# Rollout files and thread-store persistence  `stage-21.1`

This stage is the system’s long-term memory. It sits behind the main work loop and makes sure conversation threads can be saved, found again, searched, and removed later, even after the program exits.

The rollout files are the raw on-disk session logs. The rollout crate is the toolkit around those logs: recorder writes and replays them, list discovers and summarizes them, search scans them for matching text, session_index keeps a small side file of thread names, and compression quietly turns old logs into smaller compressed files without changing how the rest of the code reads them. message-history is a separate global history file that keeps an append-only record of messages across sessions.

The thread-store crate puts a cleaner, storage-neutral interface on top of all this. store defines the contract: create, append, read, list, archive, search, and delete threads. in_memory provides a simple fake version for tests. The local implementation is the real filesystem-backed version: live_writer updates active threads, read_thread reconstructs saved threads, list_threads and search_threads power browsing, delete_thread removes data, and helpers smooth over older file formats. core/src/rollout.rs connects the app’s config into this persistence layer.

## Files in this stage

### Rollout crate surface
These files define the rollout subsystem’s public API and bridge the main application configuration into rollout-specific types and helpers.

### `core/src/rollout.rs`

`orchestration` · `cross-cutting integration used whenever rollout/session archival code needs config access`

This file is mostly an integration shim between core configuration and the rollout/session archival subsystem implemented in `codex_rollout`. At the top it re-exports a broad set of rollout constants, data types, sorting/paging helpers, and lookup functions so the rest of the core crate can consume rollout functionality through this module rather than depending directly on the external crate's paths. It also exposes a small nested `list` module and a test-only `recorder` module that selectively re-export rollout helpers for narrower use sites.

The only executable logic is the implementation of `codex_rollout::RolloutConfigView` for the local `Config` type. Each trait method is a direct field projection: filesystem paths are returned as `&Path` references via `.as_path()`, the model provider ID is returned as `&str` via `.as_str()`, and the memory-generation flag is forwarded from `self.memories.generate_memories`. This trait implementation is what allows generic rollout code to read the core application's home directories, current working directory, provider identity, and memory-generation setting without depending on the full `Config` definition.

The file also re-exports `map_session_init_error` and a `truncation` module from crate-local code, making rollout-related initialization and truncation helpers available alongside the rollout facade.

#### Function details

##### `Config::codex_home`  (lines 27–29)

```
fn codex_home(&self) -> &std::path::Path
```

**Purpose**: Exposes the configured Codex home directory to rollout code through the `RolloutConfigView` trait. It is a direct borrowed view into `Config`.

**Data flow**: It reads `self.codex_home` and returns `self.codex_home.as_path()` as `&Path`. No allocation or mutation occurs.

**Call relations**: This trait method is invoked by generic `codex_rollout` code whenever it needs the Codex home root from a core `Config`. It is part of the trait bridge implemented in this file.


##### `Config::sqlite_home`  (lines 31–33)

```
fn sqlite_home(&self) -> &std::path::Path
```

**Purpose**: Exposes the configured SQLite storage directory to rollout code. It forwards the path from the core config object unchanged.

**Data flow**: It reads `self.sqlite_home` and returns a borrowed `&Path` via `.as_path()`. It has no side effects.

**Call relations**: This method is called by rollout components operating through `RolloutConfigView` when they need the SQLite home path.


##### `Config::cwd`  (lines 35–37)

```
fn cwd(&self) -> &std::path::Path
```

**Purpose**: Exposes the current working directory recorded in `Config` to rollout code. It allows rollout helpers to resolve workspace-relative behavior against the active session directory.

**Data flow**: It reads `self.cwd` and returns `self.cwd.as_path()` as a borrowed path reference. It does not mutate state.

**Call relations**: This trait method is consumed by `codex_rollout` logic through the `RolloutConfigView` abstraction alongside the other config projections in this file.


##### `Config::model_provider_id`  (lines 39–41)

```
fn model_provider_id(&self) -> &str
```

**Purpose**: Exposes the configured model provider identifier string to rollout code. It returns a borrowed string slice rather than cloning.

**Data flow**: It reads `self.model_provider_id` and returns `self.model_provider_id.as_str()`. No state changes occur.

**Call relations**: This method participates in the `RolloutConfigView` implementation used by rollout recording and metadata generation code that needs provider identity.


##### `Config::generate_memories`  (lines 43–45)

```
fn generate_memories(&self) -> bool
```

**Purpose**: Reports whether memory generation is enabled in the current configuration for rollout-related consumers. It forwards the nested boolean flag from `Config`.

**Data flow**: It reads `self.memories.generate_memories` and returns that `bool`. It performs no mutation.

**Call relations**: This trait method is called by rollout code through `RolloutConfigView` when deciding whether memory-related rollout behavior should be active.


### `rollout/src/lib.rs`

`orchestration` · `cross-cutting`

This file is the crate root for rollout persistence. It declares the internal modules that implement compression, configuration, listing, metadata extraction, persistence policy, recording, search, session-name indexing, SQLite metrics, and the state database, then selectively re-exports the types and functions that form the crate’s supported API. The result is a façade: consumers import `rollout` and get session-file path helpers, line readers, thread listing and cursor types, metadata builders, persistence filters, recorder types, search helpers, thread-name index operations, and the SQLite-backed `StateDbHandle` from one place.

Two directory-name constants, `SESSIONS_SUBDIR` and `ARCHIVED_SESSIONS_SUBDIR`, establish the on-disk layout expected by the rest of the crate. A lazily initialized static, `INTERACTIVE_SESSION_SOURCES`, defines the `SessionSource` values treated as interactive sessions: built-in CLI and VSCode sources plus custom `atlas` and `chatgpt` labels. Because it uses `LazyLock<Vec<SessionSource>>`, the allocation happens once on first access and then becomes shared immutable state.

The file also re-exports protocol types from `codex_protocol`, including `SessionMeta`, and exposes `codex_login::default_client` through a nested module so rollout internals can share the standard login client wiring. A deprecated alias preserves compatibility for older callers still using the conversation-path naming.


### Rollout storage primitives
These files provide the low-level persistence mechanisms for rollout files, sidecar naming indexes, global message history, and text search over stored transcripts.

### `message-history/src/lib.rs`

`io_transport` · `cross-cutting during message append, history inspection, and lookup`

This library defines the history data model and all file operations around it. `HistoryEntry` is the JSONL record schema (`session_id`, `ts`, `text`), while `HistoryConfig` captures the Codex home directory, persistence mode, and optional byte cap derived from config. `history_filepath` resolves the fixed `history.jsonl` path under `codex_home`.

`append_entry` is the main async write path. It first honors `HistoryPersistence::None` by returning early, ensures the parent directory exists, computes the current Unix timestamp, serializes a `HistoryEntry` to one JSON line plus trailing newline, opens the file for read/write/create (with `append(true)` and mode `0o600` on Unix), normalizes permissions via `ensure_owner_only_permissions`, and then moves the blocking lock/write/trim work into `spawn_blocking`. Inside that closure it retries `try_lock()` up to `MAX_RETRIES`, seeks to end, writes and flushes the full line, then calls `enforce_history_limit` while still holding the exclusive lock.

`enforce_history_limit` trims by whole lines only. If the file exceeds `max_bytes`, it scans line lengths, computes a soft-cap target via `trim_target_bytes` (80% of the hard cap, but never below the newest entry length), drops oldest lines until the retained tail fits, then rewrites the file with just that tail. Read-side helpers split responsibilities: `history_metadata`/`history_metadata_for_file` count newline bytes asynchronously and return a stable file identifier plus entry count; `lookup`/`lookup_history_entry` synchronously open the file, verify the identifier via `log_identity`, acquire a shared advisory lock with retries, and parse the requested zero-based line as JSON. The design favors append-only writes, whole-line trimming, and stable `(log_id, offset)` addressing across appends while degrading gracefully on missing files and parse/I/O failures.

#### Function details

##### `HistoryConfig::new`  (lines 70–76)

```
fn new(codex_home: impl Into<PathBuf>, history: &History) -> Self
```

**Purpose**: Builds the runtime history configuration from a Codex home path and the higher-level `History` config section. It extracts only the fields this crate needs for persistence decisions and size enforcement.

**Data flow**: It takes `codex_home: impl Into<PathBuf>` and `&History`, converts the home path into a `PathBuf`, copies `history.persistence` and `history.max_bytes`, and returns a new `HistoryConfig`.

**Call relations**: Callers constructing session or persistence state use this as the adapter from config-layer types into this crate’s simpler runtime config; tests also use it to vary `max_bytes` and persistence behavior.

*Call graph*: called by 6 (append_entry_trims_history_to_soft_cap, append_entry_trims_history_when_beyond_max_bytes, append_message_history_entry, lookup_message_history_entry, session_configured_populates_history_metadata, thread_session_state_from_thread_response); 1 external calls (into).


##### `history_filepath`  (lines 79–81)

```
fn history_filepath(config: &HistoryConfig) -> PathBuf
```

**Purpose**: Resolves the absolute path of the JSONL history file under the configured Codex home directory.

**Data flow**: It reads `config.codex_home`, joins it with the constant `HISTORY_FILENAME`, and returns the resulting `PathBuf`.

**Call relations**: This private helper is the common path resolver used by `append_entry`, `history_metadata`, and `lookup` so all operations target the same file location.

*Call graph*: called by 3 (append_entry, history_metadata, lookup).


##### `append_entry`  (lines 98–183)

```
async fn append_entry(
    text: &str,
    conversation_id: impl std::fmt::Display,
    config: &HistoryConfig,
) -> Result<()>
```

**Purpose**: Appends one message to the history file as a single JSONL record, under an advisory exclusive lock, and optionally trims the file to the configured size budget.

**Data flow**: It takes message text, a displayable conversation id, and `&HistoryConfig`. It first checks `config.persistence`, returning immediately for `HistoryPersistence::None`. For `SaveAll`, it resolves the file path, creates the parent directory if needed, computes the current Unix timestamp, builds a `HistoryEntry`, serializes it to JSON, appends `\n`, opens the file with read/write/create (plus append and mode `0o600` on Unix), and calls `ensure_owner_only_permissions`. It then moves the file handle, serialized line, and optional `max_bytes` into `spawn_blocking`, where it retries `try_lock`, seeks to end, writes and flushes the line, invokes `enforce_history_limit`, and returns any I/O or lock-acquisition error.

**Call relations**: This is the primary write API used by higher-level session code. It delegates path resolution to `history_filepath`, permission normalization to `ensure_owner_only_permissions`, and post-write trimming to `enforce_history_limit` while keeping all blocking lock/file operations off the async runtime.

*Call graph*: calls 2 internal fn (ensure_owner_only_permissions, history_filepath); 6 external calls (to_string, new, to_string, now, create_dir_all, spawn_blocking).


##### `enforce_history_limit`  (lines 189–262)

```
fn enforce_history_limit(file: &mut File, max_bytes: Option<usize>) -> Result<()>
```

**Purpose**: Shrinks the history file to fit within the configured byte budget by dropping whole oldest lines while always retaining the newest appended entry.

**Data flow**: It takes a mutable locked `File` and `Option<usize> max_bytes`. If the limit is absent, zero, too large to convert to `u64`, or the current file length is already within bounds, it returns immediately. Otherwise it clones the file, seeks to start, reads line-by-line through a `BufReader` to collect each line length, computes a trim target with `trim_target_bytes(max_bytes, newest_entry_len)`, accumulates `drop_bytes` by subtracting oldest line lengths until the retained size is at or below the target, seeks a reader to `drop_bytes`, reads the remaining tail into memory, truncates the original file to length 0, seeks back to start, writes the tail, flushes, and returns.

**Call relations**: Only `append_entry` calls this, and specifically while holding the exclusive file lock so trimming and appending are atomic with respect to concurrent writers.

*Call graph*: calls 1 internal fn (trim_target_bytes); 13 external calls (new, flush, metadata, seek, set_len, try_clone, write_all, Start, new, new (+3 more)).


##### `trim_target_bytes`  (lines 264–270)

```
fn trim_target_bytes(max_bytes: u64, newest_entry_len: u64) -> u64
```

**Purpose**: Computes the post-trim target size used when the history exceeds its hard cap. It intentionally trims below the hard cap to reduce immediate retrimming on the next append.

**Data flow**: It takes `max_bytes` and the newest entry length, computes `floor(max_bytes * HISTORY_SOFT_CAP_RATIO)` clamped to `[1, max_bytes]`, then returns the maximum of that soft cap and `newest_entry_len`.

**Call relations**: This helper is used only by `enforce_history_limit` to decide how aggressively to prune once the hard cap has been exceeded.

*Call graph*: called by 1 (enforce_history_limit).


##### `history_metadata`  (lines 279–282)

```
async fn history_metadata(config: &HistoryConfig) -> (u64, usize)
```

**Purpose**: Returns a stable identifier for the current history file together with the current number of entries. It is the async public wrapper around file-specific metadata scanning.

**Data flow**: It takes `&HistoryConfig`, resolves the history path with `history_filepath`, awaits `history_metadata_for_file(&path)`, and returns the `(log_id, count)` tuple.

**Call relations**: Higher-level code uses this before random-access lookup so it can later ask for a specific line offset against a specific file identity; the actual scanning work is delegated to `history_metadata_for_file`.

*Call graph*: calls 2 internal fn (history_filepath, history_metadata_for_file).


##### `lookup`  (lines 294–297)

```
fn lookup(log_id: u64, offset: usize, config: &HistoryConfig) -> Option<HistoryEntry>
```

**Purpose**: Fetches a single history entry by zero-based line offset, but only if the current history file still matches the caller’s expected file identity.

**Data flow**: It takes a `log_id`, `offset`, and `&HistoryConfig`, resolves the history path via `history_filepath`, calls `lookup_history_entry(&path, log_id, offset)`, and returns `Option<HistoryEntry>`.

**Call relations**: This is the public read API paired with `history_metadata`; callers first obtain `(log_id, count)` and later use `lookup` to safely dereference an offset only if the file has not been replaced.

*Call graph*: calls 2 internal fn (history_filepath, lookup_history_entry).


##### `ensure_owner_only_permissions`  (lines 317–319)

```
async fn ensure_owner_only_permissions(_file: &File) -> Result<()>
```

**Purpose**: On Unix, enforces `0o600` permissions on the history file so only the owner can read or write it.

**Data flow**: It reads the file metadata, masks the current mode to permission bits, and if the mode is not already `0o600`, clones the permissions and file handle and uses `spawn_blocking` to call `set_permissions` on the clone. It returns `Ok(())` if no change is needed or after the update succeeds.

**Call relations**: `append_entry` invokes this immediately after opening the file, before entering the blocking lock/write section, to keep the history file private.

*Call graph*: called by 1 (append_entry); 3 external calls (metadata, try_clone, spawn_blocking).


##### `history_metadata_for_file`  (lines 321–348)

```
async fn history_metadata_for_file(path: &Path) -> (u64, usize)
```

**Purpose**: Scans a specific history file asynchronously to derive its stable identity and count how many newline-terminated entries it contains.

**Data flow**: It takes a `&Path`, first calls `fs::metadata(path)`; if the file is missing or metadata fails it returns `(0, 0)`, otherwise it derives `log_id` with `log_identity`. It then opens the file asynchronously; if open fails it returns `(log_id, 0)`. Next it repeatedly reads into an `HISTORY_READ_BUFFER_SIZE` byte buffer, counts `b'\n'` bytes in each chunk using `memchr_iter`, accumulates the total, and returns `(log_id, count)`. Any read error after metadata/open also yields `(log_id, 0)`.

**Call relations**: This private async worker backs the public `history_metadata` API. It separates existence/identity detection from line counting so callers can still detect that a file exists even if scanning fails.

*Call graph*: calls 1 internal fn (log_identity); called by 1 (history_metadata); 3 external calls (open, metadata, memchr_iter).


##### `lookup_history_entry`  (lines 350–417)

```
fn lookup_history_entry(path: &Path, log_id: u64, offset: usize) -> Option<HistoryEntry>
```

**Purpose**: Synchronously opens the history file, verifies its identity, acquires a shared advisory lock, and parses the requested line as a `HistoryEntry`.

**Data flow**: It takes a file path, expected `log_id`, and zero-based `offset`. It opens the file read-only with `OpenOptions`; on failure it logs a warning and returns `None`. It then reads metadata, derives `current_log_id` via `log_identity`, and if the caller supplied a nonzero `log_id` that does not match, returns `None`. Next it retries `file.try_lock_shared()` up to `MAX_RETRIES`, sleeping `RETRY_SLEEP` between `WouldBlock` results. Once locked, it wraps `&file` in a `BufReader`, iterates `lines().enumerate()`, and when `idx == offset` attempts `serde_json::from_str::<HistoryEntry>(&line)`, returning `Some(entry)` on success or logging and returning `None` on read/parse failure. If the offset is past EOF or locking never succeeds, it returns `None`.

**Call relations**: The public `lookup` wrapper delegates directly to this function. It is intentionally synchronous because it uses advisory shared locking; async callers are expected to place it in `spawn_blocking` if needed.

*Call graph*: calls 1 internal fn (log_identity); called by 1 (lookup); 4 external calls (new, new, sleep, warn!).


##### `log_identity`  (lines 432–434)

```
fn log_identity(_metadata: &std::fs::Metadata) -> Option<u64>
```

**Purpose**: Extracts the platform-specific stable identifier used to detect whether a history file is the same file across metadata and lookup operations.

**Data flow**: On Unix it reads `metadata.ino()`, on Windows `metadata.creation_time()`, and on unsupported platforms returns `None`. The result is wrapped in `Option<u64>`.

**Call relations**: Both `history_metadata_for_file` and `lookup_history_entry` use this to coordinate `(log_id, offset)` addressing and reject lookups against a replaced file.

*Call graph*: called by 2 (history_metadata_for_file, lookup_history_entry); 2 external calls (creation_time, ino).


### `rollout/src/compression.rs`

`io_transport` · `rollout file reads, append preparation, and periodic background maintenance/compression`

This file has three major responsibilities. First, it resolves and reads rollout files regardless of whether they exist as plain `.jsonl` or compressed `.jsonl.zst`. `open_rollout_line_reader` retries briefly across representation transitions, and `RolloutLineReader` abstracts over async plain-file reading versus blocking zstd decoding wrapped in `spawn_blocking`. Second, it materializes compressed rollouts back to plain files for append paths. `materialize_rollout_for_append_blocking` preserves permissions, writes through a uniquely named temp file, installs the plain file without clobbering an existing winner, removes the compressed sibling when successful, and records metrics for plain/missing/decompressed/failed outcomes.

Third, the nested `worker` module runs best-effort background compression over active and archived session trees. It uses `CompressionRunMarker` under `codex_home/.tmp` to avoid overlapping or too-frequent runs, cleans stale temp files, scans directories recursively, and compresses at most two files concurrently. Compression is conservative: only files older than `MIN_ROLLOUT_AGE` are eligible, compressed output is verified by decoding it, original file metadata is preserved, and the source file is deleted only if the file's size, mtime, and permissions still match the pre-compression snapshot. If the source changed mid-run or a compressed sibling already exists, the worker records a skipped outcome instead of risking data loss.

Supporting modules handle metrics emission, path normalization between plain/compressed names, rollout filename validation, and platform-specific file creation with preserved permissions.

#### Function details

##### `spawn_rollout_compression_worker`  (lines 29–31)

```
fn spawn_rollout_compression_worker(codex_home: PathBuf)
```

**Purpose**: Starts the fire-and-forget background compression worker for a given Codex home directory. It is the public entrypoint used by the rest of the rollout subsystem.

**Data flow**: Accepts `codex_home: PathBuf` and forwards it to `worker::spawn`. It returns no value and performs no direct I/O itself.

**Call relations**: Called during rollout subsystem setup when background maintenance should begin. All runtime detection, logging, and actual work are delegated to `worker::spawn`.

*Call graph*: 1 external calls (spawn).


##### `file_modified_time`  (lines 34–41)

```
async fn file_modified_time(path: &Path) -> io::Result<Option<time::OffsetDateTime>>
```

**Purpose**: Returns the modification time of the logical rollout file, whether it currently exists in plain or compressed form. Missing files are reported as `Ok(None)` rather than errors.

**Data flow**: Accepts `&Path`, resolves the existing physical path via `path::existing_rollout_path(path).await`, returns `Ok(None)` if neither representation exists, otherwise fetches metadata with `tokio::fs::metadata`, extracts `modified()`, converts it to `time::OffsetDateTime`, and wraps it in `Some`.

**Call relations**: Used by listing code to compute `updated_at` timestamps and by wrappers that expose UTC modification times. It delegates representation resolution to the `path` module.

*Call graph*: called by 2 (file_modified_time, file_modified_time_utc); 2 external calls (existing_rollout_path, metadata).


##### `open_rollout_line_reader`  (lines 47–58)

```
async fn open_rollout_line_reader(path: &Path) -> io::Result<RolloutLineReader>
```

**Purpose**: Opens a line reader over a rollout file that may be plain or compressed, retrying briefly if the file disappears during a representation transition. This shields callers from races between compression/materialization and reads.

**Data flow**: Accepts `&Path` and loops up to `MAX_NOT_FOUND_RETRIES`. Each iteration calls `reader::open_once(path).await`; success returns the `RolloutLineReader`, `NotFound` sleeps for `OPEN_ROLLOUT_LINE_READER_RETRY_DELAY`, and any other error returns immediately. After retries are exhausted it performs one final `open_once`.

**Call relations**: Called by summary extraction, rollout loading, and search paths that need line-oriented reads. It delegates actual open logic to `reader::open_once` and only adds retry behavior.

*Call graph*: called by 5 (read_head_for_summary, read_head_summary, load_rollout_items, first_rollout_content_match_snippet, rollout_contains); 2 external calls (open_once, sleep).


##### `compressed_rollout_path`  (lines 62–64)

```
fn compressed_rollout_path(path: &Path) -> PathBuf
```

**Purpose**: Returns the `.jsonl.zst` path corresponding to a rollout path. This test-only wrapper exposes the internal path helper.

**Data flow**: Accepts `&Path` and returns `path::compressed_rollout_path(path)`. It performs no I/O.

**Call relations**: Used by tests that need to assert on compressed sibling paths without reaching into the private `path` module.

*Call graph*: called by 1 (existing_rollout_path); 1 external calls (compressed_rollout_path).


##### `materialize_rollout_for_append`  (lines 67–72)

```
async fn materialize_rollout_for_append(path: &Path) -> io::Result<PathBuf>
```

**Purpose**: Asynchronously converts a compressed rollout back into its plain `.jsonl` representation so append code can write to it. The blocking filesystem and decompression work is offloaded from the async runtime.

**Data flow**: Accepts `&Path`, clones it into a `PathBuf`, runs `materialize_rollout_for_append_blocking(path.as_path())` inside `tokio::task::spawn_blocking`, maps join errors to `io::Error::other`, and returns the resulting plain path.

**Call relations**: Called by async append/resume paths before opening a rollout for writing. It delegates all actual materialization logic to the blocking helper.

*Call graph*: called by 2 (new, append_rollout_item_to_path); 2 external calls (to_path_buf, spawn_blocking).


##### `materialize_rollout_for_append_blocking`  (lines 75–121)

```
fn materialize_rollout_for_append_blocking(path: &Path) -> io::Result<PathBuf>
```

**Purpose**: Performs the blocking materialization of a compressed rollout into a plain file while preserving permissions and avoiding clobber races. It is careful to leave a consistent winner if multiple actors race to materialize.

**Data flow**: Accepts `&Path`, normalizes to the plain path with `plain_rollout_path`, and returns early with metrics if the plain file already exists or no compressed sibling exists. Otherwise it computes the compressed path and a unique temp path, creates parent directories, reads source permissions from the compressed file, decompresses through `zstd::stream::read::Decoder` into a temp file created by `create_file_with_permissions`, flushes and syncs it, then tries to install the plain file via hard link or `persist_temp_file_noclobber`. On success it removes the temp file and compressed file, records `materialize("decompressed")`, and returns the plain path; on failure it cleans up temp state, records `materialize("failed")`, and returns the error.

**Call relations**: Called by `materialize_rollout_for_append` and blocking append paths. It relies on path helpers, temp-path generation, permission-preserving file creation, and no-clobber persistence to safely switch representations.

*Call graph*: calls 2 internal fn (plain_rollout_path, temp_path_for); called by 1 (open_log_file); 4 external calls (materialize, compressed_rollout_path, create_dir_all, remove_file).


##### `persist_temp_file_noclobber`  (lines 123–130)

```
fn persist_temp_file_noclobber(temp_path: &Path, destination: &Path) -> io::Result<()>
```

**Purpose**: Installs a completed temp file at a destination only if the destination does not already exist. Existing winners are preserved without error.

**Data flow**: Accepts temp and destination paths, converts the temp path into `tempfile::TempPath`, calls `persist_noclobber(destination)`, returns `Ok(())` on success or on `AlreadyExists`, and otherwise returns the underlying I/O error.

**Call relations**: Used by materialization when hard-link installation fails and by tests that verify no-clobber semantics.

*Call graph*: 2 external calls (persist_noclobber, try_from_path).


##### `plain_rollout_path`  (lines 133–135)

```
fn plain_rollout_path(path: &Path) -> PathBuf
```

**Purpose**: Returns the canonical plain `.jsonl` path for either a plain or compressed rollout path. It strips the compression suffix when present.

**Data flow**: Accepts `&Path` and returns `path::plain_rollout_path(path)`. No filesystem access occurs.

**Call relations**: Used by materialization and path-resolution code whenever callers need the logical plain filename regardless of current representation.

*Call graph*: called by 3 (materialize_rollout_for_append_blocking, existing_rollout_path, should_skip_compressed_sibling); 1 external calls (plain_rollout_path).


##### `parse_rollout_file_name`  (lines 138–140)

```
fn parse_rollout_file_name(name: &str) -> Option<&str>
```

**Purpose**: Validates a rollout filename and returns its canonical plain `.jsonl` name, stripping a trailing `.zst` when present. Non-rollout names return `None`.

**Data flow**: Accepts `&str` and forwards to `file_name::parse_rollout_file_name(name)`, returning `Option<&str>`.

**Call relations**: Used by listing and discovery code that parses timestamps and ids from filenames while treating compressed and plain names uniformly.

*Call graph*: 1 external calls (parse_rollout_file_name).


##### `RolloutFile::from_path`  (lines 159–170)

```
fn from_path(path: PathBuf) -> Option<Self>
```

**Purpose**: Builds a logical rollout-file entry from a discovered physical path, normalizing compressed names and hiding compressed siblings when a plain file already exists. It prevents callers from reimplementing precedence rules.

**Data flow**: Consumes a `PathBuf`, extracts its UTF-8 filename, validates it with `file_name::parse_rollout_file_name`, and checks `path::should_skip_compressed_sibling(path.as_path())`. If valid and not hidden, it returns `Some(RolloutFile { path, plain_file_name })`; otherwise `None`.

**Call relations**: Used by worker scans, listing scans, search, and id lookup. It is the common normalization layer between raw directory entries and logical rollout files.

*Call graph*: called by 7 (compress_rollouts_in_root, collect_flat_files_by_updated_at, collect_flat_rollout_files, find_rollout_path_by_id_from_filenames, collect_rollout_paths, scan_compressed_rollout_matches, scan_rollout_matches); 4 external calls (as_path, file_name, parse_rollout_file_name, should_skip_compressed_sibling).


##### `RolloutFile::path`  (lines 173–175)

```
fn path(&self) -> &Path
```

**Purpose**: Returns the physical path that should be opened for this logical rollout file. This may be either plain or compressed.

**Data flow**: Borrows `self` and returns `self.path.as_path()`.

**Call relations**: Used by callers that need to inspect or open the chosen physical representation without consuming the `RolloutFile`.

*Call graph*: 1 external calls (as_path).


##### `RolloutFile::plain_file_name`  (lines 178–180)

```
fn plain_file_name(&self) -> &str
```

**Purpose**: Returns the canonical plain `.jsonl` filename associated with this logical rollout file. This is the name used for timestamp and UUID parsing.

**Data flow**: Borrows `self` and returns `self.plain_file_name.as_str()`.

**Call relations**: Used by listing and lookup code that parses metadata from filenames while ignoring whether the physical file is compressed.


##### `RolloutFile::is_compressed`  (lines 183–185)

```
fn is_compressed(&self) -> bool
```

**Purpose**: Reports whether the physical path for this logical rollout file is the compressed representation. It distinguishes `.jsonl.zst` entries from plain `.jsonl` entries.

**Data flow**: Borrows `self`, passes `self.path.as_path()` to `path::is_compressed_rollout_path`, and returns the resulting boolean.

**Call relations**: Used by the compression worker to skip already-compressed files during scans.

*Call graph*: 2 external calls (as_path, is_compressed_rollout_path).


##### `RolloutFile::into_path`  (lines 188–190)

```
fn into_path(self) -> PathBuf
```

**Purpose**: Consumes the logical rollout-file wrapper and returns the underlying physical path. It is the ownership-taking counterpart to `path()`.

**Data flow**: Consumes `self` and returns `self.path`.

**Call relations**: Used when scan code has finished using the normalized wrapper and wants to store or open the actual path.


##### `RolloutLineReader::next_line`  (lines 205–220)

```
async fn next_line(&mut self) -> io::Result<Option<String>>
```

**Purpose**: Reads the next JSONL line from either a plain async file or a blocking compressed decoder. It hides the representation-specific mechanics behind one async method.

**Data flow**: Borrows `&mut self` and matches `self.inner`. For `Plain`, it awaits `lines.next_line()`. For `Blocking`, it temporarily takes the `BlockingLineReader` out of the `Option`, errors if it was already taken (`"compressed rollout reader is busy"`), runs `reader.next().transpose()` inside `spawn_blocking`, restores the reader into the slot, and returns the line result.

**Call relations**: Called by rollout summary and loading code after `open_rollout_line_reader`. The temporary `Option` dance prevents concurrent use of the same blocking decoder.

*Call graph*: 2 external calls (other, spawn_blocking).


##### `worker::CompressionRunMarker::try_claim`  (lines 274–302)

```
fn try_claim(codex_home: &Path) -> io::Result<Option<Self>>
```

**Purpose**: Attempts to claim the per-home compression run marker, reusing a stale marker if necessary. It prevents overlapping or too-frequent worker runs.

**Data flow**: Accepts `codex_home: &Path`, ensures `codex_home/.tmp` exists, computes the marker path, and tries `create_run_marker_file`. If creation succeeds it returns `Some(Self::new(path))`. If the marker already exists, it checks its age from metadata/modified time; a fresh marker yields `Ok(None)`, while a stale marker is removed and creation is retried. Other I/O errors propagate.

**Call relations**: Called at the start of `worker::run` to decide whether the worker should proceed. It delegates file creation to `create_run_marker_file` and marker construction to `new`.

*Call graph*: 6 external calls (join, new, create_run_marker_file, create_dir_all, metadata, remove_file).


##### `worker::CompressionRunMarker::new`  (lines 304–309)

```
fn new(path: PathBuf) -> Self
```

**Purpose**: Constructs a claimed run marker that will remove its file on drop unless persisted. It is the internal owner type for the lock file lifecycle.

**Data flow**: Accepts a marker `PathBuf` and returns `CompressionRunMarker { path, remove_on_drop: true }`.

**Call relations**: Used only by `try_claim` after successfully creating or reclaiming the marker file.


##### `worker::CompressionRunMarker::persist`  (lines 311–313)

```
fn persist(mut self)
```

**Purpose**: Marks the run marker so it survives drop after a successful worker run. This leaves a freshness marker that throttles subsequent runs.

**Data flow**: Consumes `self` mutably and sets `remove_on_drop = false`. It returns no value.

**Call relations**: Called at the end of a successful `worker::run` after metrics and logging have been recorded.


##### `worker::CompressionRunMarker::drop`  (lines 317–321)

```
fn drop(&mut self)
```

**Purpose**: Removes the marker file when the marker owner is dropped, unless it was persisted. This automatically cleans up failed or aborted runs.

**Data flow**: On drop, checks `remove_on_drop`; if true, it attempts `std::fs::remove_file(self.path.as_path())` and ignores any error.

**Call relations**: Runs implicitly when `CompressionRunMarker` leaves scope. It complements `persist` by making unsuccessful runs self-cleaning.

*Call graph*: 2 external calls (as_path, remove_file).


##### `worker::spawn`  (lines 324–341)

```
fn spawn(codex_home: PathBuf)
```

**Purpose**: Schedules the async compression worker on the current Tokio runtime if one exists, otherwise logs and records a skipped metric. It is the runtime-aware launcher for background compression.

**Data flow**: Accepts `codex_home: PathBuf`, tries `tokio::runtime::Handle::try_current()`, and if unavailable records `metrics::run("skipped_no_runtime")` and logs a warning. If a runtime exists, it spawns an async task that awaits `run(codex_home.clone())` and logs any returned error.

**Call relations**: Called by the public `spawn_rollout_compression_worker`. It delegates actual work to `run` and only handles runtime availability and detached task spawning.

*Call graph*: 5 external calls (clone, run, run, try_current, warn!).


##### `worker::run`  (lines 343–393)

```
async fn run(codex_home: PathBuf) -> io::Result<()>
```

**Purpose**: Executes one full compression-worker pass: claim marker, clean stale temps, scan active and archived roots, compress eligible files, emit metrics, and persist the run marker on success. It is the worker's main orchestration function.

**Data flow**: Accepts `codex_home: PathBuf`, claims a marker with `CompressionRunMarker::try_claim`, records skip/start/failure/completion metrics, captures `started_at`, runs `cleanup_stale_temps`, then iterates over `archived_sessions` and `sessions` roots calling `compress_rollouts_in_root` until `WORKER_MAX_RUNTIME` is reached. On success it logs aggregate stats, records duration metrics, calls `marker.persist()`, and returns `Ok(())`; on failure it records failed metrics and returns the error.

**Call relations**: Spawned by `worker::spawn` and directly invoked by tests. It coordinates the marker, cleanup, scanning, compression jobs, and metrics helpers.

*Call graph*: 11 external calls (now, as_path, join, debug!, info!, run, run_duration, try_claim, default, cleanup_stale_temps (+1 more)).


##### `worker::create_run_marker_file`  (lines 395–407)

```
fn create_run_marker_file(path: &Path) -> io::Result<()>
```

**Purpose**: Creates the lock file for a compression run and writes a small diagnostic header containing pid and start time. It uses create-new semantics so concurrent claims fail cleanly.

**Data flow**: Accepts `&Path`, opens it with `OpenOptions::new().write(true).create_new(true)`, writes `pid=<pid> started_at=<SystemTime>` via `writeln!`, and returns `Ok(())` or the I/O error.

**Call relations**: Used only by `CompressionRunMarker::try_claim` when claiming or reclaiming the run marker.

*Call graph*: 2 external calls (new, writeln!).


##### `worker::compress_rollouts_in_root`  (lines 409–485)

```
async fn compress_rollouts_in_root(
        root: &Path,
        started_at: Instant,
        stats: &mut CompressionStats,
    ) -> io::Result<()>
```

**Purpose**: Recursively scans one rollout root directory, queues compression jobs for eligible plain rollout files, and collects their outcomes with bounded concurrency. It is the worker's directory traversal and job scheduling loop.

**Data flow**: Accepts a root path, worker start time, and mutable `CompressionStats`. It returns early if the root does not exist, then depth-first traverses directories with a stack and `tokio::fs::read_dir`. For each regular file it builds `RolloutFile::from_path`, skips non-rollouts and compressed files, increments `stats.scanned` and metrics, throttles to `MAX_CONCURRENT_COMPRESSION_JOBS` by awaiting `collect_next_compression_job`, and spawns blocking jobs that call `compress_rollout_if_cold_blocking`. At the end it drains remaining jobs.

**Call relations**: Called by `worker::run` for both active and archived roots. It delegates actual compression to `compress_rollout_if_cold_blocking` and result accounting to `collect_next_compression_job`/`drain_compression_jobs`.

*Call graph*: calls 1 internal fn (from_path); 9 external calls (elapsed, new, file, collect_next_compression_job, drain_compression_jobs, read_dir, try_exists, vec!, warn!).


##### `worker::CompressionOutcome::tag`  (lines 498–505)

```
fn tag(self) -> &'static str
```

**Purpose**: Returns the metric tag string corresponding to a compression outcome enum variant. It standardizes labels used across counters and histograms.

**Data flow**: Matches `self` and returns one of the static strings `compressed`, `skipped_not_cold`, `skipped_changed`, or `skipped_already_compressed`.

**Call relations**: Used by job-result collection when recording per-file metrics.


##### `worker::CompressionMeasurement::new`  (lines 515–525)

```
fn new(
            outcome: CompressionOutcome,
            source_bytes: Option<u64>,
            compressed_bytes: Option<u64>,
        ) -> Self
```

**Purpose**: Constructs a measurement object summarizing one compression attempt's outcome and optional byte counts. It packages data for later metrics emission.

**Data flow**: Accepts a `CompressionOutcome`, optional source byte count, and optional compressed byte count, and returns `CompressionMeasurement { outcome, source_bytes, compressed_bytes }`.

**Call relations**: Used by `compress_rollout_if_cold_blocking` to report whether a file was compressed or skipped and with what sizes.


##### `worker::drain_compression_jobs`  (lines 533–540)

```
async fn drain_compression_jobs(
        jobs: &mut JoinSet<CompressionJobResult>,
        stats: &mut CompressionStats,
    )
```

**Purpose**: Waits for all outstanding compression jobs to finish and folds their results into aggregate stats. It is the full-drain helper used at the end of a scan or before propagating certain errors.

**Data flow**: Accepts a mutable `JoinSet<CompressionJobResult>` and mutable `CompressionStats`, and repeatedly calls `collect_next_compression_job` until `jobs.is_empty()`.

**Call relations**: Called by `compress_rollouts_in_root` after traversal completes and on some early-error paths to ensure spawned jobs are accounted for.

*Call graph*: 2 external calls (is_empty, collect_next_compression_job).


##### `worker::collect_next_compression_job`  (lines 542–586)

```
async fn collect_next_compression_job(
        jobs: &mut JoinSet<CompressionJobResult>,
        stats: &mut CompressionStats,
    )
```

**Purpose**: Consumes one completed compression job, updates aggregate stats, emits metrics, and logs failures. It is the result-accounting step for worker concurrency control.

**Data flow**: Awaits `jobs.join_next()`. Successful jobs with `Ok(measurement)` increment `stats.compressed` or `stats.skipped` based on `measurement.outcome`, record file counters/durations and optional byte/ratio histograms. Jobs returning `Err(err)` increment `stats.failed`, record failed metrics, and log the path-specific warning. Join errors also increment failed stats and log a task-failure warning.

**Call relations**: Called by both `drain_compression_jobs` and `compress_rollouts_in_root` when concurrency limits require waiting for a slot.

*Call graph*: 7 external calls (join_next, compressed_bytes, compression_ratio, file, file_duration, source_bytes, warn!).


