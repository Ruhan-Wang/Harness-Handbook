# Cross-cutting library tests, fixtures, and telemetry or rollout support  `stage-23.6`

This stage is the project’s shared test workshop. It is not one user-facing flow. Instead, it checks many behind-the-scenes parts that other areas depend on: reporting, settings, add-ons, service connections, saved state, and small utility helpers.

The analytics and telemetry tests make sure activity is measured, labeled, filtered, and exported safely. Configuration and policy tests check that startup settings, enterprise rules, sandboxes, permissions, paths, and environment variables are read and enforced correctly. Plugin, extension, skills, MCP, and tool tests protect the add-on system, so extra abilities are found, loaded, displayed, and called predictably. API, model, prompt, and transport tests verify fake network clients, login, streaming, prompt text, schemas, proxies, sockets, and security setup. Memories, rollout, state, and persistence tests check saved conversations, replay logs, databases, recovery, and stored memory files. Utility tests cover file URI handling and safe shortening of long output.

The directly included files add entry points and focused checks: integration test wiring, mock Cloud Tasks access, test rendering hooks, goal token accounting, file watching, hook output spilling, line buffering, terminal detection, UTF-8 string truncation, image preparation, and image-loading performance.

## Sub-stages

- [Analytics and telemetry tests](stage-23.6.1.md) `stage-23.6.1` — 18 files
- [Configuration, policy, and environment tests](stage-23.6.2.md) `stage-23.6.2` — 43 files
- [Plugins, extensions, skills, MCP, and tools tests](stage-23.6.3.md) `stage-23.6.3` — 50 files
- [API clients, models, protocol, prompts, and transport support tests](stage-23.6.4.md) `stage-23.6.4` — 38 files
- [Memories, rollout, state, and persistence tests](stage-23.6.5.md) `stage-23.6.5` — 26 files
- [Utility crate tests for path/URI and output truncation helpers](stage-23.6.6.md) `stage-23.6.6` — 3 files

## Files in this stage

### Chatgpt test harness
These files define the integration-test entrypoint and suite aggregation for the chatgpt crate.

### `chatgpt/tests/all.rs`

`test` · `test startup`

This is a small but important test wiring file. In Rust, integration tests are often built as separate test programs. Instead of creating many separate test binaries, this project uses one combined test binary and pulls the real test modules into it with `mod suite;`. Think of it like a table of contents: the actual test chapters live elsewhere, but this file tells the test runner where to start reading. Without this file, the tests under `tests/suite/` would not be included through this integration test target, so running the full test suite could miss them. There is no test logic here and no helper code. Its job is simply to connect Rust’s test runner to the organized test suite directory.


### `chatgpt/tests/suite/mod.rs`

`test` · `test startup`

This file is very small, but it plays an important organizing role. In Rust, a `mod` line is like putting a labeled folder into the current test suite: it says, “also compile and run the tests found in this module.” Here, the file gathers former standalone integration tests under one suite by including `apply_command_e2e`. Without this file, those tests might sit in the repository but not be connected to the suite that Rust is asked to run. There is no runtime logic here and no functions to call. Its job is purely structural: it helps the test runner discover the right test code during test compilation.


### Support fixtures and namespaces
These files provide shared test-support scaffolding and placeholder module roots used by other library code and tests.

### `cloud-tasks-mock-client/src/lib.rs`

`orchestration` · `compile time and crate import`

This is a small but important “front desk” file for the mock client library. The real work lives in a separate internal module called `mock`, but outside users of the crate should not have to know that. Instead, this file declares that the `mock` module exists, then publicly re-exports `MockClient` from it.

In plain terms, it turns an internal item into the crate’s main public product. Without this file, code that depends on this crate would either be unable to access `MockClient`, or would need to reach into internal module paths that the crate author may not want to promise will stay stable.

The mock client is likely used in tests or local development as a stand-in for Google Cloud Tasks, so code can be exercised without contacting the real cloud service. This file does not create tasks, send requests, or store data itself. Its job is simply to make the mock client easy and clean to import, like putting the useful tool on the counter instead of making every user search through the workshop drawers.


### `core/src/apps/mod.rs`

`test` · `test build and test execution`

This is a very small module file. In Rust, a `mod.rs` file is like a table of contents for a folder: it tells the compiler which child modules belong under that folder. Here, it declares a single child module named `render`, but only when tests are being built. The `#[cfg(test)]` line means “include the next item only during test builds.” In everyday terms, this is like keeping a testing tool in the workshop cabinet and only taking it out when you are checking the machine, not when shipping the machine to users.

Without this file, the `render` test module under `core/src/apps` would not be visible to Rust’s test build, so those tests would not be compiled or run. It does not define application behavior for normal runs. Its job is simply to make test code available at the right time and keep it out of production builds.


### Focused subsystem correctness tests
These files cover targeted unit and integration tests for accounting, buffering, output spilling, terminal detection, file watching, and string truncation behavior.

### `ext/goal/tests/accounting.rs`

`test` · `test run`

This is a small test file for the goal accounting code. In this project, token usage is a running set of numbers that says how much input and output a model has used. The important problem here is avoiding bad counting: if the system measures from the wrong starting point, it could overcharge, undercount, or flush the wrong amount of usage later.

The tests create a fresh `GoalAccountingState`, start a named turn, and then report a later token usage snapshot for that same turn. The accounting code is expected to compare the later snapshot with the snapshot taken at the start of the turn, like reading an electricity meter before and after an appliance runs. The first test proves that the computed delta comes from that exact baseline.

The second test covers a special case: `Plan` mode. A plan-mode turn is treated as something that should not contribute to goal accounting. So even when token usage is later reported, the accounting code should return no recorded usage.

The helper function `token_usage` keeps the tests readable by building `TokenUsage` values from simple numbers.

#### Function details

##### `goal_accounting_uses_turn_start_baseline_for_exact_deltas`  (lines 12–36)

```
fn goal_accounting_uses_turn_start_baseline_for_exact_deltas()
```

**Purpose**: This test proves that token accounting measures a turn by comparing the current token totals against the totals captured when the turn began. It protects against accidental counting from zero or from some later, unrelated value.

**Data flow**: It starts with a fresh accounting state and a first token usage snapshot for `turn-1`. It then sends a second, larger usage snapshot for the same turn. The result is checked to make sure both the per-turn change and the unflushed thread change are exactly 28 tokens.

**Call relations**: During the test, it uses `token_usage` to build the two token snapshots in a readable way. It then relies on `GoalAccountingState` from the accounting module to do the real calculation, and uses an equality assertion to confirm the returned numbers match the expected delta.

*Call graph*: calls 2 internal fn (default, token_usage); 1 external calls (assert_eq!).


##### `goal_accounting_ignores_plan_mode_turns`  (lines 39–52)

```
fn goal_accounting_ignores_plan_mode_turns()
```

**Purpose**: This test proves that plan-mode turns are skipped by goal accounting. That matters because planning work should not be recorded as normal goal progress token usage.

**Data flow**: It creates a fresh accounting state, starts `turn-1` in `Plan` mode with empty token usage, and then reports a later nonzero token usage snapshot. Instead of returning a recorded delta, the accounting code should return `None`, meaning nothing was counted.

**Call relations**: The test uses `token_usage` to build the later usage snapshot and then calls into `GoalAccountingState` to see how plan mode is treated. The final assertion confirms that the accounting layer intentionally declines to record anything for this turn.

*Call graph*: calls 2 internal fn (default, token_usage); 2 external calls (assert_eq!, default).


##### `token_usage`  (lines 54–68)

```
fn token_usage(
    input_tokens: i64,
    cached_input_tokens: i64,
    output_tokens: i64,
    reasoning_output_tokens: i64,
    total_tokens: i64,
) -> TokenUsage
```

**Purpose**: This helper builds a `TokenUsage` record from five plain numbers. It keeps the tests focused on the accounting behavior instead of repeating struct-building code each time.

**Data flow**: It receives values for input tokens, cached input tokens, output tokens, reasoning output tokens, and total tokens. It places those values into a `TokenUsage` structure and returns it unchanged.

**Call relations**: Both test functions call this helper when they need a token usage snapshot. It does not perform any accounting itself; it only prepares the input data that the accounting state will compare.

*Call graph*: called by 2 (goal_accounting_ignores_plan_mode_turns, goal_accounting_uses_turn_start_baseline_for_exact_deltas).


### `file-watcher/src/file_watcher_tests.rs`

`test` · `test run`

A file watcher is like a shared doorbell for the file system. Different parts of the program can say, “tell me when this path changes,” and the watcher should ring only the right doorbells, not flood everyone with repeated or irrelevant noise. This test file protects that behavior.

The tests cover two ways of smoothing event bursts. A throttled receiver sends the first change quickly, then waits before sending more. A debounced receiver waits briefly so nearby changes can be bundled together. Several tests make sure both still deliver pending changes when the sender shuts down.

The file also checks how registrations work. If the same subscriber asks for the same path twice, the watcher should count that correctly and not over-watch the operating system. When a registration or subscriber is dropped, the watch should be removed. If a requested path does not exist yet, the watcher falls back to watching the nearest existing parent directory, then moves closer when the missing file or folder appears.

Other tests verify matching rules: recursive watches include children, non-recursive watches do not include grandchildren, and parent-directory events can still notify a watch on a child path when that is needed. Finally, the tests ensure the event loop ignores harmless access events and only reports file-system events that actually change something.

#### Function details

##### `path`  (lines 11–13)

```
fn path(name: &str) -> PathBuf
```

**Purpose**: This small helper turns a plain string like "a" or "/tmp/skills" into a path object used by the watcher tests. It keeps the test code short and easy to read.

**Data flow**: It receives a text path name, wraps it as a `PathBuf` value, and returns that path. It does not touch the file system; it only builds an in-memory path value.

**Call relations**: Many tests call this helper when they need example paths for fake watcher events or expected results. It feeds those path values into watcher registration, simulated change events, and equality checks.

*Call graph*: called by 7 (debounced_receiver_coalesces_each_event_batch, debounced_receiver_flushes_pending_on_shutdown, matching_subscribers_are_notified, non_recursive_watch_ignores_grandchildren, spawn_event_loop_filters_non_mutating_events, throttled_receiver_coalesces_within_interval, throttled_receiver_flushes_pending_on_shutdown); 1 external calls (from).


##### `notify_event`  (lines 15–21)

```
fn notify_event(kind: EventKind, paths: Vec<PathBuf>) -> Event
```

**Purpose**: This helper builds a fake raw file-system event for tests. It lets a test say what kind of event happened and which paths it affected without relying on the real operating system to produce that event.

**Data flow**: It receives an event kind, such as create or access, plus a list of paths. It creates a new notify event, attaches each path to it, and returns the finished event object.

