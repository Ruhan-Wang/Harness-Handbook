# Plugin, secrets, and memory file stores  `stage-21.4`

This stage is the system’s long-term storage room. It sits behind the scenes and defines how three kinds of durable data live on disk: plugins, secrets, and memories. Its job is not the main work loop itself, but making sure important data is stored safely, found again later, and cleaned up when needed.

The plugin store file is like a careful warehouse manager. It decides where plugin files live, how a cached plugin is discovered or installed, which version should be used, and how old ones are removed without leaving the folder structure in a broken state.

The secrets files protect sensitive values such as tokens. One part defines the public rules: what a secret name can look like, how secrets are grouped, and how the code chooses a storage backend. Another part is the local backend, which saves encrypted secret files under the app’s home folder and keeps the passphrase in the operating system’s keyring. On Windows, the DPAPI wrapper uses the built-in Windows encryption service so different privilege levels can still share protected data.

The memories files manage a filesystem-based memory area. The local backend keeps all reads and writes inside the allowed root folder. The write-side code rebuilds workspace files from database results, creates per-rollout summary files with predictable names, deletes summaries that are no longer needed, safely clears memory directories without following dangerous symlinks, and prunes expired extension files. Together, these parts keep durable local state organized, private, and tidy.

## Files in this stage

### Plugin store
Implements the filesystem-backed plugin cache, including discovery, installation, version selection, validation, and removal.

### `core-plugins/src/store.rs`

`domain_logic` · `plugin install/uninstall, plugin lookup, and runtime plugin resolution`

This file is the concrete storage layer for marketplace plugins under two fixed subtrees: `plugins/cache` for installed code and `plugins/data` for per-plugin writable state. `PluginStore` wraps those roots as `AbsolutePathBuf`, enforcing at construction time that the supplied Codex home resolves to absolute cache/data paths. The cache layout is hierarchical: `<cache>/<marketplace>/<plugin>/<version>`, while data uses a flattened `<data>/<plugin>-<marketplace>` directory.

The main behavior centers on versioned installation and active-version discovery. `active_plugin_version` scans version-named subdirectories under a plugin’s base root, ignores non-directories and invalid version segments, sorts candidates with semantic-version comparison when possible, and applies a special rule: if the sentinel version `local` exists, it always wins over numbered releases. Installation validates that the source is a directory, reads `plugin.json` to confirm the manifest name matches the requested `PluginId`, derives or accepts a version string, validates that version as a safe path segment, then stages a full directory copy into a temporary sibling before renaming into place.

The atomic replacement path is careful about partial failure: it can add a new version beside an existing plugin root, or replace the whole plugin root via backup-and-rollback if necessary. After adding a new version into an existing root, it attempts to delete older version directories; if deletion fails and an older version would still outrank the new one (including `local`), it reports an error rather than silently leaving the wrong version active. Supporting helpers parse raw JSON for the optional manifest `version`, validate plugin/version path segments, recursively copy files, and normalize I/O failures into `PluginStoreError` with contextual messages.

#### Function details

##### `PluginStore::new`  (lines 34–37)

```
fn new(codex_home: PathBuf) -> Self
```

**Purpose**: Constructs a `PluginStore` from a Codex home path and treats non-absolute resolution as a programmer error. It is the infallible convenience constructor used by tests and higher-level setup code that expects a valid absolute home.

**Data flow**: Takes `codex_home: PathBuf`, forwards it to `PluginStore::try_new`, and either returns the resulting store or panics with a message that includes the underlying error. It does not mutate external state.

**Call relations**: This is the common entry used by many tests and setup helpers when creating a store should never fail. Its only delegated work is to `PluginStore::try_new`, which performs the actual path joining and absolute-path validation.

*Call graph*: called by 17 (hooks_only_scope_shares_plugin_resolution_without_loading_other_capabilities, new_with_options, load_plugins_ignores_project_config_files, active_plugin_version_compares_semver_versions_semantically, active_plugin_version_prefers_default_local_version_when_multiple_versions_exist, active_plugin_version_reads_version_directory_name, active_plugin_version_returns_latest_version_when_default_is_missing, install_copies_plugin_into_default_marketplace, install_rejects_blank_manifest_version, install_rejects_manifest_names_that_do_not_match_marketplace_plugin_name (+7 more)); 1 external calls (try_new).


##### `PluginStore::try_new`  (lines 39–47)

```
fn try_new(codex_home: PathBuf) -> Result<Self, PluginStoreError>
```

**Purpose**: Builds a store rooted at the cache and data subdirectories beneath a Codex home directory, returning a typed error instead of panicking. It establishes the invariant that both stored roots are absolute paths.

**Data flow**: Consumes `codex_home: PathBuf`, appends `PLUGINS_CACHE_DIR` and `PLUGINS_DATA_DIR`, converts both joined paths through `AbsolutePathBuf::from_absolute_path_checked`, maps any failure into `PluginStoreError::Io`, and returns `Ok(PluginStore { root, data_root })` on success.

**Call relations**: Called by orchestration code that loads or refreshes plugin caches and needs recoverable failure. `PluginStore::new` wraps this function for infallible callers; this function itself delegates only to path joining and absolute-path checking.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); called by 7 (installed_plugin_telemetry_metadata, refresh_curated_plugin_cache, refresh_non_curated_plugin_cache_with_mode, sync_remote_installed_plugin_bundles_once, remove_remote_plugin_cache, install_remote_plugin_bundle, try_new_rejects_relative_codex_home); 1 external calls (join).


##### `PluginStore::root`  (lines 49–51)

```
fn root(&self) -> &AbsolutePathBuf
```

**Purpose**: Exposes the cache root directory stored in the `PluginStore`. It is a simple accessor for callers that need the top-level plugin cache path.

**Data flow**: Reads `self.root` and returns it by shared reference as `&AbsolutePathBuf`. No transformation or side effects occur.

**Call relations**: This is a leaf accessor used wherever external code needs the cache root directly; it does not delegate further.


##### `PluginStore::plugin_base_root`  (lines 53–57)

```
fn plugin_base_root(&self, plugin_id: &PluginId) -> AbsolutePathBuf
```

**Purpose**: Computes the directory that contains all installed versions for a specific plugin. The path is grouped first by marketplace name and then by plugin name.

**Data flow**: Reads `self.root` plus `plugin_id.marketplace_name` and `plugin_id.plugin_name`, joins those segments, and returns a new `AbsolutePathBuf` representing `<cache>/<marketplace>/<plugin>`.

**Call relations**: Used as the common path primitive by version discovery, installation, root computation, and uninstall. Other methods build on this path rather than reconstructing the layout themselves.

*Call graph*: calls 1 internal fn (join); called by 4 (active_plugin_version, install_with_version, plugin_root, uninstall).


##### `PluginStore::plugin_root`  (lines 59–61)

```
fn plugin_root(&self, plugin_id: &PluginId, plugin_version: &str) -> AbsolutePathBuf
```

**Purpose**: Computes the full installation directory for one concrete plugin version. It extends the plugin base root with the version segment.

**Data flow**: Takes `plugin_id` and `plugin_version`, calls `plugin_base_root(plugin_id)`, joins `plugin_version`, and returns the resulting absolute path.

**Call relations**: Invoked during installation to report the final installed path and by callers that need a concrete version directory. It delegates path layout details to `PluginStore::plugin_base_root`.

*Call graph*: calls 1 internal fn (plugin_base_root); called by 1 (install_with_version).


##### `PluginStore::plugin_data_root`  (lines 63–68)

```
fn plugin_data_root(&self, plugin_id: &PluginId) -> AbsolutePathBuf
```

**Purpose**: Computes the writable data directory associated with a plugin, separate from the cached code bundle. Its naming scheme flattens plugin and marketplace into a single directory name.

**Data flow**: Reads `self.data_root` and formats `"<plugin_name>-<marketplace_name>"` from the `PluginId`, joins that string onto the data root, and returns the resulting `AbsolutePathBuf`.

**Call relations**: Used by plugin-loading and plugin-detail readers that need a stable per-plugin data location. It is independent of version selection and delegates only to string formatting and path joining.

*Call graph*: calls 1 internal fn (join); called by 2 (load_plugin, read_plugin_detail_for_marketplace_plugin); 1 external calls (format!).


##### `PluginStore::active_plugin_version`  (lines 70–91)

```
fn active_plugin_version(&self, plugin_id: &PluginId) -> Option<String>
```

**Purpose**: Discovers which installed version should be treated as active for a plugin by inspecting version directories on disk. It prefers the special `local` version if present; otherwise it selects the highest version after sorting.

**Data flow**: Reads the plugin base directory from `plugin_base_root(plugin_id)`, attempts `fs::read_dir`, short-circuiting to `None` on any read failure. It filters entries to directories with UTF-8 names, keeps only names accepted by `validate_plugin_version_segment`, sorts them with `compare_plugin_versions`, then returns `None` if empty, `Some("local")` if that sentinel exists anywhere, or the last sorted version otherwise.

**Call relations**: This is the core lookup used by configuration merging, plugin reads, `active_plugin_root`, and `is_installed`. It depends on the path layout from `plugin_base_root` and on the version ordering/validation helpers to avoid treating arbitrary directory names as installable versions.

*Call graph*: calls 1 internal fn (plugin_base_root); called by 4 (merge_configured_plugins_with_remote_installed, read_plugin_for_config, active_plugin_root, is_installed); 1 external calls (read_dir).


##### `PluginStore::active_plugin_root`  (lines 93–96)

```
fn active_plugin_root(&self, plugin_id: &PluginId) -> Option<AbsolutePathBuf>
```

**Purpose**: Returns the filesystem path of the currently active installed version for a plugin. It combines version discovery with path construction.

**Data flow**: Takes `plugin_id`, calls `active_plugin_version(plugin_id)`, and if a version is found maps it into `self.plugin_root(plugin_id, &plugin_version)`. It returns `Option<AbsolutePathBuf>`.

**Call relations**: Used by callers that need the actual directory to load or inspect a plugin. It is a thin adapter over `active_plugin_version`, turning the chosen version string into a concrete path.

*Call graph*: calls 1 internal fn (active_plugin_version); called by 3 (installed_plugin_name_for_marketplace, read_plugin_detail_for_marketplace_plugin, uninstall_plugin_id).


##### `PluginStore::is_installed`  (lines 98–100)

```
fn is_installed(&self, plugin_id: &PluginId) -> bool
```

**Purpose**: Checks whether any valid active installation exists for a plugin. It is a boolean convenience wrapper around active-version discovery.

**Data flow**: Calls `active_plugin_version(plugin_id)` and returns `true` if it yields `Some(_)`, otherwise `false`. No state is modified.

**Call relations**: This is a simple predicate for higher-level logic that only cares about presence. It delegates all filesystem inspection and version rules to `active_plugin_version`.

*Call graph*: calls 1 internal fn (active_plugin_version).


##### `PluginStore::install`  (lines 102–109)

```
fn install(
        &self,
        source_path: AbsolutePathBuf,
        plugin_id: PluginId,
    ) -> Result<PluginInstallResult, PluginStoreError>
```

**Purpose**: Installs a plugin from a source directory using the version declared in `plugin.json`, or `local` when no version is declared. It is the default installation path when the caller does not want to override the version string.

**Data flow**: Accepts `source_path: AbsolutePathBuf` and `plugin_id: PluginId`, derives a version by calling `plugin_version_for_source(source_path.as_path())`, then forwards all inputs to `install_with_version`. It returns the resulting `PluginInstallResult` or a `PluginStoreError`.

**Call relations**: Called by higher-level cache refresh and install flows that trust the source manifest to define the version. It delegates manifest parsing/version derivation to `plugin_version_for_source` and all actual validation/copying to `install_with_version`.

*Call graph*: calls 3 internal fn (install_with_version, plugin_version_for_source, as_path).


##### `PluginStore::install_with_version`  (lines 111–144)

```
fn install_with_version(
        &self,
        source_path: AbsolutePathBuf,
        plugin_id: PluginId,
        plugin_version: String,
    ) -> Result<PluginInstallResult, PluginStoreError>
```

**Purpose**: Performs the full validated installation of a plugin directory into the cache under an explicit version. It enforces source-directory existence, manifest name consistency, safe version naming, and atomic replacement semantics.

