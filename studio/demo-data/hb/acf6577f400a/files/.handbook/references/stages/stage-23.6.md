# Cross-cutting library tests, fixtures, and telemetry or rollout support  `stage-23.6`

This stage is a broad regression and support layer for shared libraries that sit outside the main app-server, core loop, TUI, and exec-server buckets. It does not drive startup or runtime directly; instead, it verifies the cross-cutting subsystems those phases depend on and supplies controlled fixtures and mock backends for doing so safely.

Its major test groups cover observability, configuration and policy resolution, extensibility surfaces, client/protocol plumbing, persistence, and low-level utilities. Analytics and telemetry tests confirm metrics, traces, logs, exporters, and routing policies. Configuration and environment tests lock down config loading, cloud-managed overlays, feature flags, sandbox and hook policy, and startup-time environment construction. Plugin, extension, skill, MCP, and tool tests validate discovery, normalization, lifecycle, and execution contracts. API, model, prompt, protocol, and transport tests check request encoding, auth, model selection, prompt rendering, and network transports. Memories, rollout, and state tests ensure traces, histories, indexes, and runtime databases can be recorded, reduced, repaired, and restored. Utility-focused files add targeted coverage for file watching, hook output spilling, terminal detection, line buffering, string and image truncation/loading, goal accounting, and ChatGPT test aggregation, while mock clients and test-only namespaces provide reusable scaffolding for the broader suites.

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

`test` · `test execution`

This file exists to consolidate integration testing into one Rust test target rather than many standalone files. Its only action is to declare the `suite` submodule, causing Cargo’s integration-test harness to compile and run the tests found under `tests/suite/`. The comment documents the intent explicitly: former separate integration tests have been grouped into submodules beneath a shared binary. That organization can reduce duplicated setup cost, centralize shared helpers and fixtures, and make it easier to coordinate common test state or module-level utilities. There is no runtime production behavior here, but the file is still structurally significant because Cargo treats each file in `tests/` as a separate integration test crate; by using one aggregator file, the project chooses a single crate with nested modules instead. Readers should understand that adding a new integration suite likely means editing `tests/suite/mod.rs` or adding modules beneath it, not creating another top-level test file.


### `chatgpt/tests/suite/mod.rs`

`test` · `test discovery / test execution`

This module is the internal index for the aggregated integration tests declared by `tests/all.rs`. It currently includes the `apply_command_e2e` module, meaning that end-to-end coverage for the apply-command flow is compiled into the shared integration-test binary through this file. The comments clarify that these modules were formerly standalone integration tests and are now grouped together. That design matters because it changes test compilation boundaries: shared helpers can live alongside sibling modules, and test-only state can be organized under a common namespace instead of duplicated across multiple integration crates. There is no executable logic or helper code in this file itself; its role is to define which suites participate in the aggregate run. For maintainers, this file is the place where new suite modules are registered so they become visible to the test harness.


### Support fixtures and namespaces
These files provide shared test-support scaffolding and placeholder module roots used by other library code and tests.

### `cloud-tasks-mock-client/src/lib.rs`

`test` · `test setup and simulated request handling`

This crate root is intentionally minimal: it declares the internal `mock` module and re-exports `MockClient` as the crate’s public API. The absence of any other exports signals that the crate’s sole purpose is to provide a test double or in-memory stand-in for the real cloud tasks client. By hiding the module and exposing only the top-level type, the crate keeps its mocking internals flexible while giving dependent tests a simple import path. In a larger system, this kind of crate is typically used to simulate task creation, listing, status transitions, or apply outcomes without requiring network access or a live backend. Although there is no runtime logic in this file itself, it is an important seam in the architecture because it separates production transport concerns from deterministic test behavior and local development scaffolding.


### `core/src/apps/mod.rs`

`test` · `test-only`

This file is intentionally sparse. It conditionally declares a `render` submodule only when compiling tests via `#[cfg(test)]`. That means the `apps` namespace currently has no production exports or runtime behavior from this root; instead, it reserves the module path and hosts test-specific helpers or assertions related to app rendering.

The conditional compilation is the key design detail: any code in `render` is excluded from normal builds, reducing binary size and preventing test scaffolding from leaking into production APIs. As a result, this file functions more as structural organization than as logic. It signals that app-related functionality either lives elsewhere or is still being built out, while preserving a coherent place for tests that exercise rendering behavior under the `core::apps` namespace.


### Focused subsystem correctness tests
These files cover targeted unit and integration tests for accounting, buffering, output spilling, terminal detection, file watching, and string truncation behavior.

### `ext/goal/tests/accounting.rs`

`test` · `test execution`

This small test file imports the production `accounting.rs` module directly and exercises only the token-accounting state machine. The first test establishes the key invariant that token deltas are measured from the usage snapshot captured at turn start, not from incremental updates; after starting a default-mode turn with one `TokenUsage` baseline and recording a later larger `TokenUsage`, it asserts both the per-turn delta and the thread-unflushed delta equal the exact difference in total tokens. The second test covers the mode gate: when a turn starts in `ModeKind::Plan`, later token usage should be ignored entirely and `record_token_usage` should return `None`. A local `token_usage` helper constructs `TokenUsage` values with explicit field-by-field totals so the tests remain readable and avoid repeated struct literals. Together these tests document two subtle behaviors that downstream goal accounting depends on: exact baseline subtraction and complete exclusion of plan turns from goal progress.

#### Function details

##### `goal_accounting_uses_turn_start_baseline_for_exact_deltas`  (lines 12–36)

```
fn goal_accounting_uses_turn_start_baseline_for_exact_deltas()
```

**Purpose**: Verifies that recorded token usage is computed against the turn-start baseline rather than against prior intermediate observations. It checks both the turn-local and thread-unflushed deltas.

**Data flow**: It creates a default `GoalAccountingState`, starts turn `turn-1` in default mode with a baseline `TokenUsage`, records a later larger `TokenUsage`, unwraps the returned accounting record, and asserts that both delta fields equal 28.

**Call relations**: This is a standalone unit test run by the test harness. It uses the local `token_usage` helper to build deterministic inputs and directly exercises production accounting methods.

*Call graph*: calls 2 internal fn (default, token_usage); 1 external calls (assert_eq!).


##### `goal_accounting_ignores_plan_mode_turns`  (lines 39–52)

```
fn goal_accounting_ignores_plan_mode_turns()
```

**Purpose**: Verifies that plan-mode turns do not contribute any goal token accounting. It documents the special-case exclusion for planning turns.

**Data flow**: It creates a default `GoalAccountingState`, starts `turn-1` in `ModeKind::Plan` with zero usage, records a nonzero `TokenUsage`, captures the optional result, and asserts that the result is `None`.

**Call relations**: This is another isolated unit test. It depends on the same helper constructor and directly validates the production accounting branch that suppresses plan-mode accumulation.

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

**Purpose**: Constructs `TokenUsage` test fixtures from explicit numeric components. It keeps the tests concise while preserving visibility into each token field.

**Data flow**: It takes five `i64` counters, places them into a `TokenUsage` struct, and returns that struct without side effects.

**Call relations**: It is called by both tests in this file to create baseline and updated usage snapshots with exact totals.

*Call graph*: called by 2 (goal_accounting_ignores_plan_mode_turns, goal_accounting_uses_turn_start_baseline_for_exact_deltas).


### `file-watcher/src/file_watcher_tests.rs`

`test` · `test execution`

This file is the behavioral test suite for the file-watcher module defined in the parent module. It starts with two tiny helpers: `path` builds `PathBuf`s from string literals, and `notify_event` constructs synthetic `notify::Event` values with one or more paths. The async tests then focus on the two receiver wrappers. `ThrottledWatchReceiver` is expected to emit the first batch immediately, suppress additional batches until the throttle interval elapses, and flush pending paths on channel shutdown. `DebouncedWatchReceiver` instead waits for quiet time before emitting each coalesced batch and also flushes on shutdown.

The rest of the file validates watcher registration and routing semantics. Registrations are deduplicated by watched path and recursive scope, dropping a registration or subscriber unregisters paths, and missing targets are watched via the nearest existing parent directory using bounded non-recursive fallback. Several tests cover how those fallback watches behave when the missing file or directory later appears: parent-directory events should be translated back into the originally requested path, and directory watches should migrate from the parent fallback to the newly created directory.

Notification routing is tested with multiple subscribers, recursive vs non-recursive watches, and ancestor-path events. There is also a concurrency regression test asserting that unregister holds the watcher state lock until the underlying unwatch completes, preventing races with concurrent registration. Finally, the suite checks that the event loop filters out non-mutating `notify` events and that dropping a live watcher releases its inner watcher allocation.

#### Function details

##### `path`  (lines 11–13)

```
fn path(name: &str) -> PathBuf
```

**Purpose**: Convenience helper that converts a string literal into a `PathBuf` for concise test setup.

**Data flow**: Takes `&str`, calls `PathBuf::from(name)`, and returns the resulting path.

**Call relations**: Used throughout the test file to keep synthetic path construction compact and readable.

*Call graph*: called by 7 (debounced_receiver_coalesces_each_event_batch, debounced_receiver_flushes_pending_on_shutdown, matching_subscribers_are_notified, non_recursive_watch_ignores_grandchildren, spawn_event_loop_filters_non_mutating_events, throttled_receiver_coalesces_within_interval, throttled_receiver_flushes_pending_on_shutdown); 1 external calls (from).


##### `notify_event`  (lines 15–21)

```
fn notify_event(kind: EventKind, paths: Vec<PathBuf>) -> Event
```

**Purpose**: Builds a synthetic `notify::Event` with a chosen kind and a list of affected paths.

**Data flow**: Creates `Event::new(kind)`, then iterates the provided `Vec<PathBuf>`, repeatedly calling `add_path` and reassigning the event, finally returning it.

**Call relations**: Used by tests that inject raw notify events into the watcher event loop.

*Call graph*: called by 1 (spawn_event_loop_filters_non_mutating_events); 1 external calls (new).


##### `throttled_receiver_coalesces_within_interval`  (lines 24–52)

```
async fn throttled_receiver_coalesces_within_interval()
```

**Purpose**: Verifies that the throttled receiver emits the first batch immediately and coalesces later batches until the throttle window expires.

