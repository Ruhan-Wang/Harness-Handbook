# Exec-server filesystem sandbox services  `stage-14.2.5`

This stage is the exec server’s file access layer: the part that lets the server read, write, list, copy, and delete files while deciding how safe or direct that access should be. It sits in the system’s main working path and acts like a switchboard between callers and different kinds of filesystem access.

file_read.rs manages open file-reading sessions for each client connection. It lets a client ask for specific chunks of a file, with limits so reads stay controlled. local_file_system.rs is the normal backend that talks to the host machine’s filesystem and is the concrete implementation used for most file operations. sandboxed_file_system.rs offers the same kind of file operations, but sends them through a sandbox, meaning a restricted environment with only approved permissions. fs_helper.rs defines the message format used to ask that sandbox helper to do work, and also includes a direct in-process executor for the same operations. fs_sandbox.rs actually launches and manages the helper process, works out its permissions, and turns its replies back into normal results. remote_file_system.rs is the network version: instead of touching local files, it forwards requests to another exec server over RPC, a remote procedure call.

## Files in this stage

### File read service
Manages the exec-server RPC surface for opening file-read handles and serving bounded random-access reads over those handles.

### `exec-server/src/file_read.rs`

`domain_logic` · `request handling / connection-scoped file reads`

This file implements a small stateful service for chunked file reads. `FileReadHandleManager` stores a mutex-protected `HashMap<String, Arc<File>>` keyed by caller-supplied handle ids, with a hard cap of `MAX_OPEN_FILE_READS` (128) per manager. `open` converts an async `tokio::fs::File` into a blocking `std::fs::File`, rejects duplicate handle ids, enforces the open-handle limit, and stores the file under the requested id. The manager does not generate ids itself; it validates and preserves the caller’s chosen string.

`read_block` is the main operation. It first validates that the requested length is between 1 and `codex_file_system::FILE_READ_CHUNK_SIZE`, then clones the `Arc<File>` for the handle under the mutex and performs the actual read in `tokio::task::spawn_blocking`. The blocking helper `read_block_at` repeatedly calls platform-specific positional I/O (`FileExt::read_at` on Unix, `seek_read` on Windows), handling `Interrupted` by retrying, stopping on EOF, and detecting `u64` offset overflow via `checked_add`. The returned `FileReadBlock` contains the bytes actually read and an `eof` flag set whenever fewer than `len` bytes were obtained.

A notable design choice is failure cleanup: if the blocking task fails or the read returns an error, `read_block` proactively closes that handle so future reads cannot continue against a potentially bad file state. `close` removes one handle, and `close_all` clears the entire map, which is useful during connection shutdown.

#### Function details

##### `FileReadHandleManager::open`  (lines 23–44)

```
async fn open(
        &self,
        handle_id: String,
        file: tokio::fs::File,
    ) -> io::Result<String>
```

**Purpose**: Registers a new open file under a caller-provided handle id, enforcing uniqueness and a per-manager limit.

**Data flow**: Takes ownership of a `String` handle id and a `tokio::fs::File` → converts the file into `std::fs::File` and wraps it in `Arc` → locks the handle map, rejects duplicate ids and maps already at `MAX_OPEN_FILE_READS`, inserts the file under the id, and returns `Ok(handle_id)`.

**Call relations**: Called by higher-level file-read open RPC handling; it is the entry point that populates manager state for later block reads.

*Call graph*: called by 1 (open); 4 external calls (new, into_std, new, format!).


##### `FileReadHandleManager::read_block`  (lines 46–71)

```
async fn read_block(
        &self,
        handle_id: &str,
        offset: u64,
        len: usize,
    ) -> io::Result<FileReadBlock>
```

**Purpose**: Reads a bounded block of bytes from a previously opened file handle at a specific offset, closing the handle on failure.

**Data flow**: Accepts a handle id, byte offset, and requested length → validates length with `validate_read_block_len`, locks the map long enough to clone the `Arc<File>` or return `unknown_handle_error`, then runs `read_block_at(&file, offset, len)` inside `spawn_blocking`. If the blocking task panics/cancels, converts that join error into `io::Error::other`; if the final result is any error, calls `close(handle_id)` before returning it. On success returns `FileReadBlock { bytes, eof }`.

**Call relations**: Used by the file-read RPC path after `open`; it delegates actual positional I/O to `read_block_at` and cleanup to `close`.

*Call graph*: calls 2 internal fn (close, validate_read_block_len); called by 1 (read_block); 3 external calls (other, format!, spawn_blocking).


##### `FileReadHandleManager::close`  (lines 73–75)

```
async fn close(&self, handle_id: &str)
```

**Purpose**: Removes one open file handle from the manager.

**Data flow**: Locks the handle map and removes the entry for `handle_id`, ignoring whether it existed.

**Call relations**: Called explicitly by close RPC handling and internally by `read_block` after read failures.

*Call graph*: called by 2 (read_block, close).


##### `FileReadHandleManager::close_all`  (lines 77–79)

```
async fn close_all(&self)
```

**Purpose**: Drops all tracked open file handles at once.

**Data flow**: Locks the handle map and clears it completely.

**Call relations**: Used during connection shutdown to release all per-connection file-read state.

*Call graph*: called by 1 (shutdown).


##### `read_block_at`  (lines 82–101)

```
fn read_block_at(file: &File, offset: u64, len: usize) -> io::Result<FileReadBlock>
```

**Purpose**: Performs the actual positional file read loop against a blocking `std::fs::File`, retrying interrupts and detecting EOF.

**Data flow**: Allocates a `Vec<u8>` of length `len`, tracks `bytes_read`, repeatedly computes `read_offset = offset + bytes_read` with overflow checking, calls `read_file_at` into the remaining slice, retries on `Interrupted`, stops on zero-byte reads, truncates the buffer to the actual bytes read, and returns `FileReadBlock { eof: bytes_read < len, bytes }`.

**Call relations**: Called only from `FileReadHandleManager::read_block` inside `spawn_blocking`; it isolates blocking and platform-specific I/O.

*Call graph*: calls 1 internal fn (read_file_at); 1 external calls (vec!).


##### `read_file_at`  (lines 109–111)

```
fn read_file_at(file: &File, bytes: &mut [u8], offset: u64) -> io::Result<usize>
```

**Purpose**: Provides the platform-specific positional read primitive used by block reads.

**Data flow**: On Unix, calls `std::os::unix::fs::FileExt::read_at`; on Windows, calls `std::os::windows::fs::FileExt::seek_read`; returns the resulting `io::Result<usize>`.

**Call relations**: Used by `read_block_at` so the higher-level loop can stay platform-neutral.

*Call graph*: called by 1 (read_block_at); 2 external calls (read_at, seek_read).


##### `validate_read_block_len`  (lines 113–121)

```
fn validate_read_block_len(len: usize) -> io::Result<()>
```

**Purpose**: Rejects zero-length or oversized block-read requests before any file lookup or I/O occurs.

**Data flow**: Checks whether `len` lies in `1..=FILE_READ_CHUNK_SIZE`; returns `Ok(())` when valid or `io::ErrorKind::InvalidInput` with a descriptive message otherwise.

**Call relations**: Called at the start of `FileReadHandleManager::read_block`.

*Call graph*: called by 1 (read_block); 2 external calls (new, format!).


##### `unknown_handle_error`  (lines 123–128)

```
fn unknown_handle_error(handle_id: &str) -> io::Error
```

**Purpose**: Constructs the standard not-found error for missing file-read handles.

**Data flow**: Formats the missing handle id into an `io::Error` with kind `NotFound` and returns it.

**Call relations**: Used by `FileReadHandleManager::read_block` when the requested handle id is absent from the manager.

*Call graph*: 2 external calls (new, format!).


### Filesystem helper protocol
Defines the helper-process request/response protocol and the direct executor used as the common operation layer for sandboxed filesystem work.

### `exec-server/src/fs_helper.rs`

`domain_logic` · `sandbox helper request handling`

This file is the protocol contract between the main exec-server and the helper subprocess launched for sandboxed filesystem access. `FsHelperRequest` is a tagged enum over the supported filesystem RPCs (`fs/readFile`, `fs/writeFile`, `fs/createDirectory`, `fs/getMetadata`, `fs/canonicalize`, `fs/readDirectory`, `fs/remove`, `fs/copy`), and `FsHelperResponse` wraps either a successful `FsHelperPayload` or a `JSONRPCErrorError`. The payload enum mirrors the request operations and includes a small `operation()` helper plus a family of `expect_*` methods that downcast a generic payload to the expected response type, returning an internal JSON-RPC error if the operation tag does not match.

`run_direct_request` is the implementation used by the helper binary itself. It instantiates `DirectFileSystem` and executes the requested operation without any sandbox context (`sandbox: None` everywhere). Read-file responses are base64-encoded using `STANDARD`; write-file requests decode base64 and reject malformed input as `invalid_request`. Directory creation and removal apply default booleans when the request omits them (`recursive` defaults true; `force` defaults true for remove). Metadata and directory listing responses are translated field-by-field into protocol structs.

Error mapping is intentionally opinionated. `map_fs_error` converts `io::ErrorKind::NotFound` into JSON-RPC not-found, `InvalidInput` and `PermissionDenied` into invalid-request, and everything else into internal-error. That means protocol consumers can distinguish user mistakes and missing paths from helper/runtime failures. The included test verifies that path values serialize as `file:` URIs in both requests and responses, which is an important cross-platform invariant for the helper protocol.

#### Function details

##### `FsHelperPayload::operation`  (lines 94–105)

```
fn operation(&self) -> &'static str
```

**Purpose**: Returns the protocol method string corresponding to the concrete payload variant.

**Data flow**: Matches `self` against all payload variants and returns the associated `FS_*_METHOD` constant as `&'static str`.

**Call relations**: Used by the `expect_*` downcast helpers to report mismatched response types.


##### `FsHelperPayload::expect_read_file`  (lines 107–112)

```
fn expect_read_file(self) -> Result<FsReadFileResponse, JSONRPCErrorError>
```

**Purpose**: Downcasts a generic helper payload into `FsReadFileResponse`, rejecting any other operation as an internal protocol mismatch.

**Data flow**: Consumes `self` → returns `Ok(response)` for `ReadFile`, otherwise calls `unexpected_response(FS_READ_FILE_METHOD, other.operation())` and returns that `JSONRPCErrorError`.

**Call relations**: Used by callers that issued a read-file request and need a typed response.

*Call graph*: calls 1 internal fn (unexpected_response).


##### `FsHelperPayload::expect_write_file`  (lines 114–119)

```
fn expect_write_file(self) -> Result<FsWriteFileResponse, JSONRPCErrorError>
```

**Purpose**: Downcasts a generic helper payload into `FsWriteFileResponse`.

**Data flow**: Consumes `self` → returns the inner write-file response on matching variant or an internal mismatch error via `unexpected_response` otherwise.

**Call relations**: Used after write-file helper calls to enforce operation/response consistency.

*Call graph*: calls 1 internal fn (unexpected_response).


##### `FsHelperPayload::expect_create_directory`  (lines 121–131)

```
fn expect_create_directory(
        self,
    ) -> Result<FsCreateDirectoryResponse, JSONRPCErrorError>
```

**Purpose**: Downcasts a generic helper payload into `FsCreateDirectoryResponse`.

**Data flow**: Consumes `self` → returns the create-directory response on match or an internal mismatch error naming the expected and actual operations.

**Call relations**: Used by create-directory helper call sites.

*Call graph*: calls 1 internal fn (unexpected_response).


##### `FsHelperPayload::expect_get_metadata`  (lines 133–141)

```
fn expect_get_metadata(self) -> Result<FsGetMetadataResponse, JSONRPCErrorError>
```

**Purpose**: Downcasts a generic helper payload into `FsGetMetadataResponse`.

**Data flow**: Consumes `self` → returns the metadata response on match or an internal mismatch error otherwise.

**Call relations**: Used by metadata helper call sites.

*Call graph*: calls 1 internal fn (unexpected_response).


##### `FsHelperPayload::expect_canonicalize`  (lines 143–151)

```
fn expect_canonicalize(self) -> Result<FsCanonicalizeResponse, JSONRPCErrorError>
```

**Purpose**: Downcasts a generic helper payload into `FsCanonicalizeResponse`.

**Data flow**: Consumes `self` → returns the canonicalize response on match or an internal mismatch error otherwise.

**Call relations**: Used by canonicalize helper call sites.

*Call graph*: calls 1 internal fn (unexpected_response).


##### `FsHelperPayload::expect_read_directory`  (lines 153–163)

```
fn expect_read_directory(
        self,
    ) -> Result<FsReadDirectoryResponse, JSONRPCErrorError>
```

**Purpose**: Downcasts a generic helper payload into `FsReadDirectoryResponse`.

**Data flow**: Consumes `self` → returns the directory-listing response on match or an internal mismatch error otherwise.

**Call relations**: Used by read-directory helper call sites.

*Call graph*: calls 1 internal fn (unexpected_response).


##### `FsHelperPayload::expect_remove`  (lines 165–170)

```
fn expect_remove(self) -> Result<FsRemoveResponse, JSONRPCErrorError>
```

**Purpose**: Downcasts a generic helper payload into `FsRemoveResponse`.

**Data flow**: Consumes `self` → returns the remove response on match or an internal mismatch error otherwise.

**Call relations**: Used by remove helper call sites.

*Call graph*: calls 1 internal fn (unexpected_response).


##### `FsHelperPayload::expect_copy`  (lines 172–177)

```
fn expect_copy(self) -> Result<FsCopyResponse, JSONRPCErrorError>
```

**Purpose**: Downcasts a generic helper payload into `FsCopyResponse`.

**Data flow**: Consumes `self` → returns the copy response on match or an internal mismatch error otherwise.

**Call relations**: Used by copy helper call sites.

*Call graph*: calls 1 internal fn (unexpected_response).


##### `unexpected_response`  (lines 180–184)

```
fn unexpected_response(expected: &str, actual: &str) -> JSONRPCErrorError
```

