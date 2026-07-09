# App-server integration suites — thread, turn, review, and session-state lifecycle  `stage-23.1.4.4`

This stage is the app server’s “conversation lifecycle” test area. It checks the main work loop that clients use every day: create a thread, run assistant turns, pause or interrupt them, save history, reopen it later, and eventually archive or delete it. The thread tests act like a filing system inspection: start, list, read, resume, fork, rename, roll back, archive, unarchive, delete, and summarize conversations, whether they live on disk, in memory, or in a remote store. Other tests check per-thread details such as settings, memory mode, Git metadata, loaded-thread lists, subscriptions, and live status messages.

The turn tests check the moving parts during an active assistant response: starting a turn, steering it with a new user message, asking for permissions or user input, using dynamic tools, enforcing output schemas, injecting saved items, and interrupting safely. Review and compaction tests cover special workflows: code review and shrinking long chats into summaries. Finally, client metadata, safety notifications, memory reset, and external-agent import tests make sure surrounding state and policy messages stay accurate for connected clients.

## Files in this stage

### Thread discovery and startup
These tests establish how threads are created, summarized, listed, read, and resumed across rollout-backed, in-memory, and remote-store persistence modes.

### `app-server/tests/suite/conversation_summary.rs`

`test` · `test execution`

A conversation summary is the small card-like information the app can show for an old chat: its id, where it is stored, a preview line, timestamps, model provider, working directory, and source. This test file makes sure the app server can find and report that information in a few important situations.

The tests build tiny fake worlds instead of using a real user setup. They create a temporary Codex home directory, write fake conversation data there, start a test app server, ask it for a summary using the same request shape a client would use, and compare the answer with the expected summary. One test asks by conversation id. Another asks by a relative rollout path and verifies the server treats that path as relative to the Codex home directory. A third test covers a special case: a thread that exists in an in-memory store and has no file path. That matters because not every thread necessarily comes from a saved rollout file.

The helper functions keep the comparisons fair. File paths can look different before and after the operating system resolves them, so the tests normalize paths before comparing. The small `InMemoryThreadStoreId` guard is like a temporary reservation ticket: when the test ends, it automatically removes the named in-memory store so it cannot leak into another test.

#### Function details

##### `expected_summary`  (lines 48–61)

```
fn expected_summary(conversation_id: ThreadId, path: PathBuf) -> ConversationSummary
```

**Purpose**: Builds the exact conversation summary that the rollout-file tests expect the server to return. This keeps repeated expected values in one place so the tests are easier to read.

**Data flow**: It receives a conversation id and a file path. It combines those with fixed test constants such as the preview text, timestamps, model provider, current directory, CLI version, and source. It returns a `ConversationSummary` value ready to compare against the server response.

**Call relations**: The rollout-based tests call this after creating a fake rollout file. They use its result as the trusted answer, then compare it with the summary returned by the app server.

*Call graph*: called by 2 (get_conversation_summary_by_relative_rollout_path_resolves_from_codex_home, get_conversation_summary_by_thread_id_reads_rollout); 1 external calls (from).


##### `normalized_canonical_path`  (lines 63–65)

```
fn normalized_canonical_path(path: impl AsRef<Path>) -> Result<PathBuf>
```

**Purpose**: Turns a path into a fully resolved absolute path in the form the project expects. This avoids false test failures caused by different but equivalent path spellings.

**Data flow**: It receives any path-like value. It asks the operating system to canonicalize it, meaning resolve it to the real absolute path, then wraps it as an `AbsolutePathBuf` to confirm it is truly absolute. It returns the normalized `PathBuf` or an error if the path cannot be resolved.

**Call relations**: The tests call this before building their expected summaries, and `normalized_summary_path` calls it for summaries received from the server. It acts as the path cleanup step before comparisons.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 3 (get_conversation_summary_by_relative_rollout_path_resolves_from_codex_home, get_conversation_summary_by_thread_id_reads_rollout, normalized_summary_path); 1 external calls (as_ref).


##### `normalized_summary_path`  (lines 67–72)

```
fn normalized_summary_path(mut summary: ConversationSummary) -> Result<ConversationSummary>
```

**Purpose**: Normalizes just the path inside a conversation summary before comparing it in a test. It leaves pathless summaries alone.

**Data flow**: It receives a `ConversationSummary`. If the summary has a non-empty path, it replaces that path with its canonical absolute form. It returns the updated summary, or an error if the path cannot be normalized.

**Call relations**: The rollout-file tests use this on the server response before comparing it to the expected value. It delegates the actual path resolving work to `normalized_canonical_path`.

*Call graph*: calls 1 internal fn (normalized_canonical_path).


##### `get_conversation_summary_by_thread_id_reads_rollout`  (lines 75–112)

```
async fn get_conversation_summary_by_thread_id_reads_rollout() -> Result<()>
```

**Purpose**: Checks that the app server can find a saved conversation rollout file when the client asks by thread id. This proves the normal lookup path for saved conversations works.

**Data flow**: The test creates a temporary Codex home, writes a fake rollout file with known metadata, turns the fake conversation id into a `ThreadId`, and builds the expected summary. It starts a test app server, initializes it, sends a `getConversationSummary` request using the thread id, waits for the matching JSON-RPC response, converts that response into a typed result, and compares the received summary to the expected one after normalizing paths.

**Call relations**: This is a top-level asynchronous test run by the Rust test framework. It uses helpers from test support to create the fake rollout and communicate with the server, and it uses `expected_summary`, `normalized_canonical_path`, and `normalized_summary_path` to prepare a reliable comparison.

*Call graph*: calls 4 internal fn (new, expected_summary, normalized_canonical_path, from_string); 7 external calls (new, Integer, create_fake_rollout, rollout_path, to_response, assert_eq!, timeout).


##### `get_conversation_summary_by_thread_id_reads_pathless_store_thread`  (lines 115–196)

```
async fn get_conversation_summary_by_thread_id_reads_pathless_store_thread() -> Result<()>
```

**Purpose**: Checks that the app server can summarize a thread that lives in an in-memory thread store and has no rollout file path. This protects the case where conversation data exists but is not backed by a normal file on disk.

**Data flow**: The test creates a temporary Codex home and writes a test config that points at a named in-memory thread store. It creates a thread in that store with known metadata, then builds and starts an in-process app server using test configuration. It sends a summary request by thread id, decodes the JSON result, and checks key fields: the conversation id matches, the path and working directory are empty, and the provider field has the expected test value. Finally it shuts the client down.

**Call relations**: This is another top-level asynchronous test. It calls `create_config_toml_with_in_memory_thread_store` to make the server use the same in-memory store that the test populates. The `InMemoryThreadStoreId` guard cleans up the named store when the test scope ends.

*Call graph*: calls 9 internal fn (start, create_config_toml_with_in_memory_thread_store, default, without_managed_config_for_tests, default_for_tests, new, default, from_string, for_id); 10 external calls (new, default, new, new_v4, new, Integer, default, assert_eq!, default, from_value).


##### `get_conversation_summary_by_relative_rollout_path_resolves_from_codex_home`  (lines 199–232)

```
async fn get_conversation_summary_by_relative_rollout_path_resolves_from_codex_home() -> Result<()>
```

**Purpose**: Checks that a relative rollout path is interpreted relative to the Codex home directory. Without this, clients could fail when they send compact paths instead of full absolute paths.

**Data flow**: The test creates a fake rollout in a temporary Codex home, then strips the Codex home prefix to make a relative path. It starts the test server, initializes it, sends a summary request using that relative rollout path, waits for the response, converts it to a typed summary response, normalizes the returned path, and compares it with the expected full-path summary.

**Call relations**: This top-level asynchronous test follows the same server request-and-response pattern as the thread-id rollout test. It relies on `expected_summary` and `normalized_canonical_path` to prepare the expected answer and on `normalized_summary_path` to make the server answer comparable.

*Call graph*: calls 4 internal fn (new, expected_summary, normalized_canonical_path, from_string); 7 external calls (new, Integer, create_fake_rollout, rollout_path, to_response, assert_eq!, timeout).


##### `InMemoryThreadStoreId::drop`  (lines 239–241)

```
fn drop(&mut self)
```

**Purpose**: Automatically removes the named in-memory thread store when its guard object goes away. This keeps one test's temporary store from affecting later tests.

**Data flow**: It reads the stored `store_id` from the guard object being dropped. It passes that id to `InMemoryThreadStore::remove_id`, which removes the shared in-memory store registered under that name. It does not return a value.

**Call relations**: The pathless-store test creates an `InMemoryThreadStoreId` value after choosing a store id. Rust calls this `drop` method automatically when the value leaves scope, so cleanup happens even though the test body does not call it directly.

*Call graph*: calls 1 internal fn (remove_id).


##### `create_config_toml_with_in_memory_thread_store`  (lines 244–268)

```
fn create_config_toml_with_in_memory_thread_store(
    codex_home: &Path,
    store_id: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes a small `config.toml` file that tells the app server to use a specific in-memory thread store for the test. This lets the server and the test talk about the same temporary store.

**Data flow**: It receives the Codex home directory and the in-memory store id. It formats a TOML configuration string containing basic model settings, a disabled approval policy, read-only sandboxing, the named in-memory thread store, and a mock provider. It writes that text to `config.toml` inside the temporary Codex home and returns the file-write result.

**Call relations**: The pathless-store test calls this before starting the in-process app server. The server later reads this config during startup, which connects it to the in-memory thread created by the test.

*Call graph*: called by 1 (get_conversation_summary_by_thread_id_reads_pathless_store_thread); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/remote_thread_store.rs`

`test` · `test execution`

This is a regression test file. A “thread store” is the place where conversation threads are saved. In normal use it might be local disk storage, but this file checks the path where configuration says to use a different store. The tests use a test-only in-memory store, which behaves like an external store without needing a real service.

The main idea is simple: create a temporary Codex home folder, configure the app server to use the in-memory thread store, then start the app server in-process, meaning inside the same test process rather than as a separate program. The test starts a thread, sends a user message, waits until the assistant turn finishes, lists the thread, deletes threads, and then inspects both the in-memory store and the temporary folder.

What would break without this file is subtle but important. The app could appear to work while still creating local rollout session files or a local SQLite database behind the scenes. That would violate the configured storage choice and could leak data into the wrong place. These tests act like tripwires: if local persistence creates visible files, the test fails. There is also a resume test that checks a cold restart still asks the non-local store for thread history instead of falling back to local history lookup.

#### Function details

##### `thread_delete_with_non_local_thread_store_does_not_create_local_persistence`  (lines 64–191)

```
async fn thread_delete_with_non_local_thread_store_does_not_create_local_persistence() -> Result<()>
```

**Purpose**: This test proves that starting, using, listing, and deleting threads through a configured in-memory thread store does not create local persistence files. It is meant to catch accidental writes to local session folders or SQLite databases when a non-local store is configured.

**Data flow**: It starts with a mock model server, a fresh temporary Codex home folder, and a unique in-memory store id. It writes a config file pointing the app server at that store, starts an in-process app server, creates a thread, sends a message, waits for the turn to complete, lists the thread, and deletes both a loaded and an unloaded thread. At the end it reads the in-memory store’s recorded call counts and inspects the temporary Codex home folder; the expected result is that all thread operations went through the injected store and no local persistence artifacts appeared.

**Call relations**: This is the main end-to-end regression scenario in the file. It uses create_config_toml_with_thread_store to prepare the configuration, start_in_process_server to boot the app server, delete_thread to exercise deletion through the protocol, and assert_no_local_persistence_artifacts to verify the filesystem stayed clean.

*Call graph*: calls 7 internal fn (assert_no_local_persistence_artifacts, create_config_toml_with_thread_store, delete_thread, start_in_process_server, default, from_string, for_id); 13 external calls (default, new, new_v4, new, bail!, Integer, default, create_mock_responses_server_repeating_assistant, assert!, assert_eq! (+3 more)).


##### `cold_thread_resume_reuses_non_local_history_probe`  (lines 194–275)

```
async fn cold_thread_resume_reuses_non_local_history_probe() -> Result<()>
```

**Purpose**: This test checks the restart-and-resume path. After a thread is created and materialized, the server is shut down and started again, then asked to resume the thread; the important assertion is that the non-local store is asked for history.

**Data flow**: It creates a mock model server, temporary Codex home, configuration, and in-memory thread store. It starts a client, creates a thread, sends a message so there is history to save, waits for completion, then shuts the client down. It starts a new client with the same configuration, records how many times the store has been asked to read thread history, attempts a resume, and checks that the history-read count increased by exactly one.

**Call relations**: This test focuses on the cold-start resume path rather than deletion. It uses create_config_toml_with_thread_store to select the non-local store and calls start_in_process_client directly so it can reuse the same built configuration across the first server run and the restarted server run.

*Call graph*: calls 4 internal fn (create_config_toml_with_thread_store, start_in_process_client, without_managed_config_for_tests, for_id); 13 external calls (new, default, new, new_v4, bail!, Integer, default, create_mock_responses_server_repeating_assistant, assert_eq!, default (+3 more)).


##### `start_in_process_server`  (lines 277–289)

```
async fn start_in_process_server(codex_home: &Path) -> Result<InProcessClientHandle>
```

**Purpose**: This helper builds a basic test configuration for a given Codex home folder and starts an in-process app server client. It saves the tests from repeating the same setup code.

**Data flow**: It receives the path to a temporary Codex home folder. It creates loader overrides suitable for tests, builds a Config that uses that folder both as Codex home and fallback working directory, then passes the finished Config into start_in_process_client. The output is a client handle that the test can use to send app-server protocol requests.

**Call relations**: The main persistence-regression test calls this helper when it only needs the standard setup. This helper then hands off to start_in_process_client, which does the lower-level work of actually starting the in-process server.

*Call graph*: calls 2 internal fn (start_in_process_client, without_managed_config_for_tests); called by 1 (thread_delete_with_non_local_thread_store_does_not_create_local_persistence); 3 external calls (new, to_path_buf, default).


##### `start_in_process_client`  (lines 291–321)

```
async fn start_in_process_client(
    config: Arc<Config>,
    loader_overrides: LoaderOverrides,
) -> std::io::Result<InProcessClientHandle>
```

**Purpose**: This helper starts the app server inside the test process and returns a client handle for talking to it. It supplies the many pieces of startup context the server expects, using test-safe defaults where possible.

**Data flow**: It takes a shared Config and loader overrides. It packages them with default command dispatch paths, no command-line overrides, a no-op thread config loader, fresh feedback support, no log or state database, a test environment manager, client identity information, and channel capacity. It then calls the in-process server starter and returns the resulting client handle or startup error.

**Call relations**: Both tests rely on this as the doorway into the app server. start_in_process_server calls it after building a simple Config, while the resume test calls it directly so the same Config can be reused before and after shutdown.

*Call graph*: calls 4 internal fn (start, default, default_for_tests, new); called by 2 (cold_thread_resume_reuses_non_local_history_probe, start_in_process_server); 3 external calls (new, new, default).


##### `delete_thread`  (lines 323–337)

```
async fn delete_thread(
    client: &InProcessClientHandle,
    request_id: i64,
    thread_id: String,
) -> Result<()>
```

**Purpose**: This helper sends a thread/delete request to the app server and verifies that the response has the expected shape. It turns protocol-level errors into ordinary test failures with a clear message.

**Data flow**: It receives an in-process client, a numeric request id, and the thread id to delete. It sends a ClientRequest::ThreadDelete request, checks whether the server returned an error, and parses the successful JSON response as a ThreadDeleteResponse. It returns success only if the request completed and the response was valid.

**Call relations**: The main persistence test uses this helper twice: once for the currently loaded thread and once for a thread that exists only in the store. That lets the test check that deletion routes through the non-local store in both situations.

*Call graph*: calls 1 internal fn (request); called by 1 (thread_delete_with_non_local_thread_store_does_not_create_local_persistence); 2 external calls (Integer, from_value).


##### `assert_no_local_persistence_artifacts`  (lines 339–391)

```
fn assert_no_local_persistence_artifacts(codex_home: &Path) -> Result<()>
```

**Purpose**: This helper checks that the temporary Codex home folder does not contain files or directories that would prove local thread persistence was used. It is the filesystem tripwire for the main regression test.

**Data flow**: It receives the Codex home path. It checks that known local persistence locations, such as session folders, archived session folders, the local state database, and SQLite sidecar files, do not exist. It then gathers the remaining top-level entries, ignores shell snapshot storage because that is unrelated to thread persistence, and compares the result with the small set of expected non-thread files.

**Call relations**: The main persistence test calls this after shutting down the client and after confirming store calls. This helper uses codex_home_entries to read the folder contents before deciding whether unexpected local artifacts were created.

*Call graph*: calls 1 internal fn (codex_home_entries); called by 1 (thread_delete_with_non_local_thread_store_does_not_create_local_persistence); 3 external calls (assert!, assert_eq!, read_dir).


##### `codex_home_entries`  (lines 393–400)

```
fn codex_home_entries(codex_home: &Path) -> Result<BTreeSet<String>>
```

**Purpose**: This helper returns the names of the top-level files and folders inside a Codex home directory. It gives the artifact check a simple set of names to compare against.

**Data flow**: It receives a directory path, reads that directory from disk, converts each entry’s file name into a string, and collects the names into a sorted set. The output is that set, or an error if the directory cannot be read.

**Call relations**: assert_no_local_persistence_artifacts calls this near the end of its checks. The sorted set makes it easy to compare the actual folder contents with the exact allowed contents.

*Call graph*: called by 1 (assert_no_local_persistence_artifacts); 1 external calls (read_dir).


##### `InMemoryThreadStoreId::drop`  (lines 407–409)

```
fn drop(&mut self)
```

**Purpose**: This cleanup hook unregisters the test in-memory thread store id when the guard value goes out of scope. It prevents one test’s named in-memory store from lingering and affecting another test.

**Data flow**: It reads the stored id from the InMemoryThreadStoreId value being dropped. It passes that id to the in-memory thread store registry removal function. There is no returned value; the side effect is cleanup of the shared test registry.

**Call relations**: The tests create an InMemoryThreadStoreId guard after registering or looking up an in-memory store by id. Rust calls this drop method automatically when the guard leaves scope, so the cleanup happens even though the tests do not call it directly.

*Call graph*: calls 1 internal fn (remove_id).


##### `create_config_toml_with_thread_store`  (lines 412–440)

```
fn create_config_toml_with_thread_store(
    codex_home: &Path,
    server_uri: &str,
    store_id: &str,
) -> std::io::Result<()>
```

**Purpose**: This helper writes a test config file that tells the app server to use the in-memory thread store and the mock model provider. It creates the configuration needed to exercise the non-local thread-store path.

**Data flow**: It receives the Codex home path, the mock server URI, and the in-memory store id. It formats a config.toml file containing model settings, read-only sandbox settings, the experimental thread store selection, mock provider connection details, and disabled plugins. It writes that file into the Codex home directory and returns whether the write succeeded.

**Call relations**: Both tests call this before starting the app server. The app server then reads this config during startup, which is what makes later thread operations go through the in-memory store instead of the local persistence path.

*Call graph*: called by 2 (cold_thread_resume_reuses_non_local_history_probe, thread_delete_with_non_local_thread_store_does_not_create_local_persistence); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/thread_start.rs`

`test` · `test run`

A “thread” here is a new conversation session between a client and the app server. This test file acts like a careful customer at a service desk: it sends many kinds of `thread/start` requests and checks that the server gives the right receipt, starts the right background work, and refuses bad input clearly. Without these tests, changes to thread creation could silently break important promises made to clients, such as where paths appear in JSON, when project instructions are loaded, or how trust is saved for a workspace.

Most tests build a temporary Codex home folder, write a small `config.toml`, start a `TestAppServer`, initialize it, send a `thread/start` request, and then read either a JSON-RPC response or an error. JSON-RPC is a simple request-response protocol using JSON messages. Several tests also listen for server notifications, which are messages the server sends without being directly asked.

The file covers normal thread creation, ephemeral threads that should not have disk paths, workspace root handling, instruction source discovery from `AGENTS.md` files, analytics events, cloud configuration failures, and MCP servers. MCP, or Model Context Protocol, is a way to attach external tools or services to a session. Helper functions at the bottom write different test configurations, including deliberately broken MCP servers, so each test can focus on one behavior.

#### Function details

##### `thread_start_creates_thread_and_emits_started`  (lines 58–200)

```
async fn thread_start_creates_thread_and_emits_started() -> Result<()>
```

**Purpose**: Checks the basic promise of `thread/start`: a new persistent thread is created, returned to the caller, and announced with a `thread/started` notification. It also verifies the exact JSON shape clients depend on, such as `sessionId`, `name: null`, and `ephemeral: false`.

**Data flow**: The test creates a mock model server and a temporary config, starts the app server, and sends a thread start request with a model and thread source. It reads the response, turns it into a `ThreadStartResponse`, checks the thread fields and raw JSON, then keeps reading messages until it finds the matching `thread/started` notification. The output is success if all fields and notification behavior match expectations; otherwise the test fails.

**Call relations**: The async test harness runs this as a standalone scenario. It relies on `create_config_toml_without_approval_policy` to prepare a minimal valid config, then uses the test server helpers to send the request and read back JSON-RPC messages. If an unexpected status-change notification appears before the started notification for the new thread, it deliberately fails with `bail!`.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 10 external calls (default, new, bail!, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, from_value, now, timeout).


##### `thread_start_accepts_absolute_runtime_workspace_roots`  (lines 203–239)

```
async fn thread_start_accepts_absolute_runtime_workspace_roots() -> Result<()>
```

**Purpose**: Verifies that clients may pass extra absolute workspace roots at thread start time. Workspace roots are folders the session is allowed to treat as part of the active work area.

**Data flow**: The test creates a temporary current working directory and a second folder inside it, then sends both as thread start settings. The server response is decoded and the returned current directory and runtime workspace roots are compared to their absolute path forms. The test succeeds only if the server preserves those absolute runtime roots.

**Call relations**: The test harness calls this scenario directly. It uses `create_config_toml_without_approval_policy` for the base server setup, then exercises the app server through `TestAppServer` request and response helpers.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 8 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, create_dir_all, timeout, vec!).


##### `thread_start_excludes_profile_workspace_roots_from_runtime_workspace_roots`  (lines 242–280)

```
async fn thread_start_excludes_profile_workspace_roots_from_runtime_workspace_roots() -> Result<()>
```

**Purpose**: Checks that workspace roots already defined in a user profile are not repeated as runtime workspace roots in the `thread/start` response. This keeps the response focused on roots added for this specific thread.

**Data flow**: The test writes a config with a profile workspace root, starts a thread from a separate temporary current directory, and reads the response. It inspects only the returned runtime workspace roots and expects to see the current directory, not the profile-defined root. The result is a pass if the server separates profile roots from runtime roots correctly.

**Call relations**: This test is run by the async test harness. It depends on `create_config_toml_with_profile_workspace_root` to create a config that includes profile-level permissions, then checks the app server’s thread-start response.

*Call graph*: calls 2 internal fn (new, create_config_toml_with_profile_workspace_root); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_start_rejects_unknown_environment_as_invalid_request`  (lines 283–316)

```
async fn thread_start_rejects_unknown_environment_as_invalid_request() -> Result<()>
```

**Purpose**: Confirms that the server rejects a thread start request that names a turn environment the server does not know. A turn environment is a named place where later model work can run.

**Data flow**: The test sends `thread/start` with an environment id called `missing` and an otherwise valid absolute directory. Instead of a normal response, it waits for a JSON-RPC error and checks the request id, standard invalid-request code, and human-readable message. Nothing should be created from this bad request.

**Call relations**: The test harness calls it as an isolated negative case. It uses `create_config_toml_without_approval_policy` for a normal setup, then expects the app server’s request validation path to return an error.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 7 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout, vec!).


##### `thread_start_rejects_relative_environment_cwd_as_invalid_request`  (lines 319–350)

```
async fn thread_start_rejects_relative_environment_cwd_as_invalid_request() -> Result<()>
```

**Purpose**: Makes sure an environment current directory must be absolute, not relative. This matters because relative paths can mean different things depending on where a process happens to be running.

**Data flow**: The test sends an environment named `local` with `cwd` set to `relative`. It waits for a JSON-RPC error and checks that the error points to the bad environment path and uses the invalid-request code. The expected output is a clear rejection rather than a thread.

**Call relations**: The async test harness runs this scenario. It uses the standard config helper, then sends malformed thread-start parameters through `TestAppServer` and reads the resulting error.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 7 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout, vec!).


##### `thread_start_response_includes_loaded_instruction_sources`  (lines 353–397)

```
async fn thread_start_response_includes_loaded_instruction_sources() -> Result<()>
```

**Purpose**: Checks that the thread-start response reports which instruction files were actually loaded. These `AGENTS.md` files are project or global instructions that guide the model’s behavior.

**Data flow**: The test writes a global `AGENTS.md` in the Codex home and a project `AGENTS.md` in a temporary workspace. It starts a thread in that workspace, reads the response, normalizes paths for comparison, and expects both instruction file paths to be listed. The test passes when the response tells the client exactly which instruction sources were used.

**Call relations**: The test harness calls this directly. It uses `create_config_toml_without_approval_policy` for server setup and calls `normalize_path_for_comparison` before comparing paths so Windows and non-Windows paths can be checked consistently.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 8 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, write, timeout, vec!).


##### `thread_start_response_excludes_empty_project_instruction_source`  (lines 400–440)

```
async fn thread_start_response_excludes_empty_project_instruction_source() -> Result<()>
```

**Purpose**: Verifies that an empty project `AGENTS.md` file is not reported as a loaded instruction source. Empty files should not look like meaningful guidance was loaded.

**Data flow**: The test writes non-empty global instructions and an empty project instruction file, starts a thread in that workspace, and reads the instruction source list from the response. After path normalization, it expects only the global file. The outcome is success if empty project instructions are ignored.

**Call relations**: This scenario is launched by the async test harness. It uses the common no-approval config helper and the shared path normalizer when checking the server’s response.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 8 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, write, timeout, vec!).


##### `thread_start_without_selected_environment_includes_only_global_instruction_source`  (lines 443–521)

```
async fn thread_start_without_selected_environment_includes_only_global_instruction_source() -> Result<()>
```

**Purpose**: Checks that if the caller explicitly selects no environments, project instructions are not loaded even when a current directory is provided. This prevents workspace-specific instructions from leaking into a thread that has no selected workspace environment.

**Data flow**: The test writes global and project instruction files, then starts a thread with `environments` set to an empty list. It verifies that the response lists only the global instruction file. It then starts a turn in that thread, inspects the mock model request body, and confirms it contains global instructions but not project instructions.

**Call relations**: The test harness runs this end-to-end scenario. It uses `create_config_toml_without_approval_policy`, the server’s thread-start and turn-start helpers, and `normalize_path_for_comparison` for the response path check. The mock model server provides the final evidence of what instructions were actually sent.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 10 external calls (default, new, new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, write, timeout, vec!).


##### `normalize_path_for_comparison`  (lines 531–533)

```
fn normalize_path_for_comparison(path: impl AsRef<Path>) -> PathBuf
```

**Purpose**: Turns a path into a form that can be compared reliably in tests. On Windows it removes the special `\\?\` prefix if present; on other systems it leaves the path unchanged.

**Data flow**: The function receives any path-like value. It reads it as a path, optionally converts it through a display string to strip a Windows-only prefix, and returns a `PathBuf` suitable for equality checks. It does not touch the file system.

**Call relations**: Several instruction-source tests call this helper before comparing expected and actual paths. It exists only to keep those tests from failing because of harmless platform-specific path spelling differences.

*Call graph*: 4 external calls (as_ref, display, strip_prefix, from).


##### `thread_start_tracks_thread_initialized_analytics`  (lines 536–571)

```
async fn thread_start_tracks_thread_initialized_analytics() -> Result<()>
```

**Purpose**: Checks that starting a thread sends the expected analytics event. Analytics here means a small tracking payload used to understand product behavior, not the conversation content itself.

**Data flow**: The test configures a mock server to capture analytics, starts the app server without replacing the prepared config, sends `thread/start`, and reads the returned thread. It waits for one analytics payload, extracts the thread-initialized event, and checks key fields such as thread id, session id, model, creation mode, and source. The output is success if exactly the expected event appears.

**Call relations**: The test harness calls this case. It uses `create_config_toml_with_chatgpt_base_url` to enable the ChatGPT-style backend URL and calls analytics helpers from the sibling analytics module to mount, wait for, parse, and assert the event.

*Call graph*: calls 6 internal fn (new_without_managed_config, assert_basic_thread_initialized_event, mount_analytics_capture, thread_initialized_event, wait_for_analytics_payload, create_config_toml_with_chatgpt_base_url); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_start_respects_project_config_from_cwd`  (lines 574–612)

```
async fn thread_start_respects_project_config_from_cwd() -> Result<()>
```

**Purpose**: Verifies that when a trusted project has its own `.codex/config.toml`, `thread/start` loads settings from that project. In this case it checks the model reasoning effort setting.

**Data flow**: The test creates a workspace with project config setting reasoning effort to high, marks that workspace trusted, starts a thread with that workspace as the current directory, and reads the response. It expects the response to report high reasoning effort. The before-to-after story is: trusted project config exists, thread starts there, response reflects that config.

**Call relations**: The async test harness runs it. It uses `create_config_toml_without_approval_policy` for base config and `set_project_trust_level` to make the project config eligible to load before exercising the server.

*Call graph*: calls 3 internal fn (new, create_config_toml_without_approval_policy, set_project_trust_level); 8 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, create_dir_all, write, timeout).


##### `thread_start_drops_unsupported_service_tier_id`  (lines 615–642)

```
async fn thread_start_drops_unsupported_service_tier_id() -> Result<()>
```

**Purpose**: Checks that an unknown service tier id is not echoed back in the thread-start response. A service tier is a named backend service level; unsupported names should be discarded rather than treated as valid.

**Data flow**: The test sends `thread/start` with an experimental service tier string. It decodes the response and checks that `service_tier` is `None`. The test succeeds if unsupported service tier input is dropped during session configuration.

**Call relations**: The test harness invokes this scenario. It uses the standard config helper, starts the test server, and relies on the response decoder to inspect the final server choice.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_start_accepts_default_service_tier`  (lines 645–673)

```
async fn thread_start_accepts_default_service_tier() -> Result<()>
```

**Purpose**: Confirms that the special default service tier request value is accepted and returned. This protects the client contract for asking the backend to use its default tier.

**Data flow**: The test sends `thread/start` with the default service tier value. It reads the response and expects the same value to be present in `service_tier`. The output is a passing assertion when the server keeps the supported value.

**Call relations**: The async test harness calls this test. It uses `create_config_toml_without_approval_policy` for setup and then checks the app server’s thread-start response.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_start_accepts_metrics_service_name`  (lines 676–701)

```
async fn thread_start_accepts_metrics_service_name() -> Result<()>
```

**Purpose**: Checks that a client can include a service name used for metrics without breaking thread creation. The service name identifies the calling client for measurement purposes.

**Data flow**: The test sends a thread-start request with `service_name` set to `my_app_server_client`. It reads the response and only requires that a valid non-empty thread id is returned. The result is success if metrics metadata is accepted as harmless input.

**Call relations**: The test harness runs this standalone case. It uses the common config writer and the `TestAppServer` request helpers, focusing on successful creation rather than deeper response fields.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, timeout).


##### `thread_start_ephemeral_remains_pathless`  (lines 704–746)

```
async fn thread_start_ephemeral_remains_pathless() -> Result<()>
```

**Purpose**: Verifies that ephemeral threads are marked as temporary and do not expose a saved thread path. Ephemeral means the thread should not be treated as a persistent on-disk conversation.

**Data flow**: The test sends `thread/start` with `ephemeral: true`, reads the raw and decoded response, and checks that the thread is marked ephemeral and has no path. It also checks the raw JSON contains `ephemeral: true`. The expected output is a temporary thread with no file location advertised.

**Call relations**: The async test harness invokes this scenario. It uses `create_config_toml_without_approval_policy` and the test server helpers to confirm both typed response data and wire-level JSON.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 7 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout).


##### `thread_start_fails_when_required_mcp_server_fails_to_initialize`  (lines 749–782)

```
async fn thread_start_fails_when_required_mcp_server_fails_to_initialize() -> Result<()>
```

**Purpose**: Checks that thread creation fails if a required MCP server cannot start. Required tool servers are part of the session contract, so the thread should not begin without them.

**Data flow**: The test writes a config containing a required MCP server whose command exits immediately with failure. It starts the app server, sends `thread/start`, waits for a JSON-RPC error, and checks that the message names the failed required server. The output is an intentional failure response rather than a usable thread.

**Call relations**: The test harness calls this negative case. It depends on `create_config_toml_with_required_broken_mcp`, which in turn uses `broken_mcp_transport_toml` to describe a command that fails on the current operating system.

*Call graph*: calls 2 internal fn (new, create_config_toml_with_required_broken_mcp); 6 external calls (new, Integer, default, create_mock_responses_server_repeating_assistant, assert!, timeout).


##### `thread_start_emits_mcp_server_status_updated_notifications`  (lines 785–881)

```
async fn thread_start_emits_mcp_server_status_updated_notifications() -> Result<()>
```

**Purpose**: Verifies that optional MCP server startup progress is reported to the client. Optional MCP servers may fail without blocking the thread, but the client should still be told what happened.

**Data flow**: The test writes a config with an optional broken MCP server, starts a thread, and keeps reading notifications. It expects first a `starting` status notification and then a `failed` status notification for that server, both tied to the created thread id. The test passes if the notifications are correctly shaped and include the failure message.

**Call relations**: The async test harness runs this scenario. It uses `create_config_toml_with_optional_broken_mcp`, which calls `broken_mcp_transport_toml`, then converts raw notifications into typed `ServerNotification` values before checking them.

*Call graph*: calls 2 internal fn (new, create_config_toml_with_optional_broken_mcp); 9 external calls (new, bail!, Integer, default, create_mock_responses_server_repeating_assistant, to_response, assert!, assert_eq!, timeout).


##### `thread_start_surfaces_cloud_config_bundle_load_errors`  (lines 884–963)

```
async fn thread_start_surfaces_cloud_config_bundle_load_errors() -> Result<()>
```

**Purpose**: Checks that cloud configuration loading failures are returned to clients with useful structured error details. This is especially important when authentication has expired and the user needs to log in again.

**Data flow**: The test starts a mock backend that returns unauthorized responses for both the config bundle and token refresh. It writes ChatGPT-style config and stale authentication credentials, starts the app server with environment overrides, then sends `thread/start`. It expects a JSON-RPC error whose message says configuration loading failed and whose data tells the client the reason, error type, action, status code, and detail text.

**Call relations**: The test harness calls this full failure simulation. It uses `create_config_toml_with_chatgpt_base_url`, external auth-writing helpers, `wiremock` routes for fake HTTP responses, and `TestAppServer::new_with_env` to control environment variables during the test.

*Call graph*: calls 3 internal fn (new, new_with_env, create_config_toml_with_chatgpt_base_url); 15 external calls (given, start, new, new, Integer, default, create_mock_responses_server_repeating_assistant, write_chatgpt_auth, assert!, assert_eq! (+5 more)).


##### `thread_start_with_elevated_sandbox_trusts_project_and_followup_loads_project_config`  (lines 966–1029)

```
async fn thread_start_with_elevated_sandbox_trusts_project_and_followup_loads_project_config() -> Result<()>
```

**Purpose**: Verifies that starting a thread with a write-capable sandbox can mark the project as trusted, and that a later thread start then loads the project’s config. A sandbox is a safety mode that limits what the session may do.

**Data flow**: The test creates a workspace with project config, starts one thread there with `WorkspaceWrite` sandbox, then starts a second thread there without explicitly passing sandbox settings. It checks that the second response uses the expected approval policy and high reasoning effort from project config. Finally it reads the home config file and confirms the project trust entry was written.

**Call relations**: The async test harness runs this two-step scenario. It uses `create_config_toml_without_approval_policy`, then later calls `resolve_root_git_project_for_trust` and `project_trust_key` to verify that the trust record was saved under the same key the product uses.

*Call graph*: calls 3 internal fn (new, create_config_toml_without_approval_policy, project_trust_key); 11 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, resolve_root_git_project_for_trust, create_dir_all, read_to_string, write (+1 more)).


##### `thread_start_with_nested_git_cwd_trusts_repo_root`  (lines 1032–1070)

```
async fn thread_start_with_nested_git_cwd_trusts_repo_root() -> Result<()>
```

**Purpose**: Checks that when the current directory is inside a Git repository, elevated sandbox trust is saved for the repository root, not just the nested folder. Git is the common version-control folder marked by `.git`.

**Data flow**: The test creates a fake repository root with a `.git` directory and a nested child folder. It starts a thread from the nested folder with `WorkspaceWrite`, then reads the config file. It expects the trust key for the repository root to be present and the nested-folder key to be absent.

**Call relations**: The test harness invokes this scenario. It uses the standard config helper and then calls `resolve_root_git_project_for_trust` and `project_trust_key` to compare what the app saved against the expected repository root.

*Call graph*: calls 3 internal fn (new, create_config_toml_without_approval_policy, project_trust_key); 10 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, resolve_root_git_project_for_trust, create_dir, create_dir_all, read_to_string, timeout).


##### `thread_start_with_read_only_sandbox_does_not_persist_project_trust`  (lines 1073–1101)

```
async fn thread_start_with_read_only_sandbox_does_not_persist_project_trust() -> Result<()>
```

**Purpose**: Ensures that a normal read-only thread start does not mark a project as trusted. Trust should only be persisted when the user has chosen a more powerful sandbox mode.

**Data flow**: The test starts a thread in a temporary workspace without requesting write access. After the response, it reads the home config file and checks that it contains neither a trusted marker nor the workspace path. The output is a pass if no trust setting was written.

**Call relations**: The async test harness runs this case. It uses `create_config_toml_without_approval_policy` for setup and only inspects the config file after a successful thread-start response.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 7 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, read_to_string, timeout).


##### `thread_start_preserves_untrusted_project_trust`  (lines 1104–1139)

```
async fn thread_start_preserves_untrusted_project_trust() -> Result<()>
```

**Purpose**: Verifies that if a project is already explicitly marked untrusted, starting with an elevated sandbox does not overwrite that choice. This protects a user’s deliberate security decision.

**Data flow**: The test writes base config, edits it to add an `untrusted` project entry, and saves a copy of the file contents. It then starts a thread in that workspace with `WorkspaceWrite` and reads the config again. The test passes only if the file is unchanged byte-for-byte.

**Call relations**: The test harness runs it as a trust-safety scenario. It uses `create_config_toml_without_approval_policy`, edits TOML directly, then confirms the app server does not call the trust-writing path in a way that changes the file.

*Call graph*: calls 2 internal fn (new, create_config_toml_without_approval_policy); 9 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, read_to_string, write, timeout, value).


##### `thread_start_skips_trust_write_when_project_is_already_trusted`  (lines 1142–1188)

```
async fn thread_start_skips_trust_write_when_project_is_already_trusted() -> Result<()>
```

**Purpose**: Checks that an already trusted project is not rewritten when starting with an elevated sandbox. This avoids unnecessary config file changes while still allowing project config to load.

**Data flow**: The test creates project config, marks the workspace trusted, and records the home config contents. It starts a thread with `WorkspaceWrite`, checks the response loaded the expected approval policy and high reasoning effort, then reads the config again. Success means the response is correct and the config file did not change.

**Call relations**: The async test harness calls this case. It uses `set_project_trust_level` to prepare the trusted state, relies on the standard config helper for model setup, and compares config text before and after the server request.

*Call graph*: calls 3 internal fn (new, create_config_toml_without_approval_policy, set_project_trust_level); 9 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, create_dir_all, read_to_string, write, timeout).


##### `create_config_toml_without_approval_policy`  (lines 1190–1197)

```
fn create_config_toml_without_approval_policy(
    codex_home: &Path,
    server_uri: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes the standard test configuration without explicitly setting an approval policy. Tests use it when they want the server’s defaults to decide approval behavior.

**Data flow**: The function receives a temporary Codex home path and a mock model server URL. It passes those values, plus `None` for the approval policy, to `create_config_toml_with_optional_approval_policy`. The result is a `config.toml` file on disk or an I/O error.

**Call relations**: Many thread-start tests call this helper during setup. It is a thin convenience wrapper around `create_config_toml_with_optional_approval_policy`, keeping repeated test setup short and consistent.

*Call graph*: calls 1 internal fn (create_config_toml_with_optional_approval_policy); called by 17 (thread_start_accepts_absolute_runtime_workspace_roots, thread_start_accepts_default_service_tier, thread_start_accepts_metrics_service_name, thread_start_creates_thread_and_emits_started, thread_start_drops_unsupported_service_tier_id, thread_start_ephemeral_remains_pathless, thread_start_preserves_untrusted_project_trust, thread_start_rejects_relative_environment_cwd_as_invalid_request, thread_start_rejects_unknown_environment_as_invalid_request, thread_start_respects_project_config_from_cwd (+7 more)).


##### `create_config_toml_with_optional_approval_policy`  (lines 1199–1226)

```
fn create_config_toml_with_optional_approval_policy(
    codex_home: &Path,
    server_uri: &str,
    approval_policy: Option<&str>,
) -> std::io::Result<()>
```

**Purpose**: Writes a minimal `config.toml` for tests, optionally including an approval policy. The config points the app server at the mock model provider so tests do not call a real model service.

**Data flow**: The function receives a Codex home path, mock server URL, and optional approval policy string. It builds TOML text containing model name, sandbox mode, provider name, provider base URL, and retry settings, then writes it to `config.toml`. It returns success or the file-writing error.

**Call relations**: `create_config_toml_without_approval_policy` calls this shared writer. The rest of the test file benefits from one consistent baseline config instead of duplicating TOML in every test.

*Call graph*: called by 1 (create_config_toml_without_approval_policy); 3 external calls (join, format!, write).


##### `create_config_toml_with_profile_workspace_root`  (lines 1228–1262)

```
fn create_config_toml_with_profile_workspace_root(
    codex_home: &Path,
    server_uri: &str,
    profile_root: &Path,
) -> std::io::Result<()>
```

**Purpose**: Writes a test config that includes a profile-level workspace root permission. This lets a test check the difference between roots configured in a profile and roots added at thread start time.

**Data flow**: The function receives a Codex home path, mock server URL, and profile root path. It escapes the profile path for TOML, writes model provider settings, then adds permission sections that mark that root as writable. It returns success or an I/O error.

**Call relations**: `thread_start_excludes_profile_workspace_roots_from_runtime_workspace_roots` calls this helper to set up the exact profile-root condition it wants to test.

*Call graph*: called by 1 (thread_start_excludes_profile_workspace_roots_from_runtime_workspace_roots); 4 external calls (display, join, format!, write).


##### `create_config_toml_with_chatgpt_base_url`  (lines 1264–1290)

```
fn create_config_toml_with_chatgpt_base_url(
    codex_home: &Path,
    server_uri: &str,
    chatgpt_base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes a test config that includes a ChatGPT backend base URL as well as the mock model provider. Tests use this when they need analytics or cloud configuration behavior.

**Data flow**: The function receives a Codex home path, model server URL, and ChatGPT base URL. It writes a `config.toml` with model settings, `approval_policy = "never"`, read-only sandboxing, the ChatGPT URL, and mock provider settings. It returns success or a file-writing error.

**Call relations**: `thread_start_tracks_thread_initialized_analytics` and `thread_start_surfaces_cloud_config_bundle_load_errors` call this helper because both scenarios need the app server to talk to a ChatGPT-style backend endpoint.

*Call graph*: called by 2 (thread_start_surfaces_cloud_config_bundle_load_errors, thread_start_tracks_thread_initialized_analytics); 3 external calls (join, format!, write).


##### `create_config_toml_with_required_broken_mcp`  (lines 1292–1321)

```
fn create_config_toml_with_required_broken_mcp(
    codex_home: &Path,
    server_uri: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes a config containing a required MCP server that is guaranteed to fail. This creates a controlled setup for testing that thread start is blocked when required tools cannot initialize.

**Data flow**: The function receives a Codex home path and mock model server URL. It writes normal model provider settings plus an MCP server named `required_broken`, marks it required, and inserts a platform-specific failing command from `broken_mcp_transport_toml`. It returns success or an I/O error.

**Call relations**: `thread_start_fails_when_required_mcp_server_fails_to_initialize` calls this helper. This helper delegates the operating-system-specific command text to `broken_mcp_transport_toml`.

*Call graph*: called by 1 (thread_start_fails_when_required_mcp_server_fails_to_initialize); 3 external calls (join, format!, write).


##### `create_config_toml_with_optional_broken_mcp`  (lines 1323–1351)

```
fn create_config_toml_with_optional_broken_mcp(
    codex_home: &Path,
    server_uri: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes a config containing an optional MCP server that is guaranteed to fail. This lets tests confirm the server reports optional tool failure without blocking thread creation.

**Data flow**: The function receives a Codex home path and mock model server URL. It writes normal model provider settings plus an MCP server named `optional_broken` using a failing command from `broken_mcp_transport_toml`, but does not mark it required. It returns success or an I/O error.

**Call relations**: `thread_start_emits_mcp_server_status_updated_notifications` calls this helper. Like the required version, it uses `broken_mcp_transport_toml` for the platform-specific failing command.

*Call graph*: called by 1 (thread_start_emits_mcp_server_status_updated_notifications); 3 external calls (join, format!, write).


##### `broken_mcp_transport_toml`  (lines 1360–1363)

```
fn broken_mcp_transport_toml() -> &'static str
```

**Purpose**: Returns TOML text for an MCP server command that immediately exits with failure. The exact command differs between Windows and Unix-like systems.

**Data flow**: The function takes no input. Depending on the operating system at compile time, it returns either a Windows `cmd /C exit 1` transport snippet or a Unix `/bin/sh -c exit 1` snippet. It only returns text; it does not run the command itself.

**Call relations**: The broken MCP config helpers call this when writing their test configs. Those configs are then used by tests that check required-MCP failure and optional-MCP status notifications.


### `app-server/tests/suite/v2/thread_list.rs`

`test` · `test run`

A "thread" here is a saved conversation session. The app server must be able to show those sessions in a UI, like an inbox: newest first, searchable, filterable, and split into pages. This test file protects that behavior. It creates temporary Codex home folders, writes small config files, plants fake rollout files (the saved conversation logs), starts a test app server, and sends JSON-RPC requests, which are structured request/response messages. The tests then read the server's replies and compare them with the expected thread IDs, timestamps, sources, providers, working folders, Git details, statuses, and cursors. The helper functions are the test bench: they start the server, send common list requests, create batches of fake rollouts, and edit rollout metadata such as modified time or current working directory. The individual tests cover many real user scenarios: an empty history, provider filters, folder filters, search terms, source kinds such as CLI or sub-agent, parent-child thread relationships, archived sessions, maximum page sizes, stable tie-breaking, and invalid input. Without this file, regressions in the thread history API could easily go unnoticed, causing users to see missing, duplicated, wrongly sorted, or unsearchable conversations.

#### Function details

##### `init_mcp`  (lines 52–56)

```
async fn init_mcp(codex_home: &Path) -> Result<TestAppServer>
```

**Purpose**: Starts a fresh test app server for a temporary Codex home folder and waits until it is ready. Tests use it so they can talk to the server the same way a real client would.

**Data flow**: It receives a path to a temporary Codex home. It creates a TestAppServer, sends the initialize step, waits up to the shared timeout, and returns the ready server object.

**Call relations**: Nearly every test calls this after creating config and test data. It hands back the live server that later helpers, especially list_threads and list_threads_with_sort, use to send requests.

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

**Purpose**: Sends a common thread/list request without choosing a special sort key. It is a convenience wrapper for tests that only care about filters, limits, cursors, or archive state.

**Data flow**: It takes a test server plus optional cursor, limit, provider filter, source-kind filter, and archive flag. It fills in the rest of the request with defaults, delegates to list_threads_with_sort, and returns the decoded ThreadListResponse.

**Call relations**: Many tests call this for the normal listing path. It passes the work to list_threads_with_sort, which performs the actual request and response reading.

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

**Purpose**: Sends a thread/list request and lets the caller choose whether to sort by created time or updated time. Tests use it when ordering is the behavior being checked.

**Data flow**: It receives request options, builds ThreadListParams, sends them to the test server, waits for the JSON-RPC response with the matching request ID, and converts that response into a ThreadListResponse.

**Call relations**: It is called directly by sorting tests and indirectly through list_threads. It is the main bridge between the test code and the app server's thread listing API.

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

**Purpose**: Requests only the child threads of one parent thread. This helps test the parent-child thread feature used for spawned or related conversations.

**Data flow**: It takes a server, parent thread ID, cursor, page size, and optional filters. It sends a thread/list request with parent_thread_id set, waits for the matching response, and returns the decoded list.

**Call relations**: The parent-filter test calls this twice to check paging through direct children. It talks to the same thread/list API as the other helpers, but with the parent field filled in.

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

**Purpose**: Creates many fake saved conversation files in a compact way. Tests use it when they need enough threads to exercise pagination and limits.

**Data flow**: It receives a Codex home path, a count, two small functions that choose provider and timestamp per index, and a preview string. It loops, creates each fake rollout, collects the generated IDs, and returns them.

**Call relations**: Pagination-heavy tests call this instead of writing many create_fake_rollout calls by hand. It relies on create_fake_rollout from the test support library to write each saved conversation.

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

**Purpose**: Builds matching timestamp strings in the two formats used by rollout filenames and rollout contents. It keeps bulk test setup readable.

**Data flow**: It receives year, month, day, hour, minute, and second numbers. It formats them once with dashes for the file name and once as an RFC 3339 time string, then returns both strings.

**Call relations**: It is passed into create_fake_rollouts through closures in bulk pagination tests. Those tests use it to make predictable creation times.

*Call graph*: 1 external calls (format!).


##### `set_rollout_mtime`  (lines 182–190)

```
fn set_rollout_mtime(path: &Path, updated_at_rfc3339: &str) -> Result<()>
```

**Purpose**: Changes the file modified time of a fake rollout. Tests use this because updated-at sorting is based on file modification time, like sorting documents by when they were last touched.

**Data flow**: It receives a rollout file path and an RFC 3339 timestamp string. It parses the time, builds file-time metadata, opens the file, sets its modified time, and returns success or an error.

**Call relations**: Updated-at tests call this after creating rollout files. The later list requests then prove that the server reads those modified times correctly.

*Call graph*: called by 5 (thread_list_backwards_cursor_can_seed_forward_delta_sync, thread_list_sort_updated_at_orders_by_mtime, thread_list_updated_at_paginates_with_cursor, thread_list_updated_at_tie_breaks_by_uuid, thread_list_updated_at_uses_mtime); 3 external calls (parse_from_rfc3339, new, new).


##### `set_rollout_cwd`  (lines 192–210)

```
fn set_rollout_cwd(path: &Path, cwd: &Path) -> Result<()>
```

**Purpose**: Edits the saved working directory inside a fake rollout file. This lets tests verify that the server can filter threads by the folder where they were created.

**Data flow**: It reads the rollout file, parses the first JSON line as session metadata, replaces the cwd field with the supplied path, serializes the line again, and writes the file back.

**Call relations**: The cwd filter test calls this to give two rollouts special folders. The server later reads those edited rollout files and should return only matching threads.

*Call graph*: called by 1 (thread_list_respects_cwd_filters); 7 external calls (to_path_buf, anyhow!, read_to_string, write, SessionMeta, from_str, to_string).


##### `thread_list_basic_empty`  (lines 213–234)

```
async fn thread_list_basic_empty() -> Result<()>
```

**Purpose**: Checks that listing threads from an empty Codex home returns an empty list and no next page cursor. This is the simplest baseline behavior.

**Data flow**: It creates a temporary home, writes minimal config, starts the server, requests up to ten threads for the mock provider, and checks that the response has no data and no next_cursor.

**Call relations**: It uses create_minimal_config, init_mcp, and list_threads. It proves the list endpoint behaves cleanly before any rollout files exist.

*Call graph*: calls 3 internal fn (create_minimal_config, init_mcp, list_threads); 4 external calls (new, assert!, assert_eq!, vec!).


##### `thread_list_reports_system_error_idle_flag_after_failed_turn`  (lines 237–327)

```
async fn thread_list_reports_system_error_idle_flag_after_failed_turn() -> Result<()>
```

**Purpose**: Checks that a thread whose latest turn failed is shown with a system error status in the thread list. This matters so clients can display that the conversation ended in a problem.

**Data flow**: It prepares a mock model server that first succeeds and then returns an error. It starts a thread, runs one successful turn and one failing turn, lists threads, finds the created thread, and checks its status.

**Call relations**: It uses create_runtime_config and init_mcp to run against the mock responses server, then uses list_threads to inspect the final thread metadata after notifications arrive.

*Call graph*: calls 3 internal fn (create_runtime_config, init_mcp, list_threads); 7 external calls (default, new, Integer, create_mock_responses_server_sequence, assert_eq!, timeout, vec!).


##### `create_minimal_config`  (lines 330–339)

```
fn create_minimal_config(codex_home: &std::path::Path) -> std::io::Result<()>
```

**Purpose**: Writes the smallest config file needed for most thread-list tests. It avoids repeating the same model and approval settings in every test.

**Data flow**: It receives a Codex home path, joins it with config.toml, and writes a short TOML configuration file. It returns the file write result.

**Call relations**: Most tests call this before init_mcp. The server reads this config at startup so the tests can focus on thread listing rather than configuration setup.

*Call graph*: called by 25 (thread_list_archived_filter, thread_list_backwards_cursor_can_seed_forward_delta_sync, thread_list_basic_empty, thread_list_created_at_tie_breaks_by_uuid, thread_list_default_sorts_by_created_at, thread_list_empty_source_kinds_defaults_to_interactive_only, thread_list_enforces_max_limit, thread_list_fetches_until_limit_or_exhausted, thread_list_filters_by_source_kind_subagent_thread_spawn, thread_list_filters_by_subagent_variant (+15 more)); 2 external calls (join, write).


##### `create_runtime_config`  (lines 341–362)

```
fn create_runtime_config(codex_home: &std::path::Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes a config file that points the app server at a mock model provider. It is used for tests that actually start turns and need controlled model responses.

**Data flow**: It receives a Codex home path and a mock server URL. It writes config.toml with provider details, retry settings, sandbox mode, and model settings.

**Call relations**: The failed-turn status test calls this before starting the app server. It connects that test's runtime behavior to the mock responses server.

*Call graph*: called by 1 (thread_list_reports_system_error_idle_flag_after_failed_turn); 3 external calls (join, format!, write).


##### `thread_list_pagination_next_cursor_none_on_last_page`  (lines 365–454)

```
async fn thread_list_pagination_next_cursor_none_on_last_page() -> Result<()>
```

**Purpose**: Checks normal two-page pagination. It verifies that a first page gets a next cursor and the final page reports no further cursor.

**Data flow**: It creates three fake rollouts, starts the server, lists two items, then uses the returned cursor to list the next page. It checks thread fields and confirms the second page has no next_cursor.

**Call relations**: It uses create_minimal_config, init_mcp, create_fake_rollout, and list_threads. It exercises the basic cursor flow that clients use to load more history.

*Call graph*: calls 3 internal fn (create_minimal_config, init_mcp, list_threads); 5 external calls (new, create_fake_rollout, assert!, assert_eq!, vec!).


##### `thread_list_respects_provider_filter`  (lines 457–507)

```
async fn thread_list_respects_provider_filter() -> Result<()>
```

**Purpose**: Checks that listing can be limited to one model provider. This prevents conversations from one provider being mixed into another provider's view.

**Data flow**: It creates two fake rollouts with different provider names, asks for only other_provider, and checks that exactly that thread is returned with the expected metadata.

**Call relations**: It follows the standard setup path through create_minimal_config and init_mcp, then uses list_threads with a provider filter.

*Call graph*: calls 3 internal fn (create_minimal_config, init_mcp, list_threads); 5 external calls (new, create_fake_rollout, assert_eq!, parse_from_rfc3339, vec!).


##### `thread_list_respects_cwd_filters`  (lines 510–596)

```
async fn thread_list_respects_cwd_filters() -> Result<()>
```

**Purpose**: Checks that listing can filter by current working directory, meaning the project folder where a thread happened. This supports project-specific history views.

**Data flow**: It creates three rollouts, rewrites two of them to have target cwd paths, sends a thread/list request with those cwd filters, and checks that only the two matching threads return in the expected order.

**Call relations**: It uses set_rollout_cwd to alter test data, then sends the request directly through the test server instead of the simpler list_threads helper because it needs the cwd field.

*Call graph*: calls 3 internal fn (create_minimal_config, init_mcp, set_rollout_cwd); 10 external calls (new, Integer, Many, create_fake_rollout, rollout_path, assert!, assert_eq!, create_dir_all, timeout, vec!).


##### `thread_list_respects_search_term_filter`  (lines 599–700)

```
async fn thread_list_respects_search_term_filter() -> Result<()>
```

**Purpose**: Checks that thread/list can filter threads by a search term when the SQLite state database path is enabled. SQLite is the small local database used as a faster index.

**Data flow**: It writes config enabling SQLite, creates matching and non-matching rollout files, marks database backfill complete, runs a repair/list step to populate the database, then sends a searched list request and checks only the matching IDs return.

**Call relations**: It uses lower-level state and rollout APIs to prepare the database, then init_mcp and a direct thread/list request to test the app server search filter.

*Call graph*: calls 3 internal fn (init_mcp, list_threads, init); 7 external calls (new, Integer, create_fake_rollout, assert_eq!, write, timeout, vec!).


##### `thread_search_returns_content_matches`  (lines 703–762)

```
async fn thread_search_returns_content_matches() -> Result<()>
```

**Purpose**: Checks the dedicated thread/search endpoint returns content matches and snippets. A snippet is the matching bit of text shown to the user.

**Data flow**: It creates rollouts where two previews contain the word needle, sends a thread/search request, and checks that the newer match comes first and includes the expected snippet.

**Call relations**: It uses the usual config and server startup helpers, then talks directly to send_thread_search_request because this is a search endpoint, not the list helper.

*Call graph*: calls 2 internal fn (create_minimal_config, init_mcp); 5 external calls (new, Integer, create_fake_rollout, assert_eq!, timeout).


##### `thread_search_matches_json_escaped_content`  (lines 765–803)

```
async fn thread_search_matches_json_escaped_content() -> Result<()>
```

**Purpose**: Checks that search works even when the text contains quotes and backslashes that are escaped inside JSON. This protects searches for literal user text.

**Data flow**: It creates one rollout whose preview includes quoted text and a backslash, searches for that exact string, and checks that the single result has the same thread ID and snippet.

**Call relations**: It uses create_fake_rollout to create tricky saved content, then sends a thread/search request through the test server.

*Call graph*: calls 2 internal fn (create_minimal_config, init_mcp); 5 external calls (new, Integer, create_fake_rollout, assert_eq!, timeout).


##### `thread_search_filters_by_source_kind`  (lines 806–855)

```
async fn thread_search_filters_by_source_kind() -> Result<()>
```

**Purpose**: Checks that thread/search can restrict results by source kind, such as execution-created threads versus normal CLI threads.

**Data flow**: It creates one CLI rollout and one Exec rollout with the same searchable text. It searches for the text while filtering to Exec and checks that only the Exec thread appears.

**Call relations**: It relies on create_fake_rollout_with_source for the non-CLI source and uses the search request path to prove source filters apply there too.

*Call graph*: calls 2 internal fn (create_minimal_config, init_mcp); 8 external calls (new, Integer, create_fake_rollout, create_fake_rollout_with_source, assert_eq!, assert_ne!, timeout, vec!).


##### `thread_list_state_db_only_returns_sqlite_without_jsonl_repair`  (lines 858–981)

```
async fn thread_list_state_db_only_returns_sqlite_without_jsonl_repair() -> Result<()>
```

**Purpose**: Checks the special state-db-only listing mode. In that mode, the server should trust the SQLite database and not repair or reread JSONL rollout files.

**Data flow**: It creates a rollout, populates the database through a normal list, then deliberately changes the database cwd to a stale value. A state-db-only request finds the stale cwd, while a normal scanned request does not.

**Call relations**: It combines direct state database edits with app server list requests. This test proves use_state_db_only changes where the server reads truth from.

*Call graph*: calls 3 internal fn (init_mcp, from_string, init); 8 external calls (new, Integer, One, create_fake_rollout, assert_eq!, write, timeout, vec!).


##### `thread_list_parent_filter_reads_direct_children_from_state_db`  (lines 984–1107)

```
async fn thread_list_parent_filter_reads_direct_children_from_state_db() -> Result<()>
```

**Purpose**: Checks that listing by parent thread returns only direct child threads from the state database. It also verifies paging and filtering for child threads.

**Data flow**: It creates thread metadata directly in SQLite, inserts parent-child edges including a grandchild, marks backfill complete, requests children one page at a time, and checks only the two direct children are returned newest first.

**Call relations**: It uses list_threads_for_parent as its request helper. It writes database records directly because parent-child edges live in the state database.

*Call graph*: calls 6 internal fn (create_minimal_config, init_mcp, list_threads_for_parent, new, new, init); 8 external calls (SubAgent, parse_from_rfc3339, new, new, assert!, assert_eq!, format!, Other).


##### `thread_list_parent_filter_rejects_malformed_thread_id`  (lines 1110–1137)

```
async fn thread_list_parent_filter_rejects_malformed_thread_id() -> Result<()>
```

**Purpose**: Checks that an invalid parent_thread_id is rejected with a JSON-RPC invalid request error. This keeps bad client input from being silently treated as a real filter.

**Data flow**: It starts a server, sends a thread/list request whose parent_thread_id is the string not-a-thread-id, reads the error response, and checks the error code.

**Call relations**: It uses the normal startup helpers but sends the request directly so it can pass malformed input and read an error instead of a successful ThreadListResponse.

*Call graph*: calls 2 internal fn (create_minimal_config, init_mcp); 4 external calls (new, Integer, assert_eq!, timeout).


##### `thread_list_empty_source_kinds_defaults_to_interactive_only`  (lines 1140–1183)

```
async fn thread_list_empty_source_kinds_defaults_to_interactive_only() -> Result<()>
```

**Purpose**: Checks the meaning of an empty source-kind filter. In this API, an empty list means interactive threads only, not all possible source kinds.

**Data flow**: It creates a normal CLI thread and an Exec thread, lists with source_kinds set to an empty vector, and checks that only the CLI thread is returned.

**Call relations**: It calls list_threads with Some(Vec::new()). The test uses create_fake_rollout_with_source to make the non-interactive comparison thread.

*Call graph*: calls 3 internal fn (create_minimal_config, init_mcp, list_threads); 7 external calls (new, new, create_fake_rollout, create_fake_rollout_with_source, assert_eq!, assert_ne!, vec!).


##### `thread_list_filters_by_source_kind_subagent_thread_spawn`  (lines 1186–1238)

```
async fn thread_list_filters_by_source_kind_subagent_thread_spawn() -> Result<()>
```

**Purpose**: Checks filtering for sub-agent thread-spawn conversations. These are child-like conversations started by an agent rather than directly by the user.

**Data flow**: It creates a normal CLI rollout and a rollout whose source is SubAgent ThreadSpawn, lists only SubAgentThreadSpawn, and checks that the sub-agent thread is the only result.

**Call relations**: It uses list_threads with a source-kind filter. The source metadata is created by create_fake_rollout_with_source.

*Call graph*: calls 4 internal fn (create_minimal_config, init_mcp, list_threads, from_string); 9 external calls (SubAgent, new, new_v4, create_fake_rollout, create_fake_rollout_with_source, assert!, assert_eq!, assert_ne!, vec!).


##### `thread_list_filters_by_subagent_variant`  (lines 1241–1354)

```
async fn thread_list_filters_by_subagent_variant() -> Result<()>
```

**Purpose**: Checks that different sub-agent variants can be filtered separately: review, compact, thread spawn, and other. This prevents all sub-agent activity from being lumped together.

**Data flow**: It creates four sub-agent rollouts with different variant metadata, then sends four separate list requests, one for each variant, and checks each returns only its matching thread.

**Call relations**: It uses list_threads repeatedly after creating variant-specific rollout files. The review case also verifies that parent_thread_id metadata survives into the API response.

*Call graph*: calls 4 internal fn (create_minimal_config, init_mcp, list_threads, from_string); 8 external calls (SubAgent, new, new_v4, create_fake_parented_rollout_with_source, create_fake_rollout_with_source, assert_eq!, Other, vec!).


##### `thread_list_fetches_until_limit_or_exhausted`  (lines 1357–1418)

```
async fn thread_list_fetches_until_limit_or_exhausted() -> Result<()>
```

**Purpose**: Checks that the server keeps scanning through pages until it fills the requested number of filtered results. This matters when many newer threads do not match the filter.

**Data flow**: It creates 24 rollouts where the newest 16 have the wrong provider and the older 8 match. It requests 8 matching threads and checks that all 8 target-provider threads are returned.

**Call relations**: It uses create_fake_rollouts for bulk setup and list_threads for the request. The test stresses the server's internal paging beyond the first batch.

*Call graph*: calls 4 internal fn (create_fake_rollouts, create_minimal_config, init_mcp, list_threads); 4 external calls (new, assert!, assert_eq!, vec!).


##### `thread_list_enforces_max_limit`  (lines 1421–1468)

```
async fn thread_list_enforces_max_limit() -> Result<()>
```

**Purpose**: Checks that a too-large requested limit is clamped to the server's maximum page size. This protects the server from returning overly large responses.

**Data flow**: It creates 105 rollouts, asks for 200, and checks that only 100 are returned and a next cursor is present because more data remains.

**Call relations**: It uses create_fake_rollouts to build many conversations and list_threads to verify the public API limit behavior.

*Call graph*: calls 4 internal fn (create_fake_rollouts, create_minimal_config, init_mcp, list_threads); 4 external calls (new, assert!, assert_eq!, vec!).


##### `thread_list_stops_when_not_enough_filtered_results_exist`  (lines 1471–1531)

```
async fn thread_list_stops_when_not_enough_filtered_results_exist() -> Result<()>
```

**Purpose**: Checks that listing stops cleanly when fewer filtered results exist than requested. It guards against endless scanning loops.

**Data flow**: It creates 22 rollouts where only the last 7 match the requested provider, asks for 10, and verifies that exactly those 7 are returned with no next cursor.

**Call relations**: It uses create_fake_rollouts and list_threads like the other pagination stress tests, but this time proves exhaustion is handled correctly.

*Call graph*: calls 4 internal fn (create_fake_rollouts, create_minimal_config, init_mcp, list_threads); 4 external calls (new, assert!, assert_eq!, vec!).


##### `thread_list_includes_git_info`  (lines 1534–1579)

```
async fn thread_list_includes_git_info() -> Result<()>
```

**Purpose**: Checks that Git metadata saved in a rollout appears in the thread list response. Git metadata includes commit SHA, branch, and repository URL.

**Data flow**: It creates a rollout with Git information, lists threads, finds that rollout, and checks that the API response converts the core Git fields into the app-server Git fields.

**Call relations**: It uses create_fake_rollout with git_info set, then list_threads to inspect the server-facing representation.

*Call graph*: calls 4 internal fn (create_minimal_config, init_mcp, list_threads, new); 4 external calls (new, create_fake_rollout, assert_eq!, vec!).


##### `thread_list_default_sorts_by_created_at`  (lines 1582–1628)

```
async fn thread_list_default_sorts_by_created_at() -> Result<()>
```

**Purpose**: Checks that the default thread list order is newest created thread first. This is the normal history view users expect.

**Data flow**: It creates three rollouts with different creation times, lists without a sort key, and checks the returned IDs are in descending created-at order.

**Call relations**: It calls list_threads_with_sort directly with no sort key to make the default sorting behavior explicit.

*Call graph*: calls 3 internal fn (create_minimal_config, init_mcp, list_threads_with_sort); 4 external calls (new, create_fake_rollout, assert_eq!, vec!).


##### `thread_list_sort_updated_at_orders_by_mtime`  (lines 1631–1690)

```
async fn thread_list_sort_updated_at_orders_by_mtime() -> Result<()>
```

**Purpose**: Checks that sorting by updated_at uses the rollout file's modified time. This lets recently changed conversations rise to the top even if they were created earlier.

**Data flow**: It creates three rollouts, changes their file modified times to a different order, lists with sort_key UpdatedAt, and checks the returned IDs follow modified-time order.

**Call relations**: It combines set_rollout_mtime with list_threads_with_sort. The helper changes the test files, and the server is expected to read that change.

*Call graph*: calls 4 internal fn (create_minimal_config, init_mcp, list_threads_with_sort, set_rollout_mtime); 5 external calls (new, create_fake_rollout, rollout_path, assert_eq!, vec!).


##### `thread_list_updated_at_paginates_with_cursor`  (lines 1693–1774)

```
async fn thread_list_updated_at_paginates_with_cursor() -> Result<()>
```

**Purpose**: Checks cursor pagination when sorting by updated_at. It ensures page two continues after page one in the modified-time order.

**Data flow**: It creates three rollouts, assigns modified times, requests the first two updated-at results, then uses the returned cursor to request the remaining result and checks no further cursor remains.

**Call relations**: It uses set_rollout_mtime and list_threads_with_sort twice. This is the updated-at version of the basic pagination test.

*Call graph*: calls 4 internal fn (create_minimal_config, init_mcp, list_threads_with_sort, set_rollout_mtime); 5 external calls (new, create_fake_rollout, rollout_path, assert_eq!, vec!).


##### `thread_list_backwards_cursor_can_seed_forward_delta_sync`  (lines 1777–1883)

```
async fn thread_list_backwards_cursor_can_seed_forward_delta_sync() -> Result<()>
```

**Purpose**: Checks the backwards_cursor feature used to start a later forward sync. In plain terms, the first request returns a bookmark that can be reused to ask what changed after that point.

**Data flow**: It creates two rollouts with updated times, lists the newest one descending and captures backwards_cursor, then creates a newer rollout and lists ascending from that cursor. It checks that the watermark thread and new thread appear.

**Call relations**: It sends thread/list requests directly because it needs sort_direction as well as sort_key. It uses set_rollout_mtime to control the sync boundary precisely.

*Call graph*: calls 3 internal fn (create_minimal_config, init_mcp, set_rollout_mtime); 7 external calls (new, Integer, create_fake_rollout, rollout_path, assert_eq!, timeout, vec!).


##### `thread_list_created_at_tie_breaks_by_uuid`  (lines 1886–1926)

```
async fn thread_list_created_at_tie_breaks_by_uuid() -> Result<()>
```

**Purpose**: Checks deterministic ordering when two threads have the same created_at time. The tie is broken by UUID so the order is stable, not random.

**Data flow**: It creates two rollouts with the same creation timestamp, lists them, computes the expected descending UUID order, and compares it to the response.

**Call relations**: It uses list_threads for the default created-at sort and UUID parsing in the assertion to mirror the expected tie-break rule.

*Call graph*: calls 3 internal fn (create_minimal_config, init_mcp, list_threads); 4 external calls (new, create_fake_rollout, assert_eq!, vec!).


##### `thread_list_updated_at_tie_breaks_by_uuid`  (lines 1929–1980)

```
async fn thread_list_updated_at_tie_breaks_by_uuid() -> Result<()>
```

**Purpose**: Checks deterministic ordering when two threads have the same updated_at time. Stable tie-breaking avoids duplicate or skipped items during pagination.

**Data flow**: It creates two rollouts, sets both file modified times to the same timestamp, lists by UpdatedAt, and checks the IDs are ordered by descending UUID.

**Call relations**: It uses set_rollout_mtime to create the tie and list_threads_with_sort to test the updated-at ordering path.

*Call graph*: calls 4 internal fn (create_minimal_config, init_mcp, list_threads_with_sort, set_rollout_mtime); 5 external calls (new, create_fake_rollout, rollout_path, assert_eq!, vec!).


##### `thread_list_updated_at_uses_mtime`  (lines 1983–2026)

```
async fn thread_list_updated_at_uses_mtime() -> Result<()>
```

**Purpose**: Checks that the response's updated_at field reflects the rollout file modified time, while created_at still comes from the session timestamp.

**Data flow**: It creates a rollout with one creation time, changes the file modified time to a later date, lists by UpdatedAt, finds the thread, and compares both timestamps.

**Call relations**: It uses set_rollout_mtime before list_threads_with_sort. The test verifies both sorting data and response data come from the right sources.

*Call graph*: calls 4 internal fn (create_minimal_config, init_mcp, list_threads_with_sort, set_rollout_mtime); 6 external calls (new, create_fake_rollout, rollout_path, assert_eq!, parse_from_rfc3339, vec!).


##### `thread_list_archived_filter`  (lines 2029–2087)

```
async fn thread_list_archived_filter() -> Result<()>
```

**Purpose**: Checks that active and archived conversations are separated correctly. Archived sessions live in a special archived folder and should not appear in the normal list.

**Data flow**: It creates one active and one archived rollout, moves the archived file into the archived sessions directory, lists normal threads and then archived threads, and checks each request returns the right ID.

**Call relations**: It uses filesystem operations to simulate archiving, then list_threads with archived unset and archived true to test both views.

*Call graph*: calls 3 internal fn (create_minimal_config, init_mcp, list_threads); 7 external calls (new, create_fake_rollout, rollout_path, assert_eq!, create_dir_all, rename, vec!).


##### `thread_list_invalid_cursor_returns_error`  (lines 2090–2120)

```
async fn thread_list_invalid_cursor_returns_error() -> Result<()>
```

**Purpose**: Checks that a malformed pagination cursor returns a clear invalid request error. This prevents clients from receiving confusing or partial data for a bad cursor.

**Data flow**: It starts the server, sends thread/list with cursor set to not-a-cursor, reads the JSON-RPC error response, and checks both the error code and message.

**Call relations**: It bypasses list_threads because that helper expects a successful response. The direct request lets the test inspect the server's error handling.

*Call graph*: calls 2 internal fn (create_minimal_config, init_mcp); 5 external calls (new, Integer, assert_eq!, timeout, vec!).


### `app-server/tests/suite/v2/thread_loaded_list.rs`

`test` · `test run`

This is a test file for the app server’s thread-listing feature. A “thread” here means a loaded conversation session inside the server. The file checks two important promises: if a client starts a thread, the server can later list that thread’s ID; and if there are multiple loaded threads, the server can return them in pages using a cursor, which is a marker saying “continue after this item.”

Each test builds a temporary, isolated setup so it does not depend on a real user’s files or a real AI provider. It starts a mock responses server that always replies with the assistant message “Done,” writes a small config file pointing the app server at that mock provider, then starts a `TestAppServer`. The tests communicate with the app server using JSON-RPC, a request/response message format where each request has an ID so the test can wait for the matching reply.

The helper `start_thread` starts a new thread and returns its ID. The helper `create_config_toml` writes the temporary configuration needed for the test. Timeouts are used around server reads so a broken server does not make the test hang forever.

#### Function details

##### `thread_loaded_list_returns_loaded_thread_ids`  (lines 19–46)

```
async fn thread_loaded_list_returns_loaded_thread_ids() -> Result<()>
```

**Purpose**: This test proves the basic thread-loaded-list behavior: after one thread is started, asking the server for loaded threads returns that thread’s ID. It protects against regressions where started threads are not registered, not visible through the API, or returned in the wrong response shape.

**Data flow**: The test creates a mock AI server and a temporary config folder, then starts a test app server using that folder. It initializes the server, starts one thread, sends a loaded-thread-list request with default parameters, waits for the matching JSON-RPC response, converts that response into a typed thread-list result, sorts the returned IDs, and checks that the only ID is the one it just created. It also checks that there is no next cursor, because one complete page was enough.

**Call relations**: This is one of the top-level async tests run by the test framework. It calls `create_config_toml` to prepare the server’s settings and `start_thread` to create the thread that should later appear in the list. It then uses the test server’s request and response helpers to exercise the real thread-loaded-list API and uses assertions to confirm the result.

*Call graph*: calls 3 internal fn (new, create_config_toml, start_thread); 6 external calls (new, Integer, default, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_loaded_list_paginates`  (lines 49–100)

```
async fn thread_loaded_list_paginates() -> Result<()>
```

**Purpose**: This test proves that loaded thread IDs can be fetched in pages. That matters when there may be many loaded threads and a client wants to request only a small batch at a time.

**Data flow**: The test starts a mock AI server, writes temporary configuration, initializes a test app server, and creates two threads. It sorts the two expected IDs into the order the API should return. Then it asks for the loaded-thread list with a limit of one item. The first response should contain only the first ID and a next cursor equal to that ID. The test sends a second list request using that cursor, again with a limit of one, and checks that the second response contains the second ID and no further cursor.

**Call relations**: This top-level async test follows the same setup path as the simpler listing test: it calls `create_config_toml` for configuration and `start_thread` twice to create data. It then drives the thread-loaded-list API through two requests, using the first response’s cursor as the input to the second request, which mirrors how a real client would page through results.

*Call graph*: calls 3 internal fn (new, create_config_toml, start_thread); 5 external calls (new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `create_config_toml`  (lines 102–123)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes the small configuration file needed for these tests. It tells the app server to use a mock model provider instead of a real external AI service.

**Data flow**: It receives the path to a temporary Codex home folder and the URI of the mock server. It builds the path to `config.toml`, fills in a TOML configuration string with the mock server’s `/v1` endpoint, and writes that string to disk. The output is either success or an I/O error if the file could not be written.

**Call relations**: Both tests call this helper before starting `TestAppServer`. Without this setup step, the test app server would not know to send model requests to the local mock provider, and the tests would either depend on real network services or fail during initialization.

*Call graph*: called by 2 (thread_loaded_list_paginates, thread_loaded_list_returns_loaded_thread_ids); 3 external calls (join, format!, write).


##### `start_thread`  (lines 125–139)

```
async fn start_thread(mcp: &mut TestAppServer) -> Result<String>
```

**Purpose**: This helper starts a new conversation thread through the test app server and returns the new thread’s ID. The tests use it to create known loaded threads before asking the server to list them.

**Data flow**: It receives a mutable test app server connection. It sends a thread-start request with a chosen model name and default values for the other settings, then waits for the JSON-RPC response whose ID matches that request. It converts the response into a typed thread-start result and returns the thread ID from that result.

**Call relations**: Both thread-list tests call this helper during setup. It hides the repeated request/response steps for creating a thread, so the tests can focus on checking the loaded-thread-list behavior. Internally it hands work to the test server’s `send_thread_start_request` and `read_stream_until_response_message` methods, with a timeout to prevent stalled tests.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_start_request); called by 2 (thread_loaded_list_paginates, thread_loaded_list_returns_loaded_thread_ids); 3 external calls (default, Integer, timeout).


### `app-server/tests/suite/v2/thread_read.rs`

`test` · `test run`

A “thread” here means a saved conversation with Codex. This test file acts like a careful customer: it starts a test app server, creates fake saved conversations, sends the same JSON-RPC requests a real client would send, and checks the answers. JSON-RPC is a simple request-and-response format where each request has an id and either gets a result or an error.

The tests cover the main ways a client looks at past conversations. They check that `thread/read` can return just a summary or include the turns, where a turn is one user interaction and the assistant’s replies. They check paging through turns, both older and newer, like flipping through pages in a diary. They also verify the different “item views”: full content, short summary, or no loaded items.

The file also tests edge cases that are easy to break: archived conversations, newly started threads that do not have a file yet, pathless threads stored only in the experimental thread store, renamed threads, forked threads, rolled-back turns, unsupported APIs, and failed turns. Helper functions append fake events to rollout files, create temporary config files, seed in-memory history, and extract readable text from returned turns.

#### Function details

##### `thread_read_returns_summary_without_turns`  (lines 83–135)

```
async fn thread_read_returns_summary_without_turns() -> Result<()>
```

**Purpose**: Checks that reading a saved thread without asking for turns returns only the thread summary. This protects clients that want a fast overview rather than full conversation contents.

**Data flow**: It creates a temporary Codex home, writes test config, creates a fake rollout file with one user message, starts the test server, and sends `thread/read` with `include_turns` set to false. The response should contain metadata such as id, preview, provider, path, source, and status, but an empty turns list.

**Call relations**: The async test runner calls this test. Inside the test, setup helpers create the fake model server, config, and rollout, then `TestAppServer` sends the read request and the response is decoded for assertions.

*Call graph*: calls 3 internal fn (new, new, create_config_toml); 7 external calls (new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout).


##### `thread_read_can_include_turns`  (lines 138–197)

```
async fn thread_read_can_include_turns() -> Result<()>
```

**Purpose**: Checks that `thread/read` can include the actual conversation turns when requested. It proves that saved user text and text annotations survive the read path.

**Data flow**: It creates a fake saved conversation with one user message and text element data, starts the server, and sends `thread/read` with `include_turns` set to true. The output is expected to contain one completed turn with a full item view and the original user message content.

**Call relations**: The test runner invokes it. It relies on the fake rollout helper for stored history and on `TestAppServer` request helpers to exercise the real app-server read endpoint.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, assert_eq!, panic!, timeout, vec!).


##### `thread_turns_list_can_page_backward_and_forward`  (lines 200–286)

```
async fn thread_turns_list_can_page_backward_and_forward() -> Result<()>
```

**Purpose**: Checks that `thread/turns/list` supports paging through a conversation in both directions. This matters for user interfaces that load a few turns at a time instead of loading the whole history.

**Data flow**: It creates a rollout with three user messages, asks for the newest two turns in descending order, then uses the returned cursor to fetch older history. After appending a fourth message, it uses the backwards cursor to fetch newer turns. The returned text order must match the requested direction.

**Call relations**: The test runner calls this test. The test uses `append_user_message` to grow the rollout file and `turn_user_texts` to turn returned structured items into simple strings for comparison.

*Call graph*: calls 3 internal fn (new, append_user_message, create_config_toml); 9 external calls (new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, rollout_path, assert!, assert_eq!, timeout, vec!).


##### `thread_turns_list_supports_requested_items_view`  (lines 289–354)

```
async fn thread_turns_list_supports_requested_items_view() -> Result<()>
```

**Purpose**: Checks that callers can choose how much detail to receive for each turn. This lets clients trade detail for speed, much like choosing between a full article, a summary, or just a headline.

**Data flow**: It creates one turn containing a user message and two assistant messages, then asks for the same turn using full, summary, and not-loaded views. The full view should include all assistant text, the summary should keep the user text and final assistant text, and the not-loaded view should keep metadata while omitting items.

**Call relations**: The test runner invokes it. It appends assistant messages with `append_agent_message`, fetches the turn through `read_single_turn_items_view`, and uses `turn_user_texts` and `turn_agent_texts` to verify what came back.

*Call graph*: calls 4 internal fn (new, append_agent_message, create_config_toml, read_single_turn_items_view); 8 external calls (new, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, rollout_path, assert!, assert_eq!, timeout, vec!).


##### `thread_turns_list_reads_store_history_without_rollout_path`  (lines 357–422)

```
async fn thread_turns_list_reads_store_history_without_rollout_path() -> Result<()>
```

**Purpose**: Checks that turn listing works for a thread that exists only in the thread store and has no rollout file path. This protects newer storage modes where history is not necessarily backed by a local file.

**Data flow**: It writes config pointing at an in-memory thread store, seeds that store with one pathless thread and one history item, starts the in-process app server, and sends `thread/turns/list`. The response should contain the stored user message.

**Call relations**: The test runner calls it. It uses `create_config_toml_with_thread_store` to enable the in-memory store, `seed_pathless_store_thread` to create data, and starts the server directly through the in-process API rather than the higher-level test wrapper.

*Call graph*: calls 9 internal fn (start, create_config_toml_with_thread_store, seed_pathless_store_thread, default, without_managed_config_for_tests, default_for_tests, new, from_string, for_id); 10 external calls (new, default, new, new_v4, new, Integer, default, assert_eq!, default, from_value).


##### `thread_read_loaded_include_turns_reads_store_history_without_rollout_path`  (lines 425–506)

```
async fn thread_read_loaded_include_turns_reads_store_history_without_rollout_path() -> Result<()>
```

**Purpose**: Checks that a loaded thread with no rollout file can still return stored turns when `thread/read` includes turns. This prevents an active in-memory-store thread from appearing empty just because it has no file.

**Data flow**: It configures an in-memory thread store, starts the app server, starts a new thread, appends a stored history item to that thread, and then reads the thread with `include_turns` true. The final thread object should include the stored user message.

**Call relations**: The test runner invokes it. It uses `create_config_toml_with_thread_store` for setup and `store_history_items` to produce the same stored event data used by other pathless-store tests.

*Call graph*: calls 9 internal fn (start, create_config_toml_with_thread_store, store_history_items, default, without_managed_config_for_tests, default_for_tests, new, from_string, for_id); 10 external calls (new, default, new, new_v4, new, Integer, default, assert_eq!, default, from_value).


##### `thread_list_includes_store_thread_without_rollout_path`  (lines 509–585)

```
async fn thread_list_includes_store_thread_without_rollout_path() -> Result<()>
```

**Purpose**: Checks that `thread/list` includes threads that live only in the thread store and have no rollout file. This ensures the conversation list does not silently hide pathless stored threads.

**Data flow**: It creates a temporary config with an in-memory store, seeds a pathless thread with history and a name, starts the server, and asks for the thread list. The result should contain exactly that thread, with no path, an empty preview, and the stored name.

**Call relations**: The test runner calls it. The setup flows through `create_config_toml_with_thread_store` and `seed_pathless_store_thread`, then the test talks to the in-process app-server client.

*Call graph*: calls 9 internal fn (start, create_config_toml_with_thread_store, seed_pathless_store_thread, default, without_managed_config_for_tests, default_for_tests, new, from_string, for_id); 10 external calls (new, default, new, new_v4, new, Integer, default, assert_eq!, default, from_value).


##### `thread_read_can_return_archived_threads_by_id`  (lines 588–633)

```
async fn thread_read_can_return_archived_threads_by_id() -> Result<()>
```

**Purpose**: Checks that `thread/read` can find a saved thread after its rollout file has been moved into the archived sessions folder. This matters because archived conversations should still be readable by id.

**Data flow**: It creates a saved rollout, moves its file from the active session location into the archive directory, starts the server, and reads by the original thread id. The returned thread should have the same id and preview, and its path should point to the archived file.

**Call relations**: The test runner invokes it. It uses the rollout path helper to find the file, filesystem calls to move it, and `TestAppServer` to verify the app server searches archived storage.

*Call graph*: calls 2 internal fn (new, create_config_toml); 10 external calls (new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, rollout_path, assert_eq!, create_dir_all, rename, timeout, vec!).


##### `thread_resume_initial_turns_page_matches_requested_turns_list_page`  (lines 636–704)

```
async fn thread_resume_initial_turns_page_matches_requested_turns_list_page() -> Result<()>
```

**Purpose**: Checks that resuming a thread can include an initial page of turns that exactly matches what `thread/turns/list` would return. This keeps resume behavior consistent with normal paging.

**Data flow**: It creates a three-turn conversation, asks `thread/turns/list` for the first two turns in ascending order with items not loaded, then resumes the same thread with the same initial-page settings. The resume response should contain no inline turns on the thread itself and should include the same page separately.

**Call relations**: The test runner calls it. It uses `append_user_message` to create extra turns, compares a normal list response with the page returned by the resume endpoint, and relies on protocol conversion into a shared turns-page shape.

*Call graph*: calls 3 internal fn (new, append_user_message, create_config_toml); 10 external calls (default, new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, rollout_path, assert!, assert_eq!, timeout, vec!).


##### `thread_turns_list_rejects_cursor_when_anchor_turn_is_rolled_back`  (lines 707–775)

```
async fn thread_turns_list_rejects_cursor_when_anchor_turn_is_rolled_back() -> Result<()>
```

**Purpose**: Checks that paging fails clearly if the cursor points to a turn that has since been removed by rollback. This avoids returning confusing or incorrect history after conversation edits.

**Data flow**: It creates three turns, requests a page to obtain a backwards cursor anchored at the newest turn, then appends a rollback event that removes that anchor turn. A later paging request using the old cursor should return an error saying the anchor turn is no longer present.

**Call relations**: The test runner invokes it. It uses `append_user_message` to build the history, `append_thread_rollback` to simulate removal, and the app server’s error stream to confirm the rejection.

*Call graph*: calls 4 internal fn (new, append_thread_rollback, append_user_message, create_config_toml); 8 external calls (new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, rollout_path, assert_eq!, timeout, vec!).


##### `thread_read_returns_forked_from_id_for_forked_threads`  (lines 778–825)

```
async fn thread_read_returns_forked_from_id_for_forked_threads() -> Result<()>
```

**Purpose**: Checks that when a thread is forked from another thread, reading the fork reports the original thread id. This lets clients show lineage, such as “this conversation was branched from that one.”

**Data flow**: It creates a saved thread, starts the server, sends a `thread/fork` request, then reads the newly forked thread. The read response should include `forked_from_id` equal to the original thread id.

**Call relations**: The test runner calls it. The fake rollout provides the source thread, the fork request creates a new thread, and the read request verifies that the relationship is preserved in the server response.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (default, new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, assert_eq!, timeout, vec!).


##### `thread_read_loaded_thread_returns_precomputed_path_before_materialization`  (lines 828–874)

```
async fn thread_read_loaded_thread_returns_precomputed_path_before_materialization() -> Result<()>
```

**Purpose**: Checks that a newly started thread reports its planned rollout path even before the file exists. This gives clients a stable path value without forcing the server to write an empty history file.

**Data flow**: It starts a new thread, confirms the reported rollout path does not yet exist on disk, then reads the thread without turns. The read response should return the same path, no preview, no turns, and an idle status.

**Call relations**: The test runner invokes it. It sets up a mock model server and config, then uses `TestAppServer` to start and read a live but not-yet-materialized thread.

*Call graph*: calls 2 internal fn (new, create_config_toml); 7 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout).


##### `thread_name_set_is_reflected_in_read_list_and_resume`  (lines 877–1032)

```
async fn thread_name_set_is_reflected_in_read_list_and_resume() -> Result<()>
```

**Purpose**: Checks that setting a user-facing thread name is visible everywhere clients expect it: read, list, resume, and notifications. It also verifies that the serialized network payload includes the `name` and `ephemeral` fields.

**Data flow**: It creates a saved thread, sends `thread/set/name`, waits for a name-updated notification, then reads, lists, and resumes the thread. Each response should contain the new name, and the raw JSON should include both the name and the non-ephemeral flag.

**Call relations**: The test runner calls it. It uses the standard fake rollout and mock server setup, then follows the full client story: rename, receive notification, read details, view in list, and resume.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (default, new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, assert_eq!, from_value, timeout, vec!).


##### `thread_read_include_turns_rejects_unmaterialized_loaded_thread`  (lines 1035–1083)

```
async fn thread_read_include_turns_rejects_unmaterialized_loaded_thread() -> Result<()>
```

**Purpose**: Checks that `thread/read` with turns is rejected for a newly started thread before the first user message has created real history. This prevents the server from pretending to load turns from a file that does not exist yet.

**Data flow**: It starts a new thread, confirms its rollout path has not been materialized on disk, and then sends `thread/read` with `include_turns` true. The expected output is an error message explaining that turns are unavailable before the first user message.

**Call relations**: The test runner invokes it. The server is started through `TestAppServer`, and the test listens on the error response path rather than the normal result path.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, timeout).


##### `thread_turns_list_rejects_unmaterialized_loaded_thread`  (lines 1086–1137)

```
async fn thread_turns_list_rejects_unmaterialized_loaded_thread() -> Result<()>
```

**Purpose**: Checks that `thread/turns/list` is rejected for a new thread that has not yet written its first user message. This makes the turn-list API honest about there being no readable stored history yet.

**Data flow**: It starts a fresh thread, verifies its rollout file does not exist, and sends `thread/turns/list`. The response should be an error explaining that turn listing is unavailable before the first user message.

**Call relations**: The test runner calls it. It follows the same live-thread setup as the read rejection test, but exercises the separate turn-list endpoint.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, timeout).


##### `thread_turns_items_list_returns_unsupported`  (lines 1140–1170)

```
async fn thread_turns_items_list_returns_unsupported() -> Result<()>
```

**Purpose**: Checks that the not-yet-implemented `thread/turns/items/list` endpoint returns the standard “method not found” style error. This gives clients a clear signal instead of a vague failure.

**Data flow**: It starts the test server and sends a `thread/turns/items/list` request with dummy thread and turn ids. The response should be an error with code `-32601` and a message saying the endpoint is not supported yet.

**Call relations**: The test runner invokes it. It uses normal server initialization but does not need real conversation data because it is testing endpoint availability.

*Call graph*: calls 2 internal fn (new, create_config_toml); 5 external calls (new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_read_reports_system_error_idle_flag_after_failed_turn`  (lines 1173–1238)

```
async fn thread_read_reports_system_error_idle_flag_after_failed_turn() -> Result<()>
```

**Purpose**: Checks that a thread whose assistant turn failed is reported with a system-error status when read afterward. This helps clients show that the conversation is not simply idle; it ended in an error.

**Data flow**: It starts a mock response server that returns a simulated failure, starts a thread, begins a turn with user input, waits for an error notification, and then reads the thread summary. The returned thread status should be `SystemError`.

**Call relations**: The test runner calls it. It uses response-test helpers to mount a failing server-sent-events response, then drives the app server through start, turn-start, error notification, and read.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once, sse_failed, start_mock_server); 6 external calls (default, new, Integer, assert_eq!, timeout, vec!).


##### `append_user_message`  (lines 1240–1256)

```
fn append_user_message(path: &Path, timestamp: &str, text: &str) -> std::io::Result<()>
```

**Purpose**: Adds a fake user-message event to an existing rollout file. Tests use it to build multi-turn saved conversations without going through the full live app flow.

**Data flow**: It receives a file path, timestamp, and message text. It opens the file in append mode and writes one JSON line describing a user message with no text elements or images; the function returns success or an I/O error.

**Call relations**: Paging and resume tests call this helper when they need extra user turns after the initial fake rollout. It hands the modified file back implicitly by writing directly to disk.

*Call graph*: called by 3 (thread_resume_initial_turns_page_matches_requested_turns_list_page, thread_turns_list_can_page_backward_and_forward, thread_turns_list_rejects_cursor_when_anchor_turn_is_rolled_back); 2 external calls (new, writeln!).


##### `append_agent_message`  (lines 1258–1274)

```
fn append_agent_message(path: &Path, timestamp: &str, text: &str) -> anyhow::Result<()>
```

**Purpose**: Adds a fake assistant-message event to a rollout file. This lets tests check how full and summary item views treat assistant replies.

**Data flow**: It receives a file path, timestamp, and assistant text. It opens the file, serializes an `AgentMessageEvent` into JSON, writes it as one rollout line, and returns success or an error.

**Call relations**: The items-view test calls it to add draft and final assistant messages. The server later reads those rollout lines when `read_single_turn_items_view` asks for the turn.

*Call graph*: called by 1 (thread_turns_list_supports_requested_items_view); 2 external calls (new, writeln!).


##### `append_thread_rollback`  (lines 1276–1290)

```
fn append_thread_rollback(path: &Path, timestamp: &str, num_turns: u32) -> std::io::Result<()>
```

**Purpose**: Adds a fake rollback event to a rollout file. A rollback means recent turns were removed from the conversation history.

**Data flow**: It receives a file path, timestamp, and number of turns to roll back. It appends one JSON line saying the thread was rolled back by that count, then returns success or an I/O error.

**Call relations**: The cursor-rejection test calls this after obtaining a paging cursor. The server then sees the rollback when the next paging request tries to use a cursor anchored to removed history.

*Call graph*: called by 1 (thread_turns_list_rejects_cursor_when_anchor_turn_is_rolled_back); 2 external calls (new, writeln!).


##### `read_single_turn_items_view`  (lines 1292–1315)

```
async fn read_single_turn_items_view(
    mcp: &mut TestAppServer,
    thread_id: &str,
    items_view: Option<TurnItemsView>,
) -> anyhow::Result<codex_app_server_protocol::Turn>
```

**Purpose**: Requests the first page of turns for one thread and returns the single turn it expects to find. It is a small test helper for comparing different item-detail modes.

**Data flow**: It receives a mutable test server connection, a thread id, and an optional item view. It sends `thread/turns/list`, waits for the matching response, decodes the page, checks there is exactly one turn, removes that turn from the list, and returns it.

**Call relations**: The requested-items-view test calls this three times, once for each view. It delegates the real work to `TestAppServer` request and stream-reading helpers.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_turns_list_request); called by 1 (thread_turns_list_supports_requested_items_view); 3 external calls (Integer, assert_eq!, timeout).


##### `turn_user_texts`  (lines 1317–1331)

```
fn turn_user_texts(turns: &[codex_app_server_protocol::Turn]) -> Vec<&str>
```

**Purpose**: Extracts the first user text from each returned turn, ignoring turns whose first item is not a text user message. This makes assertions easier to read.

**Data flow**: It receives a slice of returned turns. It walks through them, looks at each first item, keeps the text when that item is a text user message, and returns a vector of borrowed string slices.

**Call relations**: Several tests use this helper after reading or listing turns. It does not call server code; it only simplifies protocol objects into plain text for comparisons.

*Call graph*: 1 external calls (iter).


##### `turn_agent_texts`  (lines 1333–1342)

```
fn turn_agent_texts(turns: &[codex_app_server_protocol::Turn]) -> Vec<&str>
```

**Purpose**: Extracts assistant-message text from returned turns. Tests use it to confirm whether assistant replies are included or summarized as expected.

**Data flow**: It receives a slice of turns, walks through every item in every turn, keeps the text from assistant-message items, and returns those texts as borrowed string slices.

**Call relations**: The requested-items-view test uses it to compare full and summary views. Like `turn_user_texts`, it is a local assertion helper.

*Call graph*: 1 external calls (iter).


##### `InMemoryThreadStoreId::drop`  (lines 1349–1351)

```
fn drop(&mut self)
```

**Purpose**: Cleans up a named in-memory thread store when the test guard goes out of scope. This prevents one test’s temporary store data from leaking into another test.

**Data flow**: It reads the stored `store_id` from the guard object and asks `InMemoryThreadStore` to remove that id. It does not return a value; the side effect is cleanup.

**Call relations**: Tests create an `InMemoryThreadStoreId` value after choosing a store id. Rust automatically calls this `drop` method at the end of the scope, making cleanup automatic.

*Call graph*: calls 1 internal fn (remove_id).


##### `seed_pathless_store_thread`  (lines 1354–1393)

```
async fn seed_pathless_store_thread(
    store: &InMemoryThreadStore,
    thread_id: codex_protocol::ThreadId,
) -> Result<()>
```

**Purpose**: Creates a complete test thread directly inside the in-memory thread store, without any rollout file path. It gives pathless-store tests realistic data to read and list.

**Data flow**: It receives a store and thread id. It creates thread metadata, appends the standard test history item from `store_history_items`, sets a thread name through a metadata update, and returns success or an error.

**Call relations**: The pathless turn-list and thread-list tests call this before starting or querying the server. It uses store methods for creation, item append, and metadata update.

*Call graph*: calls 5 internal fn (store_history_items, default, append_items, create_thread, update_thread_metadata); called by 2 (thread_list_includes_store_thread_without_rollout_path, thread_turns_list_reads_store_history_without_rollout_path); 2 external calls (default, new).


##### `store_history_items`  (lines 1395–1406)

```
fn store_history_items() -> Vec<RolloutItem>
```

**Purpose**: Builds the standard one-message history used by the in-memory thread-store tests. Keeping it in one helper makes those tests expect the same content.

**Data flow**: It creates a vector containing one rollout item: a user message with the text `history from store` and no images or text elements. The vector is returned to the caller.

**Call relations**: Both `seed_pathless_store_thread` and the loaded-thread store-history test call this helper before appending items to the in-memory store.

*Call graph*: called by 2 (seed_pathless_store_thread, thread_read_loaded_include_turns_reads_store_history_without_rollout_path); 1 external calls (vec!).


##### `create_config_toml_with_thread_store`  (lines 1408–1430)

```
fn create_config_toml_with_thread_store(codex_home: &Path, store_id: &str) -> std::io::Result<()>
```

**Purpose**: Writes a temporary `config.toml` that enables the experimental in-memory thread store. Tests use it when they need storage that is not based on rollout files.

**Data flow**: It receives a Codex home directory and store id, builds a TOML configuration string with a mock model provider and the in-memory store id, and writes it to `config.toml`. It returns success or a filesystem error.

**Call relations**: The pathless-store tests call this during setup before building config or starting the server. The resulting file is what tells the app server to use the named in-memory store.

*Call graph*: called by 3 (thread_list_includes_store_thread_without_rollout_path, thread_read_loaded_include_turns_reads_store_history_without_rollout_path, thread_turns_list_reads_store_history_without_rollout_path); 3 external calls (join, format!, write).


##### `create_config_toml`  (lines 1433–1454)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes a temporary `config.toml` pointing the app server at a mock model server. Most tests use it to run the server safely without contacting a real model provider.

**Data flow**: It receives a Codex home directory and mock server URI, builds a TOML config with a mock model, read-only sandbox, no approval prompts, and response-stream settings, then writes it to disk. It returns success or an I/O error.

**Call relations**: Most thread-read, list, resume, fork, name, and error-status tests call this before starting `TestAppServer`. The mock server URI it writes becomes the endpoint used by the app server during the test.

*Call graph*: called by 14 (thread_name_set_is_reflected_in_read_list_and_resume, thread_read_can_include_turns, thread_read_can_return_archived_threads_by_id, thread_read_include_turns_rejects_unmaterialized_loaded_thread, thread_read_loaded_thread_returns_precomputed_path_before_materialization, thread_read_reports_system_error_idle_flag_after_failed_turn, thread_read_returns_forked_from_id_for_forked_threads, thread_read_returns_summary_without_turns, thread_resume_initial_turns_page_matches_requested_turns_list_page, thread_turns_items_list_returns_unsupported (+4 more)); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/thread_resume.rs`

`test` · `test suite`

A “thread” here is a saved conversation between a user and the Codex coding agent. Resuming a thread is like reopening a project notebook: the server must find the right saved file, rebuild the conversation view, reconnect to any still-running work, and avoid changing history just because someone looked at it. This test file exercises those promises from the outside by starting a real test app server, pointing it at fake model servers, creating temporary rollout files (the saved conversation logs), and sending the same JSON-RPC requests a real client would send. JSON-RPC is a request/response protocol where messages name a method and carry JSON data.

The tests cover many edge cases. They verify that empty or archived histories are rejected correctly, that resuming can return full history or metadata only, that token usage is replayed at the right time, and that interrupted turns are shown as interrupted. They also check goal behavior, analytics events, Git metadata, cloud configuration errors, required MCP server failures, and pending approval prompts. MCP means “Model Context Protocol,” a way for the agent to call external tools. Some tests use two app-server clients to prove that reconnecting to a running thread does not stop the in-flight turn. Without these tests, small changes to resume logic could silently corrupt saved sessions, leak sensitive tool payloads to remote clients, or make reconnecting clients lose important state.

#### Function details

##### `normalized_existing_path`  (lines 114–116)

```
fn normalized_existing_path(path: impl AsRef<Path>) -> Result<PathBuf>
```

**Purpose**: This helper turns an existing path into its fully resolved absolute form. It is used when a test needs to compare paths fairly, even if one path contains shortcuts such as `.` or platform-specific prefixes.

**Data flow**: It receives a path, asks the operating system for the path’s canonical location, wraps it in the project’s absolute-path type, and returns a normal path buffer. If the path does not exist or cannot be represented as an absolute path, it returns an error.

**Call relations**: The updated-at resume test calls this before sending a resume request by path. It helps that test prove the server accepts a real rollout file path rather than being confused by path spelling.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 1 (thread_resume_defers_updated_at_until_turn_start); 1 external calls (as_ref).


##### `wait_for_responses_request_count`  (lines 118–146)

```
async fn wait_for_responses_request_count(
    server: &wiremock::MockServer,
    expected_count: usize,
) -> Result<()>
```

**Purpose**: This helper waits until the fake model server has received exactly a requested number of `/responses` calls. It protects approval-flow tests from racing ahead before the server has actually continued the model conversation.

**Data flow**: It receives a mock HTTP server and an expected count. It repeatedly reads recorded requests, counts POST requests ending in `/responses`, sleeps briefly while the count is too low, fails if the count becomes too high, and returns success when the count matches.

**Call relations**: The command-approval and file-change-approval resume tests use this after approving a replayed request. It confirms that the app server made the expected model calls before the test ends.

*Call graph*: called by 2 (thread_resume_replays_pending_command_execution_request_approval, thread_resume_replays_pending_file_change_request_approval); 5 external calls (received_requests, bail!, from_millis, sleep, timeout).


##### `thread_resume_rejects_unmaterialized_thread`  (lines 149–193)

```
async fn thread_resume_rejects_unmaterialized_thread() -> Result<()>
```

**Purpose**: This test proves that a newly started thread cannot be resumed before it has any saved rollout file. A thread must first be “materialized,” meaning written to disk by a user turn.

**Data flow**: It starts a test server, creates a thread, and immediately asks to resume that thread. The expected result is an error message saying no rollout was found, rather than a fake or empty resumed conversation.

**Call relations**: The async test runner invokes it as part of the resume suite. It uses the common config helper and fake repeating model server to set up a normal app-server environment.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, timeout).


##### `thread_resume_with_empty_path_uses_running_thread_id`  (lines 196–258)

```
async fn thread_resume_with_empty_path_uses_running_thread_id() -> Result<()>
```

**Purpose**: This test checks that an explicitly empty path does not override a valid running thread id. The server should treat the thread id as the source of truth in that case.

**Data flow**: It starts and materializes a thread, then sends a resume request with the same thread id and an empty path value. The response should resume the original thread and return the same id.

**Call relations**: The test runner calls it directly. It depends on the normal config helper and fake model server, then exercises thread start, turn start, and thread resume in sequence.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (default, new, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout, vec!).


##### `thread_resume_running_thread_uses_cached_instruction_sources`  (lines 261–334)

```
async fn thread_resume_running_thread_uses_cached_instruction_sources() -> Result<()>
```

**Purpose**: This test verifies that resuming an already loaded thread reports the instruction files that were discovered when the thread started. It matters because those files may be deleted later, but the thread’s setup should remain understandable.

**Data flow**: It creates a workspace with an `AGENTS.md` instruction file, starts a thread there, materializes it, deletes the instruction file, and resumes the thread. The resume response should still list the original instruction source path.

**Call relations**: The test runner invokes it. It uses the app server like a client would and checks that cached startup data survives through resume.

*Call graph*: calls 3 internal fn (new, create_config_toml, try_from); 9 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, remove_file, write, timeout, vec!).


##### `turn_start_updates_runtime_workspace_roots_for_loaded_thread`  (lines 337–411)

```
async fn turn_start_updates_runtime_workspace_roots_for_loaded_thread() -> Result<()>
```

**Purpose**: This test checks that a turn can update the runtime workspace roots remembered for a thread. Runtime workspace roots are directories the running agent is allowed to treat as active workspaces.

**Data flow**: It starts a thread, sends a turn with two equivalent forms of the same extra workspace root, waits for completion, and resumes metadata only. The resumed thread should contain one normalized root, not duplicates.

**Call relations**: The test runner calls it. It links turn-start behavior to later resume behavior by proving that information provided during a turn is persisted for resumed clients.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, create_dir_all, timeout, vec!).


##### `thread_goal_get_rejects_unmaterialized_thread`  (lines 414–465)

```
async fn thread_goal_get_rejects_unmaterialized_thread() -> Result<()>
```

**Purpose**: This test proves that ephemeral, unmaterialized threads cannot use thread goals. A goal is a persistent objective for the agent, so it needs a durable thread behind it.

**Data flow**: It enables the goals feature in config, starts an ephemeral thread, and sends a raw `thread/goal/get` request. The expected output is an error explaining that ephemeral threads do not support goals.

**Call relations**: The test runner invokes it. It uses the unmanaged-config app server path so the test can edit the config file directly before startup.

*Call graph*: calls 2 internal fn (new_without_managed_config, create_config_toml); 9 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, json!, read_to_string, write, timeout).


##### `thread_resume_tracks_thread_initialized_analytics`  (lines 468–523)

```
async fn thread_resume_tracks_thread_initialized_analytics() -> Result<()>
```

**Purpose**: This test checks that resuming a saved thread emits the expected analytics event. Analytics here are privacy-conscious telemetry events that help the product understand how threads are used.

**Data flow**: It creates a fake saved rollout, edits its thread source to `user`, starts the server with analytics capture, resumes the thread, and reads the analytics payload. The event should identify the thread as resumed and preserve the user source.

**Call relations**: The test runner calls it. It relies on `set_thread_source_on_fake_rollout` to adjust the fixture and on analytics helpers from the sibling analytics test module to inspect the captured event.

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

**Purpose**: This helper edits the first line of a fake rollout file so its saved metadata says where the thread came from. It lets analytics tests simulate a thread created by a user or another source.

**Data flow**: It receives the Codex home directory, rollout timestamp, thread id, and desired source string. It opens the rollout file, parses the session metadata JSON, changes `thread_source`, and writes the file back with the remaining history unchanged.

**Call relations**: The analytics resume test calls this before starting the app server. It prepares the saved history so resume can read the source naturally from disk.

*Call graph*: called by 1 (thread_resume_tracks_thread_initialized_analytics); 6 external calls (rollout_path, format!, from_str, json!, read_to_string, write).


##### `thread_resume_returns_rollout_history`  (lines 545–616)

```
async fn thread_resume_returns_rollout_history() -> Result<()>
```

**Purpose**: This test proves that resuming a saved rollout rebuilds the thread’s visible history and metadata. It checks that a client reopening a conversation sees the same user message and thread details.

**Data flow**: It creates a fake rollout with a saved user message and text element metadata, resumes it, and inspects the returned thread. The output should include the thread id, preview, provider, path, status, and one completed turn containing the user message.

**Call relations**: The test runner invokes it. It uses fake rollout support to create disk history, then verifies the app server’s resume response matches that history.

*Call graph*: calls 2 internal fn (new, create_config_toml); 10 external calls (default, new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, panic!, timeout, vec!).


##### `thread_resume_redacts_payloads_for_chatgpt_remote_clients`  (lines 619–716)

```
async fn thread_resume_redacts_payloads_for_chatgpt_remote_clients() -> Result<()>
```

**Purpose**: This test checks a privacy rule: ChatGPT mobile remote clients should not receive sensitive MCP tool payloads or image-generation contents when resuming. Normal clients should still receive the full data.

**Data flow**: It runs the same resume fixture for Android remote, iOS remote, and a non-remote client. For remote clients, MCP arguments and results should be replaced with `[redacted]` and image-generation items should be omitted; for the normal client, original secret values should remain.

**Call relations**: The test runner calls it. It delegates setup to `resume_redaction_fixture`, which creates the saved history with sensitive tool and image events.

*Call graph*: calls 1 internal fn (resume_redaction_fixture); 3 external calls (assert!, assert_eq!, unreachable!).


##### `resume_redaction_fixture`  (lines 718–772)

```
async fn resume_redaction_fixture(client_name: Option<&str>) -> Result<ThreadResumeResponse>
```

**Purpose**: This helper builds and resumes a saved thread containing sensitive MCP and image-generation history. It is parameterized by client name so tests can compare remote-client and normal-client behavior.

**Data flow**: It creates a fake rollout, appends sensitive events, starts a test app server either with default client info or a supplied client name, and sends a resume request asking for full initial turn items. It returns the parsed resume response.

**Call relations**: The redaction test calls this several times. It hands off fixture construction to `append_resume_redaction_history` before exercising the app server’s resume path.

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

**Purpose**: This helper adds sensitive MCP tool-call and image-generation events to a fake rollout file. It creates the data needed to verify that resume redacts or preserves payloads correctly.

**Data flow**: It receives a Codex home path, rollout timestamp, metadata timestamp, and conversation id. It reads the existing rollout, serializes two extra event records with secret-looking fields, appends them, and writes the file back.

**Call relations**: `resume_redaction_fixture` calls it while preparing the redaction scenario. The app server later reads the appended events during resume.

*Call graph*: called by 1 (resume_redaction_fixture); 10 external calls (from_millis, rollout_path, test_absolute_path, format!, json!, ImageGenerationEnd, McpToolCallEnd, read_to_string, write, vec!).


##### `thread_resume_can_skip_turns_for_metadata_only_resume`  (lines 830–866)

```
async fn thread_resume_can_skip_turns_for_metadata_only_resume() -> Result<()>
```

**Purpose**: This test proves that a client can resume only thread metadata without loading full turn history. That is useful for list views or lightweight reconnects.

**Data flow**: It creates a fake rollout with one user message, resumes it with `exclude_turns` enabled, and checks the returned thread. The thread id should match, but the turns list should be empty.

**Call relations**: The test runner invokes it. It uses the same fake rollout machinery as full-history tests but asks the server for a smaller response.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (default, new, new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout).


##### `thread_resume_rejects_archived_session_by_id`  (lines 869–917)

```
async fn thread_resume_rejects_archived_session_by_id() -> Result<()>
```

**Purpose**: This test ensures archived sessions cannot be resumed as if they were active. Archived sessions live in a separate location and require an explicit unarchive action first.

**Data flow**: It creates a fake rollout, moves its file into the archived sessions folder, and tries to resume by id. The expected output is an error that names the session as archived and suggests an unarchive command.

**Call relations**: The test runner calls it. It directly manipulates the filesystem to simulate a previously archived session before exercising resume.

*Call graph*: calls 2 internal fn (new, create_config_toml); 11 external calls (default, new, new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, rollout_path, assert!, create_dir_all, rename (+1 more)).


##### `thread_resume_keeps_paused_goal_paused`  (lines 920–1022)

```
async fn thread_resume_keeps_paused_goal_paused() -> Result<()>
```

**Purpose**: This test checks that resuming a thread with a paused goal does not automatically restart agent work. A paused goal should stay paused until the user changes it.

**Data flow**: It enables goals, materializes a thread, sets a goal with paused status, clears buffered messages, and resumes the thread. The server should send a goal-updated notification showing `Paused` and should not send a new turn-started notification.

**Call relations**: The test runner invokes it. It combines raw goal API requests with resume to prove goal state is restored without triggering continuation.

*Call graph*: calls 2 internal fn (new_without_managed_config, create_config_toml); 13 external calls (default, new, bail!, Integer, create_mock_responses_server_repeating_assistant, to_response, assert!, assert_eq!, json!, read_to_string (+3 more)).


##### `thread_goal_set_preserves_budget_limited_same_objective`  (lines 1025–1121)

```
async fn thread_goal_set_preserves_budget_limited_same_objective() -> Result<()>
```

**Purpose**: This test verifies that setting the same goal objective again does not reset a budget-limited goal. Budget-limited means the goal has already used its allowed token budget.

**Data flow**: It enables goals, materializes a thread, sets a goal as budget-limited with a token budget, then sets the same objective again without a status. The resulting goal should remain budget-limited and keep its budget and usage counters.

**Call relations**: The test runner calls it. It focuses on the goal-setting API but uses a real materialized thread because goals are stored with threads.

*Call graph*: calls 2 internal fn (new_without_managed_config, create_config_toml); 11 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, to_response, assert_eq!, json!, read_to_string, write, timeout (+1 more)).


##### `thread_goal_set_persists_resumable_stopped_statuses`  (lines 1124–1208)

```
async fn thread_goal_set_persists_resumable_stopped_statuses() -> Result<()>
```

**Purpose**: This test checks that stopped-but-resumable goal statuses are accepted and broadcast correctly. The statuses under test are blocked and usage-limited.

**Data flow**: It enables goals, materializes a thread, then loops through two wire-format statuses. For each one, it sets the goal and confirms both the response and notification contain the expected internal status.

**Call relations**: The test runner invokes it. It exercises raw goal-set requests and checks the notification stream from the app server.

*Call graph*: calls 2 internal fn (new_without_managed_config, create_config_toml); 12 external calls (default, new, bail!, Integer, create_mock_responses_server_repeating_assistant, to_response, assert_eq!, json!, read_to_string, write (+2 more)).


##### `thread_goal_set_edits_objective_without_resetting_usage`  (lines 1211–1317)

```
async fn thread_goal_set_edits_objective_without_resetting_usage() -> Result<()>
```

**Purpose**: This test proves that editing a goal’s wording does not wipe out usage accounting or create a new goal record. This protects long-running goal progress from accidental reset.

**Data flow**: It creates a fake thread, sets an active goal with a token budget, directly records time and token usage in the state database, then edits the objective text. The response and database should keep the same goal id, original creation time, and accumulated usage, while the edited objective is returned.

**Call relations**: The test runner calls it. It uses `StateRuntime` directly to simulate stored usage, then verifies the public goal API respects that stored state.

*Call graph*: calls 4 internal fn (new_without_managed_config, create_config_toml, from_string, init); 10 external calls (new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, to_response, assert_eq!, json!, read_to_string, write, timeout).


##### `thread_goal_lifecycle_emits_analytics_and_clear_deletes_goal`  (lines 1320–1511)

```
async fn thread_goal_lifecycle_emits_analytics_and_clear_deletes_goal() -> Result<()>
```

**Purpose**: This test covers the full goal lifecycle: create, account usage, become budget-limited, clear, and confirm deletion. It also verifies analytics events do not leak the private goal objective or budget value.

**Data flow**: It enables goals and analytics, materializes a thread, sets a goal with a token budget, waits for model-driven continuation to consume tokens, checks created/usage/status analytics events, clears the goal, checks the cleared event, then confirms `goal/get` returns no goal and clearing again reports nothing was cleared.

**Call relations**: The test runner invokes it. It uses analytics helpers to observe telemetry and the fake model server to produce token usage that drives the goal into a budget-limited state.

*Call graph*: calls 4 internal fn (new_without_managed_config, mount_analytics_capture, wait_for_goal_event, create_config_toml_with_chatgpt_base_url); 12 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert!, assert_eq!, json!, read_to_string, write (+2 more)).


##### `thread_resume_emits_restored_token_usage_before_next_turn`  (lines 1514–1564)

```
async fn thread_resume_emits_restored_token_usage_before_next_turn() -> Result<()>
```

**Purpose**: This test verifies that resuming a thread with saved token usage replays a token-usage notification. A reconnecting client can then show accurate usage before the user starts another turn.

**Data flow**: It creates a fake rollout containing token usage, resumes it, reads the `thread/tokenUsage/updated` notification, and checks totals, last-turn usage, and model context window values.

**Call relations**: The test runner calls it. It depends on the fake rollout-with-token-usage helper and observes the app server’s notification stream after resume.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (default, new, Integer, create_fake_rollout_with_token_usage, create_mock_responses_server_repeating_assistant, assert_eq!, panic!, timeout).


##### `thread_resume_skips_restored_token_usage_when_turns_are_excluded`  (lines 1567–1638)

```
async fn thread_resume_skips_restored_token_usage_when_turns_are_excluded() -> Result<()>
```

**Purpose**: This test proves that metadata-only resume does not replay token usage. If turns are excluded, there is no turn context for the usage notification.

**Data flow**: It first resumes a token-usage rollout normally and sees the usage notification. Then it resumes the same thread with `exclude_turns` enabled, confirms the response has no turns, and verifies no second token-usage notification arrives.

**Call relations**: The test runner invokes it. It compares full resume and metadata-only resume behavior on the same saved rollout.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (default, new, Integer, create_fake_rollout_with_token_usage, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, panic!, timeout).


##### `thread_resume_token_usage_replay_ignores_stale_interrupted_tail_turn`  (lines 1641–1726)

```
async fn thread_resume_token_usage_replay_ignores_stale_interrupted_tail_turn() -> Result<()>
```

**Purpose**: This test checks that token usage is not wrongly attached to a later incomplete tail turn that has no token usage of its own. The saved usage should remain tied to the completed turn that produced it.

**Data flow**: It creates a rollout with token usage, appends a started-but-never-completed turn with an assistant message, resumes the thread, and checks that the tail turn is marked interrupted. The replayed token-usage notification should reference the earlier completed turn, not the stale tail turn.

**Call relations**: The test runner calls it. It manually appends rollout events to simulate a crash or stale interrupted turn before resume.

*Call graph*: calls 2 internal fn (new, create_config_toml); 14 external calls (default, new, Integer, create_fake_rollout_with_token_usage, create_mock_responses_server_repeating_assistant, rollout_path, assert_eq!, assert_ne!, format!, json! (+4 more)).


##### `thread_resume_token_usage_replay_can_belong_to_interrupted_turn`  (lines 1729–1849)

```
async fn thread_resume_token_usage_replay_can_belong_to_interrupted_turn() -> Result<()>
```

**Purpose**: This test verifies the opposite token-usage edge case: if an interrupted turn itself recorded usage before aborting, the replay should belong to that interrupted turn.

**Data flow**: It creates a rollout with an initial completed turn, appends a second turn that starts, emits a message, records token usage, and is aborted as interrupted. On resume, the notification should reference the interrupted turn and contain its later token totals.

**Call relations**: The test runner invokes it. It builds a precise saved-history sequence so resume can prove it associates usage with the correct turn.

*Call graph*: calls 2 internal fn (new, create_config_toml); 13 external calls (default, new, Integer, create_fake_rollout_with_token_usage, create_mock_responses_server_repeating_assistant, rollout_path, assert_eq!, format!, json!, panic! (+3 more)).


##### `thread_resume_prefers_persisted_git_metadata_for_local_threads`  (lines 1852–2043)

```
async fn thread_resume_prefers_persisted_git_metadata_for_local_threads() -> Result<()>
```

**Purpose**: This test ensures resume uses Git metadata already stored in Codex state rather than recomputing live Git state from the workspace. That matters when the thread should reflect a branch from a previous context.

**Data flow**: It creates a real temporary Git repository on `master`, writes a rollout for that repository, marks database backfill complete, updates the thread metadata branch to `feature/pr-branch`, and resumes the thread. The returned Git info should show the persisted branch, not the live `master` branch.

**Call relations**: The test runner calls it. It combines filesystem Git setup, state database metadata update, and the public resume API.

*Call graph*: calls 3 internal fn (new, from_string, init); 14 external calls (default, new, new_v4, Integer, create_mock_responses_server_repeating_assistant, rollout_path, assert!, assert_eq!, new, format! (+4 more)).


##### `thread_resume_and_read_interrupt_incomplete_rollout_turn_when_thread_is_idle`  (lines 2046–2161)

```
async fn thread_resume_and_read_interrupt_incomplete_rollout_turn_when_thread_is_idle() -> Result<()>
```

**Purpose**: This test verifies that an incomplete saved turn is shown as interrupted when the thread is otherwise idle. It also checks that repeated resume and read calls report the same stable interrupted state.

**Data flow**: It creates a fake rollout, appends a turn-start and assistant-message event without a completion, resumes the thread, resumes it again, and then reads it. Each response should show an idle thread with the incomplete turn marked interrupted.

**Call relations**: The test runner invokes it. It uses both resume and read APIs to prove the reconstruction logic is consistent.

*Call graph*: calls 2 internal fn (new, create_config_toml); 13 external calls (default, new, new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, rollout_path, assert_eq!, format!, json! (+3 more)).


##### `thread_resume_defers_updated_at_until_turn_start`  (lines 2164–2260)

```
async fn thread_resume_defers_updated_at_until_turn_start() -> Result<()>
```

**Purpose**: This test checks that simply resuming a thread does not update its `updated_at` timestamp or touch the rollout file. Looking at a conversation should not make it look newly active.

**Data flow**: It prepares a rollout with a known file modification time, reads the thread, resumes it, verifies the timestamp and file modification time did not change, unsubscribes, resumes by path with a cwd override, then starts a new turn. Only after the new turn should the rollout file modification time increase.

**Call relations**: The test runner calls it. It uses `setup_rollout_fixture` for the saved file and `normalized_existing_path` for the path-based resume part.

*Call graph*: calls 3 internal fn (new, normalized_existing_path, setup_rollout_fixture); 9 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, metadata, timeout, vec!).


##### `thread_resume_keeps_in_flight_turn_streaming`  (lines 2263–2356)

```
async fn thread_resume_keeps_in_flight_turn_streaming() -> Result<()>
```

**Purpose**: This test proves that another client can resume a thread while a turn is still running without stopping that turn. Reconnection should observe work, not interrupt it.

**Data flow**: It starts a primary server client, materializes a thread, starts a second client, begins a new turn on the primary client, then resumes the same thread from the secondary client. The resume should succeed while the primary client still receives the eventual turn-completed notification.

**Call relations**: The test runner invokes it. It uses two `TestAppServer` clients against the same temporary Codex home to simulate reconnecting or multi-client access.

*Call graph*: calls 2 internal fn (new, create_config_toml); 7 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_ne!, timeout, vec!).


##### `thread_resume_rejects_history_when_thread_is_running`  (lines 2359–2475)

```
async fn thread_resume_rejects_history_when_thread_is_running() -> Result<()>
```

**Purpose**: This test ensures a client cannot replace or override history while a thread is running. Changing history during active work could make the server and model disagree about the conversation.

**Data flow**: It starts and seeds a thread, starts a delayed second turn, then sends a resume request for the same thread with explicit replacement history. The server should return an error saying it cannot resume a running thread with history, and the test then interrupts the running turn cleanly.

**Call relations**: The test runner calls it. It uses a delayed mock response to keep the turn in progress long enough to test the rejection path.

*Call graph*: calls 7 internal fn (new, create_config_toml, mount_response_once, mount_sse_once, sse, sse_response, start_mock_server); 8 external calls (default, new, Integer, assert!, assert_eq!, from_millis, timeout, vec!).


##### `thread_resume_rejects_mismatched_path_for_running_thread_id`  (lines 2478–2643)

```
async fn thread_resume_rejects_mismatched_path_for_running_thread_id() -> Result<()>
```

**Purpose**: This test checks that, for a running thread, a supplied path must match the running thread’s actual rollout path. This prevents a client from accidentally joining one live thread while pointing at another saved file.

**Data flow**: It starts a running turn, optionally checks equivalent Windows path spellings are accepted, creates a separate stale rollout file, and tries to resume the running thread id with the stale path. The expected result is a `stale path` error, after which the running turn is interrupted.

**Call relations**: The test runner invokes it. It uses mock responses to keep the thread running and direct file creation to provide the mismatched path.

*Call graph*: calls 7 internal fn (new, create_config_toml, mount_response_once, mount_sse_once, sse, sse_response, start_mock_server); 17 external calls (default, from, new, new_v4, parse_str, Integer, rollout_path, assert!, assert_eq!, format! (+7 more)).


##### `thread_resume_rejoins_running_thread_even_with_override_mismatch`  (lines 2646–2778)

```
async fn thread_resume_rejoins_running_thread_even_with_override_mismatch() -> Result<()>
```

**Purpose**: This test verifies that a normal resume of a running thread rejoins the live thread even if model or cwd overrides are supplied. Live thread settings should win over stale client-supplied overrides.

**Data flow**: It starts a thread, seeds history, begins a delayed running turn, and resumes with a wrong model, wrong cwd, and a request for an initial turns page. The response should report the running model, include the in-progress turn summary, and show the thread as active or already idle depending on timing.

**Call relations**: The test runner calls it. It simulates a reconnect during active work and checks that resume queues onto the running thread listener rather than rebuilding from conflicting overrides.

*Call graph*: calls 6 internal fn (new, create_config_toml, mount_response_sequence, sse, sse_response, start_mock_server); 9 external calls (default, new, Integer, assert!, assert_eq!, panic!, from_millis, timeout, vec!).


##### `thread_resume_can_skip_turns_when_thread_is_running`  (lines 2781–2857)

```
async fn thread_resume_can_skip_turns_when_thread_is_running() -> Result<()>
```

**Purpose**: This test checks that `exclude_turns` also works when resuming a thread that is already loaded. A client can ask only for metadata without paying to transfer turn history.

**Data flow**: It starts and materializes a thread, creates a second app-server client, and resumes the same thread with `exclude_turns` enabled. The returned thread should have the same id, be idle, and contain no turns.

**Call relations**: The test runner invokes it. It uses two clients to exercise the loaded-thread resume path rather than only loading from disk.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once, sse, start_mock_server); 7 external calls (default, new, Integer, assert!, assert_eq!, timeout, vec!).


##### `thread_resume_replays_pending_command_execution_request_approval`  (lines 2860–2995)

```
async fn thread_resume_replays_pending_command_execution_request_approval() -> Result<()>
```

**Purpose**: This test verifies that if a turn is waiting for command-execution approval, resuming the thread replays the pending approval request. A reconnecting client must still be able to answer the question.

**Data flow**: It seeds a thread, starts a turn where the model asks to run a shell command, captures the original approval request, resumes the thread, and expects the same request to be sent again. It then accepts the request and waits for the turn to complete and for all expected model calls to occur.

**Call relations**: The test runner calls it. It uses `wait_for_responses_request_count` at the end to confirm the approval allowed the model interaction to continue.

*Call graph*: calls 3 internal fn (new, create_config_toml, wait_for_responses_request_count); 11 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, assert!, assert_eq!, panic!, assert_eq!, to_value, timeout (+1 more)).


##### `thread_resume_replays_pending_file_change_request_approval`  (lines 2998–3163)

```
async fn thread_resume_replays_pending_file_change_request_approval() -> Result<()>
```

**Purpose**: This test checks the same replay behavior for file-change approvals. If a patch is waiting for user approval, resuming should resend that pending request.

**Data flow**: It sets up a workspace, seeds a thread, starts a turn where the model proposes a patch, waits for the file-change item and approval request, clears buffered messages, and resumes. The same approval request should be replayed; after accepting it, the turn should complete and the expected number of model requests should be recorded.

**Call relations**: The test runner invokes it. It uses `wait_for_responses_request_count` to confirm the approved patch flow reached the model server the expected number of times.

*Call graph*: calls 3 internal fn (new, create_config_toml, wait_for_responses_request_count); 12 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, assert!, assert_eq!, panic!, from_value, to_value, create_dir (+2 more)).


##### `thread_resume_with_overrides_defers_updated_at_until_turn_start`  (lines 3166–3230)

```
async fn thread_resume_with_overrides_defers_updated_at_until_turn_start() -> Result<()>
```

**Purpose**: This test is a focused variant of the timestamp rule: even resuming with overrides must not update the thread’s activity time until a real new turn starts.

**Data flow**: It starts and restarts a materialized thread, sets the rollout file modification time to a known value, resumes with a model override, and checks that the returned updated time and file modification time are unchanged. After starting a new turn, the file modification time should increase.

**Call relations**: The test runner calls it. It uses `start_materialized_thread_and_restart` to simulate loading from an existing saved thread and `set_rollout_mtime` to control the timestamp.

*Call graph*: calls 3 internal fn (create_config_toml, set_rollout_mtime, start_materialized_thread_and_restart); 9 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, metadata, timeout, vec!).


##### `thread_resume_fails_when_required_mcp_server_fails_to_initialize`  (lines 3233–3268)

```
async fn thread_resume_fails_when_required_mcp_server_fails_to_initialize() -> Result<()>
```

**Purpose**: This test proves that resume fails clearly if a required MCP server cannot start. Required external tools are part of the thread environment, so the user should see a useful error instead of a half-loaded thread.

**Data flow**: It prepares a rollout, writes config containing a required MCP server command that does not exist, starts the app server, and asks to resume. The response should be a JSON-RPC error naming required MCP initialization failure and the broken server.

**Call relations**: The test runner invokes it. It uses `setup_rollout_fixture` for saved history and `create_config_toml_with_required_broken_mcp` to inject the failing tool configuration.

*Call graph*: calls 3 internal fn (new, create_config_toml_with_required_broken_mcp, setup_rollout_fixture); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, timeout).


##### `thread_resume_surfaces_cloud_config_bundle_load_errors`  (lines 3271–3360)

```
async fn thread_resume_surfaces_cloud_config_bundle_load_errors() -> Result<()>
```

**Purpose**: This test checks that cloud configuration failures during resume are surfaced with structured error details. In particular, an invalid ChatGPT refresh token should tell the client to ask the user to log in again.

**Data flow**: It creates mock endpoints that return authentication failures, writes ChatGPT auth with a stale refresh token, creates a saved rollout, starts the app server with a refresh-token URL override, and resumes. The expected error includes a human message plus structured data with reason, error code, action, status code, and detail text.

**Call relations**: The test runner calls it. It uses wiremock endpoints for cloud config and token refresh, plus the ChatGPT config helper, to exercise startup-time cloud configuration inside resume.

*Call graph*: calls 3 internal fn (new, new_with_env, create_config_toml_with_chatgpt_base_url); 17 external calls (default, given, start, new, new, new, Integer, create_fake_rollout_with_text_elements, create_mock_responses_server_repeating_assistant, write_chatgpt_auth (+7 more)).


##### `thread_resume_uses_path_over_non_running_thread_id`  (lines 3363–3394)

```
async fn thread_resume_uses_path_over_non_running_thread_id() -> Result<()>
```

**Purpose**: This test verifies that, for a non-running thread, an explicit rollout path can identify the session even if the supplied thread id is wrong. This supports opening a saved session by file path.

**Data flow**: It starts, materializes, and restarts a thread, then sends a resume request with a newly generated unrelated thread id but the real rollout file path. The resumed thread id should be the id stored in the file.

**Call relations**: The test runner invokes it. It relies on `start_materialized_thread_and_restart` to create a durable saved thread before testing path-based resume.

*Call graph*: calls 3 internal fn (create_config_toml, start_materialized_thread_and_restart, new); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_resume_can_load_source_by_external_path`  (lines 3397–3440)

```
async fn thread_resume_can_load_source_by_external_path() -> Result<()>
```

**Purpose**: This test checks that the server can resume a rollout file located outside its normal Codex home. That allows a client to open a specific saved conversation file from another location.

**Data flow**: It creates normal config in one temporary Codex home and a fake rollout in a separate external home, then resumes with an invalid thread id but the external rollout path. The response should use the thread id and preview from that external file and report the normalized path.

**Call relations**: The test runner calls it. It combines the shared config helper with fake rollout creation in a separate directory to prove path-based loading is not limited to the default sessions folder.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (default, new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, rollout_path, assert_eq!, timeout).


##### `thread_resume_supports_history_and_overrides`  (lines 3443–3489)

```
async fn thread_resume_supports_history_and_overrides() -> Result<()>
```

**Purpose**: This test verifies that resuming an idle saved thread can accept explicit replacement history and model/provider overrides. This is useful for clients that want to fork or rehydrate a thread with supplied conversation items.

**Data flow**: It starts and restarts a materialized thread, builds a one-message history override, resumes with that history plus model and provider overrides, and checks the resumed preview, provider, and idle status.

**Call relations**: The test runner invokes it. It uses `start_materialized_thread_and_restart` to ensure the thread is not running when the override resume is attempted.

*Call graph*: calls 2 internal fn (create_config_toml, start_materialized_thread_and_restart); 8 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout, vec!).


##### `start_materialized_thread_and_restart`  (lines 3498–3570)

```
async fn start_materialized_thread_and_restart(
    codex_home: &Path,
    seed_text: &str,
) -> Result<RestartedThreadFixture>
```

**Purpose**: This helper creates a real saved thread, shuts down that first app-server instance, and starts a second one. It gives tests a realistic “app restarted, now resume from disk” setup.

**Data flow**: It receives a Codex home path and seed user text. It starts an app server, starts a thread, sends one turn to force rollout storage, reads the thread metadata, records the thread id, rollout path, and updated time, drops the first server, starts a second server, and returns all of that in a fixture struct.

**Call relations**: Several resume tests call this when they need an idle materialized thread after restart. It hides the repeated setup steps so those tests can focus on path precedence, overrides, or timestamp behavior.

*Call graph*: calls 1 internal fn (new); called by 3 (thread_resume_supports_history_and_overrides, thread_resume_uses_path_over_non_running_thread_id, thread_resume_with_overrides_defers_updated_at_until_turn_start); 4 external calls (default, Integer, timeout, vec!).


##### `thread_resume_accepts_personality_override`  (lines 3573–3690)

```
async fn thread_resume_accepts_personality_override() -> Result<()>
```

**Purpose**: This test checks that a resumed thread can accept a personality override and use it on the next turn while preserving the base instructions from history. Personality here means an optional style setting for how the agent should respond.

**Data flow**: It seeds a thread, starts a second client, resumes with a friendly personality override, then starts another turn. It inspects the outgoing model request and expects a developer message containing a personality spec while the main instructions still include the default Codex base instructions.

**Call relations**: The test runner invokes it, unless the network skip macro disables it. It uses response-capture helpers from the core test support to inspect what the resumed turn sends to the model.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_sequence, sse, start_mock_server); 8 external calls (default, new, Integer, assert!, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `create_config_toml`  (lines 3693–3717)

```
fn create_config_toml(codex_home: &std::path::Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes a minimal app-server configuration file for most tests. It points Codex at the fake model server and enables the personality feature.

**Data flow**: It receives a Codex home directory and mock server URI. It writes `config.toml` with a fixed model, approval policy, read-only sandbox, mock model provider, and retry settings, then returns the filesystem write result.

**Call relations**: Most tests and some helpers call this before starting `TestAppServer`. It is the shared setup that makes each test use a controlled fake model backend instead of real services.

*Call graph*: called by 31 (resume_redaction_fixture, setup_rollout_fixture, thread_goal_get_rejects_unmaterialized_thread, thread_goal_set_edits_objective_without_resetting_usage, thread_goal_set_persists_resumable_stopped_statuses, thread_goal_set_preserves_budget_limited_same_objective, thread_resume_accepts_personality_override, thread_resume_and_read_interrupt_incomplete_rollout_turn_when_thread_is_idle, thread_resume_can_load_source_by_external_path, thread_resume_can_skip_turns_for_metadata_only_resume (+15 more)); 3 external calls (join, format!, write).


##### `create_config_toml_with_chatgpt_base_url`  (lines 3719–3748)

```
fn create_config_toml_with_chatgpt_base_url(
    codex_home: &std::path::Path,
    server_uri: &str,
    chatgpt_base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: This helper writes a test config like the normal one, but also includes a ChatGPT backend base URL. Tests use it when resume behavior depends on analytics or cloud configuration.

**Data flow**: It receives a Codex home path, mock model server URI, and ChatGPT base URL. It writes a `config.toml` containing both the mock model provider and the supplied ChatGPT endpoint.

**Call relations**: Analytics and cloud-config tests call this before starting the app server. It connects local resume tests to fake ChatGPT-style backend endpoints.

*Call graph*: called by 3 (thread_goal_lifecycle_emits_analytics_and_clear_deletes_goal, thread_resume_surfaces_cloud_config_bundle_load_errors, thread_resume_tracks_thread_initialized_analytics); 3 external calls (join, format!, write).


##### `create_config_toml_with_required_broken_mcp`  (lines 3750–3781)

```
fn create_config_toml_with_required_broken_mcp(
    codex_home: &std::path::Path,
    server_uri: &str,
) -> std::io::Result<()>
```

**Purpose**: This helper writes a config that deliberately contains a required MCP server with a nonexistent command. It creates the failure condition for testing required-tool initialization errors.

**Data flow**: It receives a Codex home path and mock model server URI. It writes normal model settings plus an MCP server named `required_broken` whose command cannot run and whose `required` flag is true.

**Call relations**: The required-MCP failure test calls this after preparing a rollout. Resume then reads this config and should fail because the required tool server cannot start.

*Call graph*: called by 1 (thread_resume_fails_when_required_mcp_server_fails_to_initialize); 3 external calls (join, format!, write).


##### `set_rollout_mtime`  (lines 3784–3792)

```
fn set_rollout_mtime(path: &Path, updated_at_rfc3339: &str) -> Result<()>
```

**Purpose**: This helper sets a rollout file’s modification time to a specific timestamp. Tests use it to prove resume does not touch the file unless a new turn starts.

**Data flow**: It receives a file path and an RFC 3339 timestamp string, parses the timestamp, builds file-time metadata, opens the file, and applies the modified time. It returns an error if parsing or file operations fail.

**Call relations**: `setup_rollout_fixture` and the override timestamp test call this to create a known before-state. Later assertions compare file modification times against that controlled value.

*Call graph*: called by 2 (setup_rollout_fixture, thread_resume_with_overrides_defers_updated_at_until_turn_start); 3 external calls (new, parse_from_rfc3339, new).


##### `setup_rollout_fixture`  (lines 3800–3828)

```
async fn setup_rollout_fixture(codex_home: &Path, server_uri: &str) -> Result<RolloutFixture>
```

**Purpose**: This helper prepares a saved rollout file with predictable metadata and modification time. It is used by tests that need a stable, already-existing thread on disk.

**Data flow**: It writes normal config, creates a fake rollout with one saved user message, appends updated session metadata including a multi-agent version, sets the rollout file modification time, records that time, and returns the conversation id, file path, and recorded timestamp.

**Call relations**: Timestamp and required-MCP tests call this before starting the app server. It combines config writing, fake history creation, metadata editing, and mtime control into one reusable fixture.

*Call graph*: calls 2 internal fn (create_config_toml, set_rollout_mtime); called by 2 (thread_resume_defers_updated_at_until_turn_start, thread_resume_fails_when_required_mcp_server_fails_to_initialize); 7 external calls (new, create_fake_rollout_with_text_elements, rollout_path, append_rollout_item_to_path, read_session_meta_line, SessionMeta, metadata).


### Thread state mutation
These suites cover the lifecycle operations that mutate persisted thread state, including archival, deletion, branching, rollback, and per-thread configuration updates.

### `app-server/tests/suite/v2/thread_archive.rs`

`test` · `test run`

A “thread” here is a saved conversation, stored on disk as a rollout file. Archiving means moving that saved conversation out of the active sessions area and into an archived sessions folder, like moving a paper file from the desk into a filing cabinet. These tests make sure the server does that only when it has a real file to move, and that it reports the move back to clients using JSON-RPC, a request-and-response message format.

The file creates temporary Codex home folders so each test has a clean private world. It writes a small config file that points the app server at a mock model server, so no real network model is needed. Some tests start real threads through the test server; others create fake rollout files directly on disk and record parent-child thread links in the state database.

The important behaviors under test are: a newly started but not-yet-saved thread cannot be archived; archiving a parent thread also archives spawned descendants; failures or missing descendants do not stop the main archive request from succeeding; and after archive/unarchive, old client subscriptions are cleared so the wrong client does not receive future turn notifications. Without these checks, users could lose track of saved conversations, leave orphaned child threads active, or receive updates meant for another client session.

#### Function details

##### `thread_archive_requires_materialized_rollout`  (lines 36–168)

```
async fn thread_archive_requires_materialized_rollout() -> Result<()>
```

**Purpose**: This test proves that a thread must have an actual saved rollout file before it can be archived. It protects against archiving a conversation that only exists in memory and has no file to move yet.

**Data flow**: It starts a mock model server and a temporary Codex home, writes test configuration, then starts a new thread through the app server. Before any user message is sent, it checks that the expected rollout path does not exist and that lookup by thread id finds nothing. It sends an archive request and expects an error saying no rollout was found. Then it sends a real user turn, waits for completion so the rollout file is written, confirms the file can now be found, archives the thread successfully, reads the archive notification, and checks that the file was moved from the active location to the archived folder.

**Call relations**: This is one of the main end-to-end tests in the file. It uses create_config_toml to prepare the server configuration and assert_paths_match_on_disk to confirm that the discovered thread path and the thread’s own path are truly the same file on disk. It drives the TestAppServer through start, turn, and archive requests, then verifies the server’s responses and notifications.

*Call graph*: calls 3 internal fn (new, assert_paths_match_on_disk, create_config_toml); 10 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, find_thread_path_by_id_str, from_value, timeout, vec!).


##### `thread_archive_archives_spawned_descendants`  (lines 171–279)

```
async fn thread_archive_archives_spawned_descendants() -> Result<()>
```

**Purpose**: This test checks that archiving a parent thread also archives the threads that were spawned from it. That matters because a branch of related work should not leave child conversations active when the parent is filed away.

**Data flow**: It creates three fake rollout files: a parent, a child, and a grandchild. It records parent-to-child and child-to-grandchild links in the state database, then starts the app server and asks it to archive the parent. The test reads three archive notifications, checks their thread ids, and finally confirms that none of the three threads can be found in the active session area while all three can be found in the archived area.

**Call relations**: This test sets up its own thread family using fake rollout files and state database edges, then lets the app server’s archive operation walk that family. It relies on create_config_toml for configuration and on the server’s archive request flow to produce both the response and the thread/archived notifications.

*Call graph*: calls 4 internal fn (new, create_config_toml, from_string, init); 9 external calls (new, new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, from_value, timeout).


##### `thread_archive_succeeds_when_descendant_archive_fails`  (lines 282–417)

```
async fn thread_archive_succeeds_when_descendant_archive_fails() -> Result<()>
```

**Purpose**: This test makes sure the archive request can still succeed even if one descendant thread cannot be archived. It checks that a problem with one child does not undo successful archival of the parent and other descendants.

**Data flow**: It creates parent, child, and grandchild rollout files and records their spawn relationships. Before calling archive, it deliberately creates a directory where the child’s archived file should go, causing a file-system conflict. It then archives the parent. The server returns success and sends archive notifications for the parent and grandchild, but not the child. The test confirms the child rollout is still active, the conflicting directory remains, and the parent and grandchild were moved to archived storage.

**Call relations**: This test uses the same broad setup as the descendant-archiving test, but adds a deliberate disk conflict to force one descendant archive to fail. It calls create_config_toml for setup, uses the state database to describe the thread family, and observes the app server’s response stream to ensure only successfully archived threads announce thread/archived.

*Call graph*: calls 4 internal fn (new, create_config_toml, from_string, init); 11 external calls (new, new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, find_thread_path_by_id_str, from_value, create_dir_all (+1 more)).


##### `thread_archive_succeeds_when_spawned_descendant_is_missing`  (lines 420–494)

```
async fn thread_archive_succeeds_when_spawned_descendant_is_missing() -> Result<()>
```

**Purpose**: This test checks that a missing child thread does not stop its parent from being archived. It covers the case where the state database says a child exists, but the corresponding rollout file is gone or never existed.

**Data flow**: It creates one real parent rollout and records a spawn edge from that parent to a made-up child thread id. It starts the app server, asks to archive the parent, and expects a successful response. It reads one archive notification for the parent, then verifies that the parent is no longer active and is present in archived storage.

**Call relations**: This test focuses on resilience when the state database contains stale relationship information. It uses create_config_toml for the temporary test setup, writes the spawn edge through the state runtime, and then relies on the archive request path to skip over the missing descendant while still archiving the real parent.

*Call graph*: calls 4 internal fn (new, create_config_toml, from_string, init); 8 external calls (new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, from_value, timeout).


##### `thread_archive_clears_stale_subscriptions_before_resume`  (lines 497–630)

```
async fn thread_archive_clears_stale_subscriptions_before_resume() -> Result<()>
```

**Purpose**: This test ensures that after a thread is archived, unarchived, and resumed by another client, the old client does not keep receiving turn updates. It protects users from confusing cross-talk between client sessions.

**Data flow**: It starts a primary app-server client, creates and materializes a thread, then starts a secondary client connected to the same temporary Codex home. The primary client archives and unarchives the thread. The secondary client resumes it and starts a new turn. The test then checks that the primary client does not receive a turn/started notification, while the secondary client does receive the expected completion notification.

**Call relations**: This test exercises a multi-client story rather than just file movement. It uses create_config_toml to point both TestAppServer instances at the mock provider. It then follows the server protocol through start, turn, archive, unarchive, resume, and another turn to prove that stale subscriptions are cleared before resume.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout, vec!).


##### `create_config_toml`  (lines 632–635)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes the small configuration file needed by each test server. It tells the app server which mock model provider to use and disables retries so tests behave predictably.

**Data flow**: It receives a temporary Codex home path and the mock server’s URI. It builds the path to config.toml inside that home, asks config_contents to create the file text, and writes that text to disk. The result is either success or an I/O error if the file cannot be written.

**Call relations**: All five tests call this helper during setup, before starting TestAppServer. It delegates the actual text construction to config_contents, keeping the tests focused on archive behavior instead of repeated config-file boilerplate.

*Call graph*: calls 1 internal fn (config_contents); called by 5 (thread_archive_archives_spawned_descendants, thread_archive_clears_stale_subscriptions_before_resume, thread_archive_requires_materialized_rollout, thread_archive_succeeds_when_descendant_archive_fails, thread_archive_succeeds_when_spawned_descendant_is_missing); 2 external calls (join, write).


##### `config_contents`  (lines 637–653)

```
fn config_contents(server_uri: &str) -> String
```

**Purpose**: This helper builds the text of the test config.toml file. It gives every test the same predictable model, provider, sandbox, and retry settings.

**Data flow**: It receives the mock server URI as text. It inserts that URI into a TOML configuration string, specifically as the base URL for the mock provider’s responses API. It returns the completed configuration text to be written to disk.

**Call relations**: This function is called only by create_config_toml. It is the small template-maker behind the shared test setup, so the individual archive tests do not need to repeat the configuration body.

*Call graph*: called by 1 (create_config_toml); 1 external calls (format!).


##### `assert_paths_match_on_disk`  (lines 655–660)

```
fn assert_paths_match_on_disk(actual: &Path, expected: &Path) -> std::io::Result<()>
```

**Purpose**: This helper checks that two paths point to the same real file location. It avoids false failures caused by different-looking paths that resolve to the same place.

**Data flow**: It receives two paths, resolves each one to its canonical on-disk form, and compares those resolved paths. If they match, it returns success; if resolving fails, it returns the file-system error; if they differ, the test assertion fails.

**Call relations**: The materialized-rollout test calls this after the server has written the rollout file and lookup by thread id has found it. The helper confirms that the lookup result is not merely similar, but actually refers to the same rollout path the thread reported.

*Call graph*: called by 1 (thread_archive_requires_materialized_rollout); 2 external calls (canonicalize, assert_eq!).


### `app-server/tests/suite/v2/thread_delete.rs`

`test` · `test run`

This test file protects the behavior of the app server’s “delete thread” feature. A thread is a saved conversation or work session. Some threads can spawn other threads, like branches from a tree. If a parent branch is deleted, the system is expected to delete its spawned descendants too, and to do that in a safe order: deepest children first, then their parents. Without these tests, the server could leave behind orphaned files or stale links in its state database.

The file creates temporary Codex home folders so each test runs in a clean sandbox. It uses fake rollout files, which stand in for saved thread history on disk, and a test app server that speaks the same JSON-RPC-style request and response messages as a real client. JSON-RPC is a simple message format where a client sends named requests and receives matching responses or errors.

The first test builds a parent, child, and grandchild thread chain, asks the server to delete the parent, then verifies that all three are deleted and that their spawn links are gone from the state database. The second test checks live in-memory threads before a rollout file exists: a normal persisted thread can be deleted, but an explicitly ephemeral thread, meaning temporary and not meant to be saved, must return a clear error instead of pretending deletion succeeded.

#### Function details

##### `thread_delete_deletes_spawned_descendants`  (lines 27–108)

```
async fn thread_delete_deletes_spawned_descendants() -> Result<()>
```

**Purpose**: This test proves that deleting a saved parent thread also deletes all of its spawned child threads. It matters because thread branches form a small tree, and deleting only the top item would leave confusing leftover conversations and database links behind.

**Data flow**: It starts with an empty temporary Codex home folder. Into that folder it writes three fake saved threads, turns their string IDs into real thread ID values, and records parent-to-child links in the state database. It then starts a test app server, sends a delete request for the parent ID, reads the server response and three deletion notifications, and checks that the notifications arrive for grandchild, child, and parent. Finally it looks on disk and in the state database to confirm the rollout files and descendant links are gone.

**Call relations**: During the test setup it calls `create_delete_test_rollout` to make the fake saved threads. It also uses the state runtime to create the spawn relationships before the app server is initialized. Once the server is running, the test drives it like a client would: send a delete request, wait for the matching response, then listen for `thread/deleted` notifications that prove the server carried out the cascading deletion.

*Call graph*: calls 4 internal fn (new, create_delete_test_rollout, from_string, init); 8 external calls (new, new, Integer, assert!, assert_eq!, find_thread_path_by_id_str, from_value, timeout).


##### `create_delete_test_rollout`  (lines 110–119)

```
fn create_delete_test_rollout(codex_home: &Path, minute: u8, preview: &str) -> Result<String>
```

**Purpose**: This helper creates one fake saved thread file for the deletion tests. It keeps the main test readable by hiding the repeated details needed to make a realistic rollout entry.

**Data flow**: It receives the temporary Codex home path, a minute value used to make unique timestamps, and a short preview label such as “parent” or “child”. It formats those into timestamp strings and passes them, along with a mock provider name, to the shared fake-rollout creator. It returns the new thread ID string that the test can later use for database links and delete requests.

**Call relations**: It is called by `thread_delete_deletes_spawned_descendants` while that test is building its parent-child-grandchild chain. It hands off the actual file creation to `create_fake_rollout`, which is part of the test support code, so this file only needs to choose the test-specific timestamps and preview text.

*Call graph*: called by 1 (thread_delete_deletes_spawned_descendants); 2 external calls (create_fake_rollout, format!).


##### `thread_delete_handles_live_threads_before_rollout_exists`  (lines 122–200)

```
async fn thread_delete_handles_live_threads_before_rollout_exists() -> Result<()>
```

**Purpose**: This test checks what happens when a thread exists in the running server but its saved rollout file does not exist yet. It makes sure normal live threads can still be deleted, while temporary ephemeral threads correctly reject deletion with a clear error.

**Data flow**: It starts a clean temporary server, asks it to start a normal thread, and confirms there is not yet a rollout file for that thread on disk. It then sends a delete request for that live thread and expects a successful delete response. Next it starts another thread marked as ephemeral, sends a delete request for it, and expects an error saying the thread is not persisted and cannot be deleted. At the end it asks the server for the loaded thread list and checks that the ephemeral thread is still loaded.

**Call relations**: This test talks to the `TestAppServer` as a client would: initialize, start a thread, delete a thread, read either a response or an error, and finally list loaded threads. It also uses `find_thread_path_by_id_str` between start and delete to prove the first live thread has no rollout file yet, which is the edge case being tested.

*Call graph*: calls 1 internal fn (new); 9 external calls (default, new, Integer, default, default, assert_eq!, find_thread_path_by_id_str, format!, timeout).


### `app-server/tests/suite/v2/thread_fork.rs`

`test` · `test execution`

A “thread” here is a saved conversation, and a “fork” is like making a new branch from an old conversation so the user can continue in a different direction without changing the original. These tests create small fake saved conversations on disk, start a test app server, send JSON-RPC requests to it, and check the replies and notifications. JSON-RPC is the message format used between the client and server: the test sends a request with an id, then waits for either a matching response or an error.

The file focuses on behavior that would be easy to accidentally break. It verifies that forking does not edit the original rollout file, that the new thread gets its own id and path, that copied turns and token usage appear only when they should, and that the server sends the right `thread/started` notification. It also checks special cases: loading the source thread by file path, keeping a renamed parent thread’s name in listings, making temporary “ephemeral” forks that are not saved or listed, and rejecting bad paths before trying to read them as files.

The helper functions at the bottom write simple test configuration files that point the server at mock HTTP services instead of real model or ChatGPT endpoints. This keeps the tests fast, repeatable, and safe.

#### Function details

##### `list_threads`  (lines 61–83)

```
async fn list_threads(mcp: &mut TestAppServer) -> Result<ThreadListResponse>
```

**Purpose**: Asks the test app server for the current list of conversation threads and returns the parsed list. Tests use it when they need to confirm whether a forked thread appears in the thread list.

**Data flow**: It takes a running `TestAppServer`. It sends a thread-list request with broad default filters, waits for the matching JSON-RPC response, converts that response into a `ThreadListResponse`, and gives that structured result back to the caller.

**Call relations**: This is a small test helper. The name-inheritance test calls it to find the newly forked thread in the list, and the ephemeral-fork test calls it to prove that temporary forks are left out of normal listings.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_list_request); called by 2 (thread_fork_ephemeral_remains_pathless_and_omits_listing, thread_fork_inherits_explicit_source_name_from_session_index); 2 external calls (Integer, timeout).


##### `thread_fork_creates_new_thread_and_emits_started`  (lines 86–251)

```
async fn thread_fork_creates_new_thread_and_emits_started() -> Result<()>
```

**Purpose**: Checks the main happy path for forking a saved thread. It proves that a fork creates a separate new thread, preserves useful conversation details, leaves the original file unchanged, and announces the new thread correctly.

**Data flow**: The test creates a temporary Codex home folder, writes config, creates a fake saved rollout, and records that rollout’s original file contents. It starts the app server, sends `thread/fork`, reads the response, and inspects the returned thread and raw JSON shape. It then waits for a `thread/started` notification and checks that the notification describes the new thread without sending copied turn history.

**Call relations**: The async test runner invokes this test. It relies on `create_config_toml` to prepare the server and on the test support utilities to create fake history and talk to the server. Its assertions define the expected contract for the fork response and the follow-up notification.

*Call graph*: calls 2 internal fn (new, create_config_toml); 18 external calls (default, new, bail!, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, assert_ne!, append_rollout_item_to_path (+8 more)).


##### `thread_fork_inherits_explicit_source_name_from_session_index`  (lines 254–295)

```
async fn thread_fork_inherits_explicit_source_name_from_session_index() -> Result<()>
```

**Purpose**: Verifies that if the original thread has been explicitly renamed, the fork can still show that name when threads are listed. This protects the user-visible title behavior for forked conversations.

**Data flow**: The test creates a fake saved thread, writes a name for that parent into the session index, starts the server, and forks the thread. It then asks for the thread list and searches for the forked thread, expecting its listed name to match the parent’s explicit name.

**Call relations**: The test runner calls this test. It uses `create_config_toml` for setup and `list_threads` afterward to inspect the server’s thread-list view rather than only the immediate fork response.

*Call graph*: calls 4 internal fn (new, create_config_toml, list_threads, from_string); 8 external calls (default, new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert_eq!, append_thread_name, timeout).


##### `thread_fork_can_load_source_by_path`  (lines 298–346)

```
async fn thread_fork_can_load_source_by_path() -> Result<()>
```

**Purpose**: Checks that the server can fork from a rollout file path even when the supplied thread id is not useful. This matters when a client knows exactly which saved file to use.

**Data flow**: The test creates a saved rollout and builds its expected file path. It starts the server, sends a fork request with an invalid thread id but a valid path, then reads the fork response. The output is checked to confirm that the new thread came from the real rollout, copied the preview and model provider, and contains the expected copied history.

**Call relations**: The test runner calls this scenario. It depends on `create_config_toml` for setup and then exercises the server’s fallback path-loading behavior through the normal test server request methods.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (default, new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert_eq!, assert_ne!, format!, timeout).


##### `thread_fork_emits_restored_token_usage_before_next_turn`  (lines 349–400)

```
async fn thread_fork_emits_restored_token_usage_before_next_turn() -> Result<()>
```

**Purpose**: Confirms that token usage saved in the original conversation is replayed for the forked thread. Token usage means the model input and output size accounting that clients often display or use for limits.

**Data flow**: The test creates a fake saved rollout that includes token usage numbers, starts the server, and forks it. After reading the fork response, it waits for a `thread/tokenUsage/updated` notification. It then checks that the notification points at the forked thread and copied turn, and that all token counts match the saved data.

**Call relations**: The test runner invokes this test. It uses `create_config_toml` for a mock model setup and a rollout helper that includes usage data, then listens to the server notification stream to verify the replayed accounting.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (default, new, Integer, create_fake_rollout_with_token_usage, create_mock_responses_server_repeating_assistant, assert_eq!, panic!, timeout).


##### `thread_fork_can_exclude_turns_and_skip_restored_token_usage`  (lines 403–448)

```
async fn thread_fork_can_exclude_turns_and_skip_restored_token_usage() -> Result<()>
```

**Purpose**: Checks the option to fork only the thread shell and preview, without copying past turns. It also verifies that token usage is not replayed when those turns are excluded.

**Data flow**: The test creates a saved rollout with token usage, starts the server, and sends a fork request with `exclude_turns` set to true. The response should contain a forked thread with the correct source id and preview but no turns. The test then waits for a token-usage notification and expects that wait to fail, proving no usage was replayed.

**Call relations**: The async test runner calls this test. It uses `create_config_toml` for setup and relies on the server stream timeout as evidence that an unwanted notification was not sent.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (default, new, Integer, create_fake_rollout_with_token_usage, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout).


##### `thread_fork_tracks_thread_initialized_analytics`  (lines 451–502)

```
async fn thread_fork_tracks_thread_initialized_analytics() -> Result<()>
```

**Purpose**: Verifies that forking a thread records the expected analytics event. Analytics here means a telemetry record used to understand product behavior, not part of the conversation itself.

**Data flow**: The test starts a mock server that can capture analytics, writes config pointing both model and ChatGPT traffic at test endpoints, and creates a fake saved thread. It forks that thread, waits for the analytics payload, extracts the thread-initialized event, and checks fields such as thread id, session id, model, source type, and original thread id.

**Call relations**: The test runner calls this scenario. It uses `create_config_toml_with_chatgpt_base_url` because analytics-related setup needs a ChatGPT base URL, and it works with the analytics helper functions from the surrounding test module.

*Call graph*: calls 6 internal fn (new_without_managed_config, assert_basic_thread_initialized_event, mount_analytics_capture, thread_initialized_event, wait_for_analytics_payload, create_config_toml_with_chatgpt_base_url); 7 external calls (default, new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_fork_rejects_unmaterialized_thread`  (lines 505–547)

```
async fn thread_fork_rejects_unmaterialized_thread() -> Result<()>
```

**Purpose**: Ensures the server refuses to fork a thread that exists only in memory and has not been saved as a rollout file. This prevents creating a fork from history that cannot actually be reconstructed.

**Data flow**: The test starts the server, creates a new thread through `thread/start`, and then immediately tries to fork that new thread. Instead of a normal fork response, it waits for a JSON-RPC error and checks that the message says no rollout was found for the thread id.

**Call relations**: The test runner invokes this test. It uses `create_config_toml` for mock setup, then combines a normal thread-start request with a fork request to check the server’s validation path.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, timeout).


##### `thread_fork_with_empty_path_uses_thread_id`  (lines 550–587)

```
async fn thread_fork_with_empty_path_uses_thread_id() -> Result<()>
```

**Purpose**: Checks that an empty path in a fork request is treated as if no path was supplied, so the server falls back to the thread id. This protects clients that may accidentally send an empty path value.

**Data flow**: The test creates a fake saved rollout, starts the server, and sends a fork request containing both the real thread id and an empty path. It reads the fork response and verifies that the new thread records the original thread id as its source.

**Call relations**: The test runner calls this test. It uses `create_config_toml` and the fake rollout setup, then exercises the server request path where `path` is present but should not override the thread id.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (default, new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert_eq!, new, timeout).


##### `thread_fork_surfaces_cloud_config_bundle_load_errors`  (lines 590–683)

```
async fn thread_fork_surfaces_cloud_config_bundle_load_errors() -> Result<()>
```

**Purpose**: Verifies that configuration failures from the cloud are reported clearly when forking. In this test, the fake service rejects both the config bundle request and token refresh, and the server should tell the client to log in again.

**Data flow**: The test starts mock HTTP endpoints that return authorization failures, writes config and fake ChatGPT credentials with a stale refresh token, then starts the app server with environment variables that route token refresh to the mock server. It sends a fork request and expects a JSON-RPC error. The error message and structured data are checked for the correct reason, error code, action, status code, and human-readable detail.

**Call relations**: The test runner invokes this failure case. It uses `create_config_toml_with_chatgpt_base_url` because the error path depends on cloud configuration loading, and it uses mock HTTP responses to force the exact authentication failure.

*Call graph*: calls 3 internal fn (new, new_with_env, create_config_toml_with_chatgpt_base_url); 16 external calls (default, given, start, new, new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, write_chatgpt_auth, assert! (+6 more)).


##### `thread_fork_ephemeral_remains_pathless_and_omits_listing`  (lines 686–837)

```
async fn thread_fork_ephemeral_remains_pathless_and_omits_listing() -> Result<()>
```

**Purpose**: Checks temporary, or “ephemeral,” forks. These forks should exist for the current session, have no file path, stay out of the normal thread list, but still be usable for continuing a conversation.

**Data flow**: The test creates a saved parent rollout, starts the server, and sends a fork request with `ephemeral` set to true. It checks that the returned thread is marked ephemeral, has no path, includes copied history, and is announced with a `thread/started` notification that omits copied turns. It then lists threads to confirm the ephemeral fork is absent while the parent remains present, and finally starts a new turn on the ephemeral fork to prove it still works.

**Call relations**: The async test runner calls this test. It uses `create_config_toml` for setup, `list_threads` to inspect visibility, and the server’s turn-start flow to show that a pathless temporary fork can still continue.

*Call graph*: calls 3 internal fn (new, create_config_toml, list_threads); 13 external calls (default, new, bail!, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, panic!, from_value (+3 more)).


##### `pathless_ephemeral_thread_rejects_codex_home_path_after_reload`  (lines 840–951)

```
async fn pathless_ephemeral_thread_rejects_codex_home_path_after_reload() -> Result<()>
```

**Purpose**: Checks a safety edge case after restarting the server: a pathless ephemeral thread id should not be resumed or forked using the Codex home directory as if it were a rollout file. The server should reject the directory early with a clear message.

**Data flow**: The test creates a parent rollout, starts a server, makes an ephemeral fork, runs a turn on it, and saves the fork’s id. Then it starts a fresh server using the same Codex home and tries both resume and fork requests with the Codex home directory passed as the path. Both requests should return JSON-RPC errors saying the path is a directory, without lower-level file-reading wording leaking through.

**Call relations**: The test runner invokes this restart-style scenario. It uses `create_config_toml` for setup, first drives the server to create a pathless ephemeral fork, then creates a new server instance to test how reload-time requests validate bad paths.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (default, new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout, vec!).


##### `create_config_toml`  (lines 954–975)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes a small `config.toml` file for tests that need a mock model provider. This lets the app server run without contacting real model services.

**Data flow**: It receives the temporary Codex home path and the mock server URL. It builds the path to `config.toml`, fills in a fixed test configuration string with the mock server URL, writes it to disk, and returns the file-write result.

**Call relations**: Most tests in this file call this helper during setup before starting `TestAppServer`. It provides the shared mock configuration needed for the fork and turn requests to run predictably.

*Call graph*: called by 9 (pathless_ephemeral_thread_rejects_codex_home_path_after_reload, thread_fork_can_exclude_turns_and_skip_restored_token_usage, thread_fork_can_load_source_by_path, thread_fork_creates_new_thread_and_emits_started, thread_fork_emits_restored_token_usage_before_next_turn, thread_fork_ephemeral_remains_pathless_and_omits_listing, thread_fork_inherits_explicit_source_name_from_session_index, thread_fork_rejects_unmaterialized_thread, thread_fork_with_empty_path_uses_thread_id); 3 external calls (join, format!, write).


##### `create_config_toml_with_chatgpt_base_url`  (lines 977–1003)

```
fn create_config_toml_with_chatgpt_base_url(
    codex_home: &Path,
    server_uri: &str,
    chatgpt_base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes a test `config.toml` that includes both a mock model provider and a configurable ChatGPT base URL. Tests use it when cloud configuration or analytics behavior is involved.

**Data flow**: It receives the temporary Codex home path, the mock model server URL, and the ChatGPT base URL. It writes a config file containing the fixed test model settings plus those URLs, then returns whether the disk write succeeded.

**Call relations**: The analytics test and the cloud-config error test call this setup helper. It gives those tests enough configuration to route both model traffic and ChatGPT-related requests to controlled mock servers.

*Call graph*: called by 2 (thread_fork_surfaces_cloud_config_bundle_load_errors, thread_fork_tracks_thread_initialized_analytics); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/thread_memory_mode_set.rs`

`test` · `test run`

This is a test file for the app server’s “thread memory mode” feature. In plain terms, memory mode decides whether a conversation thread should use saved memory or not. These tests make sure that when a client asks the server to turn memory off or on for a thread, the choice is actually written to the project’s persistent state, not just accepted in the moment.

Each test builds a small fake world. It creates a temporary Codex home folder, writes a test config file, starts a mock model server that always replies with “Done,” and opens the app server through a test client. One test starts a brand-new thread through the server, then disables memory for it and checks the database. The other creates a stored thread first, then asks the server to disable and re-enable memory, and checks that the final saved value is “enabled.”

The helper functions keep the setup realistic. `create_config_toml` writes a config file pointing the app server at the mock provider and turns on SQLite-backed state. `init_state_db` opens the same state database the server will use and marks setup work as complete, so the test can directly inspect the saved memory mode. Without tests like these, the server might appear to accept memory-mode requests while silently failing to persist them.

#### Function details

##### `thread_memory_mode_set_updates_loaded_thread_state`  (lines 24–63)

```
async fn thread_memory_mode_set_updates_loaded_thread_state() -> Result<()>
```

**Purpose**: This test proves that changing memory mode works for a thread that has been started and is currently known to the running app server. It disables memory for that live thread and then verifies the saved database value is `disabled`.

**Data flow**: The test starts with a temporary home folder, a fake model server URL, and a freshly initialized state database. It writes a config file, starts the test app server, creates a new thread through a thread-start request, converts the returned thread id into the database’s thread id format, sends a memory-mode-set request with `Disabled`, waits for the server’s response, and finally reads the database. The before state is a new thread with no checked memory-mode value; the after state is a saved database row whose memory mode is `disabled`.

**Call relations**: This is one of the file’s top-level async tests. It calls `create_config_toml` to make the temporary server configuration and `init_state_db` so it can inspect persistent state. It then uses the test app server helpers to send protocol requests and waits for the matching JSON-RPC response before checking the database.

*Call graph*: calls 4 internal fn (new, create_config_toml, init_state_db, from_string); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_memory_mode_set_updates_stored_thread_state`  (lines 66–103)

```
async fn thread_memory_mode_set_updates_stored_thread_state() -> Result<()>
```

**Purpose**: This test proves that changing memory mode also works for a thread that already exists in storage before the app server starts. It checks that repeated changes are saved, with the last requested value winning.

**Data flow**: The test creates a temporary home folder, writes config, initializes the state database, and creates a fake stored thread rollout file. It then starts the test app server and sends two memory-mode-set requests for the same stored thread: first `Disabled`, then `Enabled`. After both server responses arrive, it reads the state database. The before state is an existing stored thread; the after state records the final memory mode as `enabled`.

**Call relations**: This is the second top-level async test in the file. Like the live-thread test, it relies on `create_config_toml` and `init_state_db` for setup, but it also calls the test helper that creates a fake stored rollout. It drives the app server through the same public request path a real client would use, then verifies the result directly in the state database.

*Call graph*: calls 4 internal fn (new, create_config_toml, init_state_db, from_string); 6 external calls (new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `init_state_db`  (lines 105–111)

```
async fn init_state_db(codex_home: &Path) -> Result<Arc<StateRuntime>>
```

**Purpose**: This helper opens the test state database in the temporary Codex home folder and prepares it for use. It gives the tests a direct way to read back what the app server saved.

**Data flow**: It receives the path to the temporary Codex home folder. It initializes a `StateRuntime`, which is the state database access layer, using the mock provider name, then marks the database backfill as complete so the test starts from a ready state. It returns a shared database handle that the tests use later to ask for a thread’s saved memory mode.

**Call relations**: Both test functions call this during setup, before starting or exercising the app server. The returned state handle stays outside the server and acts like an independent inspector, letting the tests confirm that server requests changed persistent state.

*Call graph*: calls 1 internal fn (init); called by 2 (thread_memory_mode_set_updates_loaded_thread_state, thread_memory_mode_set_updates_stored_thread_state); 1 external calls (to_path_buf).


##### `create_config_toml`  (lines 113–138)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes the temporary `config.toml` file that makes the app server use the mock model provider and SQLite-backed state during the test. It keeps each test self-contained and prevents it from depending on a developer’s real configuration.

**Data flow**: It receives the temporary Codex home path and the mock server’s URL. It builds the path to `config.toml`, fills in a small TOML configuration string with the mock server URL, and writes that text to disk. The input is an empty or temporary test folder; the output is a config file the app server can read when it starts.

**Call relations**: Both tests call this before creating the test app server. The app server later reads the file as part of its normal startup, so the helper indirectly controls which model endpoint, provider name, sandbox setting, and feature flags the server uses during the test.

*Call graph*: called by 2 (thread_memory_mode_set_updates_loaded_thread_state, thread_memory_mode_set_updates_stored_thread_state); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/thread_metadata_update.rs`

`test` · `test run`

A “thread” is a saved conversation/session, and its Git metadata records what code branch or repository it was tied to. This test file acts like a careful customer using the server over its JSON-RPC API, which is a request-and-response message format. It starts a temporary app server, points it at a fake model provider, creates or loads test threads, sends metadata update requests, and checks the replies.

The main behavior under test is patching: a request can change only selected Git fields, or explicitly clear them. The tests also check that an empty patch is rejected, because it would mean “update nothing,” and that ephemeral threads are rejected, because they are temporary and not meant to have durable metadata edits.

Several tests cover recovery cases. The server stores thread information both in rollout files on disk and in a SQLite database. SQLite is a small file-based database. If the database row is missing but the rollout file still exists, the server should rebuild enough state to apply the metadata change without losing important thread details like preview text and creation time. One test also moves a rollout into the archive folder to confirm archived threads can still be repaired and updated.

#### Function details

##### `thread_metadata_update_patches_git_branch_and_returns_updated_thread`  (lines 39–131)

```
async fn thread_metadata_update_patches_git_branch_and_returns_updated_thread() -> Result<()>
```

**Purpose**: This test checks the happy path for changing a thread’s Git branch. It verifies that the server returns the updated thread immediately and that the same change is still visible when the thread is read afterward.

**Data flow**: It starts with a temporary Codex home folder and a fake model server, then writes a test configuration file. It starts a thread, sends a metadata update containing a new branch name, reads the update response, and compares the returned thread fields against the expected values. Finally, it reads the thread again and confirms the branch was saved rather than only echoed in the first response.

**Call relations**: The test uses create_config_toml to prepare the temporary server setup, then drives TestAppServer through initialize, thread start, metadata update, and thread read requests. It waits for JSON-RPC responses with timeouts so a broken server cannot make the test hang forever.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_metadata_update_rejects_empty_git_info_patch`  (lines 134–177)

```
async fn thread_metadata_update_rejects_empty_git_info_patch() -> Result<()>
```

**Purpose**: This test proves that the server refuses a Git metadata update request that does not actually include any field to change. That matters because accepting a no-op patch could hide client bugs or create unclear behavior.

**Data flow**: It creates a normal thread, then sends a metadata update where sha, branch, and origin URL are all absent. Instead of expecting a successful thread response, it waits for an error response and checks that the message says at least one Git field is required.

**Call relations**: Like the other API tests, it relies on create_config_toml for setup and TestAppServer for sending JSON-RPC requests. It follows the start-thread flow first because the invalid update still needs a real thread id to target.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_metadata_update_rejects_ephemeral_thread`  (lines 180–228)

```
async fn thread_metadata_update_rejects_ephemeral_thread() -> Result<()>
```

**Purpose**: This test checks that temporary, non-persistent threads cannot have their metadata updated. An ephemeral thread is meant to disappear or avoid durable storage, so allowing saved metadata changes would contradict that purpose.

**Data flow**: It starts the app server, creates a thread with the ephemeral flag turned on, and then tries to update that thread’s Git branch. The server returns an error instead of an updated thread. The test checks both the standard invalid-request error code and the message naming the affected thread.

**Call relations**: The test uses the same setup helper and request flow as the successful case, but it changes the thread-start input to request an ephemeral thread. It then follows the error path by reading an error message rather than a normal JSON-RPC response.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_metadata_update_repairs_missing_sqlite_row_for_stored_thread`  (lines 231–281)

```
async fn thread_metadata_update_repairs_missing_sqlite_row_for_stored_thread() -> Result<()>
```

**Purpose**: This test checks that the server can update metadata for a stored thread even when its SQLite database row is missing. The important promise is that the rollout file on disk can be used to rebuild the missing database state.

**Data flow**: It creates a temporary home, enables the state database, and writes a fake rollout file representing a stored thread. Then it starts the server and sends a branch update for that thread id. The returned thread should keep the original preview text and creation time from the rollout while gaining the new Git branch.

**Call relations**: This test calls init_state_db to create and mark the database as ready, then uses create_fake_rollout to create the disk-backed thread without relying on a normal live start request. The metadata update request exercises the server’s repair path before returning the updated thread.

*Call graph*: calls 3 internal fn (new, create_config_toml, init_state_db); 6 external calls (new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `thread_metadata_update_repairs_loaded_thread_without_resetting_summary`  (lines 284–361)

```
async fn thread_metadata_update_repairs_loaded_thread_without_resetting_summary() -> Result<()>
```

**Purpose**: This test covers a more delicate repair case: a thread has already been loaded into the running server, then its database row disappears. The server should repair the missing row and update Git metadata without losing the thread’s existing summary-like fields such as preview and creation time.

**Data flow**: It creates a fake rollout, reconciles it into the state database, starts the server, and resumes the thread so it becomes loaded. Then it deliberately deletes the thread’s database row. After sending a Git branch update, it checks that the returned thread still has the original preview and timestamp while also showing the new branch.

**Call relations**: This test combines init_state_db, create_fake_rollout, ThreadId parsing, and reconcile_rollout to set up a realistic stored thread before the server sees it. It then resumes the thread through TestAppServer, damages the database directly, and uses the metadata update endpoint to confirm the server repairs rather than resets the loaded thread.

*Call graph*: calls 5 internal fn (new, create_config_toml, init_state_db, from_string, reconcile_rollout); 8 external calls (default, new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, rollout_path, assert_eq!, timeout).


##### `thread_metadata_update_repairs_missing_sqlite_row_for_archived_thread`  (lines 364–424)

```
async fn thread_metadata_update_repairs_missing_sqlite_row_for_archived_thread() -> Result<()>
```

**Purpose**: This test verifies that archived threads can still be found, repaired, and updated when their SQLite row is missing. This matters because archived conversations are no longer in the main sessions folder but still need accurate metadata.

**Data flow**: It creates a fake rollout file, then moves that file into the archive directory. With the state database initialized but missing the thread row, it starts the server and sends a Git branch update. The returned thread must match the archived thread’s id, preview, and creation time, plus the new branch.

**Call relations**: The test uses init_state_db to prepare database support and create_fake_rollout plus rollout_path to create and locate the file-based thread. It then moves the file with filesystem operations before using TestAppServer to exercise the same metadata update endpoint on an archived source.

*Call graph*: calls 3 internal fn (new, create_config_toml, init_state_db); 9 external calls (new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, rollout_path, assert_eq!, create_dir_all, rename, timeout).


##### `thread_metadata_update_can_clear_stored_git_fields`  (lines 427–486)

```
async fn thread_metadata_update_can_clear_stored_git_fields() -> Result<()>
```

**Purpose**: This test checks that clients can intentionally remove stored Git metadata fields, not just set them. If all Git fields are cleared, the thread should report no Git metadata at all.

**Data flow**: It creates a fake stored thread that already has a commit hash, branch, and repository URL. Then it sends an update where each field is explicitly set to null, meaning “clear this value.” The update response should show no Git metadata, and a later read of the same thread should also show no Git metadata, proving the clearing was saved.

**Call relations**: The test uses create_fake_rollout to seed existing Git metadata and init_state_db to enable database-backed thread state. It then drives TestAppServer through metadata update and thread read requests to confirm both the immediate response and the persisted state.

*Call graph*: calls 4 internal fn (new, create_config_toml, init_state_db, new); 6 external calls (new, Integer, create_fake_rollout, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `init_state_db`  (lines 488–494)

```
async fn init_state_db(codex_home: &Path) -> Result<Arc<StateRuntime>>
```

**Purpose**: This helper prepares the test SQLite-backed state store for a temporary Codex home folder. It also marks the database backfill as complete so the server treats the database as ready for normal use.

**Data flow**: It receives a path to the temporary Codex home directory. It creates a StateRuntime for that directory and the mock provider, marks backfill complete with no last watermark, and returns the database runtime wrapped in a shared pointer so tests can keep using it.

**Call relations**: The repair and clearing tests call this helper before starting the app server or before manipulating stored thread rows. It hides the repeated database setup steps so each test can focus on the metadata-update behavior it wants to prove.

*Call graph*: calls 1 internal fn (init); called by 4 (thread_metadata_update_can_clear_stored_git_fields, thread_metadata_update_repairs_loaded_thread_without_resetting_summary, thread_metadata_update_repairs_missing_sqlite_row_for_archived_thread, thread_metadata_update_repairs_missing_sqlite_row_for_stored_thread); 1 external calls (to_path_buf).


##### `create_config_toml`  (lines 496–521)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes the minimal configuration file needed for the app server tests. It points the server at the fake model provider and turns on SQLite support.

**Data flow**: It takes the temporary Codex home path and the fake server URL. It builds a config.toml path, fills in a TOML configuration string with the mock model, read-only sandboxing, disabled approvals, SQLite feature flag, and provider URL, then writes that file to disk.

**Call relations**: Every test in this file calls this helper during setup before creating TestAppServer. Without it, the temporary server would not know which model provider to use or that the SQLite-backed thread state feature should be enabled.

*Call graph*: called by 7 (thread_metadata_update_can_clear_stored_git_fields, thread_metadata_update_patches_git_branch_and_returns_updated_thread, thread_metadata_update_rejects_empty_git_info_patch, thread_metadata_update_rejects_ephemeral_thread, thread_metadata_update_repairs_loaded_thread_without_resetting_summary, thread_metadata_update_repairs_missing_sqlite_row_for_archived_thread, thread_metadata_update_repairs_missing_sqlite_row_for_stored_thread); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/thread_name_websocket.rs`

`test` · `test run`

This is a test file for the app server’s WebSocket interface. A WebSocket is a long-lived connection where the server and client can send messages to each other at any time, like an open phone line rather than a single request and reply. These tests focus on thread names: when one client renames a conversation, every connected client should receive a “thread/name/updated” notification.

The tests create a temporary Codex home folder, write a test configuration, and create a fake saved conversation file called a rollout. Then they start a real WebSocket app-server process and connect two test clients to it. Each client sends an initialize request first, so the server knows who is connected.

There are two important cases. In the first, one client resumes the saved thread before renaming it, so the server has loaded that thread into memory. In the second, the thread is renamed without being resumed first, so the server must update a stored thread that is not currently loaded. Both cases should behave the same from the user’s point of view: the requester gets a successful response, both clients receive exactly one update notification, and the legacy stored thread name can be found on disk afterward.

The helper functions keep the tests readable by setting up clients, creating fake rollouts, checking notification contents, and verifying the stored name.

#### Function details

##### `thread_name_updated_broadcasts_for_loaded_threads`  (lines 33–96)

```
async fn thread_name_updated_broadcasts_for_loaded_threads() -> Result<()>
```

**Purpose**: This test proves that renaming a thread that has already been loaded by the server sends an update to every connected WebSocket client. It also checks that the rename is saved in the older on-disk lookup format.

**Data flow**: The test starts with a fake response server, a temporary Codex home folder, a config file, and a fake saved conversation. It launches the WebSocket server, connects two clients, initializes them, and has the first client resume the saved thread. Then the first client sends a rename request. The test reads the response and notifications, checks that both clients received the new name for the same thread ID, checks the stored legacy name on disk, and finally confirms that no extra unexpected messages arrive. At the end, it stops the server process.

**Call relations**: This is one of the main test scenarios in the file. It relies on shared WebSocket test helpers to start the server, connect clients, send requests, and read replies. Inside the scenario it calls initialize_both_clients to prepare both clients, create_rollout to make a saved thread, assert_thread_name_updated to verify each broadcast notification, and assert_legacy_thread_name to confirm the rename was persisted for legacy lookup.

*Call graph*: calls 12 internal fn (assert_no_message, connect_websocket, create_config_toml, read_notification_for_method, read_response_and_notification_for_method, read_response_for_id, send_request, spawn_websocket_server, assert_legacy_thread_name, assert_thread_name_updated (+2 more)); 6 external calls (default, from_millis, new, create_mock_responses_server_repeating_assistant, assert_eq!, to_value).


##### `thread_name_updated_broadcasts_for_not_loaded_threads`  (lines 99–148)

```
async fn thread_name_updated_broadcasts_for_not_loaded_threads() -> Result<()>
```

**Purpose**: This test proves that renaming a saved thread still works even if the server has not loaded that thread into memory first. From the clients’ point of view, the broadcast and saved result should match the loaded-thread case.

**Data flow**: The test creates a fake response server, temporary Codex home, config file, and fake saved conversation. It starts the WebSocket server, connects and initializes two clients, but does not resume the conversation. The first client sends a rename request for the stored thread. The test then reads the successful response, checks that both clients receive the update notification with the expected thread ID and name, checks that the legacy stored name was updated on disk, and confirms no extra messages appear. The server process is killed after the test work finishes.

**Call relations**: This is the companion scenario to thread_name_updated_broadcasts_for_loaded_threads. It uses the same setup and assertion helpers, but deliberately skips the thread resume step so it exercises the server path for stored-but-not-loaded threads.

*Call graph*: calls 11 internal fn (assert_no_message, connect_websocket, create_config_toml, read_notification_for_method, read_response_and_notification_for_method, send_request, spawn_websocket_server, assert_legacy_thread_name, assert_thread_name_updated, create_rollout (+1 more)); 4 external calls (from_millis, new, create_mock_responses_server_repeating_assistant, to_value).


##### `initialize_both_clients`  (lines 150–157)

```
async fn initialize_both_clients(ws1: &mut WsClient, ws2: &mut WsClient) -> Result<()>
```

**Purpose**: This helper signs in two WebSocket test clients with the server before the tests send real thread requests. Without this step, the server may not treat the connections as ready participants.

**Data flow**: It receives two mutable WebSocket clients. For the first client, it sends an initialize request with a client name and waits for the matching response within the default timeout. It then does the same for the second client. If both replies arrive successfully, it returns success; if a reply is missing, late, or invalid, the test fails with an error.

**Call relations**: Both main tests call this helper right after opening their two WebSocket connections. It hands off the actual message sending to send_initialize_request and the response reading to read_response_for_id, wrapping each wait in a timeout so a broken server does not make the test hang forever.

*Call graph*: calls 2 internal fn (read_response_for_id, send_initialize_request); called by 2 (thread_name_updated_broadcasts_for_loaded_threads, thread_name_updated_broadcasts_for_not_loaded_threads); 1 external calls (timeout).


##### `create_rollout`  (lines 159–169)

```
fn create_rollout(codex_home: &std::path::Path, filename_ts: &str) -> Result<String>
```

**Purpose**: This helper creates a fake saved conversation in the temporary test home folder. The tests need that saved conversation so they can rename a realistic existing thread.

**Data flow**: It receives the path to the temporary Codex home and a timestamp-like string used in the fake rollout filename. It passes fixed sample conversation details, such as a saved user message and provider name, into the test-support rollout creator. The result is the conversation/thread ID string that the WebSocket tests use in resume and rename requests.

**Call relations**: Both main tests call this during setup before the WebSocket server starts. It delegates the real file creation to create_fake_rollout_with_text_elements, keeping the test bodies focused on WebSocket behavior rather than fixture-building details.

*Call graph*: called by 2 (thread_name_updated_broadcasts_for_loaded_threads, thread_name_updated_broadcasts_for_not_loaded_threads); 2 external calls (new, create_fake_rollout_with_text_elements).


##### `assert_thread_name_updated`  (lines 171–181)

```
fn assert_thread_name_updated(
    notification: JSONRPCNotification,
    thread_id: &str,
    thread_name: &str,
) -> Result<()>
```

**Purpose**: This helper checks that a WebSocket notification really says the expected thread was renamed to the expected value. It turns a raw JSON-RPC notification into the typed notification shape used by the protocol.

**Data flow**: It receives a JSON-RPC notification, an expected thread ID, and an expected thread name. It reads the notification parameters, converts them from JSON into a ThreadNameUpdatedNotification, and compares the actual thread ID and thread name with the expected values. If they match, it returns success; if not, the test assertion fails.

**Call relations**: Both main tests use this after reading “thread/name/updated” messages from each client. The reading helpers find the right notification on the WebSocket, and this function performs the content check so the tests can clearly say what they expect.

*Call graph*: called by 2 (thread_name_updated_broadcasts_for_loaded_threads, thread_name_updated_broadcasts_for_not_loaded_threads); 2 external calls (assert_eq!, from_value).


##### `assert_legacy_thread_name`  (lines 183–196)

```
async fn assert_legacy_thread_name(
    codex_home: &Path,
    conversation_id: &str,
    expected_name: &str,
) -> Result<()>
```

**Purpose**: This helper verifies that the renamed thread can still be found through the older thread-name lookup path. It protects compatibility with code that reads names from the legacy storage location.

**Data flow**: It receives the temporary Codex home path, a conversation ID string, and the expected name. It converts the conversation ID string into a ThreadId, asks the core code to find the stored name for that thread, and compares the returned value with the expected name. If the stored name matches, it returns success; otherwise the test fails.

**Call relations**: Both main tests call this after checking the WebSocket notifications. That ordering shows the full expected story: the server replies, clients are notified, and the renamed value is also persisted where find_thread_name_by_id can retrieve it.

*Call graph*: calls 1 internal fn (from_string); called by 2 (thread_name_updated_broadcasts_for_loaded_threads, thread_name_updated_broadcasts_for_not_loaded_threads); 1 external calls (assert_eq!).


### `app-server/tests/suite/v2/thread_rollback.rs`

`test` · `test run`

This is an integration test for the app server’s thread rollback feature. A “thread” is a saved conversation, and a “turn” is one user message plus the assistant’s reply. The test creates a temporary server setup with a fake model provider, so no real AI service is contacted. The fake provider always returns a simple final assistant message, which makes the test predictable.

The test starts a new thread, sends two user turns, waits for both to complete, and then asks the server to roll back one turn. In everyday terms, it is checking that pressing “undo last exchange” really removes the most recent exchange and leaves the earlier one intact.

After the rollback, the test checks several important promises: the thread is idle, only the first turn remains, the first user message is still correct, and the thread’s session identity did not change. It also checks a wire-format detail: if the thread has no title, the API must still include the title field as `name: null`. That matters because clients may rely on that exact shape.

Finally, the test resumes the same thread and confirms the rollback was persisted to disk, not just changed in memory. Without this test, the server could appear to roll back correctly but bring the removed turn back after reload.

#### Function details

##### `thread_rollback_drops_last_turns_and_persists_to_rollout`  (lines 26–182)

```
async fn thread_rollback_drops_last_turns_and_persists_to_rollout() -> Result<()>
```

**Purpose**: This test proves that rolling back a thread removes the latest turn, keeps earlier conversation history, returns the expected API data, and saves the change for later resume. It is used to catch regressions where rollback only partly works or produces a response clients cannot understand.

**Data flow**: It starts with three prepared fake assistant responses and a temporary Codex home directory. It writes a test configuration that points the app server at the fake model server, starts the app server, creates a thread, sends two text turns, and waits for completion messages. It then sends a rollback request for one turn and inspects the returned thread. The expected outcome is that only the first turn remains, the thread is idle, the session id is unchanged, and the serialized JSON contains `name: null`. It then resumes the thread from storage and checks the same shortened history again, proving the rollback was saved.

**Call relations**: This is the main test scenario in the file. It calls `create_config_toml` during setup so the test server talks to the mock model provider. It also uses the test support helpers to create mock responses, start the app server, send thread and turn requests, wait for JSON-RPC responses, and convert those responses into typed thread objects before making assertions.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, panic!, timeout, vec!).


##### `create_config_toml`  (lines 184–205)

```
fn create_config_toml(codex_home: &std::path::Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes the small configuration file needed for the test server to use the fake model provider instead of a real external service. It keeps the test setup readable and repeatable.

**Data flow**: It receives the temporary Codex home folder path and the mock server’s address. From those, it builds a `config.toml` path and writes configuration text into that file. The written file selects the mock model, disables approval prompts, uses read-only sandboxing, and points model requests at the mock server URL. It returns success or an input/output error if the file cannot be written.

**Call relations**: The rollback test calls this helper before starting `TestAppServer`. Once the file is written, the app server reads it during startup and routes its model calls to the mock responses server, which makes the rest of the test deterministic.

*Call graph*: called by 1 (thread_rollback_drops_last_turns_and_persists_to_rollout); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/thread_settings_update.rs`

`test` · `test run`

A “thread” here is a conversation session with its own settings, such as which model to use, which service tier to request, what working directory should be treated as the default workspace, and what sandbox rules apply. This test file acts like a client talking to the app server through JSON-RPC, which is a request-and-response message format. It also uses mock model servers, so the tests can inspect exactly what the app server would have sent to the model provider without calling a real external service.

The main idea is simple: start a test server, create a thread, change that thread’s settings, then check two things. First, the server should send a `thread/settings/updated` notification so clients can update their UI. Second, later turns in the conversation should actually use the new settings when making model requests.

The tests cover important behavior that users would notice if it broke. Updating only settings should not accidentally start a model call. Changing `cwd`, the current working directory, should change the environment context shown to the model. Updating settings during an active turn should still notify the client. Clearing service tier should go back to the default request behavior. The helper functions at the bottom keep the tests readable by wrapping common actions like starting a thread, starting a text turn, reading notifications, and collecting mock request bodies.

#### Function details

##### `thread_settings_update_emits_notification_and_updates_future_turns`  (lines 37–95)

```
async fn thread_settings_update_emits_notification_and_updates_future_turns() -> Result<()>
```

**Purpose**: This test proves that changing a thread’s model and service tier sends a settings-updated notification and affects later turns. It also proves that merely changing settings does not itself trigger a model request.

**Data flow**: It creates a fake model server, a temporary Codex home folder, test configuration, and cached model data. It starts the app server, starts a thread, sends a settings update with a chosen model and service tier, then checks the mock server has not yet received a model request. After starting a normal text turn, it reads the settings notification, reads the saved thread, and inspects the outgoing model request body to confirm the new model and service tier were used.

**Call relations**: This is one of the main end-to-end tests in the file. It relies on `create_config_toml` for setup, `service_tier_model_and_tier_id` to pick a real catalog option, `start_thread` and `start_text_turn` to drive the server like a client would, `send_thread_settings_update` to perform the update, `read_thread_settings_updated` to observe the notification, `read_thread_with_turns` to verify persisted conversation state, and `received_response_bodies` to inspect what the app server sent to the fake model endpoint.

*Call graph*: calls 9 internal fn (new, create_config_toml, read_thread_settings_updated, read_thread_with_turns, received_response_bodies, send_thread_settings_update, service_tier_model_and_tier_id, start_text_turn, start_thread); 8 external calls (default, new, create_mock_responses_server_sequence_unchecked, write_models_cache, assert!, assert_eq!, timeout, vec!).


##### `thread_settings_update_cwd_retargets_default_environment`  (lines 98–148)

```
async fn thread_settings_update_cwd_retargets_default_environment() -> Result<()>
```

**Purpose**: This test checks that changing a thread’s working directory changes the environment information sent to the model on the next turn. In plain terms, it makes sure the model is told about the newly selected workspace folder.

**Data flow**: It starts a mock response server and creates temporary folders for the app’s home and a separate workspace. After starting a thread, it sends a settings update with the workspace path as `cwd`. It reads the resulting notification, starts a text turn, waits for completion, then looks inside the mock model request for the visible environment context and checks that it contains the updated path.

**Call relations**: This test uses `create_config_toml` and `start_thread` to prepare a normal conversation, then calls `send_thread_settings_update` and `read_thread_settings_updated` to confirm the server accepted the new working directory. It uses `start_text_turn` to force the app server to build a model request, and the mounted mock response lets the test inspect the user-visible environment text that was sent.

*Call graph*: calls 9 internal fn (new, create_config_toml, read_thread_settings_updated, send_thread_settings_update, start_text_turn, start_thread, mount_sse_once, sse, start_mock_server); 6 external calls (default, new, assert!, assert_eq!, timeout, vec!).


##### `thread_settings_update_while_turn_is_active_emits_notification`  (lines 151–190)

```
async fn thread_settings_update_while_turn_is_active_emits_notification() -> Result<()>
```

**Purpose**: This test checks that a settings update still produces a notification even while a model turn is already running. That matters because clients should stay in sync even during long-running assistant work.

**Data flow**: It sets up a mock model response that waits before finishing, starts the app server and a thread, then starts a text turn. Once the server reports that the turn has started, it sends a model-setting update. The test reads the settings-updated notification and verifies it contains the new model, then waits for the original turn to finish.

**Call relations**: This test combines `start_text_turn` with a deliberately delayed mock response to create an active-turn situation. While that turn is in progress, it uses `send_thread_settings_update` and `read_thread_settings_updated` to show that settings notifications are not blocked by ongoing work. `create_config_toml` and `start_thread` provide the standard setup.

*Call graph*: calls 9 internal fn (new, create_config_toml, read_thread_settings_updated, send_thread_settings_update, start_text_turn, start_thread, mount_response_sequence, sse_response, start_mock_server); 7 external calls (default, from_secs, new, create_final_assistant_message_sse_response, assert_eq!, timeout, vec!).


##### `thread_settings_update_null_service_tier_uses_default`  (lines 193–261)

```
async fn thread_settings_update_null_service_tier_uses_default() -> Result<()>
```

**Purpose**: This test checks what happens when a client clears a previously chosen service tier. The expected behavior is that the thread reports the default service tier setting, and later model requests omit the explicit `service_tier` field.

**Data flow**: It starts with a model and service tier chosen from the bundled model catalog. It updates the thread to use that service tier and confirms the notification shows it. Then it sends another update where `service_tier` is explicitly set to null, reads the next notification, and checks that the thread now shows the default request value. Finally, it starts a turn and inspects the outgoing model request to confirm the model is still set but no explicit service tier is sent.

**Call relations**: This test uses `service_tier_model_and_tier_id` to choose a valid service-tier example, `send_thread_settings_update` twice to first set and then clear the setting, and `read_thread_settings_updated` after each change to verify what clients would see. It then uses `start_text_turn` and `received_response_bodies` to confirm that the app server’s future provider request matches the cleared setting.

*Call graph*: calls 8 internal fn (new, create_config_toml, read_thread_settings_updated, received_response_bodies, send_thread_settings_update, service_tier_model_and_tier_id, start_text_turn, start_thread); 8 external calls (default, new, create_mock_responses_server_sequence_unchecked, write_models_cache, assert!, assert_eq!, timeout, vec!).


##### `thread_settings_update_rejects_sandbox_policy_with_permissions`  (lines 264–292)

```
async fn thread_settings_update_rejects_sandbox_policy_with_permissions() -> Result<()>
```

**Purpose**: This test verifies that the server rejects a settings update that provides both a sandbox policy and a permissions string. These two settings are overlapping ways to describe what the assistant may access, so accepting both could be ambiguous.

**Data flow**: It starts a test app server and a thread. It sends a thread settings update request containing both `sandbox_policy` and `permissions`, then waits for an error response instead of a success response. The test checks that the error message clearly says the two options cannot be combined.

**Call relations**: Unlike the helper `send_thread_settings_update`, this test sends the request directly because it expects failure rather than a normal typed response. It still uses `create_config_toml` and `start_thread` for setup, then reads the JSON-RPC error message from the app server stream.

*Call graph*: calls 3 internal fn (new, create_config_toml, start_thread); 7 external calls (default, new, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, timeout).


##### `turn_start_settings_override_emits_thread_settings_updated`  (lines 295–342)

```
async fn turn_start_settings_override_emits_thread_settings_updated() -> Result<()>
```

**Purpose**: This test checks that starting a turn with a settings override, such as a different model, also updates the thread settings and notifies clients. This matters because a one-step action from the client can both start work and change what future work should use.

**Data flow**: It starts the app server and a thread, waits for the thread-started notification, then sends a turn-start request that includes text input and a model override. It reads the turn-start response to ensure a turn was created. Next it reads the settings-updated notification and checks that the thread now reports the override model, then waits for the turn to complete.

**Call relations**: This test uses `start_thread` for the initial conversation and `read_thread_settings_updated` to observe the side effect of `turn/start`. It does not use `start_text_turn` because it needs to send a custom turn-start request with a model override and inspect the direct response.

*Call graph*: calls 4 internal fn (new, create_config_toml, read_thread_settings_updated, start_thread); 9 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert!, assert_eq!, timeout, vec!).


##### `send_thread_settings_update`  (lines 344–356)

```
async fn send_thread_settings_update(
    mcp: &mut TestAppServer,
    params: ThreadSettingsUpdateParams,
) -> Result<()>
```

**Purpose**: This helper sends a thread settings update request and waits for the normal success response. It keeps the tests focused on their intent instead of repeating request-and-response boilerplate.

**Data flow**: It receives a mutable test app server connection and the settings-update parameters. It sends the request, waits up to the shared timeout for the matching JSON-RPC response, converts that response into a `ThreadSettingsUpdateResponse`, and returns success if all of that worked.

**Call relations**: The tests call this helper whenever they expect the settings update to succeed. Internally it hands the request to the test server, waits for `read_stream_until_response_message`, and uses `to_response` to turn the generic JSON-RPC response into the specific response type the protocol promises.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_settings_update_request); called by 4 (thread_settings_update_cwd_retargets_default_environment, thread_settings_update_emits_notification_and_updates_future_turns, thread_settings_update_null_service_tier_uses_default, thread_settings_update_while_turn_is_active_emits_notification); 3 external calls (Integer, to_response, timeout).


##### `start_text_turn`  (lines 358–377)

```
async fn start_text_turn(mcp: &mut TestAppServer, thread_id: String) -> Result<()>
```

**Purpose**: This helper starts a simple user text turn saying “hello” and verifies that the server created a turn. It is used when a test needs to trigger an actual model request after settings have changed.

**Data flow**: It receives the test app server and a thread ID. It sends a `turn/start` request with one text input, waits for the response, converts it into a `TurnStartResponse`, checks that the returned turn has a non-empty ID, and then returns success.

**Call relations**: Several tests call this helper after changing settings because the next turn is where those settings should take effect. It sends the turn-start request through the test app server, waits for the matching response message, and leaves later notification checks, such as waiting for turn completion, to the calling test.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_turn_start_request); called by 4 (thread_settings_update_cwd_retargets_default_environment, thread_settings_update_emits_notification_and_updates_future_turns, thread_settings_update_null_service_tier_uses_default, thread_settings_update_while_turn_is_active_emits_notification); 6 external calls (default, Integer, to_response, assert!, timeout, vec!).


##### `start_thread`  (lines 379–392)

```
async fn start_thread(mcp: &mut TestAppServer) -> Result<ThreadStartResponse>
```

**Purpose**: This helper starts a new conversation thread using the default mock model for these tests. It gives each test a clean thread to update and inspect.

**Data flow**: It receives the test app server, sends a `thread/start` request with model `mock-model`, waits for the response, converts the JSON-RPC response into a `ThreadStartResponse`, and returns that typed result to the caller.

**Call relations**: Almost every test begins by calling this helper after app server initialization. It hides the repeated protocol details of creating a thread, so the tests can concentrate on settings-update behavior.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_start_request); called by 6 (thread_settings_update_cwd_retargets_default_environment, thread_settings_update_emits_notification_and_updates_future_turns, thread_settings_update_null_service_tier_uses_default, thread_settings_update_rejects_sandbox_policy_with_permissions, thread_settings_update_while_turn_is_active_emits_notification, turn_start_settings_override_emits_thread_settings_updated); 4 external calls (default, Integer, to_response, timeout).


##### `read_thread_with_turns`  (lines 394–410)

```
async fn read_thread_with_turns(
    mcp: &mut TestAppServer,
    thread_id: &str,
) -> Result<ThreadReadResponse>
```

**Purpose**: This helper asks the app server to read a thread and include its turns. It is useful when a test needs to confirm that conversation history was saved as expected.

**Data flow**: It receives the test app server and a thread ID. It sends a `thread/read` request with `include_turns` set to true, waits for the response, converts it into a `ThreadReadResponse`, and returns the thread data to the caller.

**Call relations**: Only the main future-turns test calls this helper, after a turn completes. It confirms that the server’s stored thread now contains the expected turn, while other helpers and mock-server checks verify notification and provider-request behavior.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_read_request); called by 1 (thread_settings_update_emits_notification_and_updates_future_turns); 3 external calls (Integer, to_response, timeout).


##### `read_thread_settings_updated`  (lines 412–424)

```
async fn read_thread_settings_updated(
    mcp: &mut TestAppServer,
) -> Result<ThreadSettingsUpdatedNotification>
```

**Purpose**: This helper waits for the next `thread/settings/updated` notification and turns its JSON payload into a typed notification object. It represents what a real client would listen for to keep its display in sync.

**Data flow**: It receives the test app server, waits for a notification named `thread/settings/updated`, checks that the notification includes parameters, deserializes those parameters into `ThreadSettingsUpdatedNotification`, and returns that typed value.

**Call relations**: Most tests call this right after an action that should change thread settings, such as `send_thread_settings_update` or a turn start with an override. It sits between the generic message stream and the test assertions by translating raw notification data into a clear Rust type.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 5 (thread_settings_update_cwd_retargets_default_environment, thread_settings_update_emits_notification_and_updates_future_turns, thread_settings_update_null_service_tier_uses_default, thread_settings_update_while_turn_is_active_emits_notification, turn_start_settings_override_emits_thread_settings_updated); 2 external calls (from_value, timeout).


##### `received_response_bodies`  (lines 426–438)

```
async fn received_response_bodies(server: &wiremock::MockServer) -> Result<Vec<Value>>
```

**Purpose**: This helper gathers the JSON request bodies that the app server sent to the mock model provider’s `/responses` endpoint. It lets tests verify the real outbound model request, not just the app server’s internal state.

**Data flow**: It receives a mock server, asks it for all received requests, filters down to requests whose path ends in `/responses`, parses each matching request body as JSON, and returns the list of JSON values.

**Call relations**: The service-tier tests call this after settings updates and turns. It provides the evidence needed to say whether future model calls actually used, or omitted, fields like `model` and `service_tier`.

*Call graph*: called by 2 (thread_settings_update_emits_notification_and_updates_future_turns, thread_settings_update_null_service_tier_uses_default); 2 external calls (received_requests, new).


##### `service_tier_model_and_tier_id`  (lines 440–446)

```
fn service_tier_model_and_tier_id() -> Result<(String, String)>
```

**Purpose**: This helper finds a bundled model preset that is visible in the model picker and has at least one service tier. It gives the tests a realistic model-and-tier pair instead of hard-coding one that might disappear.

**Data flow**: It reads all model presets from the test support catalog, searches for a preset that should appear in the picker and includes service tiers, then returns the model ID and the first service tier ID. If no such preset exists, it returns an error explaining that the catalog is missing the needed test data.

**Call relations**: The tests that verify service-tier behavior call this during setup. It connects those tests to the same model catalog logic the app uses, while keeping the test body independent of specific catalog names.

*Call graph*: calls 1 internal fn (all_model_presets); called by 2 (thread_settings_update_emits_notification_and_updates_future_turns, thread_settings_update_null_service_tier_uses_default).


##### `create_config_toml`  (lines 448–458)

```
fn create_config_toml(codex_home: &std::path::Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes a test configuration file that points the app server at the mock responses server. Without it, the app server would not know where to send model requests during the test.

**Data flow**: It receives the temporary Codex home path and the mock server URI. It writes a TOML configuration file, which is a simple text configuration format, using the mock provider name, a compaction model name, an auto-compact limit, and default extra settings. It returns an I/O result showing whether the file write succeeded.

**Call relations**: Every test calls this before starting the test app server. It is the setup bridge between the temporary test directory and the app server’s normal configuration-loading path, ensuring that later requests go to the controlled mock server.

*Call graph*: called by 6 (thread_settings_update_cwd_retargets_default_environment, thread_settings_update_emits_notification_and_updates_future_turns, thread_settings_update_null_service_tier_uses_default, thread_settings_update_rejects_sandbox_policy_with_permissions, thread_settings_update_while_turn_is_active_emits_notification, turn_start_settings_override_emits_thread_settings_updated); 2 external calls (default, write_mock_responses_config_toml).


### `app-server/tests/suite/v2/thread_unarchive.rs`

`test` · `test run`

A “thread” here is a saved conversation session. The app can archive a thread, which moves it out of the normal sessions location, and later unarchive it, which should make it visible and usable again. This test file makes sure that round trip works in two important situations.

The first test uses a temporary Codex home folder and a mock model server, like a small fake version of the real app. It starts a thread, sends a user message so the thread is written to disk, archives it, then unarchives it. The test checks the practical promises users depend on: the saved rollout file comes back to the sessions directory, the archived copy disappears, the thread’s update time is refreshed, the thread is reported as not currently loaded, and the JSON response includes `name: null` when there is no title.

The second test covers a different storage style: an in-memory thread store. That is a temporary store kept in process memory instead of regular files on disk. It creates a thread with metadata, including its parent thread and name, then asks the app server to unarchive it. The key point is that unarchiving should not invent a path or lose metadata for pathless threads.

Small helper functions write test configuration files, build provider settings, compare real filesystem paths, and clean up the shared in-memory store after the test.

#### Function details

##### `thread_unarchive_moves_rollout_back_into_sessions_directory`  (lines 57–198)

```
async fn thread_unarchive_moves_rollout_back_into_sessions_directory() -> Result<()>
```

**Purpose**: This test proves that unarchiving a normal, file-backed thread restores its saved conversation file to the active sessions directory. It also checks the response and notification sent by the server so the external API contract stays stable.

**Data flow**: It starts with a temporary home folder and a mock assistant server that always replies. The test writes a config file, starts the test app server, creates a thread, sends a message so the thread is saved to disk, archives it, manually makes the archived file look old, then sends an unarchive request. The result should be a thread response with a newer update time, status set to not loaded, `name` serialized as JSON null when unset, a `thread/unarchived` notification, the restored active file present on disk, and the archived file gone.

**Call relations**: This is the main end-to-end test in the file. It uses `create_config_toml` to prepare the temporary app configuration and `assert_paths_match_on_disk` to confirm the thread path found by the app is the same real file path returned when the thread was started. It drives the app through the same request and response flow a real client would use.

*Call graph*: calls 3 internal fn (new, assert_paths_match_on_disk, create_config_toml); 14 external calls (default, from_secs, new, new, new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, find_archived_thread_path_by_id_str (+4 more)).


##### `thread_unarchive_preserves_pathless_store_metadata`  (lines 201–293)

```
async fn thread_unarchive_preserves_pathless_store_metadata() -> Result<()>
```

**Purpose**: This test proves that unarchiving still works for a thread stored only in an in-memory thread store, where there is no rollout file path to move. It protects metadata such as the thread name and parent relationship from being lost during unarchive.

**Data flow**: It creates a temporary home folder, gives the in-memory store a unique ID, writes a config that tells the server to use that store, and inserts a thread directly into the store with known metadata. Then it starts an in-process app server and sends a thread unarchive request. The returned thread should keep the same ID, have no path, keep its `forked_from_id`, and keep its name. At the end it shuts the client down.

**Call relations**: This test uses `create_config_toml_with_in_memory_thread_store` to point the app at a named in-memory store. It also creates an `InMemoryThreadStoreId` guard so the store is removed automatically later. Instead of using the higher-level test server helper, it starts the app server in-process and sends a direct protocol request.

*Call graph*: calls 9 internal fn (start, create_config_toml_with_in_memory_thread_store, default, without_managed_config_for_tests, default_for_tests, new, default, from_string, for_id); 10 external calls (new, default, new, new_v4, new, Integer, default, assert_eq!, default, from_value).


##### `create_config_toml`  (lines 295–298)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes the small configuration file needed by the file-backed unarchive test. It tells the app which mock model provider to use and keeps the test isolated inside the temporary home folder.

**Data flow**: It receives the temporary Codex home path and the mock server URL. It builds the path to `config.toml`, asks `config_contents` to produce the file text, writes that text to disk, and returns whether the write succeeded.

**Call relations**: The first end-to-end test calls this before starting the test app server. It delegates the actual text construction to `config_contents`, keeping the test setup readable.

*Call graph*: calls 1 internal fn (config_contents); called by 1 (thread_unarchive_moves_rollout_back_into_sessions_directory); 2 external calls (join, write).


##### `InMemoryThreadStoreId::drop`  (lines 305–307)

```
fn drop(&mut self)
```

**Purpose**: This cleanup hook removes the named in-memory thread store when the test guard goes out of scope. It prevents one test’s temporary store data from leaking into later tests.

**Data flow**: It reads the stored `store_id` from the guard object just before that object is destroyed. It passes that ID to the in-memory store registry so the matching store is removed. It does not return a value; its effect is cleanup.

**Call relations**: The pathless-store test creates an `InMemoryThreadStoreId` value after choosing a unique store ID. Rust automatically calls this `drop` method at the end of the scope, so the test does not need an explicit cleanup call.

*Call graph*: calls 1 internal fn (remove_id).


##### `create_config_toml_with_in_memory_thread_store`  (lines 310–334)

```
fn create_config_toml_with_in_memory_thread_store(
    codex_home: &Path,
    store_id: &str,
) -> std::io::Result<()>
```

**Purpose**: This helper writes a configuration file that tells the app server to use a specific in-memory thread store. It is used to test unarchive behavior without relying on thread files on disk.

**Data flow**: It receives the temporary Codex home path and an in-memory store ID. It formats a `config.toml` string that includes model settings plus `experimental_thread_store` set to the given in-memory ID, writes the file into the temporary home directory, and returns whether the write succeeded.

**Call relations**: The pathless metadata test calls this before building and starting the in-process app server. The configuration it writes is what connects the server under test to the in-memory store that the test populated directly.

*Call graph*: called by 1 (thread_unarchive_preserves_pathless_store_metadata); 3 external calls (join, format!, write).


##### `config_contents`  (lines 336–352)

```
fn config_contents(server_uri: &str) -> String
```

**Purpose**: This helper builds the text of a test `config.toml` file for the normal file-backed server test. It points the app at the mock model server instead of a real external service.

**Data flow**: It receives the mock server base URL and inserts it into a TOML configuration string. The returned string contains the model name, approval and sandbox settings, provider name, provider URL, wire format, and retry settings.

**Call relations**: `create_config_toml` calls this when it needs the exact configuration text to write. Keeping it separate makes the first test’s setup shorter and makes the mock provider settings easy to see in one place.

*Call graph*: called by 1 (create_config_toml); 1 external calls (format!).


##### `assert_paths_match_on_disk`  (lines 354–359)

```
fn assert_paths_match_on_disk(actual: &Path, expected: &Path) -> std::io::Result<()>
```

**Purpose**: This helper checks that two paths point to the same real file on disk, even if their text forms differ. It avoids false failures caused by relative paths, symlinks, or other path spelling differences.

**Data flow**: It receives two filesystem paths. It canonicalizes each one, meaning it asks the operating system for the full real path, then compares the two canonical paths. If they match, it returns success; if not, the assertion fails the test.

**Call relations**: The file-backed unarchive test calls this after locating the thread by ID. It verifies that the server’s lookup mechanism finds the same rollout file path that was returned when the thread was first created.

*Call graph*: called by 1 (thread_unarchive_moves_rollout_back_into_sessions_directory); 2 external calls (canonicalize, assert_eq!).


### `app-server/tests/suite/v2/thread_unsubscribe.rs`

`test` · `test run`

This test file checks a subtle but important promise: “unsubscribe” should mean “stop sending me updates for this thread,” not “kill the thread right now.” A thread is a conversation session. The server may keep it loaded in memory for a short idle period so it can be resumed quickly, like leaving a notebook open on a desk after someone walks away.

The tests start a fake app server, point it at fake model-response servers, and then drive it through the same JSON-RPC messages a real client would send. JSON-RPC is a simple request-and-response message format. The tests verify that after unsubscribe, the thread remains loaded for a while, no immediate “thread closed” notification appears, and the thread can still report useful state.

One test covers an active turn that is waiting on a dynamic tool call. A dynamic tool is a client-provided action the model asks the client to run. The test confirms that unsubscribing while the tool is waiting does not cancel the turn; once the client replies with the tool result, the server continues to the final model response.

Helper functions create a temporary config file, start a thread, and wait until the specific tool call appears in the notification stream.

#### Function details

##### `thread_unsubscribe_keeps_thread_loaded_until_idle_timeout`  (lines 40–86)

```
async fn thread_unsubscribe_keeps_thread_loaded_until_idle_timeout() -> Result<()>
```

**Purpose**: This test proves that unsubscribing from a thread does not immediately unload or close it. A client should be able to stop listening while the server keeps the thread available during its idle timeout window.

**Data flow**: It creates a fake model server, writes a temporary config pointing to it, starts a test app server, and opens a new thread. It sends an unsubscribe request for that thread, checks that the response says the client was unsubscribed, then waits briefly to make sure no “thread closed” notification arrives. Finally it asks for the list of loaded threads and expects to see the same thread still present.

**Call relations**: This is one of the main end-to-end checks in the file. It uses create_config_toml to make the server use the mock model endpoint and start_thread to avoid repeating the thread-starting ceremony. It then exercises the app server’s unsubscribe and loaded-list APIs in the order a real client might use them.

*Call graph*: calls 3 internal fn (new, create_config_toml, start_thread); 7 external calls (new, Integer, default, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout).


##### `thread_unsubscribe_during_turn_keeps_turn_running`  (lines 89–243)

```
async fn thread_unsubscribe_during_turn_keeps_turn_running() -> Result<()>
```

**Purpose**: This test checks that unsubscribing during an active model turn does not cancel the work already in progress. This matters because a client may stop watching a thread while the server is still waiting for a tool result or model response.

**Data flow**: It sets up a streaming fake model server that first asks for a dynamic tool call and later returns a final assistant message. The test starts a thread with that tool enabled, starts a turn, waits until the server sends the tool-call request to the client, and then unsubscribes from the thread. It confirms no close notification appears while the tool call is blocked, sends back the tool result, and waits for the fake model server to receive the second request and finish the turn.

**Call relations**: This is the most detailed scenario in the file. It calls create_config_toml for setup and wait_for_dynamic_tool_started to filter the notification stream until the expected tool call begins. After unsubscribe, it hands a DynamicToolCallResponse back to the server so the normal turn flow can continue and prove the unsubscribe did not act like cancellation.

*Call graph*: calls 4 internal fn (new, create_config_toml, wait_for_dynamic_tool_started, start_streaming_sse_server); 13 external calls (default, new, Integer, assert!, assert_eq!, json!, panic!, to_string, to_value, create_dir (+3 more)).


##### `thread_unsubscribe_preserves_cached_status_before_idle_unload`  (lines 246–335)

```
async fn thread_unsubscribe_preserves_cached_status_before_idle_unload() -> Result<()>
```

**Purpose**: This test makes sure a thread’s last known status is still available after unsubscribe, before the thread is eventually unloaded for being idle. In particular, an error status must not be lost just because the client stopped subscribing.

**Data flow**: It starts a fake model server that returns a failed response, creates and initializes the app server, and starts a thread. It begins a turn that is expected to fail, waits for an error notification, then reads the thread and confirms its status is SystemError. After unsubscribing, it checks that no immediate close notification appears, resumes the same thread, and verifies the resumed thread still reports SystemError.

**Call relations**: This test uses create_config_toml and start_thread for the common setup path. It then combines thread read, unsubscribe, and resume requests to check the server’s cached thread state across those steps. Its role is to protect the behavior that unsubscribe only changes the subscription, not the remembered thread status.

*Call graph*: calls 6 internal fn (new, create_config_toml, start_thread, mount_sse_once, sse_failed, start_mock_server); 7 external calls (default, new, Integer, assert!, assert_eq!, timeout, vec!).


##### `thread_unsubscribe_reports_not_subscribed_before_idle_unload`  (lines 338–379)

```
async fn thread_unsubscribe_reports_not_subscribed_before_idle_unload() -> Result<()>
```

**Purpose**: This test checks the server’s answer when a client unsubscribes twice from the same thread. The first request should succeed, and the second should clearly say there was no active subscription left.

**Data flow**: It creates a mock model server, writes config, starts the app server, and opens a thread. It sends one unsubscribe request and expects an Unsubscribed status. Then it sends another unsubscribe request for the same thread and expects NotSubscribed, showing the server remembers that the subscription was already removed.

**Call relations**: This scenario reuses create_config_toml and start_thread, like the other simpler tests. It focuses only on the status value returned by repeated unsubscribe calls, which helps clients distinguish “I just unsubscribed you” from “you were not subscribed anymore.”

*Call graph*: calls 3 internal fn (new, create_config_toml, start_thread); 5 external calls (new, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, timeout).


##### `wait_for_dynamic_tool_started`  (lines 381–397)

```
async fn wait_for_dynamic_tool_started(
    mcp: &mut TestAppServer,
    call_id: &str,
) -> Result<ItemStartedNotification>
```

**Purpose**: This helper waits until the server reports that a particular dynamic tool call has started. It is used when a test needs to pause at the exact moment the model has requested a client-side tool.

**Data flow**: It repeatedly reads “item/started” notifications from the app server stream. For each notification, it tries to decode the notification data and checks whether the started item is a dynamic tool call with the requested call ID. Notifications without useful data, or for other items, are skipped. When the matching tool call appears, it returns the decoded notification.

**Call relations**: thread_unsubscribe_during_turn_keeps_turn_running calls this helper after starting a turn. The helper shields that test from unrelated stream messages, so the test can continue only once the specific tool call it cares about is actually waiting.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 1 (thread_unsubscribe_during_turn_keeps_turn_running); 2 external calls (matches!, from_value).


##### `create_config_toml`  (lines 399–420)

```
fn create_config_toml(codex_home: &std::path::Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes the temporary configuration file needed by the test app server. It tells the server to use the mock model provider instead of a real external service.

**Data flow**: It receives a temporary Codex home directory and the fake server’s URI. It builds the path to config.toml and writes a small TOML configuration file there, including the mock model name, permissive test sandbox settings, and the fake provider base URL. It returns an I/O result indicating whether the file write succeeded.

**Call relations**: All four main tests call this during setup before starting TestAppServer. The rest of each test depends on this file being present, because it redirects model traffic to controlled test servers and disables retries that could make test timing harder to reason about.

*Call graph*: called by 4 (thread_unsubscribe_during_turn_keeps_turn_running, thread_unsubscribe_keeps_thread_loaded_until_idle_timeout, thread_unsubscribe_preserves_cached_status_before_idle_unload, thread_unsubscribe_reports_not_subscribed_before_idle_unload); 3 external calls (join, format!, write).


##### `start_thread`  (lines 422–436)

```
async fn start_thread(mcp: &mut TestAppServer) -> Result<String>
```

**Purpose**: This helper starts a new thread through the same server API a real client would use. It keeps the tests focused on unsubscribe behavior instead of repeating the request-and-response boilerplate for creating a thread.

**Data flow**: It sends a thread-start request with the mock model name, waits for the matching response message with a timeout, decodes that response into a thread-start result, and returns the new thread’s ID. If the server does not answer or the response cannot be decoded, the error is passed back to the test.

**Call relations**: The simpler unsubscribe tests call this after the app server has been initialized. It hands them a valid thread ID, which they then use for unsubscribe, read, resume, or loaded-list requests.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_start_request); called by 3 (thread_unsubscribe_keeps_thread_loaded_until_idle_timeout, thread_unsubscribe_preserves_cached_status_before_idle_unload, thread_unsubscribe_reports_not_subscribed_before_idle_unload); 3 external calls (default, Integer, timeout).


### Turn execution and interaction
These tests follow active execution within a thread, from turn start through interruption, steering, injected history, structured outputs, and model-driven client interactions.

### `app-server/tests/suite/v2/client_metadata.rs`

`test` · `test execution`

These are integration tests: they start a real test app server, point it at a fake Responses API server, make JSON-RPC calls to the app server, and then inspect what the app server sent onward. The main thing being checked is the `x-codex-turn-metadata` data. That metadata is like a shipping label on each model request: it says which turn, session, window, thread, fork, parent, or client run the request belongs to.

The file covers several paths. A normal turn should forward client-supplied metadata, while also adding server-generated fields such as the turn id and session id. A forked thread should report which original thread it came from. A review request should be marked as a review subagent and should use parent-thread metadata correctly. A resumed subagent thread should preserve its parent and subagent kind. A steered turn should update metadata on the follow-up model request without changing the turn id. The same checks are repeated for both ordinary HTTP streaming and WebSocket request bodies.

Without these tests, a change in the server could silently drop or mislabel metadata. That would make tracing, analytics, review attribution, and fork/subagent lineage unreliable even though the model response itself might still appear to work.

#### Function details

##### `turn_start_forwards_client_metadata_to_responses_request_v2`  (lines 41–123)

```
async fn turn_start_forwards_client_metadata_to_responses_request_v2() -> Result<()>
```

**Purpose**: This test proves that when a v2 client starts a turn with extra client metadata, the app server forwards that metadata to the Responses API in the turn metadata header. It also checks that the server adds its own tracing fields, such as the turn id, session id, installation id, and window id.

**Data flow**: The test starts with a fake Responses API server, a temporary Codex home directory, and a test app server configured to use HTTP streaming. It creates a thread, starts a turn with user text and a small metadata map, waits for the turn to finish, then reads the single outgoing request captured by the fake server. The result is a set of assertions showing that the outgoing metadata contains both the client-provided values and the server-generated identifiers.

**Call relations**: The async test runner invokes this test. Inside the test, it uses `create_config_toml` to write a minimal provider configuration, uses the mock response helpers to stand in for the external Responses API, and uses `parse_json_header` to turn the captured metadata header back into JSON so it can be checked.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once, sse, start_mock_server); 10 external calls (default, from, new, Integer, default, assert!, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `turn_start_sends_fork_lineage_in_turn_metadata_for_thread_fork_v2`  (lines 126–200)

```
async fn turn_start_sends_fork_lineage_in_turn_metadata_for_thread_fork_v2() -> Result<()>
```

**Purpose**: This test checks that a turn started on a forked thread tells the Responses API which original thread it was forked from. That matters because forked conversations need a visible family history for tracing and debugging.

**Data flow**: The test creates a saved fake rollout on disk to act as the source thread, starts the app server, asks the server to fork that saved thread, and then starts a new turn on the fork. After the fake Responses API receives the model request, the test parses the metadata header and verifies that it contains the source thread id, the new forked thread id, and the new turn id.

**Call relations**: The test is run by the async test framework. It delegates the repeated fork request sequence to `fork_fake_rollout_thread`, uses `create_config_toml` for setup, and uses `parse_json_header` after the mock server captures the outgoing request.

*Call graph*: calls 6 internal fn (new, create_config_toml, fork_fake_rollout_thread, mount_sse_once, sse, start_mock_server); 8 external calls (default, new, Integer, create_fake_rollout, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `review_start_sends_parent_lineage_in_turn_metadata_for_thread_fork_v2`  (lines 203–300)

```
async fn review_start_sends_parent_lineage_in_turn_metadata_for_thread_fork_v2() -> Result<()>
```

**Purpose**: This test makes sure that starting a review on a forked thread sends review-specific lineage metadata correctly. In plain terms, it checks that the review request is labeled as a review worker and tied back to the thread being reviewed.

**Data flow**: The test prepares a fake review-shaped model response, creates a saved source thread, forks it through the app server, and then starts an inline review on the forked thread. It waits for completion and inspects the outgoing request to the fake Responses API. The observed request should include the review subagent header, should not claim it was directly forked from the original source, and should include a parent thread id pointing to the reviewed thread while using a separate internal review request thread id.

**Call relations**: The async test framework starts this test. The test uses `create_config_toml` to configure the temporary server, `fork_fake_rollout_thread` to create the fork through normal app-server behavior, and `parse_json_header` to inspect the metadata captured by the fake Responses API.

*Call graph*: calls 6 internal fn (new, create_config_toml, fork_fake_rollout_thread, mount_sse_once, sse, start_mock_server); 9 external calls (new, Integer, create_fake_rollout, assert!, assert_eq!, json!, skip_if_no_network!, timeout, vec!).


##### `turn_start_sends_other_subagent_lineage_after_cold_thread_resume_v2`  (lines 303–398)

```
async fn turn_start_sends_other_subagent_lineage_after_cold_thread_resume_v2() -> Result<()>
```

**Purpose**: This test checks that if the server resumes an existing subagent thread from disk, it keeps the subagent's parent thread and kind when sending the next turn to the Responses API. A subagent is a helper conversation working under another thread; this test protects that relationship after a cold resume.

**Data flow**: The test writes a fake saved rollout whose source says it is an `Other` subagent named `guardian` and whose parent is a separate thread id. It starts a fresh app server, resumes that saved subagent thread, verifies the resumed thread data returned by the app server, then starts a turn on it. Finally it reads the outgoing fake Responses API request and confirms that the metadata contains the parent thread id, the subagent kind, the thread id, and the turn id, without incorrectly adding fork metadata.

**Call relations**: The test is launched by the async test framework. It relies on `create_config_toml` for temporary configuration, test-support helpers to create the saved rollout, and `parse_json_header` to make the captured metadata easy to assert against.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once, sse, start_mock_server); 12 external calls (new, default, new, Integer, SubAgent, create_fake_parented_rollout_with_source, assert!, assert_eq!, Other, skip_if_no_network! (+2 more)).


##### `turn_steer_updates_client_metadata_on_follow_up_responses_request_v2`  (lines 401–525)

```
async fn turn_steer_updates_client_metadata_on_follow_up_responses_request_v2() -> Result<()>
```

**Purpose**: This test verifies that steering an in-progress turn can replace or add client metadata on the follow-up request sent to the Responses API. Steering means sending additional instructions while a turn is already underway.

**Data flow**: The test configures the fake Responses API to receive two requests: a delayed first response and then a second response after steering. It starts a thread, starts a turn with initial metadata, waits until the first outgoing request has arrived, then sends a steer request with new metadata for the same turn. At the end it inspects both captured requests: the first should have the original metadata, and the second should have the steer metadata while keeping the same turn id.

**Call relations**: The async test framework invokes this test. It uses `create_config_toml` for setup, response-sequence helpers to capture two outgoing requests, `wait_for_request_count` to pause until the first request is definitely seen, and `parse_json_header` to compare the metadata in each request.

*Call graph*: calls 7 internal fn (new, create_config_toml, wait_for_request_count, mount_response_sequence, sse, sse_response, start_mock_server); 10 external calls (default, from, new, Integer, default, assert_eq!, skip_if_no_network!, from_secs, timeout, vec!).


##### `turn_start_forwards_client_metadata_to_responses_websocket_request_body_v2`  (lines 528–623)

```
async fn turn_start_forwards_client_metadata_to_responses_websocket_request_body_v2() -> Result<()>
```

**Purpose**: This test proves that the same turn metadata is forwarded correctly when the app server talks to the Responses API over a WebSocket instead of normal HTTP streaming. A WebSocket is a long-lived network connection where messages are sent back and forth over one connection.

**Data flow**: The test starts a fake WebSocket Responses API server, writes configuration that says the provider supports WebSockets, and starts the app server. It creates a thread and starts a turn with client metadata. After completion, it reads the WebSocket messages captured by the fake server: first a warmup request and then the real response-create request. It checks that the real request body carries the JSON metadata inside `client_metadata`, including client fields and server-generated ids.

**Call relations**: The async test framework runs this test. It uses `create_config_toml` to enable WebSocket behavior, the WebSocket mock server to capture request bodies, and `parse_json_header` to decode the metadata string embedded in the captured JSON body.

*Call graph*: calls 3 internal fn (new, create_config_toml, start_websocket_server); 10 external calls (default, from, new, Integer, default, assert!, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `create_config_toml`  (lines 625–651)

```
fn create_config_toml(
    codex_home: &Path,
    server_uri: &str,
    supports_websockets: bool,
) -> std::io::Result<()>
```

**Purpose**: This helper writes a small `config.toml` file for the temporary test home directory. The file tells the app server to use the fake provider URL and whether that provider should be treated as WebSocket-capable.

**Data flow**: It receives a directory path, a fake server URI, and a true-or-false WebSocket support flag. It builds the path to `config.toml`, formats a TOML configuration string with the mock model provider settings, writes it to disk, and returns success or an I/O error if writing failed.

**Call relations**: All of the tests call this helper during setup before starting `TestAppServer`. It hands the app server the configuration needed to send model traffic to the test-controlled fake server rather than a real external service.

*Call graph*: called by 6 (review_start_sends_parent_lineage_in_turn_metadata_for_thread_fork_v2, turn_start_forwards_client_metadata_to_responses_request_v2, turn_start_forwards_client_metadata_to_responses_websocket_request_body_v2, turn_start_sends_fork_lineage_in_turn_metadata_for_thread_fork_v2, turn_start_sends_other_subagent_lineage_after_cold_thread_resume_v2, turn_steer_updates_client_metadata_on_follow_up_responses_request_v2); 3 external calls (join, format!, write).


##### `fork_fake_rollout_thread`  (lines 653–670)

```
async fn fork_fake_rollout_thread(
    mcp: &mut TestAppServer,
    source_thread_id: String,
) -> Result<ThreadForkResponse>
```

**Purpose**: This helper asks the test app server to fork an existing saved thread and returns the app server's fork response. It keeps the fork setup in one place for tests that need a forked conversation.

**Data flow**: It receives a mutable test app server connection and the id of a source thread. It sends a thread-fork JSON-RPC request, waits for the matching response with a timeout, converts the generic JSON-RPC response into a `ThreadForkResponse`, and returns that structured response or an error.

**Call relations**: The fork-lineage tests call this helper after the app server has been initialized and a fake saved rollout exists. The helper talks directly to the app server through the test client, then hands the resulting forked thread data back to the test so the test can start a turn or review on it.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_fork_request); called by 2 (review_start_sends_parent_lineage_in_turn_metadata_for_thread_fork_v2, turn_start_sends_fork_lineage_in_turn_metadata_for_thread_fork_v2); 3 external calls (default, Integer, timeout).


##### `parse_json_header`  (lines 672–674)

```
fn parse_json_header(value: &str) -> serde_json::Value
```

**Purpose**: This helper turns a metadata header string back into JSON so tests can inspect individual fields. It assumes the header must be valid JSON and fails the test immediately if it is not.

**Data flow**: It receives a string taken from a request header or WebSocket client metadata field. It parses that string as JSON and returns a `serde_json::Value`, which the tests then index by field name for assertions.

**Call relations**: The tests call this after the fake Responses API captures an outgoing request. It is the small translation step between raw wire data and readable assertions about fields like `turn_id`, `parent_thread_id`, and `fiber_run_id`.

*Call graph*: 1 external calls (from_str).


##### `wait_for_request_count`  (lines 676–690)

```
async fn wait_for_request_count(
    request_log: &core_test_support::responses::ResponseMock,
    expected: usize,
) -> Result<()>
```

**Purpose**: This helper waits until the fake Responses API has recorded at least a requested number of outgoing requests. It prevents a timing race where a test might inspect the request log before the app server has sent the first request.

**Data flow**: It receives a response mock log and an expected count. Inside a timeout, it repeatedly checks how many requests have been captured, sleeps briefly if there are not enough yet, and returns once the expected count is reached. If the count never arrives in time, it returns a timeout error.

**Call relations**: The steer-metadata test uses this helper between starting a turn and sending a steer request. That ensures the first model request has already gone out, so the later assertions can clearly compare the first request's metadata with the follow-up request's metadata.

*Call graph*: calls 1 internal fn (requests); called by 1 (turn_steer_updates_client_metadata_on_follow_up_responses_request_v2); 3 external calls (from_millis, sleep, timeout).


### `app-server/tests/suite/v2/dynamic_tools.rs`

`test` · `test execution`

Dynamic tools let an outside client teach the app server about extra actions, such as “look up a ticket,” for just one conversation thread. This test file makes sure that feature works end to end. Without these tests, the server could silently send the wrong tool definitions to the model, accept confusing tool formats, or lose the output when a tool finishes.

The tests start a real test app-server process and point it at a fake model server. The fake server records what the app-server sends and can also pretend that the model requested a tool call. The tests then act like a client: they start a thread, start a turn, wait for notifications, answer tool-call requests, and inspect the next model request.

A key theme is format translation. The server supports an older “legacy” dynamic tool shape and a newer “canonical” shape. These tests verify that legacy input is normalized before it reaches the model, and that invalid mixtures are rejected early with clear errors. They also verify the round trip: model asks for a dynamic tool, server notifies the client, client sends back text or structured content, and server forwards that output back to the model in the expected format.

#### Function details

##### `thread_start_normalizes_legacy_dynamic_tools_into_model_request`  (lines 49–161)

```
async fn thread_start_normalizes_legacy_dynamic_tools_into_model_request() -> Result<()>
```

**Purpose**: This test checks that older-style dynamic tool definitions are converted into the model-facing tool format when a thread starts. It also checks that hidden legacy tools are not exposed to the model context.

**Data flow**: It creates a fake model response, writes a temporary config pointing the app server at the fake model server, starts the app server, and sends a raw thread/start request containing legacy dynamic tools. After starting a turn, it reads the fake server’s recorded request body and checks that a plain tool became a function tool, that visible namespaced tools became a namespace, and that the hidden tool was left out.

**Call relations**: The async test runner calls this test. Inside the test, setup flows through create_config_toml and the test server helpers, then responses_bodies fetches what the fake model server received, and find_tool picks out the tool definitions that the assertions compare.

*Call graph*: calls 4 internal fn (new, create_config_toml, find_tool, responses_bodies); 8 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, json!, timeout, vec!).


##### `thread_start_rejects_hidden_dynamic_tools_without_namespace`  (lines 164–200)

```
async fn thread_start_rejects_hidden_dynamic_tools_without_namespace() -> Result<()>
```

**Purpose**: This test makes sure a hidden dynamic tool is rejected if it is not inside a namespace. That matters because hidden loading only makes sense when the tool can be grouped and addressed safely.

**Data flow**: It starts a fake model server, writes config, starts the app server, and builds a dynamic function marked as deferred or hidden. It sends that tool in a thread/start request, then reads the error response. The expected result is a JSON-RPC error with an invalid-request code and a message naming both the tool and the missing namespace requirement.

**Call relations**: The test runner invokes it as an async test. It uses create_config_toml for setup and the TestAppServer request-reading helpers to prove the server rejects the bad input before any normal thread response is produced.

*Call graph*: calls 2 internal fn (new, create_config_toml); 10 external calls (default, start, new, Integer, assert!, assert_eq!, json!, Function, timeout, vec!).


##### `thread_start_rejects_invalid_dynamic_tool_inputs`  (lines 203–317)

```
async fn thread_start_rejects_invalid_dynamic_tool_inputs() -> Result<()>
```

**Purpose**: This test checks several bad dynamic-tool definitions and confirms the server refuses them with useful error messages. It protects the boundary where client-provided tool descriptions enter the server.

**Data flow**: It starts the app server against a fake model server, then loops over invalid JSON examples: mixed legacy and canonical formats, legacy visibility fields inside canonical format, an empty namespace, and duplicate namespaces. For each case, it sends thread/start and expects an invalid-request error whose message contains the relevant explanation.

**Call relations**: The test runner calls this test. It relies on create_config_toml for the temporary app configuration and repeatedly uses the app-server test connection to send raw requests and read matching error responses.

*Call graph*: calls 2 internal fn (new, create_config_toml); 7 external calls (start, new, Integer, assert!, assert_eq!, json!, timeout).


##### `dynamic_tool_call_round_trip_sends_text_content_items_to_model`  (lines 321–551)

```
async fn dynamic_tool_call_round_trip_sends_text_content_items_to_model() -> Result<()>
```

**Purpose**: This test exercises the full path for a dynamic tool call whose result is simple text. It proves that a model-requested tool call reaches the client and that the client’s answer is sent back to the model correctly.

**Data flow**: It prepares two fake model responses: first a streamed response that asks for a dynamic tool, then a final assistant message. It starts a thread with a namespaced dynamic tool, starts a turn, waits for the server to announce the tool call, reads the server’s DynamicToolCall request, sends back a text result, waits for completion, and finally inspects recorded model requests. The output is a set of assertions showing the tool definition, the live notification data, and the follow-up function_call_output payload all match expectations.

**Call relations**: The async test runner starts the scenario. The test uses create_config_toml for setup, wait_for_dynamic_tool_started and wait_for_dynamic_tool_completed to synchronize with item notifications, responses_bodies to read fake model traffic, find_tool to locate the sent namespace, and FunctionCallOutputPayload::from_text to build the expected model payload.

*Call graph*: calls 7 internal fn (new, create_config_toml, find_tool, responses_bodies, wait_for_dynamic_tool_completed, wait_for_dynamic_tool_started, from_text); 13 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, assert!, assert_eq!, json!, panic!, Namespace, to_string (+3 more)).


##### `dynamic_tool_call_round_trip_sends_content_items_to_model`  (lines 555–745)

```
async fn dynamic_tool_call_round_trip_sends_content_items_to_model() -> Result<()>
```

**Purpose**: This test checks that dynamic tool results can include structured content, not only plain text. In particular, it verifies that text and image items are preserved and translated into the model’s expected output shape.

**Data flow**: It sets up a fake model response that emits a function call, starts the app server and a thread with a dynamic tool, then starts a turn. After the server asks the client to run the tool, the test responds with two content items: text and an image URL. It waits for the completed notification and then inspects the follow-up request to the model, confirming the raw JSON output and decoded payload contain the expected text and image data.

**Call relations**: The test runner invokes this end-to-end scenario. The test uses create_config_toml for setup, wait_for_dynamic_tool_started and wait_for_dynamic_tool_completed to follow the item lifecycle, responses_bodies to inspect model requests, and the function-call-output helpers to extract the exact output sent back to the model.

*Call graph*: calls 5 internal fn (new, create_config_toml, responses_bodies, wait_for_dynamic_tool_completed, wait_for_dynamic_tool_started); 12 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, json!, panic!, Function, to_string, to_value (+2 more)).


##### `responses_bodies`  (lines 747–761)

```
async fn responses_bodies(server: &MockServer) -> Result<Vec<Value>>
```

**Purpose**: This helper pulls out the JSON bodies of model API requests recorded by the fake model server. Tests use it to see what the app server actually sent over the wire.

**Data flow**: It receives a mock server, asks it for all received requests, filters to requests whose path ends in /responses, parses each body as JSON, and returns a list of those JSON values. If the request list cannot be fetched or a body is not JSON, it returns an error.

**Call relations**: The main tests call this after a scenario has run. It hands the recorded request bodies back to those tests so helpers like find_tool or the function-call-output extractors can inspect specific pieces.

*Call graph*: called by 3 (dynamic_tool_call_round_trip_sends_content_items_to_model, dynamic_tool_call_round_trip_sends_text_content_items_to_model, thread_start_normalizes_legacy_dynamic_tools_into_model_request); 1 external calls (received_requests).


##### `find_tool`  (lines 763–771)

```
fn find_tool(body: &'a Value, name: &str) -> Option<&'a Value>
```

**Purpose**: This helper looks inside a model request body and finds a tool definition by name. It keeps the tests focused on the expected tool rather than on the whole request body.

**Data flow**: It receives a JSON value and a tool name. It looks for a top-level tools array, scans each tool object, compares its name field with the requested name, and returns the matching JSON object if one exists. If the structure is missing or no name matches, it returns nothing.

**Call relations**: The normalization and text round-trip tests call this after responses_bodies has collected model request bodies. It acts like a small search tool before the tests compare the selected definition with the expected JSON.

*Call graph*: called by 2 (dynamic_tool_call_round_trip_sends_text_content_items_to_model, thread_start_normalizes_legacy_dynamic_tools_into_model_request); 1 external calls (get).


##### `function_call_output_payload`  (lines 773–776)

```
fn function_call_output_payload(body: &Value, call_id: &str) -> Option<FunctionCallOutputPayload>
```

**Purpose**: This helper turns a raw function_call_output value from a model request into the strongly typed payload used by the protocol code. That lets tests compare meaningful structured data instead of hand-checking every JSON field.

**Data flow**: It receives a model request body and a call id. First it asks function_call_output_raw_output to find the raw output JSON for that call. If found, it tries to deserialize that JSON into a FunctionCallOutputPayload. It returns the typed payload on success, or nothing if either lookup or parsing fails.

**Call relations**: It sits one step above function_call_output_raw_output. The round-trip tests use this kind of extraction when they need to confirm that the app server’s follow-up request can be understood as the protocol’s official function-call-output payload.

*Call graph*: calls 1 internal fn (function_call_output_raw_output).


##### `function_call_output_raw_output`  (lines 778–789)

```
fn function_call_output_raw_output(body: &Value, call_id: &str) -> Option<Value>
```

**Purpose**: This helper finds the raw output field for a specific function call inside a model request body. It is useful when a test needs to inspect the exact JSON sent back to the model.

**Data flow**: It receives a JSON request body and a call id. It looks in the input array for an item whose type is function_call_output and whose call_id matches. If it finds one, it clones and returns that item’s output field; otherwise it returns nothing.

**Call relations**: function_call_output_payload builds on this helper to parse the raw output into a typed payload. The content-item round-trip checks also use this raw view when they need to compare the precise JSON shape, including image detail fields.

*Call graph*: called by 1 (function_call_output_payload); 1 external calls (get).


##### `wait_for_dynamic_tool_started`  (lines 791–809)

```
async fn wait_for_dynamic_tool_started(
    mcp: &mut TestAppServer,
    call_id: &str,
) -> Result<ItemStartedNotification>
```

**Purpose**: This helper waits until the app server announces that a particular dynamic tool call has started. It filters out unrelated item-started notifications so the test can synchronize with the right tool call.

**Data flow**: It receives the running test app-server connection and a call id. In a loop, it waits for an item/started notification with a timeout, skips notifications without parameters, decodes the parameters, and checks whether the item is a dynamic tool call with the requested id. When it finds the right one, it returns the decoded started notification.

**Call relations**: The two dynamic-tool round-trip tests call this after starting a turn. It listens to the app server’s notification stream and hands back the first matching tool-start event so the tests can assert thread id, turn id, arguments, and status.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 2 (dynamic_tool_call_round_trip_sends_content_items_to_model, dynamic_tool_call_round_trip_sends_text_content_items_to_model); 3 external calls (matches!, from_value, timeout).


##### `wait_for_dynamic_tool_completed`  (lines 811–829)

```
async fn wait_for_dynamic_tool_completed(
    mcp: &mut TestAppServer,
    call_id: &str,
) -> Result<ItemCompletedNotification>
```

**Purpose**: This helper waits until the app server announces that a particular dynamic tool call has completed. It gives the tests a reliable point to check the final status and returned content.

**Data flow**: It receives the test app-server connection and a call id. It repeatedly waits for item/completed notifications, ignores ones without parameters, decodes the rest, and checks for a dynamic tool call whose id matches. When the matching completion arrives, it returns that notification.

**Call relations**: The round-trip tests call this after sending a DynamicToolCallResponse back to the app server. It confirms that the server accepted the client’s tool result and updated the thread item before the tests inspect the model follow-up request.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 2 (dynamic_tool_call_round_trip_sends_content_items_to_model, dynamic_tool_call_round_trip_sends_text_content_items_to_model); 3 external calls (matches!, from_value, timeout).


##### `create_config_toml`  (lines 831–852)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes the temporary app-server configuration used by these tests. It points the app server at the fake model server instead of a real provider.

**Data flow**: It receives a temporary Codex home directory and the fake server’s URI. It creates a config.toml path, formats a small configuration string with a mock model, no approvals, read-only sandboxing, and a model provider whose base URL is the fake server, then writes that file to disk. It returns success or an I/O error.

**Call relations**: Every test in this file calls this during setup before starting TestAppServer. It is the bridge between the fake model server created by the test and the app server process that needs configuration to know where to send model requests.

*Call graph*: called by 5 (dynamic_tool_call_round_trip_sends_content_items_to_model, dynamic_tool_call_round_trip_sends_text_content_items_to_model, thread_start_normalizes_legacy_dynamic_tools_into_model_request, thread_start_rejects_hidden_dynamic_tools_without_namespace, thread_start_rejects_invalid_dynamic_tool_inputs); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/memory_reset.rs`

`test` · `test run`

This is an end-to-end style test for a safety-critical cleanup feature: resetting memory. In this project, memory is stored in two places: files on disk, such as `MEMORY.md` and rollout summaries, and rows in the state database, such as generated memory outputs. A reset should clear those memory artifacts, but it must not erase the underlying thread itself or forget that the thread had memory enabled. Think of it like clearing notes from a notebook while keeping the notebook's owner label and settings.

The test builds a temporary fake Codex home directory, writes a minimal configuration file, starts a real state database, and plants both file-based memory and database-based memory. It also creates a thread record so the test can prove that thread metadata survives the reset.

Then it starts `TestAppServer`, sends the raw JSON-RPC request named `memory/reset`, waits for the matching response, and checks the result. After the server replies successfully, the test asks the database for remaining stage-one memory outputs and expects none. It also checks that the thread's memory mode is still `enabled`. Finally, it reads the memory directory and expects it to be empty. Without this test, a reset feature could accidentally leave stale memory behind, or worse, delete thread state that should be preserved.

#### Function details

##### `memory_reset_clears_memory_files_and_rows_preserves_threads`  (lines 23–69)

```
async fn memory_reset_clears_memory_files_and_rows_preserves_threads() -> Result<()>
```

**Purpose**: This is the main test case. It proves that calling `memory/reset` removes memory files and memory database rows, while preserving the thread and its memory mode.

**Data flow**: It starts with a fresh temporary Codex home folder. It writes test configuration, opens the state database, creates fake memory files, and seeds the database with a completed memory output for one thread. It then starts the test app server, sends a `memory/reset` request, and reads the response. Afterward, it checks the database and filesystem: memory rows are gone, the thread still says memory is enabled, and the memory directory has no remaining entries.

**Call relations**: This function drives the whole test story. It calls `create_config_toml` to make the app startable, `init_state_db` to prepare the database, and `seed_stage1_output` to create realistic memory state before the reset. It then uses the test server helpers to exercise the actual server request path, so the assertions check the behavior a caller would see rather than only testing a small helper in isolation.

*Call graph*: calls 4 internal fn (new, create_config_toml, init_state_db, seed_stage1_output); 8 external calls (new, Integer, assert!, assert_eq!, create_dir_all, read_dir, write, timeout).


##### `seed_stage1_output`  (lines 71–119)

```
async fn seed_stage1_output(state_db: &Arc<StateRuntime>, codex_home: &Path) -> Result<ThreadId>
```

**Purpose**: This helper creates a realistic pre-reset memory record in the database. It also creates the thread that owns that memory, so the main test can later confirm the thread survives the reset.

**Data flow**: It receives the shared state database and the temporary Codex home path. It creates fresh thread and worker IDs, builds thread metadata pointing at a fake session file, and stores that thread in the database. Then it claims a stage-one memory job, marks that job as successfully completed with raw memory text and a rollout summary, and queues global consolidation work. It returns the thread ID so the caller can check that thread's memory mode after reset.

**Call relations**: The main test calls this after the database is initialized and before the server reset request is sent. This helper prepares the database side of the memory state that `memory/reset` is expected to clear. It uses the state database's memory job APIs to mimic the normal path by which memory output would have been produced.

*Call graph*: calls 2 internal fn (from_string, new); called by 1 (memory_reset_clears_memory_files_and_rows_preserves_threads); 6 external calls (join, to_path_buf, now, new_v4, bail!, assert!).


##### `init_state_db`  (lines 121–127)

```
async fn init_state_db(codex_home: &Path) -> Result<Arc<StateRuntime>>
```

**Purpose**: This helper opens and prepares the state database for the test. It makes sure the database is ready to use without waiting for any background backfill work.

**Data flow**: It receives the temporary Codex home path. It initializes `StateRuntime`, which is the test's handle to the state database, using the mock provider name. Then it marks backfill as complete, meaning the test database is treated as already caught up. It returns the database handle wrapped in shared ownership so other async code can use it safely.

**Call relations**: The main test calls this near the beginning, before seeding memory data or starting the app server. The returned database handle is passed to `seed_stage1_output` and later queried directly by the test to verify what the reset changed.

*Call graph*: calls 1 internal fn (init); called by 1 (memory_reset_clears_memory_files_and_rows_preserves_threads); 1 external calls (to_path_buf).


##### `create_config_toml`  (lines 129–151)

```
fn create_config_toml(codex_home: &Path) -> std::io::Result<()>
```

**Purpose**: This helper writes the minimal configuration file needed for the test app server to start. It points the server at a mock model provider and enables the SQLite-backed state feature.

**Data flow**: It receives the temporary Codex home path, builds the path to `config.toml`, and writes a fixed TOML configuration string there. The file includes a mock model, no approval prompts, read-only sandboxing, SQLite enabled, and retry counts set to zero. It returns success or the filesystem error from writing the file.

**Call relations**: The main test calls this before initializing the database and server. The test server later reads this configuration from the temporary home directory, so this helper supplies the environment that makes the rest of the test run predictably without contacting a real model provider.

*Call graph*: called by 1 (memory_reset_clears_memory_files_and_rows_preserves_threads); 2 external calls (join, write).


### `app-server/tests/suite/v2/output_schema.rs`

`test` · `test run`

This is a test file for a very specific promise in the app server: when a client says, “for this reply, please return JSON shaped like this,” the server must forward that instruction to the model backend in the right format. The tests run against a mock model server instead of the real network service. That mock server records what the app server sends, like a test cashier keeping the receipt so the test can inspect it later.

Each test creates a temporary Codex home folder and writes a small configuration file that points the app server at the mock provider. It then starts a test app server, opens a thread, and sends one or more turns. A “turn” is one user message plus the assistant response that follows it.

The first test sends a turn with an `output_schema`, which is a JSON Schema: a description of the JSON object the model should produce. It confirms that the outgoing provider request contains a `text.format` block with the expected schema wrapper.

The second test proves the schema is per-turn. It sends one turn with the schema and confirms it is present, then sends another turn without a schema and confirms the provider request has no `text.format`. Without this behavior, one user’s structured-output request could silently affect later messages.

#### Function details

##### `turn_start_accepts_output_schema_v2`  (lines 21–101)

```
async fn turn_start_accepts_output_schema_v2() -> Result<()>
```

**Purpose**: This test checks the basic happy path: a v2 `turn/start` request may include an output schema, and the app server forwards that schema to the model provider. It protects against breaking structured output support for clients that need the assistant response in a predictable JSON shape.

**Data flow**: The test starts with a mock model server and a temporary configuration that points the app server at it. It opens a new thread, builds a JSON Schema requiring an `answer` string, and sends a turn containing that schema and a simple text message. After the mocked assistant response completes, the test reads the recorded provider request and compares its `text.format` field with the exact JSON wrapper expected by the provider. The visible result is a passing test if the schema was forwarded correctly, or a failed assertion if it was missing or malformed.

**Call relations**: This is one of the top-level async tests run by the Rust test runner. It uses `create_config_toml` to prepare the server configuration, relies on test-support helpers to start the mock provider and app server, then inspects the single recorded provider request after the turn finishes.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once, sse, start_mock_server); 8 external calls (default, new, Integer, assert_eq!, json!, skip_if_no_network!, timeout, vec!).


##### `turn_start_output_schema_is_per_turn_v2`  (lines 104–214)

```
async fn turn_start_output_schema_is_per_turn_v2() -> Result<()>
```

**Purpose**: This test checks that an output schema applies only to the turn where it was supplied. It prevents a subtle bug where a schema from one message could “stick” and constrain later assistant replies that did not ask for structured output.

**Data flow**: The test creates a mock provider, temporary app configuration, and a new thread. It sends a first turn with a JSON Schema and verifies that the provider request contains the expected `text.format` schema block. It then prepares a second mocked provider response and sends another turn in the same thread with `output_schema` set to nothing. Finally, it inspects the second provider request and confirms that `text.format` is absent. The before-and-after story is: first turn has schema in, provider request has schema out; second turn has no schema in, provider request has no schema out.

**Call relations**: This is also a top-level async test run by the test runner. Like the first test, it calls `create_config_toml` for setup and uses the test app server helpers to initialize, start a thread, send turns, and wait for completion messages. Its extra role is to exercise two consecutive turns so it can catch unwanted state leaking from the first turn into the second.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once, sse, start_mock_server); 8 external calls (default, new, Integer, assert_eq!, json!, skip_if_no_network!, timeout, vec!).


##### `create_config_toml`  (lines 216–237)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes the small configuration file needed by these tests. It tells the app server to use a mock model provider at the supplied server address, with retries disabled so test failures are quick and predictable.

**Data flow**: It receives the temporary Codex home directory path and the mock server URL. It builds the path to `config.toml`, formats a TOML configuration string containing the mock provider settings, and writes that text to disk. The output is an operating-system success or error result, and the side effect is a real config file that the test app server can read when it starts.

**Call relations**: Both test functions call this helper during setup, before creating `TestAppServer`. It does not take part in the turn flow itself; it prepares the environment so the app server sends its model requests to the mock server rather than to a real provider.

*Call graph*: called by 2 (turn_start_accepts_output_schema_v2, turn_start_output_schema_is_per_turn_v2); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/plan_item.rs`

`test` · `test execution`

These tests make sure plan mode behaves the way a user interface would expect. In plan mode, the model may return a special tagged section, like a form with a clearly marked “plan” field. The server should pull that plan out, stream plan updates as they arrive, and also produce a completed plan item at the end. Without this behavior, a client might only see a normal assistant message and miss the structured plan it needs to display separately.

The file sets up a fake model server instead of calling a real provider. That fake server sends prewritten streaming events, so the test can control exactly what the model appears to say. A temporary config file points the app server at this fake server and enables collaboration modes, including plan mode.

The main test starts a thread, starts a turn in plan mode, waits for server notifications, and verifies that text inside `<proposed_plan>...</proposed_plan>` becomes a `ThreadItem::Plan`. It also checks that normal assistant message items are still emitted, so extracting the plan does not erase the rest of the response. The second test proves the opposite: if there is no proposed-plan block, the server must not invent a plan item or send plan deltas.

#### Function details

##### `plan_mode_uses_proposed_plan_block_for_plan_item`  (lines 39–98)

```
async fn plan_mode_uses_proposed_plan_block_for_plan_item() -> Result<()>
```

**Purpose**: This test proves that, in plan mode, text inside a `<proposed_plan>` block is turned into a separate plan item. It also confirms that the server streams plan text as deltas and still emits the normal assistant message alongside the plan.

**Data flow**: It begins with a fake model response containing a preface, a tagged proposed-plan block, and a postscript. It writes a temporary config that points the app server at the fake model server, starts the app server, starts a plan-mode turn, and collects notifications until the turn finishes. It then compares what came out: the turn must complete successfully, the streamed plan deltas must combine into the plan text, completed items must include the expected plan item, and completed items must also include an assistant message.

**Call relations**: This is one of the two top-level test stories in the file. It uses `create_config_toml` to prepare the test app, `start_plan_mode_turn` to create a thread and begin the plan-mode request, `collect_turn_notifications` to listen for the server’s output, and `wait_for_responses_request_count` to make sure the fake model server was called exactly once.

*Call graph*: calls 5 internal fn (new, collect_turn_notifications, create_config_toml, start_plan_mode_turn, wait_for_responses_request_count); 8 external calls (new, create_mock_responses_server_sequence_unchecked, assert!, assert_eq!, format!, skip_if_no_network!, timeout, vec!).


##### `plan_mode_without_proposed_plan_does_not_emit_plan_item`  (lines 101–128)

```
async fn plan_mode_without_proposed_plan_does_not_emit_plan_item() -> Result<()>
```

**Purpose**: This test proves that ordinary assistant text does not become a plan just because the turn is in plan mode. It protects against false positives, where the server might create a plan item even though the model did not provide one.

**Data flow**: It sets up a fake model response that only says `Done`, with no proposed-plan tags. After creating the temporary config and starting a plan-mode turn, it collects notifications until completion. The expected result is that completed items contain no plan item and there are no plan delta notifications.

**Call relations**: This is the matching negative case for `plan_mode_uses_proposed_plan_block_for_plan_item`. It follows the same setup path through `create_config_toml`, `start_plan_mode_turn`, `collect_turn_notifications`, and `wait_for_responses_request_count`, but it checks that the plan-specific outputs are absent.

*Call graph*: calls 5 internal fn (new, collect_turn_notifications, create_config_toml, start_plan_mode_turn, wait_for_responses_request_count); 6 external calls (new, create_mock_responses_server_sequence_unchecked, assert!, skip_if_no_network!, timeout, vec!).


##### `start_plan_mode_turn`  (lines 130–170)

```
async fn start_plan_mode_turn(mcp: &mut TestAppServer) -> Result<codex_app_server_protocol::Turn>
```

**Purpose**: This helper starts a new conversation thread and then starts a turn in plan mode inside that thread. The tests use it so they do not have to repeat the setup steps for beginning a plan-mode request.

**Data flow**: It receives a mutable test app server connection. First it sends a thread-start request using the mock model and waits for the matching response, which gives it a thread ID. Then it builds a plan-mode collaboration setting, sends a turn-start request with the user text `Plan this`, waits for the turn-start response, and returns the newly created turn.

**Call relations**: Both top-level tests call this after the test server has been initialized. It talks to the app server through request helper methods, waits for JSON-RPC responses, converts those responses into typed protocol objects, and hands the resulting turn back to the test so later notifications can be checked against that turn.

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

**Purpose**: This helper listens to the app server’s message stream until it sees that the turn has completed. Along the way, it gathers the started items, completed items, and plan text updates that the tests need to inspect.

**Data flow**: It receives a mutable test app server connection and repeatedly reads the next message with a timeout. It ignores anything that is not a notification. For recognized notifications, it parses the JSON parameters into the right typed message: started item, completed item, plan delta, or turn completed. When the turn-completed notification arrives, it returns all collected started items, completed items, plan deltas, and the final completion payload.

**Call relations**: The two test functions call this right after starting a turn. It is the listener part of the test: `start_plan_mode_turn` kicks the work off, and `collect_turn_notifications` watches what the app server reports back until the story is finished.

*Call graph*: calls 1 internal fn (read_next_message); called by 2 (plan_mode_uses_proposed_plan_block_for_plan_item, plan_mode_without_proposed_plan_does_not_emit_plan_item); 3 external calls (new, from_value, timeout).


##### `wait_for_responses_request_count`  (lines 223–251)

```
async fn wait_for_responses_request_count(
    server: &MockServer,
    expected_count: usize,
) -> Result<()>
```

**Purpose**: This helper waits until the fake model server has received exactly the expected number of `/responses` requests. It makes the tests stricter by proving the app server contacted the model provider the expected number of times.

**Data flow**: It receives the fake HTTP server and an expected request count. Inside a timeout, it repeatedly asks the fake server what requests it has recorded, counts POST requests whose path ends with `/responses`, and stops when the count matches. If the count goes too high, or if the fake server cannot report requests, it returns an error. While waiting, it sleeps briefly between checks.

**Call relations**: Both top-level tests call this after collecting turn notifications. It verifies the outside interaction with the mocked model provider, complementing the notification checks that verify what the app server sent back to the client.

*Call graph*: called by 2 (plan_mode_uses_proposed_plan_block_for_plan_item, plan_mode_without_proposed_plan_does_not_emit_plan_item); 5 external calls (received_requests, bail!, from_millis, sleep, timeout).


##### `create_config_toml`  (lines 253–290)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes the temporary configuration file needed for the app server to run inside the test. It points the server at the fake model provider and turns on the collaboration-modes feature so plan mode is available.

**Data flow**: It receives the temporary Codex home directory and the fake server’s URI. It builds feature configuration entries, writes settings such as the mock model name, read-only sandbox mode, no approval prompts, and a model provider whose base URL is the fake server’s `/v1` endpoint. The output is a `config.toml` file on disk, or an I/O error if writing fails.

**Call relations**: Each top-level test creates a fresh temporary directory and then calls this before starting `TestAppServer`. The app server later reads this file during initialization, which is why the tests can run against controlled fake responses instead of a real model service.

*Call graph*: called by 2 (plan_mode_uses_proposed_plan_block_for_plan_item, plan_mode_without_proposed_plan_does_not_emit_plan_item); 4 external calls (from, join, format!, write).


### `app-server/tests/suite/v2/request_permissions.rs`

`test` · `test execution`

This test simulates a full conversation where the assistant needs more file-system permission before it can proceed. In plain terms, it checks that the server can pause and say, “I need permission to write here,” and that once the client replies, the server records that the request was resolved before finishing the assistant turn.

The test builds a temporary app configuration that uses a mock model provider instead of a real network service. That mock provider sends two prepared streaming responses: first a permission request, then a final assistant message. The test then starts the app server, opens a thread, starts a turn with the user message “pick a directory,” and waits for the server to send a permission request back to the client.

It carefully checks the contents of that request: it belongs to the right thread and turn, it names the expected tool call, it includes an absolute working directory, it gives the expected reason, and it asks for two write paths. The test then grants only one of those write paths for the current turn. Finally, it reads messages until it sees a “server request resolved” notification, and confirms that this notification arrives before the turn is marked completed. Without this behavior, clients could miss important permission state changes or the server might continue without properly tying approval to the original request.

#### Function details

##### `request_permissions_round_trip`  (lines 24–155)

```
async fn request_permissions_round_trip() -> Result<()>
```

**Purpose**: This is the main integration test. It proves that a permission request can travel from the mock assistant response to the app server, then to the client, and that the client's approval travels back and lets the turn finish in the right order.

**Data flow**: It starts with a temporary configuration folder and a mock response server prepared with a permission request followed by a final assistant message. It writes a config file pointing the app server at that mock provider, starts the test server, creates a thread, and starts a turn. It then reads the outgoing permission request, checks that its fields are correct, sends back a permission approval granting one requested write path for this turn, and keeps reading messages until it confirms that the request was resolved before the turn completed. The visible output is a passing test if all checks hold, or a test failure if the server sends the wrong data or messages in the wrong order.

**Call relations**: This function drives the whole scenario. It calls create_config_toml to create the test-only settings file, uses test support helpers to start the mock model server and app server, and uses protocol conversion helpers to interpret JSON-RPC responses. During the test, it acts like the client side of the app-server protocol: it starts work, receives the server's permission question, answers it, and verifies the follow-up notifications.

*Call graph*: calls 2 internal fn (new, create_config_toml); 12 external calls (default, Integer, create_mock_responses_server_sequence, to_response, assert!, assert_eq!, panic!, from_value, to_value, new (+2 more)).


##### `create_config_toml`  (lines 157–181)

```
fn create_config_toml(codex_home: &std::path::Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes the small configuration file needed for the test server. It tells the app server to use the mock model provider, run in a restrictive sandbox, and enable the permission-request tool being tested.

**Data flow**: It receives the temporary Codex home folder path and the mock server's URI. It builds the path to config.toml inside that folder, formats a TOML configuration string with the mock server URL, and writes that string to disk. The result is a config file that the test app server can read when it starts.

**Call relations**: The main test calls this before starting TestAppServer. Its job is setup: it makes sure the app server under test talks to the prepared mock responses server instead of any real provider, and that the permission-request feature is switched on for the round-trip test.

*Call graph*: called by 1 (request_permissions_round_trip); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/request_user_input.rs`

`test` · `test run`

This is an end-to-end test for a specific conversation flow: the model asks the app server to request input from the user, the app server forwards that question to the client, the client answers, and the original turn finishes. Without this test, a break in that “ask the user and resume” path could go unnoticed.

The test builds a fake model server that returns two streamed responses. The first stream contains a tool call named `request_user_input`, with one confirmation question and an automatic timeout value. The second stream is a normal final assistant message saying the work is done. The test then writes a temporary configuration file so the app server talks to this fake model server instead of a real provider.

Next, it starts a test app server, opens a thread, and starts a turn with a text input. It waits until the app server sends a server-side request asking the client to answer the model’s question. The test checks that the request is tied to the right thread, turn, tool-call id, question list, and auto-resolution timeout. It then sends back an answer and watches the message stream. The important rule it checks is ordering: the server must report that the request was resolved before it reports that the turn completed.

#### Function details

##### `create_request_user_input_sse_response_with_auto_resolution`  (lines 26–51)

```
fn create_request_user_input_sse_response_with_auto_resolution(
    call_id: &str,
    auto_resolution_ms: u64,
) -> anyhow::Result<String>
```

**Purpose**: This helper builds a fake streamed model response that asks the app server to call the `request_user_input` tool. It lets the test control the tool-call id and the automatic resolution timeout without depending on a real model.

**Data flow**: It receives a tool-call id and a timeout in milliseconds. It turns a small question form into JSON text, wraps that JSON inside a fake server-sent events stream, and returns the finished stream as a string. If converting the question data to JSON fails, it returns an error instead.

**Call relations**: The main test uses this helper when preparing the fake model server’s response sequence. Inside the helper, the JSON-building macro creates the question data, JSON serialization turns it into text, and the test response helpers wrap it as a streamed response with a created event, a function-call event, and a completed event.

*Call graph*: calls 1 internal fn (sse); 3 external calls (json!, to_string, vec!).


##### `request_user_input_round_trip`  (lines 54–161)

```
async fn request_user_input_round_trip() -> Result<()>
```

**Purpose**: This is the main test. It checks the full round trip where the model asks for user input, the app server sends that question to the client, the client answers, and the turn completes afterward.

**Data flow**: It starts with a temporary home directory and a fake model response sequence. It writes configuration pointing the app server at the fake server, starts the test app server, initializes it, creates a thread, and starts a turn. It then reads the outgoing server request, verifies its fields, sends back an answer, and keeps reading messages until it sees both the request-resolved notification and the turn-completed notification in the correct order. The result is success if every expected message arrives in time and has the expected content; otherwise the test fails.

**Call relations**: The Tokio async test runner calls this function during the test suite. It relies on `create_request_user_input_sse_response_with_auto_resolution` to create the fake tool-call stream, on `create_config_toml` to point the app server at the fake provider, and on test-support helpers such as the mock response server and `TestAppServer` to drive the app server like a real client would.

*Call graph*: calls 2 internal fn (new, create_config_toml); 12 external calls (default, Integer, create_mock_responses_server_sequence, to_response, assert!, assert_eq!, panic!, from_value, json!, new (+2 more)).


##### `create_config_toml`  (lines 162–183)

```
fn create_config_toml(codex_home: &std::path::Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes the temporary configuration file that makes the app server use the fake model provider created by the test. It keeps the test isolated from any real user configuration or network service.

**Data flow**: It receives a temporary Codex home directory path and the fake server’s base URI. It creates the path to `config.toml`, fills in a small TOML configuration string with the mock model and provider settings, and writes that file to disk. It returns success if the file was written, or an I/O error if the write fails.

**Call relations**: `request_user_input_round_trip` calls this before starting the app server. The configuration it writes is what causes later thread and turn requests to use the mock responses server instead of a real model backend.

*Call graph*: called by 1 (request_user_input_round_trip); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/thread_inject_items.rs`

`test` · `test run`

This is an integration test file. It exercises the app server almost like a real client would: start a test server, create a thread, send JSON-RPC requests, wait for replies, and inspect what the mock model provider received. The feature under test is `thread_inject_items`, which lets a client insert already-formed response items into a thread’s history. In plain terms, it is like adding a missing page into a conversation notebook, then making sure future model calls read that page in the right place.

The first test injects an assistant message before any user turn happens. It proves two things: the injected item is written into the thread’s rollout history on disk, and the next model request includes it after the normal startup context but before the user’s new message. That ordering matters because the model should see system/environment context first, then the injected history, then the latest user prompt.

The second test covers the same feature after a conversation has already had one turn. It verifies that the injected item does not appear in the earlier model request, but does appear in the next one. Helper functions create a temporary configuration that points the app at a mock model server, and search serialized response items for text used to confirm ordering.

#### Function details

##### `thread_inject_items_adds_raw_response_items_to_thread_history`  (lines 27–136)

```
async fn thread_inject_items_adds_raw_response_items_to_thread_history() -> Result<()>
```

**Purpose**: This test checks that an injected assistant response item becomes part of a new thread’s saved history and is sent to the model on the next turn. It also checks that the item is placed in the right order: after the standard initial context and before the user’s prompt.

**Data flow**: It starts with a mock model server that will return a simple streamed assistant response. The test creates a temporary app configuration pointing to that mock server, starts a test app server, opens a thread, builds an assistant message as raw response-item data, and sends it through the thread injection request. After the server accepts it, the test reads the rollout history from the thread’s saved path and confirms the item is present. Then it starts a user turn, looks at the model request captured by the mock server, and compares the positions of the environment context, injected item, and user text. The result is either success if the injected item is persisted and ordered correctly, or a test failure if any expectation is broken.

**Call relations**: This is one of the main test stories in the file. It uses `create_config_toml` to build the temporary configuration that makes the app talk to the mock provider. It uses `response_item_text_position` near the end to find where important text appears in the outgoing model input. It also relies on the test support server and rollout recorder to act like the outside model service and to inspect the thread history the app wrote.

*Call graph*: calls 7 internal fn (new, create_config_toml, response_item_text_position, mount_sse_once, sse, start_mock_server, get_rollout_history); 8 external calls (default, new, Integer, assert!, panic!, to_value, timeout, vec!).


##### `thread_inject_items_adds_raw_response_items_after_a_turn`  (lines 139–253)

```
async fn thread_inject_items_adds_raw_response_items_after_a_turn() -> Result<()>
```

**Purpose**: This test checks that response items can be injected after a conversation has already started. It makes sure the injected item affects only later model calls, not earlier ones.

**Data flow**: It starts a mock model server prepared to answer two separate turns. The test creates a temporary app configuration, starts the test app server, opens a thread, and runs a first user turn. Only after that first turn completes does it create and inject an assistant response item. Then it starts a second user turn and inspects the two model requests captured by the mock server. The first request should not contain the injected item, because it did not exist yet. The second request should contain it, because it was added to the thread history before that turn began.

**Call relations**: This is the second main test story in the file. Like the first test, it calls `create_config_toml` during setup so the app uses the mock provider instead of a real model service. It uses a mock response sequence so the two turns can be checked separately, then compares the captured requests to prove the injected history appears only after the injection request has completed.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_sequence, sse, start_mock_server); 8 external calls (default, new, Integer, assert!, assert_eq!, to_value, timeout, vec!).


##### `create_config_toml`  (lines 255–276)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes a minimal `config.toml` file for the test app server. The config tells the app to use a mock model provider at the supplied server address, with retries turned off so tests fail quickly and predictably.

**Data flow**: It receives a temporary app home directory and the mock server’s base address. It builds the path to `config.toml`, formats a small configuration string containing the mock provider URL and test settings, and writes that text to disk. It returns success if the file was written, or an input/output error if the write failed.

**Call relations**: Both test functions call this during setup, before starting `TestAppServer`. Without this helper, each test would have to repeat the same configuration text, and the app might try to contact a real provider instead of the controlled mock server.

*Call graph*: called by 2 (thread_inject_items_adds_raw_response_items_after_a_turn, thread_inject_items_adds_raw_response_items_to_thread_history); 3 external calls (join, format!, write).


##### `response_item_text_position`  (lines 278–291)

```
fn response_item_text_position(items: &[Value], needle: &str) -> Option<usize>
```

**Purpose**: This helper finds the position of the first serialized response item whose content text contains a chosen phrase. The tests use it to check the order of messages sent to the model.

**Data flow**: It receives a list of JSON values representing model input items and a text snippet to search for. For each item, it looks inside the `content` array, then inside each content object’s `text` field. If any text contains the requested snippet, it returns that item’s index in the list. If no matching text is found, it returns nothing.

**Call relations**: The first test calls this after the mock server captures the outgoing model request. It helps translate raw JSON input into simple positions, so the test can prove that environment context appears before injected history and injected history appears before the new user prompt.

*Call graph*: called by 1 (thread_inject_items_adds_raw_response_items_to_thread_history); 1 external calls (iter).


### `app-server/tests/suite/v2/thread_status.rs`

`test` · `test run`

This test file checks a small but important part of the app server’s conversation protocol: status notifications for a thread. A thread here means a running conversation session. Clients need to know when that session is busy answering and when it becomes idle again, much like a chat app showing “typing…” and then returning to normal.

The tests start a temporary, isolated Codex home directory, write a test configuration file into it, and point the app server at a fake model server. That fake server returns a simple final assistant message, so the test can focus on server behavior rather than a real network model call.

The first test starts the app server, creates a thread, starts a turn with user input, and watches the stream of JSON-RPC messages. JSON-RPC is a simple request-and-response message format. The test expects to see a `thread/status/changed` notification showing the thread became active, followed later by an idle-like state after the turn finishes.

The second test proves the opposite case: if the client says it wants to opt out of `thread/status/changed`, the server should filter those notifications out. Without these tests, clients could lose reliable progress updates, or receive unwanted messages they explicitly disabled.

#### Function details

##### `thread_status_changed_emits_runtime_updates`  (lines 25–129)

```
async fn thread_status_changed_emits_runtime_updates() -> Result<()>
```

**Purpose**: This test checks that a client receives live thread status updates while a turn is running. It proves the server announces both that a thread became active and that it later returned to an idle or finished state.

**Data flow**: The test begins with a fresh temporary Codex home directory and a fake responses server that will answer with “done.” It writes a config file pointing the app server to that fake server, starts a test app server, initializes it, creates a thread, and starts a turn with one text input. It then reads messages from the server stream until it sees a `thread/status/changed` notification for the created thread showing `Active`, and later an `Idle`, `SystemError`, or `NotLoaded` state after activity. The final output is not a returned value, but two assertions: the expected active update was seen, and a later non-active state was seen.

**Call relations**: This is one of the main tests in the file. It uses `create_config_toml` to prepare the server’s test configuration, then relies on test-support helpers to launch the app server, create the mock model response sequence, send thread and turn requests, and decode JSON-RPC responses. After proving the status notifications arrived in the right order, it also waits for the normal `turn/completed` notification so the test confirms the turn reached completion.

*Call graph*: calls 2 internal fn (new_with_env, create_config_toml); 10 external calls (default, new, Integer, create_mock_responses_server_sequence, to_response, assert!, from_value, now, timeout, vec!).


##### `thread_status_changed_can_be_opted_out`  (lines 132–217)

```
async fn thread_status_changed_can_be_opted_out() -> Result<()>
```

**Purpose**: This test checks that clients can ask not to receive thread status notifications. It protects clients that only want a smaller or more stable set of messages from being sent `thread/status/changed` anyway.

**Data flow**: The test creates a fresh temporary Codex home directory, starts a fake model server, and writes a config file that points to it. It launches the app server and initializes it with client capabilities that include `opt_out_notification_methods` containing `thread/status/changed`. Then it starts a thread and a turn, waits for the turn to complete, and briefly listens for a filtered-out status notification. The expected result is a timeout: no `thread/status/changed` message should arrive. If such a notification does arrive, or if reading fails for another reason, the test fails.

**Call relations**: This test shares the same setup helper, `create_config_toml`, and the same fake-response pattern as the runtime-update test. Its role in the bigger flow is to exercise initialization options: after the client declares its opt-out choice during initialization, the rest of the conversation runs normally, but the server should suppress the unwanted notification before it reaches the client.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (default, new, bail!, Integer, create_mock_responses_server_sequence, to_response, from_millis, timeout, vec!).


##### `create_config_toml`  (lines 219–243)

```
fn create_config_toml(codex_home: &std::path::Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes the temporary configuration file needed by both tests. It tells the app server to use the fake model provider instead of a real external service.

**Data flow**: It receives the path to the temporary Codex home directory and the fake server’s URI. It builds the path to `config.toml`, formats a TOML configuration string with the fake server URL, and writes that text to disk. The result is a standard file-write result: success if the config was created, or an input/output error if writing failed.

**Call relations**: Both tests call this helper before starting the test app server. It is the bridge between the mock responses server and the app server under test: the mock server is created first, its URI is inserted into the config file here, and then the app server reads that config during startup.

*Call graph*: called by 2 (thread_status_changed_can_be_opted_out, thread_status_changed_emits_runtime_updates); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/turn_interrupt.rs`

`test` · `test run`

A “turn” is one exchange where the user asks something and the assistant works on it. Some turns can take a long time, especially if the assistant starts a shell command. This test file makes sure the server behaves correctly when the client asks to interrupt that work.

Each test starts a temporary app server with a temporary config file and a fake model server. The fake model server sends controlled responses, such as “run this long sleep command” or “reply with done.” This lets the test create exact situations without depending on a real model.

The first test starts a turn that runs a long command, sends a turn interrupt request, and expects the server to report that the turn ended as interrupted. The second test lets a turn finish normally, then tries to interrupt it afterward; the correct behavior is an error, because there is nothing still running to stop. The third test covers a subtle case: the assistant wants to run a command but is waiting for user approval. If the turn is interrupted during that wait, the pending approval request must be marked resolved so the client is not left with a stale prompt.

The helper at the bottom writes the small config file needed to point the app server at the fake model server.

#### Function details

##### `turn_interrupt_aborts_running_turn`  (lines 32–130)

```
async fn turn_interrupt_aborts_running_turn() -> Result<()>
```

**Purpose**: This test proves that interrupting an active turn actually stops it. It creates a turn that runs a long sleep command, sends an interrupt request, and checks that the server reports the turn as interrupted.

**Data flow**: The test starts with a temporary home folder, a temporary working folder, and a fake model response that asks the app to run a long command. It writes a config file pointing the app server at that fake model, starts the test server, creates a thread, then starts a turn in that thread. After giving the command a moment to begin, it sends a turn interrupt request using the thread id and turn id. The expected result is a normal interrupt response followed by a turn completion notification whose status is “Interrupted.”

**Call relations**: This is one of the main end-to-end checks for the interrupt feature. It calls create_config_toml to prepare the server’s test configuration, then uses the test support server and protocol helpers to drive the same request and notification flow a real client would use.

*Call graph*: calls 2 internal fn (new, create_config_toml); 11 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, from_value, create_dir, from_secs, sleep, timeout (+1 more)).


##### `turn_interrupt_rejects_completed_turn`  (lines 133–207)

```
async fn turn_interrupt_rejects_completed_turn() -> Result<()>
```

**Purpose**: This test makes sure the server refuses to interrupt a turn that has already finished. That matters because an interrupt should only apply to work that is still in progress.

**Data flow**: The test creates a temporary app setup and a fake model response that immediately completes with a final assistant message. It starts a thread, starts a turn, waits until the server sends a completion notification, and confirms the turn status is “Completed.” Then it sends an interrupt request for that same turn. Instead of a successful interrupt, the test expects a JSON-RPC error with the standard “invalid request” code.

**Call relations**: This test covers the boundary case after normal completion. Like the other tests, it relies on create_config_toml for the temporary config and uses the app-server test harness to speak the JSON-RPC protocol as a client would.

*Call graph*: calls 2 internal fn (new, create_config_toml); 10 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, from_value, create_dir, from_millis, timeout, vec!).


##### `turn_interrupt_resolves_pending_command_approval_request`  (lines 210–328)

```
async fn turn_interrupt_resolves_pending_command_approval_request() -> Result<()>
```

**Purpose**: This test checks that interrupting a turn also cleans up a command approval request that is waiting for the user. Without this, a client could keep showing an approval prompt for work that has already been cancelled.

**Data flow**: The test prepares a fake model response that asks to run a long command, but configures the server so the command requires approval first. It starts a thread and turn, then waits for the server to send a command approval request. After confirming that the request belongs to the expected thread, turn, and command item, it sends a turn interrupt request. The server should respond to the interrupt, send a notification that the pending server request was resolved, and then send a turn completion notification marked “Interrupted.”

**Call relations**: This test focuses on the interaction between turn interruption and server-originated approval prompts. It uses create_config_toml to set stricter approval and sandbox settings, then verifies both sides of the cleanup: the approval request is resolved and the turn is marked interrupted.

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

**Purpose**: This helper writes the temporary config file used by the tests. It tells the app server which fake model server to call and which approval and sandbox rules to use.

**Data flow**: The function receives a temporary Codex home path, the fake server’s address, an approval policy string, and a sandbox mode string. It builds the path to config.toml and writes a small TOML configuration file there. The output is an I/O result showing whether the file write succeeded or failed.

**Call relations**: All three tests call this helper during setup. It hides the repetitive config-file writing so each test can focus on the behavior being checked: interrupting a running turn, rejecting an interrupt for a completed turn, or resolving a pending approval request.

*Call graph*: called by 3 (turn_interrupt_aborts_running_turn, turn_interrupt_rejects_completed_turn, turn_interrupt_resolves_pending_command_approval_request); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/turn_start.rs`

`test` · `test run`

A “turn” is one round of interaction with Codex: the user sends input, the server asks the model what to do, and the server streams back messages, tool calls, approvals, and completion notices. This test file acts like a careful outside client. It starts a real test app server, points it at fake model servers, sends JSON-RPC requests, and checks what comes back. JSON-RPC is a simple request-and-response message format used here between the client and app server.

The tests cover many paths that can break user experience or safety. They verify ordinary turns, empty input, text limits, image input, extra context, model and service-tier overrides, personality settings, collaboration modes, analytics, command execution, file patch approval, sandbox and working-directory changes, environment selection, and multi-agent child threads. Many tests also check that invalid requests fail before a turn actually starts, so the client does not see misleading progress events.

The helpers at the bottom create temporary configuration files and fake skills. The mock model servers are like stage actors: they return scripted model events so the app server can be tested without calling a real model. Without this file, regressions in turn startup, approval prompts, notifications, or model request shaping could reach users unnoticed.

#### Function details

##### `body_contains`  (lines 108–112)

```
fn body_contains(req: &wiremock::Request, text: &str) -> bool
```

**Purpose**: Checks whether a mock HTTP request body contains a given piece of text. Tests use it to match the model request they care about.

**Data flow**: It receives a mock request and a search string. It tries to read the request body as UTF-8 text, then returns true if that text includes the search string and false otherwise.

**Call relations**: Several tests use this as a small filter when setting up mock model responses. It lets the fake server choose a response based on what the app server sent to the model.

*Call graph*: 1 external calls (from_utf8).


##### `run_local_image_turn`  (lines 114–177)

```
async fn run_local_image_turn(detail: Option<ImageDetail>) -> Result<Vec<Value>>
```

**Purpose**: Runs a complete test turn that sends a local image file to the app server. It is shared by tests that check how image detail settings are forwarded to the model.

**Data flow**: It receives an optional image detail value. It creates a fake model server, writes a temporary config and tiny PNG file, starts a thread, sends a turn containing that local image, waits for completion, then returns the image entries found in the outgoing model requests.

**Call relations**: The local-image detail tests call this helper instead of repeating the full setup. It hands off request inspection to `received_response_input_images` after the turn finishes.

*Call graph*: calls 3 internal fn (new, create_config_toml, received_response_input_images); called by 2 (turn_start_defaults_local_image_detail_to_high, turn_start_forwards_custom_local_image_detail); 9 external calls (default, default, new, Integer, create_mock_responses_server_sequence_unchecked, assert!, write, timeout, vec!).


##### `received_response_input_images`  (lines 179–214)

```
async fn received_response_input_images(server: &wiremock::MockServer) -> Result<Vec<Value>>
```

**Purpose**: Extracts image input blocks from requests sent to the mock Responses API. Tests use it to verify what the app server actually sent to the model.

**Data flow**: It reads all HTTP requests received by the mock server, keeps only `/responses` calls, parses their JSON bodies, walks through message content, and collects blocks whose type is `input_image`.

**Call relations**: It is called by `run_local_image_turn` after the app server has completed a turn. It turns raw captured HTTP traffic into a small list that image tests can assert on.

*Call graph*: called by 1 (run_local_image_turn); 2 external calls (received_requests, new).


##### `turn_start_with_empty_input_runs_model_request`  (lines 217–316)

```
async fn turn_start_with_empty_input_runs_model_request() -> Result<()>
```

**Purpose**: Verifies that a turn with no user input still starts and completes, but does not invent an empty user message. This protects the model prompt from meaningless blank messages.

**Data flow**: The test creates a mock model response, starts the app server and a thread, sends `turn/start` with an empty input list, then checks the turn response, started and completed notifications, and the outgoing model request body.

**Call relations**: It exercises the normal `turn/start` path through the test app server. It depends on the mock model server to complete the turn and then inspects the captured request.

*Call graph*: calls 2 internal fn (new, create_config_toml); 11 external calls (default, default, new, new, Integer, create_mock_responses_server_sequence_unchecked, assert!, assert_eq!, from_value, timeout (+1 more)).


##### `turn_start_additional_context_flows_to_model_input`  (lines 319–393)

```
async fn turn_start_additional_context_flows_to_model_input() -> Result<()>
```

**Purpose**: Checks that extra context supplied by the client is included in the model input. This matters because editors or other clients may attach useful context outside the user's typed message.

**Data flow**: The test starts a thread, sends a text turn with an additional untrusted context entry, waits for completion, then parses the model request and looks for the context wrapped in an external-context tag.

**Call relations**: It drives the app server through thread start and turn start, then reads the mock server's received request to confirm the app server passed the context onward.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (default, default, from, new, Integer, create_mock_responses_server_sequence_unchecked, assert!, timeout, vec!).


##### `turn_start_sends_originator_header`  (lines 396–470)

```
async fn turn_start_sends_originator_header() -> Result<()>
```

**Purpose**: Verifies that the app server forwards the client application's identity as an `originator` HTTP header. This helps downstream services know which product client initiated the model request.

**Data flow**: The test initializes the server with client info, starts a thread and turn, waits for completion, then checks every mock model request for the expected header value.

**Call relations**: It uses client initialization before the normal turn flow. The mock model server records requests so the test can inspect their headers after the turn completes.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (from, default, new, Integer, create_mock_responses_server_sequence_unchecked, assert!, assert_eq!, timeout, vec!).


##### `turn_start_emits_user_message_item_with_text_elements`  (lines 473–561)

```
async fn turn_start_emits_user_message_item_with_text_elements() -> Result<()>
```

**Purpose**: Checks that a user message item is emitted with its client id and rich text element metadata preserved. Text elements mark ranges of text with extra information, such as annotations.

**Data flow**: The test sends a text input with a client message id and a text element range. It waits until an `item/started` notification for a user message appears, then compares the notification content to the original input.

**Call relations**: It sits in the stream of notifications produced by `turn/start`. It filters out unrelated item events until the user-message item appears.

*Call graph*: calls 2 internal fn (new, create_config_toml); 10 external calls (from, default, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, panic!, from_value, timeout, vec!).


##### `turn_start_emits_thread_scoped_warning_notification_for_trimmed_skills`  (lines 564–675)

```
async fn turn_start_emits_thread_scoped_warning_notification_for_trimmed_skills() -> Result<()>
```

**Purpose**: Verifies that when skill descriptions are too large for the model context budget, the server warns the correct thread and omits trimmed skill details. This prevents silent loss of model-visible guidance.

**Data flow**: The test shrinks a model context window in the model cache, writes two fake skills, starts a turn, waits for a warning notification, and checks both the warning text and the outgoing model request body.

**Call relations**: It uses `create_config_toml` and `write_test_skill` for setup. The turn flow produces both a warning notification to the client and a model request captured by the mock server.

*Call graph*: calls 3 internal fn (new_with_env, create_config_toml, write_test_skill); 18 external calls (from, default, new, Integer, default, create_mock_responses_server_sequence_unchecked, write_models_cache, assert!, assert_eq!, format! (+8 more)).


##### `turn_start_sends_service_tier_id_to_model_request`  (lines 678–745)

```
async fn turn_start_sends_service_tier_id_to_model_request() -> Result<()>
```

**Purpose**: Checks that a service tier chosen for a turn is sent to the model API. A service tier is a model-provider option that may affect routing or performance.

**Data flow**: The test finds a bundled model preset with service tiers, starts a thread with that model, starts a turn with a selected tier, waits for completion, and checks the JSON field sent to the mock model server.

**Call relations**: It uses the model catalog and a mock Responses API endpoint. The app server is expected to translate the turn parameter into the outgoing `service_tier` field.

*Call graph*: calls 6 internal fn (new, create_config_toml, all_model_presets, mount_sse_once, sse, start_mock_server); 8 external calls (default, default, new, Integer, write_models_cache, assert_eq!, timeout, vec!).


##### `thread_start_omits_empty_instruction_overrides_from_model_request`  (lines 748–836)

```
async fn thread_start_omits_empty_instruction_overrides_from_model_request() -> Result<()>
```

**Purpose**: Ensures that empty instruction override strings do not become empty instruction messages in the model request. This avoids confusing or noisy prompt content.

**Data flow**: The test starts a thread with empty base and developer instruction overrides, then starts a turn and inspects the model request. It verifies there is no top-level instructions field and no empty developer input text.

**Call relations**: Although the name mentions thread start, the check happens after a turn sends a model request. It confirms thread-level overrides are cleaned up before the model call.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once, sse, start_mock_server); 10 external calls (default, default, from, new, new, Integer, assert_eq!, json!, timeout, vec!).


##### `turn_start_tracks_turn_event_analytics`  (lines 839–973)

```
async fn turn_start_tracks_turn_event_analytics() -> Result<()>
```

**Purpose**: Checks that the app server records a detailed analytics event for a turn, including retry counts, model information, input image count, timing fields, and completion status.

**Data flow**: The test configures one retryable model failure followed by success, starts a turn with an image URL and metadata, waits for completion, then waits for and inspects the captured analytics event.

**Call relations**: It uses analytics test helpers to capture events sent by the app server. The fake model server records two model requests, proving the retry path is reflected in analytics.

*Call graph*: calls 5 internal fn (new_without_managed_config, mount_analytics_capture, wait_for_analytics_event, mount_response_sequence, start_mock_server); 11 external calls (default, from, new, Integer, write_mock_responses_config_toml_with_chatgpt_base_url, assert!, assert_eq!, read_to_string, write, timeout (+1 more)).


##### `turn_profile_tracks_blocking_tool_and_follow_up_sampling`  (lines 976–1077)

```
async fn turn_profile_tracks_blocking_tool_and_follow_up_sampling() -> Result<()>
```

**Purpose**: Verifies that turn profiling counts time spent waiting on a blocking tool and records the follow-up model request. A blocking tool is one where the server must wait for client input before continuing.

**Data flow**: The mock model first asks for user input, then later returns a final answer. The test waits for the server request, delays briefly, responds, waits for completion, and checks analytics timing and sampling counts.

**Call relations**: It exercises a multi-step turn: model request, tool request to the client, client response, then another model request. The analytics capture confirms the server measured that shape correctly.

*Call graph*: calls 3 internal fn (new_without_managed_config, mount_analytics_capture, wait_for_analytics_event); 12 external calls (default, new, Integer, create_mock_responses_server_sequence, write_mock_responses_config_toml_with_chatgpt_base_url, assert_eq!, json!, panic!, from_millis, sleep (+2 more)).


##### `turn_start_accepts_text_at_limit_with_mention_item`  (lines 1080–1140)

```
async fn turn_start_accepts_text_at_limit_with_mention_item() -> Result<()>
```

**Purpose**: Checks that text exactly at the maximum allowed length is accepted, even when combined with a non-text mention item. This guards the boundary of input validation.

**Data flow**: The test sends one text input with exactly the maximum character count plus a mention input. It expects the turn to start in progress and then complete normally.

**Call relations**: It uses the normal thread and turn flow with a mock model response. The key relation is to input validation before the turn starts.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (from, default, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, timeout, vec!).


##### `turn_start_rejects_combined_oversized_text_input`  (lines 1143–1216)

```
async fn turn_start_rejects_combined_oversized_text_input() -> Result<()>
```

**Purpose**: Verifies that multiple text chunks are counted together and rejected if their combined length is too large. This prevents clients from bypassing the limit by splitting text.

**Data flow**: The test starts a thread, sends two text inputs whose total character count exceeds the limit, reads the JSON-RPC error, and confirms no `turn/started` notification arrives.

**Call relations**: It exercises the validation path before any model request. The app server should return an invalid-parameters error instead of entering the turn lifecycle.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (from, default, new, Integer, assert!, assert_eq!, from_millis, timeout, vec!).


##### `turn_start_rejects_invalid_permission_selection_before_starting_turn`  (lines 1219–1291)

```
async fn turn_start_rejects_invalid_permission_selection_before_starting_turn() -> Result<()>
```

**Purpose**: Checks that an unsafe permission override is rejected before the turn starts when managed configuration forbids it. This protects policy rules from being bypassed by a client request.

**Data flow**: The test writes managed config that requires read-only sandboxing, starts a thread, asks for danger-full-access permissions in `turn/start`, then checks the error message and absence of `turn/started`.

**Call relations**: It uses configuration files to create a policy conflict. The app server should stop at request validation and never contact the model.

*Call graph*: calls 2 internal fn (new, create_config_toml); 10 external calls (from, default, new, Integer, assert!, assert_eq!, write, from_millis, timeout, vec!).


##### `turn_start_rejects_unknown_environment_before_starting_turn`  (lines 1294–1358)

```
async fn turn_start_rejects_unknown_environment_before_starting_turn() -> Result<()>
```

**Purpose**: Verifies that selecting a nonexistent execution environment fails before the turn starts. This avoids creating a turn that cannot run its tools.

**Data flow**: The test starts a thread, sends `turn/start` with an environment id named `missing`, reads the JSON-RPC error, and confirms no started notification follows.

**Call relations**: It tests environment resolution in the turn-start gate. The repeating mock model server is present but should not matter because validation fails first.

*Call graph*: calls 2 internal fn (new, create_config_toml); 10 external calls (default, default, new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, from_millis, timeout, vec!).


##### `turn_start_emits_notifications_and_accepts_model_override`  (lines 1361–1502)

```
async fn turn_start_emits_notifications_and_accepts_model_override() -> Result<()>
```

**Purpose**: Checks the basic turn lifecycle notifications and confirms that a later turn can override the model. This is the core happy-path behavior for v2 turn startup.

**Data flow**: The test starts one thread, sends a first turn and checks started/completed notifications, then sends a second turn with a different model and checks that it has a distinct id and also completes.

**Call relations**: It drives two turns through the same thread. The mock model server supplies enough responses for both, while the app server emits lifecycle notifications to the client.

*Call graph*: calls 2 internal fn (new, create_config_toml); 11 external calls (from, default, new, Integer, create_mock_responses_server_sequence_unchecked, assert!, assert_eq!, assert_ne!, from_value, timeout (+1 more)).


##### `turn_start_accepts_collaboration_mode_override_v2`  (lines 1505–1587)

```
async fn turn_start_accepts_collaboration_mode_override_v2() -> Result<()>
```

**Purpose**: Verifies that a turn-level collaboration mode can override model settings and tool instructions. Collaboration mode changes how the assistant works with the user or other agents.

**Data flow**: The test starts a thread, sends a turn with collaboration settings that specify a different model and reasoning effort, waits for completion, then checks the model request used the collaboration model and included the expected tool guidance.

**Call relations**: It uses a mock Responses API request as evidence that the app server chose the collaboration-mode settings over the direct model override.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once, sse, start_mock_server); 9 external calls (default, default, new, Integer, assert!, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `turn_start_uses_thread_feature_overrides_for_request_user_input_tool_description_v2`  (lines 1590–1673)

```
async fn turn_start_uses_thread_feature_overrides_for_request_user_input_tool_description_v2() -> Result<()>
```

**Purpose**: Checks that feature flags set on a thread affect the description of the request-user-input tool during a later turn. Tool descriptions are part of what the model sees when deciding how to ask the user questions.

**Data flow**: The test starts a thread with a feature override enabled, then starts a collaboration-mode turn and inspects the outgoing model request text for the expected description.

**Call relations**: It links thread configuration to turn-time model prompt construction. The mock server captures the final request for inspection.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once, sse, start_mock_server); 10 external calls (default, default, from, new, Integer, assert!, json!, skip_if_no_network!, timeout, vec!).


##### `turn_start_accepts_personality_override_v2`  (lines 1676–1750)

```
async fn turn_start_accepts_personality_override_v2() -> Result<()>
```

**Purpose**: Verifies that a turn can override the assistant personality and that the override appears in developer instructions sent to the model. Personality changes the style or behavioral guidance.

**Data flow**: The test enables the personality feature, starts a thread, sends a turn with `Friendly` personality, waits for completion, and checks developer messages for a personality specification block.

**Call relations**: It exercises personality prompt injection during turn startup. The mock Responses API request shows what the model actually received.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once, sse, start_mock_server); 9 external calls (from, default, new, Integer, assert!, eprintln!, skip_if_no_network!, timeout, vec!).


##### `turn_start_change_personality_mid_thread_v2`  (lines 1753–1863)

```
async fn turn_start_change_personality_mid_thread_v2() -> Result<()>
```

**Purpose**: Checks that personality can change in the middle of a thread and only appears when changed. This avoids repeating personality update messages unnecessarily.

**Data flow**: The test sends one turn without a personality override and a second turn with `Friendly`. It inspects both model requests and expects only the second to contain the personality specification.

**Call relations**: It uses a two-response mock sequence for two turns in one thread. The comparison between requests proves the server tracks personality state across turns.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_sequence, sse, start_mock_server); 9 external calls (from, default, new, Integer, assert!, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `turn_start_uses_migrated_pragmatic_personality_without_override_v2`  (lines 1866–1954)

```
async fn turn_start_uses_migrated_pragmatic_personality_without_override_v2() -> Result<()>
```

**Purpose**: Verifies that startup migration to a pragmatic personality is respected even when the turn does not explicitly set a personality. This protects users upgraded from older configuration behavior.

**Data flow**: The test creates fake prior rollout history, starts the app server, checks that config now contains the pragmatic personality and a migration marker, starts a turn, and confirms the pragmatic instruction text was sent to the model.

**Call relations**: It connects startup migration with later turn-start prompt building. The model request is the final proof that migrated config affected the turn.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once, sse, start_mock_server); 12 external calls (from, default, new, Integer, create_fake_rollout, assert!, assert_eq!, skip_if_no_network!, read_to_string, timeout (+2 more)).


##### `turn_start_defaults_local_image_detail_to_high`  (lines 1957–1967)

```
async fn turn_start_defaults_local_image_detail_to_high() -> Result<()>
```

**Purpose**: Checks that a local image without an explicit detail setting defaults to high detail. This ensures image input is sent with the expected quality level.

**Data flow**: It calls `run_local_image_turn` with no detail value, receives the captured image blocks from model requests, and asserts that the one image has detail `high`.

**Call relations**: This is a small assertion test built on the shared local-image helper. The helper performs the full server and turn setup.

*Call graph*: calls 1 internal fn (run_local_image_turn); 1 external calls (assert_eq!).


##### `turn_start_forwards_custom_local_image_detail`  (lines 1970–1980)

```
async fn turn_start_forwards_custom_local_image_detail() -> Result<()>
```

**Purpose**: Checks that a client-selected local image detail setting is preserved. In this case, `Original` should reach the model request as `original`.

**Data flow**: It calls `run_local_image_turn` with `ImageDetail::Original`, receives captured image blocks, and checks the detail field.

**Call relations**: Like the default-detail test, it delegates the full turn flow to `run_local_image_turn` and focuses only on the final model payload.

*Call graph*: calls 1 internal fn (run_local_image_turn); 1 external calls (assert_eq!).


##### `turn_start_exec_approval_toggle_v2`  (lines 1983–2137)

```
async fn turn_start_exec_approval_toggle_v2() -> Result<()>
```

**Purpose**: Tests that command execution approval can be required on one turn and disabled on a later turn. This matters because users or clients may change approval policy per turn.

**Data flow**: The first turn causes the model to request a shell command, the server asks the client for approval, the test accepts, and the turn completes. The second turn sets approval to never and danger-full-access sandboxing, then completes without an approval request.

**Call relations**: It exercises the command-tool approval loop between model, app server, and client. It also checks that a `serverRequest/resolved` notification arrives before turn completion.

*Call graph*: calls 2 internal fn (new, create_config_toml); 13 external calls (default, default, new, Integer, create_mock_responses_server_sequence, assert!, assert_eq!, panic!, from_value, to_value (+3 more)).


##### `turn_start_exec_approval_decline_v2`  (lines 2140–2282)

```
async fn turn_start_exec_approval_decline_v2() -> Result<()>
```

**Purpose**: Verifies that declining a requested command marks the command item as declined and does not produce command output. This is important safety feedback for the client UI.

**Data flow**: The test starts a turn where the model asks to run Python, waits for the command item and approval request, sends a decline response, then checks the completed command item has declined status and no exit code or output.

**Call relations**: It follows the command approval path but chooses the decline branch. The app server should still continue the turn and eventually emit `turn/completed`.

*Call graph*: calls 2 internal fn (new, create_config_toml); 15 external calls (default, default, new, Integer, create_mock_responses_server_sequence, assert!, assert_eq!, panic!, from_value, to_value (+5 more)).


##### `turn_start_updates_sandbox_and_cwd_between_turns_v2`  (lines 2285–2454)

```
async fn turn_start_updates_sandbox_and_cwd_between_turns_v2() -> Result<()>
```

**Purpose**: Checks that the working directory and sandbox settings can change between turns. The working directory is the folder where commands run.

**Data flow**: The test creates two directories, runs a first turn with one directory and workspace-write sandboxing, then runs a second turn with another directory and danger-full-access. It checks the second command item uses the second directory and command text.

**Call relations**: It proves per-turn environment settings are not stuck from a previous turn. The fake model requests shell commands so the app server has to materialize the current settings.

*Call graph*: calls 2 internal fn (new, create_config_toml); 14 external calls (default, default, new, Integer, create_mock_responses_server_sequence, format_with_current_shell_display, assert_eq!, matches!, from_value, skip_if_no_network! (+4 more)).


##### `turn_start_permission_profile_rebinds_runtime_workspace_roots_between_turns`  (lines 2458–2604)

```
async fn turn_start_permission_profile_rebinds_runtime_workspace_roots_between_turns() -> Result<()>
```

**Purpose**: On Unix, verifies that a permission profile using dynamic workspace roots is rebound when runtime workspace roots change between turns. This keeps file permissions aligned with the current workspace.

**Data flow**: The test writes a config with a permission profile referencing `:workspace_roots`, runs one turn with an old root, then another with a new root, and inspects each model request's permission instructions.

**Call relations**: It uses the mock Responses API to compare prompt instructions across two turns. The app server must rebuild permission instructions using the latest runtime roots.

*Call graph*: calls 4 internal fn (new, mount_sse_sequence, start_mock_server, from_absolute_path); 11 external calls (default, new, Integer, assert!, assert_eq!, format!, skip_if_no_network!, create_dir, write, timeout (+1 more)).


##### `turn_start_resolves_sticky_thread_local_environment_and_turn_overrides`  (lines 2607–2659)

```
async fn turn_start_resolves_sticky_thread_local_environment_and_turn_overrides() -> Result<()>
```

**Purpose**: Checks several combinations of thread-level and turn-level environment selection for the local environment. Sticky thread settings should interact correctly with per-turn overrides.

**Data flow**: The test creates config with a remote environment but runs a set of cases that select none, empty, or local environments at thread and turn level. Each case starts a thread and turn and expects normal completion.

**Call relations**: It delegates each case to `run_environment_selection_case`. This keeps the table of scenarios readable while reusing the same validation flow.

*Call graph*: calls 3 internal fn (new, create_config_toml, run_environment_selection_case); 6 external calls (default, new, create_mock_responses_server_repeating_assistant, create_dir, write, timeout).


##### `run_environment_selection_case`  (lines 2667–2740)

```
async fn run_environment_selection_case(
    mcp: &mut TestAppServer,
    workspace: &Path,
    case: EnvironmentSelectionCase,
) -> Result<()>
```

**Purpose**: Runs one environment-selection scenario and checks that the turn starts and completes. It is a helper for testing sticky thread environments and turn overrides.

**Data flow**: It receives the test server, workspace path, and one case. It starts a thread with the case's sticky environments, starts a turn with the case's turn environments, reads started and completed notifications, verifies the turn id and completed status, then clears buffered messages.

**Call relations**: It is called repeatedly by `turn_start_resolves_sticky_thread_local_environment_and_turn_overrides`. It uses `environment_params` to convert simple environment id lists into full request parameters.

*Call graph*: calls 6 internal fn (clear_message_buffer, read_stream_until_notification_message, read_stream_until_response_message, send_thread_start_request, send_turn_start_request, environment_params); called by 1 (turn_start_resolves_sticky_thread_local_environment_and_turn_overrides); 8 external calls (default, to_path_buf, to_string_lossy, Integer, assert_eq!, from_value, timeout, vec!).


##### `environment_params`  (lines 2742–2751)

```
fn environment_params(ids: Option<&[&str]>, cwd: &Path) -> Option<Vec<TurnEnvironmentParams>>
```

**Purpose**: Converts a small list of environment ids into the full environment parameter objects expected by thread and turn requests. It keeps the environment-selection tests compact.

**Data flow**: It receives optional ids and a working directory. If ids are present, it builds one `TurnEnvironmentParams` object per id, each with that id and the absolute workspace path; if absent, it returns none.

**Call relations**: It is used by `run_environment_selection_case` for both thread-level and turn-level environment settings.

*Call graph*: called by 1 (run_environment_selection_case).


##### `turn_start_file_change_approval_v2`  (lines 2754–2920)

```
async fn turn_start_file_change_approval_v2() -> Result<()>
```

**Purpose**: Tests the happy path for file patch approval. The server should show the proposed file change, ask for approval, apply the patch after acceptance, and report completion.

**Data flow**: The mock model requests an `apply_patch` tool call. The test checks the started file-change item and its diff, accepts the approval request, waits for request resolution and item completion, then reads the new file from disk.

**Call relations**: It exercises the file-change approval loop between model, app server, client, and filesystem. It confirms notification order around `serverRequest/resolved`.

*Call graph*: calls 2 internal fn (new, create_config_toml); 17 external calls (default, default, new, Integer, create_mock_responses_server_sequence, assert!, assert_eq!, panic!, assert_eq!, from_value (+7 more)).


##### `turn_start_does_not_stream_apply_patch_change_updates_without_feature_v2`  (lines 2923–3018)

```
async fn turn_start_does_not_stream_apply_patch_change_updates_without_feature_v2() -> Result<()>
```

**Purpose**: Verifies that live patch-update notifications are not emitted unless the streaming feature flag is enabled. This protects clients from receiving events they did not opt into.

**Data flow**: The fake model streams partial patch text and then the complete patch. The test runs a turn with the feature disabled, waits for completion, and checks no `item/fileChange/patchUpdated` notification is pending.

**Call relations**: It contrasts with the next streaming test. The model emits deltas either way, but the app server should suppress patch-update notifications without the feature flag.

*Call graph*: calls 2 internal fn (new, create_config_toml); 10 external calls (default, default, new, Integer, create_mock_responses_server_sequence, assert!, skip_if_no_network!, create_dir, timeout, vec!).


##### `turn_start_streams_apply_patch_change_updates_v2`  (lines 3021–3177)

```
async fn turn_start_streams_apply_patch_change_updates_v2() -> Result<()>
```

**Purpose**: Checks that live patch-update notifications are emitted when the feature is enabled and the model uses the correct patch tool type. This lets clients show file diffs while the model is still producing them.

**Data flow**: The test enables the apply-patch streaming feature, adjusts the model cache to use a freeform patch tool, starts a turn, then reads patch-updated notifications until the streamed diff becomes complete.

**Call relations**: It uses a mock model stream containing both irrelevant tool deltas and real apply-patch deltas. The app server should ignore unrelated deltas and send updates for the patch call.

*Call graph*: calls 2 internal fn (new, create_config_toml); 19 external calls (from, default, new, new, Integer, create_mock_responses_server_sequence, write_models_cache, assert!, assert_eq!, from (+9 more)).


##### `turn_start_emits_spawn_agent_item_with_model_metadata_v2`  (lines 3180–3420)

```
async fn turn_start_emits_spawn_agent_item_with_model_metadata_v2() -> Result<()>
```

**Purpose**: Verifies that when the model spawns a child agent, the app server emits collaboration tool-call items with the requested model and reasoning effort. This keeps the UI informed about child-agent work.

**Data flow**: The test scripts a parent model request that calls `spawn_agent`, a child response, and a parent follow-up. It starts a turn, checks the spawn item when started and completed, captures the child thread id, then deletes the parent and verifies both parent and child threads are removed.

**Call relations**: It exercises multi-agent orchestration through normal turn notifications and thread deletion. The mock server has separate responses for parent, child, and parent follow-up model calls.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once_match, sse, start_mock_server); 15 external calls (from, default, new, new, Integer, default, assert!, assert_eq!, json!, from_value (+5 more)).


##### `direct_input_to_multi_agent_v2_subagent_is_rejected`  (lines 3423–3548)

```
async fn direct_input_to_multi_agent_v2_subagent_is_rejected() -> Result<()>
```

**Purpose**: Checks that direct client input to a multi-agent v2 child thread is rejected. Child agents should be controlled by the multi-agent system, not by ordinary app-server turn or steer requests.

**Data flow**: The test starts a parent turn that spawns a child, waits until it learns the child thread id, then sends both `turn/start` and `turn/steer` directly to that child and checks both return the same invalid-request error.

**Call relations**: It first uses the model-driven spawn flow to create a real sub-agent, then tests the server's guardrails around that child thread.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once_match, sse, start_mock_server); 12 external calls (from, default, new, Integer, to_response, write_models_cache, assert_eq!, json!, from_value, to_string (+2 more)).


##### `turn_start_emits_spawn_agent_item_with_effective_role_model_metadata_v2`  (lines 3551–3737)

```
async fn turn_start_emits_spawn_agent_item_with_effective_role_model_metadata_v2() -> Result<()>
```

**Purpose**: Verifies that a spawned agent reports the effective model settings from its configured role, not just the raw model settings requested by the model. This matters when roles override child-agent configuration.

**Data flow**: The test writes a custom role config with its own model and reasoning effort, scripts a spawn request for that role, starts a turn, and checks the completed spawn item reports the role's model and effort.

**Call relations**: It follows the same multi-agent spawn path as the earlier spawn metadata test, but adds role configuration to prove the app server resolves final child-agent settings before notifying the client.

*Call graph*: calls 5 internal fn (new, create_config_toml, mount_sse_once_match, sse, start_mock_server); 16 external calls (from, default, new, Integer, assert!, assert_eq!, format!, json!, from_value, to_string (+6 more)).


##### `turn_start_file_change_approval_accept_for_session_persists_v2`  (lines 3740–3920)

```
async fn turn_start_file_change_approval_accept_for_session_persists_v2() -> Result<()>
```

**Purpose**: Tests that accepting file changes for the session skips later approval prompts in the same thread/session. This reduces repeated prompts after the user has granted session-wide permission.

**Data flow**: The first turn applies a new file patch after the test responds `AcceptForSession`. The second turn applies an update patch to the same file and should complete without another approval request; the test checks the file contents after both turns.

**Call relations**: It exercises state that persists across turns. The app server must remember the session approval decision when handling the second model patch call.

*Call graph*: calls 2 internal fn (new, create_config_toml); 14 external calls (default, default, new, Integer, create_mock_responses_server_sequence, assert_eq!, panic!, from_value, to_value, skip_if_no_network! (+4 more)).


##### `turn_start_file_change_approval_decline_v2`  (lines 3923–4075)

```
async fn turn_start_file_change_approval_decline_v2() -> Result<()>
```

**Purpose**: Verifies that declining a file patch marks the file-change item as declined and does not write the file. This is the safety counterpart to the file-change approval happy path.

**Data flow**: The mock model proposes adding `README.md`. The test checks the proposed diff, sends a decline response to the approval request, waits for the file-change item to complete as declined, and confirms the file does not exist.

**Call relations**: It uses the same approval loop as the acceptance test but follows the decline branch. The turn still completes after the rejected patch.

*Call graph*: calls 2 internal fn (new, create_config_toml); 16 external calls (default, default, new, Integer, create_mock_responses_server_sequence, assert!, assert_eq!, panic!, assert_eq!, from_value (+6 more)).


##### `command_execution_notifications_include_process_id`  (lines 4079–4213)

```
async fn command_execution_notifications_include_process_id() -> Result<()>
```

**Purpose**: Checks that command execution item notifications include a process id from start through completion. A process id helps clients connect UI state to the actual running process.

**Data flow**: With unified exec enabled and danger-full-access sandboxing, the test starts a turn where the model asks to execute a command. It reads the started and completed command items and compares their process ids.

**Call relations**: It exercises the command execution path without an approval prompt. On Windows the test is ignored because process id reporting differs there.

*Call graph*: calls 2 internal fn (new, create_config_toml_with_sandbox); 12 external calls (from, default, new, Integer, create_mock_responses_server_sequence, assert!, assert_eq!, from_value, skip_if_no_network!, timeout (+2 more)).


##### `turn_start_with_elevated_override_does_not_persist_project_trust`  (lines 4216–4274)

```
async fn turn_start_with_elevated_override_does_not_persist_project_trust() -> Result<()>
```

**Purpose**: Ensures that temporarily elevating a turn to danger-full-access does not write project trust into the user's config. This prevents a one-off override from becoming a permanent trust decision.

**Data flow**: The test starts a thread in a temporary workspace, sends a turn with danger-full-access sandboxing, waits for completion, then reads `config.toml` and checks it does not contain a trusted project entry.

**Call relations**: It uses the normal turn-start flow but inspects configuration afterward. The app server should apply the override only in memory for that turn.

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

**Purpose**: Writes a standard test `config.toml` that points the app server at a mock model server. Most tests use it to create a predictable temporary app-server home.

**Data flow**: It receives a Codex home directory, mock server URL, approval policy string, and feature flags. It delegates to `create_config_toml_with_sandbox` using read-only sandbox mode.

**Call relations**: Many tests call this during setup before starting `TestAppServer`. It is the common path for creating consistent model-provider and feature configuration.

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

**Purpose**: Writes a test `config.toml` with a chosen sandbox mode. Tests use it when they need the app server to start with read-only, danger-full-access, or another sandbox setting.

**Data flow**: It receives directory, server URL, approval policy, feature flags, and sandbox mode. It converts feature enum values into config keys, formats a TOML file with mock model-provider settings, and writes it to disk.

**Call relations**: It is called directly by tests that need custom sandbox setup and indirectly by `create_config_toml`. The resulting file is read by `TestAppServer` during initialization.

*Call graph*: called by 2 (command_execution_notifications_include_process_id, create_config_toml); 4 external calls (new, join, format!, write).


##### `write_test_skill`  (lines 4340–4347)

```
fn write_test_skill(codex_home: &Path, name: &str) -> std::io::Result<()>
```

**Purpose**: Creates a fake skill definition under the temporary Codex home. A skill is a named piece of guidance that can be shown to the model.

**Data flow**: It receives the Codex home path and skill name, creates a `skills/<name>` directory, and writes a minimal `SKILL.md` file with front matter and a body.

**Call relations**: It is used by the trimmed-skills warning test to give the app server skills to load and potentially omit from the model prompt.

*Call graph*: called by 1 (turn_start_emits_thread_scoped_warning_notification_for_trimmed_skills); 4 external calls (join, format!, create_dir_all, write).


### `app-server/tests/suite/v2/turn_steer.rs`

`test` · `test run`

A “turn” is one assistant response in a thread. “Steering” is like tapping the assistant on the shoulder while it is still working and giving it extra user guidance. These tests create a temporary Codex home folder, start a test app server, point it at a fake Responses API server, and then send JSON-RPC requests. JSON-RPC is a simple message format where each request gets either a response or an error.

The fake server lets the tests control what the model would do, such as asking to run a long `sleep` command. That long-running command keeps the turn active long enough for the test to send a steer request. The tests then watch the app server’s outgoing stream for responses and notifications, such as “turn started”, “item started”, or “turn completed”.

The file focuses on four important safety rules. A steer request must target a real active turn. Its text cannot be larger than the configured maximum. If accepted, the server must return the active turn id and add the new user message to the thread. And “additional context” by itself must not sneak into the model request when there is no real user input. The tests also verify analytics events so product telemetry matches what actually happened.

#### Function details

##### `turn_steer_requires_active_turn`  (lines 40–105)

```
async fn turn_steer_requires_active_turn() -> Result<()>
```

**Purpose**: This test proves that the server refuses to steer a turn that is not actually active. It protects against a client accidentally or maliciously attaching new input to a made-up turn id.

**Data flow**: The test starts with an empty temporary server setup and creates a new thread, but it does not start a turn. It then sends a steer request with an expected turn id of `turn-does-not-exist`. The server replies with an error, and the test checks that an analytics event says the request was rejected because there was no active turn.

**Call relations**: The test uses the shared test harness to start the app server and a mock Responses API server. It sends a thread-start request first so there is a valid thread, then calls the turn-steer path directly. After the app server rejects the request, the test asks the analytics helper to fetch the recorded `codex_turn_steer_event` and confirms it matches the rejection.

*Call graph*: calls 3 internal fn (new_without_managed_config, mount_analytics_capture, wait_for_analytics_event); 9 external calls (default, new, Integer, create_mock_responses_server_sequence, write_mock_responses_config_toml_with_chatgpt_base_url, assert_eq!, create_dir, timeout, vec!).


##### `turn_steer_rejects_oversized_text_input`  (lines 108–217)

```
async fn turn_steer_rejects_oversized_text_input() -> Result<()>
```

**Purpose**: This test checks that steering input has the same size protection as normal user input. Without this, a client could send an extremely large message while a turn is running and overload validation, storage, or model request building.

**Data flow**: The test prepares a fake model response that asks the server to run a long `sleep` command, then starts a thread and begins a turn so there is an active turn to steer. It builds a text string one character longer than the allowed maximum and sends it as steer input. The server returns an invalid-parameters error, including structured details such as the maximum size and actual size; the test then interrupts the long-running turn so cleanup can finish.

**Call relations**: The mock response server creates the long-running command response, and the test app server reads it during turn start. Once the `turn/started` notification proves the turn is active, this test sends the steer request. The validation path rejects the request before it can become a user message, and the test harness is used at the end to abort the still-running turn.

*Call graph*: calls 2 internal fn (new_without_managed_config, mount_analytics_capture); 9 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, write_mock_responses_config_toml_with_chatgpt_base_url, assert_eq!, create_dir, timeout, vec!).


##### `turn_steer_returns_active_turn_id`  (lines 220–363)

```
async fn turn_steer_returns_active_turn_id() -> Result<()>
```

**Purpose**: This test verifies the happy path: steering an active turn succeeds, returns the id of that same turn, and appears in the thread as a user message. It confirms that clients can reliably know which running turn accepted their guidance.

**Data flow**: The test starts a thread, starts a turn whose fake model response runs a short `sleep` command, and waits until the turn is active. It sends a steer request containing the text `steer` and a client message id. The server responds with a `TurnSteerResponse` containing the active turn id, emits an `item/started` notification for the new user message, records an accepted analytics event, and eventually completes the turn.

**Call relations**: This test ties together the main pieces of the turn-steer flow. The mock Responses API keeps the turn alive, the test app server accepts the steer request, the notification stream shows that the new user message was inserted, and the analytics helper confirms the server recorded the request as accepted. Finally, the test waits for `turn/completed` to make sure the whole turn finishes cleanly.

*Call graph*: calls 3 internal fn (new_without_managed_config, mount_analytics_capture, wait_for_analytics_event); 10 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, write_mock_responses_config_toml_with_chatgpt_base_url, assert_eq!, from_value, create_dir, timeout, vec!).


##### `turn_steer_rejects_context_only_input_without_merging_context`  (lines 366–480)

```
async fn turn_steer_rejects_context_only_input_without_merging_context() -> Result<()>
```

**Purpose**: This test makes sure extra context cannot be sent by itself as a steer message. That matters because context can be untrusted information, and it should not be silently merged into a model request unless there is valid user input to go with it.

**Data flow**: The test starts a thread and an active turn, then sends a steer request with no user input but with `additional_context` containing browser information. The server rejects the request with `input must not be empty`. After the turn completes, the test inspects the mock server’s received `/responses` requests and confirms that the rejected browser context was not included in the later model request body.

**Call relations**: The test uses the app server and mock Responses API in the same pattern as the other active-turn tests. It deliberately sends an invalid steer request during the active turn, then later asks the mock server what HTTP requests it received. That final inspection proves the rejection was not just a visible error to the client; it also prevented the extra context from being passed along downstream.

*Call graph*: calls 2 internal fn (new_without_managed_config, mount_analytics_capture); 12 external calls (default, from, new, new, Integer, create_mock_responses_server_sequence_unchecked, write_mock_responses_config_toml_with_chatgpt_base_url, assert!, assert_eq!, create_dir (+2 more)).


### Review, compaction, and imported sessions
These suites cover higher-level lifecycle flows layered on threads, including review execution, context compaction, external-agent imports, and safety/status signaling during active sessions.

### `app-server/tests/suite/v2/compaction.rs`

`test` · `test run`

These are end-to-end tests for context compaction, so they exercise the system much like a real client would. The tests create a temporary app configuration, point the app server at a mock Responses API, then talk to the app server over JSON-RPC, which is a request-and-response message format using JSON. The mock server returns staged assistant replies with token counts; high token counts make the app server decide the conversation is getting too large and should be compacted.

The file checks three main stories. First, automatic local compaction should announce that a context-compaction item has started and then completed. Second, automatic remote compaction should do the same, and should also call the remote compact endpoint with the right metadata headers. Third, a manual thread compact request should start compaction and return a normal empty response. Two negative tests confirm that bad or unknown thread IDs are rejected with a clear invalid-request error.

The helper functions are the “client script” for the tests: start a thread, send turns, wait for turn completion, and wait until the stream reports compaction start and completion. Without these tests, the server could silently stop telling clients when compaction happens, call the wrong backend endpoint, or accept invalid compaction requests.

#### Function details

##### `auto_compaction_local_emits_started_and_completed_items`  (lines 51–107)

```
async fn auto_compaction_local_emits_started_and_completed_items() -> Result<()>
```

**Purpose**: This test proves that automatic local compaction produces visible start and finish events for the client. It simulates a conversation that grows beyond the configured token limit and checks that both notifications refer to the same compaction item in the same thread.

**Data flow**: It starts with a mock model server that will return several canned replies, including large token counts that force compaction. It writes a temporary configuration with a very low compaction limit, starts the app server, creates a thread, and sends three user messages. After the server compacts the context, the test reads the outgoing notification stream and verifies that a context-compaction item was started and then completed, with matching IDs.

**Call relations**: This is one of the top-level test stories. It relies on start_thread to create the conversation, send_turn_and_wait to drive the conversation forward, and the two wait_for_context_compaction_* helpers to listen for the app server’s streamed compaction notifications.

*Call graph*: calls 8 internal fn (new, send_turn_and_wait, start_thread, wait_for_context_compaction_completed, wait_for_context_compaction_started, mount_sse_sequence, sse, start_mock_server); 8 external calls (default, new, write_mock_responses_config_toml, assert_eq!, skip_if_no_network!, timeout, unreachable!, vec!).


##### `auto_compaction_remote_emits_started_and_completed_items`  (lines 110–249)

```
async fn auto_compaction_remote_emits_started_and_completed_items() -> Result<()>
```

**Purpose**: This test proves that automatic remote compaction also announces start and finish events, and that it calls the remote compaction endpoint correctly. It is especially concerned with the metadata sent alongside normal turn requests and the compaction request.

**Data flow**: It sets up a mock server with three normal response streams and one compact endpoint response containing a compacted history. It writes configuration and fake ChatGPT authentication, starts the app server without an OpenAI API key, starts a thread, and sends three turns. It then waits for compaction start and completion notifications, checks they match the thread and item ID, inspects the mock compact endpoint to confirm it was called once, and examines request headers to confirm turn and compaction metadata were labeled correctly.

**Call relations**: This top-level test uses the same thread and turn helpers as the local compaction test, then goes further by reading the mock server’s recorded requests. It uses parse_json_header to turn metadata headers back into JSON so the assertions can check their meaning.

*Call graph*: calls 10 internal fn (new, new_with_env, send_turn_and_wait, start_thread, wait_for_context_compaction_completed, wait_for_context_compaction_started, mount_compact_json_once, mount_sse_sequence, sse, start_mock_server); 11 external calls (from, new, write_chatgpt_auth, write_mock_responses_config_toml, assert!, assert_eq!, json!, skip_if_no_network!, timeout, unreachable! (+1 more)).


##### `thread_compact_start_triggers_compaction_and_returns_empty_response`  (lines 252–305)

```
async fn thread_compact_start_triggers_compaction_and_returns_empty_response() -> Result<()>
```

**Purpose**: This test checks the manual compaction path: when a client explicitly asks to compact a thread, the server should accept the request, return the expected response shape, and emit start and completion events.

**Data flow**: It prepares a mock response that represents the compaction summary, writes temporary app configuration, starts the app server, and creates a thread. It sends a thread compact request for that thread, waits for the matching JSON-RPC response, converts it into the expected response type, then waits for context-compaction started and completed notifications. The final checks confirm both notifications belong to the thread and refer to the same compaction item.

**Call relations**: This is the top-level test for client-triggered compaction. It calls start_thread for setup and then uses the compaction notification helpers to verify that the request did more than merely return: it actually caused the compaction flow to run.

*Call graph*: calls 7 internal fn (new, start_thread, wait_for_context_compaction_completed, wait_for_context_compaction_started, mount_sse_sequence, sse, start_mock_server); 9 external calls (default, new, Integer, write_mock_responses_config_toml, assert_eq!, skip_if_no_network!, timeout, unreachable!, vec!).


##### `thread_compact_start_rejects_invalid_thread_id`  (lines 308–341)

```
async fn thread_compact_start_rejects_invalid_thread_id() -> Result<()>
```

**Purpose**: This test confirms that the server rejects a compaction request whose thread ID is not even in the expected ID format. This protects the server from treating meaningless input as a real thread reference.

**Data flow**: It starts the app server with mock configuration, sends a compact request using the string "not-a-thread-id", and waits for an error response instead of a normal response. It then checks that the error code is the standard invalid-request code and that the message explains the thread ID is invalid.

**Call relations**: This is a top-level negative test. Unlike the successful compaction tests, it does not create a thread or wait for compaction notifications, because the request should fail before any compaction work begins.

*Call graph*: calls 2 internal fn (new, start_mock_server); 8 external calls (default, new, Integer, write_mock_responses_config_toml, assert!, assert_eq!, skip_if_no_network!, timeout).


##### `thread_compact_start_rejects_unknown_thread_id`  (lines 344–377)

```
async fn thread_compact_start_rejects_unknown_thread_id() -> Result<()>
```

**Purpose**: This test confirms that a well-formed but nonexistent thread ID is rejected. In plain terms, a valid-looking address is not enough; the thread must actually exist.

**Data flow**: It starts the app server with mock configuration, sends a compact request using a UUID-shaped thread ID that was never created, and waits for an error response. It then verifies that the error is an invalid-request error and that the message says the thread was not found.

**Call relations**: This top-level negative test complements the invalid-format test. Together they check both stages of validation: first, whether the ID looks valid, and second, whether it refers to a known thread.

*Call graph*: calls 2 internal fn (new, start_mock_server); 8 external calls (default, new, Integer, write_mock_responses_config_toml, assert!, assert_eq!, skip_if_no_network!, timeout).


##### `start_thread`  (lines 379–393)

```
async fn start_thread(mcp: &mut TestAppServer) -> Result<String>
```

**Purpose**: This helper starts a new conversation thread in the test app server and returns its server-assigned thread ID. Tests use it so they can work with a real thread instead of hard-coding one.

**Data flow**: It receives a mutable test server connection. It sends a thread-start request with the mock model name, waits for the matching JSON-RPC response, converts that response into a thread-start result, and returns the new thread’s ID string.

**Call relations**: The successful compaction tests call this helper during setup. It hides the repeated request-and-response steps so those tests can focus on the compaction behavior that happens after a thread exists.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_start_request); called by 3 (auto_compaction_local_emits_started_and_completed_items, auto_compaction_remote_emits_started_and_completed_items, thread_compact_start_triggers_compaction_and_returns_empty_response); 3 external calls (default, Integer, timeout).


##### `send_turn_and_wait`  (lines 395–419)

```
async fn send_turn_and_wait(
    mcp: &mut TestAppServer,
    thread_id: &str,
    text: &str,
) -> Result<String>
```

**Purpose**: This helper sends one user message into an existing thread and waits until the server says that turn has completed. It makes each test turn behave like a finished chat exchange before the next step begins.

**Data flow**: It receives the test server connection, a thread ID, and the user’s text. It sends a turn-start request containing that text, waits for the response that gives the new turn ID, then calls wait_for_turn_completed until the completion notification for that same turn arrives. It returns the completed turn’s ID.

**Call relations**: The automatic compaction tests call this helper repeatedly to build up conversation history and token usage. It hands off to wait_for_turn_completed because starting a turn and seeing it finish are separate events in the server stream.

*Call graph*: calls 3 internal fn (read_stream_until_response_message, send_turn_start_request, wait_for_turn_completed); called by 2 (auto_compaction_local_emits_started_and_completed_items, auto_compaction_remote_emits_started_and_completed_items); 4 external calls (default, Integer, timeout, vec!).


##### `wait_for_turn_completed`  (lines 421–434)

```
async fn wait_for_turn_completed(mcp: &mut TestAppServer, turn_id: &str) -> Result<()>
```

**Purpose**: This helper listens to the app server’s notification stream until a specific turn is reported complete. It filters out unrelated completion messages so the caller knows the exact turn it cares about has finished.

**Data flow**: It receives the test server connection and the expected turn ID. It repeatedly waits for a "turn/completed" notification, decodes the JSON parameters into a typed notification object, and compares the completed turn’s ID with the requested one. It returns successfully once the matching notification is found.

**Call relations**: send_turn_and_wait calls this after receiving a turn-start response. This helper is the synchronization point that keeps the tests from racing ahead while the app server is still processing a message.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 1 (send_turn_and_wait); 2 external calls (from_value, timeout).


##### `wait_for_context_compaction_started`  (lines 436–451)

```
async fn wait_for_context_compaction_started(
    mcp: &mut TestAppServer,
) -> Result<ItemStartedNotification>
```

**Purpose**: This helper waits until the server announces that a context-compaction item has started. It ignores other started items and returns only the notification that represents compaction.

**Data flow**: It receives the test server connection. It repeatedly reads "item/started" notifications, decodes each notification’s JSON parameters, and checks whether the item is a context-compaction item. When it finds one, it returns the full started notification so the test can inspect its thread ID and item ID.

**Call relations**: The successful automatic and manual compaction tests call this after driving the conditions that should start compaction. It provides the first half of the proof that clients are being told about the compaction lifecycle.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 3 (auto_compaction_local_emits_started_and_completed_items, auto_compaction_remote_emits_started_and_completed_items, thread_compact_start_triggers_compaction_and_returns_empty_response); 2 external calls (from_value, timeout).


##### `wait_for_context_compaction_completed`  (lines 453–468)

```
async fn wait_for_context_compaction_completed(
    mcp: &mut TestAppServer,
) -> Result<ItemCompletedNotification>
```

**Purpose**: This helper waits until the server announces that a context-compaction item has completed. It lets tests confirm that compaction did not only start, but also reached its finish event.

**Data flow**: It receives the test server connection. It repeatedly reads "item/completed" notifications, decodes their JSON parameters, and checks whether each completed item is a context-compaction item. Once it finds that item type, it returns the full completed notification for assertions.

**Call relations**: The successful compaction tests call this after waiting for the started notification. Together with wait_for_context_compaction_started, it verifies the full start-to-finish notification sequence that clients depend on.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 3 (auto_compaction_local_emits_started_and_completed_items, auto_compaction_remote_emits_started_and_completed_items, thread_compact_start_triggers_compaction_and_returns_empty_response); 2 external calls (from_value, timeout).


##### `parse_json_header`  (lines 470–472)

```
fn parse_json_header(value: &str) -> serde_json::Value
```

**Purpose**: This small helper turns a request header string into JSON so tests can inspect metadata fields inside it. It is used when checking that remote compaction requests are labeled correctly.

**Data flow**: It receives a string taken from an HTTP header. It parses that string as JSON and returns the resulting JSON value; if the string is not valid JSON, the test fails immediately with a clear message.

**Call relations**: The remote compaction test uses this while inspecting the mock server’s recorded requests. It bridges the gap between raw HTTP header text and structured assertions about fields like request kind, turn ID, window ID, and compaction reason.

*Call graph*: 1 external calls (from_str).


### `app-server/tests/suite/v2/external_agent_config.rs`

`test` · `test suite`

These tests act like a careful user trying to move from another coding assistant setup into this app. They create temporary home folders, write fake external-agent files such as Claude settings or session logs, start a test app server, and then talk to it through JSON-RPC, which is a request-and-response message format using JSON.

The file checks several important promises. A config-only import should answer with an import id, send progress, send a completed notification, and save the result in the state database. Bad existing config should become a clear server error. Plugin imports should work for local marketplaces, and even pending plugin work should still finish with a completion notification. Session imports should turn old JSONL chat logs into normal app threads, preserve useful information like title and preview, and allow the user to resume the imported thread and continue chatting.

Some tests focus on edge cases that would be easy to break: importing the same session twice should not create duplicates; importing sessions should not start unrelated required MCP servers; long imports should return quickly while background work continues; and very large imported sessions should be summarized before the first follow-up message. Overall, this file protects the migration experience from silent data loss, duplicate data, hanging requests, and confusing missing notifications.

#### Function details

##### `assert_import_response`  (lines 38–41)

```
fn assert_import_response(response: ExternalAgentConfigImportResponse) -> String
```

**Purpose**: This small helper checks that an import response contains a non-empty import id. The tests use that id later to match the server’s completion notifications and saved history records to the original request.

**Data flow**: It receives an ExternalAgentConfigImportResponse from the server. It asserts that the import_id field is not blank, then returns that import id as a String for the rest of the test to compare against later messages.

**Call relations**: Several import tests call this immediately after converting a raw JSON-RPC response into a typed import response. It gives those tests a trusted import id before they wait for progress or completion notifications.

*Call graph*: called by 8 (external_agent_config_import_accepts_detected_session_payload_after_restart, external_agent_config_import_compacts_huge_session_before_first_follow_up, external_agent_config_import_creates_session_rollouts, external_agent_config_import_returns_before_background_session_import_finishes, external_agent_config_import_sends_completion_notification_after_pending_plugins_finish, external_agent_config_import_sends_completion_notification_for_local_plugins, external_agent_config_import_sends_completion_notification_for_sync_only_import, external_agent_config_import_skips_already_imported_session_versions); 1 external calls (assert!).


##### `external_agent_config_import_sends_completion_notification_for_sync_only_import`  (lines 44–158)

```
async fn external_agent_config_import_sends_completion_notification_for_sync_only_import() -> Result<()>
```

**Purpose**: This test proves that a simple, synchronous config import gives the client a response, sends progress, sends a final completion notification, and records the import history. Without this, users could start an import and never know whether it finished or what changed.

**Data flow**: The test creates temporary Codex and SQLite homes, starts a test server with those paths, and sends an externalAgentConfig/import request for a CONFIG item. It reads the response, extracts the import id, then reads progress and completion notifications. Afterward it opens the state database and asks for the saved import details, then compares the saved successes and failures with what the completion notification reported. Finally, it calls the readHistories endpoint and checks that the same result appears in user-visible history.

**Call relations**: The Tokio test runner starts this test. Inside the flow, TestAppServer is used as the fake client connection to the app server, assert_import_response validates the import id, and StateRuntime is used afterward to verify that the server persisted the same outcome it announced to the client.

*Call graph*: calls 3 internal fn (new_with_env, assert_import_response, init); 8 external calls (new, Integer, to_response, assert!, assert_eq!, from_value, json!, timeout).


##### `external_agent_config_import_returns_error_for_failed_sync_import`  (lines 161–200)

```
async fn external_agent_config_import_returns_error_for_failed_sync_import() -> Result<()>
```

**Purpose**: This test checks that a config import fails loudly and clearly when the existing app config file is invalid. That matters because silently continuing could overwrite or hide a user’s broken configuration.

**Data flow**: The test builds a temporary home folder with a fake external settings file and an intentionally malformed config.toml. It starts the server, sends a CONFIG import request, and waits for an error message instead of a normal response. It then checks that the JSON-RPC error code is the expected internal-error code and that the message explains the invalid config.toml problem.

**Call relations**: The test runner invokes this as an asynchronous server test. It talks to the server through TestAppServer and expects the import path to return a JSONRPCError rather than passing through assert_import_response, because this scenario is meant to fail.

*Call graph*: calls 1 internal fn (new_with_env); 8 external calls (new, Integer, assert!, assert_eq!, json!, create_dir_all, write, timeout).


##### `external_agent_config_import_sends_completion_notification_for_local_plugins`  (lines 203–315)

```
async fn external_agent_config_import_sends_completion_notification_for_local_plugins() -> Result<()>
```

**Purpose**: This test proves that plugin migration can import a plugin from a local marketplace and mark it installed and enabled. It protects the path where a user has already configured external plugins on disk and wants them available in the new app.

**Data flow**: The test creates a fake marketplace folder, a sample plugin manifest, and external-agent settings that enable that plugin. It starts the app server and sends an import request for the PLUGINS item. After receiving the import response and completion notification, it asks the server for the plugin list. It then searches the returned marketplaces for the sample plugin and checks that it is both installed and enabled.

**Call relations**: The test runner starts this case. The test uses TestAppServer to send the import request and later a plugin list request. It calls assert_import_response to capture the import id, then checks the completion notification before handing off to the plugin-list endpoint to confirm the imported state is visible.

*Call graph*: calls 2 internal fn (new_with_env, assert_import_response); 11 external calls (new, Integer, to_response, assert!, assert_eq!, from_value, json!, to_string_pretty, create_dir_all, write (+1 more)).


##### `external_agent_config_import_sends_completion_notification_after_pending_plugins_finish`  (lines 318–381)

```
async fn external_agent_config_import_sends_completion_notification_after_pending_plugins_finish() -> Result<()>
```

**Purpose**: This test checks that plugin imports still produce a completion notification when some plugin work is pending or cannot complete normally. The user-facing promise is that every import request eventually gets a final status message.

**Data flow**: The test writes external-agent settings for a non-local plugin marketplace with an invalid source, so the background plugin path cannot perform a real clone. It starts the server, sends a PLUGINS import request, reads the immediate import response, and waits for the completed notification. It verifies that the completed notification carries the same import id as the original response.

**Call relations**: The test runner invokes this async test. TestAppServer drives the request and notification stream, and assert_import_response supplies the import id used to match the later completion message to the earlier request.

*Call graph*: calls 2 internal fn (new_with_env, assert_import_response); 9 external calls (new, Integer, to_response, assert_eq!, from_value, json!, create_dir_all, write, timeout).


##### `external_agent_config_import_creates_session_rollouts`  (lines 384–598)

```
async fn external_agent_config_import_creates_session_rollouts() -> Result<()>
```

**Purpose**: This test proves that imported external chat sessions become real app threads that can be read, resumed, and continued. It checks the full user story: old conversation in, usable new conversation out.

**Data flow**: The test starts a mock model server that will answer follow-up requests, creates a test config, and writes an external session JSONL file containing a user message, an assistant message, and a custom title. It asks the server to detect importable external config, imports the detected item, and checks the completion result. Then it lists threads, verifies the imported thread id, preview, and title, reads the thread contents, and checks that the import marker appears. Finally it resumes the thread, sends a follow-up user message, waits for turn completion, reads the thread again, and confirms that the mock assistant answer was added.

**Call relations**: This is one of the broadest end-to-end tests in the file. It uses create_config_toml to point the app at a mock model server, uses assert_import_response to track the import, then moves through detect, import, thread list, thread read, thread resume, and turn start calls to prove the imported data works with the normal conversation flow.

*Call graph*: calls 3 internal fn (new_with_env, assert_import_response, create_config_toml); 15 external calls (default, new, Integer, create_mock_responses_server_repeating_assistant, to_response, assert_eq!, now, panic!, from_value, json! (+5 more)).


##### `external_agent_config_import_does_not_initialize_required_mcp`  (lines 601–691)

```
async fn external_agent_config_import_does_not_initialize_required_mcp() -> Result<()>
```

**Purpose**: This test checks that importing old sessions does not try to start required MCP servers. MCP here means Model Context Protocol, a way for the app to connect to external tools; the important point is that a broken required tool should not block a passive session import.

**Data flow**: The test creates a normal mock model config, then appends a required MCP server whose command does not exist. It writes a simple external session file and starts the app server. It sends a SESSIONS import request directly, waits for the response and completion notification, then lists threads and confirms that one imported thread exists. If the import had tried to initialize the broken required MCP server, this flow would fail.

**Call relations**: The test runner calls this test. It uses create_config_toml for the base server setup, then deliberately modifies that config before using TestAppServer to exercise the import and thread-list endpoints.

*Call graph*: calls 2 internal fn (new_with_env, create_config_toml); 11 external calls (new, Integer, create_mock_responses_server_repeating_assistant, to_response, assert_eq!, now, json!, create_dir_all, read_to_string, write (+1 more)).


##### `external_agent_config_import_accepts_detected_session_payload_after_restart`  (lines 694–782)

```
async fn external_agent_config_import_accepts_detected_session_payload_after_restart() -> Result<()>
```

**Purpose**: This test verifies that the session import endpoint accepts a session payload shaped like one returned by detection, even in a multi-threaded server run. It protects compatibility between the detect step and the later import step, including cases that resemble a client restarting between them.

**Data flow**: The test creates a mock model server, writes app config, creates a project folder, and writes one external session log. It starts the server and sends a SESSIONS import request with session details containing the path, working directory, and title. It reads the import response, checks the completion notification, then lists threads and confirms that exactly one thread was created.

**Call relations**: The multi-threaded Tokio test runner starts this case. The test relies on create_config_toml for setup and assert_import_response for matching the import response to the completion notification, then uses the thread-list request to verify the imported session landed in normal app storage.

*Call graph*: calls 3 internal fn (new_with_env, assert_import_response, create_config_toml); 11 external calls (new, Integer, create_mock_responses_server_repeating_assistant, to_response, assert_eq!, now, from_value, json!, create_dir_all, write (+1 more)).


##### `external_agent_config_import_skips_already_imported_session_versions`  (lines 785–874)

```
async fn external_agent_config_import_skips_already_imported_session_versions() -> Result<()>
```

**Purpose**: This test makes sure importing the same detected session twice does not create two separate threads. That prevents duplicate conversations from appearing if a user retries an import or repeats a migration.

**Data flow**: The test writes one external session file, asks the server to detect importable items, and saves the detected item list. It then sends the same import request twice. Each time it reads the response, checks the import id, and waits for a completion notification. After both imports, it lists threads and asserts that only one thread exists.

**Call relations**: The test runner invokes this async case. It uses create_config_toml to prepare a working mock model setup, assert_import_response during both import attempts, and the thread-list endpoint at the end to prove the duplicate import was skipped rather than duplicated.

*Call graph*: calls 3 internal fn (new_with_env, assert_import_response, create_config_toml); 11 external calls (new, Integer, create_mock_responses_server_repeating_assistant, to_response, assert_eq!, now, from_value, json!, create_dir_all, write (+1 more)).


##### `external_agent_config_import_returns_before_background_session_import_finishes`  (lines 878–1013)

```
async fn external_agent_config_import_returns_before_background_session_import_finishes() -> Result<()>
```

**Purpose**: This Unix-only test proves that the import request can return before a slow session import finishes in the background. This matters because the client should not hang on the initial request while large or blocked session files are being processed.

**Data flow**: The test creates and detects a normal external session, then replaces the session file with a Unix FIFO, which is like a pipe that blocks until someone writes to it. It sends an import request and checks that the server quickly returns an import id, but does not yet send completion. It then sends a duplicate import request while the first background job is still blocked. The test writes the original session contents into the FIFO twice, allowing both background imports to finish, collects both completion notifications, and verifies their import ids. Finally it lists threads and confirms only one thread was created.

**Call relations**: The multi-threaded Tokio runner invokes this test on Unix systems. It uses create_config_toml for setup and assert_import_response for both import attempts. The test’s blocking FIFO is the key tool for proving the server separates the quick request response from the slower background completion path.

*Call graph*: calls 3 internal fn (new_with_env, assert_import_response, create_config_toml); 18 external calls (from_secs, new, new, Integer, create_mock_responses_server_repeating_assistant, to_response, assert!, assert_eq!, now, new (+8 more)).


##### `external_agent_config_import_compacts_huge_session_before_first_follow_up`  (lines 1016–1189)

```
async fn external_agent_config_import_compacts_huge_session_before_first_follow_up() -> Result<()>
```

**Purpose**: This test checks that a very large imported session is summarized before the first follow-up message is sent to the model. In plain terms, it makes sure the app trims an oversized old conversation into a compact memory before continuing, instead of sending too much text at once.

**Data flow**: The test starts a mock responses server with two planned streamed replies: first a summary response, then a follow-up answer. It writes config with a small auto-compact limit and a summary prompt. It creates an external session containing very large user and assistant messages, detects and imports it, then resumes the imported thread and sends a follow-up message. After completion, it inspects the mock server’s received requests. The first request must contain the summary prompt and not the follow-up text, while the second must contain both the follow-up text and the generated local summary.

**Call relations**: The multi-threaded test runner calls this test. It uses response-test helpers to control and inspect mock model traffic, assert_import_response to track the import, and the normal thread resume and turn start endpoints to trigger the compact-then-follow-up behavior.

*Call graph*: calls 4 internal fn (new_with_env, assert_import_response, mount_sse_sequence, start_mock_server); 15 external calls (default, default, new, Integer, to_response, write_mock_responses_config_toml, assert!, assert_eq!, now, from_value (+5 more)).


##### `create_config_toml`  (lines 1191–1211)

```
fn create_config_toml(codex_home: &std::path::Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes a minimal app config file for tests that need the server to call a mock model provider. It keeps repeated setup out of the individual session-import tests.

**Data flow**: It receives the temporary Codex home path and the mock server URI. It formats a config.toml file that selects a mock model, disables approvals, uses read-only sandboxing, and points the mock provider at the server URI. It writes that file into the temporary home and returns the file-write result.

**Call relations**: Several session-import tests call this during setup before starting TestAppServer. Those tests then rely on the generated config when they resume imported threads or trigger model calls after import.

*Call graph*: called by 5 (external_agent_config_import_accepts_detected_session_payload_after_restart, external_agent_config_import_creates_session_rollouts, external_agent_config_import_does_not_initialize_required_mcp, external_agent_config_import_returns_before_background_session_import_finishes, external_agent_config_import_skips_already_imported_session_versions); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/review.rs`

`test` · `test run`

These are end-to-end style tests for code review requests in the v2 app server protocol. The tests spin up a fake model server, write a temporary configuration file that points the app server at that fake server, then talk to the app server through JSON-RPC, which is a simple request-and-response message format using JSON.

The main question this file answers is: “If a client asks the server to review something, does the server report the right visible behavior?” It checks the happy path, where a commit review becomes a review turn and produces review text. It also checks guardrails, such as rejecting a blank branch name, blank commit SHA, or blank custom instructions. One test checks detached delivery, where the review runs in a separate thread instead of being attached to the original conversation. Another ignored flaky test checks that a shell-command approval request points at the same item that later appears as the command execution item.

The helper functions keep the tests readable. They start a default thread, force a thread to have some existing rollout state when needed, and create the small config file the test server needs. Without these tests, changes to review behavior could silently break client expectations: for example, a user might not see the review mode markers, a detached review might appear on the wrong thread, or bad empty input might be accepted.

#### Function details

##### `review_start_runs_review_turn_and_emits_code_review_item`  (lines 38–153)

```
async fn review_start_runs_review_turn_and_emits_code_review_item() -> Result<()>
```

**Purpose**: This test proves that starting an inline commit review creates a review turn and eventually emits a visible code review item. It checks both the first response to the request and the later streamed notifications a client would see.

**Data flow**: It starts with a fake model response containing one review finding. The test writes config pointing the app server to that fake model, initializes the test app server, starts a thread, and sends a review-start request for a commit. It then reads the JSON-RPC response and notification stream, confirming that the turn begins with the expected user message, that the server announces entry into review mode, and that the completed review text includes the finding title and file location. The result is no returned value beyond success; failure happens through assertions or errors.

**Call relations**: This is one of the top-level async tests. It relies on create_config_toml to prepare the temporary server setup and start_default_thread to create the conversation that the review attaches to. It then drives the app server directly through the TestAppServer helpers and inspects the response and item notifications.

*Call graph*: calls 3 internal fn (new, create_config_toml, start_default_thread); 8 external calls (new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, json!, from_value, timeout).


##### `review_start_exec_approval_item_id_matches_command_execution_item`  (lines 157–251)

```
async fn review_start_exec_approval_item_id_matches_command_execution_item() -> Result<()>
```

**Purpose**: This ignored test checks a subtle approval-flow rule: when a review asks to run a shell command, the approval request should name the same item ID that later appears as the command execution item. That matters because clients need to connect the “please approve this command” prompt to the actual command shown in the UI.

**Data flow**: It feeds the fake model server a sequence: first a shell-command request, then a final assistant message. It configures the app server with an approval policy that requires approval, starts a thread, and starts a review. The test reads the server's approval request, checks the approval item ID and turn ID, waits until a command execution item appears in the notification stream, and verifies the IDs match. It then sends an approved decision back and waits for the turn to finish.

**Call relations**: As a top-level test, it sets up its own fake response sequence and uses create_config_toml_with_approval_policy instead of the default config helper because it needs approvals turned on. It also uses start_default_thread before exercising the review-start path. The test is marked ignored because it is known to be flaky.

*Call graph*: calls 3 internal fn (new, create_config_toml_with_approval_policy, start_default_thread); 9 external calls (new, Integer, create_mock_responses_server_sequence, assert_eq!, panic!, from_value, json!, timeout, vec!).


##### `review_start_rejects_empty_base_branch`  (lines 254–285)

```
async fn review_start_rejects_empty_base_branch() -> Result<()>
```

**Purpose**: This test confirms that the server refuses a base-branch review when the branch name is only whitespace. It protects clients and later review logic from receiving a meaningless target.

**Data flow**: It starts a fake model server, writes normal config, initializes the app server, and starts a thread. Then it sends a review-start request whose base branch is spaces. Instead of a normal review response, it reads an error response and checks that the error code means “invalid request” and that the message explains the branch must not be empty.

**Call relations**: This is a top-level validation test. It uses create_config_toml and start_default_thread for the standard setup, then focuses only on the bad review target and the JSON-RPC error returned by the server.

*Call graph*: calls 3 internal fn (new, create_config_toml, start_default_thread); 6 external calls (new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout).


##### `review_start_with_detached_delivery_returns_new_thread_id`  (lines 289–372)

```
async fn review_start_with_detached_delivery_returns_new_thread_id() -> Result<()>
```

**Purpose**: This test checks the detached review mode, where the review should run in a new thread rather than in the original conversation. It verifies that the response gives a different review thread ID and that the server introduces that new thread in the expected way.

**Data flow**: It prepares a fake review response with no findings, starts the app server, creates a normal thread, and runs a small ordinary turn to make sure the original thread has materialized state. It then sends a custom review request with detached delivery. The response is checked for an in-progress turn with the expected user message, and the returned review thread ID must differ from the original thread ID. The test then reads streamed messages until it sees the new thread started notification, while failing if the detached review thread first appears as a status-change notification.

**Call relations**: This top-level test uses create_config_toml for setup, start_default_thread to make the original thread, and materialize_thread_rollout to give that thread real history before starting the detached review. It then watches the raw message stream because the ordering and type of thread notifications are part of what it is testing.

*Call graph*: calls 4 internal fn (new, create_config_toml, materialize_thread_rollout, start_default_thread); 10 external calls (new, bail!, Integer, create_mock_responses_server_repeating_assistant, assert_eq!, assert_ne!, json!, from_value, now, timeout).


##### `review_start_rejects_empty_commit_sha`  (lines 375–407)

```
async fn review_start_rejects_empty_commit_sha() -> Result<()>
```

**Purpose**: This test confirms that a commit review cannot be started with an empty commit SHA, where SHA means the commit identifier used by Git. It makes sure the server rejects a request that has no real commit to review.

**Data flow**: It creates the standard fake model and app server setup, starts a thread, and sends a commit review request whose SHA is just a tab character. The test waits for an error response, checks that the code is the standard invalid-request code, and checks that the message says the SHA must not be empty.

**Call relations**: This validation test follows the same setup pattern as the other rejection tests: create_config_toml prepares the temporary config, start_default_thread creates the target thread, and the test then sends one deliberately invalid review-start request.

*Call graph*: calls 3 internal fn (new, create_config_toml, start_default_thread); 6 external calls (new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout).


##### `review_start_rejects_empty_custom_instructions`  (lines 410–444)

```
async fn review_start_rejects_empty_custom_instructions() -> Result<()>
```

**Purpose**: This test confirms that a custom review request must contain real instructions. It prevents a client from starting a vague review with only blank lines as the target.

**Data flow**: It starts the fake model and app server, creates a thread, and sends a review-start request with custom instructions made only of newline characters. The server should answer with an error, and the test checks both the invalid-request code and the message saying instructions must not be empty.

**Call relations**: This is another top-level input-validation test. It shares the common setup helpers create_config_toml and start_default_thread, then exercises the custom-instructions branch of review validation.

*Call graph*: calls 3 internal fn (new, create_config_toml, start_default_thread); 6 external calls (new, Integer, create_mock_responses_server_repeating_assistant, assert!, assert_eq!, timeout).


##### `start_default_thread`  (lines 446–465)

```
async fn start_default_thread(mcp: &mut TestAppServer) -> Result<String>
```

**Purpose**: This helper starts a basic conversation thread for tests that need an existing thread before they can start a review. It hides the repeated request, response, and notification waiting code.

**Data flow**: It receives a mutable TestAppServer connection. It sends a thread-start request with the mock model name, waits for the matching response, converts that response into a typed thread-start result, then waits for the separate “thread started” notification. It returns the new thread's ID as a string.

**Call relations**: Most tests in this file call this helper after initializing the app server and before sending a review-start request. It hands back the thread ID that becomes the target of the review request.

*Call graph*: calls 3 internal fn (read_stream_until_notification_message, read_stream_until_response_message, send_thread_start_request); called by 6 (review_start_exec_approval_item_id_matches_command_execution_item, review_start_rejects_empty_base_branch, review_start_rejects_empty_commit_sha, review_start_rejects_empty_custom_instructions, review_start_runs_review_turn_and_emits_code_review_item, review_start_with_detached_delivery_returns_new_thread_id); 3 external calls (default, Integer, timeout).


##### `materialize_thread_rollout`  (lines 467–490)

```
async fn materialize_thread_rollout(mcp: &mut TestAppServer, thread_id: &str) -> Result<()>
```

**Purpose**: This helper runs a small ordinary turn on an existing thread so that the thread has real completed activity before a detached review is started. It is used when a test needs the original thread to be fully established, not just created.

**Data flow**: It receives the test app server connection and a thread ID. It sends a turn-start request containing the text “materialize rollout,” waits for the response to that request, then waits until the turn-completed notification arrives. It returns success after the turn has finished.

**Call relations**: The detached-review test calls this after start_default_thread and before sending the detached review request. It uses the same app-server message helpers as the tests, but packages the setup step into one reusable action.

*Call graph*: calls 3 internal fn (read_stream_until_notification_message, read_stream_until_response_message, send_turn_start_request); called by 1 (review_start_with_detached_delivery_returns_new_thread_id); 4 external calls (default, Integer, timeout, vec!).


##### `create_config_toml`  (lines 492–494)

```
fn create_config_toml(codex_home: &std::path::Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes the default test configuration file for the app server. It uses the fake model server URL and sets command approval to “never,” meaning tests can run without approval prompts unless they explicitly choose otherwise.

**Data flow**: It receives the temporary Codex home directory and the fake server URL. Instead of writing the file itself, it passes those values plus the default approval policy to create_config_toml_with_approval_policy. The output is the file written on disk, or an I/O error if writing fails.

**Call relations**: Most tests call this during setup right after creating the temporary directory and fake model server. It is a small wrapper around create_config_toml_with_approval_policy for the common no-approval case.

*Call graph*: calls 1 internal fn (create_config_toml_with_approval_policy); called by 5 (review_start_rejects_empty_base_branch, review_start_rejects_empty_commit_sha, review_start_rejects_empty_custom_instructions, review_start_runs_review_turn_and_emits_code_review_item, review_start_with_detached_delivery_returns_new_thread_id).


##### `create_config_toml_with_approval_policy`  (lines 496–524)

```
fn create_config_toml_with_approval_policy(
    codex_home: &std::path::Path,
    server_uri: &str,
    approval_policy: &str,
) -> std::io::Result<()>
```

**Purpose**: This helper writes the actual config.toml file used by the test app server. It lets a test choose the approval policy while keeping the rest of the mock model-provider setup consistent.

**Data flow**: It receives the temporary Codex home path, the fake server URL, and an approval policy string. It builds the path to config.toml and writes a TOML configuration that selects the mock model, read-only sandboxing, the mock provider URL, and retry settings. It returns success if the file is written or an I/O error if not.

**Call relations**: create_config_toml calls this for the default setup, and the command-approval test calls it directly so it can request the “untrusted” approval behavior. The app server later reads this file when TestAppServer starts.

*Call graph*: called by 2 (create_config_toml, review_start_exec_approval_item_id_matches_command_execution_item); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/safety_check_downgrade.rs`

`test` · `test run`

These tests act like a careful client talking to the app server while a fake OpenAI-style server sends back controlled responses. The real problem being checked is user trust: if the server asks for one model but the backend silently uses another because of high-risk cyber safeguards, the client must be told. If a request is blocked by cyber policy, the client must receive a specific error type, not a generic failure. And if the backend sends moderation or verification metadata, the app server must translate it into the protocol messages the v2 client expects.

Each test builds a temporary configuration that points the app server at a mock HTTP server. It then starts a thread, starts a turn, and watches the JSON-RPC message stream. JSON-RPC is a simple request-and-response message format, with extra one-way messages called notifications. The helpers read those notifications until the turn finishes, checking both what appears and what must not appear.

A key theme is that older warning-style user messages should not leak into this v2 flow. The helpers inspect started and completed thread items to ensure no synthetic user message beginning with "Warning: " appears. In short, this file is a safety contract test: it proves that model reroutes, cyber-policy denials, model-verification data, and moderation metadata are surfaced as structured protocol events.

#### Function details

##### `openai_model_header_mismatch_emits_model_rerouted_notification_v2`  (lines 37–99)

```
async fn openai_model_header_mismatch_emits_model_rerouted_notification_v2() -> Result<()>
```

**Purpose**: This test checks the case where the client asks for one model but the backend response header says a different model was actually used. It verifies that the app server tells the client through a structured model reroute notification.

**Data flow**: It starts with a mock server response whose OpenAI-Model header names the server model instead of the requested model. The test writes a temporary config, starts the app server, opens a thread using the requested model, and sends a turn. It then reads notifications until the turn ends and expects a ModelReroutedNotification showing requested model → actual model with the high-risk cyber activity reason.

**Call relations**: This test sets up the fake backend with start_mock_server, sse_response, and mount_response_once, creates local configuration with create_config_toml, then drives the app through TestAppServer. After the turn starts, it hands stream checking to collect_turn_notifications_and_validate_no_warning_item, which confirms the reroute notification appears and old warning-style items do not.

*Call graph*: calls 7 internal fn (new, collect_turn_notifications_and_validate_no_warning_item, create_config_toml, mount_response_once, sse, sse_response, start_mock_server); 8 external calls (default, new, Integer, to_response, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `cyber_policy_response_emits_typed_error_notification_v2`  (lines 102–169)

```
async fn cyber_policy_response_emits_typed_error_notification_v2() -> Result<()>
```

**Purpose**: This test checks that a backend cyber-policy rejection becomes a specific, typed error notification for the client. It makes sure the app server does not misreport the policy block as a model reroute.

**Data flow**: It prepares a mock HTTP 400 response with an error code of cyber_policy and the expected policy message. The test starts the app server from a temporary config, creates a thread, starts a turn, and watches the stream. The expected output is an ErrorNotification whose error details include CodexErrorInfo::CyberPolicy and whose retry flag is false.

**Call relations**: The test uses create_config_toml to point the app at the mock server and mount_response_once to make the fake policy response available. Once the turn is running, it calls collect_cyber_policy_error_and_validate_no_reroute, which reads notifications until turn completion and fails if any model/rerouted notification appears.

*Call graph*: calls 5 internal fn (new, collect_cyber_policy_error_and_validate_no_reroute, create_config_toml, mount_response_once, start_mock_server); 10 external calls (default, new, new, Integer, to_response, assert_eq!, json!, skip_if_no_network!, timeout, vec!).


##### `response_model_field_mismatch_emits_model_rerouted_notification_v2_when_header_matches_requested`  (lines 172–243)

```
async fn response_model_field_mismatch_emits_model_rerouted_notification_v2_when_header_matches_requested() -> Result<()>
```

**Purpose**: This test covers a subtler mismatch: the top-level HTTP header says the requested model, but the streamed response metadata says a different model. It verifies that the app server still detects the actual model change and reports it.

**Data flow**: It builds a streamed response where the HTTP OpenAI-Model header matches the requested model, but the response.created event contains headers naming the server model. After configuration, initialization, thread creation, and turn start, the test reads the notification stream. The expected result is a ModelReroutedNotification showing the model changed from the requested model to the server model.

**Call relations**: Like the other reroute test, this function relies on the mock response builders and create_config_toml for setup. It then calls collect_turn_notifications_and_validate_no_warning_item, which waits for the reroute signal and checks that no old warning user-message item was emitted during the turn.

*Call graph*: calls 7 internal fn (new, collect_turn_notifications_and_validate_no_warning_item, create_config_toml, mount_response_once, sse, sse_response, start_mock_server); 8 external calls (default, new, Integer, to_response, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `model_verification_emits_typed_notification_and_warning_v2`  (lines 246–311)

```
async fn model_verification_emits_typed_notification_and_warning_v2() -> Result<()>
```

**Purpose**: This test checks that model-verification metadata from the backend becomes a clear model/verification notification. In this case, the metadata says the response has trusted access for cyber-related verification.

**Data flow**: It creates a streamed backend response containing a model verification metadata event, then starts the app server, opens a thread, and sends a turn. The notification collector reads the stream until the turn is complete. The expected output is a ModelVerificationNotification containing TrustedAccessForCyber for the current thread and turn.

**Call relations**: The test prepares the fake stream with response helper functions, writes the temporary config through create_config_toml, and drives the app with TestAppServer. It delegates stream validation to collect_model_verification_notifications_and_validate_no_warning_item, which also proves this verification-only case does not emit a warning or model reroute.

*Call graph*: calls 7 internal fn (new, collect_model_verification_notifications_and_validate_no_warning_item, create_config_toml, mount_response_once, sse, sse_response, start_mock_server); 8 external calls (default, new, Integer, to_response, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `turn_moderation_metadata_emits_typed_notification_v2`  (lines 314–392)

```
async fn turn_moderation_metadata_emits_typed_notification_v2() -> Result<()>
```

**Purpose**: This test checks that moderation metadata sent by the backend is forwarded to the client as a dedicated turn/moderationMetadata notification. It confirms that useful safety presentation data is not lost in the stream.

**Data flow**: It prepares a streamed response containing response.metadata with an openai_chatgpt_moderation_metadata object. The test starts the app server, creates a thread, starts a turn, and waits specifically for the turn/moderationMetadata notification. It parses that notification and expects the metadata JSON to contain presentation: inline for the same thread and turn.

**Call relations**: This test uses the same mock-server and temporary-config setup as the other tests, including create_config_toml and the response stream helpers. Unlike the tests with custom collectors, it reads the specific notification directly from TestAppServer and checks its decoded payload.

*Call graph*: calls 6 internal fn (new, create_config_toml, mount_response_once, sse, sse_response, start_mock_server); 9 external calls (default, new, Integer, to_response, assert_eq!, from_value, skip_if_no_network!, timeout, vec!).


##### `collect_turn_notifications_and_validate_no_warning_item`  (lines 394–434)

```
async fn collect_turn_notifications_and_validate_no_warning_item(
    mcp: &mut TestAppServer,
) -> Result<ModelReroutedNotification>
```

**Purpose**: This helper watches the app server's message stream during a turn and looks for a model reroute notification. At the same time, it guards against old-style warning messages being inserted as thread items.

**Data flow**: It receives a mutable TestAppServer, repeatedly reads the next JSON-RPC message with a timeout, and ignores anything that is not a notification. When it sees model/rerouted, it decodes and stores the payload. When it sees item/started or item/completed, it checks that the item is not a warning user message. When turn/completed arrives, it returns the stored reroute payload or reports an error if none was seen.

**Call relations**: The two reroute tests call this helper after starting a turn. It depends on is_warning_user_message_item to recognize unwanted warning-style thread items, and it uses JSON decoding to turn notification parameters into the strongly typed ModelReroutedNotification value the tests compare.

*Call graph*: calls 1 internal fn (read_next_message); called by 2 (openai_model_header_mismatch_emits_model_rerouted_notification_v2, response_model_field_mismatch_emits_model_rerouted_notification_v2_when_header_matches_requested); 3 external calls (assert!, from_value, timeout).


##### `collect_model_verification_notifications_and_validate_no_warning_item`  (lines 436–485)

```
async fn collect_model_verification_notifications_and_validate_no_warning_item(
    mcp: &mut TestAppServer,
) -> Result<ModelVerificationNotification>
```

**Purpose**: This helper watches a turn and extracts the model-verification notification. It also enforces that a verification-only response does not produce a warning or a model reroute.

**Data flow**: It takes a mutable TestAppServer and reads messages until the turn completes. If it sees model/verification, it decodes and stores that payload. If it sees warning or model/rerouted, it immediately fails the test. For item start and completion notifications, it checks that no warning-style user message item is present. At turn completion, it returns the verification payload or errors if it never arrived.

**Call relations**: The model verification test calls this helper after starting its turn. The helper reads from TestAppServer, uses is_warning_user_message_item for item checks, and hands the decoded ModelVerificationNotification back to the test for exact comparison.

*Call graph*: calls 1 internal fn (read_next_message); called by 1 (model_verification_emits_typed_notification_and_warning_v2); 4 external calls (bail!, assert!, from_value, timeout).


##### `collect_cyber_policy_error_and_validate_no_reroute`  (lines 487–518)

```
async fn collect_cyber_policy_error_and_validate_no_reroute(
    mcp: &mut TestAppServer,
) -> Result<ErrorNotification>
```

**Purpose**: This helper watches the stream for a cyber-policy error notification. It makes sure that a policy block is not also reported as a model reroute.

**Data flow**: It receives a mutable TestAppServer and reads notification messages until the turn finishes. When it sees an error notification, it decodes it and keeps it only if its extra error info says CyberPolicy. If it sees model/rerouted, it fails immediately. When turn/completed arrives, it returns the saved cyber-policy error or reports that the expected error was missing.

**Call relations**: The cyber-policy rejection test calls this helper after starting a turn against a mock 400 response. The helper is the stream-checking part of that test: it turns raw notification parameters into an ErrorNotification and verifies the absence of reroute behavior.

*Call graph*: calls 1 internal fn (read_next_message); called by 1 (cyber_policy_response_emits_typed_error_notification_v2); 3 external calls (bail!, from_value, timeout).


##### `warning_text_from_item`  (lines 520–529)

```
fn warning_text_from_item(item: &ThreadItem) -> Option<&str>
```

**Purpose**: This small helper looks inside a thread item to see whether it is a user message containing warning text. It is used to detect an older style of safety warning that these v2 tests say should not appear.

**Data flow**: It receives a ThreadItem. If the item is not a user message, it returns nothing. If it is a user message, it scans its content and returns the first text string that starts with "Warning: "; otherwise it returns nothing.

**Call relations**: is_warning_user_message_item calls this function to do the actual inspection. The notification collectors indirectly rely on it when they check item/started and item/completed notifications for unwanted warning messages.

*Call graph*: called by 1 (is_warning_user_message_item).


##### `is_warning_user_message_item`  (lines 531–533)

```
fn is_warning_user_message_item(item: &ThreadItem) -> bool
```

**Purpose**: This helper answers a yes-or-no question: is this thread item a warning-style user message? It keeps the test assertions easy to read.

**Data flow**: It takes a ThreadItem, passes it to warning_text_from_item, and converts the result into a boolean. If warning_text_from_item finds warning text, this returns true; otherwise it returns false.

**Call relations**: The stream collection helpers call this during item notification checks. It delegates the detailed text search to warning_text_from_item and gives the collectors a simple condition they can assert against.

*Call graph*: calls 1 internal fn (warning_text_from_item).


##### `create_config_toml`  (lines 535–560)

```
fn create_config_toml(codex_home: &std::path::Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes the temporary app configuration used by every test in this file. It points the app server at the mock backend and fixes settings so the tests are predictable.

**Data flow**: It receives a temporary Codex home directory path and the mock server URI. It creates a config.toml path under that directory and writes a TOML configuration file containing the requested model, read-only sandbox mode, no approval prompts, the mock provider base URL, and retry counts set to zero. Its output is either success or a file-writing error.

**Call relations**: All five test functions call this before starting TestAppServer. The app server then reads this file during initialization, which makes its model requests go to the test's mock server instead of a real provider.

*Call graph*: called by 5 (cyber_policy_response_emits_typed_error_notification_v2, model_verification_emits_typed_notification_and_warning_v2, openai_model_header_mismatch_emits_model_rerouted_notification_v2, response_model_field_mismatch_emits_model_rerouted_notification_v2_when_header_matches_requested, turn_moderation_metadata_emits_typed_notification_v2); 3 external calls (join, format!, write).
