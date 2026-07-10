# apply-patch executable integration tests  `stage-23.3.1`

This stage is the final “does the real program behave correctly?” check for the standalone apply-patch command-line tool. It sits around the program from the outside, like a user would, instead of inspecting its inside parts. The goal is to prove that the compiled executable can be launched, given patch text, and trusted to make the right changes on disk.

all.rs is the entry door for these integration tests: it builds one test binary and hands work to the shared suite. suite/mod.rs is the organizer. It groups the tests by topic and skips some platform-specific cases on Windows when needed.

cli.rs checks the basic ways a person can run the tool, including passing input as command-line arguments or through standard input, the text stream a program reads from the terminal or a pipe. tool.rs goes deeper into edge cases: bad patch syntax, missing files, overwrite rules, renames, and what happens if only part of a patch can be applied. scenarios.rs runs full end-to-end examples by copying sample folders, applying patches, and comparing the final folder contents to the expected result.

## Files in this stage

### Test suite entrypoints
These files define the integration-test binary and assemble the shared suite modules that the executable-facing tests run through.

### `apply-patch/tests/all.rs`

`test` · `test run`

This file is the root of the integration test target under `tests/`. Its only job is to include the `suite` module, causing Rust’s test harness to compile one integration-test binary that aggregates all test modules located under `tests/suite/`. The comment explains the intent explicitly: instead of many separate integration binaries, the project centralizes them behind this one entry file. That choice can reduce compile duplication and make shared fixtures or helper visibility simpler across test modules. There is no executable logic or test case in this file itself; its significance is in how Cargo discovers and builds integration tests. By naming `mod suite;`, it establishes the module tree root from which the actual scenario, CLI, and platform-specific tool tests are pulled in.


### `apply-patch/tests/suite/mod.rs`

`test` · `test run`

This module is the internal index for the integration test suite included by `tests/all.rs`. It declares three child modules: `cli`, `scenarios`, and `tool`, with `tool` compiled only when the target OS is not Windows. That conditional compilation is the key behavior in this file: it prevents platform-incompatible tests from being built or run on Windows while still keeping them part of the suite on supported systems. The file itself contains no test logic, fixtures, or helpers; instead, it defines the suite’s structure and platform split. `cli` likely groups command-line behavior tests, `scenarios` groups broader end-to-end cases, and `tool` covers functionality unavailable or unsupported on Windows. As the suite root, this file determines which test modules participate in the single integration-test binary and under what target conditions.


### CLI invocation coverage
These tests exercise direct command-line usage of the apply_patch executable, from basic invocation modes to broader user-visible success and failure behavior.

### `apply-patch/tests/suite/cli.rs`

`test` · `integration test execution`

This test file drives the built `apply_patch` binary with `assert_cmd`. The helper `apply_patch_command` resolves the executable path via `codex_utils_cargo_bin::cargo_bin("apply_patch")` and returns a configured `Command`. Each test creates an isolated temporary directory, runs the binary with that directory as `current_dir`, and then inspects both process output and resulting filesystem contents.

`test_apply_patch_cli_add_and_update` exercises the normal argument-based invocation path. It first sends an add-file patch, expects a successful exit and exact stdout summary `A <file>`, then reads the created file to confirm the newline-terminated contents. It follows with an update-file patch against the same file and expects `M <file>` plus the modified contents.

`test_apply_patch_cli_stdin_add_and_update` repeats the same scenario but supplies the patch text through stdin using `write_stdin` instead of a command-line argument. Together these tests prove that the standalone executable’s input-source selection works in both supported modes and that the user-visible success summaries match the actual filesystem changes.

#### Function details

##### `apply_patch_command`  (lines 5–9)

```
fn apply_patch_command() -> anyhow::Result<Command>
```

**Purpose**: Builds an `assert_cmd::Command` targeting the compiled `apply_patch` binary.

**Data flow**: It resolves the binary path with `cargo_bin("apply_patch")`, constructs `Command::new(...)`, and returns it wrapped in `anyhow::Result`.

**Call relations**: This helper is shared by both CLI integration tests so they can focus on patch payloads and assertions rather than binary lookup boilerplate.

