# Plugins, extensions, skills, MCP, and tools tests  `stage-23.6.3`

This stage is the safety net for the system’s “add-on” world: plugins, extensions, skills, MCP servers, and tool descriptions. It sits mostly in shared behind-the-scenes support, checking that extra features can be found, loaded, described, and used correctly before the main app relies on them.

A big group of tests covers plugins. Some build fake plugin folders and config files, then check discovery, loading, version picking, marketplace listings, remote recommendations, startup syncing, sharing, and manager behavior. Together they make sure plugins are read from the right place, bad inputs are rejected clearly, and plugin data turns into usable apps, hooks, skills, and MCP servers.

Another group covers skills, which are reusable abilities. These tests check how skills are found on disk, enabled or disabled, mentioned by name, and even inferred from shell commands.

Extension tests focus on the extension API, registry, stored state, and concrete extensions like goals, image generation, memories, and skills. MCP tests verify server config, catalog conflict rules, connection handling, client transports, and hosted or plugin-provided servers.

Finally, tool tests make sure tool definitions, schema conversion, naming, serialization, and API-facing formats stay predictable.

## Files in this stage

### Plugin test foundations
These files establish shared fixtures and validate the low-level plugin loading, storage, provider, and marketplace primitives that higher-level plugin flows build on.

### `core-plugins/src/test_support.rs`

`test` · `test setup and fixture loading`

This file is a compact test-support module for plugin-related integration tests. Its first responsibility is synthesizing a realistic plugin directory tree under a temporary root: each curated plugin gets a `.codex-plugin/plugin.json` metadata file, a sample skill markdown file, an `.mcp.json` declaring one HTTP MCP server, and an `.app.json` declaring one app connector. Marketplace helpers then assemble `.agents/plugins/marketplace.json` or `.agents/plugins/api_marketplace.json` manifests that point at those local plugin directories using `source: local` entries. The API marketplace variant optionally injects an `interface.displayName`, which mirrors production manifest shape closely enough for tests that distinguish marketplace flavors.

The second responsibility is config setup. `load_plugins_config` converts `codex_home` and `cwd` into `AbsolutePathBuf`, invokes the real layered config loader against `LOCAL_FS`, disables managed-config behavior via `LoaderOverrides::without_managed_config_for_tests`, and derives feature flags from the resulting effective TOML config. Missing feature keys intentionally fall back to explicit defaults: `plugins` defaults on, `remote_plugin` defaults off. The module also exposes fixed SHA/cache-version constants and a helper to write `.tmp/plugins.sha`, letting tests simulate curated-plugin cache state and refresh behavior without mocking internals. Most helpers panic on invalid paths or I/O failure, which is appropriate for deterministic test fixture construction.

#### Function details

##### `write_file`  (lines 17–20)

```
fn write_file(path: &Path, contents: &str)
```

**Purpose**: Creates parent directories for a target file and writes the provided string contents to disk. It is the low-level primitive all other fixture writers use so tests can materialize nested plugin and marketplace files in one call.

**Data flow**: Takes a `&Path` and `&str`. It reads the path's parent directory via `parent()`, creates that directory tree with `fs::create_dir_all`, then writes `contents` with `fs::write`. It returns `()` and mutates the filesystem at the target path; missing parents or I/O errors cause panics through `expect`/`unwrap`.

**Call relations**: This function is not a top-level scenario entry itself; it is invoked by `write_curated_plugin`, `write_curated_marketplace`, and `write_curated_plugin_sha_with` whenever those higher-level helpers need to emit a concrete file. Its role in the call flow is to centralize the directory-creation-before-write invariant.

*Call graph*: called by 3 (write_curated_marketplace, write_curated_plugin, write_curated_plugin_sha_with); 3 external calls (parent, create_dir_all, write).


##### `write_curated_plugin`  (lines 22–58)

```
fn write_curated_plugin(root: &Path, plugin_name: &str)
```

**Purpose**: Builds a complete local curated-plugin fixture under `root/plugins/<plugin_name>`. It writes the minimal set of files needed for tests to observe plugin metadata, one skill, one MCP server declaration, and one app connector declaration.

**Data flow**: Takes a root directory and plugin name. It derives `plugin_root = root/plugins/<plugin_name>` and formats JSON/markdown strings embedding `plugin_name` into `plugin.json`. It then writes four files beneath that root: `.codex-plugin/plugin.json`, `skills/SKILL.md`, `.mcp.json`, and `.app.json`. It returns `()` and populates the filesystem with a deterministic plugin layout.

**Call relations**: It is called from `write_curated_marketplace` after the marketplace manifest has been assembled, ensuring every manifest entry points to an actual local plugin tree. It delegates all file emission to `write_file`, using that helper repeatedly for each artifact in the plugin fixture.

*Call graph*: calls 1 internal fn (write_file); called by 1 (write_curated_marketplace); 2 external calls (join, format!).


##### `write_openai_curated_marketplace`  (lines 60–68)

```
fn write_openai_curated_marketplace(root: &Path, plugin_names: &[&str])
```

**Purpose**: Writes the standard curated marketplace manifest using the OpenAI curated marketplace name and the default marketplace manifest filename. It is a convenience wrapper for tests that need the non-API curated marketplace shape.

**Data flow**: Takes a root directory and a slice of plugin names. It passes `marketplace.json`, `OPENAI_CURATED_MARKETPLACE_NAME`, no display name, and the plugin list into `write_curated_marketplace`. It returns `()` after that helper has written the manifest and plugin fixtures.

**Call relations**: This function exists purely as a specialized entry into `write_curated_marketplace`. In call flow terms it selects the correct constants for the standard curated marketplace variant and leaves all manifest/plugin generation to the shared helper.

*Call graph*: calls 1 internal fn (write_curated_marketplace).


##### `write_openai_api_curated_marketplace`  (lines 70–78)

```
fn write_openai_api_curated_marketplace(root: &Path, plugin_names: &[&str])
```

**Purpose**: Writes the API curated marketplace manifest using the API-specific marketplace name, filename, and display name. Tests use it when they need the API curated fallback/install path rather than the standard curated marketplace path.

**Data flow**: Takes a root directory and plugin names, then forwards `api_marketplace.json`, `OPENAI_API_CURATED_MARKETPLACE_NAME`, `Some("OpenAI Curated")`, and the plugin list to `write_curated_marketplace`. It returns `()` after the shared helper has created the manifest and backing plugin directories.

**Call relations**: It is called by tests such as `returns_api_curated_fallback_plugins_for_direct_provider_auth` and `refresh_curated_plugin_cache_reinstalls_missing_api_curated_plugin` to seed API-curated fixtures. Like the non-API wrapper, it delegates all substantive work to `write_curated_marketplace`.

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

**Purpose**: Constructs a curated marketplace manifest file and the corresponding local plugin directories it references. It is the shared implementation behind both curated marketplace wrapper functions.

**Data flow**: Inputs are the root path, manifest filename, marketplace name, optional display name, and plugin-name slice. It maps each plugin name into a JSON object with a local `./plugins/<plugin_name>` source path, joins those snippets into the `plugins` array, conditionally formats an `interface.displayName` block when `display_name` is present, and writes the final JSON to `root/.agents/plugins/<manifest_name>`. After writing the manifest, it iterates over `plugin_names` and calls `write_curated_plugin` for each one. It returns `()` and mutates the filesystem by creating both the manifest and all referenced plugin trees.

**Call relations**: This is the central fixture-construction routine called by `write_openai_curated_marketplace` and `write_openai_api_curated_marketplace`. Within its own flow, it first delegates manifest persistence to `write_file`, then delegates per-plugin directory creation to `write_curated_plugin` so the manifest never points at nonexistent local sources.

*Call graph*: calls 2 internal fn (write_curated_plugin, write_file); called by 2 (write_openai_api_curated_marketplace, write_openai_curated_marketplace); 2 external calls (join, format!).


##### `write_curated_plugin_sha_with`  (lines 128–130)

```
fn write_curated_plugin_sha_with(codex_home: &Path, sha: &str)
```

**Purpose**: Seeds the curated-plugin SHA marker file under the Codex home directory with a caller-provided SHA string. Tests use it to simulate an existing plugin cache/version state.

**Data flow**: Takes `codex_home` and a SHA string. It formats the SHA with a trailing newline and writes it to `codex_home/.tmp/plugins.sha` via `write_file`. It returns `()` and updates that single filesystem location.

**Call relations**: This helper stands alone in the fixture setup flow rather than being part of marketplace generation. It relies on `write_file` for the actual disk write so it inherits the same parent-directory creation behavior.

*Call graph*: calls 1 internal fn (write_file); 2 external calls (join, format!).


##### `load_plugins_config`  (lines 132–156)

```
async fn load_plugins_config(codex_home: &Path, cwd: &Path) -> PluginsConfigInput
```

**Purpose**: Loads the real layered configuration for tests and converts it into a `PluginsConfigInput` with plugin-related feature flags resolved. It gives tests a production-shaped config object without requiring managed config or thread-specific loaders.

**Data flow**: It accepts `codex_home` and `cwd` as `&Path`, converts both to `AbsolutePathBuf` with `try_from`, and passes `LOCAL_FS`, the absolute codex-home path, `Some(cwd)`, an empty extra-layer slice, `LoaderOverrides::without_managed_config_for_tests()`, and `NoopThreadConfigLoader` into `load_config_layers_state`. After awaiting the result and unwrapping success, it reads `effective_config()` from the returned layer stack, computes `plugins` and `remote_plugin` booleans via `feature_enabled`, and constructs `PluginsConfigInput::new(...)` with those flags plus the fixed backend URL `https://chatgpt.com/backend-api/`. It returns that `PluginsConfigInput` value.

**Call relations**: This async helper is a higher-level test entrypoint for config-dependent plugin scenarios. It delegates config assembly to the real loader stack, then delegates feature-flag extraction to `feature_enabled` before finally packaging everything into `PluginsConfigInput::new`.

*Call graph*: calls 5 internal fn (load_config_layers_state, without_managed_config_for_tests, new, feature_enabled, try_from); 1 external calls (as_path).


##### `feature_enabled`  (lines 158–165)

```
fn feature_enabled(config: &Value, key: &str, default_enabled: bool) -> bool
```

**Purpose**: Extracts a boolean feature flag from the effective TOML config, falling back to a caller-specified default when the feature table or key is absent or not boolean. It encapsulates the exact lookup path used by plugin config tests.

**Data flow**: It takes a `toml::Value` config tree, a feature key string, and a default boolean. It traverses `config["features"][key]`, requiring the `features` node to be a table and the target value to be a boolean; otherwise it uses `default_enabled`. It returns the resolved `bool` and does not mutate any state.

**Call relations**: This function is only called by `load_plugins_config` while deriving the `plugins` and `remote_plugin` flags from the effective config. Its role is to keep the config-loading flow concise and to make the defaulting behavior explicit and reusable within that path.

*Call graph*: called by 1 (load_plugins_config); 1 external calls (get).


### `plugin/src/provider_tests.rs`

`test` · `test execution`

This test module exercises `ResolvedPlugin::from_environment` end to end with realistic manifest shapes. The helper `absolute` converts test paths into validated `AbsolutePathBuf` values, and `resource` constructs the expected `PluginResourceLocator::Environment` wrappers used in assertions.

The first test, `environment_descriptor_binds_every_manifest_resource`, builds a plugin root under the current working directory and populates a `PluginManifest<AbsolutePathBuf>` with resources across all supported locations: top-level component paths (`skills`, `mcp_servers`, `apps`), hook paths via `PluginManifestHooks::Paths`, and interface assets (`composer_icon`, `logo`, `screenshots`). After calling `ResolvedPlugin::from_environment`, it asserts both that the manifest file path itself was rebound to the environment locator and that every resource-bearing field inside the manifest was rewritten consistently, while non-resource metadata remained unchanged. The test uses `PluginManifestInterface::default()` to avoid manually filling unrelated optional fields.

The second test, `environment_descriptor_rejects_resources_outside_package_root`, constructs a manifest whose MCP server path points outside the plugin root. It verifies that construction fails with the exact `ResolvedPluginError::ResourceOutsideRoot { root, path }`, confirming that package-boundary checks apply to manifest-declared resources and not just the manifest file path.

#### Function details

##### `absolute`  (lines 11–13)

```
fn absolute(path: impl AsRef<std::path::Path>) -> AbsolutePathBuf
```

**Purpose**: Converts a test path into a validated absolute-path wrapper. It keeps test setup concise while ensuring the production absolute-path type is used in fixtures.

**Data flow**: It accepts any `AsRef<Path>`, borrows it with `as_ref`, passes it to `AbsolutePathBuf::from_absolute_path_checked`, and returns the resulting `AbsolutePathBuf` or panics if the path is not absolute.

**Call relations**: Both tests call this helper to build roots and resource paths before invoking `ResolvedPlugin::from_environment`.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); called by 2 (environment_descriptor_binds_every_manifest_resource, environment_descriptor_rejects_resources_outside_package_root); 1 external calls (as_ref).


##### `resource`  (lines 15–20)

```
fn resource(environment_id: &str, path: AbsolutePathBuf) -> PluginResourceLocator
```

**Purpose**: Builds the expected environment-scoped resource locator used in assertions. It mirrors the shape produced by the provider code without repeating enum construction inline.

**Data flow**: It takes an `environment_id` string slice and an owned `AbsolutePathBuf`, allocates `environment_id.to_string()`, wraps both in `PluginResourceLocator::Environment`, and returns that locator.

**Call relations**: The successful-binding test uses this helper repeatedly to express the expected manifest path and expected rebound manifest resources.


##### `environment_descriptor_binds_every_manifest_resource`  (lines 23–89)

```
fn environment_descriptor_binds_every_manifest_resource()
```

**Purpose**: Verifies that `ResolvedPlugin::from_environment` rewrites every manifest resource field into an environment-owned locator when all paths stay under the package root. It covers top-level paths, hook path lists, and interface asset fields in one scenario.

**Data flow**: It derives a root from the current directory, constructs absolute child paths for the manifest and all declared resources, builds a `PluginManifest<AbsolutePathBuf>` containing those paths, calls `ResolvedPlugin::from_environment`, and asserts equality on both `plugin.manifest_path()` and `plugin.manifest()` against fully rebound expected values built with `resource`.

**Call relations**: This test drives the main happy path through `ResolvedPlugin::from_environment`, indirectly exercising `PluginManifest::try_map_resources` and the environment containment checks for every supported resource-bearing field.

*Call graph*: calls 3 internal fn (default, from_environment, absolute); 5 external calls (new, assert_eq!, Paths, current_dir, vec!).


##### `environment_descriptor_rejects_resources_outside_package_root`  (lines 92–126)

```
fn environment_descriptor_rejects_resources_outside_package_root()
```

**Purpose**: Verifies that resolved-plugin construction fails when any manifest-declared resource escapes the package root. It specifically checks the exact error payload returned for an out-of-root MCP server path.

**Data flow**: It computes a plugin root and an external path under the current directory, builds a manifest whose `mcp_servers` field points to that external path, calls `ResolvedPlugin::from_environment`, captures the expected error with `expect_err`, and asserts equality against `ResolvedPluginError::ResourceOutsideRoot { root, path: outside }`.

**Call relations**: This test exercises the failure branch of `ResolvedPlugin::from_environment` and confirms that `environment_resource` is applied to manifest contents, not just to the manifest file itself.

*Call graph*: calls 2 internal fn (from_environment, absolute); 3 external calls (new, assert_eq!, current_dir).


### `core-plugins/src/provider_tests.rs`

`test` · `test execution`

This test module builds a minimal fake `ExecutorFileSystem` named `SyntheticPluginFileSystem` that only supports the operations used during plugin resolution: metadata lookup and file reads. Every supported call records a `FileSystemCall` into a mutex-protected vector so tests can assert the exact access pattern. All other filesystem trait methods return `Unsupported`, making it obvious if resolution starts depending on unexpected operations. The synthetic filesystem exposes a single plugin root and manifest path and returns fixed `MANIFEST_CONTENTS` bytes for that manifest.

Two small helpers simplify setup: `write_manifest` writes a manifest file under a chosen relative path in a temp plugin root, and `selected_root` constructs a `SelectedCapabilityRoot` with `CapabilityRootLocation::Environment`. The async tests then cover several important behaviors. One test calls `resolve_plugin_root` directly with the synthetic filesystem and asserts both the resulting `ResolvedPlugin::from_environment` value and the exact metadata/read call sequence. Others instantiate `ExecutorPluginProvider` with test `EnvironmentManager` variants to verify that a plain directory without a manifest resolves to `None`, a missing environment does not fall back to the host filesystem even if files exist locally, a malformed preferred manifest path fails immediately instead of trying alternate manifest locations, and executor paths must already be absolute rather than shell-like `~/...` strings.

#### Function details

##### `SyntheticPluginFileSystem::unsupported`  (lines 57–62)

```
fn unsupported() -> FileSystemResult<T>
```

**Purpose**: Produces a standardized `Unsupported` filesystem error for trait methods not used by plugin resolution. It keeps the fake filesystem intentionally narrow.

**Data flow**: Creates and returns `Err(io::Error::new(io::ErrorKind::Unsupported, ...))` for any generic result type `T`.

**Call relations**: Called by every unimplemented `ExecutorFileSystem` method in the synthetic test double so tests fail clearly if resolution starts using additional operations.

*Call graph*: 1 external calls (new).


##### `SyntheticPluginFileSystem::canonicalize`  (lines 66–72)

```
fn canonicalize(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, PathUri>
```

**Purpose**: Implements the trait method as unsupported in the synthetic filesystem. Resolution should not need canonicalization.

**Data flow**: Ignores its inputs, returns a boxed async future that resolves to `Self::unsupported()`.

**Call relations**: Part of the fake filesystem surface; not expected to be called by the provider logic under test.

*Call graph*: 2 external calls (pin, unsupported).


##### `SyntheticPluginFileSystem::read_file`  (lines 74–91)

```
fn read_file(
        &'a self,
        path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>>
```

**Purpose**: Returns manifest bytes only for the configured manifest path and records the read. It simulates executor-side file reads during plugin resolution.

**Data flow**: Converts the incoming `PathUri` to an absolute path, records `FileSystemCall::Read(path.clone())` in `calls`, and if the path equals `self.manifest_path` returns `MANIFEST_CONTENTS` as bytes; otherwise it returns `NotFound`. The result is wrapped in a boxed async future.

**Call relations**: Used indirectly by `resolve_plugin_root` through `read_file_text`. Tests assert that this method is called only after metadata confirms the manifest exists.

*Call graph*: calls 1 internal fn (to_abs_path); 4 external calls (pin, new, Read, clone).


##### `SyntheticPluginFileSystem::read_file_stream`  (lines 93–99)

```
fn read_file_stream(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream>
```

**Purpose**: Marks streaming reads as unsupported in the synthetic filesystem. Plugin resolution should not require them.

**Data flow**: Returns a boxed async future resolving to `Self::unsupported()`.

**Call relations**: Included only to satisfy the trait; not part of the expected resolution call flow.

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

**Purpose**: Marks writes as unsupported in the synthetic filesystem. Resolution is read-only.

**Data flow**: Returns a boxed async future resolving to `Self::unsupported()`.

**Call relations**: Trait boilerplate for the test double; unexpected use would indicate a regression in provider behavior.

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

**Purpose**: Marks directory creation as unsupported in the synthetic filesystem. Resolution should not mutate the environment filesystem.

**Data flow**: Returns a boxed async future resolving to `Self::unsupported()`.

**Call relations**: Another intentionally unused trait method in the fake filesystem.

*Call graph*: 2 external calls (pin, unsupported).


##### `SyntheticPluginFileSystem::get_metadata`  (lines 119–146)

```
fn get_metadata(
        &'a self,
        path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>
```

**Purpose**: Returns synthetic metadata for the configured plugin root and manifest path and records each lookup. It drives manifest discovery in tests.

**Data flow**: Converts the `PathUri` to an absolute path, records `FileSystemCall::Metadata(path.clone())`, then returns directory metadata if the path equals `self.plugin_root`, file metadata if it equals `self.manifest_path`, or `NotFound` otherwise. The result is produced from a boxed async future.

**Call relations**: This is the main fake operation exercised by `resolve_plugin_root` while checking the root and probing discoverable manifest paths.

*Call graph*: calls 1 internal fn (to_abs_path); 4 external calls (pin, new, Metadata, clone).


##### `SyntheticPluginFileSystem::read_directory`  (lines 148–154)

```
fn read_directory(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>>
```

**Purpose**: Marks directory listing as unsupported in the synthetic filesystem. Plugin resolution should rely on known manifest paths rather than scanning directories.

**Data flow**: Returns a boxed async future resolving to `Self::unsupported()`.

**Call relations**: Unused by the provider logic under test.

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

**Purpose**: Marks removal as unsupported in the synthetic filesystem. Resolution should not delete anything.

**Data flow**: Returns a boxed async future resolving to `Self::unsupported()`.

**Call relations**: Trait filler for the test double; not expected in call flow.

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

**Purpose**: Marks copy operations as unsupported in the synthetic filesystem. Resolution should not copy files.

**Data flow**: Returns a boxed async future resolving to `Self::unsupported()`.

**Call relations**: Unused by provider resolution; included only to satisfy the trait.

*Call graph*: 2 external calls (pin, unsupported).


##### `write_manifest`  (lines 176–181)

```
fn write_manifest(plugin_root: &Path, relative_path: &str, contents: &str)
```

**Purpose**: Writes a manifest file under a plugin root at a chosen relative path for test setup. It supports tests that need preferred and alternate manifest layouts.

**Data flow**: Takes a plugin root, relative path, and contents, joins the path, creates the parent directory, and writes the file contents. It mutates the temp filesystem and returns nothing.

**Call relations**: Called by tests that need real on-disk manifests before invoking `ExecutorPluginProvider::resolve`.

*Call graph*: called by 2 (malformed_preferred_manifest_does_not_fall_through_to_alternate, unavailable_environment_does_not_fall_back_to_host_filesystem); 3 external calls (join, create_dir_all, write).


##### `selected_root`  (lines 183–191)

```
fn selected_root(id: &str, environment_id: &str, path: &Path) -> SelectedCapabilityRoot
```

**Purpose**: Constructs a `SelectedCapabilityRoot` pointing at an environment-owned filesystem path. It reduces repetitive test boilerplate.

**Data flow**: Accepts an ID, environment ID, and `&Path`, converts the path to a lossy string, and returns a `SelectedCapabilityRoot` with `CapabilityRootLocation::Environment` populated from those values.

**Call relations**: Used by multiple tests as the common input shape for `resolve_plugin_root` and `ExecutorPluginProvider::resolve`.

*Call graph*: called by 4 (malformed_preferred_manifest_does_not_fall_through_to_alternate, plugin_root_resolution_uses_supplied_executor_file_system, standalone_capability_root_is_not_a_plugin, unavailable_environment_does_not_fall_back_to_host_filesystem); 1 external calls (to_string_lossy).


##### `plugin_root_resolution_uses_supplied_executor_file_system`  (lines 194–244)

```
async fn plugin_root_resolution_uses_supplied_executor_file_system()
```

**Purpose**: Verifies that plugin resolution uses only the supplied executor filesystem, not the host filesystem, and that it probes the expected paths in order. It also checks the exact resolved plugin descriptor.

**Data flow**: Creates a temp path that does not exist on disk, converts it to `AbsolutePathBuf`, derives the manifest path, parses `MANIFEST_CONTENTS` into an expected manifest, constructs `SyntheticPluginFileSystem`, calls `resolve_plugin_root`, and asserts both the returned `ResolvedPlugin::from_environment(...)` and the recorded call sequence `[Metadata(root), Metadata(manifest), Read(manifest)]`.

**Call relations**: This test directly exercises `resolve_plugin_root` with the synthetic filesystem to validate the core environment-backed resolution path.

*Call graph*: calls 3 internal fn (parse_plugin_manifest, selected_root, from_absolute_path_checked); 6 external calls (new, new, assert!, assert_eq!, resolve_plugin_root, tempdir).


##### `standalone_capability_root_is_not_a_plugin`  (lines 247–263)

```
async fn standalone_capability_root_is_not_a_plugin()
```

**Purpose**: Checks that an environment directory without any discoverable plugin manifest resolves to `None` rather than an error. It validates the not-a-plugin path.

**Data flow**: Creates a real temp directory, instantiates `ExecutorPluginProvider` with `EnvironmentManager::default_for_tests()`, calls `resolve` on a selected root pointing at the standalone directory, and asserts that the result is `None`.

**Call relations**: This test goes through the public provider trait method rather than the helper, covering the normal no-manifest branch.

*Call graph*: calls 3 internal fn (new, selected_root, default_for_tests); 4 external calls (new, assert_eq!, create_dir_all, tempdir).


##### `unavailable_environment_does_not_fall_back_to_host_filesystem`  (lines 266–282)

```
async fn unavailable_environment_does_not_fall_back_to_host_filesystem()
```

**Purpose**: Ensures that if the selected environment ID is unavailable, the provider fails even when the referenced path exists on the host filesystem. It prevents accidental host fallback.

**Data flow**: Creates a real plugin manifest on disk, constructs a provider with `EnvironmentManager::without_environments()`, calls `resolve` with a missing environment ID, captures the error, and asserts the exact unavailable-environment message.

**Call relations**: This test targets the environment lookup branch in `resolve_bound`, before any filesystem inspection occurs.

*Call graph*: calls 4 internal fn (new, selected_root, write_manifest, without_environments); 3 external calls (new, assert_eq!, tempdir).


##### `malformed_preferred_manifest_does_not_fall_through_to_alternate`  (lines 285–320)

```
async fn malformed_preferred_manifest_does_not_fall_through_to_alternate()
```

**Purpose**: Verifies manifest precedence: if the preferred discoverable manifest exists but is malformed, resolution fails immediately instead of trying a lower-priority alternate manifest. It protects deterministic manifest selection.

**Data flow**: Writes malformed JSON to `.codex-plugin/plugin.json` and valid JSON to `.claude-plugin/plugin.json`, computes the expected preferred manifest absolute path, resolves through `ExecutorPluginProvider`, pattern-matches the resulting `ExecutorPluginProviderError::ParseManifest`, and asserts the root ID and path refer to the preferred manifest.

**Call relations**: This test exercises `resolve_plugin_root` through the provider and specifically validates the ordered probing logic over `DISCOVERABLE_PLUGIN_MANIFEST_PATHS`.

*Call graph*: calls 5 internal fn (new, selected_root, write_manifest, default_for_tests, from_absolute_path_checked); 4 external calls (new, assert_eq!, panic!, tempdir).


##### `executor_root_must_be_an_explicit_absolute_path`  (lines 323–342)

```
async fn executor_root_must_be_an_explicit_absolute_path()
```

**Purpose**: Checks that executor capability roots must already be absolute filesystem paths and that shell-like home-relative syntax is rejected. It validates `selected_plugin_root` input rules.

**Data flow**: Constructs a provider and a `SelectedCapabilityRoot` whose environment path is `~/plugins/demo`, calls `resolve`, captures the error, and asserts the exact invalid-root-path message.

**Call relations**: This test targets the earliest validation step in `resolve_bound`, before environment lookup or manifest probing.

*Call graph*: calls 2 internal fn (new, default_for_tests); 2 external calls (new, assert_eq!).


### `core-plugins/src/store_tests.rs`

`test` · `test execution`

This file is a focused test module for the plugin storage subsystem. It imports the parent module under test via `super::*`, then defines two fixture helpers that create a minimal plugin directory tree: `.codex-plugin/plugin.json`, `skills/SKILL.md`, and `.mcp.json`. The richer helper, `write_plugin_with_version`, optionally injects a `version` field into the manifest so tests can exercise both implicit `local` installs and explicit semantic versions.

The tests cover four main behaviors. First, path derivation: `PluginStore::try_new`, `plugin_root`, and `plugin_data_root` must resolve under `plugins/cache/<marketplace>/<name>/<version>` and `plugins/data/<name>-<marketplace>`, and reject non-absolute roots. Second, installation semantics: `install` copies plugin contents into the cache, uses the manifest name as the canonical plugin key, prefers the manifest version when present, falls back to `local` otherwise, and `install_with_version` honors a caller-supplied cache version. Third, active-version resolution: when multiple cached versions exist, `local` wins if present; otherwise the latest version is chosen, with semantic comparison for semver strings rather than plain lexicographic ordering. Reinstalling a newer version prunes older cached versions while preserving the plugin root. Fourth, validation and safety: blank manifest versions are rejected, plugin and marketplace names cannot contain path separators, and the manifest name must match the marketplace/plugin identifier supplied by the caller. The assertions are intentionally exact, including normalized error strings, so these tests lock down both behavior and user-visible diagnostics.

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

**Purpose**: Creates a minimal plugin fixture on disk under a chosen directory name, optionally embedding a manifest `version`. It writes the exact file structure expected by store installation tests so later assertions can inspect copied files and version-derived destinations.

**Data flow**: It takes a root path, a directory name to create beneath that root, a manifest `name`, and an optional manifest version string. It derives `plugin_root = root.join(dir_name)`, creates `.codex-plugin` and `skills` directories, formats JSON for `.codex-plugin/plugin.json` with or without a `version` field, then writes `skills/SKILL.md` and `.mcp.json`. It returns no value and mutates the filesystem only.

**Call relations**: This helper is invoked by tests that need a plugin fixture with precise manifest contents, especially version-sensitive cases such as manifest-version installs, blank-version rejection, and replacement of older cached versions. `write_plugin` delegates to it for the common no-version case.

*Call graph*: called by 4 (install_rejects_blank_manifest_version, install_uses_manifest_version_when_present, install_with_new_version_keeps_existing_plugin_root_and_prunes_old_versions, write_plugin); 4 external calls (join, format!, create_dir_all, write).


##### `write_plugin`  (lines 27–34)

```
fn write_plugin(root: &Path, dir_name: &str, manifest_name: &str)
```

**Purpose**: Builds the standard plugin fixture without a manifest version, causing store logic to treat the plugin as the default `local` version. It is the convenience wrapper used by most tests.

**Data flow**: It accepts the root path, fixture directory name, and manifest plugin name, then forwards those values to `write_plugin_with_version` with `None` for the version. It returns no value and writes the same filesystem structure as the underlying helper.

**Call relations**: Most installation and active-version tests call this wrapper when they only need a valid plugin tree and want the store to infer `local`. Its sole delegation is to `write_plugin_with_version`, centralizing fixture creation in one implementation.

*Call graph*: calls 1 internal fn (write_plugin_with_version); called by 9 (active_plugin_version_compares_semver_versions_semantically, active_plugin_version_prefers_default_local_version_when_multiple_versions_exist, active_plugin_version_reads_version_directory_name, active_plugin_version_returns_latest_version_when_default_is_missing, install_copies_plugin_into_default_marketplace, install_rejects_manifest_names_that_do_not_match_marketplace_plugin_name, install_rejects_manifest_names_with_path_separators, install_uses_manifest_name_for_destination_and_key, install_with_version_uses_requested_cache_version).


##### `try_new_rejects_relative_codex_home`  (lines 37–46)

```
fn try_new_rejects_relative_codex_home()
```

**Purpose**: Verifies that constructing a plugin store from a relative codex home fails immediately with a path-resolution error. The test also fixes the exact user-facing error text.

**Data flow**: It passes `PathBuf::from("relative")` into `PluginStore::try_new`, expects an error, converts that error to a string, normalizes path separators by replacing backslashes with `/`, and compares the result to the expected message. It writes no state.

**Call relations**: This is a direct assertion on store initialization behavior rather than a setup helper for other tests. It exercises the failure branch of `try_new` that rejects non-absolute cache roots.

*Call graph*: calls 1 internal fn (try_new); 2 external calls (from, assert_eq!).


##### `install_copies_plugin_into_default_marketplace`  (lines 49–72)

```
fn install_copies_plugin_into_default_marketplace()
```

**Purpose**: Checks the baseline install path: a plugin with no manifest version is copied into the cache under its marketplace/name and assigned the `local` version. It also confirms that key plugin files are physically present in the installed directory.

**Data flow**: It creates a temporary directory, writes a source plugin fixture, constructs a `PluginId` for `sample-plugin@debug`, and calls `PluginStore::new(...).install(...)` with an `AbsolutePathBuf` source path. It asserts that the returned `PluginInstallResult` contains the same plugin id, version `local`, and the expected installed path, then verifies `.codex-plugin/plugin.json` and `skills/SKILL.md` exist under that destination.

**Call relations**: This test drives the normal `install` path and depends on `write_plugin` to prepare the source tree. It validates both the returned metadata and the side effect of copying files into the default marketplace cache layout.

*Call graph*: calls 4 internal fn (new, write_plugin, new, try_from); 3 external calls (assert!, assert_eq!, tempdir).


##### `install_uses_manifest_name_for_destination_and_key`  (lines 75–98)

```
fn install_uses_manifest_name_for_destination_and_key()
```

**Purpose**: Ensures installation canonicalizes the plugin name from `plugin.json`, not from the source directory name. The destination path and returned key must therefore use the manifest name.

**Data flow**: It creates a temp fixture whose directory is `source-dir` but whose manifest name is `manifest-name`, constructs a matching `PluginId`, installs from the source path, and asserts that the resulting `PluginInstallResult` points to `plugins/cache/market/manifest-name/local`. The test reads only the returned install metadata.

**Call relations**: This test exercises the branch of `install` that reads and trusts the manifest name when it matches the caller-supplied plugin id. It uses `write_plugin` to create the mismatch between directory name and manifest name.

*Call graph*: calls 4 internal fn (new, write_plugin, new, try_from); 2 external calls (assert_eq!, tempdir).


##### `plugin_root_derives_path_from_key_and_version`  (lines 101–110)

```
fn plugin_root_derives_path_from_key_and_version()
```

**Purpose**: Confirms the deterministic cache path formula used for a plugin id and version string. It locks down the exact directory nesting under `plugins/cache`.

**Data flow**: It creates a temporary store root, constructs `PluginStore` and a `PluginId` for `sample@debug`, calls `store.plugin_root(&plugin_id, "local")`, and compares the resulting path to `tmp/plugins/cache/debug/sample/local`. No filesystem writes occur beyond the temp directory creation.

**Call relations**: This is a pure path-derivation test for a store helper. It does not depend on fixture creation or installation, only on `PluginStore::new` and `plugin_root`.

*Call graph*: calls 2 internal fn (new, new); 2 external calls (assert_eq!, tempdir).


##### `plugin_data_root_derives_path_from_key`  (lines 113–122)

```
fn plugin_data_root_derives_path_from_key()
```

**Purpose**: Verifies the separate per-plugin data directory naming convention. Unlike cached code, plugin data is keyed by a flattened `<name>-<marketplace>` suffix under `plugins/data`.

**Data flow**: It creates a temporary store root, constructs a `PluginStore` and `PluginId`, calls `store.plugin_data_root(&plugin_id)`, and asserts the path equals `tmp/plugins/data/sample-debug`. It returns nothing and performs no plugin installation.

**Call relations**: This test isolates the data-root helper from the rest of the store logic. It complements `plugin_root_derives_path_from_key_and_version` by covering the non-cache path convention.

*Call graph*: calls 2 internal fn (new, new); 2 external calls (assert_eq!, tempdir).


##### `install_with_version_uses_requested_cache_version`  (lines 125–152)

```
fn install_with_version_uses_requested_cache_version()
```

**Purpose**: Checks that `install_with_version` bypasses manifest/default version inference and stores the plugin under the caller-provided cache version string. It also verifies the copied manifest file exists at that exact location.

**Data flow**: It creates a temp plugin fixture without a manifest version, builds a `PluginId` in the `openai-curated` marketplace, defines a version string `0123456789abcdef`, and calls `install_with_version` with the source path and explicit version. It asserts the returned `PluginInstallResult` contains that version and the expected cache path, then checks `.codex-plugin/plugin.json` exists there.

**Call relations**: This test covers the explicit-version installation API rather than the default `install` path. It uses `write_plugin` only to provide valid source contents; the version selection is driven entirely by the method under test.

*Call graph*: calls 4 internal fn (new, write_plugin, new, try_from); 4 external calls (assert!, assert_eq!, format!, tempdir).


##### `install_uses_manifest_version_when_present`  (lines 155–184)

```
fn install_uses_manifest_version_when_present()
```

**Purpose**: Verifies that a nonblank `version` field in `plugin.json` becomes the installed cache version. This distinguishes manifest-driven versioned installs from the fallback `local` behavior.

**Data flow**: It creates a temp plugin fixture whose manifest includes `1.2.3-beta+7`, constructs a matching `PluginId`, and calls `install`. It asserts that the returned `PluginInstallResult` reports `plugin_version: "1.2.3-beta+7"`, that the installed path includes that version segment, and that the copied manifest file exists there.

**Call relations**: This test exercises the manifest-reading branch of `install` and relies on `write_plugin_with_version` to inject a semver-like version string. It complements the default-version install test by proving manifest metadata overrides `local`.

*Call graph*: calls 4 internal fn (new, write_plugin_with_version, new, try_from); 3 external calls (assert!, assert_eq!, tempdir).


##### `install_rejects_blank_manifest_version`  (lines 187–204)

```
fn install_rejects_blank_manifest_version()
```

**Purpose**: Ensures the installer treats whitespace-only manifest versions as invalid rather than silently normalizing them or falling back to `local`. The exact validation error is part of the contract.

**Data flow**: It writes a plugin fixture with `version` set to spaces, constructs a `PluginId`, calls `install`, expects an error, converts that error to a string, normalizes path separators, and compares it to `invalid plugin version in plugin.json: must not be blank`. No successful installation occurs.

**Call relations**: This test targets the manifest validation path inside `install`. It uses `write_plugin_with_version` specifically to create the malformed input that should be rejected before any cache copy is finalized.

*Call graph*: calls 4 internal fn (new, write_plugin_with_version, new, try_from); 2 external calls (assert_eq!, tempdir).


##### `active_plugin_version_reads_version_directory_name`  (lines 207–225)

```
fn active_plugin_version_reads_version_directory_name()
```

**Purpose**: Checks that the active-version lookup derives its answer from the version directory names already present in the cache. It also verifies that `active_plugin_root` resolves to the corresponding directory.

**Data flow**: It manually writes a plugin fixture under `plugins/cache/debug/sample-plugin/local`, constructs a store and matching `PluginId`, then asserts `active_plugin_version` returns `Some("local")` and `active_plugin_root` returns that exact path. The test reads the filesystem layout rather than invoking installation.

**Call relations**: This test exercises the cache-inspection logic directly, using `write_plugin` to seed the expected on-disk structure. It validates both version discovery and root-path resolution for the active plugin.

*Call graph*: calls 3 internal fn (new, write_plugin, new); 2 external calls (assert_eq!, tempdir).


##### `active_plugin_version_prefers_default_local_version_when_multiple_versions_exist`  (lines 228–247)

```
fn active_plugin_version_prefers_default_local_version_when_multiple_versions_exist()
```

**Purpose**: Verifies the precedence rule that `local` remains active when both `local` and another cached version are present. This prevents a downloaded or versioned cache entry from displacing the default local install.

**Data flow**: It creates two plugin fixture directories under the same plugin root: one versioned `0123456789abcdef` and one `local`. It then constructs the store and plugin id and asserts `active_plugin_version` returns `Some("local")`.

**Call relations**: This test drives the branch of active-version selection that gives special priority to the default version. It uses `write_plugin` twice to create the competing cache entries.

*Call graph*: calls 3 internal fn (new, write_plugin, new); 2 external calls (assert_eq!, tempdir).


##### `active_plugin_version_returns_latest_version_when_default_is_missing`  (lines 250–269)

```
fn active_plugin_version_returns_latest_version_when_default_is_missing()
```

**Purpose**: Checks fallback selection when no `local` version exists: the store should choose the latest available cached version. The test uses two opaque version-like strings to confirm ordering among non-default entries.

**Data flow**: It seeds the cache with plugin directories `0123456789abcdef` and `fedcba9876543210`, constructs the store and plugin id, and asserts `active_plugin_version` returns `Some("fedcba9876543210")`. The result is derived entirely from directory names on disk.

**Call relations**: This test covers the non-`local` branch of active-version resolution. It complements the previous test by showing how the store behaves when only versioned cache entries are available.

*Call graph*: calls 3 internal fn (new, write_plugin, new); 2 external calls (assert_eq!, tempdir).


##### `active_plugin_version_compares_semver_versions_semantically`  (lines 272–291)

```
fn active_plugin_version_compares_semver_versions_semantically()
```

**Purpose**: Ensures semantic-version comparison is numeric/semantic rather than lexicographic. In particular, `10.0.0` must outrank `9.0.0` even though string ordering would suggest otherwise.

**Data flow**: It writes plugin fixtures under version directories `9.0.0` and `10.0.0`, constructs the store and plugin id, and asserts `active_plugin_version` returns `Some("10.0.0")`. The test reads only the discovered active version.

**Call relations**: This test targets the version-ordering logic used by active-version selection. It uses `write_plugin` to create semver-shaped cache entries and proves the selector performs semantic comparison.

*Call graph*: calls 3 internal fn (new, write_plugin, new); 2 external calls (assert_eq!, tempdir).


##### `install_with_new_version_keeps_existing_plugin_root_and_prunes_old_versions`  (lines 294–329)

```
fn install_with_new_version_keeps_existing_plugin_root_and_prunes_old_versions()
```

**Purpose**: Verifies upgrade behavior for repeated installs of the same plugin: the newest version becomes active, the plugin root remains stable, and older version directories are removed. This locks down cache-pruning semantics.

**Data flow**: It creates a store and plugin id, writes and installs a `1.0.0` fixture, then writes and installs a `2.0.0` fixture for the same plugin. After the second install it asserts `active_plugin_version` is `Some("2.0.0")`, that `plugins/cache/debug/sample-plugin/2.0.0` exists as a directory, and that `plugins/cache/debug/sample-plugin/1.0.0` no longer exists.

**Call relations**: This test drives two successive `install` calls against the same plugin id to exercise replacement logic. It depends on `write_plugin_with_version` to create distinct manifest versions and validates both selection and cleanup side effects.

*Call graph*: calls 4 internal fn (new, write_plugin_with_version, new, try_from); 3 external calls (assert!, assert_eq!, tempdir).


##### `old_plugin_version_would_stay_active_for_local_or_later_versions`  (lines 332–339)

```
fn old_plugin_version_would_stay_active_for_local_or_later_versions()
```

**Purpose**: Tests the helper predicate that decides whether an existing plugin version should remain active instead of being replaced. The covered cases show that `local` and newer installed versions block activation of an older incoming version.

**Data flow**: It calls `old_plugin_version_would_stay_active` three times with representative version pairs and asserts the boolean outcomes: `local` beats `1.0.0`, `10.0.0` beats `9.0.0`, and `1.0.0` does not beat `2.0.0`. It has no side effects.

**Call relations**: This is a direct unit test of a version-comparison helper used by store update logic. Rather than going through installation, it isolates the decision rule in a few explicit assertions.

*Call graph*: 1 external calls (assert!).


##### `plugin_root_rejects_path_separators_in_key_segments`  (lines 342–354)

```
fn plugin_root_rejects_path_separators_in_key_segments()
```

**Purpose**: Confirms that plugin ids cannot smuggle path traversal or separators through either the plugin name or marketplace segment. The test fixes the exact parse-time validation messages for both cases.

**Data flow**: It calls `PluginId::parse` with `../../etc@debug` and `sample@../../etc`, unwraps each error, converts them to strings, and compares them to the expected invalid-name and invalid-marketplace messages. No filesystem state is touched.

**Call relations**: This test exercises identifier parsing and validation independently of installation. It guards the path-construction code indirectly by ensuring unsafe key segments are rejected before any path is derived.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `install_rejects_manifest_names_with_path_separators`  (lines 357–372)

```
fn install_rejects_manifest_names_with_path_separators()
```

**Purpose**: Ensures installation rejects a plugin whose manifest `name` contains path separators or traversal syntax, even if the caller supplied a safe plugin id. This prevents unsafe manifest data from influencing destination paths.

**Data flow**: It creates a temp plugin fixture whose manifest name is `../../etc`, constructs a safe `PluginId` for `source-dir@debug`, calls `install`, expects an error, and asserts the error string equals `invalid plugin name: only ASCII letters, digits, `_`, and `-` are allowed`. No installation result is produced.

**Call relations**: This test covers validation of manifest-derived names inside `install`. It uses `write_plugin` to inject the bad manifest value and confirms the installer rejects it before copying into the cache.

*Call graph*: calls 4 internal fn (new, write_plugin, new, try_from); 2 external calls (assert_eq!, tempdir).


##### `install_rejects_marketplace_names_with_path_separators`  (lines 375–382)

```
fn install_rejects_marketplace_names_with_path_separators()
```

**Purpose**: Checks that marketplace names are validated at `PluginId` construction time and cannot contain path separators. This is the marketplace-side counterpart to plugin-name validation.

**Data flow**: It calls `PluginId::new` with a valid plugin name and an invalid marketplace string `../../etc`, unwraps the resulting error, and compares its string form to the expected invalid-marketplace message. It performs no filesystem operations.

**Call relations**: This test isolates `PluginId::new` validation rather than going through store installation. It proves unsafe marketplace segments are rejected before any plugin path can be computed.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `install_rejects_manifest_names_that_do_not_match_marketplace_plugin_name`  (lines 385–400)

```
fn install_rejects_manifest_names_that_do_not_match_marketplace_plugin_name()
```

**Purpose**: Verifies that the installer cross-checks the manifest `name` against the caller-supplied marketplace/plugin identifier and rejects mismatches. This prevents a source directory from being installed under one id while declaring another.

**Data flow**: It writes a plugin fixture whose manifest name is `manifest-name`, then calls `install` with a `PluginId` for `different-name@debug`. It expects an error and asserts the exact message states that `plugin.json name 'manifest-name' does not match marketplace plugin name 'different-name'`.

**Call relations**: This test exercises the consistency check inside `install` between manifest metadata and the requested plugin id. It uses `write_plugin` to create the mismatch and confirms installation aborts rather than silently renaming or accepting the discrepancy.

*Call graph*: calls 4 internal fn (new, write_plugin, new, try_from); 2 external calls (assert_eq!, tempdir).


### `core-plugins/src/loader_tests.rs`

`test` · `test execution`

This test module focuses on the standalone functions in `loader.rs` rather than the higher-level manager. It includes helpers for constructing user config layer entries, temporary plugin roots, manifests, hook files, and a reusable `load_sources` wrapper that resolves hook sources from a plugin root. The tests are intentionally concrete and filesystem-heavy so they exercise the same parsing and path-resolution code used in production.

One group validates configuration and loading scope behavior. `configured_plugins_from_stack_merges_user_layers` proves that effective user config merges plugin entries across multiple user layers. `hooks_only_scope_shares_plugin_resolution_without_loading_other_capabilities` creates valid, disabled, malformed, missing, and warning-producing plugins in the store, then compares full loading with `PluginLoadScope::HooksOnly`; the test asserts that plugin identity, enabled state, root, errors, and hook outputs match while manifest metadata, skills, MCP servers, and apps remain empty in hooks-only mode.

Another group exhaustively checks hook discovery precedence: default `hooks/hooks.json`, manifest single path, manifest path list replacing the default file, inline manifest hooks, inline hook lists, and invalid hook-file warnings. The helper `assert_sources` verifies plugin id propagation, source-relative paths, and handler counts. Finally, cache-version tests pin down SHA shortening behavior, and `materialize_git_subdir_uses_sparse_checkout` creates a real git repo to prove that materializing a git source with a subdirectory path uses sparse checkout and does not populate unrelated repository files.

#### Function details

##### `user_config_path`  (lines 12–15)

```
fn user_config_path(temp_dir: &TempDir, file_name: &str) -> AbsolutePathBuf
```

**Purpose**: Builds an absolute path for a temporary user config file in tests. It ensures the path satisfies `AbsolutePathBuf` requirements.

**Data flow**: Reads a `TempDir` and `file_name` → joins the temp directory path with the file name, converts it with `AbsolutePathBuf::from_absolute_path`, and returns the absolute path buffer.

**Call relations**: Used by `user_layer` callers when constructing `ConfigLayerEntry` values for config-stack tests.

*Call graph*: calls 1 internal fn (from_absolute_path); 1 external calls (path).


##### `user_layer`  (lines 17–25)

```
fn user_layer(path: AbsolutePathBuf, config: &str) -> ConfigLayerEntry
```

**Purpose**: Constructs a user-sourced `ConfigLayerEntry` from a path and TOML string. It is a compact fixture helper for layered-config tests.

**Data flow**: Takes an `AbsolutePathBuf` and TOML text → parses the TOML into a value with `toml::from_str`, wraps it in `ConfigLayerSource::User { file, profile: None }`, and returns `ConfigLayerEntry::new(...)`.

**Call relations**: Used by config-stack tests to build layered user configuration inputs.

*Call graph*: calls 1 internal fn (new); 1 external calls (from_str).


##### `configured_plugins_from_stack_merges_user_layers`  (lines 28–67)

```
fn configured_plugins_from_stack_merges_user_layers()
```

**Purpose**: Verifies that plugin config entries from multiple user layers are merged into the effective plugin map. It checks both enabled and disabled plugin states survive the merge.

**Data flow**: Creates a temp dir, builds a `ConfigLayerStack` with two user layers containing different `[plugins.*]` entries, calls `configured_plugins_from_stack`, and asserts the returned `HashMap<String, PluginConfig>` contains both plugin keys with expected `enabled` flags and empty MCP policy maps.

**Call relations**: Directly exercises the loader’s config extraction helper without involving plugin store or filesystem plugin contents.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, default, assert_eq!, default, vec!).


##### `hooks_only_scope_shares_plugin_resolution_without_loading_other_capabilities`  (lines 70–210)

```
async fn hooks_only_scope_shares_plugin_resolution_without_loading_other_capabilities()
```

**Purpose**: Checks that hooks-only loading resolves the same plugin set, roots, errors, and hook outputs as full loading while intentionally skipping manifest metadata, skills, MCP servers, and apps. It validates the optimization boundary of `PluginLoadScope::HooksOnly`.

**Data flow**: Creates multiple plugin directories in a temp store cache with varying validity, writes manifests, skills, MCP, app, and hook files, builds a config stack enabling/disabling several plugin ids, constructs a `PluginStore`, awaits both `load_plugins_from_layer_stack` and `load_plugins_from_layer_stack_with_scope(..., HooksOnly)`, compares a reduced validation tuple across both results, then inspects the `valid@test` plugin in each result to assert full load has capabilities while hooks-only leaves those capability fields empty.

**Call relations**: Exercises both bulk loader entry points and demonstrates that hooks-only mode shares plugin resolution logic but not capability loading.

*Call graph*: calls 2 internal fn (new, new); 8 external calls (new, new, default, assert!, assert_eq!, default, write_file, vec!).


##### `curated_plugin_cache_version_shortens_full_git_sha`  (lines 213–218)

```
fn curated_plugin_cache_version_shortens_full_git_sha()
```

**Purpose**: Pins down the rule that full git SHAs are shortened to eight characters for curated cache versions.

**Data flow**: Calls `curated_plugin_cache_version` with a 40-character hex string and asserts the returned string is the first eight characters.

**Call relations**: Direct unit test for the curated cache-version helper.

*Call graph*: 1 external calls (assert_eq!).


##### `curated_plugin_cache_version_preserves_non_git_sha_versions`  (lines 221–227)

```
fn curated_plugin_cache_version_preserves_non_git_sha_versions()
```

**Purpose**: Verifies that non-SHA version strings and short hex-like strings are preserved unchanged by curated cache version normalization.

**Data flow**: Calls `curated_plugin_cache_version` with `export-backup` and `0123456`, asserting each result equals the input.

**Call relations**: Complements the SHA-shortening test by covering the non-shortening branch.

*Call graph*: 1 external calls (assert_eq!).


##### `plugin_id`  (lines 229–231)

```
fn plugin_id() -> PluginId
```

**Purpose**: Returns a fixed parsed `PluginId` used by hook-source tests. It avoids repeating parse boilerplate.

**Data flow**: Parses the literal `demo-plugin@test-marketplace` with `PluginId::parse` and returns the resulting `PluginId`, panicking on failure.

**Call relations**: Used by `load_sources` and indirectly by hook-source assertions.

*Call graph*: calls 1 internal fn (parse); called by 1 (load_sources).


##### `plugin_root`  (lines 233–240)

```
fn plugin_root() -> (tempfile::TempDir, AbsolutePathBuf)
```

**Purpose**: Creates a temporary plugin root with standard manifest and hooks directories. It is the common filesystem fixture for hook-loading tests.

**Data flow**: Creates a tempdir, constructs an absolute plugin root path under it, creates `.codex-plugin` and `hooks` directories with `fs::create_dir_all`, and returns `(TempDir, AbsolutePathBuf)`.

**Call relations**: Called by the hook-loading tests before writing manifests and hook files.

*Call graph*: calls 1 internal fn (try_from); called by 6 (load_plugin_hooks_discovers_default_hooks_file, load_plugin_hooks_manifest_paths_replace_default_hooks_file, load_plugin_hooks_reports_invalid_hook_file, load_plugin_hooks_supports_inline_manifest_hook_list, load_plugin_hooks_supports_inline_manifest_hooks, load_plugin_hooks_supports_manifest_hook_path); 2 external calls (create_dir_all, tempdir).


##### `write_manifest`  (lines 242–244)

```
fn write_manifest(plugin_root: &AbsolutePathBuf, manifest: &str)
```

**Purpose**: Writes a plugin manifest string into the standard `.codex-plugin/plugin.json` location for a test plugin root.

**Data flow**: Takes `plugin_root` and manifest text → joins `.codex-plugin/plugin.json` and writes the string with `fs::write` → returns unit.

**Call relations**: Used by hook-loading tests to control manifest hook declarations.

*Call graph*: calls 1 internal fn (join); called by 6 (load_plugin_hooks_discovers_default_hooks_file, load_plugin_hooks_manifest_paths_replace_default_hooks_file, load_plugin_hooks_reports_invalid_hook_file, load_plugin_hooks_supports_inline_manifest_hook_list, load_plugin_hooks_supports_inline_manifest_hooks, load_plugin_hooks_supports_manifest_hook_path); 1 external calls (write).


##### `write_hook_file`  (lines 246–262)

```
fn write_hook_file(plugin_root: &AbsolutePathBuf, relative_path: &str, event: &str, command: &str)
```

**Purpose**: Writes a minimal hook config file for a given event and command under a relative path in the plugin root. It simplifies hook fixture creation.

**Data flow**: Takes `plugin_root`, `relative_path`, `event`, and `command` → formats a JSON hooks document and writes it to `plugin_root.join(relative_path)` → returns unit.

**Call relations**: Used by tests covering manifest hook paths and path lists.

*Call graph*: calls 1 internal fn (join); called by 2 (load_plugin_hooks_manifest_paths_replace_default_hooks_file, load_plugin_hooks_supports_manifest_hook_path); 2 external calls (format!, write).


##### `load_sources`  (lines 264–280)

```
fn load_sources(plugin_root: &AbsolutePathBuf) -> (Vec<PluginHookSource>, Vec<String>)
```

**Purpose**: Loads hook sources and warnings for a test plugin root using the production hook loader. It hides manifest and plugin-data-root setup details.

**Data flow**: Reads `plugin_root`, loads the manifest with `load_plugin_manifest`, derives a sibling `plugin-data` absolute path from the plugin root parent, calls `load_plugin_hooks(plugin_root, &plugin_id(), &plugin_data_root, &manifest.paths)`, and returns the `(sources, warnings)` tuple.

**Call relations**: Shared by all hook-loading tests as the common invocation path into production code.

*Call graph*: calls 4 internal fn (plugin_id, load_plugin_manifest, as_path, try_from); called by 6 (load_plugin_hooks_discovers_default_hooks_file, load_plugin_hooks_manifest_paths_replace_default_hooks_file, load_plugin_hooks_reports_invalid_hook_file, load_plugin_hooks_supports_inline_manifest_hook_list, load_plugin_hooks_supports_inline_manifest_hooks, load_plugin_hooks_supports_manifest_hook_path).


##### `assert_sources`  (lines 282–304)

```
fn assert_sources(sources: &[PluginHookSource], expected_relative_paths: &[&str])
```

**Purpose**: Asserts common invariants about loaded hook sources: plugin id propagation, source-relative paths, and handler counts. It keeps hook tests concise and consistent.

**Data flow**: Reads a slice of `PluginHookSource` and expected relative paths → maps sources to plugin ids, relative paths, and `hooks.handler_count()`, then asserts those vectors equal the expected plugin-id repetition, expected paths, and a vector of ones.

**Call relations**: Called by the hook-loading tests after `load_sources` to validate the returned source metadata.

*Call graph*: called by 5 (load_plugin_hooks_discovers_default_hooks_file, load_plugin_hooks_manifest_paths_replace_default_hooks_file, load_plugin_hooks_supports_inline_manifest_hook_list, load_plugin_hooks_supports_inline_manifest_hooks, load_plugin_hooks_supports_manifest_hook_path); 1 external calls (assert_eq!).


##### `load_plugin_hooks_discovers_default_hooks_file`  (lines 307–329)

```
fn load_plugin_hooks_discovers_default_hooks_file()
```

**Purpose**: Verifies that `load_plugin_hooks` falls back to `hooks/hooks.json` when the manifest does not declare hooks explicitly.

**Data flow**: Creates a plugin root, writes a minimal manifest without hooks, writes `hooks/hooks.json`, calls `load_sources`, asserts no warnings, and checks that the sole source-relative path is `hooks/hooks.json`.

**Call relations**: Exercises the default-file branch of `load_plugin_hooks`.

*Call graph*: calls 4 internal fn (assert_sources, load_sources, plugin_root, write_manifest); 2 external calls (assert_eq!, write).


##### `load_plugin_hooks_supports_manifest_hook_path`  (lines 332–347)

```
fn load_plugin_hooks_supports_manifest_hook_path()
```

**Purpose**: Checks that a manifest `hooks` string path is honored and loaded as the plugin’s hook source.

**Data flow**: Creates a plugin root, writes a manifest with `"hooks": "./hooks/one.json"`, writes that hook file, loads sources, asserts no warnings, and verifies the returned relative path is `hooks/one.json`.

**Call relations**: Exercises the manifest single-path branch of `load_plugin_hooks`.

*Call graph*: calls 5 internal fn (assert_sources, load_sources, plugin_root, write_hook_file, write_manifest); 1 external calls (assert_eq!).


##### `load_plugin_hooks_manifest_paths_replace_default_hooks_file`  (lines 350–372)

```
fn load_plugin_hooks_manifest_paths_replace_default_hooks_file()
```

**Purpose**: Verifies that manifest-declared hook path lists replace, rather than augment, the default `hooks/hooks.json`. Only the listed files should be loaded.

**Data flow**: Creates a plugin root, writes a manifest with two hook paths, writes both listed files plus a default hooks file that should be ignored, loads sources, asserts no warnings, and verifies only `hooks/one.json` and `hooks/two.json` are returned.

**Call relations**: Exercises the manifest path-list branch and its precedence over the default hook file.

*Call graph*: calls 5 internal fn (assert_sources, load_sources, plugin_root, write_hook_file, write_manifest); 1 external calls (assert_eq!).


##### `load_plugin_hooks_supports_inline_manifest_hooks`  (lines 375–398)

```
fn load_plugin_hooks_supports_inline_manifest_hooks()
```

**Purpose**: Checks that inline hook declarations embedded directly in `plugin.json` are converted into hook sources with synthetic manifest-relative source paths.

**Data flow**: Creates a plugin root, writes a manifest containing an inline `hooks` object, loads sources, asserts no warnings, and verifies the returned source-relative path is `plugin.json#hooks[0]`.

**Call relations**: Exercises the inline single-object branch of `load_plugin_hooks`.

*Call graph*: calls 4 internal fn (assert_sources, load_sources, plugin_root, write_manifest); 1 external calls (assert_eq!).


##### `load_plugin_hooks_reports_invalid_hook_file`  (lines 401–416)

```
fn load_plugin_hooks_reports_invalid_hook_file()
```

**Purpose**: Ensures invalid JSON in a hook file produces a warning and no hook sources rather than crashing. The warning message includes the full file path and parse error.

**Data flow**: Creates a plugin root, writes a manifest without explicit hooks, writes malformed JSON to `hooks/hooks.json`, loads sources, asserts the sources vector is empty, and asserts the warnings vector contains the expected formatted parse error string.

**Call relations**: Exercises the error-reporting path in `append_plugin_hook_file` through the default hook-file branch.

*Call graph*: calls 3 internal fn (load_sources, plugin_root, write_manifest); 2 external calls (assert_eq!, write).


##### `load_plugin_hooks_supports_inline_manifest_hook_list`  (lines 419–452)

```
fn load_plugin_hooks_supports_inline_manifest_hook_list()
```

**Purpose**: Verifies that a manifest can contain a list of inline hook objects and that each non-empty entry becomes a separate hook source.

**Data flow**: Creates a plugin root, writes a manifest whose `hooks` field is a two-element inline list, loads sources, asserts no warnings, and verifies the returned relative paths are `plugin.json#hooks[0]` and `plugin.json#hooks[1]`.

**Call relations**: Exercises the inline list branch of `load_plugin_hooks`.

*Call graph*: calls 4 internal fn (assert_sources, load_sources, plugin_root, write_manifest); 1 external calls (assert_eq!).


##### `materialize_git_subdir_uses_sparse_checkout`  (lines 455–499)

```
fn materialize_git_subdir_uses_sparse_checkout()
```

**Purpose**: Proves that materializing a git marketplace source with a subdirectory path uses sparse checkout so unrelated repository files are absent. It validates the git-source optimization path.

**Data flow**: Creates temp CODEX_HOME and a temp git repo with files inside and outside `plugins/toolkit`, initializes and commits the repo using `run_git`, calls `materialize_marketplace_plugin_source` with a `MarketplacePluginSource::Git` pointing at `plugins/toolkit`, then asserts the materialized path ends at the toolkit directory, contains `marker.txt`, and that unrelated root and sibling plugin files do not exist in the checkout root.

**Call relations**: Exercises `materialize_marketplace_plugin_source`, `clone_git_plugin_source`, and `run_git` together through a real repository fixture.

*Call graph*: 5 external calls (assert!, assert_eq!, create_dir_all, write, tempdir).


### `core-plugins/src/marketplace_tests.rs`

`test` · `test execution`

This file builds temporary repository and home-directory layouts on disk, writes marketplace and plugin manifest JSON files, and asserts the exact `Marketplace`, `MarketplacePlugin`, and `ResolvedMarketplacePlugin` values returned by the marketplace subsystem. Two small helpers create the alternate `.claude-plugin/marketplace.json` and `.claude-plugin/plugin.json` layouts so tests can focus on behavior rather than setup. The tests cover local string sources and structured local sources, `git-subdir` sources with GitHub shorthand normalization, relative git URLs resolved against the marketplace root, and rejection of parent-directory traversal. They also verify that root-equivalent git subdirectory paths are ignored, missing plugins produce marketplace-qualified errors, and duplicate plugin entries resolve to the first match.

On the listing side, the suite checks repository and home marketplaces together, deduplication of multiple roots inside one repo, preservation of distinct marketplaces that share the same name, preference ordering between supported manifest layouts, explicit manifest-path inputs, marketplace display-name parsing, and partial-failure behavior. Invalid plugins or invalid plugin names are dropped while keeping the marketplace entry; malformed marketplace JSON is surfaced in the returned error list instead. Additional tests pin policy defaults, product gating for installability, ignoring legacy top-level policy fields, and absolute resolution of plugin interface asset paths only when they use `./`-style relative references.

#### Function details

##### `write_alternate_marketplace`  (lines 10–15)

```
fn write_alternate_marketplace(repo_root: &Path, contents: &str) -> AbsolutePathBuf
```

**Purpose**: Creates an alternate-layout marketplace manifest under `.claude-plugin/marketplace.json` and returns its absolute path wrapper. It is a shared fixture helper for tests that need the non-default marketplace location.

**Data flow**: Takes a repository root `&Path` and raw JSON `&str`, joins the alternate relative path, creates parent directories, writes the file contents, then converts the resulting path into `AbsolutePathBuf`. It mutates the temporary filesystem and returns the manifest path for later calls into marketplace-loading code.

**Call relations**: This helper is invoked by tests that specifically exercise alternate marketplace layout support, mixed source parsing, and layout precedence. It does no assertions itself; it prepares the exact file path later passed to `find_marketplace_plugin` or discovered by `list_marketplaces_with_home`.

*Call graph*: calls 1 internal fn (try_from); called by 5 (find_marketplace_plugin_supports_alternate_layout_and_string_local_source, list_marketplaces_includes_plugins_without_discoverable_manifest, list_marketplaces_keeps_remote_and_local_plugin_sources, list_marketplaces_prefers_first_supported_manifest_layout, list_marketplaces_supports_alternate_manifest_layout); 3 external calls (join, create_dir_all, write).


##### `write_alternate_plugin_manifest`  (lines 17–21)

```
fn write_alternate_plugin_manifest(plugin_root: &Path, contents: &str)
```

**Purpose**: Creates an alternate-layout plugin manifest under `.claude-plugin/plugin.json` inside a plugin root. It supports tests that verify manifest discovery beyond the default `.codex-plugin` location.

**Data flow**: Accepts a plugin root `&Path` and manifest JSON `&str`, computes the alternate manifest path, creates its parent directory, and writes the contents. It returns no value and only affects the temporary filesystem.

**Call relations**: Used by the alternate-layout marketplace listing test to ensure plugin interface metadata can be discovered from the alternate manifest location. It is a pure setup helper called before `list_marketplaces_with_home`.

*Call graph*: called by 1 (list_marketplaces_supports_alternate_manifest_layout); 3 external calls (join, create_dir_all, write).


##### `find_marketplace_plugin_finds_repo_marketplace_plugin`  (lines 24–70)

```
fn find_marketplace_plugin_finds_repo_marketplace_plugin()
```

**Purpose**: Verifies that a standard repository marketplace file resolves a local plugin entry into a fully populated `ResolvedMarketplacePlugin`. The assertion pins plugin ID construction, local path absolutization, and default policy values.

**Data flow**: Creates a temp repo with `.git`, `.agents/plugins`, and a `marketplace.json` containing one local plugin. It passes the absolute marketplace path and plugin name to `find_marketplace_plugin`, then compares the returned struct against an expected `ResolvedMarketplacePlugin` with `MarketplacePluginSource::Local` and default policy fields.

**Call relations**: This is a direct test of the main plugin lookup path in the marketplace module. It does not delegate beyond filesystem setup and the final assertion, and serves as the baseline case other tests vary from.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `find_marketplace_plugin_supports_alternate_layout_and_string_local_source`  (lines 73–113)

```
fn find_marketplace_plugin_supports_alternate_layout_and_string_local_source()
```

**Purpose**: Checks that plugin lookup works when the marketplace manifest lives in the alternate `.claude-plugin` location and the plugin source is expressed as a bare string path. It confirms that string sources are interpreted as local paths rooted at the repo.

**Data flow**: Builds a temp repo with `.git`, writes an alternate marketplace manifest via `write_alternate_marketplace`, calls `find_marketplace_plugin`, and asserts the returned plugin ID, absolute local source path, and default policy values.

**Call relations**: This test depends on the helper to create the alternate manifest and then exercises the same lookup API as the baseline test, but under the alternate layout and shorthand source syntax.

*Call graph*: calls 1 internal fn (write_alternate_marketplace); 3 external calls (assert_eq!, create_dir_all, tempdir).


##### `find_marketplace_plugin_supports_git_subdir_sources`  (lines 116–167)

```
fn find_marketplace_plugin_supports_git_subdir_sources()
```

**Purpose**: Verifies parsing of structured `git-subdir` marketplace sources into the internal Git source representation. It locks down URL normalization, optional subdirectory path, ref name, and SHA propagation.

**Data flow**: Creates a standard marketplace manifest containing a `git-subdir` source with `url`, `path`, `ref`, and `sha`, invokes `find_marketplace_plugin`, and asserts that the resolved source is `MarketplacePluginSource::Git` with a normalized GitHub URL and the expected optional fields.

**Call relations**: This test targets the branch of marketplace resolution that converts remote source declarations rather than local paths. It is called directly by the test runner and validates the output of `find_marketplace_plugin`.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `find_marketplace_plugin_normalizes_github_shorthand_with_dot_git_suffix`  (lines 170–208)

```
fn find_marketplace_plugin_normalizes_github_shorthand_with_dot_git_suffix()
```

**Purpose**: Confirms that GitHub shorthand URLs already ending in `.git` are normalized to full HTTPS Git URLs without duplicating the suffix. It protects a subtle URL-rewrite edge case.

**Data flow**: Writes a marketplace manifest with `source.url` set to `openai/toolkit.git`, resolves the plugin, and asserts only on the `source` field of the result, expecting `https://github.com/openai/toolkit.git` with the configured subdirectory path.

**Call relations**: This test narrows in on URL normalization behavior inside marketplace resolution. It uses the same lookup entrypoint as other resolution tests but validates a specific normalization branch.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `find_marketplace_plugin_normalizes_relative_git_source_urls_to_marketplace_root`  (lines 211–256)

```
fn find_marketplace_plugin_normalizes_relative_git_source_urls_to_marketplace_root()
```

**Purpose**: Checks that relative git source URLs are resolved against the marketplace root directory for both slash styles. It ensures local bare repositories referenced from a marketplace file become absolute filesystem paths.

**Data flow**: Iterates over Unix- and Windows-style relative source strings, creates a repo plus a sibling `remotes/toolkit.git` directory, writes a marketplace manifest embedding the source string, resolves the plugin, and asserts that the resulting Git source URL equals the absolute path of the local remote repo.

**Call relations**: This test repeatedly invokes `find_marketplace_plugin` to cover path normalization across path separator variants. It complements the parent-traversal rejection test by validating the accepted relative-path case.

*Call graph*: calls 1 internal fn (try_from); 5 external calls (assert_eq!, format!, create_dir_all, write, tempdir).


##### `normalize_relative_git_plugin_source_url_rejects_parent_traversal`  (lines 259–281)

```
fn normalize_relative_git_plugin_source_url_rejects_parent_traversal()
```

**Purpose**: Verifies that relative git source URLs containing parent traversal are rejected with a marketplace-file-specific error. It protects against escaping the marketplace root.

**Data flow**: For several traversal spellings, it constructs an absolute marketplace path without needing a real file, calls `normalize_relative_git_plugin_source_url`, captures the error, and compares its string form to the expected validation message.

**Call relations**: Unlike most tests here, this one targets the lower-level URL normalization helper directly rather than full marketplace lookup. It exists to pin the exact validation failure path used by higher-level resolution.

*Call graph*: calls 1 internal fn (try_from); 2 external calls (assert_eq!, tempdir).


##### `find_marketplace_plugin_skips_root_equivalent_git_subdir_paths`  (lines 284–321)

```
fn find_marketplace_plugin_skips_root_equivalent_git_subdir_paths()
```

**Purpose**: Ensures that `git-subdir` entries whose `path` collapses to the repository root are treated as invalid and therefore not found. This prevents root-equivalent subdirectory declarations from being accepted as plugin entries.

**Data flow**: Loops over root-equivalent path strings such as `.`, `./`, and `plugins/..`, writes each into a marketplace manifest, calls `find_marketplace_plugin`, and asserts that lookup fails with the standard plugin-not-found message.

**Call relations**: This test exercises filtering behavior inside marketplace parsing: the plugin entry is present in JSON but omitted from the effective plugin set. It validates that lookup reports absence rather than a lower-level parse error.

*Call graph*: calls 1 internal fn (try_from); 5 external calls (assert_eq!, format!, create_dir_all, write, tempdir).


##### `find_marketplace_plugin_reports_missing_plugin`  (lines 324–345)

```
fn find_marketplace_plugin_reports_missing_plugin()
```

**Purpose**: Checks the user-facing error when a marketplace exists but contains no matching plugin entry. It pins the marketplace-qualified not-found message.

**Data flow**: Creates an empty marketplace manifest, calls `find_marketplace_plugin` with a missing plugin name, and asserts on the returned error string.

**Call relations**: This is the simplest negative lookup case and serves as the expected fallback outcome for several filtering scenarios tested elsewhere in the file.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `list_marketplaces_supports_alternate_manifest_layout`  (lines 348–421)

```
fn list_marketplaces_supports_alternate_manifest_layout()
```

**Purpose**: Verifies that marketplace listing discovers an alternate-layout marketplace and also reads plugin interface metadata from an alternate-layout plugin manifest. It confirms end-to-end support for the `.claude-plugin` layout.

**Data flow**: Creates a repo, writes an alternate plugin manifest with interface display name, writes an alternate marketplace manifest referencing that plugin, calls `list_marketplaces_with_home`, extracts `.marketplaces`, and asserts the exact `Marketplace` and nested `MarketplacePlugin` values including `PluginManifestInterface`.

**Call relations**: This test combines both helper fixtures and exercises the listing path rather than direct lookup. It validates that listing enriches plugin entries with manifest-derived interface data when discoverable.

*Call graph*: calls 3 internal fn (write_alternate_marketplace, write_alternate_plugin_manifest, try_from); 3 external calls (assert_eq!, create_dir_all, tempdir).


##### `list_marketplaces_includes_plugins_without_discoverable_manifest`  (lines 424–472)

```
fn list_marketplaces_includes_plugins_without_discoverable_manifest()
```

**Purpose**: Checks that listing still includes marketplace plugins even when no plugin manifest can be found at the referenced local path. The plugin remains visible but without interface metadata.

**Data flow**: Creates a repo and alternate marketplace manifest pointing at a nonexistent plugin directory, calls `list_marketplaces_with_home`, and asserts that the resulting marketplace contains the plugin with `interface: None` and the expected absolute local source path.

**Call relations**: This test covers the non-fatal manifest-discovery miss path in marketplace listing. It contrasts with the alternate-layout manifest test, showing that missing manifests do not remove the plugin entry.

*Call graph*: calls 2 internal fn (write_alternate_marketplace, try_from); 3 external calls (assert_eq!, create_dir_all, tempdir).


##### `list_marketplaces_prefers_first_supported_manifest_layout`  (lines 475–523)

```
fn list_marketplaces_prefers_first_supported_manifest_layout()
```

**Purpose**: Ensures that when both supported marketplace manifest layouts exist in one repo, listing chooses the first supported layout rather than returning both. It locks down precedence rules.

**Data flow**: Creates a repo with both `.agents/plugins/marketplace.json` and `.claude-plugin/marketplace.json`, calls `list_marketplaces_with_home`, and asserts that exactly one marketplace is returned and that it corresponds to the `.agents/plugins` manifest.

**Call relations**: This test targets repository scanning logic inside marketplace listing. It verifies layout precedence rather than plugin parsing details.

*Call graph*: calls 2 internal fn (write_alternate_marketplace, try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `list_marketplaces_supports_explicit_api_marketplace_manifest_path`  (lines 526–579)

```
fn list_marketplaces_supports_explicit_api_marketplace_manifest_path()
```

**Purpose**: Verifies that listing accepts an explicit marketplace manifest file path as an input root, even when it is not one of the default discovered filenames. This supports API-driven callers that already know the manifest location.

**Data flow**: Creates `.agents/plugins/api_marketplace.json`, passes a slice containing that exact `AbsolutePathBuf` to `list_marketplaces_with_home`, and asserts the returned marketplace and plugin source path.

**Call relations**: This test exercises the branch where the input root is itself a manifest path rather than a repo root. It confirms that listing bypasses normal repo discovery and loads the specified file directly.

*Call graph*: calls 1 internal fn (try_from); 5 external calls (assert_eq!, create_dir_all, write, from_ref, tempdir).


##### `list_marketplaces_returns_home_and_repo_marketplaces`  (lines 582–723)

```
fn list_marketplaces_returns_home_and_repo_marketplaces()
```

**Purpose**: Checks that listing can return both home-level and repo-level marketplaces, even when they share the same marketplace name. It also verifies that plugin source paths are rooted relative to each marketplace file independently.

**Data flow**: Creates separate home and repo marketplace manifests with overlapping and distinct plugin names, calls `list_marketplaces_with_home` with the repo root and `Some(home_root)`, and asserts that two `Marketplace` entries are returned in order with correctly rooted local plugin paths.

**Call relations**: This test covers multi-source aggregation in the listing API. It demonstrates that same-named marketplaces are preserved as separate entries rather than merged.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `list_marketplaces_keeps_distinct_entries_for_same_name`  (lines 726–833)

```
fn list_marketplaces_keeps_distinct_entries_for_same_name()
```

**Purpose**: Verifies that marketplaces with the same `name` but different filesystem locations remain distinct in listing results, and that direct lookup against one manifest resolves that manifest's plugin entry. It protects against accidental cross-marketplace conflation.

**Data flow**: Creates home and repo marketplace manifests with identical names and plugin names but different local paths, lists marketplaces and asserts both entries remain separate, then calls `find_marketplace_plugin` on the repo manifest and asserts it resolves to the repo-local path.

**Call relations**: This test bridges listing and direct lookup behavior. It confirms that listing preserves duplicates by path while lookup remains scoped to the manifest file supplied by the caller.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `list_marketplaces_dedupes_multiple_roots_in_same_repo`  (lines 836–894)

```
fn list_marketplaces_dedupes_multiple_roots_in_same_repo()
```

**Purpose**: Ensures that passing multiple roots inside the same Git repository does not duplicate the discovered marketplace. It validates repo-level deduplication during scanning.

**Data flow**: Creates a repo root and a nested project path inside it, writes one marketplace at the repo root, calls `list_marketplaces_with_home` with both absolute roots, and asserts that only one marketplace entry is returned.

**Call relations**: This test targets root normalization and deduplication in the listing orchestration. It differs from same-name tests by proving dedupe is based on shared repo discovery, not marketplace name.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `list_marketplaces_reads_marketplace_display_name`  (lines 897–936)

```
fn list_marketplaces_reads_marketplace_display_name()
```

**Purpose**: Checks that marketplace-level interface metadata is parsed and exposed, specifically the display name. It pins the mapping from manifest JSON to `MarketplaceInterface`.

**Data flow**: Writes a marketplace manifest containing an `interface.displayName`, lists marketplaces, and asserts that the first marketplace's `interface` field equals `Some(MarketplaceInterface { display_name: ... })`.

**Call relations**: This test focuses on marketplace metadata enrichment during listing rather than plugin-level fields. It is a narrow assertion over one parsed field.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `list_marketplaces_skips_invalid_plugins_but_keeps_marketplace`  (lines 939–995)

```
fn list_marketplaces_skips_invalid_plugins_but_keeps_marketplace()
```

**Purpose**: Verifies partial tolerance when a marketplace file is valid JSON but contains an invalid plugin entry. The marketplace remains in results while the bad plugin is omitted.

**Data flow**: Creates one valid and one invalid marketplace, where the invalid plugin uses a malformed local path lacking `./`, calls `list_marketplaces_with_home`, and asserts that both marketplaces are returned but the invalid marketplace has an empty `plugins` vector.

**Call relations**: This test exercises per-plugin validation failure handling inside listing. It contrasts with malformed marketplace JSON, which is reported separately as a load error.

*Call graph*: calls 1 internal fn (try_from); 5 external calls (assert!, assert_eq!, create_dir_all, write, tempdir).


##### `list_marketplaces_skips_plugins_with_invalid_names_but_keeps_marketplace`  (lines 998–1058)

```
fn list_marketplaces_skips_plugins_with_invalid_names_but_keeps_marketplace()
```

**Purpose**: Checks that plugins with invalid names are filtered out during listing without discarding the containing marketplace. It protects plugin-name validation behavior.

**Data flow**: Writes a marketplace with one valid plugin name and one invalid dotted name, lists marketplaces, and asserts that only the valid plugin remains in the resulting `Marketplace`.

**Call relations**: This test covers another plugin-level validation branch in listing, parallel to invalid source-path filtering.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `list_marketplaces_reports_marketplace_load_errors`  (lines 1061–1111)

```
fn list_marketplaces_reports_marketplace_load_errors()
```

**Purpose**: Verifies that malformed marketplace files are excluded from the successful marketplace list and instead surfaced in the returned `errors` collection. It pins the partial-success contract of the listing API.

**Data flow**: Creates one valid marketplace and one invalid JSON file, calls `list_marketplaces_with_home`, then asserts that exactly one marketplace was loaded, one error was recorded, the error path matches the invalid file, and the message mentions an invalid marketplace file.

**Call relations**: This test targets top-level marketplace parse failure handling, complementing tests that cover plugin-level failures which do not populate the `errors` list.

*Call graph*: calls 1 internal fn (try_from); 5 external calls (assert!, assert_eq!, create_dir_all, write, tempdir).


##### `list_marketplaces_keeps_remote_and_local_plugin_sources`  (lines 1114–1211)

```
fn list_marketplaces_keeps_remote_and_local_plugin_sources()
```

**Purpose**: Checks that listing preserves heterogeneous plugin source kinds from one marketplace: local path, URL-based remote, and `git-subdir`. It validates source normalization across all supported forms.

**Data flow**: Writes an alternate marketplace manifest containing three plugin entries with different source encodings, lists marketplaces, and asserts the exact `MarketplacePluginSource` values for each plugin, including normalized GitHub URLs and optional git metadata.

**Call relations**: This test exercises source parsing in the listing path rather than direct lookup. It ensures listing does not collapse or misclassify remote source variants.

*Call graph*: calls 2 internal fn (write_alternate_marketplace, try_from); 3 external calls (assert_eq!, create_dir_all, tempdir).


##### `list_marketplaces_resolves_plugin_interface_paths_to_absolute`  (lines 1214–1301)

```
fn list_marketplaces_resolves_plugin_interface_paths_to_absolute()
```

**Purpose**: Verifies that plugin interface asset paths from a local plugin manifest are resolved to absolute paths and that marketplace policy fields, including products, are parsed correctly. It also confirms marketplace category overrides the manifest category in the resulting interface.

**Data flow**: Creates a repo and plugin root, writes a marketplace manifest with explicit `policy` and `category`, writes a plugin manifest with interface fields and `./assets/...` paths, lists marketplaces, and asserts installation/authentication policies, parsed `Product` values, and absolute `composer_icon`, `logo`, and `screenshots` paths in the resulting `PluginManifestInterface`.

**Call relations**: This test covers one of the richest enrichment paths in listing: combining marketplace policy/category data with plugin-manifest interface data and path normalization.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `list_marketplaces_ignores_legacy_top_level_policy_fields`  (lines 1304–1345)

```
fn list_marketplaces_ignores_legacy_top_level_policy_fields()
```

**Purpose**: Checks that deprecated top-level `installPolicy` and `authPolicy` fields are ignored in favor of current defaults when no nested `policy` object is present. It prevents legacy fields from affecting behavior.

**Data flow**: Writes a marketplace manifest containing only legacy top-level policy fields, lists marketplaces, and asserts that the resulting plugin policy remains `Available` / `OnInstall` with no products restriction.

**Call relations**: This test targets backward-compatibility parsing rules in marketplace listing, specifically that unsupported legacy fields are intentionally inert.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `list_marketplaces_ignores_plugin_interface_assets_without_dot_slash`  (lines 1348–1422)

```
fn list_marketplaces_ignores_plugin_interface_assets_without_dot_slash()
```

**Purpose**: Verifies that plugin interface asset references are only accepted when written as explicit relative `./...` paths. Bare relative paths and absolute paths are ignored rather than normalized.

**Data flow**: Creates a plugin manifest whose `composerIcon`, `logo`, and `screenshots` use invalid path forms, lists marketplaces, and asserts that the resulting `PluginManifestInterface` keeps textual metadata but sets asset fields to `None` or empty vectors while policy defaults remain unchanged.

**Call relations**: This test covers a security and consistency rule in manifest path handling. It complements the absolute-resolution test by showing which path syntaxes are rejected.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `find_marketplace_plugin_skips_invalid_local_paths`  (lines 1425–1457)

```
fn find_marketplace_plugin_skips_invalid_local_paths()
```

**Purpose**: Ensures that a marketplace plugin entry with an invalid local path escaping upward is filtered out so lookup reports the plugin as absent. It validates local-path safety checks.

**Data flow**: Writes a marketplace manifest whose local source path is `../plugin-1`, calls `find_marketplace_plugin`, and asserts the standard plugin-not-found error string.

**Call relations**: This test mirrors the git parent-traversal rejection case but through full plugin lookup for local sources. It confirms invalid entries are skipped rather than returned with unsafe paths.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `find_marketplace_plugin_uses_first_duplicate_entry`  (lines 1460–1501)

```
fn find_marketplace_plugin_uses_first_duplicate_entry()
```

**Purpose**: Checks deterministic behavior when a marketplace contains duplicate plugin names: lookup returns the first matching entry. It pins duplicate-resolution order.

**Data flow**: Writes a marketplace manifest with two `local-plugin` entries pointing at different paths, resolves the plugin, and asserts that the source path corresponds to the first entry.

**Call relations**: This test targets ordering semantics inside `find_marketplace_plugin`. It complements listing tests that preserve duplicates at the marketplace level.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `find_installable_marketplace_plugin_rejects_disallowed_product`  (lines 1504–1540)

```
fn find_installable_marketplace_plugin_rejects_disallowed_product()
```

**Purpose**: Verifies that installable-plugin lookup enforces product restrictions from marketplace policy. A plugin restricted to `CHATGPT` is rejected for `ATLAS` installation.

**Data flow**: Writes a marketplace manifest with `policy.products` containing only `CHATGPT`, calls `find_installable_marketplace_plugin` with `Some(Product::Atlas)`, and asserts the marketplace-qualified not-available-for-install error.

**Call relations**: This test exercises the installability wrapper around marketplace lookup, specifically the product-gating branch after plugin resolution.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `find_marketplace_plugin_allows_missing_products_field`  (lines 1543–1573)

```
fn find_marketplace_plugin_allows_missing_products_field()
```

**Purpose**: Checks that an empty `policy` object with no `products` field does not block normal plugin resolution. Missing products means unrestricted availability rather than denial.

**Data flow**: Writes a marketplace manifest with `policy: {}`, resolves the plugin with `find_marketplace_plugin`, and asserts that the resulting `PluginId` key is constructed successfully.

**Call relations**: This test covers the permissive default branch for product policy and contrasts with the explicit-empty-products rejection case.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `find_installable_marketplace_plugin_rejects_explicit_empty_products`  (lines 1576–1612)

```
fn find_installable_marketplace_plugin_rejects_explicit_empty_products()
```

**Purpose**: Verifies that an explicit empty `products` list means the plugin is not installable for any product. This distinguishes omitted restrictions from an intentional deny-all configuration.

**Data flow**: Writes a marketplace manifest with `policy.products: []`, calls `find_installable_marketplace_plugin` for `Product::Codex`, and asserts the not-available-for-install error string.

**Call relations**: This test complements both the missing-products permissive case and the disallowed-product case, pinning the semantics of an explicitly empty allowlist.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


### `core-plugins/src/remote_tests.rs`

`test` · `test execution`

This file is a pure test module for the remote plugin subsystem. It exercises two main behaviors exposed by the parent module: construction of a remote marketplace from directory and installed plugin sources, and conversion of a `RecommendedPluginsResponse` into a `RecommendedPluginsMode`. To keep assertions concrete, it includes two small fixture builders: `directory_plugin`, which constructs a fully populated `RemotePluginDirectoryItem` with stable defaults for scope, policies, availability, release metadata, interface fields, skills, and MCP servers; and `item`, which creates a minimal `RecommendedPluginItem` with a synthetic `id` and display name.

The tests cover several non-obvious invariants. Marketplace assembly must preserve the original directory ordering and append installed-only plugins afterward rather than re-sorting. Recommended-plugin mode selection treats `enabled: false`, missing `enabled`, and `enabled: null` as legacy behavior, while `enabled: true` activates endpoint-driven recommendations. Endpoint payloads are expected to deserialize only when each plugin includes a remote installation identity (`id`). Once enabled, recommendation processing is expected to reject malformed remote plugin IDs, ignore disabled or non-installable entries, deduplicate duplicates, sort deterministically, cap the result set at `MAX_RECOMMENDED_PLUGINS`, truncate overlong visible fields to the configured maxima, and normalize `app_ids` by dropping empties and duplicates while preserving the original remote plugin identifier for installation.

#### Function details

##### `build_remote_marketplace_preserves_directory_order_and_appends_installed_only_plugins`  (lines 5–34)

```
fn build_remote_marketplace_preserves_directory_order_and_appends_installed_only_plugins()
```

**Purpose**: Verifies that marketplace construction keeps directory-provided plugins in their original sequence and appends plugins that exist only in the installed set. It asserts the resulting `remote_plugin_id` list exactly matches the expected merged order.

**Data flow**: Builds two `RemotePluginDirectoryItem` fixtures for the directory and one `RemotePluginInstalledItem` wrapping another directory-style plugin for the installed list, then passes marketplace identifiers plus `include_installed_only = true` into `build_remote_marketplace`. It unwraps the nested `Result<Option<_>>`, extracts `marketplace.plugins`, maps each plugin to `remote_plugin_id`, collects into a `Vec`, and compares that vector to `["plugin-z", "plugin-m", "plugin-a"]`.

**Call relations**: This is a top-level `#[test]` entry invoked by the Rust test runner. It directly exercises `build_remote_marketplace` under the specific condition where installed-only plugins should be included, and does not delegate beyond fixture creation and assertion.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `directory_plugin`  (lines 36–78)

```
fn directory_plugin(id: &str, name: &str) -> RemotePluginDirectoryItem
```

**Purpose**: Creates a canonical `RemotePluginDirectoryItem` fixture with caller-supplied `id` and display name while filling every other field with stable defaults. It gives tests a concise way to construct valid remote directory entries without repeating the full nested release/interface structure.

**Data flow**: Accepts `id: &str` and `name: &str`, converts them to owned `String`s, and returns a `RemotePluginDirectoryItem`. The returned value sets `scope` to `RemotePluginScope::Global`, leaves discoverability and creator/share metadata as `None`, uses `PluginInstallPolicy::Available`, `PluginAuthPolicy::OnUse`, and `PluginAvailability::Available`, and embeds a `RemotePluginReleaseResponse` whose `display_name` mirrors `name` while all optional URLs, manifests, descriptions, capabilities, skills, MCP servers, and collections are empty or `None`.

**Call relations**: This helper is used by marketplace-ordering tests to supply valid directory and installed plugin payloads. It is not part of production flow; its role is to isolate fixture setup so tests can focus on behavior under assertion.

*Call graph*: 2 external calls (new, new).


##### `item`  (lines 79–90)

```
fn item(name: &str, display_name: &str) -> RecommendedPluginItem
```

**Purpose**: Builds a minimal `RecommendedPluginItem` fixture from a logical plugin name and display name. It standardizes test inputs by generating the remote install identity in the expected `plugin_<name>` format.

**Data flow**: Takes `name: &str` and `display_name: &str`, formats the `id` as `plugin_{name}`, copies `name` into an owned `String`, leaves `status` and `installation_policy` as `None`, and returns a `RecommendedPluginItem` whose nested `RecommendedPluginRelease` contains the provided display name and an empty `app_ids` list.

**Call relations**: This helper is called by `recommended_plugins_are_validated_deduplicated_sorted_and_capped` to generate a large recommendation set with predictable identities and names. It exists only to simplify test data construction.

*Call graph*: called by 1 (recommended_plugins_are_validated_deduplicated_sorted_and_capped); 2 external calls (new, format!).


##### `recommended_plugins_enabled_flag_selects_endpoint_or_legacy_mode`  (lines 93–127)

```
fn recommended_plugins_enabled_flag_selects_endpoint_or_legacy_mode()
```

**Purpose**: Checks the mode-selection contract for recommended plugins based on the optional `enabled` flag in the response payload. It confirms that only an explicit `true` enables endpoint mode; `false`, missing, or `null` all fall back to legacy mode.

**Data flow**: Deserializes several JSON values into `RecommendedPluginsResponse`: one with `enabled: false`, two variants with no effective enablement (`plugins` only and `enabled: null`), and one with `enabled: true`. Each response is passed to `recommended_plugins_mode`, and the returned enum is compared against either `RecommendedPluginsMode::Legacy` or `RecommendedPluginsMode::Endpoint { plugins: Vec::new() }`.

**Call relations**: This test is invoked by the test runner and targets the branch point inside `recommended_plugins_mode` that interprets the endpoint feature flag. It uses serde deserialization to mimic real wire-format inputs before handing control to the production conversion logic.

*Call graph*: 3 external calls (assert_eq!, from_value, json!).


##### `recommended_plugins_require_remote_install_identity`  (lines 130–140)

```
fn recommended_plugins_require_remote_install_identity()
```

**Purpose**: Ensures endpoint-style recommended plugin payloads cannot deserialize when a plugin omits its remote installation identity field. The test protects the invariant that recommendation entries must carry the remote plugin `id` needed for installation.

**Data flow**: Constructs JSON for a `RecommendedPluginsResponse` with `enabled: true` and a plugin object containing `name` and `release.display_name` but no `id`, then attempts `serde_json::from_value::<RecommendedPluginsResponse>`. It asserts that the result is an error rather than a partially accepted response.

**Call relations**: This top-level test validates the schema boundary before `recommended_plugins_mode` is even reached. It is specifically concerned with deserialization requirements imposed by the response model used by the recommendation pipeline.

*Call graph*: 2 external calls (assert!, json!).


##### `recommended_plugins_are_validated_deduplicated_sorted_and_capped`  (lines 143–198)

```
fn recommended_plugins_are_validated_deduplicated_sorted_and_capped()
```

**Purpose**: Exercises the full recommendation-cleanup pipeline on a noisy endpoint payload containing too many entries, duplicates, malformed IDs, disabled plugins, and non-installable plugins. It verifies that the surviving recommendations are normalized into a deterministic, bounded list.

**Data flow**: Builds a reversed vector of 53 fixture items named `plugin-00` through `plugin-52`, then appends: a duplicate `plugin-00`, an invalid `not/a/plugin`, one item marked `DisabledByAdmin`, and one item with `PluginInstallPolicy::NotAvailable`. It wraps that vector in `RecommendedPluginsResponse { enabled: Some(true), plugins }`, passes it to `recommended_plugins_mode`, pattern-matches the result as `RecommendedPluginsMode::Endpoint { plugins }` or panics otherwise, then asserts the list length equals `MAX_RECOMMENDED_PLUGINS` and that the first and last normalized `RecommendedPlugin` values are the expected sorted/capped boundary entries with `config_id`, `remote_plugin_id`, `display_name`, and empty `app_connector_ids`.

**Call relations**: This test is the broadest behavioral check in the file. It is invoked by the test runner, uses `item` repeatedly to generate baseline fixtures, then drives `recommended_plugins_mode` through validation, filtering, deduplication, sorting, and truncation branches in one scenario.

*Call graph*: calls 1 internal fn (item); 3 external calls (new, assert_eq!, panic!).


##### `recommended_plugins_bound_model_visible_fields`  (lines 201–223)

```
fn recommended_plugins_bound_model_visible_fields()
```

**Purpose**: Verifies that recommendation conversion enforces maximum lengths on user-visible fields. It confirms overlong plugin names are rejected and overlong display names are truncated to the configured bound.

**Data flow**: Creates an overlong logical name using `MAX_RECOMMENDED_PLUGIN_NAME_LEN + 1` characters and an overlong display name using `MAX_RECOMMENDED_PLUGIN_DISPLAY_NAME_LEN + 1` characters. It feeds two fixture items into `recommended_plugins_mode`: one whose name exceeds the allowed bound and one named `bounded` whose display name is too long. The returned mode is asserted to be `Endpoint` with exactly one `RecommendedPlugin`, whose `config_id` and `remote_plugin_id` derive from `bounded`, whose `display_name` is truncated to exactly `MAX_RECOMMENDED_PLUGIN_DISPLAY_NAME_LEN` characters, and whose connector list is empty.

**Call relations**: This test is called by the test runner and targets the field-sanitization path inside `recommended_plugins_mode`. It demonstrates that visible-field bounds are enforced asymmetrically: invalid names drop the item, while display names are clipped and retained.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `recommended_plugins_preserve_install_identity_and_normalize_app_ids`  (lines 226–257)

```
fn recommended_plugins_preserve_install_identity_and_normalize_app_ids()
```

**Purpose**: Checks that recommendation conversion keeps the original remote plugin installation identity while cleaning up connector application IDs. It ensures empty and duplicate `app_ids` are removed without altering the plugin's remote `id`.

**Data flow**: Constructs a single `RecommendedPluginItem` with `id = "plugin_connector_sample"`, `name = "sample"`, available status/policy, display name `Sample`, and `app_ids` containing `connector_one`, an empty string, `connector_two`, and a duplicate `connector_one`. After passing `RecommendedPluginsResponse { enabled: Some(true), plugins: vec![...] }` to `recommended_plugins_mode`, it asserts the result is `Endpoint` with one `RecommendedPlugin` whose `config_id` is `sample@openai-curated-remote`, whose `remote_plugin_id` remains `plugin_connector_sample`, whose display name is unchanged, and whose `app_connector_ids` are normalized to `["connector_one", "connector_two"]`.

**Call relations**: This test is run directly by the test harness and focuses on the normalization branch of `recommended_plugins_mode` that transforms nested release `app_ids`. It demonstrates that installation identity and connector cleanup are separate concerns in the conversion logic.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `recommended_plugins_ignore_invalid_remote_plugin_ids`  (lines 260–281)

```
fn recommended_plugins_ignore_invalid_remote_plugin_ids()
```

**Purpose**: Confirms that endpoint recommendations with malformed remote plugin identifiers are silently discarded rather than propagated. It protects downstream installation/config generation from invalid remote IDs.

**Data flow**: Builds a `RecommendedPluginsResponse` with `enabled: Some(true)` and one `RecommendedPluginItem` whose `id` is the invalid string `not/a/plugin`, with otherwise minimal fields. It passes that response to `recommended_plugins_mode` and asserts the result is `RecommendedPluginsMode::Endpoint { plugins: Vec::new() }`.

**Call relations**: This test is invoked by the test runner and isolates the invalid-ID filtering path inside `recommended_plugins_mode`. Unlike the deserialization test, the payload is structurally valid JSON/model data, so the rejection happens during recommendation validation rather than parsing.

*Call graph*: 2 external calls (assert_eq!, vec!).


### Plugin lifecycle and discovery flows
This group moves from startup synchronization and remote sharing into manager-level orchestration, discoverability, routing, and the core-facing plugin adapters and mention/render behavior.

### `core-plugins/src/startup_sync_tests.rs`

`test` · `request handling`

This test module exercises the startup sync logic exposed by the parent module (`super::*`) against real temporary directories, fake git binaries, and mocked HTTP endpoints. Its helpers build on-disk curated plugin snapshots under `.tmp/plugins`, write `.tmp/plugins.sha`, and synthesize marketplace/plugin manifests so tests can verify exact repository layouts rather than only return values. On Unix, it also creates executable shell scripts to impersonate `git`, letting tests inspect command sequencing, simulate failures, and prove concurrency behavior such as serialized fetches with repeated `ls-remote` checks.

The HTTP-facing helpers mount `wiremock` routes for GitHub repository metadata, branch ref lookup, zipball download, and a separate export-archive API. Two async wrappers run the blocking sync functions inside `tokio::task::spawn_blocking`, matching production usage while keeping tests async-friendly. Archive constructors generate in-memory zip payloads for both GitHub-style zipballs and backup exports that include `.git/HEAD` and refs.

The tests focus on invariants that are easy to miss: the curated repo always lives at `codex_home/.tmp/plugins`; SHA files are trimmed; stale `plugins-clone-*` temp directories are removed selectively; sync avoids `git clone`; staged temp directories are cleaned after fetch/extract failures; invalid staged content must not replace an existing valid snapshot; unchanged SHAs skip downloads; and export-archive fallback is allowed only when no prior snapshot exists. Several tests also validate path-safety rules when reading a git SHA from an extracted backup archive.

#### Function details

##### `write_file`  (lines 19–22)

```
fn write_file(path: &Path, contents: &str)
```

**Purpose**: Creates parent directories for a target file and writes the provided string contents. It is the low-level fixture helper used to materialize manifests and SHA marker files in temporary test repositories.

**Data flow**: Takes a `&Path` and `&str`; derives the parent directory from the path, creates that directory tree, then writes the string bytes to the file. It returns no value and mutates the filesystem at the requested location.

**Call relations**: This helper is invoked by `write_curated_plugin`, `write_curated_plugin_sha`, and `write_openai_curated_marketplace` so those higher-level fixture builders can focus on repository structure and JSON content instead of directory creation.

*Call graph*: called by 3 (write_curated_plugin, write_curated_plugin_sha, write_openai_curated_marketplace); 3 external calls (parent, create_dir_all, write).


##### `write_curated_plugin`  (lines 24–30)

```
fn write_curated_plugin(root: &Path, plugin_name: &str)
```

**Purpose**: Writes a minimal curated plugin manifest for one plugin under `plugins/<name>/.codex-plugin/plugin.json`. The manifest contains only the plugin `name`, which is sufficient for these sync validation tests.

**Data flow**: Receives a repository root path and plugin name, constructs the plugin subdirectory path, formats a tiny JSON object with that name, and delegates the actual file creation to `write_file`. It returns nothing and adds one plugin manifest to disk.

**Call relations**: It is only called from `write_openai_curated_marketplace`, which uses it to keep the marketplace listing and plugin directories in sync for multi-plugin test fixtures.

*Call graph*: calls 1 internal fn (write_file); called by 1 (write_openai_curated_marketplace); 2 external calls (join, format!).


##### `write_openai_curated_marketplace`  (lines 32–62)

```
fn write_openai_curated_marketplace(root: &Path, plugin_names: &[&str])
```

**Purpose**: Builds a complete minimal curated repository fixture: `.agents/plugins/marketplace.json` plus one local plugin directory per listed plugin. The generated marketplace uses `source: local` entries pointing at `./plugins/<name>`.

**Data flow**: Accepts a root path and slice of plugin names, maps each name into a JSON marketplace entry, joins them into the `plugins` array, writes the marketplace manifest via `write_file`, then iterates the same names and calls `write_curated_plugin` for each. It returns nothing and populates a coherent curated snapshot on disk.

**Call relations**: Tests that need an existing valid snapshot call this helper before invoking sync, notably the incremental git-sync test and scenarios that verify preservation of an existing snapshot or suppression of export fallback.

*Call graph*: calls 2 internal fn (write_curated_plugin, write_file); called by 3 (sync_openai_plugins_repo_skips_export_archive_when_snapshot_exists, sync_openai_plugins_repo_via_git_preserves_existing_snapshot_on_validation_failure, sync_openai_plugins_repo_via_git_succeeds_with_local_rewritten_remote); 2 external calls (join, format!).


##### `write_curated_plugin_sha`  (lines 64–69)

```
fn write_curated_plugin_sha(codex_home: &Path)
```

**Purpose**: Creates the `.tmp/plugins.sha` marker file containing the fixed test SHA constant. It gives tests a simple way to simulate a previously synced curated snapshot.

**Data flow**: Takes `codex_home`, appends `.tmp/plugins.sha`, formats `TEST_CURATED_PLUGIN_SHA` with a trailing newline, and writes it through `write_file`. It returns nothing and updates the persisted sync SHA on disk.

**Call relations**: It is used by tests that start from an already-synced state, especially those checking that invalid updates do not overwrite the current snapshot and that export fallback is skipped when a snapshot already exists.

*Call graph*: calls 1 internal fn (write_file); called by 2 (sync_openai_plugins_repo_skips_export_archive_when_snapshot_exists, sync_openai_plugins_repo_via_git_preserves_existing_snapshot_on_validation_failure); 2 external calls (join, format!).


##### `has_plugins_clone_dirs`  (lines 71–84)

```
fn has_plugins_clone_dirs(codex_home: &Path) -> bool
```

**Purpose**: Detects whether temporary staged clone directories named `plugins-clone-*` remain under `.tmp`. Tests use it to assert cleanup after success and after failure paths.

**Data flow**: Given `codex_home`, it reads `codex_home/.tmp`; if that directory cannot be read it immediately returns `false`. Otherwise it scans entries, keeps only directories, extracts each filename as UTF-8, and returns `true` if any name starts with `plugins-clone-`.

**Call relations**: This helper is not itself called by other helpers; multiple tests query it after sync attempts to verify that staging directories are removed rather than leaked.

*Call graph*: 2 external calls (join, read_dir).


##### `write_executable_script`  (lines 87–98)

```
fn write_executable_script(path: &Path, contents: &str)
```

**Purpose**: Writes a shell script fixture and, on Unix, marks it executable. Tests use it to create fake `git` binaries that emulate success, failure, or specific command traces.

**Data flow**: It takes a script path and script body, writes the contents to disk, then reads metadata and updates permissions to mode `0o755`. It returns nothing and mutates both file contents and permissions.

**Call relations**: Unix-only tests call this helper before invoking sync so they can substitute a controlled `git` executable and observe how the sync logic reacts to command outputs and failures.

*Call graph*: called by 5 (concurrent_syncs_serialize_fetches_without_skipping_remote_checks, sync_openai_plugins_repo_falls_back_to_http_when_git_sync_fails, sync_openai_plugins_repo_via_git_cleans_up_staged_dir_on_fetch_failure, sync_openai_plugins_repo_via_git_preserves_existing_snapshot_on_validation_failure, sync_openai_plugins_repo_via_git_succeeds_with_local_rewritten_remote); 3 external calls (metadata, set_permissions, write).


##### `run_git`  (lines 101–114)

```
fn run_git(repo: &Path, args: &[&str]) -> std::process::Output
```

**Purpose**: Executes the real `git` command in a repository and asserts success, returning the captured process output. It is used to set up and mutate actual repositories for the end-to-end git sync test.

**Data flow**: Inputs are a repository path and argument slice; it spawns `git -C <repo> <args...>`, captures stdout/stderr, asserts the exit status is successful, and returns the resulting `std::process::Output`. It writes only through the external git process's effects on the repository.

**Call relations**: Only `sync_openai_plugins_repo_via_git_succeeds_with_local_rewritten_remote` uses this helper, because that test constructs a real work tree, commits content, creates a bare remote, pushes updates, and reads commit SHAs.

*Call graph*: called by 1 (sync_openai_plugins_repo_via_git_succeeds_with_local_rewritten_remote); 2 external calls (assert!, new).


##### `mount_github_repo_and_ref`  (lines 116–130)

```
async fn mount_github_repo_and_ref(server: &MockServer, sha: &str)
```

**Purpose**: Registers mock GitHub API responses for repository metadata and the default branch head SHA. This gives HTTP sync code enough information to discover the current curated plugins revision.

**Data flow**: It takes a `MockServer` and SHA string, mounts one `GET /repos/openai/plugins` response returning `{"default_branch":"main"}` and one `GET /repos/openai/plugins/git/ref/heads/main` response returning the supplied SHA. It returns no value and mutates the mock server's route table.

**Call relations**: HTTP-oriented tests call this before invoking sync so the production code can perform its normal remote SHA discovery flow without talking to real GitHub.

*Call graph*: called by 4 (sync_openai_plugins_repo_falls_back_to_http_when_git_is_unavailable, sync_openai_plugins_repo_falls_back_to_http_when_git_sync_fails, sync_openai_plugins_repo_skips_archive_download_when_sha_matches, sync_openai_plugins_repo_via_http_cleans_up_staged_dir_on_extract_failure); 5 external calls (given, new, format!, method, path).


##### `mount_github_zipball`  (lines 132–142)

```
async fn mount_github_zipball(server: &MockServer, sha: &str, bytes: Vec<u8>)
```

**Purpose**: Registers a mock GitHub zipball download endpoint for a specific commit SHA. It lets tests feed either a valid curated archive or intentionally invalid bytes into the HTTP sync path.

**Data flow**: Inputs are a `MockServer`, SHA, and raw zip bytes; it mounts `GET /repos/openai/plugins/zipball/<sha>` with `content-type: application/zip` and the provided body. It returns nothing and configures the mock server.

**Call relations**: Tests pair this with `mount_github_repo_and_ref` so the sync code first resolves the SHA and then downloads the corresponding archive.

*Call graph*: called by 3 (sync_openai_plugins_repo_falls_back_to_http_when_git_is_unavailable, sync_openai_plugins_repo_falls_back_to_http_when_git_sync_fails, sync_openai_plugins_repo_via_http_cleans_up_staged_dir_on_extract_failure); 5 external calls (given, new, format!, method, path).


##### `mount_export_archive`  (lines 144–164)

```
async fn mount_export_archive(server: &MockServer, bytes: Vec<u8>) -> String
```

**Purpose**: Sets up the backup export-archive API and file download endpoint, returning the API URL that sync should call. This supports tests for the non-GitHub fallback path.

**Data flow**: Given a `MockServer` and archive bytes, it constructs `<server>/backend-api/plugins/export/curated`, mounts that endpoint to return a JSON `download_url`, mounts `/files/curated-plugins.zip` to serve the bytes as a zip, and returns the export API URL string.

**Call relations**: Fallback tests call this helper when they want sync to bypass GitHub metadata/zipball retrieval and instead consume the backup archive flow.

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

**Purpose**: Async test wrapper around the blocking sync entrypoint that accepts custom git and HTTP endpoint overrides. It allows tokio tests to invoke the production sync logic without blocking the runtime.

**Data flow**: It takes `codex_home`, `git_binary`, `api_base_url`, and `backup_archive_api_url`, converts the string-like inputs into owned `String`s, moves them into `spawn_blocking`, calls `sync_openai_plugins_repo_with_transport_overrides`, awaits the join handle, and returns the inner `Result<String, String>`. It writes only whatever the sync function writes to disk.

**Call relations**: Most async sync tests use this wrapper because they need to point the sync logic at a fake git binary and/or `wiremock` server while preserving the exact production control path.

*Call graph*: called by 5 (sync_openai_plugins_repo_falls_back_to_export_archive_when_no_snapshot_exists, sync_openai_plugins_repo_falls_back_to_http_when_git_is_unavailable, sync_openai_plugins_repo_falls_back_to_http_when_git_sync_fails, sync_openai_plugins_repo_skips_archive_download_when_sha_matches, sync_openai_plugins_repo_skips_export_archive_when_snapshot_exists); 2 external calls (into, spawn_blocking).


##### `run_http_sync`  (lines 187–197)

```
async fn run_http_sync(
    codex_home: PathBuf,
    api_base_url: impl Into<String>,
) -> Result<String, String>
```

**Purpose**: Async wrapper around the blocking HTTP-only sync function. It is narrower than `run_sync_with_transport_overrides` and is used when a test wants to exercise the HTTP extraction path directly.

**Data flow**: It accepts `codex_home` and an API base URL, converts the URL into an owned string, runs `sync_openai_plugins_repo_via_http` inside `spawn_blocking`, awaits completion, and returns the sync result. Side effects are the filesystem changes performed by the sync implementation.

**Call relations**: Only the extract-failure test uses this helper, because that scenario specifically targets the HTTP zipball path rather than the transport-selection wrapper.

*Call graph*: called by 1 (sync_openai_plugins_repo_via_http_cleans_up_staged_dir_on_extract_failure); 2 external calls (into, spawn_blocking).


##### `assert_curated_gmail_repo`  (lines 199–206)

```
fn assert_curated_gmail_repo(repo_path: &Path)
```

**Purpose**: Asserts that a synced curated repository contains the expected marketplace manifest and Gmail plugin manifest. It is a compact postcondition check shared by several success-path tests.

**Data flow**: Given a repository path, it checks that `.agents/plugins/marketplace.json` and `plugins/gmail/.codex-plugin/plugin.json` both exist as files. It returns nothing and performs no writes.

**Call relations**: Success-path tests call this after sync completes to verify that the repository layout on disk matches the minimal curated archive fixture.

*Call graph*: called by 6 (concurrent_syncs_serialize_fetches_without_skipping_remote_checks, sync_openai_plugins_repo_falls_back_to_export_archive_when_no_snapshot_exists, sync_openai_plugins_repo_falls_back_to_http_when_git_is_unavailable, sync_openai_plugins_repo_falls_back_to_http_when_git_sync_fails, sync_openai_plugins_repo_via_git_preserves_existing_snapshot_on_validation_failure, sync_openai_plugins_repo_via_git_succeeds_with_local_rewritten_remote); 1 external calls (assert!).


##### `curated_plugins_repo_path_uses_codex_home_tmp_dir`  (lines 209–215)

```
fn curated_plugins_repo_path_uses_codex_home_tmp_dir()
```

**Purpose**: Verifies that the curated plugins repository location is always derived as `codex_home/.tmp/plugins`. This locks down the path convention used by the sync subsystem.

**Data flow**: The test creates a temporary directory, calls `curated_plugins_repo_path(tmp.path())`, and compares the result to `tmp.path().join(".tmp/plugins")`. It returns no value and only reads the computed path.

**Call relations**: This is a direct unit test of a path helper from the parent module, with no additional setup beyond a temporary root.

*Call graph*: 2 external calls (assert_eq!, tempdir).


##### `read_curated_plugins_sha_reads_trimmed_sha_file`  (lines 218–227)

```
fn read_curated_plugins_sha_reads_trimmed_sha_file()
```

**Purpose**: Checks that reading the persisted curated SHA strips trailing newlines. This ensures SHA comparisons are performed against normalized values.

**Data flow**: It creates `.tmp/plugins.sha` containing `abc123\n`, invokes `read_curated_plugins_sha`, and asserts the returned `Option<&str>` is `Some("abc123")`. The test writes fixture files and then reads the parsed result.

**Call relations**: This test directly targets the SHA-reading helper from the parent module and validates a small but important normalization behavior.

*Call graph*: 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `remove_stale_curated_repo_temp_dirs_removes_only_matching_directories`  (lines 231–270)

```
fn remove_stale_curated_repo_temp_dirs_removes_only_matching_directories()
```

**Purpose**: Confirms that stale temporary clone directories are deleted based on age and naming pattern, while fresh clone directories and unrelated directories remain. It specifically exercises the cleanup policy around `plugins-clone-*` staging directories.

**Data flow**: The test creates `.tmp/plugins-clone-stale`, `.tmp/plugins-clone-fresh`, and `.tmp/plugins-cache`, adjusts mtimes so only the first exceeds `CURATED_PLUGINS_STALE_TEMP_DIR_MAX_AGE`, calls `remove_stale_curated_repo_temp_dirs`, and then asserts existence/nonexistence of each directory. It mutates filesystem timestamps and directory trees, then reads them back.

**Call relations**: This Unix-only test directly probes the stale-temp-dir cleanup helper from the parent module, isolating its matching and age logic from the rest of sync.

*Call graph*: 4 external calls (from_secs, assert!, create_dir_all, tempdir).


##### `concurrent_syncs_serialize_fetches_without_skipping_remote_checks`  (lines 274–367)

```
fn concurrent_syncs_serialize_fetches_without_skipping_remote_checks()
```

**Purpose**: Tests that two simultaneous sync attempts both perform remote SHA checks, but only one performs the expensive fetch/update work. It validates synchronization around shared curated repo state without suppressing freshness checks.

**Data flow**: The test creates a fake `git` script that logs invocations, sleeps during `ls-remote`, and simulates `init`, `fetch`, `reset`, `clean`, and `rev-parse`; then it launches two threads gated by a `Barrier`, each calling `sync_openai_plugins_repo_with_transport_overrides`. After both return `Ok(sha)`, it inspects the repo contents, persisted SHA, and invocation log to count `ls-remote` and `fetch` calls and ensure no `clone` occurred.

**Call relations**: This Unix-only test drives the full transport-selection sync entrypoint under contention. Its assertions demonstrate the intended call flow: both callers independently check the remote, one caller performs the update, and the other observes the updated local state.

*Call graph*: calls 2 internal fn (assert_curated_gmail_repo, write_executable_script); 8 external calls (new, assert!, assert_eq!, format!, read_to_string, scope, new, tempdir).


##### `sync_openai_plugins_repo_via_git_succeeds_with_local_rewritten_remote`  (lines 371–579)

```
fn sync_openai_plugins_repo_via_git_succeeds_with_local_rewritten_remote()
```

**Purpose**: End-to-end test of successful git-based sync, including initial fetch into an empty curated repo, incremental update to a newer commit, and no-op behavior when the remote SHA is unchanged. It also verifies that URL rewriting can redirect the hardcoded GitHub remote to a local bare repository.

**Data flow**: The test builds a real work repository with marketplace and Gmail plugin files, commits it, clones it as a bare remote, captures the commit SHA, writes a wrapper `git` script that injects a custom global config with `insteadOf = https://github.com/`, and calls `sync_openai_plugins_repo_via_git`. It then mutates the work repo to add `linear`, commits and pushes, syncs again, checks the updated SHA and files, inspects invocation logs for `fetch`/`init` patterns and absence of `clone`, and finally runs a third sync to confirm unchanged remotes trigger `ls-remote` but no fetch.

**Call relations**: This is the most comprehensive git-path test in the file. It exercises the parent module's git sync implementation across first sync, incremental sync, and unchanged sync, while using `run_git`, `write_openai_curated_marketplace`, `write_executable_script`, and `assert_curated_gmail_repo` to build and verify the scenario.

*Call graph*: calls 4 internal fn (assert_curated_gmail_repo, run_git, write_executable_script, write_openai_curated_marketplace); 10 external calls (from_utf8_lossy, assert!, assert_eq!, new, format!, create_dir_all, read_to_string, write, new, tempdir).


##### `sync_openai_plugins_repo_falls_back_to_http_when_git_is_unavailable`  (lines 582–603)

```
async fn sync_openai_plugins_repo_falls_back_to_http_when_git_is_unavailable()
```

**Purpose**: Verifies that the transport-selection sync falls back to HTTP archive download when the configured git binary cannot be executed. The resulting repository should still be extracted and recorded as synced.

**Data flow**: It starts a mock server, mounts GitHub metadata and a valid zipball for a fixed SHA, invokes `run_sync_with_transport_overrides` with a nonexistent git binary and an unusable backup-archive URL, and asserts the returned SHA, extracted repo files, and `.tmp/plugins.sha` contents. The test writes only through the sync implementation.

**Call relations**: This async test covers the branch where git transport is unavailable before any git operations can succeed, proving the wrapper delegates to HTTP sync rather than failing outright.

*Call graph*: calls 5 internal fn (assert_curated_gmail_repo, curated_repo_zipball_bytes, mount_github_repo_and_ref, mount_github_zipball, run_sync_with_transport_overrides); 3 external calls (start, assert_eq!, tempdir).


##### `sync_openai_plugins_repo_falls_back_to_http_when_git_sync_fails`  (lines 607–641)

```
async fn sync_openai_plugins_repo_falls_back_to_http_when_git_sync_fails()
```

**Purpose**: Checks that a present but failing git binary also triggers HTTP fallback. Unlike the previous test, this one proves fallback occurs after an attempted git sync returns an error.

**Data flow**: It writes a fake executable `git` script that always exits 1, mounts mock GitHub metadata and zipball endpoints, runs `run_sync_with_transport_overrides`, and asserts that sync still returns the expected SHA and produces the curated Gmail repository plus persisted SHA file.

**Call relations**: This Unix-only async test exercises the transport-selection logic's error-handling path: git is chosen first, fails, and the code then delegates to HTTP archive sync.

*Call graph*: calls 6 internal fn (assert_curated_gmail_repo, curated_repo_zipball_bytes, mount_github_repo_and_ref, mount_github_zipball, run_sync_with_transport_overrides, write_executable_script); 4 external calls (start, assert_eq!, new, tempdir).


##### `sync_openai_plugins_repo_via_git_cleans_up_staged_dir_on_fetch_failure`  (lines 645–681)

```
fn sync_openai_plugins_repo_via_git_cleans_up_staged_dir_on_fetch_failure()
```

**Purpose**: Ensures that a git fetch failure does not leave behind a staged temporary clone directory. This protects later syncs from accumulating partial state under `.tmp`.

**Data flow**: The test creates a fake `git` script that returns a valid SHA for `ls-remote`, initializes a `.git` directory for `init`, and then fails `fetch` with `fatal: early EOF`; it calls `sync_openai_plugins_repo_via_git`, captures the error string, and asserts both the error message and absence of `plugins-clone-*` directories.

**Call relations**: This Unix-only test targets the git sync implementation's failure cleanup path after staging has begun but before a valid checkout is available.

*Call graph*: calls 1 internal fn (write_executable_script); 4 external calls (assert!, format!, new, tempdir).


##### `sync_openai_plugins_repo_via_git_preserves_existing_snapshot_on_validation_failure`  (lines 685–752)

```
fn sync_openai_plugins_repo_via_git_preserves_existing_snapshot_on_validation_failure()
```

**Purpose**: Verifies that when a staged git update is fetched but fails validation, the existing curated snapshot remains untouched. The test specifically simulates a staged checkout missing the marketplace manifest.

**Data flow**: It pre-populates the curated repo with a valid Gmail snapshot and stored SHA, creates a fake `git` script that reports a newer remote SHA and simulates fetch/reset/clean behavior while writing only a `linear` plugin manifest into the staged checkout, then calls `sync_openai_plugins_repo_via_git`. The test asserts the returned error mentions the missing marketplace manifest, the original Gmail repo still exists, `plugins/linear` was not installed into the live repo, the stored SHA remains `TEST_CURATED_PLUGIN_SHA`, and no staged clone dirs remain.

**Call relations**: This Unix-only test exercises the git sync implementation's validation-and-swap boundary: staging may proceed, but promotion to the live curated repo must not happen unless the staged snapshot passes structural checks.

*Call graph*: calls 4 internal fn (assert_curated_gmail_repo, write_curated_plugin_sha, write_executable_script, write_openai_curated_marketplace); 6 external calls (assert!, assert_eq!, format!, create_dir_all, new, tempdir).


##### `sync_openai_plugins_repo_via_http_cleans_up_staged_dir_on_extract_failure`  (lines 755–769)

```
async fn sync_openai_plugins_repo_via_http_cleans_up_staged_dir_on_extract_failure()
```

**Purpose**: Checks that HTTP sync removes its staged extraction directory when the downloaded archive is not a valid zip file. This mirrors the cleanup guarantee tested for git failures.

**Data flow**: It mounts GitHub metadata for a SHA and serves `b"not a zip archive"` from the zipball endpoint, runs `run_http_sync`, asserts the error string contains `failed to open curated plugins zip archive`, and confirms there are no leftover `plugins-clone-*` directories.

**Call relations**: This async test directly targets the HTTP extraction path and its cleanup behavior after archive parsing fails.

*Call graph*: calls 3 internal fn (mount_github_repo_and_ref, mount_github_zipball, run_http_sync); 3 external calls (start, assert!, tempdir).


##### `sync_openai_plugins_repo_skips_archive_download_when_sha_matches`  (lines 772–799)

```
async fn sync_openai_plugins_repo_skips_archive_download_when_sha_matches()
```

**Purpose**: Verifies that if the locally stored curated SHA already matches the remote SHA, sync does not download or replace the archive. The existing marketplace snapshot should remain in place.

**Data flow**: The test creates a minimal existing curated repo and `.tmp/plugins.sha` with a chosen SHA, mounts only the GitHub metadata/ref endpoints for that same SHA, runs `run_sync_with_transport_overrides` with a missing git binary, and then asserts the SHA file is unchanged and the marketplace manifest still exists. No zipball endpoint is needed because the code should short-circuit before download.

**Call relations**: This async test covers the optimization path in transport-selected sync where remote freshness is checked but archive retrieval is skipped because local state is already current.

*Call graph*: calls 2 internal fn (mount_github_repo_and_ref, run_sync_with_transport_overrides); 7 external calls (start, assert!, assert_eq!, format!, create_dir_all, write, tempdir).


##### `sync_openai_plugins_repo_falls_back_to_export_archive_when_no_snapshot_exists`  (lines 802–831)

```
async fn sync_openai_plugins_repo_falls_back_to_export_archive_when_no_snapshot_exists()
```

**Purpose**: Tests the final fallback path: when GitHub metadata lookup fails and there is no existing curated snapshot, sync should fetch a backup export archive instead. The extracted archive's embedded git refs determine the persisted SHA.

**Data flow**: It starts a mock server, mounts `/repos/openai/plugins` to return HTTP 500, mounts the export-archive API and a valid backup zip containing `.git/HEAD`, refs, marketplace, and Gmail plugin files, then runs `run_sync_with_transport_overrides`. The test asserts the returned SHA equals the archive's embedded SHA and that the curated repo plus `.tmp/plugins.sha` were written correctly.

**Call relations**: This async test drives the transport-selection logic through GitHub failure into backup export fallback, specifically in the case where no prior snapshot exists to preserve.

*Call graph*: calls 4 internal fn (assert_curated_gmail_repo, curated_repo_backup_archive_zip_bytes, mount_export_archive, run_sync_with_transport_overrides); 7 external calls (given, start, new, assert_eq!, tempdir, method, path).


##### `sync_openai_plugins_repo_skips_export_archive_when_snapshot_exists`  (lines 834–875)

```
async fn sync_openai_plugins_repo_skips_export_archive_when_snapshot_exists()
```

**Purpose**: Ensures that backup export fallback is intentionally suppressed when a curated snapshot already exists locally. In that case, sync should fail rather than overwrite the existing snapshot from the export archive.

**Data flow**: The test writes an existing curated repo with a `linear` plugin and stored test SHA, records the original plugin manifest contents, mounts GitHub metadata failure and a valid export archive with a different SHA, runs `run_sync_with_transport_overrides`, expects an error containing `export archive fallback skipped`, and then verifies the plugin manifest and stored SHA are unchanged.

**Call relations**: This async test complements the previous one by proving the export fallback is conditional on absence of local snapshot state, preserving existing curated content during upstream outages.

*Call graph*: calls 5 internal fn (curated_repo_backup_archive_zip_bytes, mount_export_archive, run_sync_with_transport_overrides, write_curated_plugin_sha, write_openai_curated_marketplace); 9 external calls (given, start, new, assert!, assert_eq!, read_to_string, tempdir, method, path).


##### `read_extracted_backup_archive_git_sha_reads_head_ref_from_extracted_repo`  (lines 878–894)

```
fn read_extracted_backup_archive_git_sha_reads_head_ref_from_extracted_repo()
```

**Purpose**: Checks that the helper for reading a git SHA from an extracted backup archive follows `.git/HEAD` to a branch ref and returns the referenced commit SHA. This is how backup archives communicate their revision.

**Data flow**: It creates `.git/HEAD` containing `ref: refs/heads/main` and `.git/refs/heads/main` containing a 40-character SHA, calls `read_extracted_backup_archive_git_sha`, and asserts it returns `Some(<sha>)`. The test writes fixture files and reads back the parsed result.

**Call relations**: This is a focused unit test of the backup-archive SHA reader from the parent module, independent of full sync execution.

*Call graph*: 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `read_extracted_backup_archive_git_sha_rejects_non_refs_head_target`  (lines 897–906)

```
fn read_extracted_backup_archive_git_sha_rejects_non_refs_head_target()
```

**Purpose**: Verifies that the backup-archive SHA reader rejects `.git/HEAD` targets outside `refs/`. This prevents malformed or unsafe HEAD contents from being interpreted as valid refs.

**Data flow**: The test writes `.git/HEAD` as `ref: HEAD`, calls `read_extracted_backup_archive_git_sha`, expects an error, and asserts the message mentions `must stay under refs/`. It mutates only the temporary fixture directory.

**Call relations**: This unit test covers one of the path-safety guards in the backup-archive SHA reader.

*Call graph*: 4 external calls (assert!, create_dir_all, write, tempdir).


##### `read_extracted_backup_archive_git_sha_rejects_path_traversal_ref`  (lines 909–919)

```
fn read_extracted_backup_archive_git_sha_rejects_path_traversal_ref()
```

**Purpose**: Checks that the backup-archive SHA reader rejects ref paths containing traversal components such as `../../`. This protects extraction consumers from escaping the `.git/refs` subtree.

**Data flow**: It writes `.git/HEAD` with `ref: refs/heads/../../evil`, invokes `read_extracted_backup_archive_git_sha`, expects an error, and asserts the message mentions `invalid path components`. No persistent state is produced beyond the temporary fixture.

**Call relations**: This unit test complements the previous one by validating the reader's normalization and traversal checks for extracted archive refs.

*Call graph*: 4 external calls (assert!, create_dir_all, write, tempdir).


##### `curated_repo_zipball_bytes`  (lines 921–956)

```
fn curated_repo_zipball_bytes(sha: &str) -> Vec<u8>
```

**Purpose**: Builds an in-memory GitHub-style zipball containing a minimal curated repository rooted under `openai-plugins-<sha>/`. The archive includes the marketplace manifest and Gmail plugin manifest expected by sync validation.

**Data flow**: It takes a SHA string, creates a `ZipWriter` over a `Cursor<Vec<u8>>`, starts entries for `<root>/.agents/plugins/marketplace.json` and `<root>/plugins/gmail/.codex-plugin/plugin.json`, writes fixed JSON payloads, finishes the archive, and returns the resulting byte vector.

**Call relations**: HTTP fallback tests call this helper to supply realistic zipball bytes to `mount_github_zipball`, either for successful extraction or as the baseline valid archive fixture.

*Call graph*: calls 1 internal fn (new); called by 2 (sync_openai_plugins_repo_falls_back_to_http_when_git_is_unavailable, sync_openai_plugins_repo_falls_back_to_http_when_git_sync_fails); 4 external calls (default, new, new, format!).


##### `curated_repo_backup_archive_zip_bytes`  (lines 958–1002)

```
fn curated_repo_backup_archive_zip_bytes(sha: &str) -> Vec<u8>
```

**Purpose**: Builds an in-memory backup export archive whose top-level directory is `plugins/` and which embeds git metadata plus curated plugin files. The embedded `.git/HEAD` and branch ref encode the SHA that sync should persist.

**Data flow**: Given a SHA string, it creates a zip archive containing `plugins/.git/HEAD`, `plugins/.git/refs/heads/main`, `plugins/.agents/plugins/marketplace.json`, and `plugins/plugins/gmail/.codex-plugin/plugin.json`, writes the fixed contents, finishes the writer, and returns the bytes.

**Call relations**: Export-fallback tests use this helper with `mount_export_archive` so the sync code can extract a backup snapshot and recover its git SHA from the included refs.

*Call graph*: calls 1 internal fn (new); called by 2 (sync_openai_plugins_repo_falls_back_to_export_archive_when_no_snapshot_exists, sync_openai_plugins_repo_skips_export_archive_when_snapshot_exists); 4 external calls (default, new, new, format!).


### `core-plugins/src/remote/share/tests.rs`

`test` · `test execution`

This test module builds realistic fixtures around the sharing API in `share.rs`. It provides small helpers to construct a `RemotePluginServiceConfig` pointing at a `wiremock::MockServer`, create dummy ChatGPT auth, write plugin files and local-path mapping files, inspect tar.gz archive contents, and synthesize representative remote plugin JSON payloads.

The integration-style async tests validate the exact HTTP contracts used by the share code: `save_remote_plugin_share_creates_workspace_plugin` checks the upload-url request, blob upload headers, final create request body, returned share URL, persisted local-path mapping, and archive contents; `save_remote_plugin_share_updates_existing_workspace_plugin` verifies the update path that includes `plugin_id`; `update_remote_plugin_share_targets_updates_targets` confirms target normalization for unlisted shares; `list_remote_plugin_shares_fetches_created_workspace_plugins` verifies pagination, installed-state enrichment, share principals, and local-path attachment; and `delete_remote_plugin_share_deletes_workspace_plugin` confirms remote deletion plus local mapping cleanup.

The pure unit tests focus on archive behavior: oversize rejection, manifest placement at archive root, and round-tripping long paths through the bundle archive implementation. Together these tests document subtle invariants such as automatic workspace-target insertion for unlisted shares, the exact JSON field names sent to the backend, and the expectation that shared plugin archives unpack directly into a standard plugin root.

#### Function details

##### `test_config`  (lines 25–29)

```
fn test_config(server: &MockServer) -> RemotePluginServiceConfig
```

**Purpose**: Builds a `RemotePluginServiceConfig` whose base URL points at the test mock server’s `/backend-api` prefix.

**Data flow**: It reads `server.uri()`, formats `"{}/backend-api"`, and returns a new `RemotePluginServiceConfig { chatgpt_base_url }`.

**Call relations**: Most async integration tests call this helper before invoking the share API so requests target the local `wiremock` server.

*Call graph*: called by 5 (delete_remote_plugin_share_deletes_workspace_plugin, list_remote_plugin_shares_fetches_created_workspace_plugins, save_remote_plugin_share_creates_workspace_plugin, save_remote_plugin_share_updates_existing_workspace_plugin, update_remote_plugin_share_targets_updates_targets); 1 external calls (format!).


##### `test_auth`  (lines 31–33)

```
fn test_auth() -> CodexAuth
```

**Purpose**: Creates a dummy ChatGPT auth object suitable for authenticated share API tests.

**Data flow**: It calls `CodexAuth::create_dummy_chatgpt_auth_for_testing()` and returns the resulting `CodexAuth`.

**Call relations**: The HTTP-facing tests use this helper so request builders include predictable authorization and account headers.

*Call graph*: calls 1 internal fn (create_dummy_chatgpt_auth_for_testing); called by 5 (delete_remote_plugin_share_deletes_workspace_plugin, list_remote_plugin_shares_fetches_created_workspace_plugins, save_remote_plugin_share_creates_workspace_plugin, save_remote_plugin_share_updates_existing_workspace_plugin, update_remote_plugin_share_targets_updates_targets).


##### `write_file`  (lines 35–38)

```
fn write_file(path: &Path, contents: &str)
```

**Purpose**: Creates parent directories and writes a text file for test fixture setup.

**Data flow**: It takes a filesystem `path` and `contents`, creates the parent directory tree, then writes the contents to the file, panicking on failure via `unwrap()`.

**Call relations**: Fixture-building helpers and archive tests use this to create plugin manifests, skill files, and mapping files.

*Call graph*: called by 4 (archive_plugin_for_upload_rejects_archives_over_limit, archive_plugin_for_upload_round_trips_through_plugin_bundle_archive_with_long_paths, write_plugin_share_local_path_mapping, write_test_plugin); 3 external calls (parent, create_dir_all, write).


##### `write_test_plugin`  (lines 40–51)

```
fn write_test_plugin(root: &Path, plugin_name: &str) -> PathBuf
```

**Purpose**: Creates a minimal plugin directory tree containing a manifest and one skill file.

**Data flow**: It joins `root` with `plugin_name`, writes `.codex-plugin/plugin.json` containing the plugin name, writes `skills/example/SKILL.md`, and returns the resulting plugin directory `PathBuf`.

**Call relations**: Archive tests and share-save tests call this helper to produce a realistic plugin bundle source directory.

*Call graph*: calls 1 internal fn (write_file); called by 5 (archive_plugin_for_upload_places_manifest_at_archive_root, archive_plugin_for_upload_rejects_archives_over_limit, archive_plugin_for_upload_round_trips_through_plugin_bundle_archive_with_long_paths, save_remote_plugin_share_creates_workspace_plugin, save_remote_plugin_share_updates_existing_workspace_plugin); 2 external calls (join, format!).


##### `write_plugin_share_local_path_mapping`  (lines 53–70)

```
fn write_plugin_share_local_path_mapping(
    codex_home: &Path,
    remote_plugin_id: &str,
    plugin_path: &AbsolutePathBuf,
)
```

**Purpose**: Writes a share local-path mapping file directly under `.tmp` for tests that need preexisting bookkeeping state.

**Data flow**: It formats pretty JSON containing `localPluginPathsByRemotePluginId: { remote_plugin_id: plugin_path }`, appends a newline, and writes it to `codex_home/.tmp/plugin-share-local-paths-v1.json` using `write_file`.

**Call relations**: Listing and deletion tests use this helper to simulate prior successful share saves or checkouts.

*Call graph*: calls 1 internal fn (write_file); called by 2 (delete_remote_plugin_share_deletes_workspace_plugin, list_remote_plugin_shares_fetches_created_workspace_plugins); 2 external calls (join, format!).


##### `archive_file_entries`  (lines 72–89)

```
fn archive_file_entries(archive_bytes: &[u8]) -> BTreeMap<String, Vec<u8>>
```

**Purpose**: Decodes a gzip-compressed tar archive and returns all regular-file entries with their raw contents for assertions.

**Data flow**: It wraps `archive_bytes` in `flate2::read::GzDecoder`, constructs a `tar::Archive`, iterates entries, filters to regular files, reads each file body into a `Vec<u8>`, and collects a `BTreeMap<String, Vec<u8>>` keyed by archive path.

**Call relations**: Archive-layout tests and the share-save upload test use this helper to inspect the exact files packed into the uploaded archive.

*Call graph*: called by 2 (archive_plugin_for_upload_places_manifest_at_archive_root, save_remote_plugin_share_creates_workspace_plugin); 2 external calls (new, new).


##### `remote_plugin_json`  (lines 91–110)

```
fn remote_plugin_json(plugin_id: &str) -> serde_json::Value
```

**Purpose**: Builds a baseline remote workspace-plugin JSON object used in mocked API responses.

**Data flow**: It returns a `serde_json::Value` object containing fixed fields such as `id`, `name`, `scope`, `discoverability`, installation/authentication policy, release metadata, interface, and empty skills.

**Call relations**: Other JSON fixture helpers derive from this baseline when constructing created-plugin and installed-plugin responses.

*Call graph*: called by 2 (installed_remote_plugin_json, remote_plugin_json_with_share_url_and_principals); 1 external calls (json!).


##### `remote_plugin_json_with_share_url_and_principals`  (lines 112–125)

```
fn remote_plugin_json_with_share_url_and_principals(
    plugin_id: &str,
    share_url: Option<&str>,
    share_principals: serde_json::Value,
) -> serde_json::Value
```

**Purpose**: Extends the baseline remote plugin JSON with share URL and share-principal fields for created-share listing tests.

**Data flow**: It starts from `remote_plugin_json(plugin_id)`, mutably accesses the object fields, overwrites `discoverability`, inserts `share_url`, inserts `share_principals`, and returns the modified JSON value.

**Call relations**: The created-workspace-plugin listing test uses this helper to mock paginated backend responses that include sharing metadata.

*Call graph*: calls 1 internal fn (remote_plugin_json); 2 external calls (json!, unreachable!).


##### `installed_remote_plugin_json`  (lines 127–135)

```
fn installed_remote_plugin_json(plugin_id: &str) -> serde_json::Value
```

**Purpose**: Extends the baseline remote plugin JSON with installed-plugin fields used by the installed-workspace-plugin listing endpoint.

**Data flow**: It starts from `remote_plugin_json(plugin_id)`, mutably inserts `enabled: true` and `disabled_skill_names: []`, and returns the modified JSON object.

**Call relations**: The share-listing test uses this helper to mock the installed-plugins endpoint and verify installed/enabled enrichment.

*Call graph*: calls 1 internal fn (remote_plugin_json); 2 external calls (json!, unreachable!).


##### `empty_pagination_json`  (lines 137–141)

```
fn empty_pagination_json() -> serde_json::Value
```

**Purpose**: Creates a pagination object representing the final page of a paginated backend response.

**Data flow**: It returns `json!({ "next_page_token": null })`.

**Call relations**: Listing tests use this helper when mocking the last page of created or installed plugin responses.

*Call graph*: 1 external calls (json!).


##### `expected_plugin_interface`  (lines 143–163)

```
fn expected_plugin_interface() -> PluginInterface
```

**Purpose**: Constructs the `PluginInterface` value expected after decoding the mocked remote plugin JSON.

**Data flow**: It returns a fully populated `PluginInterface` struct with fixed display name, short description, capabilities, and empty optional/collection fields.

**Call relations**: The share-listing test compares decoded summaries against this helper’s value to verify interface mapping.

*Call graph*: 2 external calls (new, vec!).


##### `save_remote_plugin_share_creates_workspace_plugin`  (lines 166–280)

```
async fn save_remote_plugin_share_creates_workspace_plugin()
```

**Purpose**: Verifies the full create-share flow: archive generation, upload URL request, blob upload, final create request, returned share URL, local mapping persistence, and archive contents.

**Data flow**: The test creates temporary Codex and plugin directories, computes the archive size, starts a mock server, installs three HTTP mocks for upload-url creation, blob upload, and workspace-plugin creation, calls `save_remote_plugin_share` with unlisted discoverability and one user target, then asserts the returned `RemotePluginShareSaveResult`, the persisted local-path mapping, and the uploaded archive file entries.

**Call relations**: This is the broadest end-to-end test of `save_remote_plugin_share`, covering its interactions with archive helpers, target normalization, HTTP helpers, and `local_paths` persistence.

*Call graph*: calls 5 internal fn (archive_file_entries, test_auth, test_config, write_test_plugin, try_from); 11 external calls (given, start, new, new, assert_eq!, json!, vec!, body_json, header, method (+1 more)).


##### `archive_plugin_for_upload_rejects_archives_over_limit`  (lines 283–298)

```
fn archive_plugin_for_upload_rejects_archives_over_limit()
```

**Purpose**: Checks that archive creation fails with `ArchiveTooLarge` when the packed plugin exceeds the configured byte limit.

**Data flow**: It creates a test plugin, adds a large file, calls `archive_plugin_for_upload_with_limit` with a tiny `max_bytes`, and asserts that the returned error matches `RemotePluginCatalogError::ArchiveTooLarge`.

**Call relations**: This unit test targets the archive-size enforcement path used indirectly by share saving.

*Call graph*: calls 2 internal fn (write_file, write_test_plugin); 2 external calls (new, assert!).


##### `archive_plugin_for_upload_places_manifest_at_archive_root`  (lines 301–327)

```
fn archive_plugin_for_upload_places_manifest_at_archive_root()
```

**Purpose**: Verifies that the packed archive contains plugin files rooted directly at the plugin root rather than nested under the source directory name.

**Data flow**: It creates a test plugin, archives it with `archive_plugin_for_upload`, decodes entries with `archive_file_entries`, and asserts the exact archive paths and file contents for the manifest and skill file.

**Call relations**: This test documents the archive layout expected by remote upload and later extraction code.

*Call graph*: calls 2 internal fn (archive_file_entries, write_test_plugin); 2 external calls (new, assert_eq!).


##### `archive_plugin_for_upload_round_trips_through_plugin_bundle_archive_with_long_paths`  (lines 330–355)

```
fn archive_plugin_for_upload_round_trips_through_plugin_bundle_archive_with_long_paths()
```

**Purpose**: Ensures archives produced for sharing can be unpacked by the bundle archive implementation even when they contain very long nested paths.

**Data flow**: It creates a test plugin, adds a deeply nested long-path skill file, archives the plugin, unpacks it into a temporary destination with `unpack_plugin_bundle_tar_gz`, and asserts that both the manifest and long-path skill file round-trip correctly.

**Call relations**: This test connects share archive creation to the lower-level bundle archive unpacker used elsewhere in the system.

*Call graph*: calls 3 internal fn (unpack_plugin_bundle_tar_gz, write_file, write_test_plugin); 3 external calls (new, new, assert_eq!).


##### `save_remote_plugin_share_updates_existing_workspace_plugin`  (lines 358–423)

```
async fn save_remote_plugin_share_updates_existing_workspace_plugin()
```

**Purpose**: Verifies the update-share path that reuses an existing remote plugin ID instead of creating a new one.

**Data flow**: It creates temporary plugin state, mocks upload-url creation with `plugin_id`, blob upload, and final POST to `/public/plugins/workspace/plugins_123`, calls `save_remote_plugin_share` with `Some("plugins_123")`, and asserts the returned result has the same remote plugin ID and no share URL.

**Call relations**: This test covers the branch in `save_remote_plugin_share` and `finalize_workspace_plugin_upload` that updates an existing remote workspace plugin.

*Call graph*: calls 4 internal fn (test_auth, test_config, write_test_plugin, try_from); 10 external calls (given, start, new, new, assert_eq!, default, json!, body_json, method, path).


##### `update_remote_plugin_share_targets_updates_targets`  (lines 426–517)

```
async fn update_remote_plugin_share_targets_updates_targets()
```

**Purpose**: Checks that updating share targets sends the expected request body and decodes the returned principals and discoverability.

**Data flow**: It starts a mock server, installs a PUT mock for `/ps/plugins/plugins_123/shares` expecting user, group, and auto-added workspace targets, calls `update_remote_plugin_share_targets`, and asserts the returned `RemotePluginShareUpdateTargetsResult` matches the mocked principals and discoverability.

**Call relations**: This test specifically validates `ensure_unlisted_workspace_target` integration inside the target-update API.

*Call graph*: calls 2 internal fn (test_auth, test_config); 10 external calls (given, start, new, assert_eq!, json!, vec!, body_json, header, method, path).


##### `list_remote_plugin_shares_fetches_created_workspace_plugins`  (lines 520–693)

```
async fn list_remote_plugin_shares_fetches_created_workspace_plugins()
```

**Purpose**: Verifies that listing shares paginates through created workspace plugins, enriches them with installed-state data, and attaches remembered local paths.

**Data flow**: It writes a local-path mapping for one remote plugin ID, mocks two pages of created-workspace-plugin responses plus one installed-workspace-plugin response, calls `list_remote_plugin_shares`, and asserts the returned vector contains two `RemotePluginShareSummary` values with correct share context, installed/enabled flags, interface data, and optional local path.

**Call relations**: This test exercises the interaction among `fetch_created_workspace_plugins`, installed-plugin lookup, summary building, and local-path mapping lookup.

*Call graph*: calls 4 internal fn (test_auth, test_config, write_plugin_share_local_path_mapping, try_from); 11 external calls (given, start, new, new, assert_eq!, json!, header, method, path, query_param (+1 more)).


##### `delete_remote_plugin_share_deletes_workspace_plugin`  (lines 696–721)

```
async fn delete_remote_plugin_share_deletes_workspace_plugin()
```

**Purpose**: Checks that deleting a remote share issues the expected DELETE request and removes the local path mapping afterward.

**Data flow**: It writes a preexisting local-path mapping, mocks a `204` DELETE response for the workspace plugin endpoint, calls `delete_remote_plugin_share`, and asserts that `local_paths::load_plugin_share_local_paths` returns an empty map afterward.

**Call relations**: This test covers both the remote deletion request and the local bookkeeping cleanup performed by `delete_remote_plugin_share`.

*Call graph*: calls 4 internal fn (test_auth, test_config, write_plugin_share_local_path_mapping, try_from); 8 external calls (given, start, new, new, assert_eq!, header, method, path).


### `core-plugins/src/manager_tests.rs`

`test` · `cross-cutting`

This file is the subsystem’s behavioral specification for plugin management. Most tests create temporary `codex_home` directories, write plugin manifests (`.codex-plugin/plugin.json`), MCP configs (`.mcp.json`), app declarations (`.app.json`), skills, hooks, and `config.toml`, then exercise `PluginsManager` APIs against those fixtures. The helpers at the top generate common plugin layouts, auth-projection fixtures, TOML config snippets, git repositories, and synthetic remote-installed plugin records.

The tests cover several distinct concerns. First, auth projection: when auth mode is `Chatgpt` or `AgentIdentity`, app-backed MCP surfaces with matching names are hidden from effective MCP output and exposed as app connector IDs instead; with API-key-style auth, apps are suppressed and MCP servers remain visible. Second, plugin loading: tests verify manifest parsing defaults, custom component paths that must begin with `./`, disabled skill resolution by skill name, capability summary sanitization/truncation, MCP policy overrides from config, disabled-plugin preservation, and cache-key behavior that ignores unrelated session-layer changes. Third, marketplace behavior: install/uninstall updates cache and config, listing merges configured roots, curated manifests, installed marketplace roots, and cached metadata while deduplicating duplicate plugin entries and respecting product restrictions. Finally, remote-plugin tests validate remote-installed cache conflict resolution, featured-plugin HTTP queries, recommended-plugin cache warming/deduplication/retry behavior, and curated/non-curated cache refresh migration rules for versioned plugin cache directories.

#### Function details

##### `plugins_manager_tracks_auth_mode`  (lines 58–77)

```
fn plugins_manager_tracks_auth_mode()
```

**Purpose**: Verifies the manager’s mutable auth-mode state machine. It checks default `None`, change detection semantics of `set_auth_mode`, and constructor initialization through `new_with_options`.

**Data flow**: Creates a temporary plugin home, constructs `PluginsManager` instances, reads `auth_mode()`, writes new auth modes through `set_auth_mode`, and compares returned booleans and stored values. It produces no persistent output beyond in-memory manager state.

**Call relations**: This is a standalone unit test for constructor and auth-mode mutator behavior. It invokes the basic and option-bearing constructors and asserts the manager only reports a change when the auth mode actually differs.

*Call graph*: calls 2 internal fn (new, new_with_options); 3 external calls (new, assert!, assert_eq!).


##### `write_auth_projection_plugin`  (lines 79–105)

```
fn write_auth_projection_plugin(codex_home: &Path, name: &str, include_app: bool)
```

**Purpose**: Builds a cached plugin fixture tailored for auth-projection tests. It writes a minimal manifest plus a same-named stdio MCP server, and optionally adds an app declaration with the same surface name.

**Data flow**: Takes a `codex_home`, plugin `name`, and `include_app` flag; computes `plugins/cache/test/<name>/local`, writes `.codex-plugin/plugin.json` and `.mcp.json`, and conditionally delegates to `write_auth_projection_app` to write `.app.json`.

**Call relations**: Auth-projection tests call this helper to create plugins whose MCP/app naming collisions trigger projection rules. When `include_app` is true it chains into `write_auth_projection_app` so the later `plugins_for_config` call can observe dual-surface behavior.

*Call graph*: calls 1 internal fn (write_auth_projection_app); called by 5 (plugin_auth_projection_hides_apps_without_chatgpt_auth, plugin_auth_projection_hides_dual_surface_mcp_with_agent_identity_apps_route, plugin_auth_projection_hides_matching_mcp_with_chatgpt_apps_route, plugin_auth_projection_keeps_non_conflicting_mcp_with_chatgpt_apps_route, plugin_auth_projection_reprojects_cached_plugins_when_auth_changes); 3 external calls (join, write_file, format!).


##### `write_auth_projection_app`  (lines 107–117)

```
fn write_auth_projection_app(codex_home: &Path, plugin_name: &str, app_name: &str)
```

**Purpose**: Writes only the `.app.json` portion of an auth-projection fixture. It lets tests create plugins where app declaration names either match or differ from MCP server names.

**Data flow**: Receives `codex_home`, `plugin_name`, and `app_name`; resolves the cached plugin root and writes `.app.json` containing an app keyed by `app_name` with connector ID `connector_<plugin_name>`.

**Call relations**: Used directly by tests that need non-conflicting app names and indirectly by `write_auth_projection_plugin` for matching-name fixtures. It supplies the app metadata later consumed by plugin loading and auth projection.

*Call graph*: called by 2 (plugin_auth_projection_keeps_non_conflicting_mcp_with_chatgpt_apps_route, write_auth_projection_plugin); 3 external calls (join, write_file, format!).


##### `app_declaration`  (lines 119–125)

```
fn app_declaration(name: &str, connector_id: &str) -> AppDeclaration
```

**Purpose**: Constructs an `AppDeclaration` value with a concrete connector ID and no category. It keeps expected-value assertions concise.

**Data flow**: Transforms `name` and `connector_id` strings into an `AppDeclaration { name, connector_id: AppConnectorId(...), category: None }` and returns it without side effects.

**Call relations**: Used in expected-output assertions where tests compare loaded plugin app declarations or capability summaries against exact values.


##### `auth_projection_config`  (lines 127–140)

```
async fn auth_projection_config(codex_home: &Path) -> PluginsConfigInput
```

**Purpose**: Creates a minimal plugin-enabled config that enables `sample@test` and `docs@test`. It centralizes the config fixture shared by auth-projection tests.

**Data flow**: Writes a TOML string to `<codex_home>/config.toml`, then asynchronously loads it via `load_config`, returning a `PluginsConfigInput`.

**Call relations**: Called by the auth-projection tests before invoking `PluginsManager::plugins_for_config`. It isolates config setup from the plugin fixture-writing helpers.

*Call graph*: calls 1 internal fn (load_config); called by 5 (plugin_auth_projection_hides_apps_without_chatgpt_auth, plugin_auth_projection_hides_dual_surface_mcp_with_agent_identity_apps_route, plugin_auth_projection_hides_matching_mcp_with_chatgpt_apps_route, plugin_auth_projection_keeps_non_conflicting_mcp_with_chatgpt_apps_route, plugin_auth_projection_reprojects_cached_plugins_when_auth_changes); 2 external calls (join, write_file).


##### `sorted_effective_mcp_server_names`  (lines 142–150)

```
fn sorted_effective_mcp_server_names(outcome: &PluginLoadOutcome) -> Vec<String>
```

**Purpose**: Normalizes effective MCP server names into deterministic sorted order for assertions. This avoids map-order dependence in tests.

**Data flow**: Reads `outcome.effective_mcp_servers()`, clones the key set into a `Vec<String>`, sorts it in place, and returns the sorted names.

**Call relations**: Used by multiple auth-projection tests and related assertions whenever the exact set of effective MCP servers matters more than insertion order.

*Call graph*: calls 1 internal fn (effective_mcp_servers).


##### `plugin_auth_projection_hides_apps_without_chatgpt_auth`  (lines 153–178)

```
async fn plugin_auth_projection_hides_apps_without_chatgpt_auth()
```

**Purpose**: Confirms that app declarations are not exposed when the manager is using API-key auth. The plugin still contributes MCP servers, including one whose name matches an app declaration.

**Data flow**: Creates `sample` with both MCP and app, `docs` with MCP only, loads config, constructs a manager with `AuthMode::ApiKey`, and reads `PluginLoadOutcome`. It asserts empty `effective_apps`, both MCP servers present, and a capability summary where `sample@test` has MCP names but no app connector IDs.

**Call relations**: This test drives the full `plugins_for_config` path under non-ChatGPT auth. It depends on `write_auth_projection_plugin`, `auth_projection_config`, and `sorted_effective_mcp_server_names` to set up and inspect the projection result.

*Call graph*: calls 3 internal fn (new_with_options, auth_projection_config, write_auth_projection_plugin); 3 external calls (new, assert!, assert_eq!).


##### `plugin_auth_projection_hides_matching_mcp_with_chatgpt_apps_route`  (lines 181–219)

```
async fn plugin_auth_projection_hides_matching_mcp_with_chatgpt_apps_route()
```

**Purpose**: Verifies that under `AuthMode::Chatgpt`, a plugin surface declared both as MCP and app is projected to the app route and removed from effective MCP servers. Non-conflicting MCP-only plugins remain visible.

**Data flow**: Builds the same `sample`/`docs` fixture as the previous test, loads config, runs `plugins_for_config`, then asserts `effective_apps == [connector_sample]`, effective MCP servers contain only `docs`, and capability summaries reflect the split.

**Call relations**: This test exercises the auth-projection branch where ChatGPT app routing wins over same-named MCP servers. It uses the same fixture helpers but validates the opposite projection outcome from API-key auth.

*Call graph*: calls 3 internal fn (new_with_options, auth_projection_config, write_auth_projection_plugin); 3 external calls (new, assert!, assert_eq!).


##### `plugin_auth_projection_hides_dual_surface_mcp_with_agent_identity_apps_route`  (lines 222–243)

```
async fn plugin_auth_projection_hides_dual_surface_mcp_with_agent_identity_apps_route()
```

**Purpose**: Checks that `AgentIdentity` auth follows the same dual-surface projection rule as ChatGPT auth. Matching MCP/app surfaces become apps, while unrelated MCP servers remain.

**Data flow**: Creates the auth-projection fixture, loads config, constructs a manager with `AuthMode::AgentIdentity`, and asserts the resulting effective apps and MCP server names.

**Call relations**: This test complements the ChatGPT projection test by proving the same projection logic applies to another backend-auth mode.

*Call graph*: calls 3 internal fn (new_with_options, auth_projection_config, write_auth_projection_plugin); 2 external calls (new, assert_eq!).


##### `plugin_auth_projection_keeps_non_conflicting_mcp_with_chatgpt_apps_route`  (lines 246–278)

```
async fn plugin_auth_projection_keeps_non_conflicting_mcp_with_chatgpt_apps_route()
```

**Purpose**: Ensures ChatGPT auth only hides MCP servers whose names collide with app declaration names. A plugin can still contribute both an app and a differently named MCP server.

**Data flow**: Writes `sample` with MCP only, then adds an app named `sample_app`, plus a `docs` MCP-only plugin. After loading, it asserts `connector_sample` is exposed as an app while both `sample` and `docs` MCP servers remain effective.

**Call relations**: This test uses `write_auth_projection_app` directly to create a non-conflicting app name and verifies the projection logic is name-based rather than plugin-wide.

*Call graph*: calls 4 internal fn (new_with_options, auth_projection_config, write_auth_projection_app, write_auth_projection_plugin); 2 external calls (new, assert_eq!).


##### `plugin_auth_projection_preserves_duplicate_connector_declaration_names`  (lines 281–361)

```
async fn plugin_auth_projection_preserves_duplicate_connector_declaration_names()
```

**Purpose**: Tests deduplication when multiple app declaration names map to the same connector ID. Matching MCP servers are hidden, but the connector appears only once in effective apps and summaries.

**Data flow**: Writes a plugin with MCP servers `foo`, `foo2`, and `other`, plus app declarations `foo` and `foo2` both pointing to `connector_shared`. It loads config under ChatGPT auth and asserts only `other` remains as MCP, while apps contain a single `connector_shared` entry.

**Call relations**: This test targets the interaction between auth projection and connector-ID deduplication. It bypasses the helper fixture writers to craft a more complex `.mcp.json`/`.app.json` combination.

*Call graph*: calls 2 internal fn (new_with_options, load_config); 3 external calls (new, assert_eq!, write_file).


##### `plugin_auth_projection_reprojects_cached_plugins_when_auth_changes`  (lines 364–435)

```
async fn plugin_auth_projection_reprojects_cached_plugins_when_auth_changes()
```

**Purpose**: Verifies that cached plugin loads are reprojected when auth mode changes, rather than reusing stale effective apps/MCP summaries. The underlying loaded plugin cache can stay, but the auth-sensitive projection must update.

**Data flow**: Loads the same cached plugins first with `AuthMode::Chatgpt`, captures the outcome, mutates the manager to `AuthMode::ApiKey`, reloads the same config, and compares both `effective_*` outputs and full `PluginCapabilitySummary` arrays.

**Call relations**: This test exercises cache invalidation boundaries inside `PluginsManager`: auth mode changes should alter projection results even when plugin files and config are unchanged.

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

**Purpose**: Creates a generic plugin fixture with optional manifest version, a default `skills/SKILL.md`, and an empty MCP config. It is the main helper for install/cache-refresh tests that care about versioned cache directories.

**Data flow**: Given a root, relative directory name, manifest name, and optional version, it creates `.codex-plugin` and `skills` directories, writes `plugin.json` with optional `version`, writes `skills/SKILL.md`, and writes `.mcp.json` containing an empty `mcpServers` object.

**Call relations**: Many install and cache-refresh tests call this helper to materialize source plugins or cached plugin directories. `write_plugin` and `write_cached_plugin` are thin wrappers around it.

*Call graph*: called by 8 (install_plugin_uses_manifest_version_for_non_curated_plugins, refresh_non_curated_plugin_cache_ignores_invalid_unconfigured_plugin_versions, refresh_non_curated_plugin_cache_refreshes_configured_git_source, refresh_non_curated_plugin_cache_reinstalls_missing_configured_plugin_with_manifest_version, refresh_non_curated_plugin_cache_replaces_existing_local_version_with_manifest_version, refresh_non_curated_plugin_cache_returns_false_when_configured_plugins_are_current, write_cached_plugin, write_plugin); 4 external calls (join, format!, create_dir_all, write).


##### `write_plugin`  (lines 458–465)

```
fn write_plugin(root: &Path, dir_name: &str, manifest_name: &str)
```

**Purpose**: Convenience wrapper that creates a plugin fixture without a manifest version. It standardizes the common `local`-style plugin setup used across tests.

**Data flow**: Passes its arguments through to `write_plugin_with_version` with `manifest_version` set to `None`, producing the same on-disk plugin layout.

**Call relations**: Used broadly by install, uninstall, marketplace-listing, hook-loading, and cache-refresh tests whenever version metadata is irrelevant.

*Call graph*: calls 1 internal fn (write_plugin_with_version); called by 13 (install_plugin_supports_git_subdir_marketplace_sources, install_plugin_supports_relative_git_subdir_marketplace_sources, install_plugin_updates_config_with_relative_path_and_plugin_key, list_marketplaces_includes_enabled_state, plugin_cache_ignores_unrelated_session_overrides, plugin_hooks_for_layer_stack_loads_configured_plugin_hooks, refresh_curated_plugin_cache_migrates_full_sha_cache_version_to_short_version, refresh_curated_plugin_cache_removes_cache_for_plugin_removed_from_marketplace, refresh_curated_plugin_cache_replaces_existing_local_version_with_short_sha_version, refresh_curated_plugin_cache_returns_false_when_configured_plugins_are_current (+3 more)).


##### `init_git_repo`  (lines 467–473)

```
fn init_git_repo(repo: &Path)
```

**Purpose**: Turns a directory into a minimal committed git repository suitable for git-subdir source tests. It ensures later clone operations have a valid history and identity.

**Data flow**: Runs `git init`, sets local user email and name, stages all files, and commits an initial snapshot in the provided repository path.

**Call relations**: Git-source install and refresh tests call this helper before invoking plugin installation or cache refresh logic that clones from a repository.

*Call graph*: calls 1 internal fn (run_git); called by 3 (install_plugin_supports_git_subdir_marketplace_sources, install_plugin_supports_relative_git_subdir_marketplace_sources, refresh_non_curated_plugin_cache_refreshes_configured_git_source).


##### `run_git`  (lines 475–490)

```
fn run_git(repo: &Path, args: &[&str])
```

**Purpose**: Executes a git command in a repository and fails the test with detailed stdout/stderr if the command fails. It provides deterministic diagnostics for fixture setup.

**Data flow**: Builds `std::process::Command` with `git -C <repo> ...args`, captures output, and asserts success; on failure it formats the repo path, command, stdout, and stderr into the panic message.

**Call relations**: Only `init_git_repo` uses this helper, so all git fixture initialization flows through this checked command runner.

*Call graph*: called by 1 (init_git_repo); 2 external calls (assert!, new).


##### `plugin_config_toml`  (lines 492–510)

```
fn plugin_config_toml(enabled: bool, plugins_feature_enabled: bool) -> String
```

**Purpose**: Programmatically builds a minimal TOML config enabling or disabling the plugins feature and a single `sample@test` plugin. It avoids hand-written TOML duplication in many tests.

**Data flow**: Constructs nested `toml::Value::Table` maps for `[features]` and `[plugins."sample@test"]`, serializes them with `toml::to_string`, and returns the resulting string.

**Call relations**: Used by many plugin-loading tests as the baseline config fixture before additional files or assertions are added.

*Call graph*: called by 12 (capability_summary_sanitizes_plugin_descriptions_to_one_line, capability_summary_truncates_overlong_plugin_descriptions, effective_apps_preserves_app_config_order, load_plugins_ignores_invalid_manifest_skills_shape, load_plugins_ignores_manifest_component_paths_without_dot_slash, load_plugins_ignores_project_config_files, load_plugins_loads_default_skills_and_mcp_servers, load_plugins_preserves_disabled_plugins_without_effective_contributions, load_plugins_returns_empty_when_feature_disabled, load_plugins_uses_manifest_configured_component_paths (+2 more)); 4 external calls (Boolean, Table, new, to_string).


##### `load_plugins_from_config`  (lines 512–522)

```
async fn load_plugins_from_config(
    config_toml: &str,
    codex_home: &Path,
    auth_mode: Option<AuthMode>,
) -> PluginLoadOutcome
```

**Purpose**: End-to-end helper that writes config, loads it, constructs a manager with a chosen auth mode, and returns the plugin load outcome. It is the main test harness for `plugins_for_config`.

**Data flow**: Writes `config.toml` under `codex_home`, awaits `load_config`, creates `PluginsManager::new_with_options(..., Some(Product::Codex), auth_mode)`, invokes `plugins_for_config`, and returns the resulting `PluginLoadOutcome`.

**Call relations**: Most plugin-loading tests call this helper instead of repeating config write/load/manager setup. It sits between fixture creation and assertions.

*Call graph*: calls 2 internal fn (new_with_options, load_config); called by 13 (capability_summary_sanitizes_plugin_descriptions_to_one_line, capability_summary_truncates_overlong_plugin_descriptions, effective_apps_dedupes_connector_ids_across_plugins, effective_apps_preserves_app_config_order, load_plugins_applies_plugin_mcp_server_policy, load_plugins_ignores_invalid_manifest_skills_shape, load_plugins_ignores_manifest_component_paths_without_dot_slash, load_plugins_ignores_unknown_disabled_skill_names, load_plugins_loads_default_skills_and_mcp_servers, load_plugins_preserves_disabled_plugins_without_effective_contributions (+3 more)); 3 external calls (join, to_path_buf, write_file).


##### `load_config`  (lines 524–526)

```
async fn load_config(codex_home: &Path, cwd: &Path) -> PluginsConfigInput
```

**Purpose**: Thin async wrapper around the shared test-support config loader. It returns the `PluginsConfigInput` used by manager APIs.

**Data flow**: Passes `codex_home` and `cwd` through to `load_plugins_config_input` and returns the loaded config object.

**Call relations**: Used throughout this file by tests that need a config object for APIs other than `plugins_for_config`, such as marketplace listing, plugin reading, and remote recommendation fetches.

*Call graph*: called by 32 (auth_projection_config, featured_plugin_ids_for_config_defaults_query_param_to_codex, featured_plugin_ids_for_config_uses_restriction_product_query_param, list_marketplaces_can_skip_openai_curated_before_loading, list_marketplaces_excludes_plugins_with_explicit_empty_products, list_marketplaces_ignores_installed_roots_missing_from_config, list_marketplaces_includes_curated_repo_marketplace, list_marketplaces_includes_enabled_state, list_marketplaces_includes_installed_marketplace_roots, list_marketplaces_installed_git_source_reads_metadata_from_cache_without_cloning (+15 more)); 1 external calls (load_plugins_config).


##### `remote_installed_linear_plugin`  (lines 528–530)

```
fn remote_installed_linear_plugin() -> RemoteInstalledPlugin
```

**Purpose**: Creates a standard remote-installed plugin fixture for the `linear` plugin in the global remote marketplace. It shortens tests that only need one canonical remote plugin.

**Data flow**: Delegates to `remote_installed_plugin("linear")` and returns the resulting `RemoteInstalledPlugin`.

**Call relations**: Used by remote-installed marketplace cache tests that need a single representative plugin with default metadata.

*Call graph*: calls 1 internal fn (remote_installed_plugin); called by 1 (build_remote_installed_plugin_marketplaces_from_cache_uses_remote_metadata).


##### `remote_installed_plugin`  (lines 532–534)

```
fn remote_installed_plugin(name: &str) -> RemoteInstalledPlugin
```

**Purpose**: Creates a default remote-installed plugin fixture in the global remote marketplace. It centralizes the common metadata defaults used by remote cache tests.

**Data flow**: Delegates to `remote_installed_plugin_in_marketplace(name, REMOTE_GLOBAL_MARKETPLACE_NAME)` and returns the populated struct.

**Call relations**: Called by `remote_installed_linear_plugin`; tests that need alternate marketplaces use the more general helper directly.

*Call graph*: calls 1 internal fn (remote_installed_plugin_in_marketplace); called by 1 (remote_installed_linear_plugin).


##### `remote_installed_plugin_in_marketplace`  (lines 536–551)

```
fn remote_installed_plugin_in_marketplace(
    name: &str,
    marketplace_name: &str,
) -> RemoteInstalledPlugin
```

**Purpose**: Builds a `RemoteInstalledPlugin` with concrete IDs, enabled state, install/auth policies, availability, and empty optional metadata. It is the low-level fixture constructor for remote-installed cache tests.

**Data flow**: Takes a plugin `name` and `marketplace_name`, formats `id` as `plugins~Plugin_<name>`, fills the remaining fields with defaults like `enabled: true`, `install_policy: Available`, `auth_policy: OnUse`, and returns the struct.

**Call relations**: Used by remote-installed cache tests to seed manager caches with plugins from specific remote marketplaces and conflict scenarios.

*Call graph*: called by 1 (remote_installed_plugin); 2 external calls (new, format!).


##### `write_cached_plugin`  (lines 553–563)

```
fn write_cached_plugin(codex_home: &Path, marketplace_name: &str, plugin_name: &str)
```

**Purpose**: Creates a cached plugin directory under `plugins/cache/<marketplace>/<plugin>/local` with manifest version `local`. It simulates an installed plugin cache entry.

**Data flow**: Computes the cache root under `codex_home`, then delegates to `write_plugin_with_version` with `manifest_version` set to `Some("local")`.

**Call relations**: Used by curated and remote-installed conflict tests to represent already cached local plugin copies.

*Call graph*: calls 1 internal fn (write_plugin_with_version); called by 3 (refresh_curated_plugin_cache_leaves_api_curated_plugin_when_api_manifest_missing, remote_installed_cache_prefers_local_curated_conflicts_when_remote_plugin_disabled, remote_installed_cache_prefers_remote_curated_conflicts_when_remote_plugin_enabled); 1 external calls (join).


##### `load_plugins_loads_default_skills_and_mcp_servers`  (lines 566–683)

```
async fn load_plugins_loads_default_skills_and_mcp_servers()
```

**Purpose**: Validates the happy path for plugin loading from default manifest locations. It checks manifest metadata, skill roots, MCP server parsing including OAuth fields, app declarations, capability summaries, and effective outputs.

**Data flow**: Writes a plugin manifest with description, a skill markdown file, `.mcp.json` with an HTTP MCP server and OAuth callback config, and `.app.json` with one app. It loads plugins under ChatGPT auth and asserts the exact `LoadedPlugin`, `PluginCapabilitySummary`, effective skill roots, effective MCP server count, and effective apps.

**Call relations**: This is the broadest plugin-loading integration test and serves as a baseline for later tests that vary one aspect of loading behavior.

*Call graph*: calls 2 internal fn (load_plugins_from_config, plugin_config_toml); 3 external calls (new, assert_eq!, write_file).


##### `load_plugins_applies_plugin_mcp_server_policy`  (lines 686–752)

```
async fn load_plugins_applies_plugin_mcp_server_policy()
```

**Purpose**: Checks that per-plugin MCP server policy overrides from config are merged onto manifest-defined MCP server settings. It specifically verifies enabled state, approval mode, enabled/disabled tools, and per-tool approval overrides.

**Data flow**: Writes a plugin with one HTTP MCP server and tool metadata, writes config containing `[plugins."sample@test".mcp_servers.sample]` overrides, loads plugins, extracts the `sample` server from the first plugin, and asserts the merged `McpServerConfig` fields.

**Call relations**: This test exercises config-layer policy application after manifest parsing but before effective MCP exposure.

*Call graph*: calls 1 internal fn (load_plugins_from_config); 4 external calls (new, assert!, assert_eq!, write_file).


##### `remote_installed_cache_ignores_plugins_missing_local_cache`  (lines 755–771)

```
async fn remote_installed_cache_ignores_plugins_missing_local_cache()
```

**Purpose**: Ensures remote-installed plugin cache entries do not produce loaded plugins unless a corresponding local cache directory exists. Remote metadata alone is insufficient for plugin loading.

**Data flow**: Writes config with `remote_plugin = true`, loads it, seeds the manager’s remote-installed cache with `linear`, runs `plugins_for_config`, and asserts the outcome is the default empty `PluginLoadOutcome`.

**Call relations**: This test covers the bridge between remote-installed metadata and local plugin materialization, proving the loader requires cached plugin files.

*Call graph*: calls 2 internal fn (new, load_config); 4 external calls (new, assert_eq!, write_file, vec!).


##### `remote_installed_cache_prefers_local_curated_conflicts_when_remote_plugin_disabled`  (lines 774–814)

```
async fn remote_installed_cache_prefers_local_curated_conflicts_when_remote_plugin_disabled()
```

**Purpose**: Verifies conflict resolution between local curated plugins and remote curated cache entries when the remote-plugin feature is disabled. Local curated entries win for overlapping plugin names.

**Data flow**: Creates config enabling curated plugins but disabling `remote_plugin`, writes cached local curated plugins and remote-curated cache entries, seeds remote-installed cache, loads plugins, and asserts the resulting plugin config names prefer local curated `linear` while still including remote-only plugins.

**Call relations**: This test drives the loader’s marketplace conflict policy under one feature-flag setting.

*Call graph*: calls 3 internal fn (new, load_config, write_cached_plugin); 4 external calls (new, assert_eq!, write_file, vec!).


##### `remote_installed_cache_prefers_remote_curated_conflicts_when_remote_plugin_enabled`  (lines 817–861)

```
async fn remote_installed_cache_prefers_remote_curated_conflicts_when_remote_plugin_enabled()
```

**Purpose**: Checks the opposite conflict policy: when `remote_plugin` is enabled, remote curated cache entries supersede local curated conflicts. It also confirms API-curated/local-curated duplicates collapse to the remote curated variant.

**Data flow**: Writes config enabling both plugins and remote plugins, creates local curated and API-curated cache entries plus remote-curated cache entries, seeds remote-installed cache, loads plugins, and asserts the resulting config names include `linear@openai-curated-remote` instead of local curated variants.

**Call relations**: Paired with the previous test, this one proves the conflict preference flips based on the remote-plugin feature flag.

*Call graph*: calls 3 internal fn (new, load_config, write_cached_plugin); 4 external calls (new, assert_eq!, write_file, vec!).


##### `build_remote_installed_plugin_marketplaces_from_cache_uses_remote_metadata`  (lines 864–936)

```
async fn build_remote_installed_plugin_marketplaces_from_cache_uses_remote_metadata()
```

**Purpose**: Verifies that marketplace objects synthesized from the remote-installed cache preserve remote metadata such as install/auth policy, interface fields, keywords, and installed/enabled state. It also confirms filtering by requested marketplace names.

**Data flow**: Seeds the manager cache with a customized `RemoteInstalledPlugin` for `linear`, calls `build_remote_installed_plugin_marketplaces_from_cache` for the global remote marketplace, and asserts the resulting marketplace and plugin fields. It then requests a different marketplace and asserts an empty result.

**Call relations**: This test targets the cache-to-marketplace transformation path rather than plugin loading.

*Call graph*: calls 2 internal fn (new, remote_installed_linear_plugin); 4 external calls (new, new, assert_eq!, vec!).


##### `build_remote_installed_plugin_marketplaces_from_cache_filters_by_marketplace_name`  (lines 939–967)

```
async fn build_remote_installed_plugin_marketplaces_from_cache_filters_by_marketplace_name()
```

**Purpose**: Checks that remote-installed cache synthesis only returns marketplaces matching the requested remote marketplace names. Plugins from other remote scopes are excluded.

**Data flow**: Seeds cache entries for workspace and shared-with-me marketplaces, requests only the workspace marketplace, and asserts the returned marketplace list contains exactly one plugin ID from that scope.

**Call relations**: This complements the previous remote marketplace synthesis test by focusing on marketplace-name filtering.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert_eq!, vec!).


##### `load_plugins_resolves_disabled_skill_names_against_loaded_plugin_skills`  (lines 970–1009)

```
async fn load_plugins_resolves_disabled_skill_names_against_loaded_plugin_skills()
```

**Purpose**: Ensures disabled skill config entries are resolved against actual loaded plugin skill names and converted into canonical disabled skill paths. If all skills are disabled, the plugin contributes no capabilities.

**Data flow**: Writes a plugin with one skill named `sample-search`, writes config disabling `sample:sample-search`, loads plugins, canonicalizes the skill path, and asserts `disabled_skill_paths` contains that path, `has_enabled_skills` is false, and capability summaries are empty.

**Call relations**: This test exercises the post-load skill-name matching logic that maps config names to concrete filesystem paths.

*Call graph*: calls 1 internal fn (load_plugins_from_config); 5 external calls (new, assert!, assert_eq!, write_file, canonicalize).


##### `load_plugins_ignores_unknown_disabled_skill_names`  (lines 1012–1054)

```
async fn load_plugins_ignores_unknown_disabled_skill_names()
```

**Purpose**: Confirms that disabling a nonexistent skill name has no effect on the loaded plugin. Unknown skill references are ignored rather than treated as errors.

**Data flow**: Creates the same plugin fixture as the previous test but disables `sample:missing-skill`, loads plugins, and asserts no disabled skill paths, `has_enabled_skills == true`, and a capability summary showing skills are still present.

**Call relations**: Paired with the previous test, this one defines the edge case for unmatched skill-disable rules.

*Call graph*: calls 1 internal fn (load_plugins_from_config); 4 external calls (new, assert!, assert_eq!, write_file).


##### `plugin_telemetry_metadata_uses_default_mcp_config_path`  (lines 1057–1099)

```
async fn plugin_telemetry_metadata_uses_default_mcp_config_path()
```

**Purpose**: Checks telemetry metadata extraction from a plugin root using the default `.mcp.json` path. It verifies the resulting capability summary includes the MCP server name.

**Data flow**: Writes a plugin manifest and default `.mcp.json`, parses a `PluginId`, calls `plugin_telemetry_metadata_from_root`, and asserts the returned `capability_summary` matches the expected `PluginCapabilitySummary`.

**Call relations**: This test covers telemetry-oriented manifest/MCP inspection outside the main plugin loading path.

*Call graph*: calls 1 internal fn (parse); 3 external calls (new, assert_eq!, write_file).


##### `capability_summary_sanitizes_plugin_descriptions_to_one_line`  (lines 1102–1136)

```
async fn capability_summary_sanitizes_plugin_descriptions_to_one_line()
```

**Purpose**: Verifies that capability summaries normalize manifest descriptions by collapsing whitespace and line breaks into a single line, while preserving the raw manifest description on the loaded plugin.

**Data flow**: Writes a plugin manifest with multiline/tabbed description and a skill, loads plugins, then compares `manifest_description` on the loaded plugin with the sanitized `description` in the capability summary.

**Call relations**: This test targets summary-generation logic rather than manifest parsing itself.

*Call graph*: calls 2 internal fn (load_plugins_from_config, plugin_config_toml); 3 external calls (new, assert_eq!, write_file).


##### `capability_summary_truncates_overlong_plugin_descriptions`  (lines 1139–1176)

```
async fn capability_summary_truncates_overlong_plugin_descriptions()
```

**Purpose**: Ensures capability summaries cap description length at `MAX_CAPABILITY_SUMMARY_DESCRIPTION_LEN` while leaving the original manifest description untouched. This protects downstream telemetry/UI payload size.

**Data flow**: Generates an overlong description string, writes it into the manifest, loads plugins, and asserts the loaded plugin retains the full string while the capability summary contains a truncated copy.

**Call relations**: This complements the previous sanitization test by covering length enforcement.

*Call graph*: calls 2 internal fn (load_plugins_from_config, plugin_config_toml); 4 external calls (new, assert_eq!, write_file, format!).


##### `load_plugins_uses_manifest_configured_component_paths`  (lines 1179–1292)

```
async fn load_plugins_uses_manifest_configured_component_paths()
```

**Purpose**: Checks that manifest-declared `skills`, `mcpServers`, and `apps` paths are honored when they use the required `./...` syntax. Default locations remain included for skills, but custom MCP/app files replace the defaults.

**Data flow**: Writes a manifest pointing to `./custom-skills/`, `./config/custom.mcp.json`, and `./config/custom.app.json`, creates both default and custom component files, loads plugins under ChatGPT auth, and asserts the resulting skill roots, MCP server map, and app declarations come from the configured paths.

**Call relations**: This test defines the manifest path override semantics consumed by the loader and manifest parser.

*Call graph*: calls 2 internal fn (load_plugins_from_config, plugin_config_toml); 3 external calls (new, assert_eq!, write_file).


##### `load_plugins_ignores_manifest_component_paths_without_dot_slash`  (lines 1295–1405)

```
async fn load_plugins_ignores_manifest_component_paths_without_dot_slash()
```

**Purpose**: Verifies that manifest component paths lacking the `./` prefix are ignored as invalid. In that case the loader falls back to default `skills`, `.mcp.json`, and `.app.json` locations.

**Data flow**: Writes a manifest with bare relative paths, creates both default and custom component files, loads plugins, and asserts only default skill roots, MCP servers, and apps are used.

**Call relations**: This is the negative counterpart to the previous path-override test and depends on manifest path validation behavior.

*Call graph*: calls 2 internal fn (load_plugins_from_config, plugin_config_toml); 3 external calls (new, assert_eq!, write_file).


##### `load_plugins_ignores_invalid_manifest_skills_shape`  (lines 1408–1443)

```
async fn load_plugins_ignores_invalid_manifest_skills_shape()
```

**Purpose**: Checks that an invalid JSON shape for the manifest `skills` field does not fail plugin loading. The loader ignores the malformed field and uses the default skills directory.

**Data flow**: Writes a manifest with `skills` as an array instead of a string, creates default and custom skill directories, loads plugins, and asserts there is no plugin error and only the default skills root is present.

**Call relations**: This test covers tolerant parsing of malformed manifest fields.

*Call graph*: calls 2 internal fn (load_plugins_from_config, plugin_config_toml); 3 external calls (new, assert_eq!, write_file).


##### `load_plugins_preserves_disabled_plugins_without_effective_contributions`  (lines 1446–1498)

```
async fn load_plugins_preserves_disabled_plugins_without_effective_contributions()
```

**Purpose**: Ensures disabled plugins still appear in the loaded plugin list with their root and enabled flag, but contribute no effective skills, MCP servers, or apps. This preserves configuration visibility without activating capabilities.

**Data flow**: Writes a plugin with an MCP server, loads config where `sample@test` is disabled, and asserts the exact `LoadedPlugin` has `enabled: false`, empty capability-bearing fields, and no effective outputs.

**Call relations**: This test defines how disabled configured plugins are represented in `PluginLoadOutcome`.

*Call graph*: calls 2 internal fn (load_plugins_from_config, plugin_config_toml); 4 external calls (new, assert!, assert_eq!, write_file).


##### `effective_apps_dedupes_connector_ids_across_plugins`  (lines 1501–1574)

```
async fn effective_apps_dedupes_connector_ids_across_plugins()
```

**Purpose**: Verifies that `effective_apps()` deduplicates connector IDs globally across multiple plugins while preserving first-seen order. Duplicate app declarations from different plugins collapse to one connector ID.

**Data flow**: Creates two plugins with overlapping and distinct connector IDs, writes a config enabling both plus the apps feature, loads plugins under ChatGPT auth, and asserts the effective app connector list contains `connector_example` once followed by `connector_gmail`.

**Call relations**: This test targets the aggregation logic over loaded plugin app declarations.

*Call graph*: calls 1 internal fn (load_plugins_from_config); 7 external calls (new, Boolean, Table, assert_eq!, write_file, new, to_string).


##### `effective_apps_preserves_app_config_order`  (lines 1577–1619)

```
async fn effective_apps_preserves_app_config_order()
```

**Purpose**: Checks that app connector IDs are emitted in declaration order from `.app.json`, with later duplicates removed rather than reordered. This preserves marketplace/plugin author intent for app ordering.

**Data flow**: Writes one plugin whose `.app.json` declares `slack`, `github`, then `slack-copy` with the same connector ID as `slack`, loads plugins under ChatGPT auth, and asserts the effective apps list is `[connector_slack, connector_github]`.

**Call relations**: This complements the cross-plugin dedupe test by focusing on within-plugin ordering semantics.

*Call graph*: calls 2 internal fn (load_plugins_from_config, plugin_config_toml); 3 external calls (new, assert_eq!, write_file).


##### `capability_index_filters_inactive_and_zero_capability_plugins`  (lines 1622–1724)

```
fn capability_index_filters_inactive_and_zero_capability_plugins()
```

**Purpose**: Verifies `PluginLoadOutcome::from_plugins` only emits capability summaries for active plugins that actually contribute skills, MCP servers, or apps and are not broken. Disabled, empty, or errored plugins are omitted.

**Data flow**: Constructs several `LoadedPlugin` values in memory with different combinations of skills, MCP servers, apps, disabled state, and errors, builds an outcome from them, and asserts the resulting `capability_summaries()` array contains only the three capability-bearing active plugins.

**Call relations**: Unlike most tests here, this one bypasses filesystem loading and directly exercises summary-index construction from loaded plugin structs.

*Call graph*: calls 1 internal fn (from_plugins); 3 external calls (new, assert_eq!, vec!).


##### `load_plugins_returns_empty_when_feature_disabled`  (lines 1727–1755)

```
async fn load_plugins_returns_empty_when_feature_disabled()
```

**Purpose**: Confirms the plugin manager short-circuits to an empty outcome when the global plugins feature flag is disabled, even if plugin files exist on disk and plugin config entries are present.

**Data flow**: Writes a plugin fixture and a config with `features.plugins = false`, loads config, runs `plugins_for_config`, and asserts the result is `PluginLoadOutcome::default()`.

**Call relations**: This test covers the top-level feature gate before any plugin discovery or loading occurs.

*Call graph*: calls 3 internal fn (new, load_config, plugin_config_toml); 3 external calls (new, assert_eq!, write_file).


##### `plugin_cache_ignores_unrelated_session_overrides`  (lines 1758–1825)

```
async fn plugin_cache_ignores_unrelated_session_overrides()
```

**Purpose**: Ensures the loaded-plugin cache key ignores unrelated session-layer config changes such as model selection. A second load with only irrelevant session overrides should reuse cached plugin data.

**Data flow**: Writes a plugin and user config, constructs `ConfigLayerStack`s that differ only in session `model`, loads plugins once, deletes `.mcp.json`, loads again with a different session override, and asserts the second outcome equals the first and still contains the cached MCP server.

**Call relations**: This test probes cache-key composition and proves only plugin-relevant config should invalidate the loaded-plugin cache.

*Call graph*: calls 3 internal fn (new, plugin_config_toml, write_plugin); 5 external calls (new, assert_eq!, write_file, remove_file, from_str).


##### `loaded_plugins_cache_invalidation_rejects_stale_load_completion`  (lines 1828–1842)

```
fn loaded_plugins_cache_invalidation_rejects_stale_load_completion()
```

**Purpose**: Checks generation-based cache invalidation for asynchronous plugin loads. A stale generation must not be allowed to populate the cache after the cache has been cleared.

**Data flow**: Creates a manager and a `PluginLoadCacheKey`, records the current generation, clears the cache to advance generation, attempts to cache an empty plugin list using the stale generation, and asserts `cached_loaded_plugins` returns `None`.

**Call relations**: This is a focused cache-coherency test for the manager’s generation guard.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, new, new, assert_eq!, default).


##### `load_plugins_rejects_invalid_plugin_keys`  (lines 1845–1883)

```
async fn load_plugins_rejects_invalid_plugin_keys()
```

**Purpose**: Verifies that plugin config keys must be of the form `<plugin>@<marketplace>`. Invalid keys still produce a `LoadedPlugin` placeholder with an error, but no effective capabilities.

**Data flow**: Writes a plugin fixture and a config whose `[plugins]` table uses key `sample`, loads plugins, and asserts there is one plugin entry with `error = Some("invalid plugin key ...")` and empty effective skills/MCP servers.

**Call relations**: This test defines error reporting for malformed plugin configuration identifiers.

*Call graph*: calls 1 internal fn (load_plugins_from_config); 8 external calls (new, Boolean, Table, assert!, assert_eq!, write_file, new, to_string).


##### `install_plugin_updates_config_with_relative_path_and_plugin_key`  (lines 1886–1937)

```
async fn install_plugin_updates_config_with_relative_path_and_plugin_key()
```

**Purpose**: Tests local marketplace plugin installation end to end: the plugin is copied into cache, the returned outcome includes the computed plugin ID/version/path/auth policy, and `config.toml` gains an enabled plugin entry.

**Data flow**: Creates a fake repo marketplace with a local plugin source, calls `PluginsManager::install_plugin`, then asserts the returned `PluginInstallOutcome` and inspects `config.toml` text for `[plugins."sample-plugin@debug"]` and `enabled = true`.

**Call relations**: This test exercises marketplace manifest resolution, installation, cache placement, and config mutation together.

*Call graph*: calls 3 internal fn (new, write_plugin, try_from); 6 external calls (assert!, assert_eq!, create_dir_all, read_to_string, write, tempdir).


##### `install_openai_curated_plugin_uses_short_sha_cache_version`  (lines 1940–1973)

```
async fn install_openai_curated_plugin_uses_short_sha_cache_version()
```

**Purpose**: Verifies curated plugin installation uses the curated repository SHA shortened to the curated cache version rather than `local` or the full SHA. This keeps curated cache directories stable and compact.

**Data flow**: Creates a curated marketplace repo fixture, writes the curated SHA marker, installs `slack`, and asserts the returned outcome points at `plugins/cache/openai-curated/slack/<short_sha>` with `OnInstall` auth policy.

**Call relations**: This test targets the curated-install special case in the install path.

*Call graph*: calls 3 internal fn (new, curated_plugins_repo_path, try_from); 5 external calls (assert_eq!, write_curated_plugin_sha_with, write_openai_curated_marketplace, format!, tempdir).


##### `install_plugin_uses_manifest_version_for_non_curated_plugins`  (lines 1976–2027)

```
async fn install_plugin_uses_manifest_version_for_non_curated_plugins()
```

**Purpose**: Checks that non-curated plugin installation uses the plugin manifest’s `version` field as the cache directory name. This distinguishes installed versions for local or git-sourced plugins.

**Data flow**: Creates a local marketplace plugin with manifest version `1.2.3-beta+7`, installs it, and asserts the returned `PluginInstallOutcome` uses that exact version string and cache path.

**Call relations**: This complements the curated install test by covering the non-curated version-selection rule.

*Call graph*: calls 3 internal fn (new, write_plugin_with_version, try_from); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `install_plugin_supports_git_subdir_marketplace_sources`  (lines 2030–2083)

```
async fn install_plugin_supports_git_subdir_marketplace_sources()
```

**Purpose**: Verifies installation from a marketplace entry whose source is a git repository plus subdirectory path. The plugin should be cloned/materialized into cache and reported as version `local`.

**Data flow**: Creates a remote git repo containing `plugins/toolkit`, initializes git, writes a marketplace manifest using a `git-subdir` source with a file URL, installs `toolkit`, and asserts the returned outcome and presence of `.codex-plugin/plugin.json` in the installed cache path.

**Call relations**: This test exercises the install path’s git-subdir source handling and clone/materialization logic.

*Call graph*: calls 4 internal fn (new, init_git_repo, write_plugin, try_from); 7 external calls (assert!, assert_eq!, format!, create_dir_all, write, tempdir, from_directory_path).


##### `install_plugin_supports_relative_git_subdir_marketplace_sources`  (lines 2086–2134)

```
async fn install_plugin_supports_relative_git_subdir_marketplace_sources()
```

**Purpose**: Checks that git-subdir marketplace sources can use a relative repository URL resolved from the marketplace root. Installation should still clone and cache the plugin correctly.

**Data flow**: Creates a marketplace repo containing a sibling git repo, writes a marketplace manifest with `url: "./remote-plugin-repo"`, installs `toolkit`, and asserts the same outcome shape as the absolute-URL git-subdir test.

**Call relations**: This complements the previous git-subdir install test by covering relative URL normalization.

*Call graph*: calls 4 internal fn (new, init_git_repo, write_plugin, try_from); 5 external calls (assert!, assert_eq!, create_dir_all, write, tempdir).


##### `uninstall_plugin_removes_cache_and_config_entry`  (lines 2137–2171)

```
async fn uninstall_plugin_removes_cache_and_config_entry()
```

**Purpose**: Verifies plugin uninstallation removes both the cached plugin directory and the corresponding config entry, and that repeating uninstall is harmless. The operation is effectively idempotent.

**Data flow**: Creates a cached plugin and config entry, calls `uninstall_plugin` twice, then asserts the cache directory no longer exists and `config.toml` no longer contains the plugin section.

**Call relations**: This test covers teardown behavior after installation and confirms repeated removal does not fail.

*Call graph*: calls 2 internal fn (new, write_plugin); 4 external calls (assert!, write_file, read_to_string, tempdir).


##### `list_marketplaces_includes_enabled_state`  (lines 2174–2297)

```
async fn list_marketplaces_includes_enabled_state()
```

**Purpose**: Checks that marketplace listing merges marketplace manifest data with installed cache state and user config enabled flags. Each listed plugin reports both `installed` and `enabled` independently.

**Data flow**: Creates a repo marketplace with two plugins, writes cached installs for both, writes config enabling one and disabling the other, loads config, calls `list_marketplaces_for_config`, finds the repo marketplace entry, and asserts the exact `ConfiguredMarketplace` structure including per-plugin `enabled` booleans.

**Call relations**: This test exercises the marketplace-listing path that enriches raw marketplace metadata with config and cache state.

*Call graph*: calls 4 internal fn (new, load_config, write_plugin, try_from); 5 external calls (assert_eq!, write_file, create_dir_all, write, tempdir).


##### `list_marketplaces_returns_empty_when_feature_disabled`  (lines 2300–2342)

```
async fn list_marketplaces_returns_empty_when_feature_disabled()
```

**Purpose**: Ensures marketplace listing is suppressed entirely when the plugins feature is disabled. Marketplace manifests on disk are ignored in that mode.

**Data flow**: Creates a repo marketplace and config with `plugins = false`, loads config, calls `list_marketplaces_for_config`, and asserts the returned marketplace list is empty.

**Call relations**: This is the marketplace-listing analogue of `load_plugins_returns_empty_when_feature_disabled`.

*Call graph*: calls 3 internal fn (new, load_config, try_from); 5 external calls (assert_eq!, write_file, create_dir_all, write, tempdir).


##### `list_marketplaces_excludes_plugins_with_explicit_empty_products`  (lines 2345–2424)

```
async fn list_marketplaces_excludes_plugins_with_explicit_empty_products()
```

**Purpose**: Verifies that marketplace plugins whose policy explicitly sets `products = []` are filtered out from listing. Plugins with no product restriction remain visible.

**Data flow**: Writes a marketplace manifest containing one plugin with empty products and one default plugin, loads config, lists marketplaces, and asserts only the unrestricted plugin appears in the marketplace’s plugin list.

**Call relations**: This test defines product-gating behavior at marketplace listing time.

*Call graph*: calls 3 internal fn (new, load_config, try_from); 5 external calls (assert_eq!, write_file, create_dir_all, write, tempdir).


##### `read_plugin_for_config_returns_plugins_disabled_when_feature_disabled`  (lines 2427–2473)

```
async fn read_plugin_for_config_returns_plugins_disabled_when_feature_disabled()
```

**Purpose**: Checks that reading marketplace plugin details fails with `MarketplaceError::PluginsDisabled` when the plugins feature flag is off. Detail reads respect the same top-level feature gate as loading and listing.

**Data flow**: Creates a repo marketplace and config with `plugins = false`, loads config, calls `read_plugin_for_config`, captures the error, and asserts it matches `MarketplaceError::PluginsDisabled`.

**Call relations**: This test covers the detail-read API’s feature gating.

*Call graph*: calls 3 internal fn (new, load_config, try_from); 5 external calls (assert!, write_file, create_dir_all, write, tempdir).


##### `read_plugin_for_config_filters_mcp_servers_for_codex_backend_auth`  (lines 2476–2554)

```
async fn read_plugin_for_config_filters_mcp_servers_for_codex_backend_auth()
```

**Purpose**: Verifies plugin detail reads apply the same auth projection rules as full plugin loading. Under ChatGPT auth, matching MCP/app surfaces are hidden from MCP names and exposed as apps; under API-key auth, apps disappear and MCP names remain.

**Data flow**: Creates a marketplace plugin with `.app.json` declaring `sample-mcp` and `.mcp.json` declaring `other-mcp` plus `sample-mcp`, loads config, reads plugin details twice with managers configured for `Chatgpt` and `ApiKey`, and compares `mcp_server_names` and `apps` in each outcome.

**Call relations**: This test extends auth projection coverage from `plugins_for_config` to the marketplace plugin detail API.

*Call graph*: calls 3 internal fn (new_with_options, load_config, try_from); 5 external calls (assert!, assert_eq!, write_file, create_dir_all, tempdir).


##### `read_plugin_for_config_uses_user_layer_skill_settings_only`  (lines 2557–2619)

```
async fn read_plugin_for_config_uses_user_layer_skill_settings_only()
```

**Purpose**: Ensures plugin detail reads only honor user-layer skill disable settings, not project-layer overrides. This prevents project config from altering marketplace detail inspection.

**Data flow**: Creates a marketplace plugin with one skill, writes user config enabling the plugin and project config disabling the skill, loads config, reads plugin details, and asserts `disabled_skill_paths` is empty.

**Call relations**: This test targets config-layer selection rules specific to plugin detail reads.

*Call graph*: calls 3 internal fn (new, load_config, try_from); 4 external calls (assert!, write_file, create_dir_all, tempdir).


##### `read_plugin_for_config_uninstalled_git_source_requires_install_without_cloning`  (lines 2622–2694)

```
async fn read_plugin_for_config_uninstalled_git_source_requires_install_without_cloning()
```

**Purpose**: Checks that reading details for an uninstalled git-source marketplace plugin does not clone the remote repository. Instead it returns a placeholder description and `InstallRequiredForRemoteSource` reason.

**Data flow**: Writes a marketplace manifest pointing at a nonexistent git-subdir source, loads config, reads plugin details, and asserts the plugin is marked uninstalled with a generated explanatory description, empty skills/apps/MCP names, and no staging directory created.

**Call relations**: This test defines the no-clone behavior for remote-source detail reads when no cached install exists.

*Call graph*: calls 3 internal fn (new, load_config, try_from); 7 external calls (assert!, assert_eq!, write_file, format!, create_dir_all, tempdir, from_directory_path).


##### `read_plugin_for_config_installed_git_source_reads_from_cache_without_cloning`  (lines 2697–2867)

```
async fn read_plugin_for_config_installed_git_source_reads_from_cache_without_cloning()
```

**Purpose**: Verifies that once a git-source plugin is installed, detail reads use the cached plugin root rather than recloning the remote source. It also checks extraction of description, interface/category, skills, deduped apps, app categories, hooks, and MCP names from cache.

**Data flow**: Creates a marketplace manifest pointing at a missing remote repo, writes a cached plugin root with manifest/interface, skills, apps, MCP config, and hooks, writes config enabling the plugin and disabling one hook state entry, loads config, reads plugin details, and asserts the full returned plugin summary plus absence of any staging clone directory.

**Call relations**: This is the installed counterpart to the previous test and exercises the cache-backed detail-read path in depth.

*Call graph*: calls 3 internal fn (new, load_config, try_from); 7 external calls (assert!, assert_eq!, write_file, format!, create_dir_all, tempdir, from_directory_path).


##### `list_marketplaces_installed_git_source_reads_metadata_from_cache_without_cloning`  (lines 2870–2983)

```
async fn list_marketplaces_installed_git_source_reads_metadata_from_cache_without_cloning()
```

**Purpose**: Checks that marketplace listing for installed git-source plugins reads interface metadata from the cached plugin root instead of cloning the remote repository. Marketplace category overrides manifest category, and relative asset paths are resolved against the cached root.

**Data flow**: Creates a marketplace manifest for a missing git source, writes a cached plugin manifest with interface fields and relative asset paths, writes config enabling the plugin, lists marketplaces, and asserts the resulting `ConfiguredMarketplacePlugin` contains a `Git` source plus resolved interface asset paths under the cache root.

**Call relations**: This test covers cache-backed metadata enrichment during marketplace listing for git-source plugins.

*Call graph*: calls 3 internal fn (new, load_config, try_from); 7 external calls (assert!, assert_eq!, write_file, format!, create_dir_all, tempdir, from_directory_path).


##### `list_marketplaces_includes_curated_repo_marketplace`  (lines 2986–3059)

```
async fn list_marketplaces_includes_curated_repo_marketplace()
```

**Purpose**: Verifies that the curated plugins repository is treated as a discoverable marketplace root and included in marketplace listings when requested. Its plugins appear as uninstalled local-source entries until installed.

**Data flow**: Creates a curated repo marketplace manifest and plugin manifest under the curated repo path, loads config, lists marketplaces with `include_openai_curated = true`, and asserts the exact curated marketplace entry and plugin metadata.

**Call relations**: This test covers curated marketplace discovery independent of additional repo roots.

*Call graph*: calls 3 internal fn (new, load_config, curated_plugins_repo_path); 5 external calls (assert_eq!, write_file, create_dir_all, write, tempdir).


##### `list_marketplaces_can_skip_openai_curated_before_loading`  (lines 3062–3090)

```
async fn list_marketplaces_can_skip_openai_curated_before_loading()
```

**Purpose**: Ensures callers can skip curated marketplace loading entirely. When skipped, even a malformed curated manifest should not produce errors or marketplace entries.

**Data flow**: Writes invalid JSON to the curated marketplace manifest, loads config, lists marketplaces with `include_openai_curated = false`, and asserts there are no errors and no curated marketplace in the result.

**Call relations**: This test validates an optimization/guard path that avoids touching curated manifests when the caller opts out.

*Call graph*: calls 3 internal fn (new, load_config, curated_plugins_repo_path); 3 external calls (assert_eq!, write_file, tempdir).


##### `list_marketplaces_uses_api_curated_manifest_when_selected`  (lines 3093–3181)

```
async fn list_marketplaces_uses_api_curated_manifest_when_selected()
```

**Purpose**: Checks that API-key-style auth selects the API-curated marketplace manifest instead of the standard curated manifest. The resulting marketplace name, path, interface, and plugin IDs should come from `api_marketplace.json`.

**Data flow**: Writes both standard and API curated manifests, loads config, sets manager auth mode to `ApiKey`, lists marketplaces, finds `openai-api-curated`, and asserts the exact `ConfiguredMarketplace` contents.

**Call relations**: This test ties auth mode to curated marketplace manifest selection.

*Call graph*: calls 3 internal fn (new, load_config, curated_plugins_repo_path); 3 external calls (assert_eq!, write_file, tempdir).


##### `list_marketplaces_skips_missing_api_curated_manifest`  (lines 3184–3214)

```
async fn list_marketplaces_skips_missing_api_curated_manifest()
```

**Purpose**: Verifies that when API-curated selection is active but the API curated manifest is missing, listing quietly omits it rather than surfacing errors from the standard curated manifest. This keeps API-curated selection tolerant of absent manifests.

**Data flow**: Writes invalid JSON to the standard curated manifest, loads config, sets auth mode to `BedrockApiKey`, lists marketplaces, and asserts no errors and no API-curated marketplace entry.

**Call relations**: This complements the previous test by covering the missing-manifest edge case for API-curated selection.

*Call graph*: calls 3 internal fn (new, load_config, curated_plugins_repo_path); 3 external calls (assert_eq!, write_file, tempdir).


##### `list_marketplaces_includes_installed_marketplace_roots`  (lines 3217–3286)

```
async fn list_marketplaces_includes_installed_marketplace_roots()
```

**Purpose**: Checks that marketplace roots installed under the marketplace install directory are included in listing when they are also present in config. The listed plugin source paths resolve relative to the installed marketplace root.

**Data flow**: Writes config with a `[marketplaces.debug]` entry, creates an installed marketplace root under `marketplace_install_root`, writes its manifest and plugin manifest, loads config, lists marketplaces, and asserts the installed marketplace path and plugin source path.

**Call relations**: This test covers discovery of installed marketplace roots from config-backed installation metadata.

*Call graph*: calls 3 internal fn (marketplace_install_root, new, load_config); 5 external calls (assert_eq!, write_file, create_dir_all, write, tempdir).


##### `list_marketplaces_uses_config_when_known_registry_is_malformed`  (lines 3289–3350)

```
async fn list_marketplaces_uses_config_when_known_registry_is_malformed()
```

**Purpose**: Ensures marketplace discovery can fall back to config even if the known-marketplaces registry file is malformed. Configured installed marketplace roots should still be listed.

**Data flow**: Creates the same installed marketplace fixture as the previous test, writes malformed JSON to `.tmp/known_marketplaces.json`, loads config, lists marketplaces, and asserts the configured marketplace is still discovered.

**Call relations**: This test targets resilience of marketplace discovery when auxiliary registry state is corrupt.

*Call graph*: calls 3 internal fn (marketplace_install_root, new, load_config); 5 external calls (assert_eq!, write_file, create_dir_all, write, tempdir).


##### `list_marketplaces_ignores_installed_roots_missing_from_config`  (lines 3353–3403)

```
async fn list_marketplaces_ignores_installed_roots_missing_from_config()
```

**Purpose**: Verifies installed marketplace directories are not listed unless they are referenced by config. Presence on disk alone is insufficient.

**Data flow**: Creates an installed marketplace root without a corresponding `[marketplaces.<name>]` config entry, loads config, lists marketplaces, and asserts no marketplace path matches that installed root.

**Call relations**: This test defines the config-as-source-of-truth rule for installed marketplace discovery.

*Call graph*: calls 3 internal fn (marketplace_install_root, new, load_config); 5 external calls (assert!, write_file, create_dir_all, write, tempdir).


##### `list_marketplaces_uses_first_duplicate_plugin_entry`  (lines 3406–3549)

```
async fn list_marketplaces_uses_first_duplicate_plugin_entry()
```

**Purpose**: Checks duplicate plugin IDs across multiple marketplace roots with the same marketplace name are deduplicated globally, keeping the first encountered entry and excluding later duplicates. Non-duplicate plugins from later roots still appear.

**Data flow**: Creates two repo roots each with a `debug` marketplace; both define `dup-plugin`, while the second also defines `b-only-plugin`. After loading config and listing marketplaces with both roots, it asserts repo A owns `dup-plugin`, repo B only lists `b-only-plugin`, and the duplicate appears exactly once overall.

**Call relations**: This test exercises cross-root deduplication during marketplace aggregation.

*Call graph*: calls 3 internal fn (new, load_config, try_from); 5 external calls (assert_eq!, write_file, create_dir_all, write, tempdir).


##### `list_marketplaces_marks_configured_plugin_uninstalled_when_cache_is_missing`  (lines 3552–3633)

```
async fn list_marketplaces_marks_configured_plugin_uninstalled_when_cache_is_missing()
```

**Purpose**: Verifies a plugin can be configured as enabled yet still be reported as not installed if its cache directory is absent. Listing separates config intent from actual installed cache state.

**Data flow**: Creates a repo marketplace and config enabling `sample-plugin@debug` but does not create a cache entry, loads config, lists marketplaces, and asserts the plugin has `installed: false` and `enabled: true`.

**Call relations**: This test complements the enabled-state listing test by covering missing-cache behavior.

*Call graph*: calls 3 internal fn (new, load_config, try_from); 5 external calls (assert_eq!, write_file, create_dir_all, write, tempdir).


##### `featured_plugin_ids_for_config_uses_restriction_product_query_param`  (lines 3636–3672)

```
async fn featured_plugin_ids_for_config_uses_restriction_product_query_param()
```

**Purpose**: Checks that featured-plugin HTTP requests include the correct `platform` query parameter derived from the manager’s restriction product and send ChatGPT auth headers when auth is provided.

**Data flow**: Starts a `wiremock` server expecting `GET /backend-api/plugins/featured?platform=chat` with authorization and account headers, rewrites `config.chatgpt_base_url` to the mock server, constructs a manager restricted to `Product::Chatgpt`, calls `featured_plugin_ids_for_config`, and asserts the returned plugin ID list.

**Call relations**: This test covers outbound HTTP request shaping for featured-plugin discovery.

*Call graph*: calls 3 internal fn (new_with_options, load_config, create_dummy_chatgpt_auth_for_testing); 11 external calls (given, start, new, assert_eq!, write_file, format!, tempdir, header, method, path (+1 more)).


##### `featured_plugin_ids_for_config_defaults_query_param_to_codex`  (lines 3675–3706)

```
async fn featured_plugin_ids_for_config_defaults_query_param_to_codex()
```

**Purpose**: Verifies that featured-plugin requests default the `platform` query parameter to `codex` when no restriction product is configured. It also confirms the response body is parsed into plugin IDs.

**Data flow**: Starts a mock server expecting `platform=codex`, rewrites `chatgpt_base_url`, constructs a manager with no restriction product, calls `featured_plugin_ids_for_config` without auth, and asserts the returned list.

**Call relations**: This complements the previous featured-plugin test by covering the default query-parameter branch.

*Call graph*: calls 2 internal fn (new_with_options, load_config); 10 external calls (given, start, new, assert_eq!, write_file, format!, tempdir, method, path, query_param).


##### `remote_plugin_caches_refresh_warms_recommended_plugins_cache`  (lines 3709–3767)

```
async fn remote_plugin_caches_refresh_warms_recommended_plugins_cache()
```

**Purpose**: Checks that background remote-plugin cache refresh populates the recommended-plugins cache and that the warmed cache is then used by synchronous reads. It also verifies explicit cache clearing.

**Data flow**: Starts a mock server for `/ps/plugins/suggested`, loads config with `remote_plugin = true`, rewrites `chatgpt_base_url`, creates an `Arc<PluginsManager>`, computes the cache key, starts background refresh with auth, polls until `cached_recommended_plugins_mode` becomes populated, compares it to `recommended_plugins_mode_for_config`, clears the cache, and asserts the cache entry disappears.

**Call relations**: This test exercises the asynchronous cache warmer path rather than direct recommendation fetches.

*Call graph*: calls 3 internal fn (new, load_config, create_dummy_chatgpt_auth_for_testing); 15 external calls (from_millis, from_secs, given, start, new, assert_eq!, write_file, json!, new, tempdir (+5 more)).


##### `recommended_plugins_mode_deduplicates_concurrent_cache_misses`  (lines 3770–3845)

```
async fn recommended_plugins_mode_deduplicates_concurrent_cache_misses()
```

**Purpose**: Verifies concurrent recommendation fetches for the same cache key are deduplicated into a single HTTP request. Both callers should receive the same parsed endpoint-backed mode, and subsequent calls should hit cache.

**Data flow**: Starts a delayed mock server expecting exactly one `/ps/plugins/suggested` request with auth and product headers, loads config, constructs a manager and auth, defines the expected `RecommendedPluginsMode::Endpoint` with sorted plugin metadata, performs two concurrent `recommended_plugins_mode_for_config` calls via `tokio::join!`, and asserts both results plus a later cached call equal the expected mode.

**Call relations**: This test targets in-flight request coalescing and cache population for recommendation fetching.

*Call graph*: calls 3 internal fn (new, load_config, create_dummy_chatgpt_auth_for_testing); 14 external calls (from_millis, given, start, new, assert_eq!, write_file, json!, tempdir, join!, vec! (+4 more)).


##### `recommended_plugins_mode_caches_explicit_false`  (lines 3848–3885)

```
async fn recommended_plugins_mode_caches_explicit_false()
```

**Purpose**: Checks that an endpoint response with `enabled: false` is cached as `RecommendedPluginsMode::Legacy`. The manager should not refetch on the second call.

**Data flow**: Starts a mock server expecting one request and returning `{ enabled: false, plugins: [] }`, loads config, constructs manager and auth, calls `recommended_plugins_mode_for_config` twice, and asserts both results are `Legacy`.

**Call relations**: This test covers caching of the endpoint’s explicit opt-out signal.

*Call graph*: calls 3 internal fn (new, load_config, create_dummy_chatgpt_auth_for_testing); 9 external calls (given, start, new, assert_eq!, write_file, json!, tempdir, method, path).


##### `recommended_plugins_mode_retries_after_fetch_failure`  (lines 3888–3936)

```
async fn recommended_plugins_mode_retries_after_fetch_failure()
```

**Purpose**: Verifies failed recommendation fetches do not poison the cache permanently. After an initial server error yields `Legacy`, a later successful response should be fetched and cached.

**Data flow**: Starts a mock server returning HTTP 500 once, loads config, calls `recommended_plugins_mode_for_config` and asserts `Legacy`, resets the server to return `{ enabled: true, plugins: [] }`, calls again, and asserts the result becomes `Endpoint { plugins: [] }`.

**Call relations**: This test defines retry semantics after transient fetch failures.

*Call graph*: calls 3 internal fn (new, load_config, create_dummy_chatgpt_auth_for_testing); 9 external calls (given, start, new, assert_eq!, write_file, json!, tempdir, method, path).


##### `refresh_curated_plugin_cache_replaces_existing_local_version_with_short_sha_version`  (lines 3939–3972)

```
fn refresh_curated_plugin_cache_replaces_existing_local_version_with_short_sha_version()
```

**Purpose**: Checks curated cache refresh migrates an installed curated plugin from `local` cache version to the current short-SHA cache version. The old `local` directory should be removed.

**Data flow**: Creates a curated marketplace repo and SHA marker, writes a configured plugin ID and an existing `plugins/cache/openai-curated/slack/local` plugin, calls `refresh_curated_plugin_cache`, and asserts the old directory is gone and the short-SHA directory exists.

**Call relations**: This test exercises curated cache migration when a configured curated plugin is already cached under the legacy `local` version.

*Call graph*: calls 3 internal fn (write_plugin, curated_plugins_repo_path, new); 4 external calls (assert!, write_curated_plugin_sha_with, write_openai_curated_marketplace, tempdir).


##### `refresh_curated_plugin_cache_reinstalls_missing_configured_plugin_with_current_short_version`  (lines 3975–3998)

```
fn refresh_curated_plugin_cache_reinstalls_missing_configured_plugin_with_current_short_version()
```

**Purpose**: Verifies curated cache refresh reinstalls a configured curated plugin when its cache directory is missing. The recreated cache uses the current short-SHA version.

**Data flow**: Creates curated marketplace metadata and SHA marker without any cached plugin directory, calls `refresh_curated_plugin_cache`, and asserts the expected short-SHA cache directory now exists.

**Call relations**: This covers the missing-cache reinstall branch for standard curated plugins.

*Call graph*: calls 2 internal fn (curated_plugins_repo_path, new); 4 external calls (assert!, write_curated_plugin_sha_with, write_openai_curated_marketplace, tempdir).


##### `refresh_curated_plugin_cache_reinstalls_missing_api_curated_plugin`  (lines 4001–4025)

```
fn refresh_curated_plugin_cache_reinstalls_missing_api_curated_plugin()
```

**Purpose**: Checks the same reinstall behavior for API-curated plugins. If configured and present in the API curated manifest, refresh recreates the cache under the API curated marketplace name.

**Data flow**: Creates standard and API curated manifests, writes the curated SHA marker, constructs an API-curated `PluginId`, calls `refresh_curated_plugin_cache`, and asserts the API-curated cache directory exists under the short-SHA version.

**Call relations**: This extends curated refresh coverage to the API-curated marketplace variant.

*Call graph*: calls 3 internal fn (curated_plugins_repo_path, write_openai_api_curated_marketplace, new); 4 external calls (assert!, write_curated_plugin_sha_with, write_openai_curated_marketplace, tempdir).


##### `refresh_curated_plugin_cache_leaves_api_curated_plugin_when_api_manifest_missing`  (lines 4028–4048)

```
fn refresh_curated_plugin_cache_leaves_api_curated_plugin_when_api_manifest_missing()
```

**Purpose**: Verifies refresh does nothing for an API-curated cached plugin if the API curated manifest is missing. Existing cache is preserved and the function reports no change.

**Data flow**: Creates only the standard curated manifest, writes an existing cached API-curated plugin, calls `refresh_curated_plugin_cache`, and asserts it returns `false` and the `local` cache directory remains.

**Call relations**: This test covers the conservative behavior when API-curated metadata is unavailable.

*Call graph*: calls 3 internal fn (write_cached_plugin, curated_plugins_repo_path, new); 3 external calls (assert!, write_openai_curated_marketplace, tempdir).


##### `refresh_curated_plugin_cache_removes_cache_for_plugin_removed_from_marketplace`  (lines 4051–4075)

```
fn refresh_curated_plugin_cache_removes_cache_for_plugin_removed_from_marketplace()
```

**Purpose**: Checks that refresh removes cache for configured curated plugins no longer present in the curated marketplace manifest. Stale cache directories should be deleted.

**Data flow**: Creates an empty curated marketplace manifest, writes a configured `google-sheets@openai-curated` plugin cache directory, calls `refresh_curated_plugin_cache`, and asserts the plugin cache root no longer exists.

**Call relations**: This test covers stale curated plugin eviction.

*Call graph*: calls 3 internal fn (write_plugin, curated_plugins_repo_path, new); 4 external calls (assert!, write_openai_curated_marketplace, format!, tempdir).


##### `curated_plugin_ids_from_config_keys_reads_latest_codex_home_user_config`  (lines 4078–4118)

```
fn curated_plugin_ids_from_config_keys_reads_latest_codex_home_user_config()
```

**Purpose**: Verifies extraction of configured curated plugin IDs directly from the current user `config.toml`. It should include both standard and API curated plugin keys and reflect later config rewrites.

**Data flow**: Writes a config containing curated and non-curated plugin entries, calls `configured_curated_plugin_ids_from_codex_home`, maps results to keys, and asserts only curated keys are returned in sorted order. It then rewrites config without plugin entries and asserts an empty result.

**Call relations**: This test targets the config-scanning helper used by curated cache refresh logic.

*Call graph*: 3 external calls (assert_eq!, write_file, tempdir).


##### `refresh_curated_plugin_cache_returns_false_when_configured_plugins_are_current`  (lines 4121–4140)

```
fn refresh_curated_plugin_cache_returns_false_when_configured_plugins_are_current()
```

**Purpose**: Ensures curated cache refresh is a no-op when configured curated plugins are already cached at the current short-SHA version. The function should report `false` for no changes.

**Data flow**: Creates curated marketplace metadata, writes a plugin cache directory already using the expected short-SHA version, calls `refresh_curated_plugin_cache`, and asserts the return value is `false`.

**Call relations**: This defines the steady-state branch for curated cache refresh.

*Call graph*: calls 3 internal fn (write_plugin, curated_plugins_repo_path, new); 4 external calls (assert!, write_openai_curated_marketplace, format!, tempdir).


##### `refresh_curated_plugin_cache_migrates_full_sha_cache_version_to_short_version`  (lines 4143–4176)

```
fn refresh_curated_plugin_cache_migrates_full_sha_cache_version_to_short_version()
```

**Purpose**: Checks migration from a legacy full-SHA curated cache directory name to the current short-SHA directory name. The old full-SHA directory should be removed.

**Data flow**: Creates curated marketplace metadata, writes a plugin cache directory named with the full SHA, calls `refresh_curated_plugin_cache`, and asserts the full-SHA directory is gone and the short-SHA directory exists.

**Call relations**: This test covers another curated cache migration path for historical cache layouts.

*Call graph*: calls 3 internal fn (write_plugin, curated_plugins_repo_path, new); 4 external calls (assert!, write_openai_curated_marketplace, format!, tempdir).


##### `refresh_non_curated_plugin_cache_replaces_existing_local_version_with_manifest_version`  (lines 4179–4233)

```
fn refresh_non_curated_plugin_cache_replaces_existing_local_version_with_manifest_version()
```

**Purpose**: Verifies non-curated cache refresh upgrades a configured plugin cached under `local` to the plugin manifest’s explicit version. The old `local` cache directory is removed.

**Data flow**: Creates a repo marketplace with a versioned local plugin source, writes an existing `local` cache entry and config enabling the plugin, calls `refresh_non_curated_plugin_cache`, and asserts the `local` directory is gone and the versioned directory exists.

**Call relations**: This is the non-curated analogue of curated cache migration from `local` to a versioned cache path.

*Call graph*: calls 2 internal fn (write_plugin, write_plugin_with_version); 4 external calls (assert!, write_file, create_dir_all, tempdir).


##### `refresh_non_curated_plugin_cache_reinstalls_missing_configured_plugin_with_manifest_version`  (lines 4236–4280)

```
fn refresh_non_curated_plugin_cache_reinstalls_missing_configured_plugin_with_manifest_version()
```

**Purpose**: Checks that refresh reinstalls a configured non-curated plugin when its cache is missing, using the manifest version as the cache directory name.

**Data flow**: Creates a repo marketplace with a versioned plugin source and config enabling it, calls `refresh_non_curated_plugin_cache` without any existing cache, and asserts the versioned cache directory is created.

**Call relations**: This covers the missing-cache reinstall branch for non-curated plugins.

*Call graph*: calls 1 internal fn (write_plugin_with_version); 4 external calls (assert!, write_file, create_dir_all, tempdir).


##### `refresh_non_curated_plugin_cache_refreshes_configured_git_source`  (lines 4283–4339)

```
fn refresh_non_curated_plugin_cache_refreshes_configured_git_source()
```

**Purpose**: Verifies refresh can materialize a configured git-subdir plugin source into cache. It clones the remote repo and installs the plugin under its manifest version.

**Data flow**: Creates a remote git repo containing `plugins/sample-plugin` with version `1.2.3`, initializes git, writes a marketplace manifest referencing it via `git-subdir`, writes config enabling the plugin, calls `refresh_non_curated_plugin_cache`, and asserts the versioned cache directory exists.

**Call relations**: This test exercises the non-curated refresh path for git-backed marketplace plugins.

*Call graph*: calls 2 internal fn (init_git_repo, write_plugin_with_version); 6 external calls (assert!, write_file, format!, create_dir_all, tempdir, from_directory_path).


##### `refresh_non_curated_plugin_cache_returns_false_when_configured_plugins_are_current`  (lines 4342–4386)

```
fn refresh_non_curated_plugin_cache_returns_false_when_configured_plugins_are_current()
```

**Purpose**: Ensures non-curated cache refresh reports no changes when configured plugins are already cached at the correct manifest version. It should not reinstall unnecessarily.

**Data flow**: Creates a repo marketplace with a versioned plugin source, writes a matching versioned cache entry and enabling config, calls `refresh_non_curated_plugin_cache`, and asserts the return value is `false`.

**Call relations**: This defines the steady-state branch for non-curated cache refresh.

*Call graph*: calls 1 internal fn (write_plugin_with_version); 4 external calls (assert!, write_file, create_dir_all, tempdir).


##### `refresh_non_curated_plugin_cache_force_reinstalls_current_local_version`  (lines 4389–4448)

```
fn refresh_non_curated_plugin_cache_force_reinstalls_current_local_version()
```

**Purpose**: Checks the force-reinstall variant refreshes even when the cache version is already `local`. This allows updated local plugin contents to overwrite stale cached files.

**Data flow**: Creates a local plugin source whose skill file contains `new skill`, writes a cached `local` plugin whose skill file contains `old skill`, writes enabling config, calls `refresh_non_curated_plugin_cache_force_reinstall`, and asserts the cached skill file now contains `new skill`.

**Call relations**: This test distinguishes forced refresh behavior from the normal no-op behavior for unchanged local-version plugins.

*Call graph*: calls 1 internal fn (write_plugin); 6 external calls (assert!, assert_eq!, write_file, create_dir_all, write, tempdir).


##### `refresh_non_curated_plugin_cache_ignores_invalid_unconfigured_plugin_versions`  (lines 4451–4503)

```
fn refresh_non_curated_plugin_cache_ignores_invalid_unconfigured_plugin_versions()
```

**Purpose**: Verifies refresh ignores unrelated marketplace plugins with invalid manifest versions as long as they are not configured. A broken unconfigured plugin should not block refreshing a valid configured one.

**Data flow**: Creates a marketplace with `sample-plugin` version `1.2.3` and `broken-plugin` version consisting of whitespace, writes config enabling only `sample-plugin`, calls `refresh_non_curated_plugin_cache`, and asserts the valid plugin’s versioned cache directory exists.

**Call relations**: This test covers error isolation during marketplace-wide refresh scans.

*Call graph*: calls 1 internal fn (write_plugin_with_version); 4 external calls (assert!, write_file, create_dir_all, tempdir).


##### `load_plugins_ignores_project_config_files`  (lines 4506–4548)

```
async fn load_plugins_ignores_project_config_files()
```

**Purpose**: Ensures plugin loading from a `ConfigLayerStack` ignores project config layers entirely. Only user/session-relevant layers should contribute plugin configuration.

**Data flow**: Creates a plugin fixture and a project `.codex/config.toml`, constructs a `ConfigLayerStack` containing only a `Project` layer, calls `load_plugins_from_layer_stack`, and asserts the returned plugin list is empty.

**Call relations**: This test targets the lower-level layer-stack loader rather than `PluginsManager`, defining which config sources are eligible for plugin loading.

*Call graph*: calls 4 internal fn (new, load_plugins_from_layer_stack, plugin_config_toml, new); 7 external calls (new, default, assert_eq!, default, write_file, new, vec!).


##### `plugin_hooks_for_layer_stack_loads_configured_plugin_hooks`  (lines 4551–4595)

```
async fn plugin_hooks_for_layer_stack_loads_configured_plugin_hooks()
```

**Purpose**: Verifies hook discovery for configured plugins through the layer-stack API. It checks that hook source files are found and no warnings are emitted for a valid hooks file.

**Data flow**: Creates a cached plugin with `hooks/hooks.json`, writes enabling config, loads config, calls `plugin_hooks_for_layer_stack`, and asserts one hook source with relative path `hooks/hooks.json` and an empty warnings list.

**Call relations**: This test covers the hook-loading path parallel to plugin capability loading.

*Call graph*: calls 4 internal fn (new, load_config, plugin_config_toml, write_plugin); 3 external calls (new, assert_eq!, write_file).


### `core-plugins/src/discoverable_tests.rs`

`test` · `test execution`

This test module validates `PluginsManager::list_tool_suggest_discoverable_plugins` under realistic filesystem and remote-cache conditions. Most tests create a temporary CODEX_HOME, populate curated or bundled marketplace directories under the expected `.tmp` layout, write plugin manifests or `.app.json` files, load `PluginsConfigInput`, and call a small wrapper that unwraps the manager result. The assertions focus on exact discoverable ids or full `ToolSuggestDiscoverablePlugin` values.

The suite covers several policy dimensions. Fallback allowlist behavior is checked for standard curated and API-curated marketplaces, including Microsoft-family plugins where one installed plugin suppresses only itself. Remote-enabled listing verifies that bundled and curated marketplaces are both considered. Deduplication and missing-plugin handling ensure configured marketplace entries do not duplicate suggestions and unreadable local plugin sources are skipped rather than failing the whole list. Description normalization is asserted through a plugin manifest with irregular whitespace.

A cluster of tests guards performance and app-expansion semantics: local plugins are not expanded merely because installed or loaded apps match, malformed `.app.json` files for unrelated local plugins are never read, and sales-style aggregate local apps do not cause expansion. Another test captures that marketplace metadata is not reloaded per plugin by counting warning log occurrences. The remote-path test uses `wiremock` to cache a global remote catalog and empty installed-plugin lists, then proves that cached remote discoverable plugins can be surfaced when their `app_ids` match already loaded app connector ids. Helper functions centralize construction of `ToolSuggestPluginDiscoveryInput`, invocation of the manager method, string-set creation, plugin installation into the local store, and writing `.app.json` fixtures.

#### Function details

##### `returns_fallback_plugins_without_installed_apps`  (lines 37–61)

```
async fn returns_fallback_plugins_without_installed_apps()
```

**Purpose**: Verifies that curated fallback plugins from the allowlist are suggested even when no installed or loaded apps are present. Non-allowlisted curated plugins are excluded.

**Data flow**: Creates a temp CODEX_HOME, writes an `openai-curated` marketplace containing `sample`, `slack`, and `openai-developers`, loads plugin config, constructs a `PluginsManager`, builds empty discovery input, calls `list_discoverable_plugins`, then maps the result to ids and asserts only the allowlisted curated ids remain.

**Call relations**: Uses `discovery_input` and `list_discoverable_plugins` as the common test harness; it exercises the local curated fallback branch of `list_tool_suggest_discoverable_plugins`.

*Call graph*: calls 4 internal fn (discovery_input, list_discoverable_plugins, new, curated_plugins_repo_path); 4 external calls (assert_eq!, load_plugins_config, write_openai_curated_marketplace, tempdir).


##### `returns_api_curated_fallback_plugins_for_direct_provider_auth`  (lines 64–89)

```
async fn returns_api_curated_fallback_plugins_for_direct_provider_auth()
```

**Purpose**: Checks that direct-provider/API-key auth causes API-curated fallback plugins to be suggested. It confirms the fallback helper recognizes `openai-api-curated` ids.

**Data flow**: Creates temp curated marketplace data under the API-curated path, loads config, constructs `CodexAuth::from_api_key`, invokes `list_discoverable_plugins` with that auth, and asserts the returned ids are the API-curated versions of the allowlisted plugins.

**Call relations**: Builds on the same helper flow as the previous test but changes auth and curated marketplace source to exercise the API-curated fallback compatibility path.

*Call graph*: calls 6 internal fn (discovery_input, list_discoverable_plugins, new, curated_plugins_repo_path, write_openai_api_curated_marketplace, from_api_key); 3 external calls (assert_eq!, load_plugins_config, tempdir).


##### `returns_microsoft_fallback_plugins`  (lines 92–121)

```
async fn returns_microsoft_fallback_plugins()
```

**Purpose**: Ensures allowlisted Microsoft-family curated plugins are suggested except for ones already installed. Installing `teams` should leave the other Microsoft plugins discoverable.

**Data flow**: Creates a curated marketplace with `teams`, `sharepoint`, `outlook-email`, and `outlook-calendar`, installs `teams` into the plugin store, loads config, lists discoverable plugins, and asserts the result ids exclude the installed plugin while preserving the remaining allowlisted entries.

**Call relations**: Uses `install_marketplace_plugin` to create installed state before calling the shared discovery wrapper; it validates installed-plugin suppression within the fallback set.

*Call graph*: calls 5 internal fn (discovery_input, install_marketplace_plugin, list_discoverable_plugins, new, curated_plugins_repo_path); 4 external calls (assert_eq!, load_plugins_config, write_openai_curated_marketplace, tempdir).


##### `includes_openai_curated_when_remote_enabled`  (lines 124–179)

```
async fn includes_openai_curated_when_remote_enabled()
```

**Purpose**: Confirms that enabling remote plugins does not suppress local curated and bundled marketplace suggestions. Both bundled and curated fallback plugins should appear together.

**Data flow**: Creates temp curated marketplace data with `slack`, writes a bundled marketplace manifest and plugin for `chrome`, writes config enabling both `plugins` and `remote_plugin`, loads config, lists discoverable plugins, and asserts the ids contain both `chrome@openai-bundled` and `slack@openai-curated`.

**Call relations**: Exercises `list_tool_suggest_discoverable_plugins` with remote enabled but without relying on remote cache contents, proving local marketplace enumeration still includes curated roots.

*Call graph*: calls 4 internal fn (discovery_input, list_discoverable_plugins, new, curated_plugins_repo_path); 7 external calls (assert_eq!, load_plugins_config, write_curated_plugin, write_file, write_openai_curated_marketplace, format!, tempdir).


##### `deduplicates_configured_marketplace_plugin`  (lines 182–227)

```
async fn deduplicates_configured_marketplace_plugin()
```

**Purpose**: Checks that a configured marketplace plugin appears only once in discoverable results rather than being duplicated by fallback/configured logic. This protects callers from duplicate suggestions for the same plugin id.

**Data flow**: Creates a bundled marketplace containing one local plugin, writes config enabling plugins and that marketplace, loads config, passes the plugin id in `configured_plugin_ids`, lists discoverable plugins, and asserts the result length is one and the sole id matches the configured plugin.

**Call relations**: Uses `discovery_input` to mark the plugin configured; it validates deduplication in the manager’s local marketplace iteration.

*Call graph*: calls 3 internal fn (discovery_input, list_discoverable_plugins, new); 6 external calls (assert_eq!, load_plugins_config, write_curated_plugin, write_file, format!, tempdir).


##### `ignores_missing_marketplace_plugin`  (lines 230–275)

```
async fn ignores_missing_marketplace_plugin()
```

**Purpose**: Verifies that a marketplace entry whose plugin files are missing is skipped rather than failing discovery. Valid curated fallback suggestions should still be returned.

**Data flow**: Creates curated marketplace data with `installed` and `slack`, writes a bundled marketplace manifest pointing at a nonexistent `sample` plugin directory, writes config for that marketplace, installs `installed`, loads config, lists discoverable plugins, and asserts only `slack@openai-curated` is returned.

**Call relations**: Relies on the manager’s warning-and-continue behavior when `read_plugin_detail_for_marketplace_plugin` fails for a local marketplace plugin.

*Call graph*: calls 5 internal fn (discovery_input, install_marketplace_plugin, list_discoverable_plugins, new, curated_plugins_repo_path); 6 external calls (assert_eq!, load_plugins_config, write_file, write_openai_curated_marketplace, format!, tempdir).


##### `normalizes_description`  (lines 278–312)

```
async fn normalizes_description()
```

**Purpose**: Checks that plugin descriptions are normalized before being exposed in discoverable output. Excess whitespace and line breaks should collapse into a prompt-safe single-spaced description.

**Data flow**: Creates curated marketplace data, overwrites `slack`’s manifest with a description containing irregular whitespace, installs another plugin to avoid empty-state ambiguity, loads config, lists discoverable plugins, and asserts the full returned `ToolSuggestDiscoverablePlugin` has normalized description text plus expected skills, MCP server names, and app connector ids.

**Call relations**: Exercises the conversion path through `read_plugin_detail_for_marketplace_plugin` and `PluginCapabilitySummary` into discoverable output.

*Call graph*: calls 5 internal fn (discovery_input, install_marketplace_plugin, list_discoverable_plugins, new, curated_plugins_repo_path); 5 external calls (assert_eq!, load_plugins_config, write_file, write_openai_curated_marketplace, tempdir).


##### `omits_installed_curated_plugins`  (lines 315–331)

```
async fn omits_installed_curated_plugins()
```

**Purpose**: Ensures already installed curated plugins are not suggested as discoverable. Installed state takes precedence over fallback eligibility.

**Data flow**: Creates a curated marketplace with `slack`, installs `slack`, loads config, lists discoverable plugins, and asserts the result is an empty vector.

**Call relations**: Uses `install_marketplace_plugin` to set up the installed-state filter in the discovery method.

*Call graph*: calls 5 internal fn (discovery_input, install_marketplace_plugin, list_discoverable_plugins, new, curated_plugins_repo_path); 4 external calls (assert_eq!, load_plugins_config, write_openai_curated_marketplace, tempdir).


##### `omits_not_available_curated_plugins`  (lines 334–391)

```
async fn omits_not_available_curated_plugins()
```

**Purpose**: Verifies that curated plugins marked with installation policy `NOT_AVAILABLE` are excluded from suggestions. Other eligible curated plugins remain visible.

**Data flow**: Writes a curated marketplace manifest containing `installed`, `slack`, and `gmail` where `gmail` has `policy.installation = NOT_AVAILABLE`, writes plugin directories, installs `installed`, loads config, lists discoverable plugins, and asserts only `slack@openai-curated` is returned.

**Call relations**: Targets the local marketplace filter that skips plugins whose installation policy is `MarketplacePluginInstallPolicy::NotAvailable`.

*Call graph*: calls 5 internal fn (discovery_input, install_marketplace_plugin, list_discoverable_plugins, new, curated_plugins_repo_path); 5 external calls (assert_eq!, load_plugins_config, write_curated_plugin, write_file, tempdir).


##### `does_not_reload_marketplace_per_plugin`  (lines 394–454)

```
async fn does_not_reload_marketplace_per_plugin()
```

**Purpose**: Guards against repeated marketplace/plugin reload work during discovery by checking warning log counts. Each plugin should be read a bounded number of times rather than causing multiplicative reloads.

**Data flow**: Creates curated marketplace data with multiple plugins, installs one plugin, writes oversized `interface.defaultPrompt` values into two plugin manifests to trigger warnings, installs a tracing subscriber backed by a leaked mutex buffer, lists discoverable plugins, asserts the returned ids, then inspects captured logs and asserts exact counts for the warning text and each plugin manifest path.

**Call relations**: Uses the shared discovery wrapper but additionally instruments tracing output to validate internal loading behavior indirectly through emitted warnings.

*Call graph*: calls 5 internal fn (discovery_input, install_marketplace_plugin, list_discoverable_plugins, new, curated_plugins_repo_path); 14 external calls (leak, new, new, from_utf8, new, assert_eq!, load_plugins_config, write_file, write_openai_curated_marketplace, format! (+4 more)).


##### `does_not_expand_local_plugins_by_installed_apps`  (lines 457–474)

```
async fn does_not_expand_local_plugins_by_installed_apps()
```

**Purpose**: Ensures local discoverable plugins are not suggested merely because an installed plugin exposes matching app connector ids. App-based expansion is reserved for cached remote discoverable plugins.

**Data flow**: Creates curated marketplace data with `sample`, `slack`, and `hubspot`, writes `.app.json` for `sample`, installs `slack`, loads config, lists discoverable plugins with no configured ids, and asserts the result is empty.

**Call relations**: Uses `write_plugin_app` and `install_marketplace_plugin` to set up local app metadata, then verifies the manager does not use installed local apps to broaden local suggestions.

*Call graph*: calls 6 internal fn (discovery_input, install_marketplace_plugin, list_discoverable_plugins, write_plugin_app, new, curated_plugins_repo_path); 4 external calls (assert_eq!, load_plugins_config, write_openai_curated_marketplace, tempdir).


##### `does_not_read_local_plugins_for_loaded_apps`  (lines 477–515)

```
async fn does_not_read_local_plugins_for_loaded_apps()
```

**Purpose**: Checks that local plugin `.app.json` files are not scanned just because the caller reports loaded app connector ids. This avoids unnecessary reads and warnings from unrelated local plugins.

**Data flow**: Creates curated marketplace data with plugins whose `.app.json` files declare app ids plus a `sample` plugin with invalid `.app.json`, installs a tracing subscriber, loads config, calls discovery with one loaded app connector id, asserts no discoverable plugins are returned, then inspects logs to confirm the invalid `plugins/sample/.app.json` file was never mentioned.

**Call relations**: Uses `write_plugin_app` and the shared discovery wrapper to validate that loaded-app expansion does not trigger local plugin app-file parsing.

*Call graph*: calls 5 internal fn (discovery_input, list_discoverable_plugins, write_plugin_app, new, curated_plugins_repo_path); 13 external calls (leak, new, new, from_utf8, new, assert_eq!, load_plugins_config, write_file, write_openai_curated_marketplace, new (+3 more)).


##### `does_not_expand_local_sales_apps`  (lines 518–586)

```
async fn does_not_expand_local_sales_apps()
```

**Purpose**: Verifies that aggregate local plugins exposing multiple app ids, such as a sales plugin, do not cause local discoverable expansion. Matching local app ids alone should not surface additional local suggestions.

**Data flow**: Creates curated plugins with app ids, creates a separate local marketplace containing an installed `sales` plugin whose `.app.json` references two of those app ids, writes config for that marketplace, installs `sales`, loads config, lists discoverable plugins, and asserts the result is empty.

**Call relations**: Combines `write_plugin_app`, marketplace setup, and `install_marketplace_plugin` to prove local app relationships are ignored by discovery expansion logic.

*Call graph*: calls 6 internal fn (discovery_input, install_marketplace_plugin, list_discoverable_plugins, write_plugin_app, new, curated_plugins_repo_path); 7 external calls (assert_eq!, load_plugins_config, write_curated_plugin, write_file, write_openai_curated_marketplace, format!, tempdir).


##### `expands_cached_remote_plugins_by_loaded_apps`  (lines 589–706)

```
async fn expands_cached_remote_plugins_by_loaded_apps()
```

**Purpose**: Proves that cached remote discoverable plugins can be suggested when their `app_ids` match app connector ids already loaded in the session, even if they are not configured or allowlisted. This is the positive case for app-based expansion.

**Data flow**: Creates temp config with remote plugins enabled, starts a `wiremock` server, mocks the global remote catalog endpoint to return one discoverable plugin with `app_ids = ["remote-unlisted-app"]`, loads config and points `chatgpt_base_url` at the mock server, creates dummy ChatGPT auth, fetches and caches the global remote catalog, mocks empty installed-plugin responses for all scopes, builds and caches remote installed marketplaces, then calls discovery with `loaded_plugin_app_connector_ids = ["remote-unlisted-app"]` and asserts the full returned `ToolSuggestDiscoverablePlugin` matches the remote catalog entry.

**Call relations**: This test drives the full remote-cache path: catalog caching, installed-marketplace caching, then `list_tool_suggest_discoverable_plugins` consuming cached remote discoverable plugins and loaded app ids.

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

**Purpose**: Constructs `ToolSuggestPluginDiscoveryInput` from borrowed string slices used in tests. It centralizes conversion into owned `HashSet<String>` collections.

**Data flow**: Takes `PluginsConfigInput` plus three `&[&str]` lists for configured, disabled, and loaded app connector ids → converts each list with `string_set` → returns a populated `ToolSuggestPluginDiscoveryInput`.

**Call relations**: Called by nearly every test in this file to keep setup concise and consistent before invoking `list_discoverable_plugins`.

*Call graph*: calls 1 internal fn (string_set); called by 14 (deduplicates_configured_marketplace_plugin, does_not_expand_local_plugins_by_installed_apps, does_not_expand_local_sales_apps, does_not_read_local_plugins_for_loaded_apps, does_not_reload_marketplace_per_plugin, expands_cached_remote_plugins_by_loaded_apps, ignores_missing_marketplace_plugin, includes_openai_curated_when_remote_enabled, normalizes_description, omits_installed_curated_plugins (+4 more)).


##### `list_discoverable_plugins`  (lines 722–731)

```
async fn list_discoverable_plugins(
    plugins_manager: &PluginsManager,
    input: ToolSuggestPluginDiscoveryInput,
    auth: Option<&CodexAuth>,
) -> Vec<ToolSuggestDiscoverablePlugin>
```

**Purpose**: Thin async test wrapper around `PluginsManager::list_tool_suggest_discoverable_plugins` that unwraps errors. It lets tests focus on expected values rather than result handling.

**Data flow**: Takes `&PluginsManager`, owned `ToolSuggestPluginDiscoveryInput`, and optional auth reference → awaits `plugins_manager.list_tool_suggest_discoverable_plugins(&input, auth)` → panics on error with a fixed message, otherwise returns `Vec<ToolSuggestDiscoverablePlugin>`.

**Call relations**: Used by all scenario tests as the common invocation point for the production discovery method.

*Call graph*: called by 14 (deduplicates_configured_marketplace_plugin, does_not_expand_local_plugins_by_installed_apps, does_not_expand_local_sales_apps, does_not_read_local_plugins_for_loaded_apps, does_not_reload_marketplace_per_plugin, expands_cached_remote_plugins_by_loaded_apps, ignores_missing_marketplace_plugin, includes_openai_curated_when_remote_enabled, normalizes_description, omits_installed_curated_plugins (+4 more)); 1 external calls (list_tool_suggest_discoverable_plugins).


##### `string_set`  (lines 733–735)

```
fn string_set(values: &[&str]) -> HashSet<String>
```

**Purpose**: Converts a slice of string slices into a `HashSet<String>` for test inputs. It removes duplicates naturally through set collection.

**Data flow**: Reads `values: &[&str]` → maps each entry through `ToString::to_string` and collects into `HashSet<String>` → returns the set.

**Call relations**: Only called by `discovery_input` to build the three set fields of `ToolSuggestPluginDiscoveryInput`.

*Call graph*: called by 1 (discovery_input).


##### `install_marketplace_plugin`  (lines 737–749)

```
async fn install_marketplace_plugin(codex_home: &Path, marketplace_root: &Path, plugin_name: &str)
```

**Purpose**: Installs a plugin from a marketplace manifest into the temporary plugin store used by tests. It also writes the curated plugin SHA expected by install logic.

**Data flow**: Takes `codex_home`, `marketplace_root`, and `plugin_name` → writes the test curated SHA via `write_curated_plugin_sha_with`, constructs a new `PluginsManager`, builds `PluginInstallRequest` with the marketplace manifest path converted to `AbsolutePathBuf`, awaits `install_plugin`, and panics if installation fails.

**Call relations**: Shared setup helper for tests that need installed-state filtering or installed plugin metadata before discovery runs.

*Call graph*: calls 2 internal fn (new, try_from); called by 8 (does_not_expand_local_plugins_by_installed_apps, does_not_expand_local_sales_apps, does_not_reload_marketplace_per_plugin, ignores_missing_marketplace_plugin, normalizes_description, omits_installed_curated_plugins, omits_not_available_curated_plugins, returns_microsoft_fallback_plugins); 3 external calls (join, to_path_buf, write_curated_plugin_sha_with).


##### `write_plugin_app`  (lines 751–765)

```
fn write_plugin_app(root: &Path, plugin_name: &str, app_name: &str, app_id: &str)
```

**Purpose**: Writes a minimal `.app.json` file for a plugin fixture. It lets tests control app connector ids exposed by local plugins.

**Data flow**: Takes a root path, plugin directory name, app name, and app id → formats a JSON document under `plugins/<plugin_name>/.app.json` and writes it to disk via `write_file` → returns unit.

**Call relations**: Used by tests that model local plugin app metadata to verify whether discovery does or does not expand suggestions based on app ids.

*Call graph*: called by 3 (does_not_expand_local_plugins_by_installed_apps, does_not_expand_local_sales_apps, does_not_read_local_plugins_for_loaded_apps); 3 external calls (join, write_file, format!).


### `core-plugins/src/app_mcp_routing_tests.rs`

`test` · `test execution`

This test module targets the routing helpers re-exported from the parent module, especially `apps_route_available` and `apply_app_mcp_routing_policy`. It defines compact fixtures: `app` constructs an `AppDeclaration` with a deterministic `AppConnectorId` of the form `connector_<name>`, while `mcp_servers` turns a list of `(name, value)` pairs into a `HashMap<String, i32>` so tests can focus on key presence rather than real MCP config payloads. Two sorting helpers normalize vector and map-key order before assertions, avoiding dependence on insertion order.

The tests pin down the policy matrix. One test proves that the apps route is only considered available for `AuthMode::Chatgpt` and `AuthMode::AgentIdentity`, and unavailable for `ApiKey` or missing auth. Another verifies that when the apps route is unavailable, `apply_app_mcp_routing_policy` clears the `apps` list entirely but leaves MCP servers untouched. A complementary test shows that when the apps route is available and the plugin is active, app declarations are preserved and MCP servers whose names conflict with app names are removed. The final test captures the subtle exception that inactive plugins do not have their conflicting MCP servers stripped even if auth would otherwise allow app routing. Together these tests document the intended precedence between auth mode, plugin activation, app declarations, and MCP server visibility.

#### Function details

##### `app`  (lines 6–12)

```
fn app(name: &str) -> AppDeclaration
```

**Purpose**: Builds a minimal `AppDeclaration` fixture for a named app. It gives each fixture a predictable connector id and leaves category unset so tests isolate routing behavior rather than metadata parsing.

**Data flow**: Takes `name: &str` → allocates owned `String` values for `AppDeclaration.name` and `AppConnectorId(format!("connector_{name}"))`, sets `category` to `None` → returns the populated `AppDeclaration` without mutating external state.

**Call relations**: Used by the routing-policy tests to seed the mutable `apps` vectors passed into `apply_app_mcp_routing_policy`; it exists purely as local fixture construction.

*Call graph*: 2 external calls (format!, new).


##### `mcp_servers`  (lines 14–19)

```
fn mcp_servers(mcp_servers: impl IntoIterator<Item = (&'static str, i32)>) -> HashMap<String, i32>
```

**Purpose**: Creates a deterministic test `HashMap<String, i32>` from literal name/value pairs. The integer payload is arbitrary and only serves to distinguish entries while assertions focus on retained keys.

**Data flow**: Consumes any iterator of `(&'static str, i32)` pairs → converts each name to `String` and collects into `HashMap<String, i32>` → returns the map.

**Call relations**: Called by the three policy tests that need mutable MCP server sets before invoking `apply_app_mcp_routing_policy`.

*Call graph*: called by 3 (app_mcp_routing_clears_apps_when_apps_route_is_unavailable, app_mcp_routing_preserves_apps_and_removes_conflicting_mcp_with_apps_route, app_mcp_routing_preserves_mcp_conflicts_when_plugin_is_inactive); 1 external calls (into_iter).


##### `sorted_app_names`  (lines 21–25)

```
fn sorted_app_names(apps: &[AppDeclaration]) -> Vec<String>
```

**Purpose**: Normalizes an app declaration slice into sorted app names for stable assertions. This avoids coupling tests to original vector order.

**Data flow**: Reads `&[AppDeclaration]` → clones each `app.name` into a `Vec<String>`, sorts it in place → returns the sorted names.

**Call relations**: Used in tests after policy application to compare surviving app declarations independent of insertion order.

*Call graph*: 1 external calls (iter).


##### `sorted_mcp_server_names`  (lines 27–31)

```
fn sorted_mcp_server_names(mcp_servers: &HashMap<String, i32>) -> Vec<String>
```

**Purpose**: Extracts and sorts MCP server names from a map so assertions are stable across `HashMap` iteration order. It verifies exactly which server keys remain after routing.

**Data flow**: Reads `&HashMap<String, i32>` → clones all keys into a `Vec<String>`, sorts the vector → returns sorted server names.

**Call relations**: Used by the routing tests to assert whether conflicting MCP entries were preserved or removed.


##### `apps_route_available_tracks_auth_mode`  (lines 34–39)

```
fn apps_route_available_tracks_auth_mode()
```

**Purpose**: Verifies the auth-mode gate for the apps route. It asserts that only ChatGPT and Agent Identity auth enable app routing, while API-key and absent auth do not.

**Data flow**: Supplies four auth-mode cases to `apps_route_available` → checks each boolean result with assertions → returns unit and writes no state.

**Call relations**: This is the direct specification test for `apps_route_available`, independent of the broader routing mutation logic.

*Call graph*: 1 external calls (assert!).


##### `app_mcp_routing_clears_apps_when_apps_route_is_unavailable`  (lines 42–58)

```
fn app_mcp_routing_clears_apps_when_apps_route_is_unavailable()
```

**Purpose**: Checks the fallback behavior when app routing cannot be used. The policy should empty the app list but leave MCP servers, including name conflicts, intact.

**Data flow**: Creates mutable `apps` with one `AppDeclaration` and mutable `mcp_servers` containing both conflicting and non-conflicting keys, passes `Some(AuthMode::ApiKey)` and `plugin_active = true` into `apply_app_mcp_routing_policy` → observes in-place mutation → asserts `apps.is_empty()` and that both MCP keys remain.

**Call relations**: Invokes the shared fixture helper `mcp_servers`; it exercises the branch where auth disables the apps route, so the policy strips app exposure instead of rewriting MCP entries.

*Call graph*: calls 1 internal fn (mcp_servers); 3 external calls (assert!, assert_eq!, vec!).


##### `app_mcp_routing_preserves_apps_and_removes_conflicting_mcp_with_apps_route`  (lines 61–80)

```
fn app_mcp_routing_preserves_apps_and_removes_conflicting_mcp_with_apps_route()
```

**Purpose**: Confirms the main conflict-resolution path for active plugins under app-route-capable auth. App declarations should survive, and MCP servers with matching names should be removed.

**Data flow**: Builds mutable app declarations for `linear` and `notion` plus an MCP map containing `linear`, `notion`, and `docs`, then calls `apply_app_mcp_routing_policy` with `Some(AuthMode::Chatgpt)` and `plugin_active = true` → reads back the mutated collections → asserts both apps remain and only `docs` remains in MCP servers.

**Call relations**: Uses `mcp_servers` to seed the map and then validates the policy branch where app routing is active and conflicts are resolved in favor of apps.

*Call graph*: calls 1 internal fn (mcp_servers); 2 external calls (assert_eq!, vec!).


##### `app_mcp_routing_preserves_mcp_conflicts_when_plugin_is_inactive`  (lines 83–99)

```
fn app_mcp_routing_preserves_mcp_conflicts_when_plugin_is_inactive()
```

**Purpose**: Captures the inactive-plugin exception to conflict removal. Even with ChatGPT auth, an inactive plugin keeps its conflicting MCP servers.

**Data flow**: Creates one app and an MCP map with a conflicting `linear` server plus `docs`, then calls `apply_app_mcp_routing_policy` with `Some(AuthMode::Chatgpt)` and `plugin_active = false` → inspects the mutated collections → asserts the app remains and both MCP servers are still present.

**Call relations**: Uses `mcp_servers` and exercises the branch where plugin activity suppresses MCP conflict pruning despite auth allowing the apps route.

*Call graph*: calls 1 internal fn (mcp_servers); 2 external calls (assert_eq!, vec!).


### `core/src/plugins/test_support.rs`

`test` · `test setup and fixture loading`

This file is a compact test-support module for plugin-related integration tests. Its core job is to materialize on-disk fixtures under a supplied root path so tests can exercise the real plugin discovery and configuration-loading code against believable directory structures. The helpers write the exact files the plugin subsystem expects: a marketplace manifest at `.agents/plugins/marketplace.json`, per-plugin metadata under `plugins/<name>/.codex-plugin/plugin.json`, a sample skill markdown file, an MCP server definition in `.mcp.json`, an app connector definition in `.app.json`, and a plugin SHA marker in `.tmp/plugins.sha`.

A small primitive, `write_file`, centralizes the invariant that parent directories must exist before writing; it eagerly creates them and unwraps all I/O results, reflecting the assumption that test setup should fail fast rather than recover. `write_openai_curated_marketplace` builds a marketplace JSON document using the canonical curated marketplace name imported from `codex_core_plugins`, then populates matching plugin directories by calling `write_curated_plugin` for each listed plugin. Separate helpers enable plugin features in the config TOML and write either a fixed test SHA or a caller-supplied SHA.

The async `load_plugins_config` function complements the fixture writers by constructing a real `Config` via `ConfigBuilder`, pointing both `codex_home` and fallback working directory at the same test root. This keeps tests deterministic and self-contained, with no dependence on the caller's actual environment.

#### Function details

##### `write_file`  (lines 10–13)

```
fn write_file(path: &Path, contents: &str)
```

**Purpose**: Writes a text file to disk after ensuring its parent directory exists. It is the low-level primitive all other fixture writers use so tests can create nested plugin paths without manually preparing directories.

**Data flow**: Takes a target `&Path` and file `&str` contents. It reads the path's parent directory via `parent()`, creates that directory tree with `fs::create_dir_all`, then writes the provided contents with `fs::write`. It returns no value and mutates the filesystem at the requested location; any missing parent or I/O failure causes an immediate panic through `expect`/`unwrap`.

**Call relations**: This function sits at the bottom of the fixture-writing call flow. It is invoked by `write_curated_plugin`, `write_curated_plugin_sha_with`, `write_openai_curated_marketplace`, and `write_plugins_feature_config` whenever those higher-level helpers need to materialize a specific config or metadata file.

*Call graph*: called by 4 (write_curated_plugin, write_curated_plugin_sha_with, write_openai_curated_marketplace, write_plugins_feature_config); 3 external calls (parent, create_dir_all, write).


##### `write_curated_plugin`  (lines 15–51)

```
fn write_curated_plugin(root: &Path, plugin_name: &str)
```

**Purpose**: Creates a single curated plugin directory tree with the minimal metadata and content needed for plugin tests. The generated fixture includes plugin identity, one sample skill, one MCP server entry, and one app connector entry.

**Data flow**: Accepts a root directory and a plugin name. It derives `plugins/<plugin_name>` beneath the root, then writes four files there: `.codex-plugin/plugin.json` containing the plugin name and description, `skills/SKILL.md` with frontmatter for a sample skill, `.mcp.json` with a `sample-docs` HTTP MCP server, and `.app.json` with a `calendar` app mapped to `connector_calendar`. It returns no value and populates the filesystem under that plugin root.

**Call relations**: This helper is called by `write_openai_curated_marketplace` after the marketplace manifest is assembled, ensuring every plugin listed in the marketplace also exists on disk with matching local-path content. It delegates all actual file creation to `write_file` so directory creation and writes are handled consistently.

*Call graph*: calls 1 internal fn (write_file); called by 1 (write_openai_curated_marketplace); 2 external calls (join, format!).


##### `write_openai_curated_marketplace`  (lines 53–83)

```
fn write_openai_curated_marketplace(root: &Path, plugin_names: &[&str])
```

**Purpose**: Builds a curated marketplace fixture containing a list of local plugins and then creates each referenced plugin's on-disk contents. It gives tests a complete marketplace-plus-plugin installation source rooted in a temporary directory.

**Data flow**: Takes a root path and a slice of plugin-name string slices. It transforms the names into JSON objects whose source is `local` and whose path is `./plugins/<plugin_name>`, joins them into the `plugins` array of a marketplace JSON document named with `OPENAI_CURATED_MARKETPLACE_NAME`, and writes that document to `.agents/plugins/marketplace.json`. After writing the manifest, it iterates over the same names and calls `write_curated_plugin` for each one, producing the corresponding plugin directories and files. It returns no value and mutates the filesystem under both `.agents/plugins` and `plugins/`.

**Call relations**: This is the top-level fixture constructor in the file for marketplace-based tests. Nothing in the provided graph calls it, but within its own flow it first uses `write_file` to emit the marketplace manifest and then delegates per-plugin fixture creation to `write_curated_plugin` so the manifest's local references resolve to real content.

*Call graph*: calls 2 internal fn (write_curated_plugin, write_file); 2 external calls (join, format!).


##### `write_curated_plugin_sha`  (lines 85–87)

```
fn write_curated_plugin_sha(codex_home: &Path)
```

**Purpose**: Writes the standard test SHA marker used to simulate the installed curated plugin revision. It is a convenience wrapper so tests can opt into the canonical fixture SHA without repeating the constant.

**Data flow**: Accepts the Codex home path, reads the module constant `TEST_CURATED_PLUGIN_SHA`, and forwards both to `write_curated_plugin_sha_with`. It returns no value and indirectly writes `.tmp/plugins.sha` under the supplied home directory.

**Call relations**: This wrapper is called by `verified_plugin_install_completed_requires_installed_plugin` when that test needs the default installed-plugin SHA state. It delegates all actual formatting and file output to `write_curated_plugin_sha_with`.

*Call graph*: calls 1 internal fn (write_curated_plugin_sha_with); called by 1 (verified_plugin_install_completed_requires_installed_plugin).


##### `write_curated_plugin_sha_with`  (lines 89–91)

```
fn write_curated_plugin_sha_with(codex_home: &Path, sha: &str)
```

**Purpose**: Writes an explicit curated plugin SHA value into the temporary plugin-state file used by tests. It lets callers simulate arbitrary installed marketplace revisions rather than the module's default test SHA.

**Data flow**: Takes a Codex home path and a SHA string. It constructs the path `.tmp/plugins.sha` under that home, formats the SHA with a trailing newline, and writes it via `write_file`. It returns no value and updates the filesystem state that later plugin logic can read as the installed SHA marker.

**Call relations**: This function is reached either indirectly through `write_curated_plugin_sha` or directly by any test helper needing a custom SHA. It relies on `write_file` for directory creation and persistence, keeping the SHA-writing path consistent with the rest of the fixture utilities.

*Call graph*: calls 1 internal fn (write_file); called by 1 (write_curated_plugin_sha); 2 external calls (join, format!).


##### `write_plugins_feature_config`  (lines 93–100)

```
fn write_plugins_feature_config(codex_home: &Path)
```

**Purpose**: Creates a minimal `config.toml` that explicitly enables the plugins feature flag. Tests use it to ensure plugin code paths are active when the configuration system is loaded.

**Data flow**: Accepts the Codex home path, appends `CONFIG_TOML_FILE`, and writes a TOML snippet containing `[features]` and `plugins = true`. It returns no value and creates or overwrites the config file under the supplied home directory.

**Call relations**: This helper is called by `verified_plugin_install_completed_requires_installed_plugin` as part of preparing a plugin-enabled test environment. It delegates the actual file creation to `write_file`, which guarantees the config file's parent directory exists.

*Call graph*: calls 1 internal fn (write_file); called by 1 (verified_plugin_install_completed_requires_installed_plugin); 1 external calls (join).


##### `load_plugins_config`  (lines 102–109)

```
async fn load_plugins_config(codex_home: &Path) -> crate::config::Config
```

**Purpose**: Loads a real `crate::config::Config` from a test Codex home directory using the production configuration builder. It gives tests a fully built config object aligned with the fixture files they just wrote.

**Data flow**: Takes a Codex home path, clones it into owned `PathBuf`s, and feeds those into `ConfigBuilder::default()` by setting both `codex_home` and `fallback_cwd(Some(...))`. It then asynchronously calls `build().await`, expects success, and returns the resulting `crate::config::Config`. The function does not write state itself; it reads configuration from the filesystem rooted at the provided home path through the builder.

**Call relations**: No callers are listed in the provided graph, but this function serves as the read-side counterpart to the file's fixture writers. Rather than parsing files directly, it delegates to `ConfigBuilder` so tests exercise the same config-loading path used by the application.

*Call graph*: 2 external calls (to_path_buf, default).


### `core/src/plugins/discoverable_tests.rs`

`test` · `test execution`

This test file wraps the production discovery function with a few helpers that create a `PluginsManager`, optionally attach auth, and invoke `super::list_tool_suggest_discoverable_plugins`. The simple helpers separate concerns: one path creates a manager with default auth-less options, another allows auth injection, and a third accepts an already prepared manager so tests can pre-populate caches.

The largest test simulates remote global plugin discovery end to end. It starts a `wiremock::MockServer`, serves a `/ps/plugins/list?scope=GLOBAL` response containing multiple remote plugins with different availability/admin states, fetches and caches the global remote catalog, verifies that cached catalog data alone does not yet surface the curated remote plugin, then mocks `/ps/plugins/installed` for `GLOBAL`, `USER`, and `WORKSPACE`, builds the installed-plugin marketplaces cache, and confirms that `github@openai-curated-remote` appears with the expected mapped fields while unlisted or unavailable entries do not. It then rewrites config to disable that plugin and verifies filtering.

The remaining tests cover simpler local behavior: returning an empty list when the plugins feature is disabled, omitting plugins listed in `tool_suggest.disabled_tools`, and including explicitly configured curated plugin IDs with their expected description, MCP server names, and app connector IDs.

#### Function details

##### `list_discoverable_plugins`  (lines 14–20)

```
async fn list_discoverable_plugins(
    config: &crate::config::Config,
    loaded_plugin_app_connector_ids: &[String],
) -> anyhow::Result<Vec<DiscoverablePluginInfo>>
```

**Purpose**: Convenience wrapper that invokes discovery without authentication. It keeps the common local-plugin tests concise.

**Data flow**: It takes a config reference and loaded connector IDs, passes them with `None` auth into `list_discoverable_plugins_with_auth`, awaits the result, and returns `anyhow::Result<Vec<DiscoverablePluginInfo>>`. It does not mutate shared state itself.

**Call relations**: Several local-behavior tests call this when remote auth is irrelevant. It delegates all setup and discovery work to `list_discoverable_plugins_with_auth`.

*Call graph*: calls 1 internal fn (list_discoverable_plugins_with_auth); called by 3 (list_tool_suggest_discoverable_plugins_includes_configured_plugin_ids, list_tool_suggest_discoverable_plugins_omits_disabled_tool_suggestions, list_tool_suggest_discoverable_plugins_returns_empty_when_plugins_feature_disabled).


##### `list_discoverable_plugins_with_auth`  (lines 22–39)

```
async fn list_discoverable_plugins_with_auth(
    config: &crate::config::Config,
    auth: Option<&codex_login::CodexAuth>,
    loaded_plugin_app_connector_ids: &[String],
) -> anyhow::Result<Vec<Dis
```

**Purpose**: Creates a `PluginsManager` configured for the test Codex home and optional auth mode, then runs discovery. It is the standard helper for tests that need manager construction but not custom cache preparation.

**Data flow**: Inputs are config, optional auth, and loaded connector IDs. It reads `config.codex_home`, constructs `PluginsManager::new_with_options` with `Some(Product::Codex)` and `auth.map(CodexAuth::api_auth_mode)`, then forwards everything to `list_discoverable_plugins_with_manager_and_auth`. It returns the discovery result unchanged.

**Call relations**: Called by `list_discoverable_plugins` and available to tests needing auth-aware manager creation. It delegates actual discovery to the manager-accepting helper after constructing the manager.

*Call graph*: calls 2 internal fn (new_with_options, list_discoverable_plugins_with_manager_and_auth); called by 1 (list_discoverable_plugins).


##### `list_discoverable_plugins_with_manager_and_auth`  (lines 41–54)

```
async fn list_discoverable_plugins_with_manager_and_auth(
    config: &crate::config::Config,
    plugins_manager: &PluginsManager,
    auth: Option<&codex_login::CodexAuth>,
    loaded_plugin_app_con
```

**Purpose**: Thin helper that calls the production discovery function with a caller-supplied manager. This lets tests reuse a manager whose caches were populated earlier in the scenario.

**Data flow**: It accepts config, `&PluginsManager`, optional auth, and loaded connector IDs, then awaits `super::list_tool_suggest_discoverable_plugins(...)` and returns its `anyhow::Result<Vec<DiscoverablePluginInfo>>`. No additional transformation occurs.

**Call relations**: Used by the auth helper and by the remote-cache integration test after it prepares marketplace caches. It delegates directly to the production function under test.

*Call graph*: called by 2 (list_discoverable_plugins_with_auth, list_tool_suggest_discoverable_plugins_includes_cached_remote_global_plugins); 1 external calls (list_tool_suggest_discoverable_plugins).


##### `list_tool_suggest_discoverable_plugins_includes_cached_remote_global_plugins`  (lines 57–332)

```
async fn list_tool_suggest_discoverable_plugins_includes_cached_remote_global_plugins()
```

**Purpose**: End-to-end test for remote curated plugin discoverability once both the global catalog and installed-plugin marketplace caches are populated. It also verifies disabled-tool filtering for a remote curated plugin ID.

**Data flow**: The test creates a temp Codex home, writes config enabling plugins and remote plugins, starts a mock HTTP server, serves a remote global plugin list payload, creates dummy auth, loads config and points `chatgpt_base_url` at the mock server, constructs a `PluginsManager`, fetches and caches the global remote catalog, and runs discovery to assert the curated remote plugin is not yet present. It then mocks installed-plugin endpoints for all scopes, builds and caches remote installed marketplaces, reruns discovery to assert only `github@openai-curated-remote` appears among curated-remote IDs with exact expected fields, rewrites config to disable that plugin, reloads config, and verifies the plugin disappears.

**Call relations**: This test drives the production discovery adapter through realistic remote-plugin cache states. It relies on `list_discoverable_plugins_with_manager_and_auth` for the actual call under test and on plugin-manager cache-building APIs to establish preconditions.

*Call graph*: calls 4 internal fn (new, fetch_and_cache_global_remote_plugin_catalog, list_discoverable_plugins_with_manager_and_auth, create_dummy_chatgpt_auth_for_testing); 10 external calls (given, start, new, assert!, assert_eq!, load_plugins_config, write_file, format!, json!, tempdir).


##### `list_tool_suggest_discoverable_plugins_returns_empty_when_plugins_feature_disabled`  (lines 335–350)

```
async fn list_tool_suggest_discoverable_plugins_returns_empty_when_plugins_feature_disabled()
```

**Purpose**: Verifies that discovery returns no plugins when the plugins feature flag is off, even if curated marketplace data exists on disk. This confirms feature gating happens before local catalog contents matter.

**Data flow**: It creates a temp home, writes a curated marketplace containing `slack`, writes config with `[features] plugins = false`, loads config, calls `list_discoverable_plugins`, and asserts the result is an empty `Vec<DiscoverablePluginInfo>`. The test writes fixture files and inspects the returned vector.

**Call relations**: This test uses the no-auth helper because only local config gating is relevant. It exercises the production discovery path under a disabled-feature configuration.

*Call graph*: calls 2 internal fn (curated_plugins_repo_path, list_discoverable_plugins); 5 external calls (assert_eq!, load_plugins_config, write_file, write_openai_curated_marketplace, tempdir).


##### `list_tool_suggest_discoverable_plugins_omits_disabled_tool_suggestions`  (lines 353–373)

```
async fn list_tool_suggest_discoverable_plugins_omits_disabled_tool_suggestions()
```

**Purpose**: Checks that a plugin listed in `tool_suggest.disabled_tools` is filtered out of discoverable results. It validates the disabled-plugin ID set assembled by the production adapter.

**Data flow**: The test creates a temp home, writes a curated marketplace with `slack`, writes config enabling plugins and disabling `slack@openai-curated` under `tool_suggest.disabled_tools`, loads config, calls `list_discoverable_plugins`, and asserts the result is empty. It uses on-disk config and curated marketplace fixtures as inputs.

**Call relations**: This test targets the disabled-plugin filtering path in `list_tool_suggest_discoverable_plugins`. It delegates invocation to the no-auth helper.

*Call graph*: calls 2 internal fn (curated_plugins_repo_path, list_discoverable_plugins); 5 external calls (assert_eq!, load_plugins_config, write_file, write_openai_curated_marketplace, tempdir).


##### `list_tool_suggest_discoverable_plugins_includes_configured_plugin_ids`  (lines 376–407)

```
async fn list_tool_suggest_discoverable_plugins_includes_configured_plugin_ids()
```

**Purpose**: Verifies that explicitly configured discoverable plugin IDs are surfaced with the expected metadata from the curated marketplace. It checks the positive path for `tool_suggest.discoverables`.

**Data flow**: It creates a temp home, writes a curated marketplace with `sample`, writes config enabling plugins and listing `sample@openai-curated` in `tool_suggest.discoverables`, loads config, calls `list_discoverable_plugins`, and asserts the returned vector contains exactly one `DiscoverablePluginInfo` with the expected ID, description, skill flag, MCP server names, and app connector IDs. The test's outputs are assertions over the returned value.

**Call relations**: This test exercises the configured-plugin-ID input path assembled by the production adapter. It uses the no-auth helper because only local curated data is needed.

*Call graph*: calls 2 internal fn (curated_plugins_repo_path, list_discoverable_plugins); 5 external calls (assert_eq!, load_plugins_config, write_file, write_openai_curated_marketplace, tempdir).


### `core/src/plugins/mentions_tests.rs`

`test` · `test execution`

This test module defines two compact fixture builders and a set of focused unit tests around mention parsing. `text_input` creates `UserInput::Text` values with empty `text_elements`, while `plugin` constructs `PluginCapabilitySummary` fixtures with only the fields relevant to mention matching populated. The tests then exercise the production collectors with small, readable inputs.

For apps, the suite verifies that a markdown-style linked mention like `[$calendar](app://calendar)` is recognized, that the same app mentioned both in text and as a structured `UserInput::Mention` is deduplicated into a single `HashSet` entry, and that non-app paths such as `mcp://`, `skill://`, and filesystem paths are ignored entirely.

For plugins, the tests verify matching from structured `plugin://...` paths, matching from plaintext `@plugin` links, deduplication across structured and linked forms, and rejection of non-plugin paths. A particularly important edge case is the final test: plugin plaintext links must use the plugin sigil (`@`), so a dollar-prefixed link like `[$sample](plugin://sample@test)` is intentionally ignored. Together these tests document the parser's exact acceptance rules and prevent regressions in mention syntax handling.

#### Function details

##### `text_input`  (lines 10–15)

```
fn text_input(text: &str) -> UserInput
```

**Purpose**: Builds a `UserInput::Text` fixture from a plain string for mention-parsing tests. It always uses an empty `text_elements` vector.

**Data flow**: It takes `&str`, converts it to an owned `String`, constructs `UserInput::Text { text, text_elements: Vec::new() }`, and returns that enum value. It has no side effects.

**Call relations**: Several plugin-mention tests call this to create concise text-only inputs. It does not delegate to local helpers.

*Call graph*: called by 4 (collect_explicit_plugin_mentions_dedupes_structured_and_linked_mentions, collect_explicit_plugin_mentions_from_linked_text_mentions, collect_explicit_plugin_mentions_ignores_dollar_linked_plugin_mentions, collect_explicit_plugin_mentions_ignores_non_plugin_paths); 1 external calls (new).


##### `plugin`  (lines 17–26)

```
fn plugin(config_name: &str, display_name: &str) -> PluginCapabilitySummary
```

**Purpose**: Builds a minimal `PluginCapabilitySummary` fixture with the supplied config and display names. The remaining fields are fixed to simple defaults suitable for matching tests.

**Data flow**: It accepts `config_name` and `display_name`, converts them to owned strings, fills `description: None`, `has_skills: true`, and empty vectors for MCP servers and app connectors, then returns the struct. No external state is read or written.

**Call relations**: The plugin-mention tests use this helper to define the available plugin inventory and expected outputs. It is a pure fixture constructor.

*Call graph*: 1 external calls (new).


##### `collect_explicit_app_ids_from_linked_text_mentions`  (lines 29–35)

```
fn collect_explicit_app_ids_from_linked_text_mentions()
```

**Purpose**: Verifies that an app linked in plaintext markdown syntax is extracted as an explicit app ID. It covers the simplest positive app-mention case.

**Data flow**: The test builds a one-element input vector containing `text_input("use [$calendar](app://calendar)")`, calls `collect_explicit_app_ids`, and asserts the result equals `HashSet::from(["calendar".to_string()])`. Its only outputs are assertions.

**Call relations**: This test directly exercises the plaintext-path branch of `collect_explicit_app_ids`. It does not use additional local helpers beyond fixture construction.

*Call graph*: 3 external calls (assert_eq!, collect_explicit_app_ids, vec!).


##### `collect_explicit_app_ids_dedupes_structured_and_linked_mentions`  (lines 38–50)

```
fn collect_explicit_app_ids_dedupes_structured_and_linked_mentions()
```

**Purpose**: Checks that the same app mentioned in both plaintext and structured form appears only once in the result set. This validates deduplication across input channels.

**Data flow**: It constructs an input vector with one text link and one `UserInput::Mention` for `app://calendar`, calls `collect_explicit_app_ids`, and asserts the returned `HashSet` contains only `"calendar"`. The test reads no external state.

**Call relations**: This test targets the chain of structured mention paths plus plaintext mention paths inside `collect_explicit_app_ids`. It verifies the `HashSet`-based deduplication behavior.

*Call graph*: 3 external calls (assert_eq!, collect_explicit_app_ids, vec!).


##### `collect_explicit_app_ids_ignores_non_app_paths`  (lines 53–75)

```
fn collect_explicit_app_ids_ignores_non_app_paths()
```

**Purpose**: Verifies that only `app://...` paths are accepted as explicit app mentions. Other path kinds and plain file paths must be ignored.

**Data flow**: It builds input containing text links and structured mentions for `mcp://docs`, `skill://team/skill`, and `/tmp/file.txt`, calls `collect_explicit_app_ids`, and asserts the result is an empty `HashSet<String>`. No filesystem or network I/O occurs.

**Call relations**: This test exercises the `tool_kind_for_path == ToolMentionKind::App` filter in the production collector. It confirms that unrelated mention syntaxes do not leak into app selection.

*Call graph*: 3 external calls (assert_eq!, collect_explicit_app_ids, vec!).


##### `collect_explicit_plugin_mentions_from_structured_paths`  (lines 78–93)

```
fn collect_explicit_plugin_mentions_from_structured_paths()
```

**Purpose**: Verifies that a structured `UserInput::Mention` with a `plugin://...` path selects the matching plugin summary. It covers the direct structured-input plugin path.

**Data flow**: The test creates two plugin fixtures, passes a single structured plugin mention plus the plugin list into `collect_explicit_plugin_mentions`, and asserts the returned vector contains only the matching `sample@test` summary. It performs pure in-memory assertions.

**Call relations**: This test targets the structured mention branch of `collect_explicit_plugin_mentions`. It uses the `plugin` fixture helper to define both available and expected plugin summaries.

*Call graph*: 3 external calls (assert_eq!, collect_explicit_plugin_mentions, vec!).


##### `collect_explicit_plugin_mentions_from_linked_text_mentions`  (lines 96–108)

```
fn collect_explicit_plugin_mentions_from_linked_text_mentions()
```

**Purpose**: Checks that a plaintext linked plugin mention using the `@` sigil is recognized. This validates the special plugin-text parsing path distinct from ordinary tool mentions.

**Data flow**: It builds two plugin fixtures, creates input with `text_input("use [@sample](plugin://sample@test)")`, calls `collect_explicit_plugin_mentions`, and asserts the result is the single matching plugin summary. The test is entirely in-memory.

**Call relations**: This test exercises the `collect_tool_mentions_from_messages_with_sigil(..., PLUGIN_TEXT_MENTION_SIGIL)` branch inside the production collector. It depends on `text_input` for concise setup.

*Call graph*: calls 1 internal fn (text_input); 3 external calls (assert_eq!, collect_explicit_plugin_mentions, vec!).


##### `collect_explicit_plugin_mentions_dedupes_structured_and_linked_mentions`  (lines 111–129)

```
fn collect_explicit_plugin_mentions_dedupes_structured_and_linked_mentions()
```

**Purpose**: Verifies that the same plugin mentioned in both linked text and structured form is returned only once. It confirms deduplication by config name before filtering the plugin list.

**Data flow**: It creates two plugin fixtures, builds input containing both `[@sample](plugin://sample@test)` text and a structured `plugin://sample@test` mention, calls `collect_explicit_plugin_mentions`, and asserts the result vector contains only one `sample@test` summary. No external state is touched.

**Call relations**: This test targets the `HashSet<String>` of mentioned config names inside the production collector. It uses `text_input` for the plaintext half of the setup.

*Call graph*: calls 1 internal fn (text_input); 3 external calls (assert_eq!, collect_explicit_plugin_mentions, vec!).


##### `collect_explicit_plugin_mentions_ignores_non_plugin_paths`  (lines 132–143)

```
fn collect_explicit_plugin_mentions_ignores_non_plugin_paths()
```

**Purpose**: Checks that app, skill, and file paths do not produce plugin matches even when plugin inventory exists. This protects the path-kind filter in plugin mention extraction.

**Data flow**: It creates one plugin fixture, builds text input containing links to `app://calendar`, `skill://team/skill`, and `/tmp/file.txt`, calls `collect_explicit_plugin_mentions`, and asserts the result is an empty `Vec<PluginCapabilitySummary>`. The test is pure and side-effect free.

**Call relations**: This test exercises the `tool_kind_for_path == ToolMentionKind::Plugin` filter in the production collector. It uses `text_input` to supply mixed non-plugin links.

*Call graph*: calls 1 internal fn (text_input); 3 external calls (assert_eq!, collect_explicit_plugin_mentions, vec!).


##### `collect_explicit_plugin_mentions_ignores_dollar_linked_plugin_mentions`  (lines 146–155)

```
fn collect_explicit_plugin_mentions_ignores_dollar_linked_plugin_mentions()
```

**Purpose**: Verifies that plugin plaintext links using the wrong sigil (`$`) are ignored. This documents the intentional syntax rule that plaintext plugin links must use `@`.

**Data flow**: It creates one plugin fixture, builds input with `text_input("use [$sample](plugin://sample@test)")`, calls `collect_explicit_plugin_mentions`, and asserts the result is an empty vector. No external state is involved.

**Call relations**: This test specifically targets the distinction between `PLUGIN_TEXT_MENTION_SIGIL` and the default tool sigil in the production parser. It ensures plugin mention extraction does not accidentally accept dollar-prefixed plugin links.

*Call graph*: calls 1 internal fn (text_input); 3 external calls (assert_eq!, collect_explicit_plugin_mentions, vec!).


### `core/src/plugins/render_tests.rs`

`test` · `test execution`

This file is a focused test module for the plugin rendering logic imported from the parent module via `use super::*`. It verifies two important behavioral contracts of `render_plugins_section`: first, that passing no plugin summaries produces `None` rather than an empty wrapper string; second, that when at least one `PluginCapabilitySummary` is present, the renderer emits a `<plugins_instructions>` block containing only stable usage guidance and does not enumerate the plugin itself. The second test constructs a concrete `PluginCapabilitySummary` with `config_name`, `display_name`, `description`, and `has_skills` populated, while filling all remaining fields from `PluginCapabilitySummary::default()`. That setup is deliberate: it proves the renderer can receive realistic plugin metadata without leaking those details into the rendered section. The expected output is asserted as a full multiline literal, so the test locks down exact formatting, headings, bullet wording, and XML-like wrapper tags. By using `pretty_assertions::assert_eq`, failures produce readable diffs, which is especially useful because the contract here is textual and whitespace-sensitive. Overall, this file acts as a regression suite for a design choice: plugin instructions are always generic guidance, not a per-plugin listing.

#### Function details

##### `render_plugins_section_returns_none_for_empty_plugins`  (lines 5–7)

```
fn render_plugins_section_returns_none_for_empty_plugins()
```

**Purpose**: Checks the renderer's base case: an empty slice of plugin summaries must suppress the section entirely by returning `None`.

**Data flow**: It passes an empty slice literal `&[]` into `render_plugins_section`, reads the returned `Option<String>`-like value, and compares it against `None` with `assert_eq!`. It does not mutate shared state or produce outputs beyond the test assertion result.

**Call relations**: This function is invoked by the Rust test harness as a standalone unit test. Its only downstream action is the equality assertion around the parent module's renderer, exercising the no-plugins branch and confirming that no placeholder text is emitted.

*Call graph*: 1 external calls (assert_eq!).


##### `render_plugins_section_keeps_plugin_usage_guidance_without_listing_plugins`  (lines 10–23)

```
fn render_plugins_section_keeps_plugin_usage_guidance_without_listing_plugins()
```

**Purpose**: Verifies that providing at least one plugin summary causes the renderer to return the canonical plugin-instructions block, while omitting any plugin-specific listing details.

**Data flow**: It builds a one-element slice containing a `PluginCapabilitySummary` with selected fields explicitly set and all others sourced from `PluginCapabilitySummary::default()`. The slice is passed to `render_plugins_section`; the returned optional string is unwrapped with `expect`, then compared to a hard-coded multiline expected string using `assert_eq!`.

**Call relations**: This function is also run directly by the test harness. It drives the renderer through its non-empty-input path, relying on `default` to create a realistic summary object and then asserting the exact rendered text so regressions in wording, formatting, or accidental plugin enumeration are caught immediately.

*Call graph*: 2 external calls (assert_eq!, default).


### `core/src/connectors_tests.rs`

`test` · `test`

This test module validates the behavior implemented in `connectors.rs` using lightweight fixture builders and temporary config homes. The helper constructors are intentionally concrete: `app` creates a baseline `AppInfo` with `is_enabled = true` and `is_accessible = false`, `plugin_names` converts string slices into owned plugin-name vectors, `test_tool_definition` builds an `rmcp::model::Tool`, and `codex_app_tool` assembles a `ToolInfo` for the `CODEX_APPS_MCP_SERVER_NAME` server with connector id, optional connector name, namespace, and plugin provenance. `with_accessible_connectors_cache_cleared` snapshots and restores the global cache around a closure so cache-writing tests do not leak state.

The tests cover several subtle invariants. Connector aggregation must preserve namespace descriptions and deduplicate/sort plugin display names as exposed through `accessible_connectors_from_mcp_tools`. Cache refresh must write the latest installed apps into the in-memory cache. Reviewer selection must prefer app-specific settings over app defaults over global config, but enterprise requirements can veto app-level overrides and force fallback to the global reviewer. `with_app_enabled_state` must not accidentally re-enable an unrelated connector that was already disabled. Tool-suggest tests verify that configured connector discoverables are included, disabled connector suggestions are removed, empty directory cache falls back to connector-id-only plugin connector metadata, and loaded plugin app connector ids are surfaced even without explicit config entries.

#### Function details

##### `app`  (lines 26–42)

```
fn app(id: &str) -> AppInfo
```

**Purpose**: Creates a minimal `AppInfo` fixture with the given id and name and otherwise default-like empty metadata. It is used to make enablement tests concise and explicit.

**Data flow**: Takes `&str id`, allocates owned strings for `id` and `name`, fills all optional metadata fields with `None`, sets `is_accessible` to `false`, `is_enabled` to `true`, and `plugin_display_names` to an empty vector, then returns the `AppInfo`.

**Call relations**: It is used by `with_app_enabled_state_preserves_unrelated_disabled_connector` to build baseline connector fixtures before mutating their enabled flags.

*Call graph*: called by 1 (with_app_enabled_state_preserves_unrelated_disabled_connector); 1 external calls (new).


##### `plugin_names`  (lines 44–46)

```
fn plugin_names(names: &[&str]) -> Vec<String>
```

**Purpose**: Converts a borrowed slice of plugin name literals into owned `Vec<String>` values for fixture construction. It keeps test setup readable where plugin provenance matters.

**Data flow**: Accepts `&[&str]`, maps each element through `ToString::to_string`, collects into `Vec<String>`, and returns that vector.

**Call relations**: It is used by `codex_app_tool` so multiple tests can specify plugin display names as simple string slices.

*Call graph*: called by 1 (codex_app_tool).


##### `test_tool_definition`  (lines 48–50)

```
fn test_tool_definition(tool_name: &str) -> Tool
```

**Purpose**: Builds a minimal `rmcp::model::Tool` fixture with an empty JSON schema object. It isolates the boilerplate needed for `ToolInfo` construction.

**Data flow**: Takes `&str tool_name`, creates a default `JsonObject`, wraps it in `Arc`, and passes it to `Tool::new_with_raw` with the owned tool name and no description. It returns the constructed `Tool`.

**Call relations**: It is called by `codex_app_tool` to populate the `tool` field of synthetic `ToolInfo` values.

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

**Purpose**: Constructs a `ToolInfo` fixture representing a tool exposed by the Codex Apps MCP server. It optionally derives a connector-specific namespace from the connector name and attaches plugin display names.

**Data flow**: Inputs are tool name, connector id, optional connector name, and plugin display-name slice. It computes `callable_namespace` either as `mcp__codex_apps__{sanitized_connector_name}` or just the server name, builds the embedded `Tool` via `test_tool_definition`, converts plugin names with `plugin_names`, and returns a fully populated `ToolInfo` with `connector_id` set.

**Call relations**: It is a local fixture helper used by tests that need realistic Codex Apps MCP tool rows, especially aggregation and cache-refresh tests.

*Call graph*: calls 2 internal fn (plugin_names, test_tool_definition).


##### `with_accessible_connectors_cache_cleared`  (lines 77–90)

```
fn with_accessible_connectors_cache_cleared(f: impl FnOnce() -> R) -> R
```

**Purpose**: Runs a closure with the global accessible-connectors cache temporarily emptied, then restores the previous cache contents afterward. This prevents tests from depending on or polluting shared process state.

**Data flow**: Takes a closure `f`, locks `ACCESSIBLE_CONNECTORS_CACHE` to `take()` the current cached value, executes `f`, then locks the cache again and restores the saved value before returning the closure's result.

**Call relations**: It is used by `refresh_accessible_connectors_cache_from_mcp_tools_writes_latest_installed_apps` so that cache assertions observe only the writes performed by that test.

*Call graph*: called by 1 (refresh_accessible_connectors_cache_from_mcp_tools_writes_latest_installed_apps).


##### `accessible_connectors_from_mcp_tools_carries_plugin_display_names`  (lines 93–141)

```
fn accessible_connectors_from_mcp_tools_carries_plugin_display_names()
```

**Purpose**: Verifies that connector aggregation from MCP tools preserves plugin provenance and ignores tools from non-app MCP servers. It also checks connector naming and install URL derivation for merged app output.

**Data flow**: The test builds a mixed `Vec<ToolInfo>` containing two Codex Apps tools for the same connector and one unrelated tool, calls `accessible_connectors_from_mcp_tools`, and asserts that the result is a single `AppInfo` for `calendar` with merged plugin display names and the expected install URL.

**Call relations**: This test directly exercises `accessible_connectors_from_mcp_tools` behavior using the local `codex_app_tool` fixture helper.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `refresh_accessible_connectors_cache_from_mcp_tools_writes_latest_installed_apps`  (lines 144–208)

```
async fn refresh_accessible_connectors_cache_from_mcp_tools_writes_latest_installed_apps()
```

**Purpose**: Checks that refreshing the cache from MCP tools writes the latest accessible connectors into the global cache when the Apps feature is enabled. It also confirms that the cached entries preserve plugin display names and include multiple connectors.

**Data flow**: The test creates a temporary Codex home, builds config, enables `Feature::Apps`, computes the cache key, constructs tool fixtures, clears the cache around a call to `refresh_accessible_connectors_cache_from_mcp_tools`, then reads the cache back with `read_cached_accessible_connectors` and asserts the exact `Vec<AppInfo>` contents.

**Call relations**: It exercises the interaction between `refresh_accessible_connectors_cache_from_mcp_tools`, cache-key generation, and cache reads, while isolating global state with `with_accessible_connectors_cache_cleared`.

*Call graph*: calls 1 internal fn (with_accessible_connectors_cache_cleared); 4 external calls (assert_eq!, default, tempdir, vec!).


##### `accessible_connectors_from_mcp_tools_preserves_description`  (lines 211–247)

```
fn accessible_connectors_from_mcp_tools_preserves_description()
```

**Purpose**: Verifies that a connector's namespace description on `ToolInfo` becomes the connector description in aggregated `AppInfo`. This guards against losing descriptive metadata during tool-to-connector collapse.

**Data flow**: The test constructs a single `ToolInfo` with `namespace_description = Some("Plan events")`, calls `accessible_connectors_from_mcp_tools`, and asserts that the resulting `AppInfo` contains the same description and expected install URL.

**Call relations**: It directly targets `accessible_connectors_from_mcp_tools` and complements the plugin-provenance aggregation test by focusing on description preservation.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `app_approvals_reviewer_uses_app_then_default_then_global`  (lines 250–312)

```
async fn app_approvals_reviewer_uses_app_then_default_then_global()
```

**Purpose**: Confirms the precedence order for approvals reviewer selection: app-specific reviewer first, then apps default reviewer, then global reviewer for non-app servers. It runs the same assertions across two reviewer combinations.

**Data flow**: For each tuple of reviewer strings and expected enum values, the test writes a temporary `config.toml`, builds config, calls `mcp_approvals_reviewer` for a configured app connector, an unconfigured app connector, no connector id, and a non-app server, and asserts the returned `ApprovalsReviewer` values.

**Call relations**: It exercises `mcp_approvals_reviewer` against real config parsing via `ConfigBuilder`, validating the branching logic for app-specific, default, and global reviewer selection.

*Call graph*: 5 external calls (assert_eq!, default, format!, write, tempdir).


##### `default_app_approvals_reviewer_respects_global_reviewer_requirements`  (lines 315–342)

```
async fn default_app_approvals_reviewer_respects_global_reviewer_requirements()
```

**Purpose**: Verifies that an apps default reviewer setting is ignored when enterprise requirements disallow it, causing fallback to the globally allowed reviewer. This protects requirement enforcement over local app defaults.

**Data flow**: The test writes config with global `auto_review` and apps default `user`, builds config with a cloud bundle requiring `allowed_approvals_reviewers = ["auto_review"]`, calls `mcp_approvals_reviewer` for an app connector, and asserts that the result is `ApprovalsReviewer::AutoReview`.

**Call relations**: It targets the requirements-check branch inside `mcp_approvals_reviewer`, using `CloudConfigBundleFixture::loader_with_enterprise_requirement` to inject the restriction.

*Call graph*: calls 1 internal fn (loader_with_enterprise_requirement); 4 external calls (assert_eq!, default, write, tempdir).


##### `app_approvals_reviewer_respects_global_reviewer_requirements`  (lines 345–372)

```
async fn app_approvals_reviewer_respects_global_reviewer_requirements()
```

**Purpose**: Verifies that a connector-specific app reviewer is also blocked by enterprise requirements when not allowed, forcing fallback to the global reviewer. It is the app-specific counterpart to the default-reviewer requirements test.

**Data flow**: The test writes config with global `auto_review` and app-specific `user`, builds config with enterprise requirements allowing only `auto_review`, calls `mcp_approvals_reviewer` for the configured connector, and asserts that the global reviewer is returned.

**Call relations**: It exercises the same requirement gate in `mcp_approvals_reviewer` but through the connector-specific reviewer lookup path.

*Call graph*: calls 1 internal fn (loader_with_enterprise_requirement); 4 external calls (assert_eq!, default, write, tempdir).


##### `with_app_enabled_state_preserves_unrelated_disabled_connector`  (lines 375–410)

```
async fn with_app_enabled_state_preserves_unrelated_disabled_connector()
```

**Purpose**: Checks that applying app enablement rules does not accidentally re-enable a connector that was already disabled when requirements only mention another connector. This guards against broad defaulting side effects.

**Data flow**: The test builds config, replaces its `config_layer_stack` with one containing requirements that disable `connector_drive`, creates `slack` and `drive` `AppInfo` fixtures with `is_enabled = false`, calls `with_app_enabled_state` on a vector containing `slack` and a fresh enabled drive fixture, and asserts that both returned connectors are disabled as expected.

**Call relations**: It directly exercises `with_app_enabled_state`, using the local `app` helper and a synthetic `ConfigLayerStack` to isolate requirements behavior.

*Call graph*: calls 2 internal fn (new, app); 7 external calls (from, default, new, default, assert_eq!, default, tempdir).


##### `tool_suggest_connector_ids_include_configured_tool_suggest_discoverables`  (lines 413–437)

```
async fn tool_suggest_connector_ids_include_configured_tool_suggest_discoverables()
```

**Purpose**: Verifies that configured connector discoverables are included in the tool-suggest connector id set, while non-connector discoverables and blank connector ids do not affect the expected result. It checks the config-driven inclusion path.

**Data flow**: The test writes a config file with mixed `tool_suggest.discoverables`, builds config, calls `tool_suggest_connector_ids(&config, &[])`, and asserts that the returned `HashSet<String>` contains only the configured connector id of interest.

**Call relations**: It targets `tool_suggest_connector_ids` using real config parsing to validate discoverable filtering by kind.

*Call graph*: 4 external calls (assert_eq!, default, write, tempdir).


##### `tool_suggest_connector_ids_exclude_disabled_tool_suggestions`  (lines 440–466)

```
async fn tool_suggest_connector_ids_exclude_disabled_tool_suggestions()
```

**Purpose**: Verifies that connector ids listed in `tool_suggest.disabled_tools` are removed from the discoverable connector id set even if they also appear in configured discoverables. This checks the disablement override.

**Data flow**: The test writes config with two connector discoverables and one disabled connector tool, builds config, calls `tool_suggest_connector_ids`, and asserts that only the non-disabled connector id remains in the returned set.

**Call relations**: It directly exercises the retain/filter stage inside `tool_suggest_connector_ids`.

*Call graph*: 4 external calls (assert_eq!, default, write, tempdir).


##### `tool_suggest_uses_connector_id_fallback_when_directory_cache_is_empty`  (lines 469–508)

```
async fn tool_suggest_uses_connector_id_fallback_when_directory_cache_is_empty()
```

**Purpose**: Checks that tool suggestion still exposes a discoverable connector when directory metadata is absent by falling back to connector-id-derived app info. This ensures tool suggestion works without a populated directory cache.

**Data flow**: The test writes config enabling apps and configuring one connector discoverable, builds config, creates dummy Codex auth and a `PluginsManager`, calls `list_tool_suggest_discoverable_tools_with_auth` with no accessible connectors and no loaded plugin app ids, and asserts that the result is a single `DiscoverableTool` built from `plugin_connector_to_app_info("connector_gmail")`.

**Call relations**: It exercises the interaction between `list_tool_suggest_discoverable_tools_with_auth` and the connector-id fallback path in merged plugin connectors when cached directory connectors are empty.

*Call graph*: calls 2 internal fn (new, create_dummy_chatgpt_auth_for_testing); 4 external calls (assert_eq!, default, write, tempdir).


##### `tool_suggest_includes_connectors_from_loaded_plugin_apps`  (lines 511–546)

```
async fn tool_suggest_includes_connectors_from_loaded_plugin_apps()
```

**Purpose**: Verifies that connector ids contributed by already loaded plugin apps are included in tool suggestion even without explicit config discoverables. This covers the plugin-app input path into connector suggestion.

**Data flow**: The test writes config enabling apps, builds config, creates dummy auth, prepares one loaded plugin app connector id, constructs a `PluginsManager`, calls `list_tool_suggest_discoverable_tools_with_auth` with that loaded id, and asserts that the result contains the corresponding fallback `DiscoverableTool`.

**Call relations**: It exercises `list_tool_suggest_discoverable_tools_with_auth` together with `tool_suggest_connector_ids`, specifically validating that loaded plugin app connector ids seed the discoverable connector set.

*Call graph*: calls 2 internal fn (new, create_dummy_chatgpt_auth_for_testing); 5 external calls (assert_eq!, default, write, tempdir, vec!).


### `tools/src/request_plugin_install_tests.rs`

`test` · `test execution`

This file is a focused regression suite for the plugin-install approval flow. Each test constructs concrete `RequestPluginInstallArgs` plus a realistic `DiscoverableTool` variant and then compares the produced value against a fully spelled-out expected struct. The first two tests validate the outer `McpServerElicitationRequestParams` shape: thread and turn identifiers are preserved, the server name is copied through, the request is always a `Form`, the message text matches the suggestion text, and the requested schema is an empty object schema with no required fields. The important detail is the `meta` JSON payload: connector installs must include `tool_name` and `install_url` but leave `remote_plugin_id` and `app_connector_ids` unset, while plugin installs must omit `install_url` and instead inject `remote_plugin_id` plus the plugin’s connector dependencies. A separate test checks the lower-level `RequestPluginInstallMeta` builder directly, ensuring the approval-kind and persistence constants are embedded exactly. The last two tests cover post-install verification helpers using `AppInfo.is_accessible` as the decisive signal: one helper succeeds only when a specific connector id is present and accessible, and the other succeeds only when every expected connector id appears in the accessible set.

#### Function details

##### `build_request_plugin_install_elicitation_request_uses_expected_shape`  (lines 7–73)

```
fn build_request_plugin_install_elicitation_request_uses_expected_shape()
```

**Purpose**: Builds a connector-install request and asserts that the full elicitation envelope matches the expected serialized shape. It checks both top-level routing fields and the connector-specific metadata embedded in `meta`.

**Data flow**: Creates `RequestPluginInstallArgs` for a connector and a `DiscoverableTool::Connector` wrapping an `AppInfo` with id, name, and `install_url`. Passes those values, along with server/thread/turn ids and a user-facing message, into the request builder; then compares the returned `McpServerElicitationRequestParams` against an expected value containing a `Form` request, empty object schema, and `RequestPluginInstallMeta` JSON.

**Call relations**: This is a standalone unit test invoked by the Rust test harness. It exercises the connector branch of the production request-construction logic and does not delegate further beyond constructing fixtures and asserting equality.

*Call graph*: 4 external calls (new, new, assert_eq!, Connector).


##### `build_request_plugin_install_elicitation_request_injects_plugin_metadata`  (lines 76–131)

```
fn build_request_plugin_install_elicitation_request_injects_plugin_metadata()
```

**Purpose**: Verifies that plugin installs populate plugin-only metadata fields in the elicitation request. In particular, it checks propagation of `remote_plugin_id` and `app_connector_ids` while leaving `install_url` absent.

**Data flow**: Constructs plugin-oriented `RequestPluginInstallArgs` and a `DiscoverableTool::Plugin` containing a `DiscoverablePluginInfo` with MCP server names and connector ids. Calls the request builder with those inputs and asserts that the returned request contains the expected `RequestPluginInstallMeta` JSON, including `tool_type = Plugin`, the plugin display name, `remote_plugin_id`, and connector dependency ids.

**Call relations**: The test harness runs this as the plugin counterpart to the connector-shape test. Its role is to pin the metadata branching behavior of the production builder when the discoverable tool is a plugin rather than a connector.

*Call graph*: 4 external calls (new, assert_eq!, Plugin, vec!).


##### `build_request_plugin_install_meta_uses_expected_shape`  (lines 134–176)

```
fn build_request_plugin_install_meta_uses_expected_shape()
```

**Purpose**: Checks the lower-level metadata builder independently of the outer elicitation request wrapper. It ensures the metadata struct fields are filled from a connector tool exactly as expected.

**Data flow**: Creates a `DiscoverableTool::Connector` around an `AppInfo` for Gmail, then calls the metadata builder with explicit tool type, action type, and suggestion reason. The returned `RequestPluginInstallMeta` is compared against a literal expected struct containing approval constants, connector id/name, suggestion text, and connector `install_url`.

**Call relations**: This test isolates the metadata-construction helper so failures can distinguish inner metadata bugs from outer request-envelope bugs. It is invoked directly by the test harness and serves as a narrower regression check than the full request tests.

*Call graph*: 4 external calls (new, new, assert_eq!, Connector).


##### `verified_connector_install_completed_requires_accessible_connector`  (lines 179–204)

```
fn verified_connector_install_completed_requires_accessible_connector()
```

**Purpose**: Confirms that connector-install completion is recognized only for connectors marked accessible. It also verifies that unrelated connector ids do not produce false positives.

**Data flow**: Builds a one-element `Vec<AppInfo>` where the `calendar` connector has `is_accessible = true`. Calls the completion predicate once with `calendar` and once with `gmail`, asserting true for the matching accessible id and false for the missing id.

**Call relations**: This test is run by the test harness to pin the semantics of the completion helper. It targets the helper’s key invariant: accessibility, not merely presence of some connector record, is what counts as completed.

*Call graph*: 2 external calls (assert!, vec!).


##### `all_requested_connectors_picked_up_requires_every_expected_connector`  (lines 207–232)

```
fn all_requested_connectors_picked_up_requires_every_expected_connector()
```

**Purpose**: Verifies that the aggregate connector check succeeds only when every requested connector id is represented in the accessible connector list. It guards against partial success being treated as complete.

**Data flow**: Creates a single accessible `calendar` connector and passes two different expected-id slices into the aggregate predicate: first just `calendar`, then `calendar` plus `gmail`. The function’s boolean result is asserted to be true for the complete match and false when one expected connector is absent.

**Call relations**: The test harness invokes this as the multi-connector counterpart to the single-connector completion test. It validates the all-or-nothing behavior expected by higher-level plugin-install flows that depend on multiple connectors.

*Call graph*: 2 external calls (assert!, vec!).


### Skills loading and extension behavior
These tests cover skill parsing and invocation from the core loader and manager up through executor-aware and extension-provided skill catalogs.

### `core-skills/src/injection_tests.rs`

`test` · `test`

This test module builds small `SkillMetadata` fixtures and `UserInput` arrays to pin down the behavior of `injection.rs`. The helpers keep tests concise: `make_skill` constructs a user-scoped skill with a synthetic absolute `SKILL.md` path, `set` converts expected string slices into `HashSet<&str>` for parser assertions, `assert_mentions` compares the parser’s internal `names` and `paths` sets directly, `linked_skill_mention` formats markdown-style linked mentions using test paths, and `collect_mentions` is a thin wrapper around `collect_explicit_skill_mentions`.

The first group of tests targets lexical parsing. They verify exact mention boundaries, end-of-string handling, resilience to many `$` characters, linked mention syntax requirements, whitespace trimming around linked paths, stopping at non-name characters like `.`, preserving namespaced forms such as `slack:search`, and suppressing common environment variables. The second group targets selection semantics over actual skill inventories. These tests show that output order follows the original `skills` slice rather than mention order, structured `UserInput::Skill` entries are processed first, invalid or disabled structured selections still block plain-name fallback, duplicate linked paths are deduped, ambiguous duplicate names are rejected, explicit linked paths override ambiguous names, connector slug collisions suppress plain-name matches but not explicit path matches, disabled linked paths are skipped, and missing linked paths do not fall back to plain-name resolution.

Together these tests document the subtle invariants in the selector: path-based references are authoritative, plain names are conservative, and deduplication happens by path and name while preserving legacy ordering semantics.

#### Function details

##### `make_skill`  (lines 9–21)

```
fn make_skill(name: &str, path: &str) -> SkillMetadata
```

**Purpose**: Creates a minimal `SkillMetadata` fixture with a chosen name and absolute test path.

**Data flow**: Takes a skill name and Unix-style path string, converts them into owned strings and an absolute `AbsolutePathBuf`, fills the remaining metadata fields with defaults like `None` and `SkillScope::User`, and returns the struct.

**Call relations**: Used by most selection tests to build compact skill inventories without repeating boilerplate.

*Call graph*: called by 13 (collect_explicit_skill_mentions_allows_explicit_path_with_connector_conflict, collect_explicit_skill_mentions_dedupes_by_path, collect_explicit_skill_mentions_prefers_linked_path_over_name, collect_explicit_skill_mentions_prefers_resource_path, collect_explicit_skill_mentions_prioritizes_structured_inputs, collect_explicit_skill_mentions_skips_ambiguous_name, collect_explicit_skill_mentions_skips_disabled_structured_and_blocks_plain_fallback, collect_explicit_skill_mentions_skips_invalid_structured_and_blocks_plain_fallback, collect_explicit_skill_mentions_skips_missing_path_with_no_fallback, collect_explicit_skill_mentions_skips_missing_path_without_fallback (+3 more)); 2 external calls (test_path_buf, format!).


##### `set`  (lines 23–25)

```
fn set(items: &'a [&'a str]) -> HashSet<&'a str>
```

**Purpose**: Builds a `HashSet<&str>` from a slice of expected string literals for parser assertions.

**Data flow**: Copies the input slice items into a new `HashSet` and returns it.

**Call relations**: Supports `assert_mentions` so tests compare unordered mention sets cleanly.


##### `assert_mentions`  (lines 27–31)

```
fn assert_mentions(text: &str, expected_names: &[&str], expected_paths: &[&str])
```

**Purpose**: Asserts that `extract_tool_mentions` returns exactly the expected mention names and linked paths for one text sample.

**Data flow**: Parses the input text with `extract_tool_mentions`, converts expected names and paths into sets via `set`, and compares them to `mentions.names` and `mentions.paths` with `assert_eq!`.

**Call relations**: Called by the parser-focused tests as the common assertion harness.

*Call graph*: called by 6 (extract_tool_mentions_handles_plain_and_linked_mentions, extract_tool_mentions_keeps_plugin_skill_namespaces, extract_tool_mentions_requires_link_syntax, extract_tool_mentions_skips_common_env_vars, extract_tool_mentions_stops_at_non_name_chars, extract_tool_mentions_trims_linked_paths_and_allows_spacing); 1 external calls (assert_eq!).


##### `linked_skill_mention`  (lines 33–35)

```
fn linked_skill_mention(name: &str, unix_path: &str) -> String
```

**Purpose**: Formats a markdown linked mention string pointing at a test skill path.

**Data flow**: Takes a mention name and Unix path, converts the path through `test_path_buf(...).display()`, interpolates both into the `[$name](path)` syntax, and returns the resulting `String`.

**Call relations**: Used by tests that need exact linked-path mentions rather than plain `$name` text.

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

**Purpose**: Thin wrapper that invokes the production explicit-skill selector with test inputs.

**Data flow**: Passes through `UserInput` slices, skill lists, disabled paths, and connector slug counts to `collect_explicit_skill_mentions`, returning the selected skills.

**Call relations**: Central helper for the selection-behavior tests.

*Call graph*: called by 13 (collect_explicit_skill_mentions_allows_explicit_path_with_connector_conflict, collect_explicit_skill_mentions_dedupes_by_path, collect_explicit_skill_mentions_prefers_linked_path_over_name, collect_explicit_skill_mentions_prefers_resource_path, collect_explicit_skill_mentions_prioritizes_structured_inputs, collect_explicit_skill_mentions_skips_ambiguous_name, collect_explicit_skill_mentions_skips_disabled_structured_and_blocks_plain_fallback, collect_explicit_skill_mentions_skips_invalid_structured_and_blocks_plain_fallback, collect_explicit_skill_mentions_skips_missing_path_with_no_fallback, collect_explicit_skill_mentions_skips_missing_path_without_fallback (+3 more)).


##### `text_mentions_skill_requires_exact_boundary`  (lines 47–68)

```
fn text_mentions_skill_requires_exact_boundary()
```

**Purpose**: Verifies that the test-only boundary checker accepts exact `$name` mentions and rejects longer identifiers sharing the same prefix.

**Data flow**: Calls `text_mentions_skill` with several positive and negative strings and asserts the expected booleans.

**Call relations**: Documents the mention token boundary rule used by the parser helpers.

*Call graph*: 1 external calls (assert_eq!).


##### `text_mentions_skill_handles_end_boundary_and_near_misses`  (lines 71–78)

```
fn text_mentions_skill_handles_end_boundary_and_near_misses()
```

**Purpose**: Checks end-of-string matching and later exact matches after earlier near misses.

**Data flow**: Runs `text_mentions_skill` against strings where the target appears at the end, as a prefix of another token, and later as an exact token, then asserts results.

**Call relations**: Complements the previous boundary test with additional scan-order cases.

*Call graph*: 1 external calls (assert_eq!).


##### `text_mentions_skill_handles_many_dollars_without_looping`  (lines 81–85)

```
fn text_mentions_skill_handles_many_dollars_without_looping()
```

**Purpose**: Ensures the boundary checker remains linear and returns false on long runs of `$` characters with no valid mention.

**Data flow**: Builds a string containing 256 dollar signs followed by non-mention text, calls `text_mentions_skill`, and asserts `false`.

**Call relations**: Guards against pathological scanning behavior in the test helper.

*Call graph*: 2 external calls (assert_eq!, format!).


##### `extract_tool_mentions_handles_plain_and_linked_mentions`  (lines 88–94)

```
fn extract_tool_mentions_handles_plain_and_linked_mentions()
```

**Purpose**: Confirms the parser collects both plain `$name` mentions and linked `[$name](path)` mentions from one string.

**Data flow**: Calls `assert_mentions` with text containing one plain and one linked mention and expected name/path sets.

**Call relations**: Exercises the main happy path of `extract_tool_mentions`.

*Call graph*: calls 1 internal fn (assert_mentions).


##### `extract_tool_mentions_skips_common_env_vars`  (lines 97–101)

```
fn extract_tool_mentions_skips_common_env_vars()
```

**Purpose**: Verifies that environment-variable-like tokens are ignored in both plain and linked forms.

**Data flow**: Runs `assert_mentions` on texts containing `$PATH`, `[$HOME](...)`, and `$XDG_CONFIG_HOME` alongside real mentions, expecting only the real tool names.

**Call relations**: Pins down the `is_common_env_var` filter.

*Call graph*: calls 1 internal fn (assert_mentions).


##### `extract_tool_mentions_requires_link_syntax`  (lines 104–108)

```
fn extract_tool_mentions_requires_link_syntax()
```

**Purpose**: Checks that only the exact linked mention syntax captures a path, while malformed variants fall back to plain-name parsing or nothing.

**Data flow**: Asserts parser output for `[beta](...)`, `[$beta] /tmp/beta`, and `[$beta]()` cases.

**Call relations**: Documents the parser’s strictness around markdown link structure.

*Call graph*: calls 1 internal fn (assert_mentions).


##### `extract_tool_mentions_trims_linked_paths_and_allows_spacing`  (lines 111–113)

```
fn extract_tool_mentions_trims_linked_paths_and_allows_spacing()
```

**Purpose**: Verifies that whitespace between `]` and `(` and around the path is tolerated and trimmed.

**Data flow**: Calls `assert_mentions` with a spaced linked mention and expects the normalized path string without surrounding spaces.

**Call relations**: Covers the permissive whitespace handling in `parse_linked_tool_mention`.

*Call graph*: calls 1 internal fn (assert_mentions).


##### `extract_tool_mentions_stops_at_non_name_chars`  (lines 116–122)

```
fn extract_tool_mentions_stops_at_non_name_chars()
```

**Purpose**: Shows that mention names stop at characters outside the allowed token set, such as `.`.

**Data flow**: Parses text containing `$alpha.skill` and `$beta_extra` and asserts that the first becomes `alpha` while the second remains `beta_extra`.

**Call relations**: Documents the exact mention character class.

*Call graph*: calls 1 internal fn (assert_mentions).


##### `extract_tool_mentions_keeps_plugin_skill_namespaces`  (lines 125–131)

```
fn extract_tool_mentions_keeps_plugin_skill_namespaces()
```

**Purpose**: Confirms that colon-separated names like `slack:search` are treated as single mentions.

**Data flow**: Calls `assert_mentions` with namespaced and plain mentions and checks both appear in the parsed name set.

**Call relations**: Covers plugin-style names supported by `is_mention_name_char`.

*Call graph*: calls 1 internal fn (assert_mentions).


##### `collect_explicit_skill_mentions_text_respects_skill_order`  (lines 134–148)

```
fn collect_explicit_skill_mentions_text_respects_skill_order()
```

**Purpose**: Verifies that text mention selection preserves the original skill inventory order rather than mention order in the text.

**Data flow**: Builds two skills in `beta, alpha` order, parses text mentioning alpha then beta, runs `collect_mentions`, and asserts the result remains `[beta, alpha]`.

**Call relations**: Documents the selector’s order-preserving scan over `skills`.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 4 external calls (new, new, assert_eq!, vec!).


##### `collect_explicit_skill_mentions_prioritizes_structured_inputs`  (lines 151–170)

```
fn collect_explicit_skill_mentions_prioritizes_structured_inputs()
```

**Purpose**: Checks that structured `UserInput::Skill` selections are resolved before text mentions and therefore appear first in the result.

**Data flow**: Creates text mentioning alpha plus a structured selection for beta, runs `collect_mentions`, and asserts `[beta, alpha]`.

**Call relations**: Covers the two-phase selection flow in `collect_explicit_skill_mentions`.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 4 external calls (new, new, assert_eq!, vec!).


##### `collect_explicit_skill_mentions_skips_invalid_structured_and_blocks_plain_fallback`  (lines 173–191)

```
fn collect_explicit_skill_mentions_skips_invalid_structured_and_blocks_plain_fallback()
```

**Purpose**: Shows that an invalid structured skill path prevents fallback to a plain text mention of the same name.

**Data flow**: Supplies one skill, text mentioning it, and a structured selection with a missing path; `collect_mentions` returns an empty vector, which the test asserts.

**Call relations**: Documents the `blocked_plain_names` behavior even when structured resolution fails.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 4 external calls (new, new, assert_eq!, vec!).


##### `collect_explicit_skill_mentions_skips_disabled_structured_and_blocks_plain_fallback`  (lines 194–213)

```
fn collect_explicit_skill_mentions_skips_disabled_structured_and_blocks_plain_fallback()
```

**Purpose**: Verifies that a disabled structured selection is ignored and still blocks plain-name fallback for that skill name.

**Data flow**: Creates a disabled-path set containing the skill path, combines text and structured inputs for the same skill, runs `collect_mentions`, and asserts no selection.

**Call relations**: Covers the interaction between disabled paths and structured-input precedence.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 5 external calls (new, from, assert_eq!, test_path_buf, vec!).


##### `collect_explicit_skill_mentions_dedupes_by_path`  (lines 216–229)

```
fn collect_explicit_skill_mentions_dedupes_by_path()
```

**Purpose**: Ensures repeated linked mentions to the same skill path produce only one selected skill.

**Data flow**: Builds one skill, repeats the same linked mention twice in text, runs `collect_mentions`, and asserts a single-element result.

**Call relations**: Documents path-based deduplication via `seen_paths`.

*Call graph*: calls 3 internal fn (collect_mentions, linked_skill_mention, make_skill); 4 external calls (new, new, assert_eq!, vec!).


##### `collect_explicit_skill_mentions_skips_ambiguous_name`  (lines 232–245)

```
fn collect_explicit_skill_mentions_skips_ambiguous_name()
```

**Purpose**: Checks that plain-name mentions are rejected when multiple enabled skills share the same name.

**Data flow**: Creates two skills named `demo-skill`, mentions that name in text, runs `collect_mentions`, and asserts an empty result.

**Call relations**: Pins down the uniqueness requirement enforced by `skill_name_counts`.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 4 external calls (new, new, assert_eq!, vec!).


##### `collect_explicit_skill_mentions_prefers_linked_path_over_name`  (lines 248–264)

```
fn collect_explicit_skill_mentions_prefers_linked_path_over_name()
```

**Purpose**: Verifies that an explicit linked path selects the intended duplicate-named skill even when a plain-name mention is also present.

**Data flow**: Creates two `demo-skill` entries, includes both `$demo-skill` and a linked mention to beta’s path, runs `collect_mentions`, and asserts only beta is selected.

**Call relations**: Documents the selector’s path-first pass and suppression of ambiguous plain-name fallback.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 4 external calls (new, new, assert_eq!, vec!).


##### `collect_explicit_skill_mentions_skips_plain_name_when_connector_matches`  (lines 267–279)

```
fn collect_explicit_skill_mentions_skips_plain_name_when_connector_matches()
```

**Purpose**: Shows that plain-name skill selection is suppressed when a connector slug with the same lowercase name exists.

**Data flow**: Creates one skill, provides connector counts containing that name, mentions it in text, runs `collect_mentions`, and asserts no selection.

**Call relations**: Covers the connector collision guard in the plain-name pass.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 4 external calls (from, new, assert_eq!, vec!).


##### `collect_explicit_skill_mentions_allows_explicit_path_with_connector_conflict`  (lines 282–294)

```
fn collect_explicit_skill_mentions_allows_explicit_path_with_connector_conflict()
```

**Purpose**: Verifies that connector-name conflicts do not block explicit linked-path selection.

**Data flow**: Creates one skill, provides a conflicting connector slug count, mentions the skill via linked path, runs `collect_mentions`, and asserts the skill is selected.

**Call relations**: Contrasts with the previous test to show connector conflicts affect only plain-name fallback.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 4 external calls (from, new, assert_eq!, vec!).


##### `collect_explicit_skill_mentions_skips_when_linked_path_disabled`  (lines 297–311)

```
fn collect_explicit_skill_mentions_skips_when_linked_path_disabled()
```

**Purpose**: Checks that an explicit linked mention to a disabled skill path is ignored.

**Data flow**: Creates duplicate-named skills, disables one path, mentions that exact path in text, runs `collect_mentions`, and asserts an empty result.

**Call relations**: Documents that exact path matching still respects `disabled_paths`.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 5 external calls (new, from, assert_eq!, test_path_buf, vec!).


##### `collect_explicit_skill_mentions_prefers_resource_path`  (lines 314–327)

```
fn collect_explicit_skill_mentions_prefers_resource_path()
```

**Purpose**: Verifies that a linked resource path selects the matching duplicate-named skill directly.

**Data flow**: Creates two `demo-skill` entries, mentions only beta’s linked path, runs `collect_mentions`, and asserts `[beta]`.

**Call relations**: Covers the straightforward exact-path selection case.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 4 external calls (new, new, assert_eq!, vec!).


##### `collect_explicit_skill_mentions_skips_missing_path_with_no_fallback`  (lines 330–343)

```
fn collect_explicit_skill_mentions_skips_missing_path_with_no_fallback()
```

**Purpose**: Shows that a linked mention to a nonexistent path does not fall back to selecting by plain name when names are ambiguous.

**Data flow**: Creates two duplicate-named skills, mentions a missing linked path, runs `collect_mentions`, and asserts no selection.

**Call relations**: Documents that linked-path mentions are authoritative even when unresolved.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 4 external calls (new, new, assert_eq!, vec!).


##### `collect_explicit_skill_mentions_skips_missing_path_without_fallback`  (lines 346–358)

```
fn collect_explicit_skill_mentions_skips_missing_path_without_fallback()
```

**Purpose**: Confirms that even with only one matching skill name, a missing linked path does not degrade into plain-name selection.

**Data flow**: Creates one skill, mentions a missing linked path, runs `collect_mentions`, and asserts an empty result.

**Call relations**: Reinforces the no-fallback rule for explicit resource links.

*Call graph*: calls 2 internal fn (collect_mentions, make_skill); 4 external calls (new, new, assert_eq!, vec!).


### `core-skills/src/invocation_utils_tests.rs`

`test` · `test`

This test module targets the command-analysis logic in `invocation_utils.rs`. It uses compact helpers to build realistic fixtures without invoking the full loader. `test_skill_metadata` creates a minimal `SkillMetadata` with a supplied `SKILL.md` path, and `test_path_display` renders Unix-style test paths through the path abstraction used elsewhere in the codebase.

The first two tests isolate `script_run_token`, confirming that interpreter commands like `python3 -u scripts/fetch_comments.py` are recognized while `python3 -c print(1)` is not, because `-c` consumes code rather than a script file and the next positional token lacks an allowed script extension. The remaining tests construct `SkillLoadOutcome` values with either `implicit_skills_by_doc_path` or `implicit_skills_by_scripts_dir` populated and then call the internal detectors directly.

For document reads, one test verifies matching an absolute `SKILL.md` path in a piped command, and another verifies that the shared parser recognizes alternate read forms such as `nl -ba path`. For script execution, one test confirms that a relative script path under `scripts/` resolves correctly when the workdir is the skill root, and another confirms that an absolute script path matches regardless of workdir. All tests canonicalize the indexed paths the same way production code does, ensuring the assertions reflect the actual lookup semantics rather than raw string equality.

#### Function details

##### `test_skill_metadata`  (lines 14–26)

```
fn test_skill_metadata(skill_doc_path: AbsolutePathBuf) -> SkillMetadata
```

**Purpose**: Builds a minimal `SkillMetadata` fixture for implicit invocation tests.

**Data flow**: Takes an absolute skill doc path, fills a `SkillMetadata` with fixed name/description and default optional fields, and returns it.

**Call relations**: Used by the doc-read and script-run detection tests to populate `SkillLoadOutcome` indexes.

*Call graph*: called by 4 (skill_doc_read_detection_matches_absolute_path, skill_doc_read_detection_matches_shared_read_parser, skill_script_run_detection_matches_absolute_path_from_any_workdir, skill_script_run_detection_matches_relative_path_from_skill_root).


##### `test_path_display`  (lines 28–30)

```
fn test_path_display(unix_path: &str) -> String
```

**Purpose**: Converts a Unix-style test path into the display string used in command tokens.

**Data flow**: Builds a test path buffer from the input string and returns its displayed form as `String`.

**Call relations**: Used by tests that need command tokens containing platform-adjusted path text.

*Call graph*: 1 external calls (test_path_buf).


##### `script_run_detection_matches_runner_plus_extension`  (lines 33–41)

```
fn script_run_detection_matches_runner_plus_extension()
```

**Purpose**: Verifies that a recognized interpreter plus a recognized script extension yields a script-run candidate.

**Data flow**: Constructs a token vector for `python3 -u scripts/fetch_comments.py`, calls `script_run_token`, and asserts that the result is `Some`.

**Call relations**: Directly exercises the positive path of `script_run_token`.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `script_run_detection_excludes_python_c`  (lines 44–52)

```
fn script_run_detection_excludes_python_c()
```

**Purpose**: Verifies that `python -c ...` is not mistaken for running a script file.

**Data flow**: Constructs tokens for `python3 -c print(1)`, calls `script_run_token`, and asserts that the result is `None`.

**Call relations**: Covers a common false-positive case in interpreter command parsing.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `skill_doc_read_detection_matches_absolute_path`  (lines 55–77)

```
fn skill_doc_read_detection_matches_absolute_path()
```

**Purpose**: Checks that reading a skill doc by absolute path resolves to the indexed skill.

**Data flow**: Creates a canonicalized skill doc path, inserts it into `implicit_skills_by_doc_path`, builds command tokens for `cat <path> | head`, calls `detect_skill_doc_read`, and asserts that the returned skill name is `test-skill`.

**Call relations**: Exercises the doc-read detector with a straightforward absolute-path command.

*Call graph*: calls 1 internal fn (test_skill_metadata); 9 external calls (new, default, from, new, assert_eq!, test_path_buf, canonicalize_if_exists, detect_skill_doc_read, vec!).


##### `skill_doc_read_detection_matches_shared_read_parser`  (lines 80–101)

```
fn skill_doc_read_detection_matches_shared_read_parser()
```

**Purpose**: Verifies that doc-read detection works through the shared parsed-command logic, not just simple `cat` forms.

**Data flow**: Builds an outcome indexed by canonicalized doc path, constructs tokens for `nl -ba <path>`, calls `detect_skill_doc_read`, and asserts the expected skill name.

**Call relations**: Documents that the detector inherits coverage from `parse_command_impl`’s broader read-command recognition.

*Call graph*: calls 1 internal fn (test_skill_metadata); 9 external calls (new, default, from, new, assert_eq!, test_path_buf, canonicalize_if_exists, detect_skill_doc_read, vec!).


##### `skill_script_run_detection_matches_relative_path_from_skill_root`  (lines 104–124)

```
fn skill_script_run_detection_matches_relative_path_from_skill_root()
```

**Purpose**: Checks that a relative script path under a skill’s `scripts/` directory matches when resolved from the skill root.

**Data flow**: Indexes the canonicalized `scripts` directory in `implicit_skills_by_scripts_dir`, builds tokens for `python3 scripts/fetch_comments.py`, calls `detect_skill_script_run` with the skill root as workdir, and asserts the returned skill name.

**Call relations**: Exercises the ancestor-walk logic for relative script paths.

*Call graph*: calls 1 internal fn (test_skill_metadata); 9 external calls (new, default, from, new, assert_eq!, test_path_buf, canonicalize_if_exists, detect_skill_script_run, vec!).


##### `skill_script_run_detection_matches_absolute_path_from_any_workdir`  (lines 127–147)

```
fn skill_script_run_detection_matches_absolute_path_from_any_workdir()
```

**Purpose**: Verifies that an absolute script path matches the indexed skill regardless of the current working directory.

**Data flow**: Indexes the canonicalized `scripts` directory, builds tokens for `python3 /tmp/skill-test/scripts/fetch_comments.py`, calls `detect_skill_script_run` with an unrelated workdir, and asserts the expected skill name.

**Call relations**: Covers the absolute-path branch of script execution detection.

*Call graph*: calls 1 internal fn (test_skill_metadata); 9 external calls (new, default, from, new, assert_eq!, test_path_buf, canonicalize_if_exists, detect_skill_script_run, vec!).


### `core-skills/src/loader_tests.rs`

`test` · `test`

This large test module constructs temporary directory trees that mimic user config homes, repo roots, plugin installs, and system caches, then drives the real loader against them. The helper layer is substantial because many tests need realistic config stacks and on-disk skill layouts. `make_config` and `make_config_for_cwd` synthesize `ConfigLayerStack` values with system, user, and discovered project layers; `project_layers_for_cwd` mirrors project-layer discovery by walking ancestors until a `.git` marker; `load_skills_for_test` intentionally avoids the real `$HOME/.agents/skills` for hermeticity. File-writing helpers create `SKILL.md`, raw frontmatter variants, metadata files, and plugin/shared-asset layouts. Unix-only helpers create symlinked directories and files.

The tests cover root mapping from config layers to scopes, inclusion of disabled project layers, loading from `$HOME/.agents/skills`, repo `.codex/skills`, repo `.agents/skills`, nested `.codex` directories, and system cache roots. They verify parsing behavior such as fallback names from directory names, plugin namespacing, qualified-name length limits, short-description extraction and limits, hidden-directory skipping, and frontmatter validation. Metadata tests exercise dependency parsing, interface fields, brand-color validation, default-prompt length checks, icon path restrictions, and plugin shared-assets exceptions. Traversal tests pin down symlink policy by scope, cycle avoidance, symlinked-file rejection, and maximum scan depth. Deduplication tests show that duplicate paths prefer the first root while duplicate names across scopes or nested repo roots are retained. Overall, the file acts as executable documentation for the loader’s many filesystem and validation edge cases.

#### Function details

##### `make_config`  (lines 29–31)

```
async fn make_config(codex_home: &TempDir) -> TestConfig
```

**Purpose**: Builds a default test config rooted at the temp codex home and using that directory as cwd.

**Data flow**: Takes a `TempDir`, derives its path, and forwards to `make_config_for_cwd`, returning the resulting `TestConfig` asynchronously.

**Call relations**: Used by many tests that do not need a custom cwd.

*Call graph*: calls 1 internal fn (make_config_for_cwd); called by 19 (accepts_icon_paths_under_assets_dir, does_not_loop_on_symlink_cycle_for_user_scope, drops_interface_when_icons_are_invalid, empty_skill_policy_defaults_to_allow_implicit_invocation, enforces_length_limits, enforces_short_description_length_limits, falls_back_to_directory_name_when_skill_name_is_missing, ignores_default_prompt_over_max_length, ignores_invalid_brand_color, ignores_symlinked_skill_file_for_user_scope (+9 more)); 1 external calls (path).


##### `config_file`  (lines 33–35)

```
fn config_file(path: PathBuf) -> AbsolutePathBuf
```

**Purpose**: Converts a `PathBuf` into an absolute config-file path for config layer entries.

**Data flow**: Calls `.abs()` on the input path and returns the resulting `AbsolutePathBuf`.

**Call relations**: Used by config-stack construction helpers.

*Call graph*: 1 external calls (abs).


##### `project_layers_for_cwd`  (lines 37–80)

```
fn project_layers_for_cwd(cwd: &Path) -> Vec<ConfigLayerEntry>
```

**Purpose**: Synthesizes project config layers for every `.codex` directory between the project root and the cwd.

**Data flow**: Normalizes file-vs-directory cwd, finds the project root by searching ancestors for `.git`, collects ancestors from root to cwd, filters to directories containing `.codex`, and maps each to a `ConfigLayerEntry::new(ConfigLayerSource::Project { ... }, empty_table)`.

**Call relations**: Called by `make_config_for_cwd` to emulate project-layer discovery in tests.

*Call graph*: called by 1 (make_config_for_cwd); 3 external calls (is_dir, parent, to_path_buf).


##### `make_config_for_cwd`  (lines 82–119)

```
async fn make_config_for_cwd(codex_home: &TempDir, cwd: PathBuf) -> TestConfig
```

**Purpose**: Constructs a `TestConfig` with synthetic system, user, and project config layers for a chosen cwd.

**Data flow**: Creates fake system and user config file paths under the temp codex home, ensures the fake system config directory exists, builds base system and user `ConfigLayerEntry` values, extends them with `project_layers_for_cwd(&cwd)`, canonicalizes the cwd, and returns `TestConfig { cwd, config_layer_stack }`.

**Call relations**: Used by tests that need repo-aware root discovery or file cwd handling.

*Call graph*: calls 2 internal fn (new, project_layers_for_cwd); called by 12 (keeps_duplicate_names_from_nested_codex_dirs, keeps_duplicate_names_from_repo_and_user, loads_skills_from_agents_dir_without_codex_dir, loads_skills_from_all_codex_dirs_under_project_root, loads_skills_from_codex_dir_when_not_git_repo, loads_skills_from_repo_root, loads_skills_from_system_cache_when_present, loads_skills_via_symlinked_subdir_for_repo_scope, loads_skills_when_cwd_is_file_in_repo, make_config (+2 more)); 6 external calls (abs, path, default, default, create_dir_all, vec!).


##### `load_skills_for_test`  (lines 121–133)

```
async fn load_skills_for_test(config: &TestConfig) -> SkillLoadOutcome
```

**Purpose**: Loads skills using the real loader while suppressing scanning of the actual user home agents directory.

**Data flow**: Calls the test-only `skill_roots_from_layer_stack` with `LOCAL_FS`, the config stack, cwd, and `home_dir = None`, then passes those roots into `load_skills_from_roots` and returns the resulting `SkillLoadOutcome`.

**Call relations**: This is the main execution helper for most loader tests.

*Call graph*: called by 29 (accepts_icon_paths_under_assets_dir, does_not_loop_on_symlink_cycle_for_user_scope, drops_interface_when_icons_are_invalid, empty_skill_policy_defaults_to_allow_implicit_invocation, enforces_length_limits, enforces_short_description_length_limits, falls_back_to_directory_name_when_skill_name_is_missing, ignores_default_prompt_over_max_length, ignores_invalid_brand_color, ignores_symlinked_skill_file_for_user_scope (+15 more)); 3 external calls (clone, load_skills_from_roots, skill_roots_from_layer_stack).


##### `mark_as_git_repo`  (lines 135–139)

```
fn mark_as_git_repo(dir: &Path)
```

**Purpose**: Marks a directory as a fake git repository by creating a `.git` marker file.

**Data flow**: Writes a small text file at `<dir>/.git`.

**Call relations**: Used by repo-root discovery tests to avoid invoking `git init`.

*Call graph*: called by 8 (keeps_duplicate_names_from_nested_codex_dirs, keeps_duplicate_names_from_repo_and_user, loads_skills_from_agents_dir_without_codex_dir, loads_skills_from_all_codex_dirs_under_project_root, loads_skills_from_repo_root, loads_skills_via_symlinked_subdir_for_repo_scope, loads_skills_when_cwd_is_file_in_repo, repo_skills_search_does_not_escape_repo_root); 2 external calls (join, write).


##### `normalized`  (lines 141–145)

```
fn normalized(path: &Path) -> AbsolutePathBuf
```

**Purpose**: Canonicalizes a path for stable assertions while falling back to the original path if canonicalization fails.

**Data flow**: Calls `dunce::canonicalize`, falls back to `to_path_buf()` on error, then converts the result to an absolute path.

**Call relations**: Used in expected `SkillMetadata` assertions so path comparisons match loader normalization.

*Call graph*: called by 5 (accepts_icon_paths_under_assets_dir, ignores_default_prompt_over_max_length, keeps_duplicate_names_from_nested_codex_dirs, loads_plugin_skill_interface_icons_from_shared_plugin_assets, loads_skill_interface_metadata_from_yaml); 1 external calls (canonicalize).


##### `skill_roots_from_layer_stack_maps_user_to_user_and_system_cache_and_system_to_admin`  (lines 148–210)

```
async fn skill_roots_from_layer_stack_maps_user_to_user_and_system_cache_and_system_to_admin() -> anyhow::Result<()>
```

**Purpose**: Verifies the mapping from user and system config layers to user, home-agents, system-cache, and admin skill roots.

**Data flow**: Creates temp directories for fake system and user config folders, builds a config stack, calls `skill_roots_from_layer_stack`, maps roots to `(scope, path)` tuples, and asserts the expected ordered list.

**Call relations**: Exercises root derivation logic directly rather than full skill loading.

*Call graph*: calls 1 internal fn (new); 7 external calls (clone, default, assert_eq!, default, create_dir_all, tempdir, vec!).


##### `skill_roots_from_layer_stack_includes_disabled_project_layers`  (lines 213–279)

```
async fn skill_roots_from_layer_stack_includes_disabled_project_layers() -> anyhow::Result<()>
```

**Purpose**: Checks that disabled project config layers still contribute repo skill roots.

**Data flow**: Builds a stack with a user layer and a disabled project layer, calls `skill_roots_from_layer_stack`, collects `(scope, path)` tuples, and asserts that the repo root is included ahead of user/system roots.

**Call relations**: Documents the loader’s decision to include disabled project layers for root discovery.

*Call graph*: calls 1 internal fn (new); 7 external calls (clone, default, assert_eq!, default, create_dir_all, tempdir, vec!).


##### `loads_skills_from_home_agents_dir_for_user_scope`  (lines 282–340)

```
async fn loads_skills_from_home_agents_dir_for_user_scope() -> anyhow::Result<()>
```

**Purpose**: Verifies that skills under `$HOME/.agents/skills` load as user-scoped skills.

**Data flow**: Creates a fake home and user config, writes a skill under `.agents/skills`, computes roots with an explicit home dir, loads skills, and asserts one user-scoped `SkillMetadata` with the normalized path.

**Call relations**: Covers the special home-agents root added for user layers.

*Call graph*: calls 2 internal fn (new, write_skill_at); 8 external calls (clone, default, assert!, assert_eq!, default, create_dir_all, tempdir, vec!).


##### `write_skill`  (lines 342–344)

```
fn write_skill(codex_home: &TempDir, dir: &str, name: &str, description: &str) -> PathBuf
```

**Purpose**: Writes a standard `SKILL.md` under the temp codex home’s `skills/` tree.

**Data flow**: Joins the codex home path with `skills`, forwards to `write_skill_at`, and returns the created file path.

**Call relations**: Common fixture helper for user-scope skill tests.

*Call graph*: calls 1 internal fn (write_skill_at); called by 13 (accepts_icon_paths_under_assets_dir, drops_interface_when_icons_are_invalid, empty_skill_policy_defaults_to_allow_implicit_invocation, enforces_length_limits, ignores_default_prompt_over_max_length, ignores_invalid_brand_color, keeps_duplicate_names_from_repo_and_user, loads_skill_dependencies_metadata_from_yaml, loads_skill_interface_metadata_from_yaml, loads_skill_policy_from_yaml (+3 more)); 1 external calls (path).


##### `write_system_skill`  (lines 346–353)

```
fn write_system_skill(codex_home: &TempDir, dir: &str, name: &str, description: &str) -> PathBuf
```

**Purpose**: Writes a standard `SKILL.md` under the temp codex home’s bundled system cache tree.

**Data flow**: Joins the codex home path with `skills/.system`, forwards to `write_skill_at`, and returns the created file path.

**Call relations**: Used by tests covering system-scope loading.

*Call graph*: calls 1 internal fn (write_skill_at); called by 1 (loads_skills_from_system_cache_when_present); 1 external calls (path).


##### `write_skill_at`  (lines 355–364)

```
fn write_skill_at(root: &Path, dir: &str, name: &str, description: &str) -> PathBuf
```

**Purpose**: Creates a skill directory and writes a normal frontmatter-bearing `SKILL.md` file there.

**Data flow**: Builds `<root>/<dir>/SKILL.md`, creates the directory, formats frontmatter with `name` and multiline `description`, writes the file, and returns its path.

**Call relations**: Primary fixture writer used across loader tests.

*Call graph*: called by 21 (deduplicates_by_path_preferring_first_root, does_not_loop_on_symlink_cycle_for_user_scope, drops_plugin_skill_interface_icons_that_escape_shared_plugin_assets, ignores_symlinked_skill_file_for_user_scope, keeps_duplicate_names_from_nested_codex_dirs, keeps_duplicate_names_from_repo_and_user, loads_plugin_skill_interface_icons_from_shared_plugin_assets, loads_skills_from_agents_dir_without_codex_dir, loads_skills_from_all_codex_dirs_under_project_root, loads_skills_from_codex_dir_when_not_git_repo (+11 more)); 4 external calls (join, format!, create_dir_all, write).


##### `write_raw_skill_at`  (lines 366–373)

```
fn write_raw_skill_at(root: &Path, dir: &str, frontmatter: &str) -> PathBuf
```

**Purpose**: Writes a `SKILL.md` with caller-supplied raw frontmatter content.

**Data flow**: Creates the target directory, wraps the provided frontmatter between `---` delimiters plus a body, writes the file, and returns its path.

**Call relations**: Used for tests that need malformed or custom frontmatter.

*Call graph*: called by 4 (falls_back_to_directory_name_when_skill_name_is_missing, namespaces_plugin_skills_using_plugin_name, plugin_skill_name_length_limit_allows_max_qualified_name, plugin_skill_name_length_limit_rejects_overlong_qualified_name); 4 external calls (join, format!, create_dir_all, write).


##### `write_skill_metadata_at`  (lines 375–384)

```
fn write_skill_metadata_at(skill_dir: &Path, contents: &str) -> PathBuf
```

**Purpose**: Writes an `agents/openai.yaml` metadata file next to a skill.

**Data flow**: Builds the metadata path under `<skill_dir>/agents/openai.yaml`, creates parent directories if needed, writes the provided contents, and returns the path.

**Call relations**: Used by dependency, interface, and policy metadata tests.

*Call graph*: called by 5 (empty_skill_policy_defaults_to_allow_implicit_invocation, loads_skill_dependencies_metadata_from_yaml, loads_skill_policy_from_yaml, loads_skill_policy_products_from_yaml, write_skill_interface_at); 3 external calls (join, create_dir_all, write).


##### `write_skill_interface_at`  (lines 386–388)

```
fn write_skill_interface_at(skill_dir: &Path, contents: &str) -> PathBuf
```

**Purpose**: Alias helper for writing interface metadata files.

**Data flow**: Forwards the skill directory and contents to `write_skill_metadata_at` and returns its path.

**Call relations**: Used by interface-specific tests for readability.

*Call graph*: calls 1 internal fn (write_skill_metadata_at); called by 7 (accepts_icon_paths_under_assets_dir, drops_interface_when_icons_are_invalid, drops_plugin_skill_interface_icons_that_escape_shared_plugin_assets, ignores_default_prompt_over_max_length, ignores_invalid_brand_color, loads_plugin_skill_interface_icons_from_shared_plugin_assets, loads_skill_interface_metadata_from_yaml).


##### `loads_skill_dependencies_metadata_from_yaml`  (lines 391–476)

```
async fn loads_skill_dependencies_metadata_from_yaml()
```

**Purpose**: Verifies that dependency metadata is parsed into `SkillDependencies` and `SkillToolDependency` entries.

**Data flow**: Creates a skill and metadata file containing multiple tool dependency definitions, loads skills through the real loader, and asserts the resulting `SkillMetadata.dependencies` structure exactly.

**Call relations**: Exercises `load_skill_metadata`, `resolve_dependencies`, and `resolve_dependency_tool` together.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config, write_skill, write_skill_metadata_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `loads_skill_interface_metadata_from_yaml`  (lines 479–532)

```
async fn loads_skill_interface_metadata_from_yaml()
```

**Purpose**: Checks that interface metadata fields are sanitized and resolved into a `SkillInterface` with normalized asset paths.

**Data flow**: Creates a skill and interface metadata file, loads skills, filters to user-scoped skills, and asserts the expected `SkillInterface` including collapsed whitespace and resolved icon paths.

**Call relations**: Covers the happy path for interface metadata resolution.

*Call graph*: calls 5 internal fn (load_skills_for_test, make_config, normalized, write_skill, write_skill_interface_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `loads_skill_policy_from_yaml`  (lines 535–565)

```
async fn loads_skill_policy_from_yaml()
```

**Purpose**: Verifies that explicit policy metadata loads and disables implicit invocation when requested.

**Data flow**: Writes a skill plus policy metadata with `allow_implicit_invocation: false`, loads skills, and asserts both the parsed `SkillPolicy` and that `allowed_skills_for_implicit_invocation()` is empty.

**Call relations**: Exercises policy parsing and downstream implicit-invocation filtering.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config, write_skill, write_skill_metadata_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `empty_skill_policy_defaults_to_allow_implicit_invocation`  (lines 568–600)

```
async fn empty_skill_policy_defaults_to_allow_implicit_invocation()
```

**Purpose**: Checks that an empty policy block yields a `SkillPolicy` with `None` for `allow_implicit_invocation`, which still allows implicit invocation.

**Data flow**: Writes `policy: {}`, loads skills, asserts the parsed policy, and asserts that the allowed-implicit-invocation list equals the full skill list.

**Call relations**: Documents the distinction between explicit false and unspecified policy.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config, write_skill, write_skill_metadata_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `loads_skill_policy_products_from_yaml`  (lines 603–635)

```
async fn loads_skill_policy_products_from_yaml()
```

**Purpose**: Verifies that policy product names deserialize case-insensitively into `Product` enum values.

**Data flow**: Writes policy metadata listing `codex`, `CHATGPT`, and `atlas`, loads skills, and asserts the resulting `SkillPolicy.products` vector.

**Call relations**: Covers product restriction parsing in policy metadata.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config, write_skill, write_skill_metadata_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `accepts_icon_paths_under_assets_dir`  (lines 638–686)

```
async fn accepts_icon_paths_under_assets_dir()
```

**Purpose**: Checks that relative icon paths rooted under `assets/` are accepted and resolved.

**Data flow**: Writes interface metadata with `assets/icon.png` and `./assets/logo.svg`, loads skills, and asserts the resulting `SkillInterface` contains normalized absolute icon paths.

**Call relations**: Exercises the accepted branch of `resolve_asset_path`.

*Call graph*: calls 5 internal fn (load_skills_for_test, make_config, normalized, write_skill, write_skill_interface_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `ignores_invalid_brand_color`  (lines 689–727)

```
async fn ignores_invalid_brand_color()
```

**Purpose**: Verifies that invalid brand colors are dropped and do not produce an interface object by themselves.

**Data flow**: Writes interface metadata containing only `brand_color: "blue"`, loads skills, and asserts the resulting skill has `interface: None`.

**Call relations**: Covers `resolve_color_str` failure and the empty-interface collapse behavior.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config, write_skill, write_skill_interface_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `ignores_default_prompt_over_max_length`  (lines 730–781)

```
async fn ignores_default_prompt_over_max_length()
```

**Purpose**: Checks that an overlong `default_prompt` is dropped while other valid interface fields remain.

**Data flow**: Writes interface metadata with a too-long prompt plus valid display name and icon, loads skills, and asserts the resulting interface keeps the valid fields but has `default_prompt: None`.

**Call relations**: Exercises field-level fail-open behavior in `resolve_interface`.

*Call graph*: calls 5 internal fn (load_skills_for_test, make_config, normalized, write_skill, write_skill_interface_at); 4 external calls (assert!, assert_eq!, format!, tempdir).


##### `drops_interface_when_icons_are_invalid`  (lines 784–823)

```
async fn drops_interface_when_icons_are_invalid()
```

**Purpose**: Verifies that invalid icon paths can cause the entire interface to disappear when no other valid fields remain.

**Data flow**: Writes interface metadata with icons outside allowed asset rules, loads skills, and asserts `interface: None`.

**Call relations**: Covers rejection paths in `resolve_asset_path` and the final empty-interface check.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config, write_skill, write_skill_interface_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `loads_plugin_skill_interface_icons_from_shared_plugin_assets`  (lines 826–884)

```
async fn loads_plugin_skill_interface_icons_from_shared_plugin_assets()
```

**Purpose**: Checks that plugin skills may reference shared plugin-level assets via `..` paths when the normalized result stays under the plugin `assets/` directory.

**Data flow**: Creates a plugin root with a skill and shared `assets/logo.svg`, writes interface metadata using `../../assets/logo.svg`, loads from an explicit plugin `SkillRoot`, and asserts both icon fields resolve to the shared asset path.

**Call relations**: Exercises the plugin-only success path in `resolve_plugin_shared_asset_path`.

*Call graph*: calls 3 internal fn (normalized, write_skill_at, write_skill_interface_at); 6 external calls (clone, assert!, assert_eq!, create_dir_all, write, tempdir).


##### `drops_plugin_skill_interface_icons_that_escape_shared_plugin_assets`  (lines 887–933)

```
async fn drops_plugin_skill_interface_icons_that_escape_shared_plugin_assets()
```

**Purpose**: Verifies that plugin icon paths using `..` are rejected when they escape the plugin `assets/` directory.

**Data flow**: Creates a plugin skill with interface metadata pointing to `../../other/logo.svg`, loads it, and asserts the resulting skill has `interface: None`.

**Call relations**: Covers the containment check in `resolve_plugin_shared_asset_path`.

*Call graph*: calls 2 internal fn (write_skill_at, write_skill_interface_at); 4 external calls (clone, assert!, assert_eq!, tempdir).


##### `symlink_dir`  (lines 936–938)

```
fn symlink_dir(target: &Path, link: &Path)
```

**Purpose**: Unix-only helper that creates a directory symlink.

**Data flow**: Calls the platform symlink API with the target and link paths.

**Call relations**: Used by symlink traversal tests.

*Call graph*: called by 5 (does_not_loop_on_symlink_cycle_for_user_scope, loads_skills_via_symlinked_subdir_for_admin_scope, loads_skills_via_symlinked_subdir_for_repo_scope, loads_skills_via_symlinked_subdir_for_user_scope, system_scope_ignores_symlinked_subdir); 1 external calls (symlink).


##### `symlink_file`  (lines 941–943)

```
fn symlink_file(target: &Path, link: &Path)
```

**Purpose**: Unix-only helper that creates a file symlink.

**Data flow**: Calls the platform symlink API with the target and link paths.

**Call relations**: Used by the symlinked-skill-file rejection test.

*Call graph*: called by 1 (ignores_symlinked_skill_file_for_user_scope); 1 external calls (symlink).


##### `loads_skills_via_symlinked_subdir_for_user_scope`  (lines 947–978)

```
async fn loads_skills_via_symlinked_subdir_for_user_scope()
```

**Purpose**: Verifies that user-scope scanning follows symlinked directories and loads skills found through them.

**Data flow**: Creates a shared temp directory containing a skill, symlinks it under the user skills root, loads skills, and asserts the linked skill is discovered with the canonical shared path.

**Call relations**: Documents symlink-following behavior for user scope.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config, symlink_dir, write_skill_at); 4 external calls (assert!, assert_eq!, create_dir_all, tempdir).


##### `ignores_symlinked_skill_file_for_user_scope`  (lines 982–1001)

```
async fn ignores_symlinked_skill_file_for_user_scope()
```

**Purpose**: Checks that a symlinked `SKILL.md` file itself is not parsed as a skill.

**Data flow**: Creates a real skill elsewhere, symlinks only the `SKILL.md` file into a user skill directory, loads skills, and asserts no skills are returned.

**Call relations**: Covers the scanner’s symlink handling, which only follows symlinked directories.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config, symlink_file, write_skill_at); 4 external calls (assert!, assert_eq!, create_dir_all, tempdir).


##### `does_not_loop_on_symlink_cycle_for_user_scope`  (lines 1005–1038)

```
async fn does_not_loop_on_symlink_cycle_for_user_scope()
```

**Purpose**: Verifies that canonicalized visited-directory tracking prevents infinite recursion through symlink cycles.

**Data flow**: Creates a directory symlink cycle under the user skills root, writes one real skill in the cycle directory, loads skills, and asserts the skill loads exactly once without errors.

**Call relations**: Exercises cycle prevention in `discover_skills_under_root`.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config, symlink_dir, write_skill_at); 4 external calls (assert!, assert_eq!, create_dir_all, tempdir).


##### `loads_skills_via_symlinked_subdir_for_admin_scope`  (lines 1042–1079)

```
async fn loads_skills_via_symlinked_subdir_for_admin_scope()
```

**Purpose**: Checks that admin-scope scanning also follows symlinked directories.

**Data flow**: Creates a shared skill directory, symlinks it under an admin root, loads from an explicit admin `SkillRoot`, and asserts the linked skill is discovered as admin-scoped.

**Call relations**: Documents that admin scope shares the same symlink policy as user and repo scopes.

*Call graph*: calls 2 internal fn (symlink_dir, write_skill_at); 5 external calls (clone, assert!, assert_eq!, create_dir_all, tempdir).


##### `loads_skills_via_symlinked_subdir_for_repo_scope`  (lines 1083–1119)

```
async fn loads_skills_via_symlinked_subdir_for_repo_scope()
```

**Purpose**: Verifies that repo-scope scanning follows symlinked directories under `.codex/skills`.

**Data flow**: Creates a fake repo, writes a shared skill elsewhere, symlinks the shared directory under the repo skills root, loads via repo-aware config, and asserts the linked skill is discovered as repo-scoped.

**Call relations**: Covers symlink traversal for repo scope.

*Call graph*: calls 5 internal fn (load_skills_for_test, make_config_for_cwd, mark_as_git_repo, symlink_dir, write_skill_at); 4 external calls (assert!, assert_eq!, create_dir_all, tempdir).


##### `system_scope_ignores_symlinked_subdir`  (lines 1123–1147)

```
async fn system_scope_ignores_symlinked_subdir()
```

**Purpose**: Checks that system-scope scanning does not follow symlinked directories.

**Data flow**: Creates a shared skill directory, symlinks it under the system cache root, loads from an explicit system `SkillRoot`, and asserts zero skills are loaded.

**Call relations**: Documents the stricter symlink policy for bundled/system skills.

*Call graph*: calls 2 internal fn (symlink_dir, write_skill_at); 5 external calls (clone, assert!, assert_eq!, create_dir_all, tempdir).


##### `respects_max_scan_depth_for_user_scope`  (lines 1150–1195)

```
async fn respects_max_scan_depth_for_user_scope()
```

**Purpose**: Verifies that scanning stops beyond the configured maximum directory depth.

**Data flow**: Writes one skill at depth 6 and another deeper, loads from the user skills root, and asserts only the within-depth skill is returned.

**Call relations**: Exercises the `MAX_SCAN_DEPTH` guard in directory enqueueing.

*Call graph*: calls 1 internal fn (write_skill); 4 external calls (clone, assert!, assert_eq!, tempdir).


##### `loads_valid_skill`  (lines 1198–1223)

```
async fn loads_valid_skill()
```

**Purpose**: Checks the basic happy path for parsing a normal skill file with multiline description sanitization.

**Data flow**: Writes a standard skill, loads skills, and asserts one `SkillMetadata` with whitespace-collapsed description and normalized path.

**Call relations**: Serves as the baseline loader success test.

*Call graph*: calls 3 internal fn (load_skills_for_test, make_config, write_skill); 3 external calls (assert!, assert_eq!, tempdir).


##### `falls_back_to_directory_name_when_skill_name_is_missing`  (lines 1226–1256)

```
async fn falls_back_to_directory_name_when_skill_name_is_missing()
```

**Purpose**: Verifies that the loader derives the skill name from the containing directory when frontmatter omits `name`.

**Data flow**: Writes a raw skill containing only `description`, loads skills, and asserts the resulting name equals the directory name.

**Call relations**: Exercises `default_skill_name` through the full loader.

*Call graph*: calls 3 internal fn (load_skills_for_test, make_config, write_raw_skill_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `namespaces_plugin_skills_using_plugin_name`  (lines 1259–1302)

```
async fn namespaces_plugin_skills_using_plugin_name()
```

**Purpose**: Checks that plugin skills are prefixed with the plugin namespace discovered from plugin metadata.

**Data flow**: Creates a plugin root with `.codex-plugin/plugin.json`, writes a raw skill under `skills/`, loads from an explicit plugin root, and asserts the resulting skill name is `sample:sample-search`.

**Call relations**: Exercises `namespaced_skill_name` and plugin namespace discovery.

*Call graph*: calls 1 internal fn (write_raw_skill_at); 6 external calls (clone, assert!, assert_eq!, create_dir_all, write, tempdir).


##### `plugin_skill_name_length_limit_allows_max_qualified_name`  (lines 1305–1347)

```
async fn plugin_skill_name_length_limit_allows_max_qualified_name()
```

**Purpose**: Verifies that a plugin-qualified skill name exactly at the maximum allowed length is accepted.

**Data flow**: Constructs plugin and skill names whose combined qualified length fits the limit, writes plugin metadata and skill frontmatter, loads skills, and asserts successful loading.

**Call relations**: Covers the upper boundary of qualified-name validation.

*Call graph*: calls 1 internal fn (write_raw_skill_at); 7 external calls (clone, assert!, assert_eq!, format!, create_dir_all, write, tempdir).


##### `plugin_skill_name_length_limit_rejects_overlong_qualified_name`  (lines 1350–1380)

```
async fn plugin_skill_name_length_limit_rejects_overlong_qualified_name()
```

**Purpose**: Checks that plugin-qualified names exceeding the maximum length are rejected with an error.

**Data flow**: Creates plugin and skill names whose combined qualified length is too long, loads from the plugin root, and asserts no skills plus one error mentioning `invalid qualified name`.

**Call relations**: Exercises `validate_len` on the namespaced name path.

*Call graph*: calls 1 internal fn (write_raw_skill_at); 7 external calls (clone, assert!, assert_eq!, format!, create_dir_all, write, tempdir).


##### `loads_short_description_from_metadata`  (lines 1383–1412)

```
async fn loads_short_description_from_metadata()
```

**Purpose**: Verifies that `metadata.short-description` in frontmatter is parsed and stored.

**Data flow**: Writes a `SKILL.md` containing `metadata.short-description`, loads skills, and asserts the resulting `SkillMetadata.short_description` value.

**Call relations**: Covers frontmatter metadata parsing distinct from `agents/openai.yaml`.

*Call graph*: calls 2 internal fn (load_skills_for_test, make_config); 5 external calls (assert!, assert_eq!, create_dir_all, write, tempdir).


##### `enforces_short_description_length_limits`  (lines 1415–1436)

```
async fn enforces_short_description_length_limits()
```

**Purpose**: Checks that overlong frontmatter short descriptions reject the skill with an error.

**Data flow**: Writes a skill whose `metadata.short-description` exceeds the limit, loads skills, and asserts zero skills plus one error mentioning `invalid metadata.short-description`.

**Call relations**: Exercises `validate_len` on optional frontmatter metadata.

*Call graph*: calls 2 internal fn (load_skills_for_test, make_config); 6 external calls (assert!, assert_eq!, format!, create_dir_all, write, tempdir).


##### `skips_hidden_and_invalid`  (lines 1439–1464)

```
async fn skips_hidden_and_invalid()
```

**Purpose**: Verifies that hidden directories are ignored and malformed frontmatter produces a recorded parse error.

**Data flow**: Creates a hidden skill directory and an invalid visible skill missing closing frontmatter, loads skills, and asserts zero skills plus one error mentioning missing YAML frontmatter.

**Call relations**: Covers hidden-entry skipping and parse-error recording.

*Call graph*: calls 2 internal fn (load_skills_for_test, make_config); 5 external calls (assert!, assert_eq!, create_dir_all, write, tempdir).


##### `enforces_length_limits`  (lines 1467–1490)

```
async fn enforces_length_limits()
```

**Purpose**: Checks that maximum description length is enforced by character count, including Unicode characters.

**Data flow**: Writes one skill with a description exactly at the limit and confirms it loads, then writes another exceeding the limit, reloads, and asserts one retained skill plus one error mentioning `invalid description`.

**Call relations**: Exercises `validate_len` with multibyte characters.

*Call graph*: calls 3 internal fn (load_skills_for_test, make_config, write_skill); 3 external calls (assert!, assert_eq!, tempdir).


##### `loads_skills_from_repo_root`  (lines 1493–1525)

```
async fn loads_skills_from_repo_root()
```

**Purpose**: Verifies that repo-scoped skills under `.codex/skills` are discovered from the cwd’s repository.

**Data flow**: Creates a fake git repo with `.codex/skills`, writes a skill there, builds repo-aware config for that cwd, loads skills, and asserts one repo-scoped skill.

**Call relations**: Covers project-layer root discovery and repo-scope loading.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config_for_cwd, mark_as_git_repo, write_skill_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `loads_skills_from_agents_dir_without_codex_dir`  (lines 1528–1561)

```
async fn loads_skills_from_agents_dir_without_codex_dir()
```

**Purpose**: Checks that repo-local `.agents/skills` roots are discovered even when no `.codex` directory exists.

**Data flow**: Creates a fake git repo, writes a skill under `.agents/skills`, loads skills for that cwd, and asserts one repo-scoped skill.

**Call relations**: Exercises `repo_agents_skill_roots` independently of project config layers.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config_for_cwd, mark_as_git_repo, write_skill_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `loads_skills_from_all_codex_dirs_under_project_root`  (lines 1564–1627)

```
async fn loads_skills_from_all_codex_dirs_under_project_root()
```

**Purpose**: Verifies that nested `.codex/skills` directories between project root and cwd all contribute repo-scoped skills.

**Data flow**: Creates a fake repo with root and nested `.codex/skills` directories, writes one skill in each, loads skills from a deeper cwd, and asserts both repo-scoped skills are present.

**Call relations**: Documents multi-layer repo skill discovery along the cwd ancestry chain.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config_for_cwd, mark_as_git_repo, write_skill_at); 4 external calls (assert!, assert_eq!, create_dir_all, tempdir).


##### `loads_skills_from_codex_dir_when_not_git_repo`  (lines 1630–1666)

```
async fn loads_skills_from_codex_dir_when_not_git_repo()
```

**Purpose**: Checks that a local `.codex/skills` directory at the cwd still loads even outside a git repository.

**Data flow**: Creates a work directory with `.codex/skills`, writes a skill there, builds config for that cwd, loads skills, and asserts one repo-scoped skill.

**Call relations**: Covers the fallback behavior when no project-root marker is found.

*Call graph*: calls 3 internal fn (load_skills_for_test, make_config_for_cwd, write_skill_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `deduplicates_by_path_preferring_first_root`  (lines 1669–1711)

```
async fn deduplicates_by_path_preferring_first_root()
```

**Purpose**: Verifies that when the same canonical skill path appears from multiple roots, the first root’s version wins.

**Data flow**: Creates one physical skill root and loads it twice as repo then user scope, then asserts the final outcome contains only the repo-scoped skill.

**Call relations**: Exercises path-based deduplication order in `load_skills_from_roots`.

*Call graph*: calls 1 internal fn (write_skill_at); 4 external calls (clone, assert!, assert_eq!, tempdir).


##### `keeps_duplicate_names_from_repo_and_user`  (lines 1714–1765)

```
async fn keeps_duplicate_names_from_repo_and_user()
```

**Purpose**: Checks that duplicate skill names from different paths and scopes are both retained.

**Data flow**: Creates one user skill and one repo skill with the same name, loads skills for the repo cwd, and asserts both `SkillMetadata` entries are present with different scopes and paths.

**Call relations**: Documents that deduplication is by path, not by name.

*Call graph*: calls 5 internal fn (load_skills_for_test, make_config_for_cwd, mark_as_git_repo, write_skill, write_skill_at); 3 external calls (assert!, assert_eq!, tempdir).


##### `keeps_duplicate_names_from_nested_codex_dirs`  (lines 1768–1839)

```
async fn keeps_duplicate_names_from_nested_codex_dirs()
```

**Purpose**: Verifies that duplicate names from different nested repo roots are both retained and sorted deterministically by path.

**Data flow**: Creates root and nested repo skills with the same name, loads skills, computes normalized paths and expected ordering, and asserts both entries are present.

**Call relations**: Covers duplicate-name retention within repo scope across multiple roots.

*Call graph*: calls 5 internal fn (load_skills_for_test, make_config_for_cwd, mark_as_git_repo, normalized, write_skill_at); 4 external calls (assert!, assert_eq!, create_dir_all, tempdir).


##### `repo_skills_search_does_not_escape_repo_root`  (lines 1842–1868)

```
async fn repo_skills_search_does_not_escape_repo_root()
```

**Purpose**: Checks that repo-local skill discovery does not walk above the detected project root.

**Data flow**: Creates an outer directory with `.codex/skills`, nests a fake git repo inside it, loads skills from the repo cwd, and asserts no outer skill is discovered.

**Call relations**: Exercises the project-root boundary enforced by `dirs_between_project_root_and_cwd`.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config_for_cwd, mark_as_git_repo, write_skill_at); 4 external calls (assert!, assert_eq!, create_dir_all, tempdir).


##### `loads_skills_when_cwd_is_file_in_repo`  (lines 1871–1910)

```
async fn loads_skills_when_cwd_is_file_in_repo()
```

**Purpose**: Verifies that project-layer discovery works when the cwd input is a file path inside a repository rather than a directory.

**Data flow**: Creates a fake repo with a skill and a regular file, builds config using the file path as cwd, loads skills, and asserts the repo skill is found.

**Call relations**: Covers the file-cwd normalization logic in `project_layers_for_cwd`.

*Call graph*: calls 4 internal fn (load_skills_for_test, make_config_for_cwd, mark_as_git_repo, write_skill_at); 4 external calls (assert!, assert_eq!, write, tempdir).


##### `non_git_repo_skills_search_does_not_walk_parents`  (lines 1913–1938)

```
async fn non_git_repo_skills_search_does_not_walk_parents()
```

**Purpose**: Checks that without a git/project-root marker, repo skill discovery does not search parent directories above the cwd.

**Data flow**: Creates an outer directory with `.codex/skills`, chooses a nested cwd without `.git`, loads skills, and asserts zero skills are found.

**Call relations**: Documents the non-git fallback behavior of project-root discovery.

*Call graph*: calls 3 internal fn (load_skills_for_test, make_config_for_cwd, write_skill_at); 4 external calls (assert!, assert_eq!, create_dir_all, tempdir).


##### `loads_skills_from_system_cache_when_present`  (lines 1941–1969)

```
async fn loads_skills_from_system_cache_when_present()
```

**Purpose**: Verifies that bundled/system skills under the system cache root are loaded as system-scoped skills.

**Data flow**: Writes a system skill under `skills/.system`, builds config for an arbitrary cwd, loads skills, and asserts one system-scoped `SkillMetadata`.

**Call relations**: Covers the special bundled system cache root.

*Call graph*: calls 3 internal fn (load_skills_for_test, make_config_for_cwd, write_system_skill); 3 external calls (assert!, assert_eq!, tempdir).


##### `skill_roots_include_admin_with_lowest_priority`  (lines 1972–1993)

```
async fn skill_roots_include_admin_with_lowest_priority()
```

**Purpose**: Checks the overall scope ordering of roots returned by `skill_roots`, with admin last.

**Data flow**: Builds a default config, calls `skill_roots`, maps roots to scopes, constructs the expected scope sequence depending on whether a home dir exists, and asserts equality.

**Call relations**: Documents root ordering as seen by the manager and loader.

*Call graph*: calls 1 internal fn (make_config); 6 external calls (clone, new, assert_eq!, skill_roots, tempdir, vec!).


### `core-skills/src/manager_tests.rs`

`test` · `test`

This test module focuses on behavior added by `manager.rs` on top of the raw loader. Its helpers create user and plugin skills on disk, derive `PluginSkillRoot` values from plugin skill paths, build minimal `SkillMetadata` fixtures for config-rule tests, and synthesize `ConfigLayerStack` values with user and session-flag layers. `skills_for_config_with_stack` is the main harness for the config-aware load path: it constructs `SkillsLoadInput` using `bundled_skills_enabled_from_stack` and calls `SkillsManager::skills_for_config` with `LOCAL_FS`.

The tests split into three themes. First, manager lifecycle and caching: disabling bundled skills at construction removes stale cached system skills; config-aware loads reuse cache entries when effective config is unchanged; cwd-based loads reuse stale results until `force_reload`; and `set_extra_roots` both changes the effective root set and clears caches for cwd-based and config-based loads. Second, root and filtering behavior: cwd loads include repo roots only when an executor filesystem is supplied, bundled/system roots are excluded when disabled in config, and plugin skills can be disabled by qualified name while still loading into the outcome’s full skill list with their path recorded in `disabled_paths`. Third, config-rule precedence: path and name selectors are tested directly through `skill_config_rules_from_stack` and `resolve_disabled_skill_paths`, showing that session flags override user-layer rules and that later name selectors can override earlier path selectors.

These tests document the manager’s key invariant: the returned `SkillLoadOutcome` may still contain disabled skills in `skills`, but all downstream enablement-sensitive behavior must consult `disabled_paths` or helper methods derived from it.

#### Function details

##### `write_user_skill`  (lines 23–28)

```
fn write_user_skill(codex_home: &TempDir, dir: &str, name: &str, description: &str)
```

**Purpose**: Writes a simple user skill under the temp codex home’s `skills/` directory.

**Data flow**: Builds the target directory, creates it, formats a minimal `SKILL.md` with the provided name and description, and writes the file.

**Call relations**: Used by manager tests that need user-scope skills discovered through normal root selection.

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

**Purpose**: Creates a plugin installation layout with plugin metadata and one skill file, returning the skill path.

**Data flow**: Builds a plugin root under `plugins/cache/<marketplace>/<plugin_name>/local`, creates `.codex-plugin` and skill directories, writes `plugin.json` with the plugin name, writes a minimal `SKILL.md`, and returns its path.

**Call relations**: Used by the plugin disable-by-name test.

*Call graph*: called by 1 (skills_for_config_disables_plugin_skills_by_name); 4 external calls (path, format!, create_dir_all, write).


##### `plugin_skill_root_for_skill_path`  (lines 58–71)

```
fn plugin_skill_root_for_skill_path(skill_path: &Path, plugin_id: &str) -> PluginSkillRoot
```

**Purpose**: Derives the `PluginSkillRoot` descriptor corresponding to a plugin skill file path.

**Data flow**: Walks up from the skill file to its containing `skills` root and plugin root, converts both to absolute paths, combines them with the provided plugin ID, and returns `PluginSkillRoot`.

**Call relations**: Used to feed plugin roots into `SkillsLoadInput` for manager tests.

*Call graph*: called by 1 (skills_for_config_disables_plugin_skills_by_name); 1 external calls (parent).


##### `test_skill`  (lines 73–88)

```
fn test_skill(name: &str, path: PathBuf) -> SkillMetadata
```

**Purpose**: Builds a canonicalized `SkillMetadata` fixture for direct disabled-path rule tests.

**Data flow**: Takes a name and path, canonicalizes the absolute path, fills a `SkillMetadata` with fixed description and default optional fields, and returns it.

**Call relations**: Used by tests that call `resolve_disabled_skill_paths` directly without loading from disk.

*Call graph*: called by 4 (disabled_paths_for_skills_allows_name_selector_to_override_path_selector, disabled_paths_for_skills_allows_session_flags_to_disable_user_enabled_skill, disabled_paths_for_skills_allows_session_flags_to_override_user_layer, disabled_paths_for_skills_disables_matching_name_selectors); 1 external calls (abs).


##### `write_demo_skill`  (lines 90–100)

```
fn write_demo_skill(tempdir: &TempDir) -> PathBuf
```

**Purpose**: Writes a fixed demo skill under a temp directory and returns its path.

**Data flow**: Creates `<tempdir>/skills/demo/SKILL.md`, writes a standard demo frontmatter/body file, and returns the path.

**Call relations**: Used by direct config-rule precedence tests.

*Call graph*: called by 4 (disabled_paths_for_skills_allows_name_selector_to_override_path_selector, disabled_paths_for_skills_allows_session_flags_to_disable_user_enabled_skill, disabled_paths_for_skills_allows_session_flags_to_override_user_layer, disabled_paths_for_skills_disables_matching_name_selectors); 3 external calls (path, create_dir_all, write).


##### `user_config_layer`  (lines 102–112)

```
fn user_config_layer(codex_home: &TempDir, config_toml: &str) -> ConfigLayerEntry
```

**Purpose**: Builds a user `ConfigLayerEntry` from TOML text rooted at the temp codex home.

**Data flow**: Constructs an absolute `config.toml` path under the temp home, parses the provided TOML string, and returns `ConfigLayerEntry::new(ConfigLayerSource::User { ... }, parsed_toml)`.

**Call relations**: Used by config-stack helpers.

*Call graph*: calls 2 internal fn (new, try_from); 2 external calls (path, from_str).


##### `config_stack`  (lines 114–121)

```
fn config_stack(codex_home: &TempDir, user_config_toml: &str) -> ConfigLayerStack
```

**Purpose**: Creates a one-layer config stack containing only a user config layer.

**Data flow**: Builds the user layer with `user_config_layer`, wraps it in a vector, constructs `ConfigLayerStack::new` with default requirements, and returns the stack.

**Call relations**: Used by many manager tests that only need user-layer configuration.

*Call graph*: calls 1 internal fn (new); called by 7 (set_extra_roots_applies_to_config_loads_and_empty_clears, set_extra_roots_replaces_runtime_roots_and_clears_cache, skills_for_config_disables_plugin_skills_by_name, skills_for_config_excludes_bundled_skills_when_disabled_in_config, skills_for_config_ignores_cwd_cache_when_session_flags_reenable_skill, skills_for_config_reuses_cache_for_same_effective_config, skills_for_cwd_uses_cached_result_until_force_reload); 3 external calls (default, default, vec!).


##### `config_stack_with_session_flags`  (lines 123–140)

```
fn config_stack_with_session_flags(
    codex_home: &TempDir,
    user_config_toml: &str,
    session_flags_toml: &str,
) -> ConfigLayerStack
```

**Purpose**: Creates a config stack containing both a user layer and a session-flags layer.

**Data flow**: Builds a user layer and a `SessionFlags` layer from TOML strings, constructs a `ConfigLayerStack` with default requirements, and returns it.

**Call relations**: Used by tests covering session-flag precedence and config-aware caching.

*Call graph*: calls 1 internal fn (new); called by 1 (skills_for_config_ignores_cwd_cache_when_session_flags_reenable_skill); 3 external calls (default, default, vec!).


##### `path_toggle_config`  (lines 142–150)

```
fn path_toggle_config(path: &std::path::Path, enabled: bool) -> String
```

**Purpose**: Formats TOML that enables or disables a skill by exact path selector.

**Data flow**: Interpolates the path display string and boolean into a `[[skills.config]]` TOML snippet and returns it.

**Call relations**: Used by direct config-rule tests and the session-flag re-enable test.

*Call graph*: called by 4 (disabled_paths_for_skills_allows_name_selector_to_override_path_selector, disabled_paths_for_skills_allows_session_flags_to_disable_user_enabled_skill, disabled_paths_for_skills_allows_session_flags_to_override_user_layer, skills_for_config_ignores_cwd_cache_when_session_flags_reenable_skill); 1 external calls (format!).


##### `name_toggle_config`  (lines 152–159)

```
fn name_toggle_config(name: &str, enabled: bool) -> String
```

**Purpose**: Formats TOML that enables or disables a skill by exact name selector.

**Data flow**: Interpolates the skill name and boolean into a `[[skills.config]]` TOML snippet and returns it.

**Call relations**: Used by plugin disable-by-name and selector-precedence tests.

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

**Purpose**: Convenience harness that runs the config-aware manager load path for a given config stack and plugin root set.

**Data flow**: Constructs `SkillsLoadInput` from the cwd tempdir, cloned config stack, copied plugin roots, and `bundled_skills_enabled_from_stack(config_layer_stack)`, then awaits `skills_manager.skills_for_config(..., Some(LOCAL_FS))` and returns the outcome.

**Call relations**: Central helper for tests targeting `SkillsManager::skills_for_config`.

*Call graph*: calls 2 internal fn (new, skills_for_config); called by 6 (set_extra_roots_applies_to_config_loads_and_empty_clears, skills_for_config_disables_plugin_skills_by_name, skills_for_config_excludes_bundled_skills_when_disabled_in_config, skills_for_config_ignores_cwd_cache_when_session_flags_reenable_skill, skills_for_config_reuses_cache_for_same_effective_config, skills_for_cwd_uses_cached_result_until_force_reload); 4 external calls (clone, path, clone, to_vec).


##### `new_with_disabled_bundled_skills_removes_stale_cached_system_skills`  (lines 179–195)

```
fn new_with_disabled_bundled_skills_removes_stale_cached_system_skills()
```

**Purpose**: Verifies that constructing a manager with bundled skills disabled removes any stale cached system skill directory.

**Data flow**: Creates a fake `skills/.system/stale-skill/SKILL.md`, constructs `SkillsManager::new(..., false)`, and asserts the `skills/.system` directory no longer exists.

**Call relations**: Exercises startup cleanup in `new_with_restriction_product`.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert!, create_dir_all, write, tempdir).


##### `skills_for_config_reuses_cache_for_same_effective_config`  (lines 198–222)

```
async fn skills_for_config_reuses_cache_for_same_effective_config()
```

**Purpose**: Checks that config-aware loads reuse cached results when the effective skill config and roots are unchanged.

**Data flow**: Creates a manager and empty config stack, writes one user skill, loads once through `skills_for_config_with_stack`, writes a second skill afterward, loads again with the same stack, and asserts the second outcome matches the first exactly.

**Call relations**: Documents the behavior of the config-keyed cache.

*Call graph*: calls 4 internal fn (new, config_stack, skills_for_config_with_stack, write_user_skill); 3 external calls (assert!, assert_eq!, tempdir).


##### `set_extra_roots_replaces_runtime_roots_and_clears_cache`  (lines 225–294)

```
async fn set_extra_roots_replaces_runtime_roots_and_clears_cache()
```

**Purpose**: Verifies that changing runtime extra roots affects cwd-based loads and invalidates stale cached outcomes.

**Data flow**: Builds a manager and `SkillsLoadInput`, confirms an initial cwd load lacks `runtime-skill`, writes a skill under an extra root, calls `set_extra_roots` with that root, reloads and asserts the skill appears, then replaces extra roots with a missing path, reloads again, and asserts the skill disappears with no errors.

**Call relations**: Exercises both extra-root replacement and cache clearing on the cwd-based path.

*Call graph*: calls 3 internal fn (new, new, config_stack); 8 external calls (clone, new, assert!, assert_eq!, create_dir_all, write, tempdir, vec!).


##### `set_extra_roots_applies_to_config_loads_and_empty_clears`  (lines 297–344)

```
async fn set_extra_roots_applies_to_config_loads_and_empty_clears()
```

**Purpose**: Checks that runtime extra roots also affect config-aware loads and that setting them to empty removes previously visible runtime skills.

**Data flow**: Loads once with no extra roots and confirms absence of `runtime-skill`, writes a runtime skill under an extra root, sets that root, reloads through `skills_for_config_with_stack` and confirms presence, then clears extra roots and confirms absence again.

**Call relations**: Covers extra-root handling on the config-keyed path.

*Call graph*: calls 3 internal fn (new, config_stack, skills_for_config_with_stack); 6 external calls (new, assert!, create_dir_all, write, tempdir, vec!).


##### `skills_for_config_disables_plugin_skills_by_name`  (lines 347–392)

```
async fn skills_for_config_disables_plugin_skills_by_name()
```

**Purpose**: Verifies that a plugin skill can be disabled by its qualified name while still being loaded into the full outcome.

**Data flow**: Creates a plugin skill and corresponding plugin root, builds a config stack disabling `sample:sample-search` by name, loads through `skills_for_config_with_stack`, finds the loaded skill, canonicalizes its path, and asserts that path is present in `outcome.disabled_paths` and absent from `allowed_skills_for_implicit_invocation()`.

**Call relations**: Exercises manager-level disabled-path resolution for plugin-qualified names.

*Call graph*: calls 6 internal fn (new, config_stack, name_toggle_config, plugin_skill_root_for_skill_path, skills_for_config_with_stack, write_plugin_skill); 4 external calls (assert!, assert_eq!, canonicalize, tempdir).


##### `skills_for_cwd_loads_repo_and_user_roots_with_local_fs`  (lines 395–455)

```
async fn skills_for_cwd_loads_repo_and_user_roots_with_local_fs()
```

**Purpose**: Checks that cwd-based loads include both repo and user roots when an executor filesystem is supplied.

**Data flow**: Creates a cwd with `.codex/skills` and a user skill under codex home, builds a config stack containing user and project layers, constructs `SkillsLoadInput`, loads with `skills_for_cwd(..., Some(LOCAL_FS))`, and asserts both skill names are present.

**Call relations**: Documents the dependency of repo-root loading on having a filesystem.

*Call graph*: calls 4 internal fn (new, new, new, write_user_skill); 9 external calls (clone, default, new, assert!, default, create_dir_all, write, tempdir, vec!).


##### `skills_for_cwd_without_fs_skips_repo_roots`  (lines 458–514)

```
async fn skills_for_cwd_without_fs_skips_repo_roots()
```

**Purpose**: Verifies that cwd-based loads omit repo roots when no executor filesystem is available.

**Data flow**: Creates the same user and repo skill setup as the previous test, but calls `skills_for_cwd(..., None)`, then asserts the user skill is present and the repo skill is absent.

**Call relations**: Covers the `fs.is_some()` gate in root selection and cwd caching.

*Call graph*: calls 4 internal fn (new, new, new, write_user_skill); 8 external calls (default, new, assert!, default, create_dir_all, write, tempdir, vec!).


##### `skills_for_config_excludes_bundled_skills_when_disabled_in_config`  (lines 517–556)

```
async fn skills_for_config_excludes_bundled_skills_when_disabled_in_config()
```

**Purpose**: Checks that config-aware loads filter out system roots when bundled skills are disabled by config, even if cached bundled files exist on disk.

**Data flow**: Creates a bundled skill under `skills/.system`, builds a config stack with `[skills.bundled] enabled = false`, constructs a manager with bundled skills disabled, recreates the bundled skill after startup cleanup, loads through `skills_for_config_with_stack`, and asserts no returned skill has that name or `SkillScope::System`.

**Call relations**: Exercises root filtering in `skill_roots_for_config` independent of filesystem cleanup success.

*Call graph*: calls 3 internal fn (new, config_stack, skills_for_config_with_stack); 4 external calls (assert!, create_dir_all, write, tempdir).


##### `skills_for_cwd_uses_cached_result_until_force_reload`  (lines 559–617)

```
async fn skills_for_cwd_uses_cached_result_until_force_reload()
```

**Purpose**: Verifies that cwd-based loads reuse cached results until explicitly forced to reload.

**Data flow**: Creates a manager and config stack, primes config-aware loading, performs an initial cwd load and confirms absence of `late-skill`, writes that skill afterward, performs another non-forced cwd load and confirms it is still absent, then performs a forced reload and confirms the skill appears.

**Call relations**: Documents the semantics of the cwd-keyed cache and `force_reload`.

*Call graph*: calls 5 internal fn (new, new, config_stack, skills_for_config_with_stack, write_user_skill); 4 external calls (clone, new, assert!, tempdir).


##### `disabled_paths_for_skills_allows_session_flags_to_override_user_layer`  (lines 621–652)

```
fn disabled_paths_for_skills_allows_session_flags_to_override_user_layer()
```

**Purpose**: Checks that a session-flags rule enabling a path overrides a user-layer rule disabling the same path.

**Data flow**: Writes a demo skill, builds `SkillMetadata` for it, constructs a config stack with user-layer `enabled = false` and session-layer `enabled = true` for the same path, derives `SkillConfigRules`, resolves disabled paths, and asserts the result is empty.

**Call relations**: Directly exercises config-rule precedence outside the manager load pipeline.

*Call graph*: calls 7 internal fn (new, new, skill_config_rules_from_stack, path_toggle_config, test_skill, write_demo_skill, try_from); 6 external calls (default, assert_eq!, default, tempdir, from_str, vec!).


##### `disabled_paths_for_skills_allows_session_flags_to_disable_user_enabled_skill`  (lines 656–690)

```
fn disabled_paths_for_skills_allows_session_flags_to_disable_user_enabled_skill()
```

**Purpose**: Verifies the inverse precedence case: session flags can disable a path that the user layer enabled.

**Data flow**: Creates the same fixture skill, builds a stack with user `enabled = true` and session `enabled = false`, resolves disabled paths, and asserts the canonical skill path is disabled.

**Call relations**: Complements the previous precedence test.

*Call graph*: calls 7 internal fn (new, new, skill_config_rules_from_stack, path_toggle_config, test_skill, write_demo_skill, try_from); 6 external calls (default, assert_eq!, default, tempdir, from_str, vec!).


##### `disabled_paths_for_skills_disables_matching_name_selectors`  (lines 694–723)

```
fn disabled_paths_for_skills_disables_matching_name_selectors()
```

**Purpose**: Checks that disabling by exact skill name marks matching skills as disabled.

**Data flow**: Creates a canonicalized skill named `github:yeet`, builds a user config stack disabling that name, derives rules, resolves disabled paths, and asserts the skill path is returned.

**Call relations**: Exercises name-based selectors in the config-rule engine.

*Call graph*: calls 7 internal fn (new, new, skill_config_rules_from_stack, name_toggle_config, test_skill, write_demo_skill, try_from); 6 external calls (default, assert_eq!, default, tempdir, from_str, vec!).


##### `disabled_paths_for_skills_allows_name_selector_to_override_path_selector`  (lines 727–758)

```
fn disabled_paths_for_skills_allows_name_selector_to_override_path_selector()
```

**Purpose**: Verifies that a later name-based enable rule can override an earlier path-based disable rule for the same skill.

**Data flow**: Creates a skill, builds a stack with user-layer path disable and session-layer name enable, derives rules, resolves disabled paths, and asserts the result is empty.

**Call relations**: Documents selector precedence across selector types and config layers.

*Call graph*: calls 8 internal fn (new, new, skill_config_rules_from_stack, name_toggle_config, path_toggle_config, test_skill, write_demo_skill, try_from); 6 external calls (default, assert_eq!, default, tempdir, from_str, vec!).


##### `skills_for_config_ignores_cwd_cache_when_session_flags_reenable_skill`  (lines 762–811)

```
async fn skills_for_config_ignores_cwd_cache_when_session_flags_reenable_skill()
```

**Purpose**: Checks that config-aware loads do not reuse a stale cwd-keyed cache entry when session flags change skill enablement.

**Data flow**: Creates one user skill, builds a parent config stack disabling it by path and a child stack that re-enables it via session flags, constructs a manager, loads the parent through `skills_for_cwd(force_reload = true)` and asserts the discovered skill is disabled, then loads the child through `skills_for_config_with_stack` and asserts the same discovered skill is enabled.

**Call relations**: Demonstrates why `skills_for_config` uses a config-derived cache key instead of the cwd cache.

*Call graph*: calls 6 internal fn (new, new, config_stack, config_stack_with_session_flags, path_toggle_config, skills_for_config_with_stack); 6 external calls (clone, new, assert_eq!, create_dir_all, write, tempdir).


### `ext/skills/tests/executor_file_system_authority.rs`

`test` · `request handling`

This test file defines a minimal `SyntheticFileSystem` that implements `ExecutorFileSystem` over an in-memory, hard-coded tree: a root directory containing `skill/SKILL.md` with `SKILL_CONTENTS`. The struct stores both an `alias_root` and a `canonical_root`; its key behavior is that canonicalization rewrites the alias path to the canonical path, while metadata, directory listing, and file reads only succeed for the canonical tree and otherwise return `io::ErrorKind::NotFound`. That setup exercises the production loader’s use of the executor filesystem rather than the host OS filesystem.

The trait implementation is intentionally narrow and read-only. `read_file_stream`, `write_file`, `create_directory`, `remove`, and `copy` all fail with `Unsupported`, making the test sensitive to any unexpected write or streaming path. `get_metadata` and `read_directory` route through the synthetic tree, and `metadata` encodes the only valid nodes: canonical root, `skill/`, and `skill/SKILL.md`.

Two async Tokio tests cover distinct invariants. The first confirms `load_skills_from_roots` can discover a skill through the supplied executor filesystem even when the alias path does not exist on disk, and that later reads via `HostLoadedSkills` still resolve to the synthetic contents at the canonicalized path. The second creates a real temporary skill root and verifies `ExecutorSkillProvider::list` preserves distinct `SelectedCapabilityRoot.id` values in generated `skill://...` display paths even when both selected roots point to the same underlying canonical filesystem location. A helper uses an atomic counter plus process ID to create unique temporary directories and writes a real `SKILL.md` file for that scenario.

#### Function details

##### `SyntheticFileSystem::metadata`  (lines 75–93)

```
fn metadata(&self, path: &AbsolutePathBuf) -> io::Result<FileMetadata>
```

**Purpose**: Computes synthetic metadata for the only three paths this fake filesystem recognizes: the canonical root directory, its `skill` subdirectory, and the `skill/SKILL.md` file. Any other path is rejected as missing.

**Data flow**: It takes an `&AbsolutePathBuf`, derives `skill_dir` and `skill_path` from `self.canonical_root`, compares the input path against those known locations, and maps the match to `(is_directory, is_file)` flags. It returns a `FileMetadata` with those flags plus fixed values for symlink, size, and timestamps, or returns `io::ErrorKind::NotFound` if the path is outside the synthetic tree.

**Call relations**: This is the shared path-validation primitive for the fake filesystem. The async canonicalization path uses it to prove that non-alias paths actually exist before returning them unchanged, and the trait-level metadata query delegates to it after converting the incoming `PathUri`.

*Call graph*: calls 1 internal fn (join); called by 2 (canonicalize, get_metadata); 1 external calls (new).


##### `SyntheticFileSystem::canonicalize`  (lines 97–103)

```
fn canonicalize(
        &'a self,
        path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, PathUri>
```

**Purpose**: Implements the executor filesystem canonicalization contract by translating the configured alias root to the configured canonical root and validating all other paths against the synthetic tree.

**Data flow**: It receives a `&PathUri`, converts it to an absolute path, and checks whether that absolute path equals `self.alias_root`. If so, it returns a new `PathUri` built from `self.canonical_root`; otherwise it calls `self.metadata` to ensure the path exists and then returns a `PathUri` for the original absolute path.

**Call relations**: This method is exposed through the `ExecutorFileSystem` trait implementation and is invoked by code under test when skill roots are normalized. Its alias-to-canonical rewrite is what lets the first test prove that loader logic uses the supplied executor filesystem instead of probing the host filesystem directly.

*Call graph*: calls 3 internal fn (metadata, from_abs_path, to_abs_path); 1 external calls (pin).


##### `SyntheticFileSystem::read_file`  (lines 105–111)

```
fn read_file(
        &'a self,
        path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>>
```

**Purpose**: Returns the hard-coded markdown contents only for the synthetic `canonical_root/skill/SKILL.md` file.

**Data flow**: It takes a `&PathUri`, converts it to an absolute path, compares that path to `self.canonical_root.join("skill/SKILL.md")`, and on an exact match returns `SKILL_CONTENTS` as a `Vec<u8>`. Any other path yields a `NotFound` I/O error.

**Call relations**: This is the concrete file-read path used by the loader and later by `HostLoadedSkills` in the first test. By only recognizing the canonical skill file, it reinforces the expectation that canonicalization happened before content reads.

*Call graph*: calls 2 internal fn (join, to_abs_path); 2 external calls (pin, new).


##### `SyntheticFileSystem::read_file_stream`  (lines 113–124)

```
fn read_file_stream(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream>
```

**Purpose**: Explicitly rejects streaming reads for the synthetic filesystem.

**Data flow**: It ignores the requested path and sandbox context and returns a boxed async future that resolves to `io::ErrorKind::Unsupported` with a fixed explanatory message.

**Call relations**: This trait method exists only to satisfy the `ExecutorFileSystem` interface for the test double. If production code unexpectedly switched from buffered reads to streaming reads in these scenarios, this test filesystem would fail fast and expose that change.

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

**Purpose**: Makes the synthetic filesystem read-only by rejecting all write attempts.

**Data flow**: It accepts a path, byte contents, and optional sandbox but ignores them all, returning a boxed async future that resolves to an `Unsupported` error labeled `read only`.

**Call relations**: This is defensive test scaffolding: the file under test should never need to mutate executor skill roots during discovery or reading. Any accidental write path would surface immediately through this method.

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

**Purpose**: Rejects directory creation so the fake executor filesystem remains immutable.

**Data flow**: It takes the requested path, creation options, and sandbox context, ignores them, and returns an async `Unsupported` error with the message `read only`.

**Call relations**: Like the other mutating trait methods, this supports the test double’s invariant that skill loading is purely read-side. It would only be reached if the code under test attempted to materialize directories in executor storage.

*Call graph*: 2 external calls (pin, new).


##### `SyntheticFileSystem::get_metadata`  (lines 144–150)

```
fn get_metadata(
        &'a self,
        path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>
```

**Purpose**: Adapts the internal metadata helper to the `ExecutorFileSystem` trait’s async `PathUri`-based interface.

**Data flow**: It receives a `&PathUri`, converts it to an absolute path inside a boxed async block, and passes that path to `self.metadata`. The result is either the synthetic `FileMetadata` for one of the known nodes or the propagated conversion/not-found error.

**Call relations**: This is the trait entry point for metadata lookups from the loader stack. It delegates all path semantics to `SyntheticFileSystem::metadata`, keeping the fake filesystem’s existence rules centralized.

*Call graph*: calls 2 internal fn (metadata, to_abs_path); 1 external calls (pin).


##### `SyntheticFileSystem::read_directory`  (lines 152–158)

```
fn read_directory(
        &'a self,
        path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>>
```

**Purpose**: Enumerates the synthetic directory tree: the root contains `skill/`, and `skill/` contains `SKILL.md`.

**Data flow**: It converts the incoming `&PathUri` to an absolute path and compares it against `self.canonical_root` and `self.canonical_root.join("skill")`. For the root it returns one `ReadDirectoryEntry` marked as a directory named `skill`; for the skill directory it returns one file entry named `SKILL.md`; otherwise it returns `NotFound`.

**Call relations**: This trait method is part of the fake filesystem surface used during skill discovery. Its exact two-level listing is what allows the loader to find the markdown file without any backing directories on the host filesystem.

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

**Purpose**: Rejects deletions to preserve the synthetic filesystem’s read-only behavior.

**Data flow**: It accepts a path, remove options, and sandbox context but ignores them, returning a boxed async future that resolves to `Unsupported` with `read only`.

**Call relations**: This is another guardrail in the test double. It should not participate in the tested flows unless production code unexpectedly tries to clean up or mutate executor roots.

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

**Purpose**: Rejects copy operations so no synthetic filesystem state can be duplicated or changed during tests.

**Data flow**: It takes source and destination paths, copy options, and sandbox context, ignores them, and returns an async `Unsupported` error with the message `read only`.

**Call relations**: This completes the read-only `ExecutorFileSystem` implementation. It is present to satisfy the trait and to make any unintended copy-based behavior fail loudly in these tests.

*Call graph*: 2 external calls (pin, new).


##### `skill_loading_and_reads_use_the_supplied_executor_file_system`  (lines 181–216)

```
async fn skill_loading_and_reads_use_the_supplied_executor_file_system()
```

**Purpose**: Verifies that skill discovery and subsequent skill text reads go through the provided executor filesystem, including alias-to-canonical path rewriting, rather than requiring real on-disk paths.

**Data flow**: The test constructs a temporary base path, derives nonexistent `alias_root` and `canonical_root` absolute paths, and asserts neither exists on disk. It then calls `load_skills_from_roots` with a single `SkillRoot` whose `file_system` is an `Arc<SyntheticFileSystem>`, checks that loading produced no errors and exactly one skill, asserts the discovered skill name and canonical `path_to_skills_md`, wraps the outcome in `HostLoadedSkills`, and finally reads the skill body back and compares it to `SKILL_CONTENTS`.

**Call relations**: This is a top-level Tokio test driving the synthetic filesystem through the real loader stack. It exercises the interaction between `load_skills_from_roots`, the executor filesystem trait methods, and `HostLoadedSkills::read_skill_text` to prove the supplied filesystem remains authoritative for both discovery and later content access.

*Call graph*: calls 3 internal fn (load_skills_from_roots, new, from_absolute_path_checked); 5 external calls (new, assert!, assert_eq!, format!, temp_dir).


##### `selected_root_id_distinguishes_identical_executor_paths`  (lines 219–282)

```
async fn selected_root_id_distinguishes_identical_executor_paths()
```

**Purpose**: Checks that executor skill catalog entries remain distinct by selected root ID even when multiple capability roots point at the same physical directory.

**Data flow**: The test creates a real temporary skill root via `create_local_skill_root`, derives both the original root path string and a canonicalized slash-normalized absolute path, constructs an `ExecutorSkillProvider` with a test `EnvironmentManager`, and calls `list` with two `SelectedCapabilityRoot` values (`root-a` and `root-b`) that both reference the same local environment path. It then maps the returned catalog entries to `(authority.id, display_path)` pairs and asserts they equal two distinct `skill://root-*/.../skill/SKILL.md` URIs, finally removing the temporary directory.

**Call relations**: This is the second top-level Tokio test and drives the provider/listing path rather than the low-level filesystem trait directly. It depends on `create_local_skill_root` for fixture setup and validates that authority identity in the catalog comes from `SelectedCapabilityRoot.id`, not just canonical filesystem location.

*Call graph*: calls 4 internal fn (default_for_tests, new_with_restriction_product, create_local_skill_root, from_absolute_path_checked); 3 external calls (new, assert_eq!, remove_dir_all).


##### `create_local_skill_root`  (lines 284–294)

```
fn create_local_skill_root(label: &str) -> io::Result<std::path::PathBuf>
```

**Purpose**: Builds a unique temporary on-disk skill root containing `skill/SKILL.md` for tests that need a real filesystem directory.

**Data flow**: It takes a descriptive `label`, increments the global `NEXT_TEST_ROOT_ID` atomic counter, combines that ID with the process ID to form a unique temp directory name, creates the `skill` subdirectory, writes `SKILL_CONTENTS` into `skill/SKILL.md`, and returns the resulting `PathBuf` or any I/O error encountered.

**Call relations**: This helper is called by `selected_root_id_distinguishes_identical_executor_paths` to provision a concrete local root that the environment-backed provider can inspect. The atomic counter avoids collisions across repeated test runs within the same process.

*Call graph*: called by 1 (selected_root_id_distinguishes_identical_executor_paths); 4 external calls (format!, temp_dir, create_dir_all, write).


### `ext/skills/tests/skills_extension.rs`

`test` · `test execution; startup and per-turn extension behavior validation`

This file exercises the installed skills extension through the public extension registry interfaces rather than unit-testing internals. Each async test builds an `ExtensionRegistryBuilder`, installs the extension with either the default installer or explicit `SkillProviders`, creates `ExtensionData` stores for session/thread/turn scope, triggers `on_thread_start`, and then inspects either context fragments or turn-input fragments produced by the registry. The tests verify several concrete behaviors: host-loaded skills already present in turn state are rendered into both the developer catalog block and a user `<skill>` payload; executor skills selected via `SelectedCapabilityRoot` appear in context and are only read when explicitly invoked in turn input; orchestrator catalog lookup failures emit a warning event once and are cached so repeated turns do not re-list; root-qualified mentions disambiguate duplicate executor skill names by locator; and prompt-hidden skills are omitted from the catalog text but remain invocable by `$name`.

To support those scenarios, `StaticSkillProvider` implements `SkillProvider` with a cloned in-memory `SkillCatalog`, optional list-call counting, optional first-call failure, and read-request recording behind `Arc<Mutex<Vec<SkillReadRequest>>>`. `ChannelEventSink` forwards emitted `Event`s into a standard mpsc channel so tests can assert warning contents. Helper functions build canonical `SkillCatalogEntry` values, a minimal `TestConfig` mapped into `SkillsExtensionConfig`, unique temp directories, and simplified tuples extracted from recorded read requests. The tests pay attention to exact rendered prompt text, authority/package/resource triples, and persistence of markers such as `InjectedHostSkillPrompts`.

#### Function details

##### `installed_extension_uses_host_loaded_skills`  (lines 55–138)

```
async fn installed_extension_uses_host_loaded_skills() -> TestResult
```

**Purpose**: Verifies that an installed extension consumes `HostLoadedSkills` already placed in turn-scoped storage and turns them into both the skills catalog instructions and the concrete `<skill>` prompt payload. It also checks that the extension marks the injected host skill path in `InjectedHostSkillPrompts`.

**Data flow**: Creates a unique temp Codex home, writes `DEMO_SKILL_CONTENTS` to `skills/demo/SKILL.md`, builds a default `TestConfig`, installs the extension, and runs thread startup with fresh session/thread stores. It then constructs a `SkillLoadOutcome` containing one `SkillMetadata` for the demo skill, wraps it in `HostLoadedSkills`, inserts that into turn storage, and invokes the first turn-input contributor with user text `$demo`. The returned fragments are rendered and compared against exact expected developer and user strings; afterward the turn store is queried for `InjectedHostSkillPrompts`, and the temp directory is removed before returning `Ok(())`.

**Call relations**: This is a top-level async test invoked by the test runner. It drives the full extension lifecycle for one turn, relying on `test_codex_home` to isolate filesystem state and `default_config` for configuration, then delegates behavior to the installed registry contributors and finally validates the side effects they wrote into turn-scoped extension data.

*Call graph*: calls 6 internal fn (new, new, new, default_config, test_codex_home, try_from); 12 external calls (clone, new, new, assert!, assert_eq!, install, default, format!, create_dir_all, remove_dir_all (+2 more)).


##### `selected_executor_catalog_is_context_and_selected_entrypoint_is_turn_input`  (lines 141–256)

```
async fn selected_executor_catalog_is_context_and_selected_entrypoint_is_turn_input() -> TestResult
```

**Purpose**: Checks that a selected executor capability root contributes a catalog entry to context prompts, while the actual skill body is only injected when the user invokes that selected skill in turn input. It also confirms the provider read request targets the expected executor authority/package/resource triple.

**Data flow**: Builds a `StaticSkillProvider` with one executor `SkillCatalogEntry`, wrapping a shared `read_requests` vector. It installs the extension with that executor provider, inserts a `Vec<SelectedCapabilityRoot>` into thread storage for `lint-fix`, runs thread startup, and asks the first context contributor for prompt fragments. After asserting the catalog text contains the executor skill and environment resource locator, it creates turn storage and invokes the first turn-input contributor with `$lint-fix please`, asserting one user fragment containing the skill name and markdown body. It converts recorded `SkillReadRequest`s via `read_request_keys`, re-runs context contribution to ensure the catalog remains available, then runs a second turn with no skill invocation and asserts no fragments are produced.

**Call relations**: This test is entered by the test harness and orchestrates both context and turn-input phases against the same registry instance. It depends on `test_entry` to build the catalog item, `default_config` for extension settings, and `read_request_keys` to normalize provider-side observations into assertion-friendly tuples.

*Call graph*: calls 4 internal fn (new, new, new, default_config); 8 external calls (clone, new, new, new, assert!, assert_eq!, install_with_providers, vec!).


##### `orchestrator_catalog_snapshot_caches_failure`  (lines 259–329)

```
async fn orchestrator_catalog_snapshot_caches_failure() -> TestResult
```

**Purpose**: Validates that an orchestrator provider list failure is surfaced as a warning event once and then cached, preventing repeated list attempts and preventing skill injection on later turns. The test specifically targets snapshot caching of a failed catalog fetch.

**Data flow**: Creates an `AtomicUsize` counter for list calls and a `StaticSkillProvider` configured with `fail_first_list: true` plus one orchestrator catalog entry. It wires a `ChannelEventSink` into the registry builder, installs the extension, initializes session/thread stores, and runs thread startup. It then requests context fragments, expects none, receives one warning `Event` from the mpsc receiver, and asserts the warning message text. Next it runs two separate turns with `$first` input and fresh turn stores, asserting both produce no fragments. Finally it reads the atomic counter and asserts the provider `list` path was called exactly once.

**Call relations**: This top-level test is driven by the test runner and exercises startup, context contribution, event emission, and repeated turn-input contribution. It relies on `default_config` for settings and on `ChannelEventSink::emit` plus `StaticSkillProvider::list` to expose whether the extension retries or caches the failed orchestrator snapshot.

*Call graph*: calls 4 internal fn (with_event_sink, new, new, default_config); 11 external calls (clone, new, new, new, new, assert!, assert_eq!, install_with_providers, panic!, channel (+1 more)).


##### `root_qualified_locator_selects_only_the_matching_executor_skill`  (lines 332–416)

```
async fn root_qualified_locator_selects_only_the_matching_executor_skill() -> TestResult
```

**Purpose**: Ensures that when multiple executor skills share the same visible name, a mention carrying a fully qualified locator selects only the matching root-specific skill. The assertion is based on both rendered prompt content and the exact provider read request.

**Data flow**: Constructs two executor `SkillCatalogEntry` values with identical names `lint-fix` but different root-qualified locators, stores them in a `StaticSkillProvider`, and installs the extension with that executor provider. It inserts two `SelectedCapabilityRoot` values into thread storage for `root-a` and `root-b`, runs thread startup, and invokes the turn-input contributor with a `UserInput::Mention` whose `path` is the `root-b` locator. The returned fragments are asserted to contain only that locator, and the recorded provider requests are transformed by `read_request_keys` and compared to the expected authority/package/resource tuple for `root-b`.

**Call relations**: This async test is called by the test harness and focuses on turn-input resolution after startup has populated thread-scoped selection state. It delegates catalog serving and read recording to `StaticSkillProvider`, while `read_request_keys` provides the normalized evidence that the extension chose the intended executor root.

*Call graph*: calls 4 internal fn (new, new, new, default_config); 8 external calls (clone, new, new, new, assert!, assert_eq!, install_with_providers, vec!).


##### `prompt_hidden_skill_can_still_be_invoked`  (lines 419–493)

```
async fn prompt_hidden_skill_can_still_be_invoked() -> TestResult
```

**Purpose**: Confirms that a catalog entry marked hidden from prompt is omitted from the visible skills catalog but remains callable by explicit `$name` invocation. The test also verifies that the provider read targets the hidden skill rather than the visible one.

**Data flow**: Builds a host `StaticSkillProvider` containing one visible and one `.hidden_from_prompt()` `SkillCatalogEntry`, sharing a `read_requests` log. After installing the extension and running thread startup with default config, it invokes the turn-input contributor for a turn whose user text is `$hidden-skill`. The resulting fragments are asserted to have length two: the first rendered catalog contains `visible-skill` but not `hidden-skill`, and the second rendered user fragment contains `<name>hidden-skill</name>`. Recorded requests are converted with `read_request_keys` and compared to the expected host authority/package/resource tuple for the hidden skill.

**Call relations**: This test is invoked by the test runner and covers the interaction between catalog visibility and invocation resolution in a single turn. It uses `test_entry` to create baseline entries, modifies one entry with the production API's hidden flag, and then inspects provider-side reads through `read_request_keys`.

*Call graph*: calls 4 internal fn (new, new, new, default_config); 8 external calls (clone, new, new, new, assert!, assert_eq!, install_with_providers, vec!).


##### `ChannelEventSink::emit`  (lines 506–508)

```
fn emit(&self, event: Event)
```

**Purpose**: Implements the `ExtensionEventSink` test double by forwarding emitted extension events into a synchronous channel. This lets tests inspect warnings and other events without mocking the extension internals.

**Data flow**: Takes ownership of an `Event` argument and calls `send` on the wrapped `std::sync::mpsc::Sender<Event>`. It ignores send failures by discarding the `Result`, so no state is returned and no panic occurs if the receiver has been dropped.

**Call relations**: The extension infrastructure calls this method whenever it emits an event through the builder-provided sink. In this file it is exercised indirectly by `orchestrator_catalog_snapshot_caches_failure`, which reads the forwarded event from the paired receiver to assert warning behavior.


##### `StaticSkillProvider::list`  (lines 512–526)

```
fn list(&self, _query: SkillListQuery) -> SkillProviderFuture<'_, SkillCatalog>
```

**Purpose**: Returns the provider's in-memory `SkillCatalog`, optionally failing on the first call and optionally incrementing a shared call counter. It simulates provider-side catalog listing behavior for host, executor, or orchestrator sources.

**Data flow**: Accepts a `SkillListQuery` but does not inspect it. It reads `self.list_calls` to optionally `fetch_add` an `AtomicUsize`, computes whether this invocation should fail based on `fail_first_list` and whether the observed prior count was zero, clones `self.catalog`, and returns a boxed async future. That future yields `Err(SkillProviderError::new("temporary orchestrator failure"))` on the configured first failure path, otherwise `Ok(catalog)`.

**Call relations**: Registry contributors invoke this through the `SkillProvider` trait when building or refreshing skill catalogs. In these tests it is central to `orchestrator_catalog_snapshot_caches_failure`, where the extension's retry/caching behavior is inferred from the single increment and the emitted warning.

*Call graph*: calls 1 internal fn (new); 2 external calls (pin, clone).


##### `StaticSkillProvider::read`  (lines 528–540)

```
fn read(&self, request: SkillReadRequest) -> SkillProviderFuture<'_, SkillReadResult>
```

**Purpose**: Records each skill read request and returns a fixed markdown body for the requested resource. It acts as a deterministic stand-in for fetching a skill's `SKILL.md` contents.

**Data flow**: Consumes a `SkillReadRequest`, clones the shared `Arc<Mutex<Vec<SkillReadRequest>>>`, and returns a boxed async future. Inside the future it locks the vector, recovering from poisoning with `PoisonError::into_inner`, pushes a clone of the request, and returns `Ok(SkillReadResult { resource: request.resource, contents: "# Lint Fix\n\nRun the formatter.".to_string() })`.

**Call relations**: The extension calls this trait method only when a selected or invoked skill needs its body injected into prompts. The tests `selected_executor_catalog_is_context_and_selected_entrypoint_is_turn_input`, `root_qualified_locator_selects_only_the_matching_executor_skill`, and `prompt_hidden_skill_can_still_be_invoked` all validate extension resolution logic by inspecting the requests this method recorded.

*Call graph*: 3 external calls (clone, pin, clone).


##### `StaticSkillProvider::search`  (lines 542–544)

```
fn search(&self, _request: SkillSearchRequest) -> SkillProviderFuture<'_, SkillSearchResult>
```

**Purpose**: Implements the `SkillProvider` search API with an always-empty result. The tests in this file do not need search behavior, so this keeps the provider minimal.

**Data flow**: Accepts a `SkillSearchRequest` and ignores it. It returns a boxed async future that resolves to `Ok(SkillSearchResult::default())`, producing no matches and mutating no shared state.

**Call relations**: This method exists to satisfy the `SkillProvider` trait for the test double. None of the tests in this file depend on search results, so it serves as inert plumbing if the extension were to call search during these scenarios.

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

**Purpose**: Constructs a canonical `SkillCatalogEntry` for tests from a source kind, authority id, package id, and main prompt resource path. It derives the visible skill name from the last path segment of the package id and assigns a stable display path.

**Data flow**: Receives `kind`, `authority_id`, `package_id`, and `main_prompt`. It computes `name` by splitting `package_id` on `/` from the right and falling back to the whole string, then creates a `SkillCatalogEntry::new` with `SkillPackageId`, `SkillAuthority`, fixed description `"Fix lint errors."`, and `SkillResourceId::new(main_prompt)`. Finally it applies `.with_display_path(format!("skill://{package_id}/SKILL.md"))` and returns the entry.

**Call relations**: This helper is called by multiple tests to avoid repeating catalog-entry construction details. It feeds `StaticSkillProvider` catalogs in the executor, orchestrator, and host scenarios, ensuring assertions can rely on consistent names and display paths.

*Call graph*: calls 3 internal fn (new, new, new); 2 external calls (new, format!).


##### `default_config`  (lines 570–575)

```
fn default_config() -> TestConfig
```

**Purpose**: Provides the baseline `TestConfig` used by all tests unless they need custom settings. The defaults enable both instruction injection and bundled skills.

**Data flow**: Takes no arguments and returns a `TestConfig` literal with `include_instructions: true` and `bundled_skills_enabled: true`. It reads no external state and writes nothing.

**Call relations**: This helper is called by every top-level test in the file before invoking thread startup. Its output is then transformed by `skills_extension_config` when the extension installer asks for configuration values.

*Call graph*: called by 5 (installed_extension_uses_host_loaded_skills, orchestrator_catalog_snapshot_caches_failure, prompt_hidden_skill_can_still_be_invoked, root_qualified_locator_selects_only_the_matching_executor_skill, selected_executor_catalog_is_context_and_selected_entrypoint_is_turn_input).


##### `skills_extension_config`  (lines 577–582)

```
fn skills_extension_config(config: &TestConfig) -> SkillsExtensionConfig
```

**Purpose**: Maps the local `TestConfig` struct into the production `SkillsExtensionConfig` expected by the installer. It isolates the tests from the extension's concrete config type.

**Data flow**: Accepts a borrowed `TestConfig`, reads its `include_instructions` and `bundled_skills_enabled` fields, and returns a new `SkillsExtensionConfig` with those same values. It performs a direct field copy with no side effects.

**Call relations**: This function is passed to `install` and `install_with_providers` as the configuration adapter used during registry setup. The installed extension later invokes it when contributors receive `ThreadStartInput` containing the test config.


##### `test_codex_home`  (lines 584–590)

```
fn test_codex_home() -> PathBuf
```

**Purpose**: Generates a unique temporary directory path for tests that need an isolated Codex home on disk. The uniqueness combines process id and a monotonically increasing atomic counter.

**Data flow**: Reads and increments `NEXT_CODEX_HOME_ID` with relaxed ordering, obtains the system temp directory via `std::env::temp_dir()`, formats a directory name `codex-skills-extension-test-<pid>-<id>`, joins it onto the temp dir, and returns the resulting `PathBuf`. It does not create the directory itself.

**Call relations**: Only `installed_extension_uses_host_loaded_skills` calls this helper, using the returned path as the root under which it writes a real `skills/demo/SKILL.md` file before exercising host-loaded skill prompt generation.

*Call graph*: called by 1 (installed_extension_uses_host_loaded_skills); 2 external calls (format!, temp_dir).


##### `read_request_keys`  (lines 592–607)

```
fn read_request_keys(
    requests: &Arc<Mutex<Vec<SkillReadRequest>>>,
) -> Vec<(SkillAuthority, SkillPackageId, SkillResourceId)>
```

**Purpose**: Normalizes recorded `SkillReadRequest`s into just the identifying tuple needed by assertions: authority, package, and resource. This strips unrelated request details and makes comparisons concise.

**Data flow**: Accepts an `Arc<Mutex<Vec<SkillReadRequest>>>`, locks the vector while recovering from poisoning with `PoisonError::into_inner`, iterates over the stored requests, clones each request's `authority`, `package`, and `resource`, collects those triples into a `Vec<(SkillAuthority, SkillPackageId, SkillResourceId)>`, and returns it.

**Call relations**: Several tests call this helper after invoking turn-input contribution to verify which skill the extension actually read. It translates the side effects produced by `StaticSkillProvider::read` into stable assertion data for executor, root-qualified, and hidden-skill scenarios.


### Extension API and built-in extensions
This group validates the generic extension framework first, then exercises concrete extensions and their end-to-end runtime behavior.

### `ext/extension-api/tests/capabilities.rs`

`test` · `test`

This test file covers two small but important extension capability contracts. The first test constructs a concrete `Vec<ResponseInputItem>` containing a single user `Message` with one `ContentItem::InputText`, then calls `NoopResponseItemInjector.inject_response_items(...)`. The expected behavior is not silent success but `Err(items)`, and the assertion checks that the returned vector is byte-for-byte equivalent to the original clone. That confirms the fallback injector preserves ownership and content when same-turn injection is unsupported.

The second test validates the blanket/closure-based `AgentSpawner` behavior exposed elsewhere in the crate. It builds an `Arc<Mutex<Vec<(ThreadId, String)>>>` to record invocations, defines a closure that accepts a `ThreadId` and request `String`, pushes those arguments into the shared log, and returns a boxed async future resolving to `Ok(request.len())`. The test then parses a concrete UUID-like `ThreadId`, invokes `spawn_subagent`, awaits the result, and asserts both the returned length and the recorded call tuple. Together these tests pin down two API ergonomics: capability fallbacks must not lose caller data, and closure adapters must preserve both input forwarding and async result propagation.

#### Function details

##### `noop_response_item_injector_returns_original_items`  (lines 14–29)

```
async fn noop_response_item_injector_returns_original_items()
```

**Purpose**: Verifies that `NoopResponseItemInjector` rejects same-turn injection by returning the original `ResponseInputItem` vector in the error branch. The test ensures unsupported injection is lossless.

**Data flow**: It builds a `Vec<ResponseInputItem>` containing one user message with one input-text content item, clones that vector, passes the clone into `NoopResponseItemInjector.inject_response_items(...).await`, unwraps the expected error with `expect_err`, and compares the returned vector to the original with `assert_eq!`. The only state it mutates is local test data.

**Call relations**: This async test directly exercises the no-op injector implementation from the capability module. It does not delegate to helper functions beyond standard assertions and vector construction.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `closure_agent_spawner_forwards_arguments_and_result`  (lines 32–56)

```
async fn closure_agent_spawner_forwards_arguments_and_result()
```

**Purpose**: Verifies that a closure used as an `AgentSpawner` receives the exact `ThreadId` and request string passed by the caller and that its async result is returned unchanged. It tests both argument forwarding and result propagation through the trait adapter.

**Data flow**: It creates a shared `Arc<Mutex<Vec<(ThreadId, String)>>>` call log, clones the `Arc` into a closure, defines that closure to record `(thread_id, request.clone())` and return `Ok(request.len())` in a boxed future, parses a concrete `ThreadId` from string, calls `spawn_subagent(thread_id, "delegate this".to_string()).await`, and asserts the returned `Ok(13)` plus the single recorded call tuple. It mutates only the local mutex-protected log.

**Call relations**: This test drives the closure-based `AgentSpawner` implementation path by invoking `spawn_subagent` on the closure itself. It relies on `ThreadId::from_string` for setup and then checks that the adapter layer does not alter inputs or outputs.

*Call graph*: calls 1 internal fn (from_string); 5 external calls (clone, new, new, new, assert_eq!).


### `ext/extension-api/tests/state.rs`

`test` · `test execution`

This test file is the behavioral specification for `codex_extension_api::ExtensionData`, treating it as a heterogeneous typed store keyed by Rust type and scoped to a logical level ID. The first test proves that inserting a `u64` and a `String` creates independent typed entries, that reinserting the same type returns the previous value, and that removing one type does not disturb another. The concurrency test wraps a single `ExtensionData` in `Arc` and spawns eight threads that all call `get_or_init` for the same `SharedValue` type; atomics force overlap so the test can assert that initialization runs exactly once and every caller receives the same `Arc` allocation, not merely equal contents. Another test creates two separate stores with the same `level_id` string and shows they do not share typed contents, confirming that identity is per-store instance rather than per-level ID. The final test uses `catch_unwind` with `AssertUnwindSafe` to confirm that a panic inside `get_or_init` does not poison the store permanently: a later initializer for the same type succeeds. Together these tests document important invariants around type-based lookup, thread safety, panic resilience, and store-local state isolation.

#### Function details

##### `typed_values_can_be_inserted_replaced_and_removed`  (lines 10–30)

```
fn typed_values_can_be_inserted_replaced_and_removed()
```

**Purpose**: Verifies basic typed-store CRUD behavior on a single `ExtensionData` instance. It checks insertion of distinct types, replacement of an existing typed value, and removal without affecting other stored types.

**Data flow**: Creates `ExtensionData::new("thread-1")`, inserts a `u64` and `String`, reads them back with `get::<u64>` and `get::<String>`, reinserts a new `u64` to observe the old value returned, removes the `String`, and asserts the final visible state. It reads only the store under test and writes typed entries into that store.

**Call relations**: This is a standalone `#[test]` entry invoked by the Rust test harness. It directly exercises `ExtensionData::new` and then validates observable behavior through assertions rather than delegating to helper functions.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `get_or_init_initializes_once_and_returns_shared_value`  (lines 33–76)

```
fn get_or_init_initializes_once_and_returns_shared_value()
```

**Purpose**: Proves that `ExtensionData::get_or_init` is safe under contention and publishes one shared initialized value. The test specifically checks both single execution of the initializer and pointer identity of the returned `Arc`s.

**Data flow**: Builds an `Arc<ExtensionData>`, plus `Arc<AtomicUsize>` counters for started callers and initialization count. It spawns `CALLER_COUNT` threads; each increments `callers_started`, calls `get_or_init` with a closure that increments `initialization_count`, spins until all workers have entered, and returns `SharedValue(7)`. After joining all threads, it collects the returned values, asserts the initializer ran once, asserts all dereferenced values equal `SharedValue(7)`, and asserts all returned `Arc`s are pointer-equal to the first.

**Call relations**: This test is run by the test harness and uses `std::array::from_fn` plus `std::thread::spawn` to create overlapping callers. Its whole purpose is to stress the synchronization inside `ExtensionData::get_or_init`; it does not call project-local helpers.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, new, assert!, assert_eq!, from_fn).


##### `stores_are_isolated_and_preserve_level_id`  (lines 79–97)

```
fn stores_are_isolated_and_preserve_level_id()
```

**Purpose**: Checks that two separate `ExtensionData` stores with the same level ID remain independent while still reporting that shared ID. It documents that `level_id` is metadata, not a global namespace key.

**Data flow**: Constructs `session_data` and `thread_data` with the same string ID, inserts a `u32` into one and a `String` into the other, then reads `level_id()` and typed values from both stores. The assertions confirm each store retains only its own inserted type and both expose the original level ID string.

**Call relations**: This is another direct test-harness entry. It invokes `ExtensionData::new` and then inspects the resulting stores through public methods to demonstrate isolation semantics.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `store_remains_usable_after_panicking_initializer`  (lines 100–109)

```
fn store_remains_usable_after_panicking_initializer()
```

**Purpose**: Ensures a failed `get_or_init` initializer does not leave the store unusable for that type. It captures the panic and then retries initialization successfully.

**Data flow**: Creates `ExtensionData::new("turn-1")`, wraps a `get_or_init::<u64>` call whose closure panics inside `catch_unwind(AssertUnwindSafe(...))`, asserts the unwind result is an error, then calls `get_or_init` again with a closure returning `99_u64` and asserts the returned shared value dereferences to `99`. The store is mutated only through those initialization attempts.

**Call relations**: The test harness invokes this function. It uses standard panic-catching utilities to probe failure behavior around `ExtensionData::get_or_init`, documenting that panic during initialization does not permanently poison the typed slot.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert!, assert_eq!, AssertUnwindSafe, catch_unwind).


### `ext/extension-api/tests/registry.rs`

`test` · `test`

This test file validates the registry and contributor contracts end to end. It defines several local test doubles: `AllContributors`, a single type implementing nearly every contributor trait with empty/default behavior; `NamedContextContributor`, which emits one `PromptFragment::developer_policy`; `RecordingTurnItemContributor`, which appends its name into a shared call log when invoked; `RecordingApprovalContributor`, which records session/thread IDs and prompt text before returning a configured `Option<ReviewDecision>`; and `RecordingEventSink`, which accepts only warning events and stores `(id, message)` pairs.

The tests cover distinct invariants. `build_round_trips_every_contributor_category` registers one `AllContributors` instance into every builder slot and confirms each registry accessor exposes exactly one contributor, then checks that approval review returns the contributor’s decision. `contributors_preserve_registration_order` proves prompt and turn-item contributors are iterated in insertion order by collecting fragments and call names. `approval_review_returns_first_claim_and_short_circuits` verifies the registry stops after the first contributor returning `Some`, while still recording earlier `None` attempts. `custom_event_sink_survives_registry_build` confirms a sink supplied to the builder remains the same shared sink after `build`. `empty_registry_does_not_claim_approval_review` checks the convenience empty registry returns `None`. The helper `warning_event` constructs the exact warning `Event` shape expected by the recording sink.

#### Function details

##### `AllContributors::tools`  (lines 71–77)

```
fn tools(
        &self,
        _session_store: &ExtensionData,
        _thread_store: &ExtensionData,
    ) -> Vec<Arc<dyn ToolExecutor<ToolCall>>>
```

**Purpose**: Implements the `ToolContributor` test double by returning no tools. It allows one object to satisfy the tool-contributor category during registry round-trip tests.

**Data flow**: It takes `&self` plus session and thread `ExtensionData` references, ignores both stores, constructs and returns an empty `Vec<Arc<dyn ToolExecutor<ToolCall>>>`. No state is read beyond the arguments and no state is mutated.

**Call relations**: The registry round-trip test registers `AllContributors` as a tool contributor and later checks that the registry stores one contributor in that category. This method itself is not the focus of the assertions; it simply fulfills the trait contract.

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

**Purpose**: Implements the `ApprovalReviewContributor` test double by always claiming the prompt with `ReviewDecision::ApprovedForSession`. It gives the registry tests a deterministic positive approval path.

**Data flow**: It takes `&self`, session and thread `ExtensionData` references, and a prompt `&str`, ignores the inputs inside an `async move` block, and returns a boxed future resolving to `Some(ReviewDecision::ApprovedForSession)`. It mutates no state.

**Call relations**: The `build_round_trips_every_contributor_category` test relies on this implementation when calling `registry.approval_review(...)`. The registry dispatch loop awaits this future and returns its decision immediately.

*Call graph*: 3 external calls (pin, new, ready).


##### `build_round_trips_every_contributor_category`  (lines 111–145)

```
async fn build_round_trips_every_contributor_category()
```

**Purpose**: Verifies that every contributor category registered on the builder appears in the built registry and that approval-review dispatch reaches the registered contributor. It is the broad smoke test for builder-to-registry transfer.

**Data flow**: It creates one `Arc<AllContributors>`, constructs a new `ExtensionRegistryBuilder<()>`, registers cloned contributor arcs into each builder category, builds the registry, then asserts each accessor slice has length 1. It also creates fresh session and thread `ExtensionData` stores, calls `approval_review(...).await`, and asserts the returned decision is `Some(ReviewDecision::ApprovedForSession)`.

**Call relations**: This test drives nearly every builder registration method plus the registry accessors and approval-review dispatcher. It uses `AllContributors` so one object can populate all categories consistently.

*Call graph*: 3 external calls (new, new, assert_eq!).


##### `NamedContextContributor::contribute`  (lines 150–158)

```
fn contribute(
        &'a self,
        _session_store: &'a ExtensionData,
        _thread_store: &'a ExtensionData,
    ) -> ExtensionFuture<'a, Vec<PromptFragment>>
```

**Purpose**: Implements a prompt contributor that emits exactly one developer-policy fragment containing its stored name. It is used to test prompt contributor ordering.

**Data flow**: It takes `&self`, ignores the session and thread stores, constructs `vec![PromptFragment::developer_policy(self.0)]`, wraps it in `std::future::ready`, boxes the future, and returns it. No shared state is mutated.

**Call relations**: The registration-order test installs two instances with different names and later iterates `registry.context_contributors()` to collect their fragments. This method supplies the observable ordered output for that assertion.

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

**Purpose**: Implements a turn-item contributor that records its own name into a shared call log and succeeds. It is used to prove turn-item contributors run in registration order.

**Data flow**: It takes `&self`, ignores the thread store, turn store, and mutable `TurnItem`, locks `self.calls`, pushes `self.name` into the shared `Vec<&'static str>`, and returns `Ok(())` from a boxed async future. It mutates only the shared test log.

**Call relations**: The registration-order test registers two instances and then manually iterates `registry.turn_item_contributors()`, awaiting each contribution. The resulting call log is the evidence that the registry preserved insertion order.

*Call graph*: 1 external calls (pin).


##### `contributors_preserve_registration_order`  (lines 184–229)

```
async fn contributors_preserve_registration_order()
```

**Purpose**: Verifies that prompt contributors and turn-item contributors are exposed and invoked in the same order they were registered. It tests the registry’s ordering invariant directly.

**Data flow**: It creates a shared `Arc<Mutex<Vec<&'static str>>>` for turn-item call recording, builds a registry with two `NamedContextContributor`s and two `RecordingTurnItemContributor`s in known order, creates session/thread/turn `ExtensionData` stores, iterates `registry.context_contributors()` to collect prompt fragments, constructs a `TurnItem::HookPrompt` value, iterates `registry.turn_item_contributors()` to apply contributions, and finally asserts both the fragment vector and recorded call slice equal `["first", "second"]` in order.

**Call relations**: This test exercises the builder registration methods, the registry accessors for context and turn-item contributors, and the contributor implementations defined above. It demonstrates that the registry does not reorder contributors during build or access.

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

**Purpose**: Implements an approval-review contributor that records every invocation and then returns a preconfigured decision. It is the test double used to verify short-circuiting and argument propagation in approval review.

**Data flow**: It takes `&self`, `session_store`, `thread_store`, and `prompt`, locks `self.calls`, pushes an `ApprovalCall` containing `self.name`, `session_store.level_id().to_string()`, `thread_store.level_id().to_string()`, and `prompt.to_string()`, then returns `self.decision.clone()` from a boxed async future. It mutates the shared call log and clones the configured decision.

**Call relations**: The short-circuit approval-review test registers several instances with different decisions. `ExtensionRegistry::approval_review` awaits this method on each contributor until one returns `Some`, and the recorded calls show exactly which contributors were reached.

*Call graph*: calls 1 internal fn (level_id); 1 external calls (pin).


##### `approval_review_returns_first_claim_and_short_circuits`  (lines 268–310)

```
async fn approval_review_returns_first_claim_and_short_circuits()
```

**Purpose**: Verifies that approval-review dispatch visits contributors in order, returns the first non-`None` decision, and does not invoke later contributors after a claim. It tests both ordering and short-circuit behavior.

**Data flow**: It creates a shared `Arc<Mutex<Vec<ApprovalCall>>>`, builds a registry with three `RecordingApprovalContributor`s configured as `None`, `Some(Approved)`, and `Some(Denied)`, creates session and thread `ExtensionData` stores, calls `registry.approval_review(...).await`, and asserts the returned decision is `Some(ReviewDecision::Approved)`. It then asserts the call log contains only the first two contributors with the expected session ID, thread ID, and prompt text.

**Call relations**: This test directly exercises `ExtensionRegistry::approval_review` and relies on `RecordingApprovalContributor::contribute` to make invocation order visible. The absence of the third contributor in the log proves short-circuiting.

*Call graph*: calls 1 internal fn (new); 6 external calls (clone, new, new, new, new, assert_eq!).


##### `RecordingEventSink::emit`  (lines 318–326)

```
fn emit(&self, event: Event)
```

**Purpose**: Implements a test event sink that accepts only warning events and records their IDs and messages. It is used to verify that a custom sink survives the builder-to-registry transition.

**Data flow**: It takes `&self` and `event: Event`, pattern-matches `event.msg` as `EventMsg::Warning(warning)`, panics if the event is any other variant, otherwise locks `self.events` and pushes `(event.id, warning.message)` into the stored vector. It mutates the sink’s internal log.

**Call relations**: The custom event-sink test emits warning events through both the builder’s and registry’s cloned sink handles. This method is the observable endpoint that records those emissions for later assertion.

*Call graph*: 1 external calls (panic!).


##### `custom_event_sink_survives_registry_build`  (lines 330–352)

```
fn custom_event_sink_survives_registry_build()
```

**Purpose**: Verifies that a host-provided event sink installed on the builder remains the same shared sink after `build`. It ensures event emission wiring is preserved across registry construction.

**Data flow**: It creates `Arc<RecordingEventSink>::default()`, constructs a builder with `ExtensionRegistryBuilder::with_event_sink(sink.clone())`, emits one warning event through `builder.event_sink()`, builds the registry, emits another warning event through `registry.event_sink()`, and asserts the underlying sink log contains both `(id, message)` pairs in order. It mutates only the recording sink’s internal vector.

**Call relations**: This test exercises `with_event_sink`, `event_sink` on both builder and registry, `build`, and the `warning_event` helper. The shared `Arc` and recorded events prove the same sink instance is retained throughout.

*Call graph*: calls 1 internal fn (warning_event); 4 external calls (new, with_event_sink, assert_eq!, default).


##### `empty_registry_does_not_claim_approval_review`  (lines 355–368)

```
async fn empty_registry_does_not_claim_approval_review()
```

**Purpose**: Verifies that the convenience empty registry has no approval-review contributors and therefore returns `None` for any prompt. It checks the zero-extension baseline behavior.

**Data flow**: It creates `empty_extension_registry::<()>()`, constructs fresh session and thread `ExtensionData` stores, calls `approval_review(...).await` with prompt `"unclaimed"`, and asserts the result is `None`. No shared state is mutated beyond local test setup.

**Call relations**: This test directly exercises the `empty_extension_registry` helper and the registry’s approval-review dispatcher in the absence of contributors. It confirms the dispatcher falls through to `None` when the contributor list is empty.

*Call graph*: 1 external calls (assert_eq!).


##### `warning_event`  (lines 370–377)

```
fn warning_event(id: &str, message: &str) -> Event
```

**Purpose**: Builds a warning `Event` with the supplied ID and message for use in event-sink tests. It centralizes the exact event shape expected by `RecordingEventSink`.

**Data flow**: It takes `id: &str` and `message: &str`, allocates owned `String` values for both, wraps the message in `WarningEvent`, wraps that in `EventMsg::Warning`, and returns the resulting `Event`. It has no side effects.

**Call relations**: The custom event-sink test calls this helper to create the two warning events emitted through the builder and registry sinks. `RecordingEventSink::emit` then pattern-matches the returned event structure.

*Call graph*: called by 1 (custom_event_sink_survives_registry_build); 1 external calls (Warning).


### `ext/goal/tests/goal_extension_backend.rs`

`test` · `test execution / integration scenarios`

This file builds a realistic test harness around the installed goal extension and then drives it through thread start/resume/stop, turn start/stop/error, token-usage notifications, tool calls, and direct service/runtime-handle operations. The tests cover tool exposure rules (hidden for ephemeral threads and review subagents), create/update semantics, preview seeding, exact accounting across tool finishes and turn stop, concurrency protection against double-accounting on parallel tool finishes, budget-limited and usage-limited transitions, stale-turn and plan-turn edge cases, external goal mutation preparation, runtime unregistration on thread stop, idle-time accounting after thread resume, and direct `GoalService` set/get/clear behavior. `GoalExtensionHarness` encapsulates registry construction with a `RecordingEventSink`, session/thread stores, and helper methods that replay extension lifecycle callbacks exactly as the host would. Utility functions create deterministic `ToolCall`, `TokenUsage`, runtime, thread id, and seeded thread metadata fixtures. `RecordingEventSink` captures emitted protocol `Event`s and filters them into compact `CapturedGoalEvent` records for assertions. The suite is valuable because it documents not just final state but event ordering and IDs, especially around progress accounting before terminal updates and around budget/usage limit transitions.

#### Function details

##### `installed_goal_tools_create_goal_and_fill_empty_preview`  (lines 51–95)

```
async fn installed_goal_tools_create_goal_and_fill_empty_preview() -> anyhow::Result<()>
```

**Purpose**: Tests that installed goal tools can create a goal and that creation backfills an empty thread preview from the objective. It also verifies the structured JSON response shape from `create_goal`.

**Data flow**: It creates a test runtime and thread id, seeds thread metadata, installs tools, selects `create_goal`, invokes it with objective and token budget JSON, inspects the code-mode JSON result, then reads thread metadata from runtime and asserts the preview was set.

**Call relations**: This integration test uses `installed_tools`, `tool_by_name`, `tool_call`, and fixture helpers to drive the real installed tool executor through the extension framework.

*Call graph*: calls 6 internal fn (installed_tools, seed_thread_metadata, test_runtime, test_thread_id, tool_by_name, tool_call); 2 external calls (assert_eq!, json!).


##### `goal_tools_hidden_for_ephemeral_threads`  (lines 98–111)

```
async fn goal_tools_hidden_for_ephemeral_threads() -> anyhow::Result<()>
```

**Purpose**: Tests that goal tools are not exposed when persistent thread state is unavailable. This protects ephemeral threads from offering persistence-dependent functionality.

**Data flow**: It creates a runtime and thread id, installs tools via `installed_tools_with_start` with `persistent_thread_state_available` set to false, collects tool names, and asserts the list is empty.

**Call relations**: It exercises the extension's thread-start gating path through the registry helper rather than calling goal code directly.

*Call graph*: calls 3 internal fn (installed_tools_with_start, test_runtime, test_thread_id); 1 external calls (assert_eq!).


##### `goal_tools_hidden_for_review_subagents`  (lines 114–127)

```
async fn goal_tools_hidden_for_review_subagents() -> anyhow::Result<()>
```

**Purpose**: Tests that review subagents do not receive goal tools. It verifies session-source-based tool suppression.

**Data flow**: It creates runtime and thread id fixtures, installs tools with a `SessionSource::SubAgent(SubAgentSource::Review)`, gathers tool names, and asserts no tools are present.

**Call relations**: Like the ephemeral-thread test, it drives installation through `installed_tools_with_start` to validate extension-level visibility rules.

*Call graph*: calls 3 internal fn (installed_tools_with_start, test_runtime, test_thread_id); 2 external calls (SubAgent, assert_eq!).


##### `installed_goal_tools_only_replace_complete_goal`  (lines 130–184)

```
async fn installed_goal_tools_only_replace_complete_goal() -> anyhow::Result<()>
```

**Purpose**: Tests that `create_goal` refuses to replace an unfinished goal but allows replacement after the existing goal is completed. It verifies both the error message and the successful replacement path.

**Data flow**: It creates a harness, invokes `create_goal` once successfully, invokes it again and captures the expected `RespondToModel` error, then invokes `update_goal` with `complete`, creates a replacement goal, and asserts the new goal's objective, status, and token usage in the response.

**Call relations**: This test uses the full harness and real tool executors to validate create/update interplay and persistence rules.

*Call graph*: calls 6 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, panic!).


##### `create_goal_resets_baseline_before_turn_stop_accounting`  (lines 187–243)

```
async fn create_goal_resets_baseline_before_turn_stop_accounting() -> anyhow::Result<()>
```

**Purpose**: Tests that creating a goal mid-turn resets accounting so only post-creation usage is charged to the new goal. It guards against attributing earlier turn usage to a goal that did not yet exist.

**Data flow**: It starts a turn with a baseline usage, records some usage before goal creation, creates the goal, records more usage, stops the turn, then reads the persisted goal and asserts only the post-create delta was counted and status remains active.

**Call relations**: It uses `GoalExtensionHarness` lifecycle helpers plus the real `create_goal` tool to verify accounting baseline reset behavior across turn stop.

*Call graph*: calls 7 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, token_usage, tool_by_name, tool_call); 2 external calls (assert_eq!, json!).


##### `tool_finish_accounts_active_goal_progress_and_emits_event`  (lines 246–294)

```
async fn tool_finish_accounts_active_goal_progress_and_emits_event() -> anyhow::Result<()>
```

**Purpose**: Tests that a tool-finish notification flushes active-goal progress into persistent state and emits a corresponding goal-updated event. It verifies both state mutation and event payload.

**Data flow**: It starts a turn, creates a goal, clears captured events, records token usage, notifies tool finish for a shell call, then reads the goal from runtime and compares captured goal events against the expected single event.

**Call relations**: It drives the extension through `notify_tool_finish`, exercising the runtime path that eventually calls goal progress accounting and event emission.

*Call graph*: calls 7 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, token_usage, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, default).


##### `parallel_tool_finish_accounts_active_goal_progress_once`  (lines 297–357)

```
async fn parallel_tool_finish_accounts_active_goal_progress_once() -> anyhow::Result<()>
```

**Purpose**: Tests that concurrent tool-finish notifications do not double-account the same progress snapshot. It validates the accounting permit / idempotence behavior under parallelism.

**Data flow**: It starts a turn, creates a goal, clears events, records token usage, triggers two `notify_tool_finish` calls concurrently with `tokio::join!`, then asserts the persisted goal accrued tokens only once and only one goal event was emitted.

**Call relations**: This test specifically targets the concurrency guard in the runtime accounting path by invoking the same lifecycle callback in parallel.

*Call graph*: calls 7 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, token_usage, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, join!).


##### `budget_limited_goal_keeps_accruing_until_turn_stop`  (lines 360–433)

```
async fn budget_limited_goal_keeps_accruing_until_turn_stop() -> anyhow::Result<()>
```

**Purpose**: Tests that once a budgeted goal becomes budget-limited at tool finish, later usage in the same turn still accrues until turn stop. It also verifies the sequence of emitted events.

**Data flow**: It starts a turn, creates a goal with a token budget, clears events, records usage that reaches the budget, notifies tool finish, records additional usage, stops the turn, then asserts final tokens used, persisted budget-limited status, and the two captured events with their event ids and token counts.

**Call relations**: It exercises both tool-finish and turn-stop lifecycle paths to confirm budget-limited goals continue accounting within the current turn.

*Call graph*: calls 7 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, token_usage, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, default).


##### `budget_limited_goal_keeps_accounting_after_later_tool_finish`  (lines 436–491)

```
async fn budget_limited_goal_keeps_accounting_after_later_tool_finish() -> anyhow::Result<()>
```

**Purpose**: Tests that a goal already marked budget-limited still accrues later progress when another tool finishes in the same turn. It covers continued accounting after the first budget-limit transition.

**Data flow**: It starts a turn, creates a budgeted goal, records usage to hit the budget, notifies one tool finish, records more usage, notifies a second tool finish, then reads the goal and asserts final tokens used and budget-limited status.

**Call relations**: It uses repeated `notify_tool_finish` calls to validate that budget-limited status does not freeze accounting prematurely.

*Call graph*: calls 7 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, token_usage, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, default).


##### `turn_error_usage_limit_accounts_progress_and_clears_accounting`  (lines 494–573)

```
async fn turn_error_usage_limit_accounts_progress_and_clears_accounting() -> anyhow::Result<()>
```

**Purpose**: Tests that a usage-limit turn error first accounts outstanding progress, then marks the goal usage-limited, and finally prevents later usage in that turn from being counted. It verifies both state and emitted events before and after the limit.

**Data flow**: It starts a turn, creates a goal, clears events, records usage, notifies a usage-limit turn error, asserts persisted tokens and status plus two captured events, then records more usage, notifies a later tool finish and turn stop, and asserts the goal did not accrue additional tokens.

**Call relations**: It drives the turn-error lifecycle path and then subsequent callbacks to confirm accounting is cleared after usage-limit handling.

*Call graph*: calls 7 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, token_usage, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, default).


##### `turn_error_blocks_goal`  (lines 576–603)

```
async fn turn_error_blocks_goal() -> anyhow::Result<()>
```

**Purpose**: Tests that a non-usage-limit turn error blocks the active goal. It covers the generic error-to-blocked transition.

**Data flow**: It starts a turn, creates a goal, notifies a turn error with `CodexErrorInfo::Other`, then reads the goal from runtime and asserts the persisted status is blocked.

**Call relations**: It exercises the turn-error branch distinct from usage-limit handling, using the harness to invoke the real lifecycle contributor.

*Call graph*: calls 6 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, default).


##### `usage_limit_budget_limited_goal_accounts_remaining_progress`  (lines 606–682)

```
async fn usage_limit_budget_limited_goal_accounts_remaining_progress() -> anyhow::Result<()>
```

**Purpose**: Tests that when a budget-limited goal later hits a usage limit, remaining unflushed progress is still accounted before the status changes to usage-limited. It verifies the intermediate event reflects budget-limited status and the final event reflects usage-limited status.

**Data flow**: It starts a turn, creates a budgeted goal, records usage to hit the budget, notifies tool finish, clears events, records more usage, invokes `usage_limit_active_goal_for_turn` through the runtime handle, then asserts final tokens, final persisted status, and the two captured events.

**Call relations**: It combines tool-finish accounting with a direct runtime-handle usage-limit transition to validate cross-path consistency.

*Call graph*: calls 7 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, token_usage, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, default).


##### `usage_limit_plan_turn_does_not_stop_goal`  (lines 685–719)

```
async fn usage_limit_plan_turn_does_not_stop_goal() -> anyhow::Result<()>
```

**Purpose**: Tests that applying a usage limit during a plan-mode turn does not stop an active goal. It preserves the invariant that plan turns are excluded from goal accounting and stop logic.

**Data flow**: It creates a goal, starts a plan-mode turn, clears events, invokes `usage_limit_active_goal_for_turn` for that turn, then reads the goal and asserts status remains active and no events were emitted.

**Call relations**: It uses `start_turn_with_mode` plus the runtime handle to target the plan-turn special case in the runtime logic.

*Call graph*: calls 6 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, default).


##### `usage_limit_stale_turn_does_not_stop_current_goal`  (lines 722–756)

```
async fn usage_limit_stale_turn_does_not_stop_current_goal() -> anyhow::Result<()>
```

**Purpose**: Tests that a usage-limit signal for an old turn does not affect the currently active goal state. It guards against stale-turn races.

**Data flow**: It starts turn 1, creates a goal, stops turn 1, starts turn 2, clears events, invokes `usage_limit_active_goal_for_turn` for stale turn 1, then asserts the goal remains active and no events were emitted.

**Call relations**: It exercises stale-turn protection through the runtime handle after advancing the harness to a newer turn.

*Call graph*: calls 6 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, default).


##### `update_goal_can_block_and_accounts_final_progress`  (lines 759–838)

```
async fn update_goal_can_block_and_accounts_final_progress() -> anyhow::Result<()>
```

**Purpose**: Tests that `update_goal` with `blocked` first accounts final in-turn progress and then persists the blocked status. It also verifies the response payload and the pair of emitted events.

**Data flow**: It starts a turn, creates a goal, clears events, records token usage, invokes `update_goal` with blocked status, inspects the JSON result, reads the persisted goal, and asserts both state and the expected active-then-blocked event sequence.

**Call relations**: It drives the real update tool through the harness, specifically validating the pre-update accounting path in the executor.

*Call graph*: calls 7 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, token_usage, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, default).


##### `external_goal_mutation_start_accounts_active_goal_progress`  (lines 841–890)

```
async fn external_goal_mutation_start_accounts_active_goal_progress() -> anyhow::Result<()>
```

**Purpose**: Tests that preparing for an external goal mutation flushes active-goal progress before the mutation occurs. It ensures service-side mutations do not lose in-flight accounting.

**Data flow**: It starts a turn, creates a goal, clears events, records token usage, invokes `prepare_external_goal_mutation` through the runtime handle, then reads the goal and asserts tokens used and the single emitted event.

**Call relations**: It targets the runtime-handle path used before external service mutations, rather than tool-driven updates.

*Call graph*: calls 7 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, token_usage, tool_by_name, tool_call); 3 external calls (assert_eq!, json!, default).


##### `goal_service_external_set_active_resets_baseline_without_live_thread`  (lines 893–966)

```
async fn goal_service_external_set_active_resets_baseline_without_live_thread() -> anyhow::Result<()>
```

**Purpose**: Tests that an external active-goal replacement resets accounting baseline even when the mutation is applied outside a live tool call. It prevents pre-mutation usage from leaking into the new objective's accounting.

**Data flow**: It starts a turn, creates an old goal, clears events, records usage, calls `GoalService::set_thread_goal` with a new objective and applies runtime effects, records more usage, notifies tool finish, then reads the goal and asserts only post-mutation usage was counted.

**Call relations**: It combines direct `GoalService` mutation with later lifecycle callbacks to validate baseline reset behavior across service/runtime boundaries.

*Call graph*: calls 7 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, token_usage, tool_by_name, tool_call); 3 external calls (assert_eq!, Set, json!).


##### `thread_stop_unregisters_goal_runtime_from_service`  (lines 969–1006)

```
async fn thread_stop_unregisters_goal_runtime_from_service() -> anyhow::Result<()>
```

**Purpose**: Tests that stopping a thread unregisters its goal runtime from the service so later service operations no longer trigger runtime-side effects. It also confirms no stray events are emitted during cleanup.

**Data flow**: It starts a turn, creates a goal, clears events, records token usage, stops the thread through the harness, then calls `goal_service.clear_thread_goal` directly and asserts it succeeds while the event sink remains empty.

**Call relations**: It exercises thread-stop lifecycle teardown and then probes service behavior afterward to confirm runtime deregistration.

*Call graph*: calls 7 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id, token_usage, tool_by_name, tool_call); 4 external calls (assert!, assert_eq!, json!, default).


##### `thread_resume_rehydrates_active_goal_idle_accounting`  (lines 1009–1052)

```
async fn thread_resume_rehydrates_active_goal_idle_accounting() -> anyhow::Result<()>
```

**Purpose**: Tests that resuming a thread with an already active persisted goal rehydrates runtime state and accrues idle wall-clock time before the next mutation. It verifies resumed idle accounting and event emission without an active turn.

**Data flow**: It seeds a persisted active goal directly in runtime, creates a harness, resumes the thread, sleeps just over one second, invokes `prepare_external_goal_mutation` through the runtime handle, then reads the goal and asserts status remains active, `time_used_seconds` increased, and the emitted event has no turn id.

**Call relations**: It targets the thread-resume lifecycle path and the runtime's idle-accounting behavior for rehydrated goals.

*Call graph*: calls 4 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id); 4 external calls (from_millis, assert!, assert_eq!, sleep).


##### `goal_service_sets_gets_and_clears_thread_goal`  (lines 1055–1094)

```
async fn goal_service_sets_gets_and_clears_thread_goal() -> anyhow::Result<()>
```

**Purpose**: Tests the direct `GoalService` API for setting, retrieving, and clearing thread goals, including objective trimming, default active status, budget persistence, and preview filling. It validates service behavior independently of tool calls.

**Data flow**: It creates runtime and thread fixtures, constructs a fresh `GoalService`, calls `set_thread_goal` with a padded objective and explicit budget, fetches the goal back through `get_thread_goal`, reads thread metadata, asserts normalized fields and preview, then clears the goal twice and asserts the first clear succeeds, the second returns false, and subsequent get returns `None`.

**Call relations**: This test bypasses the extension registry and tool executors to validate the service API directly.

*Call graph*: calls 4 internal fn (new, seed_thread_metadata, test_runtime, test_thread_id); 4 external calls (assert!, assert_eq!, Set, Set).


##### `installed_tools`  (lines 1096–1107)

```
async fn installed_tools(
    runtime: Arc<codex_state::StateRuntime>,
    thread_id: ThreadId,
) -> Vec<Arc<dyn ToolExecutor<ToolCall>>>
```

**Purpose**: Convenience helper that installs tools for a normal persistent CLI thread. It reduces repetition in tests that do not care about alternate start conditions.

**Data flow**: It takes a runtime and thread id, forwards them to `installed_tools_with_start` with `SessionSource::Cli` and persistent state enabled, awaits the result, and returns the tool list.

**Call relations**: It is used by the basic tool-installation test as a thin wrapper over the more configurable helper.

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

**Purpose**: Builds an extension registry, runs thread-start contributors with supplied session conditions, and returns the installed tool executors. It is the low-level fixture for tool-visibility tests.

**Data flow**: It creates an `ExtensionRegistryBuilder`, a `GoalService`, installs the goal extension backend, builds the registry, creates session and thread `ExtensionData` stores, invokes every thread lifecycle contributor's `on_thread_start` with the provided session source and persistence flag, then collects all tools from every tool contributor into a `Vec<Arc<dyn ToolExecutor<ToolCall>>>`.

**Call relations**: It is called by `installed_tools` and by tests that vary thread-start conditions. It drives the same contributor interfaces the host runtime would use.

*Call graph*: calls 3 internal fn (disabled, new, new); called by 3 (goal_tools_hidden_for_ephemeral_threads, goal_tools_hidden_for_review_subagents, installed_tools); 5 external calls (new, new, new, install_with_backend, to_string).


##### `tool_names`  (lines 1149–1151)

```
fn tool_names(tools: &[Arc<dyn ToolExecutor<ToolCall>>]) -> Vec<String>
```

**Purpose**: Extracts plain tool names from a list of tool executors for assertions. It is a small test-only projection helper.

**Data flow**: It takes a slice of tool executors, maps each executor through `tool_name().name`, collects the names into a `Vec<String>`, and returns it.

**Call relations**: It is used by visibility tests after `installed_tools_with_start` returns a tool list.


##### `GoalExtensionHarness::new`  (lines 1162–1201)

```
async fn new(
        runtime: Arc<codex_state::StateRuntime>,
        thread_id: ThreadId,
    ) -> anyhow::Result<Self>
```

**Purpose**: Constructs a fully initialized integration-test harness with registry, stores, goal service, and recording event sink. It simulates host installation and thread start for a persistent CLI thread.

**Data flow**: It creates a `RecordingEventSink`, builds an `ExtensionRegistryBuilder` with that sink, creates a `GoalService`, installs the goal extension backend, builds the registry, creates session and thread stores, runs all thread-start contributors with persistent CLI inputs, and returns a `GoalExtensionHarness` containing the assembled components.

**Call relations**: Most integration tests call this first to obtain a reusable environment. It centralizes extension installation and startup sequencing.

*Call graph*: calls 3 internal fn (disabled, new, new); called by 16 (budget_limited_goal_keeps_accounting_after_later_tool_finish, budget_limited_goal_keeps_accruing_until_turn_stop, create_goal_resets_baseline_before_turn_stop_accounting, external_goal_mutation_start_accounts_active_goal_progress, goal_service_external_set_active_resets_baseline_without_live_thread, installed_goal_tools_only_replace_complete_goal, parallel_tool_finish_accounts_active_goal_progress_once, thread_resume_rehydrates_active_goal_idle_accounting, thread_stop_unregisters_goal_runtime_from_service, tool_finish_accounts_active_goal_progress_and_emits_event (+6 more)); 7 external calls (clone, new, with_event_sink, new, install_with_backend, default, to_string).


##### `GoalExtensionHarness::tools`  (lines 1203–1209)

```
fn tools(&self) -> Vec<Arc<dyn ToolExecutor<ToolCall>>>
```

**Purpose**: Returns the currently available tool executors from the harness registry. It mirrors how the host asks tool contributors for thread-scoped tools.

**Data flow**: It reads the registry's tool contributors, asks each for tools using the harness session and thread stores, flattens the results, and returns the collected vector.

**Call relations**: Tests call this after harness creation to obtain real tool executors for invocation.

*Call graph*: calls 1 internal fn (tool_contributors).


##### `GoalExtensionHarness::start_turn`  (lines 1211–1214)

```
async fn start_turn(&self, turn_id: &str, usage: &TokenUsage)
```

**Purpose**: Starts a default-mode turn in the harness. It is a convenience wrapper over the mode-aware turn-start helper.

**Data flow**: It takes a turn id and `TokenUsage`, forwards them to `start_turn_with_mode` with `ModeKind::Default`, awaits completion, and returns no value.

**Call relations**: Many tests use it to begin a normal turn before recording usage or invoking tools.

*Call graph*: calls 1 internal fn (start_turn_with_mode).


##### `GoalExtensionHarness::start_turn_with_mode`  (lines 1216–1232)

```
async fn start_turn_with_mode(&self, turn_id: &str, mode: ModeKind, usage: &TokenUsage)
```

**Purpose**: Invokes all turn-start contributors for a turn with a specified collaboration mode and baseline token usage. It simulates the host beginning a turn.

**Data flow**: It creates a turn-scoped `ExtensionData`, builds a default `CollaborationMode`, overwrites its `mode`, then iterates all turn lifecycle contributors and awaits each `on_turn_start` call with the turn id, collaboration mode, baseline usage, and stores.

**Call relations**: It is called directly by tests needing non-default modes and indirectly by `start_turn`.

*Call graph*: calls 3 internal fn (turn_lifecycle_contributors, new, default_collaboration_mode); called by 1 (start_turn).


##### `GoalExtensionHarness::stop_turn`  (lines 1234–1245)

```
async fn stop_turn(&self, turn_id: &str)
```

**Purpose**: Invokes all turn-stop contributors for a given turn. It simulates host turn teardown.

**Data flow**: It creates a turn-scoped `ExtensionData`, iterates the registry's turn lifecycle contributors, and awaits each `on_turn_stop` call with the session, thread, and turn stores.

**Call relations**: Tests call it to trigger end-of-turn accounting and cleanup paths.

*Call graph*: calls 2 internal fn (turn_lifecycle_contributors, new).


##### `GoalExtensionHarness::record_token_usage`  (lines 1247–1264)

```
async fn record_token_usage(&self, turn_id: &str, usage: &TokenUsage)
```

**Purpose**: Feeds token-usage notifications into all registered token-usage contributors. It simulates the host reporting cumulative usage during a turn.

**Data flow**: It creates a turn store, wraps the provided `TokenUsage` into a `TokenUsageInfo` with default `last_token_usage` and no context-window limit, then iterates token-usage contributors and awaits each `on_token_usage` callback.

**Call relations**: Tests use it between turn start and later lifecycle events to accumulate progress that goal accounting should flush.

*Call graph*: calls 2 internal fn (token_usage_contributors, new); 2 external calls (clone, default).


##### `GoalExtensionHarness::resume_thread`  (lines 1266–1275)

```
async fn resume_thread(&self)
```

**Purpose**: Invokes all thread-resume contributors for the harness thread. It simulates the host rehydrating a persisted thread.

**Data flow**: It iterates thread lifecycle contributors and awaits each `on_thread_resume` call with the harness session and thread stores.

**Call relations**: Used by the resume/idle-accounting test to trigger runtime rehydration.

*Call graph*: calls 1 internal fn (thread_lifecycle_contributors).


##### `GoalExtensionHarness::stop_thread`  (lines 1277–1286)

```
async fn stop_thread(&self)
```

**Purpose**: Invokes all thread-stop contributors for the harness thread. It simulates host thread shutdown.

**Data flow**: It iterates thread lifecycle contributors and awaits each `on_thread_stop` call with the harness session and thread stores.

**Call relations**: Used by the teardown/unregistration test to exercise runtime cleanup.

*Call graph*: calls 1 internal fn (thread_lifecycle_contributors).


##### `GoalExtensionHarness::notify_tool_finish`  (lines 1288–1305)

```
async fn notify_tool_finish(&self, turn_id: &str, call_id: &str, tool_name: &str)
```

**Purpose**: Simulates a completed direct tool call so tool-lifecycle contributors can react. It is the main trigger for mid-turn goal progress accounting in many tests.

**Data flow**: It creates a turn store, constructs a plain `ToolName`, iterates tool lifecycle contributors, and awaits each `on_tool_finish` call with session/thread/turn stores, turn id, call id, tool name, direct source, and a successful completed outcome.

**Call relations**: Many tests use it to drive the runtime path that accounts active-goal progress after tool execution.

*Call graph*: calls 3 internal fn (tool_lifecycle_contributors, new, plain).


##### `GoalExtensionHarness::notify_turn_error`  (lines 1307–1320)

```
async fn notify_turn_error(&self, turn_id: &str, error: CodexErrorInfo)
```

**Purpose**: Simulates a turn-level error notification. It lets tests trigger usage-limit and generic-error goal transitions through the real lifecycle interface.

**Data flow**: It creates a turn store, iterates turn lifecycle contributors, and awaits each `on_turn_error` call with the turn id, cloned error, and stores.

**Call relations**: Used by tests covering usage-limit and blocked transitions caused by turn errors.

*Call graph*: calls 2 internal fn (turn_lifecycle_contributors, new); 1 external calls (clone).


##### `GoalExtensionHarness::runtime_handle`  (lines 1322–1326)

```
fn runtime_handle(&self) -> Arc<GoalRuntimeHandle>
```

**Purpose**: Retrieves the installed `GoalRuntimeHandle` from thread-scoped extension data. It exposes direct runtime operations to tests.

**Data flow**: It reads `GoalRuntimeHandle` from `thread_store`, panics if absent, and returns the shared handle.

**Call relations**: Tests call it when they need direct runtime methods such as usage-limit handling or external-mutation preparation.


##### `tool_by_name`  (lines 1329–1337)

```
fn tool_by_name(
    tools: &'a [Arc<dyn ToolExecutor<ToolCall>>],
    name: &str,
) -> &'a Arc<dyn ToolExecutor<ToolCall>>
```

**Purpose**: Finds a plain-namespaced tool executor by name and panics if it is missing. It simplifies test setup for invoking specific goal tools.

**Data flow**: It takes a slice of tool executors and a target name, searches for an executor whose `tool_name()` has no namespace and the matching `name`, and returns a reference to that executor.

**Call relations**: Most tool-invoking tests use it after obtaining a tool list from the harness or installation helpers.

*Call graph*: called by 16 (budget_limited_goal_keeps_accounting_after_later_tool_finish, budget_limited_goal_keeps_accruing_until_turn_stop, create_goal_resets_baseline_before_turn_stop_accounting, external_goal_mutation_start_accounts_active_goal_progress, goal_service_external_set_active_resets_baseline_without_live_thread, installed_goal_tools_create_goal_and_fill_empty_preview, installed_goal_tools_only_replace_complete_goal, parallel_tool_finish_accounts_active_goal_progress_once, thread_stop_unregisters_goal_runtime_from_service, tool_finish_accounts_active_goal_progress_and_emits_event (+6 more)).


##### `tool_call`  (lines 1339–1353)

```
fn tool_call(tool_name: &str, call_id: &str, arguments: serde_json::Value) -> ToolCall
```

**Purpose**: Constructs a deterministic `ToolCall` fixture with JSON function arguments and standard metadata. It keeps tests focused on behavior rather than boilerplate.

**Data flow**: It takes a tool name, call id, and JSON arguments, builds a `ToolCall` with fixed turn id `turn-1`, plain tool name, test model name, byte truncation policy, default conversation history, a `NoopTurnItemEmitter`, empty environments, and a `ToolPayload::Function` containing the serialized arguments string.

**Call relations**: Used throughout the suite whenever a real tool executor is invoked.

*Call graph*: calls 1 internal fn (plain); called by 16 (budget_limited_goal_keeps_accounting_after_later_tool_finish, budget_limited_goal_keeps_accruing_until_turn_stop, create_goal_resets_baseline_before_turn_stop_accounting, external_goal_mutation_start_accounts_active_goal_progress, goal_service_external_set_active_resets_baseline_without_live_thread, installed_goal_tools_create_goal_and_fill_empty_preview, installed_goal_tools_only_replace_complete_goal, parallel_tool_finish_accounts_active_goal_progress_once, thread_stop_unregisters_goal_runtime_from_service, tool_finish_accounts_active_goal_progress_and_emits_event (+6 more)); 5 external calls (new, to_string, new, Bytes, default).


##### `test_runtime`  (lines 1355–1358)

```
async fn test_runtime() -> anyhow::Result<Arc<codex_state::StateRuntime>>
```

**Purpose**: Creates an isolated temporary `StateRuntime` for integration tests. It ensures each test gets a fresh persistent-state sandbox.

**Data flow**: It creates a `TempDir`, keeps its path, initializes `codex_state::StateRuntime` with that path and a fixed provider string, awaits initialization, and returns the shared runtime.

**Call relations**: Nearly every integration test starts by calling this fixture helper.

*Call graph*: calls 1 internal fn (init); called by 20 (budget_limited_goal_keeps_accounting_after_later_tool_finish, budget_limited_goal_keeps_accruing_until_turn_stop, create_goal_resets_baseline_before_turn_stop_accounting, external_goal_mutation_start_accounts_active_goal_progress, goal_service_external_set_active_resets_baseline_without_live_thread, goal_service_sets_gets_and_clears_thread_goal, goal_tools_hidden_for_ephemeral_threads, goal_tools_hidden_for_review_subagents, installed_goal_tools_create_goal_and_fill_empty_preview, installed_goal_tools_only_replace_complete_goal (+10 more)); 1 external calls (new).


##### `test_thread_id`  (lines 1360–1362)

```
fn test_thread_id() -> anyhow::Result<ThreadId>
```

**Purpose**: Returns a fixed valid `ThreadId` used across tests. It avoids repeated UUID parsing boilerplate.

**Data flow**: It parses a constant UUID string with `ThreadId::from_string`, maps any parse error into `anyhow::Error`, and returns the resulting `ThreadId`.

**Call relations**: Used by most tests and helpers as the canonical thread identifier.

*Call graph*: calls 1 internal fn (from_string); called by 20 (budget_limited_goal_keeps_accounting_after_later_tool_finish, budget_limited_goal_keeps_accruing_until_turn_stop, create_goal_resets_baseline_before_turn_stop_accounting, external_goal_mutation_start_accounts_active_goal_progress, goal_service_external_set_active_resets_baseline_without_live_thread, goal_service_sets_gets_and_clears_thread_goal, goal_tools_hidden_for_ephemeral_threads, goal_tools_hidden_for_review_subagents, installed_goal_tools_create_goal_and_fill_empty_preview, installed_goal_tools_only_replace_complete_goal (+10 more)).


##### `seed_thread_metadata`  (lines 1364–1377)

```
async fn seed_thread_metadata(
    runtime: &codex_state::StateRuntime,
    thread_id: ThreadId,
) -> anyhow::Result<()>
```

**Purpose**: Creates baseline thread metadata in the runtime so preview updates and thread lookups have a persisted thread record to operate on. It is a prerequisite fixture for tests that inspect metadata.

**Data flow**: It builds a `ThreadMetadataBuilder` with the thread id, a rollout path under `runtime.codex_home()`, current UTC time, and CLI session source, then persists the built metadata via `runtime.upsert_thread`.

**Call relations**: Called by many tests before installing tools or invoking service methods that expect thread metadata to exist.

*Call graph*: calls 2 internal fn (new, codex_home); called by 18 (budget_limited_goal_keeps_accounting_after_later_tool_finish, budget_limited_goal_keeps_accruing_until_turn_stop, create_goal_resets_baseline_before_turn_stop_accounting, external_goal_mutation_start_accounts_active_goal_progress, goal_service_external_set_active_resets_baseline_without_live_thread, goal_service_sets_gets_and_clears_thread_goal, installed_goal_tools_create_goal_and_fill_empty_preview, installed_goal_tools_only_replace_complete_goal, parallel_tool_finish_accounts_active_goal_progress_once, thread_resume_rehydrates_active_goal_idle_accounting (+8 more)); 3 external calls (now, format!, upsert_thread).


##### `RecordingEventSink::goal_events`  (lines 1385–1398)

```
fn goal_events(&self) -> Vec<CapturedGoalEvent>
```

**Purpose**: Filters captured protocol events down to the goal-update fields relevant to assertions. It converts verbose `Event` values into compact `CapturedGoalEvent` records.

**Data flow**: It obtains the locked event vector via `events()`, iterates over events, selects only `EventMsg::ThreadGoalUpdated`, maps each to `CapturedGoalEvent { event_id, turn_id, status, tokens_used }`, collects them, and returns the vector.

**Call relations**: Tests call it after lifecycle actions to assert emitted goal events without inspecting unrelated event details.

*Call graph*: calls 1 internal fn (events).


##### `RecordingEventSink::clear`  (lines 1400–1402)

```
fn clear(&self)
```

**Purpose**: Clears all captured events from the sink. It lets tests isolate the events produced by a specific action.

**Data flow**: It acquires the event vector through `events()` and empties it in place.

**Call relations**: Used in many tests immediately before the action under examination so assertions only see fresh events.

*Call graph*: calls 1 internal fn (events).


##### `RecordingEventSink::events`  (lines 1404–1406)

```
fn events(&self) -> std::sync::MutexGuard<'_, Vec<Event>>
```

**Purpose**: Returns the mutex guard for the underlying captured event vector, recovering from poisoning if necessary. It centralizes lock acquisition for the sink.

**Data flow**: It locks the `Mutex<Vec<Event>>`, converts any `PoisonError` into the inner guard with `into_inner`, and returns the guard.

**Call relations**: It is the internal helper used by `goal_events`, `clear`, and `emit`.

*Call graph*: called by 3 (clear, emit, goal_events).


##### `RecordingEventSink::emit`  (lines 1410–1412)

```
fn emit(&self, event: Event)
```

**Purpose**: Implements the extension event sink by appending each emitted event to the in-memory capture buffer. It is the observation point for integration-test assertions.

**Data flow**: It takes an `Event`, acquires the event vector via `events()`, and pushes the event into the vector.

**Call relations**: The extension registry calls this whenever the goal extension emits an event; tests later inspect the captured buffer through `goal_events`.

*Call graph*: calls 1 internal fn (events).


##### `default_collaboration_mode`  (lines 1423–1432)

```
fn default_collaboration_mode() -> CollaborationMode
```

**Purpose**: Builds a default `CollaborationMode` fixture for turn-start callbacks. It supplies a stable baseline configuration for tests.

**Data flow**: It constructs and returns a `CollaborationMode` with `ModeKind::Default` and `Settings` containing model `gpt-5` and no optional overrides.

**Call relations**: Used by `GoalExtensionHarness::start_turn_with_mode` before overriding the mode field for specific scenarios.

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

**Purpose**: Constructs `TokenUsage` fixtures from explicit counters for integration tests. It keeps token-accounting scenarios readable and precise.

**Data flow**: It takes five numeric token counters, places them into a `TokenUsage` struct, and returns the struct.

**Call relations**: Used by many tests and harness calls to create baseline and updated cumulative usage snapshots.

*Call graph*: called by 11 (budget_limited_goal_keeps_accounting_after_later_tool_finish, budget_limited_goal_keeps_accruing_until_turn_stop, create_goal_resets_baseline_before_turn_stop_accounting, external_goal_mutation_start_accounts_active_goal_progress, goal_service_external_set_active_resets_baseline_without_live_thread, parallel_tool_finish_accounts_active_goal_progress_once, thread_stop_unregisters_goal_runtime_from_service, tool_finish_accounts_active_goal_progress_and_emits_event, turn_error_usage_limit_accounts_progress_and_clears_accounting, update_goal_can_block_and_accounts_final_progress (+1 more)).


##### `protocol_status`  (lines 1450–1459)

```
fn protocol_status(status: codex_state::ThreadGoalStatus) -> ThreadGoalStatus
```

**Purpose**: Converts persisted goal status values into protocol status values for assertions. It mirrors the production mapping in a test-local helper.

**Data flow**: It matches a `codex_state::ThreadGoalStatus` and returns the corresponding protocol `ThreadGoalStatus` variant.

**Call relations**: Used in tests that read raw persisted goals from runtime but want to compare against protocol-layer status enums.


### `ext/image-generation/src/tests.rs`

`test` · `test execution`

This test module is the specification for the image-generation tool in `tool.rs`. The tests cover three main areas. First, they validate the advertised tool surface: `imagegen_tool_spec()` must expose a namespace tool under the reserved `IMAGE_GEN_NAMESPACE`, with the nested function named `IMAGEGEN_TOOL_NAME`. Second, they probe `request_for_call_args()` across its decision tree. When no image references are supplied, the tool must build an `ImageGenerationRequest` with fixed defaults (`gpt-image-2`, auto background/quality/size). When `num_last_images_to_include` is used, the tests construct mixed `ResponseItem` history containing user message images, function-call outputs, custom-tool outputs, image-generation calls, and orphan outputs; the expected edit request proves that only images tied to valid calls are considered, newest images are selected first, and the final `ImageEditRequest.images` list is returned in chronological order. Additional tests assert exact user-facing errors for conflicting selectors, too many explicit paths, and insufficient history.

The remaining tests pin down `GeneratedImageOutput` serialization. `to_response_item()` must emit a `FunctionCallOutput` containing an `InputImage` data URL and, when short enough, an `InputText` save hint from `extension_image_generation_output_hint()`. `code_mode_result()` must instead return a JSON object for code mode. Helper functions build realistic `ContentItem`, `FunctionCallOutputPayload`, expected edit requests, and a minimal `ToolPayload::Function` fixture.

#### Function details

##### `uses_reserved_image_gen_namespace`  (lines 31–38)

```
fn uses_reserved_image_gen_namespace()
```

**Purpose**: Checks that the tool advertises itself as a namespace tool under the reserved image-generation namespace and that the first nested function uses the expected tool name.

**Data flow**: It reads the `ToolSpec` returned by `imagegen_tool_spec()`, pattern-matches it to `ToolSpec::Namespace`, then inspects the namespace name and first `ResponsesApiNamespaceTool` entry. It produces no value; the assertions fail the test if the namespace shape or names differ.

**Call relations**: This is a top-level unit test for the schema/exposure layer. It directly invokes `imagegen_tool_spec()` and stops at structural assertions rather than exercising request execution.

*Call graph*: 3 external calls (assert_eq!, panic!, imagegen_tool_spec).


##### `omitted_references_generate_with_fixed_defaults`  (lines 41–63)

```
async fn omitted_references_generate_with_fixed_defaults()
```

**Purpose**: Verifies that omitting both explicit image paths and history-based image selection produces a pure generation request with the tool’s baked-in defaults.

**Data flow**: It constructs `ImagegenArgs` with only a prompt, passes empty history and environments into `request_for_call_args()`, awaits the result, and compares the returned `ImageRequest::Generate` against a fully populated `ImageGenerationRequest`. The expected request includes auto background, auto quality, `auto` size, no `n`, and model `gpt-image-2`.

**Call relations**: This test targets the generate branch of `request_for_call_args()`, specifically the `(true, None)` selector case where no edit images are involved.

*Call graph*: 1 external calls (assert_eq!).


##### `recent_image_fallback_selects_newest_images_in_chronological_order`  (lines 66–139)

```
async fn recent_image_fallback_selects_newest_images_in_chronological_order()
```

**Purpose**: Confirms that history-based edit selection finds the most recent valid images across multiple response item kinds, ignores orphaned outputs, and returns the chosen images oldest-to-newest in the final edit request.

**Data flow**: It builds a synthetic `Vec<ResponseItem>` containing user message images, a function call plus matching output, a custom tool call plus matching output, an image-generation call with inline base64 result, and an unmatched function-call output. It passes `ImagegenArgs` with `num_last_images_to_include: Some(4)` into `request_for_call_args()`, then compares the returned `ImageRequest::Edit` to `expected_edit_request()` for `user-2`, `mcp`, `code-mode`, and `generated`.

**Call relations**: This test drives the history-scanning branch of `request_for_call_args()`, indirectly validating `recent_images()` and its use of call-ID tracking to include only outputs associated with actual calls.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `conflicting_image_selectors_return_tool_error`  (lines 142–163)

```
async fn conflicting_image_selectors_return_tool_error()
```

**Purpose**: Ensures the tool rejects requests that specify both explicit image paths and a history-image count at the same time.

**Data flow**: It creates `ImagegenArgs` with one absolute path in `referenced_image_paths` and `num_last_images_to_include: Some(1)`, calls `request_for_call_args()`, expects an error, and compares the error string to the exact model-facing message. No files are read because validation fails before any environment access.

**Call relations**: This test covers the `(false, Some(_))` validation branch in `request_for_call_args()`, where mutually exclusive selectors are rejected immediately.

*Call graph*: 3 external calls (assert_eq!, request_for_call_args, vec!).


##### `too_many_referenced_image_paths_return_tool_error`  (lines 166–191)

```
async fn too_many_referenced_image_paths_return_tool_error()
```

**Purpose**: Checks the hard cap on explicit edit images and verifies that the function fails before attempting to read any referenced files.

**Data flow**: It synthesizes six absolute paths, places them in `referenced_image_paths`, calls `request_for_call_args()` with empty history and environments, expects an error, and asserts the exact message mentioning the maximum of five paths. The transformation ends at argument validation.

**Call relations**: This test exercises the early `paths.len() > MAX_EDIT_IMAGES` guard in `request_for_call_args()`, before the explicit-path branch can call `image_url()`.

*Call graph*: 2 external calls (assert_eq!, request_for_call_args).


##### `recent_image_fallback_requires_requested_count`  (lines 194–217)

```
async fn recent_image_fallback_requires_requested_count()
```

**Purpose**: Verifies that history-based edit selection is strict about the requested count and does not silently proceed with fewer images than requested.

**Data flow**: It passes `ImagegenArgs` requesting the last two images, along with history containing only one user `InputImage`. After awaiting `request_for_call_args()`, it expects an error and compares the message to one that reports both the requested and available counts.

**Call relations**: This test covers the `(true, Some(count))` branch after `recent_images()` returns too few results, validating the exact failure path for insufficient conversation images.

*Call graph*: 3 external calls (assert_eq!, request_for_call_args, vec!).


##### `generated_output_returns_image_input_and_output_hint`  (lines 220–248)

```
fn generated_output_returns_image_input_and_output_hint()
```

**Purpose**: Checks that a generated image result is converted into a function-call output containing both the image bytes as a data URL and a textual save hint when the hint fits.

**Data flow**: It first computes an output hint with `extension_image_generation_output_hint()`, then constructs `GeneratedImageOutput { result, output_hint }`. It calls `to_response_item()` with a call ID and `function_payload()`, pattern-matches the returned `ResponseInputItem::FunctionCallOutput`, extracts `FunctionCallOutputBody::ContentItems`, and asserts that the content list contains an `InputImage` with `DEFAULT_IMAGE_DETAIL` followed by an `InputText` carrying the hint.

**Call relations**: This test targets `GeneratedImageOutput::to_response_item()` behavior in the normal case where a hint is present and short enough to include.

*Call graph*: calls 1 internal fn (function_payload); 3 external calls (assert_eq!, extension_image_generation_output_hint, panic!).


##### `generated_output_returns_generated_image_helper_input_in_code_mode`  (lines 251–264)

```
fn generated_output_returns_generated_image_helper_input_in_code_mode()
```

**Purpose**: Verifies the code-mode serialization path used by helper APIs rather than the normal response-item path.

**Data flow**: It builds a `GeneratedImageOutput` with base64 image data and a hint, calls `code_mode_result(&function_payload())`, and compares the returned `serde_json::Value` to an object containing `image_url` and `output_hint`. The output is a plain JSON object rather than protocol content items.

**Call relations**: This test isolates `GeneratedImageOutput::code_mode_result()`, ensuring code mode receives the helper-friendly shape expected by downstream tooling.

*Call graph*: 1 external calls (assert_eq!).


##### `generated_output_omits_oversized_output_hint`  (lines 267–291)

```
fn generated_output_omits_oversized_output_hint()
```

**Purpose**: Ensures that an oversized save hint is dropped rather than emitted alongside the generated image.

**Data flow**: It creates a very long path string, passes it through `extension_image_generation_output_hint()` to obtain an optional hint, constructs `GeneratedImageOutput`, and converts it with `to_response_item()`. After extracting the content items, it asserts that only the `InputImage` remains and no `InputText` hint is present.

**Call relations**: This test covers the edge case where hint generation returns `None` because the persisted-artifact hint would be too large, validating the omission path in `GeneratedImageOutput::to_response_item()`.

*Call graph*: calls 1 internal fn (function_payload); 3 external calls (assert_eq!, extension_image_generation_output_hint, panic!).


##### `input_image`  (lines 293–298)

```
fn input_image(image: &str) -> ContentItem
```

**Purpose**: Builds a `ContentItem::InputImage` test fixture from a short base64 payload fragment.

**Data flow**: It takes an `&str` image token, formats it into a `data:image/png;base64,...` URL, and returns a `ContentItem::InputImage` with `detail: None`. It does not touch external state.

**Call relations**: This helper is used by history-construction tests to create user message image content without repeating protocol boilerplate.

*Call graph*: 1 external calls (format!).


##### `image_output`  (lines 300–305)

```
fn image_output(image: &str) -> FunctionCallOutputPayload
```

**Purpose**: Builds a `FunctionCallOutputPayload` fixture containing a single image content item.

**Data flow**: It takes an image token, wraps it in a `FunctionCallOutputContentItem::InputImage` data URL, places that in a one-element vector, and converts it with `FunctionCallOutputPayload::from_content_items()`. The return value is a payload suitable for `ResponseItem::FunctionCallOutput` or `CustomToolCallOutput` fixtures.

**Call relations**: This helper supports the history-selection tests by creating tool-output payloads that `recent_images()` can later inspect.

*Call graph*: calls 1 internal fn (from_content_items); 1 external calls (vec!).


##### `expected_edit_request`  (lines 307–322)

```
fn expected_edit_request(prompt: &str, images: &[&str]) -> ImageEditRequest
```

**Purpose**: Constructs the exact `ImageEditRequest` shape expected from edit-selection tests, including default model parameters and ordered image URLs.

**Data flow**: It accepts a prompt and a slice of image tokens, maps each token into an `ImageUrl` data URL, collects them into `images`, and returns an `ImageEditRequest` with auto background, auto quality, `auto` size, no `n`, and model `gpt-image-2`.

**Call relations**: This helper centralizes the expected request structure for tests that compare `request_for_call_args()` output against a concrete edit request.


##### `function_payload`  (lines 324–328)

```
fn function_payload() -> ToolPayload
```

**Purpose**: Provides a minimal `ToolPayload::Function` fixture for output-formatting tests.

**Data flow**: It creates and returns `ToolPayload::Function { arguments: "{}".to_string() }`. No inputs are read and no state is modified.

**Call relations**: This helper is called by the generated-output tests when invoking `GeneratedImageOutput` methods that require a payload argument but do not inspect it.

*Call graph*: called by 2 (generated_output_omits_oversized_output_hint, generated_output_returns_image_input_and_output_hint).


### `ext/memories/src/tests.rs`

`test` · `test execution`

This file is the main behavioral test suite for the memories extension. It covers three layers. First, extension wiring: tests verify the namespace string is Responses-API-safe, that `MemoriesExtension::tools` contributes nothing without thread config or when either `enabled` or `dedicated_tools` is false, and that both direct extension use and top-level `install` register the expected four namespaced tools when enabled. Second, prompt contribution: a Tokio test creates a real `memories/memory_summary.md` and confirms `contribute` emits exactly one `DeveloperPolicy` fragment containing the summary text.

Third, it exercises concrete tool behavior through actual `ToolExecutor` instances returned by `crate::tools::memory_tools` with a `LocalMemoriesBackend`. The helper `memory_tool` selects one tool by namespaced name, while `memory_tool_name` centralizes namespace construction. End-to-end tests invoke `handle` with realistic `ToolCall` payloads and inspect `post_tool_use_response` JSON. They verify ad-hoc note creation writes to `extensions/ad_hoc/notes`, path-like filenames are rejected by schema/argument validation, read requests honor `line_offset` and `max_lines` while marking truncation, search accepts the new multi-query format and windowed `all_within_lines` mode, and legacy single-field `query` input is rejected as an unknown field. The suite intentionally uses temp directories and real async filesystem operations to validate path layout, serialization, and backend/tool integration together.

#### Function details

##### `memory_tool_namespace_matches_responses_api_identifier`  (lines 27–34)

```
fn memory_tool_namespace_matches_responses_api_identifier()
```

**Purpose**: Checks that the configured memory-tool namespace is non-empty and restricted to ASCII alphanumerics, underscore, and hyphen.

**Data flow**: It reads `crate::MEMORY_TOOLS_NAMESPACE`, evaluates character-class predicates over its bytes, and asserts the namespace satisfies the identifier contract. It returns no value and writes no state.

**Call relations**: This standalone unit test guards a naming invariant relied on by tool registration and namespacing throughout the extension.

*Call graph*: 1 external calls (assert!).


##### `tools_are_not_contributed_without_thread_config`  (lines 37–48)

```
fn tools_are_not_contributed_without_thread_config()
```

**Purpose**: Verifies that a default `MemoriesExtension` contributes no dedicated tools when the thread-scoped extension data lacks memories configuration.

**Data flow**: It constructs a default extension plus empty session/thread `ExtensionData`, calls `tools`, and asserts the returned collection is empty.

**Call relations**: This test exercises the extension’s gating logic at the contributor boundary, ensuring tool publication depends on thread configuration.

*Call graph*: 2 external calls (assert!, default).


##### `tools_are_not_contributed_when_disabled`  (lines 51–65)

```
fn tools_are_not_contributed_when_disabled()
```

**Purpose**: Confirms that explicit memories configuration with `enabled: false` suppresses all tool contribution even if dedicated tools are otherwise allowed.

**Data flow**: It creates a default extension, inserts a `MemoriesExtensionConfig` with `enabled: false` into thread data, calls `tools`, and asserts the result is empty.

**Call relations**: This test covers one branch of the extension’s configuration gate, distinguishing global disablement from other settings.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, test_path_buf, default).


##### `tools_are_not_contributed_when_dedicated_tools_disabled`  (lines 68–82)

```
fn tools_are_not_contributed_when_dedicated_tools_disabled()
```

**Purpose**: Confirms that the extension does not publish dedicated tools when `dedicated_tools` is false, even if memories are enabled.

**Data flow**: It builds thread-scoped config with `enabled: true` and `dedicated_tools: false`, invokes `tools`, and asserts no tools are returned.

**Call relations**: This complements the previous gating tests by checking the dedicated-tool feature flag independently.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, test_path_buf, default).


##### `tools_are_contributed_when_enabled_with_dedicated_tools`  (lines 85–109)

```
fn tools_are_contributed_when_enabled_with_dedicated_tools()
```

**Purpose**: Verifies that the extension publishes exactly the four expected namespaced memory tools when both enabling flags are true.

**Data flow**: It inserts enabled thread config, calls `tools`, maps each returned executor to its `tool_name`, collects the names into a vector, and compares that vector to the expected ordered list built with `memory_tool_name`.

**Call relations**: This test validates the positive registration path for direct extension contribution and indirectly checks tool ordering and namespacing.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, test_path_buf, default).


##### `install_registers_dedicated_tool_contributor`  (lines 112–139)

```
fn install_registers_dedicated_tool_contributor()
```

**Purpose**: Checks that the crate-level `install` function wires a tool contributor into the extension registry that later exposes the expected memory tools.

**Data flow**: It creates an `ExtensionRegistryBuilder`, calls `crate::install`, builds the registry, prepares enabled thread config, iterates all registered tool contributors, gathers their tool names, and asserts the resulting list matches the expected namespaced tools.

**Call relations**: This test moves one level above direct extension use to validate installation-time orchestration and registry integration.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert_eq!, test_path_buf, install).


##### `ad_hoc_tool_definition_includes_filename_contract`  (lines 142–159)

```
fn ad_hoc_tool_definition_includes_filename_contract()
```

**Purpose**: Ensures the published schema for the ad-hoc note tool exposes the filename field as a string and documents the required timestamp-slug filename format.

**Data flow**: It obtains the ad-hoc tool via `memory_tool`, serializes its `spec()` to JSON, navigates to `/tools/0/parameters/properties/filename`, and asserts both the JSON type and description contents.

**Call relations**: This test inspects generated tool metadata rather than executing the tool, guarding the contract presented to models and clients.

*Call graph*: calls 1 internal fn (memory_tool); 4 external calls (new, assert!, assert_eq!, to_value).


##### `prompt_contribution_uses_memory_summary_when_enabled`  (lines 162–194)

```
async fn prompt_contribution_uses_memory_summary_when_enabled()
```

**Purpose**: Verifies that prompt contribution reads `memory_summary.md` and emits one developer-policy fragment containing that summary when memories are enabled.

**Data flow**: It creates a temp memories directory and summary file, inserts enabled config with `dedicated_tools: false`, awaits `extension.contribute`, and asserts the fragment count, slot, and text contents.

**Call relations**: This async integration test drives the extension’s prompt-contribution path, which internally reaches the prompt builder rather than the tool layer.

*Call graph*: calls 1 internal fn (new); 6 external calls (assert!, assert_eq!, default, tempdir, create_dir_all, write).


##### `add_ad_hoc_note_tool_creates_note_file`  (lines 197–238)

```
async fn add_ad_hoc_note_tool_creates_note_file()
```

**Purpose**: Executes the ad-hoc note tool end to end and confirms it returns an empty JSON object while writing the note file to the expected append-only notes directory.

**Data flow**: It creates a temp memory root, selects the ad-hoc tool with `memory_tool`, builds a `ToolPayload::Function` JSON string containing `filename` and `note`, constructs a full `ToolCall`, awaits `handle`, checks the post-tool-use JSON response, then reads the created file from `extensions/ad_hoc/notes` and asserts its contents.

**Call relations**: This test uses both helper functions to locate the executor and construct the namespaced tool name, then drives the real backend/tool execution path.

*Call graph*: calls 2 internal fn (memory_tool, memory_tool_name); 7 external calls (new, new, assert_eq!, json!, Bytes, tempdir, default).


##### `add_ad_hoc_note_tool_rejects_paths_as_filenames`  (lines 241–273)

```
async fn add_ad_hoc_note_tool_rejects_paths_as_filenames()
```

**Purpose**: Checks that the ad-hoc note tool rejects path-like filenames such as `../...` instead of allowing directory traversal or malformed note names.

**Data flow**: It builds a temp memory root and tool, sends a function payload with an invalid `filename`, awaits `handle`, pattern-matches the result into an error, and asserts the error string mentions both `filename` and the expected timestamp format.

**Call relations**: This negative-path test exercises argument/schema validation in the tool execution flow and confirms invalid filenames fail before any file write occurs.

*Call graph*: calls 2 internal fn (memory_tool, memory_tool_name); 8 external calls (new, new, assert!, json!, panic!, Bytes, tempdir, default).


##### `read_tool_reads_memory_file`  (lines 276–322)

```
async fn read_tool_reads_memory_file()
```

**Purpose**: Executes the read tool against a real `MEMORY.md` file and verifies line-window extraction plus the `truncated` flag in the JSON response.

**Data flow**: It creates a temp memories directory, writes a three-line file, selects the read tool, sends a payload with `path`, `line_offset`, and `max_lines`, awaits `handle`, and compares the emitted post-tool-use JSON to the expected object containing only the requested line and `truncated: true`.

**Call relations**: This test validates the read tool’s integration with the local backend, including line numbering semantics and response serialization.

*Call graph*: calls 2 internal fn (memory_tool, memory_tool_name); 9 external calls (new, new, assert_eq!, json!, Bytes, tempdir, create_dir_all, write, default).


##### `search_tool_accepts_multiple_queries`  (lines 325–396)

```
async fn search_tool_accepts_multiple_queries()
```

**Purpose**: Verifies that the search tool accepts the current `queries` array format and returns per-line matches with the matched query list for each result.

**Data flow**: It writes a file containing lines that match one or both queries, invokes the search tool with `queries: ["alpha", "needle"]` and `case_sensitive: false`, awaits the result, and asserts the full JSON response including `match_mode`, `matches`, `next_cursor`, and `truncated`.

**Call relations**: This is the primary happy-path test for the modern multi-query search API and its result-shaping behavior.

*Call graph*: calls 2 internal fn (memory_tool, memory_tool_name); 9 external calls (new, new, assert_eq!, json!, Bytes, tempdir, create_dir_all, write, default).


##### `search_tool_accepts_windowed_all_match_mode`  (lines 399–457)

```
async fn search_tool_accepts_windowed_all_match_mode()
```

**Purpose**: Checks that the search tool supports the structured `all_within_lines` match mode and returns a multi-line content window when all queries occur within the configured span.

**Data flow**: It writes a three-line file with the two queries separated by one middle line, invokes the search tool with a `match_mode` object specifying `type: all_within_lines` and `line_count: 3`, awaits execution, and asserts the single returned match spans the whole three-line window.

**Call relations**: This test covers a more specialized search mode than the default any-match behavior, ensuring the tool/backend honor windowed all-query semantics.

*Call graph*: calls 2 internal fn (memory_tool, memory_tool_name); 9 external calls (new, new, assert_eq!, json!, Bytes, tempdir, create_dir_all, write, default).


##### `search_tool_rejects_legacy_single_query`  (lines 460–494)

```
async fn search_tool_rejects_legacy_single_query()
```

**Purpose**: Ensures the search tool no longer accepts the deprecated singular `query` field and surfaces that mismatch as a model-facing validation error.

**Data flow**: It creates a temp memory root and search tool, sends a payload containing only `query`, awaits `handle`, extracts the error from the failed result, and asserts the message mentions both `unknown field` and `query`.

**Call relations**: This negative-path test protects the strict `deny_unknown_fields` argument schema and confirms old clients are rejected clearly rather than silently coerced.

*Call graph*: calls 2 internal fn (memory_tool, memory_tool_name); 9 external calls (new, new, assert!, json!, panic!, Bytes, tempdir, create_dir_all, default).


##### `memory_tool`  (lines 496–505)

```
fn memory_tool(memory_root: &Path, tool_name: &str) -> Arc<dyn ToolExecutor<ToolCall>>
```

**Purpose**: Builds the full set of memory tools for a local backend and returns the one whose namespaced tool name matches the requested short name.

**Data flow**: It takes a filesystem `memory_root` and an unqualified tool name, computes the expected namespaced `ToolName` via `memory_tool_name`, constructs a `LocalMemoriesBackend` from the root, calls `crate::tools::memory_tools`, searches the resulting vector for a matching executor, and returns that executor wrapped in `Arc`, panicking if absent.

**Call relations**: Multiple execution and schema tests call this helper to avoid duplicating tool-construction logic. It delegates backend creation to `LocalMemoriesBackend::from_memory_root` and tool assembly to `memory_tools`.

*Call graph*: calls 3 internal fn (from_memory_root, memory_tool_name, memory_tools); called by 7 (ad_hoc_tool_definition_includes_filename_contract, add_ad_hoc_note_tool_creates_note_file, add_ad_hoc_note_tool_rejects_paths_as_filenames, read_tool_reads_memory_file, search_tool_accepts_multiple_queries, search_tool_accepts_windowed_all_match_mode, search_tool_rejects_legacy_single_query).


##### `memory_tool_name`  (lines 507–509)

```
fn memory_tool_name(tool_name: &str) -> ToolName
```

**Purpose**: Constructs the fully namespaced `ToolName` used by tests when comparing or invoking memory tools.

**Data flow**: It takes a short tool name string and returns `ToolName::namespaced(crate::MEMORY_TOOLS_NAMESPACE, tool_name)`.

**Call relations**: This helper is used directly by tests that build `ToolCall`s and indirectly by `memory_tool` when selecting a specific executor.

*Call graph*: calls 1 internal fn (namespaced); called by 7 (add_ad_hoc_note_tool_creates_note_file, add_ad_hoc_note_tool_rejects_paths_as_filenames, memory_tool, read_tool_reads_memory_file, search_tool_accepts_multiple_queries, search_tool_accepts_windowed_all_match_mode, search_tool_rejects_legacy_single_query).


### `memories/write/src/extensions/ad_hoc_tests.rs`

`test` · `test execution`

This test module covers the idempotence contract of `ad_hoc::seed_instructions`. It builds an isolated temporary Codex home with `tempfile::TempDir`, derives a synthetic memories root beneath it, and computes the expected `extensions/ad_hoc/instructions.md` path using the same `memory_extensions_root` helper as production code. That keeps the test aligned with the actual on-disk layout rather than duplicating path strings.

The test performs two passes. First, it calls `seed_instructions` on an empty tree and asserts that reading the resulting file yields the exact embedded `INSTRUCTIONS` constant. This confirms both directory creation and initial file contents. Next, it deliberately overwrites the file with the string `custom instructions`, calls `seed_instructions` again, and asserts that the custom contents remain unchanged. That second assertion is the important edge case: the production code must treat `AlreadyExists` as success and avoid clobbering user edits.

Because the test uses Tokio async filesystem APIs end-to-end, it validates the same asynchronous code paths used at runtime. The module is focused on observable file contents rather than implementation details like specific `OpenOptions` flags.

#### Function details

##### `seeds_instructions_without_overwriting_existing_file`  (lines 7–36)

```
async fn seeds_instructions_without_overwriting_existing_file()
```

**Purpose**: Exercises the seeding routine twice to prove first-run creation and second-run non-overwrite semantics. It checks both the default seeded markdown and preservation of a manually edited file.

**Data flow**: Creates a temporary directory, derives `memory_root` and `instructions_path`, invokes `seed_instructions(&memory_root)`, reads the file back and compares it to `INSTRUCTIONS`, writes replacement text to the same path, invokes `seed_instructions(&memory_root)` again, then reads the file again and asserts the contents are still `custom instructions`.

**Call relations**: This is a standalone Tokio test entrypoint rather than a helper called by other code. It mirrors production path construction through `memory_extensions_root`, drives the real `seed_instructions` implementation, and uses assertions around filesystem reads and writes to validate the create-only behavior.

*Call graph*: 4 external calls (new, assert_eq!, memory_extensions_root, write).


### MCP configuration and transport integration
These files test MCP config parsing, catalog resolution, connection management, extension overlays, and full client transport behavior across local and remote scenarios.

### `codex-mcp/src/plugin_config_tests.rs`

`test` · `test execution`

This test file exercises `parse_plugin_mcp_config` with realistic plugin JSON snippets and compares the full `PluginMcpConfigParseOutcome` against expected typed `McpServerConfig` values. Two helpers reduce repetition: `plugin_root` anchors all relative-path expectations under a synthetic `plugin-root` directory beneath the current working directory, and `stdio_server` constructs expected stdio configs with the exact transport and default flags used by the parser.

The tests cover both supported placement modes. In declared placement, relative `cwd` values are rewritten under the plugin root, configured `environment_id` is preserved, HTTP servers deserialize normally, OAuth `clientId` is renamed to `client_id`, and plugin-level `callbackPort` is ignored rather than propagated. In environment placement, the parser forcibly overwrites `environment_id`, defaults null or missing stdio `cwd` to the plugin root, resolves safe relative `cwd` values beneath that root, and rejects escaping paths like `../outside` with a per-server error while still returning `Ok(outcome)`. The env-var tests pin down the authority rules enforced by `bind_environment_env_vars`: executor-owned plugins convert bare names to remote config entries and reject `source: "local"`, while local environments preserve bare names and `source: "local"` but reject `source: "remote"`. Together these tests document that plugin MCP parsing is intentionally lossy and policy-aware rather than a direct JSON-to-struct decode.

#### Function details

##### `plugin_root`  (lines 16–20)

```
fn plugin_root() -> PathBuf
```

**Purpose**: Builds the synthetic plugin root path used by parser tests. It anchors expectations relative to the current working directory.

**Data flow**: Reads the process current directory, appends `plugin-root`, and returns the resulting `PathBuf`.

**Call relations**: This helper is used by nearly every test in the file to produce a stable root for relative `cwd` normalization.

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

**Purpose**: Constructs an expected stdio `McpServerConfig` for assertions. It centralizes the exact default flags and transport shape used in parser outputs.

**Data flow**: Consumes `command`, `environment_id`, a `cwd` path, and `env_vars`, then returns an `McpServerConfig` with `McpServerTransportConfig::Stdio { command, args: [], env: None, env_vars, cwd: Some(cwd.to_path_buf()) }`, the supplied environment ID, enabled=true, and all optional MCP fields unset.

**Call relations**: This helper is used by tests that compare parser output against expected stdio configs.

*Call graph*: called by 1 (declared_placement_preserves_local_plugin_normalization); 3 external calls (new, to_path_buf, new).


##### `declared_placement_preserves_local_plugin_normalization`  (lines 54–116)

```
fn declared_placement_preserves_local_plugin_normalization()
```

**Purpose**: Verifies declared placement behavior for both stdio and HTTP plugin servers. It checks relative `cwd` rewriting, preservation of configured environment ID, and OAuth field normalization.

**Data flow**: Builds expected stdio and HTTP `McpServerConfig` values, calls `parse_plugin_mcp_config` on a JSON document containing one stdio and one HTTP server under `PluginMcpServerPlacement::Declared`, and asserts the returned `PluginMcpConfigParseOutcome` contains both servers and no errors.

**Call relations**: This test exercises the declared-placement branches in `normalize_plugin_mcp_server_value` and the final typed deserialization path.

*Call graph*: calls 2 internal fn (plugin_root, stdio_server); 4 external calls (new, new, assert_eq!, parse_plugin_mcp_config).


##### `environment_placement_forces_authority_and_defaults_null_cwd`  (lines 119–162)

```
fn environment_placement_forces_authority_and_defaults_null_cwd()
```

**Purpose**: Verifies that environment placement overwrites `environment_id`, defaults null `cwd` to the plugin root, and rewrites bare/local-unspecified env vars to remote config entries for executor-owned plugins.

**Data flow**: Calls `parse_plugin_mcp_config` on a wrapped `mcpServers` JSON document with `cwd: null` and mixed `env_vars`, using `PluginMcpServerPlacement::Environment { environment_id: "executor-1" }`, then asserts the outcome contains one stdio server with environment ID `executor-1`, `cwd` equal to the plugin root, and both env vars converted to `McpServerEnvVar::Config { source: Some("remote") }`.

**Call relations**: This test covers the environment-placement rewrite logic in `normalize_plugin_mcp_server` and `bind_environment_env_vars`.

*Call graph*: calls 1 internal fn (plugin_root); 2 external calls (assert_eq!, parse_plugin_mcp_config).


##### `environment_placement_resolves_relative_cwd_beneath_plugin_root`  (lines 165–191)

```
fn environment_placement_resolves_relative_cwd_beneath_plugin_root()
```

**Purpose**: Verifies that a relative stdio `cwd` is resolved beneath the plugin root for executor-owned placement. Safe relative paths should become absolute plugin-root-relative paths.

**Data flow**: Parses a one-server JSON document with `cwd: "scripts"` under environment placement and asserts the outcome contains a stdio config whose `cwd` is `plugin_root.join("scripts")` and whose environment ID is the forced executor ID.

**Call relations**: This test exercises the successful path through `executor_plugin_cwd`.

*Call graph*: calls 1 internal fn (plugin_root); 2 external calls (assert_eq!, parse_plugin_mcp_config).


##### `environment_placement_rejects_relative_cwd_that_escapes_package`  (lines 194–218)

```
fn environment_placement_rejects_relative_cwd_that_escapes_package()
```

**Purpose**: Verifies that executor-owned placement rejects relative `cwd` values that escape the plugin root. The parser should report a per-server error instead of producing a config.

**Data flow**: Parses a one-server JSON document with `cwd: "../outside"` under environment placement and asserts the outcome contains no servers and one `PluginMcpServerParseError` whose message includes the plugin root path.

**Call relations**: This test covers the error branch in `executor_plugin_cwd` as surfaced through `normalize_plugin_mcp_server`.

*Call graph*: calls 1 internal fn (plugin_root); 2 external calls (assert_eq!, parse_plugin_mcp_config).


##### `environment_placement_rejects_orchestrator_env_vars`  (lines 221–244)

```
fn environment_placement_rejects_orchestrator_env_vars()
```

**Purpose**: Verifies that executor-owned plugins cannot request orchestrator-local env vars via `source: "local"`. Such declarations must be rejected during normalization.

**Data flow**: Parses a one-server JSON document whose `env_vars` contains `{ "name": "TOKEN", "source": "local" }` under executor environment placement and asserts the outcome contains no servers and one parse error with the expected message.

**Call relations**: This test exercises the invalid remote-environment branch in `bind_environment_env_vars`.

*Call graph*: calls 1 internal fn (plugin_root); 2 external calls (assert_eq!, parse_plugin_mcp_config).


##### `local_environment_placement_preserves_local_env_vars`  (lines 247–279)

```
fn local_environment_placement_preserves_local_env_vars()
```

**Purpose**: Verifies that local environment placement preserves local env-var semantics. Bare names remain bare names and explicit `source: "local"` remains valid.

**Data flow**: Parses a one-server JSON document with mixed bare and explicit-local `env_vars` under `PluginMcpServerPlacement::Environment { environment_id: DEFAULT_MCP_SERVER_ENVIRONMENT_ID }` and asserts the outcome contains one stdio server rooted at the plugin root with the original local env-var forms preserved.

**Call relations**: This test covers the local-environment success branches in `bind_environment_env_vars`.

*Call graph*: calls 1 internal fn (plugin_root); 2 external calls (assert_eq!, parse_plugin_mcp_config).


##### `local_environment_placement_rejects_remote_env_vars`  (lines 282–304)

```
fn local_environment_placement_rejects_remote_env_vars()
```

**Purpose**: Verifies that local environment placement rejects env vars explicitly marked `source: "remote"`. Local plugins cannot demand executor-owned secret sourcing.

**Data flow**: Parses a one-server JSON document with `env_vars` containing `{ "name": "TOKEN", "source": "remote" }` under local environment placement and asserts the outcome contains no servers and one parse error with the expected message.

**Call relations**: This test exercises the invalid local-environment branch in `bind_environment_env_vars`.

*Call graph*: calls 1 internal fn (plugin_root); 2 external calls (assert_eq!, parse_plugin_mcp_config).


### `ext/mcp/src/executor_plugin/provider_tests.rs`

`test` · `test execution`

This test module builds a narrow fake `ExecutorFileSystem` to validate `load_from_file_system()` without touching a real executor. `SyntheticExecutorFileSystem` stores a single expected config path, optional file contents, and a mutex-protected log of every absolute path read. Its `unsupported()` helper returns a consistent `io::ErrorKind::Unsupported`, and every trait method except `read_file` delegates to that helper so the tests fail if the provider unexpectedly uses another file-system operation. `read_file` converts the incoming `PathUri` back to an absolute path, records it, and only returns bytes when the path matches the configured MCP file and contents are present.

The tests cover three behaviors. `reads_declared_config_only_through_executor_file_system` creates a plugin whose manifest points at `config/mcp.json`, confirms the plugin root does not exist on disk, and still successfully loads one stdio server from synthetic contents while filtering out the hosted HTTP server. `missing_default_config_is_empty` verifies that absent `<plugin_root>/.mcp.json` is treated as no servers rather than an error. `malformed_declared_config_is_an_error` checks that invalid JSON becomes `ExecutorPluginMcpProviderError::ParseConfig` carrying the selected-root ID and exact path. Helper functions `resolved_plugin()` and `reads()` centralize plugin construction and inspection of the synthetic read log.

#### Function details

##### `SyntheticExecutorFileSystem::unsupported`  (lines 40–45)

```
fn unsupported() -> FileSystemResult<T>
```

**Purpose**: Creates the standard unsupported-operation error used by all fake file-system methods that the provider should never call in these tests.

**Data flow**: It is generic over `T` and returns `FileSystemResult<T>` containing an `io::Error` with kind `Unsupported` and a fixed explanatory message.

**Call relations**: All synthetic file-system trait methods except `read_file` delegate here, making unexpected provider behavior visible as a test failure.

*Call graph*: 1 external calls (new).


##### `SyntheticExecutorFileSystem::canonicalize`  (lines 49–55)

```
fn canonicalize(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, PathUri>
```

**Purpose**: Implements the trait method by returning an unsupported-operation future.

**Data flow**: It ignores the path and sandbox inputs, boxes an async block, and resolves to `Self::unsupported()`.

**Call relations**: This exists only to satisfy `ExecutorFileSystem`; the provider tests rely on `load_from_file_system()` not calling it.

*Call graph*: 2 external calls (pin, unsupported).


##### `SyntheticExecutorFileSystem::read_file`  (lines 57–75)

```
fn read_file(
        &'a self,
        path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>>
```

**Purpose**: Simulates reading exactly one configured file through the executor file-system interface while recording every attempted path.

**Data flow**: It takes a `PathUri`, converts it to an absolute path with `to_abs_path()`, locks `self.reads` and pushes a clone of that path, then compares it to `self.config_path`. If the path differs, it returns `NotFound`. If it matches, it returns `config_contents` as bytes when present, otherwise `NotFound`. The result is wrapped in a boxed async future.

**Call relations**: This is the only synthetic file-system operation that `load_from_file_system()` is expected to use in these tests.

*Call graph*: calls 1 internal fn (to_abs_path); 3 external calls (pin, new, clone).


##### `SyntheticExecutorFileSystem::read_file_stream`  (lines 77–83)

```
fn read_file_stream(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream>
```

**Purpose**: Implements streaming reads as unsupported because the provider should read config text directly, not as a stream.

**Data flow**: It ignores inputs and returns a boxed future resolving to `Self::unsupported()`.

**Call relations**: Included solely for trait completeness; unexpected invocation would indicate the provider changed its I/O strategy.

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

**Purpose**: Rejects writes in the synthetic file system.

**Data flow**: It ignores the path, contents, and sandbox and returns a boxed future resolving to the standard unsupported error.

**Call relations**: This guards against accidental mutation during provider tests.

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

**Purpose**: Rejects directory creation in the synthetic file system.

**Data flow**: It ignores all inputs and returns a boxed future resolving to `Self::unsupported()`.

**Call relations**: Present only to satisfy the trait; the provider should never need directory creation.

*Call graph*: 2 external calls (pin, unsupported).


##### `SyntheticExecutorFileSystem::get_metadata`  (lines 103–109)

```
fn get_metadata(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>
```

**Purpose**: Rejects metadata lookups in the synthetic file system.

**Data flow**: It ignores the path and sandbox and returns a boxed future resolving to the unsupported error.

**Call relations**: This ensures tests remain focused on direct file reads rather than metadata-based probing.

*Call graph*: 2 external calls (pin, unsupported).


##### `SyntheticExecutorFileSystem::read_directory`  (lines 111–117)

```
fn read_directory(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>>
```

**Purpose**: Rejects directory listing in the synthetic file system.

**Data flow**: It ignores inputs and returns a boxed future resolving to `Self::unsupported()`.

**Call relations**: The provider should not enumerate directories when locating MCP config files.

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

**Purpose**: Rejects file removal in the synthetic file system.

**Data flow**: It ignores the path, options, and sandbox and returns a boxed future resolving to the unsupported error.

**Call relations**: This is trait boilerplate and should remain unused by the provider.

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

**Purpose**: Rejects copy operations in the synthetic file system.

**Data flow**: It ignores source, destination, options, and sandbox and returns a boxed future resolving to `Self::unsupported()`.

**Call relations**: This final unsupported trait method helps ensure the provider performs only the expected read operation.

*Call graph*: 2 external calls (pin, unsupported).


##### `reads_declared_config_only_through_executor_file_system`  (lines 140–188)

```
async fn reads_declared_config_only_through_executor_file_system()
```

**Purpose**: Verifies that a manifest-declared MCP config is loaded through the executor file system even when the plugin root does not exist on the host file system, and that only stdio servers survive filtering.

**Data flow**: It creates temporary directories, derives a non-existent plugin root, asserts that root is absent on disk, constructs a declared config path under that root, builds a `ResolvedPlugin` with `resolved_plugin()`, and instantiates `SyntheticExecutorFileSystem` with matching contents. It awaits `load_from_file_system()`, then asserts that the returned vector contains only the `demo` stdio server with environment-bound config and that `reads(&file_system)` recorded exactly the declared config path.

**Call relations**: This test directly exercises `load_from_file_system()` and uses `resolved_plugin()` plus `reads()` helpers to keep setup and verification concise.

*Call graph*: calls 2 internal fn (resolved_plugin, from_absolute_path_checked); 6 external calls (new, new, assert!, assert_eq!, load_from_file_system, tempdir).


##### `missing_default_config_is_empty`  (lines 191–209)

```
async fn missing_default_config_is_empty()
```

**Purpose**: Checks that when no explicit MCP config path is declared, a missing default `.mcp.json` file is treated as an empty server list rather than an error.

**Data flow**: It creates a temporary plugin root, computes the default config path, builds a plugin with `mcp_servers: None`, and uses a synthetic file system whose configured file is absent. After awaiting `load_from_file_system()`, it asserts that the returned server vector is empty and that the provider attempted exactly one read of the default path.

**Call relations**: This test covers the special-case `NotFound` handling for the default config path inside `load_from_file_system()`.

*Call graph*: calls 2 internal fn (resolved_plugin, from_absolute_path_checked); 5 external calls (new, new, assert_eq!, load_from_file_system, tempdir).


##### `malformed_declared_config_is_an_error`  (lines 212–241)

```
async fn malformed_declared_config_is_an_error()
```

**Purpose**: Ensures that invalid JSON in an explicitly declared MCP config produces a structured parse error containing the selected-root ID and config path.

**Data flow**: It creates a temporary plugin root and declared config path, builds a plugin with that path, and configures the synthetic file system to return malformed JSON. It awaits `load_from_file_system()`, expects an error, pattern-matches it to `ExecutorPluginMcpProviderError::ParseConfig`, and asserts the `plugin_id` and `path` fields. It also checks that the synthetic read log contains the declared path.

**Call relations**: This test targets the parse-failure branch of `load_from_file_system()` and confirms that error context is preserved for callers.

*Call graph*: calls 2 internal fn (resolved_plugin, from_absolute_path_checked); 6 external calls (new, new, assert_eq!, panic!, load_from_file_system, tempdir).


##### `resolved_plugin`  (lines 243–267)

```
fn resolved_plugin(
    plugin_root: &AbsolutePathBuf,
    mcp_servers: Option<AbsolutePathBuf>,
) -> ResolvedPlugin
```

**Purpose**: Builds a minimal `ResolvedPlugin` fixture representing an environment-backed selected plugin with optional MCP config path metadata.

**Data flow**: It takes a plugin root and optional `mcp_servers` path, then calls `ResolvedPlugin::from_environment(...)` with fixed selected-root ID `selected-root`, environment ID `executor-test`, the plugin root, a synthetic plugin manifest path under `.codex-plugin/plugin.json`, and a `PluginManifest` whose `paths.mcp_servers` field is set from the argument. It returns the resulting `ResolvedPlugin`.

**Call relations**: This helper is used by all three provider tests to create consistent plugin descriptors without repeating manifest boilerplate.

*Call graph*: calls 2 internal fn (from_environment, join); called by 3 (malformed_declared_config_is_an_error, missing_default_config_is_empty, reads_declared_config_only_through_executor_file_system); 2 external calls (new, clone).


##### `reads`  (lines 269–275)

```
fn reads(file_system: &SyntheticExecutorFileSystem) -> Vec<AbsolutePathBuf>
```

**Purpose**: Returns the list of absolute paths that the synthetic executor file system has been asked to read.

**Data flow**: It locks `file_system.reads`, recovers from poisoning with `PoisonError::into_inner`, clones the stored `Vec<AbsolutePathBuf>`, and returns it.

**Call relations**: This helper is used by the tests to assert that `load_from_file_system()` accessed exactly the expected config path and nothing else.


### `codex-mcp/src/mcp/mod_tests.rs`

`test` · `test execution`

This test file exercises the outward-facing logic in `mcp/mod.rs` with concrete `McpConfig`, catalog, and auth setups. The shared `test_mcp_config` helper constructs a minimal but realistic `McpConfig` with defaults for OAuth storage, approval policy, elicitation capability, and an empty `ResolvedMcpCatalog`, so each test can override only the fields it cares about.

Several tests pin down policy decisions that are easy to regress: `qualified_mcp_tool_name_prefix` must sanitize invalid characters without lowercasing; `mcp_permission_prompt_is_auto_approved` must approve unrestricted managed profiles only when the global policy is `Never`, but always honor explicit `AppToolApproval::Approve` regardless of policy; and `AppToolApproval::Auto` must not silently auto-approve in the default permission mode. Provenance tests build plugin-backed catalogs and plugin capability summaries to verify that connector IDs aggregate multiple plugin display names, MCP server attribution comes from catalog plugin attribution, selected plugin servers are tracked separately, and unrelated local summaries are not merged into selected-plugin attribution. URL/config tests verify the legacy ChatGPT `/backend-api/wham/apps` path, preservation of existing `/api/codex` paths, and forwarding of the `X-OpenAI-Product-Sku` header. The async server test confirms that `effective_mcp_servers` preserves ordinary configured servers while retaining the built-in `codex_apps` server only when apps are enabled and ChatGPT auth is present.

#### Function details

##### `test_mcp_config`  (lines 20–39)

```
fn test_mcp_config(codex_home: PathBuf) -> McpConfig
```

**Purpose**: Builds a baseline `McpConfig` for tests with sensible defaults and an injected `codex_home`. It minimizes boilerplate for tests that only need to tweak a few fields.

**Data flow**: Consumes a `PathBuf` and returns an `McpConfig` populated with a fixed ChatGPT base URL, disabled apps, default OAuth/keyring settings, `Constrained::allow_any(AskForApproval::OnFailure)`, default elicitation capability, an empty `ResolvedMcpCatalog`, and no plugin summaries.

**Call relations**: This helper is called by multiple tests that need a mutable config scaffold before registering servers or plugin metadata.

*Call graph*: calls 2 internal fn (allow_any, default); called by 3 (effective_mcp_servers_preserve_runtime_servers, selected_mcp_attribution_does_not_join_an_unrelated_local_summary, tool_plugin_provenance_collects_app_and_mcp_sources); 4 external calls (default, new, default, default).


##### `qualified_mcp_tool_name_prefix_sanitizes_server_names_without_lowercasing`  (lines 42–47)

```
fn qualified_mcp_tool_name_prefix_sanitizes_server_names_without_lowercasing()
```

**Purpose**: Verifies that qualified MCP tool prefixes replace invalid characters but preserve case. It specifically checks that `Some-Server` becomes `mcp__Some_Server__`.

**Data flow**: Calls `qualified_mcp_tool_name_prefix("Some-Server")` and asserts the returned string equals the expected sanitized prefix.

**Call relations**: This test documents the exact sanitization behavior expected from the public helper.

*Call graph*: 1 external calls (assert_eq!).


##### `mcp_prompt_auto_approval_honors_unrestricted_managed_profiles`  (lines 50–80)

```
fn mcp_prompt_auto_approval_honors_unrestricted_managed_profiles()
```

**Purpose**: Verifies the interaction between approval policy and permission profile for automatic MCP prompt approval. Unrestricted managed profiles should auto-approve only under `AskForApproval::Never`.

**Data flow**: Constructs several `PermissionProfile` values, calls `mcp_permission_prompt_is_auto_approved` with different `AskForApproval` values and default context, and asserts true for unrestricted managed profiles under `Never` and false for read-only or non-`Never` cases.

**Call relations**: This test exercises the profile-based branches of the approval policy helper.

*Call graph*: 1 external calls (assert!).


##### `mcp_prompt_auto_approval_honors_approved_tools_in_all_permission_modes`  (lines 83–113)

```
fn mcp_prompt_auto_approval_honors_approved_tools_in_all_permission_modes()
```

**Purpose**: Verifies that explicit per-tool approval mode `Approve` overrides every global approval policy. It also confirms that `Auto` does not get the same treatment.

**Data flow**: Iterates over several `AskForApproval` variants, including a granular config, and asserts that `mcp_permission_prompt_is_auto_approved` returns true when `tool_approval_mode` is `Some(AppToolApproval::Approve)`. It then asserts false for `Some(AppToolApproval::Auto)` under `OnRequest`.

**Call relations**: This test covers the early-return branch in the approval helper that honors explicit tool approval.

*Call graph*: 2 external calls (Granular, assert!).


##### `mcp_prompt_auto_approval_rejects_auto_mode_in_default_permission_mode`  (lines 116–124)

```
fn mcp_prompt_auto_approval_rejects_auto_mode_in_default_permission_mode()
```

**Purpose**: Verifies that `AppToolApproval::Auto` does not silently auto-approve prompts in the default permission mode. It distinguishes `Auto` from explicit `Approve`.

**Data flow**: Calls `mcp_permission_prompt_is_auto_approved` with `AskForApproval::OnRequest`, a read-only profile, and context containing `tool_approval_mode: Some(AppToolApproval::Auto)`, then asserts the result is false.

**Call relations**: This is a focused regression test for the non-approval behavior of `Auto`.

*Call graph*: 1 external calls (assert!).


##### `tool_plugin_provenance_collects_app_and_mcp_sources`  (lines 127–187)

```
fn tool_plugin_provenance_collects_app_and_mcp_sources()
```

**Purpose**: Verifies that plugin provenance combines connector-level plugin summaries with MCP-server-level catalog attribution. It also checks plugin ID lookup behavior.

**Data flow**: Builds a test config, registers one plugin-attributed MCP server in a `ResolvedMcpCatalog`, populates two `PluginCapabilitySummary` values with overlapping connector IDs, calls `tool_plugin_provenance`, and asserts the resulting `ToolPluginProvenance` contains sorted connector display-name lists, server-level attribution for `alpha`, the correct plugin ID map, and an empty selected-plugin set. It then asserts `plugin_id_for_mcp_server_name` returns `Some` for `alpha` and `None` for `beta`.

**Call relations**: This test exercises `ToolPluginProvenance::from_config` through the public wrapper and validates both aggregation and lookup accessors.

*Call graph*: calls 4 internal fn (new, from_plugin, builder, test_mcp_config); 3 external calls (new, assert_eq!, vec!).


##### `selected_mcp_attribution_does_not_join_an_unrelated_local_summary`  (lines 190–228)

```
fn selected_mcp_attribution_does_not_join_an_unrelated_local_summary()
```

**Purpose**: Verifies that selected-plugin MCP attribution comes from the catalog entry and is not merged with an unrelated local plugin summary that happens to share the same plugin ID and server name.

**Data flow**: Builds a config with one selected-plugin registration for `github` and one local `PluginCapabilitySummary` using the same plugin ID, calls `tool_plugin_provenance`, and asserts the resulting provenance contains only the catalog display name `Executor GitHub`, the shared plugin ID, and `github` in `selected_plugin_mcp_server_names`. It also asserts `is_selected_plugin_mcp_server("github")` is true.

**Call relations**: This test protects the design choice in `ToolPluginProvenance::from_config` to trust catalog MCP attribution over unrelated local summaries.

*Call graph*: calls 4 internal fn (new, from_selected_plugin, builder, test_mcp_config); 4 external calls (new, assert!, assert_eq!, vec!).


##### `codex_apps_mcp_url_for_base_url_keeps_existing_paths`  (lines 231–248)

```
fn codex_apps_mcp_url_for_base_url_keeps_existing_paths()
```

**Purpose**: Verifies URL normalization for the built-in apps server across ChatGPT and localhost-style base URLs. Existing `/backend-api` and `/api/codex` paths must be preserved appropriately.

**Data flow**: Calls `codex_apps_mcp_url_for_base_url` with four representative base URLs and asserts each returned endpoint string matches the expected legacy or appended path.

**Call relations**: This test documents the path-rewriting rules implemented by the URL helper.

*Call graph*: 1 external calls (assert_eq!).


##### `codex_apps_server_config_uses_legacy_codex_apps_path`  (lines 251–260)

```
fn codex_apps_server_config_uses_legacy_codex_apps_path()
```

**Purpose**: Verifies that the built-in apps server config targets the legacy ChatGPT-hosted `/backend-api/wham/apps` endpoint. It ensures the public config constructor preserves backward-compatible routing.

**Data flow**: Builds a config with `codex_apps_mcp_server_config`, pattern-matches its transport as `StreamableHttp`, extracts the URL, and asserts it equals the expected legacy path; any other transport panics.

**Call relations**: This test exercises `codex_apps_mcp_server_config` and indirectly the URL normalization helpers.

*Call graph*: 2 external calls (assert_eq!, panic!).


##### `codex_apps_server_config_forwards_configured_product_sku_header`  (lines 263–283)

```
fn codex_apps_server_config_forwards_configured_product_sku_header()
```

**Purpose**: Verifies that a configured product SKU is forwarded as the `X-OpenAI-Product-Sku` HTTP header in the built-in apps server config. It also checks that no environment-derived headers are added.

**Data flow**: Builds a config with `codex_apps_mcp_server_config(..., Some("tpp"))`, matches the transport as `StreamableHttp`, and asserts `http_headers` contains the expected single-entry map while `env_http_headers` is `None`; any other transport panics.

**Call relations**: This test covers the SKU-header branch in `mcp_server_config_for_url` through the public constructor.

*Call graph*: 3 external calls (assert!, assert_eq!, panic!).


##### `effective_mcp_servers_preserve_runtime_servers`  (lines 286–390)

```
async fn effective_mcp_servers_preserve_runtime_servers()
```

**Purpose**: Verifies that `effective_mcp_servers` preserves ordinary configured servers and retains the built-in apps server when apps are enabled and ChatGPT auth is available. It checks that each resulting server still exposes its configured transport.

**Data flow**: Creates a temporary codex home, builds a test config with `apps_enabled = true`, creates dummy ChatGPT auth, registers two user-configured HTTP servers plus `codex_apps` in the catalog, calls `effective_mcp_servers`, retrieves the three expected entries, unwraps their configured configs, and asserts each transport URL matches the original configured endpoint.

**Call relations**: This async test exercises the full configured-to-effective server path, including auth gating for the built-in apps server.

*Call graph*: calls 4 internal fn (from_config, builder, test_mcp_config, create_dummy_chatgpt_auth_for_testing); 4 external calls (new, assert_eq!, panic!, tempdir).


### `codex-mcp/src/catalog_tests.rs`

`test` · `test execution`

This test module exercises the resolver in `catalog.rs` with concrete registrations from every source tier. The `server` helper builds a fully populated `McpServerConfig` rather than a minimal stub, including transport URL, environment ID, enabled/required flags, startup and tool timeouts, default approval mode, enabled/disabled tool lists, and a per-tool approval override. Additional helpers create plugin attributions, source enums, and conflict-action wrappers so assertions can compare exact `McpServerConflict` structures.

The tests document the precedence ladder and tie-breaking rules. `source_precedence_preserves_the_winning_registration` shows that extension registrations outrank compatibility, config, and plugin registrations, while same-tier plugin conflicts are still recorded even when a higher-tier source wins overall. Several tests cover the legacy disabled-name veto behavior: disabling a winner forces only that winner’s resolved config to `enabled = false`, and disabled config or discovered-plugin winners persist as vetoes when the catalog is later extended via `to_builder`; disabled selected-plugin winners do not. Other tests verify that earlier plugin or selected-plugin order wins within a tier, that selected plugins outrank discovered plugins but not config, and that equal-precedence compatibility actions use insertion order rather than source identity. The final compatibility-removal test confirms that a winning remove action deletes the server entirely while still surfacing a conflict record containing both registrations and the removal contender.

#### Function details

##### `server`  (lines 18–46)

```
fn server(url: &str) -> McpServerConfig
```

**Purpose**: Builds a representative `McpServerConfig` for tests from a URL. The config includes non-default fields so equality assertions catch accidental field loss during resolution.

**Data flow**: Takes a `&str url`, constructs a `McpServerConfig` with `StreamableHttp` transport, default environment ID, enabled and required flags, timeout durations, approval settings, enabled/disabled tool lists, and a `tools` map containing a `read` override, then returns the config.

**Call relations**: This fixture helper is used by nearly every catalog test to create comparable configs for different source registrations.

*Call graph*: called by 8 (disabled_discovered_plugin_remains_a_veto_for_runtime_overlays, disabled_selected_plugin_does_not_veto_runtime_overlays, disabled_veto_only_disables_the_winning_registration, disabled_winner_remains_a_veto_when_the_catalog_is_extended, earlier_plugin_wins_with_an_explicit_conflict, equal_precedence_uses_insertion_order_not_source_identity, selected_plugins_override_discovered_plugins_but_not_config, source_precedence_preserves_the_winning_registration); 3 external calls (from_secs, from, vec!).


##### `plugin`  (lines 48–50)

```
fn plugin(plugin_id: &str) -> McpPluginAttribution
```

**Purpose**: Creates a plugin attribution whose display name matches its plugin ID. It keeps test setup concise when only identity matters.

**Data flow**: Consumes a plugin ID string slice, clones it into two `String`s, passes them to `McpPluginAttribution::new`, and returns the attribution.

**Call relations**: Used directly by tests and indirectly by `plugin_source` and `selected_plugin_source` when constructing expected sources and registrations.

*Call graph*: calls 1 internal fn (new); called by 7 (disabled_discovered_plugin_remains_a_veto_for_runtime_overlays, disabled_selected_plugin_does_not_veto_runtime_overlays, earlier_plugin_wins_with_an_explicit_conflict, plugin_source, selected_plugin_source, selected_plugins_override_discovered_plugins_but_not_config, source_precedence_preserves_the_winning_registration).


##### `plugin_source`  (lines 52–54)

```
fn plugin_source(plugin_id: &str) -> McpServerSource
```

**Purpose**: Builds an expected `McpServerSource::Plugin` value for assertions. It wraps the standard `plugin` helper.

**Data flow**: Takes a plugin ID, creates `McpPluginAttribution` with `plugin`, wraps it in `McpServerSource::Plugin`, and returns the enum value.

**Call relations**: Used in conflict assertions where the exact winning or contending source must be compared.

*Call graph*: calls 1 internal fn (plugin); 1 external calls (Plugin).


##### `selected_plugin_source`  (lines 56–58)

```
fn selected_plugin_source(plugin_id: &str) -> McpServerSource
```

**Purpose**: Builds an expected `McpServerSource::SelectedPlugin` value for assertions. It mirrors `plugin_source` for the selected-plugin tier.

**Data flow**: Takes a plugin ID, creates attribution with `plugin`, wraps it in `McpServerSource::SelectedPlugin`, and returns it.

**Call relations**: Used in tests that verify selected-plugin precedence and conflict reporting.

*Call graph*: calls 1 internal fn (plugin); 1 external calls (SelectedPlugin).


##### `compatibility_source`  (lines 60–62)

```
fn compatibility_source(id: &str) -> McpServerSource
```

**Purpose**: Builds an expected compatibility source enum from an ID string. It is used to compare resolved winners and conflict outcomes.

**Data flow**: Consumes an ID string slice, clones it into a `String`, wraps it in `McpServerSource::Compatibility`, and returns the enum.

**Call relations**: Used in compatibility precedence and removal assertions.


##### `extension_source`  (lines 64–66)

```
fn extension_source(id: &str) -> McpServerSource
```

**Purpose**: Builds an expected extension source enum from an ID string. It supports exact equality assertions on resolved servers and conflicts.

**Data flow**: Consumes an ID string slice, clones it into a `String`, wraps it in `McpServerSource::Extension`, and returns the enum.

**Call relations**: Used in tests where extension registrations or removals are expected to win.


##### `register`  (lines 68–70)

```
fn register(source: McpServerSource) -> McpServerConflictAction
```

**Purpose**: Wraps a source in `McpServerConflictAction::Register` for concise conflict assertions. It avoids repeating enum constructors in expected values.

**Data flow**: Consumes an `McpServerSource`, wraps it in `McpServerConflictAction::Register`, and returns the action.

**Call relations**: Used only in expected `McpServerConflict` values inside tests.

*Call graph*: 1 external calls (Register).


##### `remove`  (lines 72–74)

```
fn remove(source: McpServerSource) -> McpServerConflictAction
```

**Purpose**: Wraps a source in `McpServerConflictAction::Remove` for concise conflict assertions. It mirrors `register` for removal outcomes.

**Data flow**: Consumes an `McpServerSource`, wraps it in `McpServerConflictAction::Remove`, and returns the action.

**Call relations**: Used in the equal-precedence compatibility removal test to express the expected winning removal action.

*Call graph*: 1 external calls (Remove).


##### `source_precedence_preserves_the_winning_registration`  (lines 77–132)

```
fn source_precedence_preserves_the_winning_registration()
```

**Purpose**: Verifies the full precedence ladder across extension, plugin, compatibility, and config registrations sharing one name. It also checks that same-tier plugin conflicts are still reported even though an extension wins overall.

**Data flow**: Builds several `docs` registrations from different sources, including two plugins with different orders and one disabled plugin config, resolves the catalog, then asserts the winning source/config, absence of plugin attribution, and an exact conflict record containing only the plugin-tier contenders.

**Call relations**: This test drives the resolver through mixed-tier winner selection and same-tier conflict grouping.

*Call graph*: calls 7 internal fn (from_compatibility, from_config, from_extension, from_plugin, builder, plugin, server); 2 external calls (assert!, assert_eq!).


##### `disabled_veto_only_disables_the_winning_registration`  (lines 135–156)

```
fn disabled_veto_only_disables_the_winning_registration()
```

**Purpose**: Checks that a disabled-name veto flips the winning registration’s `enabled` flag to false without otherwise changing the config. It confirms the veto applies after winner selection.

**Data flow**: Registers one extension server named `docs`, calls `disable("docs")`, builds the catalog, extracts the resolved config, and compares it to an expected clone with only `enabled = false` changed.

**Call relations**: This test isolates the post-resolution disable step in `McpCatalogBuilder::build`.

*Call graph*: calls 3 internal fn (from_extension, builder, server); 1 external calls (assert_eq!).


##### `disabled_winner_remains_a_veto_when_the_catalog_is_extended`  (lines 159–186)

```
fn disabled_winner_remains_a_veto_when_the_catalog_is_extended()
```

**Purpose**: Verifies that a disabled config winner persists as a name-scoped veto when the resolved catalog is converted back to a builder and extended with a later extension registration. The later winner should still be forced disabled.

**Data flow**: Builds a catalog with a disabled config registration for `docs`, converts the resolved catalog to a builder, adds an extension registration for the same name, rebuilds, and asserts that the extension now wins but its config has `enabled = false`.

**Call relations**: This test exercises the persisted disabled-name set carried through `ResolvedMcpCatalog::to_builder`.

*Call graph*: calls 4 internal fn (from_config, from_extension, builder, server); 1 external calls (assert_eq!).


##### `disabled_discovered_plugin_remains_a_veto_for_runtime_overlays`  (lines 189–218)

```
fn disabled_discovered_plugin_remains_a_veto_for_runtime_overlays()
```

**Purpose**: Checks that a disabled discovered-plugin winner also persists as a veto across later runtime extension overlays. This matches legacy disabled-name semantics for plugin registrations.

**Data flow**: Registers a disabled plugin server named `docs`, resolves and converts to a builder, adds an extension registration, rebuilds, and asserts that the extension wins but is disabled in the final resolved server.

**Call relations**: This test specifically covers the `disabled_registration_is_name_veto` policy for `Plugin` sources.

*Call graph*: calls 5 internal fn (from_extension, from_plugin, builder, plugin, server); 1 external calls (assert_eq!).


##### `earlier_plugin_wins_with_an_explicit_conflict`  (lines 221–253)

```
fn earlier_plugin_wins_with_an_explicit_conflict()
```

**Purpose**: Verifies same-tier plugin ordering and conflict reporting. Earlier plugin discovery order should win, and both plugin contenders should appear in the conflict record.

**Data flow**: Registers two plugin-owned `docs` servers with orders 0 and 1, builds the catalog, then asserts that plugin attribution points to the earlier plugin and that `catalog.conflicts()` contains a single conflict with the later plugin listed before the earlier winner due to sorted action order.

**Call relations**: This test focuses on plugin-tier `Reverse<usize>` precedence and conflict emission.

*Call graph*: calls 4 internal fn (from_plugin, builder, plugin, server); 1 external calls (assert_eq!).


##### `selected_plugins_override_discovered_plugins_but_not_config`  (lines 256–321)

```
fn selected_plugins_override_discovered_plugins_but_not_config()
```

**Purpose**: Checks two precedence relationships in sequence: selected plugins beat discovered plugins, but config beats selected plugins. It also verifies plugin attribution and selected-plugin conflict reporting.

**Data flow**: First registers one discovered plugin and two selected plugins for `docs`, builds and asserts that the earlier selected plugin wins with attribution and a selected-plugin conflict record. Then it converts the catalog to a builder, adds a config registration, rebuilds, and asserts that config becomes the winner.

**Call relations**: This test covers both selected-plugin tier ordering and its position relative to discovered plugins and config.

*Call graph*: calls 6 internal fn (from_config, from_plugin, from_selected_plugin, builder, plugin, server); 1 external calls (assert_eq!).


##### `disabled_selected_plugin_does_not_veto_runtime_overlays`  (lines 324–352)

```
fn disabled_selected_plugin_does_not_veto_runtime_overlays()
```

**Purpose**: Verifies the special rule that disabled selected-plugin winners do not persist as name-scoped vetoes. A later extension overlay should therefore remain enabled.

**Data flow**: Registers a disabled selected-plugin server for `docs`, resolves and converts to a builder, adds an extension registration, rebuilds, and asserts that the extension wins with its original enabled config unchanged.

**Call relations**: This test directly validates `McpServerSource::disabled_registration_is_name_veto` returning false for `SelectedPlugin`.

*Call graph*: calls 5 internal fn (from_extension, from_selected_plugin, builder, plugin, server); 1 external calls (assert_eq!).


##### `equal_precedence_uses_insertion_order_not_source_identity`  (lines 355–395)

```
fn equal_precedence_uses_insertion_order_not_source_identity()
```

**Purpose**: Checks that equal-precedence compatibility actions are resolved by insertion order because the builder uses a stable sort. It also verifies that a later compatibility removal can win and remove the server entirely while producing a conflict record.

**Data flow**: Registers two compatibility `docs` servers in order, builds and asserts that the second registration wins, then converts to a builder, appends a compatibility removal, rebuilds, and asserts that `server("docs")` is `None` and the conflict record lists both registrations plus the removal with the removal as outcome.

**Call relations**: This test exercises stable-sort tie-breaking and the participation of remove actions in the same precedence/conflict machinery as registrations.

*Call graph*: calls 3 internal fn (from_compatibility, builder, server); 1 external calls (assert_eq!).


### `codex-mcp/src/connection_manager_tests.rs`

`test` · `test execution`

This large test module covers several adjacent MCP subsystems through the public and crate-visible APIs exposed by `connection_manager.rs`, `codex_apps.rs`, `tools.rs`, and `elicitation.rs`. Fixture helpers create realistic `ToolInfo`, connector-tagged tools, per-user Codex Apps cache contexts, and `McpServerInfo` values. Additional helpers compute canonical model tool names, their lengths, and whether names remain code-mode compatible after normalization.

The first group of tests validates schema rewriting and elicitation policy: declared OpenAI file parameter names are treated literally, file-typed input schema fields are rewritten into absolute-path strings for model visibility, and granular approval settings correctly allow or reject MCP elicitations. The next group stresses tool-name normalization, checking duplicate suppression, sanitization of punctuation, preservation of raw MCP names for actual calls, collision disambiguation for sanitized namespaces and tool names, and legacy `mcp__` prefix behavior.

A substantial section targets Codex Apps disk caching. These tests verify overwrite semantics, per-user isolation via hashed cache paths, filtering of disallowed connector IDs on write/read, rejection of invalid JSON or schema-version mismatches, startup loading from cache with and without server-info cache files, and the independence of the newer server-info cache from legacy tools-cache versions. The manager-specific async tests then simulate pending and failed startup futures to prove that `list_all_tools` and `list_available_server_infos` use cached snapshots when available, block when no snapshot exists, and are cancelled by shutdown. The file closes with startup/runtime tests for local stdio failure behavior, elicitation capability serialization shape, and the specialized startup error messages produced by `mcp_init_error_display`.

#### Function details

##### `create_test_tool`  (lines 47–64)

```
fn create_test_tool(server_name: &str, tool_name: &str) -> ToolInfo
```

**Purpose**: Builds a minimal but valid `ToolInfo` fixture for a given server and tool name. The raw MCP tool name and the initial callable name are identical until normalization is applied by the code under test.

**Data flow**: Consumes `server_name` and `tool_name`, constructs a `ToolInfo` with default metadata fields, a `Tool::new` carrying a generated description and empty JSON object schema, and returns the struct.

**Call relations**: Used throughout the test file as the base fixture for normalization, caching, and startup-snapshot tests; `create_test_tool_with_connector` extends it.

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

**Purpose**: Adds connector metadata to a basic `ToolInfo` fixture. This is used to test Codex Apps connector filtering and naming behavior.

**Data flow**: Calls `create_test_tool`, then mutates the returned `ToolInfo` to set `connector_id` and optional `connector_name`, and returns the modified tool.

**Call relations**: Used by connector-filtering cache tests where allow-list behavior depends on `connector_id`.

*Call graph*: calls 1 internal fn (create_test_tool).


##### `create_codex_apps_tools_cache_context`  (lines 78–91)

```
fn create_codex_apps_tools_cache_context(
    codex_home: PathBuf,
    account_id: Option<&str>,
    chatgpt_user_id: Option<&str>,
) -> CodexAppsToolsCacheContext
```

**Purpose**: Constructs a `CodexAppsToolsCacheContext` with explicit user identity fields for cache-isolation tests. It avoids needing a real `CodexAuth` instance.

**Data flow**: Consumes a `PathBuf codex_home` and optional account/user IDs, builds a `CodexAppsToolsCacheKey` with those values and `is_workspace_account = false`, wraps it in `CodexAppsToolsCacheContext`, and returns it.

**Call relations**: Used by all Codex Apps cache tests to create deterministic per-user cache paths.

*Call graph*: called by 8 (codex_apps_server_info_cache_survives_legacy_tools_cache_write, codex_apps_tools_cache_filters_disallowed_connectors, codex_apps_tools_cache_is_ignored_when_json_is_invalid, codex_apps_tools_cache_is_ignored_when_schema_version_mismatches, codex_apps_tools_cache_is_overwritten_by_last_write, codex_apps_tools_cache_is_scoped_per_user, startup_cached_codex_apps_tools_loads_from_disk_cache, startup_cached_codex_apps_tools_loads_without_server_info_cache).


##### `create_test_server_info`  (lines 93–102)

```
fn create_test_server_info(title: &str) -> McpServerInfo
```

**Purpose**: Builds a simple `McpServerInfo` fixture with a configurable title. It represents cached presentation metadata for the Codex Apps server.

**Data flow**: Consumes a title string slice, fills a `McpServerInfo` with fixed name/version and optional title, and returns it.

**Call relations**: Used by startup-cache and failed-startup tests that verify server-info fallback behavior.

*Call graph*: called by 4 (codex_apps_server_info_cache_survives_legacy_tools_cache_write, list_all_tools_uses_cached_tool_info_snapshot_when_client_startup_fails, list_available_server_infos_uses_cache_while_client_is_pending, startup_cached_codex_apps_tools_loads_from_disk_cache).


##### `model_tool_names`  (lines 104–109)

```
fn model_tool_names(tools: &[ToolInfo]) -> HashSet<ToolName>
```

**Purpose**: Collects the canonical model-visible names of a tool list into a set for order-insensitive assertions. This is useful when normalization may reorder or deduplicate tools.

**Data flow**: Iterates a `&[ToolInfo]`, maps each tool through `ToolInfo::canonical_tool_name`, collects the results into `HashSet<ToolName>`, and returns it.

**Call relations**: Used by normalization tests that compare sets of resulting model-visible names.

*Call graph*: called by 2 (test_normalize_tools_disambiguates_sanitized_namespace_collisions, test_normalize_tools_long_names_same_server); 1 external calls (iter).


##### `model_tool_name_len`  (lines 111–116)

```
fn model_tool_name_len(name: &ToolName) -> usize
```

**Purpose**: Computes the total rendered length of a canonical tool name including namespace separator. It supports assertions about truncation to the 64-character limit.

**Data flow**: Reads a `ToolName`, adds namespace length plus `__` when a namespace exists, adds the name length, and returns the total `usize`.

**Call relations**: Used by long-name normalization tests to verify exact output length constraints.


##### `is_code_mode_compatible_tool_name`  (lines 118–125)

```
fn is_code_mode_compatible_tool_name(name: &ToolName) -> bool
```

**Purpose**: Checks whether every character in a canonical tool name is ASCII alphanumeric or underscore. This encodes the code-mode compatibility requirement for model-visible names.

**Data flow**: Reads the optional namespace and the name from a `ToolName`, iterates all characters across both parts, and returns `true` only if each character is alphanumeric or `_`.

**Call relations**: Used by normalization tests to assert that sanitization produced code-mode-safe names.

*Call graph*: 1 external calls (once).


##### `declared_openai_file_fields_treat_names_literally`  (lines 127–141)

```
fn declared_openai_file_fields_treat_names_literally()
```

**Purpose**: Verifies that declared OpenAI file parameter names are returned exactly as listed in metadata. No heuristic renaming or inference should occur.

**Data flow**: Builds a JSON metadata object containing `openai/fileParams`, converts it to an object reference, calls `declared_openai_file_input_param_names`, and asserts the returned vector matches the literal listed names.

**Call relations**: This test documents the contract used later by schema-rewriting logic for file parameters.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tool_with_model_visible_input_schema_masks_file_params`  (lines 144–195)

```
fn tool_with_model_visible_input_schema_masks_file_params()
```

**Purpose**: Checks that file-typed tool input schema fields are rewritten into string path parameters for model visibility. Both object and array-of-object file parameters are transformed and annotated with path guidance.

**Data flow**: Creates a test tool, mutates its `input_schema` and `meta` to declare file parameters, calls `tool_with_model_visible_input_schema`, and asserts the resulting schema object has string-based file fields with the expected descriptions.

**Call relations**: This test exercises the schema-rewriting helper used when exposing MCP tools to the model.

*Call graph*: calls 2 internal fn (create_test_tool, tool_with_model_visible_input_schema); 4 external calls (new, assert_eq!, Meta, json!).


##### `tool_with_model_visible_input_schema_leaves_tools_without_file_params_unchanged`  (lines 198–204)

```
fn tool_with_model_visible_input_schema_leaves_tools_without_file_params_unchanged()
```

**Purpose**: Verifies that tools lacking declared file parameters are returned unchanged by schema rewriting. This prevents unnecessary schema churn.

**Data flow**: Creates a basic test tool, calls `tool_with_model_visible_input_schema`, and asserts equality with the original tool.

**Call relations**: This is the no-op counterpart to the file-parameter masking test.

*Call graph*: calls 2 internal fn (create_test_tool, tool_with_model_visible_input_schema); 1 external calls (assert_eq!).


##### `elicitation_granular_policy_defaults_to_prompting`  (lines 207–226)

```
fn elicitation_granular_policy_defaults_to_prompting()
```

**Purpose**: Checks that most approval policies do not reject MCP elicitations by default, while granular policy rejects them when `mcp_elicitations` is disabled. It documents the policy matrix for elicitation handling.

**Data flow**: Calls `elicitation_is_rejected_by_policy` with several `AskForApproval` variants and asserts the expected booleans.

**Call relations**: This test targets the policy helper in `elicitation.rs` rather than the full manager flow.

*Call graph*: 1 external calls (assert!).


##### `elicitation_granular_policy_respects_never_and_config`  (lines 229–240)

```
fn elicitation_granular_policy_respects_never_and_config()
```

**Purpose**: Verifies that `AskForApproval::Never` always rejects MCP elicitations and that granular config with `mcp_elicitations: false` also rejects them. It reinforces the denial cases from the previous test.

**Data flow**: Invokes `elicitation_is_rejected_by_policy` with `Never` and a granular config disabling MCP elicitations, then asserts both results are true.

**Call relations**: Complements the broader policy-default test by focusing on explicit rejection modes.

*Call graph*: 1 external calls (assert!).


##### `disabled_permissions_auto_accept_elicitation_with_empty_form_schema`  (lines 243–273)

```
async fn disabled_permissions_auto_accept_elicitation_with_empty_form_schema()
```

**Purpose**: Checks that when permissions are disabled and approval policy is `Never`, an elicitation with an empty form schema is auto-accepted rather than surfaced. This covers the confirm/approval fast path.

**Data flow**: Creates an `ElicitationRequestManager`, builds a sender with a bounded event channel, sends a form elicitation whose schema has no properties, awaits the response, and asserts it is `ElicitationAction::Accept` with empty JSON content.

**Call relations**: This test exercises `ElicitationRequestManager::make_sender` and the internal `can_auto_accept_elicitation` logic.

*Call graph*: calls 1 internal fn (new); 4 external calls (Number, assert_eq!, bounded, builder).


##### `disabled_permissions_do_not_auto_accept_elicitation_with_requested_fields`  (lines 276–310)

```
async fn disabled_permissions_do_not_auto_accept_elicitation_with_requested_fields()
```

**Purpose**: Verifies that disabled permissions do not auto-accept form elicitations that actually request user input. Such requests are auto-declined instead.

**Data flow**: Creates an `ElicitationRequestManager`, builds a sender, sends a form elicitation whose schema requires a `message` string property, awaits the response, and asserts it is `ElicitationAction::Decline` with no content.

**Call relations**: This is the negative counterpart to the empty-schema auto-accept test.

*Call graph*: calls 1 internal fn (new); 6 external calls (Number, assert_eq!, bounded, builder, String, new).


##### `test_normalize_tools_short_non_duplicated_names`  (lines 313–329)

```
fn test_normalize_tools_short_non_duplicated_names()
```

**Purpose**: Verifies that short unique tool names from one server normalize cleanly with the legacy `mcp__` namespace prefix. No truncation or deduplication should occur.

**Data flow**: Builds two tools for `server1`, calls `normalize_tools_for_model_with_prefix` with prefixing enabled, computes canonical names, and asserts the resulting set contains the expected namespaced tool names.

**Call relations**: This test covers the straightforward normalization path.

*Call graph*: calls 1 internal fn (normalize_tools_for_model_with_prefix); 2 external calls (assert_eq!, vec!).


##### `test_normalize_tools_duplicated_names_skipped`  (lines 332–346)

```
fn test_normalize_tools_duplicated_names_skipped()
```

**Purpose**: Checks that duplicate normalized tool names from the same server are deduplicated by keeping only the first occurrence. This prevents ambiguous model-visible tool declarations.

**Data flow**: Creates two identical tools, normalizes them with prefixing enabled, and asserts that the resulting canonical-name set contains only one namespaced tool.

**Call relations**: This test documents duplicate suppression in the normalization pipeline.

*Call graph*: calls 1 internal fn (normalize_tools_for_model_with_prefix); 2 external calls (assert_eq!, vec!).


##### `test_normalize_tools_long_names_same_server`  (lines 349–380)

```
fn test_normalize_tools_long_names_same_server()
```

**Purpose**: Verifies that very long tool names are truncated or hashed into distinct 64-character model-visible names while preserving the expected namespace. It also checks code-mode compatibility.

**Data flow**: Creates two long-named tools on one server, normalizes them, asserts there are two outputs, computes canonical names and lengths, and checks that every name is exactly 64 characters, uses the expected namespace, and passes the compatibility predicate.

**Call relations**: This test targets the normalization logic’s length-limiting and collision-avoidance behavior.

*Call graph*: calls 2 internal fn (model_tool_names, normalize_tools_for_model_with_prefix); 3 external calls (assert!, assert_eq!, vec!).


##### `test_normalize_tools_sanitizes_invalid_characters`  (lines 383–411)

```
fn test_normalize_tools_sanitizes_invalid_characters()
```

**Purpose**: Checks that punctuation in server and tool names is sanitized for model-visible callable names while the raw MCP tool name remains unchanged for actual invocation. It verifies both canonical naming and retained raw metadata.

**Data flow**: Creates a tool with dots and hyphens in server/tool names, normalizes it, extracts the single result, and asserts the canonical name, callable namespace/name, raw `server_name`, and raw `tool.name` all match the expected sanitized-versus-raw split.

**Call relations**: This test documents the distinction between model-visible callable identifiers and the original MCP tool name.

*Call graph*: calls 1 internal fn (normalize_tools_for_model_with_prefix); 3 external calls (assert!, assert_eq!, vec!).


##### `test_normalize_tools_keeps_hyphenated_mcp_tools_callable`  (lines 414–429)

```
fn test_normalize_tools_keeps_hyphenated_mcp_tools_callable()
```

**Purpose**: Verifies that hyphenated MCP tool names remain callable after normalization by receiving sanitized callable identifiers. The raw MCP name is preserved separately.

**Data flow**: Creates one hyphenated tool, normalizes it, and asserts the canonical namespaced name, callable namespace/name, and raw `tool.name` fields.

**Call relations**: This is a focused regression test for hyphenated names in the normalization pipeline.

*Call graph*: calls 1 internal fn (normalize_tools_for_model_with_prefix); 2 external calls (assert_eq!, vec!).


##### `test_normalize_tools_disambiguates_sanitized_namespace_collisions`  (lines 432–460)

```
fn test_normalize_tools_disambiguates_sanitized_namespace_collisions()
```

**Purpose**: Checks that two different raw server names that sanitize to the same base namespace are disambiguated into distinct callable namespaces. This prevents cross-server collisions after sanitization.

**Data flow**: Creates one tool each for `basic-server` and `basic_server`, normalizes them, collects and deduplicates callable namespaces, asserts there are two distinct namespaces, checks the raw server-name set, and verifies all canonical names are code-mode compatible.

**Call relations**: This test targets namespace collision handling in normalization.

*Call graph*: calls 2 internal fn (model_tool_names, normalize_tools_for_model_with_prefix); 3 external calls (assert!, assert_eq!, vec!).


##### `test_normalize_tools_disambiguates_sanitized_tool_name_collisions`  (lines 463–486)

```
fn test_normalize_tools_disambiguates_sanitized_tool_name_collisions()
```

**Purpose**: Verifies that two raw tool names on the same server that sanitize to the same base name are disambiguated into distinct callable names. Raw MCP names remain preserved.

**Data flow**: Creates `tool-name` and `tool_name` on one server, normalizes them, collects raw tool names and callable names into sets, and asserts both raw names are preserved and the callable-name set has size two.

**Call relations**: This test covers tool-name collision handling after sanitization.

*Call graph*: calls 1 internal fn (normalize_tools_for_model_with_prefix); 2 external calls (assert_eq!, vec!).


##### `tool_filter_allows_by_default`  (lines 489–493)

```
fn tool_filter_allows_by_default()
```

**Purpose**: Checks that the default `ToolFilter` allows arbitrary tool names. This is the baseline behavior when no allow/deny lists are configured.

**Data flow**: Constructs `ToolFilter::default()`, calls `allows("any")`, and asserts the result is true.

**Call relations**: This test documents the default semantics of tool filtering.

*Call graph*: 2 external calls (assert!, default).


##### `tool_filter_applies_enabled_list`  (lines 496–504)

```
fn tool_filter_applies_enabled_list()
```

**Purpose**: Verifies that an enabled-list filter allows only listed tools and rejects others. The disabled set is empty in this scenario.

**Data flow**: Builds a `ToolFilter` with `enabled = Some({"allowed"})`, calls `allows` for `allowed` and `denied`, and asserts true then false.

**Call relations**: This test isolates enabled-list semantics.

*Call graph*: 3 external calls (from, new, assert!).


##### `tool_filter_applies_disabled_list`  (lines 507–515)

```
fn tool_filter_applies_disabled_list()
```

**Purpose**: Verifies that a disabled-list filter blocks listed tools while allowing others when no enabled list is present.

**Data flow**: Builds a `ToolFilter` with `disabled = {"blocked"}`, calls `allows` for `blocked` and `open`, and asserts false then true.

**Call relations**: This test isolates disabled-list semantics.

*Call graph*: 2 external calls (from, assert!).


##### `tool_filter_applies_enabled_then_disabled`  (lines 518–527)

```
fn tool_filter_applies_enabled_then_disabled()
```

**Purpose**: Checks that when both enabled and disabled lists are present, the enabled list gates the universe first and the disabled list can still remove an enabled tool. Unknown tools remain disallowed.

**Data flow**: Builds a `ToolFilter` with enabled `{keep, remove}` and disabled `{remove}`, calls `allows` for `keep`, `remove`, and `unknown`, and asserts true, false, false.

**Call relations**: This test documents precedence between enabled and disabled tool filters.

*Call graph*: 2 external calls (from, assert!).


##### `filter_tools_applies_per_server_filters`  (lines 530–553)

```
fn filter_tools_applies_per_server_filters()
```

**Purpose**: Verifies that `filter_tools` respects each server’s filter independently when tool lists are combined. Only tools allowed by their own server filter should survive.

**Data flow**: Creates tool lists for two servers, builds distinct `ToolFilter`s, filters each list separately with `filter_tools`, chains the results, and asserts that only one expected tool remains.

**Call relations**: This test covers the collection-level filtering helper used by the connection manager.

*Call graph*: calls 1 internal fn (filter_tools); 3 external calls (from, assert_eq!, vec!).


##### `codex_apps_tools_cache_is_overwritten_by_last_write`  (lines 556–575)

```
fn codex_apps_tools_cache_is_overwritten_by_last_write()
```

**Purpose**: Checks that writing the Codex Apps tools cache twice for the same user replaces the previous contents. The cache behaves as a snapshot, not an append-only log.

**Data flow**: Creates a temp home and one cache context, writes a first tool list, reads it back and asserts the first tool name, writes a second tool list, reads again, and asserts the second tool name is now present.

**Call relations**: This test exercises `write_cached_codex_apps_tools` and `read_cached_codex_apps_tools` together.

*Call graph*: calls 3 internal fn (read_cached_codex_apps_tools, write_cached_codex_apps_tools, create_codex_apps_tools_cache_context); 3 external calls (assert_eq!, tempdir, vec!).


##### `codex_apps_tools_cache_is_scoped_per_user`  (lines 578–608)

```
fn codex_apps_tools_cache_is_scoped_per_user()
```

**Purpose**: Verifies that Codex Apps tool caches are isolated per user identity. Different account/user IDs should produce different cache files and independent contents.

**Data flow**: Creates one temp home and two cache contexts with different user IDs, writes different tool lists to each, reads both back, asserts each sees its own tool, and asserts the two computed cache paths differ.

**Call relations**: This test documents the per-user hashing behavior implemented by `CodexAppsToolsCacheContext`.

*Call graph*: calls 3 internal fn (read_cached_codex_apps_tools, write_cached_codex_apps_tools, create_codex_apps_tools_cache_context); 4 external calls (assert_eq!, assert_ne!, tempdir, vec!).


##### `codex_apps_tools_cache_filters_disallowed_connectors`  (lines 611–639)

```
fn codex_apps_tools_cache_filters_disallowed_connectors()
```

**Purpose**: Checks that disallowed connector IDs are filtered out of the Codex Apps tools cache. Only allow-listed connectors should survive round-trip through disk.

**Data flow**: Creates a cache context, builds one blocked and one allowed connector tool, writes them to cache, reads the cache back, and asserts only the allowed tool remains with its connector ID intact.

**Call relations**: This test validates `filter_disallowed_codex_apps_tools` as applied by cache writing and reading.

*Call graph*: calls 3 internal fn (read_cached_codex_apps_tools, write_cached_codex_apps_tools, create_codex_apps_tools_cache_context); 3 external calls (assert_eq!, tempdir, vec!).


##### `codex_apps_tools_cache_is_ignored_when_schema_version_mismatches`  (lines 642–661)

```
fn codex_apps_tools_cache_is_ignored_when_schema_version_mismatches()
```

**Purpose**: Verifies that a tools cache file with the wrong schema version is treated as invalid and ignored. Startup should not consume stale incompatible cache formats.

**Data flow**: Creates a cache context, manually writes JSON with `schema_version` one greater than the current constant, then asserts `read_cached_codex_apps_tools` returns `None`.

**Call relations**: This test targets schema-version validation in `load_cached_codex_apps_tools`.

*Call graph*: calls 1 internal fn (create_codex_apps_tools_cache_context); 6 external calls (assert!, json!, to_vec_pretty, create_dir_all, write, tempdir).


##### `codex_apps_tools_cache_is_ignored_when_json_is_invalid`  (lines 664–678)

```
fn codex_apps_tools_cache_is_ignored_when_json_is_invalid()
```

**Purpose**: Checks that malformed JSON in the tools cache file is ignored rather than causing a crash or partial read. Invalid cache contents simply behave like a miss.

**Data flow**: Creates a cache context, ensures the parent directory exists, writes invalid bytes `{not json`, and asserts `read_cached_codex_apps_tools` returns `None`.

**Call relations**: This test covers the JSON parse-failure branch of the tools-cache loader.

*Call graph*: calls 1 internal fn (create_codex_apps_tools_cache_context); 4 external calls (assert!, create_dir_all, write, tempdir).


##### `startup_cached_codex_apps_tools_loads_from_disk_cache`  (lines 681–714)

```
fn startup_cached_codex_apps_tools_loads_from_disk_cache()
```

**Purpose**: Verifies that startup snapshot loading returns both cached tools and cached server info when both were written through the normal helper. This is the happy path for startup cache reuse.

**Data flow**: Creates a cache context, a cached tool list, and server info, writes them with `write_cached_codex_apps_tools_if_needed`, then calls both startup cache loaders and asserts the tool list and server info are returned as expected.

**Call relations**: This test exercises the integrated write/read path for both Codex Apps cache files.

*Call graph*: calls 5 internal fn (load_startup_cached_codex_apps_server_info, load_startup_cached_codex_apps_tools_snapshot, write_cached_codex_apps_tools_if_needed, create_codex_apps_tools_cache_context, create_test_server_info); 3 external calls (assert_eq!, tempdir, vec!).


##### `startup_cached_codex_apps_tools_loads_without_server_info_cache`  (lines 717–748)

```
fn startup_cached_codex_apps_tools_loads_without_server_info_cache()
```

**Purpose**: Checks backward compatibility with legacy setups where only the tools cache exists. Startup should still load tools even if no server-info cache file is present.

**Data flow**: Creates a cache context, manually writes a valid tools-cache JSON file, calls both startup loaders, and asserts tools are returned while server info is `None`.

**Call relations**: This test documents that server-info caching is optional and independent of tools-cache availability.

*Call graph*: calls 3 internal fn (load_startup_cached_codex_apps_server_info, load_startup_cached_codex_apps_tools_snapshot, create_codex_apps_tools_cache_context); 6 external calls (assert_eq!, json!, to_vec_pretty, create_dir_all, write, tempdir).


##### `codex_apps_server_info_cache_survives_legacy_tools_cache_write`  (lines 751–794)

```
fn codex_apps_server_info_cache_survives_legacy_tools_cache_write()
```

**Purpose**: Verifies that a valid server-info cache remains usable even if the tools cache is later overwritten with an older incompatible schema version. The two caches are versioned independently.

**Data flow**: Creates a cache context and server info, writes both caches normally, then manually overwrites the tools cache with a legacy schema version, and finally asserts that startup server-info loading still succeeds while startup tools loading returns `None`.

**Call relations**: This test targets the design choice to separate server-info cache validity from tools-cache validity.

*Call graph*: calls 4 internal fn (write_cached_codex_apps_tools_if_needed, create_codex_apps_tools_cache_context, create_test_server_info, create_test_tool); 7 external calls (assert!, assert_eq!, json!, to_vec_pretty, create_dir_all, write, tempdir).


##### `list_all_tools_uses_cached_tool_info_snapshot_while_client_is_pending`  (lines 797–834)

```
async fn list_all_tools_uses_cached_tool_info_snapshot_while_client_is_pending()
```

**Purpose**: Checks that `list_all_tools` returns cached startup tools immediately when a client’s startup future is still pending. This avoids blocking tool discovery during startup.

**Data flow**: Builds a pending shared future for `ManagedClient`, creates an uninitialized manager, inserts an `AsyncManagedClient` with a cached tool snapshot and `startup_complete = false`, calls `list_all_tools().await`, and asserts the expected normalized tool is present.

**Call relations**: This test exercises the interaction between `McpConnectionManager::list_all_tools` and `AsyncManagedClient::listed_tools` fallback behavior.

*Call graph*: calls 3 internal fn (new_uninitialized, allow_any, default); 6 external calls (new, new, assert_eq!, default, new, vec!).


##### `list_available_server_infos_uses_cache_while_client_is_pending`  (lines 837–871)

```
async fn list_available_server_infos_uses_cache_while_client_is_pending()
```

**Purpose**: Verifies that `list_available_server_infos` does not block on pending startup when cached server info exists. It should return promptly with the cached metadata.

**Data flow**: Creates a pending client future, an uninitialized manager, inserts an async client with empty cached tools but populated cached server info and `startup_complete = false`, wraps `list_available_server_infos()` in a short timeout, and asserts the returned map contains the cached server info.

**Call relations**: This test directly targets the non-blocking cache path in `McpConnectionManager::list_available_server_infos`.

*Call graph*: calls 4 internal fn (new_uninitialized, create_test_server_info, allow_any, default); 8 external calls (new, new, from_millis, new, assert_eq!, default, new, timeout).


##### `list_all_tools_accepts_canonical_namespaced_tool_names`  (lines 874–914)

```
async fn list_all_tools_accepts_canonical_namespaced_tool_names()
```

**Purpose**: Checks that when legacy prefixing is disabled, normalized tools can use the server name itself as the canonical namespace. The split namespace/name form should still resolve correctly.

**Data flow**: Creates a pending client with one cached tool on server `rmcp`, builds an uninitialized manager with `prefix_mcp_tool_names = false`, inserts the client, calls `list_all_tools`, finds the tool by canonical namespaced name `rmcp::echo`, and asserts the raw and callable fields match the expected unprefixed values.

**Call relations**: This test documents the non-legacy naming mode of tool normalization as surfaced through the manager.

*Call graph*: calls 3 internal fn (new_uninitialized, allow_any, default); 6 external calls (new, new, assert_eq!, default, new, vec!).


##### `list_all_tools_applies_legacy_mcp_prefix_by_default`  (lines 917–957)

```
async fn list_all_tools_applies_legacy_mcp_prefix_by_default()
```

**Purpose**: Verifies that with prefixing enabled, manager tool listing applies the legacy `mcp__` namespace prefix. This preserves backward-compatible model-visible names.

**Data flow**: Creates a pending client with one cached tool, builds an uninitialized manager with prefixing enabled, inserts the client, calls `list_all_tools`, finds the tool by canonical name `mcp__rmcp::echo`, and asserts the callable namespace includes the prefix while the raw MCP tool name remains `echo`.

**Call relations**: This is the manager-level counterpart to lower-level normalization tests for legacy prefix behavior.

*Call graph*: calls 3 internal fn (new_uninitialized, allow_any, default); 6 external calls (new, new, assert_eq!, default, new, vec!).


##### `list_all_tools_blocks_while_client_is_pending_without_cached_tool_info_snapshot`  (lines 960–986)

```
async fn list_all_tools_blocks_while_client_is_pending_without_cached_tool_info_snapshot()
```

**Purpose**: Checks that `list_all_tools` really waits for startup when no cached tool snapshot exists. This distinguishes a true cache miss from the non-blocking cached path.

**Data flow**: Creates a pending client with `cached_tool_info_snapshot = None`, inserts it into an uninitialized manager, wraps `list_all_tools()` in a short timeout, and asserts the timeout expires.

**Call relations**: This test documents the blocking behavior expected when no startup snapshot is available.

*Call graph*: calls 3 internal fn (new_uninitialized, allow_any, default); 7 external calls (new, new, from_millis, assert!, default, new, timeout).


##### `shutdown_cancels_pending_tool_listing`  (lines 989–1028)

```
async fn shutdown_cancels_pending_tool_listing()
```

**Purpose**: Verifies that manager shutdown cancels a pending startup/tool-listing path and allows `list_all_tools` to complete rather than hanging forever. It tests cancellation propagation through the async client future.

**Data flow**: Creates a cancellation token and a pending client future that waits for cancellation, inserts that client into an uninitialized manager wrapped in `Arc`, spawns `list_all_tools`, waits until startup begins, calls `manager.shutdown()` under a timeout, awaits the listing task, and asserts the resulting tool list is empty.

**Call relations**: This test exercises `McpConnectionManager::shutdown` together with pending client startup and tool listing.

*Call graph*: calls 3 internal fn (new_uninitialized, allow_any, default); 10 external calls (clone, new, new, from_secs, assert!, default, new, spawn, channel, timeout).


##### `list_all_tools_does_not_block_when_cached_tool_info_snapshot_is_empty`  (lines 1031–1058)

```
async fn list_all_tools_does_not_block_when_cached_tool_info_snapshot_is_empty()
```

**Purpose**: Checks that an explicitly empty cached tool snapshot is still treated as a cache hit and does not block tool listing. Empty means ‘known empty’, not ‘unknown’.

**Data flow**: Creates a pending client with `cached_tool_info_snapshot = Some(Vec::new())`, inserts it into an uninitialized manager, wraps `list_all_tools()` in a short timeout, and asserts it returns promptly with an empty vector.

**Call relations**: This test distinguishes empty cached snapshots from absent snapshots in the manager’s listing behavior.

*Call graph*: calls 3 internal fn (new_uninitialized, allow_any, default); 8 external calls (new, new, from_millis, new, assert!, default, new, timeout).


##### `list_all_tools_uses_cached_tool_info_snapshot_when_client_startup_fails`  (lines 1061–1111)

```
async fn list_all_tools_uses_cached_tool_info_snapshot_when_client_startup_fails()
```

**Purpose**: Verifies that cached startup tools and cached server info are still used after startup has completed with failure. Failed live startup should not erase useful cached presentation data.

**Data flow**: Creates a ready failed client future, an uninitialized manager, inserts an async client with cached tools, cached server info, and `startup_complete = true`, calls `list_all_tools` and `list_available_server_infos`, and asserts both return the cached data.

**Call relations**: This test covers the failed-startup fallback branches in both tool and server-info listing.

*Call graph*: calls 4 internal fn (new_uninitialized, create_test_server_info, allow_any, default); 6 external calls (new, new, assert_eq!, default, new, vec!).


##### `list_all_tools_adds_server_metadata_to_cached_tools`  (lines 1114–1157)

```
async fn list_all_tools_adds_server_metadata_to_cached_tools()
```

**Purpose**: Checks that cached startup tools are still enriched with server metadata such as origin and parallel-call support. Metadata attachment should not depend on live startup success.

**Data flow**: Creates an uninitialized manager, inserts explicit `McpServerMetadata` for server `docs`, inserts a pending async client with cached tools, calls `list_all_tools`, and asserts the returned tool carries the expected `supports_parallel_tool_calls` and `server_origin` values.

**Call relations**: This test targets `McpConnectionManager::with_server_metadata` as applied to cached tool snapshots.

*Call graph*: calls 3 internal fn (new_uninitialized, allow_any, default); 9 external calls (new, new, new, assert!, assert_eq!, default, StreamableHttp, new, vec!).


##### `server_metadata_preserves_tool_approval_policy`  (lines 1160–1179)

```
fn server_metadata_preserves_tool_approval_policy()
```

**Purpose**: Verifies that `McpServerMetadata::from` preserves both default and per-tool approval modes from an effective server config. Tool-specific overrides should win over the default mode.

**Data flow**: Builds a Codex Apps MCP server config, sets a default approval mode and a `search`-specific override, converts it into `McpServerMetadata`, and asserts the approval mode for `read` uses the default while `search` uses the override.

**Call relations**: This test covers metadata extraction used later by `McpConnectionManager::tool_approval_mode`.

*Call graph*: calls 2 internal fn (configured, from); 2 external calls (assert_eq!, codex_apps_mcp_server_config).


##### `no_local_runtime_fails_local_stdio_but_keeps_local_http_server`  (lines 1182–1293)

```
async fn no_local_runtime_fails_local_stdio_but_keeps_local_http_server()
```

**Purpose**: Checks startup behavior when no local runtime environment is available: local stdio MCP startup should fail, but a local HTTP server entry should still be present in the manager. It also verifies the exact startup error message for the stdio case.

**Data flow**: Builds two effective servers (`stdio` and `http`), constructs a real `McpConnectionManager::new` with an environment manager lacking environments, asserts both clients are present, waits briefly for `stdio` readiness and expects false, awaits the stdio client startup result and asserts it is an error whose message from `startup_outcome_error_message` matches the expected local-runtime failure, then cancels the startup token.

**Call relations**: This is an integration-style test of `McpConnectionManager::new`, startup futures, and startup error formatting.

*Call graph*: calls 7 internal fn (new, new, configured, allow_any, default, without_environments, default); 15 external calls (new, new, default, from, new, from, new, new, assert!, assert_eq! (+5 more)).


##### `elicitation_capability_uses_2025_06_18_shape_for_form_only_support`  (lines 1296–1302)

```
fn elicitation_capability_uses_2025_06_18_shape_for_form_only_support()
```

**Purpose**: Verifies the serialized JSON shape of the default elicitation capability when only form elicitation is supported. The expected shape is an empty object rather than an explicit `form` field.

**Data flow**: Wraps `ElicitationCapability::default()` in `Some`, serializes it with `serde_json::to_value`, and asserts the result equals `{}`.

**Call relations**: This test documents protocol-shape compatibility for capability advertisement.

*Call graph*: 2 external calls (default, assert_eq!).


##### `elicitation_capability_advertises_url_support_when_enabled`  (lines 1305–1317)

```
fn elicitation_capability_advertises_url_support_when_enabled()
```

**Purpose**: Checks that enabling URL elicitation support adds both `form` and `url` objects to the serialized capability. This distinguishes explicit URL support from the default form-only shape.

**Data flow**: Constructs an `ElicitationCapability` with default form and URL capabilities, serializes it to JSON, and asserts the result equals `{ "form": {}, "url": {} }`.

**Call relations**: This test complements the default-shape capability serialization test.

*Call graph*: 3 external calls (assert_eq!, default, default).


##### `mcp_init_error_display_prompts_for_github_pat`  (lines 1320–1356)

```
fn mcp_init_error_display_prompts_for_github_pat()
```

**Purpose**: Verifies the special startup error message shown for GitHub Copilot MCP when OAuth is unsupported and no bearer token is configured. The message should instruct the user to configure a personal access token.

**Data flow**: Builds an `McpAuthStatusEntry` whose transport matches the GitHub MCP URL with no bearer token or headers, converts an `anyhow!` error into `StartupOutcomeError`, calls `mcp_init_error_display`, formats the expected PAT guidance string, and asserts equality.

**Call relations**: This test targets the first special-case branch in `mcp_init_error_display`.

*Call graph*: 4 external calls (new, anyhow!, assert_eq!, format!).


##### `mcp_init_error_display_prompts_for_login_when_auth_required`  (lines 1359–1370)

```
fn mcp_init_error_display_prompts_for_login_when_auth_required()
```

**Purpose**: Checks that startup errors containing `Auth required` are rewritten into a `codex mcp login` hint. This gives users an actionable remediation path.

**Data flow**: Creates a startup error from `anyhow!("Auth required for server")`, calls `mcp_init_error_display` with no auth entry, formats the expected login message, and asserts equality.

**Call relations**: This test covers the auth-required branch in `mcp_init_error_display`.

*Call graph*: 3 external calls (anyhow!, assert_eq!, format!).


##### `mcp_init_error_display_reports_generic_errors`  (lines 1373–1407)

```
fn mcp_init_error_display_reports_generic_errors()
```

**Purpose**: Verifies that startup failures not matching any special case are rendered as generic formatted errors. Existing bearer-token configuration should suppress the GitHub PAT special case.

**Data flow**: Builds an auth entry with a generic HTTPS transport and bearer token env var, creates a `boom` startup error, calls `mcp_init_error_display`, formats the expected generic message, and asserts equality.

**Call relations**: This test covers the fallback branch of startup error formatting.

*Call graph*: 4 external calls (new, anyhow!, assert_eq!, format!).


##### `mcp_init_error_display_includes_startup_timeout_hint`  (lines 1410–1420)

```
fn mcp_init_error_display_includes_startup_timeout_hint()
```

**Purpose**: Checks that timeout-like startup errors produce a configuration hint mentioning `startup_timeout_sec` and the default timeout value. This helps users remediate slow server startup.

**Data flow**: Creates a startup error from `anyhow!("request timed out")`, calls `mcp_init_error_display` with no auth entry, and asserts the returned string matches the expected timeout guidance using the default 30-second timeout.

**Call relations**: This test covers the timeout-detection branch in `mcp_init_error_display`.

*Call graph*: 2 external calls (anyhow!, assert_eq!).


### `ext/mcp/tests/executor_plugin_mcp.rs`

`test` · `test execution`

This test exercises the full extension registration path for executor-plugin MCP discovery. It defines a compact `ContributionSummary` struct so assertions can focus on the externally visible fields of `McpServerContribution::SelectedPlugin`: server name, selected plugin ID, display name, selection order, and whether the resulting config is enabled.

The main test creates a temporary Codex home and plugin root, writes a minimal `.codex-plugin/plugin.json` whose manifest display name is `Selected Demo`, and writes a `.mcp.json` declaring three stdio servers: `allowed`, `mismatched`, and `unlisted`. It then builds a `Config` whose cloud bundle contains MCP server requirements under `plugins."selected-root"`, intentionally matching by selected root ID rather than manifest name. One requirement matches the declared command for `allowed`; another intentionally mismatches `mismatched`; `unlisted` has no requirement. The expected result proves that the contributor keeps all three servers but marks only the matching one enabled.

`selected_plugin_contributions()` performs the integration setup: it builds an extension registry, installs the executor-plugin contributor with a test `EnvironmentManager`, seeds thread data with a single `SelectedCapabilityRoot` pointing at the plugin root in the local environment, initializes the contributor’s thread state, invokes `contribute()` for that thread, and maps each selected-plugin contribution into `ContributionSummary`. Any non-selected-plugin contribution is treated as a test failure.

#### Function details

##### `selected_plugin_servers_use_managed_requirements_for_the_selected_root_id`  (lines 27–91)

```
async fn selected_plugin_servers_use_managed_requirements_for_the_selected_root_id() -> TestResult
```

**Purpose**: Verifies that selected executor plugin MCP servers are filtered/enabled according to managed requirements keyed by the selected root ID, not by manifest name.

**Data flow**: It creates temporary directories, writes plugin manifest and `.mcp.json` files under the plugin root, builds a `Config` with enterprise requirements for `plugins."selected-root".mcp_servers`, and awaits `selected_plugin_contributions(&config, plugin_root.path())`. It then asserts that the returned summaries contain three servers with plugin metadata from the selected plugin and enabled flags of `true` for `allowed` and `false` for `mismatched` and `unlisted`.

**Call relations**: This top-level integration test delegates all registry and contribution setup to `selected_plugin_contributions()` and focuses on the final externally visible contribution set.

*Call graph*: calls 2 internal fn (loader_with_enterprise_requirement, selected_plugin_contributions); 5 external calls (assert_eq!, default, create_dir_all, write, tempdir).


##### `selected_plugin_contributions`  (lines 93–139)

```
async fn selected_plugin_contributions(
    config: &Config,
    plugin_root: &std::path::Path,
) -> Vec<ContributionSummary>
```

**Purpose**: Builds a minimal extension/runtime context for one selected plugin and returns simplified summaries of the resulting MCP contributions.

**Data flow**: It takes a `Config` and plugin-root path, creates an `ExtensionRegistryBuilder`, installs executor-plugin MCP support with `install_executor_plugins(...)` using `EnvironmentManager::default_for_tests()`, and builds the registry. It then creates `ExtensionDataInit`, inserts a one-element `Vec<SelectedCapabilityRoot>` pointing at the local environment and provided plugin path, calls `initialize_executor_plugin_thread_data(&mut thread_init)`, and invokes the first registered contributor with `McpServerContributionContext::for_thread(config, &thread_init)`. The returned contributions are awaited, converted into an iterator, and mapped: `SelectedPlugin` entries become `ContributionSummary`, while `Set` or `Remove` cause a panic. The collected summaries are returned.

**Call relations**: This helper is called by the main test and exercises the public installation and thread-initialization hooks from `ext/mcp/src/lib.rs` plus the contributor implementation behind them.

*Call graph*: calls 4 internal fn (default_for_tests, for_thread, new, new); called by 1 (selected_plugin_servers_use_managed_requirements_for_the_selected_root_id); 4 external calls (new, initialize_executor_plugin_thread_data, install_executor_plugins, vec!).


### `ext/mcp/tests/hosted_apps_mcp.rs`

`test` · `test execution`

This integration test module covers the reserved `codex_apps` MCP server from several angles. The helper `installed_manager()` constructs an `McpManager` with the MCP extension installed, while `RemoveCodexApps` is a tiny test contributor that always emits `McpServerContribution::Remove` for the reserved server name.

The tests show the intended layering. With the extension installed and Apps enabled, `contributes_hosted_plugin_runtime_without_an_executor` confirms that `effective_servers()` contains a configured `StreamableHttp` server at `https://chatgpt.com/backend-api/ps/mcp`, proving the hosted runtime can be contributed without any executor plugin. `runtime_overlay_preserves_disabled_server` demonstrates that if config explicitly disables `mcp_servers.codex_apps`, the extension still contributes the server but the disabled state survives overlaying. `legacy_fallback_overwrites_reserved_config_without_an_extension` constructs a plain `McpManager` without extensions and shows the older fallback path still injects the reserved server, but at the legacy `/backend-api/wham/apps` URL. `later_extension_can_remove_same_name_registration` proves contributor ordering matters: a later `Remove` contribution can delete the hosted runtime registration. `hosted_apps_mcp_requires_chatgpt_auth` verifies that API-key auth is insufficient for this server, and `disabled_apps_remove_reserved_server_config_for_all_hosts` checks that disabling the Apps feature removes the reserved server both with the extension-installed manager and with the legacy fallback manager.

#### Function details

##### `contributes_hosted_plugin_runtime_without_an_executor`  (lines 19–44)

```
async fn contributes_hosted_plugin_runtime_without_an_executor() -> TestResult
```

**Purpose**: Checks that installing the MCP extension contributes the hosted Apps runtime server even when no executor is involved, and that it uses the new hosted runtime URL.

**Data flow**: It creates a temporary Codex home, builds a `Config` with `features.apps = true` and `chatgpt_base_url = https://chatgpt.com`, creates dummy ChatGPT auth, and obtains an extension-installed manager via `installed_manager(&config)`. It awaits `manager.effective_servers(&config, Some(&auth))`, looks up `CODEX_APPS_MCP_SERVER_NAME`, extracts its configured config, pattern-matches the transport as `StreamableHttp`, and asserts that the URL is `https://chatgpt.com/backend-api/ps/mcp`.

**Call relations**: This test uses `installed_manager()` to exercise the extension path implemented by `HostedPluginRuntimeExtension::contribute`.

*Call graph*: calls 2 internal fn (installed_manager, create_dummy_chatgpt_auth_for_testing); 5 external calls (assert_eq!, default, panic!, tempdir, vec!).


##### `runtime_overlay_preserves_disabled_server`  (lines 47–72)

```
async fn runtime_overlay_preserves_disabled_server() -> TestResult
```

**Purpose**: Verifies that when the reserved Apps MCP server is explicitly configured but disabled, the extension overlay keeps it present yet disabled.

**Data flow**: It builds a config with Apps enabled, an explicit `mcp_servers.codex_apps.url`, and `mcp_servers.codex_apps.enabled = false`, creates dummy ChatGPT auth, and gets an extension-installed manager. After awaiting `effective_servers`, it retrieves the reserved server and asserts `!server.enabled()`.

**Call relations**: This test checks the interaction between extension-contributed runtime config and user-configured disabled state in the MCP manager.

*Call graph*: calls 2 internal fn (installed_manager, create_dummy_chatgpt_auth_for_testing); 4 external calls (assert!, default, tempdir, vec!).


##### `legacy_fallback_overwrites_reserved_config_without_an_extension`  (lines 75–105)

```
async fn legacy_fallback_overwrites_reserved_config_without_an_extension() -> TestResult
```

**Purpose**: Confirms the behavior of the MCP manager when the extension is absent: the legacy reserved Apps fallback still appears and uses the older endpoint.

**Data flow**: It builds a config with Apps enabled and an explicit reserved-server URL override, creates dummy ChatGPT auth, and constructs a plain `McpManager::new(...)` with a `PluginsManager` but no extension registry. It awaits `effective_servers`, retrieves the reserved server’s configured config, pattern-matches `StreamableHttp`, and asserts that the URL is `https://chatgpt.com/backend-api/wham/apps`.

**Call relations**: This test intentionally bypasses `installed_manager()` to compare extension-managed behavior against the manager’s legacy fallback path.

*Call graph*: calls 3 internal fn (new, new, create_dummy_chatgpt_auth_for_testing); 6 external calls (new, assert_eq!, default, panic!, tempdir, vec!).


##### `later_extension_can_remove_same_name_registration`  (lines 108–129)

```
async fn later_extension_can_remove_same_name_registration() -> TestResult
```

**Purpose**: Shows that a later MCP contributor can remove the same reserved server name contributed earlier by the hosted Apps extension.

**Data flow**: It builds a config with Apps enabled, creates dummy ChatGPT auth, constructs an `ExtensionRegistryBuilder`, installs the MCP extension, then registers `RemoveCodexApps` afterward. It builds an `McpManager::new_with_extensions(...)`, awaits `effective_servers`, and asserts that the resulting map does not contain `CODEX_APPS_MCP_SERVER_NAME`.

**Call relations**: This test exercises contributor ordering and the semantics of `McpServerContribution::Remove`, using the local `RemoveCodexApps` contributor to override the extension-installed hosted runtime.

*Call graph*: calls 4 internal fn (new, new_with_extensions, new, create_dummy_chatgpt_auth_for_testing); 6 external calls (new, assert!, install, default, tempdir, vec!).


##### `hosted_apps_mcp_requires_chatgpt_auth`  (lines 132–147)

```
async fn hosted_apps_mcp_requires_chatgpt_auth() -> TestResult
```

**Purpose**: Verifies that the hosted Apps MCP server is not exposed when the session uses API-key auth instead of ChatGPT auth.

**Data flow**: It builds a config with Apps enabled, creates `CodexAuth::from_api_key("test")`, obtains an extension-installed manager, awaits `effective_servers`, and asserts that the reserved server name is absent from the resulting map.

**Call relations**: This test checks auth gating in the broader MCP manager path while using `installed_manager()` to ensure the hosted Apps extension is present.

*Call graph*: calls 2 internal fn (installed_manager, from_api_key); 4 external calls (assert!, default, tempdir, vec!).


##### `disabled_apps_remove_reserved_server_config_for_all_hosts`  (lines 150–175)

```
async fn disabled_apps_remove_reserved_server_config_for_all_hosts() -> TestResult
```

**Purpose**: Ensures that disabling the Apps feature removes the reserved Apps MCP server regardless of whether the extension-managed path or legacy fallback path is used.

**Data flow**: It builds a config with `features.apps = false` and an explicit reserved-server URL, then creates two managers: one from `installed_manager(&config)` and one plain `McpManager::new(...)`. For each manager it awaits `runtime_servers(&config)` and asserts that the reserved server name is absent.

**Call relations**: This test compares both host configurations side by side to prove that feature disabling consistently strips the reserved server.

*Call graph*: calls 3 internal fn (new, new, installed_manager); 5 external calls (new, assert!, default, tempdir, vec!).


##### `installed_manager`  (lines 177–184)

```
fn installed_manager(config: &Config) -> McpManager
```

**Purpose**: Constructs an `McpManager` configured with the MCP extension installed.

**Data flow**: It takes a `Config`, creates an `ExtensionRegistryBuilder`, calls `codex_mcp_extension::install(&mut builder)`, builds the registry, constructs a `PluginsManager` rooted at `config.codex_home`, and returns `McpManager::new_with_extensions(...)` using both.

**Call relations**: This helper is used by multiple tests to exercise the extension-managed hosted Apps MCP path without repeating setup.

*Call graph*: calls 3 internal fn (new, new_with_extensions, new); called by 4 (contributes_hosted_plugin_runtime_without_an_executor, disabled_apps_remove_reserved_server_config_for_all_hosts, hosted_apps_mcp_requires_chatgpt_auth, runtime_overlay_preserves_disabled_server); 2 external calls (new, install).


##### `RemoveCodexApps::id`  (lines 189–191)

```
fn id(&self) -> &'static str
```

**Purpose**: Returns the identifier for the test contributor that removes the reserved Apps MCP server.

**Data flow**: It returns the static string `"remove_codex_apps"`.

**Call relations**: The extension framework uses this ID when registering the test contributor in `later_extension_can_remove_same_name_registration`.


##### `RemoveCodexApps::contribute`  (lines 193–202)

```
fn contribute(
        &'a self,
        _context: McpServerContributionContext<'a, Config>,
    ) -> codex_extension_api::ExtensionFuture<'a, Vec<McpServerContribution>>
```

**Purpose**: Always contributes a removal for the reserved Apps MCP server name.

**Data flow**: It ignores the incoming `McpServerContributionContext`, boxes an async block, and returns a one-element vector containing `McpServerContribution::Remove { name: CODEX_APPS_MCP_SERVER_NAME.to_string() }`.

**Call relations**: This contributor is registered after the hosted Apps extension in one test to prove that later contributors can remove earlier same-name registrations.

*Call graph*: 2 external calls (pin, vec!).


### `core/tests/suite/rmcp_client.rs`

`test` · `request handling`

This is the largest MCP integration test file in the suite. It mixes reusable helpers, small support structs, and many end-to-end tests that drive Codex through mock Responses API streams into real MCP test servers. The helper layer does most of the heavy lifting: wall-time wrappers are validated by `assert_wall_time_line`, `split_wall_time_wrapped_output`, and `assert_wall_time_header`; user-turn constructors (`read_only_user_turn`, `auto_approved_user_turn`, `user_turn_with_permission_profile`) build `Op::UserInput` values with explicit sandbox, approval, and collaboration-mode settings; MCP server config helpers (`stdio_transport*`, `insert_mcp_server`) inject `McpServerConfig` entries into `Config`; and remote-aware helpers copy host-built binaries into Docker when tests run against a remote executor.

The file then exercises concrete behaviors: stdio MCP round trips, cwd precedence, sandbox metadata injection, serial versus parallel tool scheduling, image content conversion and resizing, sanitization for text-only models, and environment-variable propagation rules. A second cluster covers Streamable HTTP MCP servers, including local and remote startup probing, OAuth metadata discovery, fallback credential seeding in `CODEX_HOME`, and authenticated tool calls. Support types like `TestMcpServerOptions`, `EnvVarGuard`, `StreamableHttpTestServer`, and `RemoteStreamableHttpServer` exist purely to make those scenarios deterministic and self-cleaning. Across all tests, the common pattern is to script model tool calls with mock SSE, wait for `McpToolCallBegin`/`End` and `TurnComplete`, then inspect both Codex events and the exact function-call-output payload sent back to the model.

#### Function details

##### `assert_wall_time_line`  (lines 81–83)

```
fn assert_wall_time_line(line: &str)
```

**Purpose**: Asserts that a line matches the standardized MCP wall-time prefix format.

**Data flow**: It takes a `&str` line and checks it against the regex `^Wall time: [0-9]+(?:\.[0-9]+)? seconds$`. It returns no value and fails the test if the line does not match.

**Call relations**: This helper is called by both wall-time parsing helpers before they inspect the remainder of the payload. It centralizes the exact textual contract expected around MCP tool outputs.

*Call graph*: called by 2 (assert_wall_time_header, split_wall_time_wrapped_output); 1 external calls (assert_regex_match).


##### `split_wall_time_wrapped_output`  (lines 85–92)

```
fn split_wall_time_wrapped_output(output: &str) -> &str
```

**Purpose**: Strips the wall-time header and `Output:` marker from a wrapped MCP string payload, returning only the embedded output body.

**Data flow**: It splits the input string at the first newline into a wall-time line and the rest, validates the wall-time line with `assert_wall_time_line`, then removes the `Output:\n` prefix from the remainder and returns the trailing substring.

**Call relations**: Many MCP tests call this after reading `function_call_output` text from the follow-up Responses request. It is the standard decoder for string-wrapped structured MCP outputs.

*Call graph*: calls 1 internal fn (assert_wall_time_line); called by 6 (stdio_image_responses_are_sanitized_for_text_only_model, stdio_mcp_parallel_tool_calls_default_false_runs_serially, stdio_mcp_parallel_tool_calls_opt_in_runs_concurrently, stdio_mcp_read_only_tool_calls_run_concurrently_without_server_opt_in, stdio_mcp_tool_call_includes_sandbox_state_meta, stdio_server_round_trip).


##### `assert_wall_time_header`  (lines 94–100)

```
fn assert_wall_time_header(output: &str)
```

**Purpose**: Checks the special case where an MCP output item contains only the wall-time line followed by the literal `Output:` marker.

**Data flow**: It splits the string at the first newline, validates the first line with `assert_wall_time_line`, and asserts the second line equals `Output:` exactly.

**Call relations**: Image-output tests use this helper because image MCP outputs are represented as an array whose first item is just the wall-time header and whose second item is the image content block.

*Call graph*: calls 1 internal fn (assert_wall_time_line); called by 2 (stdio_image_responses_preserve_original_detail_metadata, stdio_image_responses_round_trip); 1 external calls (assert_eq!).


##### `read_only_user_turn`  (lines 102–104)

```
fn read_only_user_turn(fixture: &TestCodex, text: impl Into<String>) -> Op
```

**Purpose**: Builds a user-input operation for the fixture's current model under a read-only permission profile.

**Data flow**: It takes a `&TestCodex` and text, reads `fixture.session_configured.model`, and forwards both to `read_only_user_turn_with_model`, returning the resulting `Op`.

**Call relations**: Most MCP tests use this helper when they want tool execution to be allowed but constrained to read-only semantics. It is a convenience wrapper over the more general model-selecting helper.

*Call graph*: calls 1 internal fn (read_only_user_turn_with_model); called by 11 (call_cwd_tool, remote_stdio_env_var_source_does_not_copy_local_env, stdio_image_responses_preserve_original_detail_metadata, stdio_image_responses_resize_large_image, stdio_image_responses_round_trip, stdio_mcp_read_only_tool_calls_run_concurrently_without_server_opt_in, stdio_server_propagates_explicit_local_env_var_source, stdio_server_propagates_whitelisted_env_vars, stdio_server_round_trip, streamable_http_tool_call_round_trip (+1 more)).


##### `read_only_user_turn_with_model`  (lines 106–112)

```
fn read_only_user_turn_with_model(
    fixture: &TestCodex,
    text: impl Into<String>,
    model: String,
) -> Op
```

**Purpose**: Builds a read-only user-input operation targeting an explicit model slug.

**Data flow**: It accepts a fixture, text, and model string, obtains `PermissionProfile::read_only()`, and forwards everything to `user_turn_with_permission_profile`, returning the constructed `Op::UserInput`.

**Call relations**: This helper is used by `read_only_user_turn` and by the text-only-model image sanitization test, where the turn must explicitly target a model different from the fixture default.

*Call graph*: calls 2 internal fn (user_turn_with_permission_profile, read_only); called by 2 (read_only_user_turn, stdio_image_responses_are_sanitized_for_text_only_model).


##### `auto_approved_user_turn`  (lines 114–121)

```
fn auto_approved_user_turn(fixture: &TestCodex, text: impl Into<String>) -> Op
```

**Purpose**: Builds a user-input operation that disables approval prompts entirely, useful for mutable-tool scheduling tests.

**Data flow**: It takes a fixture and text, reads the fixture's current model, passes `PermissionProfile::Disabled` into `user_turn_with_permission_profile`, and returns the resulting `Op`.

**Call relations**: The mutable sync-tool concurrency tests use this helper so approval gating does not interfere with assertions about serial versus parallel scheduling.

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

**Purpose**: Constructs a fully populated `Op::UserInput` with explicit sandbox, approval, permission-profile, and collaboration-mode overrides.

**Data flow**: It reads `fixture.config.cwd`, derives `(sandbox_policy, permission_profile)` via `turn_permission_fields`, then returns `Op::UserInput` containing one `UserInput::Text` item, default additional context, and `ThreadSettingsOverrides` with `approval_policy = Never`, the derived sandbox and permission profile, and a `CollaborationMode` whose settings include the supplied model.

**Call relations**: This is the common turn-construction primitive behind the read-only and auto-approved wrappers. Tests use those wrappers to ensure each MCP invocation runs under a precisely controlled permission context.

*Call graph*: calls 1 internal fn (turn_permission_fields); called by 2 (auto_approved_user_turn, read_only_user_turn_with_model); 2 external calls (default, vec!).


##### `remote_aware_environment_id`  (lines 165–171)

```
fn remote_aware_environment_id() -> String
```

**Purpose**: Chooses the MCP environment ID appropriate for the active test placement.

**Data flow**: It queries `test_environment()`. If the environment is remote, it returns the literal `"remote"`; otherwise it returns `codex_config::DEFAULT_MCP_SERVER_ENVIRONMENT_ID` as a string.

**Call relations**: Tests that build MCP server configs call this helper when they need the same source code to work in both local and remote-aware CI placements.

*Call graph*: 1 external calls (test_environment).


##### `remote_aware_stdio_server_bin`  (lines 180–197)

```
fn remote_aware_stdio_server_bin() -> anyhow::Result<String>
```

**Purpose**: Returns a stdio MCP test-server executable path that is valid in the current placement, copying the host binary into the remote container when necessary.

**Data flow**: It resolves the host-side stdio server binary path via `stdio_server_bin()`, inspects `test_environment()` for a Docker container name, and either returns the host path unchanged or calls `copy_binary_to_remote_env(container_name, Path::new(&bin), "test_stdio_server")` to obtain an in-container path.

**Call relations**: Nearly every stdio MCP test calls this helper before inserting an MCP server config. It hides the local-versus-remote path rewrite so the tests can focus on transport behavior.

*Call graph*: calls 1 internal fn (copy_binary_to_remote_env); called by 13 (remote_stdio_env_var_source_does_not_copy_local_env, stdio_image_responses_are_sanitized_for_text_only_model, stdio_image_responses_preserve_original_detail_metadata, stdio_image_responses_resize_large_image, stdio_image_responses_round_trip, stdio_mcp_parallel_tool_calls_default_false_runs_serially, stdio_mcp_parallel_tool_calls_opt_in_runs_concurrently, stdio_mcp_read_only_tool_calls_run_concurrently_without_server_opt_in, stdio_mcp_tool_call_includes_sandbox_state_meta, stdio_server_propagates_explicit_local_env_var_source (+3 more)); 3 external calls (new, stdio_server_bin, test_environment).


##### `unique_remote_path`  (lines 200–206)

```
fn unique_remote_path(binary_name: &str) -> anyhow::Result<String>
```

**Purpose**: Generates a collision-resistant temporary path inside the remote container for a copied helper binary.

**Data flow**: It reads the current system time since `UNIX_EPOCH` in nanoseconds, combines that with the current process ID and the supplied binary name, and returns a `/tmp/codex-remote-env/...` path string.

**Call relations**: Only `copy_binary_to_remote_env` calls this helper. The uniqueness prevents parallel tests from overwriting each other's copied binaries inside the shared container.

*Call graph*: called by 1 (copy_binary_to_remote_env); 2 external calls (now, format!).


##### `copy_binary_to_remote_env`  (lines 209–263)

```
fn copy_binary_to_remote_env(
    container_name: &str,
    host_path: &Path,
    binary_name: &str,
) -> anyhow::Result<String>
```

**Purpose**: Copies a host-built test binary into the remote Docker container and marks it executable.

**Data flow**: It computes a unique remote path, runs `docker exec mkdir -p /tmp/codex-remote-env`, `docker cp` from the host path to `container_name:remote_path`, and `docker exec chmod +x remote_path`. Each subprocess result is checked with `ensure!`, and on success the function returns the remote path string.

**Call relations**: This helper underpins both remote-aware stdio MCP tests and remote Streamable HTTP server startup. It is the bridge that makes host-built test binaries runnable from inside the remote executor container.

*Call graph*: calls 1 internal fn (unique_remote_path); called by 2 (remote_aware_stdio_server_bin, start_remote_streamable_http_test_server); 3 external calls (new, ensure!, format!).


##### `TestMcpServerOptions::default`  (lines 272–278)

```
fn default() -> Self
```

**Purpose**: Provides default MCP server options for tests: local/default environment ID, no parallel-tool opt-in, and no tool timeout override.

**Data flow**: It constructs and returns `TestMcpServerOptions { environment_id: DEFAULT_MCP_SERVER_ENVIRONMENT_ID.to_string(), supports_parallel_tool_calls: false, tool_timeout_sec: None }`.

**Call relations**: Many tests use `..Default::default()` when inserting MCP servers, overriding only the few fields relevant to the scenario under test.


##### `stdio_transport`  (lines 281–287)

```
fn stdio_transport(
    command: String,
    env: Option<HashMap<String, String>>,
    env_vars: Vec<McpServerEnvVar>,
) -> McpServerTransportConfig
```

**Purpose**: Convenience constructor for a stdio MCP transport config without an explicit working directory.

**Data flow**: It takes a command string, optional environment map, and env-var whitelist/config list, forwards them to `stdio_transport_with_cwd(..., None)`, and returns the resulting `McpServerTransportConfig`.

**Call relations**: Most stdio MCP tests call this helper when they do not care about cwd precedence. The cwd-specific tests use the lower-level variant directly.

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

**Purpose**: Constructs a `McpServerTransportConfig::Stdio` with explicit command, args, env, env-var propagation rules, and optional cwd.

**Data flow**: It packages the supplied `command`, `env`, `env_vars`, and `cwd` into `McpServerTransportConfig::Stdio { command, args: Vec::new(), env, env_vars, cwd }` and returns it.

**Call relations**: This is the transport constructor used by `stdio_transport` and by cwd-focused tests that need to verify configured cwd beats runtime fallback.

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

**Purpose**: Adds or replaces a named MCP server entry in the mutable test `Config`.

**Data flow**: It clones the current `config.mcp_servers` map, inserts a new `McpServerConfig` built from the supplied transport and `TestMcpServerOptions` plus fixed defaults like `enabled = true`, `required = false`, `startup_timeout_sec = Some(10s)`, and empty tool maps, then writes the updated map back with `config.mcp_servers.set(...)`.

**Call relations**: Almost every MCP test uses this helper inside `with_config` closures. It centralizes the boilerplate needed to register a test MCP server while leaving transport and a few scheduling options configurable.

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

**Purpose**: Runs the `cwd` MCP tool through a scripted two-request Responses exchange and returns the structured tool result.

**Data flow**: It mounts one SSE stream that asks the model to call `mcp__{server_name}.cwd` and a second SSE stream that returns a final assistant message, submits a read-only user turn, waits for `McpToolCallBegin` and `McpToolCallEnd`, extracts `end.result.structured_content`, waits for `TurnComplete`, and returns that JSON value.

**Call relations**: The cwd precedence tests call this helper after building a fixture and waiting for MCP startup. It encapsulates the repetitive mock-server scripting and event waiting needed to exercise the `cwd` tool.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, read_only_user_turn); called by 2 (local_stdio_server_uses_runtime_fallback_cwd_when_config_omits_cwd, stdio_server_uses_configured_cwd_before_runtime_fallback); 4 external calls (wait_for_event, format!, unreachable!, vec!).


##### `assert_cwd_tool_output`  (lines 391–417)

```
fn assert_cwd_tool_output(structured: &Value, expected_cwd: &Path)
```

**Purpose**: Asserts that the structured output from the `cwd` tool matches the expected working directory, accounting for remote mode and Windows path normalization.

**Data flow**: It reads `structured["cwd"]` as a string. In remote mode it asserts exact JSON equality against `{ "cwd": expected_cwd }`; otherwise it canonicalizes both the reported path and `expected_cwd` and asserts the canonical paths are equal.

**Call relations**: Both cwd tests call this helper after `call_cwd_tool`. It hides platform-specific path quirks so the tests can focus on cwd precedence semantics.

*Call graph*: called by 2 (local_stdio_server_uses_runtime_fallback_cwd_when_config_omits_cwd, stdio_server_uses_configured_cwd_before_runtime_fallback); 3 external calls (get, assert_eq!, test_environment).


##### `stdio_server_round_trip`  (lines 421–559)

```
async fn stdio_server_round_trip() -> anyhow::Result<()>
```

**Purpose**: End-to-end test that a stdio MCP server can be discovered, invoked, and have its structured result wrapped back into the follow-up Responses request.

**Data flow**: It scripts one SSE response that requests `mcp__rmcp.echo` and a second that completes after tool execution, builds a fixture with an inserted stdio MCP server whose environment includes `MCP_TEST_VALUE`, waits for MCP startup, submits a read-only turn, waits for `McpToolCallBegin` and `McpToolCallEnd`, asserts the invocation and structured result fields (`echo`, `env`), waits for `TurnComplete`, then inspects the first request to ensure the namespace child tool was advertised and the second request's `function_call_output` to ensure the wrapped JSON payload preserves the structured result after stripping the wall-time wrapper.

**Call relations**: This is the baseline stdio MCP integration test. Many later tests vary one dimension of this same flow—cwd, env propagation, image content, scheduling—but this one establishes the core request/event/output round trip.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, read_only_user_turn, remote_aware_stdio_server_bin, split_wall_time_wrapped_output); 10 external calls (assert!, assert_eq!, wait_for_event, wait_for_mcp_server, format!, from_str, skip_if_no_network!, skip_if_wine_exec!, unreachable!, vec!).


##### `shutdown_cancels_startup_prewarm_waiting_for_mcp_startup`  (lines 562–605)

```
async fn shutdown_cancels_startup_prewarm_waiting_for_mcp_startup() -> anyhow::Result<()>
```

**Purpose**: Verifies that shutting down Codex while startup prewarm is blocked on MCP startup does not hang and does not later emit a websocket request.

**Data flow**: It starts a websocket-backed mock Responses server, binds a TCP listener to simulate a pending Streamable HTTP MCP endpoint, builds a fixture with that MCP server configured, waits for the prewarm connection attempt to reach the listener, then calls `fixture.codex.shutdown_and_wait()` under a timeout. After a short sleep it asserts the websocket server saw no connections.

**Call relations**: This test targets startup/shutdown orchestration rather than normal tool invocation. It uses the same MCP config insertion path but validates cancellation behavior around prewarm tasks.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 9 external calls (from_millis, from_secs, assert!, format!, skip_if_no_network!, bind, sleep, timeout, vec!).


##### `stdio_server_uses_configured_cwd_before_runtime_fallback`  (lines 609–672)

```
async fn stdio_server_uses_configured_cwd_before_runtime_fallback() -> anyhow::Result<()>
```

**Purpose**: Checks that a stdio MCP server's explicitly configured cwd is used instead of the runtime fallback cwd.

**Data flow**: It creates a workspace subdirectory during fixture setup, records the expected configured cwd in a shared `Mutex<Option<PathBuf>>`, inserts an MCP server using `stdio_transport_with_cwd(..., Some(configured_cwd))`, builds the fixture, waits for MCP startup, retrieves the expected cwd from the mutex, calls `call_cwd_tool`, and validates the result with `assert_cwd_tool_output`.

**Call relations**: This test depends on `call_cwd_tool` and `assert_cwd_tool_output` to isolate the cwd assertion. It is paired with the next test, which omits configured cwd to verify fallback behavior.

*Call graph*: calls 5 internal fn (start_mock_server, test_codex, assert_cwd_tool_output, call_cwd_tool, remote_aware_stdio_server_bin); 6 external calls (clone, new, new, wait_for_mcp_server, skip_if_no_network!, skip_if_wine_exec!).


##### `local_stdio_server_uses_runtime_fallback_cwd_when_config_omits_cwd`  (lines 677–736)

```
async fn local_stdio_server_uses_runtime_fallback_cwd_when_config_omits_cwd() -> anyhow::Result<()>
```

**Purpose**: Verifies on local Unix that when stdio transport omits `cwd`, the MCP server starts relative to the runtime fallback cwd.

**Data flow**: It records `config.cwd` into a shared mutex, copies the stdio test server binary into a relative path under that cwd, inserts an MCP server whose command is that relative path and whose transport omits `cwd`, builds the fixture, waits for MCP startup, retrieves the expected cwd, invokes `call_cwd_tool`, and checks the result with `assert_cwd_tool_output`.

**Call relations**: This is the fallback counterpart to the configured-cwd test. By using a relative command path, it also proves the runtime cwd is the directory from which the stdio server is resolved and launched.

*Call graph*: calls 4 internal fn (start_mock_server, test_codex, assert_cwd_tool_output, call_cwd_tool); 7 external calls (clone, new, new, from, cargo_bin, wait_for_mcp_server, skip_if_no_network!).


##### `stdio_mcp_tool_call_includes_sandbox_state_meta`  (lines 739–834)

```
async fn stdio_mcp_tool_call_includes_sandbox_state_meta() -> anyhow::Result<()>
```

**Purpose**: Ensures MCP tool results include sandbox-state metadata describing the active sandbox policy and cwd.

**Data flow**: It scripts a `sandbox_meta` tool call followed by a final assistant message, builds a fixture with a stdio MCP server, waits for startup, submits a turn with read-only permissions, inspects the first request to confirm the namespace child tool was advertised, then reads the second request's `function_call_output`, strips the wall-time wrapper, parses the JSON, and asserts the metadata object under `MCP_SANDBOX_STATE_META_CAPABILITY` contains the expected serialized sandbox policy, sandbox cwd, and `useLegacyLandlock = false`.

**Call relations**: This test extends the baseline stdio round trip by validating metadata injected into the tool result. It uses `turn_permission_fields` to compute the expected sandbox policy from the same permission profile used for the turn.

*Call graph*: calls 8 internal fn (mount_sse_once, sse, start_mock_server, test_codex, turn_permission_fields, remote_aware_stdio_server_bin, split_wall_time_wrapped_output, read_only); 9 external calls (assert!, assert_eq!, wait_for_mcp_server, format!, from_str, to_value, skip_if_no_network!, skip_if_wine_exec!, vec!).


##### `stdio_mcp_parallel_tool_calls_default_false_runs_serially`  (lines 837–953)

```
async fn stdio_mcp_parallel_tool_calls_default_false_runs_serially() -> anyhow::Result<()>
```

**Purpose**: Checks that mutable MCP tool calls run serially by default when the server has not opted into parallel execution.

**Data flow**: It scripts a single model response containing two `sync` function calls with sleep arguments, builds a fixture whose MCP server has `supports_parallel_tool_calls = false` and a tool timeout, submits an auto-approved mutable turn, collects four MCP begin/end events, computes their positions, and asserts one call fully ends before the other begins. After turn completion it inspects both `function_call_output` payloads and asserts each wrapped JSON result is `{ "result": "ok" }`.

**Call relations**: This test uses `auto_approved_user_turn` specifically to avoid approval gating on mutable tools. It is the baseline scheduling assertion that the next two concurrency tests compare against.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, auto_approved_user_turn, remote_aware_stdio_server_bin, split_wall_time_wrapped_output); 14 external calls (new, assert!, assert_eq!, Begin, End, wait_for_event, wait_for_mcp_server, format!, json!, from_str (+4 more)).


##### `stdio_mcp_read_only_tool_calls_run_concurrently_without_server_opt_in`  (lines 956–1056)

```
async fn stdio_mcp_read_only_tool_calls_run_concurrently_without_server_opt_in() -> anyhow::Result<()>
```

**Purpose**: Verifies that read-only MCP tools may run concurrently even when the server has not opted into general parallel tool calls.

**Data flow**: It scripts two `sync_readonly` calls whose server-side barrier requires concurrent arrival, builds a fixture with default `supports_parallel_tool_calls = false`, submits a read-only turn, waits for `TurnComplete`, then inspects both `function_call_output` payloads and asserts each wrapped JSON result is `{ "result": "ok" }`.

**Call relations**: This test contrasts with the serial mutable-tool baseline. The barrier in the test server makes concurrency observable: if Codex scheduled the calls serially, the server would time out instead of returning the asserted success payloads.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, read_only_user_turn, remote_aware_stdio_server_bin, split_wall_time_wrapped_output); 9 external calls (assert_eq!, wait_for_event, wait_for_mcp_server, format!, json!, from_str, skip_if_no_network!, skip_if_wine_exec!, vec!).


##### `stdio_mcp_parallel_tool_calls_opt_in_runs_concurrently`  (lines 1059–1148)

```
async fn stdio_mcp_parallel_tool_calls_opt_in_runs_concurrently() -> anyhow::Result<()>
```

**Purpose**: Checks that mutable MCP tool calls run concurrently when the server explicitly opts into parallel tool calls.

**Data flow**: It scripts two `sync` calls with a barrier requiring concurrent arrival, builds a fixture whose inserted MCP server sets `supports_parallel_tool_calls = true`, submits an auto-approved mutable turn, waits for completion, and asserts both wrapped `function_call_output` payloads decode to `{ "result": "ok" }`.

**Call relations**: This is the opt-in counterpart to the default-serial test. Together with the read-only case, it defines the scheduling matrix for mutable versus read-only tools and server opt-in.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, auto_approved_user_turn, remote_aware_stdio_server_bin, split_wall_time_wrapped_output); 9 external calls (assert_eq!, wait_for_event, wait_for_mcp_server, format!, json!, from_str, skip_if_no_network!, skip_if_wine_exec!, vec!).


##### `stdio_image_responses_round_trip`  (lines 1152–1290)

```
async fn stdio_image_responses_round_trip() -> anyhow::Result<()>
```

**Purpose**: Verifies that an MCP tool returning image content is converted into the Responses API image-input content format in the follow-up request.

**Data flow**: It scripts an `image` tool call and a final assistant message, builds a stdio MCP server configured with `MCP_TEST_IMAGE_DATA_URL = OPENAI_PNG`, submits a read-only turn, waits for `McpToolCallBegin`, `McpToolCallEnd`, and `TurnComplete`, asserts the end event contains one image content item with `mimeType = image/png` and the base64 payload from the data URL, then inspects the follow-up `function_call_output` array and asserts it contains a wall-time header item followed by an `input_image` object with the original data URL and `detail = "high"`.

**Call relations**: This test covers the image-content branch of MCP result serialization. It pairs with later image tests that enable resizing, preserve original detail metadata, or sanitize output for text-only models.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, assert_wall_time_header, read_only_user_turn, remote_aware_stdio_server_bin); 8 external calls (assert_eq!, wait_for_event, wait_for_mcp_server, format!, skip_if_no_network!, skip_if_wine_exec!, unreachable!, vec!).


##### `stdio_image_responses_resize_large_image`  (lines 1294–1396)

```
async fn stdio_image_responses_resize_large_image() -> anyhow::Result<()>
```

**Purpose**: Checks that large MCP-returned images are resized before being sent back to the model when `ResizeAllImages` is enabled.

**Data flow**: It generates a 3000x2000 PNG in memory, encodes it as a data URL, scripts an `image_scenario` tool call returning that image, enables `Feature::ResizeAllImages` in config, builds the fixture, submits a read-only turn, waits for completion, then inspects the follow-up `function_call_output` image item. It decodes the resized data URL, loads the image bytes, and asserts the dimensions are reduced to `(1920, 1280)` while `detail` remains `high`.

**Call relations**: This test extends the image round trip by toggling a feature flag and validating the transformed payload rather than the original image. It proves resizing happens on MCP-returned images before they are reintroduced into the Responses conversation.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, read_only_user_turn, remote_aware_stdio_server_bin, new); 14 external calls (ImageRgba8, from_pixel, new, assert_eq!, wait_for_event, wait_for_mcp_server, format!, Rgba, load_from_memory, json! (+4 more)).


##### `stdio_image_responses_preserve_original_detail_metadata`  (lines 1400–1487)

```
async fn stdio_image_responses_preserve_original_detail_metadata() -> anyhow::Result<()>
```

**Purpose**: Verifies that MCP image outputs marked with original detail preserve that metadata in the follow-up Responses payload.

**Data flow**: It scripts an `image_scenario` tool call for the `image_only_original_detail` scenario, builds a fixture on model `gpt-5.3-codex`, submits a read-only turn, waits for completion, then inspects the `function_call_output` array and asserts it contains a wall-time header plus an `input_image` object whose `image_url` is the expected tiny PNG data URL and whose `detail` is `original`.

**Call relations**: This test complements the default-image and resize tests by focusing on metadata preservation. It proves the MCP-to-Responses conversion path does not normalize away `original` detail when the model supports it.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, assert_wall_time_header, read_only_user_turn, remote_aware_stdio_server_bin); 7 external calls (assert_eq!, wait_for_event, wait_for_mcp_server, format!, skip_if_no_network!, skip_if_wine_exec!, vec!).


##### `stdio_image_responses_are_sanitized_for_text_only_model`  (lines 1491–1645)

```
async fn stdio_image_responses_are_sanitized_for_text_only_model() -> anyhow::Result<()>
```

**Purpose**: Checks that MCP image outputs are replaced with a textual placeholder when the active model does not support image input.

**Data flow**: It mounts a custom `/models` response advertising a text-only model, scripts an `image` tool call and final assistant message, builds a fixture with dummy auth and a stdio MCP server returning `OPENAI_PNG`, forces an online model refresh, submits a read-only turn targeting the text-only model slug, waits for MCP begin/end and turn completion, then inspects the follow-up `function_call_output` string, strips the wall-time wrapper, parses the JSON, and asserts it equals a one-item text array stating image content was omitted because the model does not support image input.

**Call relations**: This test ties together model discovery and MCP image serialization. It depends on the models manager refresh to make the text-only model metadata visible before the turn is submitted.

*Call graph*: calls 9 internal fn (mount_models_once, mount_sse_once, sse, start_mock_server, test_codex, read_only_user_turn_with_model, remote_aware_stdio_server_bin, split_wall_time_wrapped_output, create_dummy_chatgpt_auth_for_testing); 8 external calls (assert_eq!, wait_for_event, wait_for_mcp_server, format!, from_str, skip_if_no_network!, skip_if_wine_exec!, vec!).


##### `stdio_server_propagates_whitelisted_env_vars`  (lines 1649–1767)

```
async fn stdio_server_propagates_whitelisted_env_vars() -> anyhow::Result<()>
```

**Purpose**: Verifies that stdio MCP servers receive environment variables explicitly whitelisted in `env_vars`.

**Data flow**: It sets `MCP_TEST_VALUE` in the process environment via `EnvVarGuard`, scripts an `echo` tool call and final assistant message, builds a fixture whose MCP server transport has `env = None` but `env_vars = vec!["MCP_TEST_VALUE".into()]`, waits for startup, submits a read-only turn, waits for MCP begin/end and turn completion, and asserts the structured result contains both the echoed message and the propagated env value.

**Call relations**: This test differs from the baseline round trip by relying on env-var whitelisting instead of explicit `env` injection. It uses `EnvVarGuard` to keep the process environment isolated and automatically restored.

*Call graph*: calls 7 internal fn (set, mount_sse_once, sse, start_mock_server, test_codex, read_only_user_turn, remote_aware_stdio_server_bin); 10 external calls (new, assert!, assert_eq!, wait_for_event, wait_for_mcp_server, format!, skip_if_no_network!, skip_if_wine_exec!, unreachable!, vec!).


##### `stdio_server_propagates_explicit_local_env_var_source`  (lines 1771–1863)

```
async fn stdio_server_propagates_explicit_local_env_var_source() -> anyhow::Result<()>
```

**Purpose**: Checks that an env-var config entry with `source = "local"` copies the local process environment into the stdio MCP server.

**Data flow**: It sets a named environment variable with `EnvVarGuard`, scripts an `echo` tool call that asks the server to report that variable, builds a fixture whose MCP server transport includes `McpServerEnvVar::Config { name, source: Some("local") }`, waits for startup, submits a read-only turn, waits for MCP begin/end and turn completion, and asserts the structured result's `env` field equals the local value.

**Call relations**: This test narrows env propagation semantics from generic whitelisting to explicit source selection. It is paired with the next test, which verifies that `source = "remote"` does not leak local env into a remote-aware run.

*Call graph*: calls 7 internal fn (set, mount_sse_once, sse, start_mock_server, test_codex, read_only_user_turn, remote_aware_stdio_server_bin); 9 external calls (new, assert_eq!, wait_for_event, wait_for_mcp_server, format!, skip_if_no_network!, skip_if_wine_exec!, unreachable!, vec!).


##### `remote_stdio_env_var_source_does_not_copy_local_env`  (lines 1867–1961)

```
async fn remote_stdio_env_var_source_does_not_copy_local_env() -> anyhow::Result<()>
```

**Purpose**: Verifies in remote-aware mode that env vars marked with `source = "remote"` are not copied from the local orchestrator process into the remote stdio MCP server.

**Data flow**: After early-returning when not in a remote environment, it sets a local-only env var with `EnvVarGuard`, scripts an `echo` tool call requesting that variable, builds a remote-aware fixture whose MCP server transport includes `McpServerEnvVar::Config { source: Some("remote") }`, waits for startup, submits a read-only turn, waits for MCP begin/end and turn completion, and asserts the structured result's `env` field is `null`.

**Call relations**: This test is the negative counterpart to the explicit-local-source case. It proves source selection is honored across the local/remote boundary rather than blindly copying orchestrator environment variables.

*Call graph*: calls 7 internal fn (set, mount_sse_once, sse, start_mock_server, test_codex, read_only_user_turn, remote_aware_stdio_server_bin); 10 external calls (new, assert_eq!, test_environment, wait_for_event, wait_for_mcp_server, format!, skip_if_no_network!, skip_if_wine_exec!, unreachable!, vec!).


##### `RemoteStreamableHttpServer::drop`  (lines 1989–1998)

```
fn drop(&mut self)
```

**Purpose**: Performs best-effort cleanup for a remote Streamable HTTP test server by killing the process and deleting copied artifacts.

**Data flow**: On drop it calls `self.kill()`, then if `paths_to_remove` is non-empty it builds an `rm -f ...` shell script and runs it inside the Docker container with `docker exec sh -lc`. It ignores cleanup failures.

**Call relations**: This destructor is triggered automatically when a `RemoteStreamableHttpServer` owned by `StreamableHttpTestServerProcess::Remote` goes out of scope. It complements explicit shutdown by cleaning up copied binaries, addr files, and logs.

*Call graph*: calls 1 internal fn (kill); 2 external calls (new, format!).


##### `RemoteStreamableHttpServer::kill`  (lines 2003–2007)

```
fn kill(&self)
```

**Purpose**: Sends a kill signal to the remote Streamable HTTP test server process inside the Docker container.

**Data flow**: It runs `docker exec <container> kill <pid>` and ignores the result, returning no value.

**Call relations**: Both the explicit shutdown path and the `Drop` implementation call this helper. It is the primitive used to stop remote Streamable HTTP test servers.

*Call graph*: called by 1 (drop); 1 external calls (new).


##### `StreamableHttpTestServer::url`  (lines 2012–2014)

```
fn url(&self) -> &str
```

**Purpose**: Returns the MCP endpoint URL that Codex should use for the started Streamable HTTP test server.

**Data flow**: It reads and returns `&self.server_url`.

**Call relations**: The Streamable HTTP round-trip tests call this immediately after startup to capture the URL for insertion into `McpServerTransportConfig::StreamableHttp`.


##### `StreamableHttpTestServer::shutdown`  (lines 2017–2038)

```
async fn shutdown(mut self)
```

**Purpose**: Stops the local or remote Streamable HTTP test server and waits for local child-process exit when applicable.

**Data flow**: It matches on `self.process`: for `Local(child)` it checks `try_wait`, kills the child if still running or on status-check error, then awaits `child.wait()` and logs any error; for `Remote(server)` it calls `server.kill()`. It consumes `self`.

**Call relations**: The Streamable HTTP tests call this during cleanup after verifying requests and events. It provides deterministic teardown beyond the remote server's drop-based best-effort cleanup.

*Call graph*: 1 external calls (eprintln!).


##### `streamable_http_tool_call_round_trip`  (lines 2045–2185)

```
async fn streamable_http_tool_call_round_trip() -> anyhow::Result<()>
```

**Purpose**: End-to-end test that Codex can discover and invoke a Streamable HTTP MCP tool in the active local or remote-aware placement.

**Data flow**: It scripts a model response that calls `mcp__rmcp_http.echo` and then completes after tool execution, starts a placement-aware Streamable HTTP test server with an expected env value, inserts that server into config, builds a fixture with remote-aware placement, waits for MCP startup, submits a read-only turn, waits for `McpToolCallBegin` and `McpToolCallEnd`, asserts the invocation and structured result (`echo`, `env`), waits for `TurnComplete`, verifies the mock Responses server, and shuts down the HTTP test server.

**Call relations**: This is the baseline Streamable HTTP counterpart to `stdio_server_round_trip`. It depends on `start_streamable_http_test_server` to abstract over local versus remote server startup.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, read_only_user_turn, start_streamable_http_test_server); 8 external calls (assert!, assert_eq!, wait_for_event, wait_for_mcp_server, format!, skip_if_no_network!, unreachable!, vec!).


##### `streamable_http_with_oauth_round_trip`  (lines 2191–2211)

```
fn streamable_http_with_oauth_round_trip() -> anyhow::Result<()>
```

**Purpose**: Runs the OAuth-backed Streamable HTTP MCP round-trip test on a dedicated thread with a larger stack and its own Tokio runtime.

**Data flow**: It spawns a named OS thread with an 8 MiB stack, builds a single-worker Tokio runtime inside that thread, blocks on `streamable_http_with_oauth_round_trip_impl()`, joins the thread, and converts a panic into an `anyhow!` error.

**Call relations**: This synchronous wrapper exists solely to host the async OAuth test implementation under controlled runtime and stack settings. The actual MCP/OAuth assertions live in the `_impl` function.

*Call graph*: 2 external calls (anyhow!, new).


##### `streamable_http_with_oauth_round_trip_impl`  (lines 2213–2374)

```
async fn streamable_http_with_oauth_round_trip_impl() -> anyhow::Result<()>
```

**Purpose**: Verifies that a Streamable HTTP MCP server requiring a bearer token can be reached using fallback OAuth credentials stored in an isolated `CODEX_HOME`.

**Data flow**: It scripts an OAuth-backed `echo` tool call and final assistant message, starts a Streamable HTTP test server configured to require `initial-access-token`, creates a temp home and sets `CODEX_HOME` via `EnvVarGuard`, writes fallback OAuth tokens with `write_fallback_oauth_tokens`, builds a fixture whose config forces file-backed MCP OAuth credential storage and inserts the HTTP MCP server, waits for MCP startup, submits a read-only turn, waits for MCP begin/end and turn completion, asserts the structured result contains the expected echo and env values, verifies the mock Responses server, and shuts down the HTTP server.

**Call relations**: This is the authenticated variant of the plain Streamable HTTP round trip. It relies on `start_streamable_http_test_server` for server startup and `write_fallback_oauth_tokens` for seeding credentials that the MCP client should consume.

*Call graph*: calls 8 internal fn (set, mount_sse_once, sse, start_mock_server, test_codex, read_only_user_turn, start_streamable_http_test_server, write_fallback_oauth_tokens); 10 external calls (new, assert!, assert_eq!, wait_for_event, wait_for_mcp_server, format!, skip_if_no_network!, tempdir, unreachable!, vec!).


##### `start_streamable_http_test_server`  (lines 2377–2423)

```
async fn start_streamable_http_test_server(
    expected_env_value: &str,
    expected_token: Option<&str>,
) -> anyhow::Result<Option<StreamableHttpTestServer>>
```

**Purpose**: Starts the Streamable HTTP MCP test server in either local host mode or remote-container mode, depending on the active test environment.

**Data flow**: It resolves the `test_streamable_http_server` binary with `cargo_bin`, returning `Ok(None)` and printing a skip message if unavailable. It then checks `test_environment()` for a Docker container name: in remote mode it delegates to `start_remote_streamable_http_test_server`; otherwise it binds an ephemeral local port, spawns the server process with environment variables for bind address, expected env value, and optional bearer token, waits for metadata readiness via `wait_for_local_streamable_http_server`, and returns a `StreamableHttpTestServer` wrapping the local child.

**Call relations**: Both Streamable HTTP round-trip tests call this helper. It is the main placement abstraction that hides whether the MCP server runs as a local child process or inside the remote container.

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

**Purpose**: Starts the Streamable HTTP MCP test server inside the remote Docker container and returns a host-visible URL plus cleanup metadata.

**Data flow**: It copies the server binary into the container, computes remote paths for an addr file and log file, builds shell-safe environment assignments including bind address, addr-file path, expected env value, and optional bearer token, launches the server with `nohup ... & echo $!`, parses the returned PID, waits for the bound address file via `wait_for_remote_bound_addr`, resolves the container IP with `remote_container_ip`, constructs the host-visible `http://<ip>:<port>/mcp` URL, probes readiness through remote HTTP with `wait_for_remote_streamable_http_server`, optionally waits for OAuth metadata from the host side, and returns a `StreamableHttpTestServer` wrapping `RemoteStreamableHttpServer`.

**Call relations**: Only `start_streamable_http_test_server` calls this helper, in remote-aware placements. It combines binary staging, remote process launch, readiness probing, and cleanup bookkeeping.

*Call graph*: calls 5 internal fn (copy_binary_to_remote_env, remote_container_ip, wait_for_remote_bound_addr, wait_for_remote_streamable_http_server, wait_for_streamable_http_metadata); called by 1 (start_streamable_http_test_server); 7 external calls (from_secs, new, from_utf8, Remote, ensure!, format!, vec!).


##### `sh_single_quote`  (lines 2506–2508)

```
fn sh_single_quote(value: &str) -> String
```

**Purpose**: Escapes a string for safe inclusion as a single-quoted shell literal in small Docker-executed shell snippets.

**Data flow**: It replaces each `'` in the input with the shell-safe sequence `'\''` and wraps the whole result in surrounding single quotes, returning the escaped string.

**Call relations**: Remote Streamable HTTP startup uses this helper when constructing shell commands passed through `docker exec sh -lc`, preventing malformed commands when values contain quotes.

*Call graph*: 1 external calls (format!).


##### `wait_for_remote_bound_addr`  (lines 2511–2538)

```
async fn wait_for_remote_bound_addr(
    container_name: &str,
    bound_addr_file: &str,
    timeout: Duration,
) -> anyhow::Result<SocketAddr>
```

**Purpose**: Polls the remote container until the Streamable HTTP test server writes the socket address it bound to.

**Data flow**: It computes a deadline, repeatedly runs `docker exec cat <bound_addr_file>`, and if successful parses the stdout as UTF-8 `SocketAddr`. On failure before the deadline it sleeps 50 ms and retries; after the deadline it returns an `anyhow!` timeout error including stderr.

**Call relations**: Remote Streamable HTTP startup calls this helper after launching the server process. It bridges the gap between remote process creation and knowing which ephemeral port the server actually bound.

*Call graph*: called by 1 (start_remote_streamable_http_test_server); 6 external calls (from_millis, now, new, from_utf8, anyhow!, sleep).


##### `remote_container_ip`  (lines 2541–2570)

```
fn remote_container_ip(container_name: &str) -> anyhow::Result<String>
```

**Purpose**: Finds the Docker container IP address that the host-side test process can use to reach the remote Streamable HTTP server.

**Data flow**: It runs `docker inspect -f '{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}' <container>`, checks success with `ensure!`, parses stdout as UTF-8, selects the first non-empty trimmed line, and returns it, defaulting to `127.0.0.1` if no IP is reported.

**Call relations**: `start_remote_streamable_http_test_server` calls this after learning the remote bound port. The resulting IP is combined with that port to form the host-visible MCP URL.

*Call graph*: called by 1 (start_remote_streamable_http_test_server); 3 external calls (new, from_utf8, ensure!).


##### `wait_for_local_streamable_http_server`  (lines 2573–2622)

```
async fn wait_for_local_streamable_http_server(
    server_child: &mut Child,
    server_url: &str,
    timeout: Duration,
) -> anyhow::Result<()>
```

**Purpose**: Polls a locally spawned Streamable HTTP test server until its OAuth metadata endpoint responds with HTTP 200, while also failing fast if the child exits.

**Data flow**: It derives the metadata URL from `server_url`, builds a no-proxy `reqwest::Client`, loops until the deadline, checks `server_child.try_wait()` for early exit, computes remaining time, performs a timed GET request, returns success on HTTP 200, otherwise retries after 50 ms or returns a detailed timeout/error message when the deadline is reached.

**Call relations**: Local Streamable HTTP startup uses this helper before handing the server URL to the fixture. It ensures the server is actually ready to serve metadata and MCP traffic.

*Call graph*: calls 1 internal fn (streamable_http_metadata_url); called by 1 (start_streamable_http_test_server); 7 external calls (try_wait, from_millis, now, anyhow!, builder, sleep, timeout).


##### `wait_for_remote_streamable_http_server`  (lines 2625–2674)

```
async fn wait_for_remote_streamable_http_server(
    server_url: &str,
    timeout: Duration,
) -> anyhow::Result<()>
```

**Purpose**: Polls the remote Streamable HTTP server through the remote execution environment until its metadata endpoint responds successfully.

**Data flow**: It reads `CODEX_TEST_REMOTE_EXEC_SERVER_URL`, creates a remote `Environment` test client, derives the metadata URL, loops until the deadline, and issues remote HTTP GET requests via `http_client.http_request(...)` with a bounded timeout. It returns on HTTP 200, otherwise retries after 50 ms or returns a detailed timeout/error.

**Call relations**: Remote Streamable HTTP startup calls this after constructing the host-visible URL. Unlike the local readiness probe, this one validates reachability from the remote-side MCP client path that Codex will actually use.

*Call graph*: calls 2 internal fn (streamable_http_metadata_url, create_for_tests); called by 1 (start_remote_streamable_http_test_server); 6 external calls (from_millis, now, new, anyhow!, var, sleep).


##### `wait_for_streamable_http_metadata`  (lines 2677–2718)

```
async fn wait_for_streamable_http_metadata(
    server_url: &str,
    timeout: Duration,
) -> anyhow::Result<()>
```

**Purpose**: Polls the Streamable HTTP server's OAuth metadata endpoint from the host side until it returns HTTP 200.

**Data flow**: It derives the metadata URL, builds a no-proxy `reqwest::Client`, loops until the deadline, performs timed GET requests, returns success on HTTP 200, and otherwise retries after 50 ms or returns a detailed timeout/error.

**Call relations**: Remote Streamable HTTP startup calls this only when bearer-token enforcement is enabled, adding a host-side metadata readiness check on top of the remote-side reachability probe.

*Call graph*: calls 1 internal fn (streamable_http_metadata_url); called by 1 (start_remote_streamable_http_test_server); 6 external calls (from_millis, now, anyhow!, builder, sleep, timeout).


##### `streamable_http_metadata_url`  (lines 2721–2724)

```
fn streamable_http_metadata_url(server_url: &str) -> String
```

**Purpose**: Builds the OAuth metadata URL corresponding to a Streamable HTTP MCP endpoint URL.

**Data flow**: It strips a trailing `/mcp` from `server_url` if present and appends `STREAMABLE_HTTP_METADATA_PATH`, returning the resulting string.

**Call relations**: All three metadata-wait helpers call this to derive the endpoint they should probe. It keeps the metadata-path convention consistent across local and remote readiness checks.

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

**Purpose**: Writes a `.credentials.json` file under a test home directory containing fallback OAuth credentials for an MCP server.

**Data flow**: It computes an expiry timestamp one hour in the future, builds a JSON object keyed by `stub` with server name, server URL, client ID, access token, expiry, refresh token, and scopes, serializes it to bytes, and writes it to `home/.credentials.json`.

**Call relations**: The OAuth Streamable HTTP test calls this before building the fixture so the MCP client can discover credentials without sharing state with other tests.

*Call graph*: called by 1 (streamable_http_with_oauth_round_trip_impl); 6 external calls (from_secs, join, now, write, json!, to_vec).


##### `EnvVarGuard::set`  (lines 2763–2769)

```
fn set(key: &'static str, value: &std::ffi::OsStr) -> Self
```

**Purpose**: Sets an environment variable for the duration of a test and remembers the previous value for restoration.

**Data flow**: It reads the original value with `std::env::var_os`, unsafely sets the new value with `std::env::set_var`, and returns `EnvVarGuard { key, original }`.

**Call relations**: Environment-propagation tests and the OAuth test use this helper to mutate process environment safely. Restoration happens automatically in `EnvVarGuard::drop`.

*Call graph*: 2 external calls (set_var, var_os).


##### `EnvVarGuard::drop`  (lines 2773–2780)

```
fn drop(&mut self)
```

**Purpose**: Restores or removes the guarded environment variable when the guard goes out of scope.

**Data flow**: On drop it checks `self.original`: if present it restores that value with `set_var`, otherwise it removes the variable with `remove_var`.

**Call relations**: This destructor is the cleanup half of `EnvVarGuard::set`, ensuring environment mutations made by tests do not leak into later cases.

*Call graph*: 2 external calls (remove_var, set_var).


### `rmcp-client/tests/resources.rs`

`test` · `integration test execution after client initialization`

This integration test covers the resource-related portions of the RMCP client against the `test_stdio_server` binary. The helper `stdio_server_bin` resolves that binary from the Cargo target directory, while `init_params` builds an initialization request that advertises elicitation support by populating `ClientCapabilities.elicitation` with a `FormElicitationCapability`. The protocol version is pinned to `V_2025_06_18`, matching the rest of the RMCP tests.

The single async test launches the server with `RmcpClient::new_stdio_client`, using no extra args, no environment overrides, and a `LocalStdioServerLauncher` rooted at the current working directory. It then initializes the session with a callback that always accepts elicitation requests and returns an empty JSON object. After initialization, it exercises three resource APIs in sequence.

First, `list_resources` must include a `memo://codex/example-note` resource whose URI, name, title, description, and MIME type exactly match the expected `RawResource` wrapped with `.no_annotation()`. Second, `list_resource_templates` must return a single `RawResourceTemplate` for `memo://codex/{slug}` with the expected metadata and no annotations. Third, `read_resource` for the fixed URI must return `ResourceContents::TextResourceContents` containing the expected plain-text body. The test therefore verifies not just transport success but the exact schema shape and values returned by the server.

#### Function details

##### `stdio_server_bin`  (lines 26–28)

```
fn stdio_server_bin() -> Result<PathBuf, CargoBinError>
```

**Purpose**: Finds the compiled `test_stdio_server` binary used by the resource integration test. It returns the cargo-bin lookup result directly.

**Data flow**: It takes no arguments, calls `codex_utils_cargo_bin::cargo_bin("test_stdio_server")`, and returns `Result<PathBuf, CargoBinError>`.

**Call relations**: The main resource test calls this before constructing the stdio RMCP client.

*Call graph*: called by 1 (rmcp_client_can_list_and_read_resources); 1 external calls (cargo_bin).


##### `init_params`  (lines 30–43)

```
fn init_params() -> InitializeRequestParams
```

**Purpose**: Builds initialization parameters that advertise elicitation capability for the resource test session. It also fixes the client identity and protocol version.

**Data flow**: It starts from `ClientCapabilities::default()`, sets `capabilities.elicitation` to `Some(ElicitationCapability { form: Some(FormElicitationCapability { schema_validation: None }), url: None })`, constructs `InitializeRequestParams` with a `codex-test` implementation titled `Codex rmcp resource test`, applies `ProtocolVersion::V_2025_06_18`, and returns the struct.

**Call relations**: The integration test passes this into `client.initialize(...)` so the session is established with the capabilities expected by the test server.

*Call graph*: called by 1 (rmcp_client_can_list_and_read_resources); 3 external calls (default, new, new).


##### `rmcp_client_can_list_and_read_resources`  (lines 46–138)

```
async fn rmcp_client_can_list_and_read_resources() -> anyhow::Result<()>
```

**Purpose**: Runs an end-to-end stdio RMCP session that initializes the client, lists resources, lists resource templates, and reads a concrete resource. It asserts exact metadata and content values for the test server's memo resource.

**Data flow**: It resolves the server binary, creates an `RmcpClient` with `new_stdio_client`, initializes it using `init_params()` and an elicitation callback that returns `Accept` with empty JSON content, then calls `list_resources`, `list_resource_templates`, and `read_resource(ReadResourceRequestParams::new(RESOURCE_URI), timeout)`. It searches the listed resources for `RESOURCE_URI`, compares that entry and the template list against fully constructed expected model values, extracts the first returned content item from `read_resource`, and asserts it equals the expected `TextResourceContents`. It returns `Ok(())` if all protocol calls and assertions succeed.

**Call relations**: This is the sole top-level test in the file. It depends on `stdio_server_bin` and `init_params` for setup, then directly exercises the RMCP client's resource-related methods.

*Call graph*: calls 4 internal fn (new_stdio_client, new, init_params, stdio_server_bin); 7 external calls (new, new, from_secs, new, new, assert_eq!, current_dir).


### Tool definitions and conversion behavior
This group follows tool modeling from core definitions and discovery through MCP and dynamic-tool conversion, code-mode adaptation, Responses API shaping, and schema-policy fixtures.

### `tools/src/tool_definition_tests.rs`

`test` · `test run`

This test file builds a single canonical `ToolDefinition` fixture and uses struct update syntax to assert exact field-level behavior of two transformation methods defined elsewhere. The shared fixture uses a concrete function-style tool named `lookup_order`, a plain description, an empty object `input_schema` created with `JsonSchema::object`, a minimal object-shaped `output_schema` built with `serde_json::json!`, and `defer_loading: false`. The tests are intentionally narrow: they compare whole structs rather than checking individual fields, which makes the invariants explicit. `renamed_overrides_name_only` proves that `renamed(...)` must preserve description, schemas, and loading behavior while replacing only `name`. `into_deferred_drops_output_schema_and_sets_defer_loading` proves that deferred conversion has two coupled effects: `output_schema` becomes `None` and `defer_loading` becomes `true`, with all other fields preserved. Because both assertions use `pretty_assertions::assert_eq`, failures will show readable structural diffs, which is useful for catching accidental changes to defaulted or copied fields.

#### Function details

##### `tool_definition`  (lines 6–20)

```
fn tool_definition() -> ToolDefinition
```

**Purpose**: Constructs the reusable baseline `ToolDefinition` fixture used by the tests in this file. The fixture represents a non-deferred tool with an empty object input schema and a simple object output schema.

**Data flow**: It takes no arguments and creates a fresh `ToolDefinition` value from literals plus `JsonSchema::object(BTreeMap::new(), None, None)` and `serde_json::json!({"type": "object"})`. It returns that fully populated struct without mutating external state.

**Call relations**: This helper is invoked by both test cases so they compare transformations against the same canonical starting value rather than duplicating setup inline.

*Call graph*: calls 1 internal fn (object); 2 external calls (new, json!).


##### `renamed_overrides_name_only`  (lines 23–31)

```
fn renamed_overrides_name_only()
```

**Purpose**: Verifies that calling `renamed` on the fixture changes only the `name` field. The expected value is expressed with struct update syntax to make preservation of all other fields explicit.

**Data flow**: It creates a baseline fixture, calls `renamed("mcp__orders__lookup_order".to_string())` on one copy, constructs an expected `ToolDefinition` with only `name` overridden from another fixture copy, and asserts equality. It returns no value and writes no state beyond test output on failure.

**Call relations**: This is a standalone unit test run by the Rust test harness; its only delegated work is the equality assertion comparing the transformed and expected structs.

*Call graph*: 1 external calls (assert_eq!).


##### `into_deferred_drops_output_schema_and_sets_defer_loading`  (lines 34–43)

```
fn into_deferred_drops_output_schema_and_sets_defer_loading()
```

**Purpose**: Verifies the deferred conversion contract for `ToolDefinition`: eager output schema is removed and deferred loading is enabled. It ensures no unrelated fields are altered.

**Data flow**: It creates the baseline fixture, calls `into_deferred()` on it, builds an expected struct with `output_schema: None` and `defer_loading: true` layered over the original fixture, and asserts equality. It produces no return value and only signals through test success or failure.

**Call relations**: This test is executed by the test harness and complements the rename test by covering the second transformation path on `ToolDefinition`.

*Call graph*: 1 external calls (assert_eq!).


### `tools/src/tool_spec_tests.rs`

`test` · `test run`

This file is a focused regression suite for `tool_spec.rs`. Each test constructs concrete `ToolSpec` values and compares either their derived names or their serialized JSON against exact expected structures. The coverage is intentionally variant-by-variant: `tool_spec_name_covers_all_variants` ensures `ToolSpec::name()` never misses a branch, including synthetic names for built-in variants and passthrough names for embedded tool structs. The web-search conversion test verifies that config-layer structs convert losslessly into the Responses API mirror structs.

The serialization tests are especially concrete. `create_tools_json_for_responses_api_includes_top_level_name` checks that the helper returns a vector of JSON objects and that a function tool includes top-level `type`, `name`, `description`, `strict`, and nested `parameters`. Separate tests pin the exact wire shape for namespace tools, web-search tools with all optional fields populated, and tool-search tools with required fields and `additionalProperties: false`.

These tests also implicitly document serde behavior: omitted optional fields stay absent, enum tagging produces the expected `type` discriminator, and nested schema builders like `JsonSchema::object` and `JsonSchema::string` serialize into the exact schema fragments expected by downstream API consumers.

#### Function details

##### `tool_spec_name_covers_all_variants`  (lines 21–91)

```
fn tool_spec_name_covers_all_variants()
```

**Purpose**: Verifies that `ToolSpec::name()` returns the correct identifier for every enum variant, including fixed built-in names and embedded tool names.

**Data flow**: Builds representative `ToolSpec` values for `Function`, `Namespace`, `ToolSearch`, `ImageGeneration`, `WebSearch`, and `Freeform`, invokes `.name()` on each, and compares the returned `&str` to the expected literal with `assert_eq!`. It writes no persistent state.

**Call relations**: This test directly exercises the exhaustive match in `ToolSpec::name`. It is invoked by the test harness and does not delegate beyond assertions and the constructors used to assemble sample tool values.

*Call graph*: 1 external calls (assert_eq!).


##### `web_search_config_converts_to_responses_api_types`  (lines 94–119)

```
fn web_search_config_converts_to_responses_api_types()
```

**Purpose**: Checks that config-layer web-search filter and location structs convert field-for-field into the Responses API mirror structs.

**Data flow**: Constructs `ConfigWebSearchFilters` and `ConfigWebSearchUserLocation`, converts them via the `From` impls, and asserts equality with explicitly constructed `ResponsesApiWebSearchFilters` and `ResponsesApiWebSearchUserLocation` values. The transformation is expected to be a direct copy of optional fields and enum values.

**Call relations**: This test guards the two conversion impls in `tool_spec.rs`. It is run by the test harness and serves as a regression check that future config-type changes do not silently alter the wire-facing structs.

*Call graph*: 1 external calls (assert_eq!).


##### `create_tools_json_for_responses_api_includes_top_level_name`  (lines 122–150)

```
fn create_tools_json_for_responses_api_includes_top_level_name()
```

**Purpose**: Ensures the bulk serialization helper emits a function tool JSON object with the expected top-level fields, especially `name`.

**Data flow**: Creates a one-element slice containing `ToolSpec::Function`, passes it to `create_tools_json_for_responses_api`, unwraps the `Result`, and compares the returned `Vec<Value>` to a literal `json!` array. It validates both the outer vector shape and the nested schema serialization.

**Call relations**: This test covers the helper that serializes tool lists rather than individual tools. It is invoked by the test harness and indirectly exercises serde serialization for `ToolSpec` and `JsonSchema`.

*Call graph*: 1 external calls (assert_eq!).


##### `namespace_tool_spec_serializes_expected_wire_shape`  (lines 153–195)

```
fn namespace_tool_spec_serializes_expected_wire_shape()
```

**Purpose**: Pins the exact JSON representation of a namespace tool containing a nested function tool.

**Data flow**: Constructs `ToolSpec::Namespace` with one `ResponsesApiNamespaceTool::Function`, serializes it with `serde_json::to_value`, and asserts equality with a literal JSON object containing `type: "namespace"`, namespace metadata, and a nested function tool entry. No state is mutated.

**Call relations**: This test validates serde tagging and nested tool serialization for the namespace variant. It is run directly by the test harness and complements the bulk helper test by checking a single serialized value.

*Call graph*: 1 external calls (assert_eq!).


##### `web_search_tool_spec_serializes_expected_wire_shape`  (lines 198–233)

```
fn web_search_tool_spec_serializes_expected_wire_shape()
```

**Purpose**: Confirms that a fully populated `ToolSpec::WebSearch` serializes all supported optional fields under the correct JSON keys.

**Data flow**: Builds a `WebSearch` variant with `external_web_access`, `filters`, `user_location`, `search_context_size`, and `search_content_types`, serializes it to `Value`, and compares it to a literal JSON object. The assertion checks field names, enum string forms, and nested object layout.

**Call relations**: This test protects the web-search wire contract, especially serde renames and omission behavior. It is invoked by the test harness and exercises the structs defined in `tool_spec.rs` together with protocol enums.

*Call graph*: 1 external calls (assert_eq!).


##### `tool_search_tool_spec_serializes_expected_wire_shape`  (lines 236–268)

```
fn tool_search_tool_spec_serializes_expected_wire_shape()
```

**Purpose**: Verifies the JSON shape of the `tool_search` variant, including schema requirements and `additionalProperties` policy.

**Data flow**: Constructs `ToolSpec::ToolSearch` with a schema containing one required `query` property and `AdditionalProperties::Boolean(false)`, serializes it, and asserts equality with the expected JSON object. The test checks that required fields and schema metadata survive serialization intact.

**Call relations**: This test covers the specialized `tool_search` variant that uses a fixed top-level type plus caller-supplied schema. It is run by the test harness and acts as a regression check for serde output and schema builder behavior.

*Call graph*: 1 external calls (assert_eq!).


### `tools/src/tool_discovery_tests.rs`

`test` · `test run`

This test module validates two externally visible contracts from `tool_discovery.rs`. The first test checks serde output for `DiscoverableToolType` and `DiscoverableToolAction`, asserting that the `#[serde(rename_all = "snake_case")]` annotations really produce lowercase protocol strings like `connector` and `install` inside JSON objects. The second test constructs a mixed `Vec<DiscoverableTool>` containing one connector `AppInfo` and one `DiscoverablePluginInfo`, then passes it through `filter_request_plugin_install_discoverable_tools_for_client` with `Some("codex-tui")`. The expected result is a one-element vector containing only the original connector, proving that the TUI-specific branch removes plugin entries but preserves connector data exactly. The test data is concrete and complete, including optional fields such as `install_url`, accessibility flags, and plugin metadata vectors, so regressions in equality semantics or filtering logic are easy to spot. As in the other test files, `pretty_assertions::assert_eq` is used to make structural mismatches readable.

#### Function details

##### `discoverable_tool_enums_use_expected_wire_names`  (lines 7–18)

```
fn discoverable_tool_enums_use_expected_wire_names()
```

**Purpose**: Confirms that the discovery enums serialize to the expected snake_case wire values. This protects the protocol contract used by clients and servers exchanging JSON.

**Data flow**: It builds one JSON object containing enum values and another containing the expected literal strings, then asserts the two `serde_json::Value` objects are equal. It returns no value and mutates no state.

**Call relations**: This standalone unit test is run by the test harness and specifically validates the serde rename behavior declared on the enums.

*Call graph*: 1 external calls (assert_eq!).


##### `filter_request_plugin_install_discoverable_tools_for_codex_tui_omits_plugins`  (lines 21–70)

```
fn filter_request_plugin_install_discoverable_tools_for_codex_tui_omits_plugins()
```

**Purpose**: Verifies that the TUI-specific filtering rule removes plugin entries while leaving connector entries intact. It uses a mixed input vector to exercise the branch that performs filtering.

**Data flow**: It constructs a `Vec<DiscoverableTool>` with one boxed `AppInfo` connector and one boxed `DiscoverablePluginInfo` plugin, calls `filter_request_plugin_install_discoverable_tools_for_client(..., Some("codex-tui"))`, and asserts the returned vector contains only the connector entry with all fields preserved. It produces no return value beyond test success/failure.

**Call relations**: This test drives the special-case branch in the filtering function and complements the serialization test by covering runtime discovery policy rather than wire naming.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `tools/src/tool_search_tests.rs`

`test` · `test run`

This test module constructs a realistic namespace `ToolSpec` with nested JSON schema descriptions and then asserts the exact search corpus produced by `ToolSearchInfo::from_tool_spec`. The setup is intentionally layered: a `schedule_schema` object contains a `timezone` property with its own description, that schema is embedded under a `schedule` property inside a larger `parameters` object, and the parameters object itself also has a description. The namespace spec includes a name, a non-empty description, and one function tool named `automation_update` with its own description and the nested parameters schema. After generating search info, the test asserts that `search_info.entry.search_text` is a single space-joined string containing the namespace name and description once, followed by the function name in both raw and humanized forms, the function description, the parameter object description, each property name, and each nested schema description. This locks down both recursion through schema structure and the deduplication behavior that avoids repeating namespace metadata unnecessarily.

#### Function details

##### `default_search_text_uses_model_visible_namespace_metadata_once`  (lines 6–48)

```
fn default_search_text_uses_model_visible_namespace_metadata_once()
```

**Purpose**: Verifies the exact default search text generated for a namespace tool with nested schema metadata. It ensures namespace-level metadata is included once and nested function/schema terms are appended in the expected sequence.

**Data flow**: It builds nested `JsonSchema` objects using `JsonSchema::object` and `JsonSchema::string`, mutates their `description` fields, embeds them in a `ToolSpec::Namespace` containing one `ResponsesApiTool`, calls `ToolSearchInfo::from_tool_spec(spec, None)`, unwraps the `Option` with `expect`, and asserts that `search_info.entry.search_text` equals the expected literal string. It returns no value and mutates only local test data.

**Call relations**: This unit test drives the default search-text generation path through `ToolSearchInfo::from_tool_spec`, covering namespace handling, function text expansion, and recursive schema traversal.

*Call graph*: calls 3 internal fn (object, string, from_tool_spec); 4 external calls (from, assert_eq!, Namespace, vec!).


### `tools/src/dynamic_tool_tests.rs`

`test` · `test execution`

This test file exercises `parse_dynamic_tool` with small, concrete `DynamicToolFunctionSpec` inputs and compares the parsed result against fully constructed `ToolDefinition` values. The first test demonstrates an important normalization rule: an input schema that only declares `properties.id.description` but omits explicit type information is accepted and lowered into an object schema whose `id` property becomes an empty permissive `JsonSchema::default()`. That confirms the parser strips unsupported descriptive-only child schema content rather than rejecting it. The second test isolates the `defer_loading` field and proves that parsing does not overwrite or default it away when the incoming schema is already a minimal object with empty properties. Both tests build expected schemas with `JsonSchema::object` and `BTreeMap`, so they also document the exact internal representation used for parsed tools: no output schema, object-typed input schema, and `required` / `additional_properties` left as `None` unless explicitly present. The file is narrowly focused regression coverage for parser behavior that would otherwise be easy to change accidentally during schema normalization work.

#### Function details

##### `parse_dynamic_tool_sanitizes_input_schema`  (lines 9–37)

```
fn parse_dynamic_tool_sanitizes_input_schema()
```

**Purpose**: Builds a dynamic tool spec whose property schema contains only a description and asserts that parsing produces a sanitized object schema with an empty child schema for `id`.

**Data flow**: Creates a `DynamicToolFunctionSpec` with `name`, `description`, `defer_loading: false`, and a JSON input schema containing only `properties.id.description`. It passes that spec by reference into `parse_dynamic_tool`, unwraps the `Result`, and compares the returned `ToolDefinition` against an expected value whose `input_schema` is `JsonSchema::object(BTreeMap::from([("id", JsonSchema::default())]), None, None)` and whose `output_schema` is `None`.

**Call relations**: This is a standalone unit test invoked by Rust’s test harness. Its only delegated work is the parser under test plus assertion macros; it exists to pin down the sanitization path where descriptive-but-untyped property schemas are coerced into permissive placeholders.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `parse_dynamic_tool_preserves_defer_loading`  (lines 40–65)

```
fn parse_dynamic_tool_preserves_defer_loading()
```

**Purpose**: Checks that `parse_dynamic_tool` preserves a true `defer_loading` flag while parsing an otherwise minimal object schema.

**Data flow**: Constructs a `DynamicToolFunctionSpec` with `defer_loading: true` and an input schema `{ "type": "object", "properties": {} }`. It feeds that into `parse_dynamic_tool`, unwraps success, and asserts equality with a `ToolDefinition` containing an empty-object `JsonSchema`, `output_schema: None`, and `defer_loading: true`.

**Call relations**: This test is also run directly by the test harness. It complements the schema-sanitization test by isolating a non-schema field and ensuring parser normalization does not alter lifecycle/loading metadata on the resulting tool definition.

*Call graph*: 2 external calls (assert_eq!, json!).


### `tools/src/mcp_tool_tests.rs`

`test` · `test execution`

This test module exercises the MCP bridge in `mcp_tool.rs`. The helper `mcp_tool` constructs `rmcp::model::Tool` instances from a name, description, and JSON input schema by wrapping the schema with `rmcp::model::object` and `Arc`, matching the production MCP type shape. The first test proves that `parse_mcp_tool` inserts an empty top-level `properties` object when an MCP input schema declares only `type: object`; the expected parsed input is therefore `JsonSchema::object(BTreeMap::new(), None, None)`. The remaining tests focus on output handling. They mutate the helper-built tool to attach an `output_schema` and then assert that `parse_mcp_tool` does not sanitize, infer, or otherwise rewrite that schema before embedding it under `structuredContent` in the envelope returned by `mcp_call_tool_result_output_schema`. One case uses a nested `properties`/`required` object schema, and another uses an enum-only schema with no inferred type, demonstrating that output schemas are preserved verbatim at the top level. Together these tests document the asymmetry between input parsing, which is normalized aggressively, and output wrapping, which preserves MCP-provided structure.

#### Function details

##### `mcp_tool`  (lines 8–14)

```
fn mcp_tool(name: &str, description: &str, input_schema: serde_json::Value) -> rmcp::model::Tool
```

**Purpose**: Creates a minimal `rmcp::model::Tool` fixture from plain strings and a JSON input schema.

**Data flow**: Accepts `name`, `description`, and `input_schema` JSON, converts the strings to owned `String`s, wraps the schema with `rmcp::model::object`, then wraps that object in `Arc` and passes everything to `rmcp::model::Tool::new`. It returns the constructed MCP tool fixture.

**Call relations**: This helper is called by all tests in the file to avoid repeating MCP tool construction boilerplate. Individual tests may then mutate the returned tool, such as by attaching an `output_schema`.

*Call graph*: called by 3 (parse_mcp_tool_inserts_empty_properties, parse_mcp_tool_preserves_output_schema_without_inferred_type, parse_mcp_tool_preserves_top_level_output_schema); 3 external calls (new, object, new).


##### `parse_mcp_tool_inserts_empty_properties`  (lines 17–40)

```
fn parse_mcp_tool_inserts_empty_properties()
```

**Purpose**: Verifies that MCP input schemas missing top-level `properties` are patched to an empty object before parsing.

**Data flow**: Builds an MCP tool fixture with input schema `{ "type": "object" }`, passes it to `parse_mcp_tool`, unwraps success, and asserts the returned `ToolDefinition` contains an empty-object `JsonSchema` input schema and the default wrapped output schema based on `{}`.

**Call relations**: This harness-run test targets the OpenAI-compatibility patch in `parse_mcp_tool` and confirms the resulting internal schema shape.

*Call graph*: calls 1 internal fn (mcp_tool); 2 external calls (assert_eq!, json!).


##### `parse_mcp_tool_preserves_top_level_output_schema`  (lines 43–87)

```
fn parse_mcp_tool_preserves_top_level_output_schema()
```

**Purpose**: Checks that a provided MCP output schema object is embedded unchanged under `structuredContent` in the standard output envelope.

**Data flow**: Creates a base MCP tool with `mcp_tool`, assigns `tool.output_schema` to an `Arc`-wrapped object schema containing nested `properties` and `required`, parses the tool, and asserts the resulting `ToolDefinition.output_schema` equals `Some(mcp_call_tool_result_output_schema(...))` with the same raw output schema JSON.

**Call relations**: This test demonstrates that output handling in `parse_mcp_tool` is a wrapper operation, not a normalization pass, even when the output schema itself contains nested object structure.

*Call graph*: calls 1 internal fn (mcp_tool); 4 external calls (assert_eq!, object, json!, new).


##### `parse_mcp_tool_preserves_output_schema_without_inferred_type`  (lines 90–120)

```
fn parse_mcp_tool_preserves_output_schema_without_inferred_type()
```

**Purpose**: Ensures output schemas that omit `type` entirely, such as enum-only schemas, are still preserved verbatim inside the MCP result envelope.

**Data flow**: Builds an MCP tool fixture, sets `tool.output_schema` to an enum-only JSON schema, parses it with `parse_mcp_tool`, and asserts the resulting `ToolDefinition` contains the expected empty-object input schema and an output schema wrapping the raw enum-only JSON unchanged.

**Call relations**: This test complements the previous output-schema test by showing that no type inference or sanitation is applied to MCP output schemas before wrapping.

*Call graph*: calls 1 internal fn (mcp_tool); 4 external calls (assert_eq!, object, json!, new).


### `tools/src/code_mode_tests.rs`

`test` · `test execution`

This file is a focused unit-test module for two sibling functions imported from the parent module: one that augments a `ToolSpec` for code mode, and one that converts a `ToolSpec` into a `codex_code_mode::ToolDefinition`. The tests construct concrete `ToolSpec` values across supported and unsupported variants and compare the full transformed structures with exact expected values using `pretty_assertions::assert_eq`, so failures show structural diffs rather than opaque mismatches.

The test data exercises both major supported shapes: `ToolSpec::Function`, backed by `ResponsesApiTool` with a `JsonSchema::object` parameter schema and a JSON output schema, and `ToolSpec::Freeform`, backed by `FreeformTool` and `FreeformToolFormat`. The assertions check that code-mode augmentation appends a literal fenced TypeScript declaration to ordinary tool descriptions, preserving existing fields such as `strict`, `defer_loading`, parameter schemas, and output schemas unchanged. A key invariant captured here is that the special exec/code tool identified by `codex_code_mode::PUBLIC_TOOL_NAME` must not have its description rewritten, preventing recursive or redundant self-description. Another test confirms that nested freeform tools become `codex_code_mode::ToolDefinition` values with the expected `ToolName`, `CodeModeToolKind::Freeform`, and absent schemas. Finally, unsupported variants like `ToolSpec::ToolSearch` must be rejected by returning `None` rather than producing a partial or misleading code-mode definition.

#### Function details

##### `augment_tool_spec_for_code_mode_augments_function_tools`  (lines 15–66)

```
fn augment_tool_spec_for_code_mode_augments_function_tools()
```

**Purpose**: Checks that a normal function-style tool is rewritten for code mode by appending an `exec tool declaration` block to its description while leaving the rest of the tool specification intact.

**Data flow**: Builds a `ToolSpec::Function` containing a `ResponsesApiTool` with name, plain description, `strict` and `defer_loading` flags, an object-shaped `JsonSchema` parameter definition keyed by `order_id`, and a JSON output schema with required boolean field `ok`. It passes that value into `augment_tool_spec_for_code_mode` and compares the returned `ToolSpec::Function` against an expected structure whose only semantic change is the expanded multiline description containing a TypeScript declaration `lookup_order(args: { order_id: string; }): Promise<{ ok: boolean; }>;`.

**Call relations**: This is a standalone unit test invoked by the Rust test harness. Its only direct action is an equality assertion around `augment_tool_spec_for_code_mode`, and it validates the positive path for function-tool augmentation.

*Call graph*: 1 external calls (assert_eq!).


##### `augment_tool_spec_for_code_mode_preserves_exec_tool_description`  (lines 69–90)

```
fn augment_tool_spec_for_code_mode_preserves_exec_tool_description()
```

**Purpose**: Checks that the special public code-mode exec tool is exempt from description augmentation and is returned unchanged.

**Data flow**: Constructs a `ToolSpec::Freeform` whose `name` is `codex_code_mode::PUBLIC_TOOL_NAME`, with description `Run code` and a grammar-based `FreeformToolFormat`. It feeds that spec to `augment_tool_spec_for_code_mode` and asserts exact equality with the original value, confirming that neither description nor format fields are modified.

**Call relations**: This test is run directly by the test harness and covers the guard condition inside `augment_tool_spec_for_code_mode` for the reserved exec tool. It complements the previous test by proving the non-augmentation branch.

*Call graph*: 1 external calls (assert_eq!).


##### `tool_spec_to_code_mode_tool_definition_returns_augmented_nested_tools`  (lines 93–121)

```
fn tool_spec_to_code_mode_tool_definition_returns_augmented_nested_tools()
```

**Purpose**: Checks that a supported nested freeform tool is converted into a `codex_code_mode::ToolDefinition` with code-mode description text and the expected metadata.

**Data flow**: Creates a `ToolSpec::Freeform` named `apply_patch` with a grammar/lark format and stores it in `spec`. It passes `&spec` to `tool_spec_to_code_mode_tool_definition` and asserts that the result is `Some(ToolDefinition)` containing the original name, `ToolName::plain("apply_patch")`, an augmented description with a TypeScript declaration `apply_patch(input: string): Promise<unknown>;`, `CodeModeToolKind::Freeform`, and `None` for both input and output schemas.

**Call relations**: This test is invoked by the test harness and exercises the successful conversion path of `tool_spec_to_code_mode_tool_definition` for a supported freeform tool. It verifies not just presence of `Some`, but the exact shape of the produced code-mode definition.

*Call graph*: 2 external calls (assert_eq!, Freeform).


##### `tool_spec_to_code_mode_tool_definition_skips_unsupported_variants`  (lines 124–137)

```
fn tool_spec_to_code_mode_tool_definition_skips_unsupported_variants()
```

**Purpose**: Checks that unsupported `ToolSpec` variants are filtered out rather than converted into code-mode tool definitions.

**Data flow**: Constructs a `ToolSpec::ToolSearch` with execution mode `sync`, description `Search`, and an empty object `JsonSchema`. It passes a reference to `tool_spec_to_code_mode_tool_definition` and asserts that the function returns `None`, indicating no code-mode representation is produced.

**Call relations**: This test is run by the test harness and covers the rejection branch of `tool_spec_to_code_mode_tool_definition`. It establishes that unsupported variants are intentionally omitted from downstream code-mode tooling.

*Call graph*: 1 external calls (assert_eq!).


### `tools/src/responses_api_tests.rs`

`test` · `test execution`

This file is a compact but important regression suite for `responses_api.rs`. The first test verifies the base conversion from `ToolDefinition` to `ResponsesApiTool`, especially the subtle `defer_loading` mapping: an internal `false` must become `None` so the field is omitted from serialized output rather than emitted as `false`. The second test covers the dynamic-tool path by constructing a `DynamicToolFunctionSpec` with a JSON object schema and `defer_loading: true`; it confirms that parsing preserves the schema structure and that the resulting API tool carries `Some(true)`. The third test performs the same check for MCP tools, creating an `rmcp::model::Tool` with an object schema and converting it through the deferred MCP adapter while also verifying that namespacing in `ToolName` is stripped down to the final tool name. The last test checks serde output for nested namespace specs: a `LoadableToolSpec::Namespace` containing a deferred child `ResponsesApiTool` must serialize with top-level `type: "namespace"`, child `type: "function"`, and an explicit `defer_loading: true` field on the child tool. Together these tests lock down both conversion semantics and the exact JSON shape emitted to downstream API consumers.

#### Function details

##### `tool_definition_to_responses_api_tool_omits_false_defer_loading`  (lines 17–49)

```
fn tool_definition_to_responses_api_tool_omits_false_defer_loading()
```

**Purpose**: Checks that converting a non-deferred `ToolDefinition` yields a `ResponsesApiTool` whose `defer_loading` field is `None` rather than `Some(false)`. This preserves the intended omission behavior during serialization.

**Data flow**: Constructs a `ToolDefinition` with a one-property object `JsonSchema`, an output schema, and `defer_loading: false`; passes it to `tool_definition_to_responses_api_tool`; then compares the returned `ResponsesApiTool` against an expected struct where all fields match but `defer_loading` is `None`.

**Call relations**: The test harness invokes this as the baseline conversion test for the Responses API adapter. It targets the central mapping function directly rather than going through dynamic or MCP parsing.

*Call graph*: 1 external calls (assert_eq!).


##### `dynamic_tool_to_responses_api_tool_preserves_defer_loading`  (lines 52–85)

```
fn dynamic_tool_to_responses_api_tool_preserves_defer_loading()
```

**Purpose**: Verifies that the dynamic-tool conversion path preserves a `defer_loading: true` flag and correctly parses the JSON input schema into `JsonSchema`. It ensures the dynamic adapter does not lose deferred-loading intent.

**Data flow**: Builds a `DynamicToolFunctionSpec` with a JSON object schema and `defer_loading: true`, calls `dynamic_tool_to_responses_api_tool`, unwraps the `Result` with `expect`, and asserts equality with an expected `ResponsesApiTool` containing `Some(true)` and the parsed object schema.

**Call relations**: This test is run by the harness to cover the `dynamic_tool_to_responses_api_tool` path specifically. It complements the direct `ToolDefinition` test by validating the parse-plus-convert pipeline.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `mcp_tool_to_deferred_responses_api_tool_sets_defer_loading`  (lines 88–124)

```
fn mcp_tool_to_deferred_responses_api_tool_sets_defer_loading()
```

**Purpose**: Confirms that the deferred MCP conversion path marks the resulting API tool as deferred and preserves the parsed input schema. It also checks that the final tool name is the leaf name from the provided `ToolName`.

**Data flow**: Creates an `rmcp::model::Tool` with a JSON object schema wrapped in an `Arc`, calls `mcp_tool_to_deferred_responses_api_tool` with a namespaced `ToolName`, unwraps the result, and compares it to an expected `ResponsesApiTool` whose `name` is `lookup_order`, `defer_loading` is `Some(true)`, and `output_schema` is `None`.

**Call relations**: The test harness invokes this to validate the MCP-specific deferred adapter. It covers the combined effects of MCP parsing, renaming, and `into_deferred` transformation.

*Call graph*: 5 external calls (assert_eq!, json!, new, object, new).


##### `loadable_tool_spec_namespace_serializes_with_deferred_child_tools`  (lines 127–168)

```
fn loadable_tool_spec_namespace_serializes_with_deferred_child_tools()
```

**Purpose**: Checks the exact JSON serialization of a namespace spec containing a deferred child function tool. It ensures serde tagging and omission rules produce the expected wire format.

**Data flow**: Constructs a `LoadableToolSpec::Namespace` containing one `ResponsesApiNamespaceTool::Function` with `defer_loading: Some(true)` and an empty object schema, serializes it with `serde_json::to_value`, and asserts that the resulting `Value` matches a literal JSON object with namespace and child `type` tags plus `defer_loading: true` on the child.

**Call relations**: This test is executed by the harness as a serialization-focused complement to the conversion tests. Rather than calling conversion helpers, it validates the serde annotations on `LoadableToolSpec`, `ResponsesApiNamespaceTool`, and `ResponsesApiTool`.

*Call graph*: 4 external calls (assert_eq!, to_value, Namespace, vec!).


### `tools/tests/json_schema_policy_fixtures.rs`

`test` · `test run`

This test file loads JSON fixtures from disk, deserializes them into local `FixtureFile`, `FixtureTool`, and `ExpectedValue` structs, converts each fixture tool through the real MCP-to-Responses conversion pipeline, and asserts on the resulting parameter schema. The fixtures encode both positive expectations (`expected_preserved`) and negative ones (`expected_pruned`, `expected_dropped_fields`), so the tests validate not just that conversion succeeds, but that it preserves reachable structure while stripping unsupported or unreachable schema content.

`json_schema_policy_fixtures_convert_to_responses_tools` iterates over a fixed list of fixture files, converts every tool, serializes the resulting `responses_tool.parameters`, and checks invariant fields such as tool name, description, `strict: false`, and object-shaped parameters. It then walks JSON pointers to ensure preserved values remain and pruned/dropped fields disappear.

The oversized-schema test targets a specific Notion fixture whose input schema is intentionally large. It measures compact serialized byte length before and after conversion, asserting that compaction reduces size. It also checks the exact consequences of compaction: descriptions and `$defs` are removed, local references are rewritten to `{}`, and top-level argument shape remains recognizable. Helper functions isolate fixture loading, MCP tool construction via `rmcp::model::Tool::new`, and compact JSON byte counting.

#### Function details

##### `json_schema_policy_fixtures_convert_to_responses_tools`  (lines 48–119)

```
fn json_schema_policy_fixtures_convert_to_responses_tools()
```

**Purpose**: Executes the main fixture suite that validates schema conversion behavior across several real-world MCP tool catalogs.

**Data flow**: Iterates over `FIXTURE_PATHS`, loading each file into `FixtureFile`, then for each `FixtureTool` calls `convert_fixture_tool` and serializes `responses_tool.parameters` to `Value`. It compares invariant top-level fields, asserts `parameters.properties` is an object, checks each expected preserved JSON pointer/value pair, and asserts that expected pruned or dropped pointers are absent from the output schema.

**Call relations**: This is the primary integration test entrypoint for schema policy. It is invoked by the test harness, delegates fixture conversion to `convert_fixture_tool`, and uses serde serialization plus JSON-pointer lookups to validate the downstream output.

*Call graph*: calls 1 internal fn (convert_fixture_tool); 4 external calls (assert!, assert_eq!, json!, to_value).


##### `json_schema_policy_oversized_golden_schema_triggers_compaction`  (lines 122–184)

```
fn json_schema_policy_oversized_golden_schema_triggers_compaction()
```

**Purpose**: Verifies that an intentionally oversized schema triggers the converter's compaction behavior and still preserves essential argument shape.

**Data flow**: Loads the oversized fixture with `load_fixture`, selects its first tool, computes compact byte length of the input schema via `compact_json_len`, converts the tool, serializes output parameters, and computes output byte length. It asserts the output is smaller, then checks that selected pointers like `/description`, nested descriptions, and `/$defs` are absent while key rewritten or retained pointers have exact expected values.

**Call relations**: This test targets the converter's fallback path when ordinary pruning is insufficient. It is run by the test harness and delegates file loading, conversion, and byte counting to the local helpers so the assertions stay focused on compaction semantics.

*Call graph*: calls 3 internal fn (compact_json_len, convert_fixture_tool, load_fixture); 4 external calls (assert!, assert_eq!, json!, to_value).


##### `load_fixture`  (lines 186–190)

```
fn load_fixture(path: &str) -> T
```

**Purpose**: Loads and deserializes a JSON fixture file from the repository's test resources into any requested serde-deserializable type.

**Data flow**: Accepts a fixture path string, resolves it with `find_resource!`, reads the file contents with `fs::read_to_string`, and deserializes the JSON text with `serde_json::from_str` into `T: DeserializeOwned`. It panics with descriptive `expect` messages if resolution, reading, or parsing fails.

**Call relations**: This helper is called by the oversized-schema test and also used indirectly in the main fixture loop through iterator mapping. It centralizes resource lookup so tests do not duplicate path resolution and file I/O logic.

*Call graph*: called by 1 (json_schema_policy_oversized_golden_schema_triggers_compaction); 3 external calls (find_resource!, read_to_string, from_str).


##### `convert_fixture_tool`  (lines 192–210)

```
fn convert_fixture_tool(
    fixture: &FixtureFile,
    fixture_tool: &FixtureTool,
) -> codex_tools::ResponsesApiTool
```

**Purpose**: Builds an MCP `Tool` from fixture data and converts it into a `codex_tools::ResponsesApiTool` using the production conversion function.

**Data flow**: Reads the fixture source namespace and tool fields, clones the fixture's `input_schema` object map, wraps it in `Arc`, constructs `rmcp::model::Tool::new(name, description, Arc<input_schema>)`, then calls `mcp_tool_to_responses_api_tool` with a namespaced `ToolName`. It returns the converted Responses API tool or panics if conversion fails.

**Call relations**: Both fixture tests call this helper to exercise the real conversion pipeline. It bridges static fixture JSON into the exact runtime types expected by `mcp_tool_to_responses_api_tool`, ensuring the tests cover production code rather than a mocked path.

*Call graph*: calls 1 internal fn (namespaced); called by 2 (json_schema_policy_fixtures_convert_to_responses_tools, json_schema_policy_oversized_golden_schema_triggers_compaction); 3 external calls (new, mcp_tool_to_responses_api_tool, new).


##### `compact_json_len`  (lines 212–216)

```
fn compact_json_len(value: &Value) -> usize
```

**Purpose**: Measures the byte length of a JSON value when serialized without pretty-printing.

**Data flow**: Takes a borrowed `serde_json::Value`, serializes it to a compact `Vec<u8>` with `serde_json::to_vec`, and returns the resulting vector length. It panics if serialization fails.

**Call relations**: This helper is used only by the oversized-schema test to compare input and output schema sizes. It keeps the compaction assertion grounded in actual wire-size reduction rather than structural heuristics.

*Call graph*: called by 1 (json_schema_policy_oversized_golden_schema_triggers_compaction); 1 external calls (to_vec).


### End-to-end command application
This final group contains the repository-level end-to-end test for applying task-generated diffs into Git working trees.

### `chatgpt/tests/suite/apply_command_e2e.rs`

`test` · `test run`

This integration test module exercises `codex_chatgpt::apply_command::apply_diff_from_task` against an actual temporary Git repo rather than mocks. `create_temp_git_repo` creates an isolated repository in a `TempDir`, disables global/system Git config via `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, configures a local author identity, writes `README.md`, stages it, and creates an initial commit. That setup ensures deterministic Git behavior independent of the developer machine. `mock_get_task_with_fixture` loads `tests/task_turn_fixture.json` using `find_resource!`, reads it asynchronously, and deserializes it into `GetTaskResponse` with `serde_json`.

The first async test applies the fixture diff to the repo and then inspects the filesystem directly: it expects `scripts/fibonacci.js` to exist, contain a Node shebang, a `function fibonacci(n)` definition, and `module.exports = fibonacci;`, and to have exactly 31 lines as specified by the fixture. The second test pre-creates and commits a conflicting `scripts/fibonacci.js`, then runs the same apply path expecting failure. It temporarily switches the process current directory to the repo using a local `DirGuard` so the original directory is restored on drop, and finally asserts that the file contains standard Git conflict markers. The design intentionally validates both semantic content and Git conflict surfacing, not just return codes.

#### Function details

##### `create_temp_git_repo`  (lines 8–68)

```
async fn create_temp_git_repo() -> anyhow::Result<TempDir>
```

**Purpose**: Builds a disposable Git repository with one committed `README.md` so apply-command tests start from a known baseline. It also neutralizes ambient Git configuration to keep the test hermetic.

**Data flow**: The function creates a `TempDir`, derives `repo_path`, and prepares a fixed environment vector overriding Git config lookup. It runs `git init`, checks the exit status and bails with stderr text on failure, then runs `git config user.email`, `git config user.name`, writes `README.md`, stages it with `git add`, and commits with `git commit -m "Initial commit"`, again bailing if the commit fails. On success it returns the `TempDir`, whose lifetime keeps the repository on disk for the caller.

**Call relations**: Both end-to-end tests call this helper before invoking `apply_diff_from_task`. It does not delegate to project-local helpers; instead it directly orchestrates external `git` commands and filesystem writes so the tests can exercise the real patch-application path.

*Call graph*: called by 2 (test_apply_command_creates_fibonacci_file, test_apply_command_with_merge_conflicts); 5 external calls (new, bail!, new, write, vec!).


##### `mock_get_task_with_fixture`  (lines 70–75)

```
async fn mock_get_task_with_fixture() -> anyhow::Result<GetTaskResponse>
```

**Purpose**: Loads the canned task fixture used by the apply-command tests and converts it into the typed API response expected by the production code. It centralizes fixture lookup and parsing.

**Data flow**: The function resolves `tests/task_turn_fixture.json` via `find_resource!`, reads the file contents asynchronously with `tokio::fs::read_to_string`, deserializes the JSON string into `GetTaskResponse` using `serde_json::from_str`, and returns that typed value. Errors from resource lookup, I/O, or parsing propagate through `anyhow::Result`.

**Call relations**: Each test calls this helper after repository setup and before invoking `apply_diff_from_task`. It feeds the exact fixture payload into the production apply path, avoiding duplicated fixture-loading code in the tests.

*Call graph*: called by 2 (test_apply_command_creates_fibonacci_file, test_apply_command_with_merge_conflicts); 3 external calls (find_resource!, from_str, read_to_string).


##### `test_apply_command_creates_fibonacci_file`  (lines 78–117)

```
async fn test_apply_command_creates_fibonacci_file()
```

**Purpose**: Confirms that applying the fixture task to a clean repository creates the expected `scripts/fibonacci.js` file with the expected content and line count. It is the success-path integration test for the apply command.

**Data flow**: The test awaits `create_temp_git_repo` to obtain a temporary repo path, awaits `mock_get_task_with_fixture` to obtain a `GetTaskResponse`, and passes both into `apply_diff_from_task`. After the apply succeeds, it constructs `scripts/fibonacci.js`, checks existence, reads the file with `std::fs::read_to_string`, and asserts the presence of specific substrings plus an exact `lines().count()` of 31. It writes no additional state beyond whatever the production apply function changes in the repo.

**Call relations**: This test is driven by the Tokio test harness. It sequences the two local setup helpers and then delegates the core behavior to `apply_diff_from_task`, finally validating the resulting filesystem state with assertions.

*Call graph*: calls 3 internal fn (apply_diff_from_task, create_temp_git_repo, mock_get_task_with_fixture); 3 external calls (assert!, assert_eq!, read_to_string).


##### `test_apply_command_with_merge_conflicts`  (lines 120–188)

```
async fn test_apply_command_with_merge_conflicts()
```

**Purpose**: Verifies that applying the same fixture against a repository containing a conflicting committed file fails and leaves merge-conflict markers in the target file. It covers the error path where patch application cannot cleanly merge.

**Data flow**: The test creates a temp repo, manually creates `scripts/`, writes a conflicting `scripts/fibonacci.js`, stages and commits it with `git`, then captures the original current directory and switches into the repo, restoring it later via a local `DirGuard` `Drop` implementation. It loads the fixture response, calls `apply_diff_from_task`, asserts that the result is an error, reads the conflicted file back, and asserts that it contains one of the standard conflict marker strings such as `<<<<<<< HEAD`, `=======`, or `>>>>>>> `. The test mutates repository contents and process cwd as part of setup and cleanup.

**Call relations**: Like the success test, this one is invoked by the Tokio test harness and uses `create_temp_git_repo` plus `mock_get_task_with_fixture`. Its distinguishing control flow is the extra conflicting commit setup before delegating to `apply_diff_from_task`, followed by assertions on the failure result and conflict-marked file contents.

*Call graph*: calls 3 internal fn (apply_diff_from_task, create_temp_git_repo, mock_get_task_with_fixture); 7 external calls (assert!, new, current_dir, set_current_dir, create_dir_all, read_to_string, write).
