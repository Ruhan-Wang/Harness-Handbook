# Shutdown, cleanup, and teardown  `stage-17`

This stage is the system’s “tidy up and turn off the lights” step. It runs when a connection, session, or whole process is ending. Its job is to stop new work from starting, let in-flight work finish when possible, and then clean up anything still left so shutdown is orderly instead of abrupt.

One part, connection_rpc_gate.rs, acts like a door guard for each connection. It flips a shared “no new requests” switch, but keeps count of work that already started so those tasks can finish cleanly. connection_cleanup.rs is the cleanup crew for that same connection. It starts small cleanup jobs, waits for them one by one or all at once, and can cancel any stragglers if shutdown time runs out.

legacy.rs handles older agent threads. It closes them, also closes any child threads they created, and saves the final thread-tree state so the system remembers what ended.

update_loop.rs is a special Unix-only background daemon piece. It watches for installer updates, swaps in a new managed binary when needed, and restarts the daemon so the updated version takes over.

## Files in this stage

### Daemon restart loop
Handles the updater-driven daemon lifecycle, including periodic refresh checks and re-exec when the managed binary changes.

### `app-server-daemon/src/update_loop.rs`

`orchestration` · `main loop`

This module is the long-running updater driver for Unix platforms. `run` installs a SIGTERM handler, captures the identity of the currently running updater executable, waits an initial five-minute delay, and then enters an hourly loop. Each iteration calls `update_once`; errors are intentionally swallowed so the loop keeps trying on the next interval, while an explicit stop signal exits cleanly. On non-Unix builds, `run` immediately fails because the PID-managed updater model is unsupported there.

The core work happens in `update_once`. It first downloads and executes the latest standalone install script via `install_latest_standalone`, then reconstructs daemon context from environment variables, resolves the managed Codex binary path, and computes executable identities for both the running updater and managed binary. `update_modes_for_identities` decides whether the daemon restart can be version-conditional or must be unconditional with updater re-exec support: identical binaries mean `IfVersionChanged`/`None`, differing binaries mean `Always`/`ReexecIfManagedBinaryChanged`.

After that, `update_once` repeatedly calls `daemon.try_restart_if_running(...)`. A `Busy` outcome triggers a short 50 ms retry sleep; any other outcome ends the iteration. Termination is checked both before each retry and during sleeps so shutdown is responsive. `reexec_managed_updater` performs the actual `exec()` replacement into the managed binary, preserving the updater subcommand arguments. `install_latest_standalone` is deliberately quiet: it fetches `https://chatgpt.com/codex/install.sh`, pipes it into `/bin/sh -s`, suppresses stdout/stderr, and fails if the shell exits nonzero.

#### Function details

##### `run`  (lines 72–74)

```
async fn run() -> Result<()>
```

**Purpose**: Starts the periodic updater loop, wiring together signal handling, initial delay, repeated update attempts, and graceful termination. On unsupported platforms it returns an immediate error instead of entering a loop.

**Data flow**: On Unix, creates a SIGTERM `Signal`, computes the current updater executable identity, waits `INITIAL_UPDATE_DELAY`, then repeatedly invokes `update_once` and sleeps `UPDATE_INTERVAL` between iterations. It returns `Ok(())` on clean termination or propagates setup failures such as inability to install the signal handler or inspect the current executable.

**Call relations**: This function is called by `run_pid_update_loop`, making it the top-level driver for this subsystem. It delegates one-shot work to `current_updater_identity`, uses `sleep_or_terminate` for interruptible waits, and hands each cycle to `update_once`; its match logic intentionally ignores `Err(_)` from `update_once` so transient update failures do not kill the daemon.

*Call graph*: calls 3 internal fn (current_updater_identity, sleep_or_terminate, update_once); called by 1 (run_pid_update_loop); 3 external calls (terminate, bail!, signal).


##### `sleep_or_terminate`  (lines 77–82)

```
async fn sleep_or_terminate(duration: Duration, terminate: &mut Signal) -> bool
```