##### `worker::compress_rollout_if_cold_blocking`  (lines 588–657)

```
fn compress_rollout_if_cold_blocking(path: &Path) -> io::Result<CompressionMeasurement>
```

**Purpose**: Compresses one rollout file to zstd if it is old enough and unchanged throughout the operation, preserving metadata and avoiding races with concurrent writers. It is the worker's core file transformation routine.

**Data flow**: Accepts a source `&Path`, snapshots eligibility and metadata via `cold_file_state`, returns `SkippedNotCold` if too fresh or missing, returns `SkippedAlreadyCompressed` if the `.zst` sibling already exists, otherwise creates a temp file in the destination directory, writes compressed bytes with `encode_zstd_to_writer`, flushes, verifies the temp file by decoding it with `verify_zstd`, checks `same_file_state(path, &before)` before and after persisting, copies modified time and permissions with `set_file_metadata`, persists the temp file with `persist_noclobber`, removes the compressed file again if the source changed after persist, and finally deletes the original plain file only on a stable successful path. It returns a `CompressionMeasurement` describing compressed or skipped outcomes.

**Call relations**: Spawned in blocking worker jobs from `compress_rollouts_in_root`. It depends on file-state helpers and metadata-preservation helpers to make compression safe under concurrent modification.

*Call graph*: 10 external calls (compressed_rollout_path, new, cold_file_state, encode_zstd_to_writer, same_file_state, set_file_metadata, verify_zstd, create_dir_all, remove_file, new).


##### `worker::cold_file_state`  (lines 665–689)

```
fn cold_file_state(path: &Path) -> io::Result<ColdFileState>
```

**Purpose**: Determines whether a file is eligible for compression based on existence, file type, and age, while capturing the metadata needed for later race checks. It distinguishes cold files from fresh or missing ones.

**Data flow**: Accepts `&Path`, reads metadata, returns `ColdFileState::NotCold(None)` for missing or non-file paths, otherwise captures `len`, `modified`, and `permissions` into `FileState`, computes age from `SystemTime::now()`, and returns `Cold(state)` if age is at least `MIN_ROLLOUT_AGE` or `NotCold(Some(state))` if not.

**Call relations**: Called by `compress_rollout_if_cold_blocking` before any compression work begins.

*Call graph*: 4 external calls (now, Cold, NotCold, metadata).


##### `worker::same_file_state`  (lines 691–699)

```
fn same_file_state(path: &Path, expected: &FileState) -> io::Result<bool>
```

**Purpose**: Checks whether a file still matches a previously captured size, modification time, and permissions snapshot. It is used to detect concurrent changes during compression.

**Data flow**: Accepts a path and expected `FileState`, reads current metadata, and returns `Ok(true)` only if length, modified time, and permissions all match. Missing files return `Ok(false)`; other metadata errors propagate.

**Call relations**: Called by `compress_rollout_if_cold_blocking` before and after persisting the compressed file to decide whether compression should be committed or treated as skipped-changed.

*Call graph*: 1 external calls (metadata).


##### `worker::encode_zstd_to_writer`  (lines 701–707)

```
fn encode_zstd_to_writer(source: &Path, output: impl Write) -> io::Result<()>
```

**Purpose**: Streams a source file into a zstd encoder writing to the provided output sink. It performs the actual compression step.

**Data flow**: Accepts a source path and any `Write` output, opens the source file, creates `zstd::stream::write::Encoder` at `COMPRESSION_LEVEL`, copies bytes from input to encoder with `io::copy`, calls `finish()`, and returns `Ok(())` or an I/O/codec error.

**Call relations**: Used only by `compress_rollout_if_cold_blocking` when building the compressed temp file.

*Call graph*: 3 external calls (open, copy, new).


##### `worker::verify_zstd`  (lines 709–715)

```
fn verify_zstd(path: &Path) -> io::Result<()>
```

**Purpose**: Verifies that a compressed file can be fully decoded by streaming it to `io::sink()`. This catches corrupt temp outputs before they replace the source.

**Data flow**: Accepts a compressed file path, opens it, wraps it in `zstd::stream::read::Decoder`, copies all decoded bytes into `io::sink()`, and returns success only if decoding completes.

**Call relations**: Called by `compress_rollout_if_cold_blocking` immediately after writing the compressed temp file and before persisting it.

*Call graph*: 4 external calls (open, copy, sink, new).


##### `worker::set_file_metadata`  (lines 717–724)

```
fn set_file_metadata(
        file: &File,
        modified: SystemTime,
        permissions: &Permissions,
    ) -> io::Result<()>
```

**Purpose**: Applies the source file's modified time and permissions to the compressed output file. This preserves user-visible metadata across compression.

**Data flow**: Accepts a `&File`, source `SystemTime`, and source `Permissions`, calls `file.set_times(FileTimes::new().set_modified(modified))`, then `file.set_permissions(permissions.clone())`.

**Call relations**: Used by `compress_rollout_if_cold_blocking` after compression and verification but before syncing and persisting the compressed file.

*Call graph*: 4 external calls (set_permissions, set_times, new, clone).


##### `worker::cleanup_stale_temps`  (lines 726–734)

```
async fn cleanup_stale_temps(codex_home: &Path) -> io::Result<()>
```

**Purpose**: Removes stale compression temp files from both active and archived rollout roots before a worker run proceeds. This prevents abandoned temp buildup from previous interrupted runs.

**Data flow**: Accepts `codex_home: &Path`, constructs the `sessions` and `archived_sessions` roots, calls `cleanup_stale_temps_in_root` for each, and returns `Ok(())` or the first propagated error.

**Call relations**: Called near the start of `worker::run` before scanning for compressible files.

*Call graph*: 2 external calls (join, cleanup_stale_temps_in_root).


##### `worker::cleanup_stale_temps_in_root`  (lines 736–799)

```
async fn cleanup_stale_temps_in_root(root: &Path) -> io::Result<()>
```

**Purpose**: Recursively scans one root for stale `*.tmp` files left by compression and removes those older than the configured threshold. Fresh temp files are left untouched.

**Data flow**: Accepts a root path, returns early if it does not exist, then depth-first traverses directories with a stack and `tokio::fs::read_dir`. For each regular file whose name ends with `TEMP_SUFFIX`, it checks age from metadata/modified time; stale files are removed with `tokio::fs::remove_file`, recording `metrics::temp_cleanup("removed")` on success, ignoring `NotFound`, and recording/logging failures otherwise.

**Call relations**: Called by `cleanup_stale_temps` for both active and archived roots. It is the worker's pre-run housekeeping step.

*Call graph*: 6 external calls (temp_cleanup, read_dir, remove_file, try_exists, vec!, warn!).


##### `metrics::file`  (lines 817–819)

```
fn file(outcome: &'static str)
```

**Purpose**: Increments the per-file compression outcome counter. It is a thin metric wrapper.

**Data flow**: Accepts an outcome tag and calls `counter(FILE_COUNTER, &[("outcome", outcome)])`.

**Call relations**: Used throughout worker result accounting and scanning to record file-level outcomes.

*Call graph*: 1 external calls (counter).


##### `metrics::file_duration`  (lines 821–823)

```
fn file_duration(outcome: &'static str, duration: Duration)
```

**Purpose**: Records a duration histogram sample for one file compression outcome. It tags the sample by outcome.

**Data flow**: Accepts an outcome tag and `Duration`, then calls `duration_histogram(FILE_DURATION_HISTOGRAM, duration, &[("outcome", outcome)])`.

**Call relations**: Used when collecting completed compression jobs.

*Call graph*: 1 external calls (duration_histogram).


##### `metrics::source_bytes`  (lines 825–831)

```
fn source_bytes(outcome: &'static str, bytes: u64)
```

**Purpose**: Records the source-file byte size histogram for a compression outcome. Values are saturated into `i64` for the metrics backend.

**Data flow**: Accepts an outcome tag and `u64` byte count, converts with `saturating_i64`, and calls `histogram(FILE_SOURCE_BYTES_HISTOGRAM, value, tags)`.

**Call relations**: Used by compression job result accounting when source size is known.

*Call graph*: 2 external calls (histogram, saturating_i64).


##### `metrics::compressed_bytes`  (lines 833–839)

```
fn compressed_bytes(outcome: &'static str, bytes: u64)
```

**Purpose**: Records the compressed-file byte size histogram for a compression outcome. It mirrors `source_bytes` for output size.

**Data flow**: Accepts an outcome tag and `u64` byte count, converts with `saturating_i64`, and calls `histogram(FILE_COMPRESSED_BYTES_HISTOGRAM, value, tags)`.

**Call relations**: Used by compression job result accounting when compressed size is known.

*Call graph*: 2 external calls (histogram, saturating_i64).


##### `metrics::compression_ratio`  (lines 841–856)

```
fn compression_ratio(
        outcome: &'static str,
        source_bytes: u64,
        compressed_bytes: u64,
    )
```

**Purpose**: Records an integer-valued compression ratio histogram in basis points, preserving sub-percent precision without floating-point metrics. Zero-byte sources are skipped.

**Data flow**: Accepts outcome tag, source bytes, and compressed bytes. If `source_bytes == 0`, it returns early. Otherwise it computes `(compressed_bytes * 10_000) / source_bytes` as `u128`, converts with `saturating_i64`, and records it via `histogram(FILE_COMPRESSION_RATIO_HISTOGRAM, ratio, tags)`.

**Call relations**: Called when both source and compressed sizes are available for a completed compression job.

*Call graph*: 3 external calls (histogram, saturating_i64, from).


##### `metrics::materialize`  (lines 858–860)

```
fn materialize(outcome: &'static str)
```

**Purpose**: Increments the materialization outcome counter for append-path decompression. It tracks plain-exists, missing, decompressed, and failed cases.

**Data flow**: Accepts an outcome tag and calls `counter(MATERIALIZE_COUNTER, &[("outcome", outcome)])`.

**Call relations**: Used by `materialize_rollout_for_append_blocking` to record representation-switch outcomes.

*Call graph*: 1 external calls (counter).


##### `metrics::run`  (lines 862–864)

```
fn run(status: &'static str)
```

**Purpose**: Increments the worker-run status counter. It tracks statuses such as started, completed, failed, and skipped.

**Data flow**: Accepts a status tag and calls `counter(RUN_COUNTER, &[("status", status)])`.

**Call relations**: Used by `worker::spawn` and `worker::run` around worker lifecycle transitions.

*Call graph*: 1 external calls (counter).


##### `metrics::run_duration`  (lines 866–868)

```
fn run_duration(status: &'static str, duration: Duration)
```

**Purpose**: Records a duration histogram sample for a worker run status. It captures total runtime for completed or failed runs.

**Data flow**: Accepts a status tag and `Duration`, then calls `duration_histogram(RUN_DURATION_HISTOGRAM, duration, &[("status", status)])`.

**Call relations**: Used by `worker::run` when a run completes or fails.

*Call graph*: 1 external calls (duration_histogram).


##### `metrics::temp_cleanup`  (lines 870–872)

```
fn temp_cleanup(outcome: &'static str)
```

**Purpose**: Increments the stale-temp cleanup outcome counter. It tracks removed and failed cleanup attempts.

**Data flow**: Accepts an outcome tag and calls `counter(TEMP_CLEANUP_COUNTER, &[("outcome", outcome)])`.

**Call relations**: Used by `cleanup_stale_temps_in_root` when stale temp removal succeeds or fails.

*Call graph*: 1 external calls (counter).


##### `metrics::counter`  (lines 874–879)

```
fn counter(name: &str, tags: &[(&str, &str)])
```

**Purpose**: Sends a counter increment to the global OpenTelemetry metrics backend if one is configured. Missing metrics infrastructure is silently ignored.

**Data flow**: Accepts a metric name and tag slice, calls `codex_otel::global()`, returns early if `None`, otherwise invokes `metrics.counter(name, 1, tags)` and ignores its result.

**Call relations**: Used by the higher-level metric wrappers in this module.

*Call graph*: 1 external calls (global).


##### `metrics::histogram`  (lines 881–886)

```
fn histogram(name: &str, value: i64, tags: &[(&str, &str)])
```

**Purpose**: Sends an integer histogram sample to the global metrics backend if available. It is the generic numeric metric helper for this module.

**Data flow**: Accepts metric name, `i64` value, and tags, obtains `codex_otel::global()`, and if present calls `metrics.histogram(name, value, tags)`.

**Call relations**: Used by byte-count and compression-ratio wrappers.

*Call graph*: 1 external calls (global).


##### `metrics::duration_histogram`  (lines 888–893)

```
fn duration_histogram(name: &str, duration: Duration, tags: &[(&str, &str)])
```

**Purpose**: Sends a duration sample to the global metrics backend if available. It is the duration-specific metric helper for this module.

**Data flow**: Accepts metric name, `Duration`, and tags, obtains `codex_otel::global()`, and if present calls `metrics.record_duration(name, duration, tags)`.

**Call relations**: Used by file-duration and run-duration wrappers.

*Call graph*: 1 external calls (global).


##### `metrics::saturating_i64`  (lines 895–897)

```
fn saturating_i64(value: impl TryInto<i64>) -> i64
```

**Purpose**: Converts numeric values into `i64`, saturating to `i64::MAX` on overflow or failed conversion. It keeps metric emission robust across large values.

**Data flow**: Accepts any `TryInto<i64>`, attempts conversion, and returns the converted value or `i64::MAX` on failure.

**Call relations**: Used by byte-count and ratio metric wrappers before sending values to the metrics backend.

*Call graph*: 1 external calls (try_into).


##### `existing_rollout_path`  (lines 902–904)

```
async fn existing_rollout_path(path: &Path) -> Option<PathBuf>
```

**Purpose**: Returns the existing physical path for a logical rollout, preferring the plain file over its compressed sibling. It is the public wrapper around the internal path-resolution helper.

**Data flow**: Accepts `&Path` and forwards to `path::existing_rollout_path(path).await`, returning `Option<PathBuf>`.

**Call relations**: Used by callers outside this file that need representation-aware path resolution.

*Call graph*: 1 external calls (existing_rollout_path).


##### `path::compressed_rollout_path`  (lines 913–923)

```
fn compressed_rollout_path(path: &Path) -> PathBuf
```

**Purpose**: Computes the compressed sibling path for a rollout file. If the input is already compressed, it is returned unchanged.

**Data flow**: Accepts `&Path`, checks `is_compressed_rollout_path`, otherwise appends `.zst` to the filename (defaulting to `rollout.jsonl` if absent) and returns `path.with_file_name(file_name)`.

**Call relations**: Used by materialization, worker compression, and public wrappers whenever the compressed representation path is needed.

*Call graph*: 4 external calls (file_name, to_path_buf, with_file_name, is_compressed_rollout_path).


##### `path::plain_rollout_path`  (lines 925–933)

```
fn plain_rollout_path(path: &Path) -> PathBuf
```

**Purpose**: Computes the plain `.jsonl` path corresponding to a rollout path. Compressed suffixes are stripped when present.

**Data flow**: Accepts `&Path`, extracts the filename as UTF-8, strips `COMPRESSED_SUFFIX` if present, and returns `path.with_file_name(plain_file_name)`; paths without a valid filename are returned unchanged.

**Call relations**: Used by materialization, sibling-skipping logic, and existing-path resolution.

*Call graph*: 3 external calls (file_name, to_path_buf, with_file_name).


##### `path::is_compressed_rollout_path`  (lines 935–939)

```
fn is_compressed_rollout_path(path: &Path) -> bool
```

**Purpose**: Checks whether a path's filename ends with `.jsonl.zst`. It is the representation predicate for rollout paths.

**Data flow**: Accepts `&Path`, inspects `file_name().and_then(OsStr::to_str)`, and returns whether the name ends with `.jsonl.zst`.

**Call relations**: Used by path normalization, reader opening, and worker scan logic.

*Call graph*: 1 external calls (file_name).


##### `path::should_skip_compressed_sibling`  (lines 941–943)

```
fn should_skip_compressed_sibling(path: &Path) -> bool
```

**Purpose**: Determines whether a compressed rollout file should be hidden because its plain sibling currently exists. This enforces plain-file precedence during discovery.

**Data flow**: Accepts `&Path` and returns true only when the path is compressed and `plain_rollout_path(path).exists()`.

**Call relations**: Used by `RolloutFile::from_path` so directory walkers see at most one logical file per rollout.

*Call graph*: calls 1 internal fn (plain_rollout_path); 1 external calls (is_compressed_rollout_path).


##### `path::existing_rollout_path`  (lines 945–957)

```
async fn existing_rollout_path(path: &Path) -> Option<PathBuf>
```

**Purpose**: Resolves the physical path for a logical rollout, preferring the plain file and falling back to the compressed sibling. It is the async representation-resolution primitive.

**Data flow**: Accepts `&Path`, computes the plain path, checks `tokio::fs::metadata` for an existing regular file there, otherwise computes the compressed sibling and checks it similarly, returning `Some(path)` for the first existing file or `None` if neither exists.

**Call relations**: Used by public wrappers, file-modified-time lookup, and reader opening.

*Call graph*: calls 2 internal fn (compressed_rollout_path, plain_rollout_path); 1 external calls (matches!).


##### `file_name::parse_rollout_file_name`  (lines 963–970)

```
fn parse_rollout_file_name(name: &str) -> Option<&str>
```

**Purpose**: Validates rollout filenames and normalizes compressed names to their plain `.jsonl` form. It accepts only names matching `rollout-*.jsonl[.zst]`.

**Data flow**: Accepts `&str`, strips a trailing `.zst` if present, and returns `Some(name)` only if the remaining name starts with `rollout-` and ends with `.jsonl`; otherwise returns `None`.

**Call relations**: Used by `RolloutFile::from_path` and public filename parsing wrappers.


##### `reader::open_once`  (lines 985–1007)

```
async fn open_once(path: &Path) -> io::Result<RolloutLineReader>
```

**Purpose**: Opens a rollout line reader for the currently existing representation without retry logic. It chooses async plain reading or blocking zstd decoding based on the resolved path.

**Data flow**: Accepts `&Path`, resolves the existing physical path via `path::existing_rollout_path(path).await` or falls back to the requested path, then checks `path::is_compressed_rollout_path`. For compressed files it uses `spawn_blocking` to open the file, wrap it in a zstd decoder, and build a blocking `BufRead::lines()` iterator stored as `RolloutLineReaderInner::Blocking(Some(reader))`. For plain files it opens with `tokio::fs::File::open` and returns `RolloutLineReaderInner::Plain(tokio::io::BufReader::new(file).lines())`.

**Call relations**: Called by `open_rollout_line_reader`, which adds retry behavior around this single-attempt open.

*Call graph*: 8 external calls (as_path, existing_rollout_path, is_compressed_rollout_path, Blocking, Plain, open, new, spawn_blocking).


##### `create_file_with_permissions`  (lines 1022–1029)

```
fn create_file_with_permissions(path: &Path, permissions: &Permissions) -> io::Result<File>
```

**Purpose**: Creates a new file while preserving the source file's permissions, including Unix mode bits on Unix platforms. It is used when materializing compressed rollouts.

**Data flow**: Accepts a target path and source `Permissions`. On Unix it opens with `create_new(true)` and `.mode(permissions.mode() & 0o7777)`, then explicitly sets permissions; on non-Unix it opens normally and sets permissions afterward. It returns the created `File`.

**Call relations**: Used by `materialize_rollout_for_append_blocking` so decompressed plain files inherit the compressed source's permissions.

*Call graph*: 3 external calls (clone, mode, new).


##### `temp_path_for`  (lines 1031–1042)

```
fn temp_path_for(path: &Path, operation: &str) -> PathBuf
```

**Purpose**: Generates a unique temp filename adjacent to a rollout path for a named operation such as decompression. It avoids collisions across threads and processes.

**Data flow**: Accepts a base path and operation string, derives the base filename (defaulting to `rollout`), increments the global `TEMP_COUNTER` atomically, appends `.{operation}.{pid}.{counter}.tmp`, and returns `path.with_file_name(file_name)`.

**Call relations**: Used by `materialize_rollout_for_append_blocking` to create unique temp output paths during decompression.

*Call graph*: called by 1 (materialize_rollout_for_append_blocking); 3 external calls (file_name, with_file_name, format!).


### `rollout/src/session_index.rs`

`io_transport` · `cross-cutting title lookup and rename persistence`

This file implements a small append-only index stored as `session_index.jsonl` under `codex_home`. Each `SessionIndexEntry` records a `ThreadId`, `thread_name`, and `updated_at` string. Writes are serialized with a global `LazyLock<Mutex<()>>` so concurrent append/remove operations do not interleave. `append_thread_name` stamps the current UTC time and delegates to `append_session_index_entry`, which appends one JSON line and flushes immediately. `remove_thread_name_entries` is the only rewriting operation: it loads the whole file, filters out entries for one thread ID, writes a temporary file, and renames it into place.

Read paths are optimized around append order rather than timestamps. `find_thread_name_by_id` uses `spawn_blocking` plus a reverse scanner to find the newest entry for one ID. `find_thread_names_by_ids` instead streams the file forward asynchronously and lets later entries overwrite earlier ones in a `HashMap`, yielding the latest non-empty name for each requested ID. `find_thread_meta_by_name_str` is more involved: it reverse-scans matching thread IDs newest-first through a channel, then for each candidate asks the rollout listing code to resolve the thread’s rollout path and read its `SessionMetaLine`. This intentionally skips newer name entries whose rollout was never materialized or is unreadable, so an unsaved rename cannot shadow an older persisted session.

The reverse scanner reads the file in fixed-size chunks from the end, accumulates bytes for each line in reverse, reconstructs UTF-8 lines, ignores malformed/blank JSON, and stops as soon as the visitor closure returns a matching `SessionIndexEntry`. `stream_thread_ids_from_end_by_name` also tracks seen IDs so historical names for a renamed thread are ignored once a newer name for that same ID has been observed.

#### Function details

##### `append_thread_name`  (lines 33–50)

```
async fn append_thread_name(
    codex_home: &Path,
    thread_id: ThreadId,
    name: &str,
) -> std::io::Result<()>
```

**Purpose**: Appends a new thread-name mapping for a thread ID with the current UTC timestamp. The index is append-only, so later entries supersede earlier ones.

**Data flow**: Takes `codex_home`, `thread_id`, and `name`; formats `OffsetDateTime::now_utc()` as RFC3339 with fallback to `"unknown"`; builds `SessionIndexEntry { id, thread_name, updated_at }`; delegates to `append_session_index_entry` and returns its I/O result.

**Call relations**: This is the high-level write API used by callers that want to record a rename without constructing `SessionIndexEntry` manually.

*Call graph*: calls 1 internal fn (append_session_index_entry); 1 external calls (now_utc).


##### `append_session_index_entry`  (lines 54–71)

```
async fn append_session_index_entry(
    codex_home: &Path,
    entry: &SessionIndexEntry,
) -> std::io::Result<()>
```

**Purpose**: Appends one raw `SessionIndexEntry` JSON line to `session_index.jsonl` under a global process-local lock. It is the low-level durable write primitive for the session index.

**Data flow**: Locks `SESSION_INDEX_LOCK`, computes the file path with `session_index_path`, opens the file in create+append mode, serializes the entry to JSON, appends a newline, writes bytes, flushes, and returns `std::io::Result<()>`.

**Call relations**: Called by `append_thread_name`; all append-only index writes funnel through this function.

*Call graph*: calls 1 internal fn (session_index_path); called by 1 (append_thread_name); 2 external calls (to_string, new).


##### `remove_thread_name_entries`  (lines 74–105)

```
async fn remove_thread_name_entries(
    codex_home: &Path,
    thread_id: ThreadId,
) -> std::io::Result<()>
```

**Purpose**: Deletes all index entries for a given thread ID by rewriting the file without those lines. It is used when a thread’s name history should be fully removed.

**Data flow**: Locks `SESSION_INDEX_LOCK`, reads the whole index file if it exists, parses each line as `SessionIndexEntry`, filters out entries whose `id` matches `thread_id`, tracks whether anything was removed, writes the remaining lines to a temporary `.jsonl.tmp` file, and renames it over the original file.

**Call relations**: This is the only non-append mutation path in the module; it complements `append_thread_name` for cleanup/removal scenarios.

*Call graph*: calls 1 internal fn (session_index_path); 4 external calls (with_capacity, read_to_string, rename, write).


##### `find_thread_name_by_id`  (lines 108–121)

```
async fn find_thread_name_by_id(
    codex_home: &Path,
    thread_id: &ThreadId,
) -> std::io::Result<Option<String>>
```

**Purpose**: Finds the latest recorded thread name for one thread ID by scanning the index from the end. It avoids loading the whole file into memory on the async runtime thread.

**Data flow**: Builds the index path, returns `Ok(None)` if it does not exist, copies the target ID, runs `scan_index_from_end_by_id` inside `tokio::task::spawn_blocking`, unwraps nested results, and maps the found entry to `entry.thread_name`.

**Call relations**: Uses the reverse-scanning helpers because append order defines recency in this index.

*Call graph*: calls 1 internal fn (session_index_path); 1 external calls (spawn_blocking).


##### `find_thread_names_by_ids`  (lines 124–153)

```
async fn find_thread_names_by_ids(
    codex_home: &Path,
    thread_ids: &HashSet<ThreadId>,
) -> std::io::Result<HashMap<ThreadId, String>>
```

**Purpose**: Finds the latest non-empty names for a batch of thread IDs by scanning the index forward and letting later entries overwrite earlier ones. It is optimized for bulk title lookup during listing/search.

**Data flow**: Returns an empty map if the ID set is empty or the index file is missing; otherwise opens the file asynchronously, reads lines through `BufReader::lines`, skips blank or malformed lines, trims names, and inserts matching IDs into a `HashMap<ThreadId, String>`, overwriting older values with later ones.

**Call relations**: Called by rollout listing search code to map thread IDs to titles for substring filtering.

*Call graph*: calls 1 internal fn (session_index_path); called by 1 (filter_thread_items_by_search_term); 4 external calls (new, with_capacity, open, new).


##### `find_thread_meta_by_name_str`  (lines 157–195)

```
async fn find_thread_meta_by_name_str(
    codex_home: &Path,
    name: &str,
    state_db_ctx: Option<&codex_state::StateRuntime>,
) -> std::io::Result<Option<(PathBuf, SessionMetaLine)>>
```

**Purpose**: Finds the newest thread with a given current name that still has a readable rollout header. It resolves name collisions and skips unsaved or partial rollouts.

**Data flow**: Rejects blank names or missing index files, creates an `mpsc` channel, spawns a blocking reverse scan with `stream_thread_ids_from_end_by_name`, then asynchronously receives candidate thread IDs newest-first; for each ID it resolves a rollout path via `super::list::find_thread_path_by_id_str` and tries to read `SessionMetaLine` via `super::list::read_session_meta_line`; on the first success it stops and returns `Some((path, session_meta))`, otherwise returns `None` after the scan completes.

**Call relations**: This is the highest-level lookup in the module, combining reverse index scanning with rollout-path resolution and header loading to avoid returning stale or unmaterialized name hits.

*Call graph*: calls 3 internal fn (find_thread_path_by_id_str, read_session_meta_line, session_index_path); 2 external calls (channel, spawn_blocking).


##### `session_index_path`  (lines 197–199)

