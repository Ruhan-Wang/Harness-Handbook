# Shutdown, cleanup, and teardown  `stage-17`

This stage covers the “put everything away safely” part of the system. It happens when a connection, session, agent, or daemon is ending, and its job is to stop new work, let safe in-progress work finish, and release anything the system was holding.

The connection RPC gate is like a door monitor for one client connection. RPC means “remote procedure call”: a request sent over the connection asking the server to do something. During shutdown, the gate blocks new request handlers from starting, but allows ones already running to complete.

The connection cleanup tracker manages jobs that continue briefly after a connection ends. It starts these cleanup tasks, records whether they succeed or fail, and can cancel them if the whole server is shutting down.

The legacy agent control code handles older paths for stopping agents. It asks live agents to shut down cleanly, flushes their saved work, and removes their stored parent-child relationship.

The daemon update loop is also part of teardown in practice: after downloading updates, it detects changed binaries and restarts the daemon in a controlled way.

## Files in this stage

### Daemon restart loop
Handles the updater-driven daemon lifecycle, including periodic refresh checks and re-exec when the managed binary changes.

### `app-server-daemon/src/update_loop.rs`

`orchestration` · `background updater loop`

This file is the daemon’s self-update loop. Its job is to keep the installed Codex command fresh without interrupting work more than necessary. Think of it like a night-shift maintenance worker: it waits a bit after startup, checks for updates on a schedule, and only restarts the running service when the update means the service should be refreshed.

On Unix systems, the loop first installs a shutdown listener for the terminate signal, which is the operating system’s polite way of asking a process to stop. It records the identity of the updater executable that is currently running, waits five minutes, then repeatedly performs one update pass every hour. Each pass downloads and runs the standalone installer script from chatgpt.com. After that, it finds the managed Codex binary, compares its executable identity with the updater that is already running, and chooses how aggressively to restart or refresh.

If the daemon is busy, the loop retries very quickly, but it keeps listening for shutdown so it can stop cleanly. If the managed binary has changed, the updater may replace its own process with the managed binary so future update checks run from the freshly installed version. On non-Unix platforms, this pid-managed updater loop is not supported and reports an error instead.

#### Function details

##### `run`  (lines 72–74)

```
async fn run() -> Result<()>
```

**Purpose**: Starts and drives the updater loop. On Unix, it waits for shutdown signals, delays the first update, runs update checks forever, and exits cleanly when asked to terminate. On non-Unix systems, it reports that this updater style is unsupported.

**Data flow**: It begins with no caller-provided input, then creates a listener for the operating system terminate signal and reads the identity of the currently running updater executable. It waits for the initial delay unless a shutdown arrives first. After that, it repeatedly asks `update_once` to perform a single update pass, waits for the regular update interval, and returns success when the loop is told to stop. On unsupported platforms, it immediately returns an error.

**Call relations**: This is called by `run_pid_update_loop` when the daemon wants to start the pid-managed updater. It calls `current_updater_identity` once at startup, uses `sleep_or_terminate` between work cycles, and calls `update_once` for each actual update attempt. It also installs the terminate signal listener so the rest of the loop can stop promptly.

*Call graph*: calls 3 internal fn (current_updater_identity, sleep_or_terminate, update_once); called by 1 (run_pid_update_loop); 3 external calls (terminate, bail!, signal).


##### `sleep_or_terminate`  (lines 77–82)

```
async fn sleep_or_terminate(duration: Duration, terminate: &mut Signal) -> bool
```

**Purpose**: Waits for either a timer to finish or a shutdown request to arrive. It lets the updater pause without becoming deaf to termination.

**Data flow**: It receives a duration and a mutable terminate-signal listener. It waits on both at the same time: the timer and the next terminate signal. It returns `false` if the timer completed normally, or `true` if a terminate signal arrived first.

**Call relations**: `run` uses this during the initial delay and between hourly update passes. `update_once` uses it when the daemon is busy and the updater needs to retry soon. It is the small helper that keeps long waits responsive to shutdown.

*Call graph*: called by 2 (run, update_once); 1 external calls (select!).