**Purpose**: Performs an interruptible sleep that can be cut short by SIGTERM. It centralizes the updater loop’s shutdown-aware waiting behavior.

**Data flow**: Takes a `Duration` and mutable access to the installed Unix `Signal` stream → races `tokio::time::sleep(duration)` against `terminate.recv()` with `tokio::select!`. Returns `false` if the timer elapsed first and `true` if a termination signal arrived first.

**Call relations**: Both `run` and `update_once` use this helper whenever they need to wait without becoming unresponsive to shutdown. It does not delegate to internal helpers beyond Tokio’s select machinery.

*Call graph*: called by 2 (run, update_once); 1 external calls (select!).


##### `update_once`  (lines 91–119)

```
async fn update_once(
    running_updater_identity: &ExecutableIdentity,
    terminate: &mut Signal,
) -> Result<UpdateLoopControl>
```

**Purpose**: Executes one updater cycle: refresh the standalone install, inspect the managed binary, choose restart behavior, and retry daemon restart while the daemon reports itself busy. It is the unit of work repeated by the outer loop.

**Data flow**: Consumes `running_updater_identity: &ExecutableIdentity` and mutable `terminate: &mut Signal` → runs `install_latest_standalone`, builds a `Daemon` from environment, resolves the managed Codex binary path, computes its `ExecutableIdentity`, derives `(RestartMode, UpdaterRefreshMode)`, then loops calling `daemon.try_restart_if_running(...)`. Returns `UpdateLoopControl::Continue` after any non-busy restart outcome, `UpdateLoopControl::Stop` if termination is observed, or an error if install/environment/path/identity/restart operations fail.

**Call relations**: This is invoked by `run` once per update interval. It delegates environment reconstruction to `Daemon::from_environment`, binary resolution and hashing/identity work to `resolved_managed_codex_bin` and `executable_identity`, policy selection to `update_modes_for_identities`, and uses `sleep_or_terminate` to back off when `try_restart_if_running` reports `RestartIfRunningOutcome::Busy`.

*Call graph*: calls 6 internal fn (from_environment, executable_identity, resolved_managed_codex_bin, install_latest_standalone, sleep_or_terminate, update_modes_for_identities); called by 1 (run); 1 external calls (recv).


##### `current_updater_identity`  (lines 122–126)

```
async fn current_updater_identity() -> Result<ExecutableIdentity>
```

**Purpose**: Determines the executable identity of the updater process currently running this code. That identity is later compared against the managed binary to decide whether a re-exec is necessary.

**Data flow**: Reads the current process executable path via `std::env::current_exe()` → passes that path to `executable_identity` → returns the resulting `ExecutableIdentity`. It writes no state and only propagates contextualized errors.

**Call relations**: Called once by `run` during startup before the initial delay. It exists to isolate the current-process inspection step from the rest of the loop logic.

*Call graph*: calls 1 internal fn (executable_identity); called by 1 (run); 1 external calls (current_exe).


##### `update_modes_for_identities`  (lines 129–141)

```
fn update_modes_for_identities(
    running_updater_identity: &ExecutableIdentity,
    managed_identity: &ExecutableIdentity,
) -> (RestartMode, UpdaterRefreshMode)
```

**Purpose**: Maps the relationship between the running updater binary and the managed binary into concrete restart and updater-refresh policies. Equality means a lighter restart policy; inequality forces a restart and possible updater replacement.

**Data flow**: Takes references to two `ExecutableIdentity` values → compares them for equality → returns either `(RestartMode::IfVersionChanged, UpdaterRefreshMode::None)` or `(RestartMode::Always, UpdaterRefreshMode::ReexecIfManagedBinaryChanged)`. It is pure and has no side effects.

**Call relations**: This helper is called by `update_once` after both identities have been computed. Its output directly controls the arguments passed into `daemon.try_restart_if_running`, and its behavior is covered by the dedicated tests in `update_loop_tests.rs`.

*Call graph*: called by 1 (update_once).


##### `reexec_managed_updater`  (lines 144–154)

```
fn reexec_managed_updater(managed_codex_bin: &std::path::Path) -> Result<()>
```

