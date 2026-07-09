# Persistence and local runtime services startup  `stage-6`

This stage runs during startup and prepares the app’s local storage so the rest of Codex can work safely. It is like opening a workshop before the day begins: checking the filing cabinets, updating their labels, and repairing any damaged drawers.

The main entry point is state/src/runtime.rs. It opens the local SQLite databases, which are small file-based databases, applies needed schema updates, and hands usable store objects to the rest of the program. state/src/migrations.rs defines those updates in a careful way so different Codex versions can share the same database without older versions crashing on newer changes.

Rollout data has its own path. core/src/state_db_bridge.rs gives core code a simple place to start and refer to the rollout state database. rollout/src/state_db.rs connects older session files on disk with the faster SQLite index, waits for copying to finish, and offers helpers to read or fix thread metadata.

If storage is broken, recovery code steps in. cli/src/state_db_recovery.rs explains startup failures to the user or moves bad state aside. state/src/runtime/recovery.rs backs up only damaged database files so fresh ones can be created.

## Files in this stage

### Core startup bridge
These files provide the top-level entry points that connect higher layers into rollout-backed local state startup.

### `core/src/state_db_bridge.rs`

`orchestration` · `startup`

This file exists to keep the core crate from reaching directly into the rollout crate everywhere it needs the state database. A state database is a place where the system can store and read persistent state, rather than keeping everything only in memory. Without this bridge, callers would need to know the exact external module path and setup function, which would spread that dependency through the codebase.

The file does two simple things. First, it re-exports `StateDbHandle`, which means other code can import the database handle from this local bridge instead of from `codex_rollout` directly. A handle is like a key or remote control for talking to an already-created database connection. Second, it defines `init_state_db`, an asynchronous startup helper. “Asynchronous” means it may wait for work such as opening storage or connecting to a service without blocking the whole program.

When given the main `Config`, `init_state_db` passes that configuration to the rollout state database initializer and returns whatever it produces. The result is optional: if state database support is not configured or cannot be created in the expected way, the caller may receive no handle.

#### Function details

##### `init_state_db`  (lines 6–8)

```
async fn init_state_db(config: &Config) -> Option<StateDbHandle>
```

**Purpose**: Starts the rollout state database using the application configuration. Callers use it during setup when they want an optional `StateDbHandle` they can pass around to code that needs persistent state.

**Data flow**: It receives a `Config`, reads no other local data, and forwards that configuration to the rollout crate’s state database initializer. After waiting for that initializer to finish, it returns the resulting `Option<StateDbHandle>`: either a usable database handle or nothing.

**Call relations**: This function is the local doorway into the external rollout state database setup. When startup code calls it, it immediately hands the work off to `codex_rollout::state_db::init`, then passes that result back to the caller without adding extra rules of its own.

*Call graph*: 1 external calls (init).


### `rollout/src/state_db.rs`

`io_transport` · `startup and thread lookup/update paths`

Rollout files are the original record of a conversation thread, but scanning many files is slow. This file lets the program use a SQLite database instead, while still treating the rollout files as the source of truth when the database is missing, stale, or not ready. Think of it like a library card catalog: the books are still on the shelves, but the catalog makes them much faster to find.

At startup, the file initializes the SQLite-backed runtime and runs a “backfill,” which means reading existing rollout files and filling the database with their metadata. It waits until that work is complete before returning the database handle, so callers do not unknowingly read half-built state. If startup logging is not ready yet, warnings are also printed directly to standard error so the user can still see what went wrong.

After startup, the file provides small adapter functions for common thread operations: listing threads, finding a rollout path by thread id, updating timestamps, marking memory state, and applying new rollout items to the database. It also contains repair paths. If SQLite points to a missing rollout file, or a file-based fallback succeeds, these helpers can update or rebuild the database row so future reads are correct.

#### Function details

##### `init`  (lines 43–58)

```
async fn init(config: &impl RolloutConfigView) -> Option<StateDbHandle>
```

**Purpose**: Starts the local SQLite state system for normal application use. It is forgiving: if setup fails, it warns and returns no database handle instead of crashing the caller.

**Data flow**: It receives a configuration view, turns it into a concrete rollout configuration, and passes the important paths and default model provider into the lower-level initializer. If initialization succeeds, the caller gets a shared database runtime; if it fails, the error is turned into a startup warning and the caller gets `None`.

**Call relations**: This is the friendly entry point for callers that want best-effort state persistence. It delegates the real work to `try_init_with_roots`, and uses `emit_startup_warning` when that work fails. The test `state_db_init_backfills_before_returning` calls it to verify that startup waits for backfill.

*Call graph*: calls 3 internal fn (from_view, emit_startup_warning, try_init_with_roots); called by 1 (state_db_init_backfills_before_returning); 1 external calls (format!).


##### `try_init`  (lines 64–72)

```
async fn try_init(config: &impl RolloutConfigView) -> anyhow::Result<StateDbHandle>
```

**Purpose**: Starts the SQLite state system but preserves the exact error if something goes wrong. Callers use this when they want to report or handle initialization failure themselves.

**Data flow**: It receives a configuration view, extracts the database home, Codex home, and default model provider, then asks the shared initializer to open and prepare the database. On success it returns the database runtime; on failure it returns the original error with context.

**Call relations**: This is the stricter sibling of `init`. It calls `try_init_with_roots` just like `init` does, but does not swallow errors. It is used by startup flows such as `start_test_client_with_capacity` and `init_state_db_for_app_server_target`.

*Call graph*: calls 2 internal fn (from_view, try_init_with_roots); called by 2 (start_test_client_with_capacity, init_state_db_for_app_server_target).


##### `try_init_with_roots`  (lines 74–86)

```
async fn try_init_with_roots(
    codex_home: PathBuf,
    sqlite_home: PathBuf,
    default_model_provider_id: String,
) -> anyhow::Result<StateDbHandle>
```

**Purpose**: Initializes the database when the caller already has the needed filesystem roots and default provider string. It exists so both public startup functions can share the same core path.

**Data flow**: It takes the Codex home path, SQLite home path, and default model provider, then forwards them to the inner initializer without a special test lease setting. The result is either a ready database runtime or an error.

**Call relations**: `init` and `try_init` both call this after unpacking configuration. It immediately hands off to `try_init_with_roots_inner`, which does the actual database open and backfill wait.

*Call graph*: calls 1 internal fn (try_init_with_roots_inner); called by 2 (init, try_init).


##### `try_init_with_roots_and_backfill_lease`  (lines 89–102)

```
async fn try_init_with_roots_and_backfill_lease(
    codex_home: PathBuf,
    sqlite_home: PathBuf,
    default_model_provider_id: String,
    backfill_lease_seconds: i64,
) -> anyhow::Result<StateDbH
```

**Purpose**: Provides a test-only way to initialize the database with a custom backfill lease time. A lease is a temporary claim that lets one worker perform backfill work without others racing it.

**Data flow**: It receives the same paths and provider as the normal initializer, plus a lease duration in seconds. It forwards all of that to the inner initializer, which uses the lease setting while waiting for backfill.

**Call relations**: This is compiled only for tests. It calls `try_init_with_roots_inner` with a lease override so tests can exercise timing and coordination behavior without waiting for production-length intervals.

*Call graph*: calls 1 internal fn (try_init_with_roots_inner).


##### `try_init_with_roots_inner`  (lines 104–137)

```
async fn try_init_with_roots_inner(
    codex_home: PathBuf,
    sqlite_home: PathBuf,
    default_model_provider_id: String,
    backfill_lease_seconds: Option<i64>,
) -> anyhow::Result<StateDbHandle
```

**Purpose**: Does the real startup sequence: open the SQLite runtime, wait for backfill to complete, record timing, and close the runtime if startup cannot finish safely.

**Data flow**: It receives filesystem paths, a default model provider, and an optional lease setting. It opens the SQLite runtime, measures how long the backfill gate takes, waits for that gate, records the result for telemetry, and returns the runtime only if the database is ready.

**Call relations**: `try_init_with_roots` and the test-only lease initializer both funnel into this function. It calls `wait_for_backfill_gate` to make sure old rollout metadata has been imported before anyone starts using SQLite.

*Call graph*: calls 2 internal fn (wait_for_backfill_gate, init); called by 2 (try_init_with_roots, try_init_with_roots_and_backfill_lease); 4 external calls (now, as_path, clone, record_backfill_gate).


##### `wait_for_backfill_gate`  (lines 139–201)

```
async fn wait_for_backfill_gate(
    runtime: &codex_state::StateRuntime,
    codex_home: &Path,
    default_model_provider_id: &str,
    backfill_lease_seconds: Option<i64>,
) -> anyhow::Result<()>
```

**Purpose**: Waits until the database says its startup backfill is complete. This prevents callers from reading a partially populated database.

**Data flow**: It repeatedly reads the database backfill state. If backfill is incomplete, it runs the appropriate backfill routine, checks again, and either returns success, sleeps before retrying, or returns a timeout error if the wait takes too long.

**Call relations**: `try_init_with_roots_inner` calls this during startup. It uses `metadata::backfill_sessions` or `metadata::backfill_sessions_with_lease` to do the import work, and uses `emit_startup_warning` for the first visible wait message so early startup problems are not hidden.

*Call graph*: calls 3 internal fn (backfill_sessions, backfill_sessions_with_lease, emit_startup_warning); called by 1 (try_init_with_roots_inner); 6 external calls (now, anyhow!, format!, info!, get_backfill_state, sleep).


##### `emit_startup_warning`  (lines 203–211)

```
fn emit_startup_warning(message: &str)
```

**Purpose**: Reports a startup warning in a way that works before the normal logging system is ready. This helps users see database startup problems instead of losing them silently.

**Data flow**: It receives a message, sends it to tracing as a warning, and, if no tracing dispatcher has been installed yet, also prints the same message to standard error. It returns nothing.

