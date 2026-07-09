# SQLite runtime state and agent graph storage  `stage-21.2`

This stage is the system’s durable notebook. It is shared behind-the-scenes support used while the app runs, and also during startup or recovery, so important runtime facts survive a restart. Most data is kept in SQLite, a small local database stored as files.

The state crate is the main entry point. It defines safe data shapes for thread summaries, thread goals, agent jobs, backfill progress, and logs, then pairs them with runtime code that reads and writes those records. The thread runtime catalogs conversation threads, including parent and child links. The goal runtime records what a thread is trying to do and its budget. The memories runtime schedules memory extraction work. Agent job storage tracks queued, running, finished, and failed work items. Backfill storage remembers catch-up progress and prevents two workers from doing the same job.

Other pieces store imported external-agent configuration, remote-control server enrollments, and read-only audit views for diagnostics. The agent graph store adds a common interface for “which agent spawned which thread,” with a local SQLite implementation that reuses the same state database.

## Files in this stage

### State crate surface
These files define the public entry points for the SQLite-backed state subsystem and its read-only audit access.

### `state/src/audit.rs`

`io_transport` · `diagnostics/audit`

This file exists for situations where someone needs to inspect the project’s saved state, not modify it. The state is stored in a SQLite database, which is a small database kept in a local file. For diagnostics and audits, it is important to open that file carefully: if the database is missing or broken, this code should report that fact rather than silently creating a new one or trying to fix it.

The main data shape here is `ThreadStateAuditRow`. It is a small summary of one saved thread: its ID, where its rollout data lives on disk, whether it is archived, where it came from, and which model provider was used. Think of it like a read-only index card pulled from a filing cabinet.

The file’s single query function opens the database in read-only mode, asks for a few columns from the `threads` table, turns each database row into a Rust struct, and then closes the database connection. One important detail is that the database stores `archived` as a number, so the code converts zero into `false` and any non-zero value into `true`. If anything goes wrong, such as the file not existing or the table not matching expectations, the error is returned to the caller instead of being hidden.

#### Function details

##### `read_thread_state_audit_rows`  (lines 23–55)

```
async fn read_thread_state_audit_rows(path: &Path) -> Result<Vec<ThreadStateAuditRow>>
```

**Purpose**: Reads the saved thread summaries from an existing SQLite state database without changing the database. A diagnostic or audit command would use this when it wants to see what thread records are present while leaving the state file untouched.

**Data flow**: It takes a path to a database file. It opens that file read-only, refuses to create it if it is missing, runs a query against the `threads` table, and reads the selected fields from every row. Each row is converted into a `ThreadStateAuditRow`, including turning the numeric `archived` value into a true-or-false value. The result is a list of these audit rows, or an error if the database cannot be opened, queried, or decoded.

**Call relations**: When an audit path needs thread metadata, it calls this function with the state database path. Inside, the function relies on SQLite connection setup helpers and SQL query creation from external libraries, then hands the finished list of plain Rust records back to the caller for reporting or further checks.

*Call graph*: 3 external calls (new, new, query).


### `state/src/lib.rs`

`orchestration` · `cross-cutting`

This file is like the reception desk for the state subsystem. The real work is split across smaller modules, such as database runtime code, metadata extraction, migrations, audit reads, and telemetry. This file decides which of those pieces are visible to other crates and gives callers a simpler set of names to import.

The subsystem exists because rollout information starts out in JSONL files, meaning files where each line is a separate JSON record. Searching and updating that directly would be slow and awkward. The state crate mirrors the important metadata into SQLite, a small local database engine, so the rest of the system can query threads, jobs, goals, logs, memories, backfill status, and audit information in a structured way.

One important safety check happens here: the crate refuses to build unless the bundled SQLite version is new enough to include a specific fix for a WAL-reset corruption bug. WAL, or write-ahead logging, is SQLite’s way of safely recording changes before committing them. Without this guard, the project could ship with a database engine version known to risk data corruption.

The file also defines shared database filenames, metric names, and the environment variable used to override where SQLite state lives. Most callers are expected to use StateRuntime, the higher-level entry point that owns configuration and metrics, rather than reaching into the lower-level storage pieces directly.


### Thread graph foundation
These files establish the core thread metadata model and the runtime layer that persists threads and spawn-edge relationships.

### `state/src/model/thread_metadata.rs`

`data_model` · `state loading, thread indexing, listing, and reconciliation`

A thread in this system has a full rollout file on disk, but lists and searches need a compact summary: when it started, where it ran, which model it used, its title, token count, Git context, archive state, and similar facts. This file is the shared shape for that summary. Without it, different parts of the state layer could disagree about what a thread “is,” or old database rows could be read incorrectly.

The main type is `ThreadMetadata`, the clean in-memory record used by the rest of the program. `ThreadMetadataBuilder` is a safer way to create one when some facts are missing; it fills in sensible defaults such as read-only sandboxing, on-request approval, an empty title, and a default model provider. Think of it like a form that can be partly filled out, then turned into the official record.

The file also includes `ThreadRow`, a database-facing version where paths and dates are stored in plain SQLite-friendly forms. Conversion functions turn those raw database values back into richer Rust values, including careful timestamp handling so older rows stored in seconds still sort correctly after newer millisecond-precision writes. Pagination helpers create anchors for thread lists, and comparison helpers preserve important existing user edits, such as explicit titles and Git information, when metadata is rebuilt from rollout files.

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

**Purpose**: Creates a new draft thread metadata record from the few facts that must always be known: the thread id, rollout file path, creation time, and source. It also fills in safe defaults for fields that may not be known yet.

**Data flow**: It receives the required thread identity and origin details. It puts those into a `ThreadMetadataBuilder`, sets optional fields to empty, chooses a read-only sandbox policy, and sets approval to on-request. The result is a builder object that later code can add more details to before producing final metadata.

**Call relations**: Many tests and seeding helpers call this when they need realistic thread metadata without spelling out every field. After callers have added any extra information, the builder is normally finished by `ThreadMetadataBuilder::build`.

*Call graph*: called by 35 (test_thread_metadata, seed_stage1_output, thread_list_parent_filter_reads_direct_children_from_state_db, seed_recent_thread, upsert_thread_metadata, seed_thread_metadata, seed_stage1_candidate, seed_stage1_output, builder_from_items, builder_from_session_meta (+15 more)); 2 external calls (new, new_read_only_policy).


##### `ThreadMetadataBuilder::build`  (lines 184–225)

```
fn build(&self, default_provider: &str) -> ThreadMetadata
```

**Purpose**: Turns a draft `ThreadMetadataBuilder` into the final `ThreadMetadata` record used by the state system. It fills missing values with defaults and converts enum-like settings into stored strings.

**Data flow**: It reads all fields from the builder plus a default model provider string. It normalizes timestamps, turns source, sandbox policy, and approval mode into strings, uses the default provider if none was set, copies optional agent and Git information, and initializes fields such as title, preview, model, and token count. The output is a complete `ThreadMetadata` value.

**Call relations**: This is the finishing step after `ThreadMetadataBuilder::new` and any field edits. Internally it calls `canonicalize_datetime` so stored timestamps use the same precision, and it uses `enum_to_string` to make protocol values database-friendly.

*Call graph*: calls 2 internal fn (enum_to_string, canonicalize_datetime); 2 external calls (clone, new).


##### `ThreadMetadata::prefer_existing_git_info`  (lines 230–240)

```
fn prefer_existing_git_info(&mut self, existing: &Self)
```

**Purpose**: Keeps known Git information from an older metadata record when rebuilding metadata from another source. This prevents useful repository details from being erased just because a fresh extraction did not find them.

**Data flow**: It receives the current mutable metadata record and an existing record. For each Git field, if the existing record has a value, that value is copied into the current record. The function changes `self` in place and returns nothing.

**Call relations**: This fits the reconciliation flow, where rollout-derived metadata may be compared with data already stored in the state database. It does not hand off to other functions; it simply protects non-empty Git fields during that merge.


##### `ThreadMetadata::prefer_existing_explicit_title`  (lines 243–255)

```
fn prefer_existing_explicit_title(&mut self, existing: &Self)
```

**Purpose**: Preserves a user-facing title that appears to have been explicitly set before. It avoids replacing a real title with an automatic fallback such as the first user message.

**Data flow**: It looks at the existing title and checks whether it is blank or just the same as the first user message. If the existing title looks meaningful, and the new title is blank or only a fallback, it copies the existing title into the current metadata. The current record may be updated; no separate result is returned.

**Call relations**: This is another reconciliation helper used when refreshed rollout metadata is merged with stored metadata. It works alongside preservation helpers like `prefer_existing_git_info`, but its concern is the human-readable title.


##### `ThreadMetadata::diff_fields`  (lines 258–330)

```
fn diff_fields(&self, other: &Self) -> Vec<&'static str>
```

**Purpose**: Reports exactly which metadata fields differ between two thread records. This is useful for deciding whether a database row needs updating or for explaining what changed.

**Data flow**: It receives two `ThreadMetadata` records: `self` and `other`. It compares each field one by one and collects the names of fields whose values are different. It returns a list of field-name strings.

**Call relations**: This function is used as a comparison tool in broader update or reconciliation logic. It does not modify either record and does not call domain-specific helpers beyond creating the result list.

*Call graph*: 1 external calls (new).


##### `canonicalize_datetime`  (lines 333–335)

```
fn canonicalize_datetime(dt: DateTime<Utc>) -> DateTime<Utc>
```

**Purpose**: Normalizes a UTC timestamp to the same precision used for storage. This avoids tiny precision differences making two otherwise identical metadata records look different.

**Data flow**: It receives a `DateTime<Utc>`. It converts that time to Unix epoch milliseconds, then converts those milliseconds back to a `DateTime<Utc>`. If the conversion fails, it keeps the original value. The result is a timestamp rounded to the storage precision.

**Call relations**: `ThreadMetadataBuilder::build` calls this for creation, update, and archive times. It delegates the actual conversion work to `datetime_to_epoch_millis` and `epoch_millis_to_datetime`.

*Call graph*: calls 2 internal fn (datetime_to_epoch_millis, epoch_millis_to_datetime); called by 1 (build).


##### `ThreadRow::try_from_row`  (lines 366–393)

```
fn try_from_row(row: &SqliteRow) -> Result<Self>
```

**Purpose**: Reads one SQLite database row into a `ThreadRow`, the raw database-shaped version of thread metadata. It is the first step in turning stored database data back into application data.

**Data flow**: It receives a SQLite row. It asks the row for each expected column by name, such as `id`, `rollout_path`, timestamps, model fields, title, archive status, and Git fields. If all reads succeed, it returns a populated `ThreadRow`; if any column is missing or has the wrong type, it returns an error.

**Call relations**: Database query code calls this after SQLite returns rows. The resulting `ThreadRow` is then meant to be converted into `ThreadMetadata` through `ThreadMetadata::try_from`.

*Call graph*: 1 external calls (try_get).


##### `ThreadMetadata::try_from`  (lines 399–457)

```
fn try_from(row: ThreadRow) -> std::result::Result<Self, Self::Error>
```

**Purpose**: Converts a raw `ThreadRow` from the database into the richer `ThreadMetadata` used by the program. It validates and parses stored strings, paths, timestamps, and optional fields.

**Data flow**: It receives a `ThreadRow` whose values are mostly strings and integers. It parses the thread id, turns path strings into paths, converts epoch timestamps into UTC times, parses optional thread source and reasoning effort values, and treats empty preview or first-message strings as missing values. It returns either a complete `ThreadMetadata` or an error if required values are invalid.

**Call relations**: This follows `ThreadRow::try_from_row` in the database loading path. The tests `tests::thread_row_parses_reasoning_effort` and `tests::thread_row_preserves_model_defined_reasoning_effort_values` call it directly to confirm reasoning-effort parsing works.

*Call graph*: calls 2 internal fn (try_from, epoch_millis_to_datetime); called by 2 (thread_row_parses_reasoning_effort, thread_row_preserves_model_defined_reasoning_effort_values); 1 external calls (from).


##### `anchor_from_item`  (lines 460–466)

```
fn anchor_from_item(item: &ThreadMetadata, sort_key: SortKey) -> Option<Anchor>
```

**Purpose**: Creates a pagination anchor from one thread item. A pagination anchor is a bookmark that says where the next page of results should continue.

**Data flow**: It receives a `ThreadMetadata` item and a sort key. If the list is sorted by creation time, it uses the item’s creation timestamp; if sorted by update time, it uses the update timestamp. It returns an `Anchor` containing that timestamp.

**Call relations**: Thread listing code can use this after selecting the last item in a page. The returned anchor is then passed into later list queries so they continue from the right point.


##### `datetime_to_epoch_millis`  (lines 468–470)

```
fn datetime_to_epoch_millis(dt: DateTime<Utc>) -> i64
```

**Purpose**: Converts a UTC timestamp into Unix epoch milliseconds, which means the number of milliseconds since January 1, 1970. This is the millisecond format used for newer stored thread times.

**Data flow**: It receives a `DateTime<Utc>` and asks it for its millisecond timestamp. It returns that integer without changing anything else.

**Call relations**: `canonicalize_datetime` calls this before converting the value back, ensuring times are aligned with database precision.

*Call graph*: called by 1 (canonicalize_datetime); 1 external calls (timestamp_millis).


##### `datetime_to_epoch_seconds`  (lines 472–474)

```
fn datetime_to_epoch_seconds(dt: DateTime<Utc>) -> i64
```

**Purpose**: Converts a UTC timestamp into Unix epoch seconds, the older or simpler whole-second storage format. This is useful for fields that are stored only to second precision.

**Data flow**: It receives a `DateTime<Utc>`, extracts the number of seconds since January 1, 1970, and returns that integer. It does not change any stored state.

**Call relations**: No specific caller is listed in the provided call facts, but it pairs with `epoch_seconds_to_datetime` for code that needs second-precision database values.

*Call graph*: 1 external calls (timestamp).


##### `epoch_millis_to_datetime`  (lines 476–487)

```
fn epoch_millis_to_datetime(value: i64) -> Result<DateTime<Utc>>
```

**Purpose**: Turns a stored integer timestamp into a UTC date and time, while also supporting old rows that accidentally or historically stored seconds instead of milliseconds.

**Data flow**: It receives an integer timestamp. If the value is too small to be a plausible millisecond timestamp for modern thread data, it treats it as seconds and multiplies by 1000. It then converts the millisecond value into a `DateTime<Utc>`, returning an error if the number cannot represent a valid time.

**Call relations**: `ThreadMetadata::try_from` calls this when loading created and updated timestamps from the database. `canonicalize_datetime` also calls it when normalizing newly built metadata.

*Call graph*: called by 2 (try_from, canonicalize_datetime); 1 external calls (from_timestamp_millis).


##### `epoch_seconds_to_datetime`  (lines 489–492)

```
fn epoch_seconds_to_datetime(value: i64) -> Result<DateTime<Utc>>
```

**Purpose**: Turns a whole-second Unix timestamp into a UTC date and time. It is used for values that are intentionally stored at second precision.

**Data flow**: It receives an integer count of seconds since January 1, 1970. It converts that into a `DateTime<Utc>` with zero extra nanoseconds. If the value cannot be represented as a valid timestamp, it returns an error.

**Call relations**: `ThreadMetadata::try_from` uses this for the optional archive timestamp, because that database field is read as seconds rather than milliseconds.

*Call graph*: 1 external calls (from_timestamp).


##### `tests::thread_row`  (lines 516–543)

```
fn thread_row(reasoning_effort: Option<&str>) -> ThreadRow
```

**Purpose**: Builds a sample raw database row for tests. It lets each test choose the stored reasoning-effort text while keeping all other fields consistent.

**Data flow**: It receives an optional reasoning-effort string. It creates a `ThreadRow` with fixed id, paths, timestamps, model, policy, token count, and empty optional display fields, inserting the provided reasoning-effort value if present. The output is test input for conversion into `ThreadMetadata`.

**Call relations**: The reasoning-effort tests call this helper before calling `ThreadMetadata::try_from`. It keeps those tests focused on the one field they are checking.

*Call graph*: 1 external calls (new).


##### `tests::expected_thread_metadata`  (lines 545–573)

```
fn expected_thread_metadata(reasoning_effort: Option<ReasoningEffort>) -> ThreadMetadata
```

**Purpose**: Builds the expected `ThreadMetadata` value for the test row. It gives the tests a clear target to compare against after conversion.

**Data flow**: It receives an optional parsed `ReasoningEffort`. It constructs the full expected metadata record using the same fixed id, paths, timestamps, model, policy, and token count as `tests::thread_row`, with empty database strings represented as missing optional values. The output is the expected result for assertions.

**Call relations**: The two reasoning-effort tests use this helper to compare against the actual result from `ThreadMetadata::try_from`. It uses thread id and timestamp parsing helpers from external libraries to create realistic values.

*Call graph*: calls 1 internal fn (from_string); 3 external calls (from_timestamp, from, new).


##### `tests::thread_row_parses_reasoning_effort`  (lines 576–584)

```
fn thread_row_parses_reasoning_effort()
```

**Purpose**: Checks that a normal stored reasoning-effort value, such as `high`, is parsed into the expected program value.

**Data flow**: It creates a test `ThreadRow` containing the text `high`, converts it with `ThreadMetadata::try_from`, and compares the result with metadata whose reasoning effort is `High`. The test passes if the converted metadata exactly matches the expected value.

**Call relations**: This test exercises the conversion path provided by `ThreadMetadata::try_from`, using `tests::thread_row` for input and `tests::expected_thread_metadata` as the comparison target.

*Call graph*: calls 1 internal fn (try_from); 2 external calls (assert_eq!, thread_row).


##### `tests::thread_row_preserves_model_defined_reasoning_effort_values`  (lines 587–595)

```
fn thread_row_preserves_model_defined_reasoning_effort_values()
```

**Purpose**: Checks that an unfamiliar reasoning-effort value is not thrown away. This matters because future models may define new effort names before this code knows about them.

**Data flow**: It creates a test `ThreadRow` containing the text `future`, converts it into `ThreadMetadata`, and expects the reasoning effort to become a custom value holding that same text. The test passes if the conversion preserves the unknown value.

**Call relations**: Like the previous test, it calls `ThreadMetadata::try_from` through a controlled test row. Together, the tests show that known values are parsed normally and unknown values are still kept.

*Call graph*: calls 1 internal fn (try_from); 2 external calls (assert_eq!, thread_row).


### `state/src/runtime/threads.rs`

`domain_logic` · `cross-cutting thread state reads and writes`

A “thread” here is a saved conversation or agent run, with details like its title, preview text, working folder, model, token count, Git information, archive state, and the rollout file it came from. This file keeps those details in the database so the app can show thread lists quickly without rereading every rollout file from disk.

It also records when one thread spawns another. Think of this like a family tree: a parent thread can have child threads, and children can have their own descendants. The code can list children, walk the full subtree, filter by whether the link is open or closed, and find an agent by its canonical path.

The listing code builds SQL queries from filters such as archived/not archived, source, model provider, current working directory, search text, sort order, and pagination anchor. Pagination uses timestamps as cursors, so this file carefully allocates millisecond-level updated times to keep ordering stable when several updates happen at once.

The update paths are deliberately conservative. They preserve useful existing data, such as Git fields and non-empty previews, when older rollout data is replayed. Deletion also cleans related logs, memories, goals, dynamic tools, spawn edges, and job assignments, while deleting the core thread rows last so failed cleanup can be retried safely.

#### Function details

##### `StateRuntime::get_thread`  (lines 7–44)

```
async fn get_thread(&self, id: ThreadId) -> anyhow::Result<Option<crate::ThreadMetadata>>
```

**Purpose**: Loads one thread’s saved metadata by its thread id. Callers use it when they need the current database view of a conversation before changing or displaying it.

**Data flow**: It receives a thread id, reads the matching row from the threads table, converts the database fields into a ThreadMetadata value, and returns either that metadata or nothing if the id is unknown.

**Call relations**: Archive, unarchive, and rollout-apply flows call this first so they can start from the latest stored thread state before writing an updated version back.

*Call graph*: called by 3 (apply_rollout_items, mark_archived, mark_unarchived); 2 external calls (to_string, query).


##### `StateRuntime::get_thread_memory_mode`  (lines 46–52)

```
async fn get_thread_memory_mode(&self, id: ThreadId) -> anyhow::Result<Option<String>>
```

**Purpose**: Reads the saved memory mode for a thread. This is used when code only needs that one setting instead of the whole thread record.

**Data flow**: It takes a thread id, queries the memory_mode column, and returns the string if the row exists and the value can be read.

**Call relations**: It is a small direct lookup used by callers and tests that verify whether rollout metadata restored or preserved the memory setting.

*Call graph*: 2 external calls (to_string, query).


##### `StateRuntime::set_thread_preview_if_empty`  (lines 54–75)

```
async fn set_thread_preview_if_empty(
        &self,
        thread_id: ThreadId,
        preview: &str,
    ) -> anyhow::Result<bool>
```

**Purpose**: Fills in a thread preview only if the thread currently has no preview. This protects a meaningful existing preview from being overwritten by later fallback text.

**Data flow**: It receives a thread id and preview text, trims surrounding whitespace, ignores empty text, and updates the database only when the stored preview is blank. It returns whether anything changed.

**Call relations**: This is a targeted repair/update helper for places that discover a better preview later, while the main upsert path also has its own preview-preservation rule.

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

**Purpose**: Creates or replaces the saved parent-to-child link for a spawned thread. It records which thread spawned which child and the current lifecycle status of that link.

**Data flow**: It takes parent id, child id, and status, writes them into thread_spawn_edges, and if that child already has an edge, replaces the parent and status.

**Call relations**: Thread-spawn features and tests use this to build the stored spawn graph that later listing, descendant search, and deletion cleanup rely on.

*Call graph*: 3 external calls (to_string, query, as_ref).


##### `StateRuntime::set_thread_spawn_edge_status`  (lines 105–116)

```
async fn set_thread_spawn_edge_status(
        &self,
        child_thread_id: ThreadId,
        status: crate::DirectionalThreadSpawnEdgeStatus,
    ) -> anyhow::Result<()>
```

**Purpose**: Changes the status of an existing spawn link for a child thread. This lets the system mark a spawned relationship as open, closed, or another supported state.

**Data flow**: It receives a child thread id and a status, updates the matching row in thread_spawn_edges, and reports success or database errors through the result.

**Call relations**: After an edge is created by upsert_thread_spawn_edge or automatic source parsing, this function updates its lifecycle so status-filtered child and descendant lists stay accurate.

*Call graph*: 3 external calls (to_string, query, as_ref).


##### `StateRuntime::list_thread_spawn_children_with_status`  (lines 119–126)

```
async fn list_thread_spawn_children_with_status(
        &self,
        parent_thread_id: ThreadId,
        status: crate::DirectionalThreadSpawnEdgeStatus,
    ) -> anyhow::Result<Vec<ThreadId>>
```

**Purpose**: Lists the direct children of a parent thread whose spawn link has a specific status. Use this when only open or only closed child links matter.

**Data flow**: It receives a parent id and status, passes both into the shared child-listing helper, and returns matching child thread ids.

**Call relations**: It is the public, status-filtered wrapper around list_thread_spawn_children_matching.

*Call graph*: calls 1 internal fn (list_thread_spawn_children_matching).


##### `StateRuntime::list_thread_spawn_children`  (lines 129–135)

```
async fn list_thread_spawn_children(
        &self,
        parent_thread_id: ThreadId,
    ) -> anyhow::Result<Vec<ThreadId>>
```

**Purpose**: Lists all direct children of a parent thread, regardless of link status. This answers the simple question, “Which threads did this one spawn?”

**Data flow**: It receives a parent id, calls the shared child-listing helper without a status filter, and returns the child ids sorted by id.

**Call relations**: It shares the same database path as the status-filtered version but intentionally includes every stored edge.

*Call graph*: calls 1 internal fn (list_thread_spawn_children_matching).


##### `StateRuntime::list_thread_spawn_descendants_with_status`  (lines 140–147)

```
async fn list_thread_spawn_descendants_with_status(
        &self,
        root_thread_id: ThreadId,
        status: crate::DirectionalThreadSpawnEdgeStatus,
    ) -> anyhow::Result<Vec<ThreadId>>
```

**Purpose**: Lists all descendants below a root thread, but only through links with a chosen status. This is useful for walking an active or closed part of the spawn tree.

**Data flow**: It takes a root id and status, asks the recursive descendant helper to walk the graph with that status filter, and returns ids ordered by depth and id.

**Call relations**: It is the public filtered wrapper around list_thread_spawn_descendants_matching.

*Call graph*: calls 1 internal fn (list_thread_spawn_descendants_matching).


##### `StateRuntime::list_thread_spawn_descendants`  (lines 152–158)

```
async fn list_thread_spawn_descendants(
        &self,
        root_thread_id: ThreadId,
    ) -> anyhow::Result<Vec<ThreadId>>
```

**Purpose**: Lists every spawned descendant under a root thread. Unlike direct-child listing, it includes grandchildren and deeper levels.

**Data flow**: It receives a root id, calls the recursive descendant helper without a status filter, and returns all discovered ids breadth-first.

**Call relations**: Deletion retry tests and spawn-tree features use this to rediscover a subtree from the saved edges.

*Call graph*: calls 1 internal fn (list_thread_spawn_descendants_matching).


##### `StateRuntime::find_thread_spawn_child_by_path`  (lines 161–182)

```
async fn find_thread_spawn_child_by_path(
        &self,
        parent_thread_id: ThreadId,
        agent_path: &str,
    ) -> anyhow::Result<Option<ThreadId>>
```

**Purpose**: Finds a direct spawned child by its canonical agent path. This lets the system reuse or locate a child agent thread by its stable path name.

