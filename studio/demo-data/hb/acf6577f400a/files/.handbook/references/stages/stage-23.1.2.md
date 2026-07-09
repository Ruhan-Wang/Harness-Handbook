# Daemon, transport, and test-client support tests  `stage-23.1.2`

This stage is the safety net around the app server’s background service, its communication pipes, and its special test client. It is shared behind-the-scenes support: it does not run the product itself, but it proves that startup, messaging, updates, and test-only tools behave correctly.

The daemon tests check the background server’s “PID file,” a small record saying which process is running. They cover starting, stopping, stale records, launch arguments, log reading, managed install version checks, and update decisions. One key rule is protected: if the updater program itself changes, that is more urgent than an ordinary version change.

The transport tests check how clients connect and receive messages. Unix-socket tests cover local WebSocket connections, socket-file protection, message forwarding, and avoiding double startup races. Other transport tests make sure messages go only to suitable clients and that one slow client cannot block the rest. Remote-control tests check pairing, client listing, revoking, refreshed authentication, and useful error details.

The test-client files provide a realistic command-line client, fake local HTTP service, and plugin analytics checks, including smoke tests for install, update, use, and removal events.

## Files in this stage

### Daemon backend and updater tests
These tests pin down daemon-side PID handling and managed-install/update identity decisions that govern backend launch and restart behavior.

### `app-server-daemon/src/backend/pid_tests.rs`

`test` · `test suite`

A PID file is a small file that records the process ID of a running background program. It works a bit like a coat-check ticket: other parts of the system can look at it to know whether the app server is already there. This test file protects the rules around that ticket.

The tests cover tricky cases where the PID file exists but is empty. An empty file can mean a server is still starting and has reserved the slot, or it can mean a previous startup died and left junk behind. The difference is decided by a lock file, which is a separate file used like a “do not enter” sign so two processes do not claim the same PID file at once.

The file also checks that stopping the daemon waits politely while a real startup reservation is still active, that stale records are cleaned up without deleting a newer replacement, and that launching the app server uses the right hidden subcommand, flags, and environment variable when remote control is enabled or disabled.

Finally, it tests reading the recent end of a stderr log. Stderr is where programs usually write errors. The test makes sure only recent, complete lines are returned, so users see useful diagnostics rather than a huge or chopped-up log.

#### Function details

##### `locked_empty_pid_file_is_treated_as_active_reservation`  (lines 18–43)

```
async fn locked_empty_pid_file_is_treated_as_active_reservation()
```

**Purpose**: This test proves that an empty PID file is not automatically treated as garbage. If its matching lock file is still locked, the backend should understand that another startup is in progress.

**Data flow**: The test creates a temporary directory, writes an empty PID file, builds a PidBackend, opens the lock file, and locks it. Then it asks the backend to read the PID-file state. The expected result is Starting, and the PID file should still exist afterward.

**Call relations**: The test runner calls this function during the async test suite. Inside the test, it relies on PidBackend::new to create the backend setup, try_lock_file to simulate an active reservation, and read_pid_file_state to make the decision being checked.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert!, assert_eq!, new, write).


##### `unlocked_empty_pid_file_is_treated_as_stale_reservation`  (lines 46–63)

```
async fn unlocked_empty_pid_file_is_treated_as_stale_reservation()
```

**Purpose**: This test checks the opposite case from a live reservation. If the PID file is empty and nobody holds the lock, the backend should treat it as a leftover from a failed start and clean it up.

**Data flow**: The test creates a temporary directory, writes an empty PID file, and builds a PidBackend. It does not lock the matching lock file. When it reads the PID-file state, the backend should return Missing and remove the stale empty PID file from disk.

**Call relations**: The test runner invokes this async test. It sets up the backend with PidBackend::new, then exercises read_pid_file_state to confirm that stale startup leftovers are removed rather than mistaken for a live daemon.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert!, assert_eq!, write).


##### `stop_waits_for_live_reservation_to_resolve`  (lines 66–95)

```
async fn stop_waits_for_live_reservation_to_resolve()
```

**Purpose**: This test makes sure stopping the daemon does not race against a startup that is still holding the PID lock. In plain terms, stop should wait until the “someone is starting” sign is taken down.

**Data flow**: The test creates an empty PID file, locks the matching lock file, and starts a small cleanup task. That cleanup task waits briefly, releases the lock, and removes the PID file. Meanwhile, the test calls backend.stop(). The expected outcome is that stop waits long enough and finishes successfully.

**Call relations**: The test runner starts this async test. The test uses PidBackend::new for setup, try_lock_file to create the live reservation, tokio::spawn to run delayed cleanup in parallel, and backend.stop to check that the stop path waits for the reservation to resolve.

*Call graph*: calls 1 internal fn (new); 8 external calls (from_millis, new, assert!, new, remove_file, write, spawn, sleep).


##### `start_retries_stale_empty_pid_file_under_its_own_lock`  (lines 98–115)

```
async fn start_retries_stale_empty_pid_file_under_its_own_lock()
```

**Purpose**: This test checks that starting the daemon can recover from an old empty PID file by taking its own lock and trying to launch anyway. It uses a deliberately missing executable so the launch fails for the expected reason after the stale file is dealt with.

**Data flow**: The test writes an empty PID file and creates a backend whose codex binary path points to something that does not exist. It calls backend.start(), expects an error, and checks that the error says the detached app-server process could not be spawned.

**Call relations**: The test runner calls this async test. PidBackend::new creates the backend, and backend.start is the behavior under test: it should get past the stale empty PID-file situation and then fail at the actual process-spawning step.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert!, write).


##### `stale_record_cleanup_preserves_replacement_record`  (lines 118–148)

```
async fn stale_record_cleanup_preserves_replacement_record()
```

**Purpose**: This test protects against deleting the wrong PID file. If the backend is cleaning up an old stale record but a newer record has already replaced it, the newer record must be kept.

**Data flow**: The test creates two PID records: an old stale one and a newer replacement. It writes the replacement record to the PID file, then asks the backend to refresh after seeing the stale record. The result should report that the replacement process is Running, and the replacement data should remain intact.

**Call relations**: The test runner invokes this async test. It uses PidBackend::new for setup, serializes the replacement PidRecord to disk, and calls refresh_after_stale_record to verify that cleanup is careful and checks what is currently in the file before removing anything.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert_eq!, to_vec, write).


##### `update_loop_uses_hidden_app_server_subcommand`  (lines 151–163)

```
fn update_loop_uses_hidden_app_server_subcommand()
```

**Purpose**: This test confirms that the special PID update loop is launched through the intended hidden app-server daemon subcommand. That matters because this helper is an internal maintenance process, not a normal user-facing command.

**Data flow**: The test builds a PidBackend value configured with PidCommandKind::UpdateLoop. It asks for command_args() and expects the argument list to be app-server daemon pid-update-loop.

**Call relations**: The regular test runner calls this synchronous test. It does not start a process; it only checks the command construction path that production code would later use when spawning the update-loop helper.

*Call graph*: 1 external calls (assert_eq!).


##### `app_server_remote_control_uses_runtime_flag`  (lines 166–177)

```
fn app_server_remote_control_uses_runtime_flag()
```

**Purpose**: This test checks that when remote control is enabled, the app server is launched with the command-line flag that turns it on. Remote control here means the server listens for control messages from another process.

**Data flow**: The test creates a PidBackend with remote_control_enabled set to true. It asks for command_args() and expects arguments that include --remote-control plus the Unix-socket listen address.

**Call relations**: The test runner invokes this synchronous test. It uses PidBackend::new to build the same kind of backend production code would use, then checks command_args before any process is actually spawned.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `app_server_disabled_remote_control_uses_compatible_args_and_runtime_env`  (lines 180–195)

```
fn app_server_disabled_remote_control_uses_compatible_args_and_runtime_env()
```

**Purpose**: This test checks the launch settings when remote control is disabled. The command-line stays compatible, and an environment variable is used to tell the runtime that remote control should be off.

**Data flow**: The test creates a PidBackend with remote_control_enabled set to false. It checks that command_args() omits --remote-control but still includes the Unix-socket listen option, and that command_env() returns the remote-control-disabled environment variable set to 1.

**Call relations**: The test runner calls this synchronous test. PidBackend::new supplies the backend configuration, while command_args and command_env show what would be handed to the process launcher in real daemon startup.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `read_stderr_log_tail_returns_recent_complete_lines`  (lines 198–216)

```
async fn read_stderr_log_tail_returns_recent_complete_lines()
```

**Purpose**: This test makes sure diagnostic log reading returns useful recent error text instead of a huge log or a cut-off partial line. It protects the behavior users rely on when startup fails and the system shows the last stderr output.

**Data flow**: The test creates a temporary PID-file path, derives the matching stderr log path, and writes a log that starts with a very long old line followed by two recent lines. It then reads the log tail. The expected result is the log path plus only the recent complete lines, "recent error\nusage".

**Call relations**: The async test runner invokes this test. It uses stderr_log_file_for_pid_file to find where the log should live, writes test contents there, and calls read_stderr_log_tail to confirm the diagnostic trimming behavior.

*Call graph*: 5 external calls (new, assert_eq!, format!, stderr_log_file_for_pid_file, write).


### `app-server-daemon/src/managed_install_tests.rs`

`test` · `test run`

This is a test file, not production code. Its job is to protect a few important assumptions used when the daemon works with a managed Codex executable. One helper reads the output of a command like `codex 1.2.3` and extracts just the version number. These tests make sure the expected format is accepted and an incomplete format is treated as an error, rather than being quietly misunderstood. Another helper creates an identity for an executable from its raw bytes. In everyday terms, this is like giving a file a fingerprint based on what is inside it. If the bytes are the same, the fingerprint should be the same. If the bytes differ, the fingerprint should differ. These checks matter because installation and update logic often depends on knowing exactly which version or binary it is dealing with. Without tests like these, a small parsing mistake or a weak identity check could make the daemon trust the wrong executable or miss that an executable has changed.

#### Function details

##### `parses_codex_cli_version_output`  (lines 7–12)

```
fn parses_codex_cli_version_output()
```

**Purpose**: This test proves that normal Codex CLI version output can be turned into a plain version string. It uses a sample line, `codex 1.2.3`, and expects the parser to return `1.2.3`.

**Data flow**: The test starts with a text string that looks like command-line version output. It sends that text into the version parsing helper, then compares the result with the expected version number. The outcome is pass if the extracted value matches, and fail if it does not.

**Call relations**: During the test run, this function acts as a safety check around the version parsing behavior. It finishes by using an equality assertion to confirm that the parser’s answer is exactly what the rest of the daemon would rely on.

*Call graph*: 1 external calls (assert_eq!).


##### `rejects_malformed_codex_cli_version_output`  (lines 15–17)

```
fn rejects_malformed_codex_cli_version_output()
```

**Purpose**: This test makes sure incomplete Codex CLI version output is treated as invalid. It protects the daemon from accepting `codex` by itself as if it contained a usable version.

**Data flow**: The test starts with malformed text that is missing the version number. It passes that text to the parser and then checks that the parser reports an error. The result is pass if an error is produced, and fail if the bad text is accepted.

**Call relations**: During the test run, this function covers the failure path for version parsing. It uses an assertion to make sure the parser does not silently accept input that the managed install flow should not trust.

*Call graph*: 1 external calls (assert!).


##### `executable_identity_uses_binary_contents`  (lines 20–27)

```
fn executable_identity_uses_binary_contents()
```

**Purpose**: This test checks that an executable’s identity is based on its actual bytes. The same bytes should give the same identity, while different bytes should give a different identity.

**Data flow**: The test creates identities from three byte sequences: `old`, `old` again, and `new`. It compares the two identities made from the same bytes and expects them to match. Then it compares the identity from `old` with the one from `new` and expects them to differ.

**Call relations**: During the test run, this function directly calls the executable identity helper to verify its core promise. It then uses equality and inequality assertions to show that the helper behaves like a content fingerprint, which is important when update code needs to notice whether a binary has changed.

*Call graph*: 3 external calls (assert_eq!, assert_ne!, executable_identity_from_bytes).


### `app-server-daemon/src/update_loop_tests.rs`

`test` · `test run`

This is a small test file for the update loop logic. The daemon compares the identity of the updater it is currently using with the identity of a newer or candidate updater. An executable identity is like a fingerprint made from the binary's bytes: if the bytes are the same, the fingerprint is the same; if the bytes differ, the program knows the binary really changed.

The tests check two important cases. First, when the updater identity has not changed, the daemon should not force a special refresh. It can use the ordinary version-based restart rule, meaning it only restarts if the app version changed. Second, when the updater identity has changed, the daemon must be more cautious. Even if version numbers happen to look the same, the actual updater program is different, so the daemon should always restart and re-execute the managed binary if needed.

Without these tests, a future code change could accidentally make the daemon ignore a changed updater. That could leave the system running old update code, which is risky because the updater is the part responsible for applying future fixes.

#### Function details

##### `unchanged_updater_uses_version_based_restart`  (lines 9–17)

```
fn unchanged_updater_uses_version_based_restart()
```

**Purpose**: This test checks the calm path: when the old and new updater binaries have the same identity, the daemon should not force an updater refresh. It should rely on the normal rule of restarting only when the version changes.

**Data flow**: It starts with two executable identities made from the same bytes, so they represent the same binary. Those identities are passed into the update-mode decision logic, and the test expects the result to be a version-based restart mode plus no updater refresh. If the result differs, the assertion fails and the test reports that the behavior changed.

**Call relations**: During the test run, the test framework calls this function. The function asks the update decision logic what should happen for two matching identities, then uses the assertion macro to compare the actual answer with the expected safe answer.

*Call graph*: 1 external calls (assert_eq!).


##### `changed_updater_forces_refresh_even_when_version_may_match`  (lines 20–31)

```
fn changed_updater_forces_refresh_even_when_version_may_match()
```

**Purpose**: This test checks the cautious path: when the updater binary identity changes, the daemon should force a stronger restart and refresh behavior. This matters because byte-level changes can be important even when a version number might not clearly show them.

**Data flow**: It starts with two executable identities made from different bytes, so they represent different binaries. Those identities are fed to the update-mode decision logic, and the test expects an always-restart choice together with a refresh mode that re-executes if the managed binary changed. If the decision logic gives anything else, the assertion fails.

**Call relations**: During the test run, the test framework calls this function after discovering it as a test. The function exercises the update decision logic for mismatched identities and hands the result to the assertion macro, which verifies that the daemon would take the safer refresh path.

*Call graph*: 1 external calls (assert_eq!).


### Transport behavior tests
These files exercise the server and transport layers from local socket mechanics up through routing rules and remote-control APIs.

### `app-server-transport/src/transport/unix_socket_tests.rs`

`test` · `test run`

This is a test file, not production code. It acts like a careful outside inspector for the app server’s local control connection. The app server can listen on a Unix socket, which is a file-like connection point on the same machine. These tests make sure that setup works from the first URL parsing step through to a real WebSocket conversation.

The smaller tests check that listen URLs such as `unix://`, `unix:///tmp/codex.sock`, and `unix://codex.sock` become the expected transport settings. The larger async test creates a temporary socket, starts the control socket acceptor, connects a fake client, upgrades that connection to WebSocket, sends a JSON-RPC notification, and checks that the server reports the right transport events. It also checks WebSocket ping/pong behavior and confirms cleanup after shutdown.

Another test checks the startup lock. That lock is like a bathroom key: only one server startup may hold it at a time, and the next waiter must pause until it is dropped. On Unix, one more test confirms the socket file is private, so other users cannot casually access it. Temporary directories keep these tests isolated from a developer’s real machine state.

#### Function details

##### `listen_unix_socket_parses_as_unix_socket_transport`  (lines 26–33)

```
fn listen_unix_socket_parses_as_unix_socket_transport()
```

**Purpose**: This test checks the simplest Unix-socket listen URL, `unix://`. It proves that the transport parser treats it as a request to use the default app server control socket path.

**Data flow**: It starts with the text URL `unix://`. The parser turns that text into an `AppServerTransport` value, and the test compares the result with the expected Unix socket transport using the default socket path.

**Call relations**: This is an early guard around URL parsing. It relies on the same parsing code used when the server is configured to listen, and it uses an assertion to stop the test if the parsed transport is not exactly what callers expect.

*Call graph*: 1 external calls (assert_eq!).


##### `listen_unix_socket_accepts_absolute_custom_path`  (lines 36–43)

```
fn listen_unix_socket_accepts_absolute_custom_path()
```

**Purpose**: This test checks that a Unix-socket listen URL may name a full filesystem path. It matters because users or callers may want the control socket somewhere other than the default location.

**Data flow**: It gives the parser `unix:///tmp/codex.sock`. The parser should keep `/tmp/codex.sock` as an absolute path, and the test compares that result with an explicitly built absolute path value.

**Call relations**: This supports the transport setup path by verifying one accepted form of configuration input. It uses the helper `absolute_path` indirectly through the expected value construction and then asserts that parser output matches.

*Call graph*: 1 external calls (assert_eq!).


##### `listen_unix_socket_accepts_relative_custom_path`  (lines 46–54)

```
fn listen_unix_socket_accepts_relative_custom_path()
```

**Purpose**: This test checks that a Unix-socket listen URL may name a relative path, such as `codex.sock`. That lets callers give a short path and have it resolved against the current working directory.

**Data flow**: It starts with `unix://codex.sock`. The parser resolves the relative path into an absolute-path wrapper, and the test compares that against the same path resolved from the current directory.

**Call relations**: This is another URL parsing safety check. It exercises the same public parser used by real setup code and confirms that relative paths are not rejected or misread.

*Call graph*: 1 external calls (assert_eq!).


##### `control_socket_acceptor_upgrades_and_forwards_websocket_text_messages_and_pings`  (lines 57–142)

```
async fn control_socket_acceptor_upgrades_and_forwards_websocket_text_messages_and_pings()
```

**Purpose**: This end-to-end async test proves that the control socket acceptor can accept a local client, turn the raw socket connection into a WebSocket connection, forward JSON-RPC text messages as transport events, answer WebSocket pings, and shut down cleanly.

**Data flow**: It creates a temporary socket path, starts the acceptor with a channel for transport events, and connects a fake client to that socket. The client performs a WebSocket upgrade, sends a JSON-RPC notification as text, sends a ping, then closes. The test reads the event channel and WebSocket replies to confirm the server reports connection opened, incoming message, pong reply, and connection closed. Finally it cancels shutdown, waits for the acceptor task to finish, and checks that the socket path was removed where that applies.

**Call relations**: This test ties many pieces together. It calls `test_socket_path` to create a safe throwaway socket location, `connect_to_socket` to behave like a client, and `assert_socket_path_removed` after shutdown. It drives `start_control_socket_acceptor`, then watches the `TransportEvent` stream to make sure production code hands each important client action to the rest of the app server.

*Call graph*: calls 3 internal fn (assert_socket_path_removed, connect_to_socket, test_socket_path); 14 external calls (from_static, new, from_secs, Ping, Text, Notification, assert!, assert_eq!, panic!, to_string (+4 more)).


##### `app_server_startup_lock_serializes_waiters`  (lines 145–164)

```
async fn app_server_startup_lock_serializes_waiters()
```

**Purpose**: This test checks that the app server startup lock allows only one holder at a time. Without that, two app server startups could both believe they are in charge of creating or owning the same control socket.

**Data flow**: It builds a temporary lock-file path and acquires the first lock. Then it starts a second async task that tries to acquire the same lock. The second task should not finish while the first lock is still held. After the first lock is dropped, the second acquisition is allowed to complete.

**Call relations**: This test focuses on `acquire_app_server_startup_lock`. It uses `test_startup_lock_path` for an isolated lock location, then uses a short timeout to prove the second waiter is blocked until the first holder releases the lock.