**Data flow**: Takes `source_path`, `plugin_id`, and `plugin_version`. It first checks `source_path.as_path().is_dir()`, then reads the manifest name via `plugin_name_for_source` and compares it to `plugin_id.plugin_name`, validates `plugin_version` with `validate_plugin_version_segment`, computes `installed_path` with `plugin_root`, and invokes `replace_plugin_root_atomically` with the source path, plugin base root, and version. On success it returns `PluginInstallResult { plugin_id, plugin_version, installed_path }`; on failure it returns `PluginStoreError::Invalid` or an I/O-wrapped error.

**Call relations**: This is the main installation worker, reached either from `install` or from callers that already chose a version. It relies on `plugin_name_for_source` to bind the source manifest to the requested plugin identity and on `replace_plugin_root_atomically` to perform the filesystem update safely.

*Call graph*: calls 6 internal fn (plugin_base_root, plugin_root, plugin_name_for_source, replace_plugin_root_atomically, validate_plugin_version_segment, as_path); called by 1 (install); 2 external calls (Invalid, format!).


##### `PluginStore::uninstall`  (lines 146–148)

```
fn uninstall(&self, plugin_id: &PluginId) -> Result<(), PluginStoreError>
```

**Purpose**: Removes all cached versions of a plugin by deleting its base cache directory. It does not touch the separate plugin data directory.

**Data flow**: Computes the plugin base root from `plugin_id` and passes that path to `remove_existing_target`. It returns `Ok(())` if the path is absent or successfully removed, otherwise a contextual `PluginStoreError`.

**Call relations**: Used by uninstall flows that want to clear the cached plugin bundle entirely. It delegates path computation to `plugin_base_root` and deletion semantics to `remove_existing_target`.

*Call graph*: calls 2 internal fn (plugin_base_root, remove_existing_target).


##### `PluginStoreError::io`  (lines 165–167)

```
fn io(context: &'static str, source: io::Error) -> Self
```

**Purpose**: Creates the `PluginStoreError::Io` variant with a fixed context string and source `io::Error`. It centralizes the error construction pattern used throughout filesystem operations.

**Data flow**: Takes `context: &'static str` and `source: io::Error`, wraps them into `PluginStoreError::Io { context, source }`, and returns the enum value.

**Call relations**: Used internally by filesystem-heavy helpers, especially the atomic replacement path, to preserve both a human-readable operation label and the original OS error.

*Call graph*: called by 1 (replace_plugin_root_atomically).


##### `plugin_version_for_source`  (lines 170–175)

```
fn plugin_version_for_source(source_path: &Path) -> Result<String, PluginStoreError>
```

**Purpose**: Determines the install version for a source plugin directory from its manifest, defaulting to `local` when no version field is present. It also validates that the resulting version is safe to use as a path segment.

**Data flow**: Reads `source_path`, calls `plugin_manifest_version_for_source(source_path)` to get `Option<String>`, substitutes `DEFAULT_PLUGIN_VERSION` when `None`, validates the final string with `validate_plugin_version_segment`, and returns the validated version or an error.

**Call relations**: Called by installation and cache-refresh code that derives versions from source bundles. It depends on raw manifest parsing from `plugin_manifest_version_for_source` and on `validate_plugin_version_segment` to reject unsafe or malformed values.

*Call graph*: calls 2 internal fn (plugin_manifest_version_for_source, validate_plugin_version_segment); called by 2 (refresh_non_curated_plugin_cache_with_mode, install).


##### `validate_plugin_version_segment`  (lines 177–194)

```
fn validate_plugin_version_segment(plugin_version: &str) -> Result<(), String>
```

**Purpose**: Validates that a plugin version string is non-empty, not a traversal token, and contains only a restricted ASCII character set. This protects the cache layout from invalid names and path manipulation.

**Data flow**: Consumes `plugin_version: &str`, checks for empty string, exact `.` or `..`, and then verifies every character is ASCII alphanumeric or one of `-`, `_`, `.`, `+`. It returns `Ok(())` on success or a descriptive `String` error on failure.

**Call relations**: This helper is used during installation, source-version derivation, remote bundle validation, and directory scanning. It acts as the shared gatekeeper for any string that may become a version directory name.

*Call graph*: called by 4 (validate_remote_plugin_bundle, install_with_version, plugin_version_for_source, remove_old_plugin_versions); 1 external calls (matches!).


##### `plugin_manifest_for_source`  (lines 196–199)

```
fn plugin_manifest_for_source(source_path: &Path) -> Result<PluginManifest, PluginStoreError>
```

**Purpose**: Loads and validates the full plugin manifest from a source directory using the crate-level manifest loader. It converts a missing or invalid manifest into a store-specific error.

**Data flow**: Passes `source_path` to `load_plugin_manifest`, expects an `Option<PluginManifest>`, and returns the manifest on `Some` or `PluginStoreError::Invalid("missing or invalid plugin.json")` on `None`.

**Call relations**: Used only by `plugin_name_for_source`, which needs the parsed manifest name field. It delegates all manifest-format knowledge to `load_plugin_manifest`.

*Call graph*: calls 1 internal fn (load_plugin_manifest); called by 1 (plugin_name_for_source).


##### `plugin_manifest_version_for_source`  (lines 208–233)

```
fn plugin_manifest_version_for_source(
    source_path: &Path,
) -> Result<Option<String>, PluginStoreError>
```

**Purpose**: Reads only the optional `version` field from `plugin.json` in a source directory, preserving the distinction between absent, blank, non-string, and malformed JSON cases. It avoids requiring the full manifest schema just to derive an install version.

**Data flow**: Finds the manifest path with `find_plugin_manifest_path(source_path)` and errors if absent. It reads the file as text, deserializes into `RawPluginManifestVersion { version: Option<JsonValue> }`, returns `Ok(None)` when the field is missing, errors if the field is not a JSON string, trims whitespace, errors if the trimmed string is blank, and otherwise returns `Ok(Some(version.to_string()))`.

**Call relations**: Called by `plugin_version_for_source` as the low-level manifest reader for version extraction. It intentionally uses a minimal deserialization struct so version parsing remains tolerant of unrelated manifest fields.

*Call graph*: called by 1 (plugin_version_for_source); 4 external calls (find_plugin_manifest_path, Invalid, read_to_string, from_str).


##### `plugin_name_for_source`  (lines 235–242)

```
fn plugin_name_for_source(source_path: &Path) -> Result<String, PluginStoreError>
```

**Purpose**: Extracts and validates the plugin name from a source manifest before installation. It ensures the manifest name itself is a valid plugin path/name segment.

**Data flow**: Loads the manifest via `plugin_manifest_for_source`, moves out `manifest.name`, validates it with `validate_plugin_segment(&plugin_name, "plugin name")`, and returns the original string on success or a `PluginStoreError::Invalid` on failure.

**Call relations**: Used by `install_with_version` to verify that the source bundle actually belongs to the requested `PluginId`. It depends on `plugin_manifest_for_source` for parsing and on `validate_plugin_segment` for naming rules.

*Call graph*: calls 1 internal fn (plugin_manifest_for_source); called by 1 (install_with_version); 1 external calls (validate_plugin_segment).


##### `remove_existing_target`  (lines 244–258)

```
fn remove_existing_target(path: &Path) -> Result<(), PluginStoreError>
```

**Purpose**: Deletes an existing filesystem target regardless of whether it is a file or directory, and treats a missing path as success. It is the generic removal primitive used for uninstalling cached plugin roots.

**Data flow**: Takes `path: &Path`, returns early with `Ok(())` if `!path.exists()`, otherwise checks `path.is_dir()` and calls either `fs::remove_dir_all` or `fs::remove_file`. Any I/O failure is wrapped as `PluginStoreError::Io` with a fixed context.

**Call relations**: Called by `PluginStore::uninstall` after it computes the plugin base root. It encapsulates the existence check and file-vs-directory branching so callers do not need to care about the current target type.

*Call graph*: called by 1 (uninstall); 4 external calls (exists, is_dir, remove_dir_all, remove_file).


##### `replace_plugin_root_atomically`  (lines 260–334)

```
fn replace_plugin_root_atomically(
    source: &Path,
    target_root: &Path,
    plugin_version: &str,
) -> Result<(), PluginStoreError>
```

**Purpose**: Stages a plugin installation in a temporary sibling directory and then renames it into place, with backup-and-rollback logic when replacing an existing plugin root. It is the file’s core safety mechanism for avoiding partially written cache entries.

**Data flow**: Accepts `source`, `target_root`, and `plugin_version`. It validates that `target_root` has a parent and file name, creates the parent directory, creates a temporary staging directory under that parent, copies the source tree into `<staging>/<plugin_dir_name>/<plugin_version>` via `copy_dir_recursive`, and then chooses one of three activation paths: if `target_root` exists but the specific version does not, it renames only the staged version directory into the existing root and then calls `remove_old_plugin_versions`; if `target_root` exists and must be replaced wholesale, it renames the old root into a temporary backup, tries to rename the staged root into place, and on failure attempts rollback or emits an `Invalid` error describing where the backup was left; if `target_root` does not exist, it renames the staged root directly into place. It returns `Ok(())` on success or contextual `PluginStoreError` values on any failure.

**Call relations**: This function is invoked exclusively by `install_with_version` after all manifest and version validation has passed. It delegates recursive copying to `copy_dir_recursive`, uses `PluginStoreError::io` for most filesystem failures, and calls `remove_old_plugin_versions` only in the incremental-addition case to ensure the newly installed version becomes the active one.

*Call graph*: calls 3 internal fn (io, copy_dir_recursive, remove_old_plugin_versions); called by 1 (install_with_version); 9 external calls (exists, file_name, join, parent, Invalid, format!, create_dir_all, rename, new).


##### `remove_old_plugin_versions`  (lines 336–368)

```
fn remove_old_plugin_versions(
    target_root: &Path,
    plugin_version: &str,
) -> Result<(), PluginStoreError>
```

**Purpose**: Deletes obsolete version directories from an existing plugin root after a new version has been added. It also detects the dangerous case where a failed deletion would leave an older version still selected as active.

**Data flow**: Reads directory entries under `target_root`; if `read_dir` fails, it silently returns `Ok(())`. For each entry, it skips non-directories, non-UTF-8 names, the newly installed `plugin_version`, and names that fail `validate_plugin_version_segment`. For remaining version directories it attempts `fs::remove_dir_all`; if removal fails and `old_plugin_version_would_stay_active(&version, plugin_version)` is true, it returns `PluginStoreError::Invalid` explaining that the new version could not be activated while the old one remains active. Otherwise it continues and finally returns `Ok(())`.

**Call relations**: Called from `replace_plugin_root_atomically` only when a new version is inserted into an already existing plugin root. It relies on `old_plugin_version_would_stay_active` to decide whether a deletion failure is merely cleanup noise or a correctness problem for active-version selection.

*Call graph*: calls 2 internal fn (old_plugin_version_would_stay_active, validate_plugin_version_segment); called by 1 (replace_plugin_root_atomically); 4 external calls (Invalid, format!, read_dir, remove_dir_all).


##### `old_plugin_version_would_stay_active`  (lines 370–373)

```
fn old_plugin_version_would_stay_active(old_version: &str, new_version: &str) -> bool
```

**Purpose**: Determines whether an undeleted old version would outrank a newly installed version under the store’s active-version rules. It treats `local` as always active and otherwise compares versions semantically when possible.

**Data flow**: Takes `old_version` and `new_version`, returns `true` if `old_version == DEFAULT_PLUGIN_VERSION` or if `compare_plugin_versions(old_version, new_version)` reports the old version as greater than the new one; otherwise returns `false`.

**Call relations**: Used only by `remove_old_plugin_versions` to decide whether a failed cleanup prevents the new version from becoming active. It delegates ordering details to `compare_plugin_versions`.

*Call graph*: calls 1 internal fn (compare_plugin_versions); called by 1 (remove_old_plugin_versions).


##### `compare_plugin_versions`  (lines 375–380)

```
fn compare_plugin_versions(left: &str, right: &str) -> Ordering
```

**Purpose**: Orders two version strings using semantic version comparison when both parse as `semver::Version`, falling back to plain string comparison otherwise. This gives sensible ordering for release versions without rejecting non-semver labels.

