# SQLite runtime state and agent graph storage  `stage-21.2`

This stage is the system’s long-term memory. It sits behind the scenes and saves the facts the rest of the system needs between runs, using SQLite, a small built-in database stored in a file. The main entry point is state/src/lib.rs, which exposes the storage runtime and shared types.

Several files define the shapes of stored records: thread_metadata, thread_goal, agent_job, backfill_state, and log turn raw database rows into checked, typed objects the rest of the code can trust. The runtime files do the real work. threads.rs stores thread details, lists threads, and records parent/child spawn links. goals.rs keeps each thread’s goals, versions, and usage counts. memories.rs runs the multi-step memory pipeline and tracks retention and pollution rules. agent_jobs.rs saves job batches and item progress. backfill.rs tracks a one-off repair worker that fills in missing rollout metadata. remote_control.rs stores remote-control enrollment records, and external_agent_config_imports.rs keeps import history. audit.rs is a safe read-only window for diagnostics.

The agent-graph-store crate adds a clean interface for saving and querying spawn relationships. store.rs defines the contract, error.rs defines shared errors, local.rs connects that contract to the SQLite state runtime, and lib.rs re-exports the public pieces.

## Files in this stage

### State crate surface
These files define the public entry points for the SQLite-backed state subsystem and its read-only audit access.

### `state/src/audit.rs`

`io_transport` · `diagnostics`

This file is deliberately narrow in scope: it defines `ThreadStateAuditRow`, a compact struct containing the persisted thread ID, rollout path, archived flag, source, and model provider, and one async function that reads those rows from the `threads` table. The query path is explicitly non-invasive. `read_thread_state_audit_rows` builds `SqliteConnectOptions` with `create_if_missing(false)` and `read_only(true)`, disables SQL statement logging, and opens a pool with `max_connections(1)` so the audit path does not create extra concurrency or side effects.

It then executes a fixed `SELECT id, rollout_path, archived, source, model_provider FROM threads`, fetches all rows, closes the pool, and maps each SQL row into `ThreadStateAuditRow`. The `archived` column is read as `i64` and normalized to a Rust `bool` by comparing against zero, while `rollout_path` is read as a `String` and converted into `PathBuf`. Because the function uses `anyhow::Result`, SQL and conversion failures propagate directly. There is no migration, repair, or schema creation logic here by design; if the database is missing or malformed, the caller gets an error instead of this function attempting to fix anything.

#### Function details

##### `read_thread_state_audit_rows`  (lines 23–55)

```
async fn read_thread_state_audit_rows(path: &Path) -> Result<Vec<ThreadStateAuditRow>>
```

**Purpose**: Opens an existing SQLite state database in read-only mode and returns all persisted thread rows as simplified audit records. It avoids creating, migrating, or repairing the database.

**Data flow**: It takes a filesystem `&Path`, builds `SqliteConnectOptions` pointing at that file with `create_if_missing(false)`, `read_only(true)`, and statement logging disabled, then opens a single-connection pool. It runs a fixed SQL query against `threads`, awaits all rows, closes the pool, converts each row into `ThreadStateAuditRow` by extracting typed columns and converting `rollout_path` into `PathBuf` and `archived` into `bool`, and collects the mapped results into `Vec<ThreadStateAuditRow>`.

**Call relations**: This file contains only this top-level audit query; callers use it when they need diagnostics from persisted state without invoking the normal runtime initialization path.

*Call graph*: 3 external calls (new, new, query).


### `state/src/lib.rs`

`orchestration` · `startup/configuration and cross-cutting access to state APIs throughout runtime`

This file establishes the public contract of the `state` crate. At the top it enforces a hard compile-time invariant on the bundled SQLite version with an `assert!` against `libsqlite3_sys::SQLITE_VERSION_NUMBER`, requiring at least `3_051_003` because the crate depends on the WAL-reset corruption fix. That check is a notable safety measure: builds fail early rather than allowing a subtly unsafe SQLite runtime.

The module declarations divide the crate into audit reading, rollout extraction, log database access, schema migrations, shared models, path helpers, runtime orchestration, and telemetry. The file then re-exports a broad set of types so downstream code can treat the crate root as the stable API: low-level row/query structs like `LogEntry`, `LogRow`, and `LogQuery`; rollout and thread metadata models; stage-1 and phase-2 memory job claim types; agent job records; and the preferred high-level entrypoint `StateRuntime`. It also exposes runtime helpers for locating database files, backing up a corrupted runtime DB, checking SQLite corruption/lock errors, and running integrity checks, plus telemetry installation and metric-recording functions.

Finally, it defines the environment variable `SQLITE_HOME_ENV`, canonical filenames for the logs/goals/memories/state databases, and metric name constants for DB errors, backfill, initialization, and fallback paths. Those constants centralize naming so the rest of the crate and external callers use consistent filesystem and observability identifiers.


### Thread graph foundation
These files establish the core thread metadata model and the runtime layer that persists threads and spawn-edge relationships.

### `state/src/model/thread_metadata.rs`

`data_model` · `cross-cutting`

This module is the central data-model layer for thread discovery and indexing. It defines pagination types (`SortKey`, `SortDirection`, `Anchor`, `ThreadsPage`), extraction output (`ExtractionOutcome`), and the full `ThreadMetadata` record containing identifiers, rollout path, timestamps, source classification, agent annotations, model/provider details, working directory, title/preview text, sandbox and approval modes, token usage, archive time, and Git metadata.

`ThreadMetadataBuilder` exists for constructing canonical metadata from rollout parsing without requiring filename-derived defaults. Its `new` method seeds sensible defaults such as empty `cwd`, read-only sandbox policy, `OnRequest` approval mode, and absent optional fields. `build` then stringifies protocol enums, canonicalizes timestamps to the same precision used in storage, fills `updated_at` from `created_at` when absent, derives `agent_path` from the session source if not explicitly set, and falls back to the runtime’s default provider.

The file also contains reconciliation helpers: `prefer_existing_git_info` preserves already-known Git fields, while `prefer_existing_explicit_title` avoids overwriting a user-edited title with a generated one that merely mirrors the first user message. `diff_fields` enumerates exactly which fields differ between two metadata records for diagnostics or selective updates.

On the storage side, `ThreadRow::try_from_row` extracts raw SQL columns and `TryFrom<ThreadRow> for ThreadMetadata` performs semantic decoding: parsing `ThreadId`, optional `ThreadSource`, optional `ReasoningEffort`, converting paths, treating empty `preview` and `first_user_message` strings as `None`, and decoding timestamps. The timestamp helpers include a compatibility rule in `epoch_millis_to_datetime`: values older than a 2020 millisecond threshold are treated as legacy second-precision rows and multiplied by 1000 in memory so old databases continue to sort correctly after newer writes use milliseconds.

#### Function details

##### `ThreadMetadataBuilder::new`  (lines 155–181)

```
fn new(
        id: ThreadId,
        rollout_path: PathBuf,
        created_at: DateTime<Utc>,
        source: SessionSource,
    ) -> Self
```

**Purpose**: Creates a builder for rollout-derived thread metadata with required identity fields and a full set of defaults for optional metadata. It establishes the baseline values later normalized by `build`.

**Data flow**: It takes a `ThreadId`, rollout `PathBuf`, creation `DateTime<Utc>`, and `SessionSource`, then returns a `ThreadMetadataBuilder` with those fields set, `updated_at` and most optional metadata absent, `cwd` initialized to an empty `PathBuf`, `sandbox_policy` set via `SandboxPolicy::new_read_only_policy()`, and `approval_mode` set to `AskForApproval::OnRequest`.

**Call relations**: Many tests and metadata ingestion paths call this as the first step before filling optional fields and invoking `build`. It does not perform persistence itself; it prepares normalized construction inputs.

*Call graph*: called by 35 (test_thread_metadata, seed_stage1_output, thread_list_parent_filter_reads_direct_children_from_state_db, seed_recent_thread, upsert_thread_metadata, seed_thread_metadata, seed_stage1_candidate, seed_stage1_output, builder_from_items, builder_from_session_meta (+15 more)); 2 external calls (new, new_read_only_policy).


##### `ThreadMetadataBuilder::build`  (lines 184–225)

```
fn build(&self, default_provider: &str) -> ThreadMetadata
```

**Purpose**: Builds a canonical `ThreadMetadata` from the builder, filling defaults and normalizing timestamps and enum fields. It is the main constructor used after rollout parsing.

**Data flow**: It reads the builder fields plus a `default_provider: &str`, converts `source`, `sandbox_policy`, and `approval_mode` to strings via `crate::extract::enum_to_string`, canonicalizes `created_at` and optional `updated_at`, derives `updated_at` from `created_at` when missing, clones optional metadata fields, derives `agent_path` from `self.source.get_agent_path()` if no explicit path is set, falls back to `default_provider.to_string()` when `model_provider` is absent, and returns a `ThreadMetadata` with unset runtime-observed fields like `model`, `reasoning_effort`, `preview`, and `first_user_message` initialized to `None` or empty values.

**Call relations**: Callers use this after populating a `ThreadMetadataBuilder`. Internally it delegates timestamp normalization to `canonicalize_datetime` so in-memory values match storage precision.

*Call graph*: calls 2 internal fn (enum_to_string, canonicalize_datetime); 2 external calls (clone, new).


##### `ThreadMetadata::prefer_existing_git_info`  (lines 230–240)

```
fn prefer_existing_git_info(&mut self, existing: &Self)
```

**Purpose**: Preserves already-known Git metadata when reconciling newly extracted rollout metadata with an existing stored record. It only copies fields from the existing record when they are present.

**Data flow**: It mutably borrows `self` and immutably borrows `existing`, checks `existing.git_sha`, `existing.git_branch`, and `existing.git_origin_url` for `Some`, and overwrites the corresponding fields on `self` with cloned values when present.

**Call relations**: Reconciliation code calls this before upserting refreshed metadata so rollout-derived updates do not erase Git information that may have been captured earlier from another source.


##### `ThreadMetadata::prefer_existing_explicit_title`  (lines 243–255)

```
fn prefer_existing_explicit_title(&mut self, existing: &Self)
```

**Purpose**: Keeps a user-meaningful existing title when the newly derived title is empty or merely duplicates the first user message. It distinguishes explicit titles from generated placeholders.

**Data flow**: It trims `existing.title` and returns early if that title is empty or equal to `existing.first_user_message` after trimming, because such a title is not considered explicitly meaningful. Otherwise it trims `self.title`; if the new title is empty or equals `self.first_user_message`, it replaces `self.title` with `existing.title.clone()`.

**Call relations**: Metadata merge paths use this after extracting fresh rollout metadata. It complements `prefer_existing_git_info` by preserving user-facing presentation data rather than repository metadata.


##### `ThreadMetadata::diff_fields`  (lines 258–330)

```
fn diff_fields(&self, other: &Self) -> Vec<&'static str>
```

**Purpose**: Computes a field-by-field difference list between two `ThreadMetadata` values. It is intended for diagnostics, reconciliation decisions, or selective update reporting.

**Data flow**: It compares `self` and `other` across all modeled fields, pushes the corresponding field name string into a mutable `Vec<&'static str>` whenever a value differs, and returns that vector in comparison order.

**Call relations**: Higher-level synchronization or debugging code can call this to explain why two metadata records are not equal. It is a pure comparison helper with no side effects.

*Call graph*: 1 external calls (new).


##### `canonicalize_datetime`  (lines 333–335)

```
fn canonicalize_datetime(dt: DateTime<Utc>) -> DateTime<Utc>
```

**Purpose**: Normalizes a UTC datetime to the precision and conversion behavior used by persisted thread timestamps. It round-trips through epoch milliseconds and falls back to the original value if conversion unexpectedly fails.

**Data flow**: It takes a `DateTime<Utc>`, converts it to milliseconds with `datetime_to_epoch_millis`, feeds that into `epoch_millis_to_datetime`, and returns the normalized datetime or the original input if the conversion returns an error.

**Call relations**: `ThreadMetadataBuilder::build` uses this for `created_at`, `updated_at`, and `archived_at` so constructed metadata matches the same timestamp semantics used when reading from SQLite.

*Call graph*: calls 2 internal fn (datetime_to_epoch_millis, epoch_millis_to_datetime); called by 1 (build).


##### `ThreadRow::try_from_row`  (lines 366–393)

```
fn try_from_row(row: &SqliteRow) -> Result<Self>
```

**Purpose**: Extracts raw thread metadata columns from a SQLite row into a `ThreadRow`. It is the low-level storage decoding step before semantic parsing.

**Data flow**: It borrows a `SqliteRow`, reads each named column with `try_get`, and returns a `ThreadRow` containing strings, integers, and optional values exactly as stored in the database.

**Call relations**: Query code uses this immediately after SQL execution. The resulting `ThreadRow` is then passed into `ThreadMetadata::try_from` for typed conversion.

*Call graph*: 1 external calls (try_get).


##### `ThreadMetadata::try_from`  (lines 399–457)

```
fn try_from(row: ThreadRow) -> std::result::Result<Self, Self::Error>
```

**Purpose**: Converts a raw `ThreadRow` into a validated `ThreadMetadata`. It parses IDs and enums, converts timestamps and paths, and normalizes empty-string sentinel values into `None`.

**Data flow**: It consumes a `ThreadRow`, destructures all fields, parses optional `thread_source` strings with `.parse()` and wraps parse failures as `anyhow::Error::msg`, converts `id` with `ThreadId::try_from`, converts `rollout_path` and `cwd` into `PathBuf`, decodes `created_at` and `updated_at` with `epoch_millis_to_datetime`, parses `reasoning_effort` with `value.parse::<ReasoningEffort>().ok()` so unknown values become `ReasoningEffort::Custom` if the parser supports them or `None` otherwise, turns empty `preview` and `first_user_message` strings into `None`, converts optional `archived_at` seconds with `epoch_seconds_to_datetime`, and returns the assembled `ThreadMetadata`.

**Call relations**: Tests in this file call it directly to verify reasoning-effort parsing, and production query paths use it after `ThreadRow::try_from_row`. It is the semantic boundary between SQL rows and the canonical metadata model.

*Call graph*: calls 2 internal fn (try_from, epoch_millis_to_datetime); called by 2 (thread_row_parses_reasoning_effort, thread_row_preserves_model_defined_reasoning_effort_values); 1 external calls (from).


##### `anchor_from_item`  (lines 460–466)

```
fn anchor_from_item(item: &ThreadMetadata, sort_key: SortKey) -> Option<Anchor>
```

**Purpose**: Builds a pagination anchor from a thread metadata item using the selected sort key. It extracts the timestamp component needed for keyset pagination.

**Data flow**: It reads a borrowed `ThreadMetadata` and a `SortKey`, selects either `item.created_at` or `item.updated_at`, wraps that timestamp in `Anchor { ts }`, and returns `Some(anchor)`.

**Call relations**: Thread listing code uses this when producing `ThreadsPage.next_anchor` values for subsequent page requests.


##### `datetime_to_epoch_millis`  (lines 468–470)

```
fn datetime_to_epoch_millis(dt: DateTime<Utc>) -> i64
```

**Purpose**: Converts a UTC datetime into Unix epoch milliseconds. It is the write-side counterpart to `epoch_millis_to_datetime`.

**Data flow**: It takes a `DateTime<Utc>` and returns `dt.timestamp_millis()` as `i64`.

**Call relations**: `canonicalize_datetime` calls this to round-trip timestamps through the same precision used by persisted thread rows.

*Call graph*: called by 1 (canonicalize_datetime); 1 external calls (timestamp_millis).


##### `datetime_to_epoch_seconds`  (lines 472–474)

```
fn datetime_to_epoch_seconds(dt: DateTime<Utc>) -> i64
```

**Purpose**: Converts a UTC datetime into Unix epoch seconds. It supports persistence paths that store second-precision timestamps.

**Data flow**: It takes a `DateTime<Utc>` and returns `dt.timestamp()` as `i64`.

**Call relations**: Other modules import this helper when writing second-precision fields such as archive or completion timestamps.

*Call graph*: 1 external calls (timestamp).


##### `epoch_millis_to_datetime`  (lines 476–487)

```
fn epoch_millis_to_datetime(value: i64) -> Result<DateTime<Utc>>
```

**Purpose**: Converts persisted millisecond timestamps into `DateTime<Utc>`, with backward compatibility for legacy rows that stored seconds in the same column. It preserves ordering semantics across old and new databases.

**Data flow**: It takes an `i64` value, compares it against `MIN_EPOCH_MILLIS` (2020-01-01 in ms), treats smaller values as legacy seconds by multiplying with `saturating_mul(1000)`, then calls `DateTime::<Utc>::from_timestamp_millis(millis)` and returns the datetime or an `anyhow` error if invalid.

**Call relations**: Both `ThreadMetadata::try_from` and `canonicalize_datetime` rely on this helper. It is a key compatibility shim for mixed timestamp precisions in persisted thread rows.

*Call graph*: called by 2 (try_from, canonicalize_datetime); 1 external calls (from_timestamp_millis).


##### `epoch_seconds_to_datetime`  (lines 489–492)

```
fn epoch_seconds_to_datetime(value: i64) -> Result<DateTime<Utc>>
```

**Purpose**: Converts a Unix timestamp in seconds into `DateTime<Utc>` with validation. It is used for fields that remain second-precision in storage.

**Data flow**: It accepts an `i64`, calls `DateTime::<Utc>::from_timestamp(value, 0)`, and returns the datetime or an `anyhow` error if the timestamp is invalid.

**Call relations**: `ThreadMetadata::try_from` uses this for the optional `archived_at` field.

*Call graph*: 1 external calls (from_timestamp).


##### `tests::thread_row`  (lines 516–543)

```
fn thread_row(reasoning_effort: Option<&str>) -> ThreadRow
```

**Purpose**: Creates a representative `ThreadRow` fixture for conversion tests, parameterized by an optional reasoning-effort string. It keeps the tests concise and focused on parsing behavior.

**Data flow**: It takes `Option<&str>` for `reasoning_effort`, converts it to `Option<String>`, and returns a fully populated `ThreadRow` with fixed IDs, timestamps, paths, provider/model values, and empty-string sentinels for optional text fields.

**Call relations**: Both reasoning-effort tests call this helper to generate the raw row input passed into `ThreadMetadata::try_from`.

*Call graph*: 1 external calls (new).


##### `tests::expected_thread_metadata`  (lines 545–573)

```
fn expected_thread_metadata(reasoning_effort: Option<ReasoningEffort>) -> ThreadMetadata
```

**Purpose**: Builds the expected `ThreadMetadata` value corresponding to the `thread_row` fixture. It parameterizes only the parsed `ReasoningEffort` outcome.

**Data flow**: It takes `Option<ReasoningEffort>`, constructs a `ThreadMetadata` with parsed `ThreadId`, `PathBuf` paths, `DateTime<Utc>` timestamps from fixed epoch seconds, and `None` for fields represented by empty strings in the row fixture, then returns that expected value.

**Call relations**: The two conversion tests compare actual parsed metadata against this helper’s output to verify exact normalization behavior.

*Call graph*: calls 1 internal fn (from_string); 3 external calls (from_timestamp, from, new).


##### `tests::thread_row_parses_reasoning_effort`  (lines 576–584)

```
fn thread_row_parses_reasoning_effort()
```

**Purpose**: Verifies that a known reasoning-effort string (`"high"`) is parsed into the corresponding typed enum variant. It checks the full converted metadata object, not just the single field.

**Data flow**: It builds a raw row with `thread_row(Some("high"))`, converts it using `ThreadMetadata::try_from`, and asserts equality with `expected_thread_metadata(Some(ReasoningEffort::High))`.

**Call relations**: This is a unit test run by the test harness. It exercises the `ThreadMetadata::try_from` conversion path for a standard reasoning-effort value.

*Call graph*: calls 1 internal fn (try_from); 2 external calls (assert_eq!, thread_row).


##### `tests::thread_row_preserves_model_defined_reasoning_effort_values`  (lines 587–595)

```
fn thread_row_preserves_model_defined_reasoning_effort_values()
```

**Purpose**: Verifies that nonstandard reasoning-effort strings are preserved as model-defined custom values rather than discarded. It protects forward compatibility with future model outputs.

**Data flow**: It creates a raw row with `thread_row(Some("future"))`, converts it via `ThreadMetadata::try_from`, and asserts equality with `expected_thread_metadata(Some(ReasoningEffort::Custom("future".to_string())))`.

**Call relations**: This unit test complements the standard parsing test by covering the forward-compatible branch of reasoning-effort decoding.

*Call graph*: calls 1 internal fn (try_from); 2 external calls (assert_eq!, thread_row).


### `state/src/runtime/threads.rs`

`domain_logic` · `active during thread ingestion, listing, mutation, archival, and cleanup`

This file contains the bulk of the thread persistence logic for the runtime state database. On the read side, it can fetch a single thread, list thread IDs or full `ThreadMetadata` pages with keyset pagination, filter by archived state, source, provider, cwd, search term, and optional parent thread, and resolve rollout paths or exact-title matches. Query construction is centralized through `push_thread_select_columns`, `push_thread_filters`, `push_thread_order_and_limit`, and `push_list_threads_query`, which deliberately preserve index-friendly plans; the `OrderByIndex` toggle adds a unary `+` to disable timestamp-order index selection when multi-cwd filtering would otherwise regress into scans.

On the write side, the file inserts and upserts thread rows, updates preview/title/git info/memory mode, and applies rollout items incrementally. `allocate_thread_updated_at` is a key design point: it maintains a process-local atomic high-water mark of millisecond timestamps so hot writes get unique, monotonic `updated_at_ms` values without querying SQLite, while still allowing sufficiently older historical timestamps through unchanged for backfill and repair. Upserts preserve existing non-null git fields atomically and avoid overwriting a non-empty preview with an empty incoming value.

The file also persists directional spawn edges in `thread_spawn_edges`, supports direct and recursive descendant traversal, and can infer a parent edge from serialized `SessionSource`. Deletion is intentionally staged: logs, memories, goals, dynamic tools, agent job assignments, and spawn edges are cleaned before thread rows are removed, so partial failures leave enough graph state to retry cleanup safely. The extensive tests cover pagination semantics, index plans, memory-mode restoration, git-field preservation, preview filling, timestamp uniqueness, spawn-edge status filtering, and cleanup failure behavior.

#### Function details

##### `StateRuntime::get_thread`  (lines 7–44)

```
async fn get_thread(&self, id: ThreadId) -> anyhow::Result<Option<crate::ThreadMetadata>>
```

**Purpose**: Loads one thread row by `ThreadId` and converts it into `crate::ThreadMetadata`. It returns `None` when the thread does not exist.

**Data flow**: It takes a `ThreadId`, converts it to a string key, executes a `SELECT` over the `threads` table, and fetches at most one row from `self.pool`. If a row is present, it passes it through `ThreadRow::try_from_row` and then `ThreadMetadata::try_from`; the final result is `anyhow::Result<Option<ThreadMetadata>>`.

**Call relations**: This is the canonical thread read path used by `apply_rollout_items`, `mark_archived`, and `mark_unarchived` before they mutate and re-upsert metadata. It delegates row decoding to the shared `ThreadRow` conversion logic.

*Call graph*: called by 3 (apply_rollout_items, mark_archived, mark_unarchived); 2 external calls (to_string, query).


##### `StateRuntime::get_thread_memory_mode`  (lines 46–52)

```
async fn get_thread_memory_mode(&self, id: ThreadId) -> anyhow::Result<Option<String>>
```

**Purpose**: Fetches only the persisted `memory_mode` column for a thread. It is a lightweight read path when callers do not need full metadata.

**Data flow**: Given a `ThreadId`, it queries `SELECT memory_mode FROM threads WHERE id = ?`, converts the id to string, and returns `Ok(Some(String))` if the row and column are present, otherwise `Ok(None)`. SQL errors are propagated.

**Call relations**: This method is used by tests and memory-mode-related flows after rollout application. It avoids the heavier full-row decoding performed by `get_thread`.

*Call graph*: 2 external calls (to_string, query).


##### `StateRuntime::set_thread_preview_if_empty`  (lines 54–75)

```
async fn set_thread_preview_if_empty(
        &self,
        thread_id: ThreadId,
        preview: &str,
    ) -> anyhow::Result<bool>
```

**Purpose**: Fills in a thread preview only when the stored preview is currently blank. It trims the incoming text and refuses to write empty or whitespace-only values.

**Data flow**: Inputs are a `ThreadId` and preview string. The function trims the preview, returns `Ok(false)` immediately if the trimmed value is empty, otherwise executes `UPDATE threads SET preview = ? WHERE id = ? AND preview = ''` and returns whether any row was updated.

**Call relations**: This targeted mutation path is used when a later signal can supply a preview but should not overwrite an existing one. It complements the broader upsert logic, which also preserves non-empty previews during conflict updates.

*Call graph*: 2 external calls (to_string, query).


##### `StateRuntime::upsert_thread_spawn_edge`  (lines 78–102)

```
async fn upsert_thread_spawn_edge(
        &self,
        parent_thread_id: ThreadId,
        child_thread_id: ThreadId,
        status: crate::DirectionalThreadSpawnEdgeStatus,
    ) -> anyhow::Resul
```

**Purpose**: Creates or replaces the incoming spawn edge for a child thread, including its directional lifecycle status. The child thread is unique in this graph representation.

**Data flow**: It accepts parent and child `ThreadId`s plus a `DirectionalThreadSpawnEdgeStatus`, converts ids to strings and status to its string form, and executes an `INSERT ... ON CONFLICT(child_thread_id) DO UPDATE` into `thread_spawn_edges`. It returns `Ok(())` on success.

**Call relations**: Callers use this when explicitly managing spawned-thread relationships. Listing and descendant traversal methods later read the rows written here.

*Call graph*: 3 external calls (to_string, query, as_ref).


##### `StateRuntime::set_thread_spawn_edge_status`  (lines 105–116)

```
async fn set_thread_spawn_edge_status(
        &self,
        child_thread_id: ThreadId,
        status: crate::DirectionalThreadSpawnEdgeStatus,
    ) -> anyhow::Result<()>
```

**Purpose**: Updates only the status of an existing child thread's incoming spawn edge. It leaves the parent-child linkage unchanged.

**Data flow**: It takes a child `ThreadId` and new status, converts both to bound SQL values, runs `UPDATE thread_spawn_edges SET status = ? WHERE child_thread_id = ?`, and returns `Ok(())` or an error.

**Call relations**: This is the narrow mutation path used after an edge already exists and only its lifecycle state changes. Status-aware listing methods consume the updated values.

*Call graph*: 3 external calls (to_string, query, as_ref).


##### `StateRuntime::list_thread_spawn_children_with_status`  (lines 119–126)

```
async fn list_thread_spawn_children_with_status(
        &self,
        parent_thread_id: ThreadId,
        status: crate::DirectionalThreadSpawnEdgeStatus,
    ) -> anyhow::Result<Vec<ThreadId>>
```

**Purpose**: Returns direct child thread IDs for a parent, filtered to a specific edge status. Results are ordered by child thread id.

**Data flow**: It takes a parent `ThreadId` and status, wraps the status in `Some`, and forwards to `list_thread_spawn_children_matching`. The returned `Vec<ThreadId>` contains only matching direct children.

**Call relations**: This is a convenience wrapper over the internal query builder. Callers choose it when they need only open or closed children rather than all statuses.

*Call graph*: calls 1 internal fn (list_thread_spawn_children_matching).


##### `StateRuntime::list_thread_spawn_children`  (lines 129–135)

```
async fn list_thread_spawn_children(
        &self,
        parent_thread_id: ThreadId,
    ) -> anyhow::Result<Vec<ThreadId>>
```

**Purpose**: Returns all direct child thread IDs for a parent regardless of edge status. Ordering is stable by child thread id.

**Data flow**: It accepts a parent `ThreadId`, passes `None` as the status filter to `list_thread_spawn_children_matching`, and returns the resulting `Vec<ThreadId>`.

**Call relations**: This wrapper exposes the unfiltered direct-child traversal path. Tests use it to confirm that unknown future statuses are still included when no filter is requested.

*Call graph*: calls 1 internal fn (list_thread_spawn_children_matching).


##### `StateRuntime::list_thread_spawn_descendants_with_status`  (lines 140–147)

```
async fn list_thread_spawn_descendants_with_status(
        &self,
        root_thread_id: ThreadId,
        status: crate::DirectionalThreadSpawnEdgeStatus,
    ) -> anyhow::Result<Vec<ThreadId>>
```

**Purpose**: Returns all descendants reachable from a root thread whose traversed edges match a given status. Ordering is breadth-first by depth, then thread id.

**Data flow**: It takes a root `ThreadId` and status, forwards `Some(status)` to `list_thread_spawn_descendants_matching`, and returns the collected descendant IDs.

**Call relations**: This wrapper exposes the recursive status-filtered traversal path. It is used when callers need only open or closed subtrees.

*Call graph*: calls 1 internal fn (list_thread_spawn_descendants_matching).


##### `StateRuntime::list_thread_spawn_descendants`  (lines 152–158)

```
async fn list_thread_spawn_descendants(
        &self,
        root_thread_id: ThreadId,
    ) -> anyhow::Result<Vec<ThreadId>>
```

**Purpose**: Returns all descendants reachable from a root thread regardless of edge status. Results are breadth-first and stable within each depth.

**Data flow**: It accepts a root `ThreadId`, forwards `None` to `list_thread_spawn_descendants_matching`, and returns the resulting `Vec<ThreadId>`.

**Call relations**: This is the unfiltered recursive traversal entrypoint. Cleanup tests use it to verify that retry graph structure remains intact after a failed deletion attempt.

*Call graph*: calls 1 internal fn (list_thread_spawn_descendants_matching).


##### `StateRuntime::find_thread_spawn_child_by_path`  (lines 161–182)

```
async fn find_thread_spawn_child_by_path(
        &self,
        parent_thread_id: ThreadId,
        agent_path: &str,
    ) -> anyhow::Result<Option<ThreadId>>
```

**Purpose**: Finds a direct spawned child of a parent by canonical `threads.agent_path`. It errors if more than one child matches the same path.

**Data flow**: Inputs are a parent `ThreadId` and `agent_path`. The function joins `thread_spawn_edges` to `threads`, filters by parent and path, orders by thread id, limits to two rows, and passes the rows to `one_thread_id_from_rows`. It returns `Ok(None)`, `Ok(Some(ThreadId))`, or an error on duplicates/SQL issues.

**Call relations**: This lookup path is for direct children only. It delegates duplicate detection and row-to-id conversion to `one_thread_id_from_rows`.

*Call graph*: calls 1 internal fn (one_thread_id_from_rows); 2 external calls (to_string, query).


##### `StateRuntime::find_thread_spawn_descendant_by_path`  (lines 185–214)

```
async fn find_thread_spawn_descendant_by_path(
        &self,
        root_thread_id: ThreadId,
        agent_path: &str,
    ) -> anyhow::Result<Option<ThreadId>>
```

**Purpose**: Finds any spawned descendant under a root thread by canonical `agent_path`. It uses a recursive CTE and rejects ambiguous matches.

**Data flow**: It takes a root `ThreadId` and path, builds a recursive `subtree` CTE over `thread_spawn_edges`, joins descendants to `threads`, filters by `agent_path`, orders by id, limits to two rows, and converts the rows through `one_thread_id_from_rows`.

**Call relations**: This is the recursive counterpart to `find_thread_spawn_child_by_path`. It delegates ambiguity handling to `one_thread_id_from_rows` after the SQL traversal gathers candidate descendants.

*Call graph*: calls 1 internal fn (one_thread_id_from_rows); 2 external calls (to_string, query).


##### `StateRuntime::list_thread_spawn_children_matching`  (lines 216–236)

```
async fn list_thread_spawn_children_matching(
        &self,
        parent_thread_id: ThreadId,
        status: Option<crate::DirectionalThreadSpawnEdgeStatus>,
    ) -> anyhow::Result<Vec<ThreadId>>
```

**Purpose**: Internal query builder for direct child listing with an optional status filter. It centralizes the SQL shape used by both public child-list methods.

**Data flow**: Inputs are a parent `ThreadId` and `Option<DirectionalThreadSpawnEdgeStatus>`. It constructs a `QueryBuilder<Sqlite>` selecting `child_thread_id` from `thread_spawn_edges`, conditionally appends `AND status = ?`, orders by `child_thread_id`, fetches all rows, and converts each string id into `ThreadId`.

