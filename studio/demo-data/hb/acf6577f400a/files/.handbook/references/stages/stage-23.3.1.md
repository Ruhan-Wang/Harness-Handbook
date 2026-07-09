# apply-patch executable integration tests  `stage-23.3.1`

This stage checks the standalone apply-patch program from the outside, as if it were being used by a real person in a terminal. It is part of the project’s testing support, not the normal startup or work loop. Its job is to prove that the finished executable accepts patch input correctly and leaves the filesystem in the right state.

The suite starts in `all.rs`, which acts like the front door and loads the shared test tree. `mod.rs` is the table of contents. It selects the test groups to run and leaves out one group on Windows where the behavior does not apply. `cli.rs` focuses on command-line use: it runs `apply_patch` with patch text passed either as an argument or through standard input, then checks that files are created or changed. `tool.rs` goes deeper into real folder effects, testing edits, overwrites, renames, deletes, and clear failures for bad patches. `scenarios.rs` runs complete example patches and compares the final folder contents with the expected results.

## Files in this stage

### Test suite entrypoints
These files define the integration-test binary and assemble the shared suite modules that the executable-facing tests run through.

### `apply-patch/tests/all.rs`

`test` · `test run`

This file is intentionally tiny, but it plays an important organizing role. In Rust, an integration test file under `tests/` is built as its own separate test program. By having one file named `all.rs`, the project creates one combined test program instead of scattering the suite across many separate test binaries. The line `mod suite;` is like putting up a sign that says, “load the test code from the `suite` module.” Rust then looks for that module in the matching location, here the `tests/suite/` directory. This keeps the visible top-level test entry simple while allowing the real test cases to be split into smaller files underneath. Without this file, the test modules in `tests/suite/` would not be pulled into this integration test binary, so those tests would not run through this entry point.


### `apply-patch/tests/suite/mod.rs`

`test` · `test discovery and compilation`

This small file does not contain test code itself. Instead, it connects several test modules so the Rust test runner can find and compile them as one suite. Think of it like the index page at the front of a binder: the actual material is in the named sections, but without the index the runner would not know those sections are part of this test collection.

It includes tests for the command-line interface through `cli`, broader behavior examples through `scenarios`, and, on non-Windows systems only, tool-related tests through `tool`. The Windows condition matters because some tool behavior is likely tied to Unix-style system behavior, paths, permissions, or shell expectations that are not the same on Windows. By guarding that module with a platform check, the suite avoids running tests on an operating system where they would be misleading or impossible.

Without this file, these test modules would not be pulled into this particular test suite entry point, so parts of the project could stop being checked automatically.


### CLI invocation coverage
These tests exercise direct command-line usage of the apply_patch executable, from basic invocation modes to broader user-visible success and failure behavior.

### `apply-patch/tests/suite/cli.rs`

`test` · `test run`

This test file acts like a safety check for the `apply_patch` executable. Rather than calling internal code directly, it launches the real command-line tool in a temporary folder and watches what happens. That matters because a command can work internally but still fail in the way users actually use it: wrong arguments, broken input reading, incorrect output text, or files written in the wrong place.

Each test creates a fresh temporary directory, like a disposable workbench. Inside that workbench, it asks `apply_patch` to add a new text file containing `hello`. Then it reads the file from disk to confirm the file was truly created, not just reported as created. Next, it sends another patch that changes `hello` to `world`, and again checks both the command's success message and the final file contents.

The two tests cover the two main ways the tool accepts patch text. One gives the patch as a command-line argument. The other writes the patch into standard input, which is the usual pipe-like input stream programs can read from. Together, they make sure the user-facing behavior stays correct for both styles.

#### Function details

##### `apply_patch_command`  (lines 5–9)

```
fn apply_patch_command() -> anyhow::Result<Command>
```

**Purpose**: This helper builds a ready-to-run command object for the `apply_patch` executable. It keeps the tests from repeating the same setup each time they need to launch the program.

