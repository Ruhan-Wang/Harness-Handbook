# Exec-server filesystem sandbox services  `stage-14.2.5`

This stage is shared behind-the-scenes support for the exec server when it needs to work with files. The exec server may be running commands locally, in a restricted sandbox, or on another machine, but the rest of the system should be able to ask for simple actions like read, write, list, copy, or delete.

The local file system layer is the front desk for files on the same machine. It either performs the action directly or sends it through a sandbox, which is a locked-down area that limits which paths can be touched. The sandboxed file system layer is the safe version of those same operations, enforcing the sandbox rules. The filesystem sandbox runner starts helper work inside that restricted space and carefully controls what environment and file access the helper receives.

The helper protocol is the messenger format for filesystem actions. It turns requests into real file operations and turns results or failures back into replies. Remote file system support uses a similar idea to make files on another machine look local. File-read support handles long reads in small chunks, tracking open reads and rejecting unsafe or stale requests.

## Files in this stage

### File read service
Manages the exec-server RPC surface for opening file-read handles and serving bounded random-access reads over those handles.

### `exec-server/src/file_read.rs`

`io_transport` · `request handling and connection teardown`

This file is a small bookkeeping and disk-reading layer for file downloads or file inspection. Instead of reading a whole file at once, the server opens a file, gives it a handle ID, and later reads requested byte ranges from that handle. A handle ID is like a coat-check ticket: the client does not keep the file itself, but it can use the ticket to ask for more pieces.

The main type, FileReadHandleManager, stores open files in a shared map protected by a mutex, which is a lock that stops two async tasks from changing the map at the same time. It limits each connection to 128 open file reads, so a client cannot accidentally or maliciously leave unlimited files open.

Reads are done by offset and length. The length must be between 1 byte and the project’s configured maximum chunk size. The actual disk read is moved into a blocking worker task, because normal file reads can pause the thread, and this server uses async code where blocking the main runtime would slow other work. If a read fails, the handle is closed, so the server does not keep a possibly bad file session around.

The file also hides platform differences: Unix and Windows use different system calls to read from a specific file offset, but the rest of the code can call one shared helper.

#### Function details

##### `FileReadHandleManager::open`  (lines 23–44)

```
async fn open(
        &self,
        handle_id: String,
        file: tokio::fs::File,
    ) -> io::Result<String>
```

**Purpose**: Registers a newly opened file under a client-provided handle ID so later requests can read from it. It refuses duplicate handle IDs and refuses to keep more than the allowed number of open file reads for the connection.

**Data flow**: It receives a handle ID and an async file object. It converts the async file into a standard file object, wraps it so it can be safely shared, locks the handle table, checks for duplicate IDs and the open-file limit, then stores the file. It returns the handle ID on success, or an input error if the request would create a conflict or exceed the limit.

**Call relations**: This is called when the higher-level open-file request wants to start a read session. It prepares the stored file handle that later read requests will look up through FileReadHandleManager::read_block.

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

**Purpose**: Reads one requested chunk of bytes from a previously opened file handle. It checks that the requested chunk size is safe, finds the stored file, and performs the disk read without blocking the async server runtime.

**Data flow**: It receives a handle ID, a byte offset, and a length. First it validates the length, then it locks the handle table long enough to copy out the matching file reference. It runs the real file read in a blocking worker task and returns a FileReadBlock containing the bytes and an end-of-file flag. If the handle is unknown, it returns a not-found error. If the read itself fails, it closes that handle before returning the error.

**Call relations**: This is called by the higher-level read-block request after a file has been opened. It relies on validate_read_block_len before reading, hands the actual disk work to read_block_at through a blocking task, and calls FileReadHandleManager::close when a read failure means the handle should no longer be kept.

*Call graph*: calls 2 internal fn (close, validate_read_block_len); called by 1 (read_block); 3 external calls (other, format!, spawn_blocking).


##### `FileReadHandleManager::close`  (lines 73–75)

```
async fn close(&self, handle_id: &str)
```

**Purpose**: Forgets one open file-read handle. This releases the server’s stored reference to that file for this manager.

**Data flow**: It receives a handle ID, locks the handle table, and removes that entry if it exists. It does not return anything and does not report an error if the handle was already gone.

**Call relations**: This is used when a higher-level close request ends a read session. FileReadHandleManager::read_block also calls it automatically after a failed read, so later requests do not keep using a bad or inconsistent handle.

*Call graph*: called by 2 (read_block, close).


##### `FileReadHandleManager::close_all`  (lines 77–79)

```
async fn close_all(&self)
```

**Purpose**: Closes every tracked file-read handle at once. This is useful when a connection is ending and the server needs to clean up all file-read sessions owned by it.

**Data flow**: It takes no handle ID. It locks the handle table and clears every stored file entry. Nothing is returned; the visible effect is that all previously known handles become unknown.

**Call relations**: This is called during shutdown or connection cleanup. It is the broad cleanup partner to FileReadHandleManager::close, which removes only one handle.

*Call graph*: called by 1 (shutdown).


##### `read_block_at`  (lines 82–101)

```
fn read_block_at(file: &File, offset: u64, len: usize) -> io::Result<FileReadBlock>
```

**Purpose**: Reads up to a requested number of bytes from a file starting at a specific offset. It keeps trying until it fills the requested chunk, reaches the end of the file, or hits a real read error.

**Data flow**: It receives a standard file reference, an offset, and a length. It creates a byte buffer of that length, repeatedly asks read_file_at to fill the remaining part, and advances the read position as bytes arrive. If the file ends early, it returns the bytes read so far with eof set to true. If the full length is read, eof is false. If the offset calculation would overflow or the operating system reports a real error, it returns an error.

**Call relations**: This is the low-level reading worker used by FileReadHandleManager::read_block inside a blocking task. It delegates the platform-specific offset read to read_file_at so the rest of the code does not need to care whether it is running on Unix or Windows.

*Call graph*: calls 1 internal fn (read_file_at); 1 external calls (vec!).


##### `read_file_at`  (lines 109–111)

```
fn read_file_at(file: &File, bytes: &mut [u8], offset: u64) -> io::Result<usize>
```

**Purpose**: Performs one operating-system-level read from a file at a given byte offset. It gives the rest of the file a single name for an operation that is spelled differently on Unix and Windows.

**Data flow**: It receives a file, a mutable byte slice to fill, and an offset. On Unix it reads with the Unix offset-read API; on Windows it uses the Windows seek-read API. It returns how many bytes were placed into the buffer, or an I/O error from the operating system.

**Call relations**: read_block_at calls this each time it needs more bytes. This helper is the platform bridge: read_block_at owns the retry and end-of-file logic, while read_file_at performs the actual system call.

*Call graph*: called by 1 (read_block_at); 2 external calls (read_at, seek_read).


##### `validate_read_block_len`  (lines 113–121)

```
fn validate_read_block_len(len: usize) -> io::Result<()>
```

**Purpose**: Checks that a requested file-read chunk length is allowed. This prevents empty reads and prevents a client from asking the server to allocate or return an overly large block.

**Data flow**: It receives a length. It compares that length with the valid range: at least 1 byte and no more than the configured file-read chunk size. It returns success if the length is valid, or an input error explaining the allowed range if not.

**Call relations**: FileReadHandleManager::read_block calls this before looking up the handle or starting disk work. That means invalid requests are rejected early, before the server spends effort reading from a file.

*Call graph*: called by 1 (read_block); 2 external calls (new, format!).


##### `unknown_handle_error`  (lines 123–128)

```
fn unknown_handle_error(handle_id: &str) -> io::Error
```

**Purpose**: Builds a clear error for the case where a client asks for a file-read handle the server does not know about. This helps callers distinguish a missing handle from a disk-read failure.

**Data flow**: It receives the handle ID string. It creates and returns a not-found I/O error whose message names that handle. It does not read or change any stored state.

**Call relations**: FileReadHandleManager::read_block uses this when the handle table has no entry for the requested ID. It keeps the error message creation in one place so unknown-handle failures are reported consistently.

*Call graph*: 2 external calls (new, format!).


### Filesystem helper protocol
Defines the helper-process request/response protocol and the direct executor used as the common operation layer for sandboxed filesystem work.

### `exec-server/src/fs_helper.rs`

`io_transport` · `request handling`

This file is a bridge between a remote-style command, such as “read this file,” and the actual local file system. Think of it like a service desk form: callers submit a form saying which file operation they want, and this code checks the form, performs the work, and returns the answer in the expected shape.

The main request type, FsHelperRequest, lists every supported operation: read a file, write a file, create a directory, get file metadata, resolve a path to its real location, read a directory, remove something, or copy something. The matching response types wrap either a successful result or a JSON-RPC error. JSON-RPC is a simple request/response format often used between processes.

A key detail is that file contents are sent as Base64 text. Base64 is a way to safely carry raw bytes inside JSON strings. When reading, bytes are encoded before returning. When writing, the incoming Base64 string is decoded back into bytes first.

The central function, run_direct_request, uses DirectFileSystem to perform the requested operation without an extra sandbox argument. File-system failures are converted into clear protocol errors: missing files become “not found,” bad input or permission problems become “invalid request,” and unexpected failures become internal errors. The small expect_* helpers protect callers from accidentally treating one kind of response as another.

#### Function details

##### `FsHelperPayload::operation`  (lines 94–105)

```
fn operation(&self) -> &'static str
```

**Purpose**: This returns the protocol method name for a successful helper response. It lets error messages and response checks say, in a standard way, which file-system operation a payload belongs to.

**Data flow**: It receives one response payload variant, such as a read-file response or copy response. It matches that variant to the corresponding method-name string and returns that string without changing anything.

**Call relations**: The expect_* functions call this when they receive the wrong response type. They use it to explain what actually came back, so the caller can see the mismatch clearly.


##### `FsHelperPayload::expect_read_file`  (lines 107–112)

```
fn expect_read_file(self) -> Result<FsReadFileResponse, JSONRPCErrorError>
```

**Purpose**: This checks that a helper response really is a read-file response and extracts it. It prevents code from silently treating the wrong kind of file-system result as file contents.

**Data flow**: It takes a payload. If the payload contains read-file data, it returns that data. If it contains any other operation’s response, it builds a JSON-RPC error describing the mismatch.

**Call relations**: This is used by code that sent a read-file request and now wants the matching result. If the payload is not for reading, it hands off to unexpected_response to create a clear internal error.

*Call graph*: calls 1 internal fn (unexpected_response).


##### `FsHelperPayload::expect_write_file`  (lines 114–119)

```
fn expect_write_file(self) -> Result<FsWriteFileResponse, JSONRPCErrorError>
```

**Purpose**: This checks that a helper response is the empty success result for writing a file. It is a safety check for callers that just asked the helper to write data.

**Data flow**: It takes a payload. If it is a write-file response, it returns that response. Otherwise, it turns the mismatch into a JSON-RPC error.

**Call relations**: It sits after a write-file helper call in the bigger flow. When the response type does not match, it calls unexpected_response so the caller gets a useful explanation instead of bad assumptions.

*Call graph*: calls 1 internal fn (unexpected_response).


##### `FsHelperPayload::expect_create_directory`  (lines 121–131)

```
fn expect_create_directory(
        self,
    ) -> Result<FsCreateDirectoryResponse, JSONRPCErrorError>
```

**Purpose**: This checks that the helper returned the expected response for creating a directory. It confirms that the caller is looking at the result of the operation it actually requested.

**Data flow**: It receives a payload. If it is a create-directory response, it returns it. If some other response arrived, it produces a JSON-RPC error saying what was expected and what was received.

**Call relations**: This belongs to the response-validation step after a create-directory request. It relies on unexpected_response to build the standard error message when the helper response is inconsistent.

*Call graph*: calls 1 internal fn (unexpected_response).


##### `FsHelperPayload::expect_get_metadata`  (lines 133–141)

```
fn expect_get_metadata(self) -> Result<FsGetMetadataResponse, JSONRPCErrorError>
```

**Purpose**: This extracts file metadata only when the payload is truly a metadata response. Metadata means facts about a file, such as whether it is a directory and how large it is.

**Data flow**: It takes a payload and checks its kind. A get-metadata payload is returned to the caller. Any other payload becomes a JSON-RPC error explaining the unexpected operation.

**Call relations**: Callers use this after asking for metadata. If the helper sends back a different operation’s response, this function calls unexpected_response to report the protocol mix-up.