##### `update_once`  (lines 91–119)

```
async fn update_once(
    running_updater_identity: &ExecutableIdentity,
    terminate: &mut Signal,
) -> Result<UpdateLoopControl>
```

**Purpose**: Performs one full update attempt: install the latest standalone Codex, inspect the managed binary, choose the right restart behavior, and try to restart the daemon if appropriate.

**Data flow**: It receives the identity of the updater executable that was running when the loop started, plus the terminate-signal listener. First it runs `install_latest_standalone`. Then it reads daemon settings from the environment, resolves the path to the managed Codex binary, and computes that binary’s identity. It compares the two identities to choose restart and updater-refresh modes. It then tries to restart the daemon if it is running. If the daemon is busy, it waits briefly and retries unless a terminate signal arrives. It returns `Continue` when the update pass is complete, or `Stop` when shutdown should end the whole loop.

**Call relations**: `run` calls this once per update cycle. Inside the cycle it hands off installation to `install_latest_standalone`, identity checking to `executable_identity` and `resolved_managed_codex_bin`, policy selection to `update_modes_for_identities`, and restart work to the daemon’s `try_restart_if_running`. Its retry path uses `sleep_or_terminate` so shutdown still wins over retrying.

*Call graph*: calls 6 internal fn (from_environment, executable_identity, resolved_managed_codex_bin, install_latest_standalone, sleep_or_terminate, update_modes_for_identities); called by 1 (run); 1 external calls (recv).


##### `current_updater_identity`  (lines 122–126)

```
async fn current_updater_identity() -> Result<ExecutableIdentity>
```

**Purpose**: Figures out exactly which updater executable is currently running. This matters because the loop later compares it with the managed Codex binary to decide whether the updater itself should be refreshed.

**Data flow**: It reads the current process’s executable path from the operating system. It then passes that path to `executable_identity`, which produces an identity value for the file. The result is returned to the caller, or an error is returned if the path or identity cannot be read.

**Call relations**: `run` calls this once before the first update delay. The identity it returns is carried into every `update_once` call, where it is compared with the managed binary’s identity.

*Call graph*: calls 1 internal fn (executable_identity); called by 1 (run); 1 external calls (current_exe).


##### `update_modes_for_identities`  (lines 129–141)

```
fn update_modes_for_identities(
    running_updater_identity: &ExecutableIdentity,
    managed_identity: &ExecutableIdentity,
) -> (RestartMode, UpdaterRefreshMode)
```

**Purpose**: Chooses the restart policy by comparing the updater that is currently running with the managed Codex binary. In plain terms, it answers: are we already running the managed version, or should we switch to it?

**Data flow**: It receives two executable identities: one for the running updater and one for the managed Codex binary. If they match, it returns a conservative mode: restart only if the version changed, and do not refresh the updater process. If they differ, it returns a stronger mode: always restart and re-execute the updater if the managed binary changed.

**Call relations**: `update_once` calls this after it has identified both executables. The returned modes are passed into the daemon restart attempt, which uses them to decide whether to restart the service and whether to replace the updater process.

*Call graph*: called by 1 (update_once).


##### `reexec_managed_updater`  (lines 144–154)

```
fn reexec_managed_updater(managed_codex_bin: &std::path::Path) -> Result<()>
```

**Purpose**: Replaces the currently running updater process with the managed Codex binary. This is how the updater stops running from an old or standalone executable and continues from the installed managed one.

**Data flow**: It receives the path to the managed Codex binary. It starts an operating-system `exec`, which means the current process is replaced in place rather than launching a separate child process. The new process is invoked with arguments that tell it to run the app-server daemon pid update loop. If replacement fails, the function returns an error explaining which binary could not be used.

**Call relations**: This is called by `try_restart_if_running` when the restart logic decides the updater should refresh itself. Unlike ordinary helper calls, a successful `exec` does not return to the old code at all; the process has become the managed updater.

*Call graph*: called by 1 (try_restart_if_running); 1 external calls (new).


##### `install_latest_standalone`  (lines 157–193)

```
async fn install_latest_standalone() -> Result<()>
```