**Call relations**: `init` uses this when database setup fails, and `wait_for_backfill_gate` uses it when startup has to wait for backfill. It is the small safety valve for early messages.

*Call graph*: called by 2 (init, wait_for_backfill_gate); 3 external calls (eprintln!, has_been_set, warn!).


##### `get_state_db`  (lines 217–244)

```
async fn get_state_db(config: &impl RolloutConfigView) -> Option<StateDbHandle>
```

**Purpose**: Opens the SQLite database only if it already exists and has finished backfilling. It is for read-only or non-owning situations where this process should not start backfill itself.

**Data flow**: It checks whether the expected database file exists. If not, it records a fallback and returns `None`; if it exists, it tries to open the runtime and then asks `require_backfill_complete` to verify that it is safe to use.

**Call relations**: `init_state_db_for_app_server_target` calls this for optional database access. Unlike `init`, it does not run rollout backfill; it calls `require_backfill_complete` and otherwise records fallback reasons for metrics.

*Call graph*: calls 2 internal fn (require_backfill_complete, init); called by 1 (init_state_db_for_app_server_target); 5 external calls (record_fallback, state_db_path, model_provider_id, sqlite_home, try_exists).


##### `sqlite_telemetry_recorder`  (lines 247–252)

```
fn sqlite_telemetry_recorder(
    metrics: codex_otel::MetricsClient,
    originator: &str,
) -> codex_state::DbTelemetryHandle
```

**Purpose**: Builds a telemetry recorder for SQLite database activity. Telemetry means measurements and events used to understand how the system behaves.

**Data flow**: It receives a metrics client and an origin label, then passes them to the SQLite metrics recorder builder. The result is a database telemetry handle that other state code can use.

**Call relations**: This is a thin adapter around `sqlite_metrics::recorder`. It lets callers create database metrics using the rollout crate’s chosen metrics wiring.

*Call graph*: calls 1 internal fn (recorder).


##### `require_backfill_complete`  (lines 254–286)

```
async fn require_backfill_complete(
    runtime: StateDbHandle,
    codex_home: &Path,
) -> Option<StateDbHandle>
```

**Purpose**: Checks whether an opened database is safe to read. It rejects databases whose startup backfill is missing, incomplete, or unreadable.

**Data flow**: It receives a database runtime and a path used for warning messages. It reads the backfill state; if the state is complete, it returns the runtime, otherwise it logs the problem, records a fallback reason, and returns `None`.

**Call relations**: `get_state_db` calls this after opening an existing database. This separates “can the database file be opened?” from “does it contain complete enough data to trust?”

*Call graph*: called by 1 (get_state_db); 3 external calls (get_backfill_state, record_fallback, warn!).


##### `cursor_to_anchor`  (lines 288–294)

```
fn cursor_to_anchor(cursor: Option<&Cursor>) -> Option<codex_state::Anchor>
```

**Purpose**: Converts a list cursor into the database’s paging anchor. A paging anchor tells SQLite where the next page of results should start.

**Data flow**: It receives an optional cursor. If one exists, it extracts its timestamp, converts nanoseconds to milliseconds, turns that into a UTC timestamp, and wraps it as a database anchor; if any step cannot be done safely, it returns `None`.

**Call relations**: `list_thread_ids_db` and `list_threads_db` call this before asking SQLite for paged results. It translates the rollout listing layer’s cursor format into the state database’s format.

*Call graph*: called by 2 (list_thread_ids_db, list_threads_db); 2 external calls (from_timestamp_millis, try_from).


##### `normalize_cwd_for_state_db`  (lines 296–298)

```
fn normalize_cwd_for_state_db(cwd: &Path) -> PathBuf
```

**Purpose**: Turns a current working directory path into a stable form before storing or comparing it in SQLite. This reduces false mismatches caused by path spelling differences.

**Data flow**: It receives a path and tries to normalize it for path comparison. If normalization succeeds, it returns the normalized path; if normalization fails, it keeps the original path instead of failing the whole operation.

**Call relations**: Backfill and update paths use this before writing or filtering by working directory. In this file it is called by `apply_rollout_items`, `read_repair_rollout_path`, and `reconcile_rollout`; the metadata backfill code also relies on it.

*Call graph*: called by 4 (backfill_sessions_with_lease, apply_rollout_items, read_repair_rollout_path, reconcile_rollout); 1 external calls (normalize_for_path_comparison).


##### `list_thread_ids_db`  (lines 302–352)

```
async fn list_thread_ids_db(
    context: Option<&codex_state::StateRuntime>,
    codex_home: &Path,
    page_size: usize,
    cursor: Option<&Cursor>,
    sort_key: ThreadSortKey,
    allowed_sources
```

**Purpose**: Asks SQLite for a page of thread ids that match basic filters. It is used for fast parity checks without scanning rollout directories.

**Data flow**: It receives an optional database context, a Codex home path, paging information, sort choice, allowed session sources, model providers, and archive filtering. If there is no database context it returns `None`; otherwise it converts filters into database-friendly forms, queries SQLite, and returns either the ids or `None` after logging a warning.

**Call relations**: This is a database-side listing helper. It uses `cursor_to_anchor` to translate paging, warns if the provided Codex home does not match the runtime’s home, and then hands the query to the state runtime.

*Call graph*: calls 1 internal fn (cursor_to_anchor); 3 external calls (as_slice, iter, warn!).


##### `list_threads_db`  (lines 356–450)

```
async fn list_threads_db(
    context: Option<&codex_state::StateRuntime>,
    codex_home: &Path,
    page_size: usize,
    cursor: Option<&Cursor>,
    sort_key: ThreadSortKey,
    sort_direction: So
```

**Purpose**: Asks SQLite for a page of full thread metadata instead of just ids. It supports filters such as source, model provider, working directory, parent thread, archive state, and search text.

**Data flow**: It receives an optional database context and listing filters. It converts cursors, source values, provider lists, working-directory filters, sort settings, and search text into a database filter object; then it queries SQLite. For normal listings, it also checks that each returned rollout path still exists and deletes stale database rows when the file is gone.

**Call relations**: Thread-listing flows such as `find_latest_thread_path`, `list_threads_with_db_fallback`, and `list_rollout_threads` call this for fast database-backed results. It calls `cursor_to_anchor` for paging and `existing_rollout_path` to protect callers from stale paths, except for parent-filtered listings where the persisted database state is treated as authoritative.

*Call graph*: calls 1 internal fn (cursor_to_anchor); called by 3 (find_latest_thread_path, list_threads_with_db_fallback, list_rollout_threads); 5 external calls (with_capacity, as_slice, iter, existing_rollout_path, warn!).


##### `find_rollout_path_by_id`  (lines 453–466)

```
async fn find_rollout_path_by_id(
    context: Option<&codex_state::StateRuntime>,
    thread_id: ThreadId,
    archived_only: Option<bool>,
    stage: &str,
) -> Option<PathBuf>
```

**Purpose**: Looks up the rollout file path for one thread id using SQLite. This is the fast path before falling back to slower filesystem search.

**Data flow**: It receives an optional database context, a thread id, an optional archive filter, and a stage name for warning messages. If no context exists it returns `None`; otherwise it asks SQLite for the path and returns that path, or logs the database error and returns `None`.

**Call relations**: This helper is a leaf adapter around the state runtime’s lookup. The `stage` text lets whichever caller is doing a lookup identify where a warning came from.


##### `mark_thread_memory_mode_polluted`  (lines 468–483)

```
async fn mark_thread_memory_mode_polluted(
    context: Option<&codex_state::StateRuntime>,
    thread_id: ThreadId,
    stage: &str,
)
```

**Purpose**: Marks a thread’s memory mode as polluted in the memories database. In plain terms, it records that the thread’s memory-related state may no longer be clean or trustworthy.

**Data flow**: It receives an optional database context, a thread id, and a stage label. If the context is missing it does nothing; otherwise it calls the memories part of the state runtime to mark the thread, logging a warning if the write fails.

**Call relations**: Callers such as `maybe_mark_thread_memory_mode_polluted`, `mark_thread_memory_mode_polluted_if_external_context`, and `handle_any_tool` use this when outside activity can affect memory state. This function keeps that write optional and non-fatal.

*Call graph*: called by 3 (maybe_mark_thread_memory_mode_polluted, mark_thread_memory_mode_polluted_if_external_context, handle_any_tool); 1 external calls (warn!).


##### `reconcile_rollout`  (lines 486–555)

```
async fn reconcile_rollout(
    context: Option<&codex_state::StateRuntime>,
    rollout_path: &Path,
    default_provider: &str,
    builder: Option<&ThreadMetadataBuilder>,
    items: &[RolloutItem]
```

**Purpose**: Brings SQLite back into agreement with a rollout file. It can either apply known rollout items directly or read the rollout file to rebuild metadata.

**Data flow**: It receives an optional database context, a rollout path, a default provider, optional prebuilt metadata, any new rollout items, archive guidance, and an optional new memory mode. If items or a builder are available, it delegates to `apply_rollout_items`; otherwise it extracts metadata from the rollout file, normalizes paths, preserves selected existing fields, applies archive rules, upserts the thread row, and updates memory mode.

**Call relations**: This is used by update and fallback flows, including `list_threads_with_db_fallback`, `read_repair_rollout_path`, and several metadata update tests. It calls `metadata::extract_metadata_from_rollout` when it needs to rebuild from disk, and `apply_rollout_items` when incremental data is already available.

*Call graph*: calls 3 internal fn (extract_metadata_from_rollout, apply_rollout_items, normalize_cwd_for_state_db); called by 8 (thread_metadata_update_repairs_loaded_thread_without_resetting_summary, list_threads_with_db_fallback, read_repair_rollout_path, update_thread_metadata_clears_git_info_fields, update_thread_metadata_keeps_archived_thread_archived_in_sqlite, update_thread_metadata_keeps_live_archived_thread_archived_in_sqlite, update_thread_metadata_preserves_memory_mode_when_updating_git_info, update_thread_metadata); 2 external calls (is_empty, warn!).