*Call graph*: calls 1 internal fn (unexpected_response).


##### `FsHelperPayload::expect_canonicalize`  (lines 143–151)

```
fn expect_canonicalize(self) -> Result<FsCanonicalizeResponse, JSONRPCErrorError>
```

**Purpose**: This checks that a response contains the result of canonicalizing a path. Canonicalizing means resolving a path into its normalized, real form.

**Data flow**: It receives a payload. If the payload contains a canonicalized path, it returns that response. If not, it returns a JSON-RPC error that names the expected and actual operation.

**Call relations**: This is used after a canonicalize request. On mismatch, it delegates to unexpected_response so the same clear error style is used across all helper response checks.

*Call graph*: calls 1 internal fn (unexpected_response).


##### `FsHelperPayload::expect_read_directory`  (lines 153–163)

```
fn expect_read_directory(
        self,
    ) -> Result<FsReadDirectoryResponse, JSONRPCErrorError>
```

**Purpose**: This extracts a directory listing only when the payload is really a read-directory response. It protects callers from confusing a directory listing with another file-system result.

**Data flow**: It takes a payload. If it contains directory entries, it returns them. If it contains another operation’s response, it returns a JSON-RPC error instead.

**Call relations**: This is part of the normal flow after a read-directory request. If the response does not match the request, it calls unexpected_response to describe the mismatch.

*Call graph*: calls 1 internal fn (unexpected_response).


##### `FsHelperPayload::expect_remove`  (lines 165–170)

```
fn expect_remove(self) -> Result<FsRemoveResponse, JSONRPCErrorError>
```

**Purpose**: This checks that the helper response is for a remove operation, such as deleting a file or directory. It gives callers a simple success response only when the response type is correct.

**Data flow**: It receives a payload. A remove response is returned unchanged. Any other response is converted into a JSON-RPC error that says the helper returned the wrong operation.

**Call relations**: Code that requested deletion uses this before trusting the result. For mismatches, it uses unexpected_response to create the standard internal error.

*Call graph*: calls 1 internal fn (unexpected_response).


##### `FsHelperPayload::expect_copy`  (lines 172–177)

```
fn expect_copy(self) -> Result<FsCopyResponse, JSONRPCErrorError>
```

**Purpose**: This checks that the helper response is for a copy operation. It is a guardrail that keeps protocol responses paired with the requests that caused them.

**Data flow**: It takes a payload. If it is a copy response, it returns that response. Otherwise, it produces a JSON-RPC error naming the expected copy operation and the actual response operation.

**Call relations**: This is used after a copy request has been sent. When the response is not a copy response, it calls unexpected_response to report the protocol inconsistency.

*Call graph*: calls 1 internal fn (unexpected_response).


##### `unexpected_response`  (lines 180–184)

```
fn unexpected_response(expected: &str, actual: &str) -> JSONRPCErrorError
```

**Purpose**: This creates a standard error for the case where the helper returned a response for the wrong file-system operation. It makes protocol bugs easier to diagnose.

**Data flow**: It receives the method name the caller expected and the method name actually found. It combines them into a readable message and wraps that message as an internal JSON-RPC error.

**Call relations**: All of the expect_* response-checking functions call this when their payload does not match. It hands the formatted message to internal_error so the rest of the system sees a normal JSON-RPC error object.

*Call graph*: calls 1 internal fn (internal_error); called by 8 (expect_canonicalize, expect_copy, expect_create_directory, expect_get_metadata, expect_read_directory, expect_read_file, expect_remove, expect_write_file); 1 external calls (format!).


##### `run_direct_request`  (lines 186–295)

```
async fn run_direct_request(
    request: FsHelperRequest,
) -> Result<FsHelperPayload, JSONRPCErrorError>
```

**Purpose**: This performs one file-system helper request directly on the local file system and returns the matching protocol response. It is the main worker that turns helper commands into real reads, writes, deletes, copies, and directory lookups.

**Data flow**: It receives an FsHelperRequest. It creates a DirectFileSystem, chooses the right file operation, converts data when needed, and waits for the file-system work to finish. On success it returns the matching FsHelperPayload; on failure it converts the file-system error into a JSON-RPC error. For reads, raw bytes become Base64 text. For writes, Base64 text becomes raw bytes before writing.

**Call relations**: This is called by run_main when the process is running as the file-system helper. Inside the function, each request variant hands off to the matching DirectFileSystem operation. Any file-system error is passed through map_fs_error so callers receive protocol-friendly errors rather than raw operating-system errors.

*Call graph*: called by 1 (run_main); 8 external calls (Canonicalize, Copy, CreateDirectory, GetMetadata, ReadDirectory, ReadFile, Remove, WriteFile).


##### `map_fs_error`  (lines 297–305)

```
fn map_fs_error(err: io::Error) -> JSONRPCErrorError
```

**Purpose**: This translates low-level file-system errors into the JSON-RPC error categories used by the helper protocol. It helps callers understand whether a problem is a missing file, a bad request, or an unexpected failure.

**Data flow**: It receives an input/output error from the operating system or file-system layer. It checks the error kind, turns the message into text, and returns a JSON-RPC error: not found for missing paths, invalid request for bad input or permission denial, and internal error for everything else.

**Call relations**: run_direct_request uses this after every DirectFileSystem operation that can fail. The function delegates to not_found, invalid_request, or internal_error to build the final protocol error.

*Call graph*: calls 3 internal fn (internal_error, invalid_request, not_found); 2 external calls (kind, to_string).


##### `tests::helper_protocol_uses_path_uris`  (lines 316–372)

```
fn helper_protocol_uses_path_uris() -> serde_json::Result<()>
```

**Purpose**: This test checks that helper requests and responses serialize paths as file URI strings, not as plain local path text. A file URI is a path written in URL form, starting with file:, which can represent both local and server-style paths.

**Data flow**: It builds example path URI values, converts helper request and response objects into JSON, and compares the JSON against the exact expected shape. It also checks that the serialized path string matches the original URI and starts with file:.

**Call relations**: This test exercises the serialization rules for FsHelperRequest, FsHelperResponse, and FsHelperPayload. It uses write-file and canonicalize examples because they cover paths in both incoming requests and outgoing responses.

*Call graph*: calls 2 internal fn (from_path, parse); 8 external calls (new, assert!, assert_eq!, Canonicalize, WriteFile, Ok, to_value, current_dir).


### Sandboxed filesystem execution
Builds the sandboxed filesystem backend by validating sandboxable requests, invoking the helper subprocess, and translating its results back into filesystem operations.

### `exec-server/src/fs_sandbox.rs`

`orchestration` · `request handling`

The execution server sometimes needs a small helper process to do file-system work, such as reading or changing files. This file is the gatekeeper for that helper. It turns a requested permission profile into a real sandboxed command, starts the helper, sends it a JSON request through standard input, then reads a JSON response from standard output.

The main idea is: lock the helper in a room, but make sure the room still contains the tools it needs. The code first decides the helper’s working directory. That matters because some permissions are relative to the current project folder. It then converts URI-style paths into native operating-system paths, adds minimal read access needed for platform startup and for the Codex helper binaries, normalizes path aliases, and blocks network access.

A second important job is environment cleanup. Instead of passing the whole process environment, which could include secrets like API keys, it keeps only a small allowlist such as PATH and temporary-directory variables.

Finally, it asks the sandboxing layer to transform the helper command for the current platform, launches it, writes the request JSON, waits for it to finish, and converts either the helper payload or error into the server’s JSON-RPC error format.

#### Function details

##### `FileSystemSandboxRunner::new`  (lines 56–61)

```
fn new(runtime_paths: ExecServerRuntimePaths) -> Self
```

**Purpose**: Creates a runner that knows where the Codex helper programs live and what small set of environment variables may be passed to them. This is used before any sandboxed helper request can be run.

**Data flow**: It receives runtime paths for the current executable and optional sandbox executable. It calls helper_env to build a cleaned environment map, then stores both pieces in a FileSystemSandboxRunner.

**Call relations**: Construction happens before sandboxed file-system work. Later, FileSystemSandboxRunner::run uses the stored paths and environment to prepare each helper process.

*Call graph*: calls 1 internal fn (helper_env); called by 2 (sandbox_exec_request_carries_helper_env, new).


##### `FileSystemSandboxRunner::run`  (lines 63–94)

```
async fn run(
        &self,
        sandbox: &FileSystemSandboxContext,
        request: FsHelperRequest,
    ) -> Result<FsHelperPayload, JSONRPCErrorError>
```

**Purpose**: Runs one file-system helper request inside the correct sandbox. It is the main high-level path for turning a server request into a safely executed helper process.

**Data flow**: It takes a sandbox context and a helper request. It finds the working directory, converts requested permissions into native sandbox permissions, adds the helper’s own startup read access, normalizes path aliases, forces the network to be restricted, builds a sandbox command, serializes the request as JSON, and returns either the helper payload or a JSON-RPC error.

**Call relations**: This is called by the broader run_sandboxed flow. It coordinates sandbox_cwd, helper_read_roots, add_helper_runtime_permissions, normalize_file_system_policy_root_aliases, sandbox_exec_request, and run_command in that order so the helper is launched only after permissions are prepared.

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

**Purpose**: Builds the exact sandboxed command that will start the file-system helper. It hides the platform-specific sandbox setup behind one request object.

**Data flow**: It receives a permission profile, a working-directory URI, and sandbox settings. It selects an appropriate sandbox, builds a command that runs the current Codex executable in helper mode, attaches the cleaned environment, and asks the sandbox manager to transform it into the final executable request.

**Call relations**: FileSystemSandboxRunner::run calls this after permissions are finalized. It hands the resulting SandboxExecRequest back to run, which passes it to run_command for actual process execution.

*Call graph*: calls 2 internal fn (to_runtime_permissions, new); called by 1 (run); 2 external calls (clone, vec!).


##### `sandbox_cwd`  (lines 136–154)

```
fn sandbox_cwd(sandbox: &FileSystemSandboxContext) -> Result<SandboxCwd, JSONRPCErrorError>
```

**Purpose**: Decides which directory the sandboxed helper should treat as its current working directory. This is important because some permissions depend on the project or current folder.

**Data flow**: It reads the sandbox context. If the context already has a cwd URI, it converts it to a native absolute path. If no cwd is provided but permissions depend on cwd, it returns an invalid-request error. Otherwise it uses the server’s current sandbox cwd and converts that into both a native path and URI.

**Call relations**: FileSystemSandboxRunner::run calls this at the start of request preparation. Several tests call it directly to confirm it accepts explicit native directories and rejects unsafe or ambiguous missing directories.

*Call graph*: calls 6 internal fn (native_sandbox_cwd, current_sandbox_cwd, invalid_request, has_cwd_dependent_permissions, from_absolute_path, from_abs_path); called by 3 (run, sandbox_cwd_rejects_cwd_dependent_profile_without_context_cwd, sandbox_cwd_rejects_non_native_context_cwd_without_fallback).


##### `native_sandbox_cwd`  (lines 156–159)

```
fn native_sandbox_cwd(cwd: &PathUri) -> Result<AbsolutePathBuf, JSONRPCErrorError>
```

**Purpose**: Converts a path URI for the working directory into an absolute path understood by the local operating system. It exists so the rest of the sandbox code can work with native paths.

**Data flow**: It receives a PathUri. It asks the URI to become an absolute local path; if that is impossible on this operating system, it turns the problem into an invalid-request error.

**Call relations**: sandbox_cwd calls this when the sandbox context provides a cwd. It is the small conversion step between URI-based protocol data and native file-system sandbox rules.

*Call graph*: calls 1 internal fn (to_abs_path); called by 1 (sandbox_cwd).


##### `helper_read_roots`  (lines 161–174)

```
fn helper_read_roots(runtime_paths: &ExecServerRuntimePaths) -> Vec<AbsolutePathBuf>
```

**Purpose**: Finds the directories the helper may need to read just to start and run. These are usually the folders containing the Codex executable and, on Linux, the sandbox executable.

**Data flow**: It receives runtime paths. It looks at the parent directory of each relevant executable, keeps only absolute paths, removes duplicates, and returns those directories as read roots.

**Call relations**: FileSystemSandboxRunner::run uses this unless legacy Landlock mode is active. Tests call it to verify helper startup directories are added without disturbing existing write permissions.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 4 (run, helper_permissions_include_helper_read_root_without_additional_permissions, helper_permissions_include_linux_sandbox_alias_parent, helper_permissions_preserve_existing_writes); 2 external calls (new, once).