**Call relations**: Only `list_thread_spawn_children` and `list_thread_spawn_children_with_status` call this helper. It exists to keep the direct-child query logic and conversion behavior in one place.

*Call graph*: called by 2 (list_thread_spawn_children, list_thread_spawn_children_with_status); 2 external calls (new, to_string).


##### `StateRuntime::list_thread_spawn_descendants_matching`  (lines 238–290)

```
async fn list_thread_spawn_descendants_matching(
        &self,
        root_thread_id: ThreadId,
        status: Option<crate::DirectionalThreadSpawnEdgeStatus>,
    ) -> anyhow::Result<Vec<ThreadId>
```

**Purpose**: Internal recursive traversal for descendant listing with an optional status filter. It emits descendants breadth-first by carrying depth through a recursive CTE.

**Data flow**: It accepts a root `ThreadId` and optional status. Using `QueryBuilder`, it creates a recursive `subtree(child_thread_id, depth)` CTE seeded from the root's direct children; when a status is provided, both the seed and recursive step constrain `status = ?`. It then selects `child_thread_id` ordered by `depth ASC, child_thread_id ASC`, fetches all rows, and converts them into `ThreadId`s.

**Call relations**: This helper underpins both public descendant-list methods. The status-aware branch intentionally filters both the first hop and recursive expansion so only matching-status edges remain in the returned subtree.

*Call graph*: called by 2 (list_thread_spawn_descendants, list_thread_spawn_descendants_with_status); 2 external calls (new, to_string).


##### `StateRuntime::insert_thread_spawn_edge_if_absent`  (lines 292–313)

```
async fn insert_thread_spawn_edge_if_absent(
        &self,
        parent_thread_id: ThreadId,
        child_thread_id: ThreadId,
    ) -> anyhow::Result<()>
```

**Purpose**: Creates an open spawn edge only if the child thread does not already have one. It is used for inferred parentage rather than explicit edge replacement.

**Data flow**: It takes parent and child `ThreadId`s, converts them to strings, binds the default status `DirectionalThreadSpawnEdgeStatus::Open`, and executes `INSERT ... ON CONFLICT(child_thread_id) DO NOTHING`. It returns `Ok(())` regardless of whether a row was inserted.

**Call relations**: This helper is called only by `insert_thread_spawn_edge_from_source_if_absent`, which uses it after inferring a parent thread from serialized session source metadata.

*Call graph*: called by 1 (insert_thread_spawn_edge_from_source_if_absent); 2 external calls (to_string, query).


##### `StateRuntime::insert_thread_spawn_edge_from_source_if_absent`  (lines 315–325)

```
async fn insert_thread_spawn_edge_from_source_if_absent(
        &self,
        child_thread_id: ThreadId,
        source: &str,
    ) -> anyhow::Result<()>
```

**Purpose**: Infers a parent thread from a thread's serialized `source` string and inserts the corresponding spawn edge if one is not already present. If the source does not encode a parent, it does nothing.

**Data flow**: Inputs are a child `ThreadId` and source string. The function parses the source via `thread_spawn_parent_thread_id_from_source_str`; if parsing yields `Some(parent_thread_id)`, it calls `insert_thread_spawn_edge_if_absent`, otherwise it returns `Ok(())` immediately.

**Call relations**: Both `insert_thread_if_absent` and `upsert_thread_with_creation_memory_mode` call this after writing a thread row so inferred spawn relationships are persisted automatically for threads whose source encodes parentage.

*Call graph*: calls 2 internal fn (insert_thread_spawn_edge_if_absent, thread_spawn_parent_thread_id_from_source_str); called by 2 (insert_thread_if_absent, upsert_thread_with_creation_memory_mode).


##### `StateRuntime::find_rollout_path_by_id`  (lines 328–349)

```
async fn find_rollout_path_by_id(
        &self,
        id: ThreadId,
        archived_only: Option<bool>,
    ) -> anyhow::Result<Option<PathBuf>>
```

**Purpose**: Looks up the persisted rollout file path for a thread, optionally restricted to archived or unarchived rows. It returns the path without loading full metadata.

**Data flow**: It takes a `ThreadId` and `Option<bool>` for `archived_only`, builds a query selecting `rollout_path` from `threads`, conditionally appends `AND archived = 1` or `AND archived = 0`, fetches an optional row, and maps the string path into `PathBuf`.

**Call relations**: This is a lightweight lookup path for callers that only need the rollout location. It uses dynamic SQL assembly rather than the broader thread-list helpers.

*Call graph*: 2 external calls (new, to_string).


##### `StateRuntime::find_thread_by_exact_title`  (lines 353–394)

```
async fn find_thread_by_exact_title(
        &self,
        title: &str,
        allowed_sources: &[String],
        model_providers: Option<&[String]>,
        archived_only: bool,
        cwd: Optio
```

**Purpose**: Finds the newest visible thread whose title exactly matches a given string, subject to source/provider/archive/cwd filters. It returns at most one `ThreadMetadata` row ordered by newest `updated_at`.

**Data flow**: Inputs are the title, allowed sources, optional provider list, archive flag, and optional cwd. The function builds a query using `push_thread_select_columns`, `push_thread_filters`, and `push_thread_order_and_limit`, adds `AND threads.title = ?` and optional cwd equality, fetches one row, and converts it into `ThreadMetadata`.

**Call relations**: This method composes the shared filtering and ordering helpers with an exact-title predicate. It is a specialized search path layered on top of the same thread-row projection used by list operations.

*Call graph*: calls 3 internal fn (push_thread_filters, push_thread_order_and_limit, push_thread_select_columns); 1 external calls (new).


##### `StateRuntime::list_threads`  (lines 397–404)

```
async fn list_threads(
        &self,
        page_size: usize,
        filters: ThreadFilterOptions<'_>,
    ) -> anyhow::Result<crate::ThreadsPage>
```

**Purpose**: Lists visible threads as a paginated `ThreadsPage` using the supplied filter options. It is the general thread-list entrypoint without parent-child restriction.

**Data flow**: It takes a page size and `ThreadFilterOptions`, forwards them with `parent_thread_id` set to `None` into `list_threads_matching`, and returns the resulting page.

**Call relations**: This public wrapper is used for ordinary thread browsing. It delegates all query construction, pagination, and row decoding to `list_threads_matching`.

*Call graph*: calls 1 internal fn (list_threads_matching).


##### `StateRuntime::list_threads_by_parent`  (lines 407–415)

```
async fn list_threads_by_parent(
        &self,
        page_size: usize,
        parent_thread_id: ThreadId,
        filters: ThreadFilterOptions<'_>,
    ) -> anyhow::Result<crate::ThreadsPage>
```

**Purpose**: Lists direct child threads of a given parent as a paginated `ThreadsPage`, while still honoring the standard thread filters and ordering. It uses persisted spawn edges rather than rollout scanning.

**Data flow**: Inputs are page size, parent `ThreadId`, and `ThreadFilterOptions`. The function forwards them to `list_threads_matching` with `Some(parent_thread_id)` so the query adds a child-edge restriction.

**Call relations**: This wrapper exposes parent-scoped listing on top of the shared pagination machinery. Tests use it to verify direct-child filtering and keyset pagination behavior.

*Call graph*: calls 1 internal fn (list_threads_matching).


##### `StateRuntime::list_threads_matching`  (lines 417–447)

```
async fn list_threads_matching(
        &self,
        page_size: usize,
        filters: ThreadFilterOptions<'_>,
        parent_thread_id: Option<ThreadId>,
    ) -> anyhow::Result<crate::ThreadsPag
```

**Purpose**: Internal implementation for paginated thread listing, optionally restricted to direct children of a parent thread. It computes `next_anchor` by overfetching one row.

**Data flow**: It receives page size, filter options, and optional parent id. The function computes `limit = page_size + 1`, builds the SQL with `push_list_threads_query`, fetches rows, converts them into `ThreadMetadata`, records `num_scanned_rows`, and if more than `page_size` items were fetched, pops the extra row and derives `next_anchor` from the last retained item using `anchor_from_item`.

**Call relations**: Both `list_threads` and `list_threads_by_parent` call this shared implementation. It delegates SQL assembly to `push_list_threads_query` and encapsulates the keyset-pagination contract for all thread-page callers.

*Call graph*: calls 1 internal fn (push_list_threads_query); called by 2 (list_threads, list_threads_by_parent); 1 external calls (new).


##### `StateRuntime::list_thread_ids`  (lines 450–488)

```
async fn list_thread_ids(
        &self,
        limit: usize,
        anchor: Option<&crate::Anchor>,
        sort_key: crate::SortKey,
        allowed_sources: &[String],
        model_providers: Op
```

**Purpose**: Lists only thread IDs, not full metadata, using the same visibility and ordering filters as thread listing. This avoids rollout-path and metadata decoding overhead when only identifiers are needed.

**Data flow**: Inputs are limit, optional anchor, sort key, allowed sources, optional providers, and archive flag. The function builds `SELECT threads.id FROM threads`, applies `push_thread_filters` and `push_thread_order_and_limit`, fetches all rows, extracts each `id` string, converts it to `ThreadId`, and returns the vector.

**Call relations**: This method reuses the shared filter/order helpers but bypasses `push_thread_select_columns` and `ThreadRow` decoding. It serves callers that need ordered identifiers for follow-up work.

*Call graph*: calls 2 internal fn (push_thread_filters, push_thread_order_and_limit); 1 external calls (new).


##### `StateRuntime::upsert_thread`  (lines 491–494)

```
async fn upsert_thread(&self, metadata: &crate::ThreadMetadata) -> anyhow::Result<()>
```

**Purpose**: Public convenience wrapper that upserts thread metadata using the default creation memory mode behavior. It is the standard write path for full metadata replacement/merge.

**Data flow**: It takes a borrowed `ThreadMetadata` and forwards it to `upsert_thread_with_creation_memory_mode` with `None` for `creation_memory_mode`. The return value is the delegated `anyhow::Result<()>`.

**Call relations**: This wrapper is called by `apply_rollout_items`, `mark_archived`, and `mark_unarchived`, and by many tests. It exists so most callers do not need to reason about the special first-insert memory-mode override.

*Call graph*: calls 1 internal fn (upsert_thread_with_creation_memory_mode); called by 3 (apply_rollout_items, mark_archived, mark_unarchived).


##### `StateRuntime::insert_thread_if_absent`  (lines 496–580)

```
async fn insert_thread_if_absent(
        &self,
        metadata: &crate::ThreadMetadata,
    ) -> anyhow::Result<bool>
```

**Purpose**: Attempts to insert a new thread row without overwriting an existing one. It also infers and inserts a spawn edge from the thread source when applicable.

**Data flow**: It reads a `ThreadMetadata`, allocates a persisted `updated_at` via `allocate_thread_updated_at`, derives the stored preview via `metadata_preview`, binds all thread columns into an `INSERT ... ON CONFLICT(id) DO NOTHING`, and executes it. Afterward it calls `insert_thread_spawn_edge_from_source_if_absent` regardless of whether the row already existed, then returns `true` if a row was inserted and `false` otherwise.

**Call relations**: This is the non-destructive insert path used when fallback metadata should not clobber newer persisted state. It depends on `allocate_thread_updated_at` for timestamp uniqueness, `metadata_preview` for preview fallback, and inferred-edge insertion for parent-child graph maintenance.

*Call graph*: calls 3 internal fn (allocate_thread_updated_at, insert_thread_spawn_edge_from_source_if_absent, metadata_preview); 1 external calls (query).


##### `StateRuntime::set_thread_memory_mode`  (lines 582–593)

```
async fn set_thread_memory_mode(
        &self,
        thread_id: ThreadId,
        memory_mode: &str,
    ) -> anyhow::Result<bool>
```

**Purpose**: Updates the `memory_mode` column for a thread and reports whether a row was touched. It is a narrow mutation path separate from full metadata upserts.

**Data flow**: Inputs are a `ThreadId` and memory-mode string. The function executes `UPDATE threads SET memory_mode = ? WHERE id = ?` and returns `Ok(result.rows_affected() > 0)`.

**Call relations**: `apply_rollout_items` calls this after upserting metadata when rollout items contain a newer memory-mode signal. Keeping it separate avoids embedding memory-mode extraction logic into the main upsert SQL.

*Call graph*: called by 1 (apply_rollout_items); 2 external calls (to_string, query).


##### `StateRuntime::update_thread_title`  (lines 595–606)

```
async fn update_thread_title(
        &self,
        thread_id: ThreadId,
        title: &str,
    ) -> anyhow::Result<bool>
```

**Purpose**: Replaces the stored title for a thread and reports whether the row existed. It does not modify any other metadata.

**Data flow**: It binds the new title and thread id into `UPDATE threads SET title = ? WHERE id = ?` and returns a boolean based on `rows_affected()`.

**Call relations**: This is a focused update path for title edits. It bypasses the heavier full-row upsert machinery when only the title changes.

*Call graph*: 2 external calls (to_string, query).


##### `StateRuntime::touch_thread_updated_at`  (lines 608–622)

```
async fn touch_thread_updated_at(
        &self,
        thread_id: ThreadId,
        updated_at: DateTime<Utc>,
    ) -> anyhow::Result<bool>
```

**Purpose**: Updates only the persisted `updated_at` and `updated_at_ms` fields for a thread, preserving all other columns. It still routes the timestamp through the monotonic allocator.

**Data flow**: Inputs are a `ThreadId` and desired `DateTime<Utc>`. The function calls `allocate_thread_updated_at`, converts the allocated time to seconds and millis, executes `UPDATE threads SET updated_at = ?, updated_at_ms = ? WHERE id = ?`, and returns whether any row was updated.

**Call relations**: This method is used when callers need to advance ordering/cursor state without rewriting metadata. It relies on `allocate_thread_updated_at` to preserve uniqueness guarantees shared with insert/upsert paths.

*Call graph*: calls 1 internal fn (allocate_thread_updated_at); 2 external calls (to_string, query).


##### `StateRuntime::allocate_thread_updated_at`  (lines 630–668)

```
fn allocate_thread_updated_at(
        &self,
        updated_at: DateTime<Utc>,
    ) -> anyhow::Result<DateTime<Utc>>
```

**Purpose**: Allocates a persisted `updated_at` timestamp that is monotonic and unique within the current process for hot writes, while preserving sufficiently older historical timestamps unchanged. This protects keyset ordering without requiring a database read on every write.

**Data flow**: It takes a candidate `DateTime<Utc>`, converts it to epoch millis, then loops against `self.thread_updated_at_millis` using relaxed atomic loads and compare-exchange. If the candidate is newer than the current high-water mark, it installs and returns it; if it is at least one second older than current, it returns the candidate unchanged; otherwise it bumps the current mark by one millisecond and returns that bumped value. The final integer is converted back to `DateTime<Utc>`.

**Call relations**: This allocator is called by `insert_thread_if_absent`, `touch_thread_updated_at`, and `upsert_thread_with_creation_memory_mode`. It is the core invariant-preserving helper behind stable thread ordering and duplicate-timestamp avoidance.

*Call graph*: called by 3 (insert_thread_if_absent, touch_thread_updated_at, upsert_thread_with_creation_memory_mode).


##### `StateRuntime::update_thread_git_info`  (lines 670–697)

```
async fn update_thread_git_info(
        &self,
        thread_id: ThreadId,
        git_sha: Option<Option<&str>>,
        git_branch: Option<Option<&str>>,
        git_origin_url: Option<Option<&str
```

**Purpose**: Updates git metadata fields on a thread without disturbing unrelated columns. Each field can be left unchanged, set to a value, or explicitly cleared.

**Data flow**: Inputs are a `ThreadId` and three `Option<Option<&str>>` parameters for SHA, branch, and origin URL. For each field, outer `None` means leave unchanged, `Some(Some(v))` means set to `v`, and `Some(None)` means clear to SQL `NULL`. The function encodes those semantics with `CASE WHEN ? THEN ? ELSE existing END` expressions in one `UPDATE` and returns whether any row was affected.

**Call relations**: This targeted mutation path exists because rollout upserts may race with newer metadata writes; updating git fields independently avoids rewriting non-git columns. Tests verify both preservation of newer non-git metadata and explicit clearing behavior.

*Call graph*: 2 external calls (to_string, query).


##### `StateRuntime::upsert_thread_with_creation_memory_mode`  (lines 699–813)

```
async fn upsert_thread_with_creation_memory_mode(
        &self,
        metadata: &crate::ThreadMetadata,
        creation_memory_mode: Option<&str>,
    ) -> anyhow::Result<()>
```

**Purpose**: Inserts or updates a thread row while preserving important invariants: monotonic timestamps, non-empty preview retention, and atomic preservation of existing non-null git fields. On first insert it can seed a custom creation memory mode.

**Data flow**: It takes `ThreadMetadata` plus an optional creation memory mode, allocates `updated_at`, derives preview via `metadata_preview`, and executes an `INSERT ... ON CONFLICT(id) DO UPDATE`. The insert writes all thread columns including `memory_mode`; the conflict update refreshes most metadata but uses `COALESCE(NULLIF(excluded.preview, ''), threads.preview)` to avoid blanking preview and `COALESCE(threads.git_*, excluded.git_*)` to preserve existing git fields. After the SQL write it calls `insert_thread_spawn_edge_from_source_if_absent` and returns `Ok(())`.

**Call relations**: This is the real implementation behind `upsert_thread`, and `apply_rollout_items` also calls it directly when inserting a brand-new thread with a specific initial memory mode. It depends on `allocate_thread_updated_at`, `metadata_preview`, and inferred-edge insertion.

*Call graph*: calls 3 internal fn (allocate_thread_updated_at, insert_thread_spawn_edge_from_source_if_absent, metadata_preview); called by 2 (apply_rollout_items, upsert_thread); 1 external calls (query).


##### `StateRuntime::apply_rollout_items`  (lines 816–859)

```
async fn apply_rollout_items(
        &self,
        builder: &ThreadMetadataBuilder,
        items: &[RolloutItem],
        new_thread_memory_mode: Option<&str>,
        updated_at_override: Option<D
```

**Purpose**: Merges a batch of rollout items into persisted thread metadata, creating the thread if needed and restoring memory mode from session metadata when present. It is the bridge from rollout-file events to SQLite thread state.

**Data flow**: Inputs are a `ThreadMetadataBuilder`, a slice of `RolloutItem`, an optional creation memory mode for new threads, and an optional `updated_at` override. If `items` is empty it returns immediately. Otherwise it loads existing metadata with `get_thread`, builds or clones a metadata base, updates `rollout_path`, applies each rollout item via `apply_rollout_item`, preserves existing git info when a row already exists, chooses `updated_at` from the override or rollout file mtime, then either inserts with `upsert_thread_with_creation_memory_mode` or updates with `upsert_thread`. Finally it extracts the latest memory mode from the items via `extract_memory_mode` and, if present, persists it with `set_thread_memory_mode`.

**Call relations**: This method is called by rollout ingestion paths. It orchestrates reads from `get_thread`, metadata mutation through `apply_rollout_item`, persistence through the upsert methods, and post-write memory-mode repair through `extract_memory_mode` and `set_thread_memory_mode`.

*Call graph*: calls 5 internal fn (get_thread, set_thread_memory_mode, upsert_thread, upsert_thread_with_creation_memory_mode, extract_memory_mode); 1 external calls (is_empty).


##### `StateRuntime::mark_archived`  (lines 862–883)

```
async fn mark_archived(
        &self,
        thread_id: ThreadId,
        rollout_path: &Path,
        archived_at: DateTime<Utc>,
    ) -> anyhow::Result<()>
```

**Purpose**: Marks an existing thread as archived and updates its rollout path and timestamp from the archived rollout file. Missing threads are ignored.

**Data flow**: It takes a thread id, archived rollout path, and archive timestamp. The function loads the thread with `get_thread`; if absent it returns `Ok(())`. Otherwise it sets `archived_at`, replaces `rollout_path`, optionally refreshes `updated_at` from the file's modified time, warns if the loaded metadata id unexpectedly differs from the requested id, and persists the result with `upsert_thread`.

**Call relations**: Archive flows call this after moving or recognizing an archived rollout file. It depends on `get_thread` to avoid creating phantom rows and on `upsert_thread` to persist the modified metadata.

*Call graph*: calls 2 internal fn (get_thread, upsert_thread); 2 external calls (to_path_buf, warn!).


##### `StateRuntime::mark_unarchived`  (lines 886–906)

```
async fn mark_unarchived(
        &self,
        thread_id: ThreadId,
        rollout_path: &Path,
    ) -> anyhow::Result<()>
```

**Purpose**: Clears the archived flag on an existing thread and updates its rollout path and timestamp from the active rollout file. Missing threads are ignored.

**Data flow**: It accepts a thread id and rollout path, loads the thread via `get_thread`, returns early if absent, sets `archived_at` to `None`, updates `rollout_path`, optionally refreshes `updated_at` from file mtime, warns on an unexpected id mismatch, and writes the metadata back with `upsert_thread`.

**Call relations**: This is the inverse of `mark_archived` for restore/unarchive flows. It follows the same read-modify-write pattern and warning behavior.

*Call graph*: calls 2 internal fn (get_thread, upsert_thread); 2 external calls (to_path_buf, warn!).


##### `StateRuntime::delete_thread`  (lines 909–911)

```
async fn delete_thread(&self, thread_id: ThreadId) -> anyhow::Result<u64>
```

**Purpose**: Deletes one thread and all associated state by delegating to the strict multi-thread deletion path. It returns the number of thread rows removed.

**Data flow**: It wraps the single `ThreadId` in a one-element slice and forwards to `delete_threads_strict`, returning that method's `u64` result.

**Call relations**: This is the convenience single-thread entrypoint. All real cleanup logic lives in `delete_threads_strict`.

*Call graph*: calls 1 internal fn (delete_threads_strict).


##### `StateRuntime::delete_threads_strict`  (lines 917–1020)

```
async fn delete_threads_strict(&self, thread_ids: &[ThreadId]) -> anyhow::Result<u64>
```

**Purpose**: Deletes threads and their associated logs, memories, goals, dynamic tools, spawn edges, and agent-job assignments in a retry-safe order. It also cancels jobs whose running worker threads are being deleted alongside their runner threads.

**Data flow**: It takes a slice of `ThreadId`s and returns early with `0` if empty. It stringifies ids, then outside the main transaction deletes each thread's logs from `logs_pool`, memory state via `self.memories`, and goals via `self.thread_goals`. Inside a transaction on `self.pool`, it computes `now`, cancels affected `agent_jobs` when both runner and worker threads are in the deletion set, deletes `thread_dynamic_tools`, requeues running `agent_job_items` assigned to deleted threads with an error message, clears any remaining `assigned_thread_id`s, deletes spawn edges for each thread, then deletes thread rows and sums `rows_affected`. Finally it commits and returns the count.

**Call relations**: `delete_thread` delegates here for all cleanup work. The ordering is intentional: dependent state is removed before spawn edges and thread rows so a failure leaves enough graph information to rediscover and retry the same subtree cleanup.

*Call graph*: called by 1 (delete_thread); 4 external calls (now, is_empty, iter, query).


##### `one_thread_id_from_rows`  (lines 1023–1041)

```
fn one_thread_id_from_rows(
    rows: Vec<sqlx::sqlite::SqliteRow>,
    agent_path: &str,
) -> anyhow::Result<Option<ThreadId>>
```

**Purpose**: Converts up to two SQL rows containing thread IDs into an optional unique `ThreadId`, rejecting ambiguous matches. It is used by path-based spawn lookups.

**Data flow**: It takes a vector of `SqliteRow` and the queried `agent_path`, extracts each `id` string, converts them to `ThreadId`, and then returns `Ok(None)` for zero rows, `Ok(Some(id))` for one row, or an `anyhow!` error mentioning the canonical path when multiple rows were found.

**Call relations**: Both `find_thread_spawn_child_by_path` and `find_thread_spawn_descendant_by_path` delegate their post-query uniqueness check to this helper so duplicate-path handling is consistent.

*Call graph*: called by 2 (find_thread_spawn_child_by_path, find_thread_spawn_descendant_by_path); 1 external calls (anyhow!).


##### `push_list_threads_query`  (lines 1043–1072)

```
fn push_list_threads_query(
    builder: &mut QueryBuilder<Sqlite>,
    filters: ThreadFilterOptions<'_>,
    parent_thread_id: Option<ThreadId>,
    limit: usize,
)
```

**Purpose**: Builds the full SQL for paginated thread listing, including selected columns, filters, optional parent-child restriction, and ordering/limit. It also chooses whether ORDER BY may use the timestamp index.

**Data flow**: Inputs are a mutable `QueryBuilder<Sqlite>`, `ThreadFilterOptions`, optional parent thread id, and limit. The function appends the shared select projection, `FROM threads`, shared filters, an `IN (SELECT child_thread_id ...)` clause when `parent_thread_id` is present, computes `OrderByIndex` based on `cwd_filters` cardinality, and appends ordering and limit.

**Call relations**: `list_threads_matching` uses this helper for production queries, and one test calls it directly under `EXPLAIN QUERY PLAN` to verify index selection. It composes `push_thread_select_columns`, `push_thread_filters`, and `push_thread_order_and_limit`.

*Call graph*: calls 3 internal fn (push_thread_filters, push_thread_order_and_limit, push_thread_select_columns); called by 2 (list_threads_matching, list_threads_uses_indexes_matching_cwd_filters); 2 external calls (push, push_bind).


##### `push_thread_select_columns`  (lines 1074–1104)

```
fn push_thread_select_columns(builder: &mut QueryBuilder<Sqlite>)
```

**Purpose**: Appends the canonical thread column projection used when decoding rows into `ThreadMetadata`. It keeps all thread-reading queries aligned on the same selected fields and aliases.

**Data flow**: It mutates the provided `QueryBuilder<Sqlite>` by pushing a multiline `SELECT` clause covering ids, rollout path, millisecond timestamps aliased as `created_at`/`updated_at`, source fields, model fields, preview/title, archive timestamp, and git fields.

**Call relations**: This helper is called by `find_thread_by_exact_title` and `push_list_threads_query`. Centralizing the projection reduces drift between different thread-reading queries.

*Call graph*: called by 2 (find_thread_by_exact_title, push_list_threads_query); 1 external calls (push).


##### `extract_memory_mode`  (lines 1106–1115)

```
fn extract_memory_mode(items: &[RolloutItem]) -> Option<String>
```

**Purpose**: Finds the most recent memory-mode value present in a rollout item batch. It scans from the end so later session metadata wins.

**Data flow**: It takes a slice of `RolloutItem`, iterates it in reverse, and returns the first `meta.memory_mode.clone()` found on a `RolloutItem::SessionMeta`. All other rollout item variants are ignored, yielding `None` if no session metadata carries a memory mode.

**Call relations**: `apply_rollout_items` calls this after persisting metadata so it can restore or update the dedicated `threads.memory_mode` column from rollout content.

*Call graph*: called by 1 (apply_rollout_items); 1 external calls (iter).


##### `thread_spawn_parent_thread_id_from_source_str`  (lines 1117–1121)

```
fn thread_spawn_parent_thread_id_from_source_str(source: &str) -> Option<ThreadId>
```

**Purpose**: Parses a serialized thread source string and extracts an encoded parent thread id when present. It accepts either full JSON or a plain string form convertible into `SessionSource`.

**Data flow**: It takes a source `&str`, first tries `serde_json::from_str`, then falls back to wrapping the string in `Value::String` and deserializing that into `SessionSource`. If parsing succeeds, it calls `parent_thread_id()` on the parsed source and returns the resulting `Option<ThreadId>`.

**Call relations**: This parser is used only by `insert_thread_spawn_edge_from_source_if_absent` to infer persisted spawn edges from thread source metadata during inserts/upserts.

*Call graph*: called by 1 (insert_thread_spawn_edge_from_source_if_absent); 1 external calls (from_str).


##### `push_thread_filters`  (lines 1135–1213)

```
fn push_thread_filters(
    builder: &mut QueryBuilder<Sqlite>,
    options: ThreadFilterOptions<'a>,
)
```

**Purpose**: Appends the shared `WHERE` predicates for thread visibility, source/provider/cwd filtering, search, and keyset anchor pagination. It encodes several important invariants, including excluding blank-preview rows from listings.

**Data flow**: It destructures `ThreadFilterOptions`, mutates the provided `QueryBuilder<Sqlite>`, and appends predicates for archived vs visible rows, `threads.preview <> ''`, optional source and provider `IN` lists, cwd filtering (`Some([])` becomes `AND 1 = 0`), optional substring search over title or preview using `instr`, and optional anchor comparison against either `created_at_ms` or `updated_at_ms` with direction-sensitive `>` or `<`.

**Call relations**: This helper is reused by `claim_stage1_jobs_for_startup`, `find_thread_by_exact_title`, `list_thread_ids`, and `push_list_threads_query`. It is the central place where thread-list semantics and pagination predicates are defined.

*Call graph*: called by 4 (claim_stage1_jobs_for_startup, find_thread_by_exact_title, list_thread_ids, push_list_threads_query); 3 external calls (push, push_bind, separated).


##### `push_thread_order_and_limit`  (lines 1225–1252)

```
fn push_thread_order_and_limit(
    builder: &mut QueryBuilder<Sqlite>,
    sort_key: SortKey,
    sort_direction: SortDirection,
    order_by_index: OrderByIndex,
    limit: usize,
)
```

**Purpose**: Appends the `ORDER BY` and `LIMIT` clause for thread queries, with optional suppression of index-based ordering. It supports both created-at and updated-at sorting in ascending or descending order.

**Data flow**: Inputs are a mutable `QueryBuilder<Sqlite>`, `SortKey`, `SortDirection`, `OrderByIndex`, and limit. The function chooses the timestamp column and SQL direction string, optionally prefixes the ordered column with unary `+` when index ordering is disabled, then pushes `ORDER BY ... LIMIT ?` and binds the limit as `i64`.

**Call relations**: This helper is called by `find_thread_by_exact_title`, `list_thread_ids`, and `push_list_threads_query`. It works with `OrderByIndex` to preserve better filtering plans for multi-cwd queries.

*Call graph*: called by 3 (find_thread_by_exact_title, list_thread_ids, push_list_threads_query); 2 external calls (push, push_bind).


##### `metadata_preview`  (lines 1254–1260)

```
fn metadata_preview(metadata: &crate::ThreadMetadata) -> &str
```

**Purpose**: Computes the preview text that should be stored for a thread from available metadata fields. It prefers explicit preview, then falls back to first user message, then empty string.

**Data flow**: It reads a borrowed `ThreadMetadata` and returns a borrowed `&str` chosen from `metadata.preview`, `metadata.first_user_message`, or `""`. No allocation or external state is involved.

**Call relations**: Both `insert_thread_if_absent` and `upsert_thread_with_creation_memory_mode` call this helper before binding the `preview` column, ensuring consistent fallback behavior across insert and upsert paths.

*Call graph*: called by 2 (insert_thread_if_absent, upsert_thread_with_creation_memory_mode).


##### `tests::upsert_thread_keeps_creation_memory_mode_for_existing_rows`  (lines 1280–1315)

```
async fn upsert_thread_keeps_creation_memory_mode_for_existing_rows()
```

**Purpose**: Verifies that the special creation-time memory mode is applied only on first insert and is not overwritten by later ordinary upserts. This protects the initial thread memory-mode choice.

**Data flow**: The test creates a runtime and deterministic metadata, inserts the thread through `upsert_thread_with_creation_memory_mode(..., Some("disabled"))`, reads `memory_mode` directly from SQLite, then modifies the title and calls `upsert_thread`. It reads `memory_mode` again and asserts it remains `disabled`.

**Call relations**: This async test drives both the specialized insert path and the normal upsert path to validate their interaction around the `memory_mode` column.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 2 external calls (assert_eq!, query_scalar).


##### `tests::delete_thread_cleans_associated_state`  (lines 1318–1406)

```
async fn delete_thread_cleans_associated_state() -> Result<()>
```

**Purpose**: Checks that strict thread deletion removes or repairs all related state: logs, goals, dynamic tools, spawn edges, and agent-job assignments/status. It also verifies the behavior when deleting a missing thread id that still has associated state.