**Purpose**: Replaces the current updater process image with the managed Codex binary running the updater-loop subcommand. It is the low-level process handoff used when the updater itself must be refreshed.

**Data flow**: Takes `managed_codex_bin: &Path` → constructs a `std::process::Command` targeting that binary with args `app-server daemon pid-update-loop` → calls Unix `exec()` to replace the current process. Because successful `exec` never returns, the function only returns `Err(...)` containing contextualized failure information.

**Call relations**: This function is called by `try_restart_if_running` when updater refresh mode requires re-exec into the managed binary. It does not perform policy decisions itself; it is the terminal action once higher-level restart logic has decided replacement is needed.

*Call graph*: called by 1 (try_restart_if_running); 1 external calls (new).


##### `install_latest_standalone`  (lines 157–193)

```
async fn install_latest_standalone() -> Result<()>
```

**Purpose**: Fetches the latest standalone Codex installer shell script and executes it non-interactively through `/bin/sh`. This keeps the standalone updater installation current before daemon restart decisions are made.

**Data flow**: Performs an HTTP GET to the fixed install URL, validates the response status, reads the body bytes, spawns `/bin/sh -s` with piped stdin and null stdout/stderr, writes the script bytes into the child’s stdin, closes stdin, waits for exit, and returns `Ok(())` only if the shell exits successfully. It mutates external system state through network I/O and whatever the installer script changes on disk.

**Call relations**: Called at the start of each `update_once` cycle so the updater refresh happens before managed-binary comparison and restart attempts. It delegates transport to `reqwest`, process spawning to `tokio::process::Command`, and shell input streaming to Tokio async I/O.

*Call graph*: called by 1 (update_once); 5 external calls (null, piped, bail!, new, get).


### Connection shutdown gating
Stops new per-connection RPC work from starting and then manages the remaining cleanup tasks through graceful completion or abort.

### `app-server/src/connection_rpc_gate.rs`

`orchestration` · `request handling and connection shutdown`

This file defines `ConnectionRpcGate`, a small concurrency primitive used to coordinate connection shutdown with in-flight RPC handler execution. The gate has two pieces of state: `accepting: Mutex<bool>`, which decides whether new handler bodies may start, and `tasks: TaskTracker`, which counts active handlers via tokens. The design is intentionally asymmetric: closing the gate prevents future work from acquiring a token, but does not cancel work that already started.

`run` is the core operation. It locks `accepting`, returns immediately if the gate is closed, otherwise acquires a `TaskTracker` token while still under the lock, then drops the lock and awaits the supplied future. The token is dropped only after the future completes, so `TaskTracker::wait()` can reliably observe in-flight work. `close` flips `accepting` to `false` and closes the tracker so no new tokens can be issued. `shutdown` composes those steps and then waits for all tracked work to finish.

The embedded tests pin down subtle ordering guarantees: a closed gate must drop late futures without polling them, `close` must return even while work is still running, `shutdown` must block until started work completes, and in-flight counting must become visible before the handler body proceeds. `Default` simply delegates to `new`.

#### Function details

##### `ConnectionRpcGate::new`  (lines 17–23)

```
fn new() -> Self
```

**Purpose**: Creates an open gate with no in-flight handlers. New `run` calls will be accepted until `close` or `shutdown` is invoked.

**Data flow**: Initializes `accepting` to `true`, constructs a fresh `TaskTracker`, and returns `ConnectionRpcGate { accepting: Mutex<bool>, tasks }`.

**Call relations**: Used by production connection setup and by all tests in this module as the initial gate state.

*Call graph*: called by 8 (close_returns_while_started_run_remains_active, run_drops_future_without_polling_after_close, run_executes_while_open, run_is_counted_before_handler_body_continues, shutdown_drops_late_runs_while_waiting_for_inflight_work, shutdown_waits_for_started_run_to_finish, new, gate); 2 external calls (new, new).


##### `ConnectionRpcGate::run`  (lines 25–39)

```
async fn run(&self, future: F)
```