##### `add_helper_runtime_permissions`  (lines 176–205)

```
fn add_helper_runtime_permissions(
    file_system_policy: &mut FileSystemSandboxPolicy,
    helper_read_roots: &[AbsolutePathBuf],
    cwd: &std::path::Path,
)
```

**Purpose**: Adds the minimum extra file permissions the helper needs to function, without widening access more than necessary. Without this, a tightly restricted helper might fail before it can do the requested work.

**Data flow**: It receives a mutable file-system policy, helper read-root directories, and the working directory. If the policy does not already allow full-disk reads, it adds a minimal platform read entry. Then it adds read entries for helper executable directories only when the policy cannot already read them.

**Call relations**: FileSystemSandboxRunner::run calls this while preparing the final policy. The tests call it repeatedly to check that minimal reads are added, helper directories become readable, and existing write rules are preserved.

*Call graph*: calls 2 internal fn (can_read_path_with_cwd, has_full_disk_read_access); called by 6 (run, helper_permissions_enable_minimal_reads_for_restricted_profile, helper_permissions_enable_minimal_reads_for_restricted_profile_with_writes, helper_permissions_include_helper_read_root_without_additional_permissions, helper_permissions_include_linux_sandbox_alias_parent, helper_permissions_preserve_existing_writes).


##### `normalize_file_system_policy_root_aliases`  (lines 207–213)

```
fn normalize_file_system_policy_root_aliases(file_system_policy: &mut FileSystemSandboxPolicy)
```

**Purpose**: Rewrites path entries in a file-system policy so top-level path aliases are made consistent. This helps the sandbox recognize paths that may be spelled differently because of symlinks or platform aliases.

**Data flow**: It receives a mutable file-system policy. For every entry that names a concrete path, it replaces that path with the result of normalize_top_level_alias. Special symbolic paths are left unchanged.

**Call relations**: FileSystemSandboxRunner::run calls this after helper permissions are added and before the sandbox command is built. It delegates the actual path check to normalize_top_level_alias.

*Call graph*: calls 1 internal fn (normalize_top_level_alias); called by 1 (run).


##### `normalize_top_level_alias`  (lines 215–237)

```
fn normalize_top_level_alias(path: AbsolutePathBuf) -> AbsolutePathBuf
```

**Purpose**: Looks for the first existing ancestor of a path whose canonical spelling differs, then rebuilds the full path from that normalized ancestor. This is mainly to avoid sandbox mismatches caused by path aliases.

**Data flow**: It receives an absolute path. It walks upward through that path’s ancestors, checks which ancestors exist, tries to canonicalize them while preserving symlink behavior, and if it finds a different spelling, appends the original remaining suffix to that normalized ancestor. If nothing useful is found, it returns the original path.

**Call relations**: normalize_file_system_policy_root_aliases calls this for each concrete policy path. It does not launch anything or change the file system; it only returns a better path spelling.

*Call graph*: calls 2 internal fn (from_absolute_path, to_path_buf); called by 1 (normalize_file_system_policy_root_aliases); 2 external calls (canonicalize_preserving_symlinks, symlink_metadata).


##### `helper_env`  (lines 239–241)

```
fn helper_env() -> HashMap<String, String>
```

**Purpose**: Builds the environment variable map that the helper process is allowed to see. This protects secrets by not forwarding the server’s entire environment.

**Data flow**: It reads the current process environment and passes all variables through helper_env_from_vars. The result is a map containing only allowlisted variables and their string values.

**Call relations**: FileSystemSandboxRunner::new calls this once when the runner is created. A test also calls it directly to ensure it matches the same allowlist rules used by helper_env_from_vars.

*Call graph*: calls 1 internal fn (helper_env_from_vars); called by 2 (new, helper_env_carries_only_allowlisted_runtime_vars); 1 external calls (vars_os).


##### `helper_env_from_vars`  (lines 243–253)

```
fn helper_env_from_vars(
    vars: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> HashMap<String, String>
```

**Purpose**: Filters any given list of environment variables down to the safe helper allowlist. This makes the filtering easy to test without depending on the real machine environment.

**Data flow**: It receives key-value environment pairs. For each key, it asks helper_env_key_is_allowed whether the variable may pass; allowed keys and values are converted to strings and collected into a map, while all others are dropped.

**Call relations**: helper_env uses this for the real environment. Platform-specific tests feed it sample variables to prove PATH and temp variables survive while secrets such as API keys do not.

*Call graph*: called by 4 (helper_env, helper_env_preserves_corefoundation_text_encoding, helper_env_preserves_path_for_system_bwrap_discovery_without_leaking_secrets, helper_env_preserves_windows_path_key_for_system_bwrap_discovery); 1 external calls (into_iter).


##### `helper_env_key_is_allowed`  (lines 255–261)

```
fn helper_env_key_is_allowed(key: &str) -> bool
```

**Purpose**: Answers whether one environment variable name is safe and useful for the helper. It keeps startup necessities and rejects unrelated variables that may contain secrets.

**Data flow**: It receives a variable name. It checks the fixed allowlist, adds a macOS startup variable when on macOS, adds Bazel test variables in debug Bazel builds, and treats PATH case-insensitively on Windows.

**Call relations**: helper_env_from_vars relies on this decision for every environment variable. It calls bazel_bwrap_env_key_is_allowed for the special debug-build Bazel case.

*Call graph*: calls 1 internal fn (bazel_bwrap_env_key_is_allowed); 1 external calls (cfg!).


##### `bazel_bwrap_env_key_is_allowed`  (lines 269–271)

```
fn bazel_bwrap_env_key_is_allowed(_key: &str) -> bool
```

**Purpose**: Allows a small set of Bazel test environment variables needed to find bubblewrap-style sandbox tooling during debug builds. In non-debug builds, it always rejects them.

**Data flow**: It receives an environment variable name. In debug builds, it checks whether the code is running under a Bazel package and whether the key is in the Bazel allowlist; otherwise it returns false.

**Call relations**: helper_env_key_is_allowed calls this as one part of its environment filtering decision. This keeps test-only sandbox discovery support out of normal release behavior.

*Call graph*: called by 1 (helper_env_key_is_allowed); 1 external calls (option_env!).


##### `run_command`  (lines 273–299)

```
async fn run_command(
    command: SandboxExecRequest,
    request_json: Vec<u8>,
) -> Result<FsHelperPayload, JSONRPCErrorError>
```

**Purpose**: Actually starts the prepared sandboxed helper process, sends it the request, and reads its answer. This is the point where the prepared command becomes a running child process.

**Data flow**: It receives a SandboxExecRequest and serialized request JSON. It spawns the process, writes the JSON to the child’s standard input, closes input, waits for output, checks the exit status, decodes the child’s standard output as an FsHelperResponse, and returns either the payload or the helper’s error.

**Call relations**: FileSystemSandboxRunner::run calls this after sandbox_exec_request has built the safe command. run_command delegates process creation to spawn_command and turns failed process status or invalid JSON into internal errors.

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

**Purpose**: Turns the sandbox execution request into a Tokio child process, which is an asynchronously managed operating-system process. It sets up clean input, output, error streams, directory, and environment.

**Data flow**: It receives a SandboxExecRequest and extracts the command arguments, cwd, environment, and optional Unix arg0. If the command is empty, it returns an invalid request. Otherwise it creates a process with cleared environment, the supplied environment only, piped stdin/stdout/stderr, and kill-on-drop enabled, then starts it.

**Call relations**: run_command calls this before writing the helper request. The child process it returns is then used by run_command to send JSON and collect the helper response.

*Call graph*: calls 1 internal fn (invalid_request); called by 1 (run_command); 2 external calls (new, piped).


##### `io_error`  (lines 331–333)

```
fn io_error(err: std::io::Error) -> JSONRPCErrorError
```

**Purpose**: Converts a low-level input/output error into the JSON-RPC error shape used by the server. This gives callers a consistent error format.

**Data flow**: It receives a std::io::Error, turns it into text, wraps that text as an internal JSON-RPC error, and returns it.

**Call relations**: The command-running path uses this kind of conversion when file, pipe, directory, or process operations fail. It keeps those failures from leaking as raw Rust errors.

*Call graph*: calls 1 internal fn (internal_error); 1 external calls (to_string).


##### `json_error`  (lines 335–339)

```
fn json_error(err: serde_json::Error) -> JSONRPCErrorError
```

**Purpose**: Converts JSON encoding or decoding failures into the server’s JSON-RPC error format. This is used when talking to the helper through JSON messages fails.

**Data flow**: It receives a serde_json error. It formats a clear message saying the helper message could not be encoded or decoded, wraps it as an internal error, and returns it.

**Call relations**: The request-and-response flow uses this when serializing the helper request or parsing the helper response. That keeps protocol failures reported in the same style as other server errors.

*Call graph*: calls 1 internal fn (internal_error); 1 external calls (format!).


##### `tests::helper_permissions_enable_minimal_reads_for_restricted_profile`  (lines 369–377)

```
fn helper_permissions_enable_minimal_reads_for_restricted_profile()
```

**Purpose**: Checks that a restricted policy with no entries still gets the platform’s minimal read permissions for helper startup.

**Data flow**: It creates a temporary absolute cwd and an empty restricted policy, applies add_helper_runtime_permissions, then asserts the policy includes platform default reads.

**Call relations**: This test exercises add_helper_runtime_permissions directly to protect the startup-read behavior used by FileSystemSandboxRunner::run.

*Call graph*: calls 2 internal fn (add_helper_runtime_permissions, from_absolute_path); 4 external calls (new, assert!, restricted_policy, temp_dir).


##### `tests::helper_permissions_enable_minimal_reads_for_restricted_profile_with_writes`  (lines 380–391)

```
fn helper_permissions_enable_minimal_reads_for_restricted_profile_with_writes()
```

**Purpose**: Checks that adding helper read permissions still happens when the restricted policy already contains write access.

**Data flow**: It creates a cwd, adds a writable path entry, calls add_helper_runtime_permissions, and asserts that platform default reads are included.

**Call relations**: This test supports the same helper-permission path used by FileSystemSandboxRunner::run, with the extra case that write permissions are already present.

*Call graph*: calls 2 internal fn (add_helper_runtime_permissions, from_absolute_path); 4 external calls (assert!, restricted_policy, temp_dir, vec!).


##### `tests::helper_permissions_preserve_existing_writes`  (lines 394–422)

```
fn helper_permissions_preserve_existing_writes()
```

**Purpose**: Verifies that helper startup read permissions do not remove or weaken an existing write permission.

**Data flow**: It builds runtime paths from the current executable, creates a policy with one writable directory, adds helper read roots, and then checks both that the helper directory is readable and the original directory remains writable.

**Call relations**: This test calls helper_read_roots and add_helper_runtime_permissions together, mirroring the preparation sequence inside FileSystemSandboxRunner::run.

*Call graph*: calls 4 internal fn (add_helper_runtime_permissions, helper_read_roots, new, from_absolute_path); 5 external calls (assert!, restricted_policy, current_exe, temp_dir, vec!).


##### `tests::helper_env_carries_only_allowlisted_runtime_vars`  (lines 425–437)

```
fn helper_env_carries_only_allowlisted_runtime_vars()
```

**Purpose**: Confirms that helper_env returns exactly the current environment variables allowed by the filtering rule.

**Data flow**: It calls helper_env, independently filters the real environment using helper_env_key_is_allowed, and compares the two maps.

**Call relations**: This test checks the environment setup used by FileSystemSandboxRunner::new before any helper command is built.

*Call graph*: calls 1 internal fn (helper_env); 2 external calls (assert_eq!, vars_os).


##### `tests::helper_env_preserves_path_for_system_bwrap_discovery_without_leaking_secrets`  (lines 440–463)

```
fn helper_env_preserves_path_for_system_bwrap_discovery_without_leaking_secrets()
```

**Purpose**: Checks that PATH and temporary-directory variables survive filtering, while home directories, API keys, and proxy settings are dropped.

**Data flow**: It feeds sample environment variables into helper_env_from_vars and expects a map containing only PATH, TMPDIR, TMP, and TEMP.

**Call relations**: This test focuses on helper_env_from_vars, the filter used by helper_env, to guard against accidentally passing sensitive environment variables to the sandboxed helper.

*Call graph*: calls 1 internal fn (helper_env_from_vars); 1 external calls (assert_eq!).


