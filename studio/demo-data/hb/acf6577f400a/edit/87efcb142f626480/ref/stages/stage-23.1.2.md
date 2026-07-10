# Daemon, transport, and test-client support tests  `stage-23.1.2`

This stage is the safety net and test toolkit for the app-server’s behind-the-scenes support systems. It checks three important areas: the daemon, which is the long-running background process; the transport layer, which is how parts of the system talk to each other; and a special test client used to drive realistic end-to-end checks.

The daemon tests make sure process tracking and updating behave safely in tricky cases. `pid_tests.rs` checks how the server records and reuses process IDs, especially when files are empty, stale, or racing with another start. `managed_install_tests.rs` and `update_loop_tests.rs` verify how installed binaries are identified and when the updater should restart or refresh itself.

The transport tests check both local sockets and message-routing rules. `unix_socket_tests.rs` covers Unix sockets, startup locking, and cleanup. `transport_tests.rs` checks which messages are forwarded, dropped, or delayed. The remote-control tests verify client listing, revocation, pairing, token refresh, and clear error reporting.

The test-client code is the hands-on driver. `lib.rs` launches or connects to the server and sends requests. The loopback server fakes a small HTTP service for tests. The plugin analytics files capture emitted event logs and run smoke tests to confirm plugin install, uninstall, and usage events are recorded correctly.

## Files in this stage

### Daemon backend and updater tests
These tests pin down daemon-side PID handling and managed-install/update identity decisions that govern backend launch and restart behavior.

### `app-server-daemon/src/backend/pid_tests.rs`

`test` · `test-time validation of backend startup/shutdown semantics`

This test module focuses on the tricky edges of `PidBackend`. Several async tests create temporary pid files and lock files to simulate startup reservations without launching real processes. `locked_empty_pid_file_is_treated_as_active_reservation` and `unlocked_empty_pid_file_is_treated_as_stale_reservation` verify the distinction between an empty pid file that still has a live reservation lock versus one that should be deleted as stale. `stop_waits_for_live_reservation_to_resolve` confirms that shutdown does not fail immediately when it encounters a startup-in-progress marker; instead it waits for the reservation to disappear. `start_retries_stale_empty_pid_file_under_its_own_lock` checks that startup can recover from a stale empty pid file and proceed far enough to fail on the missing executable rather than on pid-file state.

Other tests validate race-safe stale-record cleanup (`stale_record_cleanup_preserves_replacement_record`), exact argv/env generation for updater and remote-control modes, and stderr-tail truncation behavior that preserves only recent complete lines. Together these tests document the backend’s intended invariants: empty pid files are meaningful only in conjunction with the lock, stale cleanup must not delete replacement records, and compatibility with older app-server remote-control behavior is encoded in launch arguments and environment variables.

#### Function details

##### `locked_empty_pid_file_is_treated_as_active_reservation`  (lines 18–43)

```
async fn locked_empty_pid_file_is_treated_as_active_reservation()
```

**Purpose**: Verifies that an empty pid file plus a held reservation lock is interpreted as `Starting`, not as stale state. It also confirms the pid file is left in place.

**Data flow**: Creates a temp directory, writes an empty pid file, constructs a `PidBackend`, opens and locks the backend’s lock file, then calls `read_pid_file_state`. It asserts the returned state is `PidFileState::Starting` and that the pid file still exists.

**Call relations**: This test directly exercises `PidBackend::new`, `try_lock_file`, and `read_pid_file_state` to pin down the active-reservation branch used by production startup and stop logic.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert!, assert_eq!, new, write).


##### `unlocked_empty_pid_file_is_treated_as_stale_reservation`  (lines 46–63)

```
async fn unlocked_empty_pid_file_is_treated_as_stale_reservation()
```

**Purpose**: Verifies that an empty pid file without an active lock is treated as stale and cleaned up. This distinguishes abandoned reservations from live startup.

**Data flow**: Creates a temp directory and empty pid file, constructs a backend, calls `read_pid_file_state`, and asserts the result is `PidFileState::Missing`. It then checks that the pid file has been removed.

**Call relations**: This test covers the stale-empty-file path in `read_pid_file_state` and `inspect_empty_pid_reservation`, documenting the cleanup behavior relied on by later startup attempts.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert!, assert_eq!, write).


##### `stop_waits_for_live_reservation_to_resolve`  (lines 66–95)

```
async fn stop_waits_for_live_reservation_to_resolve()
```

**Purpose**: Checks that `stop` waits for an in-progress startup reservation to finish or disappear instead of failing immediately. It models a short-lived reservation that is released asynchronously.

**Data flow**: Creates an empty pid file and locked reservation, spawns a cleanup task that sleeps briefly, drops the lock, and removes the pid file, then awaits `backend.stop()`. The test passes if stop returns successfully after the reservation resolves.

**Call relations**: This test drives the `stop` → `wait_for_pid_start` polling path, proving that shutdown cooperates with concurrent startup reservations.

*Call graph*: calls 1 internal fn (new); 8 external calls (from_millis, new, assert!, new, remove_file, write, spawn, sleep).


##### `start_retries_stale_empty_pid_file_under_its_own_lock`  (lines 98–115)

```
async fn start_retries_stale_empty_pid_file_under_its_own_lock()
```

**Purpose**: Ensures startup can recover from a stale empty pid file by cleaning it up under lock and continuing to the actual spawn step. The observed failure should therefore be the missing executable, not pid-file contention.

**Data flow**: Creates an empty pid file, constructs a backend pointing at a nonexistent binary, calls `start`, captures the error, and asserts its string begins with the spawn-failure prefix.

**Call relations**: This test exercises the startup loop that acquires the reservation lock, reinterprets stale pid-file state with lock held, removes stale files, and retries before spawning.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert!, write).


##### `stale_record_cleanup_preserves_replacement_record`  (lines 118–148)

```
async fn stale_record_cleanup_preserves_replacement_record()
```

**Purpose**: Verifies that stale-record cleanup does not delete a newer pid record written by another actor. Only an exact stale-record match should be removed.

**Data flow**: Constructs a backend, defines a stale `PidRecord` and a different replacement record, writes the replacement JSON to the pid file, then calls `refresh_after_stale_record(&stale)`. It asserts the returned state is `PidFileState::Running(replacement)`.

**Call relations**: This test targets the compare-before-delete logic in `refresh_after_stale_record`, which production liveness checks and shutdown rely on to avoid races.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert_eq!, to_vec, write).


##### `update_loop_uses_hidden_app_server_subcommand`  (lines 151–163)

```
fn update_loop_uses_hidden_app_server_subcommand()
```

**Purpose**: Checks the exact argv used for updater mode. The updater must launch through the hidden `app-server daemon pid-update-loop` subcommand.

**Data flow**: Builds a `PidBackend` struct literal with `PidCommandKind::UpdateLoop`, calls `command_args`, and asserts the returned vector matches the expected updater argv.

**Call relations**: This test documents the updater-specific command generation used by bootstrap when starting the managed update loop.

*Call graph*: 1 external calls (assert_eq!).


##### `app_server_remote_control_uses_runtime_flag`  (lines 166–177)

```
fn app_server_remote_control_uses_runtime_flag()
```

**Purpose**: Checks that enabling remote control adds the explicit `--remote-control` runtime flag to the app-server command line.

**Data flow**: Constructs a normal backend with `remote_control_enabled = true`, calls `command_args`, and asserts the returned argv includes `--remote-control` before `--listen unix://`.

**Call relations**: This test validates the launch behavior selected by `PidBackend::new` and `command_args` for remote-control-enabled daemon settings.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `app_server_disabled_remote_control_uses_compatible_args_and_runtime_env`  (lines 180–195)

```
fn app_server_disabled_remote_control_uses_compatible_args_and_runtime_env()
```

**Purpose**: Checks the compatibility behavior for remote-control-disabled launches: no `--remote-control` flag, plus an explicit disabling environment variable.

**Data flow**: Constructs a backend with `remote_control_enabled = false`, reads both `command_args` and `command_env`, and asserts they match the expected argv and `(REMOTE_CONTROL_DISABLED_ENV_VAR, "1")` pair.

**Call relations**: This test covers the disabled branch of both `command_args` and `command_env`, documenting how the daemon communicates remote-control-off semantics to the managed binary.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `read_stderr_log_tail_returns_recent_complete_lines`  (lines 198–216)

```
async fn read_stderr_log_tail_returns_recent_complete_lines()
```

**Purpose**: Verifies that stderr-tail reading keeps only recent complete lines when truncating a large log. Partial leading content from the byte cutoff should be discarded.

**Data flow**: Creates a temp pid file path, derives the stderr log path, writes a log whose first line exceeds the byte limit followed by two short lines, then calls `read_stderr_log_tail`. It asserts the returned `PidLogTail` contains only `recent error\nusage` and the correct path.

**Call relations**: This test exercises `stderr_log_file_for_pid_file`, `read_stderr_log_tail`, and the partial-line trimming logic in `read_log_tail`, which feeds readiness diagnostics.

*Call graph*: 5 external calls (new, assert_eq!, format!, stderr_log_file_for_pid_file, write).


### `app-server-daemon/src/managed_install_tests.rs`

`test` · `test-time validation of managed-install helpers`

This small test module validates the pure helper behavior in `managed_install.rs`. The version-parsing tests define the accepted shape of `codex --version` output: `parses_codex_cli_version_output` confirms that a normal `codex 1.2.3` line yields `1.2.3`, while `rejects_malformed_codex_cli_version_output` ensures that output lacking a second token is rejected rather than silently misparsed. That matters because daemon status reporting and updater restart decisions depend on a trustworthy managed binary version string.

The executable identity test checks that `ExecutableIdentity` is content-based rather than path-based or instance-based. By hashing `b"old"` twice and `b"new"` once, it confirms equal bytes produce equal identities and different bytes produce different identities. This protects updater logic that compares binaries by digest to detect real changes. The tests are intentionally direct and pure: they avoid filesystem or process spawning and instead exercise the parsing and hashing cores in isolation.

#### Function details

##### `parses_codex_cli_version_output`  (lines 7–12)

```
fn parses_codex_cli_version_output()
```

**Purpose**: Confirms that well-formed `codex --version` output yields the expected version token.

**Data flow**: Calls `parse_codex_version("codex 1.2.3\n")` and asserts the returned string is `1.2.3`.

**Call relations**: This test documents the happy-path parser behavior used by `managed_codex_version`.

*Call graph*: 1 external calls (assert_eq!).


##### `rejects_malformed_codex_cli_version_output`  (lines 15–17)

```
fn rejects_malformed_codex_cli_version_output()
```

**Purpose**: Confirms that malformed version output lacking a version token is rejected.

**Data flow**: Calls `parse_codex_version("codex\n")` and asserts the result is an error.

**Call relations**: This test covers the parser’s failure branch, ensuring daemon code does not accept ambiguous version output.

*Call graph*: 1 external calls (assert!).


##### `executable_identity_uses_binary_contents`  (lines 20–27)

```
fn executable_identity_uses_binary_contents()
```

**Purpose**: Confirms that executable identity depends solely on byte contents. Equal bytes must hash identically and different bytes must not.

**Data flow**: Computes identities for `b"old"`, `b"old"`, and `b"new"` using `executable_identity_from_bytes`, then asserts equality for the first pair and inequality for the changed contents.

**Call relations**: This test validates the digest semantics relied on by updater comparison logic.

*Call graph*: 3 external calls (assert_eq!, assert_ne!, executable_identity_from_bytes).


### `app-server-daemon/src/update_loop_tests.rs`

`test` · `test`

This test module exercises only `update_modes_for_identities`, the pure decision function in the updater loop. Rather than constructing real executables, it uses `managed_install::executable_identity_from_bytes` to synthesize deterministic `ExecutableIdentity` values from byte strings. That keeps the tests fast and isolates them from filesystem and process concerns.

The first test covers the stable case where the running updater and managed binary identities are equal. In that scenario the updater loop should not force a restart every time; instead it should return `RestartMode::IfVersionChanged` and `UpdaterRefreshMode::None`, meaning the daemon restart logic can rely on version checks and the updater process does not need to re-exec itself.

The second test covers the changed-binary case. When the identities differ, the code must assume the managed binary may have changed even if version metadata is ambiguous or unchanged, so it expects `RestartMode::Always` together with `UpdaterRefreshMode::ReexecIfManagedBinaryChanged`. These assertions document the subtle design choice that executable identity, not just semantic version, drives updater replacement behavior.

#### Function details

##### `unchanged_updater_uses_version_based_restart`  (lines 9–17)

```
fn unchanged_updater_uses_version_based_restart()
```

**Purpose**: Checks that identical updater identities produce the non-forcing restart policy. It verifies the exact tuple returned for the unchanged-binary path.

**Data flow**: Builds two equal synthetic executable identities from the same byte slice, passes them to `update_modes_for_identities`, and compares the returned tuple against `(RestartMode::IfVersionChanged, UpdaterRefreshMode::None)`. It returns no value and mutates no state.

**Call relations**: This test directly exercises the pure helper used by `update_once`. It covers the branch where the running updater and managed binary compare equal.

*Call graph*: 1 external calls (assert_eq!).


##### `changed_updater_forces_refresh_even_when_version_may_match`  (lines 20–31)

```
fn changed_updater_forces_refresh_even_when_version_may_match()
```

**Purpose**: Checks that differing updater identities force both restart and updater refresh behavior. The test documents that identity mismatch overrides any weaker version-based heuristic.

**Data flow**: Builds two different synthetic executable identities from distinct byte slices, passes them to `update_modes_for_identities`, and asserts the result is `(RestartMode::Always, UpdaterRefreshMode::ReexecIfManagedBinaryChanged)`. It has no side effects beyond the assertion.

**Call relations**: This test covers the alternate branch of `update_modes_for_identities`, the one consumed by `update_once` when the managed binary differs from the currently running updater.

*Call graph*: 1 external calls (assert_eq!).


### Transport behavior tests
These files exercise the server and transport layers from local socket mechanics up through routing rules and remote-control APIs.

### `app-server-transport/src/transport/unix_socket_tests.rs`

`test` · `test execution for Unix control-socket transport`

This test module covers the Unix-domain control socket transport end to end. The first three unit tests verify `AppServerTransport::from_listen_url` parsing for the bare `unix://` form, absolute custom paths, and relative custom paths resolved against the current directory. The integration-style socket test starts a real control socket acceptor, connects with `UnixStream`, upgrades to websocket using `client_async`, and then verifies the full transport event lifecycle: `ConnectionOpened`, forwarding of a JSON-RPC text notification as `TransportEvent::IncomingMessage`, automatic pong replies to websocket ping frames, and `ConnectionClosed` after client close. It also confirms the socket path is removed after shutdown.

Additional tests validate startup serialization and filesystem hygiene. `app_server_startup_lock_serializes_waiters` acquires the startup lock once, spawns a second waiter, proves it blocks, then drops the first lock and confirms the second acquires successfully. On Unix, `control_socket_file_is_private_after_bind` checks that the bound socket file has mode `0o600`.

The helper functions are intentionally concrete: they compute default and temporary socket paths as `AbsolutePathBuf`, connect to the socket with `UnixStream::connect`, and on Unix assert that the socket path no longer exists after shutdown. Together these tests ensure the local control transport is secure, cleans up after itself, and reuses the websocket transport machinery correctly.

#### Function details

##### `listen_unix_socket_parses_as_unix_socket_transport`  (lines 26–33)

```
fn listen_unix_socket_parses_as_unix_socket_transport()
```

**Purpose**: Verifies that the bare `unix://` listen URL selects Unix-socket transport with the default control socket path.

**Data flow**: Calls `AppServerTransport::from_listen_url("unix://")`, computes the expected default path via `default_control_socket_path()`, and asserts the parsed transport equals `AppServerTransport::UnixSocket { socket_path: ... }`.

**Call relations**: This is a pure parsing test for transport configuration, independent of live socket behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `listen_unix_socket_accepts_absolute_custom_path`  (lines 36–43)

```
fn listen_unix_socket_accepts_absolute_custom_path()
```

**Purpose**: Verifies that an absolute Unix listen URL path is preserved exactly in the parsed transport configuration.

**Data flow**: Parses `"unix:///tmp/codex.sock"`, builds the expected `AbsolutePathBuf` with `absolute_path`, and asserts equality with the resulting `AppServerTransport::UnixSocket` value.

**Call relations**: Complements the default-path parsing test by covering explicit absolute paths.

*Call graph*: 1 external calls (assert_eq!).


##### `listen_unix_socket_accepts_relative_custom_path`  (lines 46–54)

```
fn listen_unix_socket_accepts_relative_custom_path()
```

**Purpose**: Verifies that a relative Unix listen URL path is accepted and resolved relative to the current directory.

**Data flow**: Parses `"unix://codex.sock"`, constructs the expected `AbsolutePathBuf::relative_to_current_dir("codex.sock")`, and asserts the parsed transport matches it.

**Call relations**: Complements the absolute-path parsing test by covering relative path handling.

*Call graph*: 1 external calls (assert_eq!).


##### `control_socket_acceptor_upgrades_and_forwards_websocket_text_messages_and_pings`  (lines 57–142)

```
async fn control_socket_acceptor_upgrades_and_forwards_websocket_text_messages_and_pings()
```

**Purpose**: Exercises the live control socket acceptor end to end: websocket upgrade, JSON-RPC forwarding, ping/pong handling, connection lifecycle events, and socket-file cleanup.

**Data flow**: Creates a temp socket path and transport event channel, starts `start_control_socket_acceptor`, connects with `connect_to_socket`, upgrades via `client_async`, waits for `TransportEvent::ConnectionOpened`, sends a JSON-RPC notification as websocket text and asserts the corresponding `IncomingMessage` event, sends a websocket ping and asserts a pong frame is returned, closes the websocket and asserts `ConnectionClosed`, then cancels shutdown, awaits the acceptor, and calls `assert_socket_path_removed`.

**Call relations**: This is the main integration test for `start_control_socket_acceptor` and the shared websocket transport path it delegates to.

*Call graph*: calls 3 internal fn (assert_socket_path_removed, connect_to_socket, test_socket_path); 14 external calls (from_static, new, from_secs, Ping, Text, Notification, assert!, assert_eq!, panic!, to_string (+4 more)).


##### `app_server_startup_lock_serializes_waiters`  (lines 145–164)

```
async fn app_server_startup_lock_serializes_waiters()
```

**Purpose**: Verifies that the startup lock blocks concurrent acquirers until the first holder releases it.

**Data flow**: Creates a temp lock path, acquires the first lock with `acquire_app_server_startup_lock`, spawns a second acquisition task, asserts that task does not complete within 100 ms, drops the first lock, then awaits the second task and asserts it succeeds.

**Call relations**: Directly tests the file-locking behavior of `acquire_app_server_startup_lock`.

*Call graph*: calls 1 internal fn (test_startup_lock_path); 4 external calls (assert!, acquire_app_server_startup_lock, new, spawn).


##### `control_socket_file_is_private_after_bind`  (lines 168–191)

```
async fn control_socket_file_is_private_after_bind()
```

**Purpose**: Checks that the bound control socket file has private permissions on Unix. This enforces local-only access expectations at the filesystem level.

**Data flow**: Creates a temp socket path, starts the control socket acceptor, reads metadata for the socket path with `tokio::fs::metadata`, masks the permission bits with `0o777`, and asserts the result is `0o600`; then it cancels shutdown and awaits the acceptor.

**Call relations**: Tests the effect of `set_control_socket_permissions`, which is invoked during acceptor startup.

*Call graph*: calls 1 internal fn (test_socket_path); 5 external calls (new, assert_eq!, start_control_socket_acceptor, new, metadata).


##### `absolute_path`  (lines 193–195)

```
fn absolute_path(path: &str) -> AbsolutePathBuf
```

**Purpose**: Converts a string absolute path into `AbsolutePathBuf` for test expectations.

**Data flow**: Calls `AbsolutePathBuf::from_absolute_path(path)` and unwraps the result with `expect`.

**Call relations**: Used by parsing tests to build expected transport values.

*Call graph*: calls 1 internal fn (from_absolute_path).


##### `default_control_socket_path`  (lines 197–200)

```
fn default_control_socket_path() -> AbsolutePathBuf
```

**Purpose**: Computes the default app-server control socket path under the current Codex home directory.

**Data flow**: Calls `find_codex_home()` to locate the home directory, then `app_server_control_socket_path(&codex_home)` to derive the socket path, unwrapping both results.

**Call relations**: Used by the bare `unix://` parsing test.