##### `read_repair_rollout_path`  (lines 558–621)

```
async fn read_repair_rollout_path(
    context: Option<&codex_state::StateRuntime>,
    thread_id: Option<ThreadId>,
    archived_only: Option<bool>,
    rollout_path: &Path,
)
```

**Purpose**: Fixes SQLite after the program successfully found a rollout file by another method. This is a “repair while reading” path: once the correct file is known, the database is updated so the next lookup can be fast.

**Data flow**: It receives an optional database context, maybe a thread id, optional archive guidance, and the correct rollout path. If an existing database row can be read, it updates the path and normalized working directory only when something actually changed; if the row is missing or the quick update fails, it reads session metadata from the file and calls `reconcile_rollout` to rebuild the row.

**Call relations**: `find_thread_path_by_id_str_in_subdir` and `list_threads_with_db_fallback` call this after filesystem fallback succeeds. It uses `normalize_cwd_for_state_db` for stable path storage and hands slow repairs to `reconcile_rollout`.

*Call graph*: calls 3 internal fn (read_session_meta_line, normalize_cwd_for_state_db, reconcile_rollout); called by 2 (find_thread_path_by_id_str_in_subdir, list_threads_with_db_fallback); 2 external calls (to_path_buf, warn!).


##### `apply_rollout_items`  (lines 625–666)

```
async fn apply_rollout_items(
    context: Option<&codex_state::StateRuntime>,
    rollout_path: &Path,
    default_provider: &str,
    builder: Option<&ThreadMetadataBuilder>,
    items: &[RolloutIte
```

**Purpose**: Applies newly seen rollout items to SQLite without rereading the whole rollout file. This keeps the database current as a thread changes.

**Data flow**: It receives an optional database context, rollout path, default provider, optional metadata builder, item list, stage label, optional memory mode, and optional updated-at timestamp override. It obtains or builds metadata, fills in a default provider if missing, stores the rollout path, normalizes the working directory, and asks the state runtime to apply the items; failures are logged but not thrown.

**Call relations**: `reconcile_rollout` calls this when it already has a metadata builder or new rollout items. It may use `metadata::builder_from_items` if no builder was supplied, then delegates the actual database update to the state runtime.

*Call graph*: calls 2 internal fn (builder_from_items, normalize_cwd_for_state_db); called by 1 (reconcile_rollout); 2 external calls (to_path_buf, warn!).


##### `touch_thread_updated_at`  (lines 668–686)

```
async fn touch_thread_updated_at(
    context: Option<&codex_state::StateRuntime>,
    thread_id: Option<ThreadId>,
    updated_at: DateTime<Utc>,
    stage: &str,
) -> bool
```

**Purpose**: Updates a thread’s `updated_at` time in SQLite. Callers use this when a thread should appear recently changed even if only the timestamp needs adjusting.

**Data flow**: It receives an optional database context, an optional thread id, the new timestamp, and a stage label. If the database context or thread id is missing it returns `false`; otherwise it writes the new timestamp and returns whether SQLite reported success, logging and returning `false` on error.

**Call relations**: This is a small database-write helper for callers that already know the thread id and timestamp. The `stage` label is included in warnings so failures can be traced back to the calling flow.


### SQLite runtime initialization
These files open, migrate, and assemble the shared SQLite-backed runtime and its migration policy.

### `state/src/runtime.rs`

`orchestration` · `startup, runtime storage access, teardown, and storage diagnostics`

Codex keeps several kinds of local data on disk: thread state, log history, goals, and memories. This file is the piece that turns a Codex home folder into a working set of database connections. Without it, the rest of the system would not know where those database files live, how to open them, how to upgrade their tables, or how to cleanly shut them down.

The main type is StateRuntime. Think of it like a small building manager for four storage rooms. At startup it creates the home directory if needed, opens each SQLite database file, runs migrations (database upgrade scripts), and records telemetry so failures and slow startup phases can be seen later. Logs are kept in their own database file to reduce lock contention, meaning fewer tasks fight over the same SQLite writer lock.

The file also provides simple path helpers, a database integrity check, and a special memory-clearing helper used by a debug command. If startup fails partway through, it closes any databases it already opened so no background pool is left running. The tests at the bottom verify that integrity checks work, that the runtime can tolerate a database marked with newer migrations, and that startup telemetry records each expected phase.

#### Function details

##### `RuntimeDbSpec::path`  (lines 109–111)

```
fn path(self, codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the full file path for one runtime database inside the Codex home directory. It lets the rest of the file avoid repeating filename-joining logic.

**Data flow**: It receives a Codex home folder path and reads the database filename stored in the RuntimeDbSpec. It joins the folder and filename together, then returns the resulting path.

**Call relations**: The database constants use this helper during startup and in public path helpers. It is the small path-building step before any SQLite file can be opened.

*Call graph*: 1 external calls (join).


##### `StateRuntime::init`  (lines 171–178)

```
async fn init(codex_home: PathBuf, default_provider: String) -> anyhow::Result<Arc<Self>>
```

**Purpose**: Starts the normal StateRuntime used by the application. Callers use it when they want the local state databases opened, migrated, and ready for use.

**Data flow**: It receives the Codex home folder and the default provider name. It passes those values into the shared startup routine with no test telemetry override, then returns a shared StateRuntime object or an error.

**Call relations**: Many production and integration flows call this as the public entry point. It immediately hands the real work to StateRuntime::init_inner so normal startup and test startup follow the same path.

*Call graph*: called by 181 (state_runtime, remote_control_state_runtime, remote_control_state_runtime, remote_control_state_runtime, external_agent_config_import_sends_completion_notification_for_sync_only_import, init_state_db, disable_waits_for_in_flight_durable_enable, listen_off_exits_without_persisted_remote_control_enable, listen_off_honors_persisted_remote_control_enable, listen_off_ignores_persisted_enable_when_disabled_by_requirements (+15 more)); 1 external calls (init_inner).


##### `StateRuntime::init_with_telemetry_for_tests`  (lines 181–187)

```
async fn init_with_telemetry_for_tests(
        codex_home: PathBuf,
        default_provider: String,
        telemetry_override: &dyn DbTelemetry,
    ) -> anyhow::Result<Arc<Self>>
```

**Purpose**: Starts StateRuntime in tests while sending database startup metrics to a test-provided telemetry collector. This makes startup behavior observable without using the real telemetry system.

**Data flow**: It receives the home folder, provider name, and a telemetry object. It forwards them to the shared startup routine and returns the created runtime or the startup error.

**Call relations**: The telemetry-focused test calls this to inspect which startup phases were reported. Like the normal initializer, it delegates to StateRuntime::init_inner.

*Call graph*: called by 1 (init_records_successful_sqlite_init_phases_to_explicit_telemetry); 1 external calls (init_inner).


##### `StateRuntime::init_inner`  (lines 189–307)

```
async fn init_inner(
        codex_home: PathBuf,
        default_provider: String,
        telemetry_override: Option<&dyn DbTelemetry>,
    ) -> anyhow::Result<Arc<Self>>