```
fn session_index_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Computes the absolute path to `session_index.jsonl` under a Codex home directory. It centralizes the filename constant.

**Data flow**: Joins `codex_home` with `SESSION_INDEX_FILE` and returns the resulting `PathBuf`.

**Call relations**: Used by all read and write operations in this module.

*Call graph*: called by 5 (append_session_index_entry, find_thread_meta_by_name_str, find_thread_name_by_id, find_thread_names_by_ids, remove_thread_name_entries); 1 external calls (join).


##### `scan_index_from_end_by_id`  (lines 201–206)

```
fn scan_index_from_end_by_id(
    path: &Path,
    thread_id: &ThreadId,
) -> std::io::Result<Option<SessionIndexEntry>>
```

**Purpose**: Finds the newest index entry for a specific thread ID by delegating to the generic reverse scanner. It is the ID-specialized reverse lookup helper.

**Data flow**: Accepts an index path and thread ID reference, calls `scan_index_from_end` with a predicate comparing `entry.id` to the target, and returns the optional matching entry.

**Call relations**: Used by `find_thread_name_by_id` after moving the blocking work off the async runtime.

*Call graph*: calls 1 internal fn (scan_index_from_end).


##### `stream_thread_ids_from_end_by_name`  (lines 208–224)

```
fn stream_thread_ids_from_end_by_name(
    path: &Path,
    name: &str,
    tx: tokio::sync::mpsc::Sender<ThreadId>,
) -> std::io::Result<()>
```

**Purpose**: Streams matching thread IDs for a given current name in newest-first append order, suppressing historical names for IDs that have since been renamed. It is designed for incremental async consumption.

**Data flow**: Creates a `HashSet` of seen IDs, reverse-scans entries with `scan_index_from_end_for_each`, and for each entry first records whether this is the newest row seen for that ID; if so and `entry.thread_name == name`, sends the ID over `tx.blocking_send`; if the receiver is gone, returns early by yielding `Some(entry.clone())` through the visitor.

**Call relations**: Spawned inside `find_thread_meta_by_name_str` to feed candidate IDs over a channel while the async side resolves rollout paths.

*Call graph*: calls 1 internal fn (scan_index_from_end_for_each); 1 external calls (new).


##### `scan_index_from_end`  (lines 226–239)

```
fn scan_index_from_end(
    path: &Path,
    mut predicate: F,
) -> std::io::Result<Option<SessionIndexEntry>>
```

**Purpose**: Runs a predicate over index entries in reverse append order and returns the first matching entry. It is the generic reverse-search wrapper around the chunked scanner.

**Data flow**: Accepts a path and predicate closure, calls `scan_index_from_end_for_each` with a visitor that clones and returns the first entry satisfying the predicate, and returns the optional result.

**Call relations**: Used by `scan_index_from_end_by_id` and tests that need reverse-order lookup by arbitrary conditions.

*Call graph*: calls 1 internal fn (scan_index_from_end_for_each); called by 1 (scan_index_from_end_by_id).


##### `scan_index_from_end_for_each`  (lines 241–276)

```
fn scan_index_from_end_for_each(
    path: &Path,
    mut visit_entry: F,
) -> std::io::Result<Option<SessionIndexEntry>>
```

**Purpose**: Scans the index file backward in fixed-size chunks, reconstructing lines from the end and visiting each parsed entry newest-first. It is the core reverse-reading engine for the session index.

**Data flow**: Opens the file, gets its length, allocates a reverse-line buffer and chunk buffer, repeatedly seeks backward by up to `READ_CHUNK_SIZE`, reads bytes, iterates them in reverse, accumulates bytes until newline boundaries, calls `parse_line_from_rev` on each completed reversed line, and stops early if the visitor returns `Some(entry)`; after all chunks, parses any remaining buffered line and returns the optional visitor result.

**Call relations**: Used by both `scan_index_from_end` and `stream_thread_ids_from_end_by_name`; it encapsulates the chunked reverse-file traversal logic.

*Call graph*: calls 1 internal fn (parse_line_from_rev); called by 2 (scan_index_from_end, stream_thread_ids_from_end_by_name); 5 external calls (open, Start, new, try_from, vec!).


##### `parse_line_from_rev`  (lines 278–304)

```
fn parse_line_from_rev(
    line_rev: &mut Vec<u8>,
    visit_entry: &mut F,
) -> std::io::Result<Option<SessionIndexEntry>>
```

**Purpose**: Turns one reversed byte buffer into a parsed `SessionIndexEntry` and passes it to a visitor closure. It ignores empty, invalid UTF-8, and malformed JSON lines.

**Data flow**: If `line_rev` is empty returns `Ok(None)`; otherwise reverses the bytes in place, takes ownership of the buffer, attempts UTF-8 decoding, strips trailing `\r`, trims whitespace, deserializes `SessionIndexEntry`, and if successful calls `visit_entry(&entry)` and returns its result.

**Call relations**: Called repeatedly by `scan_index_from_end_for_each` whenever a newline boundary or EOF completes one reversed line.

*Call graph*: called by 1 (scan_index_from_end_for_each); 2 external calls (from_utf8, take).


### `rollout/src/search.rs`

`domain_logic` · `on-demand search and filtering`

This file implements rollout-content search over the sessions tree. The top-level API returns either just matching rollout paths or a map from canonical `.jsonl` paths to optional snippets. `search_rollout_matches` chooses the root directory based on the `archived` flag, JSON-escapes the search term so plain JSONL text can be matched literally, and first tries `ripgrep_rollout_paths` against `*.jsonl` files with fixed-string, case-insensitive search. If ripgrep is unavailable (`NotFound`), it falls back to a recursive scanner. Even when ripgrep succeeds, compressed rollouts still require manual scanning because ripgrep only sees plain `.jsonl` files.

The fallback scanners walk the directory tree iteratively with a stack, recognize rollout files through `compression::RolloutFile::from_path`, and treat plain and compressed files differently. Plain files are searched line-by-line with a case-insensitive literal regex over the JSON-escaped term. Compressed files are decompressed through `compression::open_rollout_line_reader` and searched semantically: `first_rollout_content_match_snippet` looks for lines whose raw JSON contains the escaped term, then parses the line into `RolloutLine`, extracts conversational text from selected `RolloutItem` variants, and returns a trimmed excerpt around the first match.

Text extraction is intentionally narrow. User messages strip the `USER_MESSAGE_BEGIN` prefix, agent messages use trimmed message text, and `ResponseItem::Message` contributes only user/assistant `InputText`/`OutputText` content. Snippet generation normalizes whitespace, then computes character-based context windows before and after the regex match so excerpts remain readable and Unicode-safe.

#### Function details

##### `search_rollout_paths`  (lines 27–39)

```
async fn search_rollout_paths(
    rg_command: &Path,
    codex_home: &Path,
    archived: bool,
    search_term: &str,
) -> io::Result<HashSet<PathBuf>>
```

**Purpose**: Searches rollouts and returns only the set of matching canonical rollout paths. It is the path-only convenience wrapper around the richer match API.

**Data flow**: Accepts the ripgrep executable path, codex home, archived flag, and search term; calls `search_rollout_matches`; discards snippet values by collecting only the returned map’s keys into a `HashSet<PathBuf>`.

**Call relations**: Delegates all real work to `search_rollout_matches` and exists for callers that do not need snippets.

*Call graph*: calls 1 internal fn (search_rollout_matches).


##### `search_rollout_matches`  (lines 41–62)

```
async fn search_rollout_matches(
    rg_command: &Path,
    codex_home: &Path,
    archived: bool,
    search_term: &str,
) -> io::Result<RolloutSearchMatches>
```

**Purpose**: Searches active or archived rollout trees and returns matching canonical rollout paths plus optional snippets for compressed matches. It coordinates ripgrep, fallback scanning, and compressed-file handling.

**Data flow**: Builds the root path from `codex_home` and the archived flag, JSON-escapes the search term, tries `ripgrep_rollout_paths`; if ripgrep is unavailable returns `scan_rollout_matches`; otherwise converts plain-file matches into a `HashMap<PathBuf, None>`, extends it with `scan_compressed_rollout_matches` results containing snippets, and returns the combined map.

**Call relations**: This is the main search entry point used by `search_rollout_paths`. It delegates plain-file acceleration to ripgrep and all decompression-aware work to the scanner helpers.

*Call graph*: calls 4 internal fn (json_escaped_search_term, ripgrep_rollout_paths, scan_compressed_rollout_matches, scan_rollout_matches); called by 1 (search_rollout_paths); 1 external calls (join).


##### `ripgrep_rollout_paths`  (lines 64–115)

```
async fn ripgrep_rollout_paths(
    rg_command: &Path,
    root: &Path,
    search_term: &str,
) -> io::Result<Option<HashSet<PathBuf>>>
```

**Purpose**: Runs external `rg` to find matching plain `.jsonl` rollout files quickly. It treats missing ripgrep as a soft fallback condition rather than an error.

**Data flow**: Checks whether the root exists; if not, returns `Some(empty set)`. Otherwise spawns `rg -l --fixed-strings --ignore-case --no-ignore --glob *.jsonl -- <term> <root>`, interprets `NotFound` as `Ok(None)`, interprets exit code 1 with empty stderr as no matches, converts successful stdout lines into absolute or root-joined `PathBuf`s, and returns `Some(HashSet<PathBuf>)`.

**Call relations**: Called by `search_rollout_matches` as the fast path for plain JSONL files. Returning `None` signals the caller to use the built-in scanner.

*Call graph*: called by 1 (search_rollout_matches); 8 external calls (new, join, from, from_utf8_lossy, new, other, format!, try_exists).


##### `scan_rollout_matches`  (lines 117–163)

```
async fn scan_rollout_matches(
    root: &Path,
    json_search_term: &str,
    search_term: &str,
) -> io::Result<RolloutSearchMatches>
```

**Purpose**: Recursively scans rollout files without ripgrep, handling both plain and compressed files. Plain matches return no snippet; compressed matches include the first content snippet.

**Data flow**: Starts from `root`, builds a case-insensitive literal regex over the JSON-escaped term, walks directories with a stack, recognizes rollout files via `compression::RolloutFile::from_path`, for compressed files calls `first_rollout_content_match_snippet` and inserts canonical plain paths with `Some(snippet)`, and for plain files calls `rollout_contains` and inserts matching paths with `None`.

**Call relations**: Used by `search_rollout_matches` when ripgrep is unavailable. It delegates line-level checks to `rollout_contains` and snippet extraction to `first_rollout_content_match_snippet`.

*Call graph*: calls 4 internal fn (from_path, case_insensitive_literal_regex, first_rollout_content_match_snippet, rollout_contains); called by 1 (search_rollout_matches); 4 external calls (new, plain_rollout_path, read_dir, vec!).


##### `rollout_contains`  (lines 165–173)

```
async fn rollout_contains(path: &Path, search_term: &Regex) -> io::Result<bool>
```

**Purpose**: Checks whether any line in a rollout file matches a precompiled regex. It is the plain-file line scanner used by fallback search.

**Data flow**: Opens a rollout line reader through the compression layer, iterates lines asynchronously, tests each line with `Regex::is_match`, returns `Ok(true)` on the first match, and `Ok(false)` if the file ends without one.

**Call relations**: Called by `scan_rollout_matches` for uncompressed rollout files.

*Call graph*: calls 1 internal fn (open_rollout_line_reader); called by 1 (scan_rollout_matches); 1 external calls (is_match).


##### `first_rollout_content_match_snippet`  (lines 175–190)

```
async fn first_rollout_content_match_snippet(
    path: &Path,
    search_term: &str,
) -> io::Result<Option<String>>
```

**Purpose**: Finds the first semantically meaningful content match in a rollout and returns a short excerpt around it. It is used primarily for compressed rollouts where raw ripgrep is unavailable.

**Data flow**: Opens a rollout line reader, builds one regex for the JSON-escaped term and another for the human search term, scans lines until one matches the JSON regex, then calls `content_match_snippet` on that line and returns the first non-`None` snippet found; otherwise returns `Ok(None)`.

**Call relations**: Called by both `scan_rollout_matches` and `scan_compressed_rollout_matches` to produce snippets from decompressed content.

*Call graph*: calls 4 internal fn (open_rollout_line_reader, case_insensitive_literal_regex, content_match_snippet, json_escaped_search_term); called by 2 (scan_compressed_rollout_matches, scan_rollout_matches).


##### `scan_compressed_rollout_matches`  (lines 192–233)

```
async fn scan_compressed_rollout_matches(
    root: &Path,
    search_term: &str,
) -> io::Result<RolloutSearchMatches>
```

**Purpose**: Recursively scans only compressed rollout files and returns canonical plain paths mapped to snippets. It complements ripgrep, which only searches plain `.jsonl` files.

**Data flow**: Walks the directory tree with a stack, recognizes rollout files, skips non-compressed ones, calls `first_rollout_content_match_snippet` for each compressed file, and inserts `compression::plain_rollout_path(path)` with `Some(snippet)` for matches.

**Call relations**: Always called by `search_rollout_matches` after successful ripgrep so compressed rollouts are not missed.

*Call graph*: calls 2 internal fn (from_path, first_rollout_content_match_snippet); called by 1 (search_rollout_matches); 4 external calls (new, plain_rollout_path, read_dir, vec!).


##### `json_escaped_search_term`  (lines 235–238)

```
fn json_escaped_search_term(search_term: &str) -> io::Result<String>
```

**Purpose**: Escapes a search term the same way it appears inside JSON strings, minus the surrounding quotes. This lets raw JSONL line scans match serialized content literally.

**Data flow**: Serializes the input string with `serde_json::to_string`, strips the leading and trailing quote characters, and returns the inner escaped string as `io::Result<String>`.

**Call relations**: Used by `search_rollout_matches` and `first_rollout_content_match_snippet` before building regexes or invoking ripgrep.

*Call graph*: called by 2 (first_rollout_content_match_snippet, search_rollout_matches); 1 external calls (to_string).


##### `case_insensitive_literal_regex`  (lines 240–245)

```
fn case_insensitive_literal_regex(search_term: impl AsRef<str>) -> io::Result<Regex>
```

**Purpose**: Builds a case-insensitive regex that treats the search term as a literal string rather than a regex pattern. It avoids accidental regex metacharacter interpretation.

**Data flow**: Reads the input as `AsRef<str>`, escapes it with `regex::escape`, builds a `RegexBuilder` with `case_insensitive(true)`, compiles it, and maps regex errors into `io::Error`.

**Call relations**: Used by the fallback scanners and snippet extractor whenever a search term needs to be matched safely.

*Call graph*: called by 2 (first_rollout_content_match_snippet, scan_rollout_matches); 3 external calls (as_ref, new, escape).


##### `content_match_snippet`  (lines 247–251)

```
fn content_match_snippet(jsonl_line: &str, search_term: &Regex) -> Option<String>
```

**Purpose**: Parses one JSONL line into a rollout item, extracts conversational text from that item, and returns an excerpt around the first match. It is the semantic bridge from raw JSON to human-readable snippets.

**Data flow**: Trims and deserializes the line into `RolloutLine`, extracts text with `conversation_text_from_item`, passes that text and the regex to `excerpt_around_match`, and returns the resulting `Option<String>`.

**Call relations**: Called by `first_rollout_content_match_snippet` after a raw JSON line has already been identified as containing the escaped search term.

*Call graph*: calls 2 internal fn (conversation_text_from_item, excerpt_around_match); called by 1 (first_rollout_content_match_snippet).


##### `conversation_text_from_item`  (lines 253–289)

```
fn conversation_text_from_item(item: &RolloutItem) -> Option<String>
```

**Purpose**: Extracts searchable human conversation text from selected rollout item variants. It intentionally ignores structural, tool-only, and non-conversational items.

**Data flow**: Matches on `RolloutItem`: for `EventMsg::UserMessage` strips the protocol prefix and returns non-empty text; for `EventMsg::AgentMessage` returns trimmed non-empty message text; for `ResponseItem::Message` concatenates text-bearing `ContentItem`s and returns it only for `role == "user"` or `"assistant"`; all other variants return `None`.

**Call relations**: Used by `content_match_snippet` to decide whether a matched JSON line can yield a readable snippet.

*Call graph*: calls 1 internal fn (strip_user_message_prefix); called by 1 (content_match_snippet).


##### `content_item_text`  (lines 291–296)

```
fn content_item_text(item: &ContentItem) -> Option<&str>
```

**Purpose**: Extracts text from a `ContentItem` when the item is textual. Images contribute no searchable text.

**Data flow**: Returns `Some(&str)` for `InputText` and `OutputText` variants by borrowing their `text` field, and `None` for `InputImage`.

**Call relations**: Used by `conversation_text_from_item` when flattening `ResponseItem::Message` content.


##### `strip_user_message_prefix`  (lines 298–303)

```
fn strip_user_message_prefix(text: &str) -> &str
```

**Purpose**: Removes the protocol-level `USER_MESSAGE_BEGIN` marker from stored user-message text before snippet generation. If the marker is absent, it just trims whitespace.

**Data flow**: Searches the input string for `USER_MESSAGE_BEGIN`; if found, returns the trimmed substring after the marker, otherwise returns `text.trim()`.

**Call relations**: Called by `conversation_text_from_item` for `EventMsg::UserMessage`.

*Call graph*: called by 1 (conversation_text_from_item).


##### `excerpt_around_match`  (lines 305–327)

```
fn excerpt_around_match(text: &str, search_term: &Regex) -> Option<String>
```

**Purpose**: Builds a short snippet around the first regex match with bounded context before and after the match. It normalizes whitespace and adds ellipses when the excerpt is clipped.

**Data flow**: Normalizes the input text with `normalize_preview_text`, finds the first regex match, computes byte-safe excerpt bounds using `char_start_before` and `char_end_after`, trims the excerpt, prefixes `"... "` when clipped at the start and suffixes `" ..."` when clipped at the end, and returns `Some(snippet)` or `None` if no match/excerpt exists.

**Call relations**: Used by `content_match_snippet` as the final snippet formatter.

*Call graph*: calls 3 internal fn (char_end_after, char_start_before, normalize_preview_text); called by 1 (content_match_snippet); 2 external calls (find, new).


##### `normalize_preview_text`  (lines 329–331)

```
fn normalize_preview_text(text: &str) -> String
```

**Purpose**: Collapses all whitespace runs in a string into single spaces for cleaner snippets and stable matching context. It removes line breaks and repeated spacing.

**Data flow**: Splits the input on whitespace, collects the pieces, joins them with single spaces, and returns the normalized `String`.

**Call relations**: Called by `excerpt_around_match` before locating and slicing the match.

*Call graph*: called by 1 (excerpt_around_match).


##### `char_start_before`  (lines 333–340)

```
fn char_start_before(text: &str, byte_index: usize, chars_before: usize) -> usize
```

**Purpose**: Finds the byte index that starts a given number of Unicode scalar values before a target byte index. It keeps excerpt slicing character-safe.

**Data flow**: Iterates `char_indices()` over the prefix `text[..byte_index]` in reverse, selects the nth character boundary before the target, and returns that byte index or `0` if there are fewer characters.

**Call relations**: Used by `excerpt_around_match` to compute the left excerpt boundary.

*Call graph*: called by 1 (excerpt_around_match).


##### `char_end_after`  (lines 342–348)

```
fn char_end_after(text: &str, byte_index: usize, chars_after: usize) -> usize
```

**Purpose**: Finds the byte index that ends a given number of Unicode scalar values after a target byte index. It keeps excerpt slicing character-safe on the right side.

**Data flow**: Iterates `char_indices()` over the suffix `text[byte_index..]`, selects the nth character boundary after the target, adds the offset back to `byte_index`, and returns that byte index or `text.len()` if there are fewer characters.

**Call relations**: Used by `excerpt_around_match` to compute the right excerpt boundary.

*Call graph*: called by 1 (excerpt_around_match).


### Rollout recording and discovery
These files implement the main rollout workflows for writing session transcripts, loading them back, and listing or locating persisted threads on disk.

### `rollout/src/list.rs`

`domain_logic` · `thread listing, summary generation, pagination, and rollout-path lookup during user queries`

This file defines the listing data model (`ThreadsPage`, `ThreadItem`), pagination cursor (`Cursor`), sort/layout enums, and the scanning logic that turns rollout files into user-facing thread summaries. It supports two sort keys: `CreatedAt`, derived from the timestamp embedded in rollout filenames, and `UpdatedAt`, derived from file mtimes. It also supports two layouts: nested date directories and flat roots. Pagination is timestamp-based via `Cursor`, with `AnchorState` suppressing items until the scan passes the previous page's last timestamp; this keeps paging stable as new files arrive.

Summary extraction is intentionally lightweight. `build_thread_item` reads only the head of a rollout via `read_head_summary`, which scans a bounded number of records looking for `SessionMeta`, a preview-bearing event, and the first user message. It extracts cwd, git metadata, source, parent thread id, agent nickname/role, model provider, CLI version, and timestamps, then applies source/provider/cwd filters. Compressed rollouts are handled transparently through `compression::open_rollout_line_reader` and `compression::RolloutFile`.

The file also contains robust thread-id lookup. `find_thread_path_by_id_str_in_subdir` first validates UUID format, optionally consults the state DB, verifies any DB-returned path by reading `SessionMeta`, records discrepancies and fallback telemetry, then falls back to filename scanning and finally broader file search. This layered approach favors fast indexed lookup while remaining resilient to stale DB rows, compressed filenames, and missing metadata.

#### Function details

##### `Cursor::new`  (lines 147–149)

```
fn new(ts: OffsetDateTime) -> Self
```

**Purpose**: Constructs a pagination cursor from a timestamp. It is the canonical constructor used throughout listing and serialization code.

**Data flow**: Accepts `OffsetDateTime` and returns `Cursor { ts }`.

**Call relations**: Used by cursor parsing, anchor conversion, and next-page cursor construction whenever a timestamp must become a cursor token.

*Call graph*: called by 31 (run_sse, prepare_encoded_json, into_prepared_stores_compressed_body_for_reuse, unpack_plugin_bundle_tar_gz, extract_zipball_to_dir, curated_repo_backup_archive_zip_bytes, curated_repo_zipball_bytes, extract_zip_to_dir, original_detail_images_are_capped_at_max_patch_count, original_detail_images_scale_with_dimensions (+15 more)).


##### `Cursor::timestamp`  (lines 151–153)

```
fn timestamp(&self) -> OffsetDateTime
```

**Purpose**: Returns the timestamp stored inside the cursor. It exposes the cursor's ordering anchor to callers that need it.

**Data flow**: Borrows `self` and returns `self.ts` by value.

**Call relations**: A simple accessor used by code that needs to inspect a cursor's timestamp without parsing its serialized form.


##### `AnchorState::new`  (lines 166–177)

```
fn new(anchor: Option<Cursor>) -> Self
```

**Purpose**: Initializes pagination anchor state from an optional cursor. Without a cursor, scanning starts immediately; with one, scanning skips until it passes the anchor timestamp.

**Data flow**: Accepts `Option<Cursor>`. For `Some(cursor)`, returns `AnchorState { ts: cursor.ts, passed: false }`; for `None`, returns `AnchorState { ts: OffsetDateTime::UNIX_EPOCH, passed: true }`.

**Call relations**: Called by all traversal variants before scanning files so they can apply stable pagination behavior through `should_skip`.

*Call graph*: called by 4 (traverse_directories_for_paths_created, traverse_directories_for_paths_updated, traverse_flat_paths_created, traverse_flat_paths_updated).


##### `AnchorState::should_skip`  (lines 179–189)

```
fn should_skip(&mut self, ts: OffsetDateTime, _id: Uuid) -> bool
```

**Purpose**: Determines whether a candidate item should be skipped because the scan has not yet moved past the previous page's anchor timestamp. It flips into pass-through mode once an older timestamp is encountered.

**Data flow**: Accepts a candidate timestamp and UUID. If `passed` is already true, returns false. Otherwise, if `ts < self.ts`, it sets `passed = true` and returns false; else it returns true. The UUID parameter is currently unused.

**Call relations**: Called by visitor and traversal loops before building thread items. It is the core pagination gate for timestamp-desc scans.

*Call graph*: called by 1 (visit).


##### `FilesByCreatedAtVisitor::visit`  (lines 220–254)

```
async fn visit(
        &mut self,
        ts: OffsetDateTime,
        id: Uuid,
        path: PathBuf,
        scanned: usize,
    ) -> ControlFlow<()>
```

**Purpose**: Processes one rollout file during created-at traversal, enforcing scan caps, pagination, and filters inline while building `ThreadItem`s. It stops traversal early once enough matches are found.

**Data flow**: Accepts file timestamp, UUID, path, and current scanned count. It first checks whether the hard scan cap has been reached with a full page, then consults `anchor_state.should_skip`, then stops if `items.len() == page_size`. Otherwise it computes `updated_at` via `file_modified_time(&path).await.unwrap_or(None).and_then(format_rfc3339)`, calls `build_thread_item(...)`, and pushes any returned item into `items`. It returns `ControlFlow::Break(())` or `Continue(())` accordingly.

**Call relations**: Invoked by `walk_rollout_files` during created-at traversal. It delegates summary extraction and filtering to `build_thread_item` and uses `file_modified_time` to populate the `updated_at` field.

*Call graph*: calls 3 internal fn (should_skip, build_thread_item, file_modified_time); 2 external calls (Break, Continue).


##### `FilesByUpdatedAtVisitor::visit`  (lines 264–278)

```
async fn visit(
        &mut self,
        _ts: OffsetDateTime,
        id: Uuid,
        path: PathBuf,
        _scanned: usize,
    ) -> ControlFlow<()>