**Purpose**: Builds the internal JSON-RPC error used when a helper response payload does not match the operation the caller expected.

**Data flow**: Formats `expected` and `actual` operation names into a message and wraps it with `internal_error(...)`.

**Call relations**: Shared by all `FsHelperPayload::expect_*` methods.

*Call graph*: calls 1 internal fn (internal_error); called by 8 (expect_canonicalize, expect_copy, expect_create_directory, expect_get_metadata, expect_read_directory, expect_read_file, expect_remove, expect_write_file); 1 external calls (format!).


##### `run_direct_request`  (lines 186–295)

```
async fn run_direct_request(
    request: FsHelperRequest,
) -> Result<FsHelperPayload, JSONRPCErrorError>
```

**Purpose**: Executes one helper request directly against the host filesystem using `DirectFileSystem` and returns the corresponding typed helper payload.

**Data flow**: Consumes an `FsHelperRequest` → matches by operation and invokes the corresponding `ExecutorFileSystem` method on `DirectFileSystem` with `sandbox: None`. For reads, base64-encodes file bytes; for writes, base64-decodes input and rejects malformed data as `invalid_request`; for create/remove, fills default option booleans when omitted; for metadata and directory listing, maps backend structs into protocol response structs; all filesystem `io::Error`s are converted through `map_fs_error` → returns `Result<FsHelperPayload, JSONRPCErrorError>`.

**Call relations**: Called by the standalone helper binary’s `run_main`; it is the in-process implementation of the helper protocol.

*Call graph*: called by 1 (run_main); 8 external calls (Canonicalize, Copy, CreateDirectory, GetMetadata, ReadDirectory, ReadFile, Remove, WriteFile).


##### `map_fs_error`  (lines 297–305)

```
fn map_fs_error(err: io::Error) -> JSONRPCErrorError
```

**Purpose**: Maps filesystem `io::Error`s into JSON-RPC error categories suitable for helper responses.

**Data flow**: Reads `err.kind()` → returns `not_found(err.to_string())` for `NotFound`, `invalid_request(err.to_string())` for `InvalidInput` or `PermissionDenied`, and `internal_error(err.to_string())` for all other kinds.

**Call relations**: Used throughout `run_direct_request` so all helper operations share the same error classification.

*Call graph*: calls 3 internal fn (internal_error, invalid_request, not_found); 2 external calls (kind, to_string).


##### `tests::helper_protocol_uses_path_uris`  (lines 316–372)

```
fn helper_protocol_uses_path_uris() -> serde_json::Result<()>
```

**Purpose**: Verifies that helper request and response JSON encodes filesystem paths as `file:` URIs rather than platform-native path strings.

**Data flow**: Builds both local and UNC-style `PathUri` values, serializes a write-file request and canonicalize response containing each path, compares the resulting JSON structures to expected `serde_json::json!` values, and asserts the serialized path strings start with `file:`.

**Call relations**: Documents a key protocol invariant for cross-platform helper communication.

*Call graph*: calls 2 internal fn (from_path, parse); 8 external calls (new, assert!, assert_eq!, Canonicalize, WriteFile, Ok, to_value, current_dir).


### Sandboxed filesystem execution
Builds the sandboxed filesystem backend by validating sandboxable requests, invoking the helper subprocess, and translating its results back into filesystem operations.

### `exec-server/src/fs_sandbox.rs`

`domain_logic` · `sandboxed filesystem request handling`

This file is the sandboxed counterpart to `fs_helper.rs`. `FileSystemSandboxRunner` owns `ExecServerRuntimePaths` and a sanitized helper environment map. Its `run` method takes a `FileSystemSandboxContext` plus an `FsHelperRequest`, derives a concrete native cwd, converts the context’s permissions into a native `PermissionProfile`, augments the filesystem policy so the helper can at least start and read its own runtime binaries, normalizes top-level path aliases, forces network access to `Restricted`, and then launches the current executable with `--codex-run-as-fs-helper` under a sandbox manager.

Several subtle permission adjustments happen before launch. `sandbox_cwd` either uses the context’s explicit cwd or falls back to the current process cwd, but only if the permission profile has no cwd-dependent entries; otherwise it rejects the request. `helper_read_roots` collects parent directories of `codex_self_exe` and optional `codex_linux_sandbox_exe`, deduplicated. `add_helper_runtime_permissions` ensures restricted profiles include the platform-minimal read entry and grants read access to helper runtime roots only when not already allowed. `normalize_file_system_policy_root_aliases` rewrites path entries through `normalize_top_level_alias`, which canonicalizes the first existing ancestor whose normalized path differs, preserving suffixes so alias roots like symlinked top-level directories still match sandbox checks.

Process execution is also tightly controlled. `helper_env` filters inherited environment variables to a small allowlist (`PATH`, temp vars, macOS CoreFoundation encoding, optional Bazel debug vars, and Windows case-insensitive PATH) to avoid leaking secrets into the helper. `sandbox_exec_request` asks `SandboxManager` to choose and transform a `SandboxCommand` for the helper executable. `run_command` then spawns the transformed command, writes the serialized request to stdin, waits for output, treats nonzero exit status as an internal error including stderr, and otherwise decodes `FsHelperResponse`, returning either the payload or the structured helper error. Tests focus on permission augmentation, cwd validation, helper environment filtering, and preserving helper runtime readability without weakening caller write restrictions.

#### Function details

##### `FileSystemSandboxRunner::new`  (lines 56–61)

```
fn new(runtime_paths: ExecServerRuntimePaths) -> Self
```

**Purpose**: Constructs a sandbox runner with runtime helper paths and a sanitized environment snapshot for helper subprocesses.

**Data flow**: Takes `ExecServerRuntimePaths`, computes `helper_env()` from the current process environment, and returns `FileSystemSandboxRunner { runtime_paths, helper_env }`.

**Call relations**: Used when creating the filesystem sandbox subsystem; later `run` calls reuse the prefiltered helper environment.

*Call graph*: calls 1 internal fn (helper_env); called by 2 (sandbox_exec_request_carries_helper_env, new).


##### `FileSystemSandboxRunner::run`  (lines 63–94)

```
async fn run(
        &self,
        sandbox: &FileSystemSandboxContext,
        request: FsHelperRequest,
    ) -> Result<FsHelperPayload, JSONRPCErrorError>
```

**Purpose**: Executes one filesystem helper request inside a sandbox derived from the supplied filesystem sandbox context.

**Data flow**: Takes `&FileSystemSandboxContext` and `FsHelperRequest` → resolves cwd with `sandbox_cwd`, converts sandbox permissions into native `PermissionProfile`, extracts and mutates the filesystem policy, computes helper runtime read roots unless legacy landlock is requested, augments permissions with `add_helper_runtime_permissions`, normalizes root aliases, rebuilds a permission profile with restricted network, prepares a sandboxed exec request via `sandbox_exec_request`, serializes the helper request to JSON bytes, and awaits `run_command` to obtain `FsHelperPayload` or `JSONRPCErrorError`.

**Call relations**: Called by higher-level sandboxed filesystem operations; it orchestrates all helper permission preparation and subprocess execution.

*Call graph*: calls 7 internal fn (sandbox_exec_request, add_helper_runtime_permissions, helper_read_roots, normalize_file_system_policy_root_aliases, run_command, sandbox_cwd, from_runtime_permissions_with_enforcement); called by 1 (run_sandboxed); 2 external calls (new, to_vec).


##### `FileSystemSandboxRunner::sandbox_exec_request`  (lines 96–133)

```
fn sandbox_exec_request(
        &self,
        permission_profile: &PermissionProfile,
        cwd: &PathUri,
        sandbox_context: &FileSystemSandboxContext,
    ) -> Result<SandboxExecRequest, J
```

**Purpose**: Builds the sandbox manager request that will launch the helper executable under the chosen sandbox implementation.

**Data flow**: Takes a `PermissionProfile`, cwd `PathUri`, and sandbox context → creates `SandboxManager`, extracts runtime permissions, selects an initial sandbox with `select_initial`, builds a `SandboxCommand` pointing at `runtime_paths.codex_self_exe` with `--codex-run-as-fs-helper`, cloned helper env, and cwd, then calls `transform(...)` with enforcement flags and runtime helper paths → returns `SandboxExecRequest` or `invalid_request` on transform failure.

**Call relations**: Used only by `run` after permission normalization; it delegates sandbox selection and command transformation to `codex_sandboxing`.

*Call graph*: calls 2 internal fn (to_runtime_permissions, new); called by 1 (run); 2 external calls (clone, vec!).


##### `sandbox_cwd`  (lines 136–154)

```
fn sandbox_cwd(sandbox: &FileSystemSandboxContext) -> Result<SandboxCwd, JSONRPCErrorError>
```

**Purpose**: Determines the native and URI working directory to use for sandbox policy evaluation and helper execution.

**Data flow**: Reads `sandbox.cwd` → if present, converts it with `native_sandbox_cwd` and returns both URI and native path; otherwise, if the sandbox has cwd-dependent permissions, returns `invalid_request`; if not, reads the current sandbox cwd from `current_sandbox_cwd()`, validates it as absolute, converts it to `PathUri`, and returns `SandboxCwd { uri, native }`.

**Call relations**: Called by `FileSystemSandboxRunner::run` and directly by tests; it enforces the invariant that dynamic permission aliases require an explicit cwd.

*Call graph*: calls 6 internal fn (native_sandbox_cwd, current_sandbox_cwd, invalid_request, has_cwd_dependent_permissions, from_absolute_path, from_abs_path); called by 3 (run, sandbox_cwd_rejects_cwd_dependent_profile_without_context_cwd, sandbox_cwd_rejects_non_native_context_cwd_without_fallback).


##### `native_sandbox_cwd`  (lines 156–159)

```
fn native_sandbox_cwd(cwd: &PathUri) -> Result<AbsolutePathBuf, JSONRPCErrorError>
```

**Purpose**: Converts a `PathUri` cwd into a native absolute path suitable for sandbox policy checks.

**Data flow**: Calls `cwd.to_abs_path()`, mapping conversion failures into `invalid_request(err.to_string())`, and returns `AbsolutePathBuf`.

**Call relations**: Used by `sandbox_cwd` when the caller supplied an explicit cwd URI.

*Call graph*: calls 1 internal fn (to_abs_path); called by 1 (sandbox_cwd).


##### `helper_read_roots`  (lines 161–174)

```
fn helper_read_roots(runtime_paths: &ExecServerRuntimePaths) -> Vec<AbsolutePathBuf>
```

**Purpose**: Collects the parent directories of helper runtime executables that may need explicit read permission inside restricted sandboxes.

**Data flow**: Starts with `runtime_paths.codex_self_exe` and optionally `codex_linux_sandbox_exe`, takes each parent directory, converts it to `AbsolutePathBuf`, deduplicates by value, and returns the resulting vector.

**Call relations**: Used by `run` and tests to determine which runtime directories may need to be added to the filesystem policy.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 4 (run, helper_permissions_include_helper_read_root_without_additional_permissions, helper_permissions_include_linux_sandbox_alias_parent, helper_permissions_preserve_existing_writes); 2 external calls (new, once).


##### `add_helper_runtime_permissions`  (lines 176–205)

```
fn add_helper_runtime_permissions(
    file_system_policy: &mut FileSystemSandboxPolicy,
    helper_read_roots: &[AbsolutePathBuf],
    cwd: &std::path::Path,
)
```

**Purpose**: Augments a filesystem sandbox policy so the helper can start and read its own runtime files without unnecessarily broadening access.

**Data flow**: Mutably inspects `file_system_policy` and the helper runtime roots plus cwd → if the policy lacks full-disk read access, ensures a `FileSystemSpecialPath::Minimal` read entry is present; then for each helper root, checks `can_read_path_with_cwd`, and if not already readable, pushes a `FileSystemSandboxEntry` granting read access to that path.

**Call relations**: Called by `run` before sandbox launch and by tests that verify helper startup permissions.

*Call graph*: calls 2 internal fn (can_read_path_with_cwd, has_full_disk_read_access); called by 6 (run, helper_permissions_enable_minimal_reads_for_restricted_profile, helper_permissions_enable_minimal_reads_for_restricted_profile_with_writes, helper_permissions_include_helper_read_root_without_additional_permissions, helper_permissions_include_linux_sandbox_alias_parent, helper_permissions_preserve_existing_writes).


##### `normalize_file_system_policy_root_aliases`  (lines 207–213)

```
fn normalize_file_system_policy_root_aliases(file_system_policy: &mut FileSystemSandboxPolicy)
```

**Purpose**: Rewrites explicit path entries in a filesystem policy through top-level alias normalization so sandbox checks use canonicalized roots.

**Data flow**: Mutably iterates `file_system_policy.entries`, and for each `FileSystemPath::Path { path }`, replaces the path with `normalize_top_level_alias(path.clone())`.

**Call relations**: Used by `run` after helper permission augmentation to reduce mismatches caused by symlinked root aliases.

*Call graph*: calls 1 internal fn (normalize_top_level_alias); called by 1 (run).


##### `normalize_top_level_alias`  (lines 215–237)

```
fn normalize_top_level_alias(path: AbsolutePathBuf) -> AbsolutePathBuf
```

**Purpose**: Canonicalizes the first existing ancestor of a path whose normalized form differs, preserving the remaining suffix, to collapse top-level alias paths onto their canonical roots.

**Data flow**: Converts `AbsolutePathBuf` to `PathBuf`, walks its ancestors, skips nonexistent ancestors, canonicalizes existing ones with `canonicalize_preserving_symlinks`, ignores unchanged ancestors, computes the suffix below the changed ancestor, and if the recombined normalized path is absolute returns it; otherwise falls back to the original path.

**Call relations**: Used by `normalize_file_system_policy_root_aliases`; it is a best-effort normalization step rather than a strict requirement.

*Call graph*: calls 2 internal fn (from_absolute_path, to_path_buf); called by 1 (normalize_file_system_policy_root_aliases); 2 external calls (canonicalize_preserving_symlinks, symlink_metadata).