```

**Purpose**: Does the real startup work for StateRuntime. It opens all runtime databases, runs their migrations, prepares supporting stores, and builds the runtime object used by the rest of the system.

**Data flow**: It starts with a Codex home path, a provider name, and optional telemetry. It creates the directory, builds migrators, computes database paths, opens state/logs/goals/memories databases, ensures a backfill tracking row exists, reads the latest thread update time, creates GoalStore and MemoryStore wrappers, runs log maintenance, and returns a shared StateRuntime. If any required step fails, it closes any database pools already opened and returns the error.

**Call relations**: StateRuntime::init and the test initializer both call this. It coordinates lower-level helpers such as open_state_sqlite, open_logs_sqlite, open_goals_sqlite, open_memories_sqlite, ensure_backfill_state_row_in_pool, and close_sqlite_pools.

*Call graph*: calls 12 internal fn (runtime_goals_migrator, runtime_logs_migrator, runtime_memories_migrator, close_sqlite_pools, ensure_backfill_state_row_in_pool, new, new, open_goals_sqlite, open_logs_sqlite, open_memories_sqlite (+2 more)); 9 external calls (clone, new, new, now, as_path, query_scalar, runtime_state_migrator, create_dir_all, warn!).


##### `StateRuntime::codex_home`  (lines 310–312)

```
fn codex_home(&self) -> &Path
```

**Purpose**: Returns the Codex home directory used by this runtime. Callers use it when they need to create or find files alongside the runtime databases.

**Data flow**: It reads the stored PathBuf from the StateRuntime and returns it as a path reference. Nothing is changed.

**Call relations**: Thread setup helpers call this when they need to know where this runtime lives on disk. It is a simple accessor after startup has completed.

*Call graph*: called by 2 (seed_thread_metadata, upsert_test_thread); 1 external calls (as_path).


##### `StateRuntime::thread_goals`  (lines 314–316)

```
fn thread_goals(&self) -> &GoalStore
```

**Purpose**: Returns the goal store for reading or changing goals tied to threads. This gives callers a focused interface instead of exposing the raw goals database pool.

**Data flow**: It reads the GoalStore stored inside StateRuntime and returns a shared reference to it. No database query happens here by itself.

**Call relations**: Goal-related operations call this before getting, setting, clearing, or seeding thread goals. It connects higher-level goal commands to the store created during startup.

*Call graph*: called by 4 (clear_thread_goal, get_thread_goal, set_thread_goal, seed_thread_cleanup_state).


##### `StateRuntime::memories`  (lines 318–320)

```
fn memories(&self) -> &MemoryStore
```

**Purpose**: Returns the memory store for reading or changing stored memories. Callers use it instead of touching the memories database directly.

**Data flow**: It reads the MemoryStore inside StateRuntime and returns a shared reference. The function itself does not modify data.

**Call relations**: Memory-related flows call this when they need to claim, complete, fail, seed, or inspect memory work. It exposes the MemoryStore that init_inner built from the memories and state database pools.

*Call graph*: called by 5 (claim, failed, succeed, seed_stage1_output_for_existing_thread, memory_pool).


##### `StateRuntime::close`  (lines 323–328)

```
async fn close(&self)
```

**Purpose**: Cleanly shuts down all database pools owned by the runtime. This prevents background database workers from staying alive after the runtime is no longer needed.

**Data flow**: It starts with an active StateRuntime. It asks the memory store and goal store to close, then closes the logs database pool and the main state database pool. It returns after shutdown requests have completed.

**Call relations**: Callers use this during teardown. It is the orderly counterpart to StateRuntime startup, closing the stores and pools that init_inner opened.

*Call graph*: calls 2 internal fn (close, close).


##### `StateRuntime::clear_memory_data_in_sqlite_home`  (lines 330–346)

```
async fn clear_memory_data_in_sqlite_home(sqlite_home: &Path) -> anyhow::Result<bool>
```

**Purpose**: Deletes memory data from the memories database in a given SQLite home folder, if that database exists. It is used by a debug command that needs to reset memories without removing all state.

**Data flow**: It receives a folder path, builds the memories database path, and first checks whether the file exists. If not, it returns false. If it exists, it opens and migrates the memories database, clears memory data inside it, closes the pool, and returns true.

**Call relations**: The debug clear-memories command calls this. Internally it reuses the normal memories database migrator and open_memories_sqlite path so the cleanup runs against the expected schema.

*Call graph*: calls 3 internal fn (runtime_memories_migrator, clear_memory_data_in_pool, open_memories_sqlite); called by 1 (run_debug_clear_memories_command); 1 external calls (try_exists).


##### `close_sqlite_pools`  (lines 349–353)

```
async fn close_sqlite_pools(pools: &[&SqlitePool])
```

**Purpose**: Closes a list of SQLite connection pools. It is used when startup fails after some databases have already opened.

**Data flow**: It receives a slice of database pools. It walks through them one by one and asks each pool to close. It does not return data.

**Call relations**: StateRuntime::init_inner calls this on error paths. It keeps partial startup failures from leaving open database workers behind.

*Call graph*: called by 1 (init_inner).


##### `base_sqlite_options`  (lines 355–363)

```
fn base_sqlite_options(path: &Path) -> SqliteConnectOptions
```

**Purpose**: Creates the common SQLite connection settings used by the runtime databases. These settings make database files if missing, use write-ahead logging, and wait briefly when the database is busy.

**Data flow**: It receives a database path. It builds SQLite connection options with that filename, file creation enabled, WAL mode, normal sync behavior, a five-second busy timeout, and SQL statement logging disabled, then returns those options.

**Call relations**: open_sqlite calls this before opening any runtime database. It centralizes the shared SQLite behavior so state, logs, goals, and memories are opened consistently.

*Call graph*: called by 1 (open_sqlite); 2 external calls (from_secs, new).


##### `open_state_sqlite`  (lines 365–374)

```
async fn open_state_sqlite(
    path: &Path,
    migrator: &Migrator,
    telemetry_override: Option<&dyn DbTelemetry>,
) -> anyhow::Result<SqlitePool>
```

**Purpose**: Opens and migrates the main state database. This database stores core runtime state such as threads and backfill tracking.

**Data flow**: It receives a path, a migrator, and optional telemetry. It forwards those to the generic open_sqlite helper using the state database specification and returns the opened pool or an error.

**Call relations**: StateRuntime::init_inner calls this during startup. A test also calls it directly to verify the runtime migrator behaves correctly.

*Call graph*: calls 1 internal fn (open_sqlite); called by 2 (init_inner, open_state_sqlite_tolerates_newer_applied_migrations).


##### `open_logs_sqlite`  (lines 376–382)

```
async fn open_logs_sqlite(
    path: &Path,
    migrator: &Migrator,
    telemetry_override: Option<&dyn DbTelemetry>,
) -> anyhow::Result<SqlitePool>
```

**Purpose**: Opens and migrates the logs database. Logs are separated from state so heavy log writing is less likely to block other state updates.

**Data flow**: It receives a path, migrator, and optional telemetry. It delegates to open_sqlite using the logs database specification and returns the resulting pool or error.

**Call relations**: StateRuntime::init_inner calls this after the state database opens. It is a thin, named wrapper around the shared open_sqlite routine.

*Call graph*: calls 1 internal fn (open_sqlite); called by 1 (init_inner).


##### `open_goals_sqlite`  (lines 384–390)

```
async fn open_goals_sqlite(
    path: &Path,
    migrator: &Migrator,
    telemetry_override: Option<&dyn DbTelemetry>,
) -> anyhow::Result<SqlitePool>
```

**Purpose**: Opens and migrates the goals database. This prepares storage for per-thread goal information.

**Data flow**: It receives a database path, migrator, and optional telemetry. It calls open_sqlite with the goals database specification and returns an opened pool or an error.

**Call relations**: StateRuntime::init_inner calls this before creating GoalStore. It relies on the common open_sqlite behavior used by all runtime databases.

*Call graph*: calls 1 internal fn (open_sqlite); called by 1 (init_inner).


##### `open_memories_sqlite`  (lines 392–398)

```
async fn open_memories_sqlite(
    path: &Path,
    migrator: &Migrator,
    telemetry_override: Option<&dyn DbTelemetry>,
) -> anyhow::Result<SqlitePool>
```

**Purpose**: Opens and migrates the memories database. This prepares storage for remembered information used across runtime work.

**Data flow**: It receives a path, migrator, and optional telemetry. It passes them to open_sqlite with the memories database specification and returns the ready pool or an error.

**Call relations**: StateRuntime::init_inner calls this during normal startup, and clear_memory_data_in_sqlite_home calls it for the debug memory-clearing path.

*Call graph*: calls 1 internal fn (open_sqlite); called by 2 (clear_memory_data_in_sqlite_home, init_inner).


##### `open_sqlite`  (lines 400–436)

```
async fn open_sqlite(
    path: &Path,
    migrator: &Migrator,
    spec: RuntimeDbSpec,
    telemetry_override: Option<&dyn DbTelemetry>,
) -> anyhow::Result<SqlitePool>
```

**Purpose**: Contains the shared recipe for opening a runtime SQLite database and applying migrations. It also records telemetry for the open and migration phases.

**Data flow**: It receives a path, a migrator, a database specification, and optional telemetry. It builds connection options, opens a pool with up to five connections, records whether opening succeeded, runs migrations, records whether migration succeeded, and returns the pool. If opening or migration fails, it wraps the error with the database label and path; if migration fails after opening, it closes the pool first.

**Call relations**: The four database-specific open helpers all call this. It is the common workhorse behind state, logs, goals, and memories startup.

*Call graph*: calls 3 internal fn (base_sqlite_options, new, record_init_result); called by 4 (open_goals_sqlite, open_logs_sqlite, open_memories_sqlite, open_state_sqlite); 3 external calls (now, run, new).


##### `ensure_backfill_state_row_in_pool`  (lines 438–464)

```
async fn ensure_backfill_state_row_in_pool(
    pool: &sqlx::SqlitePool,
) -> anyhow::Result<()>
```

**Purpose**: Makes sure the state database has the single tracking row used for backfill work. Backfill means filling in older or missing data after a schema or feature change.

**Data flow**: It receives a state database pool. It first checks whether the backfill tracking row already exists. If it does, it returns without writing. If not, it inserts a pending row with the current timestamp, using conflict protection so another writer creating it at the same time is harmless.

**Call relations**: StateRuntime::init_inner calls this after opening databases. It prepares the state database for later backfill jobs without forcing an unnecessary write on every startup.

*Call graph*: called by 1 (init_inner); 2 external calls (now, query).


##### `state_db_filename`  (lines 466–468)

```
fn state_db_filename() -> String
```

**Purpose**: Returns the configured filename for the main state database. This is useful for code that needs the name but not a full path.

**Data flow**: It reads the state database specification and returns its filename as a new string. Nothing else changes.

**Call relations**: This is a public helper alongside the other database filename helpers. It reflects the same constant used by startup.


##### `state_db_path`  (lines 470–472)

```
fn state_db_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the full path to the main state database inside a Codex home folder.

**Data flow**: It receives a Codex home path and combines it with the state database filename. It returns the resulting path.

**Call relations**: Tests use this to create or inspect state databases. It follows the same path rule used by runtime startup.

*Call graph*: called by 2 (open_state_sqlite_tolerates_newer_applied_migrations, sqlite_integrity_check_reports_ok_for_valid_db).


##### `logs_db_filename`  (lines 474–476)

```
fn logs_db_filename() -> String
```

**Purpose**: Returns the configured filename for the logs database.

**Data flow**: It reads the logs database specification and returns the filename as a string. It does not touch the file system.

**Call relations**: This public helper mirrors the logs database path used during startup.


##### `logs_db_path`  (lines 478–480)

```
fn logs_db_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the full path to the logs database inside a Codex home folder.

**Data flow**: It receives a Codex home path, joins it with the logs database filename, and returns the path.

**Call relations**: Other parts of the system can use this when they need to locate the logs database without opening the full runtime.


##### `goals_db_filename`  (lines 482–484)

```
fn goals_db_filename() -> String
```

**Purpose**: Returns the configured filename for the goals database.

**Data flow**: It reads the goals database specification and returns its filename as a string. No state is changed.

**Call relations**: This helper stays in sync with the database file that StateRuntime::init_inner opens for goals.


##### `goals_db_path`  (lines 486–488)

```
fn goals_db_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the full path to the goals database inside a Codex home folder.

**Data flow**: It receives a Codex home path and joins it with the goals database filename. It returns the full path.

**Call relations**: It is the public path helper for the same goals database opened by open_goals_sqlite.


##### `memories_db_filename`  (lines 490–492)

```
fn memories_db_filename() -> String
```

**Purpose**: Returns the configured filename for the memories database.