**Data flow**: It takes a parent id and path, joins spawn edges to thread rows, fetches up to two matching ids, and returns none, one id, or an error if the path is ambiguous.

**Call relations**: It relies on one_thread_id_from_rows to enforce the rule that a canonical path should identify at most one matching child.

*Call graph*: calls 1 internal fn (one_thread_id_from_rows); 2 external calls (to_string, query).


##### `StateRuntime::find_thread_spawn_descendant_by_path`  (lines 185–214)

```
async fn find_thread_spawn_descendant_by_path(
        &self,
        root_thread_id: ThreadId,
        agent_path: &str,
    ) -> anyhow::Result<Option<ThreadId>>
```

**Purpose**: Finds any spawned descendant under a root thread by canonical agent path. This searches deeper than immediate children.

**Data flow**: It takes a root id and path, uses a recursive SQL query to walk the spawn subtree, filters descendants by agent path, and returns none, one id, or an ambiguity error.

**Call relations**: Like the direct-child search, it hands raw rows to one_thread_id_from_rows so duplicate matches are caught clearly.

*Call graph*: calls 1 internal fn (one_thread_id_from_rows); 2 external calls (to_string, query).


##### `StateRuntime::list_thread_spawn_children_matching`  (lines 216–236)

```
async fn list_thread_spawn_children_matching(
        &self,
        parent_thread_id: ThreadId,
        status: Option<crate::DirectionalThreadSpawnEdgeStatus>,
    ) -> anyhow::Result<Vec<ThreadId>>
```

**Purpose**: Builds and runs the actual query for direct spawned children, optionally filtered by status. It avoids duplicating almost identical SQL in the public child-listing methods.

**Data flow**: It receives a parent id and optional status, builds a safe parameterized SQL query, reads child_thread_id values, converts them to ThreadId values, and returns the list.

**Call relations**: Both list_thread_spawn_children and list_thread_spawn_children_with_status delegate to this helper.

*Call graph*: called by 2 (list_thread_spawn_children, list_thread_spawn_children_with_status); 2 external calls (new, to_string).


##### `StateRuntime::list_thread_spawn_descendants_matching`  (lines 238–290)

```
async fn list_thread_spawn_descendants_matching(
        &self,
        root_thread_id: ThreadId,
        status: Option<crate::DirectionalThreadSpawnEdgeStatus>,
    ) -> anyhow::Result<Vec<ThreadId>
```

**Purpose**: Builds and runs the recursive query that walks a spawn tree. It can include all edges or only edges with a chosen status.

**Data flow**: It receives a root id and optional status, creates a recursive SQLite query, reads descendant ids with their depth, sorts them breadth-first, and returns converted ThreadId values.

**Call relations**: The public descendant-listing methods call this so the tree-walking logic lives in one place.

*Call graph*: called by 2 (list_thread_spawn_descendants, list_thread_spawn_descendants_with_status); 2 external calls (new, to_string).


##### `StateRuntime::insert_thread_spawn_edge_if_absent`  (lines 292–313)

```
async fn insert_thread_spawn_edge_if_absent(
        &self,
        parent_thread_id: ThreadId,
        child_thread_id: ThreadId,
    ) -> anyhow::Result<()>
```

**Purpose**: Creates a parent-child spawn edge only when the child does not already have one. It is a safe default insert used during thread import or creation.

**Data flow**: It receives parent and child ids, inserts an Open status edge, and does nothing if the child already has an edge.

**Call relations**: insert_thread_spawn_edge_from_source_if_absent calls this after it has extracted a parent id from the thread source.

*Call graph*: called by 1 (insert_thread_spawn_edge_from_source_if_absent); 2 external calls (to_string, query).


##### `StateRuntime::insert_thread_spawn_edge_from_source_if_absent`  (lines 315–325)

```
async fn insert_thread_spawn_edge_from_source_if_absent(
        &self,
        child_thread_id: ThreadId,
        source: &str,
    ) -> anyhow::Result<()>
```

**Purpose**: Looks at a thread’s source information and records a spawn edge if that source names a parent thread. This automatically rebuilds the spawn graph while saving thread metadata.

**Data flow**: It receives a child id and source string, parses the source for a parent id, and if found inserts the missing edge with an open status.

**Call relations**: Both insert_thread_if_absent and upsert_thread_with_creation_memory_mode call this after saving thread rows, so source-derived parent links are kept in sync.

*Call graph*: calls 2 internal fn (insert_thread_spawn_edge_if_absent, thread_spawn_parent_thread_id_from_source_str); called by 2 (insert_thread_if_absent, upsert_thread_with_creation_memory_mode).


##### `StateRuntime::find_rollout_path_by_id`  (lines 328–349)

```
async fn find_rollout_path_by_id(
        &self,
        id: ThreadId,
        archived_only: Option<bool>,
    ) -> anyhow::Result<Option<PathBuf>>
```

**Purpose**: Finds the rollout file path for a thread id. A rollout is the on-disk record of events for a conversation.

**Data flow**: It takes a thread id and optional archive filter, queries rollout_path from the threads table, and returns the path if a matching row exists.

**Call relations**: This is a direct database lookup for code that needs to locate the thread’s underlying rollout file without loading full metadata.

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

**Purpose**: Finds the newest thread with exactly the requested user-facing title. Filters keep the search limited to the right sources, providers, archive state, and optionally working folder.

**Data flow**: It receives title and filter settings, builds a normal thread-list query, adds an exact title condition, sorts newest first, and returns at most one metadata record.

**Call relations**: It reuses push_thread_select_columns, push_thread_filters, and push_thread_order_and_limit so exact-title search follows the same rules as general thread listing.

*Call graph*: calls 3 internal fn (push_thread_filters, push_thread_order_and_limit, push_thread_select_columns); 1 external calls (new).


##### `StateRuntime::list_threads`  (lines 397–404)

```
async fn list_threads(
        &self,
        page_size: usize,
        filters: ThreadFilterOptions<'_>,
    ) -> anyhow::Result<crate::ThreadsPage>
```

**Purpose**: Lists visible threads as a paged result. This powers thread list screens or APIs that browse conversations.

**Data flow**: It receives a page size and filters, then delegates to the shared listing function without limiting results to a parent thread.

**Call relations**: It is the general public entry into list_threads_matching.

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

**Purpose**: Lists only the direct child threads spawned by a given parent, with the same filtering and pagination as the normal thread list.

**Data flow**: It receives page size, parent id, and filters, then delegates to the shared listing function with that parent id attached.

**Call relations**: It uses list_threads_matching so child-thread browsing behaves like normal browsing plus an extra parent constraint.

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

**Purpose**: Runs the shared paged thread-list query and turns database rows into a ThreadsPage. It also computes whether another page is available.

**Data flow**: It receives page size, filters, and optional parent id, asks for one extra row, converts rows to metadata, removes the extra row if present, and returns items plus a next-page anchor.

**Call relations**: list_threads and list_threads_by_parent both call this after deciding whether a parent filter is needed.

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

**Purpose**: Lists only thread ids, not full metadata. This is cheaper when callers just need identifiers for another stage of work.

**Data flow**: It receives limit, cursor anchor, sort key, source/provider filters, and archive state, builds a filtered ordered query, and returns converted ThreadId values.

**Call relations**: It shares the same filter and ordering helpers as full listing, so id-only scans stay consistent with thread browsing.

*Call graph*: calls 2 internal fn (push_thread_filters, push_thread_order_and_limit); 1 external calls (new).


##### `StateRuntime::upsert_thread`  (lines 491–494)

```
async fn upsert_thread(&self, metadata: &crate::ThreadMetadata) -> anyhow::Result<()>
```

**Purpose**: Inserts or updates a thread’s metadata using the normal memory-mode behavior. “Upsert” means insert if missing, otherwise update the existing row.

**Data flow**: It receives metadata and forwards it to the fuller upsert function without a special creation-time memory mode.

**Call relations**: apply_rollout_items, mark_archived, and mark_unarchived call this when saving changed metadata for existing or normal threads.

*Call graph*: calls 1 internal fn (upsert_thread_with_creation_memory_mode); called by 3 (apply_rollout_items, mark_archived, mark_unarchived).


##### `StateRuntime::insert_thread_if_absent`  (lines 496–580)

```
async fn insert_thread_if_absent(
        &self,
        metadata: &crate::ThreadMetadata,
    ) -> anyhow::Result<bool>
```

**Purpose**: Adds a thread row only if it does not already exist. This is used when fallback or discovery code should not overwrite better metadata already stored.

**Data flow**: It receives metadata, chooses a safe updated_at timestamp, derives preview text, tries an insert with default memory mode, adds a source-derived spawn edge if appropriate, and returns whether a row was inserted.

**Call relations**: It uses allocate_thread_updated_at, metadata_preview, and insert_thread_spawn_edge_from_source_if_absent to match the main upsert path while preserving existing rows.

*Call graph*: calls 3 internal fn (allocate_thread_updated_at, insert_thread_spawn_edge_from_source_if_absent, metadata_preview); 1 external calls (query).


##### `StateRuntime::set_thread_memory_mode`  (lines 582–593)

```
async fn set_thread_memory_mode(
        &self,
        thread_id: ThreadId,
        memory_mode: &str,
    ) -> anyhow::Result<bool>
```

**Purpose**: Updates only the memory mode for a thread. This keeps a small setting change from rewriting the rest of the metadata.

**Data flow**: It takes a thread id and memory-mode string, updates the matching row, and returns whether a row was changed.

**Call relations**: apply_rollout_items calls this when newly applied rollout items contain memory-mode information.

*Call graph*: called by 1 (apply_rollout_items); 2 external calls (to_string, query).


##### `StateRuntime::update_thread_title`  (lines 595–606)

```
async fn update_thread_title(
        &self,
        thread_id: ThreadId,
        title: &str,
    ) -> anyhow::Result<bool>
```

**Purpose**: Changes only a thread’s title. This supports quick renaming without touching timestamps, previews, or other stored metadata.

**Data flow**: It receives a thread id and new title, writes the title to the matching row, and returns whether the row existed.

**Call relations**: This is a focused update path for title edits, separate from the larger metadata upsert flow.

*Call graph*: 2 external calls (to_string, query).


##### `StateRuntime::touch_thread_updated_at`  (lines 608–622)

```
async fn touch_thread_updated_at(
        &self,
        thread_id: ThreadId,
        updated_at: DateTime<Utc>,
    ) -> anyhow::Result<bool>
```

**Purpose**: Updates only the thread’s updated_at timestamp. This marks a thread as recently changed while preserving all other fields.

**Data flow**: It receives a thread id and desired time, passes the time through the timestamp allocator, stores seconds and milliseconds, and returns whether a row changed.

**Call relations**: It uses allocate_thread_updated_at for the same stable ordering guarantee as thread inserts and upserts.

*Call graph*: calls 1 internal fn (allocate_thread_updated_at); 2 external calls (to_string, query).


##### `StateRuntime::allocate_thread_updated_at`  (lines 630–668)

```
fn allocate_thread_updated_at(
        &self,
        updated_at: DateTime<Utc>,
    ) -> anyhow::Result<DateTime<Utc>>
```

**Purpose**: Chooses a safe persisted updated_at time for list ordering. It prevents hot, near-simultaneous updates from getting identical millisecond timestamps inside this process.

**Data flow**: It receives a proposed timestamp, compares it with a process-local high-water mark, keeps clearly older historical times unchanged, or bumps close repeated times by one millisecond. It returns the allocated DateTime.

**Call relations**: insert_thread_if_absent, touch_thread_updated_at, and upsert_thread_with_creation_memory_mode all call this before writing updated_at values used by pagination.

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

**Purpose**: Updates Git-related fields for a thread without disturbing newer non-Git metadata. Each Git field can be left alone, set, or cleared.

**Data flow**: It receives a thread id and three optional update instructions, uses SQL CASE expressions to change only requested fields, and returns whether a row was touched.

**Call relations**: This focused path avoids the larger upsert flow when only repository commit, branch, or origin URL changes.

*Call graph*: 2 external calls (to_string, query).


##### `StateRuntime::upsert_thread_with_creation_memory_mode`  (lines 699–813)

```
async fn upsert_thread_with_creation_memory_mode(
        &self,
        metadata: &crate::ThreadMetadata,
        creation_memory_mode: Option<&str>,
    ) -> anyhow::Result<()>
```

**Purpose**: The main insert-or-update routine for thread metadata. It writes almost all thread columns while carefully preserving important existing values when incoming data is incomplete or stale.

**Data flow**: It receives metadata and an optional creation memory mode, allocates updated_at, derives preview text, inserts a row or updates an existing one, preserves non-empty previews and existing Git fields, then records any source-derived spawn edge.

**Call relations**: upsert_thread is the simple wrapper around this, while apply_rollout_items uses it directly when creating a new thread with a known initial memory mode.

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

**Purpose**: Applies newly read rollout events to the thread metadata stored in SQLite. This is the bridge from the event log on disk to the fast searchable thread table.

**Data flow**: It receives a metadata builder, rollout items, optional new-thread memory mode, and optional updated_at override. It loads existing metadata or builds fresh metadata, applies each item, preserves existing Git details, updates the timestamp, upserts the row, and stores memory mode if the items contain one.

**Call relations**: It calls get_thread first, then chooses between upsert_thread_with_creation_memory_mode for new rows and upsert_thread for existing rows; it also uses extract_memory_mode and set_thread_memory_mode for the memory setting.

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

**Purpose**: Marks a thread as archived in the database. Archived threads are hidden from normal lists and shown only when archive filters request them.

**Data flow**: It receives a thread id, archive rollout path, and archive time, loads existing metadata, sets archived_at and path, refreshes updated_at from the file if possible, warns on id mismatch, and upserts the result.

**Call relations**: It depends on get_thread to avoid creating archive records for unknown threads and on upsert_thread to persist the changed metadata.

*Call graph*: calls 2 internal fn (get_thread, upsert_thread); 2 external calls (to_path_buf, warn!).


##### `StateRuntime::mark_unarchived`  (lines 886–906)

```
async fn mark_unarchived(
        &self,
        thread_id: ThreadId,
        rollout_path: &Path,
    ) -> anyhow::Result<()>
```

**Purpose**: Marks an archived thread as active again. This moves it back into normal, non-archived thread lists.

**Data flow**: It receives a thread id and rollout path, loads existing metadata, clears archived_at, updates the path and possibly updated_at, warns on id mismatch, and saves the metadata.

**Call relations**: It mirrors mark_archived, using get_thread before changing state and upsert_thread afterward.

*Call graph*: calls 2 internal fn (get_thread, upsert_thread); 2 external calls (to_path_buf, warn!).


##### `StateRuntime::delete_thread`  (lines 909–911)

```
async fn delete_thread(&self, thread_id: ThreadId) -> anyhow::Result<u64>
```

**Purpose**: Deletes one thread and its associated state. It is the single-thread convenience wrapper around the stricter multi-delete routine.

**Data flow**: It receives one thread id, puts it into a one-item slice, calls delete_threads_strict, and returns the number of thread rows deleted.

**Call relations**: All real cleanup work is handed to delete_threads_strict so single and batch deletion follow the same safety rules.

*Call graph*: calls 1 internal fn (delete_threads_strict).


##### `StateRuntime::delete_threads_strict`  (lines 917–1020)

```
async fn delete_threads_strict(&self, thread_ids: &[ThreadId]) -> anyhow::Result<u64>
```

**Purpose**: Deletes a set of threads and cleans the state connected to them. It is careful to remove the main thread rows last so a failed cleanup can be retried using the remaining graph information.

**Data flow**: It receives thread ids, deletes logs, memories, and goals, updates job and job-item records so deleted worker threads are unassigned or cancelled, removes dynamic tools and spawn edges, deletes thread rows in a transaction, commits, and returns the number of rows removed.

**Call relations**: delete_thread delegates here. The surrounding tests check both successful cleanup and the important retry behavior when an early cleanup step fails.

*Call graph*: called by 1 (delete_thread); 4 external calls (now, is_empty, iter, query).


##### `one_thread_id_from_rows`  (lines 1023–1041)

```
fn one_thread_id_from_rows(
    rows: Vec<sqlx::sqlite::SqliteRow>,
    agent_path: &str,
) -> anyhow::Result<Option<ThreadId>>
```

**Purpose**: Turns search results for an agent path into a clear answer: no thread, one thread, or an error for duplicates. This protects callers from silently choosing the wrong spawned agent.

**Data flow**: It receives database rows and the searched path, converts row ids to ThreadId values, returns none for zero matches, one id for one match, and an error if more than one match exists.

**Call relations**: Both direct-child and descendant path searches use this helper after their SQL queries.

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

**Purpose**: Assembles the SQL for a paged thread list. It combines selected columns, filters, optional parent-child restriction, ordering, and limit.

**Data flow**: It receives a query builder, filter options, optional parent id, and limit, appends SQL fragments and bound values, and leaves the builder ready to execute.

**Call relations**: list_threads_matching uses it for real listing; an index-planning test also calls it to verify SQLite chooses efficient query plans.

*Call graph*: calls 3 internal fn (push_thread_filters, push_thread_order_and_limit, push_thread_select_columns); called by 2 (list_threads_matching, list_threads_uses_indexes_matching_cwd_filters); 2 external calls (push, push_bind).


##### `push_thread_select_columns`  (lines 1074–1104)

```
fn push_thread_select_columns(builder: &mut QueryBuilder<Sqlite>)
```

**Purpose**: Adds the standard list of thread columns to a SQL SELECT query. This keeps all thread metadata queries reading the same shape of data.

**Data flow**: It receives a SQL query builder and appends the SELECT clause with all fields needed to reconstruct ThreadMetadata.

**Call relations**: find_thread_by_exact_title and push_list_threads_query call this before adding FROM, WHERE, and ORDER BY clauses.

*Call graph*: called by 2 (find_thread_by_exact_title, push_list_threads_query); 1 external calls (push).


##### `extract_memory_mode`  (lines 1106–1115)

```
fn extract_memory_mode(items: &[RolloutItem]) -> Option<String>
```

**Purpose**: Finds the latest memory-mode value inside rollout items. It scans from the end because later rollout metadata should win.

**Data flow**: It receives rollout items, looks backward for a session metadata item with memory_mode, and returns that string if found.

**Call relations**: apply_rollout_items uses this after saving metadata so the database memory_mode column reflects the newest rollout instruction.

*Call graph*: called by 1 (apply_rollout_items); 1 external calls (iter).


##### `thread_spawn_parent_thread_id_from_source_str`  (lines 1117–1121)

```
fn thread_spawn_parent_thread_id_from_source_str(source: &str) -> Option<ThreadId>
```

**Purpose**: Parses a thread source string and extracts the parent thread id if the source describes a spawned thread. This lets older or differently encoded source values still contribute to the spawn graph.

**Data flow**: It receives a source string, tries to parse it as session-source JSON or as a plain session-source value, then asks the parsed value for its parent id.

**Call relations**: insert_thread_spawn_edge_from_source_if_absent calls this before deciding whether to create a spawn edge.

*Call graph*: called by 1 (insert_thread_spawn_edge_from_source_if_absent); 1 external calls (from_str).


##### `push_thread_filters`  (lines 1135–1213)

```
fn push_thread_filters(
    builder: &mut QueryBuilder<Sqlite>,
    options: ThreadFilterOptions<'a>,
)
```

**Purpose**: Adds the shared WHERE conditions for thread queries. These conditions decide which threads are visible for a list or search.

**Data flow**: It receives a query builder and filter options, then appends archive filtering, non-empty preview filtering, source/provider filters, working-directory filters, search text matching, and cursor-anchor conditions.

**Call relations**: Thread listing, id listing, exact-title search, and startup job claiming reuse this helper so their filtering rules stay aligned.

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

**Purpose**: Adds ORDER BY and LIMIT to a thread query. It supports sorting by creation or update time in either direction.

**Data flow**: It receives a query builder, sort settings, an index-use hint, and a limit, then appends the ordered timestamp column and bound limit.

**Call relations**: The list and search builders call this after filters are added, making pagination and sorting consistent across those paths.

*Call graph*: called by 3 (find_thread_by_exact_title, list_thread_ids, push_list_threads_query); 2 external calls (push, push_bind).


##### `metadata_preview`  (lines 1254–1260)

```
fn metadata_preview(metadata: &crate::ThreadMetadata) -> &str
```

**Purpose**: Chooses the best preview text available from thread metadata. It prefers an explicit preview, then falls back to the first user message.

**Data flow**: It receives metadata and returns a borrowed string: preview if present, otherwise first_user_message if present, otherwise an empty string.

**Call relations**: insert_thread_if_absent and upsert_thread_with_creation_memory_mode use this before writing the preview column.

*Call graph*: called by 2 (insert_thread_if_absent, upsert_thread_with_creation_memory_mode).


##### `tests::upsert_thread_keeps_creation_memory_mode_for_existing_rows`  (lines 1280–1315)

```
async fn upsert_thread_keeps_creation_memory_mode_for_existing_rows()
```

**Purpose**: Checks that a memory mode chosen when a thread is first created is not overwritten by a later normal upsert.

**Data flow**: The test creates a runtime and thread, inserts it with memory disabled, upserts changed metadata, then reads the database and expects memory_mode to remain disabled.

**Call relations**: It protects the contract between upsert_thread and upsert_thread_with_creation_memory_mode.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 2 external calls (assert_eq!, query_scalar).


##### `tests::delete_thread_cleans_associated_state`  (lines 1318–1406)

```
async fn delete_thread_cleans_associated_state() -> Result<()>
```

**Purpose**: Verifies that deleting threads removes or repairs all related state, not just the thread row.

**Data flow**: The test seeds a thread, spawn edge, logs, goals, dynamic tools, and agent job state, deletes parent and child ids, then checks cleanup, job cancellation, and behavior for a missing thread.

**Call relations**: It exercises delete_threads_strict through realistic related records and also covers delete_thread for a single missing id.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 8 external calls (assert!, assert_eq!, json!, query, query_scalar, assert_thread_cleanup_state, seed_thread_cleanup_state, vec!).


##### `tests::delete_thread_keeps_retry_graph_on_cleanup_failure`  (lines 1409–1435)

```
async fn delete_thread_keeps_retry_graph_on_cleanup_failure() -> Result<()>
```

**Purpose**: Checks that a failed deletion leaves enough thread and spawn-edge data to retry later.

**Data flow**: The test seeds cleanup state, deliberately closes the log database so deletion fails, then confirms the original thread and descendant edge are still discoverable.

**Call relations**: It validates the ordering promise inside delete_threads_strict: risky cleanup happens before deleting the graph.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 3 external calls (assert!, assert_eq!, seed_thread_cleanup_state).


##### `tests::seed_thread_cleanup_state`  (lines 1437–1463)

```
async fn seed_thread_cleanup_state(
        runtime: &StateRuntime,
        thread_id: ThreadId,
        child_thread_id: ThreadId,
    ) -> Result<()>
```

**Purpose**: Creates common related state used by deletion tests. It gives a thread a spawn edge, a goal, and a log entry.

**Data flow**: It receives a runtime plus parent and child ids, writes a closed spawn edge, stores a test goal, and inserts one log row.

**Call relations**: The deletion tests call this helper so they both start from the same cleanup scenario.

*Call graph*: calls 1 internal fn (thread_goals); 3 external calls (to_string, query, upsert_thread_spawn_edge).


##### `tests::assert_thread_cleanup_state`  (lines 1465–1489)

```
async fn assert_thread_cleanup_state(
        runtime: &StateRuntime,
        thread_id: ThreadId,
    ) -> Result<()>
```

**Purpose**: Checks that deletion removed the common related state for a thread. It keeps cleanup assertions shared and readable.

**Data flow**: It receives a runtime and thread id, counts matching spawn edges, reads the thread goal, queries logs, and asserts all are gone.

**Call relations**: tests::delete_thread_cleans_associated_state calls this after deletion to confirm the helper-seeded state was cleaned.

*Call graph*: 7 external calls (default, assert!, assert_eq!, to_string, query_scalar, query_logs, vec!).


##### `tests::list_threads_updated_after_returns_oldest_changes_first`  (lines 1492–1573)

```
async fn list_threads_updated_after_returns_oldest_changes_first()
```

**Purpose**: Tests cursor-based listing in ascending updated-time order. It ensures paging after an anchor returns the next oldest eligible changes first.

**Data flow**: The test inserts threads with controlled update times, lists one page after an anchor, checks the returned id and next anchor, then lists the next page.

**Call relations**: It exercises list_threads and the filtering, ordering, and anchor logic built by push_thread_filters and push_thread_order_and_limit.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 2 external calls (from_timestamp, assert_eq!).


##### `tests::list_threads_filters_by_cwd`  (lines 1576–1680)

```
async fn list_threads_filters_by_cwd()
```

**Purpose**: Verifies that thread listing can be limited to specific working directories. It also checks that an empty directory filter returns no threads.

**Data flow**: The test inserts threads in three folders, lists with two folders and paging, checks only those folders appear, then lists with an empty filter and expects no items.

**Call relations**: It covers list_threads with cwd_filters and the page anchor behavior in that filtered case.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 3 external calls (from_timestamp, assert_eq!, vec!).


##### `tests::list_threads_uses_indexes_matching_cwd_filters`  (lines 1683–1760)

```
async fn list_threads_uses_indexes_matching_cwd_filters()
```

**Purpose**: Checks that generated thread-list SQL uses suitable SQLite indexes for different working-directory filter shapes. This guards performance, not just correctness.

**Data flow**: The test builds EXPLAIN QUERY PLAN queries for several filter combinations, reads SQLite’s chosen plan text, and asserts expected indexes and temporary sorts.

**Call relations**: It calls push_list_threads_query directly so changes to query construction are caught before they slow production listing.

*Call graph*: calls 3 internal fn (init, unique_temp_dir, push_list_threads_query); 5 external calls (from_timestamp, from, new, assert!, assert_eq!).


