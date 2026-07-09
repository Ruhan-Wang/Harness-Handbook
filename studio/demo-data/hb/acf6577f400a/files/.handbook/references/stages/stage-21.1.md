# Rollout files and thread-store persistence  `stage-21.1`

This stage is the system’s local memory for conversations. It runs behind the scenes during normal use, so chats can be resumed, listed, searched, archived, or deleted later. The rollout files are the raw diary: recorder.rs writes each session as JSON Lines, meaning one JSON record per line, while compression.rs can read old diaries even after they are packed into smaller .zst files. list.rs, search.rs, and session_index.rs help find those diaries by time, thread ID, name, or text match. core/src/rollout.rs and rollout/src/lib.rs make these tools easy for the rest of the app to reach.

The thread-store layer is the cleaner front desk on top of those files. store.rs defines the shared “save, read, list, update, archive, delete” contract, error.rs defines common failure messages, and lib.rs exports it all. The local store ties rollout logs, optional SQLite metadata, and live writers together. Its helpers validate paths and convert old metadata. live_writer.rs keeps active chats being saved, read_thread.rs rebuilds a thread, list_threads.rs and search_threads.rs support browsing, and delete_thread.rs removes saved files. message-history separately stores the user’s global prompt history safely across processes.

## Files in this stage

### Rollout crate surface
These files define the rollout subsystem’s public API and bridge the main application configuration into rollout-specific types and helpers.

### `core/src/rollout.rs`

`orchestration` · `cross-cutting during session recording, listing, and rollout setup`

A “rollout” here is the saved record of a Codex session or thread: where it lives on disk, how it is named, how it is listed, and what metadata belongs to it. Most of that work lives in the separate `codex_rollout` crate. This file makes that crate feel like part of `core` by publicly re-exporting its important types and helper functions.

The one piece of real behavior in this file is an adapter between two worlds. The rollout crate expects something that implements `RolloutConfigView`, which is a small read-only view of the settings it needs. The main application already has a broader `Config` type. This file teaches `Config` how to answer the rollout crate’s specific questions: where the Codex home folder is, where SQLite data lives, what the current working directory is, which model provider is being used, and whether memory generation is enabled.

An everyday analogy: the rollout crate asks for a short checklist, while `Config` is a full binder of settings. This file marks the binder pages that answer the checklist. Without it, session recording and thread listing code would either not compile or would need to know too much about the full application configuration.

#### Function details

##### `Config::codex_home`  (lines 27–29)

```
fn codex_home(&self) -> &std::path::Path
```

**Purpose**: This gives the rollout code the main Codex home folder. That folder is the base place where session and thread files can be found or stored.

**Data flow**: It starts with a `Config` object that already contains a `codex_home` path. The function borrows that path as a plain filesystem path and returns it without changing anything.

**Call relations**: The rollout crate calls this through the `RolloutConfigView` interface when it needs to locate Codex-owned files. This method does not hand work off to any other function; it simply exposes the right field from `Config`.


##### `Config::sqlite_home`  (lines 31–33)

```
fn sqlite_home(&self) -> &std::path::Path
```

**Purpose**: This tells the rollout code where the application’s SQLite-related storage lives. SQLite is a small file-based database, so this path points rollout features toward the right data area.

**Data flow**: It receives the existing `Config`, reads its `sqlite_home` path, converts it to a borrowed filesystem path, and returns that reference. No files are opened and no setting is changed.

**Call relations**: The rollout crate reaches this method through the shared configuration view when it needs database-location information. The method is a direct adapter from the core `Config` field to the rollout crate’s expected shape.


##### `Config::cwd`  (lines 35–37)

```
fn cwd(&self) -> &std::path::Path
```

**Purpose**: This provides the rollout code with the current working directory saved in the configuration. That helps session records know the project or folder context they belong to.

**Data flow**: It takes the `Config`, reads the stored `cwd` path, and returns it as a borrowed filesystem path. The before-and-after state is the same; the function only shares information.

**Call relations**: When rollout-related code needs the working directory, it asks through `RolloutConfigView`, and this method supplies the answer from `Config`. It does not call other code or perform any disk access itself.


##### `Config::model_provider_id`  (lines 39–41)

```
fn model_provider_id(&self) -> &str
```

**Purpose**: This tells the rollout code which model provider is configured, as a short text identifier. That can be useful metadata for recording or organizing sessions.

**Data flow**: It reads the `model_provider_id` string stored in `Config`, borrows it as plain text, and returns that borrowed text. Nothing is copied into a new owned value and nothing is modified.

**Call relations**: Rollout code calls this through the configuration-view trait when it needs provider information. This method is only the connector; any later use of the provider id happens inside the rollout crate.


##### `Config::generate_memories`  (lines 43–45)

```
fn generate_memories(&self) -> bool
```

**Purpose**: This tells the rollout code whether memory generation is turned on. In plain terms, it answers whether the system should create saved memory information from sessions when that feature is enabled.

**Data flow**: It receives `Config`, looks inside the nested `memories` settings, reads the `generate_memories` true-or-false value, and returns that value. It does not start memory generation by itself.

**Call relations**: Rollout-related code asks this question through `RolloutConfigView` when deciding how to behave around session metadata and memory-related features. This method only reports the configured choice; other parts of the system act on it.


### `rollout/src/lib.rs`

`other` · `cross-cutting`

A “rollout” here is the saved record of a Codex session: the conversation, metadata, and related state written to disk so it can be reopened, searched, archived, or indexed later. This file does not do the storage work itself. Instead, it acts like a reception desk: it names the important rooms in the library and re-exports the tools callers are expected to use.

It declares the internal modules for compression, configuration, listing sessions, metadata, persistence policy, recording, searching, session indexes, metrics, and the state database. It also defines shared folder names, such as `sessions` and `archived_sessions`, so the rest of the codebase uses the same directory names instead of hard-coding them in many places.

One important shared value is `INTERACTIVE_SESSION_SOURCES`, a lazily created list of session origins that count as interactive user sessions, such as the command line, VS Code, and selected custom clients. “Lazy” means the list is built only when first needed, like opening a toolbox only when someone reaches for it.

Most of the file is public exports. These make items from deeper modules available through the rollout crate’s main namespace, including readers, recorders, search helpers, list types, session metadata, and database handles. Without this file, callers would need to know much more about the crate’s internal structure, and shared constants or public APIs could easily become inconsistent.


### Rollout storage primitives
These files provide the low-level persistence mechanisms for rollout files, sidecar naming indexes, global message history, and text search over stored transcripts.

### `message-history/src/lib.rs`

`io_transport` · `cross-cutting`

This file is the persistence layer for Codex message history: it turns chat messages into durable records on disk, and later lets the app count or retrieve those records. The history file lives under the Codex home directory as `history.jsonl`, where each line is one complete JSON object. That format is like a notebook where every message gets its own row, making it easy to append new rows without rewriting the whole notebook.

The main job is safe appending. When `append_entry` is asked to save a message, it first checks whether history saving is enabled. It then creates the history directory if needed, builds a record containing the conversation ID, timestamp, and text, and writes that whole record as one line. Before writing, it takes a file lock, which is a “please wait your turn” signal for other processes. This prevents two terminal windows from writing at the same time and corrupting the file.

The file also protects privacy and storage. On Unix systems it forces the history file to be readable and writable only by the owner. If a maximum file size is configured, it trims old lines after a write, while keeping the newest entry. Finally, it provides lightweight lookup tools: one function reports the file’s identity and line count, and another finds a specific entry by line number only if the file is still the same file.

#### Function details

##### `HistoryConfig::new`  (lines 70–76)

```
fn new(codex_home: impl Into<PathBuf>, history: &History) -> Self
```

**Purpose**: Builds the small configuration object this history layer needs. It pulls the Codex home folder, the persistence choice, and the optional size limit into one place.

**Data flow**: It receives a Codex home path and a broader history configuration. It converts the home path into a stored path value, copies the setting that says whether to save history, and copies the optional maximum byte size. The result is a `HistoryConfig` that other functions can use without needing the larger configuration object.

**Call relations**: Other parts of the application and tests create this before saving, reading, or describing history. Once created, it is handed to functions like `append_entry`, `history_metadata`, and `lookup` so they all agree on where the history file is and how it should behave.

*Call graph*: called by 6 (append_entry_trims_history_to_soft_cap, append_entry_trims_history_when_beyond_max_bytes, append_message_history_entry, lookup_message_history_entry, session_configured_populates_history_metadata, thread_session_state_from_thread_response); 1 external calls (into).


##### `history_filepath`  (lines 79–81)

```
fn history_filepath(config: &HistoryConfig) -> PathBuf
```

**Purpose**: Calculates the exact path to the history file. It keeps the filename rule in one place: the file is always named `history.jsonl` inside the configured Codex home directory.

**Data flow**: It receives a `HistoryConfig`, reads its `codex_home` path, appends the fixed history filename, and returns the full path. It does not touch the disk.

**Call relations**: This is the shared path builder used by `append_entry`, `history_metadata`, and `lookup`. Those higher-level functions ask it where the file should be before they create, scan, or open the history file.

*Call graph*: called by 3 (append_entry, history_metadata, lookup).


##### `append_entry`  (lines 98–183)

```
async fn append_entry(
    text: &str,
    conversation_id: impl std::fmt::Display,
    config: &HistoryConfig,
) -> Result<()>
```

**Purpose**: Adds one message to the history file, if history saving is enabled. It is careful about concurrent writes, file permissions, timestamps, and optional size limits.

**Data flow**: It receives the message text, a conversation ID, and the history configuration. If persistence is disabled, it exits without changing anything. Otherwise it creates the history directory, records the current Unix timestamp, turns the message into one JSON line, opens or creates the file, fixes permissions where needed, and then writes the line while holding an exclusive file lock. After writing, it may trim older entries if the file is too large. It returns success or an input/output error.

**Call relations**: This is the main write path for message history. It uses `history_filepath` to find the file, `ensure_owner_only_permissions` to keep the file private, and a blocking worker thread so file locking and writing do not freeze the async runtime. While locked, it hands off to `enforce_history_limit` to keep the file within the configured size.

*Call graph*: calls 2 internal fn (ensure_owner_only_permissions, history_filepath); 6 external calls (to_string, new, to_string, now, create_dir_all, spawn_blocking).


##### `enforce_history_limit`  (lines 189–262)

```
fn enforce_history_limit(file: &mut File, max_bytes: Option<usize>) -> Result<()>
```

**Purpose**: Keeps the history file from growing past its configured maximum size. When the file is too large, it removes older lines while preserving the newest entry.

**Data flow**: It receives an already-open history file and an optional byte limit. If there is no limit, the limit is zero, or the current file is small enough, it changes nothing. If the file is too large, it measures each line, decides how much old content to drop, reads the remaining tail, truncates the file to empty, writes the tail back, and flushes it to disk.

**Call relations**: It is called from `append_entry` after a new message has been written and while the write lock is still held. It calls `trim_target_bytes` to choose a practical target size, so the file is trimmed below the hard cap rather than barely under it.

*Call graph*: calls 1 internal fn (trim_target_bytes); 13 external calls (new, flush, metadata, seek, set_len, try_clone, write_all, Start, new, new (+3 more)).


##### `trim_target_bytes`  (lines 264–270)

```
fn trim_target_bytes(max_bytes: u64, newest_entry_len: u64) -> u64
```

**Purpose**: Chooses the target size to trim the history file down to. It aims for a softer limit below the maximum so the next append does not immediately need another trim.

**Data flow**: It receives the configured maximum size and the byte length of the newest entry. It computes 80 percent of the maximum, keeps that value within a sensible range, and then makes sure the target is at least large enough to hold the newest entry. It returns the target byte count.

**Call relations**: This is a helper for `enforce_history_limit`. The trimming code uses its result to decide how many old lines to remove while still keeping the latest message.

*Call graph*: called by 1 (enforce_history_limit).


##### `history_metadata`  (lines 279–282)

```
async fn history_metadata(config: &HistoryConfig) -> (u64, usize)
```

**Purpose**: Reports basic information about the current history file: a file identity number and how many entries it appears to contain. This helps callers know whether a displayed history list still matches the file on disk.

**Data flow**: It receives the history configuration, turns it into the history file path, and asks `history_metadata_for_file` to inspect that file. It returns a pair: the file identity and the number of newline-terminated records found.

**Call relations**: This is the public, configuration-based wrapper for metadata lookup. It uses `history_filepath` for the standard location, then delegates the actual disk reading to `history_metadata_for_file`.

*Call graph*: calls 2 internal fn (history_filepath, history_metadata_for_file).


##### `lookup`  (lines 294–297)

```
fn lookup(log_id: u64, offset: usize, config: &HistoryConfig) -> Option<HistoryEntry>
```

**Purpose**: Finds one saved history entry by its line number, but only if the history file still matches the expected identity. This avoids reading from a different or replaced history file by mistake.

**Data flow**: It receives an expected file identity, a zero-based line offset, and the history configuration. It builds the history file path and asks `lookup_history_entry` to open, lock, verify, scan, and parse the requested line. It returns the entry if everything matches, or `None` if anything fails.

**Call relations**: This is the public lookup wrapper used by callers that know the configuration but should not care about file paths. It relies on `history_filepath` for location and `lookup_history_entry` for the careful read-and-parse work.

*Call graph*: calls 2 internal fn (history_filepath, lookup_history_entry).


##### `ensure_owner_only_permissions`  (lines 317–319)

```
async fn ensure_owner_only_permissions(_file: &File) -> Result<()>
```

**Purpose**: Makes the history file private to the current user where the operating system supports that permission model. On Unix, it enforces `rw-------`, meaning only the owner can read or write the file; on Windows, it does nothing and succeeds.

**Data flow**: It receives an open file. On Unix, it reads the file’s current permission bits, and if they are not owner-only, it clones the file handle and changes the permissions on a blocking worker thread. It returns success or an input/output error.

**Call relations**: It is called by `append_entry` after the history file is opened and before the message is written. This places the privacy check directly in the save path, so newly created or previously loose files are corrected during normal use.

*Call graph*: called by 1 (append_entry); 3 external calls (metadata, try_clone, spawn_blocking).


##### `history_metadata_for_file`  (lines 321–348)

```
async fn history_metadata_for_file(path: &Path) -> (u64, usize)
```

**Purpose**: Inspects a specific history file path and returns its identity plus an entry count. It is designed to fail gently: missing or unreadable files produce safe default values instead of crashing the caller.

**Data flow**: It receives a file path. It first reads metadata and extracts a platform-specific identity using `log_identity`; if that fails, it returns `(0, 0)`. If metadata succeeds, it opens the file and reads it in chunks, counting newline bytes because each line is one history entry. It returns the identity and count, or the identity with count zero if scanning fails.

**Call relations**: It does the real work behind `history_metadata`. It calls `log_identity` to label the file and uses efficient byte scanning to count entries without parsing every JSON record.

*Call graph*: calls 1 internal fn (log_identity); called by 1 (history_metadata); 3 external calls (open, metadata, memchr_iter).


##### `lookup_history_entry`  (lines 350–417)

```
fn lookup_history_entry(path: &Path, log_id: u64, offset: usize) -> Option<HistoryEntry>
```

**Purpose**: Reads one line from a specific history file and turns it back into a `HistoryEntry`. It checks the file identity first and uses a shared read lock so it does not read while another process is rewriting the file.

**Data flow**: It receives a path, an expected file identity, and a line offset. It opens the file, reads its metadata, gets the current identity, and stops if it does not match the expected one. It then repeatedly tries to take a shared lock, scans lines until it reaches the requested offset, parses that JSON line into a `HistoryEntry`, and returns it. If opening, locking, reading, matching, or parsing fails, it logs a warning where useful and returns `None`.

**Call relations**: It is called by the public `lookup` function. It uses `log_identity` to avoid stale lookups, waits briefly and retries when another process holds the lock, and performs the final JSON parsing only for the requested line.

*Call graph*: calls 1 internal fn (log_identity); called by 1 (lookup); 4 external calls (new, new, sleep, warn!).


##### `log_identity`  (lines 432–434)

```
fn log_identity(_metadata: &std::fs::Metadata) -> Option<u64>
```

**Purpose**: Extracts a stable-ish identity number for the history file from its filesystem metadata. This lets the code tell whether the file being read is the same file that was counted earlier.

**Data flow**: It receives file metadata. On Unix it returns the inode number, which is the filesystem’s internal file number. On Windows it returns the file creation time. On other platforms it returns no identity. The output is an optional number.

**Call relations**: Both `history_metadata_for_file` and `lookup_history_entry` use this helper. The metadata path records the identity, and the lookup path compares against it before trusting a requested line offset.

*Call graph*: called by 2 (history_metadata_for_file, lookup_history_entry); 2 external calls (creation_time, ino).


### `rollout/src/compression.rs`

`io_transport` · `startup background work, rollout read, rollout append, maintenance cleanup`

Rollout files are append-only history files stored as `.jsonl`, meaning one JSON record per line. Old files can take up space, so this file compresses “cold” rollout files, which are files that have not changed for at least a week. Think of it like moving old paperwork into vacuum-sealed bags: it saves space, but the system must still be able to read it when needed.

The file has three main jobs. First, it finds the right physical file for a rollout: if both plain and compressed versions exist, the plain `.jsonl` file wins because it is easier to append to. Second, it provides `RolloutLineReader`, which reads lines from either plain files or compressed `.jsonl.zst` files through the same simple interface. Third, it runs a background worker that scans session folders, compresses old plain rollout files, verifies the compressed copy, preserves timestamps and permissions, and only deletes the original if the file did not change during compression.

The code is careful about races. If another part of the program appends to a rollout while compression is happening, compression backs off instead of risking data loss. A marker file prevents overlapping compression runs. Temporary files are used for safe writes, and stale temporary files are later removed.

#### Function details

##### `spawn_rollout_compression_worker`  (lines 29–31)

```
fn spawn_rollout_compression_worker(codex_home: PathBuf)
```

**Purpose**: Starts the background job that looks for old local rollout files and compresses them. It is best-effort: if it cannot run, the main program should still continue.

**Data flow**: It receives the Codex home directory path → passes that path to the worker module → returns immediately without waiting for compression to finish.

**Call relations**: This is the public doorway into the compression worker. It delegates to `worker::spawn`, which starts the real asynchronous task when a Tokio runtime is available.

*Call graph*: 1 external calls (spawn).


##### `file_modified_time`  (lines 34–41)

```
async fn file_modified_time(path: &Path) -> io::Result<Option<time::OffsetDateTime>>
```

**Purpose**: Finds the last modified time for a rollout file, whether it currently exists as plain `.jsonl` or compressed `.jsonl.zst`. Callers use this when sorting or displaying rollout history.

**Data flow**: It receives a desired rollout path → asks which physical file actually exists → reads that file’s metadata → returns the modified timestamp, or `None` if neither version exists.

**Call relations**: Higher-level history code calls this when it needs timestamps. It relies on the path lookup helper so callers do not need to check both plain and compressed filenames themselves.

*Call graph*: called by 2 (file_modified_time, file_modified_time_utc); 2 external calls (existing_rollout_path, metadata).


##### `open_rollout_line_reader`  (lines 47–58)

```
async fn open_rollout_line_reader(path: &Path) -> io::Result<RolloutLineReader>
```

**Purpose**: Opens a rollout file for line-by-line reading, hiding whether the file is compressed. It also retries briefly if the file is being switched between plain and compressed forms.

**Data flow**: It receives a rollout path → tries to open the existing plain or compressed file → if the file briefly disappears, waits and retries → returns a `RolloutLineReader` or an error.

**Call relations**: Rollout loading, searching, and summary code call this when they need records. It delegates one open attempt to `reader::open_once` and adds retry behavior around it.

*Call graph*: called by 5 (read_head_for_summary, read_head_summary, load_rollout_items, first_rollout_content_match_snippet, rollout_contains); 2 external calls (open_once, sleep).


##### `compressed_rollout_path`  (lines 62–64)

```
fn compressed_rollout_path(path: &Path) -> PathBuf
```

**Purpose**: Builds the compressed filename for a rollout path. This is mainly exposed for tests.

**Data flow**: It receives a path → adds or preserves the `.zst` compressed suffix as needed → returns the compressed path.

**Call relations**: It is a thin wrapper around the internal path helper, used where code needs the expected `.jsonl.zst` sibling path.

*Call graph*: called by 1 (existing_rollout_path); 1 external calls (compressed_rollout_path).


##### `materialize_rollout_for_append`  (lines 67–72)

```
async fn materialize_rollout_for_append(path: &Path) -> io::Result<PathBuf>
```

**Purpose**: Makes sure a rollout is available as a plain `.jsonl` file before asynchronous append code writes to it. If only a compressed copy exists, it decompresses it first.

**Data flow**: It receives a rollout path → moves blocking disk and decompression work onto a blocking thread → returns the plain path that append code should write to.

**Call relations**: Async append paths call this before writing. It hands the real work to `materialize_rollout_for_append_blocking` so the async runtime is not blocked by file I/O.

*Call graph*: called by 2 (new, append_rollout_item_to_path); 2 external calls (to_path_buf, spawn_blocking).


##### `materialize_rollout_for_append_blocking`  (lines 75–121)

```
fn materialize_rollout_for_append_blocking(path: &Path) -> io::Result<PathBuf>
```

**Purpose**: Restores a compressed rollout file back into a normal `.jsonl` file so new records can be appended. It avoids overwriting an existing plain file.

**Data flow**: It receives a plain or compressed rollout path → computes the plain path → if plain already exists, returns it → if only compressed exists, decompresses into a temporary file, safely installs it, removes the compressed copy, records metrics, and returns the plain path.

**Call relations**: Blocking append code calls this directly, while async append code reaches it through `materialize_rollout_for_append`. It uses path helpers, temporary-file helpers, and metric recording to make decompression safe and observable.

*Call graph*: calls 2 internal fn (plain_rollout_path, temp_path_for); called by 1 (open_log_file); 4 external calls (materialize, compressed_rollout_path, create_dir_all, remove_file).


##### `persist_temp_file_noclobber`  (lines 123–130)

```
fn persist_temp_file_noclobber(temp_path: &Path, destination: &Path) -> io::Result<()>
```

**Purpose**: Moves a temporary file into its final location without overwriting an existing file. This protects against races where another process creates the destination first.

**Data flow**: It receives a temporary path and destination → converts the temp path into a managed temporary-file object → tries to persist it only if the destination is absent → treats “already exists” as success.

**Call relations**: The materialization path uses this as a fallback when a hard link cannot be created. It is part of the safety net that prevents decompression from clobbering newer data.

*Call graph*: 2 external calls (persist_noclobber, try_from_path).


##### `plain_rollout_path`  (lines 133–135)

```
fn plain_rollout_path(path: &Path) -> PathBuf
```

**Purpose**: Returns the normal `.jsonl` path for a rollout, even if the input points at the compressed `.jsonl.zst` version.

**Data flow**: It receives a path → removes the compressed suffix if present → returns the plain path.

**Call relations**: Append, lookup, and sibling-check code use this to agree on the canonical uncompressed filename.

*Call graph*: called by 3 (materialize_rollout_for_append_blocking, existing_rollout_path, should_skip_compressed_sibling); 1 external calls (plain_rollout_path).


##### `parse_rollout_file_name`  (lines 138–140)

```
fn parse_rollout_file_name(name: &str) -> Option<&str>
```

**Purpose**: Checks whether a filename looks like a rollout file and returns its normal `.jsonl` name. It accepts both plain and compressed rollout names.

**Data flow**: It receives a filename string → strips `.zst` if present → verifies the rollout naming pattern → returns the plain filename or `None`.

**Call relations**: Directory scanning uses this through `RolloutFile::from_path` so non-rollout files are ignored.

*Call graph*: 1 external calls (parse_rollout_file_name).


##### `RolloutFile::from_path`  (lines 159–170)

```
fn from_path(path: PathBuf) -> Option<Self>
```

**Purpose**: Turns a discovered filesystem path into a logical rollout file entry. It filters out unrelated files and compressed duplicates hidden by an existing plain file.

**Data flow**: It receives a path found during directory walking → reads its filename → parses it as a rollout name → skips compressed siblings when a plain version exists → returns a `RolloutFile` with both physical path and canonical plain filename.

**Call relations**: Compression scanning and rollout discovery code call this so they all follow the same plain-versus-compressed rules.

*Call graph*: called by 7 (compress_rollouts_in_root, collect_flat_files_by_updated_at, collect_flat_rollout_files, find_rollout_path_by_id_from_filenames, collect_rollout_paths, scan_compressed_rollout_matches, scan_rollout_matches); 4 external calls (as_path, file_name, parse_rollout_file_name, should_skip_compressed_sibling).


##### `RolloutFile::path`  (lines 173–175)

```
fn path(&self) -> &Path
```

**Purpose**: Returns the actual path on disk that should be opened for reading. That path may point to either a plain or compressed file.

**Data flow**: It reads the stored physical path inside the `RolloutFile` → returns it as a borrowed path.

**Call relations**: Callers that need to open the discovered file use this accessor instead of reaching into the struct.

*Call graph*: 1 external calls (as_path).


##### `RolloutFile::plain_file_name`  (lines 178–180)

```
fn plain_file_name(&self) -> &str
```

**Purpose**: Returns the canonical plain `.jsonl` filename for the rollout. This is useful for parsing rollout IDs or timestamps consistently.

**Data flow**: It reads the stored plain filename string → returns it as text.

**Call relations**: Discovery and listing code can use this even when the physical file is compressed, so naming logic stays consistent.


##### `RolloutFile::is_compressed`  (lines 183–185)

```
fn is_compressed(&self) -> bool
```

**Purpose**: Tells whether this discovered rollout file is stored in compressed form.

**Data flow**: It reads the stored physical path → checks whether its filename ends like a compressed rollout → returns true or false.

**Call relations**: The compression worker uses this to skip files that are already compressed.

*Call graph*: 2 external calls (as_path, is_compressed_rollout_path).


##### `RolloutFile::into_path`  (lines 188–190)

```
fn into_path(self) -> PathBuf
```

**Purpose**: Consumes a `RolloutFile` and returns its physical path. This is used when ownership of the path needs to move into another task.

**Data flow**: It takes the whole `RolloutFile` → extracts the stored path → returns that path.

**Call relations**: The compression worker uses this before spawning blocking compression jobs, because those jobs need to own the path they work on.


##### `RolloutLineReader::next_line`  (lines 205–220)

```
async fn next_line(&mut self) -> io::Result<Option<String>>
```

**Purpose**: Reads the next record from a rollout file, whether the file is plain or compressed. It gives callers one simple async method for both cases.

**Data flow**: It reads from the inner reader → for plain files, awaits the async line reader → for compressed files, runs the blocking decompression read on a blocking thread → returns the next line, `None` at end of file, or an error.

**Call relations**: Any code that got a reader from `open_rollout_line_reader` calls this repeatedly. It bridges async callers with compressed reads that must happen through blocking I/O.

*Call graph*: 2 external calls (other, spawn_blocking).


##### `worker::CompressionRunMarker::try_claim`  (lines 274–302)

```
fn try_claim(codex_home: &Path) -> io::Result<Option<Self>>
```

**Purpose**: Tries to claim permission to run the compression worker for this local store. It prevents two compression runs from working on the same files at the same time.

**Data flow**: It receives the Codex home directory → creates a `.tmp` marker location → tries to create a lock file → if an old marker is stale, removes it and retries → returns a marker object, `None` if another run is active, or an error.

**Call relations**: `worker::run` calls this at the start. If no marker is claimed, the worker exits early instead of overlapping another run.

*Call graph*: 6 external calls (join, new, create_run_marker_file, create_dir_all, metadata, remove_file).


##### `worker::CompressionRunMarker::new`  (lines 304–309)

```
fn new(path: PathBuf) -> Self
```

**Purpose**: Creates a marker object that will remove its marker file when dropped. This represents an active compression run.

**Data flow**: It receives the marker file path → stores it with `remove_on_drop` set to true → returns the marker object.

**Call relations**: `try_claim` uses this after successfully creating the marker file.


##### `worker::CompressionRunMarker::persist`  (lines 311–313)

```
fn persist(mut self)
```

**Purpose**: Leaves the marker file behind after a successful run. This records that compression ran recently, so another run will not start too soon.

**Data flow**: It receives the marker object by value → flips its cleanup flag off → when the object is dropped, the file remains.

**Call relations**: `worker::run` calls this only after finishing successfully. Failed or interrupted runs do not persist the marker.


##### `worker::CompressionRunMarker::drop`  (lines 317–321)

```
fn drop(&mut self)
```

**Purpose**: Cleans up the run marker file when a compression run did not finish in the normal persisted state.

**Data flow**: When the marker object goes out of scope → checks whether it should remove the marker → deletes the marker file if needed and ignores cleanup errors.

**Call relations**: This is automatic cleanup tied to `CompressionRunMarker`. It supports `try_claim` and `run` by releasing the claim on failures.

*Call graph*: 2 external calls (as_path, remove_file).


##### `worker::spawn`  (lines 324–341)

```
fn spawn(codex_home: PathBuf)
```

**Purpose**: Starts the compression worker on the current Tokio runtime, if one exists. Tokio is the async task system used by this Rust program.

**Data flow**: It receives the Codex home path → checks for a current async runtime → if missing, records a skipped run and logs a warning → otherwise spawns `run` as a background task.

**Call relations**: The public `spawn_rollout_compression_worker` calls this. It is the handoff from startup code into the worker’s main routine.

*Call graph*: 5 external calls (clone, run, run, try_current, warn!).


##### `worker::run`  (lines 343–393)

```
async fn run(codex_home: PathBuf) -> io::Result<()>
```

**Purpose**: Performs one full compression maintenance run. It claims the run marker, cleans old temporary files, scans rollout folders, compresses cold files, and records the result.

**Data flow**: It receives the Codex home path → claims or skips a run marker → cleans stale temp files → scans archived and active session directories until time runs out → logs and records metrics → keeps the marker if completed successfully.

**Call relations**: `worker::spawn` runs this in the background. It coordinates the worker helpers such as `cleanup_stale_temps`, `compress_rollouts_in_root`, and the run marker.

*Call graph*: 11 external calls (now, as_path, join, debug!, info!, run, run_duration, try_claim, default, cleanup_stale_temps (+1 more)).


##### `worker::create_run_marker_file`  (lines 395–407)

```
fn create_run_marker_file(path: &Path) -> io::Result<()>
```

**Purpose**: Creates the marker file that identifies an active or recent compression run. It writes basic information for humans or debugging tools.

**Data flow**: It receives the marker path → creates the file only if it does not already exist → writes the process ID and start time → returns success or a filesystem error.

**Call relations**: `CompressionRunMarker::try_claim` uses this to atomically claim the worker slot.

*Call graph*: 2 external calls (new, writeln!).


##### `worker::compress_rollouts_in_root`  (lines 409–485)

```
async fn compress_rollouts_in_root(
        root: &Path,
        started_at: Instant,
        stats: &mut CompressionStats,
    ) -> io::Result<()>
```

**Purpose**: Walks one rollout directory tree and starts compression jobs for plain rollout files it finds. It limits how many compressions run at once.

**Data flow**: It receives a root directory, start time, and mutable stats → skips missing roots → walks subdirectories → filters valid plain rollout files → counts scanned files → starts blocking compression jobs with a concurrency cap → drains remaining jobs before returning.

**Call relations**: `worker::run` calls this for archived and active session roots. It uses `RolloutFile::from_path` for discovery and `collect_next_compression_job` to fold job results into stats.

*Call graph*: calls 1 internal fn (from_path); 9 external calls (elapsed, new, file, collect_next_compression_job, drain_compression_jobs, read_dir, try_exists, vec!, warn!).


##### `worker::CompressionOutcome::tag`  (lines 498–505)

```
fn tag(self) -> &'static str
```

**Purpose**: Turns a compression result into a short label for metrics. Labels include compressed, skipped because not cold, skipped because changed, and already compressed.

**Data flow**: It receives an outcome enum value → matches it to a fixed text tag → returns that tag.

**Call relations**: `collect_next_compression_job` uses this when recording metrics for completed compression jobs.


##### `worker::CompressionMeasurement::new`  (lines 515–525)

```
fn new(
            outcome: CompressionOutcome,
            source_bytes: Option<u64>,
            compressed_bytes: Option<u64>,
        ) -> Self
```

**Purpose**: Builds a small report describing what happened to one file during compression. It includes the outcome and optional byte counts.

**Data flow**: It receives an outcome, optional original size, and optional compressed size → stores them in a measurement object → returns it.

**Call relations**: `compress_rollout_if_cold_blocking` creates these reports, and `collect_next_compression_job` later reads them to update stats and metrics.


##### `worker::drain_compression_jobs`  (lines 533–540)

```
async fn drain_compression_jobs(
        jobs: &mut JoinSet<CompressionJobResult>,
        stats: &mut CompressionStats,
    )
```

**Purpose**: Waits for all outstanding compression jobs to finish and records their results. This is used before leaving a directory scan.

**Data flow**: It receives the active job set and stats → repeatedly waits for the next job while any remain → updates stats through `collect_next_compression_job`.

**Call relations**: `compress_rollouts_in_root` calls this at the end and when errors require cleanup of already-started jobs.

*Call graph*: 2 external calls (is_empty, collect_next_compression_job).


##### `worker::collect_next_compression_job`  (lines 542–586)

```
async fn collect_next_compression_job(
        jobs: &mut JoinSet<CompressionJobResult>,
        stats: &mut CompressionStats,
    )
```

**Purpose**: Collects one finished compression job and turns its result into counters, timings, byte measurements, and warnings if needed.

**Data flow**: It waits for the next job result → if compression succeeded, updates compressed or skipped counts and records metrics → if the job returned an error or panicked, increments failure counts and logs a warning.

**Call relations**: `compress_rollouts_in_root` and `drain_compression_jobs` use this to keep the worker’s statistics accurate as background compression tasks finish.