##### `helper_env`  (lines 239–241)

```
fn helper_env() -> HashMap<String, String>
```

**Purpose**: Builds the helper subprocess environment by filtering the current process environment through the allowlist rules.

**Data flow**: Reads `std::env::vars_os()`, forwards the iterator to `helper_env_from_vars`, and returns the resulting `HashMap<String, String>`.

**Call relations**: Called by `FileSystemSandboxRunner::new` and tested directly.

*Call graph*: calls 1 internal fn (helper_env_from_vars); called by 2 (new, helper_env_carries_only_allowlisted_runtime_vars); 1 external calls (vars_os).


##### `helper_env_from_vars`  (lines 243–253)

```
fn helper_env_from_vars(
    vars: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> HashMap<String, String>
```

**Purpose**: Filters an arbitrary environment-variable iterator down to the subset allowed to reach the helper subprocess.

**Data flow**: Consumes an iterator of `(OsString, OsString)` pairs, converts keys and values lossily to strings, keeps only entries whose key passes `helper_env_key_is_allowed`, and collects them into a `HashMap<String, String>`.

**Call relations**: Used by `helper_env` and by tests that verify filtering behavior with synthetic environments.

*Call graph*: called by 4 (helper_env, helper_env_preserves_corefoundation_text_encoding, helper_env_preserves_path_for_system_bwrap_discovery_without_leaking_secrets, helper_env_preserves_windows_path_key_for_system_bwrap_discovery); 1 external calls (into_iter).


##### `helper_env_key_is_allowed`  (lines 255–261)

```
fn helper_env_key_is_allowed(key: &str) -> bool
```

**Purpose**: Decides whether a single environment-variable name may be inherited by the helper subprocess.

**Data flow**: Checks membership in `FS_HELPER_ENV_ALLOWLIST`, allows `__CF_USER_TEXT_ENCODING` on macOS, allows Bazel/bwrap debug variables when enabled, and allows case-insensitive `PATH` on Windows → returns a boolean.

**Call relations**: Used by `helper_env_from_vars` as the central allowlist predicate.

*Call graph*: calls 1 internal fn (bazel_bwrap_env_key_is_allowed); 1 external calls (cfg!).


##### `bazel_bwrap_env_key_is_allowed`  (lines 269–271)

```
fn bazel_bwrap_env_key_is_allowed(_key: &str) -> bool
```

**Purpose**: In debug builds, conditionally allows a small set of Bazel/runfiles variables needed for locating `bwrap` under Bazel test environments.

**Data flow**: Checks whether `option_env!("BAZEL_PACKAGE")` is set and whether `key` is in `FS_HELPER_BAZEL_BWRAP_ENV_ALLOWLIST`; returns that boolean. In non-debug builds the alternate definition always returns false.

**Call relations**: Called only from `helper_env_key_is_allowed`.

*Call graph*: called by 1 (helper_env_key_is_allowed); 1 external calls (option_env!).


##### `run_command`  (lines 273–299)

```
async fn run_command(
    command: SandboxExecRequest,
    request_json: Vec<u8>,
) -> Result<FsHelperPayload, JSONRPCErrorError>
```

**Purpose**: Executes the prepared sandboxed helper command, sends it the serialized request on stdin, and decodes its stdout response.

**Data flow**: Takes `SandboxExecRequest` and request JSON bytes → spawns the child with `spawn_command`, takes piped stdin or returns internal error, writes all request bytes, shuts down stdin, waits for full output, returns internal error with exit status and trimmed stderr if the process failed, otherwise deserializes `FsHelperResponse` from stdout and returns either the payload or the structured helper error.

**Call relations**: Called by `FileSystemSandboxRunner::run` after sandbox preparation; it delegates process creation to `spawn_command`.

*Call graph*: calls 2 internal fn (spawn_command, internal_error); called by 1 (run); 2 external calls (format!, from_slice).


##### `spawn_command`  (lines 301–329)

```
fn spawn_command(
    SandboxExecRequest {
        command: argv,
        cwd,
        env,
        arg0,
        ..
    }: SandboxExecRequest,
) -> Result<tokio::process::Child, JSONRPCErrorError>
```

**Purpose**: Turns a transformed sandbox exec request into a configured `tokio::process::Command` and spawns it with piped stdio.

**Data flow**: Destructures `SandboxExecRequest` to extract argv, cwd, env, and optional `arg0` → rejects empty argv as `invalid_request`, creates `Command::new(program)`, sets Unix `arg0` when present, appends args, sets current dir, clears inherited env, installs the filtered env map, pipes stdin/stdout/stderr, enables `kill_on_drop(true)`, and spawns the child, mapping I/O errors through `io_error`.

**Call relations**: Used only by `run_command`; it is the low-level process-launch helper.

*Call graph*: calls 1 internal fn (invalid_request); called by 1 (run_command); 2 external calls (new, piped).


##### `io_error`  (lines 331–333)

```
fn io_error(err: std::io::Error) -> JSONRPCErrorError
```

**Purpose**: Converts a plain I/O error into an internal JSON-RPC error for sandbox helper orchestration failures.

**Data flow**: Formats `err.to_string()` into `internal_error(...)` and returns the resulting `JSONRPCErrorError`.

**Call relations**: Used by cwd fallback, process spawning, stdin writes, and wait/output collection in this file.

*Call graph*: calls 1 internal fn (internal_error); 1 external calls (to_string).


##### `json_error`  (lines 335–339)

```
fn json_error(err: serde_json::Error) -> JSONRPCErrorError
```

**Purpose**: Converts helper request/response JSON encoding or decoding failures into internal JSON-RPC errors with helper-specific context.

**Data flow**: Formats the serde error into `failed to encode or decode fs sandbox helper message: ...`, wraps it with `internal_error(...)`, and returns it.

**Call relations**: Used when serializing helper requests and deserializing helper responses.

*Call graph*: calls 1 internal fn (internal_error); 1 external calls (format!).


##### `tests::helper_permissions_enable_minimal_reads_for_restricted_profile`  (lines 369–377)

```
fn helper_permissions_enable_minimal_reads_for_restricted_profile()
```

**Purpose**: Verifies that restricted filesystem policies gain the platform-minimal read permission needed for helper startup.

**Data flow**: Builds a restricted policy with no entries, calls `add_helper_runtime_permissions`, and asserts the policy now includes platform defaults.

**Call relations**: Exercises the minimal-read insertion branch.

*Call graph*: calls 2 internal fn (add_helper_runtime_permissions, from_absolute_path); 4 external calls (new, assert!, restricted_policy, temp_dir).


##### `tests::helper_permissions_enable_minimal_reads_for_restricted_profile_with_writes`  (lines 380–391)

```
fn helper_permissions_enable_minimal_reads_for_restricted_profile_with_writes()
```

**Purpose**: Checks that adding helper startup permissions still enables minimal reads even when the original policy already contains write entries.

**Data flow**: Builds a restricted policy with one writable path, augments it, and asserts platform defaults are included.

**Call relations**: Covers the same minimal-read logic in the presence of existing writes.

*Call graph*: calls 2 internal fn (add_helper_runtime_permissions, from_absolute_path); 4 external calls (assert!, restricted_policy, temp_dir, vec!).


##### `tests::helper_permissions_preserve_existing_writes`  (lines 394–422)

```
fn helper_permissions_preserve_existing_writes()
```

**Purpose**: Verifies that helper permission augmentation adds needed read access without removing or weakening existing write permissions.

**Data flow**: Builds runtime paths and a restricted policy with one writable path, augments it using computed helper roots, and asserts the helper runtime directory is readable while the original writable path remains writable.

**Call relations**: Exercises `helper_read_roots` plus `add_helper_runtime_permissions` on a realistic policy.

*Call graph*: calls 4 internal fn (add_helper_runtime_permissions, helper_read_roots, new, from_absolute_path); 5 external calls (assert!, restricted_policy, current_exe, temp_dir, vec!).


##### `tests::helper_env_carries_only_allowlisted_runtime_vars`  (lines 425–437)

```
fn helper_env_carries_only_allowlisted_runtime_vars()
```

**Purpose**: Checks that `helper_env()` exactly matches filtering the current process environment through the allowlist predicate.

**Data flow**: Computes `helper_env()`, independently filters `std::env::vars_os()` with `helper_env_key_is_allowed`, collects the expected map, and asserts equality.

**Call relations**: Validates the production helper environment snapshot logic.

*Call graph*: calls 1 internal fn (helper_env); 2 external calls (assert_eq!, vars_os).


##### `tests::helper_env_preserves_path_for_system_bwrap_discovery_without_leaking_secrets`  (lines 440–463)

```
fn helper_env_preserves_path_for_system_bwrap_discovery_without_leaking_secrets()
```

**Purpose**: Ensures helper environment filtering keeps path/temp variables needed for startup while dropping unrelated sensitive variables.

**Data flow**: Feeds a synthetic environment containing PATH/temp vars plus HOME, API key, and proxy settings into `helper_env_from_vars`, then asserts only the allowlisted path/temp entries remain.

**Call relations**: Exercises `helper_env_from_vars` and `helper_env_key_is_allowed` with a controlled input set.

*Call graph*: calls 1 internal fn (helper_env_from_vars); 1 external calls (assert_eq!).


##### `tests::helper_env_preserves_corefoundation_text_encoding`  (lines 467–483)

```
fn helper_env_preserves_corefoundation_text_encoding()
```

**Purpose**: On macOS, verifies that the CoreFoundation text-encoding variable is preserved for helper startup.

**Data flow**: Builds a synthetic environment containing `__CF_USER_TEXT_ENCODING` and `HOME`, filters it, and asserts only the CoreFoundation variable remains.

**Call relations**: Covers the macOS-specific allowlist branch.

*Call graph*: calls 1 internal fn (helper_env_from_vars); 1 external calls (assert_eq!).


##### `tests::helper_env_preserves_windows_path_key_for_system_bwrap_discovery`  (lines 487–501)

```
fn helper_env_preserves_windows_path_key_for_system_bwrap_discovery()
```

**Purpose**: On Windows, verifies that case-insensitive PATH keys are preserved while similarly named variables are not.

**Data flow**: Builds a synthetic environment containing `Path`, `PATH_INJECTION`, and a secret, filters it, and asserts only `Path` remains.

**Call relations**: Covers the Windows-specific PATH handling branch.

*Call graph*: calls 1 internal fn (helper_env_from_vars); 1 external calls (assert_eq!).


##### `tests::sandbox_exec_request_carries_helper_env`  (lines 504–532)

```
fn sandbox_exec_request_carries_helper_env()
```

**Purpose**: Checks that the sandbox exec request built for the helper includes the filtered PATH entry from the current environment.

**Data flow**: Finds the current PATH-like variable, builds runtime paths, runner, cwd, restricted permission profile, and sandbox context, calls `sandbox_exec_request`, and asserts the resulting request env contains the same PATH key/value.

**Call relations**: Exercises `FileSystemSandboxRunner::new` and `sandbox_exec_request` together.

*Call graph*: calls 5 internal fn (new, new, from_runtime_permissions, current_dir, from_abs_path); 6 external calls (assert_eq!, restricted_policy, sandbox_context_with_cwd, current_exe, vars_os, vec!).


##### `tests::sandbox_cwd_uses_context_cwd`  (lines 535–552)

```
fn sandbox_cwd_uses_context_cwd()
```

**Purpose**: Verifies that an explicit sandbox context cwd is used directly.

**Data flow**: Builds an absolute temp-dir cwd URI and a cwd-dependent policy, wraps them in a sandbox context, calls `sandbox_cwd`, and asserts the returned `SandboxCwd` matches the supplied URI and native path.

**Call relations**: Exercises the explicit-cwd branch of `sandbox_cwd`.

*Call graph*: calls 2 internal fn (from_absolute_path, from_abs_path); 5 external calls (assert_eq!, restricted_policy, sandbox_context_with_cwd, temp_dir, vec!).


##### `tests::sandbox_cwd_rejects_non_native_context_cwd_without_fallback`  (lines 555–572)

```
fn sandbox_cwd_rejects_non_native_context_cwd_without_fallback()
```

**Purpose**: Ensures that a cwd URI invalid on the current platform is rejected rather than silently falling back.

**Data flow**: Builds a non-native `PathUri`, wraps it in a cwd-dependent sandbox context, calls `sandbox_cwd`, and asserts the returned `invalid_request` error matches the platform-specific message.

**Call relations**: Covers the `native_sandbox_cwd` failure path.

*Call graph*: calls 1 internal fn (sandbox_cwd); 5 external calls (assert_eq!, non_native_cwd, restricted_policy, sandbox_context_with_cwd, vec!).


##### `tests::sandbox_cwd_rejects_cwd_dependent_profile_without_context_cwd`  (lines 575–592)

```
fn sandbox_cwd_rejects_cwd_dependent_profile_without_context_cwd()
```

**Purpose**: Verifies that sandbox contexts with dynamic/cwd-dependent permissions must provide an explicit cwd.

**Data flow**: Builds a restricted policy using `project_roots`, converts it into a sandbox context without cwd, calls `sandbox_cwd`, and asserts the error message about requiring cwd.

**Call relations**: Exercises the no-cwd rejection branch in `sandbox_cwd`.

*Call graph*: calls 4 internal fn (sandbox_cwd, from_permission_profile, from_runtime_permissions, restricted); 2 external calls (assert_eq!, vec!).


##### `tests::helper_permissions_include_helper_read_root_without_additional_permissions`  (lines 595–618)

```
fn helper_permissions_include_helper_read_root_without_additional_permissions()
```

**Purpose**: Checks that helper runtime directories are added as readable roots when the original policy lacks them.

**Data flow**: Builds runtime paths and an empty restricted policy, augments it with helper roots, and asserts the helper executable’s parent directory becomes readable.

**Call relations**: Exercises the helper-root insertion branch of `add_helper_runtime_permissions`.

*Call graph*: calls 4 internal fn (add_helper_runtime_permissions, helper_read_roots, new, from_absolute_path); 5 external calls (new, assert!, restricted_policy, current_exe, temp_dir).