**Purpose**: Downloads and runs the standalone Codex installer script. This is the step that actually brings the local Codex installation up to date before the daemon restart decision is made.

**Data flow**: It fetches `https://chatgpt.com/codex/install.sh`, checks that the web request succeeded, and reads the script bytes. It then starts `/bin/sh -s` with standard input connected, sends the downloaded script into that shell, hides the script’s output by sending stdout and stderr to null, and waits for the shell to finish. It returns success if the installer exits successfully, or an error if fetching, starting, writing, waiting, or the installer itself fails.

**Call relations**: `update_once` calls this at the start of every update pass. Once this installer has run, `update_once` can inspect the managed Codex binary and decide whether the daemon and updater need to restart.

*Call graph*: called by 1 (update_once); 5 external calls (null, piped, bail!, new, get).


### Connection shutdown gating
Stops new per-connection RPC work from starting and then manages the remaining cleanup tasks through graceful completion or abort.

### `app-server/src/connection_rpc_gate.rs`

`orchestration` · `request handling and connection shutdown`

An RPC, or remote procedure call, is a request sent over a connection asking the server to run some handler code. This file protects the awkward moment when a connection is closing. Without it, a handler could start after shutdown had begun, or shutdown could finish while earlier handler work was still running.

The main type is `ConnectionRpcGate`. Think of it like a door with a guest list counter. While the door is open, a handler can enter and receives a temporary “token” showing it is inside. When the door closes, no new handlers are allowed in, but anyone already inside is allowed to leave normally.

It uses a mutex, which is a lock that stops two async tasks from changing the same flag at the same time, to store whether the gate is still accepting work. It also uses a `TaskTracker`, a helper that counts active pieces of work and can wait until they are all done.

The important behavior is graceful shutdown. `close` flips the gate to closed and prevents future work. `shutdown` does that and then waits until all handlers that already got through the gate have finished. The tests check that open gates run work, closed gates do not even begin polling late work, and shutdown waits only for work that had already started.

#### Function details

##### `ConnectionRpcGate::new`  (lines 17–23)

```
fn new() -> Self
```

**Purpose**: Creates a fresh gate that is open and ready to let RPC handler work start. It also creates an empty tracker so active work can be counted from the beginning.

**Data flow**: Nothing is passed in. The function sets the internal accepting flag to true and creates a new task tracker with no active tokens. It returns a `ConnectionRpcGate` ready for use on a connection.

**Call relations**: This is the starting point for the gate. Tests create gates with it before checking open, closed, and shutdown behavior, and the `Default` implementation also uses it so callers can create the same open gate through Rust’s standard default pattern.

*Call graph*: called by 8 (close_returns_while_started_run_remains_active, run_drops_future_without_polling_after_close, run_executes_while_open, run_is_counted_before_handler_body_continues, shutdown_drops_late_runs_while_waiting_for_inflight_work, shutdown_waits_for_started_run_to_finish, new, gate); 2 external calls (new, new).


##### `ConnectionRpcGate::run`  (lines 25–39)

```
async fn run(&self, future: F)
```

**Purpose**: Runs one RPC handler only if the connection is still accepting work. If the gate has already been closed, it returns without starting the handler at all.

**Data flow**: It receives a future, which is async work that has not necessarily run yet. It first locks the accepting flag. If the flag is false, it drops the future untouched and returns. If the flag is true, it takes a tracker token, releases the lock, awaits the future until it finishes, and then drops the token so the active-work count goes down.

**Call relations**: This is the gate’s main doorway for handler execution. Connection code would wrap each initialized RPC handler in this method. It asks the task tracker for a token before letting the handler body continue, so `shutdown` later has something reliable to wait on.

*Call graph*: 1 external calls (token).


##### `ConnectionRpcGate::close`  (lines 41–45)

```
async fn close(&self)
```

**Purpose**: Closes the gate so no later RPC handlers can start. It does not wait for already-started handlers to finish.

**Data flow**: It reads and changes the internal accepting flag under the mutex. The flag changes from true, or remains false if already closed, to false. It also closes the task tracker so no new tracked work should be accepted. It returns once the gate is closed, even if some work is still active.