**Call relations**: The event-loop filtering test uses this helper to send controlled raw events into the watcher. That lets the test compare harmless access events with real create events.

*Call graph*: called by 1 (spawn_event_loop_filters_non_mutating_events); 1 external calls (new).


##### `throttled_receiver_coalesces_within_interval`  (lines 24–52)

```
async fn throttled_receiver_coalesces_within_interval()
```

**Purpose**: This test proves that the throttled receiver sends one change promptly, then holds back later changes until its waiting period has passed. This prevents rapid file changes from becoming a flood of notifications.

**Data flow**: It creates a watch channel and wraps the receiving side in a throttled receiver. It sends path "a" and expects it to arrive quickly, then sends "b" and "c" and checks that they do not arrive too early but do arrive together after the throttle interval.

**Call relations**: The async test runner calls this test. Inside it, the test uses the `path` helper to build sample paths, then exercises `ThrottledWatchReceiver::new` and `recv` to verify the receiver’s timing contract.

*Call graph*: calls 2 internal fn (new, path); 3 external calls (from_secs, assert_eq!, timeout).


##### `throttled_receiver_flushes_pending_on_shutdown`  (lines 55–87)

```
async fn throttled_receiver_flushes_pending_on_shutdown()
```

**Purpose**: This test checks that a throttled receiver does not lose delayed changes when the sender closes. Pending work should be delivered before the receiver reports that the channel is closed.

**Data flow**: It sends an initial path and receives it. Then it sends another path, drops the sender to simulate shutdown, and expects the pending path to be returned before a final `None` result shows that no more events can arrive.

**Call relations**: The async test runner calls this test. It focuses on the shutdown path of `ThrottledWatchReceiver`, using `path` to create the watched paths and `timeout` to ensure the receiver neither hangs nor drops data.

*Call graph*: calls 2 internal fn (new, path); 3 external calls (from_secs, assert_eq!, timeout).


##### `debounced_receiver_coalesces_each_event_batch`  (lines 90–119)

```
async fn debounced_receiver_coalesces_each_event_batch()
```

**Purpose**: This test proves that the debounced receiver waits briefly and bundles nearby changes into one event. This is useful when one save operation creates several file-system events that should be treated as one change.

**Data flow**: It creates a watch channel and a debounced receiver. It sends "a" and expects it after the debounce wait. Then it sends "c", confirms nothing arrives halfway through the wait, sends "d", and expects both "c" and "d" together.

**Call relations**: The async test runner calls this test. It uses the `path` helper and the receiver’s `recv` method to show that new input during the quiet period is folded into the same outgoing event.

*Call graph*: calls 2 internal fn (new, path); 2 external calls (assert_eq!, timeout).


##### `debounced_receiver_flushes_pending_on_shutdown`  (lines 122–143)

```
async fn debounced_receiver_flushes_pending_on_shutdown()
```

**Purpose**: This test makes sure the debounced receiver still reports a pending change if the sender shuts down before the normal waiting period finishes. Shutdown should not silently erase file changes.

**Data flow**: It sends one path into the channel, drops the sender, then expects the receiver to return that path as an event. A later receive should return `None`, meaning the channel is fully closed.

**Call relations**: The async test runner calls this test. It checks the debounced receiver’s cleanup behavior rather than its normal timing behavior, using `timeout` so a broken close path fails quickly.

*Call graph*: calls 2 internal fn (new, path); 3 external calls (from_secs, assert_eq!, timeout).


##### `is_mutating_event_filters_non_mutating_event_kinds`  (lines 146–168)

```
fn is_mutating_event_filters_non_mutating_event_kinds()
```

**Purpose**: This test checks the rule that only file-system events which change something should be treated as meaningful changes. Creating and modifying count; merely opening or accessing a file does not.

**Data flow**: It builds sample notify events for create, modify, and access cases, feeds each one into `is_mutating_event`, and compares the returned true-or-false value with the expected answer.

**Call relations**: The normal test runner calls this test. It protects the filtering logic later used by the watcher event loop, so subscribers are not notified just because something looked at a file.

*Call graph*: 1 external calls (assert_eq!).


##### `register_dedupes_by_path_and_scope`  (lines 171–187)

```
fn register_dedupes_by_path_and_scope()
```

**Purpose**: This test checks that repeated registrations for the same path and same watch style are counted rather than duplicated. It also verifies that recursive and non-recursive watches are tracked separately.

**Data flow**: It creates temporary directories, starts a no-op watcher, and registers the same directory several ways. It then reads the watcher’s test-only watch counts and expects the counts to match the number and type of registrations.

**Call relations**: The test runner calls this test. It uses `FileWatcher::noop` so the test can inspect bookkeeping without relying on a live operating-system watcher.

*Call graph*: calls 1 internal fn (noop); 4 external calls (new, assert_eq!, create_dir, tempdir).


##### `watch_registration_drop_unregisters_paths`  (lines 190–202)

```
fn watch_registration_drop_unregisters_paths()
```

**Purpose**: This test proves that dropping an individual registration removes its watch. That matters because a stale watch would keep doing unnecessary work and could notify code that no longer cares.

**Data flow**: It creates a temporary directory, registers it with a no-op watcher, then drops the registration object. After that, the watcher’s test-only counts should show that the path is no longer watched.

**Call relations**: The test runner calls this test. It exercises the cleanup behavior attached to the registration object returned by a subscriber’s `register_path` call.

*Call graph*: calls 1 internal fn (noop); 4 external calls (new, assert_eq!, create_dir, tempdir).


##### `subscriber_drop_unregisters_paths`  (lines 205–218)

```
fn subscriber_drop_unregisters_paths()
```

**Purpose**: This test checks that dropping the subscriber itself removes all paths registered through that subscriber. A subscriber is the owner of its interests, so its watches should disappear when it goes away.

**Data flow**: It creates a subscriber inside a short scope, registers a path, then lets the subscriber go out of scope. The test expects the watcher to have no remaining watch count for that path.

**Call relations**: The test runner calls this test. It verifies subscriber-level cleanup, complementing the separate test that drops a single registration object.

*Call graph*: calls 1 internal fn (noop); 4 external calls (new, assert_eq!, create_dir, tempdir).


##### `missing_path_registers_nearest_existing_parent`  (lines 221–236)

```
fn missing_path_registers_nearest_existing_parent()
```

**Purpose**: This test checks what happens when code asks to watch a file that does not exist yet. The watcher should watch the nearest existing parent directory so it can notice when the missing target appears.

**Data flow**: It creates a temporary directory, names a missing child file, and registers that missing file non-recursively. The watcher should record a non-recursive watch on the temporary directory, not on the missing file itself; after dropping the registration, that fallback watch should disappear.

**Call relations**: The test runner calls this test. It protects the fallback behavior used for files like generated metadata or lock-adjacent files that may be created later.

*Call graph*: calls 1 internal fn (noop); 3 external calls (new, assert_eq!, tempdir).


##### `deeply_missing_path_registers_nearest_existing_directory_ancestor`  (lines 239–250)

```
fn deeply_missing_path_registers_nearest_existing_directory_ancestor()
```

**Purpose**: This test checks a harder missing-path case where part of the requested path is actually a file, not a directory. The watcher should climb back to a real existing directory instead of trying to watch an impossible path.

**Data flow**: It creates a temporary directory with a file named `refs`, then asks to watch a deeper path under that file. The watcher should fall back to watching the temporary directory non-recursively.

**Call relations**: The test runner calls this test. It exercises the same missing-path fallback logic as simpler tests, but with a path shape that could otherwise confuse parent lookup.

*Call graph*: calls 1 internal fn (noop); 4 external calls (new, assert_eq!, write, tempdir).


##### `receiver_closes_when_subscriber_drops`  (lines 253–263)

```
async fn receiver_closes_when_subscriber_drops()
```

**Purpose**: This test proves that a subscriber’s event receiver closes when the subscriber is dropped. Code waiting for events needs a clear signal that no more events will arrive.

**Data flow**: It creates a subscriber and receiver, drops the subscriber, then waits for the receiver to return `None`. That `None` is the channel’s closed signal.

**Call relations**: The async test runner calls this test. It checks the connection between subscriber lifetime and the receiving side of the watch channel.

*Call graph*: calls 1 internal fn (noop); 4 external calls (new, from_secs, assert_eq!, timeout).


##### `recursive_registration_downgrades_to_non_recursive_after_drop`  (lines 266–297)

```
fn recursive_registration_downgrades_to_non_recursive_after_drop()
```

**Purpose**: This test checks that when both recursive and non-recursive watches exist on the same path, removing the recursive one leaves the non-recursive watch in place. The watcher should downgrade instead of removing the path entirely.

**Data flow**: It creates a live watcher and registers the same directory first non-recursively and then recursively. It inspects the internal watched mode, drops the recursive registration, and expects the recorded mode to become non-recursive.

**Call relations**: The test runner calls this test. It reaches into watcher internals because the behavior is about exact operating-system watch mode, not just whether a subscriber receives an event.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert_eq!, create_dir, tempdir).


##### `unregister_holds_state_lock_until_unwatch_finishes`  (lines 300–350)

```
fn unregister_holds_state_lock_until_unwatch_finishes()
```

**Purpose**: This test guards against a race condition during unregistering. A race condition is when two threads overlap in a bad order; here, a new registration must not slip in while the old operating-system unwatch operation is only half finished.

**Data flow**: It registers a recursive watch, deliberately blocks the low-level watcher lock, then drops the registration on another thread. While unregistering is stuck, the test checks that the shared state write lock is held. A second thread tries to register the same path non-recursively, and after the block is released the final state should be a clean non-recursive watch.

**Call relations**: The test runner calls this test. It coordinates two spawned threads and the watcher’s locks to prove the unregister path keeps state changes in a safe order before another registration can proceed.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_eq!, create_dir, spawn, tempdir).


##### `matching_subscribers_are_notified`  (lines 353–379)

```
async fn matching_subscribers_are_notified()
```

**Purpose**: This test checks that only subscribers whose registered paths match a changed file receive the event. A watcher shared by many parts of the program must not notify unrelated listeners.

**Data flow**: It creates two subscribers, one for `/tmp/skills` and one for `/tmp/plugins`. It simulates a change under `/tmp/skills`, then expects the skills receiver to get that path and the plugins receiver to get nothing.

**Call relations**: The async test runner calls this test. It uses throttled receivers so the simulated event flows through the same delivery shape as normal watcher notifications.

*Call graph*: calls 3 internal fn (noop, new, path); 5 external calls (new, from_secs, assert_eq!, timeout, vec!).


##### `non_recursive_watch_ignores_grandchildren`  (lines 382–394)