*Call graph*: calls 1 internal fn (test_startup_lock_path); 4 external calls (assert!, acquire_app_server_startup_lock, new, spawn).


##### `control_socket_file_is_private_after_bind`  (lines 168–191)

```
async fn control_socket_file_is_private_after_bind()
```

**Purpose**: This Unix-only test checks that the socket file created by the control socket acceptor has private permissions. In plain terms, it should not be readable or writable by other users on the machine.

**Data flow**: It creates a temporary socket path, starts the control socket acceptor, reads the filesystem metadata for the socket path, and checks the permission bits. The expected mode is `0600`, meaning only the owner has access. Then it cancels the acceptor and waits for it to stop.

**Call relations**: This test calls `test_socket_path` to avoid touching real app files and `start_control_socket_acceptor` to create an actual socket. It then inspects the file that production code created, confirming a security property right after bind time.

*Call graph*: calls 1 internal fn (test_socket_path); 5 external calls (new, assert_eq!, start_control_socket_acceptor, new, metadata).


##### `absolute_path`  (lines 193–195)

```
fn absolute_path(path: &str) -> AbsolutePathBuf
```

**Purpose**: This small helper turns a string that should already be an absolute filesystem path into the project’s absolute-path type. It keeps the URL parsing tests concise and explicit.

**Data flow**: It receives path text such as `/tmp/codex.sock`. It asks `AbsolutePathBuf` to validate and wrap that path as absolute, and returns the wrapped path. If the input is not acceptable, the test fails immediately.

**Call relations**: It supports the parsing tests by building the expected value for comparisons. Instead of each test repeating the path-conversion call, this helper gives them a clear one-line way to say, 'this should be an absolute path.'

*Call graph*: calls 1 internal fn (from_absolute_path).


##### `default_control_socket_path`  (lines 197–200)

```
fn default_control_socket_path() -> AbsolutePathBuf
```

**Purpose**: This helper computes the default app server control socket path used when a listen URL does not specify one. It lets tests compare parser output against the same default location the app server would normally use.

**Data flow**: It first finds the Codex home directory, which is the project’s user-specific storage location. It then asks the transport code to build the app server control socket path under that home directory and returns the resulting absolute path.

**Call relations**: It is used by the default URL parsing test. The helper connects configuration discovery, through `find_codex_home`, with transport path construction, through `app_server_control_socket_path`, so the expected test value follows the real app logic.

*Call graph*: calls 1 internal fn (find_codex_home); 1 external calls (app_server_control_socket_path).


##### `test_socket_path`  (lines 202–209)

```
fn test_socket_path(temp_dir: &Path) -> AbsolutePathBuf
```

**Purpose**: This helper creates a throwaway control-socket path inside a temporary directory. It prevents tests from touching a real user’s app server socket.

**Data flow**: It receives the temporary directory path. It appends `app-server-control/app-server-control.sock`, converts the result into the project’s absolute-path type, and returns it. If the path cannot be represented as absolute, the test fails.

**Call relations**: The WebSocket end-to-end test and the Unix permissions test both call this before starting the control socket acceptor. It gives those tests a safe, predictable socket location that disappears with the temporary directory.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 2 (control_socket_acceptor_upgrades_and_forwards_websocket_text_messages_and_pings, control_socket_file_is_private_after_bind); 1 external calls (join).


##### `test_startup_lock_path`  (lines 211–218)

```
fn test_startup_lock_path(temp_dir: &Path) -> AbsolutePathBuf
```

**Purpose**: This helper creates a throwaway startup-lock path inside a temporary directory. It lets the lock test run without interfering with any real app server process.

**Data flow**: It receives a temporary directory path. It appends `app-server-control/app-server-startup.lock`, wraps that full path as an absolute path, and returns it. If conversion fails, the test stops with an error.

**Call relations**: The startup-lock test calls this before trying to acquire the lock twice. It supplies the isolated file path that `acquire_app_server_startup_lock` uses to prove waiters are serialized.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 1 (app_server_startup_lock_serializes_waiters); 1 external calls (join).


##### `connect_to_socket`  (lines 220–222)

```
async fn connect_to_socket(socket_path: &Path) -> IoResult<UnixStream>
```

**Purpose**: This helper opens a client connection to the Unix socket under test. It keeps the larger WebSocket test focused on behavior rather than connection boilerplate.

**Data flow**: It receives a socket filesystem path. It asks `UnixStream` to connect to that path asynchronously and returns either the connected stream or an input/output error.

**Call relations**: The end-to-end control socket test calls this after starting the acceptor. The returned stream is then handed to the WebSocket client code so the test can act like a real app server client.

*Call graph*: calls 1 internal fn (connect); called by 1 (control_socket_acceptor_upgrades_and_forwards_websocket_text_messages_and_pings).


##### `assert_socket_path_removed`  (lines 230–233)

```
fn assert_socket_path_removed(_socket_path: &Path)
```

**Purpose**: This helper checks that the socket path is gone after the acceptor shuts down. On Unix, that cleanup matters because stale socket files can block future server starts or confuse clients.

**Data flow**: It receives the socket path that was used by the test. On Unix, it checks the filesystem and fails the test if the path still exists. On Windows, the companion version does nothing because the Windows Unix-domain-socket implementation uses the path differently and there is no Unix socket filesystem node to verify.

**Call relations**: The end-to-end control socket test calls this after cancelling and joining the acceptor. It is the final cleanup check in the story: start a socket, use it, shut it down, and make sure no stale Unix socket file is left behind.

*Call graph*: called by 1 (control_socket_acceptor_upgrades_and_forwards_websocket_text_messages_and_pings); 1 external calls (assert!).


### `app-server/src/transport_tests.rs`

`test` · `test suite`

The app server has to send messages to connected clients. Some clients opt out of certain notifications, and some do not support newer experimental features. This test file checks that the transport layer respects those client differences before putting messages onto each client's outgoing queue.

Think of the transport as a mailroom. Each client has a mailbox. Before dropping in a letter, the mailroom checks whether that client asked not to receive that type of letter, and whether the client understands the newer kind of letter. These tests build small fake connection maps, send sample outgoing envelopes through `route_outgoing_envelope`, and then inspect the receiving side of the channel to see what actually arrived.

The file also tests back-pressure, which means what happens when a client's outgoing queue is full. For broadcasts, a full queue should not freeze the whole server; the slow connection is removed and disconnected so fast clients still get their messages. For direct standard I/O style sends, the server should wait for space instead of immediately disconnecting. The tests use Tokio asynchronous channels and short timeouts to prove these timing-sensitive behaviors without depending on real network connections.

#### Function details

##### `absolute_path`  (lines 13–15)

```
fn absolute_path(path: &str) -> AbsolutePathBuf
```

**Purpose**: This small helper turns a text path into the project's absolute-path type. Tests use it when they need realistic file-system paths inside request data.

**Data flow**: It receives a string such as `/tmp`, asks `from_absolute_path` to validate and convert it, and returns an `AbsolutePathBuf`. If the test accidentally gives it a non-absolute path, it fails immediately with the message `absolute path`.

**Call relations**: The command-approval tests call this helper while building request parameters that include a current working directory and extra readable paths. It keeps those tests focused on transport behavior instead of repeating path-conversion setup.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 2 (command_execution_request_approval_keeps_additional_permissions_with_capability, command_execution_request_approval_strips_additional_permissions_without_capability).


##### `thread_realtime_started_notification`  (lines 17–23)

```
fn thread_realtime_started_notification() -> ServerNotification
```

**Purpose**: This helper builds a sample experimental realtime-started notification. Tests use it to check whether clients without the needed capability are protected from messages they may not understand.

**Data flow**: It takes no input, fills in a fixed thread id, no realtime session id, and realtime conversation version `V1`, then returns it wrapped as a `ServerNotification::ThreadRealtimeStarted` value.

**Call relations**: The two experimental-notification tests call this helper before routing the notification to a connection. The helper supplies the test message; `route_outgoing_envelope` then decides whether that message should be delivered or dropped based on the connection capability flag.

*Call graph*: called by 2 (experimental_notifications_are_dropped_without_capability, experimental_notifications_are_preserved_with_capability); 1 external calls (ThreadRealtimeStarted).


##### `to_connection_notification_respects_opt_out_filters`  (lines 26–66)

```
async fn to_connection_notification_respects_opt_out_filters()
```

**Purpose**: This test proves that a notification sent to one specific connection is dropped when that connection has opted out of that notification method. Without this behavior, clients could receive noisy or unwanted messages they explicitly disabled.

**Data flow**: The test creates one fake initialized connection whose opt-out set contains `configWarning`. It routes a `ConfigWarning` notification to that connection, then checks the writer channel and expects nothing to be there.

**Call relations**: This test constructs an `OutboundConnectionState`, passes it to `route_outgoing_envelope`, and observes the channel that would normally feed the connection writer. The route function is the unit under test: it sees the opt-out filter and does not hand the message onward.

*Call graph*: calls 1 internal fn (new); 9 external calls (new, new, new, from, new, ConfigWarning, AppServerNotification, assert!, channel).


##### `to_connection_notifications_are_dropped_for_opted_out_clients`  (lines 69–106)

```
async fn to_connection_notifications_are_dropped_for_opted_out_clients()
```

**Purpose**: This test checks the same real-world rule from the client's point of view: if a client opted out of `configWarning`, that client should not receive `ConfigWarning` notifications.

**Data flow**: It starts with a fake connection whose blocked notification list contains `configWarning`. After routing a config-warning message to that connection, the receiving side of the channel is still empty, showing that the message was filtered out.

**Call relations**: The test sets up connection state and calls `route_outgoing_envelope` with a direct-to-connection envelope. The routing code performs the filter check before it would normally queue the message for writing.

*Call graph*: calls 1 internal fn (new); 9 external calls (new, new, new, from, new, ConfigWarning, AppServerNotification, assert!, channel).


##### `to_connection_notifications_are_preserved_for_non_opted_out_clients`  (lines 109–152)

```
async fn to_connection_notifications_are_preserved_for_non_opted_out_clients()
```

**Purpose**: This test proves the positive case: clients that have not opted out still receive normal notifications. It protects against a filter that is too broad and accidentally drops useful messages.

**Data flow**: The test creates one connection with an empty opt-out set, sends it a `ConfigWarning` notification, waits for a message to arrive on the writer channel, and checks that the received notification still has the expected summary text.

**Call relations**: After the test calls `route_outgoing_envelope`, the routing code should pass the message to the connection's outgoing queue. The test then reads that queue to confirm the message was preserved rather than filtered.

*Call graph*: calls 1 internal fn (new); 9 external calls (new, new, new, new, new, ConfigWarning, AppServerNotification, assert!, channel).


##### `experimental_notifications_are_dropped_without_capability`  (lines 155–185)

```
async fn experimental_notifications_are_dropped_without_capability()
```

**Purpose**: This test makes sure experimental realtime notifications are not sent to clients that did not say they support experimental features. That avoids breaking older clients with message shapes they may not recognize.

**Data flow**: The test creates a connection with its experimental-capability flag set to false. It builds a realtime-started notification, routes it to the connection, and then verifies that the writer channel remains empty.

**Call relations**: It uses `thread_realtime_started_notification` to create the sample experimental message, then gives that message to `route_outgoing_envelope`. The routing code notices the missing capability and stops the message before it reaches the writer queue.

*Call graph*: calls 2 internal fn (new, thread_realtime_started_notification); 8 external calls (new, new, new, new, new, AppServerNotification, assert!, channel).


##### `experimental_notifications_are_preserved_with_capability`  (lines 188–222)

```
async fn experimental_notifications_are_preserved_with_capability()
```

**Purpose**: This test checks that experimental realtime notifications do get through when a client has advertised the needed capability. It prevents the compatibility gate from blocking capable clients unnecessarily.

**Data flow**: The test creates a connection whose experimental-capability flag is true. It routes a realtime-started notification and then reads the writer channel, expecting to receive a `ThreadRealtimeStarted` notification.

**Call relations**: The helper `thread_realtime_started_notification` supplies the message. `route_outgoing_envelope` checks the connection's capability flag and, because it is enabled, forwards the message into the outgoing queue where the test can read it.

*Call graph*: calls 2 internal fn (new, thread_realtime_started_notification); 8 external calls (new, new, new, new, new, AppServerNotification, assert!, channel).


##### `command_execution_request_approval_strips_additional_permissions_without_capability`  (lines 225–287)

```
async fn command_execution_request_approval_strips_additional_permissions_without_capability()
```

**Purpose**: This test verifies backward compatibility for command-approval requests. If a client does not support the newer `additionalPermissions` field, the server removes that field before sending the request.

**Data flow**: The test builds a command-execution approval request that includes extra file-system read permission details. It sends that request to a connection without the experimental capability, reads the delivered message, serializes it to JSON, and confirms that `additionalPermissions` is absent.

**Call relations**: The test uses `absolute_path` while constructing the request's path values, then calls `route_outgoing_envelope`. The routing code still delivers the request, but edits the outgoing data first so the older client sees only fields it is expected to understand.

*Call graph*: calls 2 internal fn (new, absolute_path); 11 external calls (new, new, new, new, new, Integer, Request, assert_eq!, channel, to_value (+1 more)).


##### `command_execution_request_approval_keeps_additional_permissions_with_capability`  (lines 290–362)

```
async fn command_execution_request_approval_keeps_additional_permissions_with_capability()
```

**Purpose**: This test confirms that capable clients receive the full command-approval request, including the newer additional-permissions information. It protects useful permission details from being stripped for clients that can handle them.

**Data flow**: The test creates a command-approval request containing an extra readable path, sends it to a connection with the capability flag enabled, reads the outgoing message, turns it into JSON, and checks that the `additionalPermissions` object is still present with the expected path.

**Call relations**: Like the previous command-approval test, it uses `absolute_path` to build valid path fields and sends the request through `route_outgoing_envelope`. Because the connection has the required capability, routing forwards the richer request instead of trimming it.

*Call graph*: calls 2 internal fn (new, absolute_path); 11 external calls (new, new, new, new, new, Integer, Request, assert_eq!, channel, to_value (+1 more)).


##### `broadcast_does_not_block_on_slow_connection`  (lines 365–449)

```
async fn broadcast_does_not_block_on_slow_connection()
```

**Purpose**: This test proves that broadcasting a message to all clients does not get stuck behind one slow client whose queue is already full. Without this, one stalled connection could freeze notifications for everyone.

**Data flow**: The test creates a fast connection and a slow connection, then pre-fills the slow connection's one-message queue. It broadcasts a new notification with a short timeout, expects the call to finish quickly, checks that the slow connection was removed and its disconnect token was cancelled, and confirms the fast connection received the broadcast.

**Call relations**: The test feeds a broadcast envelope into `route_outgoing_envelope`. The routing code tries to queue the broadcast for each connection; when the slow one cannot accept it immediately, the code disconnects that connection rather than waiting, while still handing the message to the fast connection.

*Call graph*: calls 2 internal fn (new, new); 12 external calls (new, new, new, from_millis, new, new, new, ConfigWarning, AppServerNotification, assert! (+2 more)).


##### `to_connection_stdio_waits_instead_of_disconnecting_when_writer_queue_is_full`  (lines 452–524)

```
async fn to_connection_stdio_waits_instead_of_disconnecting_when_writer_queue_is_full()
```

**Purpose**: This test checks a different queue-full rule for direct sends: when sending to one connection in this path, the server should wait for room instead of dropping or disconnecting. This matters for reliable ordered delivery to that client.

**Data flow**: The test fills a connection's one-message queue with a first notification, starts routing a second notification in a background task, then drains the first message. Once space is available, the routing task completes and the second message appears in the queue.

**Call relations**: The test calls `route_outgoing_envelope` from a spawned asynchronous task so it can observe that routing waits while the queue is full. After the test reads the already queued message, the route function can finish sending the second one, proving this direct-send path behaves differently from broadcast.

*Call graph*: calls 2 internal fn (new, new); 12 external calls (new, new, from_millis, new, new, new, ConfigWarning, AppServerNotification, assert!, channel (+2 more)).


### `app-server-transport/src/transport/remote_control/tests/clients_tests.rs`

`test` · `test suite`

This is a test file for the part of the app server that talks to the remote-control backend about client devices. A “client” here means another device or app enrolled for remote control, such as a phone. The tests create a tiny local HTTP server instead of using the real backend, like setting up a pretend cashier to check what the app asks for and what it does with the reply.

The file verifies several important promises. First, listing and revoking clients must work even when the broader remote-control connection is disabled. That matters because client management is an account operation, not the same as keeping a live remote-control session open. Second, listing clients must include the right authentication token and account header, encode unusual characters safely in URLs, and translate the backend’s JSON response into the simpler protocol response used by the app. Third, if the backend says a token is unauthorized, the code should reload saved credentials and try once more, but not loop forever. Finally, the tests make sure forbidden responses and malformed JSON produce helpful errors, including status codes, request identifiers, and response bodies. Without these checks, users could see silent failures or vague errors when managing their remote-control devices.

#### Function details

##### `client_management_handle`  (lines 13–37)

```
fn client_management_handle(
    remote_control_url: String,
    auth_manager: Arc<AuthManager>,
) -> RemoteControlHandle
```

**Purpose**: This helper builds a RemoteControlHandle that is suitable for client-management tests. It deliberately starts with remote control disabled, so tests can prove that listing or revoking clients does not require an active remote-control connection.

**Data flow**: It receives a remote-control server URL and an authentication manager. It creates the internal channels, locks, status values, and enrollment state that a RemoteControlHandle normally needs, then returns a ready-to-use handle pointed at the test server.

**Call relations**: The two handle-level tests call this helper before using list_clients or revoke_client. Inside, it creates fresh synchronization pieces such as watch channels and semaphores so each test gets an isolated handle instead of sharing state with other tests.

*Call graph*: calls 1 internal fn (new); called by 2 (remote_control_handle_lists_clients_while_disabled, remote_control_handle_revokes_client_while_disabled); 3 external calls (new, new, channel).


##### `empty_client_list`  (lines 39–44)

```
fn empty_client_list() -> serde_json::Value
```

**Purpose**: This small helper creates the JSON shape for a successful response with no remote-control clients. It keeps repeated test setup short and makes the intended backend reply obvious.

**Data flow**: It takes no input. It builds a JSON value containing an empty items list and a null cursor, then returns that value for the fake server to send.

**Call relations**: The authentication-recovery test uses this helper after the simulated backend accepts the refreshed token. It hands the JSON to the response helper so list_remote_control_clients can parse it as a normal empty result.

*Call graph*: called by 1 (list_remote_control_clients_recovers_auth_after_unauthorized); 1 external calls (json!).


##### `remote_control_handle_lists_clients_while_disabled`  (lines 47–116)

```
async fn remote_control_handle_lists_clients_while_disabled()
```

**Purpose**: This test proves that RemoteControlHandle can list remote-control clients even when the remote-control feature itself is currently disabled. It also checks the exact URL, query string, authorization header, account header, and parsed response.

**Data flow**: The test starts a local TCP listener, builds a RemoteControlHandle pointing at it, and calls list_clients with an environment id, cursor, limit, and sort order. The fake server receives the request, checks that spaces and special characters were safely encoded, returns one client as JSON, and the test verifies that the final response contains the expected client fields and next cursor.

**Call relations**: The async test harness runs this function. It calls client_management_handle to build the disabled handle, uses a spawned server task to inspect the outgoing HTTP request, and relies on assertions to confirm that the request and decoded response match the expected remote-control client-list behavior.

*Call graph*: calls 1 internal fn (client_management_handle); 4 external calls (bind, assert_eq!, json!, spawn).


##### `remote_control_handle_revokes_client_while_disabled`  (lines 119–144)