*Call graph*: calls 1 internal fn (find_codex_home); 1 external calls (app_server_control_socket_path).


##### `test_socket_path`  (lines 202–209)

```
fn test_socket_path(temp_dir: &Path) -> AbsolutePathBuf
```

**Purpose**: Builds a deterministic temporary control socket path under a provided temp directory.

**Data flow**: Joins `app-server-control/app-server-control.sock` onto `temp_dir`, converts the resulting absolute path into `AbsolutePathBuf`, and unwraps it.

**Call relations**: Used by live control-socket tests that need an isolated socket location.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 2 (control_socket_acceptor_upgrades_and_forwards_websocket_text_messages_and_pings, control_socket_file_is_private_after_bind); 1 external calls (join).


##### `test_startup_lock_path`  (lines 211–218)

```
fn test_startup_lock_path(temp_dir: &Path) -> AbsolutePathBuf
```

**Purpose**: Builds a deterministic temporary startup-lock path under a provided temp directory.

**Data flow**: Joins `app-server-control/app-server-startup.lock` onto `temp_dir`, converts it into `AbsolutePathBuf`, and unwraps it.

**Call relations**: Used by the startup-lock serialization test.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 1 (app_server_startup_lock_serializes_waiters); 1 external calls (join).


##### `connect_to_socket`  (lines 220–222)

```
async fn connect_to_socket(socket_path: &Path) -> IoResult<UnixStream>
```

**Purpose**: Connects a test client to the Unix control socket path.

**Data flow**: Calls `UnixStream::connect(socket_path).await` and returns the resulting `IoResult<UnixStream>`.

**Call relations**: Used by the end-to-end control socket acceptor test before websocket upgrade.

*Call graph*: calls 1 internal fn (connect); called by 1 (control_socket_acceptor_upgrades_and_forwards_websocket_text_messages_and_pings).


##### `assert_socket_path_removed`  (lines 230–233)

```
fn assert_socket_path_removed(_socket_path: &Path)
```

**Purpose**: Asserts that the Unix socket filesystem node has been removed after shutdown. On Windows the alternate definition is intentionally a no-op because the implementation differs.

**Data flow**: On Unix, checks `!socket_path.exists()` and asserts it; on Windows, ignores the argument and performs no filesystem assertion.

**Call relations**: Called by the end-to-end control socket test to verify `ControlSocketFileGuard` cleanup.

*Call graph*: called by 1 (control_socket_acceptor_upgrades_and_forwards_websocket_text_messages_and_pings); 1 external calls (assert!).


### `app-server/src/transport_tests.rs`

`test` · `test execution`

This test module validates the concrete policies implemented by `route_outgoing_envelope` and its helpers using real Tokio channels and `OutboundConnectionState` instances. Two small helpers reduce fixture noise: `absolute_path` builds `AbsolutePathBuf` values for request payloads, and `thread_realtime_started_notification` constructs an experimental `ServerNotification::ThreadRealtimeStarted` used to test capability gating.

The first group of tests covers notification suppression and delivery. They create one connection with a writer channel and vary the shared `RwLock<HashSet<String>>` of opted-out methods or the `experimental_api_enabled` atomic. The assertions check whether `writer_rx` receives nothing or the expected notification variant. This verifies both method-name opt-out filtering (`configWarning`) and dropping of experimental notifications for clients without the capability.

The next pair of tests targets request rewriting rather than dropping. They send `ServerRequest::CommandExecutionRequestApproval` messages containing `additional_permissions`, serialize the delivered message to JSON, and assert that `additionalPermissions` is absent without experimental capability and preserved with it.

The final tests probe backpressure behavior. `broadcast_does_not_block_on_slow_connection` pre-fills one disconnectable connection’s queue, then confirms a broadcast returns promptly, disconnects only the slow connection, and still delivers to the fast one. `to_connection_stdio_waits_instead_of_disconnecting_when_writer_queue_is_full` uses a non-disconnectable connection (`disconnect_sender: None`) to show that targeted sends await queue space instead of dropping the connection.

#### Function details

##### `absolute_path`  (lines 13–15)

```
fn absolute_path(path: &str) -> AbsolutePathBuf
```

**Purpose**: Builds an `AbsolutePathBuf` fixture from a string path for transport tests. It keeps request-payload setup concise.

**Data flow**: Accepts `&str`, calls `AbsolutePathBuf::from_absolute_path(path)`, unwraps with `expect("absolute path")`, and returns the resulting absolute path buffer. It has no side effects beyond panicking on invalid input.

**Call relations**: Used by the command-execution approval tests to populate `cwd` and allowed read paths. It isolates path parsing from the assertions those tests care about.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 2 (command_execution_request_approval_keeps_additional_permissions_with_capability, command_execution_request_approval_strips_additional_permissions_without_capability).


##### `thread_realtime_started_notification`  (lines 17–23)

```
fn thread_realtime_started_notification() -> ServerNotification
```

**Purpose**: Constructs a concrete experimental notification fixture used to test capability-based notification dropping/preservation. It standardizes the payload shape across tests.

**Data flow**: Returns `ServerNotification::ThreadRealtimeStarted(ThreadRealtimeStartedNotification { thread_id: "thread-1".to_string(), realtime_session_id: None, version: RealtimeConversationVersion::V1 })`. No inputs or mutable state are involved.

**Call relations**: Used by the experimental-notification tests as the message under test. It ensures both tests exercise the same notification variant and differ only in connection capability.

*Call graph*: called by 2 (experimental_notifications_are_dropped_without_capability, experimental_notifications_are_preserved_with_capability); 1 external calls (ThreadRealtimeStarted).


##### `to_connection_notification_respects_opt_out_filters`  (lines 26–66)

```
async fn to_connection_notification_respects_opt_out_filters()
```

**Purpose**: Verifies that a targeted notification is dropped when the connection has opted out of that notification method. It tests the direct-send path with an explicit opt-out set.

**Data flow**: Creates a connection with `initialized = true`, `experimental_api_enabled = true`, and `opted_out_notification_methods = {"configWarning"}`; inserts it into a connection map; routes a `ToConnection` envelope carrying `ServerNotification::ConfigWarning`; then asserts `writer_rx.try_recv()` fails, meaning nothing was enqueued.

**Call relations**: This test exercises `route_outgoing_envelope` → `send_message_to_connection` → `should_skip_notification_for_connection` on the targeted-send path. It confirms method-name opt-outs are honored before enqueueing.

*Call graph*: calls 1 internal fn (new); 9 external calls (new, new, new, from, new, ConfigWarning, AppServerNotification, assert!, channel).


##### `to_connection_notifications_are_dropped_for_opted_out_clients`  (lines 69–106)

```
async fn to_connection_notifications_are_dropped_for_opted_out_clients()
```

**Purpose**: Checks the same opt-out behavior as the previous test with a slightly different fixture setup. It reinforces that opted-out notifications never reach the client queue.

**Data flow**: Builds one initialized connection with `configWarning` in its opt-out set, routes a targeted `ConfigWarning` notification to it, and asserts the writer channel remains empty via `try_recv().is_err()`. No external state is touched.

**Call relations**: Like the previous test, it validates the targeted notification suppression path. It serves as another concrete regression test around opt-out filtering.

*Call graph*: calls 1 internal fn (new); 9 external calls (new, new, new, from, new, ConfigWarning, AppServerNotification, assert!, channel).


##### `to_connection_notifications_are_preserved_for_non_opted_out_clients`  (lines 109–152)

```
async fn to_connection_notifications_are_preserved_for_non_opted_out_clients()
```

**Purpose**: Verifies that a targeted notification is delivered when the connection has not opted out of that method. It tests the positive case for direct notification routing.

**Data flow**: Creates one initialized connection with an empty opt-out set, routes a targeted `ConfigWarning` notification, awaits one queued message from `writer_rx`, and pattern-matches that the delivered message is the expected `ConfigWarning` with summary `"task_started"`.

**Call relations**: This test covers the same routing path as the opt-out tests but confirms the message is preserved when suppression conditions are absent. It validates that filtering is selective rather than over-broad.

*Call graph*: calls 1 internal fn (new); 9 external calls (new, new, new, new, new, ConfigWarning, AppServerNotification, assert!, channel).


##### `experimental_notifications_are_dropped_without_capability`  (lines 155–185)

```
async fn experimental_notifications_are_dropped_without_capability()
```

**Purpose**: Verifies that experimental notifications are suppressed for connections that have not enabled the experimental API. It tests capability gating independent of opt-out settings.

**Data flow**: Creates one initialized connection with `experimental_api_enabled = false` and an empty opt-out set, routes a targeted `ThreadRealtimeStarted` notification from the helper, and asserts the writer channel remains empty via `try_recv().is_err()`.

**Call relations**: This test exercises the experimental branch inside `should_skip_notification_for_connection`. It confirms that capability gating applies even when the client has not explicitly opted out.

*Call graph*: calls 2 internal fn (new, thread_realtime_started_notification); 8 external calls (new, new, new, new, new, AppServerNotification, assert!, channel).


##### `experimental_notifications_are_preserved_with_capability`  (lines 188–222)

```
async fn experimental_notifications_are_preserved_with_capability()
```

**Purpose**: Verifies that experimental notifications are delivered when the connection has enabled the experimental API. It is the positive counterpart to the previous test.

**Data flow**: Creates one initialized connection with `experimental_api_enabled = true`, routes a targeted `ThreadRealtimeStarted` notification, awaits one queued message, and asserts it matches `OutgoingMessage::AppServerNotification(ServerNotification::ThreadRealtimeStarted(_))`.

**Call relations**: This test confirms that the capability gate in `should_skip_notification_for_connection` is conditional rather than unconditional. It pairs with the previous test to define the expected behavior boundary.

*Call graph*: calls 2 internal fn (new, thread_realtime_started_notification); 8 external calls (new, new, new, new, new, AppServerNotification, assert!, channel).


##### `command_execution_request_approval_strips_additional_permissions_without_capability`  (lines 225–287)

```
async fn command_execution_request_approval_strips_additional_permissions_without_capability()
```

**Purpose**: Verifies that command-execution approval requests are still delivered to non-experimental clients but with `additionalPermissions` stripped out. It tests request rewriting rather than dropping.

**Data flow**: Creates one initialized connection with `experimental_api_enabled = false`, routes a targeted `OutgoingMessage::Request(ServerRequest::CommandExecutionRequestApproval { ... additional_permissions: Some(...) ... })`, receives the queued message, serializes `message.message` to JSON, and asserts `json["params"].get("additionalPermissions") == None`.

**Call relations**: This test exercises `route_outgoing_envelope` → `send_message_to_connection` → `filter_outgoing_message_for_connection`. It documents the backward-compatibility policy for approval requests on older clients.

*Call graph*: calls 2 internal fn (new, absolute_path); 11 external calls (new, new, new, new, new, Integer, Request, assert_eq!, channel, to_value (+1 more)).


##### `command_execution_request_approval_keeps_additional_permissions_with_capability`  (lines 290–362)

```
async fn command_execution_request_approval_keeps_additional_permissions_with_capability()
```

**Purpose**: Verifies that command-execution approval requests preserve `additionalPermissions` for clients that support the experimental API. It is the positive counterpart to the stripping test.

**Data flow**: Creates one initialized connection with `experimental_api_enabled = true`, routes the same style of approval request containing `additional_permissions`, receives the queued message, serializes it to JSON, computes the expected allowed path string, and asserts `json["params"]["additionalPermissions"]` equals the expected nested JSON object.

**Call relations**: This test validates the no-rewrite branch of `filter_outgoing_message_for_connection`. Together with the previous test it defines the capability-sensitive serialization contract for approval requests.

*Call graph*: calls 2 internal fn (new, absolute_path); 11 external calls (new, new, new, new, new, Integer, Request, assert_eq!, channel, to_value (+1 more)).


##### `broadcast_does_not_block_on_slow_connection`  (lines 365–449)

```
async fn broadcast_does_not_block_on_slow_connection()
```

**Purpose**: Verifies that broadcasting to multiple disconnectable connections does not stall on a full queue: the slow connection is disconnected and removed while fast connections still receive the message. It tests the transport’s slow-client policy under fan-out.

**Data flow**: Creates fast and slow connections with queue capacity 1 and disconnect tokens, pre-fills the slow writer queue with an `already-buffered` message, inserts both into the connection map, then routes a broadcast `ConfigWarning` under a 100ms timeout. After completion it asserts the slow connection was removed from the map and its token cancelled, the fast token was not cancelled, the fast writer received the broadcast `test` message, and the slow writer still contains only its original buffered message.

**Call relations**: This test exercises the broadcast branch of `route_outgoing_envelope` and the `try_send`/disconnect path in `send_message_to_connection`. It confirms that one slow queue-backed client cannot block broadcast delivery to others.

*Call graph*: calls 2 internal fn (new, new); 12 external calls (new, new, new, from_millis, new, new, new, ConfigWarning, AppServerNotification, assert! (+2 more)).


##### `to_connection_stdio_waits_instead_of_disconnecting_when_writer_queue_is_full`  (lines 452–524)

```
async fn to_connection_stdio_waits_instead_of_disconnecting_when_writer_queue_is_full()
```

**Purpose**: Verifies that targeted sends to a non-disconnectable connection (stdio-like) wait for queue space instead of disconnecting when the writer channel is full. It tests the special backpressure behavior for stdio transports.

**Data flow**: Creates a capacity-1 writer channel, fills it with a first `queued` notification, inserts a connection with `disconnect_sender: None`, spawns a task that routes a second targeted notification, receives the first queued message to free space, waits for the routing task to finish within 100ms, then asserts the first message was `queued` and the second message is now present in the channel with summary `second`.

**Call relations**: This test exercises the non-disconnectable branch of `send_message_to_connection`, where `writer.send(...).await` is used instead of `try_send`. It documents the distinction between stdio backpressure and remote-connection disconnection.

*Call graph*: calls 2 internal fn (new, new); 12 external calls (new, new, from_millis, new, new, new, ConfigWarning, AppServerNotification, assert!, channel (+2 more)).


### `app-server-transport/src/transport/remote_control/tests/clients_tests.rs`

`test` · `test-only`

This test file isolates the management endpoints that operate independently of the websocket transport: listing remote-control clients for an environment and revoking a specific client. It builds lightweight `RemoteControlHandle` instances whose desired state is disabled and whose `state_db` is absent, specifically to prove that these APIs are gated only by policy, not by websocket enablement or enrollment state.

`client_management_handle` constructs that minimal handle with disabled status, empty current enrollment, and a supplied auth manager. The tests then stand up local HTTP listeners and inspect the exact request lines and headers generated by the production client-management code. The list test verifies URL encoding of environment id and cursor, bearer auth, account-id header, and response decoding into `RemoteControlClientsListResponse` with Unix timestamp conversion. The revoke test verifies the DELETE path and successful empty response handling.

The remaining tests focus on auth and error behavior in the lower-level `clients` module. One test simulates a stale access token followed by a fresh token after auth reload and confirms list retries once and succeeds. Another confirms that repeated 401s do not trigger unbounded retries. A revoke test ensures 403 Forbidden is surfaced immediately with request-id and cf-ray context preserved. The final test checks that malformed JSON responses keep HTTP status, body preview, and decode-error details in the returned error string.

#### Function details

##### `client_management_handle`  (lines 13–37)

```
fn client_management_handle(
    remote_control_url: String,
    auth_manager: Arc<AuthManager>,
) -> RemoteControlHandle
```

**Purpose**: Builds a minimal `RemoteControlHandle` suitable for testing client-management APIs while remote control is otherwise disabled.

**Data flow**: Creates a disabled desired-state watch sender and disabled status watch channel, initializes semaphores and empty current enrollment state, stores the supplied `remote_control_url` and `auth_manager`, and returns the assembled handle with policy `Allowed` and no state DB.

**Call relations**: Used by the handle-level list and revoke tests to prove those APIs work without active websocket transport.

*Call graph*: calls 1 internal fn (new); called by 2 (remote_control_handle_lists_clients_while_disabled, remote_control_handle_revokes_client_while_disabled); 3 external calls (new, new, channel).


##### `empty_client_list`  (lines 39–44)

```
fn empty_client_list() -> serde_json::Value
```

**Purpose**: Returns the JSON payload representing an empty paginated client list.

**Data flow**: Constructs and returns `{"items": [], "cursor": null}` as `serde_json::Value`.

**Call relations**: Used by the auth-recovery list test as the successful backend response body.

*Call graph*: called by 1 (list_remote_control_clients_recovers_auth_after_unauthorized); 1 external calls (json!).


##### `remote_control_handle_lists_clients_while_disabled`  (lines 47–116)

```
async fn remote_control_handle_lists_clients_while_disabled()
```

**Purpose**: Verifies that `RemoteControlHandle::list_clients` works even when desired state is disabled and checks the exact HTTP request shape.

**Data flow**: Starts a local listener and server task that captures one request, asserts the encoded GET path, authorization header, and account-id header, then responds with a JSON client list. The test builds a disabled handle, calls `list_clients(...)`, awaits the server task, and asserts the decoded response contains the expected `RemoteControlClient` fields and next cursor.

**Call relations**: Exercises the handle wrapper around the lower-level list API and confirms it is not blocked by disabled transport state.

*Call graph*: calls 1 internal fn (client_management_handle); 4 external calls (bind, assert_eq!, json!, spawn).


##### `remote_control_handle_revokes_client_while_disabled`  (lines 119–144)

```
async fn remote_control_handle_revokes_client_while_disabled()
```

**Purpose**: Verifies that `RemoteControlHandle::revoke_client` succeeds while remote control is disabled and uses the expected DELETE path.

**Data flow**: Starts a local listener and server task that captures one request, asserts the encoded DELETE request line, and responds `204 No Content`. The test builds a disabled handle, calls `revoke_client(...)`, waits for the server task, and asserts the empty success response.

**Call relations**: Companion handle-level test for the revoke management API.

*Call graph*: calls 1 internal fn (client_management_handle); 3 external calls (bind, assert_eq!, spawn).


##### `list_remote_control_clients_recovers_auth_after_unauthorized`  (lines 147–222)

```
async fn list_remote_control_clients_recovers_auth_after_unauthorized()
```

**Purpose**: Checks that the lower-level list API retries once after a 401 by reloading auth and using the fresh access token.

**Data flow**: Starts a local listener whose first request expects `Bearer stale-token` and returns 401, and whose second request expects `Bearer fresh-token` and returns an empty list. The test writes stale auth to disk, creates an `AuthManager`, overwrites auth on disk with fresh token, calls `list_remote_control_clients`, and asserts the final decoded response is empty.

**Call relations**: Exercises auth-recovery behavior in the client-list transport code.

*Call graph*: calls 4 internal fn (list_remote_control_clients, empty_client_list, default, shared); 5 external calls (default, bind, new, assert_eq!, spawn).


##### `list_remote_control_clients_retries_unauthorized_only_once`  (lines 225–300)

```
async fn list_remote_control_clients_retries_unauthorized_only_once()
```

**Purpose**: Ensures the list API does not retry indefinitely when both the original and recovered auth attempts receive 401 responses.

**Data flow**: Sets up a listener that returns 401 for both stale-token and fresh-token requests and then asserts no third request arrives. The test writes stale then fresh auth, calls `list_remote_control_clients`, expects an error, and asserts its kind is `PermissionDenied`.

**Call relations**: Locks in the single-retry policy for unauthorized client-list requests.

*Call graph*: calls 3 internal fn (list_remote_control_clients, default, shared); 6 external calls (default, bind, new, assert!, assert_eq!, spawn).


##### `revoke_remote_control_client_does_not_retry_forbidden`  (lines 303–338)

```
async fn revoke_remote_control_client_does_not_retry_forbidden()
```

**Purpose**: Verifies that a 403 revoke failure is surfaced immediately without auth retry and preserves backend correlation headers in the error message.

**Data flow**: Starts a listener that returns `403 Forbidden` with `x-request-id` and `cf-ray` headers, calls `revoke_remote_control_client`, expects an error, and asserts both the `PermissionDenied` kind and the fully formatted error string including URL, status, headers, and body.

**Call relations**: Covers non-retriable authorization failure handling for the revoke API.

*Call graph*: calls 1 internal fn (revoke_remote_control_client); 3 external calls (bind, assert_eq!, spawn).


##### `list_remote_control_clients_preserves_decode_error_context`  (lines 341–371)

```
async fn list_remote_control_clients_preserves_decode_error_context()
```

**Purpose**: Checks that malformed JSON in a successful client-list response still yields an error containing URL, HTTP status, body preview, and decode details.