```
async fn non_recursive_watch_ignores_grandchildren()
```

**Purpose**: This test verifies that a non-recursive watch does not report changes deeper than one level below the watched path. Non-recursive means “watch this folder itself and nearby direct entries,” not the whole tree.

**Data flow**: It registers `/tmp/skills` non-recursively, simulates a change at `/tmp/skills/nested/SKILL.md`, and expects no event to arrive within the timeout.

**Call relations**: The async test runner calls this test. It complements the matching-subscriber tests by checking the depth rule used when deciding whether a changed path belongs to a watch.

*Call graph*: calls 3 internal fn (noop, new, path); 4 external calls (new, assert_eq!, timeout, vec!).


##### `ancestor_events_notify_child_watches`  (lines 397–423)

```
async fn ancestor_events_notify_child_watches()
```

**Purpose**: This test checks that an event on a parent directory can notify a watch on a child file when that parent event may affect the child. Some operating systems report broad directory changes rather than exact file paths.

**Data flow**: It creates a real directory tree and a file, registers the file, then simulates an event on the parent skills directory. The receiver should get an event for that parent path.

**Call relations**: The async test runner calls this test. It verifies the path-matching logic that treats ancestor events as relevant to more specific child watches.

*Call graph*: calls 2 internal fn (noop, new); 8 external calls (new, from_secs, assert_eq!, create_dir, write, tempdir, timeout, vec!).


##### `missing_file_watch_reports_requested_path_when_parent_changes`  (lines 426–457)

```
async fn missing_file_watch_reports_requested_path_when_parent_changes()
```

**Purpose**: This test ensures that when a previously missing watched file appears, the subscriber is told about the requested file path, not just the parent directory used as a fallback. This gives callers the useful path they originally cared about.

**Data flow**: It registers a missing file, first simulates a sibling lock-file change and expects no event, then creates the missing file and simulates a parent-directory change. The receiver should report the missing file’s path as the changed path.

**Call relations**: The async test runner calls this test. It ties together missing-path fallback registration, parent-directory event handling, and final event rewriting to the requested path.

*Call graph*: calls 2 internal fn (noop, new); 7 external calls (new, from_secs, assert_eq!, write, tempdir, timeout, vec!).


##### `missing_file_watch_reports_requested_path_when_parent_delete_event_arrives`  (lines 460–499)

```
async fn missing_file_watch_reports_requested_path_when_parent_delete_event_arrives()
```

**Purpose**: This test checks that a fallback watch reports both creation and deletion of the requested missing-file target. The watcher should notice when the file comes into existence and when it disappears again.

**Data flow**: It registers a missing file, creates it, and simulates a parent event; the receiver should report the file path. Then it deletes the file, simulates another parent event, and again expects the same requested file path.

**Call relations**: The async test runner calls this test. It exercises the missing-file fallback flow across two state changes: absent to present, then present to absent.

*Call graph*: calls 2 internal fn (noop, new); 8 external calls (new, from_secs, assert_eq!, remove_file, write, tempdir, timeout, vec!).


##### `missing_directory_watch_moves_to_created_directory_for_child_events`  (lines 502–547)

```
async fn missing_directory_watch_moves_to_created_directory_for_child_events()
```

**Purpose**: This test verifies that a watch on a missing directory moves from the parent fallback to the actual directory once it is created. After that, changes inside the new directory should be reported normally.

**Data flow**: It registers a missing `skills` directory and confirms the watcher is temporarily watching the parent. After creating `skills` and simulating a parent change, it expects an event for `skills` and confirms the watcher moved to `skills`. Then it writes a child file and expects that child-file change to be reported.

**Call relations**: The async test runner calls this test. It checks the watcher’s ability to retarget a fallback watch as the file-system layout changes.

*Call graph*: calls 2 internal fn (noop, new); 8 external calls (new, from_secs, assert_eq!, create_dir, write, tempdir, timeout, vec!).


##### `spawn_event_loop_filters_non_mutating_events`  (lines 550–583)

```
async fn spawn_event_loop_filters_non_mutating_events()
```

**Purpose**: This test checks that the watcher’s event loop ignores raw file-system events that only access a file, while still forwarding events that create or change files. This reduces noisy, useless notifications.

**Data flow**: It creates a watcher, registers a recursive path, and starts a test event loop fed by a channel. It sends a fake access event and expects no subscriber event, then sends a fake create event and expects the changed path to arrive.

**Call relations**: The async test runner calls this test. It uses `notify_event` and `path` to build raw input for the event loop, then observes the subscriber receiver to confirm filtering is applied before delivery.

*Call graph*: calls 4 internal fn (noop, new, notify_event, path); 9 external calls (Open, new, from_secs, Access, Create, assert_eq!, unbounded_channel, timeout, vec!).


##### `dropping_live_watcher_releases_inner_watcher`  (lines 586–593)

```
async fn dropping_live_watcher_releases_inner_watcher()
```

**Purpose**: This test makes sure dropping a live `FileWatcher` releases its internal watcher object. That matters because unreleased internals can leak memory or keep operating-system watch resources open.

**Data flow**: It creates a live watcher, stores a weak reference to its internal shared object, then drops the watcher. The weak reference should no longer be upgradeable, proving the internal object was freed.

**Call relations**: The test runner calls this test. It focuses on the watcher’s ownership and cleanup behavior rather than event delivery.

*Call graph*: calls 1 internal fn (new); 2 external calls (downgrade, assert_eq!).


### `hooks/src/output_spill_tests.rs`

`test` · `test run`

Hooks can produce text that the system needs to show later. Small text is easy to carry around directly, but very large text can clutter the display or exceed practical limits. This test file checks the rule that decides between those two paths. Think of it like deciding whether to put a note directly in an email, or attach a long document and include only a link.

The tests create a temporary folder so they do not touch real user files. They build a HookOutputSpiller, which is the part of the hook system responsible for deciding whether output should remain inline or be “spilled” to disk. “Spilled” here means saved into a separate file, with the normal output replaced by a short explanation that points to that file.

One test feeds in the word “short” and confirms that nothing is written to the output folder. The other test creates a much larger string, sends it through the same path, checks that the returned text says the output was truncated, extracts the saved file path from that message, and confirms that the file contains the original full text. These tests matter because they protect both usability and data safety: users should see small hook results normally, and they should not lose large hook results just because the display was shortened.

#### Function details

##### `small_hook_output_remains_inline`  (lines 7–22)

```
async fn small_hook_output_remains_inline() -> Result<()>
```

**Purpose**: This test proves that a small amount of hook output is returned exactly as-is. It also checks that the system does not create a hook-output folder when there is nothing large enough to save separately.

**Data flow**: It starts with a fresh temporary directory, builds the expected hook output location inside it, and creates a HookOutputSpiller that would use that location if needed. It sends in a new thread identifier and the text “short”. The result should be the same text, and the output directory should still be absent.

**Call relations**: During the test run, the async test runner calls this function. The function sets up a clean temporary workspace, calls the spiller’s text decision path, and then uses assertions to confirm the small-output behavior stayed simple and inline.

*Call graph*: calls 2 internal fn (new, from_absolute_path); 3 external calls (assert!, assert_eq!, tempdir).


##### `large_hook_output_spills_to_file`  (lines 25–42)

```
async fn large_hook_output_spills_to_file() -> Result<()>
```

**Purpose**: This test proves that large hook output is not returned in full directly. Instead, it should be shortened in the visible response and saved completely to a file.

**Data flow**: It creates a fresh temporary directory and a long repeated text string. It gives that text to a HookOutputSpiller. The returned value should contain a truncation notice and a line naming the file where the full output was saved. The test reads that file back and confirms its contents exactly match the original long text.

**Call relations**: During the test run, the async test runner calls this function. The function drives the same spilling path used for real hook output, then follows the file path reported by that path to verify that the handoff from inline text to saved file worked correctly.

*Call graph*: calls 2 internal fn (new, from_absolute_path); 3 external calls (assert!, assert_eq!, tempdir).


### `ollama/src/line_buffer_tests.rs`

`test` · `test run`

Network and file data often arrive in chunks, not neat full lines. A line buffer is like a waiting tray: it keeps partial text until a newline arrives, then hands back one complete line. This test makes sure that behavior works correctly when the first chunks do not contain a newline.

The test starts with an empty `LineBuffer`. It adds the bytes for `partial`, asks for a line, and expects nothing back because there is no newline yet. It then checks the buffer’s internal state: the bytes are still saved, and `scanned_len` records that those bytes have already been searched.

Next it adds more bytes, ` line`, and again expects no complete line. The saved text becomes `partial line`, and the scanned length grows with it. Finally it adds `\nnext`. Now the newline completes the first line, so `take_line` returns `partial line\n`. The remaining bytes, `next`, stay in the buffer for later, and the scan counter resets because the leftover data has not yet been searched.

This matters because a buffer that repeatedly re-scans old partial data can become slow, especially when long lines arrive a little at a time.

#### Function details

##### `searches_only_new_bytes_after_partial_line`  (lines 7–42)

```
fn searches_only_new_bytes_after_partial_line()
```

**Purpose**: This test proves that `LineBuffer` remembers how much of its stored data it has already checked for a newline. It also verifies that once a complete line is found, the returned line is removed and the leftover bytes remain ready for the next read.

**Data flow**: The test begins with a fresh empty buffer. It feeds in byte chunks that first form an incomplete line, then later add a newline and extra following text. After each step, it asks the buffer for a complete line and compares both the returned value and the buffer’s saved internal state against the expected result.

**Call relations**: The test creates the buffer using the default constructor and uses equality assertions to compare what actually happened with what should happen. During a test run, the Rust test framework calls this function, and the assertions stop the test if the line buffer scans too much, returns a line too early, loses bytes, or fails to reset its scan position after taking a line.

*Call graph*: 2 external calls (assert_eq!, default).


### `terminal-detection/src/terminal_tests.rs`

`test` · `test run`

This is a test file. It builds small fake command-line environments and checks that the real detection code reads them correctly. A terminal program often leaves clues in environment variables, such as TERM_PROGRAM, TERM, WEZTERM_VERSION, or WT_SESSION. A multiplexer, such as tmux or Zellij, is like a terminal inside a terminal; it can hide the real terminal unless the code looks for extra clues. The tests here make sure those clues are interpreted in the right order.

The file starts with FakeEnvironment, a simple stand-in for the real operating-system environment. Instead of reading the user's actual machine, each test fills a map with only the variables it wants. That makes the tests predictable, like setting up a clean lab bench before each experiment. There is also a small terminal_info helper that creates the expected answer in a compact way.