```
async fn remote_control_handle_revokes_client_while_disabled()
```

**Purpose**: This test proves that RemoteControlHandle can revoke a remote-control client even while remote control is disabled. It checks that the client and environment identifiers are placed safely into the DELETE request path.

**Data flow**: The test starts a local listener, creates a disabled RemoteControlHandle, and calls revoke_client with an environment id and client id containing characters that need URL encoding. The fake server checks the DELETE request path, returns a 204 No Content response, and the test confirms that the revoke call returns the expected empty success response.

**Call relations**: The async test harness runs this function. It calls client_management_handle for the test handle and uses a spawned fake server to verify the outgoing request before the revoke call completes.

*Call graph*: calls 1 internal fn (client_management_handle); 3 external calls (bind, assert_eq!, spawn).


##### `list_remote_control_clients_recovers_auth_after_unauthorized`  (lines 147–222)

```
async fn list_remote_control_clients_recovers_auth_after_unauthorized()
```

**Purpose**: This test checks that listing clients can recover from an expired or stale access token. If the first request gets a 401 Unauthorized response, the code should reload saved credentials and retry with the fresh token.

**Data flow**: The test first saves credentials containing a stale token, creates an AuthManager from that saved state, then overwrites the saved credentials with a fresh token. The fake server rejects the first request after seeing the stale token, accepts the second request with the fresh token, and returns an empty list. The test confirms that the final result is a successful empty client list.

**Call relations**: The async test harness runs this function. It calls list_remote_control_clients directly, while the fake server task checks the before-and-after authentication headers. It uses empty_client_list to provide the successful response after the retry.

*Call graph*: calls 4 internal fn (list_remote_control_clients, empty_client_list, default, shared); 5 external calls (default, bind, new, assert_eq!, spawn).


##### `list_remote_control_clients_retries_unauthorized_only_once`  (lines 225–300)

```
async fn list_remote_control_clients_retries_unauthorized_only_once()
```

**Purpose**: This test makes sure the client-list code does not retry forever when authorization keeps failing. It should refresh credentials and try once, then stop if the backend still returns 401 Unauthorized.

**Data flow**: The test saves stale credentials, creates an AuthManager, then saves fresh credentials for the retry. The fake server rejects both the stale-token request and the fresh-token request, then waits briefly to ensure no third request arrives. The list call returns an error, and the test checks that the error kind is PermissionDenied.

**Call relations**: The async test harness runs this function. It calls list_remote_control_clients directly and uses the spawned fake server to enforce the retry limit: one original request, one recovery request, and no more.

*Call graph*: calls 3 internal fn (list_remote_control_clients, default, shared); 6 external calls (default, bind, new, assert!, assert_eq!, spawn).


##### `revoke_remote_control_client_does_not_retry_forbidden`  (lines 303–338)

```
async fn revoke_remote_control_client_does_not_retry_forbidden()
```

**Purpose**: This test checks that revoking a client does not retry when the backend returns 403 Forbidden. Forbidden means the server understood the user but refuses the action, so refreshing the token is not expected to help.

**Data flow**: The test starts a fake server that responds to the revoke request with 403 Forbidden, including diagnostic headers and a body. The revoke call returns an error. The test verifies both that the error is classified as PermissionDenied and that its text includes the URL, HTTP status, request id, Cloudflare ray id, and response body.

**Call relations**: The async test harness runs this function. It calls revoke_remote_control_client directly, while a spawned fake server supplies the forbidden response. The assertions confirm that the revoke path reports the backend failure clearly instead of hiding useful context.

*Call graph*: calls 1 internal fn (revoke_remote_control_client); 3 external calls (bind, assert_eq!, spawn).


##### `list_remote_control_clients_preserves_decode_error_context`  (lines 341–371)

```
async fn list_remote_control_clients_preserves_decode_error_context()
```

**Purpose**: This test ensures that a malformed successful response produces an error with enough context to debug the problem. A 200 OK response is not useful if the body cannot be parsed as the expected JSON.

**Data flow**: The test starts a fake server that replies with HTTP 200 OK but sends an invalid JSON body consisting of just an opening brace. The list call fails while trying to decode the response. The test checks that the error message includes the response URL, status, body text, and the underlying decode error.

**Call relations**: The async test harness runs this function. It calls list_remote_control_clients directly and uses a spawned fake server to send the malformed response. The assertions make sure parsing failures keep the evidence needed to diagnose backend or protocol problems.

*Call graph*: calls 1 internal fn (list_remote_control_clients); 4 external calls (default, bind, assert!, spawn).


### `app-server-transport/src/transport/remote_control/tests/pairing_tests.rs`

`test` · `test execution`

Remote control pairing is the process that lets this app server connect itself to a remote controller. That process depends on several moving parts: a saved enrollment, a server token, the user’s login token, and backend endpoints for pairing, status checks, refresh, and enrollment. If any of those pieces are stale or wrong, the user needs either automatic recovery or a clear error message.

This test file acts like a rehearsal room for that flow. Each test starts a temporary local TCP listener, which is a tiny fake backend server. The code under test sends real HTTP requests to that listener. The test then inspects the request path, authorization header, and JSON body, and replies with carefully chosen success or failure responses.

The tests cover happy paths, such as returning a pending or claimed pairing status, and harder cases, such as expired server tokens, stale user login tokens, mismatched enrollment data, invalid timestamps, and backend errors with diagnostic headers. A key theme is preserving context: when something fails, the error should include the URL, HTTP status, request id, Cloudflare ray id, response body, and parsing problem when available. Without these tests, regressions could silently break pairing or hide the information needed to diagnose production failures.

#### Function details

##### `remote_control_enrollment`  (lines 8–25)

```
fn remote_control_enrollment(
    remote_control_url: &str,
    remote_control_token: &str,
) -> RemoteControlEnrollment
```

**Purpose**: Builds a ready-to-use test enrollment for a remote-control server. Tests use it as the saved identity of an app server before asking the backend to pair or check pairing status.

**Data flow**: It receives a remote-control URL and a server token. It normalizes the URL, fills in fixed test account, environment, server, and name values, stores the token, and sets a far-future expiry time. The result is a RemoteControlEnrollment value that other tests can call methods on.

**Call relations**: This is the common setup helper for several pairing and status tests. Error helpers and direct status tests call it first, then use the returned enrollment to start pairing or ask for pairing status against the fake backend.

*Call graph*: called by 6 (pairing_error, pairing_response_error, pairing_status_error, remote_control_pairing_status_accepts_manual_pairing_code, remote_control_pairing_status_returns_claimed, remote_control_pairing_status_returns_pending); 1 external calls (from_unix_timestamp).


##### `pairing_error`  (lines 27–52)

```
async fn pairing_error(status: &'static str, body: &'static str) -> (String, String)
```

**Purpose**: Creates a controlled backend failure for starting pairing and returns the resulting error text. It lets multiple tests check that pairing failures keep the right diagnostic details.

**Data flow**: It takes an HTTP status string and response body. It starts a local fake server, waits for the pairing request, replies with that status plus request-identifying headers, then runs start_pairing on a test enrollment. The output is the error message produced by the client and the expected pairing URL.

**Call relations**: The backend-error and decode-error tests call this helper instead of repeating the server setup. Inside, it relies on remote_control_enrollment to create the client-side enrollment and a spawned fake server task to provide the response.

*Call graph*: calls 1 internal fn (remote_control_enrollment); called by 2 (start_remote_control_pairing_preserves_backend_error_context, start_remote_control_pairing_preserves_decode_error_context); 2 external calls (bind, spawn).


##### `pairing_response_error`  (lines 54–70)

```
async fn pairing_response_error(body: serde_json::Value) -> String
```

**Purpose**: Tests pairing responses that are HTTP-successful but semantically wrong, such as mismatched server information or an invalid expiry timestamp. It returns the client’s error message for the caller to inspect.

**Data flow**: It receives a JSON value to use as the backend response. It starts a fake server, sends that JSON to the pairing request, then calls start_pairing on a test enrollment. Since the response is intentionally bad for the scenario, it returns the resulting error as text.

**Call relations**: Tests that care about bad pairing response contents call this helper. It uses remote_control_enrollment for the client setup and hands the supplied JSON through the fake HTTP response.

*Call graph*: calls 1 internal fn (remote_control_enrollment); called by 1 (start_remote_control_pairing_preserves_expiry_parse_error_context); 2 external calls (bind, spawn).


##### `pairing_status_error`  (lines 72–100)

```
async fn pairing_status_error(status: &'static str, body: &'static str) -> (io::Error, String)
```

**Purpose**: Creates a controlled backend failure for checking pairing status. It is used to verify both user-facing error categories and detailed parsing error messages.

**Data flow**: It takes an HTTP status and body, starts a fake server, records the expected status endpoint URL, and replies to the client’s status request with the supplied failure. It returns the io::Error object from the client and the URL the client should mention in messages.

**Call relations**: Status-error tests call this helper to avoid duplicating fake-server setup. It builds its client enrollment with remote_control_enrollment, then exercises pairing_status against the fake backend.

*Call graph*: calls 1 internal fn (remote_control_enrollment); called by 2 (remote_control_pairing_status_maps_user_actionable_backend_errors, remote_control_pairing_status_preserves_decode_error_context); 2 external calls (bind, spawn).


##### `remote_control_handle_starts_pairing_before_websocket_connects`  (lines 103–190)

```
async fn remote_control_handle_starts_pairing_before_websocket_connects()
```

**Purpose**: Checks that a remote-control handle can start pairing even before the websocket connection is established. This matters because the UI may ask for a pairing code before the long-lived remote-control connection is ready.

**Data flow**: The test starts a fake backend that first expects a token refresh request and then a pairing request with a manual-code flag. It marks the current enrollment as nearly expired, calls start_pairing on the handle, and expects a pairing response with the returned codes, environment id, and expiry time.

**Call relations**: This is a full-flow test around the higher-level remote-control handle. The fake server supplies a refreshed server token, and the handle then hands that token into the pairing request before producing the final response.

*Call graph*: 6 external calls (now_utc, bind, assert_eq!, json!, seconds, spawn).


##### `remote_control_pairing_status_returns_pending`  (lines 193–226)

```
async fn remote_control_pairing_status_returns_pending()
```

**Purpose**: Verifies that a pairing status response saying the code has not been claimed is passed through correctly. This is the normal waiting state while a user has not completed pairing yet.

**Data flow**: The test creates a fake backend that expects a status request with the pairing code and bearer token. It responds with JSON saying claimed is false. The enrollment’s pairing_status call returns a response whose claimed field should also be false.

**Call relations**: This test uses remote_control_enrollment directly, so it focuses on the low-level enrollment status request rather than the higher-level handle. The fake backend confirms the request format and supplies the pending result.

*Call graph*: calls 1 internal fn (remote_control_enrollment); 5 external calls (bind, assert!, assert_eq!, json!, spawn).


##### `remote_control_pairing_status_accepts_manual_pairing_code`  (lines 229–258)

```
async fn remote_control_pairing_status_accepts_manual_pairing_code()
```

**Purpose**: Verifies that pairing status can be checked using a manual pairing code instead of the regular pairing code. This supports flows where a human types a readable code like ABCD-EFGH.

**Data flow**: The test starts a fake backend and expects the JSON body to contain manual_pairing_code only. It replies with claimed false, then the client returns a status response showing the pairing is still pending.

**Call relations**: Like the pending-status test, this calls remote_control_enrollment directly. It proves the status request builder can send the alternate manual-code field when that is the only code available.

*Call graph*: calls 1 internal fn (remote_control_enrollment); 5 external calls (bind, assert!, assert_eq!, json!, spawn).


##### `remote_control_pairing_status_returns_claimed`  (lines 261–285)

```
async fn remote_control_pairing_status_returns_claimed()
```

**Purpose**: Verifies that a backend response saying the pairing code was claimed becomes a claimed status in the client. This is the success signal that pairing has been completed elsewhere.

**Data flow**: The fake backend accepts one status request and returns JSON with claimed set to true. The enrollment sends the request and receives a response whose claimed field the test confirms is true.

**Call relations**: This is another direct test of the enrollment-level pairing_status method. The fake server supplies the claimed result, and the test checks that no extra interpretation changes it.

*Call graph*: calls 1 internal fn (remote_control_enrollment); 5 external calls (bind, assert!, assert_eq!, json!, spawn).


##### `remote_control_handle_refreshes_after_pairing_status_auth_failure`  (lines 288–348)

```
async fn remote_control_handle_refreshes_after_pairing_status_auth_failure()
```

**Purpose**: Checks that the higher-level handle recovers when a pairing status request fails because the server token is no longer accepted. Instead of giving up on a 401 Unauthorized response, it should refresh the token and retry.

**Data flow**: The fake backend first receives a status request with the stale server token and returns 401. It then receives a refresh request, returns a new server token, and finally receives a second status request using that new token. The handle returns the successful claimed status.

**Call relations**: This test exercises the handle’s recovery path. The status call triggers a token refresh behind the scenes, then the refreshed enrollment is used for the retry before the final response is returned.

*Call graph*: 5 external calls (bind, assert!, assert_eq!, json!, spawn).


##### `remote_control_pairing_status_maps_user_actionable_backend_errors`  (lines 351–360)

```
async fn remote_control_pairing_status_maps_user_actionable_backend_errors()
```

**Purpose**: Checks that certain backend status failures become meaningful standard error kinds. This lets callers distinguish, for example, permission problems from invalid or expired pairing information.

**Data flow**: For each chosen HTTP status, the test asks pairing_status_error to create that backend response. It then compares the resulting io::Error kind with the expected category, such as PermissionDenied or InvalidInput.

**Call relations**: This test is a small table of scenarios built on the pairing_status_error helper. The helper supplies the fake backend failure, and this test focuses only on the classification of the resulting error.

*Call graph*: calls 1 internal fn (pairing_status_error); 1 external calls (assert_eq!).


##### `remote_control_pairing_status_preserves_decode_error_context`  (lines 363–374)

```
async fn remote_control_pairing_status_preserves_decode_error_context()
```

**Purpose**: Verifies that an invalid pairing-status response includes useful context in the error message. This is important when a backend says OK but sends broken JSON.

**Data flow**: The test makes the fake backend return HTTP 200 with an invalid JSON body. It turns the resulting error into text and checks that the message includes the status URL, HTTP status, request id, Cloudflare ray id, raw body, and decode error.

**Call relations**: It uses pairing_status_error to create the malformed response. The test then inspects the error text to make sure the low-level parsing failure is not stripped of debugging information.

*Call graph*: calls 1 internal fn (pairing_status_error); 1 external calls (assert!).


##### `remote_control_handle_refreshes_after_pairing_auth_failure`  (lines 377–459)

```
async fn remote_control_handle_refreshes_after_pairing_auth_failure()
```

**Purpose**: Checks that starting pairing recovers from an unauthorized server token. If the first pairing request gets 401 Unauthorized, the handle should refresh the server token and try pairing again.

**Data flow**: The fake backend first rejects a pairing request using the stale token. It then accepts a refresh request authenticated with the user access token, returns a refreshed server token, and accepts a second pairing request using that new token. The final output is a normal pairing-start response.

**Call relations**: This test drives the higher-level handle rather than the raw enrollment. It proves that the handle connects the failed pairing attempt, refresh operation, and retried pairing request into one smooth recovery flow.

*Call graph*: 5 external calls (bind, default, assert_eq!, json!, spawn).


##### `remote_control_handle_recovers_auth_before_refreshing_pairing`  (lines 462–584)

```
async fn remote_control_handle_recovers_auth_before_refreshing_pairing()
```

**Purpose**: Checks a deeper recovery path: if refreshing the server token fails because the saved user login token is stale, the handle reloads the user auth and retries refresh before pairing. This protects users from transient auth-cache staleness.

**Data flow**: The test writes stale auth to a temporary home directory, creates an auth manager, then replaces the saved auth with a fresh token. The fake backend rejects the first refresh using the stale token, accepts a second refresh using the fresh token, and then accepts pairing with the refreshed server token. The handle returns the expected pairing response.

**Call relations**: This test combines filesystem-backed auth, the auth manager, token refresh, and pairing. The handle first tries to refresh with old auth, recovers by reloading auth, then hands the newly refreshed server token into the pairing request.

*Call graph*: calls 2 internal fn (default, shared); 8 external calls (now_utc, bind, new, default, assert_eq!, json!, seconds, spawn).


##### `start_remote_control_pairing_preserves_backend_error_context`  (lines 587–597)

```
async fn start_remote_control_pairing_preserves_backend_error_context()
```

**Purpose**: Verifies that a backend failure while starting pairing is reported with the exact useful details. The goal is an error message that someone can use to trace the failed backend request.

**Data flow**: The test asks pairing_error to simulate a 503 Service Unavailable response with a response body and identifying headers. It compares the resulting error text with the exact expected message, including URL, HTTP status, request id, ray id, and body.

**Call relations**: This is a focused assertion built on the pairing_error helper. The helper creates the fake failure, and this test confirms that start_pairing preserves the backend context.

*Call graph*: calls 1 internal fn (pairing_error); 1 external calls (assert_eq!).


##### `start_remote_control_pairing_preserves_decode_error_context`  (lines 600–609)

```
async fn start_remote_control_pairing_preserves_decode_error_context()
```

**Purpose**: Verifies that a broken JSON response from the pairing endpoint produces an error with enough detail to debug it. This covers the case where the HTTP request succeeds but the body cannot be understood.

**Data flow**: The test uses pairing_error to return HTTP 200 with an invalid JSON body. It checks the error text for the pairing URL, status, request id, ray id, raw body, and the JSON decoding problem.

**Call relations**: The pairing_error helper supplies the malformed success response. This test checks that the parsing layer adds its failure reason without losing the HTTP context.

*Call graph*: calls 1 internal fn (pairing_error); 1 external calls (assert!).


##### `start_remote_control_pairing_rejects_mismatched_backend_enrollment`  (lines 612–624)

```
async fn start_remote_control_pairing_rejects_mismatched_backend_enrollment()
```

**Purpose**: Ensures the client rejects a pairing response that belongs to a different server or environment than the enrollment being used. This prevents accidentally accepting a code for the wrong remote-control server.

**Data flow**: The test feeds a pairing response JSON whose server_id and environment_id do not match the enrollment’s expected values. The pairing call fails, and the test compares the error text with the expected mismatch explanation.

**Call relations**: This test focuses on validation after the backend response is decoded. It proves that start_pairing does not blindly trust successful-looking data if it points at the wrong enrollment.

*Call graph*: 1 external calls (assert_eq!).


##### `start_remote_control_pairing_preserves_expiry_parse_error_context`  (lines 627–643)

```
async fn start_remote_control_pairing_preserves_expiry_parse_error_context()
```

**Purpose**: Checks that an invalid expires_at timestamp in a pairing response is reported with context. The expiry controls how long the pairing code is valid, so bad data must not be accepted silently.

**Data flow**: The test asks pairing_response_error to return a JSON response with matching server details but an invalid timestamp string. It then checks that the error mentions parsing the pairing response, HTTP 200, missing diagnostic headers, the bad expires_at value, and the timestamp parse error.

**Call relations**: This test uses pairing_response_error to send malformed but otherwise plausible JSON. It verifies that the response-validation path explains exactly which field failed.

*Call graph*: calls 1 internal fn (pairing_response_error); 2 external calls (assert!, json!).


##### `remote_control_handle_disable_keeps_current_enrollment`  (lines 646–659)

```
async fn remote_control_handle_disable_keeps_current_enrollment()
```

**Purpose**: Verifies that disabling remote control does not erase the selected enrollment. This matters because turning the feature off should not make the app forget which server it was paired with.

**Data flow**: The test creates a handle with a current enrollment, sends a Disabled desired state through the handle’s state channel, and then checks that current_enrollment is still present.