**Data flow**: It starts with no user data. It asks the test support code to find the compiled `apply_patch` binary, then wraps that path in a command runner object. The result is a command object that the tests can add arguments, input, and a working directory to before running it.

**Call relations**: Both CLI tests call this helper at the moment they need to run `apply_patch`. After it returns the command object, the tests customize it for their scenario: one passes the patch as an argument, and the other writes the patch through standard input.

*Call graph*: called by 2 (test_apply_patch_cli_add_and_update, test_apply_patch_cli_stdin_add_and_update); 2 external calls (new, cargo_bin).


##### `test_apply_patch_cli_add_and_update`  (lines 12–50)

```
fn test_apply_patch_cli_add_and_update() -> anyhow::Result<()>
```

**Purpose**: This test checks the normal command-line argument path: giving `apply_patch` the whole patch as an argument. It proves that the tool can add a file, then update that same file, while printing the expected success messages.

**Data flow**: It creates a temporary directory and chooses a test filename inside it. It builds an add-file patch string, runs `apply_patch` in that directory with the patch as an argument, and checks that the command succeeds and prints an `A` message for an added file. It then reads the new file from disk and expects `hello`. Next it builds an update patch, runs the command again, checks for an `M` message for a modified file, and confirms the file now contains `world`.

**Call relations**: This test calls `apply_patch_command` twice, once for adding and once for updating. It uses the returned command runner to exercise the real executable, then uses file reading and equality checks to verify that the visible command output and the actual disk contents match.

*Call graph*: calls 1 internal fn (apply_patch_command); 3 external calls (assert_eq!, format!, tempdir).


##### `test_apply_patch_cli_stdin_add_and_update`  (lines 53–91)

```
fn test_apply_patch_cli_stdin_add_and_update() -> anyhow::Result<()>
```

**Purpose**: This test checks the standard-input path: sending the patch text into `apply_patch` through its input stream instead of as an argument. It makes sure the tool works when used in pipe-style workflows.

**Data flow**: It creates a temporary directory and names a file to test with. It prepares an add-file patch, launches `apply_patch` in the temporary directory, writes the patch into the program's standard input, and checks that the command succeeds and reports the file as added. It reads the file and expects `hello`. Then it sends an update patch the same way, checks that the command reports the file as modified, and confirms the file now contains `world`.

**Call relations**: Like the argument-based test, this one relies on `apply_patch_command` to find and prepare the real executable. Its difference is in how it hands off the patch: it writes the patch to standard input, showing that `apply_patch` supports both direct command use and stream-based use.

*Call graph*: calls 1 internal fn (apply_patch_command); 3 external calls (assert_eq!, format!, tempdir).


### `apply-patch/tests/suite/tool.rs`

`test` · `test run`

These tests treat `apply_patch` like a real user would: they start the compiled command-line program, give it a patch text, and inspect what happened on disk. Each test creates a fresh temporary directory, so it has a clean little workspace that disappears afterward. This is important because the tool’s main job is changing files, and unit tests that only look at internal code could miss mistakes in how the command behaves from the outside.

The helper functions are small conveniences. One builds and runs the command with a patch right away. Another builds the command but lets a test add arguments and then check failure details. A third turns a relative test path into the full path that the tool prints in error messages, so the expected messages match the machine running the test.

The test cases cover both happy paths and sharp edges. They confirm that one patch can add, update, delete, and move files; that several edit chunks can affect one file; and that files are overwritten in some cases. They also check failures: empty patches, missing files, invalid patch headers, deleting a directory, and update text that cannot be found. One notable behavior is that the tool is not fully “all or nothing”: if an early operation succeeds and a later one fails, the earlier file change remains.

#### Function details

##### `run_apply_patch_in_dir`  (lines 8–12)

```
fn run_apply_patch_in_dir(dir: &Path, patch: &str) -> anyhow::Result<assert_cmd::assert::Assert>
```

**Purpose**: Runs the `apply_patch` command inside a chosen folder with one patch string already supplied. Tests use it when they expect the command to complete and want to immediately check the result.