*Call graph*: 7 external calls (join_next, compressed_bytes, compression_ratio, file, file_duration, source_bytes, warn!).


##### `worker::compress_rollout_if_cold_blocking`  (lines 588–657)

```
fn compress_rollout_if_cold_blocking(path: &Path) -> io::Result<CompressionMeasurement>
```

**Purpose**: Compresses one plain rollout file, but only if it is old enough and unchanged while compression is happening. This is the core safety-critical compression step.

**Data flow**: It receives a file path → checks whether the file is cold → skips if too new, missing, or already compressed → writes a compressed temporary file → verifies it can be decompressed → checks the source file did not change → preserves metadata → installs the compressed file without overwriting → checks again → deletes the original plain file → returns a measurement of the outcome.

**Call relations**: `compress_rollouts_in_root` runs this inside blocking jobs. It relies on file-state checks, zstd encoding and verification, and metadata copying to avoid data loss.

*Call graph*: 10 external calls (compressed_rollout_path, new, cold_file_state, encode_zstd_to_writer, same_file_state, set_file_metadata, verify_zstd, create_dir_all, remove_file, new).


##### `worker::cold_file_state`  (lines 665–689)

```
fn cold_file_state(path: &Path) -> io::Result<ColdFileState>
```

**Purpose**: Decides whether a file is old enough to compress and records the file details needed to detect later changes.

**Data flow**: It receives a path → reads metadata → rejects missing, non-file, or recently modified paths → captures length, modified time, and permissions → returns either cold state or not-cold state.

**Call relations**: `compress_rollout_if_cold_blocking` calls this before doing expensive compression work.

*Call graph*: 4 external calls (now, Cold, NotCold, metadata).


##### `worker::same_file_state`  (lines 691–699)

```
fn same_file_state(path: &Path, expected: &FileState) -> io::Result<bool>
```

**Purpose**: Checks whether a file still has the same size, modified time, and permissions as before. This detects writes or metadata changes during compression.

**Data flow**: It receives a path and expected file state → reads current metadata → compares key fields → returns true if unchanged, false if missing or changed, or an error for unexpected failures.

**Call relations**: `compress_rollout_if_cold_blocking` calls this before and after installing the compressed file, so it can abandon compression if another writer touched the file.

*Call graph*: 1 external calls (metadata).


##### `worker::encode_zstd_to_writer`  (lines 701–707)

```
fn encode_zstd_to_writer(source: &Path, output: impl Write) -> io::Result<()>
```

**Purpose**: Compresses a source file into a writer using Zstandard, a compression format often shortened to zstd.

**Data flow**: It receives a source path and output writer → opens the source → streams bytes through a zstd encoder → finishes the encoder → returns success or an I/O error.

**Call relations**: `compress_rollout_if_cold_blocking` uses this to create the temporary compressed copy.

*Call graph*: 3 external calls (open, copy, new).


##### `worker::verify_zstd`  (lines 709–715)

```
fn verify_zstd(path: &Path) -> io::Result<()>
```

**Purpose**: Checks that a compressed file can actually be decompressed. This prevents replacing a good source file with a corrupt compressed copy.

**Data flow**: It receives a compressed path → opens it → streams it through a zstd decoder into a discard sink → returns success if decoding completes.

**Call relations**: `compress_rollout_if_cold_blocking` calls this before it installs the compressed file and deletes the original.

*Call graph*: 4 external calls (open, copy, sink, new).


##### `worker::set_file_metadata`  (lines 717–724)

```
fn set_file_metadata(
        file: &File,
        modified: SystemTime,
        permissions: &Permissions,
    ) -> io::Result<()>
```

**Purpose**: Copies the original file’s modified time and permissions onto the compressed file. This keeps history sorting and access behavior consistent after compression.

**Data flow**: It receives an open file, a modified time, and permissions → sets the file times → sets the permissions → returns success or an error.

**Call relations**: `compress_rollout_if_cold_blocking` uses this before persisting the compressed temporary file.

*Call graph*: 4 external calls (set_permissions, set_times, new, clone).


##### `worker::cleanup_stale_temps`  (lines 726–734)

```
async fn cleanup_stale_temps(codex_home: &Path) -> io::Result<()>
```

**Purpose**: Removes old temporary files left behind by interrupted compression or decompression work. This keeps session folders from collecting abandoned `.tmp` files.

**Data flow**: It receives the Codex home directory → builds the active and archived session roots → asks each root cleanup helper to scan for stale temp files → returns success or an error.

**Call relations**: `worker::run` calls this before starting compression, so old leftovers are cleaned during normal maintenance.

*Call graph*: 2 external calls (join, cleanup_stale_temps_in_root).


##### `worker::cleanup_stale_temps_in_root`  (lines 736–799)

```
async fn cleanup_stale_temps_in_root(root: &Path) -> io::Result<()>
```

**Purpose**: Walks one session tree and deletes stale temporary files. A temp file is considered stale only after several hours, so active work is not disturbed.

**Data flow**: It receives a root directory → skips it if missing → walks subdirectories → finds files whose names end in `.tmp` → checks their age → removes stale ones and records cleanup metrics.

**Call relations**: `cleanup_stale_temps` calls this for each session root. It logs warnings for unreadable directories or failed removals.

*Call graph*: 6 external calls (temp_cleanup, read_dir, remove_file, try_exists, vec!, warn!).


##### `metrics::file`  (lines 817–819)

```
fn file(outcome: &'static str)
```

**Purpose**: Records one file-level compression outcome, such as compressed, skipped, or failed.

**Data flow**: It receives an outcome label → sends a counter increment with that label to the metrics backend if one is configured.

**Call relations**: Compression scanning and job collection call this whenever a file is scanned or finishes processing.

*Call graph*: 1 external calls (counter).


##### `metrics::file_duration`  (lines 821–823)

```
fn file_duration(outcome: &'static str, duration: Duration)
```

**Purpose**: Records how long processing one rollout file took. This helps operators see whether compression is slow.

**Data flow**: It receives an outcome label and duration → records the duration in a histogram with that label.

**Call relations**: `collect_next_compression_job` calls this after compression jobs finish.

*Call graph*: 1 external calls (duration_histogram).


##### `metrics::source_bytes`  (lines 825–831)

```
fn source_bytes(outcome: &'static str, bytes: u64)
```

**Purpose**: Records the original size of a rollout file. This makes it possible to understand how much data compression is considering.

**Data flow**: It receives an outcome label and byte count → converts the count safely into the metric number type → records it in a histogram.

**Call relations**: `collect_next_compression_job` calls this when a measurement includes source size.

*Call graph*: 2 external calls (histogram, saturating_i64).


##### `metrics::compressed_bytes`  (lines 833–839)

```
fn compressed_bytes(outcome: &'static str, bytes: u64)
```

**Purpose**: Records the size of the compressed rollout file. This shows how much space the compressed representation uses.

**Data flow**: It receives an outcome label and byte count → converts it safely → records it in a histogram.

**Call relations**: `collect_next_compression_job` calls this after successful compression when compressed size is known.

*Call graph*: 2 external calls (histogram, saturating_i64).


##### `metrics::compression_ratio`  (lines 841–856)

```
fn compression_ratio(
        outcome: &'static str,
        source_bytes: u64,
        compressed_bytes: u64,
    )
```

**Purpose**: Records the compressed-size-to-original-size ratio. It uses integer precision so the metric system can store it reliably.

**Data flow**: It receives an outcome label, original bytes, and compressed bytes → skips zero-length sources → computes the ratio in basis points, where 10,000 means 100% → records it in a histogram.

**Call relations**: `collect_next_compression_job` calls this when both source and compressed sizes are available.

*Call graph*: 3 external calls (histogram, saturating_i64, from).


##### `metrics::materialize`  (lines 858–860)

```
fn materialize(outcome: &'static str)
```

**Purpose**: Records what happened when a compressed rollout was materialized back to plain form.

**Data flow**: It receives an outcome label such as `decompressed`, `missing`, or `failed` → increments the materialization counter.

**Call relations**: `materialize_rollout_for_append_blocking` calls this to make decompression-for-append visible.

*Call graph*: 1 external calls (counter).


##### `metrics::run`  (lines 862–864)

```
fn run(status: &'static str)
```

**Purpose**: Records the overall status of a compression worker run, such as started, completed, failed, or skipped.

**Data flow**: It receives a status label → increments the run counter with that status.

**Call relations**: `worker::spawn` and `worker::run` call this at important lifecycle points.

*Call graph*: 1 external calls (counter).


##### `metrics::run_duration`  (lines 866–868)

```
fn run_duration(status: &'static str, duration: Duration)
```

**Purpose**: Records how long a full compression worker run took.

**Data flow**: It receives a status label and duration → records the duration with that status label.

**Call relations**: `worker::run` calls this when the run completes or fails.

*Call graph*: 1 external calls (duration_histogram).


##### `metrics::temp_cleanup`  (lines 870–872)

```
fn temp_cleanup(outcome: &'static str)
```

**Purpose**: Records whether stale temporary file cleanup removed a file or failed.

**Data flow**: It receives a cleanup outcome label → increments the temp-cleanup counter.

**Call relations**: `cleanup_stale_temps_in_root` calls this while removing old `.tmp` files.

*Call graph*: 1 external calls (counter).


##### `metrics::counter`  (lines 874–879)

```
fn counter(name: &str, tags: &[(&str, &str)])
```

**Purpose**: Sends a counter increment to the global metrics system, if metrics are enabled. If no metrics backend exists, it quietly does nothing.

**Data flow**: It receives a metric name and tags → looks up the global metrics recorder → increments the counter by one when available.

**Call relations**: The higher-level metric helpers use this for run, file, materialization, and cleanup counters.

*Call graph*: 1 external calls (global).


##### `metrics::histogram`  (lines 881–886)

```
fn histogram(name: &str, value: i64, tags: &[(&str, &str)])
```

**Purpose**: Sends a numeric measurement to the global metrics system. Histograms collect distributions, such as file sizes.

**Data flow**: It receives a metric name, value, and tags → looks up the global metrics recorder → records the value if metrics are configured.

**Call relations**: Size and ratio metric helpers call this after preparing their numeric values.

*Call graph*: 1 external calls (global).


##### `metrics::duration_histogram`  (lines 888–893)

```
fn duration_histogram(name: &str, duration: Duration, tags: &[(&str, &str)])
```

**Purpose**: Records a time duration in the global metrics system. It is used for measuring file and worker run durations.

**Data flow**: It receives a metric name, duration, and tags → looks up the global metrics recorder → records the duration if available.

**Call relations**: `metrics::file_duration` and `metrics::run_duration` delegate to this helper.

*Call graph*: 1 external calls (global).


##### `metrics::saturating_i64`  (lines 895–897)

```
fn saturating_i64(value: impl TryInto<i64>) -> i64
```

**Purpose**: Safely converts a number into a signed 64-bit integer for metrics. If the number is too large, it uses the largest possible value instead of failing.

**Data flow**: It receives a convertible numeric value → tries to convert it to `i64` → returns the converted value or `i64::MAX` on overflow.

**Call relations**: Metric helpers use this before sending byte counts and ratios to histogram recording.

*Call graph*: 1 external calls (try_into).


##### `existing_rollout_path`  (lines 902–904)

```
async fn existing_rollout_path(path: &Path) -> Option<PathBuf>
```

**Purpose**: Finds the physical rollout file that exists on disk, preferring the plain `.jsonl` version over the compressed `.jsonl.zst` version.

**Data flow**: It receives a rollout path → delegates to the internal path helper → returns the existing path or `None`.

**Call relations**: External code can call this when it needs to know which representation is currently available.

*Call graph*: 1 external calls (existing_rollout_path).


##### `path::compressed_rollout_path`  (lines 913–923)

```
fn compressed_rollout_path(path: &Path) -> PathBuf
```

**Purpose**: Computes the compressed sibling path for a rollout file. If the input is already compressed, it returns it unchanged.

**Data flow**: It receives a path → checks whether it already ends as a compressed rollout → otherwise appends `.zst` to the filename → returns the resulting path.

**Call relations**: Compression, materialization, and existence lookup code use this to agree on compressed filenames.

*Call graph*: 4 external calls (file_name, to_path_buf, with_file_name, is_compressed_rollout_path).


##### `path::plain_rollout_path`  (lines 925–933)

```
fn plain_rollout_path(path: &Path) -> PathBuf
```

**Purpose**: Computes the plain `.jsonl` path for a rollout file. If the path is not compressed, it returns it unchanged.

**Data flow**: It receives a path → checks for the `.zst` suffix → strips it when present → returns the plain path.

**Call relations**: Append preparation and lookup code use this to normalize rollout paths before deciding what file to read or write.

*Call graph*: 3 external calls (file_name, to_path_buf, with_file_name).


##### `path::is_compressed_rollout_path`  (lines 935–939)

```
fn is_compressed_rollout_path(path: &Path) -> bool
```

**Purpose**: Checks whether a path names a compressed rollout file.

**Data flow**: It receives a path → reads the filename as text → returns true only when it ends with `.jsonl.zst`.

**Call relations**: Readers, scanners, and path helpers use this to branch between compressed and plain behavior.

*Call graph*: 1 external calls (file_name).


##### `path::should_skip_compressed_sibling`  (lines 941–943)

```
fn should_skip_compressed_sibling(path: &Path) -> bool
```

**Purpose**: Decides whether a compressed file should be ignored because the plain version is present. This prevents duplicate logical rollout entries.

**Data flow**: It receives a path → if it is compressed, computes the plain sibling path → checks whether the plain file exists → returns true when the compressed sibling should be hidden.

**Call relations**: `RolloutFile::from_path` uses this during directory discovery.

*Call graph*: calls 1 internal fn (plain_rollout_path); 1 external calls (is_compressed_rollout_path).


##### `path::existing_rollout_path`  (lines 945–957)

```
async fn existing_rollout_path(path: &Path) -> Option<PathBuf>
```

**Purpose**: Looks for the existing version of a rollout file on disk, with plain files taking priority over compressed files.

**Data flow**: It receives a path → normalizes it to the plain path → checks for a plain file → if absent, checks for the compressed sibling → returns whichever existing file should be used, or `None`.

**Call relations**: Top-level lookup, modified-time code, and reader opening code rely on this so they do not duplicate existence checks.

*Call graph*: calls 2 internal fn (compressed_rollout_path, plain_rollout_path); 1 external calls (matches!).


##### `file_name::parse_rollout_file_name`  (lines 963–970)

```
fn parse_rollout_file_name(name: &str) -> Option<&str>
```

**Purpose**: Recognizes valid rollout filenames. It treats compressed and plain names as the same logical rollout and returns the plain name.

**Data flow**: It receives a filename → removes `.zst` if present → checks that it starts with `rollout-` and ends with `.jsonl` → returns the normalized name or `None`.

**Call relations**: `RolloutFile::from_path` and the public wrapper use this to filter directory entries.


##### `reader::open_once`  (lines 985–1007)

```
async fn open_once(path: &Path) -> io::Result<RolloutLineReader>
```

**Purpose**: Performs one attempt to open a rollout line reader. It chooses a plain async reader or a compressed blocking decoder based on the file that exists.

**Data flow**: It receives a requested rollout path → resolves the existing plain or compressed path → if compressed, opens and wraps a zstd decoder on a blocking thread → if plain, opens it with Tokio async file I/O → returns a `RolloutLineReader`.

**Call relations**: `open_rollout_line_reader` calls this and adds retry behavior around it. The returned reader is later consumed through `RolloutLineReader::next_line`.

*Call graph*: 8 external calls (as_path, existing_rollout_path, is_compressed_rollout_path, Blocking, Plain, open, new, spawn_blocking).


##### `create_file_with_permissions`  (lines 1022–1029)

```
fn create_file_with_permissions(path: &Path, permissions: &Permissions) -> io::Result<File>
```

**Purpose**: Creates a new file and applies permissions copied from another file. On Unix, it uses the permissions at creation time as well as setting them afterward.

**Data flow**: It receives a destination path and permissions → opens a new file without overwriting an existing one → applies the requested permissions → returns the open file.

**Call relations**: `materialize_rollout_for_append_blocking` uses this when writing a decompressed plain file so the restored file behaves like the compressed source.

*Call graph*: 3 external calls (clone, mode, new).


##### `temp_path_for`  (lines 1031–1042)

```
fn temp_path_for(path: &Path, operation: &str) -> PathBuf
```

**Purpose**: Builds a unique temporary filename next to a rollout file. The name includes the operation, process ID, and a counter to avoid collisions.

**Data flow**: It receives a target path and operation name → starts with the target filename or a fallback → appends operation, process ID, counter, and `.tmp` → returns the sibling temporary path.

**Call relations**: `materialize_rollout_for_append_blocking` uses this before decompressing so incomplete output does not appear as the real rollout file.

*Call graph*: called by 1 (materialize_rollout_for_append_blocking); 3 external calls (file_name, with_file_name, format!).


### `rollout/src/session_index.rs`

`io_transport` · `cross-cutting session naming and lookup`

This file is the project’s simple address book for sessions. Each time a thread is named or renamed, it writes one new JSON line to `session_index.jsonl` under the Codex home folder. It does not rewrite the whole file for normal updates. Instead, it treats the file like a notebook where newer notes are added at the end, and the newest note wins.

That design makes renaming cheap and safe: appending one line is simpler than editing old records in place. To avoid two tasks writing at the same time and mixing their lines together, the file uses a mutex, which is a lock that allows only one writer into the critical section at once.

For lookups, the file often reads from the end backward, because the newest answer is usually near the end. It parses each line as a `SessionIndexEntry`, which contains the thread ID, the visible name, and the time of the update. Bad or empty lines are skipped rather than crashing the lookup.

It also has a more careful name lookup that finds matching thread IDs from newest to oldest, then checks whether the actual saved rollout file exists and has readable session metadata. This prevents a partial or unsaved rename from hiding an older usable session with the same name.

#### Function details

##### `append_thread_name`  (lines 33–50)

```
async fn append_thread_name(
    codex_home: &Path,
    thread_id: ThreadId,
    name: &str,
) -> std::io::Result<()>
```

**Purpose**: Records a new visible name for a thread. It adds the current time so later lookups can tell when that name was written.

**Data flow**: It receives the Codex home folder, a thread ID, and a name. It creates a `SessionIndexEntry` with those values plus the current UTC time, then passes that entry onward to be written to disk. The result is success or an I/O error if the write fails.

**Call relations**: This is the friendly public entry point for name updates. It gets the current time with `now_utc`, builds the record, and hands the actual file-writing work to `append_session_index_entry`.

*Call graph*: calls 1 internal fn (append_session_index_entry); 1 external calls (now_utc).


##### `append_session_index_entry`  (lines 54–71)

```
async fn append_session_index_entry(
    codex_home: &Path,
    entry: &SessionIndexEntry,
) -> std::io::Result<()>
```

**Purpose**: Writes one already-built session index record to `session_index.jsonl`. It is useful when the caller already has the full record, including its timestamp.

**Data flow**: It receives the Codex home folder and a session index entry. It locks the shared write lock, finds the index file path, turns the entry into one JSON string, adds a newline, appends it to the file, and flushes it so the bytes are pushed out. It returns success or the file/JSON error that stopped the write.

**Call relations**: `append_thread_name` calls this after preparing a normal rename record. This function uses `session_index_path` to decide where the index lives, and uses JSON serialization to make the record readable later.

*Call graph*: calls 1 internal fn (session_index_path); called by 1 (append_thread_name); 2 external calls (to_string, new).


##### `remove_thread_name_entries`  (lines 74–105)

```
async fn remove_thread_name_entries(
    codex_home: &Path,
    thread_id: ThreadId,
) -> std::io::Result<()>
```

**Purpose**: Deletes every stored name record for one thread ID. This is used when the index should no longer remember any name history for that thread.

**Data flow**: It receives the Codex home folder and the thread ID to remove. It locks the index, reads the whole index file if it exists, keeps only the lines that do not decode to that thread ID, writes the remaining lines to a temporary file, and renames that temporary file over the old index. If the index file is missing, it treats that as already done.

**Call relations**: Like the append path, it uses `session_index_path` to locate the file. Unlike normal updates, this must rewrite the file because it is removing older records rather than adding a new one.

*Call graph*: calls 1 internal fn (session_index_path); 4 external calls (with_capacity, read_to_string, rename, write).


##### `find_thread_name_by_id`  (lines 108–121)

```
async fn find_thread_name_by_id(
    codex_home: &Path,
    thread_id: &ThreadId,
) -> std::io::Result<Option<String>>
```

**Purpose**: Finds the current name for one thread ID, if the index has one. It searches for the newest matching record because older lines may contain old names.

**Data flow**: It receives the Codex home folder and a thread ID. If the index file does not exist, it returns `None`. Otherwise it runs the disk scan on a blocking worker thread, reads backward through the file, and returns the matching entry’s thread name if one is found.

**Call relations**: This function is the single-ID lookup path. It uses `session_index_path` to locate the index and `spawn_blocking` so the potentially slow file scanning does not block the async runtime.

*Call graph*: calls 1 internal fn (session_index_path); 1 external calls (spawn_blocking).


##### `find_thread_names_by_ids`  (lines 124–153)

```
async fn find_thread_names_by_ids(
    codex_home: &Path,
    thread_ids: &HashSet<ThreadId>,
) -> std::io::Result<HashMap<ThreadId, String>>
```

**Purpose**: Finds current names for many thread IDs in one pass through the index. This avoids doing a separate file scan for every thread in a list.

**Data flow**: It receives the Codex home folder and a set of thread IDs. If there is nothing to look up or the index file is absent, it returns an empty map. Otherwise it reads the file line by line, skips empty or invalid lines, and stores names for requested IDs; because later lines overwrite earlier ones in the map, the final result keeps the newest name seen for each ID.

**Call relations**: `filter_thread_items_by_search_term` calls this when it needs names for a batch of thread items, such as during search or filtering. This function uses `session_index_path` to find the file and asynchronous file reading so it can cooperate with the rest of the async program.

*Call graph*: calls 1 internal fn (session_index_path); called by 1 (filter_thread_items_by_search_term); 4 external calls (new, with_capacity, open, new).


##### `find_thread_meta_by_name_str`  (lines 157–195)

```
async fn find_thread_meta_by_name_str(
    codex_home: &Path,
    name: &str,
    state_db_ctx: Option<&codex_state::StateRuntime>,
) -> std::io::Result<Option<(PathBuf, SessionMetaLine)>>
```

**Purpose**: Looks up a saved thread by its human-readable name and returns the path to its rollout file plus its session metadata. It is careful not to stop at a name record if the actual saved session cannot be read.

**Data flow**: It receives the Codex home folder, a name string, and optional state database context. Empty names or a missing index immediately produce `None`. Otherwise it starts a backward scan of the index that streams matching thread IDs from newest to oldest through a channel. For each candidate ID, it asks the rollout listing code to find the saved file path, then reads that file’s metadata header. The first readable match becomes the returned path and metadata.

**Call relations**: This is the name-to-session lookup path. It uses `session_index_path` to find the index, a channel to receive candidate IDs, and `spawn_blocking` for the backward file scan. For each candidate, it hands off to `find_thread_path_by_id_str` to locate the saved rollout and to `read_session_meta_line` to confirm the file is usable.

*Call graph*: calls 3 internal fn (find_thread_path_by_id_str, read_session_meta_line, session_index_path); 2 external calls (channel, spawn_blocking).


##### `session_index_path`  (lines 197–199)