*Call graph*: called by 2 (test_apply_patch_cli_add_and_update, test_apply_patch_cli_stdin_add_and_update); 2 external calls (new, cargo_bin).


##### `test_apply_patch_cli_add_and_update`  (lines 12–50)

```
fn test_apply_patch_cli_add_and_update() -> anyhow::Result<()>
```

**Purpose**: Verifies that the CLI can add a file and then update it when the patch is passed as a positional argument.

**Data flow**: It creates a temp directory, formats add and update patch strings, runs the binary twice with `.arg(...)` and `.current_dir(...)`, asserts success and exact stdout summaries, and reads the target file after each run to confirm contents.

**Call relations**: This test invokes `apply_patch_command` for both subprocesses and exercises the executable’s argument-based input path end to end.

*Call graph*: calls 1 internal fn (apply_patch_command); 3 external calls (assert_eq!, format!, tempdir).


##### `test_apply_patch_cli_stdin_add_and_update`  (lines 53–91)

```
fn test_apply_patch_cli_stdin_add_and_update() -> anyhow::Result<()>
```

**Purpose**: Verifies the same add-then-update workflow when the patch is supplied on stdin instead of argv.

**Data flow**: It creates a temp directory, formats add and update patch strings, runs the binary twice with `.write_stdin(...)`, asserts success and exact stdout summaries, and reads the file after each run to confirm the applied changes.

**Call relations**: This test also uses `apply_patch_command`, but specifically covers the stdin-reading branch in the standalone executable.

*Call graph*: calls 1 internal fn (apply_patch_command); 3 external calls (assert_eq!, format!, tempdir).


### `apply-patch/tests/suite/tool.rs`

`test` · `integration test execution`

This file is the main black-box test suite for the `apply_patch` tool. Two helpers construct subprocess commands: `run_apply_patch_in_dir` immediately returns an `Assert` for success-oriented tests, while `apply_patch_command` returns a mutable `Command` for tests that need to configure stdin/args and inspect failures. `resolved_under` canonicalizes the temp root and joins a relative path so expected stderr messages use the same absolute paths the tool reports.

The tests cover multi-operation patches (add, modify, delete in one run), multiple update chunks in one file, moving a file into a newly created directory, and appending a trailing newline when updating a file that lacked one. They also verify overwrite semantics: add-file replaces an existing file, and move/update overwrites an existing destination. Failure-path tests assert exact stderr for empty patches, missing update context, deleting a nonexistent file, updating a nonexistent file, deleting a directory as though it were a file, invalid hunk headers, and parser-detected empty update hunks.

One especially important scenario confirms non-transactional behavior: if an earlier hunk succeeds and a later hunk fails, the earlier filesystem change remains in place. Across the suite, each test uses a fresh temporary directory, writes only the minimal fixture files needed, runs the compiled binary from that directory, and then checks both process output and resulting filesystem state.

#### Function details

##### `run_apply_patch_in_dir`  (lines 8–12)

```
fn run_apply_patch_in_dir(dir: &Path, patch: &str) -> anyhow::Result<assert_cmd::assert::Assert>
```

**Purpose**: Creates and runs an `apply_patch` subprocess in a given directory, returning the assertion handle for fluent success checks.

**Data flow**: It takes a working directory and patch string, resolves the binary path with `cargo_bin`, constructs an `assert_cmd::Command`, sets `.current_dir(dir)`, adds the patch argument, calls `.assert()`, and returns the resulting `Assert` in `anyhow::Result`.

**Call relations**: This helper is used by tests that expect successful execution and want concise chaining of `.success()` and `.stdout(...)` assertions.

*Call graph*: called by 6 (test_apply_patch_cli_add_overwrites_existing_file, test_apply_patch_cli_applies_multiple_chunks, test_apply_patch_cli_applies_multiple_operations, test_apply_patch_cli_move_overwrites_existing_destination, test_apply_patch_cli_moves_file_to_new_directory, test_apply_patch_cli_updates_file_appends_trailing_newline); 2 external calls (new, cargo_bin).


##### `apply_patch_command`  (lines 14–18)

```
fn apply_patch_command(dir: &Path) -> anyhow::Result<Command>
```

**Purpose**: Builds a configured `Command` for the `apply_patch` binary in a chosen working directory without executing it yet.

