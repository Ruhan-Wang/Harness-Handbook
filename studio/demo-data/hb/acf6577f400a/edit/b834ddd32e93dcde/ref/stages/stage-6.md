# Persistence and local runtime services startup  `stage-6`

This stage is part of startup. Its job is to make sure the app’s local storage is ready before the rest of the system begins real work. Think of it like opening a workshop in the morning: unlock the room, check the tools, fix anything broken, and only then let everyone start.

The main setup happens in state/src/runtime.rs. It opens the local SQLite databases, which are small on-disk databases, for state, logs, goals, and memories, updates them to the expected format, and builds the shared runtime object other code uses. state/src/migrations.rs provides the upgrade rules and makes startup safer by tolerating cases where a database was already upgraded by a newer version of the app.

On top of that, rollout/src/state_db.rs connects the rollout feature to this storage layer. It waits for important metadata backfill, meaning filling in missing saved details, and then offers helpers to list, find, repair, and reconcile thread information. core/src/state_db_bridge.rs is just a small adapter so core code can start this service without depending directly on rollout internals.

If startup hits database corruption or file locking problems, state/src/runtime/recovery.rs and cli/src/state_db_recovery.rs detect the issue, back up damaged files, rebuild when possible, and show clear recovery guidance in the interactive interface.

## Files in this stage

### Core startup bridge
These files provide the top-level entry points that connect higher layers into rollout-backed local state startup.

### `core/src/state_db_bridge.rs`

`orchestration` · `startup`

This file is intentionally minimal. It re-exports `StateDbHandle` from `codex_rollout::state_db` so the rest of the core crate can refer to the database handle through a stable local module path, and it defines `init_state_db`, an async wrapper around `rollout_state_db::init(config)`. The wrapper takes the core `Config` type and returns `Option<StateDbHandle>`, preserving the rollout crate's semantics that database initialization may be disabled or unavailable.

There is no additional policy, caching, or error translation here; the value of the file is architectural. By routing initialization through this bridge, the core crate can keep rollout-state-db wiring localized and avoid scattering direct imports of the rollout module throughout the codebase. That also makes future substitution or instrumentation easier because callers depend on this narrow function rather than the external module directly.

#### Function details

##### `init_state_db`  (lines 6–8)

```
async fn init_state_db(config: &Config) -> Option<StateDbHandle>
```

**Purpose**: Initializes the rollout state database for the provided configuration and returns the resulting handle if one is available. It is a direct async pass-through to the rollout crate.

**Data flow**: It takes `&Config`, awaits `rollout_state_db::init(config)`, and returns the resulting `Option<StateDbHandle>` unchanged. No additional state is read or written in this module.

**Call relations**: Called during startup when session services are being assembled and optional persistence needs to be brought online. It delegates all initialization logic to the external rollout state-db implementation.

*Call graph*: 1 external calls (init).


### `rollout/src/state_db.rs`

`orchestration` · `startup and request handling`

This file is the main orchestration layer between rollout files on disk and the SQLite state database. It defines `StateDbHandle` as `Arc<codex_state::StateRuntime>`, startup timing constants, and a set of async helpers that either initialize the runtime or perform DB-first operations with careful fallback behavior.

Initialization flows through `init`/`try_init` into `try_init_with_roots_inner`, which opens the runtime, waits for rollout metadata backfill to reach `BackfillStatus::Complete`, records the gate duration with `codex_state::record_backfill_gate`, and closes the runtime on failure. `wait_for_backfill_gate` repeatedly reads backfill state, optionally triggers `metadata::backfill_sessions_with_lease` in tests or `metadata::backfill_sessions` in normal runs, warns once loudly and then logs informational retries, and times out after a fixed startup window.

For non-owning contexts, `get_state_db` opens the DB only if the file exists and backfill is already complete, recording fallback reasons like `db_unavailable`, `db_error`, or `backfill_incomplete` instead of mutating startup state.

The rest of the file translates rollout-facing concepts into `codex_state` calls: `cursor_to_anchor` converts list cursors into millisecond `Anchor`s; listing helpers map sort keys, source filters, provider filters, cwd filters, and parent-thread filters into `codex_state` query types; stale rollout paths returned from SQLite are detected with `existing_rollout_path`, warned about, and deleted from the DB. Reconciliation helpers either apply incremental `RolloutItem`s or rebuild metadata from the rollout file, normalize cwd paths for comparison, preserve existing git info and explicit titles when appropriate, repair archived flags, update memory mode, and perform read-repair when filesystem fallback discovers a better rollout path. Throughout, the design favors resilience: absent DB context becomes a no-op or `None`, and most DB errors are downgraded to warnings so rollout features can continue via filesystem scanning.

#### Function details

##### `init`  (lines 43–58)

```
async fn init(config: &impl RolloutConfigView) -> Option<StateDbHandle>
```

**Purpose**: Initializes the SQLite state runtime for normal callers and converts any startup failure into a warning plus `None`.

**Data flow**: Reads a `RolloutConfigView`, materializes it into an owned `RolloutConfig`, and extracts `codex_home`, `sqlite_home`, and `model_provider_id`. It awaits `try_init_with_roots`; on success it returns `Some(StateDbHandle)`, and on error it formats a detailed message, emits a startup warning, and returns `None`.

**Call relations**: This is the forgiving startup entry used when callers prefer degraded behavior over surfacing initialization errors. It delegates all real work to `try_init_with_roots` and only adds error-to-warning conversion around that path.

*Call graph*: calls 3 internal fn (from_view, emit_startup_warning, try_init_with_roots); called by 1 (state_db_init_backfills_before_returning); 1 external calls (format!).


##### `try_init`  (lines 64–72)

```
async fn try_init(config: &impl RolloutConfigView) -> anyhow::Result<StateDbHandle>
```

**Purpose**: Initializes the SQLite state runtime but preserves the exact error for callers that need to handle or surface it.

**Data flow**: Consumes a `RolloutConfigView`, clones it into `RolloutConfig`, extracts the same three root values as `init`, and forwards them to `try_init_with_roots`. It returns `anyhow::Result<StateDbHandle>` unchanged from the deeper initialization path.

**Call relations**: This function is used by callers such as app-server setup and test client startup that need explicit failure propagation. It is a thin wrapper over `try_init_with_roots`, unlike `init` which swallows errors.

*Call graph*: calls 2 internal fn (from_view, try_init_with_roots); called by 2 (start_test_client_with_capacity, init_state_db_for_app_server_target).


##### `try_init_with_roots`  (lines 74–86)

```
async fn try_init_with_roots(
    codex_home: PathBuf,
    sqlite_home: PathBuf,
    default_model_provider_id: String,
) -> anyhow::Result<StateDbHandle>
```

**Purpose**: Starts initialization from explicit filesystem roots and default provider id, using the normal backfill behavior.

**Data flow**: Takes owned `PathBuf` values for `codex_home` and `sqlite_home` plus a provider id `String`. It forwards them to `try_init_with_roots_inner` with `backfill_lease_seconds` set to `None`, and returns that result.

**Call relations**: This helper is the common internal target for both public initialization entry points. It exists to share the main startup logic with the test-only lease-aware variant.

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

**Purpose**: Runs initialization with an explicit backfill lease duration so tests can simulate concurrent or stuck startup backfills deterministically.

**Data flow**: Accepts the same owned roots and provider id as `try_init_with_roots`, plus an `i64` lease duration. It passes all of them into `try_init_with_roots_inner` wrapped in `Some(backfill_lease_seconds)` and returns the resulting `anyhow::Result<StateDbHandle>`.

**Call relations**: This test-only helper feeds the same core startup path as production initialization, but forces `wait_for_backfill_gate` to use lease-aware backfill logic.

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

**Purpose**: Performs the actual startup sequence: open the runtime, wait for metadata backfill completion, record gate telemetry, and close on failure.

**Data flow**: Consumes owned `codex_home`, `sqlite_home`, `default_model_provider_id`, and an optional lease duration. It calls `codex_state::StateRuntime::init` with the SQLite home and provider id, wrapping any failure with path context. It records `Instant::now()`, awaits `wait_for_backfill_gate`, reports the elapsed time and result through `codex_state::record_backfill_gate`, closes the runtime if the gate failed, and otherwise returns the initialized handle.

**Call relations**: Both root-based initialization wrappers funnel into this function. It orchestrates the two critical phases—runtime open and backfill gate—and delegates the polling/backfill loop to `wait_for_backfill_gate`.

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

**Purpose**: Polls the runtime until startup metadata backfill is complete, opportunistically running backfill work and timing out if completion never arrives.

**Data flow**: Reads the runtime, `codex_home`, default provider id, and optional lease duration. In a loop it fetches `get_backfill_state`; if status is `Complete`, it returns `Ok(())`. Otherwise it triggers either `metadata::backfill_sessions_with_lease` or `metadata::backfill_sessions`, re-reads backfill state, checks again for completion, compares elapsed time against `STARTUP_BACKFILL_WAIT_TIMEOUT`, emits a warning on the first wait and `info!` on later waits, sleeps for `STARTUP_BACKFILL_POLL_INTERVAL`, and eventually returns either success or a timeout/read error.

**Call relations**: This function is called only from `try_init_with_roots_inner` as the startup gatekeeper. It delegates actual metadata population to the `metadata` module and controls retry cadence, logging behavior, and timeout semantics around that work.

*Call graph*: calls 3 internal fn (backfill_sessions, backfill_sessions_with_lease, emit_startup_warning); called by 1 (try_init_with_roots_inner); 6 external calls (now, anyhow!, format!, info!, get_backfill_state, sleep).


##### `emit_startup_warning`  (lines 203–211)

```
fn emit_startup_warning(message: &str)
```

**Purpose**: Sends a startup warning through tracing and mirrors it to stderr when tracing has not yet been configured.