**Call relations**: `shutdown` calls this as its first step. Tests also call it directly to prove that closing blocks later `run` calls while leaving already-started work alone.

*Call graph*: called by 1 (shutdown); 1 external calls (close).


##### `ConnectionRpcGate::shutdown`  (lines 47–50)

```
async fn shutdown(&self)
```

**Purpose**: Performs a graceful shutdown of the gate. It stops new RPC handlers from starting, then waits until all handlers that already started have finished.

**Data flow**: It takes the existing gate state. First it calls `close`, which turns off new entries. Then it waits on the task tracker until every active token has been dropped. It returns only after there is no tracked in-flight work left.

**Call relations**: This is the full shutdown path for connection cleanup. It builds directly on `close`, then hands off to the tracker’s waiting mechanism so callers can safely know that handler work has drained.

*Call graph*: calls 1 internal fn (close); 1 external calls (wait).


##### `ConnectionRpcGate::is_accepting`  (lines 53–55)

```
async fn is_accepting(&self) -> bool
```

**Purpose**: Reports whether the gate is currently open to new work. This helper exists only for tests.

**Data flow**: It locks the accepting flag, copies out the boolean value, and returns it. It does not change the gate.

**Call relations**: The tests use this to check the visible effect of calling `close` or `shutdown`. Production code does not use it because it is compiled only during testing.


##### `ConnectionRpcGate::inflight_count`  (lines 58–60)

```
fn inflight_count(&self) -> usize
```

**Purpose**: Reports how many RPC handlers are currently tracked as in progress. This helper exists only for tests.

**Data flow**: It asks the task tracker for its current length and returns that number. It does not start, stop, or change any work.

**Call relations**: The tests use this to prove that `run` adds work to the tracker before the handler body continues, and that the count returns to zero after the handler finishes.

*Call graph*: 1 external calls (len).


##### `ConnectionRpcGate::default`  (lines 64–66)

```
fn default() -> Self
```

**Purpose**: Provides Rust’s standard default construction behavior for this gate. A default gate is the same as a newly created open gate.

**Data flow**: Nothing is passed in. It delegates to `ConnectionRpcGate::new` and returns the resulting open gate.

**Call relations**: This fits the gate into Rust APIs that expect a `Default` value. Rather than keeping separate setup logic, it relies on `new` so both construction paths stay identical.

*Call graph*: 1 external calls (new).


##### `tests::run_executes_while_open`  (lines 81–92)

```
async fn run_executes_while_open()
```

**Purpose**: Checks that an open gate actually runs the async work passed to `run`. This protects the normal successful path.

**Data flow**: The test starts with a new open gate and an atomic boolean set to false. It passes async work that flips the boolean to true. After `run` finishes, the test reads the boolean and expects it to be true.

**Call relations**: This test exercises the basic relationship between `new` and `run`: a freshly created gate should accept work. It uses shared atomic state so the test can see whether the handler body ran.

*Call graph*: calls 1 internal fn (new); 4 external calls (clone, new, new, assert!).


##### `tests::run_drops_future_without_polling_after_close`  (lines 95–108)

```
async fn run_drops_future_without_polling_after_close()
```

**Purpose**: Checks that once the gate is closed, later work does not start at all. This matters because merely creating async work is different from polling it, which is what actually begins running it.

**Data flow**: The test creates a gate, closes it, and prepares async work that would flip an atomic boolean if it ran. It calls `run` with that work. The expected result is that the boolean stays false and the gate reports that it is not accepting.

**Call relations**: This test connects `close`, `run`, and `is_accepting`. It proves that closing the gate affects future `run` calls immediately, instead of letting a late handler sneak through.

*Call graph*: calls 1 internal fn (new); 4 external calls (clone, new, new, assert!).


##### `tests::close_returns_while_started_run_remains_active`  (lines 111–135)

```
async fn close_returns_while_started_run_remains_active()
```

**Purpose**: Checks that `close` stops new work but does not wait for or cancel work that already started. This confirms the difference between closing the door and waiting for everyone to leave.