**Data flow**: It resolves the binary path, constructs `Command::new(...)`, sets the current directory, and returns the command object for further customization by the caller.

**Call relations**: This helper is used by failure-oriented tests that need to add arguments and then inspect `.failure()`, `.stderr(...)`, or other subprocess assertions.

*Call graph*: called by 8 (test_apply_patch_cli_delete_directory_fails, test_apply_patch_cli_failure_after_partial_success_leaves_changes, test_apply_patch_cli_rejects_empty_patch, test_apply_patch_cli_rejects_empty_update_hunk, test_apply_patch_cli_rejects_invalid_hunk_header, test_apply_patch_cli_rejects_missing_file_delete, test_apply_patch_cli_reports_missing_context, test_apply_patch_cli_requires_existing_file_for_update); 2 external calls (new, cargo_bin).


##### `resolved_under`  (lines 20–22)

```
fn resolved_under(root: &Path, path: &str) -> anyhow::Result<PathBuf>
```

**Purpose**: Constructs the absolute path string shape expected in CLI error messages for a path under a temporary root.

**Data flow**: It canonicalizes the `root` directory and joins the provided relative `path`, returning the resulting `PathBuf`.

**Call relations**: Several tests call this helper before asserting stderr so their expected messages match the tool’s resolved absolute-path reporting.

*Call graph*: called by 5 (test_apply_patch_cli_delete_directory_fails, test_apply_patch_cli_failure_after_partial_success_leaves_changes, test_apply_patch_cli_rejects_missing_file_delete, test_apply_patch_cli_reports_missing_context, test_apply_patch_cli_requires_existing_file_for_update); 1 external calls (canonicalize).


##### `test_apply_patch_cli_applies_multiple_operations`  (lines 25–45)

```
fn test_apply_patch_cli_applies_multiple_operations() -> anyhow::Result<()>
```

**Purpose**: Verifies one patch can add a file, modify another, and delete a third in a single successful run.

**Data flow**: It creates a temp directory, writes initial files for modify/delete targets, runs a combined patch through `run_apply_patch_in_dir`, asserts exact success stdout, then reads the added and modified files and checks that the deleted file no longer exists.

**Call relations**: This test exercises the happy-path orchestration of multiple hunk types in one invocation.

*Call graph*: calls 1 internal fn (run_apply_patch_in_dir); 4 external calls (assert!, assert_eq!, write, tempdir).


##### `test_apply_patch_cli_applies_multiple_chunks`  (lines 48–65)

```
fn test_apply_patch_cli_applies_multiple_chunks() -> anyhow::Result<()>
```

**Purpose**: Checks that a single update hunk with multiple `@@` chunks modifies separate regions of the same file correctly.

**Data flow**: It writes a four-line file, runs an update patch containing two chunks, asserts success output, and reads the file back to confirm both replacements were applied in order.

**Call relations**: This test validates end-to-end handling of multi-chunk update hunks after parsing and matching.

*Call graph*: calls 1 internal fn (run_apply_patch_in_dir); 3 external calls (assert_eq!, write, tempdir).


##### `test_apply_patch_cli_moves_file_to_new_directory`  (lines 68–85)

```
fn test_apply_patch_cli_moves_file_to_new_directory() -> anyhow::Result<()>
```

**Purpose**: Verifies that an update hunk with `*** Move to:` renames a file into a previously nonexistent directory while applying content changes.

**Data flow**: It creates the original file and parent directory, runs a move/update patch, asserts success output naming the destination path, then checks that the source path is gone and the destination file contains updated contents.

**Call relations**: This test covers the interaction between rename semantics and file-content replacement in the CLI tool.

*Call graph*: calls 1 internal fn (run_apply_patch_in_dir); 5 external calls (assert!, assert_eq!, create_dir_all, write, tempdir).


##### `test_apply_patch_cli_rejects_empty_patch`  (lines 88–98)

```
fn test_apply_patch_cli_rejects_empty_patch() -> anyhow::Result<()>
```

**Purpose**: Ensures a syntactically valid patch with no hunks is treated as a failure because it changes no files.

**Data flow**: It creates a temp directory, runs the binary with a patch containing only begin/end markers, and asserts process failure with stderr `No files were modified.`.