##### `tests::helper_env_preserves_corefoundation_text_encoding`  (lines 467–483)

```
fn helper_env_preserves_corefoundation_text_encoding()
```

**Purpose**: On macOS, checks that the special CoreFoundation text-encoding variable is preserved for helper startup.

**Data flow**: It passes a macOS-specific encoding variable and HOME into helper_env_from_vars, then expects only the encoding variable to remain.

**Call relations**: This platform-specific test protects the macOS branch inside helper_env_key_is_allowed.

*Call graph*: calls 1 internal fn (helper_env_from_vars); 1 external calls (assert_eq!).


##### `tests::helper_env_preserves_windows_path_key_for_system_bwrap_discovery`  (lines 487–501)

```
fn helper_env_preserves_windows_path_key_for_system_bwrap_discovery()
```

**Purpose**: On Windows, checks that PATH is kept even when its casing is written as Path, while similar-looking unsafe names are rejected.

**Data flow**: It sends sample Windows-style environment variables into helper_env_from_vars and expects only the Path entry to remain.

**Call relations**: This platform-specific test protects the Windows case-insensitive PATH rule inside helper_env_key_is_allowed.

*Call graph*: calls 1 internal fn (helper_env_from_vars); 1 external calls (assert_eq!).


##### `tests::sandbox_exec_request_carries_helper_env`  (lines 504–532)

```
fn sandbox_exec_request_carries_helper_env()
```

**Purpose**: Checks that the sandbox execution request includes the cleaned helper environment, especially PATH.

**Data flow**: It finds PATH in the current environment, builds runtime paths and a runner, creates a restricted permission profile with a writable cwd, asks sandbox_exec_request to build the command, and asserts the request environment contains the expected PATH value.

**Call relations**: This test calls FileSystemSandboxRunner::new and then FileSystemSandboxRunner::sandbox_exec_request, confirming that environment prepared at construction reaches the final command.

*Call graph*: calls 5 internal fn (new, new, from_runtime_permissions, current_dir, from_abs_path); 6 external calls (assert_eq!, restricted_policy, sandbox_context_with_cwd, current_exe, vars_os, vec!).


##### `tests::sandbox_cwd_uses_context_cwd`  (lines 535–552)

```
fn sandbox_cwd_uses_context_cwd()
```

**Purpose**: Checks that an explicit cwd in the sandbox context is used as the sandbox working directory.

**Data flow**: It builds an absolute temporary cwd, converts it to a URI, creates a cwd-dependent policy and context, then expects sandbox_cwd to return both the same URI and native path.

**Call relations**: This test protects the first branch of sandbox_cwd, which FileSystemSandboxRunner::run depends on when permissions are relative to a project directory.

*Call graph*: calls 2 internal fn (from_absolute_path, from_abs_path); 5 external calls (assert_eq!, restricted_policy, sandbox_context_with_cwd, temp_dir, vec!).


##### `tests::sandbox_cwd_rejects_non_native_context_cwd_without_fallback`  (lines 555–572)

```
fn sandbox_cwd_rejects_non_native_context_cwd_without_fallback()
```

**Purpose**: Checks that a cwd URI that is not valid for the current operating system is rejected rather than silently replaced.

**Data flow**: It creates a deliberately non-native cwd URI, builds a sandbox context using it, calls sandbox_cwd, and compares the returned error to the expected invalid-request error.

**Call relations**: This test calls sandbox_cwd directly to ensure native_sandbox_cwd failures are visible to callers instead of falling back to some other directory.

*Call graph*: calls 1 internal fn (sandbox_cwd); 5 external calls (assert_eq!, non_native_cwd, restricted_policy, sandbox_context_with_cwd, vec!).


##### `tests::sandbox_cwd_rejects_cwd_dependent_profile_without_context_cwd`  (lines 575–592)

```
fn sandbox_cwd_rejects_cwd_dependent_profile_without_context_cwd()
```

**Purpose**: Checks that cwd-dependent permissions require an explicit cwd. This prevents relative project-root permissions from being interpreted against the wrong directory.

**Data flow**: It creates a policy that refers to project roots, builds a sandbox context without a cwd, calls sandbox_cwd, and asserts the error message explains that cwd is required.

**Call relations**: This test protects the guard in sandbox_cwd that FileSystemSandboxRunner::run relies on before preparing permissions.

*Call graph*: calls 4 internal fn (sandbox_cwd, from_permission_profile, from_runtime_permissions, restricted); 2 external calls (assert_eq!, vec!).


##### `tests::helper_permissions_include_helper_read_root_without_additional_permissions`  (lines 595–618)

```
fn helper_permissions_include_helper_read_root_without_additional_permissions()
```

**Purpose**: Checks that the helper executable’s parent directory becomes readable even when the original policy has no extra permissions.

**Data flow**: It builds runtime paths from the current executable, creates a restricted policy, adds helper runtime permissions, and asserts the executable’s parent directory can be read.

**Call relations**: This test combines helper_read_roots and add_helper_runtime_permissions, matching the helper-read-root logic used in FileSystemSandboxRunner::run.

*Call graph*: calls 4 internal fn (add_helper_runtime_permissions, helper_read_roots, new, from_absolute_path); 5 external calls (new, assert!, restricted_policy, current_exe, temp_dir).


##### `tests::helper_permissions_include_linux_sandbox_alias_parent`  (lines 621–644)

```
fn helper_permissions_include_linux_sandbox_alias_parent()
```

**Purpose**: Checks that both the Codex executable directory and a separate Linux sandbox executable directory are added as helper read roots.

**Data flow**: It creates temporary fake executable paths in different parent directories, builds runtime paths, applies helper runtime permissions, and asserts both parent directories are readable.

**Call relations**: This test protects helper_read_roots behavior for installations where the Linux sandbox executable is stored outside the main Codex executable directory.

*Call graph*: calls 4 internal fn (add_helper_runtime_permissions, helper_read_roots, new, from_absolute_path); 5 external calls (new, assert!, restricted_policy, temp_dir, tempdir).


##### `tests::restricted_policy`  (lines 646–648)

```
fn restricted_policy(entries: Vec<FileSystemSandboxEntry>) -> FileSystemSandboxPolicy
```

**Purpose**: Creates a restricted file-system policy for tests. It keeps test setup short and readable.

**Data flow**: It receives a list of file-system sandbox entries and returns a restricted FileSystemSandboxPolicy containing them.

**Call relations**: Many tests call this helper before exercising add_helper_runtime_permissions, sandbox_cwd, or sandbox_exec_request.

*Call graph*: calls 1 internal fn (restricted).


##### `tests::sandbox_context_with_cwd`  (lines 650–658)

```
fn sandbox_context_with_cwd(
        policy: &FileSystemSandboxPolicy,
        cwd: PathUri,
    ) -> crate::FileSystemSandboxContext
```

**Purpose**: Builds a sandbox context with both permissions and an explicit working directory for tests.

**Data flow**: It receives a file-system policy and cwd URI, wraps the policy with a restricted network setting into a permission profile, then creates a FileSystemSandboxContext using that cwd.

**Call relations**: Tests use this helper when they need sandbox_cwd or sandbox_exec_request to see an explicit cwd, matching the shape used by real requests.

*Call graph*: calls 2 internal fn (from_permission_profile_with_cwd, from_runtime_permissions).


##### `tests::non_native_cwd`  (lines 660–667)

```
fn non_native_cwd() -> PathUri
```

**Purpose**: Creates a cwd URI that should be invalid on the current operating system. This is used to test rejection of non-native paths.

**Data flow**: It chooses a Unix-incompatible URI on Windows or a Windows/network-style URI on Unix, parses it as a PathUri, and returns it.

**Call relations**: tests::sandbox_cwd_rejects_non_native_context_cwd_without_fallback calls this to feed sandbox_cwd a path it must reject.

*Call graph*: calls 1 internal fn (parse).


##### `tests::path_entry`  (lines 669–674)

```
fn path_entry(path: AbsolutePathBuf, access: FileSystemAccessMode) -> FileSystemSandboxEntry
```

**Purpose**: Builds a concrete path permission entry for tests. It avoids repeating the full struct shape in each test.

**Data flow**: It receives an absolute path and an access mode such as read or write. It returns a FileSystemSandboxEntry that applies that access mode to the path.

**Call relations**: Tests use this helper when constructing restricted policies for add_helper_runtime_permissions and sandbox_exec_request scenarios.


##### `tests::special_entry`  (lines 676–684)

```
fn special_entry(
        value: FileSystemSpecialPath,
        access: FileSystemAccessMode,
    ) -> FileSystemSandboxEntry
```

**Purpose**: Builds a special symbolic path permission entry for tests, such as project-root-based permissions. This helps test permissions that depend on cwd.

**Data flow**: It receives a special path value and an access mode. It returns a FileSystemSandboxEntry using that special path rather than a fixed absolute path.

**Call relations**: cwd-focused tests use this helper to create policies that make sandbox_cwd’s cwd requirement meaningful.


### `exec-server/src/sandboxed_file_system.rs`

`io_transport` · `request handling`

This file is the guarded doorway between the exec server and the local file system. Instead of opening or changing files directly, it sends each request to a sandbox helper process through FileSystemSandboxRunner. The sandbox is like a security desk: every file action must show both a valid local path and a sandbox policy that allows the action.

The main type, SandboxedFileSystem, implements the ExecutorFileSystem interface, so the rest of the server can ask for normal file operations without knowing the details of the sandbox machinery. For every operation, the code first requires a real platform sandbox context. Then it checks that the PathUri can be turned into a native absolute path, which rejects non-local or unsupported URI-style paths. Only after those checks does it build a helper request, run it inside the sandbox, and translate the response into the server’s normal data types.

File contents are sent through the helper as base64 text, which is a safe way to carry raw bytes inside JSON-style messages. One important limitation is that streaming reads are deliberately not supported here, because this sandbox helper only supports whole-file read requests. Sandbox error codes are also translated into ordinary input/output errors, so callers get familiar results such as “not found” or “invalid input.”

#### Function details

##### `SandboxedFileSystem::new`  (lines 36–40)

```
fn new(runtime_paths: ExecServerRuntimePaths) -> Self
```

**Purpose**: Creates a SandboxedFileSystem ready to run file operations through the sandbox helper. It uses the server’s runtime paths to set up the helper runner that will later execute sandboxed requests.

**Data flow**: It receives ExecServerRuntimePaths, which say where runtime support files live. It passes those paths into FileSystemSandboxRunner::new and stores the resulting runner inside a new SandboxedFileSystem. The result is a reusable file-system object.

**Call relations**: This is the setup step. It is called when code builds an executor file system with runtime paths, and also by tests that check sandboxed path behavior. After construction, the operation methods use the stored runner through run_sandboxed.

*Call graph*: calls 1 internal fn (new); called by 2 (with_runtime_paths, sandboxed_file_system_rejects_non_native_uri_as_invalid_input).


##### `SandboxedFileSystem::run_sandboxed`  (lines 42–51)

```
async fn run_sandboxed(
        &self,
        sandbox: &FileSystemSandboxContext,
        request: FsHelperRequest,
    ) -> FileSystemResult<FsHelperPayload>
```

**Purpose**: Sends one file-system helper request into the platform sandbox and returns the helper’s answer. It centralizes the common step of running the sandbox and converting sandbox protocol errors into normal I/O errors.

**Data flow**: It receives a sandbox context and a helper request, such as “read this file” or “copy this path.” It asks the FileSystemSandboxRunner to run that request under the sandbox. If the runner reports a JSON-RPC error, it turns that into an io::Error; otherwise it returns the helper payload.

**Call relations**: All real file operations call this after they have checked the sandbox and path. It hands the request off to FileSystemSandboxRunner::run, then gives the response back to methods such as read_file, write_file, copy, and remove.

*Call graph*: calls 1 internal fn (run); called by 8 (canonicalize, copy, create_directory, get_metadata, read_directory, read_file, remove, write_file).


##### `SandboxedFileSystem::canonicalize`  (lines 253–259)

```
fn canonicalize(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, PathUri>
```

**Purpose**: Finds the normalized, real version of a path while staying inside the sandbox rules. Canonicalizing is useful for resolving things like relative pieces or symbolic links into a clear absolute path.

**Data flow**: It receives a PathUri and an optional sandbox context. It first requires that the sandbox is present and suitable, then checks that the path is a native local path. It sends a Canonicalize request through run_sandboxed and returns the path from the helper response.