**Data flow**: It receives a directory path and patch text. It finds the compiled `apply_patch` program, sets that directory as the program’s working folder, passes the patch as an argument, and returns an assertion object that lets the test check success, output, or failure.

**Call relations**: The successful-behavior tests call this helper to avoid repeating command setup. It hands the actual command execution off to the external test command library, which runs the program and captures its output.

*Call graph*: called by 6 (test_apply_patch_cli_add_overwrites_existing_file, test_apply_patch_cli_applies_multiple_chunks, test_apply_patch_cli_applies_multiple_operations, test_apply_patch_cli_move_overwrites_existing_destination, test_apply_patch_cli_moves_file_to_new_directory, test_apply_patch_cli_updates_file_appends_trailing_newline); 2 external calls (new, cargo_bin).


##### `apply_patch_command`  (lines 14–18)

```
fn apply_patch_command(dir: &Path) -> anyhow::Result<Command>
```

**Purpose**: Builds a ready-to-use `apply_patch` command pointed at a chosen folder, without running it yet. Tests use it when they need more control over arguments and expected failure checks.

**Data flow**: It receives a directory path. It locates the compiled `apply_patch` binary, creates a command object, sets the command’s working directory, and returns that command object for the test to finish configuring.

**Call relations**: The error-focused tests call this helper, then add the patch text and assert exactly how the command fails. It delegates the low-level program lookup and command construction to external testing utilities.

*Call graph*: called by 8 (test_apply_patch_cli_delete_directory_fails, test_apply_patch_cli_failure_after_partial_success_leaves_changes, test_apply_patch_cli_rejects_empty_patch, test_apply_patch_cli_rejects_empty_update_hunk, test_apply_patch_cli_rejects_invalid_hunk_header, test_apply_patch_cli_rejects_missing_file_delete, test_apply_patch_cli_reports_missing_context, test_apply_patch_cli_requires_existing_file_for_update); 2 external calls (new, cargo_bin).


##### `resolved_under`  (lines 20–22)

```
fn resolved_under(root: &Path, path: &str) -> anyhow::Result<PathBuf>
```

**Purpose**: Builds the full, absolute-looking path that the tool is expected to mention in error messages. This keeps tests stable even though temporary directories have different names on each run.

**Data flow**: It receives a temporary root folder and a relative file name. It first resolves the root folder to its real filesystem location, joins the relative name onto it, and returns the resulting path.

**Call relations**: Tests that compare error messages call this before running the command. The produced path is then inserted into the expected stderr text so the assertion matches what `apply_patch` prints.

*Call graph*: called by 5 (test_apply_patch_cli_delete_directory_fails, test_apply_patch_cli_failure_after_partial_success_leaves_changes, test_apply_patch_cli_rejects_missing_file_delete, test_apply_patch_cli_reports_missing_context, test_apply_patch_cli_requires_existing_file_for_update); 1 external calls (canonicalize).


##### `test_apply_patch_cli_applies_multiple_operations`  (lines 25–45)

```
fn test_apply_patch_cli_applies_multiple_operations() -> anyhow::Result<()>
```

**Purpose**: Checks that one patch can add a file, update another file, and delete a third file in a single run. This proves the command can process a mixed batch of file changes.

**Data flow**: It creates a temporary workspace with two existing files, then sends a patch that adds `nested/new.txt`, edits `modify.txt`, and deletes `delete.txt`. After the command succeeds, it checks the success message and verifies the new file content, the edited file content, and the deleted file’s absence.

**Call relations**: This test uses `run_apply_patch_in_dir` to execute the command in the temporary workspace. After the helper returns the captured command result, the test checks both command output and filesystem state.

*Call graph*: calls 1 internal fn (run_apply_patch_in_dir); 4 external calls (assert!, assert_eq!, write, tempdir).


##### `test_apply_patch_cli_applies_multiple_chunks`  (lines 48–65)

