# Plugin, secrets, and memory file stores  `stage-21.4`

This stage is shared behind-the-scenes support for data that must survive after the app closes. It is the system’s set of local “filing cabinets” for plugins, secrets, and memories. The plugin store decides where downloaded plugins are kept, checks their labels, installs them into versioned folders, finds the active version, and removes old copies. The secrets layer defines safe secret names and groups, then uses a local encrypted file store to save, read, list, and delete secret values without writing plain text to disk. On Windows, the DPAPI wrapper uses Windows’ built-in data protection service to encrypt and decrypt small secret blobs safely.

The memories files do similar durable storage for user memory. The local memory store turns requests such as list, read, search, and add note into safe folder operations. The memory write front door defines the standard folders and paths. Its storage code materializes saved memory records as Markdown files and keeps raw combined files and per-thread summaries in sync. Cleanup code clears memory contents safely, avoids following symbolic links, and prunes old extension resource notes so storage does not grow forever.

## Files in this stage

### Plugin store
Implements the filesystem-backed plugin cache, including discovery, installation, version selection, validation, and removal.

### `core-plugins/src/store.rs`

`domain_logic` · `plugin discovery, installation, update, and uninstall`

This file solves a practical problem: once Codex has a plugin folder, it needs a safe and predictable place to store it, find it later, and delete it. Without this code, different parts of the system could disagree about where plugins are installed, accidentally load the wrong version, or leave a half-copied plugin behind after a failed install.

The main type is PluginStore. It is built from the Codex home directory and creates two important roots: one for cached plugin code and one for plugin data. Plugins are stored by marketplace name, plugin name, and version, so separate plugins and versions do not collide.

When installing, the store reads the plugin’s plugin.json file, checks that the plugin name matches the expected marketplace plugin name, decides which version folder to use, and validates that the version is safe to use as a folder name. It then copies the plugin into a temporary staging area first. Only after the copy succeeds does it move the staged folder into place. This is like packing a replacement part on a workbench before swapping it into a machine, so users are less likely to see a broken half-install.

The file also decides which version is “active.” A special local version named "local" wins if present; otherwise, it picks the newest valid version, using semantic version comparison when possible.

#### Function details

##### `PluginStore::new`  (lines 34–37)

```
fn new(codex_home: PathBuf) -> Self
```

**Purpose**: Creates a PluginStore from the Codex home folder and assumes that folder is an absolute path. This is the convenient constructor used when callers expect the path to already be valid.

**Data flow**: It receives a Codex home path, passes it to PluginStore::try_new, and returns the finished store. If try_new reports that the path cannot be turned into valid absolute plugin locations, this function stops the program with a clear panic message.

**Call relations**: Many tests and setup paths call this when they need a store quickly. Internally it delegates the real path checking to PluginStore::try_new, so the safe constructor and the convenient constructor share the same rules.

*Call graph*: called by 17 (hooks_only_scope_shares_plugin_resolution_without_loading_other_capabilities, new_with_options, load_plugins_ignores_project_config_files, active_plugin_version_compares_semver_versions_semantically, active_plugin_version_prefers_default_local_version_when_multiple_versions_exist, active_plugin_version_reads_version_directory_name, active_plugin_version_returns_latest_version_when_default_is_missing, install_copies_plugin_into_default_marketplace, install_rejects_blank_manifest_version, install_rejects_manifest_names_that_do_not_match_marketplace_plugin_name (+7 more)); 1 external calls (try_new).


##### `PluginStore::try_new`  (lines 39–47)

```
fn try_new(codex_home: PathBuf) -> Result<Self, PluginStoreError>
```

**Purpose**: Creates a PluginStore while returning an error instead of panicking if the paths are not acceptable. Callers use this when bad configuration should be reported cleanly.

**Data flow**: It receives the Codex home path, appends the plugin cache and plugin data subfolders, and checks that both resulting paths are absolute paths. If both checks pass, it returns a PluginStore containing those two roots; otherwise it returns a PluginStoreError with context.

**Call relations**: Higher-level plugin refresh, install, and cache cleanup flows call this when they need a store but must handle failure gracefully. PluginStore::new also calls it and turns any failure into a panic.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); called by 7 (installed_plugin_telemetry_metadata, refresh_curated_plugin_cache, refresh_non_curated_plugin_cache_with_mode, sync_remote_installed_plugin_bundles_once, remove_remote_plugin_cache, install_remote_plugin_bundle, try_new_rejects_relative_codex_home); 1 external calls (join).


##### `PluginStore::root`  (lines 49–51)

```
fn root(&self) -> &AbsolutePathBuf
```

**Purpose**: Returns the root folder where cached plugin code is stored. This lets other code inspect or display the cache location without changing it.

**Data flow**: It reads the store’s saved cache root and returns a shared reference to it. Nothing on disk is touched and no state changes.

**Call relations**: This is a simple accessor. It fits into bigger flows when code needs to know the cache location that was established during PluginStore construction.


##### `PluginStore::plugin_base_root`  (lines 53–57)

```
fn plugin_base_root(&self, plugin_id: &PluginId) -> AbsolutePathBuf
```

**Purpose**: Builds the folder path that contains all installed versions of one plugin. It groups versions by marketplace and plugin name.

**Data flow**: It takes a plugin id, reads its marketplace name and plugin name, and appends them under the store’s cache root. The result is a path like a cabinet drawer for that plugin, but not for any specific version yet.

**Call relations**: Version lookup, installation, path building, and uninstall all use this as their shared starting point. PluginStore::plugin_root adds the version layer on top of this path.

*Call graph*: calls 1 internal fn (join); called by 4 (active_plugin_version, install_with_version, plugin_root, uninstall).


##### `PluginStore::plugin_root`  (lines 59–61)

```
fn plugin_root(&self, plugin_id: &PluginId, plugin_version: &str) -> AbsolutePathBuf
```

**Purpose**: Builds the exact folder path for one plugin at one version. This is where that version’s plugin files should live.

**Data flow**: It receives a plugin id and a version string, asks PluginStore::plugin_base_root for the plugin’s base folder, and appends the version. It returns the full installed path without creating it.

**Call relations**: Plugin installation uses this to report where the plugin was installed. It depends on PluginStore::plugin_base_root so all version paths follow the same marketplace/name layout.

*Call graph*: calls 1 internal fn (plugin_base_root); called by 1 (install_with_version).


##### `PluginStore::plugin_data_root`  (lines 63–68)

```
fn plugin_data_root(&self, plugin_id: &PluginId) -> AbsolutePathBuf
```

**Purpose**: Builds the folder path where a plugin can keep its data, separate from its installed code. This helps plugin state survive code cache changes.

**Data flow**: It receives a plugin id, combines the plugin name and marketplace name into one folder name, and appends that under the store’s data root. It returns the resulting data path.

**Call relations**: Plugin loading and plugin detail reading use this when they need the per-plugin data location. It is separate from install paths, so replacing plugin code does not directly replace plugin data.

*Call graph*: calls 1 internal fn (join); called by 2 (load_plugin, read_plugin_detail_for_marketplace_plugin); 1 external calls (format!).


##### `PluginStore::active_plugin_version`  (lines 70–91)

```
fn active_plugin_version(&self, plugin_id: &PluginId) -> Option<String>
```

**Purpose**: Finds which installed version of a plugin should be treated as active. It prefers the special local version if present; otherwise it chooses the latest valid version folder.

**Data flow**: It receives a plugin id, reads the plugin’s base folder, keeps only directory names that are valid version names, sorts them, and then chooses the active one. It returns no value if the plugin has no valid installed versions.

**Call relations**: Configuration merging, plugin reading, PluginStore::active_plugin_root, and PluginStore::is_installed rely on this decision. It uses PluginStore::plugin_base_root to know where to look and compare_plugin_versions to sort versions sensibly.

*Call graph*: calls 1 internal fn (plugin_base_root); called by 4 (merge_configured_plugins_with_remote_installed, read_plugin_for_config, active_plugin_root, is_installed); 1 external calls (read_dir).


##### `PluginStore::active_plugin_root`  (lines 93–96)

```
fn active_plugin_root(&self, plugin_id: &PluginId) -> Option<AbsolutePathBuf>
```

**Purpose**: Returns the folder path for the active installed version of a plugin. This is useful when another part of the system wants to load files from the plugin.

**Data flow**: It receives a plugin id, asks PluginStore::active_plugin_version which version wins, and if there is one, combines that version with the plugin root path. If no active version exists, it returns nothing.

**Call relations**: Plugin detail reading, uninstall-related lookup, and marketplace plugin name lookup call this when they need the actual directory for the selected version. It is a small bridge between version choice and path construction.

*Call graph*: calls 1 internal fn (active_plugin_version); called by 3 (installed_plugin_name_for_marketplace, read_plugin_detail_for_marketplace_plugin, uninstall_plugin_id).


##### `PluginStore::is_installed`  (lines 98–100)

```
fn is_installed(&self, plugin_id: &PluginId) -> bool
```

**Purpose**: Answers the simple yes-or-no question: does this plugin have an active installed version? Callers use it when they do not need the path or version details.

**Data flow**: It receives a plugin id, asks PluginStore::active_plugin_version whether any active version exists, and returns true or false based on that.

**Call relations**: This is a convenience wrapper around PluginStore::active_plugin_version. It keeps callers from duplicating the same option-checking logic.

*Call graph*: calls 1 internal fn (active_plugin_version).


##### `PluginStore::install`  (lines 102–109)

```
fn install(
        &self,
        source_path: AbsolutePathBuf,
        plugin_id: PluginId,
    ) -> Result<PluginInstallResult, PluginStoreError>
```

**Purpose**: Installs a plugin from a source folder using the version declared in its plugin.json file, or the default local version if no version is declared. It is the normal install entry point for local plugin folders.

**Data flow**: It receives the source plugin folder and plugin id, reads the source version through plugin_version_for_source, then passes the source, id, and version to PluginStore::install_with_version. It returns an install result with the id, version, and installed path, or an error.

**Call relations**: This function hands version discovery to plugin_version_for_source and the actual copy-and-swap work to PluginStore::install_with_version. It exists so callers do not have to manually read plugin.json before installing.

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

**Purpose**: Installs a plugin from a source folder using an explicit version. It checks that the source is valid and then places it into the plugin cache safely.

**Data flow**: It receives a source path, plugin id, and version string. It confirms the source is a directory, reads and validates the plugin name from plugin.json, checks that the version is safe as a folder name, builds the final installed path, and asks replace_plugin_root_atomically to copy the files into place. It returns a PluginInstallResult on success or a detailed error on failure.

**Call relations**: PluginStore::install calls this after it has discovered a version. This function coordinates validation helpers such as plugin_name_for_source and validate_plugin_version_segment, then hands the risky disk replacement work to replace_plugin_root_atomically.

*Call graph*: calls 6 internal fn (plugin_base_root, plugin_root, plugin_name_for_source, replace_plugin_root_atomically, validate_plugin_version_segment, as_path); called by 1 (install); 2 external calls (Invalid, format!).