##### `tests::list_threads_by_parent_filters_direct_children_with_keyset_pagination`  (lines 1763–1852)

```
async fn list_threads_by_parent_filters_direct_children_with_keyset_pagination()
```

**Purpose**: Tests listing direct child threads of a parent with cursor pagination. It confirms grandchildren are not included.

**Data flow**: The test creates two children and one grandchild, stores spawn edges, lists children one page at a time, and checks the order and final anchor.

**Call relations**: It exercises list_threads_by_parent, which is the parent-filtered wrapper around list_threads_matching.

*Call graph*: calls 5 internal fn (from_string, new, init, test_thread_metadata, unique_temp_dir); 2 external calls (from_timestamp, assert_eq!).


##### `tests::apply_rollout_items_restores_memory_mode_from_session_meta`  (lines 1855–1911)

```
async fn apply_rollout_items_restores_memory_mode_from_session_meta()
```

**Purpose**: Verifies that applying rollout session metadata updates the thread memory mode in the database.

**Data flow**: The test creates a thread, builds a rollout item with a memory_mode value, applies it, then reads memory_mode and checks the new value.

**Call relations**: It covers apply_rollout_items, extract_memory_mode, and set_thread_memory_mode working together.

*Call graph*: calls 5 internal fn (from_string, new, init, test_thread_metadata, unique_temp_dir); 2 external calls (assert_eq!, vec!).


##### `tests::apply_rollout_items_preserves_existing_git_branch_and_fills_missing_git_fields`  (lines 1914–1982)

```
async fn apply_rollout_items_preserves_existing_git_branch_and_fills_missing_git_fields()
```

**Purpose**: Checks that rollout application preserves existing Git fields while still filling missing ones from rollout metadata.

**Data flow**: The test stores a thread with an existing branch, applies rollout metadata with commit, branch, and origin URL, then confirms the old branch remains while missing commit and URL are added.

**Call relations**: It validates the Git-preservation path used by apply_rollout_items before upserting metadata.

*Call graph*: calls 5 internal fn (from_string, new, init, test_thread_metadata, unique_temp_dir); 2 external calls (assert_eq!, vec!).


##### `tests::upsert_thread_preserves_existing_git_fields_atomically`  (lines 1985–2023)

```
async fn upsert_thread_preserves_existing_git_fields_atomically()
```

**Purpose**: Ensures a later upsert with different Git values does not overwrite Git fields already stored in SQLite.

**Data flow**: The test inserts metadata with Git fields, upserts cloned metadata carrying different Git fields, then reads back the original values.

**Call relations**: It protects the COALESCE-based preservation logic in upsert_thread_with_creation_memory_mode.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 1 external calls (assert_eq!).


##### `tests::upsert_thread_preserves_existing_preview_when_incoming_preview_is_empty`  (lines 2026–2056)

```
async fn upsert_thread_preserves_existing_preview_when_incoming_preview_is_empty()
```

**Purpose**: Checks that an empty incoming preview does not erase a useful stored preview.

**Data flow**: The test inserts a thread with a preview, upserts metadata with no preview, then verifies the original preview remains.

**Call relations**: It validates the preview preservation rule in the main upsert SQL.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 1 external calls (assert_eq!).


##### `tests::set_thread_preview_if_empty_only_fills_blank_preview`  (lines 2059–2097)

```
async fn set_thread_preview_if_empty_only_fills_blank_preview()
```

**Purpose**: Tests that set_thread_preview_if_empty ignores blank input, fills an empty preview once, and refuses to overwrite it afterward.

**Data flow**: The test inserts a thread with no preview, tries whitespace, then a real preview, then another preview, and finally checks the stored value.

**Call relations**: It directly exercises set_thread_preview_if_empty’s “fill only blank” behavior.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 2 external calls (assert!, assert_eq!).


##### `tests::update_thread_git_info_preserves_newer_non_git_metadata`  (lines 2100–2159)

```
async fn update_thread_git_info_preserves_newer_non_git_metadata()
```

**Purpose**: Checks that updating Git information does not roll back unrelated thread metadata that may have changed separately.

**Data flow**: The test inserts a thread, manually changes non-Git fields in the database, calls update_thread_git_info, then confirms non-Git fields stayed changed and Git fields were updated.

**Call relations**: It validates the purpose of the focused update_thread_git_info path.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 4 external calls (from_timestamp, assert!, assert_eq!, query).


##### `tests::insert_thread_if_absent_preserves_existing_metadata`  (lines 2162–2207)

```
async fn insert_thread_if_absent_preserves_existing_metadata()
```

**Purpose**: Ensures insert_thread_if_absent does not overwrite an existing row with fallback metadata.

**Data flow**: The test inserts rich existing metadata, calls insert_thread_if_absent with weaker fallback metadata for the same id, then checks the existing values remain.

**Call relations**: It protects the ON CONFLICT DO NOTHING behavior in insert_thread_if_absent.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 3 external calls (from_timestamp, assert!, assert_eq!).


##### `tests::update_thread_git_info_can_clear_fields`  (lines 2210–2241)

```
async fn update_thread_git_info_can_clear_fields()
```

**Purpose**: Verifies that Git fields can be explicitly cleared, not only set.

**Data flow**: The test inserts a thread with Git fields, calls update_thread_git_info with clear instructions, then reads back null values.

**Call relations**: It covers the nested option behavior accepted by update_thread_git_info.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 2 external calls (assert!, assert_eq!).


##### `tests::touch_thread_updated_at_updates_only_updated_at`  (lines 2244–2280)

```
async fn touch_thread_updated_at_updates_only_updated_at()
```

**Purpose**: Checks that touching a thread changes its update time without altering title or message fields.

**Data flow**: The test inserts a thread, calls touch_thread_updated_at, then verifies the timestamp changed while other metadata stayed the same.

**Call relations**: It validates touch_thread_updated_at as a narrow update path and indirectly covers timestamp allocation.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 3 external calls (from_timestamp, assert!, assert_eq!).


##### `tests::thread_updated_at_uses_unique_epoch_millis_and_reads_legacy_seconds`  (lines 2283–2378)

```
async fn thread_updated_at_uses_unique_epoch_millis_and_reads_legacy_seconds()
```

**Purpose**: Tests millisecond timestamp allocation and backward compatibility with older second-only timestamp rows.

**Data flow**: The test inserts two threads with the same millisecond time and expects the second to be bumped, inserts an older time unchanged, then manually writes a legacy seconds value and checks it reads as milliseconds.

**Call relations**: It covers allocate_thread_updated_at and the row conversion behavior used by get_thread.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 4 external calls (from_timestamp_millis, assert_eq!, query, query_as).


##### `tests::apply_rollout_items_uses_override_updated_at_when_provided`  (lines 2381–2437)

```
async fn apply_rollout_items_uses_override_updated_at_when_provided()
```

**Purpose**: Verifies that apply_rollout_items respects an explicit updated_at override instead of using the rollout file modification time.

**Data flow**: The test applies a token-count rollout item with a supplied timestamp, then checks both token count and stored updated_at.

**Call relations**: It exercises the override branch inside apply_rollout_items.

*Call graph*: calls 5 internal fn (from_string, new, init, test_thread_metadata, unique_temp_dir); 3 external calls (from_timestamp, assert_eq!, vec!).


##### `tests::thread_spawn_edges_track_directional_status`  (lines 2440–2533)

```
async fn thread_spawn_edges_track_directional_status()
```

**Purpose**: Tests parent-child spawn edges, status changes, and descendant listing. It confirms status filters affect traversal as intended.

**Data flow**: The test creates parent, child, and grandchild edges, lists open children and descendants, closes one edge, then checks open, closed, and all-descendant results.

**Call relations**: It covers upsert_thread_spawn_edge, set_thread_spawn_edge_status, and the child/descendant listing methods.

*Call graph*: calls 3 internal fn (from_string, init, unique_temp_dir); 1 external calls (assert_eq!).


##### `tests::thread_spawn_children_without_status_filter_lists_all_statuses`  (lines 2536–2594)

```
async fn thread_spawn_children_without_status_filter_lists_all_statuses()
```

**Purpose**: Ensures the unfiltered child listing includes edges with any status, even a future status string not known to current code.

**Data flow**: The test inserts open, closed, and manually inserted future-status child edges, lists children without a status filter, and expects all three ids.

**Call relations**: It protects list_thread_spawn_children and list_thread_spawn_children_matching from accidentally filtering unknown statuses.

*Call graph*: calls 3 internal fn (from_string, init, unique_temp_dir); 2 external calls (assert_eq!, query).


### Goal and memory persistence
These files build higher-level per-thread state on top of the thread runtime, covering goal tracking and the memory-processing state machine.

### `state/src/model/thread_goal.rs`

`data_model` · `database read and model conversion`

A thread goal is a piece of work attached to a conversation thread: it has an objective, a current state such as active or complete, optional token budget limits, usage counts, and creation/update times. This file is the shared vocabulary for that idea.

It has three main parts. `ThreadGoalStatus` lists the allowed states for a goal. That matters because storing free-form text like “done” or “finished” would make the rest of the system guess what the goal means. Here, only known statuses are accepted, and unknown database text becomes an error instead of silently producing bad state.

`ThreadGoal` is the clean in-memory model. It uses proper types, such as `ThreadId` for the thread identity and real UTC date-time values for timestamps. This is the version other code should want to work with.

`ThreadGoalRow` is the rougher database-facing version. SQLite rows arrive as strings, numbers, and millisecond timestamps. The conversion code reads those fields out of a database row, then turns them into the stronger `ThreadGoal` form. An everyday analogy is unpacking a shipping box: the database row is the box with labels, and `ThreadGoal` is the item assembled and checked before use.

#### Function details

##### `ThreadGoalStatus::as_str`  (lines 24–33)

```
fn as_str(self) -> &'static str
```

**Purpose**: This turns a goal status into the exact text form used for storage or output, such as `active` or `budget_limited`. It gives the rest of the program one consistent spelling for each status.

**Data flow**: It starts with one `ThreadGoalStatus` value. It matches that value to its fixed lowercase text name. It returns that text slice and does not change anything else.

**Call relations**: This is the outward conversion partner to `ThreadGoalStatus::try_from`: one function turns the enum into stored text, while the other turns stored text back into the enum. It is useful anywhere code needs to write or display the status in the same wording the database expects.


##### `ThreadGoalStatus::is_active`  (lines 35–37)

```
fn is_active(self) -> bool
```

**Purpose**: This answers the simple question, “Is this goal currently active?” It lets callers avoid repeating the exact comparison everywhere.

**Data flow**: It receives a status value. It compares it with `Active`. It returns `true` only for `Active`, otherwise `false`, and changes no stored data.

**Call relations**: This is a small convenience check used by higher-level code when deciding whether a goal should keep running or be treated as not currently active. It does not call other project code; it only reads the status value it was given.


##### `ThreadGoalStatus::is_terminal`  (lines 39–41)

```
fn is_terminal(self) -> bool
```

**Purpose**: This answers whether a goal is in a final state, meaning the system should not expect normal progress to continue. In this file, `BudgetLimited` and `Complete` are treated as terminal states.

**Data flow**: It receives a status value. It checks whether the value is one of the final statuses. It returns a boolean result and does not modify anything.

**Call relations**: This gives higher-level goal logic a single place to ask whether a goal is effectively finished. Internally it uses Rust’s `matches!` pattern check, which is just a compact way to ask “is this one of these listed cases?”

*Call graph*: 1 external calls (matches!).


##### `ThreadGoalStatus::try_from`  (lines 47–57)

```
fn try_from(value: &str) -> Result<Self>
```

**Purpose**: This converts status text from outside the typed model, especially database text, into a safe `ThreadGoalStatus` value. It rejects unknown status names so bad data does not quietly spread through the program.

**Data flow**: It receives a string such as `active` or `complete`. It compares the string with the allowed stored names. If the string is known, it returns the matching status; if not, it returns an error explaining the unknown status.

**Call relations**: This is used by `ThreadGoal::try_from` when a raw database row is being turned into a proper `ThreadGoal`. If the database contains an unexpected status, this function stops the conversion and hands back an error, created with `anyhow!`.

*Call graph*: 1 external calls (anyhow!).


##### `ThreadGoalRow::try_from_row`  (lines 86–98)

```
fn try_from_row(row: &SqliteRow) -> Result<Self>
```

**Purpose**: This reads the thread-goal columns out of a SQLite result row and puts them into a simple intermediate struct. It is the first step in turning database data into application data.

**Data flow**: It receives a SQLite row. It asks the row for each named column: thread id, goal id, objective, status, budget, usage counts, and timestamp numbers. If all fields can be read, it returns a `ThreadGoalRow`; if any field is missing or has the wrong type, it returns an error.

**Call relations**: The call graph shows this being called by `thread_goal_from_row`, which is likely the surrounding helper that converts query results. This function only unpacks the database row; the stronger type checks and timestamp conversion happen afterward, especially in `ThreadGoal::try_from`.

*Call graph*: called by 1 (thread_goal_from_row); 1 external calls (try_get).


##### `ThreadGoal::try_from`  (lines 104–116)

```
fn try_from(row: ThreadGoalRow) -> Result<Self>
```

**Purpose**: This turns the database-shaped `ThreadGoalRow` into the real `ThreadGoal` model used by the rest of the application. It validates and upgrades raw stored values into safer types.

**Data flow**: It receives a `ThreadGoalRow` containing mostly plain strings, numbers, and millisecond timestamps. It converts the thread id string into a `ThreadId`, converts the status string into `ThreadGoalStatus`, keeps the budget and usage numbers, and changes millisecond timestamps into UTC date-time values. If any conversion fails, it returns an error; otherwise it returns a complete `ThreadGoal`.

**Call relations**: This function is the second half of database loading: after `ThreadGoalRow::try_from_row` has pulled values out of SQLite, this builds the application-ready object. It hands off status parsing to `ThreadGoalStatus::try_from`, thread id parsing to `ThreadId::try_from`, and timestamp parsing to `epoch_millis_to_datetime`.

*Call graph*: calls 1 internal fn (try_from); 2 external calls (try_from, epoch_millis_to_datetime).


### `state/src/runtime/goals.rs`

`domain_logic` · `thread goal changes and usage accounting during runtime`

A thread goal is like a job ticket pinned to a conversation: it says what the thread is trying to accomplish, whether it is active, paused, complete, or stopped by limits, and how much time and token usage has been spent on it. This file is the database-backed store for those tickets. Without it, the system could lose track of a thread’s current objective, accidentally overwrite a newer goal with an older update, or keep running after a token budget has been reached.

The main type, `GoalStore`, wraps a shared SQLite connection pool. It can read the current goal, replace it with a fresh one, insert one only when allowed, update selected fields, delete it, and add usage totals. The code is careful about status rules. For example, an active goal with a token budget of zero becomes budget-limited immediately. If a goal is already over budget, trying to mark it active again does not revive it. Updates can also include an expected goal id, which acts like checking the ticket number before writing on it; stale updates are ignored if the goal has already been replaced.

The tests cover these edge cases, especially budget limits, concurrent updates, final usage accounting, and cleanup when a thread is deleted.

#### Function details

##### `GoalStore::new`  (lines 11–13)

```
fn new(pool: Arc<SqlitePool>) -> Self
```

**Purpose**: Creates a `GoalStore` from an existing SQLite connection pool. This gives the rest of the runtime a focused object for working with thread goals instead of passing database access around directly.

**Data flow**: It receives a shared database pool, stores it inside a new `GoalStore`, and returns that store. Nothing is written to the database at this point.

**Call relations**: Runtime startup calls this while building the state runtime, through `init_inner`, so later code can ask for goal operations through one dedicated store.

*Call graph*: called by 1 (init_inner).


##### `GoalStore::close`  (lines 15–17)

```
async fn close(&self)
```

**Purpose**: Closes the database pool used by this goal store. This is part of shutting down cleanly so open database work is not left hanging.

**Data flow**: It reads the stored pool and asks it to close asynchronously. It returns when the pool has finished closing.

**Call relations**: The broader runtime close path calls this during teardown, so goal database access shuts down with the rest of the state system.

*Call graph*: called by 1 (close).


##### `GoalStore::get_thread_goal`  (lines 41–66)

```
async fn get_thread_goal(
        &self,
        thread_id: ThreadId,
    ) -> anyhow::Result<Option<crate::ThreadGoal>>
```

**Purpose**: Looks up the current goal for one thread. Callers use this when they need to know what objective and status are currently stored.

**Data flow**: It receives a thread id, turns it into the database form, queries the `thread_goals` table, and returns either no goal or a `ThreadGoal` built from the row.

**Call relations**: Update and accounting flows call this when they need to return the latest goal after a change, or when no change happened and the caller still needs the current stored value.

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

**Purpose**: Creates a brand-new goal for a thread, replacing any existing one. This is used when the thread’s objective is intentionally reset.

**Data flow**: It receives the thread id, objective text, starting status, and optional token budget. It creates a new unique goal id and timestamps, applies the immediate budget rule, writes a fresh row with usage reset to zero, and returns the stored goal.

**Call relations**: This is a top-level goal operation used by callers that want a clean replacement. It relies on `status_after_budget_limit` before writing and `thread_goal_from_row` after the database returns the saved row.

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

**Purpose**: Adds a goal when there is no active replacement to protect, while allowing replacement of a completed goal. This is a safer form of creation for callers that should not overwrite an unfinished goal.

**Data flow**: It receives the thread id, objective, status, and optional budget. It creates ids and timestamps, applies the immediate budget rule, then inserts the goal or replaces only if the existing goal is complete. It returns the new goal if a write happened, or `None` if an unfinished goal was left alone.

**Call relations**: This is used as a guarded creation path. It shares the same budget-limit decision helper as full replacement, but its database condition prevents accidental overwrites of work still in progress.

*Call graph*: calls 1 internal fn (status_after_budget_limit); 5 external calls (now, new_v4, as_str, to_string, query).


##### `GoalStore::update_thread_goal`  (lines 183–330)

```
async fn update_thread_goal(
        &self,
        thread_id: ThreadId,
        update: GoalUpdate,
    ) -> anyhow::Result<Option<crate::ThreadGoal>>
```

**Purpose**: Changes selected parts of an existing goal, such as its objective, status, or token budget. It is careful not to overwrite fields the caller did not ask to change.

**Data flow**: It receives a thread id and a `GoalUpdate`, whose fields may be present or absent. It writes only the requested changes, checks an optional expected goal id, updates the timestamp, applies budget-limit rules when needed, and returns the refreshed goal or `None` if no matching goal was updated.

**Call relations**: This is the main edit path for goals. It calls `get_thread_goal` when it needs to return the current goal without changing it, and again after successful writes so callers receive the database’s final version.

*Call graph*: calls 1 internal fn (get_thread_goal); 3 external calls (now, to_string, query).


##### `GoalStore::pause_active_thread_goal`  (lines 332–338)

```
async fn pause_active_thread_goal(
        &self,
        thread_id: ThreadId,
    ) -> anyhow::Result<Option<crate::ThreadGoal>>
```

**Purpose**: Pauses a goal, but only if it is currently active. This avoids accidentally changing completed or otherwise terminal goals.

**Data flow**: It receives a thread id and asks the shared status-update helper to set that active goal to paused. It returns the updated goal if one was changed, otherwise `None`.

**Call relations**: This is a small public convenience method. It hands the real work to `update_active_thread_goal_status`, which enforces the rule that only suitable current statuses may be changed.

*Call graph*: calls 1 internal fn (update_active_thread_goal_status).


##### `GoalStore::usage_limit_active_thread_goal`  (lines 340–346)

```
async fn usage_limit_active_thread_goal(
        &self,
        thread_id: ThreadId,
    ) -> anyhow::Result<Option<crate::ThreadGoal>>
```

**Purpose**: Marks a currently running goal as stopped by an outside usage limit. It can also convert a budget-limited goal into usage-limited so the more specific stop reason is visible.

**Data flow**: It receives a thread id and asks the shared status-update helper to write the usage-limited status. It returns the changed goal or `None` if there was no eligible goal.

**Call relations**: This mirrors the pause helper but requests the usage-limited status. It delegates to `update_active_thread_goal_status` for the database update and follow-up read.

*Call graph*: calls 1 internal fn (update_active_thread_goal_status).


##### `GoalStore::update_active_thread_goal_status`  (lines 348–382)

```
async fn update_active_thread_goal_status(
        &self,
        thread_id: ThreadId,
        status: crate::ThreadGoalStatus,
    ) -> anyhow::Result<Option<crate::ThreadGoal>>
```

**Purpose**: Updates a goal’s status only when the current status is safe to change. This protects completed, paused, blocked, or otherwise non-active goals from being clobbered by late events.

**Data flow**: It receives a thread id and target status. It updates the row only if the stored goal is active, with one special case that allows usage-limited to replace budget-limited, then returns the fresh goal if a row changed.

**Call relations**: `pause_active_thread_goal` and `usage_limit_active_thread_goal` both use this helper. After a successful write, it calls `get_thread_goal` so the caller gets the complete updated goal.

*Call graph*: calls 1 internal fn (get_thread_goal); called by 2 (pause_active_thread_goal, usage_limit_active_thread_goal); 4 external calls (now, as_str, to_string, query).


##### `GoalStore::delete_thread_goal`  (lines 384–409)

```
async fn delete_thread_goal(
        &self,
        thread_id: ThreadId,
    ) -> anyhow::Result<Option<crate::ThreadGoal>>
```

**Purpose**: Deletes the goal for a thread and returns what was deleted. This is useful for explicit cleanup or for confirming what goal was removed.

**Data flow**: It receives a thread id, deletes the matching row from `thread_goals`, and returns the deleted goal if one existed. If no goal was present, it returns `None`.

**Call relations**: This is a direct database operation exposed by the store. It does not call other store methods; it lets the database return the removed row in one step.

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

**Purpose**: Adds time and token usage to a goal and may stop it when its token budget is reached. This is how the system keeps the goal’s running cost totals accurate.

**Data flow**: It receives a thread id, time increase, token increase, an accounting mode, and an optional expected goal id. Negative increases are treated as zero; if nothing is added, it just returns the current goal. Otherwise it updates counters atomically in the database, applies the budget-limited status when appropriate, and returns either `Updated` with the new goal or `Unchanged` with the current goal.

**Call relations**: Usage tracking calls this after work has happened or is being finalized. It calls `get_thread_goal` when no row is updated, and uses `thread_goal_from_row` when the database returns the updated row.

*Call graph*: calls 2 internal fn (get_thread_goal, thread_goal_from_row); 5 external calls (new, now, to_string, Unchanged, Updated).


##### `thread_goal_from_row`  (lines 526–528)

```
fn thread_goal_from_row(row: &sqlx::sqlite::SqliteRow) -> anyhow::Result<crate::ThreadGoal>
```

**Purpose**: Turns a raw SQLite row into the project’s `ThreadGoal` type. This keeps database column decoding in one small place.

**Data flow**: It receives a database row, first converts it into the internal row-shaped model, then converts that into the public `ThreadGoal`. If any field is invalid, it returns an error instead of a bad goal.

**Call relations**: Goal-writing and accounting paths use this after SQLite returns a row, especially `replace_thread_goal` and `account_thread_goal_usage`, so the rest of the code deals with normal Rust goal objects instead of raw database rows.

*Call graph*: calls 1 internal fn (try_from_row); called by 2 (account_thread_goal_usage, replace_thread_goal).


##### `status_after_budget_limit`  (lines 530–542)

```
fn status_after_budget_limit(
    status: crate::ThreadGoalStatus,
    tokens_used: i64,
    token_budget: Option<i64>,
) -> crate::ThreadGoalStatus
```

**Purpose**: Applies the simple rule that an active goal already at or above its token budget should be budget-limited. This prevents a newly created active goal from starting in an impossible state.

**Data flow**: It receives a proposed status, current token count, and optional budget. If the status is active and the token count meets or exceeds the budget, it returns budget-limited; otherwise it returns the original status.

**Call relations**: `replace_thread_goal` and `insert_thread_goal` call this before saving a goal, so budget rules are enforced from the moment the goal is created.

*Call graph*: called by 2 (insert_thread_goal, replace_thread_goal).


##### `tests::test_runtime`  (lines 551–555)

```
async fn test_runtime() -> std::sync::Arc<StateRuntime>
```

**Purpose**: Builds a temporary state runtime for tests. It gives each test a fresh database-like environment to work in.

**Data flow**: It creates a unique temporary directory, initializes the state runtime with a test provider name, and returns the ready runtime wrapped for shared use.

**Call relations**: Most tests call this first so they can exercise the real goal store behavior without touching a normal user database.

*Call graph*: calls 2 internal fn (init, unique_temp_dir).


##### `tests::test_thread_id`  (lines 557–559)

```
fn test_thread_id() -> ThreadId
```

**Purpose**: Provides a stable, known thread id for tests. This makes expected values easier to compare.

**Data flow**: It parses a fixed UUID string into a `ThreadId` and returns it. If the fixed value were invalid, the test would fail immediately.

**Call relations**: The test cases call this before inserting thread metadata and goals, so every test has a predictable thread identifier.

*Call graph*: calls 1 internal fn (from_string).


##### `tests::upsert_test_thread`  (lines 561–571)

```
async fn upsert_test_thread(runtime: &StateRuntime, thread_id: ThreadId)
```

**Purpose**: Creates or updates the thread record that a goal belongs to. Goals depend on having a thread, so tests use this setup step before goal operations.

**Data flow**: It receives a runtime and thread id, builds test thread metadata using the runtime’s home directory and a workspace path, then saves that metadata through the runtime.

**Call relations**: The tests call this after creating the runtime and thread id. It prepares the database so goal insert, update, and delete behavior can be tested realistically.