**Call relations**: This test checks a higher-level application rule beyond parsing: empty hunk lists are not considered successful work.

*Call graph*: calls 1 internal fn (apply_patch_command); 1 external calls (tempdir).


##### `test_apply_patch_cli_reports_missing_context`  (lines 101–118)

```
fn test_apply_patch_cli_reports_missing_context() -> anyhow::Result<()>
```

**Purpose**: Verifies that an update fails with a precise error when the expected old lines cannot be found in the target file.

**Data flow**: It writes a file with known contents, computes the expected absolute path via `resolved_under`, runs an update patch whose `-missing` line does not exist, asserts failure and exact stderr, and confirms the file contents remain unchanged.

**Call relations**: This test exercises the patch-application matching path that ultimately depends on sequence search and replacement computation.

*Call graph*: calls 2 internal fn (apply_patch_command, resolved_under); 4 external calls (assert_eq!, format!, write, tempdir).


##### `test_apply_patch_cli_rejects_missing_file_delete`  (lines 121–135)

```
fn test_apply_patch_cli_rejects_missing_file_delete() -> anyhow::Result<()>
```

**Purpose**: Ensures deleting a nonexistent file fails with the reported absolute path.

**Data flow**: It computes the expected missing path, runs a delete-file patch against that path in an empty temp directory, and asserts failure with exact stderr.

**Call relations**: This test covers filesystem error reporting for delete hunks.

*Call graph*: calls 2 internal fn (apply_patch_command, resolved_under); 2 external calls (format!, tempdir).


##### `test_apply_patch_cli_rejects_empty_update_hunk`  (lines 138–148)

```
fn test_apply_patch_cli_rejects_empty_update_hunk() -> anyhow::Result<()>
```

**Purpose**: Checks that parser validation errors for empty update hunks are surfaced through the CLI unchanged.

**Data flow**: It runs a patch containing `*** Update File: foo.txt` immediately followed by `*** End Patch` and asserts failure with the exact parser-generated stderr message including line number 2.

**Call relations**: This test links parser diagnostics from `ParseError::InvalidHunkError` to the executable’s user-facing error output.

*Call graph*: calls 1 internal fn (apply_patch_command); 1 external calls (tempdir).


##### `test_apply_patch_cli_requires_existing_file_for_update`  (lines 151–165)

```
fn test_apply_patch_cli_requires_existing_file_for_update() -> anyhow::Result<()>
```

**Purpose**: Ensures update hunks fail when the target file does not exist.

**Data flow**: It computes the expected absolute missing path, runs an update patch against that path in an empty temp directory, and asserts failure with the exact read-file error message.

**Call relations**: This test covers the filesystem read step that occurs after parsing but before replacement application.

*Call graph*: calls 2 internal fn (apply_patch_command, resolved_under); 2 external calls (format!, tempdir).


##### `test_apply_patch_cli_move_overwrites_existing_destination`  (lines 168–188)

```
fn test_apply_patch_cli_move_overwrites_existing_destination() -> anyhow::Result<()>
```

**Purpose**: Verifies that moving/updating a file replaces an already existing destination file rather than failing.

**Data flow**: It creates both source and destination files, runs a move/update patch, asserts success output, then checks that the source was removed and the destination now contains the new content.

**Call relations**: This test documents overwrite semantics for rename operations in the tool.

*Call graph*: calls 1 internal fn (run_apply_patch_in_dir); 5 external calls (assert!, assert_eq!, create_dir_all, write, tempdir).


##### `test_apply_patch_cli_add_overwrites_existing_file`  (lines 191–206)

```
fn test_apply_patch_cli_add_overwrites_existing_file() -> anyhow::Result<()>
```

**Purpose**: Verifies that an add-file hunk replaces an existing file’s contents instead of rejecting the operation.

**Data flow**: It writes an initial file, runs an add-file patch targeting the same path, asserts success output, and reads the file back to confirm it now contains the new content.

**Call relations**: This test captures the tool’s non-strict add semantics when the destination already exists.

*Call graph*: calls 1 internal fn (run_apply_patch_in_dir); 3 external calls (assert_eq!, write, tempdir).


##### `test_apply_patch_cli_delete_directory_fails`  (lines 209–225)