##### `PluginStore::uninstall`  (lines 146–148)

```
fn uninstall(&self, plugin_id: &PluginId) -> Result<(), PluginStoreError>
```

**Purpose**: Removes all cached versions of a plugin from disk. This is used when a plugin should no longer be available from the local cache.

**Data flow**: It receives a plugin id, builds that plugin’s base cache folder, and passes the folder to remove_existing_target. If the folder is already gone, the operation still succeeds.

**Call relations**: This function uses PluginStore::plugin_base_root to identify the whole plugin cache entry, then delegates deletion details to remove_existing_target.

*Call graph*: calls 2 internal fn (plugin_base_root, remove_existing_target).


##### `PluginStoreError::io`  (lines 165–167)

```
fn io(context: &'static str, source: io::Error) -> Self
```

**Purpose**: Creates a PluginStoreError for a failed disk operation with a short explanation of what the code was trying to do. This keeps error messages consistent.

**Data flow**: It receives a fixed context message and the original input/output error from the operating system. It wraps both into the Io variant of PluginStoreError so callers can see both the human context and the underlying cause.

**Call relations**: Disk-heavy helpers, especially replace_plugin_root_atomically and related file operations, use this to turn low-level filesystem failures into plugin-store-specific errors.

*Call graph*: called by 1 (replace_plugin_root_atomically).


##### `plugin_version_for_source`  (lines 170–175)

```
fn plugin_version_for_source(source_path: &Path) -> Result<String, PluginStoreError>
```

**Purpose**: Determines which version folder should be used for a plugin source directory. It reads plugin.json and falls back to the default "local" version when no version is listed.

**Data flow**: It receives a source folder path, asks plugin_manifest_version_for_source for the optional version from plugin.json, substitutes "local" if none is found, validates that the resulting string is safe for a folder name, and returns it.

**Call relations**: PluginStore::install uses this before installing a local plugin. Remote cache refresh code also calls it when it needs to infer a version from a plugin bundle source.

*Call graph*: calls 2 internal fn (plugin_manifest_version_for_source, validate_plugin_version_segment); called by 2 (refresh_non_curated_plugin_cache_with_mode, install).


##### `validate_plugin_version_segment`  (lines 177–194)

```
fn validate_plugin_version_segment(plugin_version: &str) -> Result<(), String>
```

**Purpose**: Checks that a plugin version string is safe to use as one folder name. It blocks empty names, path traversal names like "..", and characters outside a small safe set.

**Data flow**: It receives a version string and inspects its contents. If the string is non-empty, not "." or "..", and contains only ASCII letters, digits, dot, plus, underscore, or dash, it returns success; otherwise it returns a plain error message.

**Call relations**: Install, version discovery, remote bundle validation, and old-version cleanup all use this before trusting a version folder name. It is a guardrail that prevents a version from accidentally acting like a path.

*Call graph*: called by 4 (validate_remote_plugin_bundle, install_with_version, plugin_version_for_source, remove_old_plugin_versions); 1 external calls (matches!).


##### `plugin_manifest_for_source`  (lines 196–199)

```
fn plugin_manifest_for_source(source_path: &Path) -> Result<PluginManifest, PluginStoreError>
```

**Purpose**: Loads the full plugin manifest from a source folder and turns a missing or unreadable manifest into a plugin-store error. The manifest is the plugin.json metadata file.

**Data flow**: It receives a source path, calls load_plugin_manifest, and returns the parsed PluginManifest if one is found. If not, it returns an Invalid error saying plugin.json is missing or invalid.

**Call relations**: plugin_name_for_source calls this because name validation needs the full manifest. It is the local adapter between the manifest loader and the store’s own error type.

*Call graph*: calls 1 internal fn (load_plugin_manifest); called by 1 (plugin_name_for_source).


##### `plugin_manifest_version_for_source`  (lines 208–233)

```
fn plugin_manifest_version_for_source(
    source_path: &Path,
) -> Result<Option<String>, PluginStoreError>
```

**Purpose**: Reads just the version field from a plugin source’s plugin.json file. It deliberately parses only the small part needed for version selection.

**Data flow**: It receives a source folder path, finds plugin.json, reads it as text, parses the JSON, and looks for a version field. If the field is absent it returns None; if it is a non-blank string it returns that string; if it is malformed it returns an Invalid error.

**Call relations**: plugin_version_for_source calls this before applying the default local version and validating the result. This keeps version reading separate from the rest of install logic.

*Call graph*: called by 1 (plugin_version_for_source); 4 external calls (find_plugin_manifest_path, Invalid, read_to_string, from_str).


##### `plugin_name_for_source`  (lines 235–242)

```
fn plugin_name_for_source(source_path: &Path) -> Result<String, PluginStoreError>
```

**Purpose**: Reads and validates the plugin name declared by a source folder. This prevents installing one plugin’s files under another plugin’s marketplace id.

**Data flow**: It receives a source path, loads the manifest through plugin_manifest_for_source, extracts the name, and checks it with validate_plugin_segment. It returns the valid name or an Invalid error.

**Call relations**: PluginStore::install_with_version calls this before copying anything. That means name mismatch is caught early, before the cache is changed.

*Call graph*: calls 1 internal fn (plugin_manifest_for_source); called by 1 (install_with_version); 1 external calls (validate_plugin_segment).


##### `remove_existing_target`  (lines 244–258)

```
fn remove_existing_target(path: &Path) -> Result<(), PluginStoreError>
```

**Purpose**: Deletes an existing file or folder if it is present. It is used to remove a plugin cache entry during uninstall.

**Data flow**: It receives a path. If the path does not exist, it returns success. If it is a directory, it removes the directory tree; otherwise it removes the file. Any filesystem failure is wrapped in a PluginStoreError.

**Call relations**: PluginStore::uninstall calls this after building the plugin’s base cache path. The helper hides the difference between deleting a directory and deleting a file.

*Call graph*: called by 1 (uninstall); 4 external calls (exists, is_dir, remove_dir_all, remove_file).


##### `replace_plugin_root_atomically`  (lines 260–334)

```
fn replace_plugin_root_atomically(
    source: &Path,
    target_root: &Path,
    plugin_version: &str,
) -> Result<(), PluginStoreError>
```

**Purpose**: Copies a plugin into the cache in a way that avoids leaving a half-installed plugin behind. “Atomically” here means it stages the new files first, then swaps them into place as one final move as much as the filesystem allows.

**Data flow**: It receives the source plugin folder, the target plugin base folder, and the version name. It creates a temporary staging folder beside the real cache, copies the source into the staged version folder, and then renames staged folders into their final place. If replacing an existing cache entry fails, it tries to roll back to the previous entry and reports if rollback also fails.

**Call relations**: PluginStore::install_with_version calls this after all checks pass. This function calls copy_dir_recursive for the copy step and remove_old_plugin_versions when adding a new version to an existing plugin entry.

*Call graph*: calls 3 internal fn (io, copy_dir_recursive, remove_old_plugin_versions); called by 1 (install_with_version); 9 external calls (exists, file_name, join, parent, Invalid, format!, create_dir_all, rename, new).


##### `remove_old_plugin_versions`  (lines 336–368)

```
fn remove_old_plugin_versions(
    target_root: &Path,
    plugin_version: &str,
) -> Result<(), PluginStoreError>
```

**Purpose**: Cleans up older version folders after a new version has been added. It also protects against a failed cleanup leaving an older version that would still be chosen as active.

**Data flow**: It receives a plugin’s target root and the newly installed version. It scans child directories, skips the new version and invalid version names, and tries to remove the rest. If removing an old version fails and that old version would outrank the new one, it returns an error because the update would not really become active.

**Call relations**: replace_plugin_root_atomically calls this after placing a new version beside existing versions. It uses old_plugin_version_would_stay_active to decide whether a failed deletion is harmless or dangerous.

*Call graph*: calls 2 internal fn (old_plugin_version_would_stay_active, validate_plugin_version_segment); called by 1 (replace_plugin_root_atomically); 4 external calls (Invalid, format!, read_dir, remove_dir_all).


##### `old_plugin_version_would_stay_active`  (lines 370–373)

```
fn old_plugin_version_would_stay_active(old_version: &str, new_version: &str) -> bool
```

**Purpose**: Decides whether an old version would still win over a newly installed version. This matters because a failed cleanup could make the system keep using the old plugin.

**Data flow**: It receives an old version and a new version. It returns true if the old version is the special "local" version or if version comparison says the old version is greater than the new one.

**Call relations**: remove_old_plugin_versions calls this when it cannot delete an old folder. The answer tells cleanup whether to report a serious activation problem.

*Call graph*: calls 1 internal fn (compare_plugin_versions); called by 1 (remove_old_plugin_versions).


##### `compare_plugin_versions`  (lines 375–380)

```
fn compare_plugin_versions(left: &str, right: &str) -> Ordering
```

**Purpose**: Compares two plugin version strings in the same order used to choose the active plugin. It understands standard semantic versions when both strings follow that format.

**Data flow**: It receives two version strings. If both can be parsed as semantic versions, meaning versions like 1.2.3 with rules for major, minor, and patch numbers, it compares them by those rules. Otherwise it falls back to ordinary text comparison.

**Call relations**: active version selection and old-version safety checks rely on this ordering. old_plugin_version_would_stay_active calls it directly, and active_plugin_version uses the same comparison when sorting discovered versions.

*Call graph*: called by 1 (old_plugin_version_would_stay_active); 1 external calls (parse).


##### `copy_dir_recursive`  (lines 382–406)

```
fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), PluginStoreError>
```

**Purpose**: Copies a whole directory tree from one place to another. It recreates folders and copies regular files, walking into subfolders as needed.

**Data flow**: It receives a source directory and target directory. It creates the target directory, reads each source entry, and for each subdirectory calls itself again; for each regular file it copies the file to the matching target path. It returns success when the tree has been copied, or a PluginStoreError if any filesystem step fails.

**Call relations**: replace_plugin_root_atomically calls this to fill the temporary staging area before the staged plugin is moved into the real cache. Keeping the copy separate from the final rename helps avoid partial installs.

*Call graph*: called by 1 (replace_plugin_root_atomically); 4 external calls (join, copy, create_dir_all, read_dir).


### Secrets backend
Defines the secrets API and then realizes it with a local encrypted file-backed backend using OS-protected key material.

### `windows-sandbox-rs/src/dpapi.rs`

`io_transport` · `cross-cutting secret encryption and decryption`

This file is a small safety wrapper around Windows Data Protection API, usually called DPAPI. DPAPI is like asking Windows to put a secret into a lockbox, where Windows controls the key. Here, the lockbox is machine-wide: the encrypted data can be opened by both elevated and non-elevated processes on the same machine. That matters for a sandbox-related tool, because one part of the program may run with different privileges than another.

The main job of this file is to turn normal Rust byte slices into the special Windows `CRYPT_INTEGER_BLOB` shape that DPAPI expects, call the Windows encryption or decryption function, copy the returned bytes into a normal Rust `Vec<u8>`, and then free the memory that Windows allocated. Without this wrapper, callers would need to use unsafe pointer code directly, which is easy to get wrong and could leak memory or mishandle secrets.