##### `tests::helper_permissions_include_linux_sandbox_alias_parent`  (lines 621–644)

```
fn helper_permissions_include_linux_sandbox_alias_parent()
```

**Purpose**: Verifies that both the main executable parent and the Linux sandbox alias parent are granted read access when they differ.

**Data flow**: Builds runtime paths with distinct `codex_self_exe` and `codex_linux_sandbox_exe` parents, augments an empty restricted policy, and asserts both parent directories are readable.

**Call relations**: Exercises deduplicated multi-root handling in `helper_read_roots` and permission insertion.

*Call graph*: calls 4 internal fn (add_helper_runtime_permissions, helper_read_roots, new, from_absolute_path); 5 external calls (new, assert!, restricted_policy, temp_dir, tempdir).


##### `tests::restricted_policy`  (lines 646–648)

```
fn restricted_policy(entries: Vec<FileSystemSandboxEntry>) -> FileSystemSandboxPolicy
```

**Purpose**: Small test helper that constructs a restricted filesystem policy from explicit entries.

**Data flow**: Forwards the provided entries into `FileSystemSandboxPolicy::restricted` and returns the policy.

**Call relations**: Used by many tests in this module to keep setup concise.

*Call graph*: calls 1 internal fn (restricted).


##### `tests::sandbox_context_with_cwd`  (lines 650–658)

```
fn sandbox_context_with_cwd(
        policy: &FileSystemSandboxPolicy,
        cwd: PathUri,
    ) -> crate::FileSystemSandboxContext
```

**Purpose**: Small test helper that builds a filesystem sandbox context from a policy and explicit cwd.

**Data flow**: Creates a `PermissionProfile` from the supplied policy with restricted network, then wraps it with `from_permission_profile_with_cwd(cwd)` and returns the context.

**Call relations**: Used by cwd-related tests and sandbox exec request tests.

*Call graph*: calls 2 internal fn (from_permission_profile_with_cwd, from_runtime_permissions).


##### `tests::non_native_cwd`  (lines 660–667)

```
fn non_native_cwd() -> PathUri
```

**Purpose**: Builds a `PathUri` that is intentionally invalid as a native path on the current platform.

**Data flow**: Chooses a UNC-style URI on Unix or a Unix-style URI on Windows, parses it as `PathUri`, and returns it.

**Call relations**: Used by the non-native cwd rejection test.

*Call graph*: calls 1 internal fn (parse).


##### `tests::path_entry`  (lines 669–674)

```
fn path_entry(path: AbsolutePathBuf, access: FileSystemAccessMode) -> FileSystemSandboxEntry
```

**Purpose**: Small test helper that creates a path-based filesystem sandbox entry with the requested access mode.

**Data flow**: Wraps an `AbsolutePathBuf` and `FileSystemAccessMode` into `FileSystemSandboxEntry { path: FileSystemPath::Path { path }, access }`.

**Call relations**: Used by permission-augmentation tests.


##### `tests::special_entry`  (lines 676–684)

```
fn special_entry(
        value: FileSystemSpecialPath,
        access: FileSystemAccessMode,
    ) -> FileSystemSandboxEntry
```

**Purpose**: Small test helper that creates a special-path filesystem sandbox entry with the requested access mode.

**Data flow**: Wraps a `FileSystemSpecialPath` and `FileSystemAccessMode` into `FileSystemSandboxEntry { path: FileSystemPath::Special { value }, access }`.

**Call relations**: Used by cwd-dependent permission tests.


### `exec-server/src/sandboxed_file_system.rs`

`domain_logic` · `filesystem request handling under sandboxed execution`

This file provides the sandboxed filesystem backend used when operations must execute inside a platform sandbox. `SandboxedFileSystem` owns a `FileSystemSandboxRunner`, created from `ExecServerRuntimePaths`, which is responsible for launching or contacting the helper. The private `run_sandboxed` method is the common transport step: it sends an `FsHelperRequest` plus `FileSystemSandboxContext` to the runner and converts helper-side `JSONRPCErrorError` values into `tokio::io::Error` via `map_sandbox_error`.

Each concrete operation follows the same pattern: require a sandbox context whose policy actually demands sandbox execution, reject non-native URIs by forcing `PathUri::to_abs_path()`, build the corresponding helper request with `sandbox: None` inside the payload, await the helper response, and then extract the typed payload with `expect_*` methods. `read_file` and `write_file` additionally translate file contents through base64 (`data_base64`) because the helper protocol is JSON-RPC based. `get_metadata` and `read_directory` map protocol response structs into local `FileMetadata` and `ReadDirectoryEntry` values.

A deliberate limitation appears in `read_file_stream`: streaming reads are unsupported under platform sandboxing and immediately return `io::ErrorKind::Unsupported`. Error mapping preserves not-found and invalid-input semantics from helper JSON-RPC codes while collapsing everything else to `io::Error::other`. The key invariants are that only native filesystem URIs are accepted and that callers must supply a sandbox context whose policy actually runs in the sandbox.

#### Function details

##### `SandboxedFileSystem::new`  (lines 36–40)

```
fn new(runtime_paths: ExecServerRuntimePaths) -> Self
```

**Purpose**: Constructs a sandboxed filesystem backend with a helper runner configured from runtime executable paths.

**Data flow**: Takes `ExecServerRuntimePaths`, passes them to `FileSystemSandboxRunner::new`, stores the resulting runner in `sandbox_runner`, and returns the initialized `SandboxedFileSystem`.

**Call relations**: Called when the system selects the sandboxed filesystem implementation. All later filesystem methods delegate transport work through the runner created here.

*Call graph*: calls 1 internal fn (new); called by 2 (with_runtime_paths, sandboxed_file_system_rejects_non_native_uri_as_invalid_input).


##### `SandboxedFileSystem::run_sandboxed`  (lines 42–51)

```
async fn run_sandboxed(
        &self,
        sandbox: &FileSystemSandboxContext,
        request: FsHelperRequest,
    ) -> FileSystemResult<FsHelperPayload>
```

**Purpose**: Executes one helper request inside the platform sandbox and normalizes helper JSON-RPC errors into I/O errors.

**Data flow**: Accepts a borrowed `FileSystemSandboxContext` and an `FsHelperRequest`, awaits `self.sandbox_runner.run(sandbox, request)`, and maps any `JSONRPCErrorError` failure through `map_sandbox_error`, returning `FsHelperPayload` on success.

**Call relations**: This is the shared execution path used by every concrete sandboxed filesystem operation in the file.

*Call graph*: calls 1 internal fn (run); called by 8 (canonicalize, copy, create_directory, get_metadata, read_directory, read_file, remove, write_file).


##### `SandboxedFileSystem::canonicalize`  (lines 253–259)

```
fn canonicalize(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, PathUri>
```

**Purpose**: Canonicalizes a native path by asking the sandbox helper to resolve it inside the sandbox context.

**Data flow**: Takes a `PathUri` and optional sandbox, requires a real platform sandbox via `require_platform_sandbox`, validates the URI is native with `validate_native_path`, builds `FsHelperRequest::Canonicalize(FsCanonicalizeParams { path: path.clone(), sandbox: None })`, runs it through `run_sandboxed`, extracts the canonicalize payload with `expect_canonicalize`, maps helper errors, and returns `response.path`.

**Call relations**: Exposed through the `ExecutorFileSystem` trait implementation. It follows the standard validate-then-helper pattern shared by the other operations.

*Call graph*: calls 3 internal fn (run_sandboxed, require_platform_sandbox, validate_native_path); 3 external calls (pin, Canonicalize, clone).


##### `SandboxedFileSystem::read_file`  (lines 261–267)

```
fn read_file(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>>
```

**Purpose**: Reads an entire file through the sandbox helper and decodes the helper’s base64 payload into raw bytes.

**Data flow**: Requires a sandbox context, validates the path, sends `FsHelperRequest::ReadFile(FsReadFileParams { path: path.clone(), sandbox: None })` via `run_sandboxed`, extracts the read-file payload with `expect_read_file`, then decodes `response.data_base64` using `STANDARD.decode`. Invalid base64 is converted into `io::ErrorKind::InvalidData` with a message naming `fs/readFile` and `dataBase64`.

**Call relations**: Used by the trait adapter for full-file reads. It is one of the few methods here that performs a nontrivial post-processing step after the helper response.

*Call graph*: calls 3 internal fn (run_sandboxed, require_platform_sandbox, validate_native_path); 3 external calls (pin, ReadFile, clone).


##### `SandboxedFileSystem::read_file_stream`  (lines 269–280)

```
fn read_file_stream(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream>
```

**Purpose**: Rejects streaming file reads for sandboxed filesystems because that mode is not implemented for platform sandboxing.

**Data flow**: Ignores the provided path and sandbox arguments and returns a boxed async future that immediately yields `Err(io::Error::new(io::ErrorKind::Unsupported, ...))`.

**Call relations**: This is the `ExecutorFileSystem` trait’s streaming-read implementation for the sandboxed backend. It intentionally short-circuits instead of delegating to `run_sandboxed`.

*Call graph*: 2 external calls (pin, new).


##### `SandboxedFileSystem::write_file`  (lines 282–291)

```
fn write_file(
        &'a self,
        path: &'a PathUri,
        contents: Vec<u8>,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>
```

**Purpose**: Writes an entire file through the sandbox helper after base64-encoding the provided bytes.

**Data flow**: Requires a sandbox, validates the path, encodes `contents: Vec<u8>` with `STANDARD.encode`, builds `FsHelperRequest::WriteFile(FsWriteFileParams { path: path.clone(), data_base64, sandbox: None })`, runs it, extracts `expect_write_file`, maps helper errors, and returns `()`.

**Call relations**: Reached through the trait implementation for write operations. It mirrors `read_file` but in the opposite direction.

*Call graph*: calls 3 internal fn (run_sandboxed, require_platform_sandbox, validate_native_path); 3 external calls (pin, WriteFile, clone).


##### `SandboxedFileSystem::create_directory`  (lines 293–302)

```
fn create_directory(
        &'a self,
        path: &'a PathUri,
        options: CreateDirectoryOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a,
```

**Purpose**: Creates a directory through the sandbox helper, honoring the caller’s recursive option.

**Data flow**: Requires a sandbox, validates the path, builds `FsHelperRequest::CreateDirectory(FsCreateDirectoryParams { path: path.clone(), recursive: Some(options.recursive), sandbox: None })`, runs it, extracts `expect_create_directory`, maps errors, and returns `()`.

**Call relations**: Used by the trait adapter for directory creation. It is a straightforward request/acknowledgement helper call.

*Call graph*: calls 3 internal fn (run_sandboxed, require_platform_sandbox, validate_native_path); 3 external calls (pin, CreateDirectory, clone).


##### `SandboxedFileSystem::get_metadata`  (lines 304–310)

```
fn get_metadata(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>
```

**Purpose**: Fetches file metadata through the sandbox helper and converts the protocol response into the local metadata struct.

**Data flow**: Requires a sandbox, validates the path, sends `FsHelperRequest::GetMetadata(FsGetMetadataParams { path: path.clone(), sandbox: None })`, extracts `expect_get_metadata`, maps helper errors, and constructs `FileMetadata` by copying `is_directory`, `is_file`, `is_symlink`, `size`, `created_at_ms`, and `modified_at_ms` from the response.

**Call relations**: Called via the trait implementation when metadata is requested under sandboxing. It is one of the methods that translates protocol types into local domain types.

*Call graph*: calls 3 internal fn (run_sandboxed, require_platform_sandbox, validate_native_path); 3 external calls (pin, GetMetadata, clone).


##### `SandboxedFileSystem::read_directory`  (lines 312–318)

```
fn read_directory(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>>
```

**Purpose**: Lists directory entries through the sandbox helper and maps each protocol entry into the local directory-entry type.

**Data flow**: Requires a sandbox, validates the path, sends `FsHelperRequest::ReadDirectory(FsReadDirectoryParams { path: path.clone(), sandbox: None })`, extracts `expect_read_directory`, maps helper errors, then transforms `response.entries` into `Vec<ReadDirectoryEntry>` by copying `file_name`, `is_directory`, and `is_file` for each entry.

**Call relations**: Used by the trait adapter for directory listing. Like `get_metadata`, it performs protocol-to-local type conversion after the helper call.

*Call graph*: calls 3 internal fn (run_sandboxed, require_platform_sandbox, validate_native_path); 3 external calls (pin, ReadDirectory, clone).


##### `SandboxedFileSystem::remove`  (lines 320–332)

```
fn remove(
        &'a self,
        path: &'a PathUri,
        remove_options: RemoveOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>
```

**Purpose**: Removes a file or directory through the sandbox helper using the caller’s recursive and force options.

**Data flow**: Requires a sandbox, validates the path, builds `FsHelperRequest::Remove(FsRemoveParams { path: path.clone(), recursive: Some(remove_options.recursive), force: Some(remove_options.force), sandbox: None })`, runs it, extracts `expect_remove`, maps errors, and returns `()`.

**Call relations**: Reached through the trait implementation for delete operations. It follows the same validation and helper-dispatch pattern as the other mutating methods.

*Call graph*: calls 3 internal fn (run_sandboxed, require_platform_sandbox, validate_native_path); 3 external calls (pin, Remove, clone).


##### `SandboxedFileSystem::copy`  (lines 334–348)

```
fn copy(
        &'a self,
        source_path: &'a PathUri,
        destination_path: &'a PathUri,
        options: CopyOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> Execut
```

**Purpose**: Copies a file or directory through the sandbox helper, validating both source and destination URIs first.

**Data flow**: Requires a sandbox, validates both `source_path` and `destination_path` as native paths, builds `FsHelperRequest::Copy(FsCopyParams { source_path: source_path.clone(), destination_path: destination_path.clone(), recursive: options.recursive, sandbox: None })`, runs it, extracts `expect_copy`, maps errors, and returns `()`.

**Call relations**: Used by the trait adapter for copy operations. It is the only operation here that validates two paths before dispatch.