```

**Purpose**: Collects lightweight file candidates for later updated-at sorting instead of building full thread items immediately. This is necessary because updated-at ordering is not encoded in filenames.

**Data flow**: Accepts timestamp, UUID, path, and scanned count, ignores the created-at timestamp and scanned count, computes `updated_at` via `file_modified_time(&path).await.unwrap_or(None)`, pushes `ThreadCandidate { path, id, updated_at }` into `candidates`, and returns `ControlFlow::Continue(())`.

**Call relations**: Invoked by `walk_rollout_files` during updated-at collection. It defers expensive summary extraction until after all candidates have been sorted by mtime.

*Call graph*: calls 1 internal fn (file_modified_time); 1 external calls (Continue).


##### `Cursor::serialize`  (lines 282–291)

```
fn serialize(&self, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: Serializes a cursor as an RFC3339 timestamp string. This makes pagination tokens stable and human-readable.

**Data flow**: Formats `self.ts` with `Rfc3339`, converts formatting errors into serializer errors, and calls `serializer.serialize_str(&ts_str)`.

**Call relations**: Used implicitly by Serde whenever a `Cursor` is encoded for API responses or persisted state.

*Call graph*: 2 external calls (format, serialize_str).


##### `Cursor::deserialize`  (lines 295–301)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Deserializes a cursor from its string token form using the same parsing rules as `parse_cursor`. Invalid tokens become Serde errors.

**Data flow**: Deserializes a `String`, passes it to `parse_cursor`, and returns the resulting `Cursor` or a custom `invalid cursor` deserialization error.

**Call relations**: Used implicitly by Serde when cursors are received from clients or restored from stored state.

*Call graph*: calls 1 internal fn (parse_cursor); 1 external calls (deserialize).


##### `Cursor::from`  (lines 305–312)

```
fn from(anchor: codex_state::Anchor) -> Self
```

**Purpose**: Converts a `codex_state::Anchor` into a listing cursor by translating its nanosecond timestamp into `OffsetDateTime`. Invalid or missing timestamps fall back to the Unix epoch.

**Data flow**: Accepts `codex_state::Anchor`, extracts `anchor.ts.timestamp_nanos_opt()`, converts to `OffsetDateTime::from_unix_timestamp_nanos`, falls back to `OffsetDateTime::UNIX_EPOCH` on failure, and returns `Cursor::new(ts)`.

**Call relations**: Used when bridging pagination state from the state layer into the rollout listing layer.

*Call graph*: 1 external calls (new).


##### `get_threads`  (lines 319–344)

```
async fn get_threads(
    codex_home: &Path,
    page_size: usize,
    cursor: Option<&Cursor>,
    sort_key: ThreadSortKey,
    allowed_sources: &[SessionSource],
    model_providers: Option<&[String
```

**Purpose**: Lists thread summaries from the standard active sessions root under `codex_home`, applying pagination, sorting, and filters. It is the main public listing entrypoint.

**Data flow**: Accepts `codex_home`, page size, optional cursor, sort key, allowed sources, optional model providers, optional cwd filters, and default provider. It joins `codex_home` with `SESSIONS_SUBDIR`, constructs a `ThreadListConfig` with `ThreadListLayout::NestedByDate`, and awaits `get_threads_in_root(...)`.

**Call relations**: Called by higher-level APIs that need active thread listings. It delegates all actual traversal and filtering to `get_threads_in_root`.

*Call graph*: calls 1 internal fn (get_threads_in_root); called by 15 (find_latest_thread_path, list_threads_from_files_desc_unfiltered, test_base_instructions_missing_in_meta_defaults_to_null, test_base_instructions_present_in_meta_is_preserved, test_created_at_sort_uses_file_mtime_for_updated_at, test_get_thread_contents, test_goal_first_thread_reads_later_user_message, test_list_conversations_latest_first, test_list_threads_scans_past_head_for_user_event, test_list_threads_uses_goal_objective_as_preview (+5 more)); 1 external calls (join).


##### `get_threads_in_root`  (lines 346–395)

```
async fn get_threads_in_root(
    root: PathBuf,
    page_size: usize,
    cursor: Option<&Cursor>,
    sort_key: ThreadSortKey,
    config: ThreadListConfig<'_>,
) -> io::Result<ThreadsPage>
```

**Purpose**: Lists thread summaries from an arbitrary root directory using the requested layout, sort key, and filters. It is the configurable core behind `get_threads`.

**Data flow**: Accepts a root `PathBuf`, page size, optional cursor, sort key, and `ThreadListConfig`. If the root does not exist, it returns an empty `ThreadsPage`. Otherwise it clones the cursor into `anchor`, builds an optional `ProviderMatcher` from `config.model_providers` and `config.default_provider`, dispatches to either `traverse_directories_for_paths` or `traverse_flat_paths` based on `config.layout`, and returns the resulting page.

**Call relations**: Called by `get_threads` and tests. It chooses the traversal strategy and prepares provider filtering before delegating.

*Call graph*: calls 2 internal fn (traverse_directories_for_paths, traverse_flat_paths); called by 2 (get_threads, list_threads_from_files_desc_unfiltered); 3 external calls (clone, exists, new).


##### `traverse_directories_for_paths`  (lines 401–434)

```
async fn traverse_directories_for_paths(
    root: PathBuf,
    page_size: usize,
    anchor: Option<Cursor>,
    sort_key: ThreadSortKey,
    allowed_sources: &[SessionSource],
    provider_matcher:
```

**Purpose**: Dispatches nested-date-directory traversal to the created-at or updated-at implementation based on the requested sort key. It is the sort-key switch for the standard directory layout.

**Data flow**: Accepts root, page size, anchor, sort key, allowed sources, optional provider matcher, and optional cwd filters. It matches `sort_key` and awaits either `traverse_directories_for_paths_created` or `traverse_directories_for_paths_updated`.

**Call relations**: Called by `get_threads_in_root` when `ThreadListLayout::NestedByDate` is selected.

*Call graph*: calls 2 internal fn (traverse_directories_for_paths_created, traverse_directories_for_paths_updated); called by 1 (get_threads_in_root).


##### `traverse_flat_paths`  (lines 436–469)

```
async fn traverse_flat_paths(
    root: PathBuf,
    page_size: usize,
    anchor: Option<Cursor>,
    sort_key: ThreadSortKey,
    allowed_sources: &[SessionSource],
    provider_matcher: Option<&Pro
```

**Purpose**: Dispatches flat-directory traversal to the created-at or updated-at implementation based on the requested sort key. It is the sort-key switch for flat roots.

**Data flow**: Accepts the same parameters as the nested traversal dispatcher and matches `sort_key` to await either `traverse_flat_paths_created` or `traverse_flat_paths_updated`.

**Call relations**: Called by `get_threads_in_root` when `ThreadListLayout::Flat` is selected.

*Call graph*: calls 2 internal fn (traverse_flat_paths_created, traverse_flat_paths_updated); called by 1 (get_threads_in_root).


##### `traverse_directories_for_paths_created`  (lines 477–516)

```
async fn traverse_directories_for_paths_created(
    root: PathBuf,
    page_size: usize,
    anchor: Option<Cursor>,
    allowed_sources: &[SessionSource],
    provider_matcher: Option<&ProviderMatch
```

**Purpose**: Scans nested date directories in reverse chronological order, building thread items inline in created-at order until the page fills or the scan cap is hit. It is the efficient path when filename timestamps define ordering.

**Data flow**: Allocates `items` with page-size capacity, initializes `scanned_files`, `more_matches_available`, and a `FilesByCreatedAtVisitor` with `AnchorState::new(anchor)`, then calls `walk_rollout_files(&root, &mut scanned_files, &mut visitor).await`. After traversal it derives `reached_scan_cap`, possibly forces `more_matches_available`, computes `next_cursor` with `build_next_cursor(&items, ThreadSortKey::CreatedAt)` when needed, and returns `ThreadsPage`.

**Call relations**: Called by `traverse_directories_for_paths`. It delegates per-file work to `FilesByCreatedAtVisitor::visit` via `walk_rollout_files`.

*Call graph*: calls 3 internal fn (new, build_next_cursor, walk_rollout_files); called by 1 (traverse_directories_for_paths); 1 external calls (with_capacity).


##### `traverse_directories_for_paths_updated`  (lines 526–585)

```
async fn traverse_directories_for_paths_updated(
    root: PathBuf,
    page_size: usize,
    anchor: Option<Cursor>,
    allowed_sources: &[SessionSource],
    provider_matcher: Option<&ProviderMatch
```

**Purpose**: Scans nested date directories, collects all candidates up to the scan cap, sorts them by file mtime descending, and then builds filtered thread items in updated-at order. This is the slower but necessary path for updated-at sorting.

**Data flow**: Allocates `items`, `scanned_files`, `anchor_state`, and `more_matches_available`, collects candidates with `collect_files_by_updated_at(&root, &mut scanned_files).await`, sorts them by `(Reverse(updated_at_or_epoch), Reverse(id))`, iterates candidates applying `anchor_state.should_skip`, page-size stopping, and `build_thread_item(...)` with an `updated_at_fallback`, then computes `reached_scan_cap`, optional `next_cursor` via `build_next_cursor(..., UpdatedAt)`, and returns `ThreadsPage`.

**Call relations**: Called by `traverse_directories_for_paths`. It separates candidate collection from summary extraction because updated-at ordering requires a full mtime sort.

*Call graph*: calls 4 internal fn (new, build_next_cursor, build_thread_item, collect_files_by_updated_at); called by 1 (traverse_directories_for_paths); 1 external calls (with_capacity).


##### `traverse_flat_paths_created`  (lines 587–642)

```
async fn traverse_flat_paths_created(
    root: PathBuf,
    page_size: usize,
    anchor: Option<Cursor>,
    allowed_sources: &[SessionSource],
    provider_matcher: Option<&ProviderMatcher<'_>>,
```

**Purpose**: Lists thread items from a flat root in created-at order using filename timestamps. It mirrors the nested created-at traversal without descending date directories.

**Data flow**: Allocates `items`, `scanned_files`, `anchor_state`, and `more_matches_available`, collects `(ts, id, path)` tuples with `collect_flat_rollout_files`, iterates them applying pagination and page-size checks, computes `updated_at` via `file_modified_time`, builds items with `build_thread_item`, then computes `reached_scan_cap`, optional `next_cursor`, and returns `ThreadsPage`.

**Call relations**: Called by `traverse_flat_paths` for flat roots sorted by created-at.

*Call graph*: calls 5 internal fn (new, build_next_cursor, build_thread_item, collect_flat_rollout_files, file_modified_time); called by 1 (traverse_flat_paths); 1 external calls (with_capacity).


##### `traverse_flat_paths_updated`  (lines 644–703)

```
async fn traverse_flat_paths_updated(
    root: PathBuf,
    page_size: usize,
    anchor: Option<Cursor>,
    allowed_sources: &[SessionSource],
    provider_matcher: Option<&ProviderMatcher<'_>>,
```

**Purpose**: Lists thread items from a flat root in updated-at order by collecting candidates, sorting by mtime, and then building summaries. It is the flat-root analogue of the nested updated-at traversal.

**Data flow**: Allocates `items`, `scanned_files`, `anchor_state`, and `more_matches_available`, collects candidates with `collect_flat_files_by_updated_at`, sorts them by `(Reverse(updated_at_or_epoch), Reverse(id))`, iterates with pagination and page-size checks, builds items with `build_thread_item`, then computes `reached_scan_cap`, optional `next_cursor`, and returns `ThreadsPage`.

**Call relations**: Called by `traverse_flat_paths` when flat roots are sorted by updated-at.

*Call graph*: calls 4 internal fn (new, build_next_cursor, build_thread_item, collect_flat_files_by_updated_at); called by 1 (traverse_flat_paths); 1 external calls (with_capacity).


##### `parse_cursor`  (lines 706–720)

```
fn parse_cursor(token: &str) -> Option<Cursor>
```

**Purpose**: Parses a pagination token into a `Cursor`, accepting either RFC3339 timestamps or the filename-style `YYYY-MM-DDThh-mm-ss` format. Tokens containing `|` are rejected outright.

**Data flow**: Accepts `&str`, returns `None` if the token contains `|`, otherwise tries `OffsetDateTime::parse(token, &Rfc3339)` and falls back to parsing with a custom format description and `PrimitiveDateTime::assume_utc`. On success it wraps the timestamp with `Cursor::new`.

**Call relations**: Used by `Cursor` deserialization and other cursor-construction helpers that accept external token strings.

*Call graph*: calls 1 internal fn (new); called by 3 (deserialize, cursor_from_thread_item, cursor_to_anchor_normalizes_timestamp_format); 1 external calls (parse).


##### `build_next_cursor`  (lines 722–734)

```
fn build_next_cursor(items: &[ThreadItem], sort_key: ThreadSortKey) -> Option<Cursor>
```

**Purpose**: Builds the pagination cursor for the next page from the last returned item, using either its created-at filename timestamp or its updated-at field depending on sort order. This keeps pagination aligned with the active ordering key.

**Data flow**: Accepts a slice of `ThreadItem` and a `ThreadSortKey`. It takes the last item, extracts its filename, parses `(created_ts, _id)` with `parse_timestamp_uuid_from_filename`, then chooses `created_ts` for `CreatedAt` or parses `last.updated_at` as RFC3339 for `UpdatedAt`. It returns `Some(Cursor::new(ts))` or `None` if any required data is missing.

**Call relations**: Called by all traversal variants when there may be more results beyond the current page.

*Call graph*: calls 2 internal fn (new, parse_timestamp_uuid_from_filename); called by 4 (traverse_directories_for_paths_created, traverse_directories_for_paths_updated, traverse_flat_paths_created, traverse_flat_paths_updated); 2 external calls (parse, last).


##### `build_thread_item`  (lines 736–813)

```
async fn build_thread_item(
    path: PathBuf,
    allowed_sources: &[SessionSource],
    provider_matcher: Option<&ProviderMatcher<'_>>,
    cwd_filters: Option<&[PathBuf]>,
    updated_at: Option<St
```

**Purpose**: Reads a rollout file's head, applies source/provider/cwd filters, and constructs the user-facing `ThreadItem` summary if the rollout is discoverable. It is the central summary-extraction routine for listing and direct lookup.

**Data flow**: Accepts a rollout path, allowed sources, optional provider matcher, optional cwd filters, and optional fallback `updated_at` string. It reads `HeadTailSummary` via `read_head_summary(&path, HEAD_RECORD_LIMIT).await.unwrap_or_default()`, rejects the file if source/provider/cwd filters do not match, and only proceeds when `saw_session_meta` is true and `preview` is present. It then destructures the summary, fills `updated_at` from the summary or fallback or created-at, and returns `Some(ThreadItem { ... })`; otherwise `None`.

**Call relations**: Called by traversal visitors, traversal loops, and `read_thread_item_from_rollout`. It depends on `read_head_summary` for bounded parsing and on `ProviderMatcher`/path normalization for filtering.

*Call graph*: calls 1 internal fn (read_head_summary); called by 5 (visit, read_thread_item_from_rollout, traverse_directories_for_paths_updated, traverse_flat_paths_created, traverse_flat_paths_updated); 1 external calls (is_empty).


##### `read_thread_item_from_rollout`  (lines 820–829)

```
async fn read_thread_item_from_rollout(path: PathBuf) -> Option<ThreadItem>
```

**Purpose**: Builds a single `ThreadItem` summary from a known rollout path without scanning directories. It is the direct-summary convenience wrapper around `build_thread_item`.

**Data flow**: Accepts a `PathBuf`, calls `build_thread_item(path, &[], None, None, None).await`, and returns the resulting `Option<ThreadItem>`.

**Call relations**: Used by callers that already resolved a rollout path and want the same summary extraction logic as list operations.

*Call graph*: calls 1 internal fn (build_thread_item).


##### `collect_dirs_desc`  (lines 833–854)

```
async fn collect_dirs_desc(parent: &Path, parse: F) -> io::Result<Vec<(T, PathBuf)>>
```

**Purpose**: Collects immediate subdirectories whose names parse successfully and returns them sorted descending by the parsed key. It is the generic helper for year/month/day directory traversal.

**Data flow**: Accepts a parent path and a parse function `Fn(&str) -> Option<T>`. It reads the directory asynchronously, filters entries to directories, converts names to strings, applies `parse`, pushes `(parsed_value, entry.path())` into a vector, sorts by `Reverse(parsed_value)`, and returns the vector.

**Call relations**: Used by `walk_rollout_files` to traverse `YYYY/MM/DD` directories in reverse chronological order.

*Call graph*: called by 1 (walk_rollout_files); 2 external calls (new, read_dir).


##### `collect_files`  (lines 857–876)

```
async fn collect_files(parent: &Path, parse: F) -> io::Result<Vec<T>>
```

**Purpose**: Collects files in a directory and transforms them with a caller-provided parser. It is the generic file-collection helper used for day-directory scans.

**Data flow**: Accepts a parent path and parse function `Fn(&str, &Path) -> Option<T>`. It reads the directory asynchronously, filters to regular files, converts names to strings, applies the parser, pushes successful results into a vector, and returns it.

**Call relations**: Used by `collect_rollout_day_files` to gather rollout files from one day directory.

*Call graph*: called by 1 (collect_rollout_day_files); 2 external calls (new, read_dir).


##### `collect_flat_rollout_files`  (lines 878–911)

```
async fn collect_flat_rollout_files(
    root: &Path,
    scanned_files: &mut usize,
) -> io::Result<Vec<(OffsetDateTime, Uuid, PathBuf)>>
```

**Purpose**: Collects rollout files from a flat root, parses their created-at timestamps and UUIDs from filenames, and returns them sorted newest first. It enforces the global scan cap while scanning.

**Data flow**: Accepts a root path and mutable scanned-file counter, reads the directory, skips non-files, normalizes entries with `compression::RolloutFile::from_path`, parses `(ts, id)` from `plain_file_name`, increments `scanned_files` for each accepted rollout, stops when the cap is exceeded, pushes `(ts, id, rollout_file.into_path())` into a vector, sorts by `(Reverse(ts), Reverse(id))`, and returns it.

**Call relations**: Called by `traverse_flat_paths_created` as the flat-root created-at candidate collector.

*Call graph*: calls 2 internal fn (from_path, parse_timestamp_uuid_from_filename); called by 1 (traverse_flat_paths_created); 2 external calls (new, read_dir).


##### `collect_rollout_day_files`  (lines 913–925)

```
async fn collect_rollout_day_files(
    day_path: &Path,
) -> io::Result<Vec<(OffsetDateTime, Uuid, PathBuf)>>
```

**Purpose**: Collects rollout files from one day directory and returns them sorted by created-at timestamp and UUID descending. It is the per-day helper used by nested traversal.

**Data flow**: Accepts a day directory path, calls `collect_files` with a parser that builds `compression::RolloutFile`, parses `(ts, id)` from `plain_file_name`, and returns `(ts, id, rollout_file.into_path())`. It then sorts the resulting vector by `(Reverse(ts), Reverse(id))` and returns it.

**Call relations**: Called by `walk_rollout_files` for each day directory encountered during nested traversal.

*Call graph*: calls 1 internal fn (collect_files); called by 1 (walk_rollout_files).


##### `parse_timestamp_uuid_from_filename`  (lines 927–943)

```
fn parse_timestamp_uuid_from_filename(name: &str) -> Option<(OffsetDateTime, Uuid)>
```

**Purpose**: Parses the created-at timestamp and thread UUID encoded in a rollout filename, accepting both plain and compressed names. It is the canonical filename parser for ordering and id lookup.

**Data flow**: Accepts a filename string, normalizes it with `compression::parse_rollout_file_name`, strips the `rollout-` prefix and `.jsonl` suffix, scans from the right for a `-` whose suffix parses as a `Uuid`, parses the left portion as `PrimitiveDateTime` with the fixed `YYYY-MM-DDThh-mm-ss` format, converts it to UTC `OffsetDateTime`, and returns `Some((ts, uuid))` or `None`.

**Call relations**: Used by cursor construction, file collection, id lookup, and other code that derives ordering or identity from rollout filenames.

*Call graph*: called by 6 (build_next_cursor, collect_flat_files_by_updated_at, collect_flat_rollout_files, find_rollout_path_by_id_from_filenames, builder_from_items, thread_item_sort_key); 3 external calls (parse, parse_rollout_file_name, format_description!).


##### `collect_files_by_updated_at`  (lines 951–962)

```
async fn collect_files_by_updated_at(
    root: &Path,
    scanned_files: &mut usize,
) -> io::Result<Vec<ThreadCandidate>>
```

**Purpose**: Collects `ThreadCandidate`s from a nested date-directory tree for later updated-at sorting. It delegates traversal to the generic rollout walker.

**Data flow**: Accepts a root path and mutable scanned-file counter, initializes an empty candidate vector and `FilesByUpdatedAtVisitor`, calls `walk_rollout_files(root, scanned_files, &mut visitor).await`, and returns the collected candidates.

**Call relations**: Called by `traverse_directories_for_paths_updated` before sorting candidates by mtime.

*Call graph*: calls 1 internal fn (walk_rollout_files); called by 1 (traverse_directories_for_paths_updated); 1 external calls (new).


##### `collect_flat_files_by_updated_at`  (lines 964–1004)

```
async fn collect_flat_files_by_updated_at(
    root: &Path,
    scanned_files: &mut usize,
) -> io::Result<Vec<ThreadCandidate>>
```

**Purpose**: Collects `ThreadCandidate`s from a flat root for later updated-at sorting. It is the flat-root analogue of `collect_files_by_updated_at`.

**Data flow**: Accepts a root path and mutable scanned-file counter, reads the directory, filters to regular files, normalizes with `compression::RolloutFile::from_path`, parses UUIDs from filenames, increments the scan counter, computes `updated_at` via `file_modified_time(rollout_file.path()).await.unwrap_or(None)`, pushes `ThreadCandidate { path: rollout_file.into_path(), id, updated_at }`, and returns the vector.

**Call relations**: Called by `traverse_flat_paths_updated` before sorting candidates by mtime.

*Call graph*: calls 3 internal fn (from_path, file_modified_time, parse_timestamp_uuid_from_filename); called by 1 (traverse_flat_paths_updated); 2 external calls (new, read_dir).


##### `walk_rollout_files`  (lines 1006–1044)

```
async fn walk_rollout_files(
    root: &Path,
    scanned_files: &mut usize,
    visitor: &mut impl RolloutFileVisitor,
) -> io::Result<()>
```

**Purpose**: Traverses the nested `YYYY/MM/DD` rollout directory tree in reverse chronological order and invokes a visitor for each rollout file until traversal completes or the visitor breaks. It is the generic nested-tree walker.

**Data flow**: Accepts a root path, mutable scanned-file counter, and mutable visitor. It collects year, month, and day directories descending with `collect_dirs_desc`, then for each day collects sorted files with `collect_rollout_day_files`. For each `(ts, id, path)` it increments `scanned_files`, stops if the cap is exceeded, and awaits `visitor.visit(ts, id, path, *scanned_files)`, breaking out of nested loops on `ControlFlow::Break(())`.

**Call relations**: Used by created-at and updated-at nested traversal paths. It delegates per-file behavior to the visitor implementations.

*Call graph*: calls 2 internal fn (collect_dirs_desc, collect_rollout_day_files); called by 2 (collect_files_by_updated_at, traverse_directories_for_paths_created); 1 external calls (visit).


##### `ProviderMatcher::new`  (lines 1052–1062)

```
fn new(filters: &'a [String], default_provider: &'a str) -> Option<Self>
```

**Purpose**: Builds an optional provider matcher from a non-empty filter list and the configured default provider. Empty filter lists disable provider filtering entirely.

**Data flow**: Accepts a slice of provider filter strings and the default provider string. If `filters.is_empty()`, returns `None`; otherwise computes whether any filter equals the default provider and returns `Some(ProviderMatcher { filters, matches_default_provider })`.

**Call relations**: Called by `get_threads_in_root` before traversal so provider filtering can be applied during summary construction.


##### `ProviderMatcher::matches`  (lines 1064–1069)

```
fn matches(&self, session_provider: Option<&str>) -> bool
```

**Purpose**: Checks whether a session's model provider matches the configured provider filters, treating missing session providers as matching only when the default provider is allowed. This handles older rollouts that may omit provider metadata.

**Data flow**: Accepts `Option<&str>` for the session provider. If `Some(provider)`, it returns whether any filter equals that provider. If `None`, it returns `self.matches_default_provider`.

**Call relations**: Called by `build_thread_item` when provider filtering is enabled.


##### `read_head_summary`  (lines 1072–1154)

```
async fn read_head_summary(path: &Path, head_limit: usize) -> io::Result<HeadTailSummary>
```

**Purpose**: Reads a bounded prefix of a rollout file and extracts the metadata and preview fields needed for thread listing. It stops early once it has enough information or reaches the extended scan limit.

**Data flow**: Accepts a rollout path and head limit, opens a `RolloutLineReader` via `compression::open_rollout_line_reader`, initializes `HeadTailSummary::default()` and `lines_scanned`, then loops while under the head limit or still missing preview/first-user-message after seeing session meta. It reads lines, trims and skips empties, parses `RolloutLine` with `serde_json::from_str`, and updates summary fields based on `RolloutItem`: first `SessionMeta` populates source/thread/cwd/git/provider/version/created_at; `ResponseItem` and `InterAgentCommunication` can backfill `created_at`; `EventMsg` uses `event_msg_preview` to set `preview` and `first_user_message`. It breaks early once session meta, preview, and first user message are all present, then returns the summary.

**Call relations**: Called by `build_thread_item`. It depends on compression-aware line reading and `event_msg_preview` to keep listing fast without parsing entire transcripts.

*Call graph*: calls 2 internal fn (open_rollout_line_reader, event_msg_preview); called by 1 (build_thread_item); 2 external calls (default, from_str).


##### `read_head_for_summary`  (lines 1158–1195)

```
async fn read_head_for_summary(path: &Path) -> io::Result<Vec<serde_json::Value>>
```

**Purpose**: Reads up to `HEAD_RECORD_LIMIT` records from the start of a rollout and returns only the summary-relevant items as raw JSON values. It is used by callers that need the head payloads themselves rather than a reduced summary struct.

**Data flow**: Accepts a rollout path, opens a `RolloutLineReader`, initializes an empty `Vec<serde_json::Value>`, then reads lines until the head limit or EOF. It trims and skips empty lines, parses `RolloutLine`, and for `SessionMeta`, `ResponseItem`, and `InterAgentCommunication` converts the inner item to JSON with `serde_json::to_value` and pushes it. `Compacted`, `TurnContext`, and `EventMsg` are ignored. It returns the collected JSON values.

**Call relations**: Called by `read_session_meta_line` and tests that inspect rollout heads. It shares the same compression-aware reader as summary extraction.

*Call graph*: calls 1 internal fn (open_rollout_line_reader); called by 3 (read_session_meta_line, test_base_instructions_missing_in_meta_defaults_to_null, test_base_instructions_present_in_meta_is_preserved); 2 external calls (new, to_value).


##### `strip_user_message_prefix`  (lines 1197–1202)

```
fn strip_user_message_prefix(text: &str) -> &str
```

**Purpose**: Removes the protocol's `USER_MESSAGE_BEGIN` prefix from a user message preview and trims surrounding whitespace. If the prefix is absent, it just trims the whole string.

**Data flow**: Accepts `&str`, searches for `USER_MESSAGE_BEGIN`, and returns the substring after the prefix trimmed, or `text.trim()` if the prefix is not found.

**Call relations**: Used only by `event_msg_preview` when deriving previews from `EventMsg::UserMessage`.

*Call graph*: called by 1 (event_msg_preview).


##### `event_msg_preview`  (lines 1204–1227)

```
fn event_msg_preview(event: &EventMsg) -> Option<String>
```

**Purpose**: Extracts a user-facing preview string from selected event message types. It prefers meaningful text and falls back to `[Image]` for image-only user messages.

**Data flow**: Accepts `&EventMsg`. For `UserMessage`, it strips the prefix from `user.message`, returns the non-empty text if present, otherwise returns `[Image]` if remote or local images exist, else `None`. For `ThreadGoalUpdated`, it returns the trimmed non-empty objective string. All other event types return `None`.

**Call relations**: Called by `read_head_summary` while scanning early rollout events for preview-bearing content.

*Call graph*: calls 1 internal fn (strip_user_message_prefix); called by 1 (read_head_summary).


##### `read_session_meta_line`  (lines 1231–1245)

```
async fn read_session_meta_line(path: &Path) -> io::Result<SessionMetaLine>
```

**Purpose**: Reads and returns the `SessionMetaLine` from the head of a rollout file, erroring if the rollout is empty or does not begin with session metadata. It is the verification primitive used by path lookup and repair logic.

**Data flow**: Accepts a rollout path, reads the head JSON values with `read_head_for_summary(path).await`, takes the first value or returns `io::Error::other("rollout at ... is empty")`, then attempts `serde_json::from_value::<SessionMetaLine>(first.clone())`, mapping failure to `io::Error::other("rollout at ... does not start with session metadata")`.

**Call relations**: Called by `find_thread_path_by_id_str_in_subdir`, metadata lookup, and state-db repair paths to verify that a candidate file belongs to the expected thread.

*Call graph*: calls 1 internal fn (read_head_for_summary); called by 3 (find_thread_path_by_id_str_in_subdir, find_thread_meta_by_name_str, read_repair_rollout_path); 2 external calls (other, format!).


##### `file_modified_time`  (lines 1247–1251)

```
async fn file_modified_time(path: &Path) -> io::Result<Option<OffsetDateTime>>
```

**Purpose**: Returns the rollout file's modification time truncated to millisecond precision. This normalizes filesystem timestamps before they are serialized or compared.

**Data flow**: Accepts `&Path`, awaits `compression::file_modified_time(path)`, and maps any returned `OffsetDateTime` through `truncate_to_millis` before wrapping it back in `Option`.

**Call relations**: Used by listing visitors and flat-file collectors whenever `updated_at` ordering or display is needed.

*Call graph*: calls 1 internal fn (file_modified_time); called by 4 (visit, visit, collect_flat_files_by_updated_at, traverse_flat_paths_created).


##### `format_rfc3339`  (lines 1253–1255)

```
fn format_rfc3339(dt: OffsetDateTime) -> Option<String>
```

**Purpose**: Formats an `OffsetDateTime` as an RFC3339 string, returning `None` on formatting failure. It is the stringification helper for created/updated timestamps.

**Data flow**: Accepts `OffsetDateTime`, calls `dt.format(&Rfc3339).ok()`, and returns `Option<String>`.

**Call relations**: Used when populating `ThreadItem.updated_at` and other timestamp fields from filesystem times.

*Call graph*: 1 external calls (format).


##### `truncate_to_millis`  (lines 1257–1260)

```
fn truncate_to_millis(dt: OffsetDateTime) -> Option<OffsetDateTime>
```

**Purpose**: Rounds an `OffsetDateTime` down to millisecond precision by zeroing sub-millisecond nanoseconds. This avoids unstable higher-precision timestamps from filesystem metadata.

**Data flow**: Accepts `OffsetDateTime`, computes `millis_nanos = (dt.nanosecond() / 1_000_000) * 1_000_000`, calls `dt.replace_nanosecond(millis_nanos).ok()`, and returns the truncated timestamp or `None` on failure.

**Call relations**: Used by the local `file_modified_time` wrapper before timestamps are formatted or sorted.

*Call graph*: 2 external calls (nanosecond, replace_nanosecond).


##### `find_thread_path_by_id_str_in_subdir`  (lines 1262–1424)

```
async fn find_thread_path_by_id_str_in_subdir(
    codex_home: &Path,
    subdir: &str,
    id_str: &str,
    state_db_ctx: Option<&codex_state::StateRuntime>,
) -> io::Result<Option<PathBuf>>
```

**Purpose**: Finds a rollout path by thread UUID within either the active or archived subdirectory, preferring verified state-db results but falling back to filename scanning and broader file search. It also records discrepancies and attempts read repair when fallback succeeds.

**Data flow**: Accepts `codex_home`, a subdir name, the thread id string, and optional `state_db_ctx`. It first validates UUID syntax and derives `archived_only` plus optional `ThreadId`. If a state DB is available, it calls `find_rollout_path_by_id`, resolves any returned path through `compression::existing_rollout_path`, and verifies ownership by reading `SessionMeta` with `read_session_meta_line`; verified matches return immediately, mismatches/stale paths log errors and record fallback telemetry, and unverifiable-but-existing paths are saved as `unverified_db_path`. It then builds the filesystem root, returns `unverified_db_path` if the root does not exist, otherwise tries `find_rollout_path_by_id_from_filenames`. If that fails to find a match, it runs broader `codex_file_search::run` with limit 1, normalizes matches through `compression::RolloutFile::from_path`, and picks the first path. When a fallback path is found, it logs DB discrepancy warnings, records fallback telemetry, and calls `state_db::read_repair_rollout_path(...)`. Finally it returns the found path or the earlier `unverified_db_path`.

**Call relations**: Called by both `find_thread_path_by_id_str` and `find_archived_thread_path_by_id_str`. It orchestrates DB lookup, on-disk verification, filename scanning, broad search fallback, and read repair.

*Call graph*: calls 4 internal fn (from_string, find_rollout_path_by_id_from_filenames, read_session_meta_line, read_repair_rollout_path); called by 2 (find_archived_thread_path_by_id_str, find_thread_path_by_id_str); 11 external calls (default, new, to_path_buf, parse_str, record_fallback, existing_rollout_path, run, debug!, error!, warn! (+1 more)).


##### `find_rollout_path_by_id_from_filenames`  (lines 1426–1464)

```
async fn find_rollout_path_by_id_from_filenames(
    root: &Path,
    id_str: &str,
) -> io::Result<Option<PathBuf>>
```

**Purpose**: Recursively scans a root directory for a rollout filename whose embedded UUID matches the target thread id. It is the fast filesystem fallback before broader content search.

**Data flow**: Accepts a root path and id string, parses the target UUID or returns `Ok(None)` if invalid, then depth-first traverses directories with a stack and `tokio::fs::read_dir`. For each regular file it normalizes with `compression::RolloutFile::from_path`, parses `(ts, id)` from `plain_file_name`, and returns `Ok(Some(rollout_file.into_path()))` on the first UUID match. If traversal completes without a match, it returns `Ok(None)`.

**Call relations**: Called by `find_thread_path_by_id_str_in_subdir` before falling back to broader file search.

*Call graph*: calls 2 internal fn (from_path, parse_timestamp_uuid_from_filename); called by 1 (find_thread_path_by_id_str_in_subdir); 3 external calls (parse_str, read_dir, vec!).


##### `find_thread_path_by_id_str`  (lines 1469–1475)

```
async fn find_thread_path_by_id_str(
    codex_home: &Path,
    id_str: &str,
    state_db_ctx: Option<&codex_state::StateRuntime>,
) -> io::Result<Option<PathBuf>>
```

**Purpose**: Finds an active-session rollout path by thread UUID string. It is the public wrapper for active-session lookup.

**Data flow**: Accepts `codex_home`, id string, and optional state DB context, then awaits `find_thread_path_by_id_str_in_subdir(codex_home, SESSIONS_SUBDIR, id_str, state_db_ctx)`.

**Call relations**: Called by higher-level APIs that need to resolve active rollout files by thread id.

*Call graph*: calls 1 internal fn (find_thread_path_by_id_str_in_subdir); called by 2 (cleanup_stale_snapshots, find_thread_meta_by_name_str).


##### `find_archived_thread_path_by_id_str`  (lines 1478–1485)

```
async fn find_archived_thread_path_by_id_str(
    codex_home: &Path,
    id_str: &str,
    state_db_ctx: Option<&codex_state::StateRuntime>,
) -> io::Result<Option<PathBuf>>
```

**Purpose**: Finds an archived rollout path by thread UUID string. It is the archived-session counterpart to `find_thread_path_by_id_str`.

**Data flow**: Accepts `codex_home`, id string, and optional state DB context, then awaits `find_thread_path_by_id_str_in_subdir(codex_home, ARCHIVED_SESSIONS_SUBDIR, id_str, state_db_ctx)`.

**Call relations**: Used by callers that specifically search archived rollout storage.

*Call graph*: calls 1 internal fn (find_thread_path_by_id_str_in_subdir).


##### `rollout_date_parts`  (lines 1488–1495)

```
fn rollout_date_parts(file_name: &OsStr) -> Option<(String, String, String)>
```

**Purpose**: Extracts `YYYY`, `MM`, and `DD` strings from a rollout filename's date prefix. It is a lightweight helper for deriving directory components from filenames.

**Data flow**: Accepts `&OsStr`, converts it to a lossy string, strips the `rollout-` prefix, takes the first 10 characters as the date, slices out year/month/day substrings, clones them into `String`s, and returns `Some((year, month, day))` or `None` if the filename does not match the expected shape.

**Call relations**: Used by code that needs to map rollout filenames back to date-directory components.

*Call graph*: 1 external calls (to_string_lossy).


### `rollout/src/recorder.rs`

`orchestration` · `request handling and long-lived session recording/listing`

This file is the core rollout subsystem. On the write side, `RolloutRecorder` owns an async `mpsc` channel and a shared `RolloutWriterTask` that tracks the spawned writer task and any terminal `IoError`. New sessions are created in deferred mode: `precompute_log_file_info` chooses a dated path under `sessions/YYYY/MM/DD`, `RolloutRecorder::new` prepares a `SessionMeta` but does not create the file until `persist()` or `flush()` forces materialization. Resumed sessions instead materialize/open the existing rollout immediately. The background `rollout_writer` owns `RolloutWriterState`, which buffers `pending_items`, writes session metadata once, flushes after writes, and on I/O failure drops the writer handle but keeps unwritten items so a later barrier can reopen and retry. `record_canonical_items`, `persist`, `flush`, and `shutdown` are thin command senders over this task.

On the read side, `load_rollout_items` streams JSONL lines through the compression layer, skips blank lines, strips legacy `ghost_snapshot` response items (including inside compaction replacement history), counts parse errors instead of failing the whole file, and returns the first `SessionMeta` thread ID plus all surviving items. `get_rollout_history` wraps that into `InitialHistory`.

The file also contains thread-listing orchestration. `list_threads_with_db_fallback` combines filesystem scans and SQLite listing depending on filters, sort direction, and DB availability. It can overfetch from the filesystem, repair stale DB rows via `read_repair_rollout_path` or full `reconcile_rollout`, overlay missing metadata from state DB onto filesystem `ThreadItem`s, and fall back to filesystem pages when SQLite is unavailable or inconsistent. Additional helpers implement ascending/descending filesystem scans, title search via the sidecar session index, conversion from `codex_state::ThreadMetadata` to `ThreadItem`, and cwd-aware resume-path selection that first trusts cached cwd, then latest `TurnContext`, then full metadata extraction.

#### Function details

##### `RolloutWriterTask::new`  (lines 120–125)

```
fn new() -> Self
```

**Purpose**: Initializes the shared observability state for a background writer task. Both the join handle and terminal failure slot start empty.

**Data flow**: Allocates a `RolloutWriterTask` with `Mutex<Option<JoinHandle<()>>>` and `Mutex<Option<Arc<IoError>>>` both set to `None`; returns the new struct.

**Call relations**: Called from `RolloutRecorder::new` before spawning the writer task so all recorder clones can later inspect task state.

*Call graph*: called by 1 (new); 1 external calls (new).


##### `RolloutWriterTask::set_handle`  (lines 128–134)

```
fn set_handle(&self, handle: JoinHandle<()>)
```

**Purpose**: Stores the spawned Tokio task handle inside the shared writer-task state. This keeps ownership of the background task tied to the recorder lifecycle.

**Data flow**: Takes a `JoinHandle<()>`, locks the internal `handle` mutex with poison recovery, and replaces the stored option with `Some(handle)`; returns no value.

**Call relations**: Used only by `RolloutRecorder::new` immediately after spawning `rollout_writer`.


##### `RolloutWriterTask::mark_failed`  (lines 137–143)

```
fn mark_failed(&self, err: &IoError)
```

**Purpose**: Records a terminal background-task failure so later API calls can surface a concrete `IoError` instead of a generic channel error. It clones the error into owned storage.

**Data flow**: Accepts an `&IoError`, locks `terminal_failure`, clones the error via `clone_io_error`, wraps it in `Arc`, and stores it as `Some(...)`.

**Call relations**: Called from the spawned task wrapper in `RolloutRecorder::new` only when `rollout_writer` itself exits with an error rather than reporting a recoverable command-level failure.

*Call graph*: calls 1 internal fn (clone_io_error); 1 external calls (new).


##### `RolloutWriterTask::terminal_failure`  (lines 146–152)

```
fn terminal_failure(&self) -> Option<IoError>
```

**Purpose**: Returns a fresh owned copy of the terminal writer-task error, if one has been recorded. This avoids exposing shared mutable state to callers.

**Data flow**: Locks `terminal_failure`, reads the optional `Arc<IoError>`, clones the underlying error with `clone_io_error`, and returns `Option<IoError>`.

**Call relations**: Queried by recorder APIs when channel sends or oneshot waits fail, so they can prefer the real writer failure over a generic messaging error.


##### `clone_io_error`  (lines 155–157)

```
fn clone_io_error(err: &IoError) -> IoError
```

**Purpose**: Creates a new `std::io::Error` with the same kind and message as another error. It is a small helper for storing and re-emitting I/O failures.

**Data flow**: Reads `err.kind()` and `err.to_string()`, constructs a new `IoError::new(kind, message)`, and returns it.

**Call relations**: Used by `RolloutWriterTask::mark_failed` and `RolloutWriterTask::terminal_failure` to avoid sharing the original error object directly.

*Call graph*: called by 1 (mark_failed); 3 external calls (kind, new, to_string).


##### `RolloutRecorderParams::new`  (lines 160–179)

```
fn new(
        conversation_id: ThreadId,
        forked_from_id: Option<ThreadId>,
        parent_thread_id: Option<ThreadId>,
        source: SessionSource,
        thread_source: Option<ThreadSour
```

**Purpose**: Builds `RolloutRecorderParams::Create` for a new session with no multi-agent version set. It packages the metadata needed to synthesize the initial `SessionMeta` line later.

**Data flow**: Consumes conversation/thread IDs, source info, base instructions, and dynamic tools; returns the `Create` enum variant with `multi_agent_version: None`.

**Call relations**: Used by recorder creation call sites and tests as the standard constructor for new-session recording.

*Call graph*: called by 4 (find_locates_rollout_file_written_by_recorder, persist_reports_filesystem_error_and_retries_buffered_items, recorder_materializes_on_flush_with_pending_items, create_thread).


##### `RolloutRecorderParams::with_multi_agent_version`  (lines 181–193)

```
fn with_multi_agent_version(
        mut self,
        multi_agent_version: Option<MultiAgentVersion>,
    ) -> Self
```

**Purpose**: Adds or replaces the `multi_agent_version` field on a `Create` parameter set while leaving `Resume` parameters unchanged. It supports fluent configuration.

**Data flow**: Takes ownership of `self` and an `Option<MultiAgentVersion>`; if `self` is `Create`, mutates the embedded `multi_agent_version`; returns the updated enum value.

**Call relations**: Called by higher-level setup code that wants to enrich a create request before passing it to `RolloutRecorder::new`.


##### `RolloutRecorderParams::resume`  (lines 195–197)

```
fn resume(path: PathBuf) -> Self
```

**Purpose**: Builds `RolloutRecorderParams::Resume` for reopening an existing rollout file. It is the constructor for resume-mode recorder creation.

**Data flow**: Consumes a `PathBuf` and returns `RolloutRecorderParams::Resume { path }`.

**Call relations**: Used by resume flows and tests that reopen an existing rollout rather than creating a deferred new one.

*Call graph*: called by 2 (resume_materializes_compressed_rollout_path, resume_thread).


##### `RolloutRecorder::list_threads`  (lines 215–244)

```
async fn list_threads(
        state_db_ctx: Option<StateDbHandle>,
        config: &impl RolloutConfigView,
        page_size: usize,
        cursor: Option<&Cursor>,
        sort_key: ThreadSortKey,
```

**Purpose**: Lists active threads using the normal filesystem-plus-state-DB repair strategy. It is the public entry point for non-archived thread listing.

**Data flow**: Forwards all listing parameters plus `ThreadListArchiveFilter::Active` and `ThreadListRepairMode::ScanAndRepair` into `list_threads_with_db_fallback`; returns the resulting `ThreadsPage`.

**Call relations**: Called by UI/API listing code and many tests. It is the standard active-thread listing path that may scan files and repair SQLite rows.

*Call graph*: called by 9 (thread_list_respects_search_term_filter, list_threads_db_disabled_does_not_skip_paginated_items, list_threads_db_enabled_drops_missing_rollout_paths, list_threads_db_enabled_repairs_stale_rollout_paths, list_threads_default_filter_returns_filesystem_scan_results, list_threads_metadata_filter_overlays_state_db_list_metadata, list_threads_search_repairs_stale_state_db_hits_before_returning, list_threads_state_db_only_skips_jsonl_repair_scan, list_rollout_threads); 1 external calls (list_threads_with_db_fallback).


##### `RolloutRecorder::list_threads_from_state_db`  (lines 247–276)

```
async fn list_threads_from_state_db(
        state_db_ctx: Option<StateDbHandle>,
        config: &impl RolloutConfigView,
        page_size: usize,
        cursor: Option<&Cursor>,
        sort_key:
```

**Purpose**: Lists active threads strictly from the state DB without filesystem repair scanning. It exposes the DB-only view for callers that want speed or to test stale-row behavior.

**Data flow**: Passes the caller’s filters into `list_threads_with_db_fallback` with `Active` archive mode and `StateDbOnly` repair mode; returns a `ThreadsPage` converted from DB rows or defaulted on DB failure.

**Call relations**: Used by tests and callers that explicitly want to skip JSONL reconciliation and observe the current SQLite contents.

*Call graph*: called by 4 (list_threads_default_filter_returns_filesystem_scan_results, list_threads_search_repairs_stale_state_db_hits_before_returning, list_threads_state_db_only_skips_jsonl_repair_scan, list_rollout_threads); 1 external calls (list_threads_with_db_fallback).


##### `RolloutRecorder::list_archived_threads`  (lines 280–309)

```
async fn list_archived_threads(
        state_db_ctx: Option<StateDbHandle>,
        config: &impl RolloutConfigView,
        page_size: usize,
        cursor: Option<&Cursor>,
        sort_key: Threa
```

**Purpose**: Lists archived threads using the normal scan-and-repair strategy. It is the archived analogue of `list_threads`.

**Data flow**: Delegates to `list_threads_with_db_fallback` with `ThreadListArchiveFilter::Archived` and `ScanAndRepair`, preserving all other filters and pagination inputs.

**Call relations**: Called by archived-thread listing flows; it differs from active listing only in the root directory and archived flag passed downstream.

*Call graph*: called by 1 (list_rollout_threads); 1 external calls (list_threads_with_db_fallback).


##### `RolloutRecorder::list_archived_threads_from_state_db`  (lines 312–341)

```
async fn list_archived_threads_from_state_db(
        state_db_ctx: Option<StateDbHandle>,
        config: &impl RolloutConfigView,
        page_size: usize,
        cursor: Option<&Cursor>,
        s
```

**Purpose**: Lists archived threads from SQLite only, without filesystem repair. It is the archived analogue of `list_threads_from_state_db`.

**Data flow**: Forwards arguments into `list_threads_with_db_fallback` with `Archived` archive mode and `StateDbOnly` repair mode; returns the resulting page.

**Call relations**: Used where callers want archived rows exactly as represented in the state DB.

*Call graph*: called by 1 (list_rollout_threads); 1 external calls (list_threads_with_db_fallback).


##### `RolloutRecorder::list_threads_with_db_fallback`  (lines 344–583)

```
async fn list_threads_with_db_fallback(
        state_db_ctx: Option<StateDbHandle>,
        config: &impl RolloutConfigView,
        page_size: usize,
        cursor: Option<&Cursor>,
        sort_ke
```

**Purpose**: Implements the full listing strategy that chooses between filesystem scans, SQLite pages, metadata overlay, and reconciliation. It is the central dispatcher for all thread-list variants.

**Data flow**: Reads `codex_home` from config, derives the archived flag, short-circuits empty cwd-filter slices, optionally performs DB-only listing, otherwise scans the filesystem ascending or descending, returns filesystem results directly when no DB exists, warms/repairs the DB for filesystem hits, queries SQLite, optionally fully reconciles search hits or DB-only metadata-filter hits, overlays missing metadata from state DB onto filesystem items, records fallback telemetry, and returns either a DB-backed or filesystem-backed `ThreadsPage`.

**Call relations**: All four public list methods funnel through this function. It delegates scanning to `list_threads_from_files_asc`/`desc`, DB access to `state_db::list_threads_db`, lightweight repair to `read_repair_rollout_path`, full repair to `reconcile_rollout`, and metadata enrichment to `fill_missing_thread_item_metadata_from_state_db`.

*Call graph*: calls 7 internal fn (fill_missing_thread_item_metadata_from_state_db, list_threads_from_files_asc, list_threads_from_files_desc, page_from_filesystem_scan, list_threads_db, read_repair_rollout_path, reconcile_rollout); 7 external calls (is_empty, record_fallback, matches!, codex_home, default, error!, warn!).


##### `RolloutRecorder::find_latest_thread_path`  (lines 587–664)

```
async fn find_latest_thread_path(
        state_db_ctx: Option<StateDbHandle>,
        config: &impl RolloutConfigView,
        page_size: usize,
        cursor: Option<&Cursor>,
        sort_key: Thr
```

**Purpose**: Finds the newest resumable rollout path, optionally constrained to a matching cwd. It prefers state DB pages when available but falls back to filesystem scans when necessary.

**Data flow**: Reads `codex_home`, wraps `filter_cwd` into an optional single-element cwd filter, iterates descending DB pages via `state_db::list_threads_db` when possible, selecting a path with `select_resume_path_from_db_page`; on DB failure or exhaustion records fallback telemetry and then iterates filesystem pages from `get_threads`, selecting with `select_resume_path`; returns `Ok(Some(path))` or `Ok(None)`.

**Call relations**: Used by resume flows to locate the best candidate session. It delegates cwd-sensitive candidate validation to `select_resume_path` and `select_resume_path_from_db_page`.

*Call graph*: calls 4 internal fn (get_threads, select_resume_path, select_resume_path_from_db_page, list_threads_db); 2 external calls (record_fallback, codex_home).


##### `RolloutRecorder::new`  (lines 672–784)

```
async fn new(
        config: &impl RolloutConfigView,
        params: RolloutRecorderParams,
    ) -> std::io::Result<Self>
```

**Purpose**: Creates a recorder for either a new deferred rollout or an existing resumed rollout, then spawns the background writer task. It prepares initial session metadata and the writer communication channel.

**Data flow**: Matches on `RolloutRecorderParams`: for `Create`, computes a dated rollout path with `precompute_log_file_info`, formats a session timestamp, builds a `SessionMeta` from config and parameters, and leaves file creation deferred; for `Resume`, materializes compressed paths and opens the file in append mode immediately. It then clones cwd, creates an `mpsc` channel, allocates `RolloutWriterTask`, spawns `rollout_writer`, stores the handle, and returns `RolloutRecorder { tx, writer_task, rollout_path }`.

**Call relations**: This is the constructor used by create/resume session flows. It delegates path generation to `precompute_log_file_info`, resume materialization to compression helpers, and all actual writing to the spawned `rollout_writer` task.

*Call graph*: calls 5 internal fn (originator, materialize_rollout_for_append, new, precompute_log_file_info, rollout_writer); called by 6 (find_locates_rollout_file_written_by_recorder, resume_materializes_compressed_rollout_path, persist_reports_filesystem_error_and_retries_buffered_items, recorder_materializes_on_flush_with_pending_items, create_thread, resume_thread); 10 external calls (clone, new, env!, error!, format_description!, cwd, generate_memories, model_provider_id, new, spawn).


##### `RolloutRecorder::rollout_path`  (lines 786–788)

```
fn rollout_path(&self) -> &Path
```

**Purpose**: Returns the recorder’s canonical rollout path. It exposes the path chosen at creation or resume time without materializing or touching the file.

**Data flow**: Borrows `self.rollout_path`, converts it to `&Path`, and returns that reference.

**Call relations**: Used by callers and tests that need to inspect where the recorder will write.

*Call graph*: 1 external calls (as_path).


##### `RolloutRecorder::record_canonical_items`  (lines 790–802)

```
async fn record_canonical_items(&self, items: &[RolloutItem]) -> std::io::Result<()>
```

**Purpose**: Queues already-filtered rollout items for asynchronous writing. It is a non-blocking enqueue operation unless the bounded channel is full.

**Data flow**: Accepts a slice of `RolloutItem`; returns immediately on empty input; otherwise clones the slice into a `Vec`, sends `RolloutCmd::AddItems` over the channel, and maps send failures to either the stored terminal writer error or a generic queueing error.

**Call relations**: Called by live session code after persistence policy has already selected canonical items. The background `rollout_writer` later consumes the queued `AddItems` command.

*Call graph*: 4 external calls (send, is_empty, to_vec, AddItems).


##### `RolloutRecorder::persist`  (lines 808–823)

```
async fn persist(&self) -> std::io::Result<()>
```

**Purpose**: Forces rollout materialization and persistence of all buffered items, retrying through the writer state if needed. It is idempotent once the file exists and the buffer is empty.

**Data flow**: Creates a oneshot channel, sends `RolloutCmd::Persist { ack }`, waits for the ack result, and maps channel/await failures to the terminal writer error when available; returns `std::io::Result<()>`.

**Call relations**: Used by callers that want an explicit durability barrier. The actual work is performed inside `RolloutWriterState::persist` in the background task.

*Call graph*: 2 external calls (send, channel).


##### `RolloutRecorder::flush`  (lines 829–844)

```
async fn flush(&self) -> std::io::Result<()>
```

**Purpose**: Waits until all queued writes have been processed and flushed by the writer task. It is the stronger synchronization point for callers that need ordering guarantees.

**Data flow**: Creates a oneshot channel, sends `RolloutCmd::Flush { ack }`, awaits the response, and returns the writer’s `std::io::Result<()>`, preferring any stored terminal failure on messaging errors.

**Call relations**: Called by code and tests that need to ensure buffered items are committed. It maps directly to `RolloutWriterState::flush` in the background task.

*Call graph*: 2 external calls (send, channel).


##### `RolloutRecorder::load_rollout_items`  (lines 846–903)

```
async fn load_rollout_items(
        path: &Path,
    ) -> std::io::Result<(Vec<RolloutItem>, Option<ThreadId>, usize)>
```

**Purpose**: Reads a rollout JSONL file into `RolloutItem`s while tolerating malformed lines and filtering legacy ghost-snapshot artifacts. It also extracts the first session thread ID and counts parse errors.

**Data flow**: Opens a line reader through `compression::open_rollout_line_reader`, skips blank lines, parses each line as `serde_json::Value`, drops legacy ghost-snapshot response items or prunes them from compacted history via `strip_legacy_ghost_snapshot_rollout_line`, attempts to deserialize `RolloutLine`, records the first `SessionMeta.meta.id` as `thread_id`, pushes surviving items, increments `parse_errors` on JSON/line parse failures, errors if the file had no non-empty lines, and returns `(Vec<RolloutItem>, Option<ThreadId>, usize)`.

**Call relations**: This is the canonical rollout loader used by metadata extraction, history replay, resume-cwd matching, and many tests. It delegates legacy cleanup to `strip_legacy_ghost_snapshot_rollout_line`.

*Call graph*: calls 2 internal fn (open_rollout_line_reader, strip_legacy_ghost_snapshot_rollout_line); called by 13 (thread_id_from_rollout, sample, append_rollout_item_materializes_compressed_rollout, load_rollout_items_reads_compressed_rollout, resume_materializes_compressed_rollout_path, worker_skips_existing_compressed_archived_rollouts, extract_metadata_from_rollout, resume_candidate_matches_cwd, load_rollout_items_filters_legacy_ghost_snapshots_from_compaction_history, load_rollout_items_preserves_legacy_guardian_assessment_lines (+3 more)); 6 external calls (new, other, from_str, trace!, debug!, warn!).


##### `RolloutRecorder::get_rollout_history`  (lines 905–920)

```
async fn get_rollout_history(path: &Path) -> std::io::Result<InitialHistory>
```

**Purpose**: Converts a rollout file into `InitialHistory`, either `New` for empty item lists or `Resumed` with conversation ID and history. It is the replay-oriented wrapper around `load_rollout_items`.

**Data flow**: Loads items and optional thread ID from disk; errors if no thread ID can be parsed; returns `InitialHistory::New` when the item list is empty, otherwise returns `InitialHistory::Resumed` containing the conversation ID, full history, and plain rollout path.

**Call relations**: Used by thread resume/replay codepaths that need protocol-level history rather than raw items plus parse-error counts.

*Call graph*: called by 10 (thread_inject_items_adds_raw_response_items_to_thread_history, record_context_updates_and_set_reference_context_item_persists_baseline_without_emitting_diffs, record_context_updates_and_set_reference_context_item_persists_full_reinjection_to_rollout, record_context_updates_and_set_reference_context_item_persists_split_file_system_policy_to_rollout, thread_rollback_drops_last_turn_from_history, thread_rollback_persists_marker_and_replays_cumulatively, interrupted_fork_snapshot_does_not_synthesize_turn_id_for_legacy_history, interrupted_fork_snapshot_preserves_explicit_turn_id, interrupted_fork_snapshot_uses_persisted_mid_turn_history_without_live_source, resume_materializes_compressed_rollout_path); 4 external calls (load_rollout_items, plain_rollout_path, info!, Resumed).


##### `RolloutRecorder::shutdown`  (lines 925–947)

```
async fn shutdown(&self) -> std::io::Result<()>
```

**Purpose**: Requests the writer task to drain pending items and stop. If draining fails, it returns the error and leaves the writer alive for future retries.

**Data flow**: Creates a oneshot channel, sends `RolloutCmd::Shutdown { ack }`, awaits the ack, and maps send/wait failures to either the stored terminal writer error or a generic shutdown error; returns `std::io::Result<()>`.

**Call relations**: Called during session teardown. The background task only exits after `RolloutWriterState::shutdown` succeeds.

*Call graph*: 5 external calls (send, other, format!, channel, warn!).


##### `strip_legacy_ghost_snapshot_rollout_line`  (lines 950–967)

```
fn strip_legacy_ghost_snapshot_rollout_line(value: &mut Value) -> bool
```

**Purpose**: Removes obsolete `ghost_snapshot` response items from legacy rollout data before typed deserialization. It can either drop an entire response-item line or prune entries from compacted replacement history.

**Data flow**: Mutably inspects a JSON `Value`; if it is a `response_item` whose payload matches `is_legacy_ghost_snapshot_response_item`, returns `true` to signal the whole line should be skipped; if it is a `compacted` payload with `replacement_history`, removes ghost-snapshot entries in place and returns `false`; otherwise returns `false` unchanged.

**Call relations**: Called by `RolloutRecorder::load_rollout_items` on each parsed JSON value before deserializing into `RolloutLine`.

*Call graph*: called by 1 (load_rollout_items); 2 external calls (get, get_mut).


##### `is_legacy_ghost_snapshot_response_item`  (lines 969–971)

```
fn is_legacy_ghost_snapshot_response_item(value: &Value) -> bool
```

**Purpose**: Recognizes the legacy response-item payload shape for `ghost_snapshot`. It is a tiny predicate over raw JSON values.

**Data flow**: Reads the `type` field from a `serde_json::Value` and returns `true` only when it equals `"ghost_snapshot"`.

**Call relations**: Used exclusively by `strip_legacy_ghost_snapshot_rollout_line`.

*Call graph*: 1 external calls (get).


##### `truncate_fs_page`  (lines 973–992)

```
fn truncate_fs_page(
    mut page: ThreadsPage,
    page_size: usize,
    sort_key: ThreadSortKey,
) -> ThreadsPage
```

**Purpose**: Truncates an overfetched filesystem page to the requested size and computes the next cursor from the last retained item. It is used to make descending filesystem scans paginate correctly.

**Data flow**: Takes a mutable `ThreadsPage`, requested `page_size`, and `ThreadSortKey`; if the page is already small enough returns it unchanged, otherwise truncates `items`, derives a cursor token from the last item’s filename timestamp or `updated_at`, parses that token into a `Cursor`, stores it as `next_cursor`, and returns the page.

**Call relations**: Called by `page_from_filesystem_scan` when descending scans intentionally overfetch.

*Call graph*: called by 1 (page_from_filesystem_scan).


##### `page_from_filesystem_scan`  (lines 994–1004)

```
fn page_from_filesystem_scan(
    page: ThreadsPage,
    sort_direction: SortDirection,
    page_size: usize,
    sort_key: ThreadSortKey,
) -> ThreadsPage
```

**Purpose**: Normalizes a filesystem scan result into the page shape expected by callers, truncating only for descending order. Ascending scans already produce the final page directly.

**Data flow**: Accepts a `ThreadsPage`, sort direction, page size, and sort key; returns the page unchanged for ascending order or passes it to `truncate_fs_page` for descending order.

**Call relations**: Used by `list_threads_with_db_fallback` whenever it returns filesystem-backed results.

*Call graph*: calls 1 internal fn (truncate_fs_page); called by 1 (list_threads_with_db_fallback).


##### `fill_missing_thread_item_metadata_from_state_db`  (lines 1006–1032)

```
async fn fill_missing_thread_item_metadata_from_state_db(
    state_db_ctx: Option<&StateRuntime>,
    mut page: ThreadsPage,
) -> ThreadsPage
```

**Purpose**: Overlays missing metadata fields on filesystem-derived `ThreadItem`s using authoritative state-DB rows. It enriches fallback pages without replacing filesystem identity.

**Data flow**: If no `StateRuntime` is provided, returns the page unchanged; otherwise iterates mutable page items, skips entries without `thread_id`, fetches metadata with `get_thread`, converts successful rows via `thread_item_from_state_metadata`, and merges them into each item with `fill_missing_thread_item_metadata`; returns the updated page.

**Call relations**: Called by `list_threads_with_db_fallback` when filesystem results are returned for metadata-filtered listings or DB-error fallbacks.

*Call graph*: calls 2 internal fn (fill_missing_thread_item_metadata, thread_item_from_state_metadata); called by 1 (list_threads_with_db_fallback); 1 external calls (warn!).


##### `fill_missing_thread_item_metadata`  (lines 1034–1096)

```
fn fill_missing_thread_item_metadata(item: &mut ThreadItem, state_item: ThreadItem)
```

**Purpose**: Merges a state-derived `ThreadItem` into a filesystem-derived one while preserving filesystem path/thread identity and preferring state git fields. It fills only absent fields except for git metadata, which state values overwrite when present.

**Data flow**: Consumes `&mut ThreadItem` plus a second `ThreadItem`; destructures the state item, ignores its path and thread ID, copies first-user-message/preview/cwd/source/agent/provider/version/timestamps only when the filesystem item lacks them, and unconditionally replaces git branch/SHA/origin when the state item has values.

**Call relations**: Used by `fill_missing_thread_item_metadata_from_state_db` as the field-level merge primitive.

*Call graph*: called by 1 (fill_missing_thread_item_metadata_from_state_db).


##### `list_threads_from_files_desc`  (lines 1099–1173)

```
async fn list_threads_from_files_desc(
    codex_home: &Path,
    page_size: usize,
    cursor: Option<&Cursor>,
    sort_key: ThreadSortKey,
    allowed_sources: &[SessionSource],
    model_providers
```

**Purpose**: Performs descending filesystem thread listing, with optional title search that may scan multiple pages to accumulate enough matches. It is the descending-order file-backed listing engine.

**Data flow**: If `search_term` is present, repeatedly calls `list_threads_from_files_desc_unfiltered` with an expanded scan page size, accumulates scanned-file counts and items, filters each page by title via `filter_thread_items_by_search_term`, truncates matches to `page_size`, and computes `next_cursor` from the last retained item when more matches may exist; without search, simply delegates to the unfiltered helper.

**Call relations**: Called by `list_threads_with_db_fallback` for descending scans and by `list_threads_from_files_asc` as its underlying source of all items.

*Call graph*: calls 2 internal fn (filter_thread_items_by_search_term, list_threads_from_files_desc_unfiltered); called by 2 (list_threads_with_db_fallback, list_threads_from_files_asc); 1 external calls (new).


##### `list_threads_from_files_desc_unfiltered`  (lines 1176–1216)

```
async fn list_threads_from_files_desc_unfiltered(
    codex_home: &Path,
    page_size: usize,
    cursor: Option<&Cursor>,
    sort_key: ThreadSortKey,
    allowed_sources: &[SessionSource],
    mode
```

**Purpose**: Lists rollout files from the filesystem in descending order without title-search post-filtering. It chooses between active and archived roots.

**Data flow**: If `archived` is true, joins `codex_home` with `ARCHIVED_SESSIONS_SUBDIR` and calls `get_threads_in_root` with a flat layout config; otherwise calls `get_threads` on `codex_home`; returns the resulting `ThreadsPage`.

**Call relations**: Used by `list_threads_from_files_desc` as the raw filesystem listing primitive.

*Call graph*: calls 2 internal fn (get_threads, get_threads_in_root); called by 1 (list_threads_from_files_desc); 1 external calls (join).


##### `list_threads_from_files_asc`  (lines 1219–1293)

```
async fn list_threads_from_files_asc(
    codex_home: &Path,
    page_size: usize,
    cursor: Option<&Cursor>,
    sort_key: ThreadSortKey,
    allowed_sources: &[SessionSource],
    model_providers:
```

**Purpose**: Builds ascending filesystem listings by scanning descending pages, collecting all items, sorting them ascending, and then applying cursor/page truncation. This avoids needing a separate ascending filesystem walker.

**Data flow**: Repeatedly calls `list_threads_from_files_desc` with no search term and an expanded scan size until exhaustion, accumulates items and scan stats, optionally filters by title search, computes sortable keys with `thread_item_sort_key`, sorts ascending, applies the caller cursor by retaining items with keys after the anchor, truncates to `page_size`, computes `next_cursor` from the last retained item when more matches remain, and returns a `ThreadsPage`.

**Call relations**: Called by `list_threads_with_db_fallback` for ascending listings. It reuses descending scans and local sorting rather than duplicating traversal logic.

*Call graph*: calls 2 internal fn (filter_thread_items_by_search_term, list_threads_from_files_desc); called by 1 (list_threads_with_db_fallback); 1 external calls (new).


##### `filter_thread_items_by_search_term`  (lines 1295–1318)

```
async fn filter_thread_items_by_search_term(
    codex_home: &Path,
    items: &mut Vec<ThreadItem>,
    search_term: Option<&str>,
) -> std::io::Result<()>
```

**Purpose**: Filters thread items by title substring using the sidecar session index rather than rollout contents. This keeps filesystem fallback search behavior aligned with SQLite title filtering.

**Data flow**: If `search_term` is absent, returns immediately; otherwise collects thread IDs from the items into a `HashSet`, loads names with `find_thread_names_by_ids`, and retains only items whose thread ID maps to a title containing the search term.

**Call relations**: Used by both ascending and descending filesystem listing helpers when a title search is requested.

*Call graph*: calls 1 internal fn (find_thread_names_by_ids); called by 2 (list_threads_from_files_asc, list_threads_from_files_desc).


##### `thread_item_sort_key`  (lines 1320–1334)

```
fn thread_item_sort_key(
    item: &ThreadItem,
    sort_key: ThreadSortKey,
) -> Option<(OffsetDateTime, uuid::Uuid)>
```

**Purpose**: Computes the sortable `(timestamp, uuid)` key for a `ThreadItem` based on either filename creation time or metadata update time. It underpins cursor generation and ascending sorting.

**Data flow**: Reads the rollout filename from `item.path`, parses `(created_at, id)` with `parse_timestamp_uuid_from_filename`, chooses `created_at` or parses `item.updated_at`/`created_at` as RFC3339 depending on `ThreadSortKey`, and returns `Option<(OffsetDateTime, uuid::Uuid)>`.

**Call relations**: Called by `cursor_from_thread_item` and by `list_threads_from_files_asc` when sorting and applying cursors.

*Call graph*: calls 1 internal fn (parse_timestamp_uuid_from_filename); called by 1 (cursor_from_thread_item); 1 external calls (parse).


##### `cursor_from_thread_item`  (lines 1336–1340)

```
fn cursor_from_thread_item(item: &ThreadItem, sort_key: ThreadSortKey) -> Option<Cursor>
```

**Purpose**: Builds a pagination cursor from a thread item’s sort key. It serializes the timestamp portion into the cursor token format expected by listing APIs.

**Data flow**: Calls `thread_item_sort_key`, formats the timestamp as RFC3339, parses that string with `parse_cursor`, and returns `Option<Cursor>`.

**Call relations**: Used by filesystem listing helpers to produce `next_cursor` values after truncation.

*Call graph*: calls 2 internal fn (parse_cursor, thread_item_sort_key).


##### `precompute_log_file_info`  (lines 1353–1383)

```
fn precompute_log_file_info(
    config: &impl RolloutConfigView,
    conversation_id: ThreadId,
) -> std::io::Result<LogFileInfo>
```

**Purpose**: Chooses the dated rollout path and start timestamp for a newly created session. It embeds the conversation ID into the filename and nests files under year/month/day directories.

**Data flow**: Reads local time with `OffsetDateTime::now_local`, builds `codex_home/sessions/YYYY/MM/DD`, formats a filename-safe timestamp `YYYY-MM-DDThh-mm-ss`, constructs `rollout-{date_str}-{conversation_id}.jsonl`, joins it into a full path, and returns `LogFileInfo { path, conversation_id, timestamp }`.

**Call relations**: Called by `RolloutRecorder::new` for `Create` mode before the writer task is spawned.

*Call graph*: called by 1 (new); 4 external calls (now_local, format!, format_description!, codex_home).


##### `open_log_file`  (lines 1385–1398)

```
fn open_log_file(path: &Path) -> std::io::Result<File>
```

**Purpose**: Materializes a rollout path for append, ensures its parent directory exists, and opens it in append/create mode using blocking std I/O. It is the low-level file opener used by the writer state.

**Data flow**: Materializes compressed/plain path variants via `compression::materialize_rollout_for_append_blocking`, checks for a parent directory, creates that directory tree, opens the file with append/create options, and returns `std::fs::File` or an `IoError`.

**Call relations**: Called by `RolloutWriterState::ensure_writer_open` whenever deferred or recovered writing needs a fresh file handle.

*Call graph*: calls 1 internal fn (materialize_rollout_for_append_blocking); called by 1 (ensure_writer_open); 5 external calls (parent, other, format!, create_dir_all, new).


##### `RolloutWriterState::new`  (lines 1416–1432)

```
fn new(
        file: Option<tokio::fs::File>,
        deferred_log_file_info: Option<LogFileInfo>,
        meta: Option<SessionMeta>,
        cwd: PathBuf,
        rollout_path: PathBuf,
    ) -> Sel
```

**Purpose**: Constructs the mutable state owned by the background writer loop. It captures the optional open writer, deferred path info, pending queue, session metadata, cwd, and error-suppression state.

**Data flow**: Wraps an optional `tokio::fs::File` into `JsonlWriter`, stores deferred log info, initializes `pending_items` empty, stores optional `SessionMeta`, cwd, rollout path, and `last_logged_error: None`; returns the new state struct.

**Call relations**: Created by `rollout_writer` at task startup and directly by a retry-focused test.

*Call graph*: called by 2 (rollout_writer, writer_state_retries_write_error_before_reporting_flush_success); 1 external calls (new).


##### `RolloutWriterState::add_items`  (lines 1434–1436)

```
fn add_items(&mut self, items: Vec<RolloutItem>)
```

**Purpose**: Appends newly queued rollout items to the in-memory pending buffer. It does not write immediately by itself.

**Data flow**: Consumes a `Vec<RolloutItem>` and extends `self.pending_items` with it; returns no value.

**Call relations**: Called by `rollout_writer` when it receives `RolloutCmd::AddItems`.


##### `RolloutWriterState::flush_if_materialized`  (lines 1438–1445)

```
async fn flush_if_materialized(&mut self)
```

**Purpose**: Attempts an immediate flush after new items arrive, but only when the rollout file has already been materialized. Deferred sessions keep buffering until an explicit barrier.

**Data flow**: Checks `is_deferred`; if true returns immediately; otherwise calls `flush().await` and, on error, switches to recovery mode with `enter_recovery_mode`.

**Call relations**: Used by `rollout_writer` after `AddItems` commands so active materialized sessions write eagerly while deferred sessions remain lazy.

*Call graph*: calls 3 internal fn (enter_recovery_mode, flush, is_deferred).


##### `RolloutWriterState::persist`  (lines 1447–1449)

```
async fn persist(&mut self) -> std::io::Result<()>
```

**Purpose**: Persists all pending data, materializing the file if necessary, with one retry after reopening on failure. It is the state-level implementation behind recorder `persist()`.

**Data flow**: Calls `write_pending_with_recovery("persist")` and returns its `std::io::Result<()>`.

**Call relations**: Invoked by `rollout_writer` when handling `RolloutCmd::Persist`.

*Call graph*: calls 1 internal fn (write_pending_with_recovery).


##### `RolloutWriterState::flush`  (lines 1451–1456)

```
async fn flush(&mut self) -> std::io::Result<()>
```

**Purpose**: Flushes all pending data, unless the recorder is still deferred and has nothing buffered. It is the state-level implementation behind recorder `flush()`.

**Data flow**: If deferred with an empty pending queue, returns `Ok(())`; otherwise calls `write_pending_with_recovery("flush")` and returns the result.

**Call relations**: Called by `flush_if_materialized` and by `rollout_writer` for explicit `Flush` commands.

*Call graph*: calls 2 internal fn (is_deferred, write_pending_with_recovery); called by 1 (flush_if_materialized).


##### `RolloutWriterState::shutdown`  (lines 1458–1463)

```
async fn shutdown(&mut self) -> std::io::Result<()>
```

**Purpose**: Drains pending data before shutdown, unless there is nothing to materialize or write. It is the state-level implementation behind recorder `shutdown()`.

**Data flow**: If deferred with no pending items, returns `Ok(())`; otherwise delegates to `write_pending_with_recovery("shutdown")`.

**Call relations**: Called by `rollout_writer` when processing `Shutdown`; success allows the task loop to break.

*Call graph*: calls 2 internal fn (is_deferred, write_pending_with_recovery).


##### `RolloutWriterState::write_pending_with_recovery`  (lines 1465–1490)

```
async fn write_pending_with_recovery(&mut self, operation: &str) -> std::io::Result<()>
```

**Purpose**: Runs one write attempt, enters recovery mode on failure, reopens and retries once, and reports the final result. It centralizes the writer’s retry policy.

**Data flow**: Calls `write_pending_once`; on success clears `last_logged_error`; on first failure logs/recovery via `enter_recovery_mode`, warns, retries `write_pending_once`, clears `last_logged_error` on retry success, or logs/warns and returns the second error on retry failure.

**Call relations**: Used by `persist`, `flush`, and `shutdown` so all barrier operations share the same reopen-and-retry semantics.

*Call graph*: calls 2 internal fn (enter_recovery_mode, write_pending_once); called by 3 (flush, persist, shutdown); 1 external calls (warn!).


##### `RolloutWriterState::is_deferred`  (lines 1492–1494)

```
fn is_deferred(&self) -> bool
```

**Purpose**: Reports whether the recorder has not yet materialized its rollout file but still has deferred path information. This distinguishes lazy new sessions from active writers.

**Data flow**: Returns `true` when `self.writer.is_none()` and `self.deferred_log_file_info.is_some()`, otherwise `false`.

**Call relations**: Consulted by `flush_if_materialized`, `flush`, and `shutdown` to decide whether writing should happen yet.

*Call graph*: called by 3 (flush, flush_if_materialized, shutdown).


##### `RolloutWriterState::enter_recovery_mode`  (lines 1496–1509)

```
fn enter_recovery_mode(&mut self, err: &IoError)
```

**Purpose**: Drops the current writer handle after an I/O failure and logs the error once per distinct message. This preserves buffered items for later retry.

**Data flow**: Converts the error to a string, compares it with `last_logged_error`, emits an error log if it is new, stores the message in `last_logged_error`, and sets `self.writer = None`.

**Call relations**: Called after failed flush/write attempts by `flush_if_materialized` and `write_pending_with_recovery`.

*Call graph*: called by 2 (flush_if_materialized, write_pending_with_recovery); 2 external calls (to_string, error!).


##### `RolloutWriterState::ensure_writer_open`  (lines 1511–1527)

```
async fn ensure_writer_open(&mut self) -> std::io::Result<()>
```

**Purpose**: Opens or reopens the rollout file if no writer is currently available. It also clears deferred path info once the file is materialized.

**Data flow**: If `self.writer` already exists, returns `Ok(())`; otherwise chooses the path from deferred log info or `rollout_path`, opens it with `open_log_file`, wraps it in `tokio::fs::File` and `JsonlWriter`, stores it in `self.writer`, clears `deferred_log_file_info`, and returns success.

**Call relations**: Called by `write_pending_once` before any metadata or item writes.

*Call graph*: calls 1 internal fn (open_log_file); called by 1 (write_pending_once); 2 external calls (as_path, from_std).


##### `RolloutWriterState::write_session_meta_if_needed`  (lines 1529–1536)

```
async fn write_session_meta_if_needed(&mut self) -> std::io::Result<()>
```

**Purpose**: Writes the initial `SessionMeta` line exactly once, after the writer is open and before pending items are flushed. It also enriches the metadata with git info from the session cwd.

**Data flow**: Clones `self.meta` if present, calls `write_session_meta(self.writer.as_mut(), session_meta, &self.cwd).await`, and on success sets `self.meta = None`; otherwise leaves state unchanged via propagated error.

**Call relations**: Called by `write_pending_once` so the session header precedes all later rollout items.

*Call graph*: calls 1 internal fn (write_session_meta); called by 1 (write_pending_once).


##### `RolloutWriterState::write_pending_once`  (lines 1538–1548)

```
async fn write_pending_once(&mut self) -> std::io::Result<()>
```

**Purpose**: Performs one full write pass: ensure file open, write session metadata if needed, write pending items, and flush the file handle. It does not retry internally.

**Data flow**: Calls `ensure_writer_open`, `write_session_meta_if_needed`, and `write_pending_items_once`; then flushes the underlying file if a writer exists; returns `std::io::Result<()>`.

**Call relations**: Used only by `write_pending_with_recovery`, which wraps it with reopen-and-retry behavior.

*Call graph*: calls 3 internal fn (ensure_writer_open, write_pending_items_once, write_session_meta_if_needed); called by 1 (write_pending_with_recovery).


##### `RolloutWriterState::write_pending_items_once`  (lines 1550–1570)

```
async fn write_pending_items_once(&mut self) -> std::io::Result<()>
```

**Purpose**: Writes as many pending rollout items as possible in order, draining only the successfully written prefix. This preserves unwritten suffix items for retry after partial failure.

**Data flow**: Requires `self.writer` to exist or returns an error; iterates `self.pending_items`, calling `writer.write_rollout_item(item)` until one fails; counts successful writes, drains that prefix from `pending_items`, and returns either `Ok(())` or the first encountered write error.

**Call relations**: Called by `write_pending_once` as the item-level write loop.

*Call graph*: called by 1 (write_pending_once); 1 external calls (other).


##### `rollout_writer`  (lines 1573–1609)

```
async fn rollout_writer(
    file: Option<tokio::fs::File>,
    deferred_log_file_info: Option<LogFileInfo>,
    mut rx: mpsc::Receiver<RolloutCmd>,
    meta: Option<SessionMeta>,
    cwd: PathBuf,
```

**Purpose**: Runs the background command loop that owns all mutable writer state. It serializes item buffering, persistence barriers, and shutdown handling on a single task.

**Data flow**: Constructs `RolloutWriterState`, then repeatedly awaits `rx.recv()`; on `AddItems` appends items and opportunistically flushes if materialized, on `Persist`/`Flush` sends back the corresponding state method result, and on successful `Shutdown` acknowledges and breaks the loop; returns `Ok(())` when the channel closes or shutdown succeeds.

**Call relations**: Spawned by `RolloutRecorder::new` and driven by commands from recorder API methods.

*Call graph*: calls 2 internal fn (recv, new); called by 1 (new).


##### `write_session_meta`  (lines 1611–1635)

```
async fn write_session_meta(
    mut writer: Option<&mut JsonlWriter>,
    session_meta: SessionMeta,
    cwd: &Path,
) -> std::io::Result<()>
```

**Purpose**: Builds and writes the initial `RolloutItem::SessionMeta` line, optionally augmenting it with git repository information from the session cwd. It is the one-time header writer for new sessions.

**Data flow**: Checks whether `cwd` is inside a git repo via `get_git_repo_root`; if so, asynchronously collects git info and maps it into protocol `GitInfo`; constructs `SessionMetaLine { meta: session_meta, git }`, wraps it in `RolloutItem::SessionMeta`, and writes it through the provided `JsonlWriter` if present.

**Call relations**: Called by `RolloutWriterState::write_session_meta_if_needed` before any pending items are written.

*Call graph*: called by 1 (write_session_meta_if_needed); 3 external calls (collect_git_info, get_git_repo_root, SessionMeta).


##### `append_rollout_item_to_path`  (lines 1642–1653)

```
async fn append_rollout_item_to_path(
    rollout_path: &Path,
    item: &RolloutItem,
) -> std::io::Result<()>
```

**Purpose**: Appends a single already-filtered rollout item directly to a rollout file outside the live recorder task. It is intended for metadata updates to unloaded threads.

**Data flow**: Materializes the target path for append, opens it in append mode with Tokio, wraps the file in `JsonlWriter`, writes the provided `RolloutItem`, and returns the write result.

**Call relations**: Used by external metadata-update flows that need ordered append semantics only for one item, not a full live recorder.

*Call graph*: calls 1 internal fn (materialize_rollout_for_append); 1 external calls (new).


##### `JsonlWriter::write_rollout_item`  (lines 1667–1680)

```
async fn write_rollout_item(&mut self, rollout_item: &RolloutItem) -> std::io::Result<()>
```

**Purpose**: Serializes one rollout item as a timestamped JSONL line using the current UTC time. It wraps the item in the on-disk `RolloutLineRef` shape.

**Data flow**: Formats `OffsetDateTime::now_utc()` into millisecond RFC3339-like text, constructs `RolloutLineRef { timestamp, item }`, and delegates actual serialization/write to `write_line`.

**Call relations**: Called by writer-state item loops, session-meta writing, and direct append helpers.

*Call graph*: calls 1 internal fn (write_line); 2 external calls (now_utc, format_description!).


##### `JsonlWriter::write_line`  (lines 1681–1687)

```
async fn write_line(&mut self, item: &impl serde::Serialize) -> std::io::Result<()>
```

**Purpose**: Serializes an arbitrary value to JSON, appends a newline, writes it to the file, and flushes immediately. It is the lowest-level JSONL output primitive in this module.

**Data flow**: Takes any `serde::Serialize` value, converts it to a JSON string, appends `\n`, writes bytes with `write_all`, flushes the file, and returns `std::io::Result<()>`.

**Call relations**: Used only by `JsonlWriter::write_rollout_item`.

*Call graph*: called by 1 (write_rollout_item); 3 external calls (flush, write_all, to_string).


##### `ThreadsPage::from`  (lines 1691–1703)

```
fn from(db_page: codex_state::ThreadsPage) -> Self
```

**Purpose**: Converts a `codex_state::ThreadsPage` from SQLite into the rollout module’s filesystem-style `ThreadsPage`. It adapts item shape and pagination fields.

**Data flow**: Consumes a DB page, maps each `codex_state::ThreadMetadata` through `thread_item_from_state_metadata`, converts `next_anchor` into `next_cursor`, copies `num_scanned_rows` into `num_scanned_files`, sets `reached_scan_cap` false, and returns the new page.

**Call relations**: Used implicitly by listing code whenever a DB page is returned to rollout callers.


##### `thread_item_from_state_metadata`  (lines 1706–1729)

```
fn thread_item_from_state_metadata(item: codex_state::ThreadMetadata) -> ThreadItem
```

**Purpose**: Transforms a state-DB thread metadata row into a `ThreadItem` suitable for listing APIs. It also parses the serialized source field back into `SessionSource`.

**Data flow**: Consumes `codex_state::ThreadMetadata`; copies rollout path, IDs, preview/message/git/provider/version fields, wraps cwd/source/created/updated timestamps into the `ThreadItem` shape, parses `item.source` from JSON string or plain string with fallback to `SessionSource::Unknown`, and returns the populated `ThreadItem`.

**Call relations**: Used by `ThreadsPage::from` and `fill_missing_thread_item_metadata_from_state_db`.

*Call graph*: called by 1 (fill_missing_thread_item_metadata_from_state_db); 1 external calls (from_str).


##### `select_resume_path`  (lines 1731–1754)

```
async fn select_resume_path(
    page: &ThreadsPage,
    filter_cwd: Option<&Path>,
    default_provider: &str,
) -> Option<PathBuf>
```

**Purpose**: Chooses the first resumable rollout path from a filesystem `ThreadsPage`, optionally requiring cwd compatibility. Without a cwd filter it simply picks the first item.

**Data flow**: If `filter_cwd` is `Some`, iterates page items and asynchronously tests each with `resume_candidate_matches_cwd`, returning the first matching path clone; otherwise returns the first item’s path clone if present.

**Call relations**: Called by `RolloutRecorder::find_latest_thread_path` when scanning filesystem pages.

*Call graph*: calls 1 internal fn (resume_candidate_matches_cwd); called by 1 (find_latest_thread_path).


##### `resume_candidate_matches_cwd`  (lines 1756–1782)

```
async fn resume_candidate_matches_cwd(
    rollout_path: &Path,
    cached_cwd: Option<&Path>,
    cwd: &Path,
    default_provider: &str,
) -> bool
```

**Purpose**: Determines whether a rollout belongs to a requested cwd, using progressively more expensive evidence. It first trusts cached cwd, then checks the latest `TurnContext`, then falls back to full metadata extraction.

**Data flow**: Accepts rollout path, optional cached cwd, target cwd, and default provider; returns true immediately if cached cwd matches via `cwd_matches`; otherwise loads rollout items and scans backward for the latest `RolloutItem::TurnContext.cwd`, comparing that to the target; if still unresolved, calls `metadata::extract_metadata_from_rollout` and compares `outcome.metadata.cwd`; returns a boolean.

**Call relations**: Used by both `select_resume_path` and `select_resume_path_from_db_page` to validate resume candidates under cwd filtering.

*Call graph*: calls 3 internal fn (extract_metadata_from_rollout, load_rollout_items, cwd_matches); called by 2 (select_resume_path, select_resume_path_from_db_page).


##### `select_resume_path_from_db_page`  (lines 1784–1807)

```
async fn select_resume_path_from_db_page(
    page: &codex_state::ThreadsPage,
    filter_cwd: Option<&Path>,
    default_provider: &str,
) -> Option<PathBuf>
```

**Purpose**: Chooses the first resumable rollout path from a state-DB page, optionally requiring cwd compatibility. It mirrors `select_resume_path` but starts from DB rows.

**Data flow**: If `filter_cwd` is `Some`, iterates DB items and calls `resume_candidate_matches_cwd` with the row’s cached cwd and rollout path, returning the first matching path clone; otherwise returns the first row’s rollout path clone.

**Call relations**: Called by `RolloutRecorder::find_latest_thread_path` during the preferred DB-backed search path.

*Call graph*: calls 1 internal fn (resume_candidate_matches_cwd); called by 1 (find_latest_thread_path).


##### `cwd_matches`  (lines 1809–1811)

```
fn cwd_matches(session_cwd: &Path, cwd: &Path) -> bool
```

**Purpose**: Compares two paths after normalization using shared path utilities. It abstracts away platform/path-format differences for resume matching.

**Data flow**: Takes `session_cwd` and target `cwd`, forwards them to `path_utils::paths_match_after_normalization`, and returns the resulting boolean.

**Call relations**: Used only by `resume_candidate_matches_cwd`.

*Call graph*: called by 1 (resume_candidate_matches_cwd); 1 external calls (paths_match_after_normalization).


### Thread-store contract and test backend
These files establish the storage-neutral thread persistence API, its shared errors, and the in-memory implementation used for testing and debugging.

### `thread-store/src/error.rs`

`data_model` · `cross-cutting`

This file is the central error contract for the `thread-store` crate. It introduces `ThreadStoreResult<T>` as the crate-wide `Result` alias and `ThreadStoreError` as the enum every store implementation is expected to return. The enum is intentionally shaped around caller-meaningful failure modes rather than backend-specific details: `ThreadNotFound` carries the requested `codex_protocol::ThreadId`; `InvalidRequest` reports malformed or inconsistent input supplied by the caller; `Conflict` represents state-dependent failures such as duplicate creation or incompatible updates; `Unsupported` exposes a stable operation name for feature detection or graceful fallback; and `Internal` is the catch-all for implementation failures that do not fit the public categories. Each variant derives a user-facing message through `thiserror::Error`, so formatting is standardized across implementations. The design keeps backend internals out of the public API while still preserving enough structured data for higher layers to branch on not-found versus validation versus unsupported-operation cases. Because this file contains only types and no behavior, its main invariant is semantic consistency: all thread-store backends should map equivalent situations onto the same variant so application code can treat the trait uniformly.


### `thread-store/src/lib.rs`

`orchestration` · `startup`

This file is the API surface of the `thread-store` crate. Its module declarations organize the crate into backend implementations (`in_memory`, `local`), live-thread coordination (`live_thread`), synchronization helpers (`thread_metadata_sync`), the core trait (`store`), shared request/response types (`types`), and error definitions (`error`). The top-level documentation establishes the key abstraction boundary: application code should persist and exchange only `codex_protocol::ThreadId`, while each backend is responsible for resolving that durable identifier into local files, rollout paths, RPC calls, or other storage-specific details. The file then re-exports the crate’s public contract in a flat namespace. Consumers can construct stores such as `InMemoryThreadStore` or `LocalThreadStore`, invoke the `ThreadStore` trait, and pass strongly typed parameter structs like `CreateThreadParams`, `AppendThreadItemsParams`, `ListThreadsParams`, or `UpdateThreadMetadataParams`. It also exposes the stored-data models returned by implementations, including `StoredThread`, `StoredTurn`, paginated wrappers, search results, and metadata patch types. This crate root contains no executable logic; its importance is in curating a coherent, backend-agnostic API so downstream code depends on stable names rather than internal module layout.


### `thread-store/src/store.rs`

`domain_logic` · `cross-cutting`

This file is the abstraction boundary for thread persistence. Its main artifact is the `ThreadStore` trait, which is constrained as `Any + Send + Sync` so implementations can be shared across threads and, when necessary, downcast through `as_any()` for implementation-specific escape hatches. All operations are asynchronous and normalized through the `ThreadStoreFuture<'a, T>` alias, a boxed, pinned `Future` returning `ThreadStoreResult<T>`, which gives callers a uniform error and scheduling model regardless of backend.

The trait covers the full thread lifecycle: opening live writers (`create_thread`, `resume_thread`), ingesting rollout items (`append_items`), forcing durability (`persist_thread`, `flush_thread`), closing or abandoning live state (`shutdown_thread`, `discard_thread`), and reading persisted state (`load_history`, `read_thread`, `read_thread_by_rollout_path`). It also defines discovery and maintenance APIs such as `list_threads`, metadata patching, archive/unarchive, and deletion. The parameter and return types are all explicit crate-level domain structs like `CreateThreadParams`, `StoredThread`, `ThreadPage`, and `StoredThreadHistory`, keeping policy and schema outside the trait itself.

A notable design choice is that three capabilities—thread search, turn listing, and item listing—have default implementations that immediately return `ThreadStoreError::Unsupported` with operation-specific identifiers. That makes these features optional for backends while preserving a single trait surface. The comments also encode important invariants: append implementations must apply shared rollout persistence policy before durable writes and projections, `discard_thread` must release live writer resources without deleting already durable data, and metadata updates are literal patches rather than policy-bearing transformations.

#### Function details

##### `ThreadStore::search_threads`  (lines 85–94)

```
fn search_threads(
        &self,
        _params: SearchThreadsParams,
    ) -> ThreadStoreFuture<'_, ThreadSearchPage>
```

**Purpose**: Provides the trait's default behavior for backends that do not implement thread search. It returns an asynchronous error indicating that the `thread/search` operation is unsupported.

**Data flow**: It accepts `SearchThreadsParams` but intentionally ignores them (`_params`). The body constructs a boxed pinned async future that resolves to `Err(ThreadStoreError::Unsupported { operation: "thread/search" })`. It does not read or mutate store state and produces no side effects beyond the returned error future.

**Call relations**: This method is invoked by callers using the `ThreadStore` trait when they request search against a backend that has not overridden the default. Rather than delegating to any backend logic, it terminates the flow immediately with a standardized unsupported-operation error wrapped in a pinned future.

*Call graph*: 1 external calls (pin).


##### `ThreadStore::list_turns`  (lines 97–103)

```
fn list_turns(&self, _params: ListTurnsParams) -> ThreadStoreFuture<'_, TurnPage>
```

**Purpose**: Supplies the default implementation for listing turns within a stored thread when a backend lacks turn-level indexing or retrieval support. It reports that `list_turns` is unsupported.

**Data flow**: It takes `ListTurnsParams` and ignores the value. The function returns a `ThreadStoreFuture<'_, TurnPage>` created by boxing and pinning an async block whose output is `Err(ThreadStoreError::Unsupported { operation: "list_turns" })`. No persistent data is read, transformed, or written.

**Call relations**: Callers reach this path only when using a `ThreadStore` implementation that relies on the trait default instead of providing its own turn-listing logic. The method does not call into other store APIs; it acts as a capability gate that ends the request with a uniform unsupported error.

*Call graph*: 1 external calls (pin).


##### `ThreadStore::list_items`  (lines 106–112)

```
fn list_items(&self, _params: ListItemsParams) -> ThreadStoreFuture<'_, ItemPage>
```

**Purpose**: Implements the trait's fallback behavior for item-level listing inside a stored turn. Its concrete job is to reject the request with an unsupported-operation error for stores that do not expose persisted item enumeration.

**Data flow**: It receives `ListItemsParams` and does not inspect them. It wraps an async block in `Box::pin`, yielding a future whose result is `Err(ThreadStoreError::Unsupported { operation: "list_items" })`. The function neither accesses backend state nor emits any writes or external I/O.

**Call relations**: This default path is used when higher-level code asks a `ThreadStore` for persisted items but the concrete backend has not overridden `list_items`. It delegates only to the standard future boxing/pinning mechanism and otherwise short-circuits the call flow with a consistent capability error.

*Call graph*: 1 external calls (pin).


### `thread-store/src/in_memory.rs`

`domain_logic` · `test-time persistence and debug-mode thread storage`

This module implements a lightweight, fully in-memory persistence backend around `InMemoryThreadStore`, whose mutable state lives inside a `tokio::sync::Mutex<InMemoryThreadStoreState>`. The state tracks both stored data and observability: `InMemoryThreadStoreCalls` counts how many times each store operation was invoked, while maps hold `CreateThreadParams`, rollout histories (`Vec<RolloutItem>`), metadata patches, optional names, and rollout-path-to-thread mappings. A separate global `OnceLock<Mutex<HashMap<String, Arc<InMemoryThreadStore>>>>` lets tests obtain shared stores by string ID via `for_id` and remove them with `remove_id`.

The store records a synthetic `SessionMeta` rollout item when a thread is created, can resume threads with optional preloaded history and rollout paths, canonicalizes appended items through `persisted_rollout_items`, and reconstructs `StoredThread` views on demand with `stored_thread_from_state`. That reconstruction merges original creation parameters with later metadata patches, derives rollout paths either from metadata or reverse lookup, synthesizes timestamps with `Utc::now()` when absent, and converts patched git metadata through `git_info_from_patch`. The `ThreadStore` trait implementation mostly boxes the inherent async methods, while unsupported pagination methods are intentionally inherited from trait defaults and tested as such. One notable design choice is that `list_threads` in the trait impl post-filters by `parent_thread_id`, while the inherent `list_threads` simply returns all created threads sorted by thread ID string. Deletion removes all associated maps and returns `ThreadNotFound` only if no history existed for that thread.

#### Function details

##### `stores`  (lines 40–42)

```
fn stores() -> &'static Mutex<HashMap<String, Arc<InMemoryThreadStore>>>
```

**Purpose**: Returns the global registry of shared in-memory stores keyed by string ID. It lazily initializes the registry on first use.

**Data flow**: Reads the `IN_MEMORY_THREAD_STORES` `OnceLock`, initializes it with `Mutex<HashMap<String, Arc<InMemoryThreadStore>>>` if needed, and returns a `'static` reference to that mutex.

**Call relations**: This helper is used only by `stores_guard`, which provides the actual locked access used by `for_id` and `remove_id`.

*Call graph*: called by 1 (stores_guard).


##### `tests::default_turn_pagination_methods_return_unsupported`  (lines 57–96)

```
async fn default_turn_pagination_methods_return_unsupported()
```

**Purpose**: Verifies that the in-memory store does not implement turn/item pagination and therefore inherits the trait’s unsupported-operation behavior. This protects the intended minimal scope of the test store.

**Data flow**: Creates a default `InMemoryThreadStore` and default `ThreadId`, calls `list_turns` and `list_items` with representative parameters, captures the resulting errors, and asserts that both are `ThreadStoreError::Unsupported` with the expected operation names.

**Call relations**: This test exercises trait-default behavior rather than any custom method in the module.

*Call graph*: calls 1 internal fn (default); 2 external calls (assert!, default).


##### `tests::list_threads_filters_by_parent_thread_id`  (lines 99–158)

```
async fn list_threads_filters_by_parent_thread_id()
```

**Purpose**: Checks that the `ThreadStore` trait implementation of `list_threads` applies `parent_thread_id` filtering on top of the in-memory store’s full listing. It validates the wrapper logic rather than just raw storage.

**Data flow**: Creates a default store, constructs parent/child/unrelated thread IDs, inserts two threads with different `parent_thread_id` values via `create_thread`, then calls `ThreadStore::list_threads` with `parent_thread_id: Some(parent_thread_id)` and asserts that only the child thread ID is returned.

**Call relations**: This test specifically targets the trait-impl `list_threads` wrapper, which delegates to the inherent listing method and then retains matching parent threads.

*Call graph*: calls 3 internal fn (default, default, from_string); 4 external calls (new, assert_eq!, default, list_threads).


##### `stores_guard`  (lines 161–166)

```
fn stores_guard() -> MutexGuard<'static, HashMap<String, Arc<InMemoryThreadStore>>>
```

**Purpose**: Locks the global shared-store registry and recovers from mutex poisoning by taking the inner guard anyway. This keeps test cleanup and reuse resilient after panics.

**Data flow**: Calls `stores().lock()`, returns the `MutexGuard` on success, or extracts and returns `poisoned.into_inner()` if the mutex was poisoned.

**Call relations**: It is the synchronization helper used by `InMemoryThreadStore::for_id` and `InMemoryThreadStore::remove_id`.

*Call graph*: calls 1 internal fn (stores); called by 2 (for_id, remove_id).


##### `InMemoryThreadStore::for_id`  (lines 211–218)

```
fn for_id(id: impl Into<String>) -> Arc<Self>
```

**Purpose**: Returns a shared named in-memory store, creating it on first access. This allows multiple components in a test to point at the same synthetic persistence backend.

**Data flow**: Consumes any `Into<String>` ID, converts it to `String`, locks the global registry with `stores_guard`, inserts `Arc::new(Self::default())` if the ID is absent, clones the stored `Arc`, and returns it.

**Call relations**: This is used by tests and config-driven store selection paths that need a reusable in-memory backend keyed by identifier.

*Call graph*: calls 1 internal fn (stores_guard); called by 8 (get_conversation_summary_by_thread_id_reads_pathless_store_thread, cold_thread_resume_reuses_non_local_history_probe, thread_delete_with_non_local_thread_store_does_not_create_local_persistence, thread_list_includes_store_thread_without_rollout_path, thread_read_loaded_include_turns_reads_store_history_without_rollout_path, thread_turns_list_reads_store_history_without_rollout_path, thread_unarchive_preserves_pathless_store_metadata, thread_store_from_config); 1 external calls (into).


##### `InMemoryThreadStore::remove_id`  (lines 221–223)

```
fn remove_id(id: &str) -> Option<Arc<Self>>
```

**Purpose**: Removes and returns a shared named in-memory store from the global registry. It is mainly used for cleanup between tests.

**Data flow**: Takes a string slice ID, locks the registry with `stores_guard`, removes the matching entry from the `HashMap`, and returns the removed `Arc` if present.

**Call relations**: This complements `for_id` and is typically invoked from drop/cleanup paths in tests.

*Call graph*: calls 1 internal fn (stores_guard); called by 4 (drop, drop, drop, drop).


##### `InMemoryThreadStore::calls`  (lines 226–228)

```
async fn calls(&self) -> InMemoryThreadStoreCalls
```

**Purpose**: Returns a snapshot of the store’s operation call counters. It supports assertions about persistence behavior in tests.

**Data flow**: Locks `self.state`, clones the embedded `InMemoryThreadStoreCalls`, and returns that clone.

**Call relations**: This is a read-only inspection helper for tests that need to verify which store operations occurred.


##### `InMemoryThreadStore::as_any`  (lines 390–392)

```
fn as_any(&self) -> &dyn std::any::Any
```

**Purpose**: Exposes the store as `dyn Any` for downcasting through the `ThreadStore` trait object. It enables callers to detect concrete store types.

**Data flow**: Returns `self` as `&dyn std::any::Any` without modifying state.

**Call relations**: This satisfies the `ThreadStore` trait and supports code paths like `LiveThread::local_rollout_path` that downcast concrete stores.


##### `InMemoryThreadStore::create_thread`  (lines 394–396)

```
fn create_thread(&self, params: CreateThreadParams) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Implements thread creation by recording the original creation parameters and seeding history with a synthetic `SessionMeta` rollout item. It also increments the create call counter.

**Data flow**: Receives `CreateThreadParams`, locks state, increments `calls.create_thread`, builds a `SessionMeta` from the params including source-derived nickname/role/path and metadata-derived provider/base instructions/dynamic tools/memory mode, pushes it as `RolloutItem::SessionMeta(SessionMetaLine { ... })` into the thread’s history, stores the original params in `created_threads`, and returns `Ok(())`.

**Call relations**: This inherent async method backs the trait implementation’s boxed `create_thread` call and is used by tests that seed in-memory threads.

*Call graph*: calls 1 internal fn (default); called by 1 (seed_pathless_store_thread); 3 external calls (pin, matches!, SessionMeta).


##### `InMemoryThreadStore::resume_thread`  (lines 398–400)

```
fn resume_thread(&self, params: ResumeThreadParams) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Registers a resumed thread in memory, optionally replacing its history and associating a rollout path. It increments the resume call counter but does not validate prior existence.

**Data flow**: Takes `ResumeThreadParams`, locks state, increments `calls.resume_thread`, inserts provided history into `histories` or ensures an empty history entry exists, stores any provided rollout path in `rollout_paths`, and returns `Ok(())`.

**Call relations**: This method backs the trait implementation’s boxed `resume_thread` and is used when higher-level code resumes a live thread against the in-memory backend.

*Call graph*: 1 external calls (pin).


##### `InMemoryThreadStore::append_items`  (lines 402–404)

```
fn append_items(&self, params: AppendThreadItemsParams) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Appends canonical persisted rollout items to a thread’s in-memory history and ignores non-persistable or empty input. It increments the append counter only when something canonical remains.

**Data flow**: Receives `AppendThreadItemsParams`, canonicalizes `params.items` with `persisted_rollout_items`, returns early if the canonical list is empty, otherwise locks state, increments `calls.append_items`, extends the thread’s history vector with the canonical items, and returns `Ok(())`.

**Call relations**: This inherent method backs the trait implementation’s boxed `append_items` and is used by tests that simulate persisted rollout growth.

*Call graph*: called by 1 (seed_pathless_store_thread); 2 external calls (pin, persisted_rollout_items).


##### `InMemoryThreadStore::persist_thread`  (lines 406–411)

```
fn persist_thread(&self, _thread_id: ThreadId) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Implements the persist operation as a no-op except for call counting. It exists so higher-level code can exercise persistence lifecycle hooks against the in-memory backend.

**Data flow**: Ignores the thread ID payload, returns a boxed async block that locks state, increments `calls.persist_thread`, and yields `Ok(())`.

**Call relations**: This is the `ThreadStore` trait implementation for persist and is typically reached through `LiveThread::persist`.

*Call graph*: 1 external calls (pin).


##### `InMemoryThreadStore::flush_thread`  (lines 413–418)

```
fn flush_thread(&self, _thread_id: ThreadId) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Implements flush as a no-op except for call counting. It models the lifecycle hook without durable storage effects.

**Data flow**: Ignores the thread ID payload, returns a boxed async block that locks state, increments `calls.flush_thread`, and returns `Ok(())`.

**Call relations**: This trait method is reached through higher-level flush paths such as `LiveThread::flush`.

*Call graph*: 1 external calls (pin).


##### `InMemoryThreadStore::shutdown_thread`  (lines 420–425)

```
fn shutdown_thread(&self, _thread_id: ThreadId) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Implements shutdown as a no-op except for call counting. It lets tests observe that shutdown was requested.

**Data flow**: Ignores the thread ID payload, returns a boxed async block that locks state, increments `calls.shutdown_thread`, and returns `Ok(())`.

**Call relations**: This trait method is typically invoked by live-thread shutdown flows.

*Call graph*: 1 external calls (pin).


##### `InMemoryThreadStore::discard_thread`  (lines 427–432)

```
fn discard_thread(&self, _thread_id: ThreadId) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Implements discard as a no-op except for call counting. It models abandoning live persistence without deleting stored thread data.

**Data flow**: Ignores the thread ID payload, returns a boxed async block that locks state, increments `calls.discard_thread`, and returns `Ok(())`.

**Call relations**: This trait method is used by failure-cleanup paths such as `LiveThreadInitGuard` and `LiveThread::resume` error handling.

*Call graph*: 1 external calls (pin).


##### `InMemoryThreadStore::load_history`  (lines 434–439)

```
fn load_history(
        &self,
        params: LoadThreadHistoryParams,
    ) -> ThreadStoreFuture<'_, StoredThreadHistory>
```

**Purpose**: Loads the stored rollout history for a thread and errors if the thread is unknown. It also increments the history-load counter.

**Data flow**: Receives `LoadThreadHistoryParams`, locks state, increments `calls.load_history`, clones the thread’s history vector from `histories` or returns `ThreadStoreError::ThreadNotFound`, wraps the items in `StoredThreadHistory`, and returns it.

**Call relations**: This inherent method backs the trait implementation’s boxed `load_history` and is used by resume and read flows that need full rollout items.

*Call graph*: 1 external calls (pin).


##### `InMemoryThreadStore::read_thread`  (lines 441–443)

```
fn read_thread(&self, params: ReadThreadParams) -> ThreadStoreFuture<'_, StoredThread>
```

**Purpose**: Builds a `StoredThread` view for a thread ID, optionally including history, and tracks both read counts and read-with-history counts. It delegates reconstruction to a shared helper.

**Data flow**: Receives `ReadThreadParams`, locks state, increments `calls.read_thread`, conditionally increments `calls.read_thread_with_history`, calls `stored_thread_from_state(&state, thread_id, include_history)`, and returns that result.

**Call relations**: This inherent method backs the trait implementation’s boxed `read_thread` and is used by higher-level thread inspection paths.

*Call graph*: calls 1 internal fn (stored_thread_from_state); 1 external calls (pin).


##### `InMemoryThreadStore::read_thread_by_rollout_path`  (lines 445–452)

```
fn read_thread_by_rollout_path(
        &self,
        params: ReadThreadByRolloutPathParams,
    ) -> ThreadStoreFuture<'_, StoredThread>
```

**Purpose**: Looks up a thread by rollout path and returns its reconstructed `StoredThread` view. It errors with `InvalidRequest` if the path is unknown.

**Data flow**: Receives `ReadThreadByRolloutPathParams`, locks state, increments `calls.read_thread_by_rollout_path`, looks up `params.rollout_path` in `rollout_paths`, returns an `InvalidRequest` error if absent, otherwise calls `stored_thread_from_state(&state, thread_id, include_history)` and returns the result.

**Call relations**: This inherent method backs the trait implementation’s boxed `read_thread_by_rollout_path` for callers that identify threads by persisted rollout location.

*Call graph*: calls 1 internal fn (stored_thread_from_state); 2 external calls (pin, format!).


##### `InMemoryThreadStore::list_threads`  (lines 454–463)

```
fn list_threads(&self, params: ListThreadsParams) -> ThreadStoreFuture<'_, ThreadPage>
```

**Purpose**: Returns all created threads as a single page sorted by thread ID string. It does not itself apply filtering parameters.

**Data flow**: Locks state, increments `calls.list_threads`, maps every key in `created_threads` through `stored_thread_from_state(..., include_history=false)`, collects the results into a vector, sorts by `thread_id.to_string()`, wraps them in `ThreadPage { items, next_cursor: None }`, and returns it.

**Call relations**: The trait implementation’s `list_threads` wrapper calls this inherent method first, then applies `parent_thread_id` filtering if requested.

*Call graph*: 1 external calls (pin).


##### `InMemoryThreadStore::update_thread_metadata`  (lines 465–470)

```
fn update_thread_metadata(
        &self,
        params: UpdateThreadMetadataParams,
    ) -> ThreadStoreFuture<'_, StoredThread>
```

**Purpose**: Merges a metadata patch into stored thread metadata, updates the separately tracked thread name when present, and returns the reconstructed thread view. It increments the metadata-update counter.

**Data flow**: Receives `UpdateThreadMetadataParams`, locks state, increments `calls.update_thread_metadata`, stores `patch.name` into `names` when provided, merges the patch into `metadata_updates[thread_id]`, calls `stored_thread_from_state(&state, thread_id, false)`, and returns the resulting `StoredThread`.

**Call relations**: This inherent method backs the trait implementation’s boxed `update_thread_metadata` and is used by metadata-syncing higher-level code.

*Call graph*: calls 1 internal fn (stored_thread_from_state); called by 1 (seed_pathless_store_thread); 1 external calls (pin).


##### `InMemoryThreadStore::archive_thread`  (lines 472–477)

```
fn archive_thread(&self, _params: ArchiveThreadParams) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Implements archive as a no-op except for call counting. It does not move or mark data beyond incrementing the archive counter.

**Data flow**: Ignores the archive parameters, returns a boxed async block that locks state, increments `calls.archive_thread`, and returns `Ok(())`.

**Call relations**: This trait method exists so archive lifecycle paths can be exercised against the in-memory backend.

*Call graph*: 1 external calls (pin).


##### `InMemoryThreadStore::unarchive_thread`  (lines 479–485)

```
fn unarchive_thread(&self, params: ArchiveThreadParams) -> ThreadStoreFuture<'_, StoredThread>
```

**Purpose**: Implements unarchive by incrementing the counter and returning the current reconstructed thread view. It does not maintain archived state internally.

**Data flow**: Receives `ArchiveThreadParams`, returns a boxed async block that locks state, increments `calls.unarchive_thread`, calls `stored_thread_from_state(&state, params.thread_id, false)`, and returns that `StoredThread`.

**Call relations**: This trait method supports unarchive flows in tests even though the in-memory backend does not track archived timestamps.

*Call graph*: calls 1 internal fn (stored_thread_from_state); 1 external calls (pin).


##### `InMemoryThreadStore::delete_thread`  (lines 487–489)

```
fn delete_thread(&self, params: DeleteThreadParams) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Deletes all in-memory data associated with a thread and reports `ThreadNotFound` if the thread had no history entry. It also removes any rollout-path mappings pointing to that thread.

**Data flow**: Receives `DeleteThreadParams`, locks state, increments `calls.delete_thread`, removes the thread from `histories`, `created_threads`, `names`, and `metadata_updates`, prunes matching entries from `rollout_paths`, and returns `Ok(())` if a history entry existed or `ThreadStoreError::ThreadNotFound` otherwise.

**Call relations**: This inherent method backs the trait implementation’s boxed `delete_thread` and is used by cleanup paths.

*Call graph*: 1 external calls (pin).


##### `stored_thread_from_state`  (lines 492–565)

```
fn stored_thread_from_state(
    state: &InMemoryThreadStoreState,
    thread_id: ThreadId,
    include_history: bool,
) -> ThreadStoreResult<StoredThread>
```

**Purpose**: Reconstructs a `StoredThread` snapshot by combining original creation parameters, accumulated metadata patches, optional history, and rollout-path mappings. It is the central read-model builder for the in-memory store.

**Data flow**: Reads immutable `InMemoryThreadStoreState`, looks up `created_threads[thread_id]` or returns `ThreadNotFound`, clones history items if present, conditionally wraps them in `StoredThreadHistory`, resolves `name`, metadata patch, and rollout path, then builds a `StoredThread` with patched values taking precedence over creation defaults. Missing timestamps default to `Utc::now()`, missing provider/CLI version default to `"test"`, and git metadata is converted through `git_info_from_patch`.

**Call relations**: This helper is called by `read_thread`, `read_thread_by_rollout_path`, `update_thread_metadata`, and `unarchive_thread` so all read paths share the same reconstruction rules.

*Call graph*: called by 4 (read_thread, read_thread_by_rollout_path, unarchive_thread, update_thread_metadata).


##### `git_info_from_patch`  (lines 567–580)

```
fn git_info_from_patch(patch: &ThreadMetadataPatch) -> Option<codex_protocol::protocol::GitInfo>
```

**Purpose**: Converts optional git metadata stored in a `ThreadMetadataPatch` into the protocol-level `GitInfo` structure, dropping it entirely if every field is absent. It also wraps commit hashes in `GitSha`.

**Data flow**: Reads `patch.git_info`, extracts flattened optional `sha`, `branch`, and `origin_url`, returns `None` if all three are absent, otherwise constructs and returns `codex_protocol::protocol::GitInfo { commit_hash, branch, repository_url }` with `commit_hash` mapped through `codex_git_utils::GitSha::new`.

**Call relations**: This helper is used only by `stored_thread_from_state` when reconstructing a `StoredThread` from patched metadata.


### Local thread-store foundation
These files define the local filesystem-backed thread store and the shared helper logic used across its concrete operations.

### `thread-store/src/local/helpers.rs`

`util` · `cross-cutting`

This file is the utility layer for the local thread store. Several helpers enforce filesystem invariants: `scoped_rollout_path` canonicalizes both a root and candidate path and rejects anything outside the allowed subtree, while `rollout_path_is_archived` detects archived placement either by absolute prefix under `codex_home/archived_sessions` or by any matching path component. `matching_rollout_file_name` validates that a rollout basename ends with `<thread-id>.jsonl` or `.jsonl.zst`, preventing accidental cross-thread operations.

The conversion helpers bridge rollout records and store-facing models. `stored_thread_from_rollout_item` builds a `StoredThread` from a `codex_rollout::ThreadItem`, filling defaults for missing provider, source, preview, timestamps, and permission settings, and normalizing compressed paths to logical plain `.jsonl` paths. Supporting parsers recover RFC3339 timestamps, derive `GitInfo`, and extract a `ThreadId` from rollout filenames when the item itself lacks one.

Compatibility logic is concentrated here as well. Permission metadata can be parsed from modern serialized `PermissionProfile` JSON or older sandbox-policy strings and enums; serialization failures are downgraded to warnings and an empty string. Title helpers suppress redundant names when the title is blank or duplicates the first user message/preview. Overall, the file codifies subtle fallback behavior that keeps old rollout files and newer SQLite metadata interoperable.

#### Function details

##### `scoped_rollout_path`  (lines 26–55)

```
fn scoped_rollout_path(
    root: PathBuf,
    rollout_path: &Path,
    root_name: &str,
) -> ThreadStoreResult<PathBuf>
```

**Purpose**: Canonicalizes a rollout path and verifies it resides under a specific allowed root directory. It is used as a path-traversal guard before archive, unarchive, and delete operations touch the filesystem.

**Data flow**: Takes an owned `root` `PathBuf`, a candidate `rollout_path`, and a human-readable `root_name`. It canonicalizes `root`, canonicalizes `rollout_path`, compares `canonical_rollout_path.starts_with(&canonical_root)`, and returns the canonical rollout path on success; otherwise it returns `ThreadStoreError::Internal` for root-resolution failure or `ThreadStoreError::InvalidRequest` when the candidate is missing or outside the root.

**Call relations**: Called by archive, unarchive, and delete code paths before moving or removing files. It delegates only to filesystem canonicalization and centralizes the scope check so those higher-level flows share identical validation semantics.

*Call graph*: called by 3 (archive_thread, delete_rollout_path, unarchive_thread); 2 external calls (format!, canonicalize).


##### `rollout_path_is_archived`  (lines 57–62)

```
fn rollout_path_is_archived(codex_home: &Path, path: &Path) -> bool
```

**Purpose**: Determines whether a rollout path should be treated as archived based on its location. It supports both direct paths under the configured archived root and paths containing the archived subdirectory anywhere in their components.

**Data flow**: Consumes `codex_home` and a candidate `path`; it compares the path against `codex_home.join(ARCHIVED_SESSIONS_SUBDIR)` and scans path components for the archived subdirectory name. It returns a boolean with no side effects.

**Call relations**: Used by read and history-loading flows to enforce `include_archived`, by rollout-path resolution logic, and by metadata conversion helpers that need to set `archived_at` consistently.

*Call graph*: called by 5 (load_history, read_thread, read_thread_from_rollout_path, resolve_rollout_path, stored_thread_from_session_meta); 3 external calls (components, join, starts_with).


##### `matching_rollout_file_name`  (lines 64–92)

```
fn matching_rollout_file_name(
    rollout_path: &Path,
    thread_id: ThreadId,
    display_path: &Path,
) -> ThreadStoreResult<std::ffi::OsString>
```

**Purpose**: Checks that a rollout filename belongs to the expected thread ID by suffix, accepting both plain and compressed rollout extensions. This prevents operations on a path whose basename does not encode the requested thread.

**Data flow**: Accepts a canonical `rollout_path`, the expected `ThreadId`, and a `display_path` for error messages. It extracts the file name, builds required suffixes `<thread_id>.jsonl` and `<thread_id>.jsonl.zst`, compares them against the lossy string form, and returns the owned file name on success or `ThreadStoreError::InvalidRequest` if the file name is missing or mismatched.

**Call relations**: Called by archive, unarchive, and delete helpers after path scoping succeeds. It complements `scoped_rollout_path` by validating identity at the filename level.

*Call graph*: called by 3 (archive_thread, delete_rollout_path, unarchive_thread); 2 external calls (file_name, format!).


##### `touch_modified_time`  (lines 94–97)

```
fn touch_modified_time(path: &Path) -> std::io::Result<()>
```

**Purpose**: Updates a file's modification timestamp to the current time without rewriting its contents. It opens the file in append mode and applies `FileTimes` with a fresh modified time.

**Data flow**: Takes a `&Path`, creates `FileTimes::new().set_modified(SystemTime::now())`, opens the file with `OpenOptions::new().append(true)`, and calls `set_times`. It returns a plain `std::io::Result<()>`.

**Call relations**: Used by unarchive logic after moving a rollout so the restored file reflects a fresh modification time. It is intentionally low-level and does not wrap errors in store-specific types.

*Call graph*: called by 1 (unarchive_thread); 3 external calls (new, new, now).


##### `stored_thread_from_rollout_item`  (lines 99–154)

```
fn stored_thread_from_rollout_item(
    item: ThreadItem,
    archived: bool,
    default_provider: &str,
) -> Option<StoredThread>
```

**Purpose**: Transforms a `codex_rollout::ThreadItem` summary into the store's `StoredThread` model, applying defaults and compatibility fallbacks for missing fields. It is the main adapter from rollout-library listing/search/read summaries into thread-store responses.

**Data flow**: Consumes a `ThreadItem`, an `archived` flag, and the default provider string. It derives `thread_id` from `item.thread_id` or `thread_id_from_rollout_path`, parses `created_at`/`updated_at` with fallback to `Utc::now`, computes `archived_at`, builds `git_info` from SHA/branch/origin parts, chooses preview from `preview` then `first_user_message`, normalizes `item.path` to a plain rollout path, and constructs a `StoredThread` with fixed defaults such as `AskForApproval::OnRequest` and `PermissionProfile::read_only()`. It returns `None` if no thread ID can be determined.

**Call relations**: Called by list, search, read-by-rollout, and unarchive flows whenever a rollout-library `ThreadItem` must become a public `StoredThread`. It delegates timestamp and git parsing to local helpers.

*Call graph*: calls 3 internal fn (read_only, git_info_from_parts, parse_rfc3339); called by 3 (stored_thread_from_rollout_item_returns_logical_rollout_path, read_thread_from_rollout_path, unarchive_thread); 1 external calls (plain_rollout_path).


##### `permission_profile_from_metadata_value`  (lines 156–163)

```
fn permission_profile_from_metadata_value(value: &str, cwd: &Path) -> PermissionProfile
```

**Purpose**: Parses persisted sandbox/permission metadata into a `PermissionProfile`, supporting both modern serialized profiles and legacy sandbox-policy encodings. Invalid values degrade to read-only permissions.

**Data flow**: Takes the raw metadata string and the thread `cwd`. It first tries `serde_json::from_str::<PermissionProfile>`, then falls back to `parse_legacy_sandbox_policy` and converts that policy with `PermissionProfile::from_legacy_sandbox_policy_for_cwd`, and finally returns `PermissionProfile::read_only()` if all parsing fails.

**Call relations**: Used when reading threads from SQLite metadata so callers receive a normalized permission model regardless of how older metadata was stored.

*Call graph*: called by 2 (read_thread, stored_thread_from_sqlite_metadata).


##### `permission_profile_to_metadata_value`  (lines 165–175)

```
fn permission_profile_to_metadata_value(
    permission_profile: &PermissionProfile,
) -> String
```

**Purpose**: Serializes a `PermissionProfile` for storage in metadata, logging a warning and returning an empty string if serialization fails. This keeps metadata updates non-panicking even for unexpected serialization issues.

**Data flow**: Accepts a `&PermissionProfile`, attempts `serde_json::to_string`, and returns the serialized string on success. On error it emits `tracing::warn!` and returns `String::new()`.

**Call relations**: Called by metadata-update code before writing permission settings into SQLite. It is the inverse of `permission_profile_from_metadata_value` for the modern storage format.

*Call graph*: called by 1 (apply_metadata_update); 3 external calls (new, to_string, warn!).


##### `distinct_thread_metadata_title`  (lines 177–184)

```
fn distinct_thread_metadata_title(metadata: &ThreadMetadata) -> Option<String>
```

**Purpose**: Extracts a meaningful thread title from `ThreadMetadata` only when it is non-empty and not just a duplicate of the first user message. This avoids surfacing redundant names in list/search/read results.

**Data flow**: Reads `metadata.title` and `metadata.first_user_message`, trims whitespace, and returns `Some(title.to_string())` only when the title is non-blank and differs from the trimmed first user message; otherwise it returns `None`.

**Call relations**: Used by list, search, and SQLite-to-thread conversion paths to decide whether SQLite title metadata should become a visible thread name.

*Call graph*: called by 3 (list_threads, stored_thread_from_sqlite_metadata, set_thread_search_result_names).


##### `set_thread_name_from_title`  (lines 186–191)

```
fn set_thread_name_from_title(thread: &mut StoredThread, title: String)
```

**Purpose**: Assigns a thread name from a title only when the title is non-empty and not identical to the thread preview. It preserves the convention that names should add information beyond the preview text.

**Data flow**: Mutably borrows a `StoredThread` and takes a `String` title. It trims both title and `thread.preview`, returns early if the title is blank or duplicates the preview, and otherwise writes `thread.name = Some(title)`.

**Call relations**: Called after list/search/read flows gather titles from SQLite or legacy name indexes. It is the final gate that suppresses redundant naming in outward-facing thread summaries.

*Call graph*: called by 3 (list_threads, read_thread_from_rollout_path, set_thread_search_result_names).


##### `parse_rfc3339`  (lines 193–197)

```
fn parse_rfc3339(value: Option<&str>) -> Option<DateTime<Utc>>
```

**Purpose**: Parses an optional RFC3339 timestamp string into `DateTime<Utc>`. Missing or invalid input yields `None`.

**Data flow**: Accepts `Option<&str>`, returns early on `None`, otherwise parses with `DateTime::parse_from_rfc3339` and converts the timezone to UTC. It returns `Option<DateTime<Utc>>`.

**Call relations**: Used only by `stored_thread_from_rollout_item` to decode rollout summary timestamps while keeping invalid metadata non-fatal.

*Call graph*: called by 1 (stored_thread_from_rollout_item); 1 external calls (parse_from_rfc3339).


##### `parse_legacy_sandbox_policy`  (lines 199–211)

```
fn parse_legacy_sandbox_policy(value: &str) -> serde_json::Result<SandboxPolicy>
```

**Purpose**: Interprets older sandbox-policy metadata encodings, including JSON values and several historical string aliases. It exists solely for backward compatibility with previously persisted metadata.

**Data flow**: Takes a raw string and tries to deserialize it directly as `SandboxPolicy`, then as a JSON string value, then matches known literals like `danger-full-access`, `read-only`, `workspace-write`, and `external-sandbox`, finally retrying string-value deserialization for unknown cases. It returns `serde_json::Result<SandboxPolicy>`.

**Call relations**: Reached through `permission_profile_from_metadata_value` when modern `PermissionProfile` parsing fails. It isolates legacy decoding rules from the rest of the store.

*Call graph*: 1 external calls (from_str).


##### `git_info_from_parts`  (lines 213–226)

```
fn git_info_from_parts(
    sha: Option<String>,
    branch: Option<String>,
    origin_url: Option<String>,
) -> Option<GitInfo>
```

**Purpose**: Builds a `GitInfo` struct from optional SHA, branch, and origin URL fields, or returns `None` when all three are absent. It also wraps the SHA string in the `GitSha` newtype.

**Data flow**: Consumes three `Option<String>` values. If all are `None`, it returns `None`; otherwise it constructs `GitInfo { commit_hash, branch, repository_url }`, mapping `sha` through `GitSha::new`.

**Call relations**: Used across rollout and SQLite conversion paths, plus metadata update logic, to normalize git metadata assembly in one place.

*Call graph*: called by 5 (stored_thread_from_rollout_item, read_thread_by_rollout_path, stored_thread_from_sqlite_metadata, apply_metadata_update, update_thread_metadata).


##### `thread_id_from_rollout_path`  (lines 228–240)

```
fn thread_id_from_rollout_path(path: &Path) -> Option<ThreadId>
```

**Purpose**: Extracts a `ThreadId` from a rollout filename by stripping `.zst` and `.jsonl` suffixes and parsing the trailing UUID segment. It supports filenames of the form `...-<uuid>.jsonl[.zst]`.

**Data flow**: Reads the file name from a `&Path`, converts it to UTF-8, strips optional `.zst` then required `.jsonl`, checks that the stem is long enough and contains a dash before the final 36-character UUID, and parses that suffix with `ThreadId::from_string`. It returns `Option<ThreadId>`.

**Call relations**: Used as a fallback by `stored_thread_from_rollout_item` when the rollout summary lacks an explicit thread ID.

*Call graph*: calls 1 internal fn (from_string); 1 external calls (file_name).


##### `tests::stored_thread_from_rollout_item_returns_logical_rollout_path`  (lines 251–272)

```
fn stored_thread_from_rollout_item_returns_logical_rollout_path()
```

**Purpose**: Verifies that converting a rollout item backed by a compressed file reports the logical plain `.jsonl` rollout path in `StoredThread`.

**Data flow**: Constructs a compressed-path `ThreadItem`, calls `stored_thread_from_rollout_item`, and asserts that the resulting `StoredThread.rollout_path` is the same filename with the `.jsonl` extension rather than `.jsonl.zst`.

**Call relations**: This test pins the path-normalization behavior relied on by list/read/search responses when rollout storage may be compressed.

*Call graph*: calls 1 internal fn (stored_thread_from_rollout_item); 5 external calls (default, from, from_u128, assert_eq!, format!).


### `thread-store/src/local/mod.rs`

`orchestration` · `cross-cutting`

This module is the root of the local thread-store implementation. It declares the submodules that hold operation-specific logic and defines two core types: `LocalThreadStoreConfig`, which captures `codex_home`, `sqlite_home`, and the fallback provider ID, and `LocalThreadStore`, which stores that config plus an optional `StateDbHandle` and a process-local `Arc<Mutex<HashMap<ThreadId, RolloutRecorder>>>` of active live writers.

The inherent methods expose shared primitives used across submodules. `new` constructs the store; `state_db` clones the optional DB handle; `live_recorder`, `ensure_live_recorder_absent`, and `insert_live_recorder` enforce the invariant that at most one live recorder exists per thread ID in a process. `live_rollout_path` and `read_thread_by_rollout_path` are convenience wrappers into submodules. `load_history` is the most substantial local method: it first prefers a live recorder’s rollout path, rejects archived live threads when `include_archived` is false, and otherwise falls back to the normal read path with history enabled.

The `ThreadStore` trait implementation is mostly dispatch glue: each trait method boxes an async future and forwards to the corresponding submodule function. This file therefore defines the object’s shape, concurrency boundaries, and delegation structure. The tests here focus on cross-module behavior: live writer lifecycle, duplicate-writer rejection, external rollout resumes, archived/live history semantics, and the contract that raw appends do not themselves update SQLite metadata.

#### Function details

##### `LocalThreadStoreConfig::from_config`  (lines 77–83)

```
fn from_config(config: &impl codex_rollout::RolloutConfigView) -> Self
```

**Purpose**: Builds a local-store configuration snapshot from any `codex_rollout::RolloutConfigView`. It copies the rollout roots and default provider into owned values.

**Data flow**: Reads `codex_home()`, `sqlite_home()`, and `model_provider_id()` from the supplied config view, converts the paths to `PathBuf`s and the provider to `String`, and returns a new `LocalThreadStoreConfig`.

**Call relations**: Used by higher-level session/setup code when constructing a `LocalThreadStore` from broader application configuration.

*Call graph*: called by 8 (resume_agent_from_rollout_reads_archived_rollout_path, guardian_subagent_does_not_inherit_parent_exec_policy_rules, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, make_session_with_config_and_rx, make_session_with_history_source_and_agent_control_and_rx, session_new_fails_when_zsh_fork_enabled_without_packaged_zsh, thread_store_from_config); 3 external calls (codex_home, model_provider_id, sqlite_home).


##### `LocalThreadStore::fmt`  (lines 87–91)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats `LocalThreadStore` for debugging by exposing its configuration while intentionally omitting internal mutable state details. The output is marked non-exhaustive.

**Data flow**: Reads `self.config`, writes it into a `debug_struct("LocalThreadStore")`, and finishes with `finish_non_exhaustive()`.

**Call relations**: This is the manual `Debug` implementation for the store type and is not part of runtime control flow.

*Call graph*: 1 external calls (debug_struct).


##### `LocalThreadStore::new`  (lines 96–102)

```
fn new(config: LocalThreadStoreConfig, state_db: Option<StateDbHandle>) -> Self
```

**Purpose**: Constructs a `LocalThreadStore` with the provided configuration and optional state DB handle, initializing an empty live-recorder map.

**Data flow**: Consumes `LocalThreadStoreConfig` and `Option<StateDbHandle>`, allocates `Arc<Mutex<HashMap<ThreadId, RolloutRecorder>>>` with an empty map, and returns `Self { config, live_recorders, state_db }`.

**Call relations**: Called by tests and application setup code before any thread-store operations occur.

*Call graph*: called by 75 (resume_agent_from_rollout_reads_archived_rollout_path, has_recorded_sessions, guardian_subagent_does_not_inherit_parent_exec_policy_rules, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, make_session_with_config_and_rx, make_session_with_history_source_and_agent_control_and_rx, session_new_fails_when_zsh_fork_enabled_without_packaged_zsh, with_models_provider_home_and_state_for_tests, thread_store_from_config (+15 more)); 3 external calls (new, new, new).


##### `LocalThreadStore::state_db`  (lines 105–107)

```
async fn state_db(&self) -> Option<StateDbHandle>
```

**Purpose**: Returns a clone of the optional state DB handle used by the local store. This keeps callers from borrowing internal state directly.

**Data flow**: Reads `self.state_db.clone()` and returns `Option<StateDbHandle>` asynchronously.

**Call relations**: Used throughout submodules whenever SQLite-backed metadata lookup or updates are needed.

*Call graph*: called by 14 (archive_thread, delete_thread, list_threads, sync_materialized_rollout_path, read_sqlite_metadata, resolve_rollout_path, search_threads, set_thread_search_result_names, unarchive_thread, apply_metadata_update (+4 more)).


##### `LocalThreadStore::live_rollout_path`  (lines 126–128)

```
async fn live_rollout_path(&self, thread_id: ThreadId) -> ThreadStoreResult<PathBuf>
```

**Purpose**: Exposes the current rollout path for an active live recorder through the public store API surface. It is mainly for legacy local-only code paths.

**Data flow**: Takes a `ThreadId`, delegates to `live_writer::rollout_path(self, thread_id).await`, and returns the resulting `PathBuf` or store error.

**Call relations**: Thin wrapper over the live-writer helper, used by tests and compatibility callers.

*Call graph*: calls 1 internal fn (rollout_path).


##### `LocalThreadStore::live_recorder`  (lines 130–140)

```
async fn live_recorder(
        &self,
        thread_id: ThreadId,
    ) -> ThreadStoreResult<RolloutRecorder>
```

**Purpose**: Looks up and clones the active `RolloutRecorder` for a thread ID from the in-memory live-recorder map. Missing entries are reported as `ThreadNotFound`.

**Data flow**: Locks `self.live_recorders`, reads the map entry for `thread_id`, clones the `RolloutRecorder` if present, and returns it or `ThreadStoreError::ThreadNotFound`.

**Call relations**: Used internally by live-writer operations such as append, flush, persist, and shutdown.

*Call graph*: called by 4 (append_items, flush_thread, persist_thread, shutdown_thread).


##### `LocalThreadStore::ensure_live_recorder_absent`  (lines 142–152)

```
async fn ensure_live_recorder_absent(
        &self,
        thread_id: ThreadId,
    ) -> ThreadStoreResult<()>
```

**Purpose**: Rejects attempts to create or resume a live writer when one is already registered for the thread. It enforces the single-live-writer-per-thread invariant.

**Data flow**: Locks `self.live_recorders`, checks `contains_key(&thread_id)`, and returns `InvalidRequest` with a formatted message if present; otherwise returns `Ok(())`.

**Call relations**: Called before creating or resuming live writers so duplicate recorder insertion fails early.

*Call graph*: called by 2 (create_thread, resume_thread); 1 external calls (format!).


##### `LocalThreadStore::insert_live_recorder`  (lines 154–168)

```
async fn insert_live_recorder(
        &self,
        thread_id: ThreadId,
        recorder: RolloutRecorder,
    ) -> ThreadStoreResult<()>
```

**Purpose**: Atomically inserts a new live recorder into the map, failing if another recorder already occupies the thread ID. This closes the race between absence check and insertion.

**Data flow**: Locks `self.live_recorders`, matches on `entry(thread_id)`, inserts the provided `RolloutRecorder` into a vacant entry, or returns `InvalidRequest` if occupied.

**Call relations**: Used by live-writer create and resume flows after recorder construction.

*Call graph*: called by 2 (create_thread, resume_thread); 1 external calls (format!).


##### `LocalThreadStore::read_thread_by_rollout_path_params`  (lines 213–224)

```
async fn read_thread_by_rollout_path_params(
        &self,
        params: ReadThreadByRolloutPathParams,
    ) -> ThreadStoreResult<StoredThread>
```

**Purpose**: Adapts `ReadThreadByRolloutPathParams` into the lower-level read-by-path function signature. It is a small convenience wrapper for the trait implementation.

**Data flow**: Consumes the params struct, extracts `rollout_path`, `include_archived`, and `include_history`, and forwards them to `read_thread::read_thread_by_rollout_path`.

**Call relations**: Called by the trait-method implementation for `read_thread_by_rollout_path`.

*Call graph*: calls 1 internal fn (read_thread_by_rollout_path); called by 1 (read_thread_by_rollout_path).


##### `LocalThreadStore::as_any`  (lines 228–230)

```
fn as_any(&self) -> &dyn std::any::Any
```

**Purpose**: Returns the store as `&dyn Any` for downcasting through the `ThreadStore` trait object.

**Data flow**: Returns `self` as `&dyn std::any::Any` with no mutation.

**Call relations**: Part of the `ThreadStore` trait implementation; used by callers that need concrete-type access.


##### `LocalThreadStore::create_thread`  (lines 232–234)

```
fn create_thread(&self, params: CreateThreadParams) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Implements the trait method by boxing and dispatching to the local live-writer create function.

**Data flow**: Accepts `CreateThreadParams`, captures `self`, and returns a boxed future that awaits `live_writer::create_thread(self, params)`.

**Call relations**: This is the trait entrypoint that forwards create requests into the live-writer subsystem.

*Call graph*: calls 1 internal fn (create_thread); 1 external calls (pin).


##### `LocalThreadStore::resume_thread`  (lines 236–238)

```
fn resume_thread(&self, params: ResumeThreadParams) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Implements the trait method by boxing and dispatching to the local live-writer resume function.

**Data flow**: Accepts `ResumeThreadParams`, captures `self`, and returns a boxed future awaiting `live_writer::resume_thread(self, params)`.

**Call relations**: Trait-level forwarding method for resume operations.

*Call graph*: calls 1 internal fn (resume_thread); 1 external calls (pin).


##### `LocalThreadStore::append_items`  (lines 240–242)

```
fn append_items(&self, params: AppendThreadItemsParams) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Implements the trait method by boxing and dispatching to the live append path.

**Data flow**: Accepts `AppendThreadItemsParams` and returns a boxed future awaiting `live_writer::append_items(self, params)`.

**Call relations**: Trait-level forwarding method for raw live appends.

*Call graph*: calls 1 internal fn (append_items); 1 external calls (pin).


##### `LocalThreadStore::persist_thread`  (lines 244–246)

```
fn persist_thread(&self, thread_id: ThreadId) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Implements the trait method by boxing and dispatching to the live persist path.

**Data flow**: Accepts a `ThreadId` and returns a boxed future awaiting `live_writer::persist_thread(self, thread_id)`.

**Call relations**: Trait-level forwarding method for materializing live rollout state.

*Call graph*: calls 1 internal fn (persist_thread); 1 external calls (pin).


##### `LocalThreadStore::flush_thread`  (lines 248–250)

```
fn flush_thread(&self, thread_id: ThreadId) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Implements the trait method by boxing and dispatching to the live flush path.

**Data flow**: Accepts a `ThreadId` and returns a boxed future awaiting `live_writer::flush_thread(self, thread_id)`.

**Call relations**: Trait-level forwarding method for flushing buffered rollout writes.

*Call graph*: calls 1 internal fn (flush_thread); 1 external calls (pin).


##### `LocalThreadStore::shutdown_thread`  (lines 252–254)

```
fn shutdown_thread(&self, thread_id: ThreadId) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Implements the trait method by boxing and dispatching to the live shutdown path.

**Data flow**: Accepts a `ThreadId` and returns a boxed future awaiting `live_writer::shutdown_thread(self, thread_id)`.

**Call relations**: Trait-level forwarding method for closing and removing a live writer.

*Call graph*: calls 1 internal fn (shutdown_thread); 1 external calls (pin).


##### `LocalThreadStore::discard_thread`  (lines 256–258)

```
fn discard_thread(&self, thread_id: ThreadId) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Implements the trait method by boxing and dispatching to the live discard path.

**Data flow**: Accepts a `ThreadId` and returns a boxed future awaiting `live_writer::discard_thread(self, thread_id)`.

**Call relations**: Trait-level forwarding method for abandoning a live writer without persistence.

*Call graph*: calls 1 internal fn (discard_thread); 1 external calls (pin).


##### `LocalThreadStore::load_history`  (lines 260–265)

```
fn load_history(
        &self,
        params: LoadThreadHistoryParams,
    ) -> ThreadStoreFuture<'_, StoredThreadHistory>
```

**Purpose**: Loads a thread's rollout history, preferring an active live recorder's path when one exists and otherwise falling back to the normal read path. It also enforces archived-access rules for live threads.

**Data flow**: Consumes `LoadThreadHistoryParams`; first tries `live_writer::rollout_path(self, params.thread_id).await`. If a live path exists, it checks `helpers::rollout_path_is_archived` against `params.include_archived`, then reads the thread by rollout path with history enabled and extracts `thread.history`, returning an internal error if absent. If no live path exists, it calls `read_thread::read_thread` with `include_history: true` and similarly extracts the history.

**Call relations**: This is both an inherent helper and the implementation behind the trait's `load_history` method. It bridges live-writer state and persisted read logic so callers see current history even for externally resumed or archived live threads.

*Call graph*: calls 4 internal fn (rollout_path_is_archived, rollout_path, read_thread, read_thread_by_rollout_path); 2 external calls (pin, format!).


##### `LocalThreadStore::read_thread`  (lines 267–269)

```
fn read_thread(&self, params: ReadThreadParams) -> ThreadStoreFuture<'_, StoredThread>
```

**Purpose**: Implements the trait method by boxing and dispatching to the local read-thread logic.

**Data flow**: Accepts `ReadThreadParams` and returns a boxed future awaiting `read_thread::read_thread(self, params)`.

**Call relations**: Trait-level forwarding method for thread reads by ID.

*Call graph*: calls 1 internal fn (read_thread); 1 external calls (pin).


##### `LocalThreadStore::read_thread_by_rollout_path`  (lines 271–278)

```
fn read_thread_by_rollout_path(
        &self,
        params: ReadThreadByRolloutPathParams,
    ) -> ThreadStoreFuture<'_, StoredThread>
```

**Purpose**: Implements the trait method by boxing and dispatching through the params-adapter helper.

**Data flow**: Accepts `ReadThreadByRolloutPathParams` and returns a boxed future awaiting `LocalThreadStore::read_thread_by_rollout_path_params(self, params)`.

**Call relations**: Trait-level forwarding method for direct rollout-path reads.

*Call graph*: calls 2 internal fn (read_thread_by_rollout_path_params, read_thread_by_rollout_path); 1 external calls (pin).


##### `LocalThreadStore::list_threads`  (lines 280–282)

```
fn list_threads(&self, params: ListThreadsParams) -> ThreadStoreFuture<'_, ThreadPage>
```

**Purpose**: Implements the trait method by boxing and dispatching to the local listing logic.

**Data flow**: Accepts `ListThreadsParams` and returns a boxed future awaiting `list_threads::list_threads(self, params)`.

**Call relations**: Trait-level forwarding method for paginated thread listing.

*Call graph*: calls 1 internal fn (list_threads); called by 1 (has_threads); 1 external calls (pin).


##### `LocalThreadStore::search_threads`  (lines 284–289)

```
fn search_threads(
        &self,
        params: SearchThreadsParams,
    ) -> ThreadStoreFuture<'_, ThreadSearchPage>
```

**Purpose**: Implements the trait method by boxing and dispatching to the local search logic.

**Data flow**: Accepts `SearchThreadsParams` and returns a boxed future awaiting `search_threads::search_threads(self, params)`.

**Call relations**: Trait-level forwarding method for content-based thread search.

*Call graph*: calls 1 internal fn (search_threads); 1 external calls (pin).


##### `LocalThreadStore::update_thread_metadata`  (lines 291–296)

```
fn update_thread_metadata(
        &self,
        params: UpdateThreadMetadataParams,
    ) -> ThreadStoreFuture<'_, StoredThread>
```

**Purpose**: Implements the trait method by boxing and dispatching to metadata-update logic.

**Data flow**: Accepts `UpdateThreadMetadataParams` and returns a boxed future awaiting `update_thread_metadata::update_thread_metadata(self, params)`.

**Call relations**: Trait-level forwarding method for metadata patch application.

*Call graph*: calls 1 internal fn (update_thread_metadata); 1 external calls (pin).


##### `LocalThreadStore::archive_thread`  (lines 298–300)

```
fn archive_thread(&self, params: ArchiveThreadParams) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Implements the trait method by boxing and dispatching to archive logic.

**Data flow**: Accepts `ArchiveThreadParams` and returns a boxed future awaiting `archive_thread::archive_thread(self, params)`.

**Call relations**: Trait-level forwarding method for moving a thread into the archived collection.

*Call graph*: calls 1 internal fn (archive_thread); 1 external calls (pin).


##### `LocalThreadStore::unarchive_thread`  (lines 302–304)

```
fn unarchive_thread(&self, params: ArchiveThreadParams) -> ThreadStoreFuture<'_, StoredThread>
```

**Purpose**: Implements the trait method by boxing and dispatching to unarchive logic.

**Data flow**: Accepts `ArchiveThreadParams` and returns a boxed future awaiting `unarchive_thread::unarchive_thread(self, params)`.

**Call relations**: Trait-level forwarding method for restoring an archived thread.

*Call graph*: calls 1 internal fn (unarchive_thread); 1 external calls (pin).


##### `LocalThreadStore::delete_thread`  (lines 306–308)

```
fn delete_thread(&self, params: DeleteThreadParams) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Implements the trait method by boxing and dispatching to hard-delete logic.

**Data flow**: Accepts `DeleteThreadParams` and returns a boxed future awaiting `delete_thread::delete_thread(self, params)`.

**Call relations**: Trait-level forwarding method for destructive thread deletion.

*Call graph*: calls 1 internal fn (delete_thread); 1 external calls (pin).


##### `tests::live_writer_lifecycle_writes_and_closes`  (lines 332–378)

```
async fn live_writer_lifecycle_writes_and_closes()
```

**Purpose**: Exercises the full live-writer lifecycle: create, append, persist, flush, verify rollout contents, shutdown, and confirm further appends fail.

**Data flow**: Creates a temp store and thread ID, opens a live writer, appends a user message, persists and flushes, reads the rollout file to assert the message exists, shuts down the writer, then attempts another append and asserts `ThreadNotFound`.

**Call relations**: This integration test spans the trait forwarding methods and the live-writer module to verify end-to-end lifecycle behavior.

*Call graph*: calls 3 internal fn (default, new, test_config); 5 external calls (new, assert!, assert_rollout_contains_message, create_thread_params, vec!).


##### `tests::raw_append_items_does_not_update_sqlite_metadata`  (lines 381–415)

```
async fn raw_append_items_does_not_update_sqlite_metadata()
```

**Purpose**: Pins the contract that raw append operations only write history and do not themselves materialize or update SQLite metadata.

**Data flow**: Initializes a store with a state DB, creates a live thread, appends a user message, flushes, then queries SQLite and asserts no metadata row exists for the thread.

**Call relations**: This test validates the separation between live JSONL appends and metadata updates performed elsewhere.

*Call graph*: calls 4 internal fn (default, init, new, test_config); 4 external calls (new, assert_eq!, create_thread_params, vec!).


##### `tests::live_thread_observes_appended_items_into_sqlite_metadata`  (lines 418–450)

```
async fn live_thread_observes_appended_items_into_sqlite_metadata()
```

**Purpose**: Verifies that the higher-level `LiveThread` wrapper observes appended items and updates SQLite metadata accordingly.

**Data flow**: Creates a store with state DB, constructs a `LiveThread`, appends a user message through it, flushes, then reads SQLite metadata and asserts first-user-message, preview, and title were populated.

**Call relations**: This test demonstrates the intended layering: `LocalThreadStore` provides raw persistence while `LiveThread` adds metadata observation above it.

*Call graph*: calls 5 internal fn (default, init, create, new, test_config); 5 external calls (new, new, assert_eq!, create_thread_params, user_message_item).


##### `tests::live_thread_shutdown_does_not_materialize_empty_thread_metadata`  (lines 453–486)

```
async fn live_thread_shutdown_does_not_materialize_empty_thread_metadata()
```

**Purpose**: Ensures shutting down an empty live thread does not create a rollout file or SQLite metadata row.

**Data flow**: Creates a live thread with state DB, captures its live rollout path, shuts it down without appends, then asserts the rollout path does not exist and SQLite returns `None` for the thread.

**Call relations**: This test covers the interaction between shutdown, rollout materialization, and metadata sync.

*Call graph*: calls 5 internal fn (default, init, create, new, test_config); 5 external calls (new, new, assert!, assert_eq!, create_thread_params).


##### `tests::live_thread_shutdown_with_buffered_items_materializes_before_metadata_read`  (lines 489–530)

```
async fn live_thread_shutdown_with_buffered_items_materializes_before_metadata_read()
```

**Purpose**: Checks that shutdown flushes buffered items to disk before metadata is read, so SQLite can safely point at an existing rollout path.

**Data flow**: Creates a live thread, appends a metadata-only token-count item, shuts down, asserts the rollout file now exists, then reads SQLite metadata and checks that `rollout_path` matches the materialized file.

**Call relations**: This test validates the ordering guarantee enforced by shutdown plus `sync_materialized_rollout_path`.

*Call graph*: calls 5 internal fn (default, init, create, new, test_config); 7 external calls (new, new, assert!, assert_eq!, TokenCount, EventMsg, create_thread_params).


##### `tests::live_thread_resume_loads_history_before_observing_metadata`  (lines 533–583)

```
async fn live_thread_resume_loads_history_before_observing_metadata()
```

**Purpose**: Verifies that resuming from an existing rollout loads prior history before metadata observation, preserving original created time, provider, and first user message.

**Data flow**: Writes a session file, resumes a `LiveThread` with different incoming metadata, appends a new message, then reads SQLite metadata and asserts it reflects the original rollout's created timestamp, provider, and first user message.

**Call relations**: This test covers resume behavior across the local store, read path, and higher-level metadata observation.

*Call graph*: calls 6 internal fn (from_string, init, resume, new, test_config, write_session_file); 5 external calls (new, new, assert_eq!, user_message_item, from_u128).


##### `tests::live_thread_resume_loads_history_from_explicit_external_rollout_path`  (lines 586–637)

```
async fn live_thread_resume_loads_history_from_explicit_external_rollout_path()
```

**Purpose**: Confirms that resume works from a rollout path outside `codex_home` and still seeds metadata from the external rollout's existing history.

**Data flow**: Creates an external rollout file, resumes a `LiveThread` against it, appends a new message, then reads SQLite metadata and asserts created time, provider, and first user message came from the external rollout rather than the resume metadata.

**Call relations**: This test validates external-path resume support and the store's ability to read history from non-local rollout locations.

*Call graph*: calls 6 internal fn (from_string, init, resume, new, test_config, write_session_file); 5 external calls (new, new, assert_eq!, user_message_item, from_u128).


##### `tests::create_thread_rejects_missing_cwd`  (lines 640–657)

```
async fn create_thread_rejects_missing_cwd()
```

**Purpose**: Ensures local thread creation fails when persistence metadata omits the working directory.

**Data flow**: Builds create params, clears `metadata.cwd`, calls `store.create_thread`, captures the error, and asserts it is the expected `InvalidRequest` message.

**Call relations**: This test covers validation performed in the create path beneath the trait forwarding layer.

*Call graph*: calls 3 internal fn (default, new, test_config); 3 external calls (new, assert!, create_thread_params).


##### `tests::discard_thread_drops_unmaterialized_live_writer`  (lines 660–693)

```
async fn discard_thread_drops_unmaterialized_live_writer()
```

**Purpose**: Checks that discarding a live writer removes it from memory without materializing a rollout file and causes later appends to fail.

**Data flow**: Creates a live thread, captures its live rollout path, calls `discard_thread`, asserts the path does not exist, then attempts an append and asserts `ThreadNotFound`.

**Call relations**: This test targets the discard branch of the live-writer lifecycle.

*Call graph*: calls 3 internal fn (default, new, test_config); 4 external calls (new, assert!, create_thread_params, vec!).


##### `tests::resume_thread_reopens_live_writer_and_appends`  (lines 696–755)

```
async fn resume_thread_reopens_live_writer_and_appends()
```

**Purpose**: Verifies that a thread can be created, written, shut down, resumed in a new store instance, and appended to again using the same rollout file.

**Data flow**: Creates an initial store, writes and flushes a message, captures the rollout path, shuts down, creates a second store, resumes the thread without an explicit path, appends another message, flushes, and asserts both messages are present in the rollout.

**Call relations**: This test spans create, persist, flush, shutdown, resume, and append flows across two store instances.

*Call graph*: calls 3 internal fn (default, new, test_config); 5 external calls (new, assert_rollout_contains_message, create_thread_params, thread_metadata, vec!).


##### `tests::create_thread_rejects_duplicate_live_writer`  (lines 758–775)

```
async fn create_thread_rejects_duplicate_live_writer()
```

**Purpose**: Ensures creating the same live thread twice in one store instance is rejected.

**Data flow**: Creates a live thread, attempts to create it again with the same params, captures the error, and asserts it is an `InvalidRequest` mentioning an existing live local writer.

**Call relations**: This test covers the duplicate-prevention invariant enforced by `ensure_live_recorder_absent` and `insert_live_recorder`.

*Call graph*: calls 3 internal fn (default, new, test_config); 3 external calls (new, assert!, create_thread_params).


##### `tests::resume_thread_rejects_duplicate_live_writer`  (lines 778–803)

```
async fn resume_thread_rejects_duplicate_live_writer()
```

**Purpose**: Ensures resuming a thread that already has an active live writer in the same store instance is rejected.

**Data flow**: Creates a live thread, obtains its rollout path, attempts to resume the same thread, and asserts the resulting error is an `InvalidRequest` mentioning an existing live local writer.

**Call relations**: This test exercises duplicate detection on the resume path.

*Call graph*: calls 3 internal fn (default, new, test_config); 4 external calls (new, assert!, create_thread_params, thread_metadata).


##### `tests::resume_thread_rejects_missing_cwd`  (lines 806–830)

```
async fn resume_thread_rejects_missing_cwd()
```

**Purpose**: Checks that resuming a live writer fails when the supplied persistence metadata lacks a working directory.

**Data flow**: Writes a session file, constructs `ResumeThreadParams` with `metadata.cwd = None`, calls `store.resume_thread`, and asserts the error mentions the required cwd.

**Call relations**: This test covers validation in the resume path before recorder construction.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 3 external calls (new, assert!, from_u128).


##### `tests::load_history_uses_live_writer_rollout_path`  (lines 833–878)

```
async fn load_history_uses_live_writer_rollout_path()
```

**Purpose**: Verifies that history loading prefers the active live writer's rollout path, including when that path is external to `codex_home`.

**Data flow**: Creates an external rollout, resumes it as a live thread, appends and flushes a new message, calls `store.load_history`, and asserts the returned history contains the appended external message.

**Call relations**: This test targets the live-path-first branch in `LocalThreadStore::load_history`.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 5 external calls (new, assert!, thread_metadata, from_u128, vec!).


##### `tests::read_thread_uses_live_writer_rollout_path_for_external_resume`  (lines 881–917)

```
async fn read_thread_uses_live_writer_rollout_path_for_external_resume()
```

**Purpose**: Checks that reading a thread by ID while it is live-resumed from an external rollout returns that external rollout path and its history.

**Data flow**: Creates an external rollout, resumes it as a live thread, calls `store.read_thread` with history enabled, and asserts the returned `StoredThread` contains the external path and original user-message history.

**Call relations**: This test validates the interaction between live-writer state and read-path resolution.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 5 external calls (new, assert!, assert_eq!, thread_metadata, from_u128).


##### `tests::load_history_uses_live_writer_rollout_path_for_archived_source`  (lines 920–984)

```
async fn load_history_uses_live_writer_rollout_path_for_archived_source()
```

**Purpose**: Ensures archived live sources are rejected when `include_archived` is false and accepted when it is true, both for reads and history loads.

**Data flow**: Creates an archived rollout, resumes it as a live thread, appends and flushes a message, performs active-only read/history calls expecting errors, then loads history with `include_archived: true` and asserts the appended message is present.

**Call relations**: This test covers archived gating in `LocalThreadStore::load_history` and related read behavior for live archived paths.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_archived_session_file); 5 external calls (new, assert!, thread_metadata, from_u128, vec!).