**Call relations**: This operation follows the standard pattern used by this file: require_platform_sandbox, validate_native_path, then run_sandboxed. The public ExecutorFileSystem call boxes this asynchronous work so callers can use it through the shared file-system interface.

*Call graph*: calls 3 internal fn (run_sandboxed, require_platform_sandbox, validate_native_path); 3 external calls (pin, Canonicalize, clone).


##### `SandboxedFileSystem::read_file`  (lines 261–267)

```
fn read_file(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>>
```

**Purpose**: Reads the full contents of a file through the sandbox. It returns the file as raw bytes, while the helper communication carries those bytes as base64 text.

**Data flow**: It receives a path and an optional sandbox context. After requiring a valid sandbox and native path, it sends a ReadFile request through run_sandboxed. The helper returns base64-encoded file data; this function decodes that text into bytes and returns them, or reports invalid data if decoding fails.

**Call relations**: Callers use this through the ExecutorFileSystem interface when they need a whole file at once. Internally it relies on require_platform_sandbox, validate_native_path, and run_sandboxed, then converts the helper’s response into the byte vector expected by the rest of the server.

*Call graph*: calls 3 internal fn (run_sandboxed, require_platform_sandbox, validate_native_path); 3 external calls (pin, ReadFile, clone).


##### `SandboxedFileSystem::read_file_stream`  (lines 269–280)

```
fn read_file_stream(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream>
```

**Purpose**: Rejects streaming file reads for this sandboxed file system. Streaming means reading a file gradually in chunks, but this platform sandbox path only supports whole-file reads.

**Data flow**: It receives a path and optional sandbox context, but intentionally does not use them. It immediately returns an Unsupported I/O error explaining that streaming file reads do not support platform sandboxing.

**Call relations**: This exists because ExecutorFileSystem requires a streaming-read method. Instead of pretending streaming is available, it clearly stops the call at the boundary and tells callers to use the normal read_file flow if they need sandboxed file contents.

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

**Purpose**: Writes bytes to a file through the sandbox. It protects the operation by requiring a sandbox policy before any write request is sent.

**Data flow**: It receives a path, the bytes to write, and an optional sandbox context. It checks the sandbox and native path, encodes the bytes as base64 text, sends a WriteFile request through run_sandboxed, and returns success if the helper confirms the write.

**Call relations**: This is the sandboxed write path used through ExecutorFileSystem. Like the other operations, it performs local validation first, then hands the actual file change to run_sandboxed so FileSystemSandboxRunner can enforce the platform sandbox.

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

**Purpose**: Creates a directory through the sandbox, optionally creating missing parent directories too. This lets callers prepare workspace folders without bypassing sandbox restrictions.

**Data flow**: It receives a target path, create-directory options, and an optional sandbox context. It requires an allowed sandbox, checks the path, packages the path and recursive option into a CreateDirectory request, then sends it through run_sandboxed. It returns success when the helper accepts the operation.

**Call relations**: The ExecutorFileSystem interface calls this when a directory needs to be made. It uses require_platform_sandbox and validate_native_path before passing the request to run_sandboxed, which performs the actual sandboxed helper call.

*Call graph*: calls 3 internal fn (run_sandboxed, require_platform_sandbox, validate_native_path); 3 external calls (pin, CreateDirectory, clone).


##### `SandboxedFileSystem::get_metadata`  (lines 304–310)

```
fn get_metadata(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>
```

**Purpose**: Asks for basic facts about a file-system item through the sandbox. These facts include whether it is a file, directory, or symbolic link, plus size and timestamps.

**Data flow**: It receives a path and optional sandbox context. After sandbox and path checks, it sends a GetMetadata request through run_sandboxed. It then copies the helper’s metadata fields into the FileMetadata type used by the rest of the exec server.

**Call relations**: Callers use this through ExecutorFileSystem when they need to inspect a path before deciding what to do. The function follows the common validation-and-run pattern, then translates the helper response into the local data model.

*Call graph*: calls 3 internal fn (run_sandboxed, require_platform_sandbox, validate_native_path); 3 external calls (pin, GetMetadata, clone).


##### `SandboxedFileSystem::read_directory`  (lines 312–318)

```
fn read_directory(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>>
```

**Purpose**: Lists the entries inside a directory through the sandbox. It returns simple information for each child, such as the name and whether it is a file or directory.

**Data flow**: It receives a directory path and optional sandbox context. It requires a suitable sandbox, validates the native path, sends a ReadDirectory request through run_sandboxed, and converts each helper entry into a ReadDirectoryEntry for callers.

**Call relations**: This is the directory-listing operation behind the ExecutorFileSystem interface. It depends on require_platform_sandbox and validate_native_path before run_sandboxed, then reshapes the helper’s response into the server’s standard entry list.

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

**Purpose**: Deletes a file or directory through the sandbox. Its options decide whether directory removal can be recursive and whether missing paths should be ignored.

**Data flow**: It receives a path, remove options, and an optional sandbox context. It checks that sandboxing is active and that the path is native, then sends a Remove request containing the recursive and force flags through run_sandboxed. It returns success when the helper confirms removal.

**Call relations**: This method is called through ExecutorFileSystem when something must be deleted safely. It uses the shared helper path: validate the request locally, then let FileSystemSandboxRunner carry out the deletion inside the sandbox.

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

**Purpose**: Copies a file or directory from one path to another through the sandbox. It checks both the source and destination paths before asking the helper to do the copy.

**Data flow**: It receives a source path, destination path, copy options, and an optional sandbox context. It requires an allowed sandbox, validates both paths as native local paths, sends a Copy request through run_sandboxed, and returns success when the helper confirms the copy.

**Call relations**: This is the safe copy operation exposed through ExecutorFileSystem. It calls the same sandbox and path guards as the other operations, but applies path validation twice because both ends of the copy must be acceptable.

*Call graph*: calls 3 internal fn (run_sandboxed, require_platform_sandbox, validate_native_path); 3 external calls (pin, Copy, clone).


##### `validate_native_path`  (lines 351–353)

```
fn validate_native_path(path: &PathUri) -> FileSystemResult<()>
```

**Purpose**: Checks that a PathUri can be converted into a native absolute file-system path. This prevents sandboxed file operations from receiving unsupported URI-style paths.

**Data flow**: It receives a PathUri. It calls to_abs_path on it and discards the converted path if conversion succeeds. It returns success for valid native paths or an error if the path cannot be treated as a local absolute path.

**Call relations**: Every sandboxed operation calls this before sending a helper request. It acts like an early gatekeeper, so run_sandboxed only receives requests with paths the platform file system can actually understand.

*Call graph*: calls 1 internal fn (to_abs_path); called by 8 (canonicalize, copy, create_directory, get_metadata, read_directory, read_file, remove, write_file).


##### `require_platform_sandbox`  (lines 355–366)

```
fn require_platform_sandbox(
    sandbox: Option<&FileSystemSandboxContext>,
) -> FileSystemResult<&FileSystemSandboxContext>
```

**Purpose**: Ensures that a file operation is actually being run with a sandbox policy that should use platform sandboxing. Without this check, the sandboxed file-system layer could be called in a mode where its safety guarantee does not apply.

**Data flow**: It receives an optional sandbox context. If a context is present and says it should run in the sandbox, the function returns that context. Otherwise it returns an InvalidInput error explaining that sandboxed operations require a ReadOnly or WorkspaceWrite sandbox policy.

**Call relations**: All file operations call this before path validation and before run_sandboxed. It is the first safety check in the flow, making sure the rest of this file is only used when the sandbox is truly active.

*Call graph*: called by 8 (canonicalize, copy, create_directory, get_metadata, read_directory, read_file, remove, write_file).


##### `map_sandbox_error`  (lines 368–374)

```
fn map_sandbox_error(error: JSONRPCErrorError) -> io::Error
```

**Purpose**: Translates sandbox protocol errors into ordinary I/O errors that the rest of the server already understands. This keeps callers from needing to know the sandbox helper’s JSON-RPC error codes.

**Data flow**: It receives a JSONRPCErrorError with a numeric code and message. A “not found” code becomes an io::ErrorKind::NotFound, an “invalid request” code becomes InvalidInput, and all other codes become a general I/O error with the same message.

**Call relations**: run_sandboxed uses this when FileSystemSandboxRunner reports an error, and individual operation methods also use it when unpacking helper responses. It is the adapter between the sandbox helper’s protocol language and normal Rust I/O error handling.

*Call graph*: 2 external calls (new, other).


### Filesystem backends
Provides the concrete local filesystem implementation and the RPC-forwarding remote implementation that expose the executor filesystem interface to callers.

### `exec-server/src/local_file_system.rs`

`io_transport` · `cross-cutting file operations during request handling`

This file is the local file cabinet for the exec server. Other parts of the server ask for file operations through a shared interface, and this file turns those requests into real operating-system file actions. Without it, the server could not open files, inspect folders, write results, or safely route file access when sandboxing is required.

There are three layers. LocalFileSystem is the public router. It looks at the optional sandbox context and chooses either the sandboxed file system or the ordinary one. UnsandboxedFileSystem is a safety wrapper around direct access: it refuses requests that claim they need platform sandboxing, because those must go through the sandboxed path instead. DirectFileSystem is the layer that actually talks to the operating system using Tokio, an asynchronous runtime that lets file work happen without blocking the whole server.

The file also includes careful edge-case behavior. Whole-file reads are capped at 512 MB so a request cannot accidentally load a huge file into memory. Streamed reads are available for reading in chunks. Directory copies are done recursively, but copying a directory into itself or one of its children is rejected, like stopping someone from packing a box inside itself. Symlinks, which are file-system shortcuts, are copied as links rather than as their targets when supported.

#### Function details

##### `file_too_large_error`  (lines 30–35)

```
fn file_too_large_error() -> io::Error
```

**Purpose**: Creates the standard error used when a caller tries to read a file larger than this module allows. This keeps large files from being loaded fully into memory by accident.

**Data flow**: It takes no input, uses the fixed maximum read size, builds a readable error message, and returns an input-error value that can be sent back to the caller.

**Call relations**: DirectFileSystem::read_file calls this when the file size is too large before or after reading, so all oversized-file failures use the same wording.

*Call graph*: called by 1 (read_file); 2 external calls (new, format!).


##### `LocalFileSystem::unsandboxed`  (lines 55–60)

```
fn unsandboxed() -> Self
```

**Purpose**: Builds a local file system that always uses normal, direct file access. This is useful when the server is running without configured sandbox runtime paths.

**Data flow**: It takes no input, creates the default unsandboxed layer, leaves the sandboxed layer empty, and returns a LocalFileSystem ready for ordinary file operations.

**Call relations**: Test setup code such as default_for_tests calls this when it needs a simple local file system without sandbox routing.

*Call graph*: called by 1 (default_for_tests); 1 external calls (default).


##### `LocalFileSystem::with_runtime_paths`  (lines 62–67)

```
fn with_runtime_paths(runtime_paths: ExecServerRuntimePaths) -> Self
```

**Purpose**: Builds a local file system that can use both normal access and sandboxed access. The runtime paths tell the sandbox where its working directories and support files live.

**Data flow**: It receives runtime path settings, creates the default unsandboxed layer, creates a SandboxedFileSystem from those paths, and returns a LocalFileSystem with both routes available.

**Call relations**: Higher-level setup paths such as local, new, and create_file_system_context call this when the server has enough configuration to support sandboxed file work.

*Call graph*: calls 1 internal fn (new); called by 3 (local, new, create_file_system_context); 1 external calls (default).


##### `LocalFileSystem::sandboxed`  (lines 69–76)

```
fn sandboxed(&self) -> io::Result<&SandboxedFileSystem>
```

**Purpose**: Returns the configured sandboxed file system, or explains why one is not available. It protects callers from trying to run sandboxed work without the needed setup.

**Data flow**: It reads the LocalFileSystem's optional sandboxed field. If present, it returns a reference to it; if absent, it returns an input error saying runtime paths are required.

**Call relations**: LocalFileSystem::file_system_for calls this whenever a request says it should run in a sandbox.

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

**Purpose**: Chooses the right file-system backend for one operation. It is the traffic officer that sends sandboxed requests to the sandbox and ordinary requests to the unsandboxed path.

**Data flow**: It receives an optional sandbox context. If that context says sandboxing is needed, it returns the sandboxed file system and the context; otherwise it returns the unsandboxed file system and the same context.