**Call relations**: This test looks at local handle state only. It does not use a fake backend; it confirms that a state change to Disabled leaves the enrollment ready for later re-enabling.

*Call graph*: 1 external calls (assert!).


##### `remote_control_handle_reenrolls_after_stale_pairing_enrollment`  (lines 662–787)

```
async fn remote_control_handle_reenrolls_after_stale_pairing_enrollment()
```

**Purpose**: Checks that the handle can recover when the saved enrollment is stale and the backend no longer recognizes it. In that case, it should enroll again, then start pairing with the new enrollment.

**Data flow**: The test creates a temporary state database, saves the old enrollment as enabled, and makes the fake backend reject the first pairing request with 404. The backend then accepts a new enrollment request, returns a refreshed server token and new server/environment ids, and accepts a new pairing request. The test confirms the response uses the refreshed environment and that persistence still records remote control as enabled.

**Call relations**: This is a broad recovery test spanning pairing, enrollment, and persisted state. A stale pairing failure leads the handle to re-enroll, then the new enrollment is used immediately for a successful pairing response.

*Call graph*: 6 external calls (bind, new, default, assert_eq!, json!, spawn).


##### `remote_control_handle_discards_pairing_response_after_auth_change`  (lines 790–854)

```
async fn remote_control_handle_discards_pairing_response_after_auth_change()
```

**Purpose**: Ensures an in-flight pairing response is thrown away if the logged-in account changes before the response arrives. This avoids showing or accepting a pairing code created under the wrong user account.

**Data flow**: The test starts pairing, captures the outgoing request, then changes the saved auth account and reloads the auth manager before replying to the old request. Even though the fake backend returns a valid-looking pairing response, the pairing task finishes with an error saying pairing is unavailable until enrollment completes.

**Call relations**: This test combines an asynchronous pairing task, a fake backend, and an auth-manager reload. It proves the handle checks that the account context is still current before trusting a response from an earlier request.

*Call graph*: calls 2 internal fn (default, shared); 6 external calls (bind, new, default, assert_eq!, json!, spawn).


### Analytics capture helpers
These helper modules and focused tests define how plugin analytics captures are produced, read, and validated.

### `app-server-test-client/src/plugin_analytics_capture.rs`

`test` · `test execution`

This file is a test helper for plugin analytics. Analytics events are written to a capture file as one JSON object per line. Each line contains a payload with an `events` list inside it. The code here reads that file, picks out only the events for one remote plugin, and then checks that the expected “plugin installed” event was recorded correctly.

This matters because analytics can silently become wrong: an event might be missing, duplicated, tied to the wrong plugin, or missing fields that downstream reporting expects. Without this helper, tests would need to repeat a lot of careful JSON checking, and mistakes in analytics capture could be harder to notice.

The flow is simple. First, `read_events_for_remote_plugin` opens the capture file. If the file does not exist yet, it treats that as “no events yet” instead of an error. It parses each non-empty line as JSON and collects events whose `plugin_id` matches the remote plugin being tested. Then `validate_mutation_events` looks for exactly one `codex_plugin_installed` event. It uses `validate_event` and `require_string` to confirm that the plugin identity fields match and that several required analytics fields are present and not null. The small `PluginEventIdentity` struct is just a bundle of the expected plugin names and IDs used during validation.

#### Function details

##### `read_events_for_remote_plugin`  (lines 9–43)

```
fn read_events_for_remote_plugin(
    path: &Path,
    remote_plugin_id: &str,
) -> Result<Vec<Value>>
```

**Purpose**: Reads an analytics capture file and returns only the events that belong to one remote plugin. Tests use this to ignore unrelated analytics noise and focus on the plugin they just exercised.

**Data flow**: It receives a file path and the remote plugin ID to look for. It reads the file as text; if the file is missing, it returns an empty list. For each non-empty line, it parses the line as JSON, looks inside the line’s `events` array, keeps events whose `event_params.plugin_id` matches the requested plugin ID, and returns those matching JSON event objects.

**Call relations**: This is called by `wait_for_remote_plugin_event`, which is likely waiting until the expected analytics output appears. After this function filters the raw capture file down to relevant events, later validation code can check whether the right event was actually produced.

*Call graph*: called by 1 (wait_for_remote_plugin_event); 3 external calls (new, read_to_string, from_str).


##### `validate_mutation_events`  (lines 51–69)

```
fn validate_mutation_events(
    events: Vec<Value>,
    expected: PluginEventIdentity<'_>,
) -> Result<Vec<Value>>
```

**Purpose**: Checks that the collected events contain exactly one plugin installation analytics event, and that this event describes the expected plugin. This prevents tests from passing when the event is missing, duplicated, or attached to the wrong plugin.

**Data flow**: It receives a list of JSON events and a `PluginEventIdentity` containing the expected plugin ID, plugin name, and marketplace name. It filters the events to those whose `event_type` is `codex_plugin_installed`. If there is not exactly one such event, it returns an error. If there is exactly one, it validates the event’s contents and returns that single event in a new list.

**Call relations**: This function is the main checker after events have been read. It delegates the detailed field-by-field checks to `validate_event`; if the count is wrong, it stops immediately with a clear test failure message.

*Call graph*: calls 1 internal fn (validate_event); 2 external calls (bail!, vec!).


##### `validate_event`  (lines 71–90)

```
fn validate_event(event: &Value, expected: &PluginEventIdentity<'_>) -> Result<()>
```

**Purpose**: Checks the contents of one plugin installation event. It confirms that the event names the expected plugin and that required analytics fields are present.

**Data flow**: It receives one JSON event and the expected plugin identity. It reads the event’s `event_params`, verifies the string fields `plugin_id`, `plugin_name`, and `marketplace_name`, then checks that fields like `has_skills`, `mcp_server_count`, `connector_ids`, and `product_client_id` exist and are not null. It returns success if all checks pass, or an error explaining the first problem found.

**Call relations**: `validate_mutation_events` calls this once it has found the single expected installation event. This function uses `require_string` for repeated string comparisons, and performs the remaining required-field checks itself.

*Call graph*: calls 1 internal fn (require_string); called by 1 (validate_mutation_events); 1 external calls (bail!).


##### `require_string`  (lines 92–98)

```
fn require_string(params: &Value, field: &str, expected: &str) -> Result<()>
```

**Purpose**: Verifies that a named JSON field is a string with an exact expected value. It is a small helper that keeps the event validation code clear and gives useful error messages when a field is wrong.

**Data flow**: It receives a JSON object, the field name to inspect, and the expected string. It looks up that field, treats it as valid only if it is a string equal to the expected value, and returns success or an error showing what value was actually found.

**Call relations**: `validate_event` calls this for each identity field that must match the plugin under test. It does not call other project helpers; it performs one focused comparison and reports failure when the JSON does not match expectations.

*Call graph*: called by 1 (validate_event); 2 external calls (get, bail!).


### `app-server-test-client/src/plugin_analytics_capture_tests.rs`

`test` · `test run`

This is a test file for plugin analytics capture. The system writes analytics events as JSON lines, meaning each line is a separate JSON object. These tests create small fake capture files and fake event objects, then check that the reader and validator keep only the events for the plugin being tested and reject bad data.

The first test is like checking a mailbox: the capture file contains mail for two plugins, and the code should pick out only the envelope addressed to the target plugin. It writes a temporary file with one unrelated event and one matching event, reads back matching events with read_events_for_remote_plugin, and then asks validate_mutation_events to confirm the event has the expected identity and required fields.

The next two tests focus on failure cases. One makes two identical install events and confirms validation complains about duplicates. The other removes a required capability field, has_skills, and confirms validation reports that missing metadata.

The helper functions keep the tests readable. mutation_event builds a standard valid event, expected_identity describes the plugin the validator should expect, and unique_capture_path creates a temporary filename that should not collide with other test runs.

#### Function details

##### `reads_and_validates_remote_plugin_mutation_events`  (lines 14–40)

```
fn reads_and_validates_remote_plugin_mutation_events()
```

**Purpose**: This test proves that the capture reader can find the right remote plugin event inside a file that also contains unrelated plugin events. It also proves that the matching event passes the mutation-event validation rules.

**Data flow**: It starts by creating a unique temporary path, one valid event for the target plugin, and one similar event for a different plugin. It writes both events into a JSON-lines capture file, reads back only events for the target plugin, validates them against the expected plugin identity, and checks that the single valid event comes out. At the end, it deletes the temporary file it created.

**Call relations**: During the test, it uses mutation_event to build the valid sample event, unique_capture_path to avoid filename collisions, and expected_identity to describe what plugin the validator should accept. It then exercises the real reader, read_events_for_remote_plugin, followed by the real validator, validate_mutation_events, to check the full happy path.

*Call graph*: calls 3 internal fn (expected_identity, mutation_event, unique_capture_path); 6 external calls (assert_eq!, remove_file, write, json!, read_events_for_remote_plugin, validate_mutation_events).


##### `rejects_duplicate_mutation_events`  (lines 43–49)

```
fn rejects_duplicate_mutation_events()
```

**Purpose**: This test checks that validation fails when the same kind of plugin mutation event appears more than once. That matters because duplicate analytics events could make one install or update look like it happened multiple times.

**Data flow**: It creates one valid install event, duplicates it into a two-item list, and sends that list into validate_mutation_events with the expected plugin identity. Instead of accepting the list, the validator should return an error, and the test checks that the error message mentions that two matching events were found.

**Call relations**: The test relies on mutation_event for a realistic event shape and expected_identity for the plugin details that validation should compare against. It calls validate_mutation_events specifically to exercise the duplicate-detection branch.

*Call graph*: calls 2 internal fn (expected_identity, mutation_event); 3 external calls (assert!, validate_mutation_events, vec!).


##### `rejects_missing_capability_metadata`  (lines 52–59)

```
fn rejects_missing_capability_metadata()
```

**Purpose**: This test checks that validation rejects a plugin event when required capability information is missing. In this case, the missing field is has_skills, which tells whether the plugin includes skills.

**Data flow**: It creates a normal valid install event, then deliberately changes the has_skills field to null, meaning the value is absent or unusable. It sends that damaged event to validate_mutation_events with the expected identity, expects an error, and checks that the error message points to has_skills.

**Call relations**: The test uses mutation_event to start from a valid baseline and expected_identity to provide the plugin identity being checked. It then calls validate_mutation_events to confirm that the validator catches missing metadata rather than silently accepting it.

*Call graph*: calls 2 internal fn (expected_identity, mutation_event); 3 external calls (assert!, validate_mutation_events, vec!).


##### `mutation_event`  (lines 61–74)

```
fn mutation_event(event_type: &str) -> Value
```

**Purpose**: This helper builds a standard fake plugin analytics event for the tests. It lets each test focus on what it wants to change, instead of repeating the full JSON structure every time.

**Data flow**: It takes an event type string, such as codex_plugin_installed, and places it into a JSON object with event_params for the test plugin. The returned JSON value includes the plugin ID, plugin name, marketplace name, capability fields, connector list, server count, and client ID.

**Call relations**: The three tests call this helper whenever they need a realistic plugin event. Some tests use the event unchanged, while others duplicate it or damage one field to check that validation catches the problem.

*Call graph*: called by 3 (reads_and_validates_remote_plugin_mutation_events, rejects_duplicate_mutation_events, rejects_missing_capability_metadata); 1 external calls (json!).


##### `expected_identity`  (lines 76–82)

```
fn expected_identity() -> PluginEventIdentity<'static>
```

**Purpose**: This helper returns the plugin identity that test events are supposed to match. It keeps the expected plugin ID, plugin name, and marketplace name in one place.

**Data flow**: It takes no input and returns a PluginEventIdentity containing the constant remote plugin ID plus the sample plugin name and marketplace name used by the fake events.

**Call relations**: Each validation test calls this helper before calling validate_mutation_events. The validator uses this expected identity as the standard for deciding whether an event belongs to the right plugin.

*Call graph*: called by 3 (reads_and_validates_remote_plugin_mutation_events, rejects_duplicate_mutation_events, rejects_missing_capability_metadata).


##### `unique_capture_path`  (lines 84–93)

```
fn unique_capture_path(name: &str) -> PathBuf
```

**Purpose**: This helper creates a temporary capture-file path that is very unlikely to conflict with another test. That is important because tests may run more than once or in parallel.

**Data flow**: It takes a short name label, reads the current time and the current process ID, and combines them with the system temporary directory into a filename ending in .jsonl. The result is a PathBuf, which is Rust's owned path type.

**Call relations**: The file-reading test calls this helper before writing its fake capture file. The path it returns is then passed to the file writer, the capture reader, and finally file removal after the test finishes.

*Call graph*: called by 1 (reads_and_validates_remote_plugin_mutation_events); 3 external calls (now, format!, temp_dir).


### `app-server-test-client/src/loopback_responses_server.rs`

`test` · `test startup, request handling, teardown`

This file is a test helper. It starts a small web server on the computer’s own loopback address, 127.0.0.1, which means “talk to myself.” That is useful because tests can exercise the real HTTP path while staying fast, private, and predictable.

The server binds to an available random port, records its base URL, and runs in a background thread. Think of it like a temporary clerk at a service window: while the test runs, the clerk waits for requests; when the test ends, the clerk is told to close the window and the thread is joined so it does not keep running.

For each incoming connection, the server reads a basic HTTP request. If the first line is a POST request to a path containing `/responses`, it sends back a successful streaming-style response with two events: one saying a response was created, and one saying it completed with zero token usage. If the request is for anything else, it returns a simple 404 “not found” JSON message.

This is intentionally small and limited. It is not a general web server. It only implements enough HTTP behavior for the test client to verify its integration with a Responses API-like endpoint.

#### Function details

##### `LoopbackResponsesServer::start`  (lines 22–54)

```
fn start() -> Result<Self>
```

**Purpose**: Starts the temporary local Responses API server and returns an object that represents it. Tests use this when they need a real URL to send HTTP requests to, without contacting the real external API.

**Data flow**: It begins with no server running. It opens a TCP listener on 127.0.0.1 using a random free port, marks it as nonblocking so the background thread can regularly check for shutdown, creates a shared shutdown flag, and starts a thread that accepts connections. It returns a `LoopbackResponsesServer` containing the server’s base URL, the shutdown flag, and the thread handle.

**Call relations**: The broader test run calls this from `run` when it needs the fake Responses API. After startup, the background thread accepts client connections and routes each accepted connection into the request-processing path.

*Call graph*: called by 1 (run); 6 external calls (clone, new, new, bind, format!, spawn).


##### `LoopbackResponsesServer::base_url`  (lines 56–58)

```
fn base_url(&self) -> &str
```

**Purpose**: Gives callers the URL of the temporary local server. Tests use this URL as if it were the real Responses API endpoint.

**Data flow**: It reads the stored `base_url` string from the server object and returns it as borrowed text. Nothing is changed.

**Call relations**: After `LoopbackResponsesServer::start` creates the server, callers can ask this function for the address to configure their client. It is the handoff point between the test server setup and the code being tested.


##### `LoopbackResponsesServer::drop`  (lines 62–67)

```
fn drop(&mut self)
```

**Purpose**: Shuts down the temporary server when the server object goes away. This prevents background test threads from being left behind.

**Data flow**: It changes the shared shutdown flag from false to true. If there is still a background thread stored in the object, it takes ownership of that thread handle and waits for the thread to finish. It does not return a useful value.

**Call relations**: Rust calls this automatically when the `LoopbackResponsesServer` value is dropped. It pairs with `LoopbackResponsesServer::start`: start opens the service window, and drop closes it cleanly.


##### `handle_model_connection`  (lines 70–95)

```
fn handle_model_connection(mut stream: TcpStream) -> io::Result<()>
```

**Purpose**: Processes one client connection to the fake Responses API. It decides whether the request looks like a supported Responses API call and writes the matching HTTP reply.

**Data flow**: It receives a TCP stream, makes it blocking for simpler reading, and sets a two-second read timeout so it will not wait forever. It reads the HTTP request, inspects the first request line, and then writes either a successful event-stream response for `POST /responses`-style requests or a 404 JSON response for anything else.

**Call relations**: The server thread created by `LoopbackResponsesServer::start` calls this whenever it accepts a connection. This function relies on `read_http_request` to gather the incoming request and on `write_http_response` to send the final reply.

*Call graph*: calls 2 internal fn (read_http_request, write_http_response); 4 external calls (from_secs, set_nonblocking, set_read_timeout, concat!).


##### `read_http_request`  (lines 97–119)

```
fn read_http_request(stream: &mut TcpStream) -> io::Result<Vec<u8>>
```

**Purpose**: Reads a complete enough HTTP request from a TCP connection for this test server to understand it. It collects the headers first, then reads the body if a content length says one is present.

**Data flow**: It starts with an empty byte buffer and repeatedly reads from the stream. Once it finds the blank line that ends the HTTP headers, it asks `parse_content_length` how many body bytes to expect. It then keeps reading until it has that many body bytes or the connection closes, and returns the collected request bytes.

**Call relations**: `handle_model_connection` calls this before it can decide what response to send. This function hands off header parsing to `parse_content_length`, keeping the connection-reading logic separate from the header interpretation.

*Call graph*: calls 1 internal fn (parse_content_length); called by 1 (handle_model_connection); 2 external calls (read, new).


##### `parse_content_length`  (lines 121–131)

```
fn parse_content_length(headers: &[u8]) -> usize
```

**Purpose**: Finds the HTTP `Content-Length` header and turns it into a number of bytes to read. If the header is missing or invalid, it treats the body length as zero.

**Data flow**: It receives raw header bytes, converts them into readable text in a forgiving way, scans each header line, and looks for a name matching `content-length` without caring about letter case. If it finds a valid number, it returns that number; otherwise it returns 0.

**Call relations**: `read_http_request` calls this after it has read the HTTP headers. The result tells `read_http_request` whether it should wait for more bytes belonging to the request body.

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

**Purpose**: Writes a simple HTTP response to a TCP connection. It is used for both the successful fake streaming response and the 404 error response.

**Data flow**: It receives the stream, a status such as `200 OK`, a content type such as `text/event-stream`, and the response body text. It formats these into an HTTP response with a content length and `Connection: close`, writes it to the stream, flushes the stream so the bytes are sent, and returns whether that succeeded.

**Call relations**: `handle_model_connection` calls this after deciding what kind of reply the request deserves. This function is the final step that turns the server’s decision into bytes sent back to the test client.

*Call graph*: called by 1 (handle_model_connection); 2 external calls (flush, write!).


### Test-client smoke workflows
This sequence introduces the reusable test-client harness and then applies it to non-destructive and destructive plugin analytics smoke scenarios.

### `app-server-test-client/src/lib.rs`

`entrypoint` · `startup and command execution for app-server test runs`

Think of this file as a remote control and inspection window for the Codex app-server. The app-server speaks JSON-RPC, which is a simple request-and-response message format using JSON. This client lets developers exercise that protocol without needing the real UI.

At startup, it reads command-line options, decides whether to spawn `codex app-server` as a child process or connect to an already running WebSocket server, and then runs one chosen test command. Some commands send a single message. Others resume a thread, list models, test account login, trigger command or file-change approval prompts, or keep watching every server event.

The central piece is `CodexClient`. It knows how to write JSON-RPC messages, read responses, save notifications that arrive early, and answer approval requests from the server. It also records useful facts while streaming a turn, such as command execution status and whether a helper script finished before the turn ended.

The file also includes server-launch helpers, dynamic tool parsing, basic shell quoting, and OpenTelemetry tracing setup. Without this file, end-to-end app-server behavior would be much harder to test from scripts or CI because there would be no small, purpose-built client that drives the same protocol paths a real app uses.

#### Function details

##### `run`  (lines 315–517)

```
async fn run() -> Result<()>
```