**Data flow**: Starts a listener that returns `200 OK` with body `{`, calls `list_remote_control_clients`, expects an error, and asserts the error string contains the response URL prefix, `HTTP 200 OK`, the raw body preview, and a decode-error marker.

**Call relations**: Protects the diagnostic formatting of the client-list transport path.

*Call graph*: calls 1 internal fn (list_remote_control_clients); 4 external calls (default, bind, assert!, spawn).


### `app-server-transport/src/transport/remote_control/tests/pairing_tests.rs`

`test` · `test execution for remote-control pairing flows`

This test file builds realistic `RemoteControlEnrollment` values and then drives both low-level enrollment methods (`start_pairing`, `pairing_status`) and higher-level remote-control handle methods that may refresh server tokens, recover user auth, or re-enroll stale servers. Most tests stand up a temporary `TcpListener`, accept one or more raw HTTP requests, assert exact request lines, authorization headers, and JSON bodies, and then return crafted JSON or status responses to force specific branches.

The helpers `remote_control_enrollment`, `pairing_error`, `pairing_response_error`, and `pairing_status_error` reduce boilerplate for constructing enrollments and capturing formatted errors. The tests verify several subtle invariants: pairing can start before the websocket has connected if the current enrollment is nearly expired; pairing-status accepts either `pairing_code` or `manual_pairing_code`; 401 responses trigger server-token refresh; 404/410 stale-enrollment responses trigger re-enrollment and persistence updates; and responses are discarded if the authenticated account changes while a pairing request is in flight. Error assertions are intentionally concrete, checking inclusion of request IDs, Cloudflare ray IDs, raw response bodies, decode failures, and expiry parse failures so regressions in diagnostics are caught. The file also checks that disabling remote control does not clear the currently selected enrollment, preserving the chosen server for later reuse.

#### Function details

##### `remote_control_enrollment`  (lines 8–25)

```
fn remote_control_enrollment(
    remote_control_url: &str,
    remote_control_token: &str,
) -> RemoteControlEnrollment
```

**Purpose**: Constructs a canonical `RemoteControlEnrollment` fixture for tests from a base URL and server token. It normalizes the URL into a `RemoteControlTarget` and fills fixed account, environment, server, and expiry fields.

**Data flow**: Takes `remote_control_url` and `remote_control_token` strings, normalizes the URL, parses a fixed far-future Unix timestamp into `OffsetDateTime`, and returns a populated `RemoteControlEnrollment` with `remote_control_token: Some(...)` and stable IDs/names used by assertions.

**Call relations**: This helper is used by the error-focused helpers and direct pairing-status tests whenever they need a concrete enrollment object without going through the full handle setup path.

*Call graph*: called by 6 (pairing_error, pairing_response_error, pairing_status_error, remote_control_pairing_status_accepts_manual_pairing_code, remote_control_pairing_status_returns_claimed, remote_control_pairing_status_returns_pending); 1 external calls (from_unix_timestamp).


##### `pairing_error`  (lines 27–52)

```
async fn pairing_error(status: &'static str, body: &'static str) -> (String, String)
```

**Purpose**: Runs a one-request fake pairing server and captures the formatted error produced by `RemoteControlEnrollment::start_pairing`. It also returns the normalized pair URL expected to appear in the error text.

**Data flow**: Binds a local `TcpListener`, derives the remote-control URL and normalized `pair_url`, spawns a task that accepts one HTTP request and responds with the supplied status/body plus tracing headers, then invokes `start_pairing` with `manual_code: false`. It returns `(err.to_string(), expected_pair_url)` after awaiting the server task.

**Call relations**: Called by the backend-error and decode-error tests for pairing so those tests can focus on string assertions while this helper encapsulates listener setup and request/response orchestration.

*Call graph*: calls 1 internal fn (remote_control_enrollment); called by 2 (start_remote_control_pairing_preserves_backend_error_context, start_remote_control_pairing_preserves_decode_error_context); 2 external calls (bind, spawn).


##### `pairing_response_error`  (lines 54–70)

```
async fn pairing_response_error(body: serde_json::Value) -> String
```

**Purpose**: Runs a fake pairing endpoint that returns JSON and captures the resulting pairing error string. It is used for semantic response failures rather than HTTP status failures.

**Data flow**: Creates a local listener, spawns a server task that accepts one request and responds with the provided `serde_json::Value`, then calls `start_pairing` on a fixture enrollment and converts the expected error into a `String`.

**Call relations**: Used by the expiry-parse-error test and supports the mismatched-enrollment test pattern by centralizing the single-response JSON server behavior.

*Call graph*: calls 1 internal fn (remote_control_enrollment); called by 1 (start_remote_control_pairing_preserves_expiry_parse_error_context); 2 external calls (bind, spawn).


##### `pairing_status_error`  (lines 72–100)

```
async fn pairing_status_error(status: &'static str, body: &'static str) -> (io::Error, String)
```

**Purpose**: Runs a fake pairing-status endpoint and captures the `io::Error` returned by `RemoteControlEnrollment::pairing_status`, along with the normalized status URL. It supports assertions on both error kind and detailed formatting.

**Data flow**: Binds a listener, computes the normalized `pair_status_url`, spawns a task that serves one status/body response with request metadata headers, then calls `pairing_status` using a `pairing_code`. It returns the raw `io::Error` and expected URL after the server task completes.

**Call relations**: Shared by tests that verify user-actionable error-kind mapping and decode-error context preservation for pairing-status requests.

*Call graph*: calls 1 internal fn (remote_control_enrollment); called by 2 (remote_control_pairing_status_maps_user_actionable_backend_errors, remote_control_pairing_status_preserves_decode_error_context); 2 external calls (bind, spawn).


##### `remote_control_handle_starts_pairing_before_websocket_connects`  (lines 103–190)

```
async fn remote_control_handle_starts_pairing_before_websocket_connects()
```

**Purpose**: Verifies that a `RemoteControlHandle` can refresh an almost-expired server token and start pairing before any websocket connection has been established. It proves pairing is not blocked on websocket startup.

**Data flow**: Creates a listener whose server task expects first a refresh request and then a pair request, asserting exact paths, auth headers, and JSON payloads. The test mutates `current_enrollment.expires_at` to near-expiry, calls `remote_handle.start_pairing(...)`, and asserts the returned `RemoteControlPairingStartResponse` fields including parsed expiry epoch.

**Call relations**: This is a top-level integration-style test of the handle path, covering the control flow where `start_pairing` notices token expiry, refreshes the server token, and only then issues the pairing request.

*Call graph*: 6 external calls (now_utc, bind, assert_eq!, json!, seconds, spawn).


##### `remote_control_pairing_status_returns_pending`  (lines 193–226)

```
async fn remote_control_pairing_status_returns_pending()
```

**Purpose**: Checks that a successful pairing-status response with `claimed: false` is surfaced unchanged. It also verifies the request shape for code-based status polling.

**Data flow**: Starts a local server that asserts the POST path, bearer token, and JSON body `{ "pairing_code": "pairing-code" }`, then returns `{ "claimed": false }`. The test calls `pairing_status` and asserts the returned response has `claimed == false`.

**Call relations**: This directly exercises the low-level enrollment method without involving token refresh or handle orchestration, serving as the baseline success case.

*Call graph*: calls 1 internal fn (remote_control_enrollment); 5 external calls (bind, assert!, assert_eq!, json!, spawn).


##### `remote_control_pairing_status_accepts_manual_pairing_code`  (lines 229–258)

```
async fn remote_control_pairing_status_accepts_manual_pairing_code()
```

**Purpose**: Verifies that pairing-status requests can be keyed by `manual_pairing_code` instead of `pairing_code`. This guards the alternate request encoding path.

**Data flow**: Runs a fake server that asserts the request body contains only `{ "manual_pairing_code": "ABCD-EFGH" }`, returns `{ "claimed": false }`, and the test asserts the decoded response remains unclaimed.

**Call relations**: Like the previous status test, this targets the low-level enrollment API, but specifically the branch that serializes manual pairing codes.

*Call graph*: calls 1 internal fn (remote_control_enrollment); 5 external calls (bind, assert!, assert_eq!, json!, spawn).


##### `remote_control_pairing_status_returns_claimed`  (lines 261–285)

```
async fn remote_control_pairing_status_returns_claimed()
```

**Purpose**: Checks that a successful pairing-status response with `claimed: true` is propagated. It confirms the positive completion case for polling.

**Data flow**: Serves a single JSON response `{ "claimed": true }` to a status request, then asserts the returned response object has `claimed == true`.

**Call relations**: This complements the pending-status test by covering the alternate successful backend payload.

*Call graph*: calls 1 internal fn (remote_control_enrollment); 5 external calls (bind, assert!, assert_eq!, json!, spawn).


##### `remote_control_handle_refreshes_after_pairing_status_auth_failure`  (lines 288–348)

```
async fn remote_control_handle_refreshes_after_pairing_status_auth_failure()
```

**Purpose**: Ensures the higher-level handle retries pairing-status after a 401 by refreshing the remote-control server token. It validates stale-token recovery during polling.

**Data flow**: The fake server first receives a status request with the stale token and returns 401, then receives a refresh request and returns a refreshed token, then receives a second status request with the refreshed token and returns `{ "claimed": true }`. The test calls `remote_handle.pairing_status(...)` and asserts success.

**Call relations**: This test covers the handle-level retry path where a status poll detects server-token auth failure and delegates to refresh logic before replaying the original status request.

*Call graph*: 5 external calls (bind, assert!, assert_eq!, json!, spawn).


##### `remote_control_pairing_status_maps_user_actionable_backend_errors`  (lines 351–360)

```
async fn remote_control_pairing_status_maps_user_actionable_backend_errors()
```

**Purpose**: Checks that selected backend HTTP statuses are translated into actionable `io::ErrorKind` values rather than opaque generic failures. It codifies the user-facing mapping contract.

**Data flow**: Iterates over `(status, expected_kind)` pairs, invokes `pairing_status_error` for each, extracts the returned `io::Error`, and asserts `err.kind()` matches `PermissionDenied` for 403 and `InvalidInput` for 404/410.

**Call relations**: This is a compact table-driven test built on `pairing_status_error`, focusing only on the status-to-kind mapping branch.

*Call graph*: calls 1 internal fn (pairing_status_error); 1 external calls (assert_eq!).


##### `remote_control_pairing_status_preserves_decode_error_context`  (lines 363–374)

```
async fn remote_control_pairing_status_preserves_decode_error_context()
```

**Purpose**: Verifies that malformed JSON in a 200 pairing-status response produces an error string containing URL, HTTP status, tracing headers, body preview, and decode details. It protects diagnostic richness.

**Data flow**: Calls `pairing_status_error("200 OK", "{")`, converts the returned error to a string, and asserts that string contains the expected normalized URL and contextual fragments.

**Call relations**: Uses the shared helper to isolate assertions about formatting of decode failures rather than transport setup.

*Call graph*: calls 1 internal fn (pairing_status_error); 1 external calls (assert!).


##### `remote_control_handle_refreshes_after_pairing_auth_failure`  (lines 377–459)

```
async fn remote_control_handle_refreshes_after_pairing_auth_failure()
```

**Purpose**: Ensures `RemoteControlHandle::start_pairing` retries after a 401 pairing response by refreshing the server token first. It validates stale-token recovery for pairing initiation.

**Data flow**: The fake server expects a stale-token pair request returning 401, then a refresh request authorized with the user access token, then a second pair request authorized with the refreshed server token returning pairing JSON. The test invokes `start_pairing` and asserts the final `RemoteControlPairingStartResponse`.

**Call relations**: This is the pairing counterpart to the status-auth-failure test, covering the handle branch that refreshes server credentials and replays the pair request.

*Call graph*: 5 external calls (bind, default, assert_eq!, json!, spawn).


##### `remote_control_handle_recovers_auth_before_refreshing_pairing`  (lines 462–584)

```
async fn remote_control_handle_recovers_auth_before_refreshing_pairing()
```

**Purpose**: Verifies that if the user access token used for server refresh is itself stale, the handle reloads auth and retries refresh before pairing. It covers nested recovery: auth recovery before server-token refresh.

**Data flow**: Creates a temp auth home, saves stale auth, constructs an `AuthManager`, then overwrites auth with a fresh token. The fake server returns 401 to the first refresh request using `stale-token`, succeeds on the second refresh using `fresh-token`, then accepts the pairing request with the refreshed server token. The test also marks the current enrollment near expiry and asserts the final pairing response.

**Call relations**: This top-level test drives the deepest recovery chain in the pairing path: near-expiry enrollment triggers refresh, refresh gets 401, auth manager reloads, refresh retries, then pairing proceeds.

*Call graph*: calls 2 internal fn (default, shared); 8 external calls (now_utc, bind, new, default, assert_eq!, json!, seconds, spawn).


##### `start_remote_control_pairing_preserves_backend_error_context`  (lines 587–597)

```
async fn start_remote_control_pairing_preserves_backend_error_context()
```

**Purpose**: Checks exact formatting of non-200 pairing failures. It ensures backend status, request ID, ray ID, and body are preserved in the surfaced error.

**Data flow**: Invokes `pairing_error("503 Service Unavailable", "pairing unavailable")` and asserts the returned string exactly matches the expected formatted message including the normalized pair URL.

**Call relations**: This is a focused assertion layer over `pairing_error`, validating the final user-visible error text for backend failures.

*Call graph*: calls 1 internal fn (pairing_error); 1 external calls (assert_eq!).


##### `start_remote_control_pairing_preserves_decode_error_context`  (lines 600–609)

```
async fn start_remote_control_pairing_preserves_decode_error_context()
```

**Purpose**: Checks that malformed JSON in a 200 pairing response preserves detailed decode context. It guards against losing response metadata when deserialization fails.

**Data flow**: Calls `pairing_error("200 OK", "{")` and asserts the resulting string contains the pair URL, HTTP status, request metadata headers, raw body, and a decode-error marker.

**Call relations**: Built on the same helper as the backend-error test, but aimed at the parsing-failure branch after a nominally successful HTTP response.

*Call graph*: calls 1 internal fn (pairing_error); 1 external calls (assert!).


##### `start_remote_control_pairing_rejects_mismatched_backend_enrollment`  (lines 612–624)

```
async fn start_remote_control_pairing_rejects_mismatched_backend_enrollment()
```

**Purpose**: Verifies that pairing responses are rejected if the backend returns a different `server_id` or `environment_id` than the current enrollment. This prevents pairing against the wrong server/environment.

**Data flow**: Calls `pairing_response_error(...)` with JSON containing mismatched server/environment identifiers and asserts the returned error string exactly describes the expected and actual IDs.

**Call relations**: This test targets the semantic validation branch after successful response decoding, ensuring enrollment identity is enforced.

*Call graph*: 1 external calls (assert_eq!).


##### `start_remote_control_pairing_preserves_expiry_parse_error_context`  (lines 627–643)

```
async fn start_remote_control_pairing_preserves_expiry_parse_error_context()
```

**Purpose**: Checks that an invalid `expires_at` timestamp in an otherwise valid pairing response yields a detailed parse error message. It protects diagnostics for timestamp parsing failures.

**Data flow**: Uses `pairing_response_error` with JSON containing `expires_at: "not-a-timestamp"`, then asserts the error string includes generic parse context, HTTP 200, missing request metadata placeholders, the raw JSON body fragment, and an expiry parse marker.

**Call relations**: This complements the generic decode-error test by covering a later validation/parsing step after JSON deserialization succeeds.

*Call graph*: calls 1 internal fn (pairing_response_error); 2 external calls (assert!, json!).


##### `remote_control_handle_disable_keeps_current_enrollment`  (lines 646–659)

```
async fn remote_control_handle_disable_keeps_current_enrollment()
```

**Purpose**: Verifies that switching desired state to `Disabled` does not clear the in-memory current enrollment. The selected pairing server remains available for later re-enable or pairing operations.

**Data flow**: Creates a handle with an existing enrollment, sends `RemoteControlDesiredState::Disabled` through `desired_state_tx`, then locks `current_enrollment` and asserts it is still `Some(...)`.

**Call relations**: This is a state-retention regression test around desired-state transitions rather than HTTP behavior.

*Call graph*: 1 external calls (assert!).


##### `remote_control_handle_reenrolls_after_stale_pairing_enrollment`  (lines 662–787)

```
async fn remote_control_handle_reenrolls_after_stale_pairing_enrollment()
```

**Purpose**: Ensures a stale persisted enrollment that causes pairing to return 404 is replaced by a fresh enrollment, persisted, and then used for a successful pairing retry. It validates stale-enrollment recovery plus persistence preservation.

**Data flow**: Creates a temp state DB and handle, persists a stale enrollment with `remote_control_enabled: Some(true)`, enables desired state, and runs a fake server that returns 404 to the first pair request, then succeeds on `/enroll`, then succeeds on a second pair request using the refreshed server token and refreshed IDs. The test asserts the returned pairing response uses the refreshed environment and that the persisted enrollment still records `remote_control_enabled == Some(true)`.

**Call relations**: This top-level test covers the branch where pairing discovers the selected server no longer exists, triggers re-enrollment, updates persistence, and retries pairing with the new enrollment.

*Call graph*: 6 external calls (bind, new, default, assert_eq!, json!, spawn).


##### `remote_control_handle_discards_pairing_response_after_auth_change`  (lines 790–854)

```
async fn remote_control_handle_discards_pairing_response_after_auth_change()
```

**Purpose**: Verifies that an in-flight pairing response is discarded if the authenticated account changes before the response is processed. This prevents stale pairing codes from crossing account boundaries.

**Data flow**: Creates a temp auth home and `AuthManager`, starts `start_pairing` in a spawned task, accepts the outgoing pairing request, rewrites auth on disk to a different account, calls `auth_manager.reload()`, then responds with otherwise valid pairing JSON. The test awaits the pairing task and asserts it fails with the specific unavailable-until-enrollment-completes message.

**Call relations**: This test exercises a race-sensitive safety check in the handle path: auth changes during an outstanding request invalidate the response instead of accepting it.

*Call graph*: calls 2 internal fn (default, shared); 6 external calls (bind, new, default, assert_eq!, json!, spawn).


### Analytics capture helpers
These helper modules and focused tests define how plugin analytics captures are produced, read, and validated.

### `app-server-test-client/src/plugin_analytics_capture.rs`

`util` · `post-run analytics validation in plugin smoke tests`

This module works with analytics capture files written as JSON Lines, where each line contains a payload with an `events` array. `read_events_for_remote_plugin` is the ingestion step: it reads the capture file if present, treats a missing file as an empty event stream, parses each nonblank line as JSON, extracts the `events` array, and filters down to events whose `event_params.plugin_id` matches the requested remote plugin ID. The result is a flat `Vec<Value>` of matching event objects across all lines.

Validation is intentionally narrow. `PluginEventIdentity` carries the expected `plugin_id`, `plugin_name`, and `marketplace_name`. `validate_mutation_events` currently looks specifically for exactly one `codex_plugin_installed` event among the provided events; zero or multiple matches are treated as failures. It then delegates to `validate_event`, which checks the three identity fields with `require_string` and also enforces that several capability/metadata fields (`has_skills`, `mcp_server_count`, `connector_ids`, `product_client_id`) are present and non-null. The functions operate directly on `serde_json::Value` rather than typed structs, which keeps them resilient to partial payloads while still asserting the fields the smoke tests care about.

#### Function details

##### `read_events_for_remote_plugin`  (lines 9–43)

```
fn read_events_for_remote_plugin(
    path: &Path,
    remote_plugin_id: &str,
) -> Result<Vec<Value>>
```

**Purpose**: Reads a JSONL analytics capture file and returns only the events whose `event_params.plugin_id` matches the requested remote plugin.

**Data flow**: Takes a file path and remote plugin ID, reads the file to string, returns an empty vector if the file is missing, otherwise iterates nonblank lines with line numbers, parses each line as `serde_json::Value`, extracts its `events` array, filters events where `event["event_params"]["plugin_id"] == remote_plugin_id`, clones those matching event values, and accumulates them into a `Vec<Value>`.

**Call relations**: Plugin analytics smoke flows call this after capture to isolate the subset of events relevant to one remote plugin before applying stricter validation.

*Call graph*: called by 1 (wait_for_remote_plugin_event); 3 external calls (new, read_to_string, from_str).


##### `validate_mutation_events`  (lines 51–69)

```
fn validate_mutation_events(
    events: Vec<Value>,
    expected: PluginEventIdentity<'_>,
) -> Result<Vec<Value>>
```

**Purpose**: Asserts that the provided event list contains exactly one plugin-install mutation event for the expected plugin identity and returns that validated event.