Two important choices are made here. First, UI prompts are forbidden, so encryption or decryption will not suddenly open a Windows dialog. Second, local-machine scope is used, so the result is tied to the computer rather than only the current user account. Errors from Windows are converted into Rust errors with the Windows last-error code included.

#### Function details

##### `make_blob`  (lines 12–17)

```
fn make_blob(data: &[u8]) -> CRYPT_INTEGER_BLOB
```

**Purpose**: This helper reshapes a normal Rust byte slice into the Windows data structure that DPAPI expects. It does not copy or change the bytes; it only points Windows at the existing data and tells Windows how long it is.

**Data flow**: It receives a borrowed list of bytes. It reads the byte count and the memory address of the first byte, then builds a `CRYPT_INTEGER_BLOB` containing those two facts. The result is a small pointer-and-length package that can be passed to Windows API calls.

**Call relations**: Both `protect` and `unprotect` call this before talking to Windows. It is the adapter between ordinary Rust data and the Windows DPAPI functions.

*Call graph*: called by 2 (protect, unprotect).


##### `protect`  (lines 20–51)

```
fn protect(data: &[u8]) -> Result<Vec<u8>>
```

**Purpose**: This function asks Windows to encrypt a byte slice using DPAPI and returns the encrypted bytes. Callers use it when they need to store or pass around data that should not remain in plain readable form.

**Data flow**: It receives plain bytes from the caller. It turns them into a Windows blob with `make_blob`, prepares an empty output blob, and calls `CryptProtectData`. If Windows reports failure, it returns an error containing the Windows error code. If Windows succeeds, it copies the encrypted bytes out of the Windows-owned memory into a Rust `Vec<u8>`, frees the Windows memory with `LocalFree`, and returns the encrypted bytes.

**Call relations**: This function sits between project code and the Windows encryption service. Its direct helper is `make_blob`, and its main handoff is to the external `CryptProtectData` function. It also uses standard null pointer values because DPAPI has optional fields that this project does not use.

*Call graph*: calls 1 internal fn (make_blob); 6 external calls (anyhow!, null, null_mut, from_raw_parts, LocalFree, CryptProtectData).


##### `unprotect`  (lines 54–85)

```
fn unprotect(blob: &[u8]) -> Result<Vec<u8>>
```

**Purpose**: This function asks Windows to decrypt bytes that were previously protected with DPAPI. In this project flow, `decode_password` calls it when an encoded password needs to be turned back into usable plain bytes.

**Data flow**: It receives encrypted bytes. It packages them with `make_blob`, prepares an empty output blob, and calls `CryptUnprotectData`. If Windows cannot decrypt the data, it returns an error with the Windows error code. If decryption succeeds, it copies the plain bytes into a Rust-owned `Vec<u8>`, frees the temporary Windows-owned buffer with `LocalFree`, and returns the decrypted bytes.

**Call relations**: `decode_password` calls this when it needs the original password data. Internally, `unprotect` relies on `make_blob` to prepare the input and then hands the actual decryption work to Windows through `CryptUnprotectData`.

*Call graph*: calls 1 internal fn (make_blob); called by 1 (decode_password); 6 external calls (anyhow!, null, null_mut, from_raw_parts, LocalFree, CryptUnprotectData).


### `secrets/src/lib.rs`

`domain_logic` · `cross-cutting`

Secrets are sensitive values such as tokens or passwords. This file gives the rest of the project a safe, consistent way to talk about them without needing to know the storage details. It defines a `SecretName`, which only allows clear environment-variable-style names like `GITHUB_TOKEN`, and a `SecretScope`, which says whether a secret is shared globally or belongs to one environment, such as a project folder. Think of the scope and name together like a labeled drawer in a locked cabinet.

The `SecretsBackend` trait is the common contract for any storage system: set a value, get it back, delete it, or list what exists. The `SecretsManager` is the friendly wrapper used by callers. Today it creates a local backend, backed by files plus the operating system keyring, but the shape leaves room for other backend kinds later.

The file also contains naming helpers. `environment_id_from_cwd` turns the current directory into a stable environment id, preferring the Git repository name when possible and falling back to a short hash of the folder path. `compute_keyring_account` similarly turns the Codex home path into a stable keyring account name, so different Codex homes do not accidentally share the same secret passphrase.

#### Function details

##### `SecretName::new`  (lines 29–39)

```
fn new(raw: &str) -> Result<Self>
```

**Purpose**: Creates a safe secret name from user or program input. It rejects empty names and names containing anything other than uppercase letters, digits, or underscores, which keeps stored keys predictable and avoids confusing or unsafe names.

**Data flow**: It receives raw text, trims spaces from the ends, checks that something remains, then checks every character. If the text passes, it returns a `SecretName`; if not, it returns an error explaining what is wrong.

**Call relations**: Other parts of the secrets system call this when turning text into a trusted secret name, including parsing stored keys and tests that exercise local storage. It is the gatekeeper before names are passed on to storage operations.

*Call graph*: called by 6 (compute_secret_name, parse_canonical_key, local_namespaces_write_separate_files, save_file_does_not_leave_temp_files, set_fails_when_keyring_is_unavailable, manager_round_trips_local_backend); 1 external calls (ensure!).


##### `SecretName::as_str`  (lines 41–43)

```
fn as_str(&self) -> &str
```

**Purpose**: Returns the secret name as ordinary text. Code uses this when it needs to build storage keys or display the name without exposing any secret value.

**Data flow**: It reads the already-validated string inside the `SecretName` and returns a borrowed view of it. Nothing is changed or copied.

**Call relations**: This is used by code such as scope key creation to reuse the validated name in a larger identifier. It is a small accessor that keeps callers from reaching into the type directly.


##### `SecretName::fmt`  (lines 47–49)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Defines how a `SecretName` is printed as text. This lets logging, formatting, or user-facing output show the name itself in a normal way.

**Data flow**: It receives a formatter and writes the inner name string into it. The result is either successful formatting or a formatting error from the output machinery.

**Call relations**: Rust calls this automatically when a `SecretName` is used in display-style formatting. It supports the broader system by making the wrapper type behave like readable text where appropriate.

*Call graph*: 1 external calls (write!).


##### `SecretScope::environment`  (lines 59–64)

```
fn environment(environment_id: impl Into<String>) -> Result<Self>
```

**Purpose**: Creates an environment-specific scope from an environment id. It rejects blank ids so a secret cannot accidentally be stored under an unnamed environment.

**Data flow**: It receives something convertible into a string, trims surrounding spaces, checks that the result is not empty, and returns a `SecretScope::Environment` containing the cleaned id. If the id is empty, it returns an error.

**Call relations**: Parsing code calls this when rebuilding a scope from a stored key. It ensures environment scopes are valid before they are used to look up or save secrets.

*Call graph*: called by 1 (parse_canonical_key); 3 external calls (into, Environment, ensure!).


##### `SecretScope::canonical_key`  (lines 66–74)

```
fn canonical_key(&self, name: &SecretName) -> String
```

**Purpose**: Builds the stable storage key for a secret by combining its scope and name. This is the label used internally so global secrets and environment secrets do not collide.

**Data flow**: It receives a scope and a validated secret name. For a global secret it returns text like `global/NAME`; for an environment secret it returns text like `env/ENVIRONMENT/NAME`.

**Call relations**: The backend calls this during set, get, and delete operations to find the exact stored entry. It is the shared rule that keeps every operation looking in the same drawer.

*Call graph*: called by 3 (delete, get, set); 1 external calls (format!).


##### `SecretsManager::new`  (lines 103–111)

```
fn new(codex_home: PathBuf, backend_kind: SecretsBackendKind) -> Self
```

**Purpose**: Creates a normal secrets manager using the configured backend kind and the default operating system keyring. This is the usual constructor for production use.

**Data flow**: It receives the Codex home folder and the chosen backend kind. For the local backend, it creates a default keyring store and builds a `LocalSecretsBackend`, then wraps it in a shared pointer inside `SecretsManager`.

**Call relations**: Callers use this when they want the standard secrets setup. It hands off real storage work to `LocalSecretsBackend`, while the manager presents a simple API to the rest of the app.

*Call graph*: calls 1 internal fn (new); 1 external calls (new).


##### `SecretsManager::new_with_keyring_store`  (lines 113–124)

```
fn new_with_keyring_store(
        codex_home: PathBuf,
        backend_kind: SecretsBackendKind,
        keyring_store: Arc<dyn KeyringStore>,
    ) -> Self
```

**Purpose**: Creates a secrets manager with a caller-provided keyring store. This is useful for tests or special setups where the real operating system keyring should be replaced.

**Data flow**: It receives the Codex home folder, backend kind, and a keyring store object. For the local backend, it passes that store into `LocalSecretsBackend` and returns a manager wrapping the backend.

**Call relations**: The round-trip test calls this with a mock keyring so it can verify secret storage without depending on the machine’s real keyring. It exists as a controlled version of the normal constructor.

*Call graph*: calls 1 internal fn (new); called by 1 (manager_round_trips_local_backend); 1 external calls (new).


##### `SecretsManager::new_with_keyring_store_and_namespace`  (lines 126–140)

```
fn new_with_keyring_store_and_namespace(
        codex_home: PathBuf,
        backend_kind: SecretsBackendKind,
        keyring_store: Arc<dyn KeyringStore>,
        namespace: LocalSecretsNamespace,
```

**Purpose**: Creates a secrets manager with both a caller-provided keyring store and a chosen local namespace. A namespace is like a separate compartment, useful when tests or migrations need isolated local secret storage.

**Data flow**: It receives the Codex home folder, backend kind, keyring store, and namespace. For the local backend, it builds a `LocalSecretsBackend` using that namespace and stores it behind the manager interface.

**Call relations**: Several authentication and migration flows call this when they need precise control over where local secrets are read or written. It delegates the detailed setup to the local backend’s namespace-aware constructor.

*Call graph*: calls 1 internal fn (new_with_namespace); called by 9 (new, assert_keyring_saved_auth_and_removed_fallback, seed_secrets_backend_and_fallback_auth_file_for_delete, seed_secrets_backend_with_auth, delete_oauth_tokens_from_secrets_keyring, load_oauth_tokens_from_secrets_keyring, save_oauth_tokens_to_secrets_keyring, delete_oauth_tokens_with_secrets_backend_removes_secrets_and_file, save_oauth_tokens_with_secrets_backend_writes_encrypted_storage); 1 external calls (new).


##### `SecretsManager::set`  (lines 142–144)

```
fn set(&self, scope: &SecretScope, name: &SecretName, value: &str) -> Result<()>
```

**Purpose**: Stores or replaces one secret value. Callers use it when saving a token or other sensitive value under a validated name and scope.

**Data flow**: It receives a scope, secret name, and secret value. It forwards those directly to the backend, which performs the actual secure storage, and returns success or an error.