**Call relations**: Most LocalFileSystem operations call this first, then forward the real work to whichever backend it selected.

*Call graph*: calls 1 internal fn (sandboxed); called by 9 (canonicalize, copy, create_directory, get_metadata, read_directory, read_file, read_file_stream, remove, write_file).


##### `LocalFileSystem::open_file_for_read`  (lines 94–106)

```
async fn open_file_for_read(
        &self,
        path: &PathUri,
        sandbox: Option<&FileSystemSandboxContext>,
    ) -> FileSystemResult<tokio::fs::File>
```

**Purpose**: Opens a local file for streaming-style reading when sandboxing is not required. It deliberately refuses platform sandboxing because this streaming read path does not support it.

**Data flow**: It receives a path and optional sandbox context. If the context requires sandboxing, it returns an error; otherwise it asks the unsandboxed file system to open the file and returns the opened Tokio file.

**Call relations**: The higher-level open flow calls this when it needs a raw readable file handle. It hands the work to UnsandboxedFileSystem::open_file_for_read for the non-sandboxed case.

*Call graph*: calls 1 internal fn (open_file_for_read); called by 1 (open); 1 external calls (new).


##### `LocalFileSystem::canonicalize`  (lines 198–204)

```
fn canonicalize(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, PathUri>
```

**Purpose**: Turns a path into its canonical form, meaning the operating system's resolved absolute version. This removes ambiguity such as `.` components and followed links.

**Data flow**: It receives a path and optional sandbox context, picks the correct backend with file_system_for, sends the request there, and returns the resolved PathUri or an error.

**Call relations**: The ExecutorFileSystem implementation for LocalFileSystem boxes this async work so callers can use it through the shared file-system interface.

*Call graph*: calls 1 internal fn (file_system_for); called by 1 (canonicalize); 1 external calls (pin).


##### `LocalFileSystem::read_file`  (lines 206–212)

```
fn read_file(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>>
```

**Purpose**: Reads a whole file into memory, using either the sandboxed or unsandboxed route as appropriate.

**Data flow**: It receives a path and optional sandbox context, selects the backend, forwards the read request, and returns the file bytes or an error.

**Call relations**: The shared file-system interface calls into this method for LocalFileSystem read requests, and this method delegates the actual file access to the selected backend.

*Call graph*: calls 1 internal fn (file_system_for); called by 1 (read_file); 1 external calls (pin).


##### `LocalFileSystem::read_file_stream`  (lines 214–220)

```
fn read_file_stream(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream>
```

**Purpose**: Starts a chunk-by-chunk file read instead of loading the whole file at once. This is useful for larger files or callers that want streaming data.

**Data flow**: It receives a path and optional sandbox context, chooses the backend, asks it for a read stream, and returns that stream or an error.

**Call relations**: It follows the same routing pattern as the other LocalFileSystem operations, handing the stream creation to the selected file-system backend.

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

**Purpose**: Writes bytes to a file through the correct local route. It keeps callers from needing to know whether sandboxing applies.

**Data flow**: It receives a path, the bytes to write, and optional sandbox context. It selects the backend, passes the bytes along, and returns success or an error.

**Call relations**: The ExecutorFileSystem write path calls this, and this method forwards to the sandboxed or unsandboxed implementation chosen by file_system_for.

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

**Purpose**: Creates a directory, optionally including missing parent directories, through the correct backend.

**Data flow**: It receives a path, directory creation options, and optional sandbox context. It chooses the backend, forwards the request, and returns success or an error.

**Call relations**: The shared create-directory operation reaches this method first for LocalFileSystem, then the selected backend performs the operating-system work.

*Call graph*: calls 1 internal fn (file_system_for); called by 1 (create_directory); 1 external calls (pin).


##### `LocalFileSystem::get_metadata`  (lines 242–248)

```
fn get_metadata(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>
```

**Purpose**: Fetches basic facts about a file or folder, such as whether it is a file, directory, or symlink and how large it is.

**Data flow**: It receives a path and optional sandbox context, selects a backend, asks that backend for metadata, and returns the FileMetadata record or an error.

**Call relations**: The public metadata call on LocalFileSystem is boxed through the ExecutorFileSystem interface and lands here before being delegated.

*Call graph*: calls 1 internal fn (file_system_for); called by 1 (get_metadata); 1 external calls (pin).


##### `LocalFileSystem::read_directory`  (lines 250–256)

```
fn read_directory(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>>
```

**Purpose**: Lists the entries inside a directory through the correct backend.

**Data flow**: It receives a directory path and optional sandbox context, selects the backend, asks for the directory entries, and returns names plus simple type flags for each readable entry.

**Call relations**: The ExecutorFileSystem directory-listing call reaches this router, which then passes the request to the sandboxed or unsandboxed file system.

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

**Purpose**: Deletes a file or directory through the correct backend, following options such as recursive deletion and force.

**Data flow**: It receives a path, removal options, and optional sandbox context. It selects the backend, forwards the deletion request, and returns success or an error.

**Call relations**: The shared remove operation calls into this method, and this method delegates to the backend chosen by file_system_for.

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

**Purpose**: Copies a file, directory, or symlink through the correct backend. It hides the sandbox routing decision from callers.

**Data flow**: It receives source and destination paths, copy options, and optional sandbox context. It chooses the backend, forwards the copy request, and returns success or an error.

**Call relations**: The ExecutorFileSystem copy call for LocalFileSystem reaches this router, which then hands the operation to either the sandboxed or unsandboxed file system.

*Call graph*: calls 1 internal fn (file_system_for); called by 1 (copy); 1 external calls (pin).


##### `UnsandboxedFileSystem::open_file_for_read`  (lines 285–294)

```
async fn open_file_for_read(
        &self,
        path: &PathUri,
        sandbox: Option<&FileSystemSandboxContext>,
    ) -> FileSystemResult<tokio::fs::File>
```

**Purpose**: Opens a file for reading only if the request does not require platform sandboxing. It is a guardrail before direct file access.

**Data flow**: It receives a path and optional sandbox context, rejects contexts that require sandboxing, then asks DirectFileSystem to open the file with no sandbox context.

**Call relations**: LocalFileSystem::open_file_for_read calls this after it has decided that streaming reads must use the unsandboxed path.

*Call graph*: calls 2 internal fn (open_file_for_read, reject_platform_sandbox_context); called by 1 (open_file_for_read).


##### `UnsandboxedFileSystem::canonicalize`  (lines 401–407)

```
fn canonicalize(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, PathUri>
```

**Purpose**: Resolves a path using direct local access, but first rejects requests that should have been sandboxed.

**Data flow**: It receives a path and optional sandbox context, checks that platform sandboxing is not requested, forwards to DirectFileSystem::canonicalize, and returns the resolved path or error.

**Call relations**: It is used through the UnsandboxedFileSystem implementation of the shared file-system interface when a non-sandboxed canonicalize request is routed here.

*Call graph*: calls 2 internal fn (canonicalize, reject_platform_sandbox_context); 1 external calls (pin).


##### `UnsandboxedFileSystem::read_file`  (lines 409–415)

```
fn read_file(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>>
```

**Purpose**: Reads a whole file through direct local access after confirming the request is not supposed to run in a sandbox.

**Data flow**: It receives a path and optional sandbox context, rejects platform-sandboxed requests, forwards to DirectFileSystem::read_file, and returns the bytes or an error.

**Call relations**: When LocalFileSystem chooses the unsandboxed backend for a read, this wrapper enforces the no-platform-sandbox rule before direct reading happens.

*Call graph*: calls 2 internal fn (read_file, reject_platform_sandbox_context); 1 external calls (pin).


##### `UnsandboxedFileSystem::read_file_stream`  (lines 417–423)

```
fn read_file_stream(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream>
```

**Purpose**: Creates a streaming read from a file through direct local access, while refusing platform-sandboxed requests.

**Data flow**: It receives a path and optional sandbox context, checks the context, forwards to DirectFileSystem::read_file_stream, and returns a stream or error.

**Call relations**: It sits between LocalFileSystem's routing decision and DirectFileSystem's actual stream creation for unsandboxed reads.

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

**Purpose**: Writes a file directly, but only for requests that do not need platform sandboxing.

**Data flow**: It receives a path, bytes, and optional sandbox context. It rejects sandbox-required contexts, forwards the bytes to DirectFileSystem::write_file, and returns success or an error.

**Call relations**: LocalFileSystem can route write requests here for ordinary access; this method then hands the real write to DirectFileSystem.

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

**Purpose**: Creates a directory directly after confirming the request belongs outside the platform sandbox.

**Data flow**: It receives a path, creation options, and optional sandbox context. It rejects platform-sandboxed requests, forwards to DirectFileSystem::create_directory, and returns success or an error.

**Call relations**: This wrapper is the unsandboxed branch for directory creation before the direct operating-system call is made.

*Call graph*: calls 2 internal fn (create_directory, reject_platform_sandbox_context); 1 external calls (pin).


##### `UnsandboxedFileSystem::get_metadata`  (lines 447–453)

```
fn get_metadata(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>
```

**Purpose**: Reads file metadata directly while preventing accidental bypass of required sandboxing.

**Data flow**: It receives a path and optional sandbox context, rejects platform-sandboxed requests, forwards to DirectFileSystem::get_metadata, and returns the metadata or an error.

**Call relations**: It is the unsandboxed backend for metadata lookups selected by LocalFileSystem::file_system_for.

*Call graph*: calls 2 internal fn (get_metadata, reject_platform_sandbox_context); 1 external calls (pin).


##### `UnsandboxedFileSystem::read_directory`  (lines 455–461)

```
fn read_directory(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>>
```

**Purpose**: Lists a directory directly, but only when the request does not require platform sandboxing.

**Data flow**: It receives a path and optional sandbox context, validates that sandboxing is not required, forwards to DirectFileSystem::read_directory, and returns the entries or an error.

**Call relations**: LocalFileSystem routes ordinary directory-listing requests here, and this wrapper passes them to DirectFileSystem.

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

**Purpose**: Deletes a file or directory directly after checking that the operation is allowed to run outside the sandbox.

**Data flow**: It receives a path, removal options, and optional sandbox context. It rejects platform-sandboxed requests, forwards to DirectFileSystem::remove, and returns success or an error.

**Call relations**: It forms the unsandboxed branch for deletion requests before the direct file-system layer performs the removal.

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

**Purpose**: Copies files, directories, or symlinks directly while refusing requests that require sandboxing.

**Data flow**: It receives source and destination paths, copy options, and optional sandbox context. It checks the context, forwards the copy to DirectFileSystem::copy, and returns success or an error.

**Call relations**: When LocalFileSystem chooses the unsandboxed backend for copying, this method guards the route and then delegates the real copy work.

*Call graph*: calls 2 internal fn (copy, reject_platform_sandbox_context); 1 external calls (pin).


##### `DirectFileSystem::open_file_for_read`  (lines 490–498)

```
async fn open_file_for_read(
        &self,
        path: &PathUri,
        sandbox: Option<&FileSystemSandboxContext>,
    ) -> FileSystemResult<tokio::fs::File>
```

**Purpose**: Opens a regular file from the local disk for reading. It is the low-level entry point for direct read operations.

**Data flow**: It receives a PathUri and optional sandbox context. It rejects any sandbox context, converts the URI into an absolute local path, opens it as a regular file, and returns the file handle.

**Call relations**: DirectFileSystem::read_file and DirectFileSystem::read_file_stream call this so they share the same path conversion and regular-file check.

*Call graph*: calls 3 internal fn (reject_sandbox_context, open, to_abs_path); called by 3 (read_file, read_file_stream, open_file_for_read); 1 external calls (as_path).


##### `DirectFileSystem::canonicalize`  (lines 694–700)

```
fn canonicalize(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, PathUri>
```

**Purpose**: Asks the operating system for the fully resolved version of a path. This helps remove ambiguity caused by relative pieces or symlinks.

**Data flow**: It receives a PathUri and optional sandbox context, rejects sandbox use, converts to an absolute path, canonicalizes it with the operating system, converts it back to a PathUri, and returns it.

**Call relations**: UnsandboxedFileSystem::canonicalize delegates here after checking that the request is allowed to use direct access.

*Call graph*: calls 4 internal fn (reject_sandbox_context, from_absolute_path, from_abs_path, to_abs_path); called by 1 (canonicalize); 3 external calls (pin, canonicalize, as_path).


##### `DirectFileSystem::read_file`  (lines 702–708)