**Data flow**: Consumes a vector of event JSON values plus expected identity fields, filters the events to those whose `event_type` is `codex_plugin_installed`, errors unless exactly one match remains, validates that event with `validate_event`, and returns a one-element vector containing a clone of the validated event.

**Call relations**: Higher-level plugin mutation smoke tests use this after `read_events_for_remote_plugin` to enforce the expected install-event cardinality and metadata.

*Call graph*: calls 1 internal fn (validate_event); 2 external calls (bail!, vec!).


##### `validate_event`  (lines 71–90)

```
fn validate_event(event: &Value, expected: &PluginEventIdentity<'_>) -> Result<()>
```

**Purpose**: Checks that one plugin analytics event has the expected identity fields and includes several required non-null capability metadata fields.

**Data flow**: Borrows an event JSON value and expected identity, reads `event["event_params"]`, verifies `plugin_id`, `plugin_name`, and `marketplace_name` via `require_string`, then iterates the required metadata field names and errors if any are missing or null. It returns unit on success.

**Call relations**: Called by `validate_mutation_events` once the candidate install event has been isolated.

*Call graph*: calls 1 internal fn (require_string); called by 1 (validate_mutation_events); 1 external calls (bail!).


##### `require_string`  (lines 92–98)

```
fn require_string(params: &Value, field: &str, expected: &str) -> Result<()>
```

**Purpose**: Validates that a named field inside an event-params object exists as a string and equals an expected value.

**Data flow**: Looks up `params[field]`, converts it to `Option<&str>`, compares it to `expected`, and returns an error if the value is absent or different; otherwise returns `Ok(())`.

**Call relations**: This is the low-level field assertion helper used by `validate_event` for the identity fields.

*Call graph*: called by 1 (validate_event); 2 external calls (get, bail!).


### `app-server-test-client/src/plugin_analytics_capture_tests.rs`

`test` · `unit test execution`

This test module exercises the small plugin analytics validation layer in isolation. The main success test, `reads_and_validates_remote_plugin_mutation_events`, creates a unique temp-file path, writes two JSONL payloads containing `events` arrays—one for an unrelated plugin and one for the target plugin—and then verifies that `read_events_for_remote_plugin` filters down to the target plugin’s event and that `validate_mutation_events` accepts it. The test also removes the temporary file afterward.

Two negative tests pin the validator’s stricter assumptions. `rejects_duplicate_mutation_events` passes two identical install events and asserts that validation fails with an error mentioning that two were found. `rejects_missing_capability_metadata` mutates the synthetic install event so `has_skills` is null and asserts that validation fails mentioning that field.

The helper constructors keep the tests concise and explicit. `mutation_event` builds a representative plugin analytics event with all required fields populated; `expected_identity` returns the matching `PluginEventIdentity`; and `unique_capture_path` creates a temp-file path using the current process ID and a nanosecond timestamp to avoid collisions across test runs.

#### Function details

##### `reads_and_validates_remote_plugin_mutation_events`  (lines 14–40)

```
fn reads_and_validates_remote_plugin_mutation_events()
```

**Purpose**: Verifies the end-to-end happy path of reading a JSONL capture file, filtering events by plugin ID, and validating the resulting install mutation event.

**Data flow**: Builds a unique temp path, constructs one target install event and one unrelated event, serializes two JSON payload lines containing those events, writes them to disk, reads matching events with `read_events_for_remote_plugin`, validates them with `validate_mutation_events`, asserts the validated output equals the original target event, and removes the temp file.

**Call relations**: This test covers both helper functions together, proving that filtering and validation compose correctly on realistic capture-file input.

*Call graph*: calls 3 internal fn (expected_identity, mutation_event, unique_capture_path); 6 external calls (assert_eq!, remove_file, write, json!, read_events_for_remote_plugin, validate_mutation_events).


##### `rejects_duplicate_mutation_events`  (lines 43–49)

```
fn rejects_duplicate_mutation_events()
```

**Purpose**: Ensures validation fails when more than one install mutation event is present for the same plugin.

**Data flow**: Constructs two identical install events, passes them to `validate_mutation_events`, captures the expected error, and asserts that the error text mentions `found 2`.

**Call relations**: This negative test targets the exact-one-event invariant enforced by `validate_mutation_events`.

*Call graph*: calls 2 internal fn (expected_identity, mutation_event); 3 external calls (assert!, validate_mutation_events, vec!).


##### `rejects_missing_capability_metadata`  (lines 52–59)

```
fn rejects_missing_capability_metadata()
```

**Purpose**: Ensures validation fails when a required capability metadata field is null or missing.

**Data flow**: Creates a synthetic install event, mutates `event_params.has_skills` to `Value::Null`, runs `validate_mutation_events`, captures the expected error, and asserts that the error mentions `has_skills`.

**Call relations**: This test exercises the required-field checks performed by `validate_event`.

*Call graph*: calls 2 internal fn (expected_identity, mutation_event); 3 external calls (assert!, validate_mutation_events, vec!).


##### `mutation_event`  (lines 61–74)

```
fn mutation_event(event_type: &str) -> Value
```

**Purpose**: Constructs a representative plugin analytics event JSON object with the standard identity and capability metadata fields populated.

**Data flow**: Accepts an `event_type` string and returns a `serde_json::Value` object containing that event type plus `event_params` with the fixed remote plugin ID, plugin name, marketplace name, and required metadata fields.

**Call relations**: All three tests use this helper to create baseline event payloads before optional mutation.

*Call graph*: called by 3 (reads_and_validates_remote_plugin_mutation_events, rejects_duplicate_mutation_events, rejects_missing_capability_metadata); 1 external calls (json!).


##### `expected_identity`  (lines 76–82)

```
fn expected_identity() -> PluginEventIdentity<'static>
```

**Purpose**: Returns the expected plugin identity tuple used by validation assertions in this test module.

**Data flow**: Constructs and returns a `PluginEventIdentity<'static>` with the fixed remote plugin ID, plugin name, and marketplace name constants used by the synthetic events.

**Call relations**: Each test passes this helper’s output into `validate_mutation_events` so the expected identity stays centralized.

*Call graph*: called by 3 (reads_and_validates_remote_plugin_mutation_events, rejects_duplicate_mutation_events, rejects_missing_capability_metadata).


##### `unique_capture_path`  (lines 84–93)

```
fn unique_capture_path(name: &str) -> PathBuf
```

**Purpose**: Builds a collision-resistant temporary JSONL file path for analytics capture tests.

**Data flow**: Reads the current system time since the Unix epoch in nanoseconds, gets the current process ID, formats both plus the supplied name into a filename, joins it under the system temp directory, and returns the resulting `PathBuf`.

**Call relations**: The happy-path file-reading test uses this to avoid temp-file name collisions across runs.

*Call graph*: called by 1 (reads_and_validates_remote_plugin_mutation_events); 3 external calls (now, format!, temp_dir).


### `app-server-test-client/src/loopback_responses_server.rs`

`io_transport` · `test harness startup and local HTTP request handling`

This file provides a self-contained fake Responses API endpoint. `LoopbackResponsesServer::start` binds an ephemeral localhost TCP listener, switches it to nonblocking mode, and spawns a background thread that repeatedly accepts connections until an `AtomicBool` shutdown flag is set. Accepted sockets are handled synchronously by `handle_model_connection`; transient `WouldBlock` errors simply sleep for 10 ms and retry, while other accept failures are logged and terminate the thread.

The request handler is intentionally minimal. It switches the accepted `TcpStream` back to blocking mode, applies a 2-second read timeout, reads the full HTTP request bytes with `read_http_request`, extracts the first request line, and checks for `POST ... /responses ...`. Matching requests receive a `200 OK` response with `Content-Type: text/event-stream` and a fixed SSE body containing `response.created` and `response.completed` events for a synthetic response ID. Any other path or method gets a JSON `404 Not Found` body.

`read_http_request` reads until `\r\n\r\n`, parses `Content-Length` from headers via `parse_content_length`, and then continues reading until the declared body length is satisfied or EOF occurs. `write_http_response` emits a complete HTTP/1.1 response with content length and closes the connection. Dropping the server flips the shutdown flag and joins the background thread.

#### Function details

##### `LoopbackResponsesServer::start`  (lines 22–54)

```
fn start() -> Result<Self>
```

**Purpose**: Starts the loopback HTTP server on an ephemeral localhost port and spawns the accept loop in a background thread.

**Data flow**: Binds `TcpListener` to `127.0.0.1:0`, enables nonblocking mode, captures the chosen local address, creates an `Arc<AtomicBool>` shutdown flag, clones it into the thread, and spawns a loop that accepts connections until shutdown is set. It returns `LoopbackResponsesServer` containing the formatted `base_url`, shutdown flag, and join handle.

**Call relations**: Other test harness code calls this to obtain a temporary fake Responses API endpoint; the spawned thread delegates each accepted socket to `handle_model_connection`.

*Call graph*: called by 1 (run); 6 external calls (clone, new, new, bind, format!, spawn).


##### `LoopbackResponsesServer::base_url`  (lines 56–58)

```
fn base_url(&self) -> &str
```

**Purpose**: Returns the server’s base HTTP URL string for clients to target.

**Data flow**: Borrows `self.base_url` and returns it as `&str` without allocation or mutation.

**Call relations**: Callers use this after `start` to configure clients against the loopback server.


##### `LoopbackResponsesServer::drop`  (lines 62–67)

```
fn drop(&mut self)
```

**Purpose**: Stops the background accept loop and waits for the server thread to exit.

**Data flow**: Sets the shared shutdown flag to `true` with relaxed ordering, takes the optional join handle, and joins the thread if present. It ignores join errors.

**Call relations**: This destructor runs automatically when the loopback server wrapper goes out of scope.


##### `handle_model_connection`  (lines 70–95)

```
fn handle_model_connection(mut stream: TcpStream) -> io::Result<()>
```

**Purpose**: Processes one accepted TCP connection, recognizes the `/responses` POST endpoint, and writes either a canned SSE success response or a 404 JSON error.

**Data flow**: Takes ownership of a `TcpStream`, switches it to blocking mode, sets a 2-second read timeout, reads the full request bytes with `read_http_request`, extracts the first request line, and checks whether it starts with `POST ` and contains `/responses `. On match it writes a `200 OK` text/event-stream response containing fixed `response.created` and `response.completed` events; otherwise it writes a `404 Not Found` JSON body.

**Call relations**: The background accept loop in `LoopbackResponsesServer::start` calls this for each accepted connection.

*Call graph*: calls 2 internal fn (read_http_request, write_http_response); 4 external calls (from_secs, set_nonblocking, set_read_timeout, concat!).


##### `read_http_request`  (lines 97–119)

```
fn read_http_request(stream: &mut TcpStream) -> io::Result<Vec<u8>>
```

**Purpose**: Reads an HTTP request from a TCP stream, including the body when a `Content-Length` header is present.

**Data flow**: Reads chunks into a temporary 4096-byte buffer, appending them to a `Vec<u8>` until it finds the header terminator `\r\n\r\n` or EOF. It then parses the content length from the header bytes with `parse_content_length` and continues reading until the accumulated request length reaches header end plus body length or the peer closes the stream. It returns the collected request bytes.

**Call relations**: Called by `handle_model_connection` before request-line inspection.

*Call graph*: calls 1 internal fn (parse_content_length); called by 1 (handle_model_connection); 2 external calls (read, new).


##### `parse_content_length`  (lines 121–131)

```
fn parse_content_length(headers: &[u8]) -> usize
```

**Purpose**: Extracts the numeric `Content-Length` header value from raw HTTP header bytes, defaulting to zero when absent or invalid.

**Data flow**: Decodes the header bytes lossily to UTF-8, iterates lines, splits each on the first `:`, performs a case-insensitive name check for `content-length`, trims and parses the value as `usize`, and returns the first successful parse or `0`.

**Call relations**: Used only by `read_http_request` to know how many body bytes to continue reading.

*Call graph*: called by 1 (read_http_request); 1 external calls (from_utf8_lossy).


##### `write_http_response`  (lines 133–145)

```
fn write_http_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &str,
) -> io::Result<()>
```

**Purpose**: Writes a complete HTTP/1.1 response with status line, content type, content length, connection-close header, and body.

**Data flow**: Formats the response headers and body directly into the stream with `write!`, using `body.len()` for `Content-Length`, then flushes the stream. It returns any I/O error from writing or flushing.

**Call relations**: `handle_model_connection` uses this helper for both the canned SSE success path and the 404 error path.

*Call graph*: called by 1 (handle_model_connection); 2 external calls (flush, write!).


### Test-client smoke workflows
This sequence introduces the reusable test-client harness and then applies it to non-destructive and destructive plugin analytics smoke scenarios.

### `app-server-test-client/src/lib.rs`

`orchestration` · `CLI dispatch, integration-test execution, request handling, and spawned-process cleanup`

This file is the operational core of the test client binary. At the top, Clap models a large command surface (`Cli`, `CliCommand`) covering basic messaging, v2 thread/turn flows, approval scenarios, login, model/thread listing, elicitation pause controls, and plugin analytics smoke tests. `run` parses CLI arguments, decodes optional dynamic tool specs from inline JSON or `@file`, validates incompatible flag combinations, resolves either a spawned-stdio endpoint or shared websocket endpoint, and dispatches to the appropriate scenario function.

Transport and protocol handling live in `CodexClient`. It abstracts either a child-process stdio connection or a tungstenite websocket, generates UUID request IDs, serializes `ClientRequest` values into JSON-RPC, injects W3C trace context into outgoing requests, and reads inbound `JSONRPCMessage`s. Responses are matched by request ID; notifications are queued; server-initiated approval requests are handled synchronously by auto-accepting file changes and conditionally accepting/canceling command approvals based on `CommandApprovalBehavior`.

Higher-level scenario helpers (`send_message_v2_with_policies`, `resume_message_v2`, `send_follow_up_v2`, `test_login`, `live_elicitation_timeout_pause`, etc.) all run inside `with_client`, which initializes OTEL tracing, opens a command span, connects a client, executes the scenario closure, and prints a trace summary. `stream_turn` is the main event loop for turn execution: it prints deltas, tracks command execution statuses and aggregated output, detects whether helper-script completion markers were seen, records unexpected items that start before helper completion, and captures final turn status/error. The file also includes process-management helpers (`BackgroundAppServer`, `serve`, graceful `Drop` implementations), shell quoting and port-killing utilities, and tracing bootstrap via `TestClientTracing`.

#### Function details

##### `run`  (lines 315–517)

```
async fn run() -> Result<()>
```

**Purpose**: Parses CLI arguments, validates cross-option constraints, resolves the target app-server endpoint, and dispatches to the selected integration scenario.

**Data flow**: Reads command-line state through `Cli::parse`, parses optional dynamic tool JSON into `Option<Vec<DynamicToolSpec>>`, then matches every `CliCommand` variant to build endpoint/config inputs and invoke the corresponding async or sync helper. It returns the selected command’s `Result<()>` and may reject invalid combinations such as unsupported dynamic tools or mutually exclusive endpoint flags.

**Call relations**: This is the top-level library entrypoint invoked by `main`. It orchestrates all other scenario helpers and plugin smoke modules based on the chosen subcommand.

*Call graph*: calls 26 internal fn (ensure_dynamic_tools_unused, get_account_rate_limits, live_elicitation_timeout_pause, model_list, no_trigger_cmd_approval, parse_dynamic_tools_arg, from_flag, run, run_cleanup, run (+15 more)); 2 external calls (parse, bail!).


##### `resolve_endpoint`  (lines 529–540)

```
fn resolve_endpoint(codex_bin: Option<PathBuf>, url: Option<String>) -> Result<Endpoint>
```

**Purpose**: Chooses whether the client should spawn a private stdio app-server or connect to an existing websocket server.

**Data flow**: Consumes optional `codex_bin` and `url` inputs, errors if both are present, otherwise returns `Endpoint::SpawnCodex`, `Endpoint::ConnectWs(url)`, or a default websocket endpoint at `ws://127.0.0.1:4222`. No external state is mutated.

**Call relations**: Most command branches in `run` call this before invoking a scenario helper that can operate over either transport.

*Call graph*: called by 1 (run); 3 external calls (ConnectWs, SpawnCodex, bail!).


##### `resolve_shared_websocket_url`  (lines 542–554)

```
fn resolve_shared_websocket_url(
    codex_bin: Option<PathBuf>,
    url: Option<String>,
    command: &str,
) -> Result<String>
```

**Purpose**: Enforces that certain commands operate only against a shared websocket server rather than a private spawned stdio server.

**Data flow**: Checks whether `codex_bin` was supplied and bails with a command-specific message if so; otherwise returns the provided URL or the default websocket URL string. It performs no network I/O itself.

**Call relations**: `run` uses this for elicitation increment/decrement commands that must target an already-running shared server.

*Call graph*: called by 1 (run); 1 external calls (bail!).


##### `BackgroundAppServer::spawn`  (lines 557–587)

```
fn spawn(codex_bin: &Path, config_overrides: &[String]) -> Result<Self>
```

**Purpose**: Starts `codex app-server` as a background websocket server on an ephemeral local port and records the resulting URL and child process.

**Data flow**: Binds a temporary `TcpListener` to `127.0.0.1:0` to reserve a free port, derives a websocket URL from the chosen address, builds a `Command` for the `codex` binary, prepends the binary’s parent directory to `PATH`, forwards config overrides as repeated `--config` args, and spawns `codex app-server --listen <url>` with null stdin/stdout and inherited stderr. It returns `BackgroundAppServer { process, url }`.

**Call relations**: The live elicitation timeout harness uses this when the caller supplies `--codex-bin` instead of an existing websocket URL.

*Call graph*: called by 1 (live_elicitation_timeout_pause); 8 external calls (from, parent, inherit, null, bind, new, format!, var_os).


##### `BackgroundAppServer::drop`  (lines 591–599)

```
fn drop(&mut self)
```

**Purpose**: Ensures a background app-server child process is terminated when the wrapper is dropped.

**Data flow**: Checks whether the child has already exited via `try_wait`; if so, it prints the exit status. Otherwise it sends `kill`, waits for process termination, and ignores cleanup errors.

**Call relations**: This destructor runs automatically after `live_elicitation_timeout_pause` or any other future owner drops the background server wrapper.

*Call graph*: 4 external calls (kill, try_wait, wait, println!).


##### `serve`  (lines 602–647)

```
fn serve(codex_bin: &Path, config_overrides: &[String], listen: &str, kill: bool) -> Result<()>
```

**Purpose**: Launches `codex app-server` detached under `nohup`, optionally killing any existing listener on the same port, and writes logs to a fixed temp directory.

**Data flow**: Creates `/tmp/codex-app-server-test-client`, optionally calls `kill_listeners_on_same_port`, opens/duplicates an append-only log file, constructs a shell command line with `RUST_BACKTRACE`, `RUST_LOG`, config overrides, and `app-server --listen`, then spawns `nohup sh -c <cmdline>` with stdout/stderr redirected to the log. It prints the listen URL, launcher PID, and log path.

**Call relations**: The `serve` subcommand in `run` delegates here to create a long-lived websocket app-server outside the current process.

*Call graph*: calls 1 internal fn (kill_listeners_on_same_port); called by 1 (run); 8 external calls (new, from, from, null, new, format!, create_dir_all, println!).


##### `kill_listeners_on_same_port`  (lines 649–708)

```
fn kill_listeners_on_same_port(listen: &str) -> Result<()>
```

**Purpose**: Best-effort kills any processes currently listening on the same TCP port as the requested websocket listen URL.

**Data flow**: Parses the listen URL, extracts its port, runs `lsof -tiTCP:<port> -sTCP:LISTEN`, parses stdout lines into PIDs, sends `kill` (SIGTERM) to each, sleeps briefly, reruns `lsof`, and sends `kill -9` to any remaining listeners. It returns success even when `lsof` reports no listeners.

**Call relations**: `serve` calls this only when the `--kill` flag is set, to clear port conflicts before launching a detached server.

*Call graph*: called by 1 (serve); 7 external calls (from_millis, from_utf8_lossy, parse, new, format!, println!, sleep).


##### `shell_quote`  (lines 710–712)

```
fn shell_quote(input: &str) -> String
```

**Purpose**: Produces a single-quoted shell-safe representation of a string for embedding in generated shell command lines.

**Data flow**: Takes an input string, replaces embedded single quotes with the standard shell escape sequence, wraps the result in outer single quotes, and returns the new `String`.

**Call relations**: Used when constructing shell command lines for detached server launch and the live elicitation helper command.