```
fn test_apply_patch_cli_applies_multiple_chunks() -> anyhow::Result<()>
```

**Purpose**: Checks that one file can be edited in more than one separate place by the same patch. This matters because real patches often contain several small changes in one file.

**Data flow**: It writes a four-line file, runs a patch with two edit sections, and expects the command to report one modified file. It then reads the file and confirms that only the intended lines changed.

**Call relations**: The test relies on `run_apply_patch_in_dir` to run the command. It then uses file reading and equality checks to confirm the command made both edits correctly.

*Call graph*: calls 1 internal fn (run_apply_patch_in_dir); 3 external calls (assert_eq!, write, tempdir).


##### `test_apply_patch_cli_moves_file_to_new_directory`  (lines 68–85)

```
fn test_apply_patch_cli_moves_file_to_new_directory() -> anyhow::Result<()>
```

**Purpose**: Checks that an update patch can also move a file into a new directory while changing its contents. This protects the rename-or-move behavior of the command-line tool.

**Data flow**: It creates an original file under `old/`, sends a patch that moves it to `renamed/dir/` and changes its text, then checks that the old path is gone and the new path contains the updated content.

**Call relations**: The test prepares the needed source directory itself, then uses `run_apply_patch_in_dir` to exercise the command. It verifies the command’s report and the actual move on disk.

*Call graph*: calls 1 internal fn (run_apply_patch_in_dir); 5 external calls (assert!, assert_eq!, create_dir_all, write, tempdir).


##### `test_apply_patch_cli_rejects_empty_patch`  (lines 88–98)

```
fn test_apply_patch_cli_rejects_empty_patch() -> anyhow::Result<()>
```

**Purpose**: Checks that a patch with begin and end markers but no file changes is rejected. This prevents the tool from pretending success when it did nothing.

**Data flow**: It creates an empty temporary workspace and runs the command with an empty patch body. The expected result is failure with the message `No files were modified.`

**Call relations**: This test uses `apply_patch_command` because it is focused on a failure case and wants to assert stderr directly after adding the patch argument.

*Call graph*: calls 1 internal fn (apply_patch_command); 1 external calls (tempdir).


##### `test_apply_patch_cli_reports_missing_context`  (lines 101–118)

```
fn test_apply_patch_cli_reports_missing_context() -> anyhow::Result<()>
```

**Purpose**: Checks that updating a file fails clearly when the patch asks to replace text that is not actually present. This protects users from silent or wrong edits.

**Data flow**: It creates `modify.txt` with known content, builds the full expected path for the error message, and runs a patch that tries to replace a missing line. The command should fail, print which expected line could not be found, and leave the file unchanged.

**Call relations**: The test calls `resolved_under` to match the path shown in the error, then uses `apply_patch_command` to run and inspect the failing command. Afterward it reads the file to confirm no accidental edit happened.

*Call graph*: calls 2 internal fn (apply_patch_command, resolved_under); 4 external calls (assert_eq!, format!, write, tempdir).


##### `test_apply_patch_cli_rejects_missing_file_delete`  (lines 121–135)

```
fn test_apply_patch_cli_rejects_missing_file_delete() -> anyhow::Result<()>
```

**Purpose**: Checks that deleting a file that does not exist fails with a useful message. This confirms the tool does not treat missing deletes as successful work.

**Data flow**: It creates a temporary workspace, computes the full path of a file that is not there, and runs a delete patch for that file. The expected result is failure with a message naming the missing file.

**Call relations**: The test uses `resolved_under` for the expected error path and `apply_patch_command` to run the command in a way that lets it check the failure output exactly.

*Call graph*: calls 2 internal fn (apply_patch_command, resolved_under); 2 external calls (format!, tempdir).


##### `test_apply_patch_cli_rejects_empty_update_hunk`  (lines 138–148)

```
fn test_apply_patch_cli_rejects_empty_update_hunk() -> anyhow::Result<()>
```