**Purpose**: This is the top-level driver for the test client. It reads the command-line arguments, checks which options are allowed for the chosen command, chooses a server endpoint, and starts the requested test action.

**Data flow**: It takes no direct arguments; it reads CLI flags such as `--codex-bin`, `--url`, config overrides, dynamic tools, and a subcommand. It turns those into an endpoint and command-specific inputs, then returns success or an error after the selected operation finishes.

**Call relations**: This is the hub that sends control to helpers such as `serve`, `send_message`, `model_list`, approval tests, login tests, elicitation tests, and plugin analytics modules. Before doing so, it uses `parse_dynamic_tools_arg`, `ensure_dynamic_tools_unused`, `resolve_endpoint`, or `resolve_shared_websocket_url` to make sure each command is set up safely.

*Call graph*: calls 26 internal fn (ensure_dynamic_tools_unused, get_account_rate_limits, live_elicitation_timeout_pause, model_list, no_trigger_cmd_approval, parse_dynamic_tools_arg, from_flag, run, run_cleanup, run (+15 more)); 2 external calls (parse, bail!).


##### `resolve_endpoint`  (lines 529–540)

```
fn resolve_endpoint(codex_bin: Option<PathBuf>, url: Option<String>) -> Result<Endpoint>
```

**Purpose**: This decides how the client should reach the app-server. It enforces that the user cannot ask to both spawn a private server and connect to an existing one.

**Data flow**: It receives an optional Codex binary path and an optional WebSocket URL. It returns either a `SpawnCodex` endpoint, a `ConnectWs` endpoint, or the default local WebSocket URL if neither was provided.

**Call relations**: `run` calls this before most commands. The returned endpoint is later passed into client-driving helpers, which use it to create a `CodexClient`.

*Call graph*: called by 1 (run); 3 external calls (ConnectWs, SpawnCodex, bail!).


##### `resolve_shared_websocket_url`  (lines 542–554)

```
fn resolve_shared_websocket_url(
    codex_bin: Option<PathBuf>,
    url: Option<String>,
    command: &str,
) -> Result<String>
```

**Purpose**: This picks a WebSocket URL for commands that must talk to a shared, already-running app-server. It refuses `--codex-bin` because spawning a private standard-input server would not be visible to helper processes.

**Data flow**: It receives the optional binary path, optional URL, and command name. It returns the given URL or the default local URL, unless a binary path was supplied, in which case it returns an error.

**Call relations**: `run` uses this for elicitation counter commands. Those commands need a stable WebSocket server that multiple processes can contact.

*Call graph*: called by 1 (run); 1 external calls (bail!).


##### `BackgroundAppServer::spawn`  (lines 557–587)

```
fn spawn(codex_bin: &Path, config_overrides: &[String]) -> Result<Self>
```

**Purpose**: This starts a temporary WebSocket app-server in the background for a live test. It chooses an unused local port automatically so the test does not collide with common ports.

**Data flow**: It receives the Codex binary path and config overrides. It reserves a local port, starts `codex app-server --listen <url>`, and returns a `BackgroundAppServer` containing the child process and its URL.

**Call relations**: `live_elicitation_timeout_pause` calls this when it needs its own short-lived WebSocket server. The returned object later cleans up the process through its drop behavior.

*Call graph*: called by 1 (live_elicitation_timeout_pause); 8 external calls (from, parent, inherit, null, bind, new, format!, var_os).


##### `BackgroundAppServer::drop`  (lines 591–599)

```
fn drop(&mut self)
```

**Purpose**: This is the cleanup safety net for a temporary background app-server. It prevents the spawned server from being left running after the test ends.

**Data flow**: When the `BackgroundAppServer` value is discarded, it checks whether the child process has already exited. If not, it kills it and waits for it to finish.

**Call relations**: It is called automatically by Rust when the background server object goes out of scope, especially after `live_elicitation_timeout_pause` completes or fails.

*Call graph*: 4 external calls (kill, try_wait, wait, println!).


##### `serve`  (lines 602–647)

```
fn serve(codex_bin: &Path, config_overrides: &[String], listen: &str, kill: bool) -> Result<()>
```

**Purpose**: This starts `codex app-server` as a long-running WebSocket service for manual or scripted testing. It writes logs to a known temporary directory.

**Data flow**: It receives a Codex binary path, config overrides, a listen URL, and a flag saying whether to kill existing listeners on the same port. It builds a shell command, starts it under `nohup`, and prints the listen address, launcher process id, and log path.

**Call relations**: `run` calls this for the `serve` subcommand. If requested, it first calls `kill_listeners_on_same_port`; it also uses `shell_quote` while building the shell command.

*Call graph*: calls 1 internal fn (kill_listeners_on_same_port); called by 1 (run); 8 external calls (new, from, from, null, new, format!, create_dir_all, println!).


##### `kill_listeners_on_same_port`  (lines 649–708)

```
fn kill_listeners_on_same_port(listen: &str) -> Result<()>
```

**Purpose**: This clears the port that `serve` wants to use. It is a convenience for test setups where an old app-server may still be listening.

**Data flow**: It receives a listen URL, extracts its port, asks `lsof` which processes are listening there, sends them a normal termination signal, waits briefly, and force-kills any that remain.

**Call relations**: `serve` calls this only when the user passes the kill option. It relies on external system tools, so it is mainly suited to Unix-like development environments.

*Call graph*: called by 1 (serve); 7 external calls (from_millis, from_utf8_lossy, parse, new, format!, println!, sleep).


##### `shell_quote`  (lines 710–712)

```
fn shell_quote(input: &str) -> String
```

**Purpose**: This makes a string safe to place inside a single-quoted shell command. It prevents paths or config values containing quotes from breaking the generated command line.

**Data flow**: It receives plain text and returns the same text wrapped in single quotes, with any internal single quotes escaped in shell syntax.

**Call relations**: It is used when constructing shell commands in `serve` and `live_elicitation_timeout_pause`, where user-provided paths or URLs must be passed through `sh`.

*Call graph*: 1 external calls (format!).


##### `send_message`  (lines 722–741)

```
async fn send_message(
    endpoint: &Endpoint,
    config_overrides: &[String],
    user_message: String,
) -> Result<()>
```

**Purpose**: This sends a basic user message through the newer thread-and-turn flow, but with no experimental options or special policies. It is the simple “ask Codex something” path.

**Data flow**: It receives an endpoint, config overrides, and user text. It creates a default policy bundle and hands everything to `send_message_v2_with_policies`, then returns that result.

**Call relations**: `run` calls this for the `send-message` command. It delegates almost all real work to the shared V2 message helper.

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

**Purpose**: This public helper sends a V2 message by spawning a Codex app-server from a binary path. It exists so other code can reuse the V2 sending behavior without going through the CLI parser.

**Data flow**: It receives a binary path, config overrides, user text, and optional dynamic tool definitions. It wraps the path in a spawn endpoint and forwards the request with experimental API support enabled.

**Call relations**: It calls `send_message_v2_endpoint`, which performs validation and then uses the shared message-sending path.

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

**Purpose**: This sends a V2 message to an already chosen endpoint. It also protects users from using dynamic tools unless the experimental API flag is enabled.

**Data flow**: It receives the endpoint, config overrides, user text, an experimental flag, and optional dynamic tools. It either rejects an invalid dynamic-tool setup or builds normal send policies and forwards the work.

**Call relations**: `run` calls this for `send-message-v2`, and `send_message_v2` calls it for library-style use. It delegates to `send_message_v2_with_policies`.

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

**Purpose**: This runs a test designed to make one shell command require multiple approval callbacks. It verifies that accepting or cancelling those approvals produces the expected command and turn outcome.

**Data flow**: It receives endpoint details, a prompt, the minimum expected approval count, an optional approval index to cancel, and dynamic tools. It starts a thread, starts a turn with read-only sandboxing and approval-on-request, streams the turn, counts approvals, checks final statuses, and returns an error if expectations are not met.

**Call relations**: `run` calls this for the zsh multi-command approval test. Inside `with_client`, it uses `CodexClient` methods for initialize, thread start, turn start, and turn streaming.

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

**Purpose**: This resumes an existing V2 thread and sends a new message into it. It is useful for testing conversation continuity.

**Data flow**: It receives endpoint details, config overrides, a thread id, user text, and dynamic-tool input. It rejects dynamic tools for this command, connects a client, initializes, resumes the thread, starts a new turn, streams it, and returns the final result.

**Call relations**: `run` calls this for `resume-message-v2`. It uses `ensure_dynamic_tools_unused` first, then runs the protocol steps inside `with_client`.

*Call graph*: calls 2 internal fn (ensure_dynamic_tools_unused, with_client); called by 1 (run).


##### `thread_resume_follow`  (lines 929–948)

```
async fn thread_resume_follow(
    endpoint: &Endpoint,
    config_overrides: &[String],
    thread_id: String,
) -> Result<()>
```

**Purpose**: This resumes an existing thread and then keeps printing server notifications forever. It is a live follow mode for watching what the server emits.

**Data flow**: It receives endpoint details, config overrides, and a thread id. It initializes, resumes the thread, prints the resume response, and then continuously reads notifications until the process is stopped.

**Call relations**: `run` calls this for `thread-resume`. It uses `with_client`, then relies on `CodexClient::stream_notifications_forever`.

*Call graph*: calls 1 internal fn (with_client); called by 1 (run).


##### `watch`  (lines 950–959)

```
async fn watch(endpoint: &Endpoint, config_overrides: &[String]) -> Result<()>
```

**Purpose**: This connects to the app-server, initializes the protocol, and dumps incoming messages indefinitely. It is a general-purpose observation command.

**Data flow**: It receives endpoint details and config overrides. It creates a client, performs the initialize handshake, then reads and prints notifications until interrupted.

**Call relations**: `run` calls this for `watch`. It shares the same `with_client` wrapper and stream loop used by thread follow mode.

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

**Purpose**: This sends a prompt intended to make Codex ask for command execution approval. It is a quick test that the approval request path works.

**Data flow**: It receives endpoint details, config overrides, an optional prompt, and dynamic tools. It chooses a default prompt if needed, sets approval-on-request with a read-only sandbox, and sends the message through the shared V2 policy helper.

**Call relations**: `run` calls this for `trigger-cmd-approval`. It delegates the actual client session to `send_message_v2_with_policies`.

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

**Purpose**: This sends a prompt intended to make Codex ask for file-change approval. It tests the app-server path where edits need permission.

**Data flow**: It receives endpoint details, config overrides, an optional prompt, and dynamic tools. It chooses a default apply-patch prompt if needed, sets approval-on-request with a read-only sandbox, and sends the message.

**Call relations**: `run` calls this for `trigger-patch-approval`. The shared `send_message_v2_with_policies` function performs the connection and streaming.

*Call graph*: calls 1 internal fn (send_message_v2_with_policies); called by 1 (run).


##### `no_trigger_cmd_approval`  (lines 1013–1032)

```
async fn no_trigger_cmd_approval(
    endpoint: &Endpoint,
    config_overrides: &[String],
    dynamic_tools: &Option<Vec<DynamicToolSpec>>,
) -> Result<()>
```

**Purpose**: This sends a command-like prompt without special approval settings. It checks that normal policy choices do not accidentally trigger approval prompts.

**Data flow**: It receives endpoint details, config overrides, and dynamic tools. It sends a fixed prompt using default approval and sandbox settings, then streams the resulting turn.

**Call relations**: `run` calls this for `no-trigger-cmd-approval`. It uses `send_message_v2_with_policies` with no approval or sandbox overrides.

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

**Purpose**: This is the shared recipe for sending one V2 message with optional approval and sandbox rules. It avoids repeating the initialize-thread-turn-stream sequence in every command.

**Data flow**: It receives endpoint details, config overrides, user text, and a policy bundle. It connects a client, initializes with or without experimental support, starts a thread, starts a turn containing the user text, applies the requested policies, streams the turn, and returns success or an error.

**Call relations**: It is called by the simple send command and the approval-triggering commands. It runs through `with_client`, which adds tracing and connection setup.

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

**Purpose**: This sends two turns in the same thread. It tests that a follow-up message uses the previous conversation state.

**Data flow**: It receives endpoint details, config overrides, an initial message, a follow-up message, and optional dynamic tools. It initializes, starts one thread, sends and streams the first turn, then sends and streams the second turn in that same thread.

**Call relations**: `run` calls this for `send-follow-up-v2`. It uses `with_client` and the normal `CodexClient` thread and turn methods.

*Call graph*: calls 1 internal fn (with_client); called by 1 (run).


##### `test_login`  (lines 1127–1177)

```
async fn test_login(
    endpoint: &Endpoint,
    config_overrides: &[String],
    device_code: bool,
) -> Result<()>
```

**Purpose**: This starts a ChatGPT account login flow and waits until the server reports completion. It can test either browser-based login or device-code login.

**Data flow**: It receives endpoint details, config overrides, and a flag for device-code mode. It initializes, starts the selected login flow, prints instructions for the user, waits for a matching completion notification, and returns success only if login succeeded.

**Call relations**: `run` calls this for `test-login`. It uses `CodexClient` login methods and `wait_for_account_login_completion` inside `with_client`.

*Call graph*: calls 1 internal fn (with_client); called by 1 (run).


##### `get_account_rate_limits`  (lines 1179–1195)

```
async fn get_account_rate_limits(endpoint: &Endpoint, config_overrides: &[String]) -> Result<()>
```

**Purpose**: This asks the app-server for the current account rate limits. It is a small diagnostic command.

**Data flow**: It receives endpoint details and config overrides. It initializes a client, sends the rate-limit read request, prints the response, and returns the result status.

**Call relations**: `run` calls this for `get-account-rate-limits`. The request itself is sent through `CodexClient::get_account_rate_limits` inside `with_client`.

*Call graph*: calls 1 internal fn (with_client); called by 1 (run).


##### `model_list`  (lines 1197–1208)

```
async fn model_list(endpoint: &Endpoint, config_overrides: &[String]) -> Result<()>
```

**Purpose**: This asks the app-server which models are available. It helps confirm that model discovery works through the app-server protocol.

**Data flow**: It receives endpoint details and config overrides. It initializes, sends a default model-list request, prints the response, and returns success or an error.

**Call relations**: `run` calls this for `model-list`. It uses `CodexClient::model_list` inside the shared client wrapper.

*Call graph*: calls 1 internal fn (with_client); called by 1 (run).


##### `thread_list`  (lines 1210–1233)

```
async fn thread_list(endpoint: &Endpoint, config_overrides: &[String], limit: u32) -> Result<()>
```

**Purpose**: This lists stored conversation threads. It is useful for checking persistence and thread browsing behavior.

**Data flow**: It receives endpoint details, config overrides, and a limit. It initializes, builds a thread-list request with that limit and default filters, prints the response, and returns the outcome.

**Call relations**: `run` calls this for `thread-list`. It delegates the protocol request to `CodexClient::thread_list` inside `with_client`.

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

**Purpose**: This wraps a test command in common setup: tracing, a named span, client connection, and trace-summary printing. It is the standard doorway for most command implementations.

**Data flow**: It receives a command name, endpoint, config overrides, and a callback that uses a mutable `CodexClient`. It initializes tracing, captures trace information, connects the client, runs the callback, prints the trace summary, and returns the callback result.

**Call relations**: Many command helpers call this instead of creating clients directly. It calls `TestClientTracing::initialize`, `CodexClient::connect`, and `print_trace_summary` around the command-specific work.

*Call graph*: calls 2 internal fn (initialize, print_trace_summary); called by 10 (get_account_rate_limits, model_list, resume_message_v2, send_follow_up_v2, send_message_v2_with_policies, test_login, thread_list, thread_resume_follow, trigger_zsh_fork_multi_cmd_approval, watch); 1 external calls (info_span!).


##### `thread_increment_elicitation`  (lines 1257–1269)

```
fn thread_increment_elicitation(url: &str, thread_id: String) -> Result<()>
```

**Purpose**: This tells an existing WebSocket app-server to increment a thread's elicitation pause counter. In plain terms, it marks that the thread is waiting on outside input so some timeouts should pause.

**Data flow**: It receives a WebSocket URL and thread id. It connects, initializes, sends the increment request, prints the response, and returns success or an error.

**Call relations**: `run` calls this after `resolve_shared_websocket_url`. It connects directly with `CodexClient::connect` rather than using `with_client`.

*Call graph*: calls 1 internal fn (connect); called by 1 (run); 2 external calls (ConnectWs, println!).


##### `thread_decrement_elicitation`  (lines 1271–1283)

```
fn thread_decrement_elicitation(url: &str, thread_id: String) -> Result<()>
```

**Purpose**: This tells an existing WebSocket app-server to decrement a thread's elicitation pause counter. It is the companion cleanup or resume signal for an elicitation pause.

**Data flow**: It receives a WebSocket URL and thread id. It connects, initializes, sends the decrement request, prints the response, and returns success or an error.

**Call relations**: `run` calls this after `resolve_shared_websocket_url`. The live elicitation harness also performs a similar decrement through the client after its test.

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

**Purpose**: This is a live end-to-end test proving that an elicitation pause can keep a long helper command from being killed by a shorter execution timeout. It is like checking that a stopwatch really pauses while someone is waiting at a service counter.

**Data flow**: It receives optional server connection choices, config overrides, model name, workspace, helper script path, and hold time. It may start a background server, connects a client, starts a thread and turn that runs the helper script, streams events, validates timing and completion markers, decrements the elicitation counter for cleanup, and returns an error if any expectation fails.

**Call relations**: `run` calls this for `live-elicitation-timeout-pause`. It may call `BackgroundAppServer::spawn`, uses `CodexClient::connect`, and relies on `CodexClient::stream_turn` to collect the evidence it later checks.

*Call graph*: calls 2 internal fn (spawn, connect); called by 1 (run); 11 external calls (default, now, canonicalize, ConnectWs, bail!, cfg!, eprintln!, format!, println!, current_exe (+1 more)).


##### `ensure_dynamic_tools_unused`  (lines 1442–1452)

```
fn ensure_dynamic_tools_unused(
    dynamic_tools: &Option<Vec<DynamicToolSpec>>,
    command: &str,
) -> Result<()>
```

**Purpose**: This rejects commands that were given dynamic tools even though they do not support them. It prevents confusing tests where a flag is silently ignored.

**Data flow**: It receives optional dynamic tools and a command name. If tools are present, it returns an explanatory error; otherwise it returns success.

**Call relations**: `run` calls this for commands that do not use dynamic tools, and `resume_message_v2` calls it for its own stricter behavior.

*Call graph*: called by 2 (resume_message_v2, run); 1 external calls (bail!).


##### `parse_dynamic_tools_arg`  (lines 1454–1475)

```
fn parse_dynamic_tools_arg(dynamic_tools: &Option<String>) -> Result<Option<Vec<DynamicToolSpec>>>
```

**Purpose**: This turns the `--dynamic-tools` command-line value into structured tool definitions the app-server protocol understands. The value can be raw JSON or a filename prefixed with `@`.

**Data flow**: It receives an optional string. It reads JSON from the string or file, accepts either one object or an array of objects, normalizes those into `DynamicToolSpec` values, and returns them or no tools.

**Call relations**: `run` calls this once at startup. Commands that support dynamic tools pass the parsed result into thread-start requests.

*Call graph*: calls 1 internal fn (normalize_dynamic_tool_specs); called by 1 (run); 5 external calls (new, bail!, read_to_string, from_str, vec!).


##### `item_started_before_helper_done_is_unexpected`  (lines 1512–1522)

```
fn item_started_before_helper_done_is_unexpected(
    item: &ThreadItem,
    command_item_started: bool,
    helper_done_seen: bool,
) -> bool
```