**Data flow**: Creates a watch channel and `ThrottledWatchReceiver`, sends one changed path and awaits an immediate event, sends two more paths, asserts a short timeout expires without emission, then awaits the coalesced second event and compares exact paths.

**Call relations**: Exercises the timing semantics of `ThrottledWatchReceiver::recv`.

*Call graph*: calls 2 internal fn (new, path); 3 external calls (from_secs, assert_eq!, timeout).


##### `throttled_receiver_flushes_pending_on_shutdown`  (lines 55–87)

```
async fn throttled_receiver_flushes_pending_on_shutdown()
```

**Purpose**: Checks that pending throttled paths are emitted when the sender side closes, followed by a final `None`.

**Data flow**: Creates channel and throttled receiver, sends one path and consumes it, sends another path, drops the sender, awaits the flushed pending event, then awaits channel closure and asserts `None`.

**Call relations**: Covers the shutdown-flush branch of the throttled receiver.

*Call graph*: calls 2 internal fn (new, path); 3 external calls (from_secs, assert_eq!, timeout).


##### `debounced_receiver_coalesces_each_event_batch`  (lines 90–119)

```
async fn debounced_receiver_coalesces_each_event_batch()
```

**Purpose**: Verifies that the debounced receiver waits for the debounce interval and merges events arriving within that window.

**Data flow**: Creates channel and `DebouncedWatchReceiver`, sends one path and awaits the first delayed event, sends another path and confirms no early emission, sends a third path within the debounce window, then awaits one event containing both later paths.

**Call relations**: Exercises the debounce semantics distinct from throttling.

*Call graph*: calls 2 internal fn (new, path); 2 external calls (assert_eq!, timeout).


##### `debounced_receiver_flushes_pending_on_shutdown`  (lines 122–143)

```
async fn debounced_receiver_flushes_pending_on_shutdown()
```

**Purpose**: Checks that a debounced receiver flushes its pending batch when the sender is dropped.

**Data flow**: Creates channel and debounced receiver, sends one path, drops the sender, awaits the flushed event, then awaits closure and asserts `None`.

**Call relations**: Covers the shutdown behavior of the debounced receiver.

*Call graph*: calls 2 internal fn (new, path); 3 external calls (from_secs, assert_eq!, timeout).


##### `is_mutating_event_filters_non_mutating_event_kinds`  (lines 146–168)

```
fn is_mutating_event_filters_non_mutating_event_kinds()
```

**Purpose**: Verifies that only mutating notify event kinds are treated as relevant file changes.

**Data flow**: Constructs synthetic create, modify, and access events with `notify_event`, passes them to `is_mutating_event`, and asserts true for create/modify and false for access.

**Call relations**: Tests the event-kind filter used by the watcher event loop.

*Call graph*: 1 external calls (assert_eq!).


##### `register_dedupes_by_path_and_scope`  (lines 171–187)

```
fn register_dedupes_by_path_and_scope()
```

**Purpose**: Checks that repeated registrations of the same path and recursive mode are deduplicated while distinct scopes are counted separately.

**Data flow**: Creates temp directories, a noop watcher, and one subscriber; registers the same path twice non-recursively, once recursively, and another path recursively; then asserts `watch_counts_for_test` reports the expected non-recursive/recursive counts per path.

**Call relations**: Exercises watcher bookkeeping for registration reference counts.

*Call graph*: calls 1 internal fn (noop); 4 external calls (new, assert_eq!, create_dir, tempdir).


##### `watch_registration_drop_unregisters_paths`  (lines 190–202)

```
fn watch_registration_drop_unregisters_paths()
```

**Purpose**: Verifies that dropping an individual registration removes its watch bookkeeping.

**Data flow**: Creates a temp directory and noop watcher, registers one recursive path, drops the returned registration handle, and asserts `watch_counts_for_test` returns `None` for that path.

**Call relations**: Tests RAII-based unregistration for a single watch handle.

*Call graph*: calls 1 internal fn (noop); 4 external calls (new, assert_eq!, create_dir, tempdir).


##### `subscriber_drop_unregisters_paths`  (lines 205–218)

```
fn subscriber_drop_unregisters_paths()
```

**Purpose**: Checks that dropping a subscriber unregisters all paths it had registered.

**Data flow**: Creates a temp directory and noop watcher, creates a subscriber inside a block, registers a path, exits the block to drop the subscriber, then asserts the watcher no longer tracks the path.

**Call relations**: Covers subscriber-scoped cleanup independent of explicit registration drops.

*Call graph*: calls 1 internal fn (noop); 4 external calls (new, assert_eq!, create_dir, tempdir).


##### `missing_path_registers_nearest_existing_parent`  (lines 221–236)

```
fn missing_path_registers_nearest_existing_parent()
```

**Purpose**: Verifies that registering a missing file falls back to watching the nearest existing parent directory non-recursively.

**Data flow**: Creates a temp directory and a missing child path, registers that path on a noop watcher, asserts the temp directory has one non-recursive watch and the missing file itself has none, then drops the registration and asserts the parent watch is removed.

**Call relations**: Tests fallback registration logic for absent targets.

*Call graph*: calls 1 internal fn (noop); 3 external calls (new, assert_eq!, tempdir).


##### `deeply_missing_path_registers_nearest_existing_directory_ancestor`  (lines 239–250)

```
fn deeply_missing_path_registers_nearest_existing_directory_ancestor()
```

**Purpose**: Checks that fallback registration skips over missing path components and file prefixes to the nearest existing directory ancestor.

**Data flow**: Creates a temp directory, writes a file named `refs`, constructs a deeper missing path under `refs/heads/main`, registers it, and asserts the watcher falls back to the temp directory rather than the non-directory `refs` path.

**Call relations**: Covers a subtle missing-path edge case in fallback ancestor selection.

*Call graph*: calls 1 internal fn (noop); 4 external calls (new, assert_eq!, write, tempdir).


##### `receiver_closes_when_subscriber_drops`  (lines 253–263)

```
async fn receiver_closes_when_subscriber_drops()
```

**Purpose**: Ensures the subscriber’s receiver channel closes when the subscriber is dropped.

**Data flow**: Creates a noop watcher and subscriber/receiver pair, drops the subscriber, awaits `rx.recv()` with timeout, and asserts it returns `None`.

**Call relations**: Tests lifecycle coupling between subscriber ownership and event delivery.

*Call graph*: calls 1 internal fn (noop); 4 external calls (new, from_secs, assert_eq!, timeout).


##### `recursive_registration_downgrades_to_non_recursive_after_drop`  (lines 266–297)

```
fn recursive_registration_downgrades_to_non_recursive_after_drop()
```

**Purpose**: Verifies that when both recursive and non-recursive registrations exist for one path, dropping the recursive one downgrades the live watcher state instead of removing the path entirely.

**Data flow**: Creates a live watcher and path, registers it non-recursively and recursively, inspects `inner.watched_paths` under lock to confirm `Recursive`, drops the recursive registration, rechecks that the mode became `NonRecursive`, then drops the remaining registration.

**Call relations**: Exercises interaction between registration reference counts and the underlying notify watcher mode.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert_eq!, create_dir, tempdir).


##### `unregister_holds_state_lock_until_unwatch_finishes`  (lines 300–350)

```
fn unregister_holds_state_lock_until_unwatch_finishes()
```

**Purpose**: Regression test ensuring unregister keeps the watcher state lock held until the underlying unwatch operation completes, preventing concurrent registration races.

**Data flow**: Creates a live watcher, two subscribers, and one recursive registration. It locks the watcher inner state, spawns a thread that drops the registration, repeatedly probes whether `watcher.state.try_write()` is blocked, then spawns another thread attempting a new non-recursive registration. After releasing the inner lock, it joins both threads and asserts final watch counts and recursive mode are consistent.

**Call relations**: Targets a concurrency-sensitive path in watcher unregister/register coordination.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_eq!, create_dir, spawn, tempdir).


##### `matching_subscribers_are_notified`  (lines 353–379)

```
async fn matching_subscribers_are_notified()
```

**Purpose**: Checks that only subscribers whose registered paths match an event receive notifications.

**Data flow**: Creates a noop watcher with two subscribers watching different recursive roots, wraps both receivers in throttled receivers, sends one changed path under the skills root, awaits a delivered event on the matching receiver, and asserts the other receiver times out.

**Call relations**: Tests path-based routing across multiple subscribers.

*Call graph*: calls 3 internal fn (noop, new, path); 5 external calls (new, from_secs, assert_eq!, timeout, vec!).


##### `non_recursive_watch_ignores_grandchildren`  (lines 382–394)

```
async fn non_recursive_watch_ignores_grandchildren()
```

**Purpose**: Verifies that non-recursive watches do not receive events from deeper descendants.

**Data flow**: Creates a noop watcher, registers `/tmp/skills` non-recursively, sends a change for `/tmp/skills/nested/SKILL.md`, and asserts the receiver times out without an event.

**Call relations**: Covers recursive-scope filtering in event routing.

*Call graph*: calls 3 internal fn (noop, new, path); 4 external calls (new, assert_eq!, timeout, vec!).


##### `ancestor_events_notify_child_watches`  (lines 397–423)

```
async fn ancestor_events_notify_child_watches()
```

**Purpose**: Checks that an event on an ancestor directory can notify a watch registered on a child path.

**Data flow**: Creates a temp directory tree with a concrete child file, registers the child file path non-recursively on a noop watcher, sends an event for the ancestor `skills` directory, awaits a notification, and asserts the delivered event contains the ancestor path.

**Call relations**: Exercises ancestor-to-child matching semantics used for fallback and directory-level notifications.

*Call graph*: calls 2 internal fn (noop, new); 8 external calls (new, from_secs, assert_eq!, create_dir, write, tempdir, timeout, vec!).


##### `missing_file_watch_reports_requested_path_when_parent_changes`  (lines 426–457)

```
async fn missing_file_watch_reports_requested_path_when_parent_changes()
```

**Purpose**: Verifies that a missing-file fallback watch reports the originally requested file path once the file appears and the parent directory changes.

**Data flow**: Creates a temp directory and missing file path, registers it, sends a sibling-path event and confirms no notification, then creates the missing file, sends a parent-directory event, awaits a notification, and asserts the delivered path is the requested file path rather than the parent.