**Purpose**: Conditionally executes a handler future only if the gate is still open, while counting that handler as in-flight for shutdown coordination. If the gate is closed, it returns without polling the future.

**Data flow**: Takes `&self` and a future `F`. It locks `accepting`, reads the boolean, and if false returns immediately. If true, it acquires a `TaskTracker` token, releases the lock, awaits the future, then drops the token so the tracker count decreases. It returns `()`.

**Call relations**: This is the main entry used by connection RPC dispatch. Its token acquisition is what allows `shutdown` to wait for already-started handlers while rejecting late arrivals after `close`.

*Call graph*: 1 external calls (token).


##### `ConnectionRpcGate::close`  (lines 41–45)

```
async fn close(&self)
```

**Purpose**: Stops the gate from accepting any new handler executions and closes the task tracker to future token issuance. It does not wait for current handlers to finish.

**Data flow**: Locks `accepting`, sets it to `false`, calls `self.tasks.close()`, and returns `()`. Existing tokens remain valid until dropped by running handlers.

**Call relations**: Called directly by shutdown logic and indirectly by `ConnectionRpcGate::shutdown`; tests verify that it returns promptly even with in-flight work.

*Call graph*: called by 1 (shutdown); 1 external calls (close).


##### `ConnectionRpcGate::shutdown`  (lines 47–50)

```
async fn shutdown(&self)
```

**Purpose**: Performs graceful gate shutdown by first preventing new runs and then waiting for all already-started runs to complete. It is the high-level shutdown API for the gate.

**Data flow**: Calls `self.close().await`, then awaits `self.tasks.wait()`, and returns `()`. It reads and synchronizes on both gate state and tracker state.

**Call relations**: Used by connection teardown paths that need graceful completion semantics; it composes `close` with the tracker’s wait operation.

*Call graph*: calls 1 internal fn (close); 1 external calls (wait).


##### `ConnectionRpcGate::is_accepting`  (lines 53–55)

```
async fn is_accepting(&self) -> bool
```

**Purpose**: Test-only helper that reports whether the gate is still open to new work. It exposes the mutex-protected acceptance flag for assertions.

**Data flow**: Locks `accepting`, dereferences the boolean, and returns it.

**Call relations**: Used only by tests to confirm that `close` and `shutdown` transition the gate into the non-accepting state.


##### `ConnectionRpcGate::inflight_count`  (lines 58–60)

```
fn inflight_count(&self) -> usize
```

**Purpose**: Test-only helper that returns the number of currently tracked in-flight runs. It exposes `TaskTracker` length for assertions about ordering and shutdown behavior.

**Data flow**: Reads `self.tasks.len()` and returns the resulting `usize`.

**Call relations**: Used only by tests to verify that tokens are acquired before handler progress and released after completion.

*Call graph*: 1 external calls (len).


##### `ConnectionRpcGate::default`  (lines 64–66)

```
fn default() -> Self
```

**Purpose**: Provides the default open gate by delegating to `new`. It exists so the type can be constructed through generic default-based code paths.

**Data flow**: Calls `Self::new()` and returns the resulting `ConnectionRpcGate`.

**Call relations**: Supports generic construction; behavior is identical to `ConnectionRpcGate::new`.

*Call graph*: 1 external calls (new).


##### `tests::run_executes_while_open`  (lines 81–92)

```
async fn run_executes_while_open()
```

**Purpose**: Verifies that `run` actually polls and completes the supplied future when the gate is open. It is the baseline acceptance test for normal operation.

**Data flow**: Creates a new gate and an `Arc<AtomicBool>`, runs a future that stores `true`, then asserts the atomic flag was set.

**Call relations**: Exercises the happy path of `ConnectionRpcGate::run` with no shutdown interaction.

*Call graph*: calls 1 internal fn (new); 4 external calls (clone, new, new, assert!).


##### `tests::run_drops_future_without_polling_after_close`  (lines 95–108)

```
async fn run_drops_future_without_polling_after_close()
```

**Purpose**: Checks that once the gate is closed, `run` returns without polling the provided future at all. This is important because late handlers must not start side effects during shutdown.