**Data flow**: It initializes a runtime, inserts a thread, seeds cleanup-related state through `seed_thread_cleanup_state`, inserts a dynamic tool, creates and starts an agent job with a running item assigned to a child thread, then calls `delete_threads_strict` on parent and child. The test asserts thread removal count, absence of the thread row, zero dynamic tools, cleaned logs/goals/spawn edges via `assert_thread_cleanup_state`, pending/unassigned job item state, and cancelled job status. It then seeds state for a missing thread id and confirms `delete_thread` returns `0` while still cleaning associated state.

**Call relations**: This test exercises the full cleanup orchestration in `delete_threads_strict`, along with helper fixtures `seed_thread_cleanup_state` and `assert_thread_cleanup_state`, under both existing-row and missing-row scenarios.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 8 external calls (assert!, assert_eq!, json!, query, query_scalar, assert_thread_cleanup_state, seed_thread_cleanup_state, vec!).


##### `tests::delete_thread_keeps_retry_graph_on_cleanup_failure`  (lines 1409–1435)

```
async fn delete_thread_keeps_retry_graph_on_cleanup_failure() -> Result<()>
```

**Purpose**: Ensures a cleanup failure does not remove the thread row or spawn-edge graph needed for a later retry. It specifically simulates failure by closing the logs database before deletion.

**Data flow**: The test creates a runtime, inserts a thread, seeds cleanup state, closes `runtime.logs_pool`, and calls `delete_thread`, expecting an error. It then reads the thread back and lists descendants from the parent, asserting both the thread row and child edge remain present.

**Call relations**: This async test validates the retry-safety design of `delete_threads_strict`: because log deletion happens before thread-row and edge deletion, an early failure leaves enough state to rediscover the same subtree.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 3 external calls (assert!, assert_eq!, seed_thread_cleanup_state).


##### `tests::seed_thread_cleanup_state`  (lines 1437–1463)

```
async fn seed_thread_cleanup_state(
        runtime: &StateRuntime,
        thread_id: ThreadId,
        child_thread_id: ThreadId,
    ) -> Result<()>
```

**Purpose**: Creates the minimal associated state needed to exercise thread cleanup logic in tests. It adds a spawn edge, a thread goal, and a log row.

**Data flow**: Inputs are a runtime, parent thread id, and child thread id. The helper inserts a closed spawn edge with `upsert_thread_spawn_edge`, writes a thread goal through `thread_goals().replace_thread_goal`, inserts a log row into `logs_pool`, and returns `Result<()>`.

**Call relations**: Cleanup tests call this helper before invoking deletion paths. It prepares the dependent state that `delete_threads_strict` is expected to remove.

*Call graph*: calls 1 internal fn (thread_goals); 3 external calls (to_string, query, upsert_thread_spawn_edge).


##### `tests::assert_thread_cleanup_state`  (lines 1465–1489)

```
async fn assert_thread_cleanup_state(
        runtime: &StateRuntime,
        thread_id: ThreadId,
    ) -> Result<()>
```

**Purpose**: Asserts that cleanup-related state for a thread has been fully removed. It checks spawn edges, thread goals, and logs.

**Data flow**: Given a runtime and thread id, it queries the count of matching `thread_spawn_edges`, fetches the thread goal through `thread_goals().get_thread_goal`, queries logs through `query_logs` with a `LogQuery` filtered to the thread id, and asserts zero edges, no goal, and an empty log result.

**Call relations**: Deletion tests call this helper after cleanup operations to verify the side effects of `delete_threads_strict` beyond just the `threads` table.

*Call graph*: 7 external calls (default, assert!, assert_eq!, to_string, query_scalar, query_logs, vec!).


##### `tests::list_threads_updated_after_returns_oldest_changes_first`  (lines 1492–1573)

```
async fn list_threads_updated_after_returns_oldest_changes_first()
```

**Purpose**: Validates ascending keyset pagination over `updated_at`, especially when multiple rows share the same second-level timestamp but differ at millisecond precision. It confirms that pages advance from the oldest qualifying change to newer ones.

**Data flow**: The test inserts three threads with controlled `updated_at` values, constructs an `Anchor` at the oldest timestamp, and calls `list_threads` twice with page size 1, ascending `UpdatedAt`, and a provider filter. It collects returned ids and anchors and asserts the first page yields the newer thread, the second yields the middle thread, and pagination terminates correctly.

**Call relations**: This test exercises `list_threads`, `push_thread_filters`, `push_thread_order_and_limit`, and the anchor computation in `list_threads_matching` under ascending-order pagination.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 2 external calls (from_timestamp, assert_eq!).


##### `tests::list_threads_filters_by_cwd`  (lines 1576–1680)

```
async fn list_threads_filters_by_cwd()
```

**Purpose**: Checks that thread listing can restrict results to one or more working directories and that an explicit empty cwd filter yields no rows. It also verifies pagination order within the filtered subset.

**Data flow**: It inserts three threads with distinct cwd values and timestamps, then calls `list_threads` twice with a two-entry cwd filter and descending `UpdatedAt`, asserting the two matching threads arrive in newest-first order across pages. It then calls `list_threads` with `cwd_filters: Some(&[])` and asserts the returned page is empty.

**Call relations**: This test validates the cwd branches inside `push_thread_filters` and the pagination behavior of `list_threads_matching` when cwd filtering is active.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 3 external calls (from_timestamp, assert_eq!, vec!).


##### `tests::list_threads_uses_indexes_matching_cwd_filters`  (lines 1683–1760)

```
async fn list_threads_uses_indexes_matching_cwd_filters()
```

**Purpose**: Pins the query-plan choices for thread listing so cwd-filtered queries continue using the intended indexes. It also checks when SQLite must fall back to a temporary sort.

**Data flow**: The test initializes a runtime, defines provider filters, cwd filters, and an anchor, then for each sort key and cwd/anchor combination builds `EXPLAIN QUERY PLAN` SQL via `push_list_threads_query`. It executes the plan query, collects the `detail` strings, and asserts that the expected visible or cwd-specific index appears and that `TEMP B-TREE` sorting is present only in the expected cases.

**Call relations**: This test directly exercises `push_list_threads_query` and, indirectly, `push_thread_filters` and `push_thread_order_and_limit`, to lock in the planner-sensitive `OrderByIndex` behavior.

*Call graph*: calls 3 internal fn (init, unique_temp_dir, push_list_threads_query); 5 external calls (from_timestamp, from, new, assert!, assert_eq!).


##### `tests::list_threads_by_parent_filters_direct_children_with_keyset_pagination`  (lines 1763–1852)

```
async fn list_threads_by_parent_filters_direct_children_with_keyset_pagination()
```

**Purpose**: Verifies that parent-scoped listing returns only direct children, not deeper descendants, and still honors keyset pagination by the chosen sort key. It uses persisted spawn edges rather than rollout-derived relationships.

**Data flow**: The test inserts metadata for two direct children and one grandchild with controlled creation times, inserts spawn edges linking parent→children and child→grandchild, then calls `list_threads_by_parent` twice with page size 1 and descending `CreatedAt`. It asserts the pages contain only the two direct children in the expected order and that pagination ends after the second page.

**Call relations**: This async test drives `upsert_thread_spawn_edge` and `list_threads_by_parent`, validating the parent restriction injected by `push_list_threads_query` on top of normal thread filtering and pagination.

*Call graph*: calls 5 internal fn (from_string, new, init, test_thread_metadata, unique_temp_dir); 2 external calls (from_timestamp, assert_eq!).


##### `tests::apply_rollout_items_restores_memory_mode_from_session_meta`  (lines 1855–1911)

```
async fn apply_rollout_items_restores_memory_mode_from_session_meta()
```

**Purpose**: Confirms that applying rollout items updates the dedicated `threads.memory_mode` column from the latest session metadata. This guards against stale or missing memory-mode state after rollout reconciliation.

**Data flow**: It inserts an initial thread, constructs a `ThreadMetadataBuilder` and a single `RolloutItem::SessionMeta` carrying `memory_mode: Some("polluted")`, calls `apply_rollout_items`, then reads the persisted memory mode with `get_thread_memory_mode` and asserts it equals `Some("polluted")`.

**Call relations**: The test exercises the full rollout-application path, specifically the post-upsert `extract_memory_mode` and `set_thread_memory_mode` branch.

*Call graph*: calls 5 internal fn (from_string, new, init, test_thread_metadata, unique_temp_dir); 2 external calls (assert_eq!, vec!).


##### `tests::apply_rollout_items_preserves_existing_git_branch_and_fills_missing_git_fields`  (lines 1914–1982)

```
async fn apply_rollout_items_preserves_existing_git_branch_and_fills_missing_git_fields()
```

**Purpose**: Checks that rollout application merges git metadata conservatively: existing SQLite git fields win, but missing fields can still be filled from rollout data. This prevents stale rollout content from clobbering newer persisted git info.

**Data flow**: The test inserts a thread whose metadata already has `git_branch`, constructs rollout session metadata containing a different branch plus SHA and repository URL, applies the rollout items, then reloads the thread and asserts SHA and origin URL were filled from rollout while the existing branch remained unchanged.

**Call relations**: This test validates the interaction between `apply_rollout_items`, `prefer_existing_git_info`, and the git-preserving upsert semantics in `upsert_thread_with_creation_memory_mode`.

*Call graph*: calls 5 internal fn (from_string, new, init, test_thread_metadata, unique_temp_dir); 2 external calls (assert_eq!, vec!).


##### `tests::upsert_thread_preserves_existing_git_fields_atomically`  (lines 1985–2023)

```
async fn upsert_thread_preserves_existing_git_fields_atomically()
```

**Purpose**: Verifies that a later upsert cannot overwrite non-null git fields already stored in SQLite. The guarantee is enforced atomically in SQL rather than by a fragile read-modify-write sequence.

**Data flow**: It inserts a thread with all three git fields populated, clones the metadata with different rollout git values, calls `upsert_thread` again, then reloads the thread and asserts the original SQLite git SHA, branch, and origin URL remain intact.

**Call relations**: This test targets the `COALESCE(threads.git_*, excluded.git_*)` conflict-update expressions inside `upsert_thread_with_creation_memory_mode`, reached through the public `upsert_thread` wrapper.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 1 external calls (assert_eq!).


##### `tests::upsert_thread_preserves_existing_preview_when_incoming_preview_is_empty`  (lines 2026–2056)

```
async fn upsert_thread_preserves_existing_preview_when_incoming_preview_is_empty()
```

**Purpose**: Ensures that an upsert with no preview does not erase an existing non-empty preview. This protects migrated or derived previews from being blanked by sparse rollout metadata.

**Data flow**: The test inserts a thread whose `preview` is set and `first_user_message` is absent, clones the metadata with `preview = None`, calls `upsert_thread`, then reloads the thread and asserts the original preview string is still present.

**Call relations**: This test validates the preview-preservation clause in the upsert conflict update, reached through `upsert_thread`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 1 external calls (assert_eq!).


##### `tests::set_thread_preview_if_empty_only_fills_blank_preview`  (lines 2059–2097)

```
async fn set_thread_preview_if_empty_only_fills_blank_preview()
```

**Purpose**: Checks the exact semantics of `set_thread_preview_if_empty`: whitespace-only input is ignored, the first non-empty preview fills a blank row, and later calls do not overwrite it. It also confirms trimming behavior.

**Data flow**: It inserts a thread with neither preview nor first user message, calls `set_thread_preview_if_empty` with whitespace, then with padded text, then with a replacement string. The test asserts the returned booleans are false/true/false respectively and reloads the thread to confirm the stored preview is the trimmed first non-empty value.

**Call relations**: This test directly exercises the narrow preview-fill update path and its guard conditions.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 2 external calls (assert!, assert_eq!).


##### `tests::update_thread_git_info_preserves_newer_non_git_metadata`  (lines 2100–2159)

```
async fn update_thread_git_info_preserves_newer_non_git_metadata()
```

**Purpose**: Verifies that updating git fields does not revert newer non-git metadata written concurrently. It demonstrates why git updates are isolated from full metadata upserts.

**Data flow**: The test inserts a thread, then directly updates `updated_at`, `tokens_used`, `first_user_message`, and `preview` in SQLite to simulate a newer concurrent write. It calls `update_thread_git_info` to set all git fields, reloads the thread, and asserts the newer non-git values and timestamp remain while git fields were updated.

**Call relations**: This test targets the focused `update_thread_git_info` SQL path and contrasts it with the broader upsert behavior that could otherwise overwrite unrelated columns.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 4 external calls (from_timestamp, assert!, assert_eq!, query).


##### `tests::insert_thread_if_absent_preserves_existing_metadata`  (lines 2162–2207)

```
async fn insert_thread_if_absent_preserves_existing_metadata()
```

**Purpose**: Confirms that `insert_thread_if_absent` is truly non-destructive when the row already exists. Existing tokens, preview, first user message, and timestamp must remain untouched.

**Data flow**: It inserts an initial thread with newer metadata values, constructs an older fallback metadata object for the same id, calls `insert_thread_if_absent`, asserts the returned flag is false, then reloads the thread and checks that the original persisted values are unchanged.

**Call relations**: This test exercises the `ON CONFLICT DO NOTHING` insert path and verifies that it can be safely used as a fallback without clobbering current state.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 3 external calls (from_timestamp, assert!, assert_eq!).


##### `tests::update_thread_git_info_can_clear_fields`  (lines 2210–2241)

```
async fn update_thread_git_info_can_clear_fields()
```

**Purpose**: Checks that `update_thread_git_info` can explicitly clear git fields by passing `Some(None)` for each one. This distinguishes clearing from leaving a field unchanged.

**Data flow**: The test inserts a thread with all git fields populated, calls `update_thread_git_info(thread_id, Some(None), Some(None), Some(None))`, asserts the update touched the row, then reloads the thread and verifies all three git fields are now `None`.

**Call relations**: This test validates the tri-state parameter semantics encoded in `update_thread_git_info`'s SQL `CASE` expressions.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 2 external calls (assert!, assert_eq!).


##### `tests::touch_thread_updated_at_updates_only_updated_at`  (lines 2244–2280)

```
async fn touch_thread_updated_at_updates_only_updated_at()
```

**Purpose**: Ensures that touching a thread's timestamp changes only `updated_at` and leaves title, first user message, and preview intact. It also confirms preview fallback remains readable after the touch.

**Data flow**: It inserts a thread with known title and first user message, calls `touch_thread_updated_at` with a later timestamp, asserts the returned boolean is true, then reloads the thread and checks that only `updated_at` changed while other metadata stayed the same.

**Call relations**: This test directly exercises the narrow timestamp-update path and its use of `allocate_thread_updated_at` without invoking a full metadata upsert.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 3 external calls (from_timestamp, assert!, assert_eq!).


##### `tests::thread_updated_at_uses_unique_epoch_millis_and_reads_legacy_seconds`  (lines 2283–2378)

```
async fn thread_updated_at_uses_unique_epoch_millis_and_reads_legacy_seconds()
```

**Purpose**: Pins the timestamp allocation and decoding rules for thread ordering. It verifies unique millisecond allocation for same-time writes, preservation of sufficiently older timestamps, and compatibility with legacy rows that only have second-level `updated_at`.

**Data flow**: The test inserts two threads with identical millisecond timestamps and asserts the second persisted row was bumped by one millisecond, then inspects raw SQLite timestamp columns. It inserts a third thread with an older timestamp and confirms it was preserved unchanged. Finally it manually writes a legacy second-level `updated_at` into SQLite for one thread, reloads it through `get_thread`, and asserts it is interpreted as whole-second milliseconds.

**Call relations**: This test exercises `allocate_thread_updated_at`, the insert/upsert paths that call it, and the row-decoding logic used by `get_thread` for legacy timestamp compatibility.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 4 external calls (from_timestamp_millis, assert_eq!, query, query_as).


##### `tests::apply_rollout_items_uses_override_updated_at_when_provided`  (lines 2381–2437)

```
async fn apply_rollout_items_uses_override_updated_at_when_provided()
```

**Purpose**: Checks that rollout application honors an explicit `updated_at_override` instead of using the rollout file's modified time. This lets callers control ordering when replaying or repairing rollout data.

**Data flow**: It inserts an initial thread, builds a rollout item carrying token usage, chooses an override timestamp, calls `apply_rollout_items` with that override, then reloads the thread and asserts both `tokens_used` and `updated_at` reflect the rollout content and supplied override.

**Call relations**: This test targets the `updated_at_override` branch inside `apply_rollout_items`, ensuring it wins over file mtime lookup.

*Call graph*: calls 5 internal fn (from_string, new, init, test_thread_metadata, unique_temp_dir); 3 external calls (from_timestamp, assert_eq!, vec!).


##### `tests::thread_spawn_edges_track_directional_status`  (lines 2440–2533)

```
async fn thread_spawn_edges_track_directional_status()
```

**Purpose**: Verifies that spawn-edge status is persisted and respected by both direct-child and recursive descendant queries. It also checks that closing a parent edge prunes that branch from status-filtered descendant traversal while unfiltered traversal still sees all descendants.

**Data flow**: The test inserts parent→child and child→grandchild edges with `Open` status, queries open children and descendants, updates the child edge to `Closed`, then queries open and closed children/descendants plus unfiltered descendants. It asserts each returned `Vec<ThreadId>` matches the expected graph under the current statuses.

**Call relations**: This test exercises `upsert_thread_spawn_edge`, `set_thread_spawn_edge_status`, and all four public child/descendant listing methods to validate the status-filtered recursive SQL.

*Call graph*: calls 3 internal fn (from_string, init, unique_temp_dir); 1 external calls (assert_eq!).


##### `tests::thread_spawn_children_without_status_filter_lists_all_statuses`  (lines 2536–2594)

```
async fn thread_spawn_children_without_status_filter_lists_all_statuses()
```

**Purpose**: Confirms that unfiltered child listing returns every direct child regardless of status string, including unknown future statuses not represented by the current enum. This preserves forward compatibility for readers.

**Data flow**: It inserts open and closed child edges through `upsert_thread_spawn_edge`, inserts a third edge directly in SQL with status `future`, calls `list_thread_spawn_children`, and asserts the returned ids include all three children in sorted order.

**Call relations**: This test specifically validates the `None` status branch in `list_thread_spawn_children_matching`, showing that it does not constrain status values and therefore remains tolerant of newer statuses.

*Call graph*: calls 3 internal fn (from_string, init, unique_temp_dir); 2 external calls (assert_eq!, query).


### Goal and memory persistence
These files build higher-level per-thread state on top of the thread runtime, covering goal tracking and the memory-processing state machine.

### `state/src/model/thread_goal.rs`

`data_model` · `cross-cutting`

This module models goal-tracking state attached to a thread. `ThreadGoalStatus` is the central enum, covering active and paused execution states plus blocking and terminal budget/completion outcomes. It derives `Serialize` with `snake_case` names, and also exposes explicit string helpers and predicates so callers can consistently persist, display, and reason about status transitions.

`ThreadGoal` is the typed domain struct used by the rest of the runtime. It stores a parsed `ThreadId`, goal identifier, objective text, status, optional token budget, usage counters, and UTC creation/update timestamps. `ThreadGoalRow` is the raw storage-facing counterpart with string IDs/statuses and integer millisecond timestamps.

The conversion path is split in two. `ThreadGoalRow::try_from_row` extracts named columns from a `SqliteRow` without interpretation beyond SQLx type conversion. `TryFrom<ThreadGoalRow> for ThreadGoal` then performs semantic decoding: it parses the thread ID via `ThreadId::try_from`, converts the status string via `ThreadGoalStatus::try_from`, and turns millisecond timestamps into `DateTime<Utc>` using the shared `epoch_millis_to_datetime` helper from the parent model module. This separation keeps SQL row extraction simple while concentrating validation and normalization in one place. The status predicates (`is_active`, `is_terminal`) encode business meaning directly on the enum for downstream scheduling and accounting logic.

#### Function details

##### `ThreadGoalStatus::as_str`  (lines 24–33)

```
fn as_str(self) -> &'static str
```

**Purpose**: Returns the canonical lowercase string form of a thread-goal status. It provides the stable persisted/display representation for each enum variant.

**Data flow**: It takes `self`, matches on the variant, and returns a `&'static str` such as `"usage_limited"` or `"complete"`.

**Call relations**: This helper is used by code that writes or compares thread-goal statuses in textual form.


##### `ThreadGoalStatus::is_active`  (lines 35–37)

```
fn is_active(self) -> bool
```

**Purpose**: Checks whether the goal is currently in the active state. It is a narrow predicate rather than a broader non-terminal test.

**Data flow**: It compares `self` to `Self::Active` and returns a `bool` with no side effects.

**Call relations**: Higher-level goal logic uses this predicate when deciding whether a thread goal should continue consuming work or resources.


##### `ThreadGoalStatus::is_terminal`  (lines 39–41)

```
fn is_terminal(self) -> bool
```

**Purpose**: Checks whether the goal has reached a terminal state that should stop further progression. In this model, `BudgetLimited` and `Complete` are terminal.

**Data flow**: It evaluates a `matches!` expression over `self` and returns `true` only for the terminal variants.

**Call relations**: Goal orchestration and accounting code can use this helper to gate updates or completion handling.

*Call graph*: 1 external calls (matches!).


##### `ThreadGoalStatus::try_from`  (lines 47–57)

```
fn try_from(value: &str) -> Result<Self>
```

**Purpose**: Parses a stored status string into a `ThreadGoalStatus`. It fails fast on unknown values instead of defaulting.

**Data flow**: It accepts a `&str`, matches it against the six supported literals, returns the corresponding enum variant, or constructs an `anyhow!` error containing the unexpected string.

**Call relations**: The `ThreadGoal` conversion path calls this while turning a `ThreadGoalRow` into a typed domain object.

*Call graph*: 1 external calls (anyhow!).


##### `ThreadGoalRow::try_from_row`  (lines 86–98)

```
fn try_from_row(row: &SqliteRow) -> Result<Self>
```

**Purpose**: Extracts the raw thread-goal columns from a SQLite row into a `ThreadGoalRow`. It is the storage-facing first stage of row decoding.

**Data flow**: It borrows a `SqliteRow`, reads each named column with `try_get`, and returns a `ThreadGoalRow` containing strings, integers, and optional integers exactly as stored.

**Call relations**: Callers such as `thread_goal_from_row` invoke this immediately after a SQL query. Semantic validation is deferred to `ThreadGoal::try_from`.

*Call graph*: called by 1 (thread_goal_from_row); 1 external calls (try_get).


##### `ThreadGoal::try_from`  (lines 104–116)

```
fn try_from(row: ThreadGoalRow) -> Result<Self>
```

**Purpose**: Converts a raw `ThreadGoalRow` into a validated `ThreadGoal`. It parses the thread ID and status and converts millisecond timestamps into UTC datetimes.

**Data flow**: It consumes a `ThreadGoalRow`, passes `row.thread_id` into `ThreadId::try_from`, parses `row.status` with `ThreadGoalStatus::try_from`, copies scalar counters and optional budget directly, converts `created_at_ms` and `updated_at_ms` via `epoch_millis_to_datetime`, and returns the assembled `ThreadGoal` or an error.

**Call relations**: This is the second stage after `ThreadGoalRow::try_from_row`, providing the typed object used by the rest of the goal subsystem.

*Call graph*: calls 1 internal fn (try_from); 2 external calls (try_from, epoch_millis_to_datetime).


### `state/src/runtime/goals.rs`

`domain_logic` · `thread lifecycle, goal editing, and per-turn usage accounting`

This file defines `GoalStore`, the update payload type `GoalUpdate`, and two enums that describe accounting results and accounting modes. `GoalStore` wraps an `Arc<SqlitePool>` and provides CRUD plus accounting operations for `crate::ThreadGoal` rows keyed by `thread_id`. New or replaced goals get a fresh UUID `goal_id`, which acts as a version token; callers can pass `expected_goal_id` to reject stale updates after a replacement.

The core logic lives in `update_thread_goal` and `account_thread_goal_usage`. `update_thread_goal` has four SQL branches depending on whether status and/or token budget are being changed. Those branches preserve independent fields with `COALESCE`, update `updated_at_ms`, and enforce an important invariant: if a goal is already `BudgetLimited`, attempts to set it to `Paused` or `Blocked` keep the terminal budget-limited status instead. Likewise, activating a goal that is already over budget immediately resolves back to `BudgetLimited`. `account_thread_goal_usage` increments `time_used_seconds` and `tokens_used` atomically with a `QueryBuilder` update, choosing which statuses are eligible based on `GoalAccountingMode`; it can account only active goals, active plus budget-limited, active plus complete, or active plus stopped states.

Helper functions convert rows (`thread_goal_from_row`) and compute immediate budget-limited status on insertion/replacement (`status_after_budget_limit`). The extensive tests cover replacement semantics, stale-version rejection, concurrent partial updates, budget crossings, stopped/completed final accounting, and deletion via thread cascade.

#### Function details

##### `GoalStore::new`  (lines 11–13)

```
fn new(pool: Arc<SqlitePool>) -> Self
```

**Purpose**: Constructs a `GoalStore` wrapper around the shared SQLite pool. It is a lightweight initializer with no side effects beyond storing the pool handle.

**Data flow**: Consumes `Arc<SqlitePool>` and returns `GoalStore { pool }`.

**Call relations**: Called during runtime initialization to wire goal persistence into the larger `StateRuntime`.

*Call graph*: called by 1 (init_inner).


##### `GoalStore::close`  (lines 15–17)

```
async fn close(&self)
```

**Purpose**: Closes the underlying SQLite pool used by the goal store. This is part of runtime shutdown cleanup.

**Data flow**: Reads `self.pool` and awaits `close()` on it; it returns no value.

**Call relations**: Invoked by the enclosing runtime close path when tearing down database resources.

*Call graph*: called by 1 (close).


##### `GoalStore::get_thread_goal`  (lines 41–66)

```
async fn get_thread_goal(
        &self,
        thread_id: ThreadId,
    ) -> anyhow::Result<Option<crate::ThreadGoal>>
```

**Purpose**: Fetches the current goal row for one thread and converts it into `crate::ThreadGoal`. Missing rows return `None`.

**Data flow**: Takes `thread_id`, stringifies it, selects all goal columns from `thread_goals`, fetches an optional row, and maps it through `thread_goal_from_row`. Returns `Option<ThreadGoal>` in `anyhow::Result`.

**Call relations**: This is the common read helper used after updates and by accounting paths when no mutation occurs, so callers always see the canonical persisted row.

*Call graph*: called by 3 (account_thread_goal_usage, update_active_thread_goal_status, update_thread_goal); 2 external calls (to_string, query).


##### `GoalStore::replace_thread_goal`  (lines 68–123)

```
async fn replace_thread_goal(
        &self,
        thread_id: ThreadId,
        objective: &str,
        status: crate::ThreadGoalStatus,
        token_budget: Option<i64>,
    ) -> anyhow::Result<c
```

**Purpose**: Creates a fresh goal version for a thread, replacing any existing row unconditionally and resetting usage counters. It immediately applies budget-limit logic if the requested active goal is already over budget.

**Data flow**: Consumes `thread_id`, `objective`, desired `status`, and optional `token_budget`; generates a new UUID `goal_id`, computes `now_ms`, normalizes status through `status_after_budget_limit`, then performs an `INSERT ... ON CONFLICT(thread_id) DO UPDATE` that overwrites goal identity and resets `tokens_used` and `time_used_seconds` to zero. It fetches the returned row and converts it with `thread_goal_from_row`.

**Call relations**: Used when callers want a brand-new goal version regardless of prior state. It delegates budget normalization to `status_after_budget_limit` and row decoding to `thread_goal_from_row`.

*Call graph*: calls 2 internal fn (status_after_budget_limit, thread_goal_from_row); 5 external calls (now, new_v4, as_str, to_string, query).


##### `GoalStore::insert_thread_goal`  (lines 125–181)

```
async fn insert_thread_goal(
        &self,
        thread_id: ThreadId,
        objective: &str,
        status: crate::ThreadGoalStatus,
        token_budget: Option<i64>,
    ) -> anyhow::Result<Op
```

**Purpose**: Attempts to create a new goal version only when there is no existing goal or the existing goal is already complete. Active/incomplete goals are left untouched.

**Data flow**: Reads the same inputs as `replace_thread_goal`, generates a new UUID and timestamp, normalizes status with `status_after_budget_limit`, and executes an `INSERT ... ON CONFLICT(thread_id) DO UPDATE ... WHERE thread_goals.status = 'complete' RETURNING ...`. It returns `Some(goal)` if insertion/replacement happened, otherwise `None`.

**Call relations**: This is the conservative creation path for callers that must not clobber an active goal. It shares the same normalization logic as `replace_thread_goal`.

*Call graph*: calls 1 internal fn (status_after_budget_limit); 5 external calls (now, new_v4, as_str, to_string, query).


##### `GoalStore::update_thread_goal`  (lines 183–330)

```
async fn update_thread_goal(
        &self,
        thread_id: ThreadId,
        update: GoalUpdate,
    ) -> anyhow::Result<Option<crate::ThreadGoal>>
```

**Purpose**: Applies partial updates to objective, status, and/or token budget while preserving untouched fields and optionally enforcing optimistic concurrency via `expected_goal_id`. It also preserves budget-limited terminal semantics when appropriate.

**Data flow**: Consumes `thread_id` and `GoalUpdate`, derives borrowed optional values, computes `now_ms`, then chooses one of four SQL update shapes based on whether `status` and `token_budget` are present. The SQL uses `COALESCE` for objective, conditional `CASE` expressions for status transitions, and `goal_id` matching when `expected_goal_id` is supplied. If no fields are provided, it either returns the current goal or `None` on version mismatch. After a successful update it reloads the row with `get_thread_goal`.

**Call relations**: This is the main mutation API for existing goals. It calls `GoalStore::get_thread_goal` both for the no-op/objective-absent branch and after successful updates so callers receive the fully decoded current row.

*Call graph*: calls 1 internal fn (get_thread_goal); 3 external calls (now, to_string, query).


##### `GoalStore::pause_active_thread_goal`  (lines 332–338)

```
async fn pause_active_thread_goal(
        &self,
        thread_id: ThreadId,
    ) -> anyhow::Result<Option<crate::ThreadGoal>>
```

**Purpose**: Convenience wrapper that pauses an active goal if and only if it is currently in a pausable state. It does not override terminal statuses.

**Data flow**: Takes `thread_id` and forwards it with `ThreadGoalStatus::Paused` to `update_active_thread_goal_status`, returning that method’s optional updated goal.

**Call relations**: This is a narrow helper over `GoalStore::update_active_thread_goal_status`, used when callers want the standard pause transition without constructing a full `GoalUpdate`.

*Call graph*: calls 1 internal fn (update_active_thread_goal_status).


##### `GoalStore::usage_limit_active_thread_goal`  (lines 340–346)

```
async fn usage_limit_active_thread_goal(
        &self,
        thread_id: ThreadId,
    ) -> anyhow::Result<Option<crate::ThreadGoal>>
```

**Purpose**: Convenience wrapper that marks an active or budget-limited goal as `UsageLimited`. It is intended for external usage-limit enforcement.

**Data flow**: Consumes `thread_id` and delegates to `update_active_thread_goal_status` with `ThreadGoalStatus::UsageLimited`, returning the optional updated goal.

**Call relations**: Like `pause_active_thread_goal`, this is a specialized front door into `GoalStore::update_active_thread_goal_status`.

*Call graph*: calls 1 internal fn (update_active_thread_goal_status).


##### `GoalStore::update_active_thread_goal_status`  (lines 348–382)

```
async fn update_active_thread_goal_status(
        &self,
        thread_id: ThreadId,
        status: crate::ThreadGoalStatus,
    ) -> anyhow::Result<Option<crate::ThreadGoal>>
```

**Purpose**: Performs a constrained status transition for active goals, and for `UsageLimited` also allows promotion from `BudgetLimited`. It refuses to touch completed or otherwise terminal rows.

**Data flow**: Reads `thread_id` and target `status`, computes `now_ms`, and updates `thread_goals` where `thread_id` matches and either current status is `active` or the requested status is `usage_limited` and current status is `budget_limited`. On success it reloads the row with `get_thread_goal`; otherwise it returns `None`.

**Call relations**: This is the shared implementation behind `pause_active_thread_goal` and `usage_limit_active_thread_goal`, centralizing the allowed-state checks.