**Purpose**: This helps the elicitation timeout test decide whether a new thread item appeared too early. It flags suspicious activity after a command starts but before the helper script says it is done.

**Data flow**: It receives a thread item, whether a command item has started, and whether the helper completion marker has been seen. It returns true only for non-user-message items that start during the protected waiting window.

**Call relations**: `CodexClient::stream_turn` calls this while watching turn notifications for the live elicitation harness.

*Call graph*: called by 1 (stream_turn); 1 external calls (matches!).


##### `CodexClient::connect`  (lines 1525–1530)

```
fn connect(endpoint: &Endpoint, config_overrides: &[String]) -> Result<Self>
```

**Purpose**: This creates a `CodexClient` using the chosen transport. The transport is either a spawned app-server over standard input/output or a WebSocket connection to an existing server.

**Data flow**: It receives an endpoint and config overrides. It dispatches to `spawn_stdio` for a private child process or `connect_websocket` for a shared server, returning a ready client.

**Call relations**: It is used directly by elicitation helpers and by the shared `with_client` wrapper. Downstream code then uses the returned client for JSON-RPC calls.

*Call graph*: called by 3 (live_elicitation_timeout_pause, thread_decrement_elicitation, thread_increment_elicitation); 2 external calls (connect_websocket, spawn_stdio).


##### `CodexClient::spawn_stdio`  (lines 1532–1534)

```
fn spawn_stdio(codex_bin: &Path, config_overrides: &[String]) -> Result<Self>
```

**Purpose**: This starts `codex app-server` as a child process and communicates through its standard input and output. This is useful for isolated tests that do not need a shared WebSocket server.

**Data flow**: It receives a binary path and config overrides. It forwards to `spawn_stdio_with_env` with no extra environment variables and returns the resulting client.

**Call relations**: `CodexClient::connect` uses this for `SpawnCodex` endpoints, and plugin cleanup code can also call it through related helpers.

*Call graph*: called by 1 (run_cleanup); 1 external calls (spawn_stdio_with_env).


##### `CodexClient::spawn_stdio_with_env`  (lines 1536–1594)

```
fn spawn_stdio_with_env(
        codex_bin: &Path,
        config_overrides: &[String],
        environment: &[(OsString, OsString)],
    ) -> Result<Self>
```

**Purpose**: This is the full child-process launcher for standard-input communication. It can also add environment variables before starting the app-server.

**Data flow**: It receives a binary path, config overrides, and extra environment variables. It builds the command, pipes stdin and stdout, starts `codex app-server`, stores the child process and streams, and initializes the client's tracking fields.

**Call relations**: `CodexClient::spawn_stdio` calls this. Other test modules can use it when they need to start the app-server with special environment settings.

*Call graph*: called by 2 (spawn_client, run); 11 external calls (new, from, display, parent, inherit, piped, new, new, new, new (+1 more)).


##### `CodexClient::connect_websocket`  (lines 1596–1633)

```
fn connect_websocket(url: &str) -> Result<Self>
```

**Purpose**: This connects to an app-server over WebSocket, retrying briefly while the server starts. WebSocket is a network connection that carries messages both ways over one socket.

**Data flow**: It receives a URL string. It parses the URL, tries to connect until a ten-second deadline, then returns a client with an open WebSocket and fresh tracking state.

**Call relations**: `CodexClient::connect` uses this for `ConnectWs` endpoints. Commands that require a shared server depend on this path.

*Call graph*: 10 external calls (new, from_millis, from_secs, now, new, parse, new, new, sleep, connect).


##### `CodexClient::note_helper_output`  (lines 1635–1643)

```
fn note_helper_output(&mut self, output: &str)
```

**Purpose**: This records command output from the helper script used in the elicitation timeout test. It watches for a special “done” marker.

**Data flow**: It receives a chunk of command output, appends it to an accumulated stream, and flips `helper_done_seen` to true if the completion marker appears.

**Call relations**: `CodexClient::stream_turn` calls this when output deltas or completed command output arrive. Later validation in `live_elicitation_timeout_pause` reads the recorded flags and output.

*Call graph*: called by 1 (stream_turn).


##### `CodexClient::initialize`  (lines 1645–1647)

```
fn initialize(&mut self) -> Result<InitializeResponse>
```

**Purpose**: This performs the standard app-server initialize handshake with experimental API support enabled. The handshake tells the server who the client is and what features it wants.

**Data flow**: It takes the client state, calls `initialize_with_experimental_api(true)`, and returns the server's initialize response.

**Call relations**: Most command flows call this through their `CodexClient` before making other requests. It is a convenience wrapper around the more configurable initializer.

*Call graph*: calls 1 internal fn (initialize_with_experimental_api).


##### `CodexClient::initialize_with_experimental_api`  (lines 1649–1685)

```
fn initialize_with_experimental_api(
        &mut self,
        experimental_api: bool,
    ) -> Result<InitializeResponse>
```

**Purpose**: This performs the app-server initialize handshake and lets the caller choose whether experimental protocol features are enabled.

**Data flow**: It creates a request id, builds an initialize request with client info and capabilities, sends it, then sends the follow-up `initialized` notification required to complete the handshake. It returns the server response.

**Call relations**: `CodexClient::initialize` calls this, and message-sending code calls it directly when it needs to control the experimental flag. It uses `send_request` and `write_jsonrpc_message`.

*Call graph*: calls 3 internal fn (request_id, send_request, write_jsonrpc_message); called by 1 (initialize); 2 external calls (Notification, env!).


##### `CodexClient::thread_start`  (lines 1687–1695)

```
fn thread_start(&mut self, params: ThreadStartParams) -> Result<ThreadStartResponse>
```

**Purpose**: This asks the app-server to create a new conversation thread. A thread is the container that holds one or more turns.

**Data flow**: It receives thread-start parameters, creates a unique request id, sends a `thread/start` request, and returns the decoded thread-start response.

**Call relations**: Message and plugin turn flows call this after initialization. It relies on the generic `send_request` machinery.

*Call graph*: calls 2 internal fn (request_id, send_request); called by 1 (run_plugin_turn).


##### `CodexClient::thread_resume`  (lines 1697–1705)

```
fn thread_resume(&mut self, params: ThreadResumeParams) -> Result<ThreadResumeResponse>
```

**Purpose**: This asks the app-server to reopen an existing thread by id. It lets tests continue a prior conversation.

**Data flow**: It receives resume parameters, creates a request id, sends a `thread/resume` request, and returns the decoded response.

**Call relations**: Resume commands call this after initialization. It uses `send_request` for the actual JSON-RPC exchange.

*Call graph*: calls 2 internal fn (request_id, send_request).


##### `CodexClient::turn_start`  (lines 1707–1715)

```
fn turn_start(&mut self, params: TurnStartParams) -> Result<TurnStartResponse>
```

**Purpose**: This starts a new turn in a thread. A turn is one user message plus the app-server's work to answer it.

**Data flow**: It receives turn parameters such as thread id, input text, approval policy, sandbox policy, model effort, and working directory. It sends `turn/start` and returns the server's turn response.

**Call relations**: Message flows, follow-up flows, approval tests, live elicitation tests, and plugin turn flows call this after creating or resuming a thread.

*Call graph*: calls 2 internal fn (request_id, send_request); called by 1 (run_plugin_turn).


##### `CodexClient::login_account_chatgpt`  (lines 1717–1727)

```
fn login_account_chatgpt(&mut self) -> Result<LoginAccountResponse>
```

**Purpose**: This starts the browser-style ChatGPT account login flow. It asks the server for a login id and authorization URL.

**Data flow**: It creates a request id, sends `account/login/start` with ChatGPT browser-login parameters, and returns the login response.

**Call relations**: `test_login` calls this when device-code mode is not requested. The completion is later watched with `wait_for_account_login_completion`.

*Call graph*: calls 2 internal fn (request_id, send_request).


##### `CodexClient::login_account_chatgpt_device_code`  (lines 1729–1737)

```
fn login_account_chatgpt_device_code(&mut self) -> Result<LoginAccountResponse>
```

**Purpose**: This starts the device-code ChatGPT login flow. Device-code login gives the user a short code to enter on a verification page.

**Data flow**: It creates a request id, sends `account/login/start` with device-code parameters, and returns the login response containing the code and verification URL.

**Call relations**: `test_login` calls this when the device-code option is enabled. The same completion-waiting function is used afterward.

*Call graph*: calls 2 internal fn (request_id, send_request).


##### `CodexClient::get_account_rate_limits`  (lines 1739–1747)

```
fn get_account_rate_limits(&mut self) -> Result<GetAccountRateLimitsResponse>
```

**Purpose**: This sends the protocol request that reads current account rate-limit information.

**Data flow**: It creates a request id, sends `account/rateLimits/read` with no extra parameters, and returns the decoded rate-limit response.

**Call relations**: The `get_account_rate_limits` command wrapper calls this after initialization. It uses `send_request` for request writing and response waiting.

*Call graph*: calls 2 internal fn (request_id, send_request).


##### `CodexClient::model_list`  (lines 1749–1757)

```
fn model_list(&mut self, params: ModelListParams) -> Result<ModelListResponse>
```

**Purpose**: This sends the protocol request that lists available models.

**Data flow**: It receives model-list parameters, creates a request id, sends `model/list`, and returns the decoded model-list response.

**Call relations**: The `model_list` command wrapper calls this. It is one of the simple one-request flows built on `send_request`.

*Call graph*: calls 2 internal fn (request_id, send_request).


##### `CodexClient::thread_list`  (lines 1759–1767)

```
fn thread_list(&mut self, params: ThreadListParams) -> Result<ThreadListResponse>
```

**Purpose**: This sends the protocol request that lists stored threads using the requested filters and limit.

**Data flow**: It receives thread-list parameters, creates a request id, sends `thread/list`, and returns the decoded thread-list response.

**Call relations**: The `thread_list` command wrapper calls this after initialization. It uses the same generic request path as other client methods.

*Call graph*: calls 2 internal fn (request_id, send_request).


##### `CodexClient::thread_increment_elicitation`  (lines 1769–1780)

```
fn thread_increment_elicitation(
        &mut self,
        params: ThreadIncrementElicitationParams,
    ) -> Result<ThreadIncrementElicitationResponse>
```

**Purpose**: This sends the protocol request to increase a thread's elicitation pause counter.

**Data flow**: It receives the thread id wrapped in increment parameters, creates a request id, sends `thread/increment_elicitation`, and returns the decoded response.

**Call relations**: `thread_increment_elicitation` calls this after connecting and initializing. It uses `send_request`.

*Call graph*: calls 2 internal fn (request_id, send_request).


##### `CodexClient::thread_decrement_elicitation`  (lines 1782–1793)

```
fn thread_decrement_elicitation(
        &mut self,
        params: ThreadDecrementElicitationParams,
    ) -> Result<ThreadDecrementElicitationResponse>
```

**Purpose**: This sends the protocol request to decrease a thread's elicitation pause counter.

**Data flow**: It receives the thread id wrapped in decrement parameters, creates a request id, sends `thread/decrement_elicitation`, and returns the decoded response.

**Call relations**: `thread_decrement_elicitation` and the live elicitation harness use this for cleanup or manual counter changes.

*Call graph*: calls 2 internal fn (request_id, send_request).


##### `CodexClient::wait_for_account_login_completion`  (lines 1795–1821)

```
fn wait_for_account_login_completion(
        &mut self,
        expected_login_id: &str,
    ) -> Result<AccountLoginCompletedNotification>
```

**Purpose**: This waits until the server reports that a specific login attempt finished. It ignores unrelated login completions.

**Data flow**: It receives the expected login id. It repeatedly reads notifications, converts them into server notification types, returns the matching account-login completion, and prints rate-limit updates along the way.

**Call relations**: `test_login` calls this after starting a login flow. It depends on `next_notification` to read the mixed stream of server messages.

*Call graph*: calls 1 internal fn (next_notification); 2 external calls (try_from, println!).


##### `CodexClient::stream_turn`  (lines 1823–1917)

```
fn stream_turn(&mut self, thread_id: &str, turn_id: &str) -> Result<()>
```

**Purpose**: This reads and prints server notifications for one turn until that turn completes. It also answers approval requests and records command output/status details needed by tests.

**Data flow**: It receives the expected thread id and turn id. It reads notifications, prints message deltas and item events, tracks command execution output and status, notes early unexpected items, saves final turn status and error text, and stops when the target turn completes.

**Call relations**: Many message and test flows call this after `turn_start`, including plugin turn flows. It uses `next_notification`, `note_helper_output`, and `item_started_before_helper_done_is_unexpected`.

*Call graph*: calls 3 internal fn (next_notification, note_helper_output, item_started_before_helper_done_is_unexpected); called by 1 (run_plugin_turn); 5 external calls (try_from, matches!, print!, println!, stdout).


##### `CodexClient::stream_notifications_forever`  (lines 1919–1923)

```
fn stream_notifications_forever(&mut self) -> Result<()>
```

**Purpose**: This keeps consuming server notifications without stopping. It is for watch-style commands.

**Data flow**: It takes the client state and repeatedly calls `next_notification`. The messages are read and handled, and the loop only ends if reading fails or the process is interrupted.

**Call relations**: `watch` and `thread_resume_follow` call this after initialization or thread resume.

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

**Purpose**: This is the generic request-response wrapper for all client-initiated JSON-RPC calls. It also creates a tracing span for the request.

**Data flow**: It receives a typed client request, request id, and method name. It writes the request, waits for the matching response, decodes the response body into the requested type, and returns it.

**Call relations**: Most `CodexClient` protocol methods call this. Internally it writes via `write_request` and waits through `wait_for_response`.

*Call graph*: called by 16 (get_account_rate_limits, initialize_with_experimental_api, login_account_chatgpt, login_account_chatgpt_device_code, model_list, thread_decrement_elicitation, thread_increment_elicitation, thread_list, thread_resume, thread_start (+6 more)); 1 external calls (info_span!).


##### `CodexClient::write_request`  (lines 1948–1957)

```
fn write_request(&mut self, request: &ClientRequest) -> Result<()>
```

**Purpose**: This serializes a typed client request into the exact JSON-RPC request sent to the app-server. It also attaches trace context so server-side work can be linked to the client trace.

**Data flow**: It receives a `ClientRequest`, converts it into a JSON-RPC request, adds the current W3C trace context when available, prints a pretty version for humans, and writes the compact JSON payload to the transport.

**Call relations**: `send_request` uses this before waiting for a response. It calls `print_multiline_with_prefix` and `write_payload`.

*Call graph*: calls 2 internal fn (write_payload, print_multiline_with_prefix); 5 external calls (current_span_w3c_trace_context, from_value, to_string, to_string_pretty, to_value).


##### `CodexClient::wait_for_response`  (lines 1959–1986)

```
fn wait_for_response(&mut self, request_id: RequestId, method: &str) -> Result<T>
```

**Purpose**: This waits for the response that matches one outstanding request id. It safely deals with other messages that arrive while waiting.

**Data flow**: It receives the expected request id and method name. It reads JSON-RPC messages until it sees the matching response or error, stores unrelated notifications for later, handles server requests immediately, and returns the decoded response payload.

**Call relations**: `send_request` calls this after writing a request. It uses `read_jsonrpc_message` and may call `handle_server_request` if the server asks for approval mid-wait.

*Call graph*: calls 2 internal fn (handle_server_request, read_jsonrpc_message); 3 external calls (push_back, bail!, from_value).


##### `CodexClient::next_notification`  (lines 1988–2007)

```
fn next_notification(&mut self) -> Result<JSONRPCNotification>
```

**Purpose**: This returns the next server notification, using any notifications saved earlier before reading new data. Notifications are one-way messages from the server.

**Data flow**: It first checks the pending-notification queue. If empty, it reads JSON-RPC messages until it finds a notification, ignoring stray responses and answering server requests as needed.

**Call relations**: Streaming and login-waiting functions call this. It uses `read_jsonrpc_message` and `handle_server_request`.

*Call graph*: calls 2 internal fn (handle_server_request, read_jsonrpc_message); called by 3 (stream_notifications_forever, stream_turn, wait_for_account_login_completion); 1 external calls (pop_front).


##### `CodexClient::read_jsonrpc_message`  (lines 2009–2025)

```
fn read_jsonrpc_message(&mut self) -> Result<JSONRPCMessage>
```

**Purpose**: This reads one raw transport payload and parses it as a JSON-RPC message. It also prints the incoming JSON in a readable format.

**Data flow**: It repeatedly reads payloads until it gets non-empty text, parses the text as JSON, prints the formatted JSON, converts it into a `JSONRPCMessage`, and returns it.

**Call relations**: `wait_for_response` and `next_notification` call this whenever they need the next incoming message. It relies on `read_payload` for the transport-specific read.

*Call graph*: calls 2 internal fn (read_payload, print_multiline_with_prefix); called by 2 (next_notification, wait_for_response); 3 external calls (from_str, from_value, to_string_pretty).


##### `CodexClient::request_id`  (lines 2027–2029)

```
fn request_id(&self) -> RequestId
```

**Purpose**: This creates a fresh unique id for a JSON-RPC request. The id lets the client match a later response to the request that caused it.

**Data flow**: It reads no outside input and returns a string request id based on a newly generated UUID.

**Call relations**: Every typed request method calls this before sending through `send_request`.

*Call graph*: called by 16 (get_account_rate_limits, initialize_with_experimental_api, login_account_chatgpt, login_account_chatgpt_device_code, model_list, thread_decrement_elicitation, thread_increment_elicitation, thread_list, thread_resume, thread_start (+6 more)); 2 external calls (new_v4, String).


##### `CodexClient::handle_server_request`  (lines 2031–2048)

```
fn handle_server_request(&mut self, request: JSONRPCRequest) -> Result<()>
```

**Purpose**: This handles requests that the server sends back to the client, such as asking whether a command or file change is allowed. These are different from notifications because the server expects an answer.

**Data flow**: It receives a raw JSON-RPC request, converts it into a typed server request, routes command approvals and file-change approvals to the right handler, and errors on unsupported request types.

**Call relations**: `wait_for_response` and `next_notification` call this whenever a server request appears in the message stream.

*Call graph*: calls 2 internal fn (approve_file_change_request, handle_command_execution_request_approval); called by 2 (next_notification, wait_for_response); 2 external calls (try_from, bail!).


##### `CodexClient::handle_command_execution_request_approval`  (lines 2050–2124)

```
fn handle_command_execution_request_approval(
        &mut self,
        request_id: RequestId,
        params: CommandExecutionRequestApprovalParams,
    ) -> Result<()>
```

**Purpose**: This answers a server request asking whether a proposed command may run. It can always accept, or cancel at a configured approval count for testing.

**Data flow**: It receives a request id and approval details. It prints the command, reason, permissions, and policy amendments, updates approval counters, chooses accept or cancel based on `command_approval_behavior`, sends the response, and records the decision.

**Call relations**: `handle_server_request` calls this for command-execution approval requests. It replies through `send_server_request_response`.

*Call graph*: calls 1 internal fn (send_server_request_response); called by 1 (handle_server_request); 1 external calls (println!).


##### `CodexClient::approve_file_change_request`  (lines 2126–2156)

```
fn approve_file_change_request(
        &mut self,
        request_id: RequestId,
        params: FileChangeRequestApprovalParams,
    ) -> Result<()>
```

**Purpose**: This answers a server request asking whether a file change may proceed. In this test client, file changes are automatically accepted.

**Data flow**: It receives a request id and file-change approval details. It prints the thread, turn, item, reason, and grant root, sends an accept response, and returns success.

**Call relations**: `handle_server_request` calls this for file-change approval requests. It sends the protocol reply with `send_server_request_response`.

*Call graph*: calls 1 internal fn (send_server_request_response); called by 1 (handle_server_request); 1 external calls (println!).