**Data flow**: Takes a message string slice, logs it with `warn!`, checks `tracing::dispatcher::has_been_set()`, and if no dispatcher exists prints the same message to stderr with `eprintln!`. It returns `()` and maintains no state.

**Call relations**: This helper is used by `init` for initialization failures and by `wait_for_backfill_gate` for the first visible backfill-delay warning. It centralizes the early-startup logging fallback.

*Call graph*: called by 2 (init, wait_for_backfill_gate); 3 external calls (eprintln!, has_been_set, warn!).


##### `get_state_db`  (lines 217–244)

```
async fn get_state_db(config: &impl RolloutConfigView) -> Option<StateDbHandle>
```

**Purpose**: Opens the SQLite state DB only when it already exists and has completed startup backfill, for optional read-only or non-owning contexts.

**Data flow**: Reads `sqlite_home` and `model_provider_id` from a `RolloutConfigView`. It computes the DB path with `codex_state::state_db_path`, checks existence via `tokio::fs::try_exists`, records a `db_unavailable` fallback and returns `None` if absent, otherwise attempts `StateRuntime::init`; on init failure it records `db_error` and returns `None`. If init succeeds, it passes the runtime into `require_backfill_complete` and returns that result.

**Call relations**: This helper is used where the process should not trigger rollout backfill itself, such as app-server mode. It delegates final readiness validation to `require_backfill_complete` after doing existence and open checks.

*Call graph*: calls 2 internal fn (require_backfill_complete, init); called by 1 (init_state_db_for_app_server_target); 5 external calls (record_fallback, state_db_path, model_provider_id, sqlite_home, try_exists).


##### `sqlite_telemetry_recorder`  (lines 247–252)

```
fn sqlite_telemetry_recorder(
    metrics: codex_otel::MetricsClient,
    originator: &str,
) -> codex_state::DbTelemetryHandle
```

**Purpose**: Exposes the OTEL-backed SQLite telemetry adapter from `sqlite_metrics` under the state DB module's API.

**Data flow**: Accepts a `codex_otel::MetricsClient` and originator string, forwards them to `sqlite_metrics::recorder`, and returns the resulting `codex_state::DbTelemetryHandle`.

**Call relations**: This is a simple pass-through convenience function so callers configuring the state DB can obtain the proper telemetry handle without importing the lower-level adapter module directly.

*Call graph*: calls 1 internal fn (recorder).


##### `require_backfill_complete`  (lines 254–286)

```
async fn require_backfill_complete(
    runtime: StateDbHandle,
    codex_home: &Path,
) -> Option<StateDbHandle>
```

**Purpose**: Validates that an already-open runtime has completed startup backfill before allowing callers to use it.

**Data flow**: Takes ownership of a `StateDbHandle` and borrows the `codex_home` path for logging. It awaits `runtime.get_backfill_state()`: if status is `Complete`, it returns `Some(runtime)`; if status is another value, it warns, records `backfill_incomplete`, and returns `None`; if the read fails, it warns, records `db_error`, and returns `None`.

**Call relations**: This function is the final gate in `get_state_db`. It does not attempt repair or backfill itself; it only decides whether the optional DB handle is safe to expose.

*Call graph*: called by 1 (get_state_db); 3 external calls (get_backfill_state, record_fallback, warn!).


##### `cursor_to_anchor`  (lines 288–294)

```
fn cursor_to_anchor(cursor: Option<&Cursor>) -> Option<codex_state::Anchor>
```

**Purpose**: Converts a rollout listing cursor into the millisecond-precision `codex_state::Anchor` format expected by SQLite queries.

**Data flow**: Accepts `Option<&Cursor>`. If absent it returns `None`. Otherwise it reads the cursor timestamp, converts nanoseconds to milliseconds, attempts `i64` conversion, reconstructs a `chrono::DateTime<Utc>` with `from_timestamp_millis`, and wraps it in `codex_state::Anchor { ts }`. Any failed conversion step yields `None`.

**Call relations**: Both DB listing helpers call this before querying SQLite so filesystem/list-layer cursors can be reused against the state runtime's pagination API.

*Call graph*: called by 2 (list_thread_ids_db, list_threads_db); 2 external calls (from_timestamp_millis, try_from).


##### `normalize_cwd_for_state_db`  (lines 296–298)

```
fn normalize_cwd_for_state_db(cwd: &Path) -> PathBuf
```

**Purpose**: Normalizes a working-directory path into the canonical comparison form used by SQLite metadata, falling back to the original path on normalization failure.

**Data flow**: Borrows a `Path`, passes it to `normalize_for_path_comparison`, and returns either the normalized `PathBuf` or `cwd.to_path_buf()` if normalization errors. It does not touch external state.

**Call relations**: This helper is used anywhere rollout-derived cwd values are written or compared in the DB path: backfill, incremental apply, reconciliation, and read-repair all rely on it to keep path matching stable.

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

**Purpose**: Queries SQLite for a page of thread IDs using rollout-style filters, without scanning rollout files on disk.

**Data flow**: Takes an optional runtime reference plus codex home, page size, optional cursor, sort key, allowed session sources, optional provider filters, archived flag, and a stage label. If context is absent it returns `None`. It warns on codex-home mismatch, converts the cursor with `cursor_to_anchor`, serializes each `SessionSource` into a `String`, clones provider filters if present, maps the sort key into `codex_state::SortKey`, and awaits `ctx.list_thread_ids(...)`. On success it returns `Some(Vec<ThreadId>)`; on error it warns with the stage and returns `None`.

**Call relations**: This function is a DB-only parity/listing helper used by higher-level listing flows. It delegates the actual query to `StateRuntime::list_thread_ids` after translating rollout-layer filter types into the state-layer equivalents.

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

**Purpose**: Fetches thread metadata pages from SQLite using rollout-facing filters and performs cleanup when the DB points at stale rollout paths.

**Data flow**: Accepts an optional runtime, codex home, pagination and sorting inputs, source/provider/cwd filters, optional parent thread id, archived flag, and optional search term. It returns `None` immediately if no context exists, warns on codex-home mismatch, converts the cursor to an anchor, serializes allowed sources to strings, clones provider filters, normalizes cwd filters, builds a `codex_state::ThreadFilterOptions`, and queries either `list_threads_by_parent` or `list_threads`. On success with a parent filter it returns the page unchanged. Otherwise it iterates through `page.items`, checks each `rollout_path` with `crate::compression::existing_rollout_path`, rewrites the path if an existing compressed/uncompressed variant is found, or warns and deletes the stale thread row if no file exists. It then returns the filtered page; query errors produce a warning and `None`.

**Call relations**: Higher-level listing code uses this as the DB-first path before filesystem fallback. It delegates querying to the runtime and, for non-parent listings, adds a reconciliation pass that prunes stale DB entries discovered during read time.

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

**Purpose**: Looks up a thread's rollout file path in SQLite and downgrades lookup failures to warnings plus `None`.

**Data flow**: Takes an optional runtime reference, a `ThreadId`, optional archived filter, and a stage label. If context is absent it returns `None`; otherwise it awaits `ctx.find_rollout_path_by_id(thread_id, archived_only)` and returns the `Option<PathBuf>` on success, or logs a warning containing the stage and returns `None` on error.

**Call relations**: This helper is used by DB-first thread-path lookup flows. It is intentionally thin: it delegates the actual lookup to the runtime and only adds optional-context handling and warning-based error suppression.


##### `mark_thread_memory_mode_polluted`  (lines 468–483)

```
async fn mark_thread_memory_mode_polluted(
    context: Option<&codex_state::StateRuntime>,
    thread_id: ThreadId,
    stage: &str,
)
```

**Purpose**: Marks a thread's memory-mode state as polluted in the memories sub-database, if a state runtime is available.

**Data flow**: Accepts an optional runtime reference, a `ThreadId`, and a stage label. If context is `None` it returns immediately. Otherwise it calls `ctx.memories().mark_thread_memory_mode_polluted(thread_id).await`; any error is logged with the stage, and the function returns `()`.

**Call relations**: This helper is invoked from tool-handling and external-context paths when thread memory mode becomes suspect. It delegates the actual mutation to the memories API on the runtime.

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

**Purpose**: Synchronizes a rollout file's metadata into SQLite, either incrementally from supplied items/builder data or by re-extracting metadata from the file.

**Data flow**: Takes an optional runtime, rollout path, default provider, optional `ThreadMetadataBuilder`, rollout items slice, optional archived filter, and optional new memory mode. If no runtime exists it returns. If a builder is supplied or items are non-empty, it forwards directly to `apply_rollout_items` with stage `reconcile_rollout` and returns. Otherwise it calls `metadata::extract_metadata_from_rollout`, warns and exits on extraction failure, normalizes the extracted cwd, derives memory mode defaulting to `"enabled"`, optionally loads existing metadata with `ctx.get_thread` to preserve git info and explicit title, adjusts `archived_at` according to `archived_only`, upserts the thread metadata, and then updates thread memory mode. Upsert or memory-mode failures are warned and not propagated.

**Call relations**: This is the main repair/reconciliation entry used by metadata update flows, listing fallback, and read-repair. It either delegates to `apply_rollout_items` for incremental updates or performs a full file-based rebuild when no incremental context is available.

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

**Purpose**: Repairs SQLite metadata after filesystem fallback discovers the correct rollout path for a thread.

**Data flow**: Accepts an optional runtime, optional thread id, optional archived filter, and the discovered rollout path. If no runtime exists it returns. On the fast path, when a thread id is present and `ctx.get_thread` returns metadata, it clones that metadata, replaces `rollout_path`, normalizes `cwd`, adjusts `archived_at` according to `archived_only`, compares the repaired value to the original, and if changed warns and attempts `upsert_thread`; a successful upsert returns immediately. If no existing metadata was seen, or the fast-path upsert failed, it warns that slow-path repair is needed, reads the session meta line to infer a default provider, and calls `reconcile_rollout` with no builder and no items to rebuild metadata from file contents.

