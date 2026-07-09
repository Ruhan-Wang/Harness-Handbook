# Installation context, home discovery, and local environment probing  `stage-3`

This stage is early setup and shared support. Before Codex can load settings or run tools, it must learn “where am I, what machine is this, and what helpers can I use?” The home-dir code chooses the user’s Codex folder, using CODEX_HOME if set or ~/.codex otherwise. The install-context and managed-install code identify how Codex was installed, where bundled resources are, which executable is managed by the app, and on Unix can check its real path, version, and file fingerprint.

Several pieces probe the local working conditions. The shell snapshot code captures the user’s shell setup, like aliases and exported variables, so later commands feel like they ran in the user’s normal terminal. The environment and environment-provider code define available places to run commands: local machine, remote exec server, or neither. Windows helper materialization copies needed helper programs into a sandbox bin folder safely.

Diagnostics then report what was found. Doctor checks cover Git, system settings, launch details, and search-helper availability. Cloud environment detection finds suitable cloud workspaces. Hostname lookup gives the rest of Codex a consistent machine name for matching rules.

## Files in this stage

### Installation layout discovery
These files establish where Codex is installed, where its home directory and bundled resources live, and how managed installs are identified.

### `app-server-daemon/src/managed_install.rs`

`domain_logic` · `startup, update checks, and restart decisions`

This file supports a “managed install” of Codex: a copy of the Codex program that lives inside the app’s own home folder rather than being found randomly on the user’s system. Its first job is to build the expected path to that program, like looking in a fixed shelf location: `packages/standalone/current/codex` or `codex.exe` on Windows.

On Unix systems, it also performs checks that help the updater and restart logic make safe decisions. It can turn a path into its true, final filesystem location, which matters when the path may go through links. It can run the Codex binary with `--version`, read the text it prints, and extract the version number. If the program cannot be run, exits with an error, prints non-text data, or prints text in the wrong shape, the file returns a clear error instead of guessing.

Finally, it can compute an executable identity by reading the whole file and hashing it with SHA-256, a common fingerprinting method that turns file bytes into a fixed-size ID. This lets the system compare “is this exactly the same executable?” without relying only on names or paths, which can be misleading.

#### Function details

##### `managed_codex_bin`  (lines 19–25)

```
fn managed_codex_bin(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the expected filesystem path to the managed Codex executable inside the Codex home directory. This gives the rest of the daemon one standard place to look for the bundled program.

**Data flow**: It receives the Codex home folder path. It appends `packages`, `standalone`, `current`, and the platform-specific executable file name. It returns the complete path without checking whether the file exists.

**Call relations**: When environment setup code needs to know where the managed Codex binary should live, it calls this function. This function asks `managed_codex_file_name` for the correct final file name, then hands the finished path back to the caller.

*Call graph*: calls 1 internal fn (managed_codex_file_name); called by 1 (from_environment); 1 external calls (join).


##### `resolved_managed_codex_bin`  (lines 28–35)

```
async fn resolved_managed_codex_bin(codex_bin: &Path) -> Result<PathBuf>
```

**Purpose**: Finds the real, fully resolved location of the managed Codex binary on Unix systems. This is useful when the path may include symbolic links, which are filesystem shortcuts to another location.

**Data flow**: It receives a path to the Codex binary. It asks the operating system to canonicalize it, meaning to follow links and normalize the path. It returns the resolved path, or an error that includes the path it failed to resolve.

**Call relations**: During an update pass, `update_once` calls this before working with the managed executable. This function delegates the filesystem work to `canonicalize` and adds a clearer error message if that lookup fails.

*Call graph*: called by 1 (update_once); 1 external calls (canonicalize).


##### `managed_codex_version`  (lines 38–64)

```
async fn managed_codex_version(codex_bin: &Path) -> Result<String>
```

**Purpose**: Runs the managed Codex executable and asks it to report its version. This lets the daemon know exactly what version of Codex is currently installed or running.

**Data flow**: It receives the path to the executable. It starts that program with the `--version` argument, waits for it to finish, checks that it exited successfully, converts its standard output from bytes into text, and extracts the version string. It returns the version or a detailed error if any step fails.

**Call relations**: Version-checking code such as `managed_codex_version_best_effort` and restart logic such as `try_restart_if_running` call this when they need to compare or report the managed Codex version. After running the external program, it hands the printed text to `parse_codex_version` to pull out just the version number.

*Call graph*: calls 1 internal fn (parse_codex_version); called by 2 (managed_codex_version_best_effort, try_restart_if_running); 3 external calls (from_utf8, anyhow!, new).


##### `executable_identity`  (lines 73–78)

```
async fn executable_identity(executable: &Path) -> Result<ExecutableIdentity>
```

**Purpose**: Creates a fingerprint for an executable file by reading its contents. This helps the updater tell whether two executable files are actually the same, even if they have the same name.

**Data flow**: It receives a path to an executable. It reads all bytes from that file, then passes those bytes to `executable_identity_from_bytes`. It returns an `ExecutableIdentity`, or an error if the file cannot be read.

**Call relations**: Updater-related code calls this when it needs to identify the current updater or the managed executable during `current_updater_identity` and `update_once`. This function does the file-reading part, then hands the raw bytes to `executable_identity_from_bytes` for the hashing step.

*Call graph*: calls 1 internal fn (executable_identity_from_bytes); called by 2 (current_updater_identity, update_once); 1 external calls (read).


##### `executable_identity_from_bytes`  (lines 81–85)

```
fn executable_identity_from_bytes(bytes: &[u8]) -> ExecutableIdentity
```

**Purpose**: Turns raw executable bytes into an `ExecutableIdentity` using a SHA-256 hash. A hash is like a compact fingerprint: a small value that changes if the file contents change.

**Data flow**: It receives a slice of bytes. It computes a SHA-256 digest over those bytes and stores the 32-byte result in an `ExecutableIdentity`. It returns that identity without touching the filesystem.

**Call relations**: `executable_identity` calls this after reading an executable file from disk. Keeping the hashing step separate makes the identity calculation usable and testable without needing an actual file.

*Call graph*: called by 1 (executable_identity); 1 external calls (digest).


##### `managed_codex_file_name`  (lines 87–89)

```
fn managed_codex_file_name() -> &'static str
```

**Purpose**: Chooses the correct executable file name for the current operating system. Windows programs normally end in `.exe`, while Unix-style systems usually do not.

**Data flow**: It reads the compile-time platform setting. If the build is for Windows, it returns `codex.exe`; otherwise, it returns `codex`.

**Call relations**: `managed_codex_bin` calls this while building the full managed executable path. This keeps the platform-specific naming rule in one small place instead of spreading it through the code.

*Call graph*: called by 1 (managed_codex_bin); 1 external calls (cfg!).


##### `parse_codex_version`  (lines 92–99)

```
fn parse_codex_version(output: &str) -> Result<String>
```

**Purpose**: Extracts the version number from the text printed by `codex --version`. It expects the version to be the second whitespace-separated piece of text.

**Data flow**: It receives the full output text from the Codex executable. It splits the text into words, takes the second word, checks that it is not empty, and returns it as a string. If the output does not match the expected shape, it returns an error saying the version output was malformed.

**Call relations**: `managed_codex_version` calls this after successfully running the executable and converting its output into text. This function performs the small but important parsing step so the caller gets a clean version string instead of raw command output.

*Call graph*: called by 1 (managed_codex_version).


### `utils/home-dir/src/lib.rs`

`util` · `startup and config load`

Codex needs one reliable place to look for its settings, saved state, and other user-specific files. This file is the small utility that answers: “Where is the Codex home folder on this machine?” Think of it like finding the right filing cabinet before reading or writing any documents.

The main rule is simple. If the CODEX_HOME environment variable is set and not empty, Codex uses that path. Because this is an explicit override, the file is strict: the path must already exist, it must be a directory, and it is converted into its real full path. That conversion, called canonicalization, resolves things like symbolic links and relative path pieces so the rest of the program gets a stable absolute path.

If CODEX_HOME is not set, Codex uses the current user’s home directory and appends .codex, producing something like /home/alice/.codex or /Users/alice/.codex. In this default case, the directory is not checked for existence here; another part of the program may create it later.

The tests cover the important promises: missing override paths fail, file paths fail, valid directories are normalized, and the default path is built from the user’s home directory.

#### Function details

##### `find_codex_home`  (lines 13–18)

```
fn find_codex_home() -> std::io::Result<AbsolutePathBuf>
```

**Purpose**: This is the public entry point for finding Codex’s home configuration directory. Other code calls it when it needs the correct folder without caring whether it came from an environment variable or the default location.

**Data flow**: It reads the CODEX_HOME environment variable from the operating system. If the variable is missing or empty, it treats it as not set. It then passes that optional value to the helper that does the actual path checking and building, and returns either an absolute Codex home path or an input/output error explaining what went wrong.

**Call relations**: This function is the friendly front door for the utility. It calls find_codex_home_from_env so the detailed decision-making stays in one place, and it uses the system environment lookup when real program code needs the answer.

*Call graph*: calls 1 internal fn (find_codex_home_from_env); 1 external calls (var).


##### `find_codex_home_from_env`  (lines 20–63)

```
fn find_codex_home_from_env(codex_home_env: Option<&str>) -> std::io::Result<AbsolutePathBuf>
```

**Purpose**: This function contains the actual rules for turning an optional CODEX_HOME value into a safe absolute path. It exists separately so tests can provide pretend environment values without changing the real process environment.

**Data flow**: It receives either a string path from CODEX_HOME or no value. With a provided path, it checks the filesystem to make sure the path exists, verifies it is a directory, converts it to its canonical full path, and wraps it as an AbsolutePathBuf, a path type that guarantees the path is absolute. With no provided path, it asks the system for the user’s home directory, appends .codex, and returns that as an absolute path. If any required step fails, it returns an error with a specific message.

**Call relations**: find_codex_home calls this during normal use after reading the environment. The test functions also call it directly to exercise each branch: missing path, file instead of directory, valid directory, and default home-directory behavior. It relies on filesystem metadata checks, home directory lookup, and AbsolutePathBuf validation to hand back a path the rest of Codex can trust.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 5 (find_codex_home, find_codex_home_env_file_path_is_fatal, find_codex_home_env_missing_path_is_fatal, find_codex_home_env_valid_directory_canonicalizes, find_codex_home_without_env_uses_default_home_dir); 5 external calls (from, new, home_dir, format!, metadata).


##### `tests::find_codex_home_env_missing_path_is_fatal`  (lines 76–89)

```
fn find_codex_home_env_missing_path_is_fatal()
```

**Purpose**: This test proves that setting CODEX_HOME to a path that does not exist is treated as an error. That matters because an explicit user override should not silently fall back to some other directory.

**Data flow**: It creates a temporary directory, builds a path inside it that has not been created, and passes that missing path to find_codex_home_from_env. The expected result is an error. The test then checks that the error kind is NotFound and that the message mentions CODEX_HOME.

**Call relations**: This test calls find_codex_home_from_env directly to simulate a bad environment variable value. It protects the stricter override behavior from being accidentally weakened in the future.

*Call graph*: calls 1 internal fn (find_codex_home_from_env); 3 external calls (new, assert!, assert_eq!).


##### `tests::find_codex_home_env_file_path_is_fatal`  (lines 92–106)

```
fn find_codex_home_env_file_path_is_fatal()
```

**Purpose**: This test proves that CODEX_HOME must point to a directory, not an ordinary file. Codex needs a folder because it may contain multiple configuration and state files.

**Data flow**: It creates a temporary directory, writes a regular file inside it, and passes that file path as the pretend CODEX_HOME value. find_codex_home_from_env returns an error, and the test checks that the error kind is InvalidInput and that the message says the path is not a directory.

**Call relations**: This test exercises the branch in find_codex_home_from_env that checks filesystem metadata after a path exists. It ensures callers do not receive a file path where they expect a usable configuration folder.

*Call graph*: calls 1 internal fn (find_codex_home_from_env); 4 external calls (new, assert!, assert_eq!, write).


##### `tests::find_codex_home_env_valid_directory_canonicalizes`  (lines 109–123)

```
fn find_codex_home_env_valid_directory_canonicalizes()
```

**Purpose**: This test proves that a valid CODEX_HOME directory is accepted and normalized into its canonical absolute form. That gives the rest of the program one clean version of the path.

**Data flow**: It creates a temporary directory and passes its path to find_codex_home_from_env. The function returns a resolved AbsolutePathBuf. The test independently canonicalizes the same temporary directory, wraps it as an AbsolutePathBuf, and checks that both values match.

**Call relations**: This test calls find_codex_home_from_env on the successful override path. It also uses AbsolutePathBuf conversion itself to build the expected answer, confirming that the helper returns the same kind of trusted absolute path used elsewhere.

*Call graph*: calls 2 internal fn (from_absolute_path, find_codex_home_from_env); 2 external calls (new, assert_eq!).


##### `tests::find_codex_home_without_env_uses_default_home_dir`  (lines 126–133)

```
fn find_codex_home_without_env_uses_default_home_dir()
```

**Purpose**: This test proves that when CODEX_HOME is not provided, Codex uses the user’s normal home directory plus .codex. This is the default location most users will rely on.

**Data flow**: It calls find_codex_home_from_env with no environment value. Then it asks the system for the user’s home directory, appends .codex, wraps that as an AbsolutePathBuf, and checks that the function returned the same path.

**Call relations**: This test covers the fallback branch of find_codex_home_from_env. It shows how the helper behaves when find_codex_home has found no usable CODEX_HOME value in the real environment.

*Call graph*: calls 2 internal fn (from_absolute_path, find_codex_home_from_env); 2 external calls (assert_eq!, home_dir).


### `install-context/src/lib.rs`

`domain_logic` · `startup and cross-cutting runtime lookups`

Codex can be started in several ways: from an npm package, a Bun package, Homebrew, a standalone downloaded release, a package-style folder, or just a developer build. This file turns that messy reality into one clear answer: an InstallContext. Think of it like checking the label and compartments on a toolbox before deciding which tools are inside and where they are stored.

The file first looks at the current executable path and a few environment hints. If npm or Bun says it launched Codex, that wins. Otherwise, it checks whether the executable sits inside a known standalone release folder under the Codex home directory, or whether it looks like a Homebrew path on macOS. Separately, it can recognize a newer package layout where the executable is in a bin folder next to metadata, resources, and PATH helper folders.

The result is used later by other parts of Codex to find bundled tools such as ripgrep, usually called rg, and optional resources such as a bundled zsh shell. The code is careful to only trust real files and real directories, not just names that happen to exist. It also stores the detected context once, so the rest of the program can ask for it without repeating filesystem checks.

#### Function details

##### `InstallContext::from_exe`  (lines 69–83)

```
fn from_exe(
        is_macos: bool,
        current_exe: Option<&Path>,
        managed_by_npm: bool,
        managed_by_bun: bool,
    ) -> Self
```

**Purpose**: Builds an install description from the executable path and launch hints, using the real Codex home folder if it can be found. This is the normal helper for code that knows where the running executable is but does not want to worry about home-directory lookup.

**Data flow**: It receives whether the system is macOS, an optional executable path, and flags saying whether npm or Bun launched Codex. It asks the home-directory utility for the Codex home folder, then passes all of that information into the more detailed constructor. It returns an InstallContext that says both the install method and any package layout that was found.

**Call relations**: This is a convenience front door. It delegates the actual decision-making to InstallContext::from_exe_with_codex_home after getting the Codex home path from the shared home-directory utility.

*Call graph*: 2 external calls (from_exe_with_codex_home, find_codex_home).


##### `InstallContext::from_exe_with_codex_home`  (lines 85–107)

```
fn from_exe_with_codex_home(
        is_macos: bool,
        current_exe: Option<&Path>,
        managed_by_npm: bool,
        managed_by_bun: bool,
        codex_home: Option<&Path>,
    ) -> Self