##### `CodexClient::send_server_request_response`  (lines 2158–2167)

```
fn send_server_request_response(&mut self, request_id: RequestId, response: &T) -> Result<()>
```

**Purpose**: This sends a JSON-RPC response to a request that originally came from the server. It is how the client answers approval prompts.

**Data flow**: It receives the server's request id and a serializable response body. It wraps the body in a JSON-RPC response message and writes it to the transport.

**Call relations**: Both approval handlers call this. It delegates serialization and output to `write_jsonrpc_message`.

*Call graph*: calls 1 internal fn (write_jsonrpc_message); called by 2 (approve_file_change_request, handle_command_execution_request_approval); 2 external calls (Response, to_value).


##### `CodexClient::write_jsonrpc_message`  (lines 2169–2174)

```
fn write_jsonrpc_message(&mut self, message: JSONRPCMessage) -> Result<()>
```

**Purpose**: This writes any complete JSON-RPC message, such as a notification or response, to the server. It prints a readable copy first.

**Data flow**: It receives a JSON-RPC message, serializes it to compact JSON for transport and pretty JSON for display, prints the pretty version, then writes the compact payload.

**Call relations**: `initialize_with_experimental_api` uses this for the `initialized` notification, and `send_server_request_response` uses it for approval replies.

*Call graph*: calls 2 internal fn (write_payload, print_multiline_with_prefix); called by 2 (initialize_with_experimental_api, send_server_request_response); 2 external calls (to_string, to_string_pretty).


##### `CodexClient::write_payload`  (lines 2176–2195)

```
fn write_payload(&mut self, payload: &str) -> Result<()>
```

**Purpose**: This sends a raw JSON string over the active transport. It hides whether the connection is standard input/output or WebSocket.

**Data flow**: It receives a payload string. For standard input, it writes a line and flushes it; for WebSocket, it sends a text frame. It returns an error if the transport is closed or writing fails.

**Call relations**: `write_request` and `write_jsonrpc_message` call this after they have serialized a JSON-RPC message.

*Call graph*: called by 2 (write_jsonrpc_message, write_request); 3 external calls (bail!, Text, writeln!).


##### `CodexClient::read_payload`  (lines 2197–2223)

```
fn read_payload(&mut self) -> Result<String>
```

**Purpose**: This reads one raw message payload from the active transport. It hides the difference between line-based standard output and WebSocket frames.

**Data flow**: It reads one line from child stdout for standard-input mode, or loops over WebSocket frames until it gets text. It returns the text payload, or an error if the server closes the connection.

**Call relations**: `read_jsonrpc_message` calls this before parsing incoming JSON.

*Call graph*: called by 1 (read_jsonrpc_message); 2 external calls (new, bail!).


##### `print_multiline_with_prefix`  (lines 2226–2230)

```
fn print_multiline_with_prefix(prefix: &str, payload: &str)
```

**Purpose**: This prints multi-line text with a prefix on every line. It makes request and response logs easy to scan, with outgoing messages marked differently from incoming ones.

**Data flow**: It receives a prefix and payload text. It splits the payload into lines and prints each line with that prefix.

**Call relations**: Request-writing and message-reading helpers call this when showing pretty JSON to the user.

*Call graph*: called by 3 (read_jsonrpc_message, write_jsonrpc_message, write_request); 1 external calls (println!).


##### `TestClientTracing::initialize`  (lines 2238–2269)

```
async fn initialize(config_overrides: &[String]) -> Result<Self>
```

**Purpose**: This sets up tracing for the test client using the same configuration system as the rest of Codex. Tracing means recording timing and context so a run can be inspected later in observability tools.

**Data flow**: It receives config override strings, parses them, loads the Codex config, builds an OpenTelemetry provider when configured, installs a tracing subscriber if traces are enabled, and returns whether tracing is active.

**Call relations**: `with_client` calls this before opening a client connection. The result is used to capture and print a trace summary.

*Call graph*: calls 1 internal fn (build_provider); called by 1 (with_client); 3 external calls (load_with_cli_overrides, env!, registry).


##### `TraceSummary::capture`  (lines 2279–2287)

```
fn capture(traces_enabled: bool) -> Self
```

**Purpose**: This captures a short human-readable trace link if tracing is enabled. If tracing is off or no trace context is available, it records that tracing is disabled.

**Data flow**: It receives a boolean saying whether traces are enabled. If false, it returns `Disabled`; otherwise it reads the current W3C trace context and tries to turn it into a trace URL.

**Call relations**: `with_client` calls this inside the command tracing span. It uses `trace_url_from_context` to build the link.

*Call graph*: 1 external calls (current_span_w3c_trace_context).


##### `trace_url_from_context`  (lines 2290–2301)

```
fn trace_url_from_context(trace: &W3cTraceContext) -> Option<String>
```

**Purpose**: This extracts the trace id from a W3C trace context and formats it as an internal trace URL. W3C trace context is a standard header format for connecting logs and traces across services.

**Data flow**: It receives a trace context, reads the `traceparent` string, splits it into its standard parts, checks that the trace id has the expected length, and returns `go/trace/<id>` if valid.

**Call relations**: `TraceSummary::capture` calls this when traces are enabled and a trace context exists.

*Call graph*: 1 external calls (format!).


##### `print_trace_summary`  (lines 2303–2309)

```
fn print_trace_summary(trace_summary: &TraceSummary)
```

**Purpose**: This prints the trace information for a command run. It tells the user either where to find the Datadog trace or how to enable tracing.

**Data flow**: It receives a `TraceSummary`. If it contains a URL, it prints it; otherwise it prints a fixed disabled-tracing message.

**Call relations**: `with_client` calls this after the command-specific client work finishes.

*Call graph*: called by 1 (with_client); 1 external calls (println!).


##### `CodexClient::drop`  (lines 2312–2340)

```
fn drop(&mut self)
```

**Purpose**: This cleans up a child app-server process when a standard-input client is dropped. It gives the process a short chance to exit gracefully before killing it.

**Data flow**: When the client is discarded, it checks whether the transport owns a child process. If so, it closes stdin, waits up to a timeout for exit, prints the exit status if available, and kills the process if it is still running.

**Call relations**: Rust calls this automatically when a `CodexClient` goes out of scope. It only affects clients created by spawning `codex app-server`; WebSocket clients do not own the server process.

*Call graph*: 3 external calls (now, println!, sleep).


### `app-server-test-client/src/plugin_analytics_smoke.rs`

`test` · `smoke test run`

This is a safety check for plugin analytics. Analytics are records of important actions, such as “this plugin was enabled” or “this plugin was used.” If this test failed or did not exist, the app could silently stop reporting those actions, and people looking at plugin usage data would get wrong or incomplete information.

The file works like a small test harness. First it prepares a fresh capture file, which is just a temporary log where analytics events are written as JSON lines. It also creates a temporary user config file so the test can change plugin settings without touching a real user’s setup. Then it starts a loopback responses server, meaning a local fake model server that answers requests without needing a real external model provider.

Next it launches the Codex binary as a child process with special environment variables and config overrides. It asks the server which plugins are installed, checks that the target plugin is present and usable, writes config changes to disable and re-enable it, and starts a short turn that mentions the plugin. Finally it repeatedly reads the analytics capture file until the required events appear, then validates their identity fields and important metadata. The repeated polling matters because analytics and plugin bundle readiness can be asynchronous, like waiting for a receipt to appear after a checkout.

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

**Purpose**: Runs the whole plugin analytics smoke test from start to finish. It sets up temporary files and fake services, launches Codex, performs plugin actions, then checks the analytics output.

**Data flow**: It receives the path to the Codex binary, config override strings, the plugin id to test, and optionally a capture-file path. It creates or cleans the capture file, builds a temporary config, starts a mock responses server, launches Codex with the right environment, drives plugin disable/enable/use actions, reads captured analytics events, validates them, and prints a short success report. The result is success if all required events are present and correct, or an error explaining what went wrong.

**Call relations**: This is the main coordinator for the file. It calls the setup helpers first, then uses the client-facing helpers to ask about installed plugins and change config, then waits for plugin usage and analytics validation before returning to the outer test runner.

*Call graph*: calls 12 internal fn (spawn_stdio_with_env, start, create, expected_plugin, plugin_installed, prepare_capture_file, smoke_config_overrides, validate_plugin_events, wait_for_plugin_events, wait_for_plugin_usage (+2 more)); called by 1 (run); 2 external calls (println!, vec!).


##### `run_plugin_turn`  (lines 97–124)

```
fn run_plugin_turn(client: &mut CodexClient, expected: &ExpectedPlugin) -> Result<String>
```

**Purpose**: Starts one temporary Codex conversation turn that mentions the expected plugin. This is how the test causes a real plugin-use analytics event to be produced.

**Data flow**: It takes a live Codex client and the expected plugin details. It creates an ephemeral thread, starts a turn whose user input mentions the plugin by name and plugin URL, streams the turn until completion, and returns the new turn id. If the turn does not finish successfully, it returns an error with the last known status and error message.

**Call relations**: It is called by `wait_for_plugin_usage` during retry attempts. It hands back a turn id so the caller can look in the analytics capture file for events belonging to that exact turn.

*Call graph*: calls 3 internal fn (stream_turn, thread_start, turn_start); called by 1 (wait_for_plugin_usage); 4 external calls (default, new, bail!, vec!).


##### `wait_for_plugin_usage`  (lines 126–157)

```
fn wait_for_plugin_usage(
    client: &mut CodexClient,
    capture_path: &Path,
    expected: &ExpectedPlugin,
) -> Result<()>
```

**Purpose**: Keeps trying short plugin turns until the remote plugin is actually usable and a plugin-used event appears. This protects the smoke test from failing just because a remote plugin bundle is still warming up.

**Data flow**: It receives a Codex client, the analytics capture path, and expected plugin details. On each attempt it runs a plugin turn, waits until analytics for that turn arrive, and checks whether those events include `codex_plugin_used` for the expected plugin id. It returns when usage is confirmed, or fails after the timeout.

**Call relations**: The top-level `run` function calls this after enabling the plugin. Internally it calls `run_plugin_turn` to trigger behavior and `wait_for_turn_analytics` to use the completed turn event as a sign that analytics for that attempt have flushed.

*Call graph*: calls 2 internal fn (run_plugin_turn, wait_for_turn_analytics); called by 1 (run); 4 external calls (now, bail!, println!, sleep).


##### `plugin_installed`  (lines 166–179)

```
fn plugin_installed(client: &mut CodexClient) -> Result<PluginInstalledResponse>
```

**Purpose**: Asks the Codex app server for its installed plugin list. The smoke test needs this to prove the target plugin exists before testing its analytics.

**Data flow**: It takes a mutable Codex client, creates a request id, sends a `PluginInstalled` request with default query parameters, and returns the structured plugin-installed response. If the server rejects or fails the request, the error is returned.

**Call relations**: The top-level `run` function calls this soon after initialization. Its response is passed to `expected_plugin`, which checks that the target plugin is the one the rest of the test should exercise.

*Call graph*: calls 2 internal fn (request_id, send_request); called by 1 (run).


##### `expected_plugin`  (lines 181–221)

```
fn expected_plugin(response: &PluginInstalledResponse, plugin_id: &str) -> Result<ExpectedPlugin>
```

**Purpose**: Finds and checks the one plugin that this smoke test is supposed to test. It makes sure the plugin is installed, enabled, available, and connected to a remote plugin id.

**Data flow**: It receives the full installed-plugin response and the desired local plugin id. It searches all marketplaces for matching plugins, requires exactly one match, checks several health flags, and returns a compact `ExpectedPlugin` record with the plugin id, display name, and marketplace name. If anything is missing or ambiguous, it returns an error.

**Call relations**: It is called by `run` after `plugin_installed`. The returned expected identity is then used by config-writing, turn-running, and event-validation code so every later check is tied to the same plugin.

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

**Purpose**: Writes a plugin enabled-or-disabled setting into the temporary config file through the app server. This is how the test deliberately triggers plugin disabled and enabled analytics events.

**Data flow**: It takes a Codex client, a config file path, a plugin id, and a boolean enabled value. It sends a config write request for `plugins.<id>.enabled`, replacing the value in the chosen config file. It prints the write status and succeeds only if the server reports that the write was accepted normally.

**Call relations**: The top-level `run` function calls it twice: first to disable the plugin, then to enable it again. Those two writes are expected to create the `codex_plugin_disabled` and `codex_plugin_enabled` analytics events later validated by the file.

*Call graph*: calls 2 internal fn (request_id, send_request); called by 1 (run); 5 external calls (display, bail!, format!, json!, println!).


##### `smoke_config_overrides`  (lines 257–279)

```
fn smoke_config_overrides(responses_base_url: &str) -> Result<Vec<String>>
```

**Purpose**: Builds the config override strings needed to run this smoke test in a controlled environment. These overrides turn on plugin and analytics features and point model traffic at the local fake responses server.

**Data flow**: It receives the base URL of the loopback responses server. It formats that into a provider URL and returns a list of config assignments: analytics enabled, plugin features enabled, mock model and provider names, wire API choice, no OpenAI auth, and zero retries. If string serialization fails, it returns an error.

**Call relations**: The top-level `run` function extends the caller’s config overrides with these smoke-test-specific settings before launching the Codex child process.

*Call graph*: called by 1 (run); 3 external calls (format!, to_string, vec!).


##### `quoted`  (lines 281–283)

```
fn quoted(value: &str) -> Result<String>
```

**Purpose**: Turns a plain string into a JSON-quoted string suitable for use inside config override text. This avoids broken config when values contain characters that need escaping.

**Data flow**: It receives a string slice, serializes it as a JSON string, and returns the quoted text or an error. For example, a bare name becomes a properly quoted value that can be embedded in an override.

**Call relations**: It is used while building smoke-test config overrides, so model and provider names are written in a safe, parseable form.

*Call graph*: 1 external calls (to_string).


##### `prepare_capture_file`  (lines 285–304)

```
fn prepare_capture_file(path: &Path) -> Result<()>
```

**Purpose**: Makes sure the analytics capture file path is ready for a fresh test run. It removes any old file so previous events cannot be mistaken for new ones.

**Data flow**: It receives a path, checks that the path has an existing parent directory, and tries to delete any file already there. Missing old files are fine; missing parent directories or delete failures become errors. It does not create the new capture file itself.

**Call relations**: The top-level smoke runner calls this before launching Codex. Afterward, `wait_until_capture_is_ready` waits for the child process to create the actual capture file.

*Call graph*: called by 2 (run, run); 3 external calls (parent, bail!, remove_file).


##### `wait_until_capture_is_ready`  (lines 306–325)

```
fn wait_until_capture_is_ready(path: &Path) -> Result<()>
```

**Purpose**: Waits for the Codex child process to create the analytics capture file. This confirms that the debug analytics capture hook is active before the test starts making plugin actions.

**Data flow**: It receives a file path and repeatedly checks whether filesystem metadata exists for it. If the file appears before the short timeout, it returns success. If the file never appears, it returns an error suggesting that a debug Codex binary may be needed.

**Call relations**: The top-level `run` function calls it right after spawning Codex and before initialization. Later analytics-reading helpers assume this capture file is where events will be written.

*Call graph*: called by 2 (run, run); 4 external calls (now, bail!, metadata, sleep).


##### `wait_for_plugin_events`  (lines 327–349)

```
fn wait_for_plugin_events(path: &Path, plugin_id: &str) -> Result<Vec<Value>>
```

**Purpose**: Polls the analytics capture file until all required plugin event types have appeared for the chosen plugin. It gives asynchronous analytics time to be written.

**Data flow**: It receives the capture-file path and plugin id. It repeatedly reads plugin-specific events and checks for at least one disabled, enabled, and used event. It returns the collected events once all are present, or fails with a timeout message showing which event types were found.

**Call relations**: The top-level `run` function calls this after plugin usage has been confirmed. It relies on `read_plugin_events` to filter the capture file and on `required_event_types` to know what the smoke test must see.

*Call graph*: calls 2 internal fn (read_plugin_events, required_event_types); called by 1 (run); 3 external calls (now, bail!, sleep).


##### `wait_for_turn_analytics`  (lines 351–369)

```
fn wait_for_turn_analytics(path: &Path, turn_id: &str) -> Result<Vec<Value>>
```

**Purpose**: Waits until analytics for a specific turn have been captured. In this file, that turn event acts like a checkpoint showing that analytics for an attempted plugin use have caught up.

**Data flow**: It receives the capture path and a turn id. It repeatedly reads all capture events and looks for a `codex_turn_event` whose parameters contain that turn id. It returns the current events once found, or fails if the timeout expires.

**Call relations**: It is called by `wait_for_plugin_usage` after each attempted plugin turn. The returned events are then inspected for a plugin-used event tied to the same turn.

*Call graph*: calls 1 internal fn (read_capture_events); called by 1 (wait_for_plugin_usage); 3 external calls (now, bail!, sleep).


##### `read_plugin_events`  (lines 371–376)

```
fn read_plugin_events(path: &Path, plugin_id: &str) -> Result<Vec<Value>>
```

**Purpose**: Reads the analytics capture file and keeps only events whose plugin id matches the plugin being tested. This keeps later checks focused on the relevant plugin.

**Data flow**: It receives the capture-file path and plugin id. It calls `read_capture_events` to parse all events, filters them by `event_params.plugin_id`, and returns the matching JSON event values.

**Call relations**: It feeds `wait_for_plugin_events`, which repeatedly calls it while waiting for the disabled, enabled, and used events to appear.

*Call graph*: calls 1 internal fn (read_capture_events); called by 1 (wait_for_plugin_events).


##### `read_capture_events`  (lines 378–404)

```
fn read_capture_events(path: &Path) -> Result<Vec<Value>>
```

**Purpose**: Loads and parses the analytics capture file into individual event objects. The capture file is JSON Lines format, meaning each line is a separate JSON payload.

**Data flow**: It receives a path. If the file does not exist yet, it returns an empty list. Otherwise it reads the file as text, skips blank lines, parses each line as JSON, extracts the line’s `events` array, and appends those events into one list. Bad file reads, bad JSON, or missing `events` arrays become errors with context.

**Call relations**: It is the shared reader for both plugin-level waiting and turn-level waiting. Higher-level helpers build their specific checks on top of this raw capture parsing.

*Call graph*: called by 2 (read_plugin_events, wait_for_turn_analytics); 3 external calls (new, read_to_string, from_str).


##### `validate_plugin_events`  (lines 406–427)

```
fn validate_plugin_events(events: Vec<Value>, expected: &ExpectedPlugin) -> Result<Vec<Value>>
```

**Purpose**: Performs the final correctness check on the captured plugin analytics events. It verifies not just that events exist, but that exactly one of each required type exists and that their important fields are correct.

**Data flow**: It receives the plugin-related events and the expected plugin identity. For each required event type, it finds matching events, requires exactly one, validates plugin identity fields, and for the used event also validates extra usage metadata. It returns the validated events for printing.

**Call relations**: The top-level `run` function calls it after `wait_for_plugin_events` has collected enough events. It delegates detailed field checks to `validate_identity` and `validate_used_metadata`.

*Call graph*: calls 3 internal fn (required_event_types, validate_identity, validate_used_metadata); called by 1 (run); 2 external calls (new, bail!).


##### `required_event_types`  (lines 429–435)

```
fn required_event_types() -> [&'static str; 3]
```

**Purpose**: Defines the three analytics events this smoke test requires: plugin disabled, plugin enabled, and plugin used. Keeping them in one place makes the waiting and validation steps agree.

**Data flow**: It takes no input and returns a fixed array of event type names. The values are used as the checklist for polling and final validation.

**Call relations**: Both the waiting code and the validation code call this, so they are checking the same required set rather than maintaining two separate lists.