*Call graph*: calls 2 internal fn (codex_home, test_thread_metadata); 1 external calls (upsert_thread).


##### `tests::replace_update_and_get_thread_goal`  (lines 574–666)

```
async fn replace_update_and_get_thread_goal()
```

**Purpose**: Checks the basic lifecycle: create a goal, read it, update it, replace it, delete it, and confirm it is gone.

**Data flow**: It sets up a test runtime and thread, writes a goal, verifies the read result, updates status and budget, replaces the goal with a fresh one, then deletes it and checks later reads return nothing.

**Call relations**: The test runner invokes this test. It uses the shared setup helpers to create the environment before exercising the public `GoalStore` methods.

*Call graph*: 4 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::replace_thread_goal_applies_budget_limit_immediately`  (lines 669–689)

```
async fn replace_thread_goal_applies_budget_limit_immediately()
```

**Purpose**: Verifies that replacing a goal with an active status and a zero token budget stores it as budget-limited right away.

**Data flow**: It creates a thread, replaces its goal with budget zero, and checks that the saved status is budget-limited with zero usage.

**Call relations**: This test exercises the creation path that calls the budget-status helper through `replace_thread_goal`.

*Call graph*: 4 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::insert_thread_goal_does_not_replace_existing_goal`  (lines 692–729)

```
async fn insert_thread_goal_does_not_replace_existing_goal()
```

**Purpose**: Checks that guarded insertion does not overwrite an existing unfinished goal.

**Data flow**: It inserts an initial goal, attempts a second insert with different text and budget, then verifies the second call returns `None` and the original goal is still stored.

**Call relations**: The test runner calls this to protect the contract of `insert_thread_goal`, using the common runtime, thread id, and thread setup helpers.

*Call graph*: 4 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::insert_thread_goal_applies_budget_limit_immediately`  (lines 732–753)

```
async fn insert_thread_goal_applies_budget_limit_immediately()
```

**Purpose**: Verifies that guarded insertion also applies the immediate budget-limit rule.

**Data flow**: It creates a thread, inserts an active goal with a zero token budget, and checks that the resulting goal is budget-limited with no usage counted.

**Call relations**: This test covers the `insert_thread_goal` path and its use of the same budget decision as replacement.

*Call graph*: 4 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::update_thread_goal_ignores_replaced_goal_version`  (lines 756–821)

```
async fn update_thread_goal_ignores_replaced_goal_version()
```

**Purpose**: Checks that an update tied to an old goal id cannot change a newer replacement goal.

**Data flow**: It creates one goal, replaces it with another, tries to update using the old goal id, and confirms nothing changes. It then updates using the new goal id and confirms the change succeeds.

**Call relations**: This test focuses on the expected-goal-id safety check in `update_thread_goal`, after setup through the shared test helpers.

*Call graph*: 4 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::usage_accounting_ignores_replaced_goal_version`  (lines 824–870)

```
async fn usage_accounting_ignores_replaced_goal_version()
```

**Purpose**: Checks that usage from an old goal version is not added to a newer goal.

**Data flow**: It creates and then replaces a goal, attempts usage accounting with the old goal id, and verifies the replacement goal still has zero counted time and tokens.

**Call relations**: This test exercises the expected-goal-id protection in `account_thread_goal_usage`, using assertions to prove stale accounting was ignored.

*Call graph*: 6 external calls (assert_eq!, assert_ne!, panic!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::update_thread_goal_objective_preserves_usage_and_created_at`  (lines 873–925)

```
async fn update_thread_goal_objective_preserves_usage_and_created_at()
```

**Purpose**: Verifies that editing a goal’s wording, status, or budget does not erase its existing usage totals or original creation time.

**Data flow**: It creates a goal, adds usage, updates objective/status/budget, and compares the result against the previously accounted goal with only the requested fields changed.

**Call relations**: This test combines usage accounting and later goal editing to make sure independent fields survive `update_thread_goal`.