**Call relations**: Tests translation from fallback parent watches back to the logical watched target.

*Call graph*: calls 2 internal fn (noop, new); 7 external calls (new, from_secs, assert_eq!, write, tempdir, timeout, vec!).


##### `missing_file_watch_reports_requested_path_when_parent_delete_event_arrives`  (lines 460–499)

```
async fn missing_file_watch_reports_requested_path_when_parent_delete_event_arrives()
```

**Purpose**: Checks that fallback watches report both creation and deletion of a previously missing file as events on the requested path.

**Data flow**: Registers a missing file path, creates the file and sends a parent event to observe a creation notification, then removes the file, sends another parent event, and asserts a second notification again reports the requested file path.

**Call relations**: Extends the previous fallback-watch test to cover deletion as well as creation.

*Call graph*: calls 2 internal fn (noop, new); 8 external calls (new, from_secs, assert_eq!, remove_file, write, tempdir, timeout, vec!).


##### `missing_directory_watch_moves_to_created_directory_for_child_events`  (lines 502–547)

```
async fn missing_directory_watch_moves_to_created_directory_for_child_events()
```

**Purpose**: Verifies that a missing-directory watch initially falls back to the parent, then migrates to the created directory and starts reporting child events directly.

**Data flow**: Creates a temp directory and missing child directory path, registers it non-recursively, asserts the parent is watched, creates the directory, sends a parent event and asserts a notification for the requested directory plus updated watch counts showing migration, then creates a child file, sends a child event, and asserts the child path is delivered.

**Call relations**: Tests both fallback migration and subsequent direct child-event routing.

*Call graph*: calls 2 internal fn (noop, new); 8 external calls (new, from_secs, assert_eq!, create_dir, write, tempdir, timeout, vec!).


##### `spawn_event_loop_filters_non_mutating_events`  (lines 550–583)

```
async fn spawn_event_loop_filters_non_mutating_events()
```

**Purpose**: Checks that the watcher’s raw event loop ignores non-mutating notify events and forwards mutating ones.

**Data flow**: Creates a noop watcher and subscriber, wraps the receiver in a throttled receiver, spawns the event loop with an unbounded raw channel, sends an access event and asserts no notification arrives, then sends a create event and asserts the expected file path is delivered.

**Call relations**: Exercises the event-loop path from raw notify events through `is_mutating_event` to subscriber delivery.

*Call graph*: calls 4 internal fn (noop, new, notify_event, path); 9 external calls (Open, new, from_secs, Access, Create, assert_eq!, unbounded_channel, timeout, vec!).


##### `dropping_live_watcher_releases_inner_watcher`  (lines 586–593)

```
async fn dropping_live_watcher_releases_inner_watcher()
```

**Purpose**: Ensures dropping a live `FileWatcher` releases its inner watcher allocation rather than leaking it through lingering strong references.

**Data flow**: Creates a live watcher, downgrades its inner `Arc` to `Weak`, drops the watcher, and asserts `weak_inner.upgrade()` returns `None`.

**Call relations**: Covers watcher teardown and ownership cleanup.

*Call graph*: calls 1 internal fn (new); 2 external calls (downgrade, assert_eq!).


### `hooks/src/output_spill_tests.rs`

`test` · `test-time validation of output spilling`

This test module exercises `HookOutputSpiller` end to end using temporary directories. Rather than relying on the default OS temp location, each test constructs an isolated `output_dir` under a `tempfile::tempdir()` root and injects it directly into a `HookOutputSpiller`, which keeps the assertions deterministic and side-effect free.

`small_hook_output_remains_inline` covers the fast path where token count stays below the configured limit. It calls `maybe_spill_text` with a short string, asserts the returned text is unchanged, and confirms that the spill directory was never created. That checks both the content behavior and the optimization that avoids unnecessary filesystem work.

`large_hook_output_spills_to_file` drives the oversized-output path by repeating `"hook output "` 1,000 times. After calling `maybe_spill_text`, it asserts that the returned preview contains the truncation marker, extracts the `Full hook output saved to:` line from the preview, and reads the referenced file back from disk to ensure the full original text was preserved exactly. Together these tests validate the two key invariants of the spiller: small outputs stay inline, and large outputs remain recoverable without exposing the full text to the model.

#### Function details

##### `small_hook_output_remains_inline`  (lines 7–22)

```
async fn small_hook_output_remains_inline() -> Result<()>
```

**Purpose**: Verifies that short hook output is returned unchanged and does not create any spill directory.

**Data flow**: Creates a temporary directory, converts it to an `AbsolutePathBuf`, appends `HOOK_OUTPUTS_DIR`, constructs a `HookOutputSpiller` with that path, generates a fresh `ThreadId`, awaits `maybe_spill_text(thread_id, "short".to_string())`, then asserts the returned string is `short` and the output directory does not exist.

**Call relations**: Exercises the early-return branch of `HookOutputSpiller::maybe_spill_text` where token count is below the spill threshold.

*Call graph*: calls 2 internal fn (new, from_absolute_path); 3 external calls (assert!, assert_eq!, tempdir).


##### `large_hook_output_spills_to_file`  (lines 25–42)

```
async fn large_hook_output_spills_to_file() -> Result<()>
```

**Purpose**: Checks that oversized hook output is truncated in the visible preview and fully preserved in a spill file.

**Data flow**: Creates a temporary directory, builds a large repeated text string, constructs a `HookOutputSpiller` rooted under that temp directory, awaits `maybe_spill_text(ThreadId::new(), text.clone())`, asserts the preview mentions truncation, extracts the saved-file path from the preview footer, reads that file asynchronously, and asserts its contents equal the original large text.

**Call relations**: Exercises the spill-to-disk branch of `HookOutputSpiller::maybe_spill_text`, including preview generation and file persistence.

*Call graph*: calls 2 internal fn (new, from_absolute_path); 3 external calls (assert!, assert_eq!, tempdir).


### `ollama/src/line_buffer_tests.rs`

`test` · `test-time validation`

This test file exists solely to pin down the subtle optimization in `LineBuffer`: the `scanned_len` cursor should advance when no newline is found, and subsequent searches should begin only in newly appended bytes. The test constructs a default buffer, appends `b"partial"`, confirms `take_line()` returns `None`, and then asserts the internal state exactly matches a `BytesMut` containing `partial` with `scanned_len == 7`. It repeats the process after appending `b" line"`, expecting no line and `scanned_len == 12`, which proves the implementation did not reset the scan cursor unnecessarily.

Finally, it appends `b"\nnext"`, calls `take_line()`, and expects to receive `Some(BytesMut::from(&b"partial line\n"[..]))`. After extraction, it asserts the remaining buffer contains only `b"next"` and that `scanned_len` has been reset to `0`, because the leftover suffix has not yet been searched. By asserting internal fields directly, the test documents both the external behavior and the intended performance invariant.

#### Function details

##### `searches_only_new_bytes_after_partial_line`  (lines 7–42)

```
fn searches_only_new_bytes_after_partial_line()
```

**Purpose**: Verifies the `LineBuffer` optimization that only newly appended bytes are searched after an incomplete line has already been scanned once. It also checks that extracting a completed line resets the scan cursor.

**Data flow**: Creates `LineBuffer::default()`, appends three byte slices in sequence, calls `take_line()` after each append, and compares both returned values and the full internal `LineBuffer` state against expected `BytesMut` and `scanned_len` values.

**Call relations**: This is a direct unit test of `LineBuffer` internals rather than a higher-level integration test. It complements production callers by asserting the invariant they depend on for efficient incremental parsing.

*Call graph*: 2 external calls (assert_eq!, default).


### `terminal-detection/src/terminal_tests.rs`

`test` · `test execution`

This test module builds a controllable `FakeEnvironment` that implements the production `Environment` trait with three pieces of state: a `HashMap<String, String>` for environment variables, a stored `TmuxClientInfo`, and an optional synthetic Zellij version. Builder-style helpers (`with_var`, `with_tmux_client_info`, `with_zellij_version`) let each test assemble only the signals relevant to the scenario. A local `terminal_info(...)` helper constructs expected `TerminalInfo` values directly so assertions stay concise and compare exact field contents.

The tests are broad and intentionally encode precedence rules, not just positive matches. They verify that `TERM_PROGRAM` overrides later probes like `WEZTERM_VERSION`; that blank version variables are treated as absent; that tmux sessions can be attributed to the underlying client terminal via `client_termtype` and `client_termname`; that Zellij multiplexer detection can source versions from either `ZELLIJ_VERSION` or the environment abstraction’s fallback; and that terminal-specific probes for iTerm2, Apple Terminal, Ghostty, VS Code, Warp, WezTerm, kitty, Alacritty, Konsole, GNOME Terminal, VTE, and Windows Terminal all produce the expected `TerminalInfo` and `user_agent_token()` output. Fallback behavior is also covered for generic `TERM`, `TERM=dumb`, and fully unknown environments, plus a direct parser test for `parse_zellij_version` and a predicate test for `TerminalInfo::is_zellij`.

#### Function details

##### `FakeEnvironment::new`  (lines 12–18)

```
fn new() -> Self
```

**Purpose**: Creates an empty fake environment with no variables, no tmux client metadata, and no synthetic Zellij version. It is the starting point for nearly every test case.

**Data flow**: Allocates an empty `HashMap`, initializes `tmux_client_info` with `TmuxClientInfo::default()`, sets `zellij_version` to `None`, and returns the populated `FakeEnvironment`.

**Call relations**: Most test functions begin by calling this constructor and then chaining builder helpers to model a specific environment layout.

*Call graph*: called by 21 (detects_alacritty, detects_apple_terminal, detects_ghostty, detects_gnome_terminal, detects_iterm2, detects_kitty, detects_konsole, detects_term_fallbacks, detects_term_program, detects_tmux_client_termname (+11 more)); 2 external calls (new, default).


##### `FakeEnvironment::with_var`  (lines 20–23)

```
fn with_var(mut self, key: &str, value: &str) -> Self
```

**Purpose**: Adds or replaces one fake environment variable in the builder chain. It supports concise scenario setup in tests.