##### `tests::read_thread_by_rollout_path_includes_history`  (lines 987–1029)

```
async fn read_thread_by_rollout_path_includes_history()
```

**Purpose**: Verifies that direct rollout-path reads can include full history for a live-created thread.

**Data flow**: Creates a live thread, appends and flushes a user message, obtains the live rollout path, reads the thread by that path with history enabled, and asserts the returned history contains one user-message event.

**Call relations**: This test exercises the direct path-read wrapper and the underlying read-by-rollout logic.

*Call graph*: calls 3 internal fn (default, new, test_config); 4 external calls (new, assert_eq!, create_thread_params, vec!).


##### `tests::create_thread_params`  (lines 1031–1044)

```
fn create_thread_params(thread_id: ThreadId) -> CreateThreadParams
```

**Purpose**: Builds standard `CreateThreadParams` used by the module's tests.

**Data flow**: Accepts a `ThreadId`, fills a `CreateThreadParams` struct with default instructions, empty tool lists, fixed source values, and metadata from `thread_metadata()`, and returns it.

**Call relations**: Used by multiple tests to reduce duplication when creating live threads.

*Call graph*: calls 1 internal fn (default); 2 external calls (new, thread_metadata).


##### `tests::thread_metadata`  (lines 1046–1052)

```
fn thread_metadata() -> ThreadPersistenceMetadata
```

