# App-server integration suites — thread, turn, review, and session-state lifecycle  `stage-23.1.4.4`

This stage is the app server’s big reality check for conversation life cycle behavior. It sits in the system’s main working path: starting conversations, running turns, pausing or steering them, saving their state, and cleaning them up later. Think of it as testing the whole “conversation engine” while it is running, not just its individual parts.

Several files focus on threads, which are the server’s saved conversation sessions. They test creating a thread, reading it back, listing it, showing only loaded in-memory threads, resuming old ones, forking new branches, archiving, unarchiving, deleting, rolling back, resetting memory, and updating names, settings, metadata, and memory mode. Other tests make sure summaries are found correctly and that a remote thread store can replace local disk storage.

The turn-oriented tests cover starting a turn, interrupting it, steering it mid-flight, injecting items into history, handling dynamic tools, output schemas, plan items, permissions requests, and requests for user input. Review, compaction, status updates, client metadata, safety-policy notifications, and external-agent imports round out the picture, proving that active sessions stay consistent and clients see the right updates.

## Files in this stage

### Thread discovery and startup
These tests establish how threads are created, summarized, listed, read, and resumed across rollout-backed, in-memory, and remote-store persistence modes.

### `app-server/tests/suite/conversation_summary.rs`

`test` · `request handling in integration tests`

This test file builds small, controlled conversation fixtures and then queries the app server through both the higher-level `TestAppServer` harness and the lower-level in-process client. The rollout-backed tests create fake rollout directories under a temporary `CODEX_HOME`, derive a `ThreadId` from the generated conversation id, and compare the returned `ConversationSummary` against a hand-built expected value that includes preview text, timestamps, provider, cwd `/`, CLI version `0.0.0`, and `SessionSource::Cli`. Because the server may return canonicalized filesystem paths, helper functions normalize paths through `canonicalize()` and `AbsolutePathBuf`, and skip normalization when the summary path is empty.

The in-memory-thread-store test takes a different route: it writes a `config.toml` enabling `experimental_thread_store = { type = "in_memory", id = ... }`, creates a thread directly in `InMemoryThreadStore`, then starts the server in-process with explicit `ConfigBuilder`, loader overrides, initialization params, and test environment manager. That test captures an important edge case: a thread with no persisted rollout path returns empty `path` and `cwd`, and the server reports a generic provider string (`"test"`) rather than the raw metadata value used when creating the thread. A tiny RAII helper removes the global in-memory store id on drop so tests do not leak shared state across runs.

#### Function details

##### `expected_summary`  (lines 48–61)

```
fn expected_summary(conversation_id: ThreadId, path: PathBuf) -> ConversationSummary
```

**Purpose**: Constructs the exact `ConversationSummary` value expected from rollout-backed summary lookups. It centralizes the fixed preview, timestamps, provider, cwd, version, and source fields used by multiple tests.

**Data flow**: Takes a `ThreadId` and a resolved rollout `PathBuf` → fills a `ConversationSummary` struct with those values plus constants like `PREVIEW`, `CREATED_AT_RFC3339`, `UPDATED_AT_RFC3339`, `MODEL_PROVIDER`, cwd `/`, CLI version `0.0.0`, `SessionSource::Cli`, and `git_info: None` → returns the populated summary without mutating external state.

**Call relations**: It is invoked by the two rollout-based tests after they create fake rollout fixtures, so those tests can compare server output against a concrete expected struct instead of repeating field assembly inline.

*Call graph*: called by 2 (get_conversation_summary_by_relative_rollout_path_resolves_from_codex_home, get_conversation_summary_by_thread_id_reads_rollout); 1 external calls (from).


##### `normalized_canonical_path`  (lines 63–65)

```
fn normalized_canonical_path(path: impl AsRef<Path>) -> Result<PathBuf>
```

**Purpose**: Canonicalizes a filesystem path and re-wraps it as an `AbsolutePathBuf` before converting back to `PathBuf`. This gives tests a normalized absolute path representation that matches server behavior.

**Data flow**: Accepts any `AsRef<Path>` input → calls `canonicalize()` on the referenced path, validates it as absolute with `AbsolutePathBuf::from_absolute_path`, then converts it back into a plain `PathBuf` → returns `Result<PathBuf>` and propagates filesystem or validation errors.

**Call relations**: The rollout tests use it when building expected paths, and `normalized_summary_path` delegates to it when normalizing a non-empty summary path before assertion.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 3 (get_conversation_summary_by_relative_rollout_path_resolves_from_codex_home, get_conversation_summary_by_thread_id_reads_rollout, normalized_summary_path); 1 external calls (as_ref).


##### `normalized_summary_path`  (lines 67–72)

```
fn normalized_summary_path(mut summary: ConversationSummary) -> Result<ConversationSummary>
```

**Purpose**: Normalizes only the `path` field inside a `ConversationSummary`, leaving pathless summaries untouched. This avoids failing tests on empty-path summaries from non-rollout threads.

**Data flow**: Takes ownership of a `ConversationSummary` → checks whether `summary.path` is empty; if not, replaces it with `normalized_canonical_path(summary.path)` → returns the adjusted summary in `Result<ConversationSummary>`.

**Call relations**: Used as the final comparison shim in the rollout-backed assertions so the tests compare canonical paths while preserving the pathless-store-thread case semantics.

*Call graph*: calls 1 internal fn (normalized_canonical_path).


##### `get_conversation_summary_by_thread_id_reads_rollout`  (lines 75–112)

```
async fn get_conversation_summary_by_thread_id_reads_rollout() -> Result<()>
```

**Purpose**: Verifies that `getConversationSummary` can locate and read a persisted rollout when addressed by `ThreadId`. It checks that the returned summary matches rollout metadata and canonical path resolution.

**Data flow**: Creates a temporary codex home, writes a fake rollout with fixed metadata, parses the generated conversation id into `ThreadId`, computes the expected canonical rollout path and expected summary, starts `TestAppServer`, initializes it, sends a `GetConversationSummaryParams::ThreadId` request, waits for the matching JSON-RPC response, deserializes it into `GetConversationSummaryResponse`, normalizes the returned path, and asserts equality with the expected summary.

**Call relations**: This is a top-level async test. It drives the full request/response flow through `TestAppServer`, relying on `expected_summary` and `normalized_canonical_path` to prepare the assertion target.

*Call graph*: calls 4 internal fn (new, expected_summary, normalized_canonical_path, from_string); 7 external calls (new, Integer, create_fake_rollout, rollout_path, to_response, assert_eq!, timeout).


##### `get_conversation_summary_by_thread_id_reads_pathless_store_thread`  (lines 115–196)

```
async fn get_conversation_summary_by_thread_id_reads_pathless_store_thread() -> Result<()>
```

**Purpose**: Checks the summary returned for a thread that exists only in the experimental in-memory thread store and has no rollout file on disk. It confirms the server succeeds and emits empty path/cwd fields rather than failing lookup.

**Data flow**: Creates a temp codex home, writes a config enabling an in-memory thread store id, obtains the corresponding `InMemoryThreadStore`, creates a thread with explicit `ThreadPersistenceMetadata`, builds a config with test loader overrides and fallback cwd, starts an in-process app server with explicit initialization parameters, sends a `ClientRequest::GetConversationSummary` for that thread id, deserializes the successful result into `GetConversationSummaryResponse`, and asserts `conversation_id`, empty `path`, empty `cwd`, and `model_provider == "test"`; finally shuts the client down.

**Call relations**: This test bypasses the subprocess-style harness and instead exercises the server through `in_process::start`, because it needs direct control over config and the shared in-memory store. It depends on `create_config_toml_with_in_memory_thread_store`, and the local `InMemoryThreadStoreId` guard cleans up the global store registration when the test scope ends.

*Call graph*: calls 9 internal fn (start, create_config_toml_with_in_memory_thread_store, default, without_managed_config_for_tests, default_for_tests, new, default, from_string, for_id); 10 external calls (new, default, new, new_v4, new, Integer, default, assert_eq!, default, from_value).


##### `get_conversation_summary_by_relative_rollout_path_resolves_from_codex_home`  (lines 199–232)

```
async fn get_conversation_summary_by_relative_rollout_path_resolves_from_codex_home() -> Result<()>
```

**Purpose**: Verifies that a rollout path supplied relative to `CODEX_HOME` is resolved correctly before summary extraction. It ensures the server treats relative rollout references as codex-home-relative, not process-cwd-relative.

**Data flow**: Creates a fake rollout under a temp codex home, derives its `ThreadId`, computes the rollout's relative path by stripping the codex-home prefix, builds the expected summary using the canonical absolute rollout path, starts and initializes `TestAppServer`, sends a `GetConversationSummaryParams::RolloutPath` request with the relative path, reads and deserializes the response, normalizes the returned summary path, and asserts equality with the expected summary.

**Call relations**: This is the sibling of the thread-id rollout test, differing only in request shape. It uses `expected_summary` and `normalized_canonical_path` to prove that relative-path lookup converges on the same summary as direct thread-id lookup.

*Call graph*: calls 4 internal fn (new, expected_summary, normalized_canonical_path, from_string); 7 external calls (new, Integer, create_fake_rollout, rollout_path, to_response, assert_eq!, timeout).


##### `InMemoryThreadStoreId::drop`  (lines 239–241)

```
fn drop(&mut self)
```

**Purpose**: Removes the named in-memory thread store from the global registry when the guard goes out of scope. It prevents cross-test contamination from reused store ids.

**Data flow**: Reads `self.store_id` from the guard struct → calls `InMemoryThreadStore::remove_id(&self.store_id)` → returns unit and mutates the global in-memory store registry by deleting that entry.

**Call relations**: It is triggered automatically by Rust drop semantics in the pathless-store-thread test, where the guard is intentionally bound to a local variable solely to guarantee cleanup after the test completes.

*Call graph*: calls 1 internal fn (remove_id).


##### `create_config_toml_with_in_memory_thread_store`  (lines 244–268)

```
fn create_config_toml_with_in_memory_thread_store(
    codex_home: &Path,
    store_id: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes a minimal `config.toml` that enables the experimental in-memory thread store with a specific store id. The config also defines a mock provider section sufficient for server startup.

**Data flow**: Takes the codex-home directory path and a `store_id` string → formats TOML containing model settings, `experimental_thread_store = { type = "in_memory", id = ... }`, `model_provider = "mock_provider"`, and a `[model_providers.mock_provider]` block → writes the contents to `<codex_home>/config.toml` and returns `std::io::Result<()>`.

**Call relations**: Called only by the in-memory-thread-store test before config loading, so the server and direct store access both point at the same named in-memory backend.

*Call graph*: called by 1 (get_conversation_summary_by_thread_id_reads_pathless_store_thread); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/remote_thread_store.rs`

`test` · `request handling`

This module uses the thread-store crate’s test-only `InMemoryThreadStore` to exercise the non-local persistence path selected by `experimental_thread_store` in config. Instead of driving the external JSON-RPC transport, it starts the app server in-process via `codex_app_server::in_process::start`, giving tests direct access to `InProcessClientHandle` requests and server events. The first test creates a thread, runs a simple turn against a repeating mock assistant server, waits for `TurnCompleted`, lists threads, deletes both a loaded and an unloaded thread, then inspects the in-memory store’s call counters to ensure create/list/delete/append/flush operations all went through the injected store. It finally asserts that `codex_home` contains no local session directories, sqlite files, or unexpected artifacts beyond config, installation id, and skills.

The second test covers cold resume behavior across process restarts. It starts one in-process client, creates and materializes a thread with a turn, shuts down, starts a second client with the same config and loader overrides, and issues `thread/resume`. Even though the in-memory store is pathless and resume may fail later while assembling the response, the important invariant is that `read_thread_with_history` on the injected store increments exactly once, proving the non-local history-bearing probe is reused. Helpers build config, start in-process clients with consistent initialization parameters, send typed thread-delete requests, enumerate codex-home entries, and remove the named in-memory store id on drop.

#### Function details

##### `thread_delete_with_non_local_thread_store_does_not_create_local_persistence`  (lines 64–191)

```
async fn thread_delete_with_non_local_thread_store_does_not_create_local_persistence() -> Result<()>
```

**Purpose**: Verifies thread creation, turn execution, listing, and deletion all use the configured non-local thread store and leave no local persistence artifacts behind.

**Data flow**: Starts a repeating mock assistant server, creates temp codex home and unique in-memory store id, writes config enabling `experimental_thread_store`, obtains the named `InMemoryThreadStore`, and starts an in-process app server client. It sends `ThreadStart`, asserts the returned thread has `path = None`, sends `TurnStart` with one text input, loops on `next_event()` until `TurnCompleted` for that thread, sends `ThreadList` and asserts the thread is present with no path, deletes the loaded thread, manually creates a second unloaded thread directly in the store, deletes that thread through the app server, shuts down the client, inspects store call counters, and finally calls `assert_no_local_persistence_artifacts` on codex home.

**Call relations**: This is the main regression test in the file. It composes nearly every helper here to prove the configured non-local store is used for both active and unloaded thread deletion paths.

*Call graph*: calls 7 internal fn (assert_no_local_persistence_artifacts, create_config_toml_with_thread_store, delete_thread, start_in_process_server, default, from_string, for_id); 13 external calls (default, new, new_v4, new, bail!, Integer, default, create_mock_responses_server_repeating_assistant, assert!, assert_eq! (+3 more)).


##### `cold_thread_resume_reuses_non_local_history_probe`  (lines 194–275)

```
async fn cold_thread_resume_reuses_non_local_history_probe() -> Result<()>
```

**Purpose**: Checks that after restarting the in-process app server, `thread/resume` probes the configured non-local store with history rather than falling back to local persistence.

**Data flow**: Starts a repeating mock assistant server, creates temp codex home and unique store id, writes thread-store config, builds a shared `Config` with loader overrides, obtains the named `InMemoryThreadStore`, and starts an in-process client. It creates a thread, starts a turn to materialize history, waits for `TurnCompleted`, shuts down the client, starts a second client with the same config, records `read_thread_with_history` call count, sends `ThreadResume`, ignores the eventual result, then asserts the store’s `read_thread_with_history` count increased by exactly one before shutting down the second client.

**Call relations**: This test is a narrower restart/resume regression case. It uses `start_in_process_client` directly so both client instances share the same config and injected store identity.

*Call graph*: calls 4 internal fn (create_config_toml_with_thread_store, start_in_process_client, without_managed_config_for_tests, for_id); 13 external calls (new, default, new, new_v4, bail!, Integer, default, create_mock_responses_server_repeating_assistant, assert_eq!, default (+3 more)).


##### `start_in_process_server`  (lines 277–289)

```
async fn start_in_process_server(codex_home: &Path) -> Result<InProcessClientHandle>
```

**Purpose**: Builds config from a codex-home path and starts an in-process app-server client handle with managed config disabled for tests.

**Data flow**: Creates `LoaderOverrides::without_managed_config_for_tests()`, builds a `Config` with `codex_home`, `fallback_cwd`, and those loader overrides via `ConfigBuilder`, wraps it in `Arc`, then calls `start_in_process_client` and returns the resulting `InProcessClientHandle`.

**Call relations**: The main non-local persistence test uses this helper for one-shot startup from just a codex-home path.

*Call graph*: calls 2 internal fn (start_in_process_client, without_managed_config_for_tests); called by 1 (thread_delete_with_non_local_thread_store_does_not_create_local_persistence); 3 external calls (new, to_path_buf, default).


##### `start_in_process_client`  (lines 291–321)

```
async fn start_in_process_client(
    config: Arc<Config>,
    loader_overrides: LoaderOverrides,
) -> std::io::Result<InProcessClientHandle>
```

**Purpose**: Starts the app server in-process with a supplied config and loader overrides, returning a client handle for direct request/event interaction.

**Data flow**: Calls `in_process::start` with `InProcessStartArgs` populated from the provided `Arc<Config>` and `LoaderOverrides`, default arg0 paths, empty CLI overrides, default cloud/thread config loaders, `CodexFeedback`, no log/state DB, a test `EnvironmentManager`, `SessionSource::Cli`, `enable_codex_api_key_env = false`, a fixed `InitializeParams` client identity, and the default in-process channel capacity.

**Call relations**: Both tests ultimately use this helper, either directly or through `start_in_process_server`, to avoid external transport and exercise app-server logic in-process.

*Call graph*: calls 4 internal fn (start, default, default_for_tests, new); called by 2 (cold_thread_resume_reuses_non_local_history_probe, start_in_process_server); 3 external calls (new, new, default).


##### `delete_thread`  (lines 323–337)

```
async fn delete_thread(
    client: &InProcessClientHandle,
    request_id: i64,
    thread_id: String,
) -> Result<()>
```

**Purpose**: Sends a `thread/delete` request through the in-process client and asserts the response parses as `ThreadDeleteResponse`.

**Data flow**: Builds `ClientRequest::ThreadDelete` with the supplied numeric request id and thread id string, sends it through `client.request`, converts any returned JSON-RPC error into an `anyhow` message, deserializes the success payload into `ThreadDeleteResponse`, and returns success.

**Call relations**: The main persistence test uses this helper for both a loaded thread and an unloaded thread created directly in the store.

*Call graph*: calls 1 internal fn (request); called by 1 (thread_delete_with_non_local_thread_store_does_not_create_local_persistence); 2 external calls (Integer, from_value).


##### `assert_no_local_persistence_artifacts`  (lines 339–391)

```
fn assert_no_local_persistence_artifacts(codex_home: &Path) -> Result<()>
```

**Purpose**: Asserts that a codex-home directory contains no observable local thread-persistence artifacts.

**Data flow**: Checks that `sessions`, `archived_sessions`, and `codex_state::state_db_path(codex_home)` do not exist; scans the top-level directory for any `.sqlite`, `.sqlite-shm`, or `.sqlite-wal` files and asserts none are present; collects top-level entries with `codex_home_entries`, removes `shell_snapshots` if present, and asserts the remaining set is exactly `{ config.toml, installation_id, skills }`.

**Call relations**: The main regression test calls this helper at the end to ensure no local rollout/session/sqlite state leaked in despite using a non-local thread store.

*Call graph*: calls 1 internal fn (codex_home_entries); called by 1 (thread_delete_with_non_local_thread_store_does_not_create_local_persistence); 3 external calls (assert!, assert_eq!, read_dir).


##### `codex_home_entries`  (lines 393–400)

```
fn codex_home_entries(codex_home: &Path) -> Result<BTreeSet<String>>
```

**Purpose**: Returns the set of top-level entry names present in a codex-home directory.

**Data flow**: Reads the directory, filters out unreadable entries, converts each file name to a lossy owned string, collects them into a `BTreeSet<String>`, and returns it.

**Call relations**: Used only by `assert_no_local_persistence_artifacts` to compare the final codex-home contents against the expected minimal set.

*Call graph*: called by 1 (assert_no_local_persistence_artifacts); 1 external calls (read_dir).


##### `InMemoryThreadStoreId::drop`  (lines 407–409)

```
fn drop(&mut self)
```

**Purpose**: Removes the named in-memory thread store instance from the global test registry when the guard is dropped.

**Data flow**: Calls `InMemoryThreadStore::remove_id(&self.store_id)` in `Drop`.

**Call relations**: Both tests create this guard so the globally keyed in-memory store is cleaned up automatically after the test finishes.

*Call graph*: calls 1 internal fn (remove_id).


##### `create_config_toml_with_thread_store`  (lines 412–440)

```
fn create_config_toml_with_thread_store(
    codex_home: &Path,
    server_uri: &str,
    store_id: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes the test config that selects the named in-memory thread store and a mock Responses provider.

**Data flow**: Formats and writes `config.toml` containing model/sandbox settings, `experimental_thread_store = { type = "in_memory", id = "..." }`, mock provider configuration pointing at `<server_uri>/v1`, and `[features] plugins = false`.

**Call relations**: Both regression tests call this helper before startup so the app server routes thread persistence through the injected non-local store.

*Call graph*: called by 2 (cold_thread_resume_reuses_non_local_history_probe, thread_delete_with_non_local_thread_store_does_not_create_local_persistence); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/thread_start.rs`

`test` · `startup and thread creation`

This file is the comprehensive test suite for `thread/start`. It uses `TestAppServer` with temporary Codex homes and mock Responses API servers to validate both the typed `ThreadStartResponse` and the raw JSON-RPC wire shape. The opening test establishes the baseline contract for a new persistent thread: non-empty `id` and `session_id`, empty preview, `ThreadStatus::Idle`, nullable `name`, caller-supplied `thread_source`, and a rollout `path` that is absolute but does not yet exist because persistence is deferred until the first user message. It also verifies notification ordering by rejecting any preceding `thread/status/changed` for the newly created thread before `thread/started` arrives.

Subsequent tests probe specific start-time inputs. Runtime workspace roots must be absolute and are returned normalized; profile-configured workspace roots are excluded from runtime roots; unknown environment ids and relative environment `cwd`s are rejected as invalid requests with code `-32600`; and instruction-source discovery includes global and project `AGENTS.md` files but excludes empty project files or project instructions when no environment is selected. Analytics tests confirm `thread_initialized` emission for new threads. Configuration inheritance tests show that trusted project config under `.codex/config.toml` is loaded from `cwd`, including `ReasoningEffort`, and that elevated sandbox starts can persist project trust at the repo root while read-only starts do not.

The file also covers service-tier semantics, metrics `service_name`, ephemeral pathless threads, required and optional MCP startup failures, and structured cloud-config bundle errors when ChatGPT auth refresh fails. Helper functions at the bottom generate several config variants, including optional/required broken MCP transports and profile workspace-root permissions. A small platform-specific `normalize_path_for_comparison` helper strips Windows `\\?\` prefixes so instruction-source assertions remain stable across OSes.

#### Function details

##### `thread_start_creates_thread_and_emits_started`  (lines 58–200)

```
async fn thread_start_creates_thread_and_emits_started() -> Result<()>
```

**Purpose**: Defines the baseline contract for creating a new persistent thread and receiving its corresponding `thread/started` notification.

**Data flow**: It writes config without an explicit approval policy, initializes the server, sends `thread/start` with model `gpt-5.2` and `thread_source: User`, parses the response, and asserts concrete thread fields: non-empty ids, empty preview, provider `mock_provider`, positive `created_at`, `ephemeral: false`, idle status, caller-supplied thread source, and an absolute rollout path that does not yet exist. It also inspects the raw JSON result to verify `name: null`, nested `sessionId`, and serialized `ephemeral`/`threadSource`, then loops over incoming messages until it finds `thread/started`, explicitly failing if a `thread/status/changed` for the same thread appears first.

**Call relations**: This is the foundational thread-start test. It uses the local config helper and then validates both response and notification behavior, establishing invariants referenced implicitly by many later tests.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 10 external calls (default, new, bail!, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, from_value, now, timeout).


##### `thread_start_accepts_absolute_runtime_workspace_roots`  (lines 203–239)

```
async fn thread_start_accepts_absolute_runtime_workspace_roots() -> Result<()>
```

**Purpose**: Checks that absolute runtime workspace roots supplied at thread creation are accepted and echoed back normalized.

**Data flow**: It creates a cwd and extra root directory, starts a thread with both `cwd` and `runtime_workspace_roots`, parses the response, and asserts the returned cwd and runtime roots equal the absolute paths of those directories.

**Call relations**: This test isolates the positive path for runtime workspace roots at thread creation, complementing later resume-time workspace-root tests in another file.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 8 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, create_dir_all, timeout, vec!).


##### `thread_start_excludes_profile_workspace_roots_from_runtime_workspace_roots`  (lines 242–280)

```
async fn thread_start_excludes_profile_workspace_roots_from_runtime_workspace_roots() -> Result<()>
```

**Purpose**: Verifies that workspace roots implied by the selected permissions profile are not redundantly included in the thread’s runtime workspace roots.

**Data flow**: It writes config containing a profile workspace root, starts a thread with a separate cwd, parses the response, and asserts `runtime_workspace_roots` contains only the cwd absolute path.

**Call relations**: This test uses `create_config_toml_with_profile_workspace_root` to seed profile-derived roots and then proves `thread/start` reports only runtime-added roots.

*Call graph*: calls 2 internal fn (new, create_config_toml_with_profile_workspace_root); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_start_rejects_unknown_environment_as_invalid_request`  (lines 283–316)

```
async fn thread_start_rejects_unknown_environment_as_invalid_request() -> Result<()>
```

**Purpose**: Checks validation that `thread/start` rejects references to nonexistent turn environment ids with JSON-RPC invalid-request semantics.

**Data flow**: It sends `thread/start` with `environments` containing `environment_id: "missing"` and an absolute cwd, reads the JSON-RPC error, and asserts the request id, error code `-32600`, and exact message `unknown turn environment id `missing``.

**Call relations**: This negative test targets request validation before thread creation proceeds, using the standard config helper and direct error-path assertions.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 7 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout, vec!).


##### `thread_start_rejects_relative_environment_cwd_as_invalid_request`  (lines 319–350)

```
async fn thread_start_rejects_relative_environment_cwd_as_invalid_request() -> Result<()>
```

**Purpose**: Verifies that environment-specific cwd values must be absolute paths and that relative values are rejected as invalid requests.

**Data flow**: It sends `thread/start` with one environment whose `cwd` is deserialized from the JSON string `"relative"`, reads the JSON-RPC error, and asserts the request id, invalid-request code, and the detailed message explaining that the path does not use absolute POSIX or Windows syntax.

**Call relations**: This complements the unknown-environment test by covering path-shape validation for otherwise known environment ids.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 7 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout, vec!).


##### `thread_start_response_includes_loaded_instruction_sources`  (lines 353–397)

```
async fn thread_start_response_includes_loaded_instruction_sources() -> Result<()>
```

**Purpose**: Checks that thread creation reports all non-empty instruction sources loaded from both global and project `AGENTS.md` files.

**Data flow**: It writes a global `AGENTS.md` under Codex home and a project `AGENTS.md` under a workspace, starts a thread with that workspace as cwd, parses `instruction_sources`, normalizes the returned paths for comparison, and asserts they equal the canonicalized global path plus the project path.

**Call relations**: This test uses `normalize_path_for_comparison` to make path assertions portable and establishes the positive instruction-source discovery behavior.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 8 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, write, timeout, vec!).


##### `thread_start_response_excludes_empty_project_instruction_source`  (lines 400–440)

```
async fn thread_start_response_excludes_empty_project_instruction_source() -> Result<()>
```

**Purpose**: Verifies that an empty project `AGENTS.md` file is ignored and not reported as an instruction source.

**Data flow**: It writes a non-empty global `AGENTS.md` and an empty project `AGENTS.md`, starts a thread with the workspace as cwd, parses and normalizes `instruction_sources`, and asserts only the global path is returned.

**Call relations**: This is the empty-file counterpart to the previous instruction-source test, proving the server filters out empty project instruction files.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 8 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, write, timeout, vec!).


##### `thread_start_without_selected_environment_includes_only_global_instruction_source`  (lines 443–521)

```
async fn thread_start_without_selected_environment_includes_only_global_instruction_source() -> Result<()>
```

**Purpose**: Checks that when no environment is selected, project instructions are excluded from both the reported instruction sources and the actual model-visible prompt.

**Data flow**: It writes global and project `AGENTS.md` files, starts a thread with `cwd` set but `environments: Some(Vec::new())`, and asserts the response includes only the global instruction source. It then starts a turn, waits for completion, fetches recorded `/responses` requests from the mock server, and asserts the serialized model request body contains `global instructions` but not `project instructions`.

**Call relations**: This test extends instruction-source validation beyond the response shape into actual prompt construction for subsequent turns.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 10 external calls (default, new, new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, write, timeout, vec!).


##### `normalize_path_for_comparison`  (lines 531–533)

```
fn normalize_path_for_comparison(path: impl AsRef<Path>) -> PathBuf
```

**Purpose**: Normalizes paths for cross-platform equality checks, stripping the Windows extended-length prefix when necessary.

**Data flow**: On Windows it converts the path to a display string, removes a leading `\\?\` if present, and returns a `PathBuf`; on non-Windows it simply clones the path into a `PathBuf`.

**Call relations**: Used by the instruction-source tests so path comparisons remain stable despite platform-specific absolute-path formatting.

*Call graph*: 4 external calls (as_ref, display, strip_prefix, from).


##### `thread_start_tracks_thread_initialized_analytics`  (lines 536–571)

```
async fn thread_start_tracks_thread_initialized_analytics() -> Result<()>
```

**Purpose**: Verifies that creating a new thread emits the analytics event used for thread initialization with lifecycle mode `new`.

**Data flow**: It writes config with a ChatGPT base URL, mounts analytics capture, initializes the server without managed config, sends `thread/start` with `thread_source: User`, parses the response, waits for the analytics payload, asserts exactly one event was sent, extracts the thread-initialized event, and validates thread id, session id, model `mock-model`, lifecycle `new`, and source `user`.

**Call relations**: This test parallels the resume analytics test in the other file, proving the start path emits the same event family with start-specific values.

*Call graph*: calls 6 internal fn (new_without_managed_config, assert_basic_thread_initialized_event, mount_analytics_capture, thread_initialized_event, wait_for_analytics_payload, create_config_toml_with_chatgpt_base_url); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_start_respects_project_config_from_cwd`  (lines 574–612)

```
async fn thread_start_respects_project_config_from_cwd() -> Result<()>
```

**Purpose**: Checks that trusted project configuration under the selected cwd is loaded into the new thread’s effective settings.

**Data flow**: It writes a project `.codex/config.toml` containing `model_reasoning_effort = "high"`, marks the workspace trusted via `set_project_trust_level`, starts a thread with that cwd, parses the response, and asserts `reasoning_effort` is `Some(ReasoningEffort::High)`.

**Call relations**: This test depends on prior trust configuration and proves `thread/start` consults project config from cwd when trust allows it.

*Call graph*: calls 3 internal fn (new, create_config_toml_without_approval_policy, set_project_trust_level); 8 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, create_dir_all, write, timeout).


##### `thread_start_drops_unsupported_service_tier_id`  (lines 615–642)

```
async fn thread_start_drops_unsupported_service_tier_id() -> Result<()>
```

**Purpose**: Verifies that an unsupported service-tier id is silently dropped rather than echoed back in the thread-start response.

**Data flow**: It sends `thread/start` with `service_tier: Some(Some("experimental-tier-id"))`, parses the response, and asserts `service_tier` is `None`.

**Call relations**: This test covers service-tier normalization at session-config time, contrasting with the next test where the special default tier id is accepted.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_start_accepts_default_service_tier`  (lines 645–673)

```
async fn thread_start_accepts_default_service_tier() -> Result<()>
```

**Purpose**: Checks that the special default service-tier request value is accepted and echoed back by thread creation.

**Data flow**: It sends `thread/start` with `service_tier` set to `SERVICE_TIER_DEFAULT_REQUEST_VALUE`, parses the response, and asserts the same string is returned.

**Call relations**: This complements the unsupported-tier test by proving the server recognizes the default sentinel value as valid.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_start_accepts_metrics_service_name`  (lines 676–701)

```
async fn thread_start_accepts_metrics_service_name() -> Result<()>
```

**Purpose**: Verifies that callers may supply a metrics `service_name` during thread creation without preventing thread startup.

**Data flow**: It sends `thread/start` with `service_name: Some("my_app_server_client")`, parses the response, and asserts the returned thread id is non-empty.

**Call relations**: This is a lightweight acceptance test for an optional metrics-related field on `ThreadStartParams`.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, timeout).


##### `thread_start_ephemeral_remains_pathless`  (lines 704–746)

```
async fn thread_start_ephemeral_remains_pathless() -> Result<()>
```

**Purpose**: Checks that ephemeral threads are explicitly marked ephemeral and never expose a rollout path.

**Data flow**: It sends `thread/start` with `ephemeral: Some(true)`, parses both the typed response and raw JSON result, and asserts `thread.ephemeral` is true, `thread.path` is `None`, and the serialized thread object contains `ephemeral: true`.

**Call relations**: This test defines the pathless-thread contract that later goal and resume tests rely on when rejecting unsupported operations on ephemeral threads.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 7 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout).


##### `thread_start_fails_when_required_mcp_server_fails_to_initialize`  (lines 749–782)

```
async fn thread_start_fails_when_required_mcp_server_fails_to_initialize() -> Result<()>
```

**Purpose**: Verifies that thread creation fails if a required MCP server cannot be started.

**Data flow**: It writes config containing a required broken MCP server, initializes the app server, sends `thread/start`, reads the JSON-RPC error, and asserts the message mentions required MCP initialization failure and the server name `required_broken`.

**Call relations**: This is the start-path counterpart to the resume MCP failure test, using `create_config_toml_with_required_broken_mcp` to force the failure.

*Call graph*: calls 2 internal fn (new, create_config_toml_with_required_broken_mcp); 6 external calls (new, Integer, default, create_mock_responses_server_repeating_assistant, assert!, timeout).


##### `thread_start_emits_mcp_server_status_updated_notifications`  (lines 785–881)

```
async fn thread_start_emits_mcp_server_status_updated_notifications() -> Result<()>
```

**Purpose**: Checks that optional MCP server startup emits status notifications for both `starting` and `failed` states, tied to the new thread id.

**Data flow**: It writes config with an optional broken MCP server, starts a thread, parses the `ThreadStartResponse`, then waits for two matching `mcpServer/startupStatus/updated` notifications: first with status `starting`, then with status `failed`. Each is converted to `ServerNotification::McpServerStatusUpdated` and asserted to contain the thread id, server name `optional_broken`, the expected startup state, and an error message on failure.

**Call relations**: This test exercises asynchronous MCP startup reporting after thread creation, rather than the hard-failure path used for required MCP servers.

*Call graph*: calls 2 internal fn (new, create_config_toml_with_optional_broken_mcp); 9 external calls (new, bail!, Integer, default, create_mock_responses_server_repeating_assistant, to_response, assert!, assert_eq!, timeout).


##### `thread_start_surfaces_cloud_config_bundle_load_errors`  (lines 884–963)

```
async fn thread_start_surfaces_cloud_config_bundle_load_errors() -> Result<()>
```

**Purpose**: Verifies that thread creation surfaces structured cloud-config/auth failures when ChatGPT bundle loading fails and refresh-token renewal is revoked.

**Data flow**: It mounts wiremock handlers returning 401 for the config bundle and token refresh endpoints, writes config with `chatgpt_base_url`, writes ChatGPT auth credentials containing a stale refresh token, initializes the app server with `OPENAI_API_KEY` unset and a refresh-token URL override, sends `thread/start`, and asserts the JSON-RPC error contains a generic configuration-load message plus structured `error.data` describing reason `cloudConfigBundle`, auth error code, relogin action, status code 401, and a detailed message.

**Call relations**: This test is the start-path analogue of the resume cloud-config failure test and proves the same structured error contract is exposed during thread creation.

*Call graph*: calls 3 internal fn (new, new_with_env, create_config_toml_with_chatgpt_base_url); 15 external calls (given, start, new, new, Integer, default, create_mock_responses_server_repeating_assistant, write_chatgpt_auth, assert!, assert_eq! (+5 more)).


##### `thread_start_with_elevated_sandbox_trusts_project_and_followup_loads_project_config`  (lines 966–1029)

```
async fn thread_start_with_elevated_sandbox_trusts_project_and_followup_loads_project_config() -> Result<()>
```

**Purpose**: Checks that starting a thread with an elevated sandbox persists project trust, and that a later start from the same cwd then loads trusted project config.

**Data flow**: It writes a project config with `model_reasoning_effort = "high"`, starts one thread with `sandbox: WorkspaceWrite` for that cwd, then starts a second thread from the same cwd without explicit sandbox override. It parses the second response and asserts approval policy `OnRequest` and reasoning effort `High`. It then reads the home `config.toml`, resolves the trusted root via `resolve_root_git_project_for_trust`, computes the trust key, and asserts the config now contains that key and `trust_level = "trusted"`.

**Call relations**: This test ties together thread creation, trust persistence, and subsequent config loading, proving that elevated sandbox starts can bootstrap trusted project configuration.

*Call graph*: calls 3 internal fn (new, create_config_toml_without_approval_policy, project_trust_key); 11 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, resolve_root_git_project_for_trust, create_dir_all, read_to_string, write (+1 more)).


##### `thread_start_with_nested_git_cwd_trusts_repo_root`  (lines 1032–1070)

```
async fn thread_start_with_nested_git_cwd_trusts_repo_root() -> Result<()>
```

**Purpose**: Verifies that when a thread is started from a nested path inside a git repository with elevated sandbox, trust is persisted at the repository root rather than the nested subdirectory.

**Data flow**: It creates a fake repo root containing `.git`, a nested project directory, starts a thread from the nested cwd with `sandbox: WorkspaceWrite`, then reads the home config and computes both the resolved trusted root key and the nested-path key. It asserts the config contains the repo-root trust key and does not contain the nested-path key.

**Call relations**: This test refines the trust-persistence behavior from the previous test by checking root resolution for nested git worktrees.

*Call graph*: calls 3 internal fn (new, create_config_toml_without_approval_policy, project_trust_key); 10 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, resolve_root_git_project_for_trust, create_dir, create_dir_all, read_to_string, timeout).


##### `thread_start_with_read_only_sandbox_does_not_persist_project_trust`  (lines 1073–1101)

```
async fn thread_start_with_read_only_sandbox_does_not_persist_project_trust() -> Result<()>
```

**Purpose**: Checks that ordinary read-only thread creation does not write any project trust entry to the user config.

**Data flow**: It starts a thread from a workspace using the default read-only sandbox, then reads `config.toml` and asserts it contains neither `trust_level = "trusted"` nor the workspace path.

**Call relations**: This is the negative counterpart to the elevated-sandbox trust tests, proving trust persistence is conditional on elevated sandbox selection.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 7 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, read_to_string, timeout).


##### `thread_start_preserves_untrusted_project_trust`  (lines 1104–1139)

```
async fn thread_start_preserves_untrusted_project_trust() -> Result<()>
```

**Purpose**: Verifies that if a project is already explicitly marked untrusted, starting a thread with elevated sandbox does not overwrite that existing trust decision.

**Data flow**: It edits `config.toml` directly with `toml_edit` to add a `[projects.<workspace>] trust_level = "untrusted"` entry, records the file contents, starts a thread from that workspace with `sandbox: WorkspaceWrite`, then rereads the config and asserts it is byte-for-byte unchanged.

**Call relations**: This test ensures thread-start trust persistence respects existing explicit untrusted state instead of upgrading it.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 9 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, read_to_string, write, timeout, value).


##### `thread_start_skips_trust_write_when_project_is_already_trusted`  (lines 1142–1188)

```
async fn thread_start_skips_trust_write_when_project_is_already_trusted() -> Result<()>
```

**Purpose**: Checks that if a project is already trusted, starting with elevated sandbox loads trusted config but does not rewrite the config file.

**Data flow**: It writes a project config with high reasoning effort, marks the workspace trusted via `set_project_trust_level`, records the config file contents, starts a thread from that workspace with `sandbox: WorkspaceWrite`, parses the response and asserts approval policy `OnRequest` and reasoning effort `High`, then rereads the config and asserts it is unchanged.

**Call relations**: This complements both trust-persistence tests: trusted state should be honored for config loading, but no redundant write should occur.

*Call graph*: calls 3 internal fn (new, create_config_toml_without_approval_policy, set_project_trust_level); 9 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, create_dir_all, read_to_string, write, timeout).


##### `create_config_toml_without_approval_policy`  (lines 1190–1197)

```
fn create_config_toml_without_approval_policy(
    codex_home: &Path,
    server_uri: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes the standard thread-start test config while omitting any explicit `approval_policy` line.

**Data flow**: It delegates to `create_config_toml_with_optional_approval_policy` with `None` for the policy.

**Call relations**: This is the default config helper for most tests in the file, especially those that want to observe approval policy derived from trust or other defaults.

*Call graph*: calls 1 internal fn (create_config_toml_with_optional_approval_policy); called by 17 (thread_start_accepts_absolute_runtime_workspace_roots, thread_start_accepts_default_service_tier, thread_start_accepts_metrics_service_name, thread_start_creates_thread_and_emits_started, thread_start_drops_unsupported_service_tier_id, thread_start_ephemeral_remains_pathless, thread_start_preserves_untrusted_project_trust, thread_start_rejects_relative_environment_cwd_as_invalid_request, thread_start_rejects_unknown_environment_as_invalid_request, thread_start_respects_project_config_from_cwd (+7 more)).


##### `create_config_toml_with_optional_approval_policy`  (lines 1199–1226)

```
fn create_config_toml_with_optional_approval_policy(
    codex_home: &Path,
    server_uri: &str,
    approval_policy: Option<&str>,
) -> std::io::Result<()>
```

**Purpose**: Writes a minimal mock-provider config, optionally including an explicit approval-policy line.

**Data flow**: It computes the optional `approval_policy = "..."` snippet, formats TOML with model `mock-model`, read-only sandbox, provider `mock_provider`, and the supplied server URL, then writes `config.toml` under the Codex home.

**Call relations**: Used indirectly by `create_config_toml_without_approval_policy` and forms the baseline configuration for most thread-start scenarios.

*Call graph*: called by 1 (create_config_toml_without_approval_policy); 3 external calls (join, format!, write).


##### `create_config_toml_with_profile_workspace_root`  (lines 1228–1262)

```
fn create_config_toml_with_profile_workspace_root(
    codex_home: &Path,
    server_uri: &str,
    profile_root: &Path,
) -> std::io::Result<()>
```

**Purpose**: Writes config that defines a permissions profile with a specific workspace root, used to test exclusion of profile roots from runtime workspace roots.

**Data flow**: It escapes the supplied profile-root path for TOML, then writes `config.toml` containing `default_permissions = "dev"`, a `[permissions.dev.workspace_roots]` entry for that root, and matching filesystem permissions under `:workspace_roots`, along with the normal mock provider settings.

**Call relations**: Used only by `thread_start_excludes_profile_workspace_roots_from_runtime_workspace_roots` to seed profile-derived workspace roots.

*Call graph*: called by 1 (thread_start_excludes_profile_workspace_roots_from_runtime_workspace_roots); 4 external calls (display, join, format!, write).


##### `create_config_toml_with_chatgpt_base_url`  (lines 1264–1290)

```
fn create_config_toml_with_chatgpt_base_url(
    codex_home: &Path,
    server_uri: &str,
    chatgpt_base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes the standard mock-provider config plus a `chatgpt_base_url` for analytics and cloud-config tests.

**Data flow**: It formats and writes `config.toml` with model `mock-model`, approval policy `never`, read-only sandbox, the supplied ChatGPT backend URL, and the supplied mock model server URL.

**Call relations**: Used by the analytics and cloud-config failure tests so thread creation will attempt ChatGPT-side configuration and telemetry flows.

*Call graph*: called by 2 (thread_start_surfaces_cloud_config_bundle_load_errors, thread_start_tracks_thread_initialized_analytics); 3 external calls (join, format!, write).


##### `create_config_toml_with_required_broken_mcp`  (lines 1292–1321)

```
fn create_config_toml_with_required_broken_mcp(
    codex_home: &Path,
    server_uri: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes config containing a required MCP server whose transport always fails to start.

**Data flow**: It formats `config.toml` with the normal mock provider plus an `[mcp_servers.required_broken]` section whose transport snippet comes from `broken_mcp_transport_toml()` and `required = true`.

**Call relations**: Used only by `thread_start_fails_when_required_mcp_server_fails_to_initialize` to force the hard-failure startup path.

*Call graph*: called by 1 (thread_start_fails_when_required_mcp_server_fails_to_initialize); 3 external calls (join, format!, write).


##### `create_config_toml_with_optional_broken_mcp`  (lines 1323–1351)

```
fn create_config_toml_with_optional_broken_mcp(
    codex_home: &Path,
    server_uri: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes config containing an optional MCP server whose transport always fails, allowing startup to proceed while emitting status notifications.

**Data flow**: It writes `config.toml` with the normal mock provider plus an `[mcp_servers.optional_broken]` section using the platform-specific broken transport snippet.

**Call relations**: Used only by `thread_start_emits_mcp_server_status_updated_notifications` to exercise asynchronous MCP startup reporting.

*Call graph*: called by 1 (thread_start_emits_mcp_server_status_updated_notifications); 3 external calls (join, format!, write).


##### `broken_mcp_transport_toml`  (lines 1360–1363)

```
fn broken_mcp_transport_toml() -> &'static str
```

**Purpose**: Provides a platform-specific TOML snippet for an MCP transport command that exits with failure immediately.

**Data flow**: On Windows it returns a `cmd /C exit 1` snippet; on non-Windows it returns `/bin/sh -c exit 1`.

**Call relations**: Consumed by the required/optional broken MCP config writers so tests can force deterministic MCP startup failure on any platform.


### `app-server/tests/suite/v2/thread_list.rs`

`test` · `request handling`

This is the main listing/search regression suite for persisted threads. It defines several reusable helpers: `init_mcp` boots a `TestAppServer`; `list_threads` and `list_threads_with_sort` send typed `thread/list` requests; `list_threads_for_parent` exercises the `parent_thread_id` filter; and file-edit helpers mutate rollout metadata such as mtime and cwd directly in JSONL. The tests seed rollouts with controlled timestamps, providers, sources, git metadata, and archived locations, then assert exact ordering and field values returned by the server.

The suite covers default created-at sorting, updated-at sorting based on filesystem mtime, UUID tie-breakers, forward and backward cursors, max-limit clamping, and pagination behavior when filtering removes many candidates. Filtering coverage includes provider, cwd, archived flag, source-kind variants (CLI, Exec, multiple subagent flavors), empty `source_kinds` meaning interactive-only, and sqlite-backed `search_term` matching. Search-specific tests verify content snippets, case-insensitive matching, and JSON-escaped text. Several tests explicitly manipulate `StateRuntime` to validate sqlite-only reads, JSONL repair behavior, and parent-child spawn edges stored in the DB. There is also a runtime-status regression test proving that a thread with a failed turn is listed as `ThreadStatus::SystemError` rather than idle.

#### Function details

##### `init_mcp`  (lines 52–56)

```
async fn init_mcp(codex_home: &Path) -> Result<TestAppServer>
```

**Purpose**: Creates and initializes a `TestAppServer` for a given Codex home directory.

**Data flow**: It takes a filesystem path, constructs `TestAppServer::new`, waits for `initialize()` under `DEFAULT_READ_TIMEOUT`, and returns the ready server instance. No persistent state is changed beyond the server process/session startup.

**Call relations**: Nearly every test calls this helper during setup so they can focus on request/response assertions instead of repeated initialization boilerplate.

*Call graph*: calls 1 internal fn (new); called by 28 (thread_list_archived_filter, thread_list_backwards_cursor_can_seed_forward_delta_sync, thread_list_basic_empty, thread_list_created_at_tie_breaks_by_uuid, thread_list_default_sorts_by_created_at, thread_list_empty_source_kinds_defaults_to_interactive_only, thread_list_enforces_max_limit, thread_list_fetches_until_limit_or_exhausted, thread_list_filters_by_source_kind_subagent_thread_spawn, thread_list_filters_by_subagent_variant (+15 more)); 1 external calls (timeout).


##### `list_threads`  (lines 58–76)

```
async fn list_threads(
    mcp: &mut TestAppServer,
    cursor: Option<String>,
    limit: Option<u32>,
    providers: Option<Vec<String>>,
    source_kinds: Option<Vec<ThreadSourceKind>>,
    archive
```

**Purpose**: Convenience wrapper around `list_threads_with_sort` that issues a `thread/list` request without an explicit sort key.

**Data flow**: It accepts cursor, limit, provider filters, source-kind filters, and archived flag, forwards them to `list_threads_with_sort` with `sort_key: None`, and returns the typed `ThreadListResponse`.

**Call relations**: Most listing tests use this helper for the default created-at ordering path; it exists to centralize common request construction while delegating transport work to `list_threads_with_sort`.

*Call graph*: calls 1 internal fn (list_threads_with_sort); called by 13 (thread_list_archived_filter, thread_list_basic_empty, thread_list_created_at_tie_breaks_by_uuid, thread_list_empty_source_kinds_defaults_to_interactive_only, thread_list_enforces_max_limit, thread_list_fetches_until_limit_or_exhausted, thread_list_filters_by_source_kind_subagent_thread_spawn, thread_list_filters_by_subagent_variant, thread_list_includes_git_info, thread_list_pagination_next_cursor_none_on_last_page (+3 more)).


##### `list_threads_with_sort`  (lines 78–108)

```
async fn list_threads_with_sort(
    mcp: &mut TestAppServer,
    cursor: Option<String>,
    limit: Option<u32>,
    providers: Option<Vec<String>>,
    source_kinds: Option<Vec<ThreadSourceKind>>,
```

**Purpose**: Sends a fully parameterized `thread/list` request and decodes the JSON-RPC response into `ThreadListResponse`.

**Data flow**: It builds `ThreadListParams` from the supplied cursor, limit, provider filters, source-kind filters, optional sort key, and archived flag, always leaving `sort_direction` unset and `use_state_db_only` false. It sends the request, waits for the matching response id, and deserializes the result with `to_response`.

**Call relations**: This helper underpins both `list_threads` and the explicit sort tests. It is the common transport layer for all list assertions in the file.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_list_request); called by 6 (list_threads, thread_list_default_sorts_by_created_at, thread_list_sort_updated_at_orders_by_mtime, thread_list_updated_at_paginates_with_cursor, thread_list_updated_at_tie_breaks_by_uuid, thread_list_updated_at_uses_mtime); 2 external calls (Integer, timeout).


##### `list_threads_for_parent`  (lines 110–139)

```
async fn list_threads_for_parent(
    mcp: &mut TestAppServer,
    parent_thread_id: ThreadId,
    cursor: Option<String>,
    limit: u32,
    model_providers: Option<Vec<String>>,
    source_kinds: O
```

**Purpose**: Issues a `thread/list` request scoped to direct children of a specific parent thread id.

**Data flow**: It takes a mutable server, a `ThreadId`, pagination inputs, and optional provider/source-kind filters; converts the parent id to string; sends `ThreadListParams` with `parent_thread_id` populated; waits for the response; and returns the decoded `ThreadListResponse`.

**Call relations**: Only the parent-filter test uses this helper. It isolates the request shape needed to exercise state-db-backed child-thread listing.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_list_request); called by 1 (thread_list_parent_filter_reads_direct_children_from_state_db); 3 external calls (Integer, to_string, timeout).


##### `create_fake_rollouts`  (lines 141–165)

```
fn create_fake_rollouts(
    codex_home: &Path,
    count: usize,
    provider_for_index: F,
    timestamp_for_index: G,
    preview: &str,
) -> Result<Vec<String>>
```

**Purpose**: Bulk-creates a sequence of fake rollout files with caller-controlled provider and timestamp generation.

**Data flow**: It takes a Codex home path, a count, two closures (`provider_for_index` and `timestamp_for_index`), and a preview string. It allocates a vector sized to `count`, loops from `0..count`, derives filename and RFC3339 timestamps per index, creates each fake rollout, pushes the returned id, and finally returns the collected ids.

**Call relations**: The pagination and limit tests use this helper to generate large, patterned datasets where only some threads match the requested filters.

*Call graph*: called by 3 (thread_list_enforces_max_limit, thread_list_fetches_until_limit_or_exhausted, thread_list_stops_when_not_enough_filtered_results_exist); 2 external calls (with_capacity, create_fake_rollout).


##### `timestamp_at`  (lines 167–179)

```
fn timestamp_at(
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
) -> (String, String)
```

**Purpose**: Builds the pair of timestamp strings needed by fake rollout helpers: one filename-safe and one RFC3339.

**Data flow**: It formats the supplied date/time components into `(YYYY-MM-DDTHH-MM-SS, YYYY-MM-DDTHH:MM:SSZ)` and returns that tuple.

**Call relations**: This helper supports `create_fake_rollouts` callers that need deterministic timestamp series for ordering and pagination tests.

*Call graph*: 1 external calls (format!).


##### `set_rollout_mtime`  (lines 182–190)

```
fn set_rollout_mtime(path: &Path, updated_at_rfc3339: &str) -> Result<()>
```

**Purpose**: Mutates a rollout file’s filesystem modified time to a specific RFC3339 instant so updated-at sorting can be tested independently of created-at metadata.

**Data flow**: It parses the RFC3339 string into a UTC `DateTime`, converts it into `FileTimes`, opens the rollout file in append mode, applies the modified timestamp with `set_times`, and returns success or an error.

**Call relations**: Updated-at sorting, pagination, tie-break, and delta-sync tests call this helper after creating rollouts to force a known mtime ordering.

*Call graph*: called by 5 (thread_list_backwards_cursor_can_seed_forward_delta_sync, thread_list_sort_updated_at_orders_by_mtime, thread_list_updated_at_paginates_with_cursor, thread_list_updated_at_tie_breaks_by_uuid, thread_list_updated_at_uses_mtime); 3 external calls (parse_from_rfc3339, new, new).


##### `set_rollout_cwd`  (lines 192–210)

```
fn set_rollout_cwd(path: &Path, cwd: &Path) -> Result<()>
```

**Purpose**: Edits the first JSONL line of a rollout so its stored session metadata uses a specific working directory.

**Data flow**: It reads the rollout file as text, splits into lines, parses the first line as `RolloutLine`, requires that the first item is `RolloutItem::SessionMeta`, replaces `meta.cwd` with the provided path, reserializes the first line, rejoins all lines with a trailing newline, and writes the file back. It errors if the file is empty or does not begin with session metadata.

**Call relations**: Only the cwd-filter test uses this helper to create rollouts whose metadata differs from the default `/` path.

*Call graph*: called by 1 (thread_list_respects_cwd_filters); 7 external calls (to_path_buf, anyhow!, read_to_string, write, SessionMeta, from_str, to_string).


##### `thread_list_basic_empty`  (lines 213–234)

```
async fn thread_list_basic_empty() -> Result<()>
```

**Purpose**: Checks that listing against an empty Codex home returns no threads and no pagination cursor.

**Data flow**: The test creates a temp home, writes a minimal config, initializes the server, calls `list_threads` with a provider filter and limit 10, and asserts `data.is_empty()` and `next_cursor == None`.

**Call relations**: This is the baseline empty-state test for the list API, using the standard setup helpers.

*Call graph*: calls 3 internal fn (create_minimal_config, init_mcp, list_threads); 4 external calls (new, assert!, assert_eq!, vec!).


##### `thread_list_reports_system_error_idle_flag_after_failed_turn`  (lines 237–327)

```
async fn thread_list_reports_system_error_idle_flag_after_failed_turn() -> Result<()>
```

**Purpose**: Verifies that a thread whose latest turn failed is listed with `ThreadStatus::SystemError`.

**Data flow**: It mounts a mock response sequence where the first turn succeeds and the second SSE stream fails, writes runtime config, initializes the server, starts a thread, completes a seed turn, starts a second turn that emits an `error` notification, then calls `list_threads` with explicit source-kind filters and finds the thread in the returned data. The final assertion checks `listed.status == ThreadStatus::SystemError`.

**Call relations**: This test combines turn execution with later listing to ensure runtime failure state is reflected in summary metadata returned by `thread/list`.

*Call graph*: calls 3 internal fn (create_runtime_config, init_mcp, list_threads); 7 external calls (default, new, Integer, create_mock_responses_server_sequence, assert_eq!, timeout, vec!).


##### `create_minimal_config`  (lines 330–339)

```
fn create_minimal_config(codex_home: &std::path::Path) -> std::io::Result<()>
```

**Purpose**: Writes the smallest `config.toml` sufficient for listing/search tests that only inspect stored rollout metadata.

**Data flow**: It joins `config.toml` under the temp home and writes a short TOML document containing `model = "mock-model"` and `approval_policy = "never"`.

**Call relations**: Most pure listing/search tests call this helper because they do not need a live model provider endpoint.

*Call graph*: called by 25 (thread_list_archived_filter, thread_list_backwards_cursor_can_seed_forward_delta_sync, thread_list_basic_empty, thread_list_created_at_tie_breaks_by_uuid, thread_list_default_sorts_by_created_at, thread_list_empty_source_kinds_defaults_to_interactive_only, thread_list_enforces_max_limit, thread_list_fetches_until_limit_or_exhausted, thread_list_filters_by_source_kind_subagent_thread_spawn, thread_list_filters_by_subagent_variant (+15 more)); 2 external calls (join, write).


##### `create_runtime_config`  (lines 341–362)

```
fn create_runtime_config(codex_home: &std::path::Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes a full runtime config pointing the mock provider at a supplied server URI for tests that need to execute turns before listing.

**Data flow**: It formats and writes TOML containing model defaults, `sandbox_mode`, `model_provider = "mock_provider"`, and a provider block using `{server_uri}/v1` with zero retries.

**Call relations**: Only the failed-turn status test uses this helper because it needs actual turn execution against a mock responses server.

*Call graph*: called by 1 (thread_list_reports_system_error_idle_flag_after_failed_turn); 3 external calls (join, format!, write).


##### `thread_list_pagination_next_cursor_none_on_last_page`  (lines 365–454)

```
async fn thread_list_pagination_next_cursor_none_on_last_page() -> Result<()>
```

**Purpose**: Checks basic pagination semantics: the first page returns a cursor when more results exist, and the final page returns `nextCursor: null`.

**Data flow**: The test seeds three rollouts with descending created-at timestamps, initializes the server, requests page 1 with limit 2, asserts two items plus expected metadata fields on each thread and a non-null cursor, then requests page 2 with that cursor and asserts the remaining items still have correct metadata and `next_cursor == None`.

**Call relations**: This is the canonical pagination test for default sorting and summary field population.

*Call graph*: calls 3 internal fn (create_minimal_config, init_mcp, list_threads); 5 external calls (new, create_fake_rollout, assert!, assert_eq!, vec!).


##### `thread_list_respects_provider_filter`  (lines 457–507)

```
async fn thread_list_respects_provider_filter() -> Result<()>
```

**Purpose**: Verifies that `model_providers` filtering returns only threads whose stored provider matches the requested value.

**Data flow**: It creates two rollouts under different providers, initializes the server, lists with `model_providers = ["other_provider"]`, and asserts exactly one result with preview `X`, provider `other_provider`, expected created/updated timestamps, default cwd, CLI version, CLI source, and no git info.

**Call relations**: This test isolates provider filtering from other list behavior by using a tiny two-thread dataset.

*Call graph*: calls 3 internal fn (create_minimal_config, init_mcp, list_threads); 5 external calls (new, create_fake_rollout, assert_eq!, parse_from_rfc3339, vec!).


##### `thread_list_respects_cwd_filters`  (lines 510–596)

```
async fn thread_list_respects_cwd_filters() -> Result<()>
```

**Purpose**: Checks that `thread/list` can filter by multiple working directories stored in rollout session metadata.

**Data flow**: The test creates three rollouts, creates two target cwd directories, rewrites two rollout files with `set_rollout_cwd`, initializes the server, sends a raw `thread/list` request whose `cwd` is `ThreadListCwdFilter::Many([...])`, decodes the response, and asserts only the two rewritten thread ids are returned in descending order, excluding the untouched rollout. It also verifies the returned `cwd` paths match the injected directories.

**Call relations**: This test bypasses the local `list_threads` helper because it needs to populate the `cwd` field directly in `ThreadListParams`.

*Call graph*: calls 3 internal fn (create_minimal_config, init_mcp, set_rollout_cwd); 10 external calls (new, Integer, Many, create_fake_rollout, rollout_path, assert!, assert_eq!, create_dir_all, timeout, vec!).


##### `thread_list_respects_search_term_filter`  (lines 599–700)

```
async fn thread_list_respects_search_term_filter() -> Result<()>
```

**Purpose**: Verifies that `search_term` filtering on `thread/list` works through the sqlite fast path after manual rollout repair/backfill setup.

**Data flow**: It writes a config enabling sqlite, creates three rollouts where two previews contain `needle`, initializes `StateRuntime`, marks backfill complete, constructs a `RolloutConfig`, calls `RolloutRecorder::list_threads` once without search to repair all rollouts into sqlite, then initializes the server and sends `thread/list` with `search_term: Some("needle")`. It asserts `next_cursor == None` and that the returned ids are the newer and older matching threads in descending order.

**Call relations**: This test explicitly prepares sqlite state before invoking the app server because the searched list path depends on indexed data rather than raw JSONL scanning alone.

*Call graph*: calls 3 internal fn (init_mcp, list_threads, init); 7 external calls (new, Integer, create_fake_rollout, assert_eq!, write, timeout, vec!).


##### `thread_search_returns_content_matches`  (lines 703–762)

```
async fn thread_search_returns_content_matches() -> Result<()>
```

**Purpose**: Checks the dedicated `thread/search` API returns matching threads ordered by recency along with a content snippet.

**Data flow**: It seeds three rollouts, two containing `needle` in different casing contexts, initializes the server, sends `ThreadSearchParams` with `search_term = "needle"`, decodes `ThreadSearchResponse`, and asserts no next cursor, ids ordered newest-first, and the first result’s snippet equals `mixed NEEDLE suffix`.

**Call relations**: This test covers the search endpoint separately from `thread/list`’s optional search filter.

*Call graph*: calls 2 internal fn (create_minimal_config, init_mcp); 5 external calls (new, Integer, create_fake_rollout, assert_eq!, timeout).


##### `thread_search_matches_json_escaped_content`  (lines 765–803)

```
async fn thread_search_matches_json_escaped_content() -> Result<()>
```

**Purpose**: Ensures search can match content containing quotes and backslashes exactly as stored through JSON escaping.

**Data flow**: It creates one rollout whose preview contains `quoted "needle" \ path`, initializes the server, sends `thread/search` with the same string as the search term, decodes the response, and asserts a single result whose thread id and snippet exactly match the original string.

**Call relations**: This is a regression test for escaping/serialization boundaries in search indexing and matching.

*Call graph*: calls 2 internal fn (create_minimal_config, init_mcp); 5 external calls (new, Integer, create_fake_rollout, assert_eq!, timeout).


##### `thread_search_filters_by_source_kind`  (lines 806–855)

```
async fn thread_search_filters_by_source_kind() -> Result<()>
```

**Purpose**: Verifies that `thread/search` respects `source_kinds` filtering and can isolate Exec-origin threads from CLI threads even when content matches both.

**Data flow**: The test creates one CLI rollout and one Exec rollout with the same matching text, initializes the server, sends `thread/search` with `source_kinds = [Exec]`, and asserts the returned ids contain only the Exec thread.

**Call relations**: It extends search coverage to source-kind filtering, mirroring similar list tests but on the search endpoint.

*Call graph*: calls 2 internal fn (create_minimal_config, init_mcp); 8 external calls (new, Integer, create_fake_rollout, create_fake_rollout_with_source, assert_eq!, assert_ne!, timeout, vec!).


##### `thread_list_state_db_only_returns_sqlite_without_jsonl_repair`  (lines 858–981)

```
async fn thread_list_state_db_only_returns_sqlite_without_jsonl_repair() -> Result<()>
```

**Purpose**: Checks the difference between sqlite-only listing and the default repair/scanning path when JSONL and sqlite metadata diverge.

**Data flow**: It enables sqlite, creates a rollout, initializes `StateRuntime`, marks backfill complete, initializes the server, and first lists with `use_state_db_only: false` to trigger repair so the rollout appears. It then parses the thread id into `ThreadId`, mutates the sqlite row’s `cwd` to a stale path, and upserts it. A second list with `use_state_db_only: true` and a cwd filter for that stale path returns the thread from sqlite. A third list with the same cwd filter but `use_state_db_only: false` returns no data because JSONL scanning/repair sees the real cwd instead.

**Call relations**: This test directly manipulates sqlite state to prove the semantics of the `use_state_db_only` flag and the repair path.

*Call graph*: calls 3 internal fn (init_mcp, from_string, init); 8 external calls (new, Integer, One, create_fake_rollout, assert_eq!, write, timeout, vec!).


##### `thread_list_parent_filter_reads_direct_children_from_state_db`  (lines 984–1107)

```
async fn thread_list_parent_filter_reads_direct_children_from_state_db() -> Result<()>
```

**Purpose**: Verifies that `parent_thread_id` listing reads direct child relationships from sqlite spawn-edge data, paginates correctly, and supports source-kind filtering.

**Data flow**: It creates a minimal config, allocates parent/child/grandchild `ThreadId`s, initializes `StateRuntime`, builds and upserts three thread metadata rows with controlled timestamps, sources, providers, cwd, and preview, then inserts spawn edges parent→older child, parent→newer child, and newer child→grandchild. After marking backfill complete and initializing the server, it fetches two one-item pages for the parent and asserts newer child appears first, older child second, `next_cursor` ends at `None`, and every returned thread has `parent_thread_id` set to the parent. It then requests the same parent with `source_kinds = Some(Vec::new())` and asserts only the interactive child remains.

**Call relations**: This test bypasses rollout files entirely and exercises the state-db-only parent-child listing path through the `list_threads_for_parent` helper.

*Call graph*: calls 6 internal fn (create_minimal_config, init_mcp, list_threads_for_parent, new, new, init); 8 external calls (SubAgent, parse_from_rfc3339, new, new, assert!, assert_eq!, format!, Other).


##### `thread_list_parent_filter_rejects_malformed_thread_id`  (lines 1110–1137)

```
async fn thread_list_parent_filter_rejects_malformed_thread_id() -> Result<()>
```

**Purpose**: Checks that an invalid `parent_thread_id` is rejected as an invalid request.

**Data flow**: It creates config, initializes the server, sends `thread/list` with `parent_thread_id = "not-a-thread-id"`, waits for a JSON-RPC error, and asserts `error.code == -32600`.

**Call relations**: This is the validation counterpart to the successful parent-filter test.

*Call graph*: calls 2 internal fn (create_minimal_config, init_mcp); 4 external calls (new, Integer, assert_eq!, timeout).


##### `thread_list_empty_source_kinds_defaults_to_interactive_only`  (lines 1140–1183)

```
async fn thread_list_empty_source_kinds_defaults_to_interactive_only() -> Result<()>
```

**Purpose**: Verifies that passing an empty `source_kinds` array means interactive-only threads rather than no filtering or no results.

**Data flow**: The test creates one CLI rollout and one Exec rollout, initializes the server, lists with `source_kinds = Some(Vec::new())`, and asserts only the CLI thread id is returned, with `source == SessionSource::Cli` and `next_cursor == None`.

**Call relations**: This covers a subtle API convention where an empty array has semantic meaning distinct from `None`.

*Call graph*: calls 3 internal fn (create_minimal_config, init_mcp, list_threads); 7 external calls (new, new, create_fake_rollout, create_fake_rollout_with_source, assert_eq!, assert_ne!, vec!).


##### `thread_list_filters_by_source_kind_subagent_thread_spawn`  (lines 1186–1238)

```
async fn thread_list_filters_by_source_kind_subagent_thread_spawn() -> Result<()>
```

**Purpose**: Checks that the `SubAgentThreadSpawn` source-kind filter returns only subagent threads created via thread spawning.

**Data flow**: It creates a normal CLI rollout and a second rollout whose source is `CoreSessionSource::SubAgent(SubAgentSource::ThreadSpawn { ... })`, initializes the server, lists with `source_kinds = [SubAgentThreadSpawn]`, and asserts only the spawned subagent thread is returned. It also verifies the returned source is a subagent variant and `session_id` equals the thread id.

**Call relations**: This test isolates one specific subagent source-kind mapping in the list API.

*Call graph*: calls 4 internal fn (create_minimal_config, init_mcp, list_threads, from_string); 9 external calls (SubAgent, new, new_v4, create_fake_rollout, create_fake_rollout_with_source, assert!, assert_eq!, assert_ne!, vec!).


##### `thread_list_filters_by_subagent_variant`  (lines 1241–1354)

```
async fn thread_list_filters_by_subagent_variant() -> Result<()>
```

**Purpose**: Verifies that each subagent source-kind filter maps to the correct underlying `SubAgentSource` variant and preserves parent metadata where applicable.

**Data flow**: It creates four rollouts: review (with explicit parent), compact, thread-spawn, and other/custom. After initialization, it performs four separate `list_threads` calls with `SubAgentReview`, `SubAgentCompact`, `SubAgentThreadSpawn`, and `SubAgentOther`, collecting ids from each response and asserting each filter returns exactly the expected rollout. The review case also checks `parent_thread_id` propagation.

**Call relations**: This is the comprehensive source-kind mapping test for subagent variants, using repeated calls through the shared `list_threads` helper.

*Call graph*: calls 4 internal fn (create_minimal_config, init_mcp, list_threads, from_string); 8 external calls (SubAgent, new, new_v4, create_fake_parented_rollout_with_source, create_fake_rollout_with_source, assert_eq!, Other, vec!).


##### `thread_list_fetches_until_limit_or_exhausted`  (lines 1357–1418)

```
async fn thread_list_fetches_until_limit_or_exhausted() -> Result<()>
```

**Purpose**: Checks that server-side pagination continues scanning underlying pages until enough filtered results are accumulated to satisfy the requested limit.

**Data flow**: It bulk-creates 24 rollouts where the newest 16 use a provider that should be skipped and the oldest 8 use `target_provider`, initializes the server, requests 8 threads filtered to `target_provider`, and asserts exactly 8 results all match the provider and `next_cursor == None`.

**Call relations**: This test targets the internal loop that keeps fetching/scanning pages when early pages are filtered out heavily.

*Call graph*: calls 4 internal fn (create_fake_rollouts, create_minimal_config, init_mcp, list_threads); 4 external calls (new, assert!, assert_eq!, vec!).


##### `thread_list_enforces_max_limit`  (lines 1421–1468)

```
async fn thread_list_enforces_max_limit() -> Result<()>
```

**Purpose**: Verifies that an oversized requested limit is clamped to the server’s maximum page size.

**Data flow**: It creates 105 rollouts under one provider, initializes the server, requests `limit = 200`, and asserts only 100 items are returned and `next_cursor` is still present because more results remain.

**Call relations**: This is a boundary test for request validation and pagination limits.

*Call graph*: calls 4 internal fn (create_fake_rollouts, create_minimal_config, init_mcp, list_threads); 4 external calls (new, assert!, assert_eq!, vec!).


##### `thread_list_stops_when_not_enough_filtered_results_exist`  (lines 1471–1531)

```
async fn thread_list_stops_when_not_enough_filtered_results_exist() -> Result<()>
```

**Purpose**: Checks that listing terminates cleanly with `nextCursor: null` when filtering yields fewer matches than requested, rather than looping indefinitely.

**Data flow**: It creates 22 rollouts where only the last 7 match `target_provider`, initializes the server, requests 10 filtered results, and asserts exactly 7 are returned, all with the target provider, and `next_cursor == None`.

**Call relations**: This complements the fetch-until-limit test by covering the exhausted-data branch.

*Call graph*: calls 4 internal fn (create_fake_rollouts, create_minimal_config, init_mcp, list_threads); 4 external calls (new, assert!, assert_eq!, vec!).


##### `thread_list_includes_git_info`  (lines 1534–1579)

```
async fn thread_list_includes_git_info() -> Result<()>
```

**Purpose**: Verifies that git metadata stored in rollout session metadata is surfaced through `thread/list` using the API’s `GitInfo` shape.

**Data flow**: The test creates a rollout with `CoreGitInfo { commit_hash, branch, repository_url }`, initializes the server, lists threads, finds the created thread, and asserts `git_info` equals `ApiGitInfo { sha, branch, origin_url }` plus expected source, cwd, and CLI version defaults.

**Call relations**: This is the positive metadata-mapping test for git fields in list summaries.

*Call graph*: calls 4 internal fn (create_minimal_config, init_mcp, list_threads, new); 4 external calls (new, create_fake_rollout, assert_eq!, vec!).


##### `thread_list_default_sorts_by_created_at`  (lines 1582–1628)

```
async fn thread_list_default_sorts_by_created_at() -> Result<()>
```

**Purpose**: Checks that the default list ordering is descending by created-at timestamp.

**Data flow**: It creates three rollouts with known created-at times, initializes the server, calls `list_threads_with_sort` with `sort_key: None`, extracts ids from the response, and asserts newest-to-oldest ordering.

**Call relations**: This is the baseline ordering test that other sort-specific tests build on.

*Call graph*: calls 3 internal fn (create_minimal_config, init_mcp, list_threads_with_sort); 4 external calls (new, create_fake_rollout, assert_eq!, vec!).


##### `thread_list_sort_updated_at_orders_by_mtime`  (lines 1631–1690)

```
async fn thread_list_sort_updated_at_orders_by_mtime() -> Result<()>
```

**Purpose**: Verifies that `sort_key = UpdatedAt` orders threads by filesystem modified time rather than created-at metadata.

**Data flow**: The test creates three rollouts, rewrites their mtimes to a custom order using `set_rollout_mtime`, initializes the server, lists with `sort_key = UpdatedAt`, and asserts ids are returned in descending mtime order.

**Call relations**: It depends on `set_rollout_mtime` to decouple updated-at ordering from creation timestamps.

*Call graph*: calls 4 internal fn (create_minimal_config, init_mcp, list_threads_with_sort, set_rollout_mtime); 5 external calls (new, create_fake_rollout, rollout_path, assert_eq!, vec!).


##### `thread_list_updated_at_paginates_with_cursor`  (lines 1693–1774)

```
async fn thread_list_updated_at_paginates_with_cursor() -> Result<()>
```

**Purpose**: Checks cursor pagination when sorting by updated-at.

**Data flow**: It creates three rollouts, assigns descending mtimes, initializes the server, requests page 1 with limit 2 and `sort_key = UpdatedAt`, asserts the first two ids and captures `next_cursor`, then requests page 2 with that cursor and asserts the final id and `next_cursor == None`.

**Call relations**: This extends updated-at sorting coverage into cursor generation and continuation.

*Call graph*: calls 4 internal fn (create_minimal_config, init_mcp, list_threads_with_sort, set_rollout_mtime); 5 external calls (new, create_fake_rollout, rollout_path, assert_eq!, vec!).


##### `thread_list_backwards_cursor_can_seed_forward_delta_sync`  (lines 1777–1883)

```
async fn thread_list_backwards_cursor_can_seed_forward_delta_sync() -> Result<()>
```

**Purpose**: Verifies the `backwards_cursor` contract used for delta sync: a descending page can produce a watermark cursor that later seeds an ascending query returning the watermark item and newer updates.

**Data flow**: It creates two rollouts, sets mtimes so one is the watermark/newest, initializes the server, sends a raw `thread/list` request with `sort_key = UpdatedAt`, `sort_direction = Desc`, and `limit = 1`, then asserts the single returned id and exact `backwards_cursor` string `2025-02-02T23:59:59.999Z`. After creating a newer rollout and assigning an even newer mtime, it sends another raw `thread/list` request with `cursor = backwards_cursor`, `sort_direction = Asc`, and asserts the returned ids are the watermark thread followed by the newly updated thread.

**Call relations**: This test bypasses the helper wrappers because it needs explicit sort direction control and direct access to `backwards_cursor` semantics.

*Call graph*: calls 3 internal fn (create_minimal_config, init_mcp, set_rollout_mtime); 7 external calls (new, Integer, create_fake_rollout, rollout_path, assert_eq!, timeout, vec!).


##### `thread_list_created_at_tie_breaks_by_uuid`  (lines 1886–1926)

```
async fn thread_list_created_at_tie_breaks_by_uuid() -> Result<()>
```

**Purpose**: Checks deterministic ordering when created-at timestamps tie: threads should be ordered by descending UUID.

**Data flow**: It creates two rollouts with identical created-at timestamps, initializes the server, lists threads, computes the expected order by parsing both ids as `Uuid` and sorting descending, and asserts the returned ids match that order.

**Call relations**: This is a tie-break regression test for stable pagination and ordering.

*Call graph*: calls 3 internal fn (create_minimal_config, init_mcp, list_threads); 4 external calls (new, create_fake_rollout, assert_eq!, vec!).


##### `thread_list_updated_at_tie_breaks_by_uuid`  (lines 1929–1980)

```
async fn thread_list_updated_at_tie_breaks_by_uuid() -> Result<()>
```

**Purpose**: Checks deterministic ordering when updated-at timestamps tie: threads should again be ordered by descending UUID.

**Data flow**: It creates two rollouts, forces both mtimes to the same instant, initializes the server, lists with `sort_key = UpdatedAt`, computes expected descending-UUID order, and asserts the response matches.

**Call relations**: This mirrors the created-at tie-break test for the updated-at sort path.

*Call graph*: calls 4 internal fn (create_minimal_config, init_mcp, list_threads_with_sort, set_rollout_mtime); 5 external calls (new, create_fake_rollout, rollout_path, assert_eq!, vec!).


##### `thread_list_updated_at_uses_mtime`  (lines 1983–2026)

```
async fn thread_list_updated_at_uses_mtime() -> Result<()>
```

**Purpose**: Verifies that the returned `updated_at` field itself reflects filesystem mtime while `created_at` remains the original session timestamp.

**Data flow**: It creates one rollout, changes its mtime to a later date, initializes the server, lists with `sort_key = UpdatedAt`, finds the thread, parses expected created and updated timestamps from RFC3339 strings, and asserts both fields exactly.

**Call relations**: This complements ordering tests by checking the actual numeric metadata values exposed on the API.

*Call graph*: calls 4 internal fn (create_minimal_config, init_mcp, list_threads_with_sort, set_rollout_mtime); 6 external calls (new, create_fake_rollout, rollout_path, assert_eq!, parse_from_rfc3339, vec!).


##### `thread_list_archived_filter`  (lines 2029–2087)

```
async fn thread_list_archived_filter() -> Result<()>
```

**Purpose**: Checks that archived rollouts moved under `ARCHIVED_SESSIONS_SUBDIR` are excluded from normal listing and returned only when `archived: true` is requested.

**Data flow**: The test creates one active and one archived rollout, physically moves the archived file into the archive directory, initializes the server, lists once with `archived: None` and asserts only the active id appears, then lists again with `archived: Some(true)` and asserts only the archived id appears.

**Call relations**: This test validates the file-location-based archived filter behavior of `thread/list`.

*Call graph*: calls 3 internal fn (create_minimal_config, init_mcp, list_threads); 7 external calls (new, create_fake_rollout, rollout_path, assert_eq!, create_dir_all, rename, vec!).


##### `thread_list_invalid_cursor_returns_error`  (lines 2090–2120)

```
async fn thread_list_invalid_cursor_returns_error() -> Result<()>
```

**Purpose**: Verifies that malformed pagination cursors are rejected with a clear invalid-request error.

**Data flow**: It creates config, initializes the server, sends `thread/list` with `cursor = "not-a-cursor"`, waits for a `JSONRPCError`, and asserts code `-32600` and message `invalid cursor: not-a-cursor`.

**Call relations**: This is the negative validation test for cursor parsing.

*Call graph*: calls 2 internal fn (create_minimal_config, init_mcp); 5 external calls (new, Integer, assert_eq!, timeout, vec!).


### `app-server/tests/suite/v2/thread_loaded_list.rs`

`test` · `request handling`

This small suite verifies the behavior of the loaded-thread inventory API. Unlike `thread/list`, which scans persisted sessions, these tests create live threads through `thread/start` and then query `thread/loaded/list` to inspect the server’s in-memory loaded set. The setup is intentionally minimal: a temporary Codex home, a standard runtime config pointing at a repeating mock responses server, and a helper that starts a thread and returns its id.

The first test proves the endpoint returns the single loaded thread id and no pagination cursor. The second test creates two loaded threads and checks pagination semantics with `limit: 1`: the first page returns the lexicographically first id and uses that id as `next_cursor`, while the second page returns the remaining id and ends pagination with `None`. The tests sort expected ids locally before comparing, which documents that the endpoint’s ordering is deterministic and cursor-based over thread ids rather than creation timestamps. The helper functions encapsulate the repeated config-writing and thread-start request/response flow.

#### Function details

##### `thread_loaded_list_returns_loaded_thread_ids`  (lines 19–46)

```
async fn thread_loaded_list_returns_loaded_thread_ids() -> Result<()>
```

**Purpose**: Checks that `thread/loaded/list` returns the id of a thread started in the current server process and no continuation cursor when only one loaded thread exists.

**Data flow**: The test starts a mock server, writes config, initializes `TestAppServer`, creates one thread via `start_thread`, sends `ThreadLoadedListParams::default()`, waits for the response, decodes `ThreadLoadedListResponse`, sorts the returned `data`, and asserts it equals a one-element vector containing the started thread id with `next_cursor == None`.

**Call relations**: It uses the local `start_thread` helper to create the loaded state before querying the endpoint.

*Call graph*: calls 3 internal fn (new, create_config_toml, start_thread); 6 external calls (new, Integer, default, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_loaded_list_paginates`  (lines 49–100)

```
async fn thread_loaded_list_paginates() -> Result<()>
```

**Purpose**: Verifies pagination over loaded thread ids using `cursor` and `limit`.

**Data flow**: After setup and initialization, the test starts two threads, sorts the two expected ids, requests the first page with `limit: Some(1)`, decodes the response, and asserts the first page contains the first sorted id and `next_cursor` equals that id. It then requests a second page using that cursor and asserts the second page contains the remaining id and `next_cursor == None`.

**Call relations**: This test extends the single-thread case to prove cursor semantics for the loaded-thread listing endpoint.

*Call graph*: calls 3 internal fn (new, create_config_toml, start_thread); 5 external calls (new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `create_config_toml`  (lines 102–123)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes the standard runtime config used by the loaded-thread list tests.

**Data flow**: It joins `config.toml` under the temporary home, formats TOML with model defaults and a mock provider block using the supplied server URI, and writes the file.

**Call relations**: Both tests call this helper during setup before constructing `TestAppServer`.

*Call graph*: called by 2 (thread_loaded_list_paginates, thread_loaded_list_returns_loaded_thread_ids); 3 external calls (join, format!, write).


##### `start_thread`  (lines 125–139)

```
async fn start_thread(mcp: &mut TestAppServer) -> Result<String>
```

**Purpose**: Starts a new thread through the app server and returns its thread id.

**Data flow**: It takes a mutable `TestAppServer`, sends `ThreadStartParams` with `model: Some("gpt-5.2")`, waits for the matching JSON-RPC response, decodes `ThreadStartResponse`, and returns `thread.id`.

**Call relations**: Both loaded-list tests use this helper to populate the server’s in-memory loaded-thread set before querying `thread/loaded/list`.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_start_request); called by 2 (thread_loaded_list_paginates, thread_loaded_list_returns_loaded_thread_ids); 3 external calls (default, Integer, timeout).


### `app-server/tests/suite/v2/thread_read.rs`

`test` · `request handling`

This is the most comprehensive read-side test file for thread data. It validates summary reads, full-turn reads, turn pagination, item-view modes, archived-thread lookup, fork metadata, name propagation, and error handling for unmaterialized loaded threads. Most tests use rollout JSONL files seeded with `create_fake_rollout_with_text_elements`, then mutate those files directly with helpers that append user messages, agent messages, or rollback events. The tests assert exact `ThreadItem` shapes, `TurnStatus`, `TurnItemsView`, path/ephemeral serialization, and cursor behavior for both forward and backward paging.

A second cluster of tests bypasses rollout files entirely by configuring `experimental_thread_store` to use `InMemoryThreadStore`. Those tests start the app server in-process with a fully constructed `InProcessStartArgs`, seed pathless threads directly into the store, and prove that `thread/turns/list`, `thread/read`, and `thread/list` can operate when `thread.path` is `None`. The file also includes a small RAII wrapper that unregisters the in-memory store id on drop. Additional regressions cover archived-session lookup by id, `thread/resume` initial-turns-page parity with `thread/turns/list`, cursor invalidation after rollback, unsupported `thread/turns/items/list`, and `ThreadStatus::SystemError` after a failed turn. Shared helpers centralize JSONL appends, single-turn reads, text extraction from returned turns, store seeding, and config writing.

#### Function details

##### `thread_read_returns_summary_without_turns`  (lines 83–135)

```
async fn thread_read_returns_summary_without_turns() -> Result<()>
```

**Purpose**: Verifies that `thread/read` with `include_turns: false` returns only summary metadata for a stored rollout-backed thread.

**Data flow**: The test creates a rollout containing one user message with a text element annotation, starts the server, sends `ThreadReadParams { include_turns: false }`, decodes `ThreadReadResponse`, and asserts id, preview, provider, `ephemeral == false`, absolute path, default cwd, CLI version, CLI source, no git info, zero turns, and `ThreadStatus::NotLoaded`.

**Call relations**: This is the baseline read test for stored threads and establishes the summary-only contract before turn-loading tests.

*Call graph*: calls 3 internal fn (new, new, create_config_toml); 7 external calls (new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout).


##### `thread_read_can_include_turns`  (lines 138–197)

```
async fn thread_read_can_include_turns() -> Result<()>
```

**Purpose**: Checks that `thread/read` can return full turn history for a stored rollout when `include_turns: true` is requested.

**Data flow**: It seeds a rollout with one user message and text elements, starts the server, sends `thread/read` with `include_turns: true`, decodes the response, and asserts there is one completed turn with `items_view = Full` containing a `ThreadItem::UserMessage` whose `UserInput::Text` preserves both the message text and converted text elements. It also checks the thread status remains `NotLoaded`.

**Call relations**: This extends the summary read path into full history loading and item decoding.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, assert_eq!, panic!, timeout, vec!).


##### `thread_turns_list_can_page_backward_and_forward`  (lines 200–286)

```
async fn thread_turns_list_can_page_backward_and_forward() -> Result<()>
```

**Purpose**: Verifies turn pagination in both descending and ascending directions, including use of `next_cursor` for older pages and `backwards_cursor` for forward delta reads.

**Data flow**: The test creates a rollout with one initial user message, appends two more user messages directly to the JSONL file, starts the server, and requests `thread/turns/list` descending with limit 2. It asserts the returned user texts are `third`, `second`, all turns default to `TurnItemsView::Summary`, and both cursors are present. It then requests the older page using `next_cursor` and gets `first`. After appending a fourth message, it requests ascending from `backwards_cursor` and asserts the returned texts are `third`, `fourth`.

**Call relations**: This is the main pagination test for turn history and relies on `append_user_message` plus `turn_user_texts` to make assertions concise.

*Call graph*: calls 3 internal fn (new, append_user_message, create_config_toml); 9 external calls (new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, rollout_path, assert!, assert_eq!, timeout, vec!).


##### `thread_turns_list_supports_requested_items_view`  (lines 289–354)

```
async fn thread_turns_list_supports_requested_items_view() -> Result<()>
```

**Purpose**: Checks that `thread/turns/list` honors requested `TurnItemsView` modes (`Full`, `Summary`, `NotLoaded`) and returns the expected subsets of items.

**Data flow**: It creates a rollout with one user message, appends two agent messages, starts the server, and repeatedly calls `read_single_turn_items_view` with different `items_view` values. For `Full`, it asserts both agent messages are present. For `Summary`, it asserts the user message plus only the final agent message are present. For `NotLoaded`, it asserts `items` is empty while structural fields like id, status, timestamps, and duration match the full version.

**Call relations**: This test uses the local `read_single_turn_items_view`, `turn_user_texts`, and `turn_agent_texts` helpers to compare the three item-view modes on the same underlying turn.

*Call graph*: calls 4 internal fn (new, append_agent_message, create_config_toml, read_single_turn_items_view); 8 external calls (new, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, rollout_path, assert!, assert_eq!, timeout, vec!).


##### `thread_turns_list_reads_store_history_without_rollout_path`  (lines 357–422)

```
async fn thread_turns_list_reads_store_history_without_rollout_path() -> Result<()>
```

**Purpose**: Verifies that `thread/turns/list` can read history from the experimental in-memory thread store when a thread has no rollout path.

**Data flow**: The test creates a temp home, chooses a fixed `ThreadId`, writes config enabling an in-memory thread store id, obtains the store instance, keeps an `InMemoryThreadStoreId` guard alive, and seeds a pathless thread via `seed_pathless_store_thread`. It then builds config with `ConfigBuilder`, starts the app server in-process with explicit `InitializeParams`, sends a `ClientRequest::ThreadTurnsList`, deserializes the result into `ThreadTurnsListResponse`, and asserts the returned user texts equal `history from store`. Finally it shuts down the client.

**Call relations**: This is the first of the pathless-store tests and demonstrates the read path can fall back to thread-store history instead of rollout files.

*Call graph*: calls 9 internal fn (start, create_config_toml_with_thread_store, seed_pathless_store_thread, default, without_managed_config_for_tests, default_for_tests, new, from_string, for_id); 10 external calls (new, default, new, new_v4, new, Integer, default, assert_eq!, default, from_value).


##### `thread_read_loaded_include_turns_reads_store_history_without_rollout_path`  (lines 425–506)

```
async fn thread_read_loaded_include_turns_reads_store_history_without_rollout_path() -> Result<()>
```

**Purpose**: Checks that `thread/read` with `include_turns: true` can return history for a loaded pathless thread whose items live only in the in-memory thread store.

**Data flow**: It writes thread-store config, creates the store and guard, builds in-process server config, starts the client, sends `ClientRequest::ThreadStart` and asserts the returned thread has `path: None`, parses the thread id, appends `store_history_items()` directly into the store, then sends `ClientRequest::ThreadRead { include_turns: true }`. The decoded `ThreadReadResponse` is asserted to contain one turn whose user text is `history from store`, after which the client is shut down.

**Call relations**: This complements the previous store-history test by covering `thread/read` on a loaded pathless thread rather than `thread/turns/list` on a pre-seeded stored thread.

*Call graph*: calls 9 internal fn (start, create_config_toml_with_thread_store, store_history_items, default, without_managed_config_for_tests, default_for_tests, new, from_string, for_id); 10 external calls (new, default, new, new_v4, new, Integer, default, assert_eq!, default, from_value).


##### `thread_list_includes_store_thread_without_rollout_path`  (lines 509–585)

```
async fn thread_list_includes_store_thread_without_rollout_path() -> Result<()>
```

**Purpose**: Verifies that `thread/list` includes pathless threads sourced from the in-memory thread store and surfaces their stored name.

**Data flow**: The test writes thread-store config, seeds a pathless store thread with a fixed id and name, starts the app server in-process, sends `ClientRequest::ThreadList` with a broad limit and empty provider filter vector, deserializes `ThreadListResponse`, and asserts exactly one thread is returned with the expected id, `path: None`, empty preview, and `name = Some("named pathless thread")`. It then shuts down the client.

**Call relations**: This is the list-side counterpart to the pathless read tests and depends on `seed_pathless_store_thread` to populate metadata and history in the store.

*Call graph*: calls 9 internal fn (start, create_config_toml_with_thread_store, seed_pathless_store_thread, default, without_managed_config_for_tests, default_for_tests, new, from_string, for_id); 10 external calls (new, default, new, new_v4, new, Integer, default, assert_eq!, default, from_value).


##### `thread_read_can_return_archived_threads_by_id`  (lines 588–633)

```
async fn thread_read_can_return_archived_threads_by_id() -> Result<()>
```

**Purpose**: Checks that `thread/read` can locate a thread by id even after its rollout file has been moved into the archived sessions directory.

**Data flow**: It creates a rollout, moves the JSONL file from the active sessions tree into `ARCHIVED_SESSIONS_SUBDIR`, starts the server, sends `thread/read` with `include_turns: false`, decodes the response, and asserts the id and preview match the original thread while the returned path canonicalizes to the archived file location.

**Call relations**: This test covers archived lookup for direct reads by id, complementing archived filtering in the list suite.

*Call graph*: calls 2 internal fn (new, create_config_toml); 10 external calls (new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, rollout_path, assert_eq!, create_dir_all, rename, timeout, vec!).


##### `thread_resume_initial_turns_page_matches_requested_turns_list_page`  (lines 636–704)

```
async fn thread_resume_initial_turns_page_matches_requested_turns_list_page() -> Result<()>
```

**Purpose**: Verifies that `thread/resume` can return an `initial_turns_page` identical to what a standalone `thread/turns/list` request would return for the same parameters.

**Data flow**: The test creates a rollout with three user-message turns, starts the server, first requests `thread/turns/list` with ascending order, limit 2, and `items_view = NotLoaded`, storing the decoded page. It then sends `thread/resume` with `exclude_turns: true` and matching `initial_turns_page` parameters, decodes `ThreadResumeResponse`, asserts `thread.turns` is empty, and compares `initial_turns_page` against `TurnsPage::from(expected_page)`.

**Call relations**: This test links two APIs together, proving resume’s optional initial page is generated by the same paging logic as `thread/turns/list`.

*Call graph*: calls 3 internal fn (new, append_user_message, create_config_toml); 10 external calls (default, new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, rollout_path, assert!, assert_eq!, timeout, vec!).


##### `thread_turns_list_rejects_cursor_when_anchor_turn_is_rolled_back`  (lines 707–775)

```
async fn thread_turns_list_rejects_cursor_when_anchor_turn_is_rolled_back() -> Result<()>
```

**Purpose**: Checks that a previously issued turn cursor becomes invalid if the anchor turn is later removed by a rollback event.

**Data flow**: It creates a three-turn rollout, starts the server, requests a descending turns page to obtain `backwards_cursor`, appends a `thread_rolled_back` event removing one turn, then requests ascending from the old cursor. Instead of data, it reads a `JSONRPCError` and asserts the message is `invalid cursor: anchor turn is no longer present`.

**Call relations**: This is a cursor-stability regression test that uses `append_thread_rollback` to mutate history after cursor issuance.

*Call graph*: calls 4 internal fn (new, append_thread_rollback, append_user_message, create_config_toml); 8 external calls (new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, rollout_path, assert_eq!, timeout, vec!).


##### `thread_read_returns_forked_from_id_for_forked_threads`  (lines 778–825)

```
async fn thread_read_returns_forked_from_id_for_forked_threads() -> Result<()>
```

**Purpose**: Verifies that `thread/read` surfaces `forked_from_id` for threads created via `thread/fork`.

**Data flow**: The test creates a source rollout, starts the server, forks it, decodes the fork response to get the new thread id, then reads that thread with `include_turns: false` and asserts `thread.forked_from_id == Some(source_id)`.

**Call relations**: This ties the fork and read APIs together, ensuring fork lineage survives later reads.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (default, new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, assert_eq!, timeout, vec!).


##### `thread_read_loaded_thread_returns_precomputed_path_before_materialization`  (lines 828–874)

```
async fn thread_read_loaded_thread_returns_precomputed_path_before_materialization() -> Result<()>
```

**Purpose**: Checks that a newly started loaded thread exposes its precomputed rollout path through `thread/read` even before any file has been materialized on disk.

**Data flow**: It starts a fresh thread, captures `thread.path` from the `thread/start` response, asserts the path does not yet exist, then sends `thread/read` with `include_turns: false`. The decoded thread is asserted to have the same id, the same `Some(path)`, empty preview, zero turns, and idle status.

**Call relations**: This covers the loaded-but-unmaterialized read path and complements the later negative tests for requesting turns too early.

*Call graph*: calls 2 internal fn (new, create_config_toml); 7 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout).


##### `thread_name_set_is_reflected_in_read_list_and_resume`  (lines 877–1032)

```
async fn thread_name_set_is_reflected_in_read_list_and_resume() -> Result<()>
```

**Purpose**: Verifies that after `thread/name/set`, the new thread name is visible consistently through `thread/read`, `thread/list`, and `thread/resume`, and that wire payloads serialize both `name` and `ephemeral` fields correctly.

**Data flow**: The test seeds a stored rollout, starts the server, sends `thread/name/set`, decodes the success response, and waits for a `thread/name/updated` notification whose params are deserialized into `ThreadNameUpdatedNotification`. It then performs `thread/read`, captures both typed and raw JSON results, and asserts `thread.name` plus serialized `name` and `ephemeral: false`. Next it sends `thread/list`, finds the thread in both typed `data` and raw JSON `data` array, and asserts the same fields. Finally it sends `thread/resume`, checks the typed thread and raw JSON object for the same name and `ephemeral` serialization.

**Call relations**: This is the cross-endpoint consistency test for thread naming, chaining set-name, notification, read, list, and resume in one flow.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (default, new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, assert_eq!, from_value, timeout, vec!).


##### `thread_read_include_turns_rejects_unmaterialized_loaded_thread`  (lines 1035–1083)

```
async fn thread_read_include_turns_rejects_unmaterialized_loaded_thread() -> Result<()>
```

**Purpose**: Checks that `thread/read` with `include_turns: true` is rejected for a newly started thread before the first user message materializes a rollout.

**Data flow**: It starts a fresh thread, confirms the precomputed path does not exist, sends `thread/read` with `include_turns: true`, waits for a `JSONRPCError`, and asserts the message contains `includeTurns is unavailable before first user message`.

**Call relations**: This is the negative counterpart to the precomputed-path read test, proving summary reads are allowed before materialization but turn reads are not.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, timeout).


##### `thread_turns_list_rejects_unmaterialized_loaded_thread`  (lines 1086–1137)

```
async fn thread_turns_list_rejects_unmaterialized_loaded_thread() -> Result<()>
```

**Purpose**: Verifies that `thread/turns/list` is unavailable for a loaded thread before any user message has materialized history.

**Data flow**: The test starts a fresh thread, confirms its path does not exist, sends `thread/turns/list` with default pagination fields, waits for a `JSONRPCError`, and asserts the message contains `thread/turns/list is unavailable before first user message`.

**Call relations**: This complements the previous test by covering the dedicated turns-list endpoint rather than `thread/read include_turns`.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, timeout).


##### `thread_turns_items_list_returns_unsupported`  (lines 1140–1170)

```
async fn thread_turns_items_list_returns_unsupported() -> Result<()>
```

**Purpose**: Checks that the not-yet-implemented `thread/turns/items/list` method returns the expected method-not-found style error.

**Data flow**: It starts the server, sends `ThreadTurnsItemsListParams` with placeholder thread and turn ids, waits for a `JSONRPCError`, and asserts code `-32601` and message `thread/turns/items/list is not supported yet`.

**Call relations**: This is a pure protocol-surface regression test for an intentionally unsupported endpoint.

*Call graph*: calls 2 internal fn (new, create_config_toml); 5 external calls (new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_read_reports_system_error_idle_flag_after_failed_turn`  (lines 1173–1238)

```
async fn thread_read_reports_system_error_idle_flag_after_failed_turn() -> Result<()>
```

**Purpose**: Verifies that `thread/read` reports `ThreadStatus::SystemError` after a turn fails.

**Data flow**: The test mounts a mock SSE failure response, writes config, starts the server, creates a thread, starts a turn that fails, waits for the `error` notification, then sends `thread/read` with `include_turns: false` and asserts the returned thread status is `SystemError`.

**Call relations**: This mirrors the list-suite failed-turn status test but validates the read endpoint’s summary status field.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once, sse_failed, start_mock_server); 6 external calls (default, new, Integer, assert_eq!, timeout, vec!).


##### `append_user_message`  (lines 1240–1256)

```
fn append_user_message(path: &Path, timestamp: &str, text: &str) -> std::io::Result<()>
```

**Purpose**: Appends a synthetic user-message event line to an existing rollout JSONL file.

**Data flow**: It opens the given path in append mode and writes one JSON line containing the supplied timestamp and an `event_msg` payload of type `user_message` with the provided text, empty `text_elements`, and empty `local_images`.

**Call relations**: Pagination and resume-page tests call this helper to extend rollout history without going through the app server.

*Call graph*: called by 3 (thread_resume_initial_turns_page_matches_requested_turns_list_page, thread_turns_list_can_page_backward_and_forward, thread_turns_list_rejects_cursor_when_anchor_turn_is_rolled_back); 2 external calls (new, writeln!).


##### `append_agent_message`  (lines 1258–1274)

```
fn append_agent_message(path: &Path, timestamp: &str, text: &str) -> anyhow::Result<()>
```

**Purpose**: Appends a synthetic agent-message event line to a rollout JSONL file.

**Data flow**: It opens the file in append mode and writes one JSON line whose payload is `EventMsg::AgentMessage(AgentMessageEvent { message, phase: None, memory_citation: None })` serialized through `serde_json::to_value`.

**Call relations**: Only the items-view test uses this helper to create a turn containing multiple assistant messages.

*Call graph*: called by 1 (thread_turns_list_supports_requested_items_view); 2 external calls (new, writeln!).


##### `append_thread_rollback`  (lines 1276–1290)

```
fn append_thread_rollback(path: &Path, timestamp: &str, num_turns: u32) -> std::io::Result<()>
```

**Purpose**: Appends a synthetic thread-rollback event to a rollout JSONL file.

**Data flow**: It opens the file in append mode and writes one JSON line with the supplied timestamp and an `event_msg` payload of type `thread_rolled_back` carrying `num_turns`.

**Call relations**: The cursor-invalidation test uses this helper to remove the anchor turn after a cursor has been issued.

*Call graph*: called by 1 (thread_turns_list_rejects_cursor_when_anchor_turn_is_rolled_back); 2 external calls (new, writeln!).


##### `read_single_turn_items_view`  (lines 1292–1315)

```
async fn read_single_turn_items_view(
    mcp: &mut TestAppServer,
    thread_id: &str,
    items_view: Option<TurnItemsView>,
) -> anyhow::Result<codex_app_server_protocol::Turn>
```

**Purpose**: Fetches the first turn from `thread/turns/list` for a thread under a requested `TurnItemsView`, asserting exactly one turn is returned.

**Data flow**: It sends `ThreadTurnsListParams` with ascending sort, limit 10, and the supplied `items_view`, waits for the response, decodes `ThreadTurnsListResponse`, asserts `data.len() == 1`, removes and returns the sole `Turn`.

**Call relations**: The items-view test calls this helper three times to compare `Full`, `Summary`, and `NotLoaded` representations of the same turn.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_turns_list_request); called by 1 (thread_turns_list_supports_requested_items_view); 3 external calls (Integer, assert_eq!, timeout).


##### `turn_user_texts`  (lines 1317–1331)

```
fn turn_user_texts(turns: &[codex_app_server_protocol::Turn]) -> Vec<&str>
```

**Purpose**: Extracts the first user text from each returned turn for concise assertions in tests.

**Data flow**: It iterates over a slice of API `Turn`s, looks at each turn’s first item, matches `ThreadItem::UserMessage`, then matches the first `UserInput::Text` inside its content and collects the borrowed `text` strings. Non-text or non-user items are skipped.

**Call relations**: Several tests use this helper to compare turn ordering and presence without asserting the full nested item structure.

*Call graph*: 1 external calls (iter).


##### `turn_agent_texts`  (lines 1333–1342)

```
fn turn_agent_texts(turns: &[codex_app_server_protocol::Turn]) -> Vec<&str>
```

**Purpose**: Collects all assistant message texts from a slice of API turns.

**Data flow**: It iterates through all turns, flattens each turn’s `items`, matches `ThreadItem::AgentMessage`, and collects borrowed `text` strings from those items.

**Call relations**: The items-view test uses this helper to compare how many assistant messages are exposed under different `TurnItemsView` modes.

*Call graph*: 1 external calls (iter).


##### `InMemoryThreadStoreId::drop`  (lines 1349–1351)

```
fn drop(&mut self)
```

**Purpose**: Cleans up the globally registered in-memory thread store instance when the guard goes out of scope.

**Data flow**: On drop, it reads `self.store_id` and calls `InMemoryThreadStore::remove_id(&self.store_id)`, removing the named store from the global registry.

**Call relations**: The pathless-store tests keep an instance of this guard alive so the configured store exists during the test and is automatically deregistered afterward.

*Call graph*: calls 1 internal fn (remove_id).


##### `seed_pathless_store_thread`  (lines 1354–1393)

```
async fn seed_pathless_store_thread(
    store: &InMemoryThreadStore,
    thread_id: codex_protocol::ThreadId,
) -> Result<()>
```

**Purpose**: Creates a pathless thread directly in `InMemoryThreadStore`, appends one history item, and assigns it a stored name.

**Data flow**: It takes a store reference and `ThreadId`, calls `create_thread` with CLI source, no fork/parent ids, default base instructions, empty dynamic tools, no cwd, provider `test-provider`, and memory mode `Disabled`. It then appends `store_history_items()` and updates metadata with a `ThreadMetadataPatch` setting `name = Some(Some("named pathless thread"))` while allowing archived inclusion. It returns success after all three async store operations complete.

**Call relations**: The pathless `thread/list` and `thread/turns/list` tests call this helper to populate the in-memory store with a realistic thread that has both history and metadata.

*Call graph*: calls 5 internal fn (store_history_items, default, append_items, create_thread, update_thread_metadata); called by 2 (thread_list_includes_store_thread_without_rollout_path, thread_turns_list_reads_store_history_without_rollout_path); 2 external calls (default, new).


##### `store_history_items`  (lines 1395–1406)

```
fn store_history_items() -> Vec<RolloutItem>
```

**Purpose**: Builds the single rollout-history item used to seed pathless thread-store tests.

**Data flow**: It returns a one-element `Vec<RolloutItem>` containing `RolloutItem::EventMsg(EventMsg::UserMessage(UserMessageEvent { message: "history from store", ... }))` with no images or text elements.

**Call relations**: This helper is used by `seed_pathless_store_thread` and by the loaded pathless read test when appending history directly into the store.

*Call graph*: called by 2 (seed_pathless_store_thread, thread_read_loaded_include_turns_reads_store_history_without_rollout_path); 1 external calls (vec!).


##### `create_config_toml_with_thread_store`  (lines 1408–1430)

```
fn create_config_toml_with_thread_store(codex_home: &Path, store_id: &str) -> std::io::Result<()>
```

**Purpose**: Writes a config enabling the experimental in-memory thread store with a specific store id.

**Data flow**: It formats TOML containing model defaults, `experimental_thread_store = { type = "in_memory", id = "..." }`, `model_provider = "mock_provider"`, and a dummy provider block pointing at `http://127.0.0.1:1/v1`, then writes it to `config.toml`.

**Call relations**: All pathless-store tests call this helper so the in-process app server resolves thread operations through the named in-memory store.

*Call graph*: called by 3 (thread_list_includes_store_thread_without_rollout_path, thread_read_loaded_include_turns_reads_store_history_without_rollout_path, thread_turns_list_reads_store_history_without_rollout_path); 3 external calls (join, format!, write).


##### `create_config_toml`  (lines 1433–1454)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes the standard runtime config used by rollout-backed read tests.

**Data flow**: It joins `config.toml` under the temp home, formats TOML with model defaults and a mock provider block using the supplied server URI, and writes the file.

**Call relations**: Most tests in the file call this helper during setup before starting `TestAppServer`.

*Call graph*: called by 14 (thread_name_set_is_reflected_in_read_list_and_resume, thread_read_can_include_turns, thread_read_can_return_archived_threads_by_id, thread_read_include_turns_rejects_unmaterialized_loaded_thread, thread_read_loaded_thread_returns_precomputed_path_before_materialization, thread_read_reports_system_error_idle_flag_after_failed_turn, thread_read_returns_forked_from_id_for_forked_threads, thread_read_returns_summary_without_turns, thread_resume_initial_turns_page_matches_requested_turns_list_page, thread_turns_items_list_returns_unsupported (+4 more)); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/thread_resume.rs`

`test` · `request handling and persistence/resume flows`

This large integration test file builds realistic thread lifecycle scenarios around `TestAppServer`, temporary Codex homes, and mock Responses API servers. Most tests follow the same pattern: write a minimal `config.toml`, initialize the app server, create or synthesize a thread/rollout, issue JSON-RPC requests such as `thread/start`, `turn/start`, `thread/resume`, `thread/read`, `thread/goal/*`, and then assert on typed protocol responses and notifications. The file deliberately mixes two sources of persisted state: live threads materialized by a prior turn, and handcrafted rollout files created with helpers like `create_fake_rollout*` and then mutated directly by appending JSON lines or editing session metadata.

The coverage is unusually concrete. It verifies that resume fails before rollout materialization, that an empty `path` override resolves to the running thread’s own path, that cached instruction sources survive deletion of `AGENTS.md`, and that runtime workspace roots are normalized and deduplicated. It checks redaction rules for ChatGPT remote clients by asserting MCP arguments/results are replaced with `[redacted]` and image-generation items are dropped, while normal clients retain full payloads. Several tests inspect token-usage replay semantics, especially around interrupted tail turns, ensuring replay attaches to the last turn that actually emitted usage rather than any stale in-progress turn.

Goal-related tests validate persistence and resume semantics for paused, blocked, usage-limited, and budget-limited goals, including analytics emission and the invariant that editing an objective preserves accumulated usage and goal identity. Running-thread tests distinguish between rejoining an active in-memory thread versus loading from disk: history overrides are rejected while a thread is running, mismatched stale paths are rejected, but benign override mismatches are ignored when rejoining the active thread. Helper functions at the bottom create configs, manipulate rollout mtimes, and restart the server to prove that `updated_at` is not bumped merely by resume; only a subsequent `turn/start` should rewrite the rollout.

#### Function details

##### `normalized_existing_path`  (lines 114–116)

```
fn normalized_existing_path(path: impl AsRef<Path>) -> Result<PathBuf>
```

**Purpose**: Canonicalizes an existing filesystem path and converts it into the same absolute-path representation the server uses in protocol responses. The helper exists so path comparisons in tests are stable across platform-specific path spellings.

**Data flow**: It takes any `AsRef<Path>`, calls `canonicalize()` on the underlying path, wraps the result with `AbsolutePathBuf::from_absolute_path`, and returns the normalized `PathBuf`. It reads only the filesystem and produces no side effects beyond possible I/O errors.

**Call relations**: This helper is used by `thread_resume_defers_updated_at_until_turn_start` when resuming by explicit rollout path, so the test can compare the returned path against the on-disk rollout path without being tripped up by equivalent but differently formatted absolute paths.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 1 (thread_resume_defers_updated_at_until_turn_start); 1 external calls (as_ref).


##### `wait_for_responses_request_count`  (lines 118–146)

```
async fn wait_for_responses_request_count(
    server: &wiremock::MockServer,
    expected_count: usize,
) -> Result<()>
```

**Purpose**: Polls a `wiremock::MockServer` until it has observed exactly the expected number of POST requests to `/responses`. It turns asynchronous model traffic into a deterministic synchronization point for approval-replay tests.

**Data flow**: It reads the mock server’s recorded requests in a loop, filters them to POSTs whose URL path ends with `/responses`, counts them, and returns `Ok(())` once the count matches `expected_count`. If the count exceeds the target or the server cannot provide recorded requests, it bails with an error; otherwise it sleeps briefly between polls under an outer timeout.

**Call relations**: The helper is invoked after replaying pending command/file-change approvals in `thread_resume_replays_pending_command_execution_request_approval` and `thread_resume_replays_pending_file_change_request_approval` to prove the resumed turn continued all the way through the expected sequence of model calls.

*Call graph*: called by 2 (thread_resume_replays_pending_command_execution_request_approval, thread_resume_replays_pending_file_change_request_approval); 5 external calls (received_requests, bail!, from_millis, sleep, timeout).


##### `thread_resume_rejects_unmaterialized_thread`  (lines 149–193)

```
async fn thread_resume_rejects_unmaterialized_thread() -> Result<()>
```

**Purpose**: Verifies that a newly started persistent thread cannot be resumed until its first user turn has created rollout storage on disk.

**Data flow**: The test creates config and server fixtures, starts a thread with `thread/start`, extracts the returned thread id, then sends `thread/resume` for that id. It reads the resulting JSON-RPC error and asserts the message mentions that no rollout was found.

**Call relations**: This is a direct top-level integration test: it drives `thread/start` first to create an in-memory thread, then immediately exercises `thread/resume` under the specific condition that no turn has yet materialized persistence.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, timeout).


##### `thread_resume_with_empty_path_uses_running_thread_id`  (lines 196–258)

```
async fn thread_resume_with_empty_path_uses_running_thread_id() -> Result<()>
```

**Purpose**: Checks that when resuming a currently loaded thread, an explicitly empty `path` override does not break lookup and the server still resolves the thread by its running id.

**Data flow**: It starts a thread, runs one turn to materialize rollout storage, waits for `turn/completed`, then sends `thread/resume` with the same `thread_id`, `path: Some(PathBuf::new())`, and `exclude_turns: true`. It parses the `ThreadResumeResponse` and asserts the resumed thread id matches the original.

**Call relations**: The test first establishes a materialized running thread, then exercises the resume path that should prefer the active thread identity over an unusable empty path override.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (default, new, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout, vec!).


##### `thread_resume_running_thread_uses_cached_instruction_sources`  (lines 261–334)

```
async fn thread_resume_running_thread_uses_cached_instruction_sources() -> Result<()>
```

**Purpose**: Ensures a running thread keeps the instruction-source paths captured at start time even if the underlying instruction files are later deleted.

**Data flow**: It creates a workspace with `AGENTS.md`, starts a thread with that `cwd`, captures `instruction_sources` from `ThreadStartResponse`, runs a turn to materialize the thread, deletes the `AGENTS.md` file, then resumes the thread and asserts the same absolute instruction-source path is still returned.

**Call relations**: The test depends on `thread/start` caching instruction sources and `thread/resume` reusing that cached state for loaded threads instead of re-scanning the filesystem.

*Call graph*: calls 3 internal fn (new, create_config_toml, try_from); 9 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, remove_file, write, timeout, vec!).


##### `turn_start_updates_runtime_workspace_roots_for_loaded_thread`  (lines 337–411)

```
async fn turn_start_updates_runtime_workspace_roots_for_loaded_thread() -> Result<()>
```

**Purpose**: Verifies that runtime workspace roots supplied on a later turn become part of the loaded thread state and are normalized/deduplicated before being returned by resume.

**Data flow**: After starting a thread, it sends `turn/start` with two equivalent absolute roots (`extra-root` and `extra-root/.`), waits for completion, then resumes with `exclude_turns: true`. The response’s `runtime_workspace_roots` is asserted to contain a single normalized absolute path.

**Call relations**: This test uses `turn/start` as the state mutation point and `thread/resume` as the readback path, proving that loaded-thread runtime roots are updated by turns rather than fixed at thread creation.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, create_dir_all, timeout, vec!).


##### `thread_goal_get_rejects_unmaterialized_thread`  (lines 414–465)

```
async fn thread_goal_get_rejects_unmaterialized_thread() -> Result<()>
```

**Purpose**: Confirms that goal APIs reject ephemeral/unmaterialized threads that do not support persisted goals.

**Data flow**: It edits the generated config to enable goals, starts an ephemeral thread, then sends a raw `thread/goal/get` request for that thread id. It reads the JSON-RPC error and asserts the message says ephemeral threads do not support goals.

**Call relations**: The test uses `new_without_managed_config` because it mutates config directly, then probes the goal subsystem immediately after `thread/start` under the unsupported ephemeral-thread condition.

*Call graph*: calls 2 internal fn (new_without_managed_config, create_config_toml); 9 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, json!, read_to_string, write, timeout).


##### `thread_resume_tracks_thread_initialized_analytics`  (lines 468–523)

```
async fn thread_resume_tracks_thread_initialized_analytics() -> Result<()>
```

**Purpose**: Checks that resuming a persisted rollout emits the analytics event used for thread initialization, tagged as a resumed thread and preserving thread source metadata.

**Data flow**: It writes config with analytics capture, creates a fake rollout, mutates its session-meta line to include `thread_source`, resumes that thread, asserts the returned thread has a non-empty `session_id` and expected `thread_source`, then waits for the analytics payload and validates fields such as thread id, session id, model, lifecycle mode `resumed`, and source `user`.

**Call relations**: This test composes local rollout mutation via `set_thread_source_on_fake_rollout` with analytics helpers from the sibling module, proving that `thread/resume` triggers the same initialization telemetry pipeline as thread creation but with resumed-specific values.

*Call graph*: calls 7 internal fn (new_without_managed_config, assert_basic_thread_initialized_event, mount_analytics_capture, thread_initialized_event, wait_for_analytics_payload, create_config_toml_with_chatgpt_base_url, set_thread_source_on_fake_rollout); 8 external calls (default, new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout).


##### `set_thread_source_on_fake_rollout`  (lines 525–542)

```
fn set_thread_source_on_fake_rollout(
    codex_home: &std::path::Path,
    filename_ts: &str,
    thread_id: &str,
    thread_source: &str,
) -> Result<()>
```

**Purpose**: Edits the first line of a fake rollout file so its persisted session metadata contains a chosen `thread_source` string.

**Data flow**: Given `codex_home`, timestamped filename, thread id, and source string, it locates the rollout path, reads the file, parses the first line as JSON, writes `payload.thread_source`, rejoins the remaining lines, and rewrites the file. It returns an error if the file is empty or malformed.

**Call relations**: This helper is only used by `thread_resume_tracks_thread_initialized_analytics` to seed persisted metadata that the resume path should surface both in the response and in analytics.

*Call graph*: called by 1 (thread_resume_tracks_thread_initialized_analytics); 6 external calls (rollout_path, format!, from_str, json!, read_to_string, write).


##### `thread_resume_returns_rollout_history`  (lines 545–616)

```
async fn thread_resume_returns_rollout_history() -> Result<()>
```

**Purpose**: Validates the basic disk-backed resume contract: persisted rollout metadata and turn history are reconstructed into the protocol thread model.

**Data flow**: It creates a fake rollout containing a saved user message with serialized `TextElement`s, resumes it, and asserts concrete fields on the returned thread: id, preview, model provider, absolute path, cwd `/`, CLI version, source `Cli`, no git info, idle status, one completed turn, and one `ThreadItem::UserMessage` whose `UserInput::Text` content matches the saved preview and text elements.

**Call relations**: This is the canonical persisted-history test for `thread/resume`; later tests build on the same fake-rollout pattern to check redaction, token usage, interrupted turns, and metadata-only resumes.

*Call graph*: calls 2 internal fn (new, create_config_toml); 10 external calls (default, new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, panic!, timeout, vec!).


##### `thread_resume_redacts_payloads_for_chatgpt_remote_clients`  (lines 619–716)

```
async fn thread_resume_redacts_payloads_for_chatgpt_remote_clients() -> Result<()>
```

**Purpose**: Asserts client-specific privacy filtering during resume: ChatGPT remote clients receive redacted MCP payloads and no image-generation items, while ordinary clients receive the original persisted data.

**Data flow**: It runs `resume_redaction_fixture` for Android/iOS remote client names and inspects both the main thread turns and the optional initial-turns page. For each, it finds the `ThreadItem::McpToolCall`, checks `arguments` became `"[redacted]"`, result text became `[redacted]`, structured/meta fields were removed, and image-generation items are absent. It then runs the same fixture for a non-remote client and asserts the original secret arguments, result content, structured content, meta, and image-generation payload remain intact.

**Call relations**: This top-level test delegates setup to `resume_redaction_fixture`, which in turn appends sensitive MCP and image-generation events. The assertions prove that redaction happens in the resume serialization layer, not in persisted storage.

*Call graph*: calls 1 internal fn (resume_redaction_fixture); 3 external calls (assert!, assert_eq!, unreachable!).


##### `resume_redaction_fixture`  (lines 718–772)

```
async fn resume_redaction_fixture(client_name: Option<&str>) -> Result<ThreadResumeResponse>
```

**Purpose**: Builds a persisted rollout containing sensitive MCP and image-generation history, initializes the app server with an optional client identity, and resumes the thread with a full initial-turns page.

**Data flow**: It creates config and a fake rollout, appends extra history via `append_resume_redaction_history`, initializes `TestAppServer` either normally or with `ClientInfo`, sends `thread/resume` requesting `initial_turns_page` with `TurnItemsView::Full`, and returns the parsed `ThreadResumeResponse`.

**Call relations**: This helper is the common setup path for `thread_resume_redacts_payloads_for_chatgpt_remote_clients`, allowing that test to compare remote-client and normal-client resume behavior against identical persisted history.

*Call graph*: calls 3 internal fn (new, append_resume_redaction_history, create_config_toml); called by 1 (thread_resume_redacts_payloads_for_chatgpt_remote_clients); 6 external calls (default, new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, timeout).


##### `append_resume_redaction_history`  (lines 774–827)

```
fn append_resume_redaction_history(
    codex_home: &Path,
    filename_ts: &str,
    meta_rfc3339: &str,
    conversation_id: &str,
) -> Result<()>
```

**Purpose**: Appends concrete persisted events representing an MCP tool call result and an image-generation result, both containing sensitive payloads that later tests expect to be redacted or preserved.

**Data flow**: It reads the existing rollout file, constructs `EventMsg::McpToolCallEnd` with secret arguments/result/structured/meta fields and `EventMsg::ImageGenerationEnd` with a secret revised prompt and base64 result, serializes them as newline-delimited rollout JSON entries, and rewrites the file with the appended lines.

**Call relations**: Used only by `resume_redaction_fixture`, this helper seeds the exact persisted items that the resume path must transform differently depending on client type.

*Call graph*: called by 1 (resume_redaction_fixture); 10 external calls (from_millis, rollout_path, test_absolute_path, format!, json!, ImageGenerationEnd, McpToolCallEnd, read_to_string, write, vec!).


##### `thread_resume_can_skip_turns_for_metadata_only_resume`  (lines 830–866)

```
async fn thread_resume_can_skip_turns_for_metadata_only_resume() -> Result<()>
```

**Purpose**: Checks the `exclude_turns` optimization for disk-backed resumes, where callers want thread metadata without loading historical turns.

**Data flow**: It creates a fake rollout, resumes it with `exclude_turns: true`, parses the response, and asserts the thread id matches while `thread.turns` is empty.

**Call relations**: This test isolates the metadata-only branch of `thread/resume`; related token-usage tests later verify that excluding turns also suppresses token-usage replay.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (default, new, new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout).


##### `thread_resume_rejects_archived_session_by_id`  (lines 869–917)

```
async fn thread_resume_rejects_archived_session_by_id() -> Result<()>
```

**Purpose**: Verifies that resuming by thread id refuses archived sessions and returns a user-facing message that points to the unarchive command.

**Data flow**: It creates a fake rollout, physically moves the rollout file into the archived sessions directory, initializes the server, sends `thread/resume` by the original id, reads the JSON-RPC error, and asserts the message mentions both that the session is archived and the `codex unarchive <id>` remediation.

**Call relations**: This test exercises the path-resolution branch of resume that searches active sessions by id and must detect archived matches rather than silently loading them.

*Call graph*: calls 2 internal fn (new, create_config_toml); 11 external calls (default, new, new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, rollout_path, assert!, create_dir_all, rename (+1 more)).


##### `thread_resume_keeps_paused_goal_paused`  (lines 920–1022)

```
async fn thread_resume_keeps_paused_goal_paused() -> Result<()>
```

**Purpose**: Ensures resuming a thread with a paused persisted goal does not automatically continue work; the goal remains paused and no new turn starts.

**Data flow**: After enabling goals, starting and materializing a thread, it sends `thread/goal/set` with objective `keep polishing` and status `paused`, waits for the update notification, clears buffered messages, resumes the thread, then reads the next `thread/goal/updated` notification and asserts the goal status is still `Paused`. It also checks there is no pending `turn/started` notification.

**Call relations**: The test uses `thread/goal/set` to persist paused state, then `thread/resume` to verify the resume path republishes goal state without triggering continuation logic reserved for active goals.

*Call graph*: calls 2 internal fn (new_without_managed_config, create_config_toml); 13 external calls (default, new, bail!, Integer, create_mock_responses_server_repeating_assistant, to_response, assert!, assert_eq!, json!, read_to_string (+3 more)).


##### `thread_goal_set_preserves_budget_limited_same_objective`  (lines 1025–1121)

```
async fn thread_goal_set_preserves_budget_limited_same_objective() -> Result<()>
```

**Purpose**: Checks that re-setting the same objective without an explicit status does not reset a budget-limited goal back to active or clear its budget accounting fields.

**Data flow**: It enables goals, materializes a thread, sets a goal with status `budgetLimited` and `tokenBudget: 10`, confirms the first response and notification, then sends another `thread/goal/set` with the same objective only. The replacement response is asserted to remain `BudgetLimited` with the same token budget and zeroed usage counters.

**Call relations**: This test focuses on the goal-update merge logic inside `thread/goal/set`, specifically the branch where the objective is unchanged and resumable stopped status should be preserved.

*Call graph*: calls 2 internal fn (new_without_managed_config, create_config_toml); 11 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, to_response, assert_eq!, json!, read_to_string, write, timeout (+1 more)).


##### `thread_goal_set_persists_resumable_stopped_statuses`  (lines 1124–1208)

```
async fn thread_goal_set_persists_resumable_stopped_statuses() -> Result<()>
```

**Purpose**: Verifies that additional resumable stopped statuses—`blocked` and `usageLimited`—round-trip through `thread/goal/set` and notification emission.

**Data flow**: After enabling goals and materializing a thread, it iterates over wire statuses `blocked` and `usageLimited`, sends `thread/goal/set` for each, parses the response into `ThreadGoalSetResponse`, and then parses the subsequent `thread/goal/updated` notification, asserting both carry the expected enum variant.

**Call relations**: This test complements the paused/budget-limited cases by proving the server’s wire-to-enum mapping and persistence logic handle all resumable stopped statuses consistently.

*Call graph*: calls 2 internal fn (new_without_managed_config, create_config_toml); 12 external calls (default, new, bail!, Integer, create_mock_responses_server_repeating_assistant, to_response, assert_eq!, json!, read_to_string, write (+2 more)).


##### `thread_goal_set_edits_objective_without_resetting_usage`  (lines 1211–1317)

```
async fn thread_goal_set_edits_objective_without_resetting_usage() -> Result<()>
```

**Purpose**: Proves that editing a goal’s objective text preserves the same persisted goal record and accumulated usage, while status may transition to budget-limited if the budget has already been exceeded.

**Data flow**: It enables goals, creates a fake rollout, sets an active goal with token budget 40, then opens `StateRuntime`, fetches the persisted thread metadata and goal, manually accounts 12 seconds and 50 tokens against that goal, and sends another `thread/goal/set` with revised objective text. It then re-reads the goal and thread metadata from state and asserts the goal id and created_at are unchanged, preview remains the original preview, objective text updates, status becomes `BudgetLimited`, and usage counters remain 50 tokens / 12 seconds.

**Call relations**: Unlike most tests, this one reaches into `StateRuntime` directly to seed and inspect persisted goal accounting, then uses the public JSON-RPC API to verify that editing objective text is an in-place update rather than a reset.

*Call graph*: calls 4 internal fn (new_without_managed_config, create_config_toml, from_string, init); 10 external calls (new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, to_response, assert_eq!, json!, read_to_string, write, timeout).


##### `thread_goal_lifecycle_emits_analytics_and_clear_deletes_goal`  (lines 1320–1511)

```
async fn thread_goal_lifecycle_emits_analytics_and_clear_deletes_goal() -> Result<()>
```

**Purpose**: Covers the full persisted goal lifecycle—creation, automatic usage accounting after continuation, status transition to budget-limited, clearing, and idempotent clear—while asserting analytics payload shape and redaction.

**Data flow**: It mounts a two-response mock sequence, enables goals and analytics, starts and materializes a thread, sets a goal with a token budget, waits for `thread/goal/updated`, then waits for analytics events `created`, `usage_accounted`, and `status_changed`, asserting fields like `goal_id`, `thread_id`, `turn_id`, cumulative token/time accounting, and that sensitive fields such as objective and token budget are omitted from analytics. It then clears the goal, checks `thread/goal/cleared`, verifies a `cleared` analytics event, confirms `thread/goal/get` returns `None`, and confirms a second clear reports `cleared: false`.

**Call relations**: This is the most comprehensive goal test in the file, tying together model execution, goal continuation, analytics capture, and deletion semantics through the public API.

*Call graph*: calls 4 internal fn (new_without_managed_config, mount_analytics_capture, wait_for_goal_event, create_config_toml_with_chatgpt_base_url); 12 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert!, assert_eq!, json!, read_to_string, write (+2 more)).


##### `thread_resume_emits_restored_token_usage_before_next_turn`  (lines 1514–1564)

```
async fn thread_resume_emits_restored_token_usage_before_next_turn() -> Result<()>
```

**Purpose**: Ensures that resuming a persisted thread with saved token-usage events immediately replays a `thread/tokenUsage/updated` notification before any new turn starts.

**Data flow**: It creates a fake rollout containing token-usage history, resumes it, then waits for `thread/tokenUsage/updated`, parses the notification, and asserts the thread id, turn id, total and last token counts, cached input tokens, reasoning output tokens, and model context window match the persisted values.

**Call relations**: This test establishes the baseline token-usage replay behavior that later tests refine for `exclude_turns` and interrupted-turn edge cases.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (default, new, Integer, create_fake_rollout_with_token_usage, create_mock_responses_server_repeating_assistant, assert_eq!, panic!, timeout).


##### `thread_resume_skips_restored_token_usage_when_turns_are_excluded`  (lines 1567–1638)

```
async fn thread_resume_skips_restored_token_usage_when_turns_are_excluded() -> Result<()>
```

**Purpose**: Checks that metadata-only resume does not replay token-usage notifications, because there is no loaded turn context to attach them to.

**Data flow**: It first resumes a token-usage rollout normally and confirms one replayed notification for the expected turn id. It then resumes the same thread again with `exclude_turns: true`, asserts the returned thread has no turns, and verifies that waiting for another `thread/tokenUsage/updated` times out.

**Call relations**: This test directly contrasts the normal replay path with the `exclude_turns` branch, proving the server suppresses token-usage replay when turn history is intentionally omitted.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (default, new, Integer, create_fake_rollout_with_token_usage, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, panic!, timeout).


##### `thread_resume_token_usage_replay_ignores_stale_interrupted_tail_turn`  (lines 1641–1726)

```
async fn thread_resume_token_usage_replay_ignores_stale_interrupted_tail_turn() -> Result<()>
```

**Purpose**: Verifies that token-usage replay ignores a later stale in-progress/interrupted tail turn if that tail turn never emitted token-usage data.

**Data flow**: It creates a rollout with token usage, appends a later `TurnStarted` plus `AgentMessage` for a stale turn but no `TokenCount`, resumes the thread, asserts the resumed thread contains a completed first turn and an interrupted second turn, then reads the replayed token-usage notification and checks it still points to the first turn id rather than the stale interrupted tail turn.

**Call relations**: This test mutates the rollout file directly to create a subtle persistence edge case and then validates the resume logic that chooses which turn should own restored token usage.

*Call graph*: calls 2 internal fn (new, create_config_toml); 14 external calls (default, new, Integer, create_fake_rollout_with_token_usage, create_mock_responses_server_repeating_assistant, rollout_path, assert_eq!, assert_ne!, format!, json! (+4 more)).


##### `thread_resume_token_usage_replay_can_belong_to_interrupted_turn`  (lines 1729–1849)

```
async fn thread_resume_token_usage_replay_can_belong_to_interrupted_turn() -> Result<()>
```

**Purpose**: Checks the opposite edge case: if an interrupted turn did emit token usage before aborting, replay should attach to that interrupted turn rather than an earlier completed one.

**Data flow**: It appends a second turn containing `TurnStarted`, `AgentMessage`, `TokenCount` with larger totals, and `TurnAborted(Interrupted)` to a rollout that already has token usage. After resume, it asserts the second turn is interrupted and then verifies the replayed token-usage notification references that interrupted turn id and the newer total/last token counts.

**Call relations**: Together with the previous test, this one defines the invariant for replay ownership: use the latest turn that actually produced token-usage info, even if that turn ended interrupted.

*Call graph*: calls 2 internal fn (new, create_config_toml); 13 external calls (default, new, Integer, create_fake_rollout_with_token_usage, create_mock_responses_server_repeating_assistant, rollout_path, assert_eq!, format!, json!, panic! (+3 more)).


##### `thread_resume_prefers_persisted_git_metadata_for_local_threads`  (lines 1852–2043)

```
async fn thread_resume_prefers_persisted_git_metadata_for_local_threads() -> Result<()>
```

**Purpose**: Ensures resume returns git metadata persisted in thread metadata/state rather than recomputing live repository state from the current checkout.

**Data flow**: The test creates a real git repo on `master`, writes a rollout whose session meta points at that repo, initializes `StateRuntime`, marks backfill complete, updates thread metadata through `thread/metadata/update` to set branch `feature/pr-branch`, then resumes the thread and asserts the returned `thread.git_info.branch` is `feature/pr-branch` instead of the live repo HEAD branch.

**Call relations**: This test combines handcrafted rollout creation, direct state-db setup, and a metadata update request to prove that resume prefers persisted metadata overlays for local threads.

*Call graph*: calls 3 internal fn (new, from_string, init); 14 external calls (default, new, new_v4, Integer, create_mock_responses_server_repeating_assistant, rollout_path, assert!, assert_eq!, new, format! (+4 more)).


##### `thread_resume_and_read_interrupt_incomplete_rollout_turn_when_thread_is_idle`  (lines 2046–2161)

```
async fn thread_resume_and_read_interrupt_incomplete_rollout_turn_when_thread_is_idle() -> Result<()>
```

**Purpose**: Verifies that both `thread/resume` and `thread/read` normalize an incomplete persisted tail turn into `Interrupted` when the thread is otherwise idle.

**Data flow**: It creates a rollout with one completed turn, appends an incomplete second turn (`TurnStarted` plus `AgentMessage` only), resumes it and asserts thread status `Idle` with the second turn marked `Interrupted`, resumes again to ensure the normalization is stable, then calls `thread/read` with `include_turns: true` and asserts the same interrupted status is returned.

**Call relations**: This test checks consistency across two read paths—resume and read—after the server has already interpreted an incomplete persisted turn once.

*Call graph*: calls 2 internal fn (new, create_config_toml); 13 external calls (default, new, new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, rollout_path, assert_eq!, format!, json! (+3 more)).


##### `thread_resume_defers_updated_at_until_turn_start`  (lines 2164–2260)

```
async fn thread_resume_defers_updated_at_until_turn_start() -> Result<()>
```

**Purpose**: Proves that merely loading or resuming a thread does not rewrite the rollout file or bump `updated_at`; only a subsequent turn should do that.

**Data flow**: Using `setup_rollout_fixture`, it reads the thread before resume, resumes it and asserts `updated_at` is unchanged and the rollout file modification time is identical to the pre-test value. It then unsubscribes, resumes again by explicit path with an invalid thread id and explicit cwd override, asserts the returned cwd reflects the override, starts a new turn, waits for completion, and finally asserts the rollout file modification time is now newer than before.

**Call relations**: This test uses `normalized_existing_path` and `setup_rollout_fixture` to create a controlled persisted thread, then exercises both id-based and path-based resume branches before proving that only `turn/start` causes persistence writes.

*Call graph*: calls 3 internal fn (new, normalized_existing_path, setup_rollout_fixture); 9 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, metadata, timeout, vec!).


##### `thread_resume_keeps_in_flight_turn_streaming`  (lines 2263–2356)

```
async fn thread_resume_keeps_in_flight_turn_streaming() -> Result<()>
```

**Purpose**: Checks that a second client can resume a thread while another client has an in-flight turn, without disrupting the original stream or forcing the thread into `NotLoaded`.

**Data flow**: A primary client starts and seeds a thread, then starts a second turn and waits for `turn/started`. A secondary client initializes separately, resumes the same thread id, parses the response, and asserts the resumed thread status is anything except `NotLoaded`. The primary client then continues to receive `turn/completed` normally.

**Call relations**: This test exercises the multi-subscriber running-thread path: `thread/resume` should attach to the active in-memory thread while preserving the original turn stream.

*Call graph*: calls 2 internal fn (new, create_config_toml); 7 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_ne!, timeout, vec!).


##### `thread_resume_rejects_history_when_thread_is_running`  (lines 2359–2475)

```
async fn thread_resume_rejects_history_when_thread_is_running() -> Result<()>
```

**Purpose**: Verifies that callers cannot inject replacement history into a thread that is already running in memory.

**Data flow**: It starts a thread, seeds one completed turn, starts a delayed second turn so the thread remains running, then sends `thread/resume` with a `history` override containing a synthetic user message. It reads the JSON-RPC error and asserts the message mentions that a running thread cannot be resumed with history, then interrupts the running turn for cleanup.

**Call relations**: The test specifically targets the running-thread rejoin branch, where the server should ignore benign overrides but reject history replacement because it would conflict with active in-memory state.

*Call graph*: calls 7 internal fn (new, create_config_toml, mount_response_once, mount_sse_once, sse, sse_response, start_mock_server); 8 external calls (default, new, Integer, assert!, assert_eq!, from_millis, timeout, vec!).


##### `thread_resume_rejects_mismatched_path_for_running_thread_id`  (lines 2478–2643)

```
async fn thread_resume_rejects_mismatched_path_for_running_thread_id() -> Result<()>
```

**Purpose**: Checks path validation when rejoining a running thread: equivalent normalized paths are accepted, but a stale rollout path for a different thread is rejected.

**Data flow**: It starts and seeds a thread, begins a delayed running turn, and on Windows first verifies that an equivalent path spelling still resumes successfully. It then creates a separate stale rollout file for another UUID and sends `thread/resume` using the active thread id plus that stale path. The resulting error is asserted to mention `stale path`, and the running turn is interrupted for cleanup.

**Call relations**: This test covers the running-thread path-override guardrails: the server may normalize equivalent paths, but it must reject a path that points at different persisted history than the active thread id.

*Call graph*: calls 7 internal fn (new, create_config_toml, mount_response_once, mount_sse_once, sse, sse_response, start_mock_server); 17 external calls (default, from, new, new_v4, parse_str, Integer, rollout_path, assert!, assert_eq!, format! (+7 more)).


##### `thread_resume_rejoins_running_thread_even_with_override_mismatch`  (lines 2646–2778)

```
async fn thread_resume_rejoins_running_thread_even_with_override_mismatch() -> Result<()>
```

**Purpose**: Ensures that when a thread is actively running, resume rejoins the in-memory thread and ignores mismatched non-history overrides such as model or cwd.

**Data flow**: After starting, seeding, and then running a delayed second turn, it sends `thread/resume` with intentionally wrong `model`, `cwd`, and an `initial_turns_page` request. The response is asserted to report the actual running model `gpt-5.4`, include an initial turns page whose first turn is the running turn with `items_view: Summary` and `status: InProgress`, and show thread status either active or already idle if the queued resume raced with turn completion.

**Call relations**: This test complements the previous rejection cases by showing which overrides are intentionally ignored when the server rejoins an active thread listener instead of loading from disk.

*Call graph*: calls 6 internal fn (new, create_config_toml, mount_response_sequence, sse, sse_response, start_mock_server); 9 external calls (default, new, Integer, assert!, assert_eq!, panic!, from_millis, timeout, vec!).


##### `thread_resume_can_skip_turns_when_thread_is_running`  (lines 2781–2857)

```
async fn thread_resume_can_skip_turns_when_thread_is_running() -> Result<()>
```

**Purpose**: Verifies that `exclude_turns: true` also works when resuming a thread that is currently loaded/running in memory, returning metadata only.

**Data flow**: It starts and completes one turn on a thread, initializes a second client, resumes the thread with `exclude_turns: true`, and asserts the returned thread id matches, status is `Idle`, and `turns` is empty.

**Call relations**: This test covers the loaded-thread branch of metadata-only resume, complementing the earlier disk-backed `exclude_turns` test.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once, sse, start_mock_server); 7 external calls (default, new, Integer, assert!, assert_eq!, timeout, vec!).


##### `thread_resume_replays_pending_command_execution_request_approval`  (lines 2860–2995)

```
async fn thread_resume_replays_pending_command_execution_request_approval() -> Result<()>
```

**Purpose**: Checks that if a resumed running turn is blocked on command-execution approval, the server replays the exact pending approval request to the client so the turn can continue.

**Data flow**: It seeds a thread, starts a second turn whose model output requests a shell command under `AskForApproval::UnlessTrusted`, captures the original `ServerRequest::CommandExecutionRequestApproval`, resumes the thread, asserts the resumed thread still has an in-progress turn, then reads the replayed approval request and asserts it equals the original. After sending an accept response, it waits for `turn/completed` and uses `wait_for_responses_request_count` to confirm all three expected model requests occurred.

**Call relations**: This test depends on `wait_for_responses_request_count` for final synchronization and proves that resume rehydrates pending interactive approval state, not just passive thread history.

*Call graph*: calls 3 internal fn (new, create_config_toml, wait_for_responses_request_count); 11 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, assert!, assert_eq!, panic!, assert_eq!, to_value, timeout (+1 more)).


##### `thread_resume_replays_pending_file_change_request_approval`  (lines 2998–3163)

```
async fn thread_resume_replays_pending_file_change_request_approval() -> Result<()>
```

**Purpose**: Verifies the analogous replay behavior for pending file-change approvals generated by an `apply_patch` tool call.

**Data flow**: It seeds a thread in a workspace, starts a second turn that emits an apply-patch request under approval, waits for the `item/started` notification describing a `ThreadItem::FileChange`, captures the original `ServerRequest::FileChangeRequestApproval`, clears buffered messages, resumes the thread, asserts an in-progress turn is present, then reads the replayed approval request and checks it matches the original. After sending an accept response, it waits for completion and confirms the expected number of `/responses` requests.

**Call relations**: This test mirrors the command-approval replay path but for file changes, proving resume restores both the visible in-progress item and the blocked approval request.

*Call graph*: calls 3 internal fn (new, create_config_toml, wait_for_responses_request_count); 12 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, assert!, assert_eq!, panic!, from_value, to_value, create_dir (+2 more)).


##### `thread_resume_with_overrides_defers_updated_at_until_turn_start`  (lines 3166–3230)

```
async fn thread_resume_with_overrides_defers_updated_at_until_turn_start() -> Result<()>
```

**Purpose**: Confirms that even when resume includes overrides such as a new model, it still does not bump `updated_at` or touch the rollout file until a new turn starts.

**Data flow**: Using `start_materialized_thread_and_restart`, it gets a persisted thread and restarted server, manually sets the rollout mtime to a known timestamp, records the file modification time, resumes with a model override, and asserts the returned thread keeps the old `updated_at` and idle status while the file mtime is unchanged. It then starts a turn and asserts the file mtime increases.

**Call relations**: This is the override-specific counterpart to `thread_resume_defers_updated_at_until_turn_start`, using the restart helper and `set_rollout_mtime` to prove overrides alone do not rewrite persistence.

*Call graph*: calls 3 internal fn (create_config_toml, set_rollout_mtime, start_materialized_thread_and_restart); 9 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, metadata, timeout, vec!).


##### `thread_resume_fails_when_required_mcp_server_fails_to_initialize`  (lines 3233–3268)

```
async fn thread_resume_fails_when_required_mcp_server_fails_to_initialize() -> Result<()>
```

**Purpose**: Checks that resume fails early if the thread configuration requires an MCP server that cannot be started.

**Data flow**: It creates a persisted rollout fixture, writes config containing a required broken MCP server command, initializes the app server, sends `thread/resume`, reads the JSON-RPC error, and asserts the message mentions required MCP server initialization failure and the specific server name `required_broken`.

**Call relations**: This test reuses `setup_rollout_fixture` but changes config to force MCP startup failure, proving resume performs required MCP initialization before returning a loaded thread.

*Call graph*: calls 3 internal fn (new, create_config_toml_with_required_broken_mcp, setup_rollout_fixture); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, timeout).


##### `thread_resume_surfaces_cloud_config_bundle_load_errors`  (lines 3271–3360)

```
async fn thread_resume_surfaces_cloud_config_bundle_load_errors() -> Result<()>
```

**Purpose**: Verifies that resume surfaces structured cloud-config/auth failures when ChatGPT bundle loading fails and token refresh is revoked.

**Data flow**: It starts a wiremock server that returns 401 HTML for the config bundle endpoint and a 401 JSON auth error for `/oauth/token`, writes config pointing `chatgpt_base_url` there, writes ChatGPT auth credentials with a stale refresh token, creates a fake rollout, initializes the app server with `OPENAI_API_KEY` unset and a refresh-token URL override, then sends `thread/resume`. The resulting JSON-RPC error is asserted to contain a generic configuration-load message plus structured `error.data` describing reason `cloudConfigBundle`, auth error code, relogin action, status code 401, and a human-readable detail.

**Call relations**: This test mirrors the thread-start cloud-config failure case but specifically proves the resume path propagates the same structured error contract.

*Call graph*: calls 3 internal fn (new, new_with_env, create_config_toml_with_chatgpt_base_url); 17 external calls (default, given, start, new, new, new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, write_chatgpt_auth (+7 more)).


##### `thread_resume_uses_path_over_non_running_thread_id`  (lines 3363–3394)

```
async fn thread_resume_uses_path_over_non_running_thread_id() -> Result<()>
```

**Purpose**: Checks that for a non-running thread, an explicit rollout `path` override takes precedence over an unrelated supplied thread id.

**Data flow**: It creates and restarts a materialized thread, then sends `thread/resume` with a fresh random thread id and the real rollout file path. The parsed response is asserted to return the original persisted thread id from the file, not the bogus request id.

**Call relations**: This test targets the disk-loading branch of resume, contrasting with running-thread tests where the active thread id dominates.

*Call graph*: calls 3 internal fn (create_config_toml, start_materialized_thread_and_restart, new); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_resume_can_load_source_by_external_path`  (lines 3397–3440)

```
async fn thread_resume_can_load_source_by_external_path() -> Result<()>
```

**Purpose**: Verifies that resume can load a rollout located outside the current Codex home when given an explicit external path.

**Data flow**: It creates config in one temp home, creates a fake rollout in a separate external home, initializes the server against the first home, and sends `thread/resume` with an invalid thread id plus the external rollout path. It asserts the returned thread id matches the external rollout, the returned path normalizes to the external path, preview matches the external history, and status is `Idle`.

**Call relations**: This test demonstrates that explicit path-based resume is not limited to the server’s own sessions directory and can import external persisted sources.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (default, new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, rollout_path, assert_eq!, timeout).


##### `thread_resume_supports_history_and_overrides`  (lines 3443–3489)

```
async fn thread_resume_supports_history_and_overrides() -> Result<()>
```

**Purpose**: Checks that for a non-running persisted thread, callers may resume with explicit synthetic history and model/provider overrides, producing a new idle thread state based on those overrides.

**Data flow**: After creating and restarting a materialized thread, it builds a `history` vector containing one user `ResponseItem::Message`, sends `thread/resume` with that history plus `model` and `model_provider` overrides, and asserts the returned thread has a non-empty id, the response model provider is `mock_provider`, preview equals the history text, and status is `Idle`.

**Call relations**: This test is the positive counterpart to `thread_resume_rejects_history_when_thread_is_running`: history overrides are allowed when loading a non-running thread from persistence.

*Call graph*: calls 2 internal fn (create_config_toml, start_materialized_thread_and_restart); 8 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout, vec!).


##### `start_materialized_thread_and_restart`  (lines 3498–3570)

```
async fn start_materialized_thread_and_restart(
    codex_home: &Path,
    seed_text: &str,
) -> Result<RestartedThreadFixture>
```

**Purpose**: Creates a real persisted thread by starting a thread, running one materializing turn, reading back its metadata, dropping the first server instance, and returning a fresh server plus the persisted thread identifiers.

**Data flow**: It initializes a first `TestAppServer`, sends `thread/start`, sends `turn/start` with the provided seed text, waits for completion, reads the thread without turns to capture `updated_at`, extracts the thread id and rollout path, drops the first server, starts a second `TestAppServer`, and returns a `RestartedThreadFixture` containing the new server handle and persisted identifiers.

**Call relations**: This helper is shared by tests that need a persisted-but-not-currently-loaded thread, notably the history/override and `updated_at` deferral tests.

*Call graph*: calls 1 internal fn (new); called by 3 (thread_resume_supports_history_and_overrides, thread_resume_uses_path_over_non_running_thread_id, thread_resume_with_overrides_defers_updated_at_until_turn_start); 4 external calls (default, Integer, timeout, vec!).


##### `thread_resume_accepts_personality_override`  (lines 3573–3690)

```
async fn thread_resume_accepts_personality_override() -> Result<()>
```

**Purpose**: Verifies that resuming a persisted thread with a personality override affects the next model request by injecting a developer-visible personality update while preserving base instructions from history.

**Data flow**: After seeding a thread and restarting with a second client, it resumes the thread with `model: gpt-5.3-codex` and `personality: Friendly`, asserts the resumed thread is idle, starts a new turn, waits for completion, then inspects the last captured model request. It asserts one developer input contains `<personality_spec>` and the request instructions still contain the default Codex 5.2 base-instructions template.

**Call relations**: This test uses real network-backed request capture rather than only protocol responses, proving that resume-time personality overrides are carried forward into subsequent turn execution.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_sequence, sse, start_mock_server); 8 external calls (default, new, Integer, assert!, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `create_config_toml`  (lines 3693–3717)

```
fn create_config_toml(codex_home: &std::path::Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes a minimal test `config.toml` pointing the mock provider at a supplied Responses API server and enabling the personality feature.

**Data flow**: It joins `config.toml` under `codex_home`, formats a TOML string with model `gpt-5.3-codex`, approval policy `never`, sandbox `read-only`, provider `mock_provider`, and the supplied base URL, then writes the file.

**Call relations**: This is the default config helper used by most tests in the file whenever no ChatGPT base URL or MCP customization is needed.

*Call graph*: called by 31 (resume_redaction_fixture, setup_rollout_fixture, thread_goal_get_rejects_unmaterialized_thread, thread_goal_set_edits_objective_without_resetting_usage, thread_goal_set_persists_resumable_stopped_statuses, thread_goal_set_preserves_budget_limited_same_objective, thread_resume_accepts_personality_override, thread_resume_and_read_interrupt_incomplete_rollout_turn_when_thread_is_idle, thread_resume_can_load_source_by_external_path, thread_resume_can_skip_turns_for_metadata_only_resume (+15 more)); 3 external calls (join, format!, write).


##### `create_config_toml_with_chatgpt_base_url`  (lines 3719–3748)

```
fn create_config_toml_with_chatgpt_base_url(
    codex_home: &std::path::Path,
    server_uri: &str,
    chatgpt_base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes the standard mock-provider config plus an explicit `chatgpt_base_url`, enabling tests that exercise analytics capture or cloud-config bundle loading.

**Data flow**: It formats and writes `config.toml` under `codex_home`, embedding both the mock model server URL and the supplied ChatGPT backend base URL.

**Call relations**: Used by analytics and cloud-config failure tests so the app server will attempt ChatGPT-side configuration/telemetry flows during start or resume.

*Call graph*: called by 3 (thread_goal_lifecycle_emits_analytics_and_clear_deletes_goal, thread_resume_surfaces_cloud_config_bundle_load_errors, thread_resume_tracks_thread_initialized_analytics); 3 external calls (join, format!, write).


##### `create_config_toml_with_required_broken_mcp`  (lines 3750–3781)

```
fn create_config_toml_with_required_broken_mcp(
    codex_home: &std::path::Path,
    server_uri: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes a test config that includes a required MCP server pointing at a definitely nonexistent binary, forcing MCP initialization failure.

**Data flow**: It writes `config.toml` with the normal mock provider plus an `[mcp_servers.required_broken]` section whose `command` is `codex-definitely-not-a-real-binary` and `required = true`.

**Call relations**: This helper is used only by `thread_resume_fails_when_required_mcp_server_fails_to_initialize` to force the resume path through required-MCP startup validation.

*Call graph*: called by 1 (thread_resume_fails_when_required_mcp_server_fails_to_initialize); 3 external calls (join, format!, write).


##### `set_rollout_mtime`  (lines 3784–3792)

```
fn set_rollout_mtime(path: &Path, updated_at_rfc3339: &str) -> Result<()>
```

**Purpose**: Sets a rollout file’s modification time to a chosen RFC3339 timestamp without otherwise changing its contents.

**Data flow**: It parses the timestamp with `chrono`, converts it to `FileTimes`, opens the file in append mode, and applies the modified time via `set_times`. It returns any parse or I/O error.

**Call relations**: Used by `setup_rollout_fixture` and the override-specific `updated_at` test to create deterministic file timestamps that resume should preserve until a new turn writes the rollout.

*Call graph*: called by 2 (setup_rollout_fixture, thread_resume_with_overrides_defers_updated_at_until_turn_start); 3 external calls (new, parse_from_rfc3339, new).


##### `setup_rollout_fixture`  (lines 3800–3828)

```
async fn setup_rollout_fixture(codex_home: &Path, server_uri: &str) -> Result<RolloutFixture>
```

**Purpose**: Creates a persisted rollout fixture with known history, appends a second `SessionMeta` item carrying `multi_agent_version`, and stamps the file with a controlled modification time.

**Data flow**: It writes standard config, creates a fake rollout with one saved user message, locates the rollout path, reads the existing session-meta line, mutates `multi_agent_version` to `V1`, appends that updated `RolloutItem::SessionMeta` to the file, sets the file mtime to `2025-01-07T00:00:00Z`, reads the resulting modification time, and returns a `RolloutFixture` containing thread id, path, and pre-resume mtime.

**Call relations**: This helper is shared by tests that need a stable persisted rollout with controlled metadata and timestamps, especially the `updated_at` deferral and required-MCP failure cases.

*Call graph*: calls 2 internal fn (create_config_toml, set_rollout_mtime); called by 2 (thread_resume_defers_updated_at_until_turn_start, thread_resume_fails_when_required_mcp_server_fails_to_initialize); 7 external calls (new, create_fake_rollout_with_text_elements, rollout_path, append_rollout_item_to_path, read_session_meta_line, SessionMeta, metadata).


### Thread state mutation
These suites cover the lifecycle operations that mutate persisted thread state, including archival, deletion, branching, rollback, and per-thread configuration updates.

### `app-server/tests/suite/v2/thread_archive.rs`

`test` · `request handling`

This module tests archive semantics at both the filesystem and state-graph levels. The first test shows that a newly started persisted thread has an id and an advertised rollout path but no actual rollout file yet; `find_thread_path_by_id_str` returns `None` until a real turn materializes the rollout. Attempting to archive before that point must fail with an error mentioning that no rollout was found. After a real turn completes, the test confirms the rollout file exists, can be rediscovered by thread id, archives successfully, emits `thread/archived`, and is physically moved into `ARCHIVED_SESSIONS_SUBDIR` under the same filename.

The descendant tests use `create_fake_rollout` plus `StateRuntime` spawn-edge records to model parent/child/grandchild relationships. Archiving a parent should archive descendants too, but the observed notification order is significant: one test expects `[parent, grandchild, child]`, while the delete suite uses a different order. Another test intentionally creates a path conflict in the archived child destination so descendant archiving partially fails; the parent request still succeeds, notifications are emitted only for the successfully archived threads, and the conflicting child rollout remains active. A missing descendant is likewise tolerated. The final test uses two `TestAppServer` instances to verify that archiving and unarchiving clear stale subscriptions before a second client resumes the thread: after resume, a new turn started by the secondary client must not leak `turn/started` notifications to the primary client. Helper functions centralize config writing and canonical-path comparison.

#### Function details

##### `thread_archive_requires_materialized_rollout`  (lines 36–168)

```
async fn thread_archive_requires_materialized_rollout() -> Result<()>
```

**Purpose**: Verifies that archiving a persisted thread fails before its rollout file exists, then succeeds after a real turn materializes that rollout. It also checks that the archived rollout file is moved into the archived sessions directory and remains discoverable there.

**Data flow**: Starts a repeating mock assistant, writes config, initializes `TestAppServer`, and sends a thread-start request. From the `ThreadStartResponse` it extracts the thread id and advertised rollout path, asserts the path does not yet exist, and confirms `find_thread_path_by_id_str` returns `None`. It then sends `thread/archive`, reads a `JSONRPCError`, and checks the message mentions missing rollout. Next it starts a real turn with text `materialize`, waits for the turn response and `turn/completed`, asserts the rollout path now exists, rediscovers it by thread id, and compares the discovered and advertised paths with `assert_paths_match_on_disk`. Finally it archives again, parses `ThreadArchiveResponse`, waits for `thread/archived`, checks the notification thread id, and asserts the original rollout path is gone while the corresponding file exists under `ARCHIVED_SESSIONS_SUBDIR`.

**Call relations**: This top-level test uses `create_config_toml` for setup and `assert_paths_match_on_disk` to compare the rollout path returned by the API with the path rediscovered from disk/state after materialization.

*Call graph*: calls 3 internal fn (new, assert_paths_match_on_disk, create_config_toml); 10 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, find_thread_path_by_id_str, from_value, timeout, vec!).


##### `thread_archive_archives_spawned_descendants`  (lines 171–279)

```
async fn thread_archive_archives_spawned_descendants() -> Result<()>
```

**Purpose**: Tests recursive archiving across a parent-child-grandchild spawn graph recorded in the state database. It confirms both notification order and on-disk movement for all descendants.

**Data flow**: Creates a temporary Codex home, writes config, generates three fake rollout files for parent, child, and grandchild, converts their ids into `ThreadId` values, initializes `StateRuntime`, marks backfill complete, and inserts spawn edges parent→child (Closed) and child→grandchild (Open). After starting and initializing `TestAppServer`, it sends `thread/archive` for the parent id, parses `ThreadArchiveResponse`, then reads three `thread/archived` notifications and collects their `thread_id` values. It asserts the order is `[parent_id, grandchild_id, child_id]`, then for each thread id checks that `find_thread_path_by_id_str` returns `None` and `find_archived_thread_path_by_id_str` returns `Some(_)`.

**Call relations**: This direct test uses `create_config_toml` for server setup but otherwise prepares its own rollout and state-db fixtures before invoking the archive request and consuming notifications.

*Call graph*: calls 4 internal fn (new, create_config_toml, from_string, init); 9 external calls (new, new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, from_value, timeout).


##### `thread_archive_succeeds_when_descendant_archive_fails`  (lines 282–417)

```
async fn thread_archive_succeeds_when_descendant_archive_fails() -> Result<()>
```

**Purpose**: Ensures a parent archive request still succeeds when archiving one descendant fails due to an on-disk conflict. Successful descendants should still be archived and notified, while the conflicting child remains active.

**Data flow**: Creates config, fake parent/child/grandchild rollouts, and the same spawn-edge graph as the previous test. It then finds the active child rollout path, computes the archived destination path under `ARCHIVED_SESSIONS_SUBDIR`, and creates a directory at that destination to force a move conflict. After initializing `TestAppServer`, it archives the parent, parses `ThreadArchiveResponse`, and reads exactly two `thread/archived` notifications, asserting they are for `[parent_id, grandchild_id]`. It then asserts no third archive notification arrives within 250 ms, verifies the child rollout path still exists and the conflicting archived path remains a directory, and confirms only parent and grandchild have moved from active to archived locations.

**Call relations**: This test follows the same archive flow as `thread_archive_archives_spawned_descendants` but injects a filesystem conflict before the request to validate partial-failure tolerance.

*Call graph*: calls 4 internal fn (new, create_config_toml, from_string, init); 11 external calls (new, new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, find_thread_path_by_id_str, from_value, create_dir_all (+1 more)).


##### `thread_archive_succeeds_when_spawned_descendant_is_missing`  (lines 420–494)

```
async fn thread_archive_succeeds_when_spawned_descendant_is_missing() -> Result<()>
```

**Purpose**: Checks that archiving a parent thread succeeds even if the state database references a spawned descendant whose rollout file does not exist. The missing descendant should not block archiving the parent.

**Data flow**: Creates config and a fake parent rollout, converts the parent id and a hard-coded missing child UUID into `ThreadId` values, initializes `StateRuntime`, marks backfill complete, and inserts a parent→missing-child spawn edge. It starts `TestAppServer`, sends `thread/archive` for the parent id, parses `ThreadArchiveResponse`, waits for one `thread/archived` notification, and asserts it names the parent. It then checks that the parent no longer has an active rollout path and does have an archived rollout path.

**Call relations**: This top-level test uses `create_config_toml` for setup and otherwise constructs a minimal state-db graph with a missing descendant to validate archive robustness.

*Call graph*: calls 4 internal fn (new, create_config_toml, from_string, init); 8 external calls (new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, from_value, timeout).


##### `thread_archive_clears_stale_subscriptions_before_resume`  (lines 497–630)

```
async fn thread_archive_clears_stale_subscriptions_before_resume() -> Result<()>
```

**Purpose**: Verifies that archiving and unarchiving a thread clears stale subscriptions so that a later resume by another client does not leave the original client subscribed to future turn events. It specifically guards against notification leakage across archive/unarchive/resume boundaries.

**Data flow**: Starts a repeating mock assistant, writes config, and initializes a primary `TestAppServer`. The primary starts a thread, runs a real turn to materialize it, waits for `turn/completed`, and clears its message buffer. A secondary `TestAppServer` is then initialized against the same Codex home. The primary archives the thread, waits for the archive response and `thread/archived`, unarchives it, waits for the unarchive response and `thread/unarchived`, and clears buffers again. The secondary sends `thread/resume`, parses `ThreadResumeResponse`, and asserts the resumed thread status is `Idle`; both clients clear buffers. The secondary then starts a new turn on the resumed thread and receives the turn-start response. The test asserts the primary does not receive `turn/started` within 250 ms, while the secondary does receive `turn/completed`.

**Call relations**: This test is a multi-client orchestration scenario. It uses `create_config_toml` for setup and then coordinates two `TestAppServer` instances through archive, unarchive, resume, and a post-resume turn to validate subscription cleanup.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout, vec!).


##### `create_config_toml`  (lines 632–635)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes the archive-test configuration file by delegating the TOML body generation to `config_contents`. It keeps setup code in the tests concise while sharing one provider configuration.

**Data flow**: Accepts the Codex home path and server URI, joins `config.toml`, calls `config_contents(server_uri)` to build the TOML string, and writes it to disk. It returns the `std::io::Result<()>` from the write.

**Call relations**: Called by all top-level archive tests before `TestAppServer::new`; it delegates the actual string construction to `config_contents`.

*Call graph*: calls 1 internal fn (config_contents); called by 5 (thread_archive_archives_spawned_descendants, thread_archive_clears_stale_subscriptions_before_resume, thread_archive_requires_materialized_rollout, thread_archive_succeeds_when_descendant_archive_fails, thread_archive_succeeds_when_spawned_descendant_is_missing); 2 external calls (join, write).


##### `config_contents`  (lines 637–653)

```
fn config_contents(server_uri: &str) -> String
```

**Purpose**: Builds the common TOML configuration string used by the archive tests. The config selects `mock-model`, disables approvals, uses read-only sandboxing, and points the mock provider at the supplied server URI.

**Data flow**: Takes a `server_uri` string and interpolates it into a formatted TOML document, returning the resulting `String`.

**Call relations**: Used only by `create_config_toml` as the shared source of config text for this file's tests.

*Call graph*: called by 1 (create_config_toml); 1 external calls (format!).


##### `assert_paths_match_on_disk`  (lines 655–660)

```
fn assert_paths_match_on_disk(actual: &Path, expected: &Path) -> std::io::Result<()>
```

**Purpose**: Compares two filesystem paths after canonicalization so tests can verify they refer to the same on-disk rollout file even if their textual forms differ. It wraps the canonicalization and equality assertion in one helper.

**Data flow**: Accepts `actual` and `expected` `&Path` values, canonicalizes both, asserts equality with `assert_eq!`, and returns `Ok(())` or any canonicalization error.

**Call relations**: Called only by `thread_archive_requires_materialized_rollout` after rediscovering a rollout path by thread id, to confirm it matches the path returned in the original thread-start response.

*Call graph*: called by 1 (thread_archive_requires_materialized_rollout); 2 external calls (canonicalize, assert_eq!).


### `app-server/tests/suite/v2/thread_delete.rs`

`test` · `request handling`

This file covers deletion semantics rather than archiving. The first test constructs a parent/child/grandchild rollout tree entirely from fake rollout files and explicit spawn-edge records in `StateRuntime`. After initializing `TestAppServer`, it sends a delete request for the parent thread and expects three `thread/deleted` notifications in post-order: grandchild first, then child, then parent. It then confirms that `find_thread_path_by_id_str` returns `None` for all three ids and that `list_thread_spawn_descendants(parent)` is empty, proving both filesystem and graph state were cleaned up.

A small helper, `create_delete_test_rollout`, standardizes the fake rollout timestamps by minute offset while delegating actual file creation to `create_fake_rollout`. The second test exercises live-thread edge cases. It starts a normal persisted thread through the app server, confirms no rollout path exists yet, and deletes it successfully anyway, showing deletion can remove a live persisted thread before rollout materialization. It then starts an ephemeral thread and attempts deletion; this must fail with a precise error message stating the thread is not persisted and cannot be deleted. Finally, it lists loaded threads and asserts only the ephemeral thread id remains, demonstrating that the earlier persisted live thread was removed while the undeletable ephemeral thread stayed loaded.

#### Function details

##### `thread_delete_deletes_spawned_descendants`  (lines 27–108)

```
async fn thread_delete_deletes_spawned_descendants() -> Result<()>
```

**Purpose**: Verifies recursive deletion of a spawned thread tree, including notification order, rollout-file removal, and spawn-edge cleanup in the state database. It is the delete counterpart to the archive descendant tests.

**Data flow**: Creates a temporary Codex home, generates fake parent/child/grandchild rollouts via `create_delete_test_rollout`, initializes `StateRuntime`, converts ids to `ThreadId`, and inserts parent→child and child→grandchild spawn edges with statuses Closed and Open. It starts and initializes `TestAppServer`, sends `thread/delete` for the parent id, parses `ThreadDeleteResponse`, then reads three `thread/deleted` notifications and collects their ids. It asserts the order is `[grandchild_id, child_id, parent_id]`, checks that `find_thread_path_by_id_str` returns `None` for each thread, and asserts `list_thread_spawn_descendants(parent_thread_id)` returns an empty vector.

**Call relations**: This top-level test uses `create_delete_test_rollout` to build its rollout fixtures, then drives the delete request and validates both notification stream and state-db aftermath.

*Call graph*: calls 4 internal fn (new, create_delete_test_rollout, from_string, init); 8 external calls (new, new, Integer, assert!, assert_eq!, find_thread_path_by_id_str, from_value, timeout).


##### `create_delete_test_rollout`  (lines 110–119)

```
fn create_delete_test_rollout(codex_home: &Path, minute: u8, preview: &str) -> Result<String>
```

**Purpose**: Creates a fake rollout with a timestamp derived from a minute offset, simplifying fixture generation for delete tests. It standardizes the filename timestamp and ISO timestamp while leaving the preview text configurable.

**Data flow**: Accepts the Codex home path, a minute value, and a preview string, formats `2025-01-01T00-<minute>-00` and `2025-01-01T00:<minute>:00Z`, and passes those along with the preview and provider name `mock_provider` to `create_fake_rollout`. It returns the created thread id as `Result<String>`.

**Call relations**: Called only by `thread_delete_deletes_spawned_descendants` to create the parent, child, and grandchild rollout fixtures with predictable timestamps.

*Call graph*: called by 1 (thread_delete_deletes_spawned_descendants); 2 external calls (create_fake_rollout, format!).


##### `thread_delete_handles_live_threads_before_rollout_exists`  (lines 122–200)

```
async fn thread_delete_handles_live_threads_before_rollout_exists() -> Result<()>
```

**Purpose**: Tests deletion behavior for live threads that have not yet materialized a rollout file, distinguishing persisted threads from ephemeral ones. Persisted live threads should delete successfully; ephemeral live threads should be rejected as non-persisted.

**Data flow**: Creates a temporary Codex home, starts and initializes `TestAppServer`, and sends a default thread-start request. After parsing `ThreadStartResponse`, it checks `find_thread_path_by_id_str` returns `None` for that persisted thread id, then sends `thread/delete` and parses a successful `ThreadDeleteResponse`. Next it starts another thread with `ephemeral: Some(true)`, parses the response, sends `thread/delete` for that id, and reads a `JSONRPCError`, asserting the exact message `thread is not persisted and cannot be deleted: <id>`. Finally it sends `thread/loaded/list`, parses `ThreadLoadedListResponse`, sorts the returned ids, and asserts the only remaining loaded thread is the ephemeral one.

**Call relations**: This is a standalone top-level test. It directly drives thread-start, thread-delete, and thread-loaded-list requests to validate the server's special-case handling of live persisted versus live ephemeral threads.

*Call graph*: calls 1 internal fn (new); 9 external calls (default, new, Integer, default, default, assert_eq!, find_thread_path_by_id_str, format!, timeout).


### `app-server/tests/suite/v2/thread_fork.rs`

`test` · `request handling`

This test file builds realistic fork scenarios from on-disk rollout JSONL files and then drives the app server through `TestAppServer`. Most tests create a temporary Codex home, write a minimal `config.toml`, seed one or more fake rollouts, initialize the server, and issue `thread/fork` requests. The assertions are concrete about wire shape: `sessionId` must live under `thread`, unset `name` must serialize as JSON `null`, and `thread/started` must omit copied historical turns even when the fork response itself includes them. The suite distinguishes persistent forks from `ephemeral` forks: ephemeral forks must have `path: None`, remain usable for future turns, but never appear in `thread/list`.

The file also checks less obvious invariants. Forking must not mutate the source rollout file; a forked thread inherits preview, provider, cwd, source metadata, and optionally a stored thread name from the session index. If token usage exists in the source rollout, the server must replay a `thread/tokenUsage/updated` notification unless `exclude_turns` suppresses history restoration. Error coverage includes unmaterialized loaded threads, invalid directory paths supplied as `path`, and cloud-config bundle failures that should surface structured JSON-RPC error data with relogin guidance. Analytics capture is mounted to confirm that forking emits a `thread_initialized` event tagged as `forked` with the original thread id.

#### Function details

##### `list_threads`  (lines 61–83)

```
async fn list_threads(mcp: &mut TestAppServer) -> Result<ThreadListResponse>
```

**Purpose**: Sends a `thread/list` request with a broad default filter set and converts the JSON-RPC response into a typed `ThreadListResponse` for assertions in fork-related tests.

**Data flow**: It takes a mutable `TestAppServer`, constructs `ThreadListParams` with a 50-item limit and no filters except `use_state_db_only: false`, sends the request, waits under `DEFAULT_READ_TIMEOUT` for the matching response id, and deserializes the payload via `to_response`. It returns the typed list response without mutating any local state beyond consuming messages from the server stream.

**Call relations**: This helper is invoked by the tests that need to verify post-fork visibility in listing results. It sits after server initialization and after a fork operation, and delegates transport details to `send_thread_list_request` and `read_stream_until_response_message` so the tests can focus on list contents.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_list_request); called by 2 (thread_fork_ephemeral_remains_pathless_and_omits_listing, thread_fork_inherits_explicit_source_name_from_session_index); 2 external calls (Integer, timeout).


##### `thread_fork_creates_new_thread_and_emits_started`  (lines 86–251)

```
async fn thread_fork_creates_new_thread_and_emits_started() -> Result<()>
```

**Purpose**: Validates the main fork contract for a persisted source rollout: a new thread is created with copied history, correct metadata, no mutation of the original file, and a subsequent `thread/started` notification that introduces the thread without replaying copied turns.

**Data flow**: The test creates a fake rollout, manually appends a `SessionMeta` line with `multi_agent_version = V1`, snapshots the original file contents, starts the server, and sends `ThreadForkParams` with the source thread id and `thread_source: User`. It parses the fork response into `ThreadForkResponse`, inspects the raw JSON result for exact wire fields, rereads the original rollout to ensure byte-for-byte equality, and asserts properties on the returned thread: new id, `session_id == id`, `forked_from_id`, preview, provider, idle status, absolute path/cwd, VS Code session source, caller-supplied thread source, null name, and one interrupted turn containing the original user message. It then loops over incoming JSON-RPC messages until `thread/started`, explicitly failing if a `thread/status/changed` for the new thread appears first, and verifies that the notification serializes `name: null`, empty `turns`, and preserved `threadSource`.

**Call relations**: This is the central happy-path fork test. It is self-contained: after setup through `create_config_toml`, fake rollout creation, and server initialization, it drives `thread/fork`, then consumes notifications from the stream to verify ordering and payload shape.

*Call graph*: calls 2 internal fn (new, create_config_toml); 18 external calls (default, new, bail!, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, assert_ne!, append_rollout_item_to_path (+8 more)).


##### `thread_fork_inherits_explicit_source_name_from_session_index`  (lines 254–295)

```
async fn thread_fork_inherits_explicit_source_name_from_session_index() -> Result<()>
```

**Purpose**: Checks that a forked thread picks up an explicit stored name from the parent thread’s session index entry when later surfaced through listing.

**Data flow**: The test seeds a rollout, converts its id into `ThreadId`, writes a thread name with `append_thread_name`, starts the server, forks the thread, and parses the fork response to obtain the new thread id. It then calls the local `list_threads` helper, finds the forked thread in the returned `data`, and asserts that `name` matches the parent’s stored name.

**Call relations**: It is called directly by the test harness and uses `list_threads` as a second-phase verification step after `thread/fork`. The test demonstrates that name inheritance is not necessarily visible in the immediate fork response but must be reflected by later list reads.

*Call graph*: calls 4 internal fn (new, create_config_toml, list_threads, from_string); 8 external calls (default, new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert_eq!, append_thread_name, timeout).


##### `thread_fork_can_load_source_by_path`  (lines 298–346)

```
async fn thread_fork_can_load_source_by_path() -> Result<()>
```

**Purpose**: Verifies that `thread/fork` can resolve the source rollout from an explicit filesystem path even when the supplied `thread_id` is invalid.

**Data flow**: After creating a fake rollout and computing its absolute JSONL path, the test initializes the server and sends `ThreadForkParams` with `thread_id` set to an invalid string and `path` set to the real rollout path. It waits for the response, deserializes `ThreadForkResponse`, and asserts that the new thread id differs from the original, `forked_from_id` points to the original conversation id, preview/provider are preserved, and copied history contains one turn.

**Call relations**: This test covers the alternate source-resolution branch inside fork handling. It bypasses normal id lookup and proves that the server prefers a valid explicit path when present.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (default, new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert_eq!, assert_ne!, format!, timeout).


##### `thread_fork_emits_restored_token_usage_before_next_turn`  (lines 349–400)

```
async fn thread_fork_emits_restored_token_usage_before_next_turn() -> Result<()>
```

**Purpose**: Ensures that when a source rollout contains token-usage accounting, forking replays that accounting immediately as a `thread/tokenUsage/updated` notification tied to the restored turn.

**Data flow**: The test seeds a rollout with token usage, starts the server, forks it, and parses the returned thread to obtain the new thread id and first turn id. It then waits specifically for a `thread/tokenUsage/updated` notification, converts the generic notification into `ServerNotification`, pattern-matches `ThreadTokenUsageUpdated`, and asserts exact totals, cached input, output, reasoning output, last-turn totals, and model context window values.

**Call relations**: It runs after a successful fork response and before any new turn is started. The test’s role is to verify notification replay semantics for restored accounting state rather than the fork payload itself.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (default, new, Integer, create_fake_rollout_with_token_usage, create_mock_responses_server_repeating_assistant, assert_eq!, panic!, timeout).


##### `thread_fork_can_exclude_turns_and_skip_restored_token_usage`  (lines 403–448)

```
async fn thread_fork_can_exclude_turns_and_skip_restored_token_usage() -> Result<()>
```

**Purpose**: Checks that `exclude_turns: true` produces a fork shell without copied turns and suppresses replay of restored token-usage notifications.

**Data flow**: The test creates a rollout with token usage, initializes the server, sends a fork request with `exclude_turns: true`, and parses the response. It asserts that `forked_from_id` and preview are still populated but `turns` is empty. It then waits for `thread/tokenUsage/updated` under timeout and expects the wait itself to fail, proving no replay occurred.

**Call relations**: This test exercises the branch opposite to restored-history replay. It follows the same setup as the token-usage test but changes one request flag and then verifies both response shape and absence of a side-effect notification.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (default, new, Integer, create_fake_rollout_with_token_usage, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout).


##### `thread_fork_tracks_thread_initialized_analytics`  (lines 451–502)

```
async fn thread_fork_tracks_thread_initialized_analytics() -> Result<()>
```

**Purpose**: Confirms that forking emits the analytics event used for thread initialization, with event parameters identifying the thread as forked and preserving the caller-supplied origin.

**Data flow**: It creates a config that points both model traffic and ChatGPT base URL at the mock server, mounts analytics capture endpoints, seeds a source rollout, starts the app server without managed config, forks the thread with `thread_source: User`, and parses the fork response to get the new thread metadata. It then waits for the captured analytics payload, extracts the `thread_initialized` event, runs shared assertions for basic fields, and additionally checks `forked_from_thread_id` against the source thread id.

**Call relations**: This test extends the normal fork flow into the analytics side channel. It depends on helper functions from the sibling analytics module to capture and decode the emitted event after the fork request succeeds.

*Call graph*: calls 6 internal fn (new_without_managed_config, assert_basic_thread_initialized_event, mount_analytics_capture, thread_initialized_event, wait_for_analytics_payload, create_config_toml_with_chatgpt_base_url); 7 external calls (default, new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_fork_rejects_unmaterialized_thread`  (lines 505–547)

```
async fn thread_fork_rejects_unmaterialized_thread() -> Result<()>
```

**Purpose**: Verifies that a freshly started but not yet materialized loaded thread cannot be used as a fork source because no rollout file exists yet.

**Data flow**: The test starts the server, creates a new thread via `thread/start`, parses the returned thread id, then immediately sends `thread/fork` for that id. Instead of a response, it waits for a JSON-RPC error and asserts that the message contains `no rollout found for thread id`.

**Call relations**: This covers an error path reached only after `thread/start` but before any user turn writes a rollout. The test demonstrates that forking depends on persisted source material, not merely an in-memory loaded thread record.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, timeout).


##### `thread_fork_with_empty_path_uses_thread_id`  (lines 550–587)

```
async fn thread_fork_with_empty_path_uses_thread_id() -> Result<()>
```

**Purpose**: Checks that an explicitly provided empty `PathBuf` does not override normal source lookup and the server still resolves the source by `thread_id`.

**Data flow**: After seeding a rollout and starting the server, the test sends `ThreadForkParams` with the real `thread_id`, `path: Some(PathBuf::new())`, and `thread_source: User`. It parses the successful response and asserts that `forked_from_id` still equals the original conversation id.

**Call relations**: This is a small edge-case regression test around parameter precedence. It ensures the fork implementation treats an empty path as absent rather than as a malformed filesystem target.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (default, new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert_eq!, new, timeout).


##### `thread_fork_surfaces_cloud_config_bundle_load_errors`  (lines 590–683)

```
async fn thread_fork_surfaces_cloud_config_bundle_load_errors() -> Result<()>
```

**Purpose**: Ensures that forking surfaces cloud configuration bundle failures as structured JSON-RPC errors, including auth-specific remediation metadata when refresh-token renewal fails.

**Data flow**: The test starts a `wiremock` server that returns HTML 401 for the bundle endpoint and a JSON 401 `refresh_token_invalidated` error for `/oauth/token`. It writes config pointing ChatGPT traffic at that server, stores ChatGPT auth credentials with a stale refresh token, starts the app server with `OPENAI_API_KEY` unset and the refresh-token URL override env var set, initializes, and sends `thread/fork`. It reads the resulting `JSONRPCError`, asserts the human-readable message mentions failed configuration loading, and compares `error.data` against an exact JSON object containing reason, error code, action, status code, and detail text.

**Call relations**: This test drives forking through configuration loading rather than rollout copying. It relies on mocked HTTP endpoints and environment overrides so that the fork request triggers the cloud-config path and returns a rich error instead of a generic failure.

*Call graph*: calls 3 internal fn (new, new_with_env, create_config_toml_with_chatgpt_base_url); 16 external calls (default, given, start, new, new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, write_chatgpt_auth, assert! (+6 more)).


##### `thread_fork_ephemeral_remains_pathless_and_omits_listing`  (lines 686–837)

```
async fn thread_fork_ephemeral_remains_pathless_and_omits_listing() -> Result<()>
```

**Purpose**: Validates the special semantics of `ephemeral` forks: they are usable loaded threads with copied history, but they expose no path, serialize `ephemeral: true`, emit `thread/started` without copied turns, and never appear in `thread/list`.

**Data flow**: The test seeds a persistent source rollout, starts the server, forks with `ephemeral: true`, inspects both typed and raw JSON response fields, and asserts `ephemeral`, `path: None`, preview, idle status, null name, and one completed copied turn containing the original user message. It then consumes notifications until `thread/started`, failing if a prior `thread/status/changed` for the new thread appears, and checks that the notification also serializes `ephemeral: true` and empty `turns`. Next it calls `list_threads` to confirm the ephemeral fork id is absent while the source thread remains listed. Finally it starts a new turn on the ephemeral fork and waits for `turn/completed`, proving the pathless fork remains operational.

**Call relations**: This is the main behavioral test for ephemeral forks. It combines fork response validation, notification ordering, list visibility checks via the local helper, and a follow-up turn to prove the thread survives beyond creation.

*Call graph*: calls 3 internal fn (new, create_config_toml, list_threads); 13 external calls (default, new, bail!, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, panic!, from_value (+3 more)).


##### `pathless_ephemeral_thread_rejects_codex_home_path_after_reload`  (lines 840–951)

```
async fn pathless_ephemeral_thread_rejects_codex_home_path_after_reload() -> Result<()>
```

**Purpose**: Checks that after process restart, a pathless ephemeral thread cannot be resumed or forked by passing the Codex home directory as a fake path; the server must reject the directory before attempting rollout reads.

**Data flow**: The test first creates a parent rollout, starts a server instance, forks an ephemeral side thread, confirms `path: None`, runs one turn on it, and captures the side thread id. It then starts a fresh server instance, builds `codex_home` as a directory path, and sends `thread/resume` for the side thread with `path` set to that directory. It expects a JSON-RPC error containing `path is a directory` and explicitly not the OS-level `Is a directory` text. It repeats the same pattern with `thread/fork` on the side thread id and the same directory path, asserting the same early validation behavior.

**Call relations**: This test spans two server lifetimes to simulate reload. It first creates the pathless ephemeral thread, then verifies both resume and fork reject an invalid directory path before deeper rollout-loading logic runs.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (default, new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout, vec!).


##### `create_config_toml`  (lines 954–975)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes the standard test `config.toml` used by most fork tests, pointing the default model provider at the supplied mock responses server.

**Data flow**: It takes a Codex home path and server URI, joins `config.toml`, formats a TOML string with `model = "mock-model"`, `approval_policy = "never"`, `sandbox_mode = "read-only"`, `model_provider = "mock_provider"`, and a `[model_providers.mock_provider]` block using `{server_uri}/v1`, then writes the file to disk.

**Call relations**: This helper is called during test setup by nearly every test in the file so that `TestAppServer::new` can boot against a deterministic mock provider configuration.

*Call graph*: called by 9 (pathless_ephemeral_thread_rejects_codex_home_path_after_reload, thread_fork_can_exclude_turns_and_skip_restored_token_usage, thread_fork_can_load_source_by_path, thread_fork_creates_new_thread_and_emits_started, thread_fork_emits_restored_token_usage_before_next_turn, thread_fork_ephemeral_remains_pathless_and_omits_listing, thread_fork_inherits_explicit_source_name_from_session_index, thread_fork_rejects_unmaterialized_thread, thread_fork_with_empty_path_uses_thread_id); 3 external calls (join, format!, write).


##### `create_config_toml_with_chatgpt_base_url`  (lines 977–1003)

```
fn create_config_toml_with_chatgpt_base_url(
    codex_home: &Path,
    server_uri: &str,
    chatgpt_base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes a variant of the test config that also sets `chatgpt_base_url`, enabling tests that need cloud-config or analytics traffic to hit a controlled mock server.

**Data flow**: It accepts the Codex home path, model server URI, and ChatGPT base URL, formats a TOML document identical to the standard config plus `chatgpt_base_url = "..."`, and writes it to `config.toml` under the temporary home directory.

**Call relations**: This helper is used only by the analytics and cloud-config error tests, where forking must trigger additional HTTP interactions beyond the model provider.

*Call graph*: called by 2 (thread_fork_surfaces_cloud_config_bundle_load_errors, thread_fork_tracks_thread_initialized_analytics); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/thread_memory_mode_set.rs`

`test` · `request handling`

This file verifies that changing a thread’s memory mode updates persistent state in `StateRuntime`, regardless of whether the target thread is currently loaded in memory or exists only as a stored rollout. The tests enable sqlite explicitly in `config.toml`, initialize the state database, and then drive the app server through JSON-RPC requests.

The first test starts a live thread, converts its string id into `ThreadId`, sends `thread/memoryMode/set` with `ThreadMemoryMode::Disabled`, and then queries sqlite directly with `get_thread_memory_mode` to confirm the stored value is `disabled`. The second test seeds a fake rollout on disk, initializes the server, and sends two successive updates—first `Disabled`, then `Enabled`—to prove the endpoint can repair or locate stored thread metadata and persist the latest mode even when the thread was never loaded. A shared `init_state_db` helper initializes `StateRuntime` for the temp home and marks backfill complete so sqlite-backed operations are available immediately. The config helper writes a runtime config with sqlite enabled and unstable-feature warnings suppressed.

#### Function details

##### `thread_memory_mode_set_updates_loaded_thread_state`  (lines 24–63)

```
async fn thread_memory_mode_set_updates_loaded_thread_state() -> Result<()>
```

**Purpose**: Verifies that setting memory mode on a currently loaded thread persists the new mode into sqlite.

**Data flow**: The test starts a mock server, writes sqlite-enabled config, initializes the state DB, starts and initializes `TestAppServer`, creates a thread via `thread/start`, parses its id into `ThreadId`, sends `ThreadMemoryModeSetParams { mode: Disabled }`, decodes the success response, then queries `state_db.get_thread_memory_mode(thread_uuid)` and asserts the stored string is `disabled`.

**Call relations**: This is the loaded-thread path for the endpoint, combining app-server mutation with direct sqlite verification through the helper-initialized `StateRuntime`.

*Call graph*: calls 4 internal fn (new, create_config_toml, init_state_db, from_string); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_memory_mode_set_updates_stored_thread_state`  (lines 66–103)

```
async fn thread_memory_mode_set_updates_stored_thread_state() -> Result<()>
```

**Purpose**: Checks that memory mode updates also work for a persisted rollout that has not been loaded into the running server.

**Data flow**: It starts a mock server, writes config, initializes sqlite, creates a fake rollout and parses its id into `ThreadId`, starts the server, then loops over two modes (`Disabled`, `Enabled`) sending `thread/memoryMode/set` requests for the stored thread id and decoding each success response. After both updates, it reads the sqlite value and asserts the final stored mode is `enabled`.

**Call relations**: This complements the loaded-thread test by exercising the stored-thread repair/update path and proving later writes overwrite earlier ones.

*Call graph*: calls 4 internal fn (new, create_config_toml, init_state_db, from_string); 6 external calls (new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `init_state_db`  (lines 105–111)

```
async fn init_state_db(codex_home: &Path) -> Result<Arc<StateRuntime>>
```

**Purpose**: Initializes `StateRuntime` for the temporary Codex home and marks backfill complete so sqlite-backed thread metadata operations are immediately usable.

**Data flow**: It takes a Codex home path, calls `StateRuntime::init` with provider `mock_provider`, awaits `mark_backfill_complete(None)`, and returns the resulting `Arc<StateRuntime>`.

**Call relations**: Both tests call this helper before issuing memory-mode updates so they can verify results directly against sqlite.

*Call graph*: calls 1 internal fn (init); called by 2 (thread_memory_mode_set_updates_loaded_thread_state, thread_memory_mode_set_updates_stored_thread_state); 1 external calls (to_path_buf).


##### `create_config_toml`  (lines 113–138)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes the sqlite-enabled runtime config required by the memory-mode tests.

**Data flow**: It formats TOML containing model defaults, `sandbox_mode`, `model_provider`, `suppress_unstable_features_warning = true`, `[features] sqlite = true`, and the mock provider block using the supplied server URI, then writes it to `config.toml`.

**Call relations**: Both tests use this helper during setup so the app server and state DB operate with sqlite support enabled.

*Call graph*: called by 2 (thread_memory_mode_set_updates_loaded_thread_state, thread_memory_mode_set_updates_stored_thread_state); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/thread_metadata_update.rs`

`test` · `request handling`

This suite validates how thread metadata updates patch git information on both loaded and stored threads. The tests use a sqlite-enabled config and, where needed, initialize `StateRuntime` so they can simulate missing rows and archived rollouts. The primary happy-path test starts a thread, sends a patch that sets only `git_info.branch`, and then verifies both the typed response and raw JSON wire payload include the updated `thread.gitInfo` and `sessionId`. It follows up with `thread/read` to ensure the change persists.

Several negative and repair-oriented cases are covered. An empty git-info patch—where `sha`, `branch`, and `origin_url` are all absent—must be rejected with an invalid-request style message. Ephemeral threads must reject metadata updates entirely. For stored, loaded, and archived threads, the endpoint must be able to reconstruct missing sqlite rows from rollout files rather than failing; one test even deletes the sqlite row after a thread has been resumed to ensure repair does not wipe summary fields like preview. Another test proves tri-state patch semantics for clearing fields: `Some(None)` on each git field removes previously stored git metadata so later reads return `git_info: None`. Shared helpers initialize sqlite and write the sqlite-enabled runtime config.

#### Function details

##### `thread_metadata_update_patches_git_branch_and_returns_updated_thread`  (lines 39–131)

```
async fn thread_metadata_update_patches_git_branch_and_returns_updated_thread() -> Result<()>
```

**Purpose**: Verifies the normal metadata-update path by patching only the git branch on a loaded thread and checking both response payloads and subsequent reads.

**Data flow**: The test starts a mock server, writes config, initializes the app server, creates a thread, and sends `ThreadMetadataUpdateParams` with `git_info.branch = Some(Some("feature/sidebar-pr"))` while leaving other git fields untouched. It decodes `ThreadMetadataUpdateResponse`, inspects the raw JSON result to confirm `thread.sessionId` and nested `thread.gitInfo.branch` serialization, then sends `thread/read` with `include_turns: false` and asserts the read thread still carries the updated git info and idle status.

**Call relations**: This is the main happy-path test for the endpoint and establishes the expected patch semantics and wire contract before the negative and repair tests.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_metadata_update_rejects_empty_git_info_patch`  (lines 134–177)

```
async fn thread_metadata_update_rejects_empty_git_info_patch() -> Result<()>
```

**Purpose**: Checks that a metadata update containing a `gitInfo` object with no actual fields to change is rejected.

**Data flow**: After starting a thread, the test sends `ThreadMetadataUpdateParams` whose `git_info` has `sha: None`, `branch: None`, and `origin_url: None`, waits for a JSON-RPC error, and asserts the message is `gitInfo must include at least one field`.

**Call relations**: This is the validation test for patch shape, ensuring the endpoint distinguishes between omitted fields and explicit clear/set operations.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_metadata_update_rejects_ephemeral_thread`  (lines 180–228)

```
async fn thread_metadata_update_rejects_ephemeral_thread() -> Result<()>
```

**Purpose**: Verifies that ephemeral threads do not support metadata updates.

**Data flow**: The test starts an ephemeral thread via `thread/start` with `ephemeral: Some(true)`, then sends a metadata update that would set a git branch. It reads the resulting `JSONRPCError` and asserts code `-32600` plus a message of the form `ephemeral thread does not support metadata updates: <id>`.

**Call relations**: This covers the unsupported-target branch of the endpoint after a successful ephemeral thread creation.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_metadata_update_repairs_missing_sqlite_row_for_stored_thread`  (lines 231–281)

```
async fn thread_metadata_update_repairs_missing_sqlite_row_for_stored_thread() -> Result<()>
```

**Purpose**: Checks that updating metadata on a stored rollout succeeds even when sqlite has no row yet, by repairing from the rollout file.

**Data flow**: It writes config, initializes sqlite, creates a fake rollout with known preview and timestamp, starts the server, sends a metadata update setting the git branch, decodes the response, and asserts the returned thread preserves the original id, preview, created-at timestamp, and newly patched git info.

**Call relations**: This test exercises the repair-on-demand path for stored threads that exist on disk but are absent from sqlite.

*Call graph*: calls 3 internal fn (new, create_config_toml, init_state_db); 6 external calls (new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_metadata_update_repairs_loaded_thread_without_resetting_summary`  (lines 284–361)

```
async fn thread_metadata_update_repairs_loaded_thread_without_resetting_summary() -> Result<()>
```

**Purpose**: Verifies that if a loaded thread’s sqlite row disappears, a metadata update repairs it without losing existing summary information such as preview.

**Data flow**: The test writes config, initializes sqlite, creates a fake rollout, parses its `ThreadId`, computes the rollout path, and calls `reconcile_rollout` to seed sqlite. It then starts the server, resumes the thread so it is loaded, deletes the sqlite row directly with `state_db.delete_thread`, and sends a metadata update setting a git branch. The decoded response is checked for the original id, preserved preview, original created-at timestamp, and updated git info.

**Call relations**: This is the strongest repair regression test in the file because it combines a loaded in-memory thread with a deliberately missing sqlite row and verifies summary preservation across repair.

*Call graph*: calls 5 internal fn (new, create_config_toml, init_state_db, from_string, reconcile_rollout); 8 external calls (default, new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, rollout_path, assert_eq!, timeout).


##### `thread_metadata_update_repairs_missing_sqlite_row_for_archived_thread`  (lines 364–424)

```
async fn thread_metadata_update_repairs_missing_sqlite_row_for_archived_thread() -> Result<()>
```

**Purpose**: Checks that archived rollouts can also be repaired and updated when sqlite lacks a corresponding row.

**Data flow**: It writes config, initializes sqlite, creates a fake rollout, moves the rollout file into `ARCHIVED_SESSIONS_SUBDIR`, starts the server, sends a metadata update setting a git branch, decodes the response, and asserts id, preview, created-at timestamp, and patched git info are all correct.

**Call relations**: This extends the stored-thread repair path to archived file locations, proving the endpoint searches archived sessions as well.

*Call graph*: calls 3 internal fn (new, create_config_toml, init_state_db); 9 external calls (new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, rollout_path, assert_eq!, create_dir_all, rename, timeout).


##### `thread_metadata_update_can_clear_stored_git_fields`  (lines 427–486)

```
async fn thread_metadata_update_can_clear_stored_git_fields() -> Result<()>
```

**Purpose**: Verifies tri-state patch semantics for clearing git metadata: explicit `Some(None)` values remove stored git fields entirely.

**Data flow**: The test creates a rollout whose session metadata already contains commit hash, branch, and repository URL, initializes sqlite and the server, then sends `ThreadMetadataUpdateParams` with `sha: Some(None)`, `branch: Some(None)`, and `origin_url: Some(None)`. It decodes the response and asserts `updated.git_info == None`, then performs `thread/read` and asserts the cleared state persists.

**Call relations**: This test complements the branch-setting happy path by proving the endpoint supports explicit field clearing rather than only additive updates.

*Call graph*: calls 4 internal fn (new, create_config_toml, init_state_db, new); 6 external calls (new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `init_state_db`  (lines 488–494)

```
async fn init_state_db(codex_home: &Path) -> Result<Arc<StateRuntime>>
```

**Purpose**: Initializes sqlite state for the temporary Codex home and marks backfill complete.

**Data flow**: It calls `StateRuntime::init` with the temp home and provider `mock_provider`, awaits `mark_backfill_complete(None)`, and returns the resulting `Arc<StateRuntime>`.

**Call relations**: The repair-oriented tests call this helper so they can manipulate sqlite rows directly or rely on sqlite-backed metadata repair.

*Call graph*: calls 1 internal fn (init); called by 4 (thread_metadata_update_can_clear_stored_git_fields, thread_metadata_update_repairs_loaded_thread_without_resetting_summary, thread_metadata_update_repairs_missing_sqlite_row_for_archived_thread, thread_metadata_update_repairs_missing_sqlite_row_for_stored_thread); 1 external calls (to_path_buf).


##### `create_config_toml`  (lines 496–521)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes the sqlite-enabled runtime config used by all metadata-update tests.

**Data flow**: It formats TOML with model defaults, `sandbox_mode`, `model_provider`, `suppress_unstable_features_warning = true`, `[features] sqlite = true`, and the mock provider block using the supplied server URI, then writes it to `config.toml`.

**Call relations**: Every test in the file uses this helper during setup because metadata updates are validated against sqlite-backed thread state.

*Call graph*: called by 7 (thread_metadata_update_can_clear_stored_git_fields, thread_metadata_update_patches_git_branch_and_returns_updated_thread, thread_metadata_update_rejects_empty_git_info_patch, thread_metadata_update_rejects_ephemeral_thread, thread_metadata_update_repairs_loaded_thread_without_resetting_summary, thread_metadata_update_repairs_missing_sqlite_row_for_archived_thread, thread_metadata_update_repairs_missing_sqlite_row_for_stored_thread); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/thread_name_websocket.rs`

`test` · `request handling`

This file exercises the websocket transport rather than the in-process test harness. It imports a shared websocket test toolkit that can spawn the app-server process, connect websocket clients, send JSON-RPC requests, and read responses and notifications by method or id. Each test creates a temporary Codex home, writes websocket-compatible config, seeds a stored rollout, starts the websocket server process, and then drives two independent websocket clients through initialization.

The first test resumes the thread on one client so it is loaded, then renames it and verifies both the initiating client and the second client receive a `thread/name/updated` notification with the same thread id and new name. The second test performs the same rename without loading the thread first, proving the broadcast path also works for stored-only threads. Both tests additionally verify the legacy thread-name persistence layer by reading the stored name back through `find_thread_name_by_id`, and they assert no extra websocket messages arrive after the expected notification. Helper functions encapsulate dual-client initialization, rollout creation with text elements, notification decoding into `ThreadNameUpdatedNotification`, and legacy-name verification.

#### Function details

##### `thread_name_updated_broadcasts_for_loaded_threads`  (lines 33–96)

```
async fn thread_name_updated_broadcasts_for_loaded_threads() -> Result<()>
```

**Purpose**: Verifies that renaming a thread already loaded into the server broadcasts `thread/name/updated` to both the initiating websocket client and other connected clients.

**Data flow**: The test starts a mock model server, writes config, creates a stored rollout, spawns the websocket app-server process, connects two websocket clients, and initializes both via `initialize_both_clients`. Client 1 sends `thread/resume` for the rollout and confirms the resumed thread id, then sends `thread/name/set` with a new name. It reads the rename response plus one `thread/name/updated` notification on client 1, reads the same notification on client 2, validates both with `assert_thread_name_updated`, checks persisted legacy name storage with `assert_legacy_thread_name`, and finally asserts no extra messages arrive on either socket. The process is killed at the end regardless of test result.

**Call relations**: This is the loaded-thread websocket broadcast test. It depends on the shared websocket helpers for transport and on local helpers for initialization and notification validation.

*Call graph*: calls 12 internal fn (assert_no_message, connect_websocket, create_config_toml, read_notification_for_method, read_response_and_notification_for_method, read_response_for_id, send_request, spawn_websocket_server, assert_legacy_thread_name, assert_thread_name_updated (+2 more)); 6 external calls (default, from_millis, new, create_mock_responses_server_repeating_assistant, assert_eq!, to_value).


##### `thread_name_updated_broadcasts_for_not_loaded_threads`  (lines 99–148)

```
async fn thread_name_updated_broadcasts_for_not_loaded_threads() -> Result<()>
```

**Purpose**: Checks that renaming a stored thread that has not been resumed still broadcasts `thread/name/updated` to all websocket clients.

**Data flow**: The setup mirrors the loaded-thread test except no `thread/resume` request is sent. Client 1 sends `thread/name/set`, receives the response and one notification, client 2 receives the broadcast notification, both notifications are validated, the persisted legacy name is checked on disk, and both sockets are verified to remain quiet afterward. The spawned process is then terminated.

**Call relations**: This complements the loaded-thread case by proving the broadcast path is not limited to in-memory loaded threads.

*Call graph*: calls 11 internal fn (assert_no_message, connect_websocket, create_config_toml, read_notification_for_method, read_response_and_notification_for_method, send_request, spawn_websocket_server, assert_legacy_thread_name, assert_thread_name_updated, create_rollout (+1 more)); 4 external calls (from_millis, new, create_mock_responses_server_repeating_assistant, to_value).


##### `initialize_both_clients`  (lines 150–157)

```
async fn initialize_both_clients(ws1: &mut WsClient, ws2: &mut WsClient) -> Result<()>
```

**Purpose**: Performs the websocket `initialize` handshake for two clients in sequence.

**Data flow**: It takes mutable references to two `WsClient`s, sends initialize requests with ids 1 and 2 and distinct client names, waits under `DEFAULT_READ_TIMEOUT` for each matching response, and returns success once both handshakes complete.

**Call relations**: Both websocket rename tests call this helper immediately after connecting sockets so later requests can be sent on fully initialized sessions.

*Call graph*: calls 2 internal fn (read_response_for_id, send_initialize_request); called by 2 (thread_name_updated_broadcasts_for_loaded_threads, thread_name_updated_broadcasts_for_not_loaded_threads); 1 external calls (timeout).


##### `create_rollout`  (lines 159–169)

```
fn create_rollout(codex_home: &std::path::Path, filename_ts: &str) -> Result<String>
```

**Purpose**: Creates a fake stored rollout with empty text elements for websocket rename tests.

**Data flow**: It takes the Codex home path and a filename timestamp, then delegates to `create_fake_rollout_with_text_elements` using a fixed RFC3339 timestamp, preview `Saved user message`, an empty text-element vector, provider `mock_provider`, and no git info. It returns the created conversation id.

**Call relations**: Both websocket tests use this helper to seed the thread that will later be renamed.

*Call graph*: called by 2 (thread_name_updated_broadcasts_for_loaded_threads, thread_name_updated_broadcasts_for_not_loaded_threads); 2 external calls (new, create_fake_rollout_with_text_elements).


##### `assert_thread_name_updated`  (lines 171–181)

```
fn assert_thread_name_updated(
    notification: JSONRPCNotification,
    thread_id: &str,
    thread_name: &str,
) -> Result<()>
```

**Purpose**: Decodes a generic JSON-RPC notification into `ThreadNameUpdatedNotification` and checks its thread id and name fields.

**Data flow**: It takes a `JSONRPCNotification`, extracts `params` with context, deserializes them into `ThreadNameUpdatedNotification`, asserts `thread_id` equals the expected id and `thread_name` equals the expected string, and returns success.

**Call relations**: Both websocket tests use this helper for notifications received on both clients so the assertions stay identical across loaded and not-loaded cases.

*Call graph*: called by 2 (thread_name_updated_broadcasts_for_loaded_threads, thread_name_updated_broadcasts_for_not_loaded_threads); 2 external calls (assert_eq!, from_value).


##### `assert_legacy_thread_name`  (lines 183–196)

```
async fn assert_legacy_thread_name(
    codex_home: &Path,
    conversation_id: &str,
    expected_name: &str,
) -> Result<()>
```

**Purpose**: Verifies that the renamed thread title was persisted to the legacy thread-name storage indexed by `ThreadId`.

**Data flow**: It parses the conversation id string into `ThreadId`, calls `find_thread_name_by_id` against the Codex home, and asserts the returned optional string matches the expected name.

**Call relations**: Both websocket tests call this helper after receiving notifications to ensure broadcast and persistence stay in sync.

*Call graph*: calls 1 internal fn (from_string); called by 2 (thread_name_updated_broadcasts_for_loaded_threads, thread_name_updated_broadcasts_for_not_loaded_threads); 1 external calls (assert_eq!).


### `app-server/tests/suite/v2/thread_rollback.rs`

`test` · `request handling and persisted history mutation`

This file contains a single end-to-end rollback scenario plus a local config writer. The test stands up a mock Responses API server with three canned assistant completions—one for thread initialization and one for each of two user turns—then drives the app server through `thread/start`, two `turn/start` calls, and finally `thread/rollback`. The assertions are intentionally concrete: after rollback, the returned `ThreadRollbackResponse` must contain exactly one remaining turn, thread status must be `Idle`, and the surviving turn must still contain the original first user message as a `ThreadItem::UserMessage` with `V2UserInput::Text` content.

The test also inspects the raw JSON-RPC result object rather than only the typed response. That verifies the wire contract that the thread title field is serialized as `name: null` when unset and that `sessionId` remains nested under the `thread` object. To prove rollback persistence rather than just in-memory mutation, the test immediately issues `thread/resume` for the same thread id and reasserts that only the first turn remains. The helper `create_config_toml` writes a minimal mock-provider configuration with `approval_policy = "never"` and `sandbox_mode = "read-only"`, keeping the scenario focused on rollback semantics rather than approval or sandbox behavior.

#### Function details

##### `thread_rollback_drops_last_turns_and_persists_to_rollout`  (lines 26–182)

```
async fn thread_rollback_drops_last_turns_and_persists_to_rollout() -> Result<()>
```

**Purpose**: Creates a thread with two completed turns, rolls back the most recent turn, and verifies the rollback is visible both immediately and after a later resume from persisted rollout state.

**Data flow**: It builds a mock server with three assistant responses, writes config, initializes `TestAppServer`, starts a thread, sends two `turn/start` requests with user texts `First` and `Second`, and waits for both completions. It then sends `thread/rollback` with `num_turns: 1`, parses the typed response and raw JSON result, asserts nullable `name` serialization and preserved `session_id`, and checks only the first turn remains. Finally it sends `thread/resume`, parses `ThreadResumeResponse`, and reasserts the same one-turn history.

**Call relations**: This is the file’s sole integration test. It uses the local `create_config_toml` helper for setup and relies on `thread/resume` as the persistence check after the rollback API mutates stored rollout history.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, panic!, timeout, vec!).


##### `create_config_toml`  (lines 184–205)

```
fn create_config_toml(codex_home: &std::path::Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes the minimal mock-provider configuration needed for rollback tests.

**Data flow**: It joins `config.toml` under the supplied Codex home, formats TOML with model `mock-model`, approval policy `never`, sandbox `read-only`, and the supplied mock server base URL, then writes the file.

**Call relations**: Called only by `thread_rollback_drops_last_turns_and_persists_to_rollout` to point the app server at the canned Responses API server.

*Call graph*: called by 1 (thread_rollback_drops_last_turns_and_persists_to_rollout); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/thread_settings_update.rs`

`test` · `request handling and per-thread configuration updates`

This test file focuses on mutable thread configuration after creation. The tests use `TestAppServer` plus mock Responses API servers to update settings such as `model`, `service_tier`, `cwd`, and sandbox-related fields through `thread/settings/update`, then verify both protocol notifications and downstream model requests. The central pattern is: start a thread, send a settings update, read the `thread/settings/updated` notification, then start a later turn and inspect either the persisted thread state or the actual request body sent to the mock model server.

Several helpers keep the tests concise. `start_thread` creates a thread with `mock-model`; `start_text_turn` starts a simple `hello` turn and asserts a non-empty turn id; `send_thread_settings_update` wraps the request/response round trip; `read_thread_settings_updated` waits for and deserializes the notification; and `received_response_bodies` extracts only `/responses` request payloads from wiremock. `service_tier_model_and_tier_id` pulls a real bundled model preset that exposes service tiers, so tests validate against actual catalog data rather than hard-coded ids.

The scenarios cover both positive and negative behavior: settings-only updates must not trigger model requests; changing `cwd` must alter the `<environment_context>` visible to the model; updates during an active turn still emit notifications; clearing `service_tier` with `null` should revert to the default request behavior by omitting the field from future model requests; and combining `permissions` with `sandboxPolicy` is rejected as invalid. A final test proves that a `TurnStartParams.model` override also updates thread settings and emits the same notification channel.

#### Function details

##### `thread_settings_update_emits_notification_and_updates_future_turns`  (lines 37–95)

```
async fn thread_settings_update_emits_notification_and_updates_future_turns() -> Result<()>
```

**Purpose**: Verifies that updating a thread’s model and service tier emits a settings-updated notification and affects the next model request, without itself starting a turn.

**Data flow**: It creates config and a models cache, selects a real service-tier-capable model via `service_tier_model_and_tier_id`, starts a thread, sends `ThreadSettingsUpdateParams` with `model` and `service_tier`, and asserts the mock server has seen no `/responses` requests yet. It then starts a text turn, reads the `ThreadSettingsUpdatedNotification`, waits for completion, reads the thread with turns, and inspects captured request bodies to confirm one request used the updated model and service tier.

**Call relations**: This test orchestrates most of the file’s helpers: it uses `send_thread_settings_update`, `start_thread`, `start_text_turn`, `read_thread_settings_updated`, `read_thread_with_turns`, `received_response_bodies`, and `service_tier_model_and_tier_id` to prove both notification and future-turn application.

*Call graph*: calls 9 internal fn (new, create_config_toml, read_thread_settings_updated, read_thread_with_turns, received_response_bodies, send_thread_settings_update, service_tier_model_and_tier_id, start_text_turn, start_thread); 8 external calls (default, new, create_mock_responses_server_sequence_unchecked, write_models_cache, assert!, assert_eq!, timeout, vec!).


##### `thread_settings_update_cwd_retargets_default_environment`  (lines 98–148)

```
async fn thread_settings_update_cwd_retargets_default_environment() -> Result<()>
```

**Purpose**: Checks that changing a thread’s `cwd` updates the default environment context used for subsequent turns.

**Data flow**: It starts a thread, sends a settings update with a new workspace path as `cwd`, reads the resulting notification and asserts the stored cwd matches, then starts a text turn and waits for completion. Finally it inspects the single captured model request and extracts the user-visible `<environment_context>` block, asserting it contains the updated cwd.

**Call relations**: This test uses `send_thread_settings_update`, `read_thread_settings_updated`, `start_text_turn`, and `start_thread`; unlike the service-tier tests, it validates behavior by inspecting the model-visible prompt content rather than top-level request fields.

*Call graph*: calls 9 internal fn (new, create_config_toml, read_thread_settings_updated, send_thread_settings_update, start_text_turn, start_thread, mount_sse_once, sse, start_mock_server); 6 external calls (default, new, assert!, assert_eq!, timeout, vec!).


##### `thread_settings_update_while_turn_is_active_emits_notification`  (lines 151–190)

```
async fn thread_settings_update_while_turn_is_active_emits_notification() -> Result<()>
```

**Purpose**: Ensures thread settings can be updated while a turn is already active and that the update still emits the standard notification immediately.

**Data flow**: It mounts a delayed model response so a turn stays active, starts a thread, starts a text turn, waits for `turn/started`, sends a settings update changing the model, reads the `thread/settings/updated` notification, asserts the thread id and model, and then waits for the original turn to complete.

**Call relations**: This test specifically targets concurrent state mutation during an active turn, reusing `start_thread`, `start_text_turn`, `send_thread_settings_update`, and `read_thread_settings_updated`.

*Call graph*: calls 9 internal fn (new, create_config_toml, read_thread_settings_updated, send_thread_settings_update, start_text_turn, start_thread, mount_response_sequence, sse_response, start_mock_server); 7 external calls (default, from_secs, new, create_final_assistant_message_sse_response, assert_eq!, timeout, vec!).


##### `thread_settings_update_null_service_tier_uses_default`  (lines 193–261)

```
async fn thread_settings_update_null_service_tier_uses_default() -> Result<()>
```

**Purpose**: Verifies that sending `service_tier: null` clears an explicit service tier and returns the thread to default request behavior.

**Data flow**: It starts a thread, sets both model and service tier, reads and validates the first settings-updated notification, then sends another settings update with `service_tier: Some(None)`. After reading the second notification, it asserts the thread still reports the chosen model but now reports the default service-tier request value. It then starts a turn, waits for completion, and inspects captured request bodies to confirm a request used the model while omitting the `service_tier` field entirely.

**Call relations**: This test uses the same helper stack as the first service-tier test but focuses on the clear/reset branch and the distinction between notification state and serialized outbound request fields.

*Call graph*: calls 8 internal fn (new, create_config_toml, read_thread_settings_updated, received_response_bodies, send_thread_settings_update, service_tier_model_and_tier_id, start_text_turn, start_thread); 8 external calls (default, new, create_mock_responses_server_sequence_unchecked, write_models_cache, assert!, assert_eq!, timeout, vec!).


##### `thread_settings_update_rejects_sandbox_policy_with_permissions`  (lines 264–292)

```
async fn thread_settings_update_rejects_sandbox_policy_with_permissions() -> Result<()>
```

**Purpose**: Checks validation that `sandboxPolicy` and `permissions` cannot be supplied together in a thread settings update.

**Data flow**: It starts a thread, sends `ThreadSettingsUpdateParams` containing both `sandbox_policy: DangerFullAccess` and `permissions: ":workspace"`, reads the JSON-RPC error for that request id, and asserts the exact validation message.

**Call relations**: This is the file’s negative validation test; it uses `start_thread` for setup and then directly exercises the raw error path of `send_thread_settings_update_request` rather than the success wrapper helper.

*Call graph*: calls 3 internal fn (new, create_config_toml, start_thread); 7 external calls (default, new, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, timeout).


##### `turn_start_settings_override_emits_thread_settings_updated`  (lines 295–342)

```
async fn turn_start_settings_override_emits_thread_settings_updated() -> Result<()>
```

**Purpose**: Verifies that a turn-level settings override, specifically `TurnStartParams.model`, updates the thread’s stored settings and emits the same `thread/settings/updated` notification channel.

**Data flow**: It starts a thread, waits for `thread/started`, sends `turn/start` with `model: mock-model-3`, parses the turn response and asserts a non-empty turn id, then reads the settings-updated notification and checks the thread id and updated model before waiting for turn completion.

**Call relations**: This test complements the explicit settings-update API tests by proving that turn-start overrides feed into the same thread-settings state machine and notification mechanism.

*Call graph*: calls 4 internal fn (new, create_config_toml, read_thread_settings_updated, start_thread); 9 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert!, assert_eq!, timeout, vec!).


##### `send_thread_settings_update`  (lines 344–356)

```
async fn send_thread_settings_update(
    mcp: &mut TestAppServer,
    params: ThreadSettingsUpdateParams,
) -> Result<()>
```

**Purpose**: Convenience wrapper that sends a thread settings update request and asserts it succeeds with a typed `ThreadSettingsUpdateResponse`.

**Data flow**: It takes a mutable `TestAppServer` and `ThreadSettingsUpdateParams`, sends the request, waits for the matching JSON-RPC response under `DEFAULT_TIMEOUT`, deserializes it to `ThreadSettingsUpdateResponse`, and returns `Ok(())` if successful.

**Call relations**: Used by the positive settings-update tests so they can focus on notifications and downstream effects rather than repetitive request/response plumbing.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_settings_update_request); called by 4 (thread_settings_update_cwd_retargets_default_environment, thread_settings_update_emits_notification_and_updates_future_turns, thread_settings_update_null_service_tier_uses_default, thread_settings_update_while_turn_is_active_emits_notification); 3 external calls (Integer, to_response, timeout).


##### `start_text_turn`  (lines 358–377)

```
async fn start_text_turn(mcp: &mut TestAppServer, thread_id: String) -> Result<()>
```

**Purpose**: Starts a simple text turn on an existing thread and asserts the server returns a non-empty turn id.

**Data flow**: It sends `turn/start` with one `V2UserInput::Text { text: "hello" }`, waits for the response, deserializes `TurnStartResponse`, asserts `turn.id` is not empty, and returns success.

**Call relations**: Shared by tests that need a minimal future turn after changing settings, and by the active-turn update test to create a running turn before mutating settings.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_turn_start_request); called by 4 (thread_settings_update_cwd_retargets_default_environment, thread_settings_update_emits_notification_and_updates_future_turns, thread_settings_update_null_service_tier_uses_default, thread_settings_update_while_turn_is_active_emits_notification); 6 external calls (default, Integer, to_response, assert!, timeout, vec!).


##### `start_thread`  (lines 379–392)

```
async fn start_thread(mcp: &mut TestAppServer) -> Result<ThreadStartResponse>
```

**Purpose**: Creates a thread using the standard `mock-model` setup and returns the full typed start response.

**Data flow**: It sends `thread/start` with `model: Some("mock-model")`, waits for the matching response, and deserializes it into `ThreadStartResponse`.

**Call relations**: This helper is the common setup entry for nearly every test in the file before settings are mutated or validated.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_start_request); called by 6 (thread_settings_update_cwd_retargets_default_environment, thread_settings_update_emits_notification_and_updates_future_turns, thread_settings_update_null_service_tier_uses_default, thread_settings_update_rejects_sandbox_policy_with_permissions, thread_settings_update_while_turn_is_active_emits_notification, turn_start_settings_override_emits_thread_settings_updated); 4 external calls (default, Integer, to_response, timeout).


##### `read_thread_with_turns`  (lines 394–410)

```
async fn read_thread_with_turns(
    mcp: &mut TestAppServer,
    thread_id: &str,
) -> Result<ThreadReadResponse>
```

**Purpose**: Reads a thread including its turns and returns the typed `ThreadReadResponse`.

**Data flow**: It sends `thread/read` with the supplied thread id and `include_turns: true`, waits for the response, and deserializes it.

**Call relations**: Used only by `thread_settings_update_emits_notification_and_updates_future_turns` to confirm the thread still has the expected persisted turn history after settings changes.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_read_request); called by 1 (thread_settings_update_emits_notification_and_updates_future_turns); 3 external calls (Integer, to_response, timeout).


##### `read_thread_settings_updated`  (lines 412–424)

```
async fn read_thread_settings_updated(
    mcp: &mut TestAppServer,
) -> Result<ThreadSettingsUpdatedNotification>
```

**Purpose**: Waits for the next `thread/settings/updated` notification and deserializes its params into the typed notification payload.

**Data flow**: It waits under `DEFAULT_TIMEOUT` for a notification with method `thread/settings/updated`, extracts `params`, errors if they are missing, and converts them from JSON into `ThreadSettingsUpdatedNotification`.

**Call relations**: This helper is the notification synchronization point for all tests that expect settings changes to be broadcast.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 5 (thread_settings_update_cwd_retargets_default_environment, thread_settings_update_emits_notification_and_updates_future_turns, thread_settings_update_null_service_tier_uses_default, thread_settings_update_while_turn_is_active_emits_notification, turn_start_settings_override_emits_thread_settings_updated); 2 external calls (from_value, timeout).


##### `received_response_bodies`  (lines 426–438)

```
async fn received_response_bodies(server: &wiremock::MockServer) -> Result<Vec<Value>>
```

**Purpose**: Collects the JSON bodies of all recorded mock-server requests sent to the `/responses` endpoint.

**Data flow**: It fetches recorded requests from `wiremock::MockServer`, filters them by URL path suffix `/responses`, parses each body as `serde_json::Value`, and returns the resulting vector.

**Call relations**: Used by the service-tier tests to prove whether a settings update itself triggered model traffic and what fields later turn requests actually serialized.

*Call graph*: called by 2 (thread_settings_update_emits_notification_and_updates_future_turns, thread_settings_update_null_service_tier_uses_default); 2 external calls (received_requests, new).


##### `service_tier_model_and_tier_id`  (lines 440–446)

```
fn service_tier_model_and_tier_id() -> Result<(String, String)>
```

**Purpose**: Selects a real bundled model preset that is visible in the picker and has at least one service tier, returning both ids for use in tests.

**Data flow**: It iterates over `all_model_presets()`, finds the first preset with `show_in_picker` and a non-empty `service_tiers` list, and returns `(model.id, first_service_tier.id)`. It errors if no such preset exists.

**Call relations**: Called by the service-tier tests so they validate against actual catalog data rather than synthetic ids that might not be accepted by the server.

*Call graph*: calls 1 internal fn (all_model_presets); called by 2 (thread_settings_update_emits_notification_and_updates_future_turns, thread_settings_update_null_service_tier_uses_default).


##### `create_config_toml`  (lines 448–458)

```
fn create_config_toml(codex_home: &std::path::Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes the standard mock Responses API configuration used by these settings-update tests, including compaction-related defaults.

**Data flow**: It delegates to `write_mock_responses_config_toml`, passing the Codex home, server URI, an empty feature map, auto-compact limit `200_000`, no auth requirement override, provider name `mock_provider`, and compaction mode `compact`.

**Call relations**: This helper is used by every test in the file to create a consistent baseline configuration before thread creation and settings mutation.

*Call graph*: called by 6 (thread_settings_update_cwd_retargets_default_environment, thread_settings_update_emits_notification_and_updates_future_turns, thread_settings_update_null_service_tier_uses_default, thread_settings_update_rejects_sandbox_policy_with_permissions, thread_settings_update_while_turn_is_active_emits_notification, turn_start_settings_override_emits_thread_settings_updated); 2 external calls (default, write_mock_responses_config_toml).


### `app-server/tests/suite/v2/thread_unarchive.rs`

`test` · `archive/unarchive operations and persistence restoration`

This file covers the `thread/unarchive` API in two persistence modes. The first test uses the normal rollout-file path: it starts and materializes a thread, confirms the active rollout path can be found by thread id, archives the thread, manually backdates the archived file’s modification time, and then unarchives it. The assertions check both protocol and filesystem effects: `thread/unarchived` notification arrives, `updated_at` is bumped beyond the old timestamp, thread status becomes `NotLoaded`, nullable `name` is serialized as `null`, the original sessions-path rollout exists again, and the archived-path file has been removed.

The second test targets the experimental in-memory thread store. Instead of using `TestAppServer`, it constructs an in-process app-server client with a config pointing at an `InMemoryThreadStore` identified by a generated store id. It seeds the store directly with a pathless thread, a `forked_from_id`, and a metadata patch that sets a thread name, then sends a `ThreadUnarchive` client request. The response must preserve pathless metadata (`path: None`) and return the stored fork and name fields unchanged.

Supporting helpers include `config_contents` and two config writers, plus `assert_paths_match_on_disk` for canonicalized path equality. The `InMemoryThreadStoreId` wrapper implements `Drop` to call `InMemoryThreadStore::remove_id`, ensuring the globally registered test store is cleaned up after the test and does not leak across runs.

#### Function details

##### `thread_unarchive_moves_rollout_back_into_sessions_directory`  (lines 57–198)

```
async fn thread_unarchive_moves_rollout_back_into_sessions_directory() -> Result<()>
```

**Purpose**: Verifies that unarchiving a normal persisted thread moves its rollout file from the archived sessions directory back into the active sessions directory and updates thread metadata accordingly.

**Data flow**: It writes config, starts and materializes a thread, captures its rollout path, confirms `find_thread_path_by_id_str` resolves that path, archives the thread, resolves the archived path with `find_archived_thread_path_by_id_str`, backdates the archived file’s mtime to one second after the Unix epoch, then sends `thread/unarchive`. It parses the typed response and raw JSON result, reads the `thread/unarchived` notification, asserts the notification thread id, checks `updated_at` increased beyond the old timestamp, status is `NotLoaded`, `name` serializes as `null`, the original rollout path exists again, and the archived path no longer exists.

**Call relations**: This is the primary on-disk unarchive integration test. It uses `assert_paths_match_on_disk` to compare discovered and returned rollout paths before archiving.

*Call graph*: calls 3 internal fn (new, assert_paths_match_on_disk, create_config_toml); 14 external calls (default, from_secs, new, new, new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, find_archived_thread_path_by_id_str (+4 more)).


##### `thread_unarchive_preserves_pathless_store_metadata`  (lines 201–293)

```
async fn thread_unarchive_preserves_pathless_store_metadata() -> Result<()>
```

**Purpose**: Checks that unarchiving a thread from the experimental in-memory thread store preserves metadata for threads that have no filesystem path.

**Data flow**: It creates a unique in-memory store id and config, obtains the `InMemoryThreadStore`, seeds it directly with a pathless thread containing `forked_from_id`, source metadata, and disabled memory mode, then updates metadata to set a thread name. It builds an in-process app-server client with test loader overrides and environment manager, sends a `ClientRequest::ThreadUnarchive`, deserializes `ThreadUnarchiveResponse`, and asserts the returned thread id, `path: None`, preserved `forked_from_id`, and preserved `name`. Finally it shuts down the client.

**Call relations**: Unlike the file-based test, this one bypasses `TestAppServer` and uses the in-process server API to exercise unarchive behavior against the alternate thread-store backend.

*Call graph*: calls 9 internal fn (start, create_config_toml_with_in_memory_thread_store, default, without_managed_config_for_tests, default_for_tests, new, default, from_string, for_id); 10 external calls (new, default, new, new_v4, new, Integer, default, assert_eq!, default, from_value).


##### `create_config_toml`  (lines 295–298)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes the standard file-backed unarchive test configuration using the shared config string builder.

**Data flow**: It joins `config.toml` under the supplied Codex home and writes the string returned by `config_contents(server_uri)`.

**Call relations**: Used only by `thread_unarchive_moves_rollout_back_into_sessions_directory` for the normal rollout-file scenario.

*Call graph*: calls 1 internal fn (config_contents); called by 1 (thread_unarchive_moves_rollout_back_into_sessions_directory); 2 external calls (join, write).


##### `InMemoryThreadStoreId::drop`  (lines 305–307)

```
fn drop(&mut self)
```

**Purpose**: Removes the globally registered in-memory thread store id when the guard object goes out of scope.

**Data flow**: On drop, it reads `self.store_id` and calls `InMemoryThreadStore::remove_id(&self.store_id)`. It returns no value and performs cleanup as a side effect.

**Call relations**: This destructor is triggered automatically after `thread_unarchive_preserves_pathless_store_metadata`, ensuring the test-created in-memory store registration does not leak into other tests.

*Call graph*: calls 1 internal fn (remove_id).


##### `create_config_toml_with_in_memory_thread_store`  (lines 310–334)

```
fn create_config_toml_with_in_memory_thread_store(
    codex_home: &Path,
    store_id: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes a config that enables the experimental in-memory thread store with a specific store id.

**Data flow**: It writes `config.toml` containing model `mock-model`, approval policy `never`, read-only sandbox, `experimental_thread_store = { type = "in_memory", id = "..." }`, and a dummy mock provider URL.

**Call relations**: Used only by `thread_unarchive_preserves_pathless_store_metadata` to point the in-process app server at the seeded in-memory store.

*Call graph*: called by 1 (thread_unarchive_preserves_pathless_store_metadata); 3 external calls (join, format!, write).


##### `config_contents`  (lines 336–352)

```
fn config_contents(server_uri: &str) -> String
```

**Purpose**: Builds the standard TOML string for file-backed unarchive tests.

**Data flow**: It formats and returns a string containing model `mock-model`, approval policy `never`, read-only sandbox, provider `mock_provider`, and the supplied mock server URL.

**Call relations**: Consumed by `create_config_toml` so the file-backed unarchive test can share a single config template.

*Call graph*: called by 1 (create_config_toml); 1 external calls (format!).


##### `assert_paths_match_on_disk`  (lines 354–359)

```
fn assert_paths_match_on_disk(actual: &Path, expected: &Path) -> std::io::Result<()>
```

**Purpose**: Asserts that two filesystem paths resolve to the same canonical on-disk location.

**Data flow**: It canonicalizes both `actual` and `expected` paths and asserts equality of the resulting canonical `PathBuf`s, returning any I/O error from canonicalization.

**Call relations**: Used by `thread_unarchive_moves_rollout_back_into_sessions_directory` to verify that the path discovered by thread-id lookup matches the rollout path returned at thread creation.

*Call graph*: called by 1 (thread_unarchive_moves_rollout_back_into_sessions_directory); 2 external calls (canonicalize, assert_eq!).


### `app-server/tests/suite/v2/thread_unsubscribe.rs`

`test` · `subscription management during idle and active thread lifetimes`

This file exercises `thread/unsubscribe` as a subscription-management API rather than a destructive close. The first test starts a thread, unsubscribes, and proves the thread remains loaded for at least a short idle window: no immediate `thread/closed` notification arrives, and `thread/loaded/list` still returns the thread id. The second test covers the more important active-turn case. It uses a streaming SSE server to produce a deterministic dynamic-tool call followed by a final assistant response, starts a thread with a dynamic tool definition, begins a turn that triggers that tool, captures the `DynamicToolCall` server request, unsubscribes while the tool call is still blocked, and confirms the thread is not closed. After replying to the tool call, the turn continues to completion, proving unsubscribe does not cancel in-flight work.

The remaining tests focus on cached state and idempotence. One forces a turn failure so the thread enters `ThreadStatus::SystemError`, unsubscribes, and then resumes the thread to verify the cached error status is preserved before idle unload. Another unsubscribes twice and checks the second response reports `ThreadUnsubscribeStatus::NotSubscribed` rather than pretending to unsubscribe again.

Helpers include `wait_for_dynamic_tool_started`, which filters `item/started` notifications until it finds a `ThreadItem::DynamicToolCall` with the expected call id; `start_thread`, which wraps `thread/start` and returns only the thread id; and a simple config writer that enables `danger-full-access` sandboxing so dynamic tool execution is not blocked by filesystem restrictions.

#### Function details

##### `thread_unsubscribe_keeps_thread_loaded_until_idle_timeout`  (lines 40–86)

```
async fn thread_unsubscribe_keeps_thread_loaded_until_idle_timeout() -> Result<()>
```

**Purpose**: Verifies that unsubscribing from an idle thread removes the subscription immediately but does not unload the thread right away.

**Data flow**: It writes config, initializes the server, starts a thread via `start_thread`, sends `thread/unsubscribe`, parses `ThreadUnsubscribeResponse`, and asserts status `Unsubscribed`. It then waits briefly to ensure no `thread/closed` notification arrives, calls `thread/loaded/list`, parses `ThreadLoadedListResponse`, and asserts the unsubscribed thread id is still present with no pagination cursor.

**Call relations**: This is the baseline unsubscribe test, using `start_thread` for setup and `thread/loaded/list` as the observable proof that unsubscribe is not equivalent to immediate unload.

*Call graph*: calls 3 internal fn (new, create_config_toml, start_thread); 7 external calls (new, Integer, default, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout).


##### `thread_unsubscribe_during_turn_keeps_turn_running`  (lines 89–243)

```
async fn thread_unsubscribe_during_turn_keeps_turn_running() -> Result<()>
```

**Purpose**: Checks that unsubscribing while a turn is blocked on a dynamic tool call does not close the thread or cancel the in-flight turn.

**Data flow**: It starts a streaming SSE server that first emits a function call and later a final assistant message, writes config, initializes the app server, starts a thread with a dynamic tool spec, and starts a turn that triggers that tool. After confirming the first model response completed and waiting for the matching dynamic-tool `item/started`, it reads the `ServerRequest::DynamicToolCall` and asserts its params. It then sends `thread/unsubscribe`, asserts status `Unsubscribed`, verifies no `thread/closed` arrives while the tool call is still blocked, sends a successful `DynamicToolCallResponse`, waits for the second model request and final response completion, and shuts down the mock server.

**Call relations**: This test uses `wait_for_dynamic_tool_started` to synchronize on the blocked tool call and demonstrates that unsubscribe affects only client subscription state, not the thread’s execution pipeline.

*Call graph*: calls 4 internal fn (new, create_config_toml, wait_for_dynamic_tool_started, start_streaming_sse_server); 13 external calls (default, new, Integer, assert!, assert_eq!, json!, panic!, to_string, to_value, create_dir (+3 more)).


##### `thread_unsubscribe_preserves_cached_status_before_idle_unload`  (lines 246–335)

```
async fn thread_unsubscribe_preserves_cached_status_before_idle_unload() -> Result<()>
```

**Purpose**: Verifies that unsubscribing does not discard the thread’s cached terminal status before the thread is eventually unloaded for idleness.

**Data flow**: It mounts a failing SSE response, starts a thread, starts a turn that fails, waits for an `error` notification, reads the thread without turns and asserts status `SystemError`, unsubscribes and confirms no immediate `thread/closed`, then resumes the thread with an explicit cwd and asserts the resumed thread still reports `ThreadStatus::SystemError`.

**Call relations**: This test combines unsubscribe with a later resume to prove cached status survives the unsubscribe window and is not reset to idle merely because the client detached.

*Call graph*: calls 6 internal fn (new, create_config_toml, start_thread, mount_sse_once, sse_failed, start_mock_server); 7 external calls (default, new, Integer, assert!, assert_eq!, timeout, vec!).


##### `thread_unsubscribe_reports_not_subscribed_before_idle_unload`  (lines 338–379)

```
async fn thread_unsubscribe_reports_not_subscribed_before_idle_unload() -> Result<()>
```

**Purpose**: Checks idempotence semantics for unsubscribe requests before the thread has been unloaded: the first call unsubscribes, the second reports `NotSubscribed`.

**Data flow**: It writes config, initializes the server, starts a thread, sends `thread/unsubscribe` twice for the same thread id, parses both `ThreadUnsubscribeResponse`s, and asserts the first status is `Unsubscribed` while the second is `NotSubscribed`.

**Call relations**: This test isolates subscription bookkeeping independent of thread unloading or execution state.

*Call graph*: calls 3 internal fn (new, create_config_toml, start_thread); 5 external calls (new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `wait_for_dynamic_tool_started`  (lines 381–397)

```
async fn wait_for_dynamic_tool_started(
    mcp: &mut TestAppServer,
    call_id: &str,
) -> Result<ItemStartedNotification>
```

**Purpose**: Loops until it sees an `item/started` notification for a dynamic tool call with the specified call id.

**Data flow**: It repeatedly reads `item/started` notifications, skips any without params, deserializes params into `ItemStartedNotification`, and returns the first notification whose `item` matches `ThreadItem::DynamicToolCall { id, .. }` with the requested `call_id`.

**Call relations**: Used only by `thread_unsubscribe_during_turn_keeps_turn_running` to synchronize on the exact dynamic tool invocation before unsubscribing.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 1 (thread_unsubscribe_during_turn_keeps_turn_running); 2 external calls (matches!, from_value).


##### `create_config_toml`  (lines 399–420)

```
fn create_config_toml(codex_home: &std::path::Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes the minimal mock-provider configuration for unsubscribe tests, using `danger-full-access` sandbox mode.

**Data flow**: It joins `config.toml` under the supplied Codex home and writes TOML with model `mock-model`, approval policy `never`, sandbox mode `danger-full-access`, provider `mock_provider`, and the supplied mock server URL.

**Call relations**: Used by all unsubscribe tests so thread execution and dynamic tool calls are not constrained by a restrictive sandbox.

*Call graph*: called by 4 (thread_unsubscribe_during_turn_keeps_turn_running, thread_unsubscribe_keeps_thread_loaded_until_idle_timeout, thread_unsubscribe_preserves_cached_status_before_idle_unload, thread_unsubscribe_reports_not_subscribed_before_idle_unload); 3 external calls (join, format!, write).


##### `start_thread`  (lines 422–436)

```
async fn start_thread(mcp: &mut TestAppServer) -> Result<String>
```

**Purpose**: Starts a thread with `mock-model` and returns only its thread id.

**Data flow**: It sends `thread/start`, waits for the matching response under `DEFAULT_READ_TIMEOUT`, deserializes `ThreadStartResponse`, and returns `thread.id`.

**Call relations**: Shared by the idle-unsubscribe, cached-status, and repeated-unsubscribe tests as a compact setup helper.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_start_request); called by 3 (thread_unsubscribe_keeps_thread_loaded_until_idle_timeout, thread_unsubscribe_preserves_cached_status_before_idle_unload, thread_unsubscribe_reports_not_subscribed_before_idle_unload); 3 external calls (default, Integer, timeout).


### Turn execution and interaction
These tests follow active execution within a thread, from turn start through interruption, steering, injected history, structured outputs, and model-driven client interactions.

### `app-server/tests/suite/v2/client_metadata.rs`

`test` · `turn/review request construction in integration tests`

This suite focuses on the `x-codex-turn-metadata` payload the app server synthesizes for downstream model requests. It uses mock HTTP SSE servers and websocket servers from `core_test_support::responses`, along with temporary rollout fixtures, to force specific thread histories. The shared config writer points the mock provider at a local server and toggles websocket support. `parse_json_header` decodes the metadata blob for assertions, while `fork_fake_rollout_thread` and `wait_for_request_count` support fork-lineage and follow-up-request timing tests.

The tests cover several metadata sources. Client-supplied `responsesapi_client_metadata` must be forwarded and augmented with server-generated fields like `turn_id`, `session_id`, `installation_id`, and `window_id`. Forked threads must include `forked_from_thread_id`; review subthreads must instead carry `parent_thread_id` and set `x-openai-subagent=review`; cold-resumed subagent threads created from rollout fixtures must preserve `parent_thread_id` and `subagent_kind`. The steer test is especially important: it starts a long-running turn, waits until the first upstream request is observed, then sends `turn/steer` with new metadata and confirms the second upstream request reuses the same `turn_id` but replaces client metadata fields such as `fiber_run_id` and adds `origin`. The websocket test confirms the same metadata is embedded under `client_metadata` in the request body rather than as HTTP headers.

#### Function details

##### `turn_start_forwards_client_metadata_to_responses_request_v2`  (lines 41–123)

```
async fn turn_start_forwards_client_metadata_to_responses_request_v2() -> Result<()>
```

**Purpose**: Checks that client-supplied metadata on `turn/start` is forwarded to an HTTP Responses API request and augmented with server-generated identifiers.

**Data flow**: Starts a mock SSE server, mounts a single successful response stream, writes config with websockets disabled, starts and initializes the app server, creates a thread, sends `turn/start` with `responsesapi_client_metadata` containing `fiber_run_id`, `origin`, and `thread_source`, reads the turn response and completion notification, inspects the single upstream request, parses the `x-codex-turn-metadata` header as JSON, and asserts the client fields are preserved while `turn_id`, `installation_id`, `session_id`, and `window_id` are present and consistent with `x-codex-window-id`.

**Call relations**: This is the baseline metadata-forwarding test for HTTP transport and establishes the expected merged metadata shape.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once, sse, start_mock_server); 10 external calls (default, from, new, Integer, default, assert!, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `turn_start_sends_fork_lineage_in_turn_metadata_for_thread_fork_v2`  (lines 126–200)

```
async fn turn_start_sends_fork_lineage_in_turn_metadata_for_thread_fork_v2() -> Result<()>
```

**Purpose**: Verifies that turns started on a forked thread include `forked_from_thread_id` in downstream metadata. It proves lineage from a saved rollout is preserved into model requests.

**Data flow**: Starts a mock SSE server, writes config, creates a fake rollout to serve as the source thread, starts and initializes the app server, forks that rollout thread via `fork_fake_rollout_thread`, starts a turn on the forked thread, waits for completion, inspects the upstream request's `x-codex-turn-metadata`, and asserts `forked_from_thread_id` equals the original rollout id while `thread_id` and `turn_id` match the new forked thread and turn.

**Call relations**: This test depends on `fork_fake_rollout_thread` to create the forked thread state before issuing the turn.

*Call graph*: calls 6 internal fn (new, create_config_toml, fork_fake_rollout_thread, mount_sse_once, sse, start_mock_server); 8 external calls (default, new, Integer, create_fake_rollout, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `review_start_sends_parent_lineage_in_turn_metadata_for_thread_fork_v2`  (lines 203–300)

```
async fn review_start_sends_parent_lineage_in_turn_metadata_for_thread_fork_v2() -> Result<()>
```

**Purpose**: Checks that review requests spawned from a forked thread use parent-thread lineage rather than fork lineage and mark the request as a review subagent.

**Data flow**: Starts a mock SSE server returning a serialized review payload, writes config, creates a fake source rollout, starts and initializes the app server, forks the rollout thread, sends `review/start` with inline delivery and custom instructions, reads `ReviewStartResponse` and captures `review_thread_id`, waits for `turn/completed`, inspects the upstream request, asserts header `x-openai-subagent == "review"`, confirms `forked_from_thread_id` is absent, asserts `parent_thread_id == review_thread_id`, extracts the actual request thread id from metadata and verifies it differs from `review_thread_id`, and checks the `x-codex-window-id` prefix matches that request thread id.

**Call relations**: Like the fork-turn test, it uses `fork_fake_rollout_thread`, but then exercises the review path to show different lineage semantics for subthreads.

*Call graph*: calls 6 internal fn (new, create_config_toml, fork_fake_rollout_thread, mount_sse_once, sse, start_mock_server); 9 external calls (new, Integer, create_fake_rollout, assert!, assert_eq!, json!, skip_if_no_network!, timeout, vec!).


##### `turn_start_sends_other_subagent_lineage_after_cold_thread_resume_v2`  (lines 303–398)

```
async fn turn_start_sends_other_subagent_lineage_after_cold_thread_resume_v2() -> Result<()>
```

**Purpose**: Verifies that resuming a persisted subagent thread from rollout storage preserves parent-thread and subagent-kind lineage in subsequent turn metadata.

**Data flow**: Starts a mock SSE server, writes config, creates a fake parented rollout with `SessionSource::SubAgent(SubAgentSource::Other("guardian"))`, starts and initializes the app server, resumes that thread via `thread/resume`, asserts the resumed thread reports the expected parent id and API session source, starts a turn on the resumed thread, waits for completion, inspects `x-codex-turn-metadata`, and asserts `parent_thread_id`, `subagent_kind`, `thread_id`, and `turn_id` are present while `forked_from_thread_id` is absent.

**Call relations**: This test uses persisted rollout fixtures rather than live forking to cover cold-resume lineage propagation.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once, sse, start_mock_server); 12 external calls (new, default, new, Integer, SubAgent, create_fake_parented_rollout_with_source, assert!, assert_eq!, Other, skip_if_no_network! (+2 more)).


##### `turn_steer_updates_client_metadata_on_follow_up_responses_request_v2`  (lines 401–525)

```
async fn turn_steer_updates_client_metadata_on_follow_up_responses_request_v2() -> Result<()>
```

**Purpose**: Checks that `turn/steer` updates the client metadata used on the follow-up Responses API request while preserving the original turn id. It validates metadata replacement across multi-request turns.

**Data flow**: Starts a mock server with a delayed first SSE response and immediate second response, writes config, starts and initializes the app server, creates a thread, starts a turn with initial metadata `{ fiber_run_id: fiber-start-123 }`, reads the turn response and `turn/started`, waits until one upstream request has been logged via `wait_for_request_count`, sends `turn/steer` with new metadata `{ fiber_run_id: fiber-steer-456, origin: gaas }` and `expected_turn_id`, reads the steer response and final completion notification, then inspects both logged upstream requests and asserts the first metadata contains the original `fiber_run_id` and the second contains the updated `fiber_run_id` and `origin`, with both carrying the same `turn_id`.

**Call relations**: This test uniquely depends on `wait_for_request_count` because it must steer an active turn after the first upstream request has already been issued.

*Call graph*: calls 7 internal fn (new, create_config_toml, wait_for_request_count, mount_response_sequence, sse, sse_response, start_mock_server); 10 external calls (default, from, new, Integer, default, assert_eq!, skip_if_no_network!, from_secs, timeout, vec!).


##### `turn_start_forwards_client_metadata_to_responses_websocket_request_body_v2`  (lines 528–623)

```
async fn turn_start_forwards_client_metadata_to_responses_websocket_request_body_v2() -> Result<()>
```

**Purpose**: Verifies that when websocket transport is enabled, turn metadata is sent inside the websocket request body's `client_metadata` map rather than as HTTP headers.

**Data flow**: Starts a websocket test server with one connection serving a warmup response and the real response, writes config with `supports_websockets = true`, starts and initializes the app server, creates a thread, sends `turn/start` with client metadata `{ fiber_run_id, origin }`, reads the turn response and completion notification, fetches the warmup and real websocket requests from the test server, asserts both are `response.create` and that the real request references `previous_response_id = warm-1`, parses `request["client_metadata"]["x-codex-turn-metadata"]` as JSON, and asserts the forwarded client fields plus generated `turn_id`, `session_id`, and `window_id` consistency.

**Call relations**: This is the websocket transport counterpart to the first HTTP metadata-forwarding test.

*Call graph*: calls 3 internal fn (new, create_config_toml, start_websocket_server); 10 external calls (default, from, new, Integer, default, assert!, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `create_config_toml`  (lines 625–651)

```
fn create_config_toml(
    codex_home: &Path,
    server_uri: &str,
    supports_websockets: bool,
) -> std::io::Result<()>
```

**Purpose**: Writes a minimal mock-provider config for client-metadata tests, parameterized by base server URI and websocket support.

**Data flow**: Takes codex-home path, `server_uri`, and `supports_websockets` boolean → writes `config.toml` containing model defaults and a `[model_providers.mock_provider]` section with `base_url = "{server_uri}/v1"`, `wire_api = "responses"`, zero retries, and `supports_websockets = {supports_websockets}` → returns `std::io::Result<()>`.

**Call relations**: All top-level tests call this helper to point the app server at the appropriate local HTTP or websocket mock backend.

*Call graph*: called by 6 (review_start_sends_parent_lineage_in_turn_metadata_for_thread_fork_v2, turn_start_forwards_client_metadata_to_responses_request_v2, turn_start_forwards_client_metadata_to_responses_websocket_request_body_v2, turn_start_sends_fork_lineage_in_turn_metadata_for_thread_fork_v2, turn_start_sends_other_subagent_lineage_after_cold_thread_resume_v2, turn_steer_updates_client_metadata_on_follow_up_responses_request_v2); 3 external calls (join, format!, write).


##### `fork_fake_rollout_thread`  (lines 653–670)

```
async fn fork_fake_rollout_thread(
    mcp: &mut TestAppServer,
    source_thread_id: String,
) -> Result<ThreadForkResponse>
```

**Purpose**: Forks a saved rollout-backed thread through the app server and returns the typed fork response. It hides the request/response boilerplate for lineage tests.

**Data flow**: Takes mutable `TestAppServer` and a source thread id string → sends `thread/fork` with `thread_source: Some(ThreadSource::User)`, waits for the matching response under timeout, deserializes it into `ThreadForkResponse`, and returns it.

**Call relations**: Used by the fork-lineage turn test and the review-lineage test to create a forked thread before issuing downstream requests.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_fork_request); called by 2 (review_start_sends_parent_lineage_in_turn_metadata_for_thread_fork_v2, turn_start_sends_fork_lineage_in_turn_metadata_for_thread_fork_v2); 3 external calls (default, Integer, timeout).


##### `parse_json_header`  (lines 672–674)

```
fn parse_json_header(value: &str) -> serde_json::Value
```

**Purpose**: Parses a JSON-encoded metadata header or websocket metadata string into `serde_json::Value`. It panics with a clear message if the value is not valid JSON.

**Data flow**: Accepts a string slice → calls `serde_json::from_str(value)` and unwraps with `expect("metadata header should contain valid JSON")` → returns the parsed `Value`.

**Call relations**: Used by multiple tests when decoding `x-codex-turn-metadata` from either HTTP headers or websocket request bodies.

*Call graph*: 1 external calls (from_str).


##### `wait_for_request_count`  (lines 676–690)

```
async fn wait_for_request_count(
    request_log: &core_test_support::responses::ResponseMock,
    expected: usize,
) -> Result<()>
```

**Purpose**: Polls a `ResponseMock` until at least a given number of upstream requests have been recorded. It is used to synchronize steering with an already-started turn.

**Data flow**: Takes a `ResponseMock` reference and expected count → loops under `DEFAULT_READ_TIMEOUT`, checking `request_log.requests().len()`, sleeping 10 ms between checks until the count is reached, then returns `Ok(())`; timeout propagates as an error.

**Call relations**: Called only by the steer test so it can issue `turn/steer` after the first upstream request has definitely been sent.

*Call graph*: calls 1 internal fn (requests); called by 1 (turn_steer_updates_client_metadata_on_follow_up_responses_request_v2); 3 external calls (from_millis, sleep, timeout).


### `app-server/tests/suite/v2/dynamic_tools.rs`

`test` · `request handling`

This file covers both configuration-time and runtime aspects of dynamic tools. On the configuration side, it checks that legacy `dynamicTools` entries supplied to `thread/start` are normalized into the canonical model-request `tools` shape, and that invalid combinations are rejected with JSON-RPC invalid-request errors. The invalid cases include mixing canonical and legacy formats, using legacy visibility fields inside canonical namespaces, empty namespaces, duplicate namespace names, and hidden tools without a namespace.

On the runtime side, the two round-trip tests simulate a model emitting a function call during a turn. The app-server should surface that as a `ServerRequest::DynamicToolCall`, emit `item/started` and `item/completed` notifications with `ThreadItem::DynamicToolCall`, accept a client response via `send_response`, and then include a `function_call_output` item in the follow-up model request. One test covers plain text output using `FunctionCallOutputPayload::from_text`; the other covers structured content items, including `input_text` and `input_image`, and verifies image detail defaults to `DEFAULT_IMAGE_DETAIL`.

Helper functions inspect recorded mock-server request bodies: `responses_bodies` filters `/responses` requests and parses JSON, `find_tool` locates a named tool in the outgoing `tools` array, and `function_call_output_raw_output` / `function_call_output_payload` extract and decode the `output` field of a `function_call_output` input item. Notification waiters loop until they find the specific dynamic tool call id, ignoring unrelated item events.

#### Function details

##### `thread_start_normalizes_legacy_dynamic_tools_into_model_request`  (lines 49–161)

```
async fn thread_start_normalizes_legacy_dynamic_tools_into_model_request() -> Result<()>
```

**Purpose**: Verifies legacy `dynamicTools` input on `thread/start` is normalized into canonical function and namespace tool definitions in the model request. It also checks that hidden legacy tools are omitted from the exposed tool list while visible ones are grouped by namespace.

**Data flow**: Creates a mock responses server with a final assistant message, writes config, starts and initializes `TestAppServer`, builds a visible JSON schema, and sends a raw `thread/start` request containing three legacy dynamic tools: one top-level function, one visible namespaced tool, and one hidden namespaced tool. After starting a turn and waiting for completion, it fetches recorded `/responses` request bodies with `responses_bodies`, finds the normalized `lookup_ticket` function and `legacy_app` namespace via `find_tool`, and asserts their JSON matches the expected canonical tool objects.

**Call relations**: Invoked by the test harness. It uses raw request sending because the legacy format is not represented directly by the typed protocol structs, then inspects outbound model requests through `responses_bodies` and `find_tool`.

*Call graph*: calls 4 internal fn (new, create_config_toml, find_tool, responses_bodies); 8 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, json!, timeout, vec!).


##### `thread_start_rejects_hidden_dynamic_tools_without_namespace`  (lines 164–200)

```
async fn thread_start_rejects_hidden_dynamic_tools_without_namespace() -> Result<()>
```

**Purpose**: Checks that a hidden dynamic tool (`defer_loading: true`) cannot be declared as a top-level function without a namespace. The server should reject the thread-start request as invalid.

**Data flow**: Starts a bare `MockServer`, writes config, initializes `TestAppServer`, constructs `DynamicToolSpec::Function(DynamicToolFunctionSpec { name: "hidden_tool", ..., defer_loading: true })`, sends `send_thread_start_request` with that tool, waits for the matching error, and asserts code `-32600` plus an error message mentioning both `hidden_tool` and `namespace`.

**Call relations**: Called by the harness as a validation test. It uses the typed canonical dynamic-tool struct rather than raw JSON because this invalid case is representable in the protocol types.

*Call graph*: calls 2 internal fn (new, create_config_toml); 10 external calls (default, start, new, Integer, assert!, assert_eq!, json!, Function, timeout, vec!).


##### `thread_start_rejects_invalid_dynamic_tool_inputs`  (lines 203–317)

```
async fn thread_start_rejects_invalid_dynamic_tool_inputs() -> Result<()>
```

**Purpose**: Verifies several malformed `dynamicTools` payloads are rejected with invalid-request errors and descriptive messages. It covers mixed canonical/legacy formats, legacy fields inside canonical namespaces, empty namespaces, and duplicate namespace names.

**Data flow**: Starts a mock server and configured app-server, then iterates over a table of `(dynamic_tools_json, expected_error_substring)` cases. For each case it sends a raw `thread/start` request with `dynamicTools` set to that JSON, waits for the matching error, asserts code `-32600`, and asserts the message contains the expected substring.

**Call relations**: Invoked by the harness. It uses `send_raw_request` because several malformed cases cannot be expressed through the typed canonical structs, and it loops through multiple validation scenarios in one test.

*Call graph*: calls 2 internal fn (new, create_config_toml); 7 external calls (start, new, Integer, assert!, assert_eq!, json!, timeout).


##### `dynamic_tool_call_round_trip_sends_text_content_items_to_model`  (lines 321–551)

```
async fn dynamic_tool_call_round_trip_sends_text_content_items_to_model() -> Result<()>
```

**Purpose**: Exercises the full dynamic tool call lifecycle for text output: model emits a function call, app-server asks the client to execute it, client responds with text content, and the server sends a `function_call_output` back to the model. It also verifies started/completed item notifications for the dynamic tool call.

**Data flow**: Creates two mock responses: first an SSE stream that emits a `function_call` output item with namespace, tool name, and JSON arguments, then a final assistant message. After writing config and initializing `TestAppServer`, it defines a namespaced dynamic tool set, starts a thread with that namespace, starts a turn, and captures the returned thread and turn ids. It waits for `item/started`, asserts the `ThreadItem::DynamicToolCall` fields (`id`, `namespace`, `tool`, `arguments`, `status`, and unset completion fields), reads the server request stream until it gets `ServerRequest::DynamicToolCall`, asserts the typed `DynamicToolCallParams`, sends a `DynamicToolCallResponse` containing one `InputText` item and `success: true`, waits for `item/completed`, asserts the completed item now contains the content items, success flag, and a duration, waits for `turn/completed`, then inspects recorded `/responses` bodies to assert the namespace tool definition and the follow-up `function_call_output` payload equal the expected text payload.

**Call relations**: Run by the harness as the main runtime dynamic-tool integration test. It depends on `wait_for_dynamic_tool_started`, `wait_for_dynamic_tool_completed`, `responses_bodies`, `find_tool`, and `function_call_output_payload` to connect the JSON-RPC side of the flow to the outbound model-request side.

*Call graph*: calls 7 internal fn (new, create_config_toml, find_tool, responses_bodies, wait_for_dynamic_tool_completed, wait_for_dynamic_tool_started, from_text); 13 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, assert!, assert_eq!, json!, panic!, Namespace, to_string (+3 more)).


##### `dynamic_tool_call_round_trip_sends_content_items_to_model`  (lines 555–745)

```
async fn dynamic_tool_call_round_trip_sends_content_items_to_model() -> Result<()>
```

**Purpose**: Verifies dynamic tool call responses can carry structured content items, not just plain text, and that the server forwards them to the model in the correct serialized form. It specifically checks image items gain the default detail level.

**Data flow**: Creates mock responses where the first SSE stream emits a function call and the second completes the turn, writes config, starts and initializes the server, defines a top-level function dynamic tool, starts a thread and turn, waits for the started dynamic-tool item, reads the `ServerRequest::DynamicToolCall`, and asserts the typed params. It then builds a response containing `InputText` and `InputImage` items, separately maps those into expected `FunctionCallOutputContentItem` values with `detail: Some(DEFAULT_IMAGE_DETAIL)` for the image, sends the response, waits for the completed item and asserts its status/content/success fields, waits for `turn/completed`, then inspects recorded `/responses` bodies to assert the raw `output` JSON array and the decoded `FunctionCallOutputPayload` body both match the expected structured content items.

**Call relations**: Invoked by the harness as the structured-output companion to the text-output round-trip test. It reuses the same notification and request-reading helpers but validates `function_call_output_raw_output` and `function_call_output_payload` for content-item serialization.

*Call graph*: calls 5 internal fn (new, create_config_toml, responses_bodies, wait_for_dynamic_tool_completed, wait_for_dynamic_tool_started); 12 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, json!, panic!, Function, to_string, to_value (+2 more)).


##### `responses_bodies`  (lines 747–761)

```
async fn responses_bodies(server: &MockServer) -> Result<Vec<Value>>
```

**Purpose**: Collects and parses JSON bodies of all recorded `/responses` requests from the mock server. It is the common inspection helper for outbound model requests.

**Data flow**: Fetches `server.received_requests()`, filters requests whose URL path ends with `/responses`, parses each request body as `serde_json::Value` with `body_json`, and collects the parsed values into a `Vec<Value>`.

**Call relations**: Used by the legacy-normalization test and both dynamic-tool round-trip tests. It bridges wiremock’s recorded HTTP requests into JSON values that the tests can inspect.

*Call graph*: called by 3 (dynamic_tool_call_round_trip_sends_content_items_to_model, dynamic_tool_call_round_trip_sends_text_content_items_to_model, thread_start_normalizes_legacy_dynamic_tools_into_model_request); 1 external calls (received_requests).


##### `find_tool`  (lines 763–771)

```
fn find_tool(body: &'a Value, name: &str) -> Option<&'a Value>
```

**Purpose**: Finds a tool entry by `name` inside a model request body’s top-level `tools` array. It is used to inspect normalized or explicit dynamic tool definitions sent to the model.

**Data flow**: Looks up `body["tools"]`, treats it as an array, iterates through entries, and returns the first tool whose `name` field equals the requested string. If no such tool exists, it returns `None`.

**Call relations**: Called by the legacy-normalization test and the text round-trip test after `responses_bodies` has produced parsed request bodies. It is a small JSON navigation helper for tool-definition assertions.

*Call graph*: called by 2 (dynamic_tool_call_round_trip_sends_text_content_items_to_model, thread_start_normalizes_legacy_dynamic_tools_into_model_request); 1 external calls (get).


##### `function_call_output_payload`  (lines 773–776)

```
fn function_call_output_payload(body: &Value, call_id: &str) -> Option<FunctionCallOutputPayload>
```

**Purpose**: Extracts and deserializes a `function_call_output` item’s `output` field into `FunctionCallOutputPayload`. It provides a typed view of the follow-up model input generated from a dynamic tool response.

**Data flow**: Calls `function_call_output_raw_output` to locate the raw `output` JSON for the specified `call_id`, then attempts `serde_json::from_value` on that JSON and returns the typed payload if deserialization succeeds.

**Call relations**: Used by both dynamic-tool round-trip tests when validating the follow-up request sent to the model. It depends on `function_call_output_raw_output` for the JSON extraction step.

*Call graph*: calls 1 internal fn (function_call_output_raw_output).


##### `function_call_output_raw_output`  (lines 778–789)

```
fn function_call_output_raw_output(body: &Value, call_id: &str) -> Option<Value>
```

**Purpose**: Locates the raw `output` value of a `function_call_output` item in a model request body’s `input` array. It is the low-level extractor behind typed payload decoding and raw JSON assertions.

**Data flow**: Navigates to `body["input"]` as an array, finds the first item whose `type` is `function_call_output` and whose `call_id` matches the requested id, then clones and returns that item’s `output` field. If any step fails, it returns `None`.

**Call relations**: Called by `function_call_output_payload` and directly by the structured-content round-trip test. It isolates the JSON search logic for follow-up function-call outputs.

*Call graph*: called by 1 (function_call_output_payload); 1 external calls (get).


##### `wait_for_dynamic_tool_started`  (lines 791–809)

```
async fn wait_for_dynamic_tool_started(
    mcp: &mut TestAppServer,
    call_id: &str,
) -> Result<ItemStartedNotification>
```

**Purpose**: Waits for an `item/started` notification corresponding to a specific dynamic tool call id. It filters out unrelated item-started events.

**Data flow**: Loops reading `item/started` notifications under timeout, skips notifications with missing params, deserializes params into `ItemStartedNotification`, and returns the notification once `started.item` matches `ThreadItem::DynamicToolCall { id, .. }` with the requested `call_id`.

**Call relations**: Used by both dynamic-tool round-trip tests immediately after starting a turn. It provides the synchronization point where the server has recognized the model’s function call and surfaced it as a thread item.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 2 (dynamic_tool_call_round_trip_sends_content_items_to_model, dynamic_tool_call_round_trip_sends_text_content_items_to_model); 3 external calls (matches!, from_value, timeout).


##### `wait_for_dynamic_tool_completed`  (lines 811–829)

```
async fn wait_for_dynamic_tool_completed(
    mcp: &mut TestAppServer,
    call_id: &str,
) -> Result<ItemCompletedNotification>
```

**Purpose**: Waits for an `item/completed` notification corresponding to a specific dynamic tool call id. It is the completion-side counterpart to `wait_for_dynamic_tool_started`.

**Data flow**: Loops reading `item/completed` notifications under timeout, skips notifications with missing params, deserializes params into `ItemCompletedNotification`, and returns the notification once `completed.item` matches `ThreadItem::DynamicToolCall { id, .. }` for the requested call id.

**Call relations**: Called by both dynamic-tool round-trip tests after sending the client’s tool-call response. It marks the point where the app-server has incorporated the tool result and finalized the dynamic tool item.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 2 (dynamic_tool_call_round_trip_sends_content_items_to_model, dynamic_tool_call_round_trip_sends_text_content_items_to_model); 3 external calls (matches!, from_value, timeout).


##### `create_config_toml`  (lines 831–852)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes a minimal mock-provider config for dynamic-tool tests. It standardizes the model, approval policy, sandbox mode, and mock responses backend.

**Data flow**: Joins `config.toml` under the provided CODEX_HOME path and writes a formatted TOML string containing `model = "mock-model"`, `approval_policy = "never"`, `sandbox_mode = "read-only"`, `model_provider = "mock_provider"`, and a `[model_providers.mock_provider]` table pointing at `<server_uri>/v1` with zero retries.

**Call relations**: Used by every test in this file during setup. It is a local copy of the common mock-provider config helper tailored to these dynamic-tool tests.

*Call graph*: called by 5 (dynamic_tool_call_round_trip_sends_content_items_to_model, dynamic_tool_call_round_trip_sends_text_content_items_to_model, thread_start_normalizes_legacy_dynamic_tools_into_model_request, thread_start_rejects_hidden_dynamic_tools_without_namespace, thread_start_rejects_invalid_dynamic_tool_inputs); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/memory_reset.rs`

`test` · `request handling`

This file verifies that resetting memory clears generated memory outputs while preserving thread records and thread memory mode. The main test creates a temporary Codex home, writes a minimal config enabling SQLite state, initializes `StateRuntime`, and manually seeds both on-disk memory files (`memories/MEMORY.md` and `memories/rollout_summaries/stale.md`) and database-backed memory state. The seeding helper creates a fresh `ThreadId` and worker id from UUIDs, builds thread metadata with `ThreadMetadataBuilder` using `SessionSource::Cli`, upserts the thread, claims a stage1 memory job, marks it succeeded with `raw memory` and `rollout summary`, and enqueues global consolidation. After starting `TestAppServer`, the test sends the raw JSON-RPC method `memory/reset`, decodes `MemoryResetResponse`, and then checks both storage layers: `list_stage1_outputs_for_global` must return an empty vector, while `get_thread_memory_mode(thread_id)` must still return `Some("enabled")`. Finally it reads the `memories` directory and asserts it is empty. The key invariant is that memory reset is destructive only to memory artifacts and memory-processing rows, not to thread existence or thread-level memory settings.

#### Function details

##### `memory_reset_clears_memory_files_and_rows_preserves_threads`  (lines 23–69)

```
async fn memory_reset_clears_memory_files_and_rows_preserves_threads() -> Result<()>
```

**Purpose**: Seeds memory files and stage1 memory rows, invokes `memory/reset`, and verifies memory artifacts are removed while thread state remains intact.

**Data flow**: It creates a temporary Codex home, writes config via `create_config_toml`, initializes `StateRuntime` with `init_state_db`, creates the `memories` directory tree and stale files with Tokio filesystem APIs, seeds a completed stage1 memory job via `seed_stage1_output`, starts and initializes `TestAppServer`, sends a raw `memory/reset` request, waits for and decodes `MemoryResetResponse`, then queries the state DB to assert stage1 outputs are empty and the seeded thread’s memory mode is still `enabled`. It also reads the `memories` directory and asserts no entries remain.

**Call relations**: This is the file’s top-level integration test. It composes all three helpers to prepare config and state, then validates both database and filesystem effects of the reset RPC.

*Call graph*: calls 4 internal fn (new, create_config_toml, init_state_db, seed_stage1_output); 8 external calls (new, Integer, assert!, assert_eq!, create_dir_all, read_dir, write, timeout).


##### `seed_stage1_output`  (lines 71–119)

```
async fn seed_stage1_output(state_db: &Arc<StateRuntime>, codex_home: &Path) -> Result<ThreadId>
```

**Purpose**: Creates a thread record and a completed stage1 memory job so the reset test has database-backed memory state to clear.

**Data flow**: It takes the shared `StateRuntime` and `codex_home`, captures the current UTC time, generates thread and worker UUID-based `ThreadId`s, builds thread metadata pointing at `sessions/test.jsonl` with CLI session source, sets `updated_at` and `cwd`, builds and upserts the metadata, then calls `try_claim_stage1_job`. It pattern-matches the result to require `Stage1JobClaimOutcome::Claimed`, uses the returned ownership token to mark the stage1 job succeeded with `raw memory` and `rollout summary`, asserts that success was recorded, enqueues global consolidation, and returns the created thread id.

**Call relations**: The main reset test calls this helper after initializing the state DB. It deliberately seeds both thread metadata and memory-processing rows so the test can verify reset clears only the latter.

*Call graph*: calls 2 internal fn (from_string, new); called by 1 (memory_reset_clears_memory_files_and_rows_preserves_threads); 6 external calls (join, to_path_buf, now, new_v4, bail!, assert!).


##### `init_state_db`  (lines 121–127)

```
async fn init_state_db(codex_home: &Path) -> Result<Arc<StateRuntime>>
```

**Purpose**: Initializes the SQLite-backed state runtime for tests and marks backfill complete.

**Data flow**: It takes `codex_home`, calls `StateRuntime::init(codex_home.to_path_buf(), "mock_provider".into())`, awaits initialization, marks backfill complete with no watermark, and returns the resulting `Arc<StateRuntime>`.

**Call relations**: The main test uses this helper before seeding memory rows, ensuring the state database is ready and not blocked on any initial backfill state.

*Call graph*: calls 1 internal fn (init); called by 1 (memory_reset_clears_memory_files_and_rows_preserves_threads); 1 external calls (to_path_buf).


##### `create_config_toml`  (lines 129–151)

```
fn create_config_toml(codex_home: &Path) -> std::io::Result<()>
```

**Purpose**: Writes the minimal app-server configuration needed to enable SQLite state and start the server for the memory reset test.

**Data flow**: It joins `config.toml` under `codex_home` and writes a static TOML string containing model/provider settings, `approval_policy = "never"`, `sandbox_mode = "read-only"`, suppression of unstable-feature warnings, `[features] sqlite = true`, and a mock provider endpoint.

**Call relations**: The main test calls this first so both `StateRuntime` initialization and `TestAppServer` startup use a consistent configuration rooted in the temporary Codex home.

*Call graph*: called by 1 (memory_reset_clears_memory_files_and_rows_preserves_threads); 2 external calls (join, write).


### `app-server/tests/suite/v2/output_schema.rs`

`test` · `request handling`

This file verifies the bridge between app-server turn creation and the provider-facing Responses API request format. Both tests are network-gated with `skip_if_no_network!` and stand up a mock server using `core_test_support::responses`. The helper `create_config_toml` writes a provider configuration that points `model_provider = "mock_provider"` at the mock server's `/v1` base URL, uses the `responses` wire API, and disables retries so each test sees a single deterministic request.

In each test, the flow is: create a temporary home, write config, start `TestAppServer`, initialize it, create a thread via `thread/start`, then start a turn with `TurnStartParams` containing text input and optionally a JSON Schema value in `output_schema`. The mock server returns a short SSE sequence (`response_created`, assistant message, `completed`) so the turn can finish. After the app-server emits `turn/completed`, the test inspects the captured HTTP request body sent to the mock provider. The expected shape is nested under `/text/format` and must be `{ name: "codex_output_schema", type: "json_schema", strict: true, schema: <original schema> }`. The second test proves this field is per-turn state, not sticky session state: the first turn includes it, the second turn on the same thread omits it and the outbound payload has no `/text/format` entry.

#### Function details

##### `turn_start_accepts_output_schema_v2`  (lines 21–101)

```
async fn turn_start_accepts_output_schema_v2() -> Result<()>
```

**Purpose**: Verifies that a turn started with `output_schema` causes the app-server to send the corresponding strict JSON Schema format block to the provider. It checks the exact serialized payload shape rather than only successful completion.

**Data flow**: Skips when network tests are disabled, starts a mock responses server, mounts a one-shot SSE completion stream, creates a temp home and writes provider config, then starts and initializes `TestAppServer`. It creates a thread, builds a JSON schema object, sends `TurnStartParams` with text input and `output_schema: Some(schema)`, waits for the turn response and `turn/completed` notification, then reads the captured provider request body and asserts `/text/format` equals the expected `json_schema` wrapper around the original schema.

**Call relations**: This test drives the full thread-start then turn-start flow because output schemas are attached to turns, not global session state. It delegates config creation to `create_config_toml` and mock transport setup to the `responses` helpers so the final assertion can focus on the outbound provider payload.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once, sse, start_mock_server); 8 external calls (default, new, Integer, assert_eq!, json!, skip_if_no_network!, timeout, vec!).


##### `turn_start_output_schema_is_per_turn_v2`  (lines 104–214)

```
async fn turn_start_output_schema_is_per_turn_v2() -> Result<()>
```

**Purpose**: Ensures an output schema affects only the turn that specifies it and is not retained for later turns on the same thread. It compares two consecutive provider requests from the same server session.

**Data flow**: After the same mock-server and config setup as the previous test, it creates one thread and sends a first turn with `output_schema: Some(schema)`, waits for completion, and asserts the first captured request contains the expected `/text/format` JSON schema block. It then mounts a second SSE response, sends another turn on the same thread with `output_schema: None`, waits for completion, and asserts the second captured request has `payload.pointer("/text/format") == None`.

**Call relations**: This test extends the single-turn scenario into a statefulness check across multiple turns. It reuses `create_config_toml` and the same `TestAppServer` instance to prove the absence of schema leakage between requests.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once, sse, start_mock_server); 8 external calls (default, new, Integer, assert_eq!, json!, skip_if_no_network!, timeout, vec!).


##### `create_config_toml`  (lines 216–237)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes the minimal provider configuration needed for these output-schema tests to route requests to the mock Responses API server. It fixes the provider name, base URL, wire API, and retry counts.

**Data flow**: Takes a `codex_home` path and `server_uri`, joins `config.toml` under the home directory, formats a TOML string containing model selection, approval/sandbox settings, `model_provider = "mock_provider"`, and a `[model_providers.mock_provider]` table pointing at `{server_uri}/v1`, then writes that file to disk. It returns the `std::io::Result<()>` from `std::fs::write`.

**Call relations**: Both tests call this helper before starting `TestAppServer` so the server talks to the local mock backend instead of a real provider. It is purely setup code and does not participate in the runtime request loop beyond shaping startup configuration.

*Call graph*: called by 2 (turn_start_accepts_output_schema_v2, turn_start_output_schema_is_per_turn_v2); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/plan_item.rs`

`test` · `request handling`

This file sets up end-to-end plan-mode conversations against a mock Responses API server and inspects the notification stream emitted by the app-server. `create_config_toml` writes a provider config that enables the `Feature::CollaborationModes` feature flag by looking up its config key in the global `FEATURES` table, then points a mock provider at the supplied server URI. `start_plan_mode_turn` encapsulates the common setup: create a thread with model `mock-model`, then start a turn whose `collaboration_mode` is `CollaborationMode { mode: ModeKind::Plan, settings: Settings { model, reasoning_effort: None, developer_instructions: None } }` and whose user input is `"Plan this"`.

The notification collector loops on `mcp.read_next_message()`, ignores non-notifications, and parses `item/started`, `item/completed`, `item/plan/delta`, and `turn/completed` payloads into typed protocol structs. The positive test feeds a streamed assistant message containing text before and after a `<proposed_plan>` block; it asserts the concatenated `PlanDeltaNotification.delta` values equal only the inner plan markdown, every delta references the synthetic `{turn_id}-plan` item id, a completed `ThreadItem::Plan` exists with that same id and extracted text, and ordinary agent message items are still emitted alongside it. The negative test uses a plain assistant message and confirms both the completed-item list and delta stream contain no plan item. `wait_for_responses_request_count` polls wiremock to ensure exactly one `/responses` POST occurred, catching retries or duplicate submissions.

#### Function details

##### `plan_mode_uses_proposed_plan_block_for_plan_item`  (lines 39–98)

```
async fn plan_mode_uses_proposed_plan_block_for_plan_item() -> Result<()>
```

**Purpose**: Verifies that in plan mode the server extracts the contents of a `<proposed_plan>` block into a dedicated plan item and streams matching plan deltas. It also confirms normal agent message items are still produced.

**Data flow**: Skips when network tests are disabled, builds an SSE response whose assistant text contains `Preface`, a `<proposed_plan>` block, and `Postscript`, starts a mock responses server sequence, writes config, starts and initializes `TestAppServer`, then calls `start_plan_mode_turn`. It collects notifications until `turn/completed`, waits until the mock server has seen exactly one `/responses` request, and asserts the completed turn id/status, concatenated plan delta text, per-delta `item_id`, extracted completed `ThreadItem::Plan`, and presence of at least one `ThreadItem::AgentMessage`.

**Call relations**: This is the main positive-path test in the file. It delegates turn setup to `start_plan_mode_turn`, stream parsing to `collect_turn_notifications`, and backend request-count stabilization to `wait_for_responses_request_count` so the assertions can focus on plan-item semantics.

*Call graph*: calls 5 internal fn (new, collect_turn_notifications, create_config_toml, start_plan_mode_turn, wait_for_responses_request_count); 8 external calls (new, create_mock_responses_server_sequence_unchecked, assert!, assert_eq!, format!, skip_if_no_network!, timeout, vec!).


##### `plan_mode_without_proposed_plan_does_not_emit_plan_item`  (lines 101–128)

```
async fn plan_mode_without_proposed_plan_does_not_emit_plan_item() -> Result<()>
```

**Purpose**: Checks that plan mode alone is not enough to create a plan item; the assistant output must actually contain a `<proposed_plan>` block. It ensures the server does not synthesize plan items from arbitrary assistant text.

**Data flow**: Skips when network tests are disabled, mounts a simple SSE response with only an assistant message `Done`, writes config, starts and initializes the server, starts a plan-mode turn, collects notifications through completion, and waits for exactly one `/responses` request. It scans completed items for any `ThreadItem::Plan`, asserts none exist, and asserts the collected `plan_deltas` vector is empty.

**Call relations**: This negative-path companion to the previous test uses the same helpers and infrastructure but changes only the provider output. Its role is to prove the extraction logic is content-sensitive rather than mode-sensitive alone.

*Call graph*: calls 5 internal fn (new, collect_turn_notifications, create_config_toml, start_plan_mode_turn, wait_for_responses_request_count); 6 external calls (new, create_mock_responses_server_sequence_unchecked, assert!, skip_if_no_network!, timeout, vec!).


##### `start_plan_mode_turn`  (lines 130–170)

```
async fn start_plan_mode_turn(mcp: &mut TestAppServer) -> Result<codex_app_server_protocol::Turn>
```

**Purpose**: Creates a thread and immediately starts a plan-mode turn against it, returning the typed `Turn` object from the server. It packages the repeated setup needed by both plan-item tests.

**Data flow**: Takes a mutable `TestAppServer`, sends `ThreadStartParams` with `model: Some("mock-model")`, waits for and deserializes the thread-start response, constructs a `CollaborationMode` with `ModeKind::Plan` and `Settings { model: "mock-model", reasoning_effort: None, developer_instructions: None }`, then sends `TurnStartParams` containing the thread id, a single text `UserInput`, and that collaboration mode. It waits for the turn-start response, deserializes `TurnStartResponse`, and returns its `turn` field.

**Call relations**: Both top-level tests call this helper after server initialization. It sits at the boundary between setup and notification collection, ensuring each test enters the same plan-mode execution path before inspecting emitted items.

*Call graph*: calls 3 internal fn (read_stream_until_response_message, send_thread_start_request, send_turn_start_request); called by 2 (plan_mode_uses_proposed_plan_block_for_plan_item, plan_mode_without_proposed_plan_does_not_emit_plan_item); 4 external calls (default, Integer, timeout, vec!).


##### `collect_turn_notifications`  (lines 172–221)

```
async fn collect_turn_notifications(
    mcp: &mut TestAppServer,
) -> Result<(
    Vec<ThreadItem>,
    Vec<ThreadItem>,
    Vec<PlanDeltaNotification>,
    TurnCompletedNotification,
)>
```

**Purpose**: Consumes the app-server message stream until a `turn/completed` notification arrives, collecting started items, completed items, and plan deltas along the way. It enforces that relevant notifications include params and are parseable into typed payloads.

**Data flow**: Accepts a mutable `TestAppServer`, initializes empty vectors for started items, completed items, and `PlanDeltaNotification`s, then loops reading the next message under timeout. Non-notification messages are skipped; notification methods are matched by string. For `item/started`, `item/completed`, and `item/plan/delta`, it extracts `params`, errors if missing, deserializes the payload from JSON, and pushes the typed item into the corresponding vector. On `turn/completed`, it deserializes `TurnCompletedNotification` and returns the accumulated tuple.

**Call relations**: The two plan-mode tests call this helper immediately after starting a turn. It centralizes the notification parsing logic so the tests can assert on collected protocol objects instead of manually decoding each stream event.

*Call graph*: calls 1 internal fn (read_next_message); called by 2 (plan_mode_uses_proposed_plan_block_for_plan_item, plan_mode_without_proposed_plan_does_not_emit_plan_item); 3 external calls (new, from_value, timeout).


##### `wait_for_responses_request_count`  (lines 223–251)

```
async fn wait_for_responses_request_count(
    server: &MockServer,
    expected_count: usize,
) -> Result<()>
```

**Purpose**: Polls the mock backend until it has observed exactly the expected number of `/responses` POST requests. It fails early if the count exceeds the expectation, catching retries or duplicate submissions.

**Data flow**: Takes a `wiremock::MockServer` reference and an expected count, then runs a timeout-wrapped async polling loop. Each iteration fetches recorded requests, errors if wiremock has no request log, filters for `POST` requests whose path ends with `/responses`, and compares the count to `expected_count`; it returns success on equality, bails on excess, or sleeps 10 ms and retries otherwise.

**Call relations**: Both top-level tests invoke this after collecting notifications to ensure backend traffic has settled before asserting final behavior. It complements the notification assertions by validating the upstream provider interaction count.

*Call graph*: called by 2 (plan_mode_uses_proposed_plan_block_for_plan_item, plan_mode_without_proposed_plan_does_not_emit_plan_item); 5 external calls (received_requests, bail!, from_millis, sleep, timeout).


##### `create_config_toml`  (lines 253–290)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes a test configuration enabling collaboration modes and routing provider traffic to the supplied mock Responses API server. It derives the feature's TOML key from the global feature registry instead of hardcoding it.

**Data flow**: Builds a `BTreeMap` containing `(Feature::CollaborationModes, true)`, converts each feature entry into a TOML assignment by looking up the feature's `key` in `FEATURES`, joins those lines, then writes a `config.toml` under `codex_home`. The file sets model, approval and sandbox policies, `model_provider = "mock_provider"`, a `[features]` section with the generated feature entries, and a `[model_providers.mock_provider]` section pointing at `{server_uri}/v1` with `wire_api = "responses"` and zero retries.

**Call relations**: Both tests call this helper before starting `TestAppServer`. Its role is purely orchestration/setup: it ensures the server enters the collaboration-mode code path and talks to the local mock backend.

*Call graph*: called by 2 (plan_mode_uses_proposed_plan_block_for_plan_item, plan_mode_without_proposed_plan_does_not_emit_plan_item); 4 external calls (from, join, format!, write).


### `app-server/tests/suite/v2/request_permissions.rs`

`test` · `request handling`

This test file builds a minimal mock-provider configuration with the `request_permissions_tool` feature enabled, then drives a full thread and turn through `TestAppServer`. The mocked SSE sequence first emits a permissions tool call (`call1`) and then a final assistant message, so the test can observe both the intermediate server request and the eventual turn completion. The main test starts a thread with model `mock-model`, starts a turn with a single text user input, waits for the typed `ThreadStartResponse` and `TurnStartResponse`, and then reads the next server-originated JSON-RPC request. It requires that request to be `ServerRequest::PermissionsRequestApproval`, and checks concrete fields: matching `thread_id` and `turn_id`, `item_id == "call1"`, an absolute `cwd`, the human-readable reason string, and a file-system permission payload containing exactly two write entries mirrored into `entries` as `FileSystemSandboxEntry` values.

The test then replies with a `PermissionsRequestApprovalResponse` that grants only one of the requested write paths, scoped to the current turn. After sending that JSON-RPC response, it drains notifications until it sees `serverRequest/resolved` and later `turn/completed`, asserting that resolution arrives first and that the resolved notification carries the original request id and thread id. The helper writes the exact TOML needed to point the app server at the mock responses endpoint with retries disabled, ensuring deterministic test timing.

#### Function details

##### `request_permissions_round_trip`  (lines 24–155)

```
async fn request_permissions_round_trip() -> Result<()>
```

**Purpose**: Runs an end-to-end permissions approval scenario against a test app server using a mocked SSE backend. It proves that a permissions tool call becomes a typed server request, that the client can answer it, and that the server reports the request as resolved before the turn completes.

**Data flow**: Creates a temporary Codex home directory, writes `config.toml`, and starts a mock responses server seeded with a permissions-request SSE event followed by a final assistant message. It initializes `TestAppServer`, sends `ThreadStartParams` and `TurnStartParams`, converts the resulting `JSONRPCResponse` values into `ThreadStartResponse` and `TurnStartResponse`, then reads a `ServerRequest::PermissionsRequestApproval`. From that request it inspects `thread_id`, `turn_id`, `item_id`, `cwd`, `reason`, and nested file-system permission fields, then sends back a serialized `PermissionsRequestApprovalResponse` granting only one requested write path with `PermissionGrantScope::Turn`. Finally it reads subsequent messages until it has observed both `serverRequest/resolved` and `turn/completed`, returning `Ok(())` or propagating any timeout/parse/test failure.

**Call relations**: This is the top-level Tokio test entrypoint in the file. It invokes `create_config_toml` during setup, then drives `TestAppServer` methods to initialize the server, start a thread, start a turn, read the approval request, and send the approval response; after that it passively consumes notifications to validate the server's post-resolution behavior.

*Call graph*: calls 2 internal fn (new, create_config_toml); 12 external calls (default, Integer, create_mock_responses_server_sequence, to_response, assert!, assert_eq!, panic!, from_value, to_value, new (+2 more)).


##### `create_config_toml`  (lines 157–181)

```
fn create_config_toml(codex_home: &std::path::Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes the temporary test configuration that enables the permissions-request tool and points the app server at the mock responses backend. The generated file fixes the model/provider names and disables retries for deterministic tests.

**Data flow**: Takes a Codex home path and mock server base URI, joins `config.toml` under that directory, formats a TOML string embedding `server_uri` into the provider `base_url`, and writes the file to disk. It returns the `std::io::Result<()>` from `std::fs::write`.

**Call relations**: Called only by `request_permissions_round_trip` during test setup so the spawned `TestAppServer` reads the intended provider and feature flags before initialization.

*Call graph*: called by 1 (request_permissions_round_trip); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/request_user_input.rs`

`test` · `request handling`

This file covers the `request_user_input` tool path. It includes a helper that constructs a synthetic SSE response containing a function call with JSON arguments describing one question (`confirm_path`) and an `autoResolutionMs` timeout. The main test configures a mock provider, starts a thread and a turn, and uses richer turn parameters than the permissions test: it sets `ReasoningEffort::Medium` and a `CollaborationMode` in `Plan` mode with nested `Settings` that mirror the same model and reasoning effort. That setup ensures the request-user-input path works in a planning/collaboration context, not just a bare turn.

After receiving the typed `TurnStartResponse`, the test waits for a server-originated `ServerRequest::ToolRequestUserInput`. It asserts the request is tied to the current thread and turn, that the tool call item id is `call1`, that exactly one question was surfaced, and that the auto-resolution timeout is preserved as `Some(60_000)`. It then answers with a raw JSON object mapping `confirm_path` to an answer array containing `"yes"`. As in the permissions test, it drains notifications until it sees `serverRequest/resolved` and then `turn/completed`, asserting the ordering guarantee. The config helper writes a minimal TOML pointing at the mock responses server with retries disabled; unlike the permissions test, no extra feature flag is needed because the behavior under test is driven directly by the tool call.

#### Function details

##### `create_request_user_input_sse_response_with_auto_resolution`  (lines 26–51)

```
fn create_request_user_input_sse_response_with_auto_resolution(
    call_id: &str,
    auto_resolution_ms: u64,
) -> anyhow::Result<String>
```

**Purpose**: Builds a mock SSE payload that represents a `request_user_input` function call with one multiple-choice question and a caller-specified auto-resolution timeout. It packages the tool arguments exactly as the responses wire format expects: a JSON string embedded in a function-call event.

**Data flow**: Accepts a `call_id` and `auto_resolution_ms`, constructs a JSON object with `questions` and `autoResolutionMs`, serializes it to a string, and wraps it in a three-event SSE stream: response created, function call, and response completed. It returns the resulting SSE body string inside `anyhow::Result<String>`.

**Call relations**: Used by `request_user_input_round_trip` to seed the mock responses server with a deterministic tool-call event before the final assistant message.

*Call graph*: calls 1 internal fn (sse); 3 external calls (json!, to_string, vec!).


##### `request_user_input_round_trip`  (lines 54–161)

```
async fn request_user_input_round_trip() -> Result<()>
```

**Purpose**: Executes a full client/server exchange for a `request_user_input` tool call and validates the typed request contents and completion ordering. It confirms that the app server exposes the tool call as `ToolRequestUserInput` and accepts a structured answer payload.

**Data flow**: Creates a temporary home directory, generates two SSE responses via `create_request_user_input_sse_response_with_auto_resolution` and `create_final_assistant_message_sse_response`, starts the mock server, writes config, initializes `TestAppServer`, and sends thread/turn start requests. It converts the thread and turn `JSONRPCResponse` values into typed responses, reads the next server request, pattern-matches it as `ServerRequest::ToolRequestUserInput`, and inspects `thread_id`, `turn_id`, `item_id`, `questions.len()`, and `auto_resolution_ms`. It then sends a JSON response containing answers for `confirm_path`, loops over subsequent messages until it sees `serverRequest/resolved` and `turn/completed`, and returns `Ok(())` if all assertions hold.

**Call relations**: This is the file's main Tokio test. It depends on `create_config_toml` for setup and on `create_request_user_input_sse_response_with_auto_resolution` to fabricate the initial tool-call stream; after setup it drives `TestAppServer` through initialization, thread creation, turn creation, request receipt, response submission, and notification observation.

*Call graph*: calls 2 internal fn (new, create_config_toml); 12 external calls (default, Integer, create_mock_responses_server_sequence, to_response, assert!, assert_eq!, panic!, from_value, json!, new (+2 more)).


##### `create_config_toml`  (lines 162–183)

```
fn create_config_toml(codex_home: &std::path::Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes the temporary TOML configuration for the request-user-input test environment. The file selects the mock model/provider and points the provider base URL at the mock responses server.

**Data flow**: Receives the Codex home directory and mock server URI, computes the `config.toml` path, formats a TOML string embedding `server_uri`, and writes it to disk. It returns the `std::io::Result<()>` from the write operation.

**Call relations**: Called only by `request_user_input_round_trip` before `TestAppServer::new`, so the server process starts with the intended provider configuration.

*Call graph*: called by 1 (request_user_input_round_trip); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/thread_inject_items.rs`

`test` · `request handling`

This file focuses on injecting serialized `ResponseItem` values into an existing thread. The tests use the responses mock server to capture the exact JSON input sent to the model provider, which lets them verify not just persistence but ordering relative to environment context and user prompts. Both tests create a temporary config pointing at a mock SSE server, start a thread, and then call `thread/injectItems` with `serde_json::Value` representations of assistant message items.

The first test injects before any user turn. It confirms the item is written into rollout history by reading the thread’s rollout path through `RolloutRecorder::get_rollout_history` and matching a `RolloutItem::ResponseItem` equal to the injected value. After starting the first turn, it inspects the captured model input array and proves the injected item appears after the standard `<environment_context>` item but before the user’s `Hello` prompt. The second test injects after one completed turn and uses a two-request SSE sequence to show temporal behavior: the first model request must not contain the injected item, while the second one must. A small helper scans arbitrary JSON response items for text snippets inside nested `content` arrays.

#### Function details

##### `thread_inject_items_adds_raw_response_items_to_thread_history`  (lines 27–136)

```
async fn thread_inject_items_adds_raw_response_items_to_thread_history() -> Result<()>
```

**Purpose**: Verifies that injecting a raw assistant `ResponseItem` before the first user turn both persists it into rollout history and includes it in the next model request in the expected order.

**Data flow**: The test starts a mock SSE server that returns a simple completed assistant response, writes config, initializes `TestAppServer`, and creates a new thread. It constructs a `ResponseItem::Message` with assistant output text, serializes it to JSON, sends `ThreadInjectItemsParams` with that value, and parses the success response. It then reads the rollout file from `thread.path`, loads history via `RolloutRecorder::get_rollout_history`, and asserts a matching `RolloutItem::ResponseItem` exists. After starting a turn with user input `Hello` and waiting for completion, it inspects the captured provider request body, finds the positions of `<environment_context>`, the injected item, and the user prompt, and asserts the injected item sits between the standard context and the user message.

**Call relations**: This is the primary end-to-end injection test. It uses the local `response_item_text_position` helper to reason about ordering inside the outbound model input after `thread/injectItems` succeeds.

*Call graph*: calls 7 internal fn (new, create_config_toml, response_item_text_position, mount_sse_once, sse, start_mock_server, get_rollout_history); 8 external calls (default, new, Integer, assert!, panic!, to_value, timeout, vec!).


##### `thread_inject_items_adds_raw_response_items_after_a_turn`  (lines 139–253)

```
async fn thread_inject_items_adds_raw_response_items_after_a_turn() -> Result<()>
```

**Purpose**: Checks that items injected into an already-used thread affect only future model requests, not requests that were sent before the injection occurred.

**Data flow**: The test mounts a two-response SSE sequence, starts a thread, completes a first turn with `First turn`, then builds and serializes an assistant `ResponseItem` saying `Injected after first turn`. It sends `thread/injectItems`, parses the success response, starts a second turn with `Second turn`, and waits for completion. Finally it reads both captured provider requests and asserts the first request does not contain the injected JSON value while the second request does.

**Call relations**: This test complements the first by proving injection mutates ongoing thread history rather than retroactively changing prior requests. It relies on the mock server’s request log instead of rollout inspection.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_sequence, sse, start_mock_server); 8 external calls (default, new, Integer, assert!, assert_eq!, to_value, timeout, vec!).


##### `create_config_toml`  (lines 255–276)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes the minimal runtime config used by these tests, pointing the mock provider at the supplied responses server.

**Data flow**: It joins `config.toml` under the temporary Codex home, formats TOML with model defaults and a `[model_providers.mock_provider]` block using `{server_uri}/v1`, and writes the file to disk.

**Call relations**: Both injection tests call this helper during setup so the app server can route turn execution to the local mock SSE server.

*Call graph*: called by 2 (thread_inject_items_adds_raw_response_items_after_a_turn, thread_inject_items_adds_raw_response_items_to_thread_history); 3 external calls (join, format!, write).


##### `response_item_text_position`  (lines 278–291)

```
fn response_item_text_position(items: &[Value], needle: &str) -> Option<usize>
```

**Purpose**: Searches a JSON array of response items for the first item whose nested `content[*].text` contains a given substring.

**Data flow**: It takes a slice of `serde_json::Value` items and a `needle` string, iterates through the array, descends into each item’s `content` array if present, and returns the index of the first item containing matching text. It returns `None` when no nested text field contains the substring.

**Call relations**: Only the first test uses this helper to compare the relative positions of environment context, injected assistant content, and the user prompt in the outbound model request.

*Call graph*: called by 1 (thread_inject_items_adds_raw_response_items_to_thread_history); 1 external calls (iter).


### `app-server/tests/suite/v2/thread_status.rs`

`test` · `request handling and notification streaming`

This small test file focuses on one notification stream: `thread/status/changed`. The first test creates a thread, starts a turn, and then continuously reads JSON-RPC messages until it observes a status transition for that thread from some `ThreadStatus::Active { .. }` state to a terminal non-active state after the turn finishes. The assertions are intentionally tolerant about the exact terminal status—`Idle`, `SystemError`, or `NotLoaded` all count once an active state has been seen—because the test is validating that runtime updates are emitted, not pinning every possible completion path.

The second test verifies client-controlled suppression of those notifications. It initializes the app server with explicit `ClientInfo` and `InitializeCapabilities` whose `opt_out_notification_methods` contains `thread/status/changed`, then starts a thread and a turn normally. After `turn/completed`, it waits briefly for any status-change notification and treats either a timeout or absence as success, while any delivered notification is considered a failure. This codifies the contract that notification filtering happens per client capability negotiation.

A single helper writes the minimal config needed for these tests: `mock-model`, approval policy `untrusted`, read-only sandbox, and `collaboration_modes = true`. That feature flag matters because status updates include active/runtime state associated with collaboration-mode execution.

#### Function details

##### `thread_status_changed_emits_runtime_updates`  (lines 25–129)

```
async fn thread_status_changed_emits_runtime_updates() -> Result<()>
```

**Purpose**: Verifies that running a turn emits `thread/status/changed` notifications showing the thread becoming active and later leaving the active state.

**Data flow**: It writes config, initializes `TestAppServer` with `RUST_LOG=info`, starts a thread, starts a turn, and then loops reading JSON-RPC messages until timeout. For notifications with method `thread/status/changed` and the matching thread id, it records whether it has seen an `Active` status and then a later `Idle`, `SystemError`, or `NotLoaded` status. It finally asserts both conditions were observed and waits for `turn/completed`.

**Call relations**: This is the positive notification-stream test for the file, using raw `read_next_message()` rather than a method-specific helper so it can inspect the full interleaving of messages.

*Call graph*: calls 2 internal fn (new_with_env, create_config_toml); 10 external calls (default, new, Integer, create_mock_responses_server_sequence, to_response, assert!, from_value, now, timeout, vec!).


##### `thread_status_changed_can_be_opted_out`  (lines 132–217)

```
async fn thread_status_changed_can_be_opted_out() -> Result<()>
```

**Purpose**: Checks that clients can suppress `thread/status/changed` notifications by advertising them in `opt_out_notification_methods` during initialization.

**Data flow**: It writes config, initializes the server with explicit `ClientInfo` and `InitializeCapabilities` containing `opt_out_notification_methods: ["thread/status/changed"]`, confirms initialization returned a response, starts a thread and a turn, waits for `turn/completed`, then waits 500 ms for any `thread/status/changed` notification. A timeout is treated as success; any delivered notification or stream error causes the test to fail.

**Call relations**: This test exercises the capability-negotiation path during initialization and then validates that later turn execution respects the negotiated notification filter.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (default, new, bail!, Integer, create_mock_responses_server_sequence, to_response, from_millis, timeout, vec!).


##### `create_config_toml`  (lines 219–243)

```
fn create_config_toml(codex_home: &std::path::Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes the minimal mock-provider configuration for thread-status tests, enabling collaboration modes.

**Data flow**: It joins `config.toml` under the supplied Codex home and writes TOML with model `mock-model`, approval policy `untrusted`, read-only sandbox, feature `collaboration_modes = true`, and the supplied mock server URL.

**Call relations**: Used by both tests in the file to ensure the app server starts with the feature set needed to emit runtime status updates.

*Call graph*: called by 2 (thread_status_changed_can_be_opted_out, thread_status_changed_emits_runtime_updates); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/turn_interrupt.rs`

`test` · `request handling`

This Unix-only integration test file drives a `TestAppServer` instance through the JSON-RPC v2 thread/turn lifecycle and then issues `turn/interrupt` requests under three distinct conditions. Each test builds an isolated temporary Codex home, writes a minimal `config.toml`, starts a mock Responses API server, initializes the app server, creates a thread with `ThreadStartParams`, and starts a turn with `TurnStartParams`. The first scenario uses a long-running shell command (`sleep` or PowerShell `Start-Sleep`) returned by the mock model so the turn remains active long enough to interrupt; after a short delay, the test sends `TurnInterruptParams` and asserts that the eventual `turn/completed` notification reports `TurnStatus::Interrupted`. The second scenario uses an immediate final assistant message, waits for `TurnStatus::Completed`, then confirms a later interrupt attempt yields a JSON-RPC error with code `-32600` rather than mutating completed state. The third scenario configures `approval_policy = "untrusted"` and `sandbox_mode = "read-only"` so a shell command produces a `ServerRequest::CommandExecutionRequestApproval`; interrupting the turn must both acknowledge the interrupt and emit `serverRequest/resolved` for the pending approval before the interrupted completion notification. A small helper centralizes config generation, wiring model provider URL, approval policy, reviewer, and sandbox mode into the test home.

#### Function details

##### `turn_interrupt_aborts_running_turn`  (lines 32–130)

```
async fn turn_interrupt_aborts_running_turn() -> Result<()>
```

**Purpose**: Starts a thread and a long-running turn, interrupts that turn by explicit thread and turn id, and verifies the server finishes it as interrupted. It specifically covers the case where a shell command has already begun executing.

**Data flow**: Creates temporary `codex_home` and working directory paths, chooses a platform-specific sleep command, writes config via `create_config_toml`, and boots `TestAppServer`. It sends `ThreadStartParams` and `TurnStartParams`, deserializes `ThreadStartResponse` and `TurnStartResponse` to capture ids, sleeps briefly to let execution begin, then sends `TurnInterruptParams`. It reads the interrupt response, then reads a `turn/completed` notification, deserializes `TurnCompletedNotification`, and asserts the returned thread id matches and the turn status is `Interrupted`.

**Call relations**: This is a top-level Tokio test invoked by the test runner. It depends on `create_config_toml` to point the app server at a mock SSE server created with the unchecked sequence helper, then drives the normal initialize → thread/start → turn/start flow before exercising the interrupt path and observing the resulting completion notification.

*Call graph*: calls 2 internal fn (new, create_config_toml); 11 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, from_value, create_dir, from_secs, sleep, timeout (+1 more)).


##### `turn_interrupt_rejects_completed_turn`  (lines 133–207)

```
async fn turn_interrupt_rejects_completed_turn() -> Result<()>
```

**Purpose**: Verifies that `turn/interrupt` is only valid for active turns and is rejected once a turn has already completed normally. The test ensures the server preserves completed state instead of retroactively changing it.

**Data flow**: Builds a temporary config and mock server that emits a single final assistant message, initializes `TestAppServer`, starts a thread, then starts a turn with text input. After reading the `TurnStartResponse`, it waits for `turn/completed`, deserializes the notification, and confirms the turn finished with `TurnStatus::Completed`. It then sends `TurnInterruptParams` for that completed turn, reads a JSON-RPC error for the interrupt request id, and asserts the error code equals `INVALID_REQUEST_ERROR_CODE` (`-32600`).

**Call relations**: This Tokio test is run directly by the harness. Like the other tests in the file, it uses `create_config_toml` for setup, but unlike the running-turn case it waits for normal completion first and then validates the server's rejection branch by reading an error message instead of a success response.

*Call graph*: calls 2 internal fn (new, create_config_toml); 10 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, from_value, create_dir, from_millis, timeout, vec!).


##### `turn_interrupt_resolves_pending_command_approval_request`  (lines 210–328)

```
async fn turn_interrupt_resolves_pending_command_approval_request() -> Result<()>
```

**Purpose**: Checks that interrupting a turn with an outstanding command approval request resolves that server request and then completes the turn as interrupted. It covers cleanup behavior, not just cancellation of already-running subprocesses.

**Data flow**: Creates temp directories and a mock server that emits a shell-command tool call requiring approval, writes config with `approval_policy = "untrusted"` and `sandbox_mode = "read-only"`, and initializes `TestAppServer`. It starts a thread and turn, reads the `TurnStartResponse`, then waits for a generic server request and pattern-matches it as `ServerRequest::CommandExecutionRequestApproval`, asserting `item_id`, `thread_id`, and `turn_id`. It sends `TurnInterruptParams`, reads a successful `TurnInterruptResponse`, then reads `serverRequest/resolved`, deserializes `ServerRequestResolvedNotification`, and finally reads `turn/completed` and asserts `TurnStatus::Interrupted`.

**Call relations**: This test is entered by the test runner and follows the same setup path as the other interrupt tests, but uses the checked mock sequence helper because approval traffic is expected. In the call flow it sits between turn startup and final completion, observing both the intermediate approval request and the resolution notification that interruption should trigger.

*Call graph*: calls 2 internal fn (new, create_config_toml); 10 external calls (default, new, Integer, create_mock_responses_server_sequence, assert_eq!, panic!, from_value, create_dir, timeout, vec!).


##### `create_config_toml`  (lines 331–358)

```
fn create_config_toml(
    codex_home: &std::path::Path,
    server_uri: &str,
    approval_policy: &str,
    sandbox_mode: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes the minimal `config.toml` used by these interrupt tests, targeting the mock model server and parameterizing approval and sandbox behavior. It keeps each test focused on protocol flow instead of inline config formatting.

**Data flow**: Takes a Codex home path, mock server URI, approval policy string, and sandbox mode string. It joins `config.toml` under the home directory, formats a TOML document containing `model`, `approval_policy`, `approvals_reviewer`, `sandbox_mode`, `model_provider`, and the `[model_providers.mock_provider]` section with the supplied base URL, then writes that string to disk.

**Call relations**: This helper is called by all three tests in the file during setup, before `TestAppServer::new`. It delegates only to path joining, string formatting, and `std::fs::write`, and has no runtime role after initialization completes.

*Call graph*: called by 3 (turn_interrupt_aborts_running_turn, turn_interrupt_rejects_completed_turn, turn_interrupt_resolves_pending_command_approval_request); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/turn_start.rs`

`test` · `request handling`

This large test module builds end-to-end scenarios around `TestAppServer`, mock Responses API servers, and temporary Codex homes to validate nearly every branch of v2 turn startup. The file includes small helpers for request inspection (`body_contains`), local-image setup (`run_local_image_turn`, `received_response_input_images`), environment parameter construction, feature-aware config writing, and synthetic skill creation. The tests cover empty input handling, additional context injection into model-visible prompts, originator header propagation from `ClientInfo`, preservation of `TextElement` metadata in emitted `ThreadItem::UserMessage`, warning notifications when skill descriptions are trimmed to fit context budget, service tier forwarding, omission of empty instruction overrides, analytics emission and timing counters, input-size validation, permission and environment preflight rejection before `turn/started`, model/collaboration/personality overrides, startup personality migration, command execution approval accept/decline/cancel semantics, per-turn sandbox and cwd rebinding, runtime workspace root rebinding for permission profiles, sticky environment selection, file-change approval and streaming patch updates, multi-agent spawn metadata and descendant deletion, rejection of direct input to sub-agents, process id reporting for command execution, and ensuring elevated per-turn overrides do not persist trust into config. Most tests follow the same control flow: write config, initialize server, create thread, start turn, then inspect JSON-RPC responses/notifications and captured outbound HTTP requests. The design is intentionally concrete: assertions inspect exact notification methods, enum variants, serialized request bodies, persisted files, and analytics payload fields rather than only checking success/failure.

#### Function details

##### `body_contains`  (lines 108–112)

```
fn body_contains(req: &wiremock::Request, text: &str) -> bool
```

**Purpose**: Checks whether a captured wiremock request body contains a given substring after UTF-8 decoding. It is used to route mock SSE responses based on prompt content.

**Data flow**: Accepts a `wiremock::Request` and search text, clones the raw body bytes, attempts `String::from_utf8`, and returns `true` only if decoding succeeds and the resulting string contains the target substring. It does not mutate external state.

**Call relations**: This helper is used by tests that mount conditional mock responses, especially multi-agent scenarios where different model requests must be distinguished by prompt content. It sits entirely on the request-inspection side and delegates only to UTF-8 decoding.

*Call graph*: 1 external calls (from_utf8).


##### `run_local_image_turn`  (lines 114–177)

```
async fn run_local_image_turn(detail: Option<ImageDetail>) -> Result<Vec<Value>>
```

**Purpose**: Runs a minimal thread and turn containing a single `V2UserInput::LocalImage`, then returns the `input_image` objects actually sent to the mock Responses API. It centralizes the repeated setup for local-image detail tests.

**Data flow**: Takes an optional `ImageDetail`, creates a mock server with two final assistant SSE responses, writes config, initializes `TestAppServer`, starts a thread, writes a tiny PNG file into the temp home, and starts a turn whose input is `LocalImage { path, detail }`. After confirming the turn completes, it calls `received_response_input_images` on the mock server and returns the collected JSON values representing image spans from outbound `/responses` requests.

**Call relations**: This helper is called by the two local-image tests that verify default and explicit detail forwarding. It orchestrates the full setup/turn lifecycle and delegates final request-body extraction to `received_response_input_images`.

*Call graph*: calls 3 internal fn (new, create_config_toml, received_response_input_images); called by 2 (turn_start_defaults_local_image_detail_to_high, turn_start_forwards_custom_local_image_detail); 9 external calls (default, default, new, Integer, create_mock_responses_server_sequence_unchecked, assert!, write, timeout, vec!).


##### `received_response_input_images`  (lines 179–214)

```
async fn received_response_input_images(server: &wiremock::MockServer) -> Result<Vec<Value>>
```

**Purpose**: Extracts all `input_image` content spans from captured `/responses` HTTP requests. It lets tests assert exactly what image payloads the app server sent upstream.

**Data flow**: Reads all requests from a `wiremock::MockServer`, filters to URLs ending in `/responses`, parses each body as `serde_json::Value`, walks `input` arrays, keeps only `message` items, then scans their `content` arrays for spans whose `type` is `input_image`. It clones those JSON objects into a `Vec<Value>` and returns them.

**Call relations**: This helper is only invoked by `run_local_image_turn` after a turn has completed. It is purely observational and depends on the mock server's recorded request history.

*Call graph*: called by 1 (run_local_image_turn); 2 external calls (received_requests, new).


##### `turn_start_with_empty_input_runs_model_request`  (lines 217–316)

```
async fn turn_start_with_empty_input_runs_model_request() -> Result<()>
```

**Purpose**: Verifies that an empty `input` array still starts and completes a turn, but does not synthesize an empty user message in the outbound model request. It protects the distinction between 'no user content' and 'empty content item'.

**Data flow**: Creates a one-response mock server and config, initializes `TestAppServer`, starts a user-sourced thread, then sends `TurnStartParams` with `input: Vec::new()`. It reads the `TurnStartResponse`, then `turn/started` and `turn/completed` notifications, asserting ids and statuses. Finally it inspects captured `/responses` requests, parses the sole request body, extracts the `input` array, and asserts there is no user `message` whose `content` array is empty.

**Call relations**: This top-level test follows the standard setup path via `create_config_toml` and the unchecked mock sequence helper. After protocol assertions it pivots to HTTP-level inspection to validate request shaping, not just turn lifecycle.

*Call graph*: calls 2 internal fn (new, create_config_toml); 11 external calls (default, default, new, new, Integer, create_mock_responses_server_sequence_unchecked, assert!, assert_eq!, from_value, timeout (+1 more)).


##### `turn_start_additional_context_flows_to_model_input`  (lines 319–393)

```
async fn turn_start_additional_context_flows_to_model_input() -> Result<()>
```

**Purpose**: Checks that `additional_context` entries supplied on `turn/start` are serialized into the model-visible prompt. It specifically verifies the XML-like external context wrapper format.

**Data flow**: Starts a thread and then a turn whose input is a text message plus `additional_context` containing a `custom_source` entry with `AdditionalContextKind::Untrusted`. After waiting for the turn response and completion notification, it fetches the captured `/responses` request body and asserts its string form contains `<external_custom_source>source value</external_custom_source>`.

**Call relations**: The test is invoked by the harness and uses `create_config_toml` for setup. It delegates no internal helpers beyond standard startup, then inspects the outbound model request to confirm context propagation.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (default, default, from, new, Integer, create_mock_responses_server_sequence_unchecked, assert!, timeout, vec!).


##### `turn_start_sends_originator_header`  (lines 396–470)

```
async fn turn_start_sends_originator_header() -> Result<()>
```

**Purpose**: Ensures the app server forwards the initializing client's name as the `originator` HTTP header on model requests. This ties JSON-RPC client identity to upstream transport metadata.

**Data flow**: Creates config with the Personality feature enabled, initializes `TestAppServer` using `initialize_with_client_info` and a `ClientInfo` whose `name` is `TEST_ORIGINATOR`, starts a thread and a text turn, waits for completion, then iterates over all captured requests and asserts each has an `originator` header equal to `codex_vscode`.

**Call relations**: This test differs from most others by using client-info initialization instead of plain `initialize`. After the normal thread/turn flow it validates transport-layer headers on every request recorded by the mock server.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (from, default, new, Integer, create_mock_responses_server_sequence_unchecked, assert!, assert_eq!, timeout, vec!).


##### `turn_start_emits_user_message_item_with_text_elements`  (lines 473–561)

```
async fn turn_start_emits_user_message_item_with_text_elements() -> Result<()>
```

**Purpose**: Verifies that a started turn emits a `ThreadItem::UserMessage` preserving both `client_user_message_id` and structured `TextElement` annotations. It checks the server-side item stream, not just upstream request formatting.

**Data flow**: Builds a thread, constructs a `TextElement` over byte range `0..5`, and starts a turn with `client_user_message_id = "client-message-1"` and a single text input carrying that element. After acknowledging the turn response, it loops over `item/started` notifications until it finds a `ThreadItem::UserMessage`, then matches the variant and asserts the `client_id` and `content` equal the original input. It finally waits for `turn/completed`.

**Call relations**: The test is called directly by the runner and uses the standard config helper. Its distinctive relation is the notification loop that filters mixed item streams until the user-message item appears.

*Call graph*: calls 2 internal fn (new, create_config_toml); 10 external calls (from, default, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, panic!, from_value, timeout, vec!).


##### `turn_start_emits_thread_scoped_warning_notification_for_trimmed_skills`  (lines 564–675)

```
async fn turn_start_emits_thread_scoped_warning_notification_for_trimmed_skills() -> Result<()>
```

**Purpose**: Checks that when model context budget forces skill descriptions to be trimmed, the server emits a thread-scoped warning and omits the trimmed skill entries from the outgoing prompt while retaining the skills section. It validates both user-visible warning text and prompt contents.

**Data flow**: Creates config and a models cache, rewrites the selected model's `context_window` to a tiny value, updates `config.toml` to use that model, writes two test skills, and starts `TestAppServer` with isolated `HOME`/`USERPROFILE` env vars so skill discovery stays inside the temp home. It starts a thread and turn, reads a `warning` notification into `WarningNotification`, and asserts the warning references the thread id and exact trimming message. After completion it inspects the last model request body, asserting it still contains `## Skills` but not the named skill descriptions.

**Call relations**: This test uses `write_test_skill` and `new_with_env` in addition to the normal setup helper. It bridges filesystem fixture setup, runtime warning notifications, and outbound prompt inspection.

*Call graph*: calls 3 internal fn (new_with_env, create_config_toml, write_test_skill); 18 external calls (from, default, new, Integer, default, create_mock_responses_server_sequence_unchecked, write_models_cache, assert!, assert_eq!, format! (+8 more)).


##### `turn_start_sends_service_tier_id_to_model_request`  (lines 678–745)

```
async fn turn_start_sends_service_tier_id_to_model_request() -> Result<()>
```

**Purpose**: Verifies that a selected service tier on `turn/start` is forwarded as `service_tier` in the Responses API payload. It ensures turn-level service-tier overrides survive request construction.

**Data flow**: Starts a raw mock server, mounts a single SSE response, writes config and models cache, selects a bundled model preset that exposes service tiers, and captures the first tier id. It initializes the app server, starts a thread using that model id, then starts a turn with `service_tier: Some(Some(service_tier_id))`. After completion it reads the mounted request body and asserts `body_json()["service_tier"]` equals the chosen id.

**Call relations**: This test is driven by the harness and uses direct `responses` helpers rather than the simpler sequence server. It depends on bundled model metadata from `all_model_presets` to choose a realistic tier-bearing model.

*Call graph*: calls 6 internal fn (new, create_config_toml, all_model_presets, mount_sse_once, sse, start_mock_server); 8 external calls (default, default, new, Integer, write_models_cache, assert_eq!, timeout, vec!).


##### `thread_start_omits_empty_instruction_overrides_from_model_request`  (lines 748–836)

```
async fn thread_start_omits_empty_instruction_overrides_from_model_request() -> Result<()>
```

**Purpose**: Ensures empty-string instruction overrides on thread creation do not produce empty developer messages or an `instructions` field in the model request. It preserves omission semantics for blank overrides.

**Data flow**: Creates a mock SSE endpoint, writes config, initializes the app server, and starts a thread with `config.include_permissions_instructions = false`, `base_instructions = Some("")`, and `developer_instructions = Some("")`. It then starts a normal text turn, waits for completion, inspects the single request body, collects any developer `input_text` entries whose `text` is empty, and asserts both that `instructions` is absent and that no empty developer texts were emitted.

**Call relations**: This test is invoked directly and uses `create_config_toml` for setup. It specifically exercises thread-level configuration flowing into the later turn request body.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once, sse, start_mock_server); 10 external calls (default, default, from, new, new, Integer, assert_eq!, json!, timeout, vec!).


##### `turn_start_tracks_turn_event_analytics`  (lines 839–973)

```
async fn turn_start_tracks_turn_event_analytics() -> Result<()>
```

**Purpose**: Validates that a completed turn emits a rich `codex_turn_event` analytics payload including ids, model metadata, workspace metadata, token counters, timing fields, and retry counts. It also checks retry accounting when the first upstream response fails with a retryable 500.

**Data flow**: Mounts a response sequence consisting of one 500 JSON error followed by a successful SSE response, writes config with chatgpt base URL and enables one stream retry, mounts analytics capture, initializes the app server without managed config, starts a user thread, and starts a turn containing one image URL plus `responsesapi_client_metadata.workspace_kind = projectless`. After completion it waits for the analytics event and asserts many fields: thread/session/turn ids, client name, model/provider, sandbox policy, workspace kind, thread source, initialization mode, null subagent fields, image count, status, timestamps, token counts, timing fields as numbers, zero tool blocking, two sampling requests, one retry, and two actual response requests.

**Call relations**: This test is called by the runner and combines normal turn execution with analytics capture helpers from the sibling module. It is one of the few tests that validates side-channel telemetry rather than only protocol or filesystem effects.

*Call graph*: calls 5 internal fn (new_without_managed_config, mount_analytics_capture, wait_for_analytics_event, mount_response_sequence, start_mock_server); 11 external calls (default, from, new, Integer, write_mock_responses_config_toml_with_chatgpt_base_url, assert!, assert_eq!, read_to_string, write, timeout (+1 more)).


##### `turn_profile_tracks_blocking_tool_and_follow_up_sampling`  (lines 976–1077)

```
async fn turn_profile_tracks_blocking_tool_and_follow_up_sampling() -> Result<()>
```

**Purpose**: Checks analytics timing when a turn blocks on a tool request and then resumes sampling afterward. It ensures `tool_blocking_ms` becomes positive and sampling counts reflect the extra post-tool model request.

**Data flow**: Creates a mock sequence where the first model response requests user input and the second completes, writes config with analytics capture, initializes the app server, starts a thread, and starts a turn in collaboration Plan mode. It waits for `ServerRequest::ToolRequestUserInput`, sleeps briefly to create measurable blocking time, sends a JSON response answering the tool prompt, waits for turn completion, then fetches the analytics event and asserts positive `tool_blocking_ms`, `sampling_request_count = 2`, `sampling_retry_count = 0`, and `status = completed`.

**Call relations**: This test is invoked by the harness and uses the analytics helpers plus the checked mock sequence helper because a server request is expected mid-turn. It sits on the path where tool elicitation pauses and resumes model sampling.

*Call graph*: calls 3 internal fn (new_without_managed_config, mount_analytics_capture, wait_for_analytics_event); 12 external calls (default, new, Integer, create_mock_responses_server_sequence, write_mock_responses_config_toml_with_chatgpt_base_url, assert_eq!, json!, panic!, from_millis, sleep (+2 more)).


##### `turn_start_accepts_text_at_limit_with_mention_item`  (lines 1080–1140)

```
async fn turn_start_accepts_text_at_limit_with_mention_item() -> Result<()>
```

**Purpose**: Verifies that total text exactly at `MAX_USER_INPUT_TEXT_CHARS` is accepted even when combined with a non-text mention input item. It guards against overcounting non-text inputs toward the text limit.

**Data flow**: Creates config and a mock completion server, initializes the app server, starts a thread, then starts a turn whose input contains one `Text` item of exactly `MAX_USER_INPUT_TEXT_CHARS` characters and one `Mention` item. It reads the `TurnStartResponse`, asserts the returned turn status is `InProgress`, and waits for `turn/completed`.

**Call relations**: This test is a straightforward harness-driven validation case. It uses the standard setup helper and focuses on acceptance of boundary-sized input rather than inspecting outbound requests.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (from, default, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, timeout, vec!).


##### `turn_start_rejects_combined_oversized_text_input`  (lines 1143–1216)

```
async fn turn_start_rejects_combined_oversized_text_input() -> Result<()>
```

**Purpose**: Ensures the server rejects a turn when the combined character count across multiple text inputs exceeds the configured maximum. It also verifies structured error metadata and absence of `turn/started`.

**Data flow**: Creates config without needing a live model server, initializes the app server, starts a thread, constructs two text strings whose combined character count is one over `MAX_USER_INPUT_TEXT_CHARS`, and sends `turn/start`. It reads a `JSONRPCError`, asserts `INVALID_PARAMS_ERROR_CODE`, exact human-readable message, and structured `data` fields `input_error_code`, `max_chars`, and `actual_chars`. It then uses a short timeout to confirm no `turn/started` notification arrives.

**Call relations**: This test is entered directly by the runner and exercises preflight validation before any turn execution begins. It relies on the absence of downstream notifications as part of the assertion.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (from, default, new, Integer, assert!, assert_eq!, from_millis, timeout, vec!).


##### `turn_start_rejects_invalid_permission_selection_before_starting_turn`  (lines 1219–1291)

```
async fn turn_start_rejects_invalid_permission_selection_before_starting_turn() -> Result<()>
```

**Purpose**: Checks that an incompatible permission profile selection is rejected before the turn starts when managed config constraints disallow the requested sandbox/approval combination. It prevents invalid elevation from entering execution.

**Data flow**: Writes base config and a `managed_config.toml` forcing `sandbox_mode = "read-only"`, initializes the app server, starts a thread, and sends `turn/start` with a text input plus `permissions = BUILT_IN_PERMISSION_PROFILE_DANGER_FULL_ACCESS`. It reads a JSON-RPC error, asserts code `-32600`, and checks the message contains both the approval-policy incompatibility and the sandbox requirement mismatch. It then confirms no `turn/started` notification appears within a short timeout.

**Call relations**: This test is run by the harness and uses `create_config_toml` plus an extra managed-config file written inline. It specifically covers validation before any turn lifecycle notifications are emitted.

*Call graph*: calls 2 internal fn (new, create_config_toml); 10 external calls (from, default, new, Integer, assert!, assert_eq!, write, from_millis, timeout, vec!).


##### `turn_start_rejects_unknown_environment_before_starting_turn`  (lines 1294–1358)

```
async fn turn_start_rejects_unknown_environment_before_starting_turn() -> Result<()>
```

**Purpose**: Verifies that referencing a nonexistent environment id in `TurnEnvironmentParams` causes immediate request rejection. It ensures environment resolution happens before turn execution.

**Data flow**: Creates a repeating-assistant mock server and config, initializes the app server, starts a thread, then sends `turn/start` with one environment entry whose `environment_id` is `missing` and whose `cwd` is an absolute path. It reads a JSON-RPC error, asserts the request id matches, the code is `-32600`, and the message is exactly `unknown turn environment id `missing``. It then confirms no `turn/started` notification arrives.

**Call relations**: This test is invoked directly and uses the repeating-assistant helper only to satisfy model wiring. The core relation is validation failure before any model request or turn-start notification.

*Call graph*: calls 2 internal fn (new, create_config_toml); 10 external calls (default, default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, from_millis, timeout, vec!).


##### `turn_start_emits_notifications_and_accepts_model_override`  (lines 1361–1502)

```
async fn turn_start_emits_notifications_and_accepts_model_override() -> Result<()>
```

**Purpose**: Checks the baseline `turn/start` lifecycle notifications and verifies that a later turn can override the thread model. It confirms both notification contents and distinct turn ids across turns.

**Data flow**: Creates a mock server with three assistant completions, writes config, initializes the app server, starts a thread, and starts a first text turn with default model settings. It reads the turn response, `turn/started`, and `turn/completed`, asserting ids, `TurnStatus`, `TurnItemsView::NotLoaded`, and empty `items`. It then starts a second turn on the same thread with `model = Some("mock-model-override")`, reads the analogous notifications, and asserts the second turn id differs from the first while statuses and unloaded-items shape remain correct.

**Call relations**: This test is a direct harness entry and uses the unchecked sequence helper because only simple completions are needed. It exercises both the default path and the per-turn override path in one continuous thread.

*Call graph*: calls 2 internal fn (new, create_config_toml); 11 external calls (from, default, new, Integer, create_mock_responses_server_sequence_unchecked, assert!, assert_eq!, assert_ne!, from_value, timeout (+1 more)).


##### `turn_start_accepts_collaboration_mode_override_v2`  (lines 1505–1587)

```
async fn turn_start_accepts_collaboration_mode_override_v2() -> Result<()>
```

**Purpose**: Verifies that a turn-level `collaboration_mode` override replaces the model selection used for the upstream request and injects the expected request-user-input guidance. It checks that collaboration settings take precedence over ordinary turn overrides.

**Data flow**: After a network-availability guard, it mounts a single SSE response, writes config, initializes the app server, starts a thread with model `gpt-5.3-codex`, constructs a `CollaborationMode` whose settings specify `model = mock-model-collab` and `reasoning_effort = High`, then starts a turn that also includes ordinary `model`, `effort`, and `summary` overrides. After completion it inspects the single request body, asserting `payload["model"] == "mock-model-collab"` and that the serialized payload contains the request-user-input tool guidance string.

**Call relations**: This test is run by the harness and uses raw `responses` mocks plus a network skip macro. It validates precedence rules in request construction rather than notification sequencing.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once, sse, start_mock_server); 9 external calls (default, default, new, Integer, assert!, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `turn_start_uses_thread_feature_overrides_for_request_user_input_tool_description_v2`  (lines 1590–1673)

```
async fn turn_start_uses_thread_feature_overrides_for_request_user_input_tool_description_v2() -> Result<()>
```

**Purpose**: Checks that thread-level feature overrides affect the request-user-input tool description emitted in a collaboration-mode turn. It ensures thread config survives into later tool schema generation.

**Data flow**: With network available, it mounts a single SSE response, writes config, initializes the app server, and starts a thread whose `config` enables `features.default_mode_request_user_input`. It then starts a collaboration-mode turn and, after completion, inspects the request body text to assert it contains `This tool is only available in Default or Plan mode.`.

**Call relations**: This test is entered by the runner and mirrors the collaboration override test, but its distinguishing dependency is the thread-start config override that changes later tool-description text.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once, sse, start_mock_server); 10 external calls (default, default, from, new, Integer, assert!, json!, skip_if_no_network!, timeout, vec!).


##### `turn_start_accepts_personality_override_v2`  (lines 1676–1750)

```
async fn turn_start_accepts_personality_override_v2() -> Result<()>
```

**Purpose**: Verifies that a turn-level personality override injects a personality update into developer input for personality-capable models. It confirms the override is represented in the upstream request.

**Data flow**: After network gating, it mounts one SSE response, writes config with the Personality feature enabled, initializes the app server, starts a thread using `exp-codex-personality`, and starts a turn with `personality = Some(Personality::Friendly)`. After completion it inspects developer message texts from the captured request and asserts at least one contains `<personality_spec>`.

**Call relations**: This test is a direct harness case using the standard config helper. It focuses on request-body developer input rather than protocol notifications.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once, sse, start_mock_server); 9 external calls (from, default, new, Integer, assert!, eprintln!, skip_if_no_network!, timeout, vec!).


##### `turn_start_change_personality_mid_thread_v2`  (lines 1753–1863)

```
async fn turn_start_change_personality_mid_thread_v2() -> Result<()>
```

**Purpose**: Ensures personality updates are emitted only when the personality actually changes mid-thread. The first turn without override should not include a personality update, while the second turn with `Friendly` should.

**Data flow**: Mounts two SSE responses, writes config with Personality enabled, initializes the app server, starts a thread, runs a first turn with `personality: None`, waits for completion, then runs a second turn with `personality: Some(Friendly)` and waits again. It inspects the two captured requests, asserting the first request's developer texts contain no `<personality_spec>` and the second request's developer texts do contain it.

**Call relations**: This test is invoked by the harness and uses a two-request mock sequence. It compares successive turns on the same thread to validate stateful personality-change behavior.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_sequence, sse, start_mock_server); 9 external calls (from, default, new, Integer, assert!, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `turn_start_uses_migrated_pragmatic_personality_without_override_v2`  (lines 1866–1954)

```
async fn turn_start_uses_migrated_pragmatic_personality_without_override_v2() -> Result<()>
```

**Purpose**: Checks that startup personality migration persists `Pragmatic` into config and that subsequent turns use that migrated personality even without an explicit override. It ties startup migration side effects to later request construction.

**Data flow**: After network gating, it mounts one SSE response, writes config with Personality enabled, creates a fake rollout in the temp home, initializes the app server, then reads back `config.toml` as `ConfigToml` and asserts `personality == Some(Pragmatic)` plus existence of the migration marker file. It starts a thread and a turn with `personality: None`, waits for completion, then inspects the request instructions text and asserts it contains `LOCAL_PRAGMATIC_TEMPLATE`.

**Call relations**: This test combines startup-side migration behavior with later turn execution. It uses `create_fake_rollout` before initialization and then validates both persisted config state and outbound request instructions.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once, sse, start_mock_server); 12 external calls (from, default, new, Integer, create_fake_rollout, assert!, assert_eq!, skip_if_no_network!, read_to_string, timeout (+2 more)).


##### `turn_start_defaults_local_image_detail_to_high`  (lines 1957–1967)

```
async fn turn_start_defaults_local_image_detail_to_high() -> Result<()>
```

**Purpose**: Verifies that a local image input without an explicit detail level is sent upstream with `detail = high`. It covers the defaulting rule for local image uploads.

**Data flow**: Calls `run_local_image_turn(None)` to execute a turn with a local PNG and collect outbound `input_image` spans, then asserts exactly one image was sent and its `detail` field is `high`.

**Call relations**: This is a thin wrapper test around `run_local_image_turn`. It exists to pin the default-detail behavior while reusing the shared local-image setup path.

*Call graph*: calls 1 internal fn (run_local_image_turn); 1 external calls (assert_eq!).


##### `turn_start_forwards_custom_local_image_detail`  (lines 1970–1980)

```
async fn turn_start_forwards_custom_local_image_detail() -> Result<()>
```

**Purpose**: Verifies that an explicit local image detail override is preserved in the upstream request. It complements the default-detail test.

**Data flow**: Calls `run_local_image_turn(Some(ImageDetail::Original))`, receives the extracted `input_image` spans, and asserts there is one image whose `detail` field is `original`.

**Call relations**: Like the previous test, this is a small harness entry that delegates all setup and execution to `run_local_image_turn` and only checks the returned request payload fragment.

*Call graph*: calls 1 internal fn (run_local_image_turn); 1 external calls (assert_eq!).


##### `turn_start_exec_approval_toggle_v2`  (lines 1983–2137)

```
async fn turn_start_exec_approval_toggle_v2() -> Result<()>
```

**Purpose**: Checks both sides of command approval behavior across two turns: one turn should elicit approval under untrusted defaults, and a later turn with explicit `approval_policy = Never` plus full-access sandbox should skip approval entirely. It also verifies `serverRequest/resolved` ordering before turn completion in the approved case.

**Data flow**: Creates a mock sequence with two shell-command tool calls and two final assistant messages, writes config with default `approval_policy = untrusted`, initializes the app server, starts a thread, and runs a first turn. It reads the turn response, then a `ServerRequest::CommandExecutionRequestApproval`, asserts `item_id = call1`, sends an `Accept` response, and loops through messages until it sees `serverRequest/resolved` followed by `turn/completed`. It then starts a second turn with explicit `approval_policy: Never`, `sandbox_policy: DangerFullAccess`, and model/reasoning overrides, reads the turn response, and waits for `turn/completed` without receiving another approval request.

**Call relations**: This test is invoked by the harness and uses the checked mock sequence helper because approval requests are expected. It compares two turns on one thread to validate that per-turn overrides can disable elicitation that the thread's default config would otherwise require.

*Call graph*: calls 2 internal fn (new, create_config_toml); 13 external calls (default, default, new, Integer, create_mock_responses_server_sequence, assert!, assert_eq!, panic!, from_value, to_value (+3 more)).


##### `turn_start_exec_approval_decline_v2`  (lines 2140–2282)

```
async fn turn_start_exec_approval_decline_v2() -> Result<()>
```

**Purpose**: Verifies that declining a command execution approval marks the command item as declined with no exit code or output, while still allowing the turn to complete. It covers the negative approval branch for command tools.

**Data flow**: Creates a workspace and mock sequence with one shell command and one final assistant message, writes untrusted config, initializes the app server, starts a thread, and starts a turn in that workspace. It loops over `item/started` notifications until it finds `ThreadItem::CommandExecution`, asserting id `call-decline` and `InProgress` status. It then reads `ServerRequest::CommandExecutionRequestApproval`, asserts ids, sends a `Decline` response, loops over `item/completed` notifications until the command item appears, and asserts status `Declined`, `exit_code.is_none()`, and `aggregated_output.is_none()`. Finally it waits for `turn/completed`.

**Call relations**: This test is a direct harness case using the checked mock sequence helper. Its key relation is the item-stream filtering before and after the approval request to observe the command item's state transition.

*Call graph*: calls 2 internal fn (new, create_config_toml); 15 external calls (default, default, new, Integer, create_mock_responses_server_sequence, assert!, assert_eq!, panic!, from_value, to_value (+5 more)).


##### `turn_start_updates_sandbox_and_cwd_between_turns_v2`  (lines 2285–2454)

```
async fn turn_start_updates_sandbox_and_cwd_between_turns_v2() -> Result<()>
```

**Purpose**: Ensures per-turn sandbox policy and cwd overrides are rebound between turns on the same thread, and that command execution items reflect the second turn's cwd and command string. It guards against stale execution context leaking across turns.

**Data flow**: Creates codex home, workspace root, and two subdirectories, writes config with untrusted approval, initializes the app server, and starts a thread. It runs a first turn with `cwd = first_cwd`, `approval_policy = Never`, and a `WorkspaceWrite` sandbox rooted at `first_cwd`, waits for completion, and clears buffered messages. It then runs a second turn with `cwd = second_cwd` and `sandbox_policy = DangerFullAccess`, reads the turn response, loops until an `item/started` command execution appears, and asserts its `cwd` equals `second_cwd`, its `command` equals the shell-formatted `echo second turn`, and its status is `InProgress`. It then waits for turn completion.

**Call relations**: This test is entered by the runner and uses `format_with_current_shell_display` to compute the expected command string. It compares two sequential turns to validate runtime rebinding of execution context.

*Call graph*: calls 2 internal fn (new, create_config_toml); 14 external calls (default, default, new, Integer, create_mock_responses_server_sequence, format_with_current_shell_display, assert_eq!, matches!, from_value, skip_if_no_network! (+4 more)).


##### `turn_start_permission_profile_rebinds_runtime_workspace_roots_between_turns`  (lines 2458–2604)

```
async fn turn_start_permission_profile_rebinds_runtime_workspace_roots_between_turns() -> Result<()>
```

**Purpose**: Checks that a permission profile using `:workspace_roots` is materialized against the current turn's runtime workspace roots and rebound on later turns. It prevents stale root substitution in permissions instructions.

**Data flow**: On Unix with network available, it creates old and new workspace roots, writes a custom config whose default permissions profile grants write access to `:workspace_roots`, mounts two SSE responses, initializes the app server, starts a thread, and runs a first turn selecting the `dev` permissions profile with `runtime_workspace_roots = [old_root]`. After completion it runs a second turn with `runtime_workspace_roots = [new_root]` and no explicit permissions override. It then inspects the two captured Responses API requests, extracts the latest developer text containing `<permissions instructions>`, and asserts the first mentions only the old root while the second mentions only the new root.

**Call relations**: This test is a harness-driven integration case that bypasses the shared config helper and writes TOML inline to express the `:workspace_roots` permission profile. It validates request-body developer instructions across two turns.

*Call graph*: calls 4 internal fn (new, mount_sse_sequence, start_mock_server, from_absolute_path); 11 external calls (default, new, Integer, assert!, assert_eq!, format!, skip_if_no_network!, create_dir, write, timeout (+1 more)).


##### `turn_start_resolves_sticky_thread_local_environment_and_turn_overrides`  (lines 2607–2659)

```
async fn turn_start_resolves_sticky_thread_local_environment_and_turn_overrides() -> Result<()>
```

**Purpose**: Exercises combinations of sticky thread-local environment selection and per-turn environment overrides to ensure local execution resolution behaves consistently. It covers unset, empty, and explicit `local` selections.

**Data flow**: Creates codex home and workspace, writes config and an `environments.toml` containing a remote environment, initializes the app server, then iterates over several `EnvironmentSelectionCase` values describing sticky and turn-level environment id slices. For each case it calls `run_environment_selection_case`, which starts a thread and turn using `environment_params` to build `TurnEnvironmentParams`, then asserts the turn starts and completes successfully.

**Call relations**: This top-level test is mostly an orchestrator over `run_environment_selection_case`. It sets up the shared environment catalog once, then delegates each concrete sticky/override combination to the helper.

*Call graph*: calls 3 internal fn (new, create_config_toml, run_environment_selection_case); 6 external calls (default, new, create_mock_responses_server_repeating_assistant, create_dir, write, timeout).


##### `run_environment_selection_case`  (lines 2667–2740)

```
async fn run_environment_selection_case(
    mcp: &mut TestAppServer,
    workspace: &Path,
    case: EnvironmentSelectionCase,
) -> Result<()>
```

**Purpose**: Runs one environment-selection scenario by creating a thread with optional sticky environments and then starting a turn with optional per-turn overrides. It asserts the resulting turn starts and completes normally for that case.

**Data flow**: Accepts a mutable `TestAppServer`, workspace path, and `EnvironmentSelectionCase`. It sends `thread/start` with `cwd` and `environments` derived from `case.sticky`, reads the `ThreadStartResponse`, then sends `turn/start` with text input naming the case, `environments` derived from `case.turn`, explicit `cwd`, and model override. It reads the `TurnStartResponse`, then `turn/started` and `turn/completed` notifications, deserializes them, asserts ids and `TurnStatus::Completed`, and clears the message buffer before returning.

**Call relations**: This helper is called repeatedly by `turn_start_resolves_sticky_thread_local_environment_and_turn_overrides`. It encapsulates the repeated thread/start → turn/start → notification assertions for each environment-selection permutation.

*Call graph*: calls 6 internal fn (clear_message_buffer, read_stream_until_notification_message, read_stream_until_response_message, send_thread_start_request, send_turn_start_request, environment_params); called by 1 (turn_start_resolves_sticky_thread_local_environment_and_turn_overrides); 8 external calls (default, to_path_buf, to_string_lossy, Integer, assert_eq!, from_value, timeout, vec!).


##### `environment_params`  (lines 2742–2751)

```
fn environment_params(ids: Option<&[&str]>, cwd: &Path) -> Option<Vec<TurnEnvironmentParams>>
```

**Purpose**: Converts an optional slice of environment ids into the `TurnEnvironmentParams` vector expected by thread and turn requests. It standardizes use of the workspace absolute path as each environment's cwd.

**Data flow**: Takes `Option<&[&str]>` and a workspace `&Path`. If ids are present, it maps each id into `TurnEnvironmentParams { environment_id, cwd: cwd.abs().into() }` and returns `Some(Vec<_>)`; otherwise it returns `None`.

**Call relations**: This helper is only used by `run_environment_selection_case` to build both sticky thread environments and per-turn overrides from compact test-case data.

*Call graph*: called by 1 (run_environment_selection_case).


##### `turn_start_file_change_approval_v2`  (lines 2754–2920)

```
async fn turn_start_file_change_approval_v2() -> Result<()>
```

**Purpose**: Verifies the full file-change approval accept flow: a patch tool call becomes a `ThreadItem::FileChange`, emits an approval request, resolves before completion, applies the patch to disk, and completes the turn. It checks both protocol ordering and filesystem side effects.

**Data flow**: Creates codex home and workspace, prepares an add-file patch and mock sequence with `apply_patch` followed by a final assistant message, writes untrusted config, initializes the app server, starts a thread, and starts a turn in the workspace. It loops until an `item/started` notification yields `ThreadItem::FileChange`, asserting id `patch-call`, `PatchApplyStatus::InProgress`, and the parsed `changes` vector for `README.md`. It reads `ServerRequest::FileChangeRequestApproval`, asserts ids, sends an `Accept` response, then loops through notifications until it sees `serverRequest/resolved` and later `item/completed` for the file change, asserting completion status. Finally it reads the created file from disk and waits for `turn/completed`.

**Call relations**: This test is entered by the harness and uses the checked mock sequence helper because approval is expected. It combines item-stream observation, server-request handling, and direct filesystem verification.

*Call graph*: calls 2 internal fn (new, create_config_toml); 17 external calls (default, default, new, Integer, create_mock_responses_server_sequence, assert!, assert_eq!, panic!, assert_eq!, from_value (+7 more)).


##### `turn_start_does_not_stream_apply_patch_change_updates_without_feature_v2`  (lines 2923–3018)

```
async fn turn_start_does_not_stream_apply_patch_change_updates_without_feature_v2() -> Result<()>
```

**Purpose**: Ensures patch delta notifications are not emitted when the apply-patch streaming feature is disabled. It protects the feature gate around `item/fileChange/patchUpdated`.

**Data flow**: Creates codex home and workspace, mounts a custom SSE sequence that streams partial apply-patch input deltas and then a final patch tool call, writes config without enabling the streaming feature, initializes the app server, starts a thread and turn, waits for `turn/completed`, then inspects `mcp.pending_notification_methods()` and asserts none equal `item/fileChange/patchUpdated`.

**Call relations**: This test is run directly and uses a handcrafted SSE event stream to simulate incremental patch input. Its key relation is negative observation: the streamed deltas should not surface as notifications without the feature flag.

*Call graph*: calls 2 internal fn (new, create_config_toml); 10 external calls (default, default, new, Integer, create_mock_responses_server_sequence, assert!, skip_if_no_network!, create_dir, timeout, vec!).


##### `turn_start_streams_apply_patch_change_updates_v2`  (lines 3021–3177)

```
async fn turn_start_streams_apply_patch_change_updates_v2() -> Result<()>
```

**Purpose**: Verifies that when the streaming feature is enabled and the model/tool metadata supports freeform apply-patch input, incremental patch updates are emitted as `item/fileChange/patchUpdated` notifications. It checks filtering too, by ignoring unrelated function-call deltas.

**Data flow**: Creates codex home and workspace, mounts an SSE sequence containing an unrelated function call plus a custom-tool `apply_patch` call with two input delta events and a final patch completion, writes config enabling `Feature::ApplyPatchStreamingEvents` and disabling unrelated features, rewrites `models_cache.json` so `mock-model` advertises `apply_patch_tool_type = freeform`, initializes the app server, starts a thread and turn, and reads the `TurnStartResponse`. It then loops reading `item/fileChange/patchUpdated` notifications, deserializes `FileChangePatchUpdatedNotification`, asserts thread/turn/item ids and `PatchChangeKind::Add`, and keeps updating `streamed_content` from the `live.txt` change until it equals `live line\n`. It then waits for `turn/completed`.

**Call relations**: This test is a direct harness case that depends on both feature flags and model-cache metadata to activate the streaming path. It consumes repeated notifications until the full patch diff has accumulated.

*Call graph*: calls 2 internal fn (new, create_config_toml); 19 external calls (from, default, new, new, Integer, create_mock_responses_server_sequence, write_models_cache, assert!, assert_eq!, from (+9 more)).


##### `turn_start_emits_spawn_agent_item_with_model_metadata_v2`  (lines 3180–3420)

```
async fn turn_start_emits_spawn_agent_item_with_model_metadata_v2() -> Result<()>
```

**Purpose**: Checks that a multi-agent spawn tool call is surfaced as a `ThreadItem::CollabAgentToolCall` carrying the requested child model and reasoning effort, and that deleting the parent thread also deletes the spawned child thread. It validates both item metadata and descendant cleanup.

**Data flow**: With network available, it mounts three conditional SSE responses: parent turn emits `spawn_agent`, child turn completes, and parent follow-up completes. It writes config enabling `Feature::Collab`, initializes the app server, starts a parent thread, and starts a turn with the parent prompt. After reading the turn response, it loops for `item/started` until it finds the spawn item and asserts the full `ThreadItem::CollabAgentToolCall` structure, including empty `receiver_thread_ids`, prompt, requested model, requested reasoning effort, and empty `agents_states`. It then loops for `item/completed`, extracts the child thread id from `receiver_thread_ids`, asserts completed metadata and child agent state, waits for the parent `turn/completed`, sends `thread/delete` for the parent, reads two `thread/deleted` notifications for child then parent, and finally asserts `thread/loadedList` returns an empty list.

**Call relations**: This test is invoked by the harness and uses `body_contains`-based conditional mocks to distinguish parent, child, and follow-up model requests. It spans turn execution, multi-agent item tracking, and later thread-manager deletion behavior.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once_match, sse, start_mock_server); 15 external calls (from, default, new, new, Integer, default, assert!, assert_eq!, json!, from_value (+5 more)).


##### `direct_input_to_multi_agent_v2_subagent_is_rejected`  (lines 3423–3548)

```
async fn direct_input_to_multi_agent_v2_subagent_is_rejected() -> Result<()>
```

**Purpose**: Verifies that app-server clients cannot directly start or steer turns on multi-agent v2 sub-agent threads. Only the orchestrated parent-agent flow may drive those threads.

**Data flow**: Mounts a parent response that emits a `spawn_agent` function call, writes config enabling `Feature::MultiAgentV2`, writes models cache, initializes the app server, starts a parent thread, and starts a parent turn. It then loops over `item/completed` notifications until it finds `ThreadItem::SubAgentActivity` with `kind = Started`, extracting the child thread id. Using that child id, it sends a direct `turn/start` and reads a JSON-RPC error asserting code `-32600` and the fixed rejection message, then sends a direct `turn/steer` and asserts the same error semantics.

**Call relations**: This test is entered by the runner and depends on the spawn flow to obtain a real sub-agent thread id before exercising the rejection path. It validates both start and steer RPCs against the same invariant.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once_match, sse, start_mock_server); 12 external calls (from, default, new, Integer, to_response, write_models_cache, assert_eq!, json!, from_value, to_string (+2 more)).


##### `turn_start_emits_spawn_agent_item_with_effective_role_model_metadata_v2`  (lines 3551–3737)

```
async fn turn_start_emits_spawn_agent_item_with_effective_role_model_metadata_v2() -> Result<()>
```

**Purpose**: Checks that when a spawned agent uses a configured role, the emitted spawn item reflects the role's effective model and reasoning effort rather than the raw requested values. It validates role-config resolution in multi-agent metadata.

**Data flow**: Mounts parent, child, and parent-follow-up SSE responses similar to the previous spawn test, writes config enabling `Feature::Collab`, writes `custom-role.toml` specifying `ROLE_MODEL` and `ROLE_REASONING_EFFORT`, appends an `[agents.custom]` section to `config.toml`, initializes the app server, starts a thread, and starts the parent turn. It loops until `item/completed` yields the spawn item, extracts the child thread id, and asserts the completed `ThreadItem::CollabAgentToolCall` reports `model = ROLE_MODEL` and `reasoning_effort = ROLE_REASONING_EFFORT` while still carrying the child prompt and agent state. It then waits for the parent turn completion.

**Call relations**: This test is a harness-driven variant of the spawn-metadata test, but with extra role-config files written before initialization. It validates effective-role resolution rather than raw spawn arguments.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once_match, sse, start_mock_server); 16 external calls (from, default, new, Integer, assert!, assert_eq!, format!, json!, from_value, to_string (+6 more)).


##### `turn_start_file_change_approval_accept_for_session_persists_v2`  (lines 3740–3920)

```
async fn turn_start_file_change_approval_accept_for_session_persists_v2() -> Result<()>
```

**Purpose**: Verifies that accepting a file-change approval for the session suppresses future approval prompts for subsequent file changes in the same session. It checks persistence of approval state across turns.

**Data flow**: Creates workspace and two patch responses, writes untrusted config, initializes the app server, starts a thread, and runs a first turn that emits `patch-call-1`. It waits for the started file-change item, reads `ServerRequest::FileChangeRequestApproval`, sends `FileChangeApprovalDecision::AcceptForSession`, then waits for `item/completed` and `turn/completed` and confirms `README.md` contains `new line\n`. It then starts a second turn that emits `patch-call-2`, waits for the started file-change item and later `item/completed` and `turn/completed`, and relies on the helper behavior to fail if any unexpected approval request appears. Finally it asserts the file now contains `updated line\n`.

**Call relations**: This test is invoked directly and uses the checked mock sequence helper because the first turn must elicit approval. Its central relation is cross-turn state persistence of the approval decision.

*Call graph*: calls 2 internal fn (new, create_config_toml); 14 external calls (default, default, new, Integer, create_mock_responses_server_sequence, assert_eq!, panic!, from_value, to_value, skip_if_no_network! (+4 more)).


##### `turn_start_file_change_approval_decline_v2`  (lines 3923–4075)

```
async fn turn_start_file_change_approval_decline_v2() -> Result<()>
```

**Purpose**: Checks that declining a file-change approval marks the file-change item as declined and leaves the filesystem untouched. It covers the negative branch of patch approval.

**Data flow**: Creates workspace and a patch response, writes untrusted config, initializes the app server, starts a thread and turn, waits for the started `ThreadItem::FileChange`, asserts its parsed `changes` target `README.md`, reads `ServerRequest::FileChangeRequestApproval`, sends `FileChangeApprovalDecision::Decline`, then waits for the completed file-change item and asserts `PatchApplyStatus::Declined`. After `turn/completed`, it asserts the target file does not exist.

**Call relations**: This test is a direct harness case mirroring the accept-flow test but with a decline response. It combines item-state assertions with a negative filesystem check.

*Call graph*: calls 2 internal fn (new, create_config_toml); 16 external calls (default, default, new, Integer, create_mock_responses_server_sequence, assert!, assert_eq!, panic!, assert_eq!, from_value (+6 more)).


##### `command_execution_notifications_include_process_id`  (lines 4079–4213)

```
async fn command_execution_notifications_include_process_id() -> Result<()>
```

**Purpose**: Verifies that command execution items include a process id in both started and completed notifications when unified exec is enabled. It also checks that the completed item preserves the same pid and reports a plausible terminal status.

**Data flow**: Creates a mock sequence with an exec-command tool call and final assistant message, writes config via `create_config_toml_with_sandbox` enabling `Feature::UnifiedExec` and `danger-full-access`, initializes the app server, starts a thread, and starts a turn with full-access sandbox. It loops for `item/started` until it finds `ThreadItem::CommandExecution`, extracts and asserts a present `process_id`, then loops for `item/completed` until the same command item appears, asserting the same id, same process id, terminal status `Completed` or `Failed`, and corresponding exit-code expectations. It then waits for `turn/completed`.

**Call relations**: This test is entered by the harness and uses the sandbox-aware config helper rather than the simpler wrapper. It focuses on notification payload contents for unified exec.

*Call graph*: calls 2 internal fn (new, create_config_toml_with_sandbox); 12 external calls (from, default, new, Integer, create_mock_responses_server_sequence, assert!, assert_eq!, from_value, skip_if_no_network!, timeout (+2 more)).


##### `turn_start_with_elevated_override_does_not_persist_project_trust`  (lines 4216–4274)

```
async fn turn_start_with_elevated_override_does_not_persist_project_trust() -> Result<()>
```

**Purpose**: Ensures that using an elevated sandbox override on a single turn does not write persistent trust state into `config.toml`. It distinguishes ephemeral execution overrides from durable project trust.

**Data flow**: Creates a mock completion server and config, creates a separate workspace tempdir, initializes the app server, starts a thread rooted at that workspace, then starts a turn with `sandbox_policy = DangerFullAccess` and text input. After completion it reads `config.toml` from the Codex home and asserts it contains neither `trust_level = "trusted"` nor the workspace path string.

**Call relations**: This test is a direct harness case using the standard config helper. It validates post-turn persisted config state rather than notifications or request bodies.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (from, default, new, Integer, create_mock_responses_server_sequence_unchecked, assert!, read_to_string, timeout, vec!).


##### `create_config_toml`  (lines 4277–4290)

```
fn create_config_toml(
    codex_home: &Path,
    server_uri: &str,
    approval_policy: &str,
    feature_flags: &BTreeMap<Feature, bool>,
) -> std::io::Result<()>
```

**Purpose**: Convenience wrapper that writes a test `config.toml` using the default `read-only` sandbox. It keeps most tests from repeating the sandbox argument.

**Data flow**: Accepts Codex home path, server URI, approval policy string, and feature-flag map, then forwards those values plus `sandbox_mode = "read-only"` to `create_config_toml_with_sandbox`. It returns the underlying `std::io::Result<()>`.

**Call relations**: This helper is called by most tests in the file during setup. It exists solely to reduce duplication around the more general sandbox-aware config writer.

*Call graph*: calls 1 internal fn (create_config_toml_with_sandbox); called by 31 (direct_input_to_multi_agent_v2_subagent_is_rejected, run_local_image_turn, thread_start_omits_empty_instruction_overrides_from_model_request, turn_start_accepts_collaboration_mode_override_v2, turn_start_accepts_personality_override_v2, turn_start_accepts_text_at_limit_with_mention_item, turn_start_additional_context_flows_to_model_input, turn_start_change_personality_mid_thread_v2, turn_start_does_not_stream_apply_patch_change_updates_without_feature_v2, turn_start_emits_notifications_and_accepts_model_override (+15 more)).


##### `create_config_toml_with_sandbox`  (lines 4292–4338)

```
fn create_config_toml_with_sandbox(
    codex_home: &Path,
    server_uri: &str,
    approval_policy: &str,
    feature_flags: &BTreeMap<Feature, bool>,
    sandbox_mode: &str,
) -> std::io::Result<()
```

**Purpose**: Writes the feature-aware mock-provider `config.toml` used throughout the turn-start suite, parameterizing approval policy and sandbox mode. It translates `Feature` enum values into TOML keys using the global feature registry.

**Data flow**: Takes Codex home path, server URI, approval policy, feature-flag map, and sandbox mode. It copies the feature flags into a fresh `BTreeMap`, maps each `Feature` to its config key by searching `FEATURES`, formats `[features]` entries like `key = true/false`, joins `config.toml` under the home directory, and writes a TOML document containing model defaults, approval and sandbox settings, the features section, and a `[model_providers.mock_provider]` block pointing at `{server_uri}/v1` with zero retries.

**Call relations**: This helper is called directly by `command_execution_notifications_include_process_id` and indirectly by most other tests through `create_config_toml`. It is pure setup code and has no role after initialization.

*Call graph*: called by 2 (command_execution_notifications_include_process_id, create_config_toml); 4 external calls (new, join, format!, write).


##### `write_test_skill`  (lines 4340–4347)

```
fn write_test_skill(codex_home: &Path, name: &str) -> std::io::Result<()>
```

**Purpose**: Creates a synthetic skill directory with a minimal `SKILL.md` frontmatter and body. It is used to populate the skills catalog for trimming tests.

**Data flow**: Accepts the Codex home path and a skill name, creates `skills/<name>` recursively, then writes `SKILL.md` containing YAML frontmatter with `name` and `description` plus a simple markdown body. It returns `std::io::Result<()>`.

**Call relations**: This helper is only used by `turn_start_emits_thread_scoped_warning_notification_for_trimmed_skills` during fixture setup. It delegates to directory creation and file writing.

*Call graph*: called by 1 (turn_start_emits_thread_scoped_warning_notification_for_trimmed_skills); 4 external calls (join, format!, create_dir_all, write).


### `app-server/tests/suite/v2/turn_steer.rs`

`test` · `request handling`

This Unix-only integration test file drives `TestAppServer` through a normal thread and turn startup, then issues `turn/steer` requests under both valid and invalid conditions. The tests use temporary Codex homes, mock Responses API servers, and analytics capture to verify not only JSON-RPC responses but also telemetry emitted for steer attempts. One test confirms steering is rejected when there is no active turn on the thread and that the analytics event records `result = rejected` with `rejection_reason = no_active_turn`. Another starts a long-running shell-command turn and then sends oversized steer text, asserting `INVALID_PARAMS_ERROR_CODE`, structured input-too-large metadata, and finally interrupting the still-running turn for cleanup. The accepted-path test starts a running turn, sends a steer request with a matching `expected_turn_id`, verifies the `TurnSteerResponse` echoes the active turn id, waits for an `item/started` notification containing a `ThreadItem::UserMessage` with the steer content and client id, and checks analytics fields such as accepted turn id and image count. The final test proves that `additional_context` alone is insufficient: a steer request with empty `input` but non-empty context is rejected with `input must not be empty`, and the rejected context is not merged into the subsequent model request. Across the file, the tests are careful to distinguish request rejection before merge from accepted steering that becomes a user-message item in the active turn.

#### Function details

##### `turn_steer_requires_active_turn`  (lines 40–105)

```
async fn turn_steer_requires_active_turn() -> Result<()>
```

**Purpose**: Verifies that `turn/steer` is rejected when the target thread has no active turn and that analytics record the rejection reason. It covers the basic precondition for steering.

**Data flow**: Creates a temp Codex home, starts an empty mock server, writes config with chatgpt base URL, mounts analytics capture, initializes `TestAppServer` without managed config, and starts a thread. It then sends `TurnSteerParams` with a nonexistent `expected_turn_id`, reads a `JSONRPCError`, and asserts code `-32600`. Afterward it waits for the `codex_turn_steer_event` analytics payload and asserts thread id, `result = rejected`, zero input images, the expected turn id string, null accepted turn id, and `rejection_reason = no_active_turn`.

**Call relations**: This Tokio test is invoked by the harness and uses the analytics helpers from the sibling module. It follows thread/start but intentionally skips turn/start to exercise the no-active-turn rejection branch.

*Call graph*: calls 3 internal fn (new_without_managed_config, mount_analytics_capture, wait_for_analytics_event); 9 external calls (default, new, Integer, create_mock_responses_server_sequence, write_mock_responses_config_toml_with_chatgpt_base_url, assert_eq!, create_dir, timeout, vec!).


##### `turn_steer_rejects_oversized_text_input`  (lines 108–217)

```
async fn turn_steer_rejects_oversized_text_input() -> Result<()>
```

**Purpose**: Checks that steering input is subject to the same maximum text-length validation as turn start. It also ensures the active turn can still be interrupted and cleaned up afterward.

**Data flow**: Creates temp directories and a mock server whose first response launches a long-running shell command, writes config and mounts analytics capture, initializes the app server, starts a thread, and starts a turn in the working directory. After observing `turn/started`, it constructs a string one character longer than `MAX_USER_INPUT_TEXT_CHARS`, sends `TurnSteerParams` targeting the active turn, reads a `JSONRPCError`, and asserts `INVALID_PARAMS_ERROR_CODE`, the exact message, and structured `data` fields including `actual_chars`. It then interrupts the active turn and waits for aborted completion.

**Call relations**: This test is run directly by the harness and uses the unchecked mock sequence helper because only the long-running command matters. It exercises steer-time validation while a turn is genuinely active.

*Call graph*: calls 2 internal fn (new_without_managed_config, mount_analytics_capture); 9 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, write_mock_responses_config_toml_with_chatgpt_base_url, assert_eq!, create_dir, timeout, vec!).


##### `turn_steer_returns_active_turn_id`  (lines 220–363)

```
async fn turn_steer_returns_active_turn_id() -> Result<()>
```

**Purpose**: Verifies the successful steering path: the response returns the active turn id, the steer input becomes a user-message item, and analytics record acceptance. It confirms steering attaches to the currently running turn rather than creating a new one.

**Data flow**: Creates temp directories and a mock server that first launches a short sleep command and then returns a final assistant message, writes config and analytics capture, initializes the app server, starts a thread, and starts a turn. After `turn/started`, it sends `TurnSteerParams` with `client_user_message_id = client-steer-message-1`, text input `steer`, and `expected_turn_id` equal to the active turn id. It reads `TurnSteerResponse` and asserts `turn_id` matches the active turn. It then loops over `item/started` notifications until it finds a `ThreadItem::UserMessage` with the matching client id and asserts its content equals the steer input. Finally it reads the analytics event and asserts accepted result fields, then waits for `turn/completed`.

**Call relations**: This test is invoked by the harness and uses both analytics helpers. Its distinctive relation is the notification loop that proves accepted steering is materialized as a user-message item inside the active turn.

*Call graph*: calls 3 internal fn (new_without_managed_config, mount_analytics_capture, wait_for_analytics_event); 10 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, write_mock_responses_config_toml_with_chatgpt_base_url, assert_eq!, from_value, create_dir, timeout, vec!).


##### `turn_steer_rejects_context_only_input_without_merging_context`  (lines 366–480)

```
async fn turn_steer_rejects_context_only_input_without_merging_context() -> Result<()>
```

**Purpose**: Ensures a steer request with empty `input` but non-empty `additional_context` is rejected and that the rejected context is not merged into the model request stream. It protects against context-only steering side effects.

**Data flow**: Creates temp directories and a mock server that launches a short sleep command then completes, writes config and analytics capture, initializes the app server, starts a thread and turn, and waits for `turn/started`. It builds `additional_context` containing `browser_info = tab one`, sends `TurnSteerParams` with `input: Vec::new()` and that context, reads a `JSONRPCError`, and asserts code `-32600` and message `input must not be empty`. After the turn completes normally, it fetches recorded `/responses` requests from the mock server, asserts there were two, parses the second request body, and asserts its string form does not contain `<external_browser_info>tab one</external_browser_info>`.

**Call relations**: This test is a direct harness case using the unchecked mock sequence helper. It validates both immediate request rejection and the absence of downstream prompt contamination from rejected context.

*Call graph*: calls 2 internal fn (new_without_managed_config, mount_analytics_capture); 12 external calls (default, from, new, new, Integer, create_mock_responses_server_sequence_unchecked, write_mock_responses_config_toml_with_chatgpt_base_url, assert!, assert_eq!, create_dir (+2 more)).


### Review, compaction, and imported sessions
These suites cover higher-level lifecycle flows layered on threads, including review execution, context compaction, external-agent imports, and safety/status signaling during active sessions.

### `app-server/tests/suite/v2/compaction.rs`

`test` · `request handling`

This file drives the app-server through realistic thread and turn flows to verify context compaction behavior. It uses mock SSE response streams from `core_test_support::responses` to simulate token-heavy turns that cross configured compaction thresholds, then observes the server’s thread-level notifications. The constants at the top define timeout policy, the auto-compaction token limit, the compaction prompt text, and the JSON-RPC invalid-request code expected for bad thread ids.

The local and remote auto-compaction tests share the same shape: create a mock responses server, mount a sequence of turn responses, write a mock-provider config, initialize `TestAppServer`, create a thread with `start_thread`, and submit three turns with `send_turn_and_wait`. After the triggering turn, they wait specifically for `ThreadItem::ContextCompaction` notifications via `wait_for_context_compaction_started` and `wait_for_context_compaction_completed`, then assert both notifications refer to the same thread and compaction item id. The remote variant additionally mounts `/v1/responses/compact`, writes ChatGPT auth, disables `OPENAI_API_KEY`, and inspects request headers to verify turn metadata and compaction metadata fields such as trigger, reason, implementation, phase, strategy, turn id, and window id.

Helper functions encapsulate the repetitive JSON-RPC request/response pattern for starting threads and turns, and the notification loops intentionally ignore unrelated events until the desired turn id or context-compaction item appears.

#### Function details

##### `auto_compaction_local_emits_started_and_completed_items`  (lines 51–107)

```
async fn auto_compaction_local_emits_started_and_completed_items() -> Result<()>
```

**Purpose**: Verifies that local auto-compaction is triggered after enough token-heavy turns and that the server emits matching `item/started` and `item/completed` notifications for a context-compaction item. It checks both notifications belong to the same thread and compaction id.

**Data flow**: Starts a mock responses server, mounts four SSE sequences representing two large turns, one local summary turn, and one final reply, writes mock-provider config with `AUTO_COMPACT_LIMIT`, starts and initializes `TestAppServer`, creates a thread, and sends three user turns. It then waits for context-compaction started/completed notifications, destructures their `ThreadItem::ContextCompaction` ids, asserts both notifications reference the created thread and the same compaction item id, and returns `Ok(())`.

**Call relations**: Invoked by the Tokio test harness. It delegates thread creation and turn submission to `start_thread` and `send_turn_and_wait`, and uses the two notification wait helpers to filter the stream down to context-compaction lifecycle events.

*Call graph*: calls 8 internal fn (new, send_turn_and_wait, start_thread, wait_for_context_compaction_completed, wait_for_context_compaction_started, mount_sse_sequence, sse, start_mock_server); 8 external calls (default, new, write_mock_responses_config_toml, assert_eq!, skip_if_no_network!, timeout, unreachable!, vec!).


##### `auto_compaction_remote_emits_started_and_completed_items`  (lines 110–249)

```
async fn auto_compaction_remote_emits_started_and_completed_items() -> Result<()>
```

**Purpose**: Checks the remote compaction path, including notification emission and request metadata sent to both normal turn requests and the `/responses/compact` endpoint. It proves the server chooses remote compaction when configured and authenticated.

**Data flow**: Builds three SSE turn responses and a one-shot compact JSON response containing a summary message plus a `ResponseItem::Compaction`, writes config with `Feature::RemoteCompactionV2` disabled and `requires_openai_auth = Some(true)`, writes ChatGPT auth credentials, starts `TestAppServer::new_with_env` with `OPENAI_API_KEY` unset, creates a thread, and sends three turns. After asserting matching started/completed context-compaction notifications, it inspects the compact endpoint requests and normal response requests, parses `x-codex-turn-metadata` headers with `parse_json_header`, and asserts request-kind, turn-id, window-id, and compaction metadata fields match the expected remote pre-turn compaction semantics.

**Call relations**: This test is called by the harness and extends the local auto-compaction flow with auth setup and HTTP request inspection. It relies on `start_thread`, `send_turn_and_wait`, and the compaction notification helpers for the RPC side, then uses `parse_json_header` to validate metadata propagated to the mock HTTP server.

*Call graph*: calls 10 internal fn (new, new_with_env, send_turn_and_wait, start_thread, wait_for_context_compaction_completed, wait_for_context_compaction_started, mount_compact_json_once, mount_sse_sequence, sse, start_mock_server); 11 external calls (from, new, write_chatgpt_auth, write_mock_responses_config_toml, assert!, assert_eq!, json!, skip_if_no_network!, timeout, unreachable! (+1 more)).


##### `thread_compact_start_triggers_compaction_and_returns_empty_response`  (lines 252–305)

```
async fn thread_compact_start_triggers_compaction_and_returns_empty_response() -> Result<()>
```

**Purpose**: Verifies the explicit `thread/compact/start` RPC triggers a compaction run and returns a successful empty response payload. It also checks the corresponding started/completed context-compaction notifications.

**Data flow**: Starts a mock server with one SSE summary response, writes config, initializes `TestAppServer`, creates a thread, sends `ThreadCompactStartParams { thread_id }`, waits for the matching JSON-RPC response, deserializes it as `ThreadCompactStartResponse`, then waits for context-compaction started and completed notifications. It extracts the compaction ids from both notifications and asserts they match each other and the original thread id.

**Call relations**: Invoked by the test harness. It reuses `start_thread` and the notification wait helpers, but unlike the auto-compaction tests it triggers compaction directly through the dedicated RPC.

*Call graph*: calls 7 internal fn (new, start_thread, wait_for_context_compaction_completed, wait_for_context_compaction_started, mount_sse_sequence, sse, start_mock_server); 9 external calls (default, new, Integer, write_mock_responses_config_toml, assert_eq!, skip_if_no_network!, timeout, unreachable!, vec!).


##### `thread_compact_start_rejects_invalid_thread_id`  (lines 308–341)

```
async fn thread_compact_start_rejects_invalid_thread_id() -> Result<()>
```

**Purpose**: Checks that `thread/compact/start` rejects syntactically invalid thread ids with the JSON-RPC invalid-request code and an explanatory message. It validates input parsing before any thread lookup occurs.

**Data flow**: Starts a mock server and configured app-server, sends `ThreadCompactStartParams` with `thread_id = "not-a-thread-id"`, waits for the matching `JSONRPCError`, and asserts `error.code == -32600` plus `error.message` contains `invalid thread id`.

**Call relations**: This negative test is run directly by the harness. It follows the standard request/error path and does not use any helper beyond server initialization because no valid thread setup is needed.

*Call graph*: calls 2 internal fn (new, start_mock_server); 8 external calls (default, new, Integer, write_mock_responses_config_toml, assert!, assert_eq!, skip_if_no_network!, timeout).


##### `thread_compact_start_rejects_unknown_thread_id`  (lines 344–377)

```
async fn thread_compact_start_rejects_unknown_thread_id() -> Result<()>
```

**Purpose**: Verifies that a well-formed but nonexistent thread id is rejected as an invalid request with a `thread not found` message. It distinguishes lookup failure from syntax failure.

**Data flow**: Creates a configured app-server, sends `ThreadCompactStartParams` with a UUID-shaped thread id that was never created, waits for the matching `JSONRPCError`, and asserts the code is `-32600` and the message contains `thread not found`.

**Call relations**: Invoked by the test harness as the companion to the invalid-id test. It exercises the server’s thread lookup path after id parsing succeeds.

*Call graph*: calls 2 internal fn (new, start_mock_server); 8 external calls (default, new, Integer, write_mock_responses_config_toml, assert!, assert_eq!, skip_if_no_network!, timeout).


##### `start_thread`  (lines 379–393)

```
async fn start_thread(mcp: &mut TestAppServer) -> Result<String>
```

**Purpose**: Starts a new thread using the mock model and returns the created thread id. It packages the repeated request/response boilerplate used by multiple compaction tests.

**Data flow**: Sends `ThreadStartParams` with `model: Some("mock-model")` and other fields defaulted, waits under `DEFAULT_READ_TIMEOUT` for the matching response message, deserializes it to `ThreadStartResponse`, and returns `thread.id`.

**Call relations**: Called by the local auto-compaction, remote auto-compaction, and manual compaction tests. It sits at the beginning of those flows so later turn and compaction requests have a valid thread target.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_start_request); called by 3 (auto_compaction_local_emits_started_and_completed_items, auto_compaction_remote_emits_started_and_completed_items, thread_compact_start_triggers_compaction_and_returns_empty_response); 3 external calls (default, Integer, timeout).


##### `send_turn_and_wait`  (lines 395–419)

```
async fn send_turn_and_wait(
    mcp: &mut TestAppServer,
    thread_id: &str,
    text: &str,
) -> Result<String>
```

**Purpose**: Starts a turn with a single text user input and waits until that turn completes, returning the turn id. It hides the repetitive turn-start and completion-notification sequence.

**Data flow**: Accepts a mutable `TestAppServer`, thread id, and input text; sends `TurnStartParams` containing one `V2UserInput::Text`, waits for the matching `JSONRPCResponse`, deserializes it to `TurnStartResponse`, then calls `wait_for_turn_completed` with the returned turn id before returning that id.

**Call relations**: Used by both auto-compaction tests to submit multiple turns in sequence. It delegates completion synchronization to `wait_for_turn_completed` so callers only proceed once the turn has fully finished.

*Call graph*: calls 3 internal fn (read_stream_until_response_message, send_turn_start_request, wait_for_turn_completed); called by 2 (auto_compaction_local_emits_started_and_completed_items, auto_compaction_remote_emits_started_and_completed_items); 4 external calls (default, Integer, timeout, vec!).


##### `wait_for_turn_completed`  (lines 421–434)

```
async fn wait_for_turn_completed(mcp: &mut TestAppServer, turn_id: &str) -> Result<()>
```

**Purpose**: Consumes `turn/completed` notifications until it finds one for the specified turn id. It filters out unrelated completion events from the shared notification stream.

**Data flow**: Loops reading `turn/completed` notifications under timeout, deserializes each notification’s params into `TurnCompletedNotification`, compares `completed.turn.id` to the target `turn_id`, and returns `Ok(())` when they match.

**Call relations**: Called only by `send_turn_and_wait`. It is the notification-side counterpart to the turn-start response read and ensures the helper waits for the correct turn, not just any completion event.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 1 (send_turn_and_wait); 2 external calls (from_value, timeout).


##### `wait_for_context_compaction_started`  (lines 436–451)

```
async fn wait_for_context_compaction_started(
    mcp: &mut TestAppServer,
) -> Result<ItemStartedNotification>
```

**Purpose**: Waits for the next `item/started` notification whose item is a context-compaction thread item. It ignores unrelated started items.

**Data flow**: Loops reading `item/started` notifications under timeout, deserializes params into `ItemStartedNotification`, pattern-matches `started.item` against `ThreadItem::ContextCompaction`, and returns the full notification once a match is found.

**Call relations**: Used by all three positive compaction tests after turns or manual compaction are initiated. It isolates the notification filtering logic so the tests can focus on asserting thread ids and compaction ids.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 3 (auto_compaction_local_emits_started_and_completed_items, auto_compaction_remote_emits_started_and_completed_items, thread_compact_start_triggers_compaction_and_returns_empty_response); 2 external calls (from_value, timeout).


##### `wait_for_context_compaction_completed`  (lines 453–468)

```
async fn wait_for_context_compaction_completed(
    mcp: &mut TestAppServer,
) -> Result<ItemCompletedNotification>
```

**Purpose**: Waits for the next `item/completed` notification whose item is a context-compaction thread item. It is the completion-side companion to `wait_for_context_compaction_started`.

**Data flow**: Loops reading `item/completed` notifications under timeout, deserializes params into `ItemCompletedNotification`, pattern-matches `completed.item` against `ThreadItem::ContextCompaction`, and returns the matching notification.

**Call relations**: Called by the positive compaction tests after they observe the started notification. Together with `wait_for_context_compaction_started`, it lets those tests verify the full compaction item lifecycle.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 3 (auto_compaction_local_emits_started_and_completed_items, auto_compaction_remote_emits_started_and_completed_items, thread_compact_start_triggers_compaction_and_returns_empty_response); 2 external calls (from_value, timeout).


##### `parse_json_header`  (lines 470–472)

```
fn parse_json_header(value: &str) -> serde_json::Value
```

**Purpose**: Parses a JSON-valued HTTP header string into `serde_json::Value`. It is used to inspect turn metadata headers captured by the mock server.

**Data flow**: Takes a header string slice, calls `serde_json::from_str`, and returns the parsed `Value`, panicking if the header is not valid JSON.

**Call relations**: Used only by the remote auto-compaction test when validating `x-codex-turn-metadata` on recorded HTTP requests. It keeps the header parsing step concise and explicit.

*Call graph*: 1 external calls (from_str).


### `app-server/tests/suite/v2/external_agent_config.rs`

`test` · `migration/import workflows`

This file is a broad integration suite for `externalAgentConfig/*` RPCs. It uses temporary homes, synthetic `.claude` source data, and mock model servers to validate detection and import of external configuration artifacts into Codex state. The simplest path imports only `CONFIG` items and asserts both progress and completion notifications arrive, that the returned `import_id` is non-empty, and that import details are persisted in the SQLite-backed state database and retrievable through `externalAgentConfig/import/readHistories`. A failure case writes an invalid existing `config.toml` and confirms the import returns JSON-RPC error `-32603` mentioning the invalid config.

Plugin migration tests cover local marketplace plugins becoming listed as installed and enabled, and pending non-local plugin imports still producing a completion notification after background work settles. Session migration tests are more involved: they synthesize Claude-style `session.jsonl` files, detect them, import them into threads, verify imported thread preview/title and imported marker items, resume the thread, and run a follow-up turn to prove the imported rollout is usable. Additional tests lock in subtle behavior: imports must not initialize required MCP servers, detected payloads remain acceptable after restart, duplicate imports skip already imported session versions, and background session import returns its initial response before blocked file reads finish. The final compaction test configures a low auto-compact limit and proves that a huge imported session is summarized before the first follow-up turn, with the summary injected into the second provider request.

#### Function details

##### `assert_import_response`  (lines 38–41)

```
fn assert_import_response(response: ExternalAgentConfigImportResponse) -> String
```

**Purpose**: Validates that an import response contains a non-empty `import_id` and returns that ID for later assertions.

**Data flow**: It takes an `ExternalAgentConfigImportResponse`, asserts `response.import_id` is not empty, and returns the `String` import ID by value. It does not touch external state.

**Call relations**: Nearly every import-oriented test calls this helper immediately after deserializing the initial import response so later notification and history assertions can key off the returned ID.

*Call graph*: called by 8 (external_agent_config_import_accepts_detected_session_payload_after_restart, external_agent_config_import_compacts_huge_session_before_first_follow_up, external_agent_config_import_creates_session_rollouts, external_agent_config_import_returns_before_background_session_import_finishes, external_agent_config_import_sends_completion_notification_after_pending_plugins_finish, external_agent_config_import_sends_completion_notification_for_local_plugins, external_agent_config_import_sends_completion_notification_for_sync_only_import, external_agent_config_import_skips_already_imported_session_versions); 1 external calls (assert!).


##### `external_agent_config_import_sends_completion_notification_for_sync_only_import`  (lines 44–158)

```
async fn external_agent_config_import_sends_completion_notification_for_sync_only_import() -> Result<()>
```

**Purpose**: Verifies the synchronous config-only import path returns an import response, emits progress and completion notifications, records detailed results in state DB, and exposes them through import history reads.

**Data flow**: It creates temp directories for Codex home and SQLite home, starts `TestAppServer::new_with_env` with `HOME` and `CODEX_SQLITE_HOME`, initializes, sends a raw `externalAgentConfig/import` request containing one `CONFIG` migration item, reads and deserializes the response, extracts `import_id` via `assert_import_response`, then reads progress and completed notifications and deserializes them into typed notification structs. It opens `codex_state::StateRuntime`, fetches the persisted details record by `import_id`, compares persisted successes/failures against the notification payload, then sends `externalAgentConfig/import/readHistories`, deserializes the response, finds the matching history entry, and asserts completion timestamp plus successes/failures match.

**Call relations**: This is the most comprehensive sync-import test and is invoked directly by the harness. It uses `assert_import_response` as the bridge from initial response to later notification/state/history checks.

*Call graph*: calls 3 internal fn (new_with_env, assert_import_response, init); 8 external calls (new, Integer, to_response, assert!, assert_eq!, from_value, json!, timeout).


##### `external_agent_config_import_returns_error_for_failed_sync_import`  (lines 161–200)

```
async fn external_agent_config_import_returns_error_for_failed_sync_import() -> Result<()>
```

**Purpose**: Checks that a config import fails fast with a server error when an existing `config.toml` is invalid and cannot be merged or updated.

**Data flow**: It creates `.claude/settings.json` and an intentionally malformed `config.toml`, starts the server with `HOME` pointing at that temp home, initializes, sends a raw `externalAgentConfig/import` request for a `CONFIG` item, waits for the request-specific error response, and asserts code `-32603` plus an error message containing `invalid existing config.toml`.

**Call relations**: Called by the test harness, it exercises the negative synchronous import path without using any of the later notification or history-reading flows.

*Call graph*: calls 1 internal fn (new_with_env); 8 external calls (new, Integer, assert!, assert_eq!, json!, create_dir_all, write, timeout).


##### `external_agent_config_import_sends_completion_notification_for_local_plugins`  (lines 203–315)

```
async fn external_agent_config_import_sends_completion_notification_for_local_plugins() -> Result<()>
```

**Purpose**: Verifies that importing plugin settings from a local marketplace completes successfully and results in the plugin being listed as installed and enabled.

**Data flow**: It constructs a local marketplace tree under `marketplace/.agents/plugins/marketplace.json`, a plugin manifest under `.codex-plugin/plugin.json`, and Claude settings enabling `sample@debug` with `extraKnownMarketplaces` pointing at the local marketplace path. After starting the server with `HOME` set, it sends a raw import request for a `PLUGINS` migration item naming marketplace `debug` and plugin `sample`, deserializes the import response, extracts the `import_id`, waits for the completed notification, then sends `plugin/list` and deserializes `PluginListResponse`. It locates the `debug` marketplace and `sample` plugin and asserts `installed` and `enabled` are true.

**Call relations**: This test is entered by the harness and combines `assert_import_response` with a post-import `plugin/list` query to validate the side effects of plugin migration.

*Call graph*: calls 2 internal fn (new_with_env, assert_import_response); 11 external calls (new, Integer, to_response, assert!, assert_eq!, from_value, json!, to_string_pretty, create_dir_all, write (+1 more)).


##### `external_agent_config_import_sends_completion_notification_after_pending_plugins_finish`  (lines 318–381)

```
async fn external_agent_config_import_sends_completion_notification_after_pending_plugins_finish() -> Result<()>
```

**Purpose**: Ensures that plugin imports involving pending background work still eventually emit the completion notification.

**Data flow**: It writes Claude settings that reference a non-local marketplace with an intentionally invalid source, starts the server with `HOME` set, initializes, sends a raw `PLUGINS` import request for `formatter@acme-tools`, deserializes the initial import response, extracts the `import_id`, then waits for and deserializes the `externalAgentConfig/import/completed` notification and asserts the IDs match.

**Call relations**: The test harness invokes it directly. It focuses on notification timing and completion semantics rather than validating plugin installation state afterward.

*Call graph*: calls 2 internal fn (new_with_env, assert_import_response); 9 external calls (new, Integer, to_response, assert_eq!, from_value, json!, create_dir_all, write, timeout).


##### `external_agent_config_import_creates_session_rollouts`  (lines 384–598)

```
async fn external_agent_config_import_creates_session_rollouts() -> Result<()>
```

**Purpose**: Validates end-to-end session migration from an external `.claude` session file into a Codex thread that can later be resumed and continued.

**Data flow**: It creates a mock responses server and writes provider config via `create_config_toml`, synthesizes a Claude `session.jsonl` containing user, assistant, and custom-title records under `.claude/projects/repo`, starts the server with `HOME` set, initializes, sends `externalAgentConfig/detect` with `includeHome: true`, deserializes `ExternalAgentConfigDetectResponse`, then imports the detected items and waits for completion. From the completed notification it extracts the imported thread ID, then calls `thread/list` and `thread/read` to verify preview, title, turn count, and that the imported turn ends with `ThreadItem::AgentMessage { text: "<EXTERNAL SESSION IMPORTED>" }`. It resumes the thread, starts a follow-up turn with `UserInput::Text`, waits for response and `turn/completed`, then reads the thread again and asserts the second turn contains the mock assistant follow-up answer.

**Call relations**: This is the central session-migration integration test. It uses `create_config_toml` for provider setup and `assert_import_response` to connect the import response to the later completion and thread-inspection steps.

*Call graph*: calls 3 internal fn (new_with_env, assert_import_response, create_config_toml); 15 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, to_response, assert_eq!, now, panic!, from_value, json! (+5 more)).


##### `external_agent_config_import_does_not_initialize_required_mcp`  (lines 601–691)

```
async fn external_agent_config_import_does_not_initialize_required_mcp() -> Result<()>
```

**Purpose**: Proves that importing sessions does not trigger initialization of required MCP servers from the user's config.

**Data flow**: It writes a normal mock-provider config, appends an `[mcp_servers.required_broken]` entry with a nonexistent command and `required = true`, creates a minimal Claude session file, starts the server with `HOME` set, initializes, sends a raw `SESSIONS` import request, waits for the response and completion notification, then calls `thread/list` and asserts exactly one thread exists. The absence of startup failure is the key signal that required MCP initialization was skipped during import.

**Call relations**: Invoked by the harness, it reuses `create_config_toml` for baseline config but intentionally adds a broken required MCP server to validate import isolation from normal MCP startup behavior.

*Call graph*: calls 2 internal fn (new_with_env, create_config_toml); 11 external calls (new, Integer, create_mock_responses_server_repeating_assistant, to_response, assert_eq!, now, json!, create_dir_all, read_to_string, write (+1 more)).


##### `external_agent_config_import_accepts_detected_session_payload_after_restart`  (lines 694–782)

```
async fn external_agent_config_import_accepts_detected_session_payload_after_restart() -> Result<()>
```

**Purpose**: Checks that a session-import payload remains valid across process restart boundaries and can still be imported afterward.

**Data flow**: It writes provider config and a Claude session file, starts the server with `HOME` set, initializes, sends a raw `SESSIONS` import request using an explicit payload shaped like a detected item, deserializes the response, extracts `import_id`, waits for completion, then calls `thread/list` and asserts one thread was created.

**Call relations**: This test is a restart-safety regression check invoked by the harness. It uses `create_config_toml` and `assert_import_response`, but its main assertion is simply that the import payload is accepted and produces one imported thread.

*Call graph*: calls 3 internal fn (new_with_env, assert_import_response, create_config_toml); 11 external calls (new, Integer, create_mock_responses_server_repeating_assistant, to_response, assert_eq!, now, from_value, json!, create_dir_all, write (+1 more)).


##### `external_agent_config_import_skips_already_imported_session_versions`  (lines 785–874)

```
async fn external_agent_config_import_skips_already_imported_session_versions() -> Result<()>
```

**Purpose**: Verifies idempotence at the session-version level: importing the same detected session payload twice should not create duplicate threads.

**Data flow**: It writes provider config and a Claude session file, starts the server with `HOME` set, initializes, detects migration items via `externalAgentConfig/detect`, then loops twice sending `externalAgentConfig/import` with the same detected items. Each iteration deserializes the response, extracts `import_id`, waits for completion, and checks the notification ID. After both imports, it calls `thread/list` and asserts only one thread exists.

**Call relations**: The harness invokes it directly. It combines detection with repeated import calls and uses `assert_import_response` in each iteration before the final deduplication assertion on thread count.

*Call graph*: calls 3 internal fn (new_with_env, assert_import_response, create_config_toml); 11 external calls (new, Integer, create_mock_responses_server_repeating_assistant, to_response, assert_eq!, now, from_value, json!, create_dir_all, write (+1 more)).


##### `external_agent_config_import_returns_before_background_session_import_finishes`  (lines 878–1013)

```
async fn external_agent_config_import_returns_before_background_session_import_finishes() -> Result<()>
```

**Purpose**: Ensures the import RPC returns promptly even when background session import work is blocked, and that duplicate imports each later emit completion notifications once unblocked.

**Data flow**: On Unix, it writes provider config and a normal session file, detects migration items, then replaces the session file with a FIFO using `mkfifo` so background readers block. It sends an import request and asserts the initial response arrives within 5 seconds, extracts `import_id`, then confirms no completion notification arrives within 200 ms. It sends a duplicate import request, gets a second prompt response and `duplicate_import_id`, then twice writes the original session contents into the FIFO to unblock the background readers, collecting two completion notifications and sorting their IDs. Finally it asserts the completed IDs equal the two import IDs and that `thread/list` still reports only one thread.

**Call relations**: This concurrency-oriented test is entered by the harness and uses `assert_import_response` for both import responses. Its distinctive control flow is the deliberate blocking of background import work and later staged unblocking to observe notification behavior.

*Call graph*: calls 3 internal fn (new_with_env, assert_import_response, create_config_toml); 18 external calls (from_secs, new, new, Integer, create_mock_responses_server_repeating_assistant, to_response, assert!, assert_eq!, now, new (+8 more)).


##### `external_agent_config_import_compacts_huge_session_before_first_follow_up`  (lines 1016–1189)

```
async fn external_agent_config_import_compacts_huge_session_before_first_follow_up() -> Result<()>
```

**Purpose**: Checks that a very large imported session is auto-compacted into a summary before the first follow-up turn, and that the follow-up request uses the summary rather than replaying the full huge history.

**Data flow**: It starts a mock SSE server with two response sequences: one summary response returning `LOCAL_SUMMARY` and one normal follow-up answer. It writes config via `write_mock_responses_config_toml` with `auto_compact_limit` 200 and a custom summarization prompt, creates a Claude session file containing huge user and assistant messages, starts the server with `HOME` set, initializes, detects and imports the session, waits for completion, lists threads to get the imported thread, resumes it, starts a follow-up turn, and waits for response plus `turn/completed`. It then inspects the two captured provider requests: the first must contain the summarization prompt and not the follow-up text, while the second must contain both `follow up` and `LOCAL_SUMMARY`.

**Call relations**: This test is invoked by the harness and combines import, resume, and turn execution. It uses `assert_import_response` to track the import and then validates downstream compaction behavior by inspecting the mock provider request log.

*Call graph*: calls 4 internal fn (new_with_env, assert_import_response, mount_sse_sequence, start_mock_server); 15 external calls (default, default, new, Integer, to_response, write_mock_responses_config_toml, assert!, assert_eq!, now, from_value (+5 more)).


##### `create_config_toml`  (lines 1191–1211)

```
fn create_config_toml(codex_home: &std::path::Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes a minimal mock-provider configuration file for tests that need imported sessions to be resumable and able to run follow-up turns.

**Data flow**: It takes a Codex home path and server URI, formats a TOML string containing model, approval policy, sandbox mode, provider selection, and mock provider endpoint/retry settings, and writes it to `config.toml` under the given home directory. It returns the `std::io::Result<()>` from the write.

**Call relations**: The session-import tests that later resume threads or otherwise need a functioning model provider call this helper during setup.

*Call graph*: called by 5 (external_agent_config_import_accepts_detected_session_payload_after_restart, external_agent_config_import_creates_session_rollouts, external_agent_config_import_does_not_initialize_required_mcp, external_agent_config_import_returns_before_background_session_import_finishes, external_agent_config_import_skips_already_imported_session_versions); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/review.rs`

`test` · `request handling`

This test module focuses on review turns initiated through `ReviewStartParams`. The success-path tests verify that starting a review creates an in-progress turn whose initial item is a synthetic `ThreadItem::UserMessage` describing the review target, then emits review-mode markers on the main thread. For inline commit review, the mocked assistant repeatedly returns a JSON review payload; the test waits for `item/started` notifications until it sees `ThreadItem::EnteredReviewMode`, then for `item/completed` until it sees `ThreadItem::ExitedReviewMode`, and finally checks that the rendered review text contains both the finding title and the file/line span. A separate ignored test covers approval flow when review execution triggers a shell command: it asserts that the `CommandExecutionRequestApproval` request uses the same `item_id` as the eventual `ThreadItem::CommandExecution` notification.

The module also checks validation logic for empty base-branch names, commit SHAs, and custom instructions, expecting JSON-RPC invalid-request errors with code `-32600` and specific message fragments. The detached-delivery test is more subtle: after materializing the original thread rollout, it starts a detached review and asserts the returned `review_thread_id` differs from the source thread, then scans notifications to ensure the new thread is introduced by `thread/started` without a preceding `thread/status/changed` for that review thread. Helper functions centralize thread startup, rollout materialization via a real turn, and config generation with selectable approval policy and `shell_snapshot = false`.

#### Function details

##### `review_start_runs_review_turn_and_emits_code_review_item`  (lines 38–153)

```
async fn review_start_runs_review_turn_and_emits_code_review_item() -> Result<()>
```

**Purpose**: Tests the happy path for inline review start against a commit target and verifies that review-mode markers and rendered review content appear on the thread. It confirms both the immediate `ReviewStartResponse` shape and the later item notifications emitted during review execution.

**Data flow**: Builds a JSON review payload string with one finding and overall summary fields, serves it from a repeating mock assistant, writes config, initializes `TestAppServer`, and obtains a baseline thread id via `start_default_thread`. It sends `ReviewStartParams` targeting a commit with SHA/title, converts the response into `ReviewStartResponse`, and asserts the returned `review_thread_id`, turn status, items view, and initial `ThreadItem::UserMessage`. It then repeatedly reads `item/started` notifications until it finds `ThreadItem::EnteredReviewMode`, and `item/completed` notifications until it finds `ThreadItem::ExitedReviewMode`, extracting the rendered review body and asserting it contains the expected finding title and source location. It returns `Ok(())` on success.

**Call relations**: As a top-level test, it orchestrates the full review-start flow. It relies on `create_config_toml` for setup and `start_default_thread` to create the source thread before invoking the review-start request and consuming item notifications.

*Call graph*: calls 3 internal fn (new, create_config_toml, start_default_thread); 8 external calls (new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, json!, from_value, timeout).


##### `review_start_exec_approval_item_id_matches_command_execution_item`  (lines 157–251)

```
async fn review_start_exec_approval_item_id_matches_command_execution_item() -> Result<()>
```

**Purpose**: Checks that when a review turn requests command-execution approval, the approval request's `item_id` matches the eventual command-execution thread item id. This guards the linkage between approval UI state and the concrete execution item surfaced in the turn stream.

**Data flow**: Creates a two-step mock SSE sequence: a shell-command tool call with call id `review-call-1`, then a final assistant message. It writes config with approval policy `untrusted`, initializes the server, starts a default thread, sends a review-start request for a commit target, and asserts the returned turn's initial synthetic user message. It then reads a `ServerRequest::CommandExecutionRequestApproval`, checks `params.item_id == "review-call-1"` and `params.turn_id`, scans `item/started` notifications until it finds `ThreadItem::CommandExecution`, compares that item's id to the approval request id, sends an approval decision JSON payload, and waits for `turn/completed`.

**Call relations**: This ignored test is invoked directly by the test runner when enabled. It uses `create_config_toml_with_approval_policy` to force approval behavior and `start_default_thread` to prepare the thread before exercising the review-start path and subsequent approval/command-execution notifications.

*Call graph*: calls 3 internal fn (new, create_config_toml_with_approval_policy, start_default_thread); 9 external calls (new, Integer, create_mock_responses_server_sequence, assert_eq!, panic!, from_value, json!, timeout, vec!).


##### `review_start_rejects_empty_base_branch`  (lines 254–285)

```
async fn review_start_rejects_empty_base_branch() -> Result<()>
```

**Purpose**: Verifies that review start rejects a base-branch target whose branch name is only whitespace. It asserts the server returns a JSON-RPC invalid-request error with a branch-specific message.

**Data flow**: Starts a repeating mock assistant and test server, writes default config, initializes `TestAppServer`, creates a thread via `start_default_thread`, and sends `ReviewStartParams` with `ReviewTarget::BaseBranch { branch: "   " }`. It waits for an error response tied to the request id, deserializes it as `JSONRPCError`, and checks both the numeric error code and that the message contains `branch must not be empty`.

**Call relations**: This test covers input validation before any review execution begins. It depends on `create_config_toml` and `start_default_thread`, then stops at the error response rather than consuming turn/item notifications.

*Call graph*: calls 3 internal fn (new, create_config_toml, start_default_thread); 6 external calls (new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout).


##### `review_start_with_detached_delivery_returns_new_thread_id`  (lines 289–372)

```
async fn review_start_with_detached_delivery_returns_new_thread_id() -> Result<()>
```

**Purpose**: Tests detached review delivery, ensuring the review runs on a different thread and that the new thread is introduced cleanly via `thread/started`. It also verifies that no `thread/status/changed` notification for the detached review thread precedes that introduction.

**Data flow**: Creates a repeating mock assistant returning a minimal review payload, writes config, initializes the app server, starts a default thread, and calls `materialize_thread_rollout` so the source thread exists on disk. It sends `ReviewStartParams` with `ReviewDelivery::Detached` and custom instructions, converts the response into `ReviewStartResponse`, and asserts the returned turn is in progress with a single synthetic user-message item and a `review_thread_id` different from the original thread id. It then loops over subsequent notifications until it finds `thread/started`, explicitly failing if it first sees `thread/status/changed` for the detached review thread; once `thread/started` arrives, it deserializes `ThreadStartedNotification` and checks that both `id` and `session_id` equal the detached review thread id.

**Call relations**: This test uses both helpers: `start_default_thread` to create the source thread and `materialize_thread_rollout` to ensure rollout state exists before detached review creation. After the review-start request it acts as a notification-order validator for thread lifecycle events.

*Call graph*: calls 4 internal fn (new, create_config_toml, materialize_thread_rollout, start_default_thread); 10 external calls (new, bail!, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, assert_ne!, json!, from_value, now, timeout).


##### `review_start_rejects_empty_commit_sha`  (lines 375–407)

```
async fn review_start_rejects_empty_commit_sha() -> Result<()>
```

**Purpose**: Ensures commit-target review start rejects a SHA consisting only of whitespace. The test confirms the server reports this as an invalid request rather than attempting review execution.

**Data flow**: Sets up a repeating mock assistant, writes config, initializes the server, starts a default thread, and sends `ReviewStartParams` with `ReviewTarget::Commit { sha: "\t", title: None }`. It waits for the request's error response, deserializes `JSONRPCError`, and asserts code `-32600` plus a message containing `sha must not be empty`.

**Call relations**: Invoked directly as a validation test. It follows the same setup path as the other review validation tests, using `create_config_toml` and `start_default_thread`, but terminates once the invalid-request error is observed.

*Call graph*: calls 3 internal fn (new, create_config_toml, start_default_thread); 6 external calls (new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout).


##### `review_start_rejects_empty_custom_instructions`  (lines 410–444)

```
async fn review_start_rejects_empty_custom_instructions() -> Result<()>
```

**Purpose**: Checks that custom-instructions review targets cannot be blank or whitespace-only. It verifies the server emits a JSON-RPC invalid-request error with an instructions-specific message.

**Data flow**: Creates the mock assistant and config, initializes `TestAppServer`, starts a default thread, and sends `ReviewStartParams` with `ReviewTarget::Custom { instructions: "\n\n" }`. It reads the corresponding `JSONRPCError` and asserts the standard invalid-request code and a message containing `instructions must not be empty`.

**Call relations**: This is another direct validation test. It shares setup with the other review tests through `create_config_toml` and `start_default_thread`, then checks only the immediate error path.

*Call graph*: calls 3 internal fn (new, create_config_toml, start_default_thread); 6 external calls (new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout).


##### `start_default_thread`  (lines 446–465)

```
async fn start_default_thread(mcp: &mut TestAppServer) -> Result<String>
```

**Purpose**: Creates a standard non-ephemeral thread for review tests and waits until the server has both responded and emitted `thread/started`. It returns only the thread id, hiding the repeated startup boilerplate from the tests.

**Data flow**: Takes a mutable `TestAppServer`, sends `ThreadStartParams` with `model: Some("mock-model")` and other defaults, waits for the matching response message, converts it into `ThreadStartResponse`, then waits for a `thread/started` notification before returning `thread.id`.

**Call relations**: This helper is called by all review tests that need an existing thread. It sits early in the call flow, before review-start requests, and ensures callers do not race ahead of the thread-start notification stream.

*Call graph*: calls 3 internal fn (read_stream_until_notification_message, read_stream_until_response_message, send_thread_start_request); called by 6 (review_start_exec_approval_item_id_matches_command_execution_item, review_start_rejects_empty_base_branch, review_start_rejects_empty_commit_sha, review_start_rejects_empty_custom_instructions, review_start_runs_review_turn_and_emits_code_review_item, review_start_with_detached_delivery_returns_new_thread_id); 3 external calls (default, Integer, timeout).


##### `materialize_thread_rollout`  (lines 467–490)

```
async fn materialize_thread_rollout(mcp: &mut TestAppServer, thread_id: &str) -> Result<()>
```

**Purpose**: Forces a thread's rollout file/state to exist by running a real turn to completion. Detached-review tests use it to ensure later thread operations observe a materialized source thread.

**Data flow**: Accepts a mutable `TestAppServer` and a thread id string, sends a `TurnStartParams` containing one text input `materialize rollout`, waits for the turn-start response, then waits for `turn/completed`. It returns `Ok(())` once the turn has fully finished.

**Call relations**: Called only by `review_start_with_detached_delivery_returns_new_thread_id` after `start_default_thread`. It is a preparatory step that advances the thread from merely created to having persisted rollout activity.

*Call graph*: calls 3 internal fn (read_stream_until_notification_message, read_stream_until_response_message, send_turn_start_request); called by 1 (review_start_with_detached_delivery_returns_new_thread_id); 4 external calls (default, Integer, timeout, vec!).


##### `create_config_toml`  (lines 492–494)

```
fn create_config_toml(codex_home: &std::path::Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes the default review-test configuration using approval policy `never`. It is a thin wrapper around the more general approval-policy-aware config writer.

**Data flow**: Receives the Codex home path and server URI and forwards them, along with the literal approval policy `never`, to `create_config_toml_with_approval_policy`. It returns that helper's `std::io::Result<()>`.

**Call relations**: Used by the review tests that do not need approval prompts. It delegates all actual file generation to `create_config_toml_with_approval_policy`.

*Call graph*: calls 1 internal fn (create_config_toml_with_approval_policy); called by 5 (review_start_rejects_empty_base_branch, review_start_rejects_empty_commit_sha, review_start_rejects_empty_custom_instructions, review_start_runs_review_turn_and_emits_code_review_item, review_start_with_detached_delivery_returns_new_thread_id).


##### `create_config_toml_with_approval_policy`  (lines 496–524)

```
fn create_config_toml_with_approval_policy(
    codex_home: &std::path::Path,
    server_uri: &str,
    approval_policy: &str,
) -> std::io::Result<()>
```

**Purpose**: Generates the TOML configuration for review tests, parameterized by approval policy. The file points at the mock responses provider and disables shell snapshots.

**Data flow**: Takes the Codex home path, mock server URI, and an `approval_policy` string, computes `config.toml`, formats a TOML document embedding both the policy and provider base URL, and writes it to disk. It returns the `std::io::Result<()>` from `std::fs::write`.

**Call relations**: Called indirectly by most tests through `create_config_toml`, and directly by `review_start_exec_approval_item_id_matches_command_execution_item` to force `untrusted` approval behavior.

*Call graph*: called by 2 (create_config_toml, review_start_exec_approval_item_id_matches_command_execution_item); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/safety_check_downgrade.rs`

`test` · `request handling`

These tests exercise how the app server translates provider-level safety signals into typed JSON-RPC notifications. The constants define a requested model (`gpt-5.4`), a server-returned model (`gpt-5.3-codex`), a verification tag (`trusted_access_for_cyber`), and the expected cyber-policy error message. Several tests are network-gated with `skip_if_no_network!` because they use the shared mock HTTP server utilities. The reroute tests simulate two mismatch sources: an `OpenAI-Model` HTTP header that differs from the requested model, and a `response.created` event whose embedded headers disagree even when the outer HTTP header matches the request. In both cases the test starts a thread and turn, then drains notifications until `turn/completed`, requiring a `ModelReroutedNotification` with reason `HighRiskCyberActivity` and asserting that no warning user-message items were emitted.

The cyber-policy test instead mounts a 400 JSON error body with code `cyber_policy` and expects an `ErrorNotification` whose nested `TurnError` carries `CodexErrorInfo::CyberPolicy`, while explicitly rejecting any `model/rerouted` notification. Another test verifies `response.metadata` carrying `trusted_access_for_cyber` becomes a `ModelVerificationNotification` and still does not produce warning items or reroute notifications. The moderation-metadata test checks that `response.metadata` with `openai_chatgpt_moderation_metadata` is surfaced as `turn/moderationMetadata` with the raw metadata JSON preserved. Helper functions centralize notification collection and inspect `ThreadItem::UserMessage` content for any text beginning with `Warning: `, which these newer typed-notification paths must avoid.

#### Function details

##### `openai_model_header_mismatch_emits_model_rerouted_notification_v2`  (lines 37–99)

```
async fn openai_model_header_mismatch_emits_model_rerouted_notification_v2() -> Result<()>
```

**Purpose**: Verifies that when the provider's HTTP `OpenAI-Model` header differs from the requested model, the app server emits a typed `model/rerouted` notification. It also checks that this reroute path does not synthesize warning user-message items.

**Data flow**: Starts a mock HTTP server, mounts a one-shot SSE response whose HTTP headers include `OpenAI-Model: gpt-5.3-codex`, writes config, initializes `TestAppServer`, starts a thread requesting `gpt-5.4`, and starts a turn with one text input. After converting the thread and turn responses, it calls `collect_turn_notifications_and_validate_no_warning_item`, which drains notifications until `turn/completed` and returns the captured `ModelReroutedNotification`. The test compares that payload against the expected thread id, turn id, from/to model names, and `ModelRerouteReason::HighRiskCyberActivity`.

**Call relations**: This top-level test delegates post-turn notification validation to `collect_turn_notifications_and_validate_no_warning_item`. It uses `create_config_toml` during setup and otherwise drives the standard thread-start/turn-start flow.

*Call graph*: calls 7 internal fn (new, collect_turn_notifications_and_validate_no_warning_item, create_config_toml, mount_response_once, sse, sse_response, start_mock_server); 8 external calls (default, new, Integer, to_response, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `cyber_policy_response_emits_typed_error_notification_v2`  (lines 102–169)

```
async fn cyber_policy_response_emits_typed_error_notification_v2() -> Result<()>
```

**Purpose**: Checks that a provider 400 response with error code `cyber_policy` becomes a typed `error` notification carrying `CodexErrorInfo::CyberPolicy`. It ensures this path reports an error rather than a reroute.

**Data flow**: Starts a mock server, mounts a one-shot HTTP 400 JSON body containing the cyber-policy message and code, writes config, initializes the app server, starts a thread requesting the configured model, and starts a turn. After parsing the thread and turn responses, it invokes `collect_cyber_policy_error_and_validate_no_reroute`, which drains notifications until `turn/completed`, captures the matching `ErrorNotification`, and fails if any `model/rerouted` notification appears. The test then asserts the full expected `ErrorNotification` structure, including `will_retry: false` and the thread/turn ids.

**Call relations**: This test uses `create_config_toml` for setup and hands notification-stream validation to `collect_cyber_policy_error_and_validate_no_reroute` once the turn has started.

*Call graph*: calls 5 internal fn (new, collect_cyber_policy_error_and_validate_no_reroute, create_config_toml, mount_response_once, start_mock_server); 10 external calls (default, new, new, Integer, to_response, assert_eq!, json!, skip_if_no_network!, timeout, vec!).


##### `response_model_field_mismatch_emits_model_rerouted_notification_v2_when_header_matches_requested`  (lines 172–243)

```
async fn response_model_field_mismatch_emits_model_rerouted_notification_v2_when_header_matches_requested() -> Result<()>
```

**Purpose**: Tests the alternate reroute signal where the outer HTTP header matches the requested model but the `response.created` event embeds a different model header. The server should still emit `model/rerouted` with the same high-risk-cyber reason.

**Data flow**: Mounts an SSE response whose first event is a custom `response.created` JSON object containing `headers.OpenAI-Model = gpt-5.3-codex`, while the HTTP response header itself is `OpenAI-Model: gpt-5.4`. It writes config, initializes `TestAppServer`, starts a thread and turn, converts the typed responses, then calls `collect_turn_notifications_and_validate_no_warning_item` to obtain the reroute notification before turn completion. The returned payload is asserted against the expected thread id, turn id, requested model, server model, and reroute reason.

**Call relations**: Like the first reroute test, this one delegates stream inspection to `collect_turn_notifications_and_validate_no_warning_item`; the difference is entirely in how the mock SSE payload is constructed.

*Call graph*: calls 7 internal fn (new, collect_turn_notifications_and_validate_no_warning_item, create_config_toml, mount_response_once, sse, sse_response, start_mock_server); 8 external calls (default, new, Integer, to_response, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `model_verification_emits_typed_notification_and_warning_v2`  (lines 246–311)

```
async fn model_verification_emits_typed_notification_and_warning_v2() -> Result<()>
```

**Purpose**: Validates that model-verification metadata is surfaced as a typed `model/verification` notification and does not trigger either reroute notifications or warning items. The test specifically maps the trusted-access verification tag into the typed enum variant.

**Data flow**: Starts a mock server, mounts an SSE stream containing `response.created`, `ev_model_verification_metadata` with `trusted_access_for_cyber`, an assistant message, and completion, then writes config and initializes the app server. It starts a thread and turn, parses the typed responses, and calls `collect_model_verification_notifications_and_validate_no_warning_item`, which drains notifications until `turn/completed`, captures the `ModelVerificationNotification`, and fails on any `warning` or `model/rerouted` notification or warning-style thread item. The test asserts the returned payload contains the current thread/turn ids and `verifications: vec![ModelVerification::TrustedAccessForCyber]`.

**Call relations**: This test depends on `create_config_toml` for setup and on `collect_model_verification_notifications_and_validate_no_warning_item` for the detailed notification-stream assertions.

*Call graph*: calls 7 internal fn (new, collect_model_verification_notifications_and_validate_no_warning_item, create_config_toml, mount_response_once, sse, sse_response, start_mock_server); 8 external calls (default, new, Integer, to_response, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `turn_moderation_metadata_emits_typed_notification_v2`  (lines 314–392)

```
async fn turn_moderation_metadata_emits_typed_notification_v2() -> Result<()>
```

**Purpose**: Ensures moderation metadata embedded in a provider `response.metadata` event is forwarded as a typed `turn/moderationMetadata` notification. It checks that the raw metadata JSON is preserved exactly.

**Data flow**: Mounts an SSE stream containing `response.created`, a custom `response.metadata` event with `openai_chatgpt_moderation_metadata.presentation = "inline"`, an assistant message, and completion. It writes config, initializes `TestAppServer`, starts a thread and turn, then waits specifically for a `turn/moderationMetadata` notification. The notification params are required to be present, deserialized into `TurnModerationMetadataNotification`, and compared against the expected thread id, turn id, and metadata JSON object `{ "presentation": "inline" }`.

**Call relations**: This is a direct test without a custom collector helper. After standard setup via `create_config_toml`, it waits for the single moderation-metadata notification and validates its typed payload.

*Call graph*: calls 6 internal fn (new, create_config_toml, mount_response_once, sse, sse_response, start_mock_server); 9 external calls (default, new, Integer, to_response, assert_eq!, from_value, skip_if_no_network!, timeout, vec!).


##### `collect_turn_notifications_and_validate_no_warning_item`  (lines 394–434)

```
async fn collect_turn_notifications_and_validate_no_warning_item(
    mcp: &mut TestAppServer,
) -> Result<ModelReroutedNotification>
```

**Purpose**: Consumes a turn's notification stream until completion, returning the `ModelReroutedNotification` if one appears and asserting that no warning user-message items are emitted. It is tailored to reroute scenarios where warning items should be absent.

**Data flow**: Takes a mutable `TestAppServer`, repeatedly reads the next message under `DEFAULT_READ_TIMEOUT`, ignores non-notifications, and matches notification methods. For `model/rerouted`, it requires params and deserializes `ModelReroutedNotification` into a local slot; for `item/started` and `item/completed`, it deserializes the corresponding payloads and asserts `is_warning_user_message_item(&payload.item)` is false; on `turn/completed`, it returns the captured reroute notification or errors if none was seen first.

**Call relations**: Called by both reroute tests after the turn-start response has been received. It delegates warning-item detection to `is_warning_user_message_item` while acting as the terminal notification-draining loop for those tests.

*Call graph*: calls 1 internal fn (read_next_message); called by 2 (openai_model_header_mismatch_emits_model_rerouted_notification_v2, response_model_field_mismatch_emits_model_rerouted_notification_v2_when_header_matches_requested); 3 external calls (assert!, from_value, timeout).


##### `collect_model_verification_notifications_and_validate_no_warning_item`  (lines 436–485)

```
async fn collect_model_verification_notifications_and_validate_no_warning_item(
    mcp: &mut TestAppServer,
) -> Result<ModelVerificationNotification>
```

**Purpose**: Drains notifications for a verification-only turn, returning the typed verification payload while rejecting reroute and warning paths. It also asserts that no warning-style thread items are emitted during the turn.

**Data flow**: Reads messages from `TestAppServer` until `turn/completed`, ignoring non-notifications. It captures `model/verification` params as `ModelVerificationNotification`, immediately fails on `warning` or `model/rerouted`, and for `item/started`/`item/completed` deserializes the payloads and asserts their items are not warning user messages. When `turn/completed` arrives, it returns the captured verification payload or errors if none was observed.

**Call relations**: Used only by `model_verification_emits_typed_notification_and_warning_v2` after the turn has started. It relies on `is_warning_user_message_item` to enforce the no-warning-item invariant.

*Call graph*: calls 1 internal fn (read_next_message); called by 1 (model_verification_emits_typed_notification_and_warning_v2); 4 external calls (bail!, assert!, from_value, timeout).


##### `collect_cyber_policy_error_and_validate_no_reroute`  (lines 487–518)

```
async fn collect_cyber_policy_error_and_validate_no_reroute(
    mcp: &mut TestAppServer,
) -> Result<ErrorNotification>
```

**Purpose**: Consumes notifications until turn completion, extracting the cyber-policy `ErrorNotification` and ensuring no reroute notification is emitted. It filters error notifications by typed `CodexErrorInfo` rather than by message text alone.

**Data flow**: Loops over `read_next_message` results under timeout, ignores non-notifications, and matches methods. For `error`, it requires params, deserializes `ErrorNotification`, and stores it only if `payload.error.codex_error_info == Some(CodexErrorInfo::CyberPolicy)`; for `model/rerouted`, it immediately fails; on `turn/completed`, it returns the stored error or errors if none was seen.

**Call relations**: Called only by `cyber_policy_response_emits_typed_error_notification_v2` to centralize the stream-draining and no-reroute assertions for that scenario.

*Call graph*: calls 1 internal fn (read_next_message); called by 1 (cyber_policy_response_emits_typed_error_notification_v2); 3 external calls (bail!, from_value, timeout).


##### `warning_text_from_item`  (lines 520–529)

```
fn warning_text_from_item(item: &ThreadItem) -> Option<&str>
```

**Purpose**: Extracts the warning text from a thread item if the item is a user message containing a text input that starts with `Warning: `. It is a narrow predicate helper for detecting legacy warning items in notification streams.

**Data flow**: Accepts a `&ThreadItem`, returns early with `None` unless the item is `ThreadItem::UserMessage`, then iterates over its `content` inputs and returns the first text string whose prefix is `Warning: `. The output is `Option<&str>` borrowed from the original item.

**Call relations**: This helper is not called directly by tests; `is_warning_user_message_item` wraps it to provide a boolean check used by the collector loops.

*Call graph*: called by 1 (is_warning_user_message_item).


##### `is_warning_user_message_item`  (lines 531–533)

```
fn is_warning_user_message_item(item: &ThreadItem) -> bool
```

**Purpose**: Reports whether a thread item is a warning-style user message. It converts the optional extracted warning text into a simple boolean for assertions.

**Data flow**: Takes a `&ThreadItem`, calls `warning_text_from_item`, and returns `true` if that helper found warning text and `false` otherwise.

**Call relations**: Used by `collect_turn_notifications_and_validate_no_warning_item` and `collect_model_verification_notifications_and_validate_no_warning_item` when validating `item/started` and `item/completed` notifications.

*Call graph*: calls 1 internal fn (warning_text_from_item).


##### `create_config_toml`  (lines 535–560)

```
fn create_config_toml(codex_home: &std::path::Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes the safety-check test configuration, fixing the requested model and disabling remote-model behavior while leaving personality enabled. The generated config points the mock provider at the supplied server URI.

**Data flow**: Receives the Codex home path and server URI, computes `config.toml`, formats a TOML string embedding the `REQUESTED_MODEL` constant and `server_uri`, and writes it to disk. It returns the `std::io::Result<()>` from the file write.

**Call relations**: Called by every top-level test in this file during setup so the app server starts with the intended model and feature flags before initialization.

*Call graph*: called by 5 (cyber_policy_response_emits_typed_error_notification_v2, model_verification_emits_typed_notification_and_warning_v2, openai_model_header_mismatch_emits_model_rerouted_notification_v2, response_model_field_mismatch_emits_model_rerouted_notification_v2_when_header_matches_requested, turn_moderation_metadata_emits_typed_notification_v2); 3 external calls (join, format!, write).