**Data flow**: Takes ownership of `self`, inserts `key -> value` into the internal `vars` map after converting both to owned `String`s, and returns the modified `FakeEnvironment`.

**Call relations**: Tests chain this after `FakeEnvironment::new` to define the exact variables consumed by `detect_terminal_info_from_env`.


##### `FakeEnvironment::with_tmux_client_info`  (lines 25–31)

```
fn with_tmux_client_info(mut self, termtype: Option<&str>, termname: Option<&str>) -> Self
```

**Purpose**: Injects synthetic tmux client terminal metadata for tmux-specific detection tests. It can set either or both of `termtype` and `termname`.

**Data flow**: Consumes `self`, converts the optional `&str` inputs into owned `String`s, stores them in a new `TmuxClientInfo`, assigns that to `self.tmux_client_info`, and returns the updated environment.

**Call relations**: Tmux-focused tests use this builder to drive the `terminal_from_tmux_client_info` branch without invoking real `tmux` commands.


##### `FakeEnvironment::with_zellij_version`  (lines 33–36)

```
fn with_zellij_version(mut self, version: &str) -> Self
```

**Purpose**: Injects a synthetic Zellij version independent of `ZELLIJ_VERSION` environment variables. This lets tests exercise the environment abstraction’s fallback path.

**Data flow**: Consumes `self`, stores `Some(version.to_string())` in `self.zellij_version`, and returns the updated fake environment.

**Call relations**: It is used by the command-version-style Zellij test to mimic `ProcessEnvironment::zellij_version` behavior without spawning a subprocess.


##### `FakeEnvironment::var`  (lines 40–42)

```
fn var(&self, name: &str) -> Option<String>
```

**Purpose**: Implements `Environment::var` by reading from the fake variable map. It gives tests deterministic control over environment lookups.

**Data flow**: Reads `name`, looks it up in `self.vars`, clones the stored string if present, and returns `Option<String>`.

**Call relations**: This method is called indirectly by the production detection logic through the `Environment` trait.


##### `FakeEnvironment::tmux_client_info`  (lines 44–46)

```
fn tmux_client_info(&self) -> TmuxClientInfo
```

**Purpose**: Implements `Environment::tmux_client_info` by returning the preloaded fake tmux metadata. It avoids any subprocess interaction in tests.

**Data flow**: Clones `self.tmux_client_info` and returns the clone.

**Call relations**: The tmux detection branch in `detect_terminal_info_from_env` reaches this method when tests simulate `TERM_PROGRAM=tmux` with an active tmux multiplexer.

*Call graph*: 1 external calls (clone).


##### `FakeEnvironment::zellij_version`  (lines 48–52)

```
fn zellij_version(&self) -> Option<String>
```

**Purpose**: Implements `Environment::zellij_version` with test-controlled precedence: explicit injected version first, then nonblank `ZELLIJ_VERSION` from the fake variable map. This mirrors production’s ability to source versions from more than one place.

**Data flow**: Reads `self.zellij_version`; if present, clones and returns it, otherwise calls `self.var_non_empty("ZELLIJ_VERSION")` and returns that optional string.

**Call relations**: This method is consumed by `detect_multiplexer` during Zellij detection tests.


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

**Purpose**: Constructs expected `TerminalInfo` values inline for assertions. It keeps test bodies readable by avoiding repeated manual struct assembly.

**Data flow**: Takes a `TerminalName`, optional borrowed strings for `term_program`, `version`, and `term`, plus an optional `Multiplexer`; converts the borrowed strings into owned `String`s and returns a `TerminalInfo` literal.

**Call relations**: Many tests call this helper when comparing the output of `detect_terminal_info_from_env` against an exact expected struct.

*Call graph*: called by 1 (terminal_info_reports_is_zellij).


##### `detects_term_program`  (lines 72–136)

```
fn detects_term_program()
```

**Purpose**: Verifies that `TERM_PROGRAM`-based detection wins over later probes, preserves nonblank `TERM_PROGRAM_VERSION`, and ignores blank versions. It also checks the corresponding User-Agent token formatting.

**Data flow**: Builds several fake environments with combinations of `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, and `WEZTERM_VERSION`; runs `detect_terminal_info_from_env`; compares both the returned `TerminalInfo` and `user_agent_token()` output against expected values.

**Call relations**: This test exercises the earliest and highest-precedence branch in the main detection routine.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `terminal_info_reports_is_zellij`  (lines 139–157)

```
fn terminal_info_reports_is_zellij()
```

**Purpose**: Checks that `TerminalInfo::is_zellij` returns true only for `Multiplexer::Zellij` and false for other multiplexer variants. It validates the convenience predicate independently of environment detection.

**Data flow**: Constructs one `TerminalInfo` with `Some(Multiplexer::Zellij { .. })` and another with `Some(Multiplexer::Tmux { .. })`, then asserts the boolean result of `is_zellij()` on each.

**Call relations**: This test targets the `TerminalInfo` helper directly rather than the environment-driven detection pipeline.

*Call graph*: calls 1 internal fn (terminal_info); 1 external calls (assert!).


##### `detects_iterm2`  (lines 160–179)

```
fn detects_iterm2()
```

**Purpose**: Confirms that iTerm2 can be detected from iTerm-specific session variables even without `TERM_PROGRAM`. It also verifies the canonical User-Agent token used for that path.

**Data flow**: Creates a fake environment with `ITERM_SESSION_ID`, runs detection, and asserts both the structured result and the `iTerm.app` token.

**Call relations**: It covers the iTerm-specific branch that follows the `WEZTERM_VERSION` probe in the detection order.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_apple_terminal`  (lines 182–220)

```
fn detects_apple_terminal()
```

**Purpose**: Covers both Apple Terminal detection paths: explicit `TERM_PROGRAM=Apple_Terminal` and fallback `TERM_SESSION_ID`. It verifies that both produce the expected metadata and token.

**Data flow**: Runs detection twice with separate fake environments, once using `TERM_PROGRAM` and once using `TERM_SESSION_ID`, then compares each result and token to expected values.

**Call relations**: This test validates both the normalized `TERM_PROGRAM` path and the dedicated Apple Terminal marker branch.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_ghostty`  (lines 223–242)

```
fn detects_ghostty()
```

**Purpose**: Verifies that `TERM_PROGRAM=Ghostty` maps to `TerminalName::Ghostty` and emits the expected token. It checks a straightforward explicit-program case.

**Data flow**: Creates a fake environment with `TERM_PROGRAM=Ghostty`, runs detection, and asserts the resulting `TerminalInfo` and `Ghostty` token.

**Call relations**: It exercises `terminal_name_from_term_program` through the main `TERM_PROGRAM` branch.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_vscode`  (lines 245–266)

```
fn detects_vscode()
```

**Purpose**: Checks Visual Studio Code integrated terminal detection from `TERM_PROGRAM` and version propagation from `TERM_PROGRAM_VERSION`. It also validates versioned token formatting.

**Data flow**: Builds a fake environment with `TERM_PROGRAM=vscode` and a version string, runs detection, and asserts both the structured metadata and `vscode/<version>` token.

**Call relations**: This test covers another normalized `TERM_PROGRAM` path with version handling.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_warp_terminal`  (lines 269–290)

```
fn detects_warp_terminal()
```

**Purpose**: Verifies Warp detection from `TERM_PROGRAM=WarpTerminal`, including preservation of a complex version string containing punctuation. It ensures sanitization does not alter already-valid characters.

**Data flow**: Creates a fake environment with Warp program and version variables, runs detection, and compares the result and token to exact expected strings.

**Call relations**: It exercises the `TERM_PROGRAM` normalization path for Warp and the token formatter’s version branch.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_tmux_multiplexer`  (lines 293–315)

```
fn detects_tmux_multiplexer()
```

**Purpose**: Confirms that tmux multiplexer detection records `Multiplexer::Tmux` and, when `TERM_PROGRAM=tmux`, uses tmux client metadata instead of reporting tmux itself. This case covers an unknown client terminal type plus a client term name.

**Data flow**: Builds a fake environment with `TMUX`, `TERM_PROGRAM=tmux`, and synthetic tmux client info; runs detection; asserts that the result uses the client term type as `term_program`, the client term name as `term`, and includes tmux multiplexer metadata.

**Call relations**: This test drives the special tmux override branch inside `detect_terminal_info_from_env` and the fallback behavior inside `terminal_from_tmux_client_info`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_zellij_multiplexer`  (lines 318–332)

```
fn detects_zellij_multiplexer()
```

**Purpose**: Checks that Zellij session markers alone produce `Multiplexer::Zellij` even when no terminal emulator can be identified. It validates multiplexer-only detection.

**Data flow**: Creates a fake environment with `ZELLIJ=1`, runs detection, and asserts that the returned `TerminalInfo` is otherwise unknown but carries `Some(Multiplexer::Zellij { version: None })`.

**Call relations**: It exercises `detect_multiplexer` and the final `TerminalInfo::unknown` fallback together.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_zellij_multiplexer_version`  (lines 335–351)

```
fn detects_zellij_multiplexer_version()
```

**Purpose**: Verifies that a nonblank `ZELLIJ_VERSION` is captured into Zellij multiplexer metadata. It checks the default version source path.

**Data flow**: Creates a fake environment with `ZELLIJ_VERSION`, runs detection, and asserts that the resulting multiplexer contains the expected version string.

**Call relations**: This test targets the `Environment::zellij_version` path used by `detect_multiplexer`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_zellij_multiplexer_command_version`  (lines 354–372)

```
fn detects_zellij_multiplexer_command_version()
```

**Purpose**: Verifies that the environment abstraction can supply a Zellij version even without `ZELLIJ_VERSION` in the variable map. It models the production command fallback behavior.

**Data flow**: Builds a fake environment with `ZELLIJ=1` and an injected synthetic Zellij version, runs detection, and asserts that the multiplexer metadata includes that version.

**Call relations**: It specifically exercises the overridden `FakeEnvironment::zellij_version` path consumed by `detect_multiplexer`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `parses_zellij_version_output`  (lines 375–382)

```
fn parses_zellij_version_output()
```

**Purpose**: Tests the standalone parser for `zellij --version` output. It covers prefixed output, bare version output, and blank input.

**Data flow**: Calls `parse_zellij_version` with three representative strings and asserts the returned `Option<String>` values.

**Call relations**: This is a direct unit test of the parser helper rather than the full detection pipeline.

*Call graph*: 1 external calls (assert_eq!).


##### `detects_tmux_client_termtype`  (lines 385–407)

```
fn detects_tmux_client_termtype()
```

**Purpose**: Checks that tmux client `termtype` alone can identify the underlying terminal emulator. It verifies the branch where `termname` is absent.

**Data flow**: Creates a fake tmux environment with `TERM_PROGRAM=tmux` and `client_termtype=WezTerm`, runs detection, and asserts that the result reports `TerminalName::WezTerm` with `term_program=WezTerm` and tmux multiplexer metadata.

**Call relations**: This test exercises the preferred `termtype` path inside `terminal_from_tmux_client_info`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_tmux_client_termname`  (lines 410–432)