The rest of the file is a broad checklist: iTerm2, Apple Terminal, Ghostty, VS Code, Warp, tmux, Zellij, WezTerm, Kitty, Alacritty, Konsole, GNOME Terminal, VTE-based terminals, Windows Terminal, and plain TERM fallbacks. Each test asks the detector for a TerminalInfo result and also checks the user_agent_token string, because that string is what other parts of the system may send or log to describe the terminal.

#### Function details

##### `FakeEnvironment::new`  (lines 12–18)

```
fn new() -> Self
```

**Purpose**: Creates a blank fake environment for a test. Tests use it as a clean starting point so each case controls exactly which terminal clues exist.

**Data flow**: It starts with no inputs. It creates an empty variable map, default tmux client information, and no stored Zellij version. The result is a FakeEnvironment ready to be filled with test values.

**Call relations**: Most tests begin by calling this, then chain helper methods such as with_var or with_tmux_client_info before passing the fake environment into the real terminal detection function.

*Call graph*: called by 21 (detects_alacritty, detects_apple_terminal, detects_ghostty, detects_gnome_terminal, detects_iterm2, detects_kitty, detects_konsole, detects_term_fallbacks, detects_term_program, detects_tmux_client_termname (+11 more)); 2 external calls (new, default).


##### `FakeEnvironment::with_var`  (lines 20–23)

```
fn with_var(mut self, key: &str, value: &str) -> Self
```

**Purpose**: Adds one environment variable to the fake environment. This lets a test pretend that the operating system has set a specific clue, such as TERM_PROGRAM or TERM.

**Data flow**: It receives the current FakeEnvironment plus a variable name and value. It stores that name and value in the fake variable map, then returns the updated FakeEnvironment so the test can keep adding more values.

**Call relations**: Tests call this after FakeEnvironment::new to build the exact situation they want the detector to see. Later, FakeEnvironment::var reads back these stored values when detection asks for them.


##### `FakeEnvironment::with_tmux_client_info`  (lines 25–31)

```
fn with_tmux_client_info(mut self, termtype: Option<&str>, termname: Option<&str>) -> Self
```

**Purpose**: Sets fake information about the terminal outside tmux. This is needed because tmux can mask the real terminal, so the detector may need tmux client details to identify it.

**Data flow**: It receives optional tmux term type and term name strings. It turns any present values into owned strings, stores them in the fake tmux client info field, and returns the updated FakeEnvironment.

**Call relations**: Tmux-related tests call this before running detection. When the detection code asks the Environment for tmux client information, FakeEnvironment::tmux_client_info returns these prepared values.


##### `FakeEnvironment::with_zellij_version`  (lines 33–36)

```
fn with_zellij_version(mut self, version: &str) -> Self
```

**Purpose**: Stores a fake Zellij version as if it had been read from the Zellij command. This lets tests check the path where the detector learns Zellij's version outside normal environment variables.

**Data flow**: It receives the current FakeEnvironment and a version string. It saves that version in the fake Zellij version field and returns the updated FakeEnvironment.

**Call relations**: The Zellij command-version test uses this before detection. Later, FakeEnvironment::zellij_version gives this value to the detection code when it asks for the Zellij version.


##### `FakeEnvironment::var`  (lines 40–42)

```
fn var(&self, name: &str) -> Option<String>
```

**Purpose**: Imitates reading an environment variable from the operating system. Instead of touching the real machine, it looks in the fake map prepared by the test.

**Data flow**: It receives a variable name. It searches the fake variable map and returns a copy of the value if it exists, or nothing if it was not set.

**Call relations**: The production detection code calls this through the Environment trait whenever it needs a variable. It is the bridge between each test's setup and the detector's normal environment-reading behavior.


##### `FakeEnvironment::tmux_client_info`  (lines 44–46)

```
fn tmux_client_info(&self) -> TmuxClientInfo
```

**Purpose**: Imitates asking tmux what terminal its client is using. This helps tests cover cases where tmux is present and the visible environment variables are not enough.

**Data flow**: It takes no extra input beyond the fake environment. It returns a copy of the stored tmux client information so the detector can inspect term type and term name safely.

**Call relations**: The terminal detector calls this when it sees tmux-related clues. The tmux tests prepare its return value with FakeEnvironment::with_tmux_client_info.

*Call graph*: 1 external calls (clone).


##### `FakeEnvironment::zellij_version`  (lines 48–52)

```
fn zellij_version(&self) -> Option<String>
```

**Purpose**: Imitates discovering the Zellij version. It first uses a version explicitly stored by a test, and otherwise falls back to the ZELLIJ_VERSION environment variable when it is non-empty.

**Data flow**: It reads the fake environment's stored Zellij version. If that is absent, it asks the environment helper for a non-empty ZELLIJ_VERSION variable. It returns the version string if one can be found, or nothing otherwise.

**Call relations**: The detection code calls this when it suspects Zellij is running. Zellij tests use either with_var or with_zellij_version to check both ways the version can be found.


##### `terminal_info`  (lines 55–69)

```
fn terminal_info(
    name: TerminalName,
    term_program: Option<&str>,
    version: Option<&str>,
    term: Option<&str>,
    multiplexer: Option<Multiplexer>,
) -> TerminalInfo
```

**Purpose**: Builds an expected TerminalInfo value for assertions. It keeps the tests readable by avoiding repeated manual conversion from string slices to owned strings.

**Data flow**: It receives the expected terminal name, optional program name, optional version, optional TERM value, and optional multiplexer. It converts present string values into stored strings and returns a TerminalInfo struct.

**Call relations**: Many tests use this helper when comparing the detector's output to the expected answer. The is_zellij test also uses it to create small sample TerminalInfo values.

*Call graph*: called by 1 (terminal_info_reports_is_zellij).


##### `detects_term_program`  (lines 72–136)

```
fn detects_term_program()
```

**Purpose**: Checks that TERM_PROGRAM is treated as a strong clue for the terminal app and that its version is included only when non-empty. It also verifies that TERM_PROGRAM takes priority over a WezTerm-specific variable when both are present.

**Data flow**: It builds fake environments containing TERM_PROGRAM, TERM_PROGRAM_VERSION, and sometimes WEZTERM_VERSION. Each environment is passed to the detector, and the returned TerminalInfo and user-agent token are compared with the expected values.

**Call relations**: This test starts from FakeEnvironment::new, fills variables with with_var, calls the real detector, and uses assertions to confirm the detector chooses iTerm2 information in the intended priority order.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `terminal_info_reports_is_zellij`  (lines 139–157)

```
fn terminal_info_reports_is_zellij()
```

**Purpose**: Checks the TerminalInfo convenience method that answers whether the session is inside Zellij. This matters because callers may need a simple yes/no check without inspecting the multiplexer details themselves.

**Data flow**: It creates one TerminalInfo value with a Zellij multiplexer and one with a tmux multiplexer. It calls is_zellij on both and expects true for Zellij and false for tmux.

**Call relations**: This test uses the local terminal_info helper to build the sample values, then relies on assertions to verify the behavior of TerminalInfo::is_zellij.

*Call graph*: calls 1 internal fn (terminal_info); 1 external calls (assert!).


##### `detects_iterm2`  (lines 160–179)

```
fn detects_iterm2()
```

**Purpose**: Checks that iTerm2 can be recognized from ITERM_SESSION_ID even when TERM_PROGRAM is not set. This covers a common iTerm2-specific environment clue.

**Data flow**: It creates a fake environment with ITERM_SESSION_ID. The detector reads that clue and should return an iTerm2 TerminalInfo with no version, plus the standard iTerm user-agent token.

**Call relations**: The test builds its environment with FakeEnvironment::new and with_var, then calls the detector and compares both the full result and user-agent string.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_apple_terminal`  (lines 182–220)

```
fn detects_apple_terminal()
```

**Purpose**: Checks both main ways Apple Terminal may be identified: TERM_PROGRAM and TERM_SESSION_ID. This makes sure macOS Terminal users are recognized even if only one clue is available.

**Data flow**: It runs two fake environments, one with TERM_PROGRAM set to Apple_Terminal and one with TERM_SESSION_ID. Each is passed to the detector, and the output is checked for Apple Terminal identity and the expected user-agent token.

**Call relations**: This test follows the common pattern: create a fake environment, set one clue, call the detector, and assert that the public TerminalInfo and token match the intended behavior.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_ghostty`  (lines 223–242)

```
fn detects_ghostty()
```

**Purpose**: Checks that Ghostty is recognized from TERM_PROGRAM. This keeps support for that terminal from regressing.

**Data flow**: It creates a fake environment where TERM_PROGRAM is Ghostty. The detector should turn that into a Ghostty TerminalInfo and a Ghostty user-agent token.

**Call relations**: The test uses FakeEnvironment::new and with_var to supply the clue, then asserts the detector's result and token.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_vscode`  (lines 245–266)

```
fn detects_vscode()
```

**Purpose**: Checks that VS Code's integrated terminal is recognized and that its version is preserved. This is useful because VS Code is not a traditional standalone terminal but still provides terminal-like sessions.

**Data flow**: It sets TERM_PROGRAM to vscode and TERM_PROGRAM_VERSION to a sample version. The detector should return VS Code as the terminal, store the version, and produce a token containing both.

**Call relations**: The test prepares the fake variables, calls the shared detection function, and uses assertions to pin down both the structured result and the string form.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_warp_terminal`  (lines 269–290)

```
fn detects_warp_terminal()
```

**Purpose**: Checks recognition of Warp Terminal through TERM_PROGRAM and its version variable. It makes sure long Warp version strings are kept as-is.

**Data flow**: It builds an environment with TERM_PROGRAM set to WarpTerminal and a detailed TERM_PROGRAM_VERSION value. The detector should return WarpTerminal with that exact version and include it in the user-agent token.

**Call relations**: The test feeds a controlled FakeEnvironment into the detector and compares the answer with the expected TerminalInfo and token.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_tmux_multiplexer`  (lines 293–315)

```
fn detects_tmux_multiplexer()
```

**Purpose**: Checks that tmux is reported as a multiplexer and that the detector uses tmux client information to describe the outer terminal clues. A multiplexer is a program that hosts terminal sessions inside another terminal.

**Data flow**: It sets TMUX and TERM_PROGRAM to indicate tmux, then supplies tmux client term type and term name. The detector should mark the session as tmux, use the client term type as the program-like clue, keep the term name, and build the right token.

**Call relations**: The test prepares both environment variables and fake tmux client info before calling the detector. It verifies that the detector asks through the Environment abstraction rather than relying only on raw variables.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_zellij_multiplexer`  (lines 318–332)

```
fn detects_zellij_multiplexer()
```

**Purpose**: Checks that Zellij is recognized when the ZELLIJ environment variable is present. This ensures sessions inside Zellij are marked distinctly from ordinary terminals.

**Data flow**: It creates a fake environment with ZELLIJ set. The detector should return an otherwise unknown terminal with a Zellij multiplexer and no version.

**Call relations**: The test uses FakeEnvironment::new and with_var, then calls the detector and asserts the multiplexer part of the TerminalInfo.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_zellij_multiplexer_version`  (lines 335–351)