```
fn read_file(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>>
```

**Purpose**: Reads an entire local file into memory, with a fixed size limit to protect the server from very large reads.

**Data flow**: It opens the file, reads its metadata size, rejects it if it is over the limit, reads up to one byte beyond the limit as a second check, and returns the collected bytes.

**Call relations**: UnsandboxedFileSystem::read_file delegates here. This method uses DirectFileSystem::open_file_for_read and file_too_large_error for its safety checks.

*Call graph*: calls 2 internal fn (open_file_for_read, file_too_large_error); called by 1 (read_file); 2 external calls (pin, with_capacity).


##### `DirectFileSystem::read_file_stream`  (lines 710–716)

```
fn read_file_stream(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream>
```

**Purpose**: Turns a local file into a stream of byte chunks. This lets callers consume the file gradually instead of all at once.

**Data flow**: It opens the file, wraps it in a ReaderStream with the configured chunk size, and returns a FileSystemReadStream.

**Call relations**: UnsandboxedFileSystem::read_file_stream delegates here after sandbox checks. This method relies on DirectFileSystem::open_file_for_read for the actual file opening.

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

**Purpose**: Writes the given bytes to a local file path using direct operating-system access.

**Data flow**: It receives a path, byte contents, and optional sandbox context. It rejects sandbox context, converts the path to an absolute local path, writes the bytes, and returns success or the write error.

**Call relations**: UnsandboxedFileSystem::write_file calls this once it has confirmed the operation does not require platform sandboxing.

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

**Purpose**: Creates a local directory, either just the final directory or all missing parent directories depending on the options.

**Data flow**: It receives a path, creation options, and optional sandbox context. It rejects sandbox context, converts the path, chooses single-directory or recursive creation, and returns success or an error.

**Call relations**: UnsandboxedFileSystem::create_directory delegates here for the actual disk operation.

*Call graph*: calls 2 internal fn (reject_sandbox_context, to_abs_path); called by 1 (create_directory); 4 external calls (pin, create_dir, create_dir_all, as_path).


##### `DirectFileSystem::get_metadata`  (lines 738–744)

```
fn get_metadata(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>
```

**Purpose**: Collects simple facts about a local file-system item, including whether it is a file, folder, or symlink and its timestamps.

**Data flow**: It receives a path and optional sandbox context, rejects sandbox context, reads normal metadata and symlink metadata, builds a FileMetadata record, and returns it.

**Call relations**: UnsandboxedFileSystem::get_metadata calls this after its platform-sandbox guard. The timestamp fields use system_time_to_unix_ms to become millisecond numbers.

*Call graph*: calls 2 internal fn (reject_sandbox_context, to_abs_path); called by 1 (get_metadata); 4 external calls (pin, metadata, symlink_metadata, as_path).


##### `DirectFileSystem::read_directory`  (lines 746–752)

```
fn read_directory(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>>
```

**Purpose**: Lists the readable entries inside a local directory. Entries whose metadata cannot be read are skipped rather than failing the whole listing.

**Data flow**: It receives a path and optional sandbox context, rejects sandbox context, opens the directory, loops over entries, reads each entry's metadata when possible, and returns a list of names and type flags.

**Call relations**: UnsandboxedFileSystem::read_directory delegates here when LocalFileSystem has chosen ordinary local access.

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

**Purpose**: Deletes a local file or directory, following options for recursive deletion and ignoring missing paths when forced.

**Data flow**: It receives a path, removal options, and optional sandbox context. It rejects sandbox context, checks what kind of item exists, removes a file or directory appropriately, and returns success; if the path is missing and force is true, it also returns success.

**Call relations**: UnsandboxedFileSystem::remove calls this after rejecting platform-sandboxed requests.

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

**Purpose**: Copies a local file-system item. It supports regular files, directories when recursive copying is requested, and symlinks.

**Data flow**: It receives source and destination paths, copy options, and optional sandbox context. It rejects sandbox context, converts both paths, then runs the blocking copy work on a separate thread so the async runtime is not stalled. It returns success or a clear error.

**Call relations**: UnsandboxedFileSystem::copy delegates here. Inside the copy path, helper functions perform recursive directory copying, symlink copying, and checks that prevent copying a directory into itself.

*Call graph*: calls 2 internal fn (reject_sandbox_context, to_abs_path); called by 1 (copy); 2 external calls (pin, spawn_blocking).


##### `reject_sandbox_context`  (lines 780–788)

```
fn reject_sandbox_context(sandbox: Option<&FileSystemSandboxContext>) -> io::Result<()>
```

**Purpose**: Refuses any sandbox context for direct file-system operations. This keeps the lowest layer simple and prevents callers from thinking direct access is sandboxed.

**Data flow**: It receives an optional sandbox context. If one is present, it returns an input error; if none is present, it returns success.

**Call relations**: DirectFileSystem methods call this before touching the operating system directly.

*Call graph*: called by 8 (canonicalize, copy, create_directory, get_metadata, open_file_for_read, read_directory, remove, write_file); 1 external calls (new).


##### `reject_platform_sandbox_context`  (lines 790–798)

```
fn reject_platform_sandbox_context(sandbox: Option<&FileSystemSandboxContext>) -> io::Result<()>
```

**Purpose**: Refuses requests that say they must run in the platform sandbox. This prevents the unsandboxed wrapper from silently bypassing required isolation.

**Data flow**: It receives an optional sandbox context. If the context says sandboxing should run, it returns an error; otherwise it returns success.

**Call relations**: UnsandboxedFileSystem methods call this before delegating to DirectFileSystem.

*Call graph*: called by 10 (canonicalize, copy, create_directory, get_metadata, open_file_for_read, read_directory, read_file, read_file_stream, remove, write_file); 1 external calls (new).


##### `copy_dir_recursive`  (lines 800–817)

```
fn copy_dir_recursive(source: &Path, target: &Path) -> io::Result<()>
```

**Purpose**: Copies a directory tree by walking through every child item. It preserves regular files and symlinks while recreating folders at the destination.

**Data flow**: It receives a source directory and target directory, creates the target directory, reads each source entry, and copies each child according to whether it is a directory, file, or symlink.

**Call relations**: This helper is part of the directory-copy path used by DirectFileSystem::copy when recursive copying is allowed.

*Call graph*: calls 1 internal fn (copy_symlink); 4 external calls (join, copy, create_dir_all, read_dir).


##### `destination_is_same_or_descendant_of_source`  (lines 819–826)

```
fn destination_is_same_or_descendant_of_source(
    source: &Path,
    destination: &Path,
) -> io::Result<bool>
```

**Purpose**: Checks whether a directory copy would place the destination inside the source directory. That dangerous case is rejected because it can create endless self-copying.

**Data flow**: It receives source and destination paths, canonicalizes the source, resolves the existing portion of the destination, compares whether the destination starts with the source path, and returns true or false.

**Call relations**: DirectFileSystem::copy uses this check before recursive directory copying so it can stop invalid copy requests early.

*Call graph*: calls 1 internal fn (resolve_existing_path); 2 external calls (starts_with, canonicalize).


##### `resolve_existing_path`  (lines 828–847)

```
fn resolve_existing_path(path: &Path) -> io::Result<PathBuf>
```

**Purpose**: Resolves a path as much as possible even when the final file or folder does not exist yet. It canonicalizes the existing parent and then appends the not-yet-existing tail.

**Data flow**: It receives a path, walks upward collecting missing path pieces until it finds an existing path, canonicalizes that existing path, appends the missing pieces back, and returns the resolved path.

**Call relations**: current_sandbox_cwd and destination_is_same_or_descendant_of_source call this. A Unix test also checks that it handles symlink and `..` path escapes correctly.

*Call graph*: called by 3 (current_sandbox_cwd, destination_is_same_or_descendant_of_source, resolve_existing_path_handles_symlink_parent_dotdot_escape); 2 external calls (new, canonicalize).


##### `current_sandbox_cwd`  (lines 849–853)

```
fn current_sandbox_cwd() -> io::Result<PathBuf>
```

**Purpose**: Returns the current working directory in a resolved form suitable for sandbox decisions. This matters when the current directory may include symlinks or other path tricks.

**Data flow**: It reads the process's current directory, converts any read failure into a clearer error, resolves the path with resolve_existing_path, and returns the resolved PathBuf.

**Call relations**: The sandbox_cwd flow calls this when it needs the server's current directory for sandbox setup.

*Call graph*: calls 1 internal fn (resolve_existing_path); called by 1 (sandbox_cwd); 1 external calls (current_dir).


##### `copy_symlink`  (lines 855–878)

```
fn copy_symlink(source: &Path, target: &Path) -> io::Result<()>
```

**Purpose**: Copies a symlink as a symlink instead of copying the file or folder it points to. A symlink is a shortcut-like file-system entry.

**Data flow**: It receives source and target paths, reads the source link's target, and creates a new symlink at the destination. On Unix it uses the standard symlink call; on Windows it chooses a file or directory symlink; on unsupported platforms it returns an error.

**Call relations**: copy_dir_recursive calls this for symlink entries, and DirectFileSystem::copy uses the same behavior when the top-level source is a symlink.

*Call graph*: calls 1 internal fn (symlink_points_to_directory); called by 1 (copy_dir_recursive); 5 external calls (new, read_link, symlink, symlink_dir, symlink_file).


##### `symlink_points_to_directory`  (lines 881–887)

```
fn symlink_points_to_directory(source: &Path) -> io::Result<bool>
```

**Purpose**: On Windows, checks whether a symlink is marked as pointing to a directory. Windows needs this distinction when creating a replacement symlink.

**Data flow**: It receives a symlink path, reads symlink metadata without following the link, checks the directory-symlink flag, and returns true or false.

**Call relations**: copy_symlink calls this on Windows before deciding whether to create a directory symlink or a file symlink.

*Call graph*: called by 1 (copy_symlink); 1 external calls (symlink_metadata).


##### `system_time_to_unix_ms`  (lines 889–894)

```
fn system_time_to_unix_ms(time: SystemTime) -> i64
```

**Purpose**: Converts a system timestamp into milliseconds since the Unix epoch, which is the common time count starting at January 1, 1970.

**Data flow**: It receives a SystemTime, measures its duration since the Unix epoch, converts that duration to a 64-bit millisecond number if possible, and returns 0 if the conversion cannot be made.

**Call relations**: DirectFileSystem::get_metadata uses this when filling creation and modification times in FileMetadata.

*Call graph*: 1 external calls (duration_since).


##### `tests::resolve_existing_path_handles_symlink_parent_dotdot_escape`  (lines 907–928)

```
fn resolve_existing_path_handles_symlink_parent_dotdot_escape() -> io::Result<()>
```

**Purpose**: Tests that resolve_existing_path correctly handles a path that goes through a symlink and then uses `..` to move upward. This protects path resolution behavior that matters for sandbox safety.

**Data flow**: It creates temporary allowed and outside folders, adds a symlink from the allowed folder to the outside folder, resolves a tricky path through that link and parent reference, and checks that the result matches the expected resolved location.

**Call relations**: This test directly exercises resolve_existing_path and documents an important edge case involving symlink parents.

*Call graph*: calls 1 internal fn (resolve_existing_path); 4 external calls (assert_eq!, create_dir_all, symlink, new).


##### `tests::symlink_points_to_directory_handles_dangling_directory_symlinks`  (lines 937–953)

```
fn symlink_points_to_directory_handles_dangling_directory_symlinks() -> io::Result<()>
```

**Purpose**: On Windows, tests that a directory symlink is still recognized as a directory symlink even after its target directory is removed. This matters for copying dangling symlinks.

**Data flow**: It creates a temporary directory and a directory symlink to it, removes the target directory, calls symlink_points_to_directory on the symlink, and checks that the answer is still true.

**Call relations**: This test directly supports the Windows branch of copy_symlink, which needs to know what kind of symlink to recreate.

*Call graph*: 4 external calls (assert_eq!, create_dir, remove_dir, new).


### `exec-server/src/remote_file_system.rs`

`io_transport` · `request handling`

This file is the bridge between local-looking file operations and a file system that actually lives behind a remote exec server. Without it, code that wants to read or write files would need to know the remote protocol details itself, including how to package paths, sandbox rules, file bytes, and errors.

The main type, `RemoteFileSystem`, holds a lazily created remote client. “Lazy” means the connection is only fetched when an operation needs it, like only calling a courier when you actually have a package to send. Each file operation gets that client, builds the matching protocol request, sends it, and converts the remote reply back into the project’s normal file-system types.