**Data flow**: The test starts a handler that signals when it has begun, then waits on a one-shot message before finishing. After the handler has started, the test calls `close`. It expects the gate to be closed and the in-flight count to still be one. Then it sends the finish message, waits for the run task to complete, and shuts the gate down cleanly.

**Call relations**: This test uses `new`, `run`, `close`, `inflight_count`, and `shutdown` together. It shows that `close` is a non-blocking step, while the later cleanup can still wait for the active task.

*Call graph*: calls 1 internal fn (new); 6 external calls (clone, new, assert!, assert_eq!, channel, spawn).


##### `tests::shutdown_waits_for_started_run_to_finish`  (lines 138–170)

```
async fn shutdown_waits_for_started_run_to_finish()
```

**Purpose**: Checks that `shutdown` waits for already-started work instead of returning too early. This protects graceful connection cleanup.

**Data flow**: The test starts a handler that signals it has begun and then waits for permission to finish. It starts shutdown in another task and uses a short timeout to confirm shutdown does not complete while the handler is still waiting. After sending the finish signal, it waits for the running task and confirms the in-flight count can reach zero.

**Call relations**: This test focuses on the relationship between `run` and `shutdown`. Because `shutdown` calls `close` and then waits on the tracker, the test verifies that the tracker token held by `run` really keeps shutdown pending.

*Call graph*: calls 1 internal fn (new); 7 external calls (clone, new, from_millis, assert_eq!, channel, spawn, timeout).


##### `tests::shutdown_drops_late_runs_while_waiting_for_inflight_work`  (lines 173–212)

```
async fn shutdown_drops_late_runs_while_waiting_for_inflight_work()
```

**Purpose**: Checks the tricky case where shutdown has begun but one earlier handler is still running. Late work should be rejected during that waiting period.

**Data flow**: The test starts one handler and holds it open. It starts shutdown and confirms with a timeout that shutdown is waiting. While shutdown is waiting, it calls `run` with new async work that would flip a boolean if it ran. The boolean must stay false. Then the original handler is allowed to finish, and the final in-flight count should be zero.

**Call relations**: This test ties together `run`, `shutdown`, and the closed accepting flag. It proves that once shutdown has closed the gate, the system both waits for old work and rejects new work at the same time.

*Call graph*: calls 1 internal fn (new); 9 external calls (clone, new, new, from_millis, assert!, assert_eq!, channel, spawn, timeout).


##### `tests::run_is_counted_before_handler_body_continues`  (lines 215–237)

```
async fn run_is_counted_before_handler_body_continues()
```

**Purpose**: Checks that a handler is counted as in flight before its body proceeds far enough to signal entry. This avoids a race where shutdown might miss work that has just started.

**Data flow**: The test starts a handler that sends an entered signal and then waits. After receiving the entered signal, the test checks the in-flight count and expects it to be one. It then lets the handler continue, waits for it to finish, and expects the count to return to zero.

**Call relations**: This test examines the ordering inside `run`: the tracker token must be acquired before the handler body continues. That ordering is what makes `shutdown` reliable when work starts near the same time as closing.

*Call graph*: calls 1 internal fn (new); 5 external calls (clone, new, assert_eq!, channel, spawn).


### `app-server/src/connection_cleanup.rs`

`orchestration` · `connection cleanup and shutdown`

When a network connection ends, there may still be small pieces of work to do, such as closing resources or finishing cleanup steps. This file provides a simple holder for those background jobs so they do not get lost. Think of it like a clipboard for janitorial tasks: each finished connection can add a cleanup job, and the server can later check the clipboard, wait for jobs, or cancel everything when it is time to stop.

The main type, `ConnectionCleanupTasks`, wraps Tokio's `JoinSet`, which is a collection of asynchronous tasks that can run at the same time. An asynchronous task is work that can pause while waiting and let other work continue. The file offers methods to create the collection, add a cleanup task, wait for one task to finish, wait for all tasks to finish, and abort all remaining tasks.