**Data flow**: Parses `left` and `right` with `Version::parse`. If both succeed, it returns `left.cmp(&right)` on the parsed `Version` values; otherwise it returns `left.cmp(right)` on the original strings.

**Call relations**: Used by active-version discovery for sorting and by old-version checks during cleanup. It is the shared ordering primitive that keeps semver-aware and non-semver version names interoperable.

*Call graph*: called by 1 (old_plugin_version_would_stay_active); 1 external calls (parse).


##### `copy_dir_recursive`  (lines 382–406)

```
fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), PluginStoreError>
```

**Purpose**: Recursively copies a source plugin directory tree into a target directory, creating directories as needed and copying only regular files. It is the staging-time file population step for installation.

**Data flow**: Creates `target` with `fs::create_dir_all`, iterates `fs::read_dir(source)`, maps entry and metadata failures into contextual `PluginStoreError::Io`, and for each entry either recurses into subdirectories or copies files with `fs::copy` to `target.join(entry.file_name())`. Non-file, non-directory entries are ignored.

**Call relations**: Called by `replace_plugin_root_atomically` to build the staged plugin tree before any rename occurs. Its recursive structure ensures the staged directory mirrors the source bundle layout.

*Call graph*: called by 1 (replace_plugin_root_atomically); 4 external calls (join, copy, create_dir_all, read_dir).


### Secrets backend
Defines the secrets API and then realizes it with a local encrypted file-backed backend using OS-protected key material.

### `windows-sandbox-rs/src/dpapi.rs`

`io_transport` · `credential encode/decode when secrets are stored or read`

This file is a small Win32 interop layer around DPAPI. It converts Rust byte slices into `CRYPT_INTEGER_BLOB` structures, calls `CryptProtectData` and `CryptUnprotectData`, and copies the returned heap-allocated buffers into owned `Vec<u8>` values before freeing the original Windows memory with `LocalFree`.

The helper `make_blob` is intentionally minimal: it creates a blob view over caller-owned bytes without copying. Both public functions then allocate an empty output blob, invoke the corresponding DPAPI routine, and check the returned success flag. On failure they report the current Win32 error code via `GetLastError` inside an `anyhow` error.

A notable design choice is the flags passed to both APIs: `CRYPTPROTECT_UI_FORBIDDEN | CRYPTPROTECT_LOCAL_MACHINE`. UI is disabled so these operations are non-interactive, and machine scope is used rather than user scope so data encrypted by one privilege level can be decrypted by another on the same machine. After a successful call, the code treats the output blob as a raw byte slice of length `cbData`, clones it into Rust-owned memory, and frees the DPAPI-allocated buffer if non-null. The module therefore presents a safe, allocation-owning API despite relying on unsafe FFI internally.

#### Function details

##### `make_blob`  (lines 12–17)

```
fn make_blob(data: &[u8]) -> CRYPT_INTEGER_BLOB
```

**Purpose**: Builds a `CRYPT_INTEGER_BLOB` view over an existing byte slice for DPAPI calls. It avoids copying and simply points the Win32 structure at caller-owned memory.

**Data flow**: It takes `&[u8]`, sets `cbData` to the slice length as `u32`, casts the slice pointer to `*mut u8`, and returns the populated `CRYPT_INTEGER_BLOB`. It does not allocate or mutate external state.

**Call relations**: This helper is used by both `protect` and `unprotect` to prepare their input blobs before calling the Win32 cryptography APIs.

*Call graph*: called by 2 (protect, unprotect).


##### `protect`  (lines 20–51)

```
fn protect(data: &[u8]) -> Result<Vec<u8>>
```

**Purpose**: Encrypts arbitrary bytes with DPAPI under machine scope and returns the protected blob. It is the module’s public encryption entrypoint.

**Data flow**: It accepts plaintext bytes, wraps them with `make_blob`, initializes an empty output blob, and calls `CryptProtectData` with null optional parameters plus `CRYPTPROTECT_UI_FORBIDDEN | CRYPTPROTECT_LOCAL_MACHINE`. On success it copies the returned `pbData..pbData+cbData` into a `Vec<u8>`, frees the DPAPI buffer with `LocalFree` if present, and returns the vector; on failure it returns an `anyhow` error containing `GetLastError()`.

**Call relations**: This function is a standalone utility wrapper; it delegates only to `make_blob` and the Win32 API, then performs ownership conversion and cleanup.

*Call graph*: calls 1 internal fn (make_blob); 6 external calls (anyhow!, null, null_mut, from_raw_parts, LocalFree, CryptProtectData).


##### `unprotect`  (lines 54–85)

```
fn unprotect(blob: &[u8]) -> Result<Vec<u8>>
```

**Purpose**: Decrypts a DPAPI-protected blob produced under the same machine scope and returns the original plaintext bytes. It is the inverse of `protect`.

**Data flow**: It takes encrypted bytes, creates an input blob with `make_blob`, initializes an empty output blob, and calls `CryptUnprotectData` with the same machine-scope and no-UI flags. If successful it copies the decrypted output buffer into a `Vec<u8>`, frees the DPAPI allocation with `LocalFree` when non-null, and returns the plaintext; otherwise it returns an `anyhow` error with the Win32 last-error code.

**Call relations**: This function is called by password-decoding logic elsewhere in the system. Internally it mirrors `protect`, delegating to `make_blob` and the DPAPI unprotect API before converting the result into Rust-owned memory.

*Call graph*: calls 1 internal fn (make_blob); called by 1 (decode_password); 6 external calls (anyhow!, null, null_mut, from_raw_parts, LocalFree, CryptUnprotectData).


### `secrets/src/lib.rs`

`domain_logic` · `config load and request handling for secret reads/writes; also used in tests and backend setup`

This file is the crate’s public façade for secret storage. It introduces `SecretName`, a thin wrapper around `String` that enforces a strict invariant at construction time: names must be non-empty after trimming and may contain only ASCII `A-Z`, digits, and `_`. `SecretScope` distinguishes globally shared secrets from environment-specific ones and can convert a `(scope, name)` pair into a stable canonical key such as `global/NAME` or `env/<environment_id>/NAME`; that key format is what downstream backends use as their durable identifier.

The file also defines `SecretListEntry`, the serializable `SecretsBackendKind` enum, and the `SecretsBackend` trait with CRUD-plus-list operations returning `anyhow::Result`. `SecretsManager` is a lightweight wrapper around `Arc<dyn SecretsBackend>`; its constructors choose the concrete backend (`LocalSecretsBackend` in this version), optionally injecting a custom `KeyringStore` and local namespace for tests or specialized callers. All manager methods are pure delegation, keeping backend-specific behavior out of callers.

Two path-derived helpers encode important stability choices. `environment_id_from_cwd` prefers the Git repository root directory name when available, but falls back to a `cwd-<12 hex chars>` SHA-256 prefix of the canonicalized working directory, avoiding empty or path-unsafe IDs. `compute_keyring_account` similarly hashes the canonical `codex_home` path into `secrets|<16 hex chars>` so different homes map to distinct OS keyring accounts without exposing raw paths. The tests in this file verify the fallback environment-ID format and an end-to-end local backend round trip through the manager.

#### Function details

##### `SecretName::new`  (lines 29–39)

```
fn new(raw: &str) -> Result<Self>
```

**Purpose**: Constructs a validated `SecretName` from raw user or parsed input. It trims surrounding whitespace, rejects empty names, and enforces the crate’s uppercase ASCII identifier format.

**Data flow**: Takes `raw: &str`, derives `trimmed = raw.trim()`, checks two invariants with `anyhow::ensure!`, then wraps `trimmed.to_string()` in `SecretName`. On failure it returns an error explaining whether the name was empty or contained invalid characters; it does not mutate external state.

**Call relations**: This is the normalization gate used whenever a secret name enters the system, including canonical-key parsing, local backend file-writing paths, and the manager round-trip test. Downstream code relies on this constructor so later operations can assume names are already sanitized and backend-safe.

*Call graph*: called by 6 (compute_secret_name, parse_canonical_key, local_namespaces_write_separate_files, save_file_does_not_leave_temp_files, set_fails_when_keyring_is_unavailable, manager_round_trips_local_backend); 1 external calls (ensure!).


##### `SecretName::as_str`  (lines 41–43)

```
fn as_str(&self) -> &str
```

**Purpose**: Exposes the inner secret name as `&str` without copying. It is the read-only accessor used when formatting keys or displaying names.

**Data flow**: Reads the inner `String` field and returns `self.0.as_str()`. It performs no allocation, validation, or side effects.

**Call relations**: This accessor supports formatting and key construction elsewhere in the crate, especially `SecretScope::canonical_key`, which needs the validated name text to build backend map keys.


##### `SecretName::fmt`  (lines 47–49)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Implements `fmt::Display` for `SecretName` by printing the validated inner identifier exactly as stored. This lets names appear naturally in logs, messages, and formatted strings.

**Data flow**: Receives a formatter, reads `self.0`, and writes it into `f` via `write!`. It returns the standard `fmt::Result` from the formatter write.

**Call relations**: This method is invoked implicitly by Rust formatting machinery whenever a `SecretName` is rendered with `{}`. It does not delegate to crate logic beyond the formatter itself.

*Call graph*: 1 external calls (write!).


##### `SecretScope::environment`  (lines 59–64)

```
fn environment(environment_id: impl Into<String>) -> Result<Self>
```

**Purpose**: Builds an environment-scoped secret namespace from an arbitrary string-like input. It trims whitespace and rejects empty environment IDs before storing them.

**Data flow**: Accepts `environment_id: impl Into<String>`, converts it into an owned `String`, trims it for validation, and returns `SecretScope::Environment(trimmed.to_string())` if non-empty. Invalid empty input yields an error; no external state is touched.

**Call relations**: This constructor is used when reconstructing scopes from canonical keys and anywhere callers need a validated environment scope. It centralizes the non-empty invariant so later code can safely embed the environment ID into canonical storage keys.

*Call graph*: called by 1 (parse_canonical_key); 3 external calls (into, Environment, ensure!).


##### `SecretScope::canonical_key`  (lines 66–74)

```
fn canonical_key(&self, name: &SecretName) -> String
```

**Purpose**: Converts a scope/name pair into the stable string key used by backends for persistence and lookup. The format is intentionally explicit about whether the secret is global or environment-specific.

**Data flow**: Reads `self` and `name`, then returns either `global/<name>` or `env/<environment_id>/<name>` using `format!`. It allocates a new `String` but does not mutate any state.

**Call relations**: Backend implementations call this during `set`, `get`, and `delete` to derive the exact durable identifier under which a secret is stored. It is the bridge between typed API inputs and backend key space.

*Call graph*: called by 3 (delete, get, set); 1 external calls (format!).


##### `SecretsManager::new`  (lines 103–111)

```
fn new(codex_home: PathBuf, backend_kind: SecretsBackendKind) -> Self
```

**Purpose**: Creates a `SecretsManager` with the default OS keyring integration for the selected backend kind. In the current implementation, that means constructing a local backend backed by `DefaultKeyringStore`.

**Data flow**: Consumes `codex_home: PathBuf` and `backend_kind`, creates `Arc<dyn KeyringStore>` as `Arc::new(DefaultKeyringStore)`, matches on the backend kind, constructs `LocalSecretsBackend::new(codex_home, keyring_store)`, wraps it in `Arc<dyn SecretsBackend>`, and returns `SecretsManager { backend }`.

**Call relations**: This is the standard production constructor used when callers do not need to inject test doubles or alternate namespaces. It delegates backend-specific setup to `LocalSecretsBackend::new` after selecting the implementation from `SecretsBackendKind`.

*Call graph*: calls 1 internal fn (new); 1 external calls (new).


##### `SecretsManager::new_with_keyring_store`  (lines 113–124)

```
fn new_with_keyring_store(
        codex_home: PathBuf,
        backend_kind: SecretsBackendKind,
        keyring_store: Arc<dyn KeyringStore>,
    ) -> Self
```

**Purpose**: Creates a manager like `new`, but with an injected `KeyringStore` implementation. This supports tests and callers that need to control keyring behavior explicitly.

**Data flow**: Consumes `codex_home`, `backend_kind`, and `keyring_store: Arc<dyn KeyringStore>`, matches on the backend kind, constructs `LocalSecretsBackend::new(codex_home, keyring_store)`, stores it behind `Arc<dyn SecretsBackend>`, and returns the manager.