*Call graph*: calls 1 internal fn (get_thread_goal); called by 2 (pause_active_thread_goal, usage_limit_active_thread_goal); 4 external calls (now, as_str, to_string, query).


##### `GoalStore::delete_thread_goal`  (lines 384–409)

```
async fn delete_thread_goal(
        &self,
        thread_id: ThreadId,
    ) -> anyhow::Result<Option<crate::ThreadGoal>>
```

**Purpose**: Deletes the goal row for a thread and returns the deleted goal if one existed. It uses SQLite `RETURNING` to avoid a separate pre-read.

**Data flow**: Consumes `thread_id`, stringifies it, executes `DELETE FROM thread_goals WHERE thread_id = ? RETURNING ...`, fetches an optional row, and converts it through `thread_goal_from_row`. Returns `Option<ThreadGoal>`.

**Call relations**: Used when callers explicitly remove a goal. Tests also verify that deleting the parent thread cascades away the goal row.

*Call graph*: 2 external calls (to_string, query).


##### `GoalStore::account_thread_goal_usage`  (lines 411–523)

```
async fn account_thread_goal_usage(
        &self,
        thread_id: ThreadId,
        time_delta_seconds: i64,
        token_delta: i64,
        mode: GoalAccountingMode,
        expected_goal_id: O
```

**Purpose**: Atomically adds token/time usage to a goal under mode-specific status rules and may transition the goal to `BudgetLimited` when the budget is crossed. It returns whether the row changed or remained unchanged.

**Data flow**: Consumes `thread_id`, `time_delta_seconds`, `token_delta`, `GoalAccountingMode`, and optional `expected_goal_id`; clamps negative deltas to zero and short-circuits to `Unchanged(current_goal)` when both are zero. Otherwise it computes `now_ms`, derives SQL status filters from the accounting mode, builds an `UPDATE ... RETURNING` query with `QueryBuilder` that increments counters and conditionally sets `status = BudgetLimited`, optionally constrains by `goal_id`, and fetches an optional row. It returns `GoalAccountingOutcome::Updated(decoded_goal)` on success or `Unchanged(current_goal)` if no row matched.

**Call relations**: This is the central accounting path for per-turn resource usage. It calls `GoalStore::get_thread_goal` when no mutation occurs and `thread_goal_from_row` when the SQL update returns a changed row.

*Call graph*: calls 2 internal fn (get_thread_goal, thread_goal_from_row); 5 external calls (new, now, to_string, Unchanged, Updated).


##### `thread_goal_from_row`  (lines 526–528)

```
fn thread_goal_from_row(row: &sqlx::sqlite::SqliteRow) -> anyhow::Result<crate::ThreadGoal>
```

**Purpose**: Converts a raw SQLite row into the domain `crate::ThreadGoal` through the intermediate `ThreadGoalRow` model. It centralizes row decoding for all goal queries.

**Data flow**: Takes `&sqlx::sqlite::SqliteRow`, calls `ThreadGoalRow::try_from_row`, then `crate::ThreadGoal::try_from`, returning the decoded goal or an error.

**Call relations**: Used by read, replace, delete, and accounting paths so all row-to-domain conversion follows one implementation.

*Call graph*: calls 1 internal fn (try_from_row); called by 2 (account_thread_goal_usage, replace_thread_goal).


##### `status_after_budget_limit`  (lines 530–542)

```
fn status_after_budget_limit(
    status: crate::ThreadGoalStatus,
    tokens_used: i64,
    token_budget: Option<i64>,
) -> crate::ThreadGoalStatus
```

**Purpose**: Normalizes a requested status so an active goal that is already at or above its token budget becomes `BudgetLimited` immediately. Other statuses pass through unchanged.

**Data flow**: Consumes a desired `ThreadGoalStatus`, `tokens_used`, and optional `token_budget`; if status is `Active` and `tokens_used >= budget`, returns `BudgetLimited`, else returns the original status.

**Call relations**: Called during insertion and replacement to enforce budget semantics before the row is first written.

*Call graph*: called by 2 (insert_thread_goal, replace_thread_goal).


##### `tests::test_runtime`  (lines 551–555)

```
async fn test_runtime() -> std::sync::Arc<StateRuntime>
```

**Purpose**: Creates a fresh `StateRuntime` backed by a unique temporary directory for goal-store tests. It hides repetitive initialization boilerplate.

**Data flow**: Calls `StateRuntime::init` with a unique temp dir and fixed provider string, returning an `Arc<StateRuntime>`.

**Call relations**: Most tests call this helper first to obtain an isolated runtime.

*Call graph*: calls 2 internal fn (init, unique_temp_dir).


##### `tests::test_thread_id`  (lines 557–559)

```
fn test_thread_id() -> ThreadId
```

**Purpose**: Returns a stable, known-valid `ThreadId` used across tests. This keeps assertions deterministic.

**Data flow**: Parses a fixed UUID string into `ThreadId` and returns it.

**Call relations**: Used by many tests as the canonical thread identifier under test.

*Call graph*: calls 1 internal fn (from_string).


##### `tests::upsert_test_thread`  (lines 561–571)

```
async fn upsert_test_thread(runtime: &StateRuntime, thread_id: ThreadId)
```

**Purpose**: Seeds the state database with thread metadata required before goal operations can be exercised. It ensures the thread row exists for foreign-key and integration behavior.

**Data flow**: Builds metadata with `test_thread_metadata` using the runtime’s `codex_home`, then calls `runtime.upsert_thread(&metadata)` and panics on failure.

**Call relations**: Most tests call this before interacting with `runtime.thread_goals()` so goal rows are associated with a real thread.

*Call graph*: calls 2 internal fn (codex_home, test_thread_metadata); 1 external calls (upsert_thread).


##### `tests::replace_update_and_get_thread_goal`  (lines 574–666)

```
async fn replace_update_and_get_thread_goal()
```

**Purpose**: Covers the basic lifecycle of replacing, reading, updating, replacing again, and deleting a thread goal. It also checks that unrelated thread metadata remains readable.

**Data flow**: Creates a runtime and thread, seeds metadata, performs `replace_thread_goal`, `get_thread_goal`, `update_thread_goal`, another replacement, and repeated deletions, asserting the returned `ThreadGoal` values and final absence.

**Call relations**: This is the broad smoke test for the main CRUD APIs on `GoalStore`.

*Call graph*: 4 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::replace_thread_goal_applies_budget_limit_immediately`  (lines 669–689)

```
async fn replace_thread_goal_applies_budget_limit_immediately()
```

**Purpose**: Verifies that replacing a goal with active status and a zero budget immediately stores it as `BudgetLimited`. This pins down insertion-time budget normalization.

**Data flow**: Seeds a thread, calls `replace_thread_goal` with `Active` and `Some(0)`, then asserts the returned goal has `BudgetLimited` status and zeroed counters.

**Call relations**: This test specifically exercises `status_after_budget_limit` through the replacement path.

*Call graph*: 4 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::insert_thread_goal_does_not_replace_existing_goal`  (lines 692–729)

```
async fn insert_thread_goal_does_not_replace_existing_goal()
```

**Purpose**: Checks that `insert_thread_goal` leaves an existing active goal untouched instead of replacing it. Only the first insert should succeed.

**Data flow**: Seeds a thread, inserts one goal, attempts a second insert with different contents, asserts the second result is `None`, and confirms the stored goal is still the first one.

**Call relations**: This validates the `WHERE thread_goals.status = 'complete'` conflict-update guard in `GoalStore::insert_thread_goal`.

*Call graph*: 4 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::insert_thread_goal_applies_budget_limit_immediately`  (lines 732–753)

```
async fn insert_thread_goal_applies_budget_limit_immediately()
```

**Purpose**: Confirms that the conservative insert path also normalizes an over-budget active goal to `BudgetLimited` immediately. It mirrors the replacement test for the insert API.

**Data flow**: Seeds a thread, calls `insert_thread_goal` with active status and zero budget, unwraps the inserted goal, and asserts budget-limited status and zero counters.

**Call relations**: This covers `status_after_budget_limit` through `GoalStore::insert_thread_goal`.

*Call graph*: 4 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::update_thread_goal_ignores_replaced_goal_version`  (lines 756–821)

```
async fn update_thread_goal_ignores_replaced_goal_version()
```

**Purpose**: Verifies optimistic concurrency: an update carrying a stale `expected_goal_id` must not modify a newer replacement goal. A fresh matching version token should still succeed.

**Data flow**: Creates an original goal, replaces it to get a new `goal_id`, attempts an update using the stale original id and asserts `None`, then retries with the replacement id and asserts the status changes to `Complete`.

**Call relations**: This test targets the `expected_goal_id` predicate in `GoalStore::update_thread_goal`.

*Call graph*: 4 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::usage_accounting_ignores_replaced_goal_version`  (lines 824–870)

```
async fn usage_accounting_ignores_replaced_goal_version()
```

**Purpose**: Checks that usage accounting also respects goal versioning and does not mutate a replaced goal when given a stale `expected_goal_id`. Instead it returns the current unchanged replacement goal.

**Data flow**: Creates an original goal, replaces it, calls `account_thread_goal_usage` with the stale original id, pattern-matches `GoalAccountingOutcome::Unchanged(Some(goal))`, and asserts the returned goal is the replacement with untouched counters.

**Call relations**: This extends optimistic concurrency coverage from updates to `GoalStore::account_thread_goal_usage`.

*Call graph*: 6 external calls (assert_eq!, assert_ne!, panic!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::update_thread_goal_objective_preserves_usage_and_created_at`  (lines 873–925)

```
async fn update_thread_goal_objective_preserves_usage_and_created_at()
```

**Purpose**: Ensures that changing objective/status/budget on an existing goal does not reset accumulated usage or creation time. Only the explicitly updated fields should change.

**Data flow**: Creates a goal, accounts usage to produce nonzero counters, then updates objective, status, and budget with the current `goal_id` and asserts the returned goal preserves usage and `created_at` while reflecting the new fields.

**Call relations**: This test validates the partial-update semantics and field preservation logic in `GoalStore::update_thread_goal`.