```
fn detects_tmux_client_termname()
```

**Purpose**: Checks the tmux fallback path where only `client_termname` is available. In that case the library should preserve the capability string as `term` and leave the terminal name unknown.

**Data flow**: Builds a fake tmux environment with `TERM_PROGRAM=tmux` and only `client_termname=xterm-256color`, runs detection, and asserts the resulting `TerminalInfo` and token.

**Call relations**: It covers the `termname`-only branch in `terminal_from_tmux_client_info`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_tmux_term_program_uses_client_termtype`  (lines 435–460)

```
fn detects_tmux_term_program_uses_client_termtype()
```

**Purpose**: Verifies the richest tmux override case: tmux version from `TERM_PROGRAM_VERSION`, underlying terminal program and version parsed from `client_termtype`, and client capability string preserved from `client_termname`.

**Data flow**: Creates a fake environment with tmux markers, `TERM_PROGRAM_VERSION=3.6a`, `client_termtype="ghostty 1.2.3"`, and `client_termname="xterm-ghostty"`; runs detection; asserts exact structured metadata and `ghostty/1.2.3` token output.

**Call relations**: This test drives `tmux_version_from_env`, `split_term_program_and_version`, and `terminal_from_tmux_client_info` together through the tmux-specialized branch.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_wezterm`  (lines 463–560)

```
fn detects_wezterm()
```

**Purpose**: Covers all supported WezTerm detection paths: `WEZTERM_VERSION`, `TERM_PROGRAM=WezTerm`, blank version handling, and `TERM` fallback values `wezterm` and `wezterm-mux`. It also checks the corresponding token choices.

**Data flow**: Builds multiple fake environments for each WezTerm scenario, runs detection for each, and asserts both the structured metadata and token string.

**Call relations**: This test spans several branches in `detect_terminal_info_from_env` and `TerminalInfo::from_term`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_kitty`  (lines 563–624)

```
fn detects_kitty()
```

**Purpose**: Verifies kitty detection from `KITTY_WINDOW_ID`, from explicit `TERM_PROGRAM`, and from `TERM` containing `kitty`. It also confirms kitty wins over Alacritty when both kitty-like `TERM` and `ALACRITTY_SOCKET` are present because kitty is checked first.

**Data flow**: Creates several fake environments representing each kitty scenario, runs detection, and compares the resulting metadata and tokens to expected values.

**Call relations**: This test encodes both positive detection and precedence ordering between adjacent kitty and Alacritty probes.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_alacritty`  (lines 627–686)

```
fn detects_alacritty()
```

**Purpose**: Checks Alacritty detection from `ALACRITTY_SOCKET`, explicit `TERM_PROGRAM`, and `TERM=alacritty`. It also verifies that the `TERM` path yields the canonical name token rather than preserving `TERM`.

**Data flow**: Runs detection against multiple fake environments and asserts exact `TerminalInfo` values and token strings for each Alacritty case.

**Call relations**: It covers both the dedicated Alacritty branch and the normalized `TERM_PROGRAM` branch.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_konsole`  (lines 689–748)

```
fn detects_konsole()
```

**Purpose**: Verifies Konsole detection from `KONSOLE_VERSION`, explicit `TERM_PROGRAM`, and blank-version handling. It ensures versioned and unversioned token formatting are correct.

**Data flow**: Creates fake environments for each Konsole scenario, runs detection, and asserts the resulting metadata and User-Agent token.

**Call relations**: This test exercises the Konsole-specific branch and the canonical-name formatting path with optional version.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_gnome_terminal`  (lines 751–791)

```
fn detects_gnome_terminal()
```

**Purpose**: Checks GNOME Terminal detection from `GNOME_TERMINAL_SCREEN` and from explicit `TERM_PROGRAM=gnome-terminal`. It validates both metadata and token formatting.

**Data flow**: Builds two fake environments, runs detection for each, and compares the outputs against expected `TerminalInfo` values and token strings.

**Call relations**: It covers the GNOME-specific marker branch and the normalized `TERM_PROGRAM` branch.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_vte`  (lines 794–849)

```
fn detects_vte()
```

**Purpose**: Verifies VTE backend detection from `VTE_VERSION`, explicit `TERM_PROGRAM=VTE`, and blank-version handling. It checks that canonical token formatting includes the version only when nonblank.

**Data flow**: Creates several fake environments for VTE scenarios, runs detection, and asserts exact metadata and token outputs.

**Call relations**: This test targets the VTE-specific branch and the canonical-name formatter.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_windows_terminal`  (lines 852–892)

```
fn detects_windows_terminal()
```

**Purpose**: Checks Windows Terminal detection from `WT_SESSION` and from explicit `TERM_PROGRAM=WindowsTerminal` with version. It validates both structured metadata and token output.

**Data flow**: Runs detection against two fake environments and asserts the resulting `TerminalInfo` values and User-Agent tokens.

**Call relations**: It covers the Windows Terminal marker branch and the normalized `TERM_PROGRAM` branch.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `detects_term_fallbacks`  (lines 895–944)

```
fn detects_term_fallbacks()
```

**Purpose**: Verifies the final fallback behavior when only `TERM` is available or when no identifying variables exist at all. It covers generic unknown terminals, `TERM=dumb`, and fully unknown environments.

**Data flow**: Creates fake environments for `TERM=xterm-256color`, `TERM=dumb`, and no variables; runs detection; asserts the resulting metadata and token strings for each case.

**Call relations**: This test exercises the tail end of `detect_terminal_info_from_env`, including `TerminalInfo::from_term` and `TerminalInfo::unknown`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


### `utils/string/src/truncate/tests.rs`

`test` · `test`

This test module exercises both the internal `split_string` helper and the public truncation functions from `truncate.rs`. The `split_string_*` tests cover the low-level slicing algorithm directly: ordinary ASCII splitting, empty input, zero prefix or suffix budgets, overlapping budgets that should preserve the whole string without counting removals, and several UTF-8 cases involving emoji to ensure byte budgets never cut through code points. Those UTF-8 assertions are particularly important because the truncation implementation works in bytes but must return valid `&str` slices.

The remaining tests validate the public APIs. `truncate_with_token_budget_returns_original_when_under_limit` confirms that strings under the approximate token budget are returned unchanged with no original-count metadata. `truncate_with_token_budget_reports_truncation_at_zero_limit` checks the special zero-budget path where only the marker remains and the original approximate token count is reported. The final two tests use mixed emoji and ASCII text to verify that token-based and byte-based truncation preserve both ends of the string, insert the correct marker wording and counts, and still respect UTF-8 boundaries.

Together these tests serve as executable documentation for the truncation contract: preserve valid UTF-8, keep both ends when possible, avoid duplicated overlap, and report truncation in the mode-specific units expected by callers.

#### Function details

##### `split_string_works`  (lines 7–20)

```
fn split_string_works()
```

**Purpose**: Checks basic ASCII splitting behavior for `split_string`, including a normal middle removal and the degenerate zero-budget case. It establishes the baseline semantics of removed-character counting and returned slices.

**Data flow**: The test calls `split_string("hello world", 5, 5)` and asserts it returns `(1, "hello", "world")`, then calls `split_string("abc", 0, 0)` and asserts it returns `(3, "", "")`.

**Call relations**: It directly exercises the internal helper `split_string` without going through the public truncation wrappers, documenting the core slicing contract.

*Call graph*: 1 external calls (assert_eq!).


##### `split_string_handles_empty_string`  (lines 23–28)

```
fn split_string_handles_empty_string()
```

**Purpose**: Verifies that splitting an empty string always returns zero removed characters and empty prefix/suffix slices. It covers the early-return branch for empty input.

**Data flow**: The test calls `split_string("", 4, 4)` and asserts the result is `(0, "", "")`.

**Call relations**: It targets the empty-input fast path in `split_string`.

*Call graph*: 1 external calls (assert_eq!).


##### `split_string_only_keeps_prefix_when_tail_budget_is_zero`  (lines 31–36)

```
fn split_string_only_keeps_prefix_when_tail_budget_is_zero()
```

**Purpose**: Checks that when no suffix bytes are allowed, `split_string` preserves only the prefix and counts the rest as removed. It validates one-sided truncation behavior.

**Data flow**: The test calls `split_string("abcdef", 3, 0)` and asserts the result is `(3, "abc", "")`.

**Call relations**: It exercises the branch of `split_string` where the tail budget contributes nothing to the output.

*Call graph*: 1 external calls (assert_eq!).


##### `split_string_only_keeps_suffix_when_prefix_budget_is_zero`  (lines 39–44)

```
fn split_string_only_keeps_suffix_when_prefix_budget_is_zero()
```

**Purpose**: Checks the mirror case where only the suffix is preserved. It validates one-sided truncation from the end.

**Data flow**: The test calls `split_string("abcdef", 0, 3)` and asserts the result is `(3, "", "def")`.

**Call relations**: It complements the zero-tail-budget test by exercising the zero-prefix-budget path in `split_string`.

*Call graph*: 1 external calls (assert_eq!).


##### `split_string_handles_overlapping_budgets_without_removal`  (lines 47–52)

```
fn split_string_handles_overlapping_budgets_without_removal()
```

**Purpose**: Verifies that overlapping prefix and suffix budgets do not duplicate or remove content unnecessarily. It confirms the overlap-clamping logic.