*Call graph*: 1 external calls (format!).


##### `send_message`  (lines 722–741)

```
async fn send_message(
    endpoint: &Endpoint,
    config_overrides: &[String],
    user_message: String,
) -> Result<()>
```

**Purpose**: Implements the legacy/simple send-message flow by forwarding to the v2 turn path with default non-experimental, no-approval policies.

**Data flow**: Receives endpoint, config overrides, and a user message, constructs a `SendMessagePolicies` value with no approval or sandbox overrides and no dynamic tools, and awaits `send_message_v2_with_policies`. It returns that result.

**Call relations**: The `SendMessage` CLI branch uses this as a compatibility wrapper over the shared v2 messaging machinery.

*Call graph*: calls 1 internal fn (send_message_v2_with_policies); called by 1 (run).


##### `send_message_v2`  (lines 743–758)

```
async fn send_message_v2(
    codex_bin: &Path,
    config_overrides: &[String],
    user_message: String,
    dynamic_tools: &Option<Vec<DynamicToolSpec>>,
) -> Result<()>
```

**Purpose**: Convenience API for library callers that want to send a v2 message by spawning a specific `codex` binary over stdio.

**Data flow**: Wraps the provided binary path in `Endpoint::SpawnCodex`, forwards config overrides, message text, and dynamic tools to `send_message_v2_endpoint` with `experimental_api` forced to `true`, and returns the async result.

**Call relations**: This is a library-facing helper layered on top of the more general endpoint-based send path.

*Call graph*: calls 1 internal fn (send_message_v2_endpoint); 2 external calls (to_path_buf, SpawnCodex).


##### `send_message_v2_endpoint`  (lines 760–784)

```
async fn send_message_v2_endpoint(
    endpoint: &Endpoint,
    config_overrides: &[String],
    user_message: String,
    experimental_api: bool,
    dynamic_tools: &Option<Vec<DynamicToolSpec>>,
) -
```

**Purpose**: Starts a v2 message turn against an arbitrary endpoint, enforcing that dynamic tools require experimental API support.

**Data flow**: Checks whether `dynamic_tools` is present while `experimental_api` is false and bails if so. Otherwise it builds `SendMessagePolicies` for the `send-message-v2` command and forwards everything to `send_message_v2_with_policies`.

**Call relations**: Called from both the CLI dispatcher and the binary-path convenience wrapper; it centralizes the dynamic-tools gating rule.

*Call graph*: calls 1 internal fn (send_message_v2_with_policies); called by 2 (run, send_message_v2); 1 external calls (bail!).


##### `trigger_zsh_fork_multi_cmd_approval`  (lines 786–890)

```
async fn trigger_zsh_fork_multi_cmd_approval(
    endpoint: &Endpoint,
    config_overrides: &[String],
    user_message: Option<String>,
    min_approvals: usize,
    abort_on: Option<usize>,
    dyn
```

**Purpose**: Runs a specialized approval scenario that expects multiple command-approval callbacks for one shell command item and optionally cancels a chosen approval index.

**Data flow**: Validates `abort_on >= 1` when present, chooses a default prompt if none was supplied, then uses `with_client` to initialize a client, start a thread, configure command approval behavior and tracking fields, start a turn with `AskForApproval::OnRequest` and read-only sandboxing, stream the turn, and finally assert approval-count and completion-status expectations. It returns an error if the observed approvals or statuses do not match the requested scenario.

**Call relations**: This command-specific harness is invoked from `run` and relies on `CodexClient::stream_turn` plus approval-request handling to observe repeated approval callbacks.

*Call graph*: calls 1 internal fn (with_client); called by 1 (run); 1 external calls (bail!).


##### `resume_message_v2`  (lines 892–927)

```
async fn resume_message_v2(
    endpoint: &Endpoint,
    config_overrides: &[String],
    thread_id: String,
    user_message: String,
    dynamic_tools: &Option<Vec<DynamicToolSpec>>,
) -> Result<()>
```

**Purpose**: Resumes an existing thread by ID and sends a new v2 user message into it.

**Data flow**: Rejects dynamic tools for this command, then inside `with_client` initializes the server, sends `thread/resume`, constructs a `TurnStartParams` with one text input, starts the turn, and streams notifications until that turn completes. It returns success when the resumed turn finishes without transport/protocol errors.

**Call relations**: The `ResumeMessageV2` CLI branch dispatches here; it composes `thread_resume`, `turn_start`, and `stream_turn` into one flow.

*Call graph*: calls 2 internal fn (ensure_dynamic_tools_unused, with_client); called by 1 (run).


##### `thread_resume_follow`  (lines 929–948)

```
async fn thread_resume_follow(
    endpoint: &Endpoint,
    config_overrides: &[String],
    thread_id: String,
) -> Result<()>
```

**Purpose**: Resumes an existing thread and then continuously prints inbound notifications without auto-exiting.

**Data flow**: Within `with_client`, it initializes the connection, sends `thread/resume`, prints the response, and enters `stream_notifications_forever`, which loops until interrupted or an error occurs. It returns only on failure or process termination.

**Call relations**: Used by the `ThreadResume` CLI command as a long-running watcher for an existing thread.

*Call graph*: calls 1 internal fn (with_client); called by 1 (run).


##### `watch`  (lines 950–959)

```
async fn watch(endpoint: &Endpoint, config_overrides: &[String]) -> Result<()>
```

**Purpose**: Initializes the app-server connection and then continuously dumps inbound notifications/events.

**Data flow**: Uses `with_client` to initialize the server, print the handshake response, and call `stream_notifications_forever`. It does not send any thread or turn requests.

**Call relations**: This powers the `Watch` CLI command and is the simplest long-lived observation mode in the file.

*Call graph*: calls 1 internal fn (with_client); called by 1 (run).


##### `trigger_cmd_approval`  (lines 961–985)

```
async fn trigger_cmd_approval(
    endpoint: &Endpoint,
    config_overrides: &[String],
    user_message: Option<String>,
    dynamic_tools: &Option<Vec<DynamicToolSpec>>,
) -> Result<()>
```

**Purpose**: Starts a turn designed to elicit a command-execution approval request under read-only sandboxing.

**Data flow**: Chooses a default prompt that asks the model to run `touch /tmp/should-trigger-approval`, then forwards the message and policies (`experimental_api = true`, `approval_policy = OnRequest`, read-only sandbox) to `send_message_v2_with_policies`. It returns that scenario’s result.

**Call relations**: The `trigger-cmd-approval` CLI branch uses this thin wrapper over the shared send-with-policies flow.

*Call graph*: calls 1 internal fn (send_message_v2_with_policies); called by 1 (run).


##### `trigger_patch_approval`  (lines 987–1011)

```
async fn trigger_patch_approval(
    endpoint: &Endpoint,
    config_overrides: &[String],
    user_message: Option<String>,
    dynamic_tools: &Option<Vec<DynamicToolSpec>>,
) -> Result<()>
```

**Purpose**: Starts a turn designed to elicit a file-change/apply-patch approval request under read-only sandboxing.

**Data flow**: Uses a default prompt requesting file creation via `apply_patch`, then calls `send_message_v2_with_policies` with experimental API enabled, on-request approvals, and read-only sandboxing. It returns the delegated result.

**Call relations**: This is the patch-approval counterpart to `trigger_cmd_approval`, selected by its own CLI subcommand.

*Call graph*: calls 1 internal fn (send_message_v2_with_policies); called by 1 (run).


##### `no_trigger_cmd_approval`  (lines 1013–1032)

```
async fn no_trigger_cmd_approval(
    endpoint: &Endpoint,
    config_overrides: &[String],
    dynamic_tools: &Option<Vec<DynamicToolSpec>>,
) -> Result<()>
```

**Purpose**: Runs a control scenario that should not trigger command approval because no approval or sandbox overrides are requested.

**Data flow**: Builds a fixed prompt and forwards it to `send_message_v2_with_policies` with experimental API enabled but no approval or sandbox policy overrides. It returns the delegated result.

**Call relations**: Invoked by the `no-trigger-cmd-approval` CLI branch to contrast with the explicit approval-triggering scenarios.

*Call graph*: calls 1 internal fn (send_message_v2_with_policies); called by 1 (run).


##### `send_message_v2_with_policies`  (lines 1034–1075)

```
async fn send_message_v2_with_policies(
    endpoint: &Endpoint,
    config_overrides: &[String],
    user_message: String,
    policies: SendMessagePolicies<'_>,
) -> Result<()>
```

**Purpose**: Shared implementation for starting a new thread, sending one text turn, and streaming it to completion under configurable initialization and policy settings.

**Data flow**: Runs inside `with_client`: initializes with or without experimental API, starts a thread optionally carrying dynamic tools, constructs `TurnStartParams` with one plain-text `V2UserInput::Text`, applies optional approval and sandbox overrides, sends `turn/start`, and streams the turn until completion. It returns success if the whole request/notification sequence completes cleanly.

**Call relations**: This is the central helper behind `send_message`, `send_message_v2_endpoint`, and the approval-triggering wrappers.

*Call graph*: calls 1 internal fn (with_client); called by 5 (no_trigger_cmd_approval, send_message, send_message_v2_endpoint, trigger_cmd_approval, trigger_patch_approval).


##### `send_follow_up_v2`  (lines 1077–1125)

```
async fn send_follow_up_v2(
    endpoint: &Endpoint,
    config_overrides: &[String],
    first_message: String,
    follow_up_message: String,
    dynamic_tools: &Option<Vec<DynamicToolSpec>>,
) -> R
```

**Purpose**: Exercises two sequential turns in the same thread to validate follow-up behavior.

**Data flow**: Within `with_client`, it initializes, starts a thread, sends a first text turn and streams it to completion, then sends a second text turn on the same thread and streams that one as well. It returns success only if both turns complete without protocol errors.

**Call relations**: The `SendFollowUpV2` CLI branch uses this to test multi-turn continuity within one thread.

*Call graph*: calls 1 internal fn (with_client); called by 1 (run).


##### `test_login`  (lines 1127–1177)

```
async fn test_login(
    endpoint: &Endpoint,
    config_overrides: &[String],
    device_code: bool,
) -> Result<()>
```

**Purpose**: Starts either the browser-callback or device-code ChatGPT login flow and waits for the matching completion notification.

**Data flow**: Inside `with_client`, it initializes, sends the appropriate `account/login/start` request, prints the returned auth URL or verification code, extracts the `login_id`, waits in `wait_for_account_login_completion` until a matching `AccountLoginCompletedNotification` arrives, and then returns success or an error based on `completion.success` and `completion.error`.

**Call relations**: Selected by the `TestLogin` CLI command; it combines request/notification handling with user-facing instructions for completing the login flow.

*Call graph*: calls 1 internal fn (with_client); called by 1 (run).


##### `get_account_rate_limits`  (lines 1179–1195)

```
async fn get_account_rate_limits(endpoint: &Endpoint, config_overrides: &[String]) -> Result<()>
```

**Purpose**: Fetches and prints the current account rate-limit snapshot from the app-server.

**Data flow**: Uses `with_client` to initialize the connection, send `account/rateLimits/read`, print the typed response, and return success. No additional state is tracked.

**Call relations**: This is the implementation behind the `GetAccountRateLimits` CLI command.

*Call graph*: calls 1 internal fn (with_client); called by 1 (run).


##### `model_list`  (lines 1197–1208)

```
async fn model_list(endpoint: &Endpoint, config_overrides: &[String]) -> Result<()>
```

**Purpose**: Requests and prints the available model list from the app-server.

**Data flow**: Within `with_client`, it initializes, sends `model/list` with default params, prints the typed response, and returns success.

**Call relations**: Invoked by the `model-list` CLI branch.

*Call graph*: calls 1 internal fn (with_client); called by 1 (run).


##### `thread_list`  (lines 1210–1233)

```
async fn thread_list(endpoint: &Endpoint, config_overrides: &[String], limit: u32) -> Result<()>
```

**Purpose**: Requests and prints a page of stored threads using the supplied limit and otherwise default filters.

**Data flow**: Inside `with_client`, it initializes, constructs `ThreadListParams` with `limit: Some(limit)` and all other filters unset/defaulted, sends `thread/list`, prints the response, and returns success.

**Call relations**: This powers the `thread-list` CLI command.

*Call graph*: calls 1 internal fn (with_client); called by 1 (run).


##### `with_client`  (lines 1235–1255)

```
async fn with_client(
    command_name: &'static str,
    endpoint: &Endpoint,
    config_overrides: &[String],
    f: impl FnOnce(&mut CodexClient) -> Result<T>,
) -> Result<T>
```

**Purpose**: Wraps a scenario closure with tracing initialization, a command-level span, client connection setup, and final trace-summary printing.

**Data flow**: Asynchronously initializes `TestClientTracing` from config overrides, creates a tracing span tagged as a client command, captures a `TraceSummary` inside that span, then in the same span connects a `CodexClient` and invokes the supplied closure. After the closure returns, it prints the trace summary and returns the closure’s `Result<T>`.

**Call relations**: Nearly every scenario helper delegates through this function so they all share consistent tracing, connection setup, and teardown behavior.

*Call graph*: calls 2 internal fn (initialize, print_trace_summary); called by 10 (get_account_rate_limits, model_list, resume_message_v2, send_follow_up_v2, send_message_v2_with_policies, test_login, thread_list, thread_resume_follow, trigger_zsh_fork_multi_cmd_approval, watch); 1 external calls (info_span!).


##### `thread_increment_elicitation`  (lines 1257–1269)

```
fn thread_increment_elicitation(url: &str, thread_id: String) -> Result<()>
```

**Purpose**: Connects to a shared websocket app-server and increments the out-of-band elicitation pause counter for a thread.

**Data flow**: Wraps the URL in `Endpoint::ConnectWs`, connects a `CodexClient`, initializes the server, sends `thread/increment_elicitation` with the provided thread ID, prints the response, and returns success.

**Call relations**: The corresponding CLI branch in `run` uses this direct helper instead of `with_client` because it always targets a shared websocket endpoint.

*Call graph*: calls 1 internal fn (connect); called by 1 (run); 2 external calls (ConnectWs, println!).


##### `thread_decrement_elicitation`  (lines 1271–1283)

```
fn thread_decrement_elicitation(url: &str, thread_id: String) -> Result<()>
```

**Purpose**: Connects to a shared websocket app-server and decrements the out-of-band elicitation pause counter for a thread.

**Data flow**: Creates a websocket endpoint, connects a client, initializes, sends `thread/decrement_elicitation`, prints the response, and returns success.

**Call relations**: This is the decrement counterpart to `thread_increment_elicitation`, selected by its own CLI branch.

*Call graph*: calls 1 internal fn (connect); called by 1 (run); 2 external calls (ConnectWs, println!).


##### `live_elicitation_timeout_pause`  (lines 1285–1440)

```
fn live_elicitation_timeout_pause(
    codex_bin: Option<PathBuf>,
    url: Option<String>,
    config_overrides: &[String],
    model: String,
    workspace: PathBuf,
    script: Option<PathBuf>,
```

**Purpose**: Runs a live end-to-end harness proving that elicitation pause prevents the unified exec timeout from killing a helper script that intentionally runs longer than 10 seconds.

**Data flow**: Validates platform and `hold_seconds`, optionally spawns a background websocket app-server, resolves the helper script path and canonical workspace, connects a client, initializes, starts a thread with the requested model, constructs an exact shell command embedding the websocket URL, test-client binary path, and hold duration, then starts a turn that instructs the model to run that command exactly once with full access and high reasoning effort. After `stream_turn`, it validates elapsed time, command completion, helper output markers, absence of unexpected items before helper completion, and final turn status; it then best-effort decrements elicitation for cleanup and prints a summary.

**Call relations**: This specialized harness is dispatched from `run` and depends heavily on `BackgroundAppServer`, `CodexClient::stream_turn`, and the command-output tracking fields maintained by the client.

*Call graph*: calls 2 internal fn (spawn, connect); called by 1 (run); 11 external calls (default, now, canonicalize, ConnectWs, bail!, cfg!, eprintln!, format!, println!, current_exe (+1 more)).


##### `ensure_dynamic_tools_unused`  (lines 1442–1452)

```
fn ensure_dynamic_tools_unused(
    dynamic_tools: &Option<Vec<DynamicToolSpec>>,
    command: &str,
) -> Result<()>
```

**Purpose**: Rejects commands that were invoked with `--dynamic-tools` even though they do not support dynamic tools.

**Data flow**: Checks whether the `Option<Vec<DynamicToolSpec>>` is `Some`; if so, returns an error naming the command and suggesting supported usage, otherwise returns `Ok(())`.

**Call relations**: Many CLI branches call this early from `run`, and `resume_message_v2` also uses it directly.

*Call graph*: called by 2 (resume_message_v2, run); 1 external calls (bail!).


##### `parse_dynamic_tools_arg`  (lines 1454–1475)

```
fn parse_dynamic_tools_arg(dynamic_tools: &Option<String>) -> Result<Option<Vec<DynamicToolSpec>>>
```

**Purpose**: Parses the `--dynamic-tools` CLI argument from inline JSON or an `@file` reference into normalized dynamic tool specs.

**Data flow**: If the option is absent, returns `Ok(None)`. Otherwise it reads raw JSON either from the argument string or from a file path after `@`, parses it into `serde_json::Value`, accepts either a single object or an array of objects, rejects other JSON shapes, normalizes the values through `normalize_dynamic_tool_specs`, and returns `Some(Vec<DynamicToolSpec>)`.

**Call relations**: `run` calls this once up front so all command branches receive a pre-decoded dynamic-tools value.

*Call graph*: calls 1 internal fn (normalize_dynamic_tool_specs); called by 1 (run); 5 external calls (new, bail!, read_to_string, from_str, vec!).


##### `item_started_before_helper_done_is_unexpected`  (lines 1512–1522)

```
fn item_started_before_helper_done_is_unexpected(
    item: &ThreadItem,
    command_item_started: bool,
    helper_done_seen: bool,
) -> bool
```

**Purpose**: Encodes the harness rule for whether an `ItemStarted` notification should be considered premature while the helper command is still running.

**Data flow**: Reads the current `ThreadItem` plus booleans indicating whether the command item has started and whether helper completion has been seen. It returns `false` unless a command item is already running and the helper is not done; in that window it treats every item except `ThreadItem::UserMessage` as unexpected.

**Call relations**: `CodexClient::stream_turn` calls this when tracking `unexpected_items_before_helper_done` during the live elicitation timeout harness.

*Call graph*: called by 1 (stream_turn); 1 external calls (matches!).


##### `CodexClient::connect`  (lines 1525–1530)

```
fn connect(endpoint: &Endpoint, config_overrides: &[String]) -> Result<Self>
```

**Purpose**: Constructs a `CodexClient` over either stdio or websocket transport based on the resolved endpoint.

**Data flow**: Matches the `Endpoint`: `SpawnCodex` delegates to `spawn_stdio`, while `ConnectWs` delegates to `connect_websocket`. It returns the initialized client with transport-specific state and tracking fields set up.

**Call relations**: Scenario helpers and direct elicitation commands use this as the common connection factory.

*Call graph*: called by 3 (live_elicitation_timeout_pause, thread_decrement_elicitation, thread_increment_elicitation); 2 external calls (connect_websocket, spawn_stdio).


##### `CodexClient::spawn_stdio`  (lines 1532–1534)

```
fn spawn_stdio(codex_bin: &Path, config_overrides: &[String]) -> Result<Self>
```

**Purpose**: Starts a stdio-connected `codex app-server` child process with no extra environment overrides.

**Data flow**: Forwards the binary path and config overrides to `spawn_stdio_with_env` with an empty environment slice and returns the resulting client.

**Call relations**: This is the normal stdio path used by `CodexClient::connect`; other modules can call it when they need a spawned private server.

*Call graph*: called by 1 (run_cleanup); 1 external calls (spawn_stdio_with_env).


##### `CodexClient::spawn_stdio_with_env`  (lines 1536–1594)

```
fn spawn_stdio_with_env(
        codex_bin: &Path,
        config_overrides: &[String],
        environment: &[(OsString, OsString)],
    ) -> Result<Self>
```

**Purpose**: Starts `codex app-server` as a child process over piped stdin/stdout, optionally injecting extra environment variables, and initializes all client-side tracking state.

**Data flow**: Builds a `Command` for the binary, prepends its parent directory to `PATH`, appends config overrides and extra environment pairs, spawns `codex app-server` with piped stdin/stdout and inherited stderr, extracts the child pipes, wraps stdout in `BufReader`, and returns a `CodexClient` with `ClientTransport::Stdio` plus empty notification queues and zeroed approval/turn-tracking fields.