**Data flow**: Creates a gate, closes it, prepares an `AtomicBool` that would be set if the future ran, calls `run`, then asserts the flag is still false and `is_accepting()` is false.

**Call relations**: Exercises the early-return branch in `ConnectionRpcGate::run` after `close`.

*Call graph*: calls 1 internal fn (new); 4 external calls (clone, new, new, assert!).


##### `tests::close_returns_while_started_run_remains_active`  (lines 111–135)

```
async fn close_returns_while_started_run_remains_active()
```

**Purpose**: Verifies that `close` does not wait for already-started work and that such work remains counted as in-flight until it finishes. This distinguishes `close` from `shutdown`.

**Data flow**: Spawns a task that enters `run` and blocks on a oneshot receiver after signaling start, waits for that signal, calls `close`, asserts non-accepting state and inflight count of 1, then releases the blocked future and waits for completion.

**Call relations**: Exercises the interaction between `run`, token tracking, and `close`, proving that closing is immediate but non-cancelling.

*Call graph*: calls 1 internal fn (new); 6 external calls (clone, new, assert!, assert_eq!, channel, spawn).


##### `tests::shutdown_waits_for_started_run_to_finish`  (lines 138–170)

```
async fn shutdown_waits_for_started_run_to_finish()
```

**Purpose**: Checks that `shutdown` blocks while a started handler is still running and only completes after that handler finishes. This is the core graceful-shutdown guarantee.

**Data flow**: Starts a blocking `run` future using oneshot channels, confirms inflight count is 1, spawns `shutdown`, uses a short timeout to assert shutdown has not completed yet, then releases the handler, waits for completion, and finally asserts inflight count returns to 0.

**Call relations**: Exercises `ConnectionRpcGate::shutdown` end to end, including its internal `close` and `TaskTracker::wait()` behavior.

*Call graph*: calls 1 internal fn (new); 7 external calls (clone, new, from_millis, assert_eq!, channel, spawn, timeout).


##### `tests::shutdown_drops_late_runs_while_waiting_for_inflight_work`  (lines 173–212)

```
async fn shutdown_drops_late_runs_while_waiting_for_inflight_work()
```

**Purpose**: Verifies that once shutdown has begun, new `run` calls are rejected even though shutdown is still waiting for earlier work to finish. This protects against races where late requests sneak in during graceful drain.

**Data flow**: Starts one blocking `run`, spawns `shutdown` and confirms it is waiting via timeout, then calls `run` with a future that would set an atomic flag, asserts that flag remains false, releases the original run, and confirms inflight count reaches 0 afterward.

**Call relations**: Exercises the combined semantics of `shutdown`: immediate closure to new work plus waiting for existing work.

*Call graph*: calls 1 internal fn (new); 9 external calls (clone, new, new, from_millis, assert!, assert_eq!, channel, spawn, timeout).


##### `tests::run_is_counted_before_handler_body_continues`  (lines 215–237)

```
async fn run_is_counted_before_handler_body_continues()
```

**Purpose**: Checks the ordering guarantee that a handler is counted as in-flight before its body is allowed to continue. This prevents shutdown races where work starts but is not yet visible to the tracker.

**Data flow**: Spawns a `run` future that signals entry and then waits on a oneshot, waits for the entry signal, asserts inflight count is already 1, then releases the future and asserts the count returns to 0 after completion.

**Call relations**: Targets the token-acquisition timing inside `ConnectionRpcGate::run`.

*Call graph*: calls 1 internal fn (new); 5 external calls (clone, new, assert_eq!, channel, spawn).


### `app-server/src/connection_cleanup.rs`

`orchestration` · `connection teardown and background cleanup tracking`

This file wraps `JoinSet<()>` in a narrowly scoped `ConnectionCleanupTasks` helper used by connection lifecycle code. The abstraction is intentionally tiny: it creates an empty task set, accepts spawned cleanup futures, and centralizes result logging so callers do not need to repeat `JoinError` handling.