**Call relations**: The round-trip test uses this constructor with `MockKeyringStore` to avoid depending on the real OS keyring. It sits between callers and backend construction, forwarding the injected dependency into the local backend.

*Call graph*: calls 1 internal fn (new); called by 1 (manager_round_trips_local_backend); 1 external calls (new).


##### `SecretsManager::new_with_keyring_store_and_namespace`  (lines 126–140)

```
fn new_with_keyring_store_and_namespace(
        codex_home: PathBuf,
        backend_kind: SecretsBackendKind,
        keyring_store: Arc<dyn KeyringStore>,
        namespace: LocalSecretsNamespace,
```

**Purpose**: Creates a manager with both an injected keyring store and an explicit local namespace. This is the most configurable constructor and is used where tests or higher-level auth flows need isolated secret stores.

**Data flow**: Consumes `codex_home`, `backend_kind`, `keyring_store`, and `namespace`, matches on the backend kind, constructs `LocalSecretsBackend::new_with_namespace(codex_home, keyring_store, namespace)`, wraps it in `Arc<dyn SecretsBackend>`, and returns `SecretsManager { backend }`.

**Call relations**: This constructor is used by tests and token-management code that need deterministic separation between secret stores. It delegates all namespace-specific behavior to `LocalSecretsBackend::new_with_namespace` while preserving the same manager API.

*Call graph*: calls 1 internal fn (new_with_namespace); called by 9 (new, assert_keyring_saved_auth_and_removed_fallback, seed_secrets_backend_and_fallback_auth_file_for_delete, seed_secrets_backend_with_auth, delete_oauth_tokens_from_secrets_keyring, load_oauth_tokens_from_secrets_keyring, save_oauth_tokens_to_secrets_keyring, delete_oauth_tokens_with_secrets_backend_removes_secrets_and_file, save_oauth_tokens_with_secrets_backend_writes_encrypted_storage); 1 external calls (new).


##### `SecretsManager::set`  (lines 142–144)

```
fn set(&self, scope: &SecretScope, name: &SecretName, value: &str) -> Result<()>
```

**Purpose**: Stores or overwrites a secret value through the configured backend. It is the manager’s write entry point for callers that already have validated scope and name objects.

**Data flow**: Takes `&self`, `scope`, `name`, and `value: &str`, then forwards them unchanged to `self.backend.set(scope, name, value)`. It returns the backend’s `Result<()>` and does not add local state.

**Call relations**: Higher-level save flows call this method instead of talking to the backend directly. Its role is purely delegation, preserving the abstraction boundary so callers remain backend-agnostic.

*Call graph*: called by 1 (save).


##### `SecretsManager::get`  (lines 146–148)

```
fn get(&self, scope: &SecretScope, name: &SecretName) -> Result<Option<String>>
```

**Purpose**: Fetches a secret value from the configured backend, returning `None` when the secret is absent. It is the manager’s read entry point.

**Data flow**: Accepts `scope` and `name`, forwards them to `self.backend.get(scope, name)`, and returns `Result<Option<String>>`. It neither transforms the value nor caches it.

**Call relations**: Load paths invoke this method to retrieve secrets without depending on backend details. It simply relays the request to the selected backend implementation.

*Call graph*: called by 1 (load).


##### `SecretsManager::delete`  (lines 150–152)

```
fn delete(&self, scope: &SecretScope, name: &SecretName) -> Result<bool>
```

**Purpose**: Removes a secret from the configured backend and reports whether anything was actually deleted. It is the manager’s deletion entry point.

**Data flow**: Accepts `scope` and `name`, calls `self.backend.delete(scope, name)`, and returns `Result<bool>` where the boolean indicates presence/removal according to backend semantics.

**Call relations**: Delete flows call this wrapper to erase secrets while staying insulated from backend-specific storage mechanics. The manager itself performs no extra cleanup beyond delegation.

*Call graph*: called by 1 (delete).


##### `SecretsManager::list`  (lines 154–156)

```
fn list(&self, scope_filter: Option<&SecretScope>) -> Result<Vec<SecretListEntry>>
```

**Purpose**: Enumerates stored secrets, optionally restricted to a single scope. It returns metadata entries rather than secret values.

**Data flow**: Accepts `scope_filter: Option<&SecretScope>`, forwards it to `self.backend.list(scope_filter)`, and returns `Result<Vec<SecretListEntry>>`. No local filtering or sorting is added here.

**Call relations**: Callers use this to inspect available secrets through the backend abstraction. The manager’s role is to expose the backend capability without leaking implementation details.


##### `environment_id_from_cwd`  (lines 159–180)

```
fn environment_id_from_cwd(cwd: &Path) -> String
```

**Purpose**: Derives a stable environment identifier from a working directory. It prefers a human-readable Git repository root name and falls back to a hashed canonical path when no suitable repo name exists.

**Data flow**: Reads `cwd: &Path`, asks `get_git_repo_root(cwd)` for a repository root, and if present extracts `file_name()`, converts it lossily to text, trims it, and returns that non-empty name. Otherwise it canonicalizes `cwd` (falling back to the original path on error), converts the path to an owned string, hashes it with `Sha256`, takes the first 12 hex characters when available, and returns `cwd-<short>`.

**Call relations**: The included test exercises the fallback branch to verify the exact `cwd-` prefix and hash truncation behavior. This helper is independent of the backend manager but feeds environment-scoped secret naming elsewhere in the system.

*Call graph*: called by 1 (environment_id_fallback_has_cwd_prefix); 4 external calls (canonicalize, new, get_git_repo_root, format!).


##### `compute_keyring_account`  (lines 183–195)

```
fn compute_keyring_account(codex_home: &Path) -> String
```

**Purpose**: Computes the OS keyring account identifier used for the local secrets passphrase. It intentionally derives the account from the `codex_home` path so separate homes do not collide.

**Data flow**: Reads `codex_home: &Path`, canonicalizes it with fallback to the original path, converts the resulting path to an owned string, hashes the bytes with `Sha256`, formats the digest as hex, takes the first 16 characters when available, and returns `secrets|<short>`.

**Call relations**: Backend code uses this helper when interacting with the keyring store so account naming is deterministic and path-derived. It encapsulates the hashing/truncation policy in one place rather than duplicating it in backend implementations.

*Call graph*: 3 external calls (canonicalize, new, format!).


##### `keyring_service`  (lines 197–199)

```
fn keyring_service() -> &'static str
```

**Purpose**: Returns the fixed keyring service name used by this crate. It centralizes the service string behind a function for internal callers.

**Data flow**: Reads the module constant `KEYRING_SERVICE` and returns it as `&'static str`. There is no allocation or mutation.

**Call relations**: Internal backend code calls this helper when it needs the service identifier for keyring operations. The function exists to avoid scattering the literal `"codex"` across the crate.


##### `tests::environment_id_fallback_has_cwd_prefix`  (lines 208–223)

```
fn environment_id_fallback_has_cwd_prefix()
```

**Purpose**: Verifies that `environment_id_from_cwd` uses the hashed fallback format when given a temporary directory outside a Git repository. It checks both the `cwd-` prefix and the exact 12-character digest truncation.

**Data flow**: Creates a temporary directory, calls `environment_id_from_cwd(dir.path())`, independently canonicalizes and hashes the directory path with `Sha256`, computes the expected short hex prefix, and asserts equality with the returned environment ID.

**Call relations**: This unit test directly exercises the non-Git branch of `environment_id_from_cwd`. It does not delegate to other crate logic beyond the helper under test and standard hashing/path operations.

*Call graph*: calls 1 internal fn (environment_id_from_cwd); 4 external calls (new, assert_eq!, format!, tempdir).


##### `tests::manager_round_trips_local_backend`  (lines 226–247)

```
fn manager_round_trips_local_backend() -> Result<()>
```

**Purpose**: Exercises an end-to-end local secret lifecycle through `SecretsManager`: create manager, store a secret, read it back, list it, delete it, and confirm absence. It validates that the manager delegates correctly and that the local backend behaves coherently under a mock keyring.

**Data flow**: Creates a temporary `codex_home`, a default `MockKeyringStore`, and a manager via `new_with_keyring_store`; constructs `SecretScope::Global` and `SecretName::new("GITHUB_TOKEN")`; writes `"token-1"`, reads it back and asserts `Some`, lists all entries and checks length/name, deletes the secret and asserts success, then confirms a subsequent `get` returns `None`.

**Call relations**: This test drives the manager constructor and CRUD/list delegation path against the local backend. It is the main integration-style proof in this file that the public API and backend wiring work together.

*Call graph*: calls 2 internal fn (new, new_with_keyring_store); 5 external calls (new, assert!, assert_eq!, default, tempdir).


### `secrets/src/local.rs`

`domain_logic` · `config load and secret read/write operations`

This file defines the concrete `LocalSecretsBackend` used for local secret persistence, plus the serialized `SecretsFile` schema and namespace selection enum `LocalSecretsNamespace`. Secrets are stored as a `BTreeMap<String, String>` keyed by each scope/name pair’s canonical string form, serialized as JSON, then encrypted with `age` using a scrypt-derived recipient/identity and a randomly generated passphrase kept in a `KeyringStore`. The backend supports three namespaces—managed secrets, Codex auth, and MCP OAuth—by selecting different filenames inside `<codex_home>/secrets`.

The main flow for `set`, `get`, `delete`, and `list` is: derive the canonical key from `SecretScope` and `SecretName`, load and decrypt the file if present, mutate or inspect the in-memory map, and optionally re-encrypt and save. Missing files are treated as an empty secrets store. Schema versioning is explicit: version `0` is upgraded in memory to the current version, while any version newer than `SECRETS_VERSION` is rejected. Writes are done atomically through a temp file plus rename, with a Windows-specific replace fallback.

Security-sensitive details are easy to miss: generated passphrases are 32 random bytes encoded with base64 for ASCII-safe keyring storage; the temporary random buffer is wiped with volatile writes plus a compiler fence; and invalid canonical keys encountered during listing are skipped with a warning rather than failing the whole operation. Tests cover schema rejection, keyring failure propagation, temp-file cleanup, and namespace/file separation.

#### Function details

##### `SecretsFile::new_empty`  (lines 60–65)

```
fn new_empty() -> Self
```

**Purpose**: Constructs a fresh in-memory secrets file with the current schema version and no stored secrets. It is the default representation used when no encrypted file exists yet.

**Data flow**: It takes no arguments, creates a `SecretsFile` with `version` set to `SECRETS_VERSION` and `secrets` set to an empty `BTreeMap`, and returns that struct without touching external state.

**Call relations**: It is used by `LocalSecretsBackend::load_file` on the missing-file path so callers of backend CRUD methods can treat first use as an empty store instead of an error.

*Call graph*: called by 1 (load_file); 1 external calls (new).


##### `LocalSecretsBackend::new`  (lines 76–82)

```
fn new(codex_home: PathBuf, keyring_store: Arc<dyn KeyringStore>) -> Self
```

**Purpose**: Builds a backend for the default managed-secrets namespace. It is the convenience constructor used by most callers and tests.

**Data flow**: It receives a `PathBuf` for `codex_home` and an `Arc<dyn KeyringStore>`, forwards both along with `LocalSecretsNamespace::ManagedSecrets`, and returns the initialized backend.

**Call relations**: This constructor is the normal entry into the backend from production code and tests; it delegates namespace selection to `LocalSecretsBackend::new_with_namespace` so all initialization logic stays centralized.

*Call graph*: called by 5 (new, new_with_keyring_store, load_file_rejects_newer_schema_versions, save_file_does_not_leave_temp_files, set_fails_when_keyring_is_unavailable); 1 external calls (new_with_namespace).


##### `LocalSecretsBackend::new_with_namespace`  (lines 84–94)

```
fn new_with_namespace(
        codex_home: PathBuf,
        keyring_store: Arc<dyn KeyringStore>,
        namespace: LocalSecretsNamespace,
    ) -> Self
```

**Purpose**: Builds a backend bound to a specific local secrets namespace and therefore a specific encrypted filename. It is the constructor used when auth and OAuth secrets must be isolated from general managed secrets.

**Data flow**: It takes `codex_home`, `keyring_store`, and a `LocalSecretsNamespace`, stores them directly into a new `LocalSecretsBackend`, and returns it.