**Call relations**: Higher-level save logic calls this when it wants to persist a secret. The manager does not store the value itself; it passes the request to the selected backend.

*Call graph*: called by 1 (save).


##### `SecretsManager::get`  (lines 146–148)

```
fn get(&self, scope: &SecretScope, name: &SecretName) -> Result<Option<String>>
```

**Purpose**: Looks up a secret value by scope and name. It returns either the secret text, no value if it was not found, or an error if storage could not be read.

**Data flow**: It receives a scope and secret name, asks the backend for that exact entry, and returns the backend’s result unchanged.

**Call relations**: Higher-level load logic calls this when it needs a saved secret, such as an authentication token. The manager serves as the stable doorway while the backend does the storage-specific work.

*Call graph*: called by 1 (load).


##### `SecretsManager::delete`  (lines 150–152)

```
fn delete(&self, scope: &SecretScope, name: &SecretName) -> Result<bool>
```

**Purpose**: Removes a secret if it exists. The returned boolean tells the caller whether anything was actually deleted.

**Data flow**: It receives a scope and secret name, forwards the delete request to the backend, and returns `true` if an entry was removed or `false` if there was nothing there.

**Call relations**: Higher-level delete logic calls this during cleanup or logout-style flows. The manager routes the request to the active backend.

*Call graph*: called by 1 (delete).


##### `SecretsManager::list`  (lines 154–156)

```
fn list(&self, scope_filter: Option<&SecretScope>) -> Result<Vec<SecretListEntry>>
```

**Purpose**: Lists known secret entries, optionally limited to one scope. It returns names and scopes, not the secret values themselves.

**Data flow**: It receives either no filter or a specific scope filter, asks the backend for matching entries, and returns the list of `SecretListEntry` records.

**Call relations**: Code can call this when it needs an inventory of saved secrets without revealing their contents. The backend supplies the actual list based on its stored metadata.


##### `environment_id_from_cwd`  (lines 159–180)

```
fn environment_id_from_cwd(cwd: &Path) -> String
```

**Purpose**: Turns a working directory into a stable environment id. It uses the Git repository folder name when available, and otherwise creates a short, repeatable id from the directory path.

**Data flow**: It receives a path. First it tries to find the Git repository root and use that folder’s name. If that fails, it canonicalizes the path when possible, hashes the path text with SHA-256, shortens the hash, and returns an id like `cwd-abc123...`.

**Call relations**: The included test checks the fallback behavior. In normal use, this helper gives environment-scoped secrets a predictable label tied to the current project or folder.

*Call graph*: called by 1 (environment_id_fallback_has_cwd_prefix); 4 external calls (canonicalize, new, get_git_repo_root, format!).


##### `compute_keyring_account`  (lines 183–195)

```
fn compute_keyring_account(codex_home: &Path) -> String
```

**Purpose**: Computes the operating system keyring account name used for the local secrets passphrase. It keeps different Codex home folders separate by basing the account name on the folder path.

**Data flow**: It receives the Codex home path, canonicalizes it when possible, hashes the path text with SHA-256, shortens the hash, and returns a string like `secrets|<hash>`.

**Call relations**: The local secrets backend can use this helper when deciding where in the OS keyring to store the passphrase. It prevents two separate Codex homes from accidentally reusing the same keyring entry.

*Call graph*: 3 external calls (canonicalize, new, format!).


##### `keyring_service`  (lines 197–199)

```
fn keyring_service() -> &'static str
```

**Purpose**: Returns the fixed keyring service name used by this crate. A service name is the top-level label under which the operating system keyring stores entries.

**Data flow**: It reads the module constant `KEYRING_SERVICE` and returns the static text `codex`. Nothing is computed or changed.

**Call relations**: Backend code inside the crate can call this so every keyring operation uses the same service label. It centralizes the value instead of scattering the literal string around.


##### `tests::environment_id_fallback_has_cwd_prefix`  (lines 208–223)

```
fn environment_id_fallback_has_cwd_prefix()
```

**Purpose**: Checks that a non-Git temporary directory gets an environment id based on the `cwd-` fallback format. This protects the rule that unknown folders still receive stable, safe ids.

**Data flow**: It creates a temporary directory, asks `environment_id_from_cwd` for an id, independently computes the expected hash from the canonical path, and compares the two strings.

**Call relations**: This test directly exercises `environment_id_from_cwd`. If the fallback format or hashing behavior changes unexpectedly, the test fails and alerts maintainers.

*Call graph*: calls 1 internal fn (environment_id_from_cwd); 4 external calls (new, assert_eq!, format!, tempdir).


##### `tests::manager_round_trips_local_backend`  (lines 226–247)

```
fn manager_round_trips_local_backend() -> Result<()>
```

**Purpose**: Verifies that the secrets manager can save, read, list, and delete a secret using the local backend. It uses a mock keyring so the test is isolated from the real machine.

**Data flow**: It creates a temporary Codex home, a mock keyring, a manager, a global scope, and a `GITHUB_TOKEN` name. It saves `token-1`, reads it back, confirms it appears in the list, deletes it, and confirms it is gone.

**Call relations**: This test calls `SecretsManager::new_with_keyring_store` and then the manager’s storage methods. It proves that the public manager API and the local backend work together for the basic secret lifecycle.

*Call graph*: calls 2 internal fn (new, new_with_keyring_store); 5 external calls (new, assert!, assert_eq!, default, tempdir).


### `secrets/src/local.rs`

`io_transport` · `cross-cutting secret storage during command and request handling`

This file is the local “safe box” for project secrets. A secret might be an authentication token or an OAuth credential. The file keeps those values in encrypted `.age` files under the Codex home directory, while the encryption passphrase is stored separately in the operating system keyring, which is the system-provided secure password store.

The main type is `LocalSecretsBackend`. It knows where the Codex home directory is, which keyring to use, and which local secret namespace it is writing to. Different namespaces use different files, so general managed secrets, Codex authentication secrets, and MCP OAuth secrets do not overwrite each other.

When code asks to set or get a secret, the backend first builds a stable key from the secret's scope and name. A scope is the area where a secret applies, such as global or a particular environment. It then loads the encrypted file if it exists, decrypts it with the passphrase from the keyring, edits or reads the in-memory map, and saves it back if needed.

Saving is careful: it encrypts the JSON data, writes it to a temporary file, syncs it to disk, and then renames it into place. That is like writing a replacement note beside the old one and swapping it only when the new note is complete, reducing the chance of a half-written secrets file.

#### Function details

##### `SecretsFile::new_empty`  (lines 60–65)

```
fn new_empty() -> Self
```

**Purpose**: Creates a blank secrets file structure with the current supported format version. It is used when there is no encrypted secrets file on disk yet.

**Data flow**: It takes no outside data. It fills in the current secrets-file version and an empty ordered map of secret keys to secret values, then returns that new in-memory file object.

**Call relations**: When `LocalSecretsBackend::load_file` looks for the encrypted file and finds that it does not exist, it asks this function for a clean starting point instead of treating the missing file as an error.

*Call graph*: called by 1 (load_file); 1 external calls (new).


##### `LocalSecretsBackend::new`  (lines 76–82)

```
fn new(codex_home: PathBuf, keyring_store: Arc<dyn KeyringStore>) -> Self
```

**Purpose**: Builds a local secrets backend using the default namespace for managed secrets. This is the simple constructor most callers use when they do not need a special secrets file.

**Data flow**: It receives the Codex home path and a shared keyring store. It adds the default namespace choice and returns a configured `LocalSecretsBackend` ready to read and write local encrypted secrets.

**Call relations**: This is a convenience front door. It delegates the actual setup to `LocalSecretsBackend::new_with_namespace`, and tests and higher-level setup code use it when they want the normal `local.age` storage file.

*Call graph*: called by 5 (new, new_with_keyring_store, load_file_rejects_newer_schema_versions, save_file_does_not_leave_temp_files, set_fails_when_keyring_is_unavailable); 1 external calls (new_with_namespace).


##### `LocalSecretsBackend::new_with_namespace`  (lines 84–94)

```
fn new_with_namespace(
        codex_home: PathBuf,
        keyring_store: Arc<dyn KeyringStore>,
        namespace: LocalSecretsNamespace,
    ) -> Self
```

**Purpose**: Builds a local secrets backend for a specific secrets namespace. Callers use this when they need separate encrypted files for different kinds of credentials.

**Data flow**: It receives the Codex home path, a shared keyring store, and a namespace choice. It stores those three pieces together in a new backend object and returns it.

**Call relations**: This is the lower-level constructor behind the default constructor. Code that wants Codex authentication secrets or MCP OAuth secrets uses this path so those values land in their own files.

*Call graph*: called by 2 (new_with_keyring_store_and_namespace, local_namespaces_write_separate_files).


##### `LocalSecretsBackend::secrets_dir`  (lines 138–140)

```
fn secrets_dir(&self) -> PathBuf
```

**Purpose**: Computes the directory where local secrets files live. It keeps the path rule in one place: inside the Codex home directory, under `secrets`.

**Data flow**: It reads the backend's Codex home path, appends `secrets`, and returns the resulting path. It does not touch the disk by itself.

**Call relations**: Saving uses this to create the directory if needed, and `LocalSecretsBackend::secrets_path` uses it as the base path before adding the namespace-specific file name.

*Call graph*: called by 2 (save_file, secrets_path); 1 external calls (join).


##### `LocalSecretsBackend::secrets_path`  (lines 142–149)

```
fn secrets_path(&self) -> PathBuf
```

**Purpose**: Computes the full path to the encrypted secrets file for this backend's namespace. This is how the backend knows whether it should use `local.age`, `codex_auth.age`, or `mcp_oauth.age`.

**Data flow**: It reads the namespace stored in the backend, chooses the matching file name, appends that name to the secrets directory path, and returns the full path.

**Call relations**: Loading and saving both call this before reading from or writing to disk. It depends on `LocalSecretsBackend::secrets_dir` for the shared directory part.

*Call graph*: calls 1 internal fn (secrets_dir); called by 2 (load_file, save_file).


##### `LocalSecretsBackend::load_file`  (lines 151–177)

```
fn load_file(&self) -> Result<SecretsFile>
```

**Purpose**: Reads the encrypted secrets file from disk and turns it into an in-memory `SecretsFile`. If the file does not exist yet, it returns an empty secrets file instead.

**Data flow**: It computes the file path, checks whether the file exists, and reads the encrypted bytes if it does. It then gets or creates the passphrase from the keyring, decrypts the bytes, parses the JSON into a secrets map, normalizes an old zero version to the current version, and rejects files from newer unsupported versions. The result is a usable in-memory secrets file.

**Call relations**: The public operations `set`, `get`, `delete`, and `list` all start by calling this. It hands encrypted bytes to `decrypt_with_passphrase` and relies on `load_or_create_passphrase` for the key needed to unlock the file.

*Call graph*: calls 4 internal fn (load_or_create_passphrase, secrets_path, new_empty, decrypt_with_passphrase); called by 4 (delete, get, list, set); 3 external calls (ensure!, read, from_slice).