**Data flow**: It reads the memories database specification and returns the filename as a string. It performs no I/O.

**Call relations**: This helper reflects the filename used by memory startup and debug memory cleanup.


##### `memories_db_path`  (lines 494–496)

```
fn memories_db_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the full path to the memories database inside a Codex home folder.

**Data flow**: It receives a Codex home path, joins it with the memories database filename, and returns the full path.

**Call relations**: It matches the path that open_memories_sqlite uses during startup and cleanup.


##### `runtime_db_paths`  (lines 498–506)

```
fn runtime_db_paths(codex_home: &Path) -> Vec<RuntimeDbPath>
```

**Purpose**: Returns the labels and paths for all runtime database files. This is useful for diagnostics, backup, recovery, or reporting.

**Data flow**: It receives a Codex home path. It walks over the runtime database specifications, builds each database path, pairs it with a human-readable label, and returns the collection.

**Call relations**: This helper gathers the same database list used by startup into one public view. Recovery or tooling code can use it to know every runtime database file.


##### `sqlite_integrity_check`  (lines 509–524)

```
async fn sqlite_integrity_check(path: &Path) -> anyhow::Result<Vec<String>>
```

**Purpose**: Runs SQLite's built-in integrity check on an existing database file. This helps detect file corruption or structural problems.

**Data flow**: It receives a database path. It opens the file read-only without creating it, runs PRAGMA integrity_check, collects the returned messages, closes the pool, and returns those messages.

**Call relations**: A test calls this to confirm a valid database reports ok. In production-style diagnostics, it can be used before deciding whether a database needs recovery.

*Call graph*: called by 1 (sqlite_integrity_check_reports_ok_for_valid_db); 2 external calls (new, new).


##### `tests::TestTelemetry::counters`  (lines 558–568)

```
fn counters(&self) -> Vec<MetricEvent>
```

**Purpose**: Returns a copy of the telemetry counter events captured during a test. It lets assertions inspect telemetry without exposing the internal lock-protected list.

**Data flow**: It locks the stored vector of metric events, copies each event's name and tags, and returns the copied list. The original stored events remain unchanged.

**Call relations**: The telemetry startup test uses this after initializing StateRuntime. It reads what tests::TestTelemetry::counter collected during startup.


##### `tests::TestTelemetry::counter`  (lines 572–580)

```
fn counter(&self, name: &str, _inc: i64, tags: &[(&str, &str)])
```

**Purpose**: Records a counter metric event in the test telemetry collector. It is the test double for the real telemetry counter API.

**Data flow**: It receives a metric name, an increment value that this test ignores, and tags. It converts the tags into a map, locks the internal event list, and appends a new MetricEvent.

**Call relations**: Database startup telemetry calls this through the DbTelemetry interface. The test later reads the saved events with tests::TestTelemetry::counters.

*Call graph*: 1 external calls (tags_to_map).


##### `tests::TestTelemetry::record_duration`  (lines 582–588)

```
fn record_duration(
            &self,
            _name: &str,
            _duration: std::time::Duration,
            _tags: &[(&str, &str)],
        )