**Purpose**: Builds standard `ThreadPersistenceMetadata` used by tests, including the current working directory and test provider.

**Data flow**: Reads `std::env::current_dir()`, constructs `ThreadPersistenceMetadata { cwd: Some(...), model_provider: "test-provider", memory_mode: Enabled }`, and returns it.

**Call relations**: Shared helper for create/resume test setup.

*Call graph*: 1 external calls (current_dir).


##### `tests::user_message_item`  (lines 1054–1063)

```
fn user_message_item(message: &str) -> RolloutItem
```

**Purpose**: Constructs a `RolloutItem` containing a plain user-message event for test appends.

**Data flow**: Takes a message string, builds `UserMessageEvent` with that message and default/empty ancillary fields, wraps it in `EventMsg::UserMessage`, then in `RolloutItem::EventMsg`, and returns it.

**Call relations**: Used by many lifecycle tests to append recognizable content into rollouts.

*Call graph*: 4 external calls (default, new, UserMessage, EventMsg).


##### `tests::assert_rollout_contains_message`  (lines 1065–1075)

```
async fn assert_rollout_contains_message(path: &std::path::Path, expected: &str)
```

**Purpose**: Loads rollout items from disk and asserts that at least one user-message event contains the expected text.

**Data flow**: Accepts a rollout path and expected string, calls `RolloutRecorder::load_rollout_items(path).await`, scans the returned items for a matching `UserMessage` event, and asserts success.