```
fn detects_zellij_multiplexer_version()
```

**Purpose**: Checks that a Zellij version can be read from the ZELLIJ_VERSION environment variable. This lets the detector report not just that Zellij is present, but which version is running.

**Data flow**: It sets ZELLIJ_VERSION in the fake environment. The detector should return a TerminalInfo whose multiplexer is Zellij with that version string attached.

**Call relations**: The fake environment supplies the variable through FakeEnvironment::var and FakeEnvironment::zellij_version when the detector asks for Zellij information.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_zellij_multiplexer_command_version`  (lines 354–372)

```
fn detects_zellij_multiplexer_command_version()
```

**Purpose**: Checks the path where Zellij's version comes from a command-style lookup rather than the environment variable. This protects the fallback used when ZELLIJ is set but the version variable is not.

**Data flow**: It sets ZELLIJ to show that Zellij is active and stores a fake command-discovered version with with_zellij_version. The detector should return a Zellij multiplexer carrying that command version.

**Call relations**: The test sets up FakeEnvironment::zellij_version to return a prepared value, then verifies the detector incorporates it into TerminalInfo.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `parses_zellij_version_output`  (lines 375–382)

```
fn parses_zellij_version_output()
```

**Purpose**: Checks the small parser that extracts a Zellij version string from command output. It covers both output with the word 'zellij' and output that is just the version.

**Data flow**: It passes sample text strings into parse_zellij_version. The parser should return the version for valid non-empty strings and return nothing for an empty string.

**Call relations**: This test calls the parser directly rather than going through the full detector, because it is focused only on the version-text cleanup step used by Zellij detection.

*Call graph*: 1 external calls (assert_eq!).


##### `detects_tmux_client_termtype`  (lines 385–407)

```
fn detects_tmux_client_termtype()
```

**Purpose**: Checks that when tmux provides a client term type, that value can identify the real terminal outside tmux. In the example, the term type points to WezTerm.

**Data flow**: It sets tmux-related variables and fake tmux client info with term type WezTerm but no term name. The detector should report a tmux multiplexer while identifying the outer terminal as WezTerm.

**Call relations**: The test prepares tmux client data through with_tmux_client_info. The detector later retrieves that data through FakeEnvironment::tmux_client_info and uses it to choose the terminal name.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_tmux_client_termname`  (lines 410–432)

```
fn detects_tmux_client_termname()
```

**Purpose**: Checks that tmux client term name is kept when no stronger client term type is available. This preserves useful TERM-style information even if the specific terminal app is unknown.

**Data flow**: It creates a tmux environment with no client term type and a client term name of xterm-256color. The detector should mark tmux, leave the terminal name unknown, store the term name, and use it as the token.

**Call relations**: The test supplies tmux client info, then confirms the detector's tmux path uses the term name as fallback information.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_tmux_term_program_uses_client_termtype`  (lines 435–460)

```
fn detects_tmux_term_program_uses_client_termtype()
```

**Purpose**: Checks a more detailed tmux case where TERM_PROGRAM says tmux, but the tmux client term type reveals the real terminal and version. This prevents the detector from stopping too early at 'tmux' and losing the useful outer-terminal identity.

**Data flow**: It sets TMUX, TERM_PROGRAM as tmux, tmux's own version, and client info showing 'ghostty 1.2.3' plus a term name. The detector should record tmux with its version, identify Ghostty with version 1.2.3, keep the term name, and build a Ghostty version token.

**Call relations**: The test combines with_var and with_tmux_client_info before calling detection. It checks that the detector splits responsibilities correctly: tmux is the multiplexer, while Ghostty is the terminal being described.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_wezterm`  (lines 463–560)

```
fn detects_wezterm()
```

**Purpose**: Checks the different clues that can identify WezTerm: WEZTERM_VERSION, TERM_PROGRAM, and TERM. It also checks behavior when the version variable exists but is empty.

**Data flow**: It runs several fake environments with different WezTerm-related variables. For each one, the detector should identify WezTerm, include a version only when a non-empty version is available, and choose the expected user-agent token.

**Call relations**: This test repeatedly creates fresh FakeEnvironment values so each WezTerm clue is tested on its own. It then calls the shared detector and asserts both structured and string outputs.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_kitty`  (lines 563–624)

```
fn detects_kitty()
```

**Purpose**: Checks that Kitty is recognized from its window variable, from TERM_PROGRAM, and from TERM. It also verifies that Kitty's TERM clue wins over an Alacritty socket clue when both appear.

**Data flow**: It builds separate environments for KITTY_WINDOW_ID, TERM_PROGRAM plus version, and TERM set to xterm-kitty alongside ALACRITTY_SOCKET. The detector should consistently report Kitty and produce the expected token for each case.

**Call relations**: The test uses FakeEnvironment::new for each scenario, then confirms the detector's priority rules, especially the case where two terminal clues are present.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_alacritty`  (lines 627–686)

```
fn detects_alacritty()
```

**Purpose**: Checks that Alacritty is recognized from its socket variable, TERM_PROGRAM, and TERM. This covers the common ways Alacritty announces itself.

**Data flow**: It creates three fake environments: one with ALACRITTY_SOCKET, one with TERM_PROGRAM and version, and one with TERM set to alacritty. The detector should identify Alacritty each time and include the version only in the TERM_PROGRAM case.

**Call relations**: Each scenario starts from a clean FakeEnvironment, runs through the detector, and is checked with assertions for both TerminalInfo and user-agent token.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_konsole`  (lines 689–748)

```
fn detects_konsole()
```

**Purpose**: Checks recognition of KDE's Konsole terminal from KONSOLE_VERSION and TERM_PROGRAM. It also confirms that an empty KONSOLE_VERSION still identifies Konsole but does not create a fake version.

**Data flow**: It supplies Konsole clues in three different fake environments. The detector should report Konsole, attach a version when the version value is non-empty, and produce either Konsole/version or plain Konsole as the token.

**Call relations**: The test calls the detector after setting up each fake environment and uses assertions to lock in the intended handling of present, TERM_PROGRAM-based, and empty version clues.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_gnome_terminal`  (lines 751–791)

```
fn detects_gnome_terminal()
```

**Purpose**: Checks that GNOME Terminal is recognized from its screen variable and from TERM_PROGRAM. This covers both a GNOME-specific clue and a more general terminal-program clue.

**Data flow**: It first sets GNOME_TERMINAL_SCREEN, then separately sets TERM_PROGRAM and TERM_PROGRAM_VERSION for gnome-terminal. The detector should identify GNOME Terminal and include the version only in the second case.

**Call relations**: The test builds controlled FakeEnvironment instances, calls the detector, and verifies the expected TerminalInfo plus user-agent token.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_vte`  (lines 794–849)

```
fn detects_vte()
```

**Purpose**: Checks terminals based on VTE, a common terminal widget used by several Linux terminals. It verifies both VTE_VERSION and TERM_PROGRAM paths, including the empty-version case.

**Data flow**: It creates fake environments with VTE_VERSION, with TERM_PROGRAM set to VTE plus a version, and with an empty VTE_VERSION. The detector should identify VTE and include a version only when one is non-empty.

**Call relations**: This test exercises the detector's VTE-specific branches and confirms the user-agent token matches the structured TerminalInfo result.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_windows_terminal`  (lines 852–892)

```
fn detects_windows_terminal()
```

**Purpose**: Checks that Windows Terminal is recognized from WT_SESSION and from TERM_PROGRAM. This keeps Windows-specific detection covered alongside Unix-like terminal checks.

**Data flow**: It runs one environment with WT_SESSION and another with TERM_PROGRAM plus TERM_PROGRAM_VERSION. The detector should return Windows Terminal, with a version only in the TERM_PROGRAM case, and produce the expected token.