*Call graph*: calls 3 internal fn (run_sandboxed, require_platform_sandbox, validate_native_path); 3 external calls (pin, Copy, clone).


##### `validate_native_path`  (lines 351–353)

```
fn validate_native_path(path: &PathUri) -> FileSystemResult<()>
```

**Purpose**: Rejects non-native `PathUri` values by requiring that they convert to an absolute local filesystem path.

**Data flow**: Calls `path.to_abs_path()`, discards the successful absolute path with `drop`, and returns `Ok(())` or the underlying filesystem error.

**Call relations**: Private guard used by every sandboxed operation before helper dispatch. It enforces the invariant tested in the companion test file.

*Call graph*: calls 1 internal fn (to_abs_path); called by 8 (canonicalize, copy, create_directory, get_metadata, read_directory, read_file, remove, write_file).


##### `require_platform_sandbox`  (lines 355–366)

```
fn require_platform_sandbox(
    sandbox: Option<&FileSystemSandboxContext>,
) -> FileSystemResult<&FileSystemSandboxContext>
```

**Purpose**: Ensures the caller supplied a sandbox context whose policy actually requires platform sandbox execution.

**Data flow**: Takes `Option<&FileSystemSandboxContext>`, filters it with `sandbox.should_run_in_sandbox()`, and returns the borrowed context on success. If absent or not sandbox-running, it returns `io::ErrorKind::InvalidInput` with a message naming the accepted policies.

**Call relations**: Private precondition check used by all helper-backed operations. It prevents accidental use of this backend for unrestricted/non-platform-sandbox policies.

*Call graph*: called by 8 (canonicalize, copy, create_directory, get_metadata, read_directory, read_file, remove, write_file).


##### `map_sandbox_error`  (lines 368–374)

```
fn map_sandbox_error(error: JSONRPCErrorError) -> io::Error
```

**Purpose**: Translates helper-side JSON-RPC error codes into conventional `io::Error` kinds for filesystem callers.

**Data flow**: Matches `JSONRPCErrorError.code`: `-32004` becomes `io::ErrorKind::NotFound`, `-32600` becomes `io::ErrorKind::InvalidInput`, and all other codes become `io::Error::other(error.message)`.

**Call relations**: Used by `run_sandboxed` and by `expect_*` extraction failures after helper responses. It is the error-shaping boundary between JSON-RPC and filesystem APIs.

*Call graph*: 2 external calls (new, other).


### Filesystem backends
Provides the concrete local filesystem implementation and the RPC-forwarding remote implementation that expose the executor filesystem interface to callers.

### `exec-server/src/local_file_system.rs`

`io_transport` · `request handling`

This file defines three layers of filesystem behavior. `DirectFileSystem` performs actual host filesystem operations against native absolute paths derived from `PathUri`; it rejects any sandbox context outright. `UnsandboxedFileSystem` wraps `DirectFileSystem` and only rejects sandbox contexts that explicitly request platform sandbox execution, allowing callers to pass through non-sandbox metadata without changing behavior. `LocalFileSystem` is the top-level router: it always has an unsandboxed backend and may also hold a `SandboxedFileSystem`, selecting between them with `file_system_for` based on `FileSystemSandboxContext::should_run_in_sandbox`.

The implementation is careful about path validity and safety. All direct operations convert `PathUri` with `to_abs_path()`, so non-native URIs fail early. Whole-file reads are capped at `MAX_READ_FILE_BYTES` (512 MiB) using both metadata preflight and a `take(MAX_READ_FILE_BYTES + 1)` read to catch races where the file grows after metadata is fetched. Streaming reads use `ReaderStream` with `FILE_READ_CHUNK_SIZE`, but `LocalFileSystem::open_file_for_read` explicitly forbids platform-sandboxed streaming. Metadata combines `metadata` and `symlink_metadata` so symlink-ness is preserved while size/type reflect the target. Recursive copy runs in `spawn_blocking`, supports directories, regular files, and symlinks, rejects copying a directory into itself or a descendant, and preserves symlinks rather than dereferencing them. Helper routines such as `resolve_existing_path` canonicalize the deepest existing ancestor and then re-append unresolved suffixes, which avoids symlink/`..` escape ambiguities and is reused for sandbox cwd resolution.

#### Function details

##### `file_too_large_error`  (lines 30–35)

```
fn file_too_large_error() -> io::Error
```

**Purpose**: Constructs the specific `io::Error` returned when a whole-file read exceeds the hard 512 MiB limit. The message embeds the configured byte limit so callers get a concrete failure reason.

**Data flow**: It reads the `MAX_READ_FILE_BYTES` constant, formats it into an error string, and returns a new `io::Error` with kind `InvalidInput`. It does not mutate any state.

**Call relations**: This helper is used by `DirectFileSystem::read_file` on both the metadata-size precheck path and the post-read overflow check, so the same error shape is emitted whether the file was already too large or grew during reading.

*Call graph*: called by 1 (read_file); 2 external calls (new, format!).


##### `LocalFileSystem::unsandboxed`  (lines 55–60)

```
fn unsandboxed() -> Self
```

**Purpose**: Builds a `LocalFileSystem` that only exposes host filesystem access and has no configured sandbox backend. It is the constructor used for the global `LOCAL_FS` and test/default unsandboxed setups.

**Data flow**: It creates a default `UnsandboxedFileSystem`, stores it in the `unsandboxed` field, sets `sandboxed` to `None`, and returns the assembled `LocalFileSystem`.

**Call relations**: Callers use this when they want `LocalFileSystem` routing logic without runtime sandbox paths. Later operations that request sandbox execution will fail through `LocalFileSystem::sandboxed` because this constructor leaves that field unset.

*Call graph*: called by 1 (default_for_tests); 1 external calls (default).


##### `LocalFileSystem::with_runtime_paths`  (lines 62–67)

```
fn with_runtime_paths(runtime_paths: ExecServerRuntimePaths) -> Self
```

**Purpose**: Builds a `LocalFileSystem` that can route sandbox-eligible operations into a configured `SandboxedFileSystem`. It is the constructor for production contexts that know the executor runtime paths.

**Data flow**: It creates a default `UnsandboxedFileSystem`, constructs `SandboxedFileSystem::new(runtime_paths)`, stores it in `sandboxed`, and returns the populated `LocalFileSystem`.

**Call relations**: Higher-level setup code calls this when runtime paths are available. Subsequent file operations use `file_system_for` to choose this sandboxed backend only when the provided `FileSystemSandboxContext` says the operation should run in the sandbox.

*Call graph*: calls 1 internal fn (new); called by 3 (local, new, create_file_system_context); 1 external calls (default).


##### `LocalFileSystem::sandboxed`  (lines 69–76)

```
fn sandboxed(&self) -> io::Result<&SandboxedFileSystem>
```

**Purpose**: Returns the configured sandbox backend or produces a clear invalid-input error if sandboxed operations were requested without runtime-path configuration. It centralizes that configuration check in one place.

**Data flow**: It reads `self.sandboxed`; if present it returns `&SandboxedFileSystem`, otherwise it constructs and returns an `io::Error` with kind `InvalidInput` and a fixed explanatory message.

**Call relations**: Only `LocalFileSystem::file_system_for` calls this, so all routed operations share the same failure mode when a sandbox context requests sandbox execution but the `LocalFileSystem` was created unsandboxed.

*Call graph*: called by 1 (file_system_for).


##### `LocalFileSystem::file_system_for`  (lines 78–90)

```
fn file_system_for(
        &'a self,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> io::Result<(
        &'a dyn ExecutorFileSystem,
        Option<&'a FileSystemSandboxContext>,
```

**Purpose**: Chooses the concrete backend for one operation based on the optional `FileSystemSandboxContext`. It is the dispatch point that decides between `UnsandboxedFileSystem` and `SandboxedFileSystem`.

**Data flow**: It inspects the optional sandbox context with `should_run_in_sandbox`. If true, it fetches `self.sandboxed()?` and returns that backend plus the original sandbox reference; otherwise it returns `&self.unsandboxed` plus the same sandbox reference.

**Call relations**: Every routed async operation on `LocalFileSystem` calls this first. It delegates sandbox configuration validation to `sandboxed` and then hands the chosen backend to methods like `canonicalize`, `read_file`, `write_file`, `remove`, and `copy`.

*Call graph*: calls 1 internal fn (sandboxed); called by 9 (canonicalize, copy, create_directory, get_metadata, read_directory, read_file, read_file_stream, remove, write_file).


##### `LocalFileSystem::open_file_for_read`  (lines 94–106)

```
async fn open_file_for_read(
        &self,
        path: &PathUri,
        sandbox: Option<&FileSystemSandboxContext>,
    ) -> FileSystemResult<tokio::fs::File>
```

**Purpose**: Opens a file handle for streaming reads, but only for unsandboxed access. It explicitly blocks platform-sandboxed streaming because that mode is unsupported.

**Data flow**: It reads the optional sandbox context; if it requests sandbox execution, it returns an `InvalidInput` error. Otherwise it forwards the path and sandbox to `self.unsandboxed.open_file_for_read` and returns the resulting `tokio::fs::File`.

**Call relations**: This method is used by higher-level open/read-stream paths that need a raw file handle. Unlike the other routed methods, it bypasses `file_system_for` and hardcodes unsandboxed behavior because sandbox streaming is intentionally disallowed.

*Call graph*: calls 1 internal fn (open_file_for_read); called by 1 (open); 1 external calls (new).


##### `LocalFileSystem::canonicalize`  (lines 198–204)

```
fn canonicalize(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, PathUri>
```

**Purpose**: Canonicalizes a `PathUri` through whichever backend applies to the current sandbox context. It normalizes symlinks and path components according to the selected filesystem implementation.

**Data flow**: It takes a path and optional sandbox context, resolves `(file_system, sandbox)` via `file_system_for`, awaits `file_system.canonicalize(path, sandbox)`, and returns the resulting canonical `PathUri`.

**Call relations**: The `ExecutorFileSystem` trait implementation boxes this async method. It is the standard routed path for callers that want canonicalization without knowing whether the operation will run sandboxed or unsandboxed.

*Call graph*: calls 1 internal fn (file_system_for); called by 1 (canonicalize); 1 external calls (pin).


##### `LocalFileSystem::read_file`  (lines 206–212)

```
fn read_file(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>>
```

**Purpose**: Reads an entire file through the selected backend and returns its bytes. The actual size limits and path validation are enforced by the delegated backend.

**Data flow**: It accepts a `PathUri` and optional sandbox context, chooses a backend with `file_system_for`, awaits `read_file`, and returns the resulting `Vec<u8>` or propagated I/O error.

**Call relations**: This is the boxed implementation behind the trait’s `read_file`. It exists mainly to route to either `UnsandboxedFileSystem` or `SandboxedFileSystem` while preserving the caller’s sandbox context.

*Call graph*: calls 1 internal fn (file_system_for); called by 1 (read_file); 1 external calls (pin).


##### `LocalFileSystem::read_file_stream`  (lines 214–220)

```
fn read_file_stream(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream>
```

**Purpose**: Starts a streaming file read through the selected backend. It returns a `FileSystemReadStream` rather than buffering the whole file in memory.

**Data flow**: It receives the path and optional sandbox context, resolves the backend with `file_system_for`, awaits `read_file_stream`, and returns the stream object.

**Call relations**: The trait implementation boxes this method for generic callers. Backend-specific restrictions, such as unsandboxed-only raw file opening, are enforced below this routing layer.

*Call graph*: calls 1 internal fn (file_system_for); 1 external calls (pin).


##### `LocalFileSystem::write_file`  (lines 222–229)

```
fn write_file(
        &'a self,
        path: &'a PathUri,
        contents: Vec<u8>,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>
```

**Purpose**: Writes a complete byte buffer to a file using the backend chosen for the current sandbox context. It is the routed entry for file creation or overwrite.

**Data flow**: It takes a destination `PathUri`, owned `Vec<u8>` contents, and optional sandbox context; `file_system_for` selects the backend, then the method awaits `write_file` and returns `()` on success.

**Call relations**: The trait implementation delegates here. This method does no transformation itself beyond backend selection, leaving path conversion and actual disk I/O to the concrete filesystem.

*Call graph*: calls 1 internal fn (file_system_for); called by 1 (write_file); 1 external calls (pin).


##### `LocalFileSystem::create_directory`  (lines 231–240)

```
fn create_directory(
        &'a self,
        path: &'a PathUri,
        options: CreateDirectoryOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a,
```

**Purpose**: Creates a directory through the selected backend, honoring the caller’s recursive option. It routes sandbox-aware directory creation without duplicating implementation details.

**Data flow**: It accepts a path, `CreateDirectoryOptions`, and optional sandbox context; after `file_system_for`, it awaits the backend’s `create_directory` and returns success or the propagated error.

**Call relations**: This is the boxed trait path for directory creation. It delegates recursive/non-recursive semantics to the concrete backend implementation.

*Call graph*: calls 1 internal fn (file_system_for); called by 1 (create_directory); 1 external calls (pin).


##### `LocalFileSystem::get_metadata`  (lines 242–248)

```
fn get_metadata(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>
```

**Purpose**: Fetches `FileMetadata` for a path through the appropriate backend. It is the routed metadata lookup used by the executor API.

**Data flow**: It takes a path and optional sandbox context, selects a backend with `file_system_for`, awaits `get_metadata`, and returns the populated `FileMetadata` structure.

**Call relations**: The trait implementation forwards here. The concrete backend decides how to derive symlink, size, and timestamp fields.

*Call graph*: calls 1 internal fn (file_system_for); called by 1 (get_metadata); 1 external calls (pin).


##### `LocalFileSystem::read_directory`  (lines 250–256)

```
fn read_directory(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>>
```

**Purpose**: Lists directory entries through the selected backend and returns simplified entry metadata. It routes directory enumeration across sandbox modes.

**Data flow**: It receives a directory path and optional sandbox context, resolves the backend, awaits `read_directory`, and returns a `Vec<ReadDirectoryEntry>`.