```
fn test_apply_patch_cli_delete_directory_fails() -> anyhow::Result<()>
```

**Purpose**: Ensures a delete-file hunk does not silently remove directories and instead reports failure.

**Data flow**: It creates a directory, computes its resolved absolute path, runs a delete-file patch against that directory path, and asserts failure with exact stderr.

**Call relations**: This test covers type-mismatch handling in filesystem deletion logic.

*Call graph*: calls 2 internal fn (apply_patch_command, resolved_under); 3 external calls (format!, create_dir, tempdir).


##### `test_apply_patch_cli_rejects_invalid_hunk_header`  (lines 228–238)

```
fn test_apply_patch_cli_rejects_invalid_hunk_header() -> anyhow::Result<()>
```

**Purpose**: Checks that malformed patch headers are rejected with the parser’s exact diagnostic text.

**Data flow**: It runs a patch containing `*** Frobnicate File: foo` and asserts process failure with the expected invalid-header stderr message.

**Call relations**: This test validates propagation of parser header-validation errors through the CLI.

*Call graph*: calls 1 internal fn (apply_patch_command); 1 external calls (tempdir).


##### `test_apply_patch_cli_updates_file_appends_trailing_newline`  (lines 241–258)

```
fn test_apply_patch_cli_updates_file_appends_trailing_newline() -> anyhow::Result<()>
```

**Purpose**: Verifies that updating a file without a trailing newline produces newline-terminated output.

**Data flow**: It writes a file lacking a final newline, runs an update patch replacing it with two added lines, asserts success output, reads the file back, and checks both that it ends with `\n` and that the full contents match the expected two-line text.

**Call relations**: This test documents output normalization behavior of the patch application layer for rewritten files.

*Call graph*: calls 1 internal fn (run_apply_patch_in_dir); 5 external calls (assert!, assert_eq!, read_to_string, write, tempdir).


##### `test_apply_patch_cli_failure_after_partial_success_leaves_changes`  (lines 261–279)

```
fn test_apply_patch_cli_failure_after_partial_success_leaves_changes() -> anyhow::Result<()>
```

**Purpose**: Confirms that apply-patch is not transactional: earlier successful hunks remain applied even if a later hunk fails.

**Data flow**: It runs a patch that first adds `created.txt` and then attempts to update a missing file, asserts overall failure with the missing-file stderr and no stdout, and finally reads `created.txt` to confirm the first hunk’s effect persisted.

**Call relations**: This test captures an important operational invariant for callers: patch application proceeds hunk by hunk and does not roll back prior filesystem changes on later failure.

*Call graph*: calls 2 internal fn (apply_patch_command, resolved_under); 3 external calls (assert_eq!, format!, tempdir).


### Fixture-driven scenarios
This scenario suite applies patches to copied fixture trees and verifies final filesystem snapshots for end-to-end regression coverage.

### `apply-patch/tests/suite/scenarios.rs`

`test` · `integration test execution`

This integration test file treats each scenario directory under `tests/fixtures/scenarios` as a declarative test case. `test_apply_patch_scenarios` locates that fixture root from the repository root and iterates over each child directory, invoking `run_apply_patch_scenario` for every scenario.

A scenario consists of optional `input/`, required `patch.txt`, and required `expected/`. `run_apply_patch_scenario` creates a temporary workspace, recursively copies the input tree into it, reads the patch text, runs the compiled `apply_patch` binary in that workspace, and intentionally ignores the subprocess exit status. Instead, correctness is defined solely by final filesystem state: it snapshots both the expected tree and the actual temp directory into `BTreeMap<PathBuf, Entry>` values and compares them with `pretty_assertions::assert_eq!`.

The snapshot logic records directories as `Entry::Dir` and files as `Entry::File(Vec<u8>)`, preserving exact bytes. Both snapshotting and copying use `fs::metadata()` rather than `symlink_metadata()` so symlink-heavy Buck2 source trees are followed and behave like normal files/directories in fixtures. Recursive traversal strips the base prefix to produce relative paths, skips entries whose prefix stripping somehow fails, and creates parent directories as needed during copy. This design makes the suite resilient to platform/build-system differences while validating complete tree outcomes rather than individual stdout/stderr messages.

#### Function details