**Purpose**: Checks that an update section with no actual edit instructions is rejected. This catches malformed patches early and explains what is wrong.

**Data flow**: It runs a patch that says `Update File: foo.txt` but gives no lines to remove or add. The expected result is failure with an invalid-hunk message explaining that the update hunk is empty.

**Call relations**: The test uses `apply_patch_command` so it can pass the malformed patch and assert the exact stderr message produced by the command.

*Call graph*: calls 1 internal fn (apply_patch_command); 1 external calls (tempdir).


##### `test_apply_patch_cli_requires_existing_file_for_update`  (lines 151–165)

```
fn test_apply_patch_cli_requires_existing_file_for_update() -> anyhow::Result<()>
```

**Purpose**: Checks that updating a missing file fails instead of creating it by accident. Adding and updating are different operations, and this test keeps that boundary clear.

**Data flow**: It computes the full path for `missing.txt`, runs an update patch against that nonexistent file, and expects a failure message saying the file could not be read because it does not exist.

**Call relations**: The test calls `resolved_under` to build the expected message and `apply_patch_command` to run the command and inspect its failure.

*Call graph*: calls 2 internal fn (apply_patch_command, resolved_under); 2 external calls (format!, tempdir).


##### `test_apply_patch_cli_move_overwrites_existing_destination`  (lines 168–188)

```
fn test_apply_patch_cli_move_overwrites_existing_destination() -> anyhow::Result<()>
```

**Purpose**: Checks what happens when a moved file lands on a path that already has a file: the destination is overwritten. This documents an important and potentially surprising behavior.

**Data flow**: It creates a source file and a destination file, then runs a patch that moves the source to the destination path while changing its content. After success, it checks that the source is gone and the destination now contains the new text, not the old destination text.

**Call relations**: The test sets up both directories and files itself, then uses `run_apply_patch_in_dir` to run the command. It confirms the command reports the destination as modified.

*Call graph*: calls 1 internal fn (run_apply_patch_in_dir); 5 external calls (assert!, assert_eq!, create_dir_all, write, tempdir).


##### `test_apply_patch_cli_add_overwrites_existing_file`  (lines 191–206)

```
fn test_apply_patch_cli_add_overwrites_existing_file() -> anyhow::Result<()>
```

**Purpose**: Checks that an add-file patch overwrites an existing file with the same name. This records the tool’s chosen behavior for duplicate add paths.

**Data flow**: It creates `duplicate.txt` with old content, runs an add-file patch for the same path with new content, and then reads the file to confirm the new content replaced the old content.

**Call relations**: The test uses `run_apply_patch_in_dir` because the command is expected to succeed. The filesystem check afterward proves the overwrite really happened.

*Call graph*: calls 1 internal fn (run_apply_patch_in_dir); 3 external calls (assert_eq!, write, tempdir).


##### `test_apply_patch_cli_delete_directory_fails`  (lines 209–225)

```
fn test_apply_patch_cli_delete_directory_fails() -> anyhow::Result<()>
```

**Purpose**: Checks that a delete-file patch cannot be used to delete a directory. This keeps file deletion behavior from accidentally removing folders.

**Data flow**: It creates a directory named `dir`, computes its full path for the expected message, and runs a delete-file patch against that directory. The expected result is failure with a message saying the file could not be deleted.

**Call relations**: The test calls `resolved_under` for the path in the error text and `apply_patch_command` to run the failure case and check stderr.

*Call graph*: calls 2 internal fn (apply_patch_command, resolved_under); 3 external calls (format!, create_dir, tempdir).


##### `test_apply_patch_cli_rejects_invalid_hunk_header`  (lines 228–238)

```
fn test_apply_patch_cli_rejects_invalid_hunk_header() -> anyhow::Result<()>
```

**Purpose**: Checks that the parser rejects an unknown patch section header and tells the user which headers are valid. This helps users find formatting mistakes in patches.

**Data flow**: It runs a patch containing `*** Frobnicate File: foo`, which is not a supported operation. The command should fail and print an error naming the bad header and showing the accepted forms.