**Call relations**: This method is the trait-facing routed implementation. It delegates filtering and metadata probing of individual entries to the backend.

*Call graph*: calls 1 internal fn (file_system_for); called by 1 (read_directory); 1 external calls (pin).


##### `LocalFileSystem::remove`  (lines 258–265)

```
fn remove(
        &'a self,
        path: &'a PathUri,
        options: RemoveOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>
```

**Purpose**: Deletes a file or directory using the backend chosen for the current sandbox context. It passes through recursive and force semantics from `RemoveOptions`.

**Data flow**: It takes a path, `RemoveOptions`, and optional sandbox context, selects the backend via `file_system_for`, awaits `remove`, and returns `()` or an error.

**Call relations**: The trait implementation boxes this method. Concrete deletion behavior, including force-on-not-found and directory handling, lives in the delegated backend.

*Call graph*: calls 1 internal fn (file_system_for); called by 1 (remove); 1 external calls (pin).


##### `LocalFileSystem::copy`  (lines 267–281)

```
fn copy(
        &'a self,
        source_path: &'a PathUri,
        destination_path: &'a PathUri,
        options: CopyOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> Execut
```

**Purpose**: Copies a file, directory, or symlink through the selected backend. It is the routed entry for copy operations that may need sandbox-aware behavior.

**Data flow**: It accepts source and destination `PathUri`s, `CopyOptions`, and optional sandbox context; after backend selection with `file_system_for`, it awaits `copy` and returns success or error.

**Call relations**: The trait implementation forwards here. The heavy lifting, including recursive directory copy and symlink preservation, is delegated to the concrete filesystem.

*Call graph*: calls 1 internal fn (file_system_for); called by 1 (copy); 1 external calls (pin).


##### `UnsandboxedFileSystem::open_file_for_read`  (lines 285–294)

```
async fn open_file_for_read(
        &self,
        path: &PathUri,
        sandbox: Option<&FileSystemSandboxContext>,
    ) -> FileSystemResult<tokio::fs::File>
```

**Purpose**: Opens a file for reading on the host filesystem while rejecting requests that explicitly require platform sandboxing. It is a compatibility wrapper around `DirectFileSystem`.

**Data flow**: It checks the optional sandbox context with `reject_platform_sandbox_context`; on success it forwards the path to `self.file_system.open_file_for_read` with `None` sandbox and returns the `tokio::fs::File`.

**Call relations**: Called from `LocalFileSystem::open_file_for_read`, this wrapper preserves the caller-facing sandbox parameter shape while ensuring direct host access is never used for a sandbox-required operation.

*Call graph*: calls 2 internal fn (open_file_for_read, reject_platform_sandbox_context); called by 1 (open_file_for_read).


##### `UnsandboxedFileSystem::canonicalize`  (lines 401–407)

```
fn canonicalize(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, PathUri>
```

**Purpose**: Canonicalizes a path using direct host filesystem access, but only when the sandbox context does not demand sandbox execution. It strips the sandbox parameter before delegation.

**Data flow**: It validates the optional sandbox with `reject_platform_sandbox_context`, then awaits `self.file_system.canonicalize(path, None)` and returns the canonical `PathUri`.

**Call relations**: This is the unsandboxed branch selected by `LocalFileSystem::file_system_for`. The trait implementation boxes it for polymorphic use.

*Call graph*: calls 2 internal fn (canonicalize, reject_platform_sandbox_context); 1 external calls (pin).


##### `UnsandboxedFileSystem::read_file`  (lines 409–415)

```
fn read_file(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>>
```

**Purpose**: Reads a whole file from the host filesystem unless the caller explicitly requested sandbox execution. It forwards to `DirectFileSystem` after validation.

**Data flow**: It checks the sandbox context with `reject_platform_sandbox_context`, calls `self.file_system.read_file(path, None)`, awaits the result, and returns the file bytes.

**Call relations**: Used when `LocalFileSystem` routes a read to the unsandboxed backend. It exists to reject only platform-sandbox requests, unlike `DirectFileSystem`, which rejects any sandbox context at all.

*Call graph*: calls 2 internal fn (read_file, reject_platform_sandbox_context); 1 external calls (pin).


##### `UnsandboxedFileSystem::read_file_stream`  (lines 417–423)

```
fn read_file_stream(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream>
```

**Purpose**: Starts a streaming read from the host filesystem when sandbox execution is not required. It is the streaming counterpart to unsandboxed whole-file reads.

**Data flow**: It validates the sandbox context with `reject_platform_sandbox_context`, delegates to `self.file_system.read_file_stream(path, None)`, and returns the resulting `FileSystemReadStream`.

**Call relations**: This method is selected by `LocalFileSystem::file_system_for` for unsandboxed streaming reads and boxed by the trait implementation.

*Call graph*: calls 2 internal fn (read_file_stream, reject_platform_sandbox_context); 1 external calls (pin).


##### `UnsandboxedFileSystem::write_file`  (lines 425–434)

```
fn write_file(
        &'a self,
        path: &'a PathUri,
        contents: Vec<u8>,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>
```

**Purpose**: Writes bytes to a host file unless the sandbox context requires sandbox execution. It is a thin validation-and-forwarding wrapper.

**Data flow**: It checks the sandbox context, passes the path and owned contents to `self.file_system.write_file(path, contents, None)`, awaits completion, and returns `()`.

**Call relations**: Chosen by `LocalFileSystem` for unsandboxed writes. It preserves the public API shape while ensuring platform-sandbox requests fail early.

*Call graph*: calls 2 internal fn (write_file, reject_platform_sandbox_context); 1 external calls (pin).


##### `UnsandboxedFileSystem::create_directory`  (lines 436–445)

```
fn create_directory(
        &'a self,
        path: &'a PathUri,
        options: CreateDirectoryOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a,
```

**Purpose**: Creates a directory on the host filesystem when sandbox execution is not required. It forwards recursive options unchanged.

**Data flow**: It validates the sandbox context, delegates `path` and `CreateDirectoryOptions` to `self.file_system.create_directory(path, options, None)`, awaits completion, and returns success or error.

**Call relations**: This is the unsandboxed branch for directory creation selected by `LocalFileSystem::file_system_for`.

*Call graph*: calls 2 internal fn (create_directory, reject_platform_sandbox_context); 1 external calls (pin).


##### `UnsandboxedFileSystem::get_metadata`  (lines 447–453)

```
fn get_metadata(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>
```

**Purpose**: Retrieves metadata from the host filesystem unless the caller explicitly requested sandbox execution. It forwards directly to `DirectFileSystem` after validation.

**Data flow**: It checks the sandbox context, awaits `self.file_system.get_metadata(path, None)`, and returns the resulting `FileMetadata`.

**Call relations**: Used by routed metadata requests on the unsandboxed path and boxed by the trait implementation.

*Call graph*: calls 2 internal fn (get_metadata, reject_platform_sandbox_context); 1 external calls (pin).


##### `UnsandboxedFileSystem::read_directory`  (lines 455–461)

```
fn read_directory(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>>
```

**Purpose**: Enumerates a host directory unless the sandbox context requires sandbox execution. It is the unsandboxed wrapper for directory listing.

**Data flow**: It validates the sandbox context, delegates to `self.file_system.read_directory(path, None)`, awaits the result, and returns the collected entries.

**Call relations**: Selected by `LocalFileSystem::file_system_for` for unsandboxed directory reads.

*Call graph*: calls 2 internal fn (read_directory, reject_platform_sandbox_context); 1 external calls (pin).


##### `UnsandboxedFileSystem::remove`  (lines 463–470)

```
fn remove(
        &'a self,
        path: &'a PathUri,
        options: RemoveOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>
```

**Purpose**: Deletes a host filesystem path unless the sandbox context explicitly requires sandbox execution. It forwards force/recursive options unchanged.

**Data flow**: It checks the sandbox context, calls `self.file_system.remove(path, options, None)`, awaits completion, and returns `()` or the propagated error.

**Call relations**: This is the unsandboxed deletion path used by `LocalFileSystem` when sandbox execution is not requested.

*Call graph*: calls 2 internal fn (remove, reject_platform_sandbox_context); 1 external calls (pin).


##### `UnsandboxedFileSystem::copy`  (lines 472–486)

```
fn copy(
        &'a self,
        source_path: &'a PathUri,
        destination_path: &'a PathUri,
        options: CopyOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> Execut
```

**Purpose**: Copies a host filesystem object unless the sandbox context requires sandbox execution. It forwards source, destination, and copy options to `DirectFileSystem`.

**Data flow**: It validates the sandbox context, delegates to `self.file_system.copy(source_path, destination_path, options, None)`, awaits completion, and returns success or error.

**Call relations**: This method is the unsandboxed branch for copy operations selected by `LocalFileSystem::file_system_for`.

*Call graph*: calls 2 internal fn (copy, reject_platform_sandbox_context); 1 external calls (pin).


##### `DirectFileSystem::open_file_for_read`  (lines 490–498)

```
async fn open_file_for_read(
        &self,
        path: &PathUri,
        sandbox: Option<&FileSystemSandboxContext>,
    ) -> FileSystemResult<tokio::fs::File>
```

**Purpose**: Opens a regular file from a native absolute path on the host filesystem. It is the lowest-level async file-open primitive in this module.

**Data flow**: It rejects any non-`None` sandbox context via `reject_sandbox_context`, converts the `PathUri` to an absolute native path with `to_abs_path()`, and awaits `regular_file::open(path.as_path())`, returning a `tokio::fs::File`.

**Call relations**: This method underpins `DirectFileSystem::read_file`, `DirectFileSystem::read_file_stream`, and the unsandboxed/raw open path above it. It centralizes path conversion and regular-file enforcement.

*Call graph*: calls 3 internal fn (reject_sandbox_context, open, to_abs_path); called by 3 (read_file, read_file_stream, open_file_for_read); 1 external calls (as_path).


##### `DirectFileSystem::canonicalize`  (lines 694–700)

```
fn canonicalize(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, PathUri>
```

**Purpose**: Resolves a `PathUri` to its canonical absolute path on the host filesystem. It follows symlinks and normalizes the result back into `PathUri` form.

**Data flow**: It rejects sandbox context, converts the input `PathUri` to an absolute path, awaits `tokio::fs::canonicalize`, wraps the result in `AbsolutePathBuf::from_absolute_path`, converts that to `PathUri::from_abs_path`, and returns it.

**Call relations**: This is the concrete canonicalization implementation used by the unsandboxed wrapper and, through routing, by `LocalFileSystem` when sandboxing is not selected.

*Call graph*: calls 4 internal fn (reject_sandbox_context, from_absolute_path, from_abs_path, to_abs_path); called by 1 (canonicalize); 3 external calls (pin, canonicalize, as_path).


##### `DirectFileSystem::read_file`  (lines 702–708)

```
fn read_file(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>>
```

**Purpose**: Reads an entire file into memory with a strict 512 MiB cap and race-resistant overflow detection. It is the non-streaming file-read implementation for direct host access.

**Data flow**: It opens the file with `open_file_for_read`, fetches metadata to precheck `metadata.len()`, allocates a `Vec<u8>` with that capacity, reads via `file.take(MAX_READ_FILE_BYTES + 1).read_to_end(&mut bytes)`, checks the actual bytes read against the limit, and returns the byte vector or `file_too_large_error()`.

**Call relations**: Called through the unsandboxed wrapper and `LocalFileSystem` routing. It uses `file_too_large_error` on both preflight and post-read paths so callers see a consistent invalid-input failure.

*Call graph*: calls 2 internal fn (open_file_for_read, file_too_large_error); called by 1 (read_file); 2 external calls (pin, with_capacity).


##### `DirectFileSystem::read_file_stream`  (lines 710–716)

```
fn read_file_stream(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream>
```

**Purpose**: Creates a chunked asynchronous read stream for a file on the host filesystem. It avoids buffering the whole file and uses the configured chunk size.

**Data flow**: It opens the file with `open_file_for_read`, wraps it in `ReaderStream::with_capacity(file, FILE_READ_CHUNK_SIZE)`, then wraps that in `FileSystemReadStream::new` and returns the stream.

**Call relations**: This is the concrete streaming implementation used by the unsandboxed wrapper and routed `LocalFileSystem` reads.

*Call graph*: calls 2 internal fn (open_file_for_read, new); called by 1 (read_file_stream); 2 external calls (pin, with_capacity).


##### `DirectFileSystem::write_file`  (lines 718–725)

```
fn write_file(
        &'a self,
        path: &'a PathUri,
        contents: Vec<u8>,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>
```

**Purpose**: Writes a complete byte buffer to a native absolute path on the host filesystem. It is the direct implementation for file creation or overwrite.

**Data flow**: It rejects sandbox context, converts the `PathUri` to an absolute path, awaits `tokio::fs::write(path.as_path(), contents)`, and returns `()` on success.

**Call relations**: Used by `UnsandboxedFileSystem::write_file` and then by routed `LocalFileSystem` writes.

*Call graph*: calls 2 internal fn (reject_sandbox_context, to_abs_path); called by 1 (write_file); 3 external calls (pin, write, as_path).


##### `DirectFileSystem::create_directory`  (lines 727–736)

```
fn create_directory(
        &'a self,
        path: &'a PathUri,
        options: CreateDirectoryOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a,
```

**Purpose**: Creates a directory on the host filesystem, either one level or recursively depending on `CreateDirectoryOptions`. It is the direct implementation behind routed directory creation.

**Data flow**: It rejects sandbox context, converts the path to an absolute path, chooses `tokio::fs::create_dir_all` when `options.recursive` is true or `tokio::fs::create_dir` otherwise, awaits the operation, and returns `Ok(())`.

**Call relations**: This method is called through the unsandboxed wrapper for non-sandbox directory creation.

*Call graph*: calls 2 internal fn (reject_sandbox_context, to_abs_path); called by 1 (create_directory); 4 external calls (pin, create_dir, create_dir_all, as_path).


##### `DirectFileSystem::get_metadata`  (lines 738–744)