**Call relations**: It underpins the default constructor and is called directly by namespace-aware setup paths and tests that verify separate files are written for `CodexAuth` and `McpOAuth`.

*Call graph*: called by 2 (new_with_keyring_store_and_namespace, local_namespaces_write_separate_files).


##### `LocalSecretsBackend::secrets_dir`  (lines 138–140)

```
fn secrets_dir(&self) -> PathBuf
```

**Purpose**: Computes the directory that contains all encrypted local secret files. The path is always `<codex_home>/secrets`.

**Data flow**: It reads `self.codex_home`, appends the literal `secrets` path component, and returns the resulting `PathBuf` without filesystem access.

**Call relations**: It is a small path helper used by `secrets_path` and `save_file`, keeping directory layout logic in one place.

*Call graph*: called by 2 (save_file, secrets_path); 1 external calls (join).


##### `LocalSecretsBackend::secrets_path`  (lines 142–149)

```
fn secrets_path(&self) -> PathBuf
```

**Purpose**: Computes the exact encrypted file path for the backend’s namespace. It maps namespace variants to `local.age`, `codex_auth.age`, or `mcp_oauth.age`.

**Data flow**: It reads `self.namespace`, selects the corresponding filename constant, joins it onto `self.secrets_dir()`, and returns the full `PathBuf`.

**Call relations**: Both `load_file` and `save_file` call it so read and write operations stay aligned on the same namespace-specific file.

*Call graph*: calls 1 internal fn (secrets_dir); called by 2 (load_file, save_file).


##### `LocalSecretsBackend::load_file`  (lines 151–177)

```
fn load_file(&self) -> Result<SecretsFile>
```

**Purpose**: Loads, decrypts, deserializes, and validates the secrets file for this backend. It also normalizes legacy version `0` files to the current schema version in memory.

**Data flow**: It computes the namespace-specific path, returns `SecretsFile::new_empty()` if the file does not exist, otherwise reads ciphertext bytes from disk, obtains the passphrase from `load_or_create_passphrase`, decrypts with `decrypt_with_passphrase`, deserializes JSON into `SecretsFile`, patches `version == 0` to `SECRETS_VERSION`, checks that the version is not newer than supported, and returns the parsed struct. It reads the filesystem and keyring but does not write state.

**Call relations**: All backend read and mutation methods (`set`, `get`, `delete`, `list`) begin here. It delegates cryptography and key retrieval to helper functions so the CRUD methods can operate on a plain `SecretsFile`.

*Call graph*: calls 4 internal fn (load_or_create_passphrase, secrets_path, new_empty, decrypt_with_passphrase); called by 4 (delete, get, list, set); 3 external calls (ensure!, read, from_slice).


##### `LocalSecretsBackend::save_file`  (lines 179–190)

```
fn save_file(&self, file: &SecretsFile) -> Result<()>
```

**Purpose**: Serializes and encrypts an in-memory `SecretsFile`, ensures the secrets directory exists, and atomically replaces the on-disk file. It is the only write path for persisted local secrets.

**Data flow**: It takes a borrowed `SecretsFile`, creates `<codex_home>/secrets` if needed, loads or creates the keyring passphrase, serializes the struct to JSON bytes, encrypts those bytes with `encrypt_with_passphrase`, computes the namespace-specific destination path, and writes the ciphertext via `write_file_atomically`. It writes to disk and may create the keyring entry indirectly through passphrase loading.

**Call relations**: It is called after successful mutations from `set` and from `delete` when a key was actually removed. It relies on helper functions for encryption and atomic replacement rather than embedding those concerns inline.

*Call graph*: calls 5 internal fn (load_or_create_passphrase, secrets_dir, secrets_path, encrypt_with_passphrase, write_file_atomically); called by 2 (delete, set); 2 external calls (create_dir_all, to_vec).


##### `LocalSecretsBackend::load_or_create_passphrase`  (lines 192–213)

```
fn load_or_create_passphrase(&self) -> Result<SecretString>
```

**Purpose**: Retrieves the encryption passphrase from the OS keyring or generates and stores a new one on first use. This keeps the file encryption key local but out of plaintext config.

**Data flow**: It derives the keyring account from `self.codex_home` using `compute_keyring_account`, reads from `self.keyring_store` under `keyring_service()`, converts an existing string into `SecretString` if present, or else calls `generate_passphrase`, saves the generated secret back to the keyring, and returns the `SecretString`. It reads and may write keyring state.

**Call relations**: Both `load_file` and `save_file` depend on it before decryption or encryption. The create-on-miss behavior means callers do not need a separate initialization phase.

*Call graph*: calls 1 internal fn (generate_passphrase); called by 2 (load_file, save_file); 3 external calls (from, compute_keyring_account, keyring_service).


##### `LocalSecretsBackend::set`  (lines 217–219)

```
fn set(&self, scope: &SecretScope, name: &SecretName, value: &str) -> Result<()>
```

**Purpose**: Stores or replaces one secret value under a scoped canonical key. It rejects empty secret values before touching storage.

**Data flow**: It takes a `SecretScope`, `SecretName`, and plaintext `&str` value; validates the value is non-empty; derives the canonical key from the scope/name; loads the current `SecretsFile`; inserts or overwrites the map entry with an owned `String`; then persists the updated file with `save_file`. It writes encrypted file contents on success.

**Call relations**: This is one of the public backend operations and also the implementation used by the `SecretsBackend` trait shim. It depends on `load_file` and `save_file` for the read-modify-write cycle.

*Call graph*: calls 3 internal fn (canonical_key, load_file, save_file); 1 external calls (ensure!).


##### `LocalSecretsBackend::get`  (lines 221–223)

```
fn get(&self, scope: &SecretScope, name: &SecretName) -> Result<Option<String>>
```

**Purpose**: Looks up a single secret by scope and name and returns its plaintext value if present. It performs no mutation.

**Data flow**: It takes a `SecretScope` and `SecretName`, derives the canonical key, loads the decrypted `SecretsFile`, clones the matching map value if found, and returns `Result<Option<String>>`.

**Call relations**: This is the read path used directly and through the `SecretsBackend` trait implementation. It delegates all persistence and decryption work to `load_file`.

*Call graph*: calls 2 internal fn (canonical_key, load_file).


##### `LocalSecretsBackend::delete`  (lines 225–227)

```
fn delete(&self, scope: &SecretScope, name: &SecretName) -> Result<bool>
```

**Purpose**: Removes one secret entry if it exists and persists the updated file only when something changed. It reports whether a deletion actually occurred.

**Data flow**: It takes a `SecretScope` and `SecretName`, derives the canonical key, loads the current `SecretsFile`, removes the key from the map, conditionally calls `save_file` if removal succeeded, and returns `Result<bool>` indicating presence.

**Call relations**: This mutation path mirrors `set` but avoids rewriting the file when the key was absent. It is exposed directly and through the `SecretsBackend` trait.

*Call graph*: calls 3 internal fn (canonical_key, load_file, save_file).


##### `LocalSecretsBackend::list`  (lines 229–231)

```
fn list(&self, scope_filter: Option<&SecretScope>) -> Result<Vec<SecretListEntry>>
```

**Purpose**: Enumerates stored secrets as parsed `SecretListEntry` values, optionally filtering by scope. It tolerates malformed stored keys by skipping them with a warning.

**Data flow**: It takes an optional `&SecretScope` filter, loads the decrypted `SecretsFile`, iterates over all canonical key strings in the map, parses each with `parse_canonical_key`, drops invalid keys after emitting `warn!`, applies the optional scope filter, accumulates matching `SecretListEntry` values into a `Vec`, and returns it.

**Call relations**: This is the inventory path for callers that need names rather than values. It depends on `load_file` for storage access and `parse_canonical_key` to reverse the canonical string format.

*Call graph*: calls 2 internal fn (load_file, parse_canonical_key); 2 external calls (new, warn!).


##### `write_file_atomically`  (lines 234–311)

```
fn write_file_atomically(path: &Path, contents: &[u8]) -> Result<()>
```

**Purpose**: Replaces a file by writing ciphertext to a uniquely named temp file in the same directory, syncing it, and renaming it into place. It also cleans up temp files on failure and includes a Windows-specific replace workaround.

**Data flow**: It takes a destination `&Path` and byte slice, derives the parent directory and filename, builds a temp path using process id and current time nanoseconds, creates the temp file with `create_new`, writes all bytes, calls `sync_all`, then attempts `fs::rename` to the final path. On Windows, if rename fails because the target exists, it removes the target and retries rename; on failure it removes the temp file best-effort and returns a contextualized error.

**Call relations**: It is only called by `LocalSecretsBackend::save_file`, isolating the durability and replacement semantics from the higher-level serialization/encryption logic.

*Call graph*: called by 1 (save_file); 8 external calls (exists, file_name, parent, now, format!, new, remove_file, rename).


##### `generate_passphrase`  (lines 313–322)

```
fn generate_passphrase() -> Result<SecretString>
```

**Purpose**: Generates a new high-entropy passphrase suitable for storing in the keyring and using with age+scrypt. The raw random bytes are wiped after encoding.

**Data flow**: It allocates a 32-byte array, fills it from `OsRng`, base64-encodes the bytes into an ASCII `String`, calls `wipe_bytes` on the original buffer, wraps the encoded string in `SecretString`, and returns it.

**Call relations**: It is only used by `LocalSecretsBackend::load_or_create_passphrase` on the first-run keyring-miss path.

*Call graph*: calls 1 internal fn (wipe_bytes); called by 1 (load_or_create_passphrase); 1 external calls (from).


##### `wipe_bytes`  (lines 324–331)

```
fn wipe_bytes(bytes: &mut [u8])
```

**Purpose**: Best-effort zeroes a mutable byte slice in a way that is harder for the compiler to optimize away. It is a small memory-hygiene helper for secret material.

**Data flow**: It takes `&mut [u8]`, writes zero to each byte using `write_volatile`, then issues a `compiler_fence(Ordering::SeqCst)` to prevent reordering/elision. It mutates the provided buffer in place and returns nothing.

**Call relations**: It is called by `generate_passphrase` immediately after base64 encoding the random key bytes.

*Call graph*: called by 1 (generate_passphrase); 2 external calls (write_volatile, compiler_fence).


##### `encrypt_with_passphrase`  (lines 333–336)

```
fn encrypt_with_passphrase(plaintext: &[u8], passphrase: &SecretString) -> Result<Vec<u8>>
```

**Purpose**: Encrypts plaintext bytes using age’s scrypt recipient derived from the provided passphrase. It wraps the cryptographic library call with a contextual error.

**Data flow**: It takes plaintext `&[u8]` and a `&SecretString`, clones the passphrase into a `ScryptRecipient`, passes both to `age::encrypt`, and returns the ciphertext `Vec<u8>`.

**Call relations**: It is the encryption helper used by `LocalSecretsBackend::save_file` after JSON serialization.

*Call graph*: called by 1 (save_file); 3 external calls (new, clone, encrypt).


##### `decrypt_with_passphrase`  (lines 338–341)

```
fn decrypt_with_passphrase(ciphertext: &[u8], passphrase: &SecretString) -> Result<Vec<u8>>
```

**Purpose**: Decrypts ciphertext bytes using age’s scrypt identity derived from the provided passphrase. It is the inverse of `encrypt_with_passphrase`.

**Data flow**: It takes ciphertext `&[u8]` and a `&SecretString`, clones the passphrase into a `ScryptIdentity`, passes both to `age::decrypt`, and returns the plaintext `Vec<u8>`.

**Call relations**: It is called by `LocalSecretsBackend::load_file` after reading ciphertext from disk and retrieving the keyring passphrase.

*Call graph*: called by 1 (load_file); 3 external calls (new, clone, decrypt).


##### `parse_canonical_key`  (lines 343–370)

```
fn parse_canonical_key(canonical_key: &str) -> Option<SecretListEntry>
```

**Purpose**: Parses a stored canonical secret key string back into a typed `SecretListEntry`. It recognizes only the expected `global/<name>` and `env/<environment>/<name>` layouts.

**Data flow**: It takes a `&str`, splits on `/`, matches the first segment as either `global` or `env`, validates segment count, constructs a `SecretName`, constructs either `SecretScope::Global` or `SecretScope::environment(...)`, and returns `Some(SecretListEntry)` on success or `None` for malformed/invalid keys.