**Call relations**: The test uses `apply_patch_command` to run the malformed patch and compare the exact error text from the command.

*Call graph*: calls 1 internal fn (apply_patch_command); 1 external calls (tempdir).


##### `test_apply_patch_cli_updates_file_appends_trailing_newline`  (lines 241–258)

```
fn test_apply_patch_cli_updates_file_appends_trailing_newline() -> anyhow::Result<()>
```

**Purpose**: Checks that an updated file ends with a newline even when the original file did not. This documents the tool’s text-file formatting behavior.

**Data flow**: It creates a file whose content has no newline at the end, runs a patch that replaces that content with two lines, then reads the result. It verifies both the exact contents and that the final character is a newline.

**Call relations**: The test uses `run_apply_patch_in_dir` because the update should succeed. It then reads the file directly to check a detail that would not be visible from the command’s success message alone.

*Call graph*: calls 1 internal fn (run_apply_patch_in_dir); 5 external calls (assert!, assert_eq!, read_to_string, write, tempdir).


##### `test_apply_patch_cli_failure_after_partial_success_leaves_changes`  (lines 261–279)

```
fn test_apply_patch_cli_failure_after_partial_success_leaves_changes() -> anyhow::Result<()>
```

**Purpose**: Checks that if a patch partly succeeds and then fails, earlier changes are not rolled back. This is important because users and developers need to know the command is not atomic, meaning it does not undo the whole batch on later failure.

**Data flow**: It runs a patch that first adds `created.txt` and then tries to update a missing file. The command should fail on the missing update and print no success output, but the test then confirms that `created.txt` still exists with the added content.

**Call relations**: The test uses `resolved_under` for the expected missing-file path and `apply_patch_command` to inspect the failure. Its final file check records how the command behaves after partial progress.

*Call graph*: calls 2 internal fn (apply_patch_command, resolved_under); 3 external calls (assert_eq!, format!, tempdir).


### Fixture-driven scenarios
This scenario suite applies patches to copied fixture trees and verifies final filesystem snapshots for end-to-end regression coverage.

### `apply-patch/tests/suite/scenarios.rs`

`test` · `test run`

This is a scenario-based test file. Instead of checking one small function at a time, it treats `apply_patch` like a user would: start with some files, apply a patch, then look at what the directory contains afterward. Each test scenario lives in its own fixture folder with an `input` directory, a `patch.txt`, and an `expected` directory. The test copies the input files into a fresh temporary folder, runs the built `apply_patch` program there, and compares the whole resulting folder against the expected one.

The comparison is strict. It records every directory and every file’s raw bytes, then stores them in a sorted map so the result is stable and easy to compare. This means a scenario only passes if the final filesystem state matches exactly. The test intentionally does not care whether the command exits successfully or with an error; the scenario is defined only by what is left on disk afterward.

There is also special care for symlinks, which are shortcut-like file references often used by build systems. The code follows symlinks when reading fixture files, so the same tests work both in normal Cargo runs and under Buck2, another build system.

#### Function details

##### `test_apply_patch_scenarios`  (lines 11–26)

```
fn test_apply_patch_scenarios() -> anyhow::Result<()>
```

**Purpose**: This is the top-level test that finds every scenario folder and runs the same end-to-end check on each one. It lets the project add new patch behavior tests simply by adding new fixture directories.

**Data flow**: It starts from the repository root, builds the path to the scenario fixture directory, and reads each child entry there. For every child that is a directory, it passes that path into `run_apply_patch_scenario`. If every scenario finishes without a mismatch or file error, the test returns success.

**Call relations**: The test harness calls this function when the test suite runs. It acts like a tour guide through the fixture folders: it discovers each scenario, then hands the real work to `run_apply_patch_scenario`.

*Call graph*: calls 1 internal fn (run_apply_patch_scenario); 2 external calls (repo_root, read_dir).


##### `run_apply_patch_scenario`  (lines 30–63)