##### `test_apply_patch_scenarios`  (lines 11–26)

```
fn test_apply_patch_scenarios() -> anyhow::Result<()>
```

**Purpose**: Discovers all scenario fixture directories and runs each one as an end-to-end apply-patch test.

**Data flow**: It computes the scenarios root from `repo_root()`, reads its directory entries, filters to subdirectories, and calls `run_apply_patch_scenario` on each. It returns `Ok(())` if all scenarios pass.

**Call relations**: This is the top-level test entrypoint for the scenario suite. It delegates all per-scenario setup, execution, and verification to `run_apply_patch_scenario`.

*Call graph*: calls 1 internal fn (run_apply_patch_scenario); 2 external calls (repo_root, read_dir).


##### `run_apply_patch_scenario`  (lines 30–63)

```
fn run_apply_patch_scenario(dir: &Path) -> anyhow::Result<()>
```

**Purpose**: Executes one fixture scenario by preparing input files, running the binary, and comparing actual versus expected directory snapshots.

**Data flow**: It takes a scenario directory path, creates a temp directory, optionally copies `input/` into it via `copy_dir_recursive`, reads `patch.txt`, runs the `apply_patch` binary with that patch as an argument in the temp directory, snapshots both `expected/` and the temp directory with `snapshot_dir`, and asserts exact equality of the resulting `BTreeMap<PathBuf, Entry>` values.

**Call relations**: Called from `test_apply_patch_scenarios` for each fixture directory, this function orchestrates the full scenario lifecycle and delegates tree traversal to the snapshot/copy helpers.

*Call graph*: calls 2 internal fn (copy_dir_recursive, snapshot_dir); called by 1 (test_apply_patch_scenarios); 6 external calls (join, assert_eq!, new, cargo_bin, read_to_string, tempdir).


##### `snapshot_dir`  (lines 71–77)

```
fn snapshot_dir(root: &Path) -> anyhow::Result<BTreeMap<PathBuf, Entry>>
```

**Purpose**: Builds a normalized recursive snapshot of a directory tree for exact comparison in tests.

**Data flow**: It takes a root path, initializes an empty `BTreeMap<PathBuf, Entry>`, calls `snapshot_dir_recursive` when the root exists as a directory, and returns the populated map.

**Call relations**: This helper is used by `run_apply_patch_scenario` to capture both expected and actual filesystem state in a deterministic, comparable form.

*Call graph*: calls 1 internal fn (snapshot_dir_recursive); called by 1 (run_apply_patch_scenario); 2 external calls (new, is_dir).


##### `snapshot_dir_recursive`  (lines 79–105)

```
fn snapshot_dir_recursive(
    base: &Path,
    dir: &Path,
    entries: &mut BTreeMap<PathBuf, Entry>,
) -> anyhow::Result<()>
```

**Purpose**: Traverses a directory tree and records each relative path as either a directory marker or raw file bytes.

**Data flow**: It reads entries from `dir`, strips each path against `base` to compute a relative `PathBuf`, follows symlinks with `fs::metadata`, inserts `Entry::Dir` for directories and recurses into them, or reads file bytes and inserts `Entry::File(contents)` for regular files. It mutates the provided `entries` map in place.

**Call relations**: This is the recursive worker behind `snapshot_dir`. Its use of `metadata()` is a deliberate compatibility choice for Buck2 materialized symlink trees.

*Call graph*: called by 1 (snapshot_dir); 4 external calls (File, metadata, read, read_dir).


##### `copy_dir_recursive`  (lines 107–126)

```
fn copy_dir_recursive(src: &Path, dst: &Path) -> anyhow::Result<()>
```

**Purpose**: Copies a fixture input directory tree into a temporary workspace while following symlinks like normal files/directories.

**Data flow**: It iterates over `src` with `fs::read_dir`, computes each destination path under `dst`, inspects entries with `fs::metadata`, creates destination directories recursively for directories, and for files ensures parent directories exist before copying bytes with `fs::copy`.

**Call relations**: This helper is called by `run_apply_patch_scenario` to materialize the scenario’s starting filesystem state before invoking the binary.

*Call graph*: called by 1 (run_apply_patch_scenario); 5 external calls (join, copy, create_dir_all, metadata, read_dir).