**Call relations**: This function is called after filesystem lookup succeeds where DB lookup was stale or missing. It first tries an in-place metadata correction, then falls back to full reconciliation if the row is absent, unreadable, or not repairable directly.

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

**Purpose**: Applies incremental rollout items and associated metadata builder state into SQLite for a single thread.

**Data flow**: Takes an optional runtime, rollout path, default provider, optional builder, rollout items slice, stage label, optional new memory mode, and optional updated-at override. If no runtime exists it returns. It clones the provided builder or derives one from `metadata::builder_from_items`; if derivation fails it warns about a missing builder and returns. It fills in `builder.model_provider` from `default_provider` when absent, overwrites `builder.rollout_path`, normalizes `builder.cwd`, and calls `ctx.apply_rollout_items(&builder, items, new_thread_memory_mode, updated_at_override).await`. Errors are logged with stage and path.

**Call relations**: This helper is the incremental-update engine beneath `reconcile_rollout`. It is used when callers already have parsed rollout items or a partially built metadata object and want SQLite updated without rescanning the file.

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

**Purpose**: Updates a thread's `updated_at` timestamp in SQLite when both runtime context and thread id are available.

**Data flow**: Accepts an optional runtime, optional thread id, a `DateTime<Utc>` timestamp, and a stage label. If either the runtime or thread id is missing it returns `false`. Otherwise it awaits `ctx.touch_thread_updated_at(thread_id, updated_at)` and returns the resulting boolean, or logs a warning and returns `false` if the DB call fails.

**Call relations**: This is a small convenience wrapper for callers that may or may not have DB context or a resolved thread id. It delegates the actual timestamp mutation to the runtime and standardizes failure handling.


### SQLite runtime initialization
These files open, migrate, and assemble the shared SQLite-backed runtime and its migration policy.

### `state/src/runtime.rs`

`orchestration` · `startup`

This file is the orchestration hub for persistent runtime state. It defines `RuntimeDbSpec`, a small descriptor used to name each SQLite database, derive its path under `codex_home`, and tag telemetry phases. Four specs (`STATE_DB`, `LOGS_DB`, `GOALS_DB`, `MEMORIES_DB`) feed common startup logic while keeping logs isolated in a dedicated file to reduce lock contention.

`StateRuntime` owns the main state pool, a separate logs pool, and higher-level stores (`GoalStore`, `MemoryStore`) built on top of the goals and memories databases. `init` and `init_inner` perform the full startup sequence: create the home directory, build tolerant migrators from `migrations.rs`, derive all DB paths, open and migrate each SQLite file in order, and on any failure warn and close already-open pools before returning the error. After all pools are live, startup ensures the singleton `backfill_state` row exists, queries `MAX(threads.updated_at_ms)` to seed an `AtomicI64` cache, constructs the runtime, and runs log-database startup maintenance best-effort.

The lower-level helpers centralize SQLite configuration: WAL mode, normal synchronous mode, 5-second busy timeout, incremental auto-vacuum, and a 5-connection pool. `open_sqlite` records telemetry for both open and migrate phases and wraps failures in `RuntimeDbInitError` with the DB label and path. Additional helpers expose canonical filenames and paths, enumerate all runtime DB paths, clear only the memories DB contents in an existing home, and run `PRAGMA integrity_check` against an existing database file.

The test module validates three important behaviors: integrity checks return `ok` for a valid DB, runtime migrators tolerate newer-applied migration versions that strict SQLx migrators reject, and explicit telemetry receives success counters for every initialization phase.

#### Function details

##### `RuntimeDbSpec::path`  (lines 109–111)

```
fn path(self, codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the filesystem path for one runtime database under a given Codex home directory. It encapsulates the filename stored in the DB spec.

**Data flow**: It takes `self` and a borrowed `codex_home: &Path`, joins `self.filename` onto that directory, and returns the resulting `PathBuf`.

**Call relations**: Startup and path helper functions call this whenever they need the concrete location of the state, logs, goals, or memories database.

*Call graph*: 1 external calls (join).


##### `StateRuntime::init`  (lines 171–178)

```
async fn init(codex_home: PathBuf, default_provider: String) -> anyhow::Result<Arc<Self>>
```

**Purpose**: Public entry point for creating a fully initialized `StateRuntime` with default telemetry behavior. It delegates all real work to `init_inner`.

**Data flow**: It takes ownership of `codex_home: PathBuf` and `default_provider: String`, passes them plus `None` for `telemetry_override` into `Self::init_inner`, awaits the result, and returns `anyhow::Result<Arc<StateRuntime>>`.

**Call relations**: Many production and test setup paths invoke this to bring up persistence. It is the standard wrapper around the more configurable `init_inner`.

*Call graph*: called by 181 (state_runtime, remote_control_state_runtime, remote_control_state_runtime, remote_control_state_runtime, external_agent_config_import_sends_completion_notification_for_sync_only_import, init_state_db, disable_waits_for_in_flight_durable_enable, listen_off_exits_without_persisted_remote_control_enable, listen_off_honors_persisted_remote_control_enable, listen_off_ignores_persisted_enable_when_disabled_by_requirements (+15 more)); 1 external calls (init_inner).


##### `StateRuntime::init_with_telemetry_for_tests`  (lines 181–187)

```
async fn init_with_telemetry_for_tests(
        codex_home: PathBuf,
        default_provider: String,
        telemetry_override: &dyn DbTelemetry,
    ) -> anyhow::Result<Arc<Self>>
```

**Purpose**: Test-only initializer that injects an explicit telemetry sink into runtime startup. It exists so tests can assert which initialization phases were recorded.

**Data flow**: It takes `codex_home`, `default_provider`, and a borrowed `DbTelemetry` implementation, forwards them to `Self::init_inner` with `Some(telemetry_override)`, and returns the initialized runtime.

**Call relations**: The telemetry test calls this instead of `init` so startup metrics can be captured and inspected.

*Call graph*: called by 1 (init_records_successful_sqlite_init_phases_to_explicit_telemetry); 1 external calls (init_inner).


##### `StateRuntime::init_inner`  (lines 189–307)

```
async fn init_inner(
        codex_home: PathBuf,
        default_provider: String,
        telemetry_override: Option<&dyn DbTelemetry>,
    ) -> anyhow::Result<Arc<Self>>