**Data flow**: The test calls `split_string("abcdef", 4, 4)` and asserts the result is `(0, "abcd", "ef")`.

**Call relations**: It targets the `suffix_start < prefix_end` correction in `split_string`, ensuring overlapping budgets preserve the full string exactly once.

*Call graph*: 1 external calls (assert_eq!).


##### `split_string_respects_utf8_boundaries`  (lines 55–85)

```
fn split_string_respects_utf8_boundaries()
```

**Purpose**: Validates that `split_string` never slices through multibyte UTF-8 characters and counts removed characters correctly in Unicode-heavy inputs. It covers several edge cases with emoji and tight byte budgets.

**Data flow**: The test runs four assertions on emoji-containing strings with different prefix and suffix byte budgets, checking the exact removed-character counts and preserved slices such as `(1, "😀a", "c😀")`, `(5, "", "")`, `(3, "😀", "😀")`, and `(1, "😀😀", "😀😀")`.

**Call relations**: It directly exercises the character-boundary iteration logic in `split_string`, especially where byte budgets fall inside multibyte code points.

*Call graph*: 1 external calls (assert_eq!).


##### `truncate_with_token_budget_returns_original_when_under_limit`  (lines 88–94)

```
fn truncate_with_token_budget_returns_original_when_under_limit()
```

**Purpose**: Checks that token-budget truncation is a no-op when the input is already within the approximate budget. It verifies that no original token count is reported in that case.

**Data flow**: The test calls `truncate_middle_with_token_budget("short output", 100)`, destructures the returned `(out, original)`, and asserts `out == s` and `original == None`.

**Call relations**: It exercises the early-fit branch in the public `truncate_middle_with_token_budget` API.

*Call graph*: 2 external calls (assert_eq!, truncate_middle_with_token_budget).


##### `truncate_with_token_budget_reports_truncation_at_zero_limit`  (lines 97–102)

```
fn truncate_with_token_budget_reports_truncation_at_zero_limit()
```

**Purpose**: Verifies the special zero-token-budget behavior where the output is only a truncation marker and the original approximate token count is returned. It documents the marker wording and count semantics.

**Data flow**: The test calls `truncate_middle_with_token_budget("abcdef", 0)` and asserts the output string is `"…2 tokens truncated…"` and the optional original count is `Some(2)`.

**Call relations**: It exercises the zero-budget path through `truncate_middle_with_token_budget` and the marker-generation logic in the underlying truncation implementation.

*Call graph*: 2 external calls (assert_eq!, truncate_middle_with_token_budget).


##### `truncate_middle_tokens_handles_utf8_content`  (lines 105–110)

```
fn truncate_middle_tokens_handles_utf8_content()
```

**Purpose**: Checks token-budget truncation on mixed UTF-8 and ASCII content, ensuring both ends are preserved and the marker reports approximate token removal. It validates the public API on realistic multibyte text.

**Data flow**: The test passes a string containing ten emoji plus a second line of ASCII text to `truncate_middle_with_token_budget(..., 8)` and asserts the returned output is `"😀😀😀😀…8 tokens truncated… line with text\n"` with `tokens == Some(16)`.

**Call relations**: It exercises the full token-budget truncation path, indirectly relying on `split_string`, removed-unit calculation, and marker formatting.

*Call graph*: 2 external calls (assert_eq!, truncate_middle_with_token_budget).


##### `truncate_middle_bytes_handles_utf8_content`  (lines 113–117)

```
fn truncate_middle_bytes_handles_utf8_content()
```

**Purpose**: Checks byte-budget truncation on mixed UTF-8 content, ensuring the marker reports removed characters and the preserved slices remain valid UTF-8. It validates the char-mode public API.

**Data flow**: The test calls `truncate_middle_chars` on the same emoji-plus-text string with `max_bytes = 20` and asserts the exact output `"😀😀…21 chars truncated…with text\n"`.

**Call relations**: It exercises the public `truncate_middle_chars` wrapper and, through it, the shared truncation engine in character-count mode.

*Call graph*: 2 external calls (assert_eq!, truncate_middle_chars).


### Image utility validation and benchmarks
These files validate prompt-image handling end to end and then benchmark the same workflows under synthetic fixture inputs.

### `utils/image/src/image_tests.rs`

`test` · `test run`

This file exercises the public image-processing API with concrete encoded images rather than mocks. Two local helpers generate test fixtures: `image_bytes` encodes an RGBA `ImageBuffer` into a chosen `ImageFormat`, while `image_bytes_with_metadata` writes PNG, JPEG, or WebP bytes with ICC and EXIF metadata attached. The tests cover the main behavioral branches in `load_for_prompt_bytes` and `load_data_url_for_prompt`: pass-through of already-supported images within bounds, downscaling of oversized wide and tall images, preservation of source format for PNG/WebP/JPEG, conversion of unsupported pass-through formats like GIF into PNG, and explicit `PromptImageResizeLimits` patch-budget math. Metadata tests are especially specific: RGB ICC profiles and EXIF orientation survive re-encoding, while a CMYK JPEG ICC profile is intentionally dropped to avoid mislabeling RGB-decoded output. Error-path tests verify malformed data URLs become `InvalidDataUrl` and random bytes fail as either `Decode` or `UnsupportedImageFormat`. Cache-focused tests validate both content-addressed invalidation—different byte digests for the same logical path produce fresh outputs—and byte-budget eviction semantics in `cache_image`, including the rule that oversized entries are never inserted. Together these tests document subtle invariants around metadata safety, case-insensitive data URL parsing, and cache sizing that are easy to miss from the implementation alone.

#### Function details

##### `image_bytes`  (lines 17–23)

```
fn image_bytes(image: &ImageBuffer<Rgba<u8>, Vec<u8>>, format: ImageFormat) -> Vec<u8>
```

**Purpose**: Encodes an RGBA image buffer into raw bytes for a requested image format to build test inputs.

**Data flow**: It takes an `ImageBuffer<Rgba<u8>, Vec<u8>>` and an `ImageFormat`, clones the image into `DynamicImage::ImageRgba8`, writes it into a `Cursor<Vec<u8>>`, and returns the inner encoded `Vec<u8>`. Failures panic via `expect`, since this is test fixture setup.

**Call relations**: Many tests call this helper to create canonical PNG, WebP, or GIF inputs before invoking the public loading functions. It delegates actual encoding to the `image` crate so tests operate on realistic bytes.

*Call graph*: calls 1 internal fn (new); called by 8 (data_url_processing_converts_gif_to_png, data_url_processing_preserves_supported_source_bytes, downscales_large_image, downscales_tall_image_to_fit_square_bounds, preserves_large_image_in_original_mode, reprocesses_updated_file_contents, resize_with_limits_respects_dimension_and_patch_budgets, returns_original_image_when_within_bounds); 3 external calls (ImageRgba8, clone, new).


##### `image_bytes_with_metadata`  (lines 25–81)

```
fn image_bytes_with_metadata(
    image: &ImageBuffer<Rgba<u8>, Vec<u8>>,
    format: ImageFormat,
    icc_profile: &[u8],
) -> Vec<u8>
```

**Purpose**: Builds encoded PNG, JPEG, or WebP test images that carry ICC and EXIF metadata, allowing metadata-preservation assertions after resizing.

**Data flow**: It accepts an RGBA image buffer, a target `ImageFormat`, and an ICC profile byte slice. It selects a format-specific encoder, injects the supplied ICC profile plus the fixed `ROTATE_90_EXIF` payload, writes the image pixels, and returns the resulting encoded `Vec<u8>`. Unsupported formats panic immediately.

**Call relations**: The metadata-focused tests use this helper to create source images with known metadata. It delegates to the corresponding encoder APIs because the production code later reads those same metadata fields back through decoders.

*Call graph*: called by 2 (resizing_drops_non_rgb_icc_profile, resizing_preserves_supported_metadata); 10 external calls (ImageRgba8, as_raw, clone, height, width, new_with_quality, new, new, new_lossless, panic!).


##### `returns_original_image_when_within_bounds`  (lines 84–104)

```
async fn returns_original_image_when_within_bounds()
```

**Purpose**: Verifies that supported images already within the default size limits are returned byte-for-byte unchanged in resize-to-fit mode.

**Data flow**: For PNG and WebP, it creates a 64×32 solid-color image, encodes it, passes the bytes to `load_for_prompt_bytes`, and asserts width, height, MIME type, and exact byte equality with the original encoded bytes.

**Call relations**: This test drives the no-resize, preserve-source-bytes branch of the loader. It relies on `image_bytes` for fixture generation and checks that the loader does not unnecessarily decode/re-encode supported inputs.

*Call graph*: calls 1 internal fn (image_bytes); 4 external calls (from_pixel, new, assert_eq!, Rgba).


##### `downscales_large_image`  (lines 107–134)

```
async fn downscales_large_image()
```

**Purpose**: Checks that oversized images are resized down to fit the global maximum dimension while preserving the original supported output format.

**Data flow**: It creates 4096×2048 PNG and WebP images, processes them in `ResizeToFit` mode, then asserts both dimensions are at most `MAX_DIMENSION`, the MIME matches the source format, the output bytes still identify as that format, and decoding the output yields the reported dimensions.

**Call relations**: This test exercises the resize branch in `load_for_prompt_bytes` where dimensions exceed the default bound. It uses `image::guess_format` and `image::load_from_memory` to validate the encoded result independently of the loader’s metadata.

*Call graph*: calls 1 internal fn (image_bytes); 7 external calls (from_pixel, new, assert!, assert_eq!, Rgba, guess_format, load_from_memory).


##### `downscales_tall_image_to_fit_square_bounds`  (lines 137–151)

```
async fn downscales_tall_image_to_fit_square_bounds()
```

**Purpose**: Confirms aspect-ratio-preserving resizing for a tall image constrained by a square maximum dimension.

**Data flow**: It encodes a 1024×4096 PNG, processes it in `ResizeToFit` mode, and asserts the output dimensions are exactly `(512, MAX_DIMENSION)` with MIME `image/png`.

**Call relations**: This test targets the geometry of the resize calculation for portrait images. It complements the wide-image case by checking the opposite aspect ratio branch.

*Call graph*: calls 1 internal fn (image_bytes); 4 external calls (from_pixel, new, assert_eq!, Rgba).