```
fn get_metadata(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>
```

**Purpose**: Builds the executor’s `FileMetadata` view for a host path, including symlink status and millisecond timestamps. It intentionally combines target metadata with symlink metadata.

**Data flow**: It rejects sandbox context, converts the path, awaits both `tokio::fs::metadata` and `tokio::fs::symlink_metadata`, then constructs `FileMetadata` with `is_dir`, `is_file`, `is_symlink`, `size`, and `created_at_ms`/`modified_at_ms` derived via `system_time_to_unix_ms`, defaulting missing timestamps to `0`.

**Call relations**: This is the concrete metadata implementation used on the unsandboxed path. It relies on `system_time_to_unix_ms` to normalize `SystemTime` values into signed millisecond integers.

*Call graph*: calls 2 internal fn (reject_sandbox_context, to_abs_path); called by 1 (get_metadata); 4 external calls (pin, metadata, symlink_metadata, as_path).


##### `DirectFileSystem::read_directory`  (lines 746–752)

```
fn read_directory(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>>
```

**Purpose**: Enumerates a directory and returns simplified entry records containing file name and basic type flags. Entries whose metadata cannot be read are silently skipped.

**Data flow**: It rejects sandbox context, converts the directory path, opens `tokio::fs::read_dir`, iterates with `next_entry().await?`, fetches `tokio::fs::metadata(entry.path())` for each entry, continues on metadata failure, and pushes `ReadDirectoryEntry { file_name, is_directory, is_file }` into a result vector.

**Call relations**: This method backs unsandboxed directory listing. Its skip-on-metadata-error behavior is a deliberate resilience choice so one unreadable child does not fail the whole listing.

*Call graph*: calls 2 internal fn (reject_sandbox_context, to_abs_path); called by 1 (read_directory); 5 external calls (pin, new, metadata, read_dir, as_path).


##### `DirectFileSystem::remove`  (lines 754–761)

```
fn remove(
        &'a self,
        path: &'a PathUri,
        options: RemoveOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>
```

**Purpose**: Deletes a file, symlink, or directory from the host filesystem, honoring recursive and force options. It distinguishes directories using `symlink_metadata` so symlinks are removed as files rather than traversed.

**Data flow**: It rejects sandbox context, converts the path, calls `tokio::fs::symlink_metadata`, and on success branches by `file_type`: directories use `remove_dir_all` or `remove_dir` depending on `options.recursive`, everything else uses `remove_file`. If metadata lookup returns `NotFound` and `options.force` is true, it returns success; otherwise it propagates the error.

**Call relations**: This is the concrete deletion implementation used by the unsandboxed wrapper and routed `LocalFileSystem` removes.

*Call graph*: calls 2 internal fn (reject_sandbox_context, to_abs_path); called by 1 (remove); 6 external calls (pin, remove_dir, remove_dir_all, remove_file, symlink_metadata, as_path).


##### `DirectFileSystem::copy`  (lines 763–777)

```
fn copy(
        &'a self,
        source_path: &'a PathUri,
        destination_path: &'a PathUri,
        options: CopyOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> Execut
```

**Purpose**: Copies a regular file, directory tree, or symlink on the host filesystem using blocking stdlib operations offloaded to a blocking task. It enforces recursive directory copy and prevents copying a directory into itself or a descendant.

**Data flow**: It rejects sandbox context, converts source and destination `PathUri`s to owned `PathBuf`s, then runs a `spawn_blocking` closure. Inside the closure it reads `symlink_metadata(source)`, branches on file type, requires `options.recursive` for directories, checks `destination_is_same_or_descendant_of_source`, calls `copy_dir_recursive` for directories, `copy_symlink` for symlinks, `std::fs::copy` for regular files, and otherwise returns an `InvalidInput` error. Join errors from `spawn_blocking` are mapped to `io::Error::other`.

**Call relations**: This is the concrete copy implementation used by the unsandboxed wrapper and routed `LocalFileSystem` copies. It delegates directory recursion, symlink recreation, and descendant detection to helpers in this file.

*Call graph*: calls 2 internal fn (reject_sandbox_context, to_abs_path); called by 1 (copy); 2 external calls (pin, spawn_blocking).


##### `reject_sandbox_context`  (lines 780–788)

```
fn reject_sandbox_context(sandbox: Option<&FileSystemSandboxContext>) -> io::Result<()>
```

**Purpose**: Rejects any direct filesystem call that was given a sandbox context at all. It enforces the invariant that `DirectFileSystem` never interprets sandbox metadata.

**Data flow**: It inspects the optional sandbox argument; if `Some`, it returns an `InvalidInput` `io::Error` with a fixed message, otherwise it returns `Ok(())`.

**Call relations**: All `DirectFileSystem` operations call this before touching paths or disk, making it the guardrail that keeps direct host access separate from sandbox-aware routing.

*Call graph*: called by 8 (canonicalize, copy, create_directory, get_metadata, open_file_for_read, read_directory, remove, write_file); 1 external calls (new).


##### `reject_platform_sandbox_context`  (lines 790–798)

```
fn reject_platform_sandbox_context(sandbox: Option<&FileSystemSandboxContext>) -> io::Result<()>
```

**Purpose**: Rejects only sandbox contexts that explicitly request platform sandbox execution. It allows unsandboxed wrappers to accept a context object when it does not imply sandbox routing.

**Data flow**: It checks `sandbox.is_some_and(FileSystemSandboxContext::should_run_in_sandbox)` and returns an `InvalidInput` error if true; otherwise it returns `Ok(())`.

**Call relations**: Every `UnsandboxedFileSystem` method calls this before delegating to `DirectFileSystem`, so callers can pass through non-sandbox contexts without tripping the stricter `reject_sandbox_context` check.

*Call graph*: called by 10 (canonicalize, copy, create_directory, get_metadata, open_file_for_read, read_directory, read_file, read_file_stream, remove, write_file); 1 external calls (new).


##### `copy_dir_recursive`  (lines 800–817)

```
fn copy_dir_recursive(source: &Path, target: &Path) -> io::Result<()>
```

**Purpose**: Recursively copies a directory tree using blocking stdlib APIs, preserving regular files and symlinks. It creates target directories as needed and descends depth-first.

**Data flow**: It creates the target directory with `std::fs::create_dir_all`, iterates `std::fs::read_dir(source)`, computes each child target with `target.join(entry.file_name())`, inspects `entry.file_type()`, recursively calls itself for directories, uses `std::fs::copy` for files, and `copy_symlink` for symlinks.

**Call relations**: This helper is called only from `DirectFileSystem::copy` after directory-specific validation has already happened, including the recursive option check and descendant-of-source rejection.

*Call graph*: calls 1 internal fn (copy_symlink); 4 external calls (join, copy, create_dir_all, read_dir).


##### `destination_is_same_or_descendant_of_source`  (lines 819–826)

```
fn destination_is_same_or_descendant_of_source(
    source: &Path,
    destination: &Path,
) -> io::Result<bool>
```

**Purpose**: Determines whether a copy destination resolves to the source directory itself or somewhere beneath it. This prevents recursive self-copy explosions.

**Data flow**: It canonicalizes the source path with `std::fs::canonicalize`, resolves the destination with `resolve_existing_path` so partially nonexistent targets are handled, checks `destination.starts_with(&source)`, and returns the resulting boolean.

**Call relations**: Called from `DirectFileSystem::copy` only for directory copies, before recursion begins. It relies on `resolve_existing_path` so the check still works when the destination path does not yet exist.

*Call graph*: calls 1 internal fn (resolve_existing_path); 2 external calls (starts_with, canonicalize).


##### `resolve_existing_path`  (lines 828–847)

```
fn resolve_existing_path(path: &Path) -> io::Result<PathBuf>
```

**Purpose**: Canonicalizes the deepest existing ancestor of a path and then reattaches any nonexistent suffix components. This preserves symlink resolution for the existing prefix while still returning a usable path for not-yet-created descendants.

**Data flow**: Starting from `path`, it repeatedly walks upward while the current path does not exist, pushing missing `file_name`s into `unresolved_suffix`. It canonicalizes the remaining existing path with `std::fs::canonicalize`, then appends the saved suffix components in reverse order and returns the resulting `PathBuf`.

**Call relations**: This helper is used by `destination_is_same_or_descendant_of_source`, `current_sandbox_cwd`, and a regression test covering symlink-parent `..` escapes. It is a key design choice for safe path reasoning when the full path may not exist yet.

*Call graph*: called by 3 (current_sandbox_cwd, destination_is_same_or_descendant_of_source, resolve_existing_path_handles_symlink_parent_dotdot_escape); 2 external calls (new, canonicalize).


##### `current_sandbox_cwd`  (lines 849–853)

```
fn current_sandbox_cwd() -> io::Result<PathBuf>
```

**Purpose**: Returns the current working directory in resolved form suitable for sandbox path calculations. It wraps `current_dir` with the same canonicalize-existing-prefix logic used elsewhere.

**Data flow**: It reads `std::env::current_dir()`, maps any failure into `io::Error::other` with context text, passes the resulting path to `resolve_existing_path`, and returns the resolved `PathBuf`.

**Call relations**: Higher-level sandbox setup calls this to anchor sandbox cwd handling. It delegates all path normalization details to `resolve_existing_path`.

*Call graph*: calls 1 internal fn (resolve_existing_path); called by 1 (sandbox_cwd); 1 external calls (current_dir).


##### `copy_symlink`  (lines 855–878)

```
fn copy_symlink(source: &Path, target: &Path) -> io::Result<()>
```

**Purpose**: Recreates a symlink at the destination rather than copying the target contents. It is platform-specific because Windows needs to know whether the link points to a directory.

**Data flow**: It reads the source link target with `std::fs::read_link`. On Unix it calls `std::os::unix::fs::symlink(&link_target, target)`. On Windows it calls `symlink_points_to_directory(source)?` and then chooses `symlink_dir` or `symlink_file`. On unsupported platforms it returns an `Unsupported` error.

**Call relations**: This helper is used by both `copy_dir_recursive` and `DirectFileSystem::copy` when the source object is a symlink. On Windows it depends on `symlink_points_to_directory` to preserve link kind even for dangling directory symlinks.

*Call graph*: calls 1 internal fn (symlink_points_to_directory); called by 1 (copy_dir_recursive); 5 external calls (new, read_link, symlink, symlink_dir, symlink_file).


##### `symlink_points_to_directory`  (lines 881–887)

```
fn symlink_points_to_directory(source: &Path) -> io::Result<bool>
```

**Purpose**: Determines whether a Windows symlink is a directory symlink by inspecting symlink metadata rather than following the target. This supports dangling directory symlinks.

**Data flow**: It reads `std::fs::symlink_metadata(source)?`, accesses the Windows-specific `FileTypeExt::is_symlink_dir()` flag, and returns the resulting boolean.

**Call relations**: Only the Windows branch of `copy_symlink` calls this, so symlink recreation can choose `symlink_dir` versus `symlink_file` correctly.

*Call graph*: called by 1 (copy_symlink); 1 external calls (symlink_metadata).


##### `system_time_to_unix_ms`  (lines 889–894)

```
fn system_time_to_unix_ms(time: SystemTime) -> i64
```

**Purpose**: Converts a `SystemTime` into a signed Unix-milliseconds timestamp, falling back to `0` on underflow or conversion failure. It normalizes filesystem timestamps into the executor’s metadata format.

**Data flow**: It computes `time.duration_since(UNIX_EPOCH)`, converts the duration’s milliseconds to `i64` if possible, and returns that value or `0` if any step fails.

**Call relations**: Used by `DirectFileSystem::get_metadata` for `created_at_ms` and `modified_at_ms`, ensuring missing or invalid timestamps do not fail metadata retrieval.

*Call graph*: 1 external calls (duration_since).


##### `tests::resolve_existing_path_handles_symlink_parent_dotdot_escape`  (lines 907–928)

```
fn resolve_existing_path_handles_symlink_parent_dotdot_escape() -> io::Result<()>
```

**Purpose**: Regression test proving that `resolve_existing_path` resolves a symlinked parent before applying `..`, preventing path confusion through symlink escapes. It encodes the intended canonicalization semantics for sandbox-related path handling.

**Data flow**: It creates a temp directory tree with `allowed` and `outside`, adds a symlink `allowed/link -> outside`, resolves `allowed/link/../secret.txt`, resolves the temp root separately, and asserts the first result equals `<resolved temp root>/secret.txt`.

**Call relations**: This test directly exercises `resolve_existing_path` and documents why the helper canonicalizes the existing prefix before reattaching unresolved suffix components.

*Call graph*: calls 1 internal fn (resolve_existing_path); 4 external calls (assert_eq!, create_dir_all, symlink, new).


##### `tests::symlink_points_to_directory_handles_dangling_directory_symlinks`  (lines 937–953)

```
fn symlink_points_to_directory_handles_dangling_directory_symlinks() -> io::Result<()>
```

**Purpose**: Windows-only regression test verifying that `symlink_points_to_directory` still reports `true` after the target directory has been removed. It protects the symlink-copy logic for dangling directory links.

**Data flow**: It creates a temp directory and source directory, attempts to create a directory symlink, removes the source directory, then asserts `symlink_points_to_directory(&link_path)? == true`. If symlink creation is unavailable, it exits early with success.

**Call relations**: This test covers the Windows-specific helper used by `copy_symlink`, ensuring directory symlink recreation remains correct even when the original target no longer exists.

*Call graph*: 4 external calls (assert_eq!, create_dir, remove_dir, new).


### `exec-server/src/remote_file_system.rs`

`io_transport` · `request handling`

This file is the remote filesystem adapter used by clients that want a local trait object but execute operations through an `ExecServerClient`. `RemoteFileSystem` holds a `LazyRemoteExecServerClient`, so each method first awaits `client.get()` and converts any connection/setup failure with `map_remote_error`. The concrete async methods then issue the corresponding RPC request structs: `FsCanonicalizeParams`, `FsReadFileParams`, `FsWriteFileParams`, `FsCreateDirectoryParams`, `FsGetMetadataParams`, `FsReadDirectoryParams`, `FsRemoveParams`, and `FsCopyParams`.