```

**Purpose**: Performs the full runtime startup sequence: directory creation, migrator selection, database open/migrate, singleton-row initialization, cache seeding, store construction, and log maintenance. It is the central orchestration function for persistence startup.

**Data flow**: It receives `codex_home`, `default_provider`, and an optional telemetry sink. It creates the home directory, constructs tolerant migrators for all four DBs, derives each DB path, and opens state, logs, goals, and memories pools in order via the corresponding `open_*_sqlite` helpers. On each failure branch it logs a warning, closes any pools already opened using `close_sqlite_pools`, and returns the error. After successful opens it calls `ensure_backfill_state_row_in_pool`, records telemetry for that phase, runs `SELECT MAX(threads.updated_at_ms) FROM threads` to seed `thread_updated_at_millis`, constructs `GoalStore` and `MemoryStore`, wraps pools in `Arc`, stores the provider string and home path, then invokes `runtime.run_logs_startup_maintenance().await` best-effort before returning `Arc<Self>`.

**Call relations**: Both `init` and the test-only initializer funnel into this function. It delegates DB-specific opening to `open_state_sqlite`, `open_logs_sqlite`, `open_goals_sqlite`, and `open_memories_sqlite`, and cleanup to `close_sqlite_pools` whenever a later phase fails after earlier pools succeeded.

*Call graph*: calls 12 internal fn (runtime_goals_migrator, runtime_logs_migrator, runtime_memories_migrator, close_sqlite_pools, ensure_backfill_state_row_in_pool, new, new, open_goals_sqlite, open_logs_sqlite, open_memories_sqlite (+2 more)); 9 external calls (clone, new, new, now, as_path, query_scalar, runtime_state_migrator, create_dir_all, warn!).


##### `StateRuntime::codex_home`  (lines 310–312)

```
fn codex_home(&self) -> &Path
```

**Purpose**: Returns the configured Codex home directory for the runtime. It exposes the root under which all runtime databases live.

**Data flow**: It borrows `self`, calls `self.codex_home.as_path()`, and returns `&Path`.

**Call relations**: Tests and helper code call this when they need to derive additional files relative to the runtime’s home directory.

*Call graph*: called by 2 (seed_thread_metadata, upsert_test_thread); 1 external calls (as_path).


##### `StateRuntime::thread_goals`  (lines 314–316)

```
fn thread_goals(&self) -> &GoalStore
```

**Purpose**: Exposes the embedded `GoalStore` owned by the runtime. It provides access to goal-specific operations without exposing the underlying pool directly.

**Data flow**: It borrows `self` and returns `&GoalStore` from the `thread_goals` field.

**Call relations**: Goal-related commands and tests call this accessor before invoking goal store methods.

*Call graph*: called by 4 (clear_thread_goal, get_thread_goal, set_thread_goal, seed_thread_cleanup_state).


##### `StateRuntime::memories`  (lines 318–320)

```
fn memories(&self) -> &MemoryStore
```

**Purpose**: Exposes the embedded `MemoryStore` owned by the runtime. It is the accessor for memory-specific persistence operations.

**Data flow**: It borrows `self` and returns `&MemoryStore` from the `memories` field.

**Call relations**: Memory workflows call this accessor to reach the memory subsystem after runtime initialization.

*Call graph*: called by 5 (claim, failed, succeed, seed_stage1_output_for_existing_thread, memory_pool).


##### `StateRuntime::close`  (lines 323–328)

```
async fn close(&self)
```

**Purpose**: Shuts down the runtime’s stores and SQLite pools in an orderly async sequence. It waits for pool workers to exit.

**Data flow**: It borrows `self`, awaits `self.memories.close()`, `self.thread_goals.close()`, `self.logs_pool.close()`, and `self.pool.close()`, and returns `()`.

**Call relations**: Shutdown or test teardown paths call this when they want a clean stop of all persistence resources owned by the runtime.

*Call graph*: calls 2 internal fn (close, close).


##### `StateRuntime::clear_memory_data_in_sqlite_home`  (lines 330–346)

```
async fn clear_memory_data_in_sqlite_home(sqlite_home: &Path) -> anyhow::Result<bool>
```

**Purpose**: Opens an existing memories database under a Codex home, clears its stored memory data, and reports whether the DB existed. It is a targeted maintenance operation that does not require a full runtime.

**Data flow**: It takes `sqlite_home: &Path`, derives the memories DB path with `MEMORIES_DB.path`, checks existence with `tokio::fs::try_exists`, and returns `Ok(false)` immediately if absent. If present, it builds a tolerant memories migrator, opens the DB with `open_memories_sqlite`, calls `memories::clear_memory_data_in_pool(&pool)`, closes the pool, and returns `Ok(true)`.

**Call relations**: The debug clear-memories command invokes this standalone helper. It reuses the same migrator and open logic as full startup but only for the memories database.

*Call graph*: calls 3 internal fn (runtime_memories_migrator, clear_memory_data_in_pool, open_memories_sqlite); called by 1 (run_debug_clear_memories_command); 1 external calls (try_exists).


##### `close_sqlite_pools`  (lines 349–353)

```
async fn close_sqlite_pools(pools: &[&SqlitePool])
```

**Purpose**: Closes a slice of SQLite pools sequentially. It is a small cleanup helper used during partial-startup failure handling.

**Data flow**: It takes a slice of borrowed `&SqlitePool`, iterates over it, awaits `pool.close()` for each entry, and returns `()`.

**Call relations**: `init_inner` calls this on error paths after one or more databases have already been opened, ensuring no partially initialized pools are left running.

*Call graph*: called by 1 (init_inner).


##### `base_sqlite_options`  (lines 355–363)

```
fn base_sqlite_options(path: &Path) -> SqliteConnectOptions
```

**Purpose**: Constructs the common SQLite connection options shared by all runtime databases. It centralizes the runtime’s WAL, sync, timeout, and logging policy.

**Data flow**: It takes a database `&Path`, starts from `SqliteConnectOptions::new()`, sets the filename, enables `create_if_missing(true)`, configures WAL journal mode, normal synchronous mode, a 5-second busy timeout, and disables SQL statement logging, then returns the configured `SqliteConnectOptions`.

**Call relations**: `open_sqlite` calls this before adding DB-specific options such as incremental auto-vacuum.

*Call graph*: called by 1 (open_sqlite); 2 external calls (from_secs, new).


##### `open_state_sqlite`  (lines 365–374)

```
async fn open_state_sqlite(
    path: &Path,
    migrator: &Migrator,
    telemetry_override: Option<&dyn DbTelemetry>,
) -> anyhow::Result<SqlitePool>
```

**Purpose**: Opens and migrates the main state database using the shared SQLite startup logic. It exists mainly to attach the `STATE_DB` spec and document state-specific maintenance constraints.

**Data flow**: It takes a path, migrator, and optional telemetry sink, and forwards them to `open_sqlite(path, migrator, STATE_DB, telemetry_override)`, returning the resulting `SqlitePool` or error.

**Call relations**: `init_inner` uses this for the state DB, and a migration-compatibility test calls it directly. All substantive work is delegated to `open_sqlite`.

*Call graph*: calls 1 internal fn (open_sqlite); called by 2 (init_inner, open_state_sqlite_tolerates_newer_applied_migrations).


##### `open_logs_sqlite`  (lines 376–382)

```
async fn open_logs_sqlite(
    path: &Path,
    migrator: &Migrator,
    telemetry_override: Option<&dyn DbTelemetry>,
) -> anyhow::Result<SqlitePool>
```

**Purpose**: Opens and migrates the dedicated logs database using the shared startup logic. It binds the generic opener to the `LOGS_DB` spec.

**Data flow**: It forwards its path, migrator, and telemetry arguments into `open_sqlite` with `LOGS_DB` and returns the resulting pool.

**Call relations**: `init_inner` calls this after the state DB opens successfully.

*Call graph*: calls 1 internal fn (open_sqlite); called by 1 (init_inner).


##### `open_goals_sqlite`  (lines 384–390)

```
async fn open_goals_sqlite(
    path: &Path,
    migrator: &Migrator,
    telemetry_override: Option<&dyn DbTelemetry>,
) -> anyhow::Result<SqlitePool>
```

**Purpose**: Opens and migrates the goals database using the shared startup logic. It is the goals-specific wrapper around `open_sqlite`.

**Data flow**: It passes its arguments to `open_sqlite` with the `GOALS_DB` spec and returns the resulting pool or error.

**Call relations**: `init_inner` invokes this after the logs DB is ready.

*Call graph*: calls 1 internal fn (open_sqlite); called by 1 (init_inner).


##### `open_memories_sqlite`  (lines 392–398)

```
async fn open_memories_sqlite(
    path: &Path,
    migrator: &Migrator,
    telemetry_override: Option<&dyn DbTelemetry>,
) -> anyhow::Result<SqlitePool>
```

**Purpose**: Opens and migrates the memories database using the shared startup logic. It is used both during full runtime startup and standalone memory cleanup.

**Data flow**: It forwards its path, migrator, and telemetry arguments into `open_sqlite` with `MEMORIES_DB` and returns the resulting pool.

**Call relations**: Both `init_inner` and `clear_memory_data_in_sqlite_home` call this wrapper.

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

**Purpose**: Implements the common open-and-migrate sequence for a runtime SQLite database, including telemetry and error wrapping. It is the low-level startup primitive shared by all four DBs.

**Data flow**: It takes a DB path, migrator, `RuntimeDbSpec`, and optional telemetry sink. It builds connection options from `base_sqlite_options(path)` and adds `auto_vacuum(SqliteAutoVacuum::Incremental)`, then times and executes `SqlitePoolOptions::new().max_connections(5).connect_with(options)`. It records the open result via `crate::telemetry::record_init_result`, wraps open failures in `recovery::RuntimeDbInitError::new(spec.label, "open", path, source)`, then times `migrator.run(&pool)`, records that result too, closes the pool on migration failure, wraps the migration error with the same DB label/path context, and returns the live `SqlitePool` on success.

**Call relations**: All four `open_*_sqlite` wrappers delegate to this function. It is the shared implementation that enforces consistent SQLite settings and telemetry across database types.

*Call graph*: calls 3 internal fn (base_sqlite_options, new, record_init_result); called by 4 (open_goals_sqlite, open_logs_sqlite, open_memories_sqlite, open_state_sqlite); 3 external calls (now, run, new).


##### `ensure_backfill_state_row_in_pool`  (lines 438–464)

```
async fn ensure_backfill_state_row_in_pool(
    pool: &sqlx::SqlitePool,
) -> anyhow::Result<()>
```

**Purpose**: Ensures the singleton `backfill_state` row with `id = 1` exists in the state database. It avoids unnecessary writer contention by checking first whether the row is already present.

**Data flow**: It takes a borrowed `SqlitePool`, runs `SELECT 1 FROM backfill_state WHERE id = 1` via `query_scalar(...).fetch_optional(pool)`, and returns early if a row exists. Otherwise it executes an `INSERT ... ON CONFLICT(id) DO NOTHING` statement binding `1_i64`, `crate::BackfillStatus::Pending.as_str()`, and `Utc::now().timestamp()` for `updated_at`, then returns `Ok(())`.

**Call relations**: `init_inner` calls this after all databases are open and migrated. It is part of startup state seeding before the runtime begins normal operation.

*Call graph*: called by 1 (init_inner); 2 external calls (now, query).


##### `state_db_filename`  (lines 466–468)

```
fn state_db_filename() -> String
```

**Purpose**: Returns the canonical filename for the state database. It exposes the configured constant as an owned `String`.

**Data flow**: It reads `STATE_DB.filename`, converts it with `.to_string()`, and returns the result.

**Call relations**: Callers use this helper when they need the standard state DB filename without reconstructing it from constants.


##### `state_db_path`  (lines 470–472)

```
fn state_db_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the full path to the state database under a Codex home directory. It is the path helper for the main state DB.

**Data flow**: It takes `codex_home: &Path`, calls `STATE_DB.path(codex_home)`, and returns the resulting `PathBuf`.

**Call relations**: Tests and other code use this helper when opening or inspecting the state DB directly.

*Call graph*: called by 2 (open_state_sqlite_tolerates_newer_applied_migrations, sqlite_integrity_check_reports_ok_for_valid_db).


##### `logs_db_filename`  (lines 474–476)

```
fn logs_db_filename() -> String
```

**Purpose**: Returns the canonical filename for the logs database. It exposes the logs DB constant as an owned string.

**Data flow**: It reads `LOGS_DB.filename`, converts it to `String`, and returns it.

**Call relations**: Used by callers that need the standard logs DB filename.


##### `logs_db_path`  (lines 478–480)

```
fn logs_db_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the full path to the logs database under a Codex home directory. It is the path helper for the dedicated log store.

**Data flow**: It takes `codex_home: &Path`, calls `LOGS_DB.path(codex_home)`, and returns the resulting `PathBuf`.

**Call relations**: Other modules can use this helper when they need to inspect or manipulate the logs DB file directly.


##### `goals_db_filename`  (lines 482–484)

```
fn goals_db_filename() -> String
```

**Purpose**: Returns the canonical filename for the goals database. It is a simple accessor over the goals DB spec.

**Data flow**: It reads `GOALS_DB.filename`, converts it to `String`, and returns it.

**Call relations**: Used wherever the standard goals DB filename is needed.


##### `goals_db_path`  (lines 486–488)

```
fn goals_db_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the full path to the goals database under a Codex home directory. It is the path helper for goal persistence.