```

**Purpose**: Accepts duration metrics during tests but intentionally does nothing with them. The tests in this file only care that counter events were emitted.

**Data flow**: It receives a metric name, a duration, and tags. It ignores all of them and returns without changing stored data.

**Call relations**: The telemetry system may call this through the DbTelemetry interface while startup runs. It exists so TestTelemetry satisfies the full interface.


##### `tests::tags_to_map`  (lines 591–595)

```
fn tags_to_map(tags: &[(&str, &str)]) -> BTreeMap<String, String>
```

**Purpose**: Turns telemetry tags into a map that is easy for tests to compare. Tags are small key-value labels attached to a metric.

**Data flow**: It receives a list of string pairs. It copies each key and value into a BTreeMap and returns that map.

**Call relations**: tests::TestTelemetry::counter calls this before storing metric events. It makes later assertions deterministic and simple.


##### `tests::open_db_pool`  (lines 597–605)

```
async fn open_db_pool(path: &Path) -> SqlitePool
```

**Purpose**: Opens an existing SQLite database for tests. It is used when a test wants a plain pool without the runtime's migration-tolerant open path.

**Data flow**: It receives a database path, opens a SQLite pool with file creation disabled, and returns the pool. If opening fails, the test panics.

**Call relations**: The migration-tolerance test calls this to demonstrate how the strict migrator behaves before comparing it with open_state_sqlite.

*Call graph*: 2 external calls (new, connect_with).


##### `tests::sqlite_integrity_check_reports_ok_for_valid_db`  (lines 608–633)

```
async fn sqlite_integrity_check_reports_ok_for_valid_db()
```

**Purpose**: Verifies that sqlite_integrity_check reports ok for a simple valid database. This protects the diagnostic helper from regressions.

**Data flow**: The test creates a temporary Codex home, creates a state database with one sample table, closes it, runs sqlite_integrity_check, and asserts that the result is exactly ok. It then removes the temporary directory.

**Call relations**: The test runner calls this as an asynchronous test. It exercises state_db_path and sqlite_integrity_check together.

*Call graph*: calls 3 internal fn (sqlite_integrity_check, state_db_path, unique_temp_dir); 6 external calls (new, connect_with, assert_eq!, query, create_dir_all, remove_dir_all).


##### `tests::open_state_sqlite_tolerates_newer_applied_migrations`  (lines 636–685)

```
async fn open_state_sqlite_tolerates_newer_applied_migrations()
```

**Purpose**: Verifies that the runtime state migrator can open a database that contains a record for a future migration. This matters when a user downgrades to an older binary after a newer one has touched the database.

**Data flow**: The test creates a temporary state database, applies the current schema, manually inserts a fake future migration record, and closes the pool. It first proves the strict migrator rejects that database, then uses the runtime migrator through open_state_sqlite and expects it to open successfully. Finally it closes the pool and removes the temp directory.

**Call relations**: The test runner calls this to protect startup compatibility. It compares direct strict migration behavior with the runtime's tolerant open path.

*Call graph*: calls 3 internal fn (open_state_sqlite, state_db_path, unique_temp_dir); 9 external calls (new, connect_with, assert!, query, open_db_pool, runtime_state_migrator, create_dir_all, remove_dir_all, vec!).


##### `tests::init_records_successful_sqlite_init_phases_to_explicit_telemetry`  (lines 688–727)

```
async fn init_records_successful_sqlite_init_phases_to_explicit_telemetry()
```

**Purpose**: Verifies that successful StateRuntime startup reports every expected database initialization phase to telemetry. This helps ensure startup observability does not silently disappear.

**Data flow**: The test creates a temporary home and a TestTelemetry collector, starts StateRuntime with that collector, reads the recorded counter events, filters for successful database init events, extracts their phase names, and compares them with the expected set. It then closes database pools and removes the temporary directory.

**Call relations**: The test runner calls this as an asynchronous test. It drives StateRuntime::init_with_telemetry_for_tests and inspects events captured by TestTelemetry.

*Call graph*: calls 2 internal fn (init_with_telemetry_for_tests, unique_temp_dir); 3 external calls (assert_eq!, default, remove_dir_all).


### `state/src/migrations.rs`

`config` · `database startup and maintenance`

A database migration is a planned change to a database layout, such as adding a table or column. This file collects four embedded migration sets: one for general state, one for logs, one for goals, and one for memories. Embedding them means the migration files are bundled into the compiled program, so the program knows how to bring a database up to the version it expects.

The important extra behavior here is tolerance for a database that is “ahead” of the current program. Imagine two versions of Codex running at the same time. A newer version may upgrade the database first. Without this file’s runtime wrapper, the older version could refuse to open the database because it sees migration versions newer than the ones built into it. The helper in this file creates a copy of a migrator with `ignore_missing` turned on. That means unknown newer migrations are ignored, while known migrations are still checked by checksum, which verifies that a migration the program does know about has not changed unexpectedly.

The small public helper functions each return this relaxed runtime migrator for one database area. Other startup and cleanup code can ask for the right migrator without needing to know the compatibility details.

#### Function details

##### `runtime_migrator`  (lines 16–25)

```
fn runtime_migrator(base: &'static Migrator) -> Migrator
```

**Purpose**: This function turns a normal embedded database migrator into a runtime-friendly one that does not fail when the database contains newer migration records. It preserves the actual known migration list and safety checks, but relaxes only the case where the database has been upgraded by a newer program.

**Data flow**: It receives a reference to one built-in migrator. It builds a new migrator using the same migrations, locking rules, transaction setting, migration table name, and schema-creation settings, but changes the setting that controls missing migrations so unknown newer entries are ignored. It returns that new migrator without changing the original one.

**Call relations**: The four area-specific helper functions call this when they need a runtime migrator for state, logs, goals, or memories. Inside, it uses a borrowed view of the existing migration list, so the wrapper can reuse the embedded migration data rather than copying it.

*Call graph*: called by 4 (runtime_goals_migrator, runtime_logs_migrator, runtime_memories_migrator, runtime_state_migrator); 1 external calls (Borrowed).


##### `runtime_state_migrator`  (lines 27–29)

```
fn runtime_state_migrator() -> Migrator
```

**Purpose**: This function gives callers the compatibility-friendly migrator for the main state database. It is a simple named doorway so callers do not have to know which embedded migration set to wrap.

**Data flow**: It takes no input. It reads the embedded state migration set, passes it through the shared runtime wrapper, and returns the resulting migrator.

**Call relations**: It delegates the real work to `runtime_migrator`. Code that needs to migrate or open the state database can use this function to get the relaxed runtime behavior consistently.

*Call graph*: calls 1 internal fn (runtime_migrator).


##### `runtime_logs_migrator`  (lines 31–33)

```
fn runtime_logs_migrator() -> Migrator
```

**Purpose**: This function gives startup code the compatibility-friendly migrator for the logs database. It helps log storage open safely even if another newer Codex process has already applied newer log migrations.

**Data flow**: It takes no input. It reads the embedded logs migration set, wraps it with the shared runtime behavior, and returns the new migrator.

**Call relations**: It calls `runtime_migrator` to apply the common compatibility rule. It is called by `init_inner` during initialization when the logs database area is being prepared.

*Call graph*: calls 1 internal fn (runtime_migrator); called by 1 (init_inner).


##### `runtime_goals_migrator`  (lines 35–37)

```
fn runtime_goals_migrator() -> Migrator
```

**Purpose**: This function gives startup code the compatibility-friendly migrator for the goals database. It lets the goals storage layer tolerate newer migration records while still validating the migrations it knows about.

**Data flow**: It takes no input. It reads the embedded goals migration set, sends it to the shared runtime wrapper, and returns the resulting migrator.

**Call relations**: It relies on `runtime_migrator` for the actual wrapping behavior. `init_inner` calls it during setup when goal-related database tables need to be checked or created.

*Call graph*: calls 1 internal fn (runtime_migrator); called by 1 (init_inner).


##### `runtime_memories_migrator`  (lines 39–41)

```
fn runtime_memories_migrator() -> Migrator
```

**Purpose**: This function gives callers the compatibility-friendly migrator for the memories database. It is used both when setting up memory storage and when clearing memory data in the SQLite home area.

**Data flow**: It takes no input. It reads the embedded memory migration set, wraps it with the shared runtime compatibility settings, and returns that migrator to the caller.

**Call relations**: It calls `runtime_migrator` so memory storage gets the same “ignore unknown newer migrations” behavior as the other database areas. It is called by `init_inner` during initialization and by `clear_memory_data_in_sqlite_home` when memory data is being cleaned up.

*Call graph*: calls 1 internal fn (runtime_migrator); called by 2 (clear_memory_data_in_sqlite_home, init_inner).


### Recovery and operator guidance
These files handle startup failure recovery for local databases and present CLI-facing guidance when persistence initialization goes wrong.

### `cli/src/state_db_recovery.rs`

`orchestration` · `startup`

Codex keeps local data in SQLite database files. SQLite is a small file-based database, so startup can fail if another Codex process has the file locked, if the file is damaged, or if something that should be a folder is actually a plain file. This file keeps that recovery behavior out of the main command-line startup path, like a small roadside-assistance kit for database startup failures.

The code first unwraps startup errors to see whether they are the special local database error type used by the TUI layer. It then classifies the failure using helper checks from `codex_state`: one check looks for lock-related messages, and another looks for corruption-related messages. A separate check catches the case where the SQLite home path is blocked by a file where a directory should be.

If the failure is recoverable, this file can ask `codex_state` to back up the broken database file and prepare a fresh start. It prints user-facing messages before and after that backup, including the database location and backup folder when available. If the terminal is interactive, it pauses for Enter so the user can read what happened; otherwise it keeps going. It also provides simpler guidance for cases where automatic recovery is not used, such as telling the user to run `codex doctor` or close another running Codex process.

#### Function details

##### `startup_error`  (lines 11–14)

```
fn startup_error(err: &std::io::Error) -> Option<&LocalStateDbStartupError>
```

**Purpose**: This function checks whether a general input/output error is really a local state database startup error hidden inside it. It is used when higher-level startup code receives a broad error but needs the database-specific details.

**Data flow**: It receives a standard Rust I/O error. It looks inside that error for an attached underlying error, then tries to view that underlying value as `LocalStateDbStartupError`. If the match succeeds, it returns a borrowed reference to that database startup error; otherwise it returns nothing.

**Call relations**: This is the doorway from general startup failure handling into the more specific recovery logic in this file. It relies on the standard error wrapper's stored inner error rather than doing any database work itself.

*Call graph*: 1 external calls (get_ref).


##### `is_locked`  (lines 16–18)

```
fn is_locked(detail: &str) -> bool
```

**Purpose**: This function answers the question: does this database error message mean another process is using the database? That matters because a lock should usually be fixed by closing the other Codex process, not by rebuilding the database.

**Data flow**: It receives the detailed error text from SQLite. It passes that text to the state layer's lock detector and returns the yes-or-no result unchanged.

**Call relations**: It is a thin command-line-facing wrapper around `codex_state`'s SQLite lock knowledge. Startup code can use it before deciding to show the locked-database guidance.

*Call graph*: 1 external calls (sqlite_error_detail_is_lock).


##### `is_corruption`  (lines 20–22)

```
fn is_corruption(detail: &str) -> bool
```

**Purpose**: This function checks whether an SQLite error detail looks like database corruption. Corruption is one of the cases where Codex may be able to move the bad file aside and create a clean replacement.

**Data flow**: It receives the error detail string. It sends that string to the state layer's corruption detector, then returns the resulting true-or-false answer.

**Call relations**: It is used by `is_auto_backup_recoverable` as one reason to allow automatic backup-and-rebuild recovery. The actual knowledge of SQLite corruption phrases lives in `codex_state`.

*Call graph*: called by 1 (is_auto_backup_recoverable); 1 external calls (sqlite_error_detail_is_corruption).


##### `is_auto_backup_recoverable`  (lines 24–26)

```
fn is_auto_backup_recoverable(startup_error: &LocalStateDbStartupError) -> bool
```

**Purpose**: This function decides whether a startup database failure is safe enough for automatic recovery by backing up the bad local database and starting fresh. It treats either database corruption or a blocking file in the database home path as recoverable.

**Data flow**: It receives a `LocalStateDbStartupError`, reads its human-readable detail text, and checks whether that detail suggests corruption. It also checks the database path to see whether its parent path is wrongly occupied by a file. If either condition is true, it returns true; otherwise it returns false.

**Call relations**: This is the main recovery decision point in the file. It calls `is_corruption` for error-text classification and `sqlite_home_is_blocking_file` for the filesystem shape check before the caller decides whether to run the backup path.

*Call graph*: calls 3 internal fn (is_corruption, sqlite_home_is_blocking_file, detail).


##### `sqlite_home_is_blocking_file`  (lines 28–34)

```
fn sqlite_home_is_blocking_file(startup_error: &LocalStateDbStartupError) -> bool
```

**Purpose**: This helper detects a specific setup problem: the place where Codex expects a database directory is instead a regular file. In that situation, startup cannot create or open the database normally, but the file can be backed up and replaced by a directory.

**Data flow**: It receives the startup database error, reads the database path from it, and looks at that path's parent. It asks the filesystem for information about the parent path. If the parent exists and is a regular file, it returns true; otherwise it returns false.

**Call relations**: It is called only by `is_auto_backup_recoverable`. It supplies the filesystem-based reason for recovery, complementing the corruption check that looks at SQLite's error message.

*Call graph*: calls 1 internal fn (database_path); called by 1 (is_auto_backup_recoverable).


##### `print_auto_backup_start`  (lines 36–40)

```
fn print_auto_backup_start(startup_error: &LocalStateDbStartupError)
```

**Purpose**: This function tells the user that Codex found what appears to be a damaged local database and is about to move it aside. It makes the automatic recovery action visible instead of silently changing files.

**Data flow**: It receives the startup error, prints two plain-language lines to standard error, then calls `print_technical_details` to include the database location and original cause.

**Call relations**: It is used at the start of the automatic backup flow. After it prints the friendly explanation, it hands off to `print_technical_details` for the reusable low-level facts.

*Call graph*: calls 1 internal fn (print_technical_details); 1 external calls (eprintln!).


##### `backup_files_for_fresh_start`  (lines 42–46)

```
async fn backup_files_for_fresh_start(
    startup_error: &LocalStateDbStartupError,
) -> std::io::Result<Vec<RuntimeDbBackup>>
```

**Purpose**: This asynchronous function performs the actual backup step needed for a fresh database start. It asks the state layer to move the failed runtime database file out of the way so Codex can rebuild local data.

**Data flow**: It receives the startup error and reads the failed database path from it. It passes that path to `codex_state::backup_runtime_db_for_fresh_start`, waits for the file operation to finish, and returns either a list of backup records or an I/O error.

**Call relations**: This file does not implement the low-level file-moving itself; it delegates that to `codex_state`. The tests call this function directly to prove that only the failed database is backed up and that a blocking file can be replaced.

*Call graph*: calls 1 internal fn (database_path); called by 2 (backup_backs_up_only_failed_database_file, backup_replaces_blocking_sqlite_home_file); 1 external calls (backup_runtime_db_for_fresh_start).


##### `confirm_fresh_start_rebuild`  (lines 48–71)

```
fn confirm_fresh_start_rebuild(
    startup_error: &LocalStateDbStartupError,
    backups: &[RuntimeDbBackup],
) -> std::io::Result<()>
```

**Purpose**: This function tells the user that Codex successfully rebuilt its local database after moving the damaged one into a backup. It also pauses for confirmation when the user is in an interactive terminal, so the message is not missed.

**Data flow**: It receives the original startup error and the backup records created during recovery. It prints a success explanation, the database path, and either the backup folder path or a note that it is unavailable. If both standard input and standard error are terminals, it waits for the user to press Enter; otherwise it prints that startup will continue. It returns success unless reading from input fails.

**Call relations**: This is the closing message for the automatic recovery flow. It uses `backup_folder` to turn the backup records into a user-friendly folder path, then either waits for the person at the keyboard or continues immediately in non-interactive runs such as scripts.

*Call graph*: calls 1 internal fn (backup_folder); 4 external calls (new, eprintln!, stderr, stdin).


##### `print_diagnostic_guidance`  (lines 73–78)

```
fn print_diagnostic_guidance(startup_error: &LocalStateDbStartupError)
```

**Purpose**: This function prints advice for a damaged database situation when automatic recovery is not being completed here. It points the user to `codex doctor`, which is the command meant to inspect the setup and suggest next steps.

**Data flow**: It receives the startup error, prints a short explanation and support guidance to standard error, then prints the technical details from the error.

**Call relations**: This is one of the user-facing fallback paths. It reuses `print_technical_details` so support information is formatted the same way as in the automatic backup message.

*Call graph*: calls 1 internal fn (print_technical_details); 1 external calls (eprintln!).


##### `print_locked_guidance`  (lines 80–84)

```
fn print_locked_guidance(startup_error: &LocalStateDbStartupError)
```

**Purpose**: This function explains the common case where Codex cannot start because another Codex process is already using the local database. It tells the user to close other copies and try again.

**Data flow**: It receives the startup error, prints lock-specific guidance to standard error, and then prints the database path and cause through `print_technical_details`.

**Call relations**: This is the message path that pairs with lock detection from `is_locked`. Like the other guidance functions, it delegates the repeated technical section to `print_technical_details`.

*Call graph*: calls 1 internal fn (print_technical_details); 1 external calls (eprintln!).


##### `print_technical_details`  (lines 86–90)

```
fn print_technical_details(startup_error: &LocalStateDbStartupError)
```

**Purpose**: This small helper prints the exact database location and original error detail. It gives users and support helpers the concrete facts needed to investigate without repeating formatting code in every message.

**Data flow**: It receives a `LocalStateDbStartupError`. It reads the database path and detail message from it, then writes those values to standard error under a `Technical details` heading.

**Call relations**: Several user-facing functions call this after their plain-language explanation: `print_auto_backup_start`, `print_diagnostic_guidance`, and `print_locked_guidance`. It is the shared final paragraph for database startup failure messages.

*Call graph*: called by 3 (print_auto_backup_start, print_diagnostic_guidance, print_locked_guidance); 1 external calls (eprintln!).


##### `backup_folder`  (lines 92–94)

```
fn backup_folder(backups: &[RuntimeDbBackup]) -> Option<&Path>
```

**Purpose**: This helper finds the folder that contains the backup files, using the first backup record as the example. It exists so the success message can show one useful folder instead of listing file records.

**Data flow**: It receives a slice of backup records. It looks at the first record, takes that record's backup file path, and returns the parent folder if both exist. If there are no backups or no parent folder, it returns nothing.

**Call relations**: It is called by `confirm_fresh_start_rebuild` while preparing the success message. The dedicated test checks that it reports the parent directory of the first backup path.

*Call graph*: called by 1 (confirm_fresh_start_rebuild); 1 external calls (first).


##### `tests::backup_backs_up_only_failed_database_file`  (lines 104–126)

```
async fn backup_backs_up_only_failed_database_file() -> std::io::Result<()>
```

**Purpose**: This test proves that recovery backs up only the database file that failed, not every local database file. That matters because a problem in one database should not unnecessarily disturb unrelated local state.

**Data flow**: It creates a temporary Codex data area with two database files: one normal state file and one failed logs file. It builds a startup error pointing at the failed file, runs `backup_files_for_fresh_start`, and then checks that the failed file was removed into a backup while the other state file still exists.

**Call relations**: The test calls the same backup wrapper that production recovery uses. It verifies the contract between this CLI recovery layer and the lower-level `codex_state` backup function.

*Call graph*: calls 2 internal fn (backup_files_for_fresh_start, new); 6 external calls (new, assert!, assert_eq!, logs_db_path, state_db_path, write).


##### `tests::backup_replaces_blocking_sqlite_home_file`  (lines 129–145)

```
async fn backup_replaces_blocking_sqlite_home_file() -> std::io::Result<()>
```

**Purpose**: This test proves that Codex can recover when the expected SQLite home directory is blocked by a regular file. It checks both the decision to treat that case as recoverable and the file replacement behavior.

**Data flow**: It creates a temporary path and writes a plain file where a database directory should be. It creates a startup error for a database under that path, confirms that `is_auto_backup_recoverable` returns true, runs the backup routine, and checks that the blocking path is now a directory and that a backup file exists.

**Call relations**: The test exercises both the recovery decision helper and the backup wrapper. It anchors the special `sqlite_home_is_blocking_file` case in real filesystem behavior.

*Call graph*: calls 2 internal fn (backup_files_for_fresh_start, new); 5 external calls (new, assert!, assert_eq!, state_db_path, write).


##### `tests::backup_folder_uses_parent_of_first_backup_path`  (lines 148–158)

```
fn backup_folder_uses_parent_of_first_backup_path()
```

**Purpose**: This test checks the small formatting helper used in the recovery success message. It ensures the displayed backup folder is the parent directory of the first backup file.

**Data flow**: It builds one fake backup record with an original database path and a backup file path. It calls `backup_folder` and compares the result with the expected parent directory.

**Call relations**: The test protects the behavior that `confirm_fresh_start_rebuild` relies on when it tells the user where their backed-up database was placed.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `state/src/runtime/recovery.rs`

`io_transport` · `database startup and corruption recovery`

Codex keeps several small runtime databases in the same SQLite home folder. If SQLite says one database is corrupt, the safest fix is often to move that database out of the way and let the program rebuild it. This file does that carefully. It knows how to recognize SQLite corruption errors, find which database path was involved, and back up the right files before a fresh start.

SQLite can store extra companion files next to a database, commonly ending in `-wal` and `-shm`. These are like scratchpads SQLite uses to keep recent changes and shared state. When backing up a database, this file moves those side files too, so the backup is complete and the new database starts cleanly.

The backup is placed under a `db-backups` folder with a unique timestamped name, so older backups are not overwritten. There is also a fallback for an odd case: if the expected SQLite home path is not a folder, it backs up that blocking path itself and recreates the folder. The file also defines `RuntimeDbInitError`, a small error wrapper that remembers which database operation failed and where, making later recovery decisions possible.

#### Function details

##### `RuntimeDbInitError::new`  (lines 31–43)

```
fn new(
        label: &'static str,
        operation: &'static str,
        path: &Path,
        source: anyhow::Error,
    ) -> Self
```

**Purpose**: Creates a database-startup error that remembers what operation failed, which database label it was for, the path involved, and the original error. This extra context lets recovery code later identify the exact database file that may need to be backed up.

**Data flow**: It receives a label, an operation name, a filesystem path, and the underlying error. It copies the path into owned storage and packages all four pieces into a `RuntimeDbInitError`. The result is an error value that carries both human-readable context and the original cause.

**Call relations**: Database-opening code uses this when an SQLite database fails to initialize. Later, recovery helpers can inspect this wrapped error to find the path that failed instead of guessing from a message string.

*Call graph*: called by 2 (open_sqlite, runtime_db_path_for_corruption_error_ignores_corrupt_word_in_path); 1 external calls (to_path_buf).


##### `RuntimeDbInitError::path`  (lines 45–47)

```
fn path(&self) -> &Path
```

**Purpose**: Returns the database path stored inside a `RuntimeDbInitError`. It is used when recovery code needs to know which database file was involved in the failure.

**Data flow**: It reads the saved path from the error and returns it as a borrowed path reference. Nothing is copied or changed.

**Call relations**: This is a small accessor used by `runtime_db_path_for_corruption_error` after that function finds a `RuntimeDbInitError` inside a larger error chain.

*Call graph*: 1 external calls (as_path).


##### `RuntimeDbInitError::fmt`  (lines 51–60)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Builds the user-facing text for a `RuntimeDbInitError`. It explains what operation failed, which database label was involved, where it happened, and what the underlying error said.

**Data flow**: It reads the error's operation, label, path, and source error, then writes a sentence into Rust's formatting output. It does not change the error.

**Call relations**: Rust calls this automatically when the error is printed or converted to text. That makes logs and messages clear enough for a person to understand what went wrong.

*Call graph*: 1 external calls (write!).


##### `RuntimeDbInitError::source`  (lines 64–66)

```
fn source(&self) -> Option<&(dyn std::error::Error + 'static)>
```

**Purpose**: Exposes the original lower-level error that caused this database initialization error. This lets error-reporting and recovery code walk backward through the chain of causes.

**Data flow**: It reads the stored `anyhow::Error` and returns it as the source error. No data is changed.

**Call relations**: Rust's standard error machinery calls this when code asks for the cause of an error. The corruption-detection logic relies on being able to inspect every error in the chain.

*Call graph*: 1 external calls (as_ref).


##### `backup_runtime_db_for_fresh_start`  (lines 71–92)

```
async fn backup_runtime_db_for_fresh_start(
    db_path: &Path,
) -> std::io::Result<Vec<RuntimeDbBackup>>
```

**Purpose**: Moves a runtime SQLite database out of the way so Codex can create a clean replacement. It tries to preserve other databases in the same folder instead of wiping the whole SQLite home.

**Data flow**: It receives the path to the database that should be replaced. It checks the parent folder: if it is a normal directory, it backs up that database plus its SQLite side files; if the parent path exists but is not a directory, it backs up that blocking path and recreates the folder; if the parent does not exist, it creates it and reports that there was nothing to back up. It returns a list of original paths and where they were moved.

**Call relations**: This is the main recovery action callers use after detecting corruption. It delegates the normal database-file case to `backup_runtime_db_files` and the unusual blocked-folder case to `backup_blocking_sqlite_home`.

*Call graph*: calls 2 internal fn (backup_blocking_sqlite_home, backup_runtime_db_files); 5 external calls (parent, other, format!, create_dir_all, metadata).


##### `runtime_db_path_for_corruption_error`  (lines 94–101)

```
fn runtime_db_path_for_corruption_error(err: &anyhow::Error) -> Option<PathBuf>
```

**Purpose**: Looks at an error and, only if it is truly an SQLite corruption error, tries to extract the database path that failed. This prevents the program from backing up files just because a path or message happened to contain the word "corrupt."

**Data flow**: It receives a broad `anyhow::Error`. First it checks whether any cause in the error chain looks like SQLite corruption. If not, it returns nothing. If yes, it searches the same chain for a `RuntimeDbInitError` and returns the path stored there.

**Call relations**: This function connects error recognition with recovery. It calls `is_sqlite_corruption_error` before using `RuntimeDbInitError::path`, so backup decisions are based on both a real SQLite corruption signal and a known database path.

*Call graph*: calls 1 internal fn (is_sqlite_corruption_error); 1 external calls (chain).


##### `is_sqlite_corruption_error`  (lines 103–105)

```
fn is_sqlite_corruption_error(err: &anyhow::Error) -> bool
```

**Purpose**: Answers a yes-or-no question: does this error chain contain an SQLite error that means the database is corrupt or not really a database?

**Data flow**: It receives an `anyhow::Error`, walks through its chain of causes, and tests each cause. It returns `true` as soon as one cause matches known SQLite corruption patterns; otherwise it returns `false`.

**Call relations**: This is used by `runtime_db_path_for_corruption_error` as the gatekeeper before recovery starts. It relies on `sqlite_error_source_is_corruption` to inspect each individual error cause.

*Call graph*: called by 1 (runtime_db_path_for_corruption_error); 1 external calls (chain).


##### `sqlite_error_source_is_corruption`  (lines 107–118)

```
fn sqlite_error_source_is_corruption(source: &(dyn std::error::Error + 'static)) -> bool
```

**Purpose**: Checks one error cause to see whether it is an SQLite database error reporting corruption. It understands both SQLite message text and SQLite error codes.

**Data flow**: It receives one error from an error chain. If the error is not a `sqlx::Error`, or not a database error inside `sqlx`, it returns `false`. If it is a database error, it checks the message text and optional database code for known corruption signs and returns the result.

**Call relations**: This is the per-error test used while `is_sqlite_corruption_error` walks through a full error chain. It hands message checking to `sqlite_error_detail_is_corruption` and code checking to `sqlite_database_code_is_corruption`.

*Call graph*: calls 1 internal fn (sqlite_error_detail_is_corruption).


##### `sqlite_database_code_is_corruption`  (lines 120–125)

```
fn sqlite_database_code_is_corruption(code: Cow<'_, str>) -> bool
```

**Purpose**: Recognizes SQLite's machine-readable corruption codes. SQLite may report corruption as numbers such as `11` or `26`, or as names such as `SQLITE_CORRUPT` and `SQLITE_NOTADB`.

**Data flow**: It receives a database error code as text. It lowercases the code and compares it with the known corruption code forms. It returns `true` for a match and `false` otherwise.

**Call relations**: This supports `sqlite_error_source_is_corruption` when SQLite provides a separate error code. It complements message-text matching, because different SQLite layers may expose the same problem in different forms.

*Call graph*: 1 external calls (matches!).


##### `sqlite_error_detail_is_corruption`  (lines 127–137)

```
fn sqlite_error_detail_is_corruption(detail: &str) -> bool
```

**Purpose**: Recognizes common SQLite corruption phrases in an error message. This catches cases where SQLite reports the problem in plain text instead of, or in addition to, a code.

**Data flow**: It receives an error detail string, lowercases it, and searches for phrases such as "database disk image is malformed," "file is not a database," and SQLite corruption code markers. It returns `true` if any known phrase is present.

**Call relations**: This is called by `sqlite_error_source_is_corruption` while deciding whether an SQLx database error should trigger recovery. It is also useful as a standalone text check for SQLite corruption wording.

*Call graph*: called by 1 (sqlite_error_source_is_corruption).


##### `sqlite_error_detail_is_lock`  (lines 139–142)

```
fn sqlite_error_detail_is_lock(detail: &str) -> bool
```

**Purpose**: Recognizes SQLite messages that mean the database is temporarily locked or busy. This is different from corruption: a locked database may just need to be retried later.

**Data flow**: It receives an error detail string, lowercases it, and checks for "database is locked" or "database is busy." It returns a boolean answer and changes nothing.

**Call relations**: This function is a sibling to the corruption text checker. It helps callers distinguish a temporary access problem from a damaged database, so they do not unnecessarily back up and rebuild data.


##### `backup_runtime_db_files`  (lines 144–152)

```
async fn backup_runtime_db_files(db_path: &Path) -> std::io::Result<Vec<RuntimeDbBackup>>
```

**Purpose**: Backs up one normal SQLite database file and its companion files. This is the common recovery path when the SQLite home is a valid folder.

**Data flow**: It receives the main database path, finds its parent SQLite home folder, builds the list of related SQLite paths, and passes those paths to the lower-level backup routine. It returns the list of files that were actually moved, or an I/O error if the backup cannot be done.

**Call relations**: This is called by `backup_runtime_db_for_fresh_start` for the normal case. It uses `sqlite_paths` to include the `-wal` and `-shm` side files, then lets `backup_sqlite_paths` do the actual filesystem moves.

*Call graph*: calls 2 internal fn (backup_sqlite_paths, sqlite_paths); called by 1 (backup_runtime_db_for_fresh_start); 1 external calls (parent).


##### `backup_sqlite_paths`  (lines 154–180)

```
async fn backup_sqlite_paths(
    sqlite_home: &Path,
    paths: impl IntoIterator<Item = PathBuf>,
) -> std::io::Result<Vec<RuntimeDbBackup>>
```

**Purpose**: Moves a given set of SQLite-related files into a newly created backup folder. It records exactly where each file came from and where it went.

**Data flow**: It receives the SQLite home folder and a list of paths to consider. It creates a unique backup directory, checks each path to see whether it exists, and renames existing files into the backup directory. If no files were found, it removes the empty backup directory and returns an error; otherwise it returns a list of `RuntimeDbBackup` records.

**Call relations**: This is the worker used by `backup_runtime_db_files`. It depends on `create_unique_backup_dir` to avoid overwriting older backups and on `file_name` to keep each moved file's name when placing it in the backup folder.

*Call graph*: calls 2 internal fn (create_unique_backup_dir, file_name); called by 1 (backup_runtime_db_files); 6 external calls (join, new, other, remove_dir, rename, try_exists).


##### `backup_blocking_sqlite_home`  (lines 182–200)

```
async fn backup_blocking_sqlite_home(sqlite_home: &Path) -> std::io::Result<Vec<RuntimeDbBackup>>
```

**Purpose**: Handles the unusual case where the expected SQLite home path exists but is not a directory. It moves that blocking path aside and recreates the needed folder.

**Data flow**: It receives the intended SQLite home path. It finds the parent directory, creates a special backup parent name based on the blocked path, creates a unique backup directory, renames the blocking path into it, and then creates a fresh directory at the original SQLite home path. It returns one backup record for the moved path.

**Call relations**: This is called by `backup_runtime_db_for_fresh_start` when startup finds that the SQLite home path exists but cannot be used as a folder. It uses `create_unique_backup_dir` and `file_name` to make a safe destination before moving anything.

*Call graph*: calls 2 internal fn (create_unique_backup_dir, file_name); called by 1 (backup_runtime_db_for_fresh_start); 5 external calls (parent, format!, create_dir_all, rename, vec!).


##### `sqlite_paths`  (lines 202–212)

```
fn sqlite_paths(db_path: &Path) -> Vec<PathBuf>
```

**Purpose**: Builds the full set of files that belong to a SQLite database for backup purposes: the main database file, its write-ahead log file, and its shared-memory file.

**Data flow**: It receives the main database path. It creates two more paths by appending `-wal` and `-shm` to that path, then returns all three paths in a list.

**Call relations**: This is called by `backup_runtime_db_files` before the actual backup begins. It makes sure recovery does not leave behind SQLite side files that could interfere with a fresh database.

*Call graph*: called by 1 (backup_runtime_db_files); 2 external calls (as_os_str, vec!).


##### `create_unique_backup_dir`  (lines 214–230)

```
async fn create_unique_backup_dir(backup_parent: &Path) -> std::io::Result<PathBuf>
```

**Purpose**: Creates a new backup directory whose name will not collide with an existing backup. It is like making a fresh labeled box before moving files into storage.

**Data flow**: It receives a parent backup folder path. It ensures that parent folder exists, gets the current time in seconds, and tries to create a directory named with that timestamp plus a sequence number. If the name already exists, it increases the sequence number and tries again. It returns the path of the directory it successfully created.

**Call relations**: Both `backup_sqlite_paths` and `backup_blocking_sqlite_home` call this before moving files. This keeps backups separated and avoids accidentally overwriting an earlier recovery backup.

*Call graph*: called by 2 (backup_blocking_sqlite_home, backup_sqlite_paths); 5 external calls (join, format!, now, create_dir, create_dir_all).


##### `file_name`  (lines 232–239)

```
fn file_name(path: &Path) -> std::io::Result<&std::ffi::OsStr>
```

**Purpose**: Extracts the final name part of a path so a file or folder can be recreated under a backup directory with the same name. It reports a clear error if the path has no usable name.

**Data flow**: It receives a path and asks for its last component. If one exists, it returns that name. If not, it returns an I/O error explaining that a backup name cannot be created for the path.

**Call relations**: This helper is used whenever backup code needs to build a destination path: `backup_sqlite_paths` uses it for database files, and `backup_blocking_sqlite_home` uses it for the blocked SQLite home path.

*Call graph*: called by 2 (backup_blocking_sqlite_home, backup_sqlite_paths); 1 external calls (file_name).

## 📊 State Registers Touched

- `reg-install-home-context` — The discovered Codex home folder, install location, bundled resources, and stable local installation identity.
- `reg-state-databases` — The opened local SQLite stores and migration state that hold structured runtime data for threads, agents, goals, jobs, and summaries.
- `reg-rollout-thread-store` — The durable conversation log and searchable thread index used to resume, rebuild, archive, restore, and display sessions.
- `reg-background-work-queues` — The shared set of background tasks such as cloud refreshes, cleanup jobs, memory jobs, skill watchers, agent jobs, update checks, and session maintenance.
- `reg-observability-telemetry` — The shared logs, traces, metrics, analytics facts, rollout tracing, debug captures, and feedback evidence used to understand what happened.