**Call relations**: Shared assertion helper for tests that verify persisted rollout contents after create/resume/append flows.

*Call graph*: calls 1 internal fn (load_rollout_items); 1 external calls (assert!).


### Local thread lifecycle operations
These files cover the main local thread-store behaviors for live writing, reconstructing stored threads, browsing and searching them, and deleting persisted data.

### `thread-store/src/local/live_writer.rs`

`domain_logic` · `live thread persistence`

This file is the write-path counterpart to the read/list modules. It wraps `codex_rollout::RolloutRecorder` instances stored in `LocalThreadStore.live_recorders` and exposes lifecycle operations for live threads. `create_thread` ensures no recorder already exists for the thread, delegates recorder construction to the sibling `create_thread` module, and inserts the recorder into the in-memory map. `resume_thread` similarly rejects duplicates, resolves the rollout path either from explicit params or by reading the existing thread, requires a `cwd` in persistence metadata, builds a `RolloutConfig`, and opens a recorder in resume mode.

`append_items` canonicalizes incoming rollout items with `persisted_rollout_items`, skips empty canonical batches, records them to the live recorder, and then flushes immediately. The flush is intentional: metadata updates happen above this layer, so JSONL must be durable before SQLite metadata can be advanced. `persist_thread`, `flush_thread`, and `shutdown_thread` all invoke the corresponding recorder operation and then call `sync_materialized_rollout_path`, which checks whether a real rollout file now exists and, if SQLite metadata for the thread exists, updates its `rollout_path` to the recorder’s current path. Sync failures are logged as warnings rather than returned.

`discard_thread` simply drops an unmaterialized recorder from memory, while `rollout_path` exposes the current live path for compatibility with read/history code. All recorder I/O errors are normalized into `ThreadStoreError::Internal` via `thread_store_io_error`.

#### Function details

##### `create_thread`  (lines 20–28)

```
async fn create_thread(
    store: &LocalThreadStore,
    params: CreateThreadParams,
) -> ThreadStoreResult<()>
```

**Purpose**: Starts live local persistence for a new thread by creating a `RolloutRecorder` and registering it in the store's live-recorder map. It rejects duplicate live writers for the same thread ID.

**Data flow**: Takes the store and `CreateThreadParams`; reads `params.thread_id`, checks `store.ensure_live_recorder_absent(thread_id).await`, delegates recorder creation to `create_thread::create_thread`, and writes the resulting recorder into `store.live_recorders` via `insert_live_recorder`. It returns `()` or a `ThreadStoreError` from duplicate detection or recorder creation.

**Call relations**: Invoked by the store trait's `create_thread` method. It is a thin orchestration layer over duplicate checking, recorder construction, and insertion.

*Call graph*: calls 3 internal fn (ensure_live_recorder_absent, insert_live_recorder, create_thread); called by 1 (create_thread).


##### `resume_thread`  (lines 30–75)

```
async fn resume_thread(
    store: &LocalThreadStore,
    params: ResumeThreadParams,
) -> ThreadStoreResult<()>
```

**Purpose**: Reopens live local persistence for an existing thread, optionally discovering the rollout path by reading the thread first. It requires persistence metadata to include a working directory.

**Data flow**: Consumes the store and `ResumeThreadParams`; reads `params.thread_id`, `params.rollout_path`, `params.history`, `params.include_archived`, and `params.metadata`. It rejects duplicate live writers, resolves the rollout path either directly or by calling `read_thread`, extracts `cwd` from metadata or returns `InvalidRequest`, builds a `RolloutConfig` using the supplied provider and memory mode, creates a resumed `RolloutRecorder` with `RolloutRecorderParams::resume(rollout_path)`, and inserts it into `store.live_recorders`.

**Call relations**: Called by the store trait's resume path. When no explicit rollout path is supplied, it depends on `read_thread` to locate the persisted thread and delegates recorder construction to `RolloutRecorder::new` in resume mode.

*Call graph*: calls 5 internal fn (new, resume, ensure_live_recorder_absent, insert_live_recorder, read_thread); called by 1 (resume_thread); 1 external calls (matches!).


##### `append_items`  (lines 77–93)

```
async fn append_items(
    store: &LocalThreadStore,
    params: AppendThreadItemsParams,
) -> ThreadStoreResult<()>
```

**Purpose**: Appends canonicalized rollout items to an active live recorder and flushes them so JSONL persistence is durable before higher layers update metadata. Empty canonical batches are ignored.

**Data flow**: Accepts the store and `AppendThreadItemsParams`; reads `params.items` and `params.thread_id`, transforms items with `persisted_rollout_items`, returns early if the canonical list is empty, fetches the recorder with `store.live_recorder`, writes items via `record_canonical_items`, then flushes the recorder. It returns `()` or wraps any `std::io::Error` as `ThreadStoreError::Internal`.

**Call relations**: Invoked by the store trait append path. It sits between callers and the recorder, enforcing canonicalization and the flush-before-metadata invariant noted in the comments.

*Call graph*: calls 1 internal fn (live_recorder); called by 1 (append_items); 1 external calls (persisted_rollout_items).


##### `persist_thread`  (lines 95–106)

```
async fn persist_thread(
    store: &LocalThreadStore,
    thread_id: ThreadId,
) -> ThreadStoreResult<()>
```

**Purpose**: Forces the live recorder to materialize/persist its rollout and then attempts to synchronize the resulting rollout path into SQLite metadata. It is used when a live thread should become durably visible on disk.

**Data flow**: Takes the store and a `ThreadId`, fetches the recorder with `live_recorder`, calls `persist().await`, maps I/O errors through `thread_store_io_error`, then calls `sync_materialized_rollout_path`. It returns `()` or a store error.

**Call relations**: Called by the store trait persist method and also from metadata-update flows that need the rollout path materialized before updating SQLite.

*Call graph*: calls 2 internal fn (live_recorder, sync_materialized_rollout_path); called by 2 (persist_thread, update_thread_metadata).


##### `flush_thread`  (lines 108–119)

```
async fn flush_thread(
    store: &LocalThreadStore,
    thread_id: ThreadId,
) -> ThreadStoreResult<()>
```

**Purpose**: Flushes buffered live rollout data to disk and then syncs any materialized rollout path into SQLite metadata. It does not remove the live recorder.

**Data flow**: Reads the recorder for the given `ThreadId`, calls `flush().await`, maps I/O errors, then invokes `sync_materialized_rollout_path`. It returns `()` or a `ThreadStoreError`.

**Call relations**: Used by the store trait flush method. It shares the same post-write path-sync behavior as `persist_thread` and `shutdown_thread`.

*Call graph*: calls 2 internal fn (live_recorder, sync_materialized_rollout_path); called by 1 (flush_thread).


##### `shutdown_thread`  (lines 121–130)

```
async fn shutdown_thread(
    store: &LocalThreadStore,
    thread_id: ThreadId,
) -> ThreadStoreResult<()>
```

**Purpose**: Closes a live recorder, ensures any materialized rollout path is reflected in SQLite metadata, and removes the recorder from the in-memory live map. After this call, further appends for the thread will fail with not found.

**Data flow**: Takes the store and `ThreadId`; fetches the recorder, calls `shutdown().await`, syncs the rollout path with `sync_materialized_rollout_path`, then mutates `store.live_recorders` to remove the thread entry. It returns `()` or a wrapped I/O/store error.

**Call relations**: Called by the store trait shutdown method. It is the terminal step in the live-writer lifecycle and combines recorder shutdown with cleanup of process-local state.

*Call graph*: calls 2 internal fn (live_recorder, sync_materialized_rollout_path); called by 1 (shutdown_thread).


##### `discard_thread`  (lines 132–143)

```
async fn discard_thread(
    store: &LocalThreadStore,
    thread_id: ThreadId,
) -> ThreadStoreResult<()>
```

**Purpose**: Drops a live recorder from memory without persisting or flushing it. This is intended for abandoning an unmaterialized live thread.

**Data flow**: Consumes the store and `ThreadId`, locks `store.live_recorders`, removes the entry, maps presence to `Ok(())`, and returns `ThreadStoreError::ThreadNotFound` if no live recorder existed.

**Call relations**: Invoked by the store trait discard method. Unlike shutdown, it does not touch the recorder or filesystem; it only mutates the in-memory recorder map.

*Call graph*: called by 1 (discard_thread).


##### `rollout_path`  (lines 145–157)

```
async fn rollout_path(
    store: &LocalThreadStore,
    thread_id: ThreadId,
) -> ThreadStoreResult<PathBuf>
```

**Purpose**: Returns the current rollout path tracked by an active live recorder. It is a compatibility hook for read/history/metadata code that needs the live path before shutdown.

**Data flow**: Takes the store and `ThreadId`, locks `store.live_recorders`, looks up the recorder, calls `recorder.rollout_path()`, clones it into a `PathBuf`, and returns it or `ThreadStoreError::ThreadNotFound`.

**Call relations**: Used by `LocalThreadStore::live_rollout_path`, history loading, rollout-path resolution, and metadata update/sync code whenever live state should override persisted lookup.

*Call graph*: called by 7 (live_rollout_path, load_history, sync_materialized_rollout_path, resolve_rollout_path, apply_metadata_update, resolve_rollout_path, update_thread_metadata).


##### `sync_materialized_rollout_path`  (lines 159–200)

```
async fn sync_materialized_rollout_path(
    store: &LocalThreadStore,
    thread_id: ThreadId,
) -> ThreadStoreResult<()>
```

**Purpose**: Best-effort synchronization from a live recorder's current rollout path into SQLite thread metadata once a real rollout file exists. It intentionally logs failures instead of failing the caller.

**Data flow**: Reads the live rollout path via `rollout_path`, checks `codex_rollout::existing_rollout_path` to see whether the file has materialized, fetches the optional state DB, then loads thread metadata with `get_thread(thread_id)`. If metadata exists and `metadata.rollout_path != rollout_path`, it updates the field and writes it back with `upsert_thread`; any error in this inner async block is converted to `ThreadStoreError`, logged with `warn!`, and suppressed. The outer function always returns `Ok(())` unless obtaining the live path itself fails.

**Call relations**: Called after flush, persist, and shutdown. It bridges the live recorder subsystem and the SQLite index so readers can later find the correct rollout path.

*Call graph*: calls 2 internal fn (state_db, rollout_path); called by 3 (flush_thread, persist_thread, shutdown_thread); 2 external calls (existing_rollout_path, warn!).


##### `thread_store_io_error`  (lines 202–206)

```
fn thread_store_io_error(err: std::io::Error) -> ThreadStoreError
```

**Purpose**: Converts a plain `std::io::Error` into the store's internal error type using the error's string message.

**Data flow**: Accepts an `std::io::Error`, calls `to_string()`, and wraps it in `ThreadStoreError::Internal { message }`.

**Call relations**: Used as the common error-mapping helper for recorder operations in append, persist, flush, and shutdown paths.

*Call graph*: 1 external calls (to_string).


### `thread-store/src/local/read_thread.rs`

`domain_logic` · `request handling`

This file contains the most nuanced read logic in the local store. `read_thread` first tries SQLite metadata via `read_sqlite_metadata`; if metadata exists and is acceptable for the caller’s archived/history requirements, it converts that metadata into a `StoredThread`. When history is not requested, it may still overlay rollout-derived fields such as preview, cwd, provider, and legacy metadata by reading the rollout path and replacing selected fields while preserving SQLite-derived name, git info, and permission profile. If SQLite cannot be trusted—for example because the rollout path is stale, points to another thread, or archived filtering excludes it—the code falls back to locating a rollout file directly.

Rollout resolution prefers an active live writer’s path when it exists and is materialized, then searches active and optionally archived collections using rollout-library lookup helpers and the optional state DB. Reading from a rollout path supports both modern `ThreadItem` summaries and older files that only contain `session_meta`; in the latter case, `stored_thread_from_session_meta` reconstructs a minimal thread summary from the first line and filesystem metadata. Direct path reads canonicalize relative paths under `codex_home`, reject directories and non-files, and normalize compressed paths through `existing_rollout_path`.

History attachment is explicit and optional: if requested, the code loads all rollout items through `RolloutRecorder::load_rollout_items` and stores them in `StoredThreadHistory`. Compatibility details include legacy thread-name lookup, fallback provider IDs, parsing old sandbox-policy strings into `PermissionProfile`, and preferring SQLite git metadata when reading by rollout path.

#### Function details

##### `read_thread`  (lines 29–86)

```
async fn read_thread(
    store: &LocalThreadStore,
    params: ReadThreadParams,
) -> ThreadStoreResult<StoredThread>
```

**Purpose**: Reads a thread by ID, preferring SQLite metadata when it is valid for the request and falling back to rollout discovery otherwise. It optionally attaches full rollout history.

**Data flow**: Consumes `&LocalThreadStore` and `ReadThreadParams`; reads `thread_id`, `include_archived`, `include_history`, optional SQLite metadata via `read_sqlite_metadata`, live/store config, and rollout files. If SQLite metadata exists and passes archived/history checks, it converts it with `stored_thread_from_sqlite_metadata`, may overlay rollout-derived fields from `read_thread_from_rollout_path` when history is not requested and the rollout has a non-empty preview, then calls `attach_history_if_requested`. Otherwise it resolves a rollout path with `resolve_rollout_path`, reads it with `read_thread_from_rollout_path`, enforces archived access, optionally attaches history, and returns the resulting `StoredThread` or a `ThreadStoreError`.

**Call relations**: This is the primary read implementation used by the store trait, history loading, resume logic, and metadata-update flows. It orchestrates SQLite-first reading, rollout fallback, and optional history attachment.

*Call graph*: calls 8 internal fn (permission_profile_from_metadata_value, rollout_path_is_archived, attach_history_if_requested, read_sqlite_metadata, read_thread_from_rollout_path, resolve_rollout_path, sqlite_rollout_path_can_load_history_for_thread, stored_thread_from_sqlite_metadata); called by 5 (load_history, read_thread, resume_thread, apply_metadata_update, update_thread_metadata); 1 external calls (format!).


##### `sqlite_rollout_path_can_load_history_for_thread`  (lines 88–102)

```
async fn sqlite_rollout_path_can_load_history_for_thread(
    store: &LocalThreadStore,
    path: &std::path::Path,
    thread_id: codex_protocol::ThreadId,
) -> bool
```

**Purpose**: Checks whether the rollout path stored in SQLite still exists and actually belongs to the requested thread before it is trusted as a history source. This guards against stale or repointed metadata.

**Data flow**: Takes the store, a rollout `Path`, and `ThreadId`; it checks `codex_rollout::existing_rollout_path(path).await`, then reads the thread from that path and returns `true` only if the read succeeds and the resulting thread ID matches the requested one.

**Call relations**: Called only from `read_thread` when deciding whether SQLite metadata is safe to use for history-bearing reads.

*Call graph*: calls 1 internal fn (read_thread_from_rollout_path); called by 1 (read_thread); 2 external calls (to_path_buf, existing_rollout_path).


##### `read_thread_by_rollout_path`  (lines 104–135)

```
async fn read_thread_by_rollout_path(
    store: &LocalThreadStore,
    rollout_path: std::path::PathBuf,
    include_archived: bool,
    include_history: bool,
) -> ThreadStoreResult<StoredThread>
```

**Purpose**: Reads a thread directly from a supplied rollout path, optionally rejecting archived threads and attaching history, then overlays SQLite git metadata when available.

**Data flow**: Consumes the store, a `PathBuf`, and `include_archived`/`include_history` flags. It canonicalizes and validates the path with `resolve_requested_rollout_path`, reads the rollout summary with `read_thread_from_rollout_path`, rejects archived threads when requested, optionally fetches SQLite metadata for the thread ID and merges git SHA/branch/origin with rollout-derived fallbacks via `git_info_from_parts`, then calls `attach_history_if_requested` and returns the `StoredThread`.

**Call relations**: Used by direct path-read APIs, by history loading for live paths, and by metadata-update code that needs to inspect a specific rollout file.

*Call graph*: calls 5 internal fn (git_info_from_parts, attach_history_if_requested, read_sqlite_metadata, read_thread_from_rollout_path, resolve_requested_rollout_path); called by 4 (load_history, read_thread_by_rollout_path, read_thread_by_rollout_path_params, update_thread_metadata); 1 external calls (format!).


##### `resolve_requested_rollout_path`  (lines 137–176)

```
async fn resolve_requested_rollout_path(
    store: &LocalThreadStore,
    rollout_path: std::path::PathBuf,
) -> ThreadStoreResult<std::path::PathBuf>
```

**Purpose**: Normalizes a caller-supplied rollout path into a canonical existing file path, resolving relative paths under `codex_home` and rejecting directories or non-files. It also follows the rollout library's plain/compressed path resolution.

**Data flow**: Takes the store and a `PathBuf`; if the path is relative it joins it under `store.config.codex_home`, then checks async metadata to reject directories and non-files, asks `codex_rollout::existing_rollout_path` for the actual existing plain/compressed file, canonicalizes that path with `std::fs::canonicalize`, and returns the canonical `PathBuf` or `InvalidRequest` with a detailed message.

**Call relations**: Called only by `read_thread_by_rollout_path` to sanitize external input before any rollout parsing occurs.

*Call graph*: called by 1 (read_thread_by_rollout_path); 5 external calls (is_relative, existing_rollout_path, format!, canonicalize, metadata).


##### `attach_history_if_requested`  (lines 178–194)

```
async fn attach_history_if_requested(
    thread: &mut StoredThread,
    include_history: bool,
) -> ThreadStoreResult<()>
```

**Purpose**: Loads and attaches full rollout history to a `StoredThread` when requested. If history is not requested, it leaves the thread unchanged.

**Data flow**: Mutably borrows a `StoredThread` and a boolean flag. If `include_history` is false it returns immediately; otherwise it reads `thread.thread_id` and `thread.rollout_path`, errors if no rollout path is present, loads items with `load_history_items`, writes `thread.history = Some(StoredThreadHistory { thread_id, items })`, and returns `Ok(())`.

**Call relations**: Used by both ID-based and path-based read functions so history loading behavior is centralized.

*Call graph*: calls 1 internal fn (load_history_items); called by 2 (read_thread, read_thread_by_rollout_path); 1 external calls (format!).


##### `resolve_rollout_path`  (lines 196–243)

```
async fn resolve_rollout_path(
    store: &LocalThreadStore,
    thread_id: codex_protocol::ThreadId,
    include_archived: bool,
) -> ThreadStoreResult<Option<std::path::PathBuf>>
```

**Purpose**: Finds the best rollout path for a thread ID, preferring a materialized live-writer path and otherwise searching active and optionally archived collections. It respects the caller's archived-access flag.

**Data flow**: Accepts the store, `ThreadId`, and `include_archived`. It first tries `live_writer::rollout_path(store, thread_id)` and keeps it only if `existing_rollout_path` says the file exists and archived filtering allows it. If that fails, it fetches the optional state DB handle and calls `find_thread_path_by_id_str`; when `include_archived` is true and no active path is found, it also calls `find_archived_thread_path_by_id_str`. It returns `Ok(Some(path))`, `Ok(None)`, or `InvalidRequest` on lookup errors.

**Call relations**: Called by `read_thread` when SQLite metadata is absent or unsuitable. It bridges live state and persisted rollout discovery.

*Call graph*: calls 3 internal fn (state_db, rollout_path_is_archived, rollout_path); called by 1 (read_thread); 4 external calls (existing_rollout_path, find_archived_thread_path_by_id_str, find_thread_path_by_id_str, to_string).


##### `read_thread_from_rollout_path`  (lines 245–279)

```
async fn read_thread_from_rollout_path(
    store: &LocalThreadStore,
    path: std::path::PathBuf,
) -> ThreadStoreResult<StoredThread>
```

**Purpose**: Builds a `StoredThread` from a rollout file, using a modern `ThreadItem` summary when available and falling back to legacy `session_meta` parsing otherwise. It also applies session-meta overrides and legacy thread names.

**Data flow**: Consumes the store and a rollout `PathBuf`. It calls `read_thread_item_from_rollout`; if that returns `None`, it delegates to `stored_thread_from_session_meta`. Otherwise it computes the archived flag with `rollout_path_is_archived`, converts the item with `stored_thread_from_rollout_item`, normalizes `thread.rollout_path` to the plain path, optionally reads `SessionMetaLine` to fill `forked_from_id`, `parent_thread_id`, and a non-empty `model_provider`, then looks up a legacy thread name with `find_thread_name_by_id` and applies it via `set_thread_name_from_title`.

**Call relations**: Used by both read entrypoints and by SQLite-history validation. It is the core rollout-file decoding routine.

*Call graph*: calls 4 internal fn (rollout_path_is_archived, set_thread_name_from_title, stored_thread_from_rollout_item, stored_thread_from_session_meta); called by 3 (read_thread, read_thread_by_rollout_path, sqlite_rollout_path_can_load_history_for_thread); 6 external calls (as_path, clone, find_thread_name_by_id, plain_rollout_path, read_session_meta_line, read_thread_item_from_rollout).


##### `load_history_items`  (lines 281–290)

```
async fn load_history_items(
    path: &std::path::Path,
) -> ThreadStoreResult<Vec<codex_protocol::protocol::RolloutItem>>
```

**Purpose**: Loads all rollout items from a rollout file and maps any I/O/parsing failure into a store internal error.

**Data flow**: Takes a rollout `Path`, calls `RolloutRecorder::load_rollout_items(path).await`, extracts the `items` vector from the returned tuple, and returns it or `ThreadStoreError::Internal` with the path in the message.

**Call relations**: Called only by `attach_history_if_requested`.

*Call graph*: calls 1 internal fn (load_rollout_items); called by 1 (attach_history_if_requested).