A small helper, `log_cleanup_result`, makes cleanup failures visible. If a task fails unexpectedly, it writes a warning. If the task was cancelled on purpose, it stays quiet, because cancellation during shutdown is normal. One important detail is that `reap_next` waits forever when there are no tasks. That makes it useful in a larger `select`-style event loop: it will only wake the loop when there is actually cleanup work to collect.

#### Function details

##### `ConnectionCleanupTasks::new`  (lines 13–17)

```
fn new() -> Self
```

**Purpose**: Creates an empty tracker for connection cleanup tasks. The server uses this when it starts the main run flow so it has one place to collect later cleanup jobs.

**Data flow**: Nothing is passed in. The function creates a fresh empty task collection and wraps it in `ConnectionCleanupTasks`. The result is a ready-to-use cleanup tracker with no jobs inside yet.

**Call relations**: The main server setup, `run_main_with_transport_options`, calls this when preparing to run. After that, other parts of the server can add cleanup jobs to the tracker and wait for them through its other methods.

*Call graph*: called by 1 (run_main_with_transport_options); 1 external calls (new).


##### `ConnectionCleanupTasks::spawn`  (lines 19–21)

```
fn spawn(&mut self, future: impl Future<Output = ()> + Send + 'static)
```

**Purpose**: Adds a new cleanup job to the background task collection. Someone uses this when cleanup should happen without blocking the main server work.

**Data flow**: It receives a future, which is a piece of asynchronous work that will eventually finish. It gives that future to Tokio's task system, which starts running it in the background, and stores it in the internal collection so the server can later observe or cancel it. It returns nothing directly.

**Call relations**: This is the entry point for putting cleanup work under this file's supervision. Once a job has been spawned here, `reap_next` or `drain` can later collect its result, and `abort` can cancel it if shutdown happens first.

*Call graph*: 1 external calls (spawn).


##### `ConnectionCleanupTasks::reap_next`  (lines 23–30)

```
async fn reap_next(&mut self)
```

**Purpose**: Waits for one cleanup task to finish and records whether it ended normally or failed. It is designed for a main loop that wants to periodically collect completed cleanup work without draining everything at once.

**Data flow**: It reads the internal task collection. If there are no tasks, it waits forever, which means it produces no event until some other branch of the surrounding program does something. If there is at least one task, it waits until one finishes, then passes that task's result to `log_cleanup_result`. It does not return a value, but it removes the finished task from the collection.

**Call relations**: This method calls `log_cleanup_result` after Tokio reports that a cleanup task has completed. In the bigger flow, it acts like the server's broom: each time the run loop is ready to collect one finished cleanup job, this method picks it up and hands the outcome to the logging helper.

*Call graph*: calls 1 internal fn (log_cleanup_result); 2 external calls (is_empty, join_next).


##### `ConnectionCleanupTasks::drain`  (lines 32–36)

```
async fn drain(&mut self)
```

**Purpose**: Waits for every remaining cleanup task to finish. This is useful during orderly shutdown, when the server wants to give cleanup work a chance to complete before exiting.

**Data flow**: It repeatedly asks the internal task collection for the next finished task. Each result is sent to `log_cleanup_result` so failures are not hidden. The loop ends when no cleanup tasks remain. It returns nothing, but the collection is empty afterward.

**Call relations**: This method uses `log_cleanup_result` for each completed task, just like `reap_next`, but keeps going until the collection is empty. It is the finishing step when the server wants to clear all outstanding cleanup jobs rather than collect just one.

*Call graph*: calls 1 internal fn (log_cleanup_result); 1 external calls (join_next).


##### `ConnectionCleanupTasks::abort`  (lines 38–40)

```
fn abort(&mut self)
```

**Purpose**: Cancels all cleanup tasks that are still running. This is used when the server needs to stop quickly and should not wait for background cleanup to finish.

**Data flow**: It reads the internal task collection and tells Tokio to abort every task in it. The tasks are marked for cancellation. The function returns nothing; later, if those cancelled tasks are collected, their cancellation is treated as expected rather than as a warning.