The key behavioral distinction is between `reap_next` and `drain`. `reap_next` is designed for a main loop that wants to wait for one cleanup completion at a time; if there are currently no tasks, it awaits `pending()` forever instead of returning immediately, which makes it suitable as a branch in a `select!` without causing a busy loop. `drain` is the shutdown-oriented variant that repeatedly joins until the set is empty. `abort` requests cancellation of all tracked tasks, after which `drain` or `reap_next` can observe their completion.

`log_cleanup_result` suppresses warnings for cancelled tasks but emits a `tracing::warn!` for any other join failure, such as a panic inside a cleanup future. The file does not define cleanup semantics itself; it only tracks task completion and error visibility.

#### Function details

##### `ConnectionCleanupTasks::new`  (lines 13–17)

```
fn new() -> Self
```

**Purpose**: Constructs an empty cleanup-task tracker backed by a fresh `JoinSet<()>`. It is the starting state for a new connection’s cleanup bookkeeping.

**Data flow**: Allocates `JoinSet::new()` and returns `ConnectionCleanupTasks { tasks }` with no external side effects.

**Call relations**: Called when connection orchestration initializes per-connection state, notably from `run_main_with_transport_options`.

*Call graph*: called by 1 (run_main_with_transport_options); 1 external calls (new).


##### `ConnectionCleanupTasks::spawn`  (lines 19–21)

```
fn spawn(&mut self, future: impl Future<Output = ()> + Send + 'static)
```

**Purpose**: Registers and starts a new cleanup future under the connection’s task set. The future must be `Send + 'static` because `JoinSet` owns and runs it independently.

**Data flow**: Takes `&mut self` and a future producing `()`, forwards it to `self.tasks.spawn(future)`, and returns nothing.

**Call relations**: Used by connection-management code whenever some asynchronous cleanup action should outlive the immediate caller but still be tracked for shutdown/reaping.

*Call graph*: 1 external calls (spawn).


##### `ConnectionCleanupTasks::reap_next`  (lines 23–30)

```
async fn reap_next(&mut self)
```

**Purpose**: Waits for the next cleanup task to finish and logs any non-cancellation join failure. If there are no tasks at all, it waits forever instead of returning immediately.

**Data flow**: Reads `self.tasks.is_empty()`. If empty, awaits `pending::<()>()`; otherwise awaits `self.tasks.join_next()`. When a result arrives, passes it to `log_cleanup_result` and returns `()`. It mutates the underlying `JoinSet` by consuming one completed task.

**Call relations**: Intended for incremental cleanup supervision in a connection event loop; it delegates all join-result interpretation to `log_cleanup_result`.

*Call graph*: calls 1 internal fn (log_cleanup_result); 2 external calls (is_empty, join_next).


##### `ConnectionCleanupTasks::drain`  (lines 32–36)

```
async fn drain(&mut self)
```

**Purpose**: Joins every remaining cleanup task until none are left, logging any non-cancelled failures along the way. This is the full shutdown path for tracked cleanup work.

**Data flow**: Repeatedly awaits `self.tasks.join_next()` in a `while let Some(...)` loop, forwarding each result to `log_cleanup_result`. It empties the `JoinSet` before returning.

**Call relations**: Used during connection teardown after no more cleanup tasks should be added; it shares the same logging helper as `reap_next`.

*Call graph*: calls 1 internal fn (log_cleanup_result); 1 external calls (join_next).


##### `ConnectionCleanupTasks::abort`  (lines 38–40)

```
fn abort(&mut self)
```

**Purpose**: Requests cancellation of all tracked cleanup tasks immediately. It does not wait for them to finish joining.

**Data flow**: Calls `self.tasks.abort_all()` and returns `()`, mutating the task set’s cancellation state.

**Call relations**: Typically invoked during forced shutdown before a later `drain` or other join path observes task completion.

*Call graph*: 1 external calls (abort_all).


##### `log_cleanup_result`  (lines 43–49)

```
fn log_cleanup_result(result: Result<(), JoinError>)
```

**Purpose**: Logs unexpected cleanup task termination while ignoring normal cancellation. This keeps shutdown noise low but still surfaces panics or runtime join failures.