**Call relations**: This is the concrete stdio transport constructor used by `spawn_stdio` and by external helpers that need custom environment injection.

*Call graph*: called by 2 (spawn_client, run); 11 external calls (new, from, display, parent, inherit, piped, new, new, new, new (+1 more)).


##### `CodexClient::connect_websocket`  (lines 1596–1633)

```
fn connect_websocket(url: &str) -> Result<Self>
```

**Purpose**: Connects to an existing websocket app-server, retrying for up to 10 seconds before failing with a helpful startup hint.

**Data flow**: Parses the URL, computes a deadline, repeatedly calls tungstenite `connect(parsed.as_str())`, sleeping 50 ms between failures until success or timeout, then returns a `CodexClient` with `ClientTransport::WebSocket` and freshly initialized tracking fields.

**Call relations**: This is the websocket transport constructor used by `CodexClient::connect` and direct websocket-only commands.

*Call graph*: 10 external calls (new, from_millis, from_secs, now, new, parse, new, new, sleep, connect).


##### `CodexClient::note_helper_output`  (lines 1635–1643)

```
fn note_helper_output(&mut self, output: &str)
```

**Purpose**: Accumulates command output text and marks the helper as finished once the special completion marker appears.

**Data flow**: Appends the provided output chunk to `self.command_output_stream`; if the accumulated stream contains `[elicitation-hold] done`, it sets `self.helper_done_seen = true`. It returns unit.

**Call relations**: `stream_turn` calls this for command output deltas and aggregated command output so the live elicitation harness can detect helper completion robustly.

*Call graph*: called by 1 (stream_turn).


##### `CodexClient::initialize`  (lines 1645–1647)

```
fn initialize(&mut self) -> Result<InitializeResponse>
```

**Purpose**: Performs the standard initialize handshake with experimental API enabled.

**Data flow**: Calls `initialize_with_experimental_api(true)` and returns its typed `InitializeResponse`.

**Call relations**: Most scenario helpers use this convenience wrapper instead of specifying the experimental flag explicitly.

*Call graph*: calls 1 internal fn (initialize_with_experimental_api).


##### `CodexClient::initialize_with_experimental_api`  (lines 1649–1685)

```
fn initialize_with_experimental_api(
        &mut self,
        experimental_api: bool,
    ) -> Result<InitializeResponse>
```

**Purpose**: Sends the JSON-RPC `initialize` request with client metadata and capabilities, then completes the handshake by sending an `initialized` notification.

**Data flow**: Generates a request ID, builds `ClientRequest::Initialize` containing `ClientInfo` and `InitializeCapabilities` (including `experimental_api`, `request_attestation = false`, and the opt-out notification method list), sends it via `send_request`, then writes a raw JSON-RPC `initialized` notification with `write_jsonrpc_message`. It returns the typed initialize response.

**Call relations**: Called by `initialize` and by scenario helpers that need to toggle experimental API support before any other requests.

*Call graph*: calls 3 internal fn (request_id, send_request, write_jsonrpc_message); called by 1 (initialize); 2 external calls (Notification, env!).


##### `CodexClient::thread_start`  (lines 1687–1695)

```
fn thread_start(&mut self, params: ThreadStartParams) -> Result<ThreadStartResponse>
```

**Purpose**: Sends a typed `thread/start` request and returns the decoded response.

**Data flow**: Generates a request ID, wraps the provided `ThreadStartParams` in `ClientRequest::ThreadStart`, and delegates to `send_request`. It returns `ThreadStartResponse`.

**Call relations**: Used by many scenario helpers whenever a new thread must be created before starting a turn.

*Call graph*: calls 2 internal fn (request_id, send_request); called by 1 (run_plugin_turn).


##### `CodexClient::thread_resume`  (lines 1697–1705)

```
fn thread_resume(&mut self, params: ThreadResumeParams) -> Result<ThreadResumeResponse>
```

**Purpose**: Sends a typed `thread/resume` request for an existing thread.

**Data flow**: Creates a request ID, builds `ClientRequest::ThreadResume` with the supplied params, and delegates to `send_request`, returning `ThreadResumeResponse`.

**Call relations**: Scenario helpers for resumed-thread flows call this before sending new turns or following notifications.

*Call graph*: calls 2 internal fn (request_id, send_request).


##### `CodexClient::turn_start`  (lines 1707–1715)

```
fn turn_start(&mut self, params: TurnStartParams) -> Result<TurnStartResponse>
```

**Purpose**: Sends a typed `turn/start` request and returns the decoded turn-start response.

**Data flow**: Generates a request ID, wraps `TurnStartParams` in `ClientRequest::TurnStart`, and delegates to `send_request`. It returns `TurnStartResponse`.

**Call relations**: This is the core request used by all message-sending scenarios after a thread has been created or resumed.

*Call graph*: calls 2 internal fn (request_id, send_request); called by 1 (run_plugin_turn).


##### `CodexClient::login_account_chatgpt`  (lines 1717–1727)

```
fn login_account_chatgpt(&mut self) -> Result<LoginAccountResponse>
```

**Purpose**: Starts the browser-based ChatGPT account login flow.

**Data flow**: Generates a request ID, builds `ClientRequest::LoginAccount` with `LoginAccountParams::Chatgpt { codex_streamlined_login: false }`, sends it, and returns the typed `LoginAccountResponse`.

**Call relations**: Used by `test_login` when the device-code flag is not set.

*Call graph*: calls 2 internal fn (request_id, send_request).


##### `CodexClient::login_account_chatgpt_device_code`  (lines 1729–1737)

```
fn login_account_chatgpt_device_code(&mut self) -> Result<LoginAccountResponse>
```

**Purpose**: Starts the device-code ChatGPT account login flow.

**Data flow**: Generates a request ID, builds `ClientRequest::LoginAccount` with `LoginAccountParams::ChatgptDeviceCode`, sends it, and returns the typed response.

**Call relations**: Used by `test_login` when `--device-code` is requested.

*Call graph*: calls 2 internal fn (request_id, send_request).


##### `CodexClient::get_account_rate_limits`  (lines 1739–1747)

```
fn get_account_rate_limits(&mut self) -> Result<GetAccountRateLimitsResponse>
```

**Purpose**: Sends `account/rateLimits/read` and decodes the resulting rate-limit snapshot.

**Data flow**: Creates a request ID, builds `ClientRequest::GetAccountRateLimits { params: None }`, delegates to `send_request`, and returns `GetAccountRateLimitsResponse`.

**Call relations**: Called by the `get_account_rate_limits` scenario helper.

*Call graph*: calls 2 internal fn (request_id, send_request).


##### `CodexClient::model_list`  (lines 1749–1757)

```
fn model_list(&mut self, params: ModelListParams) -> Result<ModelListResponse>
```

**Purpose**: Sends `model/list` with the provided parameters and returns the decoded model list.

**Data flow**: Generates a request ID, wraps `ModelListParams` in `ClientRequest::ModelList`, and delegates to `send_request`, returning `ModelListResponse`.

**Call relations**: Used by the `model_list` scenario helper.

*Call graph*: calls 2 internal fn (request_id, send_request).


##### `CodexClient::thread_list`  (lines 1759–1767)

```
fn thread_list(&mut self, params: ThreadListParams) -> Result<ThreadListResponse>
```

**Purpose**: Sends `thread/list` with the provided filters and returns the decoded thread page.

**Data flow**: Creates a request ID, wraps `ThreadListParams` in `ClientRequest::ThreadList`, and delegates to `send_request`, returning `ThreadListResponse`.

**Call relations**: Used by the `thread_list` scenario helper.

*Call graph*: calls 2 internal fn (request_id, send_request).


##### `CodexClient::thread_increment_elicitation`  (lines 1769–1780)

```
fn thread_increment_elicitation(
        &mut self,
        params: ThreadIncrementElicitationParams,
    ) -> Result<ThreadIncrementElicitationResponse>
```

**Purpose**: Sends `thread/increment_elicitation` for a thread and returns the typed response.

**Data flow**: Generates a request ID, wraps `ThreadIncrementElicitationParams` in the corresponding client request, and delegates to `send_request`.

**Call relations**: Called by the direct `thread_increment_elicitation` helper and by cleanup/testing flows that manipulate elicitation pause state.

*Call graph*: calls 2 internal fn (request_id, send_request).


##### `CodexClient::thread_decrement_elicitation`  (lines 1782–1793)

```
fn thread_decrement_elicitation(
        &mut self,
        params: ThreadDecrementElicitationParams,
    ) -> Result<ThreadDecrementElicitationResponse>
```

**Purpose**: Sends `thread/decrement_elicitation` for a thread and returns the typed response.

**Data flow**: Generates a request ID, wraps `ThreadDecrementElicitationParams` in the corresponding client request, and delegates to `send_request`.

**Call relations**: Used by the direct decrement helper and by the live elicitation harness cleanup path.

*Call graph*: calls 2 internal fn (request_id, send_request).


##### `CodexClient::wait_for_account_login_completion`  (lines 1795–1821)

```
fn wait_for_account_login_completion(
        &mut self,
        expected_login_id: &str,
    ) -> Result<AccountLoginCompletedNotification>
```

**Purpose**: Consumes notifications until it sees an `account/login/completed` notification whose `login_id` matches the expected login flow.

**Data flow**: Loops on `next_notification`, attempts to deserialize each notification into `ServerNotification`, and when it sees `AccountLoginCompleted`, compares `completion.login_id` to `expected_login_id`. Matching completion is returned; mismatched completions are logged and ignored; rate-limit update notifications are also printed and ignored.

**Call relations**: `test_login` uses this after starting a login flow so it can wait for the asynchronous completion callback.

*Call graph*: calls 1 internal fn (next_notification); 2 external calls (try_from, println!).


##### `CodexClient::stream_turn`  (lines 1823–1917)

```
fn stream_turn(&mut self, thread_id: &str, turn_id: &str) -> Result<()>
```

**Purpose**: Processes notifications for one active turn until its matching `TurnCompleted` arrives, printing deltas and updating client-side tracking for approvals, command execution, helper completion, and final turn status.

**Data flow**: Loops on `next_notification`, converts notifications into `ServerNotification`, and matches many variants: prints thread/turn started notices; streams agent and command output deltas to stdout; records terminal stdin echoes; tracks `ItemStarted` and `ItemCompleted` events, including command statuses and aggregated output; updates helper-completion and unexpected-item state; and on matching `TurnCompleted`, stores `last_turn_status` and optional error message, flags premature completion if the helper was still running, prints status/error, and breaks. It returns `Ok(())` after the target turn completes.

**Call relations**: This is the main event loop used by nearly every turn-based scenario and by the live elicitation timeout harness. It depends on `item_started_before_helper_done_is_unexpected` and `note_helper_output` for specialized validation.

*Call graph*: calls 3 internal fn (next_notification, note_helper_output, item_started_before_helper_done_is_unexpected); called by 1 (run_plugin_turn); 5 external calls (try_from, matches!, print!, println!, stdout).


##### `CodexClient::stream_notifications_forever`  (lines 1919–1923)

```
fn stream_notifications_forever(&mut self) -> Result<()>
```

**Purpose**: Continuously reads and discards/prints notifications indirectly by driving the notification loop forever.

**Data flow**: Loops indefinitely calling `next_notification`; any returned notification is ignored, and any transport/protocol error breaks the function with an error. It does not maintain additional state beyond what `next_notification` and server-request handlers update.

**Call relations**: Used by `watch` and `thread_resume_follow` for long-running observation modes.

*Call graph*: calls 1 internal fn (next_notification).


##### `CodexClient::send_request`  (lines 1925–1946)

```
fn send_request(
        &mut self,
        request: ClientRequest,
        request_id: RequestId,
        method: &str,
    ) -> Result<T>
```

**Purpose**: Wraps one typed client request in a tracing span, writes it to the transport, and waits for the matching typed response.

**Data flow**: Accepts a `ClientRequest`, its `RequestId`, and a method name, creates a request-level tracing span with JSON-RPC metadata, then inside that span calls `write_request` followed by `wait_for_response`. It returns the deserialized response type `T` or an error.

**Call relations**: All typed request helpers (`initialize_with_experimental_api`, `thread_start`, `turn_start`, login, listing, elicitation controls, etc.) delegate through this common request/response path.

*Call graph*: called by 16 (get_account_rate_limits, initialize_with_experimental_api, login_account_chatgpt, login_account_chatgpt_device_code, model_list, thread_decrement_elicitation, thread_increment_elicitation, thread_list, thread_resume, thread_start (+6 more)); 1 external calls (info_span!).


##### `CodexClient::write_request`  (lines 1948–1957)

```
fn write_request(&mut self, request: &ClientRequest) -> Result<()>
```

**Purpose**: Serializes a typed `ClientRequest` into a JSON-RPC request, injects current trace context, logs a pretty-printed copy, and writes the compact payload to the transport.

**Data flow**: Converts the typed request to `serde_json::Value`, re-deserializes it as `JSONRPCRequest`, sets its `trace` field from `current_span_w3c_trace_context`, serializes both compact and pretty forms, prints the pretty form with a `> ` prefix, and sends the compact JSON string via `write_payload`.

**Call relations**: Called only by `send_request`; it is the point where tracing metadata is attached to outgoing JSON-RPC requests.

*Call graph*: calls 2 internal fn (write_payload, print_multiline_with_prefix); 5 external calls (current_span_w3c_trace_context, from_value, to_string, to_string_pretty, to_value).


##### `CodexClient::wait_for_response`  (lines 1959–1986)

```
fn wait_for_response(&mut self, request_id: RequestId, method: &str) -> Result<T>
```

**Purpose**: Reads JSON-RPC messages until it finds the response or error matching a specific request ID, while buffering notifications and servicing server-initiated requests along the way.

**Data flow**: Loops on `read_jsonrpc_message`. Matching `Response` IDs are deserialized into `T` and returned; matching `Error` IDs become a `bail!`; notifications are pushed into `pending_notifications`; server requests are handled immediately via `handle_server_request`; unrelated responses/errors are ignored by continuing the loop.

**Call relations**: This is the receive-side half of `send_request`, ensuring synchronous request/response semantics even when notifications and approval requests interleave.

*Call graph*: calls 2 internal fn (handle_server_request, read_jsonrpc_message); 3 external calls (push_back, bail!, from_value).


##### `CodexClient::next_notification`  (lines 1988–2007)

```
fn next_notification(&mut self) -> Result<JSONRPCNotification>
```

**Purpose**: Returns the next available notification, first draining any buffered notifications and otherwise reading messages until a notification arrives.

**Data flow**: If `pending_notifications` is non-empty, pops and returns the front notification. Otherwise it loops on `read_jsonrpc_message`, returning notifications immediately, ignoring stray responses/errors, and handling server requests synchronously via `handle_server_request` before continuing.

**Call relations**: Turn streaming, login completion waiting, and watch modes all rely on this helper to consume notifications without losing interleaved server requests.

*Call graph*: calls 2 internal fn (handle_server_request, read_jsonrpc_message); called by 3 (stream_notifications_forever, stream_turn, wait_for_account_login_completion); 1 external calls (pop_front).


##### `CodexClient::read_jsonrpc_message`  (lines 2009–2025)

```
fn read_jsonrpc_message(&mut self) -> Result<JSONRPCMessage>
```

**Purpose**: Reads one non-empty raw payload from the transport, parses it as JSON, pretty-prints it, and deserializes it into a `JSONRPCMessage`.

**Data flow**: Loops on `read_payload` until a non-whitespace string is received, parses it into `serde_json::Value`, pretty-serializes and prints it with a `< ` prefix, then converts the value into `JSONRPCMessage` and returns it.

**Call relations**: Both `wait_for_response` and `next_notification` use this as the low-level inbound message decoder.

*Call graph*: calls 2 internal fn (read_payload, print_multiline_with_prefix); called by 2 (next_notification, wait_for_response); 3 external calls (from_str, from_value, to_string_pretty).


##### `CodexClient::request_id`  (lines 2027–2029)

```
fn request_id(&self) -> RequestId
```

**Purpose**: Generates a fresh string JSON-RPC request ID using a UUID v4.

**Data flow**: Creates a new UUID, converts it to a string, wraps it in `RequestId::String`, and returns it.

**Call relations**: Every typed request helper calls this before constructing its `ClientRequest`.

*Call graph*: called by 16 (get_account_rate_limits, initialize_with_experimental_api, login_account_chatgpt, login_account_chatgpt_device_code, model_list, thread_decrement_elicitation, thread_increment_elicitation, thread_list, thread_resume, thread_start (+6 more)); 2 external calls (new_v4, String).


##### `CodexClient::handle_server_request`  (lines 2031–2048)

```
fn handle_server_request(&mut self, request: JSONRPCRequest) -> Result<()>
```

**Purpose**: Deserializes a raw JSON-RPC server request into a typed `ServerRequest` and dispatches supported approval requests to the appropriate responder.

**Data flow**: Attempts `ServerRequest::try_from(request)`, then matches the typed request: command-execution approvals go to `handle_command_execution_request_approval`, file-change approvals go to `approve_file_change_request`, and any other server request causes an error. It returns unit on successful handling.

**Call relations**: This function is invoked whenever `wait_for_response` or `next_notification` encounters a server-initiated request interleaved with normal traffic.

*Call graph*: calls 2 internal fn (approve_file_change_request, handle_command_execution_request_approval); called by 2 (next_notification, wait_for_response); 2 external calls (try_from, bail!).


##### `CodexClient::handle_command_execution_request_approval`  (lines 2050–2124)

```
fn handle_command_execution_request_approval(
        &mut self,
        request_id: RequestId,
        params: CommandExecutionRequestApprovalParams,
    ) -> Result<()>
```

**Purpose**: Logs the details of a command-execution approval request, updates approval-tracking counters, chooses accept vs cancel according to configured behavior, and sends the response.

**Data flow**: Destructures `CommandExecutionRequestApprovalParams`, prints thread/turn/item/approval metadata plus optional reason, network context, decisions, command, cwd, actions, permissions, and policy amendments; increments `command_approval_count` and records `item_id`; computes a `CommandExecutionApprovalDecision` based on `command_approval_behavior`; wraps it in `CommandExecutionRequestApprovalResponse`; and sends it with `send_server_request_response`.

**Call relations**: Called only from `handle_server_request` when the server asks the client to approve or cancel command execution. Its counters are later inspected by approval-focused scenario helpers.

*Call graph*: calls 1 internal fn (send_server_request_response); called by 1 (handle_server_request); 1 external calls (println!).


##### `CodexClient::approve_file_change_request`  (lines 2126–2156)

```
fn approve_file_change_request(
        &mut self,
        request_id: RequestId,
        params: FileChangeRequestApprovalParams,
    ) -> Result<()>
```

**Purpose**: Logs a file-change approval request and always responds with acceptance.

**Data flow**: Destructures `FileChangeRequestApprovalParams`, prints thread/turn/item metadata plus optional reason and grant root, constructs `FileChangeRequestApprovalResponse { decision: Accept }`, sends it via `send_server_request_response`, and returns unit.

**Call relations**: This is the file-change branch of `handle_server_request`; unlike command approvals, it does not support configurable rejection behavior.

*Call graph*: calls 1 internal fn (send_server_request_response); called by 1 (handle_server_request); 1 external calls (println!).


##### `CodexClient::send_server_request_response`  (lines 2158–2167)

```
fn send_server_request_response(&mut self, request_id: RequestId, response: &T) -> Result<()>
```

**Purpose**: Wraps a typed response payload to a server-initiated request in a JSON-RPC response envelope and writes it out.

**Data flow**: Takes a request ID and any serializable response payload, converts the payload to `serde_json::Value`, constructs `JSONRPCMessage::Response(JSONRPCResponse { id, result })`, and delegates to `write_jsonrpc_message`.

**Call relations**: Both approval handlers use this helper to answer server-initiated JSON-RPC requests.

*Call graph*: calls 1 internal fn (write_jsonrpc_message); called by 2 (approve_file_change_request, handle_command_execution_request_approval); 2 external calls (Response, to_value).


##### `CodexClient::write_jsonrpc_message`  (lines 2169–2174)

```
fn write_jsonrpc_message(&mut self, message: JSONRPCMessage) -> Result<()>
```

**Purpose**: Serializes an arbitrary JSON-RPC message, pretty-prints it for logging, and writes the compact payload to the active transport.

**Data flow**: Serializes the message to compact and pretty JSON strings, prints the pretty form with `> ` prefixes, and sends the compact string through `write_payload`.

**Call relations**: Used for the post-initialize `initialized` notification and for responses to server-initiated approval requests.