**Call relations**: This method is the emergency stop for the cleanup tracker. After tasks have been added with `spawn`, shutdown code can call `abort` to cancel them all, and `log_cleanup_result` will avoid warning about those intentional cancellations when their results are later observed.

*Call graph*: 1 external calls (abort_all).


##### `log_cleanup_result`  (lines 43–49)

```
fn log_cleanup_result(result: Result<(), JoinError>)
```

**Purpose**: Decides whether a finished cleanup task needs a warning in the logs. It keeps normal completions and intentional cancellations quiet, but reports unexpected task failures.

**Data flow**: It receives the result of a background cleanup task. If the result is successful, it does nothing. If the task ended with an error, it checks whether that error was just cancellation; cancelled tasks are ignored, while other errors are written as warnings. It returns nothing.

**Call relations**: `reap_next` and `drain` call this after receiving completed task results from Tokio. It is the shared checkpoint that turns raw task outcomes into useful server logs, so the rest of the cleanup code does not repeat the same error-checking rules.

*Call graph*: called by 2 (drain, reap_next); 1 external calls (warn!).


### Agent thread closure
Shuts down legacy agent threads and persists the resulting closed thread-tree state, including descendant teardown.

### `core/src/agent/control/legacy.rs`

`domain_logic` · `request handling and teardown`

An agent here is a running worker thread with its own session and status. This file answers a practical question: when someone says “stop that agent,” what exactly has to happen so the worker does not keep running, lose saved progress, or remain listed as alive?

There are two related ideas. “Shutdown” means asking a live agent to stop. “Close” means recording, in saved state, that this agent’s spawn link is explicitly closed, so it should not be treated as still open later. The file also supports shutting down an agent’s live descendants, which are agents that were spawned under it in the in-memory tree.

The flow is careful. Before stopping a live agent, it materializes and flushes its rollout, meaning it makes sure pending session progress is written out. If the agent is already shut down, it avoids sending a duplicate shutdown request. Either way, it waits until the thread has actually terminated, then removes it from in-memory tracking and releases related residency/spawn bookkeeping. Closing adds one more step: it tries to persist the “closed” status first, even for a known agent that is no longer live. This matters because without that saved mark, a future run could misunderstand the old spawn edge as still active.

#### Function details

##### `AgentControl::shutdown_live_agent`  (lines 6–25)

```
async fn shutdown_live_agent(&self, agent_id: ThreadId) -> CodexResult<String>
```

**Purpose**: Stops one live agent without marking its saved spawn relationship as closed. It is used when the system needs the worker gone now, while leaving the separate “was this explicitly closed?” record unchanged.

**Data flow**: It receives an agent thread id. It first upgrades the control handle into live shared state; if that fails, the error is returned. If the thread is found, it makes sure the session’s pending rollout data exists and is flushed to storage, checks whether the agent is already shut down, and otherwise sends it a shutdown operation. It then waits for the thread to finish. If the thread was not found, it still tries to send a shutdown operation by id. At the end it removes the thread from tracking, forgets related residency information, releases spawned-thread bookkeeping, and returns either the shutdown result string or an error.

**Call relations**: This is the basic single-agent stop action. AgentControl::shutdown_agent_tree calls it first for the requested agent and then for each descendant, so the tree-level shutdown can reuse the same careful cleanup path for every live worker.

*Call graph*: called by 1 (shutdown_agent_tree); 2 external calls (new, matches!).


##### `AgentControl::close_agent`  (lines 29–70)

```
async fn close_agent(&self, agent_id: ThreadId) -> CodexResult<String>
```

**Purpose**: Marks an agent as explicitly closed in saved state, then shuts down that agent and any live descendants beneath it. This is the stronger form of stopping: it records the user’s intent, not just the fact that the process should stop.

**Data flow**: It receives an agent thread id. It checks whether the system already knows metadata for that agent, then tries to inspect the live thread. If the thread is live and has access to the state database, it writes the spawn-edge status as Closed. If the thread is gone but the agent is still known, it tries to write the same Closed mark through the broader state database; failure there becomes a fatal error because the saved close decision would be lost. Other inspection failures are logged as warnings. After this persistence step, it calls the tree shutdown path. If a known stale agent is already missing or internally dead, it treats that as a harmless successful close.

