# Plugins, extensions, skills, MCP, and tools tests  `stage-23.6.3`

This stage is the test safety net for Codex’s add-on system. It covers the parts that let Codex find extra abilities, load them safely, show them to users, and turn them into tools the model can call. The plugin tests build fake home folders, marketplaces, caches, and executor file systems, then check discovery, loading, storage, curated startup syncing, remote sharing, app routing, mentions, rendering, and install requests. The skills tests do the same for skill folders: they check selection by user input, loading from user, project, plugin, and system locations, caching, enable rules, and safe executor-owned file access. The extension tests protect the public extension interface and specific extensions such as goals, image generation, and memories. The MCP tests cover Model Context Protocol, a standard way for Codex to talk to external tool servers, including configuration, catalogs, connection caching, hosted apps, executor plugins, and real client/server calls. The tool tests make sure tool definitions, schemas, search text, code-mode forms, and API JSON stay stable. Together, these tests keep the add-on “plugboard” predictable and safe.

## Files in this stage

### Plugin test foundations
These files establish shared fixtures and validate the low-level plugin loading, storage, provider, and marketplace primitives that higher-level plugin flows build on.

### `core-plugins/src/test_support.rs`

`test` · `test setup and config load`

Tests for the plugin system need small, realistic plugin installations without depending on the real network, a real marketplace, or a user's actual files. This file builds that pretend world on disk. It writes plugin metadata, sample skill files, MCP server settings, and app connector settings into temporary folders so tests can exercise the same file-reading paths that production code uses. Think of it like a stage crew setting up props before a scene: the props are fake, but they are placed exactly where the actors expect them.

It also writes marketplace manifests. A marketplace manifest is a JSON file that says, “these plugins are available here.” The helpers can create both the regular OpenAI curated marketplace and the API-flavored curated marketplace, using shared code so their structure stays consistent.

Finally, the file includes a configuration loader for tests. It asks the normal config-loading machinery to read layers from a test Codex home and working directory, but disables managed configuration that would make tests harder to control. It then turns feature flags, such as whether plugins are enabled, into a `PluginsConfigInput` object used by the plugin code under test. Without this file, many tests would need to repeat brittle setup code and would be more likely to depend on real user state.

#### Function details

##### `write_file`  (lines 17–20)

```
fn write_file(path: &Path, contents: &str)
```

**Purpose**: Writes text to a file for test setup, creating the parent folders first if they do not already exist. This lets tests describe files they need without separately building the directory tree.

**Data flow**: It receives a file path and the text to put there. It finds the file's parent folder, creates that folder and any missing folders above it, then writes the text into the file. The result is a real file on disk with the requested contents; if something goes wrong, the test stops immediately.

**Call relations**: The higher-level test helpers rely on this as their basic writing tool. `write_curated_plugin`, `write_curated_marketplace`, and `write_curated_plugin_sha_with` all call it when they need to place plugin metadata, marketplace manifests, or cache marker files on disk.

*Call graph*: called by 3 (write_curated_marketplace, write_curated_plugin, write_curated_plugin_sha_with); 3 external calls (parent, create_dir_all, write).


##### `write_curated_plugin`  (lines 22–58)

```
fn write_curated_plugin(root: &Path, plugin_name: &str)
```

**Purpose**: Creates a complete sample curated plugin folder for tests. The plugin includes a manifest, one skill, one MCP server entry, and one app connector entry so tests can verify all of those plugin features are discovered.

**Data flow**: It receives a root folder and a plugin name. From those, it builds a plugin directory under `plugins/<plugin_name>`, then writes several expected files inside it: `.codex-plugin/plugin.json`, `skills/SKILL.md`, `.mcp.json`, and `.app.json`. After it runs, the test directory looks like it contains an installed plugin with representative content.

**Call relations**: This function is called by `write_curated_marketplace` after the marketplace manifest has named the plugins. It uses `write_file` for each file it creates, so the lower-level folder creation and writing behavior stays in one place.

*Call graph*: calls 1 internal fn (write_file); called by 1 (write_curated_marketplace); 2 external calls (join, format!).


##### `write_openai_curated_marketplace`  (lines 60–68)

```
fn write_openai_curated_marketplace(root: &Path, plugin_names: &[&str])
```

**Purpose**: Creates a test version of the regular OpenAI curated marketplace. Tests use it when they need the standard marketplace name and file layout.

**Data flow**: It receives a root folder and a list of plugin names. It passes those values, along with the regular marketplace filename and marketplace name, into the shared marketplace-writing helper. The result is a marketplace manifest plus matching fake plugin folders.

**Call relations**: This is a convenience wrapper around `write_curated_marketplace`. It hides the exact manifest filename and marketplace name so tests can say what they mean at a higher level.

*Call graph*: calls 1 internal fn (write_curated_marketplace).


##### `write_openai_api_curated_marketplace`  (lines 70–78)

```
fn write_openai_api_curated_marketplace(root: &Path, plugin_names: &[&str])
```

**Purpose**: Creates a test version of the API curated marketplace. This is used for tests that need the API marketplace identity and its display name.

**Data flow**: It receives a root folder and a list of plugin names. It calls the shared marketplace writer with the API marketplace filename, API marketplace name, and display label `OpenAI Curated`. The result is a correctly shaped API marketplace manifest and fake plugin folders for each listed plugin.

**Call relations**: This wrapper feeds specific API-curated settings into `write_curated_marketplace`. Tests such as API fallback and cache refresh scenarios call it when they need that exact marketplace flavor.

*Call graph*: calls 1 internal fn (write_curated_marketplace); called by 2 (returns_api_curated_fallback_plugins_for_direct_provider_auth, refresh_curated_plugin_cache_reinstalls_missing_api_curated_plugin).


##### `write_curated_marketplace`  (lines 80–126)

```
fn write_curated_marketplace(
    root: &Path,
    manifest_name: &str,
    marketplace_name: &str,
    display_name: Option<&str>,
    plugin_names: &[&str],
)
```

**Purpose**: Writes a curated marketplace manifest and creates all plugins named in it. A marketplace manifest is the file that tells the plugin system which plugins exist and where to find them.

**Data flow**: It receives a root folder, manifest filename, marketplace name, optional display name, and a list of plugin names. It turns the plugin list into JSON entries pointing to local plugin folders, optionally adds an interface display name, writes the manifest under `.agents/plugins`, and then creates each matching plugin folder. Afterward, tests have both the catalog and the plugin contents it refers to.

**Call relations**: The two public marketplace helpers, `write_openai_curated_marketplace` and `write_openai_api_curated_marketplace`, call this shared function with different marketplace identities. It calls `write_file` to place the manifest and `write_curated_plugin` to create each listed plugin, keeping the manifest and filesystem in sync.

*Call graph*: calls 2 internal fn (write_curated_plugin, write_file); called by 2 (write_openai_api_curated_marketplace, write_openai_curated_marketplace); 2 external calls (join, format!).


##### `write_curated_plugin_sha_with`  (lines 128–130)

```
fn write_curated_plugin_sha_with(codex_home: &Path, sha: &str)
```

**Purpose**: Writes a fake curated-plugin SHA marker into the test Codex home. A SHA is a checksum-like identifier often used to say which version of cached content is present.

**Data flow**: It receives a Codex home folder and a SHA string. It writes that string, followed by a newline, to `.tmp/plugins.sha` inside the Codex home. The visible result is a cache marker file that tests can use to simulate a known plugin cache version.

**Call relations**: This helper uses `write_file` for the actual disk write. Tests can call it when they need the plugin cache to appear up to date, stale, or otherwise tied to a specific recorded SHA.

*Call graph*: calls 1 internal fn (write_file); 2 external calls (join, format!).


##### `load_plugins_config`  (lines 132–156)

```
async fn load_plugins_config(codex_home: &Path, cwd: &Path) -> PluginsConfigInput
```

**Purpose**: Loads plugin configuration for tests using the real configuration loader, but with test-safe overrides. It produces the `PluginsConfigInput` object that plugin code expects.

**Data flow**: It receives a Codex home path and a current working directory path. It first converts both to absolute paths, then asks the config loader to read the configuration layers from the local filesystem while disabling managed config for tests. From the effective combined config, it reads feature flags for `plugins` and `remote_plugin`, applies defaults when those flags are missing, and builds a `PluginsConfigInput` with a fixed backend API URL. The output is a ready-to-use plugin configuration for test code.

**Call relations**: This function sits between raw test folders and the plugin code under test. It calls the normal `load_config_layers_state` path so tests stay close to production behavior, uses `feature_enabled` to interpret feature switches, and then hands the resulting values into `PluginsConfigInput::new`.

*Call graph*: calls 5 internal fn (load_config_layers_state, without_managed_config_for_tests, new, feature_enabled, try_from); 1 external calls (as_path).


##### `feature_enabled`  (lines 158–165)

```
fn feature_enabled(config: &Value, key: &str, default_enabled: bool) -> bool
```

**Purpose**: Reads one boolean feature flag from a TOML configuration value. If the flag is missing or not written as a true/false value, it falls back to a caller-provided default.

**Data flow**: It receives the full config value, the feature name to look for, and a default boolean. It looks under the `features` table, checks the requested key, and accepts it only if it is a boolean. It returns either the found boolean or the default value.

**Call relations**: This is a small helper used by `load_plugins_config` when building test plugin configuration. It keeps the feature-flag reading rules in one place so `load_plugins_config` can focus on assembling the final plugin config object.

*Call graph*: called by 1 (load_plugins_config); 1 external calls (get).


### `plugin/src/provider_tests.rs`

`test` · `test run`

A plugin manifest is like a table of contents for a plugin: it names files such as skills, app definitions, hook definitions, icons, logos, and screenshots. In this system, those files may live inside a specific execution environment, so plain file paths are not enough. They need to be tied to the environment they came from, like labeling every borrowed tool with the workshop it belongs to.

This test file checks that behavior. The first test builds a fake plugin manifest with several resource paths under a plugin root folder. It then asks `ResolvedPlugin::from_environment` to turn that manifest into a resolved plugin. The expected result is that every resource path is converted into a `PluginResourceLocator::Environment`, which carries both the environment id and the original path.

The second test checks the safety rule. If the manifest points to a file outside the plugin's root folder, the plugin should not be accepted. That matters because a plugin should not be able to quietly refer to unrelated files elsewhere on the machine. The test confirms that the code returns the specific `ResourceOutsideRoot` error, including both the allowed root and the bad path.

#### Function details

##### `absolute`  (lines 11–13)

```
fn absolute(path: impl AsRef<std::path::Path>) -> AbsolutePathBuf
```

**Purpose**: This small test helper turns a path into an `AbsolutePathBuf`, which is this project’s type for paths that must be absolute rather than relative. It keeps the tests concise and makes failures clear if a supposedly absolute test path is not actually absolute.

**Data flow**: It receives something path-like, reads it as a standard path, and passes it to the checked absolute-path constructor. If the path is valid and absolute, it returns an `AbsolutePathBuf`; if not, the test stops with the message `absolute test path`.

**Call relations**: Both test cases call this helper while building their fake plugin folders and resource paths. It hands clean absolute paths to `ResolvedPlugin::from_environment`, so the tests focus on plugin resolution behavior rather than path conversion details.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); called by 2 (environment_descriptor_binds_every_manifest_resource, environment_descriptor_rejects_resources_outside_package_root); 1 external calls (as_ref).


##### `resource`  (lines 15–20)

```
fn resource(environment_id: &str, path: AbsolutePathBuf) -> PluginResourceLocator
```

**Purpose**: This helper builds the expected form of a resolved plugin resource: a path labeled with the environment id it belongs to. It makes the test expectations easier to read.

**Data flow**: It receives an environment id as text and an absolute path. It copies the environment id into an owned string, pairs it with the path, and returns a `PluginResourceLocator::Environment` value.

**Call relations**: The main binding test uses this helper when writing the expected resolved manifest. It mirrors what `ResolvedPlugin::from_environment` is supposed to produce for every manifest resource.


##### `environment_descriptor_binds_every_manifest_resource`  (lines 23–89)

```
fn environment_descriptor_binds_every_manifest_resource()
```

**Purpose**: This test proves that every resource path listed in a plugin manifest gets tied to the environment that provides it. Without this, later code might know a file path but not know which execution environment should be used to access it.

**Data flow**: It starts by creating absolute paths for a fake plugin root, manifest file, skills folder, server config, app config, hooks file, and interface images. It puts those paths into a `PluginManifest`, then calls `ResolvedPlugin::from_environment` with a selected plugin id, an executor environment id, the root path, the manifest path, and the manifest. The result is compared with the expected plugin: the manifest path and every resource inside the manifest should now be wrapped as environment resources using `executor-1`.

**Call relations**: During the test, `absolute` prepares the paths and `resource` builds the expected environment-labeled resources. The test then relies on `ResolvedPlugin::from_environment` to do the real resolving work, and uses equality assertions to confirm that the resolver touched every relevant manifest field, including nested hook and interface paths.

*Call graph*: calls 3 internal fn (default, from_environment, absolute); 5 external calls (new, assert_eq!, Paths, current_dir, vec!).


##### `environment_descriptor_rejects_resources_outside_package_root`  (lines 92–126)

```
fn environment_descriptor_rejects_resources_outside_package_root()
```

**Purpose**: This test proves that a plugin manifest is not allowed to point at resources outside its own plugin folder. That protects the system from plugins accidentally or deliberately reaching into unrelated parts of the filesystem.

**Data flow**: It gets the current working directory, builds one absolute path for the plugin root, and another absolute path for a resource outside that root. It creates a manifest whose MCP server config points to the outside file. Then it calls `ResolvedPlugin::from_environment` and expects failure. The final assertion checks that the returned error is exactly `ResourceOutsideRoot`, carrying the plugin root and the rejected outside path.

**Call relations**: This test uses `absolute` to prepare the root and outside paths, then asks `ResolvedPlugin::from_environment` to validate the manifest. Instead of checking a resolved plugin, it checks the error path, making sure the resolver stops as soon as it finds a resource that escapes the plugin package boundary.

*Call graph*: calls 2 internal fn (from_environment, absolute); 3 external calls (new, assert_eq!, current_dir).


### `core-plugins/src/provider_tests.rs`

`test` · `test run`

A plugin is a folder with a manifest file that describes what the plugin offers. This test file checks the rules for finding that manifest when the plugin lives inside an execution environment, rather than simply on the computer running the tests. That distinction matters because using the host file system by accident could make missing or remote environments look valid when they are not.

The file builds a small fake file system, `SyntheticPluginFileSystem`, that only pretends two things exist: the plugin root folder and its manifest file. It records each metadata check and file read, like a security camera watching which shelves a librarian visits. This lets the tests prove that plugin resolution used the supplied executor file system, not the normal local disk.

The remaining tests cover important edge cases. A plain folder without a plugin manifest should not be treated as a plugin. A missing environment should fail instead of falling back to the host machine. If the preferred manifest location exists but contains broken JSON, resolution should stop with that parse error rather than silently trying another manifest path. Finally, executor paths must be explicit absolute paths; shortcuts such as `~/plugins/demo` are rejected because the executor cannot safely guess what they mean.

#### Function details

##### `SyntheticPluginFileSystem::unsupported`  (lines 57–62)

```
fn unsupported() -> FileSystemResult<T>
```

**Purpose**: Returns a standard “unsupported operation” error for fake file-system actions that these tests do not expect plugin resolution to use. It keeps the fake file system small and makes any unexpected operation fail clearly.

**Data flow**: It takes no meaningful input. It creates an input/output error marked as unsupported, with a message explaining that the operation is not used by plugin resolution, and returns that error instead of a value.

**Call relations**: The fake file-system methods that are outside the test’s focus hand off to this helper. If plugin resolution ever calls one of those unused methods, the test will receive this clear failure rather than silently doing something misleading.

*Call graph*: 1 external calls (new).


##### `SyntheticPluginFileSystem::canonicalize`  (lines 66–72)

```
fn canonicalize(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, PathUri>
```

**Purpose**: Rejects path canonicalization in the fake file system. Canonicalization means turning a path into its official cleaned-up form, but these tests do not need that behavior.

**Data flow**: It receives a path and optional sandbox context, ignores them, and returns an asynchronous failure from `SyntheticPluginFileSystem::unsupported`. Nothing is recorded or changed.

**Call relations**: This is part of the executor file-system interface that the fake must implement. It exists so the fake can be passed anywhere an executor file system is required, while still proving that plugin resolution does not rely on this operation in the tested path.

*Call graph*: 2 external calls (pin, unsupported).


##### `SyntheticPluginFileSystem::read_file`  (lines 74–91)

```
fn read_file(
        &'a self,
        path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>>
```

**Purpose**: Pretends to read a file from the executor file system, but only succeeds for the plugin manifest. It also records the read so the test can verify exactly what plugin resolution looked at.

**Data flow**: It receives a path, converts it to an absolute path, and stores a `Read` record in the fake file system’s shared call log. If the path is the expected manifest path, it returns the manifest text as bytes; otherwise it returns a “not found” error.

**Call relations**: When `resolve_plugin_root` is tested with this fake file system, this method is the only way the resolver can obtain manifest contents. Its call log is later checked by `plugin_root_resolution_uses_supplied_executor_file_system` to confirm the resolver read the executor manifest and nothing else.

*Call graph*: calls 1 internal fn (to_abs_path); 4 external calls (pin, new, Read, clone).


##### `SyntheticPluginFileSystem::read_file_stream`  (lines 93–99)

```
fn read_file_stream(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream>
```

**Purpose**: Rejects streaming file reads in the fake file system. Streaming means reading a file in chunks, which plugin resolution does not need in these tests.

**Data flow**: It receives a path and optional sandbox context, ignores them, and returns an asynchronous unsupported-operation error. It does not alter the fake file system’s call log.

**Call relations**: This fills out the executor file-system interface. If the resolver unexpectedly tried to stream the manifest instead of reading it normally, this method would make the test fail clearly.

*Call graph*: 2 external calls (pin, unsupported).


##### `SyntheticPluginFileSystem::write_file`  (lines 101–108)

```
fn write_file(
        &'a self,
        _path: &'a PathUri,
        _contents: Vec<u8>,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>
```

**Purpose**: Rejects file writes in the fake file system. Plugin resolution should only inspect plugin files, not modify them.

**Data flow**: It receives a path, file contents, and optional sandbox context, ignores all of them, and returns an asynchronous unsupported-operation error. No files are written and no state changes.

**Call relations**: This method is present because the fake implements the full executor file-system interface. Its failure protects the test from accidentally allowing plugin resolution to write during what should be a read-only lookup.

*Call graph*: 2 external calls (pin, unsupported).


##### `SyntheticPluginFileSystem::create_directory`  (lines 110–117)

```
fn create_directory(
        &'a self,
        _path: &'a PathUri,
        _options: CreateDirectoryOptions,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'
```

**Purpose**: Rejects directory creation in the fake file system. Looking up a plugin should not create folders.

**Data flow**: It receives a path, directory-creation options, and optional sandbox context, ignores them, and returns an asynchronous unsupported-operation error. The fake file system remains unchanged.

**Call relations**: This unused interface method acts as a guardrail. If plugin resolution ever tried to prepare or repair plugin folders during these tests, this method would expose that unexpected behavior.

*Call graph*: 2 external calls (pin, unsupported).


##### `SyntheticPluginFileSystem::get_metadata`  (lines 119–146)

```
fn get_metadata(
        &'a self,
        path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>
```

**Purpose**: Answers the question “does this path exist, and is it a file or folder?” for the fake plugin root and manifest. It records each check so the test can confirm the resolver’s exact sequence of file-system questions.

**Data flow**: It receives a path, converts it to an absolute path, and appends a `Metadata` record to the shared call log. If the path is the plugin root, it returns metadata saying it is a directory; if it is the manifest path, it returns metadata saying it is a file; any other path produces a “not found” error.

**Call relations**: Plugin resolution uses metadata checks before reading the manifest. `plugin_root_resolution_uses_supplied_executor_file_system` later checks these recorded calls to prove the resolver first recognized the root as a directory, then recognized the manifest as a file, then read it.

*Call graph*: calls 1 internal fn (to_abs_path); 4 external calls (pin, new, Metadata, clone).


##### `SyntheticPluginFileSystem::read_directory`  (lines 148–154)

```
fn read_directory(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>>
```

**Purpose**: Rejects directory listing in the fake file system. These tests expect plugin resolution to check known manifest paths, not scan whole folders.

**Data flow**: It receives a path and optional sandbox context, ignores them, and returns an asynchronous unsupported-operation error. It does not return any directory entries.

**Call relations**: This method is part of the executor file-system interface. If the resolver changed to discover plugins by listing directories, this fake would fail and draw attention to that changed behavior.

*Call graph*: 2 external calls (pin, unsupported).


##### `SyntheticPluginFileSystem::remove`  (lines 156–163)

```
fn remove(
        &'a self,
        _path: &'a PathUri,
        _options: RemoveOptions,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>
```

**Purpose**: Rejects file or directory removal in the fake file system. Resolving a plugin should never delete anything.

**Data flow**: It receives a path, removal options, and optional sandbox context, ignores them, and returns an asynchronous unsupported-operation error. No fake or real files are removed.

**Call relations**: This is a safety-oriented part of the fake interface. It ensures a lookup-only test cannot accidentally permit destructive behavior.

*Call graph*: 2 external calls (pin, unsupported).


##### `SyntheticPluginFileSystem::copy`  (lines 165–173)

```
fn copy(
        &'a self,
        _source_path: &'a PathUri,
        _destination_path: &'a PathUri,
        _options: CopyOptions,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> Ex
```

**Purpose**: Rejects file copying in the fake file system. Plugin resolution should read metadata and manifest contents, not duplicate files.

**Data flow**: It receives source and destination paths, copy options, and optional sandbox context, ignores them, and returns an asynchronous unsupported-operation error. No data is copied.

**Call relations**: This completes the executor file-system interface for the fake. If plugin resolution ever attempted copying as part of lookup, the test would fail immediately through this method.

*Call graph*: 2 external calls (pin, unsupported).


##### `write_manifest`  (lines 176–181)

```
fn write_manifest(plugin_root: &Path, relative_path: &str, contents: &str)
```

**Purpose**: Creates a plugin manifest file on the real temporary test disk. Tests use it when they need realistic local files to exist.

**Data flow**: It receives a plugin root folder, a relative manifest path, and the manifest text. It joins the root and relative path, creates any missing parent directories, then writes the contents to that manifest file. Its output is the side effect of a file existing on disk.

**Call relations**: The tests for missing environments and malformed preferred manifests call this helper to set up their temporary folders. It keeps setup short so each test can focus on the behavior it is checking.

*Call graph*: called by 2 (malformed_preferred_manifest_does_not_fall_through_to_alternate, unavailable_environment_does_not_fall_back_to_host_filesystem); 3 external calls (join, create_dir_all, write).


##### `selected_root`  (lines 183–191)

```
fn selected_root(id: &str, environment_id: &str, path: &Path) -> SelectedCapabilityRoot
```

**Purpose**: Builds a `SelectedCapabilityRoot`, which is the test object saying “this chosen root lives in this environment at this path.” It avoids repeating the same setup code in every test.

**Data flow**: It receives a root id, an environment id, and a file-system path. It turns the path into text and returns a selected root whose location points to that environment path.

**Call relations**: Most tests call this helper before asking the plugin provider or resolver to resolve a root. It supplies the common input shape needed by plugin resolution while letting each test vary only the id, environment, or path.

*Call graph*: called by 4 (malformed_preferred_manifest_does_not_fall_through_to_alternate, plugin_root_resolution_uses_supplied_executor_file_system, standalone_capability_root_is_not_a_plugin, unavailable_environment_does_not_fall_back_to_host_filesystem); 1 external calls (to_string_lossy).


##### `plugin_root_resolution_uses_supplied_executor_file_system`  (lines 194–244)

```
async fn plugin_root_resolution_uses_supplied_executor_file_system()
```

**Purpose**: Tests that plugin resolution uses the provided executor file system instead of the host disk. This is important for plugins that exist only inside an execution environment.

**Data flow**: It creates a temporary path but deliberately does not create that plugin folder on the real disk. It builds a fake executor file system that says the folder and manifest exist, parses the expected manifest for comparison, then calls plugin root resolution. The test expects a resolved plugin and expects the fake file system’s call log to show a metadata check on the root, a metadata check on the manifest, and a read of the manifest.

**Call relations**: This test calls `selected_root` to describe the environment root, then sends that and the fake file system into `resolve_plugin_root`. The fake’s `get_metadata` and `read_file` methods provide the only successful file-system answers, and the final assertions prove those methods were used in the intended order.

*Call graph*: calls 3 internal fn (parse_plugin_manifest, selected_root, from_absolute_path_checked); 6 external calls (new, new, assert!, assert_eq!, resolve_plugin_root, tempdir).


##### `standalone_capability_root_is_not_a_plugin`  (lines 247–263)

```
async fn standalone_capability_root_is_not_a_plugin()
```

**Purpose**: Tests that an ordinary folder is not mistaken for a plugin. A folder should only become a plugin root when the expected plugin manifest is present.

**Data flow**: It creates a temporary standalone folder on disk, creates a plugin provider with the default test environment manager, and asks the provider to resolve that folder. The expected result is `None`, meaning “this is not a plugin,” rather than an error or a fake plugin description.

**Call relations**: The test builds its selected root with `selected_root` and calls `ExecutorPluginProvider::resolve`. It checks the provider’s normal local test environment path, making sure the broader provider flow correctly distinguishes standalone capability roots from plugin roots.

*Call graph*: calls 3 internal fn (new, selected_root, default_for_tests); 4 external calls (new, assert_eq!, create_dir_all, tempdir).


##### `unavailable_environment_does_not_fall_back_to_host_filesystem`  (lines 266–282)

```
async fn unavailable_environment_does_not_fall_back_to_host_filesystem()
```

**Purpose**: Tests that a selected root pointing at a missing environment fails, even if the same path exists on the host machine. This prevents accidental leakage from the local computer into an environment-specific lookup.

**Data flow**: It creates a real temporary plugin manifest on the host disk, then creates a provider whose environment manager has no available environments. When it asks the provider to resolve the selected root in a missing environment, the result must be an error saying that environment is unavailable.

**Call relations**: This test uses `write_manifest` to make a tempting host-side plugin and `selected_root` to point at it through a nonexistent environment. It then calls the provider’s resolve path and confirms the provider stops at the environment check instead of reading the host file system.

*Call graph*: calls 4 internal fn (new, selected_root, write_manifest, without_environments); 3 external calls (new, assert_eq!, tempdir).


##### `malformed_preferred_manifest_does_not_fall_through_to_alternate`  (lines 285–320)

```
async fn malformed_preferred_manifest_does_not_fall_through_to_alternate()
```

**Purpose**: Tests that a broken manifest in the preferred location causes a parse error instead of being ignored in favor of an alternate manifest. This keeps configuration mistakes visible.

**Data flow**: It creates a plugin folder with two manifests: the preferred `.codex-plugin/plugin.json` contains invalid JSON, while the alternate `.claude-plugin/plugin.json` is valid. It asks the provider to resolve the root and expects a parse-manifest error tied to the preferred manifest path. The successful alternate file is intentionally not used.

**Call relations**: The test uses `write_manifest` twice to set up the competing files and `selected_root` to feed the root into `ExecutorPluginProvider::resolve`. After resolution fails, it inspects the specific error shape to make sure the failure came from parsing the preferred manifest.

*Call graph*: calls 5 internal fn (new, selected_root, write_manifest, default_for_tests, from_absolute_path_checked); 4 external calls (new, assert_eq!, panic!, tempdir).


##### `executor_root_must_be_an_explicit_absolute_path`  (lines 323–342)

```
async fn executor_root_must_be_an_explicit_absolute_path()
```

**Purpose**: Tests that executor plugin roots must use absolute paths, not shortcuts such as `~/plugins/demo`. This avoids unclear path interpretation inside execution environments.

**Data flow**: It creates a selected root by hand with an environment location whose path starts with `~`. It asks the provider to resolve it and expects an error explaining that executor paths must be absolute.

**Call relations**: Unlike the other tests, this one constructs the selected root directly so it can use an intentionally invalid path string. It then calls the provider’s resolve path and verifies that validation rejects the path before any plugin lookup proceeds.

*Call graph*: calls 2 internal fn (new, default_for_tests); 2 external calls (new, assert_eq!).


### `core-plugins/src/store_tests.rs`

`test` · `test run`

A plugin store is the part of the system that turns a plugin folder into a predictable installed copy under the Codex home directory. These tests create small fake plugins in temporary folders, install them, and then check the exact files and paths that appear. This matters because plugin storage touches the filesystem, and small mistakes there could mean loading the wrong plugin, leaving stale versions behind, or allowing a malicious name to write outside the intended directory.

The helper functions at the top build a minimal plugin: a manifest file called plugin.json, a skills folder, and an MCP configuration file. Each test then uses that fake plugin as if it came from a marketplace or local development folder.

The tests cover the happy path, such as copying a plugin into plugins/cache/<marketplace>/<name>/<version>, and the rules for choosing a version. A plugin with no version becomes local. A plugin with a manifest version uses that version. If several versions exist, local wins; otherwise the newest version wins, including proper semantic version comparison, where 10.0.0 is newer than 9.0.0.

The file also checks guardrails. Plugin names and marketplace names must not contain path separators like ../, because those could escape the plugin cache directory. Manifest names must match the expected marketplace plugin name. In short, these tests make sure the plugin store behaves like a careful librarian: it shelves plugins in the right place, picks the right edition, and refuses suspicious labels.

#### Function details

##### `write_plugin_with_version`  (lines 6–25)

```
fn write_plugin_with_version(
    root: &Path,
    dir_name: &str,
    manifest_name: &str,
    manifest_version: Option<&str>,
)
```

**Purpose**: Creates a tiny fake plugin on disk for tests, optionally including a version in its manifest. This lets each test build just enough plugin structure to exercise the store without needing real plugin packages.

**Data flow**: It receives a root folder, a directory name, a manifest plugin name, and an optional version string. It creates the plugin directory, writes a .codex-plugin/plugin.json file with the chosen name and optional version, writes a sample skill file, and writes an empty MCP configuration file. Nothing is returned; the result is a ready-to-install fake plugin folder on disk.

**Call relations**: Tests that need a specific manifest version call this helper directly. The simpler write_plugin helper also calls it when tests need the same fake plugin but with no version field.

*Call graph*: called by 4 (install_rejects_blank_manifest_version, install_uses_manifest_version_when_present, install_with_new_version_keeps_existing_plugin_root_and_prunes_old_versions, write_plugin); 4 external calls (join, format!, create_dir_all, write).


##### `write_plugin`  (lines 27–34)

```
fn write_plugin(root: &Path, dir_name: &str, manifest_name: &str)
```

**Purpose**: Creates a tiny fake plugin with no explicit version in its manifest. Tests use it when they want the store to fall back to the default local version.

**Data flow**: It receives a root folder, a directory name, and a manifest plugin name. It passes those values to write_plugin_with_version with no version value, which creates the files and folders. It returns nothing; it leaves a minimal plugin directory behind.

**Call relations**: Most install and version-selection tests call this helper before asking PluginStore to inspect or install the fake plugin. It is a convenience wrapper around write_plugin_with_version.

*Call graph*: calls 1 internal fn (write_plugin_with_version); called by 9 (active_plugin_version_compares_semver_versions_semantically, active_plugin_version_prefers_default_local_version_when_multiple_versions_exist, active_plugin_version_reads_version_directory_name, active_plugin_version_returns_latest_version_when_default_is_missing, install_copies_plugin_into_default_marketplace, install_rejects_manifest_names_that_do_not_match_marketplace_plugin_name, install_rejects_manifest_names_with_path_separators, install_uses_manifest_name_for_destination_and_key, install_with_version_uses_requested_cache_version).


##### `try_new_rejects_relative_codex_home`  (lines 37–46)

```
fn try_new_rejects_relative_codex_home()
```

**Purpose**: Checks that the plugin store refuses to start from a relative Codex home path. This protects later path calculations from being ambiguous or dependent on the current working directory.

**Data flow**: It gives PluginStore::try_new a relative path named relative. The store creation is expected to fail, and the test turns the error into text. The output is an assertion that the error message clearly says the plugin cache root could not be resolved because the path was not absolute.

**Call relations**: This test calls the fallible constructor directly, before any plugin installation happens. It verifies an early setup guard that other store operations rely on.

*Call graph*: calls 1 internal fn (try_new); 2 external calls (from, assert_eq!).


##### `install_copies_plugin_into_default_marketplace`  (lines 49–72)

```
fn install_copies_plugin_into_default_marketplace()
```

**Purpose**: Checks the basic install path: a valid plugin is copied into the plugin cache under its marketplace, plugin name, and default local version. It also checks that important plugin files are actually copied.

**Data flow**: It creates a temporary folder, writes a fake plugin named sample-plugin, and builds a PluginId for the debug marketplace. It then installs the source folder through PluginStore. The result should name the same plugin, report version local, point to plugins/cache/debug/sample-plugin/local, and that destination should contain the manifest and skill file.

**Call relations**: This is a direct exercise of PluginStore::install using a plugin created by write_plugin. It confirms the core behavior that many later tests vary or constrain.

*Call graph*: calls 4 internal fn (new, write_plugin, new, try_from); 3 external calls (assert!, assert_eq!, tempdir).


##### `install_uses_manifest_name_for_destination_and_key`  (lines 75–98)

```
fn install_uses_manifest_name_for_destination_and_key()
```

**Purpose**: Checks that installation follows the plugin name inside plugin.json, not just the source folder name. This matters because a downloaded or unpacked directory may have a temporary name, while the manifest is the plugin’s identity.

**Data flow**: It creates a source folder called source-dir whose manifest says manifest-name. It installs that folder with a PluginId for manifest-name in the market marketplace. The expected result points to plugins/cache/market/manifest-name/local and keeps the PluginId for manifest-name.

**Call relations**: This test uses write_plugin to create a mismatch between folder name and manifest name, then calls PluginStore::install to prove the manifest name is what determines the installed location.

*Call graph*: calls 4 internal fn (new, write_plugin, new, try_from); 2 external calls (assert_eq!, tempdir).


##### `plugin_root_derives_path_from_key_and_version`  (lines 101–110)

```
fn plugin_root_derives_path_from_key_and_version()
```

**Purpose**: Checks that PluginStore can compute the installed root folder for a given plugin and version. This is the path other code will use when it needs to load an installed plugin.

**Data flow**: It creates a store rooted at a temporary directory and a PluginId for sample in the debug marketplace. It asks for the plugin root for version local. The returned path should be plugins/cache/debug/sample/local inside the temporary Codex home.

**Call relations**: This test calls PluginStore::plugin_root directly. It verifies the path-building rule that install and lookup operations depend on.

*Call graph*: calls 2 internal fn (new, new); 2 external calls (assert_eq!, tempdir).


##### `plugin_data_root_derives_path_from_key`  (lines 113–122)

```
fn plugin_data_root_derives_path_from_key()
```

**Purpose**: Checks where per-plugin data should live. Plugin data is separate from the plugin’s installed code so that cache versions can change without losing runtime data.

**Data flow**: It creates a store and a PluginId for sample in the debug marketplace. It asks for the plugin data root. The expected path is plugins/data/sample-debug inside the temporary Codex home.

**Call relations**: This test calls PluginStore::plugin_data_root directly. It documents and protects the naming convention used for plugin-specific data directories.

*Call graph*: calls 2 internal fn (new, new); 2 external calls (assert_eq!, tempdir).


##### `install_with_version_uses_requested_cache_version`  (lines 125–152)

```
fn install_with_version_uses_requested_cache_version()
```

**Purpose**: Checks that callers can force a specific cache version during installation. This is useful for marketplace downloads where the desired version may come from an external package hash or release identifier.

**Data flow**: It writes a fake plugin with no manifest version, creates a PluginId for the openai-curated marketplace, and chooses a version string. It installs through install_with_version. The result should report that exact version and copy the plugin into plugins/cache/openai-curated/sample-plugin/<that version>.

**Call relations**: This test uses write_plugin, then calls the explicit-version install path instead of the default install path. It confirms that install_with_version overrides the usual local fallback.

*Call graph*: calls 4 internal fn (new, write_plugin, new, try_from); 4 external calls (assert!, assert_eq!, format!, tempdir).


##### `install_uses_manifest_version_when_present`  (lines 155–184)

```
fn install_uses_manifest_version_when_present()
```

**Purpose**: Checks that a version written in plugin.json becomes the installed cache version. This lets plugins declare their own release version instead of always being installed as local.

**Data flow**: It creates a fake plugin whose manifest version is 1.2.3-beta+7, then installs it. The install result should report that same version, and the copied plugin should live under plugins/cache/debug/sample-plugin/1.2.3-beta+7.

**Call relations**: This test calls write_plugin_with_version to prepare a versioned plugin, then calls PluginStore::install. It proves the normal install path reads and honors the manifest version.

*Call graph*: calls 4 internal fn (new, write_plugin_with_version, new, try_from); 3 external calls (assert!, assert_eq!, tempdir).


##### `install_rejects_blank_manifest_version`  (lines 187–204)

```
fn install_rejects_blank_manifest_version()
```

**Purpose**: Checks that a manifest version made only of spaces is not accepted. A blank version would create unclear cache paths and make version selection unreliable.

**Data flow**: It creates a fake plugin whose version field is whitespace. It tries to install it and expects an error instead of a copied plugin. The final assertion checks that the error says the plugin version in plugin.json must not be blank.

**Call relations**: This test uses write_plugin_with_version to create an invalid manifest, then calls PluginStore::install to verify that validation stops the install early.

*Call graph*: calls 4 internal fn (new, write_plugin_with_version, new, try_from); 2 external calls (assert_eq!, tempdir).


##### `active_plugin_version_reads_version_directory_name`  (lines 207–225)

```
fn active_plugin_version_reads_version_directory_name()
```

**Purpose**: Checks that the store can discover the active installed version by looking at the version directory name. This is how the store finds an already-installed plugin.

**Data flow**: It manually creates a fake installed plugin under plugins/cache/debug/sample-plugin/local. It then creates a store and asks for the active version and active root. The answers should be local and the matching local directory.

**Call relations**: This test uses write_plugin to create a cache-shaped directory by hand, then calls active_plugin_version and active_plugin_root. It verifies lookup behavior without going through install.

*Call graph*: calls 3 internal fn (new, write_plugin, new); 2 external calls (assert_eq!, tempdir).


##### `active_plugin_version_prefers_default_local_version_when_multiple_versions_exist`  (lines 228–247)

```
fn active_plugin_version_prefers_default_local_version_when_multiple_versions_exist()
```

**Purpose**: Checks that local is chosen when both local and another version exist. This supports local development or manually installed plugins taking priority over cached release versions.

**Data flow**: It creates two installed-looking versions of the same plugin: one named with a hash-like version and one named local. It asks the store for the active version. The expected answer is local.

**Call relations**: This test builds the cache layout with write_plugin and then calls active_plugin_version. It exercises the priority rule used when several installed versions are present.

*Call graph*: calls 3 internal fn (new, write_plugin, new); 2 external calls (assert_eq!, tempdir).


##### `active_plugin_version_returns_latest_version_when_default_is_missing`  (lines 250–269)

```
fn active_plugin_version_returns_latest_version_when_default_is_missing()
```

**Purpose**: Checks that, when local is not present, the store chooses the newest available version directory. This keeps the plugin active on the most recent cached release.

**Data flow**: It creates two non-local version directories for the same plugin. It asks for the active version. The expected answer is the later version name, fedcba9876543210.

**Call relations**: This test prepares multiple cached versions with write_plugin and then calls active_plugin_version. It covers the fallback path after the local-priority rule does not apply.

*Call graph*: calls 3 internal fn (new, write_plugin, new); 2 external calls (assert_eq!, tempdir).


##### `active_plugin_version_compares_semver_versions_semantically`  (lines 272–291)

```
fn active_plugin_version_compares_semver_versions_semantically()
```

**Purpose**: Checks that standard release versions are compared by meaning, not just alphabetically. Without this, 9.0.0 could incorrectly sort after 10.0.0 because text sorting can be misleading.

**Data flow**: It creates installed versions named 9.0.0 and 10.0.0. It asks the store for the active version. The result should be 10.0.0, proving the comparison understands semantic versions, which are dotted release numbers like major.minor.patch.

**Call relations**: This test uses write_plugin to create version directories and then calls active_plugin_version. It protects the version-ranking logic used when local is absent.

*Call graph*: calls 3 internal fn (new, write_plugin, new); 2 external calls (assert_eq!, tempdir).


##### `install_with_new_version_keeps_existing_plugin_root_and_prunes_old_versions`  (lines 294–329)

```
fn install_with_new_version_keeps_existing_plugin_root_and_prunes_old_versions()
```

**Purpose**: Checks that installing a newer version replaces older cached versions of the same plugin. This avoids stale versions staying active or piling up on disk.

**Data flow**: It creates a store and installs version 1.0.0 of sample-plugin. Then it creates and installs version 2.0.0 of the same plugin. Afterward, the active version should be 2.0.0, the 2.0.0 directory should exist, and the old 1.0.0 directory should be gone.

**Call relations**: This test calls write_plugin_with_version twice and installs both fake plugins through PluginStore::install. It ties together version detection, install location, active-version choice, and cleanup of old versions.

*Call graph*: calls 4 internal fn (new, write_plugin_with_version, new, try_from); 3 external calls (assert!, assert_eq!, tempdir).


##### `old_plugin_version_would_stay_active_for_local_or_later_versions`  (lines 332–339)

```
fn old_plugin_version_would_stay_active_for_local_or_later_versions()
```

**Purpose**: Checks the helper rule that decides whether an old version would still win over a newly installed version. This rule helps the store know when replacing or pruning is needed.

**Data flow**: It feeds pairs of old and new version names into old_plugin_version_would_stay_active. The assertions expect true when the old version is local or newer than the new one, and false when the new version is newer.

**Call relations**: This test calls the version-comparison helper directly. It supports the cleanup behavior tested more fully by install_with_new_version_keeps_existing_plugin_root_and_prunes_old_versions.

*Call graph*: 1 external calls (assert!).


##### `plugin_root_rejects_path_separators_in_key_segments`  (lines 342–354)

```
fn plugin_root_rejects_path_separators_in_key_segments()
```

**Purpose**: Checks that plugin identifiers cannot contain path traversal text such as ../../etc. This is a security guard: plugin names and marketplace names must not be able to escape the cache directory.

**Data flow**: It tries to parse one PluginId with a dangerous plugin name and another with a dangerous marketplace name. Both should fail, and each error message should explain which part of the identifier is invalid and what characters are allowed.

**Call relations**: This test calls PluginId::parse before any store path is built. It verifies that unsafe identifiers are rejected at the identifier layer, which protects later path-building code.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `install_rejects_manifest_names_with_path_separators`  (lines 357–372)

```
fn install_rejects_manifest_names_with_path_separators()
```

**Purpose**: Checks that unsafe plugin names inside plugin.json are rejected during installation. Even if the requested PluginId is safe, the manifest itself must not be able to choose a dangerous destination path.

**Data flow**: It creates a fake plugin whose manifest name is ../../etc. It tries to install that plugin with a safe PluginId. The install should fail, and the error should say the plugin name may only contain allowed characters.

**Call relations**: This test uses write_plugin to create a malicious manifest, then calls PluginStore::install. It verifies that manifest validation happens before copying into the cache.

*Call graph*: calls 4 internal fn (new, write_plugin, new, try_from); 2 external calls (assert_eq!, tempdir).


##### `install_rejects_marketplace_names_with_path_separators`  (lines 375–382)

```
fn install_rejects_marketplace_names_with_path_separators()
```

**Purpose**: Checks that marketplace names are validated when a PluginId is created. A marketplace name becomes part of a filesystem path, so it must not contain path separators.

**Data flow**: It tries to create a PluginId with plugin name sample-plugin and marketplace name ../../etc. The creation should fail, and the error should explain that only safe characters are allowed in marketplace names.

**Call relations**: This test calls PluginId::new directly. It confirms unsafe marketplace input is stopped before PluginStore ever receives it.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `install_rejects_manifest_names_that_do_not_match_marketplace_plugin_name`  (lines 385–400)

```
fn install_rejects_manifest_names_that_do_not_match_marketplace_plugin_name()
```

**Purpose**: Checks that the plugin name in plugin.json must match the plugin name requested by the marketplace identifier. This prevents accidentally or deliberately installing one plugin under another plugin’s identity.

**Data flow**: It creates a source folder whose manifest says manifest-name, then tries to install it using a PluginId whose plugin name is different-name. The install should fail with an error that names both the manifest value and the expected marketplace value.

**Call relations**: This test uses write_plugin to create the mismatch and then calls PluginStore::install. It verifies the identity check that sits between reading the manifest and copying the plugin into the cache.

*Call graph*: calls 4 internal fn (new, write_plugin, new, try_from); 2 external calls (assert_eq!, tempdir).


### `core-plugins/src/loader_tests.rs`

`test` · `test run`

These are automated tests for plugin loading. Think of the plugin loader like a hotel front desk: it checks which guests are expected, finds their rooms, reads any special instructions, and ignores guests who are not allowed in. This file builds small fake plugin folders and fake user configuration files, then checks that the loader makes the right choices.

The tests cover several important promises. User configuration layers should merge, so plugins named in different config files are all seen. A special “hooks only” mode should still resolve the same plugins and report the same validation errors, but it should not spend time loading skills, app definitions, or MCP servers. MCP means “Model Context Protocol,” a way for plugins to describe external tools or services.

The file also checks hook discovery. Hooks are commands that run at certain moments, such as session start or tool use. The loader can find hooks in the default hooks file, in paths listed by the plugin manifest, or directly inside the manifest. Bad hook JSON should not crash loading; it should produce a warning.

Finally, it tests marketplace plugin materialization from a Git repository, especially when only a subdirectory is needed. That keeps checkouts small and avoids pulling unrelated files.

#### Function details

##### `user_config_path`  (lines 12–15)

```
fn user_config_path(temp_dir: &TempDir, file_name: &str) -> AbsolutePathBuf
```

**Purpose**: Builds an absolute path for a temporary user configuration file used in tests. It saves each test from repeating path setup code.

**Data flow**: It takes a temporary directory and a file name. It joins them into one filesystem path, checks that the result is absolute, and returns it as the project’s absolute-path type. If the path is somehow not absolute, the test fails immediately.

**Call relations**: The configuration-layer helper uses this when tests need a pretend user config file. It supplies paths that are then wrapped into config layer entries.

*Call graph*: calls 1 internal fn (from_absolute_path); 1 external calls (path).


##### `user_layer`  (lines 17–25)

```
fn user_layer(path: AbsolutePathBuf, config: &str) -> ConfigLayerEntry
```

**Purpose**: Creates one fake user configuration layer from a path and a TOML text snippet. TOML is a simple configuration-file format, similar to INI but with clearer structure.

**Data flow**: It receives the pretend config file path and the config text. It parses the text into structured TOML data, labels the layer as coming from a user file, and returns a config layer entry ready to be put into a stack.

**Call relations**: Tests call this while building a ConfigLayerStack. That stack is then passed into plugin loading code to see how real user configuration would be interpreted.

*Call graph*: calls 1 internal fn (new); 1 external calls (from_str).


##### `configured_plugins_from_stack_merges_user_layers`  (lines 28–67)

```
fn configured_plugins_from_stack_merges_user_layers()
```

**Purpose**: Checks that plugin settings from multiple user config layers are combined rather than one layer erasing the other. Without this, plugins from a base config and a profile or work config could disappear unexpectedly.

**Data flow**: The test creates two temporary config layers: one enabling a plugin named base and another disabling a plugin named profile. It builds a config stack from both, asks the loader for the configured plugins, and compares the result with the exact two plugin settings it expects.

**Call relations**: This test drives the config-stack path that feeds plugin loading. It relies on the helper functions for temporary user paths and layers, then verifies the public result of configured_plugins_from_stack.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, default, assert_eq!, default, vec!).


##### `hooks_only_scope_shares_plugin_resolution_without_loading_other_capabilities`  (lines 70–210)

```
async fn hooks_only_scope_shares_plugin_resolution_without_loading_other_capabilities()
```

**Purpose**: Checks that hook-only plugin loading uses the same plugin discovery and validation as full loading, while deliberately skipping non-hook features. This matters because hook startup should be reliable and lightweight.

**Data flow**: The test creates several fake plugins: a valid one with hooks plus skills, MCP servers, and apps; a disabled one; a malformed one; a missing one; and one with broken hook JSON. It loads the same config twice, once fully and once in hooks-only mode. It compares the validation-related fields from both loads, then confirms that the hooks-only version of the valid plugin did not load manifest name, skills, MCP servers, or apps.

**Call relations**: This test calls the normal full plugin loading path and the scoped loading path side by side. It shows that PluginLoadScope::HooksOnly shares plugin resolution behavior with the full loader, but stops before handing off to the extra capability loaders.

*Call graph*: calls 2 internal fn (new, new); 8 external calls (new, new, default, assert!, assert_eq!, default, write_file, vec!).


##### `curated_plugin_cache_version_shortens_full_git_sha`  (lines 213–218)

```
fn curated_plugin_cache_version_shortens_full_git_sha()
```

**Purpose**: Checks that a full Git commit identifier is shortened when used as a curated plugin cache version. A Git SHA is a long fingerprint for a commit; shortening it makes cache folder names more readable while still identifying the version well enough for this use.

**Data flow**: It gives the cache-version helper a 40-character hexadecimal commit string. It expects the result to be just the first eight characters.

**Call relations**: This test exercises the version-normalizing helper directly. It protects the naming behavior used when marketplace or curated plugins are stored in the local cache.

*Call graph*: 1 external calls (assert_eq!).


##### `curated_plugin_cache_version_preserves_non_git_sha_versions`  (lines 221–227)

```
fn curated_plugin_cache_version_preserves_non_git_sha_versions()
```

**Purpose**: Checks that version names that are not full Git commit identifiers are left unchanged. This prevents friendly labels like export-backup from being altered.

**Data flow**: It passes two non-full-SHA strings into the cache-version helper: a named version and a too-short numeric string. It expects each returned value to match the input exactly.

**Call relations**: This test complements the Git SHA shortening test. Together they define when the cache-version helper should rewrite a version string and when it should not.

*Call graph*: 1 external calls (assert_eq!).


##### `plugin_id`  (lines 229–231)

```
fn plugin_id() -> PluginId
```

**Purpose**: Creates the standard plugin ID used by the hook-loading tests. A plugin ID is the full name that identifies a plugin and its marketplace source.

**Data flow**: It parses the fixed text demo-plugin@test-marketplace into a PluginId value. If that fixed text ever stops being valid, the test fails immediately.

**Call relations**: The load_sources helper uses this ID when calling the hook loader, and assert_sources uses the same ID to check that loaded hook sources are attributed to the right plugin.

*Call graph*: calls 1 internal fn (parse); called by 1 (load_sources).


##### `plugin_root`  (lines 233–240)

```
fn plugin_root() -> (tempfile::TempDir, AbsolutePathBuf)
```

**Purpose**: Creates a temporary fake plugin directory with the basic folders that plugin-hook tests need. This gives each test a clean sandbox, like a disposable workbench.

**Data flow**: It creates a new temporary directory, adds a demo-plugin folder inside it, then creates the .codex-plugin folder for the manifest and the hooks folder for hook files. It returns both the temporary directory, which keeps the files alive, and the absolute plugin root path.

**Call relations**: Most hook-loading tests start here. After this helper creates the fake plugin skeleton, the tests write a manifest and hook files into it before asking load_sources to run the real loader code.

*Call graph*: calls 1 internal fn (try_from); called by 6 (load_plugin_hooks_discovers_default_hooks_file, load_plugin_hooks_manifest_paths_replace_default_hooks_file, load_plugin_hooks_reports_invalid_hook_file, load_plugin_hooks_supports_inline_manifest_hook_list, load_plugin_hooks_supports_inline_manifest_hooks, load_plugin_hooks_supports_manifest_hook_path); 2 external calls (create_dir_all, tempdir).


##### `write_manifest`  (lines 242–244)

```
fn write_manifest(plugin_root: &AbsolutePathBuf, manifest: &str)
```

**Purpose**: Writes a plugin manifest file into a fake plugin root. The manifest is the plugin’s description file, including things like its name and where hook definitions live.

**Data flow**: It takes a plugin root and a JSON string. It writes that JSON into .codex-plugin/plugin.json under the plugin root. Its output is the changed test filesystem; the function itself returns nothing useful.

**Call relations**: Hook-loading tests call this after creating a fake plugin root. The manifest it writes is later read by load_sources through the real manifest-loading code.

*Call graph*: calls 1 internal fn (join); called by 6 (load_plugin_hooks_discovers_default_hooks_file, load_plugin_hooks_manifest_paths_replace_default_hooks_file, load_plugin_hooks_reports_invalid_hook_file, load_plugin_hooks_supports_inline_manifest_hook_list, load_plugin_hooks_supports_inline_manifest_hooks, load_plugin_hooks_supports_manifest_hook_path); 1 external calls (write).


##### `write_hook_file`  (lines 246–262)

```
fn write_hook_file(plugin_root: &AbsolutePathBuf, relative_path: &str, event: &str, command: &str)
```

**Purpose**: Writes a simple hook configuration file for tests. It hides the repetitive JSON shape so each test can focus on which file path, event, and command matter.

**Data flow**: It receives a plugin root, a relative file path, a hook event name, and a command string. It formats those values into a small hooks JSON document and writes it at the requested path. The result is a hook file on disk for the loader to discover.

**Call relations**: Tests that need hook files named by the manifest use this helper. load_sources later reads those files through the real hook-loading path, and assert_sources checks that they were found.

*Call graph*: calls 1 internal fn (join); called by 2 (load_plugin_hooks_manifest_paths_replace_default_hooks_file, load_plugin_hooks_supports_manifest_hook_path); 2 external calls (format!, write).


##### `load_sources`  (lines 264–280)

```
fn load_sources(plugin_root: &AbsolutePathBuf) -> (Vec<PluginHookSource>, Vec<String>)
```

**Purpose**: Runs the real hook-loading path against one fake plugin root. It is the bridge between the test setup files and the loader behavior being checked.

**Data flow**: It reads the plugin manifest from disk, builds a nearby plugin-data directory path, creates the standard test plugin ID, and calls the hook loader. It returns two things: the hook sources that were successfully loaded and any warning messages produced while trying.

**Call relations**: All hook-discovery tests call this after writing their fake plugin files. It hands control to load_plugin_manifest and load_plugin_hooks, then returns their results for the test assertions.

*Call graph*: calls 4 internal fn (plugin_id, load_plugin_manifest, as_path, try_from); called by 6 (load_plugin_hooks_discovers_default_hooks_file, load_plugin_hooks_manifest_paths_replace_default_hooks_file, load_plugin_hooks_reports_invalid_hook_file, load_plugin_hooks_supports_inline_manifest_hook_list, load_plugin_hooks_supports_inline_manifest_hooks, load_plugin_hooks_supports_manifest_hook_path).


##### `assert_sources`  (lines 282–304)

```
fn assert_sources(sources: &[PluginHookSource], expected_relative_paths: &[&str])
```

**Purpose**: Checks that loaded hook sources match the expected files or manifest locations. It also checks that each source belongs to the test plugin and contains exactly one hook handler.

**Data flow**: It receives the loaded hook sources and a list of expected relative paths. It extracts plugin IDs, source paths, and hook counts from the sources, then compares each extracted list with the expected values.

**Call relations**: Successful hook-loading tests call this after load_sources. It gives those tests a compact way to verify the important shared facts without repeating the same checks every time.

*Call graph*: called by 5 (load_plugin_hooks_discovers_default_hooks_file, load_plugin_hooks_manifest_paths_replace_default_hooks_file, load_plugin_hooks_supports_inline_manifest_hook_list, load_plugin_hooks_supports_inline_manifest_hooks, load_plugin_hooks_supports_manifest_hook_path); 1 external calls (assert_eq!).


##### `load_plugin_hooks_discovers_default_hooks_file`  (lines 307–329)

```
fn load_plugin_hooks_discovers_default_hooks_file()
```

**Purpose**: Checks that, when the manifest does not name any hook paths, the loader looks for the default hooks/hooks.json file. This keeps simple plugins easy to write.

**Data flow**: The test creates a fake plugin, writes a minimal manifest, and writes a default hook file containing one PreToolUse hook. It loads hook sources and expects no warnings and exactly one source: hooks/hooks.json.

**Call relations**: This test uses plugin_root and write_manifest for setup, writes the default hook file directly, then calls load_sources and assert_sources to verify the real discovery behavior.

*Call graph*: calls 4 internal fn (assert_sources, load_sources, plugin_root, write_manifest); 2 external calls (assert_eq!, write).


##### `load_plugin_hooks_supports_manifest_hook_path`  (lines 332–347)

```
fn load_plugin_hooks_supports_manifest_hook_path()
```

**Purpose**: Checks that a manifest can point to a specific hook file. This lets plugin authors choose a non-default hook file name or location.

**Data flow**: The test creates a fake plugin whose manifest says its hooks live at ./hooks/one.json. It writes that hook file, loads the sources, and expects no warnings and one source from hooks/one.json.

**Call relations**: This test uses the shared plugin setup helpers, then exercises the branch where load_plugin_hooks follows a single path from the manifest instead of using the default file.

*Call graph*: calls 5 internal fn (assert_sources, load_sources, plugin_root, write_hook_file, write_manifest); 1 external calls (assert_eq!).


##### `load_plugin_hooks_manifest_paths_replace_default_hooks_file`  (lines 350–372)

```
fn load_plugin_hooks_manifest_paths_replace_default_hooks_file()
```

**Purpose**: Checks that manifest-specified hook paths replace the default hooks/hooks.json discovery. If a plugin explicitly lists hook files, the loader should not also pick up an accidental default file.

**Data flow**: The test writes a manifest listing two hook files, then also writes a default hook file that should be ignored. After loading, it expects only hooks/one.json and hooks/two.json, with no warnings.

**Call relations**: This test builds on the same helper path as the other hook tests. It specifically verifies the priority rule inside load_plugin_hooks: explicit manifest paths take over from the default convention.

*Call graph*: calls 5 internal fn (assert_sources, load_sources, plugin_root, write_hook_file, write_manifest); 1 external calls (assert_eq!).


##### `load_plugin_hooks_supports_inline_manifest_hooks`  (lines 375–398)

```
fn load_plugin_hooks_supports_inline_manifest_hooks()
```

**Purpose**: Checks that a plugin can put hook definitions directly inside its manifest instead of in a separate file. This supports compact plugins with small hook setups.

**Data flow**: The test writes a manifest whose hooks field contains a complete hook configuration object. It loads sources and expects one source labeled as coming from plugin.json#hooks[0], with no warnings.

**Call relations**: This test does not create a separate hook file. It sends the manifest through load_sources and then uses assert_sources to confirm that load_plugin_hooks treated the inline manifest content as a hook source.

*Call graph*: calls 4 internal fn (assert_sources, load_sources, plugin_root, write_manifest); 1 external calls (assert_eq!).


##### `load_plugin_hooks_reports_invalid_hook_file`  (lines 401–416)

```
fn load_plugin_hooks_reports_invalid_hook_file()
```

**Purpose**: Checks that an invalid hook file produces a clear warning instead of crashing or silently disappearing. This helps users fix broken plugin hook JSON.

**Data flow**: The test creates a fake plugin with the default manifest, then writes malformed text into hooks/hooks.json. Loading returns no hook sources and one warning message that includes the file path and parse error.

**Call relations**: This test uses the same setup and load_sources helper as the successful cases, but it intentionally feeds bad input to the real hook parser. It then checks the warning text directly rather than using assert_sources.

*Call graph*: calls 3 internal fn (load_sources, plugin_root, write_manifest); 2 external calls (assert_eq!, write).


##### `load_plugin_hooks_supports_inline_manifest_hook_list`  (lines 419–452)

```
fn load_plugin_hooks_supports_inline_manifest_hook_list()
```

**Purpose**: Checks that a manifest can contain a list of inline hook configurations. This allows one plugin manifest to define multiple separate hook source blocks.

**Data flow**: The test writes a manifest whose hooks field is a list with two hook objects. After loading, it expects two sources, labeled plugin.json#hooks[0] and plugin.json#hooks[1], and no warnings.

**Call relations**: This is the list-shaped counterpart to the single inline hook test. It calls load_sources to exercise the real loader and assert_sources to confirm both inline entries were preserved as separate sources.

*Call graph*: calls 4 internal fn (assert_sources, load_sources, plugin_root, write_manifest); 1 external calls (assert_eq!).


##### `materialize_git_subdir_uses_sparse_checkout`  (lines 455–499)

```
fn materialize_git_subdir_uses_sparse_checkout()
```

**Purpose**: Checks that materializing a marketplace plugin from a Git repository can fetch only the requested subdirectory. Sparse checkout means Git checks out selected paths instead of the whole repository, like taking one folder from a filing cabinet rather than copying every drawer.

**Data flow**: The test creates a temporary Git repository with a desired plugin folder, another plugin folder, and a root file. It commits those files, asks the marketplace materializer to load only plugins/toolkit, and then checks that the resulting materialized path contains the toolkit marker but not the unrelated root or other plugin files.

**Call relations**: This test prepares a real small Git repository, then calls the marketplace source materialization path with a Git source that names a subdirectory. Its assertions protect the loader’s handoff to Git checkout logic and ensure the cache stays focused on the requested plugin.

*Call graph*: 5 external calls (assert!, assert_eq!, create_dir_all, write, tempdir).


### `core-plugins/src/marketplace_tests.rs`

`test` · `test suite`

A marketplace is a JSON file that lists plugins a user can install. This test file builds many tiny fake repositories in temporary folders, writes marketplace and plugin manifest files into them, and checks that the marketplace code reads them the way users would expect. Think of it like setting up miniature shop displays, then checking that the catalog scanner finds the right products, ignores unsafe shelves, and reports broken signs without closing the whole shop.

The tests cover both the normal marketplace location under `.agents/plugins/marketplace.json` and an alternate Claude-style layout under `.claude-plugin/marketplace.json`. They verify that local plugin paths become safe absolute paths, GitHub shorthand becomes full Git URLs, relative Git URLs stay inside the marketplace root, and invalid paths are skipped rather than trusted. They also check listing behavior: marketplaces from a home directory and a repository can both appear, duplicate roots in the same repository are de-duplicated, and two marketplaces with the same name but different files remain separate.

Several tests focus on user-facing details, such as display names, plugin interface metadata, image paths, install policies, and product restrictions. The overall goal is to make marketplace discovery predictable and safe even when some entries are malformed.

#### Function details

##### `write_alternate_marketplace`  (lines 10–15)

```
fn write_alternate_marketplace(repo_root: &Path, contents: &str) -> AbsolutePathBuf
```

**Purpose**: Creates a marketplace JSON file in the alternate `.claude-plugin/marketplace.json` location used by several tests. It keeps those tests short and consistent.

**Data flow**: It receives a fake repository root and JSON text. It builds the alternate marketplace path, creates the parent folder, writes the JSON there, converts the path into the project's absolute-path type, and returns that absolute path.

**Call relations**: This is a test helper. Tests for alternate layouts and mixed plugin sources call it when they need a marketplace file without repeating the same folder-creation and file-writing steps.

*Call graph*: calls 1 internal fn (try_from); called by 5 (find_marketplace_plugin_supports_alternate_layout_and_string_local_source, list_marketplaces_includes_plugins_without_discoverable_manifest, list_marketplaces_keeps_remote_and_local_plugin_sources, list_marketplaces_prefers_first_supported_manifest_layout, list_marketplaces_supports_alternate_manifest_layout); 3 external calls (join, create_dir_all, write).


##### `write_alternate_plugin_manifest`  (lines 17–21)

```
fn write_alternate_plugin_manifest(plugin_root: &Path, contents: &str)
```

**Purpose**: Creates a plugin manifest JSON file in the alternate `.claude-plugin/plugin.json` location. It is used to check that marketplace listing can read plugin details from that layout.

**Data flow**: It receives a plugin folder and JSON text. It joins the folder with the alternate manifest path, creates the needed directory, and writes the JSON file; it does not return anything.

**Call relations**: This helper is used by the alternate-manifest-layout test before the marketplace is listed, so the production listing code has a manifest file to discover.

*Call graph*: called by 1 (list_marketplaces_supports_alternate_manifest_layout); 3 external calls (join, create_dir_all, write).


##### `find_marketplace_plugin_finds_repo_marketplace_plugin`  (lines 24–70)

```
fn find_marketplace_plugin_finds_repo_marketplace_plugin()
```

**Purpose**: Checks the basic case: a plugin listed in a repository marketplace can be found by name. This proves the normal marketplace path and local plugin path resolution work.

**Data flow**: The test creates a temporary repository with `.git`, writes a marketplace containing one local plugin, asks the marketplace lookup code for that plugin, and compares the returned plugin identity, source path, policy, and empty metadata fields to the expected values.

**Call relations**: The Rust test runner calls this test. Inside it, the production marketplace lookup is exercised directly, and the result is checked with an equality assertion.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `find_marketplace_plugin_supports_alternate_layout_and_string_local_source`  (lines 73–113)

```
fn find_marketplace_plugin_supports_alternate_layout_and_string_local_source()
```

**Purpose**: Checks that a marketplace in the alternate `.claude-plugin` layout is accepted, and that a simple string source like `./plugins/name` is treated as a local plugin path.

**Data flow**: The test creates a fake repository, writes an alternate marketplace using the helper, looks up the named plugin, and verifies that the returned source is the absolute path under the repository root with the default install and authentication policy.

**Call relations**: The test runner calls this test. It relies on `write_alternate_marketplace` for setup, then hands the resulting path to the production lookup code.

*Call graph*: calls 1 internal fn (write_alternate_marketplace); 3 external calls (assert_eq!, create_dir_all, tempdir).


##### `find_marketplace_plugin_supports_git_subdir_sources`  (lines 116–167)

```
fn find_marketplace_plugin_supports_git_subdir_sources()
```

**Purpose**: Checks that a plugin can come from a subfolder inside a Git repository. This matters because one remote repository can contain many plugins.

**Data flow**: The test writes a marketplace entry with a Git-subdirectory source, including a GitHub shorthand URL, subfolder path, branch name, and commit hash. It looks up the plugin and expects a normalized full GitHub URL plus the same subfolder, branch, and hash.

**Call relations**: The test runner calls this test to exercise the Git source parsing path in the marketplace lookup code.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `find_marketplace_plugin_normalizes_github_shorthand_with_dot_git_suffix`  (lines 170–208)

```
fn find_marketplace_plugin_normalizes_github_shorthand_with_dot_git_suffix()
```

**Purpose**: Checks that GitHub shorthand ending in `.git` is converted into a full GitHub URL without becoming malformed.

**Data flow**: The test writes a marketplace whose Git source URL is `openai/toolkit.git`, asks for the plugin, and verifies that the source becomes `https://github.com/openai/toolkit.git` with the expected subdirectory and no branch or hash.

**Call relations**: The test runner calls this test. It focuses on the URL-normalization part of the marketplace lookup flow.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `find_marketplace_plugin_normalizes_relative_git_source_urls_to_marketplace_root`  (lines 211–256)

```
fn find_marketplace_plugin_normalizes_relative_git_source_urls_to_marketplace_root()
```

**Purpose**: Checks that relative Git source URLs are interpreted relative to the marketplace's repository root, not some unpredictable current working directory.

**Data flow**: For both Unix-style and Windows-style relative paths, the test creates a fake remote Git folder under the repository, writes a marketplace pointing to it, looks up the plugin, and expects the Git URL field to be the absolute path to that local remote folder.

**Call relations**: The test runner calls this test. It repeatedly drives the production lookup code with two path spellings to make sure cross-platform path handling behaves the same.

*Call graph*: calls 1 internal fn (try_from); 5 external calls (assert_eq!, format!, create_dir_all, write, tempdir).


##### `normalize_relative_git_plugin_source_url_rejects_parent_traversal`  (lines 259–281)

```
fn normalize_relative_git_plugin_source_url_rejects_parent_traversal()
```

**Purpose**: Checks that relative Git URLs cannot escape upward out of the marketplace root using `..`. This is a safety rule that prevents a marketplace from pointing outside its allowed area by path trickery.

**Data flow**: The test tries several parent-directory path forms. Each one is passed to the URL-normalizing function, and the test expects an error saying the relative Git source must stay within the marketplace root.

**Call relations**: The test runner calls this test. Unlike many tests here, it calls the lower-level normalization function directly to verify the exact safety check and error text.

*Call graph*: calls 1 internal fn (try_from); 2 external calls (assert_eq!, tempdir).


##### `find_marketplace_plugin_skips_root_equivalent_git_subdir_paths`  (lines 284–321)

```
fn find_marketplace_plugin_skips_root_equivalent_git_subdir_paths()
```

**Purpose**: Checks that Git subdirectory sources whose path effectively means “the repository root” are not accepted as valid plugin subdirectories.

**Data flow**: The test tries path values like `.`, `./`, and `plugins/..`. For each one, it writes a marketplace entry, looks up the plugin, and expects a “not found” error because the invalid entry is skipped.

**Call relations**: The test runner calls this test. It drives the normal plugin lookup path and confirms invalid Git-subdirectory entries are filtered out before a result is returned.

*Call graph*: calls 1 internal fn (try_from); 5 external calls (assert_eq!, format!, create_dir_all, write, tempdir).


##### `find_marketplace_plugin_reports_missing_plugin`  (lines 324–345)

```
fn find_marketplace_plugin_reports_missing_plugin()
```

**Purpose**: Checks the error message when a marketplace exists but does not contain the requested plugin.

**Data flow**: The test writes an empty marketplace, asks for a plugin named `missing`, and verifies that the returned error names both the missing plugin and the marketplace.

**Call relations**: The test runner calls this test. It exercises the normal lookup failure path in the marketplace code.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `list_marketplaces_supports_alternate_manifest_layout`  (lines 348–421)

```
fn list_marketplaces_supports_alternate_manifest_layout()
```

**Purpose**: Checks that marketplace listing can read an alternate marketplace file and also read a plugin's alternate manifest file for display metadata.

**Data flow**: The test creates a plugin folder, writes an alternate plugin manifest containing a display name, writes an alternate marketplace pointing to that plugin, lists marketplaces for the repository, and expects one marketplace with one plugin whose interface metadata includes that display name.

**Call relations**: The test runner calls this test. It uses both file-writing helpers, then exercises the production marketplace-listing flow.

*Call graph*: calls 3 internal fn (write_alternate_marketplace, write_alternate_plugin_manifest, try_from); 3 external calls (assert_eq!, create_dir_all, tempdir).


##### `list_marketplaces_includes_plugins_without_discoverable_manifest`  (lines 424–472)

```
fn list_marketplaces_includes_plugins_without_discoverable_manifest()
```

**Purpose**: Checks that a plugin is still listed even if its local manifest file cannot be found. This keeps a marketplace entry visible instead of disappearing just because optional details are missing.

**Data flow**: The test writes an alternate marketplace pointing to a local plugin folder that has no manifest. It lists marketplaces and expects the plugin to appear with no interface metadata.

**Call relations**: The test runner calls this test. It uses `write_alternate_marketplace` for setup and then checks that listing is tolerant of missing plugin manifests.

*Call graph*: calls 2 internal fn (write_alternate_marketplace, try_from); 3 external calls (assert_eq!, create_dir_all, tempdir).


##### `list_marketplaces_prefers_first_supported_manifest_layout`  (lines 475–523)

```
fn list_marketplaces_prefers_first_supported_manifest_layout()
```

**Purpose**: Checks that when both supported marketplace layouts exist in a repository, the normal `.agents/plugins/marketplace.json` layout wins.

**Data flow**: The test writes a normal marketplace and an alternate marketplace in the same fake repository. It lists marketplaces and verifies that only the normal marketplace is returned.

**Call relations**: The test runner calls this test. It uses the alternate-marketplace helper plus direct file writing to compare the layout-selection order in the production listing code.

*Call graph*: calls 2 internal fn (write_alternate_marketplace, try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `list_marketplaces_supports_explicit_api_marketplace_manifest_path`  (lines 526–579)

```
fn list_marketplaces_supports_explicit_api_marketplace_manifest_path()
```

**Purpose**: Checks that callers can pass the path to a specific marketplace JSON file instead of only passing a repository root.

**Data flow**: The test writes an `api_marketplace.json` file under `.agents/plugins`, passes that exact file path as the search input, lists marketplaces, and expects the marketplace and its local plugin to be returned.

**Call relations**: The test runner calls this test. It exercises the listing path used when an API or caller already knows the marketplace file it wants read.

*Call graph*: calls 1 internal fn (try_from); 5 external calls (assert_eq!, create_dir_all, write, from_ref, tempdir).


##### `list_marketplaces_returns_home_and_repo_marketplaces`  (lines 582–723)

```
fn list_marketplaces_returns_home_and_repo_marketplaces()
```

**Purpose**: Checks that marketplace listing includes both a user's home marketplace and a repository marketplace. This lets personal and project-specific plugin catalogs coexist.

**Data flow**: The test creates separate fake home and repository roots, writes one marketplace in each with overlapping and unique plugin names, lists with both locations available, and expects two marketplace entries in order: home first, repository second.

**Call relations**: The test runner calls this test. It drives the listing flow with an optional home directory so the code must combine home-level and repo-level discoveries.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `list_marketplaces_keeps_distinct_entries_for_same_name`  (lines 726–833)

```
fn list_marketplaces_keeps_distinct_entries_for_same_name()
```

**Purpose**: Checks that two marketplace files with the same marketplace name are still treated as separate entries when they live at different paths.

**Data flow**: The test writes home and repository marketplaces with the same name and same plugin name but different local paths. Listing returns both marketplaces separately, and a direct lookup in the repository marketplace resolves to the repository plugin path.

**Call relations**: The test runner calls this test. It first exercises marketplace listing, then calls the plugin lookup code to confirm that the chosen marketplace file controls which duplicate plugin entry is used.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `list_marketplaces_dedupes_multiple_roots_in_same_repo`  (lines 836–894)

```
fn list_marketplaces_dedupes_multiple_roots_in_same_repo()
```

**Purpose**: Checks that passing both a repository root and a nested folder inside the same repository does not produce duplicate marketplace entries.

**Data flow**: The test creates a repository with a nested project folder, writes one marketplace at the repository root, passes both paths as inputs, and expects a single marketplace result.

**Call relations**: The test runner calls this test. It exercises the repository-root discovery and de-duplication part of marketplace listing.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `list_marketplaces_reads_marketplace_display_name`  (lines 897–936)

```
fn list_marketplaces_reads_marketplace_display_name()
```

**Purpose**: Checks that display metadata on the marketplace itself is read correctly. This is the name a user interface may show instead of the internal marketplace name.

**Data flow**: The test writes a marketplace with an `interface.displayName` value, lists marketplaces, and verifies that the returned marketplace interface contains that display name.

**Call relations**: The test runner calls this test. It focuses on the marketplace-level metadata path inside the listing code.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `list_marketplaces_skips_invalid_plugins_but_keeps_marketplace`  (lines 939–995)

```
fn list_marketplaces_skips_invalid_plugins_but_keeps_marketplace()
```

**Purpose**: Checks that one bad plugin entry does not make the entire marketplace disappear. This keeps valid marketplace information available even when a plugin source is malformed.

**Data flow**: The test writes one valid marketplace and one marketplace whose plugin has an invalid local path. Listing returns both marketplaces, but the invalid marketplace has an empty plugin list.

**Call relations**: The test runner calls this test. It verifies that the production listing flow filters bad plugin entries while preserving the surrounding marketplace.

*Call graph*: calls 1 internal fn (try_from); 5 external calls (assert!, assert_eq!, create_dir_all, write, tempdir).


##### `list_marketplaces_skips_plugins_with_invalid_names_but_keeps_marketplace`  (lines 998–1058)

```
fn list_marketplaces_skips_plugins_with_invalid_names_but_keeps_marketplace()
```

**Purpose**: Checks that plugins with invalid names are skipped while valid plugins in the same marketplace remain listed.

**Data flow**: The test writes a marketplace containing one valid plugin name and one invalid name with a dot. It lists marketplaces and expects only the valid plugin to appear.

**Call relations**: The test runner calls this test. It exercises the validation step that turns raw marketplace JSON entries into safe plugin records.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `list_marketplaces_reports_marketplace_load_errors`  (lines 1061–1111)

```
fn list_marketplaces_reports_marketplace_load_errors()
```

**Purpose**: Checks that a broken marketplace file is reported as an error while other valid marketplaces are still returned.

**Data flow**: The test writes one valid marketplace and one invalid JSON file. It lists marketplaces, then verifies that the valid marketplace is present and that the outcome also contains one load error tied to the broken file path.

**Call relations**: The test runner calls this test. It checks the listing function's combined outcome: successful marketplace results plus recoverable errors.

*Call graph*: calls 1 internal fn (try_from); 5 external calls (assert!, assert_eq!, create_dir_all, write, tempdir).


##### `list_marketplaces_keeps_remote_and_local_plugin_sources`  (lines 1114–1211)

```
fn list_marketplaces_keeps_remote_and_local_plugin_sources()
```

**Purpose**: Checks that listing preserves different kinds of plugin sources: local folders, full remote URLs, and Git subdirectories.

**Data flow**: The test writes an alternate marketplace containing three plugins with different source forms. It lists marketplaces and expects the local path to become absolute, the remote URL to become a Git URL ending in `.git`, and the Git subdirectory source to include its path, branch, and hash.

**Call relations**: The test runner calls this test. It uses `write_alternate_marketplace` for setup and then exercises source normalization during marketplace listing.

*Call graph*: calls 2 internal fn (write_alternate_marketplace, try_from); 3 external calls (assert_eq!, create_dir_all, tempdir).


##### `list_marketplaces_resolves_plugin_interface_paths_to_absolute`  (lines 1214–1301)

```
fn list_marketplaces_resolves_plugin_interface_paths_to_absolute()
```

**Purpose**: Checks that relative asset paths inside a plugin manifest, such as icons and screenshots, become absolute paths based on the plugin folder.

**Data flow**: The test writes a local plugin manifest with interface metadata and asset paths beginning with `./`. It lists marketplaces and expects those asset paths to be converted to absolute paths, while policy products and category override values are also reflected correctly.

**Call relations**: The test runner calls this test. It exercises marketplace listing, plugin manifest reading, policy parsing, and the path-resolution rules for user-interface assets.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `list_marketplaces_ignores_legacy_top_level_policy_fields`  (lines 1304–1345)

```
fn list_marketplaces_ignores_legacy_top_level_policy_fields()
```

**Purpose**: Checks that old top-level policy fields are ignored in favor of the current policy format. This prevents outdated fields from silently changing install behavior.

**Data flow**: The test writes a plugin entry with legacy `installPolicy` and `authPolicy` fields but no current `policy` object. After listing, it expects the default policy values rather than the legacy values.

**Call relations**: The test runner calls this test. It focuses on compatibility behavior in the listing code's policy parsing.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `list_marketplaces_ignores_plugin_interface_assets_without_dot_slash`  (lines 1348–1422)

```
fn list_marketplaces_ignores_plugin_interface_assets_without_dot_slash()
```

**Purpose**: Checks that plugin interface asset paths are only accepted when they are clearly relative paths beginning with `./`. This avoids treating arbitrary or absolute paths as trusted plugin assets.

**Data flow**: The test writes a plugin manifest with an icon path missing `./`, an absolute logo path, and a screenshot path missing `./`. Listing still reads safe text metadata, but drops those unsafe asset paths and leaves default policy values intact.

**Call relations**: The test runner calls this test. It exercises the asset-path validation part of plugin manifest processing during marketplace listing.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `find_marketplace_plugin_skips_invalid_local_paths`  (lines 1425–1457)

```
fn find_marketplace_plugin_skips_invalid_local_paths()
```

**Purpose**: Checks that local plugin paths using parent-directory traversal are not accepted by plugin lookup.

**Data flow**: The test writes a marketplace entry whose local path is `../plugin-1`, asks for that plugin, and expects a “not found” error because the unsafe entry is skipped.

**Call relations**: The test runner calls this test. It drives the production lookup path and confirms invalid local sources are filtered out rather than returned.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `find_marketplace_plugin_uses_first_duplicate_entry`  (lines 1460–1501)

```
fn find_marketplace_plugin_uses_first_duplicate_entry()
```

**Purpose**: Checks the rule for duplicate plugin names inside one marketplace: the first matching entry wins.

**Data flow**: The test writes two entries with the same plugin name but different local paths. It looks up that plugin and expects the source path from the first entry.

**Call relations**: The test runner calls this test. It exercises the marketplace lookup loop and confirms it stops on the first valid matching plugin.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `find_installable_marketplace_plugin_rejects_disallowed_product`  (lines 1504–1540)

```
fn find_installable_marketplace_plugin_rejects_disallowed_product()
```

**Purpose**: Checks that install lookup rejects a plugin when its policy allows only a different product. A product here means the application surface, such as ChatGPT, Codex, or Atlas.

**Data flow**: The test writes a plugin whose policy lists only `CHATGPT`, then asks whether it is installable for `Atlas`. It expects an error saying the plugin is not available for install in that marketplace.

**Call relations**: The test runner calls this test. It exercises the stricter installability lookup, which builds on normal marketplace lookup and then applies product-availability rules.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `find_marketplace_plugin_allows_missing_products_field`  (lines 1543–1573)

```
fn find_marketplace_plugin_allows_missing_products_field()
```

**Purpose**: Checks that a missing `products` policy field does not block normal plugin lookup.

**Data flow**: The test writes a plugin with an empty policy object, looks it up, and verifies that the returned plugin identity key combines the plugin and marketplace names as expected.

**Call relations**: The test runner calls this test. It verifies the normal lookup path, not the stricter installability filter, when product restrictions are absent.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `find_installable_marketplace_plugin_rejects_explicit_empty_products`  (lines 1576–1612)

```
fn find_installable_marketplace_plugin_rejects_explicit_empty_products()
```

**Purpose**: Checks that an explicitly empty product list means the plugin is installable for no products.

**Data flow**: The test writes a plugin whose policy has `products: []`, asks whether it is installable for Codex, and expects an unavailable-for-install error.

**Call relations**: The test runner calls this test. It exercises the installability lookup path and confirms that an empty allow-list is treated differently from a missing products field.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


### `core-plugins/src/remote_tests.rs`

`test` · `test run`

This is a test file. It does not provide the plugin feature itself; instead, it checks that the plugin feature behaves safely when given remote data from a server. That matters because remote plugin lists are partly outside the app’s direct control. If the app trusted them blindly, users might see duplicate plugins, unavailable plugins, broken plugin IDs, overlong names, or a different ordering than intended.

The file focuses on two areas. First, it checks marketplace building: plugins from the public directory should keep their original order, and plugins that are already installed but no longer appear in the directory should be appended only when that behavior is requested. Second, it checks recommended plugins: a server response can either enable a new endpoint-driven list or cause the app to use its older “legacy” recommendation behavior. When endpoint mode is enabled, the tests confirm that the list is cleaned up before use: invalid items are ignored, duplicates are removed, names are bounded to safe lengths, unavailable plugins are filtered out, connector IDs are normalized, and the final list is capped at a maximum size.

Small helper functions create fake plugin records so the tests can describe each scenario clearly without repeating a large amount of setup data.

#### Function details

##### `build_remote_marketplace_preserves_directory_order_and_appends_installed_only_plugins`  (lines 5–34)

```
fn build_remote_marketplace_preserves_directory_order_and_appends_installed_only_plugins()
```

**Purpose**: This test checks that building a remote marketplace keeps directory plugins in the same order the directory supplied, then adds installed-only plugins at the end when requested. This protects the user-facing marketplace from surprising reordering.

**Data flow**: It starts with two fake directory plugins and one fake installed plugin that is not in the directory list. It passes those into the marketplace-building logic with the “include installed-only” option turned on. It then reads the resulting plugin IDs and compares them with the expected order: the two directory plugins first, followed by the installed-only plugin.

**Call relations**: During the test, it uses ordinary test helpers to build sample vectors and compare the final result. It exercises the marketplace-building code from the surrounding module and verifies the returned marketplace instead of handing work off to another local helper.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `directory_plugin`  (lines 36–78)

```
fn directory_plugin(id: &str, name: &str) -> RemotePluginDirectoryItem
```

**Purpose**: This helper builds a realistic fake remote directory plugin record for tests. It lets the tests focus on the behavior being checked instead of repeating a large plugin structure every time.

**Data flow**: It receives a plugin ID and a display name as short text. It fills in a remote plugin directory item with those values and many safe default fields, such as global scope, available installation policy, and an empty release description. It returns the completed fake directory item for a test to use.

**Call relations**: This helper supports the marketplace test by producing sample remote plugins with predictable IDs and names. It does not call other project logic; it mainly constructs data in the shape expected by the plugin marketplace code.

*Call graph*: 2 external calls (new, new).


##### `item`  (lines 79–90)

```
fn item(name: &str, display_name: &str) -> RecommendedPluginItem
```

**Purpose**: This helper builds a fake recommended-plugin entry with a given internal name and display name. It keeps the recommendation tests short and readable when they need many sample plugins.

**Data flow**: It takes a plugin name and a display name. It creates an ID by prefixing the name, sets optional status and installation policy fields to empty, and puts the display name into a small release record. It returns this recommended-plugin item for later validation by the recommendation logic.

**Call relations**: The large validation test calls this helper repeatedly to make many fake recommendation records. After the helper returns those records, the test passes them into the recommended-plugin mode logic to see how they are filtered, sorted, deduplicated, and capped.

*Call graph*: called by 1 (recommended_plugins_are_validated_deduplicated_sorted_and_capped); 2 external calls (new, format!).


##### `recommended_plugins_enabled_flag_selects_endpoint_or_legacy_mode`  (lines 93–127)

```
fn recommended_plugins_enabled_flag_selects_endpoint_or_legacy_mode()
```

**Purpose**: This test checks the switch that decides whether recommended plugins come from the new server endpoint or from older legacy behavior. It makes sure only an explicit enabled value of true turns on endpoint mode.

**Data flow**: It creates several fake JSON server responses: one with enabled set to false, some with enabled missing or null, and one with enabled set to true. Each response is decoded into the expected response type, then passed into the mode-selection logic. The outputs are compared with the expected mode: legacy for false, missing, or null, and endpoint mode for true.

**Call relations**: The test uses JSON decoding to mimic what a real server response would look like before the plugin code sees it. It then calls the recommended-plugin mode function and checks that the rest of the system would be sent down the correct path.

*Call graph*: 3 external calls (assert_eq!, from_value, json!).


##### `recommended_plugins_require_remote_install_identity`  (lines 130–140)

```
fn recommended_plugins_require_remote_install_identity()
```

**Purpose**: This test makes sure a recommended plugin response must include the remote plugin identity needed for installation. Without that identity, the app would not know which remote plugin to install.

**Data flow**: It builds a JSON response that enables endpoint mode but includes a plugin missing its required ID. It attempts to decode that JSON into the recommendation response type. The expected result is an error, showing that malformed remote data is rejected before it can be used.

**Call relations**: This test focuses on deserialization, meaning the step where raw JSON is turned into typed Rust data. It verifies that bad data is stopped at the boundary instead of being passed deeper into recommendation processing.

*Call graph*: 2 external calls (assert!, json!).


##### `recommended_plugins_are_validated_deduplicated_sorted_and_capped`  (lines 143–198)

```
fn recommended_plugins_are_validated_deduplicated_sorted_and_capped()
```

**Purpose**: This test checks the main cleanup rules for endpoint-provided recommended plugins. It confirms that the final recommendation list is valid, unique, sorted, and no larger than the configured maximum.

**Data flow**: It creates more than the maximum number of fake plugins, in reverse order, then adds a duplicate, an invalid plugin ID, a disabled plugin, and a plugin that is not available for installation. It passes all of that into the recommended-plugin mode logic. The result is expected to be endpoint mode with exactly the maximum allowed number of cleaned plugins, beginning with plugin 00 and ending with plugin 49.

**Call relations**: This test relies on the item helper to create many sample recommendation records. It then exercises the recommendation-cleaning path and verifies the final output that the rest of the app would receive.

*Call graph*: calls 1 internal fn (item); 3 external calls (new, assert_eq!, panic!).


##### `recommended_plugins_bound_model_visible_fields`  (lines 201–223)

```
fn recommended_plugins_bound_model_visible_fields()
```

**Purpose**: This test checks that text fields visible to the product model or user interface are kept within safe length limits. This avoids oversized names from remote data leaking into later parts of the system.

**Data flow**: It creates one recommendation with a name that is too long and another with a display name that is too long. It sends both through the recommendation logic. The overlong internal name is rejected, while the overlong display name is shortened to the allowed maximum length in the final endpoint result.

**Call relations**: This test feeds carefully chosen boundary-breaking data into the same recommendation mode function used by the other recommendation tests. It checks that the function both drops unsafe identifiers and trims user-visible text where appropriate.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `recommended_plugins_preserve_install_identity_and_normalize_app_ids`  (lines 226–257)

```
fn recommended_plugins_preserve_install_identity_and_normalize_app_ids()
```

**Purpose**: This test checks that recommended plugins keep the remote plugin ID needed for installation while cleaning up related connector IDs. Connector IDs are links to app connectors, and the final list should not contain blanks or duplicates.

**Data flow**: It builds one recommended plugin with a valid remote plugin ID, a short name, a display name, and a connector list containing two real connector IDs, an empty string, and a duplicate. After processing, the output keeps the same remote plugin ID, creates the expected config ID, keeps the display name, and returns only the two unique non-empty connector IDs in order.

**Call relations**: The test sends a single detailed recommendation into the endpoint-mode processing path. It verifies that the recommendation logic preserves the identity used for installation while cleaning the extra app connector information before other code consumes it.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `recommended_plugins_ignore_invalid_remote_plugin_ids`  (lines 260–281)

```
fn recommended_plugins_ignore_invalid_remote_plugin_ids()
```

**Purpose**: This test checks that recommendations with invalid remote plugin IDs are silently left out of the endpoint result. This protects the app from trying to show or install a plugin whose identity does not match the expected format.

**Data flow**: It creates an enabled recommendation response containing one plugin whose ID has an invalid shape. It passes that response into the recommendation mode logic. The output is endpoint mode with an empty plugin list, meaning the bad item was filtered away.

**Call relations**: This test exercises the same recommendation-cleaning path as the other endpoint-mode tests, but with the focus narrowed to remote plugin ID validation. It confirms that invalid identity data does not travel onward to the rest of the plugin system.

*Call graph*: 2 external calls (assert_eq!, vec!).


### Plugin lifecycle and discovery flows
This group moves from startup synchronization and remote sharing into manager-level orchestration, discoverability, routing, and the core-facing plugin adapters and mention/render behavior.

### `core-plugins/src/startup_sync_tests.rs`

`test` · `test suite`

These tests act like a safety checklist for the curated plugin sync feature. That feature keeps a local copy of OpenAI’s plugin marketplace under the user’s Codex home directory. Without tests like these, a failed download, broken Git command, bad archive, or race between two startup syncs could leave users with missing or half-written plugins.

The file builds small fake plugin repositories in temporary folders, then runs the real sync functions against them. For Git tests, it either creates a real local Git repository or writes tiny fake “git” shell scripts that return controlled answers. For HTTP tests, it starts a mock web server that pretends to be GitHub or the backup export service. The tests then inspect the files on disk to make sure the synced repository contains the expected marketplace file and plugin manifests.

A recurring idea is staging: new plugin content is first placed in a temporary clone directory, like unpacking groceries on the counter before putting them in the fridge. If validation fails, the old snapshot should remain untouched. The tests also verify cleanup of stale temporary directories, skipping downloads when the saved SHA already matches, and serializing concurrent syncs so two startups do not corrupt the same local copy.

#### Function details

##### `write_file`  (lines 19–22)

```
fn write_file(path: &Path, contents: &str)
```

**Purpose**: Writes a text file for a test, creating its parent folders first. Tests use it to build fake plugin repositories without repeating setup code.

**Data flow**: It receives a file path and text contents. It makes sure the folder containing that file exists, then writes the text to disk. The result is a real file ready for the sync code or assertions to read.

**Call relations**: This is the small file-writing helper behind the repository fixtures. The marketplace and plugin fixture builders call it whenever they need to lay down JSON files in a temporary test directory.

*Call graph*: called by 3 (write_curated_plugin, write_curated_plugin_sha, write_openai_curated_marketplace); 3 external calls (parent, create_dir_all, write).


##### `write_curated_plugin`  (lines 24–30)

```
fn write_curated_plugin(root: &Path, plugin_name: &str)
```

**Purpose**: Creates the minimal files for one fake curated plugin. It gives tests a plugin folder with a plugin manifest, which is enough for validation to recognize it.

**Data flow**: It takes a root folder and a plugin name. From those it builds a path like plugins/<name>/.codex-plugin/plugin.json and writes a tiny JSON manifest naming the plugin. The output is a small on-disk plugin fixture.

**Call relations**: This helper is used by write_openai_curated_marketplace after that function writes the marketplace list. Together they create a consistent fake curated plugin repository.

*Call graph*: calls 1 internal fn (write_file); called by 1 (write_openai_curated_marketplace); 2 external calls (join, format!).


##### `write_openai_curated_marketplace`  (lines 32–62)

```
fn write_openai_curated_marketplace(root: &Path, plugin_names: &[&str])
```

**Purpose**: Creates a fake OpenAI curated marketplace and all plugin folders named in it. Tests use this to represent an already-synced or newly-created local plugin snapshot.

**Data flow**: It receives a root folder and a list of plugin names. It writes .agents/plugins/marketplace.json with entries pointing to local plugin paths, then creates each plugin’s manifest. The result is a repository-shaped directory that should pass curated plugin validation.

**Call relations**: Several tests call this when they need a known-good snapshot before running sync logic. It delegates the per-plugin file creation to write_curated_plugin.

*Call graph*: calls 2 internal fn (write_curated_plugin, write_file); called by 3 (sync_openai_plugins_repo_skips_export_archive_when_snapshot_exists, sync_openai_plugins_repo_via_git_preserves_existing_snapshot_on_validation_failure, sync_openai_plugins_repo_via_git_succeeds_with_local_rewritten_remote); 2 external calls (join, format!).


##### `write_curated_plugin_sha`  (lines 64–69)

```
fn write_curated_plugin_sha(codex_home: &Path)
```

**Purpose**: Writes the saved commit SHA for the curated plugin snapshot. This simulates Codex remembering which plugin version it last synced.

**Data flow**: It receives the Codex home folder. It writes the test SHA into .tmp/plugins.sha, including a newline just like a normal text file. Later checks read this file to decide whether a sync is current.

**Call relations**: Tests that start with an existing snapshot call this before running failure or fallback scenarios. It relies on write_file to create the needed .tmp folder.

*Call graph*: calls 1 internal fn (write_file); called by 2 (sync_openai_plugins_repo_skips_export_archive_when_snapshot_exists, sync_openai_plugins_repo_via_git_preserves_existing_snapshot_on_validation_failure); 2 external calls (join, format!).


##### `has_plugins_clone_dirs`  (lines 71–84)

```
fn has_plugins_clone_dirs(codex_home: &Path) -> bool
```

**Purpose**: Checks whether temporary plugin clone directories are still lying around. Tests use it to confirm failed syncs clean up after themselves.

**Data flow**: It looks inside the Codex home .tmp directory. If that directory cannot be read, it returns false. Otherwise it scans for directories whose names begin with plugins-clone- and returns true if it finds any.

**Call relations**: This helper is used by assertions throughout the file after Git or HTTP sync attempts. It verifies that staging directories were removed once the sync either succeeded or failed.

*Call graph*: 2 external calls (join, read_dir).


##### `write_executable_script`  (lines 87–98)

```
fn write_executable_script(path: &Path, contents: &str)
```

**Purpose**: Writes a shell script and marks it executable on Unix systems. Tests use this to create fake Git commands with predictable behavior.

**Data flow**: It receives a script path and script text. It writes the text to disk, reads the file permissions, changes them so the file can be run, and saves those permissions. The result is a runnable test program.

**Call relations**: Unix-only tests call this to replace the real git command with a controlled script. Those fake scripts simulate success, failure, slow remote checks, and invalid checkouts.

*Call graph*: called by 5 (concurrent_syncs_serialize_fetches_without_skipping_remote_checks, sync_openai_plugins_repo_falls_back_to_http_when_git_sync_fails, sync_openai_plugins_repo_via_git_cleans_up_staged_dir_on_fetch_failure, sync_openai_plugins_repo_via_git_preserves_existing_snapshot_on_validation_failure, sync_openai_plugins_repo_via_git_succeeds_with_local_rewritten_remote); 3 external calls (metadata, set_permissions, write).


##### `run_git`  (lines 101–114)

```
fn run_git(repo: &Path, args: &[&str]) -> std::process::Output
```

**Purpose**: Runs a real Git command in a given repository and fails the test if Git reports an error. It keeps the larger Git integration test readable.

**Data flow**: It receives a repository path and command arguments. It executes git -C <repo> with those arguments, checks that the exit status was successful, and returns Git’s captured output. If Git fails, the test stops with Git’s error text.

**Call relations**: The local rewritten remote test uses this helper to create commits, read SHAs, find the current branch, and push updates. It is the bridge between the test setup and the real Git program.

*Call graph*: called by 1 (sync_openai_plugins_repo_via_git_succeeds_with_local_rewritten_remote); 2 external calls (assert!, new).


##### `mount_github_repo_and_ref`  (lines 116–130)

```
async fn mount_github_repo_and_ref(server: &MockServer, sha: &str)
```

**Purpose**: Programs the mock server to answer the two GitHub API requests needed to discover the current curated plugin SHA. This lets HTTP sync tests run without contacting GitHub.

**Data flow**: It receives a mock server and a SHA. It registers one response for the repository metadata endpoint and another for the main branch reference endpoint. Afterward, sync code that calls those URLs receives the supplied SHA.

**Call relations**: HTTP fallback and skip-download tests call this before running sync. It sets up the remote-check part of the story, while mount_github_zipball supplies the archive content when needed.

*Call graph*: called by 4 (sync_openai_plugins_repo_falls_back_to_http_when_git_is_unavailable, sync_openai_plugins_repo_falls_back_to_http_when_git_sync_fails, sync_openai_plugins_repo_skips_archive_download_when_sha_matches, sync_openai_plugins_repo_via_http_cleans_up_staged_dir_on_extract_failure); 5 external calls (given, new, format!, method, path).


##### `mount_github_zipball`  (lines 132–142)

```
async fn mount_github_zipball(server: &MockServer, sha: &str, bytes: Vec<u8>)
```

**Purpose**: Programs the mock server to return a zip archive for a specific plugin repository SHA. Tests use it to simulate downloading GitHub’s zipball.

**Data flow**: It receives a mock server, a SHA, and raw zip bytes. It registers a GET response at the matching zipball URL with a zip content type and those bytes as the body. The output is mock server behavior, not a returned value.

**Call relations**: Fallback-to-HTTP tests call this after mounting the GitHub ref response. The sync code then downloads these bytes and tries to extract them as the curated plugins repository.

*Call graph*: called by 3 (sync_openai_plugins_repo_falls_back_to_http_when_git_is_unavailable, sync_openai_plugins_repo_falls_back_to_http_when_git_sync_fails, sync_openai_plugins_repo_via_http_cleans_up_staged_dir_on_extract_failure); 5 external calls (given, new, format!, method, path).


##### `mount_export_archive`  (lines 144–164)

```
async fn mount_export_archive(server: &MockServer, bytes: Vec<u8>) -> String
```

**Purpose**: Programs the mock server to mimic the backup export service. This backup path is used when normal GitHub-based sync cannot start and no local snapshot exists.

**Data flow**: It receives a mock server and archive bytes. It registers one endpoint that returns a JSON download URL, then registers that download URL to return the zip bytes. It returns the export API URL that the sync function should call.

**Call relations**: The export fallback tests call this before running sync with transport overrides. It supplies the backup archive path when the mocked GitHub request is made to fail.

*Call graph*: called by 2 (sync_openai_plugins_repo_falls_back_to_export_archive_when_no_snapshot_exists, sync_openai_plugins_repo_skips_export_archive_when_snapshot_exists); 5 external calls (given, new, format!, method, path).


##### `run_sync_with_transport_overrides`  (lines 166–185)

```
async fn run_sync_with_transport_overrides(
    codex_home: PathBuf,
    git_binary: impl Into<String>,
    api_base_url: impl Into<String>,
    backup_archive_api_url: impl Into<String>,
) -> Result<
```

**Purpose**: Runs the full plugin sync with test-controlled transport settings. It lets tests choose a fake Git binary, a fake GitHub base URL, and a fake backup export URL.

**Data flow**: It receives the Codex home path and three transport strings. It moves those values into a blocking background task, calls the real sync function with them, waits for completion, and returns either the synced SHA or an error string.

**Call relations**: Async tests call this because the real sync work is blocking disk and process work. It connects mock servers and fake Git commands to the production sync entry point with overrideable URLs.

*Call graph*: called by 5 (sync_openai_plugins_repo_falls_back_to_export_archive_when_no_snapshot_exists, sync_openai_plugins_repo_falls_back_to_http_when_git_is_unavailable, sync_openai_plugins_repo_falls_back_to_http_when_git_sync_fails, sync_openai_plugins_repo_skips_archive_download_when_sha_matches, sync_openai_plugins_repo_skips_export_archive_when_snapshot_exists); 2 external calls (into, spawn_blocking).


##### `run_http_sync`  (lines 187–197)

```
async fn run_http_sync(
    codex_home: PathBuf,
    api_base_url: impl Into<String>,
) -> Result<String, String>
```

**Purpose**: Runs the HTTP-only curated plugin sync from an async test. It is used when the test wants to focus on zip download and extraction behavior.

**Data flow**: It receives a Codex home path and API base URL. It runs the HTTP sync function in a blocking background task, waits for it to finish, and returns the resulting SHA or error text.

**Call relations**: The bad-zip extraction test calls this after preparing mock GitHub responses. It isolates the HTTP path instead of going through the broader Git-then-HTTP fallback wrapper.

*Call graph*: called by 1 (sync_openai_plugins_repo_via_http_cleans_up_staged_dir_on_extract_failure); 2 external calls (into, spawn_blocking).


##### `assert_curated_gmail_repo`  (lines 199–206)

```
fn assert_curated_gmail_repo(repo_path: &Path)
```

**Purpose**: Checks that a synced repository contains the expected marketplace file and Gmail plugin manifest. It is a shared assertion for successful sync tests.

**Data flow**: It receives a repository path. It checks for .agents/plugins/marketplace.json and plugins/gmail/.codex-plugin/plugin.json. It does not return data; it fails the test if either file is missing.

**Call relations**: Many success-oriented tests call this after a sync completes. It gives a simple proof that the resulting folder is not just present, but shaped like a usable curated plugin repository.

*Call graph*: called by 6 (concurrent_syncs_serialize_fetches_without_skipping_remote_checks, sync_openai_plugins_repo_falls_back_to_export_archive_when_no_snapshot_exists, sync_openai_plugins_repo_falls_back_to_http_when_git_is_unavailable, sync_openai_plugins_repo_falls_back_to_http_when_git_sync_fails, sync_openai_plugins_repo_via_git_preserves_existing_snapshot_on_validation_failure, sync_openai_plugins_repo_via_git_succeeds_with_local_rewritten_remote); 1 external calls (assert!).


##### `curated_plugins_repo_path_uses_codex_home_tmp_dir`  (lines 209–215)

```
fn curated_plugins_repo_path_uses_codex_home_tmp_dir()
```

**Purpose**: Verifies that the curated plugins repository is stored under the Codex home .tmp/plugins directory. This protects the expected on-disk layout.

**Data flow**: It creates a temporary Codex home path, asks the production path helper for the curated repo location, and compares the answer to <home>/.tmp/plugins. The output is a pass or failed assertion.

**Call relations**: This standalone unit test checks the basic path convention that the rest of the sync tests assume when they inspect files.

*Call graph*: 2 external calls (assert_eq!, tempdir).


##### `read_curated_plugins_sha_reads_trimmed_sha_file`  (lines 218–227)

```
fn read_curated_plugins_sha_reads_trimmed_sha_file()
```

**Purpose**: Verifies that the saved plugin SHA is read without its trailing newline. This matters because SHA comparisons should not fail just because the file is line-based.

**Data flow**: It creates .tmp/plugins.sha containing abc123 followed by a newline, calls the production reader, and expects to receive abc123. The test changes only temporary files.

**Call relations**: This test covers the SHA-reading helper used by sync decisions. Other tests rely on the same behavior when checking whether the stored snapshot version matches the remote one.

*Call graph*: 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `remove_stale_curated_repo_temp_dirs_removes_only_matching_directories`  (lines 231–270)

```
fn remove_stale_curated_repo_temp_dirs_removes_only_matching_directories()
```

**Purpose**: Verifies that old temporary plugin clone folders are deleted, while fresh clone folders and unrelated folders are kept. This prevents cleanup from being too aggressive.

**Data flow**: It creates three directories: an old plugins-clone directory, a fresh plugins-clone directory, and an unrelated cache directory. It changes their modification times, runs the cleanup function, then checks that only the old matching directory disappeared.

**Call relations**: This Unix-only test exercises the cleanup behavior used before or during sync. It protects against both disk clutter from stale staging folders and accidental deletion of unrelated data.

*Call graph*: 4 external calls (from_secs, assert!, create_dir_all, tempdir).


##### `concurrent_syncs_serialize_fetches_without_skipping_remote_checks`  (lines 274–367)

```
fn concurrent_syncs_serialize_fetches_without_skipping_remote_checks()
```

**Purpose**: Verifies that two syncs running at the same time do not both fetch into the repository, but both still check the remote version. This prevents races while keeping update checks accurate.

**Data flow**: It creates a fake Git script that logs every invocation and simulates a slow remote SHA check. Two threads start sync at the same time. After both finish, the test checks the synced files, saved SHA, and invocation log: two remote checks happened, only one fetch happened, and no Git clone command was used.

**Call relations**: This test uses write_executable_script to build the fake Git command and assert_curated_gmail_repo to verify the final snapshot. It directly exercises the production sync wrapper under concurrent pressure.

*Call graph*: calls 2 internal fn (assert_curated_gmail_repo, write_executable_script); 8 external calls (new, assert!, assert_eq!, format!, read_to_string, scope, new, tempdir).


##### `sync_openai_plugins_repo_via_git_succeeds_with_local_rewritten_remote`  (lines 371–579)

```
fn sync_openai_plugins_repo_via_git_succeeds_with_local_rewritten_remote()
```

**Purpose**: Tests the normal Git-based sync path using a local repository that pretends to be GitHub. It also checks incremental updates and the no-change fast path.

**Data flow**: It builds a real Git repository containing a Gmail plugin, clones it as a bare remote, and uses a Git config rewrite so https://github.com/openai/plugins.git points to that local remote. It runs the sync, checks the saved SHA and files, commits a new Linear plugin, syncs again, and finally syncs once more with no changes. The expected outcome is correct files, correct SHAs, no leftover temporary clone directories, and efficient Git commands.

**Call relations**: This is the broadest Git integration test in the file. It uses run_git for real repository operations, write_executable_script to wrap Git and log calls, write_openai_curated_marketplace to update fixture content, and assert_curated_gmail_repo to confirm the synced checkout.

*Call graph*: calls 4 internal fn (assert_curated_gmail_repo, run_git, write_executable_script, write_openai_curated_marketplace); 10 external calls (from_utf8_lossy, assert!, assert_eq!, new, format!, create_dir_all, read_to_string, write, new, tempdir).


##### `sync_openai_plugins_repo_falls_back_to_http_when_git_is_unavailable`  (lines 582–603)

```
async fn sync_openai_plugins_repo_falls_back_to_http_when_git_is_unavailable()
```

**Purpose**: Verifies that sync still works when the Git executable cannot be found. In that case, the system should download the curated plugins as a zip over HTTP.

**Data flow**: It starts a mock server, teaches it the remote SHA and zipball content, then runs sync with a deliberately missing Git binary. The result should be the expected SHA, a usable Gmail plugin repository, and a saved plugins.sha file.

**Call relations**: This async test combines mount_github_repo_and_ref, mount_github_zipball, curated_repo_zipball_bytes, and run_sync_with_transport_overrides. It proves the fallback path takes over when Git cannot even start.

*Call graph*: calls 5 internal fn (assert_curated_gmail_repo, curated_repo_zipball_bytes, mount_github_repo_and_ref, mount_github_zipball, run_sync_with_transport_overrides); 3 external calls (start, assert_eq!, tempdir).


##### `sync_openai_plugins_repo_falls_back_to_http_when_git_sync_fails`  (lines 607–641)

```
async fn sync_openai_plugins_repo_falls_back_to_http_when_git_sync_fails()
```

**Purpose**: Verifies that HTTP sync is used when Git exists but returns an error. This covers machines where Git is installed but broken or blocked.

**Data flow**: It writes a fake Git script that always exits with failure, prepares mock GitHub responses with a valid zipball, and runs sync. The expected output is a successful SHA and a valid local curated plugin snapshot despite the Git failure.

**Call relations**: This Unix-only async test uses write_executable_script for the failing Git command, the mock-mount helpers for the HTTP path, and assert_curated_gmail_repo to confirm fallback success.

*Call graph*: calls 6 internal fn (assert_curated_gmail_repo, curated_repo_zipball_bytes, mount_github_repo_and_ref, mount_github_zipball, run_sync_with_transport_overrides, write_executable_script); 4 external calls (start, assert_eq!, new, tempdir).


##### `sync_openai_plugins_repo_via_git_cleans_up_staged_dir_on_fetch_failure`  (lines 645–681)

```
fn sync_openai_plugins_repo_via_git_cleans_up_staged_dir_on_fetch_failure()
```

**Purpose**: Verifies that a failed Git fetch does not leave temporary clone directories behind. This keeps the user’s .tmp folder from collecting broken partial checkouts.

**Data flow**: It creates a fake Git script that reports a remote SHA, initializes a staged repository, then fails during fetch with an error message. The test runs Git sync, expects that error, and checks that no plugins-clone-* directories remain.

**Call relations**: This Unix-only test uses write_executable_script to simulate a partial Git failure and has_plugins_clone_dirs to verify cleanup. It focuses on failure hygiene rather than successful plugin content.

*Call graph*: calls 1 internal fn (write_executable_script); 4 external calls (assert!, format!, new, tempdir).


##### `sync_openai_plugins_repo_via_git_preserves_existing_snapshot_on_validation_failure`  (lines 685–752)

```
fn sync_openai_plugins_repo_via_git_preserves_existing_snapshot_on_validation_failure()
```

**Purpose**: Verifies that a bad newly-fetched snapshot does not replace a good existing snapshot. This protects users from losing working plugins because a remote archive is malformed.

**Data flow**: It first creates a valid existing Gmail snapshot and saved SHA. Then it uses a fake Git script to stage an update that contains a plugin file but no marketplace manifest, which should fail validation. The test expects an error, confirms the old Gmail snapshot is still present, confirms the bad Linear folder was not installed, and checks the old SHA remains saved.

**Call relations**: This test combines fixture writers, fake Git scripting, assert_curated_gmail_repo, and clone-directory cleanup checks. It exercises the staged-update safety rule: validate first, replace only after success.

*Call graph*: calls 4 internal fn (assert_curated_gmail_repo, write_curated_plugin_sha, write_executable_script, write_openai_curated_marketplace); 6 external calls (assert!, assert_eq!, format!, create_dir_all, new, tempdir).


##### `sync_openai_plugins_repo_via_http_cleans_up_staged_dir_on_extract_failure`  (lines 755–769)

```
async fn sync_openai_plugins_repo_via_http_cleans_up_staged_dir_on_extract_failure()
```

**Purpose**: Verifies that the HTTP sync path cleans up its temporary directory when the downloaded file is not a valid zip archive.

**Data flow**: It prepares mock GitHub responses where the SHA lookup succeeds but the zipball body is plain invalid bytes. It runs HTTP sync, expects an archive-opening error, and checks that no temporary plugin clone directories remain.

**Call relations**: This async test uses mount_github_repo_and_ref, mount_github_zipball, and run_http_sync. It mirrors the Git cleanup test for the zip extraction path.

*Call graph*: calls 3 internal fn (mount_github_repo_and_ref, mount_github_zipball, run_http_sync); 3 external calls (start, assert!, tempdir).


##### `sync_openai_plugins_repo_skips_archive_download_when_sha_matches`  (lines 772–799)

```
async fn sync_openai_plugins_repo_skips_archive_download_when_sha_matches()
```

**Purpose**: Verifies that the sync process does not download a zip archive when the locally saved SHA already matches the remote SHA. This avoids unnecessary network and disk work.

**Data flow**: It creates an existing local repository and writes a matching plugins.sha file. The mock server only needs to answer the remote SHA lookup. After sync runs with Git unavailable, the test confirms the saved SHA and existing marketplace file are still there.

**Call relations**: This test uses mount_github_repo_and_ref and run_sync_with_transport_overrides. Because no zipball mock is registered, the test would fail if the sync incorrectly tried to download an archive.

*Call graph*: calls 2 internal fn (mount_github_repo_and_ref, run_sync_with_transport_overrides); 7 external calls (start, assert!, assert_eq!, format!, create_dir_all, write, tempdir).


##### `sync_openai_plugins_repo_falls_back_to_export_archive_when_no_snapshot_exists`  (lines 802–831)

```
async fn sync_openai_plugins_repo_falls_back_to_export_archive_when_no_snapshot_exists()
```

**Purpose**: Verifies the last-resort backup archive path. If GitHub lookup fails and there is no local snapshot, sync should be able to use an export archive instead.

**Data flow**: It makes the mock GitHub repository lookup return an error, then mounts a backup export archive containing a Git SHA and Gmail plugin files. Sync runs with Git unavailable and the backup URL supplied. The expected result is the backup SHA, valid plugin files, and a saved SHA file.

**Call relations**: This async test uses mount_export_archive, curated_repo_backup_archive_zip_bytes, run_sync_with_transport_overrides, and assert_curated_gmail_repo. It covers the emergency path used when the normal remote source is unavailable.

*Call graph*: calls 4 internal fn (assert_curated_gmail_repo, curated_repo_backup_archive_zip_bytes, mount_export_archive, run_sync_with_transport_overrides); 7 external calls (given, start, new, assert_eq!, tempdir, method, path).


##### `sync_openai_plugins_repo_skips_export_archive_when_snapshot_exists`  (lines 834–875)

```
async fn sync_openai_plugins_repo_skips_export_archive_when_snapshot_exists()
```

**Purpose**: Verifies that the backup export archive is not used when a local snapshot already exists. This avoids replacing a known local copy with a fallback source after a temporary GitHub failure.

**Data flow**: It creates an existing Linear plugin snapshot and saved SHA, then makes the GitHub lookup fail while also offering a backup archive with different content. Sync is expected to return an error saying export fallback was skipped. The test confirms the original plugin manifest and saved SHA did not change.

**Call relations**: This test uses write_openai_curated_marketplace and write_curated_plugin_sha to create the starting snapshot, then mount_export_archive and run_sync_with_transport_overrides to simulate the failed remote plus available backup. It checks the policy decision around when fallback is allowed.

*Call graph*: calls 5 internal fn (curated_repo_backup_archive_zip_bytes, mount_export_archive, run_sync_with_transport_overrides, write_curated_plugin_sha, write_openai_curated_marketplace); 9 external calls (given, start, new, assert!, assert_eq!, read_to_string, tempdir, method, path).


##### `read_extracted_backup_archive_git_sha_reads_head_ref_from_extracted_repo`  (lines 878–894)

```
fn read_extracted_backup_archive_git_sha_reads_head_ref_from_extracted_repo()
```

**Purpose**: Verifies that the backup archive SHA reader can follow a normal Git HEAD reference. Backup archives include a .git directory, and this function must recover the commit SHA from it.

**Data flow**: It creates .git/HEAD pointing to refs/heads/main and writes a SHA into that ref file. It calls the production reader and expects that SHA back without the newline.

**Call relations**: This standalone unit test supports the export archive tests. It checks the helper that identifies which commit an extracted backup archive represents.

*Call graph*: 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `read_extracted_backup_archive_git_sha_rejects_non_refs_head_target`  (lines 897–906)

```
fn read_extracted_backup_archive_git_sha_rejects_non_refs_head_target()
```

**Purpose**: Verifies that the backup archive SHA reader rejects a HEAD reference that does not stay under refs/. This is a safety check against unexpected or unsafe Git metadata.

**Data flow**: It writes .git/HEAD containing ref: HEAD rather than a refs/... path. It calls the SHA reader, expects an error, and checks that the error explains the ref must stay under refs/.

**Call relations**: This test focuses on defensive validation in the backup archive reader. It pairs with the path traversal test to make sure extracted Git metadata cannot point wherever it wants.

*Call graph*: 4 external calls (assert!, create_dir_all, write, tempdir).


##### `read_extracted_backup_archive_git_sha_rejects_path_traversal_ref`  (lines 909–919)

```
fn read_extracted_backup_archive_git_sha_rejects_path_traversal_ref()
```

**Purpose**: Verifies that the backup archive SHA reader rejects references containing path traversal, such as ../. This prevents archive metadata from escaping the intended .git/refs area.

**Data flow**: It writes .git/HEAD pointing to refs/heads/../../evil. It calls the SHA reader, expects an error, and checks that the error mentions invalid path components.

**Call relations**: This unit test protects the same backup archive SHA-reading path used by export fallback. It specifically checks that suspicious reference paths are blocked before any ref file is read.

*Call graph*: 4 external calls (assert!, create_dir_all, write, tempdir).


##### `curated_repo_zipball_bytes`  (lines 921–956)

```
fn curated_repo_zipball_bytes(sha: &str) -> Vec<u8>
```

**Purpose**: Builds an in-memory zip file shaped like GitHub’s repository zipball for the curated plugins repo. Tests use it as mock download content.

**Data flow**: It receives a SHA, creates a zip archive in memory with a top-level folder named like openai-plugins-<sha>, and writes a marketplace file plus a Gmail plugin manifest inside. It returns the zip bytes.

**Call relations**: HTTP fallback tests pass these bytes to mount_github_zipball. The sync code then downloads and extracts the generated archive as if it came from GitHub.

*Call graph*: calls 1 internal fn (new); called by 2 (sync_openai_plugins_repo_falls_back_to_http_when_git_is_unavailable, sync_openai_plugins_repo_falls_back_to_http_when_git_sync_fails); 4 external calls (default, new, new, format!).


##### `curated_repo_backup_archive_zip_bytes`  (lines 958–1002)

```
fn curated_repo_backup_archive_zip_bytes(sha: &str) -> Vec<u8>
```

**Purpose**: Builds an in-memory backup export archive containing both plugin files and minimal Git metadata. Tests use it to simulate the export fallback service.

**Data flow**: It receives a SHA, creates a zip archive in memory, writes .git/HEAD and refs/heads/main carrying that SHA, then writes the marketplace and Gmail plugin manifest under the plugins folder. It returns the zip bytes.

**Call relations**: Export fallback tests pass these bytes to mount_export_archive. The production sync code extracts the archive, reads the embedded Git SHA, validates the plugin repository, and installs it if allowed.

*Call graph*: calls 1 internal fn (new); called by 2 (sync_openai_plugins_repo_falls_back_to_export_archive_when_no_snapshot_exists, sync_openai_plugins_repo_skips_export_archive_when_snapshot_exists); 4 external calls (default, new, new, format!).


### `core-plugins/src/remote/share/tests.rs`

`test` · `test run`

This is a test file. It builds small fake plugins on disk, starts a fake HTTP server, and then exercises the remote plugin sharing code as if it were talking to the real ChatGPT backend. The fake server lets the tests check every important detail: which web address is called, which headers are sent, what JSON body is uploaded, and what the code does with the server response.

The file covers the full life of a shared workspace plugin. First, it checks that a local plugin folder is turned into a compressed tar archive, like putting a folder into a zip file before mailing it. It verifies that the plugin manifest stays at the archive root, long file paths survive the round trip, and over-large archives are rejected. Then it tests creating a new remote share: asking the backend for an upload URL, uploading the archive, creating the workspace plugin, and saving a local mapping from remote plugin ID to local path. It also tests updating an existing remote plugin, changing who it is shared with, listing shared plugins across pages, detecting whether a listed plugin is already installed, and deleting a share while removing its saved local mapping.

Without these tests, changes to the sharing code could silently break the contract with the backend or corrupt the plugin archive format.

#### Function details

##### `test_config`  (lines 25–29)

```
fn test_config(server: &MockServer) -> RemotePluginServiceConfig
```

**Purpose**: Builds a test-only remote service configuration that points at the fake HTTP server instead of the real ChatGPT service. Tests use it so all network calls stay local and predictable.

**Data flow**: It receives a running fake server. It reads the server's base URL, appends the backend API path, and returns a RemotePluginServiceConfig containing that test URL.

**Call relations**: The main async tests call this after starting a MockServer. The resulting config is then passed into remote sharing functions such as saving, listing, updating, and deleting shares, so those functions talk to the fake server prepared by the test.

*Call graph*: called by 5 (delete_remote_plugin_share_deletes_workspace_plugin, list_remote_plugin_shares_fetches_created_workspace_plugins, save_remote_plugin_share_creates_workspace_plugin, save_remote_plugin_share_updates_existing_workspace_plugin, update_remote_plugin_share_targets_updates_targets); 1 external calls (format!).


##### `test_auth`  (lines 31–33)

```
fn test_auth() -> CodexAuth
```

**Purpose**: Creates fake ChatGPT authentication data for tests. This lets the code send realistic authorization headers without requiring a real user login.

**Data flow**: It takes no input. It asks the authentication library for a dummy test credential and returns that credential to the caller.

**Call relations**: The network-facing tests call this before invoking remote sharing functions. Those functions use the returned credential to add the expected bearer token and account ID headers, which the fake server checks.

*Call graph*: calls 1 internal fn (create_dummy_chatgpt_auth_for_testing); called by 5 (delete_remote_plugin_share_deletes_workspace_plugin, list_remote_plugin_shares_fetches_created_workspace_plugins, save_remote_plugin_share_creates_workspace_plugin, save_remote_plugin_share_updates_existing_workspace_plugin, update_remote_plugin_share_targets_updates_targets).


##### `write_file`  (lines 35–38)

```
fn write_file(path: &Path, contents: &str)
```

**Purpose**: Writes a file during a test, creating parent folders first if needed. It is a small helper for building fake plugin directories and local metadata files.

**Data flow**: It receives a file path and text contents. It makes sure the containing directory exists, then writes the text to the file. It returns nothing, but changes the temporary test filesystem.

**Call relations**: Higher-level helpers call this when constructing plugins and saved local-path mappings. A few archive tests also call it directly to add special files, such as an intentionally large file or a file with a long path.

*Call graph*: called by 4 (archive_plugin_for_upload_rejects_archives_over_limit, archive_plugin_for_upload_round_trips_through_plugin_bundle_archive_with_long_paths, write_plugin_share_local_path_mapping, write_test_plugin); 3 external calls (parent, create_dir_all, write).


##### `write_test_plugin`  (lines 40–51)

```
fn write_test_plugin(root: &Path, plugin_name: &str) -> PathBuf
```

**Purpose**: Creates a minimal fake plugin folder for tests. The plugin has just enough structure to look like a real Codex plugin: a manifest and one skill file.

**Data flow**: It receives a root directory and a plugin name. It creates a subdirectory with that name, writes .codex-plugin/plugin.json, writes a sample skill markdown file, and returns the path to the plugin folder.

**Call relations**: Most archive and upload tests call this first to get a realistic local plugin. It relies on write_file for the actual disk writes, then hands the resulting path to packaging and remote-sharing functions.

*Call graph*: calls 1 internal fn (write_file); called by 5 (archive_plugin_for_upload_places_manifest_at_archive_root, archive_plugin_for_upload_rejects_archives_over_limit, archive_plugin_for_upload_round_trips_through_plugin_bundle_archive_with_long_paths, save_remote_plugin_share_creates_workspace_plugin, save_remote_plugin_share_updates_existing_workspace_plugin); 2 external calls (join, format!).


##### `write_plugin_share_local_path_mapping`  (lines 53–70)

```
fn write_plugin_share_local_path_mapping(
    codex_home: &Path,
    remote_plugin_id: &str,
    plugin_path: &AbsolutePathBuf,
)
```

**Purpose**: Creates the local bookkeeping file that remembers which local plugin path belongs to a remote plugin ID. Tests use this to simulate a user who has already shared a plugin before.

**Data flow**: It receives the Codex home directory, a remote plugin ID, and an absolute local plugin path. It writes a JSON file under the temporary Codex home that maps the remote ID to the local path.

**Call relations**: The list and delete tests call this before running the code under test. Listing should read this saved mapping and include the local path in its result; deleting should remove the mapping afterward.

*Call graph*: calls 1 internal fn (write_file); called by 2 (delete_remote_plugin_share_deletes_workspace_plugin, list_remote_plugin_shares_fetches_created_workspace_plugins); 2 external calls (join, format!).


##### `archive_file_entries`  (lines 72–89)

```
fn archive_file_entries(archive_bytes: &[u8]) -> BTreeMap<String, Vec<u8>>
```

**Purpose**: Opens a compressed plugin archive and returns the regular files inside it. Tests use this to inspect what was actually uploaded or produced by the archive builder.

**Data flow**: It receives bytes for a gzip-compressed tar archive. It decompresses the bytes, walks through the archive entries, skips anything that is not a file, reads each file's contents, and returns a sorted map from archive path to file bytes.

**Call relations**: Archive tests call this after creating an upload archive. The create-share test also uses it on the body of the fake upload request, proving that the remote upload contained the expected plugin files.

*Call graph*: called by 2 (archive_plugin_for_upload_places_manifest_at_archive_root, save_remote_plugin_share_creates_workspace_plugin); 2 external calls (new, new).


##### `remote_plugin_json`  (lines 91–110)

```
fn remote_plugin_json(plugin_id: &str) -> serde_json::Value
```

**Purpose**: Builds a standard fake JSON description of a remote plugin. This keeps the mock backend responses consistent across tests.

**Data flow**: It receives a plugin ID. It returns a JSON object with that ID, a demo plugin name, workspace scope, policies, version, description, interface details, and an empty skill list.

**Call relations**: Other JSON helper functions build on this base object. Tests use those helpers in fake server responses so the production parsing code sees data shaped like the real backend would send.

*Call graph*: called by 2 (installed_remote_plugin_json, remote_plugin_json_with_share_url_and_principals); 1 external calls (json!).


##### `remote_plugin_json_with_share_url_and_principals`  (lines 112–125)

```
fn remote_plugin_json_with_share_url_and_principals(
    plugin_id: &str,
    share_url: Option<&str>,
    share_principals: serde_json::Value,
) -> serde_json::Value
```

**Purpose**: Builds fake remote plugin JSON that includes sharing information, such as a share link and the people or groups the plugin is shared with.

**Data flow**: It receives a plugin ID, an optional share URL, and JSON describing share principals. It starts with the standard remote plugin JSON, adds or overrides the sharing-related fields, and returns the enriched JSON object.

**Call relations**: The list-shares test uses this helper when preparing paginated fake backend responses. It depends on remote_plugin_json for the common plugin fields, then adds the fields needed to test share-specific parsing.

*Call graph*: calls 1 internal fn (remote_plugin_json); 2 external calls (json!, unreachable!).


##### `installed_remote_plugin_json`  (lines 127–135)

```
fn installed_remote_plugin_json(plugin_id: &str) -> serde_json::Value
```

**Purpose**: Builds fake JSON for a remote plugin that is already installed and enabled. This lets list tests check that installed status is merged into share results.

**Data flow**: It receives a plugin ID. It starts with the standard remote plugin JSON, adds enabled status and an empty list of disabled skills, and returns the JSON object.

**Call relations**: The list-shares test uses this in the fake response for installed workspace plugins. It depends on remote_plugin_json for the common fields and adds the installation state that the code under test should recognize.

*Call graph*: calls 1 internal fn (remote_plugin_json); 2 external calls (json!, unreachable!).


##### `empty_pagination_json`  (lines 137–141)

```
fn empty_pagination_json() -> serde_json::Value
```

**Purpose**: Creates the small JSON object that means there are no more pages of results. Tests use it to end a fake paginated backend response.

**Data flow**: It takes no input. It returns JSON with next_page_token set to null.

**Call relations**: The list-shares test uses this in mock responses for the final page of created plugins and for installed plugins. This tells the code under test to stop asking the fake backend for more pages.

*Call graph*: 1 external calls (json!).


##### `expected_plugin_interface`  (lines 143–163)

```
fn expected_plugin_interface() -> PluginInterface
```

**Purpose**: Builds the Rust data structure that should result from parsing the fake plugin interface JSON. It gives the list test a clear expected value to compare against.

**Data flow**: It takes no input. It returns a PluginInterface with the demo display name, short description, capabilities, and all unrelated optional fields left empty.

**Call relations**: The list-shares test calls this while building its expected RemotePluginSummary values. It mirrors the interface fields produced by remote_plugin_json, so the assertion checks that JSON parsing preserved the important display information.

*Call graph*: 2 external calls (new, vec!).


##### `save_remote_plugin_share_creates_workspace_plugin`  (lines 166–280)

```
async fn save_remote_plugin_share_creates_workspace_plugin()
```

**Purpose**: Tests the happy path for sharing a local plugin for the first time. It proves that the code archives the plugin, uploads it, creates a remote workspace plugin, records the local path, and returns the new share details.

**Data flow**: The test creates temporary folders, writes a fake plugin, calculates the archive size, starts a fake server, and defines expected HTTP calls. It then calls save_remote_plugin_share with no existing remote plugin ID. The result should contain the new remote plugin ID and share URL, the local mapping file should be updated, and the uploaded archive body should contain the plugin manifest and skill file.

**Call relations**: This test ties together many helpers: write_test_plugin creates the local input, test_config and test_auth prepare the remote call setup, and archive_file_entries inspects the upload. It drives the production save_remote_plugin_share function through the same sequence a real first-time share would use.

*Call graph*: calls 5 internal fn (archive_file_entries, test_auth, test_config, write_test_plugin, try_from); 11 external calls (given, start, new, new, assert_eq!, json!, vec!, body_json, header, method (+1 more)).


##### `archive_plugin_for_upload_rejects_archives_over_limit`  (lines 283–298)

```
fn archive_plugin_for_upload_rejects_archives_over_limit()
```

**Purpose**: Checks that the archive builder refuses to produce an archive when the compressed plugin package is larger than an allowed limit. This protects the upload flow from sending files that are too big.

**Data flow**: The test creates a fake plugin, adds a large extra file, and asks the archive builder to use a very small maximum size. The expected output is an ArchiveTooLarge error instead of archive bytes.

**Call relations**: It uses write_test_plugin and write_file to create the oversized input. Then it directly exercises archive_plugin_for_upload_with_limit, confirming the size guard that save flows rely on before upload.

*Call graph*: calls 2 internal fn (write_file, write_test_plugin); 2 external calls (new, assert!).


##### `archive_plugin_for_upload_places_manifest_at_archive_root`  (lines 301–327)

```
fn archive_plugin_for_upload_places_manifest_at_archive_root()
```

**Purpose**: Checks that plugin archives have the right internal layout. In particular, the manifest must appear at .codex-plugin/plugin.json at the archive root, not nested under the temporary directory name.

**Data flow**: The test writes a fake plugin, creates an archive, reads the archive back into a path-to-bytes map, and compares the paths and contents against the expected manifest and skill file.

**Call relations**: It uses write_test_plugin to make the input and archive_file_entries to inspect the output. This directly tests archive_plugin_for_upload, whose output is later uploaded by the remote sharing flow.

*Call graph*: calls 2 internal fn (archive_file_entries, write_test_plugin); 2 external calls (new, assert_eq!).


##### `archive_plugin_for_upload_round_trips_through_plugin_bundle_archive_with_long_paths`  (lines 330–355)

```
fn archive_plugin_for_upload_round_trips_through_plugin_bundle_archive_with_long_paths()
```

**Purpose**: Checks that archives with very long file paths can still be unpacked by the plugin bundle extractor. This matters because some archive formats need special handling for long names.

**Data flow**: The test creates a fake plugin, adds a skill file deeply nested under many repeated path segments, archives the plugin, unpacks it into a new temporary directory, and reads the unpacked files back. The final checks confirm both the manifest and long-path skill survived unchanged.

**Call relations**: It uses write_test_plugin and write_file to create a challenging plugin folder. Then it sends the archive produced by archive_plugin_for_upload into unpack_plugin_bundle_tar_gz, proving that the sharing archive format works with the normal bundle unpacking code.

*Call graph*: calls 3 internal fn (unpack_plugin_bundle_tar_gz, write_file, write_test_plugin); 3 external calls (new, new, assert_eq!).


##### `save_remote_plugin_share_updates_existing_workspace_plugin`  (lines 358–423)

```
async fn save_remote_plugin_share_updates_existing_workspace_plugin()
```

**Purpose**: Tests updating an already shared workspace plugin. Instead of creating a new remote plugin, the code should upload a new archive and send it to the existing plugin ID.

**Data flow**: The test creates a fake plugin and fake server responses. It calls save_remote_plugin_share with an existing remote plugin ID. The expected result keeps the same remote plugin ID and has no new share URL, because this is an update rather than a new share creation.

**Call relations**: Like the create-share test, it uses write_test_plugin, test_config, and test_auth to set up the scenario. The mocked requests verify that save_remote_plugin_share includes the existing plugin ID when asking for an upload URL and posts the uploaded file to the existing plugin endpoint.

*Call graph*: calls 4 internal fn (test_auth, test_config, write_test_plugin, try_from); 10 external calls (given, start, new, new, assert_eq!, default, json!, body_json, method, path).


##### `update_remote_plugin_share_targets_updates_targets`  (lines 426–517)

```
async fn update_remote_plugin_share_targets_updates_targets()
```

**Purpose**: Tests changing who can access a shared plugin. It verifies that users, groups, roles, and discoverability are sent to the backend in the expected shape and parsed back correctly.

**Data flow**: The test starts a fake server expecting a PUT request with two explicit share targets plus the workspace target. It calls update_remote_plugin_share_targets with user and group targets and an unlisted discoverability setting. The returned value should contain the principals and discoverability reported by the fake backend.

**Call relations**: It uses test_config and test_auth to route the request to the fake server with test credentials. It drives the production update_remote_plugin_share_targets function and checks both the outgoing request body and the returned Rust result.

*Call graph*: calls 2 internal fn (test_auth, test_config); 10 external calls (given, start, new, assert_eq!, json!, vec!, body_json, header, method, path).


##### `list_remote_plugin_shares_fetches_created_workspace_plugins`  (lines 520–693)

```
async fn list_remote_plugin_shares_fetches_created_workspace_plugins()
```

**Purpose**: Tests listing plugins the user has created and shared in the workspace. It also checks pagination, installed status, share principals, share URLs, and saved local plugin paths.

**Data flow**: The test writes a local mapping for one plugin, sets up fake server responses for two pages of created plugins, and sets up another response for installed workspace plugins. It calls list_remote_plugin_shares. The returned list should include both shared plugins, mark one as installed and enabled, attach the local path to the mapped plugin, and preserve interface and sharing details.

**Call relations**: This is the broadest listing test. It uses write_plugin_share_local_path_mapping to simulate local bookkeeping, test_config and test_auth for backend access, remote_plugin_json_with_share_url_and_principals for created-plugin responses, installed_remote_plugin_json for installed status, empty_pagination_json to stop pagination, and expected_plugin_interface in the final assertion.

*Call graph*: calls 4 internal fn (test_auth, test_config, write_plugin_share_local_path_mapping, try_from); 11 external calls (given, start, new, new, assert_eq!, json!, header, method, path, query_param (+1 more)).


##### `delete_remote_plugin_share_deletes_workspace_plugin`  (lines 696–721)

```
async fn delete_remote_plugin_share_deletes_workspace_plugin()
```

**Purpose**: Tests deleting a shared workspace plugin. It verifies that the backend delete call is made and that the local remote-ID-to-path mapping is removed afterward.

**Data flow**: The test creates a temporary Codex home, writes a saved local path mapping for a remote plugin ID, and prepares a fake server to accept a DELETE request. It calls delete_remote_plugin_share. Afterward, loading the local mapping should return an empty map.

**Call relations**: It uses write_plugin_share_local_path_mapping to set up existing local state, and test_config and test_auth to route the delete request through the fake server. It drives delete_remote_plugin_share and confirms that remote deletion and local cleanup happen together.

*Call graph*: calls 4 internal fn (test_auth, test_config, write_plugin_share_local_path_mapping, try_from); 8 external calls (given, start, new, new, assert_eq!, header, method, path).


### `core-plugins/src/manager_tests.rs`

`test` · `test run`

Plugins in this project are small add-ons that can contribute skills, MCP servers, apps, hooks, and marketplace metadata. MCP means “Model Context Protocol,” a way for Codex to talk to outside tools or services. This test file builds many tiny fake plugin folders inside temporary directories, writes realistic config files, and then asks the real plugin manager what it sees. It checks the manager’s answers against the expected outcome.

The tests cover several user-facing promises. If plugins are disabled, nothing should load. If a plugin is disabled, it should still appear as configured but should not add working capabilities. If the user is signed in with ChatGPT-style auth, app connectors should be shown and overlapping MCP servers hidden; with API-key auth, apps should be hidden and MCP servers kept. The file also tests marketplace listing, installation and uninstallation, curated OpenAI plugin cache refreshes, non-curated plugin refreshes, remote plugin recommendations, duplicate handling, and hook loading.

Think of it like a safety inspection checklist for a plug-in power strip: every socket, label, switch, cache, and remote catalog path is exercised so future code changes do not quietly break real users’ plugin setup.

#### Function details

##### `plugins_manager_tracks_auth_mode`  (lines 58–77)

```
fn plugins_manager_tracks_auth_mode()
```

**Purpose**: Checks that a plugin manager remembers the current authentication mode and reports whether changing it actually changed anything.

**Data flow**: It creates managers in temporary homes, reads their starting auth mode, sets several auth modes, and compares the reported values before and after. The result is only test assertions; no lasting files are kept.

**Call relations**: This is a standalone test. It calls the manager constructors and auth-mode methods directly to verify the basic state that later plugin-loading tests depend on.

*Call graph*: calls 2 internal fn (new, new_with_options); 3 external calls (new, assert!, assert_eq!).


##### `write_auth_projection_plugin`  (lines 79–105)

```
fn write_auth_projection_plugin(codex_home: &Path, name: &str, include_app: bool)
```

**Purpose**: Creates a small fake plugin used by authentication-projection tests. The plugin always has an MCP server, and can optionally also declare an app connector.

**Data flow**: It receives a Codex home path, a plugin name, and a flag. It writes plugin manifest and MCP JSON files under the test plugin cache, and, if requested, asks the app helper to write an app declaration too.

**Call relations**: Several auth-projection tests call this helper before loading plugins. It delegates app creation to write_auth_projection_app so those tests can build matching or non-matching MCP/app combinations.

*Call graph*: calls 1 internal fn (write_auth_projection_app); called by 5 (plugin_auth_projection_hides_apps_without_chatgpt_auth, plugin_auth_projection_hides_dual_surface_mcp_with_agent_identity_apps_route, plugin_auth_projection_hides_matching_mcp_with_chatgpt_apps_route, plugin_auth_projection_keeps_non_conflicting_mcp_with_chatgpt_apps_route, plugin_auth_projection_reprojects_cached_plugins_when_auth_changes); 3 external calls (join, write_file, format!).


##### `write_auth_projection_app`  (lines 107–117)

```
fn write_auth_projection_app(codex_home: &Path, plugin_name: &str, app_name: &str)
```

**Purpose**: Writes a fake app connector declaration for a test plugin.

**Data flow**: It receives the Codex home, plugin name, and app name. It writes a .app.json file that maps that app name to a connector id based on the plugin name.

**Call relations**: It is called both directly by one test and indirectly through write_auth_projection_plugin. The resulting file is later read by the real plugin loader.

*Call graph*: called by 2 (plugin_auth_projection_keeps_non_conflicting_mcp_with_chatgpt_apps_route, write_auth_projection_plugin); 3 external calls (join, write_file, format!).


##### `app_declaration`  (lines 119–125)

```
fn app_declaration(name: &str, connector_id: &str) -> AppDeclaration
```

**Purpose**: Builds the AppDeclaration value expected in assertions.

**Data flow**: It takes an app name and connector id string, wraps them in the correct struct types, and leaves optional category information empty.

**Call relations**: Tests use this small builder when comparing loaded app declarations, so the expected values are easy to read.


##### `auth_projection_config`  (lines 127–140)

```
async fn auth_projection_config(codex_home: &Path) -> PluginsConfigInput
```

**Purpose**: Creates the standard config used by tests that compare app and MCP visibility under different auth modes.

**Data flow**: It writes a config.toml with plugins enabled and two test plugins turned on, then loads that config into the form the plugin manager expects.

**Call relations**: The auth-projection tests call this after writing plugin files and before asking PluginsManager to load them.

*Call graph*: calls 1 internal fn (load_config); called by 5 (plugin_auth_projection_hides_apps_without_chatgpt_auth, plugin_auth_projection_hides_dual_surface_mcp_with_agent_identity_apps_route, plugin_auth_projection_hides_matching_mcp_with_chatgpt_apps_route, plugin_auth_projection_keeps_non_conflicting_mcp_with_chatgpt_apps_route, plugin_auth_projection_reprojects_cached_plugins_when_auth_changes); 2 external calls (join, write_file).


##### `sorted_effective_mcp_server_names`  (lines 142–150)

```
fn sorted_effective_mcp_server_names(outcome: &PluginLoadOutcome) -> Vec<String>
```

**Purpose**: Returns MCP server names from a load result in a stable order, so tests can compare them reliably.

**Data flow**: It reads the effective MCP server map from a PluginLoadOutcome, copies the keys, sorts them, and returns the sorted list.

**Call relations**: Auth-projection tests use this helper because maps do not promise a human-friendly order.

*Call graph*: calls 1 internal fn (effective_mcp_servers).


##### `plugin_auth_projection_hides_apps_without_chatgpt_auth`  (lines 153–178)

```
async fn plugin_auth_projection_hides_apps_without_chatgpt_auth()
```

**Purpose**: Verifies that app connectors are hidden when the manager is using API-key auth instead of ChatGPT-style auth.

**Data flow**: It creates two fake plugins, loads config, runs the manager with API-key auth, and checks that apps disappear while MCP servers remain visible.

**Call relations**: It relies on the auth projection helpers to build the fake plugin cache, then exercises plugins_for_config on the real manager.

*Call graph*: calls 3 internal fn (new_with_options, auth_projection_config, write_auth_projection_plugin); 3 external calls (new, assert!, assert_eq!).


##### `plugin_auth_projection_hides_matching_mcp_with_chatgpt_apps_route`  (lines 181–219)

```
async fn plugin_auth_projection_hides_matching_mcp_with_chatgpt_apps_route()
```

**Purpose**: Checks that with ChatGPT auth, a plugin app can replace an MCP server with the same declaration name.

**Data flow**: It writes one plugin with both an app and matching MCP server plus another MCP-only plugin. After loading, it expects the app connector to appear and the matching MCP server to be removed.

**Call relations**: This test continues the auth-projection story by proving the manager avoids showing duplicate routes to the same capability.

*Call graph*: calls 3 internal fn (new_with_options, auth_projection_config, write_auth_projection_plugin); 3 external calls (new, assert!, assert_eq!).


##### `plugin_auth_projection_hides_dual_surface_mcp_with_agent_identity_apps_route`  (lines 222–243)

```
async fn plugin_auth_projection_hides_dual_surface_mcp_with_agent_identity_apps_route()
```

**Purpose**: Checks that Agent Identity auth behaves like ChatGPT auth for plugins that expose both app and MCP surfaces.

**Data flow**: It creates the same fake plugin setup as the ChatGPT route test, loads with Agent Identity auth, and expects the app to remain while the overlapping MCP server is hidden.

**Call relations**: It reuses the shared auth projection setup and calls the real manager to confirm another auth mode follows the same projection rule.

*Call graph*: calls 3 internal fn (new_with_options, auth_projection_config, write_auth_projection_plugin); 2 external calls (new, assert_eq!).


##### `plugin_auth_projection_keeps_non_conflicting_mcp_with_chatgpt_apps_route`  (lines 246–278)

```
async fn plugin_auth_projection_keeps_non_conflicting_mcp_with_chatgpt_apps_route()
```

**Purpose**: Ensures ChatGPT auth does not hide an MCP server unless it conflicts with an app declaration name.

**Data flow**: It writes a plugin whose MCP server and app use different names, loads it with ChatGPT auth, and expects both the app connector and MCP server to remain.

**Call relations**: It uses both plugin-writing helpers to create a deliberately non-conflicting case for the projection logic.

*Call graph*: calls 4 internal fn (new_with_options, auth_projection_config, write_auth_projection_app, write_auth_projection_plugin); 2 external calls (new, assert_eq!).


##### `plugin_auth_projection_preserves_duplicate_connector_declaration_names`  (lines 281–361)

```
async fn plugin_auth_projection_preserves_duplicate_connector_declaration_names()
```

**Purpose**: Checks that multiple app declarations pointing to the same connector are deduplicated without losing unrelated MCP servers.

**Data flow**: It writes one plugin with two app names sharing one connector id and three MCP servers. After loading with ChatGPT auth, it expects one connector id and only the non-overlapping MCP server.

**Call relations**: This test builds the files inline instead of using the helper because it needs duplicate app connector declarations.

*Call graph*: calls 2 internal fn (new_with_options, load_config); 3 external calls (new, assert_eq!, write_file).


##### `plugin_auth_projection_reprojects_cached_plugins_when_auth_changes`  (lines 364–435)

```
async fn plugin_auth_projection_reprojects_cached_plugins_when_auth_changes()
```

**Purpose**: Verifies that changing auth mode updates the visible plugin capabilities even when the underlying loaded plugin data is cached.

**Data flow**: It loads plugins once with ChatGPT auth, checks apps are projected in, changes the manager to API-key auth, loads again, and checks the view switches to MCP-only.

**Call relations**: It combines the auth-mode state tested earlier with plugin caching behavior to ensure cached loads are reinterpreted for the current auth mode.

*Call graph*: calls 3 internal fn (new_with_options, auth_projection_config, write_auth_projection_plugin); 3 external calls (new, assert!, assert_eq!).


##### `write_plugin_with_version`  (lines 437–456)

```
fn write_plugin_with_version(
    root: &Path,
    dir_name: &str,
    manifest_name: &str,
    manifest_version: Option<&str>,
)
```

**Purpose**: Creates a minimal fake plugin folder, optionally with a version in its manifest.

**Data flow**: It receives a root path, directory name, manifest name, and optional version. It creates manifest and skills folders, writes plugin.json, a sample skill file, and an empty MCP config.

**Call relations**: Many installation and cache-refresh tests use this as their basic fake plugin factory. write_plugin is its simpler wrapper.

*Call graph*: called by 8 (install_plugin_uses_manifest_version_for_non_curated_plugins, refresh_non_curated_plugin_cache_ignores_invalid_unconfigured_plugin_versions, refresh_non_curated_plugin_cache_refreshes_configured_git_source, refresh_non_curated_plugin_cache_reinstalls_missing_configured_plugin_with_manifest_version, refresh_non_curated_plugin_cache_replaces_existing_local_version_with_manifest_version, refresh_non_curated_plugin_cache_returns_false_when_configured_plugins_are_current, write_cached_plugin, write_plugin); 4 external calls (join, format!, create_dir_all, write).


##### `write_plugin`  (lines 458–465)

```
fn write_plugin(root: &Path, dir_name: &str, manifest_name: &str)
```

**Purpose**: Creates a minimal fake plugin without specifying a manifest version.

**Data flow**: It passes the root, directory name, and manifest name to write_plugin_with_version with no version value.

**Call relations**: Tests call this when version details are not important, while still getting the same standard plugin layout.

*Call graph*: calls 1 internal fn (write_plugin_with_version); called by 13 (install_plugin_supports_git_subdir_marketplace_sources, install_plugin_supports_relative_git_subdir_marketplace_sources, install_plugin_updates_config_with_relative_path_and_plugin_key, list_marketplaces_includes_enabled_state, plugin_cache_ignores_unrelated_session_overrides, plugin_hooks_for_layer_stack_loads_configured_plugin_hooks, refresh_curated_plugin_cache_migrates_full_sha_cache_version_to_short_version, refresh_curated_plugin_cache_removes_cache_for_plugin_removed_from_marketplace, refresh_curated_plugin_cache_replaces_existing_local_version_with_short_sha_version, refresh_curated_plugin_cache_returns_false_when_configured_plugins_are_current (+3 more)).


##### `init_git_repo`  (lines 467–473)

```
fn init_git_repo(repo: &Path)
```

**Purpose**: Turns a test directory into a small Git repository so tests can exercise Git-based plugin sources.

**Data flow**: It runs git init, configures a test author, stages files, and creates an initial commit.

**Call relations**: Git-subdir installation and refresh tests call this before asking the plugin manager to copy from a repository source.

*Call graph*: calls 1 internal fn (run_git); called by 3 (install_plugin_supports_git_subdir_marketplace_sources, install_plugin_supports_relative_git_subdir_marketplace_sources, refresh_non_curated_plugin_cache_refreshes_configured_git_source).


##### `run_git`  (lines 475–490)

```
fn run_git(repo: &Path, args: &[&str])
```

**Purpose**: Runs a Git command in a test repository and fails the test with useful output if Git fails.

**Data flow**: It receives a repository path and argument list, starts the git process, captures output, and asserts success.

**Call relations**: init_git_repo uses this for each Git step, keeping command failure messages readable.

*Call graph*: called by 1 (init_git_repo); 2 external calls (assert!, new).


##### `plugin_config_toml`  (lines 492–510)

```
fn plugin_config_toml(enabled: bool, plugins_feature_enabled: bool) -> String
```

**Purpose**: Builds a simple config.toml string for tests with one plugin and a plugins feature flag.

**Data flow**: It receives whether the plugin is enabled and whether the plugin feature is enabled, constructs a TOML table, and serializes it to text.

**Call relations**: Many load tests call this so they can focus on plugin files instead of repeating config boilerplate.

*Call graph*: called by 12 (capability_summary_sanitizes_plugin_descriptions_to_one_line, capability_summary_truncates_overlong_plugin_descriptions, effective_apps_preserves_app_config_order, load_plugins_ignores_invalid_manifest_skills_shape, load_plugins_ignores_manifest_component_paths_without_dot_slash, load_plugins_ignores_project_config_files, load_plugins_loads_default_skills_and_mcp_servers, load_plugins_preserves_disabled_plugins_without_effective_contributions, load_plugins_returns_empty_when_feature_disabled, load_plugins_uses_manifest_configured_component_paths (+2 more)); 4 external calls (Boolean, Table, new, to_string).


##### `load_plugins_from_config`  (lines 512–522)

```
async fn load_plugins_from_config(
    config_toml: &str,
    codex_home: &Path,
    auth_mode: Option<AuthMode>,
) -> PluginLoadOutcome
```

**Purpose**: Writes a config string, loads it, and returns the plugin manager’s load outcome.

**Data flow**: It writes config.toml into the temporary Codex home, loads the config, creates a manager with the requested auth mode, and awaits plugins_for_config.

**Call relations**: Most plugin-loading tests use this helper as the standard path from fake config to PluginLoadOutcome.

*Call graph*: calls 2 internal fn (new_with_options, load_config); called by 13 (capability_summary_sanitizes_plugin_descriptions_to_one_line, capability_summary_truncates_overlong_plugin_descriptions, effective_apps_dedupes_connector_ids_across_plugins, effective_apps_preserves_app_config_order, load_plugins_applies_plugin_mcp_server_policy, load_plugins_ignores_invalid_manifest_skills_shape, load_plugins_ignores_manifest_component_paths_without_dot_slash, load_plugins_ignores_unknown_disabled_skill_names, load_plugins_loads_default_skills_and_mcp_servers, load_plugins_preserves_disabled_plugins_without_effective_contributions (+3 more)); 3 external calls (join, to_path_buf, write_file).


##### `load_config`  (lines 524–526)

```
async fn load_config(codex_home: &Path, cwd: &Path) -> PluginsConfigInput
```

**Purpose**: Loads plugin-related configuration for tests through the project’s normal config-loading helper.

**Data flow**: It receives a Codex home and current working directory, passes them to test support config loading, and returns the parsed plugin config input.

**Call relations**: Marketplace, remote, read, and load tests call this before invoking manager methods that need configuration.

*Call graph*: called by 32 (auth_projection_config, featured_plugin_ids_for_config_defaults_query_param_to_codex, featured_plugin_ids_for_config_uses_restriction_product_query_param, list_marketplaces_can_skip_openai_curated_before_loading, list_marketplaces_excludes_plugins_with_explicit_empty_products, list_marketplaces_ignores_installed_roots_missing_from_config, list_marketplaces_includes_curated_repo_marketplace, list_marketplaces_includes_enabled_state, list_marketplaces_includes_installed_marketplace_roots, list_marketplaces_installed_git_source_reads_metadata_from_cache_without_cloning (+15 more)); 1 external calls (load_plugins_config).


##### `remote_installed_linear_plugin`  (lines 528–530)

```
fn remote_installed_linear_plugin() -> RemoteInstalledPlugin
```

**Purpose**: Creates a standard fake remote-installed plugin named linear.

**Data flow**: It supplies the name linear to the general remote plugin builder and returns the resulting remote plugin record.

**Call relations**: Remote marketplace metadata tests use this as a readable shortcut.

*Call graph*: calls 1 internal fn (remote_installed_plugin); called by 1 (build_remote_installed_plugin_marketplaces_from_cache_uses_remote_metadata).


##### `remote_installed_plugin`  (lines 532–534)

```
fn remote_installed_plugin(name: &str) -> RemoteInstalledPlugin
```

**Purpose**: Creates a fake remote-installed plugin in the default global remote marketplace.

**Data flow**: It receives a plugin name and passes it with the global marketplace name to the marketplace-specific builder.

**Call relations**: Remote cache tests use this when they do not care about workspace-specific marketplace names.

*Call graph*: calls 1 internal fn (remote_installed_plugin_in_marketplace); called by 1 (remote_installed_linear_plugin).


##### `remote_installed_plugin_in_marketplace`  (lines 536–551)

```
fn remote_installed_plugin_in_marketplace(
    name: &str,
    marketplace_name: &str,
) -> RemoteInstalledPlugin
```

**Purpose**: Builds a fake remote-installed plugin record for a named remote marketplace.

**Data flow**: It receives a plugin name and marketplace name, fills in id, enabled state, policies, availability, and empty optional metadata, then returns the record.

**Call relations**: The two higher-level remote plugin helpers delegate to this, and marketplace-filtering tests call it directly for non-global marketplaces.

*Call graph*: called by 1 (remote_installed_plugin); 2 external calls (new, format!).


##### `write_cached_plugin`  (lines 553–563)

```
fn write_cached_plugin(codex_home: &Path, marketplace_name: &str, plugin_name: &str)
```

**Purpose**: Places a fake installed plugin into the plugin cache under a given marketplace and plugin name.

**Data flow**: It builds the cache path and writes a versioned fake plugin whose manifest version is local.

**Call relations**: Remote curated conflict and curated cache tests use this to simulate already-installed plugins.

*Call graph*: calls 1 internal fn (write_plugin_with_version); called by 3 (refresh_curated_plugin_cache_leaves_api_curated_plugin_when_api_manifest_missing, remote_installed_cache_prefers_local_curated_conflicts_when_remote_plugin_disabled, remote_installed_cache_prefers_remote_curated_conflicts_when_remote_plugin_enabled); 1 external calls (join).


##### `load_plugins_loads_default_skills_and_mcp_servers`  (lines 566–683)

```
async fn load_plugins_loads_default_skills_and_mcp_servers()
```

**Purpose**: Checks that a normal enabled plugin contributes its manifest, skills, MCP server, app, and capability summary.

**Data flow**: It writes a realistic plugin with manifest, skill, MCP config, and app config, loads it, and compares the full LoadedPlugin plus effective capability views.

**Call relations**: This is the baseline loading test that proves the standard file layout is recognized by load_plugins_from_config.

*Call graph*: calls 2 internal fn (load_plugins_from_config, plugin_config_toml); 3 external calls (new, assert_eq!, write_file).


##### `load_plugins_applies_plugin_mcp_server_policy`  (lines 686–752)

```
async fn load_plugins_applies_plugin_mcp_server_policy()
```

**Purpose**: Verifies that user config can override MCP server settings declared by a plugin.

**Data flow**: It writes a plugin MCP server with default tool settings, writes config overrides that disable the server and adjust tool approval settings, loads the plugin, and checks the merged server config.

**Call relations**: It exercises the manager’s policy-application path after load_plugins_from_config reads both plugin files and config.

*Call graph*: calls 1 internal fn (load_plugins_from_config); 4 external calls (new, assert!, assert_eq!, write_file).


##### `remote_installed_cache_ignores_plugins_missing_local_cache`  (lines 755–771)

```
async fn remote_installed_cache_ignores_plugins_missing_local_cache()
```

**Purpose**: Checks that a remote-installed plugin record alone is not enough to load a plugin if its local cached files are missing.

**Data flow**: It enables remote plugins, writes a remote installed cache entry, but does not create plugin files. The expected load result is empty.

**Call relations**: It calls the manager’s remote installed cache writer, then plugins_for_config, proving local cache material is required.

*Call graph*: calls 2 internal fn (new, load_config); 4 external calls (new, assert_eq!, write_file, vec!).


##### `remote_installed_cache_prefers_local_curated_conflicts_when_remote_plugin_disabled`  (lines 774–814)

```
async fn remote_installed_cache_prefers_local_curated_conflicts_when_remote_plugin_disabled()
```

**Purpose**: Ensures local curated plugins win name conflicts when the remote plugin feature is disabled.

**Data flow**: It creates local curated and remote-curated cache folders with overlapping names, disables remote plugins, and checks which config names are loaded.

**Call relations**: It combines cached plugin setup, remote installed cache records, and manager loading to test conflict resolution.

*Call graph*: calls 3 internal fn (new, load_config, write_cached_plugin); 4 external calls (new, assert_eq!, write_file, vec!).


##### `remote_installed_cache_prefers_remote_curated_conflicts_when_remote_plugin_enabled`  (lines 817–861)

```
async fn remote_installed_cache_prefers_remote_curated_conflicts_when_remote_plugin_enabled()
```

**Purpose**: Ensures remote curated plugins win name conflicts when the remote plugin feature is enabled.

**Data flow**: It creates overlapping local curated, API curated, and remote-curated cached plugins, enables remote plugins, and checks that the remote curated version is chosen for conflicts.

**Call relations**: It mirrors the disabled-remote test but flips the feature flag to verify the opposite preference.

*Call graph*: calls 3 internal fn (new, load_config, write_cached_plugin); 4 external calls (new, assert_eq!, write_file, vec!).


##### `build_remote_installed_plugin_marketplaces_from_cache_uses_remote_metadata`  (lines 864–936)

```
async fn build_remote_installed_plugin_marketplaces_from_cache_uses_remote_metadata()
```

**Purpose**: Checks that remote-installed plugin cache entries become marketplace entries with their remote metadata intact.

**Data flow**: It writes a remote cache entry with install policy, auth policy, keywords, and interface details, then builds marketplaces from the cache and compares the resulting plugin fields.

**Call relations**: This directly tests the manager’s cache-to-marketplace conversion without loading plugin files.

*Call graph*: calls 2 internal fn (new, remote_installed_linear_plugin); 4 external calls (new, new, assert_eq!, vec!).


##### `build_remote_installed_plugin_marketplaces_from_cache_filters_by_marketplace_name`  (lines 939–967)

```
async fn build_remote_installed_plugin_marketplaces_from_cache_filters_by_marketplace_name()
```

**Purpose**: Verifies that remote marketplace building only includes requested remote marketplace names.

**Data flow**: It writes remote installed cache entries for two workspace-related marketplaces, requests one marketplace, and checks that only its plugin appears.

**Call relations**: It uses remote_installed_plugin_in_marketplace data and the manager’s remote cache marketplace builder.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert_eq!, vec!).


##### `load_plugins_resolves_disabled_skill_names_against_loaded_plugin_skills`  (lines 970–1009)

```
async fn load_plugins_resolves_disabled_skill_names_against_loaded_plugin_skills()
```

**Purpose**: Checks that a user can disable a plugin skill by its plugin-qualified skill name.

**Data flow**: It writes one skill, configures that skill as disabled, loads the plugin, canonicalizes the skill path, and expects it in disabled_skill_paths with no enabled skills left.

**Call relations**: It tests the bridge between config skill rules and the actual skill files discovered during plugin loading.

*Call graph*: calls 1 internal fn (load_plugins_from_config); 5 external calls (new, assert!, assert_eq!, write_file, canonicalize).


##### `load_plugins_ignores_unknown_disabled_skill_names`  (lines 1012–1054)

```
async fn load_plugins_ignores_unknown_disabled_skill_names()
```

**Purpose**: Ensures disabling a non-existent skill does not accidentally disable real skills.

**Data flow**: It writes one skill, configures a different missing skill as disabled, loads the plugin, and expects the real skill to remain enabled.

**Call relations**: It complements the previous disabled-skill test by proving unmatched config rules are harmless.

*Call graph*: calls 1 internal fn (load_plugins_from_config); 4 external calls (new, assert!, assert_eq!, write_file).


##### `plugin_telemetry_metadata_uses_default_mcp_config_path`  (lines 1057–1099)

```
async fn plugin_telemetry_metadata_uses_default_mcp_config_path()
```

**Purpose**: Verifies telemetry metadata can find a plugin’s default .mcp.json file.

**Data flow**: It writes a plugin manifest and MCP config, asks for telemetry metadata from the plugin root, and checks the generated capability summary.

**Call relations**: It calls plugin_telemetry_metadata_from_root directly instead of going through the whole manager load path.

*Call graph*: calls 1 internal fn (parse); 3 external calls (new, assert_eq!, write_file).


##### `capability_summary_sanitizes_plugin_descriptions_to_one_line`  (lines 1102–1136)

```
async fn capability_summary_sanitizes_plugin_descriptions_to_one_line()
```

**Purpose**: Checks that capability summaries clean plugin descriptions for display without changing the raw manifest description.

**Data flow**: It writes a manifest description with newlines, multiple spaces, and a tab, loads the plugin, and expects the summary description to be a single normalized line.

**Call relations**: It uses the standard load helper and verifies summary formatting in PluginLoadOutcome.

*Call graph*: calls 2 internal fn (load_plugins_from_config, plugin_config_toml); 3 external calls (new, assert_eq!, write_file).


##### `capability_summary_truncates_overlong_plugin_descriptions`  (lines 1139–1176)

```
async fn capability_summary_truncates_overlong_plugin_descriptions()
```

**Purpose**: Checks that very long plugin descriptions are shortened in capability summaries.

**Data flow**: It writes a description one character longer than the maximum, loads the plugin, and expects the raw manifest to stay long while the summary is truncated.

**Call relations**: It protects the user-facing capability index from oversized plugin metadata.

*Call graph*: calls 2 internal fn (load_plugins_from_config, plugin_config_toml); 4 external calls (new, assert_eq!, write_file, format!).


##### `load_plugins_uses_manifest_configured_component_paths`  (lines 1179–1292)

```
async fn load_plugins_uses_manifest_configured_component_paths()
```

**Purpose**: Verifies that manifest paths beginning with ./ can override default locations for skills, MCP servers, and apps.

**Data flow**: It writes both default and custom component files, points the manifest to custom paths, loads the plugin, and expects custom components to be used.

**Call relations**: It tests how the loader interprets component path fields in plugin.json.

*Call graph*: calls 2 internal fn (load_plugins_from_config, plugin_config_toml); 3 external calls (new, assert_eq!, write_file).


##### `load_plugins_ignores_manifest_component_paths_without_dot_slash`  (lines 1295–1405)

```
async fn load_plugins_ignores_manifest_component_paths_without_dot_slash()
```

**Purpose**: Ensures manifest component paths are ignored unless they explicitly start with ./.

**Data flow**: It writes custom paths without the required prefix, plus default component files, loads the plugin, and expects the defaults to be used.

**Call relations**: It complements the custom-path test by enforcing the safe relative-path rule.

*Call graph*: calls 2 internal fn (load_plugins_from_config, plugin_config_toml); 3 external calls (new, assert_eq!, write_file).


##### `load_plugins_ignores_invalid_manifest_skills_shape`  (lines 1408–1443)

```
async fn load_plugins_ignores_invalid_manifest_skills_shape()
```

**Purpose**: Checks that an invalid skills field shape in plugin.json does not break plugin loading.

**Data flow**: It writes a manifest where skills is an array instead of the expected string, loads the plugin, and expects no error and the default skills folder.

**Call relations**: It tests loader resilience against malformed optional manifest fields.

*Call graph*: calls 2 internal fn (load_plugins_from_config, plugin_config_toml); 3 external calls (new, assert_eq!, write_file).


##### `load_plugins_preserves_disabled_plugins_without_effective_contributions`  (lines 1446–1498)

```
async fn load_plugins_preserves_disabled_plugins_without_effective_contributions()
```

**Purpose**: Verifies that disabled configured plugins are still reported but do not contribute skills, MCP servers, or apps.

**Data flow**: It writes a plugin with an MCP server, configures it as disabled, loads it, and checks that the LoadedPlugin exists with enabled false and empty capability lists.

**Call relations**: It tests the distinction between configured plugin records and effective capabilities.

*Call graph*: calls 2 internal fn (load_plugins_from_config, plugin_config_toml); 4 external calls (new, assert!, assert_eq!, write_file).


##### `effective_apps_dedupes_connector_ids_across_plugins`  (lines 1501–1574)

```
async fn effective_apps_dedupes_connector_ids_across_plugins()
```

**Purpose**: Checks that effective app connector ids are unique even when multiple plugins declare the same connector.

**Data flow**: It writes two plugins with overlapping app connector ids, enables both, loads with ChatGPT auth, and expects each connector id once.

**Call relations**: It exercises PluginLoadOutcome’s effective app projection across multiple loaded plugins.

*Call graph*: calls 1 internal fn (load_plugins_from_config); 7 external calls (new, Boolean, Table, assert_eq!, write_file, new, to_string).


##### `effective_apps_preserves_app_config_order`  (lines 1577–1619)

```
async fn effective_apps_preserves_app_config_order()
```

**Purpose**: Ensures app connector ids keep their declaration order while duplicates are removed.

**Data flow**: It writes one app config with Slack, GitHub, then a duplicate Slack entry, loads it, and expects Slack followed by GitHub.

**Call relations**: It focuses on ordering behavior in the same effective app list tested for deduplication.

*Call graph*: calls 2 internal fn (load_plugins_from_config, plugin_config_toml); 3 external calls (new, assert_eq!, write_file).


##### `capability_index_filters_inactive_and_zero_capability_plugins`  (lines 1622–1724)

```
fn capability_index_filters_inactive_and_zero_capability_plugins()
```

**Purpose**: Checks that capability summaries only include active plugins with at least one useful capability.

**Data flow**: It constructs LoadedPlugin values directly with different combinations of skills, MCP servers, apps, disabled state, and errors, then asks PluginLoadOutcome to summarize them.

**Call relations**: Unlike file-based load tests, this directly tests summary creation from in-memory loaded plugins.

*Call graph*: calls 1 internal fn (from_plugins); 3 external calls (new, assert_eq!, vec!).


##### `load_plugins_returns_empty_when_feature_disabled`  (lines 1727–1755)

```
async fn load_plugins_returns_empty_when_feature_disabled()
```

**Purpose**: Verifies that the global plugins feature flag turns plugin loading off entirely.

**Data flow**: It writes a valid plugin and config with the plugin enabled but features.plugins set false, loads through the manager, and expects the default empty outcome.

**Call relations**: It confirms the manager checks the feature flag before using cached plugin files.

*Call graph*: calls 3 internal fn (new, load_config, plugin_config_toml); 3 external calls (new, assert_eq!, write_file).


##### `plugin_cache_ignores_unrelated_session_overrides`  (lines 1758–1825)

```
async fn plugin_cache_ignores_unrelated_session_overrides()
```

**Purpose**: Checks that plugin load caching is not invalidated by unrelated session settings like model choice.

**Data flow**: It loads a plugin with one session override, deletes the MCP file, loads again with a different model override, and expects the second result to come from cache.

**Call relations**: It builds a custom config layer stack to make sure only plugin-relevant config affects the cache key.

*Call graph*: calls 3 internal fn (new, plugin_config_toml, write_plugin); 5 external calls (new, assert_eq!, write_file, remove_file, from_str).


##### `loaded_plugins_cache_invalidation_rejects_stale_load_completion`  (lines 1828–1842)

```
fn loaded_plugins_cache_invalidation_rejects_stale_load_completion()
```

**Purpose**: Ensures an old asynchronous plugin load cannot write stale data into the cache after the cache was cleared.

**Data flow**: It records a cache generation, clears the cache to advance the generation, tries to cache data using the stale generation, and confirms no cached data appears.

**Call relations**: It tests the manager’s generation guard directly, without file I/O.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, new, new, assert_eq!, default).


##### `load_plugins_rejects_invalid_plugin_keys`  (lines 1845–1883)

```
async fn load_plugins_rejects_invalid_plugin_keys()
```

**Purpose**: Verifies that plugin config keys must use the form plugin@marketplace.

**Data flow**: It writes config with an invalid key, loads plugins, and expects a LoadedPlugin entry containing a clear error and no effective capabilities.

**Call relations**: It tests validation at the boundary between user config and plugin loading.

*Call graph*: calls 1 internal fn (load_plugins_from_config); 8 external calls (new, Boolean, Table, assert!, assert_eq!, write_file, new, to_string).


##### `install_plugin_updates_config_with_relative_path_and_plugin_key`  (lines 1886–1937)

```
async fn install_plugin_updates_config_with_relative_path_and_plugin_key()
```

**Purpose**: Checks that installing a local marketplace plugin copies it into cache and enables the correct plugin key in config.

**Data flow**: It creates a fake marketplace and plugin, calls install_plugin, compares the install outcome, then reads config.toml to ensure the plugin was enabled.

**Call relations**: This begins the install tests by exercising the normal local-source install path.

*Call graph*: calls 3 internal fn (new, write_plugin, try_from); 6 external calls (assert!, assert_eq!, create_dir_all, read_to_string, write, tempdir).


##### `install_openai_curated_plugin_uses_short_sha_cache_version`  (lines 1940–1973)

```
async fn install_openai_curated_plugin_uses_short_sha_cache_version()
```

**Purpose**: Ensures OpenAI curated plugin installs use the short curated repository SHA as the cache version.

**Data flow**: It writes a curated marketplace and SHA file, installs a curated plugin, and expects the installed path and reported version to use the short cache version.

**Call relations**: It tests the special versioning rule for curated plugins.

*Call graph*: calls 3 internal fn (new, curated_plugins_repo_path, try_from); 5 external calls (assert_eq!, write_curated_plugin_sha_with, write_openai_curated_marketplace, format!, tempdir).


##### `install_plugin_uses_manifest_version_for_non_curated_plugins`  (lines 1976–2027)

```
async fn install_plugin_uses_manifest_version_for_non_curated_plugins()
```

**Purpose**: Verifies non-curated plugins use their manifest version as the cache version.

**Data flow**: It writes a plugin manifest with version 1.2.3-beta+7, installs it from a local marketplace, and checks that version appears in the outcome and cache path.

**Call relations**: It contrasts with curated install behavior by testing marketplace plugins outside the OpenAI curated set.

*Call graph*: calls 3 internal fn (new, write_plugin_with_version, try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `install_plugin_supports_git_subdir_marketplace_sources`  (lines 2030–2083)

```
async fn install_plugin_supports_git_subdir_marketplace_sources()
```

**Purpose**: Checks that a marketplace can install a plugin from a subdirectory of a Git repository.

**Data flow**: It creates a committed Git repo containing a plugin, writes marketplace metadata pointing to that repo and subdir, installs the plugin, and verifies files landed in cache.

**Call relations**: It uses init_git_repo to prepare a real Git source for install_plugin.

*Call graph*: calls 4 internal fn (new, init_git_repo, write_plugin, try_from); 7 external calls (assert!, assert_eq!, format!, create_dir_all, write, tempdir, from_directory_path).


##### `install_plugin_supports_relative_git_subdir_marketplace_sources`  (lines 2086–2134)

```
async fn install_plugin_supports_relative_git_subdir_marketplace_sources()
```

**Purpose**: Checks that Git subdirectory sources can use URLs relative to the marketplace file.

**Data flow**: It creates a marketplace repo with a nested remote plugin repo, writes a relative Git URL, installs the plugin, and verifies the cached manifest exists.

**Call relations**: It extends the Git-subdir install test to cover relative source paths.

*Call graph*: calls 4 internal fn (new, init_git_repo, write_plugin, try_from); 5 external calls (assert!, assert_eq!, create_dir_all, write, tempdir).


##### `uninstall_plugin_removes_cache_and_config_entry`  (lines 2137–2171)

```
async fn uninstall_plugin_removes_cache_and_config_entry()
```

**Purpose**: Verifies uninstalling a plugin removes its cached files and deletes its config entry, even if called twice.

**Data flow**: It writes a cached plugin and enabled config entry, calls uninstall_plugin twice, then checks the cache folder is gone and config no longer contains the plugin table.

**Call relations**: It tests cleanup behavior and idempotency for the manager’s uninstall path.

*Call graph*: calls 2 internal fn (new, write_plugin); 4 external calls (assert!, write_file, read_to_string, tempdir).


##### `list_marketplaces_includes_enabled_state`  (lines 2174–2297)

```
async fn list_marketplaces_includes_enabled_state()
```

**Purpose**: Checks marketplace listing reports whether installed plugins are enabled or disabled in config.

**Data flow**: It creates a marketplace with two plugins, caches both, configures one enabled and one disabled, lists marketplaces, and compares the full marketplace entry.

**Call relations**: It exercises list_marketplaces_for_config using loaded config and fake installed plugins.

*Call graph*: calls 4 internal fn (new, load_config, write_plugin, try_from); 5 external calls (assert_eq!, write_file, create_dir_all, write, tempdir).


##### `list_marketplaces_returns_empty_when_feature_disabled`  (lines 2300–2342)

```
async fn list_marketplaces_returns_empty_when_feature_disabled()
```

**Purpose**: Verifies marketplace listing is empty when the plugins feature is disabled.

**Data flow**: It writes a marketplace and config with features.plugins false, lists marketplaces, and expects an empty list.

**Call relations**: It confirms the same global feature switch used by plugin loading also gates marketplace listing.

*Call graph*: calls 3 internal fn (new, load_config, try_from); 5 external calls (assert_eq!, write_file, create_dir_all, write, tempdir).


##### `list_marketplaces_excludes_plugins_with_explicit_empty_products`  (lines 2345–2424)

```
async fn list_marketplaces_excludes_plugins_with_explicit_empty_products()
```

**Purpose**: Ensures marketplace plugins explicitly restricted to no products are not shown.

**Data flow**: It writes a marketplace with one plugin whose products list is empty and one normal plugin, lists marketplaces, and expects only the normal plugin.

**Call relations**: It tests product filtering in marketplace presentation.

*Call graph*: calls 3 internal fn (new, load_config, try_from); 5 external calls (assert_eq!, write_file, create_dir_all, write, tempdir).


##### `read_plugin_for_config_returns_plugins_disabled_when_feature_disabled`  (lines 2427–2473)

```
async fn read_plugin_for_config_returns_plugins_disabled_when_feature_disabled()
```

**Purpose**: Checks that reading one plugin’s details fails with a clear PluginsDisabled error when the feature is off.

**Data flow**: It writes a marketplace and disabled global feature config, calls read_plugin_for_config, and asserts the returned error kind.

**Call relations**: It tests the single-plugin details endpoint’s feature-gate behavior.

*Call graph*: calls 3 internal fn (new, load_config, try_from); 5 external calls (assert!, write_file, create_dir_all, write, tempdir).


##### `read_plugin_for_config_filters_mcp_servers_for_codex_backend_auth`  (lines 2476–2554)

```
async fn read_plugin_for_config_filters_mcp_servers_for_codex_backend_auth()
```

**Purpose**: Verifies plugin detail reading uses the same auth-based app/MCP projection as plugin loading.

**Data flow**: It writes a plugin with one app and two MCP servers, reads details once with ChatGPT auth and once with API-key auth, and compares visible apps and MCP server names.

**Call relations**: It applies the earlier auth-projection behavior to read_plugin_for_config instead of plugins_for_config.

*Call graph*: calls 3 internal fn (new_with_options, load_config, try_from); 5 external calls (assert!, assert_eq!, write_file, create_dir_all, tempdir).


##### `read_plugin_for_config_uses_user_layer_skill_settings_only`  (lines 2557–2619)

```
async fn read_plugin_for_config_uses_user_layer_skill_settings_only()
```

**Purpose**: Checks that reading marketplace plugin details ignores project-level skill disable rules.

**Data flow**: It writes a user config enabling a plugin and a project config disabling its skill, reads plugin details, and expects no disabled skill paths.

**Call relations**: It protects plugin detail views from being affected by project config layers that should not apply there.

*Call graph*: calls 3 internal fn (new, load_config, try_from); 4 external calls (assert!, write_file, create_dir_all, tempdir).


##### `read_plugin_for_config_uninstalled_git_source_requires_install_without_cloning`  (lines 2622–2694)

```
async fn read_plugin_for_config_uninstalled_git_source_requires_install_without_cloning()
```

**Purpose**: Ensures reading an uninstalled Git-source plugin does not clone it just to show details.

**Data flow**: It writes a marketplace pointing to a missing Git repo, reads the plugin, and expects an install-required reason, a helpful description, no capabilities, and no staging folder.

**Call relations**: It tests a safe, no-network/no-clone path for unavailable remote source details.

*Call graph*: calls 3 internal fn (new, load_config, try_from); 7 external calls (assert!, assert_eq!, write_file, format!, create_dir_all, tempdir, from_directory_path).


##### `read_plugin_for_config_installed_git_source_reads_from_cache_without_cloning`  (lines 2697–2867)

```
async fn read_plugin_for_config_installed_git_source_reads_from_cache_without_cloning()
```

**Purpose**: Checks that an installed Git-source plugin’s details come from the cached copy, not from cloning the source again.

**Data flow**: It writes a marketplace pointing to a missing repo but also writes a cached plugin with manifest, skill, apps, MCP, and hooks. Reading details should return cached metadata and leave no staging folder.

**Call relations**: It complements the uninstalled Git-source test by proving cache is enough when present.

*Call graph*: calls 3 internal fn (new, load_config, try_from); 7 external calls (assert!, assert_eq!, write_file, format!, create_dir_all, tempdir, from_directory_path).


##### `list_marketplaces_installed_git_source_reads_metadata_from_cache_without_cloning`  (lines 2870–2983)

```
async fn list_marketplaces_installed_git_source_reads_metadata_from_cache_without_cloning()
```

**Purpose**: Verifies marketplace listing enriches an installed Git-source plugin with manifest interface metadata from cache.

**Data flow**: It writes a Git-source marketplace whose remote is missing, creates a cached manifest with interface assets, lists marketplaces, and expects cached metadata and absolute asset paths.

**Call relations**: It tests list_marketplaces_for_config’s cache metadata path for installed Git plugins.

*Call graph*: calls 3 internal fn (new, load_config, try_from); 7 external calls (assert!, assert_eq!, write_file, format!, create_dir_all, tempdir, from_directory_path).


##### `list_marketplaces_includes_curated_repo_marketplace`  (lines 2986–3059)

```
async fn list_marketplaces_includes_curated_repo_marketplace()
```

**Purpose**: Checks that the OpenAI curated marketplace repository is included when requested.

**Data flow**: It writes a curated marketplace file and plugin manifest under the curated repo path, lists marketplaces with curated inclusion enabled, and compares the resulting marketplace.

**Call relations**: It exercises the built-in curated marketplace discovery path.

*Call graph*: calls 3 internal fn (new, load_config, curated_plugins_repo_path); 5 external calls (assert_eq!, write_file, create_dir_all, write, tempdir).


##### `list_marketplaces_can_skip_openai_curated_before_loading`  (lines 3062–3090)

```
async fn list_marketplaces_can_skip_openai_curated_before_loading()
```

**Purpose**: Ensures callers can skip loading OpenAI curated marketplace files entirely.

**Data flow**: It writes an invalid curated marketplace file, calls listing with include_openai_curated false, and expects no errors and no curated marketplace entry.

**Call relations**: It proves the skip flag prevents even malformed curated files from affecting marketplace listing.

*Call graph*: calls 3 internal fn (new, load_config, curated_plugins_repo_path); 3 external calls (assert_eq!, write_file, tempdir).


##### `list_marketplaces_uses_api_curated_manifest_when_selected`  (lines 3093–3181)

```
async fn list_marketplaces_uses_api_curated_manifest_when_selected()
```

**Purpose**: Checks that API-key-style auth selects the API curated marketplace manifest instead of the normal curated manifest.

**Data flow**: It writes both curated manifest files, sets auth mode to API key, lists marketplaces, and expects the API curated marketplace and plugin.

**Call relations**: It links manager auth mode to curated marketplace selection.

*Call graph*: calls 3 internal fn (new, load_config, curated_plugins_repo_path); 3 external calls (assert_eq!, write_file, tempdir).


##### `list_marketplaces_skips_missing_api_curated_manifest`  (lines 3184–3214)

```
async fn list_marketplaces_skips_missing_api_curated_manifest()
```

**Purpose**: Ensures missing API curated marketplace files are skipped without reporting errors for API-like auth modes.

**Data flow**: It writes only a malformed normal curated manifest, sets API-related auth, lists marketplaces, and expects no API curated entry and no errors.

**Call relations**: It tests graceful behavior when the auth-selected curated manifest is absent.

*Call graph*: calls 3 internal fn (new, load_config, curated_plugins_repo_path); 3 external calls (assert_eq!, write_file, tempdir).


##### `list_marketplaces_includes_installed_marketplace_roots`  (lines 3217–3286)

```
async fn list_marketplaces_includes_installed_marketplace_roots()
```

**Purpose**: Checks that marketplaces installed into the user’s marketplace root are listed when also recorded in config.

**Data flow**: It writes config metadata for an installed marketplace, creates its marketplace file and plugin, lists marketplaces, and verifies the installed root appears.

**Call relations**: It tests discovery of marketplace roots outside the current repository.

*Call graph*: calls 3 internal fn (marketplace_install_root, new, load_config); 5 external calls (assert_eq!, write_file, create_dir_all, write, tempdir).


##### `list_marketplaces_uses_config_when_known_registry_is_malformed`  (lines 3289–3350)

```
async fn list_marketplaces_uses_config_when_known_registry_is_malformed()
```

**Purpose**: Verifies configured installed marketplaces are still discovered even if the known-marketplaces registry file is malformed.

**Data flow**: It writes valid marketplace config and files plus an invalid known_marketplaces.json, lists marketplaces, and expects the configured marketplace plugin.

**Call relations**: It protects marketplace discovery from an unrelated broken registry cache.

*Call graph*: calls 3 internal fn (marketplace_install_root, new, load_config); 5 external calls (assert_eq!, write_file, create_dir_all, write, tempdir).


##### `list_marketplaces_ignores_installed_roots_missing_from_config`  (lines 3353–3403)

```
async fn list_marketplaces_ignores_installed_roots_missing_from_config()
```

**Purpose**: Ensures installed marketplace folders are not listed unless the user config knows about them.

**Data flow**: It creates an installed marketplace folder but no matching config entry, lists marketplaces, and asserts that root is absent.

**Call relations**: It complements the installed-root inclusion test by confirming config is required.

*Call graph*: calls 3 internal fn (marketplace_install_root, new, load_config); 5 external calls (assert!, write_file, create_dir_all, write, tempdir).


##### `list_marketplaces_uses_first_duplicate_plugin_entry`  (lines 3406–3549)

```
async fn list_marketplaces_uses_first_duplicate_plugin_entry()
```

**Purpose**: Checks that duplicate plugin names across marketplaces are resolved by keeping the first discovered entry.

**Data flow**: It creates two repository marketplaces with the same marketplace name and a duplicate plugin, lists both roots, and expects only the first duplicate plus the unique second plugin.

**Call relations**: It tests duplicate filtering across the marketplace list produced by list_marketplaces_for_config.

*Call graph*: calls 3 internal fn (new, load_config, try_from); 5 external calls (assert_eq!, write_file, create_dir_all, write, tempdir).


##### `list_marketplaces_marks_configured_plugin_uninstalled_when_cache_is_missing`  (lines 3552–3633)

```
async fn list_marketplaces_marks_configured_plugin_uninstalled_when_cache_is_missing()
```

**Purpose**: Verifies an enabled plugin in config is shown as enabled but not installed if its cache folder is missing.

**Data flow**: It writes marketplace metadata and config enabling a plugin, does not create cache files, lists marketplaces, and expects installed false with enabled true.

**Call relations**: It checks marketplace UI state when config and local cache disagree.

*Call graph*: calls 3 internal fn (new, load_config, try_from); 5 external calls (assert_eq!, write_file, create_dir_all, write, tempdir).


##### `featured_plugin_ids_for_config_uses_restriction_product_query_param`  (lines 3636–3672)

```
async fn featured_plugin_ids_for_config_uses_restriction_product_query_param()
```

**Purpose**: Checks that featured plugin lookup sends the manager’s product restriction as a platform query parameter.

**Data flow**: It starts a mock server expecting platform=chat and auth headers, points config at it, calls featured_plugin_ids_for_config, and expects the returned plugin id.

**Call relations**: It tests the network-facing featured-plugin helper with Product::Chatgpt.

*Call graph*: calls 3 internal fn (new_with_options, load_config, create_dummy_chatgpt_auth_for_testing); 11 external calls (given, start, new, assert_eq!, write_file, format!, tempdir, header, method, path (+1 more)).


##### `featured_plugin_ids_for_config_defaults_query_param_to_codex`  (lines 3675–3706)

```
async fn featured_plugin_ids_for_config_defaults_query_param_to_codex()
```

**Purpose**: Verifies featured plugin lookup defaults its platform query to codex when no product restriction is set.

**Data flow**: It starts a mock server expecting platform=codex, calls featured_plugin_ids_for_config without auth, and checks the returned id.

**Call relations**: It complements the product-restriction test by covering the default path.

*Call graph*: calls 2 internal fn (new_with_options, load_config); 10 external calls (given, start, new, assert_eq!, write_file, format!, tempdir, method, path, query_param).


##### `remote_plugin_caches_refresh_warms_recommended_plugins_cache`  (lines 3709–3767)

```
async fn remote_plugin_caches_refresh_warms_recommended_plugins_cache()
```

**Purpose**: Checks that starting a remote plugin cache refresh also warms the recommended plugins cache in the background.

**Data flow**: It starts a mock suggested-plugins endpoint, calls maybe_start_remote_plugin_caches_refresh, waits until the cache is populated, then verifies cached and direct recommended modes match and can be cleared.

**Call relations**: It exercises asynchronous background refresh behavior on an Arc-wrapped PluginsManager.

*Call graph*: calls 3 internal fn (new, load_config, create_dummy_chatgpt_auth_for_testing); 15 external calls (from_millis, from_secs, given, start, new, assert_eq!, write_file, json!, new, tempdir (+5 more)).


##### `recommended_plugins_mode_deduplicates_concurrent_cache_misses`  (lines 3770–3845)

```
async fn recommended_plugins_mode_deduplicates_concurrent_cache_misses()
```

**Purpose**: Ensures two simultaneous recommended-plugin requests share one network fetch.

**Data flow**: It sets up a delayed mock endpoint expected once, launches two concurrent requests, and checks both receive the same sorted endpoint result. A later request should come from cache.

**Call relations**: It tests cache miss deduplication for recommended_plugins_mode_for_config.

*Call graph*: calls 3 internal fn (new, load_config, create_dummy_chatgpt_auth_for_testing); 14 external calls (from_millis, given, start, new, assert_eq!, write_file, json!, tempdir, join!, vec! (+4 more)).


##### `recommended_plugins_mode_caches_explicit_false`  (lines 3848–3885)

```
async fn recommended_plugins_mode_caches_explicit_false()
```

**Purpose**: Checks that an endpoint response saying recommendations are disabled is cached as legacy mode.

**Data flow**: It mock-returns enabled false, calls recommended_plugins_mode_for_config twice, and expects Legacy both times with only one endpoint expectation.

**Call relations**: It tests caching of a valid negative response.

*Call graph*: calls 3 internal fn (new, load_config, create_dummy_chatgpt_auth_for_testing); 9 external calls (given, start, new, assert_eq!, write_file, json!, tempdir, method, path).


##### `recommended_plugins_mode_retries_after_fetch_failure`  (lines 3888–3936)

```
async fn recommended_plugins_mode_retries_after_fetch_failure()
```

**Purpose**: Verifies a failed recommended-plugin fetch does not poison the cache forever.

**Data flow**: It first mock-returns a server error and expects Legacy, then replaces the mock with a successful response and expects Endpoint mode on the next call.

**Call relations**: It tests retry behavior after network failure.

*Call graph*: calls 3 internal fn (new, load_config, create_dummy_chatgpt_auth_for_testing); 9 external calls (given, start, new, assert_eq!, write_file, json!, tempdir, method, path).


##### `refresh_curated_plugin_cache_replaces_existing_local_version_with_short_sha_version`  (lines 3939–3972)

```
fn refresh_curated_plugin_cache_replaces_existing_local_version_with_short_sha_version()
```

**Purpose**: Checks curated cache refresh replaces an old local cache version with the current short SHA version.

**Data flow**: It writes a curated marketplace, SHA file, and old local cached plugin, refreshes the cache, then checks the old folder is gone and the short-SHA folder exists.

**Call relations**: It directly tests refresh_curated_plugin_cache for an outdated installed curated plugin.

*Call graph*: calls 3 internal fn (write_plugin, curated_plugins_repo_path, new); 4 external calls (assert!, write_curated_plugin_sha_with, write_openai_curated_marketplace, tempdir).


##### `refresh_curated_plugin_cache_reinstalls_missing_configured_plugin_with_current_short_version`  (lines 3975–3998)

```
fn refresh_curated_plugin_cache_reinstalls_missing_configured_plugin_with_current_short_version()
```

**Purpose**: Ensures a configured curated plugin missing from cache is reinstalled during refresh.

**Data flow**: It writes curated marketplace data and SHA, gives refresh a configured plugin id, and expects the current short-version cache folder to be created.

**Call relations**: It tests recovery from a missing curated plugin cache.

*Call graph*: calls 2 internal fn (curated_plugins_repo_path, new); 4 external calls (assert!, write_curated_plugin_sha_with, write_openai_curated_marketplace, tempdir).


##### `refresh_curated_plugin_cache_reinstalls_missing_api_curated_plugin`  (lines 4001–4025)

```
fn refresh_curated_plugin_cache_reinstalls_missing_api_curated_plugin()
```

**Purpose**: Checks the same missing-cache reinstall behavior for API curated plugins.

**Data flow**: It writes both curated marketplace files with the target only in the API curated file, refreshes for that plugin id, and expects an API curated cache folder.

**Call relations**: It extends curated refresh coverage to the API curated marketplace name.

*Call graph*: calls 3 internal fn (curated_plugins_repo_path, write_openai_api_curated_marketplace, new); 4 external calls (assert!, write_curated_plugin_sha_with, write_openai_curated_marketplace, tempdir).


##### `refresh_curated_plugin_cache_leaves_api_curated_plugin_when_api_manifest_missing`  (lines 4028–4048)

```
fn refresh_curated_plugin_cache_leaves_api_curated_plugin_when_api_manifest_missing()
```

**Purpose**: Ensures an existing API curated cached plugin is not removed if the API curated manifest is missing.

**Data flow**: It writes only the normal curated marketplace, creates an API curated cached plugin, refreshes, and expects no changes plus the cache folder still present.

**Call relations**: It protects users from losing API curated plugins when the API manifest is unavailable.

*Call graph*: calls 3 internal fn (write_cached_plugin, curated_plugins_repo_path, new); 3 external calls (assert!, write_openai_curated_marketplace, tempdir).


##### `refresh_curated_plugin_cache_removes_cache_for_plugin_removed_from_marketplace`  (lines 4051–4075)

```
fn refresh_curated_plugin_cache_removes_cache_for_plugin_removed_from_marketplace()
```

**Purpose**: Checks that curated refresh deletes a configured plugin cache if the plugin no longer exists in the curated marketplace.

**Data flow**: It writes an empty curated marketplace, creates a cached plugin folder for a removed plugin, refreshes, and expects the plugin cache root to be gone.

**Call relations**: It tests stale curated plugin cleanup.

*Call graph*: calls 3 internal fn (write_plugin, curated_plugins_repo_path, new); 4 external calls (assert!, write_openai_curated_marketplace, format!, tempdir).


##### `curated_plugin_ids_from_config_keys_reads_latest_codex_home_user_config`  (lines 4078–4118)

```
fn curated_plugin_ids_from_config_keys_reads_latest_codex_home_user_config()
```

**Purpose**: Verifies configured curated plugin ids are read from the current user config file each time.

**Data flow**: It writes config containing curated, API curated, and non-curated plugin keys, checks only curated ids are returned, then rewrites config without them and expects an empty list.

**Call relations**: It tests the config-reading helper used by curated cache refresh startup work.

*Call graph*: 3 external calls (assert_eq!, write_file, tempdir).


##### `refresh_curated_plugin_cache_returns_false_when_configured_plugins_are_current`  (lines 4121–4140)

```
fn refresh_curated_plugin_cache_returns_false_when_configured_plugins_are_current()
```

**Purpose**: Checks curated refresh reports no change when the cache already has the current version.

**Data flow**: It writes a curated marketplace and a cache folder using the expected short version, refreshes, and expects a false return value.

**Call relations**: It verifies the no-op path for refresh_curated_plugin_cache.

*Call graph*: calls 3 internal fn (write_plugin, curated_plugins_repo_path, new); 4 external calls (assert!, write_openai_curated_marketplace, format!, tempdir).


##### `refresh_curated_plugin_cache_migrates_full_sha_cache_version_to_short_version`  (lines 4143–4176)

```
fn refresh_curated_plugin_cache_migrates_full_sha_cache_version_to_short_version()
```

**Purpose**: Ensures old curated cache folders named with the full SHA are migrated to the short SHA version.

**Data flow**: It writes a plugin cache folder using the full SHA, refreshes, and checks the full-SHA folder is removed and the short-version folder exists.

**Call relations**: It tests backward compatibility for an older curated cache naming scheme.

*Call graph*: calls 3 internal fn (write_plugin, curated_plugins_repo_path, new); 4 external calls (assert!, write_openai_curated_marketplace, format!, tempdir).


##### `refresh_non_curated_plugin_cache_replaces_existing_local_version_with_manifest_version`  (lines 4179–4233)

```
fn refresh_non_curated_plugin_cache_replaces_existing_local_version_with_manifest_version()
```

**Purpose**: Checks non-curated cache refresh replaces a local cache folder with the plugin’s manifest version.

**Data flow**: It writes a marketplace plugin with version 1.2.3, creates an old local cache, refreshes, and expects the local folder gone and the versioned folder present.

**Call relations**: It directly tests refresh_non_curated_plugin_cache for local marketplace sources.

*Call graph*: calls 2 internal fn (write_plugin, write_plugin_with_version); 4 external calls (assert!, write_file, create_dir_all, tempdir).


##### `refresh_non_curated_plugin_cache_reinstalls_missing_configured_plugin_with_manifest_version`  (lines 4236–4280)

```
fn refresh_non_curated_plugin_cache_reinstalls_missing_configured_plugin_with_manifest_version()
```

**Purpose**: Ensures non-curated refresh recreates a missing configured plugin cache using the manifest version.

**Data flow**: It writes a versioned marketplace plugin and config enabling it but no cache, refreshes, and expects the versioned cache folder.

**Call relations**: It tests missing-cache recovery for non-curated plugins.

*Call graph*: calls 1 internal fn (write_plugin_with_version); 4 external calls (assert!, write_file, create_dir_all, tempdir).


##### `refresh_non_curated_plugin_cache_refreshes_configured_git_source`  (lines 4283–4339)

```
fn refresh_non_curated_plugin_cache_refreshes_configured_git_source()
```

**Purpose**: Checks non-curated refresh can materialize a configured plugin from a Git subdirectory source.

**Data flow**: It creates a Git repo with a versioned plugin, writes a marketplace pointing to that repo, enables the plugin in config, refreshes, and expects the versioned cache folder.

**Call relations**: It combines init_git_repo with refresh_non_curated_plugin_cache to cover Git-backed marketplace entries.

*Call graph*: calls 2 internal fn (init_git_repo, write_plugin_with_version); 6 external calls (assert!, write_file, format!, create_dir_all, tempdir, from_directory_path).


##### `refresh_non_curated_plugin_cache_returns_false_when_configured_plugins_are_current`  (lines 4342–4386)

```
fn refresh_non_curated_plugin_cache_returns_false_when_configured_plugins_are_current()
```

**Purpose**: Verifies non-curated refresh reports no change when configured plugin caches already match their manifest version.

**Data flow**: It writes a marketplace plugin and an already-current cache folder, refreshes, and expects a false return value.

**Call relations**: It tests the no-op path for non-curated refresh.

*Call graph*: calls 1 internal fn (write_plugin_with_version); 4 external calls (assert!, write_file, create_dir_all, tempdir).


##### `refresh_non_curated_plugin_cache_force_reinstalls_current_local_version`  (lines 4389–4448)

```
fn refresh_non_curated_plugin_cache_force_reinstalls_current_local_version()
```

**Purpose**: Checks the force-refresh path reinstalls even when the version name has not changed.

**Data flow**: It writes a source plugin with new skill contents and an existing cache with old contents, force-refreshes, and expects the cached skill file to contain the new text.

**Call relations**: It tests refresh_non_curated_plugin_cache_force_reinstall, which is stricter than the normal no-op refresh.

*Call graph*: calls 1 internal fn (write_plugin); 6 external calls (assert!, assert_eq!, write_file, create_dir_all, write, tempdir).


##### `refresh_non_curated_plugin_cache_ignores_invalid_unconfigured_plugin_versions`  (lines 4451–4503)

```
fn refresh_non_curated_plugin_cache_ignores_invalid_unconfigured_plugin_versions()
```

**Purpose**: Ensures a malformed version in an unrelated, unconfigured plugin does not block refreshing a valid configured plugin.

**Data flow**: It writes one valid configured plugin and one broken unconfigured plugin in the same marketplace, refreshes, and expects the valid plugin cache to be created.

**Call relations**: It protects cache refresh from failing on marketplace entries the user has not configured.

*Call graph*: calls 1 internal fn (write_plugin_with_version); 4 external calls (assert!, write_file, create_dir_all, tempdir).


##### `load_plugins_ignores_project_config_files`  (lines 4506–4548)

```
async fn load_plugins_ignores_project_config_files()
```

**Purpose**: Checks that project-level config files do not enable plugins during low-level layer-stack loading.

**Data flow**: It writes a plugin cache and constructs a config layer stack containing only a project config enabling the plugin, then calls load_plugins_from_layer_stack and expects no plugins.

**Call relations**: It tests that plugin loading uses the intended config layers and ignores project config for plugin enablement.

*Call graph*: calls 4 internal fn (new, load_plugins_from_layer_stack, plugin_config_toml, new); 7 external calls (new, default, assert_eq!, default, write_file, new, vec!).


##### `plugin_hooks_for_layer_stack_loads_configured_plugin_hooks`  (lines 4551–4595)

```
async fn plugin_hooks_for_layer_stack_loads_configured_plugin_hooks()
```

**Purpose**: Verifies configured plugin hook files are loaded through the manager’s hook-loading path.

**Data flow**: It writes a plugin with hooks/hooks.json, enables the plugin, loads config, calls plugin_hooks_for_layer_stack, and checks one hook source and no warnings.

**Call relations**: It exercises hook discovery after normal config loading and plugin cache setup.

*Call graph*: calls 4 internal fn (new, load_config, plugin_config_toml, write_plugin); 3 external calls (new, assert_eq!, write_file).


### `core-plugins/src/discoverable_tests.rs`

`test` · `test run`

This is a test file, so it does not provide the plugin discovery feature itself. Instead, it protects that feature from breaking. The feature under test is the list of plugins Codex can suggest to a user when they are choosing tools. A plugin might come from an OpenAI-curated marketplace, an API-key-specific curated marketplace, a bundled marketplace, or a cached remote catalog. Some plugins should be hidden because they are already installed, disabled, unavailable, missing from disk, or not relevant to the user’s loaded app connectors.

Each test creates a temporary Codex home folder, writes fake marketplace files into it, loads the plugin configuration, creates a PluginsManager, and asks for discoverable plugins. The tests then compare the returned plugin IDs or full plugin records with the expected answer.

The file also checks subtle behavior. For example, descriptions should have messy whitespace cleaned up, marketplace data should not be reloaded repeatedly for every plugin, local plugins should not be expanded merely because an app connector is installed, and cached remote plugins can be suggested when their app connector is already loaded. Small helper functions at the bottom keep the setup readable: they build discovery input, call the manager, install a fake plugin, and write fake app metadata.

#### Function details

##### `returns_fallback_plugins_without_installed_apps`  (lines 37–61)

```
async fn returns_fallback_plugins_without_installed_apps()
```

**Purpose**: Checks the default fallback suggestions when the user has no installed app connectors. It verifies that Codex suggests the expected OpenAI-curated plugins and leaves out plugins that should not appear in this fallback list.

**Data flow**: The test starts with an empty temporary Codex home, writes a fake curated marketplace containing several plugins, and loads that configuration. It asks the plugin manager for discoverable plugins with no configured, disabled, or loaded app connector IDs. The result is turned into plugin IDs and compared with the expected curated suggestions.

**Call relations**: This test uses the shared setup helper `discovery_input` to shape the request and `list_discoverable_plugins` to call the real discovery path. It relies on the test support helpers to create the fake marketplace before the plugin manager reads it.

*Call graph*: calls 4 internal fn (discovery_input, list_discoverable_plugins, new, curated_plugins_repo_path); 4 external calls (assert_eq!, load_plugins_config, write_openai_curated_marketplace, tempdir).


##### `returns_api_curated_fallback_plugins_for_direct_provider_auth`  (lines 64–89)

```
async fn returns_api_curated_fallback_plugins_for_direct_provider_auth()
```

**Purpose**: Checks that API-key authentication changes which curated fallback marketplace is used. In this case, Codex should suggest plugins from the OpenAI API curated marketplace rather than the normal curated marketplace.

**Data flow**: The test creates a temporary home, writes an API-specific curated marketplace, creates a fake API-key authentication object, and loads the plugin configuration. It sends those inputs to discovery and receives a list of suggested plugins. The plugin IDs are compared with the API-curated IDs.

**Call relations**: Like the other discovery tests, it goes through `discovery_input` and `list_discoverable_plugins`. The important difference is that it passes authentication, so the underlying plugin manager can choose the auth-specific source.

*Call graph*: calls 6 internal fn (discovery_input, list_discoverable_plugins, new, curated_plugins_repo_path, write_openai_api_curated_marketplace, from_api_key); 3 external calls (assert_eq!, load_plugins_config, tempdir).


##### `returns_microsoft_fallback_plugins`  (lines 92–121)

```
async fn returns_microsoft_fallback_plugins()
```

**Purpose**: Checks the fallback suggestions for a group of Microsoft-related plugins. It confirms that once one plugin in that group is installed, Codex suggests the remaining related plugins instead of the installed one.

**Data flow**: The test writes a curated marketplace with Teams, SharePoint, Outlook email, and Outlook calendar plugins. It installs Teams, loads configuration, and asks for discoverable plugins with no extra app information. The output IDs should be the other Microsoft-related plugins.

**Call relations**: This test uses `install_marketplace_plugin` to put one marketplace plugin into the installed state. It then uses the same discovery helper path as the rest of the file to verify the manager’s filtering behavior.

*Call graph*: calls 5 internal fn (discovery_input, install_marketplace_plugin, list_discoverable_plugins, new, curated_plugins_repo_path); 4 external calls (assert_eq!, load_plugins_config, write_openai_curated_marketplace, tempdir).


##### `includes_openai_curated_when_remote_enabled`  (lines 124–179)

```
async fn includes_openai_curated_when_remote_enabled()
```

**Purpose**: Checks that turning on remote plugin support does not hide locally curated OpenAI plugins. Codex should still show curated suggestions alongside bundled marketplace plugins.

**Data flow**: The test creates a curated marketplace with Slack and a bundled marketplace with Chrome, then writes a configuration file enabling both plugins and remote plugins. After loading the configuration, it asks for discoverable plugins. The returned IDs should include both the bundled Chrome plugin and the curated Slack plugin.

**Call relations**: The test prepares files directly with the test support writers, then sends the loaded configuration through `discovery_input` and `list_discoverable_plugins`. It proves that the remote-enabled path still consults local curated sources.

*Call graph*: calls 4 internal fn (discovery_input, list_discoverable_plugins, new, curated_plugins_repo_path); 7 external calls (assert_eq!, load_plugins_config, write_curated_plugin, write_file, write_openai_curated_marketplace, format!, tempdir).


##### `deduplicates_configured_marketplace_plugin`  (lines 182–227)

```
async fn deduplicates_configured_marketplace_plugin()
```

**Purpose**: Checks that a plugin does not appear twice when it is both present in a marketplace and already listed as configured. This prevents duplicate suggestions in the user interface.

**Data flow**: The test writes a fake bundled marketplace containing one plugin and marks that same plugin ID as already configured in the discovery input. Discovery returns a list, and the test checks that the list contains exactly one entry with that plugin ID.

**Call relations**: This test feeds a configured plugin ID through `discovery_input`. The actual duplicate-removal behavior is exercised inside `list_discoverable_plugins`, which calls the real plugin manager method.

*Call graph*: calls 3 internal fn (discovery_input, list_discoverable_plugins, new); 6 external calls (assert_eq!, load_plugins_config, write_curated_plugin, write_file, format!, tempdir).


##### `ignores_missing_marketplace_plugin`  (lines 230–275)

```
async fn ignores_missing_marketplace_plugin()
```

**Purpose**: Checks that a marketplace entry is ignored if the plugin files are missing from disk. This matters because a marketplace catalog can mention a plugin whose folder is absent or incomplete.

**Data flow**: The test writes a curated marketplace with installed and Slack plugins, plus a separate bundled marketplace entry for Sample without writing Sample’s plugin files. It installs the curated Installed plugin, loads configuration, and asks for suggestions. The only returned plugin should be Slack from the curated marketplace.

**Call relations**: The setup combines direct file writing with `install_marketplace_plugin`. The discovery call goes through `list_discoverable_plugins`, which is expected to skip the broken marketplace entry rather than fail or show it.

*Call graph*: calls 5 internal fn (discovery_input, install_marketplace_plugin, list_discoverable_plugins, new, curated_plugins_repo_path); 6 external calls (assert_eq!, load_plugins_config, write_file, write_openai_curated_marketplace, format!, tempdir).


##### `normalizes_description`  (lines 278–312)

```
async fn normalizes_description()
```

**Purpose**: Checks that plugin descriptions are cleaned up before being shown. Extra spaces and newlines in the plugin metadata should become a readable one-line description.

**Data flow**: The test writes a Slack plugin metadata file whose description has leading spaces, a newline, and repeated spacing. It installs another plugin so Slack remains discoverable, then asks for suggestions. The returned Slack record should contain the normalized description and its other expected metadata.

**Call relations**: This test uses `install_marketplace_plugin` to create the installed-plugin context and `list_discoverable_plugins` to exercise the real metadata reading path. It verifies the final user-facing record, not just the ID.

*Call graph*: calls 5 internal fn (discovery_input, install_marketplace_plugin, list_discoverable_plugins, new, curated_plugins_repo_path); 5 external calls (assert_eq!, load_plugins_config, write_file, write_openai_curated_marketplace, tempdir).


##### `omits_installed_curated_plugins`  (lines 315–331)

```
async fn omits_installed_curated_plugins()
```

**Purpose**: Checks that Codex does not suggest a curated plugin that is already installed. A suggestion list should help users discover new options, not repeat what they already have.

**Data flow**: The test writes a curated marketplace containing Slack, installs Slack, loads the configuration, and asks for discoverable plugins. The expected result is an empty list.

**Call relations**: The installed state is created with `install_marketplace_plugin`. The discovery request is built by `discovery_input` and sent through `list_discoverable_plugins`, which should filter out the installed plugin.

*Call graph*: calls 5 internal fn (discovery_input, install_marketplace_plugin, list_discoverable_plugins, new, curated_plugins_repo_path); 4 external calls (assert_eq!, load_plugins_config, write_openai_curated_marketplace, tempdir).


##### `omits_not_available_curated_plugins`  (lines 334–391)

```
async fn omits_not_available_curated_plugins()
```

**Purpose**: Checks that curated plugins marked as not available are not suggested. This protects users from seeing options they cannot install.

**Data flow**: The test writes a custom marketplace file with Installed, Slack, and Gmail, where Gmail has an installation policy saying it is not available. It writes plugin folders, installs the Installed plugin, and asks for suggestions. The output should include Slack only.

**Call relations**: This test creates a more detailed marketplace file by hand, then uses `install_marketplace_plugin` and the common discovery helpers. It confirms that policy information in the marketplace affects the final suggestion list.

*Call graph*: calls 5 internal fn (discovery_input, install_marketplace_plugin, list_discoverable_plugins, new, curated_plugins_repo_path); 5 external calls (assert_eq!, load_plugins_config, write_curated_plugin, write_file, tempdir).


##### `does_not_reload_marketplace_per_plugin`  (lines 394–454)

```
async fn does_not_reload_marketplace_per_plugin()
```

**Purpose**: Checks that the marketplace is not reread from scratch for every plugin. This is a performance and log-noise test: repeated loading would produce repeated warnings and waste work.

**Data flow**: The test creates a curated marketplace with several plugins, installs one, and gives the remaining plugins metadata that triggers warning logs because a prompt is too long. It captures warning logs while running discovery. The returned plugin IDs and the number of warning messages are compared with the expected counts.

**Call relations**: This test uses `install_marketplace_plugin`, `discovery_input`, and `list_discoverable_plugins`, but also installs a temporary tracing subscriber, which is a log collector. The log counts reveal whether the underlying discovery code reused marketplace data or loaded it repeatedly.

*Call graph*: calls 5 internal fn (discovery_input, install_marketplace_plugin, list_discoverable_plugins, new, curated_plugins_repo_path); 14 external calls (leak, new, new, from_utf8, new, assert_eq!, load_plugins_config, write_file, write_openai_curated_marketplace, format! (+4 more)).


##### `does_not_expand_local_plugins_by_installed_apps`  (lines 457–474)

```
async fn does_not_expand_local_plugins_by_installed_apps()
```

**Purpose**: Checks that local marketplace plugins are not suggested merely because their app metadata mentions an installed app. This keeps local plugin discovery from becoming too broad.

**Data flow**: The test writes a curated marketplace with Sample, Slack, and HubSpot, adds app connector metadata to Sample, and installs Slack. It runs discovery with no loaded app connector IDs. The expected result is an empty list.

**Call relations**: The app metadata is written through `write_plugin_app`, and the installed plugin state is created through `install_marketplace_plugin`. Discovery is then called normally to confirm that local app metadata does not expand suggestions in this scenario.

*Call graph*: calls 6 internal fn (discovery_input, install_marketplace_plugin, list_discoverable_plugins, write_plugin_app, new, curated_plugins_repo_path); 4 external calls (assert_eq!, load_plugins_config, write_openai_curated_marketplace, tempdir).


##### `does_not_read_local_plugins_for_loaded_apps`  (lines 477–515)

```
async fn does_not_read_local_plugins_for_loaded_apps()
```

**Purpose**: Checks that discovery does not scan local plugin app files when deciding suggestions for already loaded app connectors. This avoids unnecessary file reads and avoids warnings from unrelated bad files.

**Data flow**: The test writes app metadata for HubSpot and Granola, then writes invalid JSON into Sample’s app metadata file. It captures warning logs and runs discovery with the HubSpot app connector marked as already loaded. The result should be empty, and the logs should not mention the invalid Sample app file.

**Call relations**: This test uses `write_plugin_app` for valid app files and direct file writing for the invalid one. It then goes through `discovery_input` and `list_discoverable_plugins`; the absence of log messages proves the discovery path did not read the unrelated local app file.

*Call graph*: calls 5 internal fn (discovery_input, list_discoverable_plugins, write_plugin_app, new, curated_plugins_repo_path); 13 external calls (leak, new, new, from_utf8, new, assert_eq!, load_plugins_config, write_file, write_openai_curated_marketplace, new (+3 more)).


##### `does_not_expand_local_sales_apps`  (lines 518–586)

```
async fn does_not_expand_local_sales_apps()
```

**Purpose**: Checks that an installed local “sales” style plugin does not cause related local app plugins to be suggested. This prevents local marketplace app relationships from accidentally expanding the suggestion list.

**Data flow**: The test writes curated plugins with app IDs, creates a separate sales marketplace whose installed plugin mentions HubSpot and Granola app IDs, installs that sales plugin, and loads configuration. It then asks for discoverable plugins. The expected result is an empty list.

**Call relations**: This test combines `write_plugin_app` for app metadata, manual marketplace setup, and `install_marketplace_plugin` for installation. It then uses the shared discovery helpers to show that installed local app relationships are not used as suggestion triggers.

*Call graph*: calls 6 internal fn (discovery_input, install_marketplace_plugin, list_discoverable_plugins, write_plugin_app, new, curated_plugins_repo_path); 7 external calls (assert_eq!, load_plugins_config, write_curated_plugin, write_file, write_openai_curated_marketplace, format!, tempdir).


##### `expands_cached_remote_plugins_by_loaded_apps`  (lines 589–706)

```
async fn expands_cached_remote_plugins_by_loaded_apps()
```

**Purpose**: Checks that cached remote plugins can be suggested when the user already has a related app connector loaded. Unlike local plugins, remote catalog data is allowed to expand suggestions in this way.

**Data flow**: The test enables remote plugins, starts a fake HTTP server, and makes that server return one global remote plugin with an app ID. It fetches and caches the remote global catalog, also caches the empty remote installed-plugin lists, then runs discovery with that app ID marked as loaded. The result should be one discoverable remote plugin with its remote ID, display name, short description, skills flag, and app connector ID.

**Call relations**: This is the broadest test in the file. It uses the fake server to stand in for the real remote plugin service, calls `fetch_and_cache_global_remote_plugin_catalog` to create the cache, asks `PluginsManager` to cache installed remote marketplaces, and finally uses `list_discoverable_plugins` to verify the suggestion produced from cached remote data.

*Call graph*: calls 5 internal fn (discovery_input, list_discoverable_plugins, new, fetch_and_cache_global_remote_plugin_catalog, create_dummy_chatgpt_auth_for_testing); 12 external calls (given, start, new, assert_eq!, load_plugins_config, write_file, format!, json!, tempdir, method (+2 more)).


##### `discovery_input`  (lines 708–720)

```
fn discovery_input(
    plugins: PluginsConfigInput,
    configured_plugin_ids: &[&str],
    disabled_plugin_ids: &[&str],
    loaded_plugin_app_connector_ids: &[&str],
) -> ToolSuggestPluginDiscovery
```

**Purpose**: Builds the request object used by the tests when asking for discoverable plugins. It keeps each test from repeating the same conversion work.

**Data flow**: It receives a loaded plugin configuration plus three lists of string IDs: configured plugins, disabled plugins, and loaded app connectors. It converts those lists into sets, which are collections that make membership checks easy, and returns a `ToolSuggestPluginDiscoveryInput` containing all of that information.

**Call relations**: Nearly every test calls this helper just before discovery. It delegates the string-list conversion to `string_set`, then hands the finished input to `list_discoverable_plugins`.

*Call graph*: calls 1 internal fn (string_set); called by 14 (deduplicates_configured_marketplace_plugin, does_not_expand_local_plugins_by_installed_apps, does_not_expand_local_sales_apps, does_not_read_local_plugins_for_loaded_apps, does_not_reload_marketplace_per_plugin, expands_cached_remote_plugins_by_loaded_apps, ignores_missing_marketplace_plugin, includes_openai_curated_when_remote_enabled, normalizes_description, omits_installed_curated_plugins (+4 more)).


##### `list_discoverable_plugins`  (lines 722–731)

```
async fn list_discoverable_plugins(
    plugins_manager: &PluginsManager,
    input: ToolSuggestPluginDiscoveryInput,
    auth: Option<&CodexAuth>,
) -> Vec<ToolSuggestDiscoverablePlugin>
```

**Purpose**: Calls the real plugin manager method that the tests are exercising. It also unwraps the result so a failed discovery causes the test to fail immediately with a clear message.

**Data flow**: It receives a plugin manager, a discovery input object, and optional authentication. It asks the manager to list tool-suggestion discoverable plugins, waits for the asynchronous work to finish, and returns the plugin list. If the manager reports an error, the test stops.

**Call relations**: All the scenario tests use this helper as the final step after setting up fake files and configuration. It is the bridge between the test setup and the production discovery code under test.

*Call graph*: called by 14 (deduplicates_configured_marketplace_plugin, does_not_expand_local_plugins_by_installed_apps, does_not_expand_local_sales_apps, does_not_read_local_plugins_for_loaded_apps, does_not_reload_marketplace_per_plugin, expands_cached_remote_plugins_by_loaded_apps, ignores_missing_marketplace_plugin, includes_openai_curated_when_remote_enabled, normalizes_description, omits_installed_curated_plugins (+4 more)); 1 external calls (list_tool_suggest_discoverable_plugins).


##### `string_set`  (lines 733–735)

```
fn string_set(values: &[&str]) -> HashSet<String>
```

**Purpose**: Turns a small list of string slices into a set of owned strings. The tests use sets because discovery input needs quick “is this ID present?” checks.

**Data flow**: It receives borrowed string values, copies each one into a new `String`, and collects them into a `HashSet`. The returned set is then stored in the discovery input.

**Call relations**: `discovery_input` calls this helper for configured plugin IDs, disabled plugin IDs, and loaded app connector IDs. It is a small convenience function that keeps the discovery-input builder tidy.

*Call graph*: called by 1 (discovery_input).


##### `install_marketplace_plugin`  (lines 737–749)

```
async fn install_marketplace_plugin(codex_home: &Path, marketplace_root: &Path, plugin_name: &str)
```

**Purpose**: Installs a fake marketplace plugin into the temporary Codex home used by a test. This lets tests check how discovery behaves when some plugins are already installed.

**Data flow**: It receives the temporary Codex home path, the root of a fake marketplace, and a plugin name. It writes the expected curated plugin SHA marker, builds the path to the marketplace JSON file, creates a plugin manager for that home, and asks it to install the named plugin. If installation fails, the test fails.

**Call relations**: Several tests call this before discovery to create an installed-plugin state. It uses the real `PluginsManager::install_plugin` path, so the later discovery call sees the same kind of installation data it would see in normal use.

*Call graph*: calls 2 internal fn (new, try_from); called by 8 (does_not_expand_local_plugins_by_installed_apps, does_not_expand_local_sales_apps, does_not_reload_marketplace_per_plugin, ignores_missing_marketplace_plugin, normalizes_description, omits_installed_curated_plugins, omits_not_available_curated_plugins, returns_microsoft_fallback_plugins); 3 external calls (join, to_path_buf, write_curated_plugin_sha_with).


##### `write_plugin_app`  (lines 751–765)

```
fn write_plugin_app(root: &Path, plugin_name: &str, app_name: &str, app_id: &str)
```

**Purpose**: Writes a small `.app.json` metadata file for a fake plugin. The metadata links an app name to an app connector ID so tests can explore app-related discovery behavior.

**Data flow**: It receives a marketplace root, plugin name, app name, and app ID. It formats those values into a JSON file and writes that file under the plugin’s folder. The filesystem is changed; nothing is returned.

**Call relations**: Tests that need app connector metadata call this during setup. The discovery code may later see these files depending on the scenario, which lets the tests prove when local app metadata should or should not influence suggestions.

*Call graph*: called by 3 (does_not_expand_local_plugins_by_installed_apps, does_not_expand_local_sales_apps, does_not_read_local_plugins_for_loaded_apps); 3 external calls (join, write_file, format!).


### `core-plugins/src/app_mcp_routing_tests.rs`

`test` · `test run`

This is a test file. It checks a small but important routing policy: when the project knows about an “app” such as Linear or Notion, and also has an MCP server with the same name, which one should be used? MCP means Model Context Protocol, a way for the system to connect tools and external services to the model. The tests treat app routes and MCP servers like two signposts that can sometimes point to the same place. The routing policy decides which signpost should remain visible.

The file starts with simple helper functions that build fake app declarations, fake MCP server maps, and sorted name lists. Sorting matters because maps do not promise a stable order, and tests need predictable comparisons.

The tests then cover three main cases. First, app routing is only available for some authentication modes: ChatGPT and Agent Identity allow it, while API key or missing authentication do not. Second, if app routing is unavailable, the policy clears the app list but leaves MCP servers alone. Third, if app routing is available and the plugin is active, apps are kept and conflicting MCP servers with the same names are removed. A final test confirms that if the plugin is inactive, even matching MCP servers are not removed. Together, these tests protect against duplicate or incorrect routes being offered to the rest of the system.

#### Function details

##### `app`  (lines 6–12)

```
fn app(name: &str) -> AppDeclaration
```

**Purpose**: Creates a small fake app declaration for use in tests. This lets each test say “make an app named linear” without repeating all the struct fields every time.

**Data flow**: It takes an app name as text. It builds an AppDeclaration with that name, makes a connector id by prefixing the name with `connector_`, leaves the category empty, and returns the completed test app object.

**Call relations**: This helper supports the test setup in this file. While building the fake connector id, it uses string formatting and constructs an AppConnectorId so the test app looks like a real app declaration.

*Call graph*: 2 external calls (format!, new).


##### `mcp_servers`  (lines 14–19)

```
fn mcp_servers(mcp_servers: impl IntoIterator<Item = (&'static str, i32)>) -> HashMap<String, i32>
```

**Purpose**: Builds a fake collection of MCP servers for tests. Each server is represented by a name and a simple integer value, so the tests can focus on which server names remain after routing rules run.

**Data flow**: It receives pairs like `("linear", 1)`. It turns each borrowed text name into an owned string, keeps the integer value, collects everything into a HashMap, and returns that map.

**Call relations**: The routing tests call this when they need a starting set of MCP servers. It uses iteration to turn the compact test input into the map shape expected by the routing policy.

*Call graph*: called by 3 (app_mcp_routing_clears_apps_when_apps_route_is_unavailable, app_mcp_routing_preserves_apps_and_removes_conflicting_mcp_with_apps_route, app_mcp_routing_preserves_mcp_conflicts_when_plugin_is_inactive); 1 external calls (into_iter).


##### `sorted_app_names`  (lines 21–25)

```
fn sorted_app_names(apps: &[AppDeclaration]) -> Vec<String>
```

**Purpose**: Pulls app names out of a list and sorts them so tests can compare results reliably. This avoids false failures caused only by ordering.

**Data flow**: It reads a slice of app declarations. It copies each app’s name into a new list, sorts that list alphabetically, and returns the sorted names.

**Call relations**: The tests use this after the routing policy has changed the app list. It gives assertions a clean, predictable view of just the names that matter.

*Call graph*: 1 external calls (iter).


##### `sorted_mcp_server_names`  (lines 27–31)

```
fn sorted_mcp_server_names(mcp_servers: &HashMap<String, i32>) -> Vec<String>
```

**Purpose**: Pulls MCP server names out of a map and sorts them for stable test comparisons. This is needed because a HashMap does not keep names in a predictable order.

**Data flow**: It reads the keys from the MCP server map, copies them into a list, sorts that list alphabetically, and returns the sorted server names.

**Call relations**: The tests use this after routing decisions have been applied. It turns the remaining MCP server map into an easy-to-compare list of names.


##### `apps_route_available_tracks_auth_mode`  (lines 34–39)

```
fn apps_route_available_tracks_auth_mode()
```

**Purpose**: Checks that app routing is enabled only for the intended authentication modes. In plain terms, it verifies that the system only offers app-based routing when the user is signed in in a way that supports it.

**Data flow**: It tries `apps_route_available` with ChatGPT, Agent Identity, API key, and no authentication. It expects true for ChatGPT and Agent Identity, and false for API key or missing authentication.

**Call relations**: This test directly exercises the availability check before the broader routing policy is tested. Its assertions act as a guardrail: if authentication rules change unexpectedly, this test points to the cause.

*Call graph*: 1 external calls (assert!).


##### `app_mcp_routing_clears_apps_when_apps_route_is_unavailable`  (lines 42–58)

```
fn app_mcp_routing_clears_apps_when_apps_route_is_unavailable()
```

**Purpose**: Verifies that when app routing is not allowed, app declarations are removed from consideration. MCP servers are left untouched because they are still valid routes.

**Data flow**: It starts with one app named `linear` and two MCP servers named `linear` and `docs`. It runs the routing policy with API key authentication, where app routing is unavailable, and with the plugin marked active. Afterward, it expects the app list to be empty and both MCP servers to still be present.

**Call relations**: This test uses the MCP server helper to build its starting map, then calls the routing policy under an unavailable-authentication scenario. It finishes by checking both sides of the outcome: apps were cleared, but MCP server names were preserved.

*Call graph*: calls 1 internal fn (mcp_servers); 3 external calls (assert!, assert_eq!, vec!).


##### `app_mcp_routing_preserves_apps_and_removes_conflicting_mcp_with_apps_route`  (lines 61–80)

```
fn app_mcp_routing_preserves_apps_and_removes_conflicting_mcp_with_apps_route()
```

**Purpose**: Verifies the preferred path when app routing is available and the plugin is active. If an app and an MCP server have the same name, the app route wins and the duplicate MCP server is removed.

**Data flow**: It starts with apps named `linear` and `notion`, and MCP servers named `linear`, `docs`, and `notion`. It runs the routing policy with ChatGPT authentication and an active plugin. Afterward, it expects both apps to remain, but only the non-conflicting MCP server `docs` to remain.

**Call relations**: This test creates a deliberate name conflict, then asks the routing policy to resolve it in the normal app-routing path. It uses sorted name helpers in the assertions so the test checks the routing decision, not collection ordering.

*Call graph*: calls 1 internal fn (mcp_servers); 2 external calls (assert_eq!, vec!).


##### `app_mcp_routing_preserves_mcp_conflicts_when_plugin_is_inactive`  (lines 83–99)

```
fn app_mcp_routing_preserves_mcp_conflicts_when_plugin_is_inactive()
```

**Purpose**: Checks that the routing policy does not remove conflicting MCP servers when the plugin is inactive. Even if app routing would otherwise be available, the inactive plugin means the policy should not clean up those overlaps.

**Data flow**: It starts with one app named `linear` and MCP servers named `linear` and `docs`. It runs the routing policy with ChatGPT authentication but marks the plugin inactive. Afterward, it expects the app to remain and both MCP servers to remain as well.

**Call relations**: This test covers the plugin-active switch in the routing decision. It calls the same policy as the other routing tests but changes only the plugin activity flag, proving that conflict removal depends on that flag being true.

*Call graph*: calls 1 internal fn (mcp_servers); 2 external calls (assert_eq!, vec!).


### `core/src/plugins/test_support.rs`

`test` · `test setup`

Plugin tests need real-looking files because the plugin system reads from the filesystem: plugin manifests, skill files, MCP server settings, app connector settings, marketplace listings, and feature flags. This file is a small toolbox for building that test world. Think of it like a stage crew that sets up props before the actor enters: it creates folders, writes JSON or TOML files, and then lets the real plugin code run against those files as if they came from a user’s machine.

The helpers write a curated plugin under a test root, create an OpenAI curated marketplace that points at one or more local plugins, store a fake plugin bundle SHA in a temporary file, and turn on the plugins feature in the test config. There is also a helper for loading the project configuration from that temporary home directory.

The important behavior is that these helpers do not silently ignore failures. They use `unwrap` and `expect`, so a test stops immediately if the fake filesystem cannot be created or config cannot be loaded. That is appropriate for test setup: if the stage cannot be built, the test should fail clearly rather than continue with misleading results.

#### Function details

##### `write_file`  (lines 10–13)

```
fn write_file(path: &Path, contents: &str)
```

**Purpose**: Writes text to a file during test setup, creating the parent folder first if needed. Tests use it so they can place config and plugin files anywhere in a temporary directory without separately making each folder.

**Data flow**: It takes a file path and some text. It looks up the file’s parent directory, creates that directory tree, then writes the text into the file. The result is a real file on disk, and the test stops with an error if the directory or file cannot be created.

**Call relations**: This is the low-level helper that the other setup helpers rely on. The plugin, marketplace, SHA, and feature-config writers all call it when they need to put one concrete file in place.

*Call graph*: called by 4 (write_curated_plugin, write_curated_plugin_sha_with, write_openai_curated_marketplace, write_plugins_feature_config); 3 external calls (parent, create_dir_all, write).


##### `write_curated_plugin`  (lines 15–51)

```
fn write_curated_plugin(root: &Path, plugin_name: &str)
```

**Purpose**: Creates a fake curated plugin folder with the files the plugin system expects to find. It is used when a test needs something that looks like an installable or readable plugin.

**Data flow**: It receives a root test directory and a plugin name. From those, it builds a plugin folder path, then writes a plugin manifest, one sample skill file, an MCP server JSON file, and an app connector JSON file. After it runs, the test root contains a complete sample plugin layout.

**Call relations**: This helper builds one plugin at a time. The marketplace helper calls it after writing the marketplace list, so every plugin named in that marketplace also exists on disk.

*Call graph*: calls 1 internal fn (write_file); called by 1 (write_openai_curated_marketplace); 2 external calls (join, format!).


##### `write_openai_curated_marketplace`  (lines 53–83)

```
fn write_openai_curated_marketplace(root: &Path, plugin_names: &[&str])
```

**Purpose**: Creates a fake OpenAI curated marketplace file that lists local test plugins. This lets tests exercise marketplace-based plugin discovery without contacting a real marketplace service.

**Data flow**: It takes a root test directory and a list of plugin names. It turns those names into JSON entries that point to local plugin folders, writes the marketplace JSON file under `.agents/plugins`, and then creates each named plugin folder and its contents. The result is a self-contained local marketplace plus the plugins it advertises.

**Call relations**: This is a higher-level setup helper. It uses `write_file` to create the marketplace listing and `write_curated_plugin` to make sure each listed plugin is actually present.

*Call graph*: calls 2 internal fn (write_curated_plugin, write_file); 2 external calls (join, format!).


##### `write_curated_plugin_sha`  (lines 85–87)

```
fn write_curated_plugin_sha(codex_home: &Path)
```

**Purpose**: Writes the standard fake curated-plugin SHA used by tests. A SHA is a fingerprint-like string often used to identify an exact downloaded or installed version.

**Data flow**: It takes the test Codex home directory and passes it, along with the file’s built-in test SHA value, to the more flexible SHA-writing helper. The visible result is a `.tmp/plugins.sha` file containing the default test fingerprint.

**Call relations**: This is a convenience wrapper for tests that do not care which SHA is used. The verified plugin install test calls it, and it delegates the actual file writing to `write_curated_plugin_sha_with`.

*Call graph*: calls 1 internal fn (write_curated_plugin_sha_with); called by 1 (verified_plugin_install_completed_requires_installed_plugin).


##### `write_curated_plugin_sha_with`  (lines 89–91)

```
fn write_curated_plugin_sha_with(codex_home: &Path, sha: &str)
```

**Purpose**: Writes a chosen plugin SHA value into the test home directory. Tests use this when they need to simulate a specific installed plugin fingerprint.

**Data flow**: It receives a Codex home path and a SHA string. It formats the SHA with a trailing newline and writes it to `.tmp/plugins.sha` under that home directory. Afterward, code that checks the installed plugin SHA can read that test value from disk.

**Call relations**: The default SHA helper calls this with the shared test SHA. Internally it relies on `write_file`, so the `.tmp` folder is created automatically if it does not exist.

*Call graph*: calls 1 internal fn (write_file); called by 1 (write_curated_plugin_sha); 2 external calls (join, format!).


##### `write_plugins_feature_config`  (lines 93–100)

```
fn write_plugins_feature_config(codex_home: &Path)
```

**Purpose**: Creates a test config file that turns the plugins feature on. This is needed for tests where plugin behavior should be enabled through the same configuration path used by the real application.

**Data flow**: It takes a Codex home directory, writes the project’s config TOML file there, and fills it with a `[features]` section where `plugins = true`. After that, loading config from this home directory will see plugins as enabled.

**Call relations**: Plugin-install verification tests call this before loading or running plugin logic. It uses `write_file` to create the config file in the right location.

*Call graph*: calls 1 internal fn (write_file); called by 1 (verified_plugin_install_completed_requires_installed_plugin); 1 external calls (join).


##### `load_plugins_config`  (lines 102–109)

```
async fn load_plugins_config(codex_home: &Path) -> crate::config::Config
```

**Purpose**: Loads a Codex configuration from a test home directory. Tests use it after writing setup files so they can get a real `Config` object built from that temporary environment.

**Data flow**: It receives a Codex home path, creates a `ConfigBuilder`, points both the Codex home and fallback current working directory at that path, then asynchronously builds the config. It returns the loaded config, or fails the test if the config cannot be loaded.

**Call relations**: This helper is used after test files have been written. It hands the prepared directory to the normal configuration builder so plugin tests exercise the real config-loading path rather than a mock shortcut.

*Call graph*: 2 external calls (to_path_buf, default).


### `core/src/plugins/discoverable_tests.rs`

`test` · `test run`

This is a test file for the plugin suggestion system. A “discoverable” plugin is a plugin Codex can recommend to the user even if it is not already installed or loaded. The tests create temporary Codex home folders, write small fake configuration files, and sometimes create fake plugin marketplaces. This lets the tests check the behavior without touching a real user setup.

The main question this file asks is: when Codex lists suggested plugins, which ones should appear and which ones should be hidden? For example, if the whole plugins feature is turned off, nothing should be suggested. If a user has disabled a specific suggestion, that plugin should disappear. If the config explicitly asks for a curated plugin to be discoverable, the result should include the correct name, description, skills, MCP servers, and app connector IDs. An MCP server is an external tool server that a plugin can expose to Codex.

One larger test also checks remote plugins. It uses a fake HTTP server, like a pretend app store, to return a remote plugin catalog. It verifies that only valid, available remote plugins become discoverable, and only after the remote installed-plugin marketplace cache has been built. This protects users from seeing stale, unavailable, disabled, or explicitly blocked plugin suggestions.

#### Function details

##### `list_discoverable_plugins`  (lines 14–20)

```
async fn list_discoverable_plugins(
    config: &crate::config::Config,
    loaded_plugin_app_connector_ids: &[String],
) -> anyhow::Result<Vec<DiscoverablePluginInfo>>
```

**Purpose**: This small helper asks the plugin suggestion system for discoverable plugins when no login information is needed. The tests use it to keep simple cases short and readable.

**Data flow**: It receives a Codex configuration and a list of plugin app connector IDs that are already loaded. It passes those along with no authentication information, then returns the list of discoverable plugin descriptions or an error.

**Call relations**: The simpler tests call this helper when they only care about local config and curated plugins. It immediately hands the real work to list_discoverable_plugins_with_auth, using no auth because those cases do not need a remote account.

*Call graph*: calls 1 internal fn (list_discoverable_plugins_with_auth); called by 3 (list_tool_suggest_discoverable_plugins_includes_configured_plugin_ids, list_tool_suggest_discoverable_plugins_omits_disabled_tool_suggestions, list_tool_suggest_discoverable_plugins_returns_empty_when_plugins_feature_disabled).


##### `list_discoverable_plugins_with_auth`  (lines 22–39)

```
async fn list_discoverable_plugins_with_auth(
    config: &crate::config::Config,
    auth: Option<&codex_login::CodexAuth>,
    loaded_plugin_app_connector_ids: &[String],
) -> anyhow::Result<Vec<Dis
```

**Purpose**: This helper prepares a PluginsManager before asking for discoverable plugin suggestions. A PluginsManager is the object that knows where plugin data lives and how plugin marketplaces should be read.

**Data flow**: It receives the config, optional login/authentication information, and already-loaded app connector IDs. It builds a PluginsManager using the Codex home folder, the Codex product name, and the auth mode if one exists. It then returns whatever the next helper finds.

**Call relations**: list_discoverable_plugins calls this when tests do not provide auth directly. After creating the manager, it passes control to list_discoverable_plugins_with_manager_and_auth so the actual suggestion call is made in one shared place.

*Call graph*: calls 2 internal fn (new_with_options, list_discoverable_plugins_with_manager_and_auth); called by 1 (list_discoverable_plugins).


##### `list_discoverable_plugins_with_manager_and_auth`  (lines 41–54)

```
async fn list_discoverable_plugins_with_manager_and_auth(
    config: &crate::config::Config,
    plugins_manager: &PluginsManager,
    auth: Option<&codex_login::CodexAuth>,
    loaded_plugin_app_con
```

**Purpose**: This helper is the direct bridge from the tests into the real plugin suggestion function. It exists so tests can either use a freshly created manager or pass in a manager whose caches have already been prepared.

**Data flow**: It receives the config, a PluginsManager, optional auth, and loaded app connector IDs. It forwards them to the production function that lists tool-suggest discoverable plugins, then returns the resulting plugin list or error.

**Call relations**: The auth helper uses this after creating a manager. The remote-plugin test also calls it directly because that test needs to reuse a specific PluginsManager after filling its remote plugin caches.

*Call graph*: called by 2 (list_discoverable_plugins_with_auth, list_tool_suggest_discoverable_plugins_includes_cached_remote_global_plugins); 1 external calls (list_tool_suggest_discoverable_plugins).


##### `list_tool_suggest_discoverable_plugins_includes_cached_remote_global_plugins`  (lines 57–332)

```
async fn list_tool_suggest_discoverable_plugins_includes_cached_remote_global_plugins()
```

**Purpose**: This test proves that a valid remote global plugin can appear as a discoverable suggestion, but only after the remote plugin marketplace cache is properly built. It also proves that a user-disabled remote suggestion is hidden.

**Data flow**: It creates a temporary Codex home, writes config that enables plugins and remote plugins, and starts a fake HTTP server that returns several remote plugin records. Some records are intentionally unusable, such as unavailable or admin-disabled plugins. The test fetches and caches the global remote catalog, asks for discoverable plugins, then confirms the remote GitHub plugin is not shown too early. It then mocks installed-plugin responses, builds the remote installed-plugin marketplace cache, asks again, and confirms only the expected GitHub remote plugin appears with the right fields. Finally it rewrites config to disable that suggestion and confirms it disappears.

**Call relations**: This test drives the most complete flow in the file. It creates auth, uses remote fetching and cache-building functions, then calls list_discoverable_plugins_with_manager_and_auth to enter the real suggestion logic at each checkpoint.

*Call graph*: calls 4 internal fn (new, fetch_and_cache_global_remote_plugin_catalog, list_discoverable_plugins_with_manager_and_auth, create_dummy_chatgpt_auth_for_testing); 10 external calls (given, start, new, assert!, assert_eq!, load_plugins_config, write_file, format!, json!, tempdir).


##### `list_tool_suggest_discoverable_plugins_returns_empty_when_plugins_feature_disabled`  (lines 335–350)

```
async fn list_tool_suggest_discoverable_plugins_returns_empty_when_plugins_feature_disabled()
```

**Purpose**: This test checks the safety switch: if the plugins feature is disabled, Codex should not suggest plugins at all. This prevents plugin suggestions from appearing when the user or environment has turned the feature off.

**Data flow**: It creates a temporary Codex home, writes a fake curated marketplace containing Slack, and writes config with plugins set to false. It loads that config, asks for discoverable plugins, and expects an empty list.

**Call relations**: This is one of the simple local tests. It prepares files with the test-support helpers, then calls list_discoverable_plugins, which routes through the helper chain into the real suggestion function.

*Call graph*: calls 2 internal fn (curated_plugins_repo_path, list_discoverable_plugins); 5 external calls (assert_eq!, load_plugins_config, write_file, write_openai_curated_marketplace, tempdir).


##### `list_tool_suggest_discoverable_plugins_omits_disabled_tool_suggestions`  (lines 353–373)

```
async fn list_tool_suggest_discoverable_plugins_omits_disabled_tool_suggestions()
```

**Purpose**: This test confirms that a plugin explicitly listed as disabled in the tool suggestion settings is not shown. It protects the user’s preference to hide a suggested tool.

**Data flow**: It creates a temporary Codex home, writes a curated marketplace with Slack, and writes config that enables plugins but disables the Slack plugin suggestion. It loads the config, asks for discoverable plugins, and expects no results.

**Call relations**: Like the other local tests, it builds a small fake filesystem setup, then calls list_discoverable_plugins. That helper path reaches the real discoverable-plugin listing code and returns the filtered result.

*Call graph*: calls 2 internal fn (curated_plugins_repo_path, list_discoverable_plugins); 5 external calls (assert_eq!, load_plugins_config, write_file, write_openai_curated_marketplace, tempdir).


##### `list_tool_suggest_discoverable_plugins_includes_configured_plugin_ids`  (lines 376–407)

```
async fn list_tool_suggest_discoverable_plugins_includes_configured_plugin_ids()
```

**Purpose**: This test checks that a plugin named in the user’s discoverable-tool configuration is returned with the expected user-facing details. It verifies not just that the plugin appears, but that its important metadata is preserved.

**Data flow**: It creates a temporary Codex home, writes a curated marketplace containing a sample plugin, and writes config that marks that sample plugin as discoverable. It loads the config, asks for discoverable plugins, and compares the result to the expected ID, name, description, skill flag, MCP server name, and app connector ID.

**Call relations**: This test uses the same simple helper path as the other local tests. After the fake marketplace and config are ready, it calls list_discoverable_plugins, which eventually calls the production suggestion-listing function.

*Call graph*: calls 2 internal fn (curated_plugins_repo_path, list_discoverable_plugins); 5 external calls (assert_eq!, load_plugins_config, write_file, write_openai_curated_marketplace, tempdir).


### `core/src/plugins/mentions_tests.rs`

`test` · `test run`

Users can point the system at outside tools in two main ways: as structured mention objects, or as links written inside normal text, such as a Markdown-style link. This test file is a safety net for that behavior. Without these tests, a change in mention parsing could quietly cause the system to miss a plugin the user asked for, activate the wrong kind of tool, or count one tool twice.

The file builds small fake user inputs and fake plugin summaries, then asks the real mention-collection functions what they find. It checks two related jobs. First, app mentions should be collected only when their path starts with `app://`, and duplicates should collapse into one app id. Second, plugin mentions should be collected only when their path starts with `plugin://` and when the text link looks like a plugin mention using `@`, not an app-style `$` label.

A useful way to think about these tests is a mail sorter. The input contains envelopes with different labels: apps, plugins, skills, files, and MCP resources. These tests make sure each sorter only takes the envelopes meant for it, leaves the rest alone, and does not put the same envelope in the pile twice.

#### Function details

##### `text_input`  (lines 10–15)

```
fn text_input(text: &str) -> UserInput
```

**Purpose**: This small helper creates a plain text user input from a string. Tests use it so they do not have to repeat the full `UserInput::Text` structure every time they need a text message.

**Data flow**: It takes a text string, copies it into an owned string, adds an empty list of text elements, and returns a `UserInput::Text` value. It does not change anything outside itself.

**Call relations**: The linked-text plugin mention tests call this helper when they need input that looks like a normal written message containing a link. It hands that prepared input to `collect_explicit_plugin_mentions`, which then does the real parsing being tested.

*Call graph*: called by 4 (collect_explicit_plugin_mentions_dedupes_structured_and_linked_mentions, collect_explicit_plugin_mentions_from_linked_text_mentions, collect_explicit_plugin_mentions_ignores_dollar_linked_plugin_mentions, collect_explicit_plugin_mentions_ignores_non_plugin_paths); 1 external calls (new).


##### `plugin`  (lines 17–26)

```
fn plugin(config_name: &str, display_name: &str) -> PluginCapabilitySummary
```

**Purpose**: This helper creates a minimal fake plugin description for tests. It lets each test name the plugin by its internal config name and its display name without filling in every field by hand.

**Data flow**: It takes a plugin config name and display name, turns both into owned strings, fills the remaining plugin fields with simple default test values, and returns a `PluginCapabilitySummary`.

**Call relations**: The plugin mention tests use this helper to build the list of available plugins and the expected result. Those plugin summaries are passed into `collect_explicit_plugin_mentions`, so the test can check whether the correct plugin was selected.

*Call graph*: 1 external calls (new).


##### `collect_explicit_app_ids_from_linked_text_mentions`  (lines 29–35)

```
fn collect_explicit_app_ids_from_linked_text_mentions()
```

**Purpose**: This test proves that an app mention written as a link inside plain text is recognized. In this case, `app://calendar` should produce the app id `calendar`.

**Data flow**: It starts with one text input containing a Markdown-style link to an app. It sends that input to `collect_explicit_app_ids`, then compares the returned set with a set containing only `calendar`.

**Call relations**: During the test run, this function calls the real app-id collection function and uses an assertion to verify the answer. It focuses on the linked-text form of an app mention.

*Call graph*: 3 external calls (assert_eq!, collect_explicit_app_ids, vec!).


##### `collect_explicit_app_ids_dedupes_structured_and_linked_mentions`  (lines 38–50)

```
fn collect_explicit_app_ids_dedupes_structured_and_linked_mentions()
```

**Purpose**: This test makes sure the same app is not counted twice when it appears in both text-link form and structured mention form. The user may mention the same thing in more than one representation, but the system should treat it as one app request.

**Data flow**: It builds two inputs that both point to `app://calendar`: one text link and one structured mention. It passes them to `collect_explicit_app_ids` and expects a set with just one `calendar` entry.

**Call relations**: This test calls the real app-id collector after creating mixed input forms. The final assertion checks the deduplication behavior, meaning duplicate mentions collapse into a single result.

*Call graph*: 3 external calls (assert_eq!, collect_explicit_app_ids, vec!).


##### `collect_explicit_app_ids_ignores_non_app_paths`  (lines 53–75)

```
fn collect_explicit_app_ids_ignores_non_app_paths()
```

**Purpose**: This test checks that the app collector does not mistake other kinds of references for apps. Links to MCP resources, skills, or ordinary files should not become app ids.

**Data flow**: It creates text and structured mentions for non-app paths such as `mcp://`, `skill://`, and a file path. It passes all of them to `collect_explicit_app_ids` and expects an empty set back.

**Call relations**: The test exercises the filtering part of the app-id collector. It confirms that only `app://` paths are accepted, while other mention types are ignored.

*Call graph*: 3 external calls (assert_eq!, collect_explicit_app_ids, vec!).


##### `collect_explicit_plugin_mentions_from_structured_paths`  (lines 78–93)

```
fn collect_explicit_plugin_mentions_from_structured_paths()
```

**Purpose**: This test proves that a structured plugin mention can select the matching plugin from the available plugin list. A structured mention is already separated from plain text and includes a path like `plugin://sample@test`.

**Data flow**: It creates two fake plugins, then provides one structured mention pointing to `sample@test`. It passes both the mention and the plugin list to `collect_explicit_plugin_mentions`, and expects only the matching sample plugin back.

**Call relations**: This test calls the real plugin mention collector with structured input. The assertion verifies that the collector connects the mention path to the correct plugin summary.

*Call graph*: 3 external calls (assert_eq!, collect_explicit_plugin_mentions, vec!).


##### `collect_explicit_plugin_mentions_from_linked_text_mentions`  (lines 96–108)

```
fn collect_explicit_plugin_mentions_from_linked_text_mentions()
```

**Purpose**: This test checks that a plugin mention written as a link in normal text is recognized when it uses the plugin-style `@` label. For example, `[@sample](plugin://sample@test)` should select the sample plugin.

**Data flow**: It builds a list of available fake plugins and a text input containing a plugin link. It sends both to `collect_explicit_plugin_mentions`, then expects the matching plugin summary as the only result.

**Call relations**: This test uses `text_input` to create the plain text message, then calls the real plugin mention collector. The assertion confirms that linked text can trigger plugin selection.

*Call graph*: calls 1 internal fn (text_input); 3 external calls (assert_eq!, collect_explicit_plugin_mentions, vec!).


##### `collect_explicit_plugin_mentions_dedupes_structured_and_linked_mentions`  (lines 111–129)

```
fn collect_explicit_plugin_mentions_dedupes_structured_and_linked_mentions()
```

**Purpose**: This test makes sure one plugin is returned only once even if the user input mentions it in two different ways. It protects against duplicate plugin activation caused by repeated references to the same plugin.

**Data flow**: It creates a text link and a structured mention that both point to `plugin://sample@test`. It passes those inputs, along with the available plugin list, to `collect_explicit_plugin_mentions` and expects a single sample plugin in the result.

**Call relations**: The test uses `text_input` for the linked-text case and also includes a structured mention. It then calls the plugin mention collector and checks that the collector merges the duplicate references.

*Call graph*: calls 1 internal fn (text_input); 3 external calls (assert_eq!, collect_explicit_plugin_mentions, vec!).


##### `collect_explicit_plugin_mentions_ignores_non_plugin_paths`  (lines 132–143)

```
fn collect_explicit_plugin_mentions_ignores_non_plugin_paths()
```

**Purpose**: This test checks that the plugin collector ignores links that point to apps, skills, or files. A plugin collector should only react to plugin paths, not to every link-like thing in the user message.

**Data flow**: It creates one available plugin, then builds a text input containing non-plugin links such as `app://calendar`, `skill://team/skill`, and a file path. It passes that to `collect_explicit_plugin_mentions` and expects an empty plugin list.

**Call relations**: This test uses `text_input` to prepare the message and then calls the real plugin mention collector. The assertion verifies the collector’s filtering rule: non-plugin paths are left alone.

*Call graph*: calls 1 internal fn (text_input); 3 external calls (assert_eq!, collect_explicit_plugin_mentions, vec!).


##### `collect_explicit_plugin_mentions_ignores_dollar_linked_plugin_mentions`  (lines 146–155)

```
fn collect_explicit_plugin_mentions_ignores_dollar_linked_plugin_mentions()
```

**Purpose**: This test captures a subtle rule: even if a link points to `plugin://...`, it should not count as an explicit plugin mention when the visible label uses `$` instead of `@`. That prevents app-style labels from accidentally activating plugins.

**Data flow**: It creates one available plugin and a text input containing `[$sample](plugin://sample@test)`. It passes them to `collect_explicit_plugin_mentions` and expects no plugins to be returned.

**Call relations**: The test uses `text_input` to build the linked message, then calls the plugin mention collector. The assertion checks that the collector pays attention not only to the link destination, but also to the mention style shown in the text.

*Call graph*: calls 1 internal fn (text_input); 3 external calls (assert_eq!, collect_explicit_plugin_mentions, vec!).


### `core/src/plugins/render_tests.rs`

`test` · `test run`

This is a small test file for the code that builds the “Plugins” section shown to the model or user. That section explains how plugins should be understood: plugins are bundles of abilities, but they are not called directly; instead, their skills, tools, or apps are used.

The tests cover two important promises. First, if there are no plugins, the renderer should return nothing. This avoids showing an empty or misleading plugin section. Second, if at least one plugin exists, the renderer should include the general plugin usage guidance, but should not list individual plugins inside this section. In plain terms, the section is like a rule card for how to think about plugins, not a catalog of every plugin.

The file uses `assert_eq!`, a test helper that compares the actual result with the expected result and clearly reports any difference. It also uses a default `PluginCapabilitySummary` value, then fills in only the fields needed for the test. If the wording or presence of this plugin guidance changes unexpectedly, these tests fail and alert the developers.

#### Function details

##### `render_plugins_section_returns_none_for_empty_plugins`  (lines 5–7)

```
fn render_plugins_section_returns_none_for_empty_plugins()
```

**Purpose**: This test makes sure no plugin section is produced when the plugin list is empty. That matters because showing plugin instructions when no plugins exist would add noise and could confuse later behavior.

**Data flow**: It starts with an empty list of plugins. It passes that list to the plugin-section renderer, then compares the result with `None`, meaning “no section was produced.” Nothing is changed outside the test.

**Call relations**: During the test run, this function exercises the renderer with the simplest possible input: no plugins. It then hands the actual and expected values to `assert_eq!`, which decides whether the behavior is correct.

*Call graph*: 1 external calls (assert_eq!).


##### `render_plugins_section_keeps_plugin_usage_guidance_without_listing_plugins`  (lines 10–23)

```
fn render_plugins_section_keeps_plugin_usage_guidance_without_listing_plugins()
```

**Purpose**: This test checks that having a plugin causes the general plugin instructions to appear, while keeping the section focused on usage guidance rather than a plugin-by-plugin list. It protects the exact wording of that guidance.

**Data flow**: It builds one sample plugin summary, using a default summary as a base and filling in a name, description, and the fact that it has skills. It sends that plugin list into the renderer, expects a rendered text block back, and compares that block with the exact expected plugin-instructions text.

**Call relations**: During the test run, this function creates a realistic plugin summary and asks the renderer for the plugin section. It uses `default` to avoid filling in unrelated fields, then uses `assert_eq!` to verify that the rendered text matches the approved guidance exactly.

*Call graph*: 2 external calls (assert_eq!, default).


### `core/src/connectors_tests.rs`

`test` · `test run`

This is a test file. It does not implement the connector system itself; instead, it builds small fake configurations, fake tools, and temporary Codex home folders to check that the real connector code behaves correctly. The main idea is: when Codex learns about tools from app connectors, it must show the right apps to the user, remember them in a cache, respect configuration rules, and suggest the right discoverable tools.

The file uses helper functions to make realistic test objects without repeating long setup code. For example, it can create a fake app record, a fake MCP tool, or a fake Codex app tool. MCP means “Model Context Protocol,” a way for external tools and services to describe callable actions to Codex.

The tests cover several important promises. Connector display names and plugin names should be preserved. Connector descriptions should come through from tool metadata. The cache of accessible connectors should be refreshed safely. App approval settings should follow the expected priority: app-specific settings first, then app defaults, then global settings, unless enterprise requirements restrict the choice. Tool suggestions should include configured connector IDs, exclude disabled suggestions, fall back to connector IDs when no directory cache exists, and include connectors from already loaded plugin apps. Without these tests, app integration could look correct in one path but fail in common configuration or caching cases.

#### Function details

##### `app`  (lines 26–42)

```
fn app(id: &str) -> AppInfo
```

**Purpose**: Creates a simple fake app connector record for tests. It fills in the required fields with predictable defaults so each test only has to care about the app ID.

**Data flow**: It receives an app ID as text. It copies that ID into both the app's ID and name fields, leaves optional details like logos and descriptions empty, marks the app as enabled but not accessible, and returns the completed AppInfo test object.

**Call relations**: This helper is used by with_app_enabled_state_preserves_unrelated_disabled_connector when that test needs two connector records with known starting values. It calls standard string construction to turn borrowed text into owned strings.

*Call graph*: called by 1 (with_app_enabled_state_preserves_unrelated_disabled_connector); 1 external calls (new).


##### `plugin_names`  (lines 44–46)

```
fn plugin_names(names: &[&str]) -> Vec<String>
```

**Purpose**: Converts a short list of plugin display names into the owned string list expected by connector data structures. It keeps test setup compact and easy to read.

**Data flow**: It receives a slice of text references such as plugin names. It copies each one into a standalone String and returns them as a vector.

**Call relations**: codex_app_tool calls this helper when building fake tool metadata with plugin display names. This keeps the tool-building helper focused on the larger ToolInfo shape instead of string conversion.

*Call graph*: called by 1 (codex_app_tool).


##### `test_tool_definition`  (lines 48–50)

```
fn test_tool_definition(tool_name: &str) -> Tool
```

**Purpose**: Builds a minimal fake MCP tool definition for tests. It supplies a tool name and an empty input description, which is enough for these connector tests.

**Data flow**: It receives a tool name. It creates an empty JSON object for the tool schema, wraps it in shared ownership, and returns a Tool object with the given name and no extra description.

**Call relations**: codex_app_tool calls this when it needs a realistic ToolInfo object. The helper delegates to external Tool and JSON constructors so the fake tool has the same basic shape as a real one.

*Call graph*: called by 1 (codex_app_tool); 3 external calls (new, default, new_with_raw).


##### `codex_app_tool`  (lines 52–75)

```
fn codex_app_tool(
    tool_name: &str,
    connector_id: &str,
    connector_name: Option<&str>,
    plugin_display_names: &[&str],
) -> ToolInfo
```

**Purpose**: Creates a fake Codex Apps MCP tool tied to a connector. Tests use it to simulate the tools Codex would normally discover from installed app connectors.

**Data flow**: It receives a tool name, connector ID, optional connector name, and plugin display names. If a connector name is present, it sanitizes that name and builds a namespaced callable path; otherwise it uses the general Codex Apps server name. It then returns a ToolInfo record containing the server name, callable names, connector identity, optional connector display name, plugin names, and a minimal tool definition.

**Call relations**: Several tests use this helper to make realistic MCP tool data. Inside, it calls plugin_names to prepare display names and test_tool_definition to create the embedded tool object.

*Call graph*: calls 2 internal fn (plugin_names, test_tool_definition).


##### `with_accessible_connectors_cache_cleared`  (lines 77–90)

```
fn with_accessible_connectors_cache_cleared(f: impl FnOnce() -> R) -> R
```

**Purpose**: Runs a test section while temporarily clearing the shared accessible-connectors cache. This prevents one test's cached data from leaking into another test, like wiping a whiteboard before using it and then restoring what was there.

**Data flow**: It receives a closure, which is a block of code to run. It locks the global cache, saves the previous cache value, clears it, runs the closure, then locks the cache again and restores the saved value. It returns whatever the closure returned.

**Call relations**: refresh_accessible_connectors_cache_from_mcp_tools_writes_latest_installed_apps uses this helper around its cache refresh check. The helper interacts with the shared cache directly so the test can make a clean assertion about the newly written cache contents.

*Call graph*: called by 1 (refresh_accessible_connectors_cache_from_mcp_tools_writes_latest_installed_apps).


##### `accessible_connectors_from_mcp_tools_carries_plugin_display_names`  (lines 93–141)

```
fn accessible_connectors_from_mcp_tools_carries_plugin_display_names()
```

**Purpose**: Checks that when multiple MCP tools belong to the same connector, Codex keeps the connector's plugin display names. This matters because the user-visible connector entry should still show which plugin sources are associated with it.

**Data flow**: The test builds two fake calendar tools with connector metadata and one unrelated non-connector tool. It passes them into the connector-conversion logic, then compares the result with the one expected calendar AppInfo. The expected output includes the connector name, generated install URL, accessibility flag, enabled state, and deduplicated plugin display names.

**Call relations**: The Rust test runner calls this test. It uses local fake data and assertion helpers, and it exercises the connector-building path that groups MCP tools into accessible app connector records.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `refresh_accessible_connectors_cache_from_mcp_tools_writes_latest_installed_apps`  (lines 144–208)

```
async fn refresh_accessible_connectors_cache_from_mcp_tools_writes_latest_installed_apps()
```

**Purpose**: Checks that refreshing the accessible-connectors cache writes the latest connector list derived from MCP tools. This protects the cached installed-app view from becoming stale or missing newly discovered connector information.

**Data flow**: The test creates a temporary Codex home folder, builds a config with the Apps feature enabled, computes the cache key, and creates fake connector tools. Inside a cleared-cache section, it refreshes the cache from those tools, reads the cached value back, and compares it with the expected list of accessible connector apps.

**Call relations**: The async test runner calls this test. It relies on with_accessible_connectors_cache_cleared to isolate the shared cache, then checks the refresh and readback path as one end-to-end cache story.

*Call graph*: calls 1 internal fn (with_accessible_connectors_cache_cleared); 4 external calls (assert_eq!, default, tempdir, vec!).


##### `accessible_connectors_from_mcp_tools_preserves_description`  (lines 211–247)

```
fn accessible_connectors_from_mcp_tools_preserves_description()
```

**Purpose**: Checks that connector descriptions from MCP namespace metadata are preserved in the app record. This matters because that description is what helps users understand what a connector can do.

**Data flow**: The test builds one fake calendar ToolInfo with a namespace description, connector ID, and connector name. It converts the tool list into accessible connectors and expects one AppInfo whose description is exactly the namespace description from the tool metadata.

**Call relations**: The test runner invokes this test. It constructs the ToolInfo directly rather than through the helper because the important detail here is the namespace description field.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `app_approvals_reviewer_uses_app_then_default_then_global`  (lines 250–312)

```
async fn app_approvals_reviewer_uses_app_then_default_then_global()
```

**Purpose**: Verifies the priority order for approval reviewer settings. For Codex Apps, an app-specific setting should win, then the app default, and only then the global setting; non-app MCP servers should use the global setting.

**Data flow**: For two combinations of reviewer values, the test writes a temporary config file containing a global reviewer, a default app reviewer, and a calendar-specific reviewer. It loads the config and asks for the reviewer for calendar, for another app, for no connector ID, and for a custom server. Each answer is compared with the expected priority result.

**Call relations**: The async test runner calls this test. It uses temporary files and config loading to exercise the real configuration path rather than manually constructing every setting in memory.

*Call graph*: 5 external calls (assert_eq!, default, format!, write, tempdir).


##### `default_app_approvals_reviewer_respects_global_reviewer_requirements`  (lines 315–342)

```
async fn default_app_approvals_reviewer_respects_global_reviewer_requirements()
```

**Purpose**: Checks that enterprise-wide reviewer restrictions override an app default that is not allowed. This prevents local app settings from bypassing organization policy.

**Data flow**: The test writes a config where the global reviewer is auto review and the default app reviewer is user. It also loads a cloud policy saying only auto review is allowed. After building the config, it asks for the reviewer for a Codex Apps connector and expects auto review, because the user reviewer is forbidden by the requirement.

**Call relations**: The async test runner invokes this test. It calls the cloud-config fixture helper to simulate an enterprise requirement, then verifies that the approval-reviewer lookup respects that requirement.

*Call graph*: calls 1 internal fn (loader_with_enterprise_requirement); 4 external calls (assert_eq!, default, write, tempdir).


##### `app_approvals_reviewer_respects_global_reviewer_requirements`  (lines 345–372)

```
async fn app_approvals_reviewer_respects_global_reviewer_requirements()
```

**Purpose**: Checks that enterprise-wide reviewer restrictions also override an app-specific reviewer that is not allowed. This closes a more specific loophole than the default-app case.

**Data flow**: The test writes a config where the global reviewer is auto review but the calendar app asks for user review. It loads a cloud policy allowing only auto review, builds the config, asks for calendar's reviewer, and expects auto review.

**Call relations**: The async test runner calls this test. Like the related default-app test, it uses the enterprise requirement fixture to make sure the real config enforcement path is being tested.

*Call graph*: calls 1 internal fn (loader_with_enterprise_requirement); 4 external calls (assert_eq!, default, write, tempdir).


##### `with_app_enabled_state_preserves_unrelated_disabled_connector`  (lines 375–410)

```
async fn with_app_enabled_state_preserves_unrelated_disabled_connector()
```

**Purpose**: Checks that applying enabled or disabled state from configuration does not accidentally re-enable an unrelated connector. This matters because disabling one app should not be undone when another app is processed.

**Data flow**: The test builds a temporary config and injects requirements saying the drive connector is disabled. It creates a Slack app that is already disabled and a Drive app. After applying enabled-state logic, it expects Slack to remain disabled and Drive to be disabled according to requirements.

**Call relations**: The async test runner invokes this test. It uses the app helper to create simple connector records, builds a requirement stack with external constructors, then asserts that the enabled-state transformation produces the intended final app list.

*Call graph*: calls 2 internal fn (new, app); 7 external calls (from, default, new, default, assert_eq!, default, tempdir).


##### `tool_suggest_connector_ids_include_configured_tool_suggest_discoverables`  (lines 413–437)

```
async fn tool_suggest_connector_ids_include_configured_tool_suggest_discoverables()
```

**Purpose**: Checks that configured connector-type tool suggestions are included. It also checks that non-connector suggestions and blank connector IDs are ignored.

**Data flow**: The test writes a temporary config with tool suggestion discoverables: one valid connector, one plugin, and one whitespace-only connector ID. After loading the config, it asks for suggested connector IDs and expects only the valid connector ID.

**Call relations**: The async test runner calls this test. It exercises the configuration-reading path for tool suggestions and uses an assertion to make sure only usable connector IDs come out.

*Call graph*: 4 external calls (assert_eq!, default, write, tempdir).


##### `tool_suggest_connector_ids_exclude_disabled_tool_suggestions`  (lines 440–466)

```
async fn tool_suggest_connector_ids_exclude_disabled_tool_suggestions()
```

**Purpose**: Checks that a connector listed as disabled is removed from tool suggestions even if it was also listed as discoverable. This gives the disabled list the expected veto power.

**Data flow**: The test writes a config with calendar and Gmail as discoverable connector suggestions, then marks calendar as disabled. It loads the config and expects the connector-ID set to contain Gmail only.

**Call relations**: The async test runner invokes this test. It is paired with the inclusion test and verifies the filtering step after configured suggestions are read.

*Call graph*: 4 external calls (assert_eq!, default, write, tempdir).


##### `tool_suggest_uses_connector_id_fallback_when_directory_cache_is_empty`  (lines 469–508)

```
async fn tool_suggest_uses_connector_id_fallback_when_directory_cache_is_empty()
```

**Purpose**: Checks that tool suggestions can still show a configured connector even when the connector directory cache has no detailed app information. This fallback keeps suggestions useful when cached metadata is missing.

**Data flow**: The test writes a config enabling apps and declaring Gmail as a discoverable connector. It builds a config, creates dummy authentication, creates a plugin manager rooted in the temporary Codex home, then asks for discoverable tools with empty directory inputs. It expects a DiscoverableTool made from the connector ID fallback.

**Call relations**: The async test runner calls this test. It creates a PluginsManager and dummy auth object, then exercises the authenticated tool-suggestion listing path where the directory cache contributes no connector details.

*Call graph*: calls 2 internal fn (new, create_dummy_chatgpt_auth_for_testing); 4 external calls (assert_eq!, default, write, tempdir).


##### `tool_suggest_includes_connectors_from_loaded_plugin_apps`  (lines 511–546)

```
async fn tool_suggest_includes_connectors_from_loaded_plugin_apps()
```

**Purpose**: Checks that connectors from already loaded plugin apps are included in tool suggestions. This matters because some app connectors may be known from loaded plugins even if they were not listed in the config file.

**Data flow**: The test writes a config with the Apps feature enabled, builds the config, creates dummy authentication and a plugin manager, and supplies one loaded plugin-app connector ID. It asks for discoverable tools and expects a DiscoverableTool created from that connector ID.

**Call relations**: The async test runner invokes this test. It follows the same authenticated suggestion-listing path as the fallback test, but the important input here is the loaded_plugin_app_connector_ids list.

*Call graph*: calls 2 internal fn (new, create_dummy_chatgpt_auth_for_testing); 5 external calls (assert_eq!, default, write, tempdir, vec!).


### `tools/src/request_plugin_install_tests.rs`

`test` · `test suite`

This is a test file. It protects the code that asks a user to approve installing a tool, such as a Google Calendar connector or a remote plugin. That approval request is sent as a structured form through MCP, the Model Context Protocol, which is a way for the app and tool servers to exchange typed messages. If this shape changes by accident, another part of the system may not understand the request, or the user may be shown the wrong install prompt.

The tests build realistic example tools, then compare the produced request or metadata against the exact expected result. For connectors, the important details include the connector id, display name, install URL, and the reason the system is suggesting it. For plugins, the tests also check plugin-specific fields such as the remote plugin id and any app connector ids linked to that plugin.

The last two tests cover verification after installation. They make sure the code only treats a connector as installed when it appears in the accessible connector list, and that a group of requested connectors is only considered complete when every expected connector is present. In everyday terms, these tests are like checking both the invitation form and the guest list: the form must have the right fields, and every required guest must actually arrive.

#### Function details

##### `build_request_plugin_install_elicitation_request_uses_expected_shape`  (lines 7–73)

```
fn build_request_plugin_install_elicitation_request_uses_expected_shape()
```

**Purpose**: This test proves that a connector install suggestion becomes the exact approval request the system expects. It uses a Google Calendar connector example to make sure the request includes the right message, thread information, server name, and connector metadata.

**Data flow**: The test starts with install arguments and a sample connector record. It passes those into the request-building function along with a server name, thread id, turn id, and user-facing reason. The result is compared with a fully written-out expected request, so any missing field, wrong value, or changed structure makes the test fail.

**Call relations**: During the test run, Rust’s test runner calls this function. The function creates the connector example, calls the production request builder from the surrounding module, and then hands the result to an equality assertion to confirm that connector install requests keep their agreed contract.

*Call graph*: 4 external calls (new, new, assert_eq!, Connector).


##### `build_request_plugin_install_elicitation_request_injects_plugin_metadata`  (lines 76–131)

```
fn build_request_plugin_install_elicitation_request_injects_plugin_metadata()
```

**Purpose**: This test checks the plugin version of the install approval request. It makes sure plugin-only details, such as the remote plugin id and linked connector ids, are included in the request metadata.

**Data flow**: The test builds install arguments and a sample plugin record with a name, remote plugin id, MCP server names, and app connector ids. It feeds that data into the request-building function. The produced request is then compared against the expected request, including the plugin metadata that should be embedded inside the form.

**Call relations**: The test runner calls this test as part of the suite. Inside, the test constructs a plugin example, asks the production request builder to turn it into an approval form, and uses an equality assertion to catch any accidental loss or renaming of plugin-specific metadata.

*Call graph*: 4 external calls (new, assert_eq!, Plugin, vec!).


##### `build_request_plugin_install_meta_uses_expected_shape`  (lines 134–176)

```
fn build_request_plugin_install_meta_uses_expected_shape()
```

**Purpose**: This test focuses just on the metadata object used inside an install approval request. It verifies that connector metadata is packaged with the correct approval kind, persistence setting, tool identity, install URL, and suggestion reason.

**Data flow**: The test creates a Gmail connector example and passes it, along with the tool type, action type, and suggestion reason, into the metadata-building function. The returned metadata object is compared with the exact expected metadata. The output should contain connector fields and leave plugin-only fields empty.

**Call relations**: This test is called by the test runner. It exercises the lower-level metadata builder directly, instead of checking the larger request wrapper, so failures point more clearly to the metadata construction step.

*Call graph*: 4 external calls (new, new, assert_eq!, Connector).


##### `verified_connector_install_completed_requires_accessible_connector`  (lines 179–204)

```
fn verified_connector_install_completed_requires_accessible_connector()
```

**Purpose**: This test checks the rule for deciding whether one connector installation is complete. A connector only counts as complete if its id appears in the list of accessible connectors.

**Data flow**: The test starts with a list containing one accessible connector, Google Calendar. It asks the verification helper about the matching id, which should return true, and then about a missing Gmail id, which should return false. Nothing is changed; the test only checks the yes-or-no answers.

**Call relations**: The test runner calls this function. The function exercises the connector verification helper and uses assertions to confirm both the successful case and the missing-connector case, which are the two important branches of the rule.

*Call graph*: 2 external calls (assert!, vec!).


##### `all_requested_connectors_picked_up_requires_every_expected_connector`  (lines 207–232)

```
fn all_requested_connectors_picked_up_requires_every_expected_connector()
```

**Purpose**: This test checks the rule for deciding whether a set of requested connectors has all been picked up after installation. It must not succeed when even one requested connector is missing.

**Data flow**: The test creates a list with one accessible connector, then checks two requested-connector lists. When the requested list only contains Calendar, the helper should return true. When the requested list contains Calendar and Gmail, the helper should return false because Gmail is not accessible.

**Call relations**: The test runner calls this test during the suite. The test calls the group-checking helper and uses assertions to show that it depends on every requested connector being present, not merely one of them.

*Call graph*: 2 external calls (assert!, vec!).


### Skills loading and extension behavior
These tests cover skill parsing and invocation from the core loader and manager up through executor-aware and extension-provided skill catalogs.

### `core-skills/src/injection_tests.rs`

`test` · `test run`

This is a test file for skill injection: the part of the system that turns user text or structured input into a list of skills to include. A “skill” here is a reusable capability with a name and a path to its `SKILLS.md` file. The tests check the small but important details of recognizing skill mentions, because a loose match could accidentally activate the wrong skill, while a strict or broken match could ignore a user’s clear request.

The file builds fake skill records, feeds sample user inputs into the real selection code, and checks the result. It covers plain mentions like `$alpha-skill`, Markdown-style linked mentions like `[$alpha-skill](/tmp/alpha)`, disabled skills, duplicate mentions, ambiguous names, and conflicts with connector names. A connector is another named capability source, so the tests make sure a plain `$name` does not silently pick a skill when that same name could mean a connector.

A useful analogy is a receptionist reading appointment requests. If someone gives only a common first name, the receptionist should not guess. If they give a full address, that should win. These tests make sure the skills system follows that kind of careful behavior.

#### Function details

##### `make_skill`  (lines 9–21)

```
fn make_skill(name: &str, path: &str) -> SkillMetadata
```

**Purpose**: Creates a small fake `SkillMetadata` record for tests. It lets each test describe a skill by just giving a name and path, instead of repeating all the boilerplate fields every time.

**Data flow**: It takes a skill name and a path string. It fills in a complete skill metadata object, including a generated description, a test absolute path, user scope, and empty optional fields. The output is a ready-to-compare fake skill record.

**Call relations**: Most collection tests call this first to build the available skills list. It relies on the test path helper to turn simple path text into the path type used by the real code, then hands those skill records to `collect_mentions`.

*Call graph*: called by 13 (collect_explicit_skill_mentions_allows_explicit_path_with_connector_conflict, collect_explicit_skill_mentions_dedupes_by_path, collect_explicit_skill_mentions_prefers_linked_path_over_name, collect_explicit_skill_mentions_prefers_resource_path, collect_explicit_skill_mentions_prioritizes_structured_inputs, collect_explicit_skill_mentions_skips_ambiguous_name, collect_explicit_skill_mentions_skips_disabled_structured_and_blocks_plain_fallback, collect_explicit_skill_mentions_skips_invalid_structured_and_blocks_plain_fallback, collect_explicit_skill_mentions_skips_missing_path_with_no_fallback, collect_explicit_skill_mentions_skips_missing_path_without_fallback (+3 more)); 2 external calls (test_path_buf, format!).


##### `set`  (lines 23–25)

```
fn set(items: &'a [&'a str]) -> HashSet<&'a str>
```

**Purpose**: Turns a short list of expected strings into a set, so tests can compare mention results without caring about order.

**Data flow**: It receives a slice of string references. It copies those references into a `HashSet`, which keeps one copy of each item. The returned set is used as the expected names or paths in assertions.

**Call relations**: It supports `assert_mentions`. The mention extractor returns sets, so this helper builds matching expected sets for clean test comparisons.


##### `assert_mentions`  (lines 27–31)

```
fn assert_mentions(text: &str, expected_names: &[&str], expected_paths: &[&str])
```

**Purpose**: Checks that mention extraction found exactly the expected skill names and linked paths in a piece of text.

**Data flow**: It takes input text plus expected names and paths. It runs the real `extract_tool_mentions` logic, converts the expected values into sets, and compares both sides. If anything differs, the test fails with a readable assertion.

**Call relations**: All the `extract_tool_mentions_*` tests use this as their shared checker. It hides repetitive assertion setup so each test can focus on one rule about mention syntax.

*Call graph*: called by 6 (extract_tool_mentions_handles_plain_and_linked_mentions, extract_tool_mentions_keeps_plugin_skill_namespaces, extract_tool_mentions_requires_link_syntax, extract_tool_mentions_skips_common_env_vars, extract_tool_mentions_stops_at_non_name_chars, extract_tool_mentions_trims_linked_paths_and_allows_spacing); 1 external calls (assert_eq!).


##### `linked_skill_mention`  (lines 33–35)

```
fn linked_skill_mention(name: &str, unix_path: &str) -> String
```

**Purpose**: Builds a Markdown-style linked skill mention for tests, such as `[$alpha](/tmp/alpha)`. This keeps linked mention examples consistent across tests.

**Data flow**: It receives a skill name and a Unix-style path string. It converts the path through the test path helper and formats the name and path into link text. The output is a string that can be inserted into fake user text.

**Call relations**: Several selection tests use this to create explicit path mentions. Those texts are then passed through `collect_mentions` to check whether path-based selection beats name-based guessing.

*Call graph*: called by 1 (collect_explicit_skill_mentions_dedupes_by_path); 1 external calls (format!).


##### `collect_mentions`  (lines 37–44)

```
fn collect_mentions(
    inputs: &[UserInput],
    skills: &[SkillMetadata],
    disabled_paths: &HashSet<AbsolutePathBuf>,
    connector_slug_counts: &HashMap<String, usize>,
) -> Vec<SkillMetadata>
```

**Purpose**: Provides a short test wrapper around the real `collect_explicit_skill_mentions` function. It makes the tests easier to read by giving the main operation a compact name.

**Data flow**: It receives user inputs, available skills, disabled skill paths, and connector name counts. It passes them straight into the real collection function. The output is the list of selected skill metadata records.

**Call relations**: The skill-selection tests call this after building fake inputs and skills. It is the bridge between the test setup and the production logic being checked.

*Call graph*: called by 13 (collect_explicit_skill_mentions_allows_explicit_path_with_connector_conflict, collect_explicit_skill_mentions_dedupes_by_path, collect_explicit_skill_mentions_prefers_linked_path_over_name, collect_explicit_skill_mentions_prefers_resource_path, collect_explicit_skill_mentions_prioritizes_structured_inputs, collect_explicit_skill_mentions_skips_ambiguous_name, collect_explicit_skill_mentions_skips_disabled_structured_and_blocks_plain_fallback, collect_explicit_skill_mentions_skips_invalid_structured_and_blocks_plain_fallback, collect_explicit_skill_mentions_skips_missing_path_with_no_fallback, collect_explicit_skill_mentions_skips_missing_path_without_fallback (+3 more)).


##### `text_mentions_skill_requires_exact_boundary`  (lines 47–68)

```
fn text_mentions_skill_requires_exact_boundary()
```

**Purpose**: Verifies that a plain `$skill-name` mention only matches when the skill name ends at a real boundary. This prevents `$notion-research-doc` from accidentally matching inside `$notion-research-docs`.

**Data flow**: It feeds several example strings and one target skill name into `text_mentions_skill`. It expects true for clean mentions surrounded by punctuation or parentheses, and false for longer words that merely start with the same text.

**Call relations**: This directly exercises the low-level text matching rule. It protects later selection logic from receiving false matches caused by partial names.

*Call graph*: 1 external calls (assert_eq!).


##### `text_mentions_skill_handles_end_boundary_and_near_misses`  (lines 71–78)

```
fn text_mentions_skill_handles_end_boundary_and_near_misses()
```

**Purpose**: Checks that a skill mention at the very end of text is still valid, while similar longer names are not. It also confirms that a later correct mention is found even after an earlier near miss.

**Data flow**: It sends short text examples to `text_mentions_skill` with `alpha-skill` as the target. The function under test returns booleans, and the test compares them to the expected true or false values.

**Call relations**: This adds coverage for edge cases around the end of the string and repeated scanning. It supports confidence that plain-text mention detection behaves predictably.

*Call graph*: 1 external calls (assert_eq!).


##### `text_mentions_skill_handles_many_dollars_without_looping`  (lines 81–85)

```
fn text_mentions_skill_handles_many_dollars_without_looping()
```

**Purpose**: Makes sure the matcher does not get stuck or behave badly when the text contains many dollar signs. This guards against a small parsing bug becoming a hang or slowdown.

**Data flow**: It creates a string with 256 dollar signs followed by ordinary text. It asks whether that text mentions `alpha-skill`, and expects false. Nothing is selected or changed; the important result is that the check finishes normally.

**Call relations**: This stress-style test exercises `text_mentions_skill` on unusual input. It is separate from normal matching tests because its main concern is safe progress, not finding a valid skill.

*Call graph*: 2 external calls (assert_eq!, format!).


##### `extract_tool_mentions_handles_plain_and_linked_mentions`  (lines 88–94)

```
fn extract_tool_mentions_handles_plain_and_linked_mentions()
```

**Purpose**: Confirms that mention extraction sees both simple `$alpha` mentions and linked `[$beta](/tmp/beta)` mentions. It also checks that the linked path is captured.

**Data flow**: It passes one sentence containing both mention styles into `assert_mentions`. The expected output is two names, `alpha` and `beta`, plus the linked path `/tmp/beta`.

**Call relations**: This calls the shared assertion helper, which calls the real extractor. It establishes the basic behavior that the later, more specific extraction tests refine.

*Call graph*: calls 1 internal fn (assert_mentions).


##### `extract_tool_mentions_skips_common_env_vars`  (lines 97–101)

```
fn extract_tool_mentions_skips_common_env_vars()
```

**Purpose**: Checks that common environment variable names like `$PATH`, `$HOME`, and `$XDG_CONFIG_HOME` are not treated as skill requests. Environment variables are operating-system placeholders, not skill names.

**Data flow**: It sends texts containing environment-variable-looking tokens and real skill mentions into `assert_mentions`. The expected results include only real skill names like `alpha` or `beta`, and no path for `[$HOME](/tmp/skill)`.

**Call relations**: This protects `extract_tool_mentions` from over-reading normal shell-style text. It uses the shared helper so the test stays focused on the ignore list behavior.

*Call graph*: calls 1 internal fn (assert_mentions).


##### `extract_tool_mentions_requires_link_syntax`  (lines 104–108)

```
fn extract_tool_mentions_requires_link_syntax()
```

**Purpose**: Verifies that paths are only collected when the mention is a proper Markdown-style link. A name and a path sitting near each other should not be treated as a linked skill path.

**Data flow**: It tests examples like `[beta](/tmp/beta)`, `[$beta] /tmp/beta`, and `[$beta]()`. The extractor should find `$beta` as a name where appropriate, but it should not record a usable path unless the link syntax and path are valid.

**Call relations**: This calls `assert_mentions`, which checks the real extractor. It narrows the meaning of “linked path” so path-based selection only happens when the user clearly supplied one.

*Call graph*: calls 1 internal fn (assert_mentions).


##### `extract_tool_mentions_trims_linked_paths_and_allows_spacing`  (lines 111–113)

```
fn extract_tool_mentions_trims_linked_paths_and_allows_spacing()
```

**Purpose**: Checks that linked skill mentions still work when users include extra spaces around the parentheses or path. This makes the parser forgiving without changing the meaning.

**Data flow**: It passes text like `[$beta]   ( /tmp/beta )` into `assert_mentions`. The expected result is name `beta` and clean path `/tmp/beta`, with surrounding spaces removed.

**Call relations**: This exercises the extractor through the shared assertion helper. It ensures later path-based skill selection can work even with slightly messy but understandable user formatting.

*Call graph*: calls 1 internal fn (assert_mentions).


##### `extract_tool_mentions_stops_at_non_name_chars`  (lines 116–122)

```
fn extract_tool_mentions_stops_at_non_name_chars()
```

**Purpose**: Verifies where a plain mention name ends. For example, `$alpha.skill` should mention `alpha`, while underscores remain part of names like `beta_extra`.

**Data flow**: It gives the extractor text containing punctuation and underscore examples. The expected name set shows which characters are accepted as part of a mention and where parsing stops.

**Call relations**: This calls `assert_mentions` to check the extractor. It documents the name-character rules that feed into skill matching.

*Call graph*: calls 1 internal fn (assert_mentions).


##### `extract_tool_mentions_keeps_plugin_skill_namespaces`  (lines 125–131)

```
fn extract_tool_mentions_keeps_plugin_skill_namespaces()
```

**Purpose**: Checks that namespaced plugin skill names such as `$slack:search` are preserved as one mention. The colon matters because it separates a plugin or connector namespace from the skill action.

**Data flow**: It passes text containing `$slack:search` and `$alpha` into the extraction checker. The expected names are exactly `slack:search` and `alpha`, with no paths.

**Call relations**: This uses `assert_mentions` to exercise the real extractor. It protects plugin-style skill naming from being split or truncated.

*Call graph*: calls 1 internal fn (assert_mentions).


##### `collect_explicit_skill_mentions_text_respects_skill_order`  (lines 134–148)

```
fn collect_explicit_skill_mentions_text_respects_skill_order()
```

**Purpose**: Ensures that plain text mentions do not reorder selected skills based on where they appear in the sentence. The existing available-skills order remains the deciding order.

**Data flow**: It creates two fake skills in the order beta then alpha, while the text mentions alpha first and beta second. After collection, the expected selected list is still beta then alpha.

**Call relations**: This builds skills with `make_skill`, calls `collect_mentions`, and compares the result. It checks that the collection layer preserves its established ordering behavior instead of following text order.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 4 external calls (new, new, assert_eq!, vec!).


##### `collect_explicit_skill_mentions_prioritizes_structured_inputs`  (lines 151–170)

```
fn collect_explicit_skill_mentions_prioritizes_structured_inputs()
```

**Purpose**: Checks that a structured skill input is treated as more explicit than a plain text mention. Structured input means the system has already received a separate skill name and path, not just words in a sentence.

**Data flow**: It prepares text asking for alpha and a structured input naming beta with its path. Collection returns beta first, then alpha, showing that the structured request gets priority.

**Call relations**: The test uses `make_skill` for setup and `collect_mentions` for the real selection step. It documents how mixed input types are combined.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 4 external calls (new, new, assert_eq!, vec!).


##### `collect_explicit_skill_mentions_skips_invalid_structured_and_blocks_plain_fallback`  (lines 173–191)

```
fn collect_explicit_skill_mentions_skips_invalid_structured_and_blocks_plain_fallback()
```

**Purpose**: Verifies that a bad structured skill reference blocks fallback to a plain text mention of the same skill. This avoids silently doing something different from the explicit structured request.

**Data flow**: It creates one real alpha skill at `/tmp/alpha`, then supplies text mentioning alpha and a structured skill input pointing alpha at `/tmp/missing`. Collection returns an empty list because the structured path is invalid and the plain mention is not used as a backup.

**Call relations**: This calls `make_skill` and then `collect_mentions`. It checks a safety rule in the collection logic: an explicit but invalid path should not be ignored in favor of a looser name match.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 4 external calls (new, new, assert_eq!, vec!).


##### `collect_explicit_skill_mentions_skips_disabled_structured_and_blocks_plain_fallback`  (lines 194–213)

```
fn collect_explicit_skill_mentions_skips_disabled_structured_and_blocks_plain_fallback()
```

**Purpose**: Checks that a disabled skill is not selected, even when both structured input and plain text mention it. It also confirms that disabling blocks fallback behavior.

**Data flow**: It creates alpha, marks alpha’s path as disabled, and supplies both text and structured input for alpha. Collection returns no skills.

**Call relations**: The test builds the disabled path set with the test path helper, then calls `collect_mentions`. It protects the rule that disabled skills stay disabled no matter how they are mentioned.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 5 external calls (new, from, assert_eq!, test_path_buf, vec!).


##### `collect_explicit_skill_mentions_dedupes_by_path`  (lines 216–229)

```
fn collect_explicit_skill_mentions_dedupes_by_path()
```

**Purpose**: Ensures that mentioning the same linked skill path more than once selects the skill only once. This prevents duplicate injections of the same skill.

**Data flow**: It creates one alpha skill and user text containing the same linked mention twice. Collection returns a one-item list containing alpha.

**Call relations**: It uses `linked_skill_mention` to build repeated link text, then sends it through `collect_mentions`. It checks that the collector treats the path as the identity for removing duplicates.

*Call graph*: calls 3 internal fn (collect_mentions, linked_skill_mention, make_skill); 4 external calls (new, new, assert_eq!, vec!).


##### `collect_explicit_skill_mentions_skips_ambiguous_name`  (lines 232–245)

```
fn collect_explicit_skill_mentions_skips_ambiguous_name()
```

**Purpose**: Verifies that a plain name mention is ignored when more than one skill has that same name. The system should not guess between two possible paths.

**Data flow**: It creates two skills both named `demo-skill` but with different paths. Text mentions `$demo-skill`, and collection returns an empty list because the name alone is ambiguous.

**Call relations**: This uses `make_skill` to set up the ambiguity and `collect_mentions` to test the real behavior. It supports the broader safety rule that unclear user requests should not activate a random skill.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 4 external calls (new, new, assert_eq!, vec!).


##### `collect_explicit_skill_mentions_prefers_linked_path_over_name`  (lines 248–264)

```
fn collect_explicit_skill_mentions_prefers_linked_path_over_name()
```

**Purpose**: Checks that an explicit linked path wins over an ambiguous plain name. If the user gives the exact path, the system can choose the right skill even when names collide.

**Data flow**: It creates two `demo-skill` records with different paths. The text includes both a plain `$demo-skill` and a linked mention pointing to beta’s path. Collection returns only beta.

**Call relations**: The test combines `linked_skill_mention`, `make_skill`, and `collect_mentions`. It shows how the collection logic resolves ambiguity when a path gives a precise answer.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 4 external calls (new, new, assert_eq!, vec!).


##### `collect_explicit_skill_mentions_skips_plain_name_when_connector_matches`  (lines 267–279)

```
fn collect_explicit_skill_mentions_skips_plain_name_when_connector_matches()
```

**Purpose**: Ensures that a plain `$alpha-skill` mention is not treated as a skill when a connector with the same name exists. This avoids choosing the skill when the user might have meant the connector.

**Data flow**: It creates one alpha skill and a connector-name count saying `alpha-skill` exists as a connector. The text mentions `$alpha-skill`, and collection returns no selected skills.

**Call relations**: This test passes connector conflict information into `collect_mentions`. It checks the collector’s caution around names shared by different capability types.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 4 external calls (from, new, assert_eq!, vec!).


##### `collect_explicit_skill_mentions_allows_explicit_path_with_connector_conflict`  (lines 282–294)

```
fn collect_explicit_skill_mentions_allows_explicit_path_with_connector_conflict()
```

**Purpose**: Checks that a connector name conflict does not block a skill when the user provides an explicit linked path. The path removes the uncertainty.

**Data flow**: It creates alpha and a connector-name conflict for `alpha-skill`. The user text contains a linked mention pointing to alpha’s exact path. Collection returns alpha.

**Call relations**: This uses the same connector conflict setup as the plain-name conflict test, but with a path-based mention. Through `collect_mentions`, it confirms that precise linked paths are allowed.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 4 external calls (from, new, assert_eq!, vec!).


##### `collect_explicit_skill_mentions_skips_when_linked_path_disabled`  (lines 297–311)

```
fn collect_explicit_skill_mentions_skips_when_linked_path_disabled()
```

**Purpose**: Verifies that a linked skill mention is ignored if the linked path is disabled. Even an exact path should not override a disabled setting.

**Data flow**: It creates two same-named skills, links to alpha’s path in the text, and marks alpha’s path as disabled. Collection returns no selected skills.

**Call relations**: The test builds skills with `make_skill`, creates the disabled path set, and calls `collect_mentions`. It confirms that the disabled list is enforced after path resolution.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 5 external calls (new, from, assert_eq!, test_path_buf, vec!).


##### `collect_explicit_skill_mentions_prefers_resource_path`  (lines 314–327)

```
fn collect_explicit_skill_mentions_prefers_resource_path()
```

**Purpose**: Checks that when a linked path matches one of several same-named skills, that path chooses the matching skill. This is another direct test of path-based disambiguation.

**Data flow**: It creates two `demo-skill` records at different paths and text linking to beta’s path. Collection returns beta.

**Call relations**: This is centered on `collect_mentions`, with setup from `make_skill` and linked mention formatting. It reinforces that the resource path is the strongest clue for selecting a skill.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 4 external calls (new, new, assert_eq!, vec!).


##### `collect_explicit_skill_mentions_skips_missing_path_with_no_fallback`  (lines 330–343)

```
fn collect_explicit_skill_mentions_skips_missing_path_with_no_fallback()
```

**Purpose**: Ensures that a linked mention to a missing path does not fall back to a same-named skill. A wrong explicit path is treated as wrong, not as a hint to guess.

**Data flow**: It creates two `demo-skill` records but links to `/tmp/missing`. Collection finds no skill at that path and returns an empty list.

**Call relations**: This calls `collect_mentions` after creating ambiguous same-name skills. It protects the rule that explicit path mentions must match a known skill path.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 4 external calls (new, new, assert_eq!, vec!).


##### `collect_explicit_skill_mentions_skips_missing_path_without_fallback`  (lines 346–358)

```
fn collect_explicit_skill_mentions_skips_missing_path_without_fallback()
```

**Purpose**: Checks the same missing-path rule when there is only one skill with that name. Even without ambiguity, the collector should not ignore an invalid linked path and select by name instead.

**Data flow**: It creates one `demo-skill` at `/tmp/alpha` and text linking `demo-skill` to `/tmp/missing`. Collection returns no skills.

**Call relations**: This final selection test uses `make_skill` and `collect_mentions`. It confirms that exact linked path requests are strict in both ambiguous and non-ambiguous cases.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 4 external calls (new, new, assert_eq!, vec!).


### `core-skills/src/invocation_utils_tests.rs`

`test` · `test run`

A “skill” in this project has a SKILL.md document and may also have scripts in a scripts folder. The main code needs to notice when a command like cat /path/to/SKILL.md means “the user read this skill’s instructions,” or when python3 scripts/tool.py means “the user ran this skill’s helper script.” Without these checks, the system could miss important skill activity, especially when paths are written in different forms such as absolute paths or paths relative to the current folder.

This test file builds small fake skill records and fake command token lists, then asks the detection helpers whether they find the right skill. Think of the command tokens as words already split from a shell command. The tests check both positive and negative cases: a Python script file should count as a script run, but python3 -c "print(1)" should not, because that runs inline code rather than a script file.

The tests also make sure path matching is forgiving in the right ways. They normalize paths before storing them, then verify that document reads and script runs still match when commands use absolute paths, relative paths, or common file-reading tools such as cat and nl.

#### Function details

##### `test_skill_metadata`  (lines 14–26)

```
fn test_skill_metadata(skill_doc_path: AbsolutePathBuf) -> SkillMetadata
```

**Purpose**: Creates a small, predictable fake SkillMetadata record for tests. The tests use it so they do not need to repeat all the fields required to describe a skill.

**Data flow**: It receives the path to a fake SKILL.md file. It puts that path into a SkillMetadata value, fills the name and description with simple test text, leaves optional fields empty, and returns the completed fake skill record.

**Call relations**: The document-read and script-run tests call this helper while setting up their fake skill inventory. It gives those tests a known skill named test-skill, so they can later check that the detection code found the expected skill.

*Call graph*: called by 4 (skill_doc_read_detection_matches_absolute_path, skill_doc_read_detection_matches_shared_read_parser, skill_script_run_detection_matches_absolute_path_from_any_workdir, skill_script_run_detection_matches_relative_path_from_skill_root).


##### `test_path_display`  (lines 28–30)

```
fn test_path_display(unix_path: &str) -> String
```

**Purpose**: Turns a Unix-style test path string into the display form used by the current test environment. This keeps the tests portable instead of assuming that paths are printed the same way everywhere.

**Data flow**: It receives a path written as a string, builds a test path object from it, converts that path to its printable display text, and returns the resulting string.

**Call relations**: Tests use this helper when they need to put a path into a fake command token list. It relies on the shared test path builder, then hands the formatted path text to the detection functions as if it had come from a shell command.

*Call graph*: 1 external calls (test_path_buf).


##### `script_run_detection_matches_runner_plus_extension`  (lines 33–41)

```
fn script_run_detection_matches_runner_plus_extension()
```

**Purpose**: Checks that a command using a script runner and a script-looking filename is recognized as a script run. In this case, python3 is the runner and fetch_comments.py is the script file.

**Data flow**: It builds a list of command tokens: python3, an option, and a .py script path. It passes those tokens to script_run_token, then checks that the result is present rather than empty.

**Call relations**: This test directly exercises the low-level script-run recognizer. It confirms that later, higher-level skill matching has a script path to work with when a command looks like a normal script execution.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `script_run_detection_excludes_python_c`  (lines 44–52)

```
fn script_run_detection_excludes_python_c()
```

**Purpose**: Checks that inline Python code is not mistaken for running a script file. The command python3 -c print(1) runs code supplied on the command line, not a file from a skill’s scripts folder.

**Data flow**: It builds tokens for python3 -c print(1), sends them to script_run_token, and checks that no script token is returned.

**Call relations**: This test guards against a false positive in the script-run recognizer. It matters because the broader skill detection should only connect commands to skills when an actual script file path is present.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `skill_doc_read_detection_matches_absolute_path`  (lines 55–77)

```
fn skill_doc_read_detection_matches_absolute_path()
```

**Purpose**: Checks that reading a skill document by its full path is linked back to the correct skill. This covers commands such as cat /tmp/skill-test/SKILL.md.

**Data flow**: It creates a fake skill whose document is at an absolute path, normalizes that path, and stores the skill in the fake loaded-skill outcome under that document path. It then builds command tokens for reading that document and passes them, along with a working directory, to detect_skill_doc_read. The expected output is the fake skill named test-skill.

**Call relations**: This test uses test_skill_metadata to build the skill record and then calls the document-read detector. It proves that the detector can look at command tokens, compare the path against the known skill-document map, and return the matching skill.

*Call graph*: calls 1 internal fn (test_skill_metadata); 9 external calls (new, default, from, new, assert_eq!, test_path_buf, canonicalize_if_exists, detect_skill_doc_read, vec!).


##### `skill_doc_read_detection_matches_shared_read_parser`  (lines 80–101)

```
fn skill_doc_read_detection_matches_shared_read_parser()
```

**Purpose**: Checks that the skill document detector works with a shared parser for common file-reading commands, not just one hard-coded command. Here it uses nl, a command that prints files with line numbers.

**Data flow**: It sets up the same kind of fake skill and normalized SKILL.md path as the other document-read test. It then builds tokens for nl -ba /tmp/skill-test/SKILL.md, runs detect_skill_doc_read, and expects to get back the fake skill named test-skill.

**Call relations**: This test again uses test_skill_metadata for setup, then sends the command tokens into the document-read detector. It confirms that the detector’s file-reading logic is shared broadly enough to catch different tools that read a SKILL.md file.

*Call graph*: calls 1 internal fn (test_skill_metadata); 9 external calls (new, default, from, new, assert_eq!, test_path_buf, canonicalize_if_exists, detect_skill_doc_read, vec!).


##### `skill_script_run_detection_matches_relative_path_from_skill_root`  (lines 104–124)

```
fn skill_script_run_detection_matches_relative_path_from_skill_root()
```

**Purpose**: Checks that running a skill script by a path relative to the skill’s root folder is recognized. For example, from inside the skill folder, python3 scripts/fetch_comments.py should point to that skill.

**Data flow**: It creates a fake skill, records the normalized scripts directory for that skill, and builds command tokens with a relative script path. It calls detect_skill_script_run with the working directory set to the skill root. The detector should combine the working directory and relative path, match it to the known scripts directory, and return the fake skill.

**Call relations**: This test uses test_skill_metadata while preparing the fake loaded-skill outcome, then calls the script-run detector. It verifies the everyday case where a user is already inside the skill folder and runs a script with a short relative path.

*Call graph*: calls 1 internal fn (test_skill_metadata); 9 external calls (new, default, from, new, assert_eq!, test_path_buf, canonicalize_if_exists, detect_skill_script_run, vec!).


##### `skill_script_run_detection_matches_absolute_path_from_any_workdir`  (lines 127–147)

```
fn skill_script_run_detection_matches_absolute_path_from_any_workdir()
```

**Purpose**: Checks that running a skill script by its full path is recognized even when the current working directory is somewhere else. This matters because absolute paths should not depend on where the command was launched.

**Data flow**: It creates a fake skill and stores its normalized scripts directory. It then builds command tokens where the script path is absolute, while the working directory is a different folder. detect_skill_script_run should use the absolute script path directly, match it to the known scripts directory, and return the fake skill named test-skill.

**Call relations**: This test shares the same setup pattern as the relative-path script test, using test_skill_metadata and the fake loaded-skill outcome. It then exercises the script-run detector in the case where the command gives enough path information on its own, so the working directory should not stop the match.

*Call graph*: calls 1 internal fn (test_skill_metadata); 9 external calls (new, default, from, new, assert_eq!, test_path_buf, canonicalize_if_exists, detect_skill_script_run, vec!).


### `core-skills/src/loader_tests.rs`

`test` · `test run`

Skills are small packages described by a SKILLS.md file and optional metadata. The loader has to search several places for them: user folders, repo folders, system cache folders, admin folders, and plugin folders. It also has to reject unsafe or malformed data, such as bad metadata, paths that escape allowed asset folders, overlong text, and symlink traps. This test file acts like a miniature city built for inspections. It creates temporary directories, writes fake skill files, marks fake Git repos, and then asks the real loader what it finds. The tests check both happy paths and edge cases: user and repo priority, hidden folders, duplicate names, missing names, system cache skills, plugin namespacing, interface icons, policy flags, dependencies, symlinks, and scan-depth limits. The helper functions keep the tests hermetic, meaning they avoid using the real home directory or real config files. Without this file, changes to skill discovery could silently break important behavior, such as loading repo skills, ignoring unsafe icon paths, or getting stuck following a symlink loop.

#### Function details

##### `make_config`  (lines 29–31)

```
async fn make_config(codex_home: &TempDir) -> TestConfig
```

**Purpose**: Creates a standard fake configuration for tests where the current working directory is the temporary Codex home. Tests use it when they only need a user-style setup and not a special repo location.

**Data flow**: It receives a temporary directory that stands in for Codex home. It turns that directory path into the current working directory for the test and passes both pieces to make_config_for_cwd. It returns a TestConfig containing an absolute current directory and a stack of fake config layers.

**Call relations**: Many tests call this helper before loading skills. It is a shortcut into make_config_for_cwd, which does the full setup work.

*Call graph*: calls 1 internal fn (make_config_for_cwd); called by 19 (accepts_icon_paths_under_assets_dir, does_not_loop_on_symlink_cycle_for_user_scope, drops_interface_when_icons_are_invalid, empty_skill_policy_defaults_to_allow_implicit_invocation, enforces_length_limits, enforces_short_description_length_limits, falls_back_to_directory_name_when_skill_name_is_missing, ignores_default_prompt_over_max_length, ignores_invalid_brand_color, ignores_symlinked_skill_file_for_user_scope (+9 more)); 1 external calls (path).


##### `config_file`  (lines 33–35)

```
fn config_file(path: PathBuf) -> AbsolutePathBuf
```

**Purpose**: Converts a normal path into the absolute path type expected by the config layer code. It keeps test setup short and consistent.

**Data flow**: It receives a PathBuf. It converts that path to an AbsolutePathBuf and returns it without changing the file system.

**Call relations**: It is used inside config construction so fake system and user config files look like real absolute config paths.

*Call graph*: 1 external calls (abs).


##### `project_layers_for_cwd`  (lines 37–80)

```
fn project_layers_for_cwd(cwd: &Path) -> Vec<ConfigLayerEntry>
```

**Purpose**: Builds the fake project config layers that would apply for a given current directory. This lets tests mimic how Codex discovers .codex folders inside a project.

**Data flow**: It receives a current path, treats it as either a directory or a file inside a directory, finds the nearest fake Git root if one exists, walks from that root down to the current directory, and returns config-layer entries for any .codex folders it sees.

**Call relations**: make_config_for_cwd calls this when assembling the full config stack. Repo-related tests rely on it to make their fake .codex/skills folders visible to the loader.

*Call graph*: called by 1 (make_config_for_cwd); 3 external calls (is_dir, parent, to_path_buf).


##### `make_config_for_cwd`  (lines 82–119)

```
async fn make_config_for_cwd(codex_home: &TempDir, cwd: PathBuf) -> TestConfig
```

**Purpose**: Creates a complete fake config setup for a chosen current working directory. This is the main test helper for checking user, system, and repo skill discovery together.

**Data flow**: It receives a temporary Codex home and a current path. It creates a fake system config directory, makes system and user config layer entries, adds project layers from project_layers_for_cwd, converts the current path to an absolute path, and returns a TestConfig.

**Call relations**: Repo and system-cache tests call this directly when they need control over the current directory. make_config calls it for the simpler default case.

*Call graph*: calls 2 internal fn (new, project_layers_for_cwd); called by 12 (keeps_duplicate_names_from_nested_codex_dirs, keeps_duplicate_names_from_repo_and_user, loads_skills_from_agents_dir_without_codex_dir, loads_skills_from_all_codex_dirs_under_project_root, loads_skills_from_codex_dir_when_not_git_repo, loads_skills_from_repo_root, loads_skills_from_system_cache_when_present, loads_skills_via_symlinked_subdir_for_repo_scope, loads_skills_when_cwd_is_file_in_repo, make_config (+2 more)); 6 external calls (abs, path, default, default, create_dir_all, vec!).


##### `load_skills_for_test`  (lines 121–133)

```
async fn load_skills_for_test(config: &TestConfig) -> SkillLoadOutcome
```

**Purpose**: Runs the real skill-loading pipeline in a safe test mode. It deliberately avoids scanning the real home directory so tests stay isolated.

**Data flow**: It receives a TestConfig. It asks the loader to derive skill roots from the fake config stack and current directory, with no real home directory, then loads skills from those roots and returns the outcome.

**Call relations**: Most tests call this after creating files. It connects the test fixture setup to the real loader functions skill_roots_from_layer_stack and load_skills_from_roots.

*Call graph*: called by 29 (accepts_icon_paths_under_assets_dir, does_not_loop_on_symlink_cycle_for_user_scope, drops_interface_when_icons_are_invalid, empty_skill_policy_defaults_to_allow_implicit_invocation, enforces_length_limits, enforces_short_description_length_limits, falls_back_to_directory_name_when_skill_name_is_missing, ignores_default_prompt_over_max_length, ignores_invalid_brand_color, ignores_symlinked_skill_file_for_user_scope (+15 more)); 3 external calls (clone, load_skills_from_roots, skill_roots_from_layer_stack).


##### `mark_as_git_repo`  (lines 135–139)

```
fn mark_as_git_repo(dir: &Path)
```

**Purpose**: Marks a temporary directory as a fake Git repository. This lets tests trigger repo-root behavior without running Git.

**Data flow**: It receives a directory path. It writes a small .git file into that directory. It returns nothing, but the directory now looks like a repo to the project-root discovery code.

**Call relations**: Repo-discovery tests call this before building config. project_layers_for_cwd later sees the .git marker and treats that directory as the project root.

*Call graph*: called by 8 (keeps_duplicate_names_from_nested_codex_dirs, keeps_duplicate_names_from_repo_and_user, loads_skills_from_agents_dir_without_codex_dir, loads_skills_from_all_codex_dirs_under_project_root, loads_skills_from_repo_root, loads_skills_via_symlinked_subdir_for_repo_scope, loads_skills_when_cwd_is_file_in_repo, repo_skills_search_does_not_escape_repo_root); 2 external calls (join, write).


##### `normalized`  (lines 141–145)

```
fn normalized(path: &Path) -> AbsolutePathBuf
```

**Purpose**: Turns paths into the same absolute, cleaned-up form that the loader reports. Tests use it so expected paths match real output even when symlinks or relative pieces are involved.

**Data flow**: It receives a path. It tries to canonicalize it, meaning resolve it to the operating system’s real path; if that fails, it keeps the original path. It returns an absolute path buffer.

**Call relations**: Assertions use this helper when comparing SkillMetadata paths and icon paths. It keeps expected values aligned with the loader’s path normalization.

*Call graph*: called by 5 (accepts_icon_paths_under_assets_dir, ignores_default_prompt_over_max_length, keeps_duplicate_names_from_nested_codex_dirs, loads_plugin_skill_interface_icons_from_shared_plugin_assets, loads_skill_interface_metadata_from_yaml); 1 external calls (canonicalize).


##### `skill_roots_from_layer_stack_maps_user_to_user_and_system_cache_and_system_to_admin`  (lines 148–210)

```
async fn skill_roots_from_layer_stack_maps_user_to_user_and_system_cache_and_system_to_admin() -> anyhow::Result<()>
```

**Purpose**: Checks that config layers become the correct skill search folders and scopes. It verifies that user config, home agents skills, system cache skills, and admin skills are ordered as expected.

**Data flow**: The test creates fake system, home, and user config folders, builds a config stack, asks skill_roots_from_layer_stack for roots, converts them to simple scope/path pairs, and compares them with the expected list.

**Call relations**: This test exercises skill_roots_from_layer_stack directly rather than loading skills. It protects the mapping from config source to search location.

*Call graph*: calls 1 internal fn (new); 7 external calls (clone, default, assert_eq!, default, create_dir_all, tempdir, vec!).


##### `skill_roots_from_layer_stack_includes_disabled_project_layers`  (lines 213–279)

```
async fn skill_roots_from_layer_stack_includes_disabled_project_layers() -> anyhow::Result<()>
```

**Purpose**: Checks that project skill folders are still considered even when their config layer is disabled as untrusted. This matters because skill discovery and config trust are separate concerns.

**Data flow**: The test creates a fake user config and a disabled project config layer, asks for skill roots, and verifies that the repo root appears before user and system-cache roots.

**Call relations**: It calls skill_roots_from_layer_stack directly to confirm root selection behavior before any skill file parsing happens.

*Call graph*: calls 1 internal fn (new); 7 external calls (clone, default, assert_eq!, default, create_dir_all, tempdir, vec!).


##### `loads_skills_from_home_agents_dir_for_user_scope`  (lines 282–340)

```
async fn loads_skills_from_home_agents_dir_for_user_scope() -> anyhow::Result<()>
```

**Purpose**: Verifies that skills under the home .agents/skills folder load as user skills. This supports compatibility with the shared agents directory layout.

**Data flow**: The test creates fake config, writes a skill under home/.agents/skills, derives roots, loads skills, and expects one user-scoped SkillMetadata record with the written name and description.

**Call relations**: It uses write_skill_at to create the fixture, then runs skill_roots_from_layer_stack and load_skills_from_roots to check the full discovery path.

*Call graph*: calls 2 internal fn (new, write_skill_at); 8 external calls (clone, default, assert!, assert_eq!, default, create_dir_all, tempdir, vec!).


##### `write_skill`  (lines 342–344)

```
fn write_skill(codex_home: &TempDir, dir: &str, name: &str, description: &str) -> PathBuf
```

**Purpose**: Writes a normal test skill under the fake Codex home skills folder. It is the common helper for creating valid user skills.

**Data flow**: It receives a temporary Codex home, a subdirectory name, a skill name, and a description. It delegates to write_skill_at using codex_home/skills and returns the path to the new SKILLS.md file.

**Call relations**: Many tests use this helper before calling make_config and load_skills_for_test. It is a thin wrapper around write_skill_at.

*Call graph*: calls 1 internal fn (write_skill_at); called by 13 (accepts_icon_paths_under_assets_dir, drops_interface_when_icons_are_invalid, empty_skill_policy_defaults_to_allow_implicit_invocation, enforces_length_limits, ignores_default_prompt_over_max_length, ignores_invalid_brand_color, keeps_duplicate_names_from_repo_and_user, loads_skill_dependencies_metadata_from_yaml, loads_skill_interface_metadata_from_yaml, loads_skill_policy_from_yaml (+3 more)); 1 external calls (path).


##### `write_system_skill`  (lines 346–353)

```
fn write_system_skill(codex_home: &TempDir, dir: &str, name: &str, description: &str) -> PathBuf
```

**Purpose**: Writes a normal test skill under the fake system-cache skill folder. It is used to check system-scoped skill loading.

**Data flow**: It receives a temporary Codex home, a subdirectory, a name, and a description. It writes the skill under skills/.system and returns the SKILLS.md path.

**Call relations**: The system-cache test calls this, then load_skills_for_test verifies that the loader reports the skill with system scope.

*Call graph*: calls 1 internal fn (write_skill_at); called by 1 (loads_skills_from_system_cache_when_present); 1 external calls (path).


##### `write_skill_at`  (lines 355–364)

```
fn write_skill_at(root: &Path, dir: &str, name: &str, description: &str) -> PathBuf
```

**Purpose**: Creates a valid SKILLS.md file at a chosen root. It lets tests place skills in user, repo, admin, plugin, or shared directories.

**Data flow**: It receives a root folder, skill directory name, skill name, and description. It creates the directory, writes YAML front matter with name and description, and returns the path to SKILLS.md.

**Call relations**: Most tests use this helper directly or through write_skill and write_system_skill. The resulting files are then consumed by load_skills_from_roots or load_skills_for_test.

*Call graph*: called by 21 (deduplicates_by_path_preferring_first_root, does_not_loop_on_symlink_cycle_for_user_scope, drops_plugin_skill_interface_icons_that_escape_shared_plugin_assets, ignores_symlinked_skill_file_for_user_scope, keeps_duplicate_names_from_nested_codex_dirs, keeps_duplicate_names_from_repo_and_user, loads_plugin_skill_interface_icons_from_shared_plugin_assets, loads_skills_from_agents_dir_without_codex_dir, loads_skills_from_all_codex_dirs_under_project_root, loads_skills_from_codex_dir_when_not_git_repo (+11 more)); 4 external calls (join, format!, create_dir_all, write).


##### `write_raw_skill_at`  (lines 366–373)

```
fn write_raw_skill_at(root: &Path, dir: &str, frontmatter: &str) -> PathBuf
```

**Purpose**: Creates a SKILLS.md file with custom front matter. Tests use it when they need missing fields, overlong names, or plugin-specific metadata.

**Data flow**: It receives a root, directory name, and raw front matter text. It wraps that text between YAML front matter markers, writes the file, and returns the path.

**Call relations**: Tests for fallback names and plugin name limits call this because write_skill always writes a complete standard skill.

*Call graph*: called by 4 (falls_back_to_directory_name_when_skill_name_is_missing, namespaces_plugin_skills_using_plugin_name, plugin_skill_name_length_limit_allows_max_qualified_name, plugin_skill_name_length_limit_rejects_overlong_qualified_name); 4 external calls (join, format!, create_dir_all, write).


##### `write_skill_metadata_at`  (lines 375–384)

```
fn write_skill_metadata_at(skill_dir: &Path, contents: &str) -> PathBuf
```

**Purpose**: Writes the optional metadata file for a skill. This file can describe dependencies, interface details, and policy settings.

**Data flow**: It receives a skill directory and metadata contents. It creates the metadata folder if needed, writes the metadata file, and returns its path.

**Call relations**: Metadata-focused tests call this directly. write_skill_interface_at also uses it because interface data is stored in the same metadata file.

*Call graph*: called by 5 (empty_skill_policy_defaults_to_allow_implicit_invocation, loads_skill_dependencies_metadata_from_yaml, loads_skill_policy_from_yaml, loads_skill_policy_products_from_yaml, write_skill_interface_at); 3 external calls (join, create_dir_all, write).


##### `write_skill_interface_at`  (lines 386–388)

```
fn write_skill_interface_at(skill_dir: &Path, contents: &str) -> PathBuf
```

**Purpose**: Writes interface metadata for a skill using the shared metadata-file helper. It keeps interface tests readable.

**Data flow**: It receives a skill directory and text contents. It passes both to write_skill_metadata_at and returns the metadata file path.

**Call relations**: Interface and icon-path tests call this before loading skills. It is a naming wrapper that shows the test is about interface data.

*Call graph*: calls 1 internal fn (write_skill_metadata_at); called by 7 (accepts_icon_paths_under_assets_dir, drops_interface_when_icons_are_invalid, drops_plugin_skill_interface_icons_that_escape_shared_plugin_assets, ignores_default_prompt_over_max_length, ignores_invalid_brand_color, loads_plugin_skill_interface_icons_from_shared_plugin_assets, loads_skill_interface_metadata_from_yaml).


##### `loads_skill_dependencies_metadata_from_yaml`  (lines 391–476)

```
async fn loads_skill_dependencies_metadata_from_yaml()
```

**Purpose**: Checks that a skill’s dependency metadata is read correctly. Dependencies describe outside tools a skill may need, such as command-line tools or MCP servers.

**Data flow**: The test writes a skill and a metadata file containing several tool dependencies. It loads skills and expects one SkillMetadata value whose dependencies match the metadata exactly.

**Call relations**: It uses write_skill and write_skill_metadata_at for setup, then make_config and load_skills_for_test to exercise the real loader.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config, write_skill, write_skill_metadata_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `loads_skill_interface_metadata_from_yaml`  (lines 479–532)

```
async fn loads_skill_interface_metadata_from_yaml()
```

**Purpose**: Checks that user-interface metadata is loaded and cleaned up. This includes display names, short descriptions, icons, brand color, and default prompt text.

**Data flow**: The test writes a skill, writes interface metadata, loads skills, filters user skills, and compares the result with normalized icon paths and trimmed text fields.

**Call relations**: It uses normalized for expected paths and load_skills_for_test for the actual loader behavior.

*Call graph*: calls 5 internal fn (load_skills_for_test, make_config, normalized, write_skill, write_skill_interface_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `loads_skill_policy_from_yaml`  (lines 535–565)

```
async fn loads_skill_policy_from_yaml()
```

**Purpose**: Checks that a policy can explicitly prevent a skill from being invoked automatically. Automatic invocation means the system may choose the skill without the user naming it.

**Data flow**: The test writes a skill with policy allow_implicit_invocation set to false. After loading, it checks the stored policy and confirms the skill is not in the allowed-for-implicit-invocation list.

**Call relations**: It uses the standard file-writing helpers, then relies on SkillLoadOutcome behavior to verify the policy affects the allowed list.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config, write_skill, write_skill_metadata_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `empty_skill_policy_defaults_to_allow_implicit_invocation`  (lines 568–600)

```
async fn empty_skill_policy_defaults_to_allow_implicit_invocation()
```

**Purpose**: Checks that an empty policy does not block automatic use of a skill. The absence of a deny flag should behave like the default allow behavior.

**Data flow**: The test writes a skill with policy: {} in metadata, loads skills, checks that the policy exists but has no explicit allow flag, and confirms the skill remains allowed for implicit invocation.

**Call relations**: It sets up metadata through write_skill_metadata_at and checks both raw loaded metadata and the outcome’s helper for allowed skills.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config, write_skill, write_skill_metadata_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `loads_skill_policy_products_from_yaml`  (lines 603–635)

```
async fn loads_skill_policy_products_from_yaml()
```

**Purpose**: Checks that product restrictions in policy metadata are parsed. Product names identify where a skill is meant to be used, such as Codex, ChatGPT, or Atlas.

**Data flow**: The test writes policy products using different letter cases, loads the skill, and expects the product list to become the correct Product enum values.

**Call relations**: It runs through load_skills_for_test so the product parsing is tested as part of normal skill loading.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config, write_skill, write_skill_metadata_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `accepts_icon_paths_under_assets_dir`  (lines 638–686)

```
async fn accepts_icon_paths_under_assets_dir()
```

**Purpose**: Verifies that interface icon paths are accepted when they stay inside the skill’s assets folder. This protects a safe convention for bundled images.

**Data flow**: The test writes interface metadata with icon_small and icon_large under assets, loads skills, and expects those paths to be normalized and included in SkillInterface.

**Call relations**: It uses write_skill_interface_at to create metadata, normalized to build expected paths, and load_skills_for_test to check loader validation.

*Call graph*: calls 5 internal fn (load_skills_for_test, make_config, normalized, write_skill, write_skill_interface_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `ignores_invalid_brand_color`  (lines 689–727)

```
async fn ignores_invalid_brand_color()
```

**Purpose**: Checks that an invalid brand color does not make it into loaded interface metadata. A valid brand color is expected to be a hex color like #3B82F6.

**Data flow**: The test writes metadata with brand_color set to blue, loads the skill, and expects the skill to load but the interface section to be absent.

**Call relations**: It exercises the interface validation path through load_skills_for_test after setup with write_skill and write_skill_interface_at.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config, write_skill, write_skill_interface_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `ignores_default_prompt_over_max_length`  (lines 730–781)

```
async fn ignores_default_prompt_over_max_length()
```

**Purpose**: Checks that an overlong default prompt is discarded while other valid interface fields survive. This prevents very large prompt text from being accepted accidentally.

**Data flow**: The test creates a default prompt one character longer than the limit, writes interface metadata with other valid fields, loads the skill, and expects default_prompt to be None while display name and icon remain.

**Call relations**: It combines test fixture writing, normalized expected paths, and the real loader to verify partial interface cleanup.

*Call graph*: calls 5 internal fn (load_skills_for_test, make_config, normalized, write_skill, write_skill_interface_at); 4 external calls (assert!, assert_eq!, format!, tempdir).


##### `drops_interface_when_icons_are_invalid`  (lines 784–823)

```
async fn drops_interface_when_icons_are_invalid()
```

**Purpose**: Checks that unsafe or wrongly placed icon paths cause the interface metadata to be dropped. This prevents icons from pointing outside the allowed assets area.

**Data flow**: The test writes icon paths that are not safely under assets, loads the skill, and expects the skill itself to load with no interface metadata.

**Call relations**: It uses write_skill_interface_at to create invalid metadata and load_skills_for_test to verify the loader’s validation decision.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config, write_skill, write_skill_interface_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `loads_plugin_skill_interface_icons_from_shared_plugin_assets`  (lines 826–884)

```
async fn loads_plugin_skill_interface_icons_from_shared_plugin_assets()
```

**Purpose**: Checks that plugin skills may use shared icons from the plugin’s assets folder. This supports plugins that keep common images outside each individual skill directory.

**Data flow**: The test creates a fake plugin root, writes a skill under plugin skills, writes icon paths that point to plugin assets, loads that root as a plugin root, and expects normalized shared asset paths in the interface.

**Call relations**: It calls load_skills_from_roots directly with a SkillRoot containing plugin_id and plugin_root, bypassing config helpers because it is testing plugin-specific root behavior.

*Call graph*: calls 3 internal fn (normalized, write_skill_at, write_skill_interface_at); 6 external calls (clone, assert!, assert_eq!, create_dir_all, write, tempdir).


##### `drops_plugin_skill_interface_icons_that_escape_shared_plugin_assets`  (lines 887–933)

```
async fn drops_plugin_skill_interface_icons_that_escape_shared_plugin_assets()
```

**Purpose**: Checks that plugin icon paths are rejected when they point outside the plugin’s shared assets area. This is a safety rule against path escape.

**Data flow**: The test writes a plugin skill whose icon points to a sibling folder outside assets. After loading, it expects the skill to remain but its interface metadata to be absent.

**Call relations**: Like the valid plugin-icon test, it calls load_skills_from_roots directly with plugin information to focus on plugin path validation.

*Call graph*: calls 2 internal fn (write_skill_at, write_skill_interface_at); 4 external calls (clone, assert!, assert_eq!, tempdir).


##### `symlink_dir`  (lines 936–938)

```
fn symlink_dir(target: &Path, link: &Path)
```

**Purpose**: Creates a directory symbolic link on Unix systems. A symbolic link is a file-system shortcut that points to another location.

**Data flow**: It receives a target directory and a link path. It creates the symlink and returns nothing; after that, the link path points at the target.

**Call relations**: Unix-only symlink tests call this before loading skills to see how the loader follows or ignores linked directories.

*Call graph*: called by 5 (does_not_loop_on_symlink_cycle_for_user_scope, loads_skills_via_symlinked_subdir_for_admin_scope, loads_skills_via_symlinked_subdir_for_repo_scope, loads_skills_via_symlinked_subdir_for_user_scope, system_scope_ignores_symlinked_subdir); 1 external calls (symlink).


##### `symlink_file`  (lines 941–943)

```
fn symlink_file(target: &Path, link: &Path)
```

**Purpose**: Creates a file symbolic link on Unix systems. Tests use it to check that linked SKILLS.md files are not accepted in user scope.

**Data flow**: It receives a target file and a link path. It creates the symlink and returns nothing; the link path now points to the target file.

**Call relations**: The symlinked-file test calls this after creating a real skill elsewhere, then load_skills_for_test verifies the loader ignores the linked file.

*Call graph*: called by 1 (ignores_symlinked_skill_file_for_user_scope); 1 external calls (symlink).


##### `loads_skills_via_symlinked_subdir_for_user_scope`  (lines 947–978)

```
async fn loads_skills_via_symlinked_subdir_for_user_scope()
```

**Purpose**: Checks that user skill scanning can follow a symlinked subdirectory. This allows users to share or organize skill folders by linking directories.

**Data flow**: The test writes a skill in a separate shared directory, symlinks that directory under codex_home/skills, loads skills, and expects the linked skill to appear as a user skill.

**Call relations**: It uses symlink_dir for the linked folder and then runs the normal config-based loader path through load_skills_for_test.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config, symlink_dir, write_skill_at); 4 external calls (assert!, assert_eq!, create_dir_all, tempdir).


##### `ignores_symlinked_skill_file_for_user_scope`  (lines 982–1001)

```
async fn ignores_symlinked_skill_file_for_user_scope()
```

**Purpose**: Checks that a direct symlink to a SKILLS.md file is ignored for user skills. Directory links are allowed, but linked skill files are treated more cautiously.

**Data flow**: The test writes a real skill elsewhere, creates a user skill directory containing a symlinked SKILLS.md, loads skills, and expects no skills.

**Call relations**: It uses symlink_file to create the risky file link, then load_skills_for_test to confirm the loader’s rule.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config, symlink_file, write_skill_at); 4 external calls (assert!, assert_eq!, create_dir_all, tempdir).


##### `does_not_loop_on_symlink_cycle_for_user_scope`  (lines 1005–1038)

```
async fn does_not_loop_on_symlink_cycle_for_user_scope()
```

**Purpose**: Checks that the loader does not get stuck when a symlink points back to an ancestor directory. This protects against infinite directory walks.

**Data flow**: The test creates a directory whose child link points back to itself, writes one real skill, loads skills, and expects that one skill with no errors.

**Call relations**: It uses symlink_dir to create the cycle and load_skills_for_test to verify the scanner tracks enough state to avoid looping.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config, symlink_dir, write_skill_at); 4 external calls (assert!, assert_eq!, create_dir_all, tempdir).


##### `loads_skills_via_symlinked_subdir_for_admin_scope`  (lines 1042–1079)

```
async fn loads_skills_via_symlinked_subdir_for_admin_scope()
```

**Purpose**: Checks that admin-scope scanning can follow symlinked subdirectories. Admin roots are trusted enough for this behavior in the loader.

**Data flow**: The test writes a skill in a shared directory, symlinks it under an admin root, loads from that root directly, and expects an admin-scoped skill.

**Call relations**: It calls load_skills_from_roots directly with an admin SkillRoot instead of building config.

*Call graph*: calls 2 internal fn (symlink_dir, write_skill_at); 5 external calls (clone, assert!, assert_eq!, create_dir_all, tempdir).


##### `loads_skills_via_symlinked_subdir_for_repo_scope`  (lines 1083–1119)

```
async fn loads_skills_via_symlinked_subdir_for_repo_scope()
```

**Purpose**: Checks that repo-scope scanning can follow symlinked skill subdirectories. This lets projects link shared skills into their .codex/skills folder.

**Data flow**: The test creates a fake Git repo, writes a skill in a shared directory, symlinks that directory into repo .codex/skills, builds config for the repo, and expects the linked skill as repo-scoped.

**Call relations**: It uses mark_as_git_repo and make_config_for_cwd to trigger repo discovery, then load_skills_for_test to run the normal loader.

*Call graph*: calls 5 internal fn (load_skills_for_test, make_config_for_cwd, mark_as_git_repo, symlink_dir, write_skill_at); 4 external calls (assert!, assert_eq!, create_dir_all, tempdir).


##### `system_scope_ignores_symlinked_subdir`  (lines 1123–1147)

```
async fn system_scope_ignores_symlinked_subdir()
```

**Purpose**: Checks that system-scope scanning does not follow symlinked subdirectories. This is a stricter safety rule for cached system skills.

**Data flow**: The test writes a skill in a shared directory, symlinks it under the system root, loads from that root as system scope, and expects zero skills.

**Call relations**: It calls load_skills_from_roots directly with a system SkillRoot to isolate the system symlink rule.

*Call graph*: calls 2 internal fn (symlink_dir, write_skill_at); 5 external calls (clone, assert!, assert_eq!, create_dir_all, tempdir).


##### `respects_max_scan_depth_for_user_scope`  (lines 1150–1195)

```
async fn respects_max_scan_depth_for_user_scope()
```

**Purpose**: Checks that user skill scanning stops at the configured maximum directory depth. This keeps scanning predictable and avoids expensive deep walks.

**Data flow**: The test writes one skill at the deepest allowed level and one just below it, loads from the user skills root, and expects only the within-depth skill.

**Call relations**: It uses write_skill to create both fixtures and calls load_skills_from_roots directly with a user root.

*Call graph*: calls 1 internal fn (write_skill); 4 external calls (clone, assert!, assert_eq!, tempdir).


##### `loads_valid_skill`  (lines 1198–1223)

```
async fn loads_valid_skill()
```

**Purpose**: Checks the basic success case: a valid SKILLS.md file becomes one SkillMetadata record. It also verifies that multiline descriptions are normalized into readable text.

**Data flow**: The test writes a normal skill, builds fake config, loads skills, and expects the name, cleaned description, path, and user scope to match.

**Call relations**: This is the simplest end-to-end test through write_skill, make_config, and load_skills_for_test.

*Call graph*: calls 3 internal fn (load_skills_for_test, make_config, write_skill); 3 external calls (assert!, assert_eq!, tempdir).


##### `falls_back_to_directory_name_when_skill_name_is_missing`  (lines 1226–1256)

```
async fn falls_back_to_directory_name_when_skill_name_is_missing()
```

**Purpose**: Checks that a skill can still load when its name is missing, using the containing directory name instead. This gives a reasonable fallback for incomplete front matter.

**Data flow**: The test writes raw front matter with only a description, loads skills, and expects the skill name to be the directory name.

**Call relations**: It uses write_raw_skill_at because the normal helper always writes a name.

*Call graph*: calls 3 internal fn (load_skills_for_test, make_config, write_raw_skill_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `namespaces_plugin_skills_using_plugin_name`  (lines 1259–1302)

```
async fn namespaces_plugin_skills_using_plugin_name()
```

**Purpose**: Checks that plugin skills are named with the plugin name as a prefix. This avoids name collisions between plugin-provided skills and other skills.

**Data flow**: The test writes a plugin.json with name sample, writes a skill without an explicit name, loads the plugin skill root, and expects the loaded name to be sample:sample-search.

**Call relations**: It calls load_skills_from_roots directly with plugin_id and plugin_root so the loader applies plugin naming rules.

*Call graph*: calls 1 internal fn (write_raw_skill_at); 6 external calls (clone, assert!, assert_eq!, create_dir_all, write, tempdir).


##### `plugin_skill_name_length_limit_allows_max_qualified_name`  (lines 1305–1347)

```
async fn plugin_skill_name_length_limit_allows_max_qualified_name()
```

**Purpose**: Checks the boundary where a plugin-qualified skill name is as long as allowed and should still load. Qualified means plugin name plus colon plus skill name.

**Data flow**: The test creates a plugin name and skill name at the maximum accepted sizes, writes plugin metadata and a skill, loads the plugin root, and expects the combined name to appear.

**Call relations**: It uses write_raw_skill_at for controlled name lengths and load_skills_from_roots for plugin-aware loading.

*Call graph*: calls 1 internal fn (write_raw_skill_at); 7 external calls (clone, assert!, assert_eq!, format!, create_dir_all, write, tempdir).


##### `plugin_skill_name_length_limit_rejects_overlong_qualified_name`  (lines 1350–1380)

```
async fn plugin_skill_name_length_limit_rejects_overlong_qualified_name()
```

**Purpose**: Checks that an overlong plugin-qualified name is rejected. This enforces the loader’s name-size limits even after plugin prefixing.

**Data flow**: The test writes a plugin and skill whose combined name is too long, loads the plugin root, and expects no skills plus one error mentioning an invalid qualified name.

**Call relations**: It is the failure-case partner to the max-length plugin-name test.

*Call graph*: calls 1 internal fn (write_raw_skill_at); 7 external calls (clone, assert!, assert_eq!, format!, create_dir_all, write, tempdir).


##### `loads_short_description_from_metadata`  (lines 1383–1412)

```
async fn loads_short_description_from_metadata()
```

**Purpose**: Checks that a short summary can be read from front matter metadata. This gives user interfaces a compact description separate from the longer description.

**Data flow**: The test writes a skill whose front matter includes metadata.short-description, loads skills, and expects short_description to contain that summary.

**Call relations**: It creates the file manually instead of using helpers because the short-description field is nested in custom front matter.

*Call graph*: calls 2 internal fn (load_skills_for_test, make_config); 5 external calls (assert!, assert_eq!, create_dir_all, write, tempdir).


##### `enforces_short_description_length_limits`  (lines 1415–1436)

```
async fn enforces_short_description_length_limits()
```

**Purpose**: Checks that an overlong short description causes the skill to be rejected. This prevents UI summary fields from growing beyond their intended size.

**Data flow**: The test writes a skill with a short-description one character over the limit, loads skills, and expects zero skills plus one validation error.

**Call relations**: It uses make_config and load_skills_for_test to exercise the same validation used in normal loading.

*Call graph*: calls 2 internal fn (load_skills_for_test, make_config); 6 external calls (assert!, assert_eq!, format!, create_dir_all, write, tempdir).


##### `skips_hidden_and_invalid`  (lines 1439–1464)

```
async fn skips_hidden_and_invalid()
```

**Purpose**: Checks that hidden skill directories are skipped and malformed skill files report errors. Hidden folders start with a dot and should not be scanned as normal skills.

**Data flow**: The test creates a hidden valid-looking skill and a visible invalid skill missing closing front matter. Loading returns no skills and one error for the malformed visible file.

**Call relations**: It uses direct file writes to create special cases, then load_skills_for_test to confirm scanner and parser behavior together.

*Call graph*: calls 2 internal fn (load_skills_for_test, make_config); 5 external calls (assert!, assert_eq!, create_dir_all, write, tempdir).


##### `enforces_length_limits`  (lines 1467–1490)

```
async fn enforces_length_limits()
```

**Purpose**: Checks the length limit for skill descriptions, including Unicode characters. It confirms the maximum is accepted and one character beyond it is rejected.

**Data flow**: The test first writes a max-length description and expects it to load. Then it writes another skill with an overlong description, reloads, and expects only the valid skill plus one error.

**Call relations**: It uses write_skill for both cases and load_skills_for_test for repeated validation.

*Call graph*: calls 3 internal fn (load_skills_for_test, make_config, write_skill); 3 external calls (assert!, assert_eq!, tempdir).


##### `loads_skills_from_repo_root`  (lines 1493–1525)

```
async fn loads_skills_from_repo_root()
```

**Purpose**: Checks that skills in a repo’s .codex/skills folder are discovered. This is the main project-local skill behavior.

**Data flow**: The test marks a temp directory as a Git repo, writes a skill under .codex/skills, builds config for that repo, loads skills, and expects a repo-scoped skill.

**Call relations**: It uses mark_as_git_repo and make_config_for_cwd so project_layers_for_cwd includes the repo .codex layer.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config_for_cwd, mark_as_git_repo, write_skill_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `loads_skills_from_agents_dir_without_codex_dir`  (lines 1528–1561)

```
async fn loads_skills_from_agents_dir_without_codex_dir()
```

**Purpose**: Checks that repo skills can also come from .agents/skills even when there is no .codex directory. This supports another project skill location.

**Data flow**: The test creates a fake Git repo, writes a skill under .agents/skills, loads through fake config, and expects a repo-scoped skill.

**Call relations**: It relies on make_config_for_cwd and load_skills_for_test to exercise repo root discovery plus agents-folder discovery.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config_for_cwd, mark_as_git_repo, write_skill_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `loads_skills_from_all_codex_dirs_under_project_root`  (lines 1564–1627)

```
async fn loads_skills_from_all_codex_dirs_under_project_root()
```

**Purpose**: Checks that nested .codex/skills folders between the repo root and current directory are included. This lets subprojects add their own skills.

**Data flow**: The test creates a repo with both root and nested .codex/skills folders, sets the current directory inside the nested area, loads skills, and expects both repo-scoped skills.

**Call relations**: project_layers_for_cwd is indirectly tested here because make_config_for_cwd must include both project layers.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config_for_cwd, mark_as_git_repo, write_skill_at); 4 external calls (assert!, assert_eq!, create_dir_all, tempdir).


##### `loads_skills_from_codex_dir_when_not_git_repo`  (lines 1630–1666)

```
async fn loads_skills_from_codex_dir_when_not_git_repo()
```

**Purpose**: Checks behavior outside Git: a .codex/skills folder in the current directory can still provide repo-scoped skills. This supports local work directories that are not repositories.

**Data flow**: The test writes a skill under the current directory’s .codex/skills, builds config for that directory without a .git marker, loads skills, and expects the skill.

**Call relations**: It uses make_config_for_cwd without mark_as_git_repo to verify the non-Git branch of project layer discovery.

*Call graph*: calls 3 internal fn (load_skills_for_test, make_config_for_cwd, write_skill_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `deduplicates_by_path_preferring_first_root`  (lines 1669–1711)

```
async fn deduplicates_by_path_preferring_first_root()
```

**Purpose**: Checks that if the same skill file is reachable through multiple roots, it is loaded only once. The first root decides the scope.

**Data flow**: The test writes one skill, loads the same root twice with different scopes, and expects one skill with the scope from the first root.

**Call relations**: It calls load_skills_from_roots directly so the duplicate-root behavior is isolated from config discovery.

*Call graph*: calls 1 internal fn (write_skill_at); 4 external calls (clone, assert!, assert_eq!, tempdir).


##### `keeps_duplicate_names_from_repo_and_user`  (lines 1714–1765)

```
async fn keeps_duplicate_names_from_repo_and_user()
```

**Purpose**: Checks that two different skill files may have the same name when they come from repo and user scopes. Duplicate names are not automatically removed.

**Data flow**: The test writes a user skill and a repo skill with the same name, loads skills for the repo, and expects both records with their different descriptions and scopes.

**Call relations**: It combines write_skill, write_skill_at, mark_as_git_repo, and load_skills_for_test to test normal mixed-scope loading.

*Call graph*: calls 5 internal fn (load_skills_for_test, make_config_for_cwd, mark_as_git_repo, write_skill, write_skill_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `keeps_duplicate_names_from_nested_codex_dirs`  (lines 1768–1839)

```
async fn keeps_duplicate_names_from_nested_codex_dirs()
```

**Purpose**: Checks that duplicate skill names from different nested project folders are both kept. The loader deduplicates by path, not by name.

**Data flow**: The test writes same-named skills in root and nested .codex folders, loads from inside the nested area, sorts expectations by normalized path order, and expects both skills.

**Call relations**: It indirectly tests project layer discovery through make_config_for_cwd and path-based ordering through normalized.

*Call graph*: calls 5 internal fn (load_skills_for_test, make_config_for_cwd, mark_as_git_repo, normalized, write_skill_at); 4 external calls (assert!, assert_eq!, create_dir_all, tempdir).


##### `repo_skills_search_does_not_escape_repo_root`  (lines 1842–1868)

```
async fn repo_skills_search_does_not_escape_repo_root()
```

**Purpose**: Checks that repo skill discovery does not walk above the Git repository root. This prevents unrelated parent directories from contributing skills.

**Data flow**: The test writes a skill in an outer directory’s .codex/skills, makes a child directory the Git repo, loads from the repo, and expects no skills.

**Call relations**: It uses mark_as_git_repo to set the boundary that project_layers_for_cwd must not cross.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config_for_cwd, mark_as_git_repo, write_skill_at); 4 external calls (assert!, assert_eq!, create_dir_all, tempdir).


##### `loads_skills_when_cwd_is_file_in_repo`  (lines 1871–1910)

```
async fn loads_skills_when_cwd_is_file_in_repo()
```

**Purpose**: Checks that repo skills still load when the current working path is a file inside the repo rather than a directory. This matches cases where a command is run against a file path.

**Data flow**: The test writes a repo skill, creates a normal file in the repo, builds config using that file path as cwd, loads skills, and expects the repo skill.

**Call relations**: project_layers_for_cwd handles the file path by using its parent directory; this test verifies that path through make_config_for_cwd.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config_for_cwd, mark_as_git_repo, write_skill_at); 4 external calls (assert!, assert_eq!, write, tempdir).


##### `non_git_repo_skills_search_does_not_walk_parents`  (lines 1913–1938)

```
async fn non_git_repo_skills_search_does_not_walk_parents()
```

**Purpose**: Checks that outside Git, skill discovery does not search parent directories above the current work directory. This keeps non-repo behavior local.

**Data flow**: The test writes a .codex/skills folder in an outer directory, sets cwd to a nested directory without a Git root, loads skills, and expects none.

**Call relations**: It uses make_config_for_cwd without a .git marker to verify the non-Git search boundary.

*Call graph*: calls 3 internal fn (load_skills_for_test, make_config_for_cwd, write_skill_at); 4 external calls (assert!, assert_eq!, create_dir_all, tempdir).


##### `loads_skills_from_system_cache_when_present`  (lines 1941–1969)

```
async fn loads_skills_from_system_cache_when_present()
```

**Purpose**: Checks that cached system skills under the user Codex home are loaded with system scope. These are separate from normal user-authored skills.

**Data flow**: The test writes a skill under skills/.system, builds config for an unrelated work directory, loads skills, and expects one system-scoped SkillMetadata record.

**Call relations**: It uses write_system_skill for setup and load_skills_for_test to run the normal root derivation that includes the system cache.

*Call graph*: calls 3 internal fn (load_skills_for_test, make_config_for_cwd, write_system_skill); 3 external calls (assert!, assert_eq!, tempdir).


##### `skill_roots_include_admin_with_lowest_priority`  (lines 1972–1993)

```
async fn skill_roots_include_admin_with_lowest_priority()
```

**Purpose**: Checks that admin skill roots are included after user and system roots. Lowest priority here means admin roots are searched later in the returned order.

**Data flow**: The test builds fake config, calls skill_roots, extracts only the scopes, builds the expected scope order, and compares the two lists.

**Call relations**: It calls skill_roots directly rather than loading skill files, focusing only on root ordering and priority.

*Call graph*: calls 1 internal fn (make_config); 6 external calls (clone, new, assert_eq!, skill_roots, tempdir, vec!).


### `core-skills/src/manager_tests.rs`

`test` · `test run`

A “skill” here is a folder containing a SKILL.md file with small metadata at the top. The skills manager has to gather these from several places: the user’s Codex home, the current project’s .codex folder, plugin caches, bundled system skills, and extra roots added while the program is running. This test file builds tiny fake skill folders in temporary directories, feeds fake configuration layers to the manager, and checks the result.

The main things being tested are cache behavior and configuration precedence. Cache behavior matters because loading skills from disk can be expensive, but stale cache entries can hide newly added skills unless a reload is requested. Configuration precedence matters because settings can come from several layers, like a user config file and session flags. Later, more specific layers should be able to override earlier ones, like a temporary instruction overriding a saved preference.

The tests also check plugin skill naming, disabled bundled skills, project skills that require a filesystem object, and extra runtime roots that can be replaced or cleared. Without these tests, a user could see disabled skills, miss enabled ones, accidentally use stale data, or get different behavior depending on where a skill came from.

#### Function details

##### `write_user_skill`  (lines 23–28)

```
fn write_user_skill(codex_home: &TempDir, dir: &str, name: &str, description: &str)
```

**Purpose**: Creates a small fake user skill on disk for tests. It is used when a test needs the skills manager to discover a normal user-installed skill.

**Data flow**: It takes a temporary Codex home folder, a skill subfolder name, a skill name, and a description. It creates the needed directory under skills/, writes a SKILL.md file with that metadata, and returns nothing; the visible result is the new file on disk.

**Call relations**: Several cache and loading tests call this helper before asking the skills manager to scan. It gives those tests realistic input without repeating the same folder-and-file setup each time.

*Call graph*: called by 4 (skills_for_config_reuses_cache_for_same_effective_config, skills_for_cwd_loads_repo_and_user_roots_with_local_fs, skills_for_cwd_uses_cached_result_until_force_reload, skills_for_cwd_without_fs_skips_repo_roots); 4 external calls (path, format!, create_dir_all, write).


##### `write_plugin_skill`  (lines 30–56)

```
fn write_plugin_skill(
    codex_home: &TempDir,
    marketplace: &str,
    plugin_name: &str,
    dir: &str,
    name: &str,
    description: &str,
) -> PathBuf
```

**Purpose**: Creates a fake plugin-owned skill in the same folder shape that cached plugins use. It lets tests check plugin skill discovery and plugin-specific disable rules.

**Data flow**: It receives a temporary Codex home, marketplace name, plugin name, skill folder name, skill name, and description. It builds a plugin cache folder, writes plugin.json, writes the skill’s SKILL.md, and returns the path to that SKILL.md file.

**Call relations**: The plugin-disabling test calls this first, then builds a plugin root from the returned path. The skills manager later reads that fake plugin root as if it came from a real installed plugin.

*Call graph*: called by 1 (skills_for_config_disables_plugin_skills_by_name); 4 external calls (path, format!, create_dir_all, write).


##### `plugin_skill_root_for_skill_path`  (lines 58–71)

```
fn plugin_skill_root_for_skill_path(skill_path: &Path, plugin_id: &str) -> PluginSkillRoot
```

**Purpose**: Builds the plugin root description needed by the skills manager from the path of one plugin skill. This saves tests from manually reconstructing the plugin folder layout.

**Data flow**: It takes the path to a plugin skill’s SKILL.md and a plugin identifier. It walks upward to find the skills root and plugin root, converts those paths to absolute paths, and returns a PluginSkillRoot value.

**Call relations**: The plugin skill test uses this after creating a fake plugin skill. The returned root is passed into the skills loading helper so plugin skills are included in the scan.

*Call graph*: called by 1 (skills_for_config_disables_plugin_skills_by_name); 1 external calls (parent).


##### `test_skill`  (lines 73–88)

```
fn test_skill(name: &str, path: PathBuf) -> SkillMetadata
```

**Purpose**: Creates an in-memory SkillMetadata value for tests that only need to check configuration rules, not full disk scanning. It represents a user skill with a known name and path.

**Data flow**: It receives a skill name and a path. It canonicalizes the path, fills in simple metadata fields, marks the skill as a user skill, and returns the completed SkillMetadata object.

**Call relations**: The disabled-paths tests use this after writing a demo skill. They then pass the metadata into the configuration-rule resolver to see whether that skill should be considered disabled.

*Call graph*: called by 4 (disabled_paths_for_skills_allows_name_selector_to_override_path_selector, disabled_paths_for_skills_allows_session_flags_to_disable_user_enabled_skill, disabled_paths_for_skills_allows_session_flags_to_override_user_layer, disabled_paths_for_skills_disables_matching_name_selectors); 1 external calls (abs).


##### `write_demo_skill`  (lines 90–100)

```
fn write_demo_skill(tempdir: &TempDir) -> PathBuf
```

**Purpose**: Writes one standard demo skill to a temporary directory. It is a compact setup helper for tests about enabling and disabling skills by path or name.

**Data flow**: It takes a temporary directory, creates skills/demo/SKILL.md inside it, writes fixed demo metadata, and returns the SKILL.md path.

**Call relations**: The selector and override tests call this before building SkillMetadata with test_skill. This gives those tests a real path to use in path-based configuration rules.

*Call graph*: called by 4 (disabled_paths_for_skills_allows_name_selector_to_override_path_selector, disabled_paths_for_skills_allows_session_flags_to_disable_user_enabled_skill, disabled_paths_for_skills_allows_session_flags_to_override_user_layer, disabled_paths_for_skills_disables_matching_name_selectors); 3 external calls (path, create_dir_all, write).


##### `user_config_layer`  (lines 102–112)

```
fn user_config_layer(codex_home: &TempDir, config_toml: &str) -> ConfigLayerEntry
```

**Purpose**: Turns a TOML text snippet into a user configuration layer. A configuration layer is one source of settings, such as a user config file.

**Data flow**: It takes a temporary Codex home and TOML text. It builds the expected config.toml path, parses the TOML, wraps both in a ConfigLayerEntry, and returns that entry.

**Call relations**: This helper is used by the stack-building helpers and by tests that need custom layer combinations. It provides the “user settings” base that later layers can override.

*Call graph*: calls 2 internal fn (new, try_from); 2 external calls (path, from_str).


##### `config_stack`  (lines 114–121)

```
fn config_stack(codex_home: &TempDir, user_config_toml: &str) -> ConfigLayerStack
```

**Purpose**: Builds a complete configuration stack containing only a user config layer. Tests use it when they do not need session flags or project-specific settings.

**Data flow**: It takes a temporary Codex home and user TOML text. It creates a user layer, combines it with default requirements, validates the stack, and returns the ConfigLayerStack.

**Call relations**: Most skills-manager tests call this to create the configuration passed into loading. It keeps the tests focused on skill behavior rather than config setup details.

*Call graph*: calls 1 internal fn (new); called by 7 (set_extra_roots_applies_to_config_loads_and_empty_clears, set_extra_roots_replaces_runtime_roots_and_clears_cache, skills_for_config_disables_plugin_skills_by_name, skills_for_config_excludes_bundled_skills_when_disabled_in_config, skills_for_config_ignores_cwd_cache_when_session_flags_reenable_skill, skills_for_config_reuses_cache_for_same_effective_config, skills_for_cwd_uses_cached_result_until_force_reload); 3 external calls (default, default, vec!).


##### `config_stack_with_session_flags`  (lines 123–140)

```
fn config_stack_with_session_flags(
    codex_home: &TempDir,
    user_config_toml: &str,
    session_flags_toml: &str,
) -> ConfigLayerStack
```

**Purpose**: Builds a configuration stack where session flags sit on top of user settings. This is used to test that temporary session choices can override saved user preferences.

**Data flow**: It receives a Codex home, user TOML text, and session-flags TOML text. It parses both layers, places them in order, validates the stack, and returns it.

**Call relations**: The cache-and-reenable test uses this to create a child configuration that differs from an already cached parent configuration. That verifies the manager does not reuse the wrong disabled-state result.

*Call graph*: calls 1 internal fn (new); called by 1 (skills_for_config_ignores_cwd_cache_when_session_flags_reenable_skill); 3 external calls (default, default, vec!).


##### `path_toggle_config`  (lines 142–150)

```
fn path_toggle_config(path: &std::path::Path, enabled: bool) -> String
```

**Purpose**: Creates a small TOML configuration snippet that enables or disables a skill by its file path. This keeps path-based config tests easy to read.

**Data flow**: It takes a path and a true-or-false enabled value. It formats them into a [[skills.config]] TOML block and returns the text.

**Call relations**: Several override tests call this to make user or session rules. Those snippets are then parsed into configuration layers and resolved against real skill paths.

*Call graph*: called by 4 (disabled_paths_for_skills_allows_name_selector_to_override_path_selector, disabled_paths_for_skills_allows_session_flags_to_disable_user_enabled_skill, disabled_paths_for_skills_allows_session_flags_to_override_user_layer, skills_for_config_ignores_cwd_cache_when_session_flags_reenable_skill); 1 external calls (format!).


##### `name_toggle_config`  (lines 152–159)

```
fn name_toggle_config(name: &str, enabled: bool) -> String
```

**Purpose**: Creates a small TOML configuration snippet that enables or disables a skill by name. This is used for tests where the selector is the skill’s public name rather than its file path.

**Data flow**: It takes a skill name and a true-or-false enabled value. It returns TOML text describing that name-based rule.

**Call relations**: Name-selector tests and the plugin-disable test use this helper. The resulting config lets the tests check whether a named skill is correctly marked disabled or re-enabled.

*Call graph*: called by 3 (disabled_paths_for_skills_allows_name_selector_to_override_path_selector, disabled_paths_for_skills_disables_matching_name_selectors, skills_for_config_disables_plugin_skills_by_name); 1 external calls (format!).


##### `skills_for_config_with_stack`  (lines 161–176)

```
async fn skills_for_config_with_stack(
    skills_manager: &SkillsManager,
    cwd: &TempDir,
    config_layer_stack: &ConfigLayerStack,
    effective_skill_roots: &[PluginSkillRoot],
) -> SkillLoadOu
```

**Purpose**: Loads skills through the same configuration-aware path that production code uses, but with test-friendly inputs. It avoids repeating the boilerplate needed to create SkillsLoadInput.

**Data flow**: It takes a skills manager, current working directory, configuration stack, and plugin skill roots. It builds a SkillsLoadInput, includes the effective bundled-skills setting, calls skills_for_config with the local filesystem, and returns the load outcome.

**Call relations**: Many async tests call this helper after setting up files and config. It hands off to SkillsManager::skills_for_config, so the tests exercise the real loading and filtering behavior.

*Call graph*: calls 2 internal fn (new, skills_for_config); called by 6 (set_extra_roots_applies_to_config_loads_and_empty_clears, skills_for_config_disables_plugin_skills_by_name, skills_for_config_excludes_bundled_skills_when_disabled_in_config, skills_for_config_ignores_cwd_cache_when_session_flags_reenable_skill, skills_for_config_reuses_cache_for_same_effective_config, skills_for_cwd_uses_cached_result_until_force_reload); 4 external calls (clone, path, clone, to_vec).


##### `new_with_disabled_bundled_skills_removes_stale_cached_system_skills`  (lines 179–195)

```
fn new_with_disabled_bundled_skills_removes_stale_cached_system_skills()
```

**Purpose**: Checks that starting the skills manager with bundled system skills disabled removes an old cached system-skills folder. This prevents disabled built-in skills from lingering on disk and being picked up later.

**Data flow**: The test creates a fake stale system skill under skills/.system, constructs the skills manager with bundled skills disabled, and then checks that the .system folder no longer exists.

**Call relations**: This is a direct test of SkillsManager::new. It sets up the stale folder itself, calls the constructor, and verifies the constructor’s cleanup side effect.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert!, create_dir_all, write, tempdir).


##### `skills_for_config_reuses_cache_for_same_effective_config`  (lines 198–222)

```
async fn skills_for_config_reuses_cache_for_same_effective_config()
```

**Purpose**: Verifies that configuration-based loading reuses a cached result when the effective configuration has not changed. This protects performance and defines that newly added files are not seen until the cache is invalidated.

**Data flow**: The test creates one user skill and loads skills. Then it writes a second skill but calls the same load again with the same configuration. The second outcome should match the first, including not showing the new skill.

**Call relations**: It uses config_stack, write_user_skill, and skills_for_config_with_stack. The important handoff is to SkillsManager::skills_for_config, which should return the cached outcome on the second call.

*Call graph*: calls 4 internal fn (new, config_stack, skills_for_config_with_stack, write_user_skill); 3 external calls (assert!, assert_eq!, tempdir).


##### `set_extra_roots_replaces_runtime_roots_and_clears_cache`  (lines 225–294)

```
async fn set_extra_roots_replaces_runtime_roots_and_clears_cache()
```

**Purpose**: Checks that runtime-added skill roots replace earlier runtime roots and clear cached results. This matters when a running session changes where it should look for skills.

**Data flow**: The test first loads skills with no extra root and confirms a runtime skill is absent. It then writes a skill in an extra root, sets that root, reloads, and sees the skill. Finally it replaces the extra root with a missing one and confirms the old runtime skill disappears without errors.

**Call relations**: It builds a SkillsLoadInput and calls SkillsManager::skills_for_cwd around calls to SkillsManager::set_extra_roots. The story is: load baseline, change roots, observe cache invalidation, replace roots, observe removal.

*Call graph*: calls 3 internal fn (new, new, config_stack); 8 external calls (clone, new, assert!, assert_eq!, create_dir_all, write, tempdir, vec!).


##### `set_extra_roots_applies_to_config_loads_and_empty_clears`  (lines 297–344)

```
async fn set_extra_roots_applies_to_config_loads_and_empty_clears()
```

**Purpose**: Checks that extra runtime roots also affect configuration-aware loading, not only current-directory loading. It also verifies that setting an empty list clears those runtime roots.

**Data flow**: The test loads once with no runtime skill, writes a runtime skill in an extra root, sets that root, and loads again to see the skill. Then it clears extra roots and confirms the skill is no longer included.

**Call relations**: It uses config_stack and skills_for_config_with_stack around calls to set_extra_roots. This proves the config-based loading path honors the same runtime-root state as the cwd-based path.

*Call graph*: calls 3 internal fn (new, config_stack, skills_for_config_with_stack); 6 external calls (new, assert!, create_dir_all, write, tempdir, vec!).


##### `skills_for_config_disables_plugin_skills_by_name`  (lines 347–392)

```
async fn skills_for_config_disables_plugin_skills_by_name()
```

**Purpose**: Verifies that a plugin skill can be disabled by its full name. This is important because plugin skills may be identified with a plugin prefix rather than only by their folder path.

**Data flow**: The test writes a fake plugin skill, creates config that disables its plugin-qualified name, builds the plugin root, and loads skills. The skill is still discovered, but its path appears in the disabled set and it is excluded from implicit invocation.

**Call relations**: It combines write_plugin_skill, name_toggle_config, plugin_skill_root_for_skill_path, and skills_for_config_with_stack. The manager does the real discovery; the assertions check that discovery and disabling are separate steps.

*Call graph*: calls 6 internal fn (new, config_stack, name_toggle_config, plugin_skill_root_for_skill_path, skills_for_config_with_stack, write_plugin_skill); 4 external calls (assert!, assert_eq!, canonicalize, tempdir).


##### `skills_for_cwd_loads_repo_and_user_roots_with_local_fs`  (lines 395–455)

```
async fn skills_for_cwd_loads_repo_and_user_roots_with_local_fs()
```

**Purpose**: Checks that current-directory loading includes both user skills and project repository skills when a filesystem object is available. Project skills live under the project’s .codex folder.

**Data flow**: The test writes one user skill and one project skill, builds a config stack with user and project layers, and calls skills_for_cwd with the local filesystem. The output should contain both skill names and no errors.

**Call relations**: It uses write_user_skill for the user root, manually writes the repo skill, then hands a full SkillsLoadInput to SkillsManager::skills_for_cwd. The local filesystem is what lets the manager inspect the project root.

*Call graph*: calls 4 internal fn (new, new, new, write_user_skill); 9 external calls (clone, default, new, assert!, default, create_dir_all, write, tempdir, vec!).


##### `skills_for_cwd_without_fs_skips_repo_roots`  (lines 458–514)

```
async fn skills_for_cwd_without_fs_skips_repo_roots()
```

**Purpose**: Checks that project repository skills are skipped when no filesystem object is supplied, while user skills still load. This makes the behavior explicit for environments where project filesystem access is not available.

**Data flow**: The test writes the same kind of user and repo skills as the previous test, but calls skills_for_cwd with no filesystem. The result should include the user skill, exclude the repo skill, and report no errors.

**Call relations**: It mirrors the local-filesystem test but changes the final handoff to SkillsManager::skills_for_cwd by passing no filesystem. The contrast shows which roots depend on filesystem access.

*Call graph*: calls 4 internal fn (new, new, new, write_user_skill); 8 external calls (default, new, assert!, default, create_dir_all, write, tempdir, vec!).


##### `skills_for_config_excludes_bundled_skills_when_disabled_in_config`  (lines 517–556)

```
async fn skills_for_config_excludes_bundled_skills_when_disabled_in_config()
```

**Purpose**: Verifies that bundled system skills are not loaded when configuration disables them. This prevents built-in skills from appearing when the user or session has turned that feature off.

**Data flow**: The test writes a fake bundled skill under skills/.system, creates config with skills.bundled.enabled set to false, constructs the manager with bundled skills disabled, recreates the fake folder to avoid relying only on cleanup, then loads skills. The result should contain no bundled skill and no system-scoped skills.

**Call relations**: It uses config_stack and skills_for_config_with_stack to exercise the normal config-aware root selection. The test deliberately recreates the folder after manager startup so the assertion proves the loader excluded the root, not just that cleanup deleted files.

*Call graph*: calls 3 internal fn (new, config_stack, skills_for_config_with_stack); 4 external calls (assert!, create_dir_all, write, tempdir).


##### `skills_for_cwd_uses_cached_result_until_force_reload`  (lines 559–617)

```
async fn skills_for_cwd_uses_cached_result_until_force_reload()
```

**Purpose**: Checks that current-directory loading uses its cached result unless force_reload is true. This defines when newly added skills become visible.

**Data flow**: The test warms the cache, confirms a late skill is absent, writes that new skill, and loads again without forcing reload. The skill remains absent. It then loads with force_reload set and the skill appears.

**Call relations**: It uses config_stack, skills_for_config_with_stack, write_user_skill, and direct calls to SkillsManager::skills_for_cwd. The final forced call is the point where the manager must bypass its cache.

*Call graph*: calls 5 internal fn (new, new, config_stack, skills_for_config_with_stack, write_user_skill); 4 external calls (clone, new, assert!, tempdir).


##### `disabled_paths_for_skills_allows_session_flags_to_override_user_layer`  (lines 621–652)

```
fn disabled_paths_for_skills_allows_session_flags_to_override_user_layer()
```

**Purpose**: Checks that session flags can re-enable a skill that the user config disabled by path. Session flags are temporary settings for the current run, and they should win over saved config.

**Data flow**: The test writes a demo skill, makes a user layer that disables its path, makes a session layer that enables the same path, resolves the config rules, and expects no disabled paths.

**Call relations**: It uses write_demo_skill, test_skill, path_toggle_config, and skill_config_rules_from_stack before calling resolve_disabled_skill_paths. The test focuses on rule precedence, not full skill loading.

*Call graph*: calls 7 internal fn (new, new, skill_config_rules_from_stack, path_toggle_config, test_skill, write_demo_skill, try_from); 6 external calls (default, assert_eq!, default, tempdir, from_str, vec!).


##### `disabled_paths_for_skills_allows_session_flags_to_disable_user_enabled_skill`  (lines 656–690)

```
fn disabled_paths_for_skills_allows_session_flags_to_disable_user_enabled_skill()
```

**Purpose**: Checks the opposite override: session flags can disable a skill that user config enabled by path. This confirms the top layer wins in both directions.

**Data flow**: The test writes a demo skill, creates a user layer enabling its path, creates a session layer disabling that path, resolves the rules, and expects the skill’s canonical path in the disabled set.

**Call relations**: It follows the same helper flow as the previous override test, then calls resolve_disabled_skill_paths. Together the pair proves session flags are not just additive; they can change the final decision either way.

*Call graph*: calls 7 internal fn (new, new, skill_config_rules_from_stack, path_toggle_config, test_skill, write_demo_skill, try_from); 6 external calls (default, assert_eq!, default, tempdir, from_str, vec!).


##### `disabled_paths_for_skills_disables_matching_name_selectors`  (lines 694–723)

```
fn disabled_paths_for_skills_disables_matching_name_selectors()
```

**Purpose**: Checks that a name-based rule disables the skill with the matching name. This supports users disabling a skill without knowing its exact file path.

**Data flow**: The test writes a demo skill, gives its metadata the name github:yeet, creates config disabling that name, resolves the rules, and expects the skill’s path to be disabled.

**Call relations**: It uses write_demo_skill, test_skill, name_toggle_config, skill_config_rules_from_stack, and resolve_disabled_skill_paths. This isolates the name selector behavior from the full loader.

*Call graph*: calls 7 internal fn (new, new, skill_config_rules_from_stack, name_toggle_config, test_skill, write_demo_skill, try_from); 6 external calls (default, assert_eq!, default, tempdir, from_str, vec!).


##### `disabled_paths_for_skills_allows_name_selector_to_override_path_selector`  (lines 727–758)

```
fn disabled_paths_for_skills_allows_name_selector_to_override_path_selector()
```

**Purpose**: Checks that a later name-based enable rule can override an earlier path-based disable rule. This matters when different configuration layers refer to the same skill in different ways.

**Data flow**: The test writes a demo skill, creates a user layer disabling it by path, creates a session layer enabling it by name, resolves the rules, and expects no disabled paths.

**Call relations**: It combines both path_toggle_config and name_toggle_config, then feeds the resulting stack through skill_config_rules_from_stack and resolve_disabled_skill_paths. The test confirms that selector type does not block normal layer precedence.

*Call graph*: calls 8 internal fn (new, new, skill_config_rules_from_stack, name_toggle_config, path_toggle_config, test_skill, write_demo_skill, try_from); 6 external calls (default, assert_eq!, default, tempdir, from_str, vec!).


##### `skills_for_config_ignores_cwd_cache_when_session_flags_reenable_skill`  (lines 762–811)

```
async fn skills_for_config_ignores_cwd_cache_when_session_flags_reenable_skill()
```

**Purpose**: Verifies that a cached current-directory result does not incorrectly decide the enabled state for a different configuration stack. This prevents a parent session’s disabled setting from leaking into a child session that re-enables the skill.

**Data flow**: The test writes one skill, creates a parent stack that disables it by path, and loads through skills_for_cwd to cache that result. It then creates a child stack with session flags that enable the same path, loads through the config-aware helper, and checks the skill is enabled in the child outcome.

**Call relations**: It uses config_stack, config_stack_with_session_flags, path_toggle_config, and skills_for_config_with_stack, plus a direct call to SkillsManager::skills_for_cwd. The sequence proves the config-aware path keys its cache by effective config instead of blindly reusing the cwd cache.

*Call graph*: calls 6 internal fn (new, new, config_stack, config_stack_with_session_flags, path_toggle_config, skills_for_config_with_stack); 6 external calls (clone, new, assert_eq!, create_dir_all, write, tempdir).


### `ext/skills/tests/executor_file_system_authority.rs`

`test` · `test execution`

This is a test file for skill loading. A “skill” here is a folder containing a SKILL.md file, which describes a capability the system can offer. The important question tested here is authority: when a skill comes from an executor environment, the code must use that executor’s file system view. It must not quietly fall back to the host computer’s file system, because that could read the wrong files or bypass sandbox rules.

To make that visible, the file defines SyntheticFileSystem, a tiny fake file system. It pretends there is a skill at a canonical path, even though no matching real folders exist on disk. It can list one directory, read one SKILL.md file, and report metadata for those virtual paths. Everything else fails, and all writing is rejected. Like a stage set, it only has the doors and rooms needed for the test.

The first test loads a skill from an alias path and proves the loader asks the supplied fake file system to canonicalize, list, and read it. The second test uses a real temporary skill folder, but registers it twice under different selected root IDs. It verifies the displayed skill URLs keep those IDs separate, even when the underlying executor path is identical.

#### Function details

##### `SyntheticFileSystem::metadata`  (lines 75–93)

```
fn metadata(&self, path: &AbsolutePathBuf) -> io::Result<FileMetadata>
```

**Purpose**: This reports whether one of the fake paths is a directory or a file. It is the fake file system’s answer to the question “does this path exist, and what kind of thing is it?”

**Data flow**: It receives an absolute path. It compares that path with the fake root folder, the fake skill folder, and the fake SKILL.md file. If the path matches one of those, it returns simple file information; if not, it returns a “not found” error.

**Call relations**: The fake canonicalization step uses this to reject unknown paths, and the executor file system metadata method passes requests into it. It is the shared truth table for what exists inside the synthetic file system.

*Call graph*: calls 1 internal fn (join); called by 2 (canonicalize, get_metadata); 1 external calls (new).


##### `SyntheticFileSystem::canonicalize`  (lines 97–103)

```
fn canonicalize(
        &'a self,
        path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, PathUri>
```

**Purpose**: This turns a requested path into the fake file system’s official path. It specifically maps the test’s alias root to the canonical root, which proves the loader respects the executor’s own idea of path identity.

**Data flow**: It receives a path URI, converts it to an absolute path, and checks whether it is the alias root. If so, it returns the canonical root as a path URI. Otherwise it checks that the path exists in the fake metadata and returns the same path back in URI form.

**Call relations**: The skill loader calls this through the ExecutorFileSystem interface while loading skills. It relies on SyntheticFileSystem::metadata for non-alias paths, so invalid paths are rejected instead of silently accepted.

*Call graph*: calls 3 internal fn (metadata, from_abs_path, to_abs_path); 1 external calls (pin).


##### `SyntheticFileSystem::read_file`  (lines 105–111)

```
fn read_file(
        &'a self,
        path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>>
```

**Purpose**: This returns the contents of the one fake SKILL.md file. It lets the test prove that skill text is being read through the supplied executor file system.

**Data flow**: It receives a path URI and converts it to an absolute path. If the path is exactly the fake canonical root plus skill/SKILL.md, it returns the test skill contents as bytes. Any other path produces a “not found” error.

**Call relations**: After the loader discovers the skill, HostLoadedSkills reads the skill body through this file system path. The narrow one-file behavior makes any accidental read from the wrong place fail.

*Call graph*: calls 2 internal fn (join, to_abs_path); 2 external calls (pin, new).


##### `SyntheticFileSystem::read_file_stream`  (lines 113–124)

```
fn read_file_stream(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream>
```

**Purpose**: This says the fake file system does not support streaming file reads. Streaming means reading a file in chunks instead of all at once.

**Data flow**: It ignores the requested path and sandbox context. It immediately returns an “unsupported” error saying streaming reads are not available.

**Call relations**: This exists because the ExecutorFileSystem interface requires it. The tests in this file use normal whole-file reads instead, so this method acts as a clear guardrail if some code unexpectedly tries streaming.

*Call graph*: 2 external calls (pin, new).


##### `SyntheticFileSystem::write_file`  (lines 126–133)

```
fn write_file(
        &'a self,
        _path: &'a PathUri,
        _contents: Vec<u8>,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>
```

**Purpose**: This blocks writes to the fake file system. The synthetic file system is intentionally read-only because these tests only need to discover and read skills.

**Data flow**: It receives a path, file contents, and optional sandbox context, but does not use them. It returns an “unsupported” error with the message “read only.”

**Call relations**: This fills the write part of the ExecutorFileSystem interface. If skill loading ever tries to modify the executor file system during these tests, this method makes that mistake visible.

*Call graph*: 2 external calls (pin, new).


##### `SyntheticFileSystem::create_directory`  (lines 135–142)

```
fn create_directory(
        &'a self,
        _path: &'a PathUri,
        _options: CreateDirectoryOptions,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'
```

**Purpose**: This blocks directory creation in the fake file system. The test file system has a fixed layout and should not be changed.

**Data flow**: It receives a path, directory creation options, and optional sandbox context. It ignores them and returns an “unsupported” read-only error.

**Call relations**: This is another required ExecutorFileSystem operation. It is not part of the expected skill-loading path, so any call to it would signal unexpected write-like behavior.

*Call graph*: 2 external calls (pin, new).


##### `SyntheticFileSystem::get_metadata`  (lines 144–150)

```
fn get_metadata(
        &'a self,
        path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>
```

**Purpose**: This exposes fake file information through the executor file system interface. It lets callers ask whether a virtual path is a file or directory.

**Data flow**: It receives a path URI, converts it to an absolute path, and passes it to SyntheticFileSystem::metadata. The result is either file metadata for one of the known fake paths or a “not found” error.

**Call relations**: The loader can call this through the ExecutorFileSystem trait while walking the skill tree. It delegates the actual path decision to SyntheticFileSystem::metadata so all existence checks stay consistent.

*Call graph*: calls 2 internal fn (metadata, to_abs_path); 1 external calls (pin).


##### `SyntheticFileSystem::read_directory`  (lines 152–158)

```
fn read_directory(
        &'a self,
        path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>>
```

**Purpose**: This lists the contents of the fake directories. It gives the loader just enough directory structure to find skill/SKILL.md.

**Data flow**: It receives a path URI and converts it to an absolute path. If the path is the fake canonical root, it returns one directory named skill. If the path is that skill directory, it returns one file named SKILL.md. Anything else returns “not found.”

**Call relations**: The skill loader uses this through the ExecutorFileSystem interface while searching for skills. It works together with read_file: this method reveals where SKILL.md is, and read_file supplies its contents.

*Call graph*: calls 2 internal fn (join, to_abs_path); 3 external calls (pin, new, vec!).


##### `SyntheticFileSystem::remove`  (lines 160–167)

```
fn remove(
        &'a self,
        _path: &'a PathUri,
        _options: RemoveOptions,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>
```

**Purpose**: This blocks deletion from the fake file system. The synthetic tree is fixed and read-only.

**Data flow**: It receives a path, remove options, and optional sandbox context, but ignores them. It returns an “unsupported” read-only error.

**Call relations**: This satisfies the ExecutorFileSystem interface. It should not be used during skill loading; if it is, the test will fail instead of hiding the unexpected deletion attempt.

*Call graph*: 2 external calls (pin, new).


##### `SyntheticFileSystem::copy`  (lines 169–177)

```
fn copy(
        &'a self,
        _source_path: &'a PathUri,
        _destination_path: &'a PathUri,
        _options: CopyOptions,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> Ex
```

**Purpose**: This blocks copying files inside the fake file system. The tests only need read access, so copy operations are deliberately unsupported.

**Data flow**: It receives source and destination paths, copy options, and optional sandbox context. It ignores them and returns an “unsupported” read-only error.

**Call relations**: This completes the required executor file system behavior for copy requests. It is a safety tripwire for unexpected mutation during skill discovery.

*Call graph*: 2 external calls (pin, new).


##### `skill_loading_and_reads_use_the_supplied_executor_file_system`  (lines 181–216)

```
async fn skill_loading_and_reads_use_the_supplied_executor_file_system()
```

**Purpose**: This test proves that loading and reading an executor skill uses the supplied executor file system. It sets up paths that do not exist on the real disk, so the test can only pass if the fake file system is truly used.

**Data flow**: It creates alias and canonical temporary paths, checks that neither exists on the host disk, then calls the skill loader with a SyntheticFileSystem. The loader returns one skill with the expected name and canonical SKILL.md path. The test then wraps the loaded result and reads the skill text, expecting exactly the synthetic file contents.

**Call relations**: This is the main test for the fake file system. It calls load_skills_from_roots, which in turn exercises SyntheticFileSystem’s canonicalize, directory listing, metadata, and file read behavior through the executor file system interface.

*Call graph*: calls 3 internal fn (load_skills_from_roots, new, from_absolute_path_checked); 5 external calls (new, assert!, assert_eq!, format!, temp_dir).


##### `selected_root_id_distinguishes_identical_executor_paths`  (lines 219–282)

```
async fn selected_root_id_distinguishes_identical_executor_paths()
```

**Purpose**: This test checks that selected executor root IDs remain meaningful even when two roots point to the same actual path. Without this, skill URLs could blur together and lose which authority they came from.

**Data flow**: It creates a temporary real skill root, builds two selected roots named root-a and root-b that both point to that same folder, and asks ExecutorSkillProvider to list skills. It then checks that the catalog has two entries and that each display path starts with its own root ID. Finally it deletes the temporary folder.

**Call relations**: This test uses create_local_skill_root to prepare a real SKILL.md file. It then drives ExecutorSkillProvider through its list call, checking the final catalog output rather than the lower-level file walking details.

*Call graph*: calls 4 internal fn (default_for_tests, new_with_restriction_product, create_local_skill_root, from_absolute_path_checked); 3 external calls (new, assert_eq!, remove_dir_all).


##### `create_local_skill_root`  (lines 284–294)

```
fn create_local_skill_root(label: &str) -> io::Result<std::path::PathBuf>
```

**Purpose**: This helper creates a temporary on-disk skill folder for tests that need a real local directory. It writes the same synthetic SKILL.md content used by the fake file system.

**Data flow**: It receives a label, combines it with the process ID and a counter to make a unique temporary path, creates a skill subdirectory, writes SKILL.md inside it, and returns the root path. If directory creation or writing fails, it returns the I/O error.

**Call relations**: selected_root_id_distinguishes_identical_executor_paths calls this before listing skills. The helper keeps the test setup small and avoids path collisions between repeated or parallel test runs.

*Call graph*: called by 1 (selected_root_id_distinguishes_identical_executor_paths); 4 external calls (format!, temp_dir, create_dir_all, write).


### `ext/skills/tests/skills_extension.rs`

`test` · `test run`

A “skill” here is a packaged instruction file, usually named SKILL.md, that can be offered to the model and explicitly invoked by a user with text like $lint-fix. This test file builds miniature Codex extension registries, starts fake threads, feeds in fake user turns, and checks the prompt fragments that the skills extension produces. In plain terms, it makes sure the extension acts like a good librarian: it shows the right catalog, fetches the requested book, hides books that should not appear on the public shelf, and does not keep retrying a broken catalog source forever.

The tests cover several important paths. One uses a real temporary SKILL.md file to prove host-loaded skills are inserted into the turn prompt with the expected instructions. Others use StaticSkillProvider, a fake provider that returns a fixed catalog and records what the extension asked it to read. This lets the tests confirm that executor skills tied to selected environment roots appear in context, that a fully qualified skill locator chooses the correct duplicate skill, and that hidden skills can still be invoked directly. Another test uses ChannelEventSink to capture warning events and proves that an orchestrator catalog failure is reported once and cached. Without these tests, changes to prompt-building or skill selection could silently expose the wrong skills, fail to load requested skills, or repeatedly hit a failing provider.

#### Function details

##### `installed_extension_uses_host_loaded_skills`  (lines 55–138)

```
async fn installed_extension_uses_host_loaded_skills() -> TestResult
```

**Purpose**: This test proves that when the host has already loaded a local skill from disk, the skills extension uses that host-provided skill data during a user turn. It checks both the catalog-style instruction text and the full skill content injected into the prompt.

**Data flow**: It creates a temporary Codex home folder, writes a demo SKILL.md file, builds the extension registry with the default test configuration, and starts a thread. Then it puts a HostLoadedSkills object into the turn store and sends user input containing "$demo". The extension returns prompt fragments, and the test compares them with the exact expected developer and user prompt text. It also checks that the turn store was marked to remember that this host skill path was injected, then removes the temporary folder.

**Call relations**: This is one of the top-level asynchronous tests. It calls helper functions such as test_codex_home to create an isolated folder and default_config to get the standard settings, then exercises the installed extension through the registry's thread-start and turn-input contributor hooks.

*Call graph*: calls 6 internal fn (new, new, new, default_config, test_codex_home, try_from); 12 external calls (clone, new, new, assert!, assert_eq!, install, default, format!, create_dir_all, remove_dir_all (+2 more)).


##### `selected_executor_catalog_is_context_and_selected_entrypoint_is_turn_input`  (lines 141–256)

```
async fn selected_executor_catalog_is_context_and_selected_entrypoint_is_turn_input() -> TestResult
```

**Purpose**: This test checks the normal flow for an executor skill, meaning a skill supplied by a selected execution environment. It verifies that the skill appears in the conversation context catalog, and that the full skill body is only loaded when the user invokes it.

**Data flow**: It builds a StaticSkillProvider containing one executor skill and inserts a selected capability root into the thread store. After thread startup, it asks the context contributor for prompt text and confirms that the catalog mentions the executor skill and its environment resource path. It then sends a turn with "$lint-fix please", receives one user prompt fragment containing the skill content, and inspects the provider's recorded read request to make sure the extension fetched the correct package and resource. A later turn without a skill mention produces no fragments.

**Call relations**: This test wires a fake executor provider into install_with_providers and then drives the extension through the same contributor interfaces used in real sessions. It relies on StaticSkillProvider::list to supply the catalog, StaticSkillProvider::read to fake reading the skill file, default_config for settings, and read_request_keys to summarize what was fetched.

*Call graph*: calls 4 internal fn (new, new, new, default_config); 8 external calls (clone, new, new, new, assert!, assert_eq!, install_with_providers, vec!).


##### `orchestrator_catalog_snapshot_caches_failure`  (lines 259–329)

```
async fn orchestrator_catalog_snapshot_caches_failure() -> TestResult
```

**Purpose**: This test makes sure a failing orchestrator skill catalog is treated as a cached failure for the thread. The important behavior is that the extension warns once and does not keep asking the same broken source on every turn.

**Data flow**: It creates a StaticSkillProvider configured to fail the first catalog listing call, plus a counter that records how many list attempts happen. It installs the extension with a ChannelEventSink so warning events can be captured. After thread startup, asking for context returns no skill prompt fragments, and the captured event contains the expected warning message. Two later turns try to invoke "$first", but both produce no fragments. Finally, the counter shows that the provider was listed only once.

**Call relations**: This top-level test uses ExtensionRegistryBuilder::with_event_sink so ChannelEventSink::emit can capture warnings. It depends on StaticSkillProvider::list to simulate the temporary failure and uses default_config during setup before driving the context and turn-input contributors.

*Call graph*: calls 4 internal fn (with_event_sink, new, new, default_config); 11 external calls (clone, new, new, new, new, assert!, assert_eq!, install_with_providers, panic!, channel (+1 more)).


##### `root_qualified_locator_selects_only_the_matching_executor_skill`  (lines 332–416)

```
async fn root_qualified_locator_selects_only_the_matching_executor_skill() -> TestResult
```

**Purpose**: This test covers the case where two selected roots contain skills with the same visible name. It proves that a fully qualified locator, like a complete skill:// path, selects the exact matching root instead of the first skill with that name.

**Data flow**: It creates two executor catalog entries that are both named "lint-fix" but belong to different roots and have different locator strings. It inserts both roots into the thread store, starts the extension, and sends a user mention whose path points to the root-b skill. The returned prompt fragment contains the root-b locator, and the recorded read request shows that only the root-b authority, package, and resource were read.

**Call relations**: This test drives the extension through install_with_providers, thread startup, and a turn-input contribution. It uses StaticSkillProvider::list for the two-entry catalog, StaticSkillProvider::read for fake content, default_config for setup, and read_request_keys to confirm the exact read target.

*Call graph*: calls 4 internal fn (new, new, new, default_config); 8 external calls (clone, new, new, new, assert!, assert_eq!, install_with_providers, vec!).


##### `prompt_hidden_skill_can_still_be_invoked`  (lines 419–493)

```
async fn prompt_hidden_skill_can_still_be_invoked() -> TestResult
```

**Purpose**: This test checks a subtle rule: a skill can be hidden from the displayed catalog but still be available if the user names it directly. That lets the system avoid advertising a skill while still supporting explicit use.

**Data flow**: It creates a host provider with two skills: one visible and one marked hidden from the prompt. After startup, it sends a turn containing "$hidden-skill". The extension returns two fragments: the catalog fragment includes the visible skill but not the hidden one, while the loaded skill fragment contains the hidden skill's name and content. The recorded read request confirms that the hidden skill was fetched from the provider.

**Call relations**: This test uses install_with_providers with a fake host provider and then runs the registry's turn-input contributor. StaticSkillProvider::list supplies both catalog entries, StaticSkillProvider::read records and returns the invoked hidden skill, default_config supplies settings, test_entry builds the entries, and read_request_keys checks what was read.

*Call graph*: calls 4 internal fn (new, new, new, default_config); 8 external calls (clone, new, new, new, assert!, assert_eq!, install_with_providers, vec!).


##### `ChannelEventSink::emit`  (lines 506–508)

```
fn emit(&self, event: Event)
```

**Purpose**: This small test helper receives extension events and forwards them into a standard channel, which is like a mailbox the test can read later. It lets a test assert that the extension produced a warning without printing to the console or depending on real event infrastructure.

**Data flow**: It receives an Event from the extension. It tries to send that event through the stored channel sender. Nothing is returned; if the receiver has gone away, the send error is deliberately ignored because the test helper does not need recovery behavior.

**Call relations**: The extension runtime calls this method when it emits an event through the event sink. In this file, orchestrator_catalog_snapshot_caches_failure installs ChannelEventSink through the registry builder so it can later read the warning event from the channel.


##### `StaticSkillProvider::list`  (lines 512–526)

```
fn list(&self, _query: SkillListQuery) -> SkillProviderFuture<'_, SkillCatalog>
```

**Purpose**: This fake provider method returns a prepared skill catalog to the extension. It can also be configured to fail on the first call, which lets tests check how the extension behaves when a catalog source is temporarily unavailable.

**Data flow**: It receives a skill list query but ignores its details. It optionally increments a shared call counter, decides whether this should be the forced first failure, clones the stored catalog, and returns an asynchronous result. The result is either an error saying there was a temporary orchestrator failure or the fixed catalog.

**Call relations**: The skills extension calls this when building a catalog snapshot for context or turn handling. Several tests rely on the successful path, while orchestrator_catalog_snapshot_caches_failure uses the fail-first behavior to verify warning and caching behavior.

*Call graph*: calls 1 internal fn (new); 2 external calls (pin, clone).


##### `StaticSkillProvider::read`  (lines 528–540)

```
fn read(&self, request: SkillReadRequest) -> SkillProviderFuture<'_, SkillReadResult>
```

**Purpose**: This fake provider method pretends to read the contents of a requested skill file. It records the request so tests can later prove the extension fetched the right skill.

**Data flow**: It receives a SkillReadRequest containing the authority, package, and resource to read. Inside the asynchronous body, it locks the shared request list, appends a clone of the request, and returns a SkillReadResult with the requested resource and fixed markdown content for a lint-fix skill.

**Call relations**: The extension calls this after user input selects or mentions a skill. Tests such as selected_executor_catalog_is_context_and_selected_entrypoint_is_turn_input, root_qualified_locator_selects_only_the_matching_executor_skill, and prompt_hidden_skill_can_still_be_invoked inspect the recorded requests through read_request_keys.

*Call graph*: 3 external calls (clone, pin, clone).


##### `StaticSkillProvider::search`  (lines 542–544)

```
fn search(&self, _request: SkillSearchRequest) -> SkillProviderFuture<'_, SkillSearchResult>
```

**Purpose**: This fake provider method supplies the search part of the SkillProvider interface, but these tests do not need search results. It returns an empty successful search result so the provider satisfies the required contract.

**Data flow**: It receives a search request and ignores it. It returns an asynchronous success value containing the default, empty SkillSearchResult. It changes no shared state.

**Call relations**: The SkillProvider trait requires this method, so StaticSkillProvider implements it even though the tests in this file focus on listing and reading skills. If the extension asks this fake provider to search, it gets a harmless empty answer.

*Call graph*: 2 external calls (pin, default).


##### `test_entry`  (lines 547–562)

```
fn test_entry(
    kind: SkillSourceKind,
    authority_id: &str,
    package_id: &str,
    main_prompt: &str,
) -> SkillCatalogEntry
```

**Purpose**: This helper builds a catalog entry for a test skill with consistent package, authority, name, description, resource, and display path. It keeps the tests readable by hiding repetitive setup details.

**Data flow**: It takes a source kind, an authority ID, a package ID, and the main prompt resource path. It derives the skill name from the last part of the package ID, creates the catalog entry, and adds a display path in skill:// form. The result is a SkillCatalogEntry ready to place into a fake catalog.

**Call relations**: The tests call this whenever they need ordinary catalog entries without custom setup. prompt_hidden_skill_can_still_be_invoked also calls hidden_from_prompt on one entry after test_entry creates it.

*Call graph*: calls 3 internal fn (new, new, new); 2 external calls (new, format!).


##### `default_config`  (lines 570–575)

```
fn default_config() -> TestConfig
```

**Purpose**: This helper returns the standard settings used by most tests: include skill instructions and enable bundled skills. It gives each test the same baseline unless the test intentionally changes something.

**Data flow**: It takes no input. It constructs and returns a TestConfig with include_instructions set to true and bundled_skills_enabled set to true. It does not read or change any shared state.

**Call relations**: All five top-level tests call this during setup. The resulting TestConfig is passed into the thread-start input, where skills_extension_config converts it into the real SkillsExtensionConfig expected by the extension installer.

*Call graph*: called by 5 (installed_extension_uses_host_loaded_skills, orchestrator_catalog_snapshot_caches_failure, prompt_hidden_skill_can_still_be_invoked, root_qualified_locator_selects_only_the_matching_executor_skill, selected_executor_catalog_is_context_and_selected_entrypoint_is_turn_input).


##### `skills_extension_config`  (lines 577–582)

```
fn skills_extension_config(config: &TestConfig) -> SkillsExtensionConfig
```

**Purpose**: This adapter turns the test-only configuration struct into the actual configuration type used by the skills extension. It lets tests keep simple settings while still installing the real extension code.

**Data flow**: It receives a TestConfig reference. It copies the include_instructions and bundled_skills_enabled values into a SkillsExtensionConfig and returns that new object. No other state is touched.

**Call relations**: The extension installer is given this function as the configuration mapping callback. When the registry starts a thread, the installed extension uses it to read the relevant settings from the TestConfig supplied by the test.


##### `test_codex_home`  (lines 584–590)

```
fn test_codex_home() -> PathBuf
```

**Purpose**: This helper creates a unique temporary folder path for tests that need a fake Codex home directory. The uniqueness prevents one test run from colliding with another.

**Data flow**: It increments a shared atomic counter, reads the operating system temporary directory, and combines that with the current process ID and counter value. It returns the resulting PathBuf but does not create the directory itself.

**Call relations**: installed_extension_uses_host_loaded_skills calls this before writing a temporary SKILL.md file. The helper uses the shared NEXT_CODEX_HOME_ID counter so repeated calls in the same process produce different paths.

*Call graph*: called by 1 (installed_extension_uses_host_loaded_skills); 2 external calls (format!, temp_dir).


##### `read_request_keys`  (lines 592–607)

```
fn read_request_keys(
    requests: &Arc<Mutex<Vec<SkillReadRequest>>>,
) -> Vec<(SkillAuthority, SkillPackageId, SkillResourceId)>
```

**Purpose**: This helper extracts the important identifying parts from the fake provider's recorded read requests. It makes assertions simpler by ignoring unrelated request details.

**Data flow**: It receives the shared, locked list of SkillReadRequest values. It locks the list, recovers even if a previous holder panicked while holding the lock, then maps each request to a tuple of authority, package ID, and resource ID. It returns the collected tuples.

**Call relations**: Several tests call this after a turn tries to load a skill. It reads the records written by StaticSkillProvider::read and lets the tests compare the actual fetched skill target with the expected one.


### Extension API and built-in extensions
This group validates the generic extension framework first, then exercises concrete extensions and their end-to-end runtime behavior.

### `ext/extension-api/tests/capabilities.rs`

`test` · `test run`

This is a test file for the extension API, which is the part of the project that lets outside extensions plug into Codex behavior. The tests focus on two “capabilities,” meaning optional powers an extension can provide.

The first test checks the safe default for response item injection. A response item injector is something that could add or alter items in a model conversation. The no-op version is deliberately not allowed to inject into the same turn, so the test gives it a user message and confirms it rejects the request while returning the exact original items. In everyday terms, it is like asking a locked suggestion box to add a note, and making sure it says “no” without losing the note you handed it.

The second test checks that ordinary Rust closures can act as agent spawners. An agent spawner is a callback that starts a subagent, which is a delegated worker tied to a thread ID. The test records what arguments the closure receives, returns the length of the request string, and then verifies both the returned result and the recorded call. This makes sure extension authors can provide simple callback functions instead of needing a heavier custom type.

#### Function details

##### `noop_response_item_injector_returns_original_items`  (lines 14–29)

```
async fn noop_response_item_injector_returns_original_items()
```

**Purpose**: This test proves that the built-in no-op response item injector refuses same-turn injection but does not discard or alter the items it was given. It matters because callers need a safe failure path where their conversation data comes back intact.

**Data flow**: The test starts with one user message containing the text “keep this input.” It passes a clone of that list into `NoopResponseItemInjector.inject_response_items`. The injector returns an error, and the test treats that error value as the returned original items. Finally, it compares those returned items with the original list to confirm nothing changed.

**Call relations**: During the test run, this function directly exercises `NoopResponseItemInjector` through the `ResponseItemInjector` trait. It uses an assertion at the end to lock in the expected contract: rejection is allowed here, but data loss or mutation is not.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `closure_agent_spawner_forwards_arguments_and_result`  (lines 32–56)

```
async fn closure_agent_spawner_forwards_arguments_and_result()
```

**Purpose**: This test proves that a plain closure can be used wherever the extension API expects an agent spawner. It also checks that the closure receives the exact thread ID and request text, and that its asynchronous result is passed back to the caller.

**Data flow**: The test creates a shared, locked list to record calls, then builds a closure that accepts a thread ID and request string. When called, the closure stores those inputs in the list and returns an asynchronous success value equal to the request length. The test creates a thread ID from a string, calls `spawn_subagent` with that ID and the text “delegate this,” waits for the result, then checks that the result is `Ok(13)` and that the recorded inputs match exactly.

**Call relations**: During the test run, this function checks the bridge between the `AgentSpawner` trait and closure-based implementations. The test calls `spawn_subagent`, which should forward into the closure; the closure records the call and returns a future, and the test verifies that both the forwarding and the returned value survive the round trip.

*Call graph*: calls 1 internal fn (from_string); 5 external calls (clone, new, new, new, assert_eq!).


### `ext/extension-api/tests/state.rs`

`test` · `test run`

This is a test file, so its job is not to provide the storage itself but to prove that the storage behaves the way extension authors will rely on. `ExtensionData` acts like a labeled box of notes for an extension: code can put in one value of each type, look it up later by that type, replace it, or remove it. These tests make sure that a number stored as a `u64` does not get confused with a `String`, and that replacing one kind of value does not disturb another.

The file also checks behavior that matters when several tasks use the same storage at once. One test starts several threads and has them all ask for the same missing value through `get_or_init`, which means “return the existing value, or create it if nobody has yet.” The test proves that only one thread actually creates the value, and everyone receives the exact same shared result.

Other tests confirm that two separate `ExtensionData` stores with the same level identifier still do not share contents, and that the identifier is preserved. Finally, the file checks an important failure case: if an initializer panics, meaning it crashes partway through, the store is not left permanently broken and can still initialize the value successfully afterward.

#### Function details

##### `typed_values_can_be_inserted_replaced_and_removed`  (lines 10–30)

```
fn typed_values_can_be_inserted_replaced_and_removed()
```

**Purpose**: This test proves that `ExtensionData` can store different kinds of values at the same time, find them again by their Rust type, replace an existing value of the same type, and remove one value without disturbing the others. It protects the basic promise that this storage behaves like a type-labeled cabinet.

**Data flow**: The test starts with a new empty `ExtensionData` store. It inserts a number and a string, reads both back, then inserts a new number of the same type and checks that the old number is returned as the replaced value. It then removes the string and confirms that the string is gone while the updated number is still present.

**Call relations**: This test directly exercises the public storage operations on a fresh `ExtensionData` value. It relies on the constructor to create an empty store, then uses assertions to confirm each visible change after insertion, replacement, lookup, and removal.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `get_or_init_initializes_once_and_returns_shared_value`  (lines 33–76)

```
fn get_or_init_initializes_once_and_returns_shared_value()
```

**Purpose**: This test checks the thread-safe lazy initialization path. Lazy initialization means a value is only created when it is first needed; the important promise here is that even if many threads ask at once, the value is created exactly one time and then shared.

**Data flow**: The test creates one shared `ExtensionData` store and two shared counters: one counting how many worker threads have started, and one counting how many times initialization actually runs. It starts eight threads, and each thread asks the store for the same `SharedValue`, creating it only if needed. The initializer waits until all workers have reached the same point, forcing real overlap. After all threads finish, the test checks that the initializer ran once, that every thread saw `SharedValue(7)`, and that all returned pointers refer to the same shared object.

**Call relations**: This test is the stress case for `get_or_init`. It builds a shared store, launches workers with Rust threads, and then uses assertions after the workers join to verify that the storage code correctly coordinated competing callers instead of creating duplicate values.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, new, assert!, assert_eq!, from_fn).


##### `stores_are_isolated_and_preserve_level_id`  (lines 79–97)

```
fn stores_are_isolated_and_preserve_level_id()
```

**Purpose**: This test proves that separate `ExtensionData` stores do not leak values into each other, even if they were created with the same level identifier. It also checks that each store remembers the identifier it was given.

**Data flow**: The test creates two separate stores using the same text identifier. It puts a number into one store and a string into the other. It then reads the level identifier from both stores and checks their contents: the first store has only the number, and the second store has only the string.

**Call relations**: This test focuses on store boundaries. It uses the constructor twice and then checks that the public lookup and identifier methods keep the two stores independent, which matters when different scopes such as a session and a thread need separate extension state.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `store_remains_usable_after_panicking_initializer`  (lines 100–109)

```
fn store_remains_usable_after_panicking_initializer()
```

**Purpose**: This test checks that a failed `get_or_init` call does not poison or permanently damage the store. In plain terms, if the first attempt to create a value crashes, a later attempt should still be able to create and read that value.

**Data flow**: The test creates a new store and deliberately calls `get_or_init` with an initializer that panics. It catches that panic so the test can continue. Then it calls `get_or_init` again with a working initializer that returns `99`, and checks that the store now returns that value successfully.

**Call relations**: This test wraps the failing initializer in Rust’s panic-catching tools so it can inspect the store afterward. It then hands control back to `get_or_init` with a normal initializer, proving that the earlier failure did not leave the storage machinery stuck in a bad state.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert!, assert_eq!, AssertUnwindSafe, catch_unwind).


### `ext/extension-api/tests/registry.rs`

`test` · `test run`

The extension registry is like a sign-up sheet for plug-in behavior. Different contributors can add prompt text, react to turns, offer tools, review approvals, or receive events. These tests make sure that when code registers those contributors, the registry does not lose them, reorder them, or stop them from working.

The file defines a few small fake contributors. Some do almost nothing except prove they can be registered. Others record what happened into a shared list protected by a mutex, which is a lock that stops two tasks changing the same list at once. The tests then build registries, ask them for their contributors, run those contributors, and compare the results with what should have happened.

A key behavior tested here is order. If one extension is registered before another, the registry should call them in that same order, because later behavior may depend on earlier behavior. Another key behavior is approval review. Contributors are asked one by one whether they want to make a decision. The registry returns the first real answer and stops asking the rest, which prevents later contributors from overriding an already-claimed decision. The file also checks that a custom event sink survives from the builder into the finished registry, and that an empty registry simply makes no approval decision.

#### Function details

##### `AllContributors::tools`  (lines 71–77)

```
fn tools(
        &self,
        _session_store: &ExtensionData,
        _thread_store: &ExtensionData,
    ) -> Vec<Arc<dyn ToolExecutor<ToolCall>>>
```

**Purpose**: This test-only implementation says that the all-purpose fake contributor offers no tools. It exists so the same fake object can be registered in the tool-contributor slot without adding unrelated tool behavior.

**Data flow**: It receives session-level and thread-level extension data, ignores both, creates an empty list, and returns that empty list. Nothing outside the function is changed.

**Call relations**: The registry builder test registers AllContributors as a tool contributor. When the registry later exposes its tool contributors, this method is the tool-list behavior that would be available, though the test only needs to prove the contributor was stored.

*Call graph*: 1 external calls (new).


##### `AllContributors::contribute`  (lines 97–107)

```
fn contribute(
        &'a self,
        _session_store: &'a ExtensionData,
        _thread_store: &'a ExtensionData,
        _prompt: &'a str,
    ) -> ExtensionFuture<'a, Option<ReviewDecision>>
```

**Purpose**: This approval-review implementation always approves for the whole session. It lets the test prove that an approval contributor registered with the builder can still be called after the registry is built.

**Data flow**: It receives the session store, thread store, and approval prompt, but does not inspect them. It returns an asynchronous result containing an approval decision: approved for the session.

**Call relations**: The build-round-trip test registers AllContributors as the approval reviewer, builds the registry, then asks the registry for an approval review. The registry calls this method and returns its decision to the test.

*Call graph*: 3 external calls (pin, new, ready).


##### `build_round_trips_every_contributor_category`  (lines 111–145)

```
async fn build_round_trips_every_contributor_category()
```

**Purpose**: This test checks that every supported contributor category can be registered in the builder and then found in the finished registry. It also verifies that approval review still works after building.

**Data flow**: It creates one shared fake contributor, registers it in each contributor category, and builds a registry. It then reads each category back from the registry and checks that one contributor is present, finally sending an approval-review request and checking for the expected approval.

**Call relations**: This is a top-level asynchronous test. It drives the registry builder directly and relies on AllContributors, including its approval-review contribution, to prove that registration and later lookup work across the full extension API.

*Call graph*: 3 external calls (new, new, assert_eq!).


##### `NamedContextContributor::contribute`  (lines 150–158)

```
fn contribute(
        &'a self,
        _session_store: &'a ExtensionData,
        _thread_store: &'a ExtensionData,
    ) -> ExtensionFuture<'a, Vec<PromptFragment>>
```

**Purpose**: This fake context contributor returns one prompt fragment containing its own name. It is used to make contributor order visible in test results.

**Data flow**: It receives session and thread stores, ignores them, turns its stored name into a developer-policy prompt fragment, wraps that fragment in a list, and returns it asynchronously.

**Call relations**: The contributor-order test registers two NamedContextContributor values named “first” and “second.” It then calls the registry’s context contributors in order and checks that the prompt fragments come back in that same order.

*Call graph*: 3 external calls (pin, ready, vec!).


##### `RecordingTurnItemContributor::contribute`  (lines 167–180)

```
fn contribute(
        &'a self,
        _thread_store: &'a ExtensionData,
        _turn_store: &'a ExtensionData,
        _item: &'a mut TurnItem,
    ) -> ExtensionFuture<'a, Result<(), String>>
```

**Purpose**: This fake turn-item contributor records that it was called. It helps prove that turn-item contributors run in the order they were registered.

**Data flow**: It receives thread data, turn data, and a mutable turn item, but only uses its own stored name and shared call log. It locks the log, appends its name, and returns success without changing the turn item.

**Call relations**: The contributor-order test registers two of these contributors. When the test loops through the registry’s turn-item contributors, each one records its name, allowing the test to compare the final call log with the expected order.

*Call graph*: 1 external calls (pin).


##### `contributors_preserve_registration_order`  (lines 184–229)

```
async fn contributors_preserve_registration_order()
```

**Purpose**: This test checks that the registry keeps contributors in the same order they were added. That matters because extension output can depend on predictable sequencing.

**Data flow**: It builds a registry with two named prompt contributors and two recording turn-item contributors. It then asks the prompt contributors for fragments and asks the turn-item contributors to process a sample turn item. The final prompt list and call log are compared with the expected “first, second” order.

**Call relations**: This asynchronous test coordinates NamedContextContributor and RecordingTurnItemContributor. It calls their contribution methods through the registry, which is the important point: the test proves the registry, not just the individual contributors, preserves order.

*Call graph*: calls 1 internal fn (new); 7 external calls (clone, new, new, new, new, assert_eq!, HookPrompt).


##### `RecordingApprovalContributor::contribute`  (lines 246–264)

```
fn contribute(
        &'a self,
        session_store: &'a ExtensionData,
        thread_store: &'a ExtensionData,
        prompt: &'a str,
    ) -> ExtensionFuture<'a, Option<ReviewDecision>>
```

**Purpose**: This fake approval contributor records the approval request it received and then returns its configured decision. It is used to test both call order and short-circuiting, meaning the registry stops after the first real decision.

**Data flow**: It receives session data, thread data, and a prompt. It reads the session and thread identifiers, stores them with its own name and the prompt in a shared call log, then returns either no decision or a configured review decision.

**Call relations**: The approval short-circuit test registers several of these contributors with different decisions. The registry calls them in order until one returns a real decision, and this method’s recorded calls show exactly how far the registry got.

*Call graph*: calls 1 internal fn (level_id); 1 external calls (pin).


##### `approval_review_returns_first_claim_and_short_circuits`  (lines 268–310)

```
async fn approval_review_returns_first_claim_and_short_circuits()
```

**Purpose**: This test checks that approval review returns the first contributor decision that is not empty, and does not keep asking later contributors afterward. This prevents later reviewers from changing a decision that has already been claimed.

**Data flow**: It creates three recording approval contributors: the first gives no answer, the second approves, and the third would deny. It asks the registry to review a prompt, then checks that the answer is the second contributor’s approval and that only the first two contributors were called.

**Call relations**: This asynchronous test drives the registry’s approval-review flow. It uses RecordingApprovalContributor to make the invisible control flow visible through a call log.

*Call graph*: calls 1 internal fn (new); 6 external calls (clone, new, new, new, new, assert_eq!).


##### `RecordingEventSink::emit`  (lines 318–326)

```
fn emit(&self, event: Event)
```

**Purpose**: This fake event sink records warning events so the test can prove the same sink is used before and after building the registry. It deliberately accepts only warning events because that is all the test sends.

**Data flow**: It receives an event, checks that the event message is a warning, then locks its internal event list and stores the event id and warning message. If a non-warning event arrives, it stops the test with a panic.

**Call relations**: The custom event-sink test sends one warning through the builder and one through the finished registry. Both calls go through this method, proving that the custom sink object survived the build step.

*Call graph*: 1 external calls (panic!).


##### `custom_event_sink_survives_registry_build`  (lines 330–352)

```
fn custom_event_sink_survives_registry_build()
```

**Purpose**: This test checks that a custom event sink attached to the registry builder is still the event sink used by the final registry. In plain terms, the message mailbox should not be replaced during construction.

**Data flow**: It creates a recording event sink, gives it to a registry builder, emits one warning through the builder, builds the registry, and emits another warning through the registry. It then reads the sink’s recorded events and checks that both warnings are present in order.

**Call relations**: This ordinary synchronous test uses warning_event to create simple warning messages and RecordingEventSink::emit to record them. It exercises both the builder’s event sink access and the final registry’s event sink access.

*Call graph*: calls 1 internal fn (warning_event); 4 external calls (new, with_event_sink, assert_eq!, default).


##### `empty_registry_does_not_claim_approval_review`  (lines 355–368)

```
async fn empty_registry_does_not_claim_approval_review()
```

**Purpose**: This test checks the safe default behavior for a registry with no approval reviewers. If nobody is registered to decide, the registry should return no decision rather than inventing one.

**Data flow**: It creates an empty registry and asks it to review a prompt using fresh session and thread data. The result is compared with None, meaning no contributor claimed the decision.

**Call relations**: This asynchronous test calls the helper that creates an empty registry and then uses the registry’s approval-review path. It complements the other approval tests by covering the no-contributors case.

*Call graph*: 1 external calls (assert_eq!).


##### `warning_event`  (lines 370–377)

```
fn warning_event(id: &str, message: &str) -> Event
```

**Purpose**: This small helper creates a warning event with a chosen id and message. It keeps the event-sink test focused on behavior instead of repeating event construction details.

**Data flow**: It receives an id string and a message string, copies both into owned strings, wraps the message as a warning event, and returns a complete event value.

**Call relations**: The custom event-sink test calls this helper twice: once for the warning sent through the builder and once for the warning sent through the finished registry.

*Call graph*: called by 1 (custom_event_sink_survives_registry_build); 1 external calls (Warning).


### `ext/goal/tests/goal_extension_backend.rs`

`test` · `test run`

The goal extension lets a Codex thread have a named goal, such as “ship this feature,” and tracks progress against it. This test file builds a small fake world around that extension: a temporary state store, a registry of extension hooks, a pretend event sink, and helper methods that simulate thread starts, turns, tool finishes, token usage updates, errors, resumes, and stops. Think of it like a driving simulator for the goal system: instead of running the whole app, the tests press the same pedals and buttons the app would press.

The tests cover the important promises the backend must keep. Goal tools should be available for normal persistent threads, but hidden for temporary threads and review subagents. Creating a goal should fill an empty thread preview and should not replace an unfinished goal. Token accounting must start from the right baseline, avoid double-counting during parallel tool completions, continue after budget limits, and stop after usage-limit errors. The file also checks that goal status changes emit user-visible events, that resumed threads restart idle time tracking, and that the public GoalService API can set, get, and clear goals. Without these tests, regressions in goal progress, visibility, or event reporting could silently make the assistant’s goal tracking misleading.

#### Function details

##### `installed_goal_tools_create_goal_and_fill_empty_preview`  (lines 51–95)

```
async fn installed_goal_tools_create_goal_and_fill_empty_preview() -> anyhow::Result<()>
```

**Purpose**: Checks the happy path for creating a goal through the installed tool. It also verifies that if the thread had no preview text, the goal objective becomes that preview.

**Data flow**: It creates a temporary runtime and a known thread, seeds thread metadata, installs the goal tools, and calls create_goal with an objective and token budget. After the tool returns, it compares the JSON result and reads the thread metadata back to confirm the preview was filled.

**Call relations**: This test uses the setup helpers to install the extension as the app would, then finds and invokes the create_goal tool. It relies on the runtime state store for the final proof that the tool changed persistent thread data.

*Call graph*: calls 6 internal fn (installed_tools, seed_thread_metadata, test_runtime, test_thread_id, tool_by_name, tool_call); 2 external calls (assert_eq!, json!).


##### `goal_tools_hidden_for_ephemeral_threads`  (lines 98–111)

```
async fn goal_tools_hidden_for_ephemeral_threads() -> anyhow::Result<()>
```

**Purpose**: Confirms that goal tools are not shown for threads that do not have persistent state. Goals need storage, so exposing the tools for temporary threads would create work the backend cannot save.

**Data flow**: It starts a simulated thread with persistent storage marked unavailable, asks the extension registry for tools, and expects an empty tool-name list.

**Call relations**: The test goes through installed_tools_with_start, which runs the same thread-start hook that decides tool availability in real use.

*Call graph*: calls 3 internal fn (installed_tools_with_start, test_runtime, test_thread_id); 1 external calls (assert_eq!).


##### `goal_tools_hidden_for_review_subagents`  (lines 114–127)

```
async fn goal_tools_hidden_for_review_subagents() -> anyhow::Result<()>
```

**Purpose**: Confirms that review subagents do not receive goal tools. Review subagents are a special kind of helper session, and this test protects the rule that they should not create or change thread goals.

**Data flow**: It starts a simulated thread whose session source is a review subagent, collects available tools, and checks that none are returned.

**Call relations**: Like the ephemeral-thread test, it uses installed_tools_with_start so the visibility decision happens through the extension’s normal thread-start path.

*Call graph*: calls 3 internal fn (installed_tools_with_start, test_runtime, test_thread_id); 2 external calls (SubAgent, assert_eq!).


##### `installed_goal_tools_only_replace_complete_goal`  (lines 130–184)

```
async fn installed_goal_tools_only_replace_complete_goal() -> anyhow::Result<()>
```

**Purpose**: Checks that a new goal cannot replace an existing unfinished goal. It then verifies that replacement is allowed after the old goal is marked complete.

**Data flow**: It creates one goal, tries to create a second and expects a model-facing error, updates the first goal to complete, then creates a replacement goal. The final tool output is checked to make sure the replacement starts fresh and active.

**Call relations**: This test uses GoalExtensionHarness to keep the installed registry and stores alive across multiple tool calls, because the behavior depends on the thread’s accumulated goal state.

*Call graph*: calls 6 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, panic!).


##### `create_goal_resets_baseline_before_turn_stop_accounting`  (lines 187–243)

```
async fn create_goal_resets_baseline_before_turn_stop_accounting() -> anyhow::Result<()>
```

**Purpose**: Checks that creating a goal in the middle of a turn resets the token-counting starting point. Tokens spent before the goal exists should not count against that goal.

**Data flow**: It starts a turn with existing token usage, records more usage, creates a goal, records still more usage, and stops the turn. The stored goal should count only the tokens used after creation.

**Call relations**: The test drives the turn lifecycle through the harness and uses token_usage to create realistic token counters. It verifies the goal backend’s accounting at turn stop.

*Call graph*: calls 7 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, token_usage, tool_by_name, tool_call); 2 external calls (assert_eq!, json!).


##### `tool_finish_accounts_active_goal_progress_and_emits_event`  (lines 246–294)

```
async fn tool_finish_accounts_active_goal_progress_and_emits_event() -> anyhow::Result<()>
```

**Purpose**: Checks that finishing a tool call records progress for an active goal and sends a goal-updated event. This keeps the UI or other listeners informed as work advances.

**Data flow**: It starts a turn, creates a goal, clears earlier captured events, records token usage, and simulates a finished tool call. It then reads the stored goal and captured events to confirm both token count and notification.

**Call relations**: The harness supplies the tool-finish lifecycle event, while RecordingEventSink captures the extension’s outgoing event for inspection.

*Call graph*: calls 7 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, token_usage, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, default).


##### `parallel_tool_finish_accounts_active_goal_progress_once`  (lines 297–357)

```
async fn parallel_tool_finish_accounts_active_goal_progress_once() -> anyhow::Result<()>
```

**Purpose**: Checks that two tool completions happening at the same time do not double-count the same token progress. This protects against race conditions, where two tasks touch shared state at once.

**Data flow**: It starts a turn, creates a goal, records a token increase, then sends two tool-finish notifications concurrently. The stored goal should include the increase once, and only one progress event should be captured.

**Call relations**: This test uses the harness’s tool-finish notification from two async branches at once, stressing the backend’s locking and de-duplication behavior.

*Call graph*: calls 7 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, token_usage, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, join!).


##### `budget_limited_goal_keeps_accruing_until_turn_stop`  (lines 360–433)

```
async fn budget_limited_goal_keeps_accruing_until_turn_stop() -> anyhow::Result<()>
```

**Purpose**: Checks that a goal can pass its token budget but still keep accurate total usage until the turn fully stops. The status becomes budget-limited, but accounting does not freeze.

**Data flow**: It creates a goal with a small budget, records enough token usage to hit the budget at tool finish, records more usage, and then stops the turn. The final stored goal includes all tokens used, and events show both the budget hit and the later final total.

**Call relations**: The test combines tool-finish and turn-stop lifecycle events to confirm that both points can add progress to the same goal.

*Call graph*: calls 7 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, token_usage, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, default).


##### `budget_limited_goal_keeps_accounting_after_later_tool_finish`  (lines 436–491)

```
async fn budget_limited_goal_keeps_accounting_after_later_tool_finish() -> anyhow::Result<()>
```

**Purpose**: Checks that after a goal is already budget-limited, later tool completions still update the total token usage. Budget-limited is a status, not a signal to stop counting.

**Data flow**: It creates a budgeted goal, records usage that reaches the budget, sends one tool-finish event, records more usage, and sends another tool-finish event. The stored goal ends with the full token total and budget-limited status.

**Call relations**: This test uses repeated token updates and tool-finish notifications through the harness to cover the path after the first budget-limit transition.

*Call graph*: calls 7 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, token_usage, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, default).


##### `turn_error_usage_limit_accounts_progress_and_clears_accounting`  (lines 494–573)

```
async fn turn_error_usage_limit_accounts_progress_and_clears_accounting() -> anyhow::Result<()>
```

**Purpose**: Checks what happens when a turn ends because the user or system hits a usage limit. The backend should save progress so far, mark the goal usage-limited, and stop accepting later progress for that turn.

**Data flow**: It creates a goal, records usage, sends a usage-limit error, and verifies progress and events. It then records more usage and sends more lifecycle events, confirming the goal does not change after accounting was cleared.

**Call relations**: The test drives the turn-error hook through the harness and then deliberately sends later updates to prove the backend no longer tracks that finished error path.

*Call graph*: calls 7 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, token_usage, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, default).


##### `turn_error_blocks_goal`  (lines 576–603)

```
async fn turn_error_blocks_goal() -> anyhow::Result<()>
```

**Purpose**: Checks that a non-usage-limit turn error marks the active goal as blocked. This tells the rest of the system that work stopped because of a problem, not because the goal was done.

**Data flow**: It starts a turn, creates a goal, sends a generic turn error, and reads the stored goal. The expected result is a blocked status.

**Call relations**: The test uses the same tool creation and turn-error lifecycle hooks as the real extension flow, but focuses only on the final status transition.

*Call graph*: calls 6 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, default).


##### `usage_limit_budget_limited_goal_accounts_remaining_progress`  (lines 606–682)

```
async fn usage_limit_budget_limited_goal_accounts_remaining_progress() -> anyhow::Result<()>
```

**Purpose**: Checks a combined edge case: a goal that already hit its budget then receives a usage-limit signal. The backend should first account for any remaining progress, then mark the goal usage-limited.

**Data flow**: It creates a small-budget goal, records enough usage to become budget-limited, clears captured events, records more usage, and calls the runtime handle’s usage-limit method. The final goal has the larger token total and usage-limited status.

**Call relations**: This test calls the runtime handle directly after setting up the active turn through the harness, exercising the backend path used when usage limits are reported outside a normal turn-error callback.

*Call graph*: calls 7 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, token_usage, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, default).


##### `usage_limit_plan_turn_does_not_stop_goal`  (lines 685–719)

```
async fn usage_limit_plan_turn_does_not_stop_goal() -> anyhow::Result<()>
```

**Purpose**: Checks that a usage limit during a planning turn does not stop the goal. Planning mode is treated differently from normal execution work.

**Data flow**: It creates a goal, starts a turn in plan mode, clears events, and asks the runtime handle to apply a usage limit for that turn. The stored goal remains active and no goal events are emitted.

**Call relations**: The test uses start_turn_with_mode to simulate a plan turn, then calls the runtime handle path that would otherwise stop an active goal.

*Call graph*: calls 6 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, default).


##### `usage_limit_stale_turn_does_not_stop_current_goal`  (lines 722–756)

```
async fn usage_limit_stale_turn_does_not_stop_current_goal() -> anyhow::Result<()>
```

**Purpose**: Checks that a usage-limit notice for an old turn does not affect the current active goal. This prevents late or delayed signals from corrupting newer work.

**Data flow**: It starts and stops one turn with a goal, starts a second turn, then applies usage-limit handling to the old turn id. The stored goal stays active and no new events appear.

**Call relations**: The test uses the harness to create a stale-turn situation, then calls the runtime handle to confirm it ignores the outdated turn.

*Call graph*: calls 6 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, default).


##### `update_goal_can_block_and_accounts_final_progress`  (lines 759–838)

```
async fn update_goal_can_block_and_accounts_final_progress() -> anyhow::Result<()>
```

**Purpose**: Checks that updating a goal to blocked first records the latest token progress. This means the final blocked state still reflects the work already spent.

**Data flow**: It creates a goal, records token usage, calls update_goal with blocked status, and inspects both the tool response and stored goal. It also checks that events show the progress update and the blocked status update.

**Call relations**: This test invokes both create_goal and update_goal tools through the installed tool executors, while the event sink observes the notifications produced by the status change.

*Call graph*: calls 7 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, token_usage, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, default).


##### `external_goal_mutation_start_accounts_active_goal_progress`  (lines 841–890)

```
async fn external_goal_mutation_start_accounts_active_goal_progress() -> anyhow::Result<()>
```

**Purpose**: Checks that before an outside API changes a goal, the backend records current progress for the active goal. This avoids losing tokens spent since the last checkpoint.

**Data flow**: It creates a goal, records token usage, then calls prepare_external_goal_mutation on the runtime handle. The stored goal gains the pending token progress and one event is captured.

**Call relations**: The test uses the harness for normal setup but calls the runtime handle directly, matching the path used by GoalService before it changes goal state from outside tool execution.

*Call graph*: calls 7 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, token_usage, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, default).


##### `goal_service_external_set_active_resets_baseline_without_live_thread`  (lines 893–966)

```
async fn goal_service_external_set_active_resets_baseline_without_live_thread() -> anyhow::Result<()>
```

**Purpose**: Checks that setting a goal through GoalService resets accounting correctly even when the change comes from outside the live tool flow. Tokens before the new active goal should not be counted again.

**Data flow**: It starts a turn with an old goal and token usage, then uses GoalService to set a new objective and applies the returned runtime effects. After more usage and a tool finish, the stored goal reflects the full intended count without double-counting the pre-change baseline.

**Call relations**: This test ties the public GoalService API to the live runtime handle behavior, proving that external goal edits and turn accounting cooperate.

*Call graph*: calls 7 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, token_usage, tool_by_name, tool_call); 3 external calls (assert_eq!, Set, json!).


##### `thread_stop_unregisters_goal_runtime_from_service`  (lines 969–1006)

```
async fn thread_stop_unregisters_goal_runtime_from_service() -> anyhow::Result<()>
```

**Purpose**: Checks that stopping a thread unregisters its live goal runtime from the service. After that, clearing the stored goal should not emit live thread events.

**Data flow**: It creates a goal, records some token usage, stops the thread through lifecycle hooks, then clears the goal through GoalService. The clear succeeds, but the event sink stays empty.

**Call relations**: The test uses the harness’s stop_thread method to trigger cleanup, then uses GoalService to confirm no stale live runtime remains connected.

*Call graph*: calls 7 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, token_usage, tool_by_name, tool_call); 4 external calls (assert!, assert_eq!, json!, default).


##### `thread_resume_rehydrates_active_goal_idle_accounting`  (lines 1009–1052)

```
async fn thread_resume_rehydrates_active_goal_idle_accounting() -> anyhow::Result<()>
```

**Purpose**: Checks that resuming a thread with an existing active goal restarts idle time tracking. If no turn is running, elapsed wall-clock time should still be counted for the goal.

**Data flow**: It writes an active goal directly into state, creates the harness, resumes the thread, waits a little over one second, and prepares an external mutation. The stored goal remains active and its elapsed time increases.

**Call relations**: This test uses the thread-resume lifecycle hook and then the runtime handle’s external-mutation checkpoint to prove resumed accounting was restored.

*Call graph*: calls 4 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id); 4 external calls (from_millis, assert!, assert_eq!, sleep).


##### `goal_service_sets_gets_and_clears_thread_goal`  (lines 1055–1094)

```
async fn goal_service_sets_gets_and_clears_thread_goal() -> anyhow::Result<()>
```

**Purpose**: Checks the public GoalService operations for setting, reading, and clearing a goal. It also verifies that the service trims objective text and updates the thread preview.

**Data flow**: It creates a runtime and thread, calls set_thread_goal with an objective and budget, reads the goal back, reads thread metadata, then clears the goal twice. The first clear succeeds, the second reports that there was nothing left to clear.

**Call relations**: Unlike most tests here, this one talks directly to GoalService rather than going through installed tools, covering the API used by other parts of the system.

*Call graph*: calls 4 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id); 4 external calls (assert!, assert_eq!, Set, Set).


##### `installed_tools`  (lines 1096–1107)

```
async fn installed_tools(
    runtime: Arc<codex_state::StateRuntime>,
    thread_id: ThreadId,
) -> Vec<Arc<dyn ToolExecutor<ToolCall>>>
```

**Purpose**: Provides a short helper for installing the goal extension tools in the normal command-line thread case. Tests use it when they do not need special session settings.

**Data flow**: It receives a runtime and thread id, fills in default values for a persistent CLI thread, and returns the list of installed tool executors.

**Call relations**: It delegates the real setup to installed_tools_with_start and is called by the basic create-goal installation test.

*Call graph*: calls 1 internal fn (installed_tools_with_start); called by 1 (installed_goal_tools_create_goal_and_fill_empty_preview).


##### `installed_tools_with_start`  (lines 1109–1147)

```
async fn installed_tools_with_start(
    runtime: Arc<codex_state::StateRuntime>,
    thread_id: ThreadId,
    session_source: SessionSource,
    persistent_thread_state_available: bool,
) -> Vec<Arc<
```

**Purpose**: Builds an extension registry, installs the goal backend, simulates a thread start, and returns the tools made available for that thread. It lets tests vary whether the thread is persistent and what kind of session it is.

**Data flow**: It takes a runtime, thread id, session source, and persistence flag. It creates session and thread stores, runs every thread-start contributor, then gathers tools from the registry.

**Call relations**: This is the setup path used by the tool-visibility tests and by installed_tools. It mirrors the app’s extension-start process closely enough to test availability rules.

*Call graph*: calls 3 internal fn (disabled, new, new); called by 3 (goal_tools_hidden_for_ephemeral_threads, goal_tools_hidden_for_review_subagents, installed_tools); 5 external calls (new, new, new, install_with_backend, to_string).


##### `tool_names`  (lines 1149–1151)

```
fn tool_names(tools: &[Arc<dyn ToolExecutor<ToolCall>>]) -> Vec<String>
```

**Purpose**: Converts a list of tool executors into just their plain names. Tests use this to compare available tools without caring about the executor objects themselves.

**Data flow**: It reads each tool’s ToolName and collects the name field into a vector of strings. It does not change any state.

**Call relations**: It is used in tests that only need to prove no tools, or certain tools, are exposed after extension setup.


##### `GoalExtensionHarness::new`  (lines 1162–1201)

```
async fn new(
        runtime: Arc<codex_state::StateRuntime>,
        thread_id: ThreadId,
    ) -> anyhow::Result<Self>
```

**Purpose**: Creates a reusable test harness for the goal extension. The harness keeps the registry, stores, goal service, and recording event sink together so tests can simulate a live thread.

**Data flow**: It takes a state runtime and thread id, creates a recording sink and registry builder, installs the goal backend, creates session and thread stores, runs thread-start hooks, and returns the assembled harness.

**Call relations**: Most lifecycle and accounting tests call this first. Its result is then used to fetch tools, start turns, record token usage, and inspect emitted events.

*Call graph*: calls 3 internal fn (disabled, new, new); called by 16 (budget_limited_goal_keeps_accounting_after_later_tool_finish, budget_limited_goal_keeps_accruing_until_turn_stop, create_goal_resets_baseline_before_turn_stop_accounting, external_goal_mutation_start_accounts_active_goal_progress, goal_service_external_set_active_resets_baseline_without_live_thread, installed_goal_tools_only_replace_complete_goal, parallel_tool_finish_accounts_active_goal_progress_once, thread_resume_rehydrates_active_goal_idle_accounting, thread_stop_unregisters_goal_runtime_from_service, tool_finish_accounts_active_goal_progress_and_emits_event (+6 more)); 7 external calls (clone, new, with_event_sink, new, install_with_backend, default, to_string).


##### `GoalExtensionHarness::tools`  (lines 1203–1209)

```
fn tools(&self) -> Vec<Arc<dyn ToolExecutor<ToolCall>>>
```

**Purpose**: Returns the tool executors currently contributed by the installed extension for this harness’s session and thread. Tests use it to find create_goal or update_goal.

**Data flow**: It reads the registry’s tool contributors and asks each one for tools using the harness’s session and thread stores. It returns a combined list.

**Call relations**: This is the harness version of tool collection, used after GoalExtensionHarness::new has already simulated thread startup.

*Call graph*: calls 1 internal fn (tool_contributors).


##### `GoalExtensionHarness::start_turn`  (lines 1211–1214)

```
async fn start_turn(&self, turn_id: &str, usage: &TokenUsage)
```

**Purpose**: Starts a normal, default-mode turn in the harness. Tests use it when they want token accounting to behave like a regular assistant turn.

**Data flow**: It receives a turn id and starting token usage, then forwards them with the default mode to start_turn_with_mode.

**Call relations**: It is a convenience wrapper over start_turn_with_mode, keeping most tests short while still using the full turn-start lifecycle path.

*Call graph*: calls 1 internal fn (start_turn_with_mode).


##### `GoalExtensionHarness::start_turn_with_mode`  (lines 1216–1232)

```
async fn start_turn_with_mode(&self, turn_id: &str, mode: ModeKind, usage: &TokenUsage)
```

**Purpose**: Simulates the beginning of a turn, optionally in a special mode such as planning. This gives the goal extension a chance to initialize per-turn accounting.

**Data flow**: It creates a turn store, builds a collaboration mode, inserts the requested mode, and calls every turn-start contributor with the starting token usage and stores.

**Call relations**: GoalExtensionHarness::start_turn calls this for default turns, while tests that need plan mode call it directly.

*Call graph*: calls 3 internal fn (turn_lifecycle_contributors, new, default_collaboration_mode); called by 1 (start_turn).


##### `GoalExtensionHarness::stop_turn`  (lines 1234–1245)

```
async fn stop_turn(&self, turn_id: &str)
```

**Purpose**: Simulates the normal end of a turn. This lets the goal backend add any final progress and clean up per-turn accounting.

**Data flow**: It creates a turn store for the given turn id and calls every turn-stop contributor with the harness’s session and thread stores.

**Call relations**: Accounting tests call this after token usage changes to check what the extension records at turn completion.

*Call graph*: calls 2 internal fn (turn_lifecycle_contributors, new).


##### `GoalExtensionHarness::record_token_usage`  (lines 1247–1264)

```
async fn record_token_usage(&self, turn_id: &str, usage: &TokenUsage)
```

**Purpose**: Simulates a token-usage update during a turn. Token usage is the count of model input and output tokens, which the goal system uses as a measure of work spent.

**Data flow**: It wraps the provided total TokenUsage in a TokenUsageInfo object, creates a turn store, and sends the update to every token-usage contributor. It does not itself calculate progress; the extension under test does that.

**Call relations**: Many tests call this before tool finish, turn stop, or errors so the goal backend has fresh usage data to account.

*Call graph*: calls 2 internal fn (token_usage_contributors, new); 2 external calls (clone, default).


##### `GoalExtensionHarness::resume_thread`  (lines 1266–1275)

```
async fn resume_thread(&self)
```

**Purpose**: Simulates resuming an existing thread. This lets the goal extension restore any live runtime bookkeeping for an active stored goal.

**Data flow**: It calls every thread-resume contributor with the harness’s session and thread stores. Any resulting state is stored inside the extension data or backend service.

**Call relations**: The resume accounting test calls this before waiting and forcing an accounting checkpoint.

*Call graph*: calls 1 internal fn (thread_lifecycle_contributors).


##### `GoalExtensionHarness::stop_thread`  (lines 1277–1286)

```
async fn stop_thread(&self)
```

**Purpose**: Simulates stopping a thread. This gives the extension a chance to unregister live runtime state and avoid sending events after the thread is gone.

**Data flow**: It calls every thread-stop contributor with the harness’s stores. The expected side effect is cleanup inside the goal service or runtime handle.

**Call relations**: The thread-stop cleanup test uses this before clearing the goal through GoalService.

*Call graph*: calls 1 internal fn (thread_lifecycle_contributors).


##### `GoalExtensionHarness::notify_tool_finish`  (lines 1288–1305)

```
async fn notify_tool_finish(&self, turn_id: &str, call_id: &str, tool_name: &str)
```

**Purpose**: Simulates a tool call finishing successfully during a turn. The goal backend uses this moment as a checkpoint for token progress.

**Data flow**: It creates a turn store and plain tool name, then calls every tool-lifecycle contributor with the turn id, call id, tool name, source, and successful outcome.

**Call relations**: Accounting tests call this after record_token_usage to trigger progress recording and event emission.

*Call graph*: calls 3 internal fn (tool_lifecycle_contributors, new, plain).


##### `GoalExtensionHarness::notify_turn_error`  (lines 1307–1320)

```
async fn notify_turn_error(&self, turn_id: &str, error: CodexErrorInfo)
```

**Purpose**: Simulates a turn ending or failing with an error. The goal backend may mark the goal blocked or usage-limited depending on the error.

**Data flow**: It creates a turn store and calls every turn-lifecycle contributor’s error hook with the supplied error and harness stores. The extension under test updates stored goal state as needed.

**Call relations**: The usage-limit and generic-error tests use this to exercise error-specific status transitions.

*Call graph*: calls 2 internal fn (turn_lifecycle_contributors, new); 1 external calls (clone).


##### `GoalExtensionHarness::runtime_handle`  (lines 1322–1326)

```
fn runtime_handle(&self) -> Arc<GoalRuntimeHandle>
```

**Purpose**: Retrieves the live GoalRuntimeHandle stored for the harness’s thread. Tests use this when they need to call backend runtime operations directly instead of going through lifecycle hooks.

**Data flow**: It reads the thread extension store and expects to find a GoalRuntimeHandle there. It returns the shared handle or fails the test if setup did not create one.

**Call relations**: Tests use this for usage-limit handling and external goal mutation checkpoints, paths that are normally triggered by surrounding application code.


##### `tool_by_name`  (lines 1329–1337)

```
fn tool_by_name(
    tools: &'a [Arc<dyn ToolExecutor<ToolCall>>],
    name: &str,
) -> &'a Arc<dyn ToolExecutor<ToolCall>>
```

**Purpose**: Finds one installed tool executor by its plain name. It makes tests clear by letting them ask for create_goal or update_goal directly.

**Data flow**: It scans the provided tool list for a tool with no namespace and the requested name, then returns a reference to it. If the tool is missing, the test fails immediately.

**Call relations**: Most tool-based tests call this after collecting tools from either installed_tools or the harness.

*Call graph*: called by 16 (budget_limited_goal_keeps_accounting_after_later_tool_finish, budget_limited_goal_keeps_accruing_until_turn_stop, create_goal_resets_baseline_before_turn_stop_accounting, external_goal_mutation_start_accounts_active_goal_progress, goal_service_external_set_active_resets_baseline_without_live_thread, installed_goal_tools_create_goal_and_fill_empty_preview, installed_goal_tools_only_replace_complete_goal, parallel_tool_finish_accounts_active_goal_progress_once, thread_stop_unregisters_goal_runtime_from_service, tool_finish_accounts_active_goal_progress_and_emits_event (+6 more)).


##### `tool_call`  (lines 1339–1353)

```
fn tool_call(tool_name: &str, call_id: &str, arguments: serde_json::Value) -> ToolCall
```

**Purpose**: Builds a realistic ToolCall object for invoking a function-style tool in tests. This avoids repeating all the surrounding fields every time a test calls create_goal or update_goal.

**Data flow**: It takes a tool name, call id, and JSON arguments, then wraps them with a fixed turn id, model name, truncation policy, empty history, no-op emitter, and function payload. The result is ready to pass to a tool executor.

**Call relations**: Tool tests use this helper before calling a tool’s handle method, so the extension receives the same shape of input it would receive in production.

*Call graph*: calls 1 internal fn (plain); called by 16 (budget_limited_goal_keeps_accounting_after_later_tool_finish, budget_limited_goal_keeps_accruing_until_turn_stop, create_goal_resets_baseline_before_turn_stop_accounting, external_goal_mutation_start_accounts_active_goal_progress, goal_service_external_set_active_resets_baseline_without_live_thread, installed_goal_tools_create_goal_and_fill_empty_preview, installed_goal_tools_only_replace_complete_goal, parallel_tool_finish_accounts_active_goal_progress_once, thread_stop_unregisters_goal_runtime_from_service, tool_finish_accounts_active_goal_progress_and_emits_event (+6 more)); 5 external calls (new, to_string, new, Bytes, default).


##### `test_runtime`  (lines 1355–1358)

```
async fn test_runtime() -> anyhow::Result<Arc<codex_state::StateRuntime>>
```

**Purpose**: Creates a fresh temporary state runtime for a test. This keeps tests isolated so stored goals and thread metadata from one test cannot affect another.

**Data flow**: It creates a temporary directory and initializes StateRuntime inside it with a test provider name. It returns the runtime wrapped for shared ownership.

**Call relations**: Almost every test starts here before seeding thread metadata or installing the extension.

*Call graph*: calls 1 internal fn (init); called by 20 (budget_limited_goal_keeps_accounting_after_later_tool_finish, budget_limited_goal_keeps_accruing_until_turn_stop, create_goal_resets_baseline_before_turn_stop_accounting, external_goal_mutation_start_accounts_active_goal_progress, goal_service_external_set_active_resets_baseline_without_live_thread, goal_service_sets_gets_and_clears_thread_goal, goal_tools_hidden_for_ephemeral_threads, goal_tools_hidden_for_review_subagents, installed_goal_tools_create_goal_and_fill_empty_preview, installed_goal_tools_only_replace_complete_goal (+10 more)); 1 external calls (new).


##### `test_thread_id`  (lines 1360–1362)

```
fn test_thread_id() -> anyhow::Result<ThreadId>
```

**Purpose**: Provides a stable thread id for tests. A fixed id makes expected JSON and event ids easy to compare.

**Data flow**: It parses a known UUID-like string into a ThreadId and converts any parse problem into an anyhow error. The output is the thread id used by the tests.

**Call relations**: Most tests call this alongside test_runtime so they can seed and query the same thread consistently.

*Call graph*: calls 1 internal fn (from_string); called by 20 (budget_limited_goal_keeps_accounting_after_later_tool_finish, budget_limited_goal_keeps_accruing_until_turn_stop, create_goal_resets_baseline_before_turn_stop_accounting, external_goal_mutation_start_accounts_active_goal_progress, goal_service_external_set_active_resets_baseline_without_live_thread, goal_service_sets_gets_and_clears_thread_goal, goal_tools_hidden_for_ephemeral_threads, goal_tools_hidden_for_review_subagents, installed_goal_tools_create_goal_and_fill_empty_preview, installed_goal_tools_only_replace_complete_goal (+10 more)).


##### `seed_thread_metadata`  (lines 1364–1377)

```
async fn seed_thread_metadata(
    runtime: &codex_state::StateRuntime,
    thread_id: ThreadId,
) -> anyhow::Result<()>
```

**Purpose**: Creates basic thread metadata in the temporary state store before a test uses goals. Goal operations often expect the thread to already exist.

**Data flow**: It builds metadata with the thread id, a rollout file path under the runtime’s home directory, the current time, and CLI session source, then upserts it into state.

**Call relations**: Tests call this after creating the runtime and thread id, before installing tools or using GoalService.

*Call graph*: calls 2 internal fn (new, codex_home); called by 18 (budget_limited_goal_keeps_accounting_after_later_tool_finish, budget_limited_goal_keeps_accruing_until_turn_stop, create_goal_resets_baseline_before_turn_stop_accounting, external_goal_mutation_start_accounts_active_goal_progress, goal_service_external_set_active_resets_baseline_without_live_thread, goal_service_sets_gets_and_clears_thread_goal, installed_goal_tools_create_goal_and_fill_empty_preview, installed_goal_tools_only_replace_complete_goal, parallel_tool_finish_accounts_active_goal_progress_once, thread_resume_rehydrates_active_goal_idle_accounting (+8 more)); 3 external calls (now, format!, upsert_thread).


##### `RecordingEventSink::goal_events`  (lines 1385–1398)

```
fn goal_events(&self) -> Vec<CapturedGoalEvent>
```

**Purpose**: Extracts only goal-update events from all captured events. This gives tests a small, focused view of what the extension announced.

**Data flow**: It locks the recorded event list, filters for ThreadGoalUpdated messages, and converts each one into a CapturedGoalEvent containing event id, turn id, status, and tokens used.

**Call relations**: Assertions use this after actions that should emit progress or status updates. It depends on events captured by RecordingEventSink::emit.

*Call graph*: calls 1 internal fn (events).


##### `RecordingEventSink::clear`  (lines 1400–1402)

```
fn clear(&self)
```

**Purpose**: Clears all recorded events. Tests use it to ignore setup events and focus only on the events caused by the next action.

**Data flow**: It locks the internal event vector and removes all entries. The sink remains usable afterward.

**Call relations**: Many tests call this after creating a goal, so later assertions only see tool-finish, error, or status-change events.

*Call graph*: calls 1 internal fn (events).


##### `RecordingEventSink::events`  (lines 1404–1406)

```
fn events(&self) -> std::sync::MutexGuard<'_, Vec<Event>>
```

**Purpose**: Safely opens the sink’s internal event list. It uses a mutex, which is a lock that stops two tasks from changing the list at the same time.

**Data flow**: It locks the event vector and returns the lock guard. If a previous holder panicked and poisoned the lock, it still recovers the inner data for test purposes.

**Call relations**: This helper is used by goal_events, clear, and emit so all event-list access goes through the same locking behavior.

*Call graph*: called by 3 (clear, emit, goal_events).


##### `RecordingEventSink::emit`  (lines 1410–1412)

```
fn emit(&self, event: Event)
```

**Purpose**: Implements the extension event sink by recording each emitted event in memory. This lets tests inspect events instead of sending them to a real client.

**Data flow**: It receives an Event, locks the internal list through events, and pushes the event into that list. It does not return a value.

**Call relations**: The extension registry calls this whenever the goal backend emits an event; test assertions later read those events through goal_events.

*Call graph*: calls 1 internal fn (events).


##### `default_collaboration_mode`  (lines 1423–1432)

```
fn default_collaboration_mode() -> CollaborationMode
```

**Purpose**: Builds a default collaboration-mode object for simulated turns. It supplies the mode and model settings that turn-start hooks expect.

**Data flow**: It creates a CollaborationMode with default mode and simple test settings such as model name gpt-5. The caller may then override the mode.

**Call relations**: GoalExtensionHarness::start_turn_with_mode calls this before notifying turn-start contributors.

*Call graph*: called by 1 (start_turn_with_mode).


##### `token_usage`  (lines 1434–1448)

```
fn token_usage(
    input_tokens: i64,
    cached_input_tokens: i64,
    output_tokens: i64,
    reasoning_output_tokens: i64,
    total_tokens: i64,
) -> TokenUsage
```

**Purpose**: Creates a TokenUsage value from explicit counts. Tests use it to describe exactly how many input, cached input, output, reasoning, and total tokens have been used.

**Data flow**: It takes five integer counts and places them into a TokenUsage struct. The result is passed into turn starts or token-usage updates.

**Call relations**: Most accounting tests use this helper to create clear before-and-after token totals for the goal backend to compare.

*Call graph*: called by 11 (budget_limited_goal_keeps_accounting_after_later_tool_finish, budget_limited_goal_keeps_accruing_until_turn_stop, create_goal_resets_baseline_before_turn_stop_accounting, external_goal_mutation_start_accounts_active_goal_progress, goal_service_external_set_active_resets_baseline_without_live_thread, parallel_tool_finish_accounts_active_goal_progress_once, thread_stop_unregisters_goal_runtime_from_service, tool_finish_accounts_active_goal_progress_and_emits_event, turn_error_usage_limit_accounts_progress_and_clears_accounting, update_goal_can_block_and_accounts_final_progress (+1 more)).


##### `protocol_status`  (lines 1450–1459)

```
fn protocol_status(status: codex_state::ThreadGoalStatus) -> ThreadGoalStatus
```

**Purpose**: Converts the state-layer goal status into the protocol-layer goal status used in emitted events and API-facing assertions. The two enums have the same meanings but live in different crates.

**Data flow**: It receives a codex_state ThreadGoalStatus and returns the matching codex_protocol ThreadGoalStatus variant. No state is changed.

**Call relations**: Tests use this when comparing stored state to protocol-shaped expectations, especially for active goals.


### `ext/image-generation/src/tests.rs`

`test` · `test run`

This is a safety net for the image-generation tool. The tool can either create a new image from a text prompt or edit existing images. These tests make sure it makes the right choice and uses predictable defaults, such as the image model, quality, size, and background settings. They also check the rules around choosing input images: a caller may give explicit image file paths, or ask for the last few images from the conversation, but not both. If the caller asks for too many images, or asks for more recent images than exist, the tool must return a clear error instead of guessing.

A large part of the file builds small fake conversation histories. These histories include images from user messages, normal function-tool outputs, code-mode tool outputs, and previous image generation calls. The tests then confirm that the newest images are selected while still being passed to the edit request in their original time order. Think of it like picking the last four photos from an album, then laying them out oldest-to-newest before editing them.

The file also tests how generated images are returned. The result is base64 image data, wrapped as an input image so the model can see it later. If there is a short save-location hint, it is included as text; if the hint is too large, it is left out to avoid bloating the response.

#### Function details

##### `uses_reserved_image_gen_namespace`  (lines 31–38)

```
fn uses_reserved_image_gen_namespace()
```

**Purpose**: This test confirms that the image-generation extension registers itself under the reserved image-generation namespace and exposes the expected function name. This matters because other parts of the system look for the tool by those exact names.

**Data flow**: It asks imagegen_tool_spec for the tool description, checks that the description is a namespace-style tool, then compares the namespace name and the first function name against the constants used by the extension. If the shape or names are wrong, the test fails.

**Call relations**: During the test suite, this function calls imagegen_tool_spec as a consumer would when discovering available tools. It uses assertions to prove that the advertised tool identity matches the reserved names, and panics if the tool is not advertised in the expected namespace form.

*Call graph*: 3 external calls (assert_eq!, panic!, imagegen_tool_spec).


##### `omitted_references_generate_with_fixed_defaults`  (lines 41–63)

```
async fn omitted_references_generate_with_fixed_defaults()
```

**Purpose**: This test checks the simplest use case: the caller gives only a text prompt and no existing images. The expected behavior is a new image generation request with fixed, known defaults.

**Data flow**: It starts with ImagegenArgs containing a prompt and no image selectors, plus empty conversation history and no extra context. The request-building code turns that into an ImageRequest::Generate with the same prompt, the gpt-image-2 model, automatic background and quality, automatic size, and no explicit image count. The test compares the whole request to the expected value.

**Call relations**: This test exercises the request-building path used when the image tool is called without reference images. It does not hand off to later network work; it stops at verifying the request object that would be sent to the image API.

*Call graph*: 1 external calls (assert_eq!).


##### `recent_image_fallback_selects_newest_images_in_chronological_order`  (lines 66–139)

```
async fn recent_image_fallback_selects_newest_images_in_chronological_order()
```

**Purpose**: This test checks that, when the caller asks for recent conversation images instead of giving file paths, the tool finds the newest usable images and sends them to the edit API in a sensible order. It protects against accidentally editing the wrong images or reversing their order.

**Data flow**: It builds a fake conversation containing several image sources: user-provided images, a function-tool image output, a code-mode tool output, a previous image-generation result, and an orphaned tool output. The input asks for the last four images. The request builder filters and selects the valid recent images, ignores the orphan, and returns an edit request containing user-2, mcp, code-mode, and generated in chronological order.

**Call relations**: This test represents a real conversation where images can arrive from several places. It feeds that history into the request-building logic, then uses expected_edit_request to describe the exact edit request that should come out.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `conflicting_image_selectors_return_tool_error`  (lines 142–163)

```
async fn conflicting_image_selectors_return_tool_error()
```

**Purpose**: This test confirms that callers cannot specify both explicit image paths and a request to use recent conversation images. The tool must reject that ambiguous instruction instead of choosing one silently.

**Data flow**: It creates arguments with one referenced image path and also asks for one recent image. The request-building function sees both selectors, returns an error, and the test checks that the error message clearly says to provide only one of the two options.

**Call relations**: This test calls request_for_call_args in a deliberately invalid way. It verifies the validation step that runs before any image files are read or any image API request is built.

*Call graph*: 3 external calls (assert_eq!, request_for_call_args, vec!).


##### `too_many_referenced_image_paths_return_tool_error`  (lines 166–191)

```
async fn too_many_referenced_image_paths_return_tool_error()
```

**Purpose**: This test enforces the limit on how many explicit image paths may be used for an edit request. The limit prevents oversized or unsupported edit requests.

**Data flow**: It builds six absolute image paths and passes them as referenced_image_paths. The request builder rejects the input before trying to read those files, and the test checks for the exact message saying that at most five paths are allowed.

**Call relations**: This test exercises the early validation part of request_for_call_args. Its place in the larger flow is to make sure bad input is caught before the extension does any disk access or prepares a request for the image service.

*Call graph*: 2 external calls (assert_eq!, request_for_call_args).


##### `recent_image_fallback_requires_requested_count`  (lines 194–217)

```
async fn recent_image_fallback_requires_requested_count()
```

**Purpose**: This test checks that asking for recent images is strict: if the caller asks for two images, one available image is not enough. This avoids surprising edits based on fewer references than the caller requested.

**Data flow**: It creates a conversation history with only one image, then asks the request builder to include the last two images. The builder counts the available images, sees there are not enough, returns an error, and the test checks the message that reports both the requested count and the available count.

**Call relations**: This test calls request_for_call_args with incomplete history. It verifies that the recent-image fallback path refuses to continue when it cannot satisfy the caller's requested image count.

*Call graph*: 3 external calls (assert_eq!, request_for_call_args, vec!).


##### `generated_output_returns_image_input_and_output_hint`  (lines 220–248)

```
fn generated_output_returns_image_input_and_output_hint()
```

**Purpose**: This test checks how a successful generated image is packaged for the model after the tool finishes. The response should include the generated image itself and, when short enough, a text hint about where it was saved.

**Data flow**: It creates a small base64 image result and asks extension_image_generation_output_hint to make a save hint. A GeneratedImageOutput is converted into a function-call output item. The test opens that response and verifies that it contains two content items: an input image with a data URL, and input text containing the hint.

**Call relations**: This test uses function_payload to mimic the original tool call payload, then exercises GeneratedImageOutput's response conversion. It checks the handoff point where the image-generation extension returns data back into the conversation stream.

*Call graph*: calls 1 internal fn (function_payload); 3 external calls (assert_eq!, extension_image_generation_output_hint, panic!).


##### `generated_output_returns_generated_image_helper_input_in_code_mode`  (lines 251–264)

```
fn generated_output_returns_generated_image_helper_input_in_code_mode()
```

**Purpose**: This test checks the special result format used in code mode. Instead of returning conversation content items, code mode receives a small JSON object with the image URL and save hint.

**Data flow**: It creates a GeneratedImageOutput with base64 image data and a hint string. Calling code_mode_result turns that into JSON with an image_url field containing a data URL and an output_hint field containing the hint. The test compares the JSON exactly.

**Call relations**: This test covers the code-mode branch of generated-image output. It proves that code-mode callers get a compact helper-friendly structure rather than the normal function-call output content.

*Call graph*: 1 external calls (assert_eq!).


##### `generated_output_omits_oversized_output_hint`  (lines 267–291)

```
fn generated_output_omits_oversized_output_hint()
```

**Purpose**: This test ensures that overly large save hints are not included in the tool output. The image should still be returned, but the extra text is dropped to keep the response small and safe.

**Data flow**: It builds a very long path, asks extension_image_generation_output_hint to make a hint, and places that optional hint into a GeneratedImageOutput. After converting to a function-call output item, the test checks that the response contains only the image content item and no text hint.

**Call relations**: Like the shorter-hint test, this uses function_payload and checks GeneratedImageOutput's conversion into a response item. It focuses on the size guard that decides whether extra hint text is passed along.

*Call graph*: calls 1 internal fn (function_payload); 3 external calls (assert_eq!, extension_image_generation_output_hint, panic!).


##### `input_image`  (lines 293–298)

```
fn input_image(image: &str) -> ContentItem
```

**Purpose**: This helper creates a fake user input image for tests. It saves each test from repeating the same content-item construction code.

**Data flow**: It receives a short image marker string, wraps it in a data URL that looks like base64 PNG data, and returns a ContentItem::InputImage with no detail setting. The marker becomes the visible payload inside the fake image URL.

**Call relations**: The conversation-history tests call this helper when they need user-message images. Those fake images are then read by the request-building logic as if they had appeared in a real conversation.

*Call graph*: 1 external calls (format!).


##### `image_output`  (lines 300–305)

```
fn image_output(image: &str) -> FunctionCallOutputPayload
```

**Purpose**: This helper creates a fake tool output that contains one image. It is used to simulate images produced by other tools or earlier calls.

**Data flow**: It receives an image marker string, turns it into a data URL, places that inside a FunctionCallOutputContentItem::InputImage, and wraps the item in a FunctionCallOutputPayload. The result looks like a real function-tool image output to the request builder.

**Call relations**: The recent-image history test uses this helper for function-call and code-mode outputs. It lets the test check whether images from tool outputs are discovered and selected correctly.

*Call graph*: calls 1 internal fn (from_content_items); 1 external calls (vec!).


##### `expected_edit_request`  (lines 307–322)

```
fn expected_edit_request(prompt: &str, images: &[&str]) -> ImageEditRequest
```

**Purpose**: This helper builds the exact image edit request that a test expects. It keeps the expected request readable while still checking all important defaults.

**Data flow**: It takes a prompt and a list of image marker strings. Each marker becomes an ImageUrl data URL, and the helper returns an ImageEditRequest with those images, the prompt, the gpt-image-2 model, automatic background and quality, automatic size, and no explicit image count.

**Call relations**: The recent-image selection test uses this helper to describe the correct edit request after images have been chosen from history. It mirrors the expected output of request_for_call_args for edit operations.


##### `function_payload`  (lines 324–328)

```
fn function_payload() -> ToolPayload
```

**Purpose**: This helper creates a minimal fake function-tool payload for output-format tests. It represents a tool call with empty JSON arguments.

**Data flow**: It takes no input and returns ToolPayload::Function with the arguments string set to {}. Nothing else is changed.

**Call relations**: The generated-output tests call this helper when converting GeneratedImageOutput into response items. It supplies the small piece of call context needed by that conversion without distracting from what the tests are really checking.

*Call graph*: called by 2 (generated_output_omits_oversized_output_hint, generated_output_returns_image_input_and_output_hint).


### `ext/memories/src/tests.rs`

`test` · `test run`

The memories extension gives Codex a small, file-backed memory area. This test file acts like a checklist for that feature: when the extension is enabled, the right tools should be offered; when it is disabled or not configured, nothing should leak into the session. The tests also verify the contract of the tools themselves. For example, the ad-hoc note tool must describe its required filename format, create a note in the expected folder, and reject filenames that look like paths so a caller cannot write outside the intended area. The read tool is tested with line offsets and limits, so callers get the requested slice of a memory file rather than the whole file. The search tool is tested for multiple search words, for “all words within this many lines” matching, and for rejecting an older single-query input shape. A useful way to think about this file is as a rehearsal room: it creates temporary memory folders, runs the same tools a real model would call, and checks the exact responses. Two small helper functions at the bottom keep those rehearsals focused by finding a named memory tool and building its namespaced tool name.

#### Function details

##### `memory_tool_namespace_matches_responses_api_identifier`  (lines 27–34)

```
fn memory_tool_namespace_matches_responses_api_identifier()
```

**Purpose**: This test checks that the shared namespace used for memory tools is valid for the external tool API. The namespace must not be empty and must only contain simple characters that the API accepts.

**Data flow**: It reads the memory tool namespace constant from the crate, checks that there is at least one character, then checks every byte for allowed letters, numbers, underscores, or dashes. Nothing is returned; the test passes if the namespace fits the contract and fails otherwise.

**Call relations**: This is an early contract test for all memory tools. Other tests build full tool names from the same namespace through memory_tool_name, so this test protects the shared prefix they all rely on.

*Call graph*: 1 external calls (assert!).


##### `tools_are_not_contributed_without_thread_config`  (lines 37–48)

```
fn tools_are_not_contributed_without_thread_config()
```

**Purpose**: This test makes sure the memories extension stays quiet when the current thread has no memory settings. Without this, tools could appear in sessions that never opted into memory.

**Data flow**: It creates a default memories extension and empty session and thread data stores. It asks the extension for its tools, then checks that the returned list is empty.

**Call relations**: This tests the extension directly, before any registry setup. It is the baseline case that later tests contrast with configured enabled and disabled states.

*Call graph*: 2 external calls (assert!, default).


##### `tools_are_not_contributed_when_disabled`  (lines 51–65)

```
fn tools_are_not_contributed_when_disabled()
```

**Purpose**: This test confirms that an explicit “disabled” setting prevents memory tools from being offered. That matters because configuration should be able to turn the feature off completely.

**Data flow**: It creates a thread data store, inserts a memory configuration with enabled set to false, and gives it a test Codex home path. It asks the extension for tools and expects no tools back.

**Call relations**: This builds on the direct extension check used by tools_are_not_contributed_without_thread_config. It proves that even if memory settings exist, the enabled flag is respected before tool contribution happens.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, test_path_buf, default).


##### `tools_are_not_contributed_when_dedicated_tools_disabled`  (lines 68–82)

```
fn tools_are_not_contributed_when_dedicated_tools_disabled()
```

**Purpose**: This test checks that memory can be enabled without exposing the dedicated memory tools. This supports configurations where memory may still contribute prompt text but not add callable tools.

**Data flow**: It inserts a thread memory configuration where enabled is true but dedicated_tools is false. It asks the extension for tools and verifies the result is empty.

**Call relations**: This sits between the fully disabled and fully enabled tests. It shows that the extension has two gates: memory must be enabled, and dedicated tools must also be enabled before tools are advertised.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, test_path_buf, default).


##### `tools_are_contributed_when_enabled_with_dedicated_tools`  (lines 85–109)

```
fn tools_are_contributed_when_enabled_with_dedicated_tools()
```

**Purpose**: This test verifies the happy path for tool contribution. When memory is enabled and dedicated tools are allowed, the extension should offer exactly the expected memory tools.

**Data flow**: It creates a configured thread store with enabled and dedicated_tools both true. It asks the extension for tools, extracts their names, and compares them with the expected add-note, list, read, and search tool names.

**Call relations**: This is the positive counterpart to the earlier negative contribution tests. It uses memory_tool_name to express the same namespacing convention that real tool calls use.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, test_path_buf, default).


##### `install_registers_dedicated_tool_contributor`  (lines 112–139)

```
fn install_registers_dedicated_tool_contributor()
```

**Purpose**: This test checks that installing the memories extension into the central extension registry actually registers its tool contributor. It protects the wiring, not just the extension object in isolation.

**Data flow**: It creates a registry builder, calls the crate’s install function, builds the registry, and prepares enabled thread memory settings. It asks every registered tool contributor for tools and compares the resulting names with the expected memory tool names.

**Call relations**: Earlier tests call MemoriesExtension directly. This one goes through install, which is the path the broader application would use, so it catches mistakes where the extension exists but is not connected to the registry.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert_eq!, test_path_buf, install).


##### `ad_hoc_tool_definition_includes_filename_contract`  (lines 142–159)

```
fn ad_hoc_tool_definition_includes_filename_contract()
```

**Purpose**: This test makes sure the ad-hoc note tool tells callers exactly what filename format it requires. That is important because the model or client needs clear instructions before calling the tool.

**Data flow**: It finds the ad-hoc note tool for a test memory root, serializes the tool specification to JSON, and looks up the filename parameter. It checks that the parameter is a string and that its description mentions the required timestamp-and-slug markdown filename shape.

**Call relations**: It uses memory_tool to retrieve the real tool definition rather than a mock. This connects the public schema seen by callers to the validation behavior checked later in add_ad_hoc_note_tool_rejects_paths_as_filenames.

*Call graph*: calls 1 internal fn (memory_tool); 4 external calls (new, assert!, assert_eq!, to_value).


##### `prompt_contribution_uses_memory_summary_when_enabled`  (lines 162–194)

```
async fn prompt_contribution_uses_memory_summary_when_enabled()
```

**Purpose**: This test verifies that, when memory is enabled, a stored memory summary is added to the prompt in the right place. In plain terms, it checks that remembered guidance can be shown to the model as developer policy text.

**Data flow**: It creates a temporary directory, adds a memories folder, writes a memory_summary.md file, and configures the extension with memory enabled. It asks the extension to contribute prompt fragments and checks that exactly one fragment appears, that it goes into the DeveloperPolicy prompt slot, and that it contains the summary text.

**Call relations**: This exercises the context-contribution side of the extension rather than the tool side. It also shows why tools_are_not_contributed_when_dedicated_tools_disabled can still be useful: dedicated tools are off here, but prompt memory contribution still works because memory itself is enabled.

*Call graph*: calls 1 internal fn (new); 6 external calls (assert!, assert_eq!, default, tempdir, create_dir_all, write).


##### `add_ad_hoc_note_tool_creates_note_file`  (lines 197–238)

```
async fn add_ad_hoc_note_tool_creates_note_file()
```

**Purpose**: This test checks that the ad-hoc note tool writes a new memory note file in the expected location. It proves that a tool call from the model can become a real saved note.

**Data flow**: It creates a temporary memory root, finds the ad-hoc note tool, and builds a tool-call payload containing a valid filename and note text. It runs the tool, checks that the tool response is an empty success object, then reads the created file and verifies that it contains the note text.

**Call relations**: The test uses memory_tool to get the real executor and memory_tool_name to build the call name used inside ToolCall. It then follows the same path a live tool invocation would follow, from JSON arguments to file creation.

*Call graph*: calls 2 internal fn (memory_tool, memory_tool_name); 7 external calls (new, new, assert_eq!, json!, Bytes, tempdir, default).


##### `add_ad_hoc_note_tool_rejects_paths_as_filenames`  (lines 241–273)

```
async fn add_ad_hoc_note_tool_rejects_paths_as_filenames()
```

**Purpose**: This test makes sure the ad-hoc note tool does not accept a filename that tries to act like a path. This prevents a caller from escaping the notes folder with input such as ../something.md.

**Data flow**: It creates a temporary memory root and calls the ad-hoc note tool with a filename containing ../. Instead of accepting the call, the tool returns an error. The test checks that the error mentions the filename problem and the expected timestamp format.

**Call relations**: This is the safety-focused counterpart to add_ad_hoc_note_tool_creates_note_file. Both use the same helper path through memory_tool, but this one expects validation to stop the operation before anything is written.

*Call graph*: calls 2 internal fn (memory_tool, memory_tool_name); 8 external calls (new, new, assert!, json!, panic!, Bytes, tempdir, default).


##### `read_tool_reads_memory_file`  (lines 276–322)

```
async fn read_tool_reads_memory_file()
```

**Purpose**: This test verifies that the read tool can return a chosen section of a memory file. It checks line-based reading, including where the returned content starts and whether more content was left out.

**Data flow**: It creates a temporary memory file with three lines, calls the read tool with a path, a starting line offset, and a maximum number of lines. The tool returns JSON containing the requested one-line content, the path, the starting line number, and a truncated flag showing that not all lines were returned.

**Call relations**: The test uses memory_tool to obtain the read executor and memory_tool_name to name the call. It complements the search tests: read retrieves known content by position, while search finds content by words.

*Call graph*: calls 2 internal fn (memory_tool, memory_tool_name); 9 external calls (new, new, assert_eq!, json!, Bytes, tempdir, create_dir_all, write, default).


##### `search_tool_accepts_multiple_queries`  (lines 325–396)

```
async fn search_tool_accepts_multiple_queries()
```

**Purpose**: This test checks that the search tool accepts more than one search term and reports which terms matched each line. This lets callers search memory for several related ideas in one request.

**Data flow**: It writes a memory file containing lines with alpha, needle, and both words. It calls the search tool with the queries array and case-insensitive matching. The output lists three matches, each with its file path, line numbers, content, and the specific query or queries found there.

**Call relations**: This is the main positive test for the current search input shape. It also supports search_tool_rejects_legacy_single_query by showing that the accepted field is queries, not the older query field.

*Call graph*: calls 2 internal fn (memory_tool, memory_tool_name); 9 external calls (new, new, assert_eq!, json!, Bytes, tempdir, create_dir_all, write, default).


##### `search_tool_accepts_windowed_all_match_mode`  (lines 399–457)

```
async fn search_tool_accepts_windowed_all_match_mode()
```

**Purpose**: This test verifies the search mode that requires all query terms to appear within a small line window. It is useful when related information is spread across nearby lines instead of appearing on one line.

**Data flow**: It writes a three-line memory file where alpha is on the first line and needle is on the third. It calls the search tool with two queries and an all_within_lines mode set to three lines. The result is one match containing the full three-line window and both matched queries.

**Call relations**: This extends the basic search test by checking a more specific matching rule. It uses the same tool lookup and call path, but the payload asks the search implementation to group nearby lines together.

*Call graph*: calls 2 internal fn (memory_tool, memory_tool_name); 9 external calls (new, new, assert_eq!, json!, Bytes, tempdir, create_dir_all, write, default).


##### `search_tool_rejects_legacy_single_query`  (lines 460–494)

```
async fn search_tool_rejects_legacy_single_query()
```

**Purpose**: This test confirms that the search tool rejects the old single-query input field. That keeps the tool interface strict and avoids silently accepting outdated calls.

**Data flow**: It creates a temporary memory root, calls the search tool with a JSON payload containing query instead of queries, and expects an error. The test then checks that the error says an unknown field was provided and names query.

**Call relations**: This is the negative counterpart to search_tool_accepts_multiple_queries. Together they define the supported search contract: callers must use the newer queries list.

*Call graph*: calls 2 internal fn (memory_tool, memory_tool_name); 9 external calls (new, new, assert!, json!, panic!, Bytes, tempdir, create_dir_all, default).


##### `memory_tool`  (lines 496–505)

```
fn memory_tool(memory_root: &Path, tool_name: &str) -> Arc<dyn ToolExecutor<ToolCall>>
```

**Purpose**: This helper finds one concrete memory tool executor by name for the tests. It saves each test from repeating the setup needed to build the local memory backend and search through all available tools.

**Data flow**: It receives a memory root folder and a plain tool name. It turns the plain name into a namespaced name, builds the memory tools backed by that folder, searches for the matching tool, and returns it wrapped in a shared pointer. If the tool is missing, it stops the test with a clear failure message.

**Call relations**: Several tool-behavior tests call this helper before making a simulated tool call or inspecting a tool specification. Inside, it delegates name construction to memory_tool_name and tool creation to the crate’s memory_tools function using a LocalMemoriesBackend.

*Call graph*: calls 3 internal fn (from_memory_root, memory_tool_name, memory_tools); called by 7 (ad_hoc_tool_definition_includes_filename_contract, add_ad_hoc_note_tool_creates_note_file, add_ad_hoc_note_tool_rejects_paths_as_filenames, read_tool_reads_memory_file, search_tool_accepts_multiple_queries, search_tool_accepts_windowed_all_match_mode, search_tool_rejects_legacy_single_query).


##### `memory_tool_name`  (lines 507–509)

```
fn memory_tool_name(tool_name: &str) -> ToolName
```

**Purpose**: This helper builds the full public name for a memory tool by adding the memory-tool namespace. It keeps tests using the same naming style as the real tool API.

**Data flow**: It receives a short tool name such as the read or search tool name. It combines that with the crate’s memory namespace and returns a ToolName value.

**Call relations**: The helper is used both by memory_tool when finding a tool and by the tool-call tests when constructing the ToolCall. This keeps lookup names and call names aligned, like using the same address label on both the mailbox and the letter.

*Call graph*: calls 1 internal fn (namespaced); called by 7 (add_ad_hoc_note_tool_creates_note_file, add_ad_hoc_note_tool_rejects_paths_as_filenames, memory_tool, read_tool_reads_memory_file, search_tool_accepts_multiple_queries, search_tool_accepts_windowed_all_match_mode, search_tool_rejects_legacy_single_query).


### `memories/write/src/extensions/ad_hoc_tests.rs`

`test` · `test run`

This is a focused test file for the ad-hoc memory extension. The feature being tested is “seeding” instructions: creating a default instructions.md file in the right memory folder so the system has something useful to start from. The risk is that this setup step might be run more than once. If it blindly rewrote the file every time, it could erase a user’s own instructions. This test makes sure that does not happen.

The test creates a temporary Codex home folder, like setting up a clean sandbox rather than touching a real user’s files. It builds the expected path to the ad-hoc instructions file, runs the seeding function, and checks that the file now contains the built-in default text. Then it simulates a user editing that file by writing “custom instructions” into it. Finally, it runs the seeding function again and checks that the custom text is still there.

In everyday terms, this test is like checking that a hotel puts a welcome card in an empty room, but does not replace a guest’s handwritten note after they have moved in.

#### Function details

##### `seeds_instructions_without_overwriting_existing_file`  (lines 7–36)

```
async fn seeds_instructions_without_overwriting_existing_file()
```

**Purpose**: This test proves that default ad-hoc instructions are created only when the instructions file is missing. It also proves that running the setup again leaves an already edited file alone.

**Data flow**: It starts with a fresh temporary folder and derives the path where the ad-hoc instructions file should live. It runs the instruction-seeding step, then reads the file back and compares it with the built-in default instructions. Next it overwrites that file with custom text, runs the seeding step again, and reads the file once more. The final result should still be the custom text, showing that existing user content was not overwritten.

**Call relations**: During the test, it asks the temporary-directory helper to create a safe sandbox, uses the memory-root path helper to find the expected extension folder, and uses asynchronous file writing to imitate a user changing the instructions. The assertions act as checkpoints: first confirming that seeding created the default file, then confirming that a second seeding pass preserved the user’s version.

*Call graph*: 4 external calls (new, assert_eq!, memory_extensions_root, write).


### MCP configuration and transport integration
These files test MCP config parsing, catalog resolution, connection management, extension overlays, and full client transport behavior across local and remote scenarios.

### `codex-mcp/src/plugin_config_tests.rs`

`test` · `test suite`

This is a test file for the code that reads plugin MCP configuration. MCP means Model Context Protocol, a way for Codex to connect to outside tool servers. A plugin can declare these servers in JSON, and the parser must turn that JSON into trusted internal settings.

The main risk this file protects against is confusing “where” a server belongs. Some MCP servers run locally, while others belong to a remote executor environment. That distinction matters because it controls the working directory, environment variables, and authority of the server. For example, a remote executor-owned plugin should not be allowed to request local-only secrets, and a local plugin should not ask for remote-only secrets.

The tests feed small JSON snippets into `parse_plugin_mcp_config` and compare the result with the exact expected configuration or error. They also check path safety: a relative working directory like `scripts` is allowed under the plugin folder, but `../outside` is rejected because it escapes the plugin root. In plain terms, these tests make sure plugin configuration is read like a careful security checkpoint, not like a blind copy-paste from JSON into runtime settings.

#### Function details

##### `plugin_root`  (lines 16–20)

```
fn plugin_root() -> PathBuf
```

**Purpose**: Builds a pretend plugin root path for the tests. This gives every test the same base folder to resolve relative paths against.

**Data flow**: It reads the process’s current directory, appends `plugin-root`, and returns that full path. Nothing on disk is created; it is just constructing the path value the parser should use as the plugin’s home folder.

**Call relations**: The test cases call this before parsing their sample JSON so they can pass a consistent plugin root into `parse_plugin_mcp_config`. It relies on the standard `current_dir` call to start from the test process’s working directory.

*Call graph*: called by 7 (declared_placement_preserves_local_plugin_normalization, environment_placement_forces_authority_and_defaults_null_cwd, environment_placement_rejects_orchestrator_env_vars, environment_placement_rejects_relative_cwd_that_escapes_package, environment_placement_resolves_relative_cwd_beneath_plugin_root, local_environment_placement_preserves_local_env_vars, local_environment_placement_rejects_remote_env_vars); 1 external calls (current_dir).


##### `stdio_server`  (lines 22–51)

```
fn stdio_server(
    command: &str,
    environment_id: &str,
    cwd: &Path,
    env_vars: Vec<McpServerEnvVar>,
) -> McpServerConfig
```

**Purpose**: Builds the expected configuration for an MCP server that runs as a local command using standard input and output. Tests use it to avoid rewriting the same expected structure by hand.

**Data flow**: It takes a command name, an environment id, a working directory, and a list of environment-variable rules. It returns an `McpServerConfig` filled with those values plus the normal defaults used by these tests, such as enabled being true and no OAuth settings.

**Call relations**: This helper is used by tests when they need to compare parsed JSON against a full expected stdio server configuration. It constructs the expected object that is later checked with `assert_eq!` after `parse_plugin_mcp_config` runs.

*Call graph*: called by 1 (declared_placement_preserves_local_plugin_normalization); 3 external calls (new, to_path_buf, new).


##### `declared_placement_preserves_local_plugin_normalization`  (lines 54–116)

```
fn declared_placement_preserves_local_plugin_normalization()
```

**Purpose**: Checks that plugin-declared MCP servers are parsed without incorrectly forcing them into an executor environment. It also verifies that both command-based and HTTP-based server definitions become the expected internal settings.

**Data flow**: The test builds a plugin root, prepares expected stdio and HTTP server configs, then parses JSON containing two servers. The result should contain both servers, with the stdio server’s relative `cwd` resolved under the plugin root and the HTTP server keeping its URL and OAuth client id while ignoring unsupported callback-port detail.

**Call relations**: This test calls `plugin_root` and `stdio_server` to build its expected answer, then hands the JSON to `parse_plugin_mcp_config` using declared placement. Finally, `assert_eq!` confirms the parser produced exactly the expected successful outcome.

*Call graph*: calls 2 internal fn (plugin_root, stdio_server); 4 external calls (new, new, assert_eq!, parse_plugin_mcp_config).


##### `environment_placement_forces_authority_and_defaults_null_cwd`  (lines 119–162)

```
fn environment_placement_forces_authority_and_defaults_null_cwd()
```

**Purpose**: Checks that when a plugin MCP server is owned by an executor environment, the executor’s environment id wins over whatever the JSON says. It also checks that a null working directory falls back to the plugin root.

**Data flow**: The test gives the parser JSON with an explicit `environment_id` of `local`, a null `cwd`, and environment variables. Because placement says the executor owns the server, the output should use `executor-1`, use the plugin root as the working directory, and mark the listed environment variables as coming from the remote side.

**Call relations**: The test first gets the plugin root, then calls `parse_plugin_mcp_config` with environment placement. It compares the parsed outcome with the expected server configuration using `assert_eq!`.

*Call graph*: calls 1 internal fn (plugin_root); 2 external calls (assert_eq!, parse_plugin_mcp_config).


##### `environment_placement_resolves_relative_cwd_beneath_plugin_root`  (lines 165–191)

```
fn environment_placement_resolves_relative_cwd_beneath_plugin_root()
```

**Purpose**: Checks that a relative working directory for an executor-owned plugin is resolved inside the plugin folder. This keeps paths predictable and tied to the plugin package.

**Data flow**: The input JSON asks for `cwd` equal to `scripts`. The parser receives the plugin root and should turn that into `plugin-root/scripts` in the resulting server configuration, while also assigning the executor environment id.

**Call relations**: This test calls `plugin_root`, sends the JSON into `parse_plugin_mcp_config`, and then uses `assert_eq!` to verify that the parser normalized the path and environment id correctly.

*Call graph*: calls 1 internal fn (plugin_root); 2 external calls (assert_eq!, parse_plugin_mcp_config).


##### `environment_placement_rejects_relative_cwd_that_escapes_package`  (lines 194–218)

```
fn environment_placement_rejects_relative_cwd_that_escapes_package()
```

**Purpose**: Checks that an executor-owned plugin cannot set its working directory outside its own plugin folder. This is a safety test against path escape using `..`.

**Data flow**: The test gives the parser a `cwd` of `../outside`. Instead of producing a server config, the parser should return no servers and one clear error saying the relative working directory must stay within the plugin root.

**Call relations**: The test obtains the plugin root, calls `parse_plugin_mcp_config` with executor environment placement, and then checks the returned error with `assert_eq!`. It confirms the parser blocks unsafe paths rather than silently accepting them.

*Call graph*: calls 1 internal fn (plugin_root); 2 external calls (assert_eq!, parse_plugin_mcp_config).


##### `environment_placement_rejects_orchestrator_env_vars`  (lines 221–244)

```
fn environment_placement_rejects_orchestrator_env_vars()
```

**Purpose**: Checks that an executor-owned plugin cannot request environment variables from the local orchestrator. The orchestrator is the local controlling process, so allowing that would blur a security boundary.

**Data flow**: The input JSON declares an environment variable named `TOKEN` with source `local`. Since the server is placed in executor environment `executor-1`, the parser should reject it and return an error instead of a server configuration.

**Call relations**: This test calls `plugin_root`, then asks `parse_plugin_mcp_config` to parse the JSON as executor-owned. The final assertion verifies that the parser reports the forbidden local source.

*Call graph*: calls 1 internal fn (plugin_root); 2 external calls (assert_eq!, parse_plugin_mcp_config).


##### `local_environment_placement_preserves_local_env_vars`  (lines 247–279)

```
fn local_environment_placement_preserves_local_env_vars()
```

**Purpose**: Checks that when a plugin server belongs to the local default environment, local environment-variable requests are allowed and preserved. This confirms the parser does not over-restrict valid local plugins.

**Data flow**: The test input contains one shorthand environment variable, `TOKEN`, and one detailed entry, `OTHER` from source `local`. The parser should return a local stdio server whose environment-variable list keeps those local meanings unchanged.

**Call relations**: The test builds a plugin root, calls `parse_plugin_mcp_config` with the default local environment id, and compares the successful parsed result with the expected configuration using `assert_eq!`.

*Call graph*: calls 1 internal fn (plugin_root); 2 external calls (assert_eq!, parse_plugin_mcp_config).


##### `local_environment_placement_rejects_remote_env_vars`  (lines 282–304)

```
fn local_environment_placement_rejects_remote_env_vars()
```

**Purpose**: Checks that a local plugin server cannot request remote-sourced environment variables. This protects the opposite side of the same local-versus-remote boundary.

**Data flow**: The input JSON declares `TOKEN` with source `remote` while the placement says the server is in the local default environment. The parser should return no servers and an error explaining that remote source is not allowed in a local environment.

**Call relations**: This test calls `plugin_root`, passes the JSON to `parse_plugin_mcp_config` using local environment placement, and uses `assert_eq!` to confirm the expected rejection.

*Call graph*: calls 1 internal fn (plugin_root); 2 external calls (assert_eq!, parse_plugin_mcp_config).


### `ext/mcp/src/executor_plugin/provider_tests.rs`

`test` · `test run`

This is a test file for the executor plugin MCP provider. MCP means Model Context Protocol, a way for the system to discover and talk to external tool servers. Plugins may declare an MCP configuration file, and this file checks that the provider loads that configuration safely through the executor’s file-system interface instead of touching the real disk directly.

To do that, the tests build a fake file system called SyntheticExecutorFileSystem. Think of it like a tiny pretend filing cabinet with only one possible file in it. It records every path someone tries to read, returns configured contents when the expected file is read, and rejects all other file operations because these tests do not need them.

The tests cover three important cases. First, a plugin that declares a config path should have that exact path read, and only valid local command-based MCP servers should be returned. Second, if the plugin uses the default config path and that file is missing, the result should simply be an empty list. Third, if a declared config file exists but contains malformed JSON, the loader should return a parse error that includes the plugin id and file path.

The helper functions create realistic plugin objects and inspect what the fake file system recorded. Without these tests, a change could accidentally read from the host disk, ignore the wrong missing file, or hide useful error details.

#### Function details

##### `SyntheticExecutorFileSystem::unsupported`  (lines 40–45)

```
fn unsupported() -> FileSystemResult<T>
```

**Purpose**: This helper returns a standard “unsupported operation” error for file-system actions the tests do not expect to use. It keeps the fake file system small and makes accidental extra calls obvious.

**Data flow**: It takes no meaningful input beyond the requested result type. It creates an input/output error saying the operation is unsupported, then returns that error instead of a value.

**Call relations**: Most fake file-system methods call this when the real loader should not need them. If the loader starts using one of those methods during these tests, the test will fail rather than silently pretending the operation worked.

*Call graph*: 1 external calls (new).


##### `SyntheticExecutorFileSystem::canonicalize`  (lines 49–55)

```
fn canonicalize(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, PathUri>
```

**Purpose**: This fake implementation rejects path canonicalization, which means resolving a path into its cleaned-up absolute form. The tests do not expect MCP config loading to need this operation.

**Data flow**: It receives a path and an optional sandbox context, ignores both, and returns an asynchronous unsupported-operation error.

**Call relations**: It is part of the ExecutorFileSystem interface so the fake file system can be passed to load_from_file_system. In these tests, it should not be part of the normal flow; if called, it hands off to SyntheticExecutorFileSystem::unsupported.

*Call graph*: 2 external calls (pin, unsupported).


##### `SyntheticExecutorFileSystem::read_file`  (lines 57–75)

```
fn read_file(
        &'a self,
        path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>>
```

**Purpose**: This is the one file-system operation the tests expect the loader to use. It records which file was requested and returns either the fake config contents or a “not found” error.

**Data flow**: It receives a path and converts it to an absolute path. It stores that path in the reads list, compares it with the configured expected config path, and then either returns the configured bytes, reports that the file is missing, or reports that the requested path was not found.

**Call relations**: The real loader, load_from_file_system, calls this during each test to read the MCP configuration. The test functions later call reads to confirm that this method was used with exactly the expected path.

*Call graph*: calls 1 internal fn (to_abs_path); 3 external calls (pin, new, clone).


##### `SyntheticExecutorFileSystem::read_file_stream`  (lines 77–83)

```
fn read_file_stream(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream>
```

**Purpose**: This fake implementation rejects streaming file reads. The MCP provider tests only need whole-file reads.

**Data flow**: It receives a path and optional sandbox context, ignores them, and returns an asynchronous unsupported-operation error.

**Call relations**: It exists to satisfy the ExecutorFileSystem interface. If load_from_file_system unexpectedly switches to stream-based reading in these tests, this method will fail through SyntheticExecutorFileSystem::unsupported.

*Call graph*: 2 external calls (pin, unsupported).


##### `SyntheticExecutorFileSystem::write_file`  (lines 85–92)

```
fn write_file(
        &'a self,
        _path: &'a PathUri,
        _contents: Vec<u8>,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>
```

**Purpose**: This fake implementation rejects file writes. Loading an MCP configuration should be read-only, so writing would be a test failure.

**Data flow**: It receives a path, file contents, and optional sandbox context, ignores them, and returns an asynchronous unsupported-operation error.

**Call relations**: It is present because ExecutorFileSystem requires it, but the config loader should never call it. Any accidental write attempt is routed to SyntheticExecutorFileSystem::unsupported.

*Call graph*: 2 external calls (pin, unsupported).


##### `SyntheticExecutorFileSystem::create_directory`  (lines 94–101)

```
fn create_directory(
        &'a self,
        _path: &'a PathUri,
        _options: CreateDirectoryOptions,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'
```

**Purpose**: This fake implementation rejects directory creation. Reading plugin MCP settings should not create folders.

**Data flow**: It receives a path, directory creation options, and optional sandbox context, ignores them, and returns an asynchronous unsupported-operation error.

**Call relations**: It is only a required part of the file-system interface. If load_from_file_system tries to create directories while loading config, this method exposes that as an unsupported operation.

*Call graph*: 2 external calls (pin, unsupported).


##### `SyntheticExecutorFileSystem::get_metadata`  (lines 103–109)

```
fn get_metadata(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>
```

**Purpose**: This fake implementation rejects metadata lookups, such as checking file size or type. These tests expect the loader to simply try reading the config file.

**Data flow**: It receives a path and optional sandbox context, ignores them, and returns an asynchronous unsupported-operation error instead of file metadata.

**Call relations**: It fills out the ExecutorFileSystem contract. It is not part of the expected test story, and it delegates failure to SyntheticExecutorFileSystem::unsupported if called.

*Call graph*: 2 external calls (pin, unsupported).


##### `SyntheticExecutorFileSystem::read_directory`  (lines 111–117)

```
fn read_directory(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>>
```

**Purpose**: This fake implementation rejects directory listing. The MCP config loader should know which file to read rather than scanning folders in these tests.

**Data flow**: It receives a directory path and optional sandbox context, ignores them, and returns an asynchronous unsupported-operation error.

**Call relations**: It is included only because the fake must implement ExecutorFileSystem. An unexpected directory scan by load_from_file_system would fail through SyntheticExecutorFileSystem::unsupported.

*Call graph*: 2 external calls (pin, unsupported).


##### `SyntheticExecutorFileSystem::remove`  (lines 119–126)

```
fn remove(
        &'a self,
        _path: &'a PathUri,
        _options: RemoveOptions,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>
```

**Purpose**: This fake implementation rejects deleting files or directories. Loading configuration should never remove anything.

**Data flow**: It receives a path, removal options, and optional sandbox context, ignores them, and returns an asynchronous unsupported-operation error.

**Call relations**: It protects the tests from unexpected destructive behavior. If the loader ever calls remove, the call is immediately rejected via SyntheticExecutorFileSystem::unsupported.

*Call graph*: 2 external calls (pin, unsupported).


##### `SyntheticExecutorFileSystem::copy`  (lines 128–136)

```
fn copy(
        &'a self,
        _source_path: &'a PathUri,
        _destination_path: &'a PathUri,
        _options: CopyOptions,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> Ex
```

**Purpose**: This fake implementation rejects copying files. MCP config loading should not duplicate files.

**Data flow**: It receives source and destination paths, copy options, and optional sandbox context, ignores them, and returns an asynchronous unsupported-operation error.

**Call relations**: It is part of the required file-system shape but should stay unused. Any unexpected copy attempt from load_from_file_system is turned into an unsupported-operation error.

*Call graph*: 2 external calls (pin, unsupported).


##### `reads_declared_config_only_through_executor_file_system`  (lines 140–188)

```
async fn reads_declared_config_only_through_executor_file_system()
```

**Purpose**: This test proves that when a plugin declares an MCP config file, the loader reads that declared file through the executor file system and returns the expected server configuration. It also confirms that hosted URL-based MCP entries are not included in this executor-local result.

**Data flow**: It creates a temporary plugin root that does not exist on the real disk, builds a plugin pointing at config/mcp.json, and gives the fake file system valid JSON contents. It calls load_from_file_system, then checks that the output contains the expected local command server with the plugin root as its working directory, and checks that exactly one read happened at the declared config path.

**Call relations**: This is a top-level asynchronous test. It uses resolved_plugin to build the plugin object, calls the real load_from_file_system function under test, and uses reads afterward to verify how SyntheticExecutorFileSystem::read_file was used.

*Call graph*: calls 2 internal fn (resolved_plugin, from_absolute_path_checked); 6 external calls (new, new, assert!, assert_eq!, load_from_file_system, tempdir).


##### `missing_default_config_is_empty`  (lines 191–209)

```
async fn missing_default_config_is_empty()
```

**Purpose**: This test checks the friendly behavior for the default MCP config file: if the plugin did not declare a custom path and the default file is missing, loading succeeds with no servers. That avoids treating an optional config file as a hard failure.

**Data flow**: It creates a temporary plugin root, chooses the default MCP config path, and configures the fake file system to report that file as missing. It calls load_from_file_system and expects an empty list, then confirms the loader tried to read exactly the default config path.

**Call relations**: This top-level asynchronous test uses resolved_plugin with no MCP path in the manifest. It exercises load_from_file_system’s missing-default-file path and then calls reads to inspect the fake file system’s recorded reads.

*Call graph*: calls 2 internal fn (resolved_plugin, from_absolute_path_checked); 5 external calls (new, new, assert_eq!, load_from_file_system, tempdir).


##### `malformed_declared_config_is_an_error`  (lines 212–241)

```
async fn malformed_declared_config_is_an_error()
```

**Purpose**: This test makes sure a declared config file with invalid JSON is treated as a real error. Since the plugin explicitly pointed to the file, broken contents should not be silently ignored.

**Data flow**: It creates a plugin with a declared mcp.json path and gives the fake file system the invalid text {not-json. It calls load_from_file_system expecting an error, checks that the error is specifically a parse-config error, and verifies that the error carries the plugin id and path. It also confirms the file system was read only at that path.

**Call relations**: This top-level asynchronous test uses resolved_plugin to build the plugin and calls load_from_file_system to trigger parsing. If the returned error is not the expected kind, the test panics; after that it uses reads to confirm the file access pattern.

*Call graph*: calls 2 internal fn (resolved_plugin, from_absolute_path_checked); 6 external calls (new, new, assert_eq!, panic!, load_from_file_system, tempdir).


##### `resolved_plugin`  (lines 243–267)

```
fn resolved_plugin(
    plugin_root: &AbsolutePathBuf,
    mcp_servers: Option<AbsolutePathBuf>,
) -> ResolvedPlugin
```

**Purpose**: This helper builds a realistic ResolvedPlugin value for the tests. It saves each test from repeating the same plugin manifest setup.

**Data flow**: It receives a plugin root path and an optional MCP config path. It creates a plugin descriptor with a fixed id, environment id, manifest path, and manifest contents, including the optional MCP server path, then returns the resolved plugin object.

**Call relations**: All three test functions call this before invoking load_from_file_system. It prepares the plugin metadata that tells the loader which config path to use and which environment id to apply.

*Call graph*: calls 2 internal fn (from_environment, join); called by 3 (malformed_declared_config_is_an_error, missing_default_config_is_empty, reads_declared_config_only_through_executor_file_system); 2 external calls (new, clone).


##### `reads`  (lines 269–275)

```
fn reads(file_system: &SyntheticExecutorFileSystem) -> Vec<AbsolutePathBuf>
```

**Purpose**: This helper returns the list of file paths the fake file system was asked to read. Tests use it to prove the loader touched the expected file and nothing else.

**Data flow**: It receives a SyntheticExecutorFileSystem, locks its reads list, clones the stored paths, and returns that clone. The original recorded list remains in the fake file system.

**Call relations**: The test functions call this after load_from_file_system finishes. It reports what SyntheticExecutorFileSystem::read_file recorded during the loader’s run.


### `codex-mcp/src/mcp/mod_tests.rs`

`test` · `test run`

MCP stands for Model Context Protocol, a way for Codex to connect to outside tools and services. This test file checks the rules that decide how those tool connections are named, trusted, attributed to plugins, and turned into runnable server configurations. Without these tests, a small change could make tool names invalid, approve a permission prompt too eagerly, lose information about which plugin supplied a tool, or rewrite a user’s configured server URL.

The file starts with a helper, `test_mcp_config`, that builds a realistic default MCP configuration for tests. Each test then changes only the part it cares about. This keeps the tests focused and easy to read.

Several tests check permission behavior: for example, whether prompts can be skipped when the policy is very permissive, and whether an explicitly approved app tool is trusted across different approval modes. Other tests check provenance, meaning “where did this tool come from?” They make sure connector IDs and MCP server names point back to the right plugin display names and plugin IDs.

The final group tests Codex Apps server setup. It verifies URL construction, optional product SKU headers, and that adding the built-in Codex Apps MCP server does not erase user-configured runtime servers. Overall, this file protects the assumptions users and plugins depend on.

#### Function details

##### `test_mcp_config`  (lines 20–39)

```
fn test_mcp_config(codex_home: PathBuf) -> McpConfig
```

**Purpose**: Builds a standard MCP configuration that tests can reuse. It gives each test a known starting point, like a clean workbench with the usual tools already laid out.

**Data flow**: It receives a `codex_home` path, which represents the test Codex home directory. It fills in an `McpConfig` with default URLs, approval settings, sandbox settings, plugin lists, and catalog data. It returns that complete configuration so individual tests can adjust only the fields they need.

**Call relations**: This helper is called by the provenance tests and the effective-server test when they need a realistic configuration. It uses default constructors and an approval-policy helper to create the baseline, then hands the finished config back to the test that called it.

*Call graph*: calls 2 internal fn (allow_any, default); called by 3 (effective_mcp_servers_preserve_runtime_servers, selected_mcp_attribution_does_not_join_an_unrelated_local_summary, tool_plugin_provenance_collects_app_and_mcp_sources); 4 external calls (default, new, default, default).


##### `qualified_mcp_tool_name_prefix_sanitizes_server_names_without_lowercasing`  (lines 42–47)

```
fn qualified_mcp_tool_name_prefix_sanitizes_server_names_without_lowercasing()
```

**Purpose**: Checks that MCP tool name prefixes are made safe without changing the capitalization of the server name. This matters because tool names need safe characters, but changing case could break expectations or make names less recognizable.

**Data flow**: It gives the prefix-building logic the server name `Some-Server`. The logic replaces the hyphen with an underscore and wraps the name in the MCP prefix format. The test expects the result to be `mcp__Some_Server__`.

**Call relations**: This is a standalone test of the tool-name prefix rule. It calls the production naming function and uses an equality assertion to confirm the output stays exactly as intended.

*Call graph*: 1 external calls (assert_eq!).


##### `mcp_prompt_auto_approval_honors_unrestricted_managed_profiles`  (lines 50–80)

```
fn mcp_prompt_auto_approval_honors_unrestricted_managed_profiles()
```

**Purpose**: Checks when MCP permission prompts may be automatically approved for managed permission profiles. A managed profile is a pre-set permission bundle, and this test makes sure only the right kind of unrestricted profile gets automatic approval.

**Data flow**: It tries several combinations of approval policy and permission profile. When approval is set to never ask and the managed file system access is unrestricted, the test expects auto-approval. When the profile is read-only, or the approval policy still asks on request, the test expects no auto-approval.

**Call relations**: This test exercises the production permission-decision function directly. It uses assertions to confirm that broad managed access is treated differently from read-only access, and that the approval policy still has the final say.

*Call graph*: 1 external calls (assert!).


##### `mcp_prompt_auto_approval_honors_approved_tools_in_all_permission_modes`  (lines 83–113)

```
fn mcp_prompt_auto_approval_honors_approved_tools_in_all_permission_modes()
```

**Purpose**: Checks that a tool explicitly marked as approved is trusted across all approval policies. This protects the meaning of a user or app decision that says, in effect, “this specific tool is allowed.”

**Data flow**: It loops through several approval policies, including granular approval, which means separate switches for different approval categories. For each policy, it passes a read-only permission profile and a context saying the tool approval mode is `Approve`; the result should be automatic approval. It also checks that `Auto` mode is not treated the same as explicit approval under the default request-based policy.

**Call relations**: This test repeatedly calls the permission-decision function with different policy settings. It confirms that explicit tool approval overrides the surrounding permission mode, while the weaker automatic mode does not.

*Call graph*: 2 external calls (Granular, assert!).


##### `mcp_prompt_auto_approval_rejects_auto_mode_in_default_permission_mode`  (lines 116–124)

```
fn mcp_prompt_auto_approval_rejects_auto_mode_in_default_permission_mode()
```

**Purpose**: Checks that `Auto` tool approval mode does not silently approve prompts when the normal policy is to ask on request. This prevents a softer “automatic if allowed” setting from becoming a blanket approval.

**Data flow**: It passes an ask-on-request approval policy, a read-only permission profile, and a context where the tool approval mode is `Auto`. The permission-decision function should return false, meaning the prompt is not auto-approved.

**Call relations**: This is a focused companion to the broader approval-mode test. It calls the same production decision function but isolates one important default case.

*Call graph*: 1 external calls (assert!).


##### `tool_plugin_provenance_collects_app_and_mcp_sources`  (lines 127–187)

```
fn tool_plugin_provenance_collects_app_and_mcp_sources()
```

**Purpose**: Checks that the system records which plugins contributed app connectors and MCP servers. Provenance means origin information: it answers questions like “which plugin supplied this tool?”

**Data flow**: It starts with a default test config, then builds an MCP catalog containing an `alpha` server registered from a plugin. It also adds capability summaries for two plugins, with connector IDs and MCP server names. After calling the provenance-building function, it expects maps from connector IDs to plugin display names, from MCP server names to plugin display names, and from MCP server names to plugin IDs.

**Call relations**: This test combines helper-built config, catalog registration, and plugin summaries to mimic a real plugin setup. It then calls the production provenance collector and checks both the whole collected structure and the lookup for a single server name.

*Call graph*: calls 4 internal fn (new, from_plugin, builder, test_mcp_config); 3 external calls (new, assert_eq!, vec!).


##### `selected_mcp_attribution_does_not_join_an_unrelated_local_summary`  (lines 190–228)

```
fn selected_mcp_attribution_does_not_join_an_unrelated_local_summary()
```

**Purpose**: Checks that a selected plugin’s MCP attribution is not accidentally merged with an unrelated local plugin summary just because they share an ID and server name. This prevents the UI or permission system from showing the wrong plugin source.

**Data flow**: It builds a config with a selected plugin server named `github`, attributed to `Executor GitHub`. It also adds a local capability summary with the same plugin ID and server name but a different display name, `Local GitHub`. The provenance result should use the selected plugin attribution only, mark the server as selected, and avoid pulling in connector information from the local summary.

**Call relations**: This test calls the same provenance-building path as the previous provenance test, but with a selected-plugin registration. It verifies that selected plugin registrations take precedence and that the selected-server lookup reports `github` correctly.

*Call graph*: calls 4 internal fn (new, from_selected_plugin, builder, test_mcp_config); 4 external calls (new, assert!, assert_eq!, vec!).


##### `codex_apps_mcp_url_for_base_url_keeps_existing_paths`  (lines 231–248)

```
fn codex_apps_mcp_url_for_base_url_keeps_existing_paths()
```

**Purpose**: Checks how Codex builds the MCP URL for Codex Apps from different base URLs. This matters because production, legacy, and local development URLs have slightly different path shapes.

**Data flow**: It passes several base URLs into the URL-building function: ChatGPT with an existing backend path, ChatGPT without one, and localhost with or without a local API path. For each input, it checks that the returned URL appends the correct Codex Apps MCP path without stripping important existing path parts.

**Call relations**: This standalone test calls the production URL-building helper and compares each result to the expected exact URL. It protects compatibility with both hosted ChatGPT endpoints and local development endpoints.

*Call graph*: 1 external calls (assert_eq!).


##### `codex_apps_server_config_uses_legacy_codex_apps_path`  (lines 251–260)

```
fn codex_apps_server_config_uses_legacy_codex_apps_path()
```

**Purpose**: Checks that the built-in Codex Apps MCP server still uses the expected legacy URL path. This is important because existing backend routes may depend on that exact path.

**Data flow**: It asks the server-config builder to create a Codex Apps MCP server configuration for `https://chatgpt.com`. It then looks inside the transport settings, which describe how the server is reached over HTTP, and expects the URL to be `https://chatgpt.com/backend-api/wham/apps`.

**Call relations**: This test calls the production Codex Apps server-config function. It then pattern-matches the returned transport configuration and fails immediately if the server is not using the expected streamable HTTP transport.

*Call graph*: 2 external calls (assert_eq!, panic!).


##### `codex_apps_server_config_forwards_configured_product_sku_header`  (lines 263–283)

```
fn codex_apps_server_config_forwards_configured_product_sku_header()
```

**Purpose**: Checks that an optional product SKU is sent as an HTTP header in the Codex Apps MCP server configuration. A product SKU is a product identifier, and the backend may use it to route or identify the request.

**Data flow**: It creates a Codex Apps MCP server config with the SKU `tpp`. It reads the HTTP transport settings and expects a header named `X-OpenAI-Product-Sku` with value `tpp`. It also confirms that no environment-based headers are set for this case.

**Call relations**: This test calls the same server-config builder as the previous URL test, but focuses on headers instead of the URL. It checks the exact transport details and fails if the wrong transport type is produced.

*Call graph*: 3 external calls (assert!, assert_eq!, panic!).


##### `effective_mcp_servers_preserve_runtime_servers`  (lines 286–390)

```
async fn effective_mcp_servers_preserve_runtime_servers()
```

**Purpose**: Checks that computing the final set of MCP servers keeps user-configured runtime servers while also including the built-in Codex Apps server. This protects user configuration from being overwritten when apps support is enabled.

**Data flow**: It creates a temporary Codex home directory, builds a test config, turns apps on, and creates dummy ChatGPT authentication for testing. It registers three servers in the catalog: two user-style HTTP servers named `sample` and `docs`, plus the built-in Codex Apps server. After calling the function that computes the effective server map, it verifies that all three servers are present and that each kept its expected HTTP URL.

**Call relations**: This asynchronous test uses the shared config helper, catalog registration helpers, and test authentication setup to simulate a realistic enabled-apps configuration. It then calls the production effective-server function and inspects the resulting server configs to make sure nothing was dropped or rewritten.

*Call graph*: calls 4 internal fn (from_config, builder, test_mcp_config, create_dummy_chatgpt_auth_for_testing); 4 external calls (new, assert_eq!, panic!, tempdir).


### `codex-mcp/src/catalog_tests.rs`

`test` · `test suite`

An MCP server here is an external tool server that Codex can talk to. In real use, the same server name might be offered by several sources: a user config file, an installed plugin, a selected plugin, an extension, or an older compatibility path. This file checks the rules for deciding which one actually appears in the final catalog.

The tests build small fake server entries, register them into a `ResolvedMcpCatalog` builder, then inspect the finished catalog. Think of the builder like a clerk receiving several applications for the same parking spot. The tests verify who gets the spot, who is recorded as losing the conflict, and what happens if someone marks the spot as disabled.

A recurring idea is a “veto”: if a winning server is disabled, that disabled state can carry forward and disable a later replacement in some cases. The tests also check that selected plugins beat automatically discovered plugins, but user config still beats selected plugins. They verify that conflicts are reported in a predictable order, and that equal-priority entries use insertion order rather than sorting by source identity. Without these tests, small changes in catalog resolution could silently change which tools users get, whether disabled servers come back unexpectedly, or whether conflict reports become misleading.

#### Function details

##### `server`  (lines 18–46)

```
fn server(url: &str) -> McpServerConfig
```

**Purpose**: Creates a realistic test MCP server configuration for a given URL. The tests use it as a ready-made sample server so each test can focus on catalog behavior instead of repeating setup details.

**Data flow**: It receives a URL string. It builds a `McpServerConfig` with HTTP transport, default environment, enabled and required flags, timeouts, tool approval settings, enabled and disabled tool lists, and one per-tool approval rule. It returns that complete server configuration, which tests may then clone or slightly edit.

**Call relations**: Most test cases call this helper before registering servers into a catalog builder. It uses small standard constructors, such as duration creation and collection creation, so the later assertions compare full server configurations rather than vague placeholders.

*Call graph*: called by 8 (disabled_discovered_plugin_remains_a_veto_for_runtime_overlays, disabled_selected_plugin_does_not_veto_runtime_overlays, disabled_veto_only_disables_the_winning_registration, disabled_winner_remains_a_veto_when_the_catalog_is_extended, earlier_plugin_wins_with_an_explicit_conflict, equal_precedence_uses_insertion_order_not_source_identity, selected_plugins_override_discovered_plugins_but_not_config, source_precedence_preserves_the_winning_registration); 3 external calls (from_secs, from, vec!).


##### `plugin`  (lines 48–50)

```
fn plugin(plugin_id: &str) -> McpPluginAttribution
```

**Purpose**: Creates a test plugin attribution from a plugin id. A plugin attribution is the label that says which plugin contributed a server.

**Data flow**: It receives a plugin id string. It copies that id into the attribution fields expected by `McpPluginAttribution::new`. It returns the attribution object for use in registrations and expected results.

**Call relations**: Tests call this when registering plugin-provided servers. The source helper functions also call it so expected conflict entries refer to the same kind of plugin identity as real registrations.

*Call graph*: calls 1 internal fn (new); called by 7 (disabled_discovered_plugin_remains_a_veto_for_runtime_overlays, disabled_selected_plugin_does_not_veto_runtime_overlays, earlier_plugin_wins_with_an_explicit_conflict, plugin_source, selected_plugin_source, selected_plugins_override_discovered_plugins_but_not_config, source_precedence_preserves_the_winning_registration).


##### `plugin_source`  (lines 52–54)

```
fn plugin_source(plugin_id: &str) -> McpServerSource
```

**Purpose**: Builds the expected catalog source value for a server that came from an automatically discovered plugin. Tests use it to write clear expected conflict records.

**Data flow**: It receives a plugin id. It turns that id into a plugin attribution with `plugin`, then wraps it in the `Plugin` source variant. The result is an `McpServerSource` value.

**Call relations**: This helper is used inside expected assertions, especially when checking conflict lists. It mirrors the source produced by plugin registrations, so the tests compare the catalog's recorded story against the intended one.

*Call graph*: calls 1 internal fn (plugin); 1 external calls (Plugin).


##### `selected_plugin_source`  (lines 56–58)

```
fn selected_plugin_source(plugin_id: &str) -> McpServerSource
```

**Purpose**: Builds the expected catalog source value for a server that came from a selected plugin. A selected plugin is one the user or runtime explicitly chose, rather than one merely discovered.

**Data flow**: It receives a plugin id. It creates a plugin attribution with `plugin`, wraps it in the `SelectedPlugin` source variant, and returns that source value.

**Call relations**: The selected-plugin tests use this helper when asserting which plugin won and how conflicts were recorded. It keeps the expected source labels aligned with the selected plugin registration path.

*Call graph*: calls 1 internal fn (plugin); 1 external calls (SelectedPlugin).


##### `compatibility_source`  (lines 60–62)

```
fn compatibility_source(id: &str) -> McpServerSource
```

**Purpose**: Builds the expected source value for a server registered through a compatibility path. This represents older or fallback registration behavior that still needs predictable catalog rules.

**Data flow**: It receives an id string. It copies the id into an `McpServerSource::Compatibility` value and returns it.

**Call relations**: Tests use this helper when checking expected winners and conflict records for compatibility registrations and removals. It keeps assertions readable without hiding the rule being tested.


##### `extension_source`  (lines 64–66)

```
fn extension_source(id: &str) -> McpServerSource
```

**Purpose**: Builds the expected source value for a server contributed by an extension. Tests use it to compare the catalog's chosen source against an easy-to-read expected value.

**Data flow**: It receives an extension id string. It copies that id into an `McpServerSource::Extension` value and returns it.

**Call relations**: Extension precedence and disabled-veto tests use this helper in their assertions. It represents the same source identity produced by extension registrations.


##### `register`  (lines 68–70)

```
fn register(source: McpServerSource) -> McpServerConflictAction
```

**Purpose**: Wraps a source as a conflict action meaning that the source tried to register a server. This makes expected conflict lists easier to read.

**Data flow**: It receives an `McpServerSource`. It wraps it in `McpServerConflictAction::Register` and returns the action.

**Call relations**: Conflict-focused tests use this helper when writing the expected outcome and contender actions. It matches the conflict records produced when catalog entries compete for the same server name.

*Call graph*: 1 external calls (Register).


##### `remove`  (lines 72–74)

```
fn remove(source: McpServerSource) -> McpServerConflictAction
```

**Purpose**: Wraps a source as a conflict action meaning that the source removed, rather than registered, a server. This is used for tests involving removal overlays.

**Data flow**: It receives an `McpServerSource`. It wraps it in `McpServerConflictAction::Remove` and returns the action.

**Call relations**: The equal-precedence test uses this helper after adding a compatibility removal. It lets the assertion show that the final catalog outcome is a removal, not just a missing server.

*Call graph*: 1 external calls (Remove).


##### `source_precedence_preserves_the_winning_registration`  (lines 77–132)

```
fn source_precedence_preserves_the_winning_registration()
```

**Purpose**: Checks that when several sources define the same server name, the highest-priority source wins and its full configuration is preserved. It also checks that losing plugin entries are reported as conflicts, not silently ignored.

**Data flow**: The test creates one extension server and several competing plugin, compatibility, and config registrations for the name `docs`. It registers them with the catalog builder, builds the catalog, and then reads back the resolved server, plugin attributions, and conflicts. The expected result is that the extension source and extension configuration win, no plugin attribution is kept for the server, and the plugin contenders appear in the conflict report.

**Call relations**: This test drives the main catalog-building path by calling the registration constructors and `ResolvedMcpCatalog::builder`. It relies on helpers like `server`, `plugin`, `extension_source`, `plugin_source`, and `register` to set up inputs and express the expected result clearly.

*Call graph*: calls 7 internal fn (from_compatibility, from_config, from_extension, from_plugin, builder, plugin, server); 2 external calls (assert!, assert_eq!).


##### `disabled_veto_only_disables_the_winning_registration`  (lines 135–156)

```
fn disabled_veto_only_disables_the_winning_registration()
```

**Purpose**: Checks that a manual disable applies to the server that actually wins resolution. It should not rewrite unrelated contender data; it should simply make the chosen server disabled.

**Data flow**: The test creates an enabled extension server and separately prepares the same expected server with `enabled` set to false. It registers the extension, asks the builder to disable the `docs` server, builds the catalog, and reads the final configuration. The output should match the extension server except for being disabled.

**Call relations**: This test calls the extension registration path and then the builder's disable operation. It confirms that the catalog builder applies a disable veto at build time to the resolved winner.

*Call graph*: calls 3 internal fn (from_extension, builder, server); 1 external calls (assert_eq!).


##### `disabled_winner_remains_a_veto_when_the_catalog_is_extended`  (lines 159–186)

```
fn disabled_winner_remains_a_veto_when_the_catalog_is_extended()
```

**Purpose**: Checks that if a catalog is built with a disabled winning server, that disabled state still matters when the catalog is later reopened and extended. This prevents a later overlay from accidentally re-enabling something the user had effectively disabled.

**Data flow**: The test starts with a config-provided `docs` server whose `enabled` flag is false. It builds the catalog, turns it back into a builder, then registers a higher-priority extension server for the same name. After building again, the final server should come from the extension, but its configuration should be disabled.

**Call relations**: This test exercises the round trip from built catalog back to builder through `to_builder`. It uses config and extension registrations to prove that a disabled winner can become a continuing veto over later runtime additions.

*Call graph*: calls 4 internal fn (from_config, from_extension, builder, server); 1 external calls (assert_eq!).


##### `disabled_discovered_plugin_remains_a_veto_for_runtime_overlays`  (lines 189–218)

```
fn disabled_discovered_plugin_remains_a_veto_for_runtime_overlays()
```

**Purpose**: Checks that a disabled server from a discovered plugin can also act as a veto when later runtime entries are added. The important behavior is that the disabled choice is remembered across catalog extension.

**Data flow**: The test registers a plugin-provided `docs` server with `enabled` set to false. It builds the catalog, converts it back to a builder, and then registers an extension server for the same name. The final catalog should choose the extension as the source, but the final configuration should have `enabled` set to false.

**Call relations**: This test combines plugin registration, catalog rebuilding through `to_builder`, and extension registration. It confirms that disabled discovered plugins are treated like a meaningful user-facing veto for later overlays.

*Call graph*: calls 5 internal fn (from_extension, from_plugin, builder, plugin, server); 1 external calls (assert_eq!).


##### `earlier_plugin_wins_with_an_explicit_conflict`  (lines 221–253)

```
fn earlier_plugin_wins_with_an_explicit_conflict()
```

**Purpose**: Checks how the catalog chooses between two automatically discovered plugins that both provide the same server name. The earlier plugin should win, and the conflict should be recorded explicitly.

**Data flow**: The test registers two plugin servers named `docs`, one with plugin order 0 and one with plugin order 1. It builds the catalog and then checks two outputs: the winning plugin attribution should be the earlier plugin, and the conflict report should show both plugin registrations with the earlier one as the outcome.

**Call relations**: This test focuses on the plugin-only resolution path. It uses `plugin`, `server`, `register`, and `plugin_source` helpers to compare the builder's result with the expected first-plugin-wins rule.

*Call graph*: calls 4 internal fn (from_plugin, builder, plugin, server); 1 external calls (assert_eq!).


##### `selected_plugins_override_discovered_plugins_but_not_config`  (lines 256–321)

```
fn selected_plugins_override_discovered_plugins_but_not_config()
```

**Purpose**: Checks two priority rules: selected plugins beat automatically discovered plugins, but user config beats selected plugins. This protects user choice while still allowing explicit config to be the final authority.

**Data flow**: The test first registers a disabled discovered plugin and two selected plugins for `docs`. After building, the selected plugin with the earlier selection order should win, plugin attribution should point to it, and the selected-plugin conflict should be reported. Then the test turns the catalog back into a builder, registers a config-provided server, rebuilds, and expects the config server to replace the selected plugin.

**Call relations**: This test walks through a two-stage catalog story: selected plugin resolution first, then a config overlay. It calls plugin and selected-plugin registration constructors, then later the config registration constructor, showing how priority changes as stronger sources are added.

*Call graph*: calls 6 internal fn (from_config, from_plugin, from_selected_plugin, builder, plugin, server); 1 external calls (assert_eq!).


##### `disabled_selected_plugin_does_not_veto_runtime_overlays`  (lines 324–352)

```
fn disabled_selected_plugin_does_not_veto_runtime_overlays()
```

**Purpose**: Checks that a disabled selected plugin does not keep disabling later runtime overlays. This is different from disabled discovered plugins and disabled config winners, so the distinction is important.

**Data flow**: The test registers a selected plugin server for `docs` with `enabled` set to false. It builds the catalog, converts it back to a builder, and registers an extension server. After rebuilding, the final server should be the extension server with its original enabled configuration intact.

**Call relations**: This test uses selected-plugin and extension registration paths with a `to_builder` step between them. It proves that selected-plugin disables are not treated as lasting vetoes over later extension-provided servers.

*Call graph*: calls 5 internal fn (from_extension, from_selected_plugin, builder, plugin, server); 1 external calls (assert_eq!).


##### `equal_precedence_uses_insertion_order_not_source_identity`  (lines 355–395)

```
fn equal_precedence_uses_insertion_order_not_source_identity()
```

**Purpose**: Checks that when two entries have the same priority, the catalog uses the order they were inserted rather than sorting by their source ids. It also checks how a later removal at the same level is reported.

**Data flow**: The test registers two compatibility servers named `docs`, first with id `z-first` and then with id `a-second`. Even though `a-second` would sort earlier alphabetically, the expected winner is based on insertion behavior as defined by the catalog. Then the catalog is turned back into a builder, a compatibility removal is added, and the rebuilt catalog should have no server while recording a conflict that includes both registrations and the removal outcome.

**Call relations**: This test focuses on compatibility registrations and removals. It uses the builder, compatibility registration, `to_builder`, and `remove_compatibility` to verify both equal-priority ordering and the way removals are captured in conflict history.

*Call graph*: calls 3 internal fn (from_compatibility, builder, server); 1 external calls (assert_eq!).


### `codex-mcp/src/connection_manager_tests.rs`

`test` · `test suite`

This is a test file, so it does not provide the main MCP feature itself. Instead, it proves that important promises stay true as the code changes. MCP, or Model Context Protocol, is the way Codex connects to outside tool servers. If these tests were missing, small changes could silently break how tools are exposed to the model, how cached Codex Apps tools are reused at startup, or how users are warned about login and approval problems.

The file builds simple fake tools and fake server records, then runs many focused checks. Some tests make sure file-upload parameters are shown to the model as local file paths instead of raw file objects. Others check that tool names are cleaned up into names the model can call, while still preserving the original MCP names for the real server call. Several tests cover allow/block tool filters and the Codex Apps disk cache, including bad JSON, old schema versions, and separate users.

The async tests simulate MCP clients that are still starting, fail to start, or get cancelled. This lets the connection manager be tested like a shop that can show yesterday’s menu while today’s kitchen is still opening. The final tests check server metadata, missing local runtimes, elicitation capability JSON, and friendly startup error messages.

#### Function details

##### `create_test_tool`  (lines 47–64)

```
fn create_test_tool(server_name: &str, tool_name: &str) -> ToolInfo
```

**Purpose**: Builds a small fake MCP tool record for tests. It gives the tool a server name, a callable name, a short description, and an empty input shape so tests can focus on one behavior at a time.

**Data flow**: It receives a server name and tool name. It packages those strings into a ToolInfo value with default-like metadata and a simple rmcp Tool inside. The result is a ready-to-use fake tool for assertions.

**Call relations**: This helper is used by tests and by create_test_tool_with_connector when they need a plain tool without writing the same setup over and over.

*Call graph*: called by 4 (codex_apps_server_info_cache_survives_legacy_tools_cache_write, create_test_tool_with_connector, tool_with_model_visible_input_schema_leaves_tools_without_file_params_unchanged, tool_with_model_visible_input_schema_masks_file_params); 5 external calls (new, default, new, format!, new).


##### `create_test_tool_with_connector`  (lines 66–76)

```
fn create_test_tool_with_connector(
    server_name: &str,
    tool_name: &str,
    connector_id: &str,
    connector_name: Option<&str>,
) -> ToolInfo
```

**Purpose**: Builds a fake tool that also carries connector information. Tests use it when they need to check whether tools from certain Codex Apps connectors are kept or removed.

**Data flow**: It receives a server name, tool name, connector id, and optional connector display name. It first creates a normal fake tool, then fills in the connector fields. It returns that enriched ToolInfo.

**Call relations**: It depends on create_test_tool for the common tool setup, then adds the connector-specific details needed by cache-filtering tests.

*Call graph*: calls 1 internal fn (create_test_tool).


##### `create_codex_apps_tools_cache_context`  (lines 78–91)

```
fn create_codex_apps_tools_cache_context(
    codex_home: PathBuf,
    account_id: Option<&str>,
    chatgpt_user_id: Option<&str>,
) -> CodexAppsToolsCacheContext
```

**Purpose**: Creates the cache identity used by Codex Apps tool-cache tests. It says where the fake Codex home directory is and which user/account the cache belongs to.

**Data flow**: It receives a temporary Codex home path plus optional account and ChatGPT user ids. It converts those optional strings into owned values and puts them into a CodexAppsToolsCacheContext. The output tells cache code which file path to read or write.

**Call relations**: Cache-related tests call this before reading or writing cached tools so each test can work in an isolated temporary directory.

*Call graph*: called by 8 (codex_apps_server_info_cache_survives_legacy_tools_cache_write, codex_apps_tools_cache_filters_disallowed_connectors, codex_apps_tools_cache_is_ignored_when_json_is_invalid, codex_apps_tools_cache_is_ignored_when_schema_version_mismatches, codex_apps_tools_cache_is_overwritten_by_last_write, codex_apps_tools_cache_is_scoped_per_user, startup_cached_codex_apps_tools_loads_from_disk_cache, startup_cached_codex_apps_tools_loads_without_server_info_cache).


##### `create_test_server_info`  (lines 93–102)

```
fn create_test_server_info(title: &str) -> McpServerInfo
```

**Purpose**: Creates a small fake MCP server information record. Tests use it to verify that server title and version data can be cached and recovered.

**Data flow**: It receives a title string. It builds an McpServerInfo for the Codex Apps server with that title, a fixed name, and a fixed version. The result is compared against cached or listed server info.

**Call relations**: Startup-cache and connection-manager tests call this when they need known server metadata to store, retrieve, or expose.

*Call graph*: called by 4 (codex_apps_server_info_cache_survives_legacy_tools_cache_write, list_all_tools_uses_cached_tool_info_snapshot_when_client_startup_fails, list_available_server_infos_uses_cache_while_client_is_pending, startup_cached_codex_apps_tools_loads_from_disk_cache).


##### `model_tool_names`  (lines 104–109)

```
fn model_tool_names(tools: &[ToolInfo]) -> HashSet<ToolName>
```

**Purpose**: Collects the model-visible names from a list of tools. This makes tests easier to read when they only care about the final callable names.

**Data flow**: It receives a slice of ToolInfo values. It asks each tool for its canonical ToolName and puts those names into a HashSet, which removes ordering concerns. The output is a set of names for comparison.

**Call relations**: Tool-normalization tests call this after normalization so they can assert on the final names without depending on vector order.

*Call graph*: called by 2 (test_normalize_tools_disambiguates_sanitized_namespace_collisions, test_normalize_tools_long_names_same_server); 1 external calls (iter).


##### `model_tool_name_len`  (lines 111–116)

```
fn model_tool_name_len(name: &ToolName) -> usize
```

**Purpose**: Measures the length of a model-visible tool name, including its namespace if present. Tests use it to confirm long names are shortened to the required size.

**Data flow**: It receives a ToolName. It counts the namespace plus the separator when a namespace exists, then adds the tool name length. It returns the total character count.

**Call relations**: The long-name normalization test uses this helper to check every generated name stays within the intended model-facing limit.


##### `is_code_mode_compatible_tool_name`  (lines 118–125)

```
fn is_code_mode_compatible_tool_name(name: &ToolName) -> bool
```

**Purpose**: Checks whether a tool name is safe for code-mode style calls. In plain terms, it verifies that only letters, numbers, and underscores appear.

**Data flow**: It receives a ToolName. It walks through the namespace, if any, and the tool name itself, checking each character. It returns true only if every character is ASCII alphanumeric or an underscore.

**Call relations**: Several normalization tests use this helper after names are sanitized or disambiguated, proving the model will see call names it can safely use.

*Call graph*: 1 external calls (once).


##### `declared_openai_file_fields_treat_names_literally`  (lines 127–141)

```
fn declared_openai_file_fields_treat_names_literally()
```

**Purpose**: Checks that declared file-parameter names are read exactly as written. This matters because a file parameter named "file" should not accidentally match unrelated names by pattern.

**Data flow**: The test builds JSON metadata listing three file parameter names. It passes that metadata to declared_openai_file_input_param_names and compares the returned strings to the original list. Nothing outside the test is changed.

**Call relations**: This test exercises the metadata-reading helper directly and guards against future code that might normalize, expand, or reinterpret those names.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tool_with_model_visible_input_schema_masks_file_params`  (lines 144–195)

```
fn tool_with_model_visible_input_schema_masks_file_params()
```

**Purpose**: Verifies that file-upload inputs are rewritten into a form the model should see: absolute local file paths. This hides raw file-object schemas that are not useful for model tool calls.

**Data flow**: The test creates a fake upload tool whose schema has object and array file fields, and metadata marking those fields as file parameters. It passes the tool through tool_with_model_visible_input_schema. The output schema should describe strings, or arrays of strings, with instructions to provide absolute paths.

**Call relations**: It uses create_test_tool for setup and then exercises tool_with_model_visible_input_schema, proving that declared file fields are masked before tools are shown to the model.

*Call graph*: calls 2 internal fn (create_test_tool, tool_with_model_visible_input_schema); 4 external calls (new, assert_eq!, Meta, json!).


##### `tool_with_model_visible_input_schema_leaves_tools_without_file_params_unchanged`  (lines 198–204)

```
fn tool_with_model_visible_input_schema_leaves_tools_without_file_params_unchanged()
```

**Purpose**: Confirms that tools without declared file parameters are not modified. This prevents harmless schemas from being rewritten unnecessarily.

**Data flow**: The test creates a normal fake tool with no file-parameter metadata. It passes it through tool_with_model_visible_input_schema and compares the result to the original. The before and after should be identical.

**Call relations**: It uses create_test_tool for setup and checks the no-op path of tool_with_model_visible_input_schema.

*Call graph*: calls 2 internal fn (create_test_tool, tool_with_model_visible_input_schema); 1 external calls (assert_eq!).


##### `elicitation_granular_policy_defaults_to_prompting`  (lines 207–226)

```
fn elicitation_granular_policy_defaults_to_prompting()
```

**Purpose**: Checks the default approval behavior for MCP elicitations, which are server requests asking the user for extra input. Most approval modes should allow prompting unless the granular setting explicitly disables MCP elicitations.

**Data flow**: The test feeds several approval policies into elicitation_is_rejected_by_policy. It expects normal prompting policies to return false, meaning not rejected, and a granular policy with mcp_elicitations set to false to return true. It only reads results.

**Call relations**: This directly exercises the policy decision helper so later elicitation flows know whether they may ask the user.

*Call graph*: 1 external calls (assert!).


##### `elicitation_granular_policy_respects_never_and_config`  (lines 229–240)

```
fn elicitation_granular_policy_respects_never_and_config()
```

**Purpose**: Verifies that policies meant to block elicitations really do block them. This protects users who configured Codex not to ask for additional MCP input.

**Data flow**: The test passes AskForApproval::Never and a granular policy with MCP elicitations disabled into elicitation_is_rejected_by_policy. Both should report rejection. No external state is changed.

**Call relations**: It complements the default-prompting test by checking the explicit denial paths in the same policy helper.

*Call graph*: 1 external calls (assert!).


##### `disabled_permissions_auto_accept_elicitation_with_empty_form_schema`  (lines 243–273)

```
async fn disabled_permissions_auto_accept_elicitation_with_empty_form_schema()
```

**Purpose**: Checks that when permissions are disabled, a harmless empty confirmation form can be accepted automatically. An empty form asks for no user-provided data, so accepting it cannot leak information.

**Data flow**: The test creates an ElicitationRequestManager with approval set to Never and a Disabled permission profile. It sends a form elicitation with no requested fields. The returned response should be Accept with an empty JSON object.

**Call relations**: It exercises ElicitationRequestManager::new and its sender path, proving the auto-response behavior for empty forms.

*Call graph*: calls 1 internal fn (new); 4 external calls (Number, assert_eq!, bounded, builder).


##### `disabled_permissions_do_not_auto_accept_elicitation_with_requested_fields`  (lines 276–310)

```
async fn disabled_permissions_do_not_auto_accept_elicitation_with_requested_fields()
```

**Purpose**: Checks that disabled permissions do not silently fill in requested user data. If a server asks for a required field, Codex should decline instead of guessing or exposing information.

**Data flow**: The test creates an ElicitationRequestManager under disabled permissions and sends a form asking for a required string field. The manager returns Decline with no content. The test verifies that response.

**Call relations**: It exercises the same sender flow as the empty-form test, but covers the safer decline path when real input is requested.

*Call graph*: calls 1 internal fn (new); 6 external calls (Number, assert_eq!, bounded, builder, String, new).


##### `test_normalize_tools_short_non_duplicated_names`  (lines 313–329)

```
fn test_normalize_tools_short_non_duplicated_names()
```

**Purpose**: Verifies that simple, unique tool names are exposed with the expected MCP prefix. This keeps model-visible names predictable for ordinary servers.

**Data flow**: The test starts with two fake tools from the same server. It runs normalize_tools_for_model_with_prefix with prefixing enabled. The output should contain names under the mcp__server1 namespace.

**Call relations**: It is a basic check of normalize_tools_for_model_with_prefix before the later tests cover edge cases like duplicates and invalid characters.

*Call graph*: calls 1 internal fn (normalize_tools_for_model_with_prefix); 2 external calls (assert_eq!, vec!).


##### `test_normalize_tools_duplicated_names_skipped`  (lines 332–346)

```
fn test_normalize_tools_duplicated_names_skipped()
```

**Purpose**: Checks that duplicate tool entries do not both get exposed to the model. Duplicate names would make a model call ambiguous.

**Data flow**: The test creates two identical fake tools and normalizes them. It then checks that only one model-visible name remains. The second duplicate is expected to be skipped.

**Call relations**: It exercises normalize_tools_for_model_with_prefix in the duplicate-name case and confirms the deduplication rule.

*Call graph*: calls 1 internal fn (normalize_tools_for_model_with_prefix); 2 external calls (assert_eq!, vec!).


##### `test_normalize_tools_long_names_same_server`  (lines 349–380)

```
fn test_normalize_tools_long_names_same_server()
```

**Purpose**: Verifies that very long tool names are shortened safely while staying distinct. This matters because model-facing tool names have practical length limits.

**Data flow**: The test creates two long-named tools from one server and normalizes them. It checks that both remain, both names are exactly the target length, both use the expected namespace, and both contain only safe characters.

**Call relations**: It calls normalize_tools_for_model_with_prefix, then uses model_tool_names, model_tool_name_len, and is_code_mode_compatible_tool_name to inspect the result.

*Call graph*: calls 2 internal fn (model_tool_names, normalize_tools_for_model_with_prefix); 3 external calls (assert!, assert_eq!, vec!).


##### `test_normalize_tools_sanitizes_invalid_characters`  (lines 383–411)

```
fn test_normalize_tools_sanitizes_invalid_characters()
```

**Purpose**: Checks that dots and hyphens are converted into safe underscores in model-visible names. At the same time, the original MCP tool name must remain available for the real server call.

**Data flow**: The test creates a server and tool name containing punctuation. After normalization, it expects the callable namespace and name to use underscores, while server_name and the underlying tool.name still preserve the raw MCP values.

**Call relations**: It directly exercises normalize_tools_for_model_with_prefix and then checks both sides of the mapping: model-safe call names and original server-facing names.

*Call graph*: calls 1 internal fn (normalize_tools_for_model_with_prefix); 3 external calls (assert!, assert_eq!, vec!).


##### `test_normalize_tools_keeps_hyphenated_mcp_tools_callable`  (lines 414–429)

```
fn test_normalize_tools_keeps_hyphenated_mcp_tools_callable()
```

**Purpose**: Confirms that hyphenated MCP server and tool names can still be called by the model. The model gets underscore-safe names while the server still receives its original hyphenated tool name.

**Data flow**: The test creates a hyphenated server/tool pair, normalizes it, and checks the canonical name, callable namespace, callable name, and raw tool name. The output should be safe for the model and faithful to the MCP server.

**Call relations**: It exercises normalize_tools_for_model_with_prefix for a common punctuation case.

*Call graph*: calls 1 internal fn (normalize_tools_for_model_with_prefix); 2 external calls (assert_eq!, vec!).


##### `test_normalize_tools_disambiguates_sanitized_namespace_collisions`  (lines 432–460)

```
fn test_normalize_tools_disambiguates_sanitized_namespace_collisions()
```

**Purpose**: Checks that two different server names do not collapse into one namespace after sanitizing. For example, a hyphen and an underscore could otherwise produce the same model-visible name.

**Data flow**: The test creates tools from two servers whose sanitized names would collide. After normalization, it expects two different callable namespaces while preserving the two raw server names. It also checks the names remain code-mode compatible.

**Call relations**: It uses normalize_tools_for_model_with_prefix and model_tool_names to verify collision handling at the namespace level.

*Call graph*: calls 2 internal fn (model_tool_names, normalize_tools_for_model_with_prefix); 3 external calls (assert!, assert_eq!, vec!).


##### `test_normalize_tools_disambiguates_sanitized_tool_name_collisions`  (lines 463–486)

```
fn test_normalize_tools_disambiguates_sanitized_tool_name_collisions()
```

**Purpose**: Checks that two raw tool names that sanitize to the same text still become distinct callable names. Without this, one tool could hide another.

**Data flow**: The test creates two tools named with a hyphen and an underscore variant. After normalization, it confirms the raw tool names are preserved and the callable names are not identical. The output keeps both tools available.

**Call relations**: It exercises normalize_tools_for_model_with_prefix for collisions inside one server namespace.

*Call graph*: calls 1 internal fn (normalize_tools_for_model_with_prefix); 2 external calls (assert_eq!, vec!).


##### `tool_filter_allows_by_default`  (lines 489–493)

```
fn tool_filter_allows_by_default()
```

**Purpose**: Verifies that an empty tool filter lets tools through. This is the baseline behavior when a user has not configured allow or block lists.

**Data flow**: The test creates the default ToolFilter and asks whether it allows an arbitrary tool name. The result should be true. No state changes occur.

**Call relations**: It directly checks ToolFilter::allows in its default configuration.

*Call graph*: 2 external calls (assert!, default).


##### `tool_filter_applies_enabled_list`  (lines 496–504)

```
fn tool_filter_applies_enabled_list()
```

**Purpose**: Checks that an enabled list acts like an allowlist. Only named tools should be available.

**Data flow**: The test builds a ToolFilter whose enabled set contains only "allowed". It asks about "allowed" and "denied". The output should allow the first and reject the second.

**Call relations**: It exercises ToolFilter::allows for configured allowlist behavior.

*Call graph*: 3 external calls (from, new, assert!).


##### `tool_filter_applies_disabled_list`  (lines 507–515)

```
fn tool_filter_applies_disabled_list()
```

**Purpose**: Checks that a disabled list blocks named tools while leaving other tools open. This lets users remove specific tools without listing every allowed one.

**Data flow**: The test builds a ToolFilter with "blocked" in the disabled set. It checks that "blocked" is rejected and "open" is accepted. The filter itself is not changed.

**Call relations**: It covers the blocklist path of ToolFilter::allows.

*Call graph*: 2 external calls (from, assert!).


##### `tool_filter_applies_enabled_then_disabled`  (lines 518–527)

```
fn tool_filter_applies_enabled_then_disabled()
```

**Purpose**: Verifies the ordering when both allow and block lists are present. A tool must first be allowed, and then it can still be removed by the disabled list.

**Data flow**: The test creates a filter where "keep" and "remove" are enabled, but "remove" is also disabled. It expects "keep" to pass, "remove" to fail, and an unknown tool to fail. The result proves disabled wins after enabled.

**Call relations**: It checks the combined rules inside ToolFilter::allows.

*Call graph*: 2 external calls (from, assert!).


##### `filter_tools_applies_per_server_filters`  (lines 530–553)

```
fn filter_tools_applies_per_server_filters()
```

**Purpose**: Checks that filtering can be applied separately to each server’s tools. This matters because different MCP servers can have different user settings.

**Data flow**: The test creates tools for two servers and separate filters for each. It filters each server’s list and combines the results. Only server1's tool_a should remain.

**Call relations**: It exercises filter_tools together with ToolFilter rules, showing how per-server filters shrink a full tool list.

*Call graph*: calls 1 internal fn (filter_tools); 3 external calls (from, assert_eq!, vec!).


##### `codex_apps_tools_cache_is_overwritten_by_last_write`  (lines 556–575)

```
fn codex_apps_tools_cache_is_overwritten_by_last_write()
```

**Purpose**: Verifies that writing the Codex Apps tool cache replaces older contents. Users should see the newest tool list, not a merge of stale and current data.

**Data flow**: The test creates a temporary cache context, writes a tool named "one", reads it back, then writes a tool named "two" and reads again. The final read should contain "two". Disk contents in the temp directory are changed.

**Call relations**: It uses create_codex_apps_tools_cache_context plus write_cached_codex_apps_tools and read_cached_codex_apps_tools to test cache overwrite behavior.

*Call graph*: calls 3 internal fn (read_cached_codex_apps_tools, write_cached_codex_apps_tools, create_codex_apps_tools_cache_context); 3 external calls (assert_eq!, tempdir, vec!).


##### `codex_apps_tools_cache_is_scoped_per_user`  (lines 578–608)

```
fn codex_apps_tools_cache_is_scoped_per_user()
```

**Purpose**: Checks that different users get separate Codex Apps tool caches. This prevents one account’s tools from leaking into another account’s startup view.

**Data flow**: The test creates two cache contexts with different account and user ids, writes different tools to each, and reads both back. Each read should return its own tool, and the cache paths should differ.

**Call relations**: It exercises the cache path and read/write functions through contexts made by create_codex_apps_tools_cache_context.

*Call graph*: calls 3 internal fn (read_cached_codex_apps_tools, write_cached_codex_apps_tools, create_codex_apps_tools_cache_context); 4 external calls (assert_eq!, assert_ne!, tempdir, vec!).


##### `codex_apps_tools_cache_filters_disallowed_connectors`  (lines 611–639)

```
fn codex_apps_tools_cache_filters_disallowed_connectors()
```

**Purpose**: Verifies that cached Codex Apps tools from blocked connectors are not returned. This keeps disallowed integrations from reappearing through the cache.

**Data flow**: The test writes two connector-backed tools, one with a blocked connector id and one allowed connector id. Reading the cache should return only the allowed tool. The blocked tool is filtered from the output.

**Call relations**: It uses create_test_tool_with_connector, then write_cached_codex_apps_tools and read_cached_codex_apps_tools to check cache-time filtering.

*Call graph*: calls 3 internal fn (read_cached_codex_apps_tools, write_cached_codex_apps_tools, create_codex_apps_tools_cache_context); 3 external calls (assert_eq!, tempdir, vec!).


##### `codex_apps_tools_cache_is_ignored_when_schema_version_mismatches`  (lines 642–661)

```
fn codex_apps_tools_cache_is_ignored_when_schema_version_mismatches()
```

**Purpose**: Checks that cache files from an unknown future schema version are ignored. This prevents new-format data from being misread by older code.

**Data flow**: The test manually writes a JSON cache file with a schema version higher than the current constant. It then tries to read it through read_cached_codex_apps_tools. The result should be None.

**Call relations**: It uses create_codex_apps_tools_cache_context for the path and then bypasses normal writing to simulate an incompatible cache file.

*Call graph*: calls 1 internal fn (create_codex_apps_tools_cache_context); 6 external calls (assert!, json!, to_vec_pretty, create_dir_all, write, tempdir).


##### `codex_apps_tools_cache_is_ignored_when_json_is_invalid`  (lines 664–678)

```
fn codex_apps_tools_cache_is_ignored_when_json_is_invalid()
```

**Purpose**: Checks that a corrupted cache file does not crash or produce bad tools. A broken disk cache should simply be skipped.

**Data flow**: The test writes invalid JSON bytes into the expected cache path. It calls read_cached_codex_apps_tools and expects None. The temporary file is the only changed state.

**Call relations**: It uses create_codex_apps_tools_cache_context to locate the cache and tests the read function’s error-tolerant path.

*Call graph*: calls 1 internal fn (create_codex_apps_tools_cache_context); 4 external calls (assert!, create_dir_all, write, tempdir).


##### `startup_cached_codex_apps_tools_loads_from_disk_cache`  (lines 681–714)

```
fn startup_cached_codex_apps_tools_loads_from_disk_cache()
```

**Purpose**: Verifies that startup can load both cached Codex Apps tools and server info from disk. This lets Codex show known tools quickly before live startup completes.

**Data flow**: The test writes a cache snapshot with one tool and server info. It then loads the startup tool snapshot and server info. The outputs should match what was written.

**Call relations**: It ties together write_cached_codex_apps_tools_if_needed, load_startup_cached_codex_apps_tools_snapshot, and load_startup_cached_codex_apps_server_info.

*Call graph*: calls 5 internal fn (load_startup_cached_codex_apps_server_info, load_startup_cached_codex_apps_tools_snapshot, write_cached_codex_apps_tools_if_needed, create_codex_apps_tools_cache_context, create_test_server_info); 3 external calls (assert_eq!, tempdir, vec!).


##### `startup_cached_codex_apps_tools_loads_without_server_info_cache`  (lines 717–748)

```
fn startup_cached_codex_apps_tools_loads_without_server_info_cache()
```

**Purpose**: Checks backward compatibility with older cache files that only contain tools. Old caches should still help startup even if they lack separate server info.

**Data flow**: The test manually writes a cache file with the current tool schema but no server info cache. Loading startup tools should succeed, while loading server info should return None.

**Call relations**: It uses create_codex_apps_tools_cache_context and the startup cache readers to cover the legacy cache shape.

*Call graph*: calls 3 internal fn (load_startup_cached_codex_apps_server_info, load_startup_cached_codex_apps_tools_snapshot, create_codex_apps_tools_cache_context); 6 external calls (assert_eq!, json!, to_vec_pretty, create_dir_all, write, tempdir).


##### `codex_apps_server_info_cache_survives_legacy_tools_cache_write`  (lines 751–794)

```
fn codex_apps_server_info_cache_survives_legacy_tools_cache_write()
```

**Purpose**: Verifies that server info cached separately is not lost when an older-style tools cache is later written. Tool-cache compatibility should not erase useful server metadata.

**Data flow**: The test first writes a modern cache including server info. It then overwrites the tools cache file with an older schema version. Loading server info should still succeed, while the old tools snapshot should be ignored.

**Call relations**: It uses create_test_server_info, create_test_tool, write_cached_codex_apps_tools_if_needed, and the startup cache readers to check separation between tool and server-info caches.

*Call graph*: calls 4 internal fn (write_cached_codex_apps_tools_if_needed, create_codex_apps_tools_cache_context, create_test_server_info, create_test_tool); 7 external calls (assert!, assert_eq!, json!, to_vec_pretty, create_dir_all, write, tempdir).


##### `list_all_tools_uses_cached_tool_info_snapshot_while_client_is_pending`  (lines 797–834)

```
async fn list_all_tools_uses_cached_tool_info_snapshot_while_client_is_pending()
```

**Purpose**: Checks that the connection manager can list cached tools while a live MCP client is still starting. This avoids making users wait when a startup cache is available.

**Data flow**: The test builds an uninitialized manager and inserts a fake client future that never finishes, plus a cached tool snapshot. Calling list_all_tools should return the cached tool immediately after normalizing its model-visible name.

**Call relations**: It uses McpConnectionManager::new_uninitialized and a manually inserted AsyncManagedClient to exercise list_all_tools on the pending-client cache path.

*Call graph*: calls 3 internal fn (new_uninitialized, allow_any, default); 6 external calls (new, new, assert_eq!, default, new, vec!).


##### `list_available_server_infos_uses_cache_while_client_is_pending`  (lines 837–871)

```
async fn list_available_server_infos_uses_cache_while_client_is_pending()
```

**Purpose**: Checks that cached server info can be listed without waiting for client startup. Server names and titles should remain available even if connection setup is slow.

**Data flow**: The test inserts a pending client with cached server info into an uninitialized manager. It calls list_available_server_infos under a short timeout. The result should arrive promptly and contain the cached info.

**Call relations**: It uses create_test_server_info and McpConnectionManager::new_uninitialized to verify the cached-server-info path.

*Call graph*: calls 4 internal fn (new_uninitialized, create_test_server_info, allow_any, default); 8 external calls (new, new, from_millis, new, assert_eq!, default, new, timeout).


##### `list_all_tools_accepts_canonical_namespaced_tool_names`  (lines 874–914)

```
async fn list_all_tools_accepts_canonical_namespaced_tool_names()
```

**Purpose**: Verifies the modern naming mode where tools keep their server namespace without the legacy mcp__ prefix. This supports canonical namespaced MCP tool calls.

**Data flow**: The test inserts a cached tool for server "rmcp" with prefixing disabled. list_all_tools should return a tool whose canonical name is namespace "rmcp" and name "echo", while preserving the raw MCP tool name.

**Call relations**: It exercises list_all_tools through an uninitialized manager configured with prefix_mcp_tool_names set to false.

*Call graph*: calls 3 internal fn (new_uninitialized, allow_any, default); 6 external calls (new, new, assert_eq!, default, new, vec!).


##### `list_all_tools_applies_legacy_mcp_prefix_by_default`  (lines 917–957)

```
async fn list_all_tools_applies_legacy_mcp_prefix_by_default()
```

**Purpose**: Checks the older default naming behavior where MCP namespaces receive an mcp__ prefix. This protects compatibility for clients expecting the legacy model-visible name.

**Data flow**: The test inserts a cached "rmcp" tool with prefixing enabled. list_all_tools should expose it under namespace "mcp__rmcp" while keeping the underlying server and raw tool name as "rmcp" and "echo".

**Call relations**: It exercises list_all_tools through an uninitialized manager configured with prefix_mcp_tool_names set to true.

*Call graph*: calls 3 internal fn (new_uninitialized, allow_any, default); 6 external calls (new, new, assert_eq!, default, new, vec!).


##### `list_all_tools_blocks_while_client_is_pending_without_cached_tool_info_snapshot`  (lines 960–986)

```
async fn list_all_tools_blocks_while_client_is_pending_without_cached_tool_info_snapshot()
```

**Purpose**: Checks that list_all_tools waits when there is no cached tool snapshot. Without cached data, the manager cannot safely invent the tool list.

**Data flow**: The test inserts a client future that never finishes and no cached tools. It calls list_all_tools with a very short timeout. The timeout should expire, proving the call is waiting.

**Call relations**: It uses McpConnectionManager::new_uninitialized and a pending AsyncManagedClient to verify the no-cache behavior.

*Call graph*: calls 3 internal fn (new_uninitialized, allow_any, default); 7 external calls (new, new, from_millis, assert!, default, new, timeout).


##### `shutdown_cancels_pending_tool_listing`  (lines 989–1028)

```
async fn shutdown_cancels_pending_tool_listing()
```

**Purpose**: Verifies that shutting down the manager cancels a tool listing that is stuck waiting for startup. This prevents background tasks from hanging during shutdown.

**Data flow**: The test creates a client future that waits on a cancellation token, starts list_all_tools in a task, then calls shutdown. Shutdown cancels the token, the startup future returns Cancelled, and the tool-listing task finishes with an empty list.

**Call relations**: It exercises McpConnectionManager::shutdown together with list_all_tools and the AsyncManagedClient cancellation path.

*Call graph*: calls 3 internal fn (new_uninitialized, allow_any, default); 10 external calls (clone, new, new, from_secs, assert!, default, new, spawn, channel, timeout).


##### `list_all_tools_does_not_block_when_cached_tool_info_snapshot_is_empty`  (lines 1031–1058)

```
async fn list_all_tools_does_not_block_when_cached_tool_info_snapshot_is_empty()
```

**Purpose**: Checks that an empty cached snapshot is still treated as a cache hit. Empty means "we know there are no tools," not "wait for startup."

**Data flow**: The test inserts a pending client with Some(empty vector) as its cached snapshot. Calling list_all_tools under a short timeout should return quickly with an empty list.

**Call relations**: It exercises list_all_tools on the cached-empty case, which is different from having no cache at all.

*Call graph*: calls 3 internal fn (new_uninitialized, allow_any, default); 8 external calls (new, new, from_millis, new, assert!, default, new, timeout).


##### `list_all_tools_uses_cached_tool_info_snapshot_when_client_startup_fails`  (lines 1061–1111)

```
async fn list_all_tools_uses_cached_tool_info_snapshot_when_client_startup_fails()
```

**Purpose**: Verifies that cached tools and server info remain usable after live client startup fails. This gives the system a graceful fallback instead of showing nothing.

**Data flow**: The test inserts a client future that immediately fails, along with cached tools and cached server info. list_all_tools should still return the cached tool, and list_available_server_infos should still return the cached server info.

**Call relations**: It uses McpConnectionManager::new_uninitialized, create_test_server_info, list_all_tools, and list_available_server_infos to test failure fallback.

*Call graph*: calls 4 internal fn (new_uninitialized, create_test_server_info, allow_any, default); 6 external calls (new, new, assert_eq!, default, new, vec!).


##### `list_all_tools_adds_server_metadata_to_cached_tools`  (lines 1114–1157)

```
async fn list_all_tools_adds_server_metadata_to_cached_tools()
```

**Purpose**: Checks that cached tools are enriched with current server metadata before being shown. Cached tool records should still reflect settings like origin URL and parallel-call support.

**Data flow**: The test inserts server metadata for a fake server and a cached tool snapshot for that server. list_all_tools returns the cached tool with supports_parallel_tool_calls set and the server origin filled in. The original cached input is not enough by itself.

**Call relations**: It exercises list_all_tools and the manager’s server_metadata map working together.

*Call graph*: calls 3 internal fn (new_uninitialized, allow_any, default); 9 external calls (new, new, new, assert!, assert_eq!, default, StreamableHttp, new, vec!).


##### `server_metadata_preserves_tool_approval_policy`  (lines 1160–1179)

```
fn server_metadata_preserves_tool_approval_policy()
```

**Purpose**: Verifies that server metadata remembers both default and per-tool approval settings. This matters because some app tools may be auto-approved while others still need prompting.

**Data flow**: The test builds a Codex Apps MCP server config with a default prompt policy and a specific approve policy for "search". It converts the config into McpServerMetadata, then queries approval modes for "read" and "search". The outputs should reflect default and override behavior.

**Call relations**: It exercises McpServerMetadata::from and tool_approval_mode using an EffectiveMcpServer built from configuration.

*Call graph*: calls 2 internal fn (configured, from); 2 external calls (assert_eq!, codex_apps_mcp_server_config).


##### `no_local_runtime_fails_local_stdio_but_keeps_local_http_server`  (lines 1182–1293)

```
async fn no_local_runtime_fails_local_stdio_but_keeps_local_http_server()
```

**Purpose**: Checks behavior when no local execution environment is available. Local stdio MCP servers need a local runtime, but local HTTP servers should still be kept as configured clients.

**Data flow**: The test builds two server configs, one stdio and one streamable HTTP, and creates a manager with EnvironmentManager::without_environments. Both client entries exist, but waiting for the stdio server fails and its startup error says a local environment is required. The test cancels the manager at the end.

**Call relations**: It exercises McpConnectionManager::new with real configuration objects and then inspects wait_for_server_ready and the stdio client startup result.

*Call graph*: calls 7 internal fn (new, new, configured, allow_any, default, without_environments, default); 15 external calls (new, new, default, from, new, from, new, new, assert!, assert_eq! (+5 more)).


##### `elicitation_capability_uses_2025_06_18_shape_for_form_only_support`  (lines 1296–1302)

```
fn elicitation_capability_uses_2025_06_18_shape_for_form_only_support()
```

**Purpose**: Checks the JSON shape advertised for the default elicitation capability. For form-only support, the protocol expects an empty object in this version.

**Data flow**: The test serializes Some(ElicitationCapability::default()) to JSON. It expects the result to be an empty object. No runtime state changes.

**Call relations**: It directly verifies serialization for the capability type used when clients announce what elicitation features they support.

*Call graph*: 2 external calls (default, assert_eq!).


##### `elicitation_capability_advertises_url_support_when_enabled`  (lines 1305–1317)

```
fn elicitation_capability_advertises_url_support_when_enabled()
```

**Purpose**: Checks that URL elicitation support appears in serialized capability JSON when enabled. This tells an MCP server that Codex can handle URL-based elicitations.

**Data flow**: The test builds an ElicitationCapability with form and url fields present, serializes it, and compares the JSON to an object containing both keys. The output is only the serialized value.

**Call relations**: It complements the default-shape test by covering the explicit URL-support path.

*Call graph*: 3 external calls (assert_eq!, default, default).


##### `mcp_init_error_display_prompts_for_github_pat`  (lines 1320–1356)

```
fn mcp_init_error_display_prompts_for_github_pat()
```

**Purpose**: Verifies the special user-facing message for GitHub MCP when OAuth is unsupported. Instead of a vague error, users should be told to configure a personal access token.

**Data flow**: The test builds a GitHub-like MCP auth status entry and an OAuth unsupported startup error. It passes them to mcp_init_error_display. The returned string should include the GitHub token URL and config snippet.

**Call relations**: It exercises mcp_init_error_display for the GitHub-specific authentication-help branch.

*Call graph*: 4 external calls (new, anyhow!, assert_eq!, format!).


##### `mcp_init_error_display_prompts_for_login_when_auth_required`  (lines 1359–1370)

```
fn mcp_init_error_display_prompts_for_login_when_auth_required()
```

**Purpose**: Checks that an authentication-required startup error tells the user to run the MCP login command. This makes a common fix clear.

**Data flow**: The test creates an error saying auth is required and calls mcp_init_error_display without an auth status entry. The output should be a concise login instruction for that server.

**Call relations**: It exercises mcp_init_error_display for the general login-needed branch.

*Call graph*: 3 external calls (anyhow!, assert_eq!, format!).


##### `mcp_init_error_display_reports_generic_errors`  (lines 1373–1407)

```
fn mcp_init_error_display_reports_generic_errors()
```

**Purpose**: Verifies that ordinary startup failures are reported with the server name and underlying error. This is the fallback when no special authentication hint applies.

**Data flow**: The test builds a custom HTTP server auth entry and a generic "boom" error. It calls mcp_init_error_display and expects the standard failure message. Nothing else changes.

**Call relations**: It exercises mcp_init_error_display for the generic error branch after the special cases are ruled out.

*Call graph*: 4 external calls (new, anyhow!, assert_eq!, format!).


##### `mcp_init_error_display_includes_startup_timeout_hint`  (lines 1410–1420)

```
fn mcp_init_error_display_includes_startup_timeout_hint()
```

**Purpose**: Checks that timeout failures include a practical configuration hint. Users should learn that they can adjust startup_timeout_sec for slow MCP servers.

**Data flow**: The test creates an error saying the request timed out and passes it to mcp_init_error_display. The returned text should mention the default timeout and show the config.toml snippet to change it.

**Call relations**: It exercises the timeout-specific branch of mcp_init_error_display.

*Call graph*: 2 external calls (anyhow!, assert_eq!).


### `ext/mcp/tests/executor_plugin_mcp.rs`

`test` · `test run`

This is a focused test for plugin-provided MCP servers. MCP here means “Model Context Protocol,” a way for Codex to connect to external tools or services through named servers. The test builds a fake plugin folder on disk, gives it a plugin manifest, and adds an `.mcp.json` file with three server definitions. Then it builds a fake Codex configuration that says the enterprise policy allows one server command, expects a different command for another server, and says nothing about the third.

The important idea is trust by identity. A selected plugin comes from a selected capability root, which has an ID chosen by Codex. The plugin’s own manifest may have a different name. This test verifies that the enterprise requirements are matched against the selected root ID, `selected-root`, rather than the name inside the plugin manifest.

The helper function sets up the extension registry just like the real system would, tells it which plugin root is selected, asks the MCP contributor to produce server contributions, and reduces those contributions to a small summary. The assertion then checks that the allowed server stays enabled, while the command mismatch and the unlisted server are disabled. Without this behavior, an enterprise-managed setup could accidentally allow the wrong plugin server, or reject the right one, because it looked up requirements under the wrong identity.

#### Function details

##### `selected_plugin_servers_use_managed_requirements_for_the_selected_root_id`  (lines 27–91)

```
async fn selected_plugin_servers_use_managed_requirements_for_the_selected_root_id() -> TestResult
```

**Purpose**: This test proves that selected plugin MCP servers are checked against requirements for the selected root ID. It also proves that server entries are disabled when they are not listed by policy or when their command does not match the managed requirement.

**Data flow**: It starts with two temporary folders: one pretending to be Codex’s home folder and one pretending to be a plugin folder. It writes a fake plugin manifest and an `.mcp.json` file containing three MCP servers. It then builds a test configuration with enterprise requirements for the `selected-root` plugin ID. That setup is passed to `selected_plugin_contributions`, which returns simple summaries of the server contributions. Finally, the test compares those summaries with the expected result: one enabled server and two disabled servers.

**Call relations**: This is the top-level test case. It prepares the fake files and fake configuration, then calls `selected_plugin_contributions` to exercise the real extension contribution path. After that helper returns, this test checks the final behavior with an equality assertion.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, selected_plugin_contributions); 5 external calls (assert_eq!, default, create_dir_all, write, tempdir).


##### `selected_plugin_contributions`  (lines 93–139)

```
async fn selected_plugin_contributions(
    config: &Config,
    plugin_root: &std::path::Path,
) -> Vec<ContributionSummary>
```

**Purpose**: This helper runs the MCP plugin contribution machinery in a small test setup and turns its results into easy-to-compare summaries. It exists so the test can focus on the meaning of the contributions rather than the setup details.

**Data flow**: It receives a Codex configuration and the path to the fake plugin folder. It creates an extension registry, installs the executor plugin support into it, and builds thread-local extension data saying that `selected-root` points to the fake plugin folder in the local test environment. It then asks the first MCP server contributor to produce contributions for that context. Each selected-plugin contribution is converted into a `ContributionSummary` containing the server name, plugin ID, display name, selection order, and whether that server is enabled. If any other kind of contribution appears, the helper stops the test because that is not the shape this test is meant to verify.

**Call relations**: This function is called by `selected_plugin_servers_use_managed_requirements_for_the_selected_root_id` after the fake plugin and configuration are ready. Inside, it wires together the extension registry, test environment manager, selected capability root data, and MCP contribution context, then hands the resulting summaries back to the test for comparison.

*Call graph*: calls 4 internal fn (default_for_tests, for_thread, new, new); called by 1 (selected_plugin_servers_use_managed_requirements_for_the_selected_root_id); 4 external calls (new, initialize_executor_plugin_thread_data, install_executor_plugins, vec!).


### `ext/mcp/tests/hosted_apps_mcp.rs`

`test` · `test run`

MCP means Model Context Protocol, a way for Codex to talk to outside tools or services through named servers. This test file focuses on one special server: the hosted Codex Apps MCP server. That server is reserved by Codex, so the project needs clear rules for when it appears and what settings it uses.

The tests build temporary Codex configurations, turn the Apps feature on or off, add fake user MCP settings, and use either ChatGPT-style auth or API-key auth. They then ask `McpManager` what servers would actually be active. Think of this like checking the final guest list after house rules, user requests, and plugin suggestions have all been combined.

The file verifies several important promises. When Apps are enabled and ChatGPT auth is present, the hosted Apps server is contributed with the expected ChatGPT URL. If a user has explicitly disabled that server, the disabled state is preserved. If the newer extension system is not installed, an older fallback still supplies the legacy Apps MCP URL. A later extension can remove the reserved server by name. API-key authentication does not enable the hosted Apps server. And when Apps are disabled, any reserved `codex_apps` server config is removed for both extension-backed and legacy manager setups.

It also defines a tiny fake extension, `RemoveCodexApps`, used to prove that extension ordering can remove an earlier contribution.

#### Function details

##### `contributes_hosted_plugin_runtime_without_an_executor`  (lines 19–44)

```
async fn contributes_hosted_plugin_runtime_without_an_executor() -> TestResult
```

**Purpose**: This test checks the happy path for hosted Codex Apps MCP. When the Apps feature is enabled and the user is authenticated with ChatGPT, Codex should add the hosted Apps server automatically, even without a separate local executor.

**Data flow**: It starts with a fresh temporary Codex home folder and builds a config with Apps enabled and a ChatGPT base URL. It creates dummy ChatGPT authentication, builds an MCP manager with the Codex MCP extension installed, and asks for the final effective server list. The expected result is a configured `codex_apps` server whose transport is streamable HTTP and whose URL points to the ChatGPT Apps MCP endpoint.

**Call relations**: This test calls `installed_manager` to create the normal extension-backed MCP manager used by installed Codex. It then relies on the manager’s effective-server calculation and compares the resulting server URL against the expected hosted endpoint.

*Call graph*: calls 2 internal fn (installed_manager, create_dummy_chatgpt_auth_for_testing); 5 external calls (assert_eq!, default, panic!, tempdir, vec!).


##### `runtime_overlay_preserves_disabled_server`  (lines 47–72)

```
async fn runtime_overlay_preserves_disabled_server() -> TestResult
```

**Purpose**: This test makes sure Codex does not secretly re-enable the reserved Apps MCP server when the user has explicitly disabled it. The hosted runtime overlay may update server details, but it must respect the user’s disabled setting.

**Data flow**: It builds a temporary config where Apps are enabled, a `codex_apps` MCP URL is supplied, and that same server is marked disabled. With dummy ChatGPT authentication and an installed extension manager, it computes the effective servers. The `codex_apps` entry should still exist, but its enabled flag should remain false.

**Call relations**: Like the main hosted-runtime test, it uses `installed_manager` to include the Codex MCP extension. It then asks `McpManager` for the final merged view and checks that the merge preserved the disabled state instead of blindly turning the server on.

*Call graph*: calls 2 internal fn (installed_manager, create_dummy_chatgpt_auth_for_testing); 4 external calls (assert!, default, tempdir, vec!).


##### `legacy_fallback_overwrites_reserved_config_without_an_extension`  (lines 75–105)

```
async fn legacy_fallback_overwrites_reserved_config_without_an_extension() -> TestResult
```

**Purpose**: This test checks the older fallback behavior used when the Codex MCP extension is not installed. Even if a user supplies a reserved `codex_apps` URL, the legacy path should replace it with Codex’s own legacy Apps MCP endpoint.

**Data flow**: It creates a temporary config with Apps enabled and a user-provided `codex_apps` URL. It creates dummy ChatGPT authentication, but builds `McpManager` without installing the extension registry. After asking for effective servers, it expects `codex_apps` to exist as a streamable HTTP server using the legacy ChatGPT Apps URL rather than the user-provided URL.

**Call relations**: This test deliberately does not call `installed_manager`; instead it constructs `McpManager` directly with a `PluginsManager`. That creates the legacy path, letting the test compare behavior when no extension contributes the hosted Apps server.

*Call graph*: calls 3 internal fn (new, new, create_dummy_chatgpt_auth_for_testing); 6 external calls (new, assert_eq!, default, panic!, tempdir, vec!).


##### `later_extension_can_remove_same_name_registration`  (lines 108–129)

```
async fn later_extension_can_remove_same_name_registration() -> TestResult
```

**Purpose**: This test proves that a later MCP extension can remove an earlier server contribution with the same reserved name. It protects the extension system’s ordering and removal behavior.

**Data flow**: It builds a temporary config with Apps enabled and dummy ChatGPT authentication. It creates an extension registry, installs the normal Codex MCP extension, then adds the fake `RemoveCodexApps` contributor afterward. When the final effective server list is computed, the `codex_apps` server should be absent.

**Call relations**: The test wires together the real Codex MCP extension and the local `RemoveCodexApps` test extension. `RemoveCodexApps::contribute` supplies a removal contribution, and `McpManager::new_with_extensions` applies those extension results when building the final server list.

*Call graph*: calls 4 internal fn (new, new_with_extensions, new, create_dummy_chatgpt_auth_for_testing); 6 external calls (new, assert!, install, default, tempdir, vec!).


##### `hosted_apps_mcp_requires_chatgpt_auth`  (lines 132–147)

```
async fn hosted_apps_mcp_requires_chatgpt_auth() -> TestResult
```

**Purpose**: This test checks that hosted Codex Apps MCP is only added for ChatGPT authentication, not for a plain API key. That matters because the hosted Apps endpoint depends on ChatGPT-style account access.

**Data flow**: It creates a temporary config with Apps enabled, then creates authentication from an API key instead of dummy ChatGPT auth. It builds the normal installed manager and asks for effective servers. The expected output is that no `codex_apps` server is present.

**Call relations**: The test uses `installed_manager` so the Codex MCP extension is available, then confirms that authentication type still controls whether the extension’s hosted Apps server is allowed to appear.

*Call graph*: calls 2 internal fn (installed_manager, from_api_key); 4 external calls (assert!, default, tempdir, vec!).


##### `disabled_apps_remove_reserved_server_config_for_all_hosts`  (lines 150–175)

```
async fn disabled_apps_remove_reserved_server_config_for_all_hosts() -> TestResult
```

**Purpose**: This test ensures that turning off the Apps feature removes the reserved `codex_apps` MCP server configuration everywhere. A user-provided reserved URL should not survive when Apps are disabled.

**Data flow**: It builds a temporary config with Apps disabled but with a `codex_apps` URL present in the MCP server settings. It creates two managers: one with the Codex MCP extension installed and one using the direct legacy setup. For each manager, it asks for runtime servers and expects the reserved Apps server name to be missing.

**Call relations**: This test compares both main manager setups: the extension-backed path from `installed_manager` and the legacy path built directly from `McpManager` and `PluginsManager`. It confirms both paths apply the same removal rule when Apps are disabled.

*Call graph*: calls 3 internal fn (new, new, installed_manager); 5 external calls (new, assert!, default, tempdir, vec!).


##### `installed_manager`  (lines 177–184)

```
fn installed_manager(config: &Config) -> McpManager
```

**Purpose**: This helper builds an `McpManager` in the same style as an installed Codex setup, with the Codex MCP extension registered. Tests use it when they want to exercise the normal extension-backed behavior.

**Data flow**: It receives a `Config`, reads the Codex home path from it, creates a new extension registry builder, installs the Codex MCP extension into that builder, and creates a `PluginsManager` rooted at the Codex home. It returns an `McpManager` that uses both the plugin manager and the built extension registry.

**Call relations**: Several tests call this helper to avoid repeating setup. It hands them a ready-to-use manager, and those tests then ask that manager for effective or runtime MCP servers.

*Call graph*: calls 3 internal fn (new, new_with_extensions, new); called by 4 (contributes_hosted_plugin_runtime_without_an_executor, disabled_apps_remove_reserved_server_config_for_all_hosts, hosted_apps_mcp_requires_chatgpt_auth, runtime_overlay_preserves_disabled_server); 2 external calls (new, install).


##### `RemoveCodexApps::id`  (lines 189–191)

```
fn id(&self) -> &'static str
```

**Purpose**: This gives the fake test extension a stable identifier. The identifier lets the extension system name this contributor when it is registered.

**Data flow**: It takes no meaningful input beyond the `RemoveCodexApps` instance. It returns the fixed text value `remove_codex_apps` and does not change any state.

**Call relations**: The extension system can call this method as part of treating `RemoveCodexApps` like any other MCP server contributor. In this test file, the contributor is registered after the real Codex MCP extension to help test removal behavior.


##### `RemoveCodexApps::contribute`  (lines 193–202)

```
fn contribute(
        &'a self,
        _context: McpServerContributionContext<'a, Config>,
    ) -> codex_extension_api::ExtensionFuture<'a, Vec<McpServerContribution>>
```

**Purpose**: This fake contributor asks the MCP system to remove the `codex_apps` server. It exists only for testing that later extensions can undo an earlier server registration.

**Data flow**: It receives a contribution context but does not need to read it. It returns an asynchronous result containing one contribution: a request to remove the server named by `CODEX_APPS_MCP_SERVER_NAME`. It does not create a server; it creates a deletion instruction.

**Call relations**: The `later_extension_can_remove_same_name_registration` test registers this contributor after installing the real Codex MCP extension. When `McpManager` collects extension contributions, this removal contribution should cancel the earlier `codex_apps` registration.

*Call graph*: 2 external calls (pin, vec!).


### `core/tests/suite/rmcp_client.rs`

`test` · `integration test execution`

MCP, or Model Context Protocol, is a way for Codex to connect the model to outside tools. This file tests that connection end to end, using small fake MCP servers and fake model responses. Think of it like a rehearsal: the mocked model asks Codex to call a tool, Codex contacts the MCP server, the server returns data, and Codex sends that result back to the model.

The tests cover two kinds of MCP server connections. One is stdio, where Codex starts a helper program and talks to it through its standard input and output. The other is Streamable HTTP, where Codex connects to an HTTP endpoint. The file also has extra plumbing for remote test runs, where helper binaries must be copied into a Docker container before they can be launched.

The suite checks many important edge cases: environment variables are passed only when allowed, configured working directories take priority, read-only tools may run in parallel, mutable tools run serially unless the server opts in, image results are converted or removed depending on model support, sandbox information is included, startup can be cancelled cleanly, and OAuth credentials are used for protected HTTP MCP servers. Without tests like these, regressions in tool calling could silently break real user workflows.

#### Function details

##### `assert_wall_time_line`  (lines 81–83)

```
fn assert_wall_time_line(line: &str)
```

**Purpose**: Checks that a line of text has the expected wall-time format, such as `Wall time: 1.23 seconds`. The tests use this to make sure tool outputs include timing information in the format Codex promises.

**Data flow**: It receives one text line, compares it with a regular expression pattern, and fails the test if the line does not match. It does not return a value; success means the line looked right.

**Call relations**: Output-parsing helpers call this before they inspect the rest of an MCP tool result. It relies on the shared test assertion helper `assert_regex_match` to do the actual pattern check.

*Call graph*: called by 2 (assert_wall_time_header, split_wall_time_wrapped_output); 1 external calls (assert_regex_match).


##### `split_wall_time_wrapped_output`  (lines 85–92)

```
fn split_wall_time_wrapped_output(output: &str) -> &str
```

**Purpose**: Peels off the timing header from a tool output string so tests can inspect the real payload underneath. This is used when MCP results are wrapped as text before being sent back to the model.

**Data flow**: It takes a full output string, splits off the first line, verifies that first line is a valid wall-time line, then removes the `Output:` marker. It returns the remaining payload text.

**Call relations**: Several MCP tests call this after reading the model-facing `function_call_output`. It delegates timing validation to `assert_wall_time_line` and hands the unwrapped JSON text back to the test.

*Call graph*: calls 1 internal fn (assert_wall_time_line); called by 6 (stdio_image_responses_are_sanitized_for_text_only_model, stdio_mcp_parallel_tool_calls_default_false_runs_serially, stdio_mcp_parallel_tool_calls_opt_in_runs_concurrently, stdio_mcp_read_only_tool_calls_run_concurrently_without_server_opt_in, stdio_mcp_tool_call_includes_sandbox_state_meta, stdio_server_round_trip).


##### `assert_wall_time_header`  (lines 94–100)

```
fn assert_wall_time_header(output: &str)
```

**Purpose**: Checks that an output item contains only the standard timing header and the `Output:` marker. This is useful for image outputs, where the timing text is a separate content item.

**Data flow**: It receives a text block, splits it into the timing line and marker line, verifies the timing line, and asserts that the marker is exactly `Output:`. It changes nothing outside the test assertion.

**Call relations**: Image-related tests call this when they expect the first item sent back to the model to be the wall-time header. It reuses `assert_wall_time_line` for the timing check.

*Call graph*: calls 1 internal fn (assert_wall_time_line); called by 2 (stdio_image_responses_preserve_original_detail_metadata, stdio_image_responses_round_trip); 1 external calls (assert_eq!).


##### `read_only_user_turn`  (lines 102–104)

```
fn read_only_user_turn(fixture: &TestCodex, text: impl Into<String>) -> Op
```

**Purpose**: Builds a test user message that tells Codex to run in read-only mode using the fixture's current model. Read-only mode means tools should not make changes to the workspace.

**Data flow**: It receives a test fixture and message text, reads the model from the fixture, and creates an `Op::UserInput` operation with read-only permissions. The returned operation can be submitted to Codex.

**Call relations**: Most tests use this when they want a normal safe turn. It is a small wrapper around `read_only_user_turn_with_model`, which does the fuller construction.

*Call graph*: calls 1 internal fn (read_only_user_turn_with_model); called by 11 (call_cwd_tool, remote_stdio_env_var_source_does_not_copy_local_env, stdio_image_responses_preserve_original_detail_metadata, stdio_image_responses_resize_large_image, stdio_image_responses_round_trip, stdio_mcp_read_only_tool_calls_run_concurrently_without_server_opt_in, stdio_server_propagates_explicit_local_env_var_source, stdio_server_propagates_whitelisted_env_vars, stdio_server_round_trip, streamable_http_tool_call_round_trip (+1 more)).


##### `read_only_user_turn_with_model`  (lines 106–112)

```
fn read_only_user_turn_with_model(
    fixture: &TestCodex,
    text: impl Into<String>,
    model: String,
) -> Op
```

**Purpose**: Builds a read-only test user message but lets the caller choose the model explicitly. This lets tests check behavior that depends on model capabilities, such as whether images are supported.

**Data flow**: It receives a fixture, text, and model name, creates a read-only permission profile, and passes everything to the shared user-turn builder. It returns a ready-to-submit Codex operation.

**Call relations**: It is called by `read_only_user_turn` for the common case and directly by the text-only image test. It hands off to `user_turn_with_permission_profile` for the actual operation layout.

*Call graph*: calls 2 internal fn (user_turn_with_permission_profile, read_only); called by 2 (read_only_user_turn, stdio_image_responses_are_sanitized_for_text_only_model).


##### `auto_approved_user_turn`  (lines 114–121)

```
fn auto_approved_user_turn(fixture: &TestCodex, text: impl Into<String>) -> Op
```

**Purpose**: Builds a test user message where tool actions are automatically approved. Tests use this when approval prompts would get in the way of checking scheduling behavior.

**Data flow**: It receives a fixture and message text, reads the fixture model, chooses a disabled permission profile, and returns a Codex user input operation. The operation tells Codex not to ask for approval.

**Call relations**: Parallel-tool scheduling tests call this for mutable tools. It uses `user_turn_with_permission_profile` so it gets the same thread settings structure as other test turns.

*Call graph*: calls 1 internal fn (user_turn_with_permission_profile); called by 2 (stdio_mcp_parallel_tool_calls_default_false_runs_serially, stdio_mcp_parallel_tool_calls_opt_in_runs_concurrently).


##### `user_turn_with_permission_profile`  (lines 123–155)

```
fn user_turn_with_permission_profile(
    fixture: &TestCodex,
    text: impl Into<String>,
    model: String,
    permission_profile: PermissionProfile,
) -> Op
```

**Purpose**: Creates the full Codex user-input operation used by the tests, including text, model choice, sandbox rules, approval rules, and permission settings. It is the common factory for test turns.

**Data flow**: It receives the fixture, text, model name, and permission profile. It converts the permission profile into sandbox and permission fields for the fixture workspace, then builds and returns an `Op::UserInput` value.

**Call relations**: `read_only_user_turn_with_model` and `auto_approved_user_turn` both call this. It calls `turn_permission_fields` to translate a human-level permission choice into the detailed protocol fields Codex expects.

*Call graph*: calls 1 internal fn (turn_permission_fields); called by 2 (auto_approved_user_turn, read_only_user_turn_with_model); 2 external calls (default, vec!).


##### `remote_aware_environment_id`  (lines 165–171)

```
fn remote_aware_environment_id() -> String
```

**Purpose**: Chooses which MCP environment id tests should use. In remote test runs it returns the special remote id; otherwise it returns the normal default id.

**Data flow**: It reads the current test environment, checks whether it is remote, and returns the appropriate environment id string. It does not modify configuration itself.

**Call relations**: Remote-aware tests use this value when inserting MCP server configuration. It relies on the shared `test_environment` helper to know where the test is running.

*Call graph*: 1 external calls (test_environment).


##### `remote_aware_stdio_server_bin`  (lines 180–197)

```
fn remote_aware_stdio_server_bin() -> anyhow::Result<String>
```

**Purpose**: Finds the stdio MCP test server executable in a way that works both locally and in remote Docker-based tests. If needed, it copies the executable into the remote container and returns the container path.

**Data flow**: It starts with the host path to the helper binary, checks the test environment, and either returns that path unchanged or copies the binary into Docker. The result is a string path usable by the process that will launch the server.

**Call relations**: Many stdio MCP tests call this before configuring the server command. When a Docker container is active, it delegates the copy work to `copy_binary_to_remote_env`.

*Call graph*: calls 1 internal fn (copy_binary_to_remote_env); called by 13 (remote_stdio_env_var_source_does_not_copy_local_env, stdio_image_responses_are_sanitized_for_text_only_model, stdio_image_responses_preserve_original_detail_metadata, stdio_image_responses_resize_large_image, stdio_image_responses_round_trip, stdio_mcp_parallel_tool_calls_default_false_runs_serially, stdio_mcp_parallel_tool_calls_opt_in_runs_concurrently, stdio_mcp_read_only_tool_calls_run_concurrently_without_server_opt_in, stdio_mcp_tool_call_includes_sandbox_state_meta, stdio_server_propagates_explicit_local_env_var_source (+3 more)); 3 external calls (new, stdio_server_bin, test_environment).


##### `unique_remote_path`  (lines 200–206)

```
fn unique_remote_path(binary_name: &str) -> anyhow::Result<String>
```

**Purpose**: Creates a unique file path inside the remote test container for a copied helper binary. This avoids two parallel tests overwriting each other's files.

**Data flow**: It receives a binary name, combines it with the current process id and current time in nanoseconds, and returns a path under `/tmp/codex-remote-env`. If getting the time fails, it returns an error.

**Call relations**: `copy_binary_to_remote_env` calls this before copying a binary into Docker. It is a small safety helper for remote test setup.

*Call graph*: called by 1 (copy_binary_to_remote_env); 2 external calls (now, format!).


##### `copy_binary_to_remote_env`  (lines 209–263)

```
fn copy_binary_to_remote_env(
    container_name: &str,
    host_path: &Path,
    binary_name: &str,
) -> anyhow::Result<String>
```

**Purpose**: Copies a helper executable from the host machine into the remote Docker test container and makes it executable. Remote MCP tests need this because a path on the host is meaningless inside the container.

**Data flow**: It receives the container name, host file path, and binary name. It creates a unique remote path, makes the remote directory, copies the file with `docker cp`, runs `chmod +x`, and returns the remote path. If any Docker command fails, it returns a detailed error.

**Call relations**: `remote_aware_stdio_server_bin` uses this for stdio tests, and `start_remote_streamable_http_test_server` uses it for HTTP server tests. It uses `unique_remote_path` to avoid filename collisions.

*Call graph*: calls 1 internal fn (unique_remote_path); called by 2 (remote_aware_stdio_server_bin, start_remote_streamable_http_test_server); 3 external calls (new, ensure!, format!).


##### `TestMcpServerOptions::default`  (lines 272–278)

```
fn default() -> Self
```

**Purpose**: Provides the normal MCP test-server options used by most tests. The defaults mean the server is local/default environment, does not opt into parallel mutable calls, and has no custom tool timeout.

**Data flow**: It takes no input and returns a `TestMcpServerOptions` value filled with safe defaults. Callers can override only the fields that matter for a specific test.

**Call relations**: Tests pass this default value, or a modified version of it, into `insert_mcp_server` when building Codex configuration.


##### `stdio_transport`  (lines 281–287)

```
fn stdio_transport(
    command: String,
    env: Option<HashMap<String, String>>,
    env_vars: Vec<McpServerEnvVar>,
) -> McpServerTransportConfig
```

**Purpose**: Builds a basic stdio transport configuration for an MCP server. Stdio here means Codex starts a command and talks to it through standard input and output.

**Data flow**: It receives a command path, optional fixed environment variables, and a list of environment variables to copy through. It returns a transport configuration with no custom working directory.

**Call relations**: Most stdio tests call this when inserting an MCP server into the test configuration. It forwards to `stdio_transport_with_cwd` with no `cwd` value.

*Call graph*: calls 1 internal fn (stdio_transport_with_cwd).


##### `stdio_transport_with_cwd`  (lines 289–302)

```
fn stdio_transport_with_cwd(
    command: String,
    env: Option<HashMap<String, String>>,
    env_vars: Vec<McpServerEnvVar>,
    cwd: Option<PathBuf>,
) -> McpServerTransportConfig
```

**Purpose**: Builds a stdio MCP transport configuration and optionally pins the server's working directory. Tests use this to check which directory the MCP server starts in.

**Data flow**: It receives the command, environment settings, copied environment variable list, and optional working directory. It returns a `McpServerTransportConfig::Stdio` value containing those fields.

**Call relations**: `stdio_transport` calls this for the common no-working-directory case. Working-directory tests call it through `stdio_transport` or directly when they need a configured directory.

*Call graph*: called by 1 (stdio_transport); 1 external calls (new).


##### `insert_mcp_server`  (lines 304–335)

```
fn insert_mcp_server(
    config: &mut Config,
    server_name: &str,
    transport: McpServerTransportConfig,
    options: TestMcpServerOptions,
)
```

**Purpose**: Adds an MCP server entry to a test Codex configuration. This is the central helper that turns a transport and options into the full config shape Codex expects.

**Data flow**: It receives a mutable config, server name, transport, and test options. It clones the existing server map, inserts a new enabled server with startup timeout, parallel-call flag, environment id, and other defaults, then writes the map back into the config.

**Call relations**: Almost every test calls this inside a `with_config` setup closure. It hides the long configuration structure so each test can focus on the behavior being checked.

*Call graph*: 2 external calls (from_secs, new).


##### `call_cwd_tool`  (lines 337–389)

```
async fn call_cwd_tool(
    server: &MockServer,
    fixture: &TestCodex,
    server_name: &str,
    call_id: &str,
) -> anyhow::Result<Value>
```

**Purpose**: Drives a small scripted model interaction that calls an MCP server's `cwd` tool and returns the tool's structured result. It keeps the working-directory tests short and focused.

**Data flow**: It receives the mock model server, fixture, MCP server name, and call id. It mounts fake model streams, submits a read-only user turn, waits for the MCP tool begin and end events, extracts the structured JSON result, waits for turn completion, and returns that JSON.

**Call relations**: The configured-`cwd` and fallback-`cwd` tests call this. It uses `read_only_user_turn`, `mount_sse_once`, and `wait_for_event` to run the full Codex-to-MCP-to-model loop.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, read_only_user_turn); called by 2 (local_stdio_server_uses_runtime_fallback_cwd_when_config_omits_cwd, stdio_server_uses_configured_cwd_before_runtime_fallback); 4 external calls (wait_for_event, format!, unreachable!, vec!).


##### `assert_cwd_tool_output`  (lines 391–417)

```
fn assert_cwd_tool_output(structured: &Value, expected_cwd: &Path)
```

**Purpose**: Checks that the MCP `cwd` tool reported the expected working directory. It accounts for differences between local and remote test environments.

**Data flow**: It receives the structured JSON from the tool and the expected path. It reads the `cwd` string, then either compares the exact remote path or canonicalizes local paths before comparing them. It fails the test if they differ.

**Call relations**: Working-directory tests call this after `call_cwd_tool` returns. It uses `test_environment` to decide whether exact path comparison is appropriate.

*Call graph*: called by 2 (local_stdio_server_uses_runtime_fallback_cwd_when_config_omits_cwd, stdio_server_uses_configured_cwd_before_runtime_fallback); 3 external calls (get, assert_eq!, test_environment).


##### `stdio_server_round_trip`  (lines 421–559)

```
async fn stdio_server_round_trip() -> anyhow::Result<()>
```

**Purpose**: Tests the basic stdio MCP happy path: Codex starts a stdio MCP server, the model asks for the `echo` tool, the tool runs, and the result is sent back to the model.

**Data flow**: The test sets up a mock model server, configures a stdio MCP server with an environment variable, submits a read-only turn, waits for tool begin/end events, inspects the structured result, and checks the final model request contains the wrapped output. It returns success only if all pieces match.

**Call relations**: This is a top-level async test. It depends on helpers such as `remote_aware_stdio_server_bin`, `insert_mcp_server`, `read_only_user_turn`, and `split_wall_time_wrapped_output`.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, read_only_user_turn, remote_aware_stdio_server_bin, split_wall_time_wrapped_output); 10 external calls (assert!, assert_eq!, wait_for_event, wait_for_mcp_server, format!, from_str, skip_if_no_network!, skip_if_wine_exec!, unreachable!, vec!).


##### `shutdown_cancels_startup_prewarm_waiting_for_mcp_startup`  (lines 562–605)

```
async fn shutdown_cancels_startup_prewarm_waiting_for_mcp_startup() -> anyhow::Result<()>
```

**Purpose**: Tests that shutting down Codex does not hang if MCP startup prewarming is still waiting on a slow or stuck server. This protects shutdown from being blocked by startup work.

**Data flow**: It starts a mock websocket model server and a TCP listener that accepts but does not complete an MCP connection. It builds Codex with that pending MCP URL, confirms the connection started, shuts Codex down with a timeout, and checks no model request was sent afterward.

**Call relations**: This top-level test uses `insert_mcp_server` during fixture setup and shared test-server helpers for the websocket side. It focuses on lifecycle cancellation rather than tool results.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 9 external calls (from_millis, from_secs, assert!, format!, skip_if_no_network!, bind, sleep, timeout, vec!).


##### `stdio_server_uses_configured_cwd_before_runtime_fallback`  (lines 609–672)

```
async fn stdio_server_uses_configured_cwd_before_runtime_fallback() -> anyhow::Result<()>
```

**Purpose**: Tests that a stdio MCP server uses the working directory explicitly configured for it instead of falling back to Codex's runtime directory.

**Data flow**: It creates a directory in the test workspace, records that path, configures the stdio MCP server with it, calls the server's `cwd` tool, and asserts the reported path matches the configured directory.

**Call relations**: This top-level test uses `remote_aware_stdio_server_bin`, `insert_mcp_server`, `call_cwd_tool`, and `assert_cwd_tool_output`. It is serialized with other cwd tests to avoid shared-state surprises.

*Call graph*: calls 5 internal fn (start_mock_server, test_codex, assert_cwd_tool_output, call_cwd_tool, remote_aware_stdio_server_bin); 6 external calls (clone, new, new, wait_for_mcp_server, skip_if_no_network!, skip_if_wine_exec!).


##### `local_stdio_server_uses_runtime_fallback_cwd_when_config_omits_cwd`  (lines 677–736)

```
async fn local_stdio_server_uses_runtime_fallback_cwd_when_config_omits_cwd() -> anyhow::Result<()>
```

**Purpose**: Tests the local fallback behavior when a stdio MCP server has no configured working directory. The expected fallback is Codex's runtime workspace directory.

**Data flow**: It copies the test stdio server into the workspace under a relative command path, configures the MCP server without `cwd`, calls the `cwd` tool, and compares the reported directory to the workspace path.

**Call relations**: This Unix-only top-level test uses `call_cwd_tool` and `assert_cwd_tool_output`. It covers the local case only because remote path handling is different.

*Call graph*: calls 4 internal fn (start_mock_server, test_codex, assert_cwd_tool_output, call_cwd_tool); 7 external calls (clone, new, new, from, cargo_bin, wait_for_mcp_server, skip_if_no_network!).


##### `stdio_mcp_tool_call_includes_sandbox_state_meta`  (lines 739–834)

```
async fn stdio_mcp_tool_call_includes_sandbox_state_meta() -> anyhow::Result<()>
```

**Purpose**: Tests that Codex includes sandbox state metadata when calling an MCP tool that asks for it. Sandbox metadata tells the tool what file access rules and working directory apply.

**Data flow**: It scripts the model to call `sandbox_meta`, configures a stdio MCP server, submits a read-only turn, unwraps the tool output sent back to the model, and checks the JSON contains the expected sandbox policy, sandbox cwd, and legacy-landlock flag.

**Call relations**: This top-level test uses `turn_permission_fields` to compute the expected sandbox information and `split_wall_time_wrapped_output` to inspect the model-facing result.

*Call graph*: calls 8 internal fn (mount_sse_once, sse, start_mock_server, test_codex, turn_permission_fields, remote_aware_stdio_server_bin, split_wall_time_wrapped_output, read_only); 9 external calls (assert!, assert_eq!, wait_for_mcp_server, format!, from_str, to_value, skip_if_no_network!, skip_if_wine_exec!, vec!).


##### `stdio_mcp_parallel_tool_calls_default_false_runs_serially`  (lines 837–953)

```
async fn stdio_mcp_parallel_tool_calls_default_false_runs_serially() -> anyhow::Result<()>
```

**Purpose**: Tests that mutable MCP tool calls run one at a time by default. This matters because two changing actions running at once could interfere with each other.

**Data flow**: It scripts the model to request two `sync` tool calls, configures a stdio server without parallel-call opt-in, submits an auto-approved turn, records begin/end events, and verifies one call finishes before the other starts. It also checks both final outputs are correct.

**Call relations**: This top-level test uses `auto_approved_user_turn` so permission prompts do not affect scheduling. It unwraps final outputs with `split_wall_time_wrapped_output`.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, auto_approved_user_turn, remote_aware_stdio_server_bin, split_wall_time_wrapped_output); 14 external calls (new, assert!, assert_eq!, Begin, End, wait_for_event, wait_for_mcp_server, format!, json!, from_str (+4 more)).


##### `stdio_mcp_read_only_tool_calls_run_concurrently_without_server_opt_in`  (lines 956–1056)

```
async fn stdio_mcp_read_only_tool_calls_run_concurrently_without_server_opt_in() -> anyhow::Result<()>
```

**Purpose**: Tests that read-only MCP tool calls may run at the same time even if the server has not opted into parallel mutable calls. Read-only calls are safe to overlap because they should not change shared state.

**Data flow**: It scripts two `sync_readonly` calls with a barrier that only succeeds if both arrive concurrently. It submits a read-only turn and verifies the final outputs from both calls are the expected JSON result.

**Call relations**: This top-level test uses `read_only_user_turn`, the stdio server helper, and `split_wall_time_wrapped_output`. The barrier in the test server acts as proof that calls overlapped.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, read_only_user_turn, remote_aware_stdio_server_bin, split_wall_time_wrapped_output); 9 external calls (assert_eq!, wait_for_event, wait_for_mcp_server, format!, json!, from_str, skip_if_no_network!, skip_if_wine_exec!, vec!).


##### `stdio_mcp_parallel_tool_calls_opt_in_runs_concurrently`  (lines 1059–1148)

```
async fn stdio_mcp_parallel_tool_calls_opt_in_runs_concurrently() -> anyhow::Result<()>
```

**Purpose**: Tests that mutable MCP tool calls can run concurrently when the MCP server explicitly says it supports parallel tool calls.

**Data flow**: It scripts two mutable `sync` calls that require concurrent arrival, configures the MCP server with `supports_parallel_tool_calls: true`, submits an auto-approved turn, and checks both outputs show success.

**Call relations**: This top-level test pairs with the default-serial test. It uses `auto_approved_user_turn` and `split_wall_time_wrapped_output` to isolate the scheduling behavior.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, auto_approved_user_turn, remote_aware_stdio_server_bin, split_wall_time_wrapped_output); 9 external calls (assert_eq!, wait_for_event, wait_for_mcp_server, format!, json!, from_str, skip_if_no_network!, skip_if_wine_exec!, vec!).


##### `stdio_image_responses_round_trip`  (lines 1152–1290)

```
async fn stdio_image_responses_round_trip() -> anyhow::Result<()>
```

**Purpose**: Tests that an MCP tool can return image content and that Codex sends it back to the model in the expected image-input format.

**Data flow**: It passes a PNG data URL to the stdio test server, scripts the model to call the `image` tool, verifies the MCP end event contains image content, then checks the next model request contains a wall-time text item plus an `input_image` item.

**Call relations**: This top-level test uses `assert_wall_time_header` for the timing item and `remote_aware_stdio_server_bin` for local-or-remote server startup.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, assert_wall_time_header, read_only_user_turn, remote_aware_stdio_server_bin); 8 external calls (assert_eq!, wait_for_event, wait_for_mcp_server, format!, skip_if_no_network!, skip_if_wine_exec!, unreachable!, vec!).


##### `stdio_image_responses_resize_large_image`  (lines 1294–1396)

```
async fn stdio_image_responses_resize_large_image() -> anyhow::Result<()>
```

**Purpose**: Tests that large images returned from MCP tools are resized when the resize feature is enabled. This keeps model input within practical size limits.

**Data flow**: It creates a large in-memory PNG, sends it as an MCP tool argument, enables the image-resize feature, submits a turn, extracts the image data sent back to the model, decodes it, and asserts the new dimensions are smaller and expected.

**Call relations**: This top-level test uses the stdio MCP server and fake model streams. It checks the behavior that happens between MCP result collection and the final model request.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, read_only_user_turn, remote_aware_stdio_server_bin, new); 14 external calls (ImageRgba8, from_pixel, new, assert_eq!, wait_for_event, wait_for_mcp_server, format!, Rgba, load_from_memory, json! (+4 more)).


##### `stdio_image_responses_preserve_original_detail_metadata`  (lines 1400–1487)

```
async fn stdio_image_responses_preserve_original_detail_metadata() -> anyhow::Result<()>
```

**Purpose**: Tests that Codex preserves image detail metadata set to `original` when the selected model supports that setting. The detail field affects how the model should treat the image.

**Data flow**: It configures a model that supports original-detail images, scripts an image scenario tool call, waits for the turn to finish, and checks the final model request contains the exact expected data URL and `detail: original`.

**Call relations**: This top-level test uses `assert_wall_time_header` and `read_only_user_turn`. It complements the resize and text-only image tests.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, assert_wall_time_header, read_only_user_turn, remote_aware_stdio_server_bin); 7 external calls (assert_eq!, wait_for_event, wait_for_mcp_server, format!, skip_if_no_network!, skip_if_wine_exec!, vec!).


##### `stdio_image_responses_are_sanitized_for_text_only_model`  (lines 1491–1645)

```
async fn stdio_image_responses_are_sanitized_for_text_only_model() -> anyhow::Result<()>
```

**Purpose**: Tests that image MCP output is replaced with a text notice when the selected model only supports text input. This prevents Codex from sending unsupported image data to the model API.

**Data flow**: It mounts a fake model list containing a text-only model, scripts an MCP image tool call, submits a read-only turn using that model, unwraps the final tool output, and checks the image was replaced by an explanatory text item.

**Call relations**: This top-level test uses `mount_models_once` to control model capabilities and `read_only_user_turn_with_model` to choose the text-only model. It uses `split_wall_time_wrapped_output` to inspect the sanitized payload.

*Call graph*: calls 9 internal fn (mount_models_once, mount_sse_once, sse, start_mock_server, test_codex, read_only_user_turn_with_model, remote_aware_stdio_server_bin, split_wall_time_wrapped_output, create_dummy_chatgpt_auth_for_testing); 8 external calls (assert_eq!, wait_for_event, wait_for_mcp_server, format!, from_str, skip_if_no_network!, skip_if_wine_exec!, vec!).


##### `stdio_server_propagates_whitelisted_env_vars`  (lines 1649–1767)

```
async fn stdio_server_propagates_whitelisted_env_vars() -> anyhow::Result<()>
```

**Purpose**: Tests that a stdio MCP server receives an environment variable when that variable is explicitly whitelisted. Environment variables can contain secrets or settings, so passing them must be deliberate.

**Data flow**: It temporarily sets `MCP_TEST_VALUE` in the test process, configures the MCP server to copy that variable, calls the `echo` tool, and checks the structured result contains the expected environment value.

**Call relations**: This top-level test uses `EnvVarGuard::set` to restore the environment afterward, plus the usual stdio MCP setup helpers.

*Call graph*: calls 7 internal fn (set, mount_sse_once, sse, start_mock_server, test_codex, read_only_user_turn, remote_aware_stdio_server_bin); 10 external calls (new, assert!, assert_eq!, wait_for_event, wait_for_mcp_server, format!, skip_if_no_network!, skip_if_wine_exec!, unreachable!, vec!).


##### `stdio_server_propagates_explicit_local_env_var_source`  (lines 1771–1863)

```
async fn stdio_server_propagates_explicit_local_env_var_source() -> anyhow::Result<()>
```

**Purpose**: Tests that an environment variable marked with source `local` is copied from the local test process into a stdio MCP server. This verifies explicit source selection works.

**Data flow**: It sets a local environment variable, configures the MCP server to copy that named variable from the local source, calls `echo`, and asserts the server saw the value.

**Call relations**: This top-level test uses `EnvVarGuard::set`, `remote_aware_stdio_server_bin`, and `read_only_user_turn`. It is serialized with related environment-source tests.

*Call graph*: calls 7 internal fn (set, mount_sse_once, sse, start_mock_server, test_codex, read_only_user_turn, remote_aware_stdio_server_bin); 9 external calls (new, assert_eq!, wait_for_event, wait_for_mcp_server, format!, skip_if_no_network!, skip_if_wine_exec!, unreachable!, vec!).


##### `remote_stdio_env_var_source_does_not_copy_local_env`  (lines 1867–1961)

```
async fn remote_stdio_env_var_source_does_not_copy_local_env() -> anyhow::Result<()>
```

**Purpose**: Tests that a variable marked with source `remote` is not accidentally copied from the local process during remote MCP runs. This prevents local secrets from leaking into remote execution.

**Data flow**: In non-remote runs it exits early. In remote runs it sets a local variable, configures the MCP server to look for it from the remote source, calls `echo`, and asserts the server receives null rather than the local value.

**Call relations**: This top-level test uses `EnvVarGuard::set` and remote-aware stdio setup. It pairs with the explicit-local-source test to check both sides of the source rule.

*Call graph*: calls 7 internal fn (set, mount_sse_once, sse, start_mock_server, test_codex, read_only_user_turn, remote_aware_stdio_server_bin); 10 external calls (new, assert_eq!, test_environment, wait_for_event, wait_for_mcp_server, format!, skip_if_no_network!, skip_if_wine_exec!, unreachable!, vec!).


##### `RemoteStreamableHttpServer::drop`  (lines 1989–1998)

```
fn drop(&mut self)
```

**Purpose**: Cleans up a remote Streamable HTTP MCP test server when its guard object is dropped. It is a safety net so leftover processes and copied files do not accumulate in the Docker container.

**Data flow**: It receives the object being dropped, calls `kill` to stop the remote process, then removes any recorded copied paths with a Docker shell command. Cleanup is best-effort and ignores command failures.

**Call relations**: The remote HTTP server wrapper owns this cleanup behavior. It calls `RemoteStreamableHttpServer::kill` first, then removes artifacts created by `start_remote_streamable_http_test_server`.

*Call graph*: calls 1 internal fn (kill); 2 external calls (new, format!).


##### `RemoteStreamableHttpServer::kill`  (lines 2003–2007)

```
fn kill(&self)
```

**Purpose**: Stops the remote Streamable HTTP test server process in Docker. It is used both during explicit shutdown and automatic cleanup.

**Data flow**: It reads the container name and process id from the struct and runs `docker exec kill <pid>`. It ignores any error because cleanup should not panic during test teardown.

**Call relations**: `RemoteStreamableHttpServer::drop` calls this, and `StreamableHttpTestServer::shutdown` calls it for remote servers.

*Call graph*: called by 1 (drop); 1 external calls (new).


##### `StreamableHttpTestServer::url`  (lines 2012–2014)

```
fn url(&self) -> &str
```

**Purpose**: Returns the MCP endpoint URL that Codex should use for the Streamable HTTP test server.

**Data flow**: It borrows the server wrapper and returns a string slice pointing at the stored server URL. It does not change the server.

**Call relations**: HTTP round-trip tests call this after starting the server so they can insert the URL into Codex's MCP configuration.


##### `StreamableHttpTestServer::shutdown`  (lines 2017–2038)

```
async fn shutdown(mut self)
```

**Purpose**: Stops a Streamable HTTP MCP test server, whether it is a local child process or a remote Docker process. This makes test cleanup explicit.

**Data flow**: It consumes the server wrapper, checks whether the process is local or remote, kills it if needed, and waits for local process exit. Errors during cleanup are printed rather than returned.

**Call relations**: HTTP round-trip tests call this after verifying behavior. For remote servers it calls `RemoteStreamableHttpServer::kill`; for local servers it uses the Tokio child process handle.

*Call graph*: 1 external calls (eprintln!).


##### `streamable_http_tool_call_round_trip`  (lines 2045–2185)

```
async fn streamable_http_tool_call_round_trip() -> anyhow::Result<()>
```

**Purpose**: Tests the basic Streamable HTTP MCP path: Codex discovers an HTTP MCP server, calls its `echo` tool, and sends the result back through the model flow.

**Data flow**: It scripts fake model responses, starts a placement-aware HTTP MCP server, configures Codex with the server URL, submits a read-only turn, verifies tool begin/end events and structured output, then verifies model requests and shuts the server down.

**Call relations**: This top-level test uses `start_streamable_http_test_server`, `insert_mcp_server`, `read_only_user_turn`, and `StreamableHttpTestServer::shutdown`.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, read_only_user_turn, start_streamable_http_test_server); 8 external calls (assert!, assert_eq!, wait_for_event, wait_for_mcp_server, format!, skip_if_no_network!, unreachable!, vec!).


##### `streamable_http_with_oauth_round_trip`  (lines 2191–2211)

```
fn streamable_http_with_oauth_round_trip() -> anyhow::Result<()>
```

**Purpose**: Runs the OAuth-backed Streamable HTTP MCP test inside a custom thread with a larger stack. This avoids stack-size problems while keeping the test itself asynchronous.

**Data flow**: It starts a new thread, builds a Tokio async runtime inside it, runs `streamable_http_with_oauth_round_trip_impl`, then returns that result to the normal test harness. If the thread panics, it returns an error.

**Call relations**: This is the synchronous test wrapper for the OAuth scenario. It delegates all real setup and assertions to `streamable_http_with_oauth_round_trip_impl`.

*Call graph*: 2 external calls (anyhow!, new).


##### `streamable_http_with_oauth_round_trip_impl`  (lines 2213–2374)

```
async fn streamable_http_with_oauth_round_trip_impl() -> anyhow::Result<()>
```

**Purpose**: Tests that Codex can call a Streamable HTTP MCP server that requires OAuth bearer-token authentication. OAuth is a standard way to prove the client has permission by sending an access token.

**Data flow**: It scripts model responses, starts an HTTP MCP server that expects a token, creates an isolated `CODEX_HOME`, writes fallback OAuth credentials, configures Codex to use file-based credentials, submits a read-only turn, verifies the authenticated tool result, and shuts down the server.

**Call relations**: This async implementation is called by `streamable_http_with_oauth_round_trip`. It uses `start_streamable_http_test_server`, `write_fallback_oauth_tokens`, `EnvVarGuard::set`, and the shared MCP assertion pattern.

*Call graph*: calls 8 internal fn (set, mount_sse_once, sse, start_mock_server, test_codex, read_only_user_turn, start_streamable_http_test_server, write_fallback_oauth_tokens); 10 external calls (new, assert!, assert_eq!, wait_for_event, wait_for_mcp_server, format!, skip_if_no_network!, tempdir, unreachable!, vec!).


##### `start_streamable_http_test_server`  (lines 2377–2423)

```
async fn start_streamable_http_test_server(
    expected_env_value: &str,
    expected_token: Option<&str>,
) -> anyhow::Result<Option<StreamableHttpTestServer>>
```

**Purpose**: Starts the Streamable HTTP MCP helper server in the correct place for the current test environment. It hides the difference between local host execution and remote Docker execution.

**Data flow**: It finds the helper binary, checks whether a Docker container is active, and either starts a remote server or starts a local child process on a free port. It waits until the server is reachable and returns a server wrapper, or `None` if the binary is unavailable.

**Call relations**: The HTTP round-trip tests call this before configuring Codex. It delegates remote startup to `start_remote_streamable_http_test_server` and local readiness checks to `wait_for_local_streamable_http_server`.

*Call graph*: calls 2 internal fn (start_remote_streamable_http_test_server, wait_for_local_streamable_http_server); called by 2 (streamable_http_tool_call_round_trip, streamable_http_with_oauth_round_trip_impl); 8 external calls (from_secs, bind, new, cargo_bin, Local, test_environment, eprintln!, format!).


##### `start_remote_streamable_http_test_server`  (lines 2426–2503)

```
async fn start_remote_streamable_http_test_server(
    container_name: &str,
    rmcp_http_server_bin: &Path,
    expected_env_value: &str,
    expected_token: Option<&str>,
) -> anyhow::Result<Stream
```

**Purpose**: Starts the Streamable HTTP MCP helper server inside the remote Docker test container. This is needed when the MCP client being tested also runs in that remote environment.

**Data flow**: It copies the helper binary into Docker, builds environment-variable assignments, launches the process with `nohup`, reads its process id, waits for the bound address file, finds the container IP, probes readiness through the remote HTTP path, optionally checks OAuth metadata, and returns a cleanup wrapper.

**Call relations**: `start_streamable_http_test_server` calls this for remote runs. It uses `copy_binary_to_remote_env`, `wait_for_remote_bound_addr`, `remote_container_ip`, `wait_for_remote_streamable_http_server`, and sometimes `wait_for_streamable_http_metadata`.

*Call graph*: calls 5 internal fn (copy_binary_to_remote_env, remote_container_ip, wait_for_remote_bound_addr, wait_for_remote_streamable_http_server, wait_for_streamable_http_metadata); called by 1 (start_streamable_http_test_server); 7 external calls (from_secs, new, from_utf8, Remote, ensure!, format!, vec!).


##### `sh_single_quote`  (lines 2506–2508)

```
fn sh_single_quote(value: &str) -> String
```

**Purpose**: Safely wraps a string in single quotes for small shell commands sent through Docker. This prevents embedded single quotes from breaking the shell snippet.

**Data flow**: It receives a string, escapes any single quote characters inside it, wraps the result in single quotes, and returns the quoted string.

**Call relations**: Remote HTTP server startup uses this while building the shell command that sets environment variables and launches the helper process.

*Call graph*: 1 external calls (format!).


##### `wait_for_remote_bound_addr`  (lines 2511–2538)

```
async fn wait_for_remote_bound_addr(
    container_name: &str,
    bound_addr_file: &str,
    timeout: Duration,
) -> anyhow::Result<SocketAddr>
```

**Purpose**: Waits until the remote Streamable HTTP helper server writes the socket address it actually bound to. This is necessary because the server may choose a random free port.

**Data flow**: It receives a container name, file path, and timeout. It repeatedly runs `docker exec cat` on the file, parses the file contents as a socket address when available, and returns that address. If the timeout expires, it returns an error.

**Call relations**: `start_remote_streamable_http_test_server` calls this after launching the remote helper. The returned port is used to build the server URL.

*Call graph*: called by 1 (start_remote_streamable_http_test_server); 6 external calls (from_millis, now, new, from_utf8, anyhow!, sleep).


##### `remote_container_ip`  (lines 2541–2570)

```
fn remote_container_ip(container_name: &str) -> anyhow::Result<String>
```

**Purpose**: Finds the Docker container IP address that the host-side test process can use to reach the remote helper server.

**Data flow**: It runs `docker inspect`, reads the IP address from the output, and returns the first non-empty line. If Docker reports no IP, it falls back to `127.0.0.1`.

**Call relations**: `start_remote_streamable_http_test_server` calls this after learning the remote server's port. The IP and port together become the MCP server URL.

*Call graph*: called by 1 (start_remote_streamable_http_test_server); 3 external calls (new, from_utf8, ensure!).


##### `wait_for_local_streamable_http_server`  (lines 2573–2622)

```
async fn wait_for_local_streamable_http_server(
    server_child: &mut Child,
    server_url: &str,
    timeout: Duration,
) -> anyhow::Result<()>
```

**Purpose**: Waits until a locally started Streamable HTTP MCP server is ready by polling its OAuth metadata endpoint. It also detects if the child process exits too early.

**Data flow**: It receives the child process, server URL, and timeout. It repeatedly checks whether the process is still running and sends HTTP GET requests to the metadata URL until it gets `200 OK` or the deadline expires.

**Call relations**: `start_streamable_http_test_server` calls this after spawning a local helper process. It uses `streamable_http_metadata_url` to know which readiness endpoint to poll.

*Call graph*: calls 1 internal fn (streamable_http_metadata_url); called by 1 (start_streamable_http_test_server); 7 external calls (try_wait, from_millis, now, anyhow!, builder, sleep, timeout).


##### `wait_for_remote_streamable_http_server`  (lines 2625–2674)

```
async fn wait_for_remote_streamable_http_server(
    server_url: &str,
    timeout: Duration,
) -> anyhow::Result<()>
```

**Purpose**: Waits until a remote Streamable HTTP MCP server is reachable from the remote execution environment. This proves the same side that will run the MCP client can contact the server.

**Data flow**: It reads the remote executor websocket URL from the environment, creates a test execution environment, and repeatedly sends HTTP requests through that environment to the metadata URL until it gets `200 OK` or times out.

**Call relations**: `start_remote_streamable_http_test_server` calls this before handing the URL to Codex. It uses `streamable_http_metadata_url` to build the readiness URL.

*Call graph*: calls 2 internal fn (streamable_http_metadata_url, create_for_tests); called by 1 (start_remote_streamable_http_test_server); 6 external calls (from_millis, now, new, anyhow!, var, sleep).


##### `wait_for_streamable_http_metadata`  (lines 2677–2718)

```
async fn wait_for_streamable_http_metadata(
    server_url: &str,
    timeout: Duration,
) -> anyhow::Result<()>
```

**Purpose**: Waits from the host process until the Streamable HTTP server's OAuth metadata endpoint responds successfully. OAuth tests use this to make sure metadata is visible before continuing.

**Data flow**: It receives a server URL and timeout, builds the metadata URL, repeatedly sends local HTTP GET requests, and returns when the response is `200 OK`. If requests fail until the deadline, it returns an error.

**Call relations**: `start_remote_streamable_http_test_server` calls this when bearer-token authentication is enabled. It shares URL construction with other readiness helpers through `streamable_http_metadata_url`.

*Call graph*: calls 1 internal fn (streamable_http_metadata_url); called by 1 (start_remote_streamable_http_test_server); 6 external calls (from_millis, now, anyhow!, builder, sleep, timeout).


##### `streamable_http_metadata_url`  (lines 2721–2724)

```
fn streamable_http_metadata_url(server_url: &str) -> String
```

**Purpose**: Builds the OAuth metadata URL for a Streamable HTTP MCP endpoint. The metadata endpoint is used as a simple readiness check and for OAuth discovery.

**Data flow**: It receives the MCP server URL, removes a trailing `/mcp` if present, appends the fixed metadata path, and returns the resulting URL string.

**Call relations**: The local, remote, and OAuth metadata wait helpers all call this so they probe the same endpoint consistently.

*Call graph*: called by 3 (wait_for_local_streamable_http_server, wait_for_remote_streamable_http_server, wait_for_streamable_http_metadata); 1 external calls (format!).


##### `write_fallback_oauth_tokens`  (lines 2726–2755)

```
fn write_fallback_oauth_tokens(
    home: &Path,
    server_name: &str,
    server_url: &str,
    client_id: &str,
    access_token: &str,
    refresh_token: &str,
) -> anyhow::Result<()>
```

**Purpose**: Writes a small test credentials file containing OAuth tokens for an MCP server. This lets Codex authenticate to the test HTTP server without running a real browser login flow.

**Data flow**: It receives a home directory, server identity, client id, access token, and refresh token. It computes an expiration time one hour in the future, builds a JSON credentials object, writes it to `.credentials.json`, and returns success or an I/O error.

**Call relations**: `streamable_http_with_oauth_round_trip_impl` calls this after creating an isolated test home. Codex later reads the file during the authenticated MCP call.

*Call graph*: called by 1 (streamable_http_with_oauth_round_trip_impl); 6 external calls (from_secs, join, now, write, json!, to_vec).


##### `EnvVarGuard::set`  (lines 2763–2769)

```
fn set(key: &'static str, value: &std::ffi::OsStr) -> Self
```

**Purpose**: Temporarily sets an environment variable for a test and remembers its previous value. This helps tests change process-wide environment safely.

**Data flow**: It receives a static environment variable name and value, reads the original value if any, sets the new value, and returns an `EnvVarGuard` containing the saved original state.

**Call relations**: Environment-variable tests and the OAuth test use this before building fixtures. Its matching cleanup happens automatically in `EnvVarGuard::drop`.

*Call graph*: 2 external calls (set_var, var_os).


##### `EnvVarGuard::drop`  (lines 2773–2780)

```
fn drop(&mut self)
```

**Purpose**: Restores an environment variable when an `EnvVarGuard` goes out of scope. This prevents one test's environment changes from leaking into later tests.

**Data flow**: It reads the saved original value from the guard. If there was an original value, it sets it back; otherwise it removes the variable.

**Call relations**: Rust calls this automatically during test cleanup. It pairs with `EnvVarGuard::set` and is especially important because many tests in this file run in the same process.

*Call graph*: 2 external calls (remove_var, set_var).


### `rmcp-client/tests/resources.rs`

`test` · `test run`

This test proves that the client can talk to an MCP-style server over standard input and output, which means the client and server exchange messages through process pipes instead of a network socket. The real-world question it answers is: “If a server offers resources like notes or documents, can this client discover and read them correctly?”

The test first finds the compiled test server program. Then it builds the startup information the client will send during the protocol handshake. That startup information says who the client is and what it supports, including “elicitation,” which is the server asking the client for extra user-provided information.

The main test launches the server as a child process, creates an RMCP client connected to it, and initializes the protocol with a five-second timeout so the test cannot hang forever. It provides a simple elicitation callback that always accepts with empty JSON content.

After setup, the test asks the server for its resources. It expects to find a memo resource at `memo://codex/example-note` with exact name, title, description, and MIME type. It also checks the resource template list, which describes URI patterns the server can serve. Finally, it reads the memo resource and verifies the returned plain-text content. If any part of discovery or reading is broken, this test fails.

#### Function details

##### `stdio_server_bin`  (lines 26–28)

```
fn stdio_server_bin() -> Result<PathBuf, CargoBinError>
```

**Purpose**: This helper finds the path to the compiled `test_stdio_server` binary. The test uses that path so it can start a real local server process instead of using a fake in-memory stand-in.

**Data flow**: It takes no input from the caller. It asks the shared cargo-binary helper to locate `test_stdio_server`; if the binary is found, it returns its filesystem path, and if not, it returns the lookup error.

**Call relations**: The main test calls this before creating the client. It hands the resulting path to the client startup code so the client knows which server program to launch.

*Call graph*: called by 1 (rmcp_client_can_list_and_read_resources); 1 external calls (cargo_bin).


##### `init_params`  (lines 30–43)

```
fn init_params() -> InitializeRequestParams
```

**Purpose**: This helper builds the initialization message the client sends when it first connects to the server. It describes the test client’s identity and the protocol features it claims to support.

**Data flow**: It starts with default client capabilities, adds support for form-based elicitation, then combines those capabilities with client name/version information and a specific protocol version. The result is an `InitializeRequestParams` value ready to send during the handshake.

**Call relations**: The main test calls this during client initialization. The returned parameters are passed into `client.initialize`, which uses them to begin the RMCP conversation with the test server.

*Call graph*: called by 1 (rmcp_client_can_list_and_read_resources); 3 external calls (default, new, new).


##### `rmcp_client_can_list_and_read_resources`  (lines 46–138)

```
async fn rmcp_client_can_list_and_read_resources() -> anyhow::Result<()>
```

**Purpose**: This is the actual integration test. It checks the full resource workflow: start the server, initialize the client, list resources, list resource templates, and read a resource.

**Data flow**: It begins by locating the test server binary and launching an RMCP client connected to it. It sends initialization details and a simple callback that accepts any elicitation request. Then it asks the server for resource information and compares the answers against exact expected values. Finally, it reads the known memo URI and checks that the returned text matches the expected sample text. If every check passes, it returns success; otherwise the test fails with an error or assertion failure.

**Call relations**: The Rust async test runner calls this test. Inside the test, it uses `stdio_server_bin` to find the server and `init_params` to prepare the startup handshake, then calls the RMCP client methods that exercise resource listing, template listing, and resource reading.

*Call graph*: calls 4 internal fn (new_stdio_client, new, init_params, stdio_server_bin); 7 external calls (new, new, from_secs, new, new, assert_eq!, current_dir).


### Tool definitions and conversion behavior
This group follows tool modeling from core definitions and discovery through MCP and dynamic-tool conversion, code-mode adaptation, Responses API shaping, and schema-policy fixtures.

### `tools/src/tool_definition_tests.rs`

`test` · `test run`

A ToolDefinition is the project’s record of a callable tool: its name, a human description, what input shape it expects, what output shape it promises, and whether its full details should be loaded later. This test file builds one sample tool, then verifies two important transformations on it.

The helper function creates a realistic example called "lookup_order". It has an empty object input schema, an object output schema, and normal loading behavior. Think of it like a sample form used to check that a copy machine is only changing the one field you asked it to change.

The first test checks renaming. When a tool is given a longer routed name such as "mcp__orders__lookup_order", only the name should change. The description, input schema, output schema, and loading setting should stay exactly the same.

The second test checks deferred loading. A deferred tool is a lighter placeholder: it keeps enough information to identify the tool, but drops the output schema and marks itself as needing later loading. This matters because callers may list many tools cheaply before fetching full details. These tests make sure those two transformations stay narrow and predictable.

#### Function details

##### `tool_definition`  (lines 6–20)

```
fn tool_definition() -> ToolDefinition
```

**Purpose**: Creates a standard sample ToolDefinition used by the tests. This gives every test the same starting point, so each test can clearly show what changed and what stayed the same.

**Data flow**: It takes no input. It builds a tool named "lookup_order" with a plain description, an empty object-shaped input schema, an object-shaped output schema, and defer_loading set to false. It returns that complete ToolDefinition for the tests to compare against.

**Call relations**: The test functions call on this helper when they need a known, unchanged tool definition. Inside, it uses the schema-building helper to make the input schema, creates an empty map for schema properties, and uses JSON construction for the output schema.

*Call graph*: calls 1 internal fn (object); 2 external calls (new, json!).


##### `renamed_overrides_name_only`  (lines 23–31)

```
fn renamed_overrides_name_only()
```

**Purpose**: Checks that renaming a ToolDefinition changes only its name. This prevents a simple rename operation from accidentally losing schema information or changing loading behavior.

**Data flow**: It starts with the sample tool definition, asks it to produce a renamed version, and compares the result with an expected ToolDefinition. The expected result has the new name but keeps every other field from the original sample. The test passes only if the actual and expected values are identical.

**Call relations**: During the test run, the Rust test runner executes this function. It depends on the shared sample created by tool_definition, then uses an equality assertion to confirm that the rename operation is limited to the name field.

*Call graph*: 1 external calls (assert_eq!).


##### `into_deferred_drops_output_schema_and_sets_defer_loading`  (lines 34–43)

```
fn into_deferred_drops_output_schema_and_sets_defer_loading()
```

**Purpose**: Checks that turning a ToolDefinition into a deferred version removes its output schema and marks it for later loading. This makes sure the deferred form is a lightweight placeholder rather than a full tool description.

**Data flow**: It starts with the sample tool definition, converts it into its deferred form, and compares that result with the expected version. The expected version has no output schema and has defer_loading set to true, while all other fields remain the same as the original sample.

**Call relations**: During the test run, the Rust test runner executes this function. It uses tool_definition as the baseline example and an equality assertion to verify that the deferred conversion changes exactly the two intended fields.

*Call graph*: 1 external calls (assert_eq!).


### `tools/src/tool_spec_tests.rs`

`test` · `test run`

The project represents different kinds of tools: ordinary function tools, groups of tools under a namespace, web search, image generation, tool search, and freeform tools such as command-like grammars. This test file checks that those tool descriptions behave correctly before they are sent to the Responses API. The main concern is the “wire shape,” meaning the exact JSON structure another service will receive. That matters because even a small change, like a missing name field or a differently spelled type, could make the API reject the request or misunderstand what tools are available.

Each test builds a small example tool, converts it through the same code used by the real system, and compares the result with the exact expected value. The comparisons use JSON examples as a clear contract: this Rust structure must become this JSON object. The file also checks that configuration types for web search, such as allowed domains and approximate user location, are copied into the API-facing types without losing information.

In everyday terms, this file is like checking a shipping label before sending a package: the contents may be right, but the label must use exactly the format the delivery service understands.

#### Function details

##### `tool_spec_name_covers_all_variants`  (lines 21–91)

```
fn tool_spec_name_covers_all_variants()
```

**Purpose**: This test checks that every kind of tool can report the correct public name. Someone would rely on this because tool names are how the rest of the system and the API identify which tool is being described or called.

**Data flow**: It creates one example of each supported tool kind, such as a function tool, namespace, tool search, image generation, web search, and freeform tool. For each example, it asks the tool for its name and compares that answer with the expected string. Nothing is returned; the test passes if all names match and fails if any name is wrong.

**Call relations**: During a test run, Rust’s test runner invokes this function because it is marked as a test. Inside, it uses the external assert_eq! comparison helper to verify each expected name. It does not hand work to other project functions beyond calling the name behavior on the tool values it constructs.

*Call graph*: 1 external calls (assert_eq!).


##### `web_search_config_converts_to_responses_api_types`  (lines 94–119)

```
fn web_search_config_converts_to_responses_api_types()
```

**Purpose**: This test checks that web search settings from the project’s configuration are converted into the API-facing web search types without changing their meaning. This is important because user settings such as allowed domains or location hints must reach the API intact.

**Data flow**: It starts with configuration-style web search filter and location values. It converts each one into the corresponding Responses API type, then compares the converted value with an explicitly written expected value. The test changes no outside state; it either confirms the conversion is faithful or fails.

**Call relations**: The test runner calls this function as part of the automated test suite. The function uses assert_eq! to compare the conversion results with the expected API-shaped values, making it a small contract test for the conversion code.

*Call graph*: 1 external calls (assert_eq!).


##### `create_tools_json_for_responses_api_includes_top_level_name`  (lines 122–150)

```
fn create_tools_json_for_responses_api_includes_top_level_name()
```

**Purpose**: This test checks that when a function tool is turned into JSON for the Responses API, the tool’s name appears at the top level of the JSON object. That name is essential because the API needs it to identify the tool.

**Data flow**: It builds a simple function tool named demo with one string parameter called foo. It sends that tool list into create_tools_json_for_responses_api, which produces JSON values, then compares the output with the exact expected JSON. If serialization fails or the JSON differs, the test fails.

**Call relations**: The test runner invokes this function during tests. This function exercises create_tools_json_for_responses_api and then uses assert_eq! to check the produced JSON against the expected API format.

*Call graph*: 1 external calls (assert_eq!).


##### `namespace_tool_spec_serializes_expected_wire_shape`  (lines 153–195)

```
fn namespace_tool_spec_serializes_expected_wire_shape()
```

**Purpose**: This test checks the JSON format for a namespace tool, which is a named group containing other tools. It protects the exact structure expected by the API when tools are bundled under a namespace.

**Data flow**: It creates a namespace called mcp__demo__ containing one function tool named lookup_order. It serializes that ToolSpec into a JSON value, then compares the result with the expected nested JSON object. The output is only the test result: pass if the JSON matches, fail if it does not.

**Call relations**: Rust’s test runner calls this function during the test phase. The function relies on JSON serialization for ToolSpec, then uses assert_eq! to confirm the namespace and its inner function tool are represented in the expected wire shape.

*Call graph*: 1 external calls (assert_eq!).


##### `web_search_tool_spec_serializes_expected_wire_shape`  (lines 198–233)

```
fn web_search_tool_spec_serializes_expected_wire_shape()
```

**Purpose**: This test checks that a web search tool becomes the exact JSON object the Responses API expects, including access permission, filters, user location, context size, and allowed content types. It matters because web search options are detailed, and losing or renaming one field could change search behavior.

**Data flow**: It builds a web search tool with external access enabled, one allowed domain, an approximate user location, a high search context size, and text plus image content types. It serializes that tool to JSON and compares it with the exact expected JSON. The test produces no application data; it only proves whether the format is correct.

**Call relations**: The test runner executes this function as one of the file’s test cases. The function sends the constructed ToolSpec through serde_json serialization and uses assert_eq! to verify that the resulting JSON matches the API contract.

*Call graph*: 1 external calls (assert_eq!).


##### `tool_search_tool_spec_serializes_expected_wire_shape`  (lines 236–268)

```
fn tool_search_tool_spec_serializes_expected_wire_shape()
```

**Purpose**: This test checks that a tool-search tool is serialized correctly, including how it describes its required query parameter. This matters because tool search is itself exposed as a tool, so its input rules must be clear to the API.

**Data flow**: It creates a tool_search specification with synchronous execution, a description, and a JSON schema requiring a string query field. It serializes that specification to JSON, then compares it with the expected object containing type, execution mode, description, required fields, and additionalProperties set to false. The only result is whether the test passes.

**Call relations**: Rust’s test runner calls this function during automated testing. The function exercises the ToolSpec JSON serialization path and uses assert_eq! to make sure the final JSON keeps the intended tool-search contract.

*Call graph*: 1 external calls (assert_eq!).


### `tools/src/tool_discovery_tests.rs`

`test` · `test run`

This is a small test file for the tool discovery feature. Tool discovery is the part of the system that tells a client, such as a user interface, what extra tools or integrations are available to install or use. Two things are checked here.

First, it verifies the exact JSON names used for tool categories and actions. This matters because JSON is the “wire format”: the shape and wording sent between programs. If Rust code renamed an enum value by accident, another client might suddenly stop understanding messages from the server.

Second, it builds a sample list containing two kinds of discoverable tools: a connector, represented by app information for Google Calendar, and a plugin, represented by plugin information for Slack. It then asks the filtering function what should be sent to the `codex-tui` client. The expected result keeps the connector and removes the plugin. In plain terms, this test is like checking a menu before handing it to a specific customer: some items may exist in the kitchen, but this customer should only see the items their interface supports or is meant to offer.

#### Function details

##### `discoverable_tool_enums_use_expected_wire_names`  (lines 7–18)

```
fn discoverable_tool_enums_use_expected_wire_names()
```

**Purpose**: This test confirms that the tool type and action type turn into the exact JSON words expected by other parts of the system. It prevents accidental changes to names like `connector` and `install`, which clients may rely on.

**Data flow**: The test starts with Rust enum values for a discoverable tool type and action. It converts them into JSON and compares that JSON with a hand-written JSON object containing the expected lowercase strings. Nothing is returned; the test passes if the two JSON values match and fails if they do not.

**Call relations**: During the test suite, this function is run by the Rust test runner. It uses `assert_eq!` to compare the produced JSON against the expected public format, so any mismatch is reported immediately as a test failure.

*Call graph*: 1 external calls (assert_eq!).


##### `filter_request_plugin_install_discoverable_tools_for_codex_tui_omits_plugins`  (lines 21–70)

```
fn filter_request_plugin_install_discoverable_tools_for_codex_tui_omits_plugins()
```

**Purpose**: This test checks that when the client is `codex-tui`, plugin entries are removed from the list of discoverable tools while connector entries remain. It guards client-specific behavior so the text UI receives only the kind of install options it should show.

**Data flow**: The test creates an input list with two items: a Google Calendar connector and a Slack plugin. It passes that list, along with the client name `codex-tui`, into the filtering function. The expected output is a new list containing only the Google Calendar connector. The test compares the actual and expected lists and changes no outside state.

**Call relations**: During the test run, this function exercises `filter_request_plugin_install_discoverable_tools_for_client` with a concrete client name and sample data. It then uses `assert_eq!` to prove that the filtering step removed the plugin before the result would be handed back to that client.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `tools/src/tool_search_tests.rs`

`test` · `test suite`

This is a small safety test for the tool search feature. The system needs to build a plain text search entry for each tool so a user or model can find the right tool by words like its name, description, or parameter meanings. If this text is missing useful details, search may fail. If it repeats the same information, search may become noisy or overweight the wrong words.

The test builds a realistic example by hand. It creates a tool namespace called "codex_app" with a description, then adds one function tool named "automation_update". That tool has its own description and a parameter schema. A schema is a structured description of what inputs the tool accepts; here it includes fields such as "mode" and a nested "schedule" object with a "timezone" field.

The test then asks `ToolSearchInfo::from_tool_spec` to convert that tool definition into search information. Finally, it compares the produced search text against the exact expected sentence. The important point is that the search text includes the namespace, tool name, split-up searchable words from the tool name, tool description, parameter descriptions, and nested parameter descriptions exactly once.

#### Function details

##### `default_search_text_uses_model_visible_namespace_metadata_once`  (lines 6–48)

```
fn default_search_text_uses_model_visible_namespace_metadata_once()
```

**Purpose**: This test proves that the default search text for a namespaced tool is built from the information a model or user is meant to see. It specifically guards against accidentally leaving out descriptions or adding namespace metadata more than once.

**Data flow**: The test starts by creating JSON-style input descriptions: a `schedule` object with a `timezone` field, then a larger parameters object with `mode` and `schedule`. It wraps those parameters inside a tool named `automation_update`, then wraps the tool inside a namespace named `codex_app`. That complete tool specification goes into `ToolSearchInfo::from_tool_spec`, which returns a search entry. The test reads the entry's `search_text` and compares it with the exact expected text; the test passes only if every visible name and description appears in the intended order and amount.

**Call relations**: During the test run, the Rust test framework calls this function. Inside it, helper constructors such as `JsonSchema::object` and `JsonSchema::string` build the fake tool input schema, and the namespace/tool enum variants and vector macro assemble the complete tool specification. The test then hands that specification to `ToolSearchInfo::from_tool_spec`, because that is the production code being checked. Finally, `assert_eq!` acts like a ruler: it verifies that the generated search text matches the expected wording exactly.

*Call graph*: calls 3 internal fn (object, string, from_tool_spec); 4 external calls (from, assert_eq!, Namespace, vec!).


### `tools/src/dynamic_tool_tests.rs`

`test` · `test run`

Dynamic tools arrive as JSON-like descriptions from outside this part of the code. Before the rest of the system can use them, they are parsed into a stricter internal shape called a ToolDefinition. This test file is a safety net for that conversion. Without these tests, a change to the parser could accidentally trust incomplete schema data or drop a setting that affects when a tool is loaded.

The first test builds a pretend tool whose input schema says it has an id field, but does not give that field a full type definition. The expected result is a cleaned, predictable schema: an object with an id property using the default schema. In plain terms, the parser should turn a partial form into something the rest of the program can rely on.

The second test checks a separate detail: defer_loading. This flag tells the system not to load the tool immediately. The test makes sure that if the outside tool description says defer_loading is true, the parsed ToolDefinition still says true. Together, these tests protect both the shape of tool inputs and an important loading behavior.

#### Function details

##### `parse_dynamic_tool_sanitizes_input_schema`  (lines 9–37)

```
fn parse_dynamic_tool_sanitizes_input_schema()
```

**Purpose**: This test checks that a dynamic tool with an incomplete input schema is still parsed into a clean internal schema. It exists to make sure the parser does not pass along vague or half-formed JSON schema data in a way that could confuse later code.

**Data flow**: The test starts with a sample DynamicToolFunctionSpec containing a name, description, a JSON input schema with one id property, and defer_loading set to false. It sends that sample into parse_dynamic_tool, then compares the result with the exact ToolDefinition it expects: same name and description, a sanitized object schema with an id field using the default schema, no output schema, and defer_loading still false. The output is not returned to other code; the test passes if the two values match and fails if they do not.

**Call relations**: During the test run, Rust’s test runner calls this function. Inside it, the json! macro is used to build the sample JSON schema in a readable way, parse_dynamic_tool is exercised as the code under test, and assert_eq! checks that the parsed result matches the expected internal tool definition.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `parse_dynamic_tool_preserves_defer_loading`  (lines 40–65)

```
fn parse_dynamic_tool_preserves_defer_loading()
```

**Purpose**: This test checks that the defer_loading setting survives conversion from an external dynamic tool description into the internal ToolDefinition. This matters because losing that flag could make the system load a tool earlier than intended.

**Data flow**: The test creates a sample DynamicToolFunctionSpec with an object-shaped input schema and defer_loading set to true. It passes that sample to parse_dynamic_tool, then compares the parsed result with an expected ToolDefinition whose schema is an empty object and whose defer_loading value is still true. Nothing is stored permanently; the before-and-after comparison is the whole point of the test.

**Call relations**: During automated testing, the Rust test runner invokes this function. The function uses json! to create the input schema, calls parse_dynamic_tool to perform the conversion being tested, and uses assert_eq! to confirm that the defer-loading instruction was carried through correctly.

*Call graph*: 2 external calls (assert_eq!, json!).


### `tools/src/mcp_tool_tests.rs`

`test` · `test suite`

This is a small test file for the code that reads tools from MCP, the Model Context Protocol, which is a way for outside systems to describe callable tools and their input and output shapes. The project has its own ToolDefinition type, so it needs a reliable translation step from an MCP tool into that internal shape. These tests act like a checklist for that translation.

The helper function builds fake MCP tools with a name, description, and JSON input schema. Each test then feeds one of those fake tools into parse_mcp_tool and compares the result with the exact ToolDefinition that should come out.

The first test checks a forgiving behavior: if an input schema says it is an object but does not list any properties, the parser should treat it as an object with an empty property map rather than failing or leaving the shape unclear. The other two tests focus on output schemas. They confirm that when MCP provides an output schema, the parser wraps it in the standard MCP call-result output shape but preserves the actual schema content inside it, even when the schema has no obvious top-level type, such as an enum. Without these tests, a future code change could silently alter tool schemas, making tools harder or impossible to call correctly.

#### Function details

##### `mcp_tool`  (lines 8–14)

```
fn mcp_tool(name: &str, description: &str, input_schema: serde_json::Value) -> rmcp::model::Tool
```

**Purpose**: This helper builds a simple fake MCP tool for the tests. It saves each test from repeating the same setup code for name, description, and input schema.

**Data flow**: It receives a tool name, a human-readable description, and a JSON value describing the input schema. It turns those into an rmcp Tool object, wrapping the schema in the object type expected by the MCP library, and returns that ready-to-test tool.

**Call relations**: The three test functions call this helper when they need a basic MCP tool. After this helper creates the starting tool, each test either uses it as-is or adds an output schema before passing it to parse_mcp_tool.

*Call graph*: called by 3 (parse_mcp_tool_inserts_empty_properties, parse_mcp_tool_preserves_output_schema_without_inferred_type, parse_mcp_tool_preserves_top_level_output_schema); 3 external calls (new, object, new).


##### `parse_mcp_tool_inserts_empty_properties`  (lines 17–40)

```
fn parse_mcp_tool_inserts_empty_properties()
```

**Purpose**: This test checks that an MCP input schema with only "type": "object" becomes a clear internal object schema with an empty properties map. This matters because callers should not have to guess whether missing properties means an error, an unknown shape, or simply no fields.

**Data flow**: The test creates an MCP tool named "no_props" whose input schema says it is an object but does not define fields. It sends that tool into parse_mcp_tool, then compares the returned ToolDefinition against the expected version: same name and description, an empty object input schema, a standard empty output wrapper, and defer_loading set to false.

**Call relations**: This test starts by using mcp_tool to build the sample tool. It then exercises parse_mcp_tool directly and uses an equality assertion to prove the parser filled in the empty properties in the exact way the rest of the system expects.

*Call graph*: calls 1 internal fn (mcp_tool); 2 external calls (assert_eq!, json!).


##### `parse_mcp_tool_preserves_top_level_output_schema`  (lines 43–87)

```
fn parse_mcp_tool_preserves_top_level_output_schema()
```

**Purpose**: This test makes sure that when an MCP tool declares an output schema, the parser keeps that schema's top-level details instead of simplifying or dropping them. It protects nested output shapes, such as an object containing a required result field.

**Data flow**: The test creates a basic MCP tool, then attaches an output schema with a required "result" field and a nested property under it. It passes the tool to parse_mcp_tool and checks that the produced ToolDefinition contains the same input schema as before and an output schema wrapper whose inner content still includes the original properties and required list.

**Call relations**: The test uses mcp_tool for the common setup, manually adds the output schema using the MCP library's object wrapper, then calls parse_mcp_tool. The final assertion verifies that parse_mcp_tool hands the output schema through mcp_call_tool_result_output_schema without losing the important structure.

*Call graph*: calls 1 internal fn (mcp_tool); 4 external calls (assert_eq!, object, json!, new).


##### `parse_mcp_tool_preserves_output_schema_without_inferred_type`  (lines 90–120)

```
fn parse_mcp_tool_preserves_output_schema_without_inferred_type()
```

**Purpose**: This test checks a subtle case: an output schema can be valid even if it does not say "type" at the top level. In particular, it ensures an enum-only output schema, such as "ok" or "error", is preserved rather than having a guessed type added or being rejected.

**Data flow**: The test builds a basic MCP tool and gives it an output schema that only lists allowed values. It runs parse_mcp_tool, then compares the result to a ToolDefinition whose output schema wrapper still contains that same enum list and no invented top-level type.

**Call relations**: Like the other output-schema test, this one uses mcp_tool to create the starting tool and then adds an MCP output schema before parsing. It focuses on making sure parse_mcp_tool and the output-wrapper helper preserve schemas exactly, even when the schema is less object-like than the common case.

*Call graph*: calls 1 internal fn (mcp_tool); 4 external calls (assert_eq!, object, json!, new).


### `tools/src/code_mode_tests.rs`

`test` · `test run`

Code mode needs to tell the model, in a clear and structured way, what tools it can call. This file is a set of automated tests that protect that behavior. Think of it like checking that a menu has been rewritten into recipe-card form: each tool should still be the same tool, but its description may gain an extra code declaration showing how to call it.

The tests cover two main helpers from the surrounding module. One helper, `augment_tool_spec_for_code_mode`, takes a tool specification and adds a TypeScript-style declaration to the description when that helps code mode understand how to call it. The tests make sure this happens for normal function tools, including their input and output shapes, while also making sure the special built-in execution tool is left untouched.

The other helper, `tool_spec_to_code_mode_tool_definition`, converts a broader tool specification into the smaller tool definition format used by code mode. The tests verify that a freeform tool, such as a patch tool that accepts raw text, becomes a code-mode tool definition with the right name, kind, and generated declaration. They also verify that unsupported tool variants, such as tool search, produce no definition rather than a misleading one.

#### Function details

##### `augment_tool_spec_for_code_mode_augments_function_tools`  (lines 15–66)

```
fn augment_tool_spec_for_code_mode_augments_function_tools()
```

**Purpose**: This test proves that a regular function-style tool gets extra code-mode guidance added to its description. It checks that the original tool details stay the same while the description gains a TypeScript-like call signature showing the expected input and output.

**Data flow**: The test starts with a `lookup_order` tool that takes an `order_id` string and returns an object with an `ok` boolean. It sends that tool into `augment_tool_spec_for_code_mode`. The expected result is the same tool, but with its description extended by an `exec tool declaration` block that shows how code mode should call `lookup_order`.

**Call relations**: During the test run, this function calls the augmentation helper and then uses `assert_eq!` to compare the actual result with the exact expected tool specification. It acts as a safety check for the path where normal function tools are prepared for code mode.

*Call graph*: 1 external calls (assert_eq!).


##### `augment_tool_spec_for_code_mode_preserves_exec_tool_description`  (lines 69–90)

```
fn augment_tool_spec_for_code_mode_preserves_exec_tool_description()
```

**Purpose**: This test makes sure the special public code execution tool is not changed by the augmentation step. That matters because this tool already has its own grammar and meaning, so adding an extra generated declaration could make its instructions confusing or wrong.

**Data flow**: The test builds a freeform tool whose name is the public code-mode execution tool name and whose format describes a small grammar. It passes that tool into `augment_tool_spec_for_code_mode`. The output is expected to be identical to the input, including the original description and grammar definition.

**Call relations**: This test exercises the exception path in the augmentation helper. It uses `assert_eq!` to confirm that the helper recognizes the built-in execution tool and returns it unchanged.

*Call graph*: 1 external calls (assert_eq!).


##### `tool_spec_to_code_mode_tool_definition_returns_augmented_nested_tools`  (lines 93–121)

```
fn tool_spec_to_code_mode_tool_definition_returns_augmented_nested_tools()
```

**Purpose**: This test checks that a freeform tool can be converted into the compact tool definition that code mode uses. It also verifies that the converted description includes a generated declaration showing that the tool accepts raw string input.

**Data flow**: The test creates an `apply_patch` freeform tool with a grammar-based format. It passes a reference to that tool into `tool_spec_to_code_mode_tool_definition`. The expected output is `Some` code-mode tool definition with the same public name, a plain internal tool name, freeform kind, no input or output schema, and a description extended with a callable declaration.

**Call relations**: This test covers the successful conversion path for nested or freeform tools. It constructs the source tool, asks the conversion helper to translate it, and uses `assert_eq!` to ensure the helper produces exactly the code-mode definition that later code-mode execution would rely on.

*Call graph*: 2 external calls (assert_eq!, Freeform).


##### `tool_spec_to_code_mode_tool_definition_skips_unsupported_variants`  (lines 124–137)

```
fn tool_spec_to_code_mode_tool_definition_skips_unsupported_variants()
```

**Purpose**: This test confirms that unsupported tool specification variants are deliberately skipped. Instead of guessing how to expose a tool-search specification in code mode, the conversion helper should return nothing.

**Data flow**: The test builds a `ToolSearch` specification with a description, execution mode, and empty parameter schema. It passes that specification into `tool_spec_to_code_mode_tool_definition`. The expected result is `None`, meaning no code-mode tool definition is produced.

**Call relations**: This test covers the safe fallback path in the conversion helper. It uses `assert_eq!` to make sure unsupported variants do not accidentally become callable code-mode tools.

*Call graph*: 1 external calls (assert_eq!).


### `tools/src/responses_api_tests.rs`

`test` · `test run`

This is a test file for the code that describes tools to the Responses API. A “tool” here means a callable function the model can use, such as `lookup_order` or `create_event`. Some tools can be marked with `defer_loading`, meaning their full details may be loaded later instead of up front. That small flag matters because it changes how the API discovers and presents tools.

The tests cover three kinds of tool sources. First, a normal internal `ToolDefinition` should not include `defer_loading` when the value is simply `false`; leaving it out keeps the serialized request cleaner and matches the expected API format. Second, a dynamic tool definition should preserve `defer_loading: true` when it is converted. Third, an MCP tool, meaning a tool coming from the Model Context Protocol integration, should become a deferred Responses API tool with `defer_loading` set to true.

The last test checks serialization of a namespace, which is like a folder of related tools. It confirms that a namespace containing a deferred child tool becomes the exact JSON object expected by the API. Without these tests, a small conversion or serialization change could silently break tool loading behavior.

#### Function details

##### `tool_definition_to_responses_api_tool_omits_false_defer_loading`  (lines 17–49)

```
fn tool_definition_to_responses_api_tool_omits_false_defer_loading()
```

**Purpose**: This test proves that converting a regular tool definition does not write `defer_loading: false` into the Responses API tool. The absence of that field is intentional and is part of the expected output shape.

**Data flow**: It starts with an internal `ToolDefinition` for a `lookup_order` tool, including a name, description, input schema, output schema, and `defer_loading` set to false. The conversion function turns that into a `ResponsesApiTool`. The test then compares the result with the exact expected tool, where `defer_loading` is `None`, meaning it will be left out rather than serialized as false.

**Call relations**: The test runner calls this function during the test suite. Inside it, the conversion being tested is exercised, and `assert_eq!` is used as the final checkpoint: if the converted tool differs from the expected Responses API version, the test fails.

*Call graph*: 1 external calls (assert_eq!).


##### `dynamic_tool_to_responses_api_tool_preserves_defer_loading`  (lines 52–85)

```
fn dynamic_tool_to_responses_api_tool_preserves_defer_loading()
```

**Purpose**: This test checks that a dynamic tool marked for deferred loading keeps that setting after conversion. It guards against losing an important instruction while translating from a dynamic tool format into the Responses API format.

**Data flow**: It builds a `DynamicToolFunctionSpec` named `lookup_order`, with its input schema written as JSON and `defer_loading` set to true. The conversion function reads that dynamic definition, parses its JSON schema into the project’s `JsonSchema` form, and returns a `ResponsesApiTool`. The expected result has the same name and description, a matching object schema, no output schema, and `defer_loading` set to `Some(true)`.

**Call relations**: The test runner invokes this function as part of the automated checks. The `json!` macro creates the schema input in a compact JSON-like form, the conversion function does the work being verified, and `assert_eq!` confirms the converted tool exactly matches the expected API-facing tool.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `mcp_tool_to_deferred_responses_api_tool_sets_defer_loading`  (lines 88–124)

```
fn mcp_tool_to_deferred_responses_api_tool_sets_defer_loading()
```

**Purpose**: This test makes sure an MCP tool is converted into a Responses API tool that is explicitly deferred. MCP tools come from an outside tool protocol, so this test protects the bridge between that protocol and the Responses API.

**Data flow**: It creates an MCP tool named `lookup_order` with a description and a JSON input schema. It also supplies a namespaced tool name, which is like a full address showing where the tool came from. The conversion function turns that MCP tool into a `ResponsesApiTool`, using the short tool name, preserving the description and schema, and setting `defer_loading` to `Some(true)`. The output is compared against the expected tool structure.

**Call relations**: The test runner calls this test during the suite. The test uses JSON-building helpers and MCP constructors to make a realistic source tool, then passes it into the deferred MCP conversion function. `assert_eq!` acts as the guardrail, failing the test if the bridge produces a tool with the wrong name, schema, or deferred-loading setting.

*Call graph*: 5 external calls (assert_eq!, json!, new, object, new).


##### `loadable_tool_spec_namespace_serializes_with_deferred_child_tools`  (lines 127–168)

```
fn loadable_tool_spec_namespace_serializes_with_deferred_child_tools()
```

**Purpose**: This test checks the final JSON produced for a namespace that contains a deferred child tool. It matters because the Responses API receives serialized JSON, not Rust data structures.

**Data flow**: It builds a `LoadableToolSpec::Namespace`, which contains a namespace name, a description, and one child function tool called `create_event`. That child tool has `defer_loading` set to true and an empty object schema. The test serializes the namespace into a JSON value, then compares it with the exact JSON expected by the API, including the namespace type, child function type, and `defer_loading: true` on the child tool.

**Call relations**: The test runner invokes this function with the other tests. The function assembles the namespace and its tool, uses `serde_json::to_value` to turn the Rust structure into JSON, and then uses `assert_eq!` to verify that the serialized form is exactly what downstream API code expects to send.

*Call graph*: 4 external calls (assert_eq!, to_value, Namespace, vec!).


### `tools/tests/json_schema_policy_fixtures.rs`

`test` · `test run`

This is a test file. Its job is to protect the code that turns MCP tools into Responses API tools. An MCP tool is a tool described in the Model Context Protocol, and the Responses API expects a slightly different shape. The risky part is the JSON Schema for each tool’s inputs: these schemas can contain references, descriptions, definitions, or fields that are valid in one place but unwanted or too large in another.

The file reads fixture JSON files that describe real-looking tools from services like Slack, Google Calendar, Google Drive, Notion, and Outlook email. For each tool, it converts the tool definition and then checks the result. It confirms that the tool name and description survive, that the output remains a non-strict tool, and that the parameters still look like an object with properties. It also checks exact JSON locations that should be preserved, pruned, or dropped.

There is also a special test for an oversized Notion schema. That test proves that compaction happens when a schema is too large: descriptions and root definitions are removed, while important top-level argument shapes remain. In plain terms, this file is like a customs inspection checklist: it makes sure schemas leave with the right baggage and without dangerous or oversized extras.

#### Function details

##### `json_schema_policy_fixtures_convert_to_responses_tools`  (lines 48–119)

```
fn json_schema_policy_fixtures_convert_to_responses_tools()
```

**Purpose**: This test checks normal fixture schemas from several services and verifies that converting them to Responses API tools keeps the required information while removing unwanted schema parts. It exists to catch regressions where schema conversion accidentally changes names, descriptions, parameter shape, or expected JSON details.

**Data flow**: It starts with the fixture file paths, loads each fixture into structured test data, and loops over every tool inside. For each tool, it asks `convert_fixture_tool` to produce a Responses API tool, turns that tool’s parameters back into plain JSON, and compares important fields against expected values from the fixture. The output is not a returned value; the result is success if every assertion passes, or a test failure that explains what changed.

**Call relations**: This is one of the main test entry points in the file. During the test run, it calls `convert_fixture_tool` for each fixture tool, then uses JSON conversion and assertions to inspect the result. It relies on the fixture expectations to tell it which schema paths should still exist, which unreachable definitions should be gone, and which fields should disappear after conversion.

*Call graph*: calls 1 internal fn (convert_fixture_tool); 4 external calls (assert!, assert_eq!, json!, to_value).


##### `json_schema_policy_oversized_golden_schema_triggers_compaction`  (lines 122–184)

```
fn json_schema_policy_oversized_golden_schema_triggers_compaction()
```

**Purpose**: This test checks the special case where a tool schema is too large and must be made smaller. It verifies that the compaction process actually reduces the schema size and removes bulky parts without destroying the important input shape.

**Data flow**: It loads one oversized fixture, takes its first tool, and measures the compact JSON byte length of the original input schema. It converts the tool, serializes the converted parameters to JSON, and measures the new byte length. Then it checks that the output is smaller, that descriptions and root definitions are absent, and that key input properties still have the expected simplified shapes.

**Call relations**: This test calls `load_fixture` to read the oversized schema fixture, `compact_json_len` to measure before-and-after size, and `convert_fixture_tool` to run the same conversion path used by the broader fixture test. It then uses assertions to prove that compaction happened in the intended order: references are rewritten before root definitions are dropped.

*Call graph*: calls 3 internal fn (compact_json_len, convert_fixture_tool, load_fixture); 4 external calls (assert!, assert_eq!, json!, to_value).


##### `load_fixture`  (lines 186–190)

```
fn load_fixture(path: &str) -> T
```

**Purpose**: This helper reads a fixture JSON file from the project’s test resources and turns it into a Rust data structure chosen by the caller. It keeps the tests focused on schema behavior instead of file-reading details.

**Data flow**: It receives a fixture path as text. It resolves that path as a project resource, reads the file contents from disk, and parses the JSON into the requested type. It returns the parsed fixture data, or stops the test with a clear failure message if the path, file read, or JSON format is wrong.

**Call relations**: The oversized-schema test calls this helper when it needs to load its golden fixture. The broader fixture test also uses the same loading idea while iterating over fixture paths. `load_fixture` hands clean, typed fixture data back to the tests so they can move on to conversion and checking.

*Call graph*: called by 1 (json_schema_policy_oversized_golden_schema_triggers_compaction); 3 external calls (find_resource!, read_to_string, from_str).


##### `convert_fixture_tool`  (lines 192–210)

```
fn convert_fixture_tool(
    fixture: &FixtureFile,
    fixture_tool: &FixtureTool,
) -> codex_tools::ResponsesApiTool
```

**Purpose**: This helper turns one fixture tool into the Responses API tool format being tested. It builds the same kind of MCP tool object the production converter expects, then runs the real conversion function.

**Data flow**: It receives the fixture file data and one tool from that fixture. It pulls out the tool name, description, and input schema, checks that the input schema is a JSON object, wraps that schema in an MCP tool, and creates a namespaced tool name using the fixture source. It returns the converted `ResponsesApiTool`, or fails the test if conversion unexpectedly does not work.

**Call relations**: Both main tests call this helper before making assertions about the converted schema. Inside, it hands the constructed tool to `mcp_tool_to_responses_api_tool`, which is the production path under test. This makes the tests realistic: they are not testing a fake shortcut, but the same conversion code used elsewhere.

*Call graph*: calls 1 internal fn (namespaced); called by 2 (json_schema_policy_fixtures_convert_to_responses_tools, json_schema_policy_oversized_golden_schema_triggers_compaction); 3 external calls (new, mcp_tool_to_responses_api_tool, new).


##### `compact_json_len`  (lines 212–216)

```
fn compact_json_len(value: &Value) -> usize
```

**Purpose**: This helper measures how many bytes a JSON value takes when written in compact form, with no extra spacing. It is used to prove that schema compaction really makes an oversized schema smaller.

**Data flow**: It receives a JSON value, serializes it into compact JSON bytes, and returns the number of bytes. If serialization fails, the test stops, because the value should always be valid JSON at this point.

**Call relations**: The oversized-schema test calls this helper before and after conversion. Those two measurements let the test compare original schema size against converted schema size and confirm that compaction reduced the payload.

*Call graph*: called by 1 (json_schema_policy_oversized_golden_schema_triggers_compaction); 1 external calls (to_vec).


### End-to-end command application
This final group contains the repository-level end-to-end test for applying task-generated diffs into Git working trees.

### `chatgpt/tests/suite/apply_command_e2e.rs`

`test` · `test run`

This is an end-to-end test file, meaning it exercises the feature in a way that is close to real use instead of testing one tiny piece in isolation. The feature under test reads a task response, finds a patch or diff inside it, and applies that diff to a working Git repository.

To make the tests safe and repeatable, the file first creates a brand-new temporary Git repository. Think of this as setting up a disposable sandbox: the test can create files, commit them, and even cause conflicts without touching the developer’s real project. It also loads a fixture file, which is a saved example response from the task system, so the test always uses the same input.

The first test checks the happy path. It applies the fixture’s diff and confirms that a new `scripts/fibonacci.js` file appears with the expected JavaScript function, command-line shebang, export statement, and line count.

The second test sets up a deliberate collision by adding a different `fibonacci.js` first. Then it applies the same task diff and expects failure. It verifies that Git-style conflict markers are left in the file, proving the system surfaces merge conflicts instead of silently overwriting work.

#### Function details

##### `create_temp_git_repo`  (lines 8–68)

```
async fn create_temp_git_repo() -> anyhow::Result<TempDir>
```

**Purpose**: This helper builds a fresh temporary Git repository for each test. It gives the apply-command code a realistic place to work while keeping the test isolated from the user’s real files.

**Data flow**: It starts with no input other than the machine’s temporary-file area. It creates a new temporary directory, runs Git commands inside it to initialize a repository, sets a test user name and email, writes a simple `README.md`, adds it, and commits it. If Git setup or the first commit fails, it returns an error with the Git message; otherwise it returns the temporary directory, which stays alive for the duration of the test.

**Call relations**: Both test functions call this first, because they need a clean repository before applying any diff. It relies on external filesystem and Git operations to create the sandbox that the later `apply_diff_from_task` call will modify.

*Call graph*: called by 2 (test_apply_command_creates_fibonacci_file, test_apply_command_with_merge_conflicts); 5 external calls (new, bail!, new, write, vec!).


##### `mock_get_task_with_fixture`  (lines 70–75)

```
async fn mock_get_task_with_fixture() -> anyhow::Result<GetTaskResponse>
```

**Purpose**: This helper loads a saved task response from a JSON fixture file. It replaces a live service call with a known, repeatable example so the tests are stable.

**Data flow**: It finds the fixture file named `tests/task_turn_fixture.json`, reads it as text, and converts the JSON text into a `GetTaskResponse` value. The result is the same kind of object the application would normally receive from the task system, ready to be passed into the diff-application code.

**Call relations**: Both tests call this after creating their repository. The loaded response is handed directly to `apply_diff_from_task`, which uses it as the source of the proposed file changes.

*Call graph*: called by 2 (test_apply_command_creates_fibonacci_file, test_apply_command_with_merge_conflicts); 3 external calls (find_resource!, from_str, read_to_string).


##### `test_apply_command_creates_fibonacci_file`  (lines 78–117)

```
async fn test_apply_command_creates_fibonacci_file()
```

**Purpose**: This test proves that applying the fixture task to a clean repository creates the expected Fibonacci JavaScript file. It is the success-case check for the apply-command feature.

**Data flow**: It creates a temporary Git repository, loads the saved task response, and passes both to `apply_diff_from_task`. After that function runs, the test looks for `scripts/fibonacci.js`, reads its contents, and checks for key expected text: the Fibonacci function, the Node.js shebang line, the export statement, and the exact expected number of lines.

**Call relations**: This test ties the helper setup functions to the real feature function, `apply_diff_from_task`. The helpers provide the repository and task data; `apply_diff_from_task` performs the change; the assertions confirm that the visible file output matches what the fixture promised.

*Call graph*: calls 3 internal fn (apply_diff_from_task, create_temp_git_repo, mock_get_task_with_fixture); 3 external calls (assert!, assert_eq!, read_to_string).


##### `test_apply_command_with_merge_conflicts`  (lines 120–188)

```
async fn test_apply_command_with_merge_conflicts()
```

**Purpose**: This test proves that the apply-command feature does not quietly overwrite an existing, conflicting file. Instead, it should fail and leave merge conflict markers that show where the competing changes collided.

**Data flow**: It creates a temporary Git repository, then manually adds and commits a different version of `scripts/fibonacci.js`. It briefly changes the process’s current working directory to that repository, using a small guard object to restore the old directory afterward. Then it loads the same task fixture and asks `apply_diff_from_task` to apply it. The expected result is an error. Finally, it reads the file and checks that it contains Git conflict marker text such as `<<<<<<<`, `=======`, or `>>>>>>>`.

**Call relations**: Like the success test, this one uses `create_temp_git_repo` and `mock_get_task_with_fixture` before calling `apply_diff_from_task`. The difference is that it prepares a conflicting committed file first, so the feature is tested under a failure condition. Its final assertions confirm that the failure is visible and inspectable rather than hidden.

*Call graph*: calls 3 internal fn (apply_diff_from_task, create_temp_git_repo, mock_get_task_with_fixture); 7 external calls (assert!, new, current_dir, set_current_dir, create_dir_all, read_to_string, write).