```
fn run_apply_patch_scenario(dir: &Path) -> anyhow::Result<()>
```

**Purpose**: This function runs one complete patch scenario from start to finish. It creates a safe temporary workspace, applies the scenario’s patch there, and checks that the resulting files match the expected answer.

**Data flow**: It receives the path to one scenario directory. It creates a temporary directory, copies the scenario’s `input` files into it if they exist, reads `patch.txt`, and runs the `apply_patch` binary with that patch text while using the temporary directory as the working folder. After the command finishes, it takes one snapshot of the scenario’s `expected` directory and one snapshot of the temporary directory, then compares them exactly. It returns success only if the snapshots are identical.

**Call relations**: `test_apply_patch_scenarios` calls this once for each fixture directory. Inside the scenario, it asks `copy_dir_recursive` to prepare the workspace and `snapshot_dir` to turn both the expected and actual folders into comparable data before using the assertion to decide whether the scenario passed.

*Call graph*: calls 2 internal fn (copy_dir_recursive, snapshot_dir); called by 1 (test_apply_patch_scenarios); 6 external calls (join, assert_eq!, new, cargo_bin, read_to_string, tempdir).


##### `snapshot_dir`  (lines 71–77)

```
fn snapshot_dir(root: &Path) -> anyhow::Result<BTreeMap<PathBuf, Entry>>
```

**Purpose**: This function turns a directory tree into a simple, comparable record of what it contains. It is used so the test can compare whole folders, not just individual files.

**Data flow**: It receives a root path and creates an empty sorted map. If the root is a directory, it asks `snapshot_dir_recursive` to walk through it and fill the map with relative paths paired with either directory markers or file contents. It returns that completed map.

**Call relations**: `run_apply_patch_scenario` calls this twice: once for the expected fixture directory and once for the temporary directory after `apply_patch` has run. It delegates the actual walking and reading to `snapshot_dir_recursive`.

*Call graph*: calls 1 internal fn (snapshot_dir_recursive); called by 1 (run_apply_patch_scenario); 2 external calls (new, is_dir).


##### `snapshot_dir_recursive`  (lines 79–105)

```
fn snapshot_dir_recursive(
    base: &Path,
    dir: &Path,
    entries: &mut BTreeMap<PathBuf, Entry>,
) -> anyhow::Result<()>
```

**Purpose**: This function walks through a directory and records every directory and file it finds. It is the part that builds the detailed folder snapshot used for exact comparison.

**Data flow**: It receives the original base directory, the current directory to inspect, and the map being filled. For each entry, it computes the path relative to the base, follows symlinks to see what the entry really points to, then records directories as `Dir` and files as `File` with their raw bytes. When it finds a subdirectory, it calls itself again to inspect that subdirectory too.

**Call relations**: `snapshot_dir` starts this recursive walk. The function then repeatedly calls itself for nested folders, building one complete snapshot that `run_apply_patch_scenario` can compare against another snapshot.

*Call graph*: called by 1 (snapshot_dir); 4 external calls (File, metadata, read, read_dir).


##### `copy_dir_recursive`  (lines 107–126)

```
fn copy_dir_recursive(src: &Path, dst: &Path) -> anyhow::Result<()>
```

**Purpose**: This function copies a whole directory tree from one place to another. It prepares the temporary test workspace so `apply_patch` can run against realistic starting files without changing the original fixtures.

**Data flow**: It receives a source directory and a destination directory. For each entry in the source, it builds the matching destination path, follows symlinks to inspect the real file or directory, creates destination folders when needed, and copies file bytes across. For subdirectories, it calls itself so the full tree is copied.

**Call relations**: `run_apply_patch_scenario` calls this before running `apply_patch`, but only when the scenario has an `input` directory. It is the setup step that turns read-only fixture data into a disposable working copy.

*Call graph*: called by 1 (run_apply_patch_scenario); 5 external calls (join, copy, create_dir_all, metadata, read_dir).