```

**Purpose**: Creates an install description when the caller already knows, or wants to control, the Codex home folder. Tests use it heavily because it lets them build fake install folders without touching the user's real machine.

**Data flow**: It takes platform information, an optional executable path, npm and Bun launch flags, and an optional Codex home path. It first tries to recognize a package layout from the executable path. Then it chooses the install method: npm first, Bun second, then path-based detection, and finally Other if nothing fits. It returns an InstallContext containing both findings.

**Call relations**: This is the central decision point used by many tests and by InstallContext::from_exe. When npm or Bun is not in charge, it hands path-based classification to install_method_from_exe.

*Call graph*: calls 1 internal fn (install_method_from_exe); called by 9 (brew_is_detected_on_macos_prefixes, bundled_file_lookups_ignore_directories, detects_package_layout_independently_from_install_method, detects_standalone_install_from_release_layout, npm_and_bun_take_precedence, npm_managed_package_keeps_package_layout, standalone_package_layout_keeps_standalone_install_method, standalone_package_rg_falls_back_when_codex_path_is_missing, standalone_rg_falls_back_when_resources_are_missing).


##### `InstallContext::current`  (lines 109–121)

```
fn current() -> &'static Self
```

**Purpose**: Returns the install description for the running Codex process. It calculates this only once, then shares the same answer everywhere else.

**Data flow**: It reads the current executable path from the operating system and checks environment variables that mark npm or Bun launches. It feeds those facts into InstallContext::from_exe and stores the result in a one-time global cell. Later calls get the already-computed context.

**Call relations**: This is the public access point used by command dispatch, diagnostics, update checks, package PATH setup, launch code, and search setup. It prevents each caller from repeating the same environment and filesystem probing.

*Call graph*: called by 7 (arg0_dispatch, doctor_install_context, standalone_release_cache_details, apply_package_path_prepend, launcher, search_threads, get_update_action).


##### `InstallContext::rg_command`  (lines 123–145)

```
fn rg_command(&self) -> PathBuf
```

**Purpose**: Finds the ripgrep command Codex should run for searching files. Ripgrep, often called rg, is a fast search tool; this function prefers a bundled copy when Codex shipped one.

**Data flow**: It looks first in the package layout's PATH helper directory, then in a standalone release's resources directory. In each place, it builds the expected rg filename and checks that it is a real file. If no bundled file is found, it returns the plain system command name, rg or rg.exe.

**Call relations**: The search provider asks this when it needs to start ripgrep. The function uses default_rg_command to choose the platform-correct executable name.

*Call graph*: calls 1 internal fn (default_rg_command); called by 1 (search_provider).


##### `InstallContext::bundled_resource`  (lines 147–169)

```
fn bundled_resource(&self, file_name: impl AsRef<Path>) -> Option<AbsolutePathBuf>
```

**Purpose**: Looks up a named file inside Codex's bundled resources. It is used when Codex wants a helper file that may have been shipped alongside the executable.

**Data flow**: It receives a file name or relative path. It checks the package-layout resource directory first, then the standalone release resource directory. If the requested path points to a real file, it returns its absolute path; otherwise it returns nothing.

**Call relations**: Higher-level code uses this as a safe resource finder. bundled_zsh_path builds on it for the bundled shell path, and install-related lookup code uses it to find packaged files.

*Call graph*: called by 2 (bundled_zsh_path, find_for_install_context); 1 external calls (as_ref).


##### `InstallContext::bundled_zsh_path`  (lines 171–177)

```
fn bundled_zsh_path(&self) -> Option<AbsolutePathBuf>
```

**Purpose**: Finds the bundled zsh executable when Codex includes one. zsh is a Unix shell, so this deliberately returns nothing on Windows.

**Data flow**: It checks the current platform. On Windows, it immediately returns no path. On other systems, it asks bundled_resource for the standard zsh resource location and returns that file path if it exists.

**Call relations**: This is a specialized wrapper around bundled_resource. bundled_zsh_bin_dir uses it when code needs the folder containing zsh rather than the zsh file itself.

*Call graph*: calls 2 internal fn (bundled_resource, zsh_resource_path); called by 1 (bundled_zsh_bin_dir); 1 external calls (cfg!).


##### `InstallContext::bundled_zsh_bin_dir`  (lines 179–181)

```
fn bundled_zsh_bin_dir(&self) -> Option<AbsolutePathBuf>
```

**Purpose**: Returns the directory that contains the bundled zsh executable. This is useful when another command needs the folder added to a search path.

**Data flow**: It asks bundled_zsh_path for the zsh file. If that file exists, it returns its parent directory. If there is no bundled zsh, it returns nothing.

**Call relations**: This is a small follow-up helper for callers that already rely on bundled_zsh_path's platform and file-existence checks.

*Call graph*: calls 1 internal fn (bundled_zsh_path).


##### `CodexPackageLayout::from_exe`  (lines 185–192)

```
fn from_exe(exe_path: &Path) -> Option<Self>
```

**Purpose**: Checks whether an executable appears to be inside Codex's package-style folder layout. That layout has a bin directory for the executable and known sibling directories for resources and PATH helpers.

**Data flow**: It receives an executable path, turns it into a canonical absolute path, and looks at its parent directory. If the executable is inside a directory named bin, it tries to build a full package layout from that bin directory. Otherwise it returns nothing.

**Call relations**: InstallContext::from_exe_with_codex_home uses this before deciding the install method, because package layout is useful even when the install method is npm, standalone, or Other. It relies on canonical_absolute_path and then hands the bin directory to CodexPackageLayout::from_package_bin_dir.

*Call graph*: calls 1 internal fn (canonical_absolute_path); 2 external calls (new, from_package_bin_dir).


##### `CodexPackageLayout::from_package_bin_dir`  (lines 194–206)

```
fn from_package_bin_dir(bin_dir: AbsolutePathBuf) -> Option<Self>
```

**Purpose**: Builds a package-layout description from a candidate bin directory. It confirms that the parent folder really looks like a Codex package before trusting it.

**Data flow**: It receives an absolute bin directory. It moves up to the parent package directory, checks for the metadata file codex-package.json, and then records any existing resource and PATH helper directories. If the metadata file is missing, it returns nothing.

**Call relations**: CodexPackageLayout::from_exe calls this after it has found an executable inside a bin folder. It uses existing_dir so optional directories are included only when they actually exist.

*Call graph*: calls 2 internal fn (existing_dir, parent).


##### `install_method_from_exe`  (lines 209–225)

```
fn install_method_from_exe(
    exe_path: &Path,
    codex_home: Option<&Path>,
    package_layout: Option<&CodexPackageLayout>,
    is_macos: bool,
) -> InstallMethod
```

**Purpose**: Classifies an executable path as standalone, Homebrew, or Other. It is used after npm and Bun have already been ruled out.

**Data flow**: It receives the executable path, optional Codex home path, optional package layout, and whether the system is macOS. It first asks whether the path belongs to a managed standalone release. If not, it checks Homebrew-style prefixes on macOS. It returns the matching InstallMethod or Other.

**Call relations**: InstallContext::from_exe_with_codex_home calls this for path-based install detection. It delegates standalone-specific rules to standalone_install_method, then applies the simpler Homebrew path check itself.

*Call graph*: calls 1 internal fn (standalone_install_method); called by 1 (from_exe_with_codex_home); 1 external calls (starts_with).


##### `standalone_install_method`  (lines 227–252)

```
fn standalone_install_method(
    exe_path: &Path,
    codex_home: Option<&Path>,
    package_layout: Option<&CodexPackageLayout>,
) -> Option<InstallMethod>
```

**Purpose**: Determines whether Codex is running from a managed standalone release under the Codex home folder. This matters because standalone installs can carry their own resources and update behavior.

**Data flow**: It receives the executable path, Codex home path, and optional package layout. It canonicalizes the Codex home path, chooses the release directory from the package layout when present or from the executable's parent directory otherwise, and checks whether that release directory sits under packages/standalone/releases. If it matches, it returns a Standalone install method with optional resources and the current platform; otherwise it returns nothing.

**Call relations**: install_method_from_exe calls this before considering Homebrew or Other. It uses canonical_absolute_path to avoid being fooled by relative paths or links, and standalone_platform to label the release as Unix or Windows.

*Call graph*: calls 2 internal fn (canonical_absolute_path, standalone_platform); called by 1 (install_method_from_exe).


##### `canonical_absolute_path`  (lines 254–257)

```
fn canonical_absolute_path(path: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: Turns a filesystem path into a clean absolute path that this crate's path type can trust. This avoids making install decisions from relative or non-normalized paths.

**Data flow**: It receives a path, asks the operating system to canonicalize it, and then wraps it as an AbsolutePathBuf only if it is truly absolute. If either step fails, it returns nothing.

**Call relations**: Package-layout detection and standalone detection both call this before comparing paths. It is the small safety gate that keeps later path checks consistent.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 2 (from_exe, standalone_install_method); 1 external calls (canonicalize).


##### `standalone_platform`  (lines 259–265)

```
fn standalone_platform() -> StandalonePlatform
```

**Purpose**: Labels the current standalone build as Windows or Unix. Unix here means non-Windows systems such as Linux and macOS.

**Data flow**: It reads the compile-time target platform. If the build is for Windows, it returns Windows; otherwise it returns Unix.

**Call relations**: standalone_install_method includes this label when it builds an InstallMethod::Standalone value, so other code can understand what kind of release is running.

*Call graph*: called by 1 (standalone_install_method); 1 external calls (cfg!).


##### `existing_dir`  (lines 267–269)

```
fn existing_dir(path: AbsolutePathBuf) -> Option<AbsolutePathBuf>
```

**Purpose**: Keeps a path only if it is actually a directory. This prevents Codex from treating missing paths or files as resource folders.

**Data flow**: It receives an absolute path. If the path is a directory, it returns that same path wrapped in Some; otherwise it returns None.

**Call relations**: CodexPackageLayout::from_package_bin_dir uses this for optional package subfolders such as codex-resources and codex-path.

*Call graph*: called by 1 (from_package_bin_dir); 1 external calls (is_dir).


##### `default_rg_command`  (lines 271–277)

```
fn default_rg_command() -> PathBuf
```

**Purpose**: Returns the normal ripgrep executable name for the current platform. Windows uses rg.exe, while Unix-like systems use rg.

**Data flow**: It checks the compile-time target platform and creates a PathBuf containing either rg.exe or rg. Nothing on disk is changed.

**Call relations**: InstallContext::rg_command uses this as both the bundled filename to look for and the fallback system command. Several tests also use it so their expected filenames match the platform.

*Call graph*: called by 6 (rg_command, bundled_file_lookups_ignore_directories, detects_package_layout_independently_from_install_method, detects_standalone_install_from_release_layout, npm_managed_package_keeps_package_layout, standalone_package_layout_keeps_standalone_install_method); 2 external calls (from, cfg!).


##### `zsh_resource_path`  (lines 279–281)

```
fn zsh_resource_path() -> PathBuf
```

**Purpose**: Builds the standard relative path to the bundled zsh executable inside Codex resources. It does not check whether the file exists.

**Data flow**: It starts with the zsh directory name, appends bin, then appends zsh. The result is a relative PathBuf such as zsh/bin/zsh.

**Call relations**: bundled_zsh_path passes this path into bundled_resource. Tests use it to create or compare the same expected bundled zsh location.

*Call graph*: called by 2 (bundled_zsh_path, detects_package_layout_independently_from_install_method); 1 external calls (from).


##### `tests::detects_standalone_install_from_release_layout`  (lines 292–331)

```
fn detects_standalone_install_from_release_layout() -> std::io::Result<()>
```

**Purpose**: Verifies that a legacy standalone release folder is recognized correctly. It also checks that resources inside that release can be found.

**Data flow**: The test creates a temporary Codex home folder with a packages/standalone/releases layout, writes a fake executable and resource files, and computes their canonical paths. It asks from_exe_with_codex_home to classify the executable, then compares the result and resource lookup against the expected standalone context.

**Call relations**: This test exercises the standalone path through from_exe_with_codex_home, including default_rg_command and the resource lookup behavior that standalone_install_method enables.

*Call graph*: calls 3 internal fn (from_exe_with_codex_home, default_rg_command, from_absolute_path); 5 external calls (assert_eq!, cfg!, create_dir_all, write, tempdir).


##### `tests::standalone_rg_falls_back_when_resources_are_missing`  (lines 334–352)

```
fn standalone_rg_falls_back_when_resources_are_missing() -> std::io::Result<()>
```

**Purpose**: Confirms that Codex does not invent a bundled ripgrep path when a standalone release has no resources directory. In that case it should use the normal system command name.

**Data flow**: The test creates a temporary standalone release directory and a fake executable, but no resource folder containing rg. It builds an install context and asks for the rg command. The expected result is the platform default rg name.

**Call relations**: This protects InstallContext::rg_command's fallback path after from_exe_with_codex_home has identified a standalone install without bundled resources.

*Call graph*: calls 1 internal fn (from_exe_with_codex_home); 5 external calls (assert_eq!, cfg!, create_dir_all, write, tempdir).


##### `tests::detects_package_layout_independently_from_install_method`  (lines 355–424)

```
fn detects_package_layout_independently_from_install_method() -> std::io::Result<()>
```

**Purpose**: Checks that the package folder layout is detected even when the install method itself is Other. This matters because bundled resources can still be useful outside a known installer.

**Data flow**: The test creates a temporary package root with bin, codex-resources, codex-path, metadata, a fake executable, a fake helper resource, and possibly zsh. It builds the context without npm, Bun, or Codex home hints. It expects method Other but a populated package layout, then checks rg, resource, and zsh lookups.

**Call relations**: This test drives CodexPackageLayout::from_exe through from_exe_with_codex_home and checks the lookup helpers that depend on package_layout.

*Call graph*: calls 4 internal fn (from_exe_with_codex_home, default_rg_command, zsh_resource_path, from_absolute_path); 5 external calls (assert_eq!, cfg!, create_dir_all, write, tempdir).


##### `tests::standalone_package_layout_keeps_standalone_install_method`  (lines 427–484)

```
fn standalone_package_layout_keeps_standalone_install_method() -> std::io::Result<()>
```

**Purpose**: Verifies the newer package layout still counts as a standalone install when it lives under the standalone releases folder. Package layout and install method should both be preserved.

**Data flow**: The test creates a standalone release directory that also has package metadata, bin, resources, and PATH helper folders. It builds a context with a Codex home path and compares the result to an expected standalone method plus a full package layout. It also checks that the package PATH helper rg and bundled resource are found.

**Call relations**: This test covers the interaction between CodexPackageLayout::from_exe and standalone_install_method. It proves that package-layout detection does not hide the standalone install classification.

*Call graph*: calls 3 internal fn (from_exe_with_codex_home, default_rg_command, from_absolute_path); 5 external calls (assert_eq!, cfg!, create_dir_all, write, tempdir).


##### `tests::npm_managed_package_keeps_package_layout`  (lines 487–515)

```
fn npm_managed_package_keeps_package_layout() -> std::io::Result<()>
```

**Purpose**: Confirms that npm launch detection takes precedence but does not discard package-layout information. Codex can still use bundled PATH helpers from the package.

**Data flow**: The test creates a package-like directory with metadata, bin, and codex-path, then marks the launch as npm-managed. It builds the context and expects InstallMethod::Npm with a package layout still present. It then checks that rg comes from the package PATH directory.

**Call relations**: This test checks the priority rules inside from_exe_with_codex_home and the way InstallContext::rg_command uses package_layout even for npm installs.

*Call graph*: calls 3 internal fn (from_exe_with_codex_home, default_rg_command, from_absolute_path); 6 external calls (assert!, assert_eq!, cfg!, create_dir_all, write, tempdir).


##### `tests::standalone_package_rg_falls_back_when_codex_path_is_missing`  (lines 518–535)

```
fn standalone_package_rg_falls_back_when_codex_path_is_missing() -> std::io::Result<()>
```

**Purpose**: Makes sure a package layout without a codex-path directory does not claim to have a bundled ripgrep command. The safe fallback is the normal rg command name.

**Data flow**: The test creates a package root with metadata and bin but no codex-path directory. It builds a context from the fake executable and asks for the rg command. The expected result is the platform default rg name.

**Call relations**: This test protects the optional-directory behavior in CodexPackageLayout::from_package_bin_dir and the fallback behavior in InstallContext::rg_command.

*Call graph*: calls 1 internal fn (from_exe_with_codex_home); 5 external calls (assert_eq!, cfg!, create_dir_all, write, tempdir).


##### `tests::bundled_file_lookups_ignore_directories`  (lines 538–560)

```
fn bundled_file_lookups_ignore_directories() -> std::io::Result<()>
```

**Purpose**: Checks that bundled file lookup accepts files only, not directories with the same name. This prevents later code from trying to execute or read a folder as if it were a file.

**Data flow**: The test creates a package layout where the supposed resource and rg command paths are directories, not files. It builds the context, asks for rg and the named resource, and expects the normal rg fallback and no bundled resource.

**Call relations**: This test exercises the file checks inside InstallContext::rg_command and InstallContext::bundled_resource after package-layout detection succeeds.

*Call graph*: calls 2 internal fn (from_exe_with_codex_home, default_rg_command); 5 external calls (assert_eq!, cfg!, create_dir_all, write, tempdir).


##### `tests::npm_and_bun_take_precedence`  (lines 563–593)

```
fn npm_and_bun_take_precedence()
```

**Purpose**: Verifies that explicit npm and Bun launch flags override path-based detection. If the wrapper says npm or Bun launched Codex, that is the install method Codex should report.

**Data flow**: The test calls from_exe_with_codex_home twice with a simple fake executable path: once with the npm flag and once with the Bun flag. It expects Npm for the first context and Bun for the second, with no package layout.

**Call relations**: This directly checks the priority order inside from_exe_with_codex_home before install_method_from_exe would be considered.

*Call graph*: calls 1 internal fn (from_exe_with_codex_home); 2 external calls (new, assert_eq!).


##### `tests::brew_is_detected_on_macos_prefixes`  (lines 596–611)

```
fn brew_is_detected_on_macos_prefixes()
```

**Purpose**: Confirms that Homebrew-style paths are recognized as Brew installs on macOS. Homebrew commonly installs under /opt/homebrew or /usr/local.

**Data flow**: The test passes a Homebrew-looking executable path and marks the platform as macOS, without npm, Bun, or Codex home hints. It expects the resulting context to have method Brew and no package layout.

**Call relations**: This test reaches install_method_from_exe through from_exe_with_codex_home and checks the macOS Homebrew fallback after standalone detection does not match.

*Call graph*: calls 1 internal fn (from_exe_with_codex_home); 2 external calls (new, assert_eq!).


### `windows-sandbox-rs/src/helper_materialization.rs`

`io_transport` · `helper launch setup`

The sandbox needs helper executables to run commands, but launching them directly from wherever the main program was installed can be unreliable or unsafe. This file acts like a careful stagehand: before the show starts, it finds the helper executable, checks whether a good copy already exists under the Codex home sandbox bin directory, and copies it there if needed.

The main flow starts with a helper kind, currently only `CommandRunner`. The code finds the source executable next to the current program or inside a bundled resources folder. It then chooses a destination name that includes a version suffix, so different builds do not accidentally reuse the wrong helper. For local development builds, where the version is the placeholder `0.0.0`, it uses the helper file’s size and modification time instead.

Copying is deliberately careful. The helper is first written to a temporary file inside the destination directory, flushed to disk, and then renamed into place. This avoids leaving half-written files behind and helps the file inherit the destination directory’s permissions. A small in-memory cache remembers successful paths so repeated launches do not keep checking the disk. If anything goes wrong, the code logs the problem and returns an older “look next to the executable” path instead of stopping the launch outright.

#### Function details

##### `HelperExecutable::file_name`  (lines 28–32)

```
fn file_name(self) -> &'static str
```

**Purpose**: Returns the actual Windows file name for a helper executable. This lets the rest of the file ask for a helper by meaning, such as `CommandRunner`, instead of repeating the literal `.exe` name everywhere.

**Data flow**: It receives a helper kind → matches it to its packaged executable name → returns that name as text.

**Call relations**: When code needs to find or name the helper, this function supplies the concrete file name. `legacy_lookup`, `sibling_source_path`, and `materialized_file_name` use it as the shared source of truth.

*Call graph*: called by 3 (legacy_lookup, materialized_file_name, sibling_source_path).


##### `HelperExecutable::label`  (lines 34–38)

```
fn label(self) -> &'static str
```

**Purpose**: Returns a short human-readable label for a helper executable. This is used for log messages so people see `command-runner` instead of a Rust enum name.

**Data flow**: It receives a helper kind → converts it to a friendly label → returns that label as text.

**Call relations**: It supports the logging side of helper resolution. When higher-level code reports what it copied or reused, this label makes the message easier to read.


##### `helper_bin_dir`  (lines 49–51)

```
fn helper_bin_dir(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the path to the sandbox’s shared helper binary directory under the Codex home folder. Other code uses this as the one agreed place for copied helper executables.

**Data flow**: It receives the Codex home path → asks the sandbox path helper for the sandbox bin directory → returns that directory path.

**Call relations**: This is the common directory chooser. It feeds destination-building in this file and is also used by other sandbox code when it needs to include the helper directory in allowed read roots.

*Call graph*: called by 7 (helper_destination_for_source, resolve_current_exe_for_launch, copy_runner_into_shared_bin_dir, gather_helper_read_roots, build_payload_roots_preserves_helper_roots_when_read_override_is_provided, build_payload_roots_replaces_full_read_policy_when_read_override_is_provided, gather_read_roots_includes_helper_bin_dir); 1 external calls (sandbox_bin_dir).


##### `legacy_lookup`  (lines 53–60)

```
fn legacy_lookup(kind: HelperExecutable) -> PathBuf
```

**Purpose**: Finds a helper executable using the older layout rules. It is a fallback path when the newer copy-into-sandbox-bin approach cannot be used.

**Data flow**: It receives a helper kind → tries to locate the current program → looks near that program or in its resources folder for the helper → returns that path if found, otherwise returns just the helper file name.

**Call relations**: It is called by `resolve_helper_for_launch` only after copying fails. That keeps older packaging layouts working instead of making helper launch fail immediately.

*Call graph*: calls 2 internal fn (file_name, bundled_executable_path_for_exe); called by 1 (resolve_helper_for_launch); 2 external calls (from, current_exe).


##### `resolve_helper_for_launch`  (lines 62–92)

```
fn resolve_helper_for_launch(
    kind: HelperExecutable,
    codex_home: &Path,
    log_dir: Option<&Path>,
) -> PathBuf
```

**Purpose**: Chooses the executable path that should be launched for a helper. It prefers a verified copy in the sandbox bin directory, but falls back to legacy lookup if copying fails.

**Data flow**: It receives the helper kind, Codex home path, and optional log directory → tries to copy or reuse the helper → logs the chosen path → returns the path to launch. If copying errors, it logs the error and returns a legacy helper path.

**Call relations**: This is the public decision point used when code needs the command runner executable, such as through `find_runner_exe`. It delegates the careful copy work to `copy_helper_if_needed` and the emergency fallback to `legacy_lookup`.

*Call graph*: calls 3 internal fn (copy_helper_if_needed, legacy_lookup, log_note); called by 1 (find_runner_exe); 1 external calls (format!).


##### `resolve_current_exe_for_launch`  (lines 94–117)

```
fn resolve_current_exe_for_launch(codex_home: &Path, fallback_executable: &str) -> PathBuf
```

**Purpose**: Copies the currently running executable into the sandbox helper bin directory and returns the copy’s path. This is useful when the sandbox needs to relaunch the same program from the controlled helper location.

**Data flow**: It receives Codex home and a fallback executable name → gets the current executable path → builds a destination with the same file name under the helper bin directory → copies it if needed → returns the copied path. If current-exe lookup or copying fails, it returns a fallback or the original path and logs the failure.

**Call relations**: This mirrors the helper-copy flow but uses the current executable as the source. It relies on `helper_bin_dir` for the destination and `copy_from_source_if_needed` for safe copying.

*Call graph*: calls 3 internal fn (copy_from_source_if_needed, helper_bin_dir, log_note); 4 external calls (from, sandbox_dir, format!, current_exe).


##### `copy_helper_if_needed`  (lines 119–165)

```
fn copy_helper_if_needed(
    kind: HelperExecutable,
    codex_home: &Path,
    log_dir: Option<&Path>,
) -> Result<PathBuf>
```

**Purpose**: Finds, names, copies, and remembers a helper executable so later launches can use a stable sandbox-local path. It avoids repeated disk work by caching successful results in memory.

**Data flow**: It receives a helper kind, Codex home, and optional log directory → checks the in-memory cache → finds the source helper beside the current executable or in resources → builds the versioned destination path → copies only if the destination is missing or stale → stores and returns the destination path.

**Call relations**: `resolve_helper_for_launch` calls this as its preferred path. Inside, it coordinates smaller helpers: `cached_helper_path`, `sibling_source_path`, `helper_destination_for_source`, `copy_from_source_if_needed`, and `store_helper_path`.

*Call graph*: calls 6 internal fn (cached_helper_path, copy_from_source_if_needed, helper_destination_for_source, sibling_source_path, store_helper_path, log_note); called by 1 (resolve_helper_for_launch); 1 external calls (format!).


##### `cached_helper_path`  (lines 167–171)

```
fn cached_helper_path(cache_key: &str) -> Option<PathBuf>
```

**Purpose**: Looks up whether this process has already resolved a helper path. This saves time and avoids repeated file checks during multiple launches.

**Data flow**: It receives a cache key string → opens a shared in-memory map protected by a mutex, which is a lock that prevents two tasks changing it at once → returns a cloned path if one is stored.

**Call relations**: `copy_helper_if_needed` asks this first. If it returns a path, the copy flow can stop early and reuse the remembered destination.

*Call graph*: called by 1 (copy_helper_if_needed).


##### `store_helper_path`  (lines 173–178)

```
fn store_helper_path(cache_key: String, path: PathBuf)
```

**Purpose**: Records a resolved helper path in the process-wide cache. This lets later calls skip the source lookup and copy check.

**Data flow**: It receives a cache key and path → opens the shared locked map → inserts the key-to-path entry. It does not return a value.

**Call relations**: `copy_helper_if_needed` calls this after a helper has been successfully copied or reused. It completes the cache story that starts with `cached_helper_path`.

*Call graph*: called by 1 (copy_helper_if_needed).


##### `sibling_source_path`  (lines 180–188)

```
fn sibling_source_path(kind: HelperExecutable) -> Result<PathBuf>
```

**Purpose**: Finds the original packaged helper executable near the currently running program. This is how the code discovers what file should be copied into the sandbox bin directory.

**Data flow**: It reads the current executable path from the operating system → uses the helper’s file name → searches beside the executable and in supported resources folders → returns the found source path or an error explaining that the helper was not found.

**Call relations**: `copy_helper_if_needed` uses this before it can build a destination or copy anything. The actual layout search is delegated to `bundled_executable_path_for_exe`.

*Call graph*: calls 2 internal fn (file_name, bundled_executable_path_for_exe); called by 1 (copy_helper_if_needed); 1 external calls (current_exe).


##### `bundled_executable_path_for_exe`  (lines 190–208)

```
fn bundled_executable_path_for_exe(exe: &Path, file_name: &str) -> Option<PathBuf>
```

**Purpose**: Searches for a bundled helper file relative to a given executable. It understands the supported packaging layouts, including direct sibling files and `codex-resources` folders.

**Data flow**: It receives an executable path and helper file name → checks the executable’s directory for the helper → if the executable is in a `bin` folder, checks the package-level resources folder → finally checks a resources folder beside the executable → returns the first existing file path or nothing.

**Call relations**: Both fallback lookup and normal source lookup rely on this layout-aware search. Tests also exercise it directly to lock down the intended priority order.

*Call graph*: called by 7 (legacy_lookup, sibling_source_path, helper_source_lookup_checks_package_resource_dir_for_bin_exe, helper_source_lookup_checks_resource_dir, helper_source_lookup_prefers_direct_sibling_over_resource_dir, helper_source_lookup_prefers_package_resource_dir_over_bin_resource_dir, find_setup_exe_for_current_exe); 2 external calls (new, parent).


##### `helper_destination_for_source`  (lines 210–218)

```
fn helper_destination_for_source(
    kind: HelperExecutable,
    codex_home: &Path,
    source: &Path,
) -> Result<PathBuf>
```

**Purpose**: Builds the final sandbox-bin path where a helper should be materialized. The destination name includes a version-like suffix so old and new helper builds do not collide.

**Data flow**: It receives the helper kind, Codex home, and source file path → computes the suffix from package version or development metadata → creates the materialized file name → joins it under the helper bin directory → returns the full destination path.

**Call relations**: `copy_helper_if_needed` calls this after finding the source helper. It combines `helper_version_suffix`, `materialized_file_name`, and `helper_bin_dir` into one destination decision.

*Call graph*: calls 3 internal fn (helper_bin_dir, helper_version_suffix, materialized_file_name); called by 1 (copy_helper_if_needed).


##### `materialized_file_name`  (lines 220–233)

```
fn materialized_file_name(kind: HelperExecutable, suffix: &str) -> String
```

**Purpose**: Creates the copied helper’s file name by inserting a suffix before the extension. For example, it can turn `codex-command-runner.exe` into `codex-command-runner-1.2.3.exe`.

**Data flow**: It receives a helper kind and suffix → splits the helper’s source file name into name stem and extension → inserts the suffix between them → returns the new file name.

**Call relations**: `helper_destination_for_source` uses this when naming copied helpers. Tests call it directly to make sure the suffix goes before `.exe`, not after it.

*Call graph*: calls 1 internal fn (file_name); called by 3 (helper_destination_for_source, copy_runner_into_shared_bin_dir, materialized_file_name_adds_suffix_before_extension); 2 external calls (new, format!).


##### `helper_version_suffix`  (lines 235–242)

```
fn helper_version_suffix(source: &Path) -> Result<String>
```

**Purpose**: Chooses the suffix used in copied helper file names. Release builds use the package version, while development builds use file metadata so rebuilt helpers get new names.

**Data flow**: It reads the compile-time Cargo package version → if it is not the development sentinel, returns that version → otherwise asks `dev_build_suffix` to build a suffix from the source file.

**Call relations**: `helper_destination_for_source` calls this before naming the destination. A test checks both the release and development behavior depending on how the crate was built.

*Call graph*: calls 1 internal fn (dev_build_suffix); called by 3 (helper_destination_for_source, copy_runner_into_shared_bin_dir, helper_version_suffix_uses_cli_version_or_dev_build_metadata); 1 external calls (env!).


##### `dev_build_suffix`  (lines 244–254)

```
fn dev_build_suffix(source: &Path) -> Result<String>
```

**Purpose**: Creates a unique-enough suffix for local development builds, where the normal package version is the placeholder `0.0.0`. It uses the helper file’s size and modification time as a simple fingerprint.

**Data flow**: It receives the source path → reads file metadata → gets file length and last modified time → converts the time to seconds since the Unix epoch, the standard timestamp starting point → returns a text suffix containing size and time.

**Call relations**: `helper_version_suffix` calls this only for development builds. This helps developers avoid accidentally launching an older copied helper after rebuilding.

*Call graph*: called by 1 (helper_version_suffix); 2 external calls (format!, metadata).


##### `copy_from_source_if_needed`  (lines 256–328)

```
fn copy_from_source_if_needed(source: &Path, destination: &Path) -> Result<CopyOutcome>
```

**Purpose**: Safely copies an executable from a source path to a destination path only when the destination is missing or stale. It avoids partial writes by copying through a temporary file first.

**Data flow**: It receives source and destination paths → checks whether the destination already matches well enough by size and modification time → if fresh, returns `Reused` → otherwise creates the destination directory, copies bytes into a temporary file inside it, flushes the file, removes any stale destination, and renames the temporary file into place → returns `ReCopied`. If another process wins the race and leaves a fresh destination, it accepts that and returns `Reused`.

**Call relations**: This is the low-level copy engine used by `copy_helper_if_needed` and `resolve_current_exe_for_launch`. Tests cover missing destinations, fresh reuse, and shared helper-bin copying.

*Call graph*: calls 1 internal fn (destination_is_fresh); called by 5 (copy_helper_if_needed, resolve_current_exe_for_launch, copy_from_source_if_needed_copies_missing_destination, copy_from_source_if_needed_reuses_fresh_destination, copy_runner_into_shared_bin_dir); 9 external calls (new_in, exists, parent, open, new, create_dir_all, remove_file, rename, copy).


##### `destination_is_fresh`  (lines 330–355)

```
fn destination_is_fresh(source: &Path, destination: &Path) -> Result<bool>
```

**Purpose**: Decides whether an existing destination file is new enough to reuse. It compares file size and modification time instead of reading the whole file.

**Data flow**: It receives source and destination paths → reads source metadata → reads destination metadata, treating a missing destination as not fresh → compares byte length and timestamps → returns true only when the destination has the same size and is at least as new as the source.

**Call relations**: `copy_from_source_if_needed` calls this before copying and again if a rename fails, which helps handle races where another process copied the same helper at the same time.

*Call graph*: called by 1 (copy_from_source_if_needed); 1 external calls (metadata).


##### `tests::copy_from_source_if_needed_copies_missing_destination`  (lines 378–392)

```
fn copy_from_source_if_needed_copies_missing_destination()
```

**Purpose**: Checks that the copy helper creates a destination file when none exists. This protects the basic first-run behavior.

**Data flow**: It creates a temporary source file → calls `copy_from_source_if_needed` with a missing destination → verifies the result says it recopied and that the destination contains the expected bytes.

**Call relations**: This test exercises the low-level copy path directly, proving that the higher-level helper materialization flow has a working copy primitive.

*Call graph*: calls 1 internal fn (copy_from_source_if_needed); 3 external calls (new, assert_eq!, write).


##### `tests::destination_is_fresh_uses_size_and_mtime`  (lines 395–407)

```
fn destination_is_fresh_uses_size_and_mtime()
```

**Purpose**: Checks that freshness depends on both size and modification time. This matters because the copier uses freshness to decide whether it can skip work.

**Data flow**: It writes a destination file, waits, then writes a same-sized source file → verifies the older destination is stale → rewrites the destination → verifies it is now fresh.

**Call relations**: This test protects `destination_is_fresh`, which is the gatekeeper called by `copy_from_source_if_needed` before deciding to reuse an executable.

*Call graph*: 5 external calls (new, assert!, write, sleep, from_secs).


##### `tests::copy_from_source_if_needed_reuses_fresh_destination`  (lines 410–425)

```
fn copy_from_source_if_needed_reuses_fresh_destination()
```

**Purpose**: Checks that an already-good copied helper is reused instead of copied again. This keeps repeated launches efficient and less disruptive.

**Data flow**: It writes a source file → copies it once → calls the copy function again with the same source and destination → verifies the second result is `Reused` and the file contents are unchanged.

**Call relations**: This test confirms the fast path inside `copy_from_source_if_needed`, which higher-level launch resolution depends on for repeated helper launches.

*Call graph*: calls 1 internal fn (copy_from_source_if_needed); 3 external calls (new, assert_eq!, write).


##### `tests::helper_bin_dir_is_under_sandbox_bin`  (lines 428–435)

```
fn helper_bin_dir_is_under_sandbox_bin()
```

**Purpose**: Checks that helper binaries are placed under the expected `.sandbox-bin` directory inside Codex home. This keeps the path contract stable for other sandbox code.

**Data flow**: It creates an example Codex home path → calls `helper_bin_dir` → compares the result to the expected `.sandbox-bin` path.

**Call relations**: This test protects the shared directory choice used by helper materialization and by other code that grants sandbox read access to helper binaries.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::copy_runner_into_shared_bin_dir`  (lines 438–459)

```
fn copy_runner_into_shared_bin_dir()
```

**Purpose**: Checks the complete naming-and-copying pattern for the command runner helper. It proves the source helper can be copied into the shared sandbox bin directory with the expected versioned name.

**Data flow**: It creates a temporary Codex home and fake runner source → computes the suffix and materialized file name → copies the source to that destination → verifies the copy result and file contents.

**Call relations**: This test stitches together `helper_bin_dir`, `helper_version_suffix`, `materialized_file_name`, and `copy_from_source_if_needed`, mirroring the main production path in smaller pieces.

*Call graph*: calls 4 internal fn (copy_from_source_if_needed, helper_bin_dir, helper_version_suffix, materialized_file_name); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `tests::helper_source_lookup_checks_resource_dir`  (lines 462–477)

```
fn helper_source_lookup_checks_resource_dir()
```

**Purpose**: Checks that helper lookup can find a helper inside a `codex-resources` folder beside the main executable. This supports packaged layouts where helpers are separated from the main binary.

**Data flow**: It builds a fake release directory with an executable and a resources folder → writes a helper file into that folder → calls `bundled_executable_path_for_exe` → verifies the resources helper is returned.

**Call relations**: This test protects one of the packaging layouts used by both `legacy_lookup` and `sibling_source_path`.

*Call graph*: calls 1 internal fn (bundled_executable_path_for_exe); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `tests::helper_source_lookup_checks_package_resource_dir_for_bin_exe`  (lines 480–497)

```
fn helper_source_lookup_checks_package_resource_dir_for_bin_exe()
```

**Purpose**: Checks that when the main executable is inside a `bin` folder, lookup also checks the package-level `codex-resources` folder. This supports installer-style directory layouts.

**Data flow**: It creates a fake package with `bin/codex.exe` and `codex-resources/codex-command-runner.exe` → calls the bundled lookup helper → verifies it finds the package-level resource.

**Call relations**: This test locks down the package-layout branch inside `bundled_executable_path_for_exe`, which source discovery and legacy fallback both rely on.

*Call graph*: calls 1 internal fn (bundled_executable_path_for_exe); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `tests::helper_source_lookup_prefers_package_resource_dir_over_bin_resource_dir`  (lines 500–520)

```
fn helper_source_lookup_prefers_package_resource_dir_over_bin_resource_dir()
```

**Purpose**: Checks the priority order when both package-level and bin-level resource folders contain a helper. The package-level resources folder should win.

**Data flow**: It creates both possible resource locations with different helper files → calls `bundled_executable_path_for_exe` for an executable in `bin` → verifies the package-level helper path is selected.

**Call relations**: This test documents and protects a subtle lookup rule inside `bundled_executable_path_for_exe`, preventing future changes from accidentally choosing the wrong bundled helper.

*Call graph*: calls 1 internal fn (bundled_executable_path_for_exe); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `tests::helper_source_lookup_prefers_direct_sibling_over_resource_dir`  (lines 523–540)

```
fn helper_source_lookup_prefers_direct_sibling_over_resource_dir()
```

**Purpose**: Checks that a helper placed directly beside the main executable is preferred over one in the resources folder. This preserves the simplest and most direct layout.

**Data flow**: It creates a fake executable, a sibling helper, and a resources helper → calls the bundled lookup helper → verifies the sibling helper path is returned.

**Call relations**: This test protects the first lookup choice in `bundled_executable_path_for_exe`, which affects both normal helper copying and legacy fallback.

*Call graph*: calls 1 internal fn (bundled_executable_path_for_exe); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `tests::helper_version_suffix_uses_cli_version_or_dev_build_metadata`  (lines 543–554)

```
fn helper_version_suffix_uses_cli_version_or_dev_build_metadata()
```

**Purpose**: Checks that helper destination suffixes match the build type. Release builds should use the package version, while development builds should use source file metadata.

**Data flow**: It writes a temporary source executable → calls `helper_version_suffix` → compares the result either to `dev_build_suffix` for the development sentinel version or to the compile-time package version.

**Call relations**: This test protects `helper_version_suffix`, which feeds destination naming through `helper_destination_for_source`.

*Call graph*: calls 1 internal fn (helper_version_suffix); 4 external calls (new, assert_eq!, env!, write).


##### `tests::materialized_file_name_adds_suffix_before_extension`  (lines 557–561)

```
fn materialized_file_name_adds_suffix_before_extension()
```

**Purpose**: Checks that version suffixes are inserted before the `.exe` extension. This keeps copied helper names readable and valid as Windows executables.

**Data flow**: It asks `materialized_file_name` to name the command runner with a test suffix → compares the result to the expected `codex-command-runner-test-suffix.exe` string.

**Call relations**: This test protects the file-name formatting used when `helper_destination_for_source` builds sandbox-bin paths.

*Call graph*: calls 1 internal fn (materialized_file_name); 1 external calls (assert_eq!).


### Execution environment modeling
These files define how startup environments are provided, selected, validated, and captured for local execution contexts.

### `core/src/shell_snapshot.rs`

`domain_logic` · `turn setup and cleanup`

When a user has a customized terminal, important behavior can live in startup files: aliases, shell functions, options, and exported variables. This file captures that setup into a temporary “snapshot” script. Think of it like taking a photo of a workbench before starting a task, so the next worker can arrange the tools the same way.

The main type, ShellSnapshot, is a small switchable service. If enabled, it looks at the current turn environment, skips remote environments, finds the local shell and working directory, and writes a snapshot file under the Codex home directory. The snapshot is first written to a temporary path, then tested by sourcing it in a shell, and only then renamed into its final path. That prevents broken half-written files from being used.

The file supports Bash, Zsh, and generic sh snapshot creation. PowerShell has a script generator, but snapshot writing currently rejects PowerShell and Windows cmd before capture. Snapshot creation is time-limited so a hanging shell startup file cannot stall the system forever.

Old snapshot files are cleaned in the background. Files for the active session are kept, while files without a matching session record, or with an old session record, are deleted. A ShellSnapshotFile also deletes its own file when dropped, so snapshots behave like temporary tickets that disappear when no longer needed.

#### Function details

##### `ShellSnapshot::new`  (lines 49–63)

```
fn new(
        codex_home: AbsolutePathBuf,
        session_id: ThreadId,
        session_telemetry: SessionTelemetry,
        state_db: Option<StateDbHandle>,
    ) -> Self
```

**Purpose**: Creates an enabled shell snapshot service for one session. It stores the Codex home directory, the session id, telemetry reporting, and optional state database access so later snapshot work has everything it needs.

**Data flow**: Inputs are the Codex home path, session id, telemetry object, and optional state database handle. The function wraps them in shared storage so asynchronous tasks can safely reuse the same settings, then returns a ShellSnapshot that is ready to build snapshot files.

**Call relations**: Session setup code calls this when shell snapshotting should be available. The returned object is later used by the build path, which reads this saved configuration before creating any files.

*Call graph*: called by 1 (new); 1 external calls (new).


##### `ShellSnapshot::disabled`  (lines 65–67)

```
fn disabled() -> Self
```

**Purpose**: Creates a shell snapshot service that deliberately does nothing. This is useful for tests, unsupported situations, or configurations where capturing the shell should be skipped.

**Data flow**: There are no inputs. The function returns a ShellSnapshot with no saved configuration, and later build attempts will immediately produce no snapshot.

**Call relations**: Several environment-resolution and session-construction paths call this when they need a harmless placeholder. Its absence of configuration is what makes ShellSnapshot::build stop before doing any disk or shell work.

*Call graph*: called by 7 (latest_environment_update_wins_while_previous_resolution_is_pending, local_environment_uses_configured_shell, resolve_turn_environments, new, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, resolved_environments_for_configuration).


##### `ShellSnapshot::build`  (lines 69–83)

```
async fn build(
        self,
        environment: TurnEnvironment,
    ) -> Option<Arc<ShellSnapshotFile>>
```

**Purpose**: Tries to create a snapshot for the current turn, if snapshotting is enabled and the environment is local. It is the public async entry point for turning a turn environment into a snapshot file.

**Data flow**: It receives a TurnEnvironment, checks whether this ShellSnapshot has configuration, rejects remote environments, reads the chosen shell, and converts the working directory to a local absolute path. If all of that succeeds, it passes the configuration, directory, and shell onward and returns an optional shared ShellSnapshotFile.

**Call relations**: This function sits at the boundary between turn environment preparation and actual snapshot creation. It gathers the practical inputs, then hands them to ShellSnapshot::build_for_cwd for timed creation and telemetry reporting.

*Call graph*: calls 1 internal fn (cwd); 2 external calls (clone, build_for_cwd).


##### `ShellSnapshot::build_for_cwd`  (lines 85–116)

```
async fn build_for_cwd(
        config: Arc<ShellSnapshotConfig>,
        cwd: AbsolutePathBuf,
        shell: Shell,
    ) -> Option<Arc<ShellSnapshotFile>>
```

**Purpose**: Creates a snapshot for a specific local directory and records whether the attempt succeeded. It wraps the real work with tracing and telemetry so the system can observe snapshot speed and failures.

**Data flow**: Inputs are shared snapshot configuration, a current working directory, and a shell description. It starts a timer, calls ShellSnapshot::try_create, records success or a simple failure reason, increments a telemetry counter, and returns the completed file wrapped for shared use if creation worked.

**Call relations**: ShellSnapshot::build calls this after it has confirmed the environment is suitable. This function delegates the file-making work to ShellSnapshot::try_create and then converts the result into the optional shared file used by the rest of the turn.

*Call graph*: calls 1 internal fn (try_create); 2 external calls (info_span!, vec!).


##### `ShellSnapshot::try_create`  (lines 118–178)

```
async fn try_create(
        codex_home: &AbsolutePathBuf,
        session_id: ThreadId,
        session_cwd: &AbsolutePathBuf,
        shell: &Shell,
        state_db: Option<StateDbHandle>,
    ) ->
```

**Purpose**: Performs the full snapshot-file creation sequence: choose names, start cleanup, write a temporary snapshot, validate it, and finalize it. It is careful to avoid leaving broken final files behind.

**Data flow**: Inputs are Codex home, session id, session working directory, shell, and optional state database. It chooses a file extension based on shell type, builds a unique final path and temporary path, starts background cleanup of old files, writes the snapshot to the temporary path, tests that the file can be loaded, renames it into place, and returns a ShellSnapshotFile. On failure it removes the temporary file when needed and returns a short reason string.

**Call relations**: ShellSnapshot::build_for_cwd uses this as the central creator. During the sequence it calls cleanup_stale_snapshots in the background, write_shell_snapshot to produce the file contents, validate_snapshot to test the result, and remove_snapshot_file when cleanup is needed.

*Call graph*: calls 5 internal fn (cleanup_stale_snapshots, remove_snapshot_file, validate_snapshot, write_shell_snapshot, join); called by 3 (build_for_cwd, try_create_creates_and_deletes_snapshot_file, try_create_uses_distinct_generation_paths); 8 external calls (now, format!, rename, spawn, error!, info!, warn!, clone).


##### `ShellSnapshotFile::path`  (lines 182–184)

```
fn path(&self) -> AbsolutePathBuf
```

**Purpose**: Returns the filesystem path to the snapshot file. Callers use this when they need to source or otherwise refer to the generated script.

**Data flow**: It reads the stored absolute path from the ShellSnapshotFile, clones it, and returns the copy. The original object keeps ownership of its cleanup responsibility.

**Call relations**: After ShellSnapshot::try_create returns a ShellSnapshotFile, later code can call this method to learn where the snapshot lives without taking the path away from the file wrapper.

*Call graph*: 1 external calls (clone).


##### `ShellSnapshotFile::drop`  (lines 188–195)

```
fn drop(&mut self)
```

**Purpose**: Deletes the snapshot file when its wrapper object is no longer used. This keeps temporary shell snapshots from piling up during normal operation.

**Data flow**: When Rust drops the ShellSnapshotFile, this method reads its stored path and tries to remove that file from disk. It returns nothing; if deletion fails, it only writes a warning log.

**Call relations**: This is called automatically by Rust’s cleanup system, not directly by the snapshot builder. It complements cleanup_stale_snapshots by removing the normal, current snapshot as soon as the owning object goes away.

*Call graph*: 2 external calls (remove_file, warn!).


##### `write_shell_snapshot`  (lines 198–225)

```
async fn write_shell_snapshot(
    shell_type: ShellType,
    output_path: &AbsolutePathBuf,
    cwd: &AbsolutePathBuf,
) -> Result<()>
```

**Purpose**: Writes the actual snapshot script to disk. It captures the shell’s current customizations, trims away startup noise, creates the destination directory, and saves the cleaned script.

**Data flow**: Inputs are a shell type, output path, and working directory. The function rejects unsupported PowerShell and cmd creation, finds the executable shell, asks capture_snapshot for raw text, uses strip_snapshot_preamble to keep only the intended snapshot section, creates the parent directory if needed, and writes the file. It returns success or a detailed error.

**Call relations**: ShellSnapshot::try_create calls this before validation. It depends on capture_snapshot for the live shell output and strip_snapshot_preamble to remove any unrelated text printed by startup files.

*Call graph*: calls 5 internal fn (get_shell, capture_snapshot, strip_snapshot_preamble, display, parent); called by 1 (try_create); 3 external calls (bail!, create_dir_all, write).


##### `capture_snapshot`  (lines 227–236)

```
async fn capture_snapshot(shell: &Shell, cwd: &AbsolutePathBuf) -> Result<String>
```

**Purpose**: Runs the right shell-specific script to print a snapshot of aliases, functions, options, and exports. Each shell has slightly different commands, so this chooses the correct recipe.

**Data flow**: Inputs are a Shell and a working directory. The function checks the shell type, builds or selects the matching snapshot script, runs it through run_shell_script, and returns the printed text. For unsupported cmd it returns an error.

**Call relations**: write_shell_snapshot calls this to get raw snapshot content. It hands off to zsh_snapshot_script, bash_snapshot_script, sh_snapshot_script, or powershell_snapshot_script to get the script text, then relies on run_shell_script to execute it.

*Call graph*: calls 5 internal fn (bash_snapshot_script, powershell_snapshot_script, run_shell_script, sh_snapshot_script, zsh_snapshot_script); called by 1 (write_shell_snapshot); 1 external calls (bail!).


##### `strip_snapshot_preamble`  (lines 238–245)

```
fn strip_snapshot_preamble(snapshot: &str) -> Result<String>
```

**Purpose**: Removes any text printed before the real snapshot begins. This protects the saved script from greetings, warnings, or other output produced by shell startup files.

**Data flow**: It receives the raw snapshot output as text, searches for the marker line “# Snapshot file,” and returns everything from that marker onward. If the marker is missing, it returns an error because the output cannot be trusted as a snapshot.

**Call relations**: write_shell_snapshot calls this immediately after capture_snapshot. It acts as a filter between noisy shell output and the clean file that will later be validated.

*Call graph*: called by 1 (write_shell_snapshot); 1 external calls (bail!).


##### `validate_snapshot`  (lines 247–263)

```
async fn validate_snapshot(
    shell: &Shell,
    snapshot_path: &AbsolutePathBuf,
    cwd: &AbsolutePathBuf,
) -> Result<()>
```

**Purpose**: Checks that the generated snapshot can actually be loaded by the target shell. This catches broken syntax before the temporary file is promoted to the final snapshot file.

**Data flow**: Inputs are the shell, snapshot path, and working directory. It builds a small script that turns on fail-fast behavior and sources the snapshot file, then runs that script with a timeout. It returns success if the shell accepts the file, or an error if loading fails or times out.

**Call relations**: ShellSnapshot::try_create calls this after writing the temporary file. It uses run_script_with_timeout directly because validation should not use a login shell; it only needs to test the snapshot file itself.

*Call graph*: calls 2 internal fn (run_script_with_timeout, display); called by 1 (try_create); 1 external calls (format!).


##### `run_shell_script`  (lines 265–274)

```
async fn run_shell_script(shell: &Shell, script: &str, cwd: &AbsolutePathBuf) -> Result<String>
```

**Purpose**: Runs a shell script as a login-style shell command with the standard snapshot timeout. A login-style shell is used so normal shell startup behavior is included while capturing the environment.

**Data flow**: It receives a shell, script text, and working directory. It forwards those values to run_script_with_timeout with the fixed snapshot timeout and login-shell mode enabled, then returns the command’s standard output as text.

**Call relations**: capture_snapshot calls this after choosing the shell-specific script. This function is a small convenience wrapper around run_script_with_timeout for the capture phase.

*Call graph*: calls 1 internal fn (run_script_with_timeout); called by 1 (capture_snapshot).


##### `run_script_with_timeout`  (lines 276–312)

```
async fn run_script_with_timeout(
    shell: &Shell,
    script: &str,
    snapshot_timeout: Duration,
    use_login_shell: bool,
    cwd: &AbsolutePathBuf,
) -> Result<String>
```

**Purpose**: Executes a shell command safely and stops waiting if it takes too long. This prevents a slow or stuck shell startup file from blocking the rest of the system.

**Data flow**: Inputs are the shell, script text, timeout length, whether to use login-shell behavior, and working directory. It asks the Shell object for the command-line arguments, starts the process with no standard input, runs it in the requested directory, detaches it from the terminal on Unix, kills it if the future is dropped, waits with a timeout, checks the exit status, and returns standard output as text. If the process fails, times out, or cannot start, it returns an error with context.

**Call relations**: run_shell_script uses this for snapshot capture, and validate_snapshot uses it for testing a completed file. It is the shared process-running engine underneath both steps.

*Call graph*: calls 2 internal fn (derive_exec_args, name); called by 2 (run_shell_script, validate_snapshot); 5 external calls (null, from_utf8_lossy, bail!, new, timeout).


##### `excluded_exports_regex`  (lines 314–316)

```
fn excluded_exports_regex() -> String
```

**Purpose**: Builds the shell-pattern text for environment variables that should not be written into snapshots. PWD and OLDPWD are skipped because they describe the shell’s current and previous directories, which should not be frozen into a reusable setup file.

**Data flow**: It reads the fixed list of excluded export variable names and joins them with the regex “or” symbol. The returned string is inserted into shell scripts so those variables can be filtered out.

**Call relations**: The Bash, Zsh, and sh script builders call this while constructing their capture scripts. It gives all of them the same exclusion rule.

*Call graph*: called by 3 (bash_snapshot_script, sh_snapshot_script, zsh_snapshot_script).


##### `zsh_snapshot_script`  (lines 318–360)

```
fn zsh_snapshot_script() -> String
```

**Purpose**: Builds the script used to capture a Zsh environment. The produced script loads the user’s Zsh startup file when available, then prints replayable definitions for functions, options, aliases, and exported variables.

**Data flow**: It gets the excluded variable pattern from excluded_exports_regex, inserts that pattern into a Zsh script template, and returns the final script text. When later run, that script prints a marked snapshot section and counts for the captured categories.

**Call relations**: capture_snapshot calls this when the selected shell is Zsh, then passes the returned script to run_shell_script. The exclusion helper keeps its export filtering consistent with other Unix-like shells.

*Call graph*: calls 1 internal fn (excluded_exports_regex); called by 1 (capture_snapshot).


##### `bash_snapshot_script`  (lines 362–402)

```
fn bash_snapshot_script() -> String
```

**Purpose**: Builds the script used to capture a Bash environment. The script loads the user’s Bash startup file when appropriate and prints commands that can recreate functions, enabled options, aliases, and exported variables.

**Data flow**: It reads the shared excluded export pattern, substitutes it into a Bash script template, and returns the completed text. When executed later, the script emits a clean snapshot starting at the marker line.

**Call relations**: capture_snapshot calls this for Bash and then runs the result through run_shell_script. It shares excluded_exports_regex with the Zsh and sh builders so directory-specific variables are not saved.

*Call graph*: calls 1 internal fn (excluded_exports_regex); called by 1 (capture_snapshot).


##### `sh_snapshot_script`  (lines 404–470)

```
fn sh_snapshot_script() -> String
```

**Purpose**: Builds the script used to capture a generic POSIX-style sh environment. Because sh varies across systems, the script checks which features are available before trying to print functions, options, aliases, and exports.

**Data flow**: It gets the excluded export pattern, inserts it into a portable shell script template, and returns that script text. The script is defensive: it uses typeset or declare only if present, handles missing alias or export support, and falls back to env output when needed.

**Call relations**: capture_snapshot calls this when the shell type is Sh. Like the Bash and Zsh builders, it uses excluded_exports_regex so the same variables are omitted from saved exports.

*Call graph*: calls 1 internal fn (excluded_exports_regex); called by 1 (capture_snapshot).


##### `powershell_snapshot_script`  (lines 472–495)

```
fn powershell_snapshot_script() -> &'static str
```

**Purpose**: Provides a PowerShell script that would print a replayable snapshot of functions, aliases, and environment variables. It is present as the PowerShell recipe, although snapshot writing currently rejects PowerShell before using it.

**Data flow**: It takes no inputs and returns a fixed PowerShell script as text. That script, when run, would print the snapshot marker, commands to remove aliases, function definitions, alias recreation commands, and environment variable assignments.

**Call relations**: capture_snapshot selects this script for PowerShell. In the current creation path, write_shell_snapshot rejects PowerShell earlier, so this is mainly ready for future support or alternate callers.

*Call graph*: called by 1 (capture_snapshot).


##### `cleanup_stale_snapshots`  (lines 500–561)

```
async fn cleanup_stale_snapshots(
    codex_home: &AbsolutePathBuf,
    active_session_id: ThreadId,
    state_db: Option<StateDbHandle>,
) -> Result<()>
```

**Purpose**: Deletes old or orphaned snapshot files from the snapshot directory. This prevents temporary shell-state files from accumulating forever.

**Data flow**: Inputs are the Codex home directory, the currently active session id, and optional state database access. The function opens the snapshot directory, ignores missing directories, scans files, extracts a session id from each filename, keeps files for the active session, checks whether each other session still has a rollout record, and removes files with no matching record or with a record older than the retention window. It returns success or an error from directory scanning and lookup work.

**Call relations**: ShellSnapshot::try_create starts this in the background before making a new snapshot. During cleanup it uses snapshot_session_id_from_file_name to understand filenames, find_thread_path_by_id_str to connect a snapshot to its session record, and remove_snapshot_file to delete unwanted files.

*Call graph*: calls 4 internal fn (remove_snapshot_file, snapshot_session_id_from_file_name, find_thread_path_by_id_str, join); called by 1 (try_create); 5 external calls (now, metadata, read_dir, to_string, warn!).


##### `remove_snapshot_file`  (lines 563–567)

```
async fn remove_snapshot_file(path: &Path)
```

**Purpose**: Deletes one snapshot file and logs a warning if deletion fails. It is the shared safe-delete helper for cleanup paths.

**Data flow**: It receives a filesystem path, tries to remove that file asynchronously, and returns nothing. A failure does not stop the caller; it is recorded as a warning.

**Call relations**: ShellSnapshot::try_create uses this when a temporary snapshot fails validation or finalization. cleanup_stale_snapshots uses it when removing old, invalid, or orphaned snapshot files.

*Call graph*: called by 2 (try_create, cleanup_stale_snapshots); 2 external calls (remove_file, warn!).


##### `snapshot_session_id_from_file_name`  (lines 569–579)

```
fn snapshot_session_id_from_file_name(file_name: &str) -> Option<&str>
```

**Purpose**: Extracts the session id embedded in a snapshot filename. This lets cleanup decide which session a file belongs to without opening the file contents.

**Data flow**: It receives a filename string, splits off the final extension, and recognizes final snapshot extensions like sh and ps1 as well as temporary names beginning with tmp-. For final snapshot names with a generation suffix, it returns only the session id before that suffix; for unrecognized names it returns nothing.

**Call relations**: cleanup_stale_snapshots calls this while scanning the snapshot directory. If this function cannot identify a session id, cleanup treats the file as not belonging to a known snapshot format and removes it.

*Call graph*: called by 1 (cleanup_stale_snapshots).


### `exec-server/src/environment.rs`

`domain_logic` · `startup, environment selection, and command/filesystem request handling`

Codex needs a safe, consistent way to decide where commands run and where file operations happen. Sometimes that is the user's own computer. Sometimes it is a remote exec-server. This file is the switchboard for that choice.

The main piece is EnvironmentManager. It stores named environments, such as "local" or "remote", and remembers which one is the default. It can build this list from user configuration, from the older CODEX_EXEC_SERVER_URL environment variable, or directly for tests. It also supports adding remote environments later, including a Noise rendezvous transport, which means an authenticated encrypted connection.

Each Environment is the actual bundle Codex uses once a choice is made. It contains a process backend for starting commands, a filesystem backend for reading and writing files, an HTTP client, and a small information provider that can say what shell is available. Local environments use local process and filesystem implementations. Remote environments create lazy clients, meaning the network connection is not opened immediately; it is opened only when something actually needs the remote server.

A key behavior is disabled mode. If the configured exec-server URL is "none", the manager has no default environment and no local fallback. That is how the rest of Codex knows shell and filesystem tools should not be offered.

#### Function details

##### `EnvironmentManager::default_for_tests`  (lines 61–71)

```
fn default_for_tests() -> Self
```

**Purpose**: Builds a simple test manager with one local environment selected as the default. Tests use it when they need normal environment behavior without reading real user configuration.

**Data flow**: No outside input is needed. It creates a map containing a local Environment, marks "local" as the default, and returns an EnvironmentManager whose local runtime paths are not configured.

**Call relations**: Many tests call this as a ready-made manager. It relies on Environment::default_for_tests to build the local environment object placed in the manager.

*Call graph*: calls 1 internal fn (default_for_tests); called by 73 (runtime_start_args_use_remote_thread_config_loader_when_configured, start_test_client_with_capacity, guardian_command_execution_notifications_wrap_review_lifecycle, interrupted_subagent_activity_removes_missing_thread_watch, turn_started_omits_active_snapshot_items, start_test_client_with_capacity, refresh_test_state, build_test_processor, get_conversation_summary_by_thread_id_reads_pathless_store_thread, mcp_resource_read_returns_error_for_unknown_thread (+15 more)); 3 external calls (new, from, new).


##### `EnvironmentManager::without_environments`  (lines 74–81)

```
fn without_environments() -> Self
```

**Purpose**: Builds a manager with no environments at all. This is useful for disabled-mode tests or for callers that want to add environments manually later.

**Data flow**: It starts from nothing, creates an empty environment map, sets no default, sets no local environment, and returns the manager.

**Call relations**: Tests use this when they need to prove that Codex does not silently fall back to the host machine. Later code can add remote entries with upsert_environment or upsert_noise_environment.

*Call graph*: called by 10 (no_local_runtime_fails_local_stdio_but_keeps_local_http_server, local_http_does_not_require_local_stdio_availability, local_stdio_requires_local_stdio_availability, unknown_explicit_environment_is_rejected, unavailable_environment_does_not_fall_back_to_host_filesystem, default_thread_environment_selections_empty_when_default_disabled, disabled_environment_manager_has_no_default_or_local_environment, environment_manager_rejects_empty_remote_environment_url, environment_manager_upserts_named_remote_environment, noise_environment_refreshes_bundle_for_each_connection_attempt); 2 external calls (new, new).


##### `EnvironmentManager::create_for_tests`  (lines 84–89)

```
async fn create_for_tests(
        exec_server_url: Option<String>,
        local_runtime_paths: Option<ExecServerRuntimePaths>,
    ) -> Self
```

**Purpose**: Creates a test manager from a raw exec-server URL value, using the same legacy interpretation as production. It lets tests check local, remote, empty, and disabled URL cases.

**Data flow**: It receives an optional URL string and optional local runtime paths. It passes both into the default-provider path and returns the resulting manager.

**Call relations**: Test setup code calls this when it wants behavior close to the old CODEX_EXEC_SERVER_URL flow. It delegates the real construction to EnvironmentManager::from_default_provider_url.

*Call graph*: called by 12 (runtime_start_args_forward_environment_manager, explicit_remote_stdio_and_http_accept_named_environment, remote_stdio_requires_absolute_cwd, default_thread_environment_selections_use_manager_default_id, matching_environment_id_and_cwd_reuse_resolved_environment, build_with_home_and_base_url, environment_manager_carries_local_runtime_paths, environment_manager_includes_local_for_default_provider_without_url, environment_manager_normalizes_empty_url, environment_manager_omits_default_provider_local_lookup_when_default_disabled (+2 more)); 1 external calls (from_default_provider_url).


##### `EnvironmentManager::from_codex_home`  (lines 97–103)

```
async fn from_codex_home(
        codex_home: impl AsRef<std::path::Path>,
        local_runtime_paths: Option<ExecServerRuntimePaths>,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: Builds an environment manager from the user's Codex home directory. This is the production path that honors an environments.toml file when present, otherwise preserving older environment-variable behavior.

**Data flow**: It receives a CODEX_HOME path and optional local runtime paths. It loads an environment provider from that home directory, asks the provider for a snapshot, then turns that snapshot into an EnvironmentManager.

**Call relations**: Startup code calls this when launching Codex with normal user configuration. It hands off file/config interpretation to environment_provider_from_codex_home and validation/building to from_snapshot.

*Call graph*: calls 1 internal fn (environment_provider_from_codex_home); called by 8 (run_main_with_transport_options, list_accessible_connectors_from_mcp_tools_with_options_and_status, toml_default_thread_environment_selections_include_local_and_remote, build_prompt_input, run_main, run_main, run_main, run_main); 2 external calls (as_ref, from_snapshot).


##### `EnvironmentManager::from_env`  (lines 107–112)

```
async fn from_env(
        local_runtime_paths: Option<ExecServerRuntimePaths>,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: Builds a manager using only environment variables, without reading CODEX_HOME configuration files. This preserves the older CODEX_EXEC_SERVER_URL setup path.

**Data flow**: It receives optional local runtime paths. It creates the default environment provider from process environment variables, gets a snapshot, validates it, and returns the manager.

**Call relations**: Command startup and archive-server setup use this when they want environment-variable configuration only. It delegates final construction to from_snapshot.

*Call graph*: calls 1 internal fn (from_env); called by 4 (run_main_with_transport_options, run_main, run_main, start_app_server_for_archive_command); 1 external calls (from_snapshot).


##### `EnvironmentManager::from_default_provider_url`  (lines 114–123)

```
async fn from_default_provider_url(
        exec_server_url: Option<String>,
        local_runtime_paths: Option<ExecServerRuntimePaths>,
    ) -> Self
```

**Purpose**: Builds a manager from a single raw URL value using the default provider rules. It is mainly a test helper and assumes those rules should always produce valid data.

**Data flow**: It receives an optional URL and optional runtime paths. It creates a DefaultEnvironmentProvider, gets its snapshot, builds a manager, and panics if that unexpectedly fails.

**Call relations**: EnvironmentManager::create_for_tests calls this. It is a thin bridge between test inputs and the shared from_snapshot builder.

*Call graph*: calls 1 internal fn (new); 2 external calls (from_snapshot, panic!).


##### `EnvironmentManager::create_for_tests_with_local`  (lines 127–137)

```
async fn create_for_tests_with_local(
        exec_server_url: Option<String>,
        local_runtime_paths: ExecServerRuntimePaths,
    ) -> Self
```

**Purpose**: Builds a test manager that always includes an explicit local environment, even if the provider default points elsewhere. Tests use it when both local and remote choices must be available.

**Data flow**: It receives an optional URL and required local runtime paths. It creates a provider snapshot, forces include_local to true, and builds a manager from that snapshot.

**Call relations**: Tests that exercise environment selection call this. It reuses DefaultEnvironmentProvider for URL interpretation and from_snapshot for validation.

*Call graph*: calls 1 internal fn (new); called by 2 (latest_environment_update_wins_while_previous_resolution_is_pending, build_with_home_and_base_url); 2 external calls (from_snapshot, panic!).


##### `EnvironmentManager::from_snapshot`  (lines 139–202)

```
fn from_snapshot(
        snapshot: EnvironmentProviderSnapshot,
        local_runtime_paths: Option<ExecServerRuntimePaths>,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: Turns a provider's environment snapshot into a validated EnvironmentManager. This is the central gatekeeper that rejects bad IDs, duplicate entries, missing defaults, and local setups without runtime paths.

**Data flow**: It receives a snapshot containing configured environments, a default choice, and whether to include local. It optionally creates the local environment, inserts remote/configured environments, validates reserved and empty names, checks the default exists, and returns either a manager or an error.

**Call relations**: Production constructors and tests all funnel through this function after configuration has been read. It calls Environment::local when local access is requested and stores all environments in the shared registry.

*Call graph*: calls 1 internal fn (local); called by 7 (environment_manager_builds_from_snapshot, environment_manager_disables_provider_default, environment_manager_rejects_empty_environment_id, environment_manager_rejects_provider_supplied_local_environment, environment_manager_rejects_unknown_provider_default, environment_manager_snapshot_without_local_environment_disables_local_default, environment_manager_uses_explicit_provider_default); 7 external calls (clone, new, with_capacity, new, Protocol, format!, from).


##### `EnvironmentManager::default_environment`  (lines 205–209)

```
fn default_environment(&self) -> Option<Arc<Environment>>
```

**Purpose**: Returns the Environment selected as the default, if one is configured. Callers use this as the main signal for whether Codex should offer shell and filesystem tools.

**Data flow**: It reads the stored default environment ID. If there is one, it looks that ID up in the environment map and returns a shared pointer to the Environment; otherwise it returns nothing.

**Call relations**: Higher-level code asks this during setup and request handling to choose where work should run. default_or_local_environment also uses it before trying the local fallback.

*Call graph*: called by 2 (default_or_local_environment, config_cwd_for_app_server_target).


##### `EnvironmentManager::default_environment_id`  (lines 212–214)

```
fn default_environment_id(&self) -> Option<&str>
```

**Purpose**: Returns the name of the default environment without fetching the Environment itself. This is useful for reporting and for initializing new sessions.

**Data flow**: It reads the manager's optional default ID and returns it as borrowed text if present.

**Call relations**: Callers use this alongside environment selection to know which named environment is active. It does not call other project code.


##### `EnvironmentManager::default_environment_ids`  (lines 217–234)

```
fn default_environment_ids(&self) -> Vec<String>
```

**Purpose**: Returns environment IDs in the order new threads should consider them: default first, then the rest. If there is no default, it returns an empty list.

**Data flow**: It reads the default ID, locks the environment map for reading, creates a list beginning with the default, appends every other environment ID, and returns that list.

**Call relations**: Thread-startup selection code calls this to seed available environment choices. It is careful to preserve the default as the first item.

*Call graph*: called by 1 (default_thread_environment_selections); 2 external calls (new, with_capacity).


##### `EnvironmentManager::try_local_environment`  (lines 237–239)

```
fn try_local_environment(&self) -> Option<Arc<Environment>>
```

**Purpose**: Returns the local Environment if the manager was configured to include one. It does not create a local fallback on the fly.

**Data flow**: It reads the stored local_environment field. If present, it clones the shared pointer and returns it; otherwise it returns nothing.

**Call relations**: Selection and test code call this to check whether local execution is explicitly available. It is also used by default_or_local_environment.


##### `EnvironmentManager::default_or_local_environment`  (lines 242–245)

```
fn default_or_local_environment(&self) -> Option<Arc<Environment>>
```

**Purpose**: Returns the default environment if available, otherwise the local environment if one was explicitly configured. This gives callers a safe fallback only when local access is allowed.

**Data flow**: It first asks for the default Environment. If that is missing, it asks for the stored local Environment. The result is either a shared Environment pointer or nothing.

**Call relations**: Callers use this when they can accept either the configured default or a known local environment. It depends on default_environment and try_local_environment.

*Call graph*: calls 1 internal fn (default_environment).


##### `EnvironmentManager::get_environment`  (lines 248–254)

```
fn get_environment(&self, environment_id: &str) -> Option<Arc<Environment>>
```

**Purpose**: Looks up a named environment such as "local", "remote", or a user-defined ID. It is the direct registry lookup operation.

**Data flow**: It receives an environment ID, reads the environment map under a read lock, clones the shared pointer if the ID exists, and returns it.

**Call relations**: Environment selection code calls this after deciding which ID it wants. Other manager methods use similar lookup behavior when resolving defaults.

*Call graph*: called by 1 (resolve_selection).


##### `EnvironmentManager::upsert_environment`  (lines 258–286)

```
fn upsert_environment(
        &self,
        environment_id: String,
        exec_server_url: String,
    ) -> Result<(), ExecServerError>
```

**Purpose**: Adds or replaces a named remote environment using a websocket exec-server URL. It does not change the manager's default environment.

**Data flow**: It receives an environment ID and URL. It rejects an empty ID, normalizes the URL, rejects disabled or missing URLs, builds a remote Environment, writes it into the map, and returns success or an error.

**Call relations**: Runtime code can call this when a remote executor becomes available or changes address. It creates the Environment through Environment::remote_inner.

*Call graph*: calls 2 internal fn (remote_inner, normalize_exec_server_url); 2 external calls (new, Protocol).


##### `EnvironmentManager::upsert_noise_environment`  (lines 293–317)

```
fn upsert_noise_environment(
        &self,
        environment_id: String,
        provider: Arc<dyn NoiseRendezvousConnectProvider>,
    ) -> Result<(), ExecServerError>
```

**Purpose**: Adds or replaces a named remote environment that connects through an authenticated encrypted Noise rendezvous stream. This is for remote execution where each reconnect must get fresh authorization.

**Data flow**: It receives an environment ID and a rendezvous provider. It rejects an empty ID, generates a Noise identity, builds remote transport parameters, creates a remote Environment, stores it in the map, and returns success or an error.

**Call relations**: Higher-level remote-connector code can call this when it has a secure rendezvous provider. It hands the transport to Environment::remote_with_transport.

*Call graph*: calls 2 internal fn (remote_with_transport, generate); 2 external calls (new, Protocol).


##### `LocalEnvironmentInfoProvider::info`  (lines 343–345)

```
fn info(&self) -> BoxFuture<'_, Result<EnvironmentInfo, ExecServerError>>
```

**Purpose**: Returns basic information for a local environment. Right now that means detecting the user's default shell.

**Data flow**: It takes no extra input. It creates local EnvironmentInfo immediately and wraps it in a completed asynchronous result.

**Call relations**: Local Environment objects use this provider when their info method is called. It delegates the actual local info creation to EnvironmentInfo::local.

*Call graph*: 2 external calls (local, ready).


##### `RemoteEnvironmentInfoProvider::new`  (lines 353–355)

```
fn new(client: LazyRemoteExecServerClient) -> Self
```

**Purpose**: Creates a metadata provider for a remote environment. It stores the lazy remote client that will ask the exec-server for environment information later.

**Data flow**: It receives a LazyRemoteExecServerClient, places it in the provider struct, and returns the provider.

**Call relations**: Environment::remote_with_transport calls this while assembling a remote Environment. The provider is later used by RemoteEnvironmentInfoProvider::info.

*Call graph*: called by 1 (remote_with_transport).


##### `RemoteEnvironmentInfoProvider::info`  (lines 359–361)

```
fn info(&self) -> BoxFuture<'_, Result<EnvironmentInfo, ExecServerError>>
```

**Purpose**: Asks a remote exec-server for its environment information. This lets Codex learn remote details such as shell information instead of assuming they match the local machine.

**Data flow**: It reads the stored lazy client, calls its environment_info request asynchronously, and returns the server's result or an error.

**Call relations**: Remote Environment objects use this provider through Environment::info. The call may open the lazy remote connection if it has not already connected.

*Call graph*: calls 1 internal fn (environment_info).


##### `Environment::default_for_tests`  (lines 366–376)

```
fn default_for_tests() -> Self
```

**Purpose**: Builds a test-only local Environment without sandbox helper runtime paths. It is convenient for tests that need a working local executor but not full sandboxed filesystem support.

**Data flow**: It creates local process, unsandboxed local filesystem, local info provider, and a normal HTTP client, then returns an Environment with no remote transport and no runtime paths.

**Call relations**: EnvironmentManager::default_for_tests and many tests call this. Because runtime paths are missing, sandboxed filesystem operations are expected to fail.

*Call graph*: calls 2 internal fn (unsandboxed, default); called by 12 (shell_mode_for_environment_uses_direct_mode_for_remote_environments, test_turn_environment, test_turn_environment, completed_pipe_commands_preserve_exit_code, default_for_tests, default_environment_has_ready_local_executor, test_environment_rejects_sandboxed_filesystem_without_runtime_paths, remote_environment_fetches_info_from_exec_server, oauth_startup_child, streamable_http_initialize_retries_remote_no_response_error (+2 more)); 1 external calls (new).


##### `Environment::fmt`  (lines 380–384)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Defines how an Environment appears in debug logs. It intentionally shows only limited information, mainly the exec-server URL.

**Data flow**: It receives a formatter, writes a debug struct containing exec_server_url, marks other fields as omitted, and returns the formatting result.

**Call relations**: Rust's debug-printing machinery calls this whenever an Environment is formatted with debug output. It avoids dumping large trait-object internals.

*Call graph*: 1 external calls (debug_struct).


##### `Environment::create`  (lines 389–394)

```
fn create(
        exec_server_url: Option<String>,
        local_runtime_paths: ExecServerRuntimePaths,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: Creates an Environment from the legacy optional exec-server URL and required local runtime paths. Production-style callers use it when they want either local or remote execution based on that URL.

**Data flow**: It receives an optional URL and runtime paths, wraps the runtime paths in Some, and passes both into create_inner. The result is either an Environment or an error.

**Call relations**: Tests call this to verify local creation behavior. The actual URL interpretation is delegated to create_inner.

*Call graph*: called by 1 (create_local_environment_does_not_connect); 1 external calls (create_inner).


##### `Environment::create_for_tests`  (lines 397–399)

```
fn create_for_tests(exec_server_url: Option<String>) -> Result<Self, ExecServerError>
```

**Purpose**: Creates an Environment from a URL for tests, without requiring configured local runtime paths. It supports quick local or remote test environments.

**Data flow**: It receives an optional URL, passes it to create_inner with no runtime paths, and returns the resulting Environment or error.

**Call relations**: Tests and helper setup code use this when they need an Environment object directly. It shares the same normalization rules as Environment::create.

*Call graph*: called by 10 (single_local_environment_cwd_requires_exactly_one_local_environment, shell_mode_for_environment_uses_direct_mode_for_remote_environments, local, test_env, wait_for_remote_streamable_http_server, create_process_context, connect_file_system, create_file_system_context, sandboxed_file_system_helper_finds_bwrap_on_preserved_path, remote_environment_fetches_info_from_exec_server); 1 external calls (create_inner).


##### `Environment::create_inner`  (lines 403–421)

```
fn create_inner(
        exec_server_url: Option<String>,
        local_runtime_paths: Option<ExecServerRuntimePaths>,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: Implements the common URL-to-Environment decision. It decides between disabled, remote, configured local, and test-local modes.

**Data flow**: It receives an optional raw URL and optional local runtime paths. It normalizes the URL; if disabled, it returns an error. With a real URL it creates a remote environment. Without a URL it creates a local environment when runtime paths exist, otherwise a test default environment.

**Call relations**: Environment::create and Environment::create_for_tests both call this. It hands off to Environment::remote_inner, Environment::local, or Environment::default_for_tests depending on the inputs.

*Call graph*: calls 1 internal fn (normalize_exec_server_url); 4 external calls (default_for_tests, local, remote_inner, Protocol).


##### `Environment::local`  (lines 423–435)

```
fn local(local_runtime_paths: ExecServerRuntimePaths) -> Self
```

**Purpose**: Builds a real local Environment with configured runtime paths. These paths are needed by filesystem helpers, especially for sandboxed operations.

**Data flow**: It receives runtime paths, creates a local process backend, a local filesystem that knows those paths, a local info provider, and a normal HTTP client, then returns the Environment.

**Call relations**: EnvironmentManager::from_snapshot calls this when local access is included. The returned environment is stored under the reserved "local" ID.

*Call graph*: calls 2 internal fn (with_runtime_paths, default); called by 1 (from_snapshot); 2 external calls (new, clone).


##### `Environment::remote_inner`  (lines 437–445)

```
fn remote_inner(
        exec_server_url: String,
        local_runtime_paths: Option<ExecServerRuntimePaths>,
    ) -> Self
```

**Purpose**: Builds a remote Environment from a websocket exec-server URL. It is the simple URL-based remote constructor.

**Data flow**: It receives a websocket URL and optional local runtime paths. It converts the URL into transport parameters and passes them to remote_with_transport.

**Call relations**: EnvironmentManager::upsert_environment and provider snapshot code use this for ordinary remote exec-server connections.

*Call graph*: calls 1 internal fn (websocket_url); called by 2 (upsert_environment, snapshot_inner); 1 external calls (remote_with_transport).


##### `Environment::remote_with_transport`  (lines 447–473)

```
fn remote_with_transport(
        remote_transport: ExecServerTransportParams,
        local_runtime_paths: Option<ExecServerRuntimePaths>,
    ) -> Self
```

**Purpose**: Builds a remote Environment for any supported transport, such as websocket, Noise rendezvous, or stdio command transport. It wires one lazy remote client into process, filesystem, metadata, and HTTP roles.

**Data flow**: It receives transport parameters and optional local runtime paths. It records the URL only when the transport has one, creates a lazy remote client, wraps that client as a remote process backend, remote filesystem, info provider, and HTTP client, then returns the Environment.

**Call relations**: Remote constructors call this as the common assembly point. The client is lazy, so creating the Environment does not immediately connect to the remote server.

*Call graph*: calls 4 internal fn (new, new, new, new); called by 2 (upsert_noise_environment, snapshot); 2 external calls (new, clone).


##### `Environment::is_remote`  (lines 475–477)

```
fn is_remote(&self) -> bool
```

**Purpose**: Reports whether this Environment uses a remote transport. Callers use it to choose behavior that differs between local and remote execution.

**Data flow**: It checks whether remote_transport is present and returns true or false.

**Call relations**: Session-opening and shell-mode code call this before deciding how to run commands. It does not trigger any connection.

*Call graph*: called by 2 (shell_mode_for_environment, open_session_with_exec_env).


##### `Environment::exec_server_url`  (lines 480–482)

```
fn exec_server_url(&self) -> Option<&str>
```

**Purpose**: Returns the remote exec-server URL when this Environment was created from a websocket URL. It returns nothing for local environments and non-URL remote transports.

**Data flow**: It reads the optional stored URL and returns it as borrowed text if present.

**Call relations**: Tests and reporting code use this to confirm or display the remote endpoint. It is only descriptive and does not affect execution.


##### `Environment::local_runtime_paths`  (lines 484–486)

```
fn local_runtime_paths(&self) -> Option<&ExecServerRuntimePaths>
```

**Purpose**: Returns the local runtime paths stored in the Environment, if any. These paths tell local filesystem helpers where support executables live.

**Data flow**: It reads the optional runtime-path field and returns a borrowed reference when present.

**Call relations**: Tests and filesystem-related setup inspect this to ensure local environments carry the required helper paths.


##### `Environment::info`  (lines 489–491)

```
async fn info(&self) -> Result<EnvironmentInfo, ExecServerError>
```

**Purpose**: Returns metadata about the selected environment, such as shell information. For local environments this is computed locally; for remote environments it is fetched from the exec-server.

**Data flow**: It asks the stored EnvironmentInfoProvider for info, waits for the asynchronous result, and returns the EnvironmentInfo or an error.

**Call relations**: Callers use this when they need to know what shell or environment details are available. The provider hides whether the source is local or remote.


##### `Environment::get_exec_backend`  (lines 493–495)

```
fn get_exec_backend(&self) -> Arc<dyn ExecBackend>
```

**Purpose**: Returns the process-running backend for this Environment. Callers use it to start and control commands in the selected place.

**Data flow**: It clones the shared pointer to the stored ExecBackend and returns it. The underlying backend is not copied; the shared reference count is increased.

**Call relations**: Session-opening code calls this after choosing an Environment. For local environments it points to LocalProcess; for remote environments it points to RemoteProcess.

*Call graph*: called by 1 (open_session_with_exec_env); 1 external calls (clone).


##### `Environment::get_http_client`  (lines 497–499)

```
fn get_http_client(&self) -> Arc<dyn HttpClient>
```

**Purpose**: Returns the HTTP client associated with this Environment. Local environments use a regular reqwest-based client, while remote environments route through the lazy remote exec-server client.

**Data flow**: It clones the shared pointer to the stored HttpClient and returns it.

**Call relations**: Code that needs to make HTTP-style requests through the selected environment calls this. Remote environments share the same lazy client used by process and filesystem operations.

*Call graph*: 1 external calls (clone).


##### `Environment::get_filesystem`  (lines 501–503)

```
fn get_filesystem(&self) -> Arc<dyn ExecutorFileSystem>
```

**Purpose**: Returns the filesystem backend for this Environment. Callers use it to read, write, and inspect files in the selected local or remote location.

**Data flow**: It clones the shared pointer to the stored ExecutorFileSystem and returns it.

**Call relations**: Tool and session code call this after environment selection. Local environments use LocalFileSystem, while remote environments use RemoteFileSystem.

*Call graph*: 1 external calls (clone).


##### `EnvironmentInfo::local`  (lines 507–511)

```
fn local() -> Self
```

**Purpose**: Creates EnvironmentInfo for the local machine. It currently records the user's default shell.

**Data flow**: It detects the default user shell, converts that detected shell into ShellInfo, and returns an EnvironmentInfo value.

**Call relations**: LocalEnvironmentInfoProvider::info calls this whenever local environment metadata is requested.

*Call graph*: calls 1 internal fn (default_user_shell).


##### `ShellInfo::from`  (lines 515–520)

```
fn from(shell: DetectedShell) -> Self
```

**Purpose**: Converts a detected shell into the protocol-friendly ShellInfo structure. This makes shell details safe to send around as plain data.

**Data flow**: It receives a DetectedShell, reads its name and path, converts both to owned strings, and returns ShellInfo.

**Call relations**: EnvironmentInfo::local uses this conversion after detecting the user's shell.

*Call graph*: calls 1 internal fn (name).


##### `tests::test_runtime_paths`  (lines 538–544)

```
fn test_runtime_paths() -> ExecServerRuntimePaths
```

**Purpose**: Creates runtime paths suitable for tests. It uses the current test executable as the known executable path.

**Data flow**: It reads the current executable path, builds ExecServerRuntimePaths with no Linux sandbox helper, and returns the result.

**Call relations**: Many tests call this whenever they need local runtime paths to build a real local EnvironmentManager.

*Call graph*: calls 1 internal fn (new); 1 external calls (current_exe).


##### `tests::assert_local_environment_unavailable`  (lines 546–548)

```
fn assert_local_environment_unavailable(manager: &EnvironmentManager)
```

**Purpose**: Small test helper that checks a manager has no local environment configured. It keeps repeated assertions short and clear.

**Data flow**: It receives a manager, calls try_local_environment, and asserts that the result is none.

**Call relations**: Disabled and remote-only tests call this to confirm Codex will not fall back to local execution.

*Call graph*: 1 external calls (assert!).


##### `tests::create_local_environment_does_not_connect`  (lines 551–558)

```
async fn create_local_environment_does_not_connect()
```

**Purpose**: Verifies that creating a local Environment works and does not behave like a remote connection. It also checks that local info can be read.

**Data flow**: It builds an Environment with no exec-server URL and test runtime paths, then asserts there is no URL, it is not remote, and info succeeds.

**Call relations**: This test exercises Environment::create and the local info path.

*Call graph*: calls 1 internal fn (create); 3 external calls (assert!, assert_eq!, test_runtime_paths).


##### `tests::environment_manager_normalizes_empty_url`  (lines 561–581)

```
async fn environment_manager_normalizes_empty_url()
```

**Purpose**: Checks that an empty exec-server URL is treated like no URL, which means local execution is used. This preserves legacy behavior.

**Data flow**: It builds a test manager with an empty URL, retrieves the default environment, and asserts that local is the default and remote is absent.

**Call relations**: This test exercises EnvironmentManager::create_for_tests and confirms the provider's URL normalization feeds correctly into the manager.

*Call graph*: calls 1 internal fn (create_for_tests); 4 external calls (new, assert!, assert_eq!, test_runtime_paths).


##### `tests::disabled_environment_manager_has_no_default_or_local_environment`  (lines 584–592)

```
async fn disabled_environment_manager_has_no_default_or_local_environment()
```

**Purpose**: Checks that a manager explicitly built without environments exposes no default or local environment. This protects disabled-mode behavior.

**Data flow**: It creates an empty manager and asserts that default lookup, default ID, local lookup, and named local/remote lookups all produce nothing.

**Call relations**: This test exercises EnvironmentManager::without_environments and the local-unavailable helper.

*Call graph*: calls 1 internal fn (without_environments); 3 external calls (assert!, assert_eq!, assert_local_environment_unavailable).


##### `tests::environment_manager_reports_remote_url`  (lines 595–617)

```
async fn environment_manager_reports_remote_url()
```

**Purpose**: Checks that a websocket URL creates a remote default environment and preserves that URL for reporting.

**Data flow**: It builds a test manager with a websocket URL, gets the default Environment, and asserts it is remote, named "remote", has the expected URL, and has no local environment.

**Call relations**: This test exercises EnvironmentManager::create_for_tests and Environment::exec_server_url.

*Call graph*: calls 1 internal fn (create_for_tests); 4 external calls (assert!, assert_eq!, assert_local_environment_unavailable, test_runtime_paths).


##### `tests::environment_manager_default_environment_caches_environment`  (lines 620–631)

```
async fn environment_manager_default_environment_caches_environment()
```

**Purpose**: Verifies that repeated default lookups return the same shared Environment, not newly created copies. This matters because backends and filesystem objects may hold state.

**Data flow**: It builds a default test manager, calls default_environment twice, and checks that both returned pointers and their filesystem pointers are the same.

**Call relations**: This test exercises EnvironmentManager::default_for_tests and EnvironmentManager::default_environment.

*Call graph*: calls 1 internal fn (default_for_tests); 1 external calls (assert!).


##### `tests::environment_manager_builds_from_snapshot`  (lines 634–659)

```
async fn environment_manager_builds_from_snapshot()
```

**Purpose**: Checks that a provider snapshot with a remote environment becomes a manager with that remote as the default. It verifies the snapshot path works without local inclusion.

**Data flow**: It creates a snapshot containing one remote environment and a matching default ID, builds a manager, and asserts the remote is present, defaulted, and local is absent.

**Call relations**: This test directly exercises EnvironmentManager::from_snapshot.

*Call graph*: calls 1 internal fn (from_snapshot); 6 external calls (assert!, assert_eq!, assert_local_environment_unavailable, test_runtime_paths, EnvironmentId, vec!).


##### `tests::environment_manager_rejects_empty_environment_id`  (lines 662–675)

```
async fn environment_manager_rejects_empty_environment_id()
```

**Purpose**: Verifies that configured environments cannot have an empty ID. Empty names would make selection ambiguous and hard to report.

**Data flow**: It creates a snapshot with an empty environment ID, tries to build a manager, expects an error, and checks the error text.

**Call relations**: This test exercises the validation branch inside EnvironmentManager::from_snapshot.

*Call graph*: calls 1 internal fn (from_snapshot); 3 external calls (assert_eq!, test_runtime_paths, vec!).


##### `tests::environment_manager_rejects_provider_supplied_local_environment`  (lines 678–694)

```
async fn environment_manager_rejects_provider_supplied_local_environment()
```

**Purpose**: Verifies that providers cannot define their own environment named "local". That name is reserved so local behavior stays under EnvironmentManager's control.

**Data flow**: It creates a snapshot containing an environment with ID "local", tries to build a manager, expects an error, and checks the message.

**Call relations**: This test protects the reserved-ID check in EnvironmentManager::from_snapshot.

*Call graph*: calls 1 internal fn (from_snapshot); 3 external calls (assert_eq!, test_runtime_paths, vec!).


##### `tests::environment_manager_uses_explicit_provider_default`  (lines 697–716)

```
async fn environment_manager_uses_explicit_provider_default()
```

**Purpose**: Checks that when a provider names a remote environment as the default, the manager honors that choice even if local is also included.

**Data flow**: It creates a snapshot with a "devbox" remote, asks to include local, sets "devbox" as default, builds the manager, and verifies ordering and remoteness.

**Call relations**: This test exercises default selection and default_environment_ids through EnvironmentManager::from_snapshot.

*Call graph*: calls 1 internal fn (from_snapshot); 5 external calls (assert!, assert_eq!, test_runtime_paths, EnvironmentId, vec!).


##### `tests::environment_manager_disables_provider_default`  (lines 719–740)

```
async fn environment_manager_disables_provider_default()
```

**Purpose**: Checks that a provider can disable the default environment while still including local as a named option. Disabled default should not erase explicitly included environments.

**Data flow**: It creates a snapshot with a remote and local inclusion but marks the default as disabled. It builds the manager and verifies there is no default while local remains available.

**Call relations**: This test exercises the disabled-default path in EnvironmentManager::from_snapshot.

*Call graph*: calls 1 internal fn (from_snapshot); 4 external calls (assert!, assert_eq!, test_runtime_paths, vec!).


##### `tests::environment_manager_rejects_unknown_provider_default`  (lines 743–760)

```
async fn environment_manager_rejects_unknown_provider_default()
```

**Purpose**: Verifies that a default ID must point to an environment that actually exists. This prevents startup from silently choosing a wrong place to run commands.

**Data flow**: It creates a snapshot with one environment but sets the default to "missing", then expects manager construction to fail with a clear error.

**Call relations**: This test protects the default-exists validation inside EnvironmentManager::from_snapshot.

*Call graph*: calls 1 internal fn (from_snapshot); 4 external calls (assert_eq!, test_runtime_paths, EnvironmentId, vec!).


##### `tests::environment_manager_includes_local_for_default_provider_without_url`  (lines 763–783)

```
async fn environment_manager_includes_local_for_default_provider_without_url()
```

**Purpose**: Checks that the default provider creates and selects local execution when no exec-server URL is set. This is the normal local fallback behavior.

**Data flow**: It builds a test manager with no URL, gets the default, and asserts that the default, named local environment, and local_environment field all point to the same local Environment.

**Call relations**: This test exercises EnvironmentManager::create_for_tests and the provider snapshot path.

*Call graph*: calls 1 internal fn (create_for_tests); 3 external calls (assert!, assert_eq!, test_runtime_paths).


##### `tests::environment_manager_carries_local_runtime_paths`  (lines 786–809)

```
async fn environment_manager_carries_local_runtime_paths()
```

**Purpose**: Verifies that local runtime paths survive through manager and environment construction. This is important for sandbox-capable filesystem helpers.

**Data flow**: It creates a manager with test runtime paths, checks the local Environment stores them, rebuilds a manager from that environment's values, and checks the paths again.

**Call relations**: This test exercises EnvironmentManager::create_for_tests and Environment::local_runtime_paths.

*Call graph*: calls 1 internal fn (create_for_tests); 2 external calls (assert_eq!, test_runtime_paths).


##### `tests::environment_manager_omits_default_provider_local_lookup_when_default_disabled`  (lines 812–824)

```
async fn environment_manager_omits_default_provider_local_lookup_when_default_disabled()
```

**Purpose**: Checks that the special URL value "none" disables all environment access. There should be no default and no local fallback.

**Data flow**: It builds a test manager with URL "none" and asserts that default, local, named local, and named remote lookups all return nothing.

**Call relations**: This test exercises disabled behavior through EnvironmentManager::create_for_tests and the local-unavailable helper.

*Call graph*: calls 1 internal fn (create_for_tests); 4 external calls (assert!, assert_eq!, assert_local_environment_unavailable, test_runtime_paths).


##### `tests::environment_manager_snapshot_without_local_environment_disables_local_default`  (lines 827–843)

```
async fn environment_manager_snapshot_without_local_environment_disables_local_default()
```

**Purpose**: Checks a snapshot state where local inclusion is turned off and the default is disabled. It ensures no local environment appears accidentally.

**Data flow**: It starts with a snapshot shape that mentions local, changes it to exclude local and disable default, builds the manager, and asserts all local/default lookups are absent.

**Call relations**: This test directly exercises EnvironmentManager::from_snapshot with no runtime paths and no local inclusion.

*Call graph*: calls 1 internal fn (from_snapshot); 5 external calls (new, assert!, assert_eq!, assert_local_environment_unavailable, EnvironmentId).


##### `tests::get_environment_returns_none_for_unknown_id`  (lines 846–850)

```
async fn get_environment_returns_none_for_unknown_id()
```

**Purpose**: Verifies that asking for an unknown environment ID returns nothing instead of creating or guessing an environment.

**Data flow**: It builds a default test manager and calls get_environment with a made-up ID, then asserts the result is none.

**Call relations**: This test exercises EnvironmentManager::get_environment.

*Call graph*: calls 1 internal fn (default_for_tests); 1 external calls (assert!).


##### `tests::environment_manager_upserts_named_remote_environment`  (lines 853–875)

```
async fn environment_manager_upserts_named_remote_environment()
```

**Purpose**: Checks that a named remote environment can be added and later replaced. It also verifies this does not set a default environment.

**Data flow**: It starts with an empty manager, inserts "executor-a" with one URL, checks it, inserts the same ID with a different URL, and checks that the stored Environment changed.

**Call relations**: This test exercises EnvironmentManager::upsert_environment and Environment::exec_server_url.

*Call graph*: calls 1 internal fn (without_environments); 2 external calls (assert!, assert_eq!).


##### `tests::environment_manager_rejects_empty_remote_environment_url`  (lines 878–889)

```
async fn environment_manager_rejects_empty_remote_environment_url()
```

**Purpose**: Verifies that adding a remote environment requires a real URL. An empty URL should not accidentally become local execution.

**Data flow**: It creates an empty manager, tries to upsert a remote environment with an empty URL, expects an error, and checks the message.

**Call relations**: This test protects the validation inside EnvironmentManager::upsert_environment.

*Call graph*: calls 1 internal fn (without_environments); 2 external calls (new, assert_eq!).


##### `tests::default_environment_has_ready_local_executor`  (lines 892–912)

```
async fn default_environment_has_ready_local_executor()
```

**Purpose**: Checks that the test local Environment can actually start a process. This proves the default test environment is useful for command-running tests.

**Data flow**: It builds a default test Environment, asks its exec backend to start the command "true" with a test process ID and current directory, then asserts the returned process ID matches.

**Call relations**: This test exercises Environment::default_for_tests and Environment::get_exec_backend.

*Call graph*: calls 3 internal fn (default_for_tests, from, from_path); 4 external calls (default, assert_eq!, current_dir, vec!).


##### `tests::test_environment_rejects_sandboxed_filesystem_without_runtime_paths`  (lines 915–939)

```
async fn test_environment_rejects_sandboxed_filesystem_without_runtime_paths()
```

**Purpose**: Checks that a test Environment without runtime paths refuses sandboxed filesystem operations. This prevents tests from accidentally claiming sandbox support they do not have.

**Data flow**: It builds a default test Environment, creates a sandbox policy and a path to the current executable, tries a sandboxed file read, expects an error, and checks the message.

**Call relations**: This test exercises Environment::default_for_tests and Environment::get_filesystem, confirming the filesystem backend enforces the runtime-path requirement.

*Call graph*: calls 6 internal fn (default_for_tests, from_permission_profile, from_runtime_permissions, restricted, from_absolute_path, from_abs_path); 3 external calls (new, assert_eq!, current_exe).


### `exec-server/src/environment_provider.rs`

`config` · `startup/config load`

Codex can run work in different “environments,” meaning places where commands can execute. This file is the small decision-maker that answers: should Codex use a remote exec server, fall back to the local machine, or disable execution environments altogether? The main input is the `CODEX_EXEC_SERVER_URL` environment variable, which is a setting supplied by the user’s shell or process environment.

The `EnvironmentProvider` trait describes something that can provide a startup snapshot of available environments. A snapshot includes three things: remote environments owned by the provider, which environment should be the default, and whether the environment manager should add the local environment itself. This split matters because this provider does not directly create the local environment; it only says whether local should be included.

`DefaultEnvironmentProvider` is the built-in provider. If the URL is missing or empty, it asks for the local environment to be included and makes local the default. If the URL is `none`, it disables environments and does not include local. If the URL is any other text, it trims extra spaces, creates a remote environment from it, and makes that remote environment the default. In short, this file is like a receptionist at startup: it reads the sign on the door and tells the rest of the system where execution should be sent.

#### Function details

##### `DefaultEnvironmentProvider::new`  (lines 46–48)

```
fn new(exec_server_url: Option<String>) -> Self
```

**Purpose**: Creates a default environment provider from a URL value that has already been read. This is useful when another part of the program, or a test, already has the raw `CODEX_EXEC_SERVER_URL` value and just needs the provider to interpret it later.

**Data flow**: It receives an optional string: either a possible exec server URL, or no value at all. It stores that value inside a `DefaultEnvironmentProvider` without interpreting it yet. The result is a provider object ready to produce a startup snapshot later.

**Call relations**: This is the basic constructor used by setup helpers and by the tests. `DefaultEnvironmentProvider::from_env` also calls it after reading the real process environment, so all creation paths end up with the same simple stored value.

*Call graph*: called by 7 (create_for_tests_with_local, from_default_provider_url, default_provider_adds_remote_environment_for_websocket_url, default_provider_normalizes_exec_server_url, default_provider_omits_local_environment_for_none_value, default_provider_requests_local_environment_when_url_is_empty, default_provider_requests_local_environment_when_url_is_missing).


##### `DefaultEnvironmentProvider::from_env`  (lines 51–53)

```
fn from_env() -> Self
```

**Purpose**: Builds a provider by reading the `CODEX_EXEC_SERVER_URL` setting from the process environment. Use this when startup code wants the normal behavior controlled by the user’s environment variables.

**Data flow**: It asks the operating system for the value of `CODEX_EXEC_SERVER_URL`. If the variable exists, the text is kept; if it is missing or unreadable, it becomes no value. That optional value is passed into `DefaultEnvironmentProvider::new`, which returns the provider.

**Call relations**: Startup-related code calls this when it wants the standard provider based on environment configuration. It hands off to `DefaultEnvironmentProvider::new` so the provider is built the same way whether the value came from the real environment or from test/setup code.

*Call graph*: called by 2 (from_env, environment_provider_from_codex_home); 2 external calls (new, var).


##### `DefaultEnvironmentProvider::snapshot_inner`  (lines 55–83)

```
fn snapshot_inner(&self) -> EnvironmentProviderSnapshot
```

**Purpose**: Turns the stored exec server URL setting into the actual startup decision: remote environment, local environment, or disabled. This is the core policy function in the file.

**Data flow**: It starts with the provider’s optional URL text. It first normalizes that text, trimming spaces and recognizing `none` as a special disabled value. If a real URL remains, it creates a remote `Environment` using that URL and labels it with the remote environment ID. Then it decides whether local should be added later and which environment ID should be the default. It returns an `EnvironmentProviderSnapshot` containing the environment list, the default choice, and the include-local flag.

**Call relations**: The asynchronous `DefaultEnvironmentProvider::snapshot` method calls this to do the real work. Inside, it relies on `normalize_exec_server_url` to make sense of the raw setting, and on `Environment::remote_inner` to build the remote environment when a URL is present.

*Call graph*: calls 2 internal fn (remote_inner, normalize_exec_server_url); called by 1 (snapshot); 2 external calls (new, EnvironmentId).


##### `DefaultEnvironmentProvider::snapshot`  (lines 87–89)

```
fn snapshot(&self) -> EnvironmentProviderFuture<'_>
```

**Purpose**: Provides the environment snapshot through the `EnvironmentProvider` trait’s asynchronous interface. Even though this provider’s work is immediate, the trait allows other providers to do slower async work, such as reading from a service.

**Data flow**: It receives the provider object. It wraps a call to `snapshot_inner` in a future, which is Rust’s way of representing work that can be awaited. When awaited, it returns either a successful `EnvironmentProviderSnapshot` or an `ExecServerError`; this implementation always wraps the snapshot as successful.

**Call relations**: Code that works with any `EnvironmentProvider` calls this method without needing to know it is the default provider. This method then delegates to `snapshot_inner`, which applies the actual URL-to-environment rules.

*Call graph*: calls 1 internal fn (snapshot_inner); 1 external calls (pin).


##### `normalize_exec_server_url`  (lines 92–98)

```
fn normalize_exec_server_url(exec_server_url: Option<String>) -> (Option<String>, bool)
```

**Purpose**: Cleans up and interprets the raw exec server URL setting. It makes the rest of the code deal with clear cases instead of messy user input like blank strings or extra spaces.

**Data flow**: It receives an optional string. If there is no value, or the value is empty after trimming whitespace, it returns no URL and says execution is not disabled. If the trimmed value is `none`, ignoring letter case, it returns no URL and says execution is disabled. Otherwise it returns the trimmed URL text and says execution is not disabled.

**Call relations**: The default provider calls this while building its startup snapshot. Other environment-building paths also call it when creating or updating environments, so the same rules for empty values, `none`, and trimmed URLs are shared across the system.

*Call graph*: called by 3 (create_inner, upsert_environment, snapshot_inner).


##### `tests::default_provider_requests_local_environment_when_url_is_missing`  (lines 109–126)

```
async fn default_provider_requests_local_environment_when_url_is_missing()
```

**Purpose**: Checks that a missing `CODEX_EXEC_SERVER_URL` means Codex should use the local environment by default. This protects the normal fallback behavior when no remote server is configured.

**Data flow**: The test creates a provider with no URL. It awaits the provider’s snapshot, turns the environment list into a lookup table, and checks that local should be included, no remote environment is present, and the default points to the local environment ID.

**Call relations**: This test calls `DefaultEnvironmentProvider::new` to set up the missing-value case. It exercises the provider through the public snapshot path, confirming that the startup decision made by `snapshot_inner` matches the intended default behavior.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, assert_eq!).


##### `tests::default_provider_requests_local_environment_when_url_is_empty`  (lines 129–146)

```
async fn default_provider_requests_local_environment_when_url_is_empty()
```

**Purpose**: Checks that an empty URL string behaves the same as a missing URL. This matters because users or scripts may set the variable but leave it blank.

**Data flow**: The test creates a provider with an empty string. It awaits the snapshot, collects the environments into a lookup table, and verifies that local should be included, neither local nor remote was provided directly by the provider, and the default is local.

**Call relations**: This test calls `DefaultEnvironmentProvider::new` with an empty string and indirectly checks `normalize_exec_server_url` through the snapshot behavior. It ensures the provider does not treat a blank string as a remote server address.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert!, assert_eq!).


##### `tests::default_provider_omits_local_environment_for_none_value`  (lines 149–163)

```
async fn default_provider_omits_local_environment_for_none_value()
```

**Purpose**: Checks that setting the URL value to `none` disables environment selection instead of falling back to local. This gives users a clear opt-out switch.

**Data flow**: The test creates a provider with the string `none`. It awaits the snapshot, collects the environment list, and confirms that local should not be included, no remote environment exists, and the default state is `Disabled`.

**Call relations**: This test calls `DefaultEnvironmentProvider::new` and then uses the snapshot path to verify the special `none` behavior. It protects the contract implemented by `normalize_exec_server_url` and `snapshot_inner`.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, assert_eq!).


##### `tests::default_provider_adds_remote_environment_for_websocket_url`  (lines 166–188)

```
async fn default_provider_adds_remote_environment_for_websocket_url()
```

**Purpose**: Checks that a real WebSocket URL creates a remote environment and makes it the default. A WebSocket URL is a network address used for two-way communication with the exec server.

**Data flow**: The test creates a provider with `ws://127.0.0.1:8765`. It awaits the snapshot, looks up the remote environment, and verifies that local is not requested, the remote environment exists, the stored URL matches the input, and the default points to the remote environment ID.

**Call relations**: This test calls `DefaultEnvironmentProvider::new` with a real remote URL. It exercises the path where `snapshot_inner` builds an `Environment::remote_inner` value and chooses the remote environment as the default.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, assert_eq!).


##### `tests::default_provider_normalizes_exec_server_url`  (lines 191–200)

```
async fn default_provider_normalizes_exec_server_url()
```

**Purpose**: Checks that extra spaces around the exec server URL are removed. This prevents small formatting mistakes in environment variables from becoming broken server addresses.

**Data flow**: The test creates a provider with a URL padded by spaces. It awaits the snapshot, converts the environment list into a lookup table, and verifies that the remote environment’s URL is stored without the surrounding spaces.

**Call relations**: This test calls `DefaultEnvironmentProvider::new` and then observes the snapshot result. It specifically protects the trimming behavior supplied by `normalize_exec_server_url` as used by `snapshot_inner`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


### Host and platform probing
These files detect local machine identity and surrounding OS or cloud context that influences configuration and startup behavior.

### `cli/src/doctor/git.rs`

`domain_logic` · `doctor diagnostics run`

This file is like a quick health check for the user's Git setup. Codex often benefits from knowing repository information, such as the project root or current branch. If Git is missing, broken, too old, or oddly configured, Codex can give confusing results. This check turns those hidden environment details into a clear report.

The main flow starts by looking for the `git` program on the user's `PATH`, which is the operating system's search list for commands. It also gathers all Git executables it can find, detects whether the current directory belongs to a Git repository, and, if Git is available, runs a few short Git commands. Those commands ask for the Git version, Git's internal executable path, build options, current branch, and `core.fsmonitor` setting. Each command has a short timeout so the doctor command does not hang.

The collected facts are then turned into a `DoctorCheck`, which is the structured report shown by the diagnostics system. Most setups are marked OK. The file raises warnings when Git is found but cannot run, when a repository exists but no Git executable is available, or when an old Git for Windows version may break terminal rendering. Tests at the bottom cover version parsing and the main warning cases.

#### Function details

##### `git_check`  (lines 30–60)

```
async fn git_check(cwd: &Path) -> DoctorCheck
```

**Purpose**: Runs the live Git environment check for a given working directory. It gathers facts from the operating system and from Git, then asks the report-building function to turn those facts into a doctor result.

**Data flow**: It receives the current working directory. It looks up the selected `git` command, gathers all Git candidates on `PATH`, checks for a repository root, and runs several Git commands if a Git executable exists. It packages those observations into `GitCheckInputs` and returns a `DoctorCheck` report.

**Call relations**: This is the top-level function for this file's check. It calls `git_candidates` to find possible Git programs, uses the external repository-root helper, runs several Git commands in parallel, and then hands everything to `git_check_from_inputs` so the reporting rules stay in one place.

*Call graph*: calls 2 internal fn (git_candidates, git_check_from_inputs); 3 external calls (get_git_repo_root, join!, which).


##### `git_check_from_inputs`  (lines 62–156)

```
fn git_check_from_inputs(inputs: GitCheckInputs) -> DoctorCheck
```

**Purpose**: Turns already-collected Git facts into a clear diagnostic report. This separation makes the warning logic easy to test without actually running Git.

**Data flow**: It receives a `GitCheckInputs` bundle containing paths, version text, repository information, branch data, and settings. It writes human-readable detail lines, chooses an overall summary, and upgrades the result from OK to Warning when it sees a known problem. It returns a completed `DoctorCheck`.

**Call relations**: The live `git_check` function calls this after collecting real data. The tests also call it directly with made-up inputs to prove that missing Git, broken Git, and normal repository metadata are reported correctly. Inside, it relies on helpers such as `git_summary`, `normalized_branch`, `push_optional_detail`, and `old_windows_git_warning`.

*Call graph*: calls 6 internal fn (new, new, git_summary, normalized_branch, old_windows_git_warning, push_optional_detail); called by 4 (git_check, reports_git_candidates_and_repo_metadata, warns_when_git_repo_has_no_git_executable, warns_when_selected_git_cannot_report_version); 3 external calls (new, cfg!, format!).


##### `git_summary`  (lines 158–166)

```
fn git_summary(inputs: &GitCheckInputs) -> String
```

**Purpose**: Chooses the short one-line summary for the Git check. It answers the basic question: did we find Git, and do we know its version?

**Data flow**: It reads the selected Git path and version from `GitCheckInputs`. If a version is known, it returns that version text. If Git was found but did not report a version, it says the version is unavailable. If Git was not found, it says so.

**Call relations**: This is used by `git_check_from_inputs` when creating the initial `DoctorCheck`. Later warning logic may replace this summary if a more serious problem is detected.

*Call graph*: called by 1 (git_check_from_inputs).


##### `push_optional_detail`  (lines 168–172)

```
fn push_optional_detail(details: &mut Vec<String>, label: &str, value: Option<&str>)
```

**Purpose**: Adds one detail line to the report only when a value exists. It avoids cluttering the doctor output with empty or missing fields.

**Data flow**: It receives the growing list of detail strings, a label, and an optional value. If the value is present, it formats `label: value` and appends it to the list. If the value is missing, it changes nothing.

**Call relations**: This helper is called several times by `git_check_from_inputs` for optional Git facts such as version, exec path, build options, branch, and fsmonitor setting.

*Call graph*: called by 1 (git_check_from_inputs); 1 external calls (format!).


##### `normalized_branch`  (lines 174–180)

```
fn normalized_branch(branch: Option<&str>) -> Option<&str>
```

**Purpose**: Cleans up the branch name before showing it to the user. In particular, it translates Git's special `HEAD` output into the clearer phrase `detached HEAD`.

**Data flow**: It receives an optional branch string. It returns `detached HEAD` for the special `HEAD` value, returns normal non-empty branch names unchanged, and returns nothing for empty or missing branch output.

**Call relations**: This is used by `git_check_from_inputs` before adding the branch detail line, so the doctor report uses language that is easier to understand.

*Call graph*: called by 1 (git_check_from_inputs).


##### `git_candidates`  (lines 182–190)

```
fn git_candidates() -> Vec<PathBuf>
```

**Purpose**: Finds every `git` executable visible on the user's command search path. This helps reveal when multiple Git installations may be competing.

**Data flow**: It asks the operating system search helper for all `git` matches. It removes duplicates while keeping a stable sorted set of paths already seen, then returns the unique list. If the search fails, it returns an empty list.

**Call relations**: The live `git_check` function calls this near the start. `git_check_from_inputs` later includes the count and paths in the diagnostic details so users can see exactly which Git commands Codex might encounter.

*Call graph*: called by 1 (git_check); 3 external calls (new, new, which_all).


##### `git_output`  (lines 192–204)

```
async fn git_output(git_path: &Path, cwd: &Path, args: &[&str]) -> Option<String>
```

**Purpose**: Runs one Git command safely and captures its useful text output. It is careful not to wait forever if Git hangs.

**Data flow**: It receives the Git executable path, the working directory, and command arguments. It starts a child process with `GIT_OPTIONAL_LOCKS=0`, which tells Git not to take optional repository locks, sets the current directory, and waits up to two seconds. If the command succeeds, it passes the process output to `command_output_text`; otherwise it returns no value.

**Call relations**: This is used by `git_check` for each Git query, such as `--version` and current branch lookup. It hands successful process output to `command_output_text` to turn raw bytes into clean report text.

*Call graph*: calls 1 internal fn (command_output_text); 2 external calls (new, timeout).


##### `command_output_text`  (lines 206–222)

```
fn command_output_text(output: Output) -> Option<String>
```

**Purpose**: Converts successful command output into a tidy single string for the report. It rejects failed commands and empty output.

**Data flow**: It receives a completed process output. If the command exited with an error status, it returns nothing. Otherwise it reads standard output as text, trims each line, drops blank lines, joins the remaining lines with semicolons, and returns that string if anything remains.

**Call relations**: This is called by `git_output` after a Git command finishes. It keeps the rest of the diagnostic code from dealing with raw process bytes or messy multi-line output.

*Call graph*: called by 1 (git_output); 1 external calls (from_utf8_lossy).


##### `git_entry_summary`  (lines 224–241)

```
fn git_entry_summary(repo_root: &Path) -> String
```

**Purpose**: Describes what the repository's `.git` entry looks like. This matters because `.git` can be a normal directory, or it can be a small file pointing somewhere else, as in worktrees and submodules.

**Data flow**: It receives the repository root path and looks at the `.git` path inside it. If `.git` is a directory, it returns `directory`. If it is a file containing a `gitdir:` pointer, it returns that target. If it is another kind of file, missing, or unreadable, it returns a short description of that state.

**Call relations**: The live `git_check` function uses this when a repository root is found, then stores the result in `GitCheckInputs`. `git_check_from_inputs` later includes the summary in the doctor details.

*Call graph*: 4 external calls (join, format!, metadata, read_to_string).


##### `old_windows_git_warning`  (lines 243–256)

```
fn old_windows_git_warning(version: Option<&str>, is_windows: bool) -> Option<String>
```

**Purpose**: Detects older Windows Git installations that are known to cause terminal display problems. This helps users fix a strange-looking interface problem by updating Git.

**Data flow**: It receives optional Git version text and a flag saying whether the program is running on Windows. On non-Windows systems, or without a version, it returns nothing. On Windows, it warns for old `msysgit` builds or for Git for Windows versions at or below 2.34.

**Call relations**: This is called by `git_check_from_inputs` after the basic Git facts are known. It calls `parse_git_version` to understand normal version strings before deciding whether to add a warning issue.

*Call graph*: calls 1 internal fn (parse_git_version); called by 1 (git_check_from_inputs).


##### `parse_git_version`  (lines 265–279)

```
fn parse_git_version(version: &str) -> Option<ParsedGitVersion>
```

**Purpose**: Extracts major, minor, and patch numbers from Git's version text. It exists so the Windows warning logic can compare versions reliably.

**Data flow**: It receives a string such as `git version 2.34.1.windows.1`. It first confirms the expected `git version ` prefix, then keeps the numeric part before any `.windows.` suffix, splits it into pieces, and parses the pieces as numbers. It returns a `ParsedGitVersion` when parsing succeeds, or nothing when the text does not match.

**Call relations**: This is called only by `old_windows_git_warning`. The version parsing tests call it indirectly through assertions to make sure Git for Windows version strings are understood correctly.

*Call graph*: called by 1 (old_windows_git_warning).


##### `tests::parses_git_for_windows_version`  (lines 288–305)

```
fn parses_git_for_windows_version()
```

**Purpose**: Checks that Git for Windows version strings are parsed into the expected numbers. This protects the warning logic from breaking if the parser is changed.

**Data flow**: It feeds two sample version strings into `parse_git_version`. It compares the returned major, minor, and patch numbers with the expected values. The test passes only if both examples parse correctly.

**Call relations**: This test focuses on the helper used by `old_windows_git_warning`. It does not run Git; it verifies the pure text-parsing behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::classifies_old_windows_git`  (lines 308–331)

```
fn classifies_old_windows_git()
```

**Purpose**: Checks that the old-Windows-Git warning appears only when it should. It confirms that old Windows Git warns, newer Windows Git does not, and non-Windows systems do not get the Windows-only warning.

**Data flow**: It passes sample version strings and platform flags into `old_windows_git_warning`. It compares each returned warning, or lack of warning, with the expected result.

**Call relations**: This test covers the decision function that `git_check_from_inputs` uses before adding a warning issue to the doctor report.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::warns_when_git_repo_has_no_git_executable`  (lines 334–345)

```
fn warns_when_git_repo_has_no_git_executable()
```

**Purpose**: Verifies that the doctor report warns when the current folder is a Git repository but no Git command is available. This is an important user-facing failure mode.

**Data flow**: It builds fake inputs with a repository root but no selected Git executable. It passes them to `git_check_from_inputs` and checks that the result status is Warning with the expected summary.

**Call relations**: This test calls the report-building function directly, avoiding any real filesystem or command lookup. It proves the missing-Git warning branch works.

*Call graph*: calls 1 internal fn (git_check_from_inputs); 3 external calls (from, assert_eq!, default).


##### `tests::warns_when_selected_git_cannot_report_version`  (lines 348–357)

```
fn warns_when_selected_git_cannot_report_version()
```

**Purpose**: Verifies that the doctor report warns when a Git executable is found but cannot successfully report its version. That usually means the selected Git command or search path is broken.

**Data flow**: It builds fake inputs with a selected Git path and repository root, but no Git version. It passes them to `git_check_from_inputs` and checks that the result is a Warning with the expected summary.

**Call relations**: This test exercises another warning branch inside `git_check_from_inputs`. It simulates the situation that would happen if `git_output` failed for `git --version`.

*Call graph*: calls 1 internal fn (git_check_from_inputs); 3 external calls (from, assert_eq!, default).


##### `tests::reports_git_candidates_and_repo_metadata`  (lines 360–377)

```
fn reports_git_candidates_and_repo_metadata()
```

**Purpose**: Checks that a healthy Git setup produces an OK report and includes useful details. This protects the ordinary, successful path.

**Data flow**: It builds fake inputs with a selected Git, two Git candidates, a version, exec path, repository root, `.git` entry type, branch, and fsmonitor setting. It passes them to `git_check_from_inputs` and verifies the status and several detail lines.

**Call relations**: This test confirms that `git_check_from_inputs` combines data from helpers such as `git_candidates`, `git_entry_summary`, and `normalized_branch` into the final doctor details as intended.

*Call graph*: calls 1 internal fn (git_check_from_inputs); 5 external calls (from, assert!, assert_eq!, default, vec!).


### `cli/src/doctor/system.rs`

`domain_logic` · `doctor command execution`

The doctor command is meant to answer a practical question: “Is my machine set up in a way this tool understands?” This file contributes the system-environment answer. It looks at the operating system, the system language, and several environment variables. Environment variables are named settings supplied by the shell, like signs posted for programs to read. Here they include locale settings, which affect language and text formatting, plus editor and pager settings, which affect what program opens text or long output.

The file first gathers all of that information into a small internal record called `SystemCheckInputs`. Then it turns that record into a `DoctorCheck`, the common report object used by the doctor feature. The report always includes OS name, OS type, OS version, and either the OS language or a clear “unavailable” message. It also includes only the locale and pager variables that are actually present, while editor variables are reported even when missing as “not set.”

This matters because many confusing CLI problems come from the surrounding system rather than the program itself: wrong language settings, missing editors, or unexpected pagers. Without this check, support would have less context, and users would have fewer clues about why behavior differs across machines.

#### Function details

##### `SystemCheckInputs::detect`  (lines 22–57)

```
fn detect() -> Self
```

**Purpose**: This function takes a snapshot of the current machine’s system environment. It is used when the doctor command needs real operating system details and relevant environment variables from the user’s shell.

**Data flow**: It starts with no caller-provided data and reads from the running computer: operating system information, the system locale, and selected environment variables. It stores found locale variables, records editor variables with “not set” when missing, and records pager variables only when present. It returns a filled `SystemCheckInputs` record ready to be turned into a doctor report.

**Call relations**: When `system_check` begins the real diagnostic check, it calls this function first to collect live system facts. This function relies on external libraries to read operating system information and locale information, then hands the gathered snapshot back to `system_check`.

*Call graph*: called by 1 (system_check); 2 external calls (get, get_locale).


##### `system_check`  (lines 60–62)

```
fn system_check() -> DoctorCheck
```

**Purpose**: This is the public entry point, within the doctor module, for producing the system environment check. Other doctor code can call it without needing to know how system details are collected.

**Data flow**: It takes no inputs. It asks `SystemCheckInputs::detect` to read the current machine’s environment, then passes that snapshot into `system_check_from_inputs`. It returns the finished `DoctorCheck` report.

**Call relations**: This function ties together collection and formatting. It calls `SystemCheckInputs::detect` to get real-world data, then calls `system_check_from_inputs` to convert that data into the standard doctor-check shape used by the rest of the doctor feature.

*Call graph*: calls 2 internal fn (detect, system_check_from_inputs).


##### `system_check_from_inputs`  (lines 64–103)

```
fn system_check_from_inputs(inputs: SystemCheckInputs) -> DoctorCheck
```

**Purpose**: This function turns already-collected system information into a readable doctor report. It exists separately from live detection so the formatting can be tested with fixed sample data.

**Data flow**: It receives a `SystemCheckInputs` record containing OS details, optional language, and selected environment variables. It builds a list of human-readable detail lines, such as `os: ...`, `LANG: ...`, or `EDITOR: not set`. It also creates a short summary focused on the OS language, then returns a `DoctorCheck` marked as OK with those details attached.

**Call relations**: In normal use, `system_check` calls this after detection. In tests, the two test functions call it directly with hand-made inputs, which lets them check the exact report text without depending on the computer running the tests.

*Call graph*: calls 1 internal fn (new); called by 3 (system_check, system_check_handles_missing_os_language, system_check_reports_os_language_locale_editor_and_pager_env); 2 external calls (format!, vec!).


##### `tests::system_check_reports_os_language_locale_editor_and_pager_env`  (lines 112–152)

```
fn system_check_reports_os_language_locale_editor_and_pager_env()
```

**Purpose**: This test checks the happy path where the OS language is known and several locale, editor, and pager variables are present. It makes sure the doctor report includes the expected summary and detail lines in the expected order.

**Data flow**: It creates sample maps for locale, editor, and pager settings, then builds a fake `SystemCheckInputs` record for macOS. It sends that record into `system_check_from_inputs` and receives a `DoctorCheck`. It compares the report’s summary and details against fixed expected text.

**Call relations**: This test calls `system_check_from_inputs` directly instead of `system_check`, so it avoids reading the real test machine’s environment. It protects the report-building behavior that users see when their system language and relevant environment variables are available.

*Call graph*: calls 1 internal fn (system_check_from_inputs); 3 external calls (from, new, assert_eq!).


##### `tests::system_check_handles_missing_os_language`  (lines 155–181)

```
fn system_check_handles_missing_os_language()
```

**Purpose**: This test checks the fallback behavior when the system language cannot be detected. It makes sure the doctor report says the language is unavailable and still reports editor variables as “not set.”

**Data flow**: It creates a fake Linux `SystemCheckInputs` record with no OS language, no locale variables, editor variables set to “not set,” and no pager variables. It passes that into `system_check_from_inputs`, gets back a `DoctorCheck`, and compares its summary and details to the expected fallback text.

**Call relations**: Like the other test, it calls `system_check_from_inputs` directly with controlled data. It verifies an important edge case that `system_check` may encounter on real machines when locale detection fails.

*Call graph*: calls 1 internal fn (system_check_from_inputs); 3 external calls (from, new, assert_eq!).


### `cloud-tasks/src/env_detect.rs`

`orchestration` · `startup and environment selection`

A cloud task needs to run inside an environment, but users should not have to memorize environment IDs. This file acts like a helpful receptionist: it looks at the local Git repository, asks the server which environments match that repository, and then picks the best match or prepares a list for the user to choose from.

It first reads the Git remote URLs from the local checkout. If a remote points to GitHub, it extracts the owner and repository name, such as `openai/example`. It then asks the backend for environments connected to that repository. If that does not produce a usable answer, it falls back to asking for the full environment list.

When choosing automatically, it follows a simple priority order: match the requested label if one was given, choose the only available environment if there is just one, prefer a pinned environment, and finally choose the one with the highest task count as a best guess. “Pinned” means the server marked that environment as preferred.

The file also contains shared HTTP and parsing helpers. It logs many details, including failed requests and raw server responses, because environment selection can fail for reasons outside the program, such as bad credentials, an unexpected server response, or a repository URL that cannot be recognized.

#### Function details

##### `autodetect_environment_id`  (lines 25–108)

```
async fn autodetect_environment_id(
    base_url: &str,
    headers: &HeaderMap,
    desired_label: Option<String>,
) -> anyhow::Result<AutodetectSelection>
```

**Purpose**: This function automatically chooses one environment ID to use for a task. It tries repository-specific environments first, then falls back to the full server list if needed.

**Data flow**: It receives the backend base URL, request headers such as authentication information, and an optional desired label. It reads local Git origins, turns GitHub origins into owner/repository pairs, asks the server for matching environments, and runs the results through the selection rules. If a match is found, it returns the chosen environment ID and optional label; if nothing is available, it returns an error.

**Call relations**: This is called by `run_main` when the program needs an environment without asking the user to pick one manually. It calls `get_git_origins` to learn what repository it is in, `parse_owner_repo` to understand GitHub remote URLs, and `pick_environment_row` to apply the final choice rules. For the fallback full-list request, it builds an HTTP client with custom certificate support so it can talk to the backend safely in more deployment setups.

*Call graph*: calls 3 internal fn (get_git_origins, parse_owner_repo, pick_environment_row); called by 1 (run_main); 9 external calls (clone, new, bail!, builder, build_reqwest_client_with_custom_ca, append_error_log, format!, from_str, to_string_pretty).


##### `pick_environment_row`  (lines 110–145)

```
fn pick_environment_row(
    envs: &[CodeEnvironment],
    desired_label: Option<&str>,
) -> Option<CodeEnvironment>
```

**Purpose**: This function chooses the best environment from a list using predictable rules. It is the small decision-maker that turns “several possible environments” into “this one.”

**Data flow**: It receives a list of environment records and, optionally, a label the user wanted. It first returns nothing if the list is empty. Otherwise it looks for an exact label match, then selects the single environment if there is only one, then prefers a pinned environment, and finally picks the environment with the highest task count or the first available item. It returns a copy of the chosen environment, or nothing if there was no list to choose from.

**Call relations**: This function is called by `autodetect_environment_id` after that function gathers possible environments from the server. It does not contact the server itself; it only makes the local choice and writes useful notes to the error log explaining why a particular environment was selected.

*Call graph*: called by 1 (autodetect_environment_id); 5 external calls (is_empty, iter, len, append_error_log, format!).


##### `get_json`  (lines 147–169)

```
async fn get_json(
    url: &str,
    headers: &HeaderMap,
) -> anyhow::Result<T>
```

**Purpose**: This helper fetches JSON from a server URL and turns it into the Rust type the caller asked for. It centralizes the repeated work of making an HTTP request, checking for failure, and decoding the response.

**Data flow**: It receives a URL and request headers. It builds an HTTP client, sends a GET request, records the HTTP status and content type, reads the response body as text, and rejects non-success status codes with a detailed error. If the request succeeds, it parses the body as JSON and returns the decoded value; if decoding fails, the error includes the original body to make debugging easier.

**Call relations**: This is the common network helper for environment lookups in this file. Higher-level flows use it when they need either repository-specific environment data or the global environment list, while this helper takes care of the lower-level HTTP and JSON details.

*Call graph*: 6 external calls (clone, bail!, builder, build_reqwest_client_with_custom_ca, append_error_log, format!).


##### `get_git_origins`  (lines 171–210)

```
fn get_git_origins() -> Vec<String>
```

**Purpose**: This function discovers the Git remote URLs for the current local repository. Those URLs are the clue used to find cloud environments connected to the same GitHub project.

**Data flow**: It runs Git commands in the current directory. First it tries `git config --get-regexp remote\..*\.url`, which reads configured remote URLs. If that gives no usable result, it tries `git remote -v`. It collects the URLs it finds, removes duplicates through `uniq`, and returns the final list. If Git is unavailable or no remotes are found, it returns an empty list.

**Call relations**: Both `autodetect_environment_id` and `list_environments` call this before asking the backend for repository-specific environments. It calls `uniq` before returning so later code does not make the same server request more than once for duplicate remotes.

*Call graph*: calls 1 internal fn (uniq); called by 2 (autodetect_environment_id, list_environments); 3 external calls (from_utf8_lossy, new, new).


##### `uniq`  (lines 212–216)

```
fn uniq(mut v: Vec<String>) -> Vec<String>
```

**Purpose**: This small helper removes duplicate strings from a list. Here it keeps repeated Git remote URLs from causing repeated environment lookups.

**Data flow**: It receives a list of strings, sorts the list, removes neighboring duplicates, and returns the cleaned list. The output may be in a different order because sorting is part of the duplicate-removal method.

**Call relations**: It is called by `get_git_origins` after Git remote URLs are collected. That keeps the rest of the environment-detection flow simpler because it can assume each returned URL is unique.

*Call graph*: called by 1 (get_git_origins).


##### `parse_owner_repo`  (lines 218–252)

```
fn parse_owner_repo(url: &str) -> Option<(String, String)>
```

**Purpose**: This function recognizes common GitHub remote URL formats and extracts the owner and repository name. It lets the program turn a Git URL into the exact repository identity the backend API expects.

**Data flow**: It receives a remote URL as text. It trims whitespace, handles SSH-style URLs such as `git@github.com:owner/repo.git`, and handles HTTP, HTTPS, git-protocol, and plain `github.com/owner/repo` forms. If it can recognize a GitHub repository, it returns the owner and repo as two strings; otherwise it returns nothing.

**Call relations**: Both `autodetect_environment_id` and `list_environments` call this after `get_git_origins` finds remote URLs. When parsing succeeds, those callers can build repository-specific backend URLs; when it fails, they simply skip that remote and continue.

*Call graph*: called by 2 (autodetect_environment_id, list_environments); 2 external calls (append_error_log, format!).


##### `list_environments`  (lines 256–362)

```
async fn list_environments(
    base_url: &str,
    headers: &HeaderMap,
) -> anyhow::Result<Vec<crate::app::EnvironmentRow>>
```

**Purpose**: This function builds the environment list shown to the terminal user interface. It combines environments linked to the current repository with the global environment list, removes duplicates, and sorts the result in a friendly order.

**Data flow**: It receives the backend base URL and request headers. It reads Git origins, parses GitHub owner/repo names, asks the backend for environments tied to each repository, and stores them in a map keyed by environment ID so duplicates collapse into one row. It then asks for the global environment list and merges that too. The final output is a sorted list of `EnvironmentRow` values, with pinned environments first, then labels alphabetically, then IDs.

**Call relations**: This is called by `resolve_environment_id` and `run_main` when the program needs environment choices, especially for the TUI modal. It uses `get_git_origins` and `parse_owner_repo` to find repository-specific candidates, logs successes with `info!`, logs recoverable failures with `warn!`, and returns by-repo results alone if the global list fails but some useful entries were already found.

*Call graph*: calls 2 internal fn (get_git_origins, parse_owner_repo); called by 2 (resolve_environment_id, run_main); 4 external calls (new, format!, info!, warn!).


### `config/src/host_name.rs`

`util` · `cross-cutting; computed on first hostname request and cached for the rest of the process`

This file answers a deceptively simple question: “What host am I running on?” That answer can come in different shapes. The operating system may report a short name like `runner-01`, while DNS may know the fuller name `runner-01.ci.example.com`. This file tries to return the best practical version.

The public entry point is `host_name()`. The first time it is called, it computes the name and stores the result in a process-wide cache. Later calls reuse that saved value. This is important because on Unix systems the first lookup may ask the local DNS resolver, which can block for a while.

The computation starts with the kernel hostname, meaning the name the operating system reports for the local machine. It trims spaces, removes a trailing dot, lowercases it, and rejects it if it is empty. Then it tries to find a fully qualified domain name, or FQDN: a complete DNS name with dots in it, like a full postal address rather than just a house name. If that succeeds, it returns the FQDN. If not, it falls back to the cleaned kernel hostname.

The result is best-effort classification, not proof of identity. In other words, it helps the program decide which host it appears to be running on, but it is not a security check.

#### Function details

##### `host_name`  (lines 15–17)

```
fn host_name() -> Option<String>
```

**Purpose**: Returns the cached hostname for this process. Other code uses this when it needs a stable, normalized name for the local machine without repeating potentially slow lookup work.

**Data flow**: It takes no input from the caller. It reads the process-wide cached value, computing it on first use through the lazy cache, and returns an optional string: either the chosen hostname or no value if even the basic hostname could not be used.

**Call relations**: This is the public doorway into the file. Code elsewhere calls `host_name` when it needs the machine name; behind the scenes the lazy cache calls `compute_host_name` once, then `host_name` simply hands back the saved result.


##### `compute_host_name`  (lines 19–34)

```
fn compute_host_name() -> Option<String>
```

**Purpose**: Builds the best hostname this file can provide. It starts with the operating system's hostname, then prefers a full DNS name if the local system can supply one.

**Data flow**: It reads the kernel hostname using `gethostname`, turns it into text, and passes it through `normalize_host_name` to trim and lowercase it. If that gives a usable name, it asks `local_fqdn_for_hostname` for a fuller DNS-qualified name. If one is found, that is returned; otherwise it returns the cleaned kernel hostname. If the kernel hostname is empty after cleanup, it returns no value.

**Call relations**: This function is the one-time worker behind the cached `host_name` value. It delegates cleanup to `normalize_host_name` and platform-specific DNS discovery to `local_fqdn_for_hostname`, then chooses the best fallback so callers still get a useful answer when DNS is incomplete.

*Call graph*: calls 2 internal fn (local_fqdn_for_hostname, normalize_host_name); 1 external calls (gethostname).


##### `normalize_host_name`  (lines 36–39)

```
fn normalize_host_name(hostname: &str) -> Option<String>
```

**Purpose**: Cleans up a hostname so comparisons are consistent. It removes harmless formatting differences like surrounding whitespace, a final dot, and uppercase letters.

**Data flow**: It receives a hostname string, trims whitespace, removes trailing dots, checks whether anything remains, and lowercases the result. It returns the cleaned string, or no value if the hostname becomes empty.

**Call relations**: This is the shared cleanup step. `compute_host_name` uses it for the operating system hostname, and `normalize_fqdn_candidate` uses it before deciding whether a possible full DNS name is good enough.

*Call graph*: called by 2 (compute_host_name, normalize_fqdn_candidate).


##### `local_fqdn_for_hostname`  (lines 66–68)

```
fn local_fqdn_for_hostname(_hostname: &str) -> Option<String>
```

**Purpose**: Tries to turn a local hostname into a fully qualified DNS name, such as `runner-01.ci.example.com`. The exact method depends on the operating system.

**Data flow**: It receives the cleaned local hostname. On Unix, it asks the system resolver through `getaddrinfo` for canonical names and keeps the first one that looks like a real DNS-qualified name. On Windows, it asks the system for the physical fully qualified DNS computer name. On other platforms, it returns no value. Any candidate name is checked with `normalize_fqdn_candidate` before being accepted.

**Call relations**: This function is called by `compute_host_name` after the basic hostname has been cleaned. It is the platform-specific lookup step: it reaches out to operating-system or DNS facilities, then hands back a better name only if it is clearly fuller than a short hostname.

*Call graph*: called by 1 (compute_host_name); 3 external calls (default, getaddrinfo, get_computer_name).


##### `normalize_fqdn_candidate`  (lines 70–72)

```
fn normalize_fqdn_candidate(hostname: &str) -> Option<String>
```

**Purpose**: Checks whether a possible hostname is really a DNS-qualified name. It accepts only cleaned names that contain a dot, because short names are not considered full DNS names here.

**Data flow**: It receives a candidate hostname, passes it through `normalize_host_name`, then tests whether the cleaned name contains `.`. If it does, the cleaned name comes out; if not, the function returns no value.

**Call relations**: This is the gatekeeper used by the full-name lookup path. `local_fqdn_for_hostname` uses it to avoid treating a short hostname returned by the system resolver as a true FQDN.

*Call graph*: calls 1 internal fn (normalize_host_name).


##### `tests::normalize_fqdn_candidate_accepts_dns_qualified_name`  (lines 80–85)

```
fn normalize_fqdn_candidate_accepts_dns_qualified_name()
```

**Purpose**: Verifies that a normal full DNS name is accepted. This protects the basic expected case for `normalize_fqdn_candidate`.

**Data flow**: It feeds `runner-01.ci.example.com` into the candidate-checking logic and compares the result with the same string wrapped as a successful value. The test changes no program state; it only passes or fails.

**Call relations**: This test exercises the acceptance path for `normalize_fqdn_candidate`. It uses `assert_eq!` to make sure the function keeps a valid DNS-qualified hostname.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_fqdn_candidate_rejects_short_name`  (lines 88–90)

```
fn normalize_fqdn_candidate_rejects_short_name()
```

**Purpose**: Verifies that a short hostname without dots is not treated as a full DNS name. This matters because the file only wants to prefer DNS results when they are genuinely more specific.

**Data flow**: It gives `runner-01` to `normalize_fqdn_candidate` and expects no value back. The test has no side effects beyond reporting success or failure.

**Call relations**: This test covers the rejection path for `normalize_fqdn_candidate`. It supports the behavior used by `local_fqdn_for_hostname`, where short resolver results should not override the cleaned kernel hostname as an FQDN.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_fqdn_candidate_trims_trailing_dot_and_normalizes_case`  (lines 93–98)

```
fn normalize_fqdn_candidate_trims_trailing_dot_and_normalizes_case()
```

**Purpose**: Verifies that full DNS names are cleaned before use. It checks that uppercase letters and a trailing DNS dot do not prevent a valid name from being accepted.

**Data flow**: It passes `RUNNER-01.CI.EXAMPLE.COM.` into `normalize_fqdn_candidate`. The function is expected to return `runner-01.ci.example.com`, showing that it lowercases the name and removes the final dot.

**Call relations**: This test confirms that `normalize_fqdn_candidate` relies on the same cleanup rules as `normalize_host_name`. It protects consistent matching behavior for hostnames that may be reported in different but equivalent forms.

*Call graph*: 1 external calls (assert_eq!).


### Runtime provenance checks
This file reports which Codex binary is running and whether key bundled helper resolution, especially ripgrep, is working.

### `cli/src/doctor/runtime.rs`

`domain_logic` · `doctor command run`

This file is part of Codex’s doctor command, which is like a health check for the command-line tool. Its job is not to run Codex’s main features. Instead, it gathers clues about the running program so a user or maintainer can understand the environment.

First, it records runtime provenance: the Codex version, the operating system and CPU type, the apparent install method, the build commit if one was embedded, and the path to the executable currently running. This matters because the same tool can be installed in several ways, and problems often depend on whether it came from npm, Homebrew, a standalone package, or a local build.

Second, it checks the search command. Codex relies on ripgrep, usually called `rg`, to search files quickly. Some installs bundle their own `rg`; others expect one to be available from the user’s system path, which is the list of folders the shell searches for commands. This file figures out which case applies, then verifies that the command exists or can run. If it cannot be verified, the doctor report warns the user and suggests installing ripgrep or repairing the package.

An important detail is that these checks are mostly informational. Runtime provenance always reports OK; deeper installation problems are left to other doctor checks.

#### Function details

##### `runtime_check`  (lines 24–49)

```
fn runtime_check() -> DoctorCheck
```

**Purpose**: Builds the doctor report row that says what Codex executable is currently running, what platform it is on, what install style it appears to use, and what build commit it came from. Someone would use this when they need a clear snapshot of the running CLI’s identity.

**Data flow**: It starts with the current executable path, if the operating system can provide it. It uses that path to infer the install context, reads the operating system and CPU architecture, adds the package version and build commit, and records the executable path as a detail. The result is a `DoctorCheck` marked OK with a short summary such as running a particular install method on a particular platform.

**Call relations**: This is one of the checks the doctor command can run when building its overall health report. It asks helper code outside this file to infer the install context and to format path details, uses `install_method_name` to make a short human-readable install label, and uses `build_commit` to include source-version information when available.

*Call graph*: calls 2 internal fn (new, install_method_name); 5 external calls (current_exe, format!, doctor_install_context, push_path_detail, vec!).


##### `search_check`  (lines 57–117)

```
fn search_check() -> DoctorCheck
```

**Purpose**: Checks whether Codex’s file-search command is available and looks usable. This matters because features that search the user’s files may be slower, limited, or broken if `rg` cannot be found or run.

**Data flow**: It finds the current executable, infers the install context, asks that context which `rg` command should be used, and decides whether that command appears to come from a bundled package or the system. If the command is a full path, it checks the file on disk and confirms it is really a file. If the command is just a name like `rg`, it tries running it with `--version`. The output is a `DoctorCheck` marked OK when the command is verified, or Warning when it cannot be verified, with details and a suggested fix on warning.

**Call relations**: The doctor command calls this as the runtime search health check. It uses `search_provider` to explain whether search is expected to come from the bundled Codex files or from the user’s system, and it hands the final status and details into `DoctorCheck` so the wider doctor report can display them.

*Call graph*: calls 2 internal fn (new, search_provider); 8 external calls (from_utf8_lossy, new, current_exe, format!, metadata, doctor_install_context, unreachable!, vec!).


##### `install_method_name`  (lines 119–127)

```
fn install_method_name(context: &InstallContext) -> &'static str
```

**Purpose**: Turns the detailed install context into a short label such as standalone, npm, bun, brew, or local build. This gives the doctor summary a simple phrase a user can recognize.

**Data flow**: It receives an install context that contains the detected install method. It compares that method against the known install types and returns a fixed text label. It does not change any state.

**Call relations**: It is used by `runtime_check` while that function is composing the short provenance summary. The fuller install description comes from elsewhere, while this helper provides the compact name used in the headline.

*Call graph*: called by 1 (runtime_check).


##### `search_provider`  (lines 129–149)

```
fn search_provider(context: &InstallContext) -> &'static str
```

**Purpose**: Decides whether the `rg` search command appears to be bundled with Codex or supplied by the user’s system. This helps explain where search is coming from, which is important when diagnosing broken package layouts or missing system tools.

**Data flow**: It receives the install context and asks it for the configured `rg` command. It then compares that command’s path with known package directories, including newer package layouts and an older standalone layout. If the command lives inside those package areas, it returns `bundled`; otherwise it returns `system`.

**Call relations**: It is called by `search_check` before the command is verified. Its answer becomes part of both the details and the summary, so the user can tell whether Codex is relying on its own packaged search tool or one found on the machine.

*Call graph*: calls 1 internal fn (rg_command); called by 1 (search_check); 1 external calls (matches!).


##### `build_commit`  (lines 151–155)

```
fn build_commit() -> &'static str
```

**Purpose**: Finds the source-code commit identifier embedded at build time, if one was provided. This helps support match a running binary back to the exact code it was built from.

**Data flow**: It looks for build-time environment values named `CODEX_BUILD_COMMIT` or `GIT_COMMIT`. If either was compiled into the program, it returns that value. If neither exists, it returns `unknown`.

**Call relations**: It is used by `runtime_check` while assembling the provenance details. The result is only reported as information; it does not affect whether the runtime check passes.

*Call graph*: 1 external calls (option_env!).

## 📊 State Registers Touched

- `reg-install-home-context` — The discovered Codex home folder, install location, bundled resources, and stable local installation identity.
- `reg-shell-workspace-environment` — The current machine, shell, PATH, working directory, project root, Git state, and environment variables used to make commands behave like the user’s terminal.
- `reg-exec-environment` — The active command-execution setup, including local or remote executor choice, sandbox helper paths, runtime paths, and process execution capabilities.