*Call graph*: calls 2 internal fn (write_payload, print_multiline_with_prefix); called by 2 (initialize_with_experimental_api, send_server_request_response); 2 external calls (to_string, to_string_pretty).


##### `CodexClient::write_payload`  (lines 2176–2195)

```
fn write_payload(&mut self, payload: &str) -> Result<()>
```

**Purpose**: Writes one raw JSON payload string to either the child process stdin or the websocket connection.

**Data flow**: Matches on `self.transport`: for stdio, writes the payload plus newline to the child stdin and flushes it, erroring if stdin is already closed; for websocket, sends a text frame to the stored URL/socket pair. It returns `Ok(())` on successful transport write.

**Call relations**: This is the lowest-level outbound transport primitive used by both request and generic JSON-RPC message writers.

*Call graph*: called by 2 (write_jsonrpc_message, write_request); 3 external calls (bail!, Text, writeln!).


##### `CodexClient::read_payload`  (lines 2197–2223)

```
fn read_payload(&mut self) -> Result<String>
```

**Purpose**: Reads one raw payload string from the active transport, abstracting over line-delimited stdio and framed websocket messages.

**Data flow**: For stdio, reads one line from the buffered child stdout, errors on EOF, and returns the line string. For websocket, loops reading frames until it gets a text frame, ignoring binary/ping/pong/frame variants and erroring on close. It returns the received text payload.

**Call relations**: `read_jsonrpc_message` uses this as the lowest-level inbound transport primitive.

*Call graph*: called by 1 (read_jsonrpc_message); 2 external calls (new, bail!).


##### `print_multiline_with_prefix`  (lines 2226–2230)

```
fn print_multiline_with_prefix(prefix: &str, payload: &str)
```

**Purpose**: Prints each line of a multi-line payload with a consistent prefix for readable request/response logs.

**Data flow**: Splits the input string on lines and prints each line prefixed with the supplied marker. It returns unit and does not transform data beyond formatting.

**Call relations**: Used by request and response logging paths so outbound and inbound JSON are visually distinguished.

*Call graph*: called by 3 (read_jsonrpc_message, write_jsonrpc_message, write_request); 1 external calls (println!).


##### `TestClientTracing::initialize`  (lines 2238–2269)

```
async fn initialize(config_overrides: &[String]) -> Result<Self>
```

**Purpose**: Loads config with CLI overrides, initializes OTEL/tracing if configured, and reports whether traces are enabled for the current command.

**Data flow**: Parses raw `-c` overrides into `CliConfigOverrides`, asynchronously loads `Config`, builds an OTEL provider with service name `codex-app-server-test-client` and analytics enabled by default, checks whether a tracer provider exists, conditionally installs the provider’s tracing layer into the subscriber registry, and returns `TestClientTracing { _otel_provider, traces_enabled }`.

**Call relations**: `with_client` awaits this before opening the command span so outgoing requests can inherit trace context when tracing is configured.

*Call graph*: calls 1 internal fn (build_provider); called by 1 (with_client); 3 external calls (load_with_cli_overrides, env!, registry).


##### `TraceSummary::capture`  (lines 2279–2287)

```
fn capture(traces_enabled: bool) -> Self
```

**Purpose**: Captures a user-facing trace summary from the current span context when tracing is enabled.

**Data flow**: If `traces_enabled` is false, returns `TraceSummary::Disabled`. Otherwise it reads the current W3C trace context, attempts to derive a trace URL with `trace_url_from_context`, and returns either `Enabled { url }` or `Disabled` if no usable context is present.

**Call relations**: `with_client` calls this inside the command span so it can print a Datadog-style trace link after the scenario finishes.

*Call graph*: 1 external calls (current_span_w3c_trace_context).


##### `trace_url_from_context`  (lines 2290–2301)

```
fn trace_url_from_context(trace: &W3cTraceContext) -> Option<String>
```

**Purpose**: Extracts a Datadog-style trace URL path from a W3C `traceparent` header when the trace ID is well-formed.

**Data flow**: Reads `trace.traceparent`, splits it on `-`, and if it finds four parts with a 32-character trace ID, formats `go/trace/<trace_id>` and returns it; otherwise returns `None`.

**Call relations**: Used only by `TraceSummary::capture` to turn raw trace context into a concise printable link.

*Call graph*: 1 external calls (format!).


##### `print_trace_summary`  (lines 2303–2309)

```
fn print_trace_summary(trace_summary: &TraceSummary)
```

**Purpose**: Prints a short Datadog trace section after a command finishes, either showing the trace URL or a disabled message.

**Data flow**: Prints a `[Datadog trace]` header, matches the `TraceSummary`, and prints either the enabled URL or the constant disabled message. It returns unit.

**Call relations**: `with_client` calls this after the scenario closure completes so every command ends with a trace summary.

*Call graph*: called by 1 (with_client); 1 external calls (println!).


##### `CodexClient::drop`  (lines 2312–2340)

```
fn drop(&mut self)
```

**Purpose**: Gracefully shuts down a spawned stdio app-server child when the client is dropped, escalating to kill after a timeout if needed.

**Data flow**: If the transport is websocket, it returns immediately. For stdio, it drops the stored stdin handle to signal EOF, checks whether the child already exited, then polls `try_wait` until `APP_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT` using `APP_SERVER_GRACEFUL_SHUTDOWN_POLL_INTERVAL`; if the child still has not exited, it sends `kill` and waits. It prints exit status when observed.

**Call relations**: This destructor runs automatically for stdio-backed clients created by `CodexClient::connect`/`spawn_stdio`, ensuring private app-server children do not leak.

*Call graph*: 3 external calls (now, println!, sleep).


### `app-server-test-client/src/plugin_analytics_smoke.rs`

`test` · `manual smoke test execution during plugin analytics verification`

This file drives the standard plugin analytics smoke scenario. It creates or reuses a capture JSONL path, deletes any stale file, creates a temporary user config file, starts a loopback responses server, and assembles config overrides that force analytics on, enable plugin features, and point a mock model/provider at the loopback server. The child process receives both the analytics capture path and the temporary config path through environment variables, then the harness waits until the capture file exists before initializing the `CodexClient`.

Once connected, the test calls `plugin/installed`, searches all marketplaces for exactly one installed plugin matching the requested local plugin id, and verifies that it is installed, enabled, available, and backed by a remote plugin id. It then writes `plugins.<id>.enabled=false` and `true` into the temporary config via `config/value/write`, expecting `WriteStatus::Ok` both times. To prove the plugin is actually usable, it repeatedly starts ephemeral threads and turns that mention `plugin://<plugin_id>` until analytics for that turn include `codex_plugin_used`; this compensates for remote bundle readiness lag. Capture parsing reads JSONL payloads whose top-level `events` arrays are flattened into `Vec<Value>`. Validation requires exactly one each of `codex_plugin_disabled`, `codex_plugin_enabled`, and `codex_plugin_used`, checks plugin identity fields, and for usage events also requires non-null metadata such as thread id, turn id, model slug, connector and MCP fields.

#### Function details

##### `run`  (lines 40–95)

```
fn run(
    codex_bin: &Path,
    config_overrides: &[String],
    plugin_id: &str,
    capture_file: Option<PathBuf>,
) -> Result<()>
```

**Purpose**: Executes the full plugin analytics smoke test for an already installed plugin, from environment setup through event validation. It is the main entry for the non-destructive analytics smoke command.

**Data flow**: Takes the Codex binary path, config overrides, target local plugin id, and optional capture-file path. It prepares the capture file, creates a `TemporaryConfigFile`, starts `LoopbackResponsesServer`, extends overrides with `smoke_config_overrides`, spawns a `CodexClient` with analytics and test-config environment variables, waits for capture readiness, initializes the client, discovers the expected plugin via `plugin_installed` and `expected_plugin`, toggles the plugin disabled then enabled via `write_plugin_enabled`, waits for plugin usage readiness, waits for required plugin events, validates them, prints pretty JSON and the capture path, and returns success or the first encountered error.

**Call relations**: Called by the test client's smoke command dispatcher. It orchestrates nearly every helper in this file, plus the loopback server and client spawn path.

*Call graph*: calls 12 internal fn (spawn_stdio_with_env, start, create, expected_plugin, plugin_installed, prepare_capture_file, smoke_config_overrides, validate_plugin_events, wait_for_plugin_events, wait_for_plugin_usage (+2 more)); called by 1 (run); 2 external calls (println!, vec!).


##### `run_plugin_turn`  (lines 97–124)

```
fn run_plugin_turn(client: &mut CodexClient, expected: &ExpectedPlugin) -> Result<String>
```

**Purpose**: Starts an ephemeral thread and turn that mentions the target plugin so the app server attempts to resolve and use it. It fails if the streamed turn does not complete successfully.

**Data flow**: Accepts a mutable `CodexClient` and `ExpectedPlugin`. It sends `thread_start` with the mock model/provider constants and empty instructions, then `turn_start` with a single `UserInput::Mention` pointing at `plugin://<plugin_id>` and the plugin name, streams the turn to completion, checks `client.last_turn_status` and `client.last_turn_error_message`, and returns the created turn id.

**Call relations**: Called repeatedly by `wait_for_plugin_usage` until a turn's analytics prove the plugin was actually used.

*Call graph*: calls 3 internal fn (stream_turn, thread_start, turn_start); called by 1 (wait_for_plugin_usage); 4 external calls (default, new, bail!, vec!).


##### `wait_for_plugin_usage`  (lines 126–157)

```
fn wait_for_plugin_usage(
    client: &mut CodexClient,
    capture_path: &Path,
    expected: &ExpectedPlugin,
) -> Result<()>
```

**Purpose**: Retries plugin-mention turns until analytics show that the plugin was used in a completed turn, accommodating delayed remote bundle readiness. It treats turn-completion analytics as the barrier for each attempt.

**Data flow**: Takes a mutable client, capture-file path, and expected plugin metadata. It loops until `PLUGIN_READY_TIMEOUT`, incrementing an attempt counter, running a plugin turn, waiting for analytics for that turn id, and scanning those events for a `codex_plugin_used` event whose `turn_id` and `plugin_id` match the attempt. On success it optionally prints how many attempts were needed; on timeout it returns an error mentioning the plugin id and attempt count.

**Call relations**: Called by `run` after toggling enabled state and before final event collection. It delegates each attempt to `run_plugin_turn` and `wait_for_turn_analytics`.

*Call graph*: calls 2 internal fn (run_plugin_turn, wait_for_turn_analytics); called by 1 (run); 4 external calls (now, bail!, println!, sleep).


##### `plugin_installed`  (lines 166–179)

```
fn plugin_installed(client: &mut CodexClient) -> Result<PluginInstalledResponse>
```

**Purpose**: Fetches the installed-plugin inventory from the app server. It is the raw RPC wrapper used before narrowing to the target plugin.

**Data flow**: Receives a mutable `CodexClient`, allocates a request id, sends `ClientRequest::PluginInstalled` with empty optional filters, and returns the typed `PluginInstalledResponse`.

**Call relations**: Called by `run` as the first plugin-discovery step before `expected_plugin` validates the chosen plugin.

*Call graph*: calls 2 internal fn (request_id, send_request); called by 1 (run).


##### `expected_plugin`  (lines 181–221)

```
fn expected_plugin(response: &PluginInstalledResponse, plugin_id: &str) -> Result<ExpectedPlugin>
```

**Purpose**: Finds and validates the single installed plugin matching the requested local plugin id across all marketplaces. It extracts the identity fields later used to validate analytics.

**Data flow**: Consumes a `PluginInstalledResponse` reference and target plugin id. It flattens all marketplace/plugin pairs, collects matches by `plugin.id`, requires exactly one match, checks `installed`, `enabled`, `availability == Available`, and presence of `remote_plugin_id`, then returns `ExpectedPlugin { plugin_id, plugin_name, marketplace_name }`.

**Call relations**: Called by `run` immediately after `plugin_installed`; its output feeds config writes, turn generation, and analytics validation.

*Call graph*: called by 1 (run); 1 external calls (bail!).


##### `write_plugin_enabled`  (lines 223–255)

```
fn write_plugin_enabled(
    client: &mut CodexClient,
    config_path: &Path,
    plugin_id: &str,
    enabled: bool,
) -> Result<()>
```

**Purpose**: Writes the plugin enabled flag into the temporary config file through the app server's config-write RPC and verifies the write was accepted. It is used to generate disabled/enabled analytics events deterministically.

**Data flow**: Takes a mutable client, config file path, plugin id, and desired boolean. It sends `ClientRequest::ConfigValueWrite` with key path `plugins.<plugin_id>.enabled`, JSON boolean value, `MergeStrategy::Replace`, and the explicit file path, prints the returned status, and returns an error if `response.status` is anything other than `WriteStatus::Ok`.

**Call relations**: Called twice by `run`, first with `false` then with `true`, to force both state-transition analytics events.

*Call graph*: calls 2 internal fn (request_id, send_request); called by 1 (run); 5 external calls (display, bail!, format!, json!, println!).


##### `smoke_config_overrides`  (lines 257–279)

```
fn smoke_config_overrides(responses_base_url: &str) -> Result<Vec<String>>
```

**Purpose**: Builds the fixed set of config overrides needed for the smoke environment, including analytics flags and a mock model provider pointed at the loopback responses server. It serializes string values so they can be passed as config literals.

**Data flow**: Accepts the loopback server base URL, serializes the provider `/v1` URL as JSON, constructs a `Vec<String>` containing analytics/plugin feature flags, default model/provider selection, provider metadata, wire API, auth requirement, and retry limits, and returns that vector.

**Call relations**: Called by `run` during child-process setup. It uses `quoted` for string-valued config entries.

*Call graph*: called by 1 (run); 3 external calls (format!, to_string, vec!).


##### `quoted`  (lines 281–283)

```
fn quoted(value: &str) -> Result<String>
```

**Purpose**: Serializes a plain string into a JSON string literal suitable for embedding in config override expressions. This avoids manual escaping bugs.

**Data flow**: Takes `&str`, runs `serde_json::to_string`, and returns the serialized string or a contextual error.

**Call relations**: Used by `smoke_config_overrides` when constructing override values that must remain quoted strings.

*Call graph*: 1 external calls (to_string).


##### `prepare_capture_file`  (lines 285–304)

```
fn prepare_capture_file(path: &Path) -> Result<()>
```

**Purpose**: Ensures the analytics capture path is usable by verifying its parent directory exists and removing any stale file at that path. It intentionally leaves the file absent so the child process can create it.

**Data flow**: Accepts a path, checks `parent()` and that the parent is a directory, attempts `fs::remove_file`, ignores `NotFound`, and wraps other filesystem errors with path context. It returns `Ok(())` once the path is clean.

**Call relations**: Called by both smoke-test files before spawning a child process that will create and append to the capture file.

*Call graph*: called by 2 (run, run); 3 external calls (parent, bail!, remove_file).


##### `wait_until_capture_is_ready`  (lines 306–325)

```
fn wait_until_capture_is_ready(path: &Path) -> Result<()>
```

**Purpose**: Polls for the analytics capture file to appear, which indicates that the child process supports and has activated capture output. It fails fast with a hint to use a debug Codex binary if the file never appears.

**Data flow**: Takes the capture-file path, repeatedly checks `fs::metadata` until success or `CAPTURE_READY_TIMEOUT`, ignores `NotFound`, wraps other metadata errors with path context, sleeps `CAPTURE_POLL_INTERVAL` between attempts, and returns `Ok(())` or a timeout error.

**Call relations**: Called by both smoke-test files immediately after spawning the child client and before initialization proceeds.

*Call graph*: called by 2 (run, run); 4 external calls (now, bail!, metadata, sleep).


##### `wait_for_plugin_events`  (lines 327–349)

```
fn wait_for_plugin_events(path: &Path, plugin_id: &str) -> Result<Vec<Value>>
```

**Purpose**: Polls the capture file until all required plugin analytics event types have appeared for the target plugin. It is the final collection barrier before validation.

**Data flow**: Accepts the capture-file path and plugin id. It repeatedly reads plugin-filtered events, checks that every event type from `required_event_types()` has count at least one using `event_count`, and returns the collected events once complete. On timeout it returns an error that includes the event types actually seen.

**Call relations**: Called by `run` after plugin usage has been proven. It depends on `read_plugin_events`, `required_event_types`, and `event_count`.

*Call graph*: calls 2 internal fn (read_plugin_events, required_event_types); called by 1 (run); 3 external calls (now, bail!, sleep).


##### `wait_for_turn_analytics`  (lines 351–369)

```
fn wait_for_turn_analytics(path: &Path, turn_id: &str) -> Result<Vec<Value>>
```

**Purpose**: Waits until analytics for a specific turn id have been captured, using the turn event as a synchronization point. This lets the caller inspect all events emitted for that attempt.

**Data flow**: Takes the capture-file path and turn id, repeatedly reads all capture events, scans for a `codex_turn_event` whose `event_params.turn_id` matches, and returns the full event list once found. It times out after `CAPTURE_TIMEOUT` with a path-specific error.

**Call relations**: Called by `wait_for_plugin_usage` after each attempted plugin turn.

*Call graph*: calls 1 internal fn (read_capture_events); called by 1 (wait_for_plugin_usage); 3 external calls (now, bail!, sleep).


##### `read_plugin_events`  (lines 371–376)

```
fn read_plugin_events(path: &Path, plugin_id: &str) -> Result<Vec<Value>>
```

**Purpose**: Filters the full analytics capture down to events whose `event_params.plugin_id` matches the target plugin. It is a thin convenience wrapper over raw capture parsing.

**Data flow**: Accepts the capture-file path and plugin id, calls `read_capture_events`, filters the resulting `Vec<Value>` by `event_params.plugin_id`, and returns the filtered vector.

**Call relations**: Used by `wait_for_plugin_events` to focus only on analytics relevant to the plugin under test.

*Call graph*: calls 1 internal fn (read_capture_events); called by 1 (wait_for_plugin_events).


##### `read_capture_events`  (lines 378–404)

```
fn read_capture_events(path: &Path) -> Result<Vec<Value>>
```

**Purpose**: Parses the JSONL analytics capture file into a flat vector of individual event objects. Each non-empty line is expected to contain a payload with an `events` array.

**Data flow**: Takes the capture-file path, reads the file to string, returns an empty vector on `NotFound`, otherwise iterates lines with indexes, skips blank lines, parses each line as `serde_json::Value`, extracts `payload["events"]` as an array, clones each event into an accumulator, and returns the flattened `Vec<Value>`.

**Call relations**: Called by both `read_plugin_events` and `wait_for_turn_analytics`; it is the core capture-file parser for this smoke harness.

*Call graph*: called by 2 (read_plugin_events, wait_for_turn_analytics); 3 external calls (new, read_to_string, from_str).


##### `validate_plugin_events`  (lines 406–427)

```
fn validate_plugin_events(events: Vec<Value>, expected: &ExpectedPlugin) -> Result<Vec<Value>>
```

**Purpose**: Checks that the plugin analytics capture contains exactly one event of each required type and that each event carries the expected identity and usage metadata. It returns the validated events in required-type order.

**Data flow**: Consumes a vector of event `Value`s and an `ExpectedPlugin`. For each event type from `required_event_types`, it filters matching events, requires exactly one, validates plugin identity fields, additionally validates usage metadata for `codex_plugin_used`, clones the event into an output vector, and returns that vector or a descriptive error.

**Call relations**: Called by `run` after `wait_for_plugin_events` has ensured the required event types are present.

*Call graph*: calls 3 internal fn (required_event_types, validate_identity, validate_used_metadata); called by 1 (run); 2 external calls (new, bail!).


##### `required_event_types`  (lines 429–435)

```
fn required_event_types() -> [&'static str; 3]
```

**Purpose**: Defines the exact analytics event types that the smoke test expects from toggling and using a plugin. Keeping them in one place ensures polling and validation stay aligned.

**Data flow**: Returns a fixed array of three `&'static str` values: `codex_plugin_disabled`, `codex_plugin_enabled`, and `codex_plugin_used`.

**Call relations**: Used by both `wait_for_plugin_events` and `validate_plugin_events` so collection and validation share the same required set.

*Call graph*: called by 2 (validate_plugin_events, wait_for_plugin_events).


##### `event_count`  (lines 437–442)

```
fn event_count(events: &[Value], event_type: &str) -> usize
```

**Purpose**: Counts how many captured events have a given `event_type`. It supports the polling logic that waits for all required event kinds to appear.

**Data flow**: Takes a slice of event `Value`s and an event-type string, filters by `event["event_type"] == event_type`, and returns the count.