**Call relations**: The test prepares fake variables, sends them through the same detection function as all other tests, and asserts the Windows Terminal result.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_term_fallbacks`  (lines 895–944)

```
fn detects_term_fallbacks()
```

**Purpose**: Checks what happens when no specific terminal app can be identified. The detector should still preserve useful TERM information, recognize the special 'dumb' terminal, and return 'unknown' when there are no clues at all.

**Data flow**: It tests three environments: TERM set to xterm-256color, TERM set to dumb, and an empty environment. The detector should return unknown with the TERM value, dumb with the dumb TERM value, and fully unknown with no term for the empty case.

**Call relations**: This test covers the detector's final fallback behavior after all stronger terminal-specific checks fail. It uses fresh FakeEnvironment values and assertions to define the safe default outputs.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


### `utils/string/src/truncate/tests.rs`

`test` · `test run`

This is a test file for a small string utility that shortens long text. The utility has to solve a deceptively tricky problem: when text is too long, it should keep useful content from the beginning and end, remove the middle, and explain how much was removed. It must also avoid cutting through a UTF-8 character. UTF-8 is the common text encoding where characters like emoji use multiple bytes; slicing in the wrong place can create invalid text.

The tests cover three main behaviors. First, they check `split_string`, which divides a string into a kept prefix, a kept suffix, and a count of removed characters. These tests include empty strings, zero-sized budgets, and cases where the requested prefix and suffix would overlap. Second, they check token-budget truncation, where the code treats a rough number of tokens as the limit and returns both the shortened output and the original token count when truncation happened. Third, they check byte-budget truncation, where the output must fit a byte limit while still remaining valid readable text.

An everyday analogy is packing a long receipt into a small note: keep the top, keep the bottom, replace the middle with “something was skipped,” and never tear a word in half.

#### Function details

##### `split_string_works`  (lines 7–20)

```
fn split_string_works()
```

**Purpose**: This test checks the basic split behavior on ordinary ASCII text. It confirms that the helper can keep the requested beginning and ending parts while counting the removed middle.

**Data flow**: It starts with simple strings and byte budgets for the front and back. The test compares the helper's result with the expected removed count, prefix, and suffix. If the result differs, the assertion fails and the test reports the mismatch.

**Call relations**: During the test run, this function acts as a basic confidence check for the string-splitting helper. It uses `assert_eq!` to compare the actual behavior against the expected behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `split_string_handles_empty_string`  (lines 23–28)

```
fn split_string_handles_empty_string()
```

**Purpose**: This test makes sure splitting an empty string stays empty and reports that nothing was removed. It protects against edge-case bugs where empty input might accidentally produce a wrong count or invalid slice.

**Data flow**: It gives the helper an empty string with nonzero front and back budgets. The expected result is zero removed characters and empty kept parts. The assertion turns that expectation into a pass-or-fail check.

**Call relations**: This test is run alongside the other truncation tests to cover the simplest possible input. It relies on `assert_eq!` to make the expected empty result explicit.

*Call graph*: 1 external calls (assert_eq!).


##### `split_string_only_keeps_prefix_when_tail_budget_is_zero`  (lines 31–36)

```
fn split_string_only_keeps_prefix_when_tail_budget_is_zero()
```

**Purpose**: This test checks that a zero budget for the suffix means no ending text is kept. It confirms that the helper respects a request to keep only the beginning of the string.

**Data flow**: It uses the string `abcdef`, asks for three bytes from the beginning, and asks for zero bytes from the end. The expected result keeps `abc`, keeps no suffix, and reports that three characters were removed. The assertion checks that exact outcome.

**Call relations**: This test covers one side of the budget rules: prefix only. It uses `assert_eq!` to verify the helper's output during the test suite.

*Call graph*: 1 external calls (assert_eq!).


##### `split_string_only_keeps_suffix_when_prefix_budget_is_zero`  (lines 39–44)

```
fn split_string_only_keeps_suffix_when_prefix_budget_is_zero()
```

**Purpose**: This test checks the opposite zero-budget case: no beginning text should be kept, but the ending text should be kept. It confirms that suffix-only truncation works.

**Data flow**: It uses the string `abcdef`, asks for zero bytes at the beginning, and asks for three bytes at the end. The expected result keeps no prefix, keeps `def`, and reports that three characters were removed. The assertion compares that expectation with the actual result.

**Call relations**: This test complements the prefix-only test by checking suffix-only behavior. It participates in the test suite through an `assert_eq!` comparison.

*Call graph*: 1 external calls (assert_eq!).


##### `split_string_handles_overlapping_budgets_without_removal`  (lines 47–52)

```
fn split_string_handles_overlapping_budgets_without_removal()
```

**Purpose**: This test checks what happens when the requested beginning and ending budgets together cover more than the string length. It makes sure the helper does not invent removed text when the whole string can be kept.

**Data flow**: It gives the helper `abcdef` and asks for four bytes at the beginning and four at the end. Since those budgets overlap, the expected result reports zero removed characters and returns the whole content split as `abcd` and `ef`. The assertion verifies that no middle removal is reported.

**Call relations**: This test guards against a subtle boundary problem in the splitting logic. It uses `assert_eq!` to lock in the desired behavior when budgets overlap.

*Call graph*: 1 external calls (assert_eq!).


##### `split_string_respects_utf8_boundaries`  (lines 55–85)

```
fn split_string_respects_utf8_boundaries()
```

**Purpose**: This test checks that splitting never cuts through a multi-byte UTF-8 character such as an emoji. This matters because cutting through one would create broken text.

**Data flow**: It runs several emoji-heavy strings through the splitting helper with byte budgets that may land inside an emoji. The expected results show that the helper backs off to valid character boundaries, sometimes keeping fewer bytes than requested. Each assertion checks the removed count and the kept beginning and ending text.

**Call relations**: This function is the main safety test for Unicode text in the splitter. It uses `assert_eq!` repeatedly to show how the helper should behave around UTF-8 character boundaries.

*Call graph*: 1 external calls (assert_eq!).


##### `truncate_with_token_budget_returns_original_when_under_limit`  (lines 88–94)

```
fn truncate_with_token_budget_returns_original_when_under_limit()
```

**Purpose**: This test checks that short text is left untouched when it is already under the token limit. A token is a rough chunk of text used for size budgeting, often similar to a word piece rather than a character.

**Data flow**: It sends the string `short output` and a generous token limit into `truncate_middle_with_token_budget`. The returned text should be the original string, and the optional original-token count should be empty because no truncation happened. Assertions confirm both parts of the result.

**Call relations**: This test calls the token-budget truncation helper in the simplest non-truncating case. It then uses `assert_eq!` to confirm that the helper leaves safe input alone.

*Call graph*: 2 external calls (assert_eq!, truncate_middle_with_token_budget).


##### `truncate_with_token_budget_reports_truncation_at_zero_limit`  (lines 97–102)

```
fn truncate_with_token_budget_reports_truncation_at_zero_limit()
```

**Purpose**: This test checks the extreme case where the allowed token budget is zero. It confirms that the helper still returns a clear truncation message and reports the original token count.

**Data flow**: It gives `abcdef` to `truncate_middle_with_token_budget` with a maximum token count of zero. The helper is expected to return only a message saying that two tokens were truncated, along with `Some(2)` to record the original size. The assertions check both the text and the reported count.

**Call relations**: This test exercises the token-budget truncation helper at its strictest limit. It uses `assert_eq!` to make sure the helper reports truncation rather than silently returning misleading output.

*Call graph*: 2 external calls (assert_eq!, truncate_middle_with_token_budget).


##### `truncate_middle_tokens_handles_utf8_content`  (lines 105–110)

```
fn truncate_middle_tokens_handles_utf8_content()
```

**Purpose**: This test checks token-budget truncation on text containing emoji and normal words. It ensures the shortened result remains readable and valid even when the original has multi-byte characters.

**Data flow**: It starts with a string containing many emoji, a newline, and a second line of text. The string is passed to `truncate_middle_with_token_budget` with a small token limit. The expected output keeps some beginning emoji and the end of the text, inserts a truncation message in the middle, and reports the original token count.

**Call relations**: This test calls the token-budget truncation helper in a realistic Unicode case. It uses `assert_eq!` to confirm both the visible shortened text and the token-count report.

*Call graph*: 2 external calls (assert_eq!, truncate_middle_with_token_budget).


##### `truncate_middle_bytes_handles_utf8_content`  (lines 113–117)

```
fn truncate_middle_bytes_handles_utf8_content()
```

**Purpose**: This test checks byte-budget truncation on text that includes emoji. It makes sure the helper can obey a byte-sized limit without breaking UTF-8 text.

**Data flow**: It provides a string with emoji and a second line, then calls `truncate_middle_chars` with a small byte budget. The expected output keeps a valid beginning and ending, inserts a message saying how many characters were removed, and preserves readable text. The assertion compares the helper's output with that exact expected string.

**Call relations**: This test exercises the byte-oriented truncation helper with Unicode content. It uses `assert_eq!` to confirm that the helper shortens the middle while keeping valid character boundaries.

*Call graph*: 2 external calls (assert_eq!, truncate_middle_chars).


### Image utility validation and benchmarks
These files validate prompt-image handling end to end and then benchmark the same workflows under synthetic fixture inputs.

### `utils/image/src/image_tests.rs`

`test` · `test run`

This is a safety net for the image utility module. The production code has to take images from files or data URLs, make sure they are small enough for prompt use, keep useful metadata when possible, and reject bad input cleanly. These tests create small in-memory images, encode them into real image formats, feed them through the public image-processing functions, and then inspect the results.

The file starts with helper functions that turn generated pixel buffers into encoded image bytes, like making a temporary PNG or JPEG without touching disk. One helper can also attach metadata: an ICC color profile, which describes how colors should be interpreted, and EXIF orientation, which records how the image should be rotated.

The tests cover the main promises of the image code. Small PNG and WebP images should pass through unchanged. Oversized images should shrink while keeping their shape and staying within dimension or “patch” budgets. “Original” mode should leave even large images alone. Supported metadata should survive resizing, but a non-RGB color profile should be dropped because it is unsafe or unsuitable for the prompt path. Data URLs are tested too, including case-insensitive prefixes, GIF-to-PNG conversion, and malformed input. The final tests make sure updated bytes are not incorrectly reused from cache, and that the cache is bounded by encoded byte size.

#### Function details

##### `image_bytes`  (lines 17–23)

```
fn image_bytes(image: &ImageBuffer<Rgba<u8>, Vec<u8>>, format: ImageFormat) -> Vec<u8>
```

**Purpose**: This helper turns a generated RGBA image into encoded bytes in a chosen image format. Tests use it to create realistic PNG, WebP, GIF, or other image inputs without needing fixture files on disk.

**Data flow**: It receives an in-memory pixel image and a target format. It clones the image, writes it into a byte buffer using the image library, and returns the finished byte vector. Nothing outside the helper is changed.

**Call relations**: Many tests first build a simple solid-color image and then call this helper to make bytes that can be passed into the prompt image loader. It acts as the test file’s small image factory before the real processing code is exercised.

*Call graph*: calls 1 internal fn (new); called by 8 (data_url_processing_converts_gif_to_png, data_url_processing_preserves_supported_source_bytes, downscales_large_image, downscales_tall_image_to_fit_square_bounds, preserves_large_image_in_original_mode, reprocesses_updated_file_contents, resize_with_limits_respects_dimension_and_patch_budgets, returns_original_image_when_within_bounds); 3 external calls (ImageRgba8, clone, new).


##### `image_bytes_with_metadata`  (lines 25–81)

```
fn image_bytes_with_metadata(
    image: &ImageBuffer<Rgba<u8>, Vec<u8>>,
    format: ImageFormat,
    icc_profile: &[u8],
) -> Vec<u8>
```

**Purpose**: This helper creates encoded image bytes that include test metadata. It is used to prove that resizing keeps safe metadata and removes unsafe color-profile metadata when needed.

**Data flow**: It receives an in-memory image, an image format, and ICC profile bytes. For PNG, JPEG, or WebP, it encodes the image while attaching the supplied ICC profile and a fixed EXIF orientation value. It returns the encoded bytes with that metadata embedded.

**Call relations**: The metadata-focused tests call this helper before sending the bytes through the image-processing path. After processing, those tests decode the result and check whether the metadata survived or was intentionally removed.

*Call graph*: called by 2 (resizing_drops_non_rgb_icc_profile, resizing_preserves_supported_metadata); 10 external calls (ImageRgba8, as_raw, clone, height, width, new_with_quality, new, new, new_lossless, panic!).


##### `returns_original_image_when_within_bounds`  (lines 84–104)

```
async fn returns_original_image_when_within_bounds()
```

**Purpose**: This test checks that already-small supported images are not rewritten unnecessarily. That matters because rewriting can change bytes, lose metadata, or waste time.

**Data flow**: It creates a small PNG and WebP image, encodes each one, and sends the bytes through prompt image loading in resize-to-fit mode. It expects the output width, height, MIME type, and encoded bytes to match the original input exactly.

**Call relations**: It uses image_bytes to make the source images, then exercises the main prompt image byte loader. It verifies the fast path where the loader recognizes that no resize or conversion is needed.

*Call graph*: calls 1 internal fn (image_bytes); 4 external calls (from_pixel, new, assert_eq!, Rgba).


##### `downscales_large_image`  (lines 107–134)

```
async fn downscales_large_image()
```

**Purpose**: This test checks that very large images are reduced before prompt use. Without this, prompt requests could contain images that are too large or too expensive to process.

**Data flow**: It creates a 4096 by 2048 image in PNG and WebP formats, passes the encoded bytes into resize-to-fit processing, and examines the result. The output must stay within the maximum dimension, keep the expected MIME type, still be readable as the same format, and report dimensions that match the decoded image.

**Call relations**: It uses image_bytes to prepare oversized inputs and then checks the real resizing path. It also asks the image library to identify and reload the output, proving the processed bytes are not just labelled correctly but are actually valid images.

*Call graph*: calls 1 internal fn (image_bytes); 7 external calls (from_pixel, new, assert!, assert_eq!, Rgba, guess_format, load_from_memory).


##### `downscales_tall_image_to_fit_square_bounds`  (lines 137–151)

```
async fn downscales_tall_image_to_fit_square_bounds()
```

**Purpose**: This test checks resizing for a tall image, where height is the limiting side. It makes sure the code preserves the image’s shape instead of simply forcing both sides to the same size.

**Data flow**: It creates a 1024 by 4096 PNG, processes it in resize-to-fit mode, and checks the resulting dimensions. The height is reduced to the maximum allowed size, and the width shrinks proportionally to 512.

**Call relations**: It uses image_bytes to create the source PNG, then calls the prompt image loader. This complements the wider-image tests by covering the portrait-shaped case.

*Call graph*: calls 1 internal fn (image_bytes); 4 external calls (from_pixel, new, assert_eq!, Rgba).


##### `resizing_preserves_supported_metadata`  (lines 154–186)

```
async fn resizing_preserves_supported_metadata()
```

**Purpose**: This test confirms that resizing does not throw away useful, supported metadata. In particular, it checks ICC color profile data and EXIF orientation data for PNG, JPEG, and WebP.

**Data flow**: It creates a slightly-too-wide image with a test RGB color profile and rotation metadata, processes it so resizing is required, and then decodes the result. It expects the new dimensions, orientation, ICC profile, and EXIF bytes to match the intended values.

**Call relations**: It relies on image_bytes_with_metadata to build inputs that contain metadata, then sends them through the resizing path. Afterward it uses a decoder to inspect what the processing code wrote back out.

*Call graph*: calls 2 internal fn (new, image_bytes_with_metadata); 5 external calls (from_pixel, with_format, new, assert_eq!, Rgba).


##### `resizing_drops_non_rgb_icc_profile`  (lines 189–211)

```
async fn resizing_drops_non_rgb_icc_profile()
```

**Purpose**: This test checks that a non-RGB ICC color profile is removed during resizing. That matters because the prompt image path expects ordinary RGB-style color data, not profiles for other color models such as CMYK.

**Data flow**: It creates a JPEG with a fake CMYK ICC profile and EXIF orientation metadata, processes it through resize-to-fit mode, and decodes the result. The ICC profile should be gone, while the EXIF metadata should still be present.

**Call relations**: It uses image_bytes_with_metadata to create a metadata-heavy JPEG, then verifies the image processor’s filtering behavior. It is paired with the previous metadata test: one proves safe metadata survives, the other proves unsafe metadata is dropped.

*Call graph*: calls 2 internal fn (new, image_bytes_with_metadata); 5 external calls (from_pixel, with_format, new, assert_eq!, Rgba).


##### `preserves_large_image_in_original_mode`  (lines 214–229)

```
async fn preserves_large_image_in_original_mode()
```

**Purpose**: This test checks that “original” mode really means no resizing. Users or callers choosing this mode expect the image bytes and dimensions to remain untouched.

**Data flow**: It creates a large PNG, keeps a copy of the encoded source bytes, and processes the image using original mode. The output must report the original dimensions, use the PNG MIME type, and contain the exact same bytes.

**Call relations**: It uses image_bytes to build a large input, then sends it through the same byte-loading entry point with a different mode. It proves that resizing is controlled by the selected prompt image mode.

*Call graph*: calls 1 internal fn (image_bytes); 4 external calls (from_pixel, new, assert_eq!, Rgba).


##### `data_url_processing_preserves_supported_source_bytes`  (lines 232–246)

```
async fn data_url_processing_preserves_supported_source_bytes()
```

**Purpose**: This test checks that a valid data URL containing a small supported image is decoded and preserved without unnecessary changes. A data URL is text that embeds file bytes directly, usually using base64 encoding.

**Data flow**: It creates a small PNG, wraps the bytes in a data URL, changes the casing of the `data:` and `base64` markers, and processes the URL. The result should keep the original dimensions, MIME type, and exact bytes.

**Call relations**: It uses image_bytes to create the PNG input and then exercises the data-URL-specific prompt loader. It proves the parser accepts normal case variations and then hands the decoded bytes into the usual image path.

*Call graph*: calls 1 internal fn (image_bytes); 3 external calls (from_pixel, assert_eq!, Rgba).


##### `data_url_processing_converts_gif_to_png`  (lines 249–262)

```
async fn data_url_processing_converts_gif_to_png()
```

**Purpose**: This test checks that GIF images supplied through data URLs are converted to PNG for prompt use. This gives the rest of the system a supported still-image format instead of leaving GIF bytes as-is.

**Data flow**: It creates a small image, encodes it as GIF, wraps it in a GIF data URL, and processes the URL. The output should say it is PNG, and the bytes should be detectable as PNG by the image library.

**Call relations**: It uses image_bytes to create GIF input, then runs the data URL loader. The test focuses on the conversion branch rather than ordinary pass-through behavior.

*Call graph*: calls 1 internal fn (image_bytes); 3 external calls (from_pixel, assert_eq!, Rgba).


##### `data_url_processing_rejects_malformed_input`  (lines 265–277)

```
fn data_url_processing_rejects_malformed_input()
```

**Purpose**: This test makes sure bad data URLs fail with a clear invalid-data-URL error instead of being accepted or crashing later. It covers missing prefixes, missing base64 markers, and invalid base64 text.

**Data flow**: It loops over several malformed URL strings and tries to process each one. Each attempt should return an InvalidDataUrl error, and no image output should be produced.

**Call relations**: Unlike the successful data URL tests, this one does not create an image first. It directly tests the parser’s guardrails before the image-decoding path can be reached.

*Call graph*: 1 external calls (assert!).


##### `resize_with_limits_respects_dimension_and_patch_budgets`  (lines 280–296)

```
async fn resize_with_limits_respects_dimension_and_patch_budgets()
```

**Purpose**: This test checks the mode where callers provide explicit resize limits. It proves that the processor obeys both a maximum side length and a maximum patch budget, where patches are fixed-size chunks used to estimate prompt image cost.

**Data flow**: It creates a 2048 by 2048 PNG, sets limits with a 2048 maximum dimension and a 2500 patch budget, and processes the image. The result is expected to shrink to 1600 by 1600, showing that the patch budget can force resizing even when the dimension limit alone would allow the original size.

**Call relations**: It uses image_bytes for the input and then calls the main byte loader with ResizeWithLimits mode. This test covers the custom-limit path rather than the default resize-to-fit rules.

*Call graph*: calls 1 internal fn (image_bytes); 5 external calls (from_pixel, new, assert_eq!, Rgba, ResizeWithLimits).


##### `fails_cleanly_for_invalid_images`  (lines 299–310)

```
async fn fails_cleanly_for_invalid_images()
```

**Purpose**: This test checks that non-image bytes produce a controlled error. That matters because callers need a useful failure result, not a panic or misleading output.

**Data flow**: It sends the text bytes `not an image` into the prompt image byte loader. The loader should reject the input with either a decode error or an unsupported-format error.

**Call relations**: This test goes straight to the image-loading entry point without using the helper image encoders. It exercises the failure path that runs when the image library cannot recognize or decode the input.

*Call graph*: 2 external calls (new, assert!).


##### `reprocesses_updated_file_contents`  (lines 313–341)

```
async fn reprocesses_updated_file_contents()
```

**Purpose**: This test makes sure the image cache does not reuse stale results when the bytes for the same path-like name change. Without this, a caller could update an image and still get the old processed version.

**Data flow**: It clears the shared image cache, processes one PNG under the same in-memory path name, then processes a different PNG under that same name. The first result should have the first dimensions, the second result should have the second dimensions, and their bytes should differ.

**Call relations**: It uses image_bytes twice to create two different inputs, then calls the byte loader twice with the same path label. The test verifies that caching is based on image content and mode, not just the supplied path.

*Call graph*: calls 1 internal fn (image_bytes); 5 external calls (from_pixel, new, assert_eq!, assert_ne!, Rgba).


##### `bounds_cache_by_encoded_byte_size`  (lines 344–364)

```
async fn bounds_cache_by_encoded_byte_size()
```

**Purpose**: This test checks that cached images are limited by the total size of their encoded bytes. The cache should not grow without bound and should avoid keeping an item that is larger than the allowed byte capacity.

**Data flow**: It creates a small cache, makes fake cache keys and fake encoded images of different byte sizes, and inserts them with a five-byte capacity. After inserting two three-byte images and one six-byte image, the oldest small item should be evicted, the newer small item should remain, and the too-large item should not be kept.

**Call relations**: This test works directly with the cache type and cache insertion helper instead of going through image decoding. It isolates the cache-size policy so failures are easier to understand.

*Call graph*: 3 external calls (new, new, assert!).


### `utils/image/benches/prompt_images.rs`

`test` · `benchmarking`

This benchmark answers a practical question: how expensive is it to prepare images before sending them in a prompt? In this project, an image attachment is loaded, possibly resized, and converted into a data URL, which is a text form of the image that can be embedded directly in a request. If this path is slow, adding screenshots or photos to prompts would feel sluggish.

The file uses Divan, a Rust benchmarking tool, as its stopwatch. It builds synthetic image files in memory instead of reading real files from disk. The screenshot fixtures look like user interfaces, with toolbars, sidebars, panels, and text-like rows. The photo fixture uses gradients and texture so it behaves more like a camera image. These are then encoded as PNG or JPEG bytes, just like real uploaded files.

There are two main benchmark styles. The “fresh attachment” tests deliberately change the bytes slightly each time so the image cache cannot help. This measures the full cost of loading and preparing a new image. The “repeated attachment” test warms the cache first, then measures what happens when the same image comes through again. The cache is like a clerk remembering a document they have already processed: repeated work should be cheaper.

#### Function details

##### `main`  (lines 35–37)

```
fn main()
```

**Purpose**: Starts the benchmark program. It hands control to Divan, the benchmarking tool, so Divan can discover and run the benchmark functions in this file.

**Data flow**: No project data goes in. The function calls Divan’s main runner, which takes over the process and runs the registered benchmarks. Nothing is returned to the rest of the code; this is the top-level benchmark entry.

**Call relations**: This is the doorway into the benchmark binary. Once it calls Divan’s runner, Divan is responsible for invoking the individual benchmark functions such as the screenshot and photo measurements.

*Call graph*: 1 external calls (main).


##### `small_png_screenshot_fresh_attachment`  (lines 40–46)

```
fn small_png_screenshot_fresh_attachment(bencher: Bencher)
```

**Purpose**: Measures the cost of preparing a small PNG screenshot when each run looks like a new attachment. This is useful for understanding the uncached cost of a common screenshot size.

**Data flow**: It starts with the predefined small screenshot dimensions. It creates a synthetic PNG screenshot, makes many slightly different byte versions to avoid cache reuse, and passes those versions to the shared fresh-attachment benchmark helper. The output is not a value; the result is timing data collected by Divan.

**Call relations**: Divan calls this benchmark during a benchmark run. It relies on screenshot_png to make the fixture, cache_miss_variants to turn it into many cache-missing inputs, and bench_fresh_attachment to run the timed measurement.

*Call graph*: calls 3 internal fn (bench_fresh_attachment, cache_miss_variants, screenshot_png).


##### `large_png_screenshot_fresh_attachment`  (lines 49–55)

```
fn large_png_screenshot_fresh_attachment(bencher: Bencher)
```

**Purpose**: Measures the cost of preparing a large PNG screenshot as if every iteration were a new upload. This shows how the image pipeline behaves with a bigger screen capture.

**Data flow**: It takes the large screenshot dimensions, creates a synthetic PNG screenshot, produces multiple byte variants that should miss the cache, and gives them to the fresh-attachment benchmark helper. Divan records timing rather than this function returning processed data.

**Call relations**: Divan invokes this benchmark alongside the others. It uses screenshot_png for the generated image, cache_miss_variants to avoid cached results, and bench_fresh_attachment to perform the repeated timing loop.

*Call graph*: calls 3 internal fn (bench_fresh_attachment, cache_miss_variants, screenshot_png).


##### `large_jpeg_photo_fresh_attachment`  (lines 58–64)

```
fn large_jpeg_photo_fresh_attachment(bencher: Bencher)
```

**Purpose**: Measures the cost of preparing a large JPEG photo when the image cache cannot be reused. This helps compare photo-like input against screenshot-like input.

**Data flow**: It starts with the large photo dimensions, generates a textured JPEG photo in memory, creates many slightly different byte versions, and sends those versions into the fresh-attachment benchmark helper. The visible result is benchmark timing output.

**Call relations**: Divan runs this as one of the benchmark cases. It calls photo_jpeg to create the photo fixture, cache_miss_variants to force cache misses, and bench_fresh_attachment to do the actual repeated measurement.

*Call graph*: calls 3 internal fn (bench_fresh_attachment, cache_miss_variants, photo_jpeg).


##### `small_png_screenshot_repeated_attachment`  (lines 67–73)

```
fn small_png_screenshot_repeated_attachment(bencher: Bencher)
```

**Purpose**: Measures the cost of preparing the same small PNG screenshot repeatedly. This is meant to show the benefit of the image cache when the exact same content is seen again.

**Data flow**: It creates one small synthetic PNG screenshot and passes that same image to the repeated-attachment benchmark helper. The helper warms the cache first, then Divan measures repeated preparation of cloned copies of the same bytes.

**Call relations**: Divan calls this benchmark during the run. It uses screenshot_png to build the input and bench_repeated_attachment to perform the cache-warmed measurement.

*Call graph*: calls 2 internal fn (bench_repeated_attachment, screenshot_png).


##### `bench_fresh_attachment`  (lines 75–86)

```
fn bench_fresh_attachment(bencher: Bencher, path: &'static str, images: Vec<Vec<u8>>)
```

**Purpose**: Runs a benchmark where each measured iteration receives a different image byte buffer. Its job is to keep the benchmark on the slower “new image” path instead of letting the cache make the work cheaper.

**Data flow**: It receives a Divan benchmark controller, a pretend file path, and a list of image byte variants. Before each measured iteration, it clones the next image variant and advances a rotating index. The benchmark then measures preparation work using those inputs, while Divan leaves the input setup itself out of the timing.

**Call relations**: The three fresh-attachment benchmark functions call this helper after creating their fixtures. It uses Divan’s with_inputs mechanism so setup work, such as choosing and cloning the next input, does not pollute the timing.

*Call graph*: called by 3 (large_jpeg_photo_fresh_attachment, large_png_screenshot_fresh_attachment, small_png_screenshot_fresh_attachment); 1 external calls (with_inputs).


##### `bench_repeated_attachment`  (lines 88–95)

```
fn bench_repeated_attachment(bencher: Bencher, path: &'static str, image: Vec<u8>)
```

**Purpose**: Runs a benchmark for the cached path, where the same image is prepared again and again. It first prepares the image once so later iterations can benefit from any cache keyed by image content.

**Data flow**: It receives a Divan benchmark controller, a file path, and one image byte buffer. It prepares that image once before timing, then gives cloned copies of the same bytes to each benchmark iteration. Divan records how fast repeated preparation is after the warm-up.

**Call relations**: small_png_screenshot_repeated_attachment calls this helper for the repeated-image case. This helper calls prepare_prompt_data_url for the warm-up, then uses Divan’s with_inputs mechanism to feed the same image content into the measured loop.

*Call graph*: calls 1 internal fn (prepare_prompt_data_url); called by 1 (small_png_screenshot_repeated_attachment); 1 external calls (with_inputs).


##### `prepare_prompt_data_url`  (lines 97–102)

```
fn prepare_prompt_data_url(path: &str, image: Vec<u8>) -> String
```

**Purpose**: Converts image bytes into the prompt-ready data URL used by the benchmark. It is the small wrapper around the real image-loading code being measured.

**Data flow**: It receives a file path string and raw image bytes. It turns the path string into a path object, asks load_for_prompt_bytes to load and resize the image using ResizeToFit mode, then converts the loaded image into a data URL string. If the fixture cannot be loaded, it stops the benchmark with an error message because benchmark fixtures are expected to be valid.

**Call relations**: bench_repeated_attachment calls this function to warm the cache before timing repeated inputs. Inside, it hands the real work to load_for_prompt_bytes from the image utility crate, because that is the production-style code path the benchmark cares about.

*Call graph*: called by 1 (bench_repeated_attachment); 2 external calls (new, load_for_prompt_bytes).


##### `cache_miss_variants`  (lines 104–113)

```
fn cache_miss_variants(image: Vec<u8>) -> Vec<Vec<u8>>
```

**Purpose**: Creates many slightly different copies of the same image bytes so the image cache treats them as different files. This lets benchmarks measure fresh processing instead of accidentally measuring cached reuse.

**Data flow**: It receives one encoded image as bytes. For each variant number, it clones the original bytes and appends the variant number in binary form at the end. It returns a list of these altered byte buffers.

**Call relations**: The fresh screenshot and photo benchmarks call this before handing inputs to bench_fresh_attachment. Its output is what keeps those benchmarks exercising the cache-miss path.

*Call graph*: called by 3 (large_jpeg_photo_fresh_attachment, large_png_screenshot_fresh_attachment, small_png_screenshot_fresh_attachment).


##### `screenshot_png`  (lines 116–148)

```
fn screenshot_png(size: ImageSize) -> Vec<u8>
```

**Purpose**: Builds a fake screenshot image and encodes it as PNG bytes. This gives the benchmark a predictable screenshot-like input without depending on external image files.

**Data flow**: It receives an image size. For every pixel, it chooses a color based on simple rules that create a toolbar, sidebar, panel borders, and text-like marks. It wraps the finished pixel grid as an image and passes it to encode_fixture to produce PNG bytes.

**Call relations**: The small and large screenshot benchmarks call this to create their inputs. After drawing the synthetic screenshot, it hands the image to encode_fixture so the rest of the benchmark works with real encoded PNG data rather than raw pixels.

*Call graph*: calls 1 internal fn (encode_fixture); called by 3 (large_png_screenshot_fresh_attachment, small_png_screenshot_fresh_attachment, small_png_screenshot_repeated_attachment); 2 external calls (ImageRgba8, from_fn).


##### `photo_jpeg`  (lines 151–165)

```
fn photo_jpeg(size: ImageSize) -> Vec<u8>
```

**Purpose**: Builds a fake photo-like image and encodes it as JPEG bytes. It provides a large, textured input that behaves differently from a clean UI screenshot.

**Data flow**: It receives an image size. For each pixel, it combines horizontal and vertical gradients with a small calculated texture value, then turns those into red, green, and blue color channels. It wraps the pixel grid as an image and passes it to encode_fixture to produce JPEG bytes.

**Call relations**: large_jpeg_photo_fresh_attachment calls this to make the photo benchmark fixture. It uses blend_channel while choosing pixel colors, then relies on encode_fixture to turn the generated image into JPEG data.

*Call graph*: calls 1 internal fn (encode_fixture); called by 1 (large_jpeg_photo_fresh_attachment); 2 external calls (ImageRgb8, from_fn).


##### `blend_channel`  (lines 167–169)

```
fn blend_channel(gradient: u32, texture: u8, divisor: u32) -> u8
```

**Purpose**: Mixes a smooth color gradient with a texture value for one color channel. This makes the synthetic photo less flat and more like a real image.

**Data flow**: It receives a gradient value, a texture byte, and a divisor that controls how strongly the texture affects the result. It adds a reduced amount of texture to the gradient, wraps the value into the 0 to 255 color range, and returns it as one byte.

**Call relations**: This helper supports the photo-generation logic in photo_jpeg. It is a small color-mixing step used while building each pixel of the synthetic JPEG fixture.

*Call graph*: 1 external calls (from).


##### `encode_fixture`  (lines 171–178)

```
fn encode_fixture(image: DynamicImage, format: ImageFormat) -> Vec<u8>
```

**Purpose**: Turns an in-memory image into encoded file bytes such as PNG or JPEG. This lets the benchmarks feed the loader the same kind of bytes it would get from a real attachment.

**Data flow**: It receives a dynamic image and an image format. It creates an empty in-memory byte buffer, writes the image into that buffer using the requested format, and returns the finished bytes. If encoding fails, it stops with an error because these generated fixtures are expected to be valid.

**Call relations**: screenshot_png and photo_jpeg call this after they finish drawing their synthetic images. It is the final step that converts generated pixels into realistic encoded image input for the benchmark.

*Call graph*: calls 1 internal fn (new); called by 2 (photo_jpeg, screenshot_png); 2 external calls (write_to, new).