**Data flow**: Consumes `Result<(), JoinError>`; if it is `Err(err)` and `!err.is_cancelled()`, emits `warn!(...)`. Otherwise it produces no output and returns `()`. No state is stored.

**Call relations**: Called by both `ConnectionCleanupTasks::reap_next` and `ConnectionCleanupTasks::drain` so all cleanup-task result handling is centralized.

*Call graph*: called by 2 (drain, reap_next); 1 external calls (warn!).


### Agent thread closure
Shuts down legacy agent threads and persists the resulting closed thread-tree state, including descendant teardown.

### `core/src/agent/control/legacy.rs`

`domain_logic` · `teardown`

This file contains the older agent lifecycle controls that tear down threads and thread subtrees. `shutdown_live_agent` is the primitive operation: it upgrades `AgentControl` to the live manager state, tries to load the thread, materializes and flushes rollout data before shutdown, avoids re-sending `Op::Shutdown` if the thread is already in `AgentStatus::Shutdown`, waits for termination, then removes the thread from the manager and registry. If the thread is already absent from memory, it still attempts `state.send_op(agent_id, Op::Shutdown {})`, allowing shutdown to reach any still-running backend process.

`close_agent` adds persistence semantics. Before shutting anything down, it marks the thread’s spawn-edge status as `DirectionalThreadSpawnEdgeStatus::Closed` in the state DB when possible. If the thread is missing from memory but known in registry metadata, it still tries to persist the closed edge through the manager-level DB handle; failure in that stale-thread case is escalated to `CodexErr::Fatal`, because the explicit close marker is the point of the operation. Other inspection failures are only logged with `warn!`.

Finally, `shutdown_agent_tree` gathers live descendants from the in-memory spawn tree, shuts down the requested agent first, then iterates descendants and tolerates `ThreadNotFound` and `InternalAgentDied` for children. A subtle consequence is that `close_agent` treats missing/dead known agents as success after attempting recursive shutdown, preserving idempotent close behavior for already-gone threads.

#### Function details

##### `AgentControl::shutdown_live_agent`  (lines 6–25)

```
async fn shutdown_live_agent(&self, agent_id: ThreadId) -> CodexResult<String>
```

**Purpose**: Shuts down one live agent thread without marking its persisted spawn edge as explicitly closed. It also removes the thread from in-memory tracking regardless of whether the shutdown path went through a loaded thread or a direct op send.

**Data flow**: Takes `agent_id: ThreadId`, upgrades to manager state, and tries `state.get_thread(agent_id).await`. If the thread is loaded, it materializes and flushes rollout, checks `thread.agent_status().await`, either returns `Ok(String::new())` for already-shutdown threads or sends `Op::Shutdown {}` through `state.send_op`, then waits for termination. If the thread is not loaded, it still sends `Op::Shutdown {}` through the manager. After either branch it calls `state.remove_thread(&agent_id).await`, `self.forget_v2_residency(agent_id)`, and `self.state.release_spawned_thread(agent_id)`, then returns the shutdown submission result.

**Call relations**: This is the primitive used by `AgentControl::shutdown_agent_tree` for both the root of a subtree and each descendant. It does not delegate to other file-local functions, but it is the core teardown step that higher-level close logic builds on.

*Call graph*: called by 1 (shutdown_agent_tree); 2 external calls (new, matches!).


##### `AgentControl::close_agent`  (lines 29–70)

```
async fn close_agent(&self, agent_id: ThreadId) -> CodexResult<String>
```

**Purpose**: Marks an agent as explicitly closed in persisted spawn-edge state and then shuts down that agent plus any live descendants. It is the durable, user-visible close operation rather than a transient live shutdown.

**Data flow**: Accepts `agent_id`, upgrades to manager state, and checks whether registry metadata exists for the thread. It then inspects the live thread: if loaded and a thread-level DB context exists, it writes `DirectionalThreadSpawnEdgeStatus::Closed`; if the thread is missing but metadata says it is known, it tries the manager-level DB context and returns `CodexErr::Fatal` if that stale-edge persistence fails; other lookup errors are logged. After persistence handling it awaits `Box::pin(self.shutdown_agent_tree(agent_id))`. If that returns `ThreadNotFound` or `InternalAgentDied` for a known agent, it converts the outcome to `Ok(String::new())`; otherwise it returns the shutdown result unchanged.