**Call relations**: Used by `wait_for_plugin_events` when checking whether every required event type has appeared at least once.

*Call graph*: 1 external calls (iter).


##### `validate_identity`  (lines 444–449)

```
fn validate_identity(event: &Value, expected: &ExpectedPlugin) -> Result<()>
```

**Purpose**: Verifies that a captured plugin event names the expected plugin id, plugin name, and marketplace. It enforces consistent identity across all event types.

**Data flow**: Accepts an event `Value` and `ExpectedPlugin`, reads `event["event_params"]`, and calls `require_string` for `plugin_id`, `plugin_name`, and `marketplace_name`. It returns `Ok(())` only if all three match exactly.

**Call relations**: Called by `validate_plugin_events` for every required event before any event is accepted as valid.

*Call graph*: calls 1 internal fn (require_string); called by 1 (validate_plugin_events).


##### `validate_used_metadata`  (lines 451–467)

```
fn validate_used_metadata(event: &Value) -> Result<()>
```

**Purpose**: Checks that the `codex_plugin_used` event includes the non-null metadata fields expected from a real plugin invocation, including the mock model slug. This guards against partially populated analytics.

**Data flow**: Takes an event `Value`, inspects `event["event_params"]`, ensures each of `has_skills`, `mcp_server_count`, `connector_ids`, `mcp_server_names`, `thread_id`, `turn_id`, and `model_slug` is present and non-null, then requires `model_slug == MOCK_MODEL_SLUG`.

**Call relations**: Called only by `validate_plugin_events` for the `codex_plugin_used` case.

*Call graph*: calls 1 internal fn (require_string); called by 1 (validate_plugin_events); 1 external calls (bail!).


##### `require_string`  (lines 469–475)

```
fn require_string(params: &Value, field: &str, expected: &str) -> Result<()>
```

**Purpose**: Asserts that a JSON object field exists as a string and equals an expected value. It provides the common exact-match check used by event validators.

**Data flow**: Accepts a JSON `Value` object, field name, and expected string. It reads `params.get(field).and_then(Value::as_str)`, compares it to `Some(expected)`, and returns `Ok(())` or a `bail!` error describing the mismatch.

**Call relations**: Used by `validate_identity` and `validate_used_metadata` to keep field checking consistent.

*Call graph*: called by 2 (validate_identity, validate_used_metadata); 2 external calls (get, bail!).


##### `TemporaryConfigFile::create`  (lines 482–490)

```
fn create() -> Result<Self>
```

**Purpose**: Creates an empty temporary TOML config file in the system temp directory for the smoke test to mutate. The file path is deterministic per process id.

**Data flow**: Builds a temp path named `codex-plugin-analytics-config-<pid>.toml`, writes an empty string to it, wraps filesystem errors with path context, and returns `TemporaryConfigFile { path }`.

**Call relations**: Called by `run` during setup so config writes can target an isolated file rather than the user's real config.

*Call graph*: called by 1 (run); 3 external calls (format!, write, temp_dir).


##### `TemporaryConfigFile::path`  (lines 492–494)

```
fn path(&self) -> &Path
```

**Purpose**: Returns the filesystem path of the temporary config file. It is a simple accessor used by setup and config-write calls.

**Data flow**: Borrows `self` and returns `&Path` referencing the stored `PathBuf`.

**Call relations**: Used by `run` when exporting the config path to the child environment and when issuing `config/value/write` requests.


##### `TemporaryConfigFile::drop`  (lines 498–500)

```
fn drop(&mut self)
```

**Purpose**: Best-effort deletes the temporary config file when the wrapper goes out of scope. It prevents smoke-test artifacts from accumulating in the temp directory.

**Data flow**: On drop, calls `fs::remove_file(&self.path)` and ignores any error.

**Call relations**: Runs automatically at teardown after `run` returns and the temporary config wrapper is dropped.

*Call graph*: 1 external calls (remove_file).


### `app-server-test-client/src/plugin_analytics_mutation_smoke.rs`

`test` · `manual smoke test execution and post-failure cleanup`

This file is a test-driver for account-mutating plugin analytics scenarios. Its top-level flow insists on an explicit `AccountMutationConfirmation` before touching account state, then prepares a JSONL analytics capture file, spawns a `CodexClient` with analytics and remote-plugin features enabled, and waits for the capture sink to appear. After initialization it reads the target plugin through `plugin/read`, materializing a `RemotePluginExpectation` that captures the local plugin id, remote id, display name, marketplace name, install policy, availability, and installed flag. The initial plugin must be uninstalled and installable; otherwise the test aborts early.

The mutation sequence installs the plugin, polls `plugin/read` until `installed == true`, waits for a `codex_plugin_installed` event to appear in the capture file, then issues uninstall and polls until the backend reports `installed == false`. A notable design choice is that uninstall RPC failure is tracked separately from backend state: if the backend becomes uninstalled but the RPC still errors, the run is treated as a local-cache/client-side failure rather than a dirty backend state. Final analytics validation delegates to shared capture helpers and checks event identity against the remote plugin id/name/marketplace. Cleanup logic classifies outcomes into `Clean`, `LocalCleanupFailure`, `Dirty`, and `Unknown`, and prints a shell-quoted recovery command when manual intervention may be needed.

#### Function details

##### `run`  (lines 36–114)

```
fn run(
    codex_bin: &Path,
    config_overrides: &[String],
    remote_plugin_id: &str,
    confirmation: AccountMutationConfirmation,
    capture_file: Option<PathBuf>,
) -> Result<()>
```

**Purpose**: Executes the full remote-plugin mutation smoke test from confirmation through analytics validation and final state restoration. It is the main destructive test path for install/uninstall analytics.

**Data flow**: Takes the Codex binary path, config overrides, target remote plugin id, confirmation flag, and optional capture-file path. It validates confirmation, chooses or creates a capture path, prepares the file, spawns and initializes a `CodexClient`, reads and validates the initial remote plugin state, runs the install/uninstall sequence, then attempts cleanup via `restore_uninstalled_state`. It prints progress, pretty-prints validated events on success, and returns `Ok(())` or propagates the most relevant failure depending on whether cleanup was clean, locally inconsistent, dirty, or unverifiable.

**Call relations**: This is invoked by the test client's command dispatch for the mutation smoke command. It orchestrates the whole flow by calling confirmation checks, capture-file setup helpers from the non-mutation smoke module, client spawning, plugin inspection, the mutation sequence, and cleanup/recovery printers when restoration is not clean.

*Call graph*: calls 10 internal fn (print_dirty_recovery, print_recovery_command, read_remote_plugin, require_confirmation, restore_uninstalled_state, run_mutation_sequence, spawn_client, validate_initial_plugin, prepare_capture_file, wait_until_capture_is_ready); called by 1 (run); 2 external calls (eprintln!, println!).


##### `run_cleanup`  (lines 116–154)

```
fn run_cleanup(
    codex_bin: &Path,
    config_overrides: &[String],
    remote_plugin_id: &str,
    confirmation: AccountMutationConfirmation,
) -> Result<()>
```

**Purpose**: Runs only the restoration logic needed to ensure a remote plugin is uninstalled, without capturing analytics or exercising install/uninstall transitions. It is intended as a recovery command after a dirty or interrupted smoke run.

**Data flow**: Accepts the Codex binary path, config overrides, remote plugin id, and confirmation. It verifies confirmation, appends overrides that disable analytics but enable plugin features, spawns a stdio `CodexClient`, initializes it, and calls `restore_uninstalled_state`. It prints a PASS message when the plugin is already or becomes uninstalled, otherwise emits categorized failure output and returns the cleanup error.

**Call relations**: This is called by the CLI cleanup subcommand rather than the main smoke path. It reuses `require_confirmation` and `restore_uninstalled_state`, and delegates dirty-state messaging to `print_dirty_recovery`.

*Call graph*: calls 4 internal fn (spawn_stdio, print_dirty_recovery, require_confirmation, restore_uninstalled_state); called by 1 (run); 2 external calls (eprintln!, println!).


##### `AccountMutationConfirmation::from_flag`  (lines 163–169)

```
fn from_flag(confirm_account_mutation: bool) -> Self
```

**Purpose**: Converts the raw CLI boolean into the explicit confirmation enum used by the mutation commands. It centralizes the mapping between a missing flag and a blocked destructive action.

**Data flow**: Consumes a `bool` and returns either `AccountMutationConfirmation::Confirmed` or `AccountMutationConfirmation::Missing`. It reads no external state and writes nothing.

**Call relations**: Used by higher-level command parsing before `run` or `run_cleanup` are entered, so those functions can enforce confirmation through a typed value instead of a bare boolean.

*Call graph*: called by 1 (run).


##### `require_confirmation`  (lines 172–179)

```
fn require_confirmation(confirmation: AccountMutationConfirmation) -> Result<()>
```

**Purpose**: Rejects execution unless the caller explicitly acknowledged that the command mutates the active account by installing and uninstalling a plugin. Its error message explains the required rerun flag.

**Data flow**: Takes an `AccountMutationConfirmation`; if it is `Missing`, it returns an `anyhow` error via `bail!`, otherwise returns `Ok(())`. It has no side effects beyond the returned error.

**Call relations**: Called at the start of both `run` and `run_cleanup` so neither path can proceed to account mutation without explicit user confirmation.

*Call graph*: called by 2 (run, run_cleanup); 2 external calls (bail!, matches!).


##### `ExpectedInstalledState::is_installed`  (lines 188–190)

```
fn is_installed(self) -> bool
```

**Purpose**: Maps the internal expected-state enum to the boolean `installed` flag returned by plugin reads. It keeps polling logic readable by avoiding repeated pattern matches.

**Data flow**: Consumes `ExpectedInstalledState` and returns `true` for `Installed` and `false` for `Uninstalled`. It reads no external state.

**Call relations**: Used only inside `wait_for_installed_state` to compare the polled plugin summary against the desired terminal state.

*Call graph*: called by 1 (wait_for_installed_state); 1 external calls (matches!).


##### `spawn_client`  (lines 193–209)

```
fn spawn_client(
    codex_bin: &Path,
    config_overrides: &[String],
    capture_path: &Path,
) -> Result<CodexClient>
```

**Purpose**: Builds the child-process configuration for the mutation smoke test and launches a `CodexClient` with analytics capture enabled. It ensures the required feature flags are always present regardless of caller overrides.

**Data flow**: Receives the Codex binary path, caller-supplied config overrides, and capture-file path. It clones and extends the overrides with `analytics.enabled=true`, `features.plugins=true`, and `features.remote_plugin=true`, constructs an environment vector containing `CODEX_ANALYTICS_EVENTS_CAPTURE_FILE`, and returns the spawned `CodexClient` from `spawn_stdio_with_env`.

**Call relations**: Called only by `run` during setup. It is the mutation-test-specific counterpart to the simpler client spawn used by `run_cleanup`.

*Call graph*: calls 1 internal fn (spawn_stdio_with_env); called by 1 (run); 1 external calls (vec!).


##### `read_remote_plugin`  (lines 222–257)

```
fn read_remote_plugin(
    client: &mut CodexClient,
    remote_plugin_id: &str,
) -> Result<RemotePluginExpectation>
```

**Purpose**: Fetches a single remote plugin via the app-server `plugin/read` RPC and normalizes the response into a local expectation struct. It also verifies that the returned remote id matches the requested plugin id.

**Data flow**: Takes a mutable `CodexClient` and the requested remote plugin id. It allocates a request id, sends `ClientRequest::PluginRead` with `remote_marketplace_name` fixed to `openai-curated-remote` and `plugin_name` set to the requested id, extracts the plugin summary and marketplace name, requires a non-`None` `remote_plugin_id`, checks equality with the requested id, and returns a populated `RemotePluginExpectation`.

**Call relations**: Used by `run` for the initial precondition check, by `wait_for_installed_state` for polling, and by `restore_uninstalled_state` to determine whether cleanup is needed and whether final verification succeeded.

*Call graph*: calls 2 internal fn (request_id, send_request); called by 3 (restore_uninstalled_state, run, wait_for_installed_state); 1 external calls (bail!).


##### `validate_initial_plugin`  (lines 259–275)

```
fn validate_initial_plugin(plugin: &RemotePluginExpectation, remote_plugin_id: &str) -> Result<()>
```

**Purpose**: Enforces the preconditions that make the mutation smoke test safe and meaningful: the chosen remote plugin must start uninstalled and be available for installation. It prevents the test from mutating an already-installed account state.

**Data flow**: Consumes a `RemotePluginExpectation` reference and the target remote plugin id string. It inspects `installed`, `availability`, and `install_policy`, returning descriptive `bail!` errors for already-installed, unavailable, or non-installable plugins; otherwise it returns `Ok(())`.

**Call relations**: Called by `run` immediately after the initial `plugin/read`, before any install request is sent.

*Call graph*: called by 1 (run); 1 external calls (bail!).


##### `run_mutation_sequence`  (lines 282–338)

```
fn run_mutation_sequence(
    client: &mut CodexClient,
    capture_path: &Path,
    expected: &RemotePluginExpectation,
) -> MutationSequenceResult
```

**Purpose**: Performs the install/uninstall sequence and validates the captured analytics events for that mutation. It preserves whether uninstall failed at the RPC layer even if backend state eventually becomes uninstalled.

**Data flow**: Takes a mutable client, capture-file path, and expected plugin metadata. Inside an inner closure it installs the plugin, waits for installed state, waits for a `codex_plugin_installed` event, attempts uninstall while capturing any uninstall error, waits for uninstalled state with combined error context if both RPC and state verification fail, reads captured events for the remote plugin, validates them against `PluginEventIdentity`, and returns the validated event list. It wraps the result together with a boolean `uninstall_rpc_failed` in `MutationSequenceResult`.

**Call relations**: Called only by `run` after initial validation. Within the sequence it delegates to install/uninstall RPC helpers, state polling, capture polling, and shared analytics validation helpers from `plugin_analytics_capture`.

*Call graph*: called by 1 (run).


##### `install_remote_plugin`  (lines 340–355)

```
fn install_remote_plugin(client: &mut CodexClient, plugin: &RemotePluginExpectation) -> Result<()>
```

**Purpose**: Issues the `plugin/install` RPC for the selected remote plugin using the marketplace and remote id discovered from `plugin/read`. It treats any RPC failure as an immediate test failure.

**Data flow**: Accepts a mutable `CodexClient` and a `RemotePluginExpectation`. It generates a request id, sends `ClientRequest::PluginInstall` with `remote_marketplace_name` and `plugin_name` from the expectation, ignores the typed `PluginInstallResponse` payload, and returns `Ok(())` on success.

**Call relations**: Used inside `run_mutation_sequence` as the first mutating step before polling for installed state.

*Call graph*: calls 2 internal fn (request_id, send_request).


##### `uninstall_remote_plugin`  (lines 357–370)

```
fn uninstall_remote_plugin(client: &mut CodexClient, remote_plugin_id: &str) -> Result<()>
```

**Purpose**: Issues the `plugin/uninstall` RPC for the plugin identified by remote plugin id. In this test harness the remote id is passed as the uninstall `plugin_id` parameter.

**Data flow**: Takes a mutable `CodexClient` and a remote plugin id string, creates a request id, sends `ClientRequest::PluginUninstall` with `PluginUninstallParams { plugin_id }`, ignores the `PluginUninstallResponse`, and returns success or the RPC error.

**Call relations**: Called by `restore_uninstalled_state` during cleanup and by the mutation sequence when transitioning back to the uninstalled state.

*Call graph*: calls 2 internal fn (request_id, send_request); called by 1 (restore_uninstalled_state).


##### `wait_for_installed_state`  (lines 372–392)

```
fn wait_for_installed_state(
    client: &mut CodexClient,
    remote_plugin_id: &str,
    expected_state: ExpectedInstalledState,
) -> Result<RemotePluginExpectation>
```

**Purpose**: Polls `plugin/read` until the remote plugin's installed flag matches the expected installed/uninstalled state or a timeout expires. It tolerates transient read failures until the deadline.

**Data flow**: Receives a mutable client, remote plugin id, and `ExpectedInstalledState`. It computes a deadline from `STATE_TIMEOUT`, repeatedly calls `read_remote_plugin`, returns the plugin expectation once `plugin.installed` matches `expected_state.is_installed()`, suppresses intermittent read errors before the deadline, and otherwise returns either the last read error at deadline or a timeout error after sleeping `POLL_INTERVAL` between attempts.

**Call relations**: Used by both `run_mutation_sequence` and `restore_uninstalled_state` as the authoritative backend-state check after install or uninstall requests.

*Call graph*: calls 2 internal fn (is_installed, read_remote_plugin); called by 1 (restore_uninstalled_state); 3 external calls (now, bail!, sleep).


##### `restore_uninstalled_state`  (lines 401–433)

```
fn restore_uninstalled_state(
    client: &mut CodexClient,
    remote_plugin_id: &str,
) -> RestorationStatus
```

**Purpose**: Attempts to leave the target remote plugin uninstalled and classifies the cleanup outcome into clean, locally inconsistent, dirty, or unknown. It distinguishes backend state from RPC/reporting failures.

**Data flow**: Takes a mutable client and remote plugin id. It first reads current state; a read failure yields `Unknown`, an already-uninstalled plugin yields `Clean`. Otherwise it sends uninstall, then polls for the uninstalled state. If polling succeeds, uninstall RPC success maps to `Clean` and uninstall RPC failure maps to `LocalCleanupFailure`; if polling fails, it combines uninstall and verification errors when both exist and returns `Dirty`.

**Call relations**: Called by both `run` and `run_cleanup` after or instead of the mutation sequence. Its status drives the top-level result messaging and whether recovery commands are printed.

*Call graph*: calls 3 internal fn (read_remote_plugin, uninstall_remote_plugin, wait_for_installed_state); called by 2 (run, run_cleanup); 4 external calls (anyhow!, Dirty, LocalCleanupFailure, Unknown).


##### `wait_for_remote_plugin_event`  (lines 435–451)

```
fn wait_for_remote_plugin_event(
    path: &Path,
    remote_plugin_id: &str,
    event_type: &str,
) -> Result<()>
```

**Purpose**: Polls the analytics capture file until an event of a specific type appears for the target remote plugin. It acts as a synchronization barrier between backend mutation and later event validation.

**Data flow**: Accepts the capture-file path, remote plugin id, and desired event type string. It repeatedly reads plugin-specific events via `read_events_for_remote_plugin`, checks whether any event's `event_type` equals the requested type, and returns `Ok(())` on success or a timeout error after `CAPTURE_TIMEOUT`, sleeping `POLL_INTERVAL` between polls.

**Call relations**: Used inside `run_mutation_sequence` after installation to ensure the install analytics event has actually been captured before proceeding to uninstall and final validation.

*Call graph*: calls 1 internal fn (read_events_for_remote_plugin); 3 external calls (now, bail!, sleep).


##### `print_dirty_recovery`  (lines 453–463)

```
fn print_dirty_recovery(
    codex_bin: &Path,
    config_overrides: &[String],
    remote_plugin_id: &str,
    err: &anyhow::Error,
)
```

**Purpose**: Prints a high-signal dirty-state failure message and then emits a concrete recovery command the operator can run. It is reserved for cases where the plugin still appears installed after cleanup attempts.

**Data flow**: Takes the Codex binary path, config overrides, remote plugin id, and cleanup error. It writes a `FAIL-DIRTY` message to stderr including the formatted error, then delegates command construction and printing to `print_recovery_command`.

**Call relations**: Called by both `run` and `run_cleanup` when `restore_uninstalled_state` reports `Dirty`.

*Call graph*: calls 1 internal fn (print_recovery_command); called by 2 (run, run_cleanup); 1 external calls (eprintln!).


##### `print_recovery_command`  (lines 465–483)

```
fn print_recovery_command(codex_bin: &Path, config_overrides: &[String], remote_plugin_id: &str)
```

**Purpose**: Constructs and prints a shell-quoted invocation of the test client that will uninstall the remote plugin with confirmation. It gives operators an exact copy-paste remediation command.

**Data flow**: Receives the Codex binary path, config overrides, and remote plugin id. It resolves the current executable path if possible, shell-quotes the executable, Codex binary, each `--config` override, and the plugin id, appends the `plugin-remote-uninstall --confirm-account-mutation` subcommand, and prints the final command to stderr.

**Call relations**: Called directly by `run` for unknown final state and indirectly via `print_dirty_recovery` for dirty cleanup outcomes.

*Call graph*: called by 2 (print_dirty_recovery, run); 3 external calls (eprintln!, format!, current_exe).