*Call graph*: 5 external calls (assert_eq!, panic!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::concurrent_partial_updates_preserve_independent_fields`  (lines 928–973)

```
async fn concurrent_partial_updates_preserve_independent_fields()
```

**Purpose**: Checks that two partial updates running at the same time do not wipe out each other’s changes.

**Data flow**: It creates a goal, starts one update that changes status and another that changes budget, waits for both, then reads the goal and verifies both changes are present.

**Call relations**: This test uses concurrent execution through `join!` to protect the field-preserving behavior of `update_thread_goal`.

*Call graph*: 5 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread, join!).


##### `tests::pause_active_thread_goal_does_not_clobber_terminal_status`  (lines 976–1032)

```
async fn pause_active_thread_goal_does_not_clobber_terminal_status()
```

**Purpose**: Verifies that pausing works for an active goal but does not overwrite a completed goal.

**Data flow**: It creates an active goal and pauses it, then marks it complete and attempts to pause again. The second pause returns no change and the completed goal remains complete.

**Call relations**: This test covers the public pause helper and the guarded status update helper beneath it.

*Call graph*: 4 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::usage_limit_active_thread_goal_updates_active_or_budget_limited_goals`  (lines 1035–1092)

```
async fn usage_limit_active_thread_goal_updates_active_or_budget_limited_goals()
```

**Purpose**: Checks when a goal can become usage-limited. Active goals can change to usage-limited, repeated updates do nothing, and budget-limited goals can also be converted.

**Data flow**: It creates an active goal, marks it usage-limited, confirms a second attempt changes nothing, then creates a budget-limited goal and confirms usage-limited can replace that status.

**Call relations**: This test exercises `usage_limit_active_thread_goal` and the special case inside the shared active-status update helper.

*Call graph*: 4 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::usage_accounting_updates_active_goals_and_accounts_budget_limited_in_flight_usage`  (lines 1095–1163)

```
async fn usage_accounting_updates_active_goals_and_accounts_budget_limited_in_flight_usage()
```

**Purpose**: Verifies normal usage counting and the rule that a goal can still receive in-flight usage after crossing its budget.

**Data flow**: It creates an active goal with a budget, adds some usage below the budget, adds enough to hit the budget, then adds one more in-flight amount while budget-limited and checks all totals.

**Call relations**: This test focuses on `account_thread_goal_usage` in active-only mode and its budget-limited transition behavior.

*Call graph*: 5 external calls (assert_eq!, panic!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::active_status_only_usage_accounting_does_not_update_budget_limited_goals`  (lines 1166–1198)

```
async fn active_status_only_usage_accounting_does_not_update_budget_limited_goals()
```

**Purpose**: Checks the stricter accounting mode that only updates goals whose status is exactly active.

**Data flow**: It creates a budget-limited goal, attempts to add usage in active-status-only mode, and verifies counters remain at zero.

**Call relations**: This test protects the difference between accounting modes in `account_thread_goal_usage`.

*Call graph*: 5 external calls (assert_eq!, panic!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::stopped_usage_accounting_promotes_paused_goal_over_budget`  (lines 1201–1246)

```
async fn stopped_usage_accounting_promotes_paused_goal_over_budget()
```

**Purpose**: Verifies that final accounting for a stopped goal can still mark it budget-limited if the final usage puts it over budget.

**Data flow**: It creates an active goal with a budget, pauses it, then accounts a final token amount above the budget using the active-or-stopped mode. The goal ends budget-limited with the final totals recorded.

**Call relations**: This test covers the broader stopped-goal accounting mode in `account_thread_goal_usage`.

*Call graph*: 5 external calls (assert_eq!, panic!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::budget_updates_immediately_stop_active_goals_already_over_budget`  (lines 1249–1293)

```
async fn budget_updates_immediately_stop_active_goals_already_over_budget()
```

**Purpose**: Checks that lowering a token budget below already-used tokens immediately stops the goal as budget-limited.

**Data flow**: It creates a goal, records token usage, lowers the budget beneath that usage, and verifies the status changes to budget-limited while preserving the counted tokens.

**Call relations**: This test exercises the budget-update branch of `update_thread_goal`.

*Call graph*: 4 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::activating_goal_already_over_budget_keeps_it_budget_limited`  (lines 1296–1344)

```
async fn activating_goal_already_over_budget_keeps_it_budget_limited()
```

**Purpose**: Verifies that trying to reactivate an over-budget goal does not bypass the budget limit.

**Data flow**: It creates a goal, records enough usage to exceed the budget, then asks to set the status back to active while changing the objective. The objective changes, but the status stays budget-limited.

**Call relations**: This test protects the status logic inside `update_thread_goal`, especially when the requested status conflicts with the stored budget state.

*Call graph*: 4 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::pausing_budget_limited_goal_preserves_terminal_status`  (lines 1347–1391)

```
async fn pausing_budget_limited_goal_preserves_terminal_status()
```

**Purpose**: Checks that asking to pause a budget-limited goal does not hide the fact that the budget was exceeded.

**Data flow**: It creates a goal, records enough usage to make it budget-limited, then sends a pause update and verifies the status remains budget-limited.

**Call relations**: This test exercises the rule in `update_thread_goal` that preserves budget-limited status over certain later status requests.

*Call graph*: 4 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::blocking_budget_limited_goal_preserves_terminal_status`  (lines 1394–1443)

```
async fn blocking_budget_limited_goal_preserves_terminal_status()
```

**Purpose**: Checks that asking to block a budget-limited goal also preserves the budget-limited status.

**Data flow**: It creates a goal, records usage over budget, then sends a blocked-status update. The result keeps the budget-limited state, apart from the normal updated timestamp.

**Call relations**: This test covers another branch of the terminal-status preservation logic in `update_thread_goal`.

*Call graph*: 5 external calls (assert_eq!, panic!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::usage_accounting_can_finalize_completed_goal_for_completing_turn`  (lines 1446–1496)

```
async fn usage_accounting_can_finalize_completed_goal_for_completing_turn()
```

**Purpose**: Verifies that completed goals usually are not updated by active-only accounting, but can receive final usage for the turn that completed them.

**Data flow**: It creates a completed goal, tries active-only accounting and sees no change, then uses active-or-complete accounting and confirms the final time and tokens are recorded.

**Call relations**: This test protects the `ActiveOrComplete` mode in `account_thread_goal_usage`.

*Call graph*: 5 external calls (assert_eq!, panic!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::usage_accounting_can_finalize_stopped_goal_for_in_flight_turn`  (lines 1499–1563)

```
async fn usage_accounting_can_finalize_stopped_goal_for_in_flight_turn()
```

**Purpose**: Verifies that a paused goal can receive final usage for work that was already in flight when it stopped.

**Data flow**: It creates an active goal, pauses it, confirms active-only accounting does nothing, then uses active-or-stopped accounting and verifies usage is added while the status remains paused.

**Call relations**: This test protects the `ActiveOrStopped` mode in `account_thread_goal_usage`.

*Call graph*: 5 external calls (assert_eq!, panic!, test_runtime, test_thread_id, upsert_test_thread).


##### `tests::usage_accounting_adds_concurrent_token_deltas`  (lines 1566–1607)

```
async fn usage_accounting_adds_concurrent_token_deltas()
```

**Purpose**: Checks that two simultaneous usage updates add together instead of one overwriting the other.

**Data flow**: It creates a goal, starts two accounting updates at once with different time and token amounts, waits for both, then reads the goal and verifies the totals are the sum.

**Call relations**: This test uses `join!` to exercise the atomic counter update behavior of `account_thread_goal_usage`.

*Call graph*: 5 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread, join!).


##### `tests::deleting_thread_deletes_goal`  (lines 1610–1638)

```
async fn deleting_thread_deletes_goal()
```

**Purpose**: Verifies that deleting a thread also removes its goal. This prevents orphaned goal records from staying in the database after their thread is gone.

**Data flow**: It creates a thread and goal, deletes the thread through the runtime, then checks that reading the goal returns nothing.

**Call relations**: This test connects the goal store to the wider thread deletion behavior, using the shared setup helpers and the runtime’s delete operation.

*Call graph*: 4 external calls (assert_eq!, test_runtime, test_thread_id, upsert_test_thread).


### `state/src/runtime/memories.rs`

`domain_logic` · `background memory extraction and consolidation, with startup scanning and test support`

This file is the memory pipeline's database control room. The system first extracts useful memory from individual conversation threads, then later consolidates selected thread memories into a global memory view. Without this file, workers could repeat the same extraction, overwrite each other, forget to retry failures, or include memories from deleted or polluted threads.

The main type is `MemoryStore`. It talks to two SQLite databases: one for memory-specific tables such as `stage1_outputs` and `jobs`, and one for thread metadata such as whether memory is enabled for a thread. SQLite is a small file-based database.

The pipeline works in two stages. Stage 1 claims work for stale threads, records success or failure, and saves the extracted memory text. Stage 2 is a single global consolidation job. It chooses the best current stage-1 outputs, based on recency and use, and marks exactly which snapshots were used in the last successful global build. The file also includes cleanup paths: deleting memory for a thread, pruning old unused outputs, marking polluted threads so they stop feeding global memory, and clearing all memory data.

A key idea is leases. A lease is like a temporary reservation ticket for a worker. If the worker disappears, the lease expires and another worker may take over. Ownership tokens make sure only the worker that claimed a job can finish it.

#### Function details

##### `MemoryStore::new`  (lines 34–36)

```
fn new(pool: Arc<SqlitePool>, state_pool: Arc<SqlitePool>) -> Self
```

**Purpose**: Creates a `MemoryStore` from the database connections it needs. It gives the memory subsystem access to both its own memory database and the main state database.

**Data flow**: It receives two shared SQLite connection pools, stores them inside a new `MemoryStore`, and returns that store for later use.

**Call relations**: The runtime setup path calls this from `init_inner` when it builds the full state runtime.

*Call graph*: called by 1 (init_inner).


##### `MemoryStore::close`  (lines 38–40)

```
async fn close(&self)
```

**Purpose**: Closes the memory database connection pool. This is used when the runtime is shutting down or cleaning up.

**Data flow**: It reads the pool stored in `MemoryStore`, asks it to close, and produces no data result beyond completion.

**Call relations**: The wider runtime `close` flow calls this so memory database resources are released with the rest of the runtime.

*Call graph*: called by 1 (close).


##### `MemoryStore::clear_memory_data`  (lines 47–49)

```
async fn clear_memory_data(&self) -> anyhow::Result<()>
```

**Purpose**: Deletes all stored memory outputs and memory pipeline jobs. This is a reset button for generated memory data, not for thread records themselves.

**Data flow**: It takes the store's memory database pool, passes it to the shared clearing helper, and returns success or an error.

**Call relations**: It delegates the actual database deletion to `clear_memory_data_in_pool`, keeping the public method small.

*Call graph*: calls 1 internal fn (clear_memory_data_in_pool).


##### `MemoryStore::record_stage1_output_usage`  (lines 55–86)

```
async fn record_stage1_output_usage(
        &self,
        thread_ids: &[ThreadId],
    ) -> anyhow::Result<usize>
```

**Purpose**: Records that certain per-thread memory outputs were used. This lets later selection prefer memories that are actually helpful.

**Data flow**: It receives thread IDs. For each one, it increments that output's usage count and sets its last-used time to now; missing rows are ignored. It returns how many rows were updated.

**Call relations**: This is a direct database update path. It does not call other project helpers, but it feeds later ranking in `MemoryStore::get_phase2_input_selection`.

*Call graph*: 3 external calls (now, is_empty, query).


##### `MemoryStore::stage1_source_needs_update`  (lines 88–131)

```
async fn stage1_source_needs_update(
        &self,
        thread_id: ThreadId,
        source_updated_at: i64,
    ) -> anyhow::Result<bool>
```

**Purpose**: Checks whether a thread's saved memory is older than the thread itself. It prevents pointless extraction work when the existing output or successful job is already current.

**Data flow**: It receives a thread ID and the thread's source update time. It looks for a saved output and then a job success watermark; if either is new enough, it returns `false`, otherwise `true`.

**Call relations**: `MemoryStore::claim_stage1_jobs_for_startup` calls this before trying to claim startup work, so it only reserves jobs that can actually produce newer memory.

*Call graph*: called by 1 (claim_stage1_jobs_for_startup); 3 external calls (as_str, to_string, query).


##### `MemoryStore::claim_stage1_jobs_for_startup`  (lines 148–270)

```
async fn claim_stage1_jobs_for_startup(
        &self,
        current_thread_id: ThreadId,
        params: Stage1StartupClaimParams<'_>,
    ) -> anyhow::Result<Vec<Stage1JobClaim>>
```

**Purpose**: Finds old enough, active threads at startup and claims memory extraction jobs for them. This lets the system catch up on memory generation without scanning forever.

**Data flow**: It receives the current worker thread ID and limits such as scan size, age window, allowed sources, and lease length. It queries eligible threads from the state database, checks whether each needs an update, then tries to claim jobs until the requested maximum is reached. It returns claimed threads with ownership tokens.

**Call relations**: It uses `push_thread_filters` to build the thread query, calls `MemoryStore::stage1_source_needs_update` to skip current rows, and hands each candidate to `MemoryStore::try_claim_stage1_job` to reserve the work.

*Call graph*: calls 3 internal fn (stage1_source_needs_update, try_claim_stage1_job, push_thread_filters); 7 external calls (days, hours, new, now, new, try_from, as_str).


##### `MemoryStore::delete_thread_memory`  (lines 272–320)

```
async fn delete_thread_memory(&self, thread_id: ThreadId) -> anyhow::Result<()>
```

**Purpose**: Removes all memory data and stage-1 job state for one thread. If that thread was part of the last global memory build, it asks phase 2 to rebuild without it.

**Data flow**: It receives a thread ID. Inside one transaction, it checks whether the output was selected for phase 2, deletes the output and its stage-1 job row, maybe enqueues global consolidation, then commits.

**Call relations**: When a selected thread is removed, it calls `enqueue_global_consolidation_with_executor` so the global memory can be corrected.

*Call graph*: calls 1 internal fn (enqueue_global_consolidation_with_executor); 4 external calls (now, as_str, to_string, query).


##### `MemoryStore::list_stage1_outputs_for_global`  (lines 330–366)

```
async fn list_stage1_outputs_for_global(
        &self,
        n: usize,
    ) -> anyhow::Result<Vec<Stage1Output>>
```

**Purpose**: Lists recent non-empty per-thread memory outputs that could feed global consolidation. It also hides outputs for threads whose memory is no longer enabled.

**Data flow**: It receives a maximum count. It reads non-empty saved outputs in newest-first order, enriches each with thread metadata, skips invisible threads, and returns up to the requested number.

**Call relations**: For each database row, it calls `MemoryStore::stage1_output_from_row_if_thread_enabled`, which performs the thread-enabled check and builds the output object.

*Call graph*: calls 1 internal fn (stage1_output_from_row_if_thread_enabled); 2 external calls (new, query).


##### `MemoryStore::prune_stage1_outputs_for_retention`  (lines 376–409)

```
async fn prune_stage1_outputs_for_retention(
        &self,
        max_unused_days: i64,
        limit: usize,
    ) -> anyhow::Result<usize>
```

**Purpose**: Deletes old, unused per-thread memory outputs to keep the memory database from growing forever. It avoids deleting outputs that are part of the last successful global baseline.

**Data flow**: It receives an age limit and deletion limit. It computes a cutoff time, deletes at most that many unselected rows older than the cutoff, and returns the number deleted.

**Call relations**: This is a standalone retention cleanup query. Its result changes what future listing and phase-2 selection calls can see.

*Call graph*: 3 external calls (days, now, query).


##### `MemoryStore::get_phase2_input_selection`  (lines 426–521)

```
async fn get_phase2_input_selection(
        &self,
        n: usize,
        max_unused_days: i64,
    ) -> anyhow::Result<Vec<Stage1Output>>
```

**Purpose**: Chooses the current set of stage-1 outputs that should be materialized for global memory consolidation. It favors used, recent, non-empty memories from still-enabled threads.

**Data flow**: It receives a maximum count and max-unused age. It pages through ranked candidate rows, checks that each thread is still enabled, reloads each selected snapshot, builds full `Stage1Output` records, sorts them by thread ID for stable output, and returns them.

**Call relations**: It calls `MemoryStore::enabled_thread_metadata` during candidate filtering and `MemoryStore::stage1_output_from_row_if_thread_enabled` when building final outputs.

*Call graph*: calls 3 internal fn (try_from, enabled_thread_metadata, stage1_output_from_row_if_thread_enabled); 6 external calls (days, now, new, with_capacity, try_from, query).


##### `MemoryStore::stage1_output_from_row_if_thread_enabled`  (lines 523–535)

```
async fn stage1_output_from_row_if_thread_enabled(
        &self,
        row: &sqlx::sqlite::SqliteRow,
    ) -> anyhow::Result<Option<Stage1Output>>
```

**Purpose**: Turns a saved stage-1 database row into a usable output only if the thread is still allowed to contribute memory.

**Data flow**: It receives a SQLite row. It reads the thread ID, fetches enabled thread metadata, returns `None` if the thread is missing or disabled, or returns a full `Stage1Output` if valid.

**Call relations**: `MemoryStore::list_stage1_outputs_for_global` and `MemoryStore::get_phase2_input_selection` call this to avoid leaking disabled or polluted thread memory into global consolidation.

*Call graph*: calls 3 internal fn (try_from, enabled_thread_metadata, stage1_output_from_row_and_thread); called by 2 (get_phase2_input_selection, list_stage1_outputs_for_global); 1 external calls (try_get).


##### `MemoryStore::enabled_thread_metadata`  (lines 537–578)

```
async fn enabled_thread_metadata(
        &self,
        thread_id: ThreadId,
    ) -> anyhow::Result<Option<ThreadMetadata>>
```

**Purpose**: Loads thread metadata only when that thread has memory enabled. This is the gatekeeper that keeps disabled or polluted threads out of memory results.

**Data flow**: It receives a thread ID, queries the state database for that thread with `memory_mode = 'enabled'`, converts the row to `ThreadMetadata`, and returns it or `None`.

**Call relations**: `MemoryStore::get_phase2_input_selection` and `MemoryStore::stage1_output_from_row_if_thread_enabled` call this before allowing a memory output to be used.

*Call graph*: called by 2 (get_phase2_input_selection, stage1_output_from_row_if_thread_enabled); 2 external calls (to_string, query).


##### `MemoryStore::mark_thread_memory_mode_polluted`  (lines 582–616)

```
async fn mark_thread_memory_mode_polluted(
        &self,
        thread_id: ThreadId,
    ) -> anyhow::Result<bool>
```

**Purpose**: Marks a thread as polluted, meaning its memory should no longer be trusted for global memory. If it was previously used in the global build, it schedules a rebuild.

**Data flow**: It receives a thread ID. It checks whether the thread's output was selected for phase 2, updates the thread's memory mode in the state database, possibly enqueues global consolidation, and returns whether the mode actually changed.

**Call relations**: When a selected thread becomes polluted, it calls `MemoryStore::enqueue_global_consolidation`, which forwards to the shared enqueue helper.

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

**Purpose**: Tries to reserve per-thread memory extraction for one worker. It prevents duplicate workers from processing the same thread and respects retry delays and a global running-job cap.

**Data flow**: It receives a thread ID, worker ID, source update time, lease length, and max running jobs. It checks whether existing output or job success is already current, then inserts or updates a job row with a fresh ownership token and lease if allowed. It returns a claimed token or a specific skip reason.

**Call relations**: `MemoryStore::claim_stage1_jobs_for_startup` calls this for startup candidates. Later success or failure methods use the ownership token it returns.

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

**Purpose**: Finishes a claimed stage-1 job that produced memory text. It saves the extracted memory and asks the global consolidation step to notice the change.

**Data flow**: It receives the thread ID, ownership token, source timestamp, memory text, rollout summary, and optional rollout slug. It updates only the matching running job, upserts the output row if the source is not older, enqueues phase 2, and returns whether finalization succeeded.

**Call relations**: It calls `enqueue_global_consolidation_with_executor` inside the same transaction so the saved output and the phase-2 notification stay in sync.

*Call graph*: calls 1 internal fn (enqueue_global_consolidation_with_executor); 4 external calls (now, as_str, to_string, query).


##### `MemoryStore::mark_stage1_job_succeeded_no_output`  (lines 902–968)

```
async fn mark_stage1_job_succeeded_no_output(
        &self,
        thread_id: ThreadId,
        ownership_token: &str,
    ) -> anyhow::Result<bool>
```

**Purpose**: Finishes a claimed stage-1 job that found nothing worth saving. It still records the successful watermark so the same unchanged thread is not retried forever.

**Data flow**: It receives the thread ID and ownership token. It marks the owned job done, reads its input watermark, deletes any old output for that thread, and enqueues phase 2 only if an old output was actually removed.

**Call relations**: If deletion changes global memory inputs, it calls `enqueue_global_consolidation_with_executor`; otherwise it just marks the stage-1 job complete.

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

**Purpose**: Records that a claimed stage-1 extraction failed and schedules a retry later. This keeps temporary failures from causing tight retry loops.

**Data flow**: It receives a thread ID, ownership token, failure message, and retry delay. It updates only the matching running job to error, clears its lease, lowers the retry count, stores the error, and returns whether a row matched.

**Call relations**: This is the failure counterpart to the stage-1 success methods. Future calls to `MemoryStore::try_claim_stage1_job` read the retry fields it writes.

*Call graph*: 4 external calls (now, as_str, to_string, query).


##### `MemoryStore::enqueue_global_consolidation`  (lines 1022–1024)

```
async fn enqueue_global_consolidation(&self, input_watermark: i64) -> anyhow::Result<()>
```

**Purpose**: Schedules or refreshes the single global memory consolidation job. Callers use it when stage-1 outputs change or selected memory must be forgotten.

**Data flow**: It receives an input watermark, passes the store's memory database executor to the helper, and returns success or an error.

**Call relations**: `MemoryStore::mark_thread_memory_mode_polluted` calls this. It delegates the database upsert to `enqueue_global_consolidation_with_executor`.

*Call graph*: calls 1 internal fn (enqueue_global_consolidation_with_executor); called by 1 (mark_thread_memory_mode_polluted).


##### `MemoryStore::try_claim_global_phase2_job`  (lines 1039–1169)

```
async fn try_claim_global_phase2_job(
        &self,
        worker_id: ThreadId,
        lease_seconds: i64,
    ) -> anyhow::Result<Phase2JobClaimOutcome>
```

**Purpose**: Tries to reserve the one global consolidation job for a worker. It acts like a lock so only one worker rebuilds global memory at a time.

**Data flow**: It receives a worker ID and lease length. It reads or creates the singleton global job row, checks retry delay, active lease, and recent-success cooldown, then writes a running lease with an ownership token if allowed. It returns claimed information or a skip reason.

**Call relations**: Callers use this before doing phase-2 work. Success, heartbeat, and failure methods later rely on the ownership token created here.

*Call graph*: 5 external calls (now, new_v4, as_str, to_string, query).


##### `MemoryStore::heartbeat_global_phase2_job`  (lines 1176–1200)

```
async fn heartbeat_global_phase2_job(
        &self,
        ownership_token: &str,
        lease_seconds: i64,
    ) -> anyhow::Result<bool>
```

**Purpose**: Extends the lease for a running global consolidation job. This lets a long-running worker say, in effect, 'I am still alive.'

**Data flow**: It receives an ownership token and lease length. It computes a new lease expiry time and updates the singleton global job only if the token still owns a running job. It returns whether the lease was extended.

**Call relations**: This fits between claiming and finishing phase 2. It protects the job from being taken over while a legitimate worker is still progressing.

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

**Purpose**: Finishes the owned global consolidation job and records exactly which stage-1 snapshots were used. This creates the baseline for later forgetting and cleanup decisions.

**Data flow**: It receives an ownership token, completed watermark, and selected outputs. It marks the job done, clears all previous selection flags, marks only the matching selected snapshots, and returns whether the owned job was finalized.

**Call relations**: It calls `mark_global_phase2_job_succeeded_row` for the job-row update, then updates `stage1_outputs` selection markers in the same transaction.

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

**Purpose**: Records that the owned global consolidation job failed and schedules a retry. It is the normal failure path when the worker still owns the job.

**Data flow**: It receives an ownership token, failure reason, and retry delay. It updates the singleton job only if the token matches a running row, clears the lease, stores the error, reduces retries without going below zero, and returns whether it matched.

**Call relations**: Future calls to `MemoryStore::try_claim_global_phase2_job` read the retry time and may temporarily skip the job.

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

**Purpose**: Provides a fallback way to mark global consolidation failed when ownership was lost or cleared. It helps recover a stuck running job.

**Data flow**: It receives an ownership token, failure reason, and retry delay. It applies the same failure update as the strict method, but also matches a running row with no ownership token. It returns whether it changed the job.

**Call relations**: This mirrors `MemoryStore::mark_global_phase2_job_failed` but is looser for recovery situations, such as an unowned running row.

*Call graph*: 2 external calls (now, query).


##### `mark_global_phase2_job_succeeded_row`  (lines 1346–1378)

```
async fn mark_global_phase2_job_succeeded_row(
    executor: E,
    ownership_token: &str,
    completed_watermark: i64,
) -> anyhow::Result<u64>
```

**Purpose**: Updates the singleton global job row to say phase 2 succeeded. It is a small helper so the job-row update can be reused inside a larger transaction.

**Data flow**: It receives a database executor, ownership token, and completed watermark. It marks the matching running global job done, clears lease and error fields, advances the success watermark, and returns the number of rows changed.

**Call relations**: `MemoryStore::mark_global_phase2_job_succeeded` calls this before it rewrites the selected stage-1 snapshot markers.

*Call graph*: called by 1 (mark_global_phase2_job_succeeded); 2 external calls (now, query).


##### `clear_memory_data_in_pool`  (lines 1380–1404)

```
async fn clear_memory_data_in_pool(pool: &SqlitePool) -> anyhow::Result<()>
```

**Purpose**: Deletes all memory outputs and memory-related job rows from a given memory database pool. It is the shared low-level reset helper.

**Data flow**: It receives a SQLite pool, opens a transaction, deletes all `stage1_outputs`, deletes stage-1 and phase-2 memory jobs, commits, and returns success or an error.

**Call relations**: `MemoryStore::clear_memory_data` calls this, and another SQLite-home clearing path can also call it directly.

*Call graph*: called by 2 (clear_memory_data_in_sqlite_home, clear_memory_data); 2 external calls (begin, query).


##### `stage1_output_from_row_and_thread`  (lines 1406–1425)

```
fn stage1_output_from_row_and_thread(
    row: &sqlx::sqlite::SqliteRow,
    thread: ThreadMetadata,
) -> anyhow::Result<Stage1Output>
```

**Purpose**: Combines a memory-output database row with thread metadata into a `Stage1Output` object. This turns raw database fields into the shape used by consolidation code.

**Data flow**: It receives a SQLite row and `ThreadMetadata`. It reads timestamps and memory text from the row, converts timestamp numbers into date-time values, copies workspace and branch data from the thread, and returns a `Stage1Output`.

**Call relations**: `MemoryStore::stage1_output_from_row_if_thread_enabled` calls this after it has confirmed the thread may be used.

*Call graph*: calls 1 internal fn (datetime_from_epoch_seconds); called by 1 (stage1_output_from_row_if_thread_enabled); 1 external calls (try_get).


##### `datetime_from_epoch_seconds`  (lines 1427–1430)

```
fn datetime_from_epoch_seconds(secs: i64) -> anyhow::Result<DateTime<Utc>>
```

**Purpose**: Converts a Unix timestamp in seconds into a date-time value. It catches impossible timestamp values instead of silently accepting them.

**Data flow**: It receives an integer second count, asks the date-time library to convert it, and returns either the date-time or an error saying the timestamp was invalid.

**Call relations**: `stage1_output_from_row_and_thread` calls this for both the source update time and the generation time.

*Call graph*: called by 1 (stage1_output_from_row_and_thread); 1 external calls (from_timestamp).


##### `enqueue_global_consolidation_with_executor`  (lines 1432–1481)

```
async fn enqueue_global_consolidation_with_executor(
    executor: E,
    input_watermark: i64,
) -> anyhow::Result<()>
```

**Purpose**: Creates or updates the singleton phase-2 job row that tells the system global memory consolidation should run. It works with either a plain pool or an active transaction.

**Data flow**: It receives a database executor and watermark. It inserts a pending global job if missing, or updates the existing row while preserving a running job, refreshing retries, and advancing the bookkeeping watermark. It returns success or an error.

**Call relations**: `MemoryStore::delete_thread_memory`, `MemoryStore::enqueue_global_consolidation`, `MemoryStore::mark_stage1_job_succeeded`, and `MemoryStore::mark_stage1_job_succeeded_no_output` call this whenever global memory may need to change.

*Call graph*: called by 4 (delete_thread_memory, enqueue_global_consolidation, mark_stage1_job_succeeded, mark_stage1_job_succeeded_no_output); 1 external calls (query).


##### `StateRuntime::clear_memory_data`  (lines 1485–1487)

```
async fn clear_memory_data(&self) -> anyhow::Result<()>
```

**Purpose**: Test-only convenience wrapper for clearing memory data through the full runtime. It lets tests call the runtime instead of reaching into `MemoryStore` directly.

**Data flow**: It receives the runtime, forwards the call to its `memories` store, and returns the same success or error.

**Call relations**: This wrapper exists inside the test configuration and mirrors `MemoryStore::clear_memory_data` for test code.


##### `StateRuntime::record_stage1_output_usage`  (lines 1489–1491)

```
async fn record_stage1_output_usage(&self, thread_ids: &[ThreadId]) -> anyhow::Result<usize>
```

**Purpose**: Test-only wrapper for recording usage of stage-1 outputs through `StateRuntime`.

**Data flow**: It receives thread IDs, forwards them to the memory store, and returns the count of updated output rows.

**Call relations**: Tests use this runtime-level shape while the real work remains in `MemoryStore::record_stage1_output_usage`.


##### `StateRuntime::claim_stage1_jobs_for_startup`  (lines 1493–1501)

```
async fn claim_stage1_jobs_for_startup(
        &self,
        current_thread_id: ThreadId,
        params: Stage1StartupClaimParams<'_>,
    ) -> anyhow::Result<Vec<Stage1JobClaim>>
```

**Purpose**: Test-only wrapper for claiming startup stage-1 jobs through the full runtime.

**Data flow**: It receives the current thread ID and startup claim parameters, forwards them to `MemoryStore`, and returns the claimed jobs.

**Call relations**: This mirrors `MemoryStore::claim_stage1_jobs_for_startup` so tests can exercise the same public runtime style as other state operations.


##### `StateRuntime::list_stage1_outputs_for_global`  (lines 1503–1505)

```
async fn list_stage1_outputs_for_global(&self, n: usize) -> anyhow::Result<Vec<Stage1Output>>
```

**Purpose**: Test-only wrapper for listing stage-1 outputs through `StateRuntime`.

**Data flow**: It receives a maximum count, forwards it to the memory store, and returns the visible outputs.

**Call relations**: It exposes `MemoryStore::list_stage1_outputs_for_global` to tests without changing the production API surface.


##### `StateRuntime::prune_stage1_outputs_for_retention`  (lines 1507–1515)

```
async fn prune_stage1_outputs_for_retention(
        &self,
        max_unused_days: i64,
        limit: usize,
    ) -> anyhow::Result<usize>
```

**Purpose**: Test-only wrapper for pruning old stage-1 outputs.

**Data flow**: It receives an age limit and batch limit, forwards them to `MemoryStore`, and returns how many rows were deleted.

**Call relations**: Tests call this wrapper to verify the retention behavior implemented in `MemoryStore::prune_stage1_outputs_for_retention`.


##### `StateRuntime::get_phase2_input_selection`  (lines 1517–1525)

```
async fn get_phase2_input_selection(
        &self,
        n: usize,
        max_unused_days: i64,
    ) -> anyhow::Result<Vec<Stage1Output>>
```

**Purpose**: Test-only wrapper for loading the current phase-2 input selection.

**Data flow**: It receives the desired count and max-unused age, forwards them to `MemoryStore`, and returns selected `Stage1Output` records.

**Call relations**: It gives tests a runtime-level route into `MemoryStore::get_phase2_input_selection`.


##### `StateRuntime::mark_thread_memory_mode_polluted`  (lines 1527–1531)

```
async fn mark_thread_memory_mode_polluted(&self, thread_id: ThreadId) -> anyhow::Result<bool>
```

**Purpose**: Test-only wrapper for marking a thread's memory mode as polluted.

**Data flow**: It receives a thread ID, forwards it to the memory store, and returns whether the thread changed state.

**Call relations**: Tests use this to verify the behavior of `MemoryStore::mark_thread_memory_mode_polluted` through the runtime.


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

**Purpose**: Test-only wrapper for trying to reserve a stage-1 job.

**Data flow**: It receives thread, worker, timestamp, lease, and running-cap inputs, forwards them to `MemoryStore`, and returns the claim outcome.

**Call relations**: Many tests use this to set up or check stage-1 job ownership while exercising `MemoryStore::try_claim_stage1_job`.


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

**Purpose**: Test-only wrapper for completing a stage-1 job that produced output.

**Data flow**: It receives the same completion details as the memory store method, forwards them, and returns whether finalization matched the owned job.

**Call relations**: Tests use this wrapper after `StateRuntime::try_claim_stage1_job` to verify success paths.


##### `StateRuntime::mark_stage1_job_succeeded_no_output`  (lines 1573–1581)

```
async fn mark_stage1_job_succeeded_no_output(
        &self,
        thread_id: ThreadId,
        ownership_token: &str,
    ) -> anyhow::Result<bool>
```

**Purpose**: Test-only wrapper for completing a stage-1 job that produced no saved memory.

**Data flow**: It receives a thread ID and ownership token, forwards them to the memory store, and returns whether the job was finalized.

**Call relations**: Tests call this to exercise `MemoryStore::mark_stage1_job_succeeded_no_output` through the runtime.


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

**Purpose**: Test-only wrapper for recording a failed stage-1 job.

**Data flow**: It receives a thread ID, ownership token, failure reason, and retry delay, forwards them to the memory store, and returns whether a running owned job was updated.

**Call relations**: Tests use this to drive retry and exhaustion scenarios implemented by `MemoryStore::mark_stage1_job_failed`.


##### `StateRuntime::enqueue_global_consolidation`  (lines 1600–1604)

```
async fn enqueue_global_consolidation(&self, input_watermark: i64) -> anyhow::Result<()>
```

**Purpose**: Test-only wrapper for scheduling global consolidation.

**Data flow**: It receives a watermark, forwards it to the memory store, and returns success or an error.

**Call relations**: Tests use this wrapper to create or advance the singleton phase-2 job via `MemoryStore::enqueue_global_consolidation`.


##### `StateRuntime::try_claim_global_phase2_job`  (lines 1606–1614)

```
async fn try_claim_global_phase2_job(
        &self,
        worker_id: ThreadId,
        lease_seconds: i64,
    ) -> anyhow::Result<Phase2JobClaimOutcome>
```

**Purpose**: Test-only wrapper for trying to reserve the global phase-2 job.

**Data flow**: It receives a worker ID and lease length, forwards them to the memory store, and returns the phase-2 claim outcome.

**Call relations**: Tests use it before calling the phase-2 success or failure wrappers.


##### `StateRuntime::mark_global_phase2_job_succeeded`  (lines 1616–1629)

```
async fn mark_global_phase2_job_succeeded(
        &self,
        ownership_token: &str,
        completed_watermark: i64,
        selected_outputs: &[Stage1Output],
    ) -> anyhow::Result<bool>
```

**Purpose**: Test-only wrapper for finishing the global consolidation job successfully.

**Data flow**: It receives an ownership token, completed watermark, and selected outputs, forwards them to the memory store, and returns whether finalization succeeded.

**Call relations**: Tests use this to verify both job completion and selected snapshot bookkeeping in `MemoryStore::mark_global_phase2_job_succeeded`.


##### `StateRuntime::mark_global_phase2_job_failed`  (lines 1631–1640)

```
async fn mark_global_phase2_job_failed(
        &self,
        ownership_token: &str,
        failure_reason: &str,
        retry_delay_seconds: i64,
    ) -> anyhow::Result<bool>
```

**Purpose**: Test-only wrapper for marking global consolidation failed with strict ownership.

**Data flow**: It receives an ownership token, reason, and retry delay, forwards them to the memory store, and returns whether the owned running job was updated.

**Call relations**: Tests use it to verify retry behavior implemented by `MemoryStore::mark_global_phase2_job_failed`.


##### `StateRuntime::mark_global_phase2_job_failed_if_unowned`  (lines 1642–1655)

```
async fn mark_global_phase2_job_failed_if_unowned(
        &self,
        ownership_token: &str,
        failure_reason: &str,
        retry_delay_seconds: i64,
    ) -> anyhow::Result<bool>
```

**Purpose**: Test-only wrapper for the fallback failure path that can recover an unowned running phase-2 job.

**Data flow**: It receives an ownership token, reason, and retry delay, forwards them to the memory store, and returns whether the fallback update worked.

**Call relations**: Tests use this to exercise `MemoryStore::mark_global_phase2_job_failed_if_unowned`.


##### `tests::stable_thread_id`  (lines 1678–1680)

```
fn stable_thread_id(value: &str) -> ThreadId
```

**Purpose**: Creates a predictable thread ID from a string for tests. Stable IDs make ordering assertions easier to read and repeat.

**Data flow**: It receives a string, parses it as a `ThreadId`, and returns the ID or fails the test if parsing is invalid.

**Call relations**: Several selection-ranking tests call this helper when they need deterministic thread ID order.

*Call graph*: calls 1 internal fn (from_string).


##### `tests::memory_pool`  (lines 1682–1684)

```
fn memory_pool(runtime: &StateRuntime) -> &sqlx::SqlitePool
```

**Purpose**: Gives tests direct access to the memory database pool. This is used for setup and assertions that inspect raw rows.

**Data flow**: It receives a runtime, reads its memory store, and returns a reference to the memory SQLite pool.

**Call relations**: Test helpers and test cases call this when they need direct SQL checks alongside runtime-level operations.

*Call graph*: calls 1 internal fn (memories).


##### `tests::age_phase2_success_beyond_cooldown`  (lines 1686–1694)

```
async fn age_phase2_success_beyond_cooldown(runtime: &StateRuntime)
```

**Purpose**: Moves the recorded phase-2 success time far enough into the past that the cooldown no longer blocks claims. It is a test helper for repeated consolidation runs.

**Data flow**: It receives a runtime, computes an old timestamp, and updates the global phase-2 job row in the memory database.

**Call relations**: Cooldown-related tests call this helper before attempting another global phase-2 claim.

*Call graph*: 3 external calls (now, query, memory_pool).


##### `tests::stage1_claim_skips_when_up_to_date`  (lines 1697–1762)

```
async fn stage1_claim_skips_when_up_to_date()
```

**Purpose**: Checks that stage-1 extraction is not claimed again when saved memory already matches the thread's source timestamp.

**Data flow**: The test creates a runtime and thread, claims and completes a stage-1 job, then tries claims at the same and newer timestamps. It expects the same timestamp to skip and the newer one to claim.

**Call relations**: It exercises the claim and success flow around `try_claim_stage1_job` and `mark_stage1_job_succeeded`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 5 external calls (new_v4, assert!, assert_eq!, panic!, remove_dir_all).


##### `tests::stage1_running_stale_can_be_stolen_but_fresh_running_is_skipped`  (lines 1765–1817)

```
async fn stage1_running_stale_can_be_stolen_but_fresh_running_is_skipped()
```

**Purpose**: Verifies that an active stage-1 lease blocks another worker, but an expired lease can be taken over.

**Data flow**: The test claims a job, confirms a second fresh claim is skipped, manually expires the lease in SQL, and confirms the second worker can then claim it.

**Call relations**: It focuses on the lease checks inside `try_claim_stage1_job`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 6 external calls (new_v4, assert!, assert_eq!, query, memory_pool, remove_dir_all).


##### `tests::stage1_concurrent_claim_for_same_thread_is_conflict_safe`  (lines 1820–1885)

```
async fn stage1_concurrent_claim_for_same_thread_is_conflict_safe()
```

**Purpose**: Makes sure two simultaneous workers cannot both claim the same stage-1 job.

**Data flow**: The test starts two claim attempts for one thread at the same time and counts the outcomes. Exactly one should claim, while the other should see the job as running.

**Call relations**: It stress-tests the transaction behavior of `try_claim_stage1_job`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 7 external calls (clone, new_v4, assert!, assert_eq!, remove_dir_all, join!, vec!).


##### `tests::stage1_concurrent_claims_respect_running_cap`  (lines 1888–1953)

```
async fn stage1_concurrent_claims_respect_running_cap()
```

**Purpose**: Checks that the global limit on running stage-1 jobs is respected even under concurrent claims for different threads.

**Data flow**: The test creates two threads and tries to claim both with a running cap of one. It expects one claim to succeed and one to be throttled.

**Call relations**: It verifies the running-job cap enforced by `try_claim_stage1_job`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 7 external calls (clone, new_v4, assert!, assert_eq!, remove_dir_all, join!, vec!).


##### `tests::claim_stage1_jobs_filters_by_age_idle_and_current_thread`  (lines 1956–2043)

```
async fn claim_stage1_jobs_filters_by_age_idle_and_current_thread()
```

**Purpose**: Checks that startup claiming only selects threads in the intended age and idle window, and never selects the current thread.

**Data flow**: The test creates current, too-fresh, barely-not-idle, eligible, and too-old threads, then runs startup claiming. Only the eligible idle thread should be returned.

**Call relations**: It exercises filtering in `claim_stage1_jobs_for_startup`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 8 external calls (days, hours, minutes, now, new_v4, assert_eq!, remove_dir_all, vec!).


##### `tests::claim_stage1_jobs_bounds_state_scan_before_memory_probes`  (lines 2046–2158)

```
async fn claim_stage1_jobs_bounds_state_scan_before_memory_probes()
```

**Purpose**: Verifies that startup claiming respects the scan limit before checking memory staleness. This prevents expensive unbounded probing.

**Data flow**: The test seeds one newer up-to-date thread and one older stale thread. With a scan limit of one no job is claimed; with two, the stale thread is reached and claimed.

**Call relations**: It tests how `claim_stage1_jobs_for_startup` combines state-database scanning with `stage1_source_needs_update`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 8 external calls (hours, now, new_v4, assert!, assert_eq!, panic!, remove_dir_all, vec!).


##### `tests::claim_stage1_jobs_skips_threads_with_disabled_memory_mode`  (lines 2161–2229)

```
async fn claim_stage1_jobs_skips_threads_with_disabled_memory_mode()
```

**Purpose**: Checks that startup claiming ignores threads whose memory mode is disabled.

**Data flow**: The test creates one disabled and one enabled eligible thread, runs startup claiming, and expects only the enabled thread to be claimed.

**Call relations**: It verifies the memory-mode filter in `claim_stage1_jobs_for_startup`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 7 external calls (hours, now, new_v4, assert_eq!, query, remove_dir_all, vec!).


##### `tests::clear_memory_data_clears_rows_and_preserves_thread_memory_modes`  (lines 2232–2338)

```
async fn clear_memory_data_clears_rows_and_preserves_thread_memory_modes()
```

**Purpose**: Ensures clearing generated memory does not change each thread's memory-mode setting.

**Data flow**: The test creates memory output and a global job, disables another thread, clears memory data, then checks memory tables are empty while thread modes remain enabled or disabled as before.

**Call relations**: It covers `clear_memory_data` and the lower-level deletion helper.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 10 external calls (hours, now, new_v4, assert!, assert_eq!, panic!, query, query_scalar, memory_pool, remove_dir_all).


##### `tests::claim_stage1_jobs_enforces_global_running_cap`  (lines 2341–2465)

```
async fn claim_stage1_jobs_enforces_global_running_cap()
```

**Purpose**: Checks that startup claiming stops when the total running stage-1 job cap is reached.

**Data flow**: The test seeds existing running jobs, creates many eligible threads, runs startup claiming, and verifies the number of new claims brings the total up to but not beyond the cap.

**Call relations**: It verifies the interaction between `claim_stage1_jobs_for_startup` and `try_claim_stage1_job`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 10 external calls (hours, seconds, now, new_v4, assert_eq!, format!, query, memory_pool, remove_dir_all, vec!).


##### `tests::claim_stage1_jobs_processes_two_full_batches_across_startup_passes`  (lines 2468–2552)

```
async fn claim_stage1_jobs_processes_two_full_batches_across_startup_passes()
```

**Purpose**: Checks that startup claiming can process multiple batches over repeated passes.

**Data flow**: The test creates many eligible threads, claims a full batch, marks that batch successful, then claims a second full batch.

**Call relations**: It verifies that completed jobs become up-to-date and later startup passes move on to remaining work.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 9 external calls (hours, seconds, now, new_v4, assert!, assert_eq!, format!, remove_dir_all, vec!).


##### `tests::delete_thread_removes_stage1_output_and_enqueues_phase2_when_selected`  (lines 2555–2677)

```
async fn delete_thread_removes_stage1_output_and_enqueues_phase2_when_selected()
```

**Purpose**: Ensures deleting a thread removes its memory output and schedules global consolidation if that output had been part of the global baseline.

**Data flow**: The test creates and selects a stage-1 output, deletes the thread, then checks the output is gone and the global phase-2 job is pending.

**Call relations**: It exercises `delete_thread_memory` through the broader thread deletion path and verifies enqueue behavior.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 8 external calls (now, new_v4, assert!, assert_eq!, panic!, query, memory_pool, remove_dir_all).


##### `tests::mark_stage1_job_succeeded_no_output_skips_phase2_when_output_was_already_absent`  (lines 2680–2752)

```
async fn mark_stage1_job_succeeded_no_output_skips_phase2_when_output_was_already_absent()
```

**Purpose**: Checks that a no-output stage-1 success does not schedule global consolidation when there was no previous output to remove.

**Data flow**: The test claims a job, completes it with no output, verifies no output row exists, confirms the same source is up-to-date, and checks no phase-2 job was created.

**Call relations**: It verifies the no-change branch of `mark_stage1_job_succeeded_no_output`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 7 external calls (new_v4, assert!, assert_eq!, panic!, query, memory_pool, remove_dir_all).


##### `tests::mark_stage1_job_succeeded_no_output_enqueues_phase2_when_deleting_output`  (lines 2755–2877)

```
async fn mark_stage1_job_succeeded_no_output_enqueues_phase2_when_deleting_output()
```

**Purpose**: Checks that a no-output stage-1 success schedules global consolidation when it deletes an existing output.

**Data flow**: The test first saves output, completes phase 2, then reruns stage 1 at a newer timestamp with no output. It expects the old output to be deleted and phase 2 to become claimable with the newer watermark.

**Call relations**: It verifies the deletion-and-enqueue branch of `mark_stage1_job_succeeded_no_output`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 8 external calls (new_v4, assert!, assert_eq!, panic!, query, age_phase2_success_beyond_cooldown, memory_pool, remove_dir_all).


##### `tests::stage1_retry_exhaustion_does_not_block_newer_watermark`  (lines 2880–2973)

```
async fn stage1_retry_exhaustion_does_not_block_newer_watermark()
```

**Purpose**: Ensures a stage-1 job that exhausted retries for one source version can still run when the thread changes.

**Data flow**: The test repeatedly claims and fails the same timestamp until retries are exhausted, confirms that timestamp is skipped, then claims a newer timestamp and verifies retries reset.

**Call relations**: It exercises retry fields written by `mark_stage1_job_failed` and read by `try_claim_stage1_job`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 7 external calls (new_v4, assert!, assert_eq!, panic!, query, memory_pool, remove_dir_all).


##### `tests::phase2_global_lock_respects_success_cooldown`  (lines 2976–3035)

```
async fn phase2_global_lock_respects_success_cooldown()
```

**Purpose**: Checks that a recent successful global consolidation blocks another run for the cooldown period.

**Data flow**: The test enqueues, claims, and succeeds phase 2, then confirms another claim is skipped during cooldown even after enqueueing more work. After aging the success time, a claim succeeds.

**Call relations**: It verifies cooldown logic in `try_claim_global_phase2_job` and uses `age_phase2_success_beyond_cooldown`.

*Call graph*: calls 3 internal fn (from_string, init, unique_temp_dir); 6 external calls (new_v4, assert!, assert_eq!, panic!, age_phase2_success_beyond_cooldown, remove_dir_all).


##### `tests::phase2_global_lock_can_be_claimed_after_retry_budget_is_exhausted`  (lines 3038–3105)

```
async fn phase2_global_lock_can_be_claimed_after_retry_budget_is_exhausted()
```

**Purpose**: Checks that phase-2 retry exhaustion does not permanently block claiming the global lock.

**Data flow**: The test fails phase 2 enough times to reduce retries to zero, confirms the stored count, then claims again successfully.

**Call relations**: It verifies that `try_claim_global_phase2_job` treats phase 2 as a lock and does not use retry exhaustion as a hard stop.

*Call graph*: calls 3 internal fn (from_string, init, unique_temp_dir); 7 external calls (new_v4, assert!, assert_eq!, panic!, query, memory_pool, remove_dir_all).


##### `tests::list_stage1_outputs_for_global_returns_latest_outputs`  (lines 3108–3208)

```
async fn list_stage1_outputs_for_global_returns_latest_outputs()
```

**Purpose**: Checks that global listing returns non-empty outputs in newest order with thread metadata attached.

**Data flow**: The test creates two threads and outputs with different timestamps, then lists outputs and checks order, summaries, rollout slug, working directory, and git branch.

**Call relations**: It exercises `list_stage1_outputs_for_global` and row-to-output conversion.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 5 external calls (new_v4, assert!, assert_eq!, panic!, remove_dir_all).


##### `tests::list_stage1_outputs_for_global_skips_empty_payloads`  (lines 3211–3277)

```
async fn list_stage1_outputs_for_global_skips_empty_payloads()
```

**Purpose**: Checks that outputs with no memory text and no summary are not listed for global consolidation.

**Data flow**: The test inserts one non-empty row and one empty row directly, lists only one output, and verifies it is the non-empty one.

**Call relations**: It verifies the non-empty filter in `list_stage1_outputs_for_global`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 5 external calls (new_v4, assert_eq!, query, memory_pool, remove_dir_all).


##### `tests::list_stage1_outputs_for_global_skips_polluted_threads`  (lines 3280–3345)

```
async fn list_stage1_outputs_for_global_skips_polluted_threads()
```

**Purpose**: Checks that outputs from polluted threads are hidden from global consolidation.

**Data flow**: The test creates outputs for two threads, marks one polluted, then lists global outputs and expects only the still-enabled thread.

**Call relations**: It verifies the enabled-thread check used by `list_stage1_outputs_for_global`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 5 external calls (new_v4, assert!, assert_eq!, panic!, remove_dir_all).


##### `tests::get_phase2_input_selection_returns_current_selected_rows`  (lines 3348–3460)

```
async fn get_phase2_input_selection_returns_current_selected_rows()
```

**Purpose**: Checks the current phase-2 input selection behavior with multiple outputs.

**Data flow**: The test creates three outputs, records a phase-2 success with a selected subset, then asks for a two-row selection and checks the returned thread order and metadata.

**Call relations**: It exercises `get_phase2_input_selection` and phase-2 success selection bookkeeping.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 6 external calls (new_v4, assert!, assert_eq!, panic!, stable_thread_id, remove_dir_all).


##### `tests::get_phase2_input_selection_excludes_polluted_previous_selection`  (lines 3463–3553)

```
async fn get_phase2_input_selection_excludes_polluted_previous_selection()
```

**Purpose**: Ensures phase-2 input selection excludes a thread that later becomes polluted, even if it was previously selected.

**Data flow**: The test creates and selects two outputs, marks one thread polluted, then asks for selection and expects only the enabled thread.

**Call relations**: It verifies `get_phase2_input_selection` checks live thread memory mode through `enabled_thread_metadata`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 5 external calls (new_v4, assert!, assert_eq!, panic!, remove_dir_all).


##### `tests::mark_thread_memory_mode_polluted_enqueues_phase2_for_selected_threads`  (lines 3556–3642)

```
async fn mark_thread_memory_mode_polluted_enqueues_phase2_for_selected_threads()
```

**Purpose**: Checks that marking a selected thread polluted schedules phase 2 so global memory can forget it.

**Data flow**: The test creates an output, selects it in phase 2, marks the thread polluted, ages the cooldown, and confirms phase 2 can be claimed again.

**Call relations**: It tests `mark_thread_memory_mode_polluted` and its call to enqueue global consolidation.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 5 external calls (new_v4, assert!, panic!, age_phase2_success_beyond_cooldown, remove_dir_all).


##### `tests::mark_thread_memory_mode_polluted_enqueues_phase2_when_already_polluted`  (lines 3645–3737)

```
async fn mark_thread_memory_mode_polluted_enqueues_phase2_when_already_polluted()
```

**Purpose**: Checks that even an already polluted selected thread can still trigger phase-2 forgetting work.

**Data flow**: The test selects an output, manually marks the thread polluted, calls the polluted-marker method again, and confirms phase 2 is claimable after cooldown.

**Call relations**: It verifies the enqueue side effect of `mark_thread_memory_mode_polluted` separately from whether the thread mode changed.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 6 external calls (new_v4, assert!, panic!, query, age_phase2_success_beyond_cooldown, remove_dir_all).


##### `tests::get_phase2_input_selection_returns_regenerated_selected_rows`  (lines 3740–3856)

```
async fn get_phase2_input_selection_returns_regenerated_selected_rows()
```

**Purpose**: Checks that if a previously selected thread is regenerated, current phase-2 input uses the newer output.

**Data flow**: The test saves an output, selects it, regenerates the thread at a newer timestamp, then asks for phase-2 input and expects the newer timestamp while the old selection marker remains recorded.

**Call relations**: It tests how `mark_stage1_job_succeeded` and `get_phase2_input_selection` behave after regeneration.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 6 external calls (new_v4, assert!, assert_eq!, panic!, memory_pool, remove_dir_all).


##### `tests::get_phase2_input_selection_uses_current_ranking_after_refreshes`  (lines 3859–3999)

```
async fn get_phase2_input_selection_uses_current_ranking_after_refreshes()
```

**Purpose**: Checks that phase-2 selection ranking is based on current outputs, not only the previous phase-2 baseline.

**Data flow**: The test creates four outputs, selects the top two, refreshes three outputs with newer timestamps, then asks for two selections and expects the newest current candidates.

**Call relations**: It verifies ranking logic in `get_phase2_input_selection` after stage-1 refreshes.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 6 external calls (new_v4, assert!, assert_eq!, panic!, stable_thread_id, remove_dir_all).


##### `tests::mark_global_phase2_job_succeeded_updates_selected_snapshot_timestamp`  (lines 4002–4149)

```
async fn mark_global_phase2_job_succeeded_updates_selected_snapshot_timestamp()
```

**Purpose**: Checks that phase-2 success records the exact source timestamp of selected snapshots.

**Data flow**: The test selects an initial output, refreshes it, runs phase 2 again after cooldown, and verifies the stored selected snapshot timestamp updates to the newer source timestamp.

**Call relations**: It verifies selection-marker updates in `mark_global_phase2_job_succeeded`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 7 external calls (new_v4, assert!, assert_eq!, panic!, age_phase2_success_beyond_cooldown, memory_pool, remove_dir_all).


##### `tests::mark_global_phase2_job_succeeded_only_marks_exact_selected_snapshots`  (lines 4152–4269)

```
async fn mark_global_phase2_job_succeeded_only_marks_exact_selected_snapshots()
```

**Purpose**: Ensures phase-2 success does not mark a row selected if the row changed after the selection was prepared.

**Data flow**: The test prepares selected outputs at timestamp 100, refreshes the same thread to 101 before finalizing phase 2, then checks the row is not marked selected for the old snapshot.

**Call relations**: It verifies the exact timestamp match used by `mark_global_phase2_job_succeeded`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 6 external calls (new_v4, assert!, assert_eq!, panic!, memory_pool, remove_dir_all).


##### `tests::record_stage1_output_usage_updates_usage_metadata`  (lines 4272–4388)

```
async fn record_stage1_output_usage_updates_usage_metadata()
```

**Purpose**: Checks that usage recording increments counts and sets a shared last-used time.

**Data flow**: The test creates outputs for two threads, records usage with duplicate IDs and a missing ID, then reads raw rows to confirm counts and last-usage timestamps.

**Call relations**: It exercises `record_stage1_output_usage` and confirms missing rows are ignored.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 7 external calls (new_v4, assert!, assert_eq!, panic!, query, memory_pool, remove_dir_all).


##### `tests::get_phase2_input_selection_prioritizes_usage_count_then_recent_usage`  (lines 4391–4484)

```
async fn get_phase2_input_selection_prioritizes_usage_count_then_recent_usage()
```

**Purpose**: Checks that phase-2 selection prefers higher usage count, then more recent usage.

**Data flow**: The test creates three outputs, manually sets usage counts and last-used times, asks for one selected output, and expects the frequently and recently used row.

**Call relations**: It verifies the ranking order in `get_phase2_input_selection`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 11 external calls (days, hours, now, new_v4, assert!, assert_eq!, panic!, query, memory_pool, stable_thread_id (+1 more)).


##### `tests::get_phase2_input_selection_excludes_stale_used_memories_but_keeps_fresh_never_used`  (lines 4487–4580)

```
async fn get_phase2_input_selection_excludes_stale_used_memories_but_keeps_fresh_never_used()
```

**Purpose**: Checks retention-style freshness rules for phase-2 input selection.

**Data flow**: The test creates old and fresh outputs with different usage metadata, then selects with a 30-day window. It expects stale used memory to be excluded, fresh never-used memory to remain, and recently used old memory to remain.

**Call relations**: It verifies the age filters inside `get_phase2_input_selection`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 10 external calls (days, now, new_v4, assert!, assert_eq!, panic!, query, memory_pool, stable_thread_id, remove_dir_all).


##### `tests::get_phase2_input_selection_prefers_recent_thread_updates_over_recent_generation`  (lines 4583–4666)

```
async fn get_phase2_input_selection_prefers_recent_thread_updates_over_recent_generation()
```

**Purpose**: Checks that selection ranking uses the source thread update time, not merely when memory was generated.

**Data flow**: The test creates two outputs, manually makes the older source look more recently generated, and confirms the newer source timestamp still wins.

**Call relations**: It verifies the source-updated ordering used by `get_phase2_input_selection`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 7 external calls (new_v4, assert!, assert_eq!, panic!, query, memory_pool, remove_dir_all).


##### `tests::prune_stage1_outputs_for_retention_prunes_stale_unselected_rows_only`  (lines 4669–4808)

```
async fn prune_stage1_outputs_for_retention_prunes_stale_unselected_rows_only()
```

**Purpose**: Checks that retention cleanup deletes stale unselected outputs but keeps selected or fresh outputs.

**Data flow**: The test creates stale unused, stale used, stale selected, and fresh used outputs, runs pruning, then checks only the appropriate stale unselected rows were removed and stage-1 job rows were preserved.

**Call relations**: It exercises `prune_stage1_outputs_for_retention` and its rule to preserve phase-2 baseline rows.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 10 external calls (days, now, new_v4, assert!, assert_eq!, panic!, query, memory_pool, remove_dir_all, vec!).


##### `tests::prune_stage1_outputs_for_retention_respects_batch_limit`  (lines 4811–4886)

```
async fn prune_stage1_outputs_for_retention_respects_batch_limit()
```

**Purpose**: Checks that pruning deletes no more than the requested batch limit.

**Data flow**: The test creates three stale outputs, prunes with a limit of two, and verifies one output remains.

**Call relations**: It verifies the `limit` argument in `prune_stage1_outputs_for_retention`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 9 external calls (days, now, new_v4, assert!, assert_eq!, panic!, query_scalar, memory_pool, remove_dir_all).


##### `tests::mark_stage1_job_succeeded_enqueues_global_consolidation`  (lines 4889–4981)

```
async fn mark_stage1_job_succeeded_enqueues_global_consolidation()
```

**Purpose**: Checks that saving stage-1 outputs schedules global consolidation and advances its watermark to the latest source.

**Data flow**: The test completes two stage-1 jobs at timestamps 100 and 101, claims phase 2, and expects the phase-2 input watermark to be 101.

**Call relations**: It verifies the enqueue call inside `mark_stage1_job_succeeded`.

*Call graph*: calls 4 internal fn (from_string, init, test_thread_metadata, unique_temp_dir); 5 external calls (new_v4, assert!, assert_eq!, panic!, remove_dir_all).


##### `tests::phase2_global_lock_allows_only_one_fresh_runner`  (lines 4984–5014)

```
async fn phase2_global_lock_allows_only_one_fresh_runner()
```

**Purpose**: Checks that only one worker can hold the global phase-2 lock while its lease is fresh.

**Data flow**: The test enqueues phase 2, lets one owner claim it, then confirms a second owner is skipped as running.

**Call relations**: It exercises the active-lease branch of `try_claim_global_phase2_job`.

*Call graph*: calls 3 internal fn (from_string, init, unique_temp_dir); 4 external calls (new_v4, assert!, assert_eq!, remove_dir_all).


##### `tests::phase2_global_lock_creates_missing_job_row`  (lines 5017–5064)

```
async fn phase2_global_lock_creates_missing_job_row()
```

**Purpose**: Checks that claiming phase 2 works even if the singleton job row does not exist yet.

**Data flow**: The test claims phase 2 with no prior enqueue, confirms the input watermark starts at zero, verifies a second claim is blocked, marks success, and confirms cooldown blocks an immediate new claim.

**Call relations**: It verifies the row-creation path in `try_claim_global_phase2_job`.

*Call graph*: calls 3 internal fn (from_string, init, unique_temp_dir); 5 external calls (new_v4, assert!, assert_eq!, panic!, remove_dir_all).


##### `tests::phase2_global_lock_stale_lease_allows_takeover`  (lines 5067–5139)

```
async fn phase2_global_lock_stale_lease_allows_takeover()
```

**Purpose**: Checks that an expired phase-2 lease can be taken over and the old owner can no longer finish the job.

**Data flow**: The test claims phase 2, manually expires the lease, claims with another owner, then verifies the old token cannot mark success while the new token can.

**Call relations**: It tests lease takeover in `try_claim_global_phase2_job` and ownership checks in `mark_global_phase2_job_succeeded`.

*Call graph*: calls 3 internal fn (from_string, init, unique_temp_dir); 9 external calls (now, new_v4, assert!, assert_eq!, assert_ne!, panic!, query, memory_pool, remove_dir_all).


##### `tests::enqueue_global_consolidation_keeps_phase2_input_watermark_monotonic`  (lines 5142–5203)

```
async fn enqueue_global_consolidation_keeps_phase2_input_watermark_monotonic()
```

**Purpose**: Checks that enqueueing global consolidation with an older watermark still advances bookkeeping enough to signal new work.

**Data flow**: The test enqueues and completes watermark 500, then enqueues watermark 400, ages cooldown, claims again, and expects the stored input watermark to be greater than 500.

**Call relations**: It verifies the monotonic update behavior in `enqueue_global_consolidation_with_executor`.

*Call graph*: calls 3 internal fn (from_string, init, unique_temp_dir); 6 external calls (new_v4, assert!, assert_eq!, panic!, age_phase2_success_beyond_cooldown, remove_dir_all).


##### `tests::phase2_failure_fallback_updates_unowned_running_job`  (lines 5206–5267)

```
async fn phase2_failure_fallback_updates_unowned_running_job()
```

**Purpose**: Checks that the fallback failure method can recover a running phase-2 job whose ownership token was cleared.

**Data flow**: The test claims phase 2, manually clears the ownership token, confirms strict failure marking does not match, then uses the fallback method and verifies later claims are blocked by retry delay.

**Call relations**: It compares `mark_global_phase2_job_failed` with `mark_global_phase2_job_failed_if_unowned`.

*Call graph*: calls 4 internal fn (from_string, new, init, unique_temp_dir); 7 external calls (new_v4, assert!, assert_eq!, panic!, query, memory_pool, remove_dir_all).


### Job and backfill state
These files define and persist operational workflow state for agent jobs and the singleton rollout-metadata backfill worker.

### `state/src/model/agent_job.rs`

`data_model` · `cross-cutting, especially when reading or writing agent job state`

An agent job appears to be a batch of work: a CSV file is read, each row becomes an item, and an agent processes those items. This file is the shared vocabulary for that feature. It says what a job contains, what an item contains, and what states they can be in, such as pending, running, completed, failed, or cancelled.

The important job of this file is to keep messy stored data from leaking into the rest of the program. Databases often store values in simple forms: text for statuses, integers for yes/no flags, integer Unix timestamps for dates, and strings for JSON. The public structs, such as AgentJob and AgentJobItem, use clearer types instead: booleans, parsed JSON values, real date-time objects, and enums. An enum is a fixed list of allowed choices, like a traffic light that can only be red, yellow, or green.

The two internal row structs, AgentJobRow and AgentJobItemRow, match what comes back from the database. Their conversion functions check and transform those raw rows into the safer public structs. If a status string is unknown, a timestamp is invalid, or JSON text cannot be parsed, the conversion returns an error instead of creating a misleading object. Without this file, other code would have to repeat these checks everywhere and would be more likely to mishandle corrupted or unexpected stored data.

#### Function details

##### `AgentJobStatus::as_str`  (lines 16–24)

```
fn as_str(self) -> &'static str
```

**Purpose**: Turns a job status into the exact lowercase text used outside the Rust enum, such as in a database or API response. This gives the project one consistent spelling for each status.

**Data flow**: It starts with an AgentJobStatus value, such as Pending or Failed. It matches that value to its stored text form. It returns a static string like "pending" or "failed" and does not change anything else.

**Call relations**: This is the outward-facing companion to AgentJobStatus::parse. Code that needs to save or display a job status can ask this function for the stable text form, while parsing code uses AgentJobStatus::parse to come back from text into the enum.


##### `AgentJobStatus::parse`  (lines 26–35)

```
fn parse(value: &str) -> Result<Self>
```

**Purpose**: Turns stored or received text into a valid AgentJobStatus. It protects the rest of the program from unknown status words by returning an error instead of guessing.

**Data flow**: It receives a string like "running". It compares the string with the allowed job status names. If it recognizes the value, it returns the matching enum value; if not, it returns an error explaining that the status is invalid.

**Call relations**: AgentJob::try_from calls this while converting a database row into an AgentJob, so bad stored status text stops at the boundary. is_agent_job_cancelled also calls it when it needs to interpret stored status text before deciding whether a job has been cancelled.

*Call graph*: called by 2 (try_from, is_agent_job_cancelled); 1 external calls (anyhow!).


##### `AgentJobStatus::is_final`  (lines 37–42)

```
fn is_final(self) -> bool
```

**Purpose**: Answers whether a job has reached an ending state. Completed, failed, and cancelled jobs are final; pending and running jobs are not.

**Data flow**: It receives one AgentJobStatus value. It checks whether that value is one of the known finished states. It returns true for completed, failed, or cancelled, and false otherwise.

**Call relations**: This is a small decision helper for higher-level job flow. Other code can use it when it needs to know whether work should stop changing state, whether cleanup can happen, or whether progress should be treated as finished.

*Call graph*: 1 external calls (matches!).


##### `AgentJobItemStatus::as_str`  (lines 54–61)

```
fn as_str(self) -> &'static str
```

**Purpose**: Turns an individual job item’s status into the exact lowercase text form used for storage or communication. It keeps item status spelling consistent across the system.

**Data flow**: It starts with an AgentJobItemStatus value, such as Running or Completed. It maps that value to a fixed string. It returns text like "running" or "completed" without changing any state.

**Call relations**: This mirrors AgentJobItemStatus::parse in the opposite direction. When code needs to write or show an item status, this function provides the canonical text; when reading text back, AgentJobItemStatus::parse restores the enum.


##### `AgentJobItemStatus::parse`  (lines 63–71)

```
fn parse(value: &str) -> Result<Self>
```

**Purpose**: Turns text into a valid status for one item inside a job. It rejects unknown words so an item cannot silently enter an impossible state.

**Data flow**: It receives a string such as "pending" or "failed". It checks that string against the allowed item statuses. It returns the matching AgentJobItemStatus, or an error if the text is not recognized.

**Call relations**: AgentJobItem::try_from calls this during database row conversion. That means raw database text is checked before the rest of the program sees the item as a normal AgentJobItem.

*Call graph*: called by 1 (try_from); 1 external calls (anyhow!).


##### `AgentJob::try_from`  (lines 164–199)

```
fn try_from(value: AgentJobRow) -> Result<Self, Self::Error>
```

**Purpose**: Converts a raw database row for a job into the safer AgentJob struct used by application code. It performs the cleanup and validation needed at the storage boundary.

**Data flow**: It receives an AgentJobRow, where some fields are plain strings or integers because that is how they are stored. It parses JSON fields, converts the status string into an AgentJobStatus, turns integer timestamps into date-time values, changes the integer auto_export flag into a true-or-false value, and checks that max_runtime_seconds can safely become an unsigned number. It returns a complete AgentJob if every conversion succeeds, or an error if any stored value is malformed.

**Call relations**: This function sits between database access code and the rest of the application. When a stored job is loaded, this conversion calls AgentJobStatus::parse for the job state, serde_json parsing for JSON text, and epoch_seconds_to_datetime for timestamps before handing back a clean AgentJob.

*Call graph*: calls 2 internal fn (parse, epoch_seconds_to_datetime); 1 external calls (from_str).


##### `AgentJobItem::try_from`  (lines 223–250)

```
fn try_from(value: AgentJobItemRow) -> Result<Self, Self::Error>
```

**Purpose**: Converts a raw database row for one job item into the safer AgentJobItem struct. It makes sure row data, result data, status, and times are all valid before the item is used.

**Data flow**: It receives an AgentJobItemRow from storage. It parses the row_json text into JSON data, parses optional result_json when present, converts the status string into an AgentJobItemStatus, and changes timestamp numbers into date-time values. It returns a usable AgentJobItem, or an error if any JSON, status, or timestamp value is invalid.

**Call relations**: This is the item-level version of AgentJob::try_from. Database loading code can rely on it to turn raw stored item rows into application objects, while it delegates status checking to AgentJobItemStatus::parse and time conversion to epoch_seconds_to_datetime.

*Call graph*: calls 2 internal fn (parse, epoch_seconds_to_datetime); 1 external calls (from_str).


##### `epoch_seconds_to_datetime`  (lines 253–256)

```
fn epoch_seconds_to_datetime(secs: i64) -> Result<DateTime<Utc>>
```

**Purpose**: Turns a Unix timestamp into a proper UTC date-time value. A Unix timestamp is a count of seconds since January 1, 1970, which is convenient for storage but not as clear for application code.

**Data flow**: It receives an integer number of seconds. It asks the date-time library to build a UTC DateTime from that number. It returns the DateTime if the number is valid, or an error if the timestamp cannot represent a real date-time.

**Call relations**: AgentJob::try_from and AgentJobItem::try_from both call this helper while translating database rows. It keeps timestamp validation in one place so job and item conversions treat stored times the same way.

*Call graph*: called by 2 (try_from, try_from); 1 external calls (from_timestamp).


### `state/src/runtime/agent_jobs.rs`

`domain_logic` · `job creation and job/item status updates during agent work`

An agent job is a batch of work, and each job has smaller items, like rows in a spreadsheet that need to be processed one by one. This file gives `StateRuntime` the methods needed to store those jobs in SQLite, update their status over time, and read back progress. Without it, the system would have no reliable memory of which jobs were pending, running, completed, failed, or cancelled.

The file starts by creating a job and all of its items together inside a transaction. A transaction is like filling out several forms as one packet: either every form is saved, or none of them are. That prevents half-created jobs. It then provides lookup methods for jobs and items, plus list and progress methods for showing what remains.

Most of the file is careful status-changing code. Jobs can move to running, completed, failed, or cancelled. Items can move from pending to running, back to pending, completed, or failed. Several updates only succeed if the item is currently in the expected state. This matters when multiple workers might be acting at once: the database update becomes a guardrail that prevents a late or wrong worker from overwriting newer truth. The tests focus on that safety, especially making sure a result report only completes the item when it comes from the currently assigned running thread.

#### Function details

##### `StateRuntime::create_agent_job`  (lines 5–99)

```
async fn create_agent_job(
        &self,
        params: &AgentJobCreateParams,
        items: &[AgentJobItemCreateParams],
    ) -> anyhow::Result<AgentJob>
```

**Purpose**: Creates a new agent job and all of its starting work items in the database. It is used when the system receives a new batch of work and needs to save both the job summary and every row-like item that belongs to it.

**Data flow**: It receives job settings and a list of item settings. It turns structured values such as headers, row data, and optional output schema into JSON text, records the current time, inserts the job as pending, inserts each item as pending, commits the database transaction, then reads the job back and returns it.

**Call relations**: This is the beginning of the agent job flow. After writing the records, it calls `StateRuntime::get_agent_job` to load the newly created job in the same shape callers expect elsewhere.

*Call graph*: calls 1 internal fn (get_agent_job); 4 external calls (now, from, to_string, query).


##### `StateRuntime::get_agent_job`  (lines 101–128)

```
async fn get_agent_job(&self, job_id: &str) -> anyhow::Result<Option<AgentJob>>
```

**Purpose**: Looks up one agent job by its id. Callers use it when they need the saved job details, such as its name, instruction, status, paths, and timing information.

**Data flow**: It receives a job id, queries the `agent_jobs` table, and either gets no row or gets one stored row. If a row exists, it converts that database row into the normal `AgentJob` value returned to the rest of the program.

**Call relations**: It is used by `StateRuntime::create_agent_job` immediately after creation to verify and return the stored job. Other code can also use it as a direct read path for job details.

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

**Purpose**: Returns the items belonging to a job, optionally filtered by status and optionally capped to a maximum count. This is useful for finding pending work, showing job contents, or reading a manageable slice of a large job.

**Data flow**: It receives a job id, an optional item status, and an optional limit. It builds a SQL query with only the needed filters, orders items by their original row order, reads matching rows, converts each row into an `AgentJobItem`, and returns the list.

**Call relations**: This method is a read-side helper for job runners or user-facing views. It builds its query dynamically so callers can ask broad questions, like all items, or narrow questions, like only pending items.

*Call graph*: 1 external calls (new).


##### `StateRuntime::get_agent_job_item`  (lines 174–205)

```
async fn get_agent_job_item(
        &self,
        job_id: &str,
        item_id: &str,
    ) -> anyhow::Result<Option<AgentJobItem>>
```

**Purpose**: Looks up one specific item inside one specific job. It is used when code needs the latest saved state of a single unit of work.

**Data flow**: It receives a job id and item id, queries the `agent_job_items` table for that exact pair, and returns either nothing or the converted `AgentJobItem` value.

**Call relations**: This is the direct read path for one item. The tests use it after status changes to confirm the database now contains the expected result.


##### `StateRuntime::mark_agent_job_running`  (lines 207–228)

```
async fn mark_agent_job_running(&self, job_id: &str) -> anyhow::Result<()>
```

**Purpose**: Marks a whole job as running. This records that work has started and clears any old completion or error marker.

**Data flow**: It receives a job id, records the current time, updates the job status to running, updates the timestamp, sets `started_at` if it was empty, clears `completed_at`, clears `last_error`, and returns success or a database error.

**Call relations**: This is usually called after a job has been created and before its items begin running. It uses the current time and a database update to make the job-level state match the active work.

*Call graph*: 2 external calls (now, query).


##### `StateRuntime::mark_agent_job_completed`  (lines 230–246)

```
async fn mark_agent_job_completed(&self, job_id: &str) -> anyhow::Result<()>
```

**Purpose**: Marks a whole job as completed. This records that the batch finished successfully.

**Data flow**: It receives a job id, records the current time, updates the job status to completed, sets both `updated_at` and `completed_at`, clears any last error, and returns once the database update is done.

**Call relations**: This is called near the end of a successful job run, after item processing is finished. It writes the final job-level state.

*Call graph*: 2 external calls (now, query).


##### `StateRuntime::mark_agent_job_failed`  (lines 248–269)

```
async fn mark_agent_job_failed(
        &self,
        job_id: &str,
        error_message: &str,
    ) -> anyhow::Result<()>
```

**Purpose**: Marks a whole job as failed and stores the reason. This gives later readers a clear final state and an explanation.

**Data flow**: It receives a job id and an error message, records the current time, sets the job status to failed, stores the completion time and error text, and returns after the database update.

**Call relations**: This is used when the overall job cannot continue or cannot finish successfully. It writes the failure state directly to the job record.

*Call graph*: 2 external calls (now, query).


##### `StateRuntime::mark_agent_job_cancelled`  (lines 271–294)

```
async fn mark_agent_job_cancelled(
        &self,
        job_id: &str,
        reason: &str,
    ) -> anyhow::Result<bool>
```

**Purpose**: Tries to cancel a job that has not already reached a final state. It returns whether the cancellation actually changed the job.

**Data flow**: It receives a job id and cancellation reason, records the current time, and updates the job to cancelled only if its current status is pending or running. It returns `true` if a row was changed and `false` if the job was already completed, failed, cancelled, or missing.

**Call relations**: This protects final states from being overwritten by a late cancellation request. Callers can use the returned boolean to know whether their cancellation was accepted.

*Call graph*: 2 external calls (now, query).


##### `StateRuntime::is_agent_job_cancelled`  (lines 296–312)

```
async fn is_agent_job_cancelled(&self, job_id: &str) -> anyhow::Result<bool>
```

**Purpose**: Checks whether a job is currently marked as cancelled. This lets long-running work notice when it should stop.

**Data flow**: It receives a job id, reads the job status from the database, and returns `false` if the job is missing. If the job exists, it parses the stored status text and returns whether it equals cancelled.

**Call relations**: This is a polling-style read method: worker code can ask it during processing to decide whether continuing would ignore a cancellation.

*Call graph*: calls 1 internal fn (parse); 1 external calls (query).


##### `StateRuntime::mark_agent_job_item_running`  (lines 314–340)

```
async fn mark_agent_job_item_running(
        &self,
        job_id: &str,
        item_id: &str,
    ) -> anyhow::Result<bool>
```

**Purpose**: Claims an item for work by moving it from pending to running. It also counts this as another attempt.

**Data flow**: It receives a job id and item id, records the current time, and updates the item only if it is currently pending. The update clears any assigned thread, increments the attempt count, clears the last error, and returns whether the claim succeeded.

**Call relations**: This is a guarded state transition. If another worker already moved the item out of pending, this method returns `false` instead of accidentally claiming work twice.

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

**Purpose**: Claims an item for work and records which thread is responsible for it. Here, a thread id is a worker-specific identifier used to prove who owns the in-progress item.

**Data flow**: It receives a job id, item id, and thread id, records the current time, and updates the item from pending to running only if it is still pending. It stores the thread id, increments the attempt count, clears the last error, and returns whether the update succeeded.

**Call relations**: This is used when later result reporting must be tied to the worker that claimed the item. The tests use it before reporting a result so the report can be checked against the assigned thread.

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

**Purpose**: Moves a running item back to pending, optionally remembering why. This allows an in-progress item to be retried later.

**Data flow**: It receives a job id, item id, and optional error message, records the current time, and updates the item only if it is currently running. It clears the assigned thread, sets the status back to pending, stores the optional error, and returns whether anything changed.

**Call relations**: This is the retry path for a running item that did not finish cleanly but should not be considered permanently failed. The status guard prevents changing items that are no longer running.

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

**Purpose**: Assigns or updates the thread id for an item that is already running. This records which worker is expected to report the result.

**Data flow**: It receives a job id, item id, and thread id, records the current time, and stores that thread id only if the item is currently running. It returns whether the item was updated.

**Call relations**: This supports workflows where an item first becomes running and the worker thread is attached afterward. The later reporting method relies on this assignment to reject reports from the wrong or stale thread.

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

**Purpose**: Stores a completed item result and marks the item completed, but only if the reporting thread is still the assigned owner. This prevents late or wrong workers from overwriting the item.

**Data flow**: It receives a job id, item id, reporting thread id, and JSON result. It turns the JSON result into text, records the current time, and updates the item to completed only if it is running and assigned to that same thread. It stores the result, sets report and completion times, clears errors and assignment, and returns whether the report was accepted.

**Call relations**: This is the safest result-submission path. The tests show both sides: a valid report completes the item, while a late report after failure is rejected because the item no longer matches the required running state.

*Call graph*: 3 external calls (now, to_string, query).


##### `StateRuntime::mark_agent_job_item_completed`  (lines 466–496)

```
async fn mark_agent_job_item_completed(
        &self,
        job_id: &str,
        item_id: &str,
    ) -> anyhow::Result<bool>
```

**Purpose**: Marks a running item completed when a result has already been stored. It is a completion step that refuses to complete an item with no result.

**Data flow**: It receives a job id and item id, records the current time, and updates the item only if it is running and `result_json` is not empty. It sets the completed time, clears the assigned thread, and returns whether the update happened.

**Call relations**: This is an alternate completion path to `StateRuntime::report_agent_job_item_result`. Its database condition protects against marking work done before any result exists.

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

**Purpose**: Marks a running item as failed and records the error message. This gives the system and users a final item-level failure reason.

**Data flow**: It receives a job id, item id, and error message, records the current time, and updates the item only if it is currently running. It sets the status to failed, stores completion and update times, saves the error, clears the assigned thread, and returns whether the update succeeded.

**Call relations**: This is the item-level failure path. The late-report test uses it before trying to report a result, proving that once the item is failed, `StateRuntime::report_agent_job_item_result` will no longer accept a stale completion.

*Call graph*: 2 external calls (now, query).


##### `StateRuntime::get_agent_job_progress`  (lines 532–566)

```
async fn get_agent_job_progress(&self, job_id: &str) -> anyhow::Result<AgentJobProgress>
```

**Purpose**: Counts how many items in a job are total, pending, running, completed, and failed. This provides a compact progress summary for dashboards, logs, or job-control code.

**Data flow**: It receives a job id, asks the database to count all matching items and count each status group, converts the database numbers into normal unsigned counts, and returns an `AgentJobProgress` value.

**Call relations**: This is a read-side summary of the item table. The success test calls it after reporting a result to confirm the job now has one completed item and no pending or running work.

*Call graph*: 2 external calls (query, try_from).


##### `tests::create_running_single_item_job`  (lines 576–613)

```
async fn create_running_single_item_job(
        runtime: &StateRuntime,
    ) -> anyhow::Result<(String, String, String)>
```

**Purpose**: Builds a small test fixture: one job, one item, and one assigned thread, with the item already running. It saves repeated setup code for the tests in this file.

**Data flow**: It receives a runtime connected to a temporary test database. It creates a job with one item, marks the job running, marks the item running with a thread id, checks that the item was claimed, and returns the three ids needed by the tests.

**Call relations**: Both test cases call this helper before checking result-report behavior. It uses the same public runtime methods that production code would use, so the tests exercise the real database transitions.

*Call graph*: 6 external calls (assert!, json!, create_agent_job, mark_agent_job_item_running_with_thread, mark_agent_job_running, vec!).


##### `tests::report_agent_job_item_result_completes_item_atomically`  (lines 616–653)

```
async fn report_agent_job_item_result_completes_item_atomically() -> anyhow::Result<()>
```

**Purpose**: Tests that reporting a result both saves the result and completes the item in one safe database update. In plain terms, it checks that the item cannot be left half-reported.

**Data flow**: It creates a temporary runtime, uses the helper to make one running item, reports a JSON result from the assigned thread, then reads the item and progress summary back. It expects the item to be completed, to contain the result, to have no assigned thread or error, and to count as completed in progress.

**Call relations**: This test calls `tests::create_running_single_item_job`, then exercises `StateRuntime::report_agent_job_item_result` indirectly through the runtime. It confirms the main happy path for item result submission.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 4 external calls (assert!, assert_eq!, json!, create_running_single_item_job).


##### `tests::report_agent_job_item_result_rejects_late_reports`  (lines 656–683)

```
async fn report_agent_job_item_result_rejects_late_reports() -> anyhow::Result<()>
```

**Purpose**: Tests that a late result report is rejected after an item has already been failed. This protects the database from stale workers changing the truth after a timeout or failure decision.

**Data flow**: It creates a temporary runtime, uses the helper to make one running item, marks that item failed, then tries to report a JSON result from the old thread. It expects the report to be refused and the item to remain failed with its original error and no result.

**Call relations**: This test sets up the same running state as the success test, then calls the failure path before result reporting. It proves that `StateRuntime::report_agent_job_item_result` respects the item’s current status instead of blindly accepting late data.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 4 external calls (assert!, assert_eq!, json!, create_running_single_item_job).


### `state/src/model/backfill_state.rs`

`data_model` · `backfill state loading and progress tracking`

A backfill job can take time and may need to survive restarts. This file gives the rest of the system a small, clear record of that job’s lifecycle: its status, its last processed watermark, and the last time it finished successfully. A watermark is like a bookmark in a long list; it tells the job where to continue next time instead of starting over.

The main type, `BackfillState`, is the shape of the saved record. Its default value means “nothing has run yet”: the job is pending, there is no bookmark, and there is no success time. When the state is read back from SQLite, `try_from_row` turns a database row into this Rust structure. It checks the text status, reads the optional watermark, and converts a stored Unix timestamp into a real UTC date and time.

`BackfillStatus` is the small set of allowed lifecycle states: pending, running, or complete. It can be turned into a database-friendly string and parsed back from one. This matters because saved data is only useful if the program can trust it; an unknown status or invalid timestamp becomes an error instead of silently producing a misleading state.

#### Function details

##### `BackfillState::default`  (lines 19–25)

```
fn default() -> Self
```

**Purpose**: Creates the starting state for a backfill job before any saved progress exists. It says the job is pending, has no saved bookmark, and has never completed successfully.

**Data flow**: Nothing comes in. The function builds a new `BackfillState` with `Pending` status, an empty `last_watermark`, and an empty `last_success_at`, then returns it.

**Call relations**: When `backfill_sessions_with_lease` needs a fresh backfill state, it calls this function. That gives the larger backfill process a safe starting point instead of guessing what missing database state should mean.

*Call graph*: called by 1 (backfill_sessions_with_lease).


##### `BackfillState::try_from_row`  (lines 29–40)

```
fn try_from_row(row: &SqliteRow) -> Result<Self>
```

**Purpose**: Turns one SQLite database row into a `BackfillState` that the program can use. It also validates the saved values so bad database data is caught early.

**Data flow**: A SQLite row comes in. The function reads the saved status text, optional last watermark, and optional success timestamp. It parses the status into a known `BackfillStatus`, converts the timestamp from Unix seconds into a UTC date and time when present, and returns a complete `BackfillState`; if any value is missing, malformed, or invalid, it returns an error.

**Call relations**: `get_backfill_state` calls this after fetching the saved row from the database. Inside, it relies on `BackfillStatus::parse` to understand the status text and on database row-reading helpers to pull out the stored fields.

*Call graph*: calls 1 internal fn (parse); called by 1 (get_backfill_state); 1 external calls (try_get).


##### `BackfillStatus::as_str`  (lines 52–58)

```
fn as_str(self) -> &'static str
```

**Purpose**: Converts a backfill status into the exact lowercase text used for storage or display, such as `pending` or `complete`.

**Data flow**: A `BackfillStatus` value comes in. The function matches it to its fixed string form and returns that string; it does not change anything else.

**Call relations**: This is the outward-facing companion to `BackfillStatus::parse`. Code that needs to save or compare a status as text can use this so every part of the system uses the same spelling.


##### `BackfillStatus::parse`  (lines 60–67)

```
fn parse(value: &str) -> Result<Self>
```

**Purpose**: Converts saved status text back into one of the allowed backfill statuses. It protects the system from accepting unknown lifecycle states.

**Data flow**: A text value comes in. If it is `pending`, `running`, or `complete`, the function returns the matching `BackfillStatus`; otherwise it returns an error explaining that the status is invalid.

**Call relations**: `BackfillState::try_from_row` calls this while rebuilding state from the database. That means loaded backfill state is checked before the rest of the backfill flow trusts it.

*Call graph*: called by 1 (try_from_row); 1 external calls (anyhow!).


##### `epoch_seconds_to_datetime`  (lines 70–73)

```
fn epoch_seconds_to_datetime(secs: i64) -> Result<DateTime<Utc>>
```

**Purpose**: Converts a saved Unix timestamp, measured in seconds since 1970-01-01 UTC, into a proper UTC date and time. It rejects timestamps that cannot be represented safely.

**Data flow**: A number of seconds comes in. The function asks the date-time library to build a UTC timestamp from it; if that succeeds, the date-time value comes out, and if not, an error comes out instead.

**Call relations**: `BackfillState::try_from_row` uses this when the database row includes a `last_success_at` value. It is the small translation step between compact database storage and the richer time value used in Rust code.

*Call graph*: 1 external calls (from_timestamp).


### `state/src/runtime/backfill.rs`

`domain_logic` · `startup and background backfill`

A backfill is a catch-up job: it scans older data and writes information that was not stored before. This file is the small control panel for that job. It stores the job’s state in a SQLite database table called backfill_state. SQLite is a local database stored on disk.

The important idea is that there is exactly one row for this job, with id = 1. Before any read or write, the code first makes sure that row exists. That means the system can repair a missing state row instead of crashing or treating the job as unknown.

The file supports the normal life of the job. It can read the current state, mark the job as running, save a checkpoint called a watermark, and mark the job complete. The watermark is like a bookmark in a book: if the job stops halfway through, it can later resume from the last saved place.

It also has a claiming step. If several runtimes start at once, only one should run the backfill. try_claim_backfill updates the row only if the job is not complete and is not already owned by a fresh running worker. If the previous worker looks stale because its timestamp is too old, another runtime may take over. Without this file, multiple workers could duplicate work, lose progress, or rerun a completed migration-like task.

#### Function details

##### `StateRuntime::get_backfill_state`  (lines 4–16)

```
async fn get_backfill_state(&self) -> anyhow::Result<crate::BackfillState>
```

**Purpose**: Reads the saved backfill status from the database. Someone uses this to know whether the catch-up job still needs to run, is already running, or has finished.

**Data flow**: It starts with the runtime’s database connection pool. First it makes sure the single backfill_state row exists. Then it reads status, last_watermark, and last_success_at from that row. Finally it turns the database row into a BackfillState value and returns it.

**Call relations**: This is the read side of the backfill control panel. It calls StateRuntime::ensure_backfill_state_row before querying, so callers get a usable state even if the singleton row was missing. It then hands the raw database row to try_from_row to convert stored text and timestamps into the project’s BackfillState type.

*Call graph*: calls 2 internal fn (try_from_row, ensure_backfill_state_row); 1 external calls (query).


##### `StateRuntime::try_claim_backfill`  (lines 23–44)

```
async fn try_claim_backfill(&self, lease_seconds: i64) -> anyhow::Result<bool>
```

**Purpose**: Tries to reserve the backfill job for this runtime. It returns true only when this runtime successfully becomes the worker that should run the job.

**Data flow**: It receives a lease length in seconds, reads the current time, and computes the oldest acceptable running timestamp. It then asks the database to update the single state row to Running, but only if the job is not Complete and is not already Running with a fresh timestamp. The output is true if exactly one row changed, otherwise false.

**Call relations**: This is used before starting the backfill work, as a gatekeeper. Like the other methods, it first calls StateRuntime::ensure_backfill_state_row. It relies on the database update itself to be the deciding moment, so two competing runtimes cannot both successfully claim the same singleton slot.

*Call graph*: calls 1 internal fn (ensure_backfill_state_row); 2 external calls (now, query).


##### `StateRuntime::mark_backfill_running`  (lines 47–61)

```
async fn mark_backfill_running(&self) -> anyhow::Result<()>
```

**Purpose**: Records that the backfill job is currently running. This is useful when the system wants to explicitly refresh or set the job’s visible status.

**Data flow**: It uses the runtime’s database pool, ensures the singleton row exists, gets the current time, and writes status = Running plus an updated timestamp into the row. It returns success or an error from the database operation.

**Call relations**: This is part of the write side of the backfill lifecycle. It calls StateRuntime::ensure_backfill_state_row first, then writes directly to the database. It does not decide ownership like StateRuntime::try_claim_backfill; it simply records the running state.

*Call graph*: calls 1 internal fn (ensure_backfill_state_row); 2 external calls (now, query).


##### `StateRuntime::checkpoint_backfill`  (lines 64–79)

```
async fn checkpoint_backfill(&self, watermark: &str) -> anyhow::Result<()>
```

**Purpose**: Saves progress while the backfill is running. The saved watermark tells future work where the last successful point was.

**Data flow**: It receives a watermark string, such as a path or ordered marker for the data already processed. It ensures the state row exists, writes status = Running, stores the watermark, and updates the timestamp. It returns nothing on success, or an error if the database write fails.

**Call relations**: A backfill worker calls this during the job, after it has safely processed a chunk of work. It depends on StateRuntime::ensure_backfill_state_row and then writes the progress marker so StateRuntime::get_backfill_state can later report it.

*Call graph*: calls 1 internal fn (ensure_backfill_state_row); 2 external calls (now, query).


##### `StateRuntime::mark_backfill_complete`  (lines 82–103)

```
async fn mark_backfill_complete(&self, last_watermark: Option<&str>) -> anyhow::Result<()>
```

**Purpose**: Records that the backfill finished successfully. It also optionally stores the final watermark and saves the finish time.

**Data flow**: It receives an optional last watermark. It ensures the state row exists, reads the current time, and updates the row to Complete. If a new watermark is provided, it replaces the old one; if not, the old watermark is kept. It also sets last_success_at and updated_at to the current time.

**Call relations**: A backfill worker calls this at the end of a successful run. After this method marks the job Complete, StateRuntime::try_claim_backfill will refuse future claims, so the finished catch-up job is not run again.

*Call graph*: calls 1 internal fn (ensure_backfill_state_row); 2 external calls (now, query).


##### `StateRuntime::ensure_backfill_state_row`  (lines 105–107)

```
async fn ensure_backfill_state_row(&self) -> anyhow::Result<()>
```

**Purpose**: Makes sure the database has the one required row that stores backfill state. This protects the rest of the code from missing-row surprises.

**Data flow**: It takes the runtime’s database pool and passes it to a shared helper that inserts or repairs the singleton row if needed. It returns success when the row is available, or an error if the database operation fails.

**Call relations**: Every public backfill state method calls this first: StateRuntime::get_backfill_state, StateRuntime::try_claim_backfill, StateRuntime::mark_backfill_running, StateRuntime::checkpoint_backfill, and StateRuntime::mark_backfill_complete. It is the common safety step before any read or write.

*Call graph*: called by 5 (checkpoint_backfill, get_backfill_state, mark_backfill_complete, mark_backfill_running, try_claim_backfill).


##### `tests::backfill_state_persists_progress_and_completion`  (lines 120–170)

```
async fn backfill_state_persists_progress_and_completion()
```

**Purpose**: Checks the happy path for the backfill state record. It proves that the system starts pending, can record running progress, and can later record completion.

**Data flow**: The test creates a temporary runtime, reads the initial state, marks the job running, saves a checkpoint watermark, reads the state again, then marks the job complete with a final watermark. It compares each observed state with the expected status, watermark, and success time, then removes the temporary directory.

**Call relations**: This test exercises StateRuntime::get_backfill_state, StateRuntime::mark_backfill_running, StateRuntime::checkpoint_backfill, and StateRuntime::mark_backfill_complete as one full story. It confirms that the main lifecycle methods work together rather than only working in isolation.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 3 external calls (assert!, assert_eq!, remove_dir_all).


##### `tests::get_backfill_state_succeeds_while_another_connection_holds_writer_slot`  (lines 173–199)

```
async fn get_backfill_state_succeeds_while_another_connection_holds_writer_slot()
```

**Purpose**: Checks that reading the backfill state still works even when another database connection is holding a write lock. A write lock is a database reservation that prevents other writers from changing data at the same time.

**Data flow**: The test creates a runtime, opens a second SQLite connection, and starts an immediate write transaction to occupy the writer slot. While that lock is held, it calls get_backfill_state and expects to receive the default backfill state. It then rolls back the transaction and deletes the temporary files.

**Call relations**: This test focuses on StateRuntime::get_backfill_state under database contention. It uses StateRuntime::init, base_sqlite_options, and state_db_path to open the same database from another connection, then verifies that the read path remains usable.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 5 external calls (assert_eq!, state_db_path, connect_with, base_sqlite_options, remove_dir_all).


##### `tests::get_backfill_state_repairs_a_missing_singleton_row`  (lines 202–225)

```
async fn get_backfill_state_repairs_a_missing_singleton_row()
```

**Purpose**: Checks that the system can recover if the required backfill_state row is missing. This matters because the rest of the file assumes there is one row with id = 1.

**Data flow**: The test creates a runtime, manually deletes the singleton row from the database, then calls get_backfill_state. It expects the default state to come back and then counts the database rows to confirm the missing row was recreated. Finally it removes the temporary directory.

**Call relations**: This test proves that StateRuntime::get_backfill_state calls the repair step through StateRuntime::ensure_backfill_state_row. It directly changes the database with a query to simulate damage or an unexpected missing row.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 3 external calls (assert_eq!, query, remove_dir_all).


##### `tests::backfill_claim_is_singleton_until_stale_and_blocked_when_complete`  (lines 228–277)

```
async fn backfill_claim_is_singleton_until_stale_and_blocked_when_complete()
```

**Purpose**: Checks the ownership rules for the backfill worker. It proves that only one fresh worker can claim the job, that a stale worker can be replaced, and that a completed job cannot be claimed again.

**Data flow**: The test creates a runtime and successfully claims the backfill once. It tries a second claim and expects it to fail. Then it manually makes the running timestamp old, tries again with a short lease, and expects the claim to succeed. Finally it marks the job complete and confirms that claiming after completion returns false.

**Call relations**: This test exercises StateRuntime::try_claim_backfill and StateRuntime::mark_backfill_complete around the edge cases that prevent duplicate workers. It uses a direct database update and the current time to simulate a stale lease.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 4 external calls (now, assert_eq!, query, remove_dir_all).


### Auxiliary runtime records
These files cover additional SQLite-backed runtime records for logs, external import tracking, and remote-control enrollment.

### `state/src/model/log.rs`

`data_model` · `request handling`

Logs are the system’s diary: they record what happened, when it happened, where it came from, and often why it matters. This file does not fetch or write logs itself. Instead, it gives the rest of the program shared, named containers for log-related information so different parts of the system can agree on the same format.

`LogEntry` is the outward-facing form of a log record. It can be serialized, meaning it can be turned into a format such as JSON for an API response or another consumer. It includes timestamps, severity level, source target, message text, optional thread and process details, and optional source-code location.

`LogRow` is the database-facing form. It represents one row read from storage and includes an `id`, which is useful for ordering or paging through logs. It derives `FromRow`, which lets the SQL database library fill the struct from a database query result.

`LogQuery` describes what someone wants to search for: levels, time range, module or file matches, thread IDs, free-text search, paging controls, and sort direction. Think of it like a form filled out before asking the log database, “show me only these kinds of entries.”


### `state/src/runtime/external_agent_config_imports.rs`

`io_transport` · `after external agent config import completion and when import history/details are requested`

When the system imports configuration from outside itself, it needs a receipt: what was attempted, what worked, what failed, and why. This file defines that receipt and stores it in the state database. Without it, users or later parts of the program would have no durable history of external agent configuration imports, making troubleshooting much harder.

The record types describe successful imported items, failed imported items, a detailed view for one import, and a history view for many imports. A success can include where the import ran from, its source, and its target. A failure also keeps the stage where things went wrong, an optional error type, and a human-readable message.

The database stores the success and failure lists as JSON text. JSON is a common text format for structured data, so the code can keep rich lists inside a database row. The methods on `StateRuntime` are the bridge between normal Rust data and the database table `external_agent_config_imports`: one method writes a completed import, one reads the details for a single import, and one reads the full history ordered newest first. If the same import ID is written again, the old record is updated rather than duplicated, like replacing an old receipt with the latest copy.

#### Function details

##### `StateRuntime::record_external_agent_config_import_completed`  (lines 42–70)

```
async fn record_external_agent_config_import_completed(
        &self,
        import_id: &str,
        successes: &[ExternalAgentConfigImportSuccessRecord],
        failures: &[ExternalAgentConfigImp
```

**Purpose**: This function saves the final result of one external agent configuration import. It records the import ID, the finish time, and the lists of successful and failed items so the result can be reviewed later.

**Data flow**: It receives an import ID plus two lists: successes and failures. It gets the current time, converts that time into milliseconds since the Unix epoch, turns both lists into JSON text, and writes everything into the `external_agent_config_imports` database table. If a row with the same import ID already exists, it updates that row with the new timestamp and result lists. It returns success when the database write finishes, or an error if time conversion, JSON conversion, or the database operation fails.

**Call relations**: This is called after an import has finished and the system needs to persist its outcome. Inside the function, it asks the clock for the current time, passes that through `datetime_to_epoch_millis` so the database stores a simple number, uses JSON serialization to prepare the result lists, and hands the final insert-or-update statement to the SQL layer.

*Call graph*: 4 external calls (now, datetime_to_epoch_millis, to_string, query).


##### `StateRuntime::external_agent_config_import_details_record`  (lines 72–98)

```
async fn external_agent_config_import_details_record(
        &self,
        import_id: &str,
    ) -> anyhow::Result<Option<ExternalAgentConfigImportDetailsRecord>>
```

**Purpose**: This function looks up the stored success and failure details for one import. It is useful when a user or another part of the system wants to inspect exactly what happened during a specific import.

**Data flow**: It receives an import ID. It queries the database for the matching row and reads the stored JSON text for successes and failures. If no row exists, it returns `None`. If a row exists, it turns the JSON text back into normal Rust record lists and returns them inside an `ExternalAgentConfigImportDetailsRecord`. Any database or JSON reading problem becomes an error.

**Call relations**: This sits on the read side of the same storage written by `StateRuntime::record_external_agent_config_import_completed`. When something asks for one import's details, this function sends a select query to the SQL layer, then rebuilds the in-memory detail record that callers can use without knowing how the data was stored.

*Call graph*: 1 external calls (query).


##### `StateRuntime::external_agent_config_import_history_records`  (lines 100–131)

```
async fn external_agent_config_import_history_records(
        &self,
    ) -> anyhow::Result<Vec<ExternalAgentConfigImportHistoryRecord>>
```

**Purpose**: This function returns the saved history of external agent configuration imports. It gives callers a newest-first list, including each import's ID, completion time, successes, and failures.

**Data flow**: It takes no import ID because it reads all stored import records. It asks the database for every row in `external_agent_config_imports`, ordered by completion time from newest to oldest, with import ID used as a stable tie-breaker. For each row, it reads the ID, timestamp, and JSON text fields, converts the JSON back into success and failure lists, and collects everything into a vector of history records. The result is the complete history list, or an error if any database read or JSON conversion fails.

**Call relations**: This function is used when the system needs an overview rather than one import's details. It relies on the SQL layer to fetch all rows, then performs the same JSON rebuilding step as the single-detail reader so callers receive ordinary structured records instead of raw database text.

*Call graph*: 1 external calls (query).


### `state/src/runtime/remote_control.rs`

`io_transport` · `cross-cutting persistence during remote-control setup and preference changes`

This file is the small database layer for remote-control enrollment records. An enrollment is the app’s saved note that says, in effect: “for this WebSocket server URL and this account, use this server ID, environment ID, and server name.” Without this file, the app could not reliably remember or update those enrollments between runs.

The main record type is `RemoteControlEnrollmentRecord`, which is a plain bundle of saved fields. The `StateRuntime` methods then do the database work: look up one enrollment, insert or update one, change whether remote control is enabled, or delete one.

A subtle detail is the optional `app_server_client_name`. In Rust, this can be `None`, meaning “no client name.” But the database key needs a concrete value to compare against, so this file stores `None` as an empty string. Think of it like writing “no middle name” as a blank box on a form, then turning that blank box back into “no value” when reading it.

The tests check that records are separated correctly by account and client name, that deleting one record does not delete a neighboring one, and that older database rows without the newer remote-control preference still load safely with that preference left unknown.

#### Function details

##### `remote_control_app_server_client_name_key`  (lines 17–19)

```
fn remote_control_app_server_client_name_key(app_server_client_name: Option<&str>) -> &str
```

**Purpose**: This helper converts an optional app-server client name into the exact text used as part of the database lookup key. It makes sure “no client name” is stored and searched as an empty string.

**Data flow**: It receives either a client name or no client name. If a name is present, it returns that name; if not, it returns the shared empty-string marker. Nothing else is changed.

**Call relations**: The database methods call this before reading, writing, updating, or deleting a row. That keeps every operation using the same rule for matching records whose client name is absent.

*Call graph*: called by 4 (delete_remote_control_enrollment, get_remote_control_enrollment, set_remote_control_enabled, upsert_remote_control_enrollment).


##### `app_server_client_name_from_key`  (lines 21–27)

```
fn app_server_client_name_from_key(app_server_client_name: String) -> Option<String>
```

**Purpose**: This helper converts the database version of the client name back into the Rust version. An empty string from the database becomes “no client name,” while any other string becomes a real client name.

**Data flow**: It receives the stored database text. If the text is empty, it returns no value; otherwise it wraps the text as a present client name. It does not touch the database itself.

**Call relations**: It belongs to the read path, where a database row is turned back into a `RemoteControlEnrollmentRecord`. It is the reverse of the key helper used before database lookups and writes.


##### `StateRuntime::get_remote_control_enrollment`  (lines 30–65)

```
async fn get_remote_control_enrollment(
        &self,
        websocket_url: &str,
        account_id: &str,
        app_server_client_name: Option<&str>,
    ) -> anyhow::Result<Option<RemoteControl
```

**Purpose**: This function looks up one saved remote-control enrollment. A caller uses it when it needs to know whether a specific account and remote-control endpoint already have saved server details.

**Data flow**: It receives a WebSocket URL, an account ID, and an optional client name. It converts the optional client name into the database key format, asks the SQLite database for a matching row, and if one exists, builds a `RemoteControlEnrollmentRecord` from it. The result is either a full record, no record, or an error if the database read fails.

**Call relations**: This is the read side of the remote-control enrollment flow. It relies on `remote_control_app_server_client_name_key` so it searches with the same key format used by writes, then uses a database query to fetch the stored row.

*Call graph*: calls 1 internal fn (remote_control_app_server_client_name_key); 1 external calls (query).


##### `StateRuntime::upsert_remote_control_enrollment`  (lines 67–103)

```
async fn upsert_remote_control_enrollment(
        &self,
        enrollment: &RemoteControlEnrollmentRecord,
    ) -> anyhow::Result<()>
```

**Purpose**: This function saves a remote-control enrollment, creating it if it is new or updating the existing row if the same URL, account, and client name already exist. “Upsert” means insert-or-update.

**Data flow**: It receives a complete `RemoteControlEnrollmentRecord`. It converts the optional client name into the database key format, writes all the identifying and server fields into the database, and stamps the row with the current time. If a matching row already exists, it updates the server ID, environment ID, server name, and timestamp instead of creating a duplicate.

**Call relations**: This is the write side of the enrollment flow. It calls the key helper before storing the row, calls the clock to record when the row changed, and sends the final SQL command to the database.

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

**Purpose**: This function changes the saved on/off preference for remote control on one enrollment. It is used when the app needs to remember whether remote control is enabled for a specific saved target.

**Data flow**: It receives the identifying fields for one enrollment plus the new enabled value. It converts the optional client name into the database key format, updates the matching row’s `remote_control_enabled` value and timestamp, and returns how many rows were changed.

**Call relations**: This function is a focused update path: it does not rewrite the server identity fields, only the enabled preference. Like the other database methods, it uses the shared key helper and the current time before sending an update query.

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

**Purpose**: This function removes one saved remote-control enrollment from the local database. A caller uses it when an enrollment should no longer be remembered.

**Data flow**: It receives a WebSocket URL, an account ID, and an optional client name. It converts the client name into the database key format, deletes only the row matching all three pieces of identity, and returns how many rows were removed.

**Call relations**: This is the cleanup path for enrollments. It shares the same key conversion as lookups and writes, which prevents deleting the wrong row when two records differ only by account or client name.

*Call graph*: calls 1 internal fn (remote_control_app_server_client_name_key); 1 external calls (query).


##### `tests::remote_control_enrollment_round_trips_by_target_and_account`  (lines 168–245)

```
async fn remote_control_enrollment_round_trips_by_target_and_account()
```

**Purpose**: This test proves that enrollment records can be saved and read back correctly, and that different accounts stay separate even when they use the same remote-control URL and client name.

**Data flow**: It creates a temporary state directory, initializes a test `StateRuntime`, inserts two enrollments, then reads them back. It expects the first account’s record to match exactly, while lookups for a missing account or wrong client name return nothing. At the end it removes the temporary directory.

**Call relations**: This test exercises the main save-and-read story through `StateRuntime::init`, the enrollment writing method, and the enrollment reading method. The assertions act like checkpoints showing that the database key uses URL, account, and client name together.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 2 external calls (assert_eq!, remove_dir_all).


##### `tests::delete_remote_control_enrollment_removes_only_matching_entry`  (lines 248–325)

```
async fn delete_remote_control_enrollment_removes_only_matching_entry()
```

**Purpose**: This test checks that deleting one enrollment does not accidentally remove another enrollment with similar details. It protects against overly broad delete queries.

**Data flow**: It creates a temporary runtime, inserts two enrollments with the same URL and no client name but different accounts, deletes only the first account’s enrollment, then checks the first is gone and the second is still present. It finally cleans up the temporary directory.

**Call relations**: This test follows the delete path after first using the normal insert path. It then calls the read path to confirm the deletion was precise rather than destructive.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 2 external calls (assert_eq!, remove_dir_all).


##### `tests::migration_preserves_legacy_remote_control_preference_as_null`  (lines 328–380)

```
async fn migration_preserves_legacy_remote_control_preference_as_null()
```

**Purpose**: This test checks compatibility with older state databases that did not yet have a saved remote-control enabled preference. It makes sure old rows still load, with that newer field left unknown instead of forced to true or false.

**Data flow**: It creates a temporary database using an older set of migrations, manually inserts a legacy enrollment row without `remote_control_enabled`, closes that database, then initializes the current runtime so migrations can bring it up to date. It reads the enrollment and checks that `remote_control_enabled` is still `None`.

**Call relations**: This test connects the migration path with the normal enrollment read path. It uses the old migrator and direct SQL setup to recreate a real upgrade scenario, then relies on `StateRuntime::init` and the enrollment lookup to verify the upgraded data behaves correctly.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 8 external calls (Owned, new, connect_with, assert_eq!, state_db_path, query, create_dir_all, remove_dir_all).


### Agent graph store adapter
These files define the storage-agnostic agent graph store API and its local implementation backed by the shared state runtime.

### `agent-graph-store/src/error.rs`

`data_model` · `cross-cutting`

The agent graph store is a part of the system that other code asks to save, read, or update graph-related data. When something goes wrong, callers need a predictable answer, not a mix of unrelated error shapes. This file provides that shared answer.

It defines a convenient result type, `AgentGraphStoreResult<T>`, which means “either the requested value of type `T`, or an `AgentGraphStoreError`.” This keeps function signatures shorter and makes it clear that store operations can fail in known ways.

The main error type, `AgentGraphStoreError`, has two cases. `InvalidRequest` is for problems caused by the caller, such as asking for something with missing or unacceptable input. `Internal` is for failures inside the store implementation itself, when the request was acceptable but the store could not complete it.

Both cases carry a plain message meant to explain the problem. The `thiserror` helper turns these enum cases into normal Rust errors with readable text. Without this file, each graph store implementation might invent its own error style, making failures harder to understand and harder for callers to handle consistently.


### `agent-graph-store/src/store.rs`

`data_model` · `cross-cutting during thread graph persistence and lookup`

This file is a contract for storing and reading an agent thread graph. In this project, a thread can spawn another thread, creating a parent-to-child link. Those links also have a lifecycle status, such as whether the spawned thread is still open. Without this contract, every part of the system that wants to save or inspect those relationships would need to know the details of the chosen storage backend.

The central idea is the `AgentGraphStore` trait. A trait in Rust is like a promise: any storage implementation that claims to be an `AgentGraphStore` must provide the listed operations. The operations are asynchronous, meaning they return work that may finish later, which is important because real storage may involve waiting on disk or a database.

The contract covers four main needs. It can insert or replace a parent-child spawn edge. It can update the status of an existing child edge, while treating a missing child as harmless. It can list the direct children of one parent, optionally filtered by status. It can also list all descendants under a root thread, walking level by level, like reading a family tree generation by generation.

One important detail is stable ordering. Implementations are expected to return lists in a predictable order, so persisted results can be combined with live in-memory results without random-looking output changes.


### `agent-graph-store/src/local.rs`

`io_transport` · `cross-cutting; active whenever local agent thread relationships are written or read`

Agents can create child threads, and the system needs to remember that family tree: which thread started which child, whether that connection is still open, and how to find all children or later descendants. This file supplies the local version of that storage. Think of it like a family-tree notebook kept on disk, where each parent-child line can be marked “open” or “closed.”

The main type, LocalAgentGraphStore, wraps an already-created StateRuntime, which is the lower-level state database. Rather than inventing new storage rules, it forwards each graph-store request to that database. When callers ask to add or update a parent-child connection, the store translates the public ThreadSpawnEdgeStatus value into the matching status type used by codex_state, then asks StateRuntime to write it. When callers ask for children or descendants, it either asks for all of them or, if a status filter is provided, asks for only open or only closed ones.

The file also turns lower-level database errors into AgentGraphStoreError::Internal so callers see one consistent error shape. The tests build a temporary database, insert thread relationships, update statuses, and confirm that direct children and deeper descendants come back in the expected order and with the expected filtering.

#### Function details

##### `LocalAgentGraphStore::fmt`  (lines 17–21)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Creates a short debug view of the local graph store. It shows where the underlying Codex home directory is, without exposing every internal detail.

**Data flow**: It receives the store and a debug formatter. It reads the codex_home path from the wrapped state database, writes that into a debug-style structure, and returns whether formatting succeeded.

**Call relations**: When Rust code asks to print this store for debugging, this function is used. It relies on the formatter’s debug_struct helper to build a readable summary.

*Call graph*: 1 external calls (debug_struct).


##### `LocalAgentGraphStore::new`  (lines 26–28)

```
fn new(state_db: Arc<StateRuntime>) -> Self
```

**Purpose**: Builds a LocalAgentGraphStore around an already-initialized StateRuntime. Use this when the database is ready and you want it to satisfy the AgentGraphStore interface.

**Data flow**: It takes a shared pointer to the state database as input. It stores that pointer inside a new LocalAgentGraphStore and returns the store.

**Call relations**: The tests call this after creating a temporary StateRuntime. In normal use, setup code would do the same: initialize the state database first, then wrap it with this graph-store adapter.

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

**Purpose**: Adds or replaces the stored link from a parent thread to a child thread. This is used when one agent thread spawns another and the system needs to record that relationship.

**Data flow**: It receives a parent thread id, a child thread id, and an open-or-closed status. It converts the status into the state database’s own status type, asks the database to save the edge, and returns success or a graph-store error.

**Call relations**: This is one of the AgentGraphStore operations implemented by the local store. Before handing the work to StateRuntime, it calls to_state_status so the public store status matches the database status type.

*Call graph*: calls 1 internal fn (to_state_status).


##### `LocalAgentGraphStore::set_thread_spawn_edge_status`  (lines 44–53)

```
async fn set_thread_spawn_edge_status(
        &self,
        child_thread_id: ThreadId,
        status: ThreadSpawnEdgeStatus,
    ) -> AgentGraphStoreResult<()>
```

**Purpose**: Changes the status of an existing child-thread relationship. For example, it can mark a previously open spawn edge as closed.

**Data flow**: It receives the child thread id and the new status. It converts the status for the state database, asks the database to update the stored edge for that child, and returns success or a graph-store error.

**Call relations**: This method is called through the AgentGraphStore interface when higher-level code needs to close or reopen a spawn relationship. It uses to_state_status before passing the request to StateRuntime.

*Call graph*: calls 1 internal fn (to_state_status).


##### `LocalAgentGraphStore::list_thread_spawn_children`  (lines 55–72)

```
async fn list_thread_spawn_children(
        &self,
        parent_thread_id: ThreadId,
        status_filter: Option<ThreadSpawnEdgeStatus>,
    ) -> AgentGraphStoreResult<Vec<ThreadId>>
```

**Purpose**: Returns the direct children of a parent thread. A caller can ask for all children, or only those whose relationship is open or closed.

**Data flow**: It receives a parent thread id and an optional status filter. If a filter is present, it converts that status and asks the state database for only matching children; otherwise it asks for all direct children. It returns a list of child thread ids or an error.

**Call relations**: This method is the local store’s answer to the AgentGraphStore child-listing request. When filtering is needed, it calls to_state_status before delegating to the StateRuntime filtering query.

*Call graph*: calls 1 internal fn (to_state_status).


##### `LocalAgentGraphStore::list_thread_spawn_descendants`  (lines 74–91)

```
async fn list_thread_spawn_descendants(
        &self,
        root_thread_id: ThreadId,
        status_filter: Option<ThreadSpawnEdgeStatus>,
    ) -> AgentGraphStoreResult<Vec<ThreadId>>
```

**Purpose**: Returns all known descendants below a root thread, not just immediate children. This lets callers see the whole spawned-thread tree under one starting thread.

**Data flow**: It receives a root thread id and an optional status filter. With a filter, it converts the requested status and asks the state database for matching descendants; without one, it asks for every descendant. It returns the descendant thread ids or an error.

**Call relations**: This method implements the AgentGraphStore descendant-listing operation. It follows the same pattern as direct-child listing: decide whether filtering is needed, translate the status with to_state_status when necessary, then delegate to StateRuntime.

*Call graph*: calls 1 internal fn (to_state_status).


##### `to_state_status`  (lines 94–99)

```
fn to_state_status(status: ThreadSpawnEdgeStatus) -> codex_state::DirectionalThreadSpawnEdgeStatus
```

**Purpose**: Translates the graph store’s public edge status into the matching status type used by the state database. This keeps the rest of the file from repeating the same conversion logic.

**Data flow**: It receives a ThreadSpawnEdgeStatus value. If it is Open, it returns the database’s Open value; if it is Closed, it returns the database’s Closed value.

**Call relations**: All four store operations that write, update, or filter by status call this helper before talking to StateRuntime. It is the small adapter between the graph-store vocabulary and the state-database vocabulary.

*Call graph*: called by 4 (list_thread_spawn_children, list_thread_spawn_descendants, set_thread_spawn_edge_status, upsert_thread_spawn_edge).


##### `internal_error`  (lines 101–105)

```
fn internal_error(err: impl std::fmt::Display) -> AgentGraphStoreError
```

**Purpose**: Wraps a lower-level error in the graph store’s standard internal-error type. This gives callers one consistent error format instead of leaking database-specific error shapes.

**Data flow**: It receives any error-like value that can be displayed as text. It turns that value into a string and places it inside AgentGraphStoreError::Internal.

**Call relations**: The store methods use this as the error-conversion step after calling the state database. Inside the helper, the original error is converted to text with to_string.

*Call graph*: 1 external calls (to_string).


##### `tests::thread_id`  (lines 119–122)

```
fn thread_id(suffix: u128) -> ThreadId
```

**Purpose**: Creates predictable ThreadId values for tests. Predictable ids make it easy to check that returned lists are in the exact expected order.

**Data flow**: It receives a numeric suffix. It formats that suffix into a UUID-shaped string, parses it into a ThreadId, and returns the ThreadId, failing the test if the string is somehow invalid.

**Call relations**: The test cases call this helper whenever they need parent, child, grandchild, or deeper thread ids. It uses formatting and ThreadId parsing to avoid hard-coding many full UUID strings.

*Call graph*: calls 1 internal fn (from_string); 1 external calls (format!).


##### `tests::state_runtime`  (lines 124–134)

```
async fn state_runtime() -> TestRuntime
```

**Purpose**: Creates a fresh temporary state database for each test. This keeps tests isolated so data from one test cannot affect another.

**Data flow**: It creates a temporary directory, initializes StateRuntime inside that directory with a test provider name, and returns both the runtime and the temporary directory holder so the directory stays alive during the test.

**Call relations**: Each test starts by calling this helper. It calls the temporary-directory constructor and StateRuntime initialization, then hands the ready database to LocalAgentGraphStore::new.

*Call graph*: calls 1 internal fn (init); 1 external calls (new).


##### `tests::local_store_upserts_and_lists_direct_children_with_status_filters`  (lines 137–190)

```
async fn local_store_upserts_and_lists_direct_children_with_status_filters()
```

**Purpose**: Checks that the local store can insert direct child edges and list them with or without status filtering. It proves that open and closed child relationships are stored separately but can also be read together.

**Data flow**: It creates a temporary database and store, builds one parent id and two child ids, inserts one closed edge and one open edge, then asks for all children, open children, and closed children. It compares the returned lists with the expected ids.

**Call relations**: This test calls state_runtime to get a clean database, LocalAgentGraphStore::new to wrap it, thread_id to make stable ids, and assertions to verify results. It also compares one filtered store result with the lower-level StateRuntime query to confirm the adapter is forwarding correctly.

*Call graph*: calls 1 internal fn (new); 3 external calls (state_runtime, thread_id, assert_eq!).


##### `tests::local_store_updates_edge_status`  (lines 193–224)

```
async fn local_store_updates_edge_status()
```

**Purpose**: Checks that an existing child edge can have its status changed. It verifies that a child moves from the open list to the closed list after an update.

**Data flow**: It creates a temporary store, inserts an open parent-child edge, updates that child edge to closed, then lists open and closed children. The expected result is no open children and one closed child.

**Call relations**: This test uses state_runtime, LocalAgentGraphStore::new, thread_id, and assertions. It exercises the store’s insert, status-update, and filtered child-listing methods together.

*Call graph*: calls 1 internal fn (new); 3 external calls (state_runtime, thread_id, assert_eq!).


##### `tests::local_store_lists_descendants_breadth_first_with_status_filters`  (lines 227–322)

```
async fn local_store_lists_descendants_breadth_first_with_status_filters()
```

**Purpose**: Checks that the local store can list a whole thread family tree, not just direct children, and can filter that tree by status. It also confirms the expected breadth-first order, meaning nearer generations are returned before deeper ones.

**Data flow**: It creates a temporary store, builds a root thread with children, grandchildren, and a great-grandchild, and inserts edges with mixed open and closed statuses. It then asks for all descendants, only open descendants, and only closed descendants, comparing each answer with the expected order and contents.

**Call relations**: This test calls state_runtime for a clean database, LocalAgentGraphStore::new for the adapter, thread_id for stable ids, and assertions for checking behavior. It also compares the open-descendant result with the direct StateRuntime query to make sure the local store’s translation layer matches the database behavior.

*Call graph*: calls 1 internal fn (new); 3 external calls (state_runtime, thread_id, assert_eq!).


### `agent-graph-store/src/lib.rs`

`other` · `cross-cutting`

This file does not contain the storage logic itself. Instead, it organizes the crate and decides what outside code is allowed to use. The crate is about tracking a small graph of relationships: when one agent starts another agent or thread, there is a parent-to-child connection, much like a family tree. Keeping that topology separate from any one storage backend means the rest of the system can ask the same questions no matter where the data is kept.

The file pulls in four internal modules: errors, a local in-memory or local implementation, the shared store interface, and common types. Then it re-exports the important public names so callers can import them from this crate directly. That keeps other parts of the project from needing to know the internal folder layout.

The exported items are the error and result types used when graph operations fail, the local store implementation, the main `AgentGraphStore` abstraction, and `ThreadSpawnEdgeStatus`, which describes the state of a parent/child thread-spawn connection. Without this file, the crate would still have internal pieces, but they would be harder or impossible for the rest of the system to reach cleanly.