**Call relations**: This is the higher-level close path that invokes `shutdown_agent_tree` after attempting to persist the closed edge. It uses warnings for non-fatal inspection problems and only escalates persistence failure in the stale-known-agent case where durable closure is the operation’s main contract.

*Call graph*: calls 1 internal fn (shutdown_agent_tree); 5 external calls (pin, new, format!, Fatal, warn!).


##### `AgentControl::shutdown_agent_tree`  (lines 73–83)

```
async fn shutdown_agent_tree(&self, agent_id: ThreadId) -> CodexResult<String>
```

**Purpose**: Shuts down an agent and every currently live descendant reachable from the in-memory spawn tree. It preserves the root agent’s shutdown result while best-effort cleaning up descendants.

**Data flow**: Takes `agent_id`, asynchronously collects `descendant_ids` via `self.live_thread_spawn_descendants(agent_id).await?`, then calls `self.shutdown_live_agent(agent_id).await` and stores that result. It iterates each descendant ID and calls `shutdown_live_agent` on it; `Ok(_)`, `ThreadNotFound`, and `InternalAgentDied` are ignored, while any other error aborts and is returned immediately. If descendant cleanup does not fail, it returns the original root shutdown result.

**Call relations**: This function is called by `AgentControl::close_agent` after persistence work. It delegates all actual per-thread teardown to `shutdown_live_agent`, first for the requested node and then for each descendant.

*Call graph*: calls 1 internal fn (shutdown_live_agent); called by 1 (close_agent).

## 📊 State Registers Touched

- `reg-install-context` — The app's understanding of where it is installed, where bundled resources live, and what kind of install this is.
- `reg-update-state` — The app's remembered information about available updates and daemon/binary replacement status.
- `reg-server-runtime` — The live app-server and daemon runtime state that tracks running server processes and how to reach them.
- `reg-transport-channels` — The currently open communication channels like stdio, sockets, websockets, and relays that requests travel through.
- `reg-terminal-mode-state` — The terminal control state that tracks modes, screen protection, suspend handling, and clean restoration on exit.
- `reg-request-serialization-state` — The shared ordering and in-flight tracking used to make sure requests touching the same resource happen safely.
- `reg-live-thread-registry` — The in-memory list of loaded conversation threads and their attached client/session runtime objects.
- `reg-command-session-state` — The live state of running shell or process sessions, including restricted command sessions and process control handles.
- `reg-agent-registry` — The live registry of active child agents and their limits, names, paths, and thread relationships.
- `reg-agent-mailboxes-and-background-jobs` — The queued messages and background work items used by multi-agent workflows, CSV fan-out jobs, and similar worker tasks.
- `reg-skills-refresh-watchers` — The live file-watch state that notices skill changes and asks the server to refresh what is available.
- `reg-connection-shutdown-gate` — The shared per-connection shutdown switch and in-flight work counters that stop new work while letting started work finish.
- `reg-app-server-thread-runtime-state` — Per-thread app-server runtime state such as listeners, subscriptions, pending interrupts, and ordered listener-command queues attached to live threads.
- `reg-managed-install-fingerprint` — The remembered managed-install version and executable fingerprint used to identify the current binary and drive update/replacement decisions.
- `reg-backend-refresh-jobs` — The set of startup and background refresh tasks that keep cloud config, model catalogs, connector listings, update checks, and similar remote reference data fresh.
- `reg-connection-cleanup-jobs` — The per-connection cleanup task set that runs during teardown, waits for background cleanup work, and cancels stragglers if shutdown deadlines are hit.
- `reg-turn-abort-and-interrupt-state` — The shared interrupted/aborted-turn state that records cancellation intent and partial-work guidance across dispatch, execution, and later prompt assembly.