##### `LocalSecretsBackend::save_file`  (lines 179–190)

```
fn save_file(&self, file: &SecretsFile) -> Result<()>
```

**Purpose**: Writes an in-memory secrets file back to disk safely and encrypted. It is used after a secret has been added, changed, or removed.

**Data flow**: It ensures the secrets directory exists, obtains the passphrase from the keyring, turns the secrets map into JSON bytes, encrypts those bytes, computes the final file path, and writes the encrypted result using an atomic replacement. Its output is success or an error explaining what failed.

**Call relations**: `set` calls this after inserting a value, and `delete` calls it after actually removing a value. It hands encryption to `encrypt_with_passphrase` and durable file replacement to `write_file_atomically`.

*Call graph*: calls 5 internal fn (load_or_create_passphrase, secrets_dir, secrets_path, encrypt_with_passphrase, write_file_atomically); called by 2 (delete, set); 2 external calls (create_dir_all, to_vec).


##### `LocalSecretsBackend::load_or_create_passphrase`  (lines 192–213)

```
fn load_or_create_passphrase(&self) -> Result<SecretString>
```

**Purpose**: Gets the encryption passphrase from the operating system keyring, or creates and stores a new one if none exists. This keeps the secrets file encrypted without asking the user for a password each time.

**Data flow**: It computes the keyring account name for this Codex home directory, asks the keyring store for an existing value, and returns it if found. If nothing is stored yet, it generates a fresh high-randomness passphrase, saves it into the keyring, and returns that new passphrase.

**Call relations**: Both loading and saving need this function before they can decrypt or encrypt the secrets file. When no key exists, it calls `generate_passphrase`; when a keyring operation fails, the higher-level read or write operation fails too.

*Call graph*: calls 1 internal fn (generate_passphrase); called by 2 (load_file, save_file); 3 external calls (from, compute_keyring_account, keyring_service).


##### `LocalSecretsBackend::set`  (lines 217–219)

```
fn set(&self, scope: &SecretScope, name: &SecretName, value: &str) -> Result<()>
```

**Purpose**: Stores or replaces one secret value. It refuses to store an empty string, because an empty secret is usually a mistake and would be hard to distinguish from missing data.

**Data flow**: It receives a scope, a secret name, and a value. It turns the scope and name into a canonical key, loads the current secrets file, inserts the new value under that key, and saves the updated encrypted file. The visible result is success or an error.

**Call relations**: This is one of the main backend operations exposed through the `SecretsBackend` trait. It depends on `load_file` to get the current state and `save_file` to persist the changed state.

*Call graph*: calls 3 internal fn (canonical_key, load_file, save_file); 1 external calls (ensure!).


##### `LocalSecretsBackend::get`  (lines 221–223)

```
fn get(&self, scope: &SecretScope, name: &SecretName) -> Result<Option<String>>
```

**Purpose**: Looks up one secret value by scope and name. It returns nothing if that exact secret has not been stored.

**Data flow**: It receives a scope and secret name, converts them to the same canonical key used when saving, loads and decrypts the secrets file, and searches the map for that key. It returns either a copy of the stored string or `None`.

**Call relations**: This is the read side of the `SecretsBackend` behavior. It only needs `load_file`; it does not call `save_file` because it does not change anything.

*Call graph*: calls 2 internal fn (canonical_key, load_file).


##### `LocalSecretsBackend::delete`  (lines 225–227)

```
fn delete(&self, scope: &SecretScope, name: &SecretName) -> Result<bool>
```

**Purpose**: Removes one secret if it exists. It tells the caller whether anything was actually removed.

**Data flow**: It receives a scope and name, converts them into a canonical key, loads the current secrets map, and tries to remove that key. If removal happened, it saves the updated encrypted file; otherwise it leaves the disk file untouched. It returns `true` for removed and `false` for not found.

**Call relations**: This is the delete operation exposed through the backend. It follows the same load-edit-save pattern as `set`, but only writes the file when there was a real change.

*Call graph*: calls 3 internal fn (canonical_key, load_file, save_file).


##### `LocalSecretsBackend::list`  (lines 229–231)

```
fn list(&self, scope_filter: Option<&SecretScope>) -> Result<Vec<SecretListEntry>>
```

**Purpose**: Lists the secret entries known to the local backend, optionally limited to one scope. It returns names and scopes, not the secret values themselves.

**Data flow**: It loads the decrypted secrets file and walks through the stored canonical keys. Each key is parsed back into a scope and name; invalid stored keys are skipped with a warning. If a scope filter was provided, entries outside that scope are ignored. The output is a list of `SecretListEntry` records.

**Call relations**: This is the inventory operation for callers that need to show what secrets exist. It relies on `parse_canonical_key` to translate stored key strings back into structured entries.

*Call graph*: calls 2 internal fn (load_file, parse_canonical_key); 2 external calls (new, warn!).


##### `write_file_atomically`  (lines 234–311)

```
fn write_file_atomically(path: &Path, contents: &[u8]) -> Result<()>
```

**Purpose**: Writes bytes to a file in a way that avoids leaving a partly written final file. This matters because a crash during secrets saving should not corrupt the only copy of the encrypted secrets file.

**Data flow**: It receives the final path and the bytes to write. It creates a uniquely named temporary file in the same directory, writes all bytes to it, syncs it to disk, and then renames it over the final path. On Windows, it has a fallback for replacing an existing file. If replacement fails, it tries to remove the temporary file and returns an error.

**Call relations**: `LocalSecretsBackend::save_file` calls this after encryption. It is the last step before the new encrypted secrets file becomes visible on disk.

*Call graph*: called by 1 (save_file); 8 external calls (exists, file_name, parent, now, format!, new, remove_file, rename).


##### `generate_passphrase`  (lines 313–322)

```
fn generate_passphrase() -> Result<SecretString>
```

**Purpose**: Creates a new random encryption passphrase for the local secrets file. It is used only when the keyring does not already have one.

**Data flow**: It fills a 32-byte array with randomness from the operating system, encodes those bytes as Base64 text so the keyring can store it safely as a string, wipes the temporary raw bytes from memory, and returns the encoded passphrase wrapped as secret data.

**Call relations**: `LocalSecretsBackend::load_or_create_passphrase` calls this during first-time setup. Before returning, it calls `wipe_bytes` to reduce how long the raw random bytes remain in memory.

*Call graph*: calls 1 internal fn (wipe_bytes); called by 1 (load_or_create_passphrase); 1 external calls (from).


##### `wipe_bytes`  (lines 324–331)

```
fn wipe_bytes(bytes: &mut [u8])
```

**Purpose**: Overwrites a byte buffer with zeroes after sensitive data has been used. This lowers the chance that secret material remains in memory longer than necessary.

**Data flow**: It receives a mutable slice of bytes. It writes zero into each byte using a special low-level write that the compiler is less likely to optimize away, then adds a compiler fence, which is a barrier that discourages reordering around the wipe. It returns nothing and changes the buffer in place.

**Call relations**: `generate_passphrase` uses this after converting random bytes into the stored passphrase string. Its job is small but security-focused: clean up the temporary raw key material.

*Call graph*: called by 1 (generate_passphrase); 2 external calls (write_volatile, compiler_fence).


##### `encrypt_with_passphrase`  (lines 333–336)

```
fn encrypt_with_passphrase(plaintext: &[u8], passphrase: &SecretString) -> Result<Vec<u8>>
```

**Purpose**: Encrypts plain secrets-file bytes using the provided passphrase. This turns readable JSON into protected bytes safe to write to disk.

**Data flow**: It receives plaintext bytes and a secret passphrase. It creates an `age` scrypt recipient, meaning an encryption target based on a passphrase and a password-hardening method, encrypts the bytes, and returns the encrypted byte vector or an error.

**Call relations**: `LocalSecretsBackend::save_file` calls this after serializing the secrets map to JSON. The encrypted output is then passed to `write_file_atomically` for storage.

*Call graph*: called by 1 (save_file); 3 external calls (new, clone, encrypt).


##### `decrypt_with_passphrase`  (lines 338–341)

```
fn decrypt_with_passphrase(ciphertext: &[u8], passphrase: &SecretString) -> Result<Vec<u8>>
```

**Purpose**: Decrypts the encrypted secrets-file bytes using the provided passphrase. This turns the protected disk file back into readable JSON for the backend to parse.

**Data flow**: It receives encrypted bytes and the secret passphrase. It creates an `age` scrypt identity, which is the passphrase-based unlocker matching the encrypting recipient, decrypts the bytes, and returns the plaintext or an error.

**Call relations**: `LocalSecretsBackend::load_file` calls this after reading the encrypted file and obtaining the passphrase from the keyring. Its output is then deserialized into `SecretsFile`.

*Call graph*: called by 1 (load_file); 3 external calls (new, clone, decrypt).


##### `parse_canonical_key`  (lines 343–370)

```
fn parse_canonical_key(canonical_key: &str) -> Option<SecretListEntry>
```

**Purpose**: Turns a stored secret key string back into a structured secret list entry. It understands the key formats used for global secrets and environment-scoped secrets.

**Data flow**: It receives a string such as a global key or an environment key, splits it on `/`, checks that the pieces match a known format, validates the secret name and environment scope, and returns a `SecretListEntry`. If the string is malformed or uses an unknown scope kind, it returns `None`.

**Call relations**: `LocalSecretsBackend::list` calls this for every stored key. Valid keys become list results; invalid keys are skipped by the caller with a warning.

*Call graph*: calls 2 internal fn (new, environment); called by 1 (list).


##### `tests::load_file_rejects_newer_schema_versions`  (lines 380–399)

```
fn load_file_rejects_newer_schema_versions() -> Result<()>
```

**Purpose**: Checks that the backend refuses to load a secrets file written with a newer format version than this code supports. This protects older code from misreading newer data.

**Data flow**: The test creates a temporary Codex home and mock keyring, saves a secrets file with a version number above the supported one, then tries to load it. The expected output is an error message saying the file is newer than supported.

**Call relations**: This test exercises the interaction between `LocalSecretsBackend::save_file` and `LocalSecretsBackend::load_file`. It proves that the version check inside loading is not silently bypassed.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, new, assert!, default, tempdir).


##### `tests::set_fails_when_keyring_is_unavailable`  (lines 402–424)

```
fn set_fails_when_keyring_is_unavailable() -> Result<()>
```

**Purpose**: Checks that saving a secret fails clearly when the keyring cannot provide or store the encryption key. Without the keyring, the backend cannot safely encrypt the file.

**Data flow**: The test creates a temporary Codex home and a mock keyring configured to fail for the relevant account. It then tries to set a global test secret. The expected result is an error that mentions failure to load the secrets key from the keyring.

**Call relations**: This test drives `LocalSecretsBackend::set`, which calls `load_file` and then `load_or_create_passphrase`. The mocked keyring failure confirms that the error travels back to the caller with useful context.