**Data flow**: It takes `codex_home: &Path`, calls `GOALS_DB.path(codex_home)`, and returns a `PathBuf`.

**Call relations**: Callers use this helper to locate the goals DB file without duplicating filename knowledge.


##### `memories_db_filename`  (lines 490–492)

```
fn memories_db_filename() -> String
```

**Purpose**: Returns the canonical filename for the memories database. It exposes the configured memories DB name as a string.

**Data flow**: It reads `MEMORIES_DB.filename`, converts it with `.to_string()`, and returns it.

**Call relations**: Used by code that needs the standard memories DB filename.


##### `memories_db_path`  (lines 494–496)

```
fn memories_db_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the full path to the memories database under a Codex home directory. It is the path helper for memory persistence.

**Data flow**: It takes `codex_home: &Path`, calls `MEMORIES_DB.path(codex_home)`, and returns the resulting `PathBuf`.

**Call relations**: Maintenance and inspection code can use this helper to locate the memories DB file.


##### `runtime_db_paths`  (lines 498–506)

```
fn runtime_db_paths(codex_home: &Path) -> Vec<RuntimeDbPath>
```

**Purpose**: Returns the labeled paths for all runtime databases under a Codex home directory. It provides a complete inventory of the runtime’s SQLite files.

**Data flow**: It takes `codex_home: &Path`, iterates over the `RUNTIME_DBS` array, maps each `RuntimeDbSpec` into a `RuntimeDbPath { label, path: spec.path(codex_home) }`, collects the results into a `Vec<RuntimeDbPath>`, and returns it.

**Call relations**: Higher-level tooling can call this to enumerate all DB files for backup, diagnostics, or cleanup.


##### `sqlite_integrity_check`  (lines 509–524)

```
async fn sqlite_integrity_check(path: &Path) -> anyhow::Result<Vec<String>>
```

**Purpose**: Runs SQLite’s built-in `PRAGMA integrity_check` against an existing database file and returns all result rows. It is a diagnostic helper for corruption detection.

**Data flow**: It takes a database `&Path`, builds read-only `SqliteConnectOptions` with `create_if_missing(false)` and statement logging disabled, opens a single-connection pool, executes `sqlx::query_scalar::<_, String>("PRAGMA integrity_check").fetch_all(&pool)`, closes the pool, and returns the collected `Vec<String>`.

**Call relations**: A test in this file calls it directly, and operational diagnostics can use it to inspect an on-disk SQLite database without starting the full runtime.

*Call graph*: called by 1 (sqlite_integrity_check_reports_ok_for_valid_db); 2 external calls (new, new).


##### `tests::TestTelemetry::counters`  (lines 558–568)

```
fn counters(&self) -> Vec<MetricEvent>
```

**Purpose**: Returns a snapshot of the telemetry counter events recorded by the test telemetry sink. It clones the stored events so assertions can inspect them without holding the mutex.

**Data flow**: It locks `self.counters: Mutex<Vec<MetricEvent>>`, iterates over the stored events, clones each event’s `name` and `tags` into a new `MetricEvent`, collects them into a `Vec`, and returns that vector.

**Call relations**: The telemetry initialization test calls this after runtime startup to inspect which DB init phases were recorded.


##### `tests::TestTelemetry::counter`  (lines 572–580)

```
fn counter(&self, name: &str, _inc: i64, tags: &[(&str, &str)])
```

**Purpose**: Implements the `DbTelemetry` counter hook for tests by recording each counter event into an in-memory vector. It ignores the increment value and stores only the metric name and tags.

**Data flow**: It receives a metric `name`, an unused increment, and a tag slice, locks the `counters` mutex, converts the tags into a `BTreeMap` via `tags_to_map`, pushes a new `MetricEvent { name: name.to_string(), tags }`, and returns `()`.

**Call relations**: Runtime startup telemetry calls this through the `DbTelemetry` trait when the test passes `TestTelemetry` into `init_with_telemetry_for_tests`.

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

**Purpose**: Implements the `DbTelemetry` duration hook as a no-op for tests. The tests in this file only care about counter events.

**Data flow**: It accepts a metric name, duration, and tags but ignores them all and returns `()` without mutating state.

**Call relations**: This satisfies the `DbTelemetry` trait so `TestTelemetry` can be injected into runtime startup.


##### `tests::tags_to_map`  (lines 591–595)

```
fn tags_to_map(tags: &[(&str, &str)]) -> BTreeMap<String, String>
```

**Purpose**: Converts a slice of telemetry tag pairs into an owned `BTreeMap<String, String>`. It gives tests a stable, comparable representation of metric tags.

**Data flow**: It takes `&[(&str, &str)]`, iterates over the pairs, clones each key and value into owned `String`s, collects them into a `BTreeMap`, and returns it.

**Call relations**: `TestTelemetry::counter` uses this helper when storing incoming telemetry events.


##### `tests::open_db_pool`  (lines 597–605)

```
async fn open_db_pool(path: &Path) -> SqlitePool
```

**Purpose**: Opens a simple SQLite pool for an existing database path in tests. It is a convenience helper for direct migration checks.

**Data flow**: It takes a `&Path`, builds `SqliteConnectOptions` with `create_if_missing(false)`, calls `SqlitePool::connect_with(...)`, awaits the connection, and returns the resulting `SqlitePool`, panicking on failure with `expect`.

**Call relations**: The migration-compatibility test uses this helper to open the state DB with strict settings before running the embedded `STATE_MIGRATOR` directly.

*Call graph*: 2 external calls (new, connect_with).


##### `tests::sqlite_integrity_check_reports_ok_for_valid_db`  (lines 608–633)

```
async fn sqlite_integrity_check_reports_ok_for_valid_db()
```

**Purpose**: Verifies that `sqlite_integrity_check` returns `"ok"` for a valid SQLite database. It exercises the helper against a minimal real database file.

**Data flow**: It creates a unique temp directory, creates the Codex home on disk, derives the state DB path, opens a SQLite DB there, creates a sample table, closes the pool, runs `sqlite_integrity_check(&path)`, asserts the returned vector equals `["ok"]`, and removes the temp directory.

**Call relations**: This Tokio test is invoked by the test runner. It drives the public integrity-check helper end to end against an actual on-disk database.

*Call graph*: calls 3 internal fn (sqlite_integrity_check, state_db_path, unique_temp_dir); 6 external calls (new, connect_with, assert_eq!, query, create_dir_all, remove_dir_all).


##### `tests::open_state_sqlite_tolerates_newer_applied_migrations`  (lines 636–685)

```
async fn open_state_sqlite_tolerates_newer_applied_migrations()
```

**Purpose**: Verifies that the runtime’s tolerant state migrator accepts a database whose migration table contains a newer version than the binary knows about, while the strict embedded migrator rejects it. It protects mixed-version compatibility behavior.

**Data flow**: It creates a temp state DB, applies `STATE_MIGRATOR`, manually inserts a fake future migration row into `_sqlx_migrations`, closes the pool, reopens the DB with `open_db_pool`, runs the strict `STATE_MIGRATOR` and asserts it fails with `MigrateError::VersionMissing(9_999)`, then constructs `runtime_state_migrator()`, opens the DB through `open_state_sqlite`, expects success, closes the tolerant pool, and removes the temp directory.

**Call relations**: This test directly exercises the interaction between `migrations.rs` and `open_state_sqlite`, proving that runtime startup uses the relaxed migration policy rather than SQLx’s strict default.

*Call graph*: calls 3 internal fn (open_state_sqlite, state_db_path, unique_temp_dir); 9 external calls (new, connect_with, assert!, query, open_db_pool, runtime_state_migrator, create_dir_all, remove_dir_all, vec!).


##### `tests::init_records_successful_sqlite_init_phases_to_explicit_telemetry`  (lines 688–727)

```
async fn init_records_successful_sqlite_init_phases_to_explicit_telemetry()
```

**Purpose**: Verifies that runtime initialization emits success telemetry for every expected open, migrate, and post-open phase when an explicit telemetry sink is supplied. It checks the completeness of startup instrumentation.

**Data flow**: It creates a temp directory and a default `TestTelemetry`, initializes the runtime with `StateRuntime::init_with_telemetry_for_tests`, reads back recorded events via `telemetry.counters()`, filters them to `DB_INIT_METRIC` counters with `status=success`, extracts the `phase` tag values into a `BTreeSet`, compares that set against the expected phase names, closes the runtime pools, and removes the temp directory.

**Call relations**: This Tokio test drives the test-only initializer and then inspects the telemetry sink’s recorded counters. It validates the instrumentation performed inside `open_sqlite`, `ensure_backfill_state_row_in_pool`, and the post-init query path.

*Call graph*: calls 2 internal fn (init_with_telemetry_for_tests, unique_temp_dir); 3 external calls (assert_eq!, default, remove_dir_all).


### `state/src/migrations.rs`

`config` · `startup`

This module exposes four static `sqlx::migrate::Migrator` values, one each for the state, logs, goals, and memories databases, using `sqlx::migrate!` to embed migration directories at compile time. Its key behavior is not the static definitions themselves but the `runtime_migrator` helper, which clones the relevant `Migrator` configuration while setting `ignore_missing: true`.

That flag is a deliberate compatibility choice: if an older Codex binary starts against a database whose `_sqlx_migrations` table contains versions newer than the binary knows about, startup should still succeed instead of failing with a "database is ahead of me" error. The implementation preserves all other migration semantics—borrowed migration list, locking mode, transaction behavior, migration table name, and schema-creation settings—so known migrations are still checksum-validated and applied normally. The four public runtime helpers simply specialize this policy for each database family. In practice, runtime initialization code calls these wrappers rather than the strict embedded migrators, allowing concurrent mixed-version binaries to share the same SQLite files more safely.

#### Function details

##### `runtime_migrator`  (lines 16–25)

```
fn runtime_migrator(base: &'static Migrator) -> Migrator
```

**Purpose**: Constructs a `Migrator` copy suitable for runtime startup by reusing an embedded migration set but relaxing the "missing version" check. It preserves all migration metadata except for enabling `ignore_missing`.

**Data flow**: It takes a borrowed static `Migrator` reference, reads its `migrations`, `locking`, `no_tx`, `table_name`, and `create_schemas` fields, wraps the migration slice with `Cow::Borrowed`, and returns a new `Migrator` value whose `ignore_missing` field is forced to `true`.

**Call relations**: This helper is not called directly by startup code; instead the database-specific wrapper functions invoke it to produce tolerant migrators. Those wrappers are then consumed by runtime initialization and maintenance paths that open SQLite databases.

*Call graph*: called by 4 (runtime_goals_migrator, runtime_logs_migrator, runtime_memories_migrator, runtime_state_migrator); 1 external calls (Borrowed).


##### `runtime_state_migrator`  (lines 27–29)

```
fn runtime_state_migrator() -> Migrator
```

**Purpose**: Produces the tolerant runtime migrator for the main state database. It is the state-specific entry point for the compatibility policy implemented in `runtime_migrator`.

**Data flow**: It reads the `STATE_MIGRATOR` static and passes it into `runtime_migrator`, returning the resulting `Migrator` by value.

**Call relations**: This wrapper is used wherever the state DB must be opened under runtime compatibility rules. It delegates all substantive behavior to `runtime_migrator`.

*Call graph*: calls 1 internal fn (runtime_migrator).


##### `runtime_logs_migrator`  (lines 31–33)

```
fn runtime_logs_migrator() -> Migrator
```

**Purpose**: Produces the tolerant runtime migrator for the dedicated logs database. It ensures log DB startup accepts newer-applied migration versions while still validating known ones.

**Data flow**: It takes no arguments, reads `LOGS_MIGRATOR`, and returns `runtime_migrator(&LOGS_MIGRATOR)`.

**Call relations**: Runtime startup calls this before opening the logs SQLite file in `init_inner`. The function itself is only a thin specialization over `runtime_migrator`.

*Call graph*: calls 1 internal fn (runtime_migrator); called by 1 (init_inner).


##### `runtime_goals_migrator`  (lines 35–37)

```
fn runtime_goals_migrator() -> Migrator
```

**Purpose**: Produces the tolerant runtime migrator for the goals database. It applies the same mixed-version startup policy to goal-tracking schema migrations.

**Data flow**: It reads `GOALS_MIGRATOR`, forwards it to `runtime_migrator`, and returns the copied `Migrator`.

**Call relations**: This function is invoked during `init_inner` before opening the goals DB. It exists so callers do not need to know which static migrator corresponds to that database.

*Call graph*: calls 1 internal fn (runtime_migrator); called by 1 (init_inner).


##### `runtime_memories_migrator`  (lines 39–41)

```
fn runtime_memories_migrator() -> Migrator
```

**Purpose**: Produces the tolerant runtime migrator for the memories database. It is used both during full runtime startup and when opening the memories DB for standalone cleanup.

**Data flow**: It reads `MEMORIES_MIGRATOR`, passes it through `runtime_migrator`, and returns the resulting `Migrator`.

**Call relations**: Both `init_inner` and `clear_memory_data_in_sqlite_home` obtain their memories migrator through this wrapper. Like the other wrappers, it delegates the actual policy construction to `runtime_migrator`.

*Call graph*: calls 1 internal fn (runtime_migrator); called by 2 (clear_memory_data_in_sqlite_home, init_inner).


### Recovery and operator guidance
These files handle startup failure recovery for local databases and present CLI-facing guidance when persistence initialization goes wrong.

### `cli/src/state_db_recovery.rs`

`util` · `interactive TUI startup failure handling and recovery`

This file is a narrow support module used only during interactive startup. Its boundary type is `codex_tui::LocalStateDbStartupError`, which the main CLI extracts from a generic `std::io::Error` using `startup_error`. From there, the helpers classify failures into lock contention (`is_locked`), corruption (`is_corruption`), or auto-recoverable cases (`is_auto_backup_recoverable`). Recovery is intentionally conservative: corruption is recoverable, and one additional case is treated as recoverable when the parent `sqlite_home` path is unexpectedly a file instead of a directory, detected by `sqlite_home_is_blocking_file`.

The user-facing functions print distinct guidance for each situation. `print_locked_guidance` tells the user another Codex process is using local data; `print_diagnostic_guidance` points them to `codex doctor`; `print_auto_backup_start` explains that damaged local database files are being moved aside. All three include a shared technical-details block with the failing database path and low-level cause string. `backup_files_for_fresh_start` delegates the actual backup/move operation to `codex_state::backup_runtime_db_for_fresh_start`.

After a successful backup-and-rebuild, `confirm_fresh_start_rebuild` prints the rebuilt database path and backup folder, then either pauses for Enter when stdin and stderr are both terminals or continues automatically in non-interactive environments. `backup_folder` derives the displayed backup directory from the first returned `RuntimeDbBackup`, matching the invariant that all moved files for one recovery attempt live under the same backup folder.

#### Function details

##### `startup_error`  (lines 11–14)

```
fn startup_error(err: &std::io::Error) -> Option<&LocalStateDbStartupError>
```

**Purpose**: Extracts a `LocalStateDbStartupError` reference from a generic I/O error if that is the underlying cause.

**Data flow**: Borrows a `std::io::Error`, reads its inner source via `get_ref()`, attempts `downcast_ref::<LocalStateDbStartupError>()`, and returns `Option<&LocalStateDbStartupError>`.

**Call relations**: Used by `run_interactive_tui` in `main.rs` to decide whether a TUI startup failure should enter the local-state recovery path.

*Call graph*: 1 external calls (get_ref).


##### `is_locked`  (lines 16–18)

```
fn is_locked(detail: &str) -> bool
```

**Purpose**: Classifies a SQLite error-detail string as a lock-contention failure.

**Data flow**: Passes the detail string into `codex_state::sqlite_error_detail_is_lock` and returns the resulting boolean.

**Call relations**: Used by `run_interactive_tui` after extracting a startup error to choose lock-specific guidance.

*Call graph*: 1 external calls (sqlite_error_detail_is_lock).


##### `is_corruption`  (lines 20–22)

```
fn is_corruption(detail: &str) -> bool
```

**Purpose**: Classifies a SQLite error-detail string as corruption.

**Data flow**: Passes the detail string into `codex_state::sqlite_error_detail_is_corruption` and returns the resulting boolean.

**Call relations**: Used by `is_auto_backup_recoverable` as one of the recoverable conditions.

*Call graph*: called by 1 (is_auto_backup_recoverable); 1 external calls (sqlite_error_detail_is_corruption).


##### `is_auto_backup_recoverable`  (lines 24–26)

```
fn is_auto_backup_recoverable(startup_error: &LocalStateDbStartupError) -> bool
```

**Purpose**: Determines whether a startup failure should trigger automatic backup-and-rebuild recovery.

**Data flow**: Borrows `LocalStateDbStartupError`, reads its detail string, and returns true when either `is_corruption(detail)` is true or `sqlite_home_is_blocking_file(startup_error)` detects a file where the SQLite home directory should be.

**Call relations**: Used by `run_interactive_tui` to decide whether to attempt automatic recovery or fall back to diagnostic guidance.

*Call graph*: calls 3 internal fn (is_corruption, sqlite_home_is_blocking_file, detail).


##### `sqlite_home_is_blocking_file`  (lines 28–34)

```
fn sqlite_home_is_blocking_file(startup_error: &LocalStateDbStartupError) -> bool
```

**Purpose**: Detects the special case where the parent directory of the failing database path exists as a regular file.

**Data flow**: Borrows `LocalStateDbStartupError`, gets `database_path()`, walks to its parent, reads filesystem metadata, and returns true when that metadata exists and reports `is_file()`.

**Call relations**: Used only by `is_auto_backup_recoverable`.

*Call graph*: calls 1 internal fn (database_path); called by 1 (is_auto_backup_recoverable).


##### `print_auto_backup_start`  (lines 36–40)

```
fn print_auto_backup_start(startup_error: &LocalStateDbStartupError)
```

**Purpose**: Prints the user-facing explanation shown before damaged local database files are moved aside automatically.

**Data flow**: Borrows `LocalStateDbStartupError`, prints two explanatory stderr lines about damage and rebuilding, then delegates the path/cause block to `print_technical_details`.

**Call relations**: Called by `run_interactive_tui` immediately before attempting `backup_files_for_fresh_start`.

*Call graph*: calls 1 internal fn (print_technical_details); 1 external calls (eprintln!).


##### `backup_files_for_fresh_start`  (lines 42–46)

```
async fn backup_files_for_fresh_start(
    startup_error: &LocalStateDbStartupError,
) -> std::io::Result<Vec<RuntimeDbBackup>>
```

**Purpose**: Moves the failing runtime database files aside so Codex can rebuild fresh local state.

**Data flow**: Borrows `LocalStateDbStartupError`, reads its `database_path()`, and awaits `codex_state::backup_runtime_db_for_fresh_start`, returning the resulting `Vec<RuntimeDbBackup>` or I/O error.

**Call relations**: Called by `run_interactive_tui` during automatic recovery and by tests that verify backup behavior.

*Call graph*: calls 1 internal fn (database_path); called by 2 (backup_backs_up_only_failed_database_file, backup_replaces_blocking_sqlite_home_file); 1 external calls (backup_runtime_db_for_fresh_start).


##### `confirm_fresh_start_rebuild`  (lines 48–71)

```
fn confirm_fresh_start_rebuild(
    startup_error: &LocalStateDbStartupError,
    backups: &[RuntimeDbBackup],
) -> std::io::Result<()>
```

**Purpose**: Prints the post-recovery confirmation message and optionally pauses for Enter before startup continues.

**Data flow**: Borrows the startup error and backup list, prints that the local database was rebuilt, prints the database path and backup folder (via `backup_folder` or `unavailable`), then checks whether stdin and stderr are terminals. In a terminal it prompts `Press Enter to continue.` and reads one line from stdin; otherwise it prints that startup is continuing automatically. Returns `std::io::Result<()>`.

**Call relations**: Called by `run_interactive_tui` after a successful backup-and-rebuild so the user sees what happened before the TUI retries startup.

*Call graph*: calls 1 internal fn (backup_folder); 4 external calls (new, eprintln!, stderr, stdin).


##### `print_diagnostic_guidance`  (lines 73–78)

```
fn print_diagnostic_guidance(startup_error: &LocalStateDbStartupError)
```

**Purpose**: Prints the fallback guidance for unrecoverable local database startup failures.

**Data flow**: Borrows `LocalStateDbStartupError`, prints stderr lines explaining that the database appears damaged, recommends `codex doctor`, asks the user to share technical details when seeking help, and then prints the shared technical-details block.

**Call relations**: Called by `run_interactive_tui` when corruption is not auto-recoverable or when automatic backup itself fails.

*Call graph*: calls 1 internal fn (print_technical_details); 1 external calls (eprintln!).


##### `print_locked_guidance`  (lines 80–84)

```
fn print_locked_guidance(startup_error: &LocalStateDbStartupError)
```

**Purpose**: Prints the guidance shown when startup fails because another Codex process is holding the local database lock.

**Data flow**: Borrows `LocalStateDbStartupError`, prints stderr lines explaining that another Codex process is using local data and should be quit, then prints the shared technical-details block.

**Call relations**: Called by `run_interactive_tui` when `is_locked` is true.

*Call graph*: calls 1 internal fn (print_technical_details); 1 external calls (eprintln!).


##### `print_technical_details`  (lines 86–90)

```
fn print_technical_details(startup_error: &LocalStateDbStartupError)
```

**Purpose**: Prints the common low-level path and cause details for local database startup failures.

**Data flow**: Borrows `LocalStateDbStartupError`, prints `Technical details:`, then prints the database location and the raw cause string from `detail()`.

**Call relations**: Shared by the auto-backup, diagnostic, and locked guidance printers.

*Call graph*: called by 3 (print_auto_backup_start, print_diagnostic_guidance, print_locked_guidance); 1 external calls (eprintln!).


##### `backup_folder`  (lines 92–94)

```
fn backup_folder(backups: &[RuntimeDbBackup]) -> Option<&Path>
```

**Purpose**: Returns the parent directory of the first backup path, which is used as the displayed backup folder for a recovery attempt.

**Data flow**: Borrows a slice of `RuntimeDbBackup`, takes the first element if present, and returns `backup_path.parent()` as `Option<&Path>`.

**Call relations**: Used by `confirm_fresh_start_rebuild`; tests verify the derived folder path.

*Call graph*: called by 1 (confirm_fresh_start_rebuild); 1 external calls (first).


##### `tests::backup_backs_up_only_failed_database_file`  (lines 104–126)

```
async fn backup_backs_up_only_failed_database_file() -> std::io::Result<()>
```

**Purpose**: Verifies that recovery backs up only the specific failed database file and leaves unrelated runtime DB files intact.

**Data flow**: Creates a temp SQLite home, writes both state and logs DB files, constructs a `LocalStateDbStartupError` for the logs DB, calls `backup_files_for_fresh_start`, and asserts that only the failed DB path appears in backups, the failed file is gone, the state DB remains, and the backup file exists.

**Call relations**: Tests `backup_files_for_fresh_start` against the normal corruption case.

*Call graph*: calls 2 internal fn (backup_files_for_fresh_start, new); 6 external calls (new, assert!, assert_eq!, logs_db_path, state_db_path, write).


##### `tests::backup_replaces_blocking_sqlite_home_file`  (lines 129–145)

```
async fn backup_replaces_blocking_sqlite_home_file() -> std::io::Result<()>
```

**Purpose**: Verifies recovery when the SQLite home path is blocked by a regular file instead of a directory.

**Data flow**: Creates a temp path where `sqlite-home` is a file, constructs a startup error for a DB path under that file path, asserts `is_auto_backup_recoverable`, calls `backup_files_for_fresh_start`, and then asserts the path has become a directory and the backup exists.

**Call relations**: Tests the special blocking-file recovery path recognized by `sqlite_home_is_blocking_file`.

*Call graph*: calls 2 internal fn (backup_files_for_fresh_start, new); 5 external calls (new, assert!, assert_eq!, state_db_path, write).


##### `tests::backup_folder_uses_parent_of_first_backup_path`  (lines 148–158)

```
fn backup_folder_uses_parent_of_first_backup_path()
```

**Purpose**: Verifies that the displayed backup folder is derived from the first backup entry’s parent directory.

**Data flow**: Constructs a one-element `Vec<RuntimeDbBackup>`, calls `backup_folder`, and asserts the returned path equals the parent directory of the backup path.

**Call relations**: Direct unit test for `backup_folder`.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `state/src/runtime/recovery.rs`

`util` · `startup error handling and corruption recovery`

This file is the runtime’s SQLite recovery utility layer. `RuntimeDbInitError` wraps initialization failures with a database label, operation name, path, and source error so later code can recover the exact database path that failed. The helper `runtime_db_path_for_corruption_error` walks an `anyhow::Error` chain, first requiring that some source looks like SQLite corruption, then extracting the embedded `RuntimeDbInitError` path if present.

Corruption detection is intentionally broad. `is_sqlite_corruption_error` scans the error chain and delegates each source to `sqlite_error_source_is_corruption`, which recognizes `sqlx::Error::Database` values whose message or SQLite code indicates corruption. Both textual details (`database disk image is malformed`, `file is not a database`, `sqlite_corrupt`, `(code: 11)`, etc.) and numeric/string codes (`11`, `26`, `sqlite_corrupt`, `sqlite_notadb`) are accepted. A separate helper detects lock/busy messages.

Backup logic distinguishes two cases. `backup_runtime_db_for_fresh_start` normally backs up only the target database and its `-wal`/`-shm` sidecars by calling `backup_runtime_db_files`; if the supposed SQLite home path exists but is not a directory, it instead moves that blocking path aside wholesale with `backup_blocking_sqlite_home` and recreates the directory. Backups are placed under uniquely named timestamped directories created by `create_unique_backup_dir`. `backup_sqlite_paths` renames only files that actually exist and removes the empty backup directory if nothing was found. The result is a `Vec<RuntimeDbBackup>` mapping original paths to backup destinations.

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

**Purpose**: Constructs a structured initialization error that records which runtime database operation failed and at what path. This preserves enough context for later corruption recovery.

**Data flow**: Consumes static `label` and `operation` strings, a `&Path`, and an `anyhow::Error`, clones the path with `to_path_buf`, and returns `RuntimeDbInitError`.

**Call relations**: Called by database-opening code when wrapping initialization failures so later helpers can recover the failing path from the error chain.

*Call graph*: called by 2 (open_sqlite, runtime_db_path_for_corruption_error_ignores_corrupt_word_in_path); 1 external calls (to_path_buf).


##### `RuntimeDbInitError::path`  (lines 45–47)

```
fn path(&self) -> &Path
```

**Purpose**: Returns the stored database path as a borrowed `&Path`. It is a small accessor used during error-chain inspection.

**Data flow**: Reads `self.path` and returns `self.path.as_path()`.

**Call relations**: Used by `runtime_db_path_for_corruption_error` after downcasting an error-chain source to `RuntimeDbInitError`.

*Call graph*: 1 external calls (as_path).


##### `RuntimeDbInitError::fmt`  (lines 51–60)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats the initialization error with operation, label, path, and source message for human-readable diagnostics. The output is suitable for logs and surfaced errors.

**Data flow**: Reads the struct fields and writes a formatted string into the provided formatter.

**Call relations**: This powers the standard `Display` representation of `RuntimeDbInitError` when it appears in error chains.

*Call graph*: 1 external calls (write!).


##### `RuntimeDbInitError::source`  (lines 64–66)

```
fn source(&self) -> Option<&(dyn std::error::Error + 'static)>
```

**Purpose**: Exposes the wrapped underlying error as the standard error source. This keeps the original failure in the error chain.

**Data flow**: Returns `Some(self.source.as_ref())` as `&(dyn Error + 'static)`.

**Call relations**: This enables `anyhow::Error::chain()` traversal used by the corruption-detection helpers.

*Call graph*: 1 external calls (as_ref).


##### `backup_runtime_db_for_fresh_start`  (lines 71–92)

```
async fn backup_runtime_db_for_fresh_start(
    db_path: &Path,
) -> std::io::Result<Vec<RuntimeDbBackup>>
```

**Purpose**: Moves the affected runtime database out of the way so it can be recreated cleanly, backing up either the database file set or an invalid blocking SQLite-home path. It also creates the SQLite home directory if it was missing.

**Data flow**: Consumes `db_path`, derives `sqlite_home = db_path.parent()`, errors if there is no parent, then inspects `tokio::fs::metadata(sqlite_home)`. If the parent exists and is a directory it delegates to `backup_runtime_db_files`; if it exists but is not a directory it delegates to `backup_blocking_sqlite_home`; if it does not exist it creates the directory and returns an error saying no files were found; other metadata errors are propagated. Returns a vector of `RuntimeDbBackup` records on success.

**Call relations**: This is the top-level recovery action invoked after corruption is detected and the failing DB path is known.

*Call graph*: calls 2 internal fn (backup_blocking_sqlite_home, backup_runtime_db_files); 5 external calls (parent, other, format!, create_dir_all, metadata).


##### `runtime_db_path_for_corruption_error`  (lines 94–101)

```
fn runtime_db_path_for_corruption_error(err: &anyhow::Error) -> Option<PathBuf>
```

**Purpose**: Extracts the failing runtime database path from an `anyhow::Error` chain, but only when the chain also indicates SQLite corruption. Non-corruption errors return `None` even if they contain a `RuntimeDbInitError`.

**Data flow**: Consumes `&anyhow::Error`, first calls `is_sqlite_corruption_error`; if false returns `None`. Otherwise it walks `err.chain()`, finds the first source downcastable to `RuntimeDbInitError`, and returns a cloned `PathBuf` from its `path()` accessor.

**Call relations**: Used by higher-level startup recovery logic to decide which database file should be backed up after an initialization failure.

*Call graph*: calls 1 internal fn (is_sqlite_corruption_error); 1 external calls (chain).


##### `is_sqlite_corruption_error`  (lines 103–105)

```
fn is_sqlite_corruption_error(err: &anyhow::Error) -> bool
```

**Purpose**: Determines whether any source in an `anyhow::Error` chain looks like a SQLite corruption error. It is the broad corruption predicate used before attempting recovery.

**Data flow**: Consumes `&anyhow::Error`, iterates `err.chain()`, and returns true if any source satisfies `sqlite_error_source_is_corruption`.

**Call relations**: Called by `runtime_db_path_for_corruption_error` and potentially other recovery decisions that need to distinguish corruption from unrelated failures.

*Call graph*: called by 1 (runtime_db_path_for_corruption_error); 1 external calls (chain).


##### `sqlite_error_source_is_corruption`  (lines 107–118)

```
fn sqlite_error_source_is_corruption(source: &(dyn std::error::Error + 'static)) -> bool
```

**Purpose**: Checks one error source for SQLite corruption by downcasting to `sqlx::Error::Database` and inspecting both message text and SQLite error code. Non-SQLx or non-database errors are ignored.

**Data flow**: Consumes a trait-object error source, attempts `downcast_ref::<sqlx::Error>()`, requires the `Database` variant, then returns true if `sqlite_error_detail_is_corruption(database_error.message())` or the optional code satisfies `sqlite_database_code_is_corruption`.

**Call relations**: Used internally by `is_sqlite_corruption_error` while scanning an error chain.

*Call graph*: calls 1 internal fn (sqlite_error_detail_is_corruption).


##### `sqlite_database_code_is_corruption`  (lines 120–125)

```
fn sqlite_database_code_is_corruption(code: Cow<'_, str>) -> bool
```

**Purpose**: Recognizes SQLite corruption/not-a-database codes in either numeric or symbolic string form. Matching is case-insensitive.

**Data flow**: Consumes a `Cow<'_, str>`, lowercases it, and returns true for `11`, `26`, `sqlite_corrupt`, or `sqlite_notadb`.

**Call relations**: Called by `sqlite_error_source_is_corruption` when a SQLx database error exposes a code.

*Call graph*: 1 external calls (matches!).


##### `sqlite_error_detail_is_corruption`  (lines 127–137)

```
fn sqlite_error_detail_is_corruption(detail: &str) -> bool
```

**Purpose**: Recognizes corruption-related SQLite error messages by substring matching. It accepts both canonical SQLite phrases and embedded code strings.

**Data flow**: Consumes an error-detail string, lowercases it, and returns true if it contains any known corruption/not-a-database phrase or code marker.

**Call relations**: Used by `sqlite_error_source_is_corruption` as the message-text half of corruption detection.

*Call graph*: called by 1 (sqlite_error_source_is_corruption).


##### `sqlite_error_detail_is_lock`  (lines 139–142)

```
fn sqlite_error_detail_is_lock(detail: &str) -> bool
```

**Purpose**: Recognizes SQLite lock/busy messages by substring matching. This is separate from corruption detection.

**Data flow**: Consumes an error-detail string, lowercases it, and returns true if it contains `database is locked` or `database is busy`.

**Call relations**: This helper is available to callers that need to distinguish transient lock contention from corruption.


##### `backup_runtime_db_files`  (lines 144–152)

```
async fn backup_runtime_db_files(db_path: &Path) -> std::io::Result<Vec<RuntimeDbBackup>>
```

**Purpose**: Backs up one runtime database file plus its `-wal` and `-shm` sidecars into a unique backup directory. It requires the database path to have a parent directory.

**Data flow**: Consumes `db_path`, derives `sqlite_home = db_path.parent()`, builds the three candidate paths with `sqlite_paths(db_path)`, and delegates to `backup_sqlite_paths(sqlite_home, ...)`, returning the resulting backup records.

**Call relations**: Called by `backup_runtime_db_for_fresh_start` in the normal case where the SQLite home exists as a directory.

*Call graph*: calls 2 internal fn (backup_sqlite_paths, sqlite_paths); called by 1 (backup_runtime_db_for_fresh_start); 1 external calls (parent).


##### `backup_sqlite_paths`  (lines 154–180)

```
async fn backup_sqlite_paths(
    sqlite_home: &Path,
    paths: impl IntoIterator<Item = PathBuf>,
) -> std::io::Result<Vec<RuntimeDbBackup>>
```

**Purpose**: Moves a provided set of SQLite-related paths into a newly created unique backup directory, recording original and backup locations. If none of the candidate paths exist, it removes the empty backup directory and returns an error.

**Data flow**: Consumes `sqlite_home` and an iterator of `PathBuf`s, creates a unique backup directory under `sqlite_home/db-backups`, loops over each path, checks `try_exists`, renames existing files into the backup directory using `file_name` for the destination name, and pushes `RuntimeDbBackup` entries. If no files were moved it removes the backup directory and returns an `io::Error::other`; otherwise it returns the backup vector.

**Call relations**: This is the shared implementation behind file-set backup, called by `backup_runtime_db_files`.

*Call graph*: calls 2 internal fn (create_unique_backup_dir, file_name); called by 1 (backup_runtime_db_files); 6 external calls (join, new, other, remove_dir, rename, try_exists).


##### `backup_blocking_sqlite_home`  (lines 182–200)

```
async fn backup_blocking_sqlite_home(sqlite_home: &Path) -> std::io::Result<Vec<RuntimeDbBackup>>
```

**Purpose**: Backs up an invalid path occupying the SQLite home location when that path is not a directory, then recreates the SQLite home directory. This recovers from a filesystem obstacle rather than a corrupt DB file set.

**Data flow**: Consumes `sqlite_home`, derives its parent, constructs a sibling backup-parent name like `<sqlite_home>.db-backups`, creates a unique backup directory there, renames the blocking path into that directory under its original file name, recreates `sqlite_home` as a directory, and returns one `RuntimeDbBackup` describing the move.

**Call relations**: Called by `backup_runtime_db_for_fresh_start` when the expected SQLite home exists but is not a directory.

*Call graph*: calls 2 internal fn (create_unique_backup_dir, file_name); called by 1 (backup_runtime_db_for_fresh_start); 5 external calls (parent, format!, create_dir_all, rename, vec!).


##### `sqlite_paths`  (lines 202–212)

```
fn sqlite_paths(db_path: &Path) -> Vec<PathBuf>
```

**Purpose**: Builds the standard SQLite file set for one database path: the main file plus `-wal` and `-shm` sidecars. This defines what gets backed up together.

**Data flow**: Consumes `db_path`, appends `-wal` and `-shm` to its OS string, and returns a `Vec<PathBuf>` containing the main path and both sidecar paths.

**Call relations**: Used by `backup_runtime_db_files` before delegating to `backup_sqlite_paths`.

*Call graph*: called by 1 (backup_runtime_db_files); 2 external calls (as_os_str, vec!).


##### `create_unique_backup_dir`  (lines 214–230)

```
async fn create_unique_backup_dir(backup_parent: &Path) -> std::io::Result<PathBuf>
```

**Purpose**: Creates a timestamped backup directory under a given parent, retrying with an incrementing sequence number until it finds an unused name. This avoids collisions across repeated recovery attempts.

**Data flow**: Consumes `backup_parent`, ensures the parent directory exists, computes a Unix-seconds timestamp from `SystemTime::now()`, then loops creating `sqlite-<timestamp>-<sequence>` directories until `create_dir` succeeds or a non-AlreadyExists error occurs. Returns the created `PathBuf`.

**Call relations**: Called by both `backup_sqlite_paths` and `backup_blocking_sqlite_home` to allocate a unique destination directory.

*Call graph*: called by 2 (backup_blocking_sqlite_home, backup_sqlite_paths); 5 external calls (join, format!, now, create_dir, create_dir_all).


##### `file_name`  (lines 232–239)

```
fn file_name(path: &Path) -> std::io::Result<&std::ffi::OsStr>
```

**Purpose**: Returns the final path component needed to preserve original file names inside backup directories. It errors when the path has no file name.

**Data flow**: Consumes `&Path`, calls `path.file_name()`, and returns the `&OsStr` or an `io::Error::other` describing the invalid path.

**Call relations**: Used by both backup implementations when constructing destination paths inside the backup directory.

*Call graph*: called by 2 (backup_blocking_sqlite_home, backup_sqlite_paths); 1 external calls (file_name).

## 📊 State Registers Touched

- `reg-codex-home-and-install-context` — The discovered home folder, install layout, bundled asset locations, and helper binary paths used across the app.
- `reg-state-runtime` — The shared runtime object holding opened local databases and services for state, logs, goals, and memories.
- `reg-sqlite-datastores` — The app’s on-disk SQLite databases that keep runtime metadata, queues, goals, logs, and related records.
- `reg-thread-store-and-rollout-history` — The durable record of threads, conversation items, and rollout history that lets sessions be resumed and replayed.
- `reg-thread-metadata-index` — The searchable metadata index for threads, including names, archive state, links, and sync status.
- `reg-memory-store-and-pipeline` — The stored memories and background memory-processing pipeline that extract and reuse important facts.
- `reg-rollout-trace-log` — The detailed saved raw event log that can later be replayed into a readable timeline.
- `reg-goals-store-and-state` — The persisted and live per-thread goal data, including goal records shown in UI and reused across session resume and later turns.