```
fn session_index_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the full path to the session index file inside the Codex home folder. This keeps every caller using the same filename and location.

**Data flow**: It receives the Codex home directory path. It joins that directory with the fixed filename `session_index.jsonl`. It returns the resulting path.

**Call relations**: All file-reading and file-writing functions call this before touching the index. It is the small shared rule that says where the index lives.

*Call graph*: called by 5 (append_session_index_entry, find_thread_meta_by_name_str, find_thread_name_by_id, find_thread_names_by_ids, remove_thread_name_entries); 1 external calls (join).


##### `scan_index_from_end_by_id`  (lines 201–206)

```
fn scan_index_from_end_by_id(
    path: &Path,
    thread_id: &ThreadId,
) -> std::io::Result<Option<SessionIndexEntry>>
```

**Purpose**: Searches the index backward for the newest entry with a particular thread ID. It is a specialized wrapper around the more general backward scanner.

**Data flow**: It receives the index file path and the target thread ID. It creates a matching rule that checks whether each entry has that ID, then returns the first matching entry found while scanning from the end. If no match exists, it returns `None`.

**Call relations**: This helper delegates the actual backward file reading to `scan_index_from_end`. It exists so callers looking up by ID do not have to write the matching rule themselves.

*Call graph*: calls 1 internal fn (scan_index_from_end).


##### `stream_thread_ids_from_end_by_name`  (lines 208–224)

```
fn stream_thread_ids_from_end_by_name(
    path: &Path,
    name: &str,
    tx: tokio::sync::mpsc::Sender<ThreadId>,
) -> std::io::Result<()>
```

**Purpose**: Streams thread IDs whose latest recorded name equals a requested name, starting with the newest index records. It also avoids treating an old name as current after a thread has been renamed.

**Data flow**: It receives the index path, the name to match, and a channel sender. As it scans backward, it remembers which thread IDs it has already seen. The first time it sees an ID, that entry represents the thread’s latest name; if that name matches the requested name, it sends the ID through the channel. It finishes with success unless scanning fails.

**Call relations**: `find_thread_meta_by_name_str` starts this on a blocking worker and receives IDs from its channel. This function uses `scan_index_from_end_for_each` so it can inspect entries newest-first and send matching IDs as they appear.

*Call graph*: calls 1 internal fn (scan_index_from_end_for_each); 1 external calls (new).


##### `scan_index_from_end`  (lines 226–239)

```
fn scan_index_from_end(
    path: &Path,
    mut predicate: F,
) -> std::io::Result<Option<SessionIndexEntry>>
```

**Purpose**: Provides a simple backward search over the index file. The caller supplies the question, and this function returns the newest entry that answers yes.

**Data flow**: It receives the index path and a predicate, which is a small yes-or-no test for each parsed entry. It scans entries from newest to oldest and returns a clone of the first entry that passes the test. If none pass, it returns `None`.

**Call relations**: `scan_index_from_end_by_id` uses this to express ID lookup in a short way. This function relies on `scan_index_from_end_for_each` for the low-level work of reading the file backward and parsing entries.

*Call graph*: calls 1 internal fn (scan_index_from_end_for_each); called by 1 (scan_index_from_end_by_id).


##### `scan_index_from_end_for_each`  (lines 241–276)

```
fn scan_index_from_end_for_each(
    path: &Path,
    mut visit_entry: F,
) -> std::io::Result<Option<SessionIndexEntry>>
```

**Purpose**: Reads the index file from the end toward the beginning and visits each valid entry. This makes newest-first lookup fast without loading the whole file into memory.

**Data flow**: It receives the index path and a visitor function. It opens the file, reads chunks from back to front, reconstructs each line in the correct order, parses it, and passes each valid `SessionIndexEntry` to the visitor. If the visitor returns an entry, scanning stops early and that entry is returned; otherwise the scan reaches the beginning and returns `None`.

**Call relations**: This is the shared engine behind backward lookups. `scan_index_from_end` uses it for simple searches, and `stream_thread_ids_from_end_by_name` uses it to stream matching IDs while still moving newest-first. It calls `parse_line_from_rev` whenever it has collected one reversed line.

*Call graph*: calls 1 internal fn (parse_line_from_rev); called by 2 (scan_index_from_end, stream_thread_ids_from_end_by_name); 5 external calls (open, Start, new, try_from, vec!).


##### `parse_line_from_rev`  (lines 278–304)

```
fn parse_line_from_rev(
    line_rev: &mut Vec<u8>,
    visit_entry: &mut F,
) -> std::io::Result<Option<SessionIndexEntry>>
```

**Purpose**: Turns one line collected backward into a usable session index entry, if possible. It quietly ignores empty, invalid, or non-UTF-8 lines so a bad record does not break the whole search.

**Data flow**: It receives a buffer containing the bytes of one line in reverse order and a visitor function. It reverses the bytes back, converts them to text, removes a trailing carriage return if present, trims whitespace, parses the JSON into a `SessionIndexEntry`, and passes that entry to the visitor. It clears the line buffer as part of taking the bytes out.

**Call relations**: `scan_index_from_end_for_each` calls this whenever a newline marks the end of a collected record. This function is the parsing checkpoint between raw file bytes and the higher-level search logic.

*Call graph*: called by 1 (scan_index_from_end_for_each); 2 external calls (from_utf8, take).


### `rollout/src/search.rs`

`domain_logic` · `request handling`

A rollout is a saved conversation log, stored as line-by-line JSON. This file is the search engine for those logs. Its job is to answer questions like “Which past sessions mentioned this text?” without making the rest of the program know about folders, compressed files, JSON escaping, or preview snippets.

The fast path uses ripgrep, an external search tool, to scan plain `.jsonl` rollout files. That is like asking a very fast librarian to list every book containing a phrase. If ripgrep is missing, or when files are compressed, the file falls back to reading rollout files itself. For compressed logs it cannot rely on ripgrep, so it opens each rollout through the compression layer, reads one line at a time, parses matching conversation items, and extracts human-readable text.

The file is careful about what it searches. Since rollouts are JSON, the search text is first escaped the same way JSON stores it, so quotes, backslashes, and similar characters still match correctly. When it creates a snippet, it ignores metadata and only uses real user or assistant conversation text. It also normalizes whitespace and adds a little context before and after the match, so the result is useful in a search UI rather than just a raw JSON line.

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

**Purpose**: This is the simple public search entry point when the caller only wants to know which rollout files matched. It hides the extra snippet information and returns just the set of matching paths.

**Data flow**: It receives the ripgrep command path, the Codex home folder, whether to search archived sessions, and the search text. It asks `search_rollout_matches` for the fuller result, throws away the snippet values, and returns only the file paths.

**Call relations**: This function sits one layer above `search_rollout_matches`. Callers use it when they do not need previews; it delegates the real searching work and then simplifies the answer.

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

**Purpose**: This is the main search coordinator. It chooses the right session folder, tries the fast ripgrep search for plain files, and also searches compressed rollout files so they are not missed.

**Data flow**: It receives the search settings and builds the folder path for either active or archived sessions. It converts the search term into its JSON-stored form, tries `ripgrep_rollout_paths`, and then returns a map from each matching plain rollout path to either no snippet or a snippet string. If ripgrep is unavailable, it falls back to scanning all rollout files itself.

**Call relations**: It is called by `search_rollout_paths` and is the hub for this file. It hands quick plain-file searching to `ripgrep_rollout_paths`, fallback walking to `scan_rollout_matches`, compressed-file searching to `scan_compressed_rollout_matches`, and search-term escaping to `json_escaped_search_term`.

*Call graph*: calls 4 internal fn (json_escaped_search_term, ripgrep_rollout_paths, scan_compressed_rollout_matches, scan_rollout_matches); called by 1 (search_rollout_paths); 1 external calls (join).


##### `ripgrep_rollout_paths`  (lines 64–115)

```
async fn ripgrep_rollout_paths(
    rg_command: &Path,
    root: &Path,
    search_term: &str,
) -> io::Result<Option<HashSet<PathBuf>>>
```

**Purpose**: This tries to use ripgrep to quickly find plain `.jsonl` rollout files containing the search text. If ripgrep is not installed, it reports that the fast path is unavailable instead of failing the whole search.

**Data flow**: It receives the ripgrep executable path, a root folder, and the already JSON-escaped search text. It checks whether the folder exists, runs ripgrep with fixed-string and case-insensitive options, reads the matching file paths from ripgrep’s output, makes them absolute when needed, and returns them as a set. If ripgrep cannot be found, it returns `None` so the caller can use a slower built-in scan.

**Call relations**: It is called by `search_rollout_matches` as the preferred fast route. When it succeeds, `search_rollout_matches` combines its plain-file results with compressed-file results; when it is unavailable, `search_rollout_matches` switches to `scan_rollout_matches`.

*Call graph*: called by 1 (search_rollout_matches); 8 external calls (new, join, from, from_utf8_lossy, new, other, format!, try_exists).


##### `scan_rollout_matches`  (lines 117–163)

```
async fn scan_rollout_matches(
    root: &Path,
    json_search_term: &str,
    search_term: &str,
) -> io::Result<RolloutSearchMatches>
```

**Purpose**: This is the built-in folder scanner used when ripgrep is not available. It walks through rollout directories itself and checks both plain and compressed rollout files.

**Data flow**: It receives a root folder, the JSON-escaped search term, and the original search term. It builds a case-insensitive literal pattern, visits subfolders, ignores non-rollout files, checks plain files with `rollout_contains`, and checks compressed files with `first_rollout_content_match_snippet`. It returns a map of matching rollout paths, with snippets for compressed matches where available.

**Call relations**: It is called by `search_rollout_matches` only on the fallback path. It relies on the compression module to recognize rollout files, on `rollout_contains` for simple plain-file matching, and on `first_rollout_content_match_snippet` when a compressed file needs real content extraction.

*Call graph*: calls 4 internal fn (from_path, case_insensitive_literal_regex, first_rollout_content_match_snippet, rollout_contains); called by 1 (search_rollout_matches); 4 external calls (new, plain_rollout_path, read_dir, vec!).


##### `rollout_contains`  (lines 165–173)

```
async fn rollout_contains(path: &Path, search_term: &Regex) -> io::Result<bool>
```

**Purpose**: This checks whether one rollout file contains the search pattern anywhere in its stored lines. It is a small helper for the slower built-in scan of plain files.

**Data flow**: It receives a rollout path and a prepared regular expression. It opens the rollout through the shared rollout line reader, reads each line, and returns `true` as soon as one line matches. If it reaches the end without a match, it returns `false`.

**Call relations**: It is called by `scan_rollout_matches` for non-compressed rollout files. It uses `open_rollout_line_reader` from the compression layer so the scanning code does not need to know the low-level file-reading details.

*Call graph*: calls 1 internal fn (open_rollout_line_reader); called by 1 (scan_rollout_matches); 1 external calls (is_match).


##### `first_rollout_content_match_snippet`  (lines 175–190)

```
async fn first_rollout_content_match_snippet(
    path: &Path,
    search_term: &str,
) -> io::Result<Option<String>>
```

**Purpose**: This searches a rollout file and returns the first readable conversation snippet that contains the search term. It is especially useful for compressed files, where the program cannot rely on ripgrep’s plain text file listing.

**Data flow**: It receives a rollout path and the original search term. It opens the rollout line reader, prepares one pattern for the JSON-stored text and another for the human-readable text, then reads lines until it finds a JSON line that may contain the term. For that line, it tries to parse out conversation text and create a short excerpt; the first successful excerpt is returned.

**Call relations**: It is called by both `scan_rollout_matches` and `scan_compressed_rollout_matches` when they need a preview snippet. It uses `json_escaped_search_term` and `case_insensitive_literal_regex` to prepare safe searches, then hands each promising line to `content_match_snippet` for parsing and excerpt creation.

*Call graph*: calls 4 internal fn (open_rollout_line_reader, case_insensitive_literal_regex, content_match_snippet, json_escaped_search_term); called by 2 (scan_compressed_rollout_matches, scan_rollout_matches).


##### `scan_compressed_rollout_matches`  (lines 192–233)

```
async fn scan_compressed_rollout_matches(
    root: &Path,
    search_term: &str,
) -> io::Result<RolloutSearchMatches>
```

**Purpose**: This searches compressed rollout files under a session folder. It exists because the fast ripgrep search only covers plain `.jsonl` files.

**Data flow**: It receives the root folder and search text. It walks through all subfolders, filters for rollout files that are compressed, asks `first_rollout_content_match_snippet` whether each one has a matching conversation snippet, and returns a map keyed by the normal plain rollout path with the snippet attached.

**Call relations**: It is called by `search_rollout_matches` after the ripgrep plain-file search succeeds. This fills the gap left by ripgrep, so compressed sessions appear in the same result set as normal sessions.

*Call graph*: calls 2 internal fn (from_path, first_rollout_content_match_snippet); called by 1 (search_rollout_matches); 4 external calls (new, plain_rollout_path, read_dir, vec!).


##### `json_escaped_search_term`  (lines 235–238)

```
fn json_escaped_search_term(search_term: &str) -> io::Result<String>
```

**Purpose**: This converts a user’s search text into the form it would have inside JSON. That matters because rollout files store conversation lines as JSON, not as raw text.

**Data flow**: It receives the original search string. It serializes it as a JSON string, removes the surrounding quotes added by JSON serialization, and returns the escaped inner text. For example, characters like quotes or backslashes become the exact sequences that would appear in a rollout line.

**Call relations**: It is used by `search_rollout_matches` before searching stored rollout lines and by `first_rollout_content_match_snippet` before checking individual JSON lines. It makes the later literal searches match the file format accurately.

*Call graph*: called by 2 (first_rollout_content_match_snippet, search_rollout_matches); 1 external calls (to_string).


##### `case_insensitive_literal_regex`  (lines 240–245)

```
fn case_insensitive_literal_regex(search_term: impl AsRef<str>) -> io::Result<Regex>
```

**Purpose**: This builds a case-insensitive search pattern that treats the search text as ordinary text, not as a special regular-expression language. It prevents characters like `.` or `*` from changing the meaning of the search.

**Data flow**: It receives any string-like search term. It escapes special regex characters, builds a regular expression with case-insensitive matching turned on, and returns the compiled pattern or an I/O-style error if building fails.

**Call relations**: It is called by `scan_rollout_matches` and `first_rollout_content_match_snippet` before they scan text. Those callers can then use regular expression matching safely while still behaving like a plain text search.

*Call graph*: called by 2 (first_rollout_content_match_snippet, scan_rollout_matches); 3 external calls (as_ref, new, escape).


##### `content_match_snippet`  (lines 247–251)

```
fn content_match_snippet(jsonl_line: &str, search_term: &Regex) -> Option<String>
```

**Purpose**: This turns one raw rollout JSON line into a human-readable search preview, if that line contains searchable conversation text. It filters out lines that are not useful conversation messages.

**Data flow**: It receives a JSONL line and a prepared search pattern. It parses the line as a rollout record, extracts user or assistant text with `conversation_text_from_item`, then asks `excerpt_around_match` to create a short snippet around the match. If parsing fails, the line is not a conversation message, or the text does not match, it returns nothing.

**Call relations**: It is called by `first_rollout_content_match_snippet` after a stored line appears to contain the search term. It delegates message filtering to `conversation_text_from_item` and preview formatting to `excerpt_around_match`.

*Call graph*: calls 2 internal fn (conversation_text_from_item, excerpt_around_match); called by 1 (first_rollout_content_match_snippet).


##### `conversation_text_from_item`  (lines 253–289)

```
fn conversation_text_from_item(item: &RolloutItem) -> Option<String>
```

**Purpose**: This extracts the actual visible conversation text from a rollout item. It deliberately ignores metadata, context records, images, and other non-message records so snippets show what a person would recognize from the chat.

**Data flow**: It receives a `RolloutItem`, which may be many kinds of saved record. For user messages it removes any internal user-message prefix, for agent messages it trims whitespace, and for response message records it joins text content from user or assistant roles. If the item has no useful text or belongs to another kind of record, it returns nothing.

**Call relations**: It is called by `content_match_snippet` when a raw rollout line has been parsed. It uses `strip_user_message_prefix` to clean older or wrapped user-message text before snippets are made.

*Call graph*: calls 1 internal fn (strip_user_message_prefix); called by 1 (content_match_snippet).


##### `content_item_text`  (lines 291–296)

```
fn content_item_text(item: &ContentItem) -> Option<&str>
```

**Purpose**: This pulls plain text out of one content item inside a response message. It ignores image content because images cannot be searched as text here.

**Data flow**: It receives a content item. If the item is input text or output text, it returns a borrowed view of that text; if it is an image, it returns nothing.

**Call relations**: This helper is used inside the response-message path of `conversation_text_from_item`. It lets that function join only text parts before deciding whether the message is searchable.


##### `strip_user_message_prefix`  (lines 298–303)

```
fn strip_user_message_prefix(text: &str) -> &str
```

**Purpose**: This removes an internal marker that may be stored before user message text. The result is cleaner text for matching and preview snippets.

**Data flow**: It receives a user message string. If it finds the known `USER_MESSAGE_BEGIN` marker, it returns the trimmed text after that marker; otherwise it returns the whole string trimmed.

**Call relations**: It is called by `conversation_text_from_item` for saved user-message events. This keeps internal protocol wrapping out of the text shown to people.

*Call graph*: called by 1 (conversation_text_from_item).


##### `excerpt_around_match`  (lines 305–327)

```
fn excerpt_around_match(text: &str, search_term: &Regex) -> Option<String>
```

**Purpose**: This creates a short preview around the first occurrence of the search term. It turns a full message into the kind of compact snippet people expect in search results.

**Data flow**: It receives conversation text and a prepared search pattern. It first normalizes whitespace, finds the first match, chooses a safe character boundary before and after the match, trims the excerpt, and adds leading or trailing ellipses when the excerpt is cut from a longer message. It returns the snippet or nothing if no usable excerpt exists.

**Call relations**: It is called by `content_match_snippet` after conversation text has been extracted. It relies on `normalize_preview_text` to make text compact and on `char_start_before` and `char_end_after` to avoid cutting through multi-byte characters.

*Call graph*: calls 3 internal fn (char_end_after, char_start_before, normalize_preview_text); called by 1 (content_match_snippet); 2 external calls (find, new).


##### `normalize_preview_text`  (lines 329–331)

```
fn normalize_preview_text(text: &str) -> String
```

**Purpose**: This cleans text for display in a search preview by collapsing all whitespace into single spaces. It makes snippets easier to read, especially when the original message had newlines or extra spacing.

**Data flow**: It receives a text string, splits it into whitespace-separated words, joins those words with one space each, and returns the cleaned string.

**Call relations**: It is called by `excerpt_around_match` before locating and cutting the preview text. This gives the excerpt code a simpler, more display-friendly string to work with.

*Call graph*: called by 1 (excerpt_around_match).


##### `char_start_before`  (lines 333–340)

```
fn char_start_before(text: &str, byte_index: usize, chars_before: usize) -> usize
```

**Purpose**: This finds a safe byte position a certain number of characters before a match. It is needed because Rust strings are stored as bytes, while people think in characters, and cutting at the wrong byte could break non-English text.

**Data flow**: It receives text, the byte position where the match starts, and the desired number of characters of context before it. It walks backward through character boundaries and returns the byte index to start the excerpt, or the beginning of the text if there is not enough earlier text.

**Call relations**: It is called by `excerpt_around_match` while building a preview. It supplies the left edge of the snippet so the excerpt includes context without corrupting the string.

*Call graph*: called by 1 (excerpt_around_match).


##### `char_end_after`  (lines 342–348)

```
fn char_end_after(text: &str, byte_index: usize, chars_after: usize) -> usize
```

**Purpose**: This finds a safe byte position a certain number of characters after a match. It lets snippets include trailing context without cutting through a character.

**Data flow**: It receives text, the byte position where the match ends, and the desired number of characters after it. It walks forward through character boundaries and returns the byte index to end the excerpt, or the end of the text if there is not enough later text.

**Call relations**: It is called by `excerpt_around_match` while building a preview. It supplies the right edge of the snippet so the final text is both readable and valid.

*Call graph*: called by 1 (excerpt_around_match).


### Rollout recording and discovery
These files implement the main rollout workflows for writing session transcripts, loading them back, and listing or locating persisted threads on disk.

### `rollout/src/list.rs`

`domain_logic` · `request handling`

Codex saves each thread as a rollout file, usually under date folders such as year/month/day. This file is the “table of contents” builder for those saved threads. Without it, the rest of the system would have to know how rollout files are named, where compressed files may live, how to read just enough JSON from the start of a file, and how to page through thousands of old sessions safely.

The main flow starts with get_threads, which chooses the sessions folder and asks get_threads_in_root to list it. The listing can be sorted by when the thread was created, which is encoded in the filename, or by when the file was last updated, which must be read from the filesystem. It can also filter by session source, model provider, or working directory.

To avoid doing unlimited work, scans stop at a fixed cap. Pagination uses a Cursor, which is just a timestamp bookmark. An AnchorState skips files until the scan has moved past the previous page’s last timestamp, like placing a bookmark in a stack of papers and continuing after it.

For each candidate file, build_thread_item reads only the beginning of the rollout, extracts session metadata and a useful preview, and returns a compact ThreadItem. The file also includes helpers to locate a rollout by thread ID, preferring the state database when available and falling back to filename and content search.

#### Function details

##### `Cursor::new`  (lines 147–149)

```
fn new(ts: OffsetDateTime) -> Self
```

**Purpose**: Creates a pagination cursor from a timestamp. A cursor is a small bookmark that says where a list request should resume next time.

**Data flow**: It receives one timestamp, stores it inside a Cursor, and returns that Cursor. It does not read files or change outside state.

**Call relations**: Listing and parsing code use this whenever they need to create a new bookmark, such as after parsing a cursor string or after building the next page token.

*Call graph*: called by 31 (run_sse, prepare_encoded_json, into_prepared_stores_compressed_body_for_reuse, unpack_plugin_bundle_tar_gz, extract_zipball_to_dir, curated_repo_backup_archive_zip_bytes, curated_repo_zipball_bytes, extract_zip_to_dir, original_detail_images_are_capped_at_max_patch_count, original_detail_images_scale_with_dimensions (+15 more)).


##### `Cursor::timestamp`  (lines 151–153)

```
fn timestamp(&self) -> OffsetDateTime
```

**Purpose**: Returns the timestamp stored inside a cursor. This lets other code inspect the bookmark without reaching into its private fields.

**Data flow**: It reads the Cursor’s saved timestamp and returns it unchanged. Nothing else is modified.

**Call relations**: This is a small accessor for callers that need to compare or convert a cursor’s time.


##### `AnchorState::new`  (lines 166–177)

```
fn new(anchor: Option<Cursor>) -> Self
```

**Purpose**: Sets up the pagination state for a scan. If there is an existing cursor, it remembers that timestamp and starts in “skip until past it” mode.

**Data flow**: It receives an optional Cursor. With a cursor, it stores its timestamp and marks that the scan has not passed it yet; without one, it starts from the beginning and skips nothing.

**Call relations**: The four traversal paths create an AnchorState before scanning so their loops can decide which files belong on the current page.

*Call graph*: called by 4 (traverse_directories_for_paths_created, traverse_directories_for_paths_updated, traverse_flat_paths_created, traverse_flat_paths_updated).


##### `AnchorState::should_skip`  (lines 179–189)

```
fn should_skip(&mut self, ts: OffsetDateTime, _id: Uuid) -> bool
```

**Purpose**: Decides whether a file should be ignored because it belongs to an earlier page. This keeps pagination stable when newer files appear while someone is paging through older results.

**Data flow**: It receives a file timestamp and ID. If the scan has not yet moved past the saved cursor timestamp, it returns true to skip; once it sees an older timestamp, it flips its internal state and starts returning false.

**Call relations**: Visitor and traversal code calls this for each candidate before spending more work building a ThreadItem.

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

**Purpose**: Processes one rollout file during a created-at-ordered directory walk. It applies paging, scan limits, and filters while collecting enough ThreadItem values for one page.

**Data flow**: It receives the file’s creation timestamp, ID, path, and scan count. It may skip the file, stop the walk if the page is full or the scan cap has been reached, or read the file metadata and append a ThreadItem to the shared item list.

**Call relations**: walk_rollout_files calls this for each file. It uses AnchorState::should_skip, file_modified_time, and build_thread_item, then tells the walker either to continue or break.

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

**Purpose**: Collects lightweight candidates for later updated-at sorting. It does not build full summaries yet, because all candidates must be sorted by modification time first.

**Data flow**: It receives a rollout path and ID, reads the file’s modification time, and appends a ThreadCandidate containing the path, ID, and update time. It always tells the scan to continue.

**Call relations**: collect_files_by_updated_at uses this visitor through walk_rollout_files before the updated-at traversal sorts and filters the candidates.

*Call graph*: calls 1 internal fn (file_modified_time); 1 external calls (Continue).


##### `Cursor::serialize`  (lines 282–291)

```
fn serialize(&self, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: Turns a Cursor into a string for JSON output. The string uses RFC3339, a common internet timestamp format such as 2024-01-01T12:00:00Z.

**Data flow**: It reads the cursor timestamp, formats it as an RFC3339 string, and gives that string to the JSON serializer. If formatting fails, it reports a serialization error.

**Call relations**: This lets ThreadsPage.next_cursor travel over APIs as a simple string token.

*Call graph*: 2 external calls (format, serialize_str).


##### `Cursor::deserialize`  (lines 295–301)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Reads a Cursor back from a JSON string. This lets a client send the previous next_cursor token into the next list request.

**Data flow**: It receives a JSON string, passes it to parse_cursor, and returns either a Cursor or a JSON decoding error if the token is invalid.

**Call relations**: It reuses parse_cursor so JSON input and manual cursor parsing follow the same rules.

*Call graph*: calls 1 internal fn (parse_cursor); 1 external calls (deserialize).


##### `Cursor::from`  (lines 305–312)

```
fn from(anchor: codex_state::Anchor) -> Self
```

**Purpose**: Converts a stored state-database anchor into this file’s Cursor type. It bridges the database representation and the listing code’s pagination token.

**Data flow**: It receives a codex_state::Anchor, converts its timestamp into an OffsetDateTime, falls back to the Unix epoch if conversion fails, and returns a Cursor.

**Call relations**: It hands database-provided pagination state into the same Cursor path used by file listing.

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

**Purpose**: Lists saved threads from the normal Codex sessions directory. This is the friendly public entry point for callers that know the Codex home folder but not the internal sessions path.

**Data flow**: It receives the Codex home path, page size, optional cursor, sort choice, filters, and default provider. It builds the sessions root path and forwards everything to get_threads_in_root, returning a ThreadsPage or an I/O error.

**Call relations**: Higher-level thread listing and tests call this. It delegates the real layout and traversal decisions to get_threads_in_root.

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

**Purpose**: Lists threads from a specific root folder. It chooses the directory layout and sets up model-provider filtering before scanning.

**Data flow**: It receives a root path, paging information, sort key, and ThreadListConfig. If the root is missing, it returns an empty page; otherwise it builds a ProviderMatcher when needed and calls the nested or flat traversal path.

**Call relations**: get_threads calls this for the standard sessions folder, while other callers can use it for custom roots. It hands work to traverse_directories_for_paths or traverse_flat_paths.

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

**Purpose**: Chooses the correct scanner for the nested year/month/day rollout layout. The choice depends on whether the caller wants creation time or update time ordering.

**Data flow**: It receives the nested root plus paging and filter settings. It forwards the same information to either the created-at or updated-at nested traversal and returns that page.

**Call relations**: get_threads_in_root calls this when the configured layout is NestedByDate.

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

**Purpose**: Chooses the correct scanner for a flat folder of rollout files. This supports roots where files are all in one directory instead of date subfolders.

**Data flow**: It receives the flat root plus paging and filter settings. It calls either the created-at or updated-at flat traversal and returns the resulting page.

**Call relations**: get_threads_in_root calls this when the configured layout is Flat.

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

**Purpose**: Builds one page of threads from nested date folders ordered by creation time. This is efficient because the creation timestamp is in the directory and filename order.

**Data flow**: It creates an empty item list, a scan counter, and a FilesByCreatedAtVisitor. walk_rollout_files feeds files to the visitor until enough results are collected or the scan cap is reached, then it builds a next cursor if more results likely exist.

**Call relations**: traverse_directories_for_paths calls this for CreatedAt sorting. It relies on walk_rollout_files for ordered scanning and build_next_cursor for pagination.

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

**Purpose**: Builds one page of threads from nested date folders ordered by last update time. Because update time is not in the filename, it must first collect candidates and sort them.

**Data flow**: It scans candidate files with their modification times, sorts newest first, applies the cursor and page size, then builds full ThreadItem summaries only for files that make the page. It reports scan counts, scan-cap status, and a next cursor when needed.

**Call relations**: traverse_directories_for_paths calls this for UpdatedAt sorting. It uses collect_files_by_updated_at, build_thread_item, and build_next_cursor.

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

**Purpose**: Builds one page from a flat directory ordered by creation time from filenames. It is the flat-layout counterpart to the nested created-at traversal.

**Data flow**: It collects flat rollout files, already sorted by timestamp and ID, skips anything before the cursor, reads modification time for display, builds ThreadItem summaries, and stops at page size or scan cap.

**Call relations**: traverse_flat_paths calls this for CreatedAt sorting. It uses collect_flat_rollout_files, file_modified_time, build_thread_item, and build_next_cursor.

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

**Purpose**: Builds one page from a flat directory ordered by file update time. It scans the flat folder, sorts by modification time, then creates summaries for the requested page.

**Data flow**: It collects candidate paths with update times, sorts newest first with ID as a tie breaker, applies the cursor and page size, reads each selected file’s summary, and returns a ThreadsPage.

**Call relations**: traverse_flat_paths calls this for UpdatedAt sorting. It uses collect_flat_files_by_updated_at, build_thread_item, and build_next_cursor.

*Call graph*: calls 4 internal fn (new, build_next_cursor, build_thread_item, collect_flat_files_by_updated_at); called by 1 (traverse_flat_paths); 1 external calls (with_capacity).


##### `parse_cursor`  (lines 706–720)

```
fn parse_cursor(token: &str) -> Option<Cursor>
```

**Purpose**: Turns a cursor token string into a Cursor. It accepts the modern RFC3339 timestamp form and an older filename-style timestamp form.

**Data flow**: It receives a token string. Tokens containing a pipe character are rejected, then the function tries to parse the string as RFC3339 or as YYYY-MM-DDThh-mm-ss; on success it returns a Cursor.

**Call relations**: Cursor::deserialize uses this for JSON input, and tests use it to check cursor compatibility.

*Call graph*: calls 1 internal fn (new); called by 3 (deserialize, cursor_from_thread_item, cursor_to_anchor_normalizes_timestamp_format); 1 external calls (parse).


##### `build_next_cursor`  (lines 722–734)

```
fn build_next_cursor(items: &[ThreadItem], sort_key: ThreadSortKey) -> Option<Cursor>
```

**Purpose**: Creates the pagination token for the next page. It uses the last item returned, because the next request should resume after that item.

**Data flow**: It reads the last ThreadItem, parses its filename for the created timestamp and ID, then chooses either the created timestamp or the item’s updated_at timestamp depending on the sort key. It returns a Cursor, or None if the needed data is missing.

**Call relations**: All four traversal functions call this when they believe more results may be available.

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

**Purpose**: Turns one rollout file into the compact summary shown in thread lists. It also applies source, model-provider, and working-directory filters.

**Data flow**: It receives a path, filters, and an optional fallback update time. It reads a short summary from the start of the file, rejects files that do not match filters or lack metadata and a preview, fills missing updated_at from the fallback or created_at, and returns a ThreadItem.

**Call relations**: Created-at visitors, updated-at traversals, flat traversals, and read_thread_item_from_rollout all use this as the central summary builder.

*Call graph*: calls 1 internal fn (read_head_summary); called by 5 (visit, read_thread_item_from_rollout, traverse_directories_for_paths_updated, traverse_flat_paths_created, traverse_flat_paths_updated); 1 external calls (is_empty).


##### `read_thread_item_from_rollout`  (lines 820–829)

```
async fn read_thread_item_from_rollout(path: PathBuf) -> Option<ThreadItem>
```

**Purpose**: Builds a ThreadItem for one known rollout path without scanning the sessions tree. This is useful when another part of the system already found the file.

**Data flow**: It receives a path and calls build_thread_item with no filters and no update-time fallback. It returns the summary if the file has enough metadata and preview information.

**Call relations**: It is a simple public wrapper around build_thread_item for direct lookup use cases.

*Call graph*: calls 1 internal fn (build_thread_item).


##### `collect_dirs_desc`  (lines 833–854)

```
async fn collect_dirs_desc(parent: &Path, parse: F) -> io::Result<Vec<(T, PathBuf)>>
```

**Purpose**: Reads child directories and sorts the ones with parseable names from newest or largest to oldest or smallest. It is used for year, month, and day folders.

**Data flow**: It receives a parent directory and a parsing function for names. It reads entries, keeps directories whose names parse successfully, sorts them descending by the parsed value, and returns their parsed keys with paths.

**Call relations**: walk_rollout_files calls this repeatedly to move through nested date folders in reverse chronological order.

*Call graph*: called by 1 (walk_rollout_files); 2 external calls (new, read_dir).


##### `collect_files`  (lines 857–876)

```
async fn collect_files(parent: &Path, parse: F) -> io::Result<Vec<T>>
```

**Purpose**: Reads files in one directory and converts matching filenames into caller-chosen values. It is a reusable helper for file collection.

**Data flow**: It receives a directory and a parsing function. It visits immediate file entries, passes each name and path to the parser, keeps successful results, and returns the collected list.

**Call relations**: collect_rollout_day_files uses this to gather rollout files for a single day folder.

*Call graph*: called by 1 (collect_rollout_day_files); 2 external calls (new, read_dir).


##### `collect_flat_rollout_files`  (lines 878–911)

```
async fn collect_flat_rollout_files(
    root: &Path,
    scanned_files: &mut usize,
) -> io::Result<Vec<(OffsetDateTime, Uuid, PathBuf)>>
```

**Purpose**: Collects rollout files from one flat directory and sorts them by creation time from their filenames. It respects the global scan cap.

**Data flow**: It receives a root folder and a mutable scan counter. It reads file entries, recognizes rollout files including compressed ones, parses timestamp and UUID from each name, increments the scan count, and returns sorted timestamp-ID-path triples.

**Call relations**: traverse_flat_paths_created uses this before applying pagination and building ThreadItem summaries.

*Call graph*: calls 2 internal fn (from_path, parse_timestamp_uuid_from_filename); called by 1 (traverse_flat_paths_created); 2 external calls (new, read_dir).


##### `collect_rollout_day_files`  (lines 913–925)

```
async fn collect_rollout_day_files(
    day_path: &Path,
) -> io::Result<Vec<(OffsetDateTime, Uuid, PathBuf)>>
```

**Purpose**: Collects all valid rollout files from one day directory. It gives the directory walker a sorted list for that day.

**Data flow**: It reads files in the day folder, recognizes rollout filenames, parses their timestamp and UUID, and sorts them newest first with UUID as a stable tie breaker.

**Call relations**: walk_rollout_files calls this after it has chosen a particular year, month, and day directory.

*Call graph*: calls 1 internal fn (collect_files); called by 1 (walk_rollout_files).


##### `parse_timestamp_uuid_from_filename`  (lines 927–943)

```
fn parse_timestamp_uuid_from_filename(name: &str) -> Option<(OffsetDateTime, Uuid)>
```

**Purpose**: Extracts the creation timestamp and UUID from a rollout filename. This is how the system understands names like rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl.

**Data flow**: It receives a filename string, normalizes it through the compression-aware filename parser, strips the rollout prefix and jsonl suffix, finds the UUID at the right end, parses the timestamp before it, and returns both values.

**Call relations**: Pagination, sorting, flat collection, and ID lookup all depend on this to interpret rollout filenames consistently.

*Call graph*: called by 6 (build_next_cursor, collect_flat_files_by_updated_at, collect_flat_rollout_files, find_rollout_path_by_id_from_filenames, builder_from_items, thread_item_sort_key); 3 external calls (parse, parse_rollout_file_name, format_description!).


##### `collect_files_by_updated_at`  (lines 951–962)

```
async fn collect_files_by_updated_at(
    root: &Path,
    scanned_files: &mut usize,
) -> io::Result<Vec<ThreadCandidate>>
```

**Purpose**: Collects nested-layout rollout candidates with their file modification times. It prepares data for updated-at sorting.

**Data flow**: It receives a root and scan counter, creates a FilesByUpdatedAtVisitor, and runs walk_rollout_files. The result is a list of ThreadCandidate values containing path, ID, and update time.

**Call relations**: traverse_directories_for_paths_updated calls this before sorting and building the final page.

*Call graph*: calls 1 internal fn (walk_rollout_files); called by 1 (traverse_directories_for_paths_updated); 1 external calls (new).


##### `collect_flat_files_by_updated_at`  (lines 964–1004)

```
async fn collect_flat_files_by_updated_at(
    root: &Path,
    scanned_files: &mut usize,
) -> io::Result<Vec<ThreadCandidate>>
```

**Purpose**: Collects flat-layout rollout candidates with their file modification times. It is the flat-folder version of collect_files_by_updated_at.

**Data flow**: It reads file entries in the root, stops at the scan cap, recognizes rollout files, parses each UUID from the filename, reads modification time, and returns ThreadCandidate values.

**Call relations**: traverse_flat_paths_updated calls this before sorting candidates by update time.

*Call graph*: calls 3 internal fn (from_path, file_modified_time, parse_timestamp_uuid_from_filename); called by 1 (traverse_flat_paths_updated); 2 external calls (new, read_dir).


##### `walk_rollout_files`  (lines 1006–1044)

```
async fn walk_rollout_files(
    root: &Path,
    scanned_files: &mut usize,
    visitor: &mut impl RolloutFileVisitor,
) -> io::Result<()>
```

**Purpose**: Walks the nested rollout directory tree in newest-first order. It is the shared scanner for nested year/month/day storage.

**Data flow**: It receives the root, a scan counter, and a visitor. It collects year, month, and day folders descending, then day files descending, increments the scan count for each file, and lets the visitor decide whether to continue or stop.

**Call relations**: Created-at listing uses it directly with FilesByCreatedAtVisitor, and updated-at candidate collection uses it with FilesByUpdatedAtVisitor.

*Call graph*: calls 2 internal fn (collect_dirs_desc, collect_rollout_day_files); called by 2 (collect_files_by_updated_at, traverse_directories_for_paths_created); 1 external calls (visit).


##### `ProviderMatcher::new`  (lines 1052–1062)

```
fn new(filters: &'a [String], default_provider: &'a str) -> Option<Self>
```

**Purpose**: Creates a model-provider filter helper. It also remembers whether sessions missing a provider should count as the default provider.

**Data flow**: It receives a list of provider names and the default provider. If the list is empty it returns None; otherwise it stores the list and whether the default provider is included.

**Call relations**: get_threads_in_root builds this once and passes it into traversal so build_thread_item can filter each file cheaply.


##### `ProviderMatcher::matches`  (lines 1064–1069)

```
fn matches(&self, session_provider: Option<&str>) -> bool
```

**Purpose**: Checks whether a session’s model provider passes the configured provider filter. Missing provider values can match when the filter includes the default provider.

**Data flow**: It receives an optional provider string. If present, it compares it against the filter list; if absent, it returns the precomputed default-provider match result.

**Call relations**: build_thread_item calls this while deciding whether a rollout file should appear in the listing.


##### `read_head_summary`  (lines 1072–1154)

```
async fn read_head_summary(path: &Path, head_limit: usize) -> io::Result<HeadTailSummary>
```

**Purpose**: Reads just enough of a rollout file to summarize it for a thread list. It avoids loading the whole conversation when only metadata and a preview are needed.

**Data flow**: It opens the rollout line reader, scans a limited number of non-empty JSON lines, records the first session metadata, captures creation time, provider, source, Git details, and preview text, and stops once it has enough information or reaches the scan limit.

**Call relations**: build_thread_item relies on this to turn raw rollout JSON lines into a HeadTailSummary. It uses event_msg_preview to turn user-facing events into preview text.

*Call graph*: calls 2 internal fn (open_rollout_line_reader, event_msg_preview); called by 1 (build_thread_item); 2 external calls (default, from_str).


##### `read_head_for_summary`  (lines 1158–1195)

```
async fn read_head_for_summary(path: &Path) -> io::Result<Vec<serde_json::Value>>
```

**Purpose**: Reads the first meaningful records from a rollout file in a JSON-value form. This is for callers that need the same “head” data, not just the ThreadItem summary.

**Data flow**: It opens the file, reads up to the head record limit, parses rollout lines, converts session metadata, response items, and inter-agent messages into JSON values, and skips event and context records.

**Call relations**: read_session_meta_line uses this to get the first metadata record, and tests use it to verify preserved head content.

*Call graph*: calls 1 internal fn (open_rollout_line_reader); called by 3 (read_session_meta_line, test_base_instructions_missing_in_meta_defaults_to_null, test_base_instructions_present_in_meta_is_preserved); 2 external calls (new, to_value).


##### `strip_user_message_prefix`  (lines 1197–1202)

```
fn strip_user_message_prefix(text: &str) -> &str
```

**Purpose**: Removes an internal marker from user-message text before showing it as a preview. This keeps list previews clean for humans.

**Data flow**: It receives message text. If it finds the USER_MESSAGE_BEGIN marker, it returns the trimmed text after the marker; otherwise it returns the trimmed original text.

**Call relations**: event_msg_preview calls this when turning a UserMessage event into display text.

*Call graph*: called by 1 (event_msg_preview).


##### `event_msg_preview`  (lines 1204–1227)

```
fn event_msg_preview(event: &EventMsg) -> Option<String>
```

**Purpose**: Extracts a human-readable preview from event messages that can describe a thread. It supports normal user messages, image-only messages, and thread goal updates.

**Data flow**: It receives an EventMsg. For user messages it returns cleaned text, or [Image] if images exist but text is empty; for goal updates it returns the objective text; for other events it returns None.

**Call relations**: read_head_summary calls this while scanning rollout events so the final ThreadItem can show a useful preview.

*Call graph*: calls 1 internal fn (strip_user_message_prefix); called by 1 (read_head_summary).


##### `read_session_meta_line`  (lines 1231–1245)

```
async fn read_session_meta_line(path: &Path) -> io::Result<SessionMetaLine>
```

**Purpose**: Reads the SessionMetaLine from the start of a rollout file. This gives callers the authoritative session metadata for a known file.

**Data flow**: It calls read_head_for_summary, takes the first JSON value, and tries to deserialize it as SessionMetaLine. If the file is empty or does not start with metadata, it returns a clear I/O error.

**Call relations**: Thread-path lookup uses this to verify that a database path really belongs to the requested thread, and other metadata lookup code reuses it.

*Call graph*: calls 1 internal fn (read_head_for_summary); called by 3 (find_thread_path_by_id_str_in_subdir, find_thread_meta_by_name_str, read_repair_rollout_path); 2 external calls (other, format!).


##### `file_modified_time`  (lines 1247–1251)

```
async fn file_modified_time(path: &Path) -> io::Result<Option<OffsetDateTime>>
```

**Purpose**: Reads a rollout file’s last modification time and normalizes it. This provides the updated_at value used for display and updated-time sorting.

**Data flow**: It asks the compression layer for the file modification time, then truncates the timestamp to milliseconds. It returns an optional timestamp inside an I/O result.

**Call relations**: Created-at and updated-at listing paths call this whenever they need filesystem update time.

*Call graph*: calls 1 internal fn (file_modified_time); called by 4 (visit, visit, collect_flat_files_by_updated_at, traverse_flat_paths_created).


##### `format_rfc3339`  (lines 1253–1255)

```
fn format_rfc3339(dt: OffsetDateTime) -> Option<String>
```

**Purpose**: Formats a timestamp as an RFC3339 string. This is the display and cursor-friendly timestamp format used in ThreadItem fields.

**Data flow**: It receives an OffsetDateTime and tries to format it. On success it returns the string; on formatting failure it returns None.

**Call relations**: Listing code uses this after reading modification times so updated_at can be stored as text.

*Call graph*: 1 external calls (format).


##### `truncate_to_millis`  (lines 1257–1260)

```
fn truncate_to_millis(dt: OffsetDateTime) -> Option<OffsetDateTime>
```

**Purpose**: Rounds a timestamp down to millisecond precision. This avoids tiny nanosecond differences that are not useful for listing and cursor output.

**Data flow**: It receives a timestamp, computes the nearest lower millisecond nanosecond value, replaces the timestamp’s nanosecond field, and returns the adjusted timestamp if valid.

**Call relations**: file_modified_time calls this before handing modification times to sorting and formatting code.

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

**Purpose**: Finds a rollout file for a thread UUID inside either the active sessions folder or the archived sessions folder. It prefers the state database but has careful fallbacks when the database is missing, stale, or wrong.

**Data flow**: It receives Codex home, a subdirectory name, an ID string, and an optional state database runtime. It validates the UUID, tries a database lookup and verifies the file’s metadata, then falls back to filename scanning and finally content search; when a fallback succeeds, it asks the state database repair code to record the corrected path.

**Call relations**: find_thread_path_by_id_str and find_archived_thread_path_by_id_str are thin wrappers around this. It calls read_session_meta_line for verification, find_rollout_path_by_id_from_filenames for faster disk fallback, and read_repair_rollout_path after a successful fallback.

*Call graph*: calls 4 internal fn (from_string, find_rollout_path_by_id_from_filenames, read_session_meta_line, read_repair_rollout_path); called by 2 (find_archived_thread_path_by_id_str, find_thread_path_by_id_str); 11 external calls (default, new, to_path_buf, parse_str, record_fallback, existing_rollout_path, run, debug!, error!, warn! (+1 more)).


##### `find_rollout_path_by_id_from_filenames`  (lines 1426–1464)

```
async fn find_rollout_path_by_id_from_filenames(
    root: &Path,
    id_str: &str,
) -> io::Result<Option<PathBuf>>
```

**Purpose**: Searches a rollout directory tree for a file whose filename contains the target UUID. This is faster than searching file contents because it only inspects names.

**Data flow**: It receives a root path and ID string, parses the target UUID, walks directories with an explicit stack, recognizes rollout files, parses each filename’s UUID, and returns the first matching path.

**Call relations**: find_thread_path_by_id_str_in_subdir uses this as its first disk fallback after a database lookup fails or cannot be trusted.

*Call graph*: calls 2 internal fn (from_path, parse_timestamp_uuid_from_filename); called by 1 (find_thread_path_by_id_str_in_subdir); 3 external calls (parse_str, read_dir, vec!).


##### `find_thread_path_by_id_str`  (lines 1469–1475)

```
async fn find_thread_path_by_id_str(
    codex_home: &Path,
    id_str: &str,
    state_db_ctx: Option<&codex_state::StateRuntime>,
) -> io::Result<Option<PathBuf>>
```

**Purpose**: Finds an active, non-archived thread rollout file by UUID string. It is the public helper for normal session lookup.

**Data flow**: It receives Codex home, an ID string, and an optional state database runtime, then calls find_thread_path_by_id_str_in_subdir with the active sessions subdirectory. It returns an optional path or an I/O error.

**Call relations**: Cleanup and metadata lookup code call this when they need to resolve a thread ID to its rollout file.

*Call graph*: calls 1 internal fn (find_thread_path_by_id_str_in_subdir); called by 2 (cleanup_stale_snapshots, find_thread_meta_by_name_str).


##### `find_archived_thread_path_by_id_str`  (lines 1478–1485)

```
async fn find_archived_thread_path_by_id_str(
    codex_home: &Path,
    id_str: &str,
    state_db_ctx: Option<&codex_state::StateRuntime>,
) -> io::Result<Option<PathBuf>>
```

**Purpose**: Finds an archived thread rollout file by UUID string. It is the archived-session counterpart to find_thread_path_by_id_str.

**Data flow**: It receives Codex home, an ID string, and an optional state database runtime, then calls find_thread_path_by_id_str_in_subdir with the archived sessions subdirectory.

**Call relations**: Callers use this when they specifically want archived thread records rather than active sessions.

*Call graph*: calls 1 internal fn (find_thread_path_by_id_str_in_subdir).


##### `rollout_date_parts`  (lines 1488–1495)

```
fn rollout_date_parts(file_name: &OsStr) -> Option<(String, String, String)>
```

**Purpose**: Extracts the year, month, and day folder names from a rollout filename. This helps place or reason about files in the nested date layout.

**Data flow**: It receives an OsStr filename, converts it to text, reads the date portion after the rollout prefix, slices out year, month, and day strings, and returns them if the name is shaped as expected.

**Call relations**: This is a small filename utility for code that needs to map a rollout file name back to its date-directory components.

*Call graph*: 1 external calls (to_string_lossy).


### `rollout/src/recorder.rs`

`io_transport` · `cross-cutting: session start, live recording, resume, listing, shutdown`

A “rollout” is the saved diary of a Codex session. Each line is one JSON record, so tools and later Codex runs can read the conversation back in order. This file is the main recorder for that diary.

For a new session, it chooses a filename under the Codex home directory, builds the first metadata record, and waits until the session really needs to be saved. For a resumed session, it opens the existing rollout file and appends to it. Actual writing happens in a background task, so the user-facing session is not slowed down by disk writes. The design is like a mail slot: callers drop records into a queue, and one writer task picks them up and writes them safely.

The file is careful about failure. If writing fails, it keeps unwritten records in memory, closes the bad file handle, and tries to reopen the file on the next persist or flush. It also knows how to read old rollout files, skip one legacy record type, and recover a session history.

For listing sessions, it prefers the state database, but scans rollout files when the database is missing, stale, or filtered results need repair.

#### Function details

##### `RolloutWriterTask::new`  (lines 120–125)

```
fn new() -> Self
```

**Purpose**: Creates the small shared status object used to watch the background writer task. It starts with no task handle and no recorded fatal error.

**Data flow**: No outside data goes in. It builds empty lock-protected fields, then returns a fresh writer-task status object.

**Call relations**: RolloutRecorder::new creates this before spawning the background writer, so later recorder clones can see whether that writer has failed.

*Call graph*: called by 1 (new); 1 external calls (new).


##### `RolloutWriterTask::set_handle`  (lines 128–134)

```
fn set_handle(&self, handle: JoinHandle<()>)
```

**Purpose**: Stores the handle for the spawned background task. This keeps the task associated with the recorder for as long as recorder clones exist.

**Data flow**: It receives a task handle, locks the stored handle slot, and replaces the empty slot with that handle. It returns nothing and only changes this shared state.

**Call relations**: After RolloutRecorder::new spawns the writer task, it calls this to remember the task it just created.


##### `RolloutWriterTask::mark_failed`  (lines 137–143)

```
fn mark_failed(&self, err: &IoError)
```

**Purpose**: Records that the background writer stopped with a serious error. Future recorder calls can then report the real writer failure instead of a vague channel error.

**Data flow**: It receives an input/output error, copies its kind and message, stores that copy in shared state, and returns nothing.

**Call relations**: The spawned writer task calls this if rollout_writer returns a terminal error. It uses clone_io_error so the same error information can be reused later.

*Call graph*: calls 1 internal fn (clone_io_error); 1 external calls (new).


##### `RolloutWriterTask::terminal_failure`  (lines 146–152)

```
fn terminal_failure(&self) -> Option<IoError>
```

**Purpose**: Returns the stored fatal writer error, if one has happened. Recorder methods use this to give callers a meaningful error.

**Data flow**: It reads the shared error slot. If an error is present, it returns a fresh copy; otherwise it returns nothing.

**Call relations**: The public recorder methods consult this when sending to, or waiting on, the background writer fails.


##### `clone_io_error`  (lines 155–157)

```
fn clone_io_error(err: &IoError) -> IoError
```

**Purpose**: Makes a new input/output error with the same broad kind and text as another one. This is needed because standard I/O errors are not cheaply shareable by themselves.

**Data flow**: It reads the original error’s kind and message, then builds and returns a new error containing those details.

**Call relations**: RolloutWriterTask::mark_failed uses this before storing an error for later API calls.

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

**Purpose**: Builds the settings for starting a brand-new recorded session. It gathers the session identity, parent or fork information, source details, base instructions, and available dynamic tools.

**Data flow**: Caller-supplied session details go in. The function packages them into a Create parameter value with no multi-agent version set yet.

**Call relations**: Session creation code and tests use this before calling RolloutRecorder::new.

*Call graph*: called by 4 (find_locates_rollout_file_written_by_recorder, persist_reports_filesystem_error_and_retries_buffered_items, recorder_materializes_on_flush_with_pending_items, create_thread).


##### `RolloutRecorderParams::with_multi_agent_version`  (lines 181–193)

```
fn with_multi_agent_version(
        mut self,
        multi_agent_version: Option<MultiAgentVersion>,
    ) -> Self
```

**Purpose**: Adds optional multi-agent version information to parameters for a new session. It leaves resume parameters unchanged.

**Data flow**: It receives existing parameters and an optional version. If the parameters describe a new session, it stores that version and returns the updated parameters.

**Call relations**: This is a builder-style step used before RolloutRecorder::new when multi-agent metadata should be written into the session record.


##### `RolloutRecorderParams::resume`  (lines 195–197)

```
fn resume(path: PathBuf) -> Self
```

**Purpose**: Builds the settings for appending to an existing rollout file. Use this when continuing a saved session rather than creating a new one.

**Data flow**: A file path goes in. The function returns a Resume parameter value containing that path.

**Call relations**: Resume flows pass this into RolloutRecorder::new so the recorder opens the existing rollout instead of choosing a new filename.

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

**Purpose**: Lists active saved sessions for display to a user. It supports paging, sorting, filtering by source, model provider, working directory, and search text.

**Data flow**: It receives configuration, optional database access, paging and filter choices. It forwards those choices to the shared listing routine and returns a page of thread summaries.

**Call relations**: User-facing thread list code and tests call this. It delegates the real database-versus-filesystem decision to RolloutRecorder::list_threads_with_db_fallback.

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

**Purpose**: Lists active saved sessions using only the state database path. This avoids scanning rollout JSON files for repair.

**Data flow**: It receives the same listing inputs as list_threads, but asks the shared routine to use database-only repair mode. It returns a page, or an empty/default page if the database path cannot answer.

**Call relations**: Thread-list endpoints use this when they explicitly want the state database view. The common work still happens in RolloutRecorder::list_threads_with_db_fallback.

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

**Purpose**: Lists archived saved sessions instead of active ones. Archived sessions live in a separate directory.

**Data flow**: It receives paging, sorting, and filter inputs, marks the request as archived, and returns a page of archived thread summaries.

**Call relations**: The rollout thread listing flow calls this for archived views, while the shared listing routine handles repair and fallback.

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

**Purpose**: Lists archived sessions from the state database without scanning files for repair. This is the database-only version of archived listing.

**Data flow**: It passes the listing inputs to the shared routine with archived and state-database-only flags, then returns the resulting page.

**Call relations**: Archive list callers use this when they want the database result directly. The deeper work is still centralized in RolloutRecorder::list_threads_with_db_fallback.

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

**Purpose**: Chooses the safest way to list sessions: prefer the state database, scan rollout files when needed, and repair stale database rows when possible. This keeps the session list useful even if the database is missing or out of date.

**Data flow**: Listing options go in. It may scan JSONL files, query the database, reconcile mismatches, overlay missing metadata, and then returns a ThreadsPage with items and a next-page cursor.

**Call relations**: All active and archived listing entry points call this. It hands off file scanning to list_threads_from_files_asc or list_threads_from_files_desc, database work to state_db helpers, and metadata filling to fill_missing_thread_item_metadata_from_state_db.

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

**Purpose**: Finds the newest saved session that can be resumed, optionally only if it belongs to a given working directory. This is used for “resume last conversation” behavior.

**Data flow**: It receives config, optional database access, filters, and an optional target directory. It searches database pages first, then filesystem pages if needed, and returns the chosen rollout path or nothing.

**Call relations**: Resume code calls this before opening a session. It asks select_resume_path_from_db_page or select_resume_path to pick a valid candidate from each page.

*Call graph*: calls 4 internal fn (get_threads, select_resume_path, select_resume_path_from_db_page, list_threads_db); 2 external calls (record_fallback, codex_home).


##### `RolloutRecorder::new`  (lines 672–784)

```
async fn new(
        config: &impl RolloutConfigView,
        params: RolloutRecorderParams,
    ) -> std::io::Result<Self>
```

**Purpose**: Creates a recorder for either a new session or a resumed one. It sets up the rollout path, optional first metadata record, and a background task that performs disk writes.

**Data flow**: Configuration and create/resume parameters go in. For new sessions it precomputes a file path and metadata; for resumed sessions it opens the existing file. It returns a RolloutRecorder with a command channel to the writer task.

**Call relations**: Session creation and resume flows call this. It prepares data with precompute_log_file_info or compression helpers, spawns rollout_writer, and stores task status in RolloutWriterTask.

*Call graph*: calls 5 internal fn (originator, materialize_rollout_for_append, new, precompute_log_file_info, rollout_writer); called by 6 (find_locates_rollout_file_written_by_recorder, resume_materializes_compressed_rollout_path, persist_reports_filesystem_error_and_retries_buffered_items, recorder_materializes_on_flush_with_pending_items, create_thread, resume_thread); 10 external calls (clone, new, env!, error!, format_description!, cwd, generate_memories, model_provider_id, new, spawn).


##### `RolloutRecorder::rollout_path`  (lines 786–788)

```
fn rollout_path(&self) -> &Path
```

**Purpose**: Returns the path where this recorder writes its rollout file. Callers use it when they need to show, index, or later reopen the saved session.

**Data flow**: It reads the recorder’s stored path and returns it as a borrowed path reference. Nothing is changed.

**Call relations**: This is a simple accessor used by code that already has a recorder and needs to know where its session is being saved.

*Call graph*: 1 external calls (as_path).


##### `RolloutRecorder::record_canonical_items`  (lines 790–802)

```
async fn record_canonical_items(&self, items: &[RolloutItem]) -> std::io::Result<()>
```

**Purpose**: Queues one or more session records to be written in order. These are the official history items that make later replay possible.

**Data flow**: A slice of rollout items goes in. Empty input is ignored; otherwise the items are copied into a command and sent to the background writer. The result says whether queuing succeeded.

**Call relations**: Live session code calls this as the conversation progresses. The background rollout_writer receives the AddItems command and appends the items to its pending queue.

*Call graph*: 4 external calls (send, is_empty, to_vec, AddItems).


##### `RolloutRecorder::persist`  (lines 808–823)

```
async fn persist(&self) -> std::io::Result<()>
```

**Purpose**: Forces a new deferred rollout to be materialized on disk and writes all buffered records. It is safe to call more than once.

**Data flow**: No item data goes in directly. It sends a Persist command with a one-time reply channel, waits for the writer’s answer, and returns success or the write error.

**Call relations**: Callers use this when a session must definitely exist on disk. rollout_writer receives the command and asks RolloutWriterState::persist to do the actual work.

*Call graph*: 2 external calls (send, channel).


##### `RolloutRecorder::flush`  (lines 829–844)

```
async fn flush(&self) -> std::io::Result<()>
```

**Purpose**: Waits until all queued rollout records have been written and flushed to disk. This gives callers a durability checkpoint.

**Data flow**: It sends a Flush command to the writer and waits on a one-time reply. The output is success, or an error if writing and retrying failed.

**Call relations**: Session code calls this before important transitions or shutdown. rollout_writer passes the request to RolloutWriterState::flush.

*Call graph*: 2 external calls (send, channel).


##### `RolloutRecorder::load_rollout_items`  (lines 846–903)

```
async fn load_rollout_items(
        path: &Path,
    ) -> std::io::Result<(Vec<RolloutItem>, Option<ThreadId>, usize)>
```

**Purpose**: Reads a rollout file back into memory as session history. It tolerates bad lines by counting them and skips a known old “ghost snapshot” record shape.

**Data flow**: A rollout path goes in. The function opens a line reader, parses each non-empty JSON line into a RolloutItem, remembers the first session ID, counts parse errors, and returns the items, thread ID, and error count.

**Call relations**: Resume, metadata extraction, tests, and cwd matching use this. It relies on compression readers and strip_legacy_ghost_snapshot_rollout_line before parsing each line.

*Call graph*: calls 2 internal fn (open_rollout_line_reader, strip_legacy_ghost_snapshot_rollout_line); called by 13 (thread_id_from_rollout, sample, append_rollout_item_materializes_compressed_rollout, load_rollout_items_reads_compressed_rollout, resume_materializes_compressed_rollout_path, worker_skips_existing_compressed_archived_rollouts, extract_metadata_from_rollout, resume_candidate_matches_cwd, load_rollout_items_filters_legacy_ghost_snapshots_from_compaction_history, load_rollout_items_preserves_legacy_guardian_assessment_lines (+3 more)); 6 external calls (new, other, from_str, trace!, debug!, warn!).


##### `RolloutRecorder::get_rollout_history`  (lines 905–920)

```
async fn get_rollout_history(path: &Path) -> std::io::Result<InitialHistory>
```

**Purpose**: Turns a saved rollout file into the initial history object used when resuming a session. It also reports an error if the file does not contain a session ID.

**Data flow**: A path goes in. It loads rollout items, extracts the conversation ID, and returns InitialHistory::Resumed with the items and plain rollout path; an empty item list becomes InitialHistory::New.

**Call relations**: Thread resume and history-related tests call this. It is a thin resume-focused wrapper around RolloutRecorder::load_rollout_items.

*Call graph*: called by 10 (thread_inject_items_adds_raw_response_items_to_thread_history, record_context_updates_and_set_reference_context_item_persists_baseline_without_emitting_diffs, record_context_updates_and_set_reference_context_item_persists_full_reinjection_to_rollout, record_context_updates_and_set_reference_context_item_persists_split_file_system_policy_to_rollout, thread_rollback_drops_last_turn_from_history, thread_rollback_persists_marker_and_replays_cumulatively, interrupted_fork_snapshot_does_not_synthesize_turn_id_for_legacy_history, interrupted_fork_snapshot_preserves_explicit_turn_id, interrupted_fork_snapshot_uses_persisted_mid_turn_history_without_live_source, resume_materializes_compressed_rollout_path); 4 external calls (load_rollout_items, plain_rollout_path, info!, Resumed).


##### `RolloutRecorder::shutdown`  (lines 925–947)

```
async fn shutdown(&self) -> std::io::Result<()>
```

**Purpose**: Asks the background writer to drain pending records and then stop. If draining fails, the writer is kept alive so another retry can happen.

**Data flow**: It sends a Shutdown command with a reply channel. On success it returns after the writer has flushed and exited; on failure it returns the writer or channel error.

**Call relations**: Session teardown calls this. rollout_writer handles the command by calling RolloutWriterState::shutdown and only breaks its loop after success.

*Call graph*: 5 external calls (send, other, format!, channel, warn!).


##### `strip_legacy_ghost_snapshot_rollout_line`  (lines 950–967)

```
fn strip_legacy_ghost_snapshot_rollout_line(value: &mut Value) -> bool
```

**Purpose**: Removes or skips an old rollout record type that current code no longer wants to load. This keeps older session files from breaking resume.

**Data flow**: A mutable JSON value goes in. If it is a standalone legacy ghost snapshot, the function reports that the whole line should be skipped; if it is inside compacted history, it removes those entries in place.

**Call relations**: RolloutRecorder::load_rollout_items calls this before converting raw JSON into modern RolloutLine data.

*Call graph*: called by 1 (load_rollout_items); 2 external calls (get, get_mut).


##### `is_legacy_ghost_snapshot_response_item`  (lines 969–971)

```
fn is_legacy_ghost_snapshot_response_item(value: &Value) -> bool
```

**Purpose**: Recognizes the old ghost snapshot response item shape. It exists so both standalone and nested legacy records can be detected the same way.

**Data flow**: A JSON value goes in. The function checks its type field and returns true only for ghost_snapshot.

**Call relations**: strip_legacy_ghost_snapshot_rollout_line uses this when deciding what to skip or remove.

*Call graph*: 1 external calls (get).


##### `truncate_fs_page`  (lines 973–992)

```
fn truncate_fs_page(
    mut page: ThreadsPage,
    page_size: usize,
    sort_key: ThreadSortKey,
) -> ThreadsPage
```

**Purpose**: Cuts a filesystem-scanned page down to the requested size and builds the cursor for the next page. This is needed because descending scans may intentionally fetch extra rows.

**Data flow**: A page, size, and sort key go in. If the page is too long, it removes items after the limit and sets the next cursor from the last remaining item.

**Call relations**: page_from_filesystem_scan calls this when adapting filesystem results for descending sort order.

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

**Purpose**: Normalizes a page returned by filesystem scanning. Ascending scans are already the requested size; descending scans may need trimming.

**Data flow**: A scanned page plus sort settings go in. It returns the page unchanged for ascending order or a truncated page for descending order.

**Call relations**: RolloutRecorder::list_threads_with_db_fallback uses this whenever it must return filesystem results instead of a database page.

*Call graph*: calls 1 internal fn (truncate_fs_page); called by 1 (list_threads_with_db_fallback).


##### `fill_missing_thread_item_metadata_from_state_db`  (lines 1006–1032)

```
async fn fill_missing_thread_item_metadata_from_state_db(
    state_db_ctx: Option<&StateRuntime>,
    mut page: ThreadsPage,
) -> ThreadsPage
```

**Purpose**: Improves filesystem-scanned thread summaries with metadata from the state database. This gives file fallback results richer titles, previews, model information, and timestamps when available.

**Data flow**: An optional database runtime and a page go in. For each item with a thread ID, it fetches stored metadata and fills only missing or better fields, then returns the updated page.

**Call relations**: RolloutRecorder::list_threads_with_db_fallback calls this when returning filesystem-backed filtered results.

*Call graph*: calls 2 internal fn (fill_missing_thread_item_metadata, thread_item_from_state_metadata); called by 1 (list_threads_with_db_fallback); 1 external calls (warn!).


##### `fill_missing_thread_item_metadata`  (lines 1034–1096)

```
fn fill_missing_thread_item_metadata(item: &mut ThreadItem, state_item: ThreadItem)
```

**Purpose**: Copies useful metadata from a database-backed thread item into a filesystem-backed thread item without overwriting fields that are already present, except for git details where newer values replace blanks.

**Data flow**: A mutable thread item and a state-derived thread item go in. Missing fields such as preview, cwd, source, agent role, provider, and times are filled in place.

**Call relations**: fill_missing_thread_item_metadata_from_state_db calls this after converting database metadata into the same ThreadItem shape.

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

**Purpose**: Lists rollout files from newest to oldest, with optional title search support. Search requires scanning extra pages because matching is done after the basic file listing.

**Data flow**: Directory, paging, sorting, filter, archive, and search inputs go in. It gathers file-backed thread items, optionally filters by search term, trims to page size, and returns a ThreadsPage.

**Call relations**: RolloutRecorder::list_threads_with_db_fallback uses this for descending file fallback. list_threads_from_files_asc also uses it as a building block.

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

**Purpose**: Performs the basic newest-first file scan without search filtering. It knows whether to read active sessions or archived sessions.

**Data flow**: Codex home, paging, sort, filters, and archive flag go in. It calls the appropriate lower-level scanner and returns the page it finds.

**Call relations**: list_threads_from_files_desc calls this before any search-term filtering is applied.

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

**Purpose**: Lists rollout files from oldest to newest. Because the lower-level file scanner is newest-first, it gathers results, sorts them, and then applies the ascending cursor.

**Data flow**: Listing settings go in. It repeatedly scans descending pages, optionally filters by search term, sorts all found items by the requested time key, applies the cursor, and returns one ascending page.

**Call relations**: RolloutRecorder::list_threads_with_db_fallback calls this when the requested sort direction is ascending.

*Call graph*: calls 2 internal fn (filter_thread_items_by_search_term, list_threads_from_files_desc); called by 1 (list_threads_with_db_fallback); 1 external calls (new).


##### `filter_thread_items_by_search_term`  (lines 1295–1318)

```
async fn filter_thread_items_by_search_term(
    codex_home: &Path,
    items: &mut Vec<ThreadItem>,
    search_term: Option<&str>,
) -> std::io::Result<()>
```

**Purpose**: Filters file-backed thread summaries by title. The file scan itself only has thread IDs, so this looks titles up in the sidecar session index.

**Data flow**: Codex home, a mutable item list, and an optional search term go in. If there is a search term, it loads names for the listed thread IDs and removes items whose title does not contain the term.

**Call relations**: Both ascending and descending file-listing helpers call this so filesystem fallback behaves like database search.

*Call graph*: calls 1 internal fn (find_thread_names_by_ids); called by 2 (list_threads_from_files_asc, list_threads_from_files_desc).


##### `thread_item_sort_key`  (lines 1320–1334)

```
fn thread_item_sort_key(
    item: &ThreadItem,
    sort_key: ThreadSortKey,
) -> Option<(OffsetDateTime, uuid::Uuid)>
```

**Purpose**: Computes the timestamp used to sort a thread item, plus the UUID from its filename as a tie-breaker. This gives stable ordering for file-backed pages.

**Data flow**: A thread item and sort key go in. It reads the rollout filename and, for updated-at sorting, the item timestamps, then returns a sortable pair or nothing if required data is missing.

**Call relations**: cursor_from_thread_item uses this to build page cursors, and ascending listing uses the same idea when sorting collected items.

*Call graph*: calls 1 internal fn (parse_timestamp_uuid_from_filename); called by 1 (cursor_from_thread_item); 1 external calls (parse).


##### `cursor_from_thread_item`  (lines 1336–1340)

```
fn cursor_from_thread_item(item: &ThreadItem, sort_key: ThreadSortKey) -> Option<Cursor>
```

**Purpose**: Builds a pagination cursor from a thread item. A cursor is the marker that says where the next page should continue.

**Data flow**: A thread item and sort key go in. It gets the item’s sort timestamp, formats it, parses it into a Cursor, and returns that cursor if all steps work.

**Call relations**: File-listing helpers use this when they need to report that more matching results may be available.

*Call graph*: calls 2 internal fn (parse_cursor, thread_item_sort_key).


##### `precompute_log_file_info`  (lines 1353–1383)

```
fn precompute_log_file_info(
    config: &impl RolloutConfigView,
    conversation_id: ThreadId,
) -> std::io::Result<LogFileInfo>
```

**Purpose**: Chooses the rollout filename and directory for a new session before the file is actually created. The path includes the date and conversation ID.

**Data flow**: Configuration and a conversation ID go in. It reads the current local time, builds a dated sessions path, formats a rollout filename, and returns the path, ID, and timestamp.

**Call relations**: RolloutRecorder::new calls this for newly created sessions so metadata and the future file path are ready up front.

*Call graph*: called by 1 (new); 4 external calls (now_local, format!, format_description!, codex_home).


##### `open_log_file`  (lines 1385–1398)

```
fn open_log_file(path: &Path) -> std::io::Result<File>
```

**Purpose**: Opens a rollout file for appending, creating its parent directories if needed. It also materializes a compressed rollout into an appendable plain file when necessary.

**Data flow**: A path goes in. The function prepares the path, creates missing directories, opens the file in append/create mode, and returns the standard file handle.

**Call relations**: RolloutWriterState::ensure_writer_open calls this whenever deferred creation or recovery needs a usable file handle.

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

**Purpose**: Creates the mutable state owned by the background writer task. This state holds the open file, buffered records, first metadata record, and recovery bookkeeping.

**Data flow**: Optional file, optional deferred file info, metadata, cwd, and rollout path go in. It wraps an existing file in a JsonlWriter if present and initializes an empty pending queue.

**Call relations**: rollout_writer creates this when its task starts, and tests can construct it directly for retry behavior.

*Call graph*: called by 2 (rollout_writer, writer_state_retries_write_error_before_reporting_flush_success); 1 external calls (new).


##### `RolloutWriterState::add_items`  (lines 1434–1436)

```
fn add_items(&mut self, items: Vec<RolloutItem>)
```

**Purpose**: Adds newly queued rollout records to the writer’s in-memory pending queue. They stay there until a successful write removes them.

**Data flow**: A vector of rollout items goes in. The function appends them to pending_items and returns nothing.

**Call relations**: rollout_writer calls this after receiving an AddItems command from RolloutRecorder::record_canonical_items.


##### `RolloutWriterState::flush_if_materialized`  (lines 1438–1445)

```
async fn flush_if_materialized(&mut self)
```

**Purpose**: Best-effort writes pending items only if the rollout file already exists or is open. It avoids creating a deferred new-session file too early.

**Data flow**: It reads the writer state. If still deferred, it does nothing; otherwise it tries to flush and enters recovery mode if that fails.

**Call relations**: rollout_writer calls this after AddItems so resumed or already-persisted sessions keep writing continuously.

*Call graph*: calls 3 internal fn (enter_recovery_mode, flush, is_deferred).


##### `RolloutWriterState::persist`  (lines 1447–1449)

```
async fn persist(&mut self) -> std::io::Result<()>
```

**Purpose**: Writes all pending data and creates the rollout file if it was deferred. This is the state-level implementation of an explicit persist request.

**Data flow**: It uses the current pending queue, metadata, and file info. It writes through the recovery wrapper and returns success or an input/output error.

**Call relations**: rollout_writer calls this when it receives a Persist command from RolloutRecorder::persist.

*Call graph*: calls 1 internal fn (write_pending_with_recovery).


##### `RolloutWriterState::flush`  (lines 1451–1456)

```
async fn flush(&mut self) -> std::io::Result<()>
```

**Purpose**: Writes all pending records if there is anything to write. If a new session is still deferred and empty, it succeeds without creating a file.

**Data flow**: It checks whether the writer is deferred and whether pending_items is empty. If writing is needed, it calls the recovery wrapper and returns the result.

**Call relations**: RolloutWriterState::flush_if_materialized and rollout_writer’s Flush command both use this.

*Call graph*: calls 2 internal fn (is_deferred, write_pending_with_recovery); called by 1 (flush_if_materialized).


##### `RolloutWriterState::shutdown`  (lines 1458–1463)

```
async fn shutdown(&mut self) -> std::io::Result<()>
```

**Purpose**: Writes pending records as part of stopping the writer. Like flush, it does not create an empty deferred rollout file.

**Data flow**: It inspects deferred state and pending items. If data exists, it writes with recovery; otherwise it returns success immediately.

**Call relations**: rollout_writer calls this for a Shutdown command and only exits the command loop if it succeeds.

*Call graph*: calls 2 internal fn (is_deferred, write_pending_with_recovery).


##### `RolloutWriterState::write_pending_with_recovery`  (lines 1465–1490)

```
async fn write_pending_with_recovery(&mut self, operation: &str) -> std::io::Result<()>
```

**Purpose**: Tries to write pending data, and if the first attempt fails, closes the current writer, reopens it, and tries once more. This protects against transient file-handle problems.

**Data flow**: An operation name goes in for logging. It attempts write_pending_once; on error it enters recovery mode, retries once, clears the stored error on success, or returns the second error.

**Call relations**: persist, flush, and shutdown all use this so their error handling is consistent.

*Call graph*: calls 2 internal fn (enter_recovery_mode, write_pending_once); called by 3 (flush, persist, shutdown); 1 external calls (warn!).


##### `RolloutWriterState::is_deferred`  (lines 1492–1494)

```
fn is_deferred(&self) -> bool
```

**Purpose**: Checks whether this writer is waiting to create a new rollout file later. Deferred means there is no open writer yet but precomputed file information exists.

**Data flow**: It reads the writer and deferred-info fields and returns true or false.

**Call relations**: flush_if_materialized, flush, and shutdown use this to avoid creating empty rollout files unnecessarily.

*Call graph*: called by 3 (flush, flush_if_materialized, shutdown).


##### `RolloutWriterState::enter_recovery_mode`  (lines 1496–1509)

```
fn enter_recovery_mode(&mut self, err: &IoError)
```

**Purpose**: Records a write failure and drops the current file writer so the next attempt will reopen the file. This keeps unwritten items buffered for retry.

**Data flow**: An error goes in. The function logs it if it is new, saves its message, sets writer to none, and returns nothing.

**Call relations**: flush_if_materialized and write_pending_with_recovery call this after write failures.

*Call graph*: called by 2 (flush_if_materialized, write_pending_with_recovery); 2 external calls (to_string, error!).


##### `RolloutWriterState::ensure_writer_open`  (lines 1511–1527)

```
async fn ensure_writer_open(&mut self) -> std::io::Result<()>
```

**Purpose**: Makes sure there is an open JsonlWriter before writing. It creates the deferred file or reopens the rollout path after recovery.

**Data flow**: It reads existing writer state. If already open it returns success; otherwise it opens the right path, wraps the file for async writing, clears deferred info, and returns success or an error.

**Call relations**: write_pending_once calls this before writing metadata or queued items.

*Call graph*: calls 1 internal fn (open_log_file); called by 1 (write_pending_once); 2 external calls (as_path, from_std).


##### `RolloutWriterState::write_session_meta_if_needed`  (lines 1529–1536)

```
async fn write_session_meta_if_needed(&mut self) -> std::io::Result<()>
```

**Purpose**: Writes the first session metadata record once, before normal pending items. This record identifies the session and captures startup context.

**Data flow**: It reads the optional metadata field. If present, it writes it with git information, then clears the field so it is not written again.

**Call relations**: write_pending_once calls this after opening the writer and before writing queued rollout items.

*Call graph*: calls 1 internal fn (write_session_meta); called by 1 (write_pending_once).


##### `RolloutWriterState::write_pending_once`  (lines 1538–1548)

```
async fn write_pending_once(&mut self) -> std::io::Result<()>
```

**Purpose**: Performs one straight write attempt without retry logic. It opens the writer, writes session metadata if needed, writes pending items, and flushes the file.

**Data flow**: It uses the state’s file, metadata, and pending queue. Successfully written items are removed; errors are returned for the recovery wrapper to handle.

**Call relations**: write_pending_with_recovery calls this for the first attempt and, if needed, the retry.

*Call graph*: calls 3 internal fn (ensure_writer_open, write_pending_items_once, write_session_meta_if_needed); called by 1 (write_pending_with_recovery).


##### `RolloutWriterState::write_pending_items_once`  (lines 1550–1570)

```
async fn write_pending_items_once(&mut self) -> std::io::Result<()>
```

**Purpose**: Writes queued rollout items in order and removes only the items that were successfully written. This preserves the unwritten suffix after an error.

**Data flow**: It reads pending_items and the open writer. It writes each item until one fails, drains the written prefix from the queue, and returns success or the first write error.

**Call relations**: write_pending_once calls this after metadata is handled.

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

**Purpose**: Runs the background loop that owns the rollout file and processes recording commands. It is the single place that actually mutates writer state.

**Data flow**: Initial file/deferred info, metadata, cwd, path, and a command receiver go in. It receives commands, updates or flushes RolloutWriterState, sends acknowledgements for barrier commands, and exits after successful shutdown.

**Call relations**: RolloutRecorder::new spawns this task. Recorder methods communicate with it by sending RolloutCmd messages.

*Call graph*: calls 2 internal fn (recv, new); called by 1 (new).


##### `write_session_meta`  (lines 1611–1635)

```
async fn write_session_meta(
    mut writer: Option<&mut JsonlWriter>,
    session_meta: SessionMeta,
    cwd: &Path,
) -> std::io::Result<()>
```

**Purpose**: Writes the session metadata line, including git information when the working directory is inside a git repository. This makes saved sessions easier to understand later.

**Data flow**: An optional writer, session metadata, and cwd go in. It collects git branch/commit/remote details if available, wraps everything as a SessionMeta rollout item, and writes it if a writer exists.

**Call relations**: RolloutWriterState::write_session_meta_if_needed calls this before the first normal session records are written.

*Call graph*: called by 1 (write_session_meta_if_needed); 3 external calls (collect_git_info, get_git_repo_root, SessionMeta).


##### `append_rollout_item_to_path`  (lines 1642–1653)

```
async fn append_rollout_item_to_path(
    rollout_path: &Path,
    item: &RolloutItem,
) -> std::io::Result<()>
```

**Purpose**: Appends one rollout item directly to an existing rollout file. This is for metadata updates to sessions that are not currently loaded.

**Data flow**: A rollout path and item go in. It materializes the file if compressed, opens it for append, writes the item as JSONL, and returns the write result.

**Call relations**: This bypasses RolloutRecorder’s live queue by design; live sessions should use record_canonical_items to preserve ordering.

*Call graph*: calls 1 internal fn (materialize_rollout_for_append); 1 external calls (new).


##### `JsonlWriter::write_rollout_item`  (lines 1667–1680)

```
async fn write_rollout_item(&mut self, rollout_item: &RolloutItem) -> std::io::Result<()>
```

**Purpose**: Writes one rollout item as a timestamped JSON Lines record. The timestamp records when this line was appended.

**Data flow**: A rollout item goes in. It creates the current UTC timestamp, builds a serializable line object, and passes it to write_line.

**Call relations**: RolloutWriterState and append_rollout_item_to_path use this for every rollout item written to disk.

*Call graph*: calls 1 internal fn (write_line); 2 external calls (now_utc, format_description!).


##### `JsonlWriter::write_line`  (lines 1681–1687)

```
async fn write_line(&mut self, item: &impl serde::Serialize) -> std::io::Result<()>
```

**Purpose**: Serializes one value to JSON, adds a newline, writes it to the file, and flushes it. This is the lowest-level JSONL write step.

**Data flow**: Any serializable item goes in. It becomes a JSON string plus newline, then bytes are written to the async file and flushed.

**Call relations**: JsonlWriter::write_rollout_item calls this after adding rollout-specific timestamp wrapping.

*Call graph*: called by 1 (write_rollout_item); 3 external calls (flush, write_all, to_string).


##### `ThreadsPage::from`  (lines 1691–1703)

```
fn from(db_page: codex_state::ThreadsPage) -> Self
```

**Purpose**: Converts a page returned by the state database into the rollout listing page type used by this module. This lets callers receive one consistent shape.

**Data flow**: A database ThreadsPage goes in. Each database metadata row is converted into a ThreadItem, the database cursor is converted, and a new ThreadsPage comes out.

**Call relations**: RolloutRecorder::list_threads_with_db_fallback uses this conversion whenever it returns database results.


##### `thread_item_from_state_metadata`  (lines 1706–1729)

```
fn thread_item_from_state_metadata(item: codex_state::ThreadMetadata) -> ThreadItem
```

**Purpose**: Turns one database thread metadata row into a ThreadItem used by rollout listing. It also parses the stored session source, defaulting to Unknown if parsing fails.

**Data flow**: A database ThreadMetadata value goes in. The function maps paths, IDs, preview fields, cwd, git details, provider, version, and timestamps into a ThreadItem.

**Call relations**: ThreadsPage::from and fill_missing_thread_item_metadata_from_state_db use this when they need database rows in file-listing format.

*Call graph*: called by 1 (fill_missing_thread_item_metadata_from_state_db); 1 external calls (from_str).


##### `select_resume_path`  (lines 1731–1754)

```
async fn select_resume_path(
    page: &ThreadsPage,
    filter_cwd: Option<&Path>,
    default_provider: &str,
) -> Option<PathBuf>
```

**Purpose**: Chooses a rollout path from a filesystem-backed page for resume. If a working directory filter is given, it checks candidates until one matches.

**Data flow**: A ThreadsPage, optional cwd, and default provider go in. It returns the first page item when no cwd is required, or the first candidate whose saved cwd matches.

**Call relations**: RolloutRecorder::find_latest_thread_path calls this during filesystem fallback search.

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

**Purpose**: Checks whether a saved session belongs to the requested working directory. It uses cached metadata first, then falls back to reading the rollout file or extracting metadata.

**Data flow**: A rollout path, optional cached cwd, target cwd, and default provider go in. It compares normalized paths from the cache, latest turn context, or extracted metadata, and returns true or false.

**Call relations**: select_resume_path and select_resume_path_from_db_page call this when filtering resume candidates by cwd.

*Call graph*: calls 3 internal fn (extract_metadata_from_rollout, load_rollout_items, cwd_matches); called by 2 (select_resume_path, select_resume_path_from_db_page).


##### `select_resume_path_from_db_page`  (lines 1784–1807)

```
async fn select_resume_path_from_db_page(
    page: &codex_state::ThreadsPage,
    filter_cwd: Option<&Path>,
    default_provider: &str,
) -> Option<PathBuf>
```

**Purpose**: Chooses a rollout path from a database-backed page for resume. It mirrors select_resume_path but starts from database metadata rows.

**Data flow**: A database page, optional cwd, and default provider go in. It returns the first path if no cwd filter exists, or the first path whose cached or extracted cwd matches.

**Call relations**: RolloutRecorder::find_latest_thread_path calls this while trying database pages before falling back to filesystem scanning.

*Call graph*: calls 1 internal fn (resume_candidate_matches_cwd); called by 1 (find_latest_thread_path).


##### `cwd_matches`  (lines 1809–1811)

```
fn cwd_matches(session_cwd: &Path, cwd: &Path) -> bool
```

**Purpose**: Compares two working-directory paths after normalization. This avoids false mismatches caused by harmless path spelling differences.

**Data flow**: Two paths go in. The shared path utility normalizes and compares them, and a boolean comes out.

**Call relations**: resume_candidate_matches_cwd uses this for every cwd comparison it performs.

*Call graph*: called by 1 (resume_candidate_matches_cwd); 1 external calls (paths_match_after_normalization).


### Thread-store contract and test backend
These files establish the storage-neutral thread persistence API, its shared errors, and the in-memory implementation used for testing and debugging.

### `thread-store/src/error.rs`

`data_model` · `cross-cutting`

A thread store needs to fail in predictable ways. For example, someone may ask for a thread that is not saved, try an operation the store does not support, or send request data that does not make sense. This file collects those possible failures into one shared error type, `ThreadStoreError`, so callers do not have to guess how each store reports problems.

It also defines `ThreadStoreResult<T>`, a shortcut meaning “either the requested value of type `T`, or a `ThreadStoreError`.” This is a common Rust pattern: instead of throwing exceptions, functions return a result that clearly says whether the operation succeeded or failed.

The error categories are intentionally plain and stable. `ThreadNotFound` includes the requested `ThreadId`, so an error message can say exactly which thread was missing. `InvalidRequest` is for bad input from the caller. `Conflict` means the request was understandable, but it clashes with the store’s current state. `Unsupported` marks features a particular store cannot do yet. `Internal` is the fallback for unexpected implementation failures.

Without this file, different thread-store backends could describe the same failure in different ways, making higher-level code harder to write and error messages less consistent.


### `thread-store/src/lib.rs`

`other` · `cross-cutting API surface`

This file does not store threads itself. Instead, it defines the shape of the crate’s public API: the set of names other code is meant to use when working with saved conversation threads. A thread here means a persisted conversation record, identified by a durable ThreadId from codex_protocol.

The main idea is storage neutrality. Application code should not need to know whether a thread lives in local files, memory, a remote service, or another backing store. It should talk to the ThreadStore interface and pass around stable thread IDs. The concrete storage layer then figures out where the data really lives.

This file declares the internal modules that make up the crate, such as error handling, in-memory storage, local storage, live-thread support, metadata syncing, and shared request/response types. It then re-exports the important pieces with pub use, which is like putting the most useful tools on the front counter instead of making callers search through the back rooms.

Without this file, users of the crate would have to know its internal module layout and import many pieces from many places. This file keeps that boundary tidy and makes it easier to swap or add storage implementations without changing the rest of the application.


### `thread-store/src/store.rs`

`io_transport` · `cross-cutting thread persistence`

This file is the storage doorway for threads. A thread is a saved conversation or work session, and different installations may store those threads in different ways. Without this shared doorway, every part of the app would need to know the exact storage system being used, which would make changing storage backends risky and messy.

The central piece is the `ThreadStore` trait. A trait is like a checklist of promises: any storage implementation must provide these operations. The promises cover the full life of a thread: create it, reopen it, append new items, force pending data to be saved, shut down or discard a live writer, load history, read summaries, list and search threads, update metadata, archive, unarchive, and delete.

Most methods are only declared here, not implemented. That means each storage backend must decide how to do the actual saving and reading. A few newer or optional features have safe default behavior: if a backend does not support searching, listing turns, or listing items, the default answer is an “unsupported operation” error. This is like a universal adapter saying, “I understand the request, but this device cannot do that.”

The file also defines `ThreadStoreFuture`, the standard asynchronous return shape for these operations. In plain terms, store actions may take time, so they return a promise of a result instead of blocking immediately.

#### Function details

##### `ThreadStore::search_threads`  (lines 85–94)

```
fn search_threads(
        &self,
        _params: SearchThreadsParams,
    ) -> ThreadStoreFuture<'_, ThreadSearchPage>
```

**Purpose**: This is the default response when code asks a thread store to search threads, but that store has not provided search support. Instead of pretending to search, it clearly returns an “unsupported” error.

**Data flow**: A search request comes in, but this default version does not inspect the request fields. It creates an asynchronous result that immediately resolves to a `ThreadStoreError::Unsupported` error for the `thread/search` operation. Nothing is saved, changed, or read.

**Call relations**: This method is used as the fallback implementation for stores that do not override search. Its only handoff is wrapping the error in a pinned asynchronous future, so callers receive the same kind of future they would get from a real storage operation.

*Call graph*: 1 external calls (pin).


##### `ThreadStore::list_turns`  (lines 97–103)

```
fn list_turns(&self, _params: ListTurnsParams) -> ThreadStoreFuture<'_, TurnPage>
```

**Purpose**: This is the default response when code asks a thread store to list the turns inside a thread, but that store has not implemented turn-level listing. It fails in a clear, expected way rather than returning misleading empty data.

**Data flow**: A turn-listing request comes in, but the default method ignores its details. It builds an asynchronous result that resolves to an `Unsupported` error naming `list_turns`. The store’s data is left untouched.

**Call relations**: This sits in the trait as an optional capability. If a concrete store does not supply its own version, callers who ask for turn listing get this fallback; it packages the error using a pinned future so it still matches the trait’s asynchronous interface.

*Call graph*: 1 external calls (pin).


##### `ThreadStore::list_items`  (lines 106–112)

```
fn list_items(&self, _params: ListItemsParams) -> ThreadStoreFuture<'_, ItemPage>
```

**Purpose**: This is the default response when code asks a thread store to list saved items inside a turn, but that store does not support item-level listing. It tells the caller the feature is unavailable.

**Data flow**: An item-listing request arrives, but this default implementation does not use the request contents. It returns an asynchronous result containing an `Unsupported` error for `list_items`. No thread data is loaded or modified.

**Call relations**: This is the fallback path for storage implementations that have not added item listing. Like the other optional defaults, it hands back a pinned asynchronous future so higher-level code can treat it like any other store operation, even though the answer is an error.

*Call graph*: 1 external calls (pin).


### `thread-store/src/in_memory.rs`

`domain_logic` · `test/debug storage operations`

A “thread” here is a saved conversation, with metadata such as its ID, name, model, working directory, and a list of saved conversation items. Real thread stores may write to disk or talk to a remote service. This file offers a simpler stand-in: it keeps everything in hash maps protected by locks, like labeled folders in a locked cabinet.

The file supports creating a thread, resuming one, appending saved items, reading a thread back, listing known threads, updating metadata, archiving/unarchiving counters, and deleting stored data. It also records how many times each operation was called. That makes tests able to check not only “what was stored?” but also “did the code ask storage to do the right thing?”

There is also a shared registry of named in-memory stores. Tests can ask for a store by ID and get the same store back later, which mimics selecting a configured non-local store without actually running a network service.

The important limitation is that this store is temporary. It does not persist across process runs, and several operations are intentionally lightweight: archive-like methods mostly count calls, while thread contents live only in memory.

#### Function details

##### `stores`  (lines 40–42)

```
fn stores() -> &'static Mutex<HashMap<String, Arc<InMemoryThreadStore>>>
```

**Purpose**: Returns the global map of named in-memory thread stores, creating that map the first time it is needed. This lets different tests or debug configurations share a store by a simple string ID.

**Data flow**: No caller-provided data goes in. The function checks a one-time global holder; if the holder is empty, it creates a mutex-protected hash map. It returns a reference to that shared locked map.

**Call relations**: The locking helper calls this when it needs access to the registry. Higher-level functions do not use the global map directly; they go through the helper so locking is consistent.

*Call graph*: called by 1 (stores_guard).


##### `tests::default_turn_pagination_methods_return_unsupported`  (lines 57–96)

```
async fn default_turn_pagination_methods_return_unsupported()
```

**Purpose**: Checks that the default turn and item pagination methods report that they are not supported by this in-memory store. This protects callers from assuming every store implementation can page through turns and items.

**Data flow**: The test creates a default store and a sample thread ID, then asks for turns and items. Instead of successful pages, it expects specific “unsupported operation” errors.

**Call relations**: This is a test-only caller of the store’s default trait behavior. It confirms that unsupported pagination remains explicit rather than silently returning misleading empty data.

*Call graph*: calls 1 internal fn (default); 2 external calls (assert!, default).


##### `tests::list_threads_filters_by_parent_thread_id`  (lines 99–158)

```
async fn list_threads_filters_by_parent_thread_id()
```

**Purpose**: Checks that listing threads can filter children by their parent thread ID. This matters for features that show only threads belonging under a particular parent conversation.

**Data flow**: The test creates one child thread with a parent ID and one unrelated thread without that parent. It then lists threads while asking for that parent only, and expects only the child thread to come back.

**Call relations**: This test drives thread creation and the trait-level list operation. It verifies the filtering layer that sits on top of the store’s basic list of all created threads.

*Call graph*: calls 3 internal fn (default, default, from_string); 4 external calls (new, assert_eq!, default, list_threads).


##### `stores_guard`  (lines 161–166)

```
fn stores_guard() -> MutexGuard<'static, HashMap<String, Arc<InMemoryThreadStore>>>
```

**Purpose**: Locks the global store registry and returns access to it. If a previous panic poisoned the lock, it still recovers the inner map so tests can keep going.

**Data flow**: No ordinary input goes in. It asks `stores` for the shared registry, locks the mutex, and returns the guard that allows reading or changing the map.

**Call relations**: The named-store functions use this before adding, finding, or removing shared stores. It is the safe doorway into the global registry.

*Call graph*: calls 1 internal fn (stores); called by 2 (for_id, remove_id).


##### `InMemoryThreadStore::for_id`  (lines 211–218)

```
fn for_id(id: impl Into<String>) -> Arc<Self>
```

**Purpose**: Gets the shared in-memory store for a given ID, creating it if it does not already exist. This is useful when configuration says “use store X” and different parts of a test need to refer to the same fake store.

**Data flow**: A string-like ID goes in. The function locks the global registry, looks for that ID, inserts a fresh default store if missing, and returns a reference-counted pointer to the store.

**Call relations**: Configuration and tests call this when they need a named fake store. It relies on `stores_guard` for safe access to the registry and hands back an object that implements the thread-store interface.

*Call graph*: calls 1 internal fn (stores_guard); called by 8 (get_conversation_summary_by_thread_id_reads_pathless_store_thread, cold_thread_resume_reuses_non_local_history_probe, thread_delete_with_non_local_thread_store_does_not_create_local_persistence, thread_list_includes_store_thread_without_rollout_path, thread_read_loaded_include_turns_reads_store_history_without_rollout_path, thread_turns_list_reads_store_history_without_rollout_path, thread_unarchive_preserves_pathless_store_metadata, thread_store_from_config); 1 external calls (into).


##### `InMemoryThreadStore::remove_id`  (lines 221–223)

```
fn remove_id(id: &str) -> Option<Arc<Self>>
```

**Purpose**: Removes a named shared in-memory store from the global registry. Tests use this for cleanup so one test’s stored threads do not leak into another test.

**Data flow**: A store ID goes in. The function locks the registry, removes the matching entry if present, and returns the removed store pointer or nothing if there was no match.

**Call relations**: Cleanup code calls this when a named store is no longer needed. It uses the same registry lock helper as `for_id`, but deletes instead of fetching or creating.

*Call graph*: calls 1 internal fn (stores_guard); called by 4 (drop, drop, drop, drop).


##### `InMemoryThreadStore::calls`  (lines 226–228)

```
async fn calls(&self) -> InMemoryThreadStoreCalls
```

**Purpose**: Returns a snapshot of how many times each store operation has been called. Tests use this to check that code made the expected storage requests.

**Data flow**: The store instance is the input. The function locks its internal state, clones the call-count record, and returns that copy without changing the stored threads.

**Call relations**: Test code calls this after exercising behavior. It reads the counters that the other store methods increment as they run.


##### `InMemoryThreadStore::as_any`  (lines 390–392)

```
fn as_any(&self) -> &dyn std::any::Any
```

**Purpose**: Exposes this store as a generic Rust `Any` value, which allows code to later check whether a trait object is really an `InMemoryThreadStore`. This is mostly useful in tests and plumbing code.

**Data flow**: The store instance goes in by reference. The function returns the same object viewed through a more general type, without copying or changing anything.

**Call relations**: This method is part of the shared `ThreadStore` interface. Code that only has a generic thread store can use it when it needs type-specific access.


##### `InMemoryThreadStore::create_thread`  (lines 394–396)

```
fn create_thread(&self, params: CreateThreadParams) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Creates a new in-memory thread and records its starting session metadata. This gives later reads and history loads something realistic to return.

**Data flow**: Creation parameters go in, including the thread ID, source, parent or fork information, model provider, instructions, tools, and persistence metadata. The store locks its state, increments the create counter, writes an initial session metadata item into the thread history, saves the creation parameters, and returns success.

**Call relations**: Callers use this through the `ThreadStore` interface when a conversation begins. It prepares data later used by history loading, thread reading, and thread listing.

*Call graph*: calls 1 internal fn (default); called by 1 (seed_pathless_store_thread); 3 external calls (pin, matches!, SessionMeta).


##### `InMemoryThreadStore::resume_thread`  (lines 398–400)

```
fn resume_thread(&self, params: ResumeThreadParams) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Marks a thread as resumed and optionally seeds it with existing history and a rollout path. A rollout path is the file path where a conversation transcript may have been stored elsewhere.

**Data flow**: Resume parameters go in with a thread ID, optional history, and optional rollout path. The store locks its state, increments the resume counter, stores the provided history or creates an empty history slot, records the path-to-thread mapping if given, and returns success.

**Call relations**: Code calls this when reopening an existing thread. Later reads by rollout path depend on the mapping saved here.

*Call graph*: 1 external calls (pin).


##### `InMemoryThreadStore::append_items`  (lines 402–404)

```
fn append_items(&self, params: AppendThreadItemsParams) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Adds new persisted conversation items to a thread’s stored history. It ignores items that should not be persisted, matching the behavior of real rollout storage.

**Data flow**: Append parameters go in with a thread ID and raw items. The function first converts them to the canonical saved form; if nothing remains, it returns without touching counters. Otherwise it locks the state, increments the append counter, extends that thread’s history, and returns success.

**Call relations**: Conversation code calls this as new events happen. It uses the rollout item filtering helper before saving, and later `load_history` or `read_thread` can return the accumulated items.

*Call graph*: called by 1 (seed_pathless_store_thread); 2 external calls (pin, persisted_rollout_items).


##### `InMemoryThreadStore::persist_thread`  (lines 406–411)

```
fn persist_thread(&self, _thread_id: ThreadId) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Records that the caller asked to persist a thread. In this in-memory implementation there is no disk or remote service to write to, so it only counts the request.

**Data flow**: A thread ID is accepted but not otherwise used. The store locks its state, increments the persist counter, and returns success.

**Call relations**: This fulfills the `ThreadStore` interface for code paths that expect to force persistence. Tests can later inspect the call counter to confirm the request happened.

*Call graph*: 1 external calls (pin).


##### `InMemoryThreadStore::flush_thread`  (lines 413–418)

```
fn flush_thread(&self, _thread_id: ThreadId) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Records that the caller asked to flush pending thread data. Because this store has no background buffer, flushing simply succeeds after counting the call.

**Data flow**: A thread ID goes in. The function locks the state, increments the flush counter, and returns success without changing thread contents.

**Call relations**: Code using the generic store interface may call this after writes. In this fake store, it exists so those flows can run unchanged in tests.

*Call graph*: 1 external calls (pin).


##### `InMemoryThreadStore::shutdown_thread`  (lines 420–425)

```
fn shutdown_thread(&self, _thread_id: ThreadId) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Records that the caller asked to shut down storage for a thread. The in-memory store does not need real shutdown work, but counting the call lets tests verify lifecycle behavior.

**Data flow**: A thread ID goes in. The function locks the state, increments the shutdown counter, leaves stored data in place, and returns success.

**Call relations**: Thread lifecycle code calls this through the `ThreadStore` interface during cleanup. The method keeps that path testable without requiring real external resources.

*Call graph*: 1 external calls (pin).


##### `InMemoryThreadStore::discard_thread`  (lines 427–432)

```
fn discard_thread(&self, _thread_id: ThreadId) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Records that the caller asked to discard a thread. This implementation only counts the request; actual deletion is done by `delete_thread`.

**Data flow**: A thread ID goes in. The function locks the state, increments the discard counter, makes no other data changes, and returns success.

**Call relations**: Generic thread cleanup flows can call this safely in tests. The recorded counter shows whether discard was requested.

*Call graph*: 1 external calls (pin).


##### `InMemoryThreadStore::load_history`  (lines 434–439)

```
fn load_history(
        &self,
        params: LoadThreadHistoryParams,
    ) -> ThreadStoreFuture<'_, StoredThreadHistory>
```

**Purpose**: Returns the saved conversation history for a thread. If the thread has no known history, it reports that the thread was not found.

**Data flow**: Load parameters go in with a thread ID. The store locks its state, increments the load-history counter, looks up that thread’s item list, clones it into a `StoredThreadHistory`, and returns it; if missing, it returns a not-found error.

**Call relations**: Readers and resume flows use this when they need the actual saved conversation items. It reads histories created by `create_thread`, `resume_thread`, and `append_items`.

*Call graph*: 1 external calls (pin).


##### `InMemoryThreadStore::read_thread`  (lines 441–443)

```
fn read_thread(&self, params: ReadThreadParams) -> ThreadStoreFuture<'_, StoredThread>
```

**Purpose**: Builds and returns a stored-thread summary, optionally including the full history. This is the main way callers read back thread metadata from the fake store.

**Data flow**: Read parameters go in with a thread ID and an include-history flag. The store locks its state, increments read counters, and asks `stored_thread_from_state` to assemble the returned `StoredThread` or a not-found error.

**Call relations**: Generic store callers use this to fetch one thread. It delegates the detailed assembly work to `stored_thread_from_state`, which combines creation data, updates, names, paths, and optional history.

*Call graph*: calls 1 internal fn (stored_thread_from_state); 1 external calls (pin).


##### `InMemoryThreadStore::read_thread_by_rollout_path`  (lines 445–452)

```
fn read_thread_by_rollout_path(
        &self,
        params: ReadThreadByRolloutPathParams,
    ) -> ThreadStoreFuture<'_, StoredThread>
```

**Purpose**: Finds a thread by its rollout file path and returns the stored-thread view. This supports code that starts from a transcript path instead of a thread ID.

**Data flow**: Parameters go in with a rollout path and include-history flag. The store locks its state, increments the path-read counter, looks up which thread ID owns that path, and either returns an invalid-request error or builds the stored thread through `stored_thread_from_state`.

**Call relations**: This depends on rollout path mappings saved during resume or metadata updates. Once it finds the thread ID, it follows the same assembly path as ordinary `read_thread`.

*Call graph*: calls 1 internal fn (stored_thread_from_state); 2 external calls (pin, format!).


##### `InMemoryThreadStore::list_threads`  (lines 454–463)

```
fn list_threads(&self, params: ListThreadsParams) -> ThreadStoreFuture<'_, ThreadPage>
```

**Purpose**: Returns a page containing all threads known to the store, sorted by thread ID. The in-memory store does not produce additional pages, so there is no next cursor.

**Data flow**: The store state is the input. The function locks it, increments the list counter, builds a stored-thread summary for every created thread without history, sorts the results, and returns them in a `ThreadPage`.

**Call relations**: The trait-level list method calls this basic lister, then may apply extra filtering such as parent-thread filtering. The actual item-building comes from the same state-to-thread helper used by single-thread reads.

*Call graph*: 1 external calls (pin).


##### `InMemoryThreadStore::update_thread_metadata`  (lines 465–470)

```
fn update_thread_metadata(
        &self,
        params: UpdateThreadMetadataParams,
    ) -> ThreadStoreFuture<'_, StoredThread>
```

**Purpose**: Applies metadata changes to a thread and returns the updated stored-thread summary. This lets tests simulate later changes such as names, previews, model details, paths, or timestamps.

**Data flow**: Update parameters go in with a thread ID and a metadata patch. The store locks its state, increments the update counter, stores a name separately when provided, merges the patch with any earlier patch for that thread, and returns a fresh stored-thread view.

**Call relations**: Callers use this after a thread already exists. It hands off to `stored_thread_from_state` so the returned value reflects both original creation data and the accumulated patch.

*Call graph*: calls 1 internal fn (stored_thread_from_state); called by 1 (seed_pathless_store_thread); 1 external calls (pin).


##### `InMemoryThreadStore::archive_thread`  (lines 472–477)

```
fn archive_thread(&self, _params: ArchiveThreadParams) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Records that a thread was archived. In this in-memory implementation, archiving does not hide the thread or set an archived timestamp; it only counts the call.

**Data flow**: Archive parameters go in but are not used to change stored thread data. The function locks the state, increments the archive counter, and returns success.

**Call relations**: Archive flows can run against this fake store through the common interface. Tests can check the counter, but should not expect full archive filtering behavior from this method.

*Call graph*: 1 external calls (pin).


##### `InMemoryThreadStore::unarchive_thread`  (lines 479–485)

```
fn unarchive_thread(&self, params: ArchiveThreadParams) -> ThreadStoreFuture<'_, StoredThread>
```

**Purpose**: Records that a thread was unarchived and returns its current stored-thread summary. This mirrors the interface expected by real stores while keeping behavior simple.

**Data flow**: Archive parameters go in with the thread ID. The store locks its state, increments the unarchive counter, and uses `stored_thread_from_state` to return the thread or a not-found error.

**Call relations**: Unarchive flows call this through the `ThreadStore` interface. It reuses the central thread-building helper so returned metadata is consistent with ordinary reads.

*Call graph*: calls 1 internal fn (stored_thread_from_state); 1 external calls (pin).


##### `InMemoryThreadStore::delete_thread`  (lines 487–489)

```
fn delete_thread(&self, params: DeleteThreadParams) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Deletes all in-memory records for a thread. This is the operation that actually removes histories, creation data, names, metadata patches, and rollout path mappings.

**Data flow**: Delete parameters go in with a thread ID. The store locks its state, increments the delete counter, removes the thread from all internal maps, removes any paths pointing to it, and returns success only if a history entry existed; otherwise it returns a not-found error.

**Call relations**: Callers use this through the common store interface when a thread should be removed. It is the stronger counterpart to lifecycle methods like discard, which only count requests here.

*Call graph*: 1 external calls (pin).


##### `stored_thread_from_state`  (lines 492–565)

```
fn stored_thread_from_state(
    state: &InMemoryThreadStoreState,
    thread_id: ThreadId,
    include_history: bool,
) -> ThreadStoreResult<StoredThread>
```

**Purpose**: Assembles a complete `StoredThread` view from the store’s internal maps. It is the central translator from scattered in-memory records into the shape callers expect.

**Data flow**: The current state, a thread ID, and an include-history flag go in. The function finds the original creation record, collects history if requested, applies name and metadata patches, finds a rollout path, fills in sensible test defaults for missing fields, converts git metadata when present, and returns the finished stored thread or a not-found error.

**Call relations**: Read, read-by-path, metadata update, and unarchive operations all rely on this helper. Keeping the assembly in one place means those operations return consistent thread data.

*Call graph*: called by 4 (read_thread, read_thread_by_rollout_path, unarchive_thread, update_thread_metadata).


##### `git_info_from_patch`  (lines 567–580)

```
fn git_info_from_patch(patch: &ThreadMetadataPatch) -> Option<codex_protocol::protocol::GitInfo>
```

**Purpose**: Converts git-related fields from a metadata patch into the protocol’s `GitInfo` shape. It returns nothing if the patch does not contain any meaningful git information.

**Data flow**: A metadata patch goes in. The function looks for commit SHA, branch, and origin URL, unwraps values that may explicitly be absent, and if at least one exists, builds a `GitInfo` object with the expected field names and SHA wrapper.

**Call relations**: The stored-thread assembly helper calls this when it needs to include git information in a returned thread. It keeps the git conversion detail out of the main thread-building logic.


### Local thread-store foundation
These files define the local filesystem-backed thread store and the shared helper logic used across its concrete operations.

### `thread-store/src/local/helpers.rs`

`util` · `cross-cutting during thread reads, archive/unarchive/delete operations, and metadata updates`

A “thread” here is a saved conversation, and a “rollout” is the log file that records it. This file is like the thread store’s utility drawer: it does the careful small jobs that many larger operations rely on. Some helpers protect the filesystem by making sure a requested rollout path really lives inside the expected home directory and that its file name matches the thread ID. Without those checks, archive or delete operations could accidentally touch the wrong file. Other helpers recognize whether a rollout is archived, update a file’s modified time when it is restored, and extract a thread ID from the standard rollout file name format.

The file also converts lower-level saved data into a `StoredThread`, which is the richer thread record the rest of the store understands. During that conversion it fills in safe defaults, parses timestamps, normalizes compressed rollout paths to their plain `.jsonl` form, builds Git information when present, and uses read-only permissions if nothing more specific is known.

Finally, it deals with metadata compatibility. Permission settings may be saved in the current JSON format or in older names such as `workspace-write`; this file reads both. It also avoids showing duplicate thread titles when the title is just the first user message repeated.

#### Function details

##### `scoped_rollout_path`  (lines 26–55)

```
fn scoped_rollout_path(
    root: PathBuf,
    rollout_path: &Path,
    root_name: &str,
) -> ThreadStoreResult<PathBuf>
```

**Purpose**: Checks that a rollout file path is safely inside an allowed root directory. This prevents callers such as archive or delete operations from acting on files outside the thread store area.

**Data flow**: It receives the allowed root folder, the rollout path to check, and a human-readable name for that root. It resolves both paths to their real filesystem locations, then compares them. If the rollout path is inside the root, it returns the resolved path; otherwise it returns an invalid-request error with a clear message.

**Call relations**: Archive, delete, and unarchive flows call this before touching a rollout file. It acts as the gatekeeper before those higher-level operations move or remove anything on disk.

*Call graph*: called by 3 (archive_thread, delete_rollout_path, unarchive_thread); 2 external calls (format!, canonicalize).


##### `rollout_path_is_archived`  (lines 57–62)

```
fn rollout_path_is_archived(codex_home: &Path, path: &Path) -> bool
```

**Purpose**: Decides whether a rollout path points to an archived session. This lets readers and resolvers treat archived conversations differently from active ones.

**Data flow**: It receives the Codex home directory and a path. It checks whether the path starts inside the known archived sessions folder, or whether any part of the path is named like the archive folder. It returns `true` for archived-looking paths and `false` otherwise.

**Call relations**: Thread loading and path resolution code calls this when it needs to label a thread or choose where to look. It supplies a simple yes-or-no answer used by `load_history`, `read_thread`, `read_thread_from_rollout_path`, `resolve_rollout_path`, and `stored_thread_from_session_meta`.

*Call graph*: called by 5 (load_history, read_thread, read_thread_from_rollout_path, resolve_rollout_path, stored_thread_from_session_meta); 3 external calls (components, join, starts_with).


##### `matching_rollout_file_name`  (lines 64–92)

```
fn matching_rollout_file_name(
    rollout_path: &Path,
    thread_id: ThreadId,
    display_path: &Path,
) -> ThreadStoreResult<std::ffi::OsString>
```

**Purpose**: Verifies that a rollout file name belongs to the thread ID the caller expects. This protects archive, delete, and unarchive actions from mixing up two different conversations.

**Data flow**: It receives a rollout path, the expected thread ID, and a display path for error messages. It extracts the file name and checks that it ends with either `<thread_id>.jsonl` or `<thread_id>.jsonl.zst`. If the name matches, it returns the file name; if not, it returns an invalid-request error.

**Call relations**: Archive, delete, and unarchive operations call this after choosing a path. It gives them confidence that the file they are about to move or delete really matches the thread requested by the user.

*Call graph*: called by 3 (archive_thread, delete_rollout_path, unarchive_thread); 2 external calls (file_name, format!).


##### `touch_modified_time`  (lines 94–97)

```
fn touch_modified_time(path: &Path) -> std::io::Result<()>
```

**Purpose**: Updates a file’s modified time to the current moment. This is useful when a rollout is restored so filesystem ordering can reflect that recent change.

**Data flow**: It receives a path. It opens that file for appending, creates a file timestamp using the current system time, and writes that timestamp onto the file metadata. It returns success or an operating-system I/O error.

**Call relations**: The unarchive flow calls this after bringing a thread back. It does not decide what to unarchive; it only refreshes the file’s timestamp once the larger operation has chosen the file.

*Call graph*: called by 1 (unarchive_thread); 3 external calls (new, new, now).


##### `stored_thread_from_rollout_item`  (lines 99–154)

```
fn stored_thread_from_rollout_item(
    item: ThreadItem,
    archived: bool,
    default_provider: &str,
) -> Option<StoredThread>
```

**Purpose**: Turns a lightweight rollout index item into a fuller `StoredThread` record. This lets the rest of the thread store work with one consistent shape even when the source data is incomplete.

**Data flow**: It receives a `ThreadItem`, whether it is archived, and a default model provider name. It finds or derives the thread ID, parses creation and update times, builds optional Git information, chooses a preview message, normalizes the rollout path, and fills missing fields with safe defaults such as read-only permissions. If it cannot determine a thread ID, it returns nothing; otherwise it returns a completed `StoredThread`.

**Call relations**: Reading a thread from a rollout path and unarchiving a thread both use this conversion step. The included test also calls it to confirm compressed `.zst` rollout paths are stored as their logical plain `.jsonl` path. Inside the conversion it relies on helpers for timestamps, Git data, and path normalization.

*Call graph*: calls 3 internal fn (read_only, git_info_from_parts, parse_rfc3339); called by 3 (stored_thread_from_rollout_item_returns_logical_rollout_path, read_thread_from_rollout_path, unarchive_thread); 1 external calls (plain_rollout_path).


##### `permission_profile_from_metadata_value`  (lines 156–163)

```
fn permission_profile_from_metadata_value(value: &str, cwd: &Path) -> PermissionProfile
```

**Purpose**: Reads saved permission settings from metadata and turns them into a current `PermissionProfile`. It exists so both new metadata and older saved formats still work.

**Data flow**: It receives a metadata string and the thread’s working directory. It first tries to parse the string as a current permission profile. If that fails, it tries to interpret it as an older sandbox policy and converts that into a permission profile for the working directory. If every attempt fails, it returns a read-only profile as the safest fallback.

**Call relations**: Thread-reading code calls this when rebuilding a thread from stored metadata, including SQLite metadata. It bridges old stored values into the current permission system before the rest of the store sees them.

*Call graph*: called by 2 (read_thread, stored_thread_from_sqlite_metadata).


##### `permission_profile_to_metadata_value`  (lines 165–175)

```
fn permission_profile_to_metadata_value(
    permission_profile: &PermissionProfile,
) -> String
```

**Purpose**: Converts a `PermissionProfile` into the string form saved in metadata. This is the reverse of reading permission metadata.

**Data flow**: It receives a permission profile. It tries to serialize it as JSON text. If that works, it returns the JSON string; if serialization fails, it writes a warning to the log and returns an empty string.

**Call relations**: Metadata update code calls this when saving permission changes. It prepares the profile for storage so later reads can reconstruct the same setting.

*Call graph*: called by 1 (apply_metadata_update); 3 external calls (new, to_string, warn!).


##### `distinct_thread_metadata_title`  (lines 177–184)

```
fn distinct_thread_metadata_title(metadata: &ThreadMetadata) -> Option<String>
```

**Purpose**: Returns a thread title only if it is meaningful and not just a duplicate of the first user message. This keeps thread lists from showing redundant names.

**Data flow**: It receives thread metadata. It trims whitespace from the title, checks whether it is empty, and compares it with the trimmed first user message if one exists. It returns no title for empty or duplicate text, otherwise it returns the cleaned title.

**Call relations**: Thread listing, SQLite metadata conversion, and search-result naming call this before displaying or storing a thread name. It supplies the “is this title worth showing?” decision.

*Call graph*: called by 3 (list_threads, stored_thread_from_sqlite_metadata, set_thread_search_result_names).


##### `set_thread_name_from_title`  (lines 186–191)

```
fn set_thread_name_from_title(thread: &mut StoredThread, title: String)
```

**Purpose**: Copies a title onto a stored thread as its display name, but only when the title is useful. It avoids setting names that are blank or merely repeat the preview text.

**Data flow**: It receives a mutable `StoredThread` and a proposed title. It trims and compares the title with the thread preview. If the title is blank or the same as the preview, it leaves the thread unchanged; otherwise it sets `thread.name` to that title.

**Call relations**: Thread listing, rollout-path reading, and search-result naming use this after they have found a possible title. It applies the final rule for whether the thread should get a separate display name.

*Call graph*: called by 3 (list_threads, read_thread_from_rollout_path, set_thread_search_result_names).


##### `parse_rfc3339`  (lines 193–197)

```
fn parse_rfc3339(value: Option<&str>) -> Option<DateTime<Utc>>
```

**Purpose**: Parses a timestamp written in RFC 3339 format, a common internet date-time format such as `2025-01-03T12:00:00Z`. It gives the rollout conversion code reliable UTC times when the saved data includes them.

**Data flow**: It receives an optional string. If no string is present, it returns nothing. If a string is present, it tries to parse it as an RFC 3339 timestamp and convert it to UTC; failed parsing also returns nothing.

**Call relations**: The rollout-item conversion helper calls this for created and updated times. If parsing fails, that caller chooses fallback times instead of letting a bad timestamp break thread loading.

*Call graph*: called by 1 (stored_thread_from_rollout_item); 1 external calls (parse_from_rfc3339).


##### `parse_legacy_sandbox_policy`  (lines 199–211)

```
fn parse_legacy_sandbox_policy(value: &str) -> serde_json::Result<SandboxPolicy>
```

**Purpose**: Interprets older saved sandbox permission values. A sandbox policy describes what a session was allowed to do, such as read-only access or workspace writing.

**Data flow**: It receives a string. It tries several interpretations: direct JSON, JSON string value, and known legacy words such as `danger-full-access`, `read-only`, `workspace-write`, and `external-sandbox`. If one matches, it returns the corresponding sandbox policy; otherwise it returns a parse error.

**Call relations**: The permission metadata reader uses this as a compatibility path when current permission-profile parsing fails. It lets old threads keep sensible permissions after the storage format has changed.

*Call graph*: 1 external calls (from_str).


##### `git_info_from_parts`  (lines 213–226)

```
fn git_info_from_parts(
    sha: Option<String>,
    branch: Option<String>,
    origin_url: Option<String>,
) -> Option<GitInfo>
```

**Purpose**: Builds optional Git repository information from separate saved pieces: commit hash, branch, and remote URL. Git is the version-control system used to track source code changes.

**Data flow**: It receives optional commit SHA text, branch name, and origin URL. If all three are missing, it returns no Git info. If any are present, it wraps the commit hash in the project’s Git SHA type and returns a `GitInfo` record containing the available pieces.

**Call relations**: Rollout conversion, rollout-path reading, SQLite metadata conversion, metadata application, and metadata update code all call this when they need one Git-info object from scattered fields. It centralizes the rule that completely empty Git data should stay absent.

*Call graph*: called by 5 (stored_thread_from_rollout_item, read_thread_by_rollout_path, stored_thread_from_sqlite_metadata, apply_metadata_update, update_thread_metadata).


##### `thread_id_from_rollout_path`  (lines 228–240)

```
fn thread_id_from_rollout_path(path: &Path) -> Option<ThreadId>
```

**Purpose**: Tries to recover a thread ID from the standard rollout file name. This helps load older or incomplete rollout items that did not store the thread ID separately.

**Data flow**: It receives a path. It extracts the file name, removes a possible `.zst` compression suffix, then removes the `.jsonl` suffix. It expects the last 36 characters before that suffix to be a UUID-style thread ID preceded by a dash. If that pattern is valid, it returns the parsed `ThreadId`; otherwise it returns nothing.

**Call relations**: The rollout-item conversion helper uses this when the `ThreadItem` itself does not include a thread ID. It is a fallback, not the main source of identity.

*Call graph*: calls 1 internal fn (from_string); 1 external calls (file_name).


##### `tests::stored_thread_from_rollout_item_returns_logical_rollout_path`  (lines 251–272)

```
fn stored_thread_from_rollout_item_returns_logical_rollout_path()
```

**Purpose**: Checks that converting a compressed rollout item stores the logical plain rollout path rather than the compressed filename. This protects code that expects thread records to point at the `.jsonl` form.

**Data flow**: It creates a fixed UUID and a fake compressed `.jsonl.zst` rollout path, builds a mostly default `ThreadItem`, and converts it with `stored_thread_from_rollout_item`. It then compares the stored path with the expected same path ending in `.jsonl`.

**Call relations**: This test exercises `stored_thread_from_rollout_item` directly. It documents and guards an important behavior used by thread reading and unarchiving: compressed rollout files are represented internally by their plain logical path.

*Call graph*: calls 1 internal fn (stored_thread_from_rollout_item); 5 external calls (default, from, from_u128, assert_eq!, format!).


### `thread-store/src/local/mod.rs`

`orchestration` · `cross-cutting: active whenever local threads are created, read, updated, searched, archived, or shut down`

A thread is a saved conversation history. Locally, the project keeps the full replayable history in rollout JSONL files, while SQLite, when available, acts like a fast card catalog for thread names, dates, paths, and search metadata. This file defines LocalThreadStore, the concrete local version of the ThreadStore interface, and LocalThreadStoreConfig, which says where the local files and database live.

The important job here is coordination. Most detailed work is delegated to nearby modules such as live_writer, read_thread, list_threads, and archive_thread. This file keeps the shared pieces: configuration, the optional SQLite handle, and a map of currently open RolloutRecorder objects. That map is protected by a mutex, which is a lock that stops two async tasks from changing the same collection at the same time.

A useful analogy is a library desk. The JSONL files are the actual books, SQLite is the searchable catalog, and LocalThreadStore is the librarian who knows whether a book is currently being written, where to find it, and which specialist desk should handle reading, searching, archiving, or deleting. Without this file, callers would not have one consistent local storage object that obeys the ThreadStore contract.

#### Function details

##### `LocalThreadStoreConfig::from_config`  (lines 77–83)

```
fn from_config(config: &impl codex_rollout::RolloutConfigView) -> Self
```

**Purpose**: Builds the local thread-store settings from the broader application configuration. It extracts the folders used for local Codex data and SQLite data, plus the default model provider used when older saved metadata is incomplete.

**Data flow**: It receives any configuration object that can reveal the Codex home folder, SQLite home folder, and model provider id. It copies those values into a LocalThreadStoreConfig. The result is a small, process-wide settings object for local thread storage.

**Call relations**: Startup and test setup code call this when they need a LocalThreadStoreConfig. It asks the shared rollout configuration for the three paths or ids it needs, then hands the finished config to LocalThreadStore::new or similar setup paths.

*Call graph*: called by 8 (resume_agent_from_rollout_reads_archived_rollout_path, guardian_subagent_does_not_inherit_parent_exec_policy_rules, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, make_session_with_config_and_rx, make_session_with_history_source_and_agent_control_and_rx, session_new_fails_when_zsh_fork_enabled_without_packaged_zsh, thread_store_from_config); 3 external calls (codex_home, model_provider_id, sqlite_home).


##### `LocalThreadStore::fmt`  (lines 87–91)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Provides a safe debug printout for LocalThreadStore. It shows the configuration but avoids dumping internal live writer state.

**Data flow**: It receives a formatter from Rust's debugging system. It writes a debug structure containing the store config and marks the rest as intentionally not shown. Nothing in the store is changed.

**Call relations**: This is used automatically when code formats LocalThreadStore with Rust's debug formatting. It delegates to the standard debug builder rather than being called directly by storage logic.

*Call graph*: 1 external calls (debug_struct).


##### `LocalThreadStore::new`  (lines 96–102)

```
fn new(config: LocalThreadStoreConfig, state_db: Option<StateDbHandle>) -> Self
```

**Purpose**: Creates a new local thread store object. Callers use it when they want one place to read and write local conversation threads.

**Data flow**: It receives local storage configuration and, optionally, a handle to the SQLite state database. It creates an empty shared map for live rollout writers, stores the database handle, and returns a ready LocalThreadStore.

**Call relations**: Session setup, tests, and thread-store construction paths call this after configuration is known. Later ThreadStore methods use the fields initialized here to delegate work to writer, reader, search, archive, and delete modules.

*Call graph*: called by 75 (resume_agent_from_rollout_reads_archived_rollout_path, has_recorded_sessions, guardian_subagent_does_not_inherit_parent_exec_policy_rules, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, make_session_with_config_and_rx, make_session_with_history_source_and_agent_control_and_rx, session_new_fails_when_zsh_fork_enabled_without_packaged_zsh, with_models_provider_home_and_state_for_tests, thread_store_from_config (+15 more)); 3 external calls (new, new, new).


##### `LocalThreadStore::state_db`  (lines 105–107)

```
async fn state_db(&self) -> Option<StateDbHandle>
```

**Purpose**: Returns the optional SQLite database handle used by local storage. Other modules use it when they need fast metadata lookup or updates.

**Data flow**: It reads the store's saved database handle and clones it if one exists. The caller gets either a usable handle or None, meaning this store must rely on rollout files only.

**Call relations**: Archive, delete, list, search, read, and repair-style helper paths call this when they may need SQLite. It does not perform database work itself; it simply shares the handle with the module that will.

*Call graph*: called by 14 (archive_thread, delete_thread, list_threads, sync_materialized_rollout_path, read_sqlite_metadata, resolve_rollout_path, search_threads, set_thread_search_result_names, unarchive_thread, apply_metadata_update (+4 more)).


##### `LocalThreadStore::live_rollout_path`  (lines 126–128)

```
async fn live_rollout_path(&self, thread_id: ThreadId) -> ThreadStoreResult<PathBuf>
```

**Purpose**: Returns the file path currently used by the live writer for a thread. This supports older local-only code paths that still need to know the active rollout file location.

**Data flow**: It receives a thread id. It asks the live writer module to resolve that thread's rollout path and returns the path or an error if it cannot be found.

**Call relations**: Callers use this after creating or resuming a live thread, especially in tests and legacy flows. The actual lookup is handed to live_writer::rollout_path.

*Call graph*: calls 1 internal fn (rollout_path).


##### `LocalThreadStore::live_recorder`  (lines 130–140)

```
async fn live_recorder(
        &self,
        thread_id: ThreadId,
    ) -> ThreadStoreResult<RolloutRecorder>
```

**Purpose**: Finds the active RolloutRecorder for a thread. A RolloutRecorder is the object that appends conversation items to that thread's JSONL history file.

**Data flow**: It receives a thread id, locks the live-recorder map, and looks up the matching recorder. It returns a cloned recorder when found, or a ThreadNotFound error when no live writer is open.

**Call relations**: Append, persist, flush, and shutdown paths call this before touching a live thread. It is the gatekeeper that prevents writes to threads that are not currently open for live recording.

*Call graph*: called by 4 (append_items, flush_thread, persist_thread, shutdown_thread).


##### `LocalThreadStore::ensure_live_recorder_absent`  (lines 142–152)

```
async fn ensure_live_recorder_absent(
        &self,
        thread_id: ThreadId,
    ) -> ThreadStoreResult<()>
```

**Purpose**: Checks that a thread does not already have an open live writer. This prevents two writers from appending to the same thread at once.

**Data flow**: It receives a thread id, locks the live-recorder map, and checks whether that id is present. If present, it returns an InvalidRequest error; otherwise it returns success without changing anything.

**Call relations**: Create and resume operations call this before opening a new live writer. It protects the later insert step from duplicate live writers, like checking that a room is free before issuing another key.

*Call graph*: called by 2 (create_thread, resume_thread); 1 external calls (format!).


##### `LocalThreadStore::insert_live_recorder`  (lines 154–168)

```
async fn insert_live_recorder(
        &self,
        thread_id: ThreadId,
        recorder: RolloutRecorder,
    ) -> ThreadStoreResult<()>
```

**Purpose**: Registers a newly opened live writer for a thread. This makes future appends, flushes, and shutdowns find the correct RolloutRecorder.

**Data flow**: It receives a thread id and recorder, locks the live-recorder map, and tries to insert the pair. If the id is already present it returns an InvalidRequest error; if not, it stores the recorder and returns success.

**Call relations**: Create and resume operations call this after the live writer module has prepared a recorder. Later live operations retrieve the same recorder through LocalThreadStore::live_recorder.

*Call graph*: called by 2 (create_thread, resume_thread); 1 external calls (format!).


##### `LocalThreadStore::read_thread_by_rollout_path_params`  (lines 213–224)

```
async fn read_thread_by_rollout_path_params(
        &self,
        params: ReadThreadByRolloutPathParams,
    ) -> ThreadStoreResult<StoredThread>
```

**Purpose**: Adapts the trait-style parameter object into the lower-level read-by-path call. It exists so the ThreadStore interface can pass one params value while the internal reader receives separate arguments.

**Data flow**: It receives a ReadThreadByRolloutPathParams value containing a path and flags for archived threads and history. It passes those values to the read_thread module and returns the StoredThread result.

**Call relations**: The ThreadStore implementation for read_thread_by_rollout_path calls this wrapper. The real file parsing and metadata construction are handed off to read_thread::read_thread_by_rollout_path.

*Call graph*: calls 1 internal fn (read_thread_by_rollout_path); called by 1 (read_thread_by_rollout_path).


##### `LocalThreadStore::as_any`  (lines 228–230)

```
fn as_any(&self) -> &dyn std::any::Any
```

**Purpose**: Lets code treat this store as a general Rust Any value for safe downcasting. Downcasting means checking at runtime whether a trait object is actually a LocalThreadStore.

**Data flow**: It receives a reference to the store and returns the same object behind Rust's Any interface. It does not read storage data or change anything.

**Call relations**: This is part of the ThreadStore trait implementation. Higher-level code can use it when it has a generic ThreadStore but needs to recognize the concrete local implementation.


##### `LocalThreadStore::create_thread`  (lines 232–234)

```
fn create_thread(&self, params: CreateThreadParams) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Starts a new local live thread. It opens the machinery needed to write that thread's rollout history as conversation items arrive.

**Data flow**: It receives CreateThreadParams, wraps the async work in a boxed future, and delegates to live_writer::create_thread. The result is success or a store error; the live writer map may gain a recorder.

**Call relations**: Callers invoke this through the ThreadStore interface when a new conversation begins. The detailed file creation and recorder setup happen in the live_writer module.

*Call graph*: calls 1 internal fn (create_thread); 1 external calls (pin).


##### `LocalThreadStore::resume_thread`  (lines 236–238)

```
fn resume_thread(&self, params: ResumeThreadParams) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Reopens an existing thread for live writing. This is used when a saved conversation continues and new items should be appended to its rollout file.

**Data flow**: It receives ResumeThreadParams, returns a boxed async future, and delegates to live_writer::resume_thread. That flow may locate old history, open the right rollout path, and register a live recorder.

**Call relations**: The ThreadStore interface calls this when a session is resumed. This wrapper keeps the public interface uniform while live_writer performs the storage-specific work.

*Call graph*: calls 1 internal fn (resume_thread); 1 external calls (pin).


##### `LocalThreadStore::append_items`  (lines 240–242)

```
fn append_items(&self, params: AppendThreadItemsParams) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Adds new rollout items to a live thread's history. These items are the durable replay records for the conversation.

**Data flow**: It receives AppendThreadItemsParams with a thread id and items. It boxes an async call to live_writer::append_items, which writes the items through the active recorder. The call returns success or an error such as missing live thread.

**Call relations**: Live conversation code calls this through ThreadStore while a thread is active. The wrapper delegates to live_writer, which uses LocalThreadStore::live_recorder internally.

*Call graph*: calls 1 internal fn (append_items); 1 external calls (pin).


##### `LocalThreadStore::persist_thread`  (lines 244–246)

```
fn persist_thread(&self, thread_id: ThreadId) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Makes sure a live thread has been materialized on disk. This matters for threads that may have been buffered before a real rollout file exists.

**Data flow**: It receives a thread id and returns a boxed async call to live_writer::persist_thread. The live writer module ensures the thread's saved file state is durable enough for later reads.

**Call relations**: Higher-level live-thread code calls this when it needs the thread to exist as stored data. This function is only the ThreadStore-facing doorway into the live writer behavior.

*Call graph*: calls 1 internal fn (persist_thread); 1 external calls (pin).


##### `LocalThreadStore::flush_thread`  (lines 248–250)

```
fn flush_thread(&self, thread_id: ThreadId) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Flushes pending writes for a live thread. Flushing pushes buffered data out so readers and the filesystem can see the latest saved history.

**Data flow**: It receives a thread id, boxes an async call, and delegates to live_writer::flush_thread. The result reports whether the flush succeeded.

**Call relations**: Callers use this after appending items or before checking files. The live writer module retrieves the active recorder and performs the actual flush.

*Call graph*: calls 1 internal fn (flush_thread); 1 external calls (pin).


##### `LocalThreadStore::shutdown_thread`  (lines 252–254)

```
fn shutdown_thread(&self, thread_id: ThreadId) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Closes a live writer for a thread. After shutdown, new appends to that live writer should fail unless the thread is resumed again.

**Data flow**: It receives a thread id and delegates through a boxed future to live_writer::shutdown_thread. That path finalizes or removes writer state and returns success or an error.

**Call relations**: Session teardown calls this when a live conversation ends. It works with the live writer module, which removes the recorder from the store's live map.

*Call graph*: calls 1 internal fn (shutdown_thread); 1 external calls (pin).


##### `LocalThreadStore::discard_thread`  (lines 256–258)

```
fn discard_thread(&self, thread_id: ThreadId) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Drops a live thread that should not be kept. This is useful for empty or cancelled conversations that should not leave a saved rollout file behind.

**Data flow**: It receives a thread id and delegates to live_writer::discard_thread. The live writer removes the active recorder and may delete an unmaterialized rollout file. The result is success or a storage error.

**Call relations**: Callers use this instead of shutdown when the live thread should be abandoned. This wrapper exposes that behavior through the ThreadStore trait.

*Call graph*: calls 1 internal fn (discard_thread); 1 external calls (pin).


##### `LocalThreadStore::load_history`  (lines 260–265)

```
fn load_history(
        &self,
        params: LoadThreadHistoryParams,
    ) -> ThreadStoreFuture<'_, StoredThreadHistory>
```

**Purpose**: Loads the saved item history for a thread. It gives special care to live resumed threads, because their true rollout path may be outside the normal local folder.

**Data flow**: It receives a thread id and an include-archived flag. First it tries to find a live rollout path; if found, it checks whether archived threads are allowed, reads that rollout file with history included, and returns the history. If no live path exists, it reads the thread by id with history included and extracts the history. If a read succeeds but history is missing, it returns an internal error.

**Call relations**: The ThreadStore trait calls this when callers need only history rather than full thread metadata. It uses live_writer::rollout_path, helpers::rollout_path_is_archived, and the read_thread module to choose the safest source.

*Call graph*: calls 4 internal fn (rollout_path_is_archived, rollout_path, read_thread, read_thread_by_rollout_path); 2 external calls (pin, format!).


##### `LocalThreadStore::read_thread`  (lines 267–269)

```
fn read_thread(&self, params: ReadThreadParams) -> ThreadStoreFuture<'_, StoredThread>
```

**Purpose**: Reads one stored thread by its id. The caller can choose whether archived threads and full history should be included.

**Data flow**: It receives ReadThreadParams, wraps the async work in a boxed future, and delegates to read_thread::read_thread. The output is a StoredThread or an error.

**Call relations**: This is the ThreadStore-facing read operation. The detailed lookup, whether through SQLite or rollout files, belongs to the read_thread module.

*Call graph*: calls 1 internal fn (read_thread); 1 external calls (pin).


##### `LocalThreadStore::read_thread_by_rollout_path`  (lines 271–278)

```
fn read_thread_by_rollout_path(
        &self,
        params: ReadThreadByRolloutPathParams,
    ) -> ThreadStoreFuture<'_, StoredThread>
```

**Purpose**: Reads a thread directly from a known rollout file path. This is useful when the caller already knows the file to inspect, including external or legacy rollout files.

**Data flow**: It receives ReadThreadByRolloutPathParams, boxes an async call to the local wrapper, and returns a StoredThread. The params control whether archived files are accepted and whether full history is loaded.

**Call relations**: This implements the ThreadStore trait method. It hands off to LocalThreadStore::read_thread_by_rollout_path_params, which then calls the read_thread module.

*Call graph*: calls 2 internal fn (read_thread_by_rollout_path_params, read_thread_by_rollout_path); 1 external calls (pin).


##### `LocalThreadStore::list_threads`  (lines 280–282)

```
fn list_threads(&self, params: ListThreadsParams) -> ThreadStoreFuture<'_, ThreadPage>
```

**Purpose**: Returns a page of stored threads for browsing. A page is a limited batch of results rather than every thread at once.

**Data flow**: It receives ListThreadsParams, boxes an async call, and delegates to list_threads::list_threads. The result is a ThreadPage containing matching thread summaries and paging information.

**Call relations**: UI or higher-level checks such as has_threads call this through ThreadStore. The listing module does the actual query and fallback work.

*Call graph*: calls 1 internal fn (list_threads); called by 1 (has_threads); 1 external calls (pin).


##### `LocalThreadStore::search_threads`  (lines 284–289)

```
fn search_threads(
        &self,
        params: SearchThreadsParams,
    ) -> ThreadStoreFuture<'_, ThreadSearchPage>
```

**Purpose**: Searches stored local threads. It lets callers find conversations by text or metadata instead of knowing the exact thread id.

**Data flow**: It receives SearchThreadsParams, boxes an async call, and delegates to search_threads::search_threads. The output is a page of search results.

**Call relations**: Search features call this through ThreadStore. The search_threads module uses the store's configuration and optional SQLite handle to perform the search.

*Call graph*: calls 1 internal fn (search_threads); 1 external calls (pin).


##### `LocalThreadStore::update_thread_metadata`  (lines 291–296)

```
fn update_thread_metadata(
        &self,
        params: UpdateThreadMetadataParams,
    ) -> ThreadStoreFuture<'_, StoredThread>
```

**Purpose**: Applies a metadata update to a stored thread. Metadata includes searchable or display information such as title, preview, and related thread fields.

**Data flow**: It receives UpdateThreadMetadataParams, boxes an async call, and delegates to update_thread_metadata::update_thread_metadata. The output is the updated StoredThread.

**Call relations**: Higher-level live-thread code calls this when appended items have been observed and should affect SQLite metadata. Raw append_items intentionally does not do this by itself.

*Call graph*: calls 1 internal fn (update_thread_metadata); 1 external calls (pin).


##### `LocalThreadStore::archive_thread`  (lines 298–300)

```
fn archive_thread(&self, params: ArchiveThreadParams) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Marks a thread as archived so normal active-thread views can hide it. Archiving keeps the data but changes where or how it is considered visible.

**Data flow**: It receives ArchiveThreadParams, boxes an async call, and delegates to archive_thread::archive_thread. The result is success or a store error.

**Call relations**: Archive actions call this through ThreadStore. The archive_thread module performs the filesystem and optional SQLite updates.

*Call graph*: calls 1 internal fn (archive_thread); 1 external calls (pin).


##### `LocalThreadStore::unarchive_thread`  (lines 302–304)

```
fn unarchive_thread(&self, params: ArchiveThreadParams) -> ThreadStoreFuture<'_, StoredThread>
```

**Purpose**: Restores an archived thread to the active set. It returns the thread after it has been made visible again.

**Data flow**: It receives ArchiveThreadParams, boxes an async call, and delegates to unarchive_thread::unarchive_thread. The result is the restored StoredThread or an error.

**Call relations**: Unarchive actions call this through ThreadStore. The unarchive_thread module performs the concrete move or metadata changes.

*Call graph*: calls 1 internal fn (unarchive_thread); 1 external calls (pin).


##### `LocalThreadStore::delete_thread`  (lines 306–308)

```
fn delete_thread(&self, params: DeleteThreadParams) -> ThreadStoreFuture<'_, ()>
```

**Purpose**: Deletes a stored thread. This is the destructive path for removing local thread data.

**Data flow**: It receives DeleteThreadParams, boxes an async call, and delegates to delete_thread::delete_thread. The result tells whether deletion succeeded or why it failed.

**Call relations**: Delete commands call this through ThreadStore. The delete_thread module handles the actual file and optional SQLite cleanup.

*Call graph*: calls 1 internal fn (delete_thread); 1 external calls (pin).


##### `tests::live_writer_lifecycle_writes_and_closes`  (lines 332–378)

```
async fn live_writer_lifecycle_writes_and_closes()
```

**Purpose**: Tests the normal life of a live writer: create, append, persist, flush, then shut down. It proves that data reaches the rollout file and that shutdown removes the live writer.

**Data flow**: The test creates a temporary store, opens a thread, appends a user message, flushes it, checks the rollout file for that message, shuts the thread down, and then verifies another append fails.

**Call relations**: It exercises LocalThreadStore::create_thread, append_items, persist_thread, flush_thread, live_rollout_path, and shutdown_thread. The helper assert_rollout_contains_message confirms the written file content.

*Call graph*: calls 3 internal fn (default, new, test_config); 5 external calls (new, assert!, assert_rollout_contains_message, create_thread_params, vec!).


##### `tests::raw_append_items_does_not_update_sqlite_metadata`  (lines 381–415)

```
async fn raw_append_items_does_not_update_sqlite_metadata()
```

**Purpose**: Tests an important contract: raw appends write history only and do not automatically update SQLite metadata. This keeps metadata updates explicit.

**Data flow**: The test creates a store with SQLite, creates a thread, appends a message through append_items, flushes, and then reads SQLite directly. It expects no metadata row for that thread.

**Call relations**: It contrasts raw ThreadStore appends with the LiveThread behavior tested later. The state database is used only to confirm that no metadata was created.

*Call graph*: calls 4 internal fn (default, init, new, test_config); 4 external calls (new, assert_eq!, create_thread_params, vec!).


##### `tests::live_thread_observes_appended_items_into_sqlite_metadata`  (lines 418–450)

```
async fn live_thread_observes_appended_items_into_sqlite_metadata()
```

**Purpose**: Tests that the higher-level LiveThread wrapper observes appended messages and turns them into SQLite metadata. This confirms the intended path for keeping the searchable catalog current.

**Data flow**: The test creates a store with SQLite, creates a LiveThread, appends a user message, flushes, and reads the database. It expects first message, preview, and title fields to reflect the appended text.

**Call relations**: It uses LiveThread::create instead of raw append_items. That higher layer calls the store and then updates metadata through the intended metadata path.

*Call graph*: calls 5 internal fn (default, init, create, new, test_config); 5 external calls (new, new, assert_eq!, create_thread_params, user_message_item).


##### `tests::live_thread_shutdown_does_not_materialize_empty_thread_metadata`  (lines 453–486)

```
async fn live_thread_shutdown_does_not_materialize_empty_thread_metadata()
```

**Purpose**: Tests that shutting down an empty live thread does not create a useless file or database record. Empty abandoned conversations should not clutter local storage.

**Data flow**: The test creates a LiveThread with SQLite, records its expected rollout path, shuts it down without appending items, and checks that the file and SQLite metadata are absent.

**Call relations**: It exercises LiveThread shutdown behavior on top of LocalThreadStore. The database read confirms that no metadata was accidentally materialized.

*Call graph*: calls 5 internal fn (default, init, create, new, test_config); 5 external calls (new, new, assert!, assert_eq!, create_thread_params).


##### `tests::live_thread_shutdown_with_buffered_items_materializes_before_metadata_read`  (lines 489–530)

```
async fn live_thread_shutdown_with_buffered_items_materializes_before_metadata_read()
```

**Purpose**: Tests that a live thread with buffered items is saved before shutdown metadata is checked. Even metadata-only rollout items should cause the thread to exist if something was written.

**Data flow**: The test creates a LiveThread, appends a token-count item, shuts down, then checks that the rollout file exists and SQLite has metadata pointing to that path.

**Call relations**: It covers the shutdown path where buffered writer state must be persisted. The SQLite lookup verifies that metadata was created after materialization.

*Call graph*: calls 5 internal fn (default, init, create, new, test_config); 7 external calls (new, new, assert!, assert_eq!, TokenCount, EventMsg, create_thread_params).


##### `tests::live_thread_resume_loads_history_before_observing_metadata`  (lines 533–583)

```
async fn live_thread_resume_loads_history_before_observing_metadata()
```

**Purpose**: Tests that resuming a saved thread reads its old history before deciding metadata from new appends. This prevents newer resume parameters from overwriting facts already present in the rollout.

**Data flow**: The test writes an existing session file, resumes it as a LiveThread with different metadata values, appends a new message, and checks SQLite. It expects created time, provider, and first message to come from the old rollout history.

**Call relations**: It exercises LiveThread::resume and the local read/resume path. The write_session_file helper supplies the existing rollout that should be trusted first.

*Call graph*: calls 6 internal fn (from_string, init, resume, new, test_config, write_session_file); 5 external calls (new, new, assert_eq!, user_message_item, from_u128).


##### `tests::live_thread_resume_loads_history_from_explicit_external_rollout_path`  (lines 586–637)

```
async fn live_thread_resume_loads_history_from_explicit_external_rollout_path()
```

**Purpose**: Tests that resume can read history from a rollout file outside the normal Codex home. This matters for imported or explicitly supplied rollout paths.

**Data flow**: The test writes a session file in a separate temporary folder, resumes using that explicit path, appends a new message, and checks SQLite metadata. It expects old history from the external file to shape the metadata.

**Call relations**: It focuses on the resume path's ability to honor an explicit rollout_path. The local store must not assume every live thread file is under its own home directory.

*Call graph*: calls 6 internal fn (from_string, init, resume, new, test_config, write_session_file); 5 external calls (new, new, assert_eq!, user_message_item, from_u128).


##### `tests::create_thread_rejects_missing_cwd`  (lines 640–657)

```
async fn create_thread_rejects_missing_cwd()
```

**Purpose**: Tests that creating a local thread requires a current working directory. The directory is part of the local persistence metadata needed for later context.

**Data flow**: The test builds normal create params, removes the cwd field, calls create_thread, and expects an InvalidRequest error with the specific message.

**Call relations**: It exercises validation inside the create-thread flow delegated to live_writer. The helper create_thread_params supplies the otherwise valid request.

*Call graph*: calls 3 internal fn (default, new, test_config); 3 external calls (new, assert!, create_thread_params).


##### `tests::discard_thread_drops_unmaterialized_live_writer`  (lines 660–693)

```
async fn discard_thread_drops_unmaterialized_live_writer()
```

**Purpose**: Tests that discarding a not-yet-materialized live thread removes it cleanly. After discard, the file should not exist and the writer should no longer accept appends.

**Data flow**: The test creates a thread, records its rollout path, discards it, verifies the path does not exist, then tries to append and expects ThreadNotFound.

**Call relations**: It covers LocalThreadStore::discard_thread and the live-recorder removal behavior. It is the discard counterpart to the normal shutdown lifecycle test.

*Call graph*: calls 3 internal fn (default, new, test_config); 4 external calls (new, assert!, create_thread_params, vec!).


##### `tests::resume_thread_reopens_live_writer_and_appends`  (lines 696–755)

```
async fn resume_thread_reopens_live_writer_and_appends()
```

**Purpose**: Tests that a thread can be created, shut down, reopened in a new store, and appended to again. This proves saved rollout files can continue across store instances.

**Data flow**: The test writes an initial message with one store, flushes and shuts it down, creates a second store with the same config, resumes the thread, appends another message, and checks the same rollout file for both messages.

**Call relations**: It exercises create, append, persist, flush, shutdown, and resume flows. The final file check confirms that resume appended to the existing history rather than starting over.

*Call graph*: calls 3 internal fn (default, new, test_config); 5 external calls (new, assert_rollout_contains_message, create_thread_params, thread_metadata, vec!).


##### `tests::create_thread_rejects_duplicate_live_writer`  (lines 758–775)

```
async fn create_thread_rejects_duplicate_live_writer()
```

**Purpose**: Tests that creating the same live thread twice is rejected. This protects one rollout file from having two active writers.

**Data flow**: The test creates a thread, then calls create_thread again with the same id. It expects an InvalidRequest error mentioning an existing live local writer.

**Call relations**: It exercises LocalThreadStore::ensure_live_recorder_absent and insert protection through the create path. This guards the live-recorder map against duplicates.

*Call graph*: calls 3 internal fn (default, new, test_config); 3 external calls (new, assert!, create_thread_params).


##### `tests::resume_thread_rejects_duplicate_live_writer`  (lines 778–803)

```
async fn resume_thread_rejects_duplicate_live_writer()
```

**Purpose**: Tests that resuming a thread already open for live writing is rejected. Resume must not create a second writer for the same thread.

**Data flow**: The test creates a live thread, gets its rollout path, tries to resume the same thread using that path, and expects an InvalidRequest error about an existing live writer.

**Call relations**: It checks the same duplicate-writer protection as create, but through the resume path. The live_rollout_path call supplies the path for the attempted duplicate resume.

*Call graph*: calls 3 internal fn (default, new, test_config); 4 external calls (new, assert!, create_thread_params, thread_metadata).


##### `tests::resume_thread_rejects_missing_cwd`  (lines 806–830)

```
async fn resume_thread_rejects_missing_cwd()
```

**Purpose**: Tests that resuming a local thread also requires a current working directory in metadata. Resume needs the same local context as create.

**Data flow**: The test writes an existing session file, builds resume params with cwd set to None, calls resume_thread, and expects an InvalidRequest error mentioning the missing cwd.

**Call relations**: It exercises validation in live_writer::resume_thread through the LocalThreadStore trait method. The archived or external history details are not the focus here; metadata validity is.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 3 external calls (new, assert!, from_u128).


##### `tests::load_history_uses_live_writer_rollout_path`  (lines 833–878)

```
async fn load_history_uses_live_writer_rollout_path()
```

**Purpose**: Tests that load_history reads from the active live writer's rollout path, even when that path is external. This prevents history reads from looking in the wrong local folder.

**Data flow**: The test writes an external session file, resumes it, appends and flushes a new item, then calls load_history. It expects the returned history to include the newly appended external item.

**Call relations**: It directly covers LocalThreadStore::load_history's first step: ask live_writer for the active path before falling back to thread-id lookup.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 5 external calls (new, assert!, thread_metadata, from_u128, vec!).


##### `tests::read_thread_uses_live_writer_rollout_path_for_external_resume`  (lines 881–917)

```
async fn read_thread_uses_live_writer_rollout_path_for_external_resume()
```

**Purpose**: Tests that read_thread also respects the live writer path for an externally resumed thread. Reading by id should still find the actual active file.

**Data flow**: The test creates an external rollout, resumes it, then reads the thread by id with history included. It expects the stored rollout path to equal the external path and the history to include the old user message.

**Call relations**: It covers read_thread behavior while a live recorder points outside the normal home. This complements the load_history external-path test.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 5 external calls (new, assert!, assert_eq!, thread_metadata, from_u128).


##### `tests::load_history_uses_live_writer_rollout_path_for_archived_source`  (lines 920–984)

```
async fn load_history_uses_live_writer_rollout_path_for_archived_source()
```

**Purpose**: Tests archived handling for a live thread resumed from an archived rollout file. Active-only reads should reject it, while archived-inclusive reads should work.

**Data flow**: The test writes an archived session file, resumes it, appends and flushes a message, then tries read_thread and load_history with include_archived false and expects errors. It then loads history with include_archived true and expects the appended message.

**Call relations**: It exercises LocalThreadStore::load_history's archive check and the read path's equivalent behavior. The helper write_archived_session_file creates the archived source.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_archived_session_file); 5 external calls (new, assert!, thread_metadata, from_u128, vec!).


##### `tests::read_thread_by_rollout_path_includes_history`  (lines 987–1029)

```
async fn read_thread_by_rollout_path_includes_history()
```

**Purpose**: Tests that reading directly by rollout path can include full history. This is the path-based read API's basic success case.

**Data flow**: The test creates a thread, appends one user message, flushes, gets the rollout path, reads by that path with history included, and checks the thread id and user-message count.

**Call relations**: It exercises the inherent path-read helper and the read_thread_by_rollout_path machinery. It confirms the include_history flag is honored.

*Call graph*: calls 3 internal fn (default, new, test_config); 4 external calls (new, assert_eq!, create_thread_params, vec!).


##### `tests::create_thread_params`  (lines 1031–1044)

```
fn create_thread_params(thread_id: ThreadId) -> CreateThreadParams
```

**Purpose**: Builds a standard CreateThreadParams value for tests. It keeps test setup short and consistent.

**Data flow**: It receives a thread id, fills in default source, instructions, tool, relationship, and metadata fields, and returns a complete create request.

**Call relations**: Many tests call this before creating a thread. It calls tests::thread_metadata for the shared metadata block.

*Call graph*: calls 1 internal fn (default); 2 external calls (new, thread_metadata).


##### `tests::thread_metadata`  (lines 1046–1052)

```
fn thread_metadata() -> ThreadPersistenceMetadata
```

**Purpose**: Builds standard thread persistence metadata for tests. It supplies a current working directory, test model provider, and enabled memory mode.

**Data flow**: It reads the process current directory, combines it with fixed test values, and returns ThreadPersistenceMetadata.

**Call relations**: Test helpers and resume tests call this wherever valid local metadata is needed. Individual tests modify its output when they need to test invalid metadata.

*Call graph*: 1 external calls (current_dir).


##### `tests::user_message_item`  (lines 1054–1063)

```
fn user_message_item(message: &str) -> RolloutItem
```

**Purpose**: Creates a rollout item representing a user message for tests. This avoids repeating the nested event construction in every test.

**Data flow**: It receives message text, places it into a UserMessageEvent with default optional fields, wraps that as an EventMsg, then wraps it as a RolloutItem.

**Call relations**: Lifecycle, append, resume, and read tests use this helper when they need a realistic user-message entry in thread history.

*Call graph*: 4 external calls (default, new, UserMessage, EventMsg).


##### `tests::assert_rollout_contains_message`  (lines 1065–1075)

```
async fn assert_rollout_contains_message(path: &std::path::Path, expected: &str)
```

**Purpose**: Checks that a rollout file contains a particular user message. It is a test assertion helper for confirming that writes reached disk.

**Data flow**: It receives a file path and expected text, loads rollout items from the file, scans for a user-message item with matching text, and fails the test if none is found.

**Call relations**: Several live-writer tests call this after flushing or resuming. It uses RolloutRecorder::load_rollout_items, the same rollout-file reader used by storage code.

*Call graph*: calls 1 internal fn (load_rollout_items); 1 external calls (assert!).


### Local thread lifecycle operations
These files cover the main local thread-store behaviors for live writing, reconstructing stored threads, browsing and searching them, and deleting persisted data.

### `thread-store/src/local/live_writer.rs`

`io_transport` · `active during a local thread’s live lifetime: create/resume, append, flush/persist, and shutdown`

A thread is a saved conversation. While a thread is “live”, new events need to be written to disk in the right order so the conversation can be recovered later. This file is the bridge between the local thread store and the rollout recorder, which is the object that writes the detailed history file for a thread.

The main idea is simple: before a thread can receive new saved items, it must have exactly one live recorder. Creating or resuming a thread starts that recorder and stores it in the local thread store. Appending items first converts them into the stable saved format, then asks the recorder to write them, and then flushes the writer so the JSONL history file is caught up before other metadata is applied. JSONL means “one JSON record per line”, a common format for append-only logs.

The file also has end-of-life actions. Persisting and flushing force pending data to disk. Shutting down closes the recorder and removes it from the live set. Discarding simply drops the live recorder without doing a shutdown write. A small helper keeps the stored metadata’s rollout path aligned with the real materialized file path, so the database does not point at the wrong history file.

#### Function details

##### `create_thread`  (lines 20–28)

```
async fn create_thread(
    store: &LocalThreadStore,
    params: CreateThreadParams,
) -> ThreadStoreResult<()>
```

**Purpose**: Starts a brand-new local thread recorder. It prevents accidentally starting two live writers for the same thread, then creates the underlying rollout recorder and registers it as the active writer.

**Data flow**: It receives the local store and creation details, including the thread id. It first checks the store to make sure no recorder is already live for that id. Then it asks the lower-level thread creation code to make the recorder. Finally, it places that recorder into the store’s live-recorder map so later appends know where to write.

**Call relations**: This is called when the local thread store is asked to create a live thread. It relies on the store’s duplicate-recorder check before handing off to the lower-level create-thread routine, then gives the resulting recorder back to the store for future write operations.

*Call graph*: calls 3 internal fn (ensure_live_recorder_absent, insert_live_recorder, create_thread); called by 1 (create_thread).


##### `resume_thread`  (lines 30–75)

```
async fn resume_thread(
    store: &LocalThreadStore,
    params: ResumeThreadParams,
) -> ThreadStoreResult<()>
```

**Purpose**: Reopens an existing thread so new events can continue being written to its history file. It finds the correct rollout path, builds recorder settings from the thread metadata, and installs the resumed recorder as live.

**Data flow**: It receives the store and resume parameters. If the caller already supplied a rollout path, it uses that. Otherwise it reads the thread metadata to discover the saved rollout path. It also requires a current working directory from metadata, because the local recorder needs a folder context. It builds a rollout configuration from store settings and thread metadata, creates a recorder in resume mode, and saves that recorder in the live-recorder map.

**Call relations**: This is used by the local resume flow before any new items are appended. If needed, it calls the thread reader to recover missing path information, then calls the rollout recorder constructor with resume parameters. Once the recorder is created, it hands it to the store so append, flush, persist, and shutdown calls can find it.

*Call graph*: calls 5 internal fn (new, resume, ensure_live_recorder_absent, insert_live_recorder, read_thread); called by 1 (resume_thread); 1 external calls (matches!).


##### `append_items`  (lines 77–93)

```
async fn append_items(
    store: &LocalThreadStore,
    params: AppendThreadItemsParams,
) -> ThreadStoreResult<()>
```

**Purpose**: Writes newly accepted thread items to the live rollout history. It also flushes immediately so the detailed history file is not behind the store metadata that may be updated right after this call.

**Data flow**: It receives the store and a batch of items to append. It converts the items into the canonical persisted form, meaning the stable form that should actually be saved. If nothing remains after that conversion, it returns without writing. Otherwise it looks up the live recorder for the thread, records the canonical items, and flushes the recorder to push the data to disk.

**Call relations**: This is called when the live thread accepts new items. It depends on a recorder having already been installed by create_thread or resume_thread. After recording, it deliberately flushes before returning because the surrounding live-thread flow applies metadata immediately afterward, and the code wants the JSONL history to be at least as up to date as the database.

*Call graph*: calls 1 internal fn (live_recorder); called by 1 (append_items); 1 external calls (persisted_rollout_items).


##### `persist_thread`  (lines 95–106)

```
async fn persist_thread(
    store: &LocalThreadStore,
    thread_id: ThreadId,
) -> ThreadStoreResult<()>
```

**Purpose**: Forces a live thread recorder to persist its data, then updates stored metadata if the recorder’s actual rollout path has changed. This is used when the system wants stronger assurance that the thread’s history is saved.

**Data flow**: It receives the store and thread id. It finds the live recorder for that thread, asks it to persist, converts any file-writing error into a thread-store error, and then calls the path-sync helper. The result is either success or a thread-store error if the live recorder cannot be found or the write fails.

**Call relations**: This function is used by the local persist flow and also after metadata updates that need the disk state to be durable. It hands the final metadata alignment step to sync_materialized_rollout_path so the database can reflect the actual rollout file location.

*Call graph*: calls 2 internal fn (live_recorder, sync_materialized_rollout_path); called by 2 (persist_thread, update_thread_metadata).


##### `flush_thread`  (lines 108–119)

```
async fn flush_thread(
    store: &LocalThreadStore,
    thread_id: ThreadId,
) -> ThreadStoreResult<()>
```

**Purpose**: Pushes pending live recorder writes to disk without fully closing the recorder. It then checks whether the metadata’s rollout path needs to be brought up to date.

**Data flow**: It receives the store and thread id. It gets the live recorder, asks it to flush buffered data, turns any input/output error into the project’s thread-store error type, and then runs the rollout-path sync. It leaves the recorder active for future appends.

**Call relations**: This is called when the local thread store needs current pending writes to land on disk while the thread remains live. Like persist_thread, it delegates the metadata-path cleanup to sync_materialized_rollout_path after the recorder has written its data.

*Call graph*: calls 2 internal fn (live_recorder, sync_materialized_rollout_path); called by 1 (flush_thread).


##### `shutdown_thread`  (lines 121–130)

```
async fn shutdown_thread(
    store: &LocalThreadStore,
    thread_id: ThreadId,
) -> ThreadStoreResult<()>
```

**Purpose**: Cleanly closes a live thread recorder and removes it from the store’s active recorder list. This is the normal end-of-life path for a live local thread writer.

**Data flow**: It receives the store and thread id. It looks up the live recorder, asks it to shut down, syncs the materialized rollout path into metadata if possible, then locks the live-recorder map and removes the recorder entry. After this, the thread is no longer considered live in this store.

**Call relations**: This is called when the local thread store is shutting down a live thread. It first lets the recorder finish its own shutdown work, then uses sync_materialized_rollout_path to keep metadata accurate, and only then removes the recorder so later operations cannot write through it.

*Call graph*: calls 2 internal fn (live_recorder, sync_materialized_rollout_path); called by 1 (shutdown_thread).


##### `discard_thread`  (lines 132–143)

```
async fn discard_thread(
    store: &LocalThreadStore,
    thread_id: ThreadId,
) -> ThreadStoreResult<()>
```

**Purpose**: Forgets a live recorder without asking it to flush, persist, or shut down. This is useful for abandoning a live writer entry when the caller does not want the normal close-out behavior.

**Data flow**: It receives the store and thread id. It locks the live-recorder map, removes the recorder for that thread if one exists, and returns success. If there is no matching recorder, it returns a thread-not-found error.

**Call relations**: This is called by the local discard flow. Unlike shutdown_thread, it does not talk to the recorder or sync metadata; it only edits the store’s live-recorder table.

*Call graph*: called by 1 (discard_thread).


##### `rollout_path`  (lines 145–157)

```
async fn rollout_path(
    store: &LocalThreadStore,
    thread_id: ThreadId,
) -> ThreadStoreResult<PathBuf>
```

**Purpose**: Returns the filesystem path for the live recorder’s rollout history file. Other code uses this when it needs to read, resolve, or store the location of a live thread’s history.

**Data flow**: It receives the store and thread id. It locks the live-recorder map, finds the recorder for that thread, asks the recorder for its rollout path, copies that path into a PathBuf, and returns it. If the thread has no live recorder, it returns a thread-not-found error.

**Call relations**: This is a small lookup helper used by several flows that need the live history file path, including history loading, path resolution, metadata updates, and the sync helper in this file. It does not write anything itself; it supplies the path that those larger operations need.

*Call graph*: called by 7 (live_rollout_path, load_history, sync_materialized_rollout_path, resolve_rollout_path, apply_metadata_update, resolve_rollout_path, update_thread_metadata).


##### `sync_materialized_rollout_path`  (lines 159–200)

```
async fn sync_materialized_rollout_path(
    store: &LocalThreadStore,
    thread_id: ThreadId,
) -> ThreadStoreResult<()>
```

**Purpose**: Keeps the thread metadata’s rollout path aligned with the actual rollout file path once that file exists. This prevents the database from pointing to an outdated or temporary path.

**Data flow**: It receives the store and thread id. It first asks rollout_path for the live recorder’s current path. If that path does not correspond to an existing materialized rollout file, it stops. If the store has no state database, it also stops. Otherwise it reads the thread metadata from the database, compares the saved rollout path with the live recorder’s path, and writes an updated metadata row only if the path changed. If this sync work fails, it logs a warning but still returns success to the caller.

**Call relations**: This helper is called after persist_thread, flush_thread, and shutdown_thread, because those are moments when the recorder may have finalized or revealed the real file path. It consults the live recorder path, checks the rollout layer’s view of whether the file exists, and then talks to the state database only when there is something worth syncing.

*Call graph*: calls 2 internal fn (state_db, rollout_path); called by 3 (flush_thread, persist_thread, shutdown_thread); 2 external calls (existing_rollout_path, warn!).


##### `thread_store_io_error`  (lines 202–206)

```
fn thread_store_io_error(err: std::io::Error) -> ThreadStoreError
```

**Purpose**: Converts a standard file input/output error into the thread store’s own error type. This gives callers one consistent kind of error to handle.

**Data flow**: It receives a standard input/output error. It turns the error into text and wraps that text inside ThreadStoreError::Internal. The returned value can then be passed up through thread-store results.

**Call relations**: This helper is used by recorder-writing operations in this file, such as append, persist, flush, and shutdown paths. It is the small adapter between low-level disk errors and the higher-level thread store API.

*Call graph*: 1 external calls (to_string).


### `thread-store/src/local/read_thread.rs`

`domain_logic` · `request handling`

A thread can be remembered in two places: a SQLite database that stores fast metadata, and a rollout file, which is a line-by-line log of what happened in the session. This file is the reader that turns those sources into one `StoredThread`, the project’s common shape for a saved conversation. It first tries the fast SQLite metadata when it is safe to trust. If the caller asks for full history, it double-checks that SQLite’s saved rollout path still exists and still belongs to the requested thread, because files can be moved or replaced. If SQLite is missing, stale, archived when archived threads are not allowed, or otherwise not enough, it searches for the rollout file by thread id. Reading by an explicit rollout path follows the same idea, but starts from the caller’s path and verifies it points to a real file. The file also handles older storage formats. If a rollout does not contain a normal summary item, it falls back to the session metadata line. It parses stored strings into richer values such as session source and approval mode, fills in defaults when old data is incomplete, and attaches history only when requested. The tests cover active and archived threads, stale SQLite paths, legacy names and sandbox policy data, fork information, and missing files.

#### Function details

##### `read_thread`  (lines 29–86)

```
async fn read_thread(
    store: &LocalThreadStore,
    params: ReadThreadParams,
) -> ThreadStoreResult<StoredThread>
```

**Purpose**: Reads one thread by its thread id. It chooses the best available source: SQLite metadata when it is trustworthy, otherwise the rollout log file on disk.

**Data flow**: It receives a local store and read options, including the thread id, whether archived threads are allowed, and whether full history is wanted. It looks up SQLite metadata, checks archive rules and whether history can safely be loaded from the saved path, may refresh the summary from the rollout file, then optionally adds history. If SQLite is not usable, it locates the rollout file and reads from that instead. It returns a complete `StoredThread` or an error explaining why the thread could not be read.

**Call relations**: Higher-level flows such as loading history, resuming a thread, and applying or updating metadata call this when they need the current thread record. It delegates small jobs to `read_sqlite_metadata`, `stored_thread_from_sqlite_metadata`, `resolve_rollout_path`, `read_thread_from_rollout_path`, `sqlite_rollout_path_can_load_history_for_thread`, and `attach_history_if_requested` so each source and safety check is handled in one place.

*Call graph*: calls 8 internal fn (permission_profile_from_metadata_value, rollout_path_is_archived, attach_history_if_requested, read_sqlite_metadata, read_thread_from_rollout_path, resolve_rollout_path, sqlite_rollout_path_can_load_history_for_thread, stored_thread_from_sqlite_metadata); called by 5 (load_history, read_thread, resume_thread, apply_metadata_update, update_thread_metadata); 1 external calls (format!).


##### `sqlite_rollout_path_can_load_history_for_thread`  (lines 88–102)

```
async fn sqlite_rollout_path_can_load_history_for_thread(
    store: &LocalThreadStore,
    path: &std::path::Path,
    thread_id: codex_protocol::ThreadId,
) -> bool
```

**Purpose**: Checks whether the rollout path saved in SQLite can really be used to load history for the requested thread. This protects against stale database records pointing at missing files or at a different thread.

**Data flow**: It receives the store, a path, and the expected thread id. It first checks whether the path exists as a rollout file. Then it reads the thread summary from that path and compares the thread id inside the file with the expected id. It returns `true` only if both checks pass.

**Call relations**: `read_thread` uses this before trusting SQLite metadata when full history is requested. It calls `read_thread_from_rollout_path` as a verification step, so the history loader later does not replay the wrong file.

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

**Purpose**: Reads a thread when the caller already has a rollout file path instead of only a thread id. It is useful for path-based operations, while still applying archive rules and optional history loading.

**Data flow**: It receives the store, a rollout path, and flags for archived threads and history. It resolves the path into a real file, reads the thread from that file, rejects archived threads unless allowed, and then consults SQLite for extra metadata such as newer git information. If requested, it loads the full history before returning the `StoredThread`.

**Call relations**: This is called by path-based history and metadata flows. It relies on `resolve_requested_rollout_path` for safe path handling, `read_thread_from_rollout_path` for the file contents, `read_sqlite_metadata` and `git_info_from_parts` for metadata enrichment, and `attach_history_if_requested` for full replay data.

*Call graph*: calls 5 internal fn (git_info_from_parts, attach_history_if_requested, read_sqlite_metadata, read_thread_from_rollout_path, resolve_requested_rollout_path); called by 4 (load_history, read_thread_by_rollout_path, read_thread_by_rollout_path_params, update_thread_metadata); 1 external calls (format!).


##### `resolve_requested_rollout_path`  (lines 137–176)

```
async fn resolve_requested_rollout_path(
    store: &LocalThreadStore,
    rollout_path: std::path::PathBuf,
) -> ThreadStoreResult<std::path::PathBuf>
```

**Purpose**: Turns a caller-provided rollout path into a canonical real file path. It rejects paths that do not point to a normal existing file.

**Data flow**: It receives the store and a path. If the path is relative, it treats it as relative to the Codex home directory. It checks whether the target is a directory, a non-file, or missing, and returns a clear invalid-request error for those cases. When valid, it returns the canonical absolute path.

**Call relations**: `read_thread_by_rollout_path` calls this before reading any file contents. It uses filesystem metadata, rollout path existence checks, and canonicalization so later code can assume the path is safe and concrete.

*Call graph*: called by 1 (read_thread_by_rollout_path); 5 external calls (is_relative, existing_rollout_path, format!, canonicalize, metadata).


##### `attach_history_if_requested`  (lines 178–194)

```
async fn attach_history_if_requested(
    thread: &mut StoredThread,
    include_history: bool,
) -> ThreadStoreResult<()>
```

**Purpose**: Adds the full rollout history to a thread only when the caller asked for it. This avoids expensive file replay when a summary is enough.

**Data flow**: It receives a mutable `StoredThread` and a flag. If the flag is false, it leaves the thread unchanged. If true, it requires the thread to have a rollout path, loads the rollout items from that path, and stores them inside `thread.history` along with the thread id.

**Call relations**: Both `read_thread` and `read_thread_by_rollout_path` call this at the end of their reading process. It hands the actual file loading to `load_history_items` and converts the loaded items into `StoredThreadHistory`.

*Call graph*: calls 1 internal fn (load_history_items); called by 2 (read_thread, read_thread_by_rollout_path); 1 external calls (format!).


##### `resolve_rollout_path`  (lines 196–243)

```
async fn resolve_rollout_path(
    store: &LocalThreadStore,
    thread_id: codex_protocol::ThreadId,
    include_archived: bool,
) -> ThreadStoreResult<Option<std::path::PathBuf>>
```

**Purpose**: Finds the rollout file for a thread id. It knows where to look for live, active, and archived rollout files.

**Data flow**: It receives the store, a thread id, and whether archived threads are allowed. It first checks whether there is a live writer path for the thread. If that does not work, it uses the state database context when available and searches the Codex home directory for active files, and then archived files if allowed. It returns an optional path or an error if the search itself fails.

**Call relations**: `read_thread` calls this when SQLite metadata cannot be used. It works with `live_writer::rollout_path`, rollout existence checks, archive-path checks, and rollout search helpers to find the best file location.

*Call graph*: calls 3 internal fn (state_db, rollout_path_is_archived, rollout_path); called by 1 (read_thread); 4 external calls (existing_rollout_path, find_archived_thread_path_by_id_str, find_thread_path_by_id_str, to_string).


##### `read_thread_from_rollout_path`  (lines 245–279)

```
async fn read_thread_from_rollout_path(
    store: &LocalThreadStore,
    path: std::path::PathBuf,
) -> ThreadStoreResult<StoredThread>
```

**Purpose**: Builds a `StoredThread` by reading a rollout log file. This is the main bridge from raw on-disk session logs to the thread summary used by the rest of the system.

**Data flow**: It receives the store and a rollout path. It tries to read a summary item from the rollout. If none exists, it falls back to the session metadata line. When a summary is found, it converts it to a `StoredThread`, marks whether it is archived, records the plain rollout path, adds fork and parent ids from session metadata, applies a non-empty model provider from metadata, and applies a saved thread name if one exists. It returns the assembled thread.

**Call relations**: This helper is used by `read_thread`, `read_thread_by_rollout_path`, and `sqlite_rollout_path_can_load_history_for_thread`. It delegates conversion to `stored_thread_from_rollout_item`, fallback construction to `stored_thread_from_session_meta`, and name cleanup to `set_thread_name_from_title`.

*Call graph*: calls 4 internal fn (rollout_path_is_archived, set_thread_name_from_title, stored_thread_from_rollout_item, stored_thread_from_session_meta); called by 3 (read_thread, read_thread_by_rollout_path, sqlite_rollout_path_can_load_history_for_thread); 6 external calls (as_path, clone, find_thread_name_by_id, plain_rollout_path, read_session_meta_line, read_thread_item_from_rollout).


##### `load_history_items`  (lines 281–290)

```
async fn load_history_items(
    path: &std::path::Path,
) -> ThreadStoreResult<Vec<codex_protocol::protocol::RolloutItem>>
```

**Purpose**: Loads every recorded rollout item from a rollout file. This is used when callers need the full conversation, not just a summary.

**Data flow**: It receives a file path. It asks `RolloutRecorder` to load the rollout items from disk, converts any loading failure into a thread-store internal error with the path included, and returns the vector of rollout items.

**Call relations**: `attach_history_if_requested` calls this only when history was requested. It is the narrow point where full rollout replay data is read from disk.

*Call graph*: calls 1 internal fn (load_rollout_items); called by 1 (attach_history_if_requested).


##### `read_sqlite_metadata`  (lines 292–298)

```
async fn read_sqlite_metadata(
    store: &LocalThreadStore,
    thread_id: codex_protocol::ThreadId,
) -> Option<ThreadMetadata>
```

**Purpose**: Looks up a thread’s metadata row in the local SQLite state database. SQLite is the fast summary source when it is available.

**Data flow**: It receives the store and thread id. It asks the store for a state database runtime; if there is none, it returns `None`. If there is a database, it fetches the thread row and returns the metadata when found, ignoring lookup errors by returning no metadata.

**Call relations**: `read_thread` uses this as its first possible source. `read_thread_by_rollout_path` uses it after reading a rollout file to enrich the result with database-backed details such as git information.

*Call graph*: calls 1 internal fn (state_db); called by 2 (read_thread, read_thread_by_rollout_path).


##### `stored_thread_from_sqlite_metadata`  (lines 300–362)

```
async fn stored_thread_from_sqlite_metadata(
    store: &LocalThreadStore,
    metadata: ThreadMetadata,
) -> StoredThread
```

**Purpose**: Converts a SQLite `ThreadMetadata` record into the common `StoredThread` shape. It fills in names, preview text, permissions, git details, and defaults that callers expect.

**Data flow**: It receives the store and one metadata record. It chooses a display name from a distinct SQLite title or a legacy saved thread name, reads session metadata from the rollout path when available for fork and parent ids, picks preview text from preview or first user message, parses stored strings into typed source and approval values, builds permission and git information, and returns a `StoredThread` without full history.

**Call relations**: `read_thread` calls this when SQLite metadata is acceptable. It relies on helper functions such as `distinct_thread_metadata_title`, `permission_profile_from_metadata_value`, `git_info_from_parts`, `parse_session_source`, and `parse_or_default` to keep the conversion compatible with newer and older stored data.

*Call graph*: calls 5 internal fn (distinct_thread_metadata_title, git_info_from_parts, permission_profile_from_metadata_value, parse_or_default, parse_session_source); called by 1 (read_thread); 3 external calls (find_thread_name_by_id, plain_rollout_path, read_session_meta_line).


##### `stored_thread_from_session_meta`  (lines 364–377)

```
async fn stored_thread_from_session_meta(
    store: &LocalThreadStore,
    path: std::path::PathBuf,
) -> ThreadStoreResult<StoredThread>
```

**Purpose**: Creates a thread summary from only the session metadata line in a rollout file. This is the fallback for rollout files that do not contain a richer summary item.

**Data flow**: It receives the store and path. It reads the session metadata line from the file, checks whether the path is archived, and passes those pieces into `stored_thread_from_meta_line`. If the metadata line cannot be read, it returns an internal error.

**Call relations**: `read_thread_from_rollout_path` calls this when `read_thread_item_from_rollout` finds no summary item. It hands the actual object construction to `stored_thread_from_meta_line`.

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

**Purpose**: Builds a minimal `StoredThread` from a session metadata line. It provides sensible defaults when only basic session information is available.

**Data flow**: It receives the store, a parsed metadata line, the file path, and whether the file is archived. It parses the creation time, uses the file modification time as the update time when available, stores the rollout path, copies ids, working directory, source, agent data, and git data from the metadata, and fills missing summary fields with safe defaults such as empty preview, read-only permissions, and approval-on-request. It returns the constructed thread.

**Call relations**: `stored_thread_from_session_meta` calls this after successfully reading the metadata line. It uses `parse_rfc3339_non_optional` for the timestamp and filesystem metadata to estimate when the file was last updated.

*Call graph*: calls 2 internal fn (read_only, parse_rfc3339_non_optional); called by 1 (stored_thread_from_session_meta); 4 external calls (as_path, new, plain_rollout_path, metadata).


##### `parse_session_source`  (lines 426–430)

```
fn parse_session_source(source: &str) -> SessionSource
```

**Purpose**: Parses a stored session source string into a typed `SessionSource` value. It keeps older plain-string storage working as well as newer JSON-shaped storage.

**Data flow**: It receives a string. It first tries to parse the string as JSON, then tries to treat the whole string as a JSON string value. If both fail, it returns `SessionSource::Unknown`.

**Call relations**: `stored_thread_from_sqlite_metadata` uses this while converting SQLite metadata. It isolates compatibility parsing so the main conversion stays readable.

*Call graph*: called by 1 (stored_thread_from_sqlite_metadata); 1 external calls (from_str).


##### `parse_or_default`  (lines 432–439)

```
fn parse_or_default(value: &str, default: T) -> T
```

**Purpose**: Parses a stored string into any requested typed value, with a fallback default. It is a small compatibility helper for values that may be saved as JSON or as older plain strings.

**Data flow**: It receives a string and a default value. It tries JSON parsing, then plain-string JSON conversion, and returns the parsed value if either works. If parsing fails, it returns the default.

**Call relations**: `stored_thread_from_sqlite_metadata` uses this for fields such as approval mode. The function keeps bad or old saved data from breaking thread reads.

*Call graph*: called by 1 (stored_thread_from_sqlite_metadata); 1 external calls (from_str).


##### `parse_rfc3339_non_optional`  (lines 441–445)

```
fn parse_rfc3339_non_optional(value: &str) -> Option<DateTime<Utc>>
```

**Purpose**: Parses a timestamp written in RFC 3339 format, the common internet date-time format such as `2025-01-03T12:00:00Z`. It returns no value if the string is not valid.

**Data flow**: It receives a timestamp string. It tries to parse it as RFC 3339, converts the result to UTC time if successful, and returns `Some(time)`. If parsing fails, it returns `None`.

**Call relations**: `stored_thread_from_meta_line` uses this to turn the session metadata timestamp into the thread creation time, falling back to the current time if parsing fails.

*Call graph*: called by 1 (stored_thread_from_meta_line); 1 external calls (parse_from_rfc3339).


##### `tests::read_thread_returns_active_rollout_summary`  (lines 470–495)

```
async fn read_thread_returns_active_rollout_summary()
```

**Purpose**: Checks that an active rollout file can be read into a thread summary and full history. It proves the normal happy path works without SQLite.

**Data flow**: The test creates a temporary Codex home, writes a session file, reads by thread id with history enabled, and checks the id, rollout path, archive status, preview text, and loaded history id.

**Call relations**: It exercises the public store `read_thread` path, which reaches the `read_thread` function in this file and then the rollout-reading and history-loading helpers.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 3 external calls (new, from_u128, assert_eq!).


##### `tests::read_thread_returns_rollout_path_summary`  (lines 498–525)

```
async fn read_thread_returns_rollout_path_summary()
```

**Purpose**: Checks that reading by a relative rollout path works. It makes sure relative paths are resolved under the Codex home directory.

**Data flow**: The test writes a session file, strips the home directory prefix to make the path relative, reads by rollout path without history, and checks the thread id, canonical rollout path, and preview.

**Call relations**: It exercises the public path-based read method, which goes through `read_thread_by_rollout_path`, `resolve_requested_rollout_path`, and `read_thread_from_rollout_path`.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 3 external calls (new, from_u128, assert_eq!).


##### `tests::read_thread_by_rollout_path_prefers_sqlite_git_info`  (lines 528–574)

```
async fn read_thread_by_rollout_path_prefers_sqlite_git_info()
```

**Purpose**: Checks that SQLite git metadata can override or complete git data from the rollout. This keeps path-based reads aligned with the latest saved state.

**Data flow**: The test writes a rollout with git data, stores SQLite metadata with a different branch, reads by rollout path, and verifies the result uses the SQLite branch while preserving fallback commit and repository URL from the rollout.

**Call relations**: It drives `read_thread_by_rollout_path`, especially the part that calls `read_sqlite_metadata` and rebuilds git information with `git_info_from_parts`.

*Call graph*: calls 6 internal fn (from_string, new, init, new, test_config, write_session_file); 4 external calls (new, now, from_u128, assert_eq!).


##### `tests::read_thread_returns_archived_rollout_when_requested`  (lines 577–615)

```
async fn read_thread_returns_archived_rollout_when_requested()
```

**Purpose**: Checks that archived threads are hidden by default but returned when explicitly allowed. This protects callers that only want active conversations.

**Data flow**: The test writes an archived session file, first reads without archived permission and expects an invalid-request error, then reads with archived permission and checks the archived thread summary.

**Call relations**: It exercises archive filtering in `read_thread`, `resolve_rollout_path`, and `read_thread_from_rollout_path`.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_archived_session_file); 5 external calls (new, from_u128, assert!, assert_eq!, panic!).


##### `tests::read_thread_prefers_active_rollout_over_archived`  (lines 618–640)

```
async fn read_thread_prefers_active_rollout_over_archived()
```

**Purpose**: Checks that when both active and archived files exist for the same thread, the active one wins. This avoids showing an older archived copy when a live copy is available.

**Data flow**: The test writes both active and archived session files for the same id, reads with archived files allowed, and verifies the returned path and preview come from the active file.

**Call relations**: It focuses on the search order inside `resolve_rollout_path` as used by `read_thread`.

*Call graph*: calls 5 internal fn (from_string, new, test_config, write_archived_session_file, write_session_file); 3 external calls (new, from_u128, assert_eq!).


##### `tests::read_thread_returns_forked_from_id`  (lines 643–672)

```
async fn read_thread_returns_forked_from_id()
```

**Purpose**: Checks that fork information is preserved when reading a thread. Fork information tells the system which earlier conversation this one came from.

**Data flow**: The test writes a session file that includes a parent/fork id, reads the thread, and verifies the returned `forked_from_id` matches the parent thread id.

**Call relations**: It exercises `read_thread_from_rollout_path`, including the extra session metadata read that fills fork and parent fields.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file_with_fork); 3 external calls (new, from_u128, assert_eq!).


##### `tests::read_thread_applies_sqlite_thread_name`  (lines 675–712)

```
async fn read_thread_applies_sqlite_thread_name()
```

**Purpose**: Checks that a saved SQLite title becomes the thread’s display name. This confirms database metadata is used for user-facing names.

**Data flow**: The test writes a rollout file, inserts SQLite metadata with a title and first message, reads the thread, and checks that `name` is the saved title.

**Call relations**: It drives the SQLite-first branch of `read_thread` and the name selection inside `stored_thread_from_sqlite_metadata`.

*Call graph*: calls 6 internal fn (from_string, new, init, new, test_config, write_session_file); 4 external calls (new, now, from_u128, assert_eq!).


##### `tests::read_thread_returns_permission_profile_from_sqlite_metadata`  (lines 715–753)

```
async fn read_thread_returns_permission_profile_from_sqlite_metadata()
```

**Purpose**: Checks that a permission profile saved in SQLite is returned on the thread. Permissions describe what the session was allowed to do.

**Data flow**: The test stores a serialized disabled permission profile in SQLite, reads the thread, and checks that the preview comes from the rollout while the permission profile comes from SQLite.

**Call relations**: It exercises the merge behavior in `read_thread` and the permission conversion through `permission_profile_from_metadata_value`.

*Call graph*: calls 6 internal fn (from_string, new, init, new, test_config, write_session_file); 5 external calls (new, now, from_u128, assert_eq!, to_string).


##### `tests::read_thread_accepts_legacy_sandbox_policy_metadata`  (lines 756–791)

```
async fn read_thread_accepts_legacy_sandbox_policy_metadata()
```

**Purpose**: Checks that older sandbox policy strings are still understood. This keeps old saved sessions readable after the permission format changed.

**Data flow**: The test stores a legacy policy string such as `danger-full-access`, reads with history enabled, and verifies it becomes the expected permission profile.

**Call relations**: It covers the SQLite metadata conversion path in `stored_thread_from_sqlite_metadata` and the legacy handling inside `permission_profile_from_metadata_value`.

*Call graph*: calls 6 internal fn (from_string, new, init, new, test_config, write_session_file); 4 external calls (new, now, from_u128, assert_eq!).


##### `tests::read_thread_preserves_rollout_cwd_when_sqlite_metadata_exists`  (lines 794–881)

```
async fn read_thread_preserves_rollout_cwd_when_sqlite_metadata_exists()
```

**Purpose**: Checks that the rollout file’s working directory is kept when the rollout has the better live summary. This matters because permissions may depend on the actual directory used by the session.

**Data flow**: The test creates a rollout with one working directory and SQLite metadata with another. It reads without history and verifies the result uses rollout preview, provider, and working directory, while still applying the SQLite title and permission policy converted for the rollout directory.

**Call relations**: It exercises the part of `read_thread` that starts with SQLite metadata but replaces the summary with `read_thread_from_rollout_path` when the rollout has a real preview.

*Call graph*: calls 5 internal fn (from_string, new, init, new, test_config); 11 external calls (from, new, now, from_u128, new, assert_eq!, format!, json!, create, create_dir_all (+1 more)).


##### `tests::read_thread_uses_legacy_thread_name_when_sqlite_title_is_missing`  (lines 884–904)

```
async fn read_thread_uses_legacy_thread_name_when_sqlite_title_is_missing()
```

**Purpose**: Checks that the older saved thread-name file is used when SQLite has no title. This keeps names from older installations visible.

**Data flow**: The test writes a session file, appends a legacy thread name, reads the thread, and verifies that name is returned.

**Call relations**: It exercises `read_thread_from_rollout_path`, which calls the rollout helper to find a saved thread name and then applies it with `set_thread_name_from_title`.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 4 external calls (new, from_u128, assert_eq!, append_thread_name).


##### `tests::read_thread_uses_sqlite_metadata_for_rollout_without_user_preview`  (lines 907–973)

```
async fn read_thread_uses_sqlite_metadata_for_rollout_without_user_preview()
```

**Purpose**: Checks that SQLite metadata is kept when the rollout file has no user-message preview. This prevents a sparse rollout from wiping out useful database summary data.

**Data flow**: The test writes a rollout containing only session metadata, inserts richer SQLite metadata, reads with history enabled, and checks that SQLite fields like name, provider, working directory, and CLI version are returned while history still loads from the rollout file.

**Call relations**: It covers the SQLite-first branch of `read_thread`, including `sqlite_rollout_path_can_load_history_for_thread` and `attach_history_if_requested`.

*Call graph*: calls 5 internal fn (from_string, new, init, new, test_config); 9 external calls (new, now, from_u128, assert_eq!, format!, json!, create, create_dir_all, writeln!).


##### `tests::read_thread_falls_back_to_rollout_search_when_sqlite_path_is_stale`  (lines 976–1022)

```
async fn read_thread_falls_back_to_rollout_search_when_sqlite_path_is_stale()
```

**Purpose**: Checks that a missing rollout path saved in SQLite does not block reading the thread. The reader should search for the real rollout instead.

**Data flow**: The test stores SQLite metadata pointing to a missing external file, writes the real rollout under Codex home, reads with archived and history allowed, and verifies the returned thread comes from the real rollout.

**Call relations**: It exercises `read_thread` rejecting stale SQLite history paths through `sqlite_rollout_path_can_load_history_for_thread`, then falling back to `resolve_rollout_path`.

*Call graph*: calls 6 internal fn (from_string, new, init, new, test_config, write_session_file); 4 external calls (new, now, from_u128, assert_eq!).


##### `tests::read_thread_falls_back_when_sqlite_path_points_to_another_thread`  (lines 1025–1069)

```
async fn read_thread_falls_back_when_sqlite_path_points_to_another_thread()
```

**Purpose**: Checks that SQLite metadata pointing at a valid file for the wrong thread is not trusted. This prevents loading another conversation’s history by mistake.

**Data flow**: The test writes the real rollout for one id and an external rollout for another id, stores SQLite metadata for the first id pointing to the second file, reads with history, and verifies the result comes from the correct rollout.

**Call relations**: It directly validates the thread-id check inside `sqlite_rollout_path_can_load_history_for_thread` as part of the `read_thread` fallback path.

*Call graph*: calls 6 internal fn (from_string, new, init, new, test_config, write_session_file); 4 external calls (new, now, from_u128, assert_eq!).


##### `tests::read_thread_uses_session_meta_for_rollout_without_user_preview_or_sqlite_metadata`  (lines 1072–1122)

```
async fn read_thread_uses_session_meta_for_rollout_without_user_preview_or_sqlite_metadata()
```

**Purpose**: Checks that a rollout containing only session metadata can still be read when SQLite is absent. This is important for minimal or older session files.

**Data flow**: The test writes a file with only a session metadata line, reads with history enabled, and checks id, path, empty preview, provider, timestamps, archive status, working directory, CLI version, source, and one loaded history item.

**Call relations**: It exercises the fallback from `read_thread_from_rollout_path` to `stored_thread_from_session_meta` and then `stored_thread_from_meta_line`.

*Call graph*: calls 3 internal fn (from_string, new, test_config); 9 external calls (new, from_u128, assert!, assert_eq!, format!, json!, create, create_dir_all, writeln!).


##### `tests::read_thread_falls_back_to_sqlite_summary`  (lines 1125–1184)

```
async fn read_thread_falls_back_to_sqlite_summary()
```

**Purpose**: Checks that SQLite alone can provide a thread summary when the rollout file is outside the normal searchable location and history is not requested. This lets the UI show metadata even when the log is not available through rollout search.

**Data flow**: The test inserts SQLite metadata with preview, first user message, title, model, provider, working directory, CLI version, and source, then reads without history and checks those fields are returned.

**Call relations**: It covers the `stored_thread_from_sqlite_metadata` path inside `read_thread` when no rollout replay is needed.

*Call graph*: calls 5 internal fn (from_string, new, init, new, test_config); 6 external calls (new, now, from_u128, assert!, assert_eq!, format!).


##### `tests::read_thread_sqlite_fallback_respects_include_archived`  (lines 1187–1241)

```
async fn read_thread_sqlite_fallback_respects_include_archived()
```

**Purpose**: Checks that archived status in SQLite is respected when no rollout is used. Archived metadata should not appear in active-only reads.

**Data flow**: The test stores archived SQLite metadata, tries to read without archived permission and expects an invalid-request error, then reads with archived permission and checks the archived summary is returned.

**Call relations**: It validates the archive checks at the start of `read_thread` before the SQLite metadata path is accepted.

*Call graph*: calls 5 internal fn (from_string, new, init, new, test_config); 7 external calls (new, now, from_u128, assert!, assert_eq!, format!, panic!).


##### `tests::read_thread_sqlite_fallback_loads_archived_history`  (lines 1244–1288)

```
async fn read_thread_sqlite_fallback_loads_archived_history()
```

**Purpose**: Checks that archived history can be loaded through a SQLite metadata path when archived threads are allowed. This ensures archived conversations are still fully replayable.

**Data flow**: The test writes an archived rollout, stores matching archived SQLite metadata, reads with archived and history enabled, and checks the summary plus the loaded history item count.

**Call relations**: It exercises `read_thread`, `sqlite_rollout_path_can_load_history_for_thread`, `stored_thread_from_sqlite_metadata`, and `attach_history_if_requested` working together for archived data.

*Call graph*: calls 6 internal fn (from_string, new, init, new, test_config, write_archived_session_file); 5 external calls (new, now, from_u128, assert!, assert_eq!).


##### `tests::read_thread_fails_without_rollout`  (lines 1291–1313)

```
async fn read_thread_fails_without_rollout()
```

**Purpose**: Checks the error case when a requested thread cannot be found anywhere. This confirms callers get a clear invalid-request error instead of an empty or misleading thread.

**Data flow**: The test creates a store with no session files or database metadata, asks to read a thread id, and verifies the error message says no rollout was found for that id.

**Call relations**: It drives `read_thread` through the path where `read_sqlite_metadata` finds nothing and `resolve_rollout_path` returns no file.

*Call graph*: calls 3 internal fn (from_string, new, test_config); 4 external calls (new, from_u128, assert_eq!, panic!).


### `thread-store/src/local/list_threads.rs`

`domain_logic` · `request handling`

This file is the local thread store’s table-of-contents builder. A thread may live in newer SQLite state data, older rollout files on disk, or both, so this code decides where to look and then cleans up the result into one consistent shape. Without it, the app could not reliably show a user their saved conversations, page through long histories, search titles, or separate active threads from archived ones.

The main flow starts by checking the page cursor, which is a small bookmark saying “continue from here.” If the bookmark is malformed, the request is rejected early. The code then translates the store’s public sorting options into the matching options used by the lower-level rollout library. It asks that library for a page of rollout thread records, using the helper `list_rollout_threads` to pick the right source: active files, archived files, SQLite-only data, or a parent-filtered database query.

After that, it converts the raw rollout records into stored thread summaries. One important finishing step is naming. The rollout data may not contain the best title, so the code first looks in the state database for distinct titles, then falls back to legacy name lookup from disk. It is like building a contact list from several address books, then filling in missing display names from the best available source.

#### Function details

##### `list_threads`  (lines 21–108)

```
async fn list_threads(
    store: &LocalThreadStore,
    params: ListThreadsParams,
) -> ThreadStoreResult<ThreadPage>
```

**Purpose**: This is the main local listing operation. It receives the caller’s filters and paging options, fetches matching thread records, converts them into the thread-store format, and fills in readable thread names when possible.

**Data flow**: It takes a `LocalThreadStore` and `ListThreadsParams`. It reads the optional cursor, sorting choices, archive flag, filters, search term, store configuration, and optional state database. It validates and translates those inputs, asks `list_rollout_threads` for raw thread rows, converts those rows into stored thread summaries, gathers their thread IDs, looks up better titles from the state database and then from legacy files, applies those titles, and returns a `ThreadPage` with items plus the next cursor if more results exist. If the cursor is invalid or the lower-level listing fails, it returns a thread-store error instead.

**Call relations**: This function is called when the local thread store needs to answer a list request. It delegates the actual source selection and raw listing work to `list_rollout_threads`, then adds local-store polish: conversion into public thread objects and title enrichment. It also calls helper routines that recognize good metadata titles and write those titles back onto the returned thread summaries.

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

**Purpose**: This helper chooses the correct lower-level rollout listing method for the caller’s request. It is where the code decides whether to read active threads, archived threads, only the state database, or a parent-thread slice.

**Data flow**: It receives an optional state database handle, rollout configuration, default model provider, list parameters, optional cursor, and sort settings. If a parent thread ID is present, it asks the state database for only child threads of that parent and marks each returned item with that parent ID. Otherwise, it chooses among active versus archived and database-only versus mixed disk/database listing paths. It returns a raw rollout `ThreadsPage`, or wraps any failure in a `ThreadStoreError::Internal` with a readable message.

**Call relations**: The higher-level `list_threads` function uses this as its source picker before doing conversion and name cleanup. The search flow also reuses it, so search and normal listing stay consistent about archived data, state-database-only mode, provider filters, working-directory filters, and pagination. It hands off to the rollout recorder or state database functions because those lower layers know how to read the actual stored records.

*Call graph*: calls 5 internal fn (list_archived_threads, list_archived_threads_from_state_db, list_threads, list_threads_from_state_db, list_threads_db); called by 2 (list_threads, search_threads).


##### `tests::list_threads_uses_default_provider_when_rollout_omits_provider`  (lines 230–262)

```
async fn list_threads_uses_default_provider_when_rollout_omits_provider()
```

**Purpose**: This test checks that an old or incomplete rollout file without a model provider still produces a thread summary with the store’s default provider. That keeps older saved conversations from showing a blank or missing provider.

**Data flow**: It creates a temporary home directory, builds a local store with test configuration, writes one session file that deliberately omits the model provider, and asks for a normal thread listing. The returned page is expected to contain one item, and that item’s provider must be the configured test default.

**Call relations**: This test exercises the public listing path through the local store, which reaches the file’s `list_threads` function and then the rollout listing helper. It proves that the conversion step after raw rollout loading supplies a safe default when the underlying record does not include one.

*Call graph*: calls 3 internal fn (new, test_config, write_session_file_with); 4 external calls (new, from_u128, new, assert_eq!).


##### `tests::list_threads_preserves_sqlite_title_search_results`  (lines 265–330)

```
async fn list_threads_preserves_sqlite_title_search_results()
```

**Purpose**: This test checks that searching through SQLite title data returns the matching thread and keeps the preview text from the database. It protects the newer state-database search path from losing useful summary fields.

**Data flow**: It creates a temporary store with a real state database runtime, marks backfill as complete, inserts thread metadata whose title contains the search word, and then lists threads with `use_state_db_only` and a search term. The result should contain exactly that thread ID, and its first user message should remain the plain preview stored in the database.

**Call relations**: The test drives the same local listing entry point but forces the database-only branch inside `list_rollout_threads`. It is especially tied to title search behavior: the lower-level database lookup finds the thread, and the outer `list_threads` conversion must preserve the search result’s summary text.

*Call graph*: calls 5 internal fn (from_string, new, init, new, test_config); 6 external calls (new, now, from_u128, new, assert_eq!, write).


##### `tests::list_threads_selects_active_or_archived_collection`  (lines 333–400)

```
async fn list_threads_selects_active_or_archived_collection()
```

**Purpose**: This test verifies that active and archived thread listings are kept separate. A request for active threads should not include archived ones, and a request for archived threads should mark them as archived.

**Data flow**: It creates a temporary store, writes one active session file and one archived session file, then performs two listings: one with `archived` set to false and one with it set to true. It compares the returned IDs to the expected active or archived thread ID and checks that only the archived result has an archive timestamp.

**Call relations**: This test covers the branch selection inside `list_rollout_threads`: normal listing should use the active collection, while archived listing should use the archived collection. The outer `list_threads` function then converts those raw records into returned items whose archive fields callers can trust.

*Call graph*: calls 5 internal fn (from_string, new, test_config, write_archived_session_file, write_session_file); 4 external calls (new, from_u128, new, assert_eq!).


##### `tests::list_threads_returns_local_rollout_summary`  (lines 403–441)

```
async fn list_threads_returns_local_rollout_summary()
```

**Purpose**: This test checks the basic happy path for listing a local rollout session. It confirms that a saved session file turns into a useful thread summary with ID, path, preview text, provider, version, and source.

**Data flow**: It creates a temporary local store, writes one session file, lists threads with source and provider filters, and inspects the first returned item. The expected output is one thread whose summary fields match the file that was written, including the first user message used as the preview.

**Call relations**: This test exercises the full normal flow: the local store calls `list_threads`, which calls `list_rollout_threads`, which reads rollout data from disk. It then verifies that the conversion helpers used by `list_threads` produce the public-facing summary that callers need for a thread list UI.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 4 external calls (new, from_u128, assert_eq!, vec!).


##### `tests::list_threads_rejects_invalid_cursor`  (lines 444–466)

```
async fn list_threads_rejects_invalid_cursor()
```

**Purpose**: This test ensures that bad pagination bookmarks are rejected instead of being ignored or passed deeper into the listing system. That gives callers a clear error when they send an unusable cursor.

**Data flow**: It creates a temporary local store and calls the listing operation with `cursor` set to a string that is not a valid encoded cursor. The result should be an error, specifically an invalid-request error, rather than a page of threads.

**Call relations**: This test focuses on the first validation step in `list_threads`, before any rollout or database listing happens. It protects the boundary between caller input and lower-level storage code by making sure malformed cursors stop at the top.

*Call graph*: calls 2 internal fn (new, test_config); 3 external calls (new, new, assert!).


### `thread-store/src/local/search_threads.rs`

`domain_logic` · `request handling`

This file answers the question: “Which of my local threads mention this text?” Without it, the local thread store could list threads, but it could not search inside their saved conversation data and return useful search results.

The main flow starts by checking that the user supplied a non-empty search term and that any paging cursor is valid. A cursor is like a bookmark: it says where the next page of results should continue. The file then translates the thread store’s sort choices into the rollout system’s sort choices, builds the rollout configuration, and asks the rollout search layer to find saved rollout files that contain the text.

There are two stages because searching file contents and listing thread metadata are separate jobs. First, it finds matching rollout files. Then it scans the normal thread list in sorted order and keeps only the threads whose rollout file matched. This preserves the expected ordering and filtering while still using fast content search. It also reads or builds a snippet for each match, so the caller can show a preview instead of only a thread title.

Finally, it converts rollout items into stored thread search results and fills in human-friendly thread names. Names may come from the newer state database, or from older legacy rollout data if the database does not have them. The result is a page of search hits plus an optional next cursor.

#### Function details

##### `search_threads`  (lines 31–169)

```
async fn search_threads(
    store: &LocalThreadStore,
    params: SearchThreadsParams,
) -> ThreadStoreResult<ThreadSearchPage>
```

**Purpose**: Searches local thread history for a required text term and returns one page of matching threads. It combines content search, thread listing, pagination, sorting, filtering, snippets, and display names into the search response a caller needs.

**Data flow**: It receives a local thread store and search parameters, including the search text, page size, sort order, filters, archive choice, and optional cursor. It validates the search text and cursor, reads store configuration and the optional state database, asks the rollout search code to find files containing the term, then scans the regular thread list in order until it has enough matching results. Each matching rollout item is paired with a snippet, converted into a stored thread result, enriched with a display name, and returned as a ThreadSearchPage with an optional next cursor.

**Call relations**: This is the central search operation for the file. During a search request, it gets install information through current, checks the store database through state_db, asks search_rollout_matches to find matching saved rollout files, uses list_rollout_threads to walk threads in the requested order, asks first_rollout_content_match_snippet for a snippet when needed, and calls set_thread_search_result_names at the end so the returned threads have readable names.

*Call graph*: calls 4 internal fn (current, state_db, list_rollout_threads, set_thread_search_result_names); called by 1 (search_threads); 4 external calls (new, first_rollout_content_match_snippet, plain_rollout_path, search_rollout_matches).


##### `cursor_from_thread_search_item`  (lines 171–184)

```
fn cursor_from_thread_search_item(
    item: &ThreadSearchItem,
    sort_key: ThreadSortKey,
) -> Option<codex_rollout::Cursor>
```

**Purpose**: Builds the paging bookmark for a search result item. The bookmark is based on the item’s creation or update time, depending on how the search results are being sorted.

**Data flow**: It receives one internal search item and the chosen sort key. It chooses the relevant timestamp from the item: created time for creation sorting, or updated time with created time as a fallback for update sorting. It then turns that timestamp into a rollout cursor; if the needed timestamp is missing or cannot be parsed, it returns nothing.

**Call relations**: search_threads uses this helper only when it has found more matches than fit on the current page. It takes the last returned item and produces the cursor that lets the next search request resume after that point.

*Call graph*: 1 external calls (parse_cursor).


##### `set_thread_search_result_names`  (lines 186–218)

```
async fn set_thread_search_result_names(
    store: &LocalThreadStore,
    items: &mut [StoredThreadSearchResult],
)
```

**Purpose**: Adds friendly names or titles to the search results before they are returned. This matters because raw thread records may have only an identifier, while users expect recognizable thread names.

**Data flow**: It receives the local store and a mutable list of search results. It collects all thread IDs, then looks for titles in the newer state database first. If some names are still missing, it looks in legacy rollout files. For every title it finds, it updates the matching thread result so the caller receives a named thread rather than just a bare ID.

**Call relations**: search_threads calls this after converting matching rollout items into search results. This helper reaches into the store’s state database through state_db, uses distinct_thread_metadata_title to pick a usable title from metadata, falls back to find_thread_names_by_ids for older saved data, and applies each title with set_thread_name_from_title.

*Call graph*: calls 3 internal fn (state_db, distinct_thread_metadata_title, set_thread_name_from_title); called by 1 (search_threads); 3 external calls (with_capacity, find_thread_names_by_ids, iter).


### `thread-store/src/local/delete_thread.rs`

`domain_logic` · `request handling`

A “thread” here is a saved conversation or session, and a “rollout file” is the on-disk log that stores it. This file provides the local hard-delete path: when someone asks to delete a thread, it first looks for that thread in the normal sessions area and then in the archived sessions area. If it finds one or both, it removes the matching files before reporting success. This matters because the thread’s real content lives in those files; if they stayed behind, the thread would not truly be deleted.

The deletion is deliberately defensive. Before removing a file, the code checks that the path is inside the expected sessions folders, which helps prevent accidental deletion outside the project’s storage area. It also checks that the file name matches the requested thread id, like checking the label on a box before throwing it away. It removes both the plain rollout file and a possible compressed sibling ending in `.jsonl.zst`.

After file deletion, it removes thread-name index entries, which are lookup records used to find threads by name. If no rollout file was found at all, it reports “thread not found.” It also removes any live recorder for that thread from memory so the local store no longer tracks an active writer for something that has been deleted.

#### Function details

##### `delete_thread`  (lines 23–85)

```
async fn delete_thread(
    store: &LocalThreadStore,
    params: DeleteThreadParams,
) -> ThreadStoreResult<()>
```

**Purpose**: Deletes one local thread by finding its saved rollout files, removing them from disk, clearing its name-index entries, and forgetting any live in-memory recorder for it. This is the main operation used when a caller wants a thread to be permanently removed from local storage.

**Data flow**: It receives a local store and delete parameters containing the thread id. It reads the store configuration to find the Codex home folder, optionally reads the state database context, searches both active and archived session locations, and collects any matching rollout paths. It then deletes each found rollout file, removes name-index entries for the thread, reports an error if no rollout was found, and finally removes the thread from the store’s live recorder map.

**Call relations**: This is the top-level delete routine used by the local thread store’s delete operation. It asks the rollout lookup helpers to find active and archived files, passes each discovered path to delete_rollout_file for the actual disk removal, then calls the rollout index cleanup helper so stale name lookups do not remain.

*Call graph*: calls 2 internal fn (state_db, delete_rollout_file); called by 1 (delete_thread); 5 external calls (new, find_archived_thread_path_by_id_str, find_thread_path_by_id_str, remove_thread_name_entries, format!).


##### `delete_rollout_file`  (lines 87–97)

```
fn delete_rollout_file(
    store: &LocalThreadStore,
    rollout_path: &Path,
    thread_id: codex_protocol::ThreadId,
) -> ThreadStoreResult<bool>
```

**Purpose**: Deletes the physical rollout file for a thread, including both the normal plain file and a possible compressed copy. It returns whether anything was actually removed.

**Data flow**: It receives the store, a rollout path, and the thread id that should own that file. It normalizes the path to the plain rollout location, builds the matching compressed `.jsonl.zst` path, and asks delete_rollout_path to remove each one. It returns true if either version was deleted, or false if both were already gone.

**Call relations**: delete_thread calls this once for each rollout path it found. This function does not do the low-level safety checks itself; it delegates each candidate file to delete_rollout_path, which verifies the location and file name before deleting.

*Call graph*: calls 1 internal fn (delete_rollout_path); called by 1 (delete_thread); 1 external calls (plain_rollout_path).


##### `delete_rollout_path`  (lines 99–131)

```
fn delete_rollout_path(
    store: &LocalThreadStore,
    rollout_path: &Path,
    thread_id: codex_protocol::ThreadId,
) -> ThreadStoreResult<bool>
```

**Purpose**: Safely removes one specific rollout file from disk. It protects against deleting the wrong file by checking that the path belongs under the known sessions folders and that the file name matches the requested thread id.

**Data flow**: It receives the store, a path to delete, and the expected thread id. It first resolves the path as being inside either the active sessions folder or the archived sessions folder; if the file has already vanished, it allows that as a successful no-op. It then checks that the file name matches the thread id, tries to remove the file, returns true when deletion happened, false when the file was already missing, and an internal error if the operating system refused the delete for another reason.

**Call relations**: delete_rollout_file calls this for the plain rollout path and the compressed sibling path. It relies on scoped_rollout_path for the “is this file in the allowed area?” check, matching_rollout_file_name for the “is this the right thread?” check, and finally the filesystem remove call for the actual deletion.

*Call graph*: calls 2 internal fn (matching_rollout_file_name, scoped_rollout_path); called by 1 (delete_rollout_file); 2 external calls (format!, remove_file).


##### `tests::delete_thread_removes_active_and_archived_rollouts`  (lines 148–179)

```
async fn delete_thread_removes_active_and_archived_rollouts()
```

**Purpose**: Checks that deleting a thread removes rollout files from both normal sessions and archived sessions. It also confirms that a compressed sibling file is removed along with the plain active file.

**Data flow**: The test creates a temporary Codex home folder, builds a local thread store pointed at it, writes one active session file, writes a compressed companion file, and writes one archived session file. It then deletes each thread by id and checks that the corresponding files no longer exist afterward.

**Call relations**: This test exercises the public local-store delete path, which leads into delete_thread and then down into the rollout deletion helpers. It uses test support helpers to create realistic files so the delete flow is tested against actual disk paths.

*Call graph*: calls 5 internal fn (from_string, new, test_config, write_archived_session_file, write_session_file); 4 external calls (new, from_u128, assert!, write).


##### `tests::delete_rollout_file_treats_vanished_path_as_already_deleted`  (lines 182–192)

```
async fn delete_rollout_file_treats_vanished_path_as_already_deleted()
```

**Purpose**: Checks the race-friendly behavior where a rollout file that disappears before deletion is treated as already deleted. This matters because another process or cleanup step might remove the file after it was discovered.

**Data flow**: The test creates a temporary store and a session file, then manually removes that file before calling delete_rollout_file. The expected result is a successful return value of false, meaning no file was deleted by this call because it was already gone.

**Call relations**: This test calls delete_rollout_file directly to focus on the lower-level file deletion behavior. It verifies the rule described by delete_rollout_path: a missing file is not treated as a failure when the delete operation reaches it.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 4 external calls (new, from_u128, assert!, remove_file).


##### `tests::delete_thread_reports_missing_thread`  (lines 195–209)

```
async fn delete_thread_reports_missing_thread()
```

**Purpose**: Checks that asking to delete a thread with no rollout file produces a clear “thread not found” error. This prevents a missing thread from being silently treated as a successful delete.

**Data flow**: The test creates an empty temporary store, builds a valid-looking thread id that has no saved file, and calls the store’s delete operation. It expects an error and compares the user-facing error text to the exact missing-thread message.

**Call relations**: This test goes through the store delete API into delete_thread. It covers the branch where both active and archived lookup find nothing, so the operation reports ThreadNotFound after attempting the related cleanup steps.

*Call graph*: calls 3 internal fn (from_string, new, test_config); 2 external calls (new, assert_eq!).