**Call relations**: It is used exclusively by `LocalSecretsBackend::list` to turn persisted map keys back into typed listing entries while safely rejecting bad data.

*Call graph*: calls 2 internal fn (new, environment); called by 1 (list).


##### `tests::load_file_rejects_newer_schema_versions`  (lines 380–399)

```
fn load_file_rejects_newer_schema_versions() -> Result<()>
```

**Purpose**: Verifies that a secrets file serialized with a version newer than `SECRETS_VERSION` is rejected during load. This protects forward-compatibility boundaries.

**Data flow**: The test creates a temp home directory and mock keyring, constructs a backend, saves a `SecretsFile` with `version = SECRETS_VERSION + 1`, then calls `load_file` and asserts the returned error message mentions unsupported newer versions.

**Call relations**: It exercises the `save_file` → `load_file` path specifically to confirm the version guard in `LocalSecretsBackend::load_file` is enforced.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, new, assert!, default, tempdir).


##### `tests::set_fails_when_keyring_is_unavailable`  (lines 402–424)

```
fn set_fails_when_keyring_is_unavailable() -> Result<()>
```

**Purpose**: Checks that storing a secret fails cleanly when the keyring load operation errors. It ensures keyring failures are surfaced rather than silently bypassed.

**Data flow**: The test creates a temp home and mock keyring, configures the mock to return a `KeyringError` for the computed account, constructs a backend, attempts `set` on a global secret, and asserts the resulting error mentions failure to load the secrets key from the keyring.

**Call relations**: It drives the `set` path into `load_or_create_passphrase`, validating error propagation from keyring access through the backend API.

*Call graph*: calls 2 internal fn (new, new); 6 external calls (new, Invalid, assert!, default, compute_keyring_account, tempdir).


##### `tests::save_file_does_not_leave_temp_files`  (lines 427–450)

```
fn save_file_does_not_leave_temp_files() -> Result<()>
```

**Purpose**: Ensures repeated saves replace the encrypted file cleanly without leaving stale temp files behind. It also confirms the latest value remains readable.

**Data flow**: The test creates a temp backend, writes the same secret twice via `set`, reads the secrets directory entries from disk, collects filenames, asserts only `local.age` exists, and then asserts `get` returns the second value.

**Call relations**: It exercises `set` and therefore `save_file` and `write_file_atomically`, checking the temp-file cleanup and replacement behavior of the atomic write helper.

*Call graph*: calls 2 internal fn (new, new); 5 external calls (new, assert_eq!, read_dir, default, tempdir).


##### `tests::local_namespaces_write_separate_files`  (lines 453–496)

```
fn local_namespaces_write_separate_files() -> Result<()>
```

**Purpose**: Verifies that different `LocalSecretsNamespace` values isolate data into separate encrypted files. This prevents auth and OAuth secrets from colliding with managed secrets.

**Data flow**: The test creates one temp home and shared mock keyring, constructs `CodexAuth` and `McpOAuth` backends, writes the same scoped name with different values through each backend, reads both values back, and asserts the corresponding namespace-specific files exist while `local.age` does not.

**Call relations**: It directly exercises `LocalSecretsBackend::new_with_namespace` and the namespace-dependent path selection in `secrets_path`.

*Call graph*: calls 2 internal fn (new, new_with_namespace); 5 external calls (new, assert!, assert_eq!, default, tempdir).


### Memory store backend
Provides the concrete local memories backend and its root-scoped filesystem access layer.

### `ext/memories/src/local.rs`

`io_transport` · `request handling`

This module is the local backend adapter behind the abstract `MemoriesBackend` trait. `LocalMemoriesBackend` stores a single `root: PathBuf`, representing the on-disk memories directory. Two constructors establish that root: one derives it from `<codex_home>/memories`, and one accepts any path-like input directly, which is useful for tests or standalone tool setup.

The most important internal routine is `resolve_scoped_path`. Given an optional relative path, it either returns the backend root or incrementally appends path components while enforcing filesystem safety rules. It rejects parent-directory traversal, absolute/prefixed paths, and hidden components before touching disk. As it walks existing components, it fetches metadata with `symlink_metadata`, rejects symlinks, and ensures intermediate components are directories. If it encounters a missing component, it appends the remaining suffix without further metadata checks and returns the resulting path; this allows callers like list/search/read to distinguish “syntactically valid but not found” from “invalid path”.

`metadata_or_none` wraps `tokio::fs::symlink_metadata`, converting `NotFound` into `Ok(None)` while preserving other I/O failures as `MemoriesBackendError::Io`. The trait implementation itself is intentionally thin: each async method delegates to a focused submodule (`ad_hoc_note`, `list`, `read`, `search`) so validation and traversal logic stay localized while all operations share the same root and path-safety helpers.

#### Function details

##### `LocalMemoriesBackend::from_codex_home`  (lines 30–32)

```
fn from_codex_home(codex_home: &AbsolutePathBuf) -> Self
```

**Purpose**: Builds a backend rooted at the standard memories directory under the Codex home path. It encodes the convention that local memories live in `<codex_home>/memories`.

**Data flow**: Reads the provided `AbsolutePathBuf`, appends the literal `"memories"` component via `join`, converts that to a `PathBuf`, and passes it into `from_memory_root`. It returns a new `LocalMemoriesBackend`.

**Call relations**: Used by extension tool setup when dedicated memory tools are created. It delegates actual struct construction to `LocalMemoriesBackend::from_memory_root` after deriving the canonical root path.

*Call graph*: calls 1 internal fn (join); called by 1 (tools); 1 external calls (from_memory_root).


##### `LocalMemoriesBackend::from_memory_root`  (lines 34–36)

```
fn from_memory_root(root: impl Into<PathBuf>) -> Self
```

**Purpose**: Constructs a backend from an explicit filesystem root. It is the generic constructor for callers that already know the memory store location.

**Data flow**: Accepts any `Into<PathBuf>` root input, converts it into a `PathBuf`, and returns `LocalMemoriesBackend { root }`. No filesystem access occurs.

**Call relations**: Called by `from_codex_home` and by external setup paths such as memory tool construction. It is a leaf constructor with no further delegation beyond the `Into<PathBuf>` conversion.

*Call graph*: called by 1 (memory_tool); 1 external calls (into).


##### `LocalMemoriesBackend::resolve_scoped_path`  (lines 38–88)

```
async fn resolve_scoped_path(
        &self,
        relative_path: Option<&str>,
    ) -> Result<PathBuf, MemoriesBackendError>
```

**Purpose**: Validates and resolves a user-supplied relative memory path against the backend root without allowing escape, hidden paths, or symlink traversal. It is the central guardrail for list/read/search path access.

**Data flow**: Takes `relative_path: Option<&str>`. If `None`, it returns a clone of `self.root`. Otherwise it parses the string as a `Path`, rejects any `ParentDir`, `RootDir`, or Windows prefix components with `invalid_path`, rejects hidden components by returning `NotFound`, then walks components one by one from `self.root`. For each existing component it reads metadata via `metadata_or_none`, rejects symlinks using `display_relative_path` plus `reject_symlink`, and ensures intermediate components are directories. If a component does not yet exist, it appends the remaining suffix and returns the resulting `PathBuf` unchanged. The function returns the fully scoped path or a `MemoriesBackendError`.

**Call relations**: Called by the local `list`, `read`, and `search` implementations before they touch the filesystem. It delegates metadata lookup to `metadata_or_none` and path-policy checks to helpers in `local::path` so all callers share identical confinement rules.

*Call graph*: calls 3 internal fn (invalid_path, display_relative_path, reject_symlink); called by 3 (list, read, search); 3 external calls (new, clone, metadata_or_none).


##### `LocalMemoriesBackend::metadata_or_none`  (lines 90–98)

```
async fn metadata_or_none(
        path: &Path,
    ) -> Result<Option<std::fs::Metadata>, MemoriesBackendError>
```

**Purpose**: Fetches filesystem metadata while treating missing paths as a non-error. This lets higher-level operations distinguish absence from invalidity or I/O failure.

**Data flow**: Accepts a `&Path`, awaits `tokio::fs::symlink_metadata(path)`, and maps outcomes as follows: successful metadata becomes `Ok(Some(metadata))`; `ErrorKind::NotFound` becomes `Ok(None)`; any other error becomes `Err(MemoriesBackendError::Io(...))` via `From<std::io::Error>`. It writes no state.

**Call relations**: Used throughout local filesystem operations wherever existence checks are needed, including directory creation, path resolution, listing, reading, and recursive search. It is the shared metadata primitive beneath those flows.

*Call graph*: called by 5 (ensure_directory, list, read, search, search_entries); 1 external calls (symlink_metadata).


##### `LocalMemoriesBackend::add_ad_hoc_note`  (lines 102–107)

```
async fn add_ad_hoc_note(
        &self,
        request: AddAdHocMemoryNoteRequest,
    ) -> Result<AddAdHocMemoryNoteResponse, MemoriesBackendError>
```

**Purpose**: Implements the trait’s ad-hoc note creation operation by forwarding to the dedicated module. It keeps the trait impl itself minimal.

**Data flow**: Receives an `AddAdHocMemoryNoteRequest`, passes `self` and the request into `ad_hoc_note::add_ad_hoc_note`, awaits the result, and returns either `AddAdHocMemoryNoteResponse` or `MemoriesBackendError` unchanged.

**Call relations**: Called through the `MemoriesBackend` trait by tool execution paths that create notes. It delegates all validation, directory creation, and file writing to the `local/ad_hoc_note.rs` implementation.

*Call graph*: calls 1 internal fn (add_ad_hoc_note).


##### `LocalMemoriesBackend::list`  (lines 109–114)

```
async fn list(
        &self,
        request: ListMemoriesRequest,
    ) -> Result<ListMemoriesResponse, MemoriesBackendError>
```

**Purpose**: Implements memory listing for the local backend by dispatching to the listing module. It exposes directory/file enumeration through the trait.

**Data flow**: Accepts a `ListMemoriesRequest`, forwards `self` and the request to `list::list`, awaits the async result, and returns the resulting `ListMemoriesResponse` or error.

**Call relations**: Invoked via the backend trait when callers request directory contents or a single file entry. It delegates all cursor parsing, path validation, and entry collection to `local/list.rs`.

*Call graph*: calls 1 internal fn (list).


##### `LocalMemoriesBackend::read`  (lines 116–121)

```
async fn read(
        &self,
        request: ReadMemoryRequest,
    ) -> Result<ReadMemoryResponse, MemoriesBackendError>
```

**Purpose**: Implements file reading for the local backend by forwarding to the read module. It provides line-based, token-truncated reads through the trait.

**Data flow**: Takes a `ReadMemoryRequest`, passes it with `self` into `read::read`, awaits completion, and returns the produced `ReadMemoryResponse` or `MemoriesBackendError`.

**Call relations**: Called through the backend trait when a memory file’s contents are requested. It delegates validation, file loading, line slicing, and truncation to `local/read.rs`.

*Call graph*: calls 1 internal fn (read).


##### `LocalMemoriesBackend::search`  (lines 123–128)

```
async fn search(
        &self,
        request: SearchMemoriesRequest,
    ) -> Result<SearchMemoriesResponse, MemoriesBackendError>
```

**Purpose**: Implements content search for the local backend by forwarding to the search module. It exposes recursive file scanning and query matching through the trait.

**Data flow**: Receives a `SearchMemoriesRequest`, forwards `self` and the request to `search::search`, awaits the result, and returns the resulting `SearchMemoriesResponse` or error.

**Call relations**: Invoked via the backend trait when callers perform memory searches. It delegates query validation, traversal, matching, and pagination to `local/search.rs`.

*Call graph*: calls 1 internal fn (search).


### Memory workspace writing
Defines the write-side memory workspace layout and then handles synchronization, cleanup, and extension pruning for on-disk memory artifacts.

### `memories/write/src/lib.rs`

`config` · `cross-cutting`

This crate root organizes the write-path subsystem into focused modules (`control`, `extensions`, `guard`, `phase1`, `phase2`, `prompts`, `runtime`, `start`, `storage`, and `workspace`) and re-exports the operations that other crates consume, such as startup task creation, prompt builders, storage synchronization, and extension pruning. Beyond module wiring, it centralizes a set of internal constants that define the on-disk artifact layout and operational defaults.