##### `read_sqlite_metadata`  (lines 292–298)

```
async fn read_sqlite_metadata(
    store: &LocalThreadStore,
    thread_id: codex_protocol::ThreadId,
) -> Option<ThreadMetadata>
```

**Purpose**: Fetches thread metadata from the optional state DB, suppressing DB errors by returning `None`. This keeps read paths resilient when SQLite is unavailable or inconsistent.

**Data flow**: Reads `store.state_db().await`, returns early if absent, otherwise calls `runtime.get_thread(thread_id).await`, discards errors with `.ok().flatten()`, and returns `Option<ThreadMetadata>`.

**Call relations**: Used by both ID-based and path-based reads as the SQLite metadata source.

*Call graph*: calls 1 internal fn (state_db); called by 2 (read_thread, read_thread_by_rollout_path).


##### `stored_thread_from_sqlite_metadata`  (lines 300–362)

```
async fn stored_thread_from_sqlite_metadata(
    store: &LocalThreadStore,
    metadata: ThreadMetadata,
) -> StoredThread
```

**Purpose**: Converts a `codex_state::ThreadMetadata` row into a `StoredThread`, supplementing it with legacy name-index and session-meta information where useful. It is the SQLite-side counterpart to rollout-item conversion.

**Data flow**: Consumes the store and `ThreadMetadata`. It derives `name` from `distinct_thread_metadata_title` or falls back to `find_thread_name_by_id`, optionally reads `SessionMetaLine` from `metadata.rollout_path` to recover `forked_from_id` and `parent_thread_id`, normalizes the rollout path to plain `.jsonl`, computes preview from `metadata.preview` or `first_user_message`, parses `permission_profile` from `metadata.sandbox_policy`, parses `source` and `approval_mode` from stored strings, builds `git_info` from git fields, substitutes the store default provider when `metadata.model_provider` is empty, and returns a populated `StoredThread` with `history: None`.

**Call relations**: Called by `read_thread` when SQLite metadata is chosen as the primary source.

*Call graph*: calls 5 internal fn (distinct_thread_metadata_title, git_info_from_parts, permission_profile_from_metadata_value, parse_or_default, parse_session_source); called by 1 (read_thread); 3 external calls (find_thread_name_by_id, plain_rollout_path, read_session_meta_line).


##### `stored_thread_from_session_meta`  (lines 364–377)

```
async fn stored_thread_from_session_meta(
    store: &LocalThreadStore,
    path: std::path::PathBuf,
) -> ThreadStoreResult<StoredThread>
```

**Purpose**: Reads a legacy rollout file's `session_meta` line and converts it into a minimal `StoredThread` when no modern thread summary item is available.

**Data flow**: Takes the store and rollout path, reads `SessionMetaLine` with `read_session_meta_line`, computes the archived flag with `rollout_path_is_archived`, delegates to `stored_thread_from_meta_line`, and returns the resulting `StoredThread` or an internal error if the meta line cannot be read.

**Call relations**: Used as the fallback branch inside `read_thread_from_rollout_path` for older rollout formats.

*Call graph*: calls 2 internal fn (rollout_path_is_archived, stored_thread_from_meta_line); called by 1 (read_thread_from_rollout_path); 2 external calls (as_path, read_session_meta_line).


##### `stored_thread_from_meta_line`  (lines 379–424)

```
fn stored_thread_from_meta_line(
    store: &LocalThreadStore,
    meta_line: SessionMetaLine,
    path: std::path::PathBuf,
    archived: bool,
) -> StoredThread
```

**Purpose**: Constructs a `StoredThread` directly from a `SessionMetaLine` plus filesystem metadata. It is the lowest-level compatibility path for old rollout files.

**Data flow**: Consumes the store, `SessionMetaLine`, rollout path, and archived flag. It parses `created_at` from `meta_line.meta.timestamp` with fallback to `Utc::now`, derives `updated_at` from filesystem modified time or `created_at`, normalizes the rollout path to plain `.jsonl`, and builds a `StoredThread` using fields from `meta_line.meta` and `meta_line.git`, defaulting preview to empty, name to `None`, approval mode to `OnRequest`, and permission profile to `PermissionProfile::read_only()`.

**Call relations**: Called only by `stored_thread_from_session_meta`.

*Call graph*: calls 2 internal fn (read_only, parse_rfc3339_non_optional); called by 1 (stored_thread_from_session_meta); 4 external calls (as_path, new, plain_rollout_path, metadata).


##### `parse_session_source`  (lines 426–430)

```
fn parse_session_source(source: &str) -> SessionSource
```

**Purpose**: Parses a stored session-source string into `SessionSource`, accepting either full JSON or a bare string value. Unknown values become `SessionSource::Unknown`.

**Data flow**: Takes a `&str`, tries `serde_json::from_str`, then wraps the string in `serde_json::Value::String` and retries, finally returning `SessionSource::Unknown` on failure.

**Call relations**: Used by `stored_thread_from_sqlite_metadata` when decoding SQLite metadata.

*Call graph*: called by 1 (stored_thread_from_sqlite_metadata); 1 external calls (from_str).


##### `parse_or_default`  (lines 432–439)

```
fn parse_or_default(value: &str, default: T) -> T
```

**Purpose**: Generic helper that parses a stored string into any deserializable type, accepting either JSON or a bare string representation and falling back to a provided default.

**Data flow**: Consumes a string slice and a default value of type `T: DeserializeOwned`; it tries `serde_json::from_str`, then string-value deserialization, and returns the parsed value or the supplied default.

**Call relations**: Used by `stored_thread_from_sqlite_metadata` to decode fields like `approval_mode` without making malformed metadata fatal.

*Call graph*: called by 1 (stored_thread_from_sqlite_metadata); 1 external calls (from_str).


##### `parse_rfc3339_non_optional`  (lines 441–445)

```
fn parse_rfc3339_non_optional(value: &str) -> Option<DateTime<Utc>>
```

**Purpose**: Parses a required RFC3339 timestamp string into UTC, returning `None` on invalid input.

**Data flow**: Takes a `&str`, parses it with `DateTime::parse_from_rfc3339`, converts the timezone to UTC, and returns `Option<DateTime<Utc>>`.

**Call relations**: Used by `stored_thread_from_meta_line` for legacy session-meta timestamps.

*Call graph*: called by 1 (stored_thread_from_meta_line); 1 external calls (parse_from_rfc3339).


##### `tests::read_thread_returns_active_rollout_summary`  (lines 470–495)

```
async fn read_thread_returns_active_rollout_summary()
```

**Purpose**: Verifies that reading an active thread by ID returns rollout-derived summary fields and attached history.

**Data flow**: Creates a temp store and active session file, reads the thread with history enabled, and asserts thread ID, rollout path, `archived_at`, preview, and history thread ID.

**Call relations**: This test exercises the normal rollout-read path in `read_thread`.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 3 external calls (new, from_u128, assert_eq!).


##### `tests::read_thread_returns_rollout_path_summary`  (lines 498–525)

```
async fn read_thread_returns_rollout_path_summary()
```

**Purpose**: Checks that reading by a relative rollout path resolves it under `codex_home`, canonicalizes it, and returns the expected summary.

**Data flow**: Writes a session file, derives a relative path under the temp home, calls `read_thread_by_rollout_path`, and asserts thread ID, canonical rollout path, and preview.

**Call relations**: This test targets `resolve_requested_rollout_path` and direct path reading.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 3 external calls (new, from_u128, assert_eq!).


##### `tests::read_thread_by_rollout_path_prefers_sqlite_git_info`  (lines 528–574)

```
async fn read_thread_by_rollout_path_prefers_sqlite_git_info()
```

**Purpose**: Ensures direct path reads overlay SQLite git metadata over rollout-derived git info when SQLite has newer values.

**Data flow**: Creates a rollout and matching SQLite metadata with a different branch, reads by rollout path, extracts `git_info`, and asserts branch came from SQLite while commit hash and repository URL remain present.

**Call relations**: This test covers the SQLite git-merge logic in `read_thread_by_rollout_path`.

*Call graph*: calls 6 internal fn (from_string, new, init, new, test_config, write_session_file); 4 external calls (new, now, from_u128, assert_eq!).


##### `tests::read_thread_returns_archived_rollout_when_requested`  (lines 577–615)

```
async fn read_thread_returns_archived_rollout_when_requested()
```

**Purpose**: Verifies that archived rollouts are hidden from active-only reads but returned when `include_archived` is true.

**Data flow**: Writes an archived session file, performs an active-only read expecting an invalid-request message, then reads again with `include_archived: true` and asserts archived path, non-`None` `archived_at`, preview, and absent history.

**Call relations**: This test exercises archived filtering in `resolve_rollout_path` and `read_thread`.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_archived_session_file); 5 external calls (new, from_u128, assert!, assert_eq!, panic!).


##### `tests::read_thread_prefers_active_rollout_over_archived`  (lines 618–640)

```
async fn read_thread_prefers_active_rollout_over_archived()
```

**Purpose**: Checks that when both active and archived rollouts exist for the same thread ID, the active rollout is chosen.

**Data flow**: Writes both active and archived session files for one UUID, reads with `include_archived: true`, and asserts the returned rollout path is the active one with `archived_at == None` and active preview text.

**Call relations**: This test validates the active-first search order in `resolve_rollout_path`.

*Call graph*: calls 5 internal fn (from_string, new, test_config, write_archived_session_file, write_session_file); 3 external calls (new, from_u128, assert_eq!).


##### `tests::read_thread_returns_forked_from_id`  (lines 643–672)

```
async fn read_thread_returns_forked_from_id()
```

**Purpose**: Ensures fork ancestry encoded in session metadata is surfaced in the returned thread summary.

**Data flow**: Writes a session file containing `forked_from_id`, reads the thread, and asserts `thread.forked_from_id` matches the expected parent thread ID.

**Call relations**: This test covers the session-meta override logic in `read_thread_from_rollout_path`.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file_with_fork); 3 external calls (new, from_u128, assert_eq!).


##### `tests::read_thread_applies_sqlite_thread_name`  (lines 675–712)

```
async fn read_thread_applies_sqlite_thread_name()
```

**Purpose**: Verifies that a meaningful SQLite title becomes the thread name when reading by ID.

**Data flow**: Creates a rollout and SQLite metadata with `title = "Saved title"` and first-user-message equal to the rollout preview, reads the thread, and asserts `thread.name` is `Some("Saved title")`.

**Call relations**: This test exercises `distinct_thread_metadata_title` and SQLite-to-thread conversion in `stored_thread_from_sqlite_metadata`.

*Call graph*: calls 6 internal fn (from_string, new, init, new, test_config, write_session_file); 4 external calls (new, now, from_u128, assert_eq!).


##### `tests::read_thread_returns_permission_profile_from_sqlite_metadata`  (lines 715–753)

```
async fn read_thread_returns_permission_profile_from_sqlite_metadata()
```

**Purpose**: Checks that a serialized modern `PermissionProfile` stored in SQLite is parsed and returned on reads.

**Data flow**: Creates a rollout and SQLite metadata whose `sandbox_policy` field contains serialized `PermissionProfile::Disabled`, reads the thread, and asserts preview and permission profile.

**Call relations**: This test covers `permission_profile_from_metadata_value` as used by SQLite-backed reads.

*Call graph*: calls 6 internal fn (from_string, new, init, new, test_config, write_session_file); 5 external calls (new, now, from_u128, assert_eq!, to_string).


##### `tests::read_thread_accepts_legacy_sandbox_policy_metadata`  (lines 756–791)

```
async fn read_thread_accepts_legacy_sandbox_policy_metadata()
```

**Purpose**: Verifies that legacy sandbox-policy strings in SQLite metadata are still accepted and converted into the correct permission profile.

**Data flow**: Creates a rollout and SQLite metadata with `sandbox_policy = "danger-full-access"`, reads the thread with history enabled, and asserts the resulting permission profile is `Disabled`.

**Call relations**: This test targets the legacy parsing branch in `permission_profile_from_metadata_value` reached through `read_thread`.

*Call graph*: calls 6 internal fn (from_string, new, init, new, test_config, write_session_file); 4 external calls (new, now, from_u128, assert_eq!).


##### `tests::read_thread_preserves_rollout_cwd_when_sqlite_metadata_exists`  (lines 794–881)

```
async fn read_thread_preserves_rollout_cwd_when_sqlite_metadata_exists()
```

**Purpose**: Checks that when rollout and SQLite metadata disagree, a rollout with a real preview can override fields like cwd and provider while preserving SQLite title and permission semantics.

**Data flow**: Manually writes a rollout whose session meta has cwd `/` and provider `rollout-provider`, inserts SQLite metadata with a different cwd, title, first-user-message, and legacy sandbox policy, reads without history, and asserts the returned thread uses rollout path, rollout preview/provider/cwd, SQLite title, and a permission profile derived from the legacy policy against the rollout cwd.

**Call relations**: This test exercises the hybrid overlay branch in `read_thread` where rollout data replaces selected SQLite summary fields.

*Call graph*: calls 5 internal fn (from_string, new, init, new, test_config); 11 external calls (from, new, now, from_u128, new, assert_eq!, format!, json!, create, create_dir_all (+1 more)).


##### `tests::read_thread_uses_legacy_thread_name_when_sqlite_title_is_missing`  (lines 884–904)

```
async fn read_thread_uses_legacy_thread_name_when_sqlite_title_is_missing()
```

**Purpose**: Ensures that when no meaningful SQLite title exists, the legacy thread-name index is used as the thread name.

**Data flow**: Writes a session file, appends a legacy thread name entry, reads the thread, and asserts `thread.name` equals the legacy title.

**Call relations**: This test covers the fallback name lookup in rollout-based reads.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 4 external calls (new, from_u128, assert_eq!, append_thread_name).


##### `tests::read_thread_uses_sqlite_metadata_for_rollout_without_user_preview`  (lines 907–973)

```
async fn read_thread_uses_sqlite_metadata_for_rollout_without_user_preview()
```

**Purpose**: Verifies that when a rollout lacks a user preview, SQLite metadata remains the primary summary source while history still loads from the rollout.

**Data flow**: Creates a rollout containing only session meta, inserts SQLite metadata with title/provider/cwd/CLI version, reads with history enabled, and asserts the returned thread uses SQLite summary fields, empty preview, and one-item history.

**Call relations**: This test covers the branch where rollout overlay is skipped because the rollout summary has no preview.

*Call graph*: calls 5 internal fn (from_string, new, init, new, test_config); 9 external calls (new, now, from_u128, assert_eq!, format!, json!, create, create_dir_all, writeln!).


##### `tests::read_thread_falls_back_to_rollout_search_when_sqlite_path_is_stale`  (lines 976–1022)

```
async fn read_thread_falls_back_to_rollout_search_when_sqlite_path_is_stale()
```

**Purpose**: Checks that stale SQLite rollout paths do not block reads; the code falls back to searching actual rollout files by thread ID.

**Data flow**: Creates a real local rollout, inserts SQLite metadata pointing at a missing external path, reads with archived/history enabled, and asserts the returned thread uses the real rollout path, rollout preview, default provider, and loaded history.

**Call relations**: This test validates stale-path rejection via `sqlite_rollout_path_can_load_history_for_thread` and fallback through `resolve_rollout_path`.

*Call graph*: calls 6 internal fn (from_string, new, init, new, test_config, write_session_file); 4 external calls (new, now, from_u128, assert_eq!).


##### `tests::read_thread_falls_back_when_sqlite_path_points_to_another_thread`  (lines 1025–1069)

```
async fn read_thread_falls_back_when_sqlite_path_points_to_another_thread()
```

**Purpose**: Ensures that if SQLite metadata points to a rollout belonging to a different thread, the read path falls back to the correct rollout discovered by thread ID.

**Data flow**: Creates a real local rollout for one thread and a different external rollout for another thread, stores the wrong path in SQLite metadata, reads the original thread, and asserts the returned summary and history come from the correct local rollout.

**Call relations**: This test covers the thread-ID verification logic in `sqlite_rollout_path_can_load_history_for_thread`.

*Call graph*: calls 6 internal fn (from_string, new, init, new, test_config, write_session_file); 4 external calls (new, now, from_u128, assert_eq!).


##### `tests::read_thread_uses_session_meta_for_rollout_without_user_preview_or_sqlite_metadata`  (lines 1072–1122)

```
async fn read_thread_uses_session_meta_for_rollout_without_user_preview_or_sqlite_metadata()
```

**Purpose**: Verifies the legacy fallback path that reconstructs a thread solely from `session_meta` when no modern summary item or SQLite metadata exists.

**Data flow**: Writes a rollout containing only session meta, reads with history enabled, and asserts thread ID, rollout path, empty preview, absent name, provider, timestamps, cwd, CLI version, source, and one-item history.

**Call relations**: This test targets `stored_thread_from_session_meta` and `stored_thread_from_meta_line`.

*Call graph*: calls 3 internal fn (from_string, new, test_config); 9 external calls (new, from_u128, assert!, assert_eq!, format!, json!, create, create_dir_all, writeln!).


##### `tests::read_thread_falls_back_to_sqlite_summary`  (lines 1125–1184)

```
async fn read_thread_falls_back_to_sqlite_summary()
```

**Purpose**: Checks that when no rollout can be found but SQLite metadata exists, the read path still returns a summary from SQLite.

**Data flow**: Creates SQLite metadata pointing at an external rollout path without creating the file, reads without history, and asserts preview, first-user-message, provider, model, cwd, CLI version, source, archived state, and absent history come from SQLite.

**Call relations**: This test covers the SQLite-summary fallback branch in `read_thread` when history is not requested.

*Call graph*: calls 5 internal fn (from_string, new, init, new, test_config); 6 external calls (new, now, from_u128, assert!, assert_eq!, format!).


##### `tests::read_thread_sqlite_fallback_respects_include_archived`  (lines 1187–1241)

```
async fn read_thread_sqlite_fallback_respects_include_archived()
```

**Purpose**: Ensures SQLite-only fallback summaries still honor the caller's archived filter.

**Data flow**: Creates archived SQLite metadata without a usable rollout, performs an active-only read expecting an invalid-request message, then reads with `include_archived: true` and asserts preview and archived state.

**Call relations**: This test validates archived gating on the SQLite-first branch in `read_thread`.

*Call graph*: calls 5 internal fn (from_string, new, init, new, test_config); 7 external calls (new, now, from_u128, assert!, assert_eq!, format!, panic!).


##### `tests::read_thread_sqlite_fallback_loads_archived_history`  (lines 1244–1288)

```
async fn read_thread_sqlite_fallback_loads_archived_history()
```

**Purpose**: Checks that archived history can still be loaded when SQLite metadata points at an archived rollout and `include_archived` is true.

**Data flow**: Writes an archived rollout, inserts matching archived SQLite metadata, reads with history enabled and archived allowed, and asserts rollout path, preview, archived state, and two-item history.

**Call relations**: This test covers the SQLite-backed archived-history path in `read_thread`.

*Call graph*: calls 6 internal fn (from_string, new, init, new, test_config, write_archived_session_file); 5 external calls (new, now, from_u128, assert!, assert_eq!).


##### `tests::read_thread_fails_without_rollout`  (lines 1291–1313)

```
async fn read_thread_fails_without_rollout()
```

**Purpose**: Confirms that reading a nonexistent thread without usable SQLite fallback returns the expected invalid-request error.

**Data flow**: Creates an empty temp store, reads a fixed thread ID, captures the error, and asserts the message says no rollout was found for that thread ID.

**Call relations**: This test covers the terminal failure path in `read_thread` after rollout resolution returns `None`.

*Call graph*: calls 3 internal fn (from_string, new, test_config); 4 external calls (new, from_u128, assert_eq!, panic!).


### `thread-store/src/local/list_threads.rs`

`domain_logic` · `request handling`

This file turns `ListThreadsParams` into a `ThreadPage`. The top-level `list_threads` function first parses an optional opaque cursor string using rollout-library cursor parsing and maps store-level sort enums into rollout-library equivalents. It then builds a `RolloutConfig` from the local store configuration and delegates the actual page fetch to `list_rollout_threads`, which chooses among four rollout-recorder listing APIs depending on `archived` and `use_state_db_only`, or uses a dedicated state-DB query when filtering by `parent_thread_id`.

Once a rollout page is returned, the code serializes the next cursor back into the string form expected by callers, converts each `codex_rollout::ThreadItem` into a `StoredThread` via `stored_thread_from_rollout_item`, and then performs a second enrichment pass for names. It gathers all thread IDs in the page, queries SQLite metadata when available, and uses `distinct_thread_metadata_title` to keep only meaningful titles. If some threads still lack names, it falls back to legacy thread-name index files under `codex_home` via `find_thread_names_by_ids`. Finally, `set_thread_name_from_title` applies those titles without duplicating the preview text.

Important behavior: parent-filtered listing requires the state DB and fails internally if unavailable; archived listing sets `archived_at` through rollout-item conversion; and missing provider metadata in rollout files is replaced with the configured default provider.

#### Function details

##### `list_threads`  (lines 21–108)

```
async fn list_threads(
    store: &LocalThreadStore,
    params: ListThreadsParams,
) -> ThreadStoreResult<ThreadPage>
```

**Purpose**: Builds a paginated thread listing for the local store, converts rollout summaries into `StoredThread` values, and enriches them with names from SQLite titles or legacy name indexes. It also validates the incoming cursor string.

**Data flow**: Consumes `&LocalThreadStore` and `ListThreadsParams`; reads `params.cursor`, sort settings, archive/search/filter flags, `store.config`, and the optional state DB. It parses the cursor, constructs a `RolloutConfig`, calls `list_rollout_threads`, converts returned `ThreadItem`s with `stored_thread_from_rollout_item`, gathers thread IDs into a `HashSet`, fills a `HashMap<ThreadId, String>` from SQLite metadata and then legacy name files, mutates each `StoredThread` name via `set_thread_name_from_title`, and returns `ThreadPage { items, next_cursor }`.

**Call relations**: This is the main list implementation behind the store trait method. It delegates page retrieval to `list_rollout_threads` and uses helper functions to merge metadata-derived names into the final response.

*Call graph*: calls 4 internal fn (state_db, distinct_thread_metadata_title, set_thread_name_from_title, list_rollout_threads); called by 1 (list_threads); 2 external calls (with_capacity, find_thread_names_by_ids).


##### `list_rollout_threads`  (lines 110–209)

```
async fn list_rollout_threads(
    state_db: Option<codex_rollout::StateDbHandle>,
    config: &RolloutConfig,
    default_model_provider_id: &str,
    params: &ListThreadsParams,
    cursor: Option<&
```

**Purpose**: Selects the concrete rollout/state-DB listing backend based on parent filtering, archive mode, and `use_state_db_only`. It is the lower-level page fetcher shared by list and search flows.

**Data flow**: Takes an optional `StateDbHandle`, a `RolloutConfig`, default provider ID, original `ListThreadsParams`, optional parsed cursor, and rollout sort enums. If `params.parent_thread_id` is set, it queries `codex_rollout::state_db::list_threads_db`, converts the result into `ThreadsPage`, and stamps `parent_thread_id` onto each item. Otherwise it dispatches to one of `RolloutRecorder::list_archived_threads_from_state_db`, `list_threads_from_state_db`, `list_archived_threads`, or `list_threads`, then maps backend errors into `ThreadStoreError::Internal`.

**Call relations**: Called directly by `list_threads` and reused by `search_threads` to scan sorted thread pages while intersecting them with content-search matches. It centralizes backend selection so both callers share identical listing semantics.

*Call graph*: calls 5 internal fn (list_archived_threads, list_archived_threads_from_state_db, list_threads, list_threads_from_state_db, list_threads_db); called by 2 (list_threads, search_threads).


##### `tests::list_threads_uses_default_provider_when_rollout_omits_provider`  (lines 230–262)

```
async fn list_threads_uses_default_provider_when_rollout_omits_provider()
```

**Purpose**: Checks that listing fills in the configured default model provider when a rollout file lacks provider metadata.

**Data flow**: Creates a temp store, writes a session file with `model_provider` omitted, calls `store.list_threads(...)`, and asserts the single returned item's `model_provider` equals `test-provider`.

**Call relations**: This test exercises the conversion path through `stored_thread_from_rollout_item` as reached from `list_threads`.

*Call graph*: calls 3 internal fn (new, test_config, write_session_file_with); 4 external calls (new, from_u128, new, assert_eq!).


##### `tests::list_threads_preserves_sqlite_title_search_results`  (lines 265–330)

```
async fn list_threads_preserves_sqlite_title_search_results()
```

**Purpose**: Verifies that state-DB-only listing with a search term returns the matching thread and preserves the rollout preview/first-user-message rather than replacing it with the title.

**Data flow**: Initializes a state DB, inserts `ThreadMetadata` with a title containing the search term and a distinct preview/first message, calls `store.list_threads(...)` with `use_state_db_only: true` and `search_term: Some("needle")`, then asserts the returned thread ID and first-user-message.

**Call relations**: This test covers the state-DB listing branch in `list_rollout_threads` and the title-enrichment logic in `list_threads`.

*Call graph*: calls 5 internal fn (from_string, new, init, new, test_config); 6 external calls (new, now, from_u128, new, assert_eq!, write).


##### `tests::list_threads_selects_active_or_archived_collection`  (lines 333–400)

```
async fn list_threads_selects_active_or_archived_collection()
```

**Purpose**: Confirms that the `archived` flag selects the correct rollout collection and that archived results carry `archived_at` while active ones do not.

**Data flow**: Writes one active and one archived session file, performs two listings with `archived: false` and `archived: true`, converts UUIDs to `ThreadId`s, and asserts each page contains only the expected thread plus the expected `archived_at` values.

**Call relations**: This test validates the backend-selection branch in `list_rollout_threads` and the archived-state mapping performed by `stored_thread_from_rollout_item`.

*Call graph*: calls 5 internal fn (from_string, new, test_config, write_archived_session_file, write_session_file); 4 external calls (new, from_u128, new, assert_eq!).


##### `tests::list_threads_returns_local_rollout_summary`  (lines 403–441)

```
async fn list_threads_returns_local_rollout_summary()
```

**Purpose**: Checks that a normal local listing returns the expected summary fields extracted from a rollout file, including preview, rollout path, provider, CLI version, and source.

**Data flow**: Creates a temp store, writes a session file, calls `store.list_threads(...)` with source/provider filters, and asserts the returned page has one item with the expected thread ID and rollout-derived fields.

**Call relations**: This test exercises the standard non-archived, non-state-DB-only listing path end to end.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 4 external calls (new, from_u128, assert_eq!, vec!).


##### `tests::list_threads_rejects_invalid_cursor`  (lines 444–466)

```
async fn list_threads_rejects_invalid_cursor()
```

**Purpose**: Ensures that malformed cursor strings are rejected as invalid requests before any listing backend is queried.

**Data flow**: Creates a temp store, calls `store.list_threads(...)` with `cursor: Some("not-a-cursor")`, captures the error, and asserts it matches `ThreadStoreError::InvalidRequest`.

**Call relations**: This test targets the early cursor-parse validation branch in `list_threads`.

*Call graph*: calls 2 internal fn (new, test_config); 3 external calls (new, new, assert!).


### `thread-store/src/local/search_threads.rs`

`domain_logic` · `request handling`

This file layers full-text rollout search on top of the listing machinery. `search_threads` first validates that `search_term` is non-empty and parses the optional cursor string. It maps store sort enums into rollout-library equivalents, builds a `RolloutConfig`, and asks `InstallContext::current().rg_command()` for the ripgrep executable used by `search_rollout_matches`. That search returns a map keyed by logical rollout path, with optional precomputed snippets.

The function then scans sorted thread pages using `list_rollout_threads` rather than returning raw grep hits directly. This preserves the same ordering and filtering semantics as normal listing. To avoid too many round trips, it requests oversized scan pages (`page_size * 8`, clamped between 256 and 2048) and loops until it has enough matching items, exhausts the rollout-match set, or runs out of pages. For each listed thread item, it normalizes the path to the plain rollout path, checks whether that path is in the remaining match map, and either uses the stored snippet or lazily computes one with `first_rollout_content_match_snippet`.

After truncating to the requested page size, it derives the next cursor from the last retained item's created/updated timestamp, converts each `ThreadItem` into a `StoredThreadSearchResult`, and enriches names exactly like listing does: SQLite titles first, then legacy name-index entries, with redundant titles suppressed. The result is a search page that is content-filtered but still sorted and shaped like normal thread summaries.

#### Function details

##### `search_threads`  (lines 31–169)

```
async fn search_threads(
    store: &LocalThreadStore,
    params: SearchThreadsParams,
) -> ThreadStoreResult<ThreadSearchPage>
```

**Purpose**: Searches rollout contents for a term, intersects those matches with sorted thread listings, and returns paginated `StoredThreadSearchResult` values with snippets. It rejects empty search terms and malformed cursors.

**Data flow**: Consumes `&LocalThreadStore` and `SearchThreadsParams`; reads `search_term`, cursor, sort settings, archive flag, allowed sources, and store config/state DB. It validates the term, parses the cursor, builds a `RolloutConfig`, gets the ripgrep command from `InstallContext::current()`, calls `search_rollout_matches`, then repeatedly calls `list_rollout_threads` with oversized scan params. For each listed item it normalizes the path with `plain_rollout_path`, looks up/removes a snippet from the remaining match map or computes one with `first_rollout_content_match_snippet`, accumulates `ThreadSearchItem`s, truncates to `page_size`, derives `next_cursor`, converts items with `stored_thread_from_rollout_item`, enriches names via `set_thread_search_result_names`, and returns `ThreadSearchPage`.

**Call relations**: This is the store's search implementation. It delegates content matching to rollout-library grep helpers, ordering/filtering to `list_rollout_threads`, and final name enrichment to `set_thread_search_result_names`.

*Call graph*: calls 4 internal fn (current, state_db, list_rollout_threads, set_thread_search_result_names); called by 1 (search_threads); 4 external calls (new, first_rollout_content_match_snippet, plain_rollout_path, search_rollout_matches).


##### `cursor_from_thread_search_item`  (lines 171–184)

```
fn cursor_from_thread_search_item(
    item: &ThreadSearchItem,
    sort_key: ThreadSortKey,
) -> Option<codex_rollout::Cursor>
```

**Purpose**: Derives a rollout cursor from a matched thread item using the timestamp field appropriate for the requested sort key. It returns `None` when the necessary timestamp is missing or unparsable.

**Data flow**: Takes a `ThreadSearchItem` reference and `ThreadSortKey`; selects `item.item.created_at` for created-time sorting or `updated_at` falling back to `created_at` for updated-time sorting, then parses that timestamp string with `parse_cursor` and returns the resulting optional cursor.

**Call relations**: Used only by `search_threads` when constructing the next-page cursor after truncating matched results.

*Call graph*: 1 external calls (parse_cursor).


##### `set_thread_search_result_names`  (lines 186–218)

```
async fn set_thread_search_result_names(
    store: &LocalThreadStore,
    items: &mut [StoredThreadSearchResult],
)
```

**Purpose**: Enriches search results with thread names from SQLite titles or legacy name-index entries, suppressing redundant names that duplicate previews. It mirrors the naming logic used by normal listing.

**Data flow**: Mutably borrows a slice of `StoredThreadSearchResult`, gathers their thread IDs into a `HashSet`, allocates a `HashMap<ThreadId, String>`, fills it from SQLite metadata using `distinct_thread_metadata_title`, falls back to `find_thread_names_by_ids` for missing names, then mutates each result's `thread` via `set_thread_name_from_title` when a title is available.

**Call relations**: Called at the end of `search_threads` so search results present the same naming behavior as list results.

*Call graph*: calls 3 internal fn (state_db, distinct_thread_metadata_title, set_thread_name_from_title); called by 1 (search_threads); 3 external calls (with_capacity, find_thread_names_by_ids, iter).


### `thread-store/src/local/delete_thread.rs`

`domain_logic` · `request handling`

This file performs destructive local thread removal against the filesystem-backed rollout store. The main async path first derives the target thread ID string, fetches the optional state DB handle from `LocalThreadStore`, and asks rollout lookup helpers for both active and archived rollout locations. It accumulates any discovered paths, deduplicating the archived result if it resolves to the same file as the active lookup. Lookup failures are surfaced as `ThreadStoreError::InvalidRequest` with thread-specific context, while absence of both active and archived rollouts becomes `ThreadStoreError::ThreadNotFound` only after cleanup attempts complete.

For each discovered rollout, deletion is delegated through a two-step helper chain. `delete_rollout_file` normalizes to the plain `.jsonl` path and also targets the sibling `.jsonl.zst` compressed variant, deleting either or both. `delete_rollout_path` enforces path safety by canonicalizing the candidate under either `sessions` or `archived sessions`, tolerates a path that vanished before canonicalization by treating it as already deleted, verifies the filename suffix matches the requested `ThreadId`, and then removes the file. After all rollout files are gone, the code removes legacy thread-name index entries under `codex_home`; only then does it clear any in-memory live recorder entry for the thread. A key invariant is that success means all discovered rollout artifacts and name-index entries are gone, but SQLite cleanup is intentionally left to higher layers.

#### Function details

##### `delete_thread`  (lines 23–85)

```
async fn delete_thread(
    store: &LocalThreadStore,
    params: DeleteThreadParams,
) -> ThreadStoreResult<()>
```

**Purpose**: Deletes every persisted rollout file associated with a thread ID, including active and archived copies, then removes legacy thread-name index entries and drops any live recorder entry. It reports `ThreadNotFound` only when no rollout path was found in either collection.

**Data flow**: Takes a `&LocalThreadStore` and `DeleteThreadParams`; reads `params.thread_id`, `store.config.codex_home`, the optional state DB via `store.state_db().await`, and the `live_recorders` map. It resolves active and archived rollout paths, collects them into a vector, invokes `delete_rollout_file` for each path, then calls `remove_thread_name_entries` under `codex_home`. On success it removes the thread from `store.live_recorders`; on failure it returns a `ThreadStoreError` describing lookup, deletion, or index-removal failure.

**Call relations**: This is the local implementation behind the store-level delete operation. It is invoked from the higher-level `ThreadStore` method path and orchestrates the whole delete flow, delegating actual file removal to `delete_rollout_file` and relying on rollout-library lookup/index helpers to discover files and erase legacy name entries.

*Call graph*: calls 2 internal fn (state_db, delete_rollout_file); called by 1 (delete_thread); 5 external calls (new, find_archived_thread_path_by_id_str, find_thread_path_by_id_str, remove_thread_name_entries, format!).


##### `delete_rollout_file`  (lines 87–97)

```
fn delete_rollout_file(
    store: &LocalThreadStore,
    rollout_path: &Path,
    thread_id: codex_protocol::ThreadId,
) -> ThreadStoreResult<bool>
```

**Purpose**: Deletes both the logical plain rollout path and its compressed `.jsonl.zst` sibling for a single discovered rollout. It returns whether either variant was actually removed.

**Data flow**: Accepts the store, a rollout path, and the expected `ThreadId`. It converts the supplied path to the plain rollout path with `codex_rollout::plain_rollout_path`, derives the compressed sibling by changing the extension to `jsonl.zst`, calls `delete_rollout_path` on both, and returns `true` if either call deleted a file.

**Call relations**: Called once per discovered rollout by `delete_thread`. It exists to centralize the dual-path deletion rule so the top-level delete logic does not need to know whether the persisted artifact is plain, compressed, or both.

*Call graph*: calls 1 internal fn (delete_rollout_path); called by 1 (delete_thread); 1 external calls (plain_rollout_path).


##### `delete_rollout_path`  (lines 99–131)

```
fn delete_rollout_path(
    store: &LocalThreadStore,
    rollout_path: &Path,
    thread_id: codex_protocol::ThreadId,
) -> ThreadStoreResult<bool>
```

**Purpose**: Validates that a candidate rollout file is scoped under the allowed sessions roots, confirms its filename matches the requested thread ID, and removes the file while treating `NotFound` as already deleted. This is the safety-critical filesystem deletion primitive in the file.

**Data flow**: Receives the store, a concrete path candidate, and the expected `ThreadId`. It reads `store.config.codex_home`, tries to canonicalize the path under `sessions` first and `archived sessions` second via `scoped_rollout_path`, falls back to the original path only when `try_exists` says the file is already gone, validates the basename with `matching_rollout_file_name`, then calls `std::fs::remove_file`. It returns `Ok(true)` when a file was removed, `Ok(false)` when it was already absent, or a `ThreadStoreError` for invalid scope/name or I/O failure.

**Call relations**: Used only by `delete_rollout_file`. It encapsulates the path-validation and deletion semantics so the caller can safely attempt deletion of both plain and compressed variants without duplicating security checks.

*Call graph*: calls 2 internal fn (matching_rollout_file_name, scoped_rollout_path); called by 1 (delete_rollout_file); 2 external calls (format!, remove_file).


##### `tests::delete_thread_removes_active_and_archived_rollouts`  (lines 148–179)

```
async fn delete_thread_removes_active_and_archived_rollouts()
```

**Purpose**: Verifies that deleting a thread removes rollout files from both active and archived collections, and also removes a compressed sibling when present for an active rollout.

**Data flow**: Builds a temporary `LocalThreadStore`, writes one active session file plus a `.jsonl.zst` sibling and one archived session file, converts UUIDs into `ThreadId`s, invokes `store.delete_thread(...)`, and asserts the corresponding files no longer exist.

**Call relations**: This test exercises the full top-level delete path and indirectly covers both rollout discovery branches and the compressed-sibling behavior delegated through `delete_rollout_file`.

*Call graph*: calls 5 internal fn (from_string, new, test_config, write_archived_session_file, write_session_file); 4 external calls (new, from_u128, assert!, write).


##### `tests::delete_rollout_file_treats_vanished_path_as_already_deleted`  (lines 182–192)

```
async fn delete_rollout_file_treats_vanished_path_as_already_deleted()
```

**Purpose**: Checks that deleting a rollout path that disappeared after discovery returns success with `false` rather than failing. This pins the retry-friendly semantics described in the module docs.

**Data flow**: Creates a temp store and session file, removes the file manually, then calls `delete_rollout_file` with the stale path and asserts the returned boolean is `false`.

**Call relations**: This test targets the lower-level helper directly, specifically the `try_exists`/`NotFound` path inside `delete_rollout_path` as reached through `delete_rollout_file`.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 4 external calls (new, from_u128, assert!, remove_file).


##### `tests::delete_thread_reports_missing_thread`  (lines 195–209)

```
async fn delete_thread_reports_missing_thread()
```

**Purpose**: Confirms that deleting a thread with no active or archived rollout produces the user-facing not-found error.

**Data flow**: Creates an empty temp store, parses a fixed `ThreadId`, calls `store.delete_thread(...)`, captures the error, and compares its string form to the expected not-found message.

**Call relations**: This test covers the top-level branch in `delete_thread` where no rollout paths are discovered and the function returns `ThreadStoreError::ThreadNotFound` after cleanup attempts.

*Call graph*: calls 3 internal fn (from_string, new, test_config); 2 external calls (new, assert_eq!).