*Call graph*: calls 2 internal fn (new, new); 6 external calls (new, Invalid, assert!, default, compute_keyring_account, tempdir).


##### `tests::save_file_does_not_leave_temp_files`  (lines 427–450)

```
fn save_file_does_not_leave_temp_files() -> Result<()>
```

**Purpose**: Checks that repeated saves do not leave temporary files behind in the secrets directory. This matters because atomic writing creates temporary files as part of normal operation.

**Data flow**: The test creates a backend, writes the same secret twice with different values, reads the secrets directory, and collects the visible file names. It expects to find only the final `local.age` file, and it also checks that the stored value is the newer one.

**Call relations**: This test covers the save path from `LocalSecretsBackend::set` through `save_file` and `write_file_atomically`. It confirms both cleanup behavior and successful replacement of the encrypted file.

*Call graph*: calls 2 internal fn (new, new); 5 external calls (new, assert_eq!, read_dir, default, tempdir).


##### `tests::local_namespaces_write_separate_files`  (lines 453–496)

```
fn local_namespaces_write_separate_files() -> Result<()>
```

**Purpose**: Checks that different local secret namespaces write to different encrypted files. This prevents unrelated credential groups from overwriting each other.

**Data flow**: The test creates two backends that share the same Codex home and keyring but use different namespaces. It stores the same secret name in both, reads both values back, and checks that `codex_auth.age` and `mcp_oauth.age` exist while the default `local.age` file does not.

**Call relations**: This test uses `LocalSecretsBackend::new_with_namespace`, then exercises `set` and `get` on each backend. It verifies that `secrets_path` chooses the namespace-specific file names correctly.

*Call graph*: calls 2 internal fn (new, new_with_namespace); 5 external calls (new, assert!, assert_eq!, default, tempdir).


### Memory store backend
Provides the concrete local memories backend and its root-scoped filesystem access layer.

### `ext/memories/src/local.rs`

`io_transport` · `request handling`

This file is the front door for storing and reading “memories” from the local filesystem. A memory root folder is chosen, usually a `memories` folder inside the Codex home directory, and every operation must stay inside that folder. That safety rule matters: without it, a request could accidentally or maliciously read files outside the memories area, such as by using `..` in a path.

The main type, `LocalMemoriesBackend`, remembers only one thing: the root folder where memories live. It implements the shared `MemoriesBackend` interface, which means the rest of the project can ask for memories without caring whether they come from local files or some other storage system.

The most important internal helper is `resolve_scoped_path`. It takes an optional user-provided relative path and carefully turns it into a real path under the memory root. It rejects paths that try to go upward, start at the filesystem root, use platform-specific prefixes, include hidden path parts, pass through regular files as if they were folders, or cross symbolic links. A symbolic link is like a shortcut; rejecting it helps prevent a shortcut inside the memories folder from pointing somewhere outside it.

The actual work for adding notes, listing, reading, and searching lives in submodules. This file wires those pieces together and enforces the common local-backend shape.

#### Function details

##### `LocalMemoriesBackend::from_codex_home`  (lines 30–32)

```
fn from_codex_home(codex_home: &AbsolutePathBuf) -> Self
```

**Purpose**: Creates a local memories backend using the standard location under the Codex home folder. Someone uses this when they want memories to live in the normal `memories` subfolder rather than choosing a custom folder.

**Data flow**: It receives the Codex home path, appends `memories` to it, and passes that resulting folder path into the more general constructor. The result is a `LocalMemoriesBackend` whose root points at that standard memories directory.

**Call relations**: Tooling code calls this when it wants the default local memories setup. This function does the small bit of path building, then hands off to `LocalMemoriesBackend::from_memory_root` so backend creation stays consistent.

*Call graph*: calls 1 internal fn (join); called by 1 (tools); 1 external calls (from_memory_root).


##### `LocalMemoriesBackend::from_memory_root`  (lines 34–36)

```
fn from_memory_root(root: impl Into<PathBuf>) -> Self
```

**Purpose**: Creates a local memories backend from an explicitly chosen root folder. This is useful when the caller already knows exactly where memory files should be stored.

**Data flow**: It receives something that can become a filesystem path, converts it into a `PathBuf`, and stores it as the backend’s root. The output is a new `LocalMemoriesBackend` ready to answer memory requests relative to that folder.

**Call relations**: The memory tool can call this directly for a custom memory location. It is also used by `LocalMemoriesBackend::from_codex_home`, which first builds the default `memories` path and then delegates construction here.

*Call graph*: called by 1 (memory_tool); 1 external calls (into).


##### `LocalMemoriesBackend::resolve_scoped_path`  (lines 38–88)

```
async fn resolve_scoped_path(
        &self,
        relative_path: Option<&str>,
    ) -> Result<PathBuf, MemoriesBackendError>
```

**Purpose**: Safely turns an optional user path into a real path inside the memories root. It exists to stop requests from escaping the memories folder or walking through unsafe filesystem structures.

**Data flow**: It starts with either no path or a relative path string. If no path is provided, it returns the backend’s root folder. If a path is provided, it checks each part: it rejects upward moves like `..`, absolute paths, hidden components, symbolic links, and attempts to treat a file as a folder. As it walks the path, it reads filesystem metadata where entries already exist. The final output is a safe path under the memory root, or a clear backend error if the path is not allowed.

**Call relations**: The list, read, and search flows call this before touching the filesystem, so they all share the same safety gate. While checking the path, it asks `LocalMemoriesBackend::metadata_or_none` whether each partial path exists, and it uses path helper functions to display paths and reject symbolic links.

*Call graph*: calls 3 internal fn (invalid_path, display_relative_path, reject_symlink); called by 3 (list, read, search); 3 external calls (new, clone, metadata_or_none).


##### `LocalMemoriesBackend::metadata_or_none`  (lines 90–98)

```
async fn metadata_or_none(
        path: &Path,
    ) -> Result<Option<std::fs::Metadata>, MemoriesBackendError>
```

**Purpose**: Looks up filesystem information for a path, while treating “does not exist” as a normal, non-error case. This lets callers distinguish between a missing path and a real filesystem failure.

**Data flow**: It receives a path and asks the operating system for metadata about that exact path, including whether it is a symbolic link. If metadata is found, it returns it wrapped in `Some`. If the path is missing, it returns `None`. If another disk error happens, it converts that into a memories backend error.

**Call relations**: Path-sensitive operations use this whenever they need to inspect the filesystem without immediately failing on missing entries. It supports directory creation checks, listing, reading, searching, and deeper search entry inspection.

*Call graph*: called by 5 (ensure_directory, list, read, search, search_entries); 1 external calls (symlink_metadata).


##### `LocalMemoriesBackend::add_ad_hoc_note`  (lines 102–107)

```
async fn add_ad_hoc_note(
        &self,
        request: AddAdHocMemoryNoteRequest,
    ) -> Result<AddAdHocMemoryNoteResponse, MemoriesBackendError>
```

**Purpose**: Accepts a request to add a one-off memory note and forwards it to the note-writing code. This keeps the public backend interface simple while letting the note-specific module do the actual file work.

**Data flow**: It receives an add-note request and the current backend, then passes both to the `ad_hoc_note` module. That module performs the work and returns either a response describing the added note or a backend error.

**Call relations**: This is the `MemoriesBackend` implementation point for adding ad hoc notes. When outside code calls the backend’s add-note operation, this method immediately hands the request to `ad_hoc_note::add_ad_hoc_note`.

*Call graph*: calls 1 internal fn (add_ad_hoc_note).


##### `LocalMemoriesBackend::list`  (lines 109–114)

```
async fn list(
        &self,
        request: ListMemoriesRequest,
    ) -> Result<ListMemoriesResponse, MemoriesBackendError>
```

**Purpose**: Accepts a request to list memories and forwards it to the listing code. It is the local backend’s public entry for browsing what memories are available.

**Data flow**: It receives a list request and passes it, along with the backend root information, to the `list` module. The result is a list response or an error if the requested location is invalid or cannot be read.

**Call relations**: This is called through the shared `MemoriesBackend` interface when someone wants to browse memories. The real listing work happens in `list::list`, which can use this backend’s safe path resolution helpers.

*Call graph*: calls 1 internal fn (list).


##### `LocalMemoriesBackend::read`  (lines 116–121)

```
async fn read(
        &self,
        request: ReadMemoryRequest,
    ) -> Result<ReadMemoryResponse, MemoriesBackendError>
```

**Purpose**: Accepts a request to read a memory and forwards it to the reading code. It is the local backend’s public entry for opening a specific memory file.

**Data flow**: It receives a read request and sends it to the `read` module together with the backend. The output is the memory contents in a read response, or an error if the path is unsafe, missing, or unreadable.

**Call relations**: This method is invoked through the shared backend interface whenever a caller wants one memory’s contents. It delegates to `read::read`, which relies on the backend’s path-safety behavior before reading from disk.

*Call graph*: calls 1 internal fn (read).


##### `LocalMemoriesBackend::search`  (lines 123–128)

```
async fn search(
        &self,
        request: SearchMemoriesRequest,
    ) -> Result<SearchMemoriesResponse, MemoriesBackendError>
```

**Purpose**: Accepts a request to search memories and forwards it to the search code. It gives callers a way to find matching memory files within the local memories folder.

**Data flow**: It receives a search request and passes it to the `search` module along with the backend. The search code examines allowed files and returns matching results, or reports an error if the requested search scope is invalid or inaccessible.

**Call relations**: This is the shared backend interface method for search. When a caller asks the local backend to search, this method hands off to `search::search`, which can use the backend’s scoped path and metadata helpers while walking the memory files.

*Call graph*: calls 1 internal fn (search).


### Memory workspace writing
Defines the write-side memory workspace layout and then handles synchronization, cleanup, and extension pruning for on-disk memory artifacts.

### `memories/write/src/lib.rs`

`orchestration` · `startup and cross-cutting memory write setup`

This file is like the signboard and floor plan for the memory write crate. The memory write system turns conversation history and other signals into durable “memories” that Codex can use later. Without this file, other parts of the program would not have one clear place to ask, “Where do memories live?” or “Which memory-writing functions are available to me?”

Most of the detailed work lives in submodules, such as startup processing, prompt building, storage, extension cleanup, and workspace diffing. This file pulls selected functions from those modules into the crate’s public interface, so callers do not need to know the internal folder layout.

It also defines shared constants for important artifact names: the `memories` directory, the `rollout_summaries` folder, the `extensions` folder, and the `raw_memories.md` file. These names matter because multiple phases must agree on the same disk layout. If one part wrote summaries in one place and another looked elsewhere, the memory pipeline would silently lose track of its inputs.

The small helper functions at the bottom build those paths consistently. `ensure_layout` creates the required summaries directory before the rest of the write pipeline expects to use it.

#### Function details

##### `memory_root`  (lines 116–118)

```
fn memory_root(codex_home: &AbsolutePathBuf) -> AbsolutePathBuf
```

**Purpose**: Builds the top-level folder path where Codex memory files live under the Codex home directory. Callers use it so every part of the system agrees that memories are stored in the same place.