##### `resizing_preserves_supported_metadata`  (lines 154–186)

```
async fn resizing_preserves_supported_metadata()
```

**Purpose**: Ensures that resizing keeps EXIF orientation and RGB ICC profiles for formats whose encoders support those metadata fields.

**Data flow**: For PNG, JPEG, and WebP, it creates a 2050×2 image with known RGB ICC and EXIF metadata, processes it, asserts the resized dimensions are `(2048, 2)`, then decodes the output with a format-specific `ImageReader` and compares dimensions, orientation, ICC profile, and EXIF bytes against expected values.

**Call relations**: This test covers the production path where metadata is extracted before decode and re-applied during re-encoding. It depends on `image_bytes_with_metadata` to seed metadata and validates the behavior of `encode_image` plus `apply_image_metadata` indirectly.

*Call graph*: calls 2 internal fn (new, image_bytes_with_metadata); 5 external calls (from_pixel, with_format, new, assert_eq!, Rgba).


##### `resizing_drops_non_rgb_icc_profile`  (lines 189–211)

```
async fn resizing_drops_non_rgb_icc_profile()
```

**Purpose**: Verifies the safety rule that non-RGB ICC profiles are not copied onto resized output.

**Data flow**: It creates a JPEG with a CMYK-signature ICC profile and EXIF metadata, processes it, decodes the result, and asserts that ICC metadata is `None` while EXIF metadata is still present.

**Call relations**: This test exercises the metadata filter in `load_for_prompt_bytes` that only preserves profiles whose bytes 16..20 equal `b"RGB "`. It demonstrates that EXIF and ICC are handled independently.

*Call graph*: calls 2 internal fn (new, image_bytes_with_metadata); 5 external calls (from_pixel, with_format, new, assert_eq!, Rgba).


##### `preserves_large_image_in_original_mode`  (lines 214–229)

```
async fn preserves_large_image_in_original_mode()
```

**Purpose**: Checks that `PromptImageMode::Original` bypasses resizing even when the image exceeds the default maximum dimension.

**Data flow**: It creates a 4096×2048 PNG, processes it in `Original` mode, and asserts the original dimensions, MIME, and exact encoded bytes are preserved.

**Call relations**: This test drives the explicit no-resize branch in the loader. It contrasts with `downscales_large_image`, showing that size enforcement depends on mode.

*Call graph*: calls 1 internal fn (image_bytes); 4 external calls (from_pixel, new, assert_eq!, Rgba).


##### `data_url_processing_preserves_supported_source_bytes`  (lines 232–246)

```
async fn data_url_processing_preserves_supported_source_bytes()
```

**Purpose**: Confirms that data URL ingestion accepts case-insensitive `data:` and `base64` markers and preserves supported source bytes when no conversion is needed.

**Data flow**: It creates a small PNG, wraps it in a data URL, intentionally uppercases the scheme and `base64` token, processes it with `load_data_url_for_prompt`, and asserts dimensions, MIME, and exact byte equality with the original PNG bytes.

**Call relations**: This test exercises `load_data_url_for_prompt` parsing before it delegates into `load_for_prompt_bytes`. It specifically validates the case-insensitive prefix and metadata checks.

*Call graph*: calls 1 internal fn (image_bytes); 3 external calls (from_pixel, assert_eq!, Rgba).


##### `data_url_processing_converts_gif_to_png`  (lines 249–262)

```
async fn data_url_processing_converts_gif_to_png()
```

**Purpose**: Verifies that GIF data URLs are accepted as input but re-encoded to PNG because GIF bytes are not preserved verbatim by the loader.

**Data flow**: It creates a GIF data URL from a small RGBA image, processes it, and asserts the output MIME is `image/png` and the resulting bytes are detected as PNG.

**Call relations**: This test covers the branch where the guessed source format is supported for decoding but not for byte-preserving pass-through. The loader therefore falls back to `encode_image(..., ImageFormat::Png, ...)`.

*Call graph*: calls 1 internal fn (image_bytes); 3 external calls (from_pixel, assert_eq!, Rgba).


##### `data_url_processing_rejects_malformed_input`  (lines 265–277)

```
fn data_url_processing_rejects_malformed_input()
```

**Purpose**: Checks that malformed or unsupported data URL spellings fail with the dedicated `InvalidDataUrl` error variant.

**Data flow**: It iterates over several malformed strings—missing `data:` prefix, missing comma, non-base64 form, and invalid base64 payload—and asserts each call to `load_data_url_for_prompt` returns `Err(ImageProcessingError::InvalidDataUrl { .. })`.

**Call relations**: This test targets the parser and validation logic in `load_data_url_for_prompt` before any image decoding occurs. It ensures malformed transport syntax is not misreported as an image decode failure.

*Call graph*: 1 external calls (assert!).


##### `resize_with_limits_respects_dimension_and_patch_budgets`  (lines 280–296)

```
async fn resize_with_limits_respects_dimension_and_patch_budgets()
```

**Purpose**: Validates the explicit resize-limits mode that combines a maximum dimension with a patch-count budget.

**Data flow**: It creates a 2048×2048 PNG, defines `PromptImageResizeLimits { max_dimension: 2048, max_patches: 2_500 }`, processes the image in `ResizeWithLimits`, and asserts the output dimensions are `(1600, 1600)`.

**Call relations**: This test exercises `prompt_image_output_dimensions_for_limits` through the public loader. It demonstrates that an image can be shrunk even when already within `max_dimension` because the patch budget is tighter.

*Call graph*: calls 1 internal fn (image_bytes); 5 external calls (from_pixel, new, assert_eq!, Rgba, ResizeWithLimits).


##### `fails_cleanly_for_invalid_images`  (lines 299–310)

```
async fn fails_cleanly_for_invalid_images()
```

**Purpose**: Ensures arbitrary non-image bytes fail with a structured image-processing error rather than panicking or producing nonsense output.

**Data flow**: It passes the byte string `b"not an image"` to `load_for_prompt_bytes`, expects an error, and asserts the error is either `Decode` or `UnsupportedImageFormat`.

**Call relations**: This test covers the decode/format-detection failure path and the normalization performed by `ImageProcessingError::decode_error`. It allows either classification because the underlying image crate may fail at different stages.

*Call graph*: 2 external calls (new, assert!).


##### `reprocesses_updated_file_contents`  (lines 313–341)

```
async fn reprocesses_updated_file_contents()
```

**Purpose**: Checks that the cache key depends on image bytes, not just the logical path, so changed contents are reprocessed correctly.

**Data flow**: It clears the global `IMAGE_CACHE`, processes one PNG under the path `in-memory-image`, then processes different PNG bytes under the same path and asserts the second result has different dimensions and bytes from the first.

**Call relations**: This test drives the SHA-1 digest cache-key logic in `load_for_prompt_bytes`. It proves that cache hits require matching content bytes and mode, not merely a reused path string.

*Call graph*: calls 1 internal fn (image_bytes); 5 external calls (from_pixel, new, assert_eq!, assert_ne!, Rgba).


##### `bounds_cache_by_encoded_byte_size`  (lines 344–364)

```
async fn bounds_cache_by_encoded_byte_size()
```

**Purpose**: Verifies that cache insertion and eviction are governed by total encoded-byte capacity and that oversized entries are skipped entirely.

**Data flow**: It creates a small `ImageCache`, synthetic `ImageCacheKey` values, and `EncodedImage` values of chosen byte lengths. After inserting two 3-byte images and one 6-byte image with a 5-byte capacity, it asserts the oldest small entry was evicted, the newer small entry remains, and the oversized image was never cached.

**Call relations**: This test directly exercises `cache_image` rather than going through the loader. It documents the LRU eviction order and the early-return rule for entries larger than the byte budget.

*Call graph*: 3 external calls (new, new, assert!).


### `utils/image/benches/prompt_images.rs`

`test` · `benchmark run`

This benchmark file is a standalone executable that drives image-processing performance tests. It defines three fixed `ImageSize` constants representing small and large screenshots and a large photo, plus `CACHE_MISS_VARIANT_COUNT` to generate many byte-distinct variants of the same logical image. The benchmark entry `main` simply hands control to `divan::main()`.

The benchmark functions split into fresh-attachment and repeated-attachment scenarios. Fresh benchmarks call `cache_miss_variants(...)` so each iteration uses image bytes with a unique suffix, intentionally defeating content-digest caching in the loader. Repeated benchmarks warm the cache once and then repeatedly clone the same bytes. Both paths ultimately call `prepare_prompt_data_url`, which invokes `load_for_prompt_bytes(Path::new(path), image, PromptImageMode::ResizeToFit)` and converts the loaded image into a data URL.

Fixture generation is synthetic and deterministic. `screenshot_png` builds an `RgbaImage` with toolbar, sidebar, panel borders, and text-row patterns to resemble a UI screenshot, then encodes it as PNG. `photo_jpeg` builds an `RgbImage` from gradients plus pseudo-texture mixed by `blend_channel`, then encodes it as JPEG. `encode_fixture` writes a `DynamicImage` into a `Cursor<Vec<u8>>` and returns the encoded bytes. The design keeps benchmark inputs self-contained and reproducible without external image files.

#### Function details

##### `main`  (lines 35–37)

```
fn main()
```

**Purpose**: Starts the Divan benchmark harness for this benchmark binary. It has no benchmark logic of its own beyond handing off control.

**Data flow**: It takes no arguments, calls `divan::main()`, and returns unit. It does not manage local state beyond entering the harness.

**Call relations**: As the benchmark executable entrypoint, it is invoked when this bench target runs and allows Divan to discover and execute the annotated benchmark functions.

*Call graph*: 1 external calls (main).


##### `small_png_screenshot_fresh_attachment`  (lines 40–46)

```
fn small_png_screenshot_fresh_attachment(bencher: Bencher)
```

**Purpose**: Benchmarks loading a small synthetic PNG screenshot as a fresh attachment on each iteration. It uses cache-busting variants so the loader stays on its miss path.

**Data flow**: It takes a `Bencher`, generates a small screenshot PNG via `screenshot_png(SMALL_SCREENSHOT)`, expands it into many byte-distinct variants with `cache_miss_variants`, and passes the path label and variant list into `bench_fresh_attachment`.