The nested constant modules capture several important invariants: artifact names like `extensions`, `rollout_summaries`, and `raw_memories.md`; extension resource retention settings and timestamp format; the Codex rate-limit identifier; prompt text blocks describing extension folder semantics; stage-one and stage-two model/runtime parameters; and workspace diff filename and size limits. Keeping these values here makes path helpers and downstream logic agree on a single filesystem schema.

The executable behavior in this file is a small set of path constructors plus one async initializer. `memory_root` derives the top-level memories directory from the Codex home path. `rollout_summaries_dir`, `memory_extensions_root`, and `raw_memories_file` append the canonical artifact names to an arbitrary root. `ensure_layout` currently creates only the rollout summaries directory, establishing the minimum required directory structure for later write-path phases. These helpers are intentionally simple but foundational: many other modules rely on them to avoid hard-coded path strings and layout drift.

#### Function details

##### `memory_root`  (lines 116–118)

```
fn memory_root(codex_home: &AbsolutePathBuf) -> AbsolutePathBuf
```

**Purpose**: Computes the canonical top-level memories directory under the Codex home directory. It gives the rest of the crate a single source of truth for where memory artifacts live.

**Data flow**: Accepts `codex_home: &AbsolutePathBuf`, appends the literal `"memories"` with `join`, and returns the resulting `AbsolutePathBuf`.

**Call relations**: This is a foundational path helper used by higher-level startup and storage code to anchor all memory artifact paths. It performs no I/O itself and simply standardizes the root location.

*Call graph*: calls 1 internal fn (join).


##### `rollout_summaries_dir`  (lines 120–122)

```
fn rollout_summaries_dir(root: &Path) -> PathBuf
```

**Purpose**: Builds the path to the rollout summaries subdirectory beneath a given memories root. It encapsulates the artifact subdirectory name defined in the crate constants.

**Data flow**: Takes `root: &Path`, appends `artifacts::ROLLOUT_SUMMARIES_SUBDIR`, and returns the resulting `PathBuf`.

**Call relations**: This helper is called by `ensure_layout` when creating the initial directory structure, and can also be used by storage code that reads or writes rollout summary files.

*Call graph*: called by 1 (ensure_layout); 1 external calls (join).


##### `memory_extensions_root`  (lines 124–126)

```
fn memory_extensions_root(root: &Path) -> PathBuf
```

**Purpose**: Builds the path to the extensions directory beneath a given memories root. It standardizes where extension instruction files and resources are stored.

**Data flow**: Takes `root: &Path`, appends `artifacts::EXTENSIONS_SUBDIR`, and returns the resulting `PathBuf`.

**Call relations**: This helper underpins extension-related modules such as instruction seeding and resource pruning, ensuring they all target the same `extensions` subtree.

*Call graph*: 1 external calls (join).


##### `raw_memories_file`  (lines 128–130)

```
fn raw_memories_file(root: &Path) -> PathBuf
```

**Purpose**: Builds the path to the consolidated raw memories markdown file under a memories root. It centralizes the filename used by storage logic.

**Data flow**: Accepts `root: &Path`, appends `artifacts::RAW_MEMORIES_FILENAME`, and returns the resulting `PathBuf`.

**Call relations**: This path helper is intended for storage and synchronization code that reads or rewrites the raw memories artifact, keeping the filename consistent across the crate.

*Call graph*: 1 external calls (join).


##### `ensure_layout`  (lines 132–134)

```
async fn ensure_layout(root: &Path) -> std::io::Result<()>
```

**Purpose**: Creates the minimum required on-disk layout for the write-path crate by ensuring the rollout summaries directory exists. It is the crate’s basic filesystem bootstrap step.

**Data flow**: Takes `root: &Path`, derives the rollout summaries directory with `rollout_summaries_dir(root)`, calls `tokio::fs::create_dir_all` on that path, and returns the resulting `std::io::Result<()>`.

**Call relations**: This function relies on `rollout_summaries_dir` for path construction and performs the actual filesystem initialization. It is used during setup phases that need the memories directory structure present before writing artifacts.

*Call graph*: calls 1 internal fn (rollout_summaries_dir); 1 external calls (create_dir_all).


### `memories/write/src/storage.rs`

`io_transport` · `phase-2 workspace sync`

This file is the storage layer for phase-2 workspace inputs. The two public entrypoints, `rebuild_raw_memories_file_from_memories` and `sync_rollout_summaries_from_memories`, both ensure the workspace layout exists before writing files. They operate on slices of `codex_state::Stage1Output`, but intentionally retain only the first `max_raw_memories_for_consolidation` entries via `retained_memories`; the caller is expected to provide those rows in the desired order.

`rebuild_raw_memories_file` writes a single markdown file beginning with `# Raw Memories`. When no retained memories exist it writes a placeholder line; otherwise it emits a stable, human-readable section per thread including thread ID, source timestamp, cwd, rollout path, the derived rollout-summary filename, and the trimmed raw memory body. Formatting errors from `writeln!` are converted into `std::io::Error` with helper functions.

`sync_rollout_summaries_from_memories` computes the set of summary file stems that should remain, prunes any `.md` files in the rollout summaries directory whose stems are no longer retained, and rewrites one summary file per retained memory. Each summary file includes metadata headers and the summary body, plus `git_branch` when present.

The filename logic in `rollout_summary_file_stem_from_parts` is deliberately deterministic and compact: it derives a timestamp fragment and 4-character base62 short hash from the thread ID when possible, then appends a sanitized, lowercase, underscore-normalized slug truncated to 60 characters. If the thread ID is not a UUID, it falls back to hashing the raw thread ID bytes and using `source_updated_at` for the timestamp.

#### Function details

##### `rebuild_raw_memories_file_from_memories`  (lines 13–20)

```
async fn rebuild_raw_memories_file_from_memories(
    root: &Path,
    memories: &[Stage1Output],
    max_raw_memories_for_consolidation: usize,
) -> std::io::Result<()>
```

**Purpose**: Ensures the memories workspace layout exists and rebuilds `raw_memories.md` from the selected stage-1 outputs. It is the public wrapper around the actual file-writing implementation.

**Data flow**: Takes the memory root path, a slice of `Stage1Output`, and the maximum number of raw memories to include. It awaits `ensure_layout(root)` and then delegates to `rebuild_raw_memories_file`, returning the resulting `std::io::Result<()>`.

**Call relations**: Called during phase-2 workspace sync before git diffing. It exists mainly to guarantee directory layout before writing.

*Call graph*: calls 1 internal fn (rebuild_raw_memories_file); 1 external calls (ensure_layout).


##### `sync_rollout_summaries_from_memories`  (lines 23–42)

```
async fn sync_rollout_summaries_from_memories(
    root: &Path,
    memories: &[Stage1Output],
    max_raw_memories_for_consolidation: usize,
) -> std::io::Result<()>
```

**Purpose**: Synchronizes the canonical per-rollout summary markdown files under the memories workspace. It prunes obsolete summaries and rewrites the retained set from DB-backed stage-1 outputs.

**Data flow**: Inputs are the memory root, stage-1 outputs slice, and retention limit. It ensures layout, computes the retained subset, maps each retained memory to its summary file stem to build a `HashSet<String>` of files to keep, prunes outdated summary files with `prune_rollout_summaries`, then iterates retained memories and writes each summary file with `write_rollout_summary_for_thread`. It returns `std::io::Result<()>`.

**Call relations**: Called by phase-2 workspace sync before rebuilding `raw_memories.md`. It delegates retention slicing, pruning, and per-thread file writing to helpers in this file.

*Call graph*: calls 3 internal fn (prune_rollout_summaries, retained_memories, write_rollout_summary_for_thread); 1 external calls (ensure_layout).


##### `rebuild_raw_memories_file`  (lines 44–78)

```
async fn rebuild_raw_memories_file(
    root: &Path,
    memories: &[Stage1Output],
    max_raw_memories_for_consolidation: usize,
) -> std::io::Result<()>
```

**Purpose**: Writes the consolidated `raw_memories.md` file content from the retained stage-1 outputs. The output is structured markdown intended for both human inspection and consolidation-agent input.

**Data flow**: Receives the memory root, stage-1 outputs slice, and retention limit. It slices to retained memories, initializes a markdown body with `# Raw Memories`, writes a placeholder if empty, otherwise appends a heading line and then for each retained memory writes thread ID, RFC3339 update time, cwd, rollout path, derived summary filename, a blank line, and the trimmed raw memory text followed by spacing. It writes the final string to `raw_memories_file(root)` and returns the I/O result.

**Call relations**: Called only by `rebuild_raw_memories_file_from_memories`. It uses `retained_memories` and `rollout_summary_file_stem` to keep file content aligned with summary filenames.

*Call graph*: calls 1 internal fn (retained_memories); called by 1 (rebuild_raw_memories_file_from_memories); 5 external calls (from, raw_memories_file, format!, write, writeln!).


##### `prune_rollout_summaries`  (lines 80–108)

```
async fn prune_rollout_summaries(root: &Path, keep: &HashSet<String>) -> std::io::Result<()>
```

**Purpose**: Deletes rollout summary markdown files whose stems are no longer in the retained set. It tolerates missing directories and logs non-NotFound deletion failures.

**Data flow**: Takes the memory root and a `HashSet<String>` of stems to keep. It opens the rollout summaries directory, returning early if the directory does not exist, iterates entries, extracts `.md` stems, and for any stem not in `keep` attempts `remove_file`. `NotFound` deletion errors are ignored; other deletion errors are logged with the path. It returns `std::io::Result<()>`.

**Call relations**: Called by `sync_rollout_summaries_from_memories` before rewriting retained summaries so stale files do not linger in the workspace.

*Call graph*: called by 1 (sync_rollout_summaries_from_memories); 4 external calls (rollout_summaries_dir, read_dir, remove_file, warn!).


##### `write_rollout_summary_for_thread`  (lines 110–136)

```
async fn write_rollout_summary_for_thread(
    root: &Path,
    memory: &Stage1Output,
) -> std::io::Result<()>
```

**Purpose**: Writes one per-thread rollout summary markdown file containing metadata headers and the summary body. It uses the deterministic file-stem scheme defined in this module.

**Data flow**: Inputs are the memory root and one `Stage1Output`. It computes the file stem with `rollout_summary_file_stem`, builds the target path under `rollout_summaries`, formats a body containing thread ID, RFC3339 update time, rollout path, cwd, optional git branch, a blank line, and the summary text plus trailing newline, then writes the file and returns the I/O result.

**Call relations**: Called by `sync_rollout_summaries_from_memories` for each retained memory after pruning.

*Call graph*: calls 1 internal fn (rollout_summary_file_stem); called by 1 (sync_rollout_summaries_from_memories); 5 external calls (new, rollout_summaries_dir, format!, write, writeln!).


##### `retained_memories`  (lines 138–143)

```
fn retained_memories(
    memories: &[Stage1Output],
    max_raw_memories_for_consolidation: usize,
) -> &[Stage1Output]
```

**Purpose**: Returns the prefix of the stage-1 outputs slice that should be retained for consolidation. It enforces the caller-supplied maximum without reordering.

**Data flow**: Takes the full `memories` slice and `max_raw_memories_for_consolidation`, computes `memories.len().min(max)`, and returns a subslice from the start through that bound.

**Call relations**: Used by both `rebuild_raw_memories_file` and `sync_rollout_summaries_from_memories` so both file outputs operate on the same retained subset.

*Call graph*: called by 2 (rebuild_raw_memories_file, sync_rollout_summaries_from_memories); 1 external calls (len).


##### `raw_memories_format_error`  (lines 145–147)

```
fn raw_memories_format_error(err: std::fmt::Error) -> std::io::Error
```

**Purpose**: Converts a `std::fmt::Error` encountered while building `raw_memories.md` into an `std::io::Error` with context. It lets formatting failures fit the async file-writing API’s error type.

**Data flow**: Accepts a `std::fmt::Error`, formats it into a message prefixed with `format raw memories:`, wraps it with `std::io::Error::other`, and returns the new I/O error.

**Call relations**: Used by `rebuild_raw_memories_file` when `writeln!` on the in-memory string buffer fails.

*Call graph*: 2 external calls (other, format!).


##### `rollout_summary_format_error`  (lines 149–151)