Data conversion is explicit. `read_file` decodes `response.data_base64` using `base64::STANDARD`, returning `InvalidData` if the server sends malformed base64. `get_metadata` and `read_directory` map protocol response fields into local `FileMetadata` and `ReadDirectoryEntry` values. `read_file_stream` is special: it rejects sandbox contexts that require platform sandboxing with `io::ErrorKind::Unsupported`, because the chunked streaming protocol does not support that mode, and otherwise delegates to `remote_file_stream::open`.

The trait implementation simply boxes each async method into `ExecutorFileSystemFuture`, keeping the public interface object-safe. `remote_sandbox_context` clones an optional `FileSystemSandboxContext` and calls `drop_cwd_if_unused`, preserving URI-based paths while stripping unnecessary cwd state before transmission. `map_remote_error` is the key error boundary: JSON-RPC server code `-32004` becomes `NotFound`, `-32600` becomes `InvalidInput`, transport closure becomes `BrokenPipe`, and all other remote failures become generic `io::Error::other(...)`. The tests document cwd-dropping behavior and the broken-pipe mapping for closed/disconnected transports.

#### Function details

##### `RemoteFileSystem::new`  (lines 39–42)

```
fn new(client: LazyRemoteExecServerClient) -> Self
```

**Purpose**: Constructs a remote filesystem adapter around a lazily initialized exec-server client.

**Data flow**: It takes a `LazyRemoteExecServerClient`, emits a trace log, stores the client in `RemoteFileSystem`, and returns the new wrapper.

**Call relations**: It is called by higher-level remote transport setup and path-URI tests. All subsequent filesystem trait calls route through the stored lazy client.

*Call graph*: called by 2 (remote_with_transport, remote_file_system_sends_path_and_sandbox_cwd_uris_without_native_conversion); 1 external calls (trace!).


##### `RemoteFileSystem::canonicalize`  (lines 229–235)

```
fn canonicalize(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, PathUri>
```

**Purpose**: Requests canonicalization of a remote path and returns the normalized `PathUri` from the server.

**Data flow**: It takes `&PathUri` and optional sandbox context, logs the operation, awaits `self.client.get()`, builds `FsCanonicalizeParams` with a cloned path and `remote_sandbox_context(sandbox)`, sends `fs_canonicalize`, maps remote errors to `io::Error`, and returns `response.path`.

**Call relations**: It backs the `ExecutorFileSystem::canonicalize` trait method. It delegates sandbox shaping to `remote_sandbox_context` and connection/error translation to `map_remote_error`.

*Call graph*: calls 2 internal fn (get, remote_sandbox_context); 3 external calls (pin, trace!, clone).


##### `RemoteFileSystem::read_file`  (lines 237–243)

```
fn read_file(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>>
```

**Purpose**: Reads an entire remote file in one RPC call and decodes the returned base64 payload into raw bytes.

**Data flow**: It takes `&PathUri` and optional sandbox context, logs, acquires the remote client, sends `fs_read_file` with cloned path and transformed sandbox, then decodes `response.data_base64` using `STANDARD.decode`. RPC failures are mapped with `map_remote_error`; invalid base64 becomes `io::ErrorKind::InvalidData` with a message naming `dataBase64`.

**Call relations**: It backs the `ExecutorFileSystem::read_file` trait method and is exercised by the path-URI integration test to verify that URIs are transmitted unchanged.

*Call graph*: calls 2 internal fn (get, remote_sandbox_context); 3 external calls (pin, trace!, clone).


##### `RemoteFileSystem::read_file_stream`  (lines 245–251)

```
fn read_file_stream(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream>
```

**Purpose**: Starts a chunked remote file read stream when sandbox constraints permit it.

**Data flow**: It takes `&PathUri` and optional sandbox context. If the sandbox exists and `should_run_in_sandbox` is true, it immediately returns `io::ErrorKind::Unsupported`. Otherwise it logs, acquires the remote client, clones the path, transforms the sandbox with `remote_sandbox_context`, and delegates to `file_stream::open` to obtain a `FileSystemReadStream`.

**Call relations**: It backs the `ExecutorFileSystem::read_file_stream` trait method. Its main special role is enforcing the invariant that streaming reads are unavailable for platform-sandboxed execution.

*Call graph*: calls 2 internal fn (get, remote_sandbox_context); 5 external calls (pin, new, open, trace!, clone).


##### `RemoteFileSystem::write_file`  (lines 253–260)

```
fn write_file(
        &'a self,
        path: &'a PathUri,
        contents: Vec<u8>,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>
```

**Purpose**: Writes a complete file to the remote exec-server by base64-encoding the provided contents and sending them in one RPC request.

**Data flow**: It takes `&PathUri`, `contents: Vec<u8>`, and optional sandbox context, logs, acquires the client, builds `FsWriteFileParams` with a cloned path, `STANDARD.encode(contents)`, and transformed sandbox, sends `fs_write_file`, maps any remote error, and returns `Ok(())` on success.

**Call relations**: It backs the `ExecutorFileSystem::write_file` trait method and follows the same client acquisition and sandbox conversion pattern as the other RPC wrappers.

*Call graph*: calls 2 internal fn (get, remote_sandbox_context); 3 external calls (pin, trace!, clone).


##### `RemoteFileSystem::create_directory`  (lines 262–271)

```
fn create_directory(
        &'a self,
        path: &'a PathUri,
        options: CreateDirectoryOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a,
```

**Purpose**: Creates a remote directory with optional recursive behavior.

**Data flow**: It takes `&PathUri`, `CreateDirectoryOptions`, and optional sandbox context, logs, acquires the client, sends `fs_create_directory` with cloned path, `recursive: Some(options.recursive)`, and transformed sandbox, maps errors, and returns `Ok(())`.

**Call relations**: It backs the `ExecutorFileSystem::create_directory` trait method.

*Call graph*: calls 2 internal fn (get, remote_sandbox_context); 3 external calls (pin, trace!, clone).


##### `RemoteFileSystem::get_metadata`  (lines 273–279)

```
fn get_metadata(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>
```

**Purpose**: Fetches remote metadata for a path and converts the protocol response into the local `FileMetadata` struct.

**Data flow**: It takes `&PathUri` and optional sandbox context, logs, acquires the client, sends `fs_get_metadata`, maps errors, and constructs `FileMetadata` from the response fields `is_directory`, `is_file`, `is_symlink`, `size`, `created_at_ms`, and `modified_at_ms`.

**Call relations**: It backs the `ExecutorFileSystem::get_metadata` trait method and is one of the methods that demonstrates explicit protocol-to-domain struct mapping.

*Call graph*: calls 2 internal fn (get, remote_sandbox_context); 3 external calls (pin, trace!, clone).


##### `RemoteFileSystem::read_directory`  (lines 281–287)

```
fn read_directory(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>>
```

**Purpose**: Lists a remote directory and maps each protocol entry into the local `ReadDirectoryEntry` type.

**Data flow**: It takes `&PathUri` and optional sandbox context, logs, acquires the client, sends `fs_read_directory`, maps errors, then transforms `response.entries` with `into_iter().map(...)` into a `Vec<ReadDirectoryEntry>` containing `file_name`, `is_directory`, and `is_file`.

**Call relations**: It backs the `ExecutorFileSystem::read_directory` trait method.

*Call graph*: calls 2 internal fn (get, remote_sandbox_context); 3 external calls (pin, trace!, clone).


##### `RemoteFileSystem::remove`  (lines 289–296)

```
fn remove(
        &'a self,
        path: &'a PathUri,
        options: RemoveOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>
```

**Purpose**: Removes a remote file or directory using the provided recursive and force options.

**Data flow**: It takes `&PathUri`, `RemoveOptions`, and optional sandbox context, logs, acquires the client, sends `fs_remove` with cloned path, `recursive: Some(options.recursive)`, `force: Some(options.force)`, and transformed sandbox, maps errors, and returns `Ok(())`.

**Call relations**: It backs the `ExecutorFileSystem::remove` trait method.

*Call graph*: calls 2 internal fn (get, remote_sandbox_context); 3 external calls (pin, trace!, clone).


##### `RemoteFileSystem::copy`  (lines 298–312)

```
fn copy(
        &'a self,
        source_path: &'a PathUri,
        destination_path: &'a PathUri,
        options: CopyOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> Execut
```

**Purpose**: Requests a remote filesystem copy operation between two paths.

**Data flow**: It takes source and destination `&PathUri`, `CopyOptions`, and optional sandbox context, logs, acquires the client, sends `fs_copy` with cloned source and destination paths, `recursive: options.recursive`, and transformed sandbox, maps errors, and returns `Ok(())`.

**Call relations**: It backs the `ExecutorFileSystem::copy` trait method.

*Call graph*: calls 2 internal fn (get, remote_sandbox_context); 3 external calls (pin, trace!, clone).


##### `remote_sandbox_context`  (lines 315–321)

```
fn remote_sandbox_context(
    sandbox: Option<&FileSystemSandboxContext>,
) -> Option<FileSystemSandboxContext>
```

**Purpose**: Prepares an optional sandbox context for transmission to the remote server by cloning it and dropping cwd when that cwd is not semantically needed.

**Data flow**: It takes `Option<&FileSystemSandboxContext>`, clones the inner value when present, applies `FileSystemSandboxContext::drop_cwd_if_unused`, and returns `Option<FileSystemSandboxContext>`.

**Call relations**: It is called by every remote filesystem RPC wrapper and by the streaming helper path. Tests in this file verify both the cwd-dropping and cwd-preserving cases.

*Call graph*: called by 11 (canonicalize, copy, create_directory, get_metadata, read_directory, read_file, read_file_stream, remove, write_file, remote_sandbox_context_drops_unused_cwd (+1 more)).


##### `map_remote_error`  (lines 323–337)

```
fn map_remote_error(error: ExecServerError) -> io::Error
```

**Purpose**: Converts `ExecServerError` values from the remote transport into conventional local `tokio::io::Error` kinds.

**Data flow**: It pattern-matches the input `ExecServerError`. Server code `-32004` becomes `io::ErrorKind::NotFound`; server code `-32600` becomes `InvalidInput`; other server errors become `io::Error::other(message)`; `Closed` and `Disconnected(_)` become `BrokenPipe` with the fixed message `exec-server transport closed`; all remaining variants become `io::Error::other(error.to_string())`.

**Call relations**: It is used by all remote filesystem methods and by `remote_file_stream::open` to normalize transport and server failures at the filesystem boundary.

*Call graph*: 3 external calls (new, other, to_string).


##### `tests::remote_sandbox_context_drops_unused_cwd`  (lines 359–377)

```
fn remote_sandbox_context_drops_unused_cwd()
```

**Purpose**: Verifies that `remote_sandbox_context` removes cwd when the sandbox policy does not require it.

**Data flow**: The test builds a restricted sandbox policy rooted at a concrete path, derives a `PermissionProfile`, constructs a `FileSystemSandboxContext` with a cwd, calls `remote_sandbox_context`, and asserts that the resulting context has `cwd == None`.

**Call relations**: It documents the intended optimization performed by `remote_sandbox_context` before sandbox data is sent over RPC.

*Call graph*: calls 4 internal fn (remote_sandbox_context, from_permission_profile_with_cwd, from_runtime_permissions, restricted); 3 external calls (assert_eq!, path_uri, vec!).


##### `tests::remote_sandbox_context_preserves_required_cwd`  (lines 380–397)

```
fn remote_sandbox_context_preserves_required_cwd()
```

**Purpose**: Verifies that `remote_sandbox_context` keeps cwd when the sandbox policy depends on project-root-relative semantics.

**Data flow**: The test builds a restricted sandbox policy using `FileSystemSpecialPath::project_roots`, derives permissions, constructs a sandbox context with a cwd, calls `remote_sandbox_context`, and asserts that the resulting context still contains that cwd.

**Call relations**: It complements the previous test by covering the branch where `drop_cwd_if_unused` must retain cwd information.

*Call graph*: calls 4 internal fn (remote_sandbox_context, from_permission_profile_with_cwd, from_runtime_permissions, restricted); 3 external calls (assert_eq!, path_uri, vec!).


##### `tests::transport_errors_map_to_broken_pipe`  (lines 400–427)

```
fn transport_errors_map_to_broken_pipe()
```

**Purpose**: Checks that closed or disconnected transport errors are surfaced to filesystem callers as `BrokenPipe` with a stable message.

**Data flow**: The test creates an array containing `ExecServerError::Closed` and `ExecServerError::Disconnected(...)`, maps each through `map_remote_error`, collects `(kind, message)` pairs, and asserts that both become `io::ErrorKind::BrokenPipe` with `exec-server transport closed`.

**Call relations**: It documents the transport-failure branch of `map_remote_error`.

*Call graph*: 2 external calls (assert_eq!, Disconnected).


##### `tests::absolute_test_path`  (lines 429–432)

```
fn absolute_test_path(name: &str) -> AbsolutePathBuf
```

**Purpose**: Builds an absolute temporary filesystem path for sandbox-context tests.

**Data flow**: It takes a `name: &str`, joins it onto `std::env::temp_dir()`, converts the result with `AbsolutePathBuf::from_absolute_path`, and returns the validated absolute path.

**Call relations**: It is a local test helper used by `path_uri` and the sandbox-context tests.

*Call graph*: calls 1 internal fn (from_absolute_path); 1 external calls (temp_dir).


##### `tests::path_uri`  (lines 434–436)

```
fn path_uri(name: &str) -> PathUri
```

**Purpose**: Converts a named temporary absolute path into a `PathUri` for tests.

**Data flow**: It takes `name: &str`, obtains an absolute path via `absolute_test_path`, converts it with `PathUri::from_abs_path`, and returns the URI.

**Call relations**: It is a fixture helper used by the sandbox-context tests.

*Call graph*: calls 1 internal fn (from_abs_path); 1 external calls (absolute_test_path).