*Call graph*: 5 external calls (assert_eq!, panic!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::concurrent_partial_updates_preserve_independent_fields`  (lines 928–973)

```
async fn concurrent_partial_updates_preserve_independent_fields()
```

**Purpose**: Checks that concurrent updates to different fields do not clobber each other. One task changes status while another changes budget, and both effects should survive.

**Data flow**: Seeds a goal, launches two `update_thread_goal` futures with `tokio::join!`, waits for both, then reloads the goal and asserts it has both the paused status and the updated token budget.

**Call relations**: This test exercises the SQL `COALESCE`/partial-update design under concurrent writes.

*Call graph*: 5 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread, join!).


##### `tests::pause_active_thread_goal_does_not_clobber_terminal_status`  (lines 976–1032)

```
async fn pause_active_thread_goal_does_not_clobber_terminal_status()
```

**Purpose**: Verifies that pausing works for an active goal but later pause attempts do not overwrite a terminal completed status. The helper should return `None` when no transition is allowed.

**Data flow**: Creates an active goal, pauses it and checks the updated status, then marks it complete via `update_thread_goal`, calls `pause_active_thread_goal` again, and asserts no change occurred and the stored goal remains complete.

**Call relations**: This covers the allowed-state filter inside `GoalStore::update_active_thread_goal_status` as used by the pause wrapper.

*Call graph*: 4 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::usage_limit_active_thread_goal_updates_active_or_budget_limited_goals`  (lines 1035–1092)

```
async fn usage_limit_active_thread_goal_updates_active_or_budget_limited_goals()
```

**Purpose**: Checks that usage limiting can transition both active and budget-limited goals to `UsageLimited`, but repeated application after that has no effect. It captures the special-case promotion rule.

**Data flow**: Creates an active goal and usage-limits it, asserts the new status, retries and expects `None`, then replaces the goal with `BudgetLimited`, usage-limits again, and asserts the status becomes `UsageLimited`.

**Call relations**: This directly validates the conditional branch in `GoalStore::update_active_thread_goal_status` that allows `budget_limited -> usage_limited`.

*Call graph*: 4 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::usage_accounting_updates_active_goals_and_accounts_budget_limited_in_flight_usage`  (lines 1095–1163)

```
async fn usage_accounting_updates_active_goals_and_accounts_budget_limited_in_flight_usage()
```

**Purpose**: Verifies normal active accounting, transition to `BudgetLimited` when crossing the budget, and continued accounting of in-flight usage after that transition. This captures the intended semantics of `ActiveOnly` mode.

**Data flow**: Creates an active goal with budget 20, accounts 5 tokens/7 seconds and checks active status, then accounts 15 more tokens to hit the budget and checks `BudgetLimited`, then accounts another 5/5 and asserts counters continue increasing while status stays budget-limited.

**Call relations**: This test targets the status filters and `CASE` expression built by `GoalStore::account_thread_goal_usage`.

*Call graph*: 5 external calls (assert_eq!, panic!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::active_status_only_usage_accounting_does_not_update_budget_limited_goals`  (lines 1166–1198)

```
async fn active_status_only_usage_accounting_does_not_update_budget_limited_goals()
```

**Purpose**: Ensures the stricter `ActiveStatusOnly` mode refuses to account usage on already budget-limited goals. The row should remain unchanged.

**Data flow**: Creates a budget-limited goal, calls `account_thread_goal_usage` in `ActiveStatusOnly` mode, pattern-matches `Unchanged(Some(goal))`, and asserts counters remain zero.

**Call relations**: This distinguishes `ActiveStatusOnly` from the looser accounting modes in `GoalStore::account_thread_goal_usage`.

*Call graph*: 5 external calls (assert_eq!, panic!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::stopped_usage_accounting_promotes_paused_goal_over_budget`  (lines 1201–1246)

```
async fn stopped_usage_accounting_promotes_paused_goal_over_budget()
```

**Purpose**: Checks that `ActiveOrStopped` mode can account final in-flight usage on a paused goal and still promote it to `BudgetLimited` if the budget is exceeded. This supports accounting after a stop signal.

**Data flow**: Creates an active goal with budget, pauses it, then accounts 25 tokens/3 seconds in `ActiveOrStopped` mode and asserts the returned goal is budget-limited with updated counters.

**Call relations**: This test exercises the broader stopped-status filter used only in `GoalAccountingMode::ActiveOrStopped`.

*Call graph*: 5 external calls (assert_eq!, panic!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::budget_updates_immediately_stop_active_goals_already_over_budget`  (lines 1249–1293)

```
async fn budget_updates_immediately_stop_active_goals_already_over_budget()
```

**Purpose**: Verifies that lowering a token budget below already-used tokens immediately changes an active goal to `BudgetLimited`. Budget edits are therefore not purely cosmetic.

**Data flow**: Creates an active goal with budget 100, accounts 50 tokens, then updates only `token_budget` to 40 and asserts the returned goal is now budget-limited with the lower budget and preserved usage.

**Call relations**: This covers the `(None, Some(token_budget))` branch in `GoalStore::update_thread_goal`.

*Call graph*: 4 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::activating_goal_already_over_budget_keeps_it_budget_limited`  (lines 1296–1344)

```
async fn activating_goal_already_over_budget_keeps_it_budget_limited()
```

**Purpose**: Ensures that trying to reactivate a goal whose usage already exceeds its budget does not restore `Active`; it remains `BudgetLimited`. Objective text may still update.

**Data flow**: Creates an active goal, accounts usage beyond budget, then calls `update_thread_goal` with a new objective and requested `Active` status and asserts the stored status remains budget-limited while the objective changes.

**Call relations**: This validates the status-preserving `CASE` logic in the status-update branches of `GoalStore::update_thread_goal`.

*Call graph*: 4 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::pausing_budget_limited_goal_preserves_terminal_status`  (lines 1347–1391)

```
async fn pausing_budget_limited_goal_preserves_terminal_status()
```

**Purpose**: Checks that requesting `Paused` on a budget-limited goal does not overwrite the budget-limited terminal state. The update should preserve status while still succeeding as a row update.

**Data flow**: Creates a goal, pushes it over budget through accounting, then updates status to `Paused` and asserts the returned goal still has `BudgetLimited` status and preserved counters/budget.

**Call relations**: This targets the explicit `WHEN status = budget_limited AND requested IN (paused, blocked) THEN status` logic in `GoalStore::update_thread_goal`.

*Call graph*: 4 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::blocking_budget_limited_goal_preserves_terminal_status`  (lines 1394–1443)

```
async fn blocking_budget_limited_goal_preserves_terminal_status()
```

**Purpose**: Verifies the same preservation rule for `Blocked` requests against a budget-limited goal. The row updates timestamp-wise but status remains budget-limited.

**Data flow**: Creates a goal, accounts it over budget, then requests `Blocked` via `update_thread_goal` and asserts the returned goal matches the prior budget-limited state except for `updated_at`.

**Call relations**: This complements the paused case and covers the other preserved-status branch in `GoalStore::update_thread_goal`.

*Call graph*: 5 external calls (assert_eq!, panic!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::usage_accounting_can_finalize_completed_goal_for_completing_turn`  (lines 1446–1496)

```
async fn usage_accounting_can_finalize_completed_goal_for_completing_turn()
```

**Purpose**: Shows that completed goals are ignored by `ActiveOnly` accounting but can still receive final usage in `ActiveOrComplete` mode. This supports accounting the turn that completed the goal.

**Data flow**: Creates a completed goal, accounts usage in `ActiveOnly` mode and asserts unchanged counters, then accounts the same usage in `ActiveOrComplete` mode and asserts counters increase while status stays complete.

**Call relations**: This test distinguishes the status filters selected by different `GoalAccountingMode` values.

*Call graph*: 5 external calls (assert_eq!, panic!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::usage_accounting_can_finalize_stopped_goal_for_in_flight_turn`  (lines 1499–1563)

```
async fn usage_accounting_can_finalize_stopped_goal_for_in_flight_turn()
```

**Purpose**: Verifies that paused goals are ignored by `ActiveOnly` accounting but can still absorb final in-flight usage in `ActiveOrStopped` mode. Status remains paused after accounting.

**Data flow**: Creates an active goal, pauses it, accounts usage in `ActiveOnly` mode and asserts no change, then accounts the same usage in `ActiveOrStopped` mode and asserts counters increase while status stays paused.

**Call relations**: This covers the stopped-goal accounting path in `GoalStore::account_thread_goal_usage`.

*Call graph*: 5 external calls (assert_eq!, panic!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::usage_accounting_adds_concurrent_token_deltas`  (lines 1566–1607)

```
async fn usage_accounting_adds_concurrent_token_deltas()
```

**Purpose**: Checks that concurrent accounting updates accumulate rather than overwrite each other. Both token and time deltas from separate tasks should be reflected in the final row.

**Data flow**: Creates an active goal, launches two `account_thread_goal_usage` calls concurrently with different deltas, waits for both, then reloads the goal and asserts summed `tokens_used` and `time_used_seconds`.

**Call relations**: This test validates the atomic increment behavior of the SQL update built by `GoalStore::account_thread_goal_usage`.

*Call graph*: 5 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread, join!).


##### `tests::deleting_thread_deletes_goal`  (lines 1610–1638)

```
async fn deleting_thread_deletes_goal()
```

**Purpose**: Verifies that deleting a thread removes its associated goal row as well. This confirms the expected database-level relationship between threads and goals.

**Data flow**: Creates a thread and goal, calls `runtime.delete_thread(thread_id)`, then reads the goal and asserts it is absent.

**Call relations**: This test covers integration between thread deletion and goal persistence, rather than a direct `GoalStore` delete call.

*Call graph*: 4 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread).


### `state/src/runtime/memories.rs`

`domain_logic` · `background memory extraction/consolidation, startup scans, and memory artifact maintenance`

This file defines `MemoryStore`, which uses two SQLite pools: a memories DB (`pool`) for `jobs` and `stage1_outputs`, and the main state DB (`state_pool`) for thread metadata. It coordinates a two-phase pipeline. Stage 1 is per-thread extraction (`memory_stage1`), keyed by thread id; phase 2 is singleton global consolidation (`memory_consolidate_global`, job key `global`). Constants define retry budgets, cooldowns, and selection paging.

Stage-1 claiming is careful and transactional. `try_claim_stage1_job` opens `BEGIN IMMEDIATE`, first skips work if either an existing `stage1_outputs.source_updated_at` or the job row’s `last_success_watermark` is already at least the requested source watermark, then inserts or updates a `jobs` row to `running` only if the global running count is below `max_running_jobs`, any prior lease is stale, retry backoff has elapsed or the source watermark advanced, and retries remain unless the watermark advanced. Newer source watermarks reset retry budget. Success paths either upsert a non-empty `stage1_outputs` row or delete an existing one for no-output extraction; both can enqueue phase 2 by upserting the singleton global job and monotonically advancing its bookkeeping watermark.

Phase 2 uses a singleton lock row with lease, retry, and success cooldown semantics. Claiming ignores DB watermarks as a dirty check; actual work is determined later by workspace diffing. Successful completion rewrites `selected_for_phase2` markers so only the exact selected stage-1 snapshots remain marked, including the selected snapshot timestamp. Read-side helpers list visible stage-1 outputs, compute current phase-2 input selection using usage count and recency while filtering out disabled/polluted threads, record usage metadata, prune stale unselected outputs, and mark threads polluted to trigger forgetting. The large test suite covers concurrency, stale leases, retry exhaustion, selection ranking, retention, pollution, and exact snapshot bookkeeping.

#### Function details

##### `MemoryStore::new`  (lines 34–36)

```
fn new(pool: Arc<SqlitePool>, state_pool: Arc<SqlitePool>) -> Self
```

**Purpose**: Constructs a `MemoryStore` with separate pools for the memories database and the main state database. It is the wiring point for this subsystem.

**Data flow**: Consumes `pool` and `state_pool` as `Arc<SqlitePool>` values and returns `MemoryStore { pool, state_pool }`.

**Call relations**: Called during runtime initialization to attach memory persistence and thread-metadata lookups.

*Call graph*: called by 1 (init_inner).


##### `MemoryStore::close`  (lines 38–40)

```
async fn close(&self)
```

**Purpose**: Closes the memories database pool. This is part of runtime shutdown.

**Data flow**: Reads `self.pool` and awaits `close()` on it.

**Call relations**: Invoked by the enclosing runtime close path.

*Call graph*: called by 1 (close).


##### `MemoryStore::clear_memory_data`  (lines 47–49)

```
async fn clear_memory_data(&self) -> anyhow::Result<()>
```

**Purpose**: Deletes all persisted memory pipeline state from the memories database. It removes both stage-1 outputs and memory-related job rows.

**Data flow**: Reads `self.pool` and delegates to `clear_memory_data_in_pool`, returning its result.

**Call relations**: This is the store-level wrapper over the shared pool helper used for full memory-state resets.

*Call graph*: calls 1 internal fn (clear_memory_data_in_pool).


##### `MemoryStore::record_stage1_output_usage`  (lines 55–86)

```
async fn record_stage1_output_usage(
        &self,
        thread_ids: &[ThreadId],
    ) -> anyhow::Result<usize>
```

**Purpose**: Increments usage metadata for cited stage-1 outputs so later phase-2 selection can prioritize frequently used memories. Missing thread ids are ignored.

**Data flow**: Consumes a slice of `ThreadId`; returns `0` immediately if empty. Otherwise it computes `now`, opens a transaction, loops over thread ids, and for each executes `UPDATE stage1_outputs SET usage_count = COALESCE(usage_count, 0) + 1, last_usage = now WHERE thread_id = ?`, summing `rows_affected()` before commit. Returns the number of updated rows.

**Call relations**: This is a write-side maintenance API used after memory outputs are cited or consumed, feeding ranking logic in `MemoryStore::get_phase2_input_selection`.

*Call graph*: 3 external calls (now, is_empty, query).


##### `MemoryStore::stage1_source_needs_update`  (lines 88–131)

```
async fn stage1_source_needs_update(
        &self,
        thread_id: ThreadId,
        source_updated_at: i64,
    ) -> anyhow::Result<bool>
```

**Purpose**: Determines whether a thread’s source watermark is newer than both any persisted stage-1 output and the last successful stage-1 job watermark. It avoids unnecessary re-extraction.

**Data flow**: Consumes `thread_id` and `source_updated_at`, stringifies the thread id, queries `stage1_outputs.source_updated_at` and then `jobs.last_success_watermark` for the stage-1 job key, and returns `false` if either stored watermark is already at least the requested source watermark; otherwise returns `true`.

**Call relations**: Used by `MemoryStore::claim_stage1_jobs_for_startup` to skip threads that are already up to date before attempting a claim.

*Call graph*: called by 1 (claim_stage1_jobs_for_startup); 3 external calls (as_str, to_string, query).


##### `MemoryStore::claim_stage1_jobs_for_startup`  (lines 148–270)

```
async fn claim_stage1_jobs_for_startup(
        &self,
        current_thread_id: ThreadId,
        params: Stage1StartupClaimParams<'_>,
    ) -> anyhow::Result<Vec<Stage1JobClaim>>
```

**Purpose**: Scans eligible threads from the state database and claims up to `max_claimed` stale stage-1 jobs for startup processing. It bounds state-DB scanning separately from memory-DB claim attempts.

**Data flow**: Consumes the current worker thread id and `Stage1StartupClaimParams`, returns empty if `scan_limit` or `max_claimed` is zero, computes age and idle cutoffs, builds a filtered thread query with `push_thread_filters`, `memory_mode = 'enabled'`, exclusion of the current thread, and updated-at bounds, then fetches and decodes `ThreadMetadata` rows from `state_pool`. It iterates those candidates in order, skips ones where `stage1_source_needs_update` is false, calls `try_claim_stage1_job` with the thread’s `updated_at.timestamp()` as source watermark, and collects successful claims into `Stage1JobClaim` values until `max_claimed` is reached.

**Call relations**: This is the startup orchestration entry point for stage-1 work. It delegates staleness checks to `MemoryStore::stage1_source_needs_update`, thread filtering to `push_thread_filters`, and actual locking to `MemoryStore::try_claim_stage1_job`.

*Call graph*: calls 3 internal fn (stage1_source_needs_update, try_claim_stage1_job, push_thread_filters); 7 external calls (days, hours, new, now, new, try_from, as_str).


##### `MemoryStore::delete_thread_memory`  (lines 272–320)

```
async fn delete_thread_memory(&self, thread_id: ThreadId) -> anyhow::Result<()>
```

**Purpose**: Removes a thread’s stage-1 output and stage-1 job row, and if the deleted output had been part of the last successful phase-2 baseline, enqueues global consolidation to forget it. The whole operation is transactional.

**Data flow**: Consumes `thread_id`, computes `now`, opens a transaction, reads `selected_for_phase2` from `stage1_outputs`, deletes the stage-1 output row and the corresponding stage-1 job row, conditionally calls `enqueue_global_consolidation_with_executor(&mut tx, now)` when a selected output was actually deleted, commits, and returns `()`.

**Call relations**: This is called from thread-deletion flows so memory artifacts stay in sync with thread lifecycle. It delegates phase-2 enqueueing to the shared executor helper.

*Call graph*: calls 1 internal fn (enqueue_global_consolidation_with_executor); 4 external calls (now, as_str, to_string, query).


##### `MemoryStore::list_stage1_outputs_for_global`  (lines 330–366)

```
async fn list_stage1_outputs_for_global(
        &self,
        n: usize,
    ) -> anyhow::Result<Vec<Stage1Output>>
```

**Purpose**: Returns the newest visible non-empty stage-1 outputs for use as global consolidation candidates. It filters out disabled or polluted threads by consulting the state database.

**Data flow**: Consumes `n`, returns empty if zero, selects all non-empty `stage1_outputs` rows ordered by `source_updated_at DESC, thread_id DESC`, then iterates rows and calls `stage1_output_from_row_if_thread_enabled`; each successful visible output is pushed until `n` outputs have been collected.

**Call relations**: This is the main read path for phase-2 candidate materialization. It delegates thread visibility checks and row hydration to `MemoryStore::stage1_output_from_row_if_thread_enabled`.

*Call graph*: calls 1 internal fn (stage1_output_from_row_if_thread_enabled); 2 external calls (new, query).


##### `MemoryStore::prune_stage1_outputs_for_retention`  (lines 376–409)

```
async fn prune_stage1_outputs_for_retention(
        &self,
        max_unused_days: i64,
        limit: usize,
    ) -> anyhow::Result<usize>
```

**Purpose**: Deletes stale, unselected stage-1 outputs based on last usage or source recency while preserving selected baseline rows and all job watermarks. It prunes in bounded batches.

**Data flow**: Consumes `max_unused_days` and `limit`, returns `0` if limit is zero, computes a cutoff timestamp, and executes a `DELETE` whose subquery selects up to `limit` thread ids from `stage1_outputs` where `selected_for_phase2 = 0` and `COALESCE(last_usage, source_updated_at) < cutoff`, ordered stalest-first. It returns the number of deleted rows as `usize`.

**Call relations**: This is a retention-maintenance API for the memories DB. It intentionally touches only `stage1_outputs`, leaving `jobs` rows intact.

*Call graph*: 3 external calls (days, now, query).


##### `MemoryStore::get_phase2_input_selection`  (lines 426–521)

```
async fn get_phase2_input_selection(
        &self,
        n: usize,
        max_unused_days: i64,
    ) -> anyhow::Result<Vec<Stage1Output>>
```

**Purpose**: Computes the current top-N phase-2 input set from stage-1 outputs using usage count and recency, while filtering out stale, disabled, or polluted threads. It returns fully hydrated `Stage1Output` values sorted by thread id.

**Data flow**: Consumes `n` and `max_unused_days`, returns empty if `n == 0`, computes a cutoff timestamp, then pages through candidate `(thread_id, source_updated_at)` pairs from `stage1_outputs` ordered by `usage_count DESC`, `COALESCE(last_usage, source_updated_at) DESC`, `source_updated_at DESC`, `thread_id DESC`. For each candidate it calls `enabled_thread_metadata` to ensure the thread is still visible; selected keys are then reloaded from `stage1_outputs`, converted through `stage1_output_from_row_if_thread_enabled`, collected, and finally sorted by `thread_id` before return.

**Call relations**: This is the read-side selection algorithm for phase 2. It depends on `enabled_thread_metadata` for visibility filtering and `stage1_output_from_row_if_thread_enabled` for final hydration.

*Call graph*: calls 3 internal fn (try_from, enabled_thread_metadata, stage1_output_from_row_if_thread_enabled); 6 external calls (days, now, new, with_capacity, try_from, query).


##### `MemoryStore::stage1_output_from_row_if_thread_enabled`  (lines 523–535)

```
async fn stage1_output_from_row_if_thread_enabled(
        &self,
        row: &sqlx::sqlite::SqliteRow,
    ) -> anyhow::Result<Option<Stage1Output>>
```

**Purpose**: Hydrates a `Stage1Output` from a stage-1 row only if the corresponding thread still exists and has `memory_mode = 'enabled'`. Otherwise it suppresses the row.

**Data flow**: Reads `thread_id` from the provided SQLite row, parses it into `ThreadId`, calls `enabled_thread_metadata`, and if metadata exists passes both row and thread metadata to `stage1_output_from_row_and_thread`; otherwise returns `Ok(None)`.

**Call relations**: Used by both `list_stage1_outputs_for_global` and `get_phase2_input_selection` to enforce thread visibility and attach thread-derived fields like `cwd` and `git_branch`.

*Call graph*: calls 3 internal fn (try_from, enabled_thread_metadata, stage1_output_from_row_and_thread); called by 2 (get_phase2_input_selection, list_stage1_outputs_for_global); 1 external calls (try_get).


##### `MemoryStore::enabled_thread_metadata`  (lines 537–578)

```
async fn enabled_thread_metadata(
        &self,
        thread_id: ThreadId,
    ) -> anyhow::Result<Option<ThreadMetadata>>
```

**Purpose**: Loads thread metadata from the main state database only when the thread’s `memory_mode` is `enabled`. Polluted or disabled threads are treated as absent for memory selection purposes.

**Data flow**: Consumes `thread_id`, stringifies it, selects thread columns from `threads WHERE id = ? AND memory_mode = 'enabled'` using `state_pool`, and converts an optional row through `ThreadRow::try_from_row` and `ThreadMetadata::try_from`.

**Call relations**: This is the visibility gate used by stage-1 output listing and phase-2 input selection.

*Call graph*: called by 2 (get_phase2_input_selection, stage1_output_from_row_if_thread_enabled); 2 external calls (to_string, query).


##### `MemoryStore::mark_thread_memory_mode_polluted`  (lines 582–616)

```
async fn mark_thread_memory_mode_polluted(
        &self,
        thread_id: ThreadId,
    ) -> anyhow::Result<bool>
```

**Purpose**: Marks a thread as `polluted` in the state database and, if its current stage-1 output participated in the last successful phase-2 baseline, enqueues global consolidation so that baseline can forget it. It reports whether the thread state actually changed.

**Data flow**: Consumes `thread_id`, computes `now`, reads `selected_for_phase2` from `stage1_outputs`, updates `threads SET memory_mode = 'polluted' WHERE id = ? AND memory_mode != 'polluted'`, conditionally calls `enqueue_global_consolidation(now)` when the output had been selected, and returns whether the thread row update affected any rows.

**Call relations**: This is the pollution/forgetting trigger. It delegates phase-2 enqueueing to `MemoryStore::enqueue_global_consolidation`.

*Call graph*: calls 1 internal fn (enqueue_global_consolidation); 4 external calls (now, as_str, to_string, query).


##### `MemoryStore::try_claim_stage1_job`  (lines 634–806)

```
async fn try_claim_stage1_job(
        &self,
        thread_id: ThreadId,
        worker_id: ThreadId,
        source_updated_at: i64,
        lease_seconds: i64,
        max_running_jobs: usize,
```

**Purpose**: Attempts to claim a per-thread stage-1 extraction job with lease, retry, watermark, and global-running-cap semantics. It returns a precise `Stage1JobClaimOutcome` describing success or the reason for skipping.

**Data flow**: Consumes `thread_id`, `worker_id`, `source_updated_at`, `lease_seconds`, and `max_running_jobs`; computes `now`, `lease_until`, a fresh UUID `ownership_token`, and stringified ids; opens `BEGIN IMMEDIATE`; checks existing `stage1_outputs` and `jobs.last_success_watermark` for up-to-date skips; then executes an `INSERT ... SELECT ... ON CONFLICT(kind, job_key) DO UPDATE` that claims the row only if the global running count is below cap, any existing running lease is stale, retry backoff has elapsed or the watermark advanced, and retries remain or the watermark advanced. On success it commits and returns `Claimed { ownership_token }`; otherwise it reads current job state and maps it to `SkippedRetryExhausted`, `SkippedRetryBackoff`, `SkippedRunning`, or a default running skip.

**Call relations**: This is the core stage-1 locking primitive used directly by callers and by `MemoryStore::claim_stage1_jobs_for_startup`. Its transactional checks are what make concurrent claims conflict-safe.

*Call graph*: called by 1 (claim_stage1_jobs_for_startup); 5 external calls (now, new_v4, as_str, to_string, query).


##### `MemoryStore::mark_stage1_job_succeeded`  (lines 821–892)

```
async fn mark_stage1_job_succeeded(
        &self,
        thread_id: ThreadId,
        ownership_token: &str,
        source_updated_at: i64,
        raw_memory: &str,
        rollout_summary: &str,
```

**Purpose**: Finalizes an owned running stage-1 job as successful, upserts the generated memory output, and enqueues global consolidation. It preserves prior phase-2 selection markers until phase 2 rewrites them.

**Data flow**: Consumes `thread_id`, `ownership_token`, `source_updated_at`, `raw_memory`, `rollout_summary`, and optional `rollout_slug`; computes `now`; opens a transaction; updates the matching running stage-1 `jobs` row to `done`, clears lease/error, and copies `input_watermark` into `last_success_watermark`; if no row matches it commits and returns `false`. Otherwise it upserts `stage1_outputs` with the new payload and `generated_at = now`, replacing existing output only when the new `source_updated_at` is newer or equal, calls `enqueue_global_consolidation_with_executor(&mut tx, source_updated_at)`, commits, and returns `true`.

**Call relations**: This is the normal successful completion path after `MemoryStore::try_claim_stage1_job`. It delegates phase-2 enqueueing to the shared executor helper.

*Call graph*: calls 1 internal fn (enqueue_global_consolidation_with_executor); 4 external calls (now, as_str, to_string, query).


##### `MemoryStore::mark_stage1_job_succeeded_no_output`  (lines 902–968)

```
async fn mark_stage1_job_succeeded_no_output(
        &self,
        thread_id: ThreadId,
        ownership_token: &str,
    ) -> anyhow::Result<bool>
```

**Purpose**: Finalizes an owned running stage-1 job when extraction produced no memory output, deleting any existing stage-1 output instead of writing an empty one. It only enqueues phase 2 if an existing output was actually removed.

**Data flow**: Consumes `thread_id` and `ownership_token`, computes `now`, opens a transaction, updates the matching running stage-1 job row to `done` and clears lease/error, returns `false` if no row matched, then reads the job’s `input_watermark`, deletes any `stage1_outputs` row for the thread, conditionally calls `enqueue_global_consolidation_with_executor` when a row was deleted, commits, and returns `true`.

**Call relations**: This is the no-output success variant of stage-1 completion. It shares the same ownership check as `MemoryStore::mark_stage1_job_succeeded` but differs in how it updates `stage1_outputs` and phase-2 enqueueing.

*Call graph*: calls 1 internal fn (enqueue_global_consolidation_with_executor); 4 external calls (now, as_str, to_string, query).


##### `MemoryStore::mark_stage1_job_failed`  (lines 977–1013)

```
async fn mark_stage1_job_failed(
        &self,
        thread_id: ThreadId,
        ownership_token: &str,
        failure_reason: &str,
        retry_delay_seconds: i64,
    ) -> anyhow::Result<bool
```

**Purpose**: Marks an owned running stage-1 job as failed, clears its lease, stores the failure reason, and schedules retry backoff while decrementing retry budget. It returns whether the owned running row was matched.

**Data flow**: Consumes `thread_id`, `ownership_token`, `failure_reason`, and `retry_delay_seconds`; computes `now` and `retry_at`; updates the matching running stage-1 job row to `status = 'error'`, `finished_at = now`, `lease_until = NULL`, `retry_at`, `retry_remaining = retry_remaining - 1`, and `last_error = failure_reason`; returns `rows_affected() > 0`.

**Call relations**: This is the failure path paired with `MemoryStore::try_claim_stage1_job`, feeding the retry/backoff logic that later claims inspect.

*Call graph*: 4 external calls (now, as_str, to_string, query).


##### `MemoryStore::enqueue_global_consolidation`  (lines 1022–1024)

```
async fn enqueue_global_consolidation(&self, input_watermark: i64) -> anyhow::Result<()>
```

**Purpose**: Upserts the singleton global phase-2 job into a pending-or-running state and advances its bookkeeping watermark. It is the public wrapper over the executor-generic helper.

**Data flow**: Consumes `input_watermark` and forwards `self.pool.as_ref()` plus that watermark to `enqueue_global_consolidation_with_executor`, returning `()`.

**Call relations**: Called when stage-1 outputs change or polluted/selected rows need forgetting. `MemoryStore::mark_thread_memory_mode_polluted` delegates here.

*Call graph*: calls 1 internal fn (enqueue_global_consolidation_with_executor); called by 1 (mark_thread_memory_mode_polluted).


##### `MemoryStore::try_claim_global_phase2_job`  (lines 1039–1169)

```
async fn try_claim_global_phase2_job(
        &self,
        worker_id: ThreadId,
        lease_seconds: i64,
    ) -> anyhow::Result<Phase2JobClaimOutcome>
```

**Purpose**: Attempts to claim the singleton global consolidation lock with lease, retry-backoff, and success-cooldown semantics. It returns a `Phase2JobClaimOutcome` describing whether the caller now owns the lock.

**Data flow**: Consumes `worker_id` and `lease_seconds`, computes `now`, `lease_until`, `cooldown_cutoff`, and a fresh `ownership_token`, opens `BEGIN IMMEDIATE`, reads the singleton global job row, and if absent inserts a new running row with zero watermark and default retries. If present, it extracts `status`, `lease_until`, `retry_at`, `input_watermark`, `finished_at`, and `last_error`; returns `SkippedRetryUnavailable`, `SkippedRunning`, or `SkippedCooldown` when those conditions apply; otherwise updates the row to `running` with new ownership and lease if the stale/cooldown predicates still hold. It commits and returns either `Claimed { ownership_token, input_watermark }` or `SkippedRunning`.

**Call relations**: This is the phase-2 locking primitive used by consolidation workers. It is independent of actual work detection, which the caller performs after claiming.

*Call graph*: 5 external calls (now, new_v4, as_str, to_string, query).


##### `MemoryStore::heartbeat_global_phase2_job`  (lines 1176–1200)

```
async fn heartbeat_global_phase2_job(
        &self,
        ownership_token: &str,
        lease_seconds: i64,
    ) -> anyhow::Result<bool>
```

**Purpose**: Extends the lease on an owned running global phase-2 job. It is a lightweight keepalive for long-running consolidation work.

**Data flow**: Consumes `ownership_token` and `lease_seconds`, computes `now` and `lease_until`, updates the singleton global job row’s `lease_until` where `status = 'running'` and `ownership_token` matches, and returns whether a row was updated.

**Call relations**: Used by active phase-2 workers after a successful claim from `MemoryStore::try_claim_global_phase2_job`.

*Call graph*: 2 external calls (now, query).


##### `MemoryStore::mark_global_phase2_job_succeeded`  (lines 1212–1259)

```
async fn mark_global_phase2_job_succeeded(
        &self,
        ownership_token: &str,
        completed_watermark: i64,
        selected_outputs: &[Stage1Output],
    ) -> anyhow::Result<bool>
```

**Purpose**: Finalizes an owned running global phase-2 job as successful and rewrites the `selected_for_phase2` baseline markers to exactly match the selected outputs used for that run. This persists the latest successful baseline snapshot.

**Data flow**: Consumes `ownership_token`, `completed_watermark`, and a slice of `Stage1Output`; opens a transaction; calls `mark_global_phase2_job_succeeded_row` to update the singleton job row to `done` and advance `last_success_watermark`; if no row matched it commits and returns `false`. Otherwise it clears all existing `selected_for_phase2` flags and snapshot timestamps in `stage1_outputs`, then for each selected output updates the matching `(thread_id, source_updated_at)` row to `selected_for_phase2 = 1` and `selected_for_phase2_source_updated_at = source_updated_at`, commits, and returns `true`.

**Call relations**: This is the successful completion path after `MemoryStore::try_claim_global_phase2_job`. It delegates the job-row state transition to `mark_global_phase2_job_succeeded_row`.

*Call graph*: calls 1 internal fn (mark_global_phase2_job_succeeded_row); 1 external calls (query).


##### `MemoryStore::mark_global_phase2_job_failed`  (lines 1268–1301)

```
async fn mark_global_phase2_job_failed(
        &self,
        ownership_token: &str,
        failure_reason: &str,
        retry_delay_seconds: i64,
    ) -> anyhow::Result<bool>
```

**Purpose**: Marks an owned running global phase-2 job as failed, clears its lease, stores the failure reason, and schedules retry backoff while decrementing retry budget. It requires strict ownership.

**Data flow**: Consumes `ownership_token`, `failure_reason`, and `retry_delay_seconds`; computes `now` and `retry_at`; updates the singleton global job row where `status = 'running'` and `ownership_token` matches, setting `status = 'error'`, `finished_at`, `lease_until = NULL`, `retry_at`, `retry_remaining = max(retry_remaining - 1, 0)`, and `last_error`; returns whether a row matched.

**Call relations**: This is the normal failure path for a phase-2 worker that still owns the lock.

*Call graph*: 2 external calls (now, query).


##### `MemoryStore::mark_global_phase2_job_failed_if_unowned`  (lines 1309–1343)

```
async fn mark_global_phase2_job_failed_if_unowned(
        &self,
        ownership_token: &str,
        failure_reason: &str,
        retry_delay_seconds: i64,
    ) -> anyhow::Result<bool>
```

**Purpose**: Fallback failure finalization for a running global phase-2 job when ownership may have been lost or cleared. It can match either the expected token or a null ownership token.

**Data flow**: Consumes the same inputs as `mark_global_phase2_job_failed`, computes `now` and `retry_at`, and updates the singleton global job row where `status = 'running'` and `(ownership_token = ? OR ownership_token IS NULL)`, applying the same error/retry transition and returning whether a row matched.

**Call relations**: Used as a recovery path when strict ownership failure finalization does not match, such as after ownership token loss.

*Call graph*: 2 external calls (now, query).


##### `mark_global_phase2_job_succeeded_row`  (lines 1346–1378)

```
async fn mark_global_phase2_job_succeeded_row(
    executor: E,
    ownership_token: &str,
    completed_watermark: i64,
) -> anyhow::Result<u64>
```

**Purpose**: Performs just the singleton global job-row success transition, independent of rewriting selected stage-1 outputs. It is generic over any SQLx executor so it can run inside a transaction.

**Data flow**: Consumes an executor, `ownership_token`, and `completed_watermark`; computes `now`; updates the singleton global job row where it is running and owned by the token, setting `status = 'done'`, `finished_at = now`, `lease_until = NULL`, `last_error = NULL`, and `last_success_watermark = max(existing, completed_watermark)`; returns `rows_affected()`.

**Call relations**: Called only by `MemoryStore::mark_global_phase2_job_succeeded` as the first step of the transactional success path.

*Call graph*: called by 1 (mark_global_phase2_job_succeeded); 2 external calls (now, query).


##### `clear_memory_data_in_pool`  (lines 1380–1404)

```
async fn clear_memory_data_in_pool(pool: &SqlitePool) -> anyhow::Result<()>
```

**Purpose**: Deletes all stage-1 outputs and all memory-related job rows from a given memories database pool in one transaction. It is the shared implementation behind full memory-state clearing.

**Data flow**: Consumes `&SqlitePool`, begins a transaction, deletes all rows from `stage1_outputs`, deletes all `jobs` rows whose `kind` is stage 1 or global consolidation, commits, and returns `()`.

**Call relations**: Used by `MemoryStore::clear_memory_data` and any other pool-level reset path.

*Call graph*: called by 2 (clear_memory_data_in_sqlite_home, clear_memory_data); 2 external calls (begin, query).


##### `stage1_output_from_row_and_thread`  (lines 1406–1425)

```
fn stage1_output_from_row_and_thread(
    row: &sqlx::sqlite::SqliteRow,
    thread: ThreadMetadata,
) -> anyhow::Result<Stage1Output>
```

**Purpose**: Combines a raw `stage1_outputs` row with already-loaded `ThreadMetadata` to produce a fully hydrated `Stage1Output`. It attaches thread-derived fields such as rollout path, cwd, and git branch.

**Data flow**: Reads `source_updated_at`, `generated_at`, `raw_memory`, `rollout_summary`, and `rollout_slug` from the SQLite row, converts the timestamps with `datetime_from_epoch_seconds`, and returns a `Stage1Output` populated from both the row and the supplied `ThreadMetadata`.

**Call relations**: Called by `MemoryStore::stage1_output_from_row_if_thread_enabled` after thread visibility has already been checked.

*Call graph*: calls 1 internal fn (datetime_from_epoch_seconds); called by 1 (stage1_output_from_row_if_thread_enabled); 1 external calls (try_get).


##### `datetime_from_epoch_seconds`  (lines 1427–1430)

```
fn datetime_from_epoch_seconds(secs: i64) -> anyhow::Result<DateTime<Utc>>
```

**Purpose**: Converts a Unix-seconds timestamp into `DateTime<Utc>` and errors on invalid values. It centralizes timestamp validation for memory outputs.

**Data flow**: Consumes `secs`, calls `DateTime::<Utc>::from_timestamp(secs, 0)`, and returns either the datetime or an `anyhow` error describing the invalid timestamp.

**Call relations**: Used by `stage1_output_from_row_and_thread` when hydrating persisted stage-1 output timestamps.

*Call graph*: called by 1 (stage1_output_from_row_and_thread); 1 external calls (from_timestamp).


##### `enqueue_global_consolidation_with_executor`  (lines 1432–1481)

```
async fn enqueue_global_consolidation_with_executor(
    executor: E,
    input_watermark: i64,
) -> anyhow::Result<()>
```

**Purpose**: Upserts the singleton global phase-2 job row using any SQLx executor, preserving running state when already running and monotonically advancing the bookkeeping watermark. It is the shared enqueue primitive for multiple write paths.

**Data flow**: Consumes an executor and `input_watermark`, executes an `INSERT ... ON CONFLICT(kind, job_key) DO UPDATE` for the global job key that sets pending defaults, preserves `running` status and retry timing when already running, raises `retry_remaining` to at least the default, and updates `input_watermark` to either the new higher watermark or `existing + 1` when the new watermark is not greater. Returns `()`.

**Call relations**: Called by `MemoryStore::delete_thread_memory`, `MemoryStore::enqueue_global_consolidation`, `MemoryStore::mark_stage1_job_succeeded`, and `MemoryStore::mark_stage1_job_succeeded_no_output`.

*Call graph*: called by 4 (delete_thread_memory, enqueue_global_consolidation, mark_stage1_job_succeeded, mark_stage1_job_succeeded_no_output); 1 external calls (query).


##### `StateRuntime::clear_memory_data`  (lines 1485–1487)

```
async fn clear_memory_data(&self) -> anyhow::Result<()>
```

**Purpose**: Test-only forwarding method from `StateRuntime` to `MemoryStore::clear_memory_data`. It exposes the store API through the runtime wrapper used in tests.

**Data flow**: Reads `self.memories` and awaits `clear_memory_data()`, returning its result.

**Call relations**: Used only in the test module so tests can call memory APIs directly on `StateRuntime`.


##### `StateRuntime::record_stage1_output_usage`  (lines 1489–1491)

```
async fn record_stage1_output_usage(&self, thread_ids: &[ThreadId]) -> anyhow::Result<usize>
```

**Purpose**: Test-only runtime wrapper for recording stage-1 output usage. It forwards directly to the memory store.

**Data flow**: Consumes a slice of `ThreadId`, calls `self.memories.record_stage1_output_usage(thread_ids)`, and returns the updated-row count.

**Call relations**: Provides test access to the underlying store method.


##### `StateRuntime::claim_stage1_jobs_for_startup`  (lines 1493–1501)

```
async fn claim_stage1_jobs_for_startup(
        &self,
        current_thread_id: ThreadId,
        params: Stage1StartupClaimParams<'_>,
    ) -> anyhow::Result<Vec<Stage1JobClaim>>
```

**Purpose**: Test-only runtime wrapper for startup stage-1 claiming. It forwards the current thread id and claim parameters to the memory store.

**Data flow**: Consumes `current_thread_id` and `Stage1StartupClaimParams`, delegates to `self.memories.claim_stage1_jobs_for_startup(...)`, and returns the resulting claims.

**Call relations**: Used by tests that exercise startup scanning through the runtime facade.


##### `StateRuntime::list_stage1_outputs_for_global`  (lines 1503–1505)

```
async fn list_stage1_outputs_for_global(&self, n: usize) -> anyhow::Result<Vec<Stage1Output>>
```

**Purpose**: Test-only runtime wrapper for listing visible stage-1 outputs. It forwards to the memory store implementation.

**Data flow**: Consumes `n`, calls `self.memories.list_stage1_outputs_for_global(n)`, and returns the vector.

**Call relations**: Used by tests that inspect phase-2 candidate materialization.


##### `StateRuntime::prune_stage1_outputs_for_retention`  (lines 1507–1515)

```
async fn prune_stage1_outputs_for_retention(
        &self,
        max_unused_days: i64,
        limit: usize,
    ) -> anyhow::Result<usize>
```

**Purpose**: Test-only runtime wrapper for stage-1 retention pruning. It exposes the store method through `StateRuntime`.

**Data flow**: Consumes `max_unused_days` and `limit`, delegates to `self.memories.prune_stage1_outputs_for_retention(...)`, and returns the deleted-row count.

**Call relations**: Used by retention tests.


##### `StateRuntime::get_phase2_input_selection`  (lines 1517–1525)

```
async fn get_phase2_input_selection(
        &self,
        n: usize,
        max_unused_days: i64,
    ) -> anyhow::Result<Vec<Stage1Output>>
```

**Purpose**: Test-only runtime wrapper for computing the current phase-2 input selection. It forwards to the memory store.

**Data flow**: Consumes `n` and `max_unused_days`, calls `self.memories.get_phase2_input_selection(...)`, and returns the selected outputs.

**Call relations**: Used by tests that validate ranking and baseline-selection behavior.


##### `StateRuntime::mark_thread_memory_mode_polluted`  (lines 1527–1531)

```
async fn mark_thread_memory_mode_polluted(&self, thread_id: ThreadId) -> anyhow::Result<bool>
```

**Purpose**: Test-only runtime wrapper for marking a thread polluted and possibly enqueueing forgetting. It forwards to the memory store.

**Data flow**: Consumes `thread_id`, delegates to `self.memories.mark_thread_memory_mode_polluted(thread_id)`, and returns the boolean transition result.

**Call relations**: Used by pollution tests.


##### `StateRuntime::try_claim_stage1_job`  (lines 1533–1550)

```
async fn try_claim_stage1_job(
        &self,
        thread_id: ThreadId,
        worker_id: ThreadId,
        source_updated_at: i64,
        lease_seconds: i64,
        max_running_jobs: usize,
```

**Purpose**: Test-only runtime wrapper for stage-1 job claiming. It exposes the store’s claim primitive through `StateRuntime`.

**Data flow**: Consumes thread id, worker id, source watermark, lease seconds, and max running jobs; forwards them to `self.memories.try_claim_stage1_job(...)` and returns the claim outcome.

**Call relations**: Used heavily throughout the tests to drive stage-1 job state transitions.


##### `StateRuntime::mark_stage1_job_succeeded`  (lines 1552–1571)

```
async fn mark_stage1_job_succeeded(
        &self,
        thread_id: ThreadId,
        ownership_token: &str,
        source_updated_at: i64,
        raw_memory: &str,
        rollout_summary: &str,
```

**Purpose**: Test-only runtime wrapper for successful stage-1 completion with output. It forwards all completion data to the memory store.

**Data flow**: Consumes thread id, ownership token, source watermark, raw memory, rollout summary, and optional rollout slug; delegates to `self.memories.mark_stage1_job_succeeded(...)` and returns the success boolean.

**Call relations**: Used by tests after successful stage-1 claims.


##### `StateRuntime::mark_stage1_job_succeeded_no_output`  (lines 1573–1581)

```
async fn mark_stage1_job_succeeded_no_output(
        &self,
        thread_id: ThreadId,
        ownership_token: &str,
    ) -> anyhow::Result<bool>
```

**Purpose**: Test-only runtime wrapper for successful stage-1 completion without output. It forwards to the memory store.

**Data flow**: Consumes thread id and ownership token, calls `self.memories.mark_stage1_job_succeeded_no_output(...)`, and returns the boolean result.

**Call relations**: Used by tests covering deletion/no-output semantics.


##### `StateRuntime::mark_stage1_job_failed`  (lines 1583–1598)

```
async fn mark_stage1_job_failed(
        &self,
        thread_id: ThreadId,
        ownership_token: &str,
        failure_reason: &str,
        retry_delay_seconds: i64,
    ) -> anyhow::Result<bool
```

**Purpose**: Test-only runtime wrapper for stage-1 failure finalization. It forwards failure details to the memory store.

**Data flow**: Consumes thread id, ownership token, failure reason, and retry delay; delegates to `self.memories.mark_stage1_job_failed(...)` and returns whether the row matched.

**Call relations**: Used by retry/backoff tests.


##### `StateRuntime::enqueue_global_consolidation`  (lines 1600–1604)

```
async fn enqueue_global_consolidation(&self, input_watermark: i64) -> anyhow::Result<()>
```

**Purpose**: Test-only runtime wrapper for enqueueing the singleton phase-2 job. It forwards to the memory store helper.

**Data flow**: Consumes `input_watermark`, calls `self.memories.enqueue_global_consolidation(input_watermark)`, and returns `()`.

**Call relations**: Used by tests that seed or advance phase-2 work.


##### `StateRuntime::try_claim_global_phase2_job`  (lines 1606–1614)

```
async fn try_claim_global_phase2_job(
        &self,
        worker_id: ThreadId,
        lease_seconds: i64,
    ) -> anyhow::Result<Phase2JobClaimOutcome>
```

**Purpose**: Test-only runtime wrapper for claiming the singleton phase-2 lock. It forwards to the memory store implementation.

**Data flow**: Consumes `worker_id` and `lease_seconds`, delegates to `self.memories.try_claim_global_phase2_job(...)`, and returns the claim outcome.

**Call relations**: Used by many tests to drive phase-2 lock behavior.


##### `StateRuntime::mark_global_phase2_job_succeeded`  (lines 1616–1629)

```
async fn mark_global_phase2_job_succeeded(
        &self,
        ownership_token: &str,
        completed_watermark: i64,
        selected_outputs: &[Stage1Output],
    ) -> anyhow::Result<bool>
```

**Purpose**: Test-only runtime wrapper for successful phase-2 completion and baseline rewrite. It forwards to the memory store.

**Data flow**: Consumes `ownership_token`, `completed_watermark`, and selected outputs, delegates to `self.memories.mark_global_phase2_job_succeeded(...)`, and returns the boolean result.

**Call relations**: Used by tests that validate baseline selection persistence.


##### `StateRuntime::mark_global_phase2_job_failed`  (lines 1631–1640)

```
async fn mark_global_phase2_job_failed(
        &self,
        ownership_token: &str,
        failure_reason: &str,
        retry_delay_seconds: i64,
    ) -> anyhow::Result<bool>
```

**Purpose**: Test-only runtime wrapper for strict-ownership phase-2 failure finalization. It forwards to the memory store.

**Data flow**: Consumes `ownership_token`, `failure_reason`, and `retry_delay_seconds`, delegates to `self.memories.mark_global_phase2_job_failed(...)`, and returns the boolean result.

**Call relations**: Used by phase-2 retry tests.


##### `StateRuntime::mark_global_phase2_job_failed_if_unowned`  (lines 1642–1655)

```
async fn mark_global_phase2_job_failed_if_unowned(
        &self,
        ownership_token: &str,
        failure_reason: &str,
        retry_delay_seconds: i64,
    ) -> anyhow::Result<bool>
```

**Purpose**: Test-only runtime wrapper for fallback phase-2 failure finalization when ownership may be missing. It forwards to the memory store.

**Data flow**: Consumes `ownership_token`, `failure_reason`, and `retry_delay_seconds`, delegates to `self.memories.mark_global_phase2_job_failed_if_unowned(...)`, and returns the boolean result.

**Call relations**: Used by tests covering recovery from unowned running phase-2 rows.


##### `tests::stable_thread_id`  (lines 1678–1680)

```
fn stable_thread_id(value: &str) -> ThreadId
```

**Purpose**: Parses a fixed string into a deterministic `ThreadId` for tests that need stable ordering assertions. It avoids random UUIDs where exact ids matter.

**Data flow**: Consumes a string slice, calls `ThreadId::from_string`, and returns the parsed id.

**Call relations**: Used by selection-ranking tests that compare exact thread-id order.

*Call graph*: calls 1 internal fn (from_string).


##### `tests::memory_pool`  (lines 1682–1684)

```
fn memory_pool(runtime: &StateRuntime) -> &sqlx::SqlitePool
```

**Purpose**: Returns a direct reference to the memories database pool inside a runtime. It lets tests inspect or mutate memory tables with raw SQL.

**Data flow**: Reads `runtime.memories().pool.as_ref()` and returns `&SqlitePool`.

**Call relations**: Used by many tests for direct SQL assertions and setup.

*Call graph*: calls 1 internal fn (memories).


##### `tests::age_phase2_success_beyond_cooldown`  (lines 1686–1694)

```
async fn age_phase2_success_beyond_cooldown(runtime: &StateRuntime)
```

**Purpose**: Artificially ages the global phase-2 job’s `finished_at` timestamp so cooldown-based claim blocking no longer applies. It is a reusable test helper.

**Data flow**: Computes `Utc::now().timestamp() - PHASE2_SUCCESS_COOLDOWN_SECONDS - 1`, updates the global job row’s `finished_at` through raw SQL on `memory_pool(runtime)`, and returns `()`.

**Call relations**: Used by multiple phase-2 tests that need to bypass the success cooldown after a prior successful run.

*Call graph*: 3 external calls (now, query, memory_pool).


##### `tests::stage1_claim_skips_when_up_to_date`  (lines 1697–1762)

```
async fn stage1_claim_skips_when_up_to_date()
```

**Purpose**: Verifies that once a stage-1 job has succeeded for a given source watermark, later claims at the same watermark are skipped as up to date, while a newer watermark is claimable. This covers both output and job-watermark freshness checks.

**Data flow**: Creates a runtime and thread, claims and completes stage 1 at watermark 100, then attempts another claim at 100 and asserts `SkippedUpToDate`, followed by a claim at 101 and asserts it is claimable.

**Call relations**: This test exercises `try_claim_stage1_job` together with `mark_stage1_job_succeeded`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 5 external calls (new_v4, assert!, assert_eq!, panic!, remove_dir_all).


##### `tests::stage1_running_stale_can_be_stolen_but_fresh_running_is_skipped`  (lines 1765–1817)

```
async fn stage1_running_stale_can_be_stolen_but_fresh_running_is_skipped()
```

**Purpose**: Checks lease semantics for stage-1 jobs: a fresh running lease blocks takeover, but an expired lease allows another worker to claim the job. It validates stale-runner recovery.

**Data flow**: Claims a stage-1 job as owner A, attempts a fresh claim as owner B and expects `SkippedRunning`, manually sets `lease_until = 0`, then retries as owner B and expects a successful claim.

**Call relations**: This targets the stale-lease branch in `MemoryStore::try_claim_stage1_job`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 6 external calls (new_v4, assert!, assert_eq!, query, memory_pool, remove_dir_all).


##### `tests::stage1_concurrent_claim_for_same_thread_is_conflict_safe`  (lines 1820–1885)

```
async fn stage1_concurrent_claim_for_same_thread_is_conflict_safe()
```

**Purpose**: Verifies that concurrent claims for the same thread result in exactly one winner and one non-winning outcome, even under SQLite lock contention. It also retries transient `database is locked` errors in the test harness.

**Data flow**: Creates one thread, clones the runtime, launches two concurrent claim attempts with small retry loops, collects both outcomes, and asserts exactly one is `Claimed` and the other is either `SkippedRunning` or the winner.

**Call relations**: This test stresses the `BEGIN IMMEDIATE` and conflict-safe SQL in `MemoryStore::try_claim_stage1_job`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 7 external calls (clone, new_v4, assert!, assert_eq!, remove_dir_all, join!, vec!).


##### `tests::stage1_concurrent_claims_respect_running_cap`  (lines 1888–1953)

```
async fn stage1_concurrent_claims_respect_running_cap()
```

**Purpose**: Checks that concurrent claims for different threads still respect the global `max_running_jobs` cap. Only one claim should succeed when the cap is one.

**Data flow**: Creates two threads, launches two concurrent claims with `max_running_jobs = 1`, and asserts exactly one outcome is `Claimed` while the other is throttled as `SkippedRunning`.

**Call relations**: This validates the global running-count guard embedded in `MemoryStore::try_claim_stage1_job`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 7 external calls (clone, new_v4, assert!, assert_eq!, remove_dir_all, join!, vec!).


##### `tests::claim_stage1_jobs_filters_by_age_idle_and_current_thread`  (lines 1956–2043)

```
async fn claim_stage1_jobs_filters_by_age_idle_and_current_thread()
```

**Purpose**: Verifies startup scanning filters out the current thread, too-fresh threads, not-yet-idle threads, and too-old threads, leaving only eligible idle threads. It confirms the state-DB query predicates.

**Data flow**: Seeds several threads with different `updated_at` ages, calls `claim_stage1_jobs_for_startup` with age and idle thresholds, and asserts only the eligible idle thread is claimed.

**Call relations**: This test targets the thread-selection query built by `MemoryStore::claim_stage1_jobs_for_startup`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 8 external calls (days, hours, minutes, now, new_v4, assert_eq!, remove_dir_all, vec!).


##### `tests::claim_stage1_jobs_bounds_state_scan_before_memory_probes`  (lines 2046–2158)

```
async fn claim_stage1_jobs_bounds_state_scan_before_memory_probes()
```

**Purpose**: Checks that `scan_limit` bounds how many state rows are considered before memory staleness checks and claims. A stale candidate beyond the scan window should not be reached.

**Data flow**: Seeds one up-to-date eligible thread and one stale eligible thread, first calls startup claiming with `scan_limit = 1` and asserts no claims, then with `scan_limit = 2` and asserts the stale thread is claimed.

**Call relations**: This validates the separation between state-DB scan bounding and memory-DB probing in `MemoryStore::claim_stage1_jobs_for_startup`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 8 external calls (hours, now, new_v4, assert!, assert_eq!, panic!, remove_dir_all, vec!).


##### `tests::claim_stage1_jobs_skips_threads_with_disabled_memory_mode`  (lines 2161–2229)

```
async fn claim_stage1_jobs_skips_threads_with_disabled_memory_mode()
```

**Purpose**: Verifies that startup stage-1 scanning ignores threads whose `memory_mode` is `disabled`. Only enabled threads should be considered claimable.

**Data flow**: Seeds current, disabled, and enabled threads, manually updates one thread to `memory_mode = 'disabled'`, runs startup claiming, and asserts only the enabled thread is returned.

**Call relations**: This covers the `threads.memory_mode = 'enabled'` predicate in the startup scan query.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 7 external calls (hours, now, new_v4, assert_eq!, query, remove_dir_all, vec!).


##### `tests::clear_memory_data_clears_rows_and_preserves_thread_memory_modes`  (lines 2232–2338)

```
async fn clear_memory_data_clears_rows_and_preserves_thread_memory_modes()
```

**Purpose**: Checks that clearing memory data removes stage-1 outputs and memory jobs without altering thread rows’ `memory_mode` values in the main state database. It distinguishes memory-state reset from thread-state reset.

**Data flow**: Seeds enabled and disabled threads, creates stage-1 output and phase-2 job state, calls `clear_memory_data`, then counts memory rows and reads thread `memory_mode` values to assert memory tables are empty while thread modes remain unchanged.

**Call relations**: This test validates `MemoryStore::clear_memory_data` and the separation between memories DB and state DB.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 10 external calls (hours, now, new_v4, assert!, assert_eq!, panic!, query, query_scalar, memory_pool, remove_dir_all).


##### `tests::claim_stage1_jobs_enforces_global_running_cap`  (lines 2341–2465)

```
async fn claim_stage1_jobs_enforces_global_running_cap()
```

**Purpose**: Verifies that startup claiming respects the global stage-1 running cap even when many eligible threads exist and some jobs are already running. It should fill only the remaining capacity.

**Data flow**: Seeds many eligible threads plus ten pre-existing running stage-1 jobs, runs startup claiming with `max_claimed = 64`, asserts exactly 54 new claims, then counts running jobs and confirms the total is 64 and subsequent claims return none.

**Call relations**: This exercises the interaction between startup scanning and the running-count guard in `MemoryStore::try_claim_stage1_job`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 10 external calls (hours, seconds, now, new_v4, assert_eq!, format!, query, memory_pool, remove_dir_all, vec!).


##### `tests::claim_stage1_jobs_processes_two_full_batches_across_startup_passes`  (lines 2468–2552)

```
async fn claim_stage1_jobs_processes_two_full_batches_across_startup_passes()
```

**Purpose**: Checks that repeated startup passes can process multiple full batches of eligible threads. Completing the first batch should free capacity for the second.

**Data flow**: Seeds 200 eligible threads, claims 64 on the first startup pass, marks each claimed job succeeded, then runs a second startup pass and asserts another 64 claims are returned.

**Call relations**: This validates the intended batching behavior of `MemoryStore::claim_stage1_jobs_for_startup` across repeated runs.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 9 external calls (hours, seconds, now, new_v4, assert!, assert_eq!, format!, remove_dir_all, vec!).


##### `tests::delete_thread_removes_stage1_output_and_enqueues_phase2_when_selected`  (lines 2555–2677)

```
async fn delete_thread_removes_stage1_output_and_enqueues_phase2_when_selected()
```

**Purpose**: Verifies that deleting a thread removes its stage-1 output and, if that output was part of the selected phase-2 baseline, re-enqueues the global phase-2 job. This ensures forgetting happens after thread deletion.

**Data flow**: Creates a thread and stage-1 output, runs a successful phase-2 selection that marks the output selected, deletes the thread, then asserts the output row is gone and the global phase-2 job is pending with an advanced input watermark.

**Call relations**: This test covers the integration between thread deletion and `MemoryStore::delete_thread_memory`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 8 external calls (now, new_v4, assert!, assert_eq!, panic!, query, memory_pool, remove_dir_all).


##### `tests::mark_stage1_job_succeeded_no_output_skips_phase2_when_output_was_already_absent`  (lines 2680–2752)

```
async fn mark_stage1_job_succeeded_no_output_skips_phase2_when_output_was_already_absent()
```

**Purpose**: Checks that a no-output stage-1 success does not enqueue phase 2 when there was no existing stage-1 output to delete. It still marks the source watermark as up to date.

**Data flow**: Claims a stage-1 job for a thread with no prior output, finalizes it with `mark_stage1_job_succeeded_no_output`, asserts no `stage1_outputs` row exists, verifies a same-watermark claim is skipped as up to date, and confirms no global phase-2 job row was created.

**Call relations**: This targets the conditional enqueue behavior in `MemoryStore::mark_stage1_job_succeeded_no_output`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 7 external calls (new_v4, assert!, assert_eq!, panic!, query, memory_pool, remove_dir_all).


##### `tests::mark_stage1_job_succeeded_no_output_enqueues_phase2_when_deleting_output`  (lines 2755–2877)

```
async fn mark_stage1_job_succeeded_no_output_enqueues_phase2_when_deleting_output()
```

**Purpose**: Verifies the opposite no-output case: when a prior stage-1 output exists, a later no-output success deletes it and enqueues phase 2 so the baseline can forget it. The new phase-2 watermark should reflect the newer source.

**Data flow**: Creates an initial stage-1 output and successful phase-2 baseline, then claims stage 1 again at a newer watermark and finalizes with no output, asserts the output row is deleted, ages cooldown, claims phase 2 again, and checks the new input watermark equals the newer source watermark.

**Call relations**: This exercises deletion-triggered enqueueing in `MemoryStore::mark_stage1_job_succeeded_no_output` plus later phase-2 claiming.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 8 external calls (new_v4, assert!, assert_eq!, panic!, query, age_phase2_success_beyond_cooldown, memory_pool, remove_dir_all).


##### `tests::stage1_retry_exhaustion_does_not_block_newer_watermark`  (lines 2880–2973)

```
async fn stage1_retry_exhaustion_does_not_block_newer_watermark()
```

**Purpose**: Checks that exhausting stage-1 retries for one source watermark blocks further claims at that watermark but does not block a newer source watermark, which resets retry budget. This is key to forward progress after source changes.

**Data flow**: Claims and fails the same stage-1 job three times at watermark 100, asserts a fourth claim at 100 yields `SkippedRetryExhausted`, then claims at 101 and asserts success plus reset `retry_remaining = 3` and updated `input_watermark` in the job row.

**Call relations**: This validates the retry-reset-on-newer-watermark logic in `MemoryStore::try_claim_stage1_job`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 7 external calls (new_v4, assert!, assert_eq!, panic!, query, memory_pool, remove_dir_all).


##### `tests::phase2_global_lock_respects_success_cooldown`  (lines 2976–3035)

```
async fn phase2_global_lock_respects_success_cooldown()
```

**Purpose**: Verifies that after a successful phase-2 run, subsequent claims are blocked during the success cooldown even if new enqueue events occur. Claims become possible again only after the cooldown ages out.

**Data flow**: Enqueues phase 2, claims and completes it successfully, attempts another claim and expects `SkippedCooldown`, enqueues again and still expects cooldown blocking, then ages `finished_at` beyond cooldown and asserts a new claim succeeds.

**Call relations**: This targets the cooldown branch in `MemoryStore::try_claim_global_phase2_job`.

*Call graph*: calls 3 internal fn (from_string, init, unique_temp_dir); 6 external calls (new_v4, assert!, assert_eq!, panic!, age_phase2_success_beyond_cooldown, remove_dir_all).


##### `tests::phase2_global_lock_can_be_claimed_after_retry_budget_is_exhausted`  (lines 3038–3105)

```
async fn phase2_global_lock_can_be_claimed_after_retry_budget_is_exhausted()
```

**Purpose**: Checks that phase-2 retry exhaustion does not permanently block future claims. The lock can still be claimed later because actual work detection happens outside the DB row.

**Data flow**: Enqueues phase 2, claims and fails it three times to drive `retry_remaining` to zero, verifies that value in SQL, then attempts another claim and asserts it still succeeds.

**Call relations**: This validates the intentionally different semantics of phase-2 claiming versus stage-1 retry exhaustion.

*Call graph*: calls 3 internal fn (from_string, init, unique_temp_dir); 7 external calls (new_v4, assert!, assert_eq!, panic!, query, memory_pool, remove_dir_all).


##### `tests::list_stage1_outputs_for_global_returns_latest_outputs`  (lines 3108–3208)

```
async fn list_stage1_outputs_for_global_returns_latest_outputs()
```

**Purpose**: Verifies that listing stage-1 outputs for global consolidation returns newest outputs first and hydrates thread-derived fields like `cwd` and `git_branch`. It also checks rollout slug persistence.

**Data flow**: Creates two threads, writes stage-1 outputs at different source watermarks, then calls `list_stage1_outputs_for_global(10)` and asserts ordering, summaries, rollout slugs, cwd paths, and git branches.

**Call relations**: This test exercises `MemoryStore::list_stage1_outputs_for_global` and `stage1_output_from_row_if_thread_enabled`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 5 external calls (new_v4, assert!, assert_eq!, panic!, remove_dir_all).


##### `tests::list_stage1_outputs_for_global_skips_empty_payloads`  (lines 3211–3277)

```
async fn list_stage1_outputs_for_global_skips_empty_payloads()
```

**Purpose**: Checks that stage-1 outputs with both blank `raw_memory` and blank `rollout_summary` are excluded from global listing. Only non-empty payloads should be visible.

**Data flow**: Inserts one non-empty and one empty `stage1_outputs` row directly, calls `list_stage1_outputs_for_global(1)`, and asserts only the non-empty output is returned.

**Call relations**: This validates the non-empty payload predicate in `MemoryStore::list_stage1_outputs_for_global`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 5 external calls (new_v4, assert_eq!, query, memory_pool, remove_dir_all).


##### `tests::list_stage1_outputs_for_global_skips_polluted_threads`  (lines 3280–3345)

```
async fn list_stage1_outputs_for_global_skips_polluted_threads()
```

**Purpose**: Verifies that outputs belonging to polluted threads are hidden from global listing even if the stage-1 rows still exist. Visibility depends on current thread metadata.

**Data flow**: Creates two threads and outputs, marks one thread polluted in the state DB, calls `list_stage1_outputs_for_global`, and asserts only the enabled thread’s output remains visible.

**Call relations**: This covers the enabled-thread filtering performed by `MemoryStore::enabled_thread_metadata`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 5 external calls (new_v4, assert!, assert_eq!, panic!, remove_dir_all).


##### `tests::get_phase2_input_selection_returns_current_selected_rows`  (lines 3348–3460)

```
async fn get_phase2_input_selection_returns_current_selected_rows()
```

**Purpose**: Checks that phase-2 input selection combines current ranking with the previous successful baseline markers, returning the top current rows among visible outputs. It also verifies rollout-path hydration.

**Data flow**: Creates three threads and outputs, runs a successful phase-2 selection marking two outputs selected, then calls `get_phase2_input_selection(2, large_window)` and asserts the returned thread ids and rollout path values.

**Call relations**: This exercises `MemoryStore::get_phase2_input_selection` after a prior successful baseline rewrite.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 6 external calls (new_v4, assert!, assert_eq!, panic!, stable_thread_id, remove_dir_all).


##### `tests::get_phase2_input_selection_excludes_polluted_previous_selection`  (lines 3463–3553)

```
async fn get_phase2_input_selection_excludes_polluted_previous_selection()
```

**Purpose**: Verifies that previously selected outputs are excluded from current phase-2 input selection once their threads become polluted. Baseline markers alone do not override visibility rules.

**Data flow**: Creates two outputs, marks both selected via a successful phase-2 run, then marks one thread polluted and calls `get_phase2_input_selection`, asserting only the enabled thread remains.

**Call relations**: This covers the interaction between baseline markers and `enabled_thread_metadata` filtering.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 5 external calls (new_v4, assert!, assert_eq!, panic!, remove_dir_all).


##### `tests::mark_thread_memory_mode_polluted_enqueues_phase2_for_selected_threads`  (lines 3556–3642)

```
async fn mark_thread_memory_mode_polluted_enqueues_phase2_for_selected_threads()
```

**Purpose**: Checks that marking a selected thread polluted both changes its memory mode and causes phase 2 to become claimable again after cooldown. This is the forgetting trigger for selected baseline members.

**Data flow**: Creates a thread and output, marks it selected through a successful phase-2 run, calls `mark_thread_memory_mode_polluted`, ages cooldown, then asserts a new phase-2 claim succeeds.

**Call relations**: This validates the enqueue-on-selected behavior in `MemoryStore::mark_thread_memory_mode_polluted`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 5 external calls (new_v4, assert!, panic!, age_phase2_success_beyond_cooldown, remove_dir_all).


##### `tests::mark_thread_memory_mode_polluted_enqueues_phase2_when_already_polluted`  (lines 3645–3737)

```
async fn mark_thread_memory_mode_polluted_enqueues_phase2_when_already_polluted()
```

**Purpose**: Verifies that even if the thread is already marked polluted, calling the pollution API still enqueues phase 2 when the thread had been selected, though the boolean return reports no state transition. Enqueueing and state-change reporting are intentionally separate.

**Data flow**: Creates a selected output, manually sets the thread to polluted, calls `mark_thread_memory_mode_polluted` and asserts it returns `false`, ages cooldown, then confirms phase 2 can be claimed again.

**Call relations**: This covers the subtle case where enqueueing depends on selection membership, not on whether the thread row changed.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 6 external calls (new_v4, assert!, panic!, query, age_phase2_success_beyond_cooldown, remove_dir_all).


##### `tests::get_phase2_input_selection_returns_regenerated_selected_rows`  (lines 3740–3856)

```
async fn get_phase2_input_selection_returns_regenerated_selected_rows()
```

**Purpose**: Checks that when a previously selected thread regenerates a newer stage-1 output, current phase-2 input selection returns the regenerated snapshot rather than the old selected snapshot. The old selected snapshot timestamp remains recorded until phase 2 rewrites it.

**Data flow**: Creates an initial output, marks it selected via phase 2, regenerates the thread’s stage-1 output at a newer watermark, calls `get_phase2_input_selection(1, large_window)`, and asserts the returned output uses the newer source watermark while SQL still shows `selected_for_phase2_source_updated_at` pointing to the older selected snapshot.

**Call relations**: This validates the distinction between current visible output rows and the persisted previous-baseline snapshot markers.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 6 external calls (new_v4, assert!, assert_eq!, panic!, memory_pool, remove_dir_all).


##### `tests::get_phase2_input_selection_uses_current_ranking_after_refreshes`  (lines 3859–3999)

```
async fn get_phase2_input_selection_uses_current_ranking_after_refreshes()
```

**Purpose**: Verifies that current phase-2 selection ranking is based on current outputs and recency, not frozen previous selections. Refreshing some threads should reorder the top-N set accordingly.

**Data flow**: Creates four outputs, marks the initial top two selected via phase 2, refreshes three threads with newer stage-1 outputs, then calls `get_phase2_input_selection(2, large_window)` and asserts the returned thread ids are the newly highest-ranked current outputs.

**Call relations**: This exercises the ranking logic in `MemoryStore::get_phase2_input_selection` after baseline drift.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 6 external calls (new_v4, assert!, assert_eq!, panic!, stable_thread_id, remove_dir_all).


##### `tests::mark_global_phase2_job_succeeded_updates_selected_snapshot_timestamp`  (lines 4002–4149)

```
async fn mark_global_phase2_job_succeeded_updates_selected_snapshot_timestamp()
```

**Purpose**: Checks that a later successful phase-2 run updates `selected_for_phase2_source_updated_at` to the newly selected snapshot timestamp for a thread. The baseline marker should track the exact selected snapshot, not just the thread id.

**Data flow**: Creates an initial output and successful phase-2 selection, refreshes the thread with a newer output, ages cooldown, runs phase 2 again selecting the refreshed output, then reads SQL and asserts `selected_for_phase2_source_updated_at` now equals the newer source watermark.

**Call relations**: This validates the exact-snapshot rewrite performed by `MemoryStore::mark_global_phase2_job_succeeded`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 7 external calls (new_v4, assert!, assert_eq!, panic!, age_phase2_success_beyond_cooldown, memory_pool, remove_dir_all).


##### `tests::mark_global_phase2_job_succeeded_only_marks_exact_selected_snapshots`  (lines 4152–4269)

```
async fn mark_global_phase2_job_succeeded_only_marks_exact_selected_snapshots()
```

**Purpose**: Verifies that phase-2 success marks only the exact `(thread_id, source_updated_at)` snapshots passed in `selected_outputs`; if a thread refreshes before completion, the newer row is not incorrectly marked selected. This prevents stale selection metadata from drifting onto newer outputs.

**Data flow**: Creates an initial output, claims phase 2 and captures that selected snapshot, refreshes the thread with a newer output before finalizing phase 2, then completes phase 2 with the old selected snapshot and asserts the current row has no selected markers while current input selection returns the newer output.

**Call relations**: This targets the exact-match `UPDATE ... WHERE thread_id = ? AND source_updated_at = ?` loop in `MemoryStore::mark_global_phase2_job_succeeded`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 6 external calls (new_v4, assert!, assert_eq!, panic!, memory_pool, remove_dir_all).


##### `tests::record_stage1_output_usage_updates_usage_metadata`  (lines 4272–4388)

```
async fn record_stage1_output_usage_updates_usage_metadata()
```

**Purpose**: Checks that recording usage increments `usage_count` per cited thread occurrence and stamps a shared `last_usage` timestamp. Missing thread ids should not count as updates.

**Data flow**: Creates two stage-1 outputs, calls `record_stage1_output_usage` with `[thread_a, thread_a, thread_b, missing]`, asserts the returned updated-row count is three, then reads SQL to verify counts `2` and `1` plus equal positive `last_usage` timestamps.

**Call relations**: This validates `MemoryStore::record_stage1_output_usage`, which later feeds phase-2 ranking.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 7 external calls (new_v4, assert!, assert_eq!, panic!, query, memory_pool, remove_dir_all).


##### `tests::get_phase2_input_selection_prioritizes_usage_count_then_recent_usage`  (lines 4391–4484)

```
async fn get_phase2_input_selection_prioritizes_usage_count_then_recent_usage()
```

**Purpose**: Verifies the ranking order for phase-2 input selection: higher `usage_count` wins first, and ties are broken by more recent `last_usage`/source recency. This ensures frequently cited memories are preferred.

**Data flow**: Creates three outputs, manually sets usage metadata so threads A and B tie on count but B has more recent usage, then calls `get_phase2_input_selection(1, 30)` and asserts thread B is selected.

**Call relations**: This targets the `ORDER BY usage_count DESC, COALESCE(last_usage, source_updated_at) DESC, ...` logic in `MemoryStore::get_phase2_input_selection`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 11 external calls (days, hours, now, new_v4, assert!, assert_eq!, panic!, query, memory_pool, stable_thread_id (+1 more)).


##### `tests::get_phase2_input_selection_excludes_stale_used_memories_but_keeps_fresh_never_used`  (lines 4487–4580)

```
async fn get_phase2_input_selection_excludes_stale_used_memories_but_keeps_fresh_never_used()
```

**Purpose**: Checks the freshness window semantics: used memories are excluded when `last_usage` is too old, while never-used memories can still be included if their `source_updated_at` is fresh enough. This distinguishes stale usage from fresh generation.

**Data flow**: Creates three outputs with different ages, manually sets usage metadata so one used memory is stale, one never-used memory is fresh, and one used memory is recently used, then calls `get_phase2_input_selection(3, 30)` and asserts only the fresh-never-used and fresh-used threads remain.

**Call relations**: This validates the freshness predicate in `MemoryStore::get_phase2_input_selection`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 10 external calls (days, now, new_v4, assert!, assert_eq!, panic!, query, memory_pool, stable_thread_id, remove_dir_all).


##### `tests::get_phase2_input_selection_prefers_recent_thread_updates_over_recent_generation`  (lines 4583–4666)

```
async fn get_phase2_input_selection_prefers_recent_thread_updates_over_recent_generation()
```

**Purpose**: Verifies that phase-2 ranking uses `source_updated_at` rather than `generated_at` when comparing current outputs. A row with an older source watermark should not outrank a newer source just because it was regenerated later.

**Data flow**: Creates two outputs with source watermarks 100 and 200, manually edits `generated_at` so the older source appears newer by generation time, then calls `get_phase2_input_selection(1, large_window)` and asserts the newer source watermark still wins.

**Call relations**: This test pins down that `generated_at` is not part of the ranking order in `MemoryStore::get_phase2_input_selection`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 7 external calls (new_v4, assert!, assert_eq!, panic!, query, memory_pool, remove_dir_all).


##### `tests::prune_stage1_outputs_for_retention_prunes_stale_unselected_rows_only`  (lines 4669–4808)

```
async fn prune_stage1_outputs_for_retention_prunes_stale_unselected_rows_only()
```

**Purpose**: Checks that retention pruning deletes only stale unselected outputs, preserving selected baseline rows and recently used rows, and leaving stage-1 job rows untouched. It validates both selection protection and job preservation.

**Data flow**: Creates four outputs with different ages, marks one stale row selected and one fresh row recently used, records the count of stage-1 job rows, runs pruning, then asserts only the fresh-used and selected outputs remain and the job-row count is unchanged.

**Call relations**: This exercises `MemoryStore::prune_stage1_outputs_for_retention` and its deliberate non-interaction with `jobs`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 10 external calls (days, now, new_v4, assert!, assert_eq!, panic!, query, memory_pool, remove_dir_all, vec!).


##### `tests::prune_stage1_outputs_for_retention_respects_batch_limit`  (lines 4811–4886)

```
async fn prune_stage1_outputs_for_retention_respects_batch_limit()
```

**Purpose**: Verifies that retention pruning deletes at most the requested batch size even when more stale rows are eligible. This supports incremental cleanup passes.

**Data flow**: Creates three stale outputs, runs pruning with `limit = 2`, asserts two rows were deleted, then counts remaining outputs and confirms one remains.

**Call relations**: This targets the `LIMIT ?` behavior in the pruning subquery.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 9 external calls (days, now, new_v4, assert!, assert_eq!, panic!, query_scalar, memory_pool, remove_dir_all).


##### `tests::mark_stage1_job_succeeded_enqueues_global_consolidation`  (lines 4889–4981)

```
async fn mark_stage1_job_succeeded_enqueues_global_consolidation()
```

**Purpose**: Checks that successful stage-1 completions advance the global phase-2 job watermark so a later phase-2 claim sees the newest source watermark. Multiple stage-1 successes should raise the watermark to the max/newest bookkeeping value.

**Data flow**: Creates two threads, completes stage 1 for source watermarks 100 and 101, then claims the global phase-2 job and asserts the returned `input_watermark` is 101.

**Call relations**: This validates the enqueueing side effect of `MemoryStore::mark_stage1_job_succeeded`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 5 external calls (new_v4, assert!, assert_eq!, panic!, remove_dir_all).


##### `tests::phase2_global_lock_allows_only_one_fresh_runner`  (lines 4984–5014)

```
async fn phase2_global_lock_allows_only_one_fresh_runner()
```

**Purpose**: Verifies that only one worker can hold a fresh global phase-2 running lease at a time. A second concurrent claimant should be skipped as running.

**Data flow**: Enqueues phase 2, claims it as owner A and asserts success, then immediately attempts a claim as owner B and asserts `SkippedRunning`.

**Call relations**: This covers the fresh-running-lease branch in `MemoryStore::try_claim_global_phase2_job`.

*Call graph*: calls 3 internal fn (from_string, init, unique_temp_dir); 4 external calls (new_v4, assert!, assert_eq!, remove_dir_all).


##### `tests::phase2_global_lock_creates_missing_job_row`  (lines 5017–5064)

```
async fn phase2_global_lock_creates_missing_job_row()
```

**Purpose**: Checks that the first phase-2 claim can create the singleton job row from scratch with input watermark zero. After successful completion, cooldown semantics still apply.

**Data flow**: Initializes a runtime with no global job row, claims phase 2 as owner A and asserts `input_watermark = 0`, verifies owner B is blocked while A runs, marks success, then asserts a later claim is skipped due to cooldown.

**Call relations**: This exercises the missing-row insert path in `MemoryStore::try_claim_global_phase2_job`.

*Call graph*: calls 3 internal fn (from_string, init, unique_temp_dir); 5 external calls (new_v4, assert!, assert_eq!, panic!, remove_dir_all).


##### `tests::phase2_global_lock_stale_lease_allows_takeover`  (lines 5067–5139)

```
async fn phase2_global_lock_stale_lease_allows_takeover()
```

**Purpose**: Verifies stale-lease takeover for the singleton phase-2 lock and ensures the stale owner can no longer finalize success afterward. Ownership transfer must be exclusive.

**Data flow**: Enqueues phase 2, claims it as owner A, manually expires `lease_until`, claims it as owner B and captures a different token, then asserts owner A’s success finalization returns false while owner B’s succeeds.

**Call relations**: This targets stale-lease takeover semantics in `MemoryStore::try_claim_global_phase2_job` and ownership checks in `mark_global_phase2_job_succeeded`.

*Call graph*: calls 3 internal fn (from_string, init, unique_temp_dir); 9 external calls (now, new_v4, assert!, assert_eq!, assert_ne!, panic!, query, memory_pool, remove_dir_all).


##### `tests::enqueue_global_consolidation_keeps_phase2_input_watermark_monotonic`  (lines 5142–5203)

```
async fn enqueue_global_consolidation_keeps_phase2_input_watermark_monotonic()
```

**Purpose**: Checks that enqueueing phase 2 with a lower watermark after a successful higher-watermark run still advances the bookkeeping watermark monotonically rather than decreasing it. This preserves a monotonic dirty counter.

**Data flow**: Enqueues and successfully completes phase 2 at watermark 500, then enqueues again with watermark 400, ages cooldown, claims phase 2, and asserts the returned `input_watermark` is still greater than 500.

**Call relations**: This validates the monotonic watermark update logic in `enqueue_global_consolidation_with_executor`.

*Call graph*: calls 3 internal fn (from_string, init, unique_temp_dir); 6 external calls (new_v4, assert!, assert_eq!, panic!, age_phase2_success_beyond_cooldown, remove_dir_all).


##### `tests::phase2_failure_fallback_updates_unowned_running_job`  (lines 5206–5267)

```
async fn phase2_failure_fallback_updates_unowned_running_job()
```

**Purpose**: Verifies the fallback failure path for a running global phase-2 job whose ownership token has been cleared. Strict ownership failure should miss, while the unowned fallback should transition the row to retry-unavailable error state.

**Data flow**: Enqueues and claims phase 2, manually sets `ownership_token = NULL`, calls strict `mark_global_phase2_job_failed` and asserts false, then calls `mark_global_phase2_job_failed_if_unowned` and asserts true, finally attempting a new claim and expecting `SkippedRetryUnavailable`.

**Call relations**: This test covers the recovery-oriented difference between `MemoryStore::mark_global_phase2_job_failed` and `MemoryStore::mark_global_phase2_job_failed_if_unowned`.

*Call graph*: calls 4 internal fn (from_string, new, init, unique_temp_dir); 7 external calls (new_v4, assert!, assert_eq!, panic!, query, memory_pool, remove_dir_all).


### Job and backfill state
These files define and persist operational workflow state for agent jobs and the singleton rollout-metadata backfill worker.

### `state/src/model/agent_job.rs`

`data_model` · `cross-cutting`

This file contains the core types for batch-style agent execution. `AgentJobStatus` models whole-job lifecycle states (`Pending`, `Running`, `Completed`, `Failed`, `Cancelled`) and `AgentJobItemStatus` models per-item progress (`Pending`, `Running`, `Completed`, `Failed`). Each enum provides a stable lowercase string representation for persistence and a parser that rejects unknown values with contextual `anyhow` errors.

The main structs are `AgentJob`, which stores job-wide metadata such as instruction text, CSV paths, optional JSON output schema, timestamps, and last error, and `AgentJobItem`, which stores row-level execution state including source identifiers, raw row JSON, assignment, attempts, optional result JSON, and reporting timestamps. Companion parameter structs capture creation-time inputs, while `AgentJobProgress` aggregates counts.

The important behavior lives in `TryFrom<AgentJobRow>` and `TryFrom<AgentJobItemRow>`. These conversions decode SQLite-friendly representations into typed fields: integer booleans become `bool`, optional JSON strings become `serde_json::Value`, JSON arrays become `Vec<String>`, optional integer runtime limits become `Option<u64>` with explicit overflow checking, and epoch-second timestamps become `DateTime<Utc>` through a shared validator. The timestamp helper rejects invalid Unix timestamps instead of silently normalizing them, so malformed persisted rows fail conversion early. Overall, this module keeps storage quirks localized and presents the rest of the runtime with validated, typed job records.

#### Function details

##### `AgentJobStatus::as_str`  (lines 16–24)

```
fn as_str(self) -> &'static str
```

**Purpose**: Returns the canonical lowercase storage string for a whole-job status. The mapping is fixed and used when serializing statuses into the database or logs.

**Data flow**: It takes `self` by value, matches on the enum variant, and returns a `&'static str` such as `"pending"` or `"cancelled"` without mutating any state.

**Call relations**: This is a leaf conversion helper used by persistence code that needs a stable textual representation of `AgentJobStatus`.


##### `AgentJobStatus::parse`  (lines 26–35)

```
fn parse(value: &str) -> Result<Self>
```

**Purpose**: Parses a persisted status string into an `AgentJobStatus` enum. It enforces that only known lowercase values are accepted.

**Data flow**: It reads an input `&str`, matches it against the allowed literals, returns the corresponding enum on success, and otherwise constructs an `anyhow` error containing the invalid value.

**Call relations**: Row conversion code calls this while materializing `AgentJob` values from `AgentJobRow`, and other runtime logic such as cancellation checks also relies on it when interpreting stored status text.

*Call graph*: called by 2 (try_from, is_agent_job_cancelled); 1 external calls (anyhow!).


##### `AgentJobStatus::is_final`  (lines 37–42)

```
fn is_final(self) -> bool
```

**Purpose**: Reports whether a job status is terminal. It treats `Completed`, `Failed`, and `Cancelled` as final states.

**Data flow**: It consumes `self`, evaluates a `matches!` expression over the enum variant, and returns a `bool` with no side effects.

**Call relations**: This is a pure predicate used by higher-level job orchestration to decide whether a job can still transition or receive more work.

*Call graph*: 1 external calls (matches!).


##### `AgentJobItemStatus::as_str`  (lines 54–61)

```
fn as_str(self) -> &'static str
```

**Purpose**: Returns the canonical lowercase storage string for a per-item status. It provides the persisted representation for item lifecycle values.

**Data flow**: It matches the `AgentJobItemStatus` variant and returns a corresponding `&'static str` such as `"running"` or `"failed"`.

**Call relations**: This helper supports persistence and comparison code that needs a stable textual form of item status.


##### `AgentJobItemStatus::parse`  (lines 63–71)

```
fn parse(value: &str) -> Result<Self>
```

**Purpose**: Parses a persisted item-status string into an `AgentJobItemStatus`. Unknown values are rejected rather than coerced.

**Data flow**: It takes a `&str`, matches it against the four accepted literals, returns the enum variant on success, and otherwise returns an `anyhow` error naming the invalid status.

**Call relations**: The `AgentJobItem` row conversion path invokes this while decoding `AgentJobItemRow` records from SQLite.

*Call graph*: called by 1 (try_from); 1 external calls (anyhow!).


##### `AgentJob::try_from`  (lines 164–199)

```
fn try_from(value: AgentJobRow) -> Result<Self, Self::Error>
```

**Purpose**: Converts a raw `AgentJobRow` loaded from SQLite into a validated `AgentJob`. It decodes JSON fields, converts integer-backed booleans and durations, parses status text, and validates timestamps.

**Data flow**: It consumes an `AgentJobRow`, optionally parses `output_schema_json` from JSON text into `Option<Value>`, parses `input_headers_json` into `Vec<String>`, converts `max_runtime_seconds: Option<i64>` into `Option<u64>` with overflow checking, maps `auto_export != 0` to `bool`, parses `status` via `AgentJobStatus::parse`, and converts all epoch-second fields through `epoch_seconds_to_datetime`, including optional timestamps via `map(...).transpose()`. On success it returns a fully populated `AgentJob`; on malformed JSON, invalid status text, invalid timestamps, or negative/overflowing runtime limits it returns an error.

**Call relations**: This conversion is the main bridge from SQLx row structs into the domain model. Callers that fetch `AgentJobRow` values rely on it to centralize validation and normalization before the rest of the runtime uses the job.

*Call graph*: calls 2 internal fn (parse, epoch_seconds_to_datetime); 1 external calls (from_str).


##### `AgentJobItem::try_from`  (lines 223–250)

```
fn try_from(value: AgentJobItemRow) -> Result<Self, Self::Error>
```

**Purpose**: Converts a raw `AgentJobItemRow` from SQLite into a typed `AgentJobItem`. It validates status text, parses JSON payloads, and turns epoch seconds into UTC datetimes.

**Data flow**: It consumes an `AgentJobItemRow`, copies scalar fields directly, parses `row_json` into `serde_json::Value`, parses `status` with `AgentJobItemStatus::parse`, optionally parses `result_json` when present, and converts required and optional timestamp fields with `epoch_seconds_to_datetime`. It returns the assembled `AgentJobItem` or an error if any JSON or timestamp is invalid.

**Call relations**: This is the item-level counterpart to `AgentJob::try_from`, used by query paths that load item rows and need a validated in-memory representation.

*Call graph*: calls 2 internal fn (parse, epoch_seconds_to_datetime); 1 external calls (from_str).


##### `epoch_seconds_to_datetime`  (lines 253–256)

```
fn epoch_seconds_to_datetime(secs: i64) -> Result<DateTime<Utc>>
```

**Purpose**: Validates and converts a Unix timestamp in seconds into `DateTime<Utc>`. It exists to keep timestamp parsing consistent across job and job-item row conversions.

**Data flow**: It takes an `i64` second count, calls `DateTime::<Utc>::from_timestamp(secs, 0)`, and returns the resulting datetime or an `anyhow` error if the timestamp is out of range.

**Call relations**: Both `AgentJob::try_from` and `AgentJobItem::try_from` delegate all epoch-second decoding to this helper so invalid persisted timestamps fail uniformly.

*Call graph*: called by 2 (try_from, try_from); 1 external calls (from_timestamp).


### `state/src/runtime/agent_jobs.rs`

`domain_logic` · `background job scheduling and per-item execution/reporting`

This file adds agent-job persistence methods onto `StateRuntime` for two tables: `agent_jobs` and `agent_job_items`. Creation is transactional: `create_agent_job` serializes structured fields such as `input_headers`, optional `output_schema_json`, and each item's `row_json`, inserts the parent job row with `Pending` status and timestamps, inserts all child items as `Pending`, commits, then reloads the created job through the normal decoding path. Reads convert SQL rows (`AgentJobRow`, `AgentJobItemRow`) into domain types via `TryFrom`, so malformed stored JSON or invalid enum strings surface as errors instead of silently passing through.

The update methods encode a strict state machine in SQL `WHERE` clauses. Job-level transitions move between `Pending`, `Running`, `Completed`, `Failed`, and `Cancelled`, with cancellation only succeeding from pending/running states. Item-level transitions similarly require expected prior states: only pending items can be claimed as running, only running items can be reset, completed, failed, or assigned a thread, and `report_agent_job_item_result` additionally requires the reporting thread to match `assigned_thread_id`. That makes late or duplicate reports harmless: the update affects zero rows and returns `false`. `mark_agent_job_item_completed` also requires `result_json IS NOT NULL`, separating “result recorded” from “completion finalized.” Progress is computed with SQL aggregates and defensively converted from `i64` to `usize`, defaulting on impossible negative/overflow cases. The tests focus on the atomic result-report path and rejection of stale reports after failure.

#### Function details

##### `StateRuntime::create_agent_job`  (lines 5–99)

```
async fn create_agent_job(
        &self,
        params: &AgentJobCreateParams,
        items: &[AgentJobItemCreateParams],
    ) -> anyhow::Result<AgentJob>
```

**Purpose**: Creates one `agent_jobs` row plus all associated `agent_job_items` rows in a single transaction, initializing statuses and timestamps. After commit, it reloads the job through the normal read path and fails if the inserted job cannot be fetched back.

**Data flow**: Reads `params` and `items`, captures `Utc::now().timestamp()`, serializes `params.input_headers`, optional `params.output_schema_json`, and each item's `row_json`, converts optional `max_runtime_seconds` from `usize`-like input to `i64`, then inserts the parent row and each child row into SQLite via a transaction on `self.pool`. It returns the decoded `AgentJob`; on serialization, conversion, SQL, or reload failure it returns an `anyhow::Error`.

**Call relations**: This is the entry point used by higher-level job creation flows. After writing rows it delegates to `StateRuntime::get_agent_job` so the returned object is produced by the same decoding logic as later reads, rather than reconstructing it manually.

*Call graph*: calls 1 internal fn (get_agent_job); 4 external calls (now, from, to_string, query).


##### `StateRuntime::get_agent_job`  (lines 101–128)

```
async fn get_agent_job(&self, job_id: &str) -> anyhow::Result<Option<AgentJob>>
```

**Purpose**: Loads a single job row by `id` from `agent_jobs` and converts it into the domain `AgentJob`. Missing rows return `Ok(None)` rather than an error.

**Data flow**: Takes `job_id`, runs a `SELECT` over all persisted job columns, fetches at most one `AgentJobRow`, and maps that row through `AgentJob::try_from`. It returns `Option<AgentJob>` wrapped in `anyhow::Result`.

**Call relations**: It is used immediately after insertion by `StateRuntime::create_agent_job` to verify the committed row can be read back and decoded correctly.

*Call graph*: called by 1 (create_agent_job).


##### `StateRuntime::list_agent_job_items`  (lines 130–172)

```
async fn list_agent_job_items(
        &self,
        job_id: &str,
        status: Option<AgentJobItemStatus>,
        limit: Option<usize>,
    ) -> anyhow::Result<Vec<AgentJobItem>>
```

**Purpose**: Returns ordered item rows for one job, optionally filtered by item status and capped by a limit. The SQL is built dynamically so absent filters do not add unnecessary predicates.

**Data flow**: Consumes `job_id`, optional `AgentJobItemStatus`, and optional `limit`; builds a `QueryBuilder<Sqlite>` query with `WHERE job_id = ?`, optional `AND status = ?`, `ORDER BY row_index ASC`, and optional `LIMIT`. It fetches `Vec<AgentJobItemRow>` and converts each row into `AgentJobItem`, returning the collected vector.

**Call relations**: This is a read-side helper for callers that need to inspect queued, running, or completed items for a job. It does not delegate to other local methods because it performs a bulk query and conversion directly.

*Call graph*: 1 external calls (new).


##### `StateRuntime::get_agent_job_item`  (lines 174–205)

```
async fn get_agent_job_item(
        &self,
        job_id: &str,
        item_id: &str,
    ) -> anyhow::Result<Option<AgentJobItem>>
```

**Purpose**: Fetches one specific item identified by `(job_id, item_id)` and decodes it into `AgentJobItem`. It distinguishes absence from decode or SQL failure.

**Data flow**: Reads `job_id` and `item_id`, executes a `SELECT` over all item columns from `agent_job_items`, fetches an optional `AgentJobItemRow`, and maps it through `AgentJobItem::try_from`. Returns `Ok(None)` if no row matches.

**Call relations**: This is a direct lookup used by tests and likely by higher-level execution/reporting code to inspect the latest persisted state of one item.


##### `StateRuntime::mark_agent_job_running`  (lines 207–228)

```
async fn mark_agent_job_running(&self, job_id: &str) -> anyhow::Result<()>
```

**Purpose**: Transitions a job to `Running`, stamps `updated_at`, initializes `started_at` if it was previously null, and clears completion/error fields. It does not enforce a prior status check.

**Data flow**: Takes `job_id`, computes `now`, and issues an `UPDATE agent_jobs` setting `status`, `updated_at`, `started_at = COALESCE(started_at, now)`, `completed_at = NULL`, and `last_error = NULL`. It writes only to the database and returns `()` on success.

**Call relations**: Called when a worker begins processing a job. It is independent of item transitions, which are handled by separate item-level methods.

*Call graph*: 2 external calls (now, query).


##### `StateRuntime::mark_agent_job_completed`  (lines 230–246)

```
async fn mark_agent_job_completed(&self, job_id: &str) -> anyhow::Result<()>
```

**Purpose**: Marks the whole job as completed and records a completion timestamp. It also clears any previous error text.

**Data flow**: Consumes `job_id`, computes `now`, and updates the matching `agent_jobs` row to `status = Completed`, `updated_at = now`, `completed_at = now`, `last_error = NULL`. Returns `()`.

**Call relations**: Used by orchestration code once all items have been successfully finalized; it does not inspect item state itself.

*Call graph*: 2 external calls (now, query).


##### `StateRuntime::mark_agent_job_failed`  (lines 248–269)

```
async fn mark_agent_job_failed(
        &self,
        job_id: &str,
        error_message: &str,
    ) -> anyhow::Result<()>
```

**Purpose**: Marks the whole job as failed and stores a human-readable error message. Completion time is set at failure time.

**Data flow**: Reads `job_id` and `error_message`, computes `now`, and updates the job row with `status = Failed`, `updated_at = now`, `completed_at = now`, and `last_error = error_message`. Returns `()`.

**Call relations**: Used when job-level execution aborts. Unlike cancellation, it does not restrict which prior statuses may be overwritten.

*Call graph*: 2 external calls (now, query).


##### `StateRuntime::mark_agent_job_cancelled`  (lines 271–294)

```
async fn mark_agent_job_cancelled(
        &self,
        job_id: &str,
        reason: &str,
    ) -> anyhow::Result<bool>
```

**Purpose**: Attempts to cancel a job only if it is still pending or running, recording the cancellation reason. The boolean result tells callers whether the transition actually happened.

**Data flow**: Consumes `job_id` and `reason`, computes `now`, and runs an `UPDATE` guarded by `status IN (Pending, Running)`. It writes `Cancelled`, timestamps, and `last_error = reason`, then returns `true` if `rows_affected() > 0`.

**Call relations**: This is the safe cancellation path for external stop requests. The guarded update prevents terminal jobs from being overwritten after completion or failure.

*Call graph*: 2 external calls (now, query).


##### `StateRuntime::is_agent_job_cancelled`  (lines 296–312)

```
async fn is_agent_job_cancelled(&self, job_id: &str) -> anyhow::Result<bool>
```

**Purpose**: Checks whether a persisted job currently has `Cancelled` status. Missing jobs are treated as not cancelled.

**Data flow**: Takes `job_id`, selects only the `status` column, returns `false` if no row exists, otherwise parses the stored string with `AgentJobStatus::parse` and compares it to `Cancelled`. It returns a boolean in `anyhow::Result`.

**Call relations**: This is a polling helper for runners that need to stop work cooperatively if a cancellation request has been persisted.

*Call graph*: calls 1 internal fn (parse); 1 external calls (query).


##### `StateRuntime::mark_agent_job_item_running`  (lines 314–340)

```
async fn mark_agent_job_item_running(
        &self,
        job_id: &str,
        item_id: &str,
    ) -> anyhow::Result<bool>
```

**Purpose**: Claims a pending item for execution without attaching a thread id, increments its attempt counter, and clears any prior error. It succeeds only from the `Pending` state.

**Data flow**: Reads `job_id` and `item_id`, computes `now`, and updates the matching row where `status = Pending`, setting `status = Running`, `assigned_thread_id = NULL`, `attempt_count = attempt_count + 1`, `updated_at = now`, and `last_error = NULL`. Returns whether one row changed.

**Call relations**: Used by item runners that do not yet have or need a thread assignment. The guarded update prevents double-claiming the same item.

*Call graph*: 2 external calls (now, query).


##### `StateRuntime::mark_agent_job_item_running_with_thread`  (lines 342–370)

```
async fn mark_agent_job_item_running_with_thread(
        &self,
        job_id: &str,
        item_id: &str,
        thread_id: &str,
    ) -> anyhow::Result<bool>
```

**Purpose**: Claims a pending item for execution and records the thread responsible for reporting its result. It also increments attempts and clears stale errors.

**Data flow**: Consumes `job_id`, `item_id`, and `thread_id`, computes `now`, and updates the row only if it is currently pending. It writes `status = Running`, `assigned_thread_id = thread_id`, increments `attempt_count`, updates `updated_at`, clears `last_error`, and returns a success boolean.

**Call relations**: This is the thread-aware claim path used by the tests’ setup helper and by execution flows that later rely on thread ownership checks in `StateRuntime::report_agent_job_item_result`.

*Call graph*: 2 external calls (now, query).


##### `StateRuntime::mark_agent_job_item_pending`  (lines 372–399)

```
async fn mark_agent_job_item_pending(
        &self,
        job_id: &str,
        item_id: &str,
        error_message: Option<&str>,
    ) -> anyhow::Result<bool>
```

**Purpose**: Moves a running item back to pending, optionally preserving an error message explaining why it was requeued. It clears any assigned thread.

**Data flow**: Reads `job_id`, `item_id`, and optional `error_message`, computes `now`, and updates only rows currently in `Running`. It writes `status = Pending`, `assigned_thread_id = NULL`, `updated_at = now`, and `last_error = error_message`, returning whether the transition occurred.

**Call relations**: Used for retry/requeue behavior after a running attempt should be abandoned without marking the item terminal.

*Call graph*: 2 external calls (now, query).


##### `StateRuntime::set_agent_job_item_thread`  (lines 401–423)

```
async fn set_agent_job_item_thread(
        &self,
        job_id: &str,
        item_id: &str,
        thread_id: &str,
    ) -> anyhow::Result<bool>
```

**Purpose**: Attaches or replaces the `assigned_thread_id` for an item that is already running. It refuses to modify non-running items.

**Data flow**: Consumes `job_id`, `item_id`, and `thread_id`, computes `now`, and updates `assigned_thread_id` plus `updated_at` where the row matches and `status = Running`. Returns `true` if the row was updated.

**Call relations**: This supports flows where an item is first marked running and only later associated with a concrete thread identifier.

*Call graph*: 2 external calls (now, query).


##### `StateRuntime::report_agent_job_item_result`  (lines 425–464)

```
async fn report_agent_job_item_result(
        &self,
        job_id: &str,
        item_id: &str,
        reporting_thread_id: &str,
        result_json: &Value,
    ) -> anyhow::Result<bool>
```

**Purpose**: Atomically records a JSON result payload and completes the item, but only if the reporting thread still owns the running item. This prevents late or stolen reports from overwriting newer state.

**Data flow**: Reads `job_id`, `item_id`, `reporting_thread_id`, and `result_json`; serializes the JSON value to a string; computes `now`; then updates the row only when `status = Running` and `assigned_thread_id = reporting_thread_id`. It writes `status = Completed`, `result_json`, `reported_at`, `completed_at`, `updated_at`, clears `last_error`, clears `assigned_thread_id`, and returns whether the update matched.

**Call relations**: This is the key result-ingest path exercised by both tests. Its ownership and status predicates are what make completion atomic and reject late reports after another transition such as failure.

*Call graph*: 3 external calls (now, to_string, query).


##### `StateRuntime::mark_agent_job_item_completed`  (lines 466–496)

```
async fn mark_agent_job_item_completed(
        &self,
        job_id: &str,
        item_id: &str,
    ) -> anyhow::Result<bool>
```

**Purpose**: Finalizes a running item as completed only if a result payload has already been stored. It clears thread assignment and stamps completion time.

**Data flow**: Consumes `job_id` and `item_id`, computes `now`, and updates rows matching the item, `status = Running`, and `result_json IS NOT NULL`. It writes `status = Completed`, `completed_at`, `updated_at`, and `assigned_thread_id = NULL`, returning whether a row changed.

**Call relations**: This supports a two-step completion flow where result persistence may happen separately from terminal status transition; the SQL guard enforces the invariant that completed items must have a result.

*Call graph*: 2 external calls (now, query).


##### `StateRuntime::mark_agent_job_item_failed`  (lines 498–530)

```
async fn mark_agent_job_item_failed(
        &self,
        job_id: &str,
        item_id: &str,
        error_message: &str,
    ) -> anyhow::Result<bool>
```

**Purpose**: Marks a running item as failed, records the failure message, and releases any thread assignment. It only applies to currently running items.

**Data flow**: Reads `job_id`, `item_id`, and `error_message`, computes `now`, and updates the matching running row to `status = Failed`, `completed_at = now`, `updated_at = now`, `last_error = error_message`, `assigned_thread_id = NULL`. Returns whether the update matched.

**Call relations**: Used when item execution terminates unsuccessfully. The tests use it to prove that a later `report_agent_job_item_result` call is rejected.

*Call graph*: 2 external calls (now, query).


##### `StateRuntime::get_agent_job_progress`  (lines 532–566)

```
async fn get_agent_job_progress(&self, job_id: &str) -> anyhow::Result<AgentJobProgress>
```

**Purpose**: Computes aggregate counts of pending, running, completed, and failed items for one job. It returns a normalized `AgentJobProgress` struct with `usize` fields.

**Data flow**: Takes `job_id`, runs a single aggregate query with `COUNT(*)` and `SUM(CASE WHEN status = ... THEN 1 ELSE 0 END)` for each tracked status, extracts `i64`/`Option<i64>` values, converts them to `usize` with fallbacks, and returns `AgentJobProgress`.

**Call relations**: This is a read-side summary helper for dashboards or orchestration code deciding whether a job is finished or still has active work.

*Call graph*: 2 external calls (query, try_from).


##### `tests::create_running_single_item_job`  (lines 576–613)

```
async fn create_running_single_item_job(
        runtime: &StateRuntime,
    ) -> anyhow::Result<(String, String, String)>
```

**Purpose**: Builds a minimal one-item job fixture already transitioned into a running state with an assigned thread. It centralizes repetitive setup for the result-report tests.

**Data flow**: Given a `StateRuntime`, it constructs fixed `job_id`, `item_id`, and `thread_id` strings, calls job creation with one JSON row, marks the job running, marks the item running with the thread, asserts that claim succeeded, and returns the three identifiers.

**Call relations**: Both async tests call this helper before exercising success or late-report rejection paths, so they start from the same persisted state.

*Call graph*: 6 external calls (assert!, json!, create_agent_job, mark_agent_job_item_running_with_thread, mark_agent_job_running, vec!).


##### `tests::report_agent_job_item_result_completes_item_atomically`  (lines 616–653)

```
async fn report_agent_job_item_result_completes_item_atomically() -> anyhow::Result<()>
```

**Purpose**: Verifies that reporting a result both stores the JSON payload and transitions the item to completed in one accepted update. It also checks progress counters and cleanup of thread/error fields.

**Data flow**: Creates a temporary runtime, uses `create_running_single_item_job`, submits a JSON result through `report_agent_job_item_result`, then reloads the item and progress summary to assert completed status, stored result, cleared assignment/error, and populated timestamps.

**Call relations**: This test exercises the happy path of `StateRuntime::report_agent_job_item_result` and indirectly validates `get_agent_job_item` and `get_agent_job_progress` after the atomic update.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 4 external calls (assert!, assert_eq!, json!, create_running_single_item_job).


##### `tests::report_agent_job_item_result_rejects_late_reports`  (lines 656–683)

```
async fn report_agent_job_item_result_rejects_late_reports() -> anyhow::Result<()>
```

**Purpose**: Proves that once a running item has already been failed, a later result report from the old thread is ignored rather than overwriting terminal state. The persisted failure remains intact.

**Data flow**: Creates a temporary runtime and running fixture, marks the item failed with an error message, then attempts to report a JSON result. It asserts the report was rejected and reloads the item to confirm status is still `Failed`, `result_json` is absent, and `last_error` is preserved.

**Call relations**: This test targets the ownership/status guard in `StateRuntime::report_agent_job_item_result`, demonstrating why the SQL `WHERE` clause includes both running status and matching assigned thread.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 4 external calls (assert!, assert_eq!, json!, create_running_single_item_job).


### `state/src/model/backfill_state.rs`

`data_model` · `startup`

This module models a single-row control record used by rollout metadata backfill. `BackfillState` stores three pieces of state: the current `BackfillStatus`, an optional `last_watermark` string identifying the last processed rollout position, and an optional `last_success_at` timestamp. Its `Default` implementation intentionally represents a never-run backfill: `Pending` status with no watermark and no success time.

`BackfillStatus` is a compact enum with `Pending`, `Running`, and `Complete` variants plus string conversion helpers. The parser is strict and returns an error for any unknown persisted value, preventing silent acceptance of corrupted or future-incompatible rows.

The main operational function is `BackfillState::try_from_row`, which reads named columns from a `sqlx::sqlite::SqliteRow`. It extracts `status` as a string, `last_watermark` as an optional string, and `last_success_at` as an optional epoch-second integer. Optional timestamps are converted with `map(...).transpose()` so `NULL` remains `None` while malformed integers become errors. The private timestamp helper wraps `DateTime::<Utc>::from_timestamp` and rejects invalid values. Together these pieces ensure the backfill subsystem sees a small, strongly typed state object rather than raw SQL values.

#### Function details

##### `BackfillState::default`  (lines 19–25)

```
fn default() -> Self
```

**Purpose**: Constructs the initial in-memory backfill state used when no persisted progress exists yet. It represents an untouched backfill run.

**Data flow**: It takes no inputs and returns a `BackfillState` with `status` set to `BackfillStatus::Pending` and both optional fields set to `None`.

**Call relations**: Backfill orchestration uses this default when it needs a baseline state before or instead of loading a persisted row.

*Call graph*: called by 1 (backfill_sessions_with_lease).


##### `BackfillState::try_from_row`  (lines 29–40)

```
fn try_from_row(row: &SqliteRow) -> Result<Self>
```

**Purpose**: Builds a typed `BackfillState` from a SQLite result row. It validates the status string and converts the optional success timestamp into UTC.

**Data flow**: It reads `status`, `last_watermark`, and `last_success_at` columns from a borrowed `SqliteRow` using `try_get`. The status string is parsed with `BackfillStatus::parse`; `last_success_at` is read as `Option<i64>` and converted through `epoch_seconds_to_datetime` with `transpose()` so nulls stay absent and invalid timestamps error. It returns the assembled `BackfillState` or a conversion error.

**Call relations**: Database read code such as `get_backfill_state` invokes this after fetching a row. The function delegates status interpretation to `BackfillStatus::parse` and timestamp validation to the local helper.

*Call graph*: calls 1 internal fn (parse); called by 1 (get_backfill_state); 1 external calls (try_get).


##### `BackfillStatus::as_str`  (lines 52–58)

```
fn as_str(self) -> &'static str
```

**Purpose**: Returns the canonical lowercase string form of a backfill lifecycle status. This is the persisted representation written into the database.

**Data flow**: It matches the enum variant and returns one of `"pending"`, `"running"`, or `"complete"`.

**Call relations**: Persistence code uses this helper when writing backfill status values, including startup initialization paths that seed the control row.


##### `BackfillStatus::parse`  (lines 60–67)

```
fn parse(value: &str) -> Result<Self>
```

**Purpose**: Parses a persisted status string into a `BackfillStatus` enum. It rejects any value outside the known lifecycle vocabulary.

**Data flow**: It takes a `&str`, matches it against the three accepted literals, returns the corresponding enum variant, or returns an `anyhow` error naming the invalid value.

**Call relations**: `BackfillState::try_from_row` calls this while decoding the `status` column from SQLite.

*Call graph*: called by 1 (try_from_row); 1 external calls (anyhow!).


##### `epoch_seconds_to_datetime`  (lines 70–73)

```
fn epoch_seconds_to_datetime(secs: i64) -> Result<DateTime<Utc>>
```

**Purpose**: Converts a Unix timestamp in seconds into `DateTime<Utc>` with validation. It prevents invalid persisted timestamps from entering the backfill model.

**Data flow**: It accepts an `i64` second count, calls `DateTime::<Utc>::from_timestamp(secs, 0)`, and returns either the datetime or an `anyhow` error if conversion fails.

**Call relations**: This helper is used inside `BackfillState::try_from_row` for the optional `last_success_at` field.

*Call graph*: 1 external calls (from_timestamp).


### `state/src/runtime/backfill.rs`

`domain_logic` · `startup and background backfill coordination`

This file extends `StateRuntime` with a tiny state machine around the `backfill_state` table. Every public method begins by ensuring the singleton row with `id = 1` exists, via `ensure_backfill_state_row`, so callers do not need separate initialization logic and reads can self-heal after accidental deletion. `get_backfill_state` then reads `status`, `last_watermark`, and `last_success_at` and delegates row decoding to `crate::BackfillState::try_from_row`.

The claim path is lease-based rather than owner-based. `try_claim_backfill` computes `lease_cutoff = now - lease_seconds`, then updates the singleton row to `Running` only if the backfill is not already `Complete` and either not currently `Running` or running with an expired `updated_at`. A successful update means this runtime claimed the worker slot. Separate helpers mark the backfill running, checkpoint a `last_watermark` while keeping status `Running`, and mark completion while optionally replacing the watermark and always setting `last_success_at` and `updated_at` to the same current timestamp.

The tests cover the intended edge cases: progress persists across transitions, reads still succeed while another SQLite connection holds an immediate write transaction, deleting the singleton row is repaired transparently, stale running leases can be reclaimed, and completed backfills cannot be claimed again. The design intentionally uses `updated_at` as the lease heartbeat field, avoiding a separate lease column.

#### Function details

##### `StateRuntime::get_backfill_state`  (lines 4–16)

```
async fn get_backfill_state(&self) -> anyhow::Result<crate::BackfillState>
```

**Purpose**: Loads the singleton backfill state row and converts it into `crate::BackfillState`. It first guarantees the row exists so callers always get a coherent defaultable state.

**Data flow**: Reads no external inputs beyond `self`, calls `ensure_backfill_state_row`, selects `status`, `last_watermark`, and `last_success_at` from `backfill_state WHERE id = 1`, and passes the fetched row to `crate::BackfillState::try_from_row`. Returns the decoded state or an error.

**Call relations**: This is the main read API for backfill status. It depends on `StateRuntime::ensure_backfill_state_row` so reads can repair missing singleton state before decoding.

*Call graph*: calls 2 internal fn (try_from_row, ensure_backfill_state_row); 1 external calls (query).


##### `StateRuntime::try_claim_backfill`  (lines 23–44)

```
async fn try_claim_backfill(&self, lease_seconds: i64) -> anyhow::Result<bool>
```

**Purpose**: Attempts to atomically claim the singleton backfill worker slot using a lease timeout. It refuses claims when the backfill is complete or when another non-stale runner still owns the slot.

**Data flow**: Consumes `lease_seconds`, ensures the singleton row exists, computes `now` and `lease_cutoff`, then updates `backfill_state` to `status = Running, updated_at = now` only when `id = 1`, status is not `Complete`, and either status is not `Running` or `updated_at <= lease_cutoff`. It returns `true` if exactly one row was updated.

**Call relations**: This is the coordination primitive used by higher-level backfill workers. It relies on `ensure_backfill_state_row` and encodes the lease semantics directly in SQL rather than with a separate owner record.

*Call graph*: calls 1 internal fn (ensure_backfill_state_row); 2 external calls (now, query).


##### `StateRuntime::mark_backfill_running`  (lines 47–61)

```
async fn mark_backfill_running(&self) -> anyhow::Result<()>
```

**Purpose**: Forces the singleton backfill state to `Running` and refreshes its heartbeat timestamp. It does not perform lease checks.

**Data flow**: Ensures the row exists, computes the current timestamp, and updates `status` and `updated_at` for `id = 1`. Returns `()` on success.

**Call relations**: Used by code that already knows it should be considered the active backfill worker and just needs to persist that state.

*Call graph*: calls 1 internal fn (ensure_backfill_state_row); 2 external calls (now, query).


##### `StateRuntime::checkpoint_backfill`  (lines 64–79)

```
async fn checkpoint_backfill(&self, watermark: &str) -> anyhow::Result<()>
```

**Purpose**: Persists in-progress backfill progress by storing the latest processed watermark while keeping the state marked as running. This acts as resumable progress metadata.

**Data flow**: Consumes `watermark`, ensures the singleton row exists, computes `Utc::now().timestamp()`, and updates `status = Running`, `last_watermark = watermark`, and `updated_at` for `id = 1`. Returns `()`.

**Call relations**: Called during long-running backfill work to advance progress without marking completion. It shares the same singleton-row precondition helper as the other methods.

*Call graph*: calls 1 internal fn (ensure_backfill_state_row); 2 external calls (now, query).


##### `StateRuntime::mark_backfill_complete`  (lines 82–103)

```
async fn mark_backfill_complete(&self, last_watermark: Option<&str>) -> anyhow::Result<()>
```

**Purpose**: Marks the singleton backfill as complete, records success time, and optionally updates the final watermark. Existing watermark is preserved when no new one is supplied.

**Data flow**: Consumes optional `last_watermark`, ensures the row exists, computes `now`, and updates `status = Complete`, `last_watermark = COALESCE(input, existing)`, `last_success_at = now`, and `updated_at = now` for `id = 1`. Returns `()`.

**Call relations**: This is the terminal success transition for the backfill worker. After this, `StateRuntime::try_claim_backfill` will refuse future claims.

*Call graph*: calls 1 internal fn (ensure_backfill_state_row); 2 external calls (now, query).


##### `StateRuntime::ensure_backfill_state_row`  (lines 105–107)

```
async fn ensure_backfill_state_row(&self) -> anyhow::Result<()>
```

**Purpose**: Delegates to the shared pool-level helper that creates or repairs the singleton `backfill_state` row. It hides that initialization detail behind the runtime API.

**Data flow**: Reads `self.pool` and passes it to `ensure_backfill_state_row_in_pool`, returning only success or failure. It does not itself inspect or return row contents.

**Call relations**: Every public backfill method calls this first so reads and writes can assume `backfill_state(id=1)` exists.

*Call graph*: called by 5 (checkpoint_backfill, get_backfill_state, mark_backfill_complete, mark_backfill_running, try_claim_backfill).


##### `tests::backfill_state_persists_progress_and_completion`  (lines 120–170)

```
async fn backfill_state_persists_progress_and_completion()
```

**Purpose**: Checks the normal lifecycle from default pending state through running, checkpointed progress, and final completion. It verifies watermark and success timestamp persistence.

**Data flow**: Creates a temporary runtime, reads initial state, calls `mark_backfill_running`, `checkpoint_backfill`, and `mark_backfill_complete`, then reloads state after each phase and asserts expected field values before cleaning up the temp directory.

**Call relations**: This test exercises the happy-path interaction among the public backfill state methods.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 3 external calls (assert!, assert_eq!, remove_dir_all).


##### `tests::get_backfill_state_succeeds_while_another_connection_holds_writer_slot`  (lines 173–199)

```
async fn get_backfill_state_succeeds_while_another_connection_holds_writer_slot()
```

**Purpose**: Verifies that reading backfill state still works while a separate SQLite connection holds an immediate write transaction. This guards against read-path fragility under writer contention.

**Data flow**: Initializes a runtime, opens a second connection with `base_sqlite_options`, begins `BEGIN IMMEDIATE` to hold the writer slot, calls `get_backfill_state`, asserts it returns the default state, then rolls back and removes the temp directory.

**Call relations**: This test specifically targets the robustness of `StateRuntime::get_backfill_state` and the singleton-row repair/read path under SQLite locking conditions.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 5 external calls (assert_eq!, state_db_path, connect_with, base_sqlite_options, remove_dir_all).


##### `tests::get_backfill_state_repairs_a_missing_singleton_row`  (lines 202–225)

```
async fn get_backfill_state_repairs_a_missing_singleton_row()
```

**Purpose**: Confirms that deleting the singleton row does not permanently break the API because the next read recreates it. It also verifies only one repaired row exists afterward.

**Data flow**: Creates a runtime, manually deletes `backfill_state WHERE id = 1`, calls `get_backfill_state`, asserts the returned state is default, then counts rows with `id = 1` to ensure the repair recreated exactly one singleton row.

**Call relations**: This test validates the contract provided by `StateRuntime::ensure_backfill_state_row`, which all public methods depend on.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 3 external calls (assert_eq!, query, remove_dir_all).


##### `tests::backfill_claim_is_singleton_until_stale_and_blocked_when_complete`  (lines 228–277)

```
async fn backfill_claim_is_singleton_until_stale_and_blocked_when_complete()
```

**Purpose**: Tests the lease-based claim semantics: first claim succeeds, duplicate fresh claim fails, stale running state can be reclaimed, and completed state blocks future claims. It captures the intended worker-slot behavior.

**Data flow**: Initializes a runtime, calls `try_claim_backfill` twice, manually ages `updated_at` to a stale timestamp, claims again with a short lease, marks completion, then attempts one final claim and asserts the expected booleans at each step.

**Call relations**: This test directly exercises `StateRuntime::try_claim_backfill` and `StateRuntime::mark_backfill_complete`, proving the SQL lease and completion guards behave as designed.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 4 external calls (now, assert_eq!, query, remove_dir_all).


### Auxiliary runtime records
These files cover additional SQLite-backed runtime records for logs, external import tracking, and remote-control enrollment.

### `state/src/model/log.rs`

`data_model` · `request handling and query execution whenever logs are inserted, fetched, or serialized`

This file provides three related data structures for log storage and retrieval. `LogEntry` is the richer serialized record shape intended for outward-facing use: it includes timestamps (`ts`, `ts_nanos`), severity and target strings, optional message content, optional `feedback_log_body`, thread/process identifiers, module path, source file, and line number. It derives `Serialize`, making it suitable for API responses or JSON export.

`LogRow` is the SQL-mapped storage representation, deriving `sqlx::FromRow`. It includes the database primary key `id` and most of the same core fields, but notably omits `feedback_log_body` and `module_path`, reflecting the exact columns expected from SQL queries rather than the full serialized view. Keeping this separate avoids coupling query code to presentation concerns.

`LogQuery` is a caller-built filter object with a `Default` implementation. It captures level filtering via uppercase strings, timestamp bounds, module/file wildcard lists, explicit thread IDs, free-text search, whether threadless rows should be included, cursor-style pagination through `after_id`, optional `limit`, and sort direction via `descending`. The shape makes query construction explicit and composable: absent options mean no filter, while vectors allow multi-value predicates. This file is purely schema-oriented; SQL generation and execution happen in the log DB layer.


### `state/src/runtime/external_agent_config_imports.rs`

`domain_logic` · `post-import result recording and history/detail retrieval`

This file contains four serializable record structs that describe external agent configuration import outcomes: success entries, failure entries, a detail view combining both lists, and a history view that also includes `import_id` and `completed_at_ms`. The records intentionally preserve concrete import metadata such as `item_type`, optional working directory (`PathBuf`), source and target identifiers, failure stage, and optional error type.

`StateRuntime::record_external_agent_config_import_completed` writes one row per `import_id` into `external_agent_config_imports`, storing the current completion time in epoch milliseconds via `datetime_to_epoch_millis(Utc::now())` and serializing the success/failure slices as JSON strings. The SQL uses `ON CONFLICT(import_id) DO UPDATE`, so repeated completion writes for the same import replace the stored payload rather than creating duplicates.

The two read methods reverse that process. `external_agent_config_import_details_record` fetches one row by `import_id`, extracts the `successes` and `failures` JSON columns, and deserializes them into an `ExternalAgentConfigImportDetailsRecord`. `external_agent_config_import_history_records` fetches all rows ordered by newest completion time then `import_id`, deserializing each row into `ExternalAgentConfigImportHistoryRecord`. The design keeps the schema simple—JSON blobs in SQLite—while exposing strongly typed Rust records to callers. Tests live in a separate file referenced with `#[path = ...]`.

#### Function details

##### `StateRuntime::record_external_agent_config_import_completed`  (lines 42–70)

```
async fn record_external_agent_config_import_completed(
        &self,
        import_id: &str,
        successes: &[ExternalAgentConfigImportSuccessRecord],
        failures: &[ExternalAgentConfigImp
```

**Purpose**: Upserts the final success and failure lists for a completed external-agent-config import. Reusing the same `import_id` overwrites the previous stored payload and completion timestamp.

**Data flow**: Consumes `import_id`, slices of `ExternalAgentConfigImportSuccessRecord` and `ExternalAgentConfigImportFailureRecord`, computes current epoch milliseconds, serializes both slices to JSON strings, and inserts or updates the `external_agent_config_imports` row in SQLite. It writes database state only and returns `()`.

**Call relations**: This is the write-side API used when an import finishes. Later reads through the detail and history methods deserialize exactly the JSON written here.

*Call graph*: 4 external calls (now, datetime_to_epoch_millis, to_string, query).


##### `StateRuntime::external_agent_config_import_details_record`  (lines 72–98)

```
async fn external_agent_config_import_details_record(
        &self,
        import_id: &str,
    ) -> anyhow::Result<Option<ExternalAgentConfigImportDetailsRecord>>
```

**Purpose**: Loads the stored success and failure payloads for one import id and returns them as a typed detail record. Missing imports return `None`.

**Data flow**: Reads `import_id`, selects `successes` and `failures` from `external_agent_config_imports`, fetches an optional row, extracts both columns as `String`, deserializes them from JSON into vectors, and wraps them in `ExternalAgentConfigImportDetailsRecord`.

**Call relations**: This is the per-import read path paired with `StateRuntime::record_external_agent_config_import_completed`, used when callers need the exact stored outcome for one import.

*Call graph*: 1 external calls (query).


##### `StateRuntime::external_agent_config_import_history_records`  (lines 100–131)

```
async fn external_agent_config_import_history_records(
        &self,
    ) -> anyhow::Result<Vec<ExternalAgentConfigImportHistoryRecord>>
```

**Purpose**: Returns all recorded imports as typed history records ordered by newest completion time first. Each row includes both metadata and deserialized success/failure lists.

**Data flow**: Runs a `SELECT` over `import_id`, `completed_at_ms`, `successes`, and `failures`, ordered by `completed_at_ms DESC, import_id ASC`; for each row it extracts scalar columns, deserializes the JSON payloads, and collects `ExternalAgentConfigImportHistoryRecord` values into a vector.

**Call relations**: This is the aggregate read path for UI/history views. It complements the single-record detail lookup and consumes the same persisted JSON schema.

*Call graph*: 1 external calls (query).


### `state/src/runtime/remote_control.rs`

`domain_logic` · `runtime request handling for remote-control enrollment persistence`

This file defines the persisted shape of a remote-control enrollment and the SQL used to read, insert/update, toggle, and delete those rows from the `remote_control_enrollments` table. The central data type is `RemoteControlEnrollmentRecord`, which stores the websocket endpoint, account identity, optional app-server client name, server/environment identifiers, server display name, and an optional `remote_control_enabled` preference. Because SQLite uniqueness and equality checks are simpler with non-null key columns, the file uses an empty-string sentinel (`REMOTE_CONTROL_APP_SERVER_CLIENT_NAME_NONE`) to encode `None` for `app_server_client_name`. `remote_control_app_server_client_name_key` performs the write-side normalization, while `app_server_client_name_from_key` reverses it on reads.

`StateRuntime::get_remote_control_enrollment` performs a keyed lookup and reconstructs the record from a row, including nullable `remote_control_enabled`. `upsert_remote_control_enrollment` inserts or updates by the composite key `(websocket_url, account_id, app_server_client_name)`, refreshing server identity fields and `updated_at`; notably, the conflict update clause does not overwrite `remote_control_enabled`, so preference changes are expected to flow through `set_remote_control_enabled`. `delete_remote_control_enrollment` removes exactly one keyed enrollment and returns affected-row count. The tests cover round-tripping by account/client tuple, selective deletion, and migration compatibility where legacy rows lacking the new preference column must surface as `None` after schema upgrade.

#### Function details

##### `remote_control_app_server_client_name_key`  (lines 17–19)

```
fn remote_control_app_server_client_name_key(app_server_client_name: Option<&str>) -> &str
```

**Purpose**: Converts an optional app-server client name into the canonical database key representation. `None` becomes the empty-string sentinel so the composite key can be stored and queried consistently.

**Data flow**: It takes `Option<&str>` and returns `&str`, either the provided client name or `REMOTE_CONTROL_APP_SERVER_CLIENT_NAME_NONE`. It reads no external state and writes nothing.

**Call relations**: This helper sits on every write and keyed lookup path for remote-control enrollments. `get_remote_control_enrollment`, `upsert_remote_control_enrollment`, `set_remote_control_enabled`, and `delete_remote_control_enrollment` all call it before binding the key column so they agree on how `None` is represented.

*Call graph*: called by 4 (delete_remote_control_enrollment, get_remote_control_enrollment, set_remote_control_enabled, upsert_remote_control_enrollment).


##### `app_server_client_name_from_key`  (lines 21–27)

```
fn app_server_client_name_from_key(app_server_client_name: String) -> Option<String>
```

**Purpose**: Decodes the stored key representation back into the public optional client-name field. It treats the empty-string sentinel as absence and preserves any non-empty string.

**Data flow**: It accepts an owned `String` loaded from SQLite and returns `Option<String>`, mapping `""` to `None` and any other value to `Some(value)`. No external state is touched.

**Call relations**: This helper is used during row-to-record reconstruction inside `StateRuntime::get_remote_control_enrollment`. It is the read-side counterpart to `remote_control_app_server_client_name_key`.


##### `StateRuntime::get_remote_control_enrollment`  (lines 30–65)

```
async fn get_remote_control_enrollment(
        &self,
        websocket_url: &str,
        account_id: &str,
        app_server_client_name: Option<&str>,
    ) -> anyhow::Result<Option<RemoteControl
```

**Purpose**: Looks up a single remote-control enrollment by websocket URL, account ID, and optional app-server client name. If a row exists, it reconstructs a `RemoteControlEnrollmentRecord` with the normalized optional client name and nullable preference field.

**Data flow**: Inputs are the three key components plus `self.pool`. The function builds a `SELECT` query, binds the URL, account, and normalized client-name key, fetches at most one row, then extracts typed columns with `try_get`. It returns `Ok(None)` when no row matches, `Ok(Some(record))` when one does, or propagates SQL/decoding errors.

**Call relations**: Callers use this as the read path after inserts, deletes, migrations, or preference changes. Internally it delegates key normalization to `remote_control_app_server_client_name_key` and row decoding to inline `try_get` extraction plus `app_server_client_name_from_key`.

*Call graph*: calls 1 internal fn (remote_control_app_server_client_name_key); 1 external calls (query).


##### `StateRuntime::upsert_remote_control_enrollment`  (lines 67–103)

```
async fn upsert_remote_control_enrollment(
        &self,
        enrollment: &RemoteControlEnrollmentRecord,
    ) -> anyhow::Result<()>
```

**Purpose**: Inserts a remote-control enrollment or updates the server identity fields of an existing enrollment keyed by target/account/client. It also stamps `updated_at` with the current UTC timestamp.

**Data flow**: It takes a borrowed `RemoteControlEnrollmentRecord`, reads its fields, normalizes `app_server_client_name`, computes `Utc::now().timestamp()`, and executes an `INSERT ... ON CONFLICT DO UPDATE`. The insert writes all columns including `remote_control_enabled`; the conflict update refreshes `server_id`, `environment_id`, `server_name`, and `updated_at`. It returns `Ok(())` or propagates database errors.

**Call relations**: This is the main persistence entry for enrollment creation and refresh. Tests call it before `get_remote_control_enrollment` and `delete_remote_control_enrollment`; preference-only changes are expected to go through `set_remote_control_enabled` rather than this method's narrower conflict update.

*Call graph*: calls 1 internal fn (remote_control_app_server_client_name_key); 2 external calls (now, query).


##### `StateRuntime::set_remote_control_enabled`  (lines 105–129)

```
async fn set_remote_control_enabled(
        &self,
        websocket_url: &str,
        account_id: &str,
        app_server_client_name: Option<&str>,
        remote_control_enabled: bool,
    ) ->
```

**Purpose**: Updates only the `remote_control_enabled` flag for an existing enrollment and reports whether any row matched. It also refreshes `updated_at`.

**Data flow**: Inputs are the enrollment key tuple, the new boolean flag, and `self.pool`. The function normalizes the optional client name, binds the new flag and current timestamp into an `UPDATE`, executes it, and returns the resulting `rows_affected()` count as `u64`.

**Call relations**: This method is the targeted preference-update path for existing enrollments. It relies on the same key normalization helper as the other CRUD methods so callers can address rows consistently whether `app_server_client_name` is present or absent.

*Call graph*: calls 1 internal fn (remote_control_app_server_client_name_key); 2 external calls (now, query).


##### `StateRuntime::delete_remote_control_enrollment`  (lines 131–151)

```
async fn delete_remote_control_enrollment(
        &self,
        websocket_url: &str,
        account_id: &str,
        app_server_client_name: Option<&str>,
    ) -> anyhow::Result<u64>
```

**Purpose**: Deletes a single enrollment identified by websocket URL, account ID, and optional app-server client name. It returns how many rows were removed.

**Data flow**: It reads the three key arguments, converts the optional client name into the stored key form, executes a `DELETE` against `remote_control_enrollments`, and returns `rows_affected()` as `u64`. No other state is modified.

**Call relations**: Callers use this to remove stale or revoked enrollments. The tests verify that it deletes only the matching row and leaves other account/client combinations intact.

*Call graph*: calls 1 internal fn (remote_control_app_server_client_name_key); 1 external calls (query).


##### `tests::remote_control_enrollment_round_trips_by_target_and_account`  (lines 168–245)

```
async fn remote_control_enrollment_round_trips_by_target_and_account()
```

**Purpose**: Verifies that enrollments are keyed by websocket URL, account ID, and client name, and that inserted rows round-trip back into identical `RemoteControlEnrollmentRecord` values. It also checks that mismatched account or client lookups return `None`.

**Data flow**: The test creates a temporary runtime, inserts two enrollment records with the same websocket URL and client name but different accounts, then performs three reads: one exact match and two misses. It compares the returned values to expected records and removes the temp directory at the end.

**Call relations**: This async test is driven by the test runner. It exercises the normal write/read flow through `StateRuntime::init`, `upsert_remote_control_enrollment`, and `get_remote_control_enrollment` under distinct key combinations.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 2 external calls (assert_eq!, remove_dir_all).


##### `tests::delete_remote_control_enrollment_removes_only_matching_entry`  (lines 248–325)

```
async fn delete_remote_control_enrollment_removes_only_matching_entry()
```

**Purpose**: Confirms that deletion is scoped to the exact enrollment key and does not remove neighboring rows. The scenario specifically covers the `None` client-name case encoded through the empty-string sentinel.

**Data flow**: It initializes a runtime, inserts two enrollments sharing the same websocket URL but different accounts and no client name, deletes one by exact key, then reads both keys back. The test asserts one affected row, absence of the deleted record, presence of the retained record, and finally removes the temp directory.

**Call relations**: The test runner invokes this async test to validate the interaction between `upsert_remote_control_enrollment`, `delete_remote_control_enrollment`, and `get_remote_control_enrollment` when the optional client-name component is absent.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 2 external calls (assert_eq!, remove_dir_all).


##### `tests::migration_preserves_legacy_remote_control_preference_as_null`  (lines 328–380)

```
async fn migration_preserves_legacy_remote_control_preference_as_null()
```

**Purpose**: Checks schema migration compatibility for legacy enrollment rows created before `remote_control_enabled` existed. After upgrading the database, the old row should still load and expose `remote_control_enabled` as `None` rather than a fabricated default.

**Data flow**: The test creates a temp state DB, constructs an older migrator from the first 36 migrations, opens the SQLite file directly, applies the old schema, inserts a legacy enrollment row without the preference column, closes the pool, then initializes `StateRuntime` on the same home. It reads the migrated enrollment and asserts that `actual.remote_control_enabled` is `None`, then cleans up the temp directory.

**Call relations**: This async migration test bypasses normal runtime writes to seed an old-schema database directly, then re-enters through `StateRuntime::init` and `get_remote_control_enrollment` to validate the upgraded read path.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 8 external calls (Owned, new, connect_with, assert_eq!, state_db_path, query, create_dir_all, remove_dir_all).


### Agent graph store adapter
These files define the storage-agnostic agent graph store API and its local implementation backed by the shared state runtime.

### `agent-graph-store/src/error.rs`

`data_model` · `cross-cutting`

This file is the crate’s canonical error definition for persisted agent thread topology operations. It introduces `AgentGraphStoreResult<T>` as a direct alias for `Result<T, AgentGraphStoreError>`, ensuring every store API returns the same error shape regardless of backend. The central type is `AgentGraphStoreError`, an enum derived with `Debug` and `thiserror::Error`, so it participates cleanly in Rust error propagation while also formatting stable human-readable messages.

The enum intentionally has only two variants. `InvalidRequest { message: String }` represents caller mistakes such as malformed identifiers, impossible state transitions, or unsupported query parameters. `Internal { message: String }` is the fallback for implementation failures that do not deserve a more specific public category, such as storage corruption, lock poisoning, or backend-specific failures being normalized at the crate boundary. Both variants carry a `String` rather than nested source types, which keeps the public API storage-neutral and avoids leaking backend internals through the trait boundary. The design choice here is minimalism: callers can distinguish bad input from store failure, while implementations retain freedom to map richer internal errors into concise external messages.


### `agent-graph-store/src/store.rs`

`domain_logic` · `request handling`

This file contains the core abstraction of the crate: the `AgentGraphStore` trait. The trait is `Send + Sync`, making implementations safe to share across concurrent async execution contexts. Every method is asynchronous and returns an `AgentGraphStoreResult`, so callers interact with a uniform future-based API regardless of whether the backend is in-memory, file-backed, or remote.

The domain model is a directed edge from `parent_thread_id: ThreadId` to `child_thread_id: ThreadId`, annotated with a `ThreadSpawnEdgeStatus`. `upsert_thread_spawn_edge` establishes or replaces the single persisted incoming parent edge for a child; the comments make the one-parent invariant explicit and require re-insertion to overwrite both parent and status. `set_thread_spawn_edge_status` updates only the status and must treat unknown children as a successful no-op, which simplifies callers that race with deletion or partial persistence. The two list methods define important ordering and traversal semantics. `list_thread_spawn_children` returns direct children, optionally filtered by exact status. `list_thread_spawn_descendants` performs breadth-first traversal ordered first by depth and then by thread id, and its `status_filter` constrains traversal itself, not just final output. That subtle rule means a closed edge prunes the entire subtree when filtering for open edges. The file therefore serves as both interface and behavioral contract for deterministic graph queries.


### `agent-graph-store/src/local.rs`

`io_transport` · `request handling / persistence access`

This file is the bridge between the crate-level `AgentGraphStore` trait and the lower-level `StateRuntime` persistence API. The central type, `LocalAgentGraphStore`, is a thin cloneable wrapper around `Arc<StateRuntime>`, so multiple callers can share the same initialized state database handle without owning separate connections or setup logic. Its `Debug` implementation intentionally exposes only the runtime’s `codex_home` path and marks the struct non-exhaustive rather than dumping internal database state.

The trait implementation is almost entirely adapter code: each public async method converts the crate’s `ThreadSpawnEdgeStatus` enum into `codex_state::DirectionalThreadSpawnEdgeStatus` via `to_state_status`, invokes the corresponding `StateRuntime` async method, and maps any backend error into `AgentGraphStoreError::Internal` using `internal_error`. The two list methods preserve an important branch: when a status filter is present they call the status-specific runtime query, otherwise they call the unfiltered query. There is no in-memory caching, deduplication, or traversal logic here; ordering and breadth-first descendant semantics come from `StateRuntime` and are asserted in tests.

The tests build a temporary runtime with `TempDir`, synthesize deterministic `ThreadId` values from formatted UUID strings, and verify direct-child listing, status mutation, and descendant traversal. They also confirm that filtered results match the underlying state runtime’s own filtered queries, making this file’s main invariant explicit: it must be a faithful status-converting façade over `StateRuntime`.

#### Function details

##### `LocalAgentGraphStore::fmt`  (lines 17–21)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats the store for debugging without exposing the full runtime internals. It reports the `codex_home` backing path and leaves the struct marked non-exhaustive.

**Data flow**: Reads `self.state_db.codex_home()` from the wrapped `StateRuntime` and writes that value into a `DebugStruct` builder attached to the provided formatter. Returns the formatter’s `std::fmt::Result`.

**Call relations**: This is invoked implicitly by Rust formatting/debugging paths rather than by the store logic itself. Its only delegation is to the formatter’s `debug_struct` machinery so logs can identify which local state directory backs the store.

*Call graph*: 1 external calls (debug_struct).


##### `LocalAgentGraphStore::new`  (lines 26–28)

```
fn new(state_db: Arc<StateRuntime>) -> Self
```

**Purpose**: Constructs a `LocalAgentGraphStore` from an already initialized shared `StateRuntime`. It performs no setup beyond storing the `Arc`.

**Data flow**: Consumes an `Arc<StateRuntime>` argument and places it into the `state_db` field of a new `LocalAgentGraphStore`, returning that wrapper by value.

**Call relations**: Used by the file’s tests after creating a temporary runtime fixture. It is the entry point that wires this adapter around an existing runtime before trait methods are exercised.

*Call graph*: called by 3 (local_store_lists_descendants_breadth_first_with_status_filters, local_store_updates_edge_status, local_store_upserts_and_lists_direct_children_with_status_filters).


##### `LocalAgentGraphStore::upsert_thread_spawn_edge`  (lines 32–42)

```
async fn upsert_thread_spawn_edge(
        &self,
        parent_thread_id: ThreadId,
        child_thread_id: ThreadId,
        status: ThreadSpawnEdgeStatus,
    ) -> AgentGraphStoreResult<()>
```

**Purpose**: Creates or updates a directional parent→child thread-spawn edge in the state database with the requested open/closed lifecycle status.

**Data flow**: Takes `parent_thread_id`, `child_thread_id`, and crate-level `ThreadSpawnEdgeStatus`; converts the status with `to_state_status`; awaits `state_db.upsert_thread_spawn_edge(...)`; maps any backend error into `AgentGraphStoreError::Internal`; returns `AgentGraphStoreResult<()>`.

**Call relations**: As part of the `AgentGraphStore` trait implementation, this is called by higher-level graph users whenever a spawn relationship must be recorded. It delegates all persistence to `StateRuntime`, with this file only responsible for enum translation and error normalization.

*Call graph*: calls 1 internal fn (to_state_status).


##### `LocalAgentGraphStore::set_thread_spawn_edge_status`  (lines 44–53)

```
async fn set_thread_spawn_edge_status(
        &self,
        child_thread_id: ThreadId,
        status: ThreadSpawnEdgeStatus,
    ) -> AgentGraphStoreResult<()>
```

**Purpose**: Updates the lifecycle status of an existing spawn edge identified by child thread id, such as closing an open child edge.

**Data flow**: Accepts `child_thread_id` and crate-level `ThreadSpawnEdgeStatus`, translates the status via `to_state_status`, calls `state_db.set_thread_spawn_edge_status(...)`, converts any error through `internal_error`, and returns `AgentGraphStoreResult<()>`.

**Call relations**: Called when callers need to mutate edge state without re-specifying the parent. It follows the same adapter pattern as `upsert_thread_spawn_edge`, delegating the actual update to `StateRuntime`.

*Call graph*: calls 1 internal fn (to_state_status).


##### `LocalAgentGraphStore::list_thread_spawn_children`  (lines 55–72)

```
async fn list_thread_spawn_children(
        &self,
        parent_thread_id: ThreadId,
        status_filter: Option<ThreadSpawnEdgeStatus>,
    ) -> AgentGraphStoreResult<Vec<ThreadId>>
```

**Purpose**: Fetches direct child thread ids for a parent, optionally restricting results to only open or only closed edges.

**Data flow**: Receives `parent_thread_id` and `Option<ThreadSpawnEdgeStatus>`. If the option is `Some`, it converts the status and awaits `state_db.list_thread_spawn_children_with_status(...)`; otherwise it awaits `state_db.list_thread_spawn_children(...)`. In both branches it maps backend errors to `AgentGraphStoreError::Internal` and returns `Vec<ThreadId>`.

**Call relations**: This method is invoked by graph consumers that need one-hop child relationships. Its key control-flow branch is driven by whether a status filter is present, selecting the filtered or unfiltered runtime query accordingly.

*Call graph*: calls 1 internal fn (to_state_status).


##### `LocalAgentGraphStore::list_thread_spawn_descendants`  (lines 74–91)

```
async fn list_thread_spawn_descendants(
        &self,
        root_thread_id: ThreadId,
        status_filter: Option<ThreadSpawnEdgeStatus>,
    ) -> AgentGraphStoreResult<Vec<ThreadId>>
```

**Purpose**: Fetches all descendant thread ids under a root thread, optionally filtered by edge status.

**Data flow**: Takes `root_thread_id` and `Option<ThreadSpawnEdgeStatus>`. A `match` chooses between `state_db.list_thread_spawn_descendants_with_status(...)` after status conversion or `state_db.list_thread_spawn_descendants(...)` with no filter. Errors are converted to `AgentGraphStoreError::Internal`; the return value is `Vec<ThreadId>`.

**Call relations**: Used when callers need transitive graph traversal rather than direct children. Like the child-listing method, it is a pure adapter whose branching mirrors the presence or absence of a status filter while leaving traversal ordering to `StateRuntime`.

*Call graph*: calls 1 internal fn (to_state_status).


##### `to_state_status`  (lines 94–99)

```
fn to_state_status(status: ThreadSpawnEdgeStatus) -> codex_state::DirectionalThreadSpawnEdgeStatus
```

**Purpose**: Maps the crate’s public thread-spawn edge status enum to the equivalent `codex_state` directional status enum.

**Data flow**: Consumes a `ThreadSpawnEdgeStatus` value and returns the corresponding `codex_state::DirectionalThreadSpawnEdgeStatus` variant through a two-arm `match`.

**Call relations**: This helper is the shared conversion point used by all trait methods that pass status into `StateRuntime`. It centralizes the enum mapping so the adapter methods stay consistent.

*Call graph*: called by 4 (list_thread_spawn_children, list_thread_spawn_descendants, set_thread_spawn_edge_status, upsert_thread_spawn_edge).


##### `internal_error`  (lines 101–105)

```
fn internal_error(err: impl std::fmt::Display) -> AgentGraphStoreError
```

**Purpose**: Wraps any displayable backend error as the store’s generic internal error variant with a string message.

**Data flow**: Accepts any `err` implementing `Display`, converts it to a `String` with `to_string`, and returns `AgentGraphStoreError::Internal { message }`.

**Call relations**: Used as the common `map_err` target after runtime calls fail. It collapses backend-specific error types into the trait’s crate-level error surface.

*Call graph*: 1 external calls (to_string).


##### `tests::thread_id`  (lines 119–122)

```
fn thread_id(suffix: u128) -> ThreadId
```

**Purpose**: Builds deterministic `ThreadId` values for tests from a numeric suffix embedded into a UUID-shaped string.

**Data flow**: Takes a `u128` suffix, formats it into `00000000-0000-0000-0000-{suffix:012}`, parses that string with `ThreadId::from_string`, and returns the resulting `ThreadId`, panicking if parsing fails.

**Call relations**: Called by all three async tests to create stable parent/child ids without hardcoding many full UUID literals. It isolates test-id generation from the assertions.

*Call graph*: calls 1 internal fn (from_string); 1 external calls (format!).


##### `tests::state_runtime`  (lines 124–134)

```
async fn state_runtime() -> TestRuntime
```

**Purpose**: Creates a temporary initialized `StateRuntime` fixture backed by a fresh temp directory for integration tests.

**Data flow**: Allocates a `TempDir`, passes its path and a fixed provider string into `StateRuntime::init(...).await`, stores the resulting `Arc<StateRuntime>` plus the tempdir handle in `TestRuntime`, and returns that fixture.

**Call relations**: This helper is the shared setup path for all tests in the module. By retaining the `TempDir` inside `TestRuntime`, it keeps the backing directory alive for the duration of each test.

*Call graph*: calls 1 internal fn (init); 1 external calls (new).


##### `tests::local_store_upserts_and_lists_direct_children_with_status_filters`  (lines 137–190)

```
async fn local_store_upserts_and_lists_direct_children_with_status_filters()
```

**Purpose**: Verifies that inserted child edges are listed in expected order and that open/closed filtering matches both explicit expectations and the underlying state runtime.

**Data flow**: Builds a temporary runtime and store, creates one parent and two children, inserts one closed and one open edge, then queries all children, open children, and closed children. It compares returned vectors against expected `ThreadId` sequences and against `StateRuntime`’s filtered query result.

**Call relations**: This test drives `LocalAgentGraphStore::new`, `upsert_thread_spawn_edge`, and `list_thread_spawn_children` through the normal adapter path. It specifically exercises the branch where `status_filter` is `None` and the branch where it is `Some(...)`.

*Call graph*: calls 1 internal fn (new); 3 external calls (state_runtime, thread_id, assert_eq!).


##### `tests::local_store_updates_edge_status`  (lines 193–224)

```
async fn local_store_updates_edge_status()
```

**Purpose**: Checks that changing an edge from open to closed moves the child between filtered result sets.

**Data flow**: Creates a runtime and store, inserts an open edge, updates that child edge to closed, then queries open and closed child lists for the parent. It asserts that the open list becomes empty and the closed list contains the child id.

**Call relations**: This test covers the mutation path through `set_thread_spawn_edge_status` after an initial `upsert_thread_spawn_edge`. It validates that later filtered reads observe the updated persisted status.

*Call graph*: calls 1 internal fn (new); 3 external calls (state_runtime, thread_id, assert_eq!).


##### `tests::local_store_lists_descendants_breadth_first_with_status_filters`  (lines 227–322)

```
async fn local_store_lists_descendants_breadth_first_with_status_filters()
```

**Purpose**: Builds a multi-level spawn tree and verifies descendant traversal order plus status-filtered descendant selection.

**Data flow**: Creates several thread ids, inserts a mix of open and closed edges across child, grandchild, and great-grandchild levels, then queries all descendants, open descendants, and closed descendants from the root. It asserts breadth-first ordering for the unfiltered result and exact filtered subsets for open and closed queries, also cross-checking open descendants against the underlying state runtime.

**Call relations**: This is the broadest integration test in the file, exercising repeated `upsert_thread_spawn_edge` calls followed by `list_thread_spawn_descendants` with and without filters. It demonstrates that traversal semantics are inherited correctly from `StateRuntime` through this adapter.

*Call graph*: calls 1 internal fn (new); 3 external calls (state_runtime, thread_id, assert_eq!).


### `agent-graph-store/src/lib.rs`

`orchestration` · `startup`

This file is the top-level API surface for the `agent-graph-store` crate. Its module declarations split the crate into four concerns: `error` for shared failure types, `local` for the in-process implementation, `store` for the storage-neutral trait boundary, and `types` for domain enums such as edge lifecycle state. The crate-level documentation string summarizes the domain: persisted parent/child topology for agents spawned from threads.

The file’s main job is selective re-export. External users do not need to know the internal module layout; instead they import `AgentGraphStoreError`, `AgentGraphStoreResult`, `LocalAgentGraphStore`, `AgentGraphStore`, and `ThreadSpawnEdgeStatus` directly from the crate root. That makes the crate read like a compact interface: one trait to program against, one concrete implementation for local use, one enum describing edge state, and one shared error/result pair. There is no executable logic here, but the design matters because it establishes the crate’s stable public boundary and hides implementation details behind a small set of names. In practice this file is active whenever another crate depends on the graph store API, whether for trait-based integration, testing with the local backend, or matching on standardized errors.