```
fn rollout_summary_format_error(err: std::fmt::Error) -> std::io::Error
```

**Purpose**: Converts a `std::fmt::Error` encountered while building a rollout summary file into an `std::io::Error` with context. It mirrors the raw-memories formatting adapter.

**Data flow**: Accepts a `std::fmt::Error`, formats it into a message prefixed with `format rollout summary:`, wraps it with `std::io::Error::other`, and returns it.

**Call relations**: Used by `write_rollout_summary_for_thread` when formatting the summary body.

*Call graph*: 2 external calls (other, format!).


##### `rollout_summary_file_stem`  (lines 153–159)

```
fn rollout_summary_file_stem(memory: &Stage1Output) -> String
```

**Purpose**: Computes the deterministic filename stem for a `Stage1Output`’s rollout summary artifact. It is the public convenience wrapper over the lower-level parts-based implementation.

**Data flow**: Reads `thread_id`, `source_updated_at`, and optional `rollout_slug` from the `Stage1Output` and forwards them to `rollout_summary_file_stem_from_parts`, returning the resulting `String`.

**Call relations**: Used by both `write_rollout_summary_for_thread` and `rebuild_raw_memories_file` so filenames referenced in `raw_memories.md` match the actual summary files.

*Call graph*: calls 1 internal fn (rollout_summary_file_stem_from_parts); called by 1 (write_rollout_summary_for_thread).


##### `rollout_summary_file_stem_from_parts`  (lines 161–238)

```
fn rollout_summary_file_stem_from_parts(
    thread_id: codex_protocol::ThreadId,
    source_updated_at: chrono::DateTime<chrono::Utc>,
    rollout_slug: Option<&str>,
) -> String
```

**Purpose**: Builds a compact, deterministic summary-file stem from thread identity, timestamp, and optional rollout slug. It balances readability with collision resistance by combining a timestamp fragment, a 4-character base62 short hash, and a sanitized slug suffix.

**Data flow**: Inputs are a `ThreadId`, source update timestamp, and optional slug. It converts the thread ID to string and tries to parse it as a UUID; on success it extracts the UUID timestamp for the date fragment when available and uses the low 32 bits of the UUID as the short-hash seed, otherwise it falls back to `source_updated_at` and a simple rolling hash over the thread ID bytes. It reduces the seed modulo a fixed hash space, encodes four base62 characters, forms `timestamp-shorthash`, then if a slug exists sanitizes up to 60 characters by lowercasing ASCII alphanumerics and replacing all other chars with underscores, trims trailing underscores, and appends the slug if non-empty. It returns the final stem string.

**Call relations**: Called only by `rollout_summary_file_stem`, which exposes this naming scheme to the rest of the storage layer.

*Call graph*: called by 1 (rollout_summary_file_stem); 7 external calls (format, with_capacity, parse_str, format!, bytes, to_string, from).


### `memories/write/src/control.rs`

`domain_logic` · `memory write cleanup/reset`

This module provides asynchronous filesystem cleanup helpers for the memory write side. `clear_memory_roots_contents` is the public entrypoint: given a Codex home path, it derives both `memories` and `memories_extensions` and clears each one in turn. The actual deletion logic lives in `clear_memory_root_contents`, which is careful about safety and idempotence.

Before deleting anything, `clear_memory_root_contents` calls `tokio::fs::symlink_metadata` on the target root. If the path exists and is a symlink, it returns an `InvalidInput` error with a message naming the offending path; this prevents recursive deletion through a link into arbitrary locations. A missing root is treated as acceptable, and any other metadata error is propagated. The function then ensures the root directory exists with `create_dir_all`, reads its entries, and removes each child: directories via `remove_dir_all`, everything else via `remove_file`. The root directory itself is never removed.

The embedded tests document both invariants. One test creates nested files and directories, clears the root, and verifies the root still exists but is empty. A Unix-only test creates a symlinked root pointing outside the tree, asserts the function rejects it with `ErrorKind::InvalidInput`, and confirms the symlink target file remains untouched.

#### Function details

##### `clear_memory_roots_contents`  (lines 3–12)

```
async fn clear_memory_roots_contents(codex_home: &Path) -> std::io::Result<()>
```

**Purpose**: Clears the contents of both standard memory roots under a Codex home directory: `memories` and `memories_extensions`. It is the high-level cleanup entrypoint used by callers that want a full memory reset.

**Data flow**: Takes `codex_home: &Path`, constructs two child paths with `join`, iterates over them, awaits `clear_memory_root_contents` for each, propagates any I/O error immediately, and returns `Ok(())` once both roots have been processed.

**Call relations**: This public helper delegates all safety checks and deletion behavior to `clear_memory_root_contents`. It exists to apply the same clearing logic to both memory-related roots in one call.

*Call graph*: calls 1 internal fn (clear_memory_root_contents); 1 external calls (join).


##### `clear_memory_root_contents`  (lines 14–44)

```
async fn clear_memory_root_contents(memory_root: &Path) -> std::io::Result<()>
```

**Purpose**: Safely empties a single memory root directory without deleting the root itself. It rejects symlinked roots to prevent accidental deletion outside the intended directory tree.

**Data flow**: Accepts `memory_root: &Path`, reads metadata with `tokio::fs::symlink_metadata`, returns an `InvalidInput` error if the existing path is a symlink, ignores `NotFound`, propagates other metadata errors, ensures the directory exists with `create_dir_all`, opens it with `read_dir`, iterates entries with `next_entry`, obtains each entry’s path and file type, removes directories recursively with `remove_dir_all`, removes non-directories with `remove_file`, and returns `Ok(())` when the directory is empty.

**Call relations**: This function is called by the public `clear_memory_roots_contents` helper and directly by the module’s tests. It is the core cleanup routine that enforces the module’s safety invariant around symlink rejection.

*Call graph*: called by 3 (clear_memory_roots_contents, clear_memory_root_contents_preserves_root_directory, clear_memory_root_contents_rejects_symlinked_root); 7 external calls (new, format!, create_dir_all, read_dir, remove_dir_all, remove_file, symlink_metadata).


##### `tests::clear_memory_root_contents_preserves_root_directory`  (lines 52–87)

```
async fn clear_memory_root_contents_preserves_root_directory()
```

**Purpose**: Tests that clearing a memory root removes nested files and directories but leaves the root directory itself in place. It verifies the function’s non-destructive behavior toward the root path.

**Data flow**: Creates a temporary directory tree with a `memories` root, nested `rollout_summaries` directory, and two files, awaits `clear_memory_root_contents(&root)`, checks with `try_exists` that `root` still exists, reads the directory entries afterward, and asserts that no entries remain.

**Call relations**: This unit test invokes `clear_memory_root_contents` directly to validate the root-preservation invariant documented by the module.

*Call graph*: calls 1 internal fn (clear_memory_root_contents); 5 external calls (assert!, tempdir, create_dir_all, read_dir, write).


##### `tests::clear_memory_root_contents_rejects_symlinked_root`  (lines 91–115)

```
async fn clear_memory_root_contents_rejects_symlinked_root()
```

**Purpose**: Tests that a symlinked memory root is rejected and that the symlink target is not modified. It guards against a dangerous class of recursive deletion bugs.

**Data flow**: On Unix, creates a temporary target directory and file outside the intended root, creates a symlink named `memories` pointing to that target, awaits `clear_memory_root_contents(&root)` expecting an error, asserts the error kind is `InvalidInput`, and then checks that the target file still exists.

**Call relations**: This Unix-only unit test directly exercises the symlink safety branch in `clear_memory_root_contents`, confirming both the returned error and the absence of side effects on the symlink target.

*Call graph*: calls 1 internal fn (clear_memory_root_contents); 6 external calls (assert!, assert_eq!, symlink, tempdir, create_dir_all, write).


### `memories/write/src/extensions/prune.rs`

`domain_logic` · `background maintenance / startup cleanup`

This file implements extension resource retention cleanup. The public entrypoint computes the current UTC time and forwards to a testable helper that accepts an explicit `now`. The pruning logic derives a cutoff by subtracting `crate::extension_resources::RETENTION_DAYS` from the supplied timestamp, then scans the `<memory_root>/extensions` directory.

The traversal is intentionally conservative. It first reads each child under the extensions root and skips anything that is not a directory or does not contain `instructions.md`; this prevents unrelated folders from being treated as active extensions. For each qualifying extension, it looks for a `resources` subdirectory. Missing `resources` directories are ignored, while other read errors are logged with `tracing::warn` and skipped so one bad extension does not abort the whole cleanup pass.

Inside `resources`, only regular files with `.md` suffixes are considered. The code extracts the first 19 characters of the filename and parses them using `crate::extension_resources::FILENAME_TS_FORMAT` (`%Y-%m-%dT%H-%M-%S`). Files whose timestamps are invalid or newer than the cutoff are preserved. Files at or before the cutoff are deleted with `tokio::fs::remove_file`; `NotFound` during deletion is tolerated, but other failures are warned. This design makes pruning best-effort, resilient to concurrent filesystem changes, and tightly scoped to timestamped markdown resource artifacts.

#### Function details

##### `prune_old_extension_resources`  (lines 9–11)

```
async fn prune_old_extension_resources(memory_root: &Path)
```

**Purpose**: Starts a pruning pass using the current UTC time as the retention reference point. It exists as the public convenience wrapper around the deterministic helper.

**Data flow**: Takes `memory_root: &Path`, obtains `Utc::now()`, and forwards both values into `prune_old_extension_resources_with_now`. It returns no value and performs cleanup for side effects on disk.

**Call relations**: This is the externally used pruning entrypoint re-exported by the extensions module. Its only job is to supply wall-clock time and delegate the actual traversal and deletion policy to `prune_old_extension_resources_with_now`.

*Call graph*: calls 1 internal fn (prune_old_extension_resources_with_now); 1 external calls (now).


##### `prune_old_extension_resources_with_now`  (lines 13–88)

```
async fn prune_old_extension_resources_with_now(memory_root: &Path, now: DateTime<Utc>)
```

**Purpose**: Walks extension directories, identifies timestamped markdown resource files older than the retention cutoff, and deletes them while logging non-fatal filesystem failures. It is structured for deterministic testing by accepting an explicit `now` timestamp.

**Data flow**: Consumes `memory_root: &Path` and `now: DateTime<Utc>`, computes `cutoff = now - Duration::days(RETENTION_DAYS)`, derives the extensions root with `memory_extensions_root`, and iterates directory entries from `tokio::fs::read_dir`. For each extension directory with an `instructions.md` marker, it reads `resources`, filters entries to regular `.md` files, parses each filename through `resource_timestamp`, compares the parsed timestamp to `cutoff`, and removes files whose timestamps are not newer than the cutoff. It writes changes by deleting files and emits warnings for unreadable directories or failed deletions except `NotFound`.

**Call relations**: This helper is called by `prune_old_extension_resources` in production and directly by tests that need a fixed clock. During its scan it delegates timestamp extraction to `resource_timestamp`; all other work is inline control flow around Tokio directory iteration, existence checks, and file removal.

*Call graph*: calls 1 internal fn (resource_timestamp); called by 1 (prune_old_extension_resources); 6 external calls (days, memory_extensions_root, read_dir, remove_file, try_exists, warn!).


##### `resource_timestamp`  (lines 90–96)

```
fn resource_timestamp(file_name: &str) -> Option<DateTime<Utc>>
```

**Purpose**: Parses the timestamp prefix from a resource filename into a UTC `DateTime`. It recognizes only filenames whose first 19 characters match the configured extension resource timestamp format.

**Data flow**: Accepts `file_name: &str`, slices the prefix `..19`, parses it with `NaiveDateTime::parse_from_str` using `crate::extension_resources::FILENAME_TS_FORMAT`, and converts the parsed naive timestamp into `DateTime<Utc>` with `DateTime::from_naive_utc_and_offset`. It returns `Some(timestamp)` on success or `None` if the filename is too short or malformed.

**Call relations**: This parser is used inside `prune_old_extension_resources_with_now` after the caller has already filtered to markdown filenames. Its `Option` return lets the pruning loop silently skip files that do not follow the timestamped naming convention.

*Call graph*: called by 1 (prune_old_extension_resources_with_now); 2 external calls (from_naive_utc_and_offset, parse_from_str).