File contents are sent as Base64 text, which is a safe way to carry raw bytes through a text-based protocol. Metadata and directory entries are translated from protocol shapes into local structs. Sandbox context is copied and cleaned before sending, so the remote side receives only the working-directory information it truly needs. Remote server failures are also translated into ordinary `io::Error` kinds, such as “not found,” “invalid input,” or “broken pipe,” so callers can react in the usual Rust file-I/O way.

One important limitation is that streaming reads do not support platform sandboxing here; the file rejects that combination instead of pretending it is safe.

#### Function details

##### `RemoteFileSystem::new`  (lines 39–42)

```
fn new(client: LazyRemoteExecServerClient) -> Self
```

**Purpose**: Creates a `RemoteFileSystem` around a remote exec-server client. Callers use it when they want the standard executor file-system interface to operate through a remote server instead of directly on local disk.

**Data flow**: It receives a lazy remote client, records a trace message for debugging, and stores the client inside a new `RemoteFileSystem`. The result is a ready-to-use remote file-system adapter.

**Call relations**: Setup code such as `remote_with_transport` calls this when wiring a remote transport into the executor. Tests that check path and sandbox URI behavior also create this object so later file operations can travel through the remote protocol.

*Call graph*: called by 2 (remote_with_transport, remote_file_system_sends_path_and_sandbox_cwd_uris_without_native_conversion); 1 external calls (trace!).


##### `RemoteFileSystem::canonicalize`  (lines 229–235)

```
fn canonicalize(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, PathUri>
```

**Purpose**: Asks the remote server to turn a path into its canonical, cleaned-up form. This is used when the rest of the system needs the remote side’s real view of a path, not a local guess.

**Data flow**: It takes a path and optional sandbox rules, gets the remote client, cleans the sandbox context with `remote_sandbox_context`, sends a canonicalize request, and returns the path from the server’s response. If the client or server reports an error, that error is converted into a normal I/O error.

**Call relations**: When executor code calls the file-system trait’s canonicalize operation, this method is the remote implementation. It relies on the lazy client for transport and on `remote_sandbox_context` so sandbox information is sent in the right remote-friendly form.

*Call graph*: calls 2 internal fn (get, remote_sandbox_context); 3 external calls (pin, trace!, clone).


##### `RemoteFileSystem::read_file`  (lines 237–243)

```
fn read_file(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>>
```

**Purpose**: Reads an entire remote file into memory as bytes. It lets callers treat a remote file read like an ordinary file read.

**Data flow**: It receives a path and optional sandbox context, gets the remote client, sends a read-file request, and receives file contents encoded as Base64 text. It decodes that text back into raw bytes and returns them; invalid Base64 becomes an invalid-data I/O error.

**Call relations**: This is used through the executor file-system interface when a caller wants the full file at once. It hands sandbox cleanup to `remote_sandbox_context` and depends on the remote client to perform the actual read.

*Call graph*: calls 2 internal fn (get, remote_sandbox_context); 3 external calls (pin, trace!, clone).


##### `RemoteFileSystem::read_file_stream`  (lines 245–251)

```
fn read_file_stream(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream>
```

**Purpose**: Opens a remote file for streaming reads, so callers can consume it gradually instead of loading it all at once. It refuses sandboxed streaming when the sandbox requires platform enforcement, because that combination is not supported here.

**Data flow**: It checks the optional sandbox first. If the sandbox says the operation must run in a platform sandbox, it returns an unsupported-operation error. Otherwise it gets the remote client, prepares the cleaned sandbox context, and asks `file_stream::open` to create the read stream.

**Call relations**: The executor file-system trait calls this when a streaming read is requested. This method is the gatekeeper for the unsupported sandbox case, then delegates the stream-specific remote protocol work to the file stream module.

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

**Purpose**: Writes bytes to a file on the remote side. It hides the protocol detail that raw bytes must be encoded before being sent.

**Data flow**: It takes a path, a byte vector, and optional sandbox rules. It gets the remote client, Base64-encodes the bytes into text, sends a write-file request, and returns success when the server accepts it. Remote failures become ordinary I/O errors.

**Call relations**: This is called through the executor file-system interface when higher-level code wants to save file contents remotely. It uses `remote_sandbox_context` before handing the request to the remote client.

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

**Purpose**: Creates a directory on the remote file system. It also carries the caller’s choice about whether missing parent folders should be created automatically.

**Data flow**: It receives a path, directory-creation options, and optional sandbox context. It gets the remote client, sends the path plus the recursive option to the server, and returns success or a mapped I/O error.

**Call relations**: Executor file-system users reach this method when they request directory creation against a remote backend. The method prepares the request and depends on the remote server to do the actual disk change.

*Call graph*: calls 2 internal fn (get, remote_sandbox_context); 3 external calls (pin, trace!, clone).


##### `RemoteFileSystem::get_metadata`  (lines 273–279)

```
fn get_metadata(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>
```

**Purpose**: Fetches basic facts about a remote path, such as whether it is a file, directory, or symbolic link, and its size and timestamps. Callers use this before deciding how to treat a path.

**Data flow**: It takes a path and optional sandbox rules, obtains the remote client, sends a metadata request, and converts the protocol response into the local `FileMetadata` shape. The returned object contains only the normalized metadata fields the rest of the executor expects.

**Call relations**: This sits behind the executor file-system trait’s metadata operation. It uses `remote_sandbox_context` for safe request preparation and translates the remote response so higher layers do not need to know the protocol format.

*Call graph*: calls 2 internal fn (get, remote_sandbox_context); 3 external calls (pin, trace!, clone).


##### `RemoteFileSystem::read_directory`  (lines 281–287)

```
fn read_directory(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>>
```

**Purpose**: Lists the entries inside a remote directory. It gives callers a simple list of names and basic file-versus-directory information.

**Data flow**: It receives a directory path and optional sandbox context, gets the remote client, and sends a read-directory request. It then maps each protocol entry into a local `ReadDirectoryEntry` and returns the collected list.

**Call relations**: This method is used when the executor file-system interface needs a directory listing from the remote backend. It performs the remote call, then reshapes the result for code that expects the project’s common file-system types.

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

**Purpose**: Deletes a file or directory on the remote side. It carries options such as recursive deletion and force deletion so callers can request the same behavior they would expect from local file operations.

**Data flow**: It takes the target path, remove options, and optional sandbox rules. It gets the remote client, sends a remove request with the recursive and force flags, and returns success if the server completes the deletion.

**Call relations**: Higher-level executor code reaches this through the file-system trait when it wants to delete something remotely. This method packages the deletion request and lets the remote server perform the actual filesystem change.

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

**Purpose**: Copies a file or directory from one remote path to another. It includes the recursive option for directory copies.

**Data flow**: It receives a source path, destination path, copy options, and optional sandbox context. It gets the remote client, sends a copy request with both paths and the recursive flag, and returns success or a mapped I/O error.

**Call relations**: This is the remote implementation of the executor file-system copy operation. It uses `remote_sandbox_context` to prepare sandbox data, then hands the actual copy command to the remote client.

*Call graph*: calls 2 internal fn (get, remote_sandbox_context); 3 external calls (pin, trace!, clone).


##### `remote_sandbox_context`  (lines 315–321)

```
fn remote_sandbox_context(
    sandbox: Option<&FileSystemSandboxContext>,
) -> Option<FileSystemSandboxContext>
```

**Purpose**: Prepares sandbox information before it is sent to the remote server. It removes the current working directory from the sandbox context when that directory is not needed, avoiding unnecessary or misleading path information.

**Data flow**: It receives an optional reference to a sandbox context. If there is no sandbox, it returns `None`; if there is one, it clones it, drops the current working directory when it is unused, and returns the cleaned copy.

**Call relations**: Every remote file operation calls this before sending sandbox data. The unit tests exercise both important cases: dropping an unused working directory and preserving one that sandbox rules still depend on.

*Call graph*: called by 11 (canonicalize, copy, create_directory, get_metadata, read_directory, read_file, read_file_stream, remove, write_file, remote_sandbox_context_drops_unused_cwd (+1 more)).


##### `map_remote_error`  (lines 323–337)

```
fn map_remote_error(error: ExecServerError) -> io::Error
```

**Purpose**: Converts exec-server errors into standard Rust I/O errors. This matters because callers of a file system expect familiar categories like “not found” or “invalid input,” not remote protocol error codes.

**Data flow**: It receives an `ExecServerError`. Server “not found” errors become `io::ErrorKind::NotFound`, invalid request errors become `InvalidInput`, closed or disconnected transports become `BrokenPipe`, and other failures become a general I/O error with the available message.

**Call relations**: Remote file operations use this whenever getting the client or awaiting a remote request fails. The transport-error test checks the important case where a closed or disconnected connection is reported as a broken pipe.

*Call graph*: 3 external calls (new, other, to_string).


##### `tests::remote_sandbox_context_drops_unused_cwd`  (lines 359–377)

```
fn remote_sandbox_context_drops_unused_cwd()
```

**Purpose**: Checks that sandbox cleanup removes the current working directory when the permissions do not need it. This prevents remote requests from carrying extra local path context for no reason.

**Data flow**: The test builds a restricted file-system policy that points at a concrete path, creates a sandbox context with a current working directory, runs `remote_sandbox_context`, and checks that the resulting context has no current working directory.

**Call relations**: The test harness calls this during automated tests. It directly exercises `remote_sandbox_context` and uses permission-profile helpers to create a realistic sandbox input.

*Call graph*: calls 4 internal fn (remote_sandbox_context, from_permission_profile_with_cwd, from_runtime_permissions, restricted); 3 external calls (assert_eq!, path_uri, vec!).


##### `tests::remote_sandbox_context_preserves_required_cwd`  (lines 380–397)

```
fn remote_sandbox_context_preserves_required_cwd()
```

**Purpose**: Checks that sandbox cleanup keeps the current working directory when sandbox rules depend on project-root special paths. This protects remote sandbox behavior from losing context it still needs.

**Data flow**: The test builds a policy using a special project-roots path, creates a sandbox context with a current working directory, runs `remote_sandbox_context`, and confirms that the same working directory is still present afterward.

**Call relations**: The test harness runs this alongside the other sandbox cleanup test. Together, they show that `remote_sandbox_context` is selective: it drops unused context but keeps required context.

*Call graph*: calls 4 internal fn (remote_sandbox_context, from_permission_profile_with_cwd, from_runtime_permissions, restricted); 3 external calls (assert_eq!, path_uri, vec!).


##### `tests::transport_errors_map_to_broken_pipe`  (lines 400–427)

```
fn transport_errors_map_to_broken_pipe()
```

**Purpose**: Verifies that closed and disconnected remote transports are reported as a broken pipe. A broken pipe is the standard I/O way to say the communication channel is no longer usable.

**Data flow**: The test creates two transport-related exec-server errors, maps each one with `map_remote_error`, collects the resulting error kind and message, and compares them with the expected broken-pipe results.

**Call relations**: The test harness calls this during automated tests. It protects the behavior that remote file operations rely on when their underlying connection disappears.

*Call graph*: 2 external calls (assert_eq!, Disconnected).


##### `tests::absolute_test_path`  (lines 429–432)

```
fn absolute_test_path(name: &str) -> AbsolutePathBuf
```

**Purpose**: Builds an absolute temporary path for tests. It gives the tests a valid absolute path without hard-coding a machine-specific location.

**Data flow**: It takes a simple name, appends it to the operating system’s temporary directory, converts that path into the project’s absolute-path type, and returns it.

**Call relations**: Test helper code calls this when constructing path values for sandbox and URI tests. `tests::path_uri` builds on it to make `PathUri` values.

*Call graph*: calls 1 internal fn (from_absolute_path); 1 external calls (temp_dir).


##### `tests::path_uri`  (lines 434–436)

```
fn path_uri(name: &str) -> PathUri
```

**Purpose**: Creates a `PathUri` test value from a simple name. A `PathUri` is the project’s URI-style representation of a file path.

**Data flow**: It receives a name, turns it into an absolute test path using `tests::absolute_test_path`, converts that absolute path into a `PathUri`, and returns the URI.

**Call relations**: The sandbox-context tests call this helper when they need current-working-directory paths expressed in the same URI form used by remote file-system requests.

*Call graph*: calls 1 internal fn (from_abs_path); 1 external calls (absolute_test_path).