**Data flow**: It receives the absolute path to the Codex home folder. It appends the folder name `memories` to that path. It returns the resulting absolute path without creating anything on disk.

**Call relations**: This is a basic path-building helper used when higher-level memory startup or storage code needs to locate the memory area. Its only handoff is to the path library’s `join` operation, which safely combines folder names.

*Call graph*: calls 1 internal fn (join).


##### `rollout_summaries_dir`  (lines 120–122)

```
fn rollout_summaries_dir(root: &Path) -> PathBuf
```

**Purpose**: Builds the path to the folder that stores rollout summary files, which are compact records used by the memory pipeline. It keeps the folder name centralized so callers do not hard-code it in different places.

**Data flow**: It receives a memory root path. It appends the standard `rollout_summaries` subfolder name. It returns that new path and does not touch the filesystem itself.

**Call relations**: This helper is called by `ensure_layout` when the crate needs to create the summaries folder. Other storage-related code can also use the same helper to read or write summaries in the agreed location.

*Call graph*: called by 1 (ensure_layout); 1 external calls (join).


##### `memory_extensions_root`  (lines 124–126)

```
fn memory_extensions_root(root: &Path) -> PathBuf
```

**Purpose**: Builds the path to the folder where optional memory extension inputs live. Extensions are extra memory sources with their own instructions, so the pipeline needs a predictable place to find them.

**Data flow**: It receives a memory root path. It appends the standard `extensions` subfolder name. It returns the resulting path without checking whether the folder exists.

**Call relations**: This helper supports the parts of the memory pipeline that read extension instructions or prune old extension resources. It simply prepares the path and leaves actual reading, writing, or cleanup to the extension-related modules.

*Call graph*: 1 external calls (join).


##### `raw_memories_file`  (lines 128–130)

```
fn raw_memories_file(root: &Path) -> PathBuf
```

**Purpose**: Builds the path to the main raw memory Markdown file. This gives storage code one shared answer for where the plain memory artifact should be written or rebuilt.

**Data flow**: It receives a memory root path. It appends the fixed filename `raw_memories.md`. It returns the full file path and does not open, read, or write the file.

**Call relations**: This helper is meant for storage and rebuild operations that need to locate the raw memories file. It only constructs the name; the actual file work is done by storage functions exported from other modules.

*Call graph*: 1 external calls (join).


##### `ensure_layout`  (lines 132–134)

```
async fn ensure_layout(root: &Path) -> std::io::Result<()>
```

**Purpose**: Creates the minimum folder structure the memory write system needs before it starts writing files. In this file, that means ensuring the rollout summaries directory exists.

**Data flow**: It receives the memory root path. It asks `rollout_summaries_dir` to build the correct summaries folder path, then asks the asynchronous filesystem layer to create that folder and any missing parent folders. It returns success if the folder is ready, or an input/output error if the filesystem operation fails.

**Call relations**: This function is part of startup preparation. It uses `rollout_summaries_dir` so it creates the same folder that the rest of the crate will later read from or write to, then hands off to `tokio::fs::create_dir_all`, an async disk operation that safely creates missing directories.

*Call graph*: calls 1 internal fn (rollout_summaries_dir); 1 external calls (create_dir_all).


### `memories/write/src/storage.rs`

`io_transport` · `memory persistence and sync`

This file is the bridge between structured memory data and the human-readable files stored in the memories folder. A “stage-1 output” is a saved result from an earlier memory-building step: it includes a thread id, timestamps, working directory, raw memory text, and a rollout summary. This file writes that information out as Markdown so people and later tools can inspect it.

There are two main jobs. The first rebuilds `raw_memories.md`, a single combined file containing the newest retained raw memories. The second syncs a folder of rollout summary files, one file per retained thread. “Retained” means only the first N memory records are used, where N is the configured maximum. Anything beyond that limit is ignored for these outputs.

Before writing, the public functions make sure the expected folder layout exists. When syncing rollout summaries, the code also removes old `.md` summary files that no longer match a retained memory. This is like cleaning a noticeboard before pinning up the current notices, so stale summaries do not linger.

A notable detail is how summary filenames are built. The file name starts with a timestamp-like fragment and a short hash, then may include a cleaned-up version of a rollout slug. This makes names stable, readable, and safe for filesystems.

#### Function details

##### `rebuild_raw_memories_file_from_memories`  (lines 13–20)

```
async fn rebuild_raw_memories_file_from_memories(
    root: &Path,
    memories: &[Stage1Output],
    max_raw_memories_for_consolidation: usize,
) -> std::io::Result<()>
```

**Purpose**: This is the public entry point for rebuilding the combined `raw_memories.md` file from memory records. It prepares the directory layout first, then delegates the actual file content creation to the internal writer.

**Data flow**: It receives a root folder, a list of stage-1 memory records, and a maximum number of records to include. It first ensures the memory storage folders and files are arranged correctly. Then it passes the same inputs onward to build and write the combined Markdown file, returning success or an input/output error.

**Call relations**: Callers use this when the on-disk raw memories file needs to reflect the database-backed memory records. It calls `ensure_layout` before handing the real writing work to `rebuild_raw_memories_file`, so the writer can assume the destination layout exists.

*Call graph*: calls 1 internal fn (rebuild_raw_memories_file); 1 external calls (ensure_layout).


##### `sync_rollout_summaries_from_memories`  (lines 23–42)

```
async fn sync_rollout_summaries_from_memories(
    root: &Path,
    memories: &[Stage1Output],
    max_raw_memories_for_consolidation: usize,
) -> std::io::Result<()>
```

**Purpose**: This is the public entry point for making the rollout summary files match the current memory records. It writes one summary file for each retained memory and removes outdated summary files that no longer belong.

**Data flow**: It receives a root folder, memory records, and a maximum count. It ensures the folder layout exists, keeps only the allowed slice of records, computes the filenames that should remain, deletes old `.md` summary files not in that set, then writes fresh summary files for the retained memories. It returns success or an input/output error.

**Call relations**: This function coordinates the whole rollout-summary sync. It uses `retained_memories` to decide what counts, `prune_rollout_summaries` to clear stale files, and `write_rollout_summary_for_thread` to write each current file.

*Call graph*: calls 3 internal fn (prune_rollout_summaries, retained_memories, write_rollout_summary_for_thread); 1 external calls (ensure_layout).


##### `rebuild_raw_memories_file`  (lines 44–78)

```
async fn rebuild_raw_memories_file(
    root: &Path,
    memories: &[Stage1Output],
    max_raw_memories_for_consolidation: usize,
) -> std::io::Result<()>
```

**Purpose**: This function builds the full text of `raw_memories.md` and writes it to disk. It is the actual worker behind the public rebuild function.

**Data flow**: It takes the root folder, memory records, and the maximum count. It chooses the retained records, creates a Markdown document starting with a title, writes a short empty-state message if there are no records, or otherwise adds a section for each retained thread with metadata and raw memory text. Finally it writes the finished string to the `raw_memories.md` path.

**Call relations**: It is called by `rebuild_raw_memories_file_from_memories` after the directory layout has been checked. It uses `retained_memories` to apply the configured limit and `raw_memories_file` to find the output path.

*Call graph*: calls 1 internal fn (retained_memories); called by 1 (rebuild_raw_memories_file_from_memories); 5 external calls (from, raw_memories_file, format!, write, writeln!).


##### `prune_rollout_summaries`  (lines 80–108)

```
async fn prune_rollout_summaries(root: &Path, keep: &HashSet<String>) -> std::io::Result<()>
```

**Purpose**: This function removes old rollout summary Markdown files that should no longer exist. It prevents stale summaries from being mistaken for current memory data.

**Data flow**: It receives the root folder and a set of filename stems to keep. It opens the rollout summaries directory, skips missing directories, scans each entry, and only considers files ending in `.md`. If a Markdown file’s stem is not in the keep set, it tries to delete it. Deletion failures are logged as warnings unless the file was already gone.

**Call relations**: It is called during `sync_rollout_summaries_from_memories`, before new summary files are written. That means the folder is cleaned against the current retained memory set before `write_rollout_summary_for_thread` repopulates it.

*Call graph*: called by 1 (sync_rollout_summaries_from_memories); 4 external calls (rollout_summaries_dir, read_dir, remove_file, warn!).


##### `write_rollout_summary_for_thread`  (lines 110–136)

```
async fn write_rollout_summary_for_thread(
    root: &Path,
    memory: &Stage1Output,
) -> std::io::Result<()>
```

**Purpose**: This function writes one rollout summary Markdown file for one memory record. The file contains useful identifying details followed by the summary text itself.

**Data flow**: It receives the root folder and one stage-1 memory record. It creates a stable filename stem from the memory, builds the full path inside the rollout summaries directory, formats metadata such as thread id, update time, rollout path, current working directory, and optional git branch, then appends the rollout summary body. It writes that complete text to disk.

**Call relations**: It is called once per retained memory by `sync_rollout_summaries_from_memories`. It relies on `rollout_summary_file_stem` to produce the safe, stable file name used for the summary.

*Call graph*: calls 1 internal fn (rollout_summary_file_stem); called by 1 (sync_rollout_summaries_from_memories); 5 external calls (new, rollout_summaries_dir, format!, write, writeln!).


##### `retained_memories`  (lines 138–143)

```
fn retained_memories(
    memories: &[Stage1Output],
    max_raw_memories_for_consolidation: usize,
) -> &[Stage1Output]
```

**Purpose**: This small helper applies the configured limit to the memory list. It decides which records are allowed to appear in generated files.

**Data flow**: It receives a slice of memory records and a maximum count. It returns a slice containing records from the front of the input, stopping at the maximum or at the end of the list if there are fewer records.

**Call relations**: Both major flows call this helper: `rebuild_raw_memories_file` uses it for the combined raw memory document, and `sync_rollout_summaries_from_memories` uses it for per-thread summary files. This keeps the retention rule consistent in both places.

*Call graph*: called by 2 (rebuild_raw_memories_file, sync_rollout_summaries_from_memories); 1 external calls (len).


##### `raw_memories_format_error`  (lines 145–147)

```
fn raw_memories_format_error(err: std::fmt::Error) -> std::io::Error
```

**Purpose**: This function converts a text-formatting failure into an input/output-style error with a message specific to raw memory file creation. It lets formatting problems travel through the same error path as file-writing problems.

**Data flow**: It receives a formatting error from building the Markdown string. It wraps that error in a new `std::io::Error` whose message says the raw memories formatting failed, and returns that new error.

**Call relations**: The raw memory writer uses this when calls that append formatted text to the Markdown body fail. It is part of the error-conversion path used while `rebuild_raw_memories_file` is preparing the file contents.

*Call graph*: 2 external calls (other, format!).


##### `rollout_summary_format_error`  (lines 149–151)

```
fn rollout_summary_format_error(err: std::fmt::Error) -> std::io::Error
```

**Purpose**: This function converts a text-formatting failure into an input/output-style error with a message specific to rollout summary creation. It keeps summary formatting failures understandable to callers.