*Call graph*: called by 2 (validate_plugin_events, wait_for_plugin_events).


##### `event_count`  (lines 437–442)

```
fn event_count(events: &[Value], event_type: &str) -> usize
```

**Purpose**: Counts how many captured events have a particular event type. It is a small helper for deciding whether enough events have arrived.

**Data flow**: It receives a slice of JSON event values and an event type string. It scans the events, compares each event’s `event_type` field to the requested type, and returns the count.

**Call relations**: It supports the polling logic that waits for required plugin analytics events. Its output is used as a simple yes/no signal: has at least one of this type appeared yet?

*Call graph*: 1 external calls (iter).


##### `validate_identity`  (lines 444–449)

```
fn validate_identity(event: &Value, expected: &ExpectedPlugin) -> Result<()>
```

**Purpose**: Checks that an analytics event describes the exact plugin and marketplace expected by the test. This catches cases where an event exists but belongs to the wrong plugin or has wrong labels.

**Data flow**: It receives one JSON event and the expected plugin details. It looks inside `event_params` and requires matching `plugin_id`, `plugin_name`, and `marketplace_name` string fields. It returns success only if all three match.

**Call relations**: It is called by `validate_plugin_events` for every required event. It uses `require_string` for the repeated field-by-field comparison work.

*Call graph*: calls 1 internal fn (require_string); called by 1 (validate_plugin_events).


##### `validate_used_metadata`  (lines 451–467)

```
fn validate_used_metadata(event: &Value) -> Result<()>
```

**Purpose**: Checks the extra fields that must be present on a plugin-used analytics event. These fields describe the context of the usage, such as the turn, thread, model, and plugin resources.

**Data flow**: It receives one JSON event. It inspects `event_params` and fails if required fields such as `thread_id`, `turn_id`, `connector_ids`, or `mcp_server_count` are missing or null. It also requires `model_slug` to equal the mock model slug used by this smoke test.

**Call relations**: It is called only by `validate_plugin_events` when validating the `codex_plugin_used` event. It uses `require_string` for the exact model-slug check.

*Call graph*: calls 1 internal fn (require_string); called by 1 (validate_plugin_events); 1 external calls (bail!).


##### `require_string`  (lines 469–475)

```
fn require_string(params: &Value, field: &str, expected: &str) -> Result<()>
```

**Purpose**: Checks that a JSON object has a named string field with an exact expected value. It gives clearer error messages than a bare comparison would.

**Data flow**: It receives a JSON value, a field name, and the expected string. It reads the field, treats non-string or missing values as no match, and returns success only when the actual string equals the expected one. Otherwise it returns an error saying what was expected and what was found.

**Call relations**: It is the shared low-level checker used by `validate_identity` and `validate_used_metadata` so those functions can express their checks clearly.

*Call graph*: called by 2 (validate_identity, validate_used_metadata); 2 external calls (get, bail!).


##### `TemporaryConfigFile::create`  (lines 482–490)

```
fn create() -> Result<Self>
```

**Purpose**: Creates an empty temporary config file for the smoke test. This lets the test write plugin settings without changing a real user configuration file.

**Data flow**: It builds a path in the system temp directory using the current process id, writes an empty file at that path, and returns a `TemporaryConfigFile` wrapper holding the path. If the file cannot be written, it returns an error with the path included.

**Call relations**: The top-level `run` function calls this during setup. The resulting object provides the config path for environment setup and later config write requests, and its drop behavior cleans the file up.

*Call graph*: called by 1 (run); 3 external calls (format!, write, temp_dir).


##### `TemporaryConfigFile::path`  (lines 492–494)

```
fn path(&self) -> &Path
```

**Purpose**: Returns the path of the temporary config file. Other parts of the smoke test use this path when launching Codex and writing plugin settings.

**Data flow**: It receives the temporary config wrapper by reference and returns a borrowed path reference. It does not read, write, or change the file.

**Call relations**: The setup and config-writing parts of `run` call this when they need to pass the same temporary config file path to the child process or to config write requests.


##### `TemporaryConfigFile::drop`  (lines 498–500)

```
fn drop(&mut self)
```

**Purpose**: Deletes the temporary config file when the wrapper goes out of scope. This is cleanup code, like throwing away scratch paper after the test is done.

**Data flow**: It receives the wrapper during automatic cleanup and attempts to remove the file at its stored path. Any deletion error is ignored, because cleanup failure should not hide the main test result.

**Call relations**: Rust calls this automatically when `TemporaryConfigFile` is dropped, normally at the end of `run` or during early error unwinding. It complements `TemporaryConfigFile::create` by removing the file it made.

*Call graph*: 1 external calls (remove_file).


### `app-server-test-client/src/plugin_analytics_mutation_smoke.rs`

`test` · `manual smoke test and cleanup`

This file exists to test a risky but important path: changing plugin state on a real account and proving that analytics records those changes correctly. A “smoke test” is a broad end-to-end check that asks, “does the whole thing basically work?” Here, the whole thing includes starting the Codex app server, reading a remote plugin from the marketplace, installing it, waiting until the server reports it as installed, uninstalling it, and checking the captured analytics file.

The file is careful because it mutates account state. It refuses to run unless the caller explicitly confirms that account mutation is allowed. It also requires the chosen plugin to start out uninstalled, so the test can safely restore the original state afterward.

The flow is like borrowing a tool from a shared workshop: first make sure you are allowed to touch it, record where everything is, take the tool out, confirm the checkout was logged, put it back, and confirm the shelf is clean again. If anything goes wrong, the code tries to clean up by uninstalling the plugin. If cleanup cannot be verified, it prints a recovery command so a human can fix the account state.

It also distinguishes between backend state and local cleanup problems. For example, the plugin may truly be uninstalled on the backend even if the uninstall request reports an error afterward. The file reports those cases separately so failures are easier to diagnose.

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

**Purpose**: Runs the full analytics mutation smoke test. It starts a Codex client with analytics capture enabled, installs and uninstalls a remote plugin, validates the captured analytics, and then makes sure the plugin is left uninstalled.

**Data flow**: It receives the Codex binary path, configuration overrides, the remote plugin id, a confirmation value, and optionally a capture-file path. It first refuses to continue without confirmation, prepares the analytics capture file, starts the app server, reads the plugin, checks that it is safe to mutate, runs the install/uninstall sequence, and then attempts cleanup. It returns success only when analytics were validated and the original uninstalled state was restored; otherwise it returns an error and prints a failure category and recovery guidance.

**Call relations**: This is the main driver for the smoke test. It calls require_confirmation before touching the account, uses spawn_client to start the test server, uses read_remote_plugin and validate_initial_plugin to confirm the starting state, delegates the core install/uninstall check to run_mutation_sequence, and always follows with restore_uninstalled_state. When cleanup leaves uncertainty or a dirty account, it calls print_dirty_recovery or print_recovery_command to tell the operator what to do next.

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

**Purpose**: Runs only the cleanup path: it tries to make sure a remote plugin is uninstalled. This is used when the full smoke test failed or when a human wants to restore the account state directly.

**Data flow**: It receives the Codex binary path, configuration overrides, the remote plugin id, and the required confirmation. It adds plugin-related configuration, starts a Codex client without analytics capture, initializes it, and asks restore_uninstalled_state to remove the plugin if needed. It prints success if the plugin is uninstalled, or returns an error if cleanup failed or could not be verified.

**Call relations**: This is a smaller companion to run. It still calls require_confirmation because it mutates account state, then relies on restore_uninstalled_state for the actual cleanup. If the plugin still appears installed, it calls print_dirty_recovery so the user gets the same recovery instructions as in the full smoke test.

*Call graph*: calls 4 internal fn (spawn_stdio, print_dirty_recovery, require_confirmation, restore_uninstalled_state); called by 1 (run); 2 external calls (eprintln!, println!).


##### `AccountMutationConfirmation::from_flag`  (lines 163–169)

```
fn from_flag(confirm_account_mutation: bool) -> Self
```

**Purpose**: Turns a command-line confirmation flag into a small internal value that says whether account mutation was explicitly approved. This keeps the safety check clear and consistent.

**Data flow**: It takes a boolean from the caller, where true means the user supplied the confirmation flag. It returns AccountMutationConfirmation::Confirmed for true and AccountMutationConfirmation::Missing for false. It does not change anything else.

**Call relations**: This is used before run or run_cleanup receive their confirmation value. Those later functions pass the value to require_confirmation, which is the gate that stops accidental install and uninstall operations.

*Call graph*: called by 1 (run).


##### `require_confirmation`  (lines 172–179)

```
fn require_confirmation(confirmation: AccountMutationConfirmation) -> Result<()>
```

**Purpose**: Protects the active account from accidental changes. It refuses to continue unless the caller has explicitly confirmed that installing and uninstalling a plugin is allowed.

**Data flow**: It receives an AccountMutationConfirmation value. If the value says confirmation is missing, it returns an error with instructions to rerun using the confirmation flag. If confirmation is present, it returns success and changes nothing.

**Call relations**: Both run and run_cleanup call this before making any request that could change plugin state. It is the safety latch for this file: without it, a developer could accidentally mutate their active account just by running the wrong smoke-test command.

*Call graph*: called by 2 (run, run_cleanup); 2 external calls (bail!, matches!).


##### `ExpectedInstalledState::is_installed`  (lines 188–190)

```
fn is_installed(self) -> bool
```

**Purpose**: Converts the expected plugin state into a simple true-or-false answer. It lets polling code compare “installed” versus “uninstalled” against the server’s boolean status.

**Data flow**: It receives an ExpectedInstalledState value. It returns true for Installed and false for Uninstalled. It has no side effects.

**Call relations**: wait_for_installed_state calls this while repeatedly reading the plugin from the server. This small helper keeps the waiting loop readable: the loop can compare the server’s installed flag directly to the expected state.

*Call graph*: called by 1 (wait_for_installed_state); 1 external calls (matches!).


##### `spawn_client`  (lines 193–209)

```
fn spawn_client(
    codex_bin: &Path,
    config_overrides: &[String],
    capture_path: &Path,
) -> Result<CodexClient>
```

**Purpose**: Starts the Codex app server test client with the exact settings needed for this analytics smoke test. It enables analytics, plugins, and remote plugins, and points analytics capture at a chosen file.

**Data flow**: It receives the Codex binary path, existing configuration overrides, and the analytics capture path. It copies the overrides, adds required feature flags, creates an environment variable that tells the server where to write captured analytics events, and returns a spawned CodexClient connected over standard input and output.

**Call relations**: run calls this after preparing the capture file. The returned client is then initialized and used for all plugin read, install, and uninstall requests in the test.

*Call graph*: calls 1 internal fn (spawn_stdio_with_env); called by 1 (run); 1 external calls (vec!).


##### `read_remote_plugin`  (lines 222–257)

```
fn read_remote_plugin(
    client: &mut CodexClient,
    remote_plugin_id: &str,
) -> Result<RemotePluginExpectation>
```

**Purpose**: Asks the app server for information about one remote plugin and packages the important fields into a test-friendly structure. It also checks that the server returned the same remote plugin id that was requested.

**Data flow**: It receives a mutable CodexClient and a remote plugin id. It sends a plugin/read request using the remote marketplace hint, reads the response, verifies the returned remote id is present and matches the requested id, and returns the plugin’s local id, remote id, name, marketplace name, installed flag, install policy, and availability. If the response is missing or mismatched, it returns an error.

**Call relations**: run uses this to inspect the starting plugin state. wait_for_installed_state uses it repeatedly while polling for a state change. restore_uninstalled_state uses it to decide whether cleanup is needed at all.

*Call graph*: calls 2 internal fn (request_id, send_request); called by 3 (restore_uninstalled_state, run, wait_for_installed_state); 1 external calls (bail!).


##### `validate_initial_plugin`  (lines 259–275)

```
fn validate_initial_plugin(plugin: &RemotePluginExpectation, remote_plugin_id: &str) -> Result<()>
```

**Purpose**: Checks that the chosen plugin is safe and meaningful for the smoke test. The test only makes sense if the plugin starts uninstalled and is available to install.

**Data flow**: It receives the plugin details read from the server and the requested remote plugin id. It returns an error if the plugin is already installed, unavailable, or marked as not installable. If all checks pass, it returns success without changing anything.

**Call relations**: run calls this immediately after read_remote_plugin. It prevents the mutation sequence from starting in a bad state, especially one where the test could uninstall a plugin the user already had installed before the test began.

*Call graph*: called by 1 (run); 1 external calls (bail!).


##### `run_mutation_sequence`  (lines 282–338)

```
fn run_mutation_sequence(
    client: &mut CodexClient,
    capture_path: &Path,
    expected: &RemotePluginExpectation,
) -> MutationSequenceResult
```

**Purpose**: Performs the core test: install the remote plugin, wait for the installed state, wait for the install analytics event, uninstall the plugin, and validate the full set of mutation analytics events.

**Data flow**: It receives the client, the analytics capture-file path, and the expected plugin identity. It sends an install request, waits until the server reports the plugin installed, waits until the install event appears in the capture file, sends an uninstall request, waits until the server reports the plugin uninstalled, then reads and validates the captured analytics events. It returns either the validated event data or an error, plus a flag saying whether the uninstall request itself reported failure.

**Call relations**: run delegates the risky middle of the smoke test to this function. Inside the sequence it uses install_remote_plugin, uninstall_remote_plugin, wait_for_installed_state, wait_for_remote_plugin_event, read_events_for_remote_plugin, and validate_mutation_events. The extra uninstall failure flag lets run report a special case where the backend state became clean but the uninstall remote procedure call still failed.

*Call graph*: called by 1 (run).


##### `install_remote_plugin`  (lines 340–355)

```
fn install_remote_plugin(client: &mut CodexClient, plugin: &RemotePluginExpectation) -> Result<()>
```

**Purpose**: Sends the request that installs the chosen remote plugin. It is the test’s deliberate account mutation step.

**Data flow**: It receives the Codex client and the plugin details. It builds a plugin/install request using the plugin’s marketplace name and remote plugin id, sends it to the server, and returns success if the server accepts the install response. It does not itself wait for the installed state; it only sends the command.

**Call relations**: run_mutation_sequence uses this at the start of the mutation sequence. After it returns, the sequence calls wait_for_installed_state because installation may not be visible immediately.

*Call graph*: calls 2 internal fn (request_id, send_request).


##### `uninstall_remote_plugin`  (lines 357–370)

```
fn uninstall_remote_plugin(client: &mut CodexClient, remote_plugin_id: &str) -> Result<()>
```

**Purpose**: Sends the request that uninstalls a remote plugin. It is used both during the smoke test and during cleanup.

**Data flow**: It receives the Codex client and a remote plugin id. It builds a plugin/uninstall request, sends it to the server, and returns success if the uninstall response is accepted. It does not itself prove the plugin is gone; callers verify that separately.

**Call relations**: run_mutation_sequence uses this after the install event has been observed. restore_uninstalled_state also calls it when cleanup finds the plugin still installed. In both cases, callers follow up with wait_for_installed_state to check what actually happened.

*Call graph*: calls 2 internal fn (request_id, send_request); called by 1 (restore_uninstalled_state).


##### `wait_for_installed_state`  (lines 372–392)

```
fn wait_for_installed_state(
    client: &mut CodexClient,
    remote_plugin_id: &str,
    expected_state: ExpectedInstalledState,
) -> Result<RemotePluginExpectation>
```

**Purpose**: Waits until the server reports that a plugin is either installed or uninstalled. This accounts for delays between sending a request and seeing the new state.

**Data flow**: It receives the client, the remote plugin id, and the desired installed state. Until a timeout is reached, it repeatedly calls read_remote_plugin, compares the returned installed flag to the expected state, and sleeps briefly between attempts. It returns the latest plugin details when the expected state appears, or an error if the timeout expires.

**Call relations**: run_mutation_sequence calls this after install and after uninstall to confirm each mutation really took effect. restore_uninstalled_state calls it during cleanup to verify that an uninstall actually left the account clean. It uses ExpectedInstalledState::is_installed to compare the enum-like expected state to the server’s boolean value.

*Call graph*: calls 2 internal fn (is_installed, read_remote_plugin); called by 1 (restore_uninstalled_state); 3 external calls (now, bail!, sleep).


##### `restore_uninstalled_state`  (lines 401–433)

```
fn restore_uninstalled_state(
    client: &mut CodexClient,
    remote_plugin_id: &str,
) -> RestorationStatus
```

**Purpose**: Tries to leave the account in the safe final state: the remote plugin is uninstalled. It classifies cleanup results so callers can tell the difference between a clean account, a local/reporting problem, a dirty account, and an unknown state.

**Data flow**: It receives the client and remote plugin id. It first reads the current plugin state. If the plugin is already uninstalled, it returns Clean. If it is installed, it sends an uninstall request and waits for the server to report uninstalled. Depending on whether the uninstall request and final state check succeeded, it returns Clean, LocalCleanupFailure, Dirty, or Unknown with the relevant error.

**Call relations**: run calls this after the main mutation sequence no matter whether the sequence passed or failed. run_cleanup uses it as its main operation. It relies on read_remote_plugin, uninstall_remote_plugin, and wait_for_installed_state, then hands a clear status back to the caller so the caller can print the right failure message or recovery command.

*Call graph*: calls 3 internal fn (read_remote_plugin, uninstall_remote_plugin, wait_for_installed_state); called by 2 (run, run_cleanup); 4 external calls (anyhow!, Dirty, LocalCleanupFailure, Unknown).


##### `wait_for_remote_plugin_event`  (lines 435–451)

```
fn wait_for_remote_plugin_event(
    path: &Path,
    remote_plugin_id: &str,
    event_type: &str,
) -> Result<()>
```

**Purpose**: Waits until a specific analytics event for a remote plugin appears in the capture file. This prevents the test from racing ahead before analytics has had time to write the event.

**Data flow**: It receives the capture-file path, the remote plugin id, and the event type to look for. Until a timeout is reached, it reads captured events for that plugin and checks whether any event has the requested event_type. It returns success when the event appears, or an error if it never shows up in time.

**Call relations**: run_mutation_sequence uses this after installing the plugin, specifically to wait for the codex_plugin_installed event. Later, the sequence reads all plugin events and passes them to validate_mutation_events for stricter validation.

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

**Purpose**: Prints a clear warning when cleanup did not leave the account in the expected uninstalled state. It also prints a command the user can run to try the cleanup again.

**Data flow**: It receives the Codex binary path, configuration overrides, the remote plugin id, and the cleanup error. It writes a failure message to standard error explaining that the plugin still appears installed, then calls print_recovery_command to show a ready-to-copy cleanup command. It returns nothing.

**Call relations**: run and run_cleanup call this when restore_uninstalled_state reports a Dirty result. It delegates the exact command formatting to print_recovery_command so both full-test and cleanup failures give consistent instructions.

*Call graph*: calls 1 internal fn (print_recovery_command); called by 2 (run, run_cleanup); 1 external calls (eprintln!).


##### `print_recovery_command`  (lines 465–483)

```
fn print_recovery_command(codex_bin: &Path, config_overrides: &[String], remote_plugin_id: &str)
```

**Purpose**: Builds and prints a command-line instruction for manually uninstalling the remote plugin through this test client. This helps a human recover the account if the automated cleanup could not prove success.

**Data flow**: It receives the Codex binary path, configuration overrides, and remote plugin id. It finds the current test-client executable when possible, quotes command parts so paths and values with spaces are safer to copy, appends the cleanup subcommand and confirmation flag, and prints the final command to standard error.

**Call relations**: print_dirty_recovery calls this for dirty cleanup failures, and run calls it directly when the final state cannot be verified. It is the last-resort handoff from automation to a human operator.

*Call graph*: called by 2 (print_dirty_recovery, run); 3 external calls (eprintln!, format!, current_exe).
