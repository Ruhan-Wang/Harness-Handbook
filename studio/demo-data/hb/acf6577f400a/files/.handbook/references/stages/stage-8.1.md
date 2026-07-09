# App-server and daemon transport bring-up  `stage-8.1`

This stage is the system’s “switchboard” for bringing the app server to life and letting other parts talk to it. The daemon files manage a background server process: the main daemon coordinates start, stop, restart, setup, updates, and configuration; the backend helpers add shared setup and clearer errors; the PID backend uses a process-ID file to prevent duplicate servers and remove stale records. The daemon client, remote-control client, and doctor check connect to the local control socket to inspect status, check versions, or enable and watch remote control without unsafe side effects.

Inside the app server, the runtime loads configuration, opens transports, routes JSON-RPC messages, performs the initialize handshake, sends outgoing replies, tracks pending answers, and can also run embedded inside the caller. Transport files provide the roads: standard input/output pipes, a private Unix socket, WebSockets, and WebSocket authentication. Remote-control files enroll the server, remember whether remote control should be enabled, maintain the remote WebSocket, track remote clients, reconnect, pair, revoke, and preserve messages. Client facades then give CLI and TUI code one simple way to send requests and receive events.

## Files in this stage

### Daemon lifecycle and process backends
These files define the daemon's top-level orchestration, its managed app-server process backend, and the low-level probing client used to supervise server readiness.

### `app-server-daemon/src/lib.rs`

`orchestration` · `startup, lifecycle commands, remote-control setup, update loop`

This file exists so users and other Codex tools can treat the app-server like a dependable background service instead of manually starting a binary and tracking its process ID. The app-server is contacted through a Unix socket, which is a local communication endpoint similar to a private phone line on the same machine. The daemon records state in files under the Codex home directory: process ID files, a settings file, and a lock file.

The public functions at the top are the safe front doors. They first check that the platform is supported, then build a Daemon from the current environment. The Daemon knows where the socket, settings, managed Codex binary, and process files live.

Most operations take an operation lock, which is a file lock that prevents two commands from starting or stopping the server at the same time. Starting probes the socket first, then checks whether a daemon-owned process is already coming up, and only then launches the managed app-server. Restarting refuses to interfere with an app-server that is running but not owned by this daemon. Bootstrapping also starts the updater process. Remote-control functions update settings and restart the managed server when needed so the setting actually takes effect.

#### Function details

##### `probe_app_server_version`  (lines 79–81)

```
async fn probe_app_server_version(socket_path: &Path) -> Result<String>
```

**Purpose**: Checks an existing app-server socket and asks the server what version it is running. This is useful when callers only need to identify a live server without changing it.

**Data flow**: It receives a socket path, sends a lightweight probe request through the client code, reads the returned server information, and returns just the app-server version string.

**Call relations**: This is a small public helper around the lower-level client probe. It does not create a Daemon or start anything; it simply passes the socket path to the client layer and extracts the version.

*Call graph*: calls 1 internal fn (probe).


##### `RemoteControlMode::is_enabled`  (lines 131–133)

```
fn is_enabled(self) -> bool
```

**Purpose**: Turns the remote-control mode value into a simple true or false. Callers use it when they need to store or compare the setting.

**Data flow**: It receives either Enabled or Disabled and returns true for Enabled and false for Disabled. It changes nothing.

**Call relations**: The remote-control setting flow calls this inside Daemon::set_remote_control_locked before saving settings or deciding whether a restart is needed.

*Call graph*: called by 1 (set_remote_control_locked); 1 external calls (matches!).


##### `run`  (lines 190–193)

```
async fn run(command: LifecycleCommand) -> Result<LifecycleOutput>
```

**Purpose**: Public entry for lifecycle commands such as start, restart, stop, and version. It shields callers from setup details.

**Data flow**: It receives a lifecycle command, checks whether daemon lifecycle support is available on this operating system, creates a Daemon from the environment, and forwards the command to that Daemon. The result is a structured lifecycle report.

**Call relations**: This is the outer wrapper for Daemon::run. Command-line or API layers can call it without knowing where Codex state files live.

*Call graph*: calls 2 internal fn (from_environment, ensure_supported_platform).


##### `bootstrap`  (lines 195–198)

```
async fn bootstrap(options: BootstrapOptions) -> Result<BootstrapOutput>
```

**Purpose**: Public entry for first-time daemon setup. It prepares the managed app-server and updater using the requested remote-control setting.

**Data flow**: It receives bootstrap options, checks platform support, builds a Daemon from the environment, and asks it to bootstrap. It returns a report containing paths, versions, backend type, and enabled features.

**Call relations**: This wraps Daemon::bootstrap so higher layers can request setup without directly constructing daemon paths.

*Call graph*: calls 2 internal fn (from_environment, ensure_supported_platform).


##### `ensure_remote_control_started`  (lines 200–205)

```
async fn ensure_remote_control_started() -> Result<RemoteControlStartOutput>
```

**Purpose**: Makes sure the daemon is bootstrapped and the app-server is started with remote control enabled. It is used when a caller needs remote-control support but does not care whether setup already happened.

**Data flow**: It checks platform support, creates the Daemon, and delegates to Daemon::ensure_remote_control_started. The output says whether this was a bootstrap or a normal start.

**Call relations**: This is the public wrapper around the Daemon method. Daemon::ensure_remote_control_ready builds on it when it also needs to connect remote control.

*Call graph*: calls 2 internal fn (from_environment, ensure_supported_platform).


##### `ensure_remote_control_ready`  (lines 207–212)

```
async fn ensure_remote_control_ready() -> Result<RemoteControlReadyOutput>
```

**Purpose**: Starts or bootstraps the daemon if needed, then makes sure remote control can actually connect. It gives callers one call for the full “make it ready” path.

**Data flow**: It checks platform support, creates a Daemon, runs the daemon-side remote-control startup flow, then returns both daemon startup information and remote-control connection status.

**Call relations**: This public wrapper delegates to Daemon::ensure_remote_control_ready, which first calls Daemon::ensure_remote_control_started and then asks the remote-control client to connect.

*Call graph*: calls 2 internal fn (from_environment, ensure_supported_platform).


##### `enable_remote_control_on_socket`  (lines 214–226)

```
async fn enable_remote_control_on_socket(
    socket_path: &Path,
    connect_timeout: Duration,
    connect_retry_delay: Duration,
) -> Result<RemoteControlReadyStatus>
```

**Purpose**: Enables remote control on a specific app-server socket, retrying for a limited time. This is useful when the caller already knows the socket path and does not need full daemon setup.

**Data flow**: It receives a socket path, total connection timeout, and delay between retries. After checking platform support, it asks the remote-control client to keep trying until it connects or times out, and returns the final ready status.

**Call relations**: Unlike the Daemon-based helpers, this function works directly with a supplied socket. It hands the actual retry behavior to remote_control_client::enable_remote_control_with_connect_retry.

*Call graph*: calls 2 internal fn (ensure_supported_platform, enable_remote_control_with_connect_retry).


##### `set_remote_control`  (lines 228–231)

```
async fn set_remote_control(mode: RemoteControlMode) -> Result<RemoteControlOutput>
```

**Purpose**: Public entry for turning daemon-managed remote control on or off. It updates saved settings and restarts the managed server if the change must take effect immediately.

**Data flow**: It receives the desired mode, checks platform support, creates a Daemon from the environment, and delegates to the Daemon. The result reports the new state and any running server version.

**Call relations**: This is the public wrapper around Daemon::set_remote_control. The detailed work happens under the daemon operation lock.

*Call graph*: calls 2 internal fn (from_environment, ensure_supported_platform).


##### `run_pid_update_loop`  (lines 233–236)

```
async fn run_pid_update_loop() -> Result<()>
```

**Purpose**: Starts the daemon's updater loop. The updater is the background task that keeps the managed app-server refreshed.

**Data flow**: It checks that the platform is supported and then runs the update loop. It returns success when the loop exits normally or an error if startup or loop execution fails.

**Call relations**: This is the public entry into the update_loop module. Bootstrap starts a separate updater backend that ultimately uses this path.

*Call graph*: calls 2 internal fn (ensure_supported_platform, run).


##### `ensure_supported_platform`  (lines 244–248)

```
fn ensure_supported_platform() -> Result<()>
```

**Purpose**: Stops daemon lifecycle code from running on unsupported operating systems. In this file, lifecycle support is Unix-only.

**Data flow**: It reads no input. On Unix it returns success; on non-Unix platforms it returns an explanatory error.

**Call relations**: Every public lifecycle or remote-control entry point calls this first, so unsupported systems fail early before touching files or sockets.

*Call graph*: called by 7 (bootstrap, enable_remote_control_on_socket, ensure_remote_control_ready, ensure_remote_control_started, run, run_pid_update_loop, set_remote_control); 1 external calls (anyhow!).


##### `Daemon::from_environment`  (lines 260–274)

```
fn from_environment() -> Result<Self>
```

**Purpose**: Builds a Daemon object using the current Codex home directory. This gathers all the file paths the daemon needs into one place.

**Data flow**: It finds CODEX_HOME, derives the app-server socket path, state directory, PID files, lock file, settings file, and managed Codex binary path, then returns a Daemon containing those paths.

**Call relations**: Public wrapper functions call this before delegating to Daemon methods. The update code also uses it when it needs the same environment-based daemon layout.

*Call graph*: calls 1 internal fn (managed_codex_bin); called by 6 (bootstrap, ensure_remote_control_ready, ensure_remote_control_started, run, set_remote_control, update_once); 2 external calls (app_server_control_socket_path, find_codex_home).


##### `Daemon::run`  (lines 276–292)

```
async fn run(&self, command: LifecycleCommand) -> Result<LifecycleOutput>
```

**Purpose**: Dispatches a lifecycle command to the matching daemon action. It also ensures start, restart, and stop do not overlap with another operation.

**Data flow**: It receives a command. For start, restart, and stop it acquires the operation lock, then calls the matching method. For version it calls version directly. It returns the lifecycle output from that method.

**Call relations**: The public run function calls this. It is the switchboard that routes user commands to Daemon::start, Daemon::restart, Daemon::stop, or Daemon::version.

*Call graph*: calls 5 internal fn (acquire_operation_lock, restart, start, stop, version).


##### `Daemon::start`  (lines 294–330)

```
async fn start(&self) -> Result<LifecycleOutput>
```

**Purpose**: Starts the managed app-server if it is not already running. It avoids duplicate launches by first checking both the socket and the daemon-owned backend.

**Data flow**: It loads settings, probes the socket, checks for an existing daemon-owned process, verifies the managed Codex binary exists, starts the backend if needed, waits until the socket answers, and returns a lifecycle report.

**Call relations**: Daemon::run calls this for Start, and Daemon::ensure_remote_control_started calls it after enabling remote control. It relies on client probing, backend startup, and output formatting helpers.

*Call graph*: calls 8 internal fn (ensure_managed_codex_bin, load_settings, output, running_backend, running_backend_instance, start_managed_backend, wait_until_ready, probe); called by 2 (ensure_remote_control_started, run).


##### `Daemon::restart`  (lines 332–357)

```
async fn restart(&self) -> Result<LifecycleOutput>
```

**Purpose**: Stops the daemon-owned app-server and launches a fresh one. It refuses to restart an app-server that exists but is not owned by this daemon.

**Data flow**: It loads settings, probes the socket, checks ownership through the backend, verifies the managed binary, stops any daemon-owned process, starts a new managed backend, waits for readiness, and returns a Restarted report.

**Call relations**: Daemon::run calls this for Restart. It uses the same backend and readiness helpers as start, but always replaces the daemon-owned process.

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

**Purpose**: Used by the updater to restart the app-server only when it is safe and appropriate. It can skip work if another operation is busy, the server is not ready, or the running version is already current.

**Data flow**: It opens and tries to lock the operation file without waiting. If locked, it loads settings, checks for a daemon-owned backend, probes the server, optionally compares versions, restarts with the supplied managed binary when needed, and may re-execute the updater after a successful restart.

**Call relations**: This method is mainly for the update path. It calls restart_decision to decide what to do and should_reexec_updater to decide whether the updater process should replace itself.

*Call graph*: calls 11 internal fn (load_settings, open_operation_lock_file, running_backend_instance, start_managed_backend_with_bin, wait_until_ready, probe, managed_codex_version, restart_decision, should_reexec_updater, try_lock_file (+1 more)); 1 external calls (anyhow!).


##### `Daemon::stop`  (lines 405–433)

```
async fn stop(&self) -> Result<LifecycleOutput>
```

**Purpose**: Stops the daemon-owned app-server if it is running. It avoids killing an app-server that the daemon did not start.

**Data flow**: It loads settings, checks for a daemon-owned backend, stops it if found, and returns Stopped. If no backend is found but the socket answers, it returns an error because another app-server is running. Otherwise it reports NotRunning.

**Call relations**: Daemon::run calls this for Stop. It uses backend ownership checks and socket probing to distinguish safe stops from unsafe interference.

*Call graph*: calls 4 internal fn (load_settings, output, running_backend_instance, probe); called by 1 (run); 1 external calls (anyhow!).


##### `Daemon::version`  (lines 435–446)

```
async fn version(&self) -> Result<LifecycleOutput>
```

**Purpose**: Reports the version of the currently reachable app-server. It also says whether the daemon appears to own the running backend.

**Data flow**: It loads settings, probes the socket to get the app-server version, checks the daemon backend state, and returns a Running lifecycle output with version information.

**Call relations**: Daemon::run calls this for Version. It shares the output formatting path used by start, stop, and restart.

*Call graph*: calls 4 internal fn (load_settings, output, running_backend, probe); called by 1 (run).


##### `Daemon::wait_until_ready`  (lines 448–463)

```
async fn wait_until_ready(&self) -> Result<client::ProbeInfo>
```

**Purpose**: Waits for the app-server socket to begin answering after a start or restart. This turns a process launch into a usable service.

**Data flow**: It repeatedly probes the socket until it succeeds or a timeout is reached. On success it returns probe information; on timeout it adds helpful diagnostic context and returns the last error.

**Call relations**: Start, restart, bootstrap, remote-control changes, and updater restarts call this after launching the backend. If probing fails too long, it asks app_server_not_ready_context for a better error message.

*Call graph*: calls 2 internal fn (app_server_not_ready_context, probe); called by 5 (bootstrap_locked, restart, set_remote_control_locked, start, try_restart_if_running); 2 external calls (now, sleep).


##### `Daemon::app_server_not_ready_context`  (lines 465–473)

```
async fn app_server_not_ready_context(&self) -> String
```

**Purpose**: Builds a useful error message when the app-server was launched but never became reachable. It helps users understand what binary was used and what the server printed.

**Data flow**: It starts with the socket path, appends managed Codex binary details, then appends the tail of the stderr log if available. It returns the combined text.

**Call relations**: Daemon::wait_until_ready calls this only on timeout. It combines local daemon context with backend log context.

*Call graph*: calls 2 internal fn (append_daemon_app_server_context, append_stderr_log_tail_context); called by 1 (wait_until_ready); 1 external calls (format!).


##### `Daemon::append_daemon_app_server_context`  (lines 475–484)

```
async fn append_daemon_app_server_context(&self, context: &mut String)
```

**Purpose**: Adds the managed app-server path and best-known version to an error message. This makes failures easier to diagnose.

**Data flow**: It receives a mutable text buffer, tries to read the managed Codex version, falls back to unknown, and appends path and version lines to the buffer.

**Call relations**: Daemon::app_server_not_ready_context calls this before appending stderr log output, so the final message first identifies what binary the daemon tried to run.

*Call graph*: calls 1 internal fn (managed_codex_version_best_effort); called by 1 (app_server_not_ready_context); 1 external calls (format!).


##### `Daemon::bootstrap`  (lines 486–489)

```
async fn bootstrap(&self, options: BootstrapOptions) -> Result<BootstrapOutput>
```

**Purpose**: Runs bootstrap setup while holding the operation lock. Bootstrap prepares both the app-server backend and the updater backend.

**Data flow**: It acquires the operation lock, then passes the requested options to bootstrap_locked. It returns the bootstrap report from that locked operation.

**Call relations**: The public bootstrap wrapper calls this. It exists to separate locking from the detailed bootstrap steps.

*Call graph*: calls 2 internal fn (acquire_operation_lock, bootstrap_locked).


##### `Daemon::ensure_remote_control_started`  (lines 491–508)

```
async fn ensure_remote_control_started(&self) -> Result<RemoteControlStartOutput>
```

**Purpose**: Makes sure remote control is enabled and the managed app-server is running. It bootstraps if the daemon has not been fully set up yet.

**Data flow**: It acquires the operation lock, loads settings, checks whether the updater backend indicates bootstrap has happened, then either enables remote control and starts the server or bootstraps with remote control enabled. It returns which path was used.

**Call relations**: Daemon::ensure_remote_control_ready calls this first. The public ensure_remote_control_started wrapper also reaches this through Daemon construction.

*Call graph*: calls 6 internal fn (acquire_operation_lock, bootstrap_locked, is_bootstrapped, load_settings, set_remote_control_locked, start); called by 1 (ensure_remote_control_ready); 2 external calls (Bootstrap, Start).


##### `Daemon::ensure_remote_control_ready`  (lines 510–518)

```
async fn ensure_remote_control_ready(&self) -> Result<RemoteControlReadyOutput>
```

**Purpose**: Completes the full remote-control readiness path: daemon started, app-server running, and remote control connected.

**Data flow**: It calls ensure_remote_control_started, then asks the remote-control client to enable or connect through the daemon socket. It returns both daemon startup output and remote-control connection status.

**Call relations**: The public ensure_remote_control_ready wrapper delegates here. This method ties together daemon lifecycle work and remote-control client work.

*Call graph*: calls 2 internal fn (ensure_remote_control_started, enable_remote_control).


##### `Daemon::set_remote_control`  (lines 520–523)

```
async fn set_remote_control(&self, mode: RemoteControlMode) -> Result<RemoteControlOutput>
```

**Purpose**: Changes the remote-control setting while preventing concurrent daemon operations. It is the locked wrapper around the detailed setting logic.

**Data flow**: It receives the desired mode, acquires the operation lock, calls set_remote_control_locked, and returns the resulting status report.

**Call relations**: The public set_remote_control wrapper calls this. The split keeps locking policy separate from the setting and restart decisions.

*Call graph*: calls 2 internal fn (acquire_operation_lock, set_remote_control_locked).


##### `Daemon::set_remote_control_locked`  (lines 525–582)

```
async fn set_remote_control_locked(
        &self,
        mode: RemoteControlMode,
    ) -> Result<RemoteControlOutput>
```

**Purpose**: Actually turns remote control on or off in settings and, if the managed server is running, makes that change active. This may involve restarting the app-server.

**Data flow**: It loads previous settings, converts the requested mode to true or false, checks whether the daemon owns any running backend, rejects unmanaged running servers, saves changed settings, restarts the managed backend if needed, and returns a remote-control output report.

**Call relations**: Daemon::set_remote_control and Daemon::ensure_remote_control_started call this while holding the operation lock. It uses status helpers to report whether the setting changed or was already in that state.

*Call graph*: calls 12 internal fn (ensure_managed_codex_bin, load_settings, remote_control_output, running_backend_instance, start_managed_backend, wait_until_ready, is_enabled, already_remote_control_status, probe, disable_remote_control (+2 more)); called by 2 (ensure_remote_control_started, set_remote_control); 1 external calls (anyhow!).


##### `Daemon::bootstrap_locked`  (lines 584–624)

```
async fn bootstrap_locked(&self, options: BootstrapOptions) -> Result<BootstrapOutput>
```

**Purpose**: Performs the real bootstrap work after locking has already been handled. It writes settings, starts the app-server, and starts the updater.

**Data flow**: It verifies the managed Codex binary exists, creates settings from the options, refuses to take over an unmanaged running server, saves settings, stops any old daemon-owned app-server, starts the app-server backend, restarts the updater backend, waits for readiness, and returns a bootstrap report.

**Call relations**: Daemon::bootstrap and Daemon::ensure_remote_control_started call this. It coordinates backend creation, settings persistence, updater startup, and readiness probing.

*Call graph*: calls 9 internal fn (backend_paths, ensure_managed_codex_bin, managed_codex_version_best_effort, running_backend, running_backend_instance, wait_until_ready, pid_backend, pid_update_loop_backend, probe); called by 2 (bootstrap, ensure_remote_control_started); 3 external calls (clone, anyhow!, env!).


##### `Daemon::running_backend`  (lines 626–631)

```
async fn running_backend(&self, settings: &DaemonSettings) -> Result<Option<BackendKind>>
```

**Purpose**: Reports what kind of daemon-owned backend is currently running, without exposing the backend object itself. At present, that backend kind is PID-file based.

**Data flow**: It receives settings, asks running_backend_instance whether a backend is active, and converts an active instance into BackendKind::Pid. It returns either Some(Pid) or None.

**Call relations**: Start, restart, version, and bootstrap use this when they only need a user-facing backend label rather than an object they can stop or start.

*Call graph*: calls 1 internal fn (running_backend_instance); called by 4 (bootstrap_locked, restart, start, version).


##### `Daemon::running_backend_instance`  (lines 633–642)

```
async fn running_backend_instance(
        &self,
        settings: &DaemonSettings,
    ) -> Result<Option<backend::PidBackend>>
```

**Purpose**: Checks whether the daemon-owned app-server backend is starting or running. It returns the backend object when there is one to act on.

**Data flow**: It builds backend paths from settings, creates a PID backend, asks whether it is starting or running, and returns the backend object if active.

**Call relations**: Many lifecycle paths use this before stopping, restarting, or deciding ownership. It is the main guard against interfering with unmanaged app-server processes.

*Call graph*: calls 2 internal fn (backend_paths, pid_backend); called by 7 (bootstrap_locked, restart, running_backend, set_remote_control_locked, start, stop, try_restart_if_running).


##### `Daemon::start_managed_backend`  (lines 644–647)

```
async fn start_managed_backend(&self, settings: &DaemonSettings) -> Result<Option<u32>>
```

**Purpose**: Starts the app-server using the daemon's configured managed Codex binary. It is the normal launch helper.

**Data flow**: It receives settings, forwards them with the daemon's managed binary path to start_managed_backend_with_bin, and returns the launched process ID when available.

**Call relations**: Start, restart, and remote-control setting changes call this. The updater-specific path can bypass it by calling start_managed_backend_with_bin with a chosen binary.

*Call graph*: calls 1 internal fn (start_managed_backend_with_bin); called by 3 (restart, set_remote_control_locked, start).


##### `Daemon::start_managed_backend_with_bin`  (lines 649–657)

```
async fn start_managed_backend_with_bin(
        &self,
        settings: &DaemonSettings,
        managed_codex_bin: &Path,
    ) -> Result<Option<u32>>
```

**Purpose**: Starts the app-server using a specific Codex binary path. This lets the updater launch a newly installed managed binary.

**Data flow**: It receives settings and a binary path, builds backend paths using that binary, creates the PID backend, starts it, and returns an optional process ID.

**Call relations**: start_managed_backend calls this for normal starts. try_restart_if_running calls it directly when the updater wants to restart with a supplied managed binary.

*Call graph*: calls 2 internal fn (backend_paths_with_bin, pid_backend); called by 2 (start_managed_backend, try_restart_if_running).


##### `Daemon::is_bootstrapped`  (lines 659–662)

```
async fn is_bootstrapped(&self, settings: &DaemonSettings) -> Result<bool>
```

**Purpose**: Checks whether daemon bootstrap appears to have happened by looking for the updater backend. The updater is treated as the sign that full daemon setup is active.

**Data flow**: It receives settings, builds updater backend paths, asks whether that updater is starting or running, and returns true or false.

**Call relations**: Daemon::ensure_remote_control_started uses this to choose between a simple start path and a full bootstrap path.

*Call graph*: calls 2 internal fn (backend_paths, pid_update_loop_backend); called by 1 (ensure_remote_control_started).


##### `Daemon::ensure_managed_codex_bin`  (lines 664–677)

```
fn ensure_managed_codex_bin(&self) -> Result<()>
```

**Purpose**: Verifies that the managed standalone Codex binary exists before the daemon tries to launch it. Without this check, later startup errors would be harder to understand.

**Data flow**: It checks whether the configured managed binary path is a file. If it exists, it returns success; if not, it returns an error explaining how to install the standalone managed Codex.

**Call relations**: Start, restart, bootstrap, and remote-control restart paths call this before launching a managed app-server.

*Call graph*: called by 4 (bootstrap_locked, restart, set_remote_control_locked, start); 3 external calls (display, is_file, anyhow!).


##### `Daemon::managed_codex_version_best_effort`  (lines 685–687)

```
async fn managed_codex_version_best_effort(&self) -> Option<String>
```

**Purpose**: Tries to read the version of the managed Codex binary without making version lookup failures fatal. This is mainly for reporting and diagnostics.

**Data flow**: It asks the managed-install code for the binary version. On success it returns the version string; on failure it returns None.

**Call relations**: Output formatting, bootstrap reporting, and readiness error context call this to include version information when available.

*Call graph*: calls 1 internal fn (managed_codex_version); called by 3 (append_daemon_app_server_context, bootstrap_locked, output).


##### `Daemon::backend_paths`  (lines 689–691)

```
fn backend_paths(&self, settings: &DaemonSettings) -> BackendPaths
```

**Purpose**: Builds the set of paths and flags needed to create backend objects using the daemon's normal managed Codex binary.

**Data flow**: It receives settings and forwards them, along with the daemon's managed binary path, to backend_paths_with_bin. The result is a BackendPaths value.

**Call relations**: Backend checks, bootstrap, and updater checks use this whenever they need backend configuration for the standard managed binary.

*Call graph*: calls 1 internal fn (backend_paths_with_bin); called by 3 (bootstrap_locked, is_bootstrapped, running_backend_instance).


##### `Daemon::backend_paths_with_bin`  (lines 693–704)

```
fn backend_paths_with_bin(
        &self,
        settings: &DaemonSettings,
        managed_codex_bin: &Path,
    ) -> BackendPaths
```

**Purpose**: Assembles the exact backend configuration for a given Codex binary. This is the shared recipe for app-server and updater backend objects.

**Data flow**: It receives settings and a binary path, copies the binary path and PID file paths, includes the remote-control flag, and returns a BackendPaths struct.

**Call relations**: backend_paths calls this for normal use. start_managed_backend_with_bin calls it when launching with a specific binary path.

*Call graph*: called by 2 (backend_paths, start_managed_backend_with_bin); 2 external calls (to_path_buf, clone).


##### `Daemon::load_settings`  (lines 706–708)

```
async fn load_settings(&self) -> Result<DaemonSettings>
```

**Purpose**: Reads daemon settings from disk. These settings currently include whether remote control should be enabled.

**Data flow**: It uses the daemon's settings file path, asks DaemonSettings to load it, and returns the settings or an error.

**Call relations**: Lifecycle, remote-control, and updater restart paths call this before deciding how to start or inspect the backend.

*Call graph*: calls 1 internal fn (load); called by 7 (ensure_remote_control_started, restart, set_remote_control_locked, start, stop, try_restart_if_running, version).


##### `Daemon::acquire_operation_lock`  (lines 710–723)

```
async fn acquire_operation_lock(&self) -> Result<tokio::fs::File>
```

**Purpose**: Waits for exclusive permission to perform a daemon operation. This prevents races like one command stopping the server while another starts it.

**Data flow**: It opens the lock file, repeatedly tries to lock it until success or a timeout, sleeps briefly between attempts, and returns the open locked file. Keeping the file alive keeps the lock held.

**Call relations**: Daemon::run, bootstrap, ensure_remote_control_started, and set_remote_control use this before changing daemon state. It depends on open_operation_lock_file and try_lock_file.

*Call graph*: calls 2 internal fn (open_operation_lock_file, try_lock_file); called by 4 (bootstrap, ensure_remote_control_started, run, set_remote_control); 3 external calls (anyhow!, now, sleep).


##### `Daemon::open_operation_lock_file`  (lines 725–746)

```
async fn open_operation_lock_file(&self) -> Result<tokio::fs::File>
```

**Purpose**: Creates or opens the file used as the daemon operation lock. The lock file is the shared object that operating-system locking works on.

**Data flow**: It ensures the parent state directory exists, opens the lock file for writing, and returns the file handle. If directory creation or opening fails, it adds the path to the error.

**Call relations**: acquire_operation_lock uses this before waiting for the lock. try_restart_if_running also uses it when the updater wants a non-waiting lock attempt.

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

**Purpose**: Builds a standard lifecycle response for start, restart, stop, and version commands. It keeps response fields consistent across those commands.

**Data flow**: It receives status, backend, optional process ID, and optional app-server version. It adds managed binary path, best-effort managed binary version, socket path, and CLI version, then returns a LifecycleOutput.

**Call relations**: Start, restart, stop, and version call this after their work is done. It centralizes the user-facing lifecycle report shape.

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

**Purpose**: Builds the standard response for remote-control setting changes. It reports both the saved setting and any live app-server version.

**Data flow**: It receives remote-control status, optional backend, enabled flag, and optional app-server version. It adds socket path and CLI version, then returns a RemoteControlOutput.

**Call relations**: set_remote_control_locked calls this for both changed and already-unchanged cases.

*Call graph*: called by 1 (set_remote_control_locked); 2 external calls (clone, env!).


##### `remote_control_status`  (lines 786–791)

```
fn remote_control_status(mode: RemoteControlMode) -> RemoteControlStatus
```

**Purpose**: Converts a requested remote-control mode into the status used when the setting actually changed. It makes reporting consistent.

**Data flow**: It receives Enabled or Disabled and returns the matching Enabled or Disabled status value.

**Call relations**: set_remote_control_locked calls this after saving a changed setting and applying any needed restart.

*Call graph*: called by 1 (set_remote_control_locked).


##### `already_remote_control_status`  (lines 793–798)

```
fn already_remote_control_status(mode: RemoteControlMode) -> RemoteControlStatus
```

**Purpose**: Converts a requested remote-control mode into the status used when the daemon was already in that mode. This lets callers distinguish no-op changes from real changes.

**Data flow**: It receives Enabled or Disabled and returns AlreadyEnabled or AlreadyDisabled.

**Call relations**: set_remote_control_locked calls this when the saved setting already matches the requested mode.

*Call graph*: called by 1 (set_remote_control_locked).


##### `restart_decision`  (lines 801–815)

```
fn restart_decision(
    mode: RestartMode,
    info: Option<&client::ProbeInfo>,
    managed_version: Option<&str>,
) -> RestartDecision
```

**Purpose**: Decides whether the updater should restart the app-server. It can avoid a restart when the running app-server already matches the managed binary version.

**Data flow**: It receives a restart mode, optional probe information from the running server, and optional managed binary version. It returns NotReady, AlreadyCurrent, or Restart.

**Call relations**: try_restart_if_running calls this after probing the server and reading the managed version. The decision controls whether that method skips, reports not ready, or restarts.

*Call graph*: called by 1 (try_restart_if_running).


##### `should_reexec_updater`  (lines 818–824)

```
fn should_reexec_updater(
    updater_refresh_mode: UpdaterRefreshMode,
    outcome: RestartIfRunningOutcome,
) -> bool
```

**Purpose**: Decides whether the updater process should replace itself after restarting the app-server. This only happens after a validated restart with a changed managed binary.

**Data flow**: It receives an updater refresh mode and the restart outcome. It returns true only when refresh mode requests re-execution and the outcome was Restarted.

**Call relations**: try_restart_if_running calls this near the end. If it returns true, the update loop is asked to re-execute using the managed binary.

*Call graph*: called by 1 (try_restart_if_running).


##### `try_lock_file`  (lines 843–845)

```
fn try_lock_file(_file: &tokio::fs::File) -> Result<bool>
```

**Purpose**: Attempts to take an exclusive file lock without waiting. A file lock is an operating-system lock that lets processes agree who may touch shared state.

**Data flow**: It receives an open file. On Unix it calls the system flock operation; it returns true if the lock was taken, false if another process already holds it, or an error for unexpected failures. On non-Unix in this code path, it succeeds.

**Call relations**: acquire_operation_lock uses this in a retry loop. try_restart_if_running uses it once so the updater can back off instead of blocking.

*Call graph*: called by 2 (acquire_operation_lock, try_restart_if_running); 3 external calls (as_raw_fd, last_os_error, flock).


##### `tests::remote_control_status_uses_camel_case_json`  (lines 869–874)

```
fn remote_control_status_uses_camel_case_json()
```

**Purpose**: Checks that remote-control status values serialize to the JSON spelling expected by callers. This protects the public API shape.

**Data flow**: It serializes AlreadyEnabled to JSON and compares the result with the expected string alreadyEnabled.

**Call relations**: This test covers the serde naming behavior used by RemoteControlOutput and related API responses.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::updater_reexec_waits_for_validated_restart`  (lines 877–891)

```
fn updater_reexec_waits_for_validated_restart()
```

**Purpose**: Verifies that updater re-execution happens only after a successful restart. This avoids replacing the updater after skipped or failed restart attempts.

**Data flow**: It feeds several restart outcomes into should_reexec_updater with refresh mode enabled and checks that only Restarted returns true.

**Call relations**: This test protects the decision used by Daemon::try_restart_if_running after updater-driven restarts.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::unchanged_updater_never_reexecs`  (lines 894–906)

```
fn unchanged_updater_never_reexecs()
```

**Purpose**: Verifies that the updater does not re-execute when refresh mode is disabled. This prevents unnecessary updater replacement.

**Data flow**: It feeds several restart outcomes into should_reexec_updater with refresh mode None and checks that every result is false.

**Call relations**: This test covers the no-refresh branch used by Daemon::try_restart_if_running.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::restart_decision_preserves_forced_refreshes`  (lines 909–940)

```
fn restart_decision_preserves_forced_refreshes()
```

**Purpose**: Checks the restart decision rules for version-based and forced restarts. It ensures forced refreshes still restart even when versions match.

**Data flow**: It creates sample probe information, calls restart_decision with different modes and available data, and compares the decisions with expected results.

**Call relations**: This test protects the logic that Daemon::try_restart_if_running uses before stopping and starting the backend.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::remote_control_start_output_serializes_inner_output_without_tag`  (lines 943–1004)

```
fn remote_control_start_output_serializes_inner_output_without_tag()
```

**Purpose**: Checks that remote-control startup output serializes exactly like the inner lifecycle or bootstrap output, without an extra wrapper tag. This keeps the API response simple for clients.

**Data flow**: It builds sample LifecycleOutput and BootstrapOutput values, wraps each in RemoteControlStartOutput, serializes them, and verifies the wrapped JSON matches the inner JSON.

**Call relations**: This test protects the untagged serialization behavior used by ensure_remote_control_started and ensure_remote_control_ready outputs.

*Call graph*: 3 external calls (Bootstrap, Start, assert_eq!).


##### `tests::not_ready_context_reports_daemon_app_server_before_stderr`  (lines 1007–1033)

```
async fn not_ready_context_reports_daemon_app_server_before_stderr()
```

**Purpose**: Checks the order and content of the error context shown when the app-server does not become ready. The message should identify the daemon's binary before showing stderr output.

**Data flow**: It creates a temporary daemon layout, writes a fake stderr log, asks for the not-ready context, and compares it with the expected text.

**Call relations**: This test covers Daemon::app_server_not_ready_context and indirectly Daemon::append_daemon_app_server_context, which are used by wait_until_ready on timeout.

*Call graph*: 3 external calls (new, assert_eq!, write).


### `app-server-daemon/src/backend/mod.rs`

`orchestration` · `startup and readiness/error reporting`

This module ties the rest of the daemon to the PID-based backend implementation. A PID file is a small file that records a running process ID, so another program can find or check that process later. In everyday terms, it is like leaving a note on the door saying which worker is currently on duty.

The file exposes `PidBackend` from the private `pid` module, defines `BackendKind` so the backend type can be reported or serialized as data, and groups the file paths needed to start or inspect backend processes in `BackendPaths`. Those paths include the Codex binary to run, the main PID file, a separate PID file for the update loop, and a flag saying whether remote control is enabled.

The two constructor functions turn those raw paths into a usable `PidBackend`: one for the normal managed app-server and one for the update loop. This keeps callers from needing to know the details of how `PidBackend` is built.

The final helper improves troubleshooting. If the app-server is not ready, it tries to read the tail end of the managed server's stderr log, meaning the most recent error output. If it finds anything, it appends it to a human-readable context string; if reading fails, it records that failure too.

#### Function details

##### `pid_backend`  (lines 24–30)

```
fn pid_backend(paths: BackendPaths) -> PidBackend
```

**Purpose**: Creates the normal PID-based backend for the managed app-server. Callers use it when they need an object that knows how to work with the app-server process recorded in the main PID file.

**Data flow**: It receives a `BackendPaths` bundle containing the Codex binary path, the main PID file path, the update-loop PID file path, and a remote-control flag. It takes the binary path, main PID file path, and remote-control flag, passes them into `PidBackend::new`, and returns the resulting backend object. The update-loop PID file is not used here because this function is only for the main backend.

**Call relations**: During bootstrap, backend lookup, or starting a managed backend with a chosen binary, callers ask `pid_backend` to build the main backend for them. This function then hands the real construction work to `new`, so the rest of the daemon does not need to know the exact constructor details.

*Call graph*: calls 1 internal fn (new); called by 3 (bootstrap_locked, running_backend_instance, start_managed_backend_with_bin).


##### `pid_update_loop_backend`  (lines 32–34)

```
fn pid_update_loop_backend(paths: BackendPaths) -> PidBackend
```

**Purpose**: Creates the PID-based backend used for the update loop, which is tracked separately from the main app-server. This lets the daemon check or start the updater without confusing it with the main server process.

**Data flow**: It receives the same `BackendPaths` bundle as the main backend builder. It uses the Codex binary path and the update-loop PID file path, passes them into `PidBackend::new_update_loop`, and returns the resulting backend object.

**Call relations**: Bootstrap and bootstrapping checks call this when they need to reason about the update-loop process. The function delegates to `new_update_loop`, keeping the caller focused on the larger startup question instead of the details of constructing that backend.

*Call graph*: calls 1 internal fn (new_update_loop); called by 2 (bootstrap_locked, is_bootstrapped).


##### `append_stderr_log_tail_context`  (lines 36–46)

```
async fn append_stderr_log_tail_context(pid_file: &Path, context: &mut String)
```

**Purpose**: Adds recent stderr log output from the managed app-server to an existing error message, when that output is available. This helps a person understand why the server was not ready, instead of only seeing a vague readiness failure.

**Data flow**: It receives a path to the PID file and a mutable text string used as context. It asks `read_stderr_log_tail` to find and read the recent stderr log connected to that PID file. If a log tail is found, it appends that text to the context string. If no log is found, it leaves the context unchanged. If reading fails, it appends a short message describing that failure.

**Call relations**: When `app_server_not_ready_context` is building an explanation for a readiness problem, it calls this helper to enrich the message. This function relies on `read_stderr_log_tail` for the actual log reading and uses formatting only to turn a read error into clear text for the final context.

*Call graph*: calls 1 internal fn (read_stderr_log_tail); called by 1 (app_server_not_ready_context); 1 external calls (format!).


### `app-server-daemon/src/backend/pid.rs`

`orchestration` · `startup, status checks, shutdown`

This file is the “process caretaker” for a daemon-style app server. A daemon is a program that keeps running in the background. To know whether that background program is already running, the code writes a PID record: the process ID plus the process start time. The start time matters because operating systems can reuse process IDs; without it, the code might accidentally stop or trust the wrong process.

Starting is done carefully. First it creates or checks a lock file, which is like putting a “reserved” sign on a table so two callers do not both start servers. It then creates an empty PID file as a reservation, launches the child process, captures its stderr output in a log file, records the child’s real start time, and finally replaces the reservation with a JSON PID record.

Stopping is also cautious. It waits if a start is still in progress, verifies that the PID record still matches the live process, asks the process to exit politely, then force-kills it if it does not stop within the grace period. The file also knows how to read the last part of the stderr log so startup failures can include useful clues. Most process-control features are Unix-only; on unsupported platforms, the public start/stop helpers report that PID-managed startup or shutdown is unavailable.

#### Function details

##### `PidLogTail::append_to_context`  (lines 51–60)

```
fn append_to_context(&self, context: &mut String)
```

**Purpose**: Adds the saved tail of the managed server’s stderr log to an existing error message. This makes failures easier to diagnose because the caller sees the last lines the background process wrote before or during the problem.

**Data flow**: It receives a mutable text buffer and reads the log path and log contents stored in the PidLogTail. It appends a heading with the file path, then appends each log line indented underneath. It does not return a new value; it changes the provided text buffer in place.

**Call relations**: When another part of the daemon wants to enrich an error report, it can first fetch a PidLogTail and then call this method to paste the log into the report. This method is the final formatting step after the log tail has already been read.

*Call graph*: 1 external calls (format!).


##### `PidBackend::new`  (lines 78–88)

```
fn new(codex_bin: PathBuf, pid_file: PathBuf, remote_control_enabled: bool) -> Self
```

**Purpose**: Creates a PID-based backend for the normal app server. It stores where the Codex binary is, where the PID file should live, and whether remote control should be enabled when the server starts.

**Data flow**: It takes the path to the executable, the PID file path, and a true-or-false remote-control setting. It derives a matching lock-file path from the PID file and returns a PidBackend configured for an app-server command.

**Call relations**: Higher-level setup code and tests call this when they need a backend for the regular app server. Later, methods such as start, stop, and is_starting_or_running use the paths and command choice saved here.

*Call graph*: called by 8 (pid_backend, app_server_disabled_remote_control_uses_compatible_args_and_runtime_env, app_server_remote_control_uses_runtime_flag, locked_empty_pid_file_is_treated_as_active_reservation, stale_record_cleanup_preserves_replacement_record, start_retries_stale_empty_pid_file_under_its_own_lock, stop_waits_for_live_reservation_to_resolve, unlocked_empty_pid_file_is_treated_as_stale_reservation); 1 external calls (with_extension).


##### `PidBackend::new_update_loop`  (lines 90–98)

```
fn new_update_loop(codex_bin: PathBuf, pid_file: PathBuf) -> Self
```

**Purpose**: Creates a PID-based backend for the updater loop instead of the normal app server. The updater is started and stopped with slightly different command and kill behavior.

**Data flow**: It takes the executable path and PID file path, derives the matching lock-file path, and returns a PidBackend marked as an update-loop command. No files are touched yet; it only prepares the settings.

**Call relations**: Code that supervises the update loop calls this constructor. The rest of the backend methods then reuse the same PID-file machinery but choose updater-specific command arguments and forced shutdown behavior.

*Call graph*: called by 1 (pid_update_loop_backend); 1 external calls (with_extension).


##### `PidBackend::is_starting_or_running`  (lines 100–116)

```
async fn is_starting_or_running(&self) -> Result<bool>
```

**Purpose**: Answers the practical question: “Is this managed process either already running or currently being started?” It also cleans up a stale PID record if it points to a process that is no longer really the same process.

**Data flow**: It reads the PID-file state. If there is no file, it returns false. If a start reservation is active, it returns true. If there is a running record, it checks whether that record still matches a live process; stale records are refreshed under the lock before deciding.

**Call relations**: Status-checking code calls this before deciding whether to start another server or report that one exists. It relies on read_pid_file_state for the file view, record_is_active for the process check, and refresh_after_stale_record to safely remove outdated records.

*Call graph*: calls 3 internal fn (read_pid_file_state, record_is_active, refresh_after_stale_record).


##### `PidBackend::start`  (lines 236–238)

```
async fn start(&self) -> Result<Option<u32>>
```

**Purpose**: Starts the managed process if it is not already running. On Unix, it launches a detached child process and publishes a PID record; on unsupported platforms it reports that this startup style is not available.

**Data flow**: It uses the backend’s executable path, PID file, lock file, command kind, and remote-control setting. It creates the PID directory, obtains the reservation lock, reserves the PID file, opens a stderr log, builds the command, launches the child, reads the child’s start time, writes a JSON PID record through a temporary file, and returns the new process ID. If another valid process is already recorded, it returns no PID instead of starting a duplicate. On failure, it removes reservations and may terminate the child it just spawned.

**Call relations**: Startup orchestration calls this when it wants the daemon running. Inside the flow it coordinates many helpers: locking, stale-record checks, command argument selection, stderr-log creation, process start-time reading, and cleanup termination if a later step fails.

*Call graph*: calls 8 internal fn (acquire_reservation_lock, command_args, command_env, open_stderr_log, read_pid_file_state_with_lock_held, record_is_active, terminate_process, read_process_start_time); 15 external calls (parent, with_extension, from, null, bail!, new, format!, new, create_dir_all, remove_file (+5 more)).


##### `PidBackend::stop`  (lines 240–275)

```
async fn stop(&self) -> Result<()>
```

**Purpose**: Stops the managed process, waiting safely if startup is still in progress. It first asks the process to exit normally, then forcefully kills it if it stays alive too long.

**Data flow**: It reads or waits for a PID record, verifies that the record still matches the live process, sends a normal termination signal, and then repeatedly checks whether the process has gone away. After a grace period it escalates to a forceful kill. It returns success once the PID file is gone or stale state is cleared, and returns an error if the process still appears active after the timeout.

**Call relations**: Shutdown code calls this when the daemon should stop. It depends on wait_for_pid_start so it does not race with startup, uses record_is_active and refresh_after_stale_record to avoid trusting stale files, and hands off to terminate_process or force_terminate_process for the actual operating-system signal.

*Call graph*: calls 5 internal fn (force_terminate_process, record_is_active, refresh_after_stale_record, terminate_process, wait_for_pid_start); 3 external calls (bail!, now, sleep).


##### `PidBackend::wait_for_pid_start`  (lines 277–294)

```
async fn wait_for_pid_start(&self) -> Result<Option<PidRecord>>
```

**Purpose**: Waits briefly for an in-progress PID reservation to turn into a real PID record. This avoids stopping or inspecting the server while another task is halfway through starting it.

**Data flow**: It repeatedly reads the PID-file state until it sees no file, a running record, or a starting reservation that lasts too long. Missing becomes None, a running record becomes Some(record), and a stuck reservation becomes an error.

**Call relations**: stop calls this at the beginning of each shutdown attempt. It uses read_pid_file_state to watch the reservation and sleeps between checks so it does not spin wastefully.

*Call graph*: calls 1 internal fn (read_pid_file_state); called by 1 (stop); 3 external calls (bail!, now, sleep).


##### `PidBackend::read_pid_file_state`  (lines 296–326)

```
async fn read_pid_file_state(&self) -> Result<PidFileState>
```

**Purpose**: Interprets the PID file and lock file as one of three states: missing, starting, or running. This is the main reader that understands the on-disk protocol.

**Data flow**: It tries to read the PID file. If the file is missing, it checks whether the lock file is currently held and returns either Starting or Missing. If the file is empty, it inspects whether that empty file is an active reservation, a stale leftover, or a file that was filled meanwhile. If the file has contents, it parses the JSON PID record and returns Running.

**Call relations**: Status checks and stop-waiting code call this to get a safe view of the process state. It delegates the tricky empty-file cases to reservation_lock_is_active and inspect_empty_pid_reservation.

*Call graph*: calls 2 internal fn (inspect_empty_pid_reservation, reservation_lock_is_active); called by 2 (is_starting_or_running, wait_for_pid_start); 3 external calls (Running, read_to_string, from_str).


##### `PidBackend::read_pid_file_state_with_lock_held`  (lines 328–347)

```
async fn read_pid_file_state_with_lock_held(&self) -> Result<PidFileState>
```

**Purpose**: Reads the PID file when the caller already owns the reservation lock. Because the lock is held, an empty PID file cannot be a live reservation by another task, so it can be treated as stale.

**Data flow**: It reads the PID file. Missing means Missing. Empty contents are removed and treated as Missing. Non-empty contents are parsed as a PID record and returned as Running.

**Call relations**: start uses this after it wins the lock and discovers a PID file already exists. refresh_after_stale_record also uses it while holding the lock so it can safely decide whether to remove an outdated record.

*Call graph*: called by 2 (refresh_after_stale_record, start); 4 external calls (Running, read_to_string, remove_file, from_str).


##### `PidBackend::refresh_after_stale_record`  (lines 349–360)

```
async fn refresh_after_stale_record(&self, expected: &PidRecord) -> Result<PidFileState>
```

**Purpose**: Safely removes a PID file only if it still contains the stale record the caller already checked. This prevents deleting a newer PID record written by another starter.

**Data flow**: It takes the stale record the caller saw, obtains the reservation lock, rereads the PID file, and compares the current record with the expected one. If they match, it removes the PID file and returns Missing. If the file changed, it returns the new state instead.

**Call relations**: is_starting_or_running and stop call this after discovering that a recorded process is no longer active. It uses acquire_reservation_lock and read_pid_file_state_with_lock_held to make cleanup safe against races.

*Call graph*: calls 2 internal fn (acquire_reservation_lock, read_pid_file_state_with_lock_held); called by 2 (is_starting_or_running, stop); 1 external calls (remove_file).


##### `PidBackend::acquire_reservation_lock`  (lines 362–383)

```
async fn acquire_reservation_lock(&self) -> Result<fs::File>
```

**Purpose**: Obtains exclusive access to the PID reservation lock file. This is the guard that keeps two tasks from starting or cleaning up the same managed process at the same time.

**Data flow**: It opens or creates the lock file, then repeatedly tries to take an exclusive non-blocking file lock until it succeeds or a timeout expires. On success it returns the open file, whose lifetime keeps the lock held. On timeout or lock error it returns an error.

**Call relations**: start calls this before reserving or publishing a PID file. refresh_after_stale_record calls it before deleting a stale record. Lower-level try_lock_file performs the actual operating-system lock attempt.

*Call graph*: calls 1 internal fn (try_lock_file); called by 2 (refresh_after_stale_record, start); 4 external calls (bail!, new, now, sleep).


##### `PidBackend::open_stderr_log`  (lines 386–400)

```
async fn open_stderr_log(&self) -> Result<fs::File>
```

**Purpose**: Creates the stderr log file used by the detached managed process. Stderr is where programs usually write warnings and errors, so saving it gives later diagnostics something useful to show.

**Data flow**: It derives a stderr-log path from the PID file path, opens the file for writing, creates it if needed, and truncates old contents. It returns the open file so start can attach it to the child process.

**Call relations**: start calls this just before spawning the child process. It relies on stderr_log_file_for_pid_file so the write path matches the later read path used by read_stderr_log_tail.

*Call graph*: calls 1 internal fn (stderr_log_file_for_pid_file); called by 1 (start); 1 external calls (new).


##### `PidBackend::command_args`  (lines 403–413)

```
fn command_args(&self) -> Vec<&'static str>
```

**Purpose**: Chooses the command-line arguments used to launch the managed process. The arguments differ depending on whether this backend starts the normal app server, the app server with remote control, or the update loop.

**Data flow**: It reads the backend’s command kind and remote-control setting, then returns a list of fixed argument strings. No files or processes are changed.

**Call relations**: start calls this while building the child process command. The returned arguments are passed directly to the Codex binary.

*Call graph*: called by 1 (start); 1 external calls (vec!).


##### `PidBackend::command_env`  (lines 416–426)

```
fn command_env(&self) -> Option<(&'static str, &'static str)>
```

**Purpose**: Chooses any special environment variable needed when launching the process. In particular, it marks remote control as disabled when the app server is started without remote-control support.

**Data flow**: It reads the backend’s command kind. For an app server with remote control disabled, it returns a key-value pair to put in the child process environment. For remote-control-enabled app servers and the update loop, it returns nothing.

**Call relations**: start calls this after setting command arguments. If it returns a value, start adds that environment variable before spawning the child.

*Call graph*: called by 1 (start).


##### `PidBackend::terminate_process`  (lines 428–433)

```
fn terminate_process(&self, pid: u32) -> Result<()>
```

**Purpose**: Sends the normal “please exit” shutdown request for the backend’s managed process. It is a small method wrapper so the rest of the backend can call one common operation.

**Data flow**: It receives a process ID and checks the backend command kind. It then calls the lower-level terminate_process helper to send the operating-system termination signal. It returns success if the signal was sent or the process is already gone, otherwise an error.

**Call relations**: start calls this to clean up a child if startup fails after spawning. stop calls it as the first, polite shutdown step before considering a forceful kill.

*Call graph*: calls 1 internal fn (terminate_process); called by 2 (start, stop).


##### `PidBackend::force_terminate_process`  (lines 435–440)

```
fn force_terminate_process(&self, pid: u32) -> Result<()>
```

**Purpose**: Forcefully stops the managed process after graceful shutdown has taken too long. For the update loop, it kills the whole process group so child processes are not left behind.

**Data flow**: It receives a process ID and looks at the backend command kind. For the normal app server, it sends a force-kill signal to that PID. For the update loop, it sends the force-kill signal to the process group rooted at that PID. It returns success if the target is killed or already gone, otherwise an error.

**Call relations**: stop calls this only after the grace period has passed. It delegates to force_terminate_process or force_terminate_process_group depending on what kind of managed command was started.

*Call graph*: calls 2 internal fn (force_terminate_process, force_terminate_process_group); called by 1 (stop).


##### `PidBackend::record_is_active`  (lines 442–444)

```
async fn record_is_active(&self, record: &PidRecord) -> Result<bool>
```

**Purpose**: Checks whether a PID record still describes the same live process. This protects the daemon from trusting a stale PID file after a crash or process-ID reuse.

**Data flow**: It receives a PID record containing a process ID and start time. It asks process_matches_record whether that process exists and still has the same start time. It returns true only when both match.

**Call relations**: is_starting_or_running, start, and stop call this before trusting a PID record. It is the backend-level wrapper around the platform-specific process check.

*Call graph*: calls 1 internal fn (process_matches_record); called by 3 (is_starting_or_running, start, stop).


##### `read_stderr_log_tail`  (lines 447–453)

```
async fn read_stderr_log_tail(pid_file: &Path) -> Result<Option<PidLogTail>>
```

**Purpose**: Reads the last part of the stderr log associated with a PID file. This is used to add helpful recent server output to error messages without loading an entire large log.

**Data flow**: It takes a PID file path, derives the matching stderr-log path, and asks read_log_tail to read up to the configured byte limit. If there is useful content, it wraps the path and contents in a PidLogTail; if the log is missing or empty, it returns None.

**Call relations**: The broader daemon error-reporting helper append_stderr_log_tail_context calls this. It connects the PID-file naming convention to the generic tail-reading helper.

*Call graph*: calls 2 internal fn (read_log_tail, stderr_log_file_for_pid_file); called by 1 (append_stderr_log_tail_context).


##### `stderr_log_file_for_pid_file`  (lines 455–457)

```
fn stderr_log_file_for_pid_file(pid_file: &Path) -> PathBuf
```

**Purpose**: Builds the stderr-log file path that belongs to a PID file. This keeps log naming consistent between the writer and the reader.

**Data flow**: It receives a PID file path and returns a sibling-style path with the extension changed to stderr.log. It does not touch the filesystem.

**Call relations**: open_stderr_log uses this when preparing the child process’s stderr output. read_stderr_log_tail uses the same helper later when looking for that saved output.

*Call graph*: called by 2 (open_stderr_log, read_stderr_log_tail); 1 external calls (with_extension).


##### `read_log_tail`  (lines 459–495)

```
async fn read_log_tail(path: &Path, byte_limit: u64) -> Result<Option<String>>
```

**Purpose**: Reads only the end of a log file, up to a byte limit, and returns clean text. This avoids pulling a very large stderr log into memory just to show recent messages.

**Data flow**: It opens the given path. Missing files produce None. Empty files produce None. For non-empty files, it seeks near the end, reads the remaining bytes, drops a partial first line if it started in the middle, converts bytes to text even if some characters are invalid, trims trailing whitespace, and returns the text if anything remains.

**Call relations**: read_stderr_log_tail calls this after choosing the stderr-log path. It is the reusable low-level reader that turns a log file into a small diagnostic snippet.

*Call graph*: called by 1 (read_stderr_log_tail); 4 external calls (Start, from_utf8_lossy, new, open).


##### `process_exists`  (lines 498–504)

```
fn process_exists(pid: u32) -> bool
```

**Purpose**: Checks whether a Unix process ID currently refers to an existing process. It treats “permission denied” as still existing, because the process may be alive even if this user cannot signal it.

**Data flow**: It receives a numeric process ID, converts it to the operating system’s PID type, and uses a harmless signal check. It returns true if the process exists or access is denied, and false if the PID is invalid or the process is gone.

**Call relations**: process_matches_record calls this before and after reading process start time. It is the quick existence check used before doing the more precise start-time comparison.

*Call graph*: called by 1 (process_matches_record); 3 external calls (last_os_error, kill, try_from).


##### `terminate_process`  (lines 552–554)

```
fn terminate_process(_pid: u32) -> Result<()>
```

**Purpose**: Sends a normal Unix termination signal to a process, or reports unsupported shutdown on non-Unix platforms. A normal termination signal gives the process a chance to clean up.

**Data flow**: It receives a process ID. On Unix, it converts the ID, sends SIGTERM, and treats “no such process” as success because the desired end state is already true. Other signal errors become an error result. On unsupported platforms, it returns an unsupported-operation error.

**Call relations**: PidBackend::terminate_process delegates here. This helper is used during normal stop and during startup cleanup if a child was spawned but could not be recorded correctly.

*Call graph*: called by 1 (terminate_process); 4 external calls (bail!, last_os_error, kill, try_from).


##### `force_terminate_process`  (lines 557–559)

```
fn force_terminate_process(_pid: u32) -> Result<()>
```

**Purpose**: Sends a forceful kill signal to one process, or reports unsupported shutdown on non-Unix platforms. This is used only after the normal shutdown request has not worked.

**Data flow**: It receives a process ID. On Unix, it converts the ID, sends SIGKILL, and treats “no such process” as success. Other errors are returned with context. On unsupported platforms, it returns an unsupported-operation error.

**Call relations**: PidBackend::force_terminate_process calls this for the normal app server after stop’s grace period expires.

*Call graph*: called by 1 (force_terminate_process); 4 external calls (bail!, last_os_error, kill, try_from).


##### `force_terminate_process_group`  (lines 562–564)

```
fn force_terminate_process_group(_pid: u32) -> Result<()>
```

**Purpose**: Forcefully kills a whole Unix process group rooted at a given PID, or reports unsupported updater shutdown on non-Unix platforms. This helps stop an updater and any child processes it may have started.

**Data flow**: It receives the updater’s process ID. On Unix, it converts the ID and sends SIGKILL to the negative PID, which means the process group. If the group is already gone, it counts as success; other errors are returned. On unsupported platforms, it returns an unsupported-operation error.

**Call relations**: PidBackend::force_terminate_process calls this for update-loop backends. stop reaches it only after graceful shutdown has exceeded the grace period.

*Call graph*: called by 1 (force_terminate_process); 4 external calls (bail!, last_os_error, kill, try_from).


##### `process_matches_record`  (lines 580–582)

```
async fn process_matches_record(_record: &PidRecord) -> Result<bool>
```

**Purpose**: Verifies that a PID record points to the same process that was originally recorded. This avoids the classic PID-file bug where a process ID gets reused by an unrelated program.

**Data flow**: It receives a PID record. On Unix, it first checks whether the process exists, then reads that process’s start time and compares it with the recorded start time. If the process disappears during the check, it returns false. On non-Unix platforms, it returns false because this PID-management mode is not supported.

**Call relations**: PidBackend::record_is_active calls this whenever higher-level code needs to trust or reject a PID record. It combines process_exists and read_process_start_time into the stronger identity check.

*Call graph*: calls 2 internal fn (process_exists, read_process_start_time); called by 1 (record_is_active).


##### `try_lock_file`  (lines 609–611)

```
fn try_lock_file(_file: &fs::File) -> Result<bool>
```

**Purpose**: Attempts to take an exclusive file lock without waiting forever. A file lock is a small operating-system guard that lets one process say, “I am using this file right now.”

**Data flow**: It receives an open file. On Unix, it asks the operating system for an exclusive non-blocking lock and returns true if it got it, false if someone else already holds it, or an error for unexpected failures. On unsupported platforms, it reports that PID-managed startup is unsupported.

**Call relations**: acquire_reservation_lock repeatedly calls this until the lock is acquired or times out. reservation_lock_is_active and inspect_empty_pid_reservation also use it to tell whether another starter is currently holding the reservation.

*Call graph*: called by 3 (acquire_reservation_lock, inspect_empty_pid_reservation, reservation_lock_is_active); 4 external calls (as_raw_fd, bail!, last_os_error, flock).


##### `reservation_lock_is_active`  (lines 635–637)

```
async fn reservation_lock_is_active(_path: &Path) -> Result<bool>
```

**Purpose**: Checks whether the PID reservation lock is currently held by someone else. This helps distinguish “no PID file because nothing is happening” from “a process is in the middle of starting.”

**Data flow**: It opens or creates the lock file, tries to lock it, and returns true if the lock could not be taken because another holder has it. If the lock can be taken, it returns false. On non-Unix platforms, it returns false.

**Call relations**: read_pid_file_state calls this when the PID file is missing. That lets a missing PID file still be reported as Starting if startup has reserved the lock but has not yet published the PID record.

*Call graph*: calls 1 internal fn (try_lock_file); called by 1 (read_pid_file_state); 1 external calls (new).


##### `inspect_empty_pid_reservation`  (lines 683–688)

```
async fn inspect_empty_pid_reservation(
    _pid_path: &Path,
    _lock_path: &Path,
) -> Result<EmptyPidReservation>
```

**Purpose**: Figures out what an empty PID file means. An empty PID file can be a live startup reservation, a stale leftover, or a file that was filled just after it was first read.

**Data flow**: It opens the lock file and tries to take the lock. If another holder has it, it returns Active. If it gets the lock, it rereads the PID file: missing or still-empty means stale, and the empty file may be removed; non-empty contents are parsed as a PID record and returned. On non-Unix platforms, it treats the reservation as stale.

**Call relations**: read_pid_file_state calls this only after it reads an empty PID file. This helper resolves the race between a starter writing the PID record and another task reading the file.

*Call graph*: calls 1 internal fn (try_lock_file); called by 1 (read_pid_file_state); 5 external calls (Record, new, read_to_string, remove_file, from_str).


##### `read_process_start_time`  (lines 691–708)

```
async fn read_process_start_time(pid: u32) -> Result<String>
```

**Purpose**: Reads a process’s start time from the operating system so the PID record can identify a specific process, not just a reusable number. On Unix it uses the ps command for this.

**Data flow**: It receives a process ID, runs ps to ask for that process’s long start time, checks that the command succeeded, converts the output to text, trims it, and returns the start-time string. If ps fails, the output is not valid UTF-8, or the start time is empty, it returns an error.

**Call relations**: start calls this immediately after spawning the child so it can write a trustworthy PID record. process_matches_record calls it later to confirm that the recorded PID still belongs to the same process.

*Call graph*: called by 2 (start, process_matches_record); 3 external calls (from_utf8, bail!, new).


### `app-server-daemon/src/client.rs`

`io_transport` · `startup, control commands, and readiness checks`

The app-server exposes a local control socket, which is like a private phone line on the same machine. This file contains the code the daemon uses to call that phone line safely and politely. It first opens a Unix socket connection, upgrades it to a WebSocket connection, then speaks JSON-RPC, a simple request-and-response message format encoded as JSON. The most important flow is the probe: connect to the server, send an "initialize" request that identifies this daemon, wait for the matching response, send an "initialized" notification, then close the connection. From the server's reply, it extracts the app-server version from a user-agent string. This lets other parts of the daemon answer questions like "is the server alive?" and "what version is it?" without needing to know the wire-level details. The file also sets a short timeout for control-socket responses, so a stuck or half-dead server does not make daemon commands hang forever. The helper functions here are deliberately small: one opens the connection, one sends a message, one waits for a text message and parses it, and one pulls a version number out of a formatted string.

#### Function details

##### `probe`  (lines 34–43)

```
async fn probe(socket_path: &Path) -> Result<ProbeInfo>
```

**Purpose**: Checks whether an app-server is reachable through a given control socket and returns basic information about it. It protects callers from waiting forever by applying a short timeout.

**Data flow**: It receives a socket path. It starts the real probe work, waits up to the configured timeout, and either returns a ProbeInfo with the server version or returns an error explaining that probing failed or took too long.

**Call relations**: Higher-level daemon actions such as starting, stopping, restarting, checking version, and waiting for readiness call this when they need to know whether the app-server is alive. It delegates the actual conversation to probe_inner and wraps that conversation in a timeout.

*Call graph*: calls 1 internal fn (probe_inner); called by 9 (bootstrap_locked, restart, set_remote_control_locked, start, stop, try_restart_if_running, version, wait_until_ready, probe_app_server_version); 1 external calls (timeout).


##### `probe_inner`  (lines 45–61)

```
async fn probe_inner(socket_path: &Path) -> Result<ProbeInfo>
```

**Purpose**: Carries out the actual probe conversation with the app-server. It connects, introduces the daemon, confirms initialization, closes the connection, and extracts the server version.

**Data flow**: It receives a socket path. It opens a WebSocket connection, sends an initialize request without experimental API support, sends an "initialized" notification after the response arrives, closes the WebSocket, then turns the response's user-agent string into a ProbeInfo value.

**Call relations**: probe calls this after adding the timeout wrapper. Inside, it uses connect to open the link, initialize to perform the JSON-RPC handshake, send_message to send the final notification, and parse_version_from_user_agent to pull out the version.

*Call graph*: calls 4 internal fn (connect, initialize, parse_version_from_user_agent, send_message); called by 1 (probe); 1 external calls (Notification).


##### `connect`  (lines 63–71)

```
async fn connect(socket_path: &Path) -> Result<WebSocketStream<UnixStream>>
```

**Purpose**: Opens the local control connection to the app-server and turns it into a WebSocket stream. This gives the rest of the code a standard way to send and receive protocol messages.

**Data flow**: It receives a filesystem path to a Unix socket. It connects to that socket, performs the WebSocket upgrade, and returns a WebSocket stream ready for JSON-RPC messages. If either step fails, it returns an error that includes the socket path.

**Call relations**: probe_inner uses this before probing the server. Other flows, such as retrying connections or enabling and disabling remote control, also call it when they need a live channel to the app-server.

*Call graph*: calls 1 internal fn (connect); called by 5 (probe_inner, connect_with_retry, disable_remote_control, enable_remote_control, run_enable_remote_control_scenario); 1 external calls (client_async).


##### `initialize`  (lines 73–116)

```
async fn initialize(
    websocket: &mut WebSocketStream<S>,
    experimental_api: bool,
) -> Result<InitializeResponse>
```

**Purpose**: Performs the JSON-RPC initialize handshake with the app-server. This is the formal introduction where the daemon says who it is and what capabilities it wants to use.

**Data flow**: It receives an open WebSocket and a flag saying whether to request the experimental API. It builds an initialize request containing the daemon's name, title, package version, and optional capabilities, sends it, then reads messages until it finds the response with the matching request id. It parses that response into an InitializeResponse and returns it.

**Call relations**: probe_inner uses this during probing, and initialize_client uses it when setting up a fuller client session. It relies on send_message to write the request and read_message, with a timeout, to wait for the correct response.

*Call graph*: calls 2 internal fn (read_message, send_message); called by 2 (probe_inner, initialize_client); 5 external calls (default, Request, env!, to_value, timeout).


##### `send_message`  (lines 118–129)

```
async fn send_message(
    websocket: &mut WebSocketStream<S>,
    message: &JSONRPCMessage,
) -> Result<()>
```

**Purpose**: Serializes one JSON-RPC message and sends it over an open WebSocket. It is the shared outgoing-message doorway for this client code.

**Data flow**: It receives a WebSocket and a JSONRPCMessage value. It converts the message into a JSON string, wraps that string as a WebSocket text frame, sends it, and returns success or an error from serialization or sending.

**Call relations**: initialize uses it to send the initialize request, and probe_inner uses it to send the initialized notification. Other remote-control flows also call it whenever they need to send requests, replies, or status messages over the same protocol.

*Call graph*: called by 8 (initialize, probe_inner, initialize_client, send_remote_control_request, accept_initialized_client, disable_remote_control_retries_without_params_for_older_servers, send_remote_control_status, serve_enable_remote_control_scenario); 3 external calls (send, to_string, Text).


##### `read_message`  (lines 131–146)

```
async fn read_message(websocket: &mut WebSocketStream<S>) -> Result<JSONRPCMessage>
```

**Purpose**: Waits for the next usable JSON-RPC message from a WebSocket. It ignores non-text WebSocket frames because this protocol expects JSON text.

**Data flow**: It receives a WebSocket. It repeatedly reads incoming frames, skips anything that is not text, and parses the first text payload as a JSONRPCMessage. If the socket closes or the text is not valid protocol JSON, it returns an error.

**Call relations**: initialize uses this while waiting for the initialize response. Other remote-control code uses it to read responses, accept initialized clients, and wait for status messages.

*Call graph*: called by 6 (initialize, read_remote_control_response, accept_initialized_client, disable_remote_control_retries_without_params_for_older_servers, serve_enable_remote_control_scenario, wait_for_remote_control_status); 1 external calls (next).


##### `parse_version_from_user_agent`  (lines 148–158)

```
fn parse_version_from_user_agent(user_agent: &str) -> Result<String>
```

**Purpose**: Extracts the version number from the app-server's user-agent string. A user-agent is a short identity string, usually shaped like "name/version" followed by extra details.

**Data flow**: It receives a user-agent string. It looks for the slash that separates the name from the version, then takes the first non-empty word after the slash. It returns that version as a string, or an error if the expected version part is missing.

**Call relations**: probe_inner calls this after initialization, because the server version is reported inside the initialize response's user-agent field. The tests in this file check both the successful and failing cases.

*Call graph*: called by 1 (probe_inner).


##### `tests::parses_version_from_codex_user_agent`  (lines 167–175)

```
fn parses_version_from_codex_user_agent()
```

**Purpose**: Checks that a normal Codex-style user-agent string yields the expected version number. This protects the probe result from silently breaking if the parsing rules change.

**Data flow**: It gives parse_version_from_user_agent a realistic user-agent string containing a name, version, operating-system details, and another product token. It expects the function to return "1.2.3".

**Call relations**: This test directly exercises parse_version_from_user_agent. It stands apart from the network code so the version parsing rule can be verified without opening any socket.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::rejects_user_agent_without_version`  (lines 178–180)

```
fn rejects_user_agent_without_version()
```

**Purpose**: Checks that a user-agent with no slash-and-version part is rejected. This makes sure malformed server identity strings do not produce misleading version information.

**Data flow**: It passes a string containing only the product name into parse_version_from_user_agent. It expects an error rather than a fake or empty version.

**Call relations**: This test directly exercises the failure path of parse_version_from_user_agent. Together with the successful parsing test, it documents the minimum format the probe code expects from the server.

*Call graph*: 1 external calls (assert!).


### `cli/src/doctor/background.rs`

`domain_logic` · `doctor command diagnostics`

This file is like a cautious mechanic who looks under the hood without turning the engine on. Its job is to help users understand whether the background app-server daemon appears to be running, missing, or stuck in a confusing state.

The main check looks in Codex’s home directory for the daemon’s state folder, settings file, process ID files, and control socket. A process ID file is a small file that usually records which operating-system process is running. A control socket is a local communication endpoint, like a private door the CLI can use to talk to the daemon.

Missing files are not treated as failures, because the daemon may simply not be running. If there is no socket, the check reports “not running” and still considers that healthy. If a socket exists, the code tries one bounded probe: it asks the daemon for its version. If that works, the daemon is considered running. If it fails, the socket is marked stale or unreachable, which becomes a warning because clients may also fail to connect.

The file also includes tests for the main situations: no daemon, a running status value with a version, and a fake socket that cannot answer.

#### Function details

##### `background_server_check`  (lines 27–76)

```
async fn background_server_check(config: &Config) -> DoctorCheck
```

**Purpose**: Builds the complete doctor result for the background app-server. It gathers visible clues from the daemon’s state directory and, only if a socket already exists, checks whether the daemon can answer with its version.

**Data flow**: It receives the current configuration, especially the Codex home folder. From that folder it builds paths for the daemon state directory, settings file, PID files, and control socket. It records readable detail lines, asks `socket_status` whether the socket looks usable, adds the server mode, and returns a `DoctorCheck` with an OK or warning status plus human-readable details.

**Call relations**: This is the top-level check in this file. The tests call it directly to verify the doctor output. During its work it delegates small file-reporting details to `push_file_detail`, asks external code for the control socket path, and calls `socket_status` for the only live probe.

*Call graph*: calls 3 internal fn (new, push_file_detail, socket_status); called by 2 (failed_version_probe_reports_unavailable, not_running_background_server_stays_ok_without_version); 3 external calls (new, app_server_control_socket_path, format!).


##### `push_file_detail`  (lines 78–91)

```
fn push_file_detail(details: &mut Vec<String>, label: &str, path: &Path)
```

**Purpose**: Adds one clear detail line about whether a specific file exists and is actually a file. It helps the doctor output explain what was found without treating missing files as errors.

**Data flow**: It receives the growing list of detail strings, a label such as “settings,” and a file path. It checks the path’s filesystem metadata. It then appends a message saying the path is a file, missing, not a file, or could not be checked because of an error.

**Call relations**: `background_server_check` calls this for the settings file and both PID files. It does not decide the overall health by itself; it only supplies facts for the final doctor report.

*Call graph*: called by 1 (background_server_check); 2 external calls (format!, metadata).


##### `server_mode`  (lines 93–99)

```
fn server_mode(state_dir: &Path) -> &'static str
```

**Purpose**: Decides whether the daemon appears to be in persistent or ephemeral mode. In plain terms, persistent means there is a saved settings file; ephemeral means the daemon state looks temporary or not configured to persist.

**Data flow**: It receives the daemon state directory path. It checks whether `settings.json` exists there as a file. It returns the text `persistent` if it does, otherwise `ephemeral`.

**Call relations**: `background_server_check` uses this result when writing the final detail lines, so users can see what style of background server setup the state directory suggests.

*Call graph*: 1 external calls (join).


##### `SocketStatus::check_status`  (lines 108–113)

```
fn check_status(&self) -> CheckStatus
```

**Purpose**: Converts the socket-specific result into the general doctor status used by the rest of the doctor system. Not running and running are both OK; a stale or unreachable socket is a warning.

**Data flow**: It reads the current `SocketStatus` value. If the value says there is no running daemon or there is a reachable daemon, it returns `CheckStatus::Ok`. If the value says the socket exists but could not be reached, it returns `CheckStatus::Warning`.

**Call relations**: `background_server_check` uses this when building the final `DoctorCheck`. This keeps the rule about what counts as healthy close to the socket status type itself.


##### `SocketStatus::summary`  (lines 115–121)

```
fn summary(&self) -> &'static str
```

**Purpose**: Provides the short one-line summary shown in the doctor result for each socket state. This is the user-facing headline for the background server check.

**Data flow**: It reads the current `SocketStatus` value and maps it to a fixed sentence: not running, running, or stale/unreachable. It returns that sentence for use in the final report.

**Call relations**: `background_server_check` uses this summary when it creates the final doctor check. The test cases also indirectly rely on these exact summaries.


##### `SocketStatus::detail_label`  (lines 123–129)

```
fn detail_label(&self) -> &'static str
```

**Purpose**: Provides a compact label for the detailed status line. It is shorter than the summary and is meant to fit inside the doctor details list.

**Data flow**: It reads the current `SocketStatus` value and returns a short label: `not running`, `running`, or `stale or unreachable`.

**Call relations**: `background_server_check` uses this after probing the socket so the details include a simple status line. Tests check for these labels in the report.


##### `SocketStatus::app_server_version_detail`  (lines 131–141)

```
fn app_server_version_detail(&self) -> Option<String>
```

**Purpose**: Creates an optional detail line about the app-server version. It only includes a version when the daemon answered, or an “unavailable” message when a socket existed but the version probe failed.

**Data flow**: It reads the current `SocketStatus`. For `NotRunning`, it returns nothing because there is no daemon to ask. For `Running`, it returns a detail string containing the version. For `StaleOrUnreachable`, it returns a detail string explaining that the version could not be fetched and includes the shortened error.

**Call relations**: `background_server_check` calls this after `socket_status` so the final report can include version information when useful. The tests check both the running and failed-probe behavior.

*Call graph*: 1 external calls (format!).


##### `socket_status`  (lines 144–153)

```
async fn socket_status(socket_path: &Path) -> SocketStatus
```

**Purpose**: Figures out what the existing control socket means. If there is no socket, the daemon is treated as not running; if there is a socket, it tries to ask the daemon for its version.

**Data flow**: It receives the control socket path. First it checks whether that path exists. If not, it returns `NotRunning`. If it exists, it calls the app-server daemon probe. A successful reply becomes `Running(version)`. A failed reply becomes `StaleOrUnreachable(shortened error)`.

**Call relations**: `background_server_check` calls this as the active part of the diagnostic. When probing fails, it hands the error to `concise_probe_error` so the final user message stays readable.

*Call graph*: calls 1 internal fn (concise_probe_error); called by 1 (background_server_check); 4 external calls (exists, Running, StaleOrUnreachable, probe_app_server_version).


##### `concise_probe_error`  (lines 155–176)

```
fn concise_probe_error(err: &anyhow::Error, socket_path: &Path) -> String
```

**Purpose**: Turns a possibly long, noisy socket probe error into a short message suitable for doctor output. It avoids dumping an entire local path or an overly long technical error into the report.

**Data flow**: It receives the original error and the socket path. It turns the error into text, replaces the full socket path with the friendlier phrase `control socket`, collapses extra whitespace, and truncates the result to a fixed length. If the message is empty, it returns `unknown error`.

**Call relations**: `socket_status` calls this only when the version probe fails. Its output is stored inside `SocketStatus::StaleOrUnreachable`, which later appears in the version detail line.

*Call graph*: called by 1 (socket_status); 3 external calls (display, to_string, format!).


##### `tests::test_config`  (lines 187–193)

```
async fn test_config(codex_home: PathBuf) -> Config
```

**Purpose**: Builds a test configuration rooted in a temporary Codex home directory. This lets tests run without touching the user’s real files.

**Data flow**: It receives a temporary path. It feeds that path into the configuration builder and awaits the finished configuration. It returns the resulting `Config` or fails the test if the config cannot be built.

**Call relations**: The async tests call this before running `background_server_check`, so each test has an isolated fake home directory.

*Call graph*: 1 external calls (default).


##### `tests::create_socket_placeholder`  (lines 195–201)

```
fn create_socket_placeholder(config: &Config)
```

**Purpose**: Creates a fake control socket path for tests. It does not create a real working daemon socket; it creates a placeholder file so the production code believes something is present and then the probe fails.

**Data flow**: It receives a test configuration, asks external app-server code for the expected socket path, creates the parent directory, and writes an empty file at that path.

**Call relations**: The failed-probe test calls this to simulate a stale or unusable socket. That setup drives `background_server_check` into the warning path.

*Call graph*: 3 external calls (app_server_control_socket_path, create_dir_all, write).


##### `tests::not_running_background_server_stays_ok_without_version`  (lines 204–219)

```
async fn not_running_background_server_stays_ok_without_version()
```

**Purpose**: Verifies that an absent background server is not considered a doctor failure. This matters because not every user should have the daemon running all the time.

**Data flow**: It creates a temporary directory, builds a test config pointing there, and runs `background_server_check`. It then checks that the result is OK, says the server is not running, includes the `not running` detail, and does not include any version line.

**Call relations**: This test calls `test_config` and then the main `background_server_check`. It protects the intended behavior that missing daemon files are normal, not alarming.

*Call graph*: calls 1 internal fn (background_server_check); 4 external calls (assert!, assert_eq!, test_config, tempdir).


##### `tests::running_background_server_reports_app_server_version`  (lines 222–232)

```
fn running_background_server_reports_app_server_version()
```

**Purpose**: Verifies the formatting and health rules for an already-known running socket status. It checks that a running daemon is OK and that its version is shown.

**Data flow**: It creates a `SocketStatus::Running` value with version `1.2.3`. It calls the status helper methods and compares their outputs to the expected OK status, summary, label, and version detail.

**Call relations**: This test exercises the `SocketStatus` methods directly rather than going through filesystem setup or socket probing. It protects the small translation layer from internal status values to user-facing text.

*Call graph*: 2 external calls (assert_eq!, Running).


##### `tests::failed_version_probe_reports_unavailable`  (lines 235–258)

```
async fn failed_version_probe_reports_unavailable()
```

**Purpose**: Verifies that a present but unusable socket becomes a warning with a clear explanation. This is the case that often explains why clients cannot connect.

**Data flow**: It creates a temporary Codex home, builds a config, and writes a fake socket placeholder. Then it runs `background_server_check` and checks that the result is a warning, says the socket is stale or unreachable, includes that status detail, and includes a version-unavailable detail.

**Call relations**: This test uses `test_config` and `create_socket_placeholder` to set up the stale-socket scenario, then calls `background_server_check`. It confirms the path from socket probing failure to user-facing warning.

*Call graph*: calls 1 internal fn (background_server_check); 5 external calls (assert!, assert_eq!, create_socket_placeholder, test_config, tempdir).


### Daemon remote-control switching
These files implement the daemon-side JSON-RPC flows that enable, disable, and monitor remote-control mode against the running app-server.

### `app-server-daemon/src/remote_control_client.rs`

`io_transport` · `during remote-control enable/disable commands`

Remote control is not switched on by simply flipping a local flag. The daemon must connect to the running app server, speak its JSON-RPC protocol, ask for remote control to be enabled or disabled, and then interpret the server’s answer. JSON-RPC is a simple message style where one side sends named requests and receives matching responses.

This file is the bridge for that conversation. First it opens a WebSocket connection over a Unix socket, which is like using a private local phone line to the app server. It then performs the normal client startup handshake, sends an "initialized" notification, and sends either a remoteControl/enable or remoteControl/disable request.

A key detail is compatibility with older servers. Newer requests include an "ephemeral" option, meaning the remote-control change is temporary. If the server rejects that option as invalid, this file tries again without parameters so older app servers still work.

For enabling, the first response may say remote control is only "Connecting". In that case the file keeps listening for status-change notifications until the connection finishes, fails, or a timeout is reached. The result is wrapped as RemoteControlReadyStatus, including whether the wait timed out. The tests build fake local servers to verify the happy paths, timeout behavior, errors, and old-server fallback.

#### Function details

##### `enable_remote_control`  (lines 37–40)

```
async fn enable_remote_control(socket_path: &Path) -> Result<RemoteControlReadyStatus>
```

**Purpose**: Turns remote control on using the app server socket path. This is the simple entry point for callers that expect the server socket to already be available.

**Data flow**: It receives a filesystem path to the app server socket. It opens a WebSocket connection to that path, then passes the live connection to the timed enable flow. It returns a RemoteControlReadyStatus describing whether remote control connected, is still connecting, errored, or timed out.

**Call relations**: Higher-level code such as ensure_remote_control_ready and set_remote_control_locked calls this when remote control should be enabled. This function only opens the connection; it hands the actual protocol conversation to enable_remote_control_with_timeout.

*Call graph*: calls 2 internal fn (connect, enable_remote_control_with_timeout); called by 2 (ensure_remote_control_ready, set_remote_control_locked).


##### `disable_remote_control`  (lines 42–54)

```
async fn disable_remote_control(socket_path: &Path) -> Result<RemoteControlReadyStatus>
```

**Purpose**: Turns remote control off using the app server socket path. It performs the startup handshake, sends a disable request, and returns the server’s final status.

**Data flow**: It receives a socket path, connects to the app server, initializes the client session, builds disable parameters with ephemeral set to true, and sends the remoteControl/disable request. If the server replies successfully, the response is converted into RemoteControlReadyStatus; the WebSocket is then closed. If the newer parameter format is rejected, the request is retried without parameters.

**Call relations**: set_remote_control_locked uses this when the system needs to disable remote control. The test disable_remote_control_retries_without_params_for_older_servers also calls it to prove the old-server fallback works. Internally it relies on initialize_client and request_remote_control_with_legacy_fallback.

*Call graph*: calls 3 internal fn (connect, initialize_client, request_remote_control_with_legacy_fallback); called by 2 (set_remote_control_locked, disable_remote_control_retries_without_params_for_older_servers); 2 external calls (from, to_value).


##### `enable_remote_control_with_connect_retry`  (lines 56–64)

```
async fn enable_remote_control_with_connect_retry(
    socket_path: &Path,
    connect_timeout: Duration,
    connect_retry_delay: Duration,
) -> Result<RemoteControlReadyStatus>
```

**Purpose**: Turns remote control on, but first keeps trying to connect for a limited amount of time. This is useful when the app server may still be starting up.

**Data flow**: It receives a socket path, a total connection timeout, and a pause between attempts. It repeatedly tries to connect until one attempt succeeds or the timeout expires. Once connected, it runs the normal timed enable flow and returns the resulting RemoteControlReadyStatus.

**Call relations**: enable_remote_control_on_socket calls this when it wants a more patient startup path. This function delegates connection retrying to connect_with_retry and delegates the enable conversation to enable_remote_control_with_timeout.

*Call graph*: calls 2 internal fn (connect_with_retry, enable_remote_control_with_timeout); called by 1 (enable_remote_control_on_socket).


##### `enable_remote_control_with_timeout`  (lines 66–87)

```
async fn enable_remote_control_with_timeout(
    websocket: &mut WebSocketStream<S>,
    ready_timeout: Duration,
) -> Result<RemoteControlReadyStatus>
```

**Purpose**: Runs the full remote-control enable conversation on an already-open WebSocket. It also waits for a later status update if the first answer says the connection is still in progress.

**Data flow**: It receives a mutable WebSocket and a maximum wait time. It initializes the client session, sends remoteControl/enable with ephemeral parameters, and converts the response into RemoteControlReadyStatus. If that status is Connecting, it keeps reading status notifications until the status changes or the timeout expires. It closes the socket before returning the latest status.

**Call relations**: enable_remote_control, enable_remote_control_with_connect_retry, and the enable tests all use this as the core enable workflow. It calls initialize_client first, uses request_remote_control_with_legacy_fallback for compatibility, and calls wait_for_remote_control_status only when the server says more waiting is needed.

*Call graph*: calls 3 internal fn (initialize_client, request_remote_control_with_legacy_fallback, wait_for_remote_control_status); called by 3 (enable_remote_control, enable_remote_control_with_connect_retry, run_enable_remote_control_scenario); 3 external calls (close, from, to_value).


##### `initialize_client`  (lines 89–101)

```
async fn initialize_client(websocket: &mut WebSocketStream<S>) -> Result<()>
```

**Purpose**: Performs the required opening handshake with the app server before remote-control requests are sent. It tells the server this client supports the experimental API and then sends the standard initialized notification.

**Data flow**: It receives an open WebSocket. It calls the shared client initialization routine with experimental API support enabled, then sends an "initialized" notification over the same socket. It returns nothing on success, or an error if either step fails.

**Call relations**: disable_remote_control and enable_remote_control_with_timeout call this before making remote-control requests. It relies on the shared client module to send the actual JSON-RPC messages.

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

**Purpose**: Builds and sends one JSON-RPC request for a remote-control method. It centralizes the request shape so enable, disable, and fallback requests are sent consistently.

**Data flow**: It receives the WebSocket, a request ID, a method name such as remoteControl/enable, and optional JSON parameters. It wraps those pieces into a JSON-RPC request message and writes it to the socket. It returns success after the message is sent, or an error with the method name included for context.

**Call relations**: request_remote_control_with_legacy_fallback calls this for the first request and, when needed, for the retry without parameters. It hands the completed message to the shared client send function.

*Call graph*: calls 1 internal fn (send_message); called by 1 (request_remote_control_with_legacy_fallback); 1 external calls (Request).


##### `request_remote_control_with_legacy_fallback`  (lines 123–159)

```
async fn request_remote_control_with_legacy_fallback(
    websocket: &mut WebSocketStream<S>,
    method: &str,
    params: serde_json::Value,
) -> Result<T>
```

**Purpose**: Sends a remote-control request in the modern format, then retries in an older format if the server says the parameters are invalid. This keeps new clients working with older app servers.

**Data flow**: It receives a WebSocket, a method name, and JSON parameters. It sends the request with parameters and waits for the matching response. If the result is successful, it returns the parsed response. If the server reports the JSON-RPC invalid-parameters error, it sends the same request again with no parameters. If that also fails for invalid parameters, it returns an error.

**Call relations**: disable_remote_control and enable_remote_control_with_timeout use this so they do not need to know about protocol-version differences. It sends requests through send_remote_control_request and reads answers through read_remote_control_response.

*Call graph*: calls 2 internal fn (read_remote_control_response, send_remote_control_request); called by 2 (disable_remote_control, enable_remote_control_with_timeout); 1 external calls (anyhow!).


##### `connect_with_retry`  (lines 161–183)

```
async fn connect_with_retry(
    socket_path: &Path,
    connect_timeout: Duration,
    connect_retry_delay: Duration,
) -> Result<WebSocketStream<codex_uds::UnixStream>>
```

**Purpose**: Keeps trying to connect to the app server socket until the server is ready or a deadline passes. It turns a short startup race into a controlled wait.

**Data flow**: It receives the socket path, the maximum time to keep trying, and the delay between tries. It repeatedly calls the shared connect function. On the first successful connection it returns the WebSocket. If time runs out, it returns the final connection error with a clearer message saying the app server did not become ready.

**Call relations**: enable_remote_control_with_connect_retry uses this before starting the enable protocol. It relies on the shared client connection function and sleeps between failed attempts.

*Call graph*: calls 1 internal fn (connect); called by 1 (enable_remote_control_with_connect_retry); 2 external calls (now, sleep).


##### `read_remote_control_response`  (lines 185–223)

```
async fn read_remote_control_response(
    websocket: &mut WebSocketStream<S>,
    request_id: &RequestId,
    method: &str,
) -> Result<RemoteControlRpcResponse<T>>
```

**Purpose**: Waits for the response to a specific remote-control request and ignores unrelated messages that may arrive first. It also recognizes the special invalid-parameters error used for legacy fallback.

**Data flow**: It receives a WebSocket, the request ID it is waiting for, and the method name for error messages. It reads messages with a timeout. If it finds the matching success response, it parses the JSON result into the expected response type. If it finds the matching invalid-parameters error, it returns a special InvalidParams marker. Other matching errors become failures, remote-control status notifications are ignored here, and unrelated messages are skipped.

**Call relations**: request_remote_control_with_legacy_fallback calls this after each request it sends. This function uses remote_control_status_notification to identify status notifications that should not interrupt waiting for the request response.

*Call graph*: calls 2 internal fn (read_message, remote_control_status_notification); called by 1 (request_remote_control_with_legacy_fallback); 3 external calls (anyhow!, Success, timeout).


##### `wait_for_remote_control_status`  (lines 225–257)

```
async fn wait_for_remote_control_status(
    websocket: &mut WebSocketStream<S>,
    mut latest: RemoteControlReadyStatus,
    ready_timeout: Duration,
) -> Result<RemoteControlReadyStatus>
```

**Purpose**: After enable returns "Connecting", this waits for a later notification that says remote control has connected or failed. If no final status arrives in time, it returns the latest status marked as timed out.

**Data flow**: It receives a WebSocket, the latest known status, and a maximum wait time. It reads messages until the deadline. Non-notification messages and unrelated notifications are ignored. When a remote-control status-change notification arrives, it becomes the new latest status. If that status is no longer Connecting, it is returned immediately. If the timer expires, the latest status is returned with timed_out set to true.

**Call relations**: enable_remote_control_with_timeout calls this only when the enable response says remote control is still Connecting. It uses remote_control_status_notification to recognize and parse the relevant notifications.

*Call graph*: calls 2 internal fn (read_message, remote_control_status_notification); called by 1 (enable_remote_control_with_timeout); 3 external calls (from, now, timeout).


##### `remote_control_status_notification`  (lines 259–267)

```
fn remote_control_status_notification(
    notification: &JSONRPCNotification,
) -> Option<RemoteControlStatusChangedNotification>
```

**Purpose**: Checks whether a JSON-RPC notification is a remote-control status update and, if so, parses its details. It is the filter that separates useful status updates from other server chatter.

**Data flow**: It receives a notification message. If the method name is not remoteControl/status/changed, it returns nothing. If the method matches, it takes the notification parameters and tries to parse them into a RemoteControlStatusChangedNotification. A valid parse returns that status object; missing or malformed data returns nothing.

**Call relations**: read_remote_control_response uses this to skip status notifications while waiting for a direct response. wait_for_remote_control_status uses it to find the status updates that decide whether enabling is finished.

*Call graph*: called by 2 (read_remote_control_response, wait_for_remote_control_status); 1 external calls (from_value).


##### `RemoteControlReadyStatus::from`  (lines 304–317)

```
fn from(notification: RemoteControlStatusChangedNotification) -> Self
```

**Purpose**: Converts a remote-control status-change notification into the simpler status object returned by this client. It keeps the connection status, server name, and environment ID, while dropping fields that the caller does not need here.

**Data flow**: It receives a RemoteControlStatusChangedNotification from the protocol layer. It copies out the status, server name, and environment ID, ignores the installation ID, and creates a RemoteControlReadyStatus with timed_out set to false. The timeout flag is only set later by waiting logic if a deadline expires.

**Call relations**: wait_for_remote_control_status uses this conversion when a status notification arrives. The wider enable flow then returns the converted value to callers once the status is final or timed out.


##### `tests::enable_remote_control_uses_connected_enable_response_without_later_notification`  (lines 339–366)

```
async fn enable_remote_control_uses_connected_enable_response_without_later_notification() -> Result<()>
```

**Purpose**: Checks that enabling remote control returns immediately when the enable response already says Connected. No later notification should be required in that case.

**Data flow**: The test builds a fake scenario where the server response says Connected and no follow-up notification is sent. It runs the enable flow and compares the returned RemoteControlReadyStatus with the expected connected status, server name, environment ID, and timed_out false.

**Call relations**: This test drives the shared helper run_enable_remote_control_scenario, which creates the fake server and calls the real enable_remote_control_with_timeout logic. It proves the enable path does not wait unnecessarily.

*Call graph*: 4 external calls (from_millis, remote_control_status, run_enable_remote_control_scenario, assert_eq!).


##### `tests::enable_remote_control_waits_for_connected_notification`  (lines 369–395)

```
async fn enable_remote_control_waits_for_connected_notification() -> Result<()>
```

**Purpose**: Checks that enabling remote control waits for a later notification when the first response says Connecting. This verifies the normal asynchronous connection flow.

**Data flow**: The test creates a fake server response with Connecting and then sends a status-change notification with Connected. It runs the enable flow and expects the final returned status to be Connected with the environment ID from the notification.

**Call relations**: This test uses run_enable_remote_control_scenario to exercise enable_remote_control_with_timeout and its wait_for_remote_control_status step. It shows that later notifications can update the initial response.

*Call graph*: 4 external calls (from_secs, remote_control_status, run_enable_remote_control_scenario, assert_eq!).


##### `tests::enable_remote_control_reports_connecting_after_timeout`  (lines 398–421)

```
async fn enable_remote_control_reports_connecting_after_timeout() -> Result<()>
```

**Purpose**: Checks that the client reports a timeout instead of waiting forever when remote control stays Connecting. This protects callers from hanging on a server that never sends a final status.

**Data flow**: The test sets up a fake server that replies Connecting and sends no useful follow-up notification before a short timeout. The enable flow returns the same Connecting status, but with timed_out set to true.

**Call relations**: This test goes through run_enable_remote_control_scenario into enable_remote_control_with_timeout. It specifically validates the timeout branch inside wait_for_remote_control_status.

*Call graph*: 4 external calls (from_millis, remote_control_status, run_enable_remote_control_scenario, assert_eq!).


##### `tests::enable_remote_control_returns_errored_enable_response`  (lines 424–447)

```
async fn enable_remote_control_returns_errored_enable_response() -> Result<()>
```

**Purpose**: Checks that an Errored response from the server is returned as-is rather than treated as something to wait on. This keeps failures visible to callers immediately.

**Data flow**: The test configures the fake server to answer the enable request with Errored. The enable flow converts that response into RemoteControlReadyStatus and returns it with timed_out false.

**Call relations**: Like the other enable tests, it uses run_enable_remote_control_scenario to reach the real enable logic. It confirms that only Connecting triggers wait_for_remote_control_status.

*Call graph*: 4 external calls (from_millis, remote_control_status, run_enable_remote_control_scenario, assert_eq!).


##### `tests::enable_remote_control_retries_without_params_for_older_servers`  (lines 450–473)

```
async fn enable_remote_control_retries_without_params_for_older_servers() -> Result<()>
```

**Purpose**: Checks that enabling remote control still works with older servers that reject the newer ephemeral parameter. This protects backward compatibility.

**Data flow**: The fake server first rejects the enable request with the invalid-parameters error. The client then retries the same method without parameters, receives a Connected response, and returns the expected connected status.

**Call relations**: This test uses run_enable_remote_control_scenario and the fake server helper to exercise request_remote_control_with_legacy_fallback through the real enable path.

*Call graph*: 4 external calls (from_millis, remote_control_status, run_enable_remote_control_scenario, assert_eq!).


##### `tests::disable_remote_control_retries_without_params_for_older_servers`  (lines 476–539)

```
async fn disable_remote_control_retries_without_params_for_older_servers() -> Result<()>
```

**Purpose**: Checks that disabling remote control also supports the old-server fallback when ephemeral parameters are rejected. It mirrors the enable fallback test for the disable method.

**Data flow**: The test creates a temporary Unix socket and a fake server. The fake server accepts initialization, receives a disable request with ephemeral true, rejects it as invalid parameters, then verifies the client sends a second disable request with no parameters. It responds Disabled, and the test checks that disable_remote_control returns the expected disabled status.

**Call relations**: This test calls the real disable_remote_control function while a spawned fake server uses accept_initialized_client and protocol messages to simulate an older app server.

*Call graph*: calls 5 internal fn (read_message, send_message, disable_remote_control, from, bind); 9 external calls (new, accept_initialized_client, remote_control_status, Error, Response, assert_eq!, panic!, to_value, spawn).


##### `tests::run_enable_remote_control_scenario`  (lines 549–562)

```
async fn run_enable_remote_control_scenario(
        scenario: EnableScenario,
    ) -> Result<RemoteControlReadyStatus>
```

**Purpose**: Sets up a reusable fake-server environment for enable-flow tests. It keeps the individual tests focused on the scenario they care about.

**Data flow**: It receives an EnableScenario describing what the fake server should send and whether it should reject parameters. It creates a temporary socket, starts the fake server task, connects a real client WebSocket, runs enable_remote_control_with_timeout, waits for the server task to finish, and returns the status produced by the client.

**Call relations**: The enable tests call this helper. It connects the test scenario to serve_enable_remote_control_scenario on the server side and the real enable_remote_control_with_timeout on the client side.

*Call graph*: calls 3 internal fn (connect, enable_remote_control_with_timeout, bind); 3 external calls (new, serve_enable_remote_control_scenario, spawn).


##### `tests::serve_enable_remote_control_scenario`  (lines 564–622)

```
async fn serve_enable_remote_control_scenario(
        listener: UnixListener,
        scenario: EnableScenario,
    ) -> Result<()>
```

**Purpose**: Acts as a fake app server for enable-flow tests. It speaks just enough of the protocol to test the client’s behavior.

**Data flow**: It receives a Unix socket listener and an EnableScenario. It accepts and initializes a client, optionally sends an initial status notification, reads and checks the enable request, optionally rejects the first request to trigger fallback, sends the configured enable response, and optionally sends a later status notification. If no later notification is configured, it waits briefly so the client can hit its timeout path.

**Call relations**: run_enable_remote_control_scenario spawns this helper as the server side of each enable test. It uses accept_initialized_client to handle the handshake and send_remote_control_status for status notifications.

*Call graph*: calls 3 internal fn (read_message, send_message, from); 9 external calls (from_millis, accept_initialized_client, send_remote_control_status, Error, Response, assert_eq!, panic!, to_value, sleep).


##### `tests::accept_initialized_client`  (lines 624–662)

```
async fn accept_initialized_client(
        mut listener: UnixListener,
    ) -> Result<WebSocketStream<codex_uds::UnixStream>>
```

**Purpose**: Accepts one fake-server WebSocket connection and verifies the client performs the required initialization handshake. It gives tests a ready-to-use WebSocket after setup is complete.

**Data flow**: It receives a Unix socket listener, accepts a connection, upgrades it to a WebSocket, reads the initialize request, checks that experimentalApi is true, sends a normal initialize response, then reads and verifies the initialized notification. It returns the WebSocket positioned after the handshake.

**Call relations**: The fake server helpers call this before testing enable or disable requests. It mirrors the initialization that initialize_client performs on the real client side.

*Call graph*: calls 3 internal fn (read_message, send_message, accept); 5 external calls (Response, assert_eq!, panic!, json!, accept_async).


##### `tests::send_remote_control_status`  (lines 664–679)

```
async fn send_remote_control_status(
        websocket: &mut WebSocketStream<S>,
        status: RemoteControlStatusChangedNotification,
    ) -> Result<()>
```

**Purpose**: Sends a remote-control status-change notification from a fake server to the client during tests. It avoids repeating the notification-building code in each scenario.

**Data flow**: It receives a WebSocket and a status notification object. It serializes the status into JSON, wraps it in a JSON-RPC notification named remoteControl/status/changed, and sends it over the socket. It returns success or the send error.

**Call relations**: serve_enable_remote_control_scenario calls this when a test scenario includes an initial or follow-up status notification. The real client later recognizes these messages through remote_control_status_notification.

*Call graph*: calls 1 internal fn (send_message); 2 external calls (Notification, to_value).


##### `tests::remote_control_status`  (lines 681–691)

```
fn remote_control_status(
        status: RemoteControlConnectionStatus,
        environment_id: Option<&str>,
    ) -> RemoteControlStatusChangedNotification
```

**Purpose**: Builds a standard remote-control status notification for tests. It fills in repeated test values so each test only has to choose the connection status and optional environment ID.

**Data flow**: It receives a RemoteControlConnectionStatus and an optional environment ID string. It returns a RemoteControlStatusChangedNotification with the chosen status, the shared fake server name, the shared fake installation ID, and the optional environment ID converted to an owned string.

**Call relations**: Most enable tests and the disable fallback test use this helper to create realistic protocol status objects. Those objects are then sent by fake server helpers or converted into response payloads.


### Server bootstrap and connection routing
These files bring up the app-server runtime itself, initialize connections, and manage outbound delivery across in-process and external transports.

### `app-server/src/lib.rs`

`entrypoint` · `startup, main loop, shutdown`

Think of this file as the app server’s control room. It does not contain every feature itself; instead, it starts the right machines, connects their pipes, watches their status lights, and turns them off in the right order. At startup it reads configuration, prepares logging and analytics, opens the local database, checks for warnings, and decides which ways clients may connect: standard input/output, a Unix socket, a WebSocket, or remote control. It then creates message channels, which are like in-memory mailboxes, so transport code, request processing code, and outgoing writers can work independently without sharing the same mutable connection table.

Once running, the file keeps two main loops alive. One loop receives client events, asks MessageProcessor to process JSON-RPC requests, and tracks each connection’s session state. The other loop sends outgoing messages to the right connection writers. This split matters because writing to clients can be slow, and slow writes should not block request handling.

The file also handles graceful restart. On shutdown signals it can stop accepting new work, wait for running assistant turns to finish, then disconnect clients. If a second forceable signal arrives, it stops waiting. It also contains safety code for a corrupted local SQLite database: it backs up damaged files and lets the server rebuild fresh state instead of failing immediately.

#### Function details

##### `configured_thread_config_loader`  (lines 136–141)

```
fn configured_thread_config_loader(config: &Config) -> Arc<dyn ThreadConfigLoader>
```

**Purpose**: Chooses how thread-specific configuration should be loaded. If the main config names a remote endpoint, it builds a remote loader; otherwise it uses a no-op loader that does nothing.

**Data flow**: It receives the loaded Config. It reads the optional experimental thread config endpoint, turns that into either a RemoteThreadConfigLoader or a NoopThreadConfigLoader, wraps it in shared ownership, and returns it.

**Call relations**: During server startup, run_main_with_transport_options calls this after the first config preload. The returned loader is installed into ConfigManager so later config reloads can include discovered thread configuration.

*Call graph*: calls 1 internal fn (new); called by 1 (run_main_with_transport_options); 1 external calls (new).


##### `shutdown_signal`  (lines 187–208)

```
async fn shutdown_signal() -> IoResult<ShutdownSignal>
```

**Purpose**: Waits for an operating-system shutdown signal and classifies it as either forceable or graceful-only. This lets the server know whether it should drain work or prepare for a possible forced restart.

**Data flow**: It reads process signals from the operating system. On Unix it waits for Ctrl-C, terminate, or hangup signals; on non-Unix systems it waits for Ctrl-C. It returns the kind of shutdown signal, or an input/output error if signal listening fails.

**Call relations**: The main processor loop inside run_main_with_transport_options waits on this when graceful signal handling is enabled. Its result is handed to ShutdownState::on_signal, which records whether shutdown has begun or should be forced.

*Call graph*: 4 external calls (hangup, terminate, select!, ctrl_c).


##### `ShutdownState::requested`  (lines 211–213)

```
fn requested(&self) -> bool
```

**Purpose**: Answers whether a shutdown has already been requested. It is a small readability helper for the main loop.

**Data flow**: It reads the ShutdownState value and returns the stored requested flag without changing anything.

**Call relations**: The processor loop uses this while deciding whether to keep watching running assistant turns during graceful restart.


##### `ShutdownState::forced`  (lines 215–217)

```
fn forced(&self) -> bool
```

**Purpose**: Answers whether shutdown has moved from graceful waiting to forced stopping. This helps the server decide whether to drain work or abandon cleanup.

**Data flow**: It reads the ShutdownState value and returns the stored forced flag without changing anything.

**Call relations**: The processor loop checks this before listening for more shutdown signals and again at teardown to choose between graceful cleanup and aborting cleanup tasks.


##### `ShutdownState::on_signal`  (lines 219–238)

```
fn on_signal(
        &mut self,
        signal: ShutdownSignal,
        connection_count: usize,
        running_turn_count: usize,
    )
```

**Purpose**: Records that the process received a shutdown signal. The first signal starts graceful draining; a later forceable signal changes the shutdown into a forced one.

**Data flow**: It receives the signal type, the current number of connections, and the number of running assistant turns. It updates the shutdown state and logs what is happening. It does not return a value.

**Call relations**: The processor loop calls this after shutdown_signal returns. Its updated state is later interpreted by ShutdownState::update to decide whether the server can finish.

*Call graph*: 2 external calls (info!, matches!).


##### `ShutdownState::update`  (lines 240–266)

```
fn update(&mut self, running_turn_count: usize, connection_count: usize) -> ShutdownAction
```

**Purpose**: Decides whether the server should keep waiting or finish shutdown now. It lets graceful restart wait for active assistant work, unless shutdown was forced.

**Data flow**: It receives the current running assistant turn count and connection count. It checks the stored shutdown flags, logs progress when useful, updates the last logged count, and returns either Noop or Finish.

**Call relations**: The processor loop calls this on each pass. When it returns Finish, run_main_with_transport_options cancels transport acceptors and asks the outbound router to disconnect all clients.

*Call graph*: 1 external calls (info!).


##### `config_warning_from_error`  (lines 269–283)

```
fn config_warning_from_error(
    summary: impl Into<String>,
    err: &std::io::Error,
) -> ConfigWarningNotification
```

**Purpose**: Turns a configuration loading error into a warning object that can be shown to clients. It preserves both the human message and, when available, the exact file location of the problem.

**Data flow**: It receives a short summary and an input/output error. It asks config_error_location whether the error includes a config file path and text range, then builds a ConfigWarningNotification with summary, details, optional path, and optional range.

**Call relations**: run_main_with_transport_options uses this when strict config mode is off and user configuration cannot be loaded. It lets the server continue with defaults while still telling clients what went wrong.

*Call graph*: calls 1 internal fn (config_error_location); called by 1 (run_main_with_transport_options); 2 external calls (into, to_string).


##### `config_error_location`  (lines 285–295)

```
fn config_error_location(err: &std::io::Error) -> Option<(String, AppTextRange)>
```

**Purpose**: Extracts the file path and text range from a configuration error, if that information is available. This helps editors point users at the exact broken part of a config file.

**Data flow**: It receives an input/output error. It looks inside the wrapped error for a ConfigLoadError, converts the config error’s path and range into app-server protocol types, and returns them if found.

**Call relations**: config_warning_from_error calls this while building a client-visible warning. If this function finds nothing, the warning still exists but has no clickable location.

*Call graph*: called by 1 (config_warning_from_error); 1 external calls (get_ref).


##### `exec_policy_warning_location`  (lines 297–317)

```
fn exec_policy_warning_location(err: &ExecPolicyError) -> (Option<String>, Option<AppTextRange>)
```

**Purpose**: Finds where an execution policy parsing problem happened. An execution policy is a rule file that controls what commands may run.

**Data flow**: It receives an ExecPolicyError. For parse errors, it returns the policy file path and, if known, the exact text range. For other error types it returns no location.

**Call relations**: run_main_with_transport_options calls this after checking execution policy warnings. The location becomes part of a ConfigWarningNotification sent to clients.

*Call graph*: called by 1 (run_main_with_transport_options).


##### `app_text_range`  (lines 319–330)

```
fn app_text_range(range: &CoreTextRange) -> AppTextRange
```

**Purpose**: Converts a text range from the core configuration format into the app-server protocol format. This keeps file-location warnings understandable to clients.

**Data flow**: It receives a core TextRange with start and end line and column numbers. It copies those numbers into the protocol’s TextRange type and returns it.

**Call relations**: config_error_location uses this when translating config loading errors into client-facing warning data.


##### `project_config_warning`  (lines 332–372)

```
fn project_config_warning(config: &Config) -> Option<ConfigWarningNotification>
```

**Purpose**: Builds a warning when project-local Codex settings are disabled because a project is not trusted. This tells users why local config, hooks, or execution policies are not being applied.

**Data flow**: It receives the current Config. It scans all config layers, finds disabled project layers, collects each folder and reason, and returns one combined ConfigWarningNotification if any were found.

**Call relations**: run_main_with_transport_options calls this during startup after loading configuration. Any returned warning is added to the startup warning list sent to initialized clients.

*Call graph*: called by 1 (run_main_with_transport_options); 3 external calls (new, concat!, format!).


##### `LogFormat::from_env_value`  (lines 375–380)

```
fn from_env_value(value: Option<&str>) -> Self
```

**Purpose**: Interprets the LOG_FORMAT environment value. Only the value json, ignoring case and surrounding spaces, enables JSON logs; everything else uses normal text logs.

**Data flow**: It receives an optional string. It trims and lowercases it, compares it to json, and returns either LogFormat::Json or LogFormat::Default.

**Call relations**: log_format_from_env calls this after reading the environment. The test functions in this file check the accepted and rejected values.

*Call graph*: called by 1 (log_format_from_env).


##### `log_format_from_env`  (lines 383–386)

```
fn log_format_from_env() -> LogFormat
```

**Purpose**: Reads the process environment to decide how stderr logs should be formatted. This gives operators a simple switch for structured JSON logging.

**Data flow**: It reads LOG_FORMAT from the environment, passes the optional value to LogFormat::from_env_value, and returns the chosen LogFormat.

**Call relations**: run_main_with_transport_options calls this while installing tracing, which is the Rust logging and diagnostics system used by the server.

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

**Purpose**: Starts the app server with the normal defaults. It is the convenient public entry used when the caller does not need custom transport or runtime options.

**Data flow**: It receives startup paths, command-line config overrides, loader overrides, strict-config choice, and the default analytics setting. It fills in standard choices such as stdio transport, VS Code session source, default WebSocket auth settings, and default runtime options, then awaits run_main_with_transport_options.

**Call relations**: This is the simpler front door into the runtime. It delegates all real setup and looping work to run_main_with_transport_options.

*Call graph*: calls 2 internal fn (default, run_main_with_transport_options); 1 external calls (default).


##### `AppServerRuntimeOptions::default`  (lines 423–429)

```
fn default() -> Self
```

**Purpose**: Defines the normal runtime behavior for the app server. By default, plugin startup work runs, remote control preference is resolved from saved state, and shutdown signal handling is installed.

**Data flow**: It takes no input. It creates and returns an AppServerRuntimeOptions value with the project’s default choices.

**Call relations**: run_main uses this when it calls run_main_with_transport_options, so ordinary server startup gets a consistent set of runtime behaviors.

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

**Purpose**: Builds and runs the full app server. It loads configuration, opens transports, starts background tasks, routes messages, watches shutdown signals, and performs cleanup.

**Data flow**: It receives startup paths, config override settings, transport choice, session source, authentication settings, analytics defaults, and runtime options. It creates channels for incoming events and outgoing messages, loads config, initializes telemetry and the SQLite state database, starts local or remote connection acceptors, creates MessageProcessor, and runs the processor and outbound router tasks until shutdown. It returns Ok when the server stops cleanly or an input/output error if startup cannot continue.

**Call relations**: run_main calls this for the default path, and specialized callers can call it directly with custom transports. Inside, it calls many helper functions in this file for config warnings, log format, database recovery, test-only loader overrides, thread config loading, and analytics transport naming, then hands request work to MessageProcessor and outgoing writes to route_outgoing_envelope.

*Call graph*: calls 27 internal fn (app_server_startup_lock_path, policy_from_settings, analytics_rpc_transport, analytics_events_client_from_config, new, config_warning_from_error, configured_thread_config_loader, new, exec_policy_warning_location, init_sqlite_state_db_with_fresh_start_on_corruption (+15 more)); called by 1 (run_main); 33 external calls (clone, new, new, default, from_default_env, new, new, new, new, default (+15 more)).


##### `init_sqlite_state_db_with_fresh_start_on_corruption`  (lines 1196–1267)

```
async fn init_sqlite_state_db_with_fresh_start_on_corruption(
    config: &Config,
) -> anyhow::Result<StateDbInitResult>
```

**Purpose**: Opens the local SQLite state database, and if it appears damaged, moves the damaged files aside so the server can start with a fresh database. SQLite is the small embedded database used for local server state.

**Data flow**: It receives the current Config, repeatedly tries to initialize the rollout state database, and watches for corruption-style failures. On corruption or a blocking file where the database folder should be, it backs up the bad database files, records what was moved, and tries again. It returns the database handle plus an optional recovery notice, or an error if recovery fails.

**Call relations**: run_main_with_transport_options calls this during startup before message processing begins. It uses sqlite_home_is_blocking_file, sqlite_recovery_notice, and emit_state_db_backup_warning to decide when and how to recover and how to warn users.

*Call graph*: calls 3 internal fn (emit_state_db_backup_warning, sqlite_home_is_blocking_file, sqlite_recovery_notice); called by 1 (run_main_with_transport_options); 8 external calls (new, new, anyhow!, backup_runtime_db_for_fresh_start, is_sqlite_corruption_error, runtime_db_path_for_corruption_error, format!, try_init).


##### `sqlite_home_is_blocking_file`  (lines 1269–1274)

```
fn sqlite_home_is_blocking_file(database_path: &Path) -> bool
```

**Purpose**: Checks for a filesystem mistake where the database’s parent folder is actually a file. That situation blocks SQLite from creating its database in the expected place.

**Data flow**: It receives a database path. It looks at the path’s parent, reads its filesystem metadata if possible, and returns true only when that parent exists as a regular file.

**Call relations**: init_sqlite_state_db_with_fresh_start_on_corruption calls this after a database open failure. A true result is treated similarly to corruption: the runtime tries a fresh-start backup path.

*Call graph*: called by 1 (init_sqlite_state_db_with_fresh_start_on_corruption); 1 external calls (parent).


##### `sqlite_recovery_notice`  (lines 1276–1294)

```
fn sqlite_recovery_notice(
    recovered_databases: &[RecoveredSqliteDatabase],
) -> Option<SqliteRecoveryNotice>
```

**Purpose**: Creates a user-facing notice describing any database files that were backed up during recovery. Without this, the server could silently rebuild state after moving damaged files.

**Data flow**: It receives a list of recovered database records. If the list is empty it returns None. Otherwise it formats each original database path and backup folder into a details string and returns a SqliteRecoveryNotice.

**Call relations**: init_sqlite_state_db_with_fresh_start_on_corruption calls this after database initialization finally succeeds. The notice is later turned into a startup configuration warning by run_main_with_transport_options.

*Call graph*: called by 1 (init_sqlite_state_db_with_fresh_start_on_corruption); 2 external calls (is_empty, iter).


##### `emit_state_db_backup_warning`  (lines 1296–1304)

```
fn emit_state_db_backup_warning(message: &str)
```

**Purpose**: Logs a warning about database backup or recovery, and prints it directly to stderr if logging has not been set up yet. This makes early startup recovery visible.

**Data flow**: It receives a message string. It sends the message through tracing as a warning, then checks whether a tracing dispatcher has already been installed; if not, it also writes the message to standard error.

**Call relations**: init_sqlite_state_db_with_fresh_start_on_corruption calls this whenever it detects damage, moves files, or reports final backup locations.

*Call graph*: called by 1 (init_sqlite_state_db_with_fresh_start_on_corruption); 3 external calls (eprintln!, has_been_set, warn!).


##### `test_user_config_file_from_env`  (lines 1306–1316)

```
fn test_user_config_file_from_env() -> Option<std::path::PathBuf>
```

**Purpose**: Reads a debug-only environment variable that can point the app server at a test user config file. In non-debug builds it always returns nothing.

**Data flow**: In debug builds, it reads CODEX_APP_SERVER_TEST_USER_CONFIG_FILE, ignores empty values, and returns the path if present. In release builds, it returns None without reading a useful value.

**Call relations**: run_main_with_transport_options calls this before loading config, then passes the result to loader_overrides_with_test_user_config_file.

*Call graph*: called by 1 (run_main_with_transport_options); 1 external calls (var_os).


##### `loader_overrides_with_test_user_config_file`  (lines 1318–1341)

```
fn loader_overrides_with_test_user_config_file(
    mut loader_overrides: LoaderOverrides,
    test_user_config_file: Option<std::path::PathBuf>,
) -> IoResult<LoaderOverrides>
```

**Purpose**: Applies the debug-only test user config path to LoaderOverrides. This lets tests and development runs use a specific config file without changing real user settings.

**Data flow**: It receives existing LoaderOverrides and an optional path. In debug builds, if a path exists, it verifies that it is absolute, stores it as the user config path, logs a warning, and returns the modified overrides. In non-debug builds it ignores the path and returns the original overrides.

**Call relations**: run_main_with_transport_options calls this at the start of config setup. The debug_test_user_config_file_overrides_loader_path test also calls it to verify that the override is applied.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 2 (run_main_with_transport_options, debug_test_user_config_file_overrides_loader_path); 1 external calls (warn!).


##### `analytics_rpc_transport`  (lines 1343–1350)

```
fn analytics_rpc_transport(transport: &AppServerTransport) -> AppServerRpcTransport
```

**Purpose**: Labels the server’s connection style for analytics. Stdio is reported separately; all socket, WebSocket, off, and remote-style modes are grouped as WebSocket transport for analytics purposes.

**Data flow**: It receives an AppServerTransport value. It matches the transport kind and returns the corresponding AppServerRpcTransport label.

**Call relations**: run_main_with_transport_options calls this when constructing MessageProcessorArgs, so analytics events from request processing include the broad RPC transport type.

*Call graph*: called by 1 (run_main_with_transport_options).


##### `tests::log_format_from_env_value_matches_json_values_case_insensitively`  (lines 1364–1368)

```
fn log_format_from_env_value_matches_json_values_case_insensitively()
```

**Purpose**: Checks that JSON logging is enabled by json regardless of letter case or surrounding spaces. This protects the operator-facing LOG_FORMAT behavior.

**Data flow**: It passes several string examples into LogFormat::from_env_value and asserts that each returns LogFormat::Json.

**Call relations**: This test exercises LogFormat::from_env_value directly. It does not take part in server runtime; it runs only under the test harness.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::log_format_from_env_value_defaults_for_non_json_values`  (lines 1371–1379)

```
fn log_format_from_env_value_defaults_for_non_json_values()
```

**Purpose**: Checks that missing or non-json LOG_FORMAT values fall back to the normal text log format. This prevents accidental JSON logging from near-miss values like jsonl.

**Data flow**: It passes None, an empty string, text, and jsonl into LogFormat::from_env_value and asserts that each returns LogFormat::Default.

**Call relations**: This test covers the default branch used by log_format_from_env. It runs only during tests.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::debug_test_user_config_file_overrides_loader_path`  (lines 1383–1395)

```
fn debug_test_user_config_file_overrides_loader_path()
```

**Purpose**: Verifies the debug-only path that lets developers override the user config file for app-server tests. It confirms that the override is stored as an absolute path.

**Data flow**: It creates a temporary config path, calls loader_overrides_with_test_user_config_file with default loader overrides and that path, then asserts that the returned overrides contain the same absolute path.

**Call relations**: This test calls loader_overrides_with_test_user_config_file directly. It is compiled only in debug builds, matching the debug-only feature it checks.

*Call graph*: calls 1 internal fn (loader_overrides_with_test_user_config_file); 3 external calls (assert_eq!, default, temp_dir).


### `app-server/src/outgoing_message.rs`

`io_transport` · `request handling and cross-cutting server-to-client messaging`

When the app server talks to a client, it needs more than a simple “send this JSON” helper. Some messages are replies to a specific client request. Some are server notifications that should go to one client, several clients, or everyone. Some are server requests that need a later client response, like asking for approval. This file keeps those cases organized.

The main type, OutgoingMessageSender, owns a channel to the lower transport layer. A channel is like a queue: this file puts outgoing envelopes into it, and another part of the program actually writes them to the network. It also keeps a table of pending callbacks, so when a client answers a server request, the waiting task gets the result. A second table stores RequestContext values, which preserve tracing information for incoming requests until a final response or error is sent.

ThreadScopedOutgoingMessageSender is a narrower wrapper for one conversation thread. It automatically targets the right client connections and tags pending requests with the thread id, making cleanup possible when a thread turn changes or is aborted.

Without this file, messages could go to the wrong connection, pending approvals could hang forever, request traces would be lost, and disconnects or turn transitions would leave stale state behind.

#### Function details

##### `RequestContext::new`  (lines 58–68)

```
fn new(
        request_id: ConnectionRequestId,
        span: Span,
        parent_trace: Option<W3cTraceContext>,
    ) -> Self
```

**Purpose**: Builds a saved context for one incoming client request. The context ties together the request’s connection-specific id, its tracing span, and any trace information inherited from the caller.

**Data flow**: It receives a connection-scoped request id, a tracing span, and optional parent trace data. It stores those pieces together in a RequestContext and returns it for later use when the server sends the final response or error.

**Call relations**: Request-processing code creates this context when a client request starts. Later, OutgoingMessageSender stores it, reads trace data from it, or removes it when the request is completed or the connection closes.

*Call graph*: called by 4 (process_client_request, process_request, connection_closed_clears_registered_request_contexts, send_response_clears_registered_request_context).


##### `RequestContext::request_trace`  (lines 70–72)

```
fn request_trace(&self) -> Option<W3cTraceContext>
```

**Purpose**: Returns the best trace identity available for this request. This lets later work stay linked to the original request in observability tools.

**Data flow**: It looks first at the current span to see whether it has W3C trace context, which is a standard way to pass trace ids between systems. If the span has none, it falls back to the parent trace saved when the request arrived.

**Call relations**: Higher-level thread startup code asks for this when it needs to continue the same trace across later work. It relies on the tracing helper span_w3c_trace_context to extract trace data from the span.

*Call graph*: called by 1 (thread_start_inner); 1 external calls (span_w3c_trace_context).


##### `RequestContext::span`  (lines 74–76)

```
fn span(&self) -> Span
```

**Purpose**: Gives callers a copy of the tracing span for this request. A span is a named section of work used for logs and performance tracing.

**Data flow**: It reads the stored span, clones the handle, and returns the clone. The original context remains unchanged.

**Call relations**: Request dispatch and execution paths use this span when running work or sending the final outgoing message, so logs and send failures are connected back to the request that caused them.

*Call graph*: called by 3 (dispatch_initialized_client_request, run_request_with_context, thread_start_inner); 1 external calls (clone).


##### `RequestContext::record_turn_id`  (lines 78–80)

```
fn record_turn_id(&self, turn_id: &str)
```

**Purpose**: Adds the conversation turn id to this request’s trace span. This makes logs easier to connect to a specific turn in a thread.

**Data flow**: It receives a turn id string and records it as a field on the stored tracing span. It does not return anything; it enriches the trace data in place.

**Call relations**: OutgoingMessageSender uses this through its request-context table when later code learns which turn belongs to an already-registered request.

*Call graph*: 1 external calls (record).


##### `ThreadScopedOutgoingMessageSender::new`  (lines 121–131)

```
fn new(
        outgoing: Arc<OutgoingMessageSender>,
        connection_ids: Vec<ConnectionId>,
        thread_id: ThreadId,
    ) -> Self
```

**Purpose**: Creates a sender that is pre-bound to one thread and a known set of client connections. This saves callers from repeatedly passing the same thread and connection information.

**Data flow**: It receives the shared outgoing sender, a list of connection ids, and a thread id. It wraps the connection list in shared storage and returns a ThreadScopedOutgoingMessageSender.

**Call relations**: Thread and turn handling code constructs this wrapper before emitting events or asking the client for thread-specific decisions. Many tests also create it to exercise thread-scoped behavior.

*Call graph*: called by 18 (command_execution_started_helper_emits_once, complete_command_execution_item_emits_declined_once_for_pending_command, guardian_command_execution_notifications_wrap_review_lifecycle, interrupted_subagent_activity_removes_missing_thread_watch, test_handle_token_count_event_emits_usage_and_rate_limits, test_handle_token_count_event_without_usage_info, test_handle_turn_complete_emits_completed_without_error, test_handle_turn_complete_emits_error_multiple_turns, test_handle_turn_complete_emits_failed_with_error, test_handle_turn_diff_emits_v2_notification (+8 more)); 1 external calls (new).


##### `ThreadScopedOutgoingMessageSender::send_request`  (lines 133–144)

```
async fn send_request(
        &self,
        payload: ServerRequestPayload,
    ) -> (RequestId, oneshot::Receiver<ClientRequestResult>)
```

**Purpose**: Sends a server request to the clients attached to this thread and returns a way to wait for the client’s answer. This is used for things like asking for approval or input.

**Data flow**: It receives a request payload without an id. It asks the shared OutgoingMessageSender to assign an id, remember the callback, and send the request to this wrapper’s connections, tagged with this wrapper’s thread id. It returns the assigned request id and a one-shot receiver that will later contain the client result or error.

**Call relations**: Thread-specific event handling calls this when the server needs a response from the client. The real sending and callback bookkeeping are delegated to OutgoingMessageSender::send_request_to_connections.

*Call graph*: called by 1 (apply_bespoke_event_handling).


##### `ThreadScopedOutgoingMessageSender::track_effective_permissions_approval_response`  (lines 146–158)

```
fn track_effective_permissions_approval_response(
        &self,
        request_id: RequestId,
        response: RequestPermissionsResponse,
    )
```

**Purpose**: Records analytics when a permissions approval request receives an effective response. This is measurement-only; it does not send a message to the client.

**Data flow**: It receives the request id and the permissions response. It gets the current time in milliseconds and sends the event to the analytics client stored on the shared outgoing sender.

**Call relations**: Thread-level code can call this after permission decisions. It uses now_unix_timestamp_ms so analytics events have a completion time.

*Call graph*: calls 1 internal fn (now_unix_timestamp_ms).


##### `ThreadScopedOutgoingMessageSender::send_server_notification`  (lines 160–170)

```
async fn send_server_notification(&self, notification: ServerNotification)
```

**Purpose**: Sends a notification to the clients attached to this thread. Notifications are one-way messages, like progress updates, that do not expect a reply.

**Data flow**: It receives a notification, records it with analytics, and checks whether this thread has any target connections. If there are none, it stops. Otherwise it asks the shared sender to deliver the notification to those connections.

**Call relations**: Turn and event handling code calls this for thread-local updates such as token counts, diffs, plans, errors, and completion notices. It delegates actual delivery to OutgoingMessageSender::send_server_notification_to_connections.

*Call graph*: called by 10 (apply_bespoke_event_handling, complete_command_execution_item, emit_turn_completed_with_status, handle_error_notification, handle_token_count_event, handle_turn_diff, handle_turn_plan_update, maybe_emit_hook_prompt_item_completed, maybe_emit_raw_response_item_completed, start_command_execution_item); 1 external calls (clone).


##### `ThreadScopedOutgoingMessageSender::send_global_server_notification`  (lines 172–174)

```
async fn send_global_server_notification(&self, notification: ServerNotification)
```

**Purpose**: Sends a notification to all clients instead of only this thread’s connections. This is useful for events that are not tied to one thread view.

**Data flow**: It receives a notification and passes it directly to the shared outgoing sender’s broadcast-style notification method. It does not inspect the thread’s connection list.

**Call relations**: Thread event handling uses this when a thread-scoped component needs to emit a global app-server notification.

*Call graph*: called by 1 (apply_bespoke_event_handling).


##### `ThreadScopedOutgoingMessageSender::abort_pending_server_requests`  (lines 176–191)

```
async fn abort_pending_server_requests(&self)
```

**Purpose**: Cancels all outstanding server requests for this thread because the turn state changed. This prevents old approval or input prompts from resolving after they are no longer valid.

**Data flow**: It creates an internal JSON-RPC error with an extra machine-readable reason, then asks the shared sender to cancel every pending request tagged with this thread id. Each waiting task receives that error.

**Call relations**: Thread event handling calls this during turn transitions. It relies on internal_error to build the error and on OutgoingMessageSender::cancel_requests_for_thread to do the cleanup.

*Call graph*: calls 1 internal fn (internal_error); called by 1 (apply_bespoke_event_handling); 1 external calls (json!).


##### `ThreadScopedOutgoingMessageSender::send_response`  (lines 193–198)

```
async fn send_response(&self, request_id: ConnectionRequestId, response: T)
```

**Purpose**: Sends a successful response to a specific incoming client request. It is a convenience method for thread code that already holds the thread-scoped sender.

**Data flow**: It receives the connection-scoped request id and a typed response payload. It forwards both to the shared outgoing sender, which serializes the response and targets the correct connection.

**Call relations**: Thread event handling and interrupt-response code use this when they finish handling a client request successfully.

*Call graph*: called by 2 (apply_bespoke_event_handling, respond_to_pending_interrupts).


##### `ThreadScopedOutgoingMessageSender::send_error`  (lines 200–206)

```
async fn send_error(
        &self,
        request_id: ConnectionRequestId,
        error: impl Into<JSONRPCErrorError>,
    )
```

**Purpose**: Sends an error response to a specific incoming client request. This is used when thread-level processing cannot complete the request normally.

**Data flow**: It receives the connection-scoped request id and an error-like value. It converts through the shared sender, which builds the JSON-RPC error message and sends it to the original connection.

**Call relations**: Thread event handling and rollback-failure handling call this when they need to answer a client request with failure.

*Call graph*: called by 2 (apply_bespoke_event_handling, handle_thread_rollback_failed).


##### `OutgoingMessageSender::new`  (lines 210–221)

```
fn new(
        sender: mpsc::Sender<OutgoingEnvelope>,
        analytics_events_client: AnalyticsEventsClient,
    ) -> Self
```

**Purpose**: Creates the central outgoing-message coordinator. It starts with no pending callbacks or request contexts and is ready to enqueue messages to the transport layer.

**Data flow**: It receives a channel sender for outgoing envelopes and an analytics client. It creates an atomic counter for future server request ids, two protected maps for pending state, and returns the assembled sender.

**Call relations**: Server setup and many tests construct this before any outgoing communication happens. Other methods on this type then use the stored channel and maps for all outgoing work.

*Call graph*: called by 38 (command_execution_started_helper_emits_once, complete_command_execution_item_emits_declined_once_for_pending_command, guardian_command_execution_notifications_wrap_review_lifecycle, interrupted_subagent_activity_removes_missing_thread_watch, test_handle_token_count_event_emits_usage_and_rate_limits, test_handle_token_count_event_without_usage_info, test_handle_turn_complete_emits_completed_without_error, test_handle_turn_complete_emits_error_multiple_turns, test_handle_turn_complete_emits_failed_with_error, test_handle_turn_diff_emits_v2_notification (+15 more)); 3 external calls (new, new, new).


##### `OutgoingMessageSender::register_request_context`  (lines 223–231)

```
async fn register_request_context(&self, request_context: RequestContext)
```

**Purpose**: Remembers tracing context for an incoming client request that has not yet received its final answer. This keeps later response sending tied to the original trace.

**Data flow**: It receives a RequestContext, locks the request-context table, and inserts it under the connection-scoped request id. If an unresolved context with the same id was already present, it logs a warning.

**Call relations**: Request-processing code calls this near the start of handling a client request. send_response_as and send_error later remove the context when the request is completed.

*Call graph*: 1 external calls (warn!).


##### `OutgoingMessageSender::connection_closed`  (lines 233–236)

```
async fn connection_closed(&self, connection_id: ConnectionId)
```

**Purpose**: Forgets unresolved request contexts for a client connection that has gone away. This prevents memory and trace state from being kept for a disconnected client.

**Data flow**: It receives a connection id, locks the request-context table, and removes every saved context whose connection id matches. It returns nothing.

**Call relations**: Connection cleanup code calls this when a transport connection closes. Tests verify that contexts for other still-open connections remain.


##### `OutgoingMessageSender::request_trace_context`  (lines 238–246)

```
async fn request_trace_context(
        &self,
        request_id: &ConnectionRequestId,
    ) -> Option<W3cTraceContext>
```

**Purpose**: Looks up trace information for an unresolved incoming request. This lets later server work continue the same trace if the request is still known.

**Data flow**: It receives a connection-scoped request id, locks the context table, and finds the matching RequestContext. If present, it asks that context for its trace; otherwise it returns no trace.

**Call relations**: Higher-level request or thread startup code uses this when it needs trace continuity for work spawned after the initial request was registered.


##### `OutgoingMessageSender::record_request_turn_id`  (lines 248–257)

```
async fn record_request_turn_id(
        &self,
        request_id: &ConnectionRequestId,
        turn_id: &str,
    )
```

**Purpose**: Attaches a turn id to the trace for an unresolved request. This improves diagnostics by linking request logs to the conversation turn they affected.

**Data flow**: It receives a connection-scoped request id and a turn id string. It locks the context table, finds the saved RequestContext if it exists, and records the turn id on that context’s span.

**Call relations**: Code that learns the turn id after request registration calls this to enrich tracing. It uses RequestContext::record_turn_id on the stored context.


##### `OutgoingMessageSender::take_request_context`  (lines 259–265)

```
async fn take_request_context(
        &self,
        request_id: &ConnectionRequestId,
    ) -> Option<RequestContext>
```

**Purpose**: Removes and returns the saved context for a request that is about to be answered. “Take” matters here because a request should only have one final response or error.

**Data flow**: It receives a connection-scoped request id, locks the context table, removes the matching entry, and returns it if one was present.

**Call relations**: send_response_as and send_error call this just before sending a final message. The returned context is used to attach tracing to the outgoing send.

*Call graph*: called by 2 (send_error, send_response_as).


##### `OutgoingMessageSender::request_context_count`  (lines 268–270)

```
async fn request_context_count(&self) -> usize
```

**Purpose**: Counts how many unresolved request contexts are currently stored. This exists only for tests.

**Data flow**: It locks the request-context table, reads its size, and returns that number. It does not change runtime behavior.

**Call relations**: Tests call this to prove that responses and disconnects clear saved request contexts instead of leaking them.


##### `OutgoingMessageSender::send_request`  (lines 272–280)

```
async fn send_request(
        &self,
        request: ServerRequestPayload,
    ) -> (RequestId, oneshot::Receiver<ClientRequestResult>)
```

**Purpose**: Broadcasts a server request to clients and returns a way to wait for a client response. It is the general version used when the request is not scoped to specific connections.

**Data flow**: It receives a request payload, passes it to send_request_to_connections with no target connection list and no thread id, and returns the generated request id plus the one-shot receiver.

**Call relations**: Callers use this for app-wide server-to-client requests. The real id creation, callback storage, and enqueueing are done by send_request_to_connections.

*Call graph*: calls 1 internal fn (send_request_to_connections).


##### `OutgoingMessageSender::next_request_id`  (lines 282–284)

```
fn next_request_id(&self) -> RequestId
```

**Purpose**: Creates the next unique id for a server request. Unique ids let later client responses be matched back to the right waiting task.

**Data flow**: It increments an atomic integer counter, which is a number safe to update from multiple tasks, and wraps the previous value as a JSON-RPC integer request id.

**Call relations**: send_request_to_connections calls this before building every outgoing server request.

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

**Purpose**: Sends a server request either to all clients or to selected connections, and records the callback needed to receive the answer. This is the heart of server-initiated request handling.

**Data flow**: It receives optional target connection ids, a request payload, and an optional thread id. It assigns a request id, turns the payload into a full ServerRequest, creates a one-shot channel for the eventual client answer, and stores that sender in the pending-callback map. Then it enqueues either a broadcast envelope or one targeted envelope per connection. If enqueueing fails, it logs the failure and removes the pending callback.

**Call relations**: OutgoingMessageSender::send_request and ThreadScopedOutgoingMessageSender::send_request both flow into this method. Later, notify_client_response, notify_client_error, or cancellation methods use the stored callback entry to finish the waiting receiver.

*Call graph*: calls 2 internal fn (track_server_request, next_request_id); called by 1 (send_request); 6 external calls (send, clone, request_with_id, Request, channel, warn!).


##### `OutgoingMessageSender::replay_requests_to_connection_for_thread`  (lines 352–371)

```
async fn replay_requests_to_connection_for_thread(
        &self,
        connection_id: ConnectionId,
        thread_id: ThreadId,
    )
```

**Purpose**: Resends still-pending thread-specific server requests to a connection. This is useful when a client connection joins or reconnects and needs to see prompts that are still waiting.

**Data flow**: It receives a connection id and thread id. It gathers pending requests for that thread, then enqueues each one as a targeted outgoing request to the given connection, logging if any enqueue fails.

**Call relations**: It builds on pending_requests_for_thread to find the work. The transport writer later receives the queued envelopes and writes them to the client.

*Call graph*: calls 1 internal fn (pending_requests_for_thread); 3 external calls (send, Request, warn!).


##### `OutgoingMessageSender::notify_client_response`  (lines 373–393)

```
async fn notify_client_response(&self, id: RequestId, result: Result)
```

**Purpose**: Completes a pending server request when the client sends a successful response. It wakes the task that has been waiting for that answer.

**Data flow**: It receives the request id and the JSON result from the client. It removes the matching pending callback entry, records analytics for most typed responses, and sends Ok(result) through the one-shot callback. If no callback is found or the receiver is gone, it logs a warning.

**Call relations**: The client-response processing path calls this after decoding a client response. It uses take_request_callback to ensure the request is completed only once.

*Call graph*: calls 3 internal fn (track_server_response, take_request_callback, now_unix_timestamp_ms); 2 external calls (matches!, warn!).


##### `OutgoingMessageSender::notify_client_error`  (lines 395–411)

```
async fn notify_client_error(&self, id: RequestId, error: JSONRPCErrorError)
```

**Purpose**: Completes a pending server request when the client answers with an error. The waiting server task receives that error instead of hanging.

**Data flow**: It receives a request id and JSON-RPC error. It removes the pending callback, records an aborted-request analytics event, and sends Err(error) to the waiting receiver. Missing callbacks or dropped receivers are logged.

**Call relations**: The client-error processing path calls this after decoding an error response from the client. It shares the same callback-removal helper used by successful responses and cancellation.

*Call graph*: calls 3 internal fn (track_server_request_aborted, take_request_callback, now_unix_timestamp_ms); 2 external calls (clone, warn!).


##### `OutgoingMessageSender::cancel_request`  (lines 413–422)

```
async fn cancel_request(&self, id: &RequestId) -> bool
```

**Purpose**: Cancels one pending server request by id. This is used when the server no longer wants to wait for the client’s answer.

**Data flow**: It receives a request id, removes the matching pending callback if present, records an aborted-request analytics event, and returns true if something was canceled or false if no pending request matched.

**Call relations**: Cancellation code calls this for a single request. It uses take_request_callback so later client responses for the same id will no longer find a waiter.

*Call graph*: calls 3 internal fn (track_server_request_aborted, take_request_callback, now_unix_timestamp_ms).


##### `OutgoingMessageSender::cancel_all_requests`  (lines 424–443)

```
async fn cancel_all_requests(&self, error: Option<JSONRPCErrorError>)
```

**Purpose**: Cancels every pending server request. This is a broad cleanup path, for example during shutdown or major connection state changes.

**Data flow**: It drains the entire pending-callback map into a temporary list. For each entry it records an aborted-request analytics event, and if an error was supplied, it sends that error to the waiting receiver.

**Call relations**: Broader lifecycle code can use this to clear all outstanding server-to-client waits. It does not call take_request_callback because it drains the whole map at once.

*Call graph*: calls 2 internal fn (track_server_request_aborted, now_unix_timestamp_ms); 1 external calls (warn!).


##### `OutgoingMessageSender::take_request_callback`  (lines 445–451)

```
async fn take_request_callback(
        &self,
        id: &RequestId,
    ) -> Option<(RequestId, PendingCallbackEntry)>
```

**Purpose**: Removes the pending callback for one server request and returns it. This is the small shared helper that makes completion and cancellation one-time actions.

**Data flow**: It receives a request id, locks the pending-callback map, removes the entry with that id, and returns both the id and the stored callback entry if found.

**Call relations**: notify_client_response, notify_client_error, and cancel_request all call this before finishing a pending request. Once it returns an entry, that request is no longer considered pending.

*Call graph*: called by 3 (cancel_request, notify_client_error, notify_client_response).


##### `OutgoingMessageSender::pending_requests_for_thread`  (lines 453–466)

```
async fn pending_requests_for_thread(
        &self,
        thread_id: ThreadId,
    ) -> Vec<ServerRequest>
```

**Purpose**: Lists the still-pending server requests that belong to one thread. This lets the server replay or inspect outstanding prompts for that thread.

**Data flow**: It receives a thread id, locks the pending-callback map, filters entries whose stored thread id matches, clones their ServerRequest values, sorts them by request id, and returns the sorted list.

**Call relations**: replay_requests_to_connection_for_thread calls this before resending pending prompts to a connection. Tests also verify that the returned order is stable.

*Call graph*: called by 1 (replay_requests_to_connection_for_thread).


##### `OutgoingMessageSender::cancel_requests_for_thread`  (lines 468–501)

```
async fn cancel_requests_for_thread(
        &self,
        thread_id: ThreadId,
        error: Option<JSONRPCErrorError>,
    )
```

**Purpose**: Cancels every pending server request associated with one thread. This prevents old thread prompts from surviving after that thread’s turn changes or is aborted.

**Data flow**: It receives a thread id and optional error. It finds all pending callback entries tagged with that thread, removes them from the map, records an aborted-request analytics event for each, and sends the supplied error to each waiter if one was provided.

**Call relations**: ThreadScopedOutgoingMessageSender::abort_pending_server_requests uses this during turn transitions. Thread cleanup code can also call it directly when it needs to clear only one thread’s pending requests.

*Call graph*: calls 2 internal fn (track_server_request_aborted, now_unix_timestamp_ms); 2 external calls (with_capacity, warn!).


##### `OutgoingMessageSender::send_response`  (lines 503–508)

```
async fn send_response(&self, request_id: ConnectionRequestId, response: T)
```

**Purpose**: Sends a successful response to an incoming client request using any response type that can become a client response payload. It is a typed convenience wrapper.

**Data flow**: It receives a connection-scoped request id and a response value. It converts the response into ClientResponsePayload and forwards it to send_response_as.

**Call relations**: send_result calls this for successful results, and thread-scoped sending also delegates here through the shared sender.

*Call graph*: calls 1 internal fn (send_response_as); called by 1 (send_result); 1 external calls (into).


##### `OutgoingMessageSender::send_response_as`  (lines 510–551)

```
async fn send_response_as(
        &self,
        request_id: ConnectionRequestId,
        response: ClientResponsePayload,
    )
```

**Purpose**: Serializes and sends a successful JSON-RPC response to the exact connection that made the request. It also clears the saved request context because the request is now finished.

**Data flow**: It receives a connection-scoped request id and a ClientResponsePayload. It converts the payload into JSON-RPC response parts, tracks analytics if there is a typed response event, removes the saved RequestContext, and sends a response envelope to the original connection. If serialization fails, it sends an internal error response instead.

**Call relations**: OutgoingMessageSender::send_response calls this after type conversion. It uses take_request_context before final sending and hands the actual enqueue operation to send_outgoing_message_to_connection, or to send_error_inner on serialization failure.

*Call graph*: calls 4 internal fn (internal_error, send_error_inner, send_outgoing_message_to_connection, take_request_context); called by 1 (send_response); 3 external calls (into_jsonrpc_parts_and_payload, Response, format!).


##### `OutgoingMessageSender::send_server_notification`  (lines 553–556)

```
async fn send_server_notification(&self, notification: ServerNotification)
```

**Purpose**: Broadcasts a server notification to clients. Notifications are one-way updates and do not create pending callbacks.

**Data flow**: It receives a notification and calls send_server_notification_to_connections with an empty target list, which this file treats as broadcast-to-all.

**Call relations**: Account login/import progress code calls this for app-wide notifications. The lower helper performs the actual enqueueing.

*Call graph*: calls 1 internal fn (send_server_notification_to_connections); called by 3 (send_chatgpt_login_completion_notifications, send_completed_import_notification, send_import_progress).


##### `OutgoingMessageSender::send_server_notification_to_connections`  (lines 558–593)

```
async fn send_server_notification_to_connections(
        &self,
        connection_ids: &[ConnectionId],
        notification: ServerNotification,
    )
```

**Purpose**: Sends a one-way notification either to all clients or to a selected list of connections. It is the main delivery path for app-server notifications.

**Data flow**: It receives a list of target connection ids and a notification. It wraps the notification as an outgoing app-server notification. If the list is empty, it enqueues one broadcast envelope. Otherwise it enqueues one targeted envelope per connection, logging any failures.

**Call relations**: Both global notification sending and thread-scoped notification sending use this. The transport layer later consumes the queued envelopes and writes the serialized JSON-RPC notification.

*Call graph*: called by 1 (send_server_notification); 6 external calls (send, clone, is_empty, AppServerNotification, trace!, warn!).


##### `OutgoingMessageSender::send_server_notification_to_connection_and_wait`  (lines 595–615)

```
async fn send_server_notification_to_connection_and_wait(
        &self,
        connection_id: ConnectionId,
        notification: ServerNotification,
    )
```

**Purpose**: Sends a notification to one connection and waits until the transport says the write is complete. This is useful when ordering or flush confirmation matters.

**Data flow**: It receives a connection id and notification, wraps the notification, creates a one-shot completion channel, and enqueues a targeted envelope containing the completion sender. Then it waits for the completion receiver to fire, ignoring the final value.

**Call relations**: Code that needs stronger delivery timing can call this instead of the normal fire-and-forget notification method. The transport writer is expected to signal the included completion sender after writing.

*Call graph*: 6 external calls (send, clone, AppServerNotification, channel, trace!, warn!).


##### `OutgoingMessageSender::send_error`  (lines 617–625)

```
async fn send_error(
        &self,
        request_id: ConnectionRequestId,
        error: impl Into<JSONRPCErrorError>,
    )
```

**Purpose**: Sends an error response to the connection that made a client request. It also clears that request’s saved trace context.

**Data flow**: It receives a connection-scoped request id and an error-like value. It removes the request context, converts the error into a JSON-RPC error, and passes everything to send_error_inner.

**Call relations**: send_result calls this for failed results, and thread-scoped error sending delegates here. send_error_inner builds the outgoing error envelope.

*Call graph*: calls 2 internal fn (send_error_inner, take_request_context); called by 1 (send_result); 1 external calls (into).


##### `OutgoingMessageSender::send_result`  (lines 627–641)

```
async fn send_result(
        &self,
        request_id: ConnectionRequestId,
        result: std::result::Result<T, E>,
    )
```

**Purpose**: Turns a normal Rust result into either a success response or an error response. This gives callers one simple method when their work can succeed or fail.

**Data flow**: It receives a request id and a Result value. If the result is Ok, it sends the contained response. If it is Err, it sends the contained error.

**Call relations**: Request handlers can call this after finishing work instead of writing their own match. It delegates to send_response and send_error.

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

**Purpose**: Builds the actual outgoing error message and sends it to one connection. This keeps the common error-envelope construction in one place.

**Data flow**: It receives an optional request context, a connection-scoped request id, and a JSON-RPC error. It creates an OutgoingMessage::Error with the request id and error, then sends it to the request’s connection.

**Call relations**: send_error uses this for normal error responses, and send_response_as uses it when response serialization fails. It delegates enqueueing and trace instrumentation to send_outgoing_message_to_connection.

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

**Purpose**: Enqueues one already-built outgoing message for one connection, optionally under the original request’s tracing span. This is the final common send step for responses and errors.

**Data flow**: It receives optional request context, a connection id, a prepared outgoing message, and a label such as “response” or “error.” It creates a targeted envelope and sends it through the outgoing channel. If a context exists, it instruments the send with that span. If enqueueing fails, it logs a warning.

**Call relations**: send_response_as and send_error_inner call this after building final response or error messages. The transport layer later consumes the envelope.

*Call graph*: called by 2 (send_error_inner, send_response_as); 2 external calls (send, warn!).


##### `now_unix_timestamp_ms`  (lines 686–693)

```
fn now_unix_timestamp_ms() -> u64
```

**Purpose**: Returns the current time as milliseconds since the Unix epoch, which is the common timestamp starting point of January 1, 1970. Analytics events use this timestamp.

**Data flow**: It reads the system clock, subtracts the Unix epoch, converts the duration to milliseconds, and returns it as an unsigned integer. If the clock or conversion fails, it safely returns zero.

**Call relations**: Analytics-related methods call this when recording client responses, aborted requests, cancellations, and effective permissions approval responses.

*Call graph*: called by 6 (cancel_all_requests, cancel_request, cancel_requests_for_thread, notify_client_error, notify_client_response, track_effective_permissions_approval_response); 1 external calls (now).


##### `tests::verify_server_notification_serialization`  (lines 729–751)

```
fn verify_server_notification_serialization()
```

**Purpose**: Checks that a server notification serializes to the expected JSON-RPC method and parameters. This protects the wire format clients depend on.

**Data flow**: It builds an account-login-completed notification, wraps it as an outgoing app-server notification, serializes it to JSON, and compares the JSON to the expected object.

**Call relations**: This is a unit test for notification serialization. It does not run in production, but it guards the behavior used by notification-sending methods.

*Call graph*: 4 external calls (AccountLoginCompleted, nil, AppServerNotification, assert_eq!).


##### `tests::verify_account_login_completed_notification_serialization`  (lines 754–776)

```
fn verify_account_login_completed_notification_serialization()
```

**Purpose**: Verifies the exact JSON shape for an account login completion notification. This ensures clients receive the method name and fields they expect.

**Data flow**: It creates a login-completed notification with a known UUID, converts it through OutgoingMessage serialization, and asserts that the resulting JSON matches the expected method and params.

**Call relations**: This test supports the notification path by catching accidental protocol changes before runtime.

*Call graph*: 4 external calls (AccountLoginCompleted, nil, AppServerNotification, assert_eq!).


##### `tests::verify_account_rate_limits_notification_serialization`  (lines 779–823)

```
fn verify_account_rate_limits_notification_serialization()
```

**Purpose**: Verifies the JSON format for account rate-limit updates. Rate-limit data has nested fields, so this test makes sure those fields stay correctly named and shaped.

**Data flow**: It builds a rate-limit snapshot notification, wraps it as an outgoing notification, serializes it, and compares the full JSON object to the expected structure.

**Call relations**: This test protects clients that listen for account/rateLimits/updated notifications sent through this file’s notification methods.

*Call graph*: 3 external calls (AccountRateLimitsUpdated, AppServerNotification, assert_eq!).


##### `tests::verify_account_updated_notification_serialization`  (lines 826–845)

```
fn verify_account_updated_notification_serialization()
```

**Purpose**: Checks that account update notifications serialize correctly. This covers fields such as authentication mode and plan type.

**Data flow**: It creates an account-updated notification, wraps and serializes it, then asserts that the JSON method and parameter names match the protocol.

**Call relations**: This test guards the wire format used when OutgoingMessageSender broadcasts account update notifications.

*Call graph*: 3 external calls (AccountUpdated, AppServerNotification, assert_eq!).


##### `tests::verify_config_warning_notification_serialization`  (lines 848–869)

```
fn verify_config_warning_notification_serialization()
```

**Purpose**: Checks the JSON shape for configuration warning notifications. These warnings tell clients about configuration problems in a predictable format.

**Data flow**: It builds a config warning with summary and details, serializes it as an outgoing notification, and compares the JSON to the expected method and params.

**Call relations**: This unit test protects the notification format consumed by clients when config warnings are sent.

*Call graph*: 3 external calls (ConfigWarning, AppServerNotification, assert_eq!).


##### `tests::verify_guardian_warning_notification_serialization`  (lines 872–891)

```
fn verify_guardian_warning_notification_serialization()
```

**Purpose**: Verifies the JSON format for guardian warning notifications. These messages tell the client when an automatic safety review denied an action.

**Data flow**: It creates a guardian warning with a thread id and message, serializes it through OutgoingMessage, and asserts the expected JSON result.

**Call relations**: This test supports the same notification serialization used by thread-scoped notification sending.

*Call graph*: 3 external calls (GuardianWarning, AppServerNotification, assert_eq!).


##### `tests::verify_model_rerouted_notification_serialization`  (lines 894–919)

```
fn verify_model_rerouted_notification_serialization()
```

**Purpose**: Checks that model rerouting notifications serialize with the correct method name and fields. Clients rely on this to explain why a model changed.

**Data flow**: It builds a model-rerouted notification with thread, turn, source model, target model, and reason, then serializes and compares it to expected JSON.

**Call relations**: This test protects notifications that can be sent by the server when model choice changes during a turn.

*Call graph*: 3 external calls (ModelRerouted, AppServerNotification, assert_eq!).


##### `tests::verify_model_verification_notification_serialization`  (lines 922–943)

```
fn verify_model_verification_notification_serialization()
```

**Purpose**: Verifies the JSON format for model verification notifications. These notifications report model-related verification status to the client.

**Data flow**: It creates a notification with one verification value, serializes it as an outgoing notification, and checks the resulting JSON array and fields.

**Call relations**: This test guards a notification variant delivered through the same outgoing notification machinery.

*Call graph*: 4 external calls (ModelVerification, AppServerNotification, assert_eq!, vec!).


##### `tests::verify_turn_moderation_metadata_notification_serialization`  (lines 946–968)

```
fn verify_turn_moderation_metadata_notification_serialization()
```

**Purpose**: Checks that turn moderation metadata notifications keep arbitrary metadata in the expected JSON location. This matters because metadata may be displayed or interpreted by clients.

**Data flow**: It builds a moderation metadata notification containing a small JSON object, serializes it, and compares the full output to the expected JSON-RPC method and params.

**Call relations**: This test protects the notification format used by turn-related event handling.

*Call graph*: 4 external calls (TurnModerationMetadata, AppServerNotification, assert_eq!, json!).


##### `tests::server_request_response_from_result_decodes_typed_response`  (lines 971–1010)

```
fn server_request_response_from_result_decodes_typed_response()
```

**Purpose**: Verifies that a raw client result for a server request can be decoded into the correct typed server response. This proves the callback result can be interpreted safely.

**Data flow**: It builds a command-execution approval request, feeds it a JSON result containing a decision, decodes that result into a typed ServerResponse, and checks the request id and decision.

**Call relations**: This test supports notify_client_response, which receives raw client results and records analytics after decoding typed responses.

*Call graph*: 4 external calls (Integer, assert_eq!, json!, panic!).


##### `tests::send_response_routes_to_target_connection`  (lines 1012–1050)

```
async fn send_response_routes_to_target_connection()
```

**Purpose**: Checks that a response goes only to the connection that made the request. This prevents one client from receiving another client’s answer.

**Data flow**: It creates an OutgoingMessageSender with a test channel, sends a response for connection 42, reads the queued envelope, and asserts that the envelope targets connection 42 with the expected response id and JSON result.

**Call relations**: This test exercises OutgoingMessageSender::send_response and the lower response enqueue path.

*Call graph*: calls 2 internal fn (disabled, new); 7 external calls (ThreadArchive, from_secs, Integer, new, assert_eq!, panic!, timeout).


##### `tests::send_response_clears_registered_request_context`  (lines 1053–1081)

```
async fn send_response_clears_registered_request_context()
```

**Purpose**: Verifies that sending a final response removes the saved request context. This prevents stale trace state from accumulating.

**Data flow**: It registers a RequestContext, confirms one context is stored, sends a response for that request, and then confirms the context table is empty.

**Call relations**: This test covers register_request_context, request_context_count, and the context-removal behavior inside send_response.

*Call graph*: calls 3 internal fn (disabled, new, new); 5 external calls (ThreadArchive, Integer, new, assert_eq!, info_span!).


##### `tests::send_error_routes_to_target_connection`  (lines 1084–1116)

```
async fn send_error_routes_to_target_connection()
```

**Purpose**: Checks that an error response is sent to the correct connection with the correct request id and error body.

**Data flow**: It creates a test sender, sends an internal error for a request on connection 9, reads the queued envelope, and asserts the connection id, outgoing message type, request id, and error match.

**Call relations**: This test exercises OutgoingMessageSender::send_error and the shared targeted-send path.

*Call graph*: calls 3 internal fn (disabled, internal_error, new); 6 external calls (from_secs, Integer, new, assert_eq!, panic!, timeout).


##### `tests::send_server_notification_to_connection_and_wait_tracks_write_completion`  (lines 1119–1161)

```
async fn send_server_notification_to_connection_and_wait_tracks_write_completion()
```

**Purpose**: Verifies that the wait-for-write notification method really waits until the transport signals completion. This protects code that needs a notification flushed before continuing.

**Data flow**: It starts send_server_notification_to_connection_and_wait in a task, reads the queued targeted envelope, checks that a write-completion sender is attached, sends the completion signal, and confirms the task finishes.

**Call relations**: This test covers OutgoingMessageSender::send_server_notification_to_connection_and_wait and the completion channel contract with the transport layer.

*Call graph*: calls 2 internal fn (disabled, new); 8 external calls (from_secs, ModelRerouted, new, assert!, assert_eq!, panic!, spawn, timeout).


##### `tests::connection_closed_clears_registered_request_contexts`  (lines 1164–1196)

```
async fn connection_closed_clears_registered_request_contexts()
```

**Purpose**: Checks that closing one connection removes only that connection’s request contexts. Contexts for other live connections must remain.

**Data flow**: It registers two contexts on different connections, confirms both are stored, closes one connection through connection_closed, and confirms only one context remains.

**Call relations**: This test exercises RequestContext::new, register_request_context, connection_closed, and request_context_count.

*Call graph*: calls 3 internal fn (disabled, new, new); 4 external calls (Integer, new, assert_eq!, info_span!).


##### `tests::notify_client_error_forwards_error_to_waiter`  (lines 1199–1227)

```
async fn notify_client_error_forwards_error_to_waiter()
```

**Purpose**: Verifies that when a client returns an error for a pending server request, the waiting receiver gets that same error. This prevents approval or prompt waits from hanging silently.

**Data flow**: It sends a server request, keeps the returned receiver, calls notify_client_error with an internal error, waits on the receiver, and asserts that it receives Err(error).

**Call relations**: This test covers send_request, notify_client_error, and the pending callback table used between them.

*Call graph*: calls 4 internal fn (disabled, internal_error, new, new); 5 external calls (from_secs, new, ApplyPatchApproval, assert_eq!, timeout).


##### `tests::pending_requests_for_thread_returns_thread_requests_in_request_id_order`  (lines 1230–1290)

```
async fn pending_requests_for_thread_returns_thread_requests_in_request_id_order()
```

**Purpose**: Checks that pending requests for a thread are returned in request-id order. Stable ordering makes replay predictable for clients.

**Data flow**: It creates a thread-scoped sender, sends several thread-tagged requests, asks the shared sender for pending requests for that thread, and compares the returned ids to the send order.

**Call relations**: This test exercises ThreadScopedOutgoingMessageSender::send_request and OutgoingMessageSender::pending_requests_for_thread.

*Call graph*: calls 4 internal fn (disabled, new, new, new); 7 external calls (new, DynamicToolCall, FileChangeRequestApproval, ToolRequestUserInput, assert_eq!, json!, vec!).


##### `tests::cancel_requests_for_thread_cancels_all_thread_requests`  (lines 1293–1351)

```
async fn cancel_requests_for_thread_cancels_all_thread_requests()
```

**Purpose**: Verifies that canceling a thread’s pending requests resolves every waiter with the supplied error and leaves no pending requests behind.

**Data flow**: It sends two thread-scoped requests, calls cancel_requests_for_thread with an error, waits for both receivers, checks that both received the error, and confirms the thread has no pending requests.

**Call relations**: This test covers ThreadScopedOutgoingMessageSender::send_request, OutgoingMessageSender::cancel_requests_for_thread, and pending_requests_for_thread.

*Call graph*: calls 5 internal fn (disabled, internal_error, new, new, new); 9 external calls (new, from_secs, DynamicToolCall, ToolRequestUserInput, assert!, assert_eq!, json!, timeout, vec!).


### `app-server/src/request_processors/initialize_processor.rs`

`orchestration` · `connection initialization and early request handling`

When a client first connects to the app server, it must introduce itself before normal requests can be accepted. This file is the gatekeeper for that first step. It checks that the connection has not already been initialized, reads the client's name, version, and capabilities, and stores those details in the connection's session state. That session state is like a name badge and permission card for the rest of the connection.

The file also updates shared process-wide identity information for real clients, such as the default originator and user-agent suffix. A user agent is the text sent to other services to say what software is making a request. Some internal clients are deliberately excluded from changing this global identity, so background server pieces do not pretend to be the user-facing client.

After the session is marked initialized, the processor records an analytics event, applies the configured residency requirement, builds an initialize response containing the Codex user agent, home directory, and platform information, and sends that response back to the client. It can also send configuration warning notifications either to one newly initialized connection or to all connections. Finally, once a connection is initialized, this file provides a small helper to record analytics for later client requests.

#### Function details

##### `InitializeRequestProcessor::new`  (lines 28–42)

```
fn new(
        outgoing: Arc<OutgoingMessageSender>,
        analytics_events_client: AnalyticsEventsClient,
        config: Arc<Config>,
        config_warnings: Vec<ConfigWarningNotification>,
```

**Purpose**: Creates an InitializeRequestProcessor with everything it needs to answer initialize requests: an outgoing message sender, analytics client, configuration, startup warnings, and the type of RPC transport being used. It is used during server setup so later request handling has one ready-made object to call.

**Data flow**: It receives shared messaging, analytics, configuration, warning, and transport objects. It stores them inside a new processor, wrapping the warning list so it can be cheaply shared when the processor is cloned. The result is a processor instance ready to be used for initialization work.

**Call relations**: A higher-level constructor calls this when wiring the app server together. After that setup step, the returned processor is the object other request-handling code uses when a client sends initialize or when initialization-related notifications need to be sent.

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

**Purpose**: Processes a client's initialize request and turns an uninitialized connection into an initialized one. It validates the client identity, stores the client's capabilities, records analytics, sends the initialize response, and optionally marks the connection as ready for outbound messages immediately.

**Data flow**: It starts with a connection id, request id, initialize parameters, the connection's current session state, and an optional shared boolean flag. It first refuses the request if the session is already initialized. It then extracts capabilities such as experimental API access, request attestation, and notification opt-outs. It validates the client name as a legal HTTP header value, because that name may be used as request metadata later. It writes the accepted details into the session state. If the client is not one of the special internal non-originating clients, it may update global client identity, including the default originator and user-agent suffix. It records an initialize analytics event, applies the residency setting from config, builds an InitializeResponse with user-agent, Codex home, and operating-system information, and sends that response. If the optional atomic boolean is present, it sets it to true and returns true; otherwise it returns false. Errors come back as JSON-RPC errors when the request is invalid.

**Call relations**: The client request handler calls this when it receives an initialize request. Inside, it asks the session whether it is already initialized, commits the initialized session state, calls login-client helpers to update process-wide identity, calls analytics to record the initialize event, and uses the outgoing message sender to reply to the exact connection and request. The boolean return tells the caller whether this function already marked outbound sending as initialized, which matters because some transports need to send connection-scoped notifications before opening the outbound path.

*Call graph*: calls 6 internal fn (track_initialize, initialize, initialized, get_codex_user_agent, set_default_client_residency_requirement, set_default_originator); called by 1 (handle_client_request); 5 external calls (from_str, new, clone, format!, warn!).


##### `InitializeRequestProcessor::send_initialize_notifications_to_connection`  (lines 160–172)

```
async fn send_initialize_notifications_to_connection(
        &self,
        connection_id: ConnectionId,
    )
```

**Purpose**: Sends any configuration warnings to one specific connection after initialization. This lets a newly connected client learn about startup configuration problems without broadcasting duplicates to everyone else.

**Data flow**: It receives a connection id and reads the stored list of configuration warning notifications. For each warning, it wraps the warning as a server notification and sends it only to the given connection through the outgoing message sender. It does not return data; its visible effect is sending messages.

**Call relations**: A higher-level initialization notification path calls this when only one connection should receive the warnings. This function does not decide what the warnings mean; it simply takes the warnings captured during configuration and hands them to the outgoing messaging layer for that connection.

*Call graph*: called by 1 (send_initialize_notifications_to_connection); 1 external calls (ConfigWarning).


##### `InitializeRequestProcessor::send_initialize_notifications`  (lines 174–180)

```
async fn send_initialize_notifications(&self)
```

**Purpose**: Broadcasts any configuration warnings to all connected clients. This is useful when initialization-related warnings should be visible everywhere, not just to one newly connected client.

**Data flow**: It reads the processor's stored configuration warnings. For each warning, it turns it into a server notification and sends it through the outgoing message sender without limiting it to a single connection. It produces no direct return value; it sends notifications as its side effect.

**Call relations**: A higher-level notification path calls this when initialization warnings should be sent broadly. It relies on the outgoing messaging layer to perform the actual broadcast, while this function supplies the warning content in the expected server-notification form.

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

**Purpose**: Records analytics for a normal client request after the connection has already been initialized. This gives the system visibility into what initialized clients are asking the server to do.

**Data flow**: It receives the connection id, request id, and the client request itself. It passes those details to the analytics events client, using the raw connection id value along with the request id and request content. It returns nothing; the outcome is an analytics record being submitted.

**Call relations**: The initialized request dispatcher calls this when it is about to process or has received a request from an initialized client. This function is a small bridge from request dispatching into the analytics system, keeping the analytics call in the same processor that owns initialization-related tracking.

*Call graph*: calls 1 internal fn (track_request); called by 1 (dispatch_initialized_client_request).


### `app-server/src/transport.rs`

`io_transport` · `request handling and main loop`

This file sits between the rest of the app server and the actual connection machinery, such as standard input/output, WebSocket, or control-socket transports. Think of it like a mailroom: other parts of the server hand it an outgoing envelope, and it decides whether that envelope goes to one client, many clients, or nowhere.

It tracks two kinds of connection information. `ConnectionState` is used for an active incoming connection and includes session data plus shared flags about what that client supports. `OutboundConnectionState` is the sending side: it remembers whether the client has finished setup, whether it opted into experimental features, which notification types it does not want, where to send queued messages, and whether the server is allowed to forcibly disconnect it.

The important safety work happens before a message is sent. Experimental notifications are hidden from clients that did not enable the experimental API. Some request fields are stripped out for older or less-capable clients. Notifications are also skipped when a client has opted out of that notification method. If a disconnectable client’s outgoing queue is full, the server treats it as too slow and disconnects it rather than letting one slow client block everyone else.

Without this file, the server would have no central place to apply client capabilities, opt-out rules, and back-pressure protection for outgoing traffic.

#### Function details

##### `ConnectionState::new`  (lines 47–59)

```
fn new(
        _origin: ConnectionOrigin,
        outbound_initialized: Arc<AtomicBool>,
        outbound_experimental_api_enabled: Arc<AtomicBool>,
        outbound_opted_out_notification_methods: A
```

**Purpose**: Creates the shared state for a newly connected client. It bundles together flags about outgoing capabilities with a fresh session record for that connection.

**Data flow**: It receives the connection’s origin and shared pieces of state, including whether outgoing messages are initialized, whether experimental API features are enabled, and which notifications the client opted out of. It stores those shared pieces and creates a new `ConnectionSessionState`, which is the per-client session memory. The result is a `ConnectionState` ready to be attached to the connection.

**Call relations**: This is used when a connection is being set up. It calls the session-state constructor so the connection starts with clean session data while still sharing capability flags with the outbound side of the same connection.

*Call graph*: calls 1 internal fn (new); 1 external calls (new).


##### `OutboundConnectionState::new`  (lines 71–85)

```
fn new(
        writer: mpsc::Sender<QueuedOutgoingMessage>,
        initialized: Arc<AtomicBool>,
        experimental_api_enabled: Arc<AtomicBool>,
        opted_out_notification_methods: Arc<RwLock
```

**Purpose**: Creates the sending-side record for a connection. This record tells the router how to send messages to that client and what limits or preferences apply.

**Data flow**: It receives a message sender, shared flags for initialization and experimental API support, the shared set of opted-out notification methods, and an optional cancellation token used for disconnecting. It stores these values unchanged. The output is an `OutboundConnectionState` that can later be used to queue outgoing messages or request a disconnect.

**Call relations**: This is called when outbound communication is prepared, including from setup code such as `start_uninitialized` and from tests that check broadcast behavior, experimental feature filtering, and notification opt-out behavior. Later, routing code reads the state it created to decide whether and how to send each message.

*Call graph*: called by 10 (start_uninitialized, broadcast_does_not_block_on_slow_connection, command_execution_request_approval_keeps_additional_permissions_with_capability, command_execution_request_approval_strips_additional_permissions_without_capability, experimental_notifications_are_dropped_without_capability, experimental_notifications_are_preserved_with_capability, to_connection_notification_respects_opt_out_filters, to_connection_notifications_are_dropped_for_opted_out_clients, to_connection_notifications_are_preserved_for_non_opted_out_clients, to_connection_stdio_waits_instead_of_disconnecting_when_writer_queue_is_full).


##### `OutboundConnectionState::can_disconnect`  (lines 87–89)

```
fn can_disconnect(&self) -> bool
```

**Purpose**: Answers whether this connection can be forcibly disconnected by this router. A connection can be disconnected only if it was given a cancellation token.

**Data flow**: It reads the optional disconnect token stored in the connection state. If the token exists, it returns `true`; otherwise it returns `false`. It does not change anything.

**Call relations**: This is used inside `send_message_to_connection` before choosing how to queue a message. If a connection can be disconnected, the router uses a non-blocking send and may drop the connection if its queue is full; otherwise it waits for space instead.


##### `OutboundConnectionState::request_disconnect`  (lines 91–95)

```
fn request_disconnect(&self)
```

**Purpose**: Asks the connection to shut down, if this connection supports that. It is the polite trigger used by the router when a client is gone or too slow.

**Data flow**: It looks for the optional cancellation token stored in the connection state. If one is present, it cancels that token, which signals the connection task to stop. It returns no value and does nothing when there is no token.

**Call relations**: This is called by `disconnect_connection` after the connection has been removed from the active map. It hands off the actual shutdown signal to the connection task through the cancellation token.


##### `should_skip_notification_for_connection`  (lines 98–121)

```
fn should_skip_notification_for_connection(
    connection_state: &OutboundConnectionState,
    message: &OutgoingMessage,
) -> bool
```

**Purpose**: Decides whether a notification should be withheld from a particular connection. It protects clients from receiving experimental messages they did not ask for and respects notification opt-out settings.

**Data flow**: It receives one connection’s outbound state and one outgoing message. It reads the connection’s opted-out notification set through a read lock, which is a shared-data guard that lets many readers look safely at the same data. If the lock cannot be read, it logs a warning and chooses not to skip the message. For app-server notifications, it checks whether the notification is experimental and whether the client enabled experimental APIs, then checks whether the notification method is in the opt-out set. It returns `true` when the message should be skipped and `false` otherwise.

**Call relations**: This helper is called by `send_message_to_connection` for direct sends and by `route_outgoing_envelope` when selecting broadcast targets. It acts as the gatekeeper before a notification is queued for a client.

*Call graph*: called by 1 (send_message_to_connection); 1 external calls (warn!).


##### `disconnect_connection`  (lines 123–132)

```
fn disconnect_connection(
    connections: &mut HashMap<ConnectionId, OutboundConnectionState>,
    connection_id: ConnectionId,
) -> bool
```

**Purpose**: Removes a connection from the active outbound connection list and signals it to shut down. This keeps the server from continuing to send messages to a connection that should no longer be used.

**Data flow**: It receives the mutable map of active connections and the ID of the connection to remove. If that ID is present, it takes the connection state out of the map, asks it to disconnect, and returns `true`. If the ID is not present, it returns `false` and changes nothing.

**Call relations**: This is called by `send_message_to_connection` when a send fails, the outgoing channel is closed, or a disconnectable client’s queue is full. It is the cleanup step after the router decides a connection is no longer healthy.

*Call graph*: called by 1 (send_message_to_connection).


##### `send_message_to_connection`  (lines 134–172)

```
async fn send_message_to_connection(
    connections: &mut HashMap<ConnectionId, OutboundConnectionState>,
    connection_id: ConnectionId,
    message: OutgoingMessage,
    write_complete_tx: Option<
```

**Purpose**: Attempts to send one outgoing message to one specific connection. Before sending, it filters the message for that client’s capabilities and may skip it entirely if the client should not receive it.

**Data flow**: It receives the active connection map, a target connection ID, the outgoing message, and optionally a one-time completion sender used to report when writing is done. It looks up the connection; if missing, it logs that the message is being dropped. If present, it filters the message, checks notification skip rules, wraps the result into a queued message, and sends it through the connection’s writer channel. For disconnectable clients it tries to send immediately; if the queue is full or closed, it removes and disconnects the client. For non-disconnectable clients it waits for the send to complete and disconnects only if the channel has closed. It returns `true` when this call caused a disconnect and `false` otherwise.

**Call relations**: This is the worker used by `route_outgoing_envelope` for both direct messages and broadcasts. It calls `filter_outgoing_message_for_connection` to adapt the message, `should_skip_notification_for_connection` to respect capabilities and opt-outs, and `disconnect_connection` when sending is no longer possible.

*Call graph*: calls 3 internal fn (disconnect_connection, filter_outgoing_message_for_connection, should_skip_notification_for_connection); called by 1 (route_outgoing_envelope); 1 external calls (warn!).


##### `filter_outgoing_message_for_connection`  (lines 174–196)

```
fn filter_outgoing_message_for_connection(
    connection_state: &OutboundConnectionState,
    message: OutgoingMessage,
) -> OutgoingMessage
```

**Purpose**: Adjusts an outgoing message so it is safe for the receiving client’s supported feature set. In particular, it removes experimental request fields when the client has not enabled the experimental API.

**Data flow**: It receives a connection state and an outgoing message. It reads the connection’s experimental-API flag. If the message is a command-execution approval request and the client did not enable experimental features, it strips experimental fields from the request parameters and rebuilds the message. All other messages, or messages for clients with experimental support, pass through unchanged. The output is the message version that should be sent to that connection.

**Call relations**: This is called by `send_message_to_connection` before notification skipping and queuing. It ensures each client sees a message shape it understands, instead of forcing the rest of the server to know each client’s capabilities.

*Call graph*: called by 1 (send_message_to_connection); 1 external calls (Request).


##### `route_outgoing_envelope`  (lines 198–237)

```
async fn route_outgoing_envelope(
    connections: &mut HashMap<ConnectionId, OutboundConnectionState>,
    envelope: OutgoingEnvelope,
)
```

**Purpose**: Routes an outgoing envelope either to one named connection or to every suitable initialized connection. This is the main outward-facing routing function in the file.

**Data flow**: It receives the mutable map of active outbound connections and an `OutgoingEnvelope`, which is a wrapper that says where a message should go. For a direct envelope, it sends the message to the named connection and keeps any write-completion signal attached. For a broadcast envelope, it first builds a list of initialized connections that should receive the notification, excluding clients that are not ready or should skip it. It then sends a cloned copy of the message to each target connection without a write-completion signal.

**Call relations**: This is called by `start_uninitialized`, which is part of the wider server startup and connection loop. It delegates actual per-connection sending to `send_message_to_connection`, so the same filtering, opt-out checks, and slow-client disconnect behavior apply to both direct sends and broadcasts.

*Call graph*: calls 1 internal fn (send_message_to_connection); called by 1 (start_uninitialized).


### `app-server/src/in_process.rs`

`orchestration` · `startup, request handling, event delivery, shutdown`

Normally, the app server behaves like a separate service: a client sends JSON-RPC messages over a transport such as stdio or a websocket. This file keeps the same app-server behavior but swaps the outside transport for in-memory queues. That matters for command-line or terminal features that want app-server power without starting another process.

The main idea is like replacing a mail truck with an office inbox. Messages still have the same forms and rules, but they move through local channels instead of across a process boundary. `start` creates the runtime, performs the required initialize/initialized handshake, and returns an `InProcessClientHandle`. Callers use that handle to send typed requests, send notifications, answer server questions, read server events, and request shutdown.

Inside, `start_uninitialized` builds the real machinery: authentication, analytics, configuration loading, the existing `MessageProcessor`, outbound routing, and several bounded queues. “Bounded” means the queues have a fixed size, so callers can get a `WouldBlock` error instead of letting memory grow forever. Some low-priority notifications may be dropped when the consumer falls behind, but important server requests are not silently lost; they are failed back to the processor so approval-style flows do not hang forever.

#### Function details

##### `server_notification_requires_delivery`  (lines 104–111)

```
fn server_notification_requires_delivery(notification: &ServerNotification) -> bool
```

**Purpose**: Decides whether a server notification is important enough that the in-process runtime should wait to deliver it instead of dropping it when the event queue is full. It protects terminal or state-changing messages, such as a turn completing, from being treated as disposable.

**Data flow**: It receives one server notification, checks which kind it is, and returns `true` for the few notification types that must be delivered. For all other notification types it returns `false`, meaning they may be skipped under pressure.

**Call relations**: When `start_uninitialized` is forwarding outgoing server messages to the embedded client, it asks this helper whether a notification needs guaranteed delivery. The answer decides whether the runtime waits for queue space or tries a non-blocking send that may fail if the client is behind.

*Call graph*: 1 external calls (matches!).


##### `InProcessClientSender::request`  (lines 204–216)

```
async fn request(&self, request: ClientRequest) -> IoResult<PendingClientRequestResponse>
```

**Purpose**: Sends a client request into the embedded app server and waits for the matching response. It is used when the caller expects either a successful JSON-RPC result or a JSON-RPC error.

**Data flow**: It takes a typed client request, creates a one-time reply channel, wraps both into an internal message, and tries to put that message on the runtime queue. Then it waits on the reply channel and returns the response, or an I/O-style error if the runtime disappears before answering.

**Call relations**: This is the lower-level sender used by `InProcessClientHandle::request`. It hands the request to `try_send_client_message`, and later receives the result that the runtime loop sends back after `MessageProcessor` produces a response.

*Call graph*: calls 1 internal fn (try_send_client_message); called by 1 (request); 2 external calls (new, channel).


##### `InProcessClientSender::notify`  (lines 218–220)

```
fn notify(&self, notification: ClientNotification) -> IoResult<()>
```

**Purpose**: Sends a client notification into the embedded app server without waiting for a response. Notifications are fire-and-forget messages, such as telling the server that initialization is complete.

**Data flow**: It receives a typed notification, wraps it as an internal runtime message, and tries to place it on the client-to-runtime queue. It returns success if queued, or an I/O-style error if the queue is full or closed.

**Call relations**: This is called by `InProcessClientHandle::notify`. It uses `try_send_client_message` so notification sending follows the same backpressure and closed-runtime rules as requests.

*Call graph*: calls 1 internal fn (try_send_client_message); called by 1 (notify).


##### `InProcessClientSender::respond_to_server_request`  (lines 222–227)

```
fn respond_to_server_request(&self, request_id: RequestId, result: Result) -> IoResult<()>
```

**Purpose**: Sends a successful answer to a request that originally came from the server. This is needed for flows where the app server asks the embedded client a question, such as an approval decision.

**Data flow**: It takes the server request ID and the result value, wraps them in an internal message, and tries to queue that message for the runtime. The function itself does not wait for the server to process the answer.

**Call relations**: This is called by `InProcessClientHandle::respond_to_server_request`. The runtime later forwards the answer to `OutgoingMessageSender`, which wakes the app-server side that is waiting for the client response.

*Call graph*: calls 1 internal fn (try_send_client_message); called by 1 (respond_to_server_request).


##### `InProcessClientSender::fail_server_request`  (lines 229–238)

```
fn fail_server_request(
        &self,
        request_id: RequestId,
        error: JSONRPCErrorError,
    ) -> IoResult<()>
```

**Purpose**: Sends an error answer to a request that came from the server. Callers use it when they cannot or will not satisfy the server's request, so the server does not wait forever.

**Data flow**: It takes the server request ID and an error object, wraps them as an internal message, and attempts to put that message on the runtime queue. It returns only whether the message could be queued.

**Call relations**: This is called by `InProcessClientHandle::fail_server_request`. The runtime later passes the error into `OutgoingMessageSender`, which reports the failure back to the app-server logic waiting on that request.

*Call graph*: calls 1 internal fn (try_send_client_message); called by 1 (fail_server_request).


##### `InProcessClientSender::try_send_client_message`  (lines 240–252)

```
fn try_send_client_message(&self, message: InProcessClientMessage) -> IoResult<()>
```

**Purpose**: Performs the actual non-blocking send into the in-process runtime queue. It converts low-level queue problems into ordinary I/O-style errors that callers can understand.

**Data flow**: It receives an internal client message and tries to enqueue it immediately. If the queue accepts it, the result is success; if the queue is full, the result is `WouldBlock`; if the runtime has closed, the result is `BrokenPipe`.

**Call relations**: All sending methods on `InProcessClientSender` go through this helper. That keeps request, notification, and server-response behavior consistent when the embedded runtime is busy or already shut down.

*Call graph*: called by 4 (fail_server_request, notify, request, respond_to_server_request); 2 external calls (try_send, new).


##### `InProcessClientHandle::request`  (lines 276–278)

```
async fn request(&self, request: ClientRequest) -> IoResult<PendingClientRequestResponse>
```

**Purpose**: Provides the public handle method for sending an app-server request and awaiting its response. This is the method most low-level in-process callers use when they want to ask the server to do something.

**Data flow**: It receives a typed client request from the caller and passes it to the inner `InProcessClientSender`. The returned value is either a transport error, or a JSON-RPC-level success or failure from the app server.

**Call relations**: This method delegates to `InProcessClientSender::request`. Other code, including thread-deletion flows noted in the call graph, calls this public handle method rather than talking to the sender directly.

*Call graph*: calls 1 internal fn (request); called by 1 (delete_thread).


##### `InProcessClientHandle::notify`  (lines 284–286)

```
fn notify(&self, notification: ClientNotification) -> IoResult<()>
```

**Purpose**: Provides the public handle method for sending a notification to the embedded app server. It is used for messages that do not have a reply.

**Data flow**: It takes a typed client notification and forwards it to the inner sender. The only output is whether the notification could be placed on the runtime queue.

**Call relations**: This is a thin public wrapper over `InProcessClientSender::notify`. `start` uses this path after a successful initialize request to send the required `initialized` notification.

*Call graph*: calls 1 internal fn (notify).


##### `InProcessClientHandle::respond_to_server_request`  (lines 293–295)

```
fn respond_to_server_request(&self, request_id: RequestId, result: Result) -> IoResult<()>
```

**Purpose**: Lets the embedded client answer a server request with a successful result. It keeps approval or question-and-answer flows moving after the caller receives a `ServerRequest` event.

**Data flow**: It takes a request ID and result, forwards them through the inner sender, and returns whether the answer was queued. The app-server state is changed later when the runtime processes that queued message.

**Call relations**: This method wraps `InProcessClientSender::respond_to_server_request`. It is meant to be used after `next_event` yields an `InProcessServerEvent::ServerRequest`.

*Call graph*: calls 1 internal fn (respond_to_server_request).


##### `InProcessClientHandle::fail_server_request`  (lines 301–307)

```
fn fail_server_request(
        &self,
        request_id: RequestId,
        error: JSONRPCErrorError,
    ) -> IoResult<()>
```

**Purpose**: Lets the embedded client reject or fail a server request. This is the safe alternative to ignoring a server request, which could leave the server waiting indefinitely.

**Data flow**: It takes a request ID and JSON-RPC error, forwards them to the inner sender, and returns whether the error response was queued. The runtime later sends the failure back to the app-server request waiter.

**Call relations**: This method wraps `InProcessClientSender::fail_server_request`. It belongs in the same event flow as `respond_to_server_request`, but is used when the client cannot provide a valid result.

*Call graph*: calls 1 internal fn (fail_server_request).


##### `InProcessClientHandle::next_event`  (lines 313–315)

```
async fn next_event(&mut self) -> Option<InProcessServerEvent>
```

**Purpose**: Waits for the next event sent by the embedded app server to the in-process client. Events can be server requests, notifications, or a lag warning that tells the caller it fell behind.

**Data flow**: It waits on the event receiver queue. If an event is available, it returns that event; if the runtime has exited and the queue is drained, it returns `None`.

**Call relations**: Callers use this method while the runtime is active to consume messages produced by the routing loop in `start_uninitialized`. Server request events received here can be answered with `respond_to_server_request` or `fail_server_request`.

*Call graph*: calls 1 internal fn (recv).


##### `InProcessClientHandle::shutdown`  (lines 321–340)

```
async fn shutdown(self) -> IoResult<()>
```

**Purpose**: Requests a clean stop of the embedded app-server runtime and waits for its background tasks to finish. It prevents the local runtime from leaking work after the caller is done.

**Data flow**: It sends a shutdown message with a one-time acknowledgement channel, waits for that acknowledgement for a limited time, then waits for the runtime task itself. If the runtime does not finish in time, it aborts the task and still returns success from the shutdown attempt.

**Call relations**: This is the public teardown path for handles created by `start` or `start_uninitialized`. The runtime loop receives the shutdown message, drains and cancels outstanding work, stops processor and routing tasks, and then acknowledges shutdown.

*Call graph*: 2 external calls (channel, timeout).


##### `InProcessClientHandle::sender`  (lines 342–344)

```
fn sender(&self) -> InProcessClientSender
```

**Purpose**: Returns a cloneable sender that can be moved into other tasks while the main handle keeps receiving events. This is useful when one part of a caller sends commands and another part reads server events.

**Data flow**: It reads the handle's inner sender and returns a clone of it. The clone points to the same runtime queue, so messages sent through either sender go to the same embedded server.

**Call relations**: This helper exposes `InProcessClientSender` without giving away the event receiver or runtime task handle. It supports multi-task caller designs built on top of the same in-process runtime.

*Call graph*: 1 external calls (clone).


##### `start`  (lines 352–372)

```
async fn start(args: InProcessStartArgs) -> IoResult<InProcessClientHandle>
```

**Purpose**: Starts the embedded app server and performs the required initialization handshake before returning control to the caller. Callers get a handle that is already ready to use.

**Data flow**: It takes all startup arguments, saves the initialize parameters, starts the lower-level runtime with `start_uninitialized`, sends an `Initialize` request, checks whether that succeeded, then sends the `Initialized` notification. If initialization fails, it shuts the runtime down and returns an invalid-data error.

**Call relations**: This is the normal entry into this file's functionality and is used by higher-level in-process clients and tests. It relies on `start_uninitialized` for the task setup, then uses the public request and notification path to make startup match the normal app-server protocol.

*Call graph*: calls 1 internal fn (start_uninitialized); called by 9 (start, start_test_client_with_capacity, get_conversation_summary_by_thread_id_reads_pathless_store_thread, mcp_resource_read_returns_error_for_unknown_thread, start_in_process_client, thread_list_includes_store_thread_without_rollout_path, thread_read_loaded_include_turns_reads_store_history_without_rollout_path, thread_turns_list_reads_store_history_without_rollout_path, thread_unarchive_preserves_pathless_store_metadata); 3 external calls (Integer, new, format!).


##### `start_uninitialized`  (lines 374–727)

```
async fn start_uninitialized(args: InProcessStartArgs) -> IoResult<InProcessClientHandle>
```

**Purpose**: Builds and launches the in-process app-server runtime but does not perform the initialize handshake itself. It sets up the queues, background tasks, message processor, outbound routing, and shutdown cleanup.

**Data flow**: It receives startup configuration, clamps the queue capacity to at least one, resolves the installation ID, creates client and event queues, and spawns the runtime task. Inside that task, client messages are forwarded into `MessageProcessor`, outgoing responses are matched back to waiting requests, server events are sent to the client, and shutdown cancels outstanding work and drains background tasks.

**Call relations**: `start` calls this first, then performs initialization on top of the returned handle. This function is the central wiring point: it connects the in-memory client queue, the existing `MessageProcessor`, the outgoing-envelope router, and the event stream seen by `next_event`.

*Call graph*: calls 9 internal fn (analytics_events_client_from_config, new, internal_error, new, new, new, new, route_outgoing_envelope, shared_from_config); called by 1 (start); 11 external calls (clone, new, new, new, new, new, new, resolve_installation_id, select!, spawn (+1 more)).


##### `tests::build_test_config`  (lines 747–761)

```
async fn build_test_config(codex_home: &Path) -> Config
```

**Purpose**: Builds a configuration object for tests using a temporary Codex home directory. It falls back to the default config-loading path if the builder path cannot produce a config.

**Data flow**: It receives a filesystem path, tries to build a `Config` using that path, and returns the resulting config. If the first build attempt fails, it loads the default config with no command-line overrides for the same directory.

**Call relations**: The test startup helper calls this before creating an in-process runtime. It keeps the tests focused on runtime behavior instead of repeating config setup in every test.

*Call graph*: 4 external calls (to_path_buf, new, load_default_with_cli_overrides_for_codex_home, default).


##### `tests::start_test_client_with_capacity`  (lines 763–800)

```
async fn start_test_client_with_capacity(
        session_source: SessionSource,
        channel_capacity: usize,
    ) -> InProcessClientHandle
```

**Purpose**: Creates a fully initialized in-process client for tests, with a caller-chosen queue capacity. It packages all the many startup dependencies into safe test defaults.

**Data flow**: It creates a temporary Codex home, builds config, initializes test state storage, fills an `InProcessStartArgs` struct, calls `start`, stores the temp directory on the handle so it lives long enough, and returns the ready client.

**Call relations**: Most tests in this module call this helper directly or through `tests::start_test_client`. It exercises the same public `start` path used outside tests, while supplying test-only environment and configuration pieces.

*Call graph*: calls 5 internal fn (start, default, default_for_tests, new, try_init); 6 external calls (new, new, new, build_test_config, default, default).


##### `tests::start_test_client`  (lines 802–804)

```
async fn start_test_client(session_source: SessionSource) -> InProcessClientHandle
```

**Purpose**: Starts a test in-process client using the default queue capacity. It is a convenience wrapper for tests that do not care about queue sizing.

**Data flow**: It receives the desired session source, passes it along with `DEFAULT_IN_PROCESS_CHANNEL_CAPACITY` to `tests::start_test_client_with_capacity`, and returns the initialized client.

**Call relations**: The request and session-source tests call this helper. It keeps those tests short while still using the fuller setup path underneath.

*Call graph*: 1 external calls (start_test_client_with_capacity).


##### `tests::in_process_start_initializes_and_handles_typed_v2_request`  (lines 807–825)

```
async fn in_process_start_initializes_and_handles_typed_v2_request()
```

**Purpose**: Checks that `start` returns a runtime that has already completed initialization and can answer a typed protocol request. It verifies the basic promise of this file: ready-to-use in-process app-server access.

**Data flow**: The test starts a client, sends a `ConfigRequirementsRead` request, confirms the transport succeeded and the app-server request succeeded, parses the returned JSON into the expected response type, and then shuts the client down.

**Call relations**: This test uses `tests::start_test_client`, then calls the same public request and shutdown methods a real embedded caller would use. It protects the startup handshake and request-response path from regressions.

*Call graph*: 4 external calls (Integer, start_test_client, assert!, from_value).


##### `tests::in_process_start_uses_requested_session_source_for_thread_start`  (lines 828–853)

```
async fn in_process_start_uses_requested_session_source_for_thread_start()
```

**Purpose**: Checks that the session source supplied at startup is preserved when a new thread is created. This matters because callers such as CLI and exec surfaces need their sessions labeled correctly.

**Data flow**: For each requested source, the test starts a client, sends a thread-start request, parses the response, and compares the created thread's source to the expected API value. It then shuts down that client before trying the next case.

**Call relations**: This test uses `tests::start_test_client` and the public request path. It confirms that startup data passed through `InProcessStartArgs` reaches the `MessageProcessor` and appears in app-server results.

*Call graph*: 5 external calls (Integer, default, start_test_client, assert_eq!, from_value).


##### `tests::in_process_start_clamps_zero_channel_capacity`  (lines 856–880)

```
async fn in_process_start_clamps_zero_channel_capacity()
```

**Purpose**: Checks that asking for a zero-sized runtime queue does not break startup. The runtime should clamp the capacity to at least one and still process requests.

**Data flow**: The test starts a client with capacity zero, repeatedly tries a config request until it is accepted if the queue is briefly full, verifies the response parses correctly, and then shuts down the client.

**Call relations**: This test calls `tests::start_test_client_with_capacity`, which reaches `start_uninitialized` where the capacity is clamped. It protects callers from accidental invalid queue configuration.

*Call graph*: 5 external calls (Integer, start_test_client_with_capacity, panic!, from_value, yield_now).


##### `tests::guaranteed_delivery_helpers_cover_terminal_server_notifications`  (lines 883–907)

```
fn guaranteed_delivery_helpers_cover_terminal_server_notifications()
```

**Purpose**: Checks that the helper for guaranteed notification delivery includes important terminal notifications. It makes sure completion-style messages are not accidentally treated as droppable.

**Data flow**: The test builds sample `TurnCompleted` and `ExternalAgentConfigImportCompleted` notifications, passes each to `server_notification_requires_delivery`, and asserts that the helper returns `true`.

**Call relations**: This directly tests `server_notification_requires_delivery`, which is used by the event-forwarding path in `start_uninitialized`. It guards the policy that important end-of-flow notifications should survive queue pressure.

*Call graph*: 1 external calls (assert!).


### Transport listeners and websocket policy
These files provide the concrete stdio, Unix-socket, and websocket listeners plus the authentication policy that guards websocket upgrades.

### `app-server-transport/src/transport/auth.rs`

`io_transport` · `startup and websocket request handling`

This file is the gatekeeper for websocket access. A websocket starts as an HTTP request that asks to be “upgraded” into a long-lived connection. Before allowing that upgrade, the server may need to check an Authorization header, much like a receptionist checking a badge before opening a secure door.

The file covers two authentication styles. In capability-token mode, the client sends a secret token, and the server compares its SHA-256 hash with the expected hash. SHA-256 is a one-way fingerprint: the server can check a match without storing the original token. The comparison is done in constant time, meaning it avoids timing clues that could help an attacker guess the token. In signed-bearer-token mode, the client sends a JWT, or JSON Web Token, signed with a shared secret. The server checks the signature, expiry time, optional “not before” time, issuer, and audience.

The file also parses command-line options into clean settings, reads secret files at startup, rejects unsafe or inconsistent configuration, and reports authentication failures as HTTP 401 Unauthorized errors. Without this file, a websocket listener exposed beyond the local machine could accidentally accept unauthenticated connections.

#### Function details

##### `WebsocketAuthError::status_code`  (lines 128–130)

```
fn status_code(&self) -> StatusCode
```

**Purpose**: Returns the HTTP status code attached to an authentication failure. Callers use it to decide what response code to send back to the client.

**Data flow**: It reads the stored status code inside the error object and gives that code back unchanged. It does not change anything.

**Call relations**: When websocket authorization fails, other code can call this accessor to turn the internal error into an HTTP response.


##### `WebsocketAuthError::message`  (lines 132–134)

```
fn message(&self) -> &'static str
```

**Purpose**: Returns the short error message attached to an authentication failure. This lets the response-building code explain why access was denied.

**Data flow**: It reads the stored message inside the error object and returns that static text. Nothing else is modified.

**Call relations**: It pairs with WebsocketAuthError::status_code so callers can produce both the HTTP code and the human-readable reason.


##### `AppServerWebsocketAuthArgs::try_into_settings`  (lines 138–219)

```
fn try_into_settings(self) -> anyhow::Result<AppServerWebsocketAuthSettings>
```

**Purpose**: Turns raw command-line websocket authentication flags into a validated settings object. It catches mismatched options early, before the server starts listening.

**Data flow**: It receives the parsed command-line fields, trims optional issuer and audience text, checks which authentication mode was requested, and rejects flags that do not belong to that mode. It converts path arguments into absolute paths and parses a hex SHA-256 token digest when needed, then returns either clean settings or a clear error.

**Call relations**: This is the first step in the authentication setup story. It uses absolute_path_arg and sha256_digest_arg for detailed validation, and it stops startup with an error when the user gives an impossible or unsafe combination of flags.

*Call graph*: calls 2 internal fn (absolute_path_arg, sha256_digest_arg); 1 external calls (bail!).


##### `policy_from_settings`  (lines 222–264)

```
fn policy_from_settings(
    settings: &AppServerWebsocketAuthSettings,
) -> io::Result<WebsocketAuthPolicy>
```

**Purpose**: Builds the runtime websocket authentication policy from already-validated settings. This is where startup settings become the actual rule used later on incoming websocket requests.

**Data flow**: It receives an AppServerWebsocketAuthSettings value. If capability-token mode uses a file, it reads and trims the token, hashes it, and stores only the hash; if the hash was supplied directly, it stores that. If signed-token mode is used, it reads the shared secret file, checks that the secret is long enough, converts the clock-skew setting into the right number type, and stores all of that in a WebsocketAuthPolicy. If no auth was configured, it returns a policy with no mode.

**Call relations**: The main server startup path calls this after command-line settings are prepared. Later, websocket request code uses the returned policy in authorize_upgrade, and listener setup can use it to warn or block unsafe unauthenticated non-local listeners.

*Call graph*: calls 3 internal fn (read_trimmed_secret, sha256_digest, validate_signed_bearer_secret); called by 2 (capability_token_hash_policy_authorizes_matching_bearer_token, run_main_with_transport_options); 1 external calls (try_from).


##### `is_unauthenticated_non_loopback_listener`  (lines 266–271)

```
fn is_unauthenticated_non_loopback_listener(
    bind_address: SocketAddr,
    policy: &WebsocketAuthPolicy,
) -> bool
```

**Purpose**: Checks whether the server is about to listen on a non-local network address without websocket authentication. This helps catch a dangerous setup before exposing access to other machines.

**Data flow**: It receives a socket address and an authentication policy. It checks whether the IP address is not loopback, meaning not just this same computer, and whether the policy has no authentication mode. It returns true only when both are true.

**Call relations**: The websocket acceptor setup calls this while deciding whether a listener is safe. It does not authenticate a request itself; it flags risky listener configuration.

*Call graph*: called by 1 (start_websocket_acceptor); 1 external calls (ip).


##### `authorize_upgrade`  (lines 273–304)

```
fn authorize_upgrade(
    headers: &HeaderMap,
    policy: &WebsocketAuthPolicy,
) -> Result<(), WebsocketAuthError>
```

**Purpose**: Decides whether a websocket upgrade request is allowed under the current authentication policy. This is the main request-time gate.

**Data flow**: It receives HTTP headers and the current policy. If no authentication is configured, it allows the request. Otherwise it extracts a bearer token from the Authorization header. For capability-token mode, it hashes the presented token and compares it with the stored hash. For signed-token mode, it verifies the JWT using the shared secret and claim rules. It returns success or a WebsocketAuthError.

**Call relations**: The websocket upgrade handler calls this before accepting a connection. It relies on bearer_token_from_headers to read the client’s credential, sha256_digest and constant-time comparison for simple tokens, and verify_signed_bearer_token for signed JWTs.

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

**Purpose**: Checks that a signed bearer token is genuine and acceptable for this server. A bearer token is a credential the client presents in an HTTP Authorization header.

**Data flow**: It receives the token string, shared secret bytes, optional expected issuer and audience, and allowed clock skew. It first decodes and verifies the JWT signature, then checks the decoded claims such as expiry and audience. It returns success if every check passes, otherwise an authentication error.

**Call relations**: authorize_upgrade calls this in signed-bearer-token mode. The tests also call it directly to confirm that valid tokens pass and tampered or incomplete tokens fail.

*Call graph*: calls 2 internal fn (decode_jwt_claims, validate_jwt_claims); called by 6 (authorize_upgrade, signed_bearer_token_verification_accepts_multiple_audiences, signed_bearer_token_verification_accepts_valid_token, signed_bearer_token_verification_rejects_alg_none_tokens, signed_bearer_token_verification_rejects_missing_exp, signed_bearer_token_verification_rejects_tampering).


##### `decode_jwt_claims`  (lines 317–327)

```
fn decode_jwt_claims(token: &str, shared_secret: &[u8]) -> Result<JwtClaims, WebsocketAuthError>
```

**Purpose**: Verifies the JWT signature and extracts the claims, which are the token’s stated facts such as expiry time and audience.

**Data flow**: It receives the token text and the shared secret. It configures JWT decoding to use HS256, a shared-secret signing method, and asks the JWT library to verify the signature while leaving claim checks to this file. It returns the decoded claims or an Unauthorized error if decoding or signature verification fails.

**Call relations**: verify_signed_bearer_token calls this first, before validate_jwt_claims checks the meaning of the decoded data.

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

**Purpose**: Checks whether decoded JWT claims are still valid for this server right now. It enforces expiry, optional start time, issuer, and audience rules.

**Data flow**: It receives decoded claims, optional expected issuer and audience, and a clock-skew allowance. It compares the current UTC time with the token’s expiry and not-before times, then compares issuer and audience when configured. It returns success if the token is acceptable, or an Unauthorized error with a specific reason if not.

**Call relations**: verify_signed_bearer_token calls this after decode_jwt_claims succeeds. It delegates audience comparison to audience_matches because JWTs can store one audience or a list of audiences.

*Call graph*: calls 2 internal fn (audience_matches, unauthorized); called by 1 (verify_signed_bearer_token); 1 external calls (now_utc).


##### `audience_matches`  (lines 358–366)

```
fn audience_matches(audience: Option<&JwtAudienceClaim>, expected_audience: &str) -> bool
```

**Purpose**: Checks whether a JWT audience claim contains the audience this server expects. The audience is like a “this token is meant for” label.

**Data flow**: It receives an optional audience claim and the expected audience string. If the token has a single audience, it compares that one value. If it has a list, it searches the list. If there is no audience claim, it returns false.

**Call relations**: validate_jwt_claims calls this only when the server was configured to require a specific audience.

*Call graph*: called by 1 (validate_jwt_claims).


##### `bearer_token_from_headers`  (lines 368–386)

```
fn bearer_token_from_headers(headers: &HeaderMap) -> Result<&str, WebsocketAuthError>
```

**Purpose**: Extracts the token from an HTTP Authorization header in the expected `Bearer <token>` format. It rejects missing, malformed, non-text, or empty credentials.

**Data flow**: It receives the request headers, looks for the Authorization header, converts it to text, splits it into an authentication scheme and token, checks that the scheme is Bearer, trims the token, and returns the token text. On any problem, it returns an Unauthorized error.

**Call relations**: authorize_upgrade calls this before it can check either kind of websocket authentication credential.

*Call graph*: calls 1 internal fn (unauthorized); called by 1 (authorize_upgrade); 1 external calls (get).


##### `validate_signed_bearer_secret`  (lines 388–399)

```
fn validate_signed_bearer_secret(path: &Path, shared_secret: &[u8]) -> io::Result<()>
```

**Purpose**: Makes sure the shared secret used to sign JWTs is not too short. A short secret would be easier to guess, so the server refuses it at startup.

**Data flow**: It receives the secret file path and the secret bytes read from that file. It checks that the secret is at least 32 bytes long. It returns success for a strong-enough secret, or an invalid-input error that names the file when it is too short.

**Call relations**: policy_from_settings calls this while building signed-bearer-token policy. A test also calls it directly to confirm short secrets are rejected.

*Call graph*: called by 2 (policy_from_settings, validate_signed_bearer_secret_rejects_short_secret); 2 external calls (new, format!).


##### `read_trimmed_secret`  (lines 401–419)

```
fn read_trimmed_secret(path: &std::path::Path) -> io::Result<String>
```

**Purpose**: Reads a secret value from a file and removes surrounding whitespace. This lets secret files end with a newline without making the newline part of the secret.

**Data flow**: It receives a file path, reads the file as text, trims whitespace from the beginning and end, and checks that something remains. It returns the trimmed secret string, or an I/O error with context if the file cannot be read or is empty.

**Call relations**: policy_from_settings calls this when a token or shared secret is supplied through a file.

*Call graph*: called by 1 (policy_from_settings); 3 external calls (new, format!, read_to_string).


##### `absolute_path_arg`  (lines 421–423)

```
fn absolute_path_arg(flag_name: &str, path: PathBuf) -> anyhow::Result<AbsolutePathBuf>
```

**Purpose**: Checks that a path supplied on the command line is absolute, meaning it starts from the filesystem root rather than depending on the current directory.

**Data flow**: It receives the flag name and a path. It tries to convert the path into an AbsolutePathBuf and, if that fails, returns an error that mentions which flag was wrong.

**Call relations**: AppServerWebsocketAuthArgs::try_into_settings calls this for token and shared-secret file arguments so later startup code has unambiguous file locations.

*Call graph*: calls 1 internal fn (try_from); called by 1 (try_into_settings).


##### `sha256_digest_arg`  (lines 425–438)

```
fn sha256_digest_arg(flag_name: &str, value: &str) -> anyhow::Result<[u8; 32]>
```

**Purpose**: Parses a command-line SHA-256 digest written as 64 hexadecimal characters. Hexadecimal is a compact text form for bytes using digits 0-9 and letters a-f.

**Data flow**: It receives the flag name and text value, trims the value, checks that it has exactly 64 characters, converts each pair of hex characters into one byte, and returns the resulting 32-byte digest. If the shape or characters are wrong, it returns a clear argument error.

**Call relations**: AppServerWebsocketAuthArgs::try_into_settings calls this when capability-token mode is configured with a precomputed token hash. It uses hex_nibble for the per-character conversion.

*Call graph*: calls 1 internal fn (hex_nibble); called by 1 (try_into_settings); 1 external calls (bail!).


##### `hex_nibble`  (lines 440–447)

```
fn hex_nibble(flag_name: &str, byte: u8) -> anyhow::Result<u8>
```

**Purpose**: Converts one hexadecimal character into its 4-bit numeric value. It is a small helper for reading SHA-256 digests from command-line text.

**Data flow**: It receives the flag name and one byte representing a character. If the character is 0-9, a-f, or A-F, it returns the corresponding number from 0 to 15. Otherwise it returns the same digest-format error used by the parser.

**Call relations**: sha256_digest_arg calls this twice for each byte of the final SHA-256 digest.

*Call graph*: called by 1 (sha256_digest_arg); 1 external calls (bail!).


##### `sha256_digest`  (lines 449–453)

```
fn sha256_digest(input: &[u8]) -> [u8; 32]
```

**Purpose**: Computes the SHA-256 fingerprint of some bytes and returns it as exactly 32 bytes. This is used to compare secrets without keeping or comparing the plain secret directly.

**Data flow**: It receives a byte slice, runs the SHA-256 hash function over it, copies the result into a fixed 32-byte array, and returns that array. It does not modify the input.

**Call relations**: policy_from_settings uses this to store a capability token as a hash, authorize_upgrade uses it to hash a presented token before comparison, and tests use it to create expected hashes.

*Call graph*: called by 3 (authorize_upgrade, policy_from_settings, capability_token_hash_policy_authorizes_matching_bearer_token); 1 external calls (digest).


##### `unauthorized`  (lines 455–460)

```
fn unauthorized(message: &'static str) -> WebsocketAuthError
```

**Purpose**: Creates a standard websocket authentication error with HTTP 401 Unauthorized. It keeps error creation consistent across the file.

**Data flow**: It receives a static message, combines it with the Unauthorized HTTP status code, and returns a WebsocketAuthError.

**Call relations**: authorize_upgrade, bearer_token_from_headers, and validate_jwt_claims call this whenever a request should be rejected for authentication reasons.

*Call graph*: called by 3 (authorize_upgrade, bearer_token_from_headers, validate_jwt_claims).


##### `tests::signed_token`  (lines 474–482)

```
fn signed_token(shared_secret: &[u8], claims: serde_json::Value) -> String
```

**Purpose**: Builds a test JWT signed with HS256 so the tests can exercise real signature verification. It is only used in the test module.

**Data flow**: It receives shared secret bytes and JSON claims. It base64-url encodes a JWT header and the claims, signs the header-and-claims text with HMAC-SHA256, base64-url encodes the signature, and returns the full token string.

**Call relations**: Several signed-bearer-token tests call this to create valid or intentionally modified tokens for verify_signed_bearer_token.

*Call graph*: 3 external calls (new_from_slice, format!, to_vec).


##### `tests::detects_unauthenticated_non_loopback_listener`  (lines 485–503)

```
fn detects_unauthenticated_non_loopback_listener()
```

**Purpose**: Checks that the server can spot an unauthenticated listener exposed beyond the local machine. This protects against accidentally opening an unsecured websocket port to the network.

**Data flow**: It creates a default no-auth policy, tests a public-style address and a loopback address, then tests a public-style address with authentication configured. The expected results confirm that only non-loopback plus no-auth is flagged.

**Call relations**: This test directly exercises is_unauthenticated_non_loopback_listener, the helper used during websocket listener setup.

*Call graph*: 2 external calls (default, assert!).


##### `tests::capability_token_args_require_token_file_or_hash`  (lines 506–518)

```
fn capability_token_args_require_token_file_or_hash()
```

**Purpose**: Confirms that capability-token mode cannot be enabled without telling the server what token or token hash to expect.

**Data flow**: It builds command-line args with capability-token mode but no token source, converts them to settings, and expects an error mentioning the missing token file or hash option.

**Call relations**: This test exercises AppServerWebsocketAuthArgs::try_into_settings and verifies one of its startup configuration guardrails.

*Call graph*: 2 external calls (default, assert!).


##### `tests::capability_token_args_accept_token_hash`  (lines 521–540)

```
fn capability_token_args_accept_token_hash()
```

**Purpose**: Confirms that a valid SHA-256 token hash supplied on the command line is accepted and decoded correctly.

**Data flow**: It builds args with capability-token mode and a 64-character hex digest, converts them to settings, and compares the result with the expected 32-byte hash value.

**Call relations**: This test covers the path from AppServerWebsocketAuthArgs::try_into_settings through sha256_digest_arg and hex_nibble.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::capability_token_args_reject_multiple_token_sources`  (lines 543–556)

```
fn capability_token_args_reject_multiple_token_sources()
```

**Purpose**: Confirms that the user cannot provide both a token file and a token hash for capability-token mode. Having two sources would be ambiguous.

**Data flow**: It builds args containing both token-source options, converts them to settings, and expects an error saying the options are mutually exclusive.

**Call relations**: This test exercises the configuration validation inside AppServerWebsocketAuthArgs::try_into_settings.

*Call graph*: 3 external calls (default, from, assert!).


##### `tests::capability_token_args_reject_malformed_token_hash`  (lines 559–571)

```
fn capability_token_args_reject_malformed_token_hash()
```

**Purpose**: Confirms that an invalid token hash string is rejected before startup continues.

**Data flow**: It builds args with capability-token mode and a non-SHA-256-looking string, tries to convert them to settings, and expects an error about the required 64-character hex form.

**Call relations**: This test checks AppServerWebsocketAuthArgs::try_into_settings through sha256_digest_arg.

*Call graph*: 2 external calls (default, assert!).


##### `tests::capability_token_hash_policy_authorizes_matching_bearer_token`  (lines 574–596)

```
fn capability_token_hash_policy_authorizes_matching_bearer_token()
```

**Purpose**: Confirms that capability-token authentication accepts the correct bearer token and rejects a wrong one.

**Data flow**: It creates settings containing the hash of a known token, builds a policy, sends headers with the matching token and expects success, then replaces the header with a wrong token and expects Unauthorized.

**Call relations**: This test follows the real flow from policy_from_settings to authorize_upgrade, with sha256_digest used to prepare the expected hash.

*Call graph*: calls 3 internal fn (authorize_upgrade, policy_from_settings, sha256_digest); 3 external calls (new, from_static, assert_eq!).


##### `tests::signed_bearer_args_require_mode_when_mode_specific_flags_are_set`  (lines 599–610)

```
fn signed_bearer_args_require_mode_when_mode_specific_flags_are_set()
```

**Purpose**: Confirms that signed-token-specific flags are not accepted unless the user explicitly chooses a websocket auth mode.

**Data flow**: It builds args with a shared secret file but no `--ws-auth` mode, converts them to settings, and expects an error telling the user to choose a mode.

**Call relations**: This test exercises AppServerWebsocketAuthArgs::try_into_settings and its rule that mode-specific options must not float on their own.

*Call graph*: 3 external calls (default, from, assert!).


##### `tests::signed_bearer_args_default_clock_skew_and_trim_optional_claims`  (lines 613–636)

```
fn signed_bearer_args_default_clock_skew_and_trim_optional_claims()
```

**Purpose**: Confirms that signed-bearer-token settings get sensible cleanup: default clock skew, trimmed issuer text, and empty audience treated as absent.

**Data flow**: It builds signed-token args with a secret file, an issuer surrounded by spaces, and a blank audience. After conversion, it compares the settings with the expected absolute path, trimmed issuer, no audience, and default clock-skew value.

**Call relations**: This test focuses on AppServerWebsocketAuthArgs::try_into_settings and its normalization of signed-bearer-token options.

*Call graph*: 3 external calls (default, from, assert_eq!).


##### `tests::signed_bearer_token_verification_rejects_tampering`  (lines 639–657)

```
fn signed_bearer_token_verification_rejects_tampering()
```

**Purpose**: Confirms that changing a signed JWT after it was created makes verification fail. This proves the signature check is actually protecting the token contents.

**Data flow**: It creates a valid signed token, alters part of the token text, then calls verify_signed_bearer_token and expects an Unauthorized error.

**Call relations**: This test uses tests::signed_token to create the starting token and then checks verify_signed_bearer_token directly.

*Call graph*: calls 1 internal fn (verify_signed_bearer_token); 3 external calls (signed_token, assert_eq!, json!).


##### `tests::signed_bearer_token_verification_accepts_valid_token`  (lines 660–678)

```
fn signed_bearer_token_verification_accepts_valid_token()
```

**Purpose**: Confirms that a properly signed, unexpired JWT with the expected issuer and audience is accepted.

**Data flow**: It creates a token with a future expiry, issuer, and audience, then verifies it with matching expected values. The expected result is success.

**Call relations**: This test uses tests::signed_token and calls verify_signed_bearer_token, covering both signature decoding and claim validation.

*Call graph*: calls 1 internal fn (verify_signed_bearer_token); 2 external calls (signed_token, json!).


##### `tests::signed_bearer_token_verification_accepts_multiple_audiences`  (lines 681–698)

```
fn signed_bearer_token_verification_accepts_multiple_audiences()
```

**Purpose**: Confirms that a JWT audience list is accepted when one entry matches the expected audience.

**Data flow**: It creates a signed token whose audience claim is an array containing both an unrelated value and the expected value, then verifies it. The expected result is success.

**Call relations**: This test checks verify_signed_bearer_token and, through it, the audience_matches helper for list-style audience claims.

*Call graph*: calls 1 internal fn (verify_signed_bearer_token); 2 external calls (signed_token, json!).


##### `tests::signed_bearer_token_verification_rejects_alg_none_tokens`  (lines 701–719)

```
fn signed_bearer_token_verification_rejects_alg_none_tokens()
```

**Purpose**: Confirms that unsigned JWTs claiming `alg: none` are rejected. This protects against a classic JWT mistake where a server accepts tokens with no real signature.

**Data flow**: It manually builds a token with an `alg` value of `none` and no signature, then asks verify_signed_bearer_token to check it. The expected result is an Unauthorized error.

**Call relations**: This test targets the decode_jwt_claims part of verify_signed_bearer_token, ensuring the decoder only accepts the configured HS256 signed-token method.

*Call graph*: calls 1 internal fn (verify_signed_bearer_token); 4 external calls (assert_eq!, format!, json!, to_vec).


##### `tests::signed_bearer_token_verification_rejects_missing_exp`  (lines 722–739)

```
fn signed_bearer_token_verification_rejects_missing_exp()
```

**Purpose**: Confirms that a JWT without an expiry claim is rejected. Tokens need an expiry so stolen credentials do not remain useful forever.

**Data flow**: It creates a signed token that has an issuer but no `exp` expiry field, then verifies it and expects an Unauthorized error.

**Call relations**: This test calls verify_signed_bearer_token with a token built by tests::signed_token, checking that decoding into required claims fails when expiry is absent.

*Call graph*: calls 1 internal fn (verify_signed_bearer_token); 3 external calls (signed_token, assert_eq!, json!).


##### `tests::validate_signed_bearer_secret_rejects_short_secret`  (lines 742–750)

```
fn validate_signed_bearer_secret_rejects_short_secret()
```

**Purpose**: Confirms that too-short shared secrets are refused. This keeps signed-token security from depending on weak, easy-to-guess secrets.

**Data flow**: It calls validate_signed_bearer_secret with a short byte string and expects an invalid-input error whose message says the secret must be at least 32 bytes.

**Call relations**: This test directly exercises validate_signed_bearer_secret, the startup check used by policy_from_settings.

*Call graph*: calls 1 internal fn (validate_signed_bearer_secret); 3 external calls (new, assert!, assert_eq!).


### `app-server-transport/src/transport/stdio.rs`

`io_transport` · `startup and ongoing message handling`

This file turns the process’s normal input and output streams into a usable transport connection. In everyday terms, stdin is the mailbox where outside messages arrive, and stdout is the chute where this server sends messages back. Without this file, the server could not be controlled by a parent program using the common “one JSON message per line” style of communication.

The main function opens a new connection, gives the rest of the server a sender it can use to write replies, and then starts two background tasks. One task reads stdin line by line. Each line is expected to be a JSON-RPC message, which is a standard way for tools to send requests and responses as JSON. The reader forwards each incoming line into the server’s transport event system. It also watches for the first “initialize” request so it can extract the client program’s name and send that name to whoever is waiting for it.

The second background task waits for outgoing messages from the server. For each one, it turns the message into JSON text, adds a newline, writes it to stdout, and optionally signals that the write finished. If stdin ends, reading fails, or the output channel closes, the tasks stop and the connection is reported as closed.

#### Function details

##### `start_stdio_connection`  (lines 24–101)

```
async fn start_stdio_connection(
    transport_event_tx: mpsc::Sender<TransportEvent>,
    stdio_handles: &mut Vec<JoinHandle<()>>,
    initialize_client_name_tx: oneshot::Sender<String>,
) -> IoResul
```

**Purpose**: Starts a stdin/stdout-based connection for the app server. It announces the new connection to the rest of the system, then launches one background reader for incoming lines and one background writer for outgoing messages.

**Data flow**: It receives a channel for sending transport events, a list where it can store background task handles, and a one-time sender for reporting the initializing client’s name. It creates a new connection id and an internal outgoing-message channel, sends a “connection opened” event, then starts reading stdin and writing stdout in separate tasks. Incoming text lines become transport events for the server; outgoing queued messages become newline-ended JSON on stdout. It returns success if setup worked, or an input/output error if the transport event receiver is unavailable.

**Call relations**: This is the entry point for stdio transport setup. While reading each stdin line, it calls stdio_initialize_client_name to see whether the line is the initial handshake and, if so, extracts the client name. It also hands incoming lines to the shared transport helper that forwards messages into the server, and hands outgoing messages to the shared serializer before writing them to stdout.

*Call graph*: calls 1 internal fn (stdio_initialize_client_name); 13 external calls (new, clone, send, take, debug!, error!, info!, stdin, stdout, forward_incoming_message (+3 more)).


##### `stdio_initialize_client_name`  (lines 103–113)

```
fn stdio_initialize_client_name(line: &str) -> Option<String>
```

**Purpose**: Looks at one incoming line and tries to pull out the client program’s name from an “initialize” request. This lets the server learn who is connecting during the startup handshake.

**Data flow**: It takes a single text line, tries to parse it as a JSON-RPC message, checks that it is a request whose method is exactly “initialize”, then parses its parameters as initialization data. If all of that succeeds, it returns the client name. If the line is not valid JSON, is not a request, is for another method, or lacks usable parameters, it returns nothing.

**Call relations**: This helper is used by start_stdio_connection inside the stdin reading loop. The reader calls it for each incoming line until it successfully sends the client name through the one-time notification channel; after that, the name sender is no longer used, but normal message forwarding continues.

*Call graph*: called by 1 (start_stdio_connection).


### `app-server-transport/src/transport/unix_socket.rs`

`io_transport` · `startup, request handling, shutdown`

This file is the front door for local, same-machine control connections to the app server. A Unix-domain socket is like a network port, but it lives as a file path on the local computer instead of an internet address. That makes it useful for private communication between local processes. Before listening, the file makes sure the socket directory is private, checks whether another server is already using the socket, removes stale leftover socket files from previous runs, and then binds a new listener. Once listening, it accepts incoming local connections until a shutdown signal arrives. Each accepted connection is upgraded to a WebSocket connection, which is a message-based protocol, and then handed to the shared WebSocket transport code so the rest of the system can treat local socket clients like other transport clients. The file also includes a startup lock helper. That lock uses a file as a “one-at-a-time” marker so two app server instances do not race each other during startup. Finally, a small guard object removes the socket file when the acceptor task ends, like taking down a sign when a shop closes.

#### Function details

##### `start_control_socket_acceptor`  (lines 24–44)

```
async fn start_control_socket_acceptor(
    socket_path: AbsolutePathBuf,
    transport_event_tx: mpsc::Sender<TransportEvent>,
    shutdown_token: CancellationToken,
) -> IoResult<JoinHandle<()>>
```

**Purpose**: Starts the local control socket listener. It prepares the socket path, opens the Unix socket, makes its permissions private, and launches the background task that accepts clients.

**Data flow**: It receives an absolute socket path, a channel for sending transport events, and a shutdown token. It first checks and prepares the path, binds a listener to that path, wraps the path in a cleanup guard, sets file permissions, logs that the socket is ready, and returns a task handle for the newly spawned accept loop. If preparation or binding fails, it returns an I/O error instead.

**Call relations**: This is the setup doorway for the file. It calls prepare_control_socket_path before binding, calls set_control_socket_permissions after the socket file exists, and then starts run_control_socket_acceptor in a Tokio task so accepting connections can continue in the background.

*Call graph*: calls 5 internal fn (prepare_control_socket_path, run_control_socket_acceptor, set_control_socket_permissions, bind, as_path); 2 external calls (info!, spawn).


##### `run_control_socket_acceptor`  (lines 46–91)

```
async fn run_control_socket_acceptor(
    mut listener: UnixListener,
    transport_event_tx: mpsc::Sender<TransportEvent>,
    shutdown_token: CancellationToken,
    socket_guard: ControlSocketFileGu
```

**Purpose**: Runs the ongoing accept loop for the control socket. It waits for local clients, upgrades each connection to WebSocket, and passes it into the shared WebSocket connection runner.

**Data flow**: It receives a Unix socket listener, a sender for transport events, a shutdown token, and a socket-file cleanup guard. While the shutdown token is not cancelled, it waits for new socket connections. Recoverable accept errors are logged and retried; other accept errors are logged and followed by a short pause before retrying. For each successful connection, it spawns a new task, performs the WebSocket upgrade, splits the connection into reading and writing halves, and hands those halves plus the event sender to run_websocket_connection. When shutdown is requested, the loop exits and the cleanup guard later removes the socket file.

**Call relations**: start_control_socket_acceptor creates this task after the socket is ready. This function is the bridge between low-level Unix socket accepting and the higher-level WebSocket transport: once a client connects, it hands the connection off to run_websocket_connection.

*Call graph*: calls 1 internal fn (run_websocket_connection); called by 1 (start_control_socket_acceptor); 6 external calls (clone, info!, select!, spawn, accept_async, warn!).


##### `prepare_control_socket_path`  (lines 93–132)

```
async fn prepare_control_socket_path(socket_path: &Path) -> IoResult<()>
```

**Purpose**: Makes sure the socket path is safe and usable before the server tries to listen on it. It prevents accidentally starting a second server on the same socket and clears away stale socket files left by old runs.

**Data flow**: It receives a filesystem path. If the path has a parent directory, it prepares that directory as a private socket directory. Then it tries to connect to the path. If a connection succeeds, another server is already listening, so it returns an “address in use” error. If the path does not exist, it succeeds. If the path refuses connections, it checks whether the file is a stale socket; if so, it removes it. If the path exists but is not a stale socket, it returns an error rather than deleting something unexpected.

**Call relations**: start_control_socket_acceptor calls this before binding the listener. It relies on helper functions from codex_uds to prepare private directories and recognize stale socket files, so the later bind step starts from a clean and safe filesystem state.

*Call graph*: calls 1 internal fn (connect); called by 1 (start_control_socket_acceptor); 8 external calls (exists, parent, try_exists, new, is_stale_socket_path, prepare_private_socket_directory, format!, remove_file).


##### `acquire_app_server_startup_lock`  (lines 138–156)

```
async fn acquire_app_server_startup_lock(
    startup_lock_path: AbsolutePathBuf,
) -> IoResult<AppServerStartupLock>
```

**Purpose**: Takes a startup lock so only one app server startup path can proceed at a time. This avoids two processes both thinking they are responsible for creating or owning the control socket.

**Data flow**: It receives an absolute path for a lock file. It prepares the parent directory if needed, then runs blocking file-lock work on a separate blocking thread so it does not stall the async runtime. That work opens or creates the lock file, locks it, and returns an AppServerStartupLock that keeps the file open. Holding that returned object keeps the lock alive; dropping it releases the lock.

**Call relations**: This helper is not called by the other functions in this file according to the provided graph, but it supports the same startup story. It complements the socket preparation code by reducing races before the socket acceptor is started.

*Call graph*: calls 1 internal fn (as_path); 2 external calls (prepare_private_socket_directory, spawn_blocking).


##### `set_control_socket_permissions`  (lines 170–172)

```
async fn set_control_socket_permissions(_socket_path: &Path) -> IoResult<()>
```

**Purpose**: Restricts who can access the control socket file. On Unix systems it sets the socket file to owner-only access, which helps keep local control traffic private.

**Data flow**: It receives the socket path. On Unix, it converts the private mode value into filesystem permissions and applies them to the socket file. On non-Unix platforms, the matching version does nothing and succeeds, because Unix permission bits do not apply there in the same way.

**Call relations**: start_control_socket_acceptor calls this right after binding the listener, once the socket file exists. It is a security step between creating the socket and announcing that the app-server control socket is listening.

*Call graph*: called by 1 (start_control_socket_acceptor); 2 external calls (from_mode, set_permissions).


##### `ControlSocketFileGuard::drop`  (lines 179–189)

```
fn drop(&mut self)
```

**Purpose**: Cleans up the socket file when the guard is dropped. This helps prevent stale socket files from being left behind after the acceptor stops.

**Data flow**: It reads the stored socket path from the guard and tries to remove that file from disk. If the file is already gone, it ignores that. If removal fails for another reason, it logs a warning with the socket path and the error.

**Call relations**: start_control_socket_acceptor creates the guard and passes it into run_control_socket_acceptor. That acceptor keeps the guard alive for as long as it is listening; when the acceptor exits during shutdown or task cleanup, this drop method runs and removes the socket file.

*Call graph*: calls 1 internal fn (as_path); 2 external calls (remove_file, warn!).


### `app-server-transport/src/transport/websocket.rs`

`io_transport` · `startup, connection handling, shutdown`

This file is the bridge between WebSocket clients and the app server’s internal message system. A WebSocket is a network connection that stays open so both sides can send messages whenever they need to, like a phone call rather than sending separate letters. Without this file, browser-like or WebSocket-based clients could not connect to the app server, pass messages in, or receive responses back.

At startup, the file binds a TCP listener to an address, prints a small “where am I listening?” banner, and builds an Axum web router. Axum is the Rust web framework used here. The router exposes simple health endpoints and sends all other requests toward WebSocket upgrade logic. Before accepting clients, it rejects unsafe setups: a non-localhost listener must have authentication, and requests with an Origin header are refused to reduce browser-based cross-site risks.

Once a client is accepted, the connection is split into two cooperating tasks. The inbound task reads messages from the client, answers WebSocket ping frames with pong frames, drops unsupported binary messages, and forwards valid text messages into the app’s transport event channel. The outbound task waits for queued server messages, serializes them as JSON text, and writes them to the WebSocket. If either side stops, errors, or is cancelled, the other side is stopped too, and the rest of the app is told that the connection closed.

#### Function details

##### `colorize`  (lines 51–54)

```
fn colorize(text: &str, style: Style) -> String
```

**Purpose**: Adds terminal color and style to a short piece of text when the user’s terminal supports it. This is only for making the startup banner easier to read.

**Data flow**: It receives plain text and a style, such as bold or green. It asks the color library to apply that style only when stderr supports color, then returns the final string to print.

**Call relations**: The startup banner uses this helper each time it wants a label or URL to look distinct. It does not take part in networking; it only prepares display text for print_websocket_startup_banner.

*Call graph*: called by 1 (print_websocket_startup_banner).


##### `print_websocket_startup_banner`  (lines 57–77)

```
fn print_websocket_startup_banner(addr: SocketAddr)
```

**Purpose**: Prints a human-friendly startup message showing where the WebSocket server is listening and where its health checks live. It also gives a safety note about localhost versus non-localhost access.

**Data flow**: It receives the bound socket address. It formats WebSocket and HTTP URLs from that address, colorizes the pieces, and writes several lines to stderr. Nothing is returned.

**Call relations**: start_websocket_acceptor calls this after the operating system has successfully assigned a listening address. It relies on colorize to make the banner readable, then hands no data onward.

*Call graph*: calls 1 internal fn (colorize); called by 1 (start_websocket_acceptor); 4 external calls (ip, new, eprintln!, format!).


##### `health_check_handler`  (lines 85–87)

```
async fn health_check_handler() -> StatusCode
```

**Purpose**: Replies to health-check requests with a simple “OK” HTTP status. This lets other tools ask whether the listener process is alive.

**Data flow**: It takes no meaningful input from the request body. It returns HTTP 200 OK, with no extra calculation or state change.

**Call relations**: start_websocket_acceptor wires this into the /readyz and /healthz routes. Monitoring or startup-check clients call those routes to confirm that the listener is reachable.


##### `reject_requests_with_origin_header`  (lines 89–103)

```
async fn reject_requests_with_origin_header(
    request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode>
```

**Purpose**: Blocks requests that include an Origin header. This is a safety guard against browser-style cross-site requests being silently upgraded into trusted WebSocket connections.

**Data flow**: It receives an HTTP request and the next router step. If the request headers include Origin, it logs a warning and returns HTTP 403 Forbidden. If not, it passes the request to the next step and returns that response.

**Call relations**: start_websocket_acceptor installs this as middleware, meaning it runs before the health routes or WebSocket upgrade route. When it allows a request through, Axum continues to whichever handler matches next.

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

**Purpose**: Decides whether an incoming HTTP request may become a WebSocket connection, then starts the per-connection WebSocket work if it is allowed.

**Data flow**: It receives the pending WebSocket upgrade, the client’s socket address, shared listener state, and request headers. It checks the headers against the configured authentication policy. On failure, it returns an error HTTP response; on success, it accepts the upgrade and starts a connection task using the WebSocket stream.

**Call relations**: The router created by start_websocket_acceptor sends fallback requests here. It calls the authentication helper before accepting the client. After upgrade, it splits the WebSocket into read and write halves and hands them to run_websocket_connection.

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

**Purpose**: Starts the WebSocket server listener and returns the background task that keeps it running. This is the main setup point for WebSocket transport.

**Data flow**: It receives a bind address, a channel for sending transport events into the rest of the app, a shutdown token, and an authentication policy. It refuses unsafe unauthenticated public listeners, binds the TCP socket, prints the banner, builds the router, and spawns the Axum server. It returns either an I/O error or a handle to the spawned server task.

**Call relations**: Higher-level startup code calls this when WebSocket transport should be enabled. It wires together health_check_handler, reject_requests_with_origin_header, websocket_upgrade_handler, and the shared listener state. The spawned server watches the shutdown token so it can stop gracefully.

*Call graph*: calls 2 internal fn (is_unauthenticated_non_loopback_listener, print_websocket_startup_banner); 13 external calls (new, cancelled, new, bind, any, get, serve, new, error!, format! (+3 more)).


##### `run_websocket_connection`  (lines 172–229)

```
async fn run_websocket_connection(
    websocket_writer: impl futures::sink::Sink<M, Error = SinkError> + Send + 'static,
    websocket_reader: impl futures::stream::Stream<Item = Result<M, StreamErro
```

**Purpose**: Runs one accepted WebSocket client connection until either reading or writing ends. It announces connection open and close events to the rest of the app.

**Data flow**: It receives a WebSocket writer, a WebSocket reader, and the app’s transport event channel. It creates a new connection ID, creates channels for outgoing messages and control replies, sends a ConnectionOpened event, then starts separate inbound and outbound loops. When either loop ends, it cancels the other and sends a ConnectionClosed event.

**Call relations**: websocket_upgrade_handler uses this after a successful WebSocket upgrade, and the provided call graph also shows it being reused by run_control_socket_acceptor. It starts run_websocket_outbound_loop for server-to-client traffic and run_websocket_inbound_loop for client-to-server traffic, tying both to the same cancellation token.

*Call graph*: calls 2 internal fn (run_websocket_inbound_loop, run_websocket_outbound_loop); called by 1 (run_control_socket_acceptor); 6 external calls (new, clone, send, next_connection_id, select!, spawn).


##### `AxumWebSocketMessage::text`  (lines 249–251)

```
fn text(text: String) -> Self
```

**Purpose**: Builds an Axum WebSocket text message from a string. The outbound loop uses this shape when it needs to send JSON text through an Axum WebSocket.

**Data flow**: It receives a string. It wraps that string in Axum’s WebSocket text-message type and returns it.

**Call relations**: run_websocket_outbound_loop calls this through the AppServerWebSocketMessage trait when the concrete WebSocket type is Axum’s message type. This keeps the outbound loop generic instead of tied to one WebSocket library.

*Call graph*: 1 external calls (Text).


##### `AxumWebSocketMessage::pong`  (lines 253–255)

```
fn pong(payload: Bytes) -> Self
```

**Purpose**: Builds an Axum WebSocket pong reply. A pong is the standard answer to a ping, showing the connection is still alive.

**Data flow**: It receives the ping payload bytes. It wraps those bytes in Axum’s pong-message type and returns it.

**Call relations**: run_websocket_inbound_loop asks for this through the AppServerWebSocketMessage trait when it receives a ping. The returned message is sent through the control queue to the outbound loop.

*Call graph*: 1 external calls (Pong).


##### `AxumWebSocketMessage::into_incoming`  (lines 257–265)

```
fn into_incoming(self) -> Option<IncomingWebSocketMessage>
```

**Purpose**: Converts Axum’s detailed WebSocket message type into the smaller set of message kinds this transport cares about. This lets the rest of the file work with one simple internal WebSocket vocabulary.

**Data flow**: It receives one Axum WebSocket message. It classifies it as text, binary, ping, pong, or close, preserving text content and ping bytes where needed. It returns that simpler classification.

**Call relations**: run_websocket_inbound_loop uses this through the AppServerWebSocketMessage trait before deciding what to do with a received frame. Text is forwarded inward, ping gets a pong reply, close stops the connection, and binary is ignored with a warning.

*Call graph*: 2 external calls (Ping, Text).


##### `TungsteniteWebSocketMessage::text`  (lines 269–271)

```
fn text(text: String) -> Self
```

**Purpose**: Builds a Tungstenite WebSocket text message from a string. Tungstenite is another Rust WebSocket library used by this transport path.

**Data flow**: It receives a string. It wraps that string in Tungstenite’s text-message type and returns it.

**Call relations**: run_websocket_outbound_loop can call this through the AppServerWebSocketMessage trait when the connection uses Tungstenite messages. This is part of the adapter layer that lets the same loop work with more than one WebSocket implementation.

*Call graph*: 1 external calls (Text).


##### `TungsteniteWebSocketMessage::pong`  (lines 273–275)

```
fn pong(payload: Bytes) -> Self
```

**Purpose**: Builds a Tungstenite WebSocket pong reply for a received ping. This keeps the connection compliant with normal WebSocket keepalive behavior.

**Data flow**: It receives the ping payload bytes. It wraps those bytes in Tungstenite’s pong-message type and returns it.

**Call relations**: run_websocket_inbound_loop requests this through the AppServerWebSocketMessage trait after seeing a ping. The pong is then passed to the outbound loop through the control channel.

*Call graph*: 1 external calls (Pong).


##### `TungsteniteWebSocketMessage::into_incoming`  (lines 277–286)

```
fn into_incoming(self) -> Option<IncomingWebSocketMessage>
```

**Purpose**: Converts Tungstenite’s WebSocket message type into the simple internal message categories used by this transport. It ignores raw protocol frame objects because the transport does not need to process them directly.

**Data flow**: It receives one Tungstenite WebSocket message. It turns normal text, binary, ping, pong, and close messages into the shared IncomingWebSocketMessage form. If the message is a low-level frame, it returns nothing.

**Call relations**: run_websocket_inbound_loop uses this through the AppServerWebSocketMessage trait. This lets the inbound loop make the same decisions for Tungstenite connections as it does for Axum connections.

*Call graph*: 2 external calls (Ping, Text).


##### `run_websocket_outbound_loop`  (lines 289–328)

```
async fn run_websocket_outbound_loop(
    websocket_writer: impl futures::sink::Sink<M, Error = SinkError> + Send + 'static,
    mut writer_rx: mpsc::Receiver<QueuedOutgoingMessage>,
    mut writer_co
```

**Purpose**: Continuously writes messages from the app out to the WebSocket client. It is the server-to-client half of a live WebSocket connection.

**Data flow**: It receives a WebSocket writer, a channel of queued outgoing app messages, a channel of immediate control messages such as pongs, and a disconnect token. It waits for whichever event comes first: shutdown, a control message, or an app message. App messages are serialized to JSON text before sending. If sending fails or a channel closes, the loop exits.

**Call relations**: run_websocket_connection starts this as a background task for each client. It receives normal outbound messages from the connection’s writer channel and control replies from run_websocket_inbound_loop. When it finishes, run_websocket_connection cancels the inbound loop and closes the connection.

*Call graph*: called by 1 (run_websocket_connection); 2 external calls (pin!, select!).


##### `run_websocket_inbound_loop`  (lines 330–388)

```
async fn run_websocket_inbound_loop(
    websocket_reader: impl futures::stream::Stream<Item = Result<M, StreamError>> + Send + 'static,
    transport_event_tx: mpsc::Sender<TransportEvent>,
    write
```

**Purpose**: Continuously reads messages arriving from the WebSocket client. It is the client-to-server half of a live WebSocket connection.

**Data flow**: It receives a WebSocket reader, the app’s transport event channel, a writer channel tied to this client, a control-message channel, the connection ID, and a disconnect token. For text messages, it forwards the content into the app’s transport system. For pings, it queues a pong reply. For close, read errors, full control queues, or shutdown, it exits. Unsupported binary messages are logged and dropped.

**Call relations**: run_websocket_connection starts this beside run_websocket_outbound_loop. It calls the shared forwarding path for valid text messages and uses the outbound loop’s control channel for pong replies. When it finishes, run_websocket_connection cancels the outbound loop and reports the connection closed.

*Call graph*: called by 1 (run_websocket_connection); 2 external calls (pin!, select!).


### Remote-control transport subsystem
These files implement remote-control desired state, enrollment persistence and HTTP pairing, multiplexed client tracking, and the reconnecting websocket loop.

### `app-server-transport/src/transport/remote_control/mod.rs`

`orchestration` · `startup, background connection loop, and remote-control request handling`

Remote control lets another approved client connect to this app server through a remote service. This file makes that safe and orderly. Without it, the server would not have one clear place to decide whether remote control is allowed, how to enroll with the remote service, how to pair new clients, or how to report connection status.

The main object is `RemoteControlHandle`. Other parts of the app use it like a dashboard: turn remote control on or off, ask for the current status, start pairing, check pairing progress, list paired clients, or revoke a client. Behind the scenes, the file uses shared “watch” channels, which are like noticeboards that always hold the latest value, to publish the desired state and the current connection status.

A separate background websocket task does the long-running connection work. `start_remote_control` sets up that task and returns both the task handle and the `RemoteControlHandle` used by the rest of the server. The file also protects enrollment data with locks so pairing and websocket connection setup do not accidentally choose or overwrite different server registrations at the same time. It carefully handles disabled-by-policy cases, missing local state storage, expired server tokens, and account changes, because those are the moments where remote access could otherwise become confusing or unsafe.

#### Function details

##### `take_remote_control_disabled_env`  (lines 89–95)

```
fn take_remote_control_disabled_env() -> bool
```

**Purpose**: Checks whether an internal environment variable says remote control should start disabled, then removes that marker. This is used at process startup so the setting is consumed once before worker threads begin.

**Data flow**: It reads the process environment for `CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED`. If the value is exactly `1`, it returns `true`; otherwise it returns `false`. In either case, it removes the environment variable afterward.

**Call relations**: This is an early startup helper. It relies only on standard environment-variable calls and does not hand work to the rest of the remote-control machinery directly.

*Call graph*: 2 external calls (remove_var, var_os).


##### `RemoteControlEnrollmentState::new`  (lines 136–141)

```
fn new(enrollment: Option<RemoteControlEnrollment>) -> Self
```

**Purpose**: Creates the shared container that remembers the current remote-control server enrollment. It also creates a one-at-a-time lock so pairing and websocket setup cannot edit that enrollment at the same time.

**Data flow**: It takes an optional existing enrollment. It stores that enrollment in a protected slot and creates a semaphore, which is a small gate that allows only one holder through.

**Call relations**: Startup uses this when building the remote-control system. Tests and helper setup code also use it to create controlled enrollment state.

*Call graph*: called by 5 (start_remote_control, client_management_handle, plain_start_resolves_persisted_remote_control_preference, remote_control_handle_with_current_enrollment, test_current_enrollment); 2 external calls (new, new).


##### `RemoteControlEnrollmentState::lock`  (lines 143–153)

```
async fn lock(&self) -> RemoteControlEnrollmentLease<'_>
```

**Purpose**: Takes exclusive access to the current enrollment and returns a temporary lease for editing it. The lease is like checking out a document from a cabinet: while you hold it, no one else edits the original.

**Data flow**: It waits for the semaphore permit, copies the current enrollment snapshot, and returns a `RemoteControlEnrollmentLease` containing that copy. When the lease is later dropped, its final value is written back.

**Call relations**: Pairing flows call this before loading, refreshing, or replacing enrollment information. It calls `snapshot` to get the starting value.

*Call graph*: calls 1 internal fn (snapshot); 2 external calls (acquire, unreachable!).


##### `RemoteControlEnrollmentState::snapshot`  (lines 155–160)

```
fn snapshot(&self) -> Option<RemoteControlEnrollment>
```

**Purpose**: Makes a safe copy of the current enrollment without taking the longer async lease. This gives callers a quick read of what server enrollment is currently selected.

**Data flow**: It locks the internal standard mutex, clones the optional enrollment, and returns that clone. The stored enrollment remains in place.

**Call relations**: It is used by `RemoteControlEnrollmentState::lock` to initialize the editable lease.

*Call graph*: called by 1 (lock); 1 external calls (lock).


##### `RemoteControlEnrollmentLease::deref`  (lines 172–174)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Lets the enrollment lease be read as if it were the optional enrollment it contains. This makes the lease convenient to pass into code that expects normal enrollment data.

**Data flow**: It receives the lease by reference and returns a read-only reference to the enrollment copy inside it. Nothing is changed.

**Call relations**: This supports the lock-and-edit pattern used by pairing and enrollment code.


##### `RemoteControlEnrollmentLease::deref_mut`  (lines 178–180)

```
fn deref_mut(&mut self) -> &mut Self::Target
```

**Purpose**: Lets the enrollment lease be edited as if it were the optional enrollment it contains. This is how callers update the checked-out enrollment copy.

**Data flow**: It receives the lease by mutable reference and returns a mutable reference to its internal enrollment copy. Changes affect the lease copy until it is dropped.

**Call relations**: This works with `RemoteControlEnrollmentLease::drop`, which writes the edited copy back to shared state.


##### `RemoteControlEnrollmentLease::drop`  (lines 184–190)

```
fn drop(&mut self)
```

**Purpose**: Writes the lease’s final enrollment value back into the shared enrollment state when the lease goes out of scope. This is the automatic “return the document to the cabinet” step.

**Data flow**: It takes the enrollment value from the lease, locks the shared storage, and replaces the stored enrollment with that value.

**Call relations**: It completes the flow started by `RemoteControlEnrollmentState::lock`. Callers do not call it manually; Rust runs it automatically when the lease is finished.


##### `RemoteControlUnavailable::fmt`  (lines 197–202)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Provides the human-readable message for the error used when remote control cannot work because the local SQLite state database is unavailable. SQLite is the small local database used for saved state.

**Data flow**: It receives a formatter and writes a fixed explanatory sentence into it. The result is used wherever the error is displayed.

**Call relations**: This supports `RemoteControlEnableError` and other user-facing error paths that need a clear reason.

*Call graph*: 1 external calls (write!).


##### `RemoteControlDisabledByRequirements::fmt`  (lines 211–213)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Provides the human-readable message for the error used when policy or managed requirements forbid remote control. This makes the failure reason explicit instead of looking like a random connection problem.

**Data flow**: It receives a formatter and writes a fixed message saying remote control is disabled by managed requirements.

**Call relations**: This is used when policy checks in `RemoteControlHandle` reject an operation.

*Call graph*: 1 external calls (write!).


##### `RemoteControlEnableError::fmt`  (lines 225–230)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Turns the broader enable-error enum into the right human-readable message. It delegates to the specific error inside it.

**Data flow**: It receives either an unavailable-state error or a disabled-by-policy error. It formats whichever one is present and returns the formatting result.

**Call relations**: This is used by callers of enable operations when they need to display or log why enabling remote control failed.


##### `RemoteControlHandle::ensure_remote_control_allowed`  (lines 236–241)

```
fn ensure_remote_control_allowed(&self) -> Result<(), RemoteControlDisabledByRequirements>
```

**Purpose**: Checks whether remote control is allowed by the current policy. It stops operations early when managed requirements have disabled the feature.

**Data flow**: It reads the handle’s policy. If the policy is `Allowed`, it returns success; if the policy is `DisabledByRequirements`, it returns a specific policy error.

**Call relations**: Enable and I/O-style permission checks call this before doing work. It is the main gatekeeper for policy enforcement.

*Call graph*: called by 2 (enable_with_preference, ensure_remote_control_allowed_io).


##### `RemoteControlHandle::ensure_remote_control_allowed_io`  (lines 243–246)

```
fn ensure_remote_control_allowed_io(&self) -> io::Result<()>
```

**Purpose**: Runs the same policy check as `ensure_remote_control_allowed`, but converts the result into an `io::Result`. That lets network-style and database-style functions report the policy failure in their normal error format.

**Data flow**: It calls `ensure_remote_control_allowed`. Success stays success; a disabled-by-policy error becomes a permission-denied I/O error.

**Call relations**: Disable, pairing, client listing, and client revocation call this before they talk to storage or remote services.

*Call graph*: calls 1 internal fn (ensure_remote_control_allowed); called by 5 (disable, list_clients, pairing_status, revoke_client, start_pairing).


##### `RemoteControlHandle::enable_ephemeral`  (lines 248–252)

```
fn enable_ephemeral(
        &self,
    ) -> Result<RemoteControlStatusChangedNotification, RemoteControlEnableError>
```

**Purpose**: Requests remote control to be enabled without explicitly saving that preference as a permanent user setting. “Ephemeral” here means the request is for the current run unless existing state says otherwise.

**Data flow**: It passes no persistence preference into `enable_with_preference`. The result is the latest remote-control status notification or an enable error.

**Call relations**: This is the simple public enable method. It hands the real decision-making to `enable_with_preference`.

*Call graph*: calls 1 internal fn (enable_with_preference).


##### `RemoteControlHandle::enable_with_preference`  (lines 254–305)

```
fn enable_with_preference(
        &self,
        persistence_preference: Option<bool>,
    ) -> Result<RemoteControlStatusChangedNotification, RemoteControlEnableError>
```

**Purpose**: Changes the desired state to enabled and publishes a connecting status if needed. It also refuses to enable remote control when policy forbids it or when the local state database is missing.

**Data flow**: It reads policy, database availability, the current desired state, and the current status. It updates the desired-state watch channel to enabled, possibly preserving a previous persistence preference, then returns the current status if already connecting/connected or publishes `Connecting`.

**Call relations**: Called by `enable_ephemeral`. It calls `ensure_remote_control_allowed`, `status`, and `publish_status`; the background websocket task observes the desired-state change and does the actual connection work.

*Call graph*: calls 3 internal fn (ensure_remote_control_allowed, publish_status, status); called by 1 (enable_ephemeral); 4 external calls (Unavailable, info!, matches!, warn!).


##### `RemoteControlHandle::disable`  (lines 307–324)

```
async fn disable(
        &self,
        app_server_client_name: Option<&str>,
    ) -> io::Result<RemoteControlStatusChangedNotification>
```

**Purpose**: Turns remote control off and saves that disabled preference when possible. This is the persistent disable path used when the choice should be remembered.

**Data flow**: It checks policy, takes locks so only one desired-state change and persistence write happen at a time, writes the disabled preference to the state database, then moves the in-memory state to disabled and returns the new status.

**Call relations**: It calls `persist_preference` before `transition_disabled`. The locks coordinate with other remote-control state changes and with websocket persistence work.

*Call graph*: calls 4 internal fn (ensure_remote_control_allowed_io, persist_preference, transition_disabled, acquire_persistence_lock).


##### `RemoteControlHandle::disable_ephemeral`  (lines 326–334)

```
async fn disable_ephemeral(&self) -> RemoteControlStatusChangedNotification
```

**Purpose**: Turns remote control off for the current run without saving that as a persistent preference. This is useful for temporary shutdowns or internal mode changes.

**Data flow**: It takes the same state-change locks as the persistent disable path, skips the database write, changes the desired state to disabled, and returns the new status notification.

**Call relations**: It calls `transition_disabled` after taking the persistence lock. Unlike `disable`, it does not call `persist_preference`.

*Call graph*: calls 2 internal fn (transition_disabled, acquire_persistence_lock).


##### `RemoteControlHandle::transition_disabled`  (lines 336–352)

```
fn transition_disabled(&self) -> RemoteControlStatusChangedNotification
```

**Purpose**: Performs the in-memory transition to disabled and publishes a disabled connection status. This is the shared final step for both persistent and temporary disabling.

**Data flow**: It updates the desired-state watch channel to `Disabled`, reads the current status for logging, publishes a `Disabled` status, and returns that status notification.

**Call relations**: Called by `disable` and `disable_ephemeral`. It uses `publish_status` so status subscribers hear about the change.

*Call graph*: calls 2 internal fn (publish_status, status); called by 2 (disable, disable_ephemeral); 1 external calls (info!).


##### `RemoteControlHandle::persist_preference`  (lines 354–376)

```
async fn persist_preference(
        &self,
        app_server_client_name: Option<&str>,
        remote_control_enabled: bool,
    ) -> io::Result<()>
```

**Purpose**: Saves whether remote control should be enabled for this app server, account, and remote-control service target. This is how the choice survives restart.

**Data flow**: It reads the state database, current remote-control authentication, the normalized remote-control URL, and the pairing persistence key. It writes the enabled/disabled preference into the database and returns success or an I/O error.

**Call relations**: Called by `disable`. It depends on authentication loading, URL normalization, and `pairing_persistence_key` to identify the right saved row.

*Call graph*: calls 3 internal fn (pairing_persistence_key, load_remote_control_auth, normalize_remote_control_url); called by 1 (disable).


##### `RemoteControlHandle::status`  (lines 378–380)

```
fn status(&self) -> RemoteControlStatusChangedNotification
```

**Purpose**: Returns the latest known remote-control status. This is a quick snapshot for callers that want to know whether the feature is disabled, connecting, or connected.

**Data flow**: It reads the current value from the status watch channel, clones it, and returns the clone. It does not change state.

**Call relations**: Enable, disable, pairing, and status publishing code call this when they need the latest status object.

*Call graph*: called by 5 (enable_with_preference, pairing_status, publish_status, start_pairing, transition_disabled).


##### `RemoteControlHandle::status_receiver`  (lines 382–384)

```
fn status_receiver(&self) -> watch::Receiver<RemoteControlStatusChangedNotification>
```

**Purpose**: Gives callers a subscription to future remote-control status changes. This is useful for UI or protocol code that wants to be notified instead of polling repeatedly.

**Data flow**: It creates a new receiver subscribed to the status watch channel. The caller receives the current status immediately and later updates as they happen.

**Call relations**: This exposes the status stream maintained by `publish_status` and the websocket status publisher.


##### `RemoteControlHandle::start_pairing`  (lines 386–502)

```
async fn start_pairing(
        &self,
        params: RemoteControlPairingStartParams,
        app_server_client_name: Option<&str>,
    ) -> io::Result<RemoteControlPairingStartResponse>
```

**Purpose**: Starts the process of pairing a new remote-control client with this app server. It ensures remote control is enabled, finds or creates the server enrollment, refreshes expired credentials when needed, and asks the remote service to begin pairing.

**Data flow**: It takes pairing parameters and an optional app-server client name. It loads auth, reads current status, locks enrollment state, loads or creates enrollment, refreshes tokens if needed, sends a start-pairing request, checks that the account and enabled state did not change mid-flight, then returns the pairing response.

**Call relations**: This is called by request-handling code when a user starts pairing. It calls `load_or_enroll_pairing_server`, `refresh_pairing_enrollment`, `clear_pairing_server_token`, and several validation helpers to recover from stale or rejected server credentials.

*Call graph*: calls 8 internal fn (ensure_remote_control_allowed_io, load_or_enroll_pairing_server, pairing_persistence_key, status, load_remote_control_auth, clear_pairing_server_token, pairing_unavailable_error, refresh_pairing_enrollment); 2 external calls (lock, pairing_disabled_error).


##### `RemoteControlHandle::load_or_enroll_pairing_server`  (lines 504–552)

```
async fn load_or_enroll_pairing_server(
        &self,
        current_enrollment: &mut Option<RemoteControlEnrollment>,
        auth: &mut auth::RemoteControlConnectionAuth,
        installation_id:
```

**Purpose**: Gets a usable server enrollment for pairing and, if it had to create a new one, saves it to local state. Enrollment is the server’s registration with the remote-control service.

**Data flow**: It receives the current enrollment slot, auth, installation/server identity, optional client name, and a reuse-or-replace choice. It loads or creates an enrollment, saves newly created enrollment details with the current persistence preference, publishes it into shared state, and returns it.

**Call relations**: Called by `start_pairing` and `pairing_status` when they need a valid enrollment. It builds on `load_or_enroll_server` and updates persistence through `update_persisted_remote_control_enrollment`.

*Call graph*: calls 4 internal fn (load_or_enroll_server, acquire_persistence_lock, update_persisted_remote_control_enrollment, publish_current_enrollment); called by 2 (pairing_status, start_pairing); 1 external calls (pairing_disabled_error).


##### `RemoteControlHandle::load_or_enroll_server`  (lines 554–602)

```
async fn load_or_enroll_server(
        &self,
        current_enrollment: &Option<RemoteControlEnrollment>,
        auth: &mut auth::RemoteControlConnectionAuth,
        installation_id: &str,
```

**Purpose**: Chooses the actual enrollment record to use. It reuses the current one when safe, loads a saved one from the database when available, or creates a new enrollment with the remote service.

**Data flow**: It normalizes the remote-control URL, checks whether the current enrollment belongs to the current account, optionally loads a persisted enrollment, or calls `enroll_pairing_server` to create one. It returns the enrollment plus a flag saying whether it was newly created.

**Call relations**: Called only by `load_or_enroll_pairing_server`. It is the lower-level selection step before persistence and publication happen.

*Call graph*: calls 3 internal fn (load_persisted_remote_control_enrollment, enroll_pairing_server, normalize_remote_control_url); called by 1 (load_or_enroll_pairing_server).


##### `RemoteControlHandle::pairing_persistence_key`  (lines 604–616)

```
fn pairing_persistence_key(
        &self,
        app_server_client_name: Option<&str>,
    ) -> io::Result<Option<String>>
```

**Purpose**: Finds or establishes the client-name key used to store pairing-related preferences. This matters when multiple app-server clients might need separate saved remote-control settings.

**Data flow**: It checks whether a persistence key is required and missing. If so, it uses the provided app-server client name, stores it in a watch channel, and returns the current key as an optional string.

**Call relations**: Called by `persist_preference` and `start_pairing`. It supplies the identifying key used for database persistence.

*Call graph*: called by 2 (persist_preference, start_pairing); 2 external calls (borrow, send_replace).


##### `RemoteControlHandle::pairing_status`  (lines 618–716)

```
async fn pairing_status(
        &self,
        params: RemoteControlPairingStatusParams,
    ) -> io::Result<RemoteControlPairingStatusResponse>
```

**Purpose**: Asks the remote service whether a pairing attempt has completed, failed, or is still pending. It also refreshes credentials and protects against account or enabled-state changes during the check.

**Data flow**: It takes status-query parameters, validates that remote control is allowed and enabled, loads auth, locks current enrollment, refreshes the enrollment token if needed, converts the request’s pairing code into the internal form, asks the remote service for status, handles stale or unauthorized enrollment errors, and returns the response.

**Call relations**: Request-handling code calls this after `start_pairing`. It uses `remote_control_pairing_status_code`, `refresh_pairing_enrollment`, `clear_pairing_server_token`, and may call `load_or_enroll_pairing_server` if the remote service says the saved enrollment no longer exists.

*Call graph*: calls 8 internal fn (ensure_remote_control_allowed_io, load_or_enroll_pairing_server, status, load_remote_control_auth, clear_pairing_server_token, pairing_unavailable_error, refresh_pairing_enrollment, remote_control_pairing_status_code); 3 external calls (lock, borrow, pairing_disabled_error).


##### `RemoteControlHandle::list_clients`  (lines 718–725)

```
async fn list_clients(
        &self,
        params: RemoteControlClientsListParams,
    ) -> io::Result<RemoteControlClientsListResponse>
```

**Purpose**: Lists clients that are authorized to use remote control for this account/service. This lets users inspect who can connect.

**Data flow**: It receives list parameters, checks policy, then passes the remote-control URL, auth manager, and parameters to the client-management module. It returns the list response or an I/O error.

**Call relations**: This is a public handle method used by request-handling code. It delegates the service call to `clients::list_remote_control_clients`.

*Call graph*: calls 2 internal fn (ensure_remote_control_allowed_io, list_remote_control_clients).


##### `RemoteControlHandle::revoke_client`  (lines 727–734)

```
async fn revoke_client(
        &self,
        params: RemoteControlClientsRevokeParams,
    ) -> io::Result<RemoteControlClientsRevokeResponse>
```

**Purpose**: Revokes a remote-control client so it can no longer connect. This is the safety valve for removing access.

**Data flow**: It receives revoke parameters, checks policy, then passes the remote-control URL, auth manager, and parameters to the client-management module. It returns the revoke response or an I/O error.

**Call relations**: This is a public handle method used by request-handling code. It delegates the service call to `clients::revoke_remote_control_client`.

*Call graph*: calls 2 internal fn (ensure_remote_control_allowed_io, revoke_remote_control_client).


##### `RemoteControlHandle::pairing_disabled_error`  (lines 736–741)

```
fn pairing_disabled_error() -> io::Error
```

**Purpose**: Creates the standard error used when someone tries to pair while remote control is not enabled. This keeps the message consistent across pairing paths.

**Data flow**: It creates an invalid-input I/O error with a fixed explanatory message and returns it.

**Call relations**: Pairing setup code uses this when the desired state is disabled or no longer enabled.

*Call graph*: 1 external calls (new).


##### `RemoteControlHandle::publish_status`  (lines 743–771)

```
fn publish_status(
        &self,
        connection_status: RemoteControlConnectionStatus,
    ) -> RemoteControlStatusChangedNotification
```

**Purpose**: Updates the shared remote-control status and notifies subscribers if the connection status actually changed. It avoids sending duplicate status updates.

**Data flow**: It receives a new connection status, combines it with the existing server name and installation details, updates the status watch channel only if the full status changed, logs the transition, and returns the latest status.

**Call relations**: Called by enable and disable transitions. The returned status is what API callers can send back to clients, while subscribers receive the same update through the watch channel.

*Call graph*: calls 1 internal fn (status); called by 2 (enable_with_preference, transition_disabled); 1 external calls (info!).


##### `enroll_pairing_server`  (lines 774–798)

```
async fn enroll_pairing_server(
    auth_manager: &Arc<AuthManager>,
    auth: &mut auth::RemoteControlConnectionAuth,
    remote_control_target: &protocol::RemoteControlTarget,
    installation_id: &
```

**Purpose**: Registers this app server with the remote-control service for pairing. If the first attempt fails because authentication is no longer valid, it tries to recover auth and then retries once.

**Data flow**: It receives the auth manager, mutable auth data, remote-control target, installation ID, and server name. It attempts enrollment; on permission failure, it asks the auth manager to recover, reloads auth, and tries enrollment again. It returns the new enrollment or an error.

**Call relations**: Called by `RemoteControlHandle::load_or_enroll_server` when no usable existing enrollment is available. It delegates the actual service call to `enroll_remote_control_server`.

*Call graph*: calls 3 internal fn (load_remote_control_auth, recover_remote_control_auth, enroll_remote_control_server); called by 1 (load_or_enroll_server).


##### `remote_control_pairing_status_code`  (lines 800–819)

```
fn remote_control_pairing_status_code(
    params: &RemoteControlPairingStatusParams,
) -> io::Result<RemoteControlPairingStatusCode>
```

**Purpose**: Validates the pairing-status request and turns its code field into the internal form used by the protocol layer. It enforces that the caller provides exactly one kind of pairing code.

**Data flow**: It reads `pairing_code` and `manual_pairing_code` from the parameters. If exactly one is present, it wraps that value in the matching internal enum; if both or neither are present, it returns an invalid-input error.

**Call relations**: Called by `RemoteControlHandle::pairing_status` before contacting the remote service.

*Call graph*: called by 1 (pairing_status); 3 external calls (ManualPairingCode, PairingCode, new).


##### `refresh_pairing_enrollment`  (lines 821–850)

```
async fn refresh_pairing_enrollment(
    current_enrollment: &mut Option<RemoteControlEnrollment>,
    auth_manager: &Arc<AuthManager>,
    auth: &mut auth::RemoteControlConnectionAuth,
    installati
```

**Purpose**: Refreshes the server token inside an enrollment when it is expired or rejected. The server token is the credential used to prove this app server is registered.

**Data flow**: It tries to refresh the enrollment using current auth. If permission is denied, it attempts auth recovery, reloads auth, verifies the account still matches, and retries. If refresh succeeds and the enrollment still matches the current selected server, it writes the refreshed enrollment back.

**Call relations**: Called by `start_pairing` and `pairing_status` when an enrollment says its server token should be refreshed or when the remote service rejects a request. It uses `replace_current_enrollment` to avoid overwriting a different selected enrollment.

*Call graph*: calls 5 internal fn (load_remote_control_auth, recover_remote_control_auth, refresh_remote_control_server, pairing_unavailable_error, replace_current_enrollment); called by 2 (pairing_status, start_pairing).


##### `clear_pairing_server_token`  (lines 852–862)

```
fn clear_pairing_server_token(
    current_enrollment: &mut Option<RemoteControlEnrollment>,
    enrollment: &mut RemoteControlEnrollment,
) -> io::Result<()>
```

**Purpose**: Removes the server token from an enrollment after the remote service rejects it. This prevents the code from continuing to trust a credential that is known to be bad.

**Data flow**: It clears the token in the given enrollment, then tries to replace the current shared enrollment with that token-cleared version. It returns success if the shared enrollment still matches, otherwise a pairing-unavailable error.

**Call relations**: Called by `start_pairing` and `pairing_status` after permission-denied responses. It uses `replace_current_enrollment` for safe shared-state update.

*Call graph*: calls 3 internal fn (clear_server_token, pairing_unavailable_error, replace_current_enrollment); called by 2 (pairing_status, start_pairing).


##### `pairing_unavailable_error`  (lines 864–869)

```
fn pairing_unavailable_error() -> io::Error
```

**Purpose**: Creates the standard error used when pairing cannot proceed because enrollment is not ready or no longer valid. This gives callers a consistent explanation.

**Data flow**: It creates an invalid-input I/O error with a fixed message and returns it.

**Call relations**: Used throughout pairing flows, especially by `start_pairing`, `pairing_status`, `refresh_pairing_enrollment`, and `clear_pairing_server_token`.

*Call graph*: called by 4 (pairing_status, start_pairing, clear_pairing_server_token, refresh_pairing_enrollment); 1 external calls (new).


##### `remote_control_status_with_connection_status`  (lines 871–885)

```
fn remote_control_status_with_connection_status(
    status: &RemoteControlStatusChangedNotification,
    connection_status: RemoteControlConnectionStatus,
) -> RemoteControlStatusChangedNotification
```

**Purpose**: Builds a new status notification by changing only the connection status while preserving identity fields. If remote control becomes disabled, it also clears the environment ID because there is no active remote environment.

**Data flow**: It takes the current status and a new connection status. It copies server name and installation ID, sets the new status, and either keeps or clears the environment ID depending on whether the status is disabled.

**Call relations**: Used by `RemoteControlHandle::publish_status` to create the next status value consistently.


##### `publish_current_enrollment`  (lines 887–892)

```
fn publish_current_enrollment(
    current_enrollment: &mut Option<RemoteControlEnrollment>,
    enrollment: &RemoteControlEnrollment,
)
```

**Purpose**: Stores a selected enrollment as the current shared enrollment. This makes later pairing or websocket work use the same server registration.

**Data flow**: It takes a mutable current-enrollment slot and an enrollment reference. It clones the enrollment and puts it into the slot.

**Call relations**: Called by `load_or_enroll_pairing_server` after an enrollment has been reused or newly saved.

*Call graph*: called by 1 (load_or_enroll_pairing_server); 1 external calls (clone).


##### `replace_current_enrollment`  (lines 894–906)

```
fn replace_current_enrollment(
    current_enrollment: &mut Option<RemoteControlEnrollment>,
    enrollment: &RemoteControlEnrollment,
) -> bool
```

**Purpose**: Safely replaces the current enrollment only if it is still the same enrollment record. This prevents one async operation from overwriting another operation’s newer choice.

**Data flow**: It compares the current stored enrollment with the proposed updated enrollment by account, server, and environment. If they match, it stores the clone and returns `true`; otherwise it leaves state unchanged and returns `false`.

**Call relations**: Called by `refresh_pairing_enrollment` and `clear_pairing_server_token` after changing token-related fields.

*Call graph*: called by 2 (clear_pairing_server_token, refresh_pairing_enrollment); 1 external calls (clone).


##### `same_remote_control_enrollment`  (lines 908–917)

```
fn same_remote_control_enrollment(
    left: &RemoteControlEnrollment,
    right: &RemoteControlEnrollment,
) -> bool
```

**Purpose**: Checks whether two enrollment objects refer to the same remote server registration. It deliberately ignores rotating token values, because tokens can change while the underlying enrollment stays the same.

**Data flow**: It compares account ID, server ID, and environment ID. If all three match, it returns `true`; otherwise it returns `false`.

**Call relations**: Used by `replace_current_enrollment` as the safety check before writing refreshed or token-cleared enrollment data.


##### `start_remote_control`  (lines 919–1071)

```
async fn start_remote_control(
    config: RemoteControlStartConfig,
    state_db: Option<Arc<StateRuntime>>,
    auth_manager: Arc<AuthManager>,
    transport_event_tx: mpsc::Sender<TransportEvent>,
```

**Purpose**: Sets up the whole remote-control subsystem and starts its background websocket task. It returns both the spawned task and a handle that other code can use to control remote control.

**Data flow**: It takes startup configuration, optional state database, auth manager, event sender, shutdown token, optional client-name receiver, and startup mode. It decides the initial desired state, prepares watch channels, locks, enrollment state, status state, and websocket configuration, spawns the websocket task, and returns the task handle plus `RemoteControlHandle`.

**Call relations**: This is the main entry point for this module during app-server startup. It creates `RemoteControlWebsocket`, hands it channels and shared state, and wraps the public control methods in `RemoteControlHandle` for the rest of the server.

*Call graph*: calls 4 internal fn (new, normalize_remote_control_url, new, new); 11 external calls (new, clone, new, error!, gethostname, info!, AssertUnwindSafe, resume_unwind, spawn, warn! (+1 more)).


### `app-server-transport/src/transport/remote_control/desired_state.rs`

`domain_logic` · `startup and remote-control request handling`

Remote control has two different kinds of state: what the app wants right now, and what was saved from a previous run. This file is the bridge between those. On first startup, the desired state may be unknown because the app has not yet checked who the user is or whether remote control was previously enabled. Once it can read the saved enrollment record, it turns that unknown state into a clear enabled or disabled answer.

The file also protects writes to saved state with a semaphore, which is a gate that lets only one task pass at a time. That matters because enabling, disabling, enrolling, or reacting to an account change could otherwise try to edit the same saved remote-control record at once.

The biggest operation here is `RemoteControlHandle::enable`. It checks that remote control is allowed, loads the current account, normalizes the remote-control server URL, finds or creates an enrollment, writes the enabled preference to the state database, publishes the current enrollment to the rest of the system, updates the in-memory desired state, and finally sends a status update. In plain terms, it is the “turn this feature on and remember it” button, with checks to avoid saving the wrong account or racing another state change.

#### Function details

##### `RemoteControlDesiredState::is_enabled`  (lines 29–31)

```
fn is_enabled(self) -> bool
```

**Purpose**: This answers the simple question: does this desired-state value mean remote control is enabled? It hides the enum details so other code can ask for a plain yes-or-no result.

**Data flow**: It takes one `RemoteControlDesiredState` value. If the value is `Enabled`, regardless of its saved-preference detail, it returns `true`; otherwise it returns `false`. It does not change anything.

**Call relations**: This is a small helper used when code has already resolved or read the desired state and needs a boolean answer. In this file, `RemoteControlHandle::resolve_persisted_preference` uses it after checking that the state is no longer unknown.

*Call graph*: 1 external calls (matches!).


##### `acquire_persistence_lock`  (lines 34–36)

```
async fn acquire_persistence_lock(lock: &Semaphore) -> SemaphorePermit<'_>
```

**Purpose**: This waits for the lock that protects saved remote-control state. It is used so only one task at a time can change the persisted enrollment or enabled flag.

**Data flow**: It receives a semaphore, which is a one-at-a-time gate. It waits until a permit is available, then returns that permit. While the permit is held, other tasks trying to take the same lock must wait.

**Call relations**: Several remote-control state transitions call this before touching persisted state: `disable`, `disable_ephemeral`, `load_or_enroll_pairing_server`, `enable`, `enroll_and_persist_remote_control_server`, and `resolve_desired_state_after_account_change`. In this file, `RemoteControlHandle::enable` uses it just before writing the enabled preference to the database.

*Call graph*: called by 6 (disable, disable_ephemeral, load_or_enroll_pairing_server, enable, enroll_and_persist_remote_control_server, resolve_desired_state_after_account_change); 1 external calls (acquire).


##### `desired_state_from_persisted_enrollment`  (lines 38–48)

```
fn desired_state_from_persisted_enrollment(
    enrollment: Option<RemoteControlEnrollmentRecord>,
) -> RemoteControlDesiredState
```

**Purpose**: This converts a saved enrollment record into the app’s in-memory desired-state value. It treats only an explicit saved `true` as enabled; anything missing, unset, or false becomes disabled.

**Data flow**: It receives an optional saved enrollment record. If the record exists and its `remote_control_enabled` field is `Some(true)`, it returns `Enabled` with a saved preference of `Some(true)`. If there is no record, or the saved value is false or empty, it returns `Disabled`.

**Call relations**: This is the common translation step for code that reads saved remote-control data. It is called by `RemoteControlHandle::resolve_persisted_preference`, `resolve_unknown_desired_state`, and `resolve_desired_state_after_account_change` when they need to turn database data into the runtime desired state.

*Call graph*: called by 3 (resolve_persisted_preference, resolve_unknown_desired_state, resolve_desired_state_after_account_change).


##### `RemoteControlHandle::resolve_persisted_preference`  (lines 51–94)

```
async fn resolve_persisted_preference(
        &self,
        app_server_client_name: Option<&str>,
    ) -> io::Result<bool>
```

**Purpose**: This figures out, usually during startup or first use, whether remote control should be enabled based on saved data. It is careful not to do that work twice if another task has already resolved the answer.

**Data flow**: It takes an optional app-server client name, then first checks whether remote control is allowed at all. If it is not allowed, it returns `false`. It takes the desired-state RPC lock so two requests do not resolve the unknown state at the same time. If the desired state is already known, it returns whether that state is enabled. Otherwise it reads the state database, loads the current remote-control account, normalizes the remote-control URL, builds the persistence key for the client name, fetches the saved enrollment, converts it with `desired_state_from_persisted_enrollment`, stores that result if the state is still unknown, and returns the final enabled-or-disabled answer.

**Call relations**: This function sits at the point where runtime state meets saved configuration. It calls `load_remote_control_auth` to know which account’s enrollment to read, `normalize_remote_control_url` so the lookup uses the canonical server address, and `desired_state_from_persisted_enrollment` to interpret the database row. If remote control storage is unavailable, it reports that as an I/O error.

*Call graph*: calls 3 internal fn (load_remote_control_auth, desired_state_from_persisted_enrollment, normalize_remote_control_url); 1 external calls (matches!).


##### `RemoteControlHandle::enable`  (lines 96–170)

```
async fn enable(
        &self,
        app_server_client_name: Option<&str>,
    ) -> io::Result<RemoteControlStatusChangedNotification>
```

**Purpose**: This turns remote control on and saves that choice so it survives future runs. It also makes sure there is a valid enrollment with the remote-control server before marking the feature enabled.

**Data flow**: It receives an optional app-server client name. It first checks permission, then takes a transition lock so another enable-or-disable request cannot race it. It requires a state database, loads the current account, normalizes the remote-control URL, and prepares the persistence key for the client name. It reads current status, locks the current enrollment, and asks the server-enrollment path to reuse or create an enrollment. After enrollment, it reloads auth and refuses to continue if the account changed mid-operation. Then it takes the persistence lock, writes `remote_control_enabled = true` to the database, creates or updates the persisted enrollment row if needed, publishes the enrollment in memory, updates the desired state to enabled with a saved preference, publishes the environment id to status listeners, and returns the new status notification.

**Call relations**: This is the durable enable path for `RemoteControlHandle`. It calls `load_remote_control_auth` before and after enrollment to avoid saving an enrollment under the wrong account, `normalize_remote_control_url` for consistent database keys, `acquire_persistence_lock` before writing saved state, `update_persisted_remote_control_enrollment` if no existing row was updated, `publish_current_enrollment` to refresh shared in-memory enrollment data, and `RemoteControlStatusPublisher::new` to announce the updated environment id.

*Call graph*: calls 5 internal fn (load_remote_control_auth, acquire_persistence_lock, update_persisted_remote_control_enrollment, normalize_remote_control_url, new); 2 external calls (new, publish_current_enrollment).


### `app-server-transport/src/transport/remote_control/enroll.rs`

`io_transport` · `startup, enrollment, token refresh, and pairing request handling`

Remote control needs a trusted handshake before another device or service can connect to this app server. This file is the handshake clerk. It enrolls the local server with the remote-control backend, stores the stable parts of that enrollment in the local state database, keeps the temporary server token fresh, and uses that token to start and check pairing.

The central record is `RemoteControlEnrollment`. It holds the target backend URLs, account and environment IDs, server ID, server name, and an optional temporary token with an expiry time. The token is deliberately treated as short-lived: if it is missing or close to expiring, pairing is refused until the server refreshes it. This is like refusing to open a secure door with a badge that is about to expire.

The file also wraps HTTP calls to the backend. It sends JSON requests, adds authentication and identifying headers, reads responses, turns backend failures into useful local errors, and limits response-body previews so logs are helpful without exposing secrets. Sensitive fields such as tokens and pairing codes are redacted before being included in error text.

Finally, it saves and loads enrollment identity from SQLite-backed state. The saved record lets the app remember “this machine is already enrolled as server X” without saving the temporary token itself.

#### Function details

##### `RemoteControlEnrollment::start_pairing`  (lines 49–140)

```
async fn start_pairing(
        &self,
        request: StartRemoteControlPairingRequest,
    ) -> io::Result<RemoteControlPairingStartResponse>
```

**Purpose**: Starts a new remote-control pairing session for an already enrolled server. It refuses to proceed if the server token is missing or too close to expiry, because pairing must happen with a valid short-lived credential.

**Data flow**: It takes the current enrollment and a pairing request. It checks whether the token is usable, sends the request as JSON to the backend pairing URL with bearer-token authentication, reads the response, redacts and previews the body for any error messages, verifies that the returned server and environment match this enrollment, parses the expiry time, and returns the pairing code information expected by the app-server protocol.

**Call relations**: When a caller asks to begin pairing, this method first relies on `should_refresh_server_token` to decide whether the enrollment is ready. It then uses `build_reqwest_client` to contact the backend and `preview_remote_control_response_body` to make failures understandable without leaking secrets. If the token is not usable, it reports the shared `pairing_unavailable_error` instead of making the backend call.

*Call graph*: calls 3 internal fn (should_refresh_server_token, preview_remote_control_response_body, build_reqwest_client); 5 external calls (parse, new, other, format!, pairing_unavailable_error).


##### `RemoteControlEnrollment::pairing_status`  (lines 142–203)

```
async fn pairing_status(
        &self,
        request: RemoteControlPairingStatusRequest,
    ) -> io::Result<RemoteControlPairingStatusResponse>
```

**Purpose**: Checks whether a pairing request has been claimed by a remote client. It is used after pairing has started, so the local app can poll for progress.

**Data flow**: It receives the enrollment and a status request. It confirms the server token is present and fresh enough, posts the request to the backend status URL with bearer-token authentication, reads and previews the response body for diagnostics, converts backend error codes into local error kinds, parses the backend response, and returns only the public `claimed` status.

**Call relations**: This method follows the same readiness gate as `start_pairing` by calling `should_refresh_server_token`. It uses `build_reqwest_client` for the HTTP request and `preview_remote_control_response_body` for safe error text. If the enrollment needs a token refresh, it stops early with `pairing_unavailable_error`.

*Call graph*: calls 3 internal fn (should_refresh_server_token, preview_remote_control_response_body, build_reqwest_client); 3 external calls (new, format!, pairing_unavailable_error).


##### `RemoteControlEnrollment::should_refresh_server_token`  (lines 205–212)

```
fn should_refresh_server_token(&self) -> bool
```

**Purpose**: Decides whether the temporary remote-control server token should be refreshed before use. It treats a missing token or a token expiring within the safety window as unusable.

**Data flow**: It reads the enrollment’s optional token and optional expiry time. If either is absent, or if the expiry time is at or before the current time plus a 30-second buffer, it returns `true`; otherwise it returns `false`.

**Call relations**: `start_pairing` and `pairing_status` call this before making backend pairing requests. That keeps those flows from using stale credentials and pushes the caller toward the refresh path first.

*Call graph*: called by 2 (pairing_status, start_pairing).


##### `RemoteControlEnrollment::clear_server_token`  (lines 214–217)

```
fn clear_server_token(&mut self)
```

**Purpose**: Removes the short-lived server token from an enrollment. This is useful when another part of the system knows the token should no longer be trusted.

**Data flow**: It takes a mutable enrollment. It changes `remote_control_token` and `expires_at` from whatever they were to `None`, leaving the stable enrollment IDs and server name untouched.

**Call relations**: The wider remote-control flow calls this through `clear_pairing_server_token` when it needs to forget the temporary credential while keeping the enrollment identity.

*Call graph*: called by 1 (clear_pairing_server_token).


##### `load_persisted_remote_control_enrollment`  (lines 220–281)

```
async fn load_persisted_remote_control_enrollment(
    state_db: Option<&StateRuntime>,
    remote_control_target: &RemoteControlTarget,
    account_id: &str,
    app_server_client_name: Option<&str>,
```

**Purpose**: Loads a previously saved remote-control enrollment from the local state database. This lets the app reuse the same server identity after restart instead of enrolling as a new server every time.

**Data flow**: It receives an optional state database, the remote-control target, the account ID, and an optional client name. If the database is unavailable, it returns a not-found style error. Otherwise it looks up a matching saved enrollment by backend URL, account, and client name. If found, it builds a `RemoteControlEnrollment` with the saved stable IDs but no temporary token; if not found, it returns `None`.

**Call relations**: `load_or_enroll_server` and `prepare_remote_control_enrollment` call this early in the remote-control setup path. It logs whether it reused an enrollment or found none, and it warns if the state database lookup itself fails.

*Call graph*: called by 2 (load_or_enroll_server, prepare_remote_control_enrollment); 6 external calls (clone, new, other, format!, info!, warn!).


##### `update_persisted_remote_control_enrollment`  (lines 283–348)

```
async fn update_persisted_remote_control_enrollment(
    state_db: Option<&StateRuntime>,
    remote_control_target: &RemoteControlTarget,
    account_id: &str,
    app_server_client_name: Option<&str
```

**Purpose**: Saves or clears the stable enrollment record in local state. It is how the app remembers which server ID belongs to a target backend and account.

**Data flow**: It receives the optional state database, target, account, optional client name, optional enrollment, and optional enabled flag. If an enrollment is provided, it verifies the account matches, writes or updates the record, and logs the saved server and environment IDs. If no enrollment is provided, it deletes the matching record and logs how many rows were removed.

**Call relations**: Enrollment and settings flows call this after creating, reusing, enabling, or clearing remote control. Tests also call it to prove records round-trip correctly and that deletion only removes the matching target/account entry.

*Call graph*: called by 12 (load_or_enroll_pairing_server, enable, clearing_persisted_remote_control_enrollment_removes_only_matching_entry, persisted_remote_control_enrollment_round_trips_by_target_and_account, persisted_enable_does_not_follow_auth_to_an_account_without_a_preference, remote_control_http_mode_preserves_enrollment_after_generic_websocket_404, remote_control_http_mode_preserves_stale_enrollment_when_reenrollment_fails, remote_control_http_mode_reenrolls_after_explicit_missing_server_404, remote_control_http_mode_reenrolls_when_refresh_reports_stale_enrollment, remote_control_http_mode_refreshes_persisted_enrollment_before_connecting (+2 more)); 4 external calls (new, other, format!, info!).


##### `preview_remote_control_response_body`  (lines 350–368)

```
fn preview_remote_control_response_body(body: &[u8]) -> String
```

**Purpose**: Creates a safe, short preview of a backend response body for error messages. It helps developers diagnose backend problems without dumping huge responses or exposing secrets.

**Data flow**: It receives raw response bytes. It converts them to text, trims whitespace, returns `<empty>` if nothing remains, redacts sensitive JSON fields when possible, and truncates the result to a fixed maximum length without cutting through the middle of a character.

**Call relations**: HTTP-facing flows such as pairing, enrollment, client listing, client revocation, and websocket connection error formatting use this whenever they need to include a backend response body in an error. It delegates the secret-hiding step to `redact_remote_control_response_body`.

*Call graph*: calls 1 internal fn (redact_remote_control_response_body); called by 6 (list_remote_control_clients, revoke_remote_control_client, pairing_status, start_pairing, send_remote_control_server_request, format_remote_control_websocket_connect_error); 1 external calls (from_utf8_lossy).


##### `redact_remote_control_response_body`  (lines 370–387)

```
fn redact_remote_control_response_body(body: &str) -> String
```

**Purpose**: Hides secrets from a response body that looks like a JSON object. It protects fields such as server tokens and pairing codes before text is logged or returned in an error.

**Data flow**: It receives response text. If the text is valid JSON and the top-level value is an object, it replaces `remote_control_token`, `pairing_code`, and `manual_pairing_code` values with `<redacted>` and returns the JSON text. If the body is not such a JSON object, it returns the original text unchanged.

**Call relations**: `preview_remote_control_response_body` calls this as its redaction step. That keeps the sensitive-field knowledge in one small helper while the preview function focuses on trimming and length limits.

*Call graph*: called by 1 (preview_remote_control_response_body); 1 external calls (String).


##### `format_headers`  (lines 389–400)

```
fn format_headers(headers: &HeaderMap) -> String
```

**Purpose**: Extracts a small set of useful tracing headers from an HTTP response. These IDs help connect a local error to backend logs or Cloudflare request routing information.

**Data flow**: It receives an HTTP header map. It looks for a request ID header, falling back from `x-request-id` to `x-oai-request-id`, and also looks for `cf-ray`. Missing values become `<none>` and invalid text becomes `<invalid utf-8>`. It returns one compact string containing both values.

**Call relations**: `send_remote_control_server_request` uses this when building backend error messages, so a failed enrollment or refresh can be matched to server-side diagnostics.

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

**Purpose**: Registers this app server with the remote-control backend for the first time. It creates the server identity that later pairing and websocket flows rely on.

**Data flow**: It receives the target backend, connection authentication, installation ID, and desired server name. It builds an enrollment request containing the server name, operating system, CPU architecture, app-server version, and installation ID. It sends that request to the backend, receives server and environment IDs plus a temporary token, builds a `RemoteControlEnrollment`, stores the token and expiry on it, and returns the completed enrollment.

**Call relations**: Higher-level flows such as `enroll_pairing_server` and `enroll_and_persist_remote_control_server` call this when no reusable enrollment exists or a new enrollment is needed. It relies on `send_remote_control_server_request` for the HTTP exchange and `update_remote_control_server_token` to attach the returned temporary credential.

*Call graph*: calls 1 internal fn (update_remote_control_server_token); called by 3 (enroll_remote_control_server_parse_failure_includes_response_body, enroll_pairing_server, enroll_and_persist_remote_control_server); 2 external calls (clone, env!).


##### `refresh_remote_control_server`  (lines 443–480)

```
async fn refresh_remote_control_server(
    auth: &RemoteControlConnectionAuth,
    installation_id: &str,
    enrollment: &mut RemoteControlEnrollment,
) -> io::Result<()>
```

**Purpose**: Refreshes the temporary token for an existing remote-control enrollment. This lets the app keep using the same server identity without re-enrolling.

**Data flow**: It receives authentication, installation ID, and a mutable enrollment. It sends the current server ID and installation ID to the refresh URL, receives a fresh token and expiry, checks that the backend returned the same server and environment IDs, then updates the enrollment’s token fields. If the IDs do not match, it returns an error instead of silently changing identity.

**Call relations**: `refresh_pairing_enrollment` and `prepare_remote_control_enrollment` call this when the current token is missing or nearing expiry. It uses the shared server-request sender and then hands token parsing and storage to `update_remote_control_server_token`.

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

**Purpose**: Sends a JSON request to the remote-control backend for server enrollment-style operations and parses the JSON response. It centralizes the repeated HTTP behavior for enrolling and refreshing.

**Data flow**: It receives a URL, authentication, installation ID, request body, action name, and response label. It builds a client, adds authentication headers plus account and installation headers, posts the JSON request with a timeout, reads the response body, creates a safe body preview, turns non-success HTTP statuses into local errors, and parses a successful JSON body into the requested response type.

**Call relations**: Enrollment and refresh flows use this helper so they share the same timeout, headers, response parsing, and error format. It calls `format_headers` to include request tracing IDs and `preview_remote_control_response_body` so response snippets are safe to show.

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

**Purpose**: Stores a newly received temporary server token and its expiry time on an enrollment. It keeps token parsing in one place.

**Data flow**: It receives a mutable enrollment, the URL used for the backend call, a token string, and an expiry timestamp string. It parses the expiry as RFC 3339 date-time text, then writes the token and parsed expiry into the enrollment. If parsing fails, it returns an error that names the backend URL.

**Call relations**: `enroll_remote_control_server` calls this after first enrollment, and `refresh_remote_control_server` calls it after token refresh. Both flows depend on it to turn backend text into a usable expiry time.

*Call graph*: called by 2 (enroll_remote_control_server, refresh_remote_control_server); 1 external calls (parse).


##### `tests::remote_control_state_runtime`  (lines 575–579)

```
async fn remote_control_state_runtime(codex_home: &TempDir) -> Arc<StateRuntime>
```

**Purpose**: Creates a temporary state database runtime for tests. It gives persistence tests a real local database without touching a user’s actual data.

**Data flow**: It receives a temporary directory. It initializes `StateRuntime` rooted at that directory with a test provider name and returns it wrapped for shared use by async test code.

**Call relations**: The persistence tests call this before saving or loading enrollments. It keeps their setup short and consistent.

*Call graph*: calls 1 internal fn (init); 1 external calls (path).


##### `tests::remote_control_enrollment_refreshes_server_token_before_expiry`  (lines 582–601)

```
fn remote_control_enrollment_refreshes_server_token_before_expiry()
```

**Purpose**: Verifies the 30-second token refresh safety window. The test proves that a token expiring soon is considered stale while one expiring just later is still usable.

**Data flow**: It builds two nearly identical enrollments: one with a token expiring in 29 seconds and one expiring in 31 seconds. It calls `should_refresh_server_token` on both and checks that only the first asks for refresh.

**Call relations**: This test directly protects the behavior used by `start_pairing` and `pairing_status`, where using a token too close to expiry could make pairing unreliable.

*Call graph*: calls 1 internal fn (normalize_remote_control_url); 3 external calls (now_utc, assert!, seconds).


##### `tests::preview_remote_control_response_body_redacts_server_token`  (lines 604–617)

```
fn preview_remote_control_response_body_redacts_server_token()
```

**Purpose**: Checks that response previews hide sensitive remote-control fields. It makes sure error messages do not reveal tokens or pairing codes.

**Data flow**: It feeds a JSON response containing a server ID, token, pairing code, and manual pairing code into `preview_remote_control_response_body`. It parses the preview back as JSON and asserts that the sensitive fields were replaced with `<redacted>` while the server ID remained visible.

**Call relations**: This test protects the redaction path used by HTTP error reporting throughout this file and related remote-control client flows.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::persisted_remote_control_enrollment_round_trips_by_target_and_account`  (lines 620–701)

```
async fn persisted_remote_control_enrollment_round_trips_by_target_and_account()
```

**Purpose**: Proves that saved enrollments can be loaded again and are separated by backend target and account. This prevents one account or remote-control environment from accidentally reusing another’s server identity.

**Data flow**: It creates a temporary state database, two different remote-control targets, and two enrollment records for the same account. It saves both records, then loads by different target/account combinations and checks that the matching entries come back and a missing account returns `None`.

**Call relations**: The test uses `update_persisted_remote_control_enrollment` to write records and `load_persisted_remote_control_enrollment` to read them back. It supports the startup paths that reuse enrollment records.

*Call graph*: calls 2 internal fn (update_persisted_remote_control_enrollment, normalize_remote_control_url); 3 external calls (new, remote_control_state_runtime, assert_eq!).


##### `tests::clearing_persisted_remote_control_enrollment_removes_only_matching_entry`  (lines 704–785)

```
async fn clearing_persisted_remote_control_enrollment_removes_only_matching_entry()
```

**Purpose**: Verifies that clearing one persisted enrollment does not delete unrelated enrollments. This matters when the same machine may know about more than one remote-control backend target.

**Data flow**: It creates a temporary state database, saves two enrollments for different targets, then clears only the first target’s record. It loads both afterward and checks that the first is gone while the second is still present.

**Call relations**: The test exercises the delete branch of `update_persisted_remote_control_enrollment` and confirms that `load_persisted_remote_control_enrollment` still finds the untouched record.

*Call graph*: calls 2 internal fn (update_persisted_remote_control_enrollment, normalize_remote_control_url); 3 external calls (new, remote_control_state_runtime, assert_eq!).


##### `tests::enroll_remote_control_server_parse_failure_includes_response_body`  (lines 788–832)

```
async fn enroll_remote_control_server_parse_failure_includes_response_body()
```

**Purpose**: Checks that a malformed enrollment response produces an error containing the response body. This makes backend integration failures much easier to diagnose.

**Data flow**: It starts a tiny local TCP server, points a normalized remote-control target at it, and has the server return JSON that is missing required enrollment fields. It calls `enroll_remote_control_server`, expects parsing to fail, and compares the full error text to the expected message including the safe response body preview.

**Call relations**: This test drives the real enrollment path through `enroll_remote_control_server`. Its local server helpers, `accept_http_request` and `respond_with_json`, provide a controlled backend response.

*Call graph*: calls 2 internal fn (enroll_remote_control_server, normalize_remote_control_url); 8 external calls (bind, accept_http_request, respond_with_json, assert_eq!, unauthenticated_auth_provider, format!, json!, spawn).


##### `tests::accept_http_request`  (lines 834–858)

```
async fn accept_http_request(listener: &TcpListener) -> TcpStream
```

**Purpose**: Accepts one simple HTTP request in a test and returns the underlying socket so the test can write a response. It is a small stand-in for a backend server.

**Data flow**: It receives a TCP listener, waits up to five seconds for a connection, reads the request line and headers until the blank line that ends HTTP headers, and returns the stream positioned for writing a response.

**Call relations**: The parse-failure enrollment test uses this helper inside a spawned task before calling `respond_with_json`. It keeps the fake server just detailed enough for the HTTP client to talk to it.

*Call graph*: 5 external calls (new, from_secs, new, accept, timeout).


##### `tests::respond_with_json`  (lines 860–871)

```
async fn respond_with_json(mut stream: TcpStream, body: serde_json::Value)
```

**Purpose**: Writes a minimal HTTP JSON response to a test TCP stream. It lets tests control exactly what body the enrollment code receives.

**Data flow**: It receives a TCP stream and a JSON value. It converts the JSON to text, builds an HTTP 200 response with content type, content length, and connection-close headers, writes it to the stream, and flushes the bytes.

**Call relations**: The parse-failure enrollment test calls this after `accept_http_request` has captured the client connection. Together they simulate a backend response without running a full web server.

*Call graph*: 4 external calls (flush, write_all, to_string, format!).


### `app-server-transport/src/transport/remote_control/client_tracker.rs`

`io_transport` · `request handling, idle cleanup, and shutdown`

Remote-control clients talk to the app server through envelopes that include a client id, sometimes a stream id, and a JSON-RPC message. This file is the traffic clerk for those clients. When a client sends its first initialize message, ClientTracker creates a new internal connection, gives the rest of the transport layer a writer for replies, and starts a background task that forwards server replies back to that remote client.

It also protects the server from common connection problems. It ignores duplicate inbound messages once a sequence number has already been successfully delivered. It answers pings, marks active clients as alive, and can close clients that have been idle too long. It supports older clients that do not yet send stream ids by remembering a temporary stream id for them.

A key detail is how closing works. Normal events use a short timeout when sending into the transport queue, so a stuck queue does not freeze the tracker. But connection-closed events are treated carefully: they are spawned into their own task so cleanup can still reach the transport layer even if the caller is cancelled. Without this file, remote-control clients would not have stable connection identities, replies could not be routed back, duplicate retries could be mishandled, and dead clients might stay open forever.

#### Function details

##### `ClientTracker::new`  (lines 55–68)

```
fn new(
        server_event_tx: mpsc::Sender<QueuedServerEnvelope>,
        transport_event_tx: mpsc::Sender<TransportEvent>,
        shutdown_token: &CancellationToken,
    ) -> Self
```

**Purpose**: Creates an empty tracker ready to remember remote clients and forward their events. It also creates a child cancellation token, which is like giving the tracker its own off-switch connected to the larger server shutdown switch.

**Data flow**: It receives a sender for server-bound remote-control events, a sender for transport-layer events, and a shutdown token. It builds empty maps for clients and legacy stream ids, creates an empty task set for outbound forwarding tasks, and returns a new ClientTracker holding all of that.

**Call relations**: Tests call this to set up a tracker before simulating client messages. After construction, other methods such as handle_message, close_client, and shutdown use the stored senders and cancellation token to drive the client lifecycle.

*Call graph*: called by 11 (cancelled_outbound_task_emits_connection_closed, close_client_keeps_forwarding_after_caller_is_aborted, close_client_waits_for_transport_event_queue_capacity, incoming_message_timeout_does_not_advance_seq_id, initialize_timeout_closes_open_connection, initialize_with_new_stream_id_opens_new_connection_for_same_client, legacy_initialize_without_stream_id_resets_inbound_seq_id, non_close_transport_event_send_times_out_when_queue_stays_full, shutdown_cancels_blocked_outbound_forwarding, new (+1 more)); 3 external calls (child_token, new, new).


##### `ClientTracker::bookkeep_join_set`  (lines 70–78)

```
async fn bookkeep_join_set(&mut self) -> Option<(ClientId, StreamId)>
```

**Purpose**: Waits for one outbound client task to finish and reports which client stream ended. This lets the owner of the tracker notice when a background sender has stopped and then close the matching connection cleanly.

**Data flow**: It waits on the tracker’s JoinSet, which is a collection of background tasks. If a task finishes normally, it returns that task’s client id and stream id. If tasks fail internally, it skips them and keeps waiting; if there is nothing left, it waits forever rather than returning a misleading result.

**Call relations**: The outbound tasks are created by handle_message through run_client_outbound. A caller can use bookkeep_join_set after one of those tasks exits, then call close_client to send the final connection-closed event.

*Call graph*: 2 external calls (join_next, pending).


##### `ClientTracker::shutdown`  (lines 80–88)

```
async fn shutdown(&mut self)
```

**Purpose**: Stops the tracker and all clients it knows about. This is the orderly shutdown path for remote-control connections.

**Data flow**: It first cancels the tracker’s shutdown token, which tells child tasks to stop. Then it repeatedly picks remaining clients and closes them. Finally, it drains the task set so background outbound tasks have finished before shutdown completes.

**Call relations**: This method calls close_client for each known client and then drain_join_set. Tests use it to prove shutdown does not hang even when outbound forwarding is blocked.

*Call graph*: calls 2 internal fn (close_client, drain_join_set); 1 external calls (cancel).


##### `ClientTracker::drain_join_set`  (lines 90–92)

```
async fn drain_join_set(&mut self)
```

**Purpose**: Waits until all background outbound tasks have finished. It is a cleanup helper used during shutdown.

**Data flow**: It repeatedly waits for the next completed task in the JoinSet and discards the result. When no more tasks remain, it returns.

**Call relations**: shutdown calls this after cancelling and closing clients. It does not create or close clients itself; it only makes sure the spawned forwarding work has stopped.

*Call graph*: called by 1 (shutdown); 1 external calls (join_next).


##### `ClientTracker::handle_message`  (lines 94–242)

```
async fn handle_message(
        &mut self,
        client_envelope: ClientEnvelope,
    ) -> Result<(), Stopped>
```

**Purpose**: Processes one message envelope from a remote-control client. It decides whether to open a new connection, forward a client message, answer a ping, ignore a duplicate, or close a connection.

**Data flow**: It receives a ClientEnvelope containing the client id, optional stream id, optional sequence number, and event. It works out the effective stream id, including fallback behavior for older clients. For initialize messages, it may open a new connection, create a reply channel, spawn an outbound forwarding task, and forward the initialize JSON-RPC message inward. For later messages, it updates activity time and forwards them if they are new. For pings, it updates status or sends an unknown pong. For client-closed events, it closes the matching client.

**Call relations**: This is the main entry point used when remote-control input arrives. It calls close_client when a stream must be replaced or closed, send_transport_event when the app-server transport layer must be told something, record_inbound_message_delivery after successful delivery, remove_client for rollback after failed initialization, and spawn_connection_closed when cleanup must continue without blocking reconnects.

*Call graph*: calls 5 internal fn (close_client, record_inbound_message_delivery, remove_client, send_transport_event, spawn_connection_closed); 9 external calls (child_token, now, spawn, run_client_outbound, clone, matches!, next_connection_id, spawn, channel).


##### `ClientTracker::run_client_outbound`  (lines 244–290)

```
async fn run_client_outbound(
        client_id: ClientId,
        stream_id: StreamId,
        server_event_tx: mpsc::Sender<QueuedServerEnvelope>,
        mut writer_rx: mpsc::Receiver<QueuedOutgoin
```

**Purpose**: Runs the background loop that sends server replies and pong-status updates back to one remote-control client stream. It is the return lane for messages after a client connection has been opened.

**Data flow**: It receives a client id, stream id, a sender for queued server envelopes, a receiver for outgoing app-server messages, a receiver watching pong status, and a cancellation token. It waits for one of three things: cancellation, a server message to forward, or a pong status change. It wraps each outbound item in a server envelope with the right client and stream ids, sends it, and exits if cancellation or channel closure happens. When it exits, it returns the client id and stream id.

**Call relations**: handle_message spawns this when an initialize message opens a connection. bookkeep_join_set later observes its returned client key so the tracker owner can clean up the connection.

*Call graph*: 1 external calls (select!).


##### `ClientTracker::close_expired_clients`  (lines 292–307)

```
async fn close_expired_clients(
        &mut self,
    ) -> Result<Vec<(ClientId, StreamId)>, Stopped>
```

**Purpose**: Finds clients that have been quiet for too long and closes them. This prevents abandoned remote-control sessions from staying open forever.

**Data flow**: It reads the current time, checks every stored client’s last activity time, collects the client-stream keys that are older than the idle timeout, and closes each one. It returns the list of client streams it closed, or an error if sending a close event fails.

**Call relations**: An idle-sweep loop elsewhere can call this periodically. It relies on remote_control_client_is_alive to decide who is still active and calls close_client to do the actual shutdown work.

*Call graph*: calls 1 internal fn (close_client); 1 external calls (now).


##### `ClientTracker::close_client`  (lines 309–321)

```
async fn close_client(
        &mut self,
        client_key: &(ClientId, StreamId),
    ) -> Result<(), Stopped>
```

**Purpose**: Closes one tracked client stream if it exists. It removes the client from the tracker, tells its outbound task to stop, and notifies the transport layer that the connection is closed.

**Data flow**: It receives a client id and stream id pair. If no such client is stored, it returns successfully without changing anything. If found, it removes the client state, cancels that client’s disconnect token, and sends a ConnectionClosed transport event for the stored connection id.

**Call relations**: handle_message calls this for explicit client closes or reconnects on the same stream. close_expired_clients calls it for idle clients, and shutdown calls it for every remaining client.

*Call graph*: calls 2 internal fn (remove_client, send_transport_event); called by 3 (close_expired_clients, handle_message, shutdown).


##### `ClientTracker::remove_client`  (lines 323–333)

```
fn remove_client(&mut self, client_key: &(ClientId, StreamId)) -> Option<ClientState>
```

**Purpose**: Deletes a client stream from the tracker’s internal records. It also cleans up the legacy stream-id shortcut if that shortcut pointed to the removed stream.

**Data flow**: It receives a client id and stream id pair. It removes the matching ClientState from the clients map. If the legacy-stream map for that client points to the same stream, it removes that legacy entry too. It returns the removed state, or nothing if the client was not known.

**Call relations**: close_client uses this as the first step of normal closure. handle_message also uses it during initialization rollback if a newly opened connection cannot receive its first message.

*Call graph*: called by 2 (close_client, handle_message).


##### `ClientTracker::send_transport_event`  (lines 335–367)

```
async fn send_transport_event(&self, event: TransportEvent) -> Result<(), Stopped>
```

**Purpose**: Sends an event to the app-server transport layer, with safeguards so a stuck receiver does not block most remote-control work forever. Connection-closed events get special treatment because cleanup must be reliable.

**Data flow**: It receives a TransportEvent. If it is ConnectionClosed, it hands it to send_connection_closed. For other events, it names the event for logging, tries to send it through the transport-event channel, and waits only up to a fixed timeout. It returns success if the event is accepted, or Stopped if the receiver is gone or the timeout expires.

**Call relations**: handle_message uses this when opening connections and forwarding inbound client messages. close_client uses it when reporting closure. It calls transport_event_name for clearer warning logs and send_connection_closed for close events.

*Call graph*: calls 2 internal fn (send_connection_closed, transport_event_name); called by 2 (close_client, handle_message); 3 external calls (send, timeout, warn!).


##### `ClientTracker::record_inbound_message_delivery`  (lines 369–380)

```
fn record_inbound_message_delivery(
        &mut self,
        client_key: &(ClientId, StreamId),
        seq_id: Option<u64>,
    )
```

**Purpose**: Remembers the latest inbound sequence number only after the message has actually reached the app-server transport layer. This avoids treating a failed delivery as if it had succeeded.

**Data flow**: It receives a client stream key and an optional sequence number. If a sequence number is present and the client is still tracked, it stores that number as the latest delivered inbound message for that client.

**Call relations**: handle_message calls this after send_transport_event succeeds for a client message. Later calls to handle_message use the stored number to ignore duplicate retries.

*Call graph*: called by 1 (handle_message).


##### `ClientTracker::send_connection_closed`  (lines 382–395)

```
async fn send_connection_closed(&self, connection_id: ConnectionId) -> Result<(), Stopped>
```

**Purpose**: Forwards a connection-closed event in a way that survives caller cancellation. Closing is cleanup, so the code tries harder to deliver it than ordinary messages.

**Data flow**: It receives a connection id, starts a separate task to send the close event, and waits for that task’s result. If the spawned task succeeds, it returns that result. If the task itself fails, it logs a warning and reports Stopped.

**Call relations**: send_transport_event calls this whenever the event is ConnectionClosed. This method delegates the actual sending to spawn_connection_closed.

*Call graph*: calls 1 internal fn (spawn_connection_closed); called by 1 (send_transport_event); 1 external calls (warn!).


##### `ClientTracker::spawn_connection_closed`  (lines 397–418)

```
fn spawn_connection_closed(
        &self,
        connection_id: ConnectionId,
    ) -> JoinHandle<Result<(), Stopped>>
```

**Purpose**: Starts a detached task that sends a ConnectionClosed event to the transport layer. This lets close delivery continue even if the original caller is aborted.

**Data flow**: It receives a connection id, clones the transport-event sender, logs what it is doing, and spawns an async task. That task sends the ConnectionClosed event and returns success or Stopped if the receiver has disappeared.

**Call relations**: send_connection_closed uses this for normal close-event delivery. handle_message also uses it during initialization rollback, where the first message could not be forwarded and the code must close the just-opened connection without blocking a reconnect.

*Call graph*: called by 2 (handle_message, send_connection_closed); 3 external calls (clone, info!, spawn).


##### `transport_event_name`  (lines 421–427)

```
fn transport_event_name(event: &TransportEvent) -> &'static str
```

**Purpose**: Turns a transport event into a short text label for logs. This makes warnings easier to read without printing the whole event.

**Data flow**: It receives a reference to a TransportEvent and matches its variant. It returns one of the fixed strings: connection_opened, connection_closed, or incoming_message.

**Call relations**: send_transport_event calls this before attempting a timed send, so timeout and receiver-dropped warnings can say which kind of event failed.

*Call graph*: called by 1 (send_transport_event).


##### `remote_control_message_starts_connection`  (lines 429–435)

```
fn remote_control_message_starts_connection(message: &JSONRPCMessage) -> bool
```

**Purpose**: Checks whether a JSON-RPC message is the initialize request that begins a remote-control connection. The tracker uses this as the doorway for creating new connections.

**Data flow**: It receives a JSON-RPC message. It returns true only when the message is a request whose method name is exactly initialize; all notifications, responses, and other request methods return false.

**Call relations**: handle_message uses this decision to tell a first connection-opening message apart from ordinary later messages.

*Call graph*: 1 external calls (matches!).


##### `remote_control_client_is_alive`  (lines 437–439)

```
fn remote_control_client_is_alive(client: &ClientState, now: Instant) -> bool
```

**Purpose**: Decides whether a client has been active recently enough to keep. It is the small rule behind idle-client cleanup.

**Data flow**: It receives a client state and the current time. It compares now with the client’s last activity time and returns true if the gap is less than the remote-control idle timeout.

**Call relations**: close_expired_clients uses this helper while scanning the clients map, then closes any client for which this returns false.

*Call graph*: 1 external calls (duration_since).


##### `tests::initialize_envelope`  (lines 455–457)

```
fn initialize_envelope(client_id: &str) -> ClientEnvelope
```

**Purpose**: Builds a test client envelope containing an initialize request without a stream id. It represents the older client behavior that the tracker still supports.

**Data flow**: It receives a client id string and passes it to initialize_envelope_with_stream_id with no stream id. The result is a ready-to-send ClientEnvelope for tests.

**Call relations**: Several tests use this helper when they want to exercise the legacy stream-id path instead of the newer explicit stream-id path.

*Call graph*: 1 external calls (initialize_envelope_with_stream_id).


##### `tests::initialize_envelope_with_stream_id`  (lines 459–482)

```
fn initialize_envelope_with_stream_id(
        client_id: &str,
        stream_id: Option<&str>,
    ) -> ClientEnvelope
```

**Purpose**: Builds a test client envelope containing an initialize request, optionally with a stream id. This gives tests a consistent way to open simulated remote-control connections.

**Data flow**: It receives a client id string and an optional stream id string. It creates a JSON-RPC initialize request with sample client information, wraps it as a ClientMessage event, adds the ids and sequence number, and returns the ClientEnvelope.

**Call relations**: The test cases call this before passing the envelope to ClientTracker::handle_message. It is the shared setup for both modern stream-id tests and legacy fallback tests.

*Call graph*: 4 external calls (Request, Integer, new, json!).


##### `tests::initialized_notification`  (lines 484–489)

```
fn initialized_notification() -> JSONRPCMessage
```

**Purpose**: Creates a simple JSON-RPC initialized notification for tests. This is used as a normal follow-up message after initialization.

**Data flow**: It takes no input. It returns a JSON-RPC notification whose method is initialized and whose parameters are absent.

**Call relations**: Tests use this helper when they need a harmless inbound message to fill queues, retry delivery, or check sequence-number behavior.

*Call graph*: 1 external calls (Notification).


##### `tests::cancelled_outbound_task_emits_connection_closed`  (lines 492–549)

```
async fn cancelled_outbound_task_emits_connection_closed()
```

**Purpose**: Verifies that when an outbound client task is cancelled, the tracker can notice it and emit a connection-closed event. This protects cleanup for externally cancelled client streams.

**Data flow**: The test creates channels and a tracker, sends an initialize envelope, reads the connection-opened and incoming-message events, cancels the disconnect token, waits for bookkeep_join_set to report the ended client, calls close_client, and checks that the matching connection-closed event appears.

**Call relations**: It exercises ClientTracker::new, handle_message, bookkeep_join_set, and close_client together. It proves the background outbound task’s returned client key is enough to drive final closure.

*Call graph*: calls 1 internal fn (new); 7 external calls (new, from_secs, initialize_envelope, assert_eq!, channel, panic!, timeout).


##### `tests::shutdown_cancels_blocked_outbound_forwarding`  (lines 552–606)

```
async fn shutdown_cancels_blocked_outbound_forwarding()
```

**Purpose**: Verifies shutdown does not hang when an outbound server-event queue is already full. This matters because shutdown must be able to stop even under backpressure, meaning when a queue cannot accept more messages.

**Data flow**: The test fills a small server-event queue, opens a client, sends an outgoing message through the writer, and then calls shutdown with a timeout. The expected result is that shutdown completes instead of waiting forever for queue space.

**Call relations**: It uses ClientTracker::new, handle_message, the outbound task started by handle_message, and ClientTracker::shutdown. The test confirms shutdown cancellation reaches run_client_outbound.

*Call graph*: calls 2 internal fn (new, new); 10 external calls (new, from_secs, ConfigWarning, AppServerNotification, initialize_envelope, new, new, channel, panic!, timeout).


##### `tests::non_close_transport_event_send_times_out_when_queue_stays_full`  (lines 609–631)

```
async fn non_close_transport_event_send_times_out_when_queue_stays_full()
```

**Purpose**: Checks that ordinary transport events fail with a timeout when the transport-event queue remains full. This prevents remote-control message handling from freezing indefinitely.

**Data flow**: The test creates a transport-event channel with capacity one, fills it, then asks the tracker to send an IncomingMessage event. Because nothing drains the queue, the send times out and the test expects an error.

**Call relations**: It uses ClientTracker::new and send_transport_event directly. It focuses on the timeout path for non-close events.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, initialized_notification, assert!, channel, next_connection_id).


##### `tests::incoming_message_timeout_does_not_advance_seq_id`  (lines 634–693)

```
async fn incoming_message_timeout_does_not_advance_seq_id()
```

**Purpose**: Verifies that a failed inbound-message delivery does not mark its sequence number as delivered. This allows a client retry to be accepted later.

**Data flow**: The test opens a client with a stream id, fills the transport-event queue so a follow-up message times out, and confirms handle_message returns an error. After draining the queue, it sends the same envelope again and expects the message to be forwarded successfully with the original connection id.

**Call relations**: It exercises handle_message, send_transport_event, and record_inbound_message_delivery. The test proves sequence-number deduplication only advances after successful forwarding.

*Call graph*: calls 1 internal fn (new); 10 external calls (new, initialize_envelope_with_stream_id, initialized_notification, new, new, assert!, assert_eq!, channel, panic!, next_connection_id).


##### `tests::initialize_timeout_closes_open_connection`  (lines 696–730)

```
async fn initialize_timeout_closes_open_connection()
```

**Purpose**: Verifies that if opening a connection succeeds but forwarding the initialize message times out, the newly opened connection is closed. This prevents half-open connections from being left behind.

**Data flow**: The test uses a tiny transport-event queue and starts handle_message for an initialize envelope. It expects the operation to return an error quickly, then reads a connection-opened event followed by a connection-closed event with the same connection id.

**Call relations**: It exercises the rollback path inside handle_message, including remove_client and spawn_connection_closed. The test checks that rollback does not wait forever for close delivery.

*Call graph*: calls 1 internal fn (new); 7 external calls (new, initialize_envelope_with_stream_id, assert!, assert_eq!, channel, panic!, spawn).


##### `tests::close_client_waits_for_transport_event_queue_capacity`  (lines 733–795)

```
async fn close_client_waits_for_transport_event_queue_capacity()
```

**Purpose**: Checks that closing a client waits for room in the transport-event queue when needed. Unlike ordinary events, close events are allowed to wait so cleanup is delivered.

**Data flow**: The test opens a client, fills the transport-event queue with incoming messages, then starts close_client and confirms it does not finish while the queue is full. After draining the queued messages, close_client completes and the test receives the expected ConnectionClosed event.

**Call relations**: It uses ClientTracker::new, handle_message, and close_client. It proves the special connection-closed path waits for queue capacity instead of using the short timeout for ordinary events.

*Call graph*: calls 1 internal fn (new); 10 external calls (new, initialize_envelope_with_stream_id, initialized_notification, new, new, assert!, assert_eq!, channel, panic!, pin!).


##### `tests::close_client_keeps_forwarding_after_caller_is_aborted`  (lines 798–856)

```
async fn close_client_keeps_forwarding_after_caller_is_aborted()
```

**Purpose**: Verifies that a connection-closed event still gets delivered even if the task that called close_client is aborted. This protects cleanup during abrupt task cancellation.

**Data flow**: The test opens a client, fills the transport-event queue, starts close_client in a spawned task, then aborts that task while it is blocked. After draining the queue, it still receives the ConnectionClosed event with the right connection id.

**Call relations**: It exercises close_client, send_connection_closed, and spawn_connection_closed. The test confirms the detached close-forwarding task does the important cleanup independently of its caller.

*Call graph*: calls 1 internal fn (new); 12 external calls (new, from_secs, initialize_envelope_with_stream_id, initialized_notification, new, new, assert!, assert_eq!, channel, panic! (+2 more)).


##### `tests::initialize_with_new_stream_id_opens_new_connection_for_same_client`  (lines 859–892)

```
async fn initialize_with_new_stream_id_opens_new_connection_for_same_client()
```

**Purpose**: Checks that the same client id can open separate connections when it uses different stream ids. This supports multiple streams from one remote-control client.

**Data flow**: The test sends one initialize envelope for client-1 on stream-1 and reads its connection id. It then sends another initialize envelope for client-1 on stream-2 and reads a second connection id. The test expects the two ids to be different.

**Call relations**: It uses ClientTracker::new and handle_message with explicit stream ids. It confirms the tracker keys clients by both client id and stream id, not just by client id.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, initialize_envelope_with_stream_id, assert_ne!, channel, panic!).


##### `tests::legacy_initialize_without_stream_id_resets_inbound_seq_id`  (lines 895–937)

```
async fn legacy_initialize_without_stream_id_resets_inbound_seq_id()
```

**Purpose**: Checks legacy behavior for clients that do not send stream ids. It ensures an initialize without a stream id creates a usable remembered stream for later messages from the same client.

**Data flow**: The test opens a client using an initialize envelope with no stream id, reads the connection-opened and initialize events, then sends a follow-up initialized notification also without a stream id. It expects that follow-up to be forwarded on the same connection.

**Call relations**: It uses ClientTracker::new, initialize_envelope, and handle_message. The test proves the legacy stream-id map lets older clients continue a session after initialization.

*Call graph*: calls 1 internal fn (new); 7 external calls (new, Notification, initialize_envelope, new, assert_eq!, channel, panic!).


### `app-server-transport/src/transport/remote_control/websocket.rs`

`io_transport` · `startup, main loop, connection handling, reconnects, shutdown`

Remote control is the bridge between this app server and clients that are somewhere else. A WebSocket is a long-lived network connection, like a phone line left open, so both sides can talk without creating a new connection for every message. This file owns that phone line.

At startup it builds a RemoteControlWebsocket with shared state, authentication, enrollment records, and channels for server events. Its main run loop waits until remote control is enabled, makes sure the server is enrolled with the remote service, connects, and then starts two workers: one writes outgoing server messages to the socket, and one reads incoming client messages from it.

The writer gives each outgoing stream a sequence number, splits large messages into transport-sized pieces, keeps unacknowledged messages in a bounded buffer, and sends periodic ping frames to check that the connection is alive. The reader parses incoming JSON, reassembles split client messages, drops duplicates or oversized pieces, passes valid messages to the client tracker, and clears state when clients close or go idle.

The file is careful about recovery. If authentication changes, enrollment is stale, the server token is rejected, or the WebSocket fails, it updates status and reconnects with backoff instead of spinning. Without this file, remote-control clients could not reliably reach the app server, and reconnects could lose or duplicate in-flight messages.

#### Function details

##### `BoundedOutboundBuffer::new`  (lines 93–100)

```
fn new() -> (Self, watch::Receiver<usize>)
```

**Purpose**: Creates an empty holding area for outgoing messages that have been sent but not yet acknowledged by the remote client. It also creates a small status feed that reports how many messages are currently waiting.

**Data flow**: It starts with no inputs beyond construction → creates an empty map of per-client/per-stream message queues and a watch channel set to zero → returns the buffer and a receiver that other tasks can watch for usage changes.

**Call relations**: RemoteControlWebsocket::new uses this when building the shared WebSocket state. Several tests also create one directly to check acknowledgement and writer behavior.

*Call graph*: called by 17 (new, outbound_buffer_acks_by_stream_id, outbound_buffer_advances_segmented_acks_by_wire_cursor, outbound_buffer_retains_unacked_messages_until_ack_advances, outbound_buffer_treats_segmentless_acks_as_seq_level_acks, run_server_writer_inner_assigns_contiguous_seq_ids_per_stream, run_server_writer_inner_sends_periodic_ping_frames, run_websocket_reader_inner_times_out_without_pong_frames, websocket_state_allows_replay_after_later_chunk_drops, websocket_state_allows_replay_after_rejected_out_of_order_chunk (+7 more)); 2 external calls (new, channel).


##### `BoundedOutboundBuffer::insert`  (lines 102–111)

```
fn insert(&mut self, server_envelope: &ServerEnvelope)
```

**Purpose**: Stores a copy of an outgoing server message until the client confirms it received it. This protects messages across reconnects.

**Data flow**: A server envelope comes in → it is grouped by client id and stream id, appended to that stream’s queue, and the used-count is increased → the buffer now remembers one more unacknowledged message.

**Call relations**: The server writer calls this after preparing a message for the wire, so later acknowledgements can remove it.

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

**Purpose**: Removes messages that the remote client says it has received. It understands both whole-message acknowledgements and acknowledgements for split message segments.

**Data flow**: A client id, stream id, acknowledged sequence number, and optional segment number come in → matching buffered messages at or before that cursor are removed and the used-count is decreased → only still-unconfirmed messages remain.

**Call relations**: WebsocketState::record_client_message_delivery calls this when it sees an Ack event from the client.

*Call graph*: called by 1 (record_client_message_delivery); 2 external calls (clone, clone).


##### `BoundedOutboundBuffer::server_envelopes`  (lines 141–145)

```
fn server_envelopes(&self) -> impl Iterator<Item = &ServerEnvelope>
```

**Purpose**: Lets the writer inspect all currently unacknowledged outgoing messages. This is used to resend them after a reconnect.

**Data flow**: It reads the buffer’s per-stream queues → flattens them into one iterator → returns references to the stored server envelopes without changing the buffer.

**Call relations**: The server writer uses this at the start of a connection to replay messages that were sent before but not yet acknowledged.


##### `WebsocketState::observe_client_message`  (lines 157–200)

```
fn observe_client_message(
        &mut self,
        client_envelope: ClientEnvelope,
        wire_size_bytes: usize,
    ) -> ClientSegmentObservation
```

**Purpose**: Checks an incoming client message before the rest of the system sees it. It drops duplicates, rejects oversized split-message chunks, and reassembles chunks into a complete client message when possible.

**Data flow**: A client envelope and its wire size come in → the function identifies whether it is part of a split message, compares it with remembered completed chunks, consults the reassembler, and may invalidate bad state → it returns an observation saying to forward, wait for more chunks, or drop it.

**Call relations**: The WebSocket reader calls this for every incoming text message before handing anything to the client tracker.

*Call graph*: calls 3 internal fn (invalidate_stream, observe, should_ignore_chunk); called by 1 (observe_client_message); 2 external calls (client_message_key, warn!).


##### `WebsocketState::record_client_message_delivery`  (lines 202–225)

```
fn record_client_message_delivery(
        &mut self,
        client_envelope: &ClientEnvelope,
        client_message_key: Option<((ClientId, Option<StreamId>), u64)>,
    )
```

**Purpose**: Records that a client message was successfully delivered to the client tracker. This is the point where cursors, completed chunk tracking, and acknowledgements become official.

**Data flow**: A delivered client envelope and optional message key come in → it saves the subscribe cursor, remembers completed split-message sequence ids, and applies Ack events to the outbound buffer → internal state now reflects what has safely been processed.

**Call relations**: The WebSocket reader calls this only after the client tracker accepts a message, so duplicate protection does not hide messages that were never delivered.

*Call graph*: calls 1 internal fn (ack).


##### `WebsocketState::invalidate_client_message_stream`  (lines 227–230)

```
fn invalidate_client_message_stream(&mut self, client_id: &ClientId, stream_id: &StreamId)
```

**Purpose**: Forgets duplicate-protection state for one client stream. This lets a new stream reuse sequence numbers safely after the old one closes or is discarded.

**Data flow**: A client id and stream id come in → the matching completed-chunk cursor is removed → later chunks on that stream are treated as fresh.

**Call relations**: The WebSocket reader uses this when a stream is closed, expires, or is invalidated by the client tracker.

*Call graph*: 2 external calls (clone, clone).


##### `WebsocketState::invalidate_client_message_client`  (lines 232–235)

```
fn invalidate_client_message_client(&mut self, client_id: &ClientId)
```

**Purpose**: Forgets duplicate-protection state for all streams belonging to one client. This is used when the whole client, not just one stream, is gone.

**Data flow**: A client id comes in → all stored completed-chunk cursors for that client are removed → future messages from that client are not blocked by old history.

**Call relations**: The WebSocket reader uses this after a client-level close event.


##### `WebsocketState::client_message_key`  (lines 237–251)

```
fn client_message_key(
        client_envelope: &ClientEnvelope,
    ) -> Option<((ClientId, Option<StreamId>), u64)>
```

**Purpose**: Builds the small identity key used to track split client messages. Only chunked client messages with sequence numbers need this key.

**Data flow**: A client envelope comes in → if it is a ClientMessageChunk with a sequence id, the function combines client id, optional stream id, and sequence id → otherwise it returns nothing.

**Call relations**: The WebSocket reader uses this before validation, and WebsocketState uses the same idea to decide whether a chunk is stale or duplicate.

*Call graph*: called by 1 (run_websocket_reader_inner).


##### `RemoteControlStatusPublisher::new`  (lines 323–325)

```
fn new(tx: watch::Sender<RemoteControlStatusChangedNotification>) -> Self
```

**Purpose**: Wraps a status watch channel in a small publisher object. Other code uses this object to report connection and environment changes.

**Data flow**: A watch sender comes in → it is stored inside the publisher → callers get a cloneable object that can publish status updates.

**Call relations**: Startup code and tests create this before constructing the WebSocket loop.

*Call graph*: called by 4 (enable, start_remote_control, plain_start_resolves_persisted_remote_control_preference, remote_control_status_channel).


##### `RemoteControlStatusPublisher::status`  (lines 327–329)

```
fn status(&self) -> RemoteControlStatusChangedNotification
```

**Purpose**: Returns the latest remote-control status snapshot. This is mainly used for logging and decisions around connection state.

**Data flow**: It reads the current value from the watch channel → clones it → returns the snapshot without changing the channel.

**Call relations**: RemoteControlWebsocket::run checks this around connection attempts and shutdown logging.

*Call graph*: called by 1 (run); 1 external calls (borrow).


##### `RemoteControlStatusPublisher::publish_status`  (lines 331–355)

```
fn publish_status(&self, connection_status: RemoteControlConnectionStatus)
```

**Purpose**: Publishes a new connection status, such as connecting, connected, errored, or disabled. It avoids sending duplicate notifications when nothing actually changed.

**Data flow**: A connection status comes in → it is merged into the existing status notification while preserving fields like server name and installation id → if the result differs, subscribers are notified and a log entry is written.

**Call relations**: RemoteControlWebsocket::connect and RemoteControlWebsocket::run call this as the connection moves through its lifecycle.

*Call graph*: called by 2 (connect, run); 2 external calls (send_if_modified, info!).


##### `RemoteControlStatusPublisher::publish_environment_id`  (lines 357–387)

```
fn publish_environment_id(&self, environment_id: Option<String>)
```

**Purpose**: Updates the environment id shown in remote-control status. It deliberately does not change the environment id while the feature is disabled.

**Data flow**: An optional environment id comes in → if status is not Disabled, the id is folded into the current notification → subscribers are notified only when the visible status changed.

**Call relations**: Enrollment preparation and enrollment creation call this when they learn or clear the remote environment.

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

**Purpose**: Builds the long-running WebSocket controller and all of its shared helper objects. This is the setup step before the remote-control loop can run.

**Data flow**: Configuration, state storage, authentication, channels, shutdown token, and desired-state sender come in → it creates event channels, a client tracker, outbound buffer, shared WebSocket state, and auth watchers → returns a ready-to-run RemoteControlWebsocket.

**Call relations**: Remote-control startup code calls this, then calls RemoteControlWebsocket::run to begin the loop.

*Call graph*: calls 2 internal fn (new, new); called by 3 (start_remote_control, plain_start_resolves_persisted_remote_control_preference, run_remote_control_websocket_loop_shutdown_cancels_reconnect_backoff); 6 external calls (new, child_token, new, new, default, channel).


##### `RemoteControlWebsocket::run`  (lines 455–557)

```
async fn run(
        mut self,
        app_server_client_name_rx: Option<oneshot::Receiver<String>>,
    )
```

**Purpose**: Runs the top-level remote-control loop. It waits for required identity information, resolves whether remote control should be enabled, connects when allowed, reconnects after failures, and shuts down cleanly.

**Data flow**: The constructed WebSocket object and optional app-server client-name receiver come in → the loop waits, resolves state, repeatedly connects and runs a connection, and watches for disable or shutdown → it ends by shutting down the client tracker.

**Call relations**: This is the main driver for the file. It calls the wait, preference-resolution, connect, and per-connection worker orchestration functions.

*Call graph*: calls 7 internal fn (publish_status, status, connect, resolve_unknown_desired_state, run_connection, wait_for_app_server_client_name, wait_until_enabled); 5 external calls (child_token, send_replace, info!, matches!, warn!).


##### `RemoteControlWebsocket::wait_for_app_server_client_name`  (lines 559–575)

```
async fn wait_for_app_server_client_name(
        &self,
        app_server_client_name_rx: Option<oneshot::Receiver<String>>,
    ) -> Result<Option<String>, ()>
```

**Purpose**: Waits for the app-server client name if one is expected. It stops waiting if shutdown happens first.

**Data flow**: An optional one-shot receiver comes in → if present, the function waits for either the name or cancellation; if absent, it immediately succeeds with no name → returns the optional name or an error signal.

**Call relations**: RemoteControlWebsocket::run calls this before resolving persisted remote-control preferences or connecting.

*Call graph*: called by 1 (run); 1 external calls (select!).


##### `RemoteControlWebsocket::resolve_unknown_desired_state`  (lines 577–643)

```
async fn resolve_unknown_desired_state(
        &mut self,
        app_server_client_name: Option<&str>,
    ) -> bool
```

**Purpose**: Decides what to do when remote-control preference starts as Unknown. It looks at saved enrollment data and authentication to choose Enabled or Disabled.

**Data flow**: The optional app-server client name comes in → the URL is normalized, authentication and state storage are checked, and persisted enrollment is read with retries → the desired-state watch is updated from Unknown to the resolved state.

**Call relations**: RemoteControlWebsocket::run calls this once near startup if the current desired state has not yet been resolved.

*Call graph*: calls 5 internal fn (load_remote_control_auth, desired_state_from_persisted_enrollment, normalize_remote_control_url, transition_unknown_to, wait_for_preference_resolution_retry); called by 1 (run); 3 external calls (info!, matches!, warn!).


##### `RemoteControlWebsocket::transition_unknown_to`  (lines 645–653)

```
fn transition_unknown_to(&self, desired_state: RemoteControlDesiredState)
```

**Purpose**: Changes desired state from Unknown to a concrete state, but only if nobody else already changed it. This prevents overwriting newer decisions.

**Data flow**: A desired state comes in → the watch sender is edited only when the current value is still Unknown → subscribers see the new state if the transition happened.

**Call relations**: RemoteControlWebsocket::resolve_unknown_desired_state uses this for safe one-way preference resolution.

*Call graph*: called by 1 (resolve_unknown_desired_state).


##### `RemoteControlWebsocket::wait_for_preference_resolution_retry`  (lines 655–661)

```
async fn wait_for_preference_resolution_retry(&mut self) -> bool
```

**Purpose**: Waits briefly before retrying preference resolution, while still reacting quickly to shutdown or desired-state changes.

**Data flow**: It watches shutdown, desired-state changes, and a short sleep → returns false if the loop should stop, true if retrying is still appropriate.

**Call relations**: RemoteControlWebsocket::resolve_unknown_desired_state calls this after temporary authentication or database failures.

*Call graph*: called by 1 (resolve_unknown_desired_state); 1 external calls (select!).


##### `RemoteControlWebsocket::wait_until_enabled`  (lines 663–668)

```
async fn wait_until_enabled(&mut self) -> bool
```

**Purpose**: Pauses the main loop until remote control is enabled. It also exits if the system is shutting down or the desired-state channel closes.

**Data flow**: It reads the shutdown token and desired-state receiver → waits for an enabled value unless cancellation wins → returns whether the loop should proceed.

**Call relations**: RemoteControlWebsocket::run calls this before every connection cycle.

*Call graph*: called by 1 (run); 1 external calls (select!).


##### `RemoteControlWebsocket::connect`  (lines 670–830)

```
async fn connect(
        &mut self,
        shutdown_token: &CancellationToken,
        app_server_client_name: Option<&str>,
    ) -> ConnectOutcome
```

**Purpose**: Attempts to establish a remote-control WebSocket connection, including URL validation, enrollment, authentication, retry timing, and status updates.

**Data flow**: The shutdown token and optional app-server client name come in → the function prepares connection options, calls the lower-level connector, handles errors, auth changes, disabling, and backoff → returns Connected, Disabled, or Shutdown.

**Call relations**: RemoteControlWebsocket::run calls this for each connection cycle. It delegates the actual handshake and enrollment work to connect_remote_control_websocket.

*Call graph*: calls 3 internal fn (normalize_remote_control_url, publish_status, next_reconnect_delay); called by 1 (run); 8 external calls (new, snapshot, Connected, borrow, clone, info!, select!, warn!).


##### `RemoteControlWebsocket::run_connection`  (lines 832–875)

```
async fn run_connection(
        &self,
        websocket_connection: WebSocketStream<MaybeTlsStream<TcpStream>>,
        shutdown_token: CancellationToken,
    ) -> ConnectionEndReason
```

**Purpose**: Runs one live WebSocket connection by splitting it into a writer task and a reader task. It stops both when shutdown, disablement, or worker failure occurs.

**Data flow**: A connected WebSocket and cancellation token come in → the socket is split into read and write halves, two tasks are spawned, and the function waits for the first stop condition → workers are cancelled and joined, then an end reason is returned.

**Call relations**: RemoteControlWebsocket::run calls this after a successful connect. It starts run_server_writer and run_websocket_reader.

*Call graph*: called by 1 (run); 9 external calls (cancel, clone, join_connection_workers, run_server_writer, run_websocket_reader, split, clone, select!, new).


##### `RemoteControlWebsocket::join_connection_workers`  (lines 877–895)

```
async fn join_connection_workers(
        join_set: &mut tokio::task::JoinSet<()>,
        shutdown_timeout: std::time::Duration,
    )
```

**Purpose**: Waits for connection worker tasks to finish, but does not wait forever. If they are stuck, it aborts them.

**Data flow**: A join set and timeout come in → the function tries to drain finished tasks within the timeout → if time runs out, it logs, aborts remaining tasks, and drains again.

**Call relations**: RemoteControlWebsocket::run_connection uses this during connection teardown; a test verifies stuck workers are aborted.

*Call graph*: called by 1 (join_connection_workers_aborts_stuck_worker_after_timeout); 4 external calls (abort_all, drain_join_set, timeout, warn!).


##### `RemoteControlWebsocket::drain_join_set`  (lines 897–899)

```
async fn drain_join_set(join_set: &mut tokio::task::JoinSet<()>)
```

**Purpose**: Consumes all completed task results from a task set until it is empty. It is a cleanup helper.

**Data flow**: A mutable join set comes in → it repeatedly awaits the next task result → when no tasks remain, it returns with no output.

**Call relations**: RemoteControlWebsocket::join_connection_workers uses this before and after aborting tasks.

*Call graph*: 1 external calls (join_next).


##### `RemoteControlWebsocket::run_server_writer`  (lines 901–926)

```
async fn run_server_writer(
        state: Arc<Mutex<WebsocketState>>,
        server_event_rx: Arc<Mutex<mpsc::Receiver<super::QueuedServerEnvelope>>>,
        used_rx: watch::Receiver<usize>,
```

**Purpose**: Wraps the server-writer loop and logs whether it stopped normally or because the WebSocket broke. It is the task entry point for outgoing traffic.

**Data flow**: Shared state, the queued server-event receiver, buffer usage receiver, socket writer, ping interval, and shutdown token come in → it runs the inner writer → it logs success or error.

**Call relations**: RemoteControlWebsocket::run_connection spawns this task for each active connection.

*Call graph*: 2 external calls (run_server_writer_inner, warn!).


##### `RemoteControlWebsocket::run_server_writer_inner`  (lines 932–1064)

```
async fn run_server_writer_inner(
        state: Arc<Mutex<WebsocketState>>,
        server_event_rx: Arc<Mutex<mpsc::Receiver<super::QueuedServerEnvelope>>>,
        mut used_rx: watch::Receiver<usiz
```

**Purpose**: Sends server-side events over the WebSocket. It also resends unacknowledged messages after reconnect, assigns sequence numbers, splits large messages, stores them for acknowledgement, and sends periodic pings.

**Data flow**: Shared WebSocket state, a server-event queue, buffer usage updates, the socket writer, timing settings, and shutdown token come in → old unacknowledged messages are replayed, then new queued events are turned into JSON WebSocket messages while respecting buffer capacity → writes go to the remote service and optional completion signals are sent.

**Call relations**: RemoteControlWebsocket::run_server_writer delegates to this. Tests call it directly to check ping frames and per-stream sequence numbers.

*Call graph*: calls 1 internal fn (split_server_envelope_for_transport); called by 2 (run_server_writer_inner_assigns_contiguous_seq_ids_per_stream, run_server_writer_inner_sends_periodic_ping_frames); 8 external calls (set_missed_tick_behavior, with_capacity, error!, borrow, to_string, select!, now, interval_at).


##### `RemoteControlWebsocket::run_websocket_reader`  (lines 1066–1086)

```
async fn run_websocket_reader(
        client_tracker: Arc<Mutex<ClientTracker>>,
        state: Arc<Mutex<WebsocketState>>,
        websocket_reader: SplitStream<WebSocketStream<MaybeTlsStream<TcpStr
```

**Purpose**: Wraps the WebSocket reader loop and logs why it ended. It is the task entry point for incoming client traffic.

**Data flow**: The client tracker, shared state, socket reader, pong timeout, and shutdown token come in → it runs the inner reader → it logs whether the reader stopped cleanly or with an error.

**Call relations**: RemoteControlWebsocket::run_connection spawns this task for each active connection.

*Call graph*: 2 external calls (run_websocket_reader_inner, warn!).


##### `RemoteControlWebsocket::run_websocket_reader_inner`  (lines 1092–1235)

```
async fn run_websocket_reader_inner(
        client_tracker: Arc<Mutex<ClientTracker>>,
        state: Arc<Mutex<WebsocketState>>,
        mut websocket_reader: SplitStream<WebSocketStream<MaybeTlsStr
```

**Purpose**: Reads messages from the remote-control WebSocket and delivers valid client events to the client tracker. It also watches for missing pong replies, closed clients, idle clients, duplicate chunks, and unsupported message types.

**Data flow**: A client tracker, shared WebSocket state, socket reader, timeout, and shutdown token come in → the loop waits for socket frames, client cleanup events, idle sweeps, and pong deadlines; text frames are parsed and validated → accepted client envelopes are delivered, acknowledgements and cursors are recorded, and stale stream state is cleared.

**Call relations**: RemoteControlWebsocket::run_websocket_reader delegates to this. Tests call it directly to verify pong timeout behavior.

*Call graph*: calls 1 internal fn (client_message_key); called by 1 (run_websocket_reader_inner_times_out_without_pong_frames); 9 external calls (new, format!, matches!, pin!, select!, now, interval, sleep, warn!).


##### `set_remote_control_header`  (lines 1238–1251)

```
fn set_remote_control_header(
    headers: &mut tungstenite::http::HeaderMap,
    name: &'static str,
    value: &str,
) -> io::Result<()>
```

**Purpose**: Adds one HTTP header to the WebSocket handshake request and reports a clear error if the value is invalid.

**Data flow**: A header map, header name, and string value come in → the value is converted to a legal HTTP header value and inserted → the request headers are updated or an input error is returned.

**Call relations**: build_remote_control_websocket_request uses this for every custom remote-control header.

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

**Purpose**: Builds the authenticated HTTP request used to start the WebSocket handshake. This is where the remote service learns which enrolled server is connecting.

**Data flow**: The WebSocket URL, enrollment, installation id, and optional subscribe cursor come in → the URL becomes a client request and headers for server id, name, protocol version, bearer token, installation id, and cursor are added → a ready handshake request is returned.

**Call relations**: connect_remote_control_websocket calls this after enrollment is prepared.

*Call graph*: calls 1 internal fn (set_remote_control_header); called by 1 (connect_remote_control_websocket); 1 external calls (format!).


##### `next_reconnect_delay`  (lines 1303–1312)

```
fn next_reconnect_delay(reconnect_attempt: &mut u64) -> (std::time::Duration, bool)
```

**Purpose**: Chooses how long to wait before the next reconnect attempt. It uses backoff, meaning retries get slower after repeated failures, up to a cap.

**Data flow**: A mutable reconnect-attempt counter comes in → a delay is calculated and capped; if the cap is reached the counter resets, otherwise it increments → the delay and whether a reset happened are returned.

**Call relations**: RemoteControlWebsocket::connect calls this after connection failures; a unit test checks the reset behavior.

*Call graph*: calls 1 internal fn (backoff); called by 2 (connect, next_reconnect_delay_resets_after_cap).


##### `connect_remote_control_websocket`  (lines 1314–1430)

```
async fn connect_remote_control_websocket(
    remote_control_target: &RemoteControlTarget,
    state_db: Option<&StateRuntime>,
    mut auth_context: RemoteControlAuthContext<'_>,
    current_enrollm
```

**Purpose**: Performs the lower-level work of preparing enrollment and opening the WebSocket connection. It also reacts to important HTTP failures from the remote service.

**Data flow**: Remote target, optional state database, auth context, current enrollment, connection options, and status publisher come in → authentication and enrollment are prepared under a lock, a handshake request is built, and connect_async runs with a timeout → returns the WebSocket stream and response, or updates enrollment/token state and returns a detailed error.

**Call relations**: RemoteControlWebsocket::connect calls this inside its retry loop. Many tests call it directly to check authentication, enrollment, and HTTP error behavior.

*Call graph*: calls 6 internal fn (build_remote_control_websocket_request, clear_remote_control_server_token_if_matches, format_remote_control_websocket_connect_error, prepare_remote_control_enrollment, replace_remote_control_enrollment_if_matches, websocket_response_reports_missing_remote_app_server); called by 6 (connect_remote_control_websocket_includes_http_error_details, connect_remote_control_websocket_invalidates_unauthorized_server_token, connect_remote_control_websocket_recovers_after_unauthorized_enrollment, connect_remote_control_websocket_recovers_after_unauthorized_refresh, connect_remote_control_websocket_requires_chatgpt_auth, connect_remote_control_websocket_requires_sqlite_state_db); 10 external calls (as_ref, lock, other, ensure_rustls_crypto_provider, format!, info!, matches!, timeout, connect_async, warn!).


##### `prepare_remote_control_enrollment`  (lines 1432–1586)

```
async fn prepare_remote_control_enrollment(
    remote_control_target: &RemoteControlTarget,
    state_db: Option<&StateRuntime>,
    auth_context: &mut RemoteControlAuthContext<'_>,
    enrollment: &
```

**Purpose**: Makes sure there is a valid remote-control enrollment before a WebSocket is opened. Enrollment is the remote service’s record that this app server exists and is allowed to connect.

**Data flow**: Target, state database, auth context, current enrollment, connection options, and status publisher come in → it loads authentication, clears incompatible account state, loads persisted enrollment, creates or refreshes enrollment as needed, and updates environment status → returns the connection auth to use for the handshake.

**Call relations**: connect_remote_control_websocket calls this before building the WebSocket request.

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

**Purpose**: Re-checks whether remote control should stay enabled after the logged-in account changes. This prevents one account’s persisted preference from leaking into another account.

**Data flow**: State database, target, auth manager, account id, and connection options come in → if durable enabled state is active, it locks preference persistence, loads enrollment for the new account, verifies the account did not change again, and updates desired state from that enrollment → returns success or a retryable error.

**Call relations**: prepare_remote_control_enrollment calls this when the in-memory enrollment belongs to a different account.

*Call graph*: calls 3 internal fn (load_remote_control_auth, acquire_persistence_lock, desired_state_from_persisted_enrollment); called by 1 (prepare_remote_control_enrollment); 2 external calls (new, get_remote_control_enrollment).


##### `websocket_response_reports_missing_remote_app_server`  (lines 1633–1643)

```
fn websocket_response_reports_missing_remote_app_server(
    response: &tungstenite::http::Response<Option<Vec<u8>>>,
) -> bool
```

**Purpose**: Recognizes the specific 404 response that means the remote service no longer knows this enrolled app server. Other 404s are treated differently.

**Data flow**: An HTTP response with an optional body comes in → the status must be 404 and the body must be JSON with the expected detail message → returns true only for that exact missing-server case.

**Call relations**: connect_remote_control_websocket uses this to decide whether to replace a stale enrollment after a failed handshake.

*Call graph*: called by 1 (connect_remote_control_websocket); 2 external calls (body, status).


##### `replace_remote_control_enrollment_if_matches`  (lines 1645–1677)

```
async fn replace_remote_control_enrollment_if_matches(
    state_db: Option<&StateRuntime>,
    remote_control_target: &RemoteControlTarget,
    auth_context: RemoteControlEnrollmentAuthContext<'_, '_
```

**Purpose**: Replaces the current enrollment, but only if it still matches the stale enrollment that caused the failure. This avoids overwriting newer enrollment work from another task.

**Data flow**: State database, target, auth context, current enrollment lock, stale enrollment, options, and status publisher come in → it checks that the locked current enrollment is the same one → if so, it enrolls and persists a replacement.

**Call relations**: connect_remote_control_websocket calls this when the WebSocket service explicitly says the remote app server was not found.

*Call graph*: calls 1 internal fn (enroll_and_persist_remote_control_server); called by 1 (connect_remote_control_websocket); 3 external calls (as_ref, lock, new).


##### `clear_remote_control_server_token_if_matches`  (lines 1679–1692)

```
async fn clear_remote_control_server_token_if_matches(
    current_enrollment: &CurrentRemoteControlEnrollment,
    enrollment: &RemoteControlEnrollment,
) -> io::Result<()>
```

**Purpose**: Clears a rejected server token from the current enrollment when the WebSocket handshake gets a 401 or 403 response. That forces a token refresh on the next attempt.

**Data flow**: The current enrollment lock and failed enrollment come in → the function locks current enrollment, confirms it is the same record, and clears its token → returns an error if there is no matching enrollment.

**Call relations**: connect_remote_control_websocket calls this when the remote service rejects the WebSocket authorization token.

*Call graph*: called by 1 (connect_remote_control_websocket); 2 external calls (as_mut, lock).


##### `enroll_and_persist_remote_control_server`  (lines 1694–1784)

```
async fn enroll_and_persist_remote_control_server(
    remote_control_target: &RemoteControlTarget,
    state_db: &StateRuntime,
    auth_context: RemoteControlEnrollmentAuthContext<'_, '_>,
    enrol
```

**Purpose**: Creates a new remote-control enrollment and saves it to the local state database. It can either create only when missing or deliberately replace an existing enrollment.

**Data flow**: Target, database, auth context, mutable enrollment slot, connection options, status publisher, and selection mode come in → if enrollment is needed and remote control is still enabled, it calls the enroll API, locks persistence, saves the result with the current preference, publishes the environment id, and stores the new enrollment in memory → returns success or an error.

**Call relations**: prepare_remote_control_enrollment uses this for normal setup and token-refresh replacement. replace_remote_control_enrollment_if_matches uses it for stale-enrollment repair.

*Call graph*: calls 5 internal fn (recover_remote_control_auth, acquire_persistence_lock, enroll_remote_control_server, update_persisted_remote_control_enrollment, publish_environment_id); called by 2 (prepare_remote_control_enrollment, replace_remote_control_enrollment_if_matches); 4 external calls (new, other, format!, info!).


##### `format_remote_control_websocket_connect_error`  (lines 1786–1805)

```
fn format_remote_control_websocket_connect_error(
    websocket_url: &str,
    err: &tungstenite::Error,
) -> String
```

**Purpose**: Builds a human-readable error message for failed WebSocket connection attempts. For HTTP failures, it includes selected headers and a preview of the body.

**Data flow**: A WebSocket URL and tungstenite error come in → a base message is created; if the error contains an HTTP response, header details and body preview are appended → returns the final string.

**Call relations**: connect_remote_control_websocket uses this when returning connection failures to the retry loop.

*Call graph*: calls 1 internal fn (preview_remote_control_response_body); called by 1 (connect_remote_control_websocket); 1 external calls (format!).


##### `tests::remote_control_enrollment`  (lines 1853–1865)

```
fn remote_control_enrollment(remote_control_token: Option<&str>) -> RemoteControlEnrollment
```

**Purpose**: Creates a sample enrollment for tests. It saves repeated test setup from being written in every test.

**Data flow**: An optional server token comes in → a normalized localhost remote-control target and fixed account/server/environment fields are assembled → returns a RemoteControlEnrollment with optional expiry.

**Call relations**: Many tests use this helper before calling connection or buffer code.

*Call graph*: calls 1 internal fn (normalize_remote_control_url).


##### `tests::test_current_enrollment`  (lines 1867–1871)

```
fn test_current_enrollment(
        enrollment: Option<RemoteControlEnrollment>,
    ) -> CurrentRemoteControlEnrollment
```

**Purpose**: Wraps an optional test enrollment in the shared enrollment state type used by production code.

**Data flow**: An optional enrollment comes in → it is placed in RemoteControlEnrollmentState and wrapped in an Arc for shared ownership → returns a CurrentRemoteControlEnrollment.

**Call relations**: Connection tests use this to pass realistic shared enrollment state into connect_remote_control_websocket.

*Call graph*: calls 1 internal fn (new); 1 external calls (new).


##### `tests::next_reconnect_delay_resets_after_cap`  (lines 1874–1891)

```
fn next_reconnect_delay_resets_after_cap()
```

**Purpose**: Checks that reconnect backoff resets after reaching the maximum delay. This keeps later retries from staying permanently at the cap.

**Data flow**: The test starts with a high reconnect attempt count → calls next_reconnect_delay twice → asserts the first call hits the cap and resets, and the second returns an early retry delay.

**Call relations**: This directly tests next_reconnect_delay.

*Call graph*: calls 1 internal fn (next_reconnect_delay); 2 external calls (assert!, assert_eq!).


##### `tests::websocket_404_only_reports_explicit_missing_remote_app_server`  (lines 1894–1931)

```
fn websocket_404_only_reports_explicit_missing_remote_app_server()
```

**Purpose**: Checks that only a very specific 404 response is treated as “remote app server not found.” This avoids replacing enrollments for unrelated 404 errors.

**Data flow**: Several fake HTTP responses come in through a table → each is passed to websocket_response_reports_missing_remote_app_server → assertions compare the result with the expected true or false value.

**Call relations**: This directly tests the stale-enrollment detection helper used by connect_remote_control_websocket.

*Call graph*: 4 external calls (new, assert!, assert_eq!, builder).


##### `tests::remote_control_status_channel`  (lines 1933–1944)

```
fn remote_control_status_channel() -> (
        RemoteControlStatusPublisher,
        watch::Receiver<RemoteControlStatusChangedNotification>,
    )
```

**Purpose**: Creates a status publisher and receiver for tests. It starts with a known Connecting status.

**Data flow**: No input is needed → a watch channel is created with fixed test server and installation data → returns the publisher and receiver.

**Call relations**: Status and connection tests use this helper to observe published changes.

*Call graph*: calls 1 internal fn (new); 1 external calls (channel).


##### `tests::enabled_desired_state_sender`  (lines 1946–1951)

```
fn enabled_desired_state_sender() -> watch::Sender<RemoteControlDesiredState>
```

**Purpose**: Creates a desired-state sender whose value says remote control is enabled. Tests use it to avoid repeating watch-channel setup.

**Data flow**: No input is needed → a watch channel is created with Enabled and no persistence preference → returns the sender side.

**Call relations**: Connection tests pass this sender through RemoteControlConnectOptions.

*Call graph*: 1 external calls (channel).


##### `tests::mark_recovery_auth_change_seen_marks_only_recovery_revision_seen`  (lines 1954–1966)

```
fn mark_recovery_auth_change_seen_marks_only_recovery_revision_seen()
```

**Purpose**: Checks that auth recovery can mark its own reload as seen. This prevents the reconnect loop from waking up for the recovery action it just performed.

**Data flow**: A watch channel revision is advanced once → mark_recovery_auth_change_seen is called with the revision from before recovery → the test asserts there is no unseen change left.

**Call relations**: This tests auth recovery behavior used indirectly by enrollment and refresh error handling.

*Call graph*: calls 1 internal fn (mark_recovery_auth_change_seen); 2 external calls (assert!, channel).


##### `tests::mark_recovery_auth_change_seen_preserves_racing_auth_change`  (lines 1969–1982)

```
fn mark_recovery_auth_change_seen_preserves_racing_auth_change()
```

**Purpose**: Checks that a real concurrent authentication change is not hidden by recovery bookkeeping. This protects against missing a user login/logout change.

**Data flow**: A watch channel revision is advanced twice → mark_recovery_auth_change_seen marks only the recovery-related revision → the test asserts another change is still visible.

**Call relations**: This supports the auth-change retry behavior used by connection recovery.

*Call graph*: calls 1 internal fn (mark_recovery_auth_change_seen); 2 external calls (assert!, channel).


##### `tests::remote_control_state_runtime`  (lines 1984–1988)

```
async fn remote_control_state_runtime(codex_home: &TempDir) -> Arc<StateRuntime>
```

**Purpose**: Creates a temporary state database runtime for tests. This gives tests realistic persistence without touching a user’s real data.

**Data flow**: A temporary directory comes in → StateRuntime is initialized under that directory with a test provider name → returns the runtime in an Arc.

**Call relations**: Connection tests use this helper whenever enrollment must be loaded from or saved to state.

*Call graph*: calls 1 internal fn (init); 1 external calls (path).


##### `tests::remote_control_auth_manager`  (lines 1990–1992)

```
fn remote_control_auth_manager() -> Arc<AuthManager>
```

**Purpose**: Creates an AuthManager backed by dummy ChatGPT authentication for tests. This lets connection code believe a user is logged in.

**Data flow**: No input is needed → dummy ChatGPT auth is created and wrapped in an AuthManager → returns the shared manager.

**Call relations**: Most WebSocket connection tests use this helper for successful auth setup.

*Call graph*: calls 2 internal fn (auth_manager_from_auth, create_dummy_chatgpt_auth_for_testing).


##### `tests::remote_control_url_for_listener`  (lines 1994–1999)

```
fn remote_control_url_for_listener(listener: &TcpListener) -> String
```

**Purpose**: Builds a remote-control base URL that points at a local test TCP listener.

**Data flow**: A listener comes in → its local address is read → returns an http:// URL ending in /backend-api/.

**Call relations**: Connection tests use this to aim the WebSocket client at a fake local server.

*Call graph*: 2 external calls (local_addr, format!).


##### `tests::remote_control_auth_dot_json`  (lines 2001–2039)

```
fn remote_control_auth_dot_json(access_token: &str) -> AuthDotJson
```

**Purpose**: Creates an auth file structure with a fake but parseable ChatGPT token. Tests use this to simulate stale and fresh stored credentials.

**Data flow**: An access token string comes in → a fake JWT-like id token and token data are assembled → returns an AuthDotJson value ready to save.

**Call relations**: Unauthorized enrollment and refresh tests save these credentials before invoking connect_remote_control_websocket.

*Call graph*: calls 1 internal fn (parse_chatgpt_jwt_claims); 4 external calls (now, format!, json!, to_vec).


##### `tests::connect_remote_control_websocket_includes_http_error_details`  (lines 2042–2114)

```
async fn connect_remote_control_websocket_includes_http_error_details()
```

**Purpose**: Verifies that failed WebSocket HTTP responses include useful details in the returned error. This helps operators diagnose remote-control connection failures.

**Data flow**: A local fake server returns HTTP 503 with headers and a body → connect_remote_control_websocket tries to connect → the test asserts the error string includes status, selected header information, and body preview.

**Call relations**: This exercises connect_remote_control_websocket and its error formatter.

*Call graph*: calls 2 internal fn (normalize_remote_control_url, connect_remote_control_websocket); 17 external calls (new, bind, new, accept_http_request, enabled_desired_state_sender, remote_control_auth_manager, remote_control_enrollment, remote_control_state_runtime, remote_control_status_channel, remote_control_url_for_listener (+7 more)).


##### `tests::connect_remote_control_websocket_invalidates_unauthorized_server_token`  (lines 2117–2182)

```
async fn connect_remote_control_websocket_invalidates_unauthorized_server_token()
```

**Purpose**: Verifies that a 401 WebSocket response clears the stored server token. The next connection attempt can then refresh rather than reuse a bad token.

**Data flow**: A local fake server returns HTTP 401 → connect_remote_control_websocket fails → the test checks the error text and confirms the enrollment remains but its token is cleared.

**Call relations**: This exercises connect_remote_control_websocket and clear_remote_control_server_token_if_matches.

*Call graph*: calls 2 internal fn (normalize_remote_control_url, connect_remote_control_websocket); 14 external calls (new, bind, new, accept_http_request, enabled_desired_state_sender, remote_control_auth_manager, remote_control_enrollment, remote_control_state_runtime, remote_control_status_channel, remote_control_url_for_listener (+4 more)).


##### `tests::connect_remote_control_websocket_recovers_after_unauthorized_enrollment`  (lines 2185–2279)

```
async fn connect_remote_control_websocket_recovers_after_unauthorized_enrollment()
```

**Purpose**: Verifies that an unauthorized enrollment attempt triggers auth recovery and reports a retryable error. It also checks that recovery’s own auth reload does not cause an extra reconnect wakeup.

**Data flow**: Stale auth is saved, then fresh auth replaces it while a fake server returns 401 to enrollment → connect_remote_control_websocket attempts enrollment and fails → the test asserts fresh auth is loaded and the auth-change receiver is not spuriously marked changed.

**Call relations**: This exercises connect_remote_control_websocket, prepare_remote_control_enrollment, and enroll_and_persist_remote_control_server.

*Call graph*: calls 4 internal fn (normalize_remote_control_url, connect_remote_control_websocket, default, shared); 15 external calls (new, bind, new, accept_http_request, enabled_desired_state_sender, remote_control_auth_dot_json, remote_control_state_runtime, remote_control_status_channel, remote_control_url_for_listener, respond_with_status_and_headers (+5 more)).


##### `tests::connect_remote_control_websocket_recovers_after_unauthorized_refresh`  (lines 2282–2382)

```
async fn connect_remote_control_websocket_recovers_after_unauthorized_refresh()
```

**Purpose**: Verifies that an unauthorized token refresh attempt also triggers auth recovery. This covers the refresh path separately from first enrollment.

**Data flow**: A current enrollment without a usable token and stale saved auth are prepared; the fake server returns 401 to refresh → connect_remote_control_websocket fails after recovery → the test checks the fresh token is loaded and status remains correct.

**Call relations**: This exercises prepare_remote_control_enrollment and refresh error handling inside connect_remote_control_websocket.

*Call graph*: calls 4 internal fn (normalize_remote_control_url, connect_remote_control_websocket, default, shared); 16 external calls (new, bind, new, accept_http_request, enabled_desired_state_sender, remote_control_auth_dot_json, remote_control_enrollment, remote_control_state_runtime, remote_control_status_channel, remote_control_url_for_listener (+6 more)).


##### `tests::connect_remote_control_websocket_requires_sqlite_state_db`  (lines 2385–2421)

```
async fn connect_remote_control_websocket_requires_sqlite_state_db()
```

**Purpose**: Checks that remote control fails clearly when no state database is available. Enrollment persistence is required for this feature.

**Data flow**: Connection setup is created with no state database → connect_remote_control_websocket is called → the test asserts a NotFound error and that the in-memory enrollment is cleared.

**Call relations**: This directly tests the database requirement in prepare_remote_control_enrollment.

*Call graph*: calls 2 internal fn (normalize_remote_control_url, connect_remote_control_websocket); 7 external calls (new, enabled_desired_state_sender, remote_control_auth_manager, remote_control_enrollment, remote_control_status_channel, test_current_enrollment, assert_eq!).


##### `tests::connect_remote_control_websocket_requires_chatgpt_auth`  (lines 2424–2486)

```
async fn connect_remote_control_websocket_requires_chatgpt_auth()
```

**Purpose**: Checks that remote control requires ChatGPT authentication. It also confirms environment status is cleared when auth is missing.

**Data flow**: A state database is present but the AuthManager has no ChatGPT credentials → connect_remote_control_websocket is called → the test asserts PermissionDenied, cleared enrollment, and status without an environment id.

**Call relations**: This exercises prepare_remote_control_enrollment’s authentication failure path.

*Call graph*: calls 4 internal fn (normalize_remote_control_url, connect_remote_control_websocket, default, shared); 8 external calls (new, new, enabled_desired_state_sender, remote_control_enrollment, remote_control_state_runtime, remote_control_status_channel, test_current_enrollment, assert_eq!).


##### `tests::run_remote_control_websocket_loop_shutdown_cancels_reconnect_backoff`  (lines 2489–2540)

```
async fn run_remote_control_websocket_loop_shutdown_cancels_reconnect_backoff()
```

**Purpose**: Verifies that shutdown interrupts a reconnect delay. This prevents the app from hanging during shutdown just because remote-control retry backoff is sleeping.

**Data flow**: A WebSocket loop is started against a closed local listener → it enters reconnect behavior → the test cancels the shutdown token and asserts the task exits quickly.

**Call relations**: This calls RemoteControlWebsocket::new and RemoteControlWebsocket::run.

*Call graph*: calls 2 internal fn (normalize_remote_control_url, new); 14 external calls (new, new, from_millis, new, bind, remote_control_auth_manager, remote_control_status_channel, remote_control_url_for_listener, test_current_enrollment, channel (+4 more)).


##### `tests::publish_status_if_changed_sends_only_status_changes`  (lines 2543–2627)

```
async fn publish_status_if_changed_sends_only_status_changes()
```

**Purpose**: Checks that status publishing only notifies subscribers when the visible status actually changes. It also checks that environment id updates are ignored while disabled.

**Data flow**: A test status channel is created → repeated status and environment updates are published → the receiver is checked for expected changes and non-changes.

**Call relations**: This directly tests RemoteControlStatusPublisher behavior.

*Call graph*: 3 external calls (remote_control_status_channel, assert!, assert_eq!).


##### `tests::run_server_writer_inner_sends_periodic_ping_frames`  (lines 2630–2665)

```
async fn run_server_writer_inner_sends_periodic_ping_frames()
```

**Purpose**: Verifies that the writer sends ping frames on schedule. Pings are how the connection checks that the other side is still alive.

**Data flow**: A connected local WebSocket pair is created and the writer runs with a short ping interval → the server side reads the next frame → the test asserts it is a Ping and then shuts the writer down.

**Call relations**: This directly calls RemoteControlWebsocket::run_server_writer_inner.

*Call graph*: calls 2 internal fn (new, run_server_writer_inner); 12 external calls (new, new, from_millis, from_secs, new, new, default, connected_websocket_pair, assert!, channel (+2 more)).


##### `tests::join_connection_workers_aborts_stuck_worker_after_timeout`  (lines 2668–2676)

```
async fn join_connection_workers_aborts_stuck_worker_after_timeout()
```

**Purpose**: Checks that stuck connection workers are aborted after the shutdown timeout. This protects teardown from waiting forever.

**Data flow**: A join set containing a never-finishing task is created → join_connection_workers is called with a tiny timeout → the test asserts the join set is empty afterward.

**Call relations**: This directly tests RemoteControlWebsocket::join_connection_workers.

*Call graph*: calls 1 internal fn (join_connection_workers); 3 external calls (from_millis, assert!, new).


##### `tests::run_server_writer_inner_assigns_contiguous_seq_ids_per_stream`  (lines 2679–2755)

```
async fn run_server_writer_inner_assigns_contiguous_seq_ids_per_stream()
```

**Purpose**: Verifies that outgoing sequence numbers increase separately for each client stream. This matters because acknowledgements are tracked per stream.

**Data flow**: Three queued server events are sent across two streams → the writer emits JSON messages → the test reads them and asserts stream-1 gets sequence ids 1 and 2 while stream-2 starts at 1.

**Call relations**: This directly calls RemoteControlWebsocket::run_server_writer_inner.

*Call graph*: calls 2 internal fn (new, run_server_writer_inner); 12 external calls (new, new, from_secs, new, new, new, new, default, connected_websocket_pair, assert_eq! (+2 more)).


##### `tests::run_websocket_reader_inner_times_out_without_pong_frames`  (lines 2758–2795)

```
async fn run_websocket_reader_inner_times_out_without_pong_frames()
```

**Purpose**: Verifies that the reader fails when pong frames stop arriving. This prevents a half-dead connection from looking healthy forever.

**Data flow**: A local WebSocket reader is run with a short pong timeout and no pong messages are sent → the reader returns an error → the test asserts the error is TimedOut.

**Call relations**: This directly calls RemoteControlWebsocket::run_websocket_reader_inner.

*Call graph*: calls 3 internal fn (new, new, run_websocket_reader_inner); 11 external calls (new, new, from_millis, from_secs, new, new, default, connected_websocket_pair, assert_eq!, channel (+1 more)).


##### `tests::outbound_buffer_acks_by_stream_id`  (lines 2798–2843)

```
fn outbound_buffer_acks_by_stream_id()
```

**Purpose**: Checks that acknowledgements remove messages only for the matching client and stream. Messages on other streams or clients must not be lost.

**Data flow**: The test inserts three buffered messages across two clients/streams → acknowledges one client stream → asserts only messages for that stream at or before the cursor were removed.

**Call relations**: This directly tests BoundedOutboundBuffer::ack.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, new, server_envelope, assert_eq!).


##### `tests::outbound_buffer_retains_unacked_messages_until_ack_advances`  (lines 2846–2888)

```
fn outbound_buffer_retains_unacked_messages_until_ack_advances()
```

**Purpose**: Checks that messages remain buffered until the acknowledgement cursor reaches them. This protects unsent or unconfirmed messages.

**Data flow**: Several messages are inserted → an acknowledgement covers only one sequence on one stream → the test asserts unrelated or newer messages remain and usage count is correct.

**Call relations**: This directly tests BoundedOutboundBuffer retention behavior.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, new, server_envelope, assert_eq!).


##### `tests::outbound_buffer_advances_segmented_acks_by_wire_cursor`  (lines 2891–2916)

```
fn outbound_buffer_advances_segmented_acks_by_wire_cursor()
```

**Purpose**: Checks that acknowledgements for split messages advance by both sequence id and segment id. This allows partial wire-level progress to be tracked accurately.

**Data flow**: Two segments for the same sequence are inserted → an acknowledgement for segment 1 arrives → the test asserts both segments are removed.

**Call relations**: This directly tests BoundedOutboundBuffer::ack with segmented messages.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, new, server_chunk_envelope, assert_eq!).


##### `tests::outbound_buffer_treats_segmentless_acks_as_seq_level_acks`  (lines 2919–2941)

```
fn outbound_buffer_treats_segmentless_acks_as_seq_level_acks()
```

**Purpose**: Checks that an acknowledgement without a segment id means the whole sequence was received. This supports older or simpler acknowledgement forms.

**Data flow**: Two segments for one sequence are inserted → an acknowledgement for the sequence without segment detail arrives → the test asserts all segments for that sequence are removed.

**Call relations**: This directly tests BoundedOutboundBuffer::ack.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, new, server_chunk_envelope, assert_eq!).


##### `tests::websocket_state_drops_duplicate_client_chunks_while_pending`  (lines 2944–2978)

```
fn websocket_state_drops_duplicate_client_chunks_while_pending()
```

**Purpose**: Checks that duplicate chunks for an in-progress client message are dropped. This avoids corrupting a message while it is still being assembled.

**Data flow**: The first chunk of a two-part message is observed, then repeated, then followed by another chunk in an invalid state → the test checks which observations are Pending or Dropped.

**Call relations**: This directly tests WebsocketState::observe_client_message.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, default, client_chunk_envelope, assert!).


##### `tests::websocket_state_drops_replayed_client_chunks_after_completion`  (lines 2981–3037)

```
fn websocket_state_drops_replayed_client_chunks_after_completion()
```

**Purpose**: Checks that once a split client message has been fully delivered, replayed chunks for the same sequence are dropped. This prevents duplicate client messages after reconnect or retry.

**Data flow**: Two chunks are observed and assembled into a complete message → delivery is recorded → the first chunk is observed again and must be dropped.

**Call relations**: This tests WebsocketState::observe_client_message and record_client_message_delivery together.

*Call graph*: calls 1 internal fn (new); 10 external calls (new, Notification, new, new, default, client_chunk_envelope, observe_client_message, assert!, panic!, to_vec).


##### `tests::websocket_state_allows_replay_before_completed_chunk_delivery`  (lines 3040–3086)

```
fn websocket_state_allows_replay_before_completed_chunk_delivery()
```

**Purpose**: Checks that replay is still allowed if a completed split message has not yet been recorded as delivered. This avoids losing a message that assembled but failed before delivery.

**Data flow**: A two-chunk message is assembled → before delivery is recorded, the first chunk is sent again → the test asserts it can start pending again.

**Call relations**: This directly tests the boundary between observation and record_client_message_delivery.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Notification, default, client_chunk_envelope, assert!, to_vec).


##### `tests::websocket_state_allows_replay_after_rejected_out_of_order_chunk`  (lines 3089–3115)

```
fn websocket_state_allows_replay_after_rejected_out_of_order_chunk()
```

**Purpose**: Checks that an out-of-order rejected chunk does not poison the stream forever. A later correct first chunk should still be accepted.

**Data flow**: A second chunk arrives before the first and is dropped → the first chunk then arrives → the test asserts it is accepted as pending.

**Call relations**: This directly tests WebsocketState::observe_client_message and the reassembler’s rejection behavior.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, default, client_chunk_envelope, assert!).


##### `tests::websocket_state_allows_replay_after_later_chunk_drops`  (lines 3118–3148)

```
fn websocket_state_allows_replay_after_later_chunk_drops()
```

**Purpose**: Checks that a bad later chunk does not prevent retrying the message from the beginning. This supports recovery after malformed or incomplete chunk sequences.

**Data flow**: A first chunk is accepted, then an invalid second chunk is dropped → the first chunk is sent again → the test asserts it is accepted as pending.

**Call relations**: This directly tests WebsocketState::observe_client_message.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, default, client_chunk_envelope, assert!).


##### `tests::websocket_state_drops_oversized_client_chunk_frames`  (lines 3151–3169)

```
fn websocket_state_drops_oversized_client_chunk_frames()
```

**Purpose**: Checks that an oversized client chunk frame is rejected. This protects memory and processing from messages that exceed the transport limit.

**Data flow**: A chunk envelope is observed with a wire size larger than the maximum → observe_client_message returns Dropped → the test asserts that result.

**Call relations**: This directly tests the size guard in WebsocketState::observe_client_message.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, default, client_chunk_envelope, assert!).


##### `tests::websocket_state_ignores_oversized_stale_chunks_without_dropping_newer_assembly`  (lines 3172–3230)

```
fn websocket_state_ignores_oversized_stale_chunks_without_dropping_newer_assembly()
```

**Purpose**: Checks that a too-large stale chunk does not destroy a newer message that is currently being assembled. This prevents old retries from disrupting current work.

**Data flow**: A newer first chunk starts assembly, then an oversized older chunk arrives, then the newer second chunk arrives → the test asserts the old chunk is dropped and the newer message still completes.

**Call relations**: This directly tests WebsocketState::observe_client_message and stale-chunk handling.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Notification, default, client_chunk_envelope, assert!, to_vec).


##### `tests::websocket_state_ignores_oversized_duplicate_chunks_without_dropping_current_assembly`  (lines 3233–3291)

```
fn websocket_state_ignores_oversized_duplicate_chunks_without_dropping_current_assembly()
```

**Purpose**: Checks that a too-large duplicate chunk does not invalidate the current assembly. Duplicate noise should not break a valid in-progress message.

**Data flow**: A first chunk starts assembly, an oversized duplicate first chunk arrives, then the second chunk arrives → the test asserts the duplicate is dropped and the message still completes.

**Call relations**: This directly tests WebsocketState::observe_client_message.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Notification, default, client_chunk_envelope, assert!, to_vec).


##### `tests::websocket_state_clears_chunk_cursor_when_stream_is_invalidated`  (lines 3294–3331)

```
fn websocket_state_clears_chunk_cursor_when_stream_is_invalidated()
```

**Purpose**: Checks that invalidating a stream clears old chunk cursor state. After cleanup, lower sequence numbers can be accepted on the new stream lifecycle.

**Data flow**: A chunk with sequence 4 is observed → stream message and reassembler state are invalidated → a chunk with sequence 1 is observed and accepted as pending.

**Call relations**: This tests WebsocketState::invalidate_client_message_stream together with reassembler invalidation.

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

**Purpose**: Builds a simple server envelope for outbound-buffer tests. The message content is a small config-warning notification with a readable summary.

**Data flow**: Client id, stream id, sequence id, and summary come in → a ServerEnvelope containing a server message event is assembled → returns the envelope.

**Call relations**: Outbound-buffer tests use this helper to insert realistic server messages.

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

**Purpose**: Builds a split server-message envelope for acknowledgement tests. It represents one segment of a two-part outgoing message.

**Data flow**: Client id, stream id, sequence id, and segment id come in → a ServerEnvelope with a ServerMessageChunk event is assembled → returns the envelope.

**Call relations**: Segmented acknowledgement tests use this helper with BoundedOutboundBuffer.

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

**Purpose**: Builds a split client-message envelope for WebSocket state tests. It base64-encodes the raw chunk bytes because the protocol carries chunks as text.

**Data flow**: Client id, stream id, sequence id, segment metadata, total message size, and raw bytes come in → the bytes are encoded and placed in a ClientEnvelope → returns the envelope.

**Call relations**: Client-chunk reassembly and duplicate tests use this helper.

*Call graph*: 2 external calls (new, new).


##### `tests::observe_client_message`  (lines 3398–3406)

```
fn observe_client_message(
        state: &mut WebsocketState,
        envelope: ClientEnvelope,
    ) -> ClientSegmentObservation
```

**Purpose**: Test helper that computes the serialized wire size before calling WebsocketState::observe_client_message. This keeps tests close to real behavior.

**Data flow**: A mutable WebSocket state and client envelope come in → the envelope is serialized to count its wire size → the production observe_client_message result is returned.

**Call relations**: Many WebsocketState tests use this helper instead of calling the method directly.

*Call graph*: calls 1 internal fn (observe_client_message); 1 external calls (to_vec).


##### `tests::accept_http_request`  (lines 3408–3435)

```
async fn accept_http_request(listener: &TcpListener) -> (TcpStream, String)
```

**Purpose**: Accepts one raw HTTP request from a local test listener and returns the stream plus the request line. It is a lightweight fake server helper.

**Data flow**: A TCP listener comes in → the helper waits for a connection, reads the request line and headers until the blank line → returns the underlying stream and the request line string.

**Call relations**: Connection tests use this inside fake server tasks before sending custom HTTP responses.

*Call graph*: 4 external calls (new, new, accept, timeout).


##### `tests::connected_websocket_pair`  (lines 3437–3463)

```
async fn connected_websocket_pair() -> (
        WebSocketStream<MaybeTlsStream<TcpStream>>,
        WebSocketStream<TcpStream>,
    )
```

**Purpose**: Creates a connected client/server WebSocket pair on localhost for tests. This avoids relying on any external network service.

**Data flow**: No input is needed → a local TCP listener is bound, a client connects, the server accepts the WebSocket handshake → returns the client and server WebSocket streams.

**Call relations**: Writer and reader tests use this helper to exercise WebSocket frame behavior.

*Call graph*: 5 external calls (bind, format!, spawn, accept_async, connect_async).


##### `tests::read_server_text_event`  (lines 3465–3477)

```
async fn read_server_text_event(
        server_stream: &mut WebSocketStream<TcpStream>,
    ) -> serde_json::Value
```

**Purpose**: Reads the next text WebSocket message from the server side and parses it as JSON. It fails the test if the next frame is not text.

**Data flow**: A mutable server WebSocket stream comes in → the helper waits for one frame with a timeout, checks it is text, and parses JSON → returns the JSON value.

**Call relations**: The sequence-number writer test uses this to inspect emitted server events.

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

**Purpose**: Writes a simple HTTP response to a test TCP stream. It lets tests simulate remote-control service errors such as 401 or 503.

**Data flow**: A TCP stream, status line, extra headers, and body come in → an HTTP/1.1 response string with content length and close header is built and written → the fake server response is flushed to the client.

**Call relations**: Connection tests call this after accept_http_request to control how connect_remote_control_websocket fails.

*Call graph*: 3 external calls (flush, write_all, format!).


### Client facades and TUI session layer
These files expose the shared app-server client API, its remote transport implementation, and the higher-level TUI session wrapper built on top of that client.

### `app-server-client/src/lib.rs`

`orchestration` · `startup, request handling, event streaming, teardown`

This file is the front desk for app-server communication. Tools like the TUI or exec mode need to ask the app server to start threads, read account state, update config, and react to server events. Without this facade, each caller would need to know the low-level details of channels, JSON-RPC response envelopes, startup handshakes, backpressure, and shutdown.

The file supports two shapes of client: an in-process client, where the app server runs inside the same program, and a remote client, where communication goes through the remote module. The public `AppServerClient` and `AppServerRequestHandle` hide that difference so callers can use one API.

For the in-process case, the file starts the embedded runtime and then creates a worker task. Think of this worker as a mailroom clerk. Public methods put commands into one bounded queue. The worker forwards them to the server, receives server events, and puts those events into another bounded queue for the caller. The queues are bounded so a slow consumer cannot grow memory forever.

A key detail is event priority. Some events, such as streamed assistant text and turn-completed signals, must not be lost or the UI can become corrupted or wait forever. Less critical progress output may be dropped under pressure, with a lag marker telling the caller that something was skipped. Shutdown is also bounded: it tries to stop cleanly, but aborts the worker if it takes too long.

#### Function details

##### `migrate_personality_if_needed`  (lines 98–110)

```
async fn migrate_personality_if_needed(
    codex_home: &Path,
    config_toml: &ConfigToml,
    state_db: Option<StateDbHandle>,
) -> IoResult<bool>
```

**Purpose**: Runs a one-time migration for the embedded app-server personality settings. It tells the caller whether config changed and should be reloaded.

**Data flow**: It receives the Codex home path, parsed config, and optional state database. It asks the core migration code to inspect and possibly update state. It returns `true` only when the migration actually applied changes; skipped cases return `false`.

**Call relations**: Startup code can call this before creating a client. It delegates the real migration work to `maybe_migrate_personality` and translates the detailed status into a simple yes-or-no result.

*Call graph*: calls 1 internal fn (maybe_migrate_personality).


##### `AppServerEvent::from`  (lines 128–136)

```
fn from(value: InProcessServerEvent) -> Self
```

**Purpose**: Converts a low-level in-process server event into the public event type used by this client facade.

**Data flow**: It receives an `InProcessServerEvent`. It keeps the same meaning, wrapping lag notices, server notifications, and server requests in the public `AppServerEvent` enum. The output is ready for callers that do not care whether the event came from an in-process or remote server.

**Call relations**: The public `AppServerClient::next_event` uses this conversion when the client is in-process. It helps make in-process and remote events look the same to higher-level code.

*Call graph*: 2 external calls (ServerNotification, ServerRequest).


##### `event_requires_delivery`  (lines 139–150)

```
fn event_requires_delivery(event: &InProcessServerEvent) -> bool
```

**Purpose**: Decides whether an in-process event is too important to drop when the event queue is full.

**Data flow**: It receives an event. If the event is a server notification, it asks `server_notification_requires_delivery` whether that notification belongs to the lossless group. It returns `true` for must-deliver events and `false` for best-effort events.

**Call relations**: `forward_in_process_event` calls this before sending events to the caller. This is the gate that protects transcript and completion events from being lost under backpressure.

*Call graph*: calls 1 internal fn (server_notification_requires_delivery); called by 1 (forward_in_process_event).


##### `server_notification_requires_delivery`  (lines 163–175)

```
fn server_notification_requires_delivery(notification: &ServerNotification) -> bool
```

**Purpose**: Lists the server notifications that must always reach the caller because dropping them can corrupt visible output or leave the caller waiting.

**Data flow**: It receives a server notification and checks whether it is one of the important transcript, settings, import-completion, item-completion, or turn-completion notifications. It returns a boolean classification.

**Call relations**: `event_requires_delivery` calls this for in-process events, and the remote transport shares the same rule so both paths treat important events consistently.

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

**Purpose**: Sends one server event toward the caller while protecting important events and avoiding unbounded memory growth.

**Data flow**: It receives the caller event queue, a counter of already skipped events, a new event, and a callback for rejecting dropped server requests. It either sends the event, records that it was skipped, emits a lag marker, or reports that the stream should stop because the receiver closed. If a server request is dropped, it rejects that request so the server is not left waiting forever.

**Call relations**: The worker task inside `InProcessAppServerClient::start` uses this for every in-process server event. Tests call it directly to verify that important transcript events survive backpressure.

*Call graph*: calls 1 internal fn (event_requires_delivery); called by 1 (forward_in_process_event_preserves_transcript_notifications_under_backpressure); 3 external calls (send, try_send, warn!).


##### `TypedRequestError::fmt`  (lines 286–306)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Turns a typed request error into a readable message for logs or users.

**Data flow**: It receives one of the error variants: transport failure, server JSON-RPC error, or response decoding failure. It writes a message that includes the request method and the most useful details. The output is formatted text.

**Call relations**: This is used whenever `TypedRequestError` is displayed. It makes failures from `request_typed` easier to understand without inspecting the enum manually.

*Call graph*: 1 external calls (write!).


##### `TypedRequestError::source`  (lines 310–316)

```
fn source(&self) -> Option<&(dyn Error + 'static)>
```

**Purpose**: Exposes the underlying error when there is one, so standard Rust error reporting can follow the cause chain.

**Data flow**: It receives the typed request error. For transport and decoding failures it returns the wrapped lower-level error. For server-side JSON-RPC errors it returns no source because that payload is protocol data rather than a Rust error object.

**Call relations**: Error reporters and tests use this through Rust's standard `Error` trait. It supports clearer debugging of `request_typed` failures.


##### `configured_thread_config_loader`  (lines 359–364)

```
fn configured_thread_config_loader(config: &Config) -> Arc<dyn ThreadConfigLoader>
```

**Purpose**: Chooses how thread-specific config should be loaded for the in-process server.

**Data flow**: It reads the config. If an experimental thread-config endpoint is set, it creates a remote loader for that endpoint. Otherwise it creates a no-op loader that does not fetch extra thread config. It returns the chosen loader behind a shared pointer.

**Call relations**: `InProcessClientStartArgs::into_runtime_start_args` calls this while building runtime startup arguments. It decides whether startup will include remote thread config support.

*Call graph*: calls 1 internal fn (new); called by 1 (into_runtime_start_args); 1 external calls (new).


##### `InProcessClientStartArgs::initialize_params`  (lines 368–387)

```
fn initialize_params(&self) -> InitializeParams
```

**Purpose**: Builds the `initialize` request data that identifies this client to the app server.

**Data flow**: It reads the client name, version, experimental API flag, and notification opt-out list from the startup arguments. It packages them into protocol-level initialize parameters. The output is sent during app-server startup.

**Call relations**: `into_runtime_start_args` calls this before starting the in-process runtime. It is the handshake information the server sees first.

*Call graph*: called by 1 (into_runtime_start_args).


##### `InProcessClientStartArgs::into_runtime_start_args`  (lines 389–410)

```
fn into_runtime_start_args(self) -> InProcessStartArgs
```

**Purpose**: Converts the facade's startup settings into the lower-level startup settings required by the embedded app server.

**Data flow**: It consumes `InProcessClientStartArgs`, builds initialize parameters, chooses the thread config loader, and moves through config, state, feedback, environment, warnings, and channel capacity. The result is an `InProcessStartArgs` value for the runtime.

**Call relations**: `InProcessAppServerClient::start` calls this just before launching the embedded server. It is the adapter between this crate's public startup shape and the app-server runtime's internal one.

*Call graph*: calls 2 internal fn (initialize_params, configured_thread_config_loader); called by 1 (start).


##### `InProcessAppServerClient::start`  (lines 480–597)

```
async fn start(args: InProcessClientStartArgs) -> IoResult<Self>
```

**Purpose**: Starts the embedded app server and the facade worker task that connects callers to it.

**Data flow**: It receives startup arguments, clamps the queue size to at least one, starts the in-process runtime, creates command and event queues, and spawns a worker loop. It returns a ready-to-use client containing the command sender, event receiver, and worker task handle.

**Call relations**: Tests, exec, and TUI startup paths call this to create an in-process client. The worker it spawns later receives commands from request, notification, server-request resolution, and shutdown methods, while also forwarding runtime events through `forward_in_process_event`.

*Call graph*: calls 2 internal fn (into_runtime_start_args, start); called by 3 (start_test_client_with_capacity, run_exec_session, widget_forced_chatgpt); 2 external calls (select!, spawn).


##### `InProcessAppServerClient::request_handle`  (lines 599–603)

```
fn request_handle(&self) -> InProcessAppServerRequestHandle
```

**Purpose**: Creates a cloneable request-only handle for code that needs to send requests without owning the full client.

**Data flow**: It reads the client's command sender and clones it. The output is an `InProcessAppServerRequestHandle` that can submit requests through the same worker.

**Call relations**: The public `AppServerClient::request_handle` wraps this for in-process clients. It lets background tasks make app-server requests while the main client continues to receive events.

*Call graph*: 1 external calls (clone).


##### `InProcessAppServerClient::request`  (lines 609–629)

```
async fn request(&self, request: ClientRequest) -> IoResult<RequestResult>
```

**Purpose**: Sends one typed client request to the in-process app server and waits for the raw JSON-RPC-style result.

**Data flow**: It receives a `ClientRequest`, creates a one-time reply channel, sends a command to the worker, and waits for the worker to return either a successful JSON value or a server error payload. If the worker channel is closed, it returns an I/O-style broken-pipe error.

**Call relations**: `InProcessAppServerClient::request_typed` builds on this. The worker created by `start` receives the command and forwards the request to the embedded app-server handle.

*Call graph*: called by 1 (request_typed); 3 external calls (new, send, channel).


##### `InProcessAppServerClient::request_typed`  (lines 637–655)

```
async fn request_typed(&self, request: ClientRequest) -> Result<T, TypedRequestError>
```

**Purpose**: Sends a request and decodes a successful JSON response into the concrete type the caller expects.

**Data flow**: It receives a request and a desired response type. It extracts the method name for diagnostics, calls `request`, turns transport and server failures into `TypedRequestError`, and deserializes the JSON result into the requested type. The output is either the typed response or a layered error.

**Call relations**: Higher-level request helpers call this when they expect a specific response shape. It uses `request_method_name` so any failure names the app-server method involved.

*Call graph*: calls 2 internal fn (request, request_method_name); called by 1 (send_request_with_response); 1 external calls (from_value).


##### `InProcessAppServerClient::notify`  (lines 658–678)

```
async fn notify(&self, notification: ClientNotification) -> IoResult<()>
```

**Purpose**: Sends a client notification to the in-process app server without expecting a response body.

**Data flow**: It receives a notification, creates a one-time completion channel, and sends a notify command to the worker. The worker forwards it to the server and sends back success or an I/O error.

**Call relations**: Public notification calls on the in-process client use this path. It shares the same worker queue as requests so caller-facing methods do not directly touch the runtime handle.

*Call graph*: 2 external calls (send, channel).


##### `InProcessAppServerClient::resolve_server_request`  (lines 684–709)

```
async fn resolve_server_request(
        &self,
        request_id: RequestId,
        result: JsonRpcResult,
    ) -> IoResult<()>
```

**Purpose**: Answers a request that the server previously sent to this client.

**Data flow**: It receives the server request ID and a JSON result. It sends a resolve command to the worker and waits for confirmation that the response was handed back to the server. It returns an I/O error if the worker path is closed.

**Call relations**: `AppServerClient::resolve_server_request` calls this for in-process clients. Callers should use it only for request IDs they got from the client's event stream.

*Call graph*: called by 1 (resolve_server_request); 2 external calls (send, channel).


##### `InProcessAppServerClient::reject_server_request`  (lines 712–737)

```
async fn reject_server_request(
        &self,
        request_id: RequestId,
        error: JSONRPCErrorError,
    ) -> IoResult<()>
```

**Purpose**: Rejects a server request with a JSON-RPC error payload.

**Data flow**: It receives the server request ID and error details. It sends a reject command to the worker and waits for the worker to report whether the error response was delivered to the server.

**Call relations**: `AppServerClient::reject_server_request` calls this for in-process clients. The worker also uses the same underlying server-failure path internally when overloaded server requests must be rejected.

*Call graph*: called by 1 (reject_server_request); 2 external calls (send, channel).


##### `InProcessAppServerClient::next_event`  (lines 744–746)

```
async fn next_event(&mut self) -> Option<InProcessServerEvent>
```

**Purpose**: Waits for the next event from the in-process app server.

**Data flow**: It waits on the event receiver queue. If an event arrives, it returns it. If the worker has exited and the queue closes, it returns `None`.

**Call relations**: Higher-level event loops call this to receive notifications, server requests, and lag markers. The worker created by `start` is the producer for this queue.

*Call graph*: calls 1 internal fn (recv).


##### `InProcessAppServerClient::shutdown`  (lines 752–784)

```
async fn shutdown(self) -> IoResult<()>
```

**Purpose**: Stops the in-process client and embedded runtime without letting shutdown hang forever.

**Data flow**: It consumes the client, drops the event receiver to unblock any pending event sends, sends a shutdown command to the worker, and waits with a timeout. If the worker still does not finish, it aborts the task. It returns success unless a confirmed shutdown response reports an I/O error.

**Call relations**: `AppServerClient::shutdown` calls this for in-process clients. Tests verify that it finishes promptly even when background resources exist.

*Call graph*: called by 1 (shutdown); 2 external calls (channel, timeout).


##### `InProcessAppServerRequestHandle::request`  (lines 788–808)

```
async fn request(&self, request: ClientRequest) -> IoResult<RequestResult>
```

**Purpose**: Lets a cloned request handle send a raw request through the in-process worker.

**Data flow**: It receives a request, creates a one-time reply channel, sends the request command through the shared command sender, and waits for the raw request result. Closed channels become broken-pipe I/O errors.

**Call relations**: `InProcessAppServerRequestHandle::request_typed` calls this. It is useful when code needs request access but should not own the full event-receiving client.

*Call graph*: called by 1 (request_typed); 3 external calls (new, send, channel).


##### `InProcessAppServerRequestHandle::request_typed`  (lines 810–828)

```
async fn request_typed(&self, request: ClientRequest) -> Result<T, TypedRequestError>
```

**Purpose**: Sends a request through a request-only handle and decodes the response into the expected type.

**Data flow**: It receives a request, records the method name, calls the handle's raw `request`, maps transport and server errors into `TypedRequestError`, and deserializes the JSON result into the caller's response type.

**Call relations**: The unified `AppServerRequestHandle::request_typed` delegates here for in-process handles. It mirrors the full client's typed request behavior.

*Call graph*: calls 2 internal fn (request, request_method_name); 1 external calls (from_value).


##### `AppServerRequestHandle::request`  (lines 832–837)

```
async fn request(&self, request: ClientRequest) -> IoResult<RequestResult>
```

**Purpose**: Sends a raw request through either an in-process or remote request handle using one common method.

**Data flow**: It receives a request and checks which kind of handle it wraps. It forwards the request to the in-process or remote implementation and returns that result unchanged.

**Call relations**: Callers with a generic request handle use this when they do not need to know where the server lives. It is the small dispatch layer above the two transport-specific handles.


##### `AppServerRequestHandle::request_typed`  (lines 839–847)

```
async fn request_typed(&self, request: ClientRequest) -> Result<T, TypedRequestError>
```

**Purpose**: Sends a typed request through either kind of request handle and decodes the response.

**Data flow**: It receives a request and expected response type. It forwards to the in-process or remote typed request method, then returns the typed response or `TypedRequestError` from that path.

**Call relations**: Many higher-level features use this handle to fetch account limits, token activity, marketplace data, MCP server status, and similar information without caring whether the app server is local or remote.

*Call graph*: called by 25 (consume_rate_limit_reset_credit_request, fetch_account_rate_limits, fetch_account_token_activity, fetch_all_mcp_server_statuses, fetch_connectors_list, fetch_feedback_upload, fetch_marketplace_add, fetch_marketplace_remove, fetch_marketplace_upgrade, fetch_plugin_detail (+15 more)).


##### `AppServerClient::codex_home`  (lines 851–858)

```
fn codex_home(&self, local_codex_home: &AbsolutePathBuf) -> Option<AppServerPath>
```

**Purpose**: Returns the Codex home path as seen by the app server, when that can be known.

**Data flow**: It receives the local Codex home as a fallback. For in-process clients it converts that local path into an app-server path. For remote clients it asks the remote server what home path it reported during initialization. The result is optional because a remote server may not provide it.

**Call relations**: The `codex_home_path` helper uses this to display or work with the correct server-side home path. It hides the difference between local and remote path ownership.

*Call graph*: calls 2 internal fn (from_app_server, display); called by 1 (codex_home_path).


##### `AppServerClient::request`  (lines 860–865)

```
async fn request(&self, request: ClientRequest) -> IoResult<RequestResult>
```

**Purpose**: Sends a raw request through the active app-server client, regardless of whether it is in-process or remote.

**Data flow**: It receives a request, matches on the client kind, and forwards the request to that implementation. The returned raw JSON-RPC-style result is passed back unchanged.

**Call relations**: This is the public dispatch method for callers that want raw results. It keeps higher-level code from branching on client location.


##### `AppServerClient::request_typed`  (lines 867–875)

```
async fn request_typed(&self, request: ClientRequest) -> Result<T, TypedRequestError>
```

**Purpose**: Sends a request through the active client and decodes the response into the caller's expected type.

**Data flow**: It receives a request and response type. It delegates to the in-process or remote typed request method, returning either a decoded value or a typed error.

**Call relations**: Many app features call this during bootstrap, config reload, account reads, logout, memory reset, thread forking, and external agent configuration flows.

*Call graph*: called by 34 (bootstrap, external_agent_config_detect, external_agent_config_import, fork_thread, logout_account, memory_reset, read_account, reload_user_config, resume_thread, review_start (+15 more)).


##### `AppServerClient::notify`  (lines 877–882)

```
async fn notify(&self, notification: ClientNotification) -> IoResult<()>
```

**Purpose**: Sends a notification through either an in-process or remote app-server client.

**Data flow**: It receives a client notification, dispatches it to the wrapped implementation, and returns success or an I/O error.

**Call relations**: This is the public notification path. It lets callers emit fire-and-forget protocol messages without knowing the transport.


##### `AppServerClient::resolve_server_request`  (lines 884–893)

```
async fn resolve_server_request(
        &self,
        request_id: RequestId,
        result: JsonRpcResult,
    ) -> IoResult<()>
```

**Purpose**: Answers a server-originated request through the active client.

**Data flow**: It receives the server request ID and JSON result. It forwards them to the in-process or remote implementation and returns whether the response was sent successfully.

**Call relations**: Higher-level server-request handling calls this after the user or UI supplies an answer. It routes the answer back over the same client that produced the request event.

*Call graph*: called by 1 (resolve_server_request).


##### `AppServerClient::reject_server_request`  (lines 895–904)

```
async fn reject_server_request(
        &self,
        request_id: RequestId,
        error: JSONRPCErrorError,
    ) -> IoResult<()>
```

**Purpose**: Rejects a server-originated request through the active client.

**Data flow**: It receives a request ID and JSON-RPC error payload. It forwards them to the wrapped in-process or remote client and returns the send result.

**Call relations**: Higher-level server-request handling calls this when a request cannot or should not be fulfilled. It keeps rejection behavior uniform across transports.

*Call graph*: called by 1 (reject_server_request).


##### `AppServerClient::next_event`  (lines 906–911)

```
async fn next_event(&mut self) -> Option<AppServerEvent>
```

**Purpose**: Waits for the next public app-server event from either transport.

**Data flow**: It waits on the wrapped client. For in-process events, it converts them into `AppServerEvent`; for remote events, it returns the remote event directly. If the event stream closes, it returns `None`.

**Call relations**: The outer event loop calls this to drive UI updates, approval prompts, disconnect handling, and lag reporting.

*Call graph*: called by 1 (next_event).


##### `AppServerClient::shutdown`  (lines 913–918)

```
async fn shutdown(self) -> IoResult<()>
```

**Purpose**: Stops the active client cleanly, using the right shutdown path for its transport.

**Data flow**: It consumes the public client, dispatches to the in-process or remote shutdown implementation, and returns the shutdown result.

**Call relations**: Application teardown calls this. It prevents callers from needing separate local and remote cleanup code.

*Call graph*: called by 1 (shutdown).


##### `AppServerClient::request_handle`  (lines 920–925)

```
fn request_handle(&self) -> AppServerRequestHandle
```

**Purpose**: Creates a cloneable request handle for the active client.

**Data flow**: It checks whether the client is in-process or remote, obtains that implementation's request handle, and wraps it in the public enum. The output can be moved into helper tasks that only need request access.

**Call relations**: Higher-level code calls this when it wants to make requests from another component while the main client keeps ownership of event receiving and shutdown.

*Call graph*: called by 1 (request_handle); 2 external calls (InProcess, Remote).


##### `request_method_name`  (lines 930–940)

```
fn request_method_name(request: &ClientRequest) -> String
```

**Purpose**: Extracts a request's JSON-RPC method name for clearer error messages.

**Data flow**: It serializes the request to JSON, looks for the `method` field, and returns it as a string. If anything is missing or cannot be serialized, it returns `"<unknown>"`.

**Call relations**: Both full-client and request-handle `request_typed` methods call this before sending a request. The name is later included in transport, server, or decode errors.

*Call graph*: called by 2 (request_typed, request_typed); 1 external calls (to_value).


##### `tests::build_test_config`  (lines 977–984)

```
async fn build_test_config() -> Config
```

**Purpose**: Creates a usable config for tests, falling back to default loading if the builder fails.

**Data flow**: It tries to build a default config. If that fails, it loads the default config with no command-line overrides. It returns a config value suitable for starting test clients.

**Call relations**: Runtime-argument tests use this helper so they can focus on client behavior rather than config setup details.

*Call graph*: 3 external calls (new, load_default_with_cli_overrides, default).


##### `tests::build_test_config_for_codex_home`  (lines 986–1000)

```
async fn build_test_config_for_codex_home(codex_home: &Path) -> Config
```

**Purpose**: Creates test config tied to a temporary Codex home directory.

**Data flow**: It receives a path, tries to build config using that path, and falls back to loading default config for that Codex home with no overrides. It returns the resulting config.

**Call relations**: The test client startup helper calls this so each test can run with isolated filesystem state.

*Call graph*: 4 external calls (to_path_buf, new, load_default_with_cli_overrides_for_codex_home, default).


##### `tests::TestClient::deref`  (lines 1010–1012)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Lets test code use `TestClient` as if it were an `InProcessAppServerClient`.

**Data flow**: It receives a borrowed `TestClient` and returns a borrowed reference to its inner client. It does not change any state.

**Call relations**: Tests use this convenience so request methods can be called directly on `TestClient` while the wrapper still owns the temporary Codex home.


##### `tests::TestClient::shutdown`  (lines 1016–1018)

```
async fn shutdown(self) -> IoResult<()>
```

**Purpose**: Shuts down the inner in-process client owned by a test wrapper.

**Data flow**: It consumes the `TestClient`, takes its inner client, and awaits that client's shutdown. The temporary directory is then dropped with the wrapper.

**Call relations**: Tests call this at the end of in-process scenarios to clean up the embedded runtime.

*Call graph*: calls 1 internal fn (shutdown).


##### `tests::start_test_client_with_capacity`  (lines 1021–1057)

```
async fn start_test_client_with_capacity(
        session_source: SessionSource,
        channel_capacity: usize,
    ) -> TestClient
```

**Purpose**: Starts an in-process test client with a chosen event and command queue size.

**Data flow**: It creates a temporary Codex home, builds config, initializes state storage, fills startup arguments with test defaults, and starts `InProcessAppServerClient`. It returns a `TestClient` that keeps the temp directory alive.

**Call relations**: Most in-process tests use this directly or through `start_test_client`. It exercises the same startup path as production code with controlled test settings.

*Call graph*: calls 4 internal fn (start, default, default_for_tests, new); 7 external calls (new, new, new, build_test_config_for_codex_home, default, init_state_db, default).


##### `tests::start_test_client`  (lines 1059–1061)

```
async fn start_test_client(session_source: SessionSource) -> TestClient
```

**Purpose**: Starts an in-process test client using the default queue capacity.

**Data flow**: It receives a session source, passes it with the default capacity to `start_test_client_with_capacity`, and returns the resulting test client.

**Call relations**: In-process tests call this when they do not need to test queue-size edge cases.

*Call graph*: 1 external calls (start_test_client_with_capacity).


##### `tests::start_test_remote_server`  (lines 1063–1071)

```
async fn start_test_remote_server(handler: F) -> String
```

**Purpose**: Starts a simple local WebSocket test server without authentication.

**Data flow**: It receives a handler for the accepted WebSocket connection and forwards to the auth-capable helper with no expected token. It returns the WebSocket URL for the test client to connect to.

**Call relations**: Remote-client tests use this to create a fake app server that can inspect and respond to protocol messages.

*Call graph*: 1 external calls (start_test_remote_server_with_auth).


##### `tests::start_test_remote_server_with_auth`  (lines 1073–1109)

```
async fn start_test_remote_server_with_auth(
        expected_auth_token: Option<String>,
        handler: F,
    ) -> String
```

**Purpose**: Starts a local WebSocket test server and optionally checks the client's authorization header.

**Data flow**: It binds a TCP listener on localhost, spawns a task that accepts one connection, verifies the auth header if expected, upgrades to WebSocket, and runs the supplied handler. It returns the server URL.

**Call relations**: Remote connection tests use this to verify normal connection behavior and bearer-token handling.

*Call graph*: 4 external calls (bind, format!, spawn, accept_hdr_async).


##### `tests::expect_remote_initialize`  (lines 1111–1136)

```
async fn expect_remote_initialize(websocket: &mut tokio_tungstenite::WebSocketStream<S>)
```

**Purpose**: Performs the expected initialize handshake on a fake remote server.

**Data flow**: It reads the first JSON-RPC request from the WebSocket, checks that it is `initialize`, writes a response containing user agent and Codex home data, then reads the follow-up `initialized` notification. It changes the WebSocket stream by consuming and writing messages.

**Call relations**: Most remote tests call this inside their fake server handler before testing later requests, notifications, or disconnect behavior.

*Call graph*: 6 external calls (read_websocket_message, write_websocket_message, Response, assert_eq!, panic!, json!).


##### `tests::read_websocket_message`  (lines 1138–1161)

```
async fn read_websocket_message(
        websocket: &mut tokio_tungstenite::WebSocketStream<S>,
    ) -> JSONRPCMessage
```

**Purpose**: Reads the next text JSON-RPC message from a WebSocket during tests.

**Data flow**: It pulls frames from the WebSocket, ignores non-message control frames such as pings, parses text frames as JSON-RPC messages, and returns the parsed message. It panics on unexpected close or invalid test conditions.

**Call relations**: Remote test server helpers use this whenever they need to observe what the client sent.

*Call graph*: 2 external calls (next, panic!).


##### `tests::write_websocket_message`  (lines 1163–1177)

```
async fn write_websocket_message(
        websocket: &mut tokio_tungstenite::WebSocketStream<S>,
        message: JSONRPCMessage,
    )
```

**Purpose**: Writes a JSON-RPC message as a WebSocket text frame during tests.

**Data flow**: It receives a mutable WebSocket and a protocol message, serializes the message to JSON text, and sends it as a text frame. It panics if serialization or sending fails in the test.

**Call relations**: Remote fake servers use this to send responses, notifications, and server requests to the client.

*Call graph*: 3 external calls (send, to_string, Text).


##### `tests::command_execution_output_delta_notification`  (lines 1179–1188)

```
fn command_execution_output_delta_notification(delta: &str) -> ServerNotification
```

**Purpose**: Builds a test notification representing streamed command output.

**Data flow**: It receives a text delta and places it into a `CommandExecutionOutputDelta` notification with fixed thread, turn, and item IDs. The output is a server notification for tests.

**Call relations**: Backpressure tests use this as an example of best-effort output that may be dropped.

*Call graph*: 1 external calls (CommandExecutionOutputDelta).


##### `tests::agent_message_delta_notification`  (lines 1190–1199)

```
fn agent_message_delta_notification(delta: &str) -> ServerNotification
```

**Purpose**: Builds a test notification representing streamed assistant text.

**Data flow**: It receives a text delta and packages it into an `AgentMessageDelta` notification with fixed IDs. The output is a server notification for tests.

**Call relations**: Backpressure tests use this as a must-deliver transcript event.

*Call graph*: 1 external calls (AgentMessageDelta).


##### `tests::item_completed_notification`  (lines 1201–1213)

```
fn item_completed_notification(text: &str) -> ServerNotification
```

**Purpose**: Builds a test notification saying an assistant message item is complete.

**Data flow**: It receives final text, creates an agent-message thread item, and wraps it in an `ItemCompleted` notification. The output is a server notification for tests.

**Call relations**: Backpressure tests use this to confirm completed transcript items are preserved.

*Call graph*: 1 external calls (ItemCompleted).


##### `tests::turn_completed_notification`  (lines 1215–1229)

```
fn turn_completed_notification() -> ServerNotification
```

**Purpose**: Builds a test notification saying a turn finished successfully.

**Data flow**: It constructs a completed turn with fixed IDs and wraps it in a `TurnCompleted` notification. The output is a server notification for tests.

**Call relations**: Backpressure tests use this to confirm terminal completion signals are never dropped.

*Call graph*: 2 external calls (TurnCompleted, new).


##### `tests::test_remote_connect_args`  (lines 1231–1243)

```
fn test_remote_connect_args(websocket_url: String) -> RemoteAppServerConnectArgs
```

**Purpose**: Creates standard connection settings for remote-client tests.

**Data flow**: It receives a WebSocket URL and fills in test client identity, experimental API setting, empty notification opt-outs, no auth token, and a small queue capacity. It returns remote connection arguments.

**Call relations**: Most remote tests call this before connecting `RemoteAppServerClient` to a fake server.

*Call graph*: 1 external calls (new).


##### `tests::typed_request_roundtrip_works`  (lines 1246–1256)

```
async fn typed_request_roundtrip_works()
```

**Purpose**: Checks that an in-process typed request can be sent and decoded successfully.

**Data flow**: It starts a test client, sends a config-requirements read request, expects a typed response, and shuts the client down.

**Call relations**: This verifies the main `InProcessAppServerClient::request_typed` path against the embedded runtime.

*Call graph*: 2 external calls (start_test_client, Integer).


##### `tests::typed_request_reports_json_rpc_errors`  (lines 1259–1276)

```
async fn typed_request_reports_json_rpc_errors()
```

**Purpose**: Checks that server-side JSON-RPC failures become useful typed request errors.

**Data flow**: It starts a client, requests a missing thread, expects an error, and checks that the message includes the protocol method name. It then shuts down the client.

**Call relations**: This tests the error-mapping path used by typed requests.

*Call graph*: 3 external calls (start_test_client, Integer, assert!).


##### `tests::caller_provided_session_source_is_applied`  (lines 1279–1298)

```
async fn caller_provided_session_source_is_applied()
```

**Purpose**: Verifies that the session source supplied at startup is recorded on new threads.

**Data flow**: It starts clients with different session sources, starts ephemeral threads, and checks that each returned thread reports the expected source. Each client is shut down afterward.

**Call relations**: This protects the startup argument flow from `InProcessClientStartArgs` into the app-server runtime.

*Call graph*: 4 external calls (start_test_client, Integer, default, assert_eq!).


##### `tests::threads_started_via_app_server_are_visible_through_typed_requests`  (lines 1301–1329)

```
async fn threads_started_via_app_server_are_visible_through_typed_requests()
```

**Purpose**: Checks that a thread started through the app-server API can be read back through the same API.

**Data flow**: It starts a client, sends a thread-start request, then sends a thread-read request for the returned thread ID. It compares the IDs and shuts down.

**Call relations**: This verifies that typed request flow works across multiple related app-server methods.

*Call graph*: 4 external calls (start_test_client, Integer, default, assert_eq!).


##### `tests::tiny_channel_capacity_still_supports_request_roundtrip`  (lines 1332–1343)

```
async fn tiny_channel_capacity_still_supports_request_roundtrip()
```

**Purpose**: Ensures the client still works when queues are as small as one item.

**Data flow**: It starts an in-process client with capacity one, sends a typed config request, expects success, and shuts down.

**Call relations**: This guards the queue setup in `InProcessAppServerClient::start`, especially the minimum-capacity behavior.

*Call graph*: 2 external calls (start_test_client_with_capacity, Integer).


##### `tests::forward_in_process_event_preserves_transcript_notifications_under_backpressure`  (lines 1346–1431)

```
async fn forward_in_process_event_preserves_transcript_notifications_under_backpressure()
```

**Purpose**: Tests that important transcript and completion notifications are delivered even when the event queue is full.

**Data flow**: It fills a one-item event queue, tries to forward a best-effort command-output event that gets skipped, then forwards must-deliver assistant and completion events. It reads back the queued events and checks for a lag marker followed by preserved transcript events.

**Call relations**: This directly exercises `forward_in_process_event` and the must-deliver classification helpers.

*Call graph*: calls 1 internal fn (forward_in_process_event); 12 external calls (from_secs, new, agent_message_delta_notification, command_execution_output_delta_notification, item_completed_notification, turn_completed_notification, ServerNotification, assert!, assert_eq!, channel (+2 more)).


##### `tests::remote_typed_request_roundtrip_works`  (lines 1434–1475)

```
async fn remote_typed_request_roundtrip_works()
```

**Purpose**: Checks that a remote WebSocket client can initialize, send a typed request, and decode the response.

**Data flow**: It starts a fake WebSocket server, performs initialize, expects an account-read request, sends an account response, and verifies the client decodes it and records server metadata.

**Call relations**: This tests the remote client exported by this crate alongside the shared typed request behavior.

*Call graph*: calls 1 internal fn (connect); 4 external calls (start_test_remote_server, test_remote_connect_args, Integer, assert_eq!).


##### `tests::remote_unix_socket_typed_request_roundtrip_works`  (lines 1478–1533)

```
async fn remote_unix_socket_typed_request_roundtrip_works()
```

**Purpose**: Checks the remote client over a Unix socket WebSocket connection.

**Data flow**: It creates a temporary Unix socket listener, accepts a WebSocket connection, performs initialize, answers an account-read request, and verifies the client receives the typed response.

**Call relations**: This covers the non-TCP remote endpoint path exposed by the remote module.

*Call graph*: calls 3 internal fn (connect, bind, from_absolute_path); 12 external calls (new, new, expect_remote_initialize, read_websocket_message, write_websocket_message, Response, Integer, assert_eq!, panic!, to_value (+2 more)).


##### `tests::remote_typed_request_accepts_large_single_frame_response`  (lines 1536–1582)

```
async fn remote_typed_request_accepts_large_single_frame_response()
```

**Purpose**: Verifies that a large remote response frame can be received and decoded.

**Data flow**: It starts a fake server that returns an account response with large extra padding. The client sends an account request, ignores irrelevant extra data during typed decoding, and verifies the meaningful fields.

**Call relations**: This protects remote transport limits and response decoding for large server messages.

*Call graph*: calls 1 internal fn (connect); 4 external calls (start_test_remote_server, test_remote_connect_args, Integer, assert_eq!).


##### `tests::remote_connect_includes_auth_header_when_configured`  (lines 1585–1610)

```
async fn remote_connect_includes_auth_header_when_configured()
```

**Purpose**: Checks that remote WebSocket connections include a bearer token when configured.

**Data flow**: It starts a fake server expecting an authorization header, connects a remote client with a token, performs initialize, and shuts down.

**Call relations**: This tests the authentication part of remote connection setup.

*Call graph*: calls 1 internal fn (connect); 2 external calls (new, start_test_remote_server_with_auth).


##### `tests::remote_connect_rejects_non_loopback_ws_when_auth_configured`  (lines 1613–1635)

```
async fn remote_connect_rejects_non_loopback_ws_when_auth_configured()
```

**Purpose**: Ensures bearer tokens are not sent over unsafe non-loopback plain WebSocket URLs.

**Data flow**: It tries to connect to a non-local `ws://` URL with an auth token. It expects connection setup to fail before network use and checks the error kind and message.

**Call relations**: This protects the remote transport security policy enforced by the remote module.

*Call graph*: calls 1 internal fn (connect); 4 external calls (new, assert!, assert_eq!, panic!).


##### `tests::remote_auth_token_transport_policy_allows_wss_and_loopback_ws`  (lines 1638–1648)

```
fn remote_auth_token_transport_policy_allows_wss_and_loopback_ws()
```

**Purpose**: Checks the URL policy for when auth tokens may be used.

**Data flow**: It tests secure `wss://`, loopback `ws://`, and non-loopback `ws://` URLs. It expects the first two to be allowed and the last to be rejected.

**Call relations**: This unit test covers the remote module's helper that decides whether a WebSocket URL is safe for bearer-token use.

*Call graph*: 1 external calls (assert!).


##### `tests::remote_duplicate_request_id_keeps_original_waiter`  (lines 1651–1736)

```
async fn remote_duplicate_request_id_keeps_original_waiter()
```

**Purpose**: Verifies that a duplicate remote request ID is rejected without stealing the first request's response.

**Data flow**: It starts a fake server, sends one request through a cloned handle, waits until the server sees it, then sends another request with the same ID. The second fails locally, and the first still receives the server response.

**Call relations**: This protects remote request tracking so concurrent callers cannot corrupt each other's waiters.

*Call graph*: calls 1 internal fn (connect); 6 external calls (start_test_remote_server, test_remote_connect_args, Integer, assert_eq!, spawn, channel).


##### `tests::remote_notifications_arrive_over_websocket`  (lines 1739–1771)

```
async fn remote_notifications_arrive_over_websocket()
```

**Purpose**: Checks that server notifications sent over a remote WebSocket become client events.

**Data flow**: A fake server initializes, sends an account-updated notification, and the client waits for the next event. The test verifies the event contains that notification.

**Call relations**: This covers the remote event path used by `AppServerClient::next_event` for remote clients.

*Call graph*: calls 1 internal fn (connect); 3 external calls (start_test_remote_server, test_remote_connect_args, assert!).


##### `tests::remote_backpressure_preserves_transcript_notifications`  (lines 1774–1868)

```
async fn remote_backpressure_preserves_transcript_notifications()
```

**Purpose**: Tests that remote event backpressure follows the same must-deliver rules as in-process events.

**Data flow**: A fake server sends best-effort command output and must-deliver transcript/completion notifications into a client with capacity one. The test drains events and verifies the transcript events appear, with either the second best-effort event or a lag marker accounting for pressure.

**Call relations**: This ensures the remote transport shares the delivery classification from this file.

*Call graph*: calls 1 internal fn (connect); 10 external calls (from_secs, new, start_test_remote_server, test_remote_connect_args, assert!, assert_eq!, matches!, panic!, channel, timeout).


##### `tests::remote_server_request_resolution_roundtrip_works`  (lines 1871–1923)

```
async fn remote_server_request_resolution_roundtrip_works()
```

**Purpose**: Checks that a remote server request can be delivered to the client and answered.

**Data flow**: A fake server sends a user-input request. The client receives it as an event and calls resolve with an empty JSON result. The server then reads the JSON-RPC response with the same request ID.

**Call relations**: This verifies the remote version of server-request handling exposed through the public client API.

*Call graph*: calls 1 internal fn (connect); 4 external calls (start_test_remote_server, test_remote_connect_args, panic!, json!).


##### `tests::remote_server_request_received_during_initialize_is_delivered`  (lines 1926–2001)

```
async fn remote_server_request_received_during_initialize_is_delivered()
```

**Purpose**: Ensures server requests that arrive during the initialize handshake are not lost.

**Data flow**: The fake server sends a server request before replying to initialize, then finishes the handshake. The client later receives the request event and resolves it, and the server observes the response.

**Call relations**: This protects an ordering edge case in remote startup where messages can arrive before initialization fully completes.

*Call graph*: calls 1 internal fn (connect); 4 external calls (start_test_remote_server, test_remote_connect_args, panic!, json!).


##### `tests::remote_unknown_server_request_is_rejected`  (lines 2004–2036)

```
async fn remote_unknown_server_request_is_rejected()
```

**Purpose**: Checks that unsupported remote server request methods are rejected with a JSON-RPC method-not-found error.

**Data flow**: A fake server sends a request with an unknown method. The client does not surface it for handling; instead, the server receives an error response with the original ID.

**Call relations**: This verifies defensive behavior in the remote request decoder.

*Call graph*: calls 1 internal fn (connect); 2 external calls (start_test_remote_server, test_remote_connect_args).


##### `tests::remote_disconnect_surfaces_as_event`  (lines 2039–2054)

```
async fn remote_disconnect_surfaces_as_event()
```

**Purpose**: Checks that a remote server disconnect is reported as a client event.

**Data flow**: A fake server initializes and then closes the WebSocket. The client waits for the next event and expects a disconnected event.

**Call relations**: This protects the remote event loop behavior that lets user interfaces react to lost server connections.

*Call graph*: calls 1 internal fn (connect); 3 external calls (start_test_remote_server, test_remote_connect_args, assert!).


##### `tests::typed_request_error_exposes_sources`  (lines 2057–2084)

```
fn typed_request_error_exposes_sources()
```

**Purpose**: Tests how `TypedRequestError` formats and exposes underlying causes.

**Data flow**: It creates transport, server, and decode error variants, checks which ones expose a source error, and verifies the formatted server error includes code and data.

**Call relations**: This covers the `Display` and `Error` implementations for typed request failures.

*Call graph*: 3 external calls (new, assert_eq!, json!).


##### `tests::next_event_surfaces_lagged_markers`  (lines 2087–2112)

```
async fn next_event_surfaces_lagged_markers()
```

**Purpose**: Checks that lag markers placed in the in-process event queue are returned by `next_event`.

**Data flow**: It builds a minimal client with a preloaded lagged event, calls `next_event`, verifies the marker is received, and then shuts down the client.

**Call relations**: This confirms that event consumers can see overload notifications emitted by the worker.

*Call graph*: 5 external calls (from_secs, assert!, channel, spawn, timeout).


##### `tests::event_requires_delivery_marks_transcript_and_terminal_events`  (lines 2115–2189)

```
fn event_requires_delivery_marks_transcript_and_terminal_events()
```

**Purpose**: Verifies the must-deliver event classification.

**Data flow**: It constructs several important notifications and checks they require delivery, then checks lag markers and command-output deltas do not. The output is test assertions only.

**Call relations**: This protects `event_requires_delivery` and `server_notification_requires_delivery`, which are central to backpressure behavior.

*Call graph*: 1 external calls (assert!).


##### `tests::runtime_start_args_forward_environment_manager`  (lines 2192–2242)

```
async fn runtime_start_args_forward_environment_manager()
```

**Purpose**: Checks that startup conversion preserves the configured environment manager.

**Data flow**: It builds config and a test environment manager, converts client startup args into runtime args, and verifies the same shared manager is present and still describes a remote default environment.

**Call relations**: This covers `InProcessClientStartArgs::into_runtime_start_args`, especially the field forwarding needed by execution and filesystem operations.

*Call graph*: calls 4 internal fn (default, create_for_tests, new, new); 8 external calls (new, new, build_test_config, default, assert!, assert_eq!, default, current_exe).


##### `tests::runtime_start_args_use_remote_thread_config_loader_when_configured`  (lines 2245–2280)

```
async fn runtime_start_args_use_remote_thread_config_loader_when_configured()
```

**Purpose**: Checks that setting an experimental thread-config endpoint creates a remote thread config loader.

**Data flow**: It builds config with an endpoint, converts startup args, then tries to load thread config. Because the endpoint is intentionally invalid, the resulting request-failed error proves the remote loader was used.

**Call relations**: This tests `configured_thread_config_loader` through the runtime-start-args conversion.

*Call graph*: calls 3 internal fn (default, default_for_tests, new); 7 external calls (new, default, new, build_test_config, default, assert_eq!, default).


##### `tests::shutdown_completes_promptly_without_retained_managers`  (lines 2283–2290)

```
async fn shutdown_completes_promptly_without_retained_managers()
```

**Purpose**: Ensures client shutdown does not wait for the full fallback timeout in normal test conditions.

**Data flow**: It starts a test client, wraps shutdown in a one-second timeout, and expects shutdown to finish successfully within that time.

**Call relations**: This guards the bounded shutdown path in `InProcessAppServerClient::shutdown`.

*Call graph*: 3 external calls (from_secs, start_test_client, timeout).


### `app-server-client/src/remote.rs`

`io_transport` · `connection setup, request handling, event streaming, shutdown`

This file is the bridge between the app and a remote app server. Without it, callers such as a terminal interface would need to know about WebSockets, connection handshakes, JSON-RPC message shapes, request IDs, and reconnect-style failure reporting. Here, all of that is wrapped behind `RemoteAppServerClient`.

The connection starts by choosing an endpoint: a normal WebSocket URL, or a Unix socket on the same machine. The client opens the socket, upgrades it to WebSocket, and sends an `initialize` request. That handshake tells the server who the client is and what features it wants. Any server messages that arrive during this startup are saved so the caller can read them later instead of losing them.

After startup, a background worker task owns the actual WebSocket. Think of it like a mailroom clerk: callers hand it outgoing requests and notifications through an internal channel, and it reads incoming server messages from the wire. It matches replies to the original request by ID, turns server notifications into `AppServerEvent` values, and forwards server-initiated requests so higher-level code can answer them. It also reports disconnections as events, so users see a clear failure instead of a silent hang.

The file also enforces a few safety rules, such as only sending authorization tokens over secure WebSockets or local loopback connections.

#### Function details

##### `RemoteAppServerConnectArgs::initialize_params`  (lines 93–112)

```
fn initialize_params(&self) -> InitializeParams
```

**Purpose**: Builds the startup information sent to the server during the initial handshake. It includes the client name, version, feature flags, and any notification methods the client does not want to receive.

**Data flow**: It reads the connection arguments already stored in `RemoteAppServerConnectArgs` → copies them into the protocol's `InitializeParams` shape → returns those parameters for the connection code to send to the server.

**Call relations**: `RemoteAppServerClient::connect` calls this before opening the remote session, so the handshake has a ready-made description of this client.

*Call graph*: called by 1 (connect).


##### `websocket_url_supports_auth_token`  (lines 115–123)

```
fn websocket_url_supports_auth_token(url: &Url) -> bool
```

**Purpose**: Decides whether it is safe to attach an authorization token to a WebSocket URL. Tokens are allowed for encrypted `wss://` URLs, or for plain `ws://` only when the target is the local machine.

**Data flow**: It receives a parsed URL → checks its scheme and host → returns `true` when the token would not be sent over an unsafe remote plain-text connection, otherwise `false`.

**Call relations**: `connect_websocket_endpoint` uses this as a guard before adding an authorization header, preventing accidental token leaks to non-local unencrypted WebSocket servers.

*Call graph*: called by 1 (connect_websocket_endpoint); 2 external calls (host, scheme).


##### `RemoteAppServerClient::connect`  (lines 164–183)

```
async fn connect(args: RemoteAppServerConnectArgs) -> IoResult<Self>
```

**Purpose**: Creates a remote app-server client from user-provided connection settings. It chooses the right transport, opens it, performs startup, and returns a client ready to send requests and receive events.

**Data flow**: It receives connection arguments → builds initialization parameters → connects either to a WebSocket URL or a Unix socket → passes the open WebSocket stream into the shared setup path → returns a `RemoteAppServerClient` or an input/connection error.

**Call relations**: This is the public entry into the remote transport. It calls `RemoteAppServerConnectArgs::initialize_params`, then either `connect_websocket_endpoint` or `connect_unix_socket_endpoint`, and finally hands the stream to `connect_with_stream`. Many remote-transport tests exercise behavior through this method.

*Call graph*: calls 3 internal fn (initialize_params, connect_unix_socket_endpoint, connect_websocket_endpoint); called by 13 (remote_backpressure_preserves_transcript_notifications, remote_connect_includes_auth_header_when_configured, remote_connect_rejects_non_loopback_ws_when_auth_configured, remote_disconnect_surfaces_as_event, remote_duplicate_request_id_keeps_original_waiter, remote_notifications_arrive_over_websocket, remote_server_request_received_during_initialize_is_delivered, remote_server_request_resolution_roundtrip_works, remote_typed_request_accepts_large_single_frame_response, remote_typed_request_roundtrip_works (+3 more)); 1 external calls (connect_with_stream).


##### `RemoteAppServerClient::server_version`  (lines 185–187)

```
fn server_version(&self) -> Option<&str>
```

**Purpose**: Returns the server version learned during the initialize handshake, if the server provided one. Callers can use this for display, diagnostics, or compatibility checks.

**Data flow**: It reads the stored optional server version from the client → exposes it as an optional borrowed string → changes nothing.

**Call relations**: This is a simple accessor used after `connect_with_stream` has stored handshake metadata on the client.


##### `RemoteAppServerClient::codex_home`  (lines 189–191)

```
fn codex_home(&self) -> Option<&str>
```

**Purpose**: Returns the server's Codex home directory, if the server reported one during initialization. This lets higher-level code know which remote workspace or configuration area the server is using.

**Data flow**: It reads the stored optional `codex_home` value → exposes it as an optional borrowed string → changes nothing.

**Call relations**: This accessor depends on metadata extracted by `initialize_remote_connection` and stored when the client is built.


##### `RemoteAppServerClient::connect_with_stream`  (lines 193–483)

```
async fn connect_with_stream(
        channel_capacity: usize,
        endpoint: String,
        stream: WebSocketStream<S>,
        initialize_params: InitializeParams,
    ) -> IoResult<Self>
```

**Purpose**: Finishes setting up a remote client once a WebSocket stream already exists. It runs the initialize handshake and starts the background worker that routes all later messages.

**Data flow**: It receives a WebSocket stream, endpoint label, channel size, and initialize parameters → sends and waits for the startup handshake → creates command and event channels → starts a background task that writes outgoing commands and reads incoming WebSocket messages → returns a client containing those channels, saved startup events, server metadata, and the worker task handle.

**Call relations**: `RemoteAppServerClient::connect` reaches this after choosing and opening the transport. Inside, it calls `initialize_remote_connection`, creates channels, and spawns the worker task that the client methods later talk to.

*Call graph*: calls 1 internal fn (initialize_remote_connection); 4 external calls (new, new, select!, spawn).


##### `RemoteAppServerClient::request_handle`  (lines 485–489)

```
fn request_handle(&self) -> RemoteAppServerRequestHandle
```

**Purpose**: Creates a lightweight request sender that can be cloned and used without holding the full client object. This is useful when some part of the program only needs to send requests, not read events or shut down the connection.

**Data flow**: It reads the client's command-sending channel → clones that sender → returns a `RemoteAppServerRequestHandle` that can submit requests to the same background worker.

**Call relations**: `RemoteAppServerClient::request` uses this helper for its own request path, and other code can keep the handle for request-only access while the main client continues receiving events.

*Call graph*: called by 1 (request); 1 external calls (clone).


##### `RemoteAppServerClient::request`  (lines 491–493)

```
async fn request(&self, request: ClientRequest) -> IoResult<RequestResult>
```

**Purpose**: Sends one client request to the remote server and waits for the server's JSON-RPC result or error. It is the simple request API on the full client.

**Data flow**: It receives a typed `ClientRequest` → gets a request handle → forwards the request through that handle → returns either a transport error, or the server's success/error response.

**Call relations**: This is a convenience layer over `RemoteAppServerRequestHandle::request`. `RemoteAppServerClient::request_typed` calls it when it wants a response decoded into a specific Rust type.

*Call graph*: calls 1 internal fn (request_handle); called by 1 (request_typed).


##### `RemoteAppServerClient::request_typed`  (lines 495–513)

```
async fn request_typed(&self, request: ClientRequest) -> Result<T, TypedRequestError>
```

**Purpose**: Sends a request and turns a successful JSON response into a caller-chosen data type. It separates three kinds of failure: transport failure, server-declared error, and response data that does not match the expected shape.

**Data flow**: It receives a typed request and the expected output type → records the method name for clearer errors → sends the request → if the server returned success, deserializes the JSON value into `T` → returns the typed value or a detailed `TypedRequestError`.

**Call relations**: It builds on `RemoteAppServerClient::request`, uses the shared `request_method_name` helper for readable error labels, and uses JSON deserialization to produce the final typed result.

*Call graph*: calls 1 internal fn (request); 2 external calls (request_method_name, from_value).


##### `RemoteAppServerClient::notify`  (lines 515–535)

```
async fn notify(&self, notification: ClientNotification) -> IoResult<()>
```

**Purpose**: Sends a client notification to the server. A notification is a one-way message: the server is not expected to send a JSON-RPC response.

**Data flow**: It receives a `ClientNotification` → creates a one-use reply channel so the worker can report whether writing succeeded → sends a `Notify` command to the worker → returns success if the message was written, or an I/O error if the worker or connection failed.

**Call relations**: This method talks to the background worker through the command channel. The worker converts the notification to JSON-RPC and writes it to the WebSocket.

*Call graph*: 2 external calls (send, channel).


##### `RemoteAppServerClient::resolve_server_request`  (lines 537–562)

```
async fn resolve_server_request(
        &self,
        request_id: RequestId,
        result: JsonRpcResult,
    ) -> IoResult<()>
```

**Purpose**: Sends a successful answer to a request that the server previously sent to the client. This completes a server-initiated JSON-RPC request.

**Data flow**: It receives the server's request ID and a JSON result → packages them into a worker command → waits for the worker to write the response message → returns success or an I/O error.

**Call relations**: When `next_event` delivers an `AppServerEvent::ServerRequest`, higher-level code can process that request and then call this method to answer it.

*Call graph*: 2 external calls (send, channel).


##### `RemoteAppServerClient::reject_server_request`  (lines 564–589)

```
async fn reject_server_request(
        &self,
        request_id: RequestId,
        error: JSONRPCErrorError,
    ) -> IoResult<()>
```

**Purpose**: Sends an error answer to a request that the server previously sent to the client. This is used when the client cannot or will not fulfill the server's request.

**Data flow**: It receives the server's request ID and a JSON-RPC error object → sends a reject command to the worker → waits for the worker to write the error response → returns success or an I/O error.

**Call relations**: This is the failure-side partner to `resolve_server_request`. It lets higher-level event handling close the loop after receiving a server request.

*Call graph*: 2 external calls (send, channel).


##### `RemoteAppServerClient::next_event`  (lines 591–596)

```
async fn next_event(&mut self) -> Option<AppServerEvent>
```

**Purpose**: Waits for the next event coming from the remote server. Events include server notifications, server-initiated requests, and disconnection notices.

**Data flow**: It first checks events saved during initialization → if one exists, returns it immediately → otherwise waits on the live event channel from the worker → returns the next event, or `None` if the stream has ended.

**Call relations**: Callers use this as the receiving side of the remote client. It combines startup-time events from `initialize_remote_connection` with later events delivered by the background worker.

*Call graph*: 2 external calls (recv, pop_front).


##### `RemoteAppServerClient::shutdown`  (lines 598–624)

```
async fn shutdown(self) -> IoResult<()>
```

**Purpose**: Closes the remote client cleanly without hanging forever. It asks the worker to close the WebSocket, waits briefly, and aborts the worker if it does not finish in time.

**Data flow**: It consumes the client → drops the event receiver → sends a shutdown command to the worker → waits up to the configured shutdown timeout for the close result and worker completion → returns success unless the close itself reported a real error.

**Call relations**: This is the teardown path for the remote transport. A test in this file checks that shutdown still completes if the worker exits after the shutdown command is queued.

*Call graph*: 2 external calls (channel, timeout).


##### `RemoteAppServerRequestHandle::request`  (lines 628–631)

```
async fn request(&self, request: ClientRequest) -> IoResult<RequestResult>
```

**Purpose**: Sends a typed client request through a request-only handle. It is the handle's convenient version of the request API.

**Data flow**: It receives a `ClientRequest` → converts it into a raw JSON-RPC request → sends it through `request_json_rpc` → returns the server's result or error wrapped in the transport result.

**Call relations**: `RemoteAppServerRequestHandle::request_typed` calls this before decoding a typed response. The full client can also create this handle through `request_handle`.

*Call graph*: calls 2 internal fn (request_json_rpc, jsonrpc_request_from_client_request); called by 1 (request_typed).


##### `RemoteAppServerRequestHandle::request_json_rpc`  (lines 633–653)

```
async fn request_json_rpc(&self, request: JSONRPCRequest) -> IoResult<RequestResult>
```

**Purpose**: Sends an already-formed JSON-RPC request to the worker and waits for the matching response. This is the lower-level request path used when the caller already has protocol-shaped data.

**Data flow**: It receives a `JSONRPCRequest` → creates a one-use response channel → sends a `Request` command to the background worker → waits until the worker receives the server response with the same request ID → returns that response or an I/O error if communication broke.

**Call relations**: `RemoteAppServerRequestHandle::request` uses this after converting a typed client request. The background worker keeps the request ID in its pending map so it can send the right response back to this waiting call.

*Call graph*: called by 1 (request); 3 external calls (new, send, channel).


##### `RemoteAppServerRequestHandle::request_typed`  (lines 655–673)

```
async fn request_typed(&self, request: ClientRequest) -> Result<T, TypedRequestError>
```

**Purpose**: Sends a request through a request-only handle and decodes the successful JSON response into a caller-chosen type. It gives clearer errors by saying whether the problem was transport, server rejection, or bad response shape.

**Data flow**: It receives a `ClientRequest` and expected type `T` → sends the request → unwraps the server result if successful → deserializes the JSON value into `T` → returns the typed value or a `TypedRequestError`.

**Call relations**: This mirrors `RemoteAppServerClient::request_typed`, but works from a cloned request handle instead of the full client.

*Call graph*: calls 1 internal fn (request); 2 external calls (request_method_name, from_value).


##### `connect_websocket_endpoint`  (lines 676–737)

```
async fn connect_websocket_endpoint(
    websocket_url: String,
    auth_token: Option<String>,
) -> IoResult<(String, WebSocketStream<MaybeTlsStream<TcpStream>>)>
```

**Purpose**: Opens a remote WebSocket connection over TCP, optionally adding a bearer authorization token. It validates the URL and applies safety checks before connecting.

**Data flow**: It receives a WebSocket URL string and optional token → parses and validates the URL → refuses unsafe token use → builds the WebSocket handshake request, adding an authorization header when allowed → ensures TLS crypto support is ready → connects with a timeout and configured message limits → returns the endpoint label and open WebSocket stream.

**Call relations**: `RemoteAppServerClient::connect` calls this for `RemoteAppServerEndpoint::WebSocket`. It uses `websocket_url_supports_auth_token` for token safety and `remote_websocket_config` for frame/message size limits.

*Call graph*: calls 2 internal fn (remote_websocket_config, websocket_url_supports_auth_token); called by 1 (connect); 7 external calls (from_str, parse, new, ensure_rustls_crypto_provider, format!, timeout, connect_async_with_config).


##### `connect_unix_socket_endpoint`  (lines 739–784)

```
async fn connect_unix_socket_endpoint(
    socket_path: AbsolutePathBuf,
) -> IoResult<(String, WebSocketStream<UnixStream>)>
```

**Purpose**: Opens a local Unix socket and upgrades it to a WebSocket session. This lets the same JSON-RPC-over-WebSocket code work for local socket files as well as network URLs.

**Data flow**: It receives an absolute socket path → builds a human-readable `unix://...` endpoint label → connects to the socket with a timeout → performs a WebSocket handshake over that socket using a placeholder URL → returns the endpoint label and open WebSocket stream.

**Call relations**: `RemoteAppServerClient::connect` calls this for `RemoteAppServerEndpoint::UnixSocket`. It shares `remote_websocket_config` with the TCP WebSocket path so both transports have the same message limits.

*Call graph*: calls 3 internal fn (remote_websocket_config, connect, as_path); called by 1 (connect); 3 external calls (format!, timeout, client_async_with_config).


##### `remote_websocket_config`  (lines 786–790)

```
fn remote_websocket_config() -> WebSocketConfig
```

**Purpose**: Creates the WebSocket settings used for remote app-server connections. Its main job is to allow large enough messages for this protocol while still setting an explicit limit.

**Data flow**: It starts from the WebSocket library's default configuration → sets maximum frame and message sizes to the remote app-server limit → returns the finished configuration.

**Call relations**: Both `connect_websocket_endpoint` and `connect_unix_socket_endpoint` call this before starting their WebSocket sessions.

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

**Purpose**: Performs the required startup handshake with the remote app server. It sends `initialize`, waits for the matching response, saves any early events, and then sends `initialized`.

**Data flow**: It receives an open WebSocket stream, endpoint label, initialization parameters, and timeout → writes an `initialize` JSON-RPC request → reads messages until the matching response arrives or an error/timeout occurs → collects notifications and server requests that arrive early → extracts server version and Codex home from the response → sends the final `initialized` notification → returns saved events plus metadata.

**Call relations**: `connect_with_stream` calls this before starting the long-running worker. It uses conversion helpers for client requests and notifications, `app_server_event_from_notification` for early notifications, and `write_jsonrpc_message` for outgoing protocol messages.

*Call graph*: calls 4 internal fn (app_server_event_from_notification, jsonrpc_notification_from_client_notification, jsonrpc_request_from_client_request, write_jsonrpc_message); called by 1 (connect_with_stream); 13 external calls (try_from, new, next, ServerRequest, Error, Notification, Request, String, new, other (+3 more)).


##### `app_server_event_from_notification`  (lines 936–941)

```
fn app_server_event_from_notification(notification: JSONRPCNotification) -> Option<AppServerEvent>
```

**Purpose**: Turns a raw JSON-RPC notification from the server into the app client's common event type, when it is a notification this client understands. Unknown notifications are ignored.

**Data flow**: It receives a `JSONRPCNotification` → tries to decode it as a known `ServerNotification` → wraps it as `AppServerEvent::ServerNotification` on success → returns `None` if the notification is not recognized.

**Call relations**: `initialize_remote_connection` uses this for notifications that arrive during startup, and the background worker uses the same idea when streaming later notifications to the event receiver.

*Call graph*: called by 1 (initialize_remote_connection); 2 external calls (try_from, ServerNotification).


##### `deliver_event`  (lines 943–953)

```
fn deliver_event(
    event_tx: &mpsc::UnboundedSender<AppServerEvent>,
    event: AppServerEvent,
) -> IoResult<()>
```

**Purpose**: Sends an `AppServerEvent` to the part of the program that is waiting for remote server events. It turns a closed event channel into a normal I/O-style error.

**Data flow**: It receives an event sender and an event → tries to place the event on the channel → returns success if the receiver is still alive, or a broken-pipe error if the consumer has gone away.

**Call relations**: The background worker relies on this whenever it needs to report server notifications, server requests, or disconnections to `RemoteAppServerClient::next_event`.

*Call graph*: 1 external calls (send).


##### `jsonrpc_request_from_client_request`  (lines 955–964)

```
fn jsonrpc_request_from_client_request(request: ClientRequest) -> JSONRPCRequest
```

**Purpose**: Converts the project's typed client request enum into the raw JSON-RPC request shape used on the wire. It assumes these internal protocol types are correctly serializable.

**Data flow**: It receives a `ClientRequest` → serializes it to a generic JSON value → deserializes that value as a `JSONRPCRequest` → returns the raw request, or panics if the protocol definitions are internally inconsistent.

**Call relations**: `RemoteAppServerRequestHandle::request` uses this for normal outgoing requests, and `initialize_remote_connection` uses it to build the startup `initialize` request.

*Call graph*: called by 2 (request, initialize_remote_connection); 3 external calls (panic!, from_value, to_value).


##### `jsonrpc_notification_from_client_notification`  (lines 966–977)

```
fn jsonrpc_notification_from_client_notification(
    notification: ClientNotification,
) -> JSONRPCNotification
```

**Purpose**: Converts the project's typed client notification enum into the raw JSON-RPC notification shape sent over the WebSocket.

**Data flow**: It receives a `ClientNotification` → serializes it to a generic JSON value → deserializes that value as a `JSONRPCNotification` → returns the raw notification, or panics if the internal protocol definitions do not line up.

**Call relations**: `initialize_remote_connection` uses this for the `initialized` notification, and the worker uses the same conversion path when sending client notifications.

*Call graph*: called by 1 (initialize_remote_connection); 3 external calls (panic!, from_value, to_value).


##### `write_jsonrpc_message`  (lines 979–996)

```
async fn write_jsonrpc_message(
    stream: &mut WebSocketStream<S>,
    message: JSONRPCMessage,
    endpoint: &str,
) -> IoResult<()>
```

**Purpose**: Serializes one JSON-RPC message and writes it as a WebSocket text frame. This is the final step before a request, response, error, or notification leaves the client.

**Data flow**: It receives a mutable WebSocket stream, a `JSONRPCMessage`, and an endpoint label for error text → converts the message to a JSON string → sends that string as a WebSocket text message → returns success or an I/O error describing the failed endpoint.

**Call relations**: `initialize_remote_connection` calls this during the handshake, and the background worker uses the same writing behavior for normal traffic after connection setup.

*Call graph*: called by 1 (initialize_remote_connection); 3 external calls (send, to_string, Text).


##### `websocket_close_error_is_already_closed`  (lines 998–1007)

```
fn websocket_close_error_is_already_closed(err: &TungsteniteError) -> bool
```

**Purpose**: Recognizes close errors that simply mean the WebSocket is already gone. This prevents shutdown from treating harmless double-close situations as real failures.

**Data flow**: It receives a WebSocket library error → checks whether it is an already-closed connection or a matching low-level socket error → returns `true` for harmless closed states and `false` for other errors.

**Call relations**: The shutdown command handling in the worker uses this when closing the WebSocket, so normal race conditions during teardown do not become noisy errors.

*Call graph*: 1 external calls (matches!).


##### `tests::shutdown_tolerates_worker_exit_after_command_is_queued`  (lines 1013–1032)

```
async fn shutdown_tolerates_worker_exit_after_command_is_queued()
```

**Purpose**: Tests that client shutdown succeeds even if the background worker exits right after receiving the shutdown command. This guards against a race condition during teardown.

**Data flow**: It creates a fake command channel, event channel, and worker task → builds a `RemoteAppServerClient` around them → calls `shutdown` → expects shutdown to complete without error even though the worker does not send a normal close response.

**Call relations**: This test exercises `RemoteAppServerClient::shutdown` directly and documents the intended behavior for a worker that disappears during shutdown.

*Call graph*: 3 external calls (new, channel, spawn).


### `tui/src/app_server_session.rs`

`io_transport` · `startup, main loop, and request handling`

The terminal UI should not have to know the exact JSON-RPC messages used to talk to the app server. JSON-RPC is a message format where each request names a method and carries structured data. This file hides that plumbing behind `AppServerSession`, much like a front desk that translates a visitor's plain request into the right internal form.

At startup it reads account information, asks the server which models are available, chooses a default model, and returns the details the UI needs for its first screen. During normal use it sends requests to start, resume, fork, archive, delete, rename, steer, interrupt, and compact threads. It also sends account, memory, skills, review, goal, and configuration requests.

A large part of the file converts local configuration into the server's expected request shapes. That includes the current working directory, model provider, service tier, approval rules, and permission or sandbox settings. It also converts server responses back into `ThreadSessionState`, the TUI's local record of a conversation. The file contains compatibility behavior too: if an older remote server does not understand thread setting updates, the TUI quietly stops sending that optional request instead of bothering the user with repeated errors.

#### Function details

##### `bootstrap_request_error`  (lines 140–142)

```
fn bootstrap_request_error(context: &'static str, err: TypedRequestError) -> color_eyre::Report
```

**Purpose**: Builds a clearer error message for failures that happen while the TUI is starting up. It adds human context, such as which startup request failed.

**Data flow**: It receives a short context label and a typed request error → combines them into one report → returns that report to the caller.

**Call relations**: Startup-facing methods use this when an app-server request fails, so the higher-level run code can show a useful failure instead of a bare protocol error.

*Call graph*: 1 external calls (eyre!).


##### `is_thread_settings_update_unsupported`  (lines 144–148)

```
fn is_thread_settings_update_unsupported(source: &JSONRPCErrorError) -> bool
```

**Purpose**: Decides whether a server error means the server simply does not support the optional thread settings update method. This lets the TUI stay compatible with older servers.

**Data flow**: It reads the JSON-RPC error code and message → checks for method-not-found or an invalid-request message naming `thread/settings/update` → returns true only for those compatibility cases.

**Call relations**: `AppServerSession::thread_settings_update` calls this after a server rejection, then disables future setting-update requests if the method is unsupported.

*Call graph*: called by 1 (thread_settings_update).


##### `ThreadParamsMode::model_provider_from_config`  (lines 190–195)

```
fn model_provider_from_config(self, config: &Config) -> Option<String>
```

**Purpose**: Chooses whether the TUI should send the configured model provider to the server. Embedded servers need it; remote servers decide that for themselves.

**Data flow**: It receives the thread parameter mode and the current config → returns the config's model provider id for embedded mode, or nothing for remote mode.

**Call relations**: The thread start, resume, and fork parameter builders call this while assembling app-server requests.

*Call graph*: called by 3 (thread_fork_params_from_config, thread_resume_params_from_config, thread_start_params_from_config).


##### `AppServerSession::new`  (lines 215–226)

```
fn new(client: AppServerClient, thread_params_mode: ThreadParamsMode) -> Self
```

**Purpose**: Creates a fresh app-server session wrapper for the TUI. It stores the client connection and initializes request numbering and feature flags.

**Data flow**: It receives an app-server client and a thread parameter mode → fills default fields such as request id 1, no remote directory override, empty model cache, and no import in progress → returns a ready `AppServerSession`.

**Call relations**: Top-level TUI startup and picker/archive flows create this session before they begin sending app-server requests.

*Call graph*: called by 6 (run_ratatui_app, start_app_server_for_archive_command, start_app_server_for_picker, fork_last_filters_latest_session_by_cwd_unless_show_all, latest_session_lookup_falls_back_for_rollout_missing_from_state_db, lookup_session_target_by_name_uses_backend_title_search); 2 external calls (new, new).


##### `AppServerSession::with_remote_cwd_override`  (lines 228–231)

```
fn with_remote_cwd_override(mut self, remote_cwd_override: Option<PathBuf>) -> Self
```

**Purpose**: Adds or changes the working-directory override used when the app server is remote. This is useful when the server's workspace path is not the same as the local terminal path.

**Data flow**: It receives the session and an optional path → stores that path as the remote current working directory override → returns the updated session.

**Call relations**: Callers use this during setup before thread start, resume, or fork requests are built.


##### `AppServerSession::remote_cwd_override`  (lines 233–235)

```
fn remote_cwd_override(&self) -> Option<&std::path::Path>
```

**Purpose**: Returns the remote working-directory override, if one was configured.

**Data flow**: It reads the stored optional path → exposes it as a borrowed path without changing the session.

**Call relations**: Startup and picker flows read this when deciding how to launch or resume work against a remote app server.

*Call graph*: called by 3 (spawn_startup_thread_start, run_fork_picker_with_app_server, run_resume_picker_with_launch_context).


##### `AppServerSession::uses_remote_workspace`  (lines 237–239)

```
fn uses_remote_workspace(&self) -> bool
```

**Purpose**: Answers whether this session expects the app server to own the workspace path. That changes how paths and permissions are sent.

**Data flow**: It reads the stored thread parameter mode → returns true for remote mode and false for embedded mode.

**Call relations**: Migration prompts and session lookup flows use this to choose behavior that differs between local embedded work and remote workspaces.

*Call graph*: called by 4 (handle_external_agent_config_migration_prompt, lookup_latest_session_target_with_app_server, run_fork_picker_with_app_server, run_resume_picker_with_launch_context); 1 external calls (matches!).


##### `AppServerSession::uses_embedded_app_server`  (lines 241–243)

```
fn uses_embedded_app_server(&self) -> bool
```

**Purpose**: Answers whether the TUI is talking to an app server running inside the same process. Embedded mode can use local assumptions that a remote server cannot.

**Data flow**: It inspects the stored app-server client variant → returns true when it is in-process.

**Call relations**: The external agent migration prompt checks this before deciding how to proceed.

*Call graph*: called by 1 (handle_external_agent_config_migration_prompt); 1 external calls (matches!).


##### `AppServerSession::codex_home_path`  (lines 245–250)

```
fn codex_home_path(
        &self,
        local_codex_home: &AbsolutePathBuf,
    ) -> Option<AppServerPath>
```

**Purpose**: Asks the client how the local Codex home directory should be represented for the app server. This matters when local and remote paths differ.

**Data flow**: It receives the local Codex home path → delegates path translation to the app-server client → returns an app-server path if translation is possible.

**Call relations**: Thread goal editing code calls this when it needs to open or save goal-related data through the app server.

*Call graph*: calls 1 internal fn (codex_home); called by 2 (open_thread_goal_editor, set_thread_goal_draft).


##### `AppServerSession::server_version`  (lines 252–257)

```
fn server_version(&self) -> Option<&str>
```

**Purpose**: Returns the remote app server's version string when the session is connected to a remote server. Embedded sessions do not have a separate remote version.

**Data flow**: It inspects the client type → if remote, reads the remote client's version → otherwise returns nothing.

**Call relations**: The main run flow uses this for version-aware behavior or display.

*Call graph*: called by 1 (run).


##### `AppServerSession::bootstrap`  (lines 259–347)

```
async fn bootstrap(&mut self, config: &Config) -> Result<AppServerBootstrap>
```

**Purpose**: Collects the key information the TUI needs before drawing its first useful screen. It reads account status, available models, default model choice, and feedback/account display details.

**Data flow**: It reads account info, sends a model list request, converts server models into local model presets, chooses a default model, stores model data on the session, and builds an `AppServerBootstrap` result.

**Call relations**: The main `run` flow calls this at startup. It uses `read_account`, request ids, app-server typed requests, and model/account conversion helpers.

*Call graph*: calls 3 internal fn (request_typed, next_request_id, read_account); called by 1 (run); 2 external calls (now, plan_type_display_name).


##### `AppServerSession::read_account`  (lines 353–364)

```
async fn read_account(&mut self) -> Result<GetAccountResponse>
```

**Purpose**: Fetches current account information without refreshing authentication tokens. It is a lighter account check used during startup and login status checks.

**Data flow**: It creates a request id → sends `GetAccount` with `refresh_token` set to false → returns the server's account response or a contextual startup error.

**Call relations**: `bootstrap` calls this as its first account step, and login status code uses it when it only needs the current auth mode.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 2 (bootstrap, get_login_status).


##### `AppServerSession::external_agent_config_detect`  (lines 366–375)

```
async fn external_agent_config_detect(
        &mut self,
        params: ExternalAgentConfigDetectParams,
    ) -> Result<ExternalAgentConfigDetectResponse>
```

**Purpose**: Asks the app server to look for importable settings from an external agent, specifically the Claude Code migration flow. It does not import anything; it only detects what could be migrated.

**Data flow**: It receives detection parameters → assigns a request id → sends an `ExternalAgentConfigDetect` request → returns the detected migration information.

**Call relations**: The external agent migration prompt calls this before offering the user import choices.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (handle_external_agent_config_migration_prompt).


##### `AppServerSession::external_agent_config_import`  (lines 377–406)

```
async fn external_agent_config_import(
        &mut self,
        migration_items: Vec<ExternalAgentConfigMigrationItem>,
    ) -> Result<()>
```

**Purpose**: Starts importing selected external agent configuration items, while preventing two imports from running at the same time.

**Data flow**: It receives selected migration items → atomically marks import completion as pending → sends the import request → keeps the pending flag on success, or clears it if the request itself fails.

**Call relations**: The migration prompt calls this after the user chooses what to import. Later notification handling consumes the completion flag.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (handle_external_agent_config_migration_prompt); 3 external calls (store, swap, bail!).


##### `AppServerSession::external_agent_config_import_in_progress`  (lines 408–411)

```
fn external_agent_config_import_in_progress(&self) -> bool
```

**Purpose**: Reports whether an external agent config import is currently considered in progress.

**Data flow**: It reads an atomic boolean flag → returns true if an import completion is still pending.

**Call relations**: The migration prompt checks this so it can avoid starting a duplicate import.

*Call graph*: called by 1 (handle_external_agent_config_migration_prompt); 1 external calls (load).


##### `AppServerSession::consume_external_agent_config_import_completion`  (lines 413–416)

```
fn consume_external_agent_config_import_completion(&self) -> bool
```

**Purpose**: Marks a pending external agent import as completed and tells the caller whether there was one to consume.

**Data flow**: It swaps the pending flag to false → returns the previous value.

**Call relations**: Server notification handling calls this when the app server reports that the import has finished.

*Call graph*: called by 1 (handle_server_notification_event); 1 external calls (swap).


##### `AppServerSession::next_event`  (lines 418–420)

```
async fn next_event(&mut self) -> Option<AppServerEvent>
```

**Purpose**: Waits for the next event coming from the app server. Events are server-to-TUI messages, such as notifications or updates.

**Data flow**: It asks the client for the next event → returns that event, or nothing if the event stream has ended.

**Call relations**: Thread settings update tests and event-loop helpers use this to observe app-server messages.

*Call graph*: calls 1 internal fn (next_event); called by 1 (next_thread_settings_updated).


##### `AppServerSession::start_thread`  (lines 423–426)

```
async fn start_thread(&mut self, config: &Config) -> Result<AppServerStartedThread>
```

**Purpose**: Test-only convenience wrapper for starting a normal new thread. It uses the same path as production thread start but without a special start source.

**Data flow**: It receives config → calls `start_thread_with_session_start_source` with no source → returns the started thread state.

**Call relations**: Compiled for tests, it exercises the main thread-start flow through the same helper used by production code.

*Call graph*: calls 1 internal fn (start_thread_with_session_start_source).


##### `AppServerSession::start_thread_with_session_start_source`  (lines 428–451)

```
async fn start_thread_with_session_start_source(
        &mut self,
        config: &Config,
        session_start_source: Option<ThreadStartSource>,
    ) -> Result<AppServerStartedThread>
```

**Purpose**: Starts a new conversation thread on the app server. It can also label why the session was started, such as after clearing a session.

**Data flow**: It prepares effective config, builds thread start parameters, sends `ThreadStart`, and converts the response into `AppServerStartedThread` with session state and initial turns.

**Call relations**: Fresh-session flows call this. It relies on parameter builders and response mapping helpers to keep request and UI state conversion separate.

*Call graph*: calls 6 internal fn (request_typed, next_request_id, session_config_with_effective_service_tier, thread_params_mode, started_thread_from_start_response, thread_start_params_from_config); called by 2 (start_fresh_session_with_summary_hint, start_thread).


##### `AppServerSession::resume_thread`  (lines 453–483)

```
async fn resume_thread(
        &mut self,
        config: Config,
        thread_id: ThreadId,
    ) -> Result<AppServerStartedThread>
```

**Purpose**: Reopens an existing app-server thread for use in the TUI. It restores session settings and past turns from the server response.

**Data flow**: It receives config and a thread id → builds resume parameters → sends `ThreadResume` → optionally looks up the parent thread title if this is a fork → maps the response into local session state.

**Call relations**: Main startup, resume selection, live attachment, and snapshot refresh flows call this when they need an existing conversation loaded.

*Call graph*: calls 7 internal fn (request_typed, fork_parent_title_from_app_server, next_request_id, session_config_with_effective_service_tier, thread_params_mode, started_thread_from_resume_response, thread_resume_params_from_config); called by 4 (run, attach_live_thread_for_selection, resume_target_session, refresh_snapshot_session_if_needed).


##### `AppServerSession::fork_thread`  (lines 485–514)

```
async fn fork_thread(
        &mut self,
        config: Config,
        thread_id: ThreadId,
    ) -> Result<AppServerStartedThread>
```

**Purpose**: Creates a new thread by forking an existing one. A fork is like making a copy of a conversation so the user can try a different direction.

**Data flow**: It receives config and source thread id → builds fork parameters → sends `ThreadFork` → fetches the parent title when available → returns the new thread's local session state and turns.

**Call relations**: Run and event handlers call this when the user chooses to fork or start a side conversation.

*Call graph*: calls 7 internal fn (request_typed, fork_parent_title_from_app_server, next_request_id, session_config_with_effective_service_tier, thread_params_mode, started_thread_from_fork_response, thread_fork_params_from_config); called by 3 (run, handle_event, handle_start_side).


##### `AppServerSession::thread_params_mode`  (lines 516–518)

```
fn thread_params_mode(&self) -> ThreadParamsMode
```

**Purpose**: Returns whether thread requests should be built for an embedded or remote app server.

**Data flow**: It reads the stored mode → returns it unchanged.

**Call relations**: Thread start, resume, fork, and startup helpers use this when building requests.

*Call graph*: called by 4 (spawn_startup_thread_start, fork_thread, resume_thread, start_thread_with_session_start_source).


##### `AppServerSession::session_config_with_effective_service_tier`  (lines 520–544)

```
fn session_config_with_effective_service_tier(&self, config: &Config) -> Config
```

**Purpose**: Adjusts the config so the app server receives the correct service tier for the selected model. A service tier is a speed or capacity choice for model use.

**Data flow**: It picks the active model from config or cached default → asks service-tier resolution what should be sent → returns a cloned config with service tier and notice fields updated.

**Call relations**: Thread start, resume, and fork call this before building request parameters.

*Call graph*: calls 1 internal fn (service_tier_update_for_core); called by 3 (fork_thread, resume_thread, start_thread_with_session_start_source); 1 external calls (clone).


##### `AppServerSession::fork_parent_title_from_app_server`  (lines 546–569)

```
async fn fork_parent_title_from_app_server(
        &mut self,
        forked_from_id: Option<&str>,
    ) -> Option<String>
```

**Purpose**: Looks up the display title of the parent thread when a thread was forked. This lets the UI show where a fork came from.

**Data flow**: It receives an optional parent id string → parses it into a thread id → reads parent metadata without turns → returns the parent name, or nothing if parsing or reading fails.

**Call relations**: Resume and fork flows call this after the server response says a thread has a parent.

*Call graph*: calls 2 internal fn (from_string, thread_read); called by 2 (fork_thread, resume_thread); 1 external calls (warn!).


##### `AppServerSession::thread_list`  (lines 571–580)

```
async fn thread_list(
        &mut self,
        params: ThreadListParams,
    ) -> Result<ThreadListResponse>
```

**Purpose**: Requests a page or filtered list of threads from the app server. This powers session pickers and lookup features.

**Data flow**: It receives list parameters → assigns a request id → sends `ThreadList` → returns the server's thread list response.

**Call relations**: Latest-session lookup, title search, page loading, and exact-name lookup flows use this.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 4 (lookup_latest_session_target_with_app_server, lookup_session_target_by_name_with_app_server, load_app_server_page, lookup_session_by_exact_name).


##### `AppServerSession::thread_loaded_list`  (lines 587–596)

```
async fn thread_loaded_list(
        &mut self,
        params: ThreadLoadedListParams,
    ) -> Result<ThreadLoadedListResponse>
```

**Purpose**: Asks which thread ids the app server currently has loaded in memory. This helps the TUI discover live subagent threads that already exist.

**Data flow**: It receives loaded-list parameters → sends `ThreadLoadedList` → returns the loaded thread ids and related data.

**Call relations**: The TUI's subagent backfill flow calls this, then uses `thread_read` to fetch full metadata for each thread.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (backfill_loaded_subagent_threads).


##### `AppServerSession::thread_read`  (lines 598–616)

```
async fn thread_read(
        &mut self,
        thread_id: ThreadId,
        include_turns: bool,
    ) -> Result<Thread>
```

**Purpose**: Fetches one thread's metadata, and optionally its turns, from the app server.

**Data flow**: It receives a thread id and a flag saying whether to include turns → sends `ThreadRead` → returns the `Thread` object from the response.

**Call relations**: Session lookup, transcript loading, liveness refresh, subagent backfill, and fork-parent title lookup all use this when they need details for a specific thread.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 8 (attach_live_thread_for_selection, backfill_loaded_subagent_threads, refresh_agent_picker_thread_liveness, fork_parent_title_from_app_server, lookup_session_target_with_app_server, load_transcript_preview, resolve_session_target, load_session_transcript); 1 external calls (to_string).


##### `AppServerSession::thread_archive`  (lines 618–631)

```
async fn thread_archive(&mut self, thread_id: ThreadId) -> Result<()>
```

**Purpose**: Moves a thread into the archived state. Archived threads are hidden from normal active lists but not deleted.

**Data flow**: It receives a thread id → sends `ThreadArchive` → returns success with no extra data.

**Call relations**: Current-thread archive actions and session archive commands call this.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 2 (archive_current_thread, run_session_archive_action_with_app_server); 1 external calls (to_string).


##### `AppServerSession::thread_delete`  (lines 633–646)

```
async fn thread_delete(&mut self, thread_id: ThreadId) -> Result<()>
```

**Purpose**: Deletes a thread through the app server.

**Data flow**: It receives a thread id → sends `ThreadDelete` → returns success with no extra data if the server accepts it.

**Call relations**: Thread deletion UI actions and archive-command flows call this when the user chooses permanent removal.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 2 (delete_current_thread, run_session_archive_action_with_app_server); 1 external calls (to_string).


##### `AppServerSession::thread_unarchive`  (lines 648–661)

```
async fn thread_unarchive(&mut self, thread_id: ThreadId) -> Result<Thread>
```

**Purpose**: Restores an archived thread to active use.

**Data flow**: It receives a thread id → sends `ThreadUnarchive` → returns the restored thread object from the server.

**Call relations**: Session archive action code calls this when the user reverses an archive.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (run_session_archive_action_with_app_server); 1 external calls (to_string).


##### `AppServerSession::thread_metadata_update_branch`  (lines 663–683)

```
async fn thread_metadata_update_branch(
        &mut self,
        thread_id: ThreadId,
        branch: String,
    ) -> Result<ThreadMetadataUpdateResponse>
```

**Purpose**: Updates the git branch stored in a thread's metadata. Git is the version-control system used to track code changes.

**Data flow**: It receives a thread id and branch name → sends a metadata update containing only the branch field → returns the server's update response.

**Call relations**: Event handling calls this when the TUI needs to sync branch information to the app server.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (handle_event); 1 external calls (to_string).


##### `AppServerSession::thread_settings_update`  (lines 685–716)

```
async fn thread_settings_update(
        &mut self,
        params: ThreadSettingsUpdateParams,
    ) -> Result<()>
```

**Purpose**: Sends updated thread settings such as model or personality to the app server. If the server is too old to support this optional method, it quietly turns the feature off for the session.

**Data flow**: It receives settings update parameters → if support is still enabled, sends `ThreadSettingsUpdate` → on known unsupported errors, records that future calls should be skipped → otherwise returns success or a real error.

**Call relations**: The TUI's setting update sender calls this after local settings change.

*Call graph*: calls 2 internal fn (next_request_id, is_thread_settings_update_unsupported); called by 1 (send_thread_settings_update).


##### `AppServerSession::thread_inject_items`  (lines 718–739)

```
async fn thread_inject_items(
        &mut self,
        thread_id: ThreadId,
        items: Vec<ResponseItem>,
    ) -> Result<ThreadInjectItemsResponse>
```

**Purpose**: Adds already-built response items into a thread. This is used for side conversation setup where the TUI needs to seed context.

**Data flow**: It receives a thread id and response items → serializes the items to JSON values → sends `ThreadInjectItems` → returns the server response.

**Call relations**: Side-thread startup calls this after creating a side thread and before using it.

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

**Purpose**: Starts a new assistant turn in an existing thread. A turn is one round of user input and assistant work.

**Data flow**: It receives input items, working directory, permissions, model settings, workspace roots, and optional output schema → converts permission overrides into server fields → sends `TurnStart` → returns the server's turn-start response.

**Call relations**: The active-thread submit path calls this when the user sends a new message or task.

*Call graph*: calls 3 internal fn (request_typed, next_request_id, turn_permissions_overrides); called by 1 (try_submit_active_thread_op_via_app_server); 4 external calls (as_path, into, to_string, to_vec).


##### `AppServerSession::turn_interrupt`  (lines 791–808)

```
async fn turn_interrupt(
        &mut self,
        thread_id: ThreadId,
        turn_id: String,
    ) -> std::result::Result<(), TypedRequestError>
```

**Purpose**: Asks the app server to stop a running turn.

**Data flow**: It receives a thread id and turn id → sends `TurnInterrupt` → returns success or the typed request error directly.

**Call relations**: Interrupt handling and active-thread submission use this when the user cancels ongoing work; `startup_interrupt` also delegates to it.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 3 (interrupt_side_thread, try_submit_active_thread_op_via_app_server, startup_interrupt); 1 external calls (to_string).


##### `AppServerSession::startup_interrupt`  (lines 810–815)

```
async fn startup_interrupt(
        &mut self,
        thread_id: ThreadId,
    ) -> std::result::Result<(), TypedRequestError>
```

**Purpose**: Interrupts startup work for a thread when there may not be a normal turn id yet.

**Data flow**: It receives a thread id → calls `turn_interrupt` with an empty turn id → returns that result.

**Call relations**: Side-thread and active-thread interrupt paths call this for startup-time cancellation.

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

**Purpose**: Sends extra guidance to an already-running turn. This lets the user steer the assistant while work is in progress.

**Data flow**: It receives a thread id, expected turn id, and new input items → sends `TurnSteer` → returns the server's steering response.

**Call relations**: The active-thread submit path calls this when input should be applied to an existing running turn instead of starting a new one.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (try_submit_active_thread_op_via_app_server); 1 external calls (to_string).


##### `AppServerSession::thread_set_name`  (lines 839–857)

```
async fn thread_set_name(
        &mut self,
        thread_id: ThreadId,
        name: String,
    ) -> Result<()>
```

**Purpose**: Renames a thread.

**Data flow**: It receives a thread id and name → sends `ThreadSetName` → returns success when the server confirms.

**Call relations**: Active-thread operations call this when the UI title or user-specified session name changes.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (try_submit_active_thread_op_via_app_server); 1 external calls (to_string).


##### `AppServerSession::thread_memory_mode_set`  (lines 859–877)

```
async fn thread_memory_mode_set(
        &mut self,
        thread_id: ThreadId,
        mode: ThreadMemoryMode,
    ) -> Result<()>
```

**Purpose**: Changes a thread's memory mode. Memory mode controls how the assistant uses saved memory for that conversation.

**Data flow**: It receives a thread id and memory mode → sends `ThreadMemoryModeSet` → returns success when accepted.

**Call relations**: Memory settings update code calls this after the user changes memory behavior.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (update_memory_settings_with_app_server); 1 external calls (to_string).


##### `AppServerSession::memory_reset`  (lines 879–890)

```
async fn memory_reset(&mut self) -> Result<()>
```

**Purpose**: Requests a reset of stored memory through the app server.

**Data flow**: It creates a request id → sends `MemoryReset` with no extra parameters → returns success when the server completes it.

**Call relations**: The memory reset UI flow calls this when the user confirms a reset.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (reset_memories_with_app_server).


##### `AppServerSession::thread_goal_get`  (lines 892–906)

```
async fn thread_goal_get(
        &mut self,
        thread_id: ThreadId,
    ) -> Result<ThreadGoalGetResponse>
```

**Purpose**: Fetches the current goal attached to a thread. A goal is the user's longer-running objective for that conversation.

**Data flow**: It receives a thread id → sends `ThreadGoalGet` → returns the goal response.

**Call relations**: Goal menu, goal editor, draft setting, and resume-prompt flows call this before displaying or editing the goal.

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

**Purpose**: Sets or updates a thread goal, including objective text, status, and optional token budget.

**Data flow**: It receives a thread id and optional goal fields → sends `ThreadGoalSet` → returns the server's set response.

**Call relations**: Goal draft and goal status flows call this when the user changes goal details.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 2 (set_thread_goal_draft, set_thread_goal_status); 1 external calls (to_string).


##### `AppServerSession::thread_goal_clear`  (lines 930–944)

```
async fn thread_goal_clear(
        &mut self,
        thread_id: ThreadId,
    ) -> Result<ThreadGoalClearResponse>
```

**Purpose**: Removes the goal from a thread.

**Data flow**: It receives a thread id → sends `ThreadGoalClear` → returns the server's clear response.

**Call relations**: Goal-clearing and draft-setting flows call this when the user wants no active goal.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 2 (clear_thread_goal, set_thread_goal_draft); 1 external calls (to_string).


##### `AppServerSession::logout_account`  (lines 946–957)

```
async fn logout_account(&mut self) -> Result<()>
```

**Purpose**: Logs the current account out through the app server.

**Data flow**: It sends `LogoutAccount` with no extra parameters → returns success if the server logs out.

**Call relations**: The main event handler calls this when the user chooses a logout action.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (handle_event).


##### `AppServerSession::thread_unsubscribe`  (lines 959–972)

```
async fn thread_unsubscribe(&mut self, thread_id: ThreadId) -> Result<()>
```

**Purpose**: Stops receiving updates for a thread. This is useful when a thread is no longer active in the UI.

**Data flow**: It receives a thread id → sends `ThreadUnsubscribe` → returns success when the server confirms.

**Call relations**: Startup-thread, fresh-session, side-thread discard, and current-thread shutdown flows call this during cleanup.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 4 (handle_startup_thread_started, start_fresh_session_with_summary_hint, discard_side_thread, shutdown_current_thread); 1 external calls (to_string).


##### `AppServerSession::thread_compact_start`  (lines 974–987)

```
async fn thread_compact_start(&mut self, thread_id: ThreadId) -> Result<()>
```

**Purpose**: Starts compaction for a thread. Compaction condenses conversation history so the thread can continue with less context load.

**Data flow**: It receives a thread id → sends `ThreadCompactStart` → returns success when the server begins compaction.

**Call relations**: Active-thread operations call this when the user requests compaction.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (try_submit_active_thread_op_via_app_server); 1 external calls (to_string).


##### `AppServerSession::thread_shell_command`  (lines 989–1007)

```
async fn thread_shell_command(
        &mut self,
        thread_id: ThreadId,
        command: String,
    ) -> Result<()>
```

**Purpose**: Sends a shell command associated with a thread to the app server. A shell command is a terminal command such as `ls` or `git status`.

**Data flow**: It receives a thread id and command text → sends `ThreadShellCommand` → returns success when accepted.

**Call relations**: Active-thread operations call this when the UI needs the server to run or record a command for the thread.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (try_submit_active_thread_op_via_app_server); 1 external calls (to_string).


##### `AppServerSession::thread_approve_guardian_denied_action`  (lines 1009–1028)

```
async fn thread_approve_guardian_denied_action(
        &mut self,
        thread_id: ThreadId,
        event: &GuardianAssessmentEvent,
    ) -> Result<()>
```

**Purpose**: Approves an action that an automatic safety or review system, called Guardian, previously denied.

**Data flow**: It receives a thread id and Guardian assessment event → serializes the event to JSON → sends `ThreadApproveGuardianDeniedAction` → returns success when the server records approval.

**Call relations**: Active-thread operations call this when the user explicitly approves a denied action.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (try_submit_active_thread_op_via_app_server); 2 external calls (to_string, to_value).


##### `AppServerSession::thread_background_terminals_clean`  (lines 1030–1046)

```
async fn thread_background_terminals_clean(
        &mut self,
        thread_id: ThreadId,
    ) -> Result<()>
```

**Purpose**: Asks the server to clean up background terminals linked to a thread.

**Data flow**: It receives a thread id → sends `ThreadBackgroundTerminalsClean` → returns success when cleanup is accepted.

**Call relations**: Active-thread operations call this when terminal resources should be cleared.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (try_submit_active_thread_op_via_app_server); 1 external calls (to_string).


##### `AppServerSession::thread_rollback`  (lines 1048–1064)

```
async fn thread_rollback(
        &mut self,
        thread_id: ThreadId,
        num_turns: u32,
    ) -> Result<ThreadRollbackResponse>
```

**Purpose**: Rolls a thread back by a given number of turns. This is like undoing recent conversation steps.

**Data flow**: It receives a thread id and number of turns → sends `ThreadRollback` → returns the rollback response.

**Call relations**: Active-thread operations call this when the user asks to undo conversation progress.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (try_submit_active_thread_op_via_app_server); 1 external calls (to_string).


##### `AppServerSession::review_start`  (lines 1066–1083)

```
async fn review_start(
        &mut self,
        thread_id: ThreadId,
        target: ReviewTarget,
    ) -> Result<ReviewStartResponse>
```

**Purpose**: Starts an inline review for a thread target. Inline means the review result is delivered back into the conversation flow.

**Data flow**: It receives a thread id and review target → sends `ReviewStart` with inline delivery → returns the review-start response.

**Call relations**: Active-thread operations call this when the user starts a code or work review.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (try_submit_active_thread_op_via_app_server); 1 external calls (to_string).


##### `AppServerSession::skills_list`  (lines 1085–1094)

```
async fn skills_list(
        &mut self,
        params: SkillsListParams,
    ) -> Result<SkillsListResponse>
```

**Purpose**: Fetches the skills available from the app server. Skills are named capabilities the assistant can use or expose.

**Data flow**: It receives list parameters → sends `SkillsList` → returns the server's skills response.

**Call relations**: Active-thread operations call this when the UI needs to show or use available skills.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (try_submit_active_thread_op_via_app_server).


##### `AppServerSession::reload_user_config`  (lines 1096–1112)

```
async fn reload_user_config(&mut self) -> Result<()>
```

**Purpose**: Tells the app server to reload user configuration without changing any config entries.

**Data flow**: It sends an empty `ConfigBatchWrite` request with `reload_user_config` set to true → returns success when the server reloads.

**Call relations**: Active-thread operations call this after user config changes need to take effect.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (try_submit_active_thread_op_via_app_server); 1 external calls (new).


##### `AppServerSession::reject_server_request`  (lines 1114–1120)

```
async fn reject_server_request(
        &self,
        request_id: RequestId,
        error: JSONRPCErrorError,
    ) -> std::io::Result<()>
```

**Purpose**: Sends a rejection response for a request that the server made to the TUI. This is the TUI saying, in protocol form, that it cannot or will not fulfill the request.

**Data flow**: It receives a server request id and JSON-RPC error → delegates to the client → returns I/O success or failure.

**Call relations**: The app-server request rejection helper calls this when the UI declines a server-initiated request.

*Call graph*: calls 1 internal fn (reject_server_request); called by 1 (reject_app_server_request).


##### `AppServerSession::resolve_server_request`  (lines 1122–1128)

```
async fn resolve_server_request(
        &self,
        request_id: RequestId,
        result: serde_json::Value,
    ) -> std::io::Result<()>
```

**Purpose**: Sends a successful response for a request that the server made to the TUI.

**Data flow**: It receives a server request id and JSON result value → delegates to the client → returns I/O success or failure.

**Call relations**: The app-server request resolution helper calls this after the TUI has produced a result for the server.

*Call graph*: calls 1 internal fn (resolve_server_request); called by 1 (try_resolve_app_server_request).


##### `AppServerSession::shutdown`  (lines 1130–1132)

```
async fn shutdown(self) -> std::io::Result<()>
```

**Purpose**: Closes down the app-server client connection cleanly.

**Data flow**: It consumes the session → asks the client to shut down → returns any I/O error from shutdown.

**Call relations**: The main run flow and background page loader use this during teardown.

*Call graph*: calls 1 internal fn (shutdown); called by 2 (run, spawn_app_server_page_loader).


##### `AppServerSession::request_handle`  (lines 1134–1136)

```
fn request_handle(&self) -> AppServerRequestHandle
```

**Purpose**: Creates a lightweight handle that can send app-server requests without borrowing the whole session. This is useful for background tasks.

**Data flow**: It asks the client for a request handle → returns that handle.

**Call relations**: The main run flow and many background fetch operations use this to perform app-server work outside the central session object.

*Call graph*: calls 1 internal fn (request_handle); called by 29 (run, consume_rate_limit_reset_credit, fetch_connectors_list, fetch_hooks_list, fetch_marketplace_add, fetch_marketplace_remove, fetch_marketplace_upgrade, fetch_mcp_inventory, fetch_plugin_detail, fetch_plugin_install (+15 more)).


##### `AppServerSession::next_request_id`  (lines 1138–1142)

```
fn next_request_id(&mut self) -> RequestId
```

**Purpose**: Generates the next unique numeric request id for JSON-RPC calls. Unique ids let replies be matched to requests.

**Data flow**: It reads the current counter → increments it → returns the old value wrapped as an integer request id.

**Call relations**: Nearly every request-sending method in this session calls it before sending a typed request.

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

**Purpose**: Starts a thread using a standalone request handle rather than a full `AppServerSession`. This allows startup thread creation to happen from a background task.

**Data flow**: It receives a request handle, config, mode, and optional remote directory → builds thread start parameters → sends `ThreadStart` with a unique string id → maps the response into started-thread state.

**Call relations**: The startup thread spawning flow calls this when it needs to start work without owning the main session.

*Call graph*: calls 3 internal fn (request_typed, started_thread_from_start_response, thread_start_params_from_config); called by 1 (spawn_startup_thread_start); 2 external calls (String, format!).


##### `status_account_display_from_auth_mode`  (lines 1166–1182)

```
fn status_account_display_from_auth_mode(
    auth_mode: Option<AuthMode>,
    plan_type: Option<codex_protocol::account::PlanType>,
) -> Option<StatusAccountDisplay>
```

**Purpose**: Converts a low-level authentication mode into the account label the TUI status area should show.

**Data flow**: It receives an optional auth mode and optional plan type → maps API key to an API-key display, ChatGPT-like modes to a ChatGPT display, Bedrock or no auth to no display → returns the display value.

**Call relations**: Server notification handling uses this when account status changes, and tests check that plan labels are remapped correctly.

*Call graph*: called by 2 (handle_server_notification_event, status_account_display_from_auth_mode_uses_remapped_plan_labels).


##### `model_preset_from_api_model`  (lines 1184–1236)

```
fn model_preset_from_api_model(model: ApiModel) -> ModelPreset
```

**Purpose**: Converts a model record from the app-server protocol into the TUI/core model preset shape. This gives the UI one consistent model format.

**Data flow**: It receives an API model → copies names, descriptions, reasoning-effort options, service tiers, upgrade information, visibility, availability notices, and input modalities → returns a `ModelPreset`.

**Call relations**: `bootstrap` uses this while processing the server's model list.


##### `approvals_reviewer_override_from_config`  (lines 1238–1242)

```
fn approvals_reviewer_override_from_config(
    config: &Config,
) -> Option<codex_app_server_protocol::ApprovalsReviewer>
```

**Purpose**: Extracts the configured approvals reviewer in the protocol form expected by the app server. The approvals reviewer is who decides whether risky actions may proceed.

**Data flow**: It receives config → converts the configured reviewer value → returns it wrapped as an optional override.

**Call relations**: Thread start, resume, and fork parameter builders call this while preparing server requests.

*Call graph*: called by 3 (thread_fork_params_from_config, thread_resume_params_from_config, thread_start_params_from_config).


##### `config_request_overrides_from_config`  (lines 1244–1286)

```
fn config_request_overrides_from_config(
    config: &Config,
) -> Option<HashMap<String, serde_json::Value>>
```

**Purpose**: Builds a small map of config values that should be sent as per-thread overrides to the app server.

**Data flow**: It reads reasoning effort, reasoning summary, verbosity, personality, web search mode, and hook trust bypass from config → inserts present values into a JSON map → returns that map.

**Call relations**: Thread start, resume, and fork parameter builders include these overrides in their requests; tests verify personality defaults are not accidentally forced.

*Call graph*: called by 4 (config_request_overrides_preserve_implicit_personality_default, thread_fork_params_from_config, thread_resume_params_from_config, thread_start_params_from_config); 1 external calls (new).


##### `service_tier_override_from_config`  (lines 1288–1293)

```
fn service_tier_override_from_config(config: &Config) -> Option<Option<String>>
```

**Purpose**: Converts service-tier settings from config into the nested optional form expected by the app-server protocol.

**Data flow**: It reads explicit service tier first → otherwise checks the fast-default opt-out notice → returns the service tier override, or nothing if no override should be sent.

**Call relations**: Thread start, resume, and fork parameter builders call this when assembling request fields.

*Call graph*: called by 3 (thread_fork_params_from_config, thread_resume_params_from_config, thread_start_params_from_config).


##### `sandbox_mode_from_permission_profile`  (lines 1295–1318)

```
fn sandbox_mode_from_permission_profile(
    permission_profile: &PermissionProfile,
    cwd: &std::path::Path,
) -> Option<codex_app_server_protocol::SandboxMode>
```

**Purpose**: Projects the richer local permission profile into the simpler sandbox mode understood by remote thread lifecycle requests. A sandbox is a safety boundary for file and network access.

**Data flow**: It receives a permission profile and current directory → checks whether access is disabled, external, full disk, workspace-write, or read-only → returns the matching server sandbox mode or nothing when it cannot be represented.

**Call relations**: Thread lifecycle parameter builders use this when they are not sending an active permission profile id; tests cover remote projection cases.

*Call graph*: calls 2 internal fn (file_system_sandbox_policy, network_sandbox_policy); called by 2 (thread_lifecycle_params_forward_explicit_remote_cwd_override_for_remote_sessions, thread_lifecycle_params_omit_cwd_without_remote_override_for_remote_sessions).


##### `permission_profile_id_from_active_profile`  (lines 1320–1322)

```
fn permission_profile_id_from_active_profile(active: ActivePermissionProfile) -> String
```

**Purpose**: Extracts the id string from an active permission profile.

**Data flow**: It receives an active profile → returns its id field.

**Call relations**: Permission override helpers and tests use this whenever the protocol needs the selected profile id.

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

**Purpose**: Translates the user's per-turn permission choice into the server fields for a turn request.

**Data flow**: It receives a permission override and current directory → returns no override for preserve, a profile id for active-profile selection, or a legacy sandbox policy for legacy/custom sandbox selection.

**Call relations**: `turn_start` calls this before sending a turn; tests verify preserve, active profile, remote profile, and legacy sandbox behavior.

*Call graph*: calls 2 internal fn (permission_profile_id_from_active_profile, legacy_compatible_permission_profile); called by 6 (turn_start, embedded_turn_permissions_select_profile_id_only, embedded_turn_permissions_use_active_profile_selection, legacy_turn_permissions_project_to_sandbox_when_explicitly_overridden, remote_turn_permissions_preserve_active_profile_selection, turn_permissions_preserve_thread_permissions_without_override).


##### `permissions_selection_from_config`  (lines 1353–1365)

```
fn permissions_selection_from_config(
    config: &Config,
    thread_params_mode: ThreadParamsMode,
) -> Option<String>
```

**Purpose**: Chooses whether to send an active permission profile id from config. Remote thread lifecycle requests avoid sending local profile ids.

**Data flow**: It receives config and thread parameter mode → returns nothing for remote mode → otherwise returns the active permission profile id if one is configured.

**Call relations**: Thread start, resume, and fork parameter builders call this before deciding whether they need a sandbox fallback.

*Call graph*: called by 3 (thread_fork_params_from_config, thread_resume_params_from_config, thread_start_params_from_config); 1 external calls (matches!).


##### `thread_start_params_from_config`  (lines 1367–1402)

```
fn thread_start_params_from_config(
    config: &Config,
    thread_params_mode: ThreadParamsMode,
    remote_cwd_override: Option<&std::path::Path>,
    session_start_source: Option<ThreadStartSource
```

**Purpose**: Builds the full app-server request body for starting a thread from local TUI config.

**Data flow**: It reads model, provider, service tier, cwd, workspace roots, approvals, permissions, config overrides, ephemeral flag, start source, and developer instructions → returns `ThreadStartParams`.

**Call relations**: Session thread-start methods and startup request-handle flow call this; tests exercise embedded, remote, config override, clear-source, and instruction behavior.

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

**Purpose**: Builds the app-server request body for resuming an existing thread.

**Data flow**: It receives config, thread id, mode, and optional remote cwd → selects model/provider, service tier, cwd, workspace roots, approvals, permissions or sandbox, config overrides, and developer instructions → returns `ThreadResumeParams`.

**Call relations**: `AppServerSession::resume_thread` calls this before sending the resume request; tests compare its fields with start and fork behavior.

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

**Purpose**: Builds the app-server request body for forking an existing thread.

**Data flow**: It receives config, source thread id, mode, and optional remote cwd → includes lifecycle settings plus fork-specific instruction overrides, ephemeral setting, and thread source → returns `ThreadForkParams`.

**Call relations**: `AppServerSession::fork_thread` calls this before sending the fork request; tests verify instruction and remote/local field behavior.

*Call graph*: calls 7 internal fn (model_provider_from_config, approvals_reviewer_override_from_config, config_request_overrides_from_config, permissions_selection_from_config, service_tier_override_from_config, thread_cwd_from_config, with_terminal_visualization_instructions); called by 6 (fork_thread, terminal_visualization_instructions_are_gated_for_all_tui_thread_flows, thread_fork_params_forward_instruction_overrides, thread_lifecycle_params_forward_config_overrides_and_service_tier, thread_lifecycle_params_forward_explicit_remote_cwd_override_for_remote_sessions, thread_lifecycle_params_omit_cwd_without_remote_override_for_remote_sessions); 2 external calls (default, to_string).


##### `thread_cwd_from_config`  (lines 1478–1489)

```
fn thread_cwd_from_config(
    config: &Config,
    thread_params_mode: ThreadParamsMode,
    remote_cwd_override: Option<&std::path::Path>,
) -> Option<String>
```

**Purpose**: Chooses what current working directory should be sent to the app server for thread lifecycle requests.

**Data flow**: It receives config, mode, and optional remote override → returns the local config cwd for embedded mode, the override for remote mode, or nothing for remote mode without an override.

**Call relations**: Start, resume, and fork parameter builders call this while setting the `cwd` field.

*Call graph*: called by 3 (thread_fork_params_from_config, thread_resume_params_from_config, thread_start_params_from_config).


##### `started_thread_from_start_response`  (lines 1491–1504)

```
async fn started_thread_from_start_response(
    response: ThreadStartResponse,
    config: &Config,
    thread_params_mode: ThreadParamsMode,
) -> Result<AppServerStartedThread>
```

**Purpose**: Converts a server thread-start response into the TUI's started-thread wrapper.

**Data flow**: It receives the server response, config, and mode → builds local session state from the response → pairs it with the response's turns → returns `AppServerStartedThread`.

**Call relations**: Thread start flows call this after `ThreadStart` succeeds.

*Call graph*: calls 1 internal fn (thread_session_state_from_thread_start_response); called by 2 (start_thread_with_session_start_source, start_thread_with_request_handle).


##### `started_thread_from_resume_response`  (lines 1506–1519)

```
async fn started_thread_from_resume_response(
    response: ThreadResumeResponse,
    config: &Config,
    thread_params_mode: ThreadParamsMode,
) -> Result<AppServerStartedThread>
```

**Purpose**: Converts a server thread-resume response into the TUI's started-thread wrapper.

**Data flow**: It receives the server response, config, and mode → maps response fields into `ThreadSessionState` → carries over restored turns → returns `AppServerStartedThread`.

**Call relations**: `resume_thread` and resume-response tests use this after a resume response is available.

*Call graph*: calls 1 internal fn (thread_session_state_from_thread_resume_response); called by 2 (resume_thread, resume_response_restores_turns_from_thread_items).


##### `started_thread_from_fork_response`  (lines 1521–1534)

```
async fn started_thread_from_fork_response(
    response: ThreadForkResponse,
    config: &Config,
    thread_params_mode: ThreadParamsMode,
) -> Result<AppServerStartedThread>
```

**Purpose**: Converts a server thread-fork response into the TUI's started-thread wrapper.

**Data flow**: It receives the fork response, config, and mode → builds session state → attaches returned turns → returns `AppServerStartedThread`.

**Call relations**: `fork_thread` calls this after `ThreadFork` succeeds.

*Call graph*: calls 1 internal fn (thread_session_state_from_thread_fork_response); called by 1 (fork_thread).


##### `thread_session_state_from_thread_start_response`  (lines 1536–1566)

```
async fn thread_session_state_from_thread_start_response(
    response: &ThreadStartResponse,
    config: &Config,
    thread_params_mode: ThreadParamsMode,
) -> Result<ThreadSessionState, String>
```

**Purpose**: Builds local `ThreadSessionState` from a thread-start response.

**Data flow**: It reads thread id, name, path, model, provider, service tier, approval settings, sandbox, cwd, workspace roots, instruction sources, and reasoning effort → resolves the display permission profile → delegates to the shared session-state builder.

**Call relations**: `started_thread_from_start_response` calls this to keep start-specific response mapping small.

*Call graph*: calls 2 internal fn (display_permission_profile_from_thread_response, thread_session_state_from_thread_response); called by 1 (started_thread_from_start_response).


##### `thread_session_state_from_thread_resume_response`  (lines 1568–1607)

```
async fn thread_session_state_from_thread_resume_response(
    response: &ThreadResumeResponse,
    config: &Config,
    thread_params_mode: ThreadParamsMode,
) -> Result<ThreadSessionState, String>
```

**Purpose**: Builds local `ThreadSessionState` from a thread-resume response, including compatibility with older embedded responses.

**Data flow**: It reads resume response fields → chooses a permission profile either from legacy sandbox fallback or normal display mapping → delegates to the shared session-state builder.

**Call relations**: `started_thread_from_resume_response` calls this; tests use it indirectly to check restored turns and permissions.

*Call graph*: calls 3 internal fn (from_legacy_sandbox_policy_for_cwd, display_permission_profile_from_thread_response, thread_session_state_from_thread_response); called by 1 (started_thread_from_resume_response); 1 external calls (matches!).


##### `thread_session_state_from_thread_fork_response`  (lines 1609–1639)

```
async fn thread_session_state_from_thread_fork_response(
    response: &ThreadForkResponse,
    config: &Config,
    thread_params_mode: ThreadParamsMode,
) -> Result<ThreadSessionState, String>
```

**Purpose**: Builds local `ThreadSessionState` from a thread-fork response.

**Data flow**: It reads fork response fields → resolves the display permission profile → delegates to the shared session-state builder.

**Call relations**: `started_thread_from_fork_response` calls this after a fork succeeds.

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

**Purpose**: Chooses which permission profile the TUI should display for a thread response. Embedded sessions trust local config; remote sessions reconstruct a profile from the server sandbox policy.

**Data flow**: It receives server sandbox, cwd, config, and mode → returns the config's effective profile for embedded mode or a legacy-derived profile for remote mode.

**Call relations**: Start, resume, and fork response mappers call this; tests verify embedded and remote behavior.

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

**Purpose**: Creates the TUI's complete `ThreadSessionState` from normalized response fields. This is the final conversion point from server data to local UI state.

**Data flow**: It receives explicit thread, model, permission, path, workspace, instruction, and config fields → parses ids, reads message-history metadata from disk, and fills a `ThreadSessionState` struct → returns it or a string error if ids are invalid.

**Call relations**: All start, resume, and fork session-state mappers call this; tests call it directly for history and fork-id behavior.

*Call graph*: calls 2 internal fn (new, from_string); called by 5 (session_configured_populates_history_metadata, session_configured_preserves_fork_source_thread_id, thread_session_state_from_thread_fork_response, thread_session_state_from_thread_resume_response, thread_session_state_from_thread_start_response); 1 external calls (history_metadata).


##### `app_server_rate_limit_snapshots`  (lines 1714–1732)

```
fn app_server_rate_limit_snapshots(
    response: GetAccountRateLimitsResponse,
) -> Vec<RateLimitSnapshot>
```

**Purpose**: Combines rate-limit information from the app server while removing duplicate copies of the primary limit. Rate limits describe how much model usage remains in a time window.

**Data flow**: It receives the rate-limit response → starts with the top-level primary snapshot → adds map entries whose ids are not the same as the primary → returns the deduplicated list.

**Call relations**: Its test verifies that the top-level limit is not shown twice when it also appears in the map.

*Call graph*: called by 1 (app_server_rate_limit_snapshots_deduplicates_top_level_limit_from_map); 1 external calls (vec!).


##### `tests::build_config`  (lines 1762–1768)

```
async fn build_config(temp_dir: &TempDir) -> Config
```

**Purpose**: Creates a basic test configuration rooted in a temporary directory.

**Data flow**: It receives a temporary directory → builds a `Config` with that directory as Codex home → returns the config for tests.

**Call relations**: Many async tests call this to avoid repeating boilerplate setup.

*Call graph*: 2 external calls (path, default).


##### `tests::rate_limit_snapshot`  (lines 1770–1785)

```
fn rate_limit_snapshot(limit_id: &str) -> RateLimitSnapshot
```

**Purpose**: Builds a small fake rate-limit snapshot for tests.

**Data flow**: It receives a limit id string → fills a `RateLimitSnapshot` with that id and simple default window data → returns it.

**Call relations**: The rate-limit deduplication test uses this to create input data.


##### `tests::app_server_rate_limit_snapshots_deduplicates_top_level_limit_from_map`  (lines 1788–1807)

```
fn app_server_rate_limit_snapshots_deduplicates_top_level_limit_from_map()
```

**Purpose**: Checks that duplicate primary rate-limit snapshots are removed.

**Data flow**: It builds a response with one top-level limit and a map containing the same limit plus another → calls `app_server_rate_limit_snapshots` → asserts that only the primary and other limit remain.

**Call relations**: This protects the rate-limit display from showing the same limit twice.

*Call graph*: calls 1 internal fn (app_server_rate_limit_snapshots); 3 external calls (from, assert_eq!, rate_limit_snapshot).


##### `tests::thread_settings_update_compat_detects_unsupported_errors`  (lines 1810–1838)

```
fn thread_settings_update_compat_detects_unsupported_errors()
```

**Purpose**: Checks the compatibility detection for unsupported thread settings updates.

**Data flow**: It creates several JSON-RPC error cases → calls the unsupported-error checker → asserts which ones should be treated as unsupported.

**Call relations**: This protects `thread_settings_update` from disabling itself for unrelated invalid requests.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::thread_start_params_include_cwd_for_embedded_sessions`  (lines 1841–1875)

```
async fn thread_start_params_include_cwd_for_embedded_sessions()
```

**Purpose**: Verifies that embedded thread-start requests include local workspace details and active permission selection.

**Data flow**: It builds config with workspace permissions → creates start parameters in embedded mode → checks cwd, workspace roots, sandbox, permissions, provider, and thread source.

**Call relations**: This guards the embedded request-building path used by thread startup.

*Call graph*: calls 1 internal fn (thread_start_params_from_config); 4 external calls (assert_eq!, default, default, tempdir).


##### `tests::thread_start_params_can_mark_clear_source`  (lines 1878–1890)

```
async fn thread_start_params_can_mark_clear_source()
```

**Purpose**: Verifies that thread-start parameters can record a clear-session start source.

**Data flow**: It builds config → creates start parameters with `ThreadStartSource::Clear` → asserts the source is preserved.

**Call relations**: This protects the session-start-source field used by fresh session flows.

*Call graph*: calls 1 internal fn (thread_start_params_from_config); 3 external calls (assert_eq!, tempdir, build_config).


##### `tests::embedded_turn_permissions_use_active_profile_selection`  (lines 1893–1907)

```
fn embedded_turn_permissions_use_active_profile_selection()
```

**Purpose**: Checks that an active permission profile override turns into the expected profile id.

**Data flow**: It creates a workspace profile and cwd → calls `turn_permissions_overrides` → asserts no sandbox policy is sent and the permission id is set.

**Call relations**: This covers the permission path used by `turn_start`.

*Call graph*: calls 3 internal fn (new, permission_profile_id_from_active_profile, turn_permissions_overrides); 3 external calls (assert_eq!, test_path_buf, ActiveProfile).


##### `tests::embedded_turn_permissions_select_profile_id_only`  (lines 1910–1925)

```
fn embedded_turn_permissions_select_profile_id_only()
```

**Purpose**: Confirms that selecting a built-in active profile sends only its id, not a sandbox policy.

**Data flow**: It creates an active profile → converts turn permissions → checks that the permission string equals the built-in profile id.

**Call relations**: This reinforces the active-profile branch in `turn_permissions_overrides`.

*Call graph*: calls 2 internal fn (new, turn_permissions_overrides); 3 external calls (assert_eq!, test_path_buf, ActiveProfile).


##### `tests::turn_permissions_preserve_thread_permissions_without_override`  (lines 1928–1936)

```
fn turn_permissions_preserve_thread_permissions_without_override()
```

**Purpose**: Checks that the preserve option leaves existing thread permissions untouched.

**Data flow**: It calls `turn_permissions_overrides` with `Preserve` → asserts both returned override fields are empty.

**Call relations**: This protects the default turn-start behavior when the user did not request a permission change.

*Call graph*: calls 1 internal fn (turn_permissions_overrides); 2 external calls (assert_eq!, test_path_buf).


##### `tests::legacy_turn_permissions_project_to_sandbox_when_explicitly_overridden`  (lines 1939–1954)

```
fn legacy_turn_permissions_project_to_sandbox_when_explicitly_overridden()
```

**Purpose**: Checks that a legacy read-only permission override becomes a read-only sandbox policy.

**Data flow**: It creates a cwd and read-only profile → converts the override → asserts a read-only sandbox policy is returned and no profile id is sent.

**Call relations**: This covers the legacy/custom permission branch used by `turn_start`.

*Call graph*: calls 2 internal fn (read_only, turn_permissions_overrides); 3 external calls (assert_eq!, test_path_buf, LegacySandbox).


##### `tests::remote_turn_permissions_preserve_active_profile_selection`  (lines 1957–1970)

```
fn remote_turn_permissions_preserve_active_profile_selection()
```

**Purpose**: Checks that active profile ids are preserved even for remote turn overrides.

**Data flow**: It creates a custom active profile id → converts turn permissions → asserts that id is sent and no sandbox policy is sent.

**Call relations**: This protects remote-compatible behavior in `turn_permissions_overrides`.

*Call graph*: calls 3 internal fn (new, permission_profile_id_from_active_profile, turn_permissions_overrides); 3 external calls (assert_eq!, test_path_buf, ActiveProfile).


##### `tests::thread_lifecycle_params_omit_cwd_without_remote_override_for_remote_sessions`  (lines 1973–2028)

```
async fn thread_lifecycle_params_omit_cwd_without_remote_override_for_remote_sessions()
```

**Purpose**: Verifies that remote thread lifecycle requests do not send a cwd unless the user provided a remote override.

**Data flow**: It builds config and thread id → creates start, resume, and fork parameters in remote mode → checks cwd omission, workspace roots, model provider omission, sandbox fallback, and permission omission.

**Call relations**: This guards request builders for remote app-server sessions.

*Call graph*: calls 5 internal fn (new, sandbox_mode_from_permission_profile, thread_fork_params_from_config, thread_resume_params_from_config, thread_start_params_from_config); 3 external calls (assert_eq!, tempdir, build_config).


##### `tests::sandbox_mode_does_not_project_non_cwd_write_roots_for_remote_sessions`  (lines 2031–2057)

```
fn sandbox_mode_does_not_project_non_cwd_write_roots_for_remote_sessions()
```

**Purpose**: Checks that write access outside the current project is not simplified into workspace-write mode.

**Data flow**: It builds a permission profile with write access to an extra path but not cwd → calls sandbox projection → expects read-only.

**Call relations**: This protects `sandbox_mode_from_permission_profile` from granting too much access in remote requests.

*Call graph*: 3 external calls (assert_eq!, test_path_buf, vec!).


##### `tests::sandbox_mode_projects_cwd_write_for_remote_sessions`  (lines 2060–2087)

```
fn sandbox_mode_projects_cwd_write_for_remote_sessions()
```

**Purpose**: Checks that write access to project roots becomes workspace-write mode.

**Data flow**: It builds a permission profile that can write project roots → calls sandbox projection → expects workspace-write.

**Call relations**: This verifies the safe positive case for remote sandbox projection.

*Call graph*: 3 external calls (assert_eq!, test_path_buf, vec!).


##### `tests::thread_lifecycle_params_forward_explicit_remote_cwd_override_for_remote_sessions`  (lines 2090–2133)

```
async fn thread_lifecycle_params_forward_explicit_remote_cwd_override_for_remote_sessions()
```

**Purpose**: Verifies that remote start, resume, and fork requests include an explicitly supplied remote cwd.

**Data flow**: It builds config, thread id, and remote cwd → creates lifecycle parameters in remote mode → checks cwd, provider, sandbox, permissions, and thread source fields.

**Call relations**: This protects remote workspace launch behavior when local and server paths differ.

*Call graph*: calls 5 internal fn (new, sandbox_mode_from_permission_profile, thread_fork_params_from_config, thread_resume_params_from_config, thread_start_params_from_config); 4 external calls (from, assert_eq!, tempdir, build_config).


##### `tests::thread_lifecycle_params_forward_config_overrides_and_service_tier`  (lines 2136–2186)

```
async fn thread_lifecycle_params_forward_config_overrides_and_service_tier()
```

**Purpose**: Checks that thread lifecycle requests carry config overrides and explicit service tier.

**Data flow**: It sets reasoning, summary, verbosity, personality, web search, hook trust, and service tier in config → builds start, resume, and fork params → asserts the expected JSON override map and service tier are present.

**Call relations**: This guards the config-to-request conversion helpers used by all thread lifecycle requests.

*Call graph*: calls 4 internal fn (new, thread_fork_params_from_config, thread_resume_params_from_config, thread_start_params_from_config); 4 external calls (from, assert_eq!, tempdir, build_config).


##### `tests::config_request_overrides_preserve_implicit_personality_default`  (lines 2189–2207)

```
async fn config_request_overrides_preserve_implicit_personality_default()
```

**Purpose**: Checks that an unset personality is not sent as an override, while an explicit `none` personality is sent.

**Data flow**: It builds config with no personality → verifies the override map lacks personality → sets personality to explicit none → verifies the map contains it.

**Call relations**: This protects `config_request_overrides_from_config` from changing behavior by sending implicit defaults.

*Call graph*: calls 1 internal fn (config_request_overrides_from_config); 4 external calls (assert!, assert_eq!, tempdir, build_config).


##### `tests::thread_fork_params_forward_instruction_overrides`  (lines 2210–2229)

```
async fn thread_fork_params_forward_instruction_overrides()
```

**Purpose**: Verifies that fork requests carry base and developer instruction overrides from config.

**Data flow**: It sets base and developer instructions → builds fork params → asserts both instruction fields are present.

**Call relations**: This protects the fork-specific request builder behavior.

*Call graph*: calls 2 internal fn (new, thread_fork_params_from_config); 3 external calls (assert_eq!, tempdir, build_config).


##### `tests::terminal_visualization_instructions_are_gated_for_all_tui_thread_flows`  (lines 2232–2302)

```
async fn terminal_visualization_instructions_are_gated_for_all_tui_thread_flows()
```

**Purpose**: Checks that extra terminal visualization instructions are only added when the feature flag is enabled.

**Data flow**: It builds start, resume, and fork params before and after enabling the feature → compares developer instruction fields to the expected gated output.

**Call relations**: This guards the shared instruction helper used by thread start, resume, and fork request builders.

*Call graph*: calls 4 internal fn (new, thread_fork_params_from_config, thread_resume_params_from_config, thread_start_params_from_config); 4 external calls (assert_eq!, format!, tempdir, build_config).


##### `tests::resume_response_restores_turns_from_thread_items`  (lines 2305–2426)

```
async fn resume_response_restores_turns_from_thread_items()
```

**Purpose**: Verifies that resuming a thread restores turns and maps session metadata correctly.

**Data flow**: It creates a fake resume response with a turn, fork id, workspace roots, instructions, and sandbox → maps it to started-thread state → asserts restored fields and turns for remote and embedded cases.

**Call relations**: This protects `started_thread_from_resume_response` and the resume session-state mapping path.

*Call graph*: calls 3 internal fn (read_only, new, started_thread_from_resume_response); 8 external calls (new, assert_eq!, test_path_buf, default, default, tempdir, build_config, vec!).


##### `tests::remote_thread_response_uses_legacy_sandbox_fallback`  (lines 2429–2447)

```
async fn remote_thread_response_uses_legacy_sandbox_fallback()
```

**Purpose**: Checks that remote thread responses derive display permissions from the server sandbox policy.

**Data flow**: It creates a read-only sandbox response → calls the display permission mapper in remote mode → expects a read-only permission profile.

**Call relations**: This covers the remote branch of `display_permission_profile_from_thread_response`.

*Call graph*: calls 1 internal fn (read_only); 4 external calls (assert_eq!, test_path_buf, tempdir, build_config).


##### `tests::embedded_thread_response_uses_local_config_profile`  (lines 2450–2472)

```
async fn embedded_thread_response_uses_local_config_profile()
```

**Purpose**: Checks that embedded thread responses display the local config permission profile instead of trusting the response sandbox.

**Data flow**: It builds config with read-only default permissions → calls the display permission mapper in embedded mode with a full-access sandbox → expects the local read-only profile.

**Call relations**: This covers the embedded branch of `display_permission_profile_from_thread_response`.

*Call graph*: 5 external calls (assert_eq!, test_path_buf, default, default, tempdir).


##### `tests::session_configured_populates_history_metadata`  (lines 2475–2516)

```
async fn session_configured_populates_history_metadata()
```

**Purpose**: Verifies that session-state creation includes message-history metadata.

**Data flow**: It appends two history entries → builds session state from thread response fields → checks that a nonzero log id and entry count of two are present.

**Call relations**: This protects the shared `thread_session_state_from_thread_response` builder.

*Call graph*: calls 4 internal fn (new, read_only, new, thread_session_state_from_thread_response); 7 external calls (new, assert_eq!, assert_ne!, append_entry, test_path_buf, tempdir, build_config).


##### `tests::session_configured_preserves_fork_source_thread_id`  (lines 2519–2547)

```
async fn session_configured_preserves_fork_source_thread_id()
```

**Purpose**: Verifies that a fork parent id from a response is preserved in local session state.

**Data flow**: It builds session state with a thread id and forked-from id → asserts the resulting session contains the parsed parent id.

**Call relations**: This protects fork lineage display and resume/fork mapping.

*Call graph*: calls 3 internal fn (read_only, new, thread_session_state_from_thread_response); 5 external calls (new, assert_eq!, test_path_buf, tempdir, build_config).


##### `tests::status_account_display_from_auth_mode_uses_remapped_plan_labels`  (lines 2550–2574)

```
fn status_account_display_from_auth_mode_uses_remapped_plan_labels()
```

**Purpose**: Checks that account display labels use the user-friendly plan names expected by the status UI.

**Data flow**: It converts ChatGPT auth with enterprise and business plan variants → asserts the display labels are remapped to `Enterprise` and `Business`.

**Call relations**: This protects `status_account_display_from_auth_mode`, which is used when account status notifications arrive.

*Call graph*: calls 1 internal fn (status_account_display_from_auth_mode); 1 external calls (assert!).