**Data flow**: It receives a formatting error from constructing a rollout summary file. It turns that into a new `std::io::Error` that explains the failure happened while formatting a rollout summary.

**Call relations**: The per-thread summary writer uses this while building Markdown metadata. It supports `write_rollout_summary_for_thread` by making formatting errors fit the same result type as disk-write errors.

*Call graph*: 2 external calls (other, format!).


##### `rollout_summary_file_stem`  (lines 153–159)

```
fn rollout_summary_file_stem(memory: &Stage1Output) -> String
```

**Purpose**: This function creates the filename stem for a rollout summary from a full memory record. A filename stem is the filename without the `.md` ending.

**Data flow**: It receives one stage-1 memory record. It extracts the thread id, update timestamp, and optional rollout slug, then passes those pieces to the lower-level filename builder. It returns the generated stem as a string.

**Call relations**: It is called by `write_rollout_summary_for_thread` when deciding where to write a summary file. It delegates the detailed naming rules to `rollout_summary_file_stem_from_parts`.

*Call graph*: calls 1 internal fn (rollout_summary_file_stem_from_parts); called by 1 (write_rollout_summary_for_thread).


##### `rollout_summary_file_stem_from_parts`  (lines 161–238)

```
fn rollout_summary_file_stem_from_parts(
    thread_id: codex_protocol::ThreadId,
    source_updated_at: chrono::DateTime<chrono::Utc>,
    rollout_slug: Option<&str>,
) -> String
```

**Purpose**: This function builds a stable, readable, filesystem-safe filename stem from a thread id, timestamp, and optional rollout slug. It helps summary files have names that are both meaningful to humans and unlikely to collide.

**Data flow**: It receives a thread id, a fallback update timestamp, and an optional rollout slug. If the thread id is a UUID, it tries to use the UUID’s embedded timestamp and part of the UUID as a short hash seed; otherwise it uses the supplied timestamp and computes a simple hash from the thread id text. It turns the hash into four compact characters, combines it with the timestamp, then cleans the slug by lowercasing letters and replacing unsafe characters with underscores. The result is a filename stem like a dated label with a short unique tag and optional readable suffix.

**Call relations**: It is the detailed naming engine behind `rollout_summary_file_stem`. That higher-level helper supplies values from a memory record, while this function applies the exact rules for timestamps, short hashes, slug cleanup, and length limiting.

*Call graph*: called by 1 (rollout_summary_file_stem); 7 external calls (format, with_capacity, parse_str, format!, bytes, to_string, from).


### `memories/write/src/control.rs`

`domain_logic` · `memory cleanup`

This file is a small safety-focused cleanup tool for the memory-writing part of the system. Its job is to empty the memory storage areas, like clearing the contents of a filing cabinet without throwing away the cabinet itself. The public function targets two known folders under the Codex home directory: `memories` and `memories_extensions`.

The important detail is that the code does not blindly delete paths. Before clearing a memory root, it asks the operating system for information about that path. If the path is a symbolic link, meaning a shortcut that points somewhere else, the code refuses to continue. This prevents a serious accident: deleting files in an unexpected outside location just because the memory folder pointed there.

If the folder does not exist, the code creates it. Then it reads every item directly inside the folder. Subfolders are removed with all their contents, while files are removed one by one. At the end, the root folder still exists but is empty.

The tests check both promises: clearing leaves the root directory present and empty, and a symlinked root is rejected without deleting the real target.

#### Function details

##### `clear_memory_roots_contents`  (lines 3–12)

```
async fn clear_memory_roots_contents(codex_home: &Path) -> std::io::Result<()>
```

**Purpose**: This is the public cleanup function for all standard memory storage locations under a Codex home directory. Someone would use it when they want to reset stored memory contents without removing the memory folders themselves.

**Data flow**: It receives the path to the Codex home directory. From that, it builds two child paths: `memories` and `memories_extensions`. It then asks `clear_memory_root_contents` to empty each one. If either cleanup fails, the error is returned; otherwise it finishes successfully with no value beyond success.

**Call relations**: This function is the higher-level caller. It does not do the deletion itself; instead, it names the two memory roots and hands each one to `clear_memory_root_contents`, which performs the careful filesystem work.

*Call graph*: calls 1 internal fn (clear_memory_root_contents); 1 external calls (join).


##### `clear_memory_root_contents`  (lines 14–44)

```
async fn clear_memory_root_contents(memory_root: &Path) -> std::io::Result<()>
```

**Purpose**: This function empties one memory root directory while preserving the directory itself. It also refuses to operate if that root is a symbolic link, which protects files outside the intended memory area from being deleted by mistake.

**Data flow**: It receives one directory path. First it checks what that path is. If it is a symbolic link, it returns an `InvalidInput` error. If the path is missing, that is allowed. Next it creates the directory if needed. Then it reads each item inside it: directories are deleted recursively, and regular files or other non-directory entries are removed as files. The result is an existing, empty root directory, or an error if the filesystem operation fails.

**Call relations**: This is the core worker used by `clear_memory_roots_contents` for each standard memory folder. The tests also call it directly: one test confirms the root survives and becomes empty, and another confirms a symlinked root is rejected before anything outside the root can be deleted.

*Call graph*: called by 3 (clear_memory_roots_contents, clear_memory_root_contents_preserves_root_directory, clear_memory_root_contents_rejects_symlinked_root); 7 external calls (new, format!, create_dir_all, read_dir, remove_dir_all, remove_file, symlink_metadata).


##### `tests::clear_memory_root_contents_preserves_root_directory`  (lines 52–87)

```
async fn clear_memory_root_contents_preserves_root_directory()
```

**Purpose**: This test proves that clearing a memory root removes its contents but does not delete the root folder itself. That matters because later code may expect the folder to still exist.

**Data flow**: It creates a temporary directory, then builds a fake memory root with a nested folder and two stale files. It calls `clear_memory_root_contents` on that root. Afterward, it checks that the root directory still exists and that reading it finds no remaining entries.

**Call relations**: This test exercises the normal successful path through `clear_memory_root_contents`. It sets up realistic contents, asks the cleanup function to run, and verifies the promised before-and-after behavior.

*Call graph*: calls 1 internal fn (clear_memory_root_contents); 5 external calls (assert!, tempdir, create_dir_all, read_dir, write).


##### `tests::clear_memory_root_contents_rejects_symlinked_root`  (lines 91–115)

```
async fn clear_memory_root_contents_rejects_symlinked_root()
```

**Purpose**: This Unix-only test proves that the cleanup function refuses to clear a memory root that is actually a symbolic link. The goal is to prevent accidental deletion of files in some outside target directory.

**Data flow**: It creates a temporary outside directory with a file that should be kept. Then it creates a symbolic link named like the memory root pointing to that outside directory. It calls `clear_memory_root_contents` and expects an `InvalidInput` error. Finally, it checks that the outside file still exists.

**Call relations**: This test exercises the safety branch inside `clear_memory_root_contents`. It confirms that the function stops before deletion when the root path is a symlink, preserving the linked target.

*Call graph*: calls 1 internal fn (clear_memory_root_contents); 6 external calls (assert!, assert_eq!, symlink, tempdir, create_dir_all, write).


### `memories/write/src/extensions/prune.rs`

`domain_logic` · `maintenance cleanup`

Memory extensions can have a `resources` folder containing Markdown files. Those files appear to be named with a timestamp at the start, like a date label on a box in storage. This file periodically looks through those boxes and throws away the ones that are too old.

The cleanup starts from a memory root folder, finds the extensions area, and scans each extension directory. It only treats a directory as a real extension if it contains an `instructions.md` file. Inside each valid extension, it looks for a `resources` folder, then checks each file in that folder. Only regular files ending in `.md` are considered. For each one, it reads the timestamp from the first part of the filename and compares it with a cutoff date based on `RETENTION_DAYS`. If the timestamp is at or before the cutoff, the file is deleted.

The code is deliberately cautious. Missing folders are treated as normal and ignored. Files that cannot be understood are skipped. If a directory cannot be read or an old file cannot be deleted, it logs a warning instead of stopping the whole cleanup. This matters because pruning is housekeeping: it should reduce clutter without risking the rest of the system failing just because one file is odd or temporarily unavailable.

#### Function details

##### `prune_old_extension_resources`  (lines 9–11)

```
async fn prune_old_extension_resources(memory_root: &Path)
```

**Purpose**: This is the public cleanup function callers use when they want to remove expired extension resource files. It uses the current time as the reference point for deciding what is old.

**Data flow**: It receives the root folder for memories. It reads the current UTC time, then passes both the folder and that time into the more detailed pruning function. It does not return a value; its effect is that old resource files may be removed from disk.

**Call relations**: This function is the simple front door for pruning. When another part of the system wants normal cleanup behavior, it calls this function, which supplies the current time and hands the real work to `prune_old_extension_resources_with_now`.

*Call graph*: calls 1 internal fn (prune_old_extension_resources_with_now); 1 external calls (now).


##### `prune_old_extension_resources_with_now`  (lines 13–88)

```
async fn prune_old_extension_resources_with_now(memory_root: &Path, now: DateTime<Utc>)
```

**Purpose**: This function does the actual pruning work. It scans extension resource folders, identifies timestamped Markdown files that are older than the allowed retention period, and deletes them.

**Data flow**: It receives a memory root folder and a specific 'now' time. From that, it calculates a cutoff date, finds the extensions directory, walks through extension folders, checks for `instructions.md`, opens each `resources` folder, filters for Markdown files, extracts each file's timestamp, and removes files whose timestamp is too old. It changes the filesystem by deleting expired files, and it logs warnings when it cannot read or remove something important.

**Call relations**: The public `prune_old_extension_resources` function calls this after choosing the current time. During the scan, this function asks `memory_extensions_root` where extension data lives, uses filesystem calls to read directories and delete files, and calls `resource_timestamp` whenever it needs to turn a resource filename into a date it can compare.

*Call graph*: calls 1 internal fn (resource_timestamp); called by 1 (prune_old_extension_resources); 6 external calls (days, memory_extensions_root, read_dir, remove_file, try_exists, warn!).


##### `resource_timestamp`  (lines 90–96)

```
fn resource_timestamp(file_name: &str) -> Option<DateTime<Utc>>
```

**Purpose**: This helper reads the timestamp embedded at the start of a resource filename. It turns that filename prefix into a UTC date and time so the pruning code can decide whether the file is expired.

**Data flow**: It receives a filename as text. It takes the first 19 characters, tries to parse them using the expected timestamp format, and wraps the result as a UTC time. If the filename is too short or the timestamp does not match the expected format, it returns nothing.

**Call relations**: `prune_old_extension_resources_with_now` calls this for each candidate Markdown resource file. If this helper returns a timestamp, the pruning function compares it to the cutoff date; if it returns nothing, the file is skipped because its age cannot be trusted.

*Call graph*: called by 1 (prune_old_extension_resources_with_now); 2 external calls (from_naive_utc_and_offset, parse_from_str).