**Call relations**: This is one of the Divan-discovered benchmark cases. It delegates all iteration setup and measurement wiring to `bench_fresh_attachment`.

*Call graph*: calls 3 internal fn (bench_fresh_attachment, cache_miss_variants, screenshot_png).


##### `large_png_screenshot_fresh_attachment`  (lines 49–55)

```
fn large_png_screenshot_fresh_attachment(bencher: Bencher)
```

**Purpose**: Benchmarks fresh-attachment processing for a large synthetic PNG screenshot. It stresses the same cache-miss path as the small screenshot benchmark but with a larger image.

**Data flow**: It receives a `Bencher`, creates a large screenshot fixture with `screenshot_png(LARGE_SCREENSHOT)`, wraps it in cache-miss variants, and forwards everything to `bench_fresh_attachment`.

**Call relations**: Like the small screenshot fresh benchmark, it is a top-level benchmark case that delegates execution mechanics to `bench_fresh_attachment`.

*Call graph*: calls 3 internal fn (bench_fresh_attachment, cache_miss_variants, screenshot_png).


##### `large_jpeg_photo_fresh_attachment`  (lines 58–64)

```
fn large_jpeg_photo_fresh_attachment(bencher: Bencher)
```

**Purpose**: Benchmarks fresh-attachment processing for a large synthetic JPEG photo. It exercises the cache-miss path with a photo-like image and JPEG encoding characteristics.

**Data flow**: It takes a `Bencher`, generates JPEG bytes from `photo_jpeg(LARGE_PHOTO)`, creates cache-busting variants with `cache_miss_variants`, and passes them to `bench_fresh_attachment` with a `.jpg` path label.

**Call relations**: This benchmark complements the PNG screenshot cases by feeding `bench_fresh_attachment` a different image structure and format.

*Call graph*: calls 3 internal fn (bench_fresh_attachment, cache_miss_variants, photo_jpeg).


##### `small_png_screenshot_repeated_attachment`  (lines 67–73)

```
fn small_png_screenshot_repeated_attachment(bencher: Bencher)
```

**Purpose**: Benchmarks repeated processing of the same small PNG screenshot attachment, allowing cache reuse. It contrasts with the fresh-attachment benchmarks that intentionally miss the cache.

**Data flow**: It takes a `Bencher`, generates one small screenshot PNG via `screenshot_png(SMALL_SCREENSHOT)`, and passes the path label and bytes to `bench_repeated_attachment`.

**Call relations**: This top-level benchmark delegates to `bench_repeated_attachment`, which warms the cache and measures repeated use of identical bytes.

*Call graph*: calls 2 internal fn (bench_repeated_attachment, screenshot_png).


##### `bench_fresh_attachment`  (lines 75–86)

```
fn bench_fresh_attachment(bencher: Bencher, path: &'static str, images: Vec<Vec<u8>>)
```

**Purpose**: Sets up a benchmark where each iteration receives a different image byte vector to avoid content-digest cache hits. It cycles through a precomputed list of variants outside the measured timing.

**Data flow**: It takes `bencher: Bencher`, `path: &'static str`, and `images: Vec<Vec<u8>>`. It initializes `image_index = 0`, then configures `bencher.with_inputs(...)` with a closure that clones `images[image_index]`, advances the index modulo `images.len()`, and yields the cloned bytes. The benchmark body then calls `prepare_prompt_data_url(path, image)` for each provided input.

**Call relations**: This helper is called by the three fresh-attachment benchmark functions. It encapsulates Divan-specific setup so those benchmarks only need to supply fixture bytes and labels.

*Call graph*: called by 3 (large_jpeg_photo_fresh_attachment, large_png_screenshot_fresh_attachment, small_png_screenshot_fresh_attachment); 1 external calls (with_inputs).


##### `bench_repeated_attachment`  (lines 88–95)

```
fn bench_repeated_attachment(bencher: Bencher, path: &'static str, image: Vec<u8>)
```

**Purpose**: Sets up a benchmark where the same image bytes are reused each iteration, after first warming the loader path once. This isolates repeated-attachment performance from per-iteration input construction.

**Data flow**: It takes `bencher: Bencher`, `path: &'static str`, and `image: Vec<u8>`. Before measurement it calls `prepare_prompt_data_url(path, image.clone())` once to warm the path. It then configures `with_inputs` to clone the same `image` each iteration and benchmarks `prepare_prompt_data_url(path, image)` on those clones.

**Call relations**: This helper is called by `small_png_screenshot_repeated_attachment`. It differs from `bench_fresh_attachment` by intentionally reusing identical bytes and priming the cache first.

*Call graph*: calls 1 internal fn (prepare_prompt_data_url); called by 1 (small_png_screenshot_repeated_attachment); 1 external calls (with_inputs).


##### `prepare_prompt_data_url`  (lines 97–102)

```
fn prepare_prompt_data_url(path: &str, image: Vec<u8>) -> String
```

**Purpose**: Runs the actual image-loading workload under test and converts the result into a data URL. It is the benchmarked operation used by both fresh and repeated attachment scenarios.

**Data flow**: It takes `path: &str` and `image: Vec<u8>`, constructs a `Path` from the string, calls `load_for_prompt_bytes` with `PromptImageMode::ResizeToFit`, expects successful loading, then calls `.into_data_url()` on the loaded image and returns the resulting `String`.

**Call relations**: This function is invoked from the benchmark closures configured by `bench_fresh_attachment` and `bench_repeated_attachment`. It is the core measured unit of work in this file.

*Call graph*: called by 1 (bench_repeated_attachment); 2 external calls (new, load_for_prompt_bytes).


##### `cache_miss_variants`  (lines 104–113)

```
fn cache_miss_variants(image: Vec<u8>) -> Vec<Vec<u8>>
```

**Purpose**: Generates many byte-distinct variants of one encoded image so the loader's content-based cache treats each as a miss. The visual payload stays the same except for an appended suffix.

**Data flow**: It takes `image: Vec<u8>`, iterates from `0` to `CACHE_MISS_VARIANT_COUNT`, clones the original bytes for each variant, appends the variant number's little-endian bytes with `extend_from_slice`, collects all modified byte vectors into a `Vec<Vec<u8>>`, and returns it.

**Call relations**: This helper is used by the fresh-attachment benchmark functions before they call `bench_fresh_attachment`, specifically to force the benchmark onto the cache-miss path.

*Call graph*: called by 3 (large_jpeg_photo_fresh_attachment, large_png_screenshot_fresh_attachment, small_png_screenshot_fresh_attachment).


##### `screenshot_png`  (lines 116–148)

```
fn screenshot_png(size: ImageSize) -> Vec<u8>
```

**Purpose**: Builds a synthetic RGBA screenshot-like image and encodes it as PNG for benchmark fixtures. The generated pattern imitates UI chrome, panels, and text rows.

**Data flow**: It takes `size: ImageSize`, creates an `RgbaImage` with `from_fn`, and for each `(x, y)` computes booleans for toolbar, sidebar, panel borders, and text rows. Based on those conditions it selects fixed `Rgba([r, g, b, 255])` colors, with panel interiors varying by a computed panel index. It wraps the image as `DynamicImage::ImageRgba8` and passes it to `encode_fixture(..., ImageFormat::Png)`, returning the encoded bytes.

**Call relations**: This fixture generator is called by the PNG benchmark entry functions. It delegates final encoding to `encode_fixture` after synthesizing the pixel data.

*Call graph*: calls 1 internal fn (encode_fixture); called by 3 (large_png_screenshot_fresh_attachment, small_png_screenshot_fresh_attachment, small_png_screenshot_repeated_attachment); 2 external calls (ImageRgba8, from_fn).


##### `photo_jpeg`  (lines 151–165)

```
fn photo_jpeg(size: ImageSize) -> Vec<u8>
```

**Purpose**: Builds a synthetic RGB photo-like image with gradients and pseudo-random texture, then encodes it as JPEG. It provides a more natural-image workload than the screenshot fixture.

**Data flow**: It takes `size: ImageSize`, creates an `RgbImage` with `from_fn`, computes `x_gradient`, `y_gradient`, and a deterministic `texture` value for each pixel, then forms three channels by calling `blend_channel` with different gradient combinations and divisors. It wraps the image as `DynamicImage::ImageRgb8`, encodes it via `encode_fixture(..., ImageFormat::Jpeg)`, and returns the resulting bytes.

**Call relations**: This fixture generator is used by `large_jpeg_photo_fresh_attachment`. It relies on `blend_channel` for per-channel mixing and `encode_fixture` for serialization.

*Call graph*: calls 1 internal fn (encode_fixture); called by 1 (large_jpeg_photo_fresh_attachment); 2 external calls (ImageRgb8, from_fn).


##### `blend_channel`  (lines 167–169)

```
fn blend_channel(gradient: u32, texture: u8, divisor: u32) -> u8
```

**Purpose**: Combines a gradient component with a texture component to produce one 8-bit color channel for the synthetic photo fixture. The divisor controls how strongly texture influences the result.

**Data flow**: It takes `gradient: u32`, `texture: u8`, and `divisor: u32`, converts `texture` to `u32`, divides it by `divisor`, adds that to `gradient`, applies modulo 256, casts the result to `u8`, and returns it.

**Call relations**: This helper is called only by `photo_jpeg` to keep the per-channel mixing formula concise and reusable across the three RGB channels.

*Call graph*: 1 external calls (from).


##### `encode_fixture`  (lines 171–178)

```
fn encode_fixture(image: DynamicImage, format: ImageFormat) -> Vec<u8>
```

**Purpose**: Encodes an in-memory `DynamicImage` into the requested image format and returns the raw bytes. It is shared by both synthetic fixture generators.

**Data flow**: It takes `image: DynamicImage` and `format: ImageFormat`, creates a `Cursor<Vec<u8>>`, writes the image into that cursor with `write_to`, expects success, then extracts and returns the inner `Vec<u8>` with `into_inner()`.

**Call relations**: This helper is called by `screenshot_png` and `photo_jpeg` after they generate pixel data, centralizing the image-encoding step.

*Call graph*: calls 1 internal fn (new); called by 2 (photo_jpeg, screenshot_png); 2 external calls (write_to, new).