**Call relations**: This is the higher-level close operation. It does the persistent “closed” bookkeeping itself, logs or returns errors when that bookkeeping cannot be trusted, and then hands the actual stopping work to AgentControl::shutdown_agent_tree.

*Call graph*: calls 1 internal fn (shutdown_agent_tree); 5 external calls (pin, new, format!, Fatal, warn!).


##### `AgentControl::shutdown_agent_tree`  (lines 73–83)

```
async fn shutdown_agent_tree(&self, agent_id: ThreadId) -> CodexResult<String>
```

**Purpose**: Stops one agent plus any live child agents that can be reached from the current in-memory spawn tree. It is useful when stopping a parent should also clean up workers that were started under it.

**Data flow**: It receives the root agent thread id. It asks for the list of live descendant thread ids, then shuts down the root agent and saves that result. After that it walks through each descendant and shuts it down too. Missing or already-dead descendants are ignored, because they no longer need stopping. Any other descendant shutdown error stops the process and is returned. If descendant cleanup succeeds, the function returns the original root agent’s shutdown result.

**Call relations**: AgentControl::close_agent calls this after it has recorded the close status. This function coordinates the multi-agent shutdown, while AgentControl::shutdown_live_agent performs the actual per-agent flush, stop request, wait, and cleanup.

*Call graph*: calls 1 internal fn (shutdown_live_agent); called by 1 (close_agent).

## 📊 State Registers Touched

- `reg-state-databases` — The opened local SQLite stores and migration state that hold structured runtime data for threads, agents, goals, jobs, and summaries.
- `reg-rollout-thread-store` — The durable conversation log and searchable thread index used to resume, rebuild, archive, restore, and display sessions.
- `reg-app-server-runtime` — The live app-server or daemon state, including open transports, connected clients, request routing, and server lifecycle status.
- `reg-remote-control-relay` — The remote-control, relay, socket, WebSocket, and encrypted connection state used to connect clients and helper processes.
- `reg-process-registry` — The shared record of running or tracked external processes, their identifiers, input/output streams, terminal sizes, and completion state.
- `reg-live-session-services` — The toolbox attached to one running session, such as model access, auth, telemetry, approvals, tools, extensions, networking, and MCP connections.
- `reg-thread-session-state` — The live state of a conversation thread, including its identity, workspace, selected model, history, permissions, listeners, and lifecycle status.
- `reg-agent-registry-graph` — The live and persisted map of parent agents, child agents, thread names, statuses, and which helper agents are still open.
- `reg-background-work-queues` — The shared set of background tasks such as cloud refreshes, cleanup jobs, memory jobs, skill watchers, agent jobs, update checks, and session maintenance.
- `reg-observability-telemetry` — The shared logs, traces, metrics, analytics facts, rollout tracing, debug captures, and feedback evidence used to understand what happened.
- `reg-update-check-state` — Cached update notices, downloaded-or-pending update metadata, and daemon restart/update status produced by update checks and consumed by UI or teardown restart logic.
- `reg-code-mode-runtime-state` — The live code-mode execution sessions, V8 isolates, loaded modules, pending calls, timers, and shutdown state for JavaScript/code-cell execution.
- `reg-realtime-stream-state` — Active realtime conversation state, including audio/text stream sessions, WebSocket transport state, buffers, and stop/cancel lifecycle data.
- `reg-request-serialization-gates` — The in-flight RPC/session request admission gates, per-resource serialization queues, and shutdown blockers that control when handlers may start or must drain.
- `reg-terminal-runtime-state` — Live terminal control state such as raw mode, alternate screen ownership, resize/suspend handling, input streams, and restoration obligations.
- `reg-process-hardening-state` — Process-wide hardening status and OS security settings applied at bootstrap, such as dump/inspection/tamper restrictions that affect the rest of the run.
- `reg-outgoing-transport-buffers` — Queued outbound protocol messages, write buffers, and backpressure state for app-server, daemon, exec-server, and remote transports.
