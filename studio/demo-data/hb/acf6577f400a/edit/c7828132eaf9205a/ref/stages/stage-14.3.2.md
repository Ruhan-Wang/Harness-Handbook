# Plugin and connector ecosystem management  `stage-14.3.2`

This stage is the system’s “app store and adapter hub.” It is mostly behind-the-scenes support, but it also powers the command-line and text UI screens where people browse, install, remove, and share plugins and connectors.

At the center, lib.rs exposes the whole plugin subsystem, while manager.rs coordinates the big jobs: loading installed plugins, reading marketplaces, refreshing caches, and running install or uninstall flows. loader.rs does the lower-level work of turning plugin IDs and marketplace entries into usable capabilities. manifest.rs, marketplace.rs, and provider.rs read plugin and marketplace files from disk and turn them into clean, checked data the rest of the system can trust.

Several files manage marketplace lifecycle: marketplace_add, marketplace_upgrade, marketplace_remove, plus metadata, source, and git helpers. remote.rs, remote_legacy.rs, remote_bundle.rs, and the remote sharing files handle plugins that come from online services, including downloading bundles safely, syncing local caches, and sharing a workspace plugin with others.

The connector side decides which app connectors are discoverable and allowed, using connectors.rs, app_tool_policy.rs, mcp_connector.rs, app_mcp_routing.rs, and plugin_namespace.rs. Finally, discoverable files, mention parsing, install-suggestion tools, plugin_cmd.rs, and the TUI plugin screen present this ecosystem to users and guide them toward relevant installs.

## Files in this stage

### Plugin subsystem foundations
These files define the core crate surface and the low-level manifest, provider, routing, marketplace, loader, and manager layers that everything else in plugin and connector management builds on.

### `core-plugins/src/lib.rs`

`orchestration` · `compile-time API surface / cross-cutting`

This crate root is mostly structural. It declares internal modules such as `app_mcp_routing`, `discoverable`, `manager`, and `plugin_bundle_archive`, and publicly exposes submodules like `installed_marketplaces`, `loader`, `manifest`, `marketplace`, `remote`, `startup_sync`, and `toggles`. It also defines the three canonical marketplace-name constants used throughout the crate: `OPENAI_CURATED_MARKETPLACE_NAME`, `OPENAI_API_CURATED_MARKETPLACE_NAME`, and `OPENAI_BUNDLED_MARKETPLACE_NAME`.

The only executable logic here is `is_openai_curated_marketplace_name`, a small predicate used by cache refresh, conflict resolution, and marketplace selection code to treat the standard curated and API-curated catalogs as one conceptual family. Two type aliases specialize generic plugin types from `codex_plugin` with `codex_config::McpServerConfig`, giving the crate a consistent `LoadedPlugin` and `PluginLoadOutcome` vocabulary.

The remainder of the file is a curated re-export list. It lifts commonly used manager types (`PluginsManager`, `PluginsConfigInput`, install/read outcomes and errors), loader output (`PluginHookLoadOutcome`), discoverable-plugin DTOs, provider types, and remote recommendation types into the crate root. That design keeps callers from needing to know the internal module layout and makes this file the stable API boundary for the plugin subsystem.

#### Function details

##### `is_openai_curated_marketplace_name`  (lines 26–29)

```
fn is_openai_curated_marketplace_name(marketplace_name: &str) -> bool
```

**Purpose**: Tests whether a marketplace name belongs to the built-in curated marketplace family. It treats both the standard curated and API-curated names as equivalent for policy decisions.

**Data flow**: Takes `marketplace_name: &str` → compares it against `OPENAI_CURATED_MARKETPLACE_NAME` and `OPENAI_API_CURATED_MARKETPLACE_NAME` → returns `bool` with no side effects.

**Call relations**: Used across loader and manager code wherever curated marketplaces need special handling, such as cache refresh, conflict resolution, and marketplace-root selection.


### `core-plugins/src/provider.rs`

`domain_logic` · `capability root resolution / plugin loading`

This file implements `ExecutorPluginProvider`, a `PluginProvider` backed by `EnvironmentManager`. Its job is to take a `SelectedCapabilityRoot` whose location is an environment path, validate that path, inspect the environment's filesystem for a discoverable plugin manifest, parse that manifest, and construct a `ResolvedPlugin` tagged as environment-sourced. The provider-specific error enum is detailed and stage-specific: invalid absolute-path syntax, missing environment, root metadata failures, non-directory roots, manifest metadata/read failures, manifest parse failures, and descriptor-construction failures are all distinguished.

`resolve_bound` is the main entrypoint. It first converts the selected root's path string into an `AbsolutePathBuf` with `selected_plugin_root`, rejecting non-absolute executor paths such as `~/...`. It then requires that the referenced environment exists in `EnvironmentManager`, obtains its `ExecutorFileSystem`, and delegates to `resolve_plugin_root`. That helper checks that the root exists and is a directory, then probes each path in `DISCOVERABLE_PLUGIN_MANIFEST_PATHS` in order using environment filesystem metadata calls. The first existing regular file wins; metadata errors other than `NotFound` abort resolution, and a malformed preferred manifest does not fall through to alternates. If no manifest exists, the root is treated as not-a-plugin and returns `Ok(None)`. Otherwise the manifest text is read, parsed with `parse_plugin_manifest`, and converted into `ResolvedPlugin::from_environment`. `ResolvedExecutorPlugin` wraps the resulting descriptor together with the filesystem object so later code can read plugin assets from the same environment context.

#### Function details

##### `ResolvedExecutorPlugin::plugin`  (lines 89–91)

```
fn plugin(&self) -> &ResolvedPlugin
```

**Purpose**: Returns the resolved plugin descriptor stored in the wrapper. It exposes the source-neutral `ResolvedPlugin` without the filesystem binding details.

**Data flow**: Reads `self.plugin` and returns it by shared reference. It does not mutate state.

**Call relations**: Called by downstream loading code after `resolve_bound` succeeds and the caller needs the descriptor portion of the bound result.

*Call graph*: called by 1 (load).


##### `ResolvedExecutorPlugin::file_system`  (lines 94–96)

```
fn file_system(&self) -> &dyn ExecutorFileSystem
```

**Purpose**: Returns the concrete executor filesystem that was used to resolve the plugin. This lets later consumers access plugin files through the same environment abstraction.

**Data flow**: Reads `self.file_system`, dereferences the `Arc`, and returns `&dyn ExecutorFileSystem`.

**Call relations**: Used by downstream loading code alongside `ResolvedExecutorPlugin::plugin` so descriptor and file access stay paired.

*Call graph*: called by 1 (load).


##### `ExecutorPluginProvider::new`  (lines 101–105)

```
fn new(environment_manager: Arc<EnvironmentManager>) -> Self
```

**Purpose**: Constructs a provider bound to an `EnvironmentManager`. It is the dependency-injection point for environment-backed plugin resolution.

**Data flow**: Takes `Arc<EnvironmentManager>`, stores it in the struct, and returns `ExecutorPluginProvider`.

**Call relations**: Called by tests and production setup before any `resolve` or `resolve_bound` calls.

*Call graph*: called by 6 (host_and_executor_sources_parse_the_same_manifest, executor_root_must_be_an_explicit_absolute_path, malformed_preferred_manifest_does_not_fall_through_to_alternate, standalone_capability_root_is_not_a_plugin, unavailable_environment_does_not_fall_back_to_host_filesystem, new).


##### `ExecutorPluginProvider::resolve_bound`  (lines 108–129)

```
async fn resolve_bound(
        &self,
        selected_root: &SelectedCapabilityRoot,
    ) -> Result<Option<ResolvedExecutorPlugin>, ExecutorPluginProviderError>
```

**Purpose**: Resolves a selected environment capability root into a plugin descriptor plus the exact filesystem used to inspect it. It is the provider's richer API beyond the trait method.

**Data flow**: Accepts `&SelectedCapabilityRoot`, extracts `root_id`, computes `plugin_root` via `selected_plugin_root`, destructures the environment location to get `environment_id`, looks up the environment in `self.environment_manager`, obtains its filesystem, and awaits `resolve_plugin_root`. If that returns `Some(plugin)`, it wraps the plugin and filesystem in `ResolvedExecutorPlugin`; if `None`, it returns `Ok(None)`; missing environments and lower-level resolution failures become `ExecutorPluginProviderError` variants.

**Call relations**: This is the main implementation method used directly by some callers and indirectly by the trait `resolve` method. It delegates path validation to `selected_plugin_root` and filesystem/manifest inspection to `resolve_plugin_root`.

*Call graph*: calls 2 internal fn (resolve_plugin_root, selected_plugin_root); called by 2 (resolve, resolve_snapshot).


##### `ExecutorPluginProvider::resolve`  (lines 135–142)

```
async fn resolve(
        &self,
        selected_root: &SelectedCapabilityRoot,
    ) -> Result<Option<ResolvedPlugin>, Self::Error>
```

**Purpose**: Implements the `PluginProvider` trait by resolving an environment capability root into a plain `ResolvedPlugin`. It discards the bound filesystem wrapper after successful resolution.

**Data flow**: Takes `&SelectedCapabilityRoot`, awaits `self.resolve_bound(selected_root)`, and maps `Option<ResolvedExecutorPlugin>` into `Option<ResolvedPlugin>` by moving out the inner `plugin` field.

**Call relations**: This trait method is invoked by generic plugin-loading code. It is a thin adapter over `resolve_bound`.

*Call graph*: calls 1 internal fn (resolve_bound).


##### `selected_plugin_root`  (lines 145–165)

```
fn selected_plugin_root(
    selected_root: &SelectedCapabilityRoot,
) -> Result<AbsolutePathBuf, ExecutorPluginProviderError>
```

**Purpose**: Validates and converts the selected capability root's environment path string into an `AbsolutePathBuf`. It enforces that executor paths are explicit absolute filesystem paths.

**Data flow**: Reads `selected_root.id` and the `path` string from `CapabilityRootLocation::Environment`, constructs a `PathBuf`, checks `is_absolute()`, and returns `ExecutorPluginProviderError::InvalidRootPath` if not absolute. Otherwise it calls `AbsolutePathBuf::from_absolute_path_checked` and maps any validation error into the same error variant with the original root ID and path string.

**Call relations**: Called first by `ExecutorPluginProvider::resolve_bound` before any environment lookup or filesystem access.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); called by 1 (resolve_bound); 1 external calls (from).


##### `resolve_plugin_root`  (lines 167–246)

```
async fn resolve_plugin_root(
    selected_root: &SelectedCapabilityRoot,
    plugin_root: AbsolutePathBuf,
    file_system: &dyn ExecutorFileSystem,
) -> Result<Option<ResolvedPlugin>, ExecutorPlugin
```

**Purpose**: Inspects one environment filesystem root to determine whether it contains a discoverable plugin manifest and, if so, parses and converts it into a `ResolvedPlugin`. It is the core environment-backed resolution routine.

**Data flow**: Inputs are the selected root metadata, an absolute plugin root, and `&dyn ExecutorFileSystem`. It converts the root to `PathUri`, fetches metadata, and errors with `InspectRoot` or `RootNotDirectory` if the root is inaccessible or not a directory. It then iterates `DISCOVERABLE_PLUGIN_MANIFEST_PATHS`, joining each candidate to the root and probing metadata through the executor filesystem. The first candidate that exists as a file is selected; `NotFound` is ignored, other metadata errors become `InspectManifest`, and no manifest yields `Ok(None)`. For the chosen manifest it reads text with `read_file_text`, parses it with `parse_plugin_manifest`, and constructs `ResolvedPlugin::from_environment` using the selected root ID, environment ID, plugin root, manifest path, and parsed manifest. Read, parse, and descriptor-construction failures are mapped into specific provider errors.

**Call relations**: Called by `ExecutorPluginProvider::resolve_bound` after environment lookup. It is the main logic path tested by `provider_tests.rs`, including manifest precedence and environment-filesystem-only behavior.

*Call graph*: calls 5 internal fn (parse_plugin_manifest, read_file_text, from_environment, join, from_abs_path); called by 1 (resolve_bound); 1 external calls (get_metadata).


### `core-plugins/src/manifest.rs`

`domain_logic` · `plugin load`

This file defines host-local aliases for `codex_plugin::manifest` types parameterized by `AbsolutePathBuf`, then implements tolerant parsing around a `RawPluginManifest` shape. The parser intentionally keeps some fields as raw JSON-backed enums first—especially `skills`, `hooks`, and `interface.defaultPrompt`—so it can validate syntax and log warnings instead of failing the whole manifest.

`load_plugin_manifest` discovers a manifest path using `find_plugin_manifest_path`, reads the file, and returns `None` on any parse failure after emitting a warning. `parse_plugin_manifest` performs the real normalization: blank manifest names fall back to the plugin root directory name; `version` is trimmed and dropped if empty; interface assets (`composerIcon`, `logo`, `screenshots`) are resolved to absolute paths only if they use `./...` syntax and stay within the plugin root; and `defaultPrompt` accepts either a legacy string or an array of strings, collapsing whitespace, rejecting empty/overlong prompts, and limiting the list to three entries of at most 128 characters each. Manifest component paths for skills, MCP servers, apps, and hooks are similarly validated to reject missing `./`, `..`, or non-normal path components. Hooks can be declared as a single path, multiple paths, inline object, or inline object list. Invalid shapes are ignored with warnings rather than aborting manifest loading.

#### Function details

##### `load_plugin_manifest`  (lines 111–124)

```
fn load_plugin_manifest(plugin_root: &Path) -> Option<PluginManifest>
```

**Purpose**: Loads and parses a plugin manifest from the local filesystem, returning `None` if discovery, file reading, or parsing fails. It is intentionally forgiving and logs parse failures instead of surfacing them as hard errors.

**Data flow**: Takes a plugin root path, discovers a manifest file via `find_plugin_manifest_path`, reads it as UTF-8 text, passes the contents to `parse_plugin_manifest`, and returns `Some(PluginManifest)` on success. On parse failure it emits a warning containing the manifest path and error and returns `None`.

**Call relations**: This is the main entry used by plugin loading, marketplace resolution, telemetry, and tests. It delegates all normalization to `parse_plugin_manifest` after handling discovery and I/O.

*Call graph*: calls 1 internal fn (parse_plugin_manifest); called by 12 (load_declared_plugin_mcp_servers, load_plugin, load_plugin_apps, plugin_telemetry_metadata_from_root, load_sources, read_plugin_detail_for_marketplace_plugin, host_and_executor_sources_parse_the_same_manifest, load_manifest, resolve_marketplace_plugin_entry, extract_remote_plugin_bundle_to_path (+2 more)); 3 external calls (find_plugin_manifest_path, read_to_string, warn!).


##### `parse_plugin_manifest`  (lines 126–230)

```
fn parse_plugin_manifest(
    plugin_root: &Path,
    manifest_path: &Path,
    contents: &str,
) -> Result<PluginManifest, serde_json::Error>
```

**Purpose**: Converts raw JSON manifest contents into a normalized `PluginManifest` with validated paths, trimmed version, optional interface metadata, and fallback naming. It is the core manifest interpretation routine.

**Data flow**: Consumes `plugin_root`, `manifest_path`, and raw JSON `contents`; deserializes into `RawPluginManifest`; derives `name` from the directory name when the raw name is blank; trims and filters `version`; resolves `skills`, `mcpServers`, `apps`, and `hooks` through path validators; resolves interface fields including default prompts and asset paths; and returns a typed `PluginManifest` or a `serde_json::Error` if top-level JSON deserialization fails.

**Call relations**: Called by `load_plugin_manifest` and lower-level executor/plugin-root resolution paths. It delegates field-specific normalization to `resolve_manifest_hooks`, `resolve_manifest_path_value`, `resolve_manifest_path`, `resolve_default_prompts`, and `resolve_interface_asset_path`.

*Call graph*: calls 3 internal fn (resolve_manifest_hooks, resolve_manifest_path, resolve_manifest_path_value); called by 3 (load_plugin_manifest, resolve_plugin_root, plugin_root_resolution_uses_supplied_executor_file_system); 1 external calls (file_name).


##### `resolve_manifest_hooks`  (lines 232–260)

```
fn resolve_manifest_hooks(
    plugin_root: &Path,
    hooks: Option<RawPluginManifestHooks>,
) -> Option<PluginManifestHooks>
```

**Purpose**: Normalizes the manifest `hooks` field across its supported shapes: single path, path list, inline hooks object, or inline hooks list. Invalid or empty forms are ignored.

**Data flow**: Takes the plugin root and optional raw hooks enum; for path forms it resolves each path under the plugin root and wraps them in `PluginManifestHooks::Paths`; for inline forms it wraps one or more `HooksFile` values in `PluginManifestHooks::Inline`; for invalid JSON shapes it logs a warning and returns `None`.

**Call relations**: Used only by `parse_plugin_manifest` to interpret the `hooks` field while preserving tolerant parsing semantics.

*Call graph*: calls 1 internal fn (resolve_manifest_path); called by 1 (parse_plugin_manifest); 4 external calls (Inline, Paths, warn!, vec!).


##### `resolve_interface_asset_path`  (lines 262–268)

```
fn resolve_interface_asset_path(
    plugin_root: &Path,
    field: &'static str,
    path: Option<&str>,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Resolves an interface asset path such as `composerIcon`, `logo`, or a screenshot using the same validation rules as other manifest-relative paths. It exists mainly to make interface parsing clearer.

**Data flow**: Receives the plugin root, field name, and optional string path; forwards them to `resolve_manifest_path` and returns the resulting `AbsolutePathBuf` or `None`.

**Call relations**: Called from `parse_plugin_manifest` while building `PluginManifestInterface`.

*Call graph*: calls 1 internal fn (resolve_manifest_path).


##### `resolve_default_prompts`  (lines 270–325)

```
fn resolve_default_prompts(
    manifest_path: &Path,
    value: Option<&RawPluginManifestDefaultPrompt>,
) -> Option<Vec<String>>
```

**Purpose**: Parses and sanitizes `interface.defaultPrompt`, supporting both a legacy single string and a bounded array of strings. It enforces prompt count and per-prompt validity while skipping bad entries.

**Data flow**: Takes the manifest path and optional raw default-prompt enum; for a single string it normalizes it through `resolve_default_prompt_str`; for a list it iterates entries in order, warns on invalid non-string items, stops after `MAX_DEFAULT_PROMPT_COUNT`, and collects valid normalized prompts; for invalid top-level shapes it warns and returns `None`.

**Call relations**: Called by `parse_plugin_manifest` when constructing interface metadata. It delegates per-string validation to `resolve_default_prompt_str` and warning emission to `warn_invalid_default_prompt`.

*Call graph*: calls 2 internal fn (resolve_default_prompt_str, warn_invalid_default_prompt); 2 external calls (new, format!).


##### `resolve_default_prompt_str`  (lines 327–342)

```
fn resolve_default_prompt_str(manifest_path: &Path, field: &str, prompt: &str) -> Option<String>
```

**Purpose**: Normalizes one default prompt string by collapsing whitespace and enforcing non-empty and maximum-length constraints. Invalid prompts are rejected with warnings.

**Data flow**: Receives the manifest path, field label, and raw prompt string; splits and rejoins whitespace into single spaces, checks for emptiness and character count over `MAX_DEFAULT_PROMPT_LEN`, warns on failure, and returns `Some(normalized_prompt)` or `None`.

**Call relations**: Used by `resolve_default_prompts` for both the legacy single-string form and each array element.

*Call graph*: calls 1 internal fn (warn_invalid_default_prompt); called by 1 (resolve_default_prompts); 1 external calls (format!).


##### `warn_invalid_default_prompt`  (lines 344–349)

```
fn warn_invalid_default_prompt(manifest_path: &Path, field: &str, message: &str)
```

**Purpose**: Emits a standardized warning for ignored default-prompt values. It centralizes the warning format so all prompt validation failures look the same in logs.

**Data flow**: Formats the manifest path, field name, and validation message into a tracing warning and returns no value.

**Call relations**: Called by `resolve_default_prompt_str` and `resolve_default_prompts` whenever prompt content or shape is invalid.

*Call graph*: called by 2 (resolve_default_prompt_str, resolve_default_prompts); 1 external calls (warn!).


##### `json_value_type`  (lines 351–360)

```
fn json_value_type(value: &JsonValue) -> &'static str
```

**Purpose**: Maps a `serde_json::Value` to a human-readable JSON type name for warning messages. It keeps parse warnings concrete and consistent.

**Data flow**: Matches the input `JsonValue` variant and returns one of the static strings `null`, `boolean`, `number`, `string`, `array`, or `object`.

**Call relations**: Used by manifest field validators when reporting invalid JSON shapes.


##### `resolve_manifest_path_value`  (lines 362–377)

```
fn resolve_manifest_path_value(
    plugin_root: &Path,
    field: &'static str,
    path: Option<&RawPluginManifestPath>,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Handles manifest path fields that were first parsed into a tagged raw enum so invalid non-string JSON can be warned about and ignored. It is currently used for the `skills` field.

**Data flow**: Takes the plugin root, field name, and optional `RawPluginManifestPath`; if it is a string path, forwards to `resolve_manifest_path`; if it is an invalid JSON value, logs a warning naming the actual JSON type and returns `None`.

**Call relations**: Called by `parse_plugin_manifest` for fields whose raw shape must be validated before path resolution.

*Call graph*: calls 1 internal fn (resolve_manifest_path); called by 1 (parse_plugin_manifest); 1 external calls (warn!).


##### `resolve_manifest_path`  (lines 379–420)

```
fn resolve_manifest_path(
    plugin_root: &Path,
    field: &'static str,
    path: Option<&str>,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Validates and resolves a manifest-relative path into an absolute path under the plugin root. It enforces the `./...` syntax and rejects traversal or non-normal components.

**Data flow**: Accepts the plugin root, field name, and optional string path; returns `None` for missing or empty paths; requires a `./` prefix; rejects bare `./`, `..`, root-like, or other non-`Normal` path components; joins the normalized relative path to the plugin root; converts it to `AbsolutePathBuf`; and logs warnings for every invalid case.

**Call relations**: This is the shared path validator used by `parse_plugin_manifest`, `resolve_manifest_hooks`, `resolve_manifest_path_value`, and `resolve_interface_asset_path`.

*Call graph*: calls 1 internal fn (try_from); called by 4 (parse_plugin_manifest, resolve_interface_asset_path, resolve_manifest_hooks, resolve_manifest_path_value); 4 external calls (join, new, new, warn!).


##### `tests::write_manifest`  (lines 444–460)

```
fn write_manifest(plugin_root: &Path, version: Option<&str>, interface: &str)
```

**Purpose**: Creates a test plugin manifest file with optional version and caller-supplied interface JSON. It is the primary fixture writer for manifest parser tests.

**Data flow**: Creates `.codex-plugin` under the provided plugin root, formats a JSON manifest string containing `name`, optional `version`, and `interface`, and writes it to `.codex-plugin/plugin.json`.

**Call relations**: Used by most tests in this module to generate manifests with controlled interface/default-prompt/version content.

*Call graph*: 4 external calls (join, format!, create_dir_all, write).


##### `tests::write_alternate_plugin_manifest`  (lines 462–467)

```
fn write_alternate_plugin_manifest(plugin_root: &Path, contents: &str)
```

**Purpose**: Writes a manifest to an alternate discoverable path to verify manifest discovery is not limited to `.codex-plugin/plugin.json`. It supports fallback-path tests.

**Data flow**: Builds the alternate manifest path under `.claude-plugin/plugin.json`, creates parent directories, and writes the provided contents verbatim.

**Call relations**: Used by the alternate-manifest discovery test.

*Call graph*: 3 external calls (join, create_dir_all, write).


##### `tests::load_manifest`  (lines 469–471)

```
fn load_manifest(plugin_root: &Path) -> PluginManifest
```

**Purpose**: Small test helper that loads a manifest and unwraps success. It keeps parser tests concise.

**Data flow**: Calls `load_plugin_manifest(plugin_root)` and panics if it returns `None`, otherwise returning the parsed `PluginManifest`.

**Call relations**: Used by most tests in this module after fixture creation.

*Call graph*: calls 1 internal fn (load_plugin_manifest).


##### `tests::plugin_interface_accepts_legacy_default_prompt_string`  (lines 474–493)

```
fn plugin_interface_accepts_legacy_default_prompt_string()
```

**Purpose**: Verifies the parser accepts the legacy single-string `defaultPrompt` form and normalizes whitespace. The resulting interface should contain a one-element prompt list.

**Data flow**: Creates a temp plugin manifest with `defaultPrompt` as a padded string, loads it, extracts the interface, and asserts `default_prompt == Some(["Summarize my inbox"])`.

**Call relations**: This test exercises the single-string branch of `resolve_default_prompts`.

*Call graph*: 4 external calls (assert_eq!, load_manifest, write_manifest, tempdir).


##### `tests::plugin_interface_normalizes_default_prompt_array`  (lines 496–530)

```
fn plugin_interface_normalizes_default_prompt_array()
```

**Purpose**: Checks array-form default prompts are normalized, invalid entries are skipped, overlong/blank prompts are rejected, and only the first three valid prompts are kept. It validates both filtering and count limiting.

**Data flow**: Writes a manifest whose `defaultPrompt` array contains valid strings, a number, an overlong string, a blank string, and extra valid strings beyond the limit; loads the manifest; and asserts only the first three valid normalized prompts remain.

**Call relations**: This test covers the list-processing branch of `resolve_default_prompts` and the validation logic in `resolve_default_prompt_str`.

*Call graph*: 5 external calls (assert_eq!, load_manifest, write_manifest, format!, tempdir).


##### `tests::plugin_interface_ignores_invalid_default_prompt_shape`  (lines 533–549)

```
fn plugin_interface_ignores_invalid_default_prompt_shape()
```

**Purpose**: Verifies that an object-valued `defaultPrompt` is ignored rather than causing manifest load failure. The interface remains present but without default prompts.

**Data flow**: Writes a manifest with `defaultPrompt` as an object, loads it, extracts the interface, and asserts `default_prompt` is `None`.

**Call relations**: This test covers the invalid-top-level-shape branch of `resolve_default_prompts`.

*Call graph*: 4 external calls (assert_eq!, load_manifest, write_manifest, tempdir).


##### `tests::plugin_manifest_reads_trimmed_version`  (lines 552–566)

```
fn plugin_manifest_reads_trimmed_version()
```

**Purpose**: Checks that manifest versions are trimmed of surrounding whitespace before being stored. Empty-after-trim versions would be dropped entirely.

**Data flow**: Writes a manifest with padded version text, loads it, and asserts `manifest.version == Some("1.2.3-beta+7")`.

**Call relations**: This test targets the version normalization logic inside `parse_plugin_manifest`.

*Call graph*: 4 external calls (assert_eq!, load_manifest, write_manifest, tempdir).


##### `tests::plugin_manifest_reads_keywords`  (lines 569–588)

```
fn plugin_manifest_reads_keywords()
```

**Purpose**: Verifies the parser preserves the manifest `keywords` array exactly as strings. Keywords are not normalized beyond JSON deserialization.

**Data flow**: Writes a manifest containing a `keywords` array, loads it, and asserts the resulting `manifest.keywords` vector matches the input strings.

**Call relations**: This test covers a straightforward metadata field carried through by `parse_plugin_manifest`.

*Call graph*: 5 external calls (assert_eq!, load_manifest, create_dir_all, write, tempdir).


##### `tests::plugin_manifest_uses_alternate_discoverable_path`  (lines 591–615)

```
fn plugin_manifest_uses_alternate_discoverable_path()
```

**Purpose**: Checks manifest discovery finds supported alternate manifest locations and still applies normal parsing rules there. Version trimming and interface parsing should work the same.

**Data flow**: Writes a manifest under `.claude-plugin/plugin.json`, loads it through `load_manifest`, and asserts the trimmed version and interface display name.

**Call relations**: This test validates the discovery behavior used by `load_plugin_manifest` via `find_plugin_manifest_path`.

*Call graph*: 4 external calls (assert_eq!, load_manifest, write_alternate_plugin_manifest, tempdir).


##### `tests::host_and_executor_sources_parse_the_same_manifest`  (lines 618–657)

```
async fn host_and_executor_sources_parse_the_same_manifest()
```

**Purpose**: Ensures host-side manifest parsing and executor-side plugin resolution produce equivalent resolved plugin descriptors. This guards against divergence between host and executor manifest handling.

**Data flow**: Writes a manifest with version and `composerIcon`, loads it on the host, constructs an `ExecutorPluginProvider` with a test `EnvironmentManager`, resolves the plugin from an environment-backed `SelectedCapabilityRoot`, builds the expected `ResolvedPlugin::from_environment` using the host manifest and absolute paths, and asserts equality.

**Call relations**: This integration test connects `load_plugin_manifest` to executor resolution, proving both paths interpret the same manifest consistently.

*Call graph*: calls 5 internal fn (load_plugin_manifest, new, default_for_tests, from_environment, from_absolute_path_checked); 4 external calls (new, assert_eq!, write_manifest, tempdir).


### `core-plugins/src/app_mcp_routing.rs`

`domain_logic` · `plugin loading and routing-policy application`

This file contains a narrow but important routing policy for plugin/app integration. `apps_route_available` is the feature gate: it returns true only when an `AuthMode` is present and that mode reports `uses_codex_backend()`. If there is no auth mode or the backend does not support Codex-backed app routing, app declarations should not be exposed.

`apply_app_mcp_routing_policy` mutates two caller-owned collections in place: a `Vec<AppDeclaration>` and a `HashMap<String, M>` of MCP servers. Its first branch enforces the gate strictly: when app routing is unavailable, it clears the app declaration list and returns immediately, leaving MCP servers untouched. When routing is available, it optionally resolves name conflicts between app declarations and MCP servers. Specifically, if `plugin_active` is true and there is at least one app declaration, it collects all app names into a `HashSet<&str>` and retains only those MCP server entries whose map key is not one of the app declaration names.

That design means app declarations take precedence over same-named MCP servers only when the plugin path is active; otherwise both collections remain as supplied. The function is generic over the MCP server value type because it only needs to inspect and filter keys.

#### Function details

##### `apps_route_available`  (lines 6–8)

```
fn apps_route_available(auth_mode: Option<AuthMode>) -> bool
```

**Purpose**: Determines whether app-based routing should be enabled for the current authentication mode.

**Data flow**: Accepts `auth_mode: Option<AuthMode>`, calls `is_some_and(AuthMode::uses_codex_backend)`, and returns true only when a mode exists and uses the Codex backend.

**Call relations**: It is used directly by plugin-loading code and by `apply_app_mcp_routing_policy` as the top-level gate before any app declarations are kept.

*Call graph*: called by 2 (apply_app_mcp_routing_policy, load_plugin_mcp_servers).


##### `apply_app_mcp_routing_policy`  (lines 10–28)

```
fn apply_app_mcp_routing_policy(
    apps: &mut Vec<AppDeclaration>,
    mcp_servers: &mut HashMap<String, M>,
    auth_mode: Option<AuthMode>,
    plugin_active: bool,
)
```

**Purpose**: Mutates app declarations and MCP server registrations to enforce app-routing availability and resolve app/server name conflicts when plugins are active.

**Data flow**: Takes mutable references to `apps: &mut Vec<AppDeclaration>` and `mcp_servers: &mut HashMap<String, M>`, plus `auth_mode` and `plugin_active`. If `apps_route_available(auth_mode)` is false, it clears `apps` and returns. Otherwise, when `plugin_active` is true and `apps` is non-empty, it collects `app.name` values into a `HashSet<&str>` and calls `mcp_servers.retain` to remove any server whose key matches an app declaration name. It returns no value.

**Call relations**: Several plugin-resolution and plugin-detail builders call this function after assembling app declarations and MCP servers. It delegates only the availability check to `apps_route_available`; the rest of the policy is enforced inline because it directly mutates both collections.

*Call graph*: calls 1 internal fn (apps_route_available); called by 4 (load_plugin_mcp_servers, read_plugin_detail_for_marketplace_plugin, resolve_loaded_plugins_for_auth, build_remote_plugin_detail).


### `core-plugins/src/marketplace.rs`

`domain_logic` · `marketplace discovery`

This file is the core marketplace parser and resolver. It defines public structs for `Marketplace`, `MarketplacePlugin`, `ResolvedMarketplacePlugin`, list outcomes, and policy/source enums, plus conversion impls from marketplace-specific install/auth policies into app-server protocol enums. Marketplace manifests are discoverable from a small set of supported relative paths, including standard, API-curated, and legacy Claude layouts.

The loading flow starts with `find_marketplace_manifest_path` or `discover_marketplace_paths_from_roots`, which search explicit roots, home, and enclosing git repositories while deduplicating paths. `load_raw_marketplace_manifest` reads and deserializes JSON into raw structs. `load_marketplace` then resolves each plugin entry: unsupported sources are skipped with warnings; invalid plugin IDs are also skipped; local sources are resolved relative to the marketplace root and enriched with `load_plugin_manifest`; git sources are normalized into canonical URL/path/ref/sha fields but do not load plugin manifests. Marketplace-level interface metadata is reduced to currently supported fields.

Path and source normalization are strict. Local plugin paths must start with `./` and remain within the marketplace root. Git subdirectory paths must contain only normal path components. Git URLs accept HTTP(S), SSH, file URLs, absolute paths, relative paths rooted at the marketplace root, and GitHub shorthand `owner/repo`, with GitHub HTTPS URLs normalized to include `.git`. Product restrictions are carried through in plugin policy and enforced by `find_installable_marketplace_plugin`, which rejects `NotAvailable` plugins and plugins excluded by the caller’s restriction product.

#### Function details

##### `PluginInstallPolicy::from`  (lines 112–118)

```
fn from(value: MarketplacePluginInstallPolicy) -> Self
```

**Purpose**: Converts marketplace-specific install policy values into the app-server protocol enum. It preserves the semantic meaning of availability states across subsystem boundaries.

**Data flow**: Takes a `MarketplacePluginInstallPolicy` and returns the corresponding `codex_app_server_protocol::PluginInstallPolicy` variant without side effects.

**Call relations**: Used wherever marketplace metadata must be surfaced through protocol-facing types.


##### `PluginAuthPolicy::from`  (lines 122–127)

```
fn from(value: MarketplacePluginAuthPolicy) -> Self
```

**Purpose**: Converts marketplace-specific authentication policy values into the app-server protocol enum. It maps `OnInstall` and `OnUse` directly.

**Data flow**: Consumes a `MarketplacePluginAuthPolicy` and returns the matching `codex_app_server_protocol::PluginAuthPolicy` variant.

**Call relations**: Used when marketplace plugin metadata is exported to protocol consumers.


##### `MarketplaceError::io`  (lines 167–169)

```
fn io(context: &'static str, source: io::Error) -> Self
```

**Purpose**: Constructs the `MarketplaceError::Io` variant with a fixed context string and source error. It standardizes wrapping of filesystem I/O failures.

**Data flow**: Receives a static context label and an `io::Error`, packages them into `MarketplaceError::Io`, and returns the error value.

**Call relations**: Called by marketplace file-reading helpers when a non-NotFound I/O error occurs.


##### `find_marketplace_plugin`  (lines 172–195)

```
fn find_marketplace_plugin(
    marketplace_path: &AbsolutePathBuf,
    plugin_name: &str,
) -> Result<ResolvedMarketplacePlugin, MarketplaceError>
```

**Purpose**: Loads a marketplace manifest and resolves one named plugin entry from it. It returns the first matching resolvable plugin or a `PluginNotFound` error.

**Data flow**: Reads and deserializes the marketplace file via `load_raw_marketplace_manifest`, iterates raw plugin entries, skips non-matching names, resolves matching entries through `resolve_marketplace_plugin_entry`, and returns the resolved plugin. If no matching resolvable entry exists, it returns `MarketplaceError::PluginNotFound` using the marketplace name from the manifest.

**Call relations**: Used by plugin detail reads and installability checks. It delegates source normalization and optional manifest enrichment to `resolve_marketplace_plugin_entry`.

*Call graph*: calls 2 internal fn (load_raw_marketplace_manifest, resolve_marketplace_plugin_entry); called by 2 (read_plugin_for_config, find_installable_marketplace_plugin).


##### `find_installable_marketplace_plugin`  (lines 197–220)

```
fn find_installable_marketplace_plugin(
    marketplace_path: &AbsolutePathBuf,
    plugin_name: &str,
    restriction_product: Option<Product>,
) -> Result<ResolvedMarketplacePlugin, MarketplaceError
```

**Purpose**: Finds a marketplace plugin and enforces installability constraints such as policy and product restrictions. It rejects plugins that exist but are not installable in the current product context.

**Data flow**: Calls `find_marketplace_plugin`, inspects `resolved.policy.installation` and `resolved.policy.products`, computes whether the optional `restriction_product` matches any declared products, and either returns the resolved plugin or `MarketplaceError::PluginNotAvailable`.

**Call relations**: Called by plugin installation flows after basic marketplace lookup. It layers policy enforcement on top of raw plugin resolution.

*Call graph*: calls 1 internal fn (find_marketplace_plugin); called by 2 (install_plugin, install_plugin_with_remote_sync).


##### `list_marketplaces`  (lines 222–226)

```
fn list_marketplaces(
    additional_roots: &[AbsolutePathBuf],
) -> Result<MarketplaceListOutcome, MarketplaceError>
```

**Purpose**: Public entry point for marketplace discovery using the process home directory plus any additional roots. It returns both successfully loaded marketplaces and per-path load errors.

**Data flow**: Computes an optional home directory via `home_dir`, then forwards `additional_roots` and that home path to `list_marketplaces_with_home`, returning its `MarketplaceListOutcome`.

**Call relations**: Used by marketplace discovery and refresh code as the top-level listing API.

*Call graph*: calls 2 internal fn (home_dir, list_marketplaces_with_home); called by 3 (refresh_non_curated_plugin_cache_with_mode, discover_marketplaces_for_config, list_marketplaces_for_config).


##### `home_dir`  (lines 228–236)

```
fn home_dir() -> Option<PathBuf>
```

**Purpose**: Finds a usable absolute home directory path from environment variables or the platform default. It prefers `HOME`/`USERPROFILE` when set and absolute.

**Data flow**: Scans `HOME` and `USERPROFILE`, filters out empty values, converts to `PathBuf`, keeps the first absolute path, and falls back to `dirs::home_dir()` if needed.

**Call relations**: Called by `list_marketplaces` and other code that needs a stable home root for marketplace discovery.

*Call graph*: called by 2 (list_marketplaces, checkout_remote_plugin_share).


##### `validate_marketplace_root`  (lines 238–247)

```
fn validate_marketplace_root(root: &Path) -> Result<String, MarketplaceError>
```

**Purpose**: Checks that a directory contains a supported marketplace manifest and that the manifest loads successfully. On success it returns the marketplace name declared in the manifest.

**Data flow**: Searches the root with `find_marketplace_manifest_path`; if none is found, returns `InvalidMarketplaceFile`; otherwise loads the marketplace via `load_marketplace` and returns `marketplace.name`.

**Call relations**: Used by marketplace-add metadata and source validation to confirm a candidate root is a real marketplace.

*Call graph*: calls 2 internal fn (find_marketplace_manifest_path, load_marketplace); called by 4 (find_marketplace_root_by_name, installed_marketplace_root_for_source, validate_marketplace_source_root, upgrade_configured_git_marketplace); 1 external calls (to_path_buf).


##### `find_marketplace_manifest_path`  (lines 249–259)

```
fn find_marketplace_manifest_path(root: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: Searches a root directory for a marketplace manifest in any supported relative location. It returns the first existing supported path as an absolute path.

**Data flow**: Iterates `MARKETPLACE_MANIFEST_RELATIVE_PATHS`, joins each to the root, checks `is_file`, converts the first match to `AbsolutePathBuf`, and returns it or `None`.

**Call relations**: Used by validation and discovery code as the basic root-to-manifest lookup primitive.

*Call graph*: called by 5 (import_plugins, configured_marketplace_snapshot_issues, discover_marketplace_paths_from_roots, validate_marketplace_root, upgrade_configured_git_marketplace).


##### `supported_marketplace_manifest_path`  (lines 261–272)

```
fn supported_marketplace_manifest_path(path: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: Validates that a given file path is itself a marketplace manifest in one of the supported layouts. It is stricter than root-based discovery because it starts from a file path.

**Data flow**: Checks the path is a file, verifies at least one supported relative layout matches via `marketplace_root_from_layout`, converts the path to `AbsolutePathBuf`, and returns it or `None`.

**Call relations**: Used during discovery when callers may pass a manifest file directly instead of a root directory.

*Call graph*: calls 1 internal fn (try_from); called by 1 (discover_marketplace_paths_from_roots); 2 external calls (is_file, to_path_buf).


##### `invalid_marketplace_layout_error`  (lines 274–279)

```
fn invalid_marketplace_layout_error(path: &AbsolutePathBuf) -> MarketplaceError
```

**Purpose**: Builds a standardized error for marketplace files that are not located in a supported layout. It keeps layout-validation failures consistent.

**Data flow**: Copies the provided absolute path into `MarketplaceError::InvalidMarketplaceFile` with a fixed message and returns the error.

**Call relations**: Used by `marketplace_root_dir` when no supported layout matches.

*Call graph*: calls 1 internal fn (to_path_buf); called by 1 (marketplace_root_dir).


##### `marketplace_root_from_layout`  (lines 281–294)

```
fn marketplace_root_from_layout(marketplace_path: &Path, relative_path: &str) -> Option<PathBuf>
```

**Purpose**: Computes the marketplace root directory by checking whether a file path ends with a specific supported relative manifest path. It is the layout-matching primitive behind several validators.

**Data flow**: Walks backward through the components of the candidate relative path and the actual file path, ensuring each trailing component matches; if all do, returns the remaining parent directory as the marketplace root.

**Call relations**: Called by `supported_marketplace_manifest_path` and `marketplace_root_dir` to recognize supported marketplace layouts.

*Call graph*: called by 1 (marketplace_root_dir); 1 external calls (new).


##### `load_marketplace`  (lines 296–341)

```
fn load_marketplace(path: &AbsolutePathBuf) -> Result<Marketplace, MarketplaceError>
```

**Purpose**: Loads a marketplace manifest into a typed `Marketplace`, resolving plugin entries, enriching local plugins with manifest metadata, and skipping invalid plugin entries with warnings. It is the main marketplace parsing routine.

**Data flow**: Reads raw JSON via `load_raw_marketplace_manifest`, iterates raw plugin entries, resolves each through `resolve_marketplace_plugin_entry`, skips `None` and `InvalidPlugin` cases with warnings, extracts `local_version` and `keywords` from any loaded plugin manifest, resolves marketplace interface metadata, and returns a populated `Marketplace`.

**Call relations**: Used by validation and listing flows. It delegates plugin-level resolution to `resolve_marketplace_plugin_entry` and marketplace-interface reduction to `resolve_marketplace_interface`.

*Call graph*: calls 3 internal fn (load_raw_marketplace_manifest, resolve_marketplace_interface, resolve_marketplace_plugin_entry); called by 3 (refresh_curated_plugin_cache, list_marketplaces_with_home, validate_marketplace_root); 3 external calls (new, clone, warn!).


##### `list_marketplaces_with_home`  (lines 344–368)

```
fn list_marketplaces_with_home(
    additional_roots: &[AbsolutePathBuf],
    home_dir: Option<&Path>,
) -> Result<MarketplaceListOutcome, MarketplaceError>
```

**Purpose**: Discovers marketplace manifests from roots and home, loads each one, and accumulates both successes and non-fatal per-path errors. It is the implementation behind the public listing API.

**Data flow**: Starts with an empty `MarketplaceListOutcome`, obtains candidate manifest paths from `discover_marketplace_paths_from_roots`, attempts `load_marketplace` for each, pushes successful marketplaces into `marketplaces`, and records warning-backed `MarketplaceListError` entries for failures.

**Call relations**: Called by `list_marketplaces`; it orchestrates discovery and loading while treating individual marketplace failures as recoverable.

*Call graph*: calls 2 internal fn (discover_marketplace_paths_from_roots, load_marketplace); called by 1 (list_marketplaces); 2 external calls (default, warn!).


##### `discover_marketplace_paths_from_roots`  (lines 370–407)

```
fn discover_marketplace_paths_from_roots(
    additional_roots: &[AbsolutePathBuf],
    home_dir: Option<&Path>,
) -> Vec<AbsolutePathBuf>
```

**Purpose**: Finds candidate marketplace manifest paths from the home directory, explicit roots, direct manifest-file inputs, direct root inputs, and enclosing git repositories. It deduplicates paths while preserving discovery order.

**Data flow**: Begins with an empty vector, optionally adds a home-root manifest, then for each additional root tries `supported_marketplace_manifest_path`, direct `find_marketplace_manifest_path`, and finally `get_git_repo_root` followed by `find_marketplace_manifest_path` on the repo root, pushing only paths not already present.

**Call relations**: Used exclusively by `list_marketplaces_with_home` as the discovery phase before loading.

*Call graph*: calls 3 internal fn (find_marketplace_manifest_path, supported_marketplace_manifest_path, try_from); called by 1 (list_marketplaces_with_home); 2 external calls (new, get_git_repo_root).


##### `load_raw_marketplace_manifest`  (lines 409–425)

```
fn load_raw_marketplace_manifest(
    path: &AbsolutePathBuf,
) -> Result<RawMarketplaceManifest, MarketplaceError>
```

**Purpose**: Reads and deserializes a marketplace JSON file into its raw representation. It distinguishes missing files from other I/O and parse failures.

**Data flow**: Reads the file contents from `path.as_path()`, maps `NotFound` to `MarketplaceNotFound`, wraps other read errors with `MarketplaceError::io`, deserializes JSON into `RawMarketplaceManifest`, and maps parse errors to `InvalidMarketplaceFile` with the serde message.

**Call relations**: Called by both `find_marketplace_plugin` and `load_marketplace` as the raw JSON ingestion step.

*Call graph*: calls 1 internal fn (as_path); called by 2 (find_marketplace_plugin, load_marketplace); 2 external calls (read_to_string, from_str).


##### `resolve_marketplace_plugin_entry`  (lines 427–466)

```
fn resolve_marketplace_plugin_entry(
    marketplace_path: &AbsolutePathBuf,
    marketplace_name: &str,
    plugin: RawMarketplaceManifestPlugin,
) -> Result<Option<ResolvedMarketplacePlugin>, Market
```

**Purpose**: Resolves one raw marketplace plugin entry into a typed plugin descriptor with normalized source, validated plugin ID, policy, optional manifest, and interface metadata. Local sources are enriched from the plugin manifest; git sources are not.

**Data flow**: Destructures the raw plugin entry, resolves its source through `resolve_supported_plugin_source`, optionally loads a local plugin manifest with `load_plugin_manifest`, merges marketplace category onto any manifest interface via `plugin_interface_with_marketplace_category`, constructs a validated `PluginId`, and returns `Some(ResolvedMarketplacePlugin)` or `None` for skipped unsupported/unresolvable sources.

**Call relations**: Used by both marketplace loading and single-plugin lookup. It is the central bridge from raw plugin entry JSON to typed marketplace plugin metadata.

*Call graph*: calls 4 internal fn (load_plugin_manifest, plugin_interface_with_marketplace_category, resolve_supported_plugin_source, new); called by 2 (find_marketplace_plugin, load_marketplace).


##### `resolve_supported_plugin_source`  (lines 468–495)

```
fn resolve_supported_plugin_source(
    marketplace_path: &AbsolutePathBuf,
    plugin_name: &str,
    source: RawMarketplaceManifestPluginSource,
) -> Option<MarketplacePluginSource>
```

**Purpose**: Filters out unsupported raw plugin source shapes and resolves supported ones while downgrading source-resolution failures to warnings plus omission. This keeps malformed plugin entries from aborting the whole marketplace.

**Data flow**: Matches the raw source enum; unsupported variants log a warning and return `None`; supported variants are passed to `resolve_plugin_source`, whose success becomes `Some(source)` and whose errors are logged before returning `None`.

**Call relations**: Called by `resolve_marketplace_plugin_entry` to implement tolerant per-plugin source handling.

*Call graph*: calls 1 internal fn (resolve_plugin_source); called by 1 (resolve_marketplace_plugin_entry); 1 external calls (warn!).


##### `resolve_plugin_source`  (lines 497–541)

```
fn resolve_plugin_source(
    marketplace_path: &AbsolutePathBuf,
    source: RawMarketplaceManifestPluginSource,
) -> Result<MarketplacePluginSource, MarketplaceError>
```

**Purpose**: Normalizes a raw plugin source declaration into either a local absolute path or a canonical git source descriptor. It handles legacy string paths, local objects, URL objects, and git-subdir objects.

**Data flow**: Matches the raw source variant; local path forms are resolved with `resolve_local_plugin_source_path`; URL and git-subdir forms normalize the URL, optional subdirectory path, and optional ref/sha selectors; unsupported variants are unreachable because they should have been filtered earlier.

**Call relations**: Called only by `resolve_supported_plugin_source`; it delegates field-level normalization to the local-path and git normalization helpers.

*Call graph*: calls 4 internal fn (normalize_git_plugin_source_url, normalize_optional_git_selector, normalize_remote_plugin_subdir, resolve_local_plugin_source_path); called by 1 (resolve_supported_plugin_source); 1 external calls (unreachable!).


##### `resolve_local_plugin_source_path`  (lines 543–574)

```
fn resolve_local_plugin_source_path(
    marketplace_path: &AbsolutePathBuf,
    path: &str,
) -> Result<AbsolutePathBuf, MarketplaceError>
```

**Purpose**: Validates and resolves a local plugin source path relative to the marketplace root. It enforces `./` syntax and forbids traversal outside the root.

**Data flow**: Requires the raw path to start with `./`, rejects empty or non-normal path components, computes the marketplace root via `marketplace_root_dir`, joins the relative path under that root, and returns an `AbsolutePathBuf` or `InvalidMarketplaceFile`.

**Call relations**: Used by `resolve_plugin_source` for local plugin source declarations.

*Call graph*: calls 2 internal fn (marketplace_root_dir, to_path_buf); called by 1 (resolve_plugin_source); 1 external calls (new).


##### `normalize_remote_plugin_subdir`  (lines 576–599)

```
fn normalize_remote_plugin_subdir(
    marketplace_path: &AbsolutePathBuf,
    path: &str,
) -> Result<String, MarketplaceError>
```

**Purpose**: Normalizes and validates the `path` portion of a git plugin source. It trims whitespace, strips an optional leading `./`, and rejects traversal or empty paths.

**Data flow**: Trims the input string, removes a leading `./` if present, checks for emptiness, verifies all path components are `Normal`, and returns the normalized relative path string or `InvalidMarketplaceFile`.

**Call relations**: Called by `resolve_plugin_source` for URL and git-subdir source forms.

*Call graph*: calls 1 internal fn (to_path_buf); called by 1 (resolve_plugin_source); 1 external calls (new).


##### `normalize_git_plugin_source_url`  (lines 601–636)

```
fn normalize_git_plugin_source_url(
    marketplace_path: &AbsolutePathBuf,
    url: &str,
) -> Result<String, MarketplaceError>
```

**Purpose**: Accepts several git URL syntaxes and normalizes them into a canonical string form. It supports HTTP(S), SSH, file URLs, absolute paths, relative paths rooted at the marketplace root, and GitHub shorthand.

**Data flow**: Trims the URL, rejects empty strings, returns normalized GitHub HTTPS URLs with `.git`, resolves relative paths through `normalize_relative_git_plugin_source_url`, passes through file/absolute/SSH forms, expands GitHub shorthand via `normalize_github_shorthand_url`, and otherwise returns `InvalidMarketplaceFile`.

**Call relations**: Used by `resolve_plugin_source` for all git-backed source declarations.

*Call graph*: calls 4 internal fn (normalize_github_git_url, normalize_github_shorthand_url, normalize_relative_git_plugin_source_url, to_path_buf); called by 1 (resolve_plugin_source); 1 external calls (format!).


##### `normalize_relative_git_plugin_source_url`  (lines 638–659)

```
fn normalize_relative_git_plugin_source_url(
    marketplace_path: &AbsolutePathBuf,
    url: &str,
) -> Result<String, MarketplaceError>
```

**Purpose**: Resolves a relative git source URL against the marketplace root while forbidding upward traversal. It converts marketplace-relative repository references into concrete filesystem paths.

**Data flow**: Starts from `marketplace_root_dir(marketplace_path)`, splits the relative URL on `/` and `\`, ignores empty and `.` segments, rejects `..`, appends remaining segments, and returns the resulting path as a display string.

**Call relations**: Called by `normalize_git_plugin_source_url` when a git source URL is relative.

*Call graph*: calls 2 internal fn (marketplace_root_dir, to_path_buf); called by 1 (normalize_git_plugin_source_url).


##### `normalize_optional_git_selector`  (lines 661–667)

```
fn normalize_optional_git_selector(value: &Option<String>) -> Option<String>
```

**Purpose**: Trims optional git selector strings such as `ref` or `sha` and drops them if empty. It prevents blank selectors from being treated as meaningful values.

**Data flow**: Reads an `Option<String>`, trims the inner string if present, filters out empties, and returns `Option<String>`.

**Call relations**: Used by `resolve_plugin_source` for optional `ref_name` and `sha` fields.

*Call graph*: called by 1 (resolve_plugin_source).


##### `normalize_github_git_url`  (lines 669–675)

```
fn normalize_github_git_url(url: &str) -> String
```

**Purpose**: Normalizes GitHub HTTPS repository URLs to include a `.git` suffix when missing. Non-GitHub URLs are returned unchanged.

**Data flow**: Checks whether the URL starts with `https://github.com/` and lacks a `.git` suffix; if so, appends `.git`, otherwise clones the original string.

**Call relations**: Called by `normalize_git_plugin_source_url` for HTTP(S) GitHub URLs.

*Call graph*: called by 1 (normalize_git_plugin_source_url); 1 external calls (format!).


##### `normalize_github_shorthand_url`  (lines 677–689)

```
fn normalize_github_shorthand_url(source: &str) -> Option<String>
```

**Purpose**: Expands `owner/repo` shorthand into a full GitHub HTTPS `.git` URL when the input looks like a valid shorthand. Invalid shorthand-like strings return `None`.

**Data flow**: First checks `looks_like_github_shorthand`; if true, splits into owner and repo, strips any `.git` suffix from the repo segment, rejects an empty repo, and returns `https://github.com/<owner>/<repo>.git`.

**Call relations**: Used by `normalize_git_plugin_source_url` to support shorthand git source declarations.

*Call graph*: calls 1 internal fn (looks_like_github_shorthand); called by 1 (normalize_git_plugin_source_url); 1 external calls (format!).


##### `looks_like_github_shorthand`  (lines 691–699)

```
fn looks_like_github_shorthand(source: &str) -> bool
```

**Purpose**: Recognizes whether a string has exactly two slash-separated segments that both satisfy GitHub shorthand segment rules. It is a syntactic filter before shorthand expansion.

**Data flow**: Splits the source on `/`, extracts owner, repo, and any extra segment, and returns true only if owner and repo are present, valid per `is_github_shorthand_segment`, and there is no third segment.

**Call relations**: Called by `normalize_github_shorthand_url`.

*Call graph*: called by 1 (normalize_github_shorthand_url).


##### `is_github_shorthand_segment`  (lines 701–706)

```
fn is_github_shorthand_segment(segment: &str) -> bool
```

**Purpose**: Validates one owner or repo segment for GitHub shorthand syntax. Allowed characters are ASCII alphanumerics plus `-`, `_`, and `.`.

**Data flow**: Checks the segment is non-empty and that every character matches the allowed set, returning a boolean.

**Call relations**: Used by shorthand recognition logic.


##### `plugin_interface_with_marketplace_category`  (lines 708–719)

```
fn plugin_interface_with_marketplace_category(
    mut interface: Option<PluginManifestInterface>,
    category: Option<String>,
) -> Option<PluginManifestInterface>
```

**Purpose**: Merges a marketplace-level plugin category onto an optional plugin manifest interface, with marketplace taxonomy taking precedence over manifest category. It ensures category overrides are visible even when the manifest lacks an interface object.

**Data flow**: Takes an optional `PluginManifestInterface` and optional category string; if a category is present, inserts a default interface if needed and sets `interface.category = Some(category)`; returns the resulting optional interface.

**Call relations**: Used during marketplace plugin resolution and plugin detail reads to apply marketplace taxonomy over manifest metadata.

*Call graph*: called by 2 (read_plugin_detail_for_marketplace_plugin, resolve_marketplace_plugin_entry).


##### `marketplace_root_dir`  (lines 722–735)

```
fn marketplace_root_dir(
    marketplace_path: &AbsolutePathBuf,
) -> Result<AbsolutePathBuf, MarketplaceError>
```

**Purpose**: Computes the root directory that contains a marketplace manifest file in one of the supported layouts. It rejects files outside those layouts.

**Data flow**: Iterates supported relative manifest paths, uses `marketplace_root_from_layout` to test each against the provided absolute marketplace path, converts the matched root to `AbsolutePathBuf`, and returns it or an invalid-layout error.

**Call relations**: Used by local-path and relative-git-source normalization to anchor paths at the marketplace root.

*Call graph*: calls 4 internal fn (invalid_marketplace_layout_error, marketplace_root_from_layout, as_path, try_from); called by 3 (run_list, normalize_relative_git_plugin_source_url, resolve_local_plugin_source_path).


##### `resolve_marketplace_interface`  (lines 806–817)

```
fn resolve_marketplace_interface(
    interface: Option<RawMarketplaceManifestInterface>,
) -> Option<MarketplaceInterface>
```

**Purpose**: Reduces raw marketplace interface JSON into the currently supported typed interface. Empty interfaces are dropped.

**Data flow**: Takes an optional `RawMarketplaceManifestInterface`; if present and `display_name` is set, returns `Some(MarketplaceInterface { display_name })`, otherwise returns `None`.

**Call relations**: Called by `load_marketplace` when constructing the final `Marketplace`.

*Call graph*: called by 1 (load_marketplace).


### `core-plugins/src/loader.rs`

`domain_logic` · `plugin load, cache refresh, metadata extraction`

This file is the heart of plugin materialization. It defines constants for default plugin file locations (`skills`, `hooks/hooks.json`, `.mcp.json`, `.app.json`, `config.toml`), lightweight parsing structs for `.app.json`, and several loading scopes. The main path starts with `load_plugins_from_layer_stack`, which derives skill config rules and delegates to `load_plugins_from_layer_stack_with_scope`. That function merges configured plugins with remote-installed plugin configs, sorts them by configured key, loads each plugin via `load_plugin`, and warns on duplicate MCP server names across plugins.

`load_plugin` constructs a `LoadedPlugin<McpServerConfig>` incrementally. It validates the plugin id, resolves the active cached plugin root from `PluginStore`, checks directory and manifest existence, and then either loads all capabilities or only hooks depending on `PluginLoadScope`. Full-capability loading reads skill roots and skill metadata, computes disabled skill paths, parses one or more MCP config files and overlays per-plugin MCP policy from config, and loads app declarations from `.app.json`. Hook loading is always performed and supports manifest-declared hook paths, inline hook objects, or the default hooks file.

The file also owns cache-refresh logic. Curated refresh compares configured curated plugin ids against curated marketplace manifests and installs or removes cached bundles based on the curated repo SHA, while non-curated refresh scans discovered marketplaces, materializes local or git sources, computes source versions, and reinstalls when versions change or forced reinstall is requested. Additional helpers parse plugin config from user TOML, derive curated/non-curated plugin ids, compute telemetry summaries from plugin roots, apply auth-sensitive app/MCP routing, and materialize git plugin sources using sparse checkout when a subdirectory path is specified. Error handling is intentionally forgiving during capability parsing—invalid manifests, hooks, app files, or MCP entries usually produce warnings and partial results rather than aborting the entire plugin load.

#### Function details

##### `log_plugin_load_errors`  (lines 83–93)

```
fn log_plugin_load_errors(plugins: &[LoadedPlugin<McpServerConfig>])
```

**Purpose**: Emits warnings for plugins that loaded with an `error` field set. It surfaces per-plugin failures after a bulk load without changing the load result.

**Data flow**: Reads a slice of `LoadedPlugin<McpServerConfig>` → filters to entries whose `error` is `Some`, extracts `config_name`, `root`, and error text, and logs each via `warn!` → returns unit.

**Call relations**: Called after `load_plugins_from_layer_stack` by manager code so plugin load failures are visible in logs while the partially loaded plugin list is still returned.

*Call graph*: called by 1 (plugins_for_config_with_force_reload); 2 external calls (iter, warn!).


##### `load_plugins_from_layer_stack`  (lines 110–129)

```
async fn load_plugins_from_layer_stack(
    config_layer_stack: &ConfigLayerStack,
    extra_plugins: HashMap<String, PluginConfig>,
    store: &PluginStore,
    restriction_product: Option<Product>,
```

**Purpose**: Loads all configured plugins with full capabilities from a config layer stack. It is the public async entry point for normal plugin loading.

**Data flow**: Takes a `ConfigLayerStack`, extra plugin configs, `PluginStore`, optional product restriction, and a remote-conflict preference flag → derives `SkillConfigRules` from the stack → delegates to `load_plugins_from_layer_stack_with_scope` with `PluginLoadScope::AllCapabilities` → returns `Vec<LoadedPlugin<McpServerConfig>>`.

**Call relations**: Used by `PluginsManager` for cached and uncached plugin loads; it wraps the more general scoped loader with the standard full-capability mode.

*Call graph*: calls 2 internal fn (load_plugins_from_layer_stack_with_scope, skill_config_rules_from_stack); called by 3 (plugins_for_config_with_force_reload, plugins_for_layer_stack, load_plugins_ignores_project_config_files).


##### `load_plugins_from_layer_stack_with_scope`  (lines 131–167)

```
async fn load_plugins_from_layer_stack_with_scope(
    config_layer_stack: &ConfigLayerStack,
    extra_plugins: HashMap<String, PluginConfig>,
    store: &PluginStore,
    prefer_remote_curated_confl
```

**Purpose**: Shared implementation for loading either full plugin capabilities or hooks only. It merges configured and remote-installed plugin configs, orders them deterministically, and loads each plugin one by one.

**Data flow**: Reads config stack, extra plugin configs, store, conflict preference, and a `PluginLoadScope` → builds configured plugin map via `configured_plugins_from_stack` and `merge_configured_plugins_with_remote_installed`, sorts entries by configured key, allocates an output vector and a `seen_mcp_server_names` map, awaits `load_plugin` for each entry, warns when a plugin introduces an MCP server name already seen from another plugin, pushes each loaded plugin, and returns the vector.

**Call relations**: Called by both `load_plugins_from_layer_stack` and `load_plugin_hooks_from_layer_stack`; it is the central bulk-loading loop.

*Call graph*: calls 3 internal fn (configured_plugins_from_stack, load_plugin, merge_configured_plugins_with_remote_installed); called by 2 (load_plugin_hooks_from_layer_stack, load_plugins_from_layer_stack); 3 external calls (new, with_capacity, warn!).


##### `load_plugin_hooks_from_layer_stack`  (lines 170–196)

```
async fn load_plugin_hooks_from_layer_stack(
    config_layer_stack: &ConfigLayerStack,
    extra_plugins: HashMap<String, PluginConfig>,
    store: &PluginStore,
    prefer_remote_curated_conflicts:
```

**Purpose**: Loads only hook declarations and hook warnings from enabled plugins, skipping skills, MCP servers, and apps. It provides a cheaper path for hook resolution.

**Data flow**: Invokes `load_plugins_from_layer_stack_with_scope` with `PluginLoadScope::HooksOnly` → filters the resulting plugins to active ones → flattens `hook_sources` and `hook_load_warnings` into a `PluginHookLoadOutcome` → returns that outcome.

**Call relations**: Used by manager hook-resolution APIs when callers need plugin hooks without paying the cost of full capability loading.

*Call graph*: calls 1 internal fn (load_plugins_from_layer_stack_with_scope); called by 1 (plugin_hooks_for_layer_stack).


##### `merge_configured_plugins_with_remote_installed`  (lines 198–244)

```
fn merge_configured_plugins_with_remote_installed(
    mut configured_plugins: HashMap<String, PluginConfig>,
    extra_plugins: HashMap<String, PluginConfig>,
    store: &PluginStore,
    prefer_remo
```

**Purpose**: Combines user-configured plugins with remote-installed plugin configs while resolving curated local/remote conflicts. It can prefer remote curated plugins over local curated ones when requested.

**Data flow**: Takes mutable `configured_plugins`, `extra_plugins`, `PluginStore`, and `prefer_remote_curated_conflicts` → scans configured plugin keys, parses valid ids, records installed local curated plugin keys grouped by plugin name, then iterates extra plugin configs, derives the installed remote curated plugin name with `installed_plugin_name_for_marketplace`, checks for matching local curated installs, optionally removes local curated entries when remote should win, inserts surviving extra plugins, and returns the merged `HashMap<String, PluginConfig>`.

**Call relations**: Called only by `load_plugins_from_layer_stack_with_scope`; it is the policy point where remote-installed plugins are folded into effective config.

*Call graph*: calls 3 internal fn (installed_plugin_name_for_marketplace, active_plugin_version, parse); called by 1 (load_plugins_from_layer_stack_with_scope); 2 external calls (new, is_openai_curated_marketplace_name).


##### `installed_plugin_name_for_marketplace`  (lines 246–257)

```
fn installed_plugin_name_for_marketplace(
    plugin_key: &str,
    marketplace_name: &str,
    store: &PluginStore,
) -> Option<String>
```

**Purpose**: Extracts the plugin name from a plugin key only if it belongs to a specific marketplace and has an active installed root. It is a small helper for conflict detection.

**Data flow**: Parses `plugin_key` into `PluginId`, compares `marketplace_name`, checks `store.active_plugin_root(&plugin_id)`, and if all conditions pass returns `Some(plugin_id.plugin_name)`; otherwise returns `None`.

**Call relations**: Used by `merge_configured_plugins_with_remote_installed` to recognize remote curated plugins that are actually installed locally.

*Call graph*: calls 2 internal fn (active_plugin_root, parse); called by 1 (merge_configured_plugins_with_remote_installed).


##### `remote_installed_plugins_to_config`  (lines 259–292)

```
fn remote_installed_plugins_to_config(
    plugins: &[RemoteInstalledPlugin],
    store: &PluginStore,
) -> HashMap<String, PluginConfig>
```

**Purpose**: Projects remote installed plugin records into synthetic `PluginConfig` entries that can participate in normal plugin loading. Only remote plugins with valid ids and present local bundles are included.

**Data flow**: Reads a slice of `RemoteInstalledPlugin` and the `PluginStore` → for each plugin, attempts `PluginId::new(plugin.name, plugin.marketplace_name)`, warns and skips invalid names, skips plugins whose active local bundle root is missing, and otherwise emits `(plugin_id.as_key(), PluginConfig { enabled: plugin.enabled, mcp_servers: HashMap::new() })` → collects into a `HashMap<String, PluginConfig>`.

**Call relations**: Called by manager cache code to expose remote installed state as extra plugin config during plugin loading.

*Call graph*: called by 1 (remote_installed_plugin_configs); 1 external calls (iter).


##### `refresh_curated_plugin_cache`  (lines 294–383)

```
fn refresh_curated_plugin_cache(
    codex_home: &Path,
    plugin_version: &str,
    configured_curated_plugin_ids: &[PluginId],
) -> Result<bool, String>
```

**Purpose**: Synchronizes cached curated plugin bundles with the current curated marketplace manifests and curated repo version. It installs updated bundles and removes stale configured curated plugins that disappeared from the curated marketplace.

**Data flow**: Takes `codex_home`, a curated `plugin_version`, and configured curated `PluginId`s → computes the cache version via `curated_plugin_cache_version`, opens `PluginStore`, gathers curated marketplace manifest paths with `curated_marketplace_paths_for_cache_refresh`, loads each marketplace, records loaded marketplace names, plugin keys, and local source paths while warning on duplicates, then iterates configured curated plugin ids: if a plugin no longer exists in a loaded curated marketplace it warns and uninstalls stale cache data if present; if it exists and its active cached version differs from the target cache version, it installs the source path into the store with that version. Returns `Ok(cache_refreshed)` or a descriptive `Err(String)`.

**Call relations**: Triggered by startup curated-repo sync in manager code; it is the curated-specific cache maintenance routine.

*Call graph*: calls 5 internal fn (curated_marketplace_paths_for_cache_refresh, curated_plugin_cache_version, load_marketplace, try_new, new); 4 external calls (new, new, to_path_buf, warn!).


##### `curated_marketplace_paths_for_cache_refresh`  (lines 385–407)

```
fn curated_marketplace_paths_for_cache_refresh(
    codex_home: &Path,
) -> Result<Vec<AbsolutePathBuf>, String>
```

**Purpose**: Finds the local curated marketplace manifest paths used during curated cache refresh. It always includes the standard curated manifest and conditionally includes the API-curated manifest if present.

**Data flow**: Builds `.tmp/plugins/.agents/plugins/marketplace.json` under `codex_home`, converts it to `AbsolutePathBuf`, initializes a vector with it, then checks for `.tmp/plugins/.agents/plugins/api_marketplace.json`; if that file exists, converts and appends it → returns `Result<Vec<AbsolutePathBuf>, String>`.

**Call relations**: Called only by `refresh_curated_plugin_cache` to enumerate curated marketplace manifests.

*Call graph*: calls 1 internal fn (try_from); called by 1 (refresh_curated_plugin_cache); 2 external calls (join, vec!).


##### `curated_plugin_cache_version`  (lines 409–415)

```
fn curated_plugin_cache_version(plugin_version: &str) -> String
```

**Purpose**: Normalizes curated plugin versions for cache storage. Full 40-character git SHAs are shortened to an 8-character prefix; other version strings are preserved.

**Data flow**: Reads `plugin_version: &str` → checks `is_full_git_sha(plugin_version)` → returns either the first 8 characters or the original string as a new `String`.

**Call relations**: Used by curated cache refresh and curated plugin installation so curated bundles share a stable short version format.

*Call graph*: calls 1 internal fn (is_full_git_sha); called by 2 (refresh_curated_plugin_cache, install_resolved_plugin).


##### `refresh_non_curated_plugin_cache`  (lines 417–426)

```
fn refresh_non_curated_plugin_cache(
    codex_home: &Path,
    additional_roots: &[AbsolutePathBuf],
) -> Result<bool, String>
```

**Purpose**: Refreshes cached non-curated plugin bundles only when their source version has changed. It is the normal background refresh mode.

**Data flow**: Passes `codex_home`, `additional_roots`, and `NonCuratedCacheRefreshMode::IfVersionChanged` into `refresh_non_curated_plugin_cache_with_mode` → returns that result.

**Call relations**: Called by the manager’s non-curated cache refresh loop for ordinary marketplace scans.

*Call graph*: calls 1 internal fn (refresh_non_curated_plugin_cache_with_mode); called by 1 (run_non_curated_plugin_cache_refresh_loop).


##### `refresh_non_curated_plugin_cache_force_reinstall`  (lines 428–437)

```
fn refresh_non_curated_plugin_cache_force_reinstall(
    codex_home: &Path,
    additional_roots: &[AbsolutePathBuf],
) -> Result<bool, String>
```

**Purpose**: Refreshes cached non-curated plugin bundles unconditionally, reinstalling even when the version appears unchanged. This is used after marketplace upgrades.

**Data flow**: Delegates to `refresh_non_curated_plugin_cache_with_mode` with `NonCuratedCacheRefreshMode::ForceReinstall` → returns the result.

**Call relations**: Used by manager code after configured marketplace upgrades and by the forced refresh branch of the background loop.

*Call graph*: calls 1 internal fn (refresh_non_curated_plugin_cache_with_mode); called by 2 (run_non_curated_plugin_cache_refresh_loop, upgrade_configured_marketplaces_for_config).


##### `refresh_non_curated_plugin_cache_with_mode`  (lines 439–526)

```
fn refresh_non_curated_plugin_cache_with_mode(
    codex_home: &Path,
    additional_roots: &[AbsolutePathBuf],
    mode: NonCuratedCacheRefreshMode,
) -> Result<bool, String>
```

**Purpose**: Synchronizes configured non-curated plugins from discovered marketplace sources into the local plugin store. It supports either version-sensitive refresh or forced reinstall.

**Data flow**: Reads `codex_home`, marketplace roots, and refresh mode → parses configured plugins from `config.toml` via `configured_plugins_from_codex_home`, derives sorted non-curated `PluginId`s, returns `Ok(false)` if none are configured, opens `PluginStore`, lists marketplaces from `additional_roots`, skips curated marketplaces, records unique sources for configured plugin keys while warning on duplicates, then for each configured non-curated plugin id materializes its source with `materialize_marketplace_plugin_source`, computes source version with `plugin_version_for_source`, optionally skips unchanged versions in `IfVersionChanged` mode, installs the source into the store with that version, and tracks whether anything changed. Missing configured plugins produce warnings but do not fail the refresh.

**Call relations**: Shared implementation behind both non-curated refresh entry points; invoked from manager background refresh and marketplace-upgrade flows.

*Call graph*: calls 7 internal fn (configured_plugins_from_codex_home, materialize_marketplace_plugin_source, non_curated_plugin_ids_from_config_keys, list_marketplaces, try_new, plugin_version_for_source, new); called by 2 (refresh_non_curated_plugin_cache, refresh_non_curated_plugin_cache_force_reinstall); 4 external calls (new, to_path_buf, is_openai_curated_marketplace_name, warn!).


##### `configured_plugins_from_stack`  (lines 528–535)

```
fn configured_plugins_from_stack(
    config_layer_stack: &ConfigLayerStack,
) -> HashMap<String, PluginConfig>
```

**Purpose**: Extracts the effective `[plugins]` table from the user config layer stack. It ignores non-user layers and returns an empty map when no user config exists.

**Data flow**: Reads `config_layer_stack.effective_user_config()` → if absent returns empty `HashMap`; otherwise delegates to `configured_plugins_from_user_config_value` → returns `HashMap<String, PluginConfig>`.

**Call relations**: Used by bulk plugin loading to determine configured plugins before merging remote-installed state.

*Call graph*: calls 2 internal fn (effective_user_config, configured_plugins_from_user_config_value); called by 1 (load_plugins_from_layer_stack_with_scope); 1 external calls (new).


##### `is_full_git_sha`  (lines 537–539)

```
fn is_full_git_sha(value: &str) -> bool
```

**Purpose**: Recognizes whether a version string is a full 40-character hexadecimal git SHA. It is a narrow helper for curated version shortening.

**Data flow**: Reads `value: &str` → checks length equals 40 and every character is an ASCII hex digit → returns `bool`.

**Call relations**: Only called by `curated_plugin_cache_version`.

*Call graph*: called by 1 (curated_plugin_cache_version).


##### `configured_plugins_from_user_config_value`  (lines 541–554)

```
fn configured_plugins_from_user_config_value(
    user_config: &toml::Value,
) -> HashMap<String, PluginConfig>
```

**Purpose**: Parses the `[plugins]` TOML subtree into `HashMap<String, PluginConfig>`. Invalid plugin config syntax is logged and treated as empty.

**Data flow**: Reads `user_config: &toml::Value` → looks up `plugins`, returns empty map if absent, clones that subtree and attempts `try_into()` as `HashMap<String, PluginConfig>`, returning the parsed map on success or logging `warn!` and returning empty on failure.

**Call relations**: Shared by stack-based and file-based config readers.

*Call graph*: called by 2 (configured_plugins_from_codex_home, configured_plugins_from_stack); 3 external calls (new, get, warn!).


##### `configured_plugins_from_codex_home`  (lines 556–588)

```
fn configured_plugins_from_codex_home(
    codex_home: &Path,
    read_error_message: &str,
    parse_error_message: &str,
) -> HashMap<String, PluginConfig>
```

**Purpose**: Reads and parses the user `config.toml` from disk to obtain configured plugins. It is used by cache-refresh code that runs outside the layered config machinery.

**Data flow**: Builds `codex_home/config.toml`, reads it as a string with `fs::read_to_string`, returns empty on not-found, warns and returns empty on other read errors, parses the string as `toml::Value`, warns and returns empty on parse errors, then delegates to `configured_plugins_from_user_config_value` and returns the resulting plugin map.

**Call relations**: Used by curated/non-curated cache refresh helpers and curated plugin id extraction from CODEX_HOME.

*Call graph*: calls 1 internal fn (configured_plugins_from_user_config_value); called by 2 (configured_curated_plugin_ids_from_codex_home, refresh_non_curated_plugin_cache_with_mode); 4 external calls (new, join, read_to_string, warn!).


##### `configured_plugin_ids`  (lines 590–608)

```
fn configured_plugin_ids(
    configured_plugins: HashMap<String, PluginConfig>,
    invalid_plugin_key_message: &str,
) -> Vec<PluginId>
```

**Purpose**: Parses configured plugin keys into `PluginId` values while dropping invalid keys with warnings. It centralizes invalid-key handling for curated and non-curated subsets.

**Data flow**: Consumes a `HashMap<String, PluginConfig>` and an error message string → iterates keys, attempts `PluginId::parse`, keeps successful ids, warns with the supplied message on parse failure, and returns `Vec<PluginId>`.

**Call relations**: Called by `curated_plugin_ids_from_config_keys` and `non_curated_plugin_ids_from_config_keys`.

*Call graph*: called by 2 (curated_plugin_ids_from_config_keys, non_curated_plugin_ids_from_config_keys).


##### `curated_plugin_ids_from_config_keys`  (lines 610–622)

```
fn curated_plugin_ids_from_config_keys(
    configured_plugins: HashMap<String, PluginConfig>,
) -> Vec<PluginId>
```

**Purpose**: Filters configured plugin ids down to curated marketplaces and sorts them deterministically. It prepares the curated subset for cache refresh.

**Data flow**: Calls `configured_plugin_ids`, filters ids whose `marketplace_name` satisfies `is_openai_curated_marketplace_name`, sorts by `PluginId::as_key`, and returns the vector.

**Call relations**: Used by `configured_curated_plugin_ids_from_codex_home`.

*Call graph*: calls 1 internal fn (configured_plugin_ids); called by 1 (configured_curated_plugin_ids_from_codex_home).


##### `non_curated_plugin_ids_from_config_keys`  (lines 624–636)

```
fn non_curated_plugin_ids_from_config_keys(
    configured_plugins: HashMap<String, PluginConfig>,
) -> Vec<PluginId>
```

**Purpose**: Filters configured plugin ids down to non-curated marketplaces and sorts them. It prepares the non-curated subset for cache refresh.

**Data flow**: Calls `configured_plugin_ids`, keeps ids whose marketplace name is not curated, sorts by `PluginId::as_key`, and returns the vector.

**Call relations**: Used by `refresh_non_curated_plugin_cache_with_mode`.

*Call graph*: calls 1 internal fn (configured_plugin_ids); called by 1 (refresh_non_curated_plugin_cache_with_mode).


##### `configured_curated_plugin_ids_from_codex_home`  (lines 638–644)

```
fn configured_curated_plugin_ids_from_codex_home(codex_home: &Path) -> Vec<PluginId>
```

**Purpose**: Convenience helper that reads configured plugins from disk and returns only curated plugin ids. It is used during startup curated sync.

**Data flow**: Calls `configured_plugins_from_codex_home` with curated-specific error messages, then `curated_plugin_ids_from_config_keys` → returns `Vec<PluginId>`.

**Call relations**: Invoked by manager startup code before `refresh_curated_plugin_cache`.

*Call graph*: calls 2 internal fn (configured_plugins_from_codex_home, curated_plugin_ids_from_config_keys).


##### `load_plugin`  (lines 646–759)

```
async fn load_plugin(
    config_name: String,
    plugin: &PluginConfig,
    store: &PluginStore,
    scope: &PluginLoadScope<'_>,
) -> LoadedPlugin<McpServerConfig>
```

**Purpose**: Loads one configured plugin from the local plugin store into a `LoadedPlugin`, optionally with all capabilities or hooks only. It performs validation, manifest parsing, capability discovery, and error recording.

**Data flow**: Takes `config_name`, `PluginConfig`, `PluginStore`, and `PluginLoadScope` → parses `config_name` as `PluginId`, resolves active plugin root or fallback root, initializes a `LoadedPlugin` with empty capabilities and no error, returns early if disabled, invalid, not installed, missing directory, or missing/invalid manifest by setting `error`; in `AllCapabilities` scope it fills `manifest_name`, `manifest_description`, skill roots, resolved skills and disabled paths, computes `has_enabled_skills`, loads MCP servers from each config path and overlays per-server policy via `apply_plugin_mcp_server_policy`, warns on duplicate server definitions within the plugin, and loads app declarations; in all scopes it loads hooks via `load_plugin_hooks` and stores hook warnings → returns the populated `LoadedPlugin<McpServerConfig>`.

**Call relations**: Called from the bulk loader loop. It delegates to most of the file’s parsing helpers and is the central per-plugin assembly routine.

*Call graph*: calls 10 internal fn (apply_plugin_mcp_server_policy, load_mcp_servers_from_file, load_plugin_apps, load_plugin_hooks, load_plugin_skills, plugin_mcp_config_paths, plugin_skill_roots, load_plugin_manifest, plugin_data_root, parse); called by 1 (load_plugins_from_layer_stack_with_scope); 4 external calls (new, new, new, warn!).


##### `apply_plugin_mcp_server_policy`  (lines 761–778)

```
fn apply_plugin_mcp_server_policy(config: &mut McpServerConfig, policy: &PluginMcpServerConfig)
```

**Purpose**: Overlays user/plugin-config policy onto a discovered MCP server config. It updates enablement, default approval mode, tool allow/deny lists, and per-tool approval overrides.

**Data flow**: Mutably reads `config: &mut McpServerConfig` and `policy: &PluginMcpServerConfig` → copies scalar and optional fields from policy into config, cloning enabled/disabled tool lists when present, and updates or creates entries in `config.tools` for per-tool approval modes → returns unit after in-place mutation.

**Call relations**: Called by `load_plugin` for each discovered MCP server whose name has a corresponding policy entry in the configured plugin config.

*Call graph*: called by 1 (load_plugin).


##### `ResolvedPluginSkills::has_enabled_skills`  (lines 788–794)

```
fn has_enabled_skills(&self) -> bool
```

**Purpose**: Determines whether a plugin should be considered as having enabled skills. Any skill-load error counts as enabled, otherwise at least one skill must not be disabled by config rules.

**Data flow**: Reads `self.had_errors`, `self.skills`, and `self.disabled_skill_paths` → returns `true` if there were load errors or if any skill’s `path_to_skills_md` is absent from the disabled set; otherwise returns `false`.

**Call relations**: Used by `load_plugin` after `load_plugin_skills` to set `LoadedPlugin.has_enabled_skills`.


##### `load_plugin_skills`  (lines 797–828)

```
async fn load_plugin_skills(
    plugin_root: &AbsolutePathBuf,
    plugin_id: &PluginId,
    manifest_paths: &PluginManifestPaths,
    restriction_product: Option<Product>,
    skill_config_rules: &S
```

**Purpose**: Loads and filters a plugin’s skills from its skill roots. It applies product restrictions and computes which loaded skills are disabled by config rules.

**Data flow**: Takes plugin root, plugin id, manifest paths, optional product restriction, and `SkillConfigRules` → derives skill roots with `plugin_skill_roots`, wraps them as `SkillRoot` values using `LOCAL_FS`, awaits `load_skills_from_roots`, records whether any loader errors occurred, filters loaded skills by `matches_product_restriction_for_product`, computes disabled skill paths with `resolve_disabled_skill_paths`, and returns `ResolvedPluginSkills { skills, disabled_skill_paths, had_errors }`.

**Call relations**: Called by `load_plugin` and plugin-detail reading to resolve skill metadata consistently.

*Call graph*: calls 3 internal fn (plugin_skill_roots, resolve_disabled_skill_paths, load_skills_from_roots); called by 2 (load_plugin, read_plugin_detail_for_marketplace_plugin).


##### `plugin_skill_roots`  (lines 830–841)

```
fn plugin_skill_roots(
    plugin_root: &AbsolutePathBuf,
    manifest_paths: &PluginManifestPaths,
) -> Vec<AbsolutePathBuf>
```

**Purpose**: Computes the complete set of skill directories for a plugin from defaults and manifest overrides. It deduplicates and sorts the resulting absolute paths.

**Data flow**: Reads `plugin_root` and `manifest_paths` → starts with `default_skill_roots(plugin_root)`, appends `manifest_paths.skills` if present, sorts paths, removes duplicates, and returns `Vec<AbsolutePathBuf>`.

**Call relations**: Used by skill loading and telemetry extraction whenever plugin skill roots are needed.

*Call graph*: calls 1 internal fn (default_skill_roots); called by 3 (load_plugin, load_plugin_skills, plugin_telemetry_metadata_from_root).


##### `default_skill_roots`  (lines 843–850)

```
fn default_skill_roots(plugin_root: &AbsolutePathBuf) -> Vec<AbsolutePathBuf>
```

**Purpose**: Finds the conventional `skills` directory under a plugin root. It returns that directory only if it exists.

**Data flow**: Joins `plugin_root` with `DEFAULT_SKILLS_DIR_NAME`, checks `is_dir`, and returns either a one-element vector containing that path or an empty vector.

**Call relations**: Called by `plugin_skill_roots` as the default skill-root source.

*Call graph*: calls 1 internal fn (join); called by 1 (plugin_skill_roots); 2 external calls (new, vec!).


##### `plugin_mcp_config_paths`  (lines 852–860)

```
fn plugin_mcp_config_paths(
    plugin_root: &Path,
    manifest_paths: &PluginManifestPaths,
) -> Vec<AbsolutePathBuf>
```

**Purpose**: Determines which MCP config files should be read for a plugin. A manifest-declared MCP path overrides the default `.mcp.json` discovery.

**Data flow**: Reads `plugin_root` and `manifest_paths` → if `manifest_paths.mcp_servers` is present returns a single-element vector containing that path; otherwise delegates to `default_mcp_config_paths`.

**Call relations**: Used by plugin loading, declared-MCP loading, and telemetry extraction.

*Call graph*: calls 1 internal fn (default_mcp_config_paths); called by 3 (load_declared_plugin_mcp_servers, load_plugin, plugin_telemetry_metadata_from_root); 1 external calls (vec!).


##### `default_mcp_config_paths`  (lines 862–873)

```
fn default_mcp_config_paths(plugin_root: &Path) -> Vec<AbsolutePathBuf>
```

**Purpose**: Finds the conventional `.mcp.json` file under a plugin root. It returns a sorted, deduplicated list containing that file when present.

**Data flow**: Builds `plugin_root/.mcp.json`, checks `is_file`, converts it to `AbsolutePathBuf` if possible, pushes it into a vector, sorts by path, deduplicates equal paths, and returns the vector.

**Call relations**: Called by `plugin_mcp_config_paths` when the manifest does not specify MCP config paths.

*Call graph*: calls 1 internal fn (try_from); called by 1 (plugin_mcp_config_paths); 2 external calls (join, new).


##### `load_plugin_apps`  (lines 875–884)

```
async fn load_plugin_apps(plugin_root: &Path) -> Vec<AppDeclaration>
```

**Purpose**: Loads app declarations from a plugin’s `.app.json` files, honoring manifest path overrides when available. It falls back to the default app config path if the manifest is missing or invalid.

**Data flow**: Reads `plugin_root` → if `load_plugin_manifest(plugin_root)` succeeds, computes app config paths with `plugin_app_config_paths(plugin_root, &manifest.paths)` and awaits `load_apps_from_paths`; otherwise computes `default_app_config_paths(plugin_root)` and loads from those paths → returns `Vec<AppDeclaration>`.

**Call relations**: Used by full plugin loading, plugin detail reading, and auth-sensitive MCP routing.

*Call graph*: calls 4 internal fn (default_app_config_paths, load_apps_from_paths, plugin_app_config_paths, load_plugin_manifest); called by 3 (load_plugin, load_plugin_mcp_servers, read_plugin_detail_for_marketplace_plugin).


##### `plugin_app_declarations_from_value`  (lines 886–894)

```
fn plugin_app_declarations_from_value(value: &JsonValue) -> Vec<AppDeclaration>
```

**Purpose**: Parses app declarations directly from a JSON value and removes duplicate connector ids. It is a pure helper for callers that already have JSON in memory.

**Data flow**: Clones the input `serde_json::Value`, attempts to deserialize it as `PluginAppFile`, returns empty on failure, converts the parsed file to declarations with `app_declarations_from_file(parsed, None)`, then retains only the first declaration for each unique `connector_id.0` using a `HashSet` → returns `Vec<AppDeclaration>`.

**Call relations**: Used by code that needs app declarations from arbitrary JSON values rather than filesystem paths.

*Call graph*: calls 1 internal fn (app_declarations_from_file); called by 1 (plugin_app_category_by_id_from_value); 3 external calls (new, clone, new).


##### `plugin_app_config_paths`  (lines 896–904)

```
fn plugin_app_config_paths(
    plugin_root: &Path,
    manifest_paths: &PluginManifestPaths,
) -> Vec<AbsolutePathBuf>
```

**Purpose**: Determines which app config files should be read for a plugin. A manifest-declared apps path overrides the default `.app.json` discovery.

**Data flow**: Reads `plugin_root` and `manifest_paths` → if `manifest_paths.apps` is present returns a single-element vector containing that path; otherwise delegates to `default_app_config_paths`.

**Call relations**: Used by `load_plugin_apps` and telemetry extraction.

*Call graph*: calls 1 internal fn (default_app_config_paths); called by 2 (load_plugin_apps, plugin_telemetry_metadata_from_root); 1 external calls (vec!).


##### `default_app_config_paths`  (lines 906–917)

```
fn default_app_config_paths(plugin_root: &Path) -> Vec<AbsolutePathBuf>
```

**Purpose**: Finds the conventional `.app.json` file under a plugin root. It returns a sorted, deduplicated list containing that file when present.

**Data flow**: Builds `plugin_root/.app.json`, checks `is_file`, converts it to `AbsolutePathBuf` if possible, pushes it into a vector, sorts by path, deduplicates equal paths, and returns the vector.

**Call relations**: Called by `plugin_app_config_paths` and by `load_plugin_apps` when no manifest is available.

*Call graph*: calls 1 internal fn (try_from); called by 2 (load_plugin_apps, plugin_app_config_paths); 2 external calls (join, new).


##### `load_plugin_hooks`  (lines 922–976)

```
fn load_plugin_hooks(
    plugin_root: &AbsolutePathBuf,
    plugin_id: &PluginId,
    plugin_data_root: &AbsolutePathBuf,
    manifest_paths: &PluginManifestPaths,
) -> (Vec<PluginHookSource>, Vec<St
```

**Purpose**: Discovers hook declarations for a plugin from manifest-declared hook files, inline manifest hook objects, or the default `hooks/hooks.json`. It also accumulates human-readable warnings for unreadable or invalid hook files.

**Data flow**: Reads plugin root, plugin id, plugin data root, and manifest paths → initializes `sources` and `warnings`; if `manifest_paths.hooks` is `Paths`, iterates each path and delegates to `append_plugin_hook_file`; if it is `Inline`, resolves the manifest path and pushes one `PluginHookSource` per non-empty inline hooks object with `source_relative_path` like `plugin.json#hooks[index]`; if hooks are absent, checks for `hooks/hooks.json` and appends it if present → returns `(Vec<PluginHookSource>, Vec<String>)`.

**Call relations**: Called by `load_plugin` and plugin-detail reading; it centralizes all hook-source discovery modes.

*Call graph*: calls 3 internal fn (append_plugin_hook_file, as_path, join); called by 2 (load_plugin, read_plugin_detail_for_marketplace_plugin); 5 external calls (new, find_plugin_manifest_path, format!, clone, clone).


##### `append_plugin_hook_file`  (lines 980–1027)

```
fn append_plugin_hook_file(
    plugin_root: &AbsolutePathBuf,
    plugin_id: &PluginId,
    plugin_data_root: &AbsolutePathBuf,
    path: &AbsolutePathBuf,
    sources: &mut Vec<PluginHookSource>,
```

**Purpose**: Reads one hook config file, parses it, and appends a `PluginHookSource` if it contains hooks. Failures are converted into warning strings instead of hard errors.

**Data flow**: Takes plugin root/id/data root, a hook file path, and mutable `sources`/`warnings` vectors → reads the file as text, pushes a formatted warning and returns on read failure, parses it as `HooksFile`, pushes a parse warning and returns on parse failure, returns silently if `parsed.hooks` is empty, computes a source-relative path by stripping the plugin root prefix when possible, and pushes a `PluginHookSource` containing cloned plugin metadata and parsed hooks.

**Call relations**: Used internally by `load_plugin_hooks` for both manifest-declared and default hook files.

*Call graph*: calls 1 internal fn (as_path); called by 1 (load_plugin_hooks); 4 external calls (format!, read_to_string, clone, clone).


##### `load_apps_from_paths`  (lines 1029–1052)

```
async fn load_apps_from_paths(
    plugin_root: &Path,
    app_config_paths: Vec<AbsolutePathBuf>,
) -> Vec<AppDeclaration>
```

**Purpose**: Loads and concatenates app declarations from one or more app config files. Invalid files are skipped with warnings.

**Data flow**: Takes `plugin_root` and a vector of app config paths → asynchronously reads each file, skips unreadable files, parses JSON as `PluginAppFile`, warns and skips on parse failure, converts each parsed file to declarations with `app_declarations_from_file(parsed, Some(plugin_root))`, extends an output vector, and returns the combined declarations.

**Call relations**: Called by `load_plugin_apps` and telemetry extraction after path resolution.

*Call graph*: calls 1 internal fn (app_declarations_from_file); called by 2 (load_plugin_apps, plugin_telemetry_metadata_from_root); 3 external calls (new, read_to_string, warn!).


##### `app_declarations_from_file`  (lines 1054–1079)

```
fn app_declarations_from_file(
    parsed: PluginAppFile,
    plugin_root: Option<&Path>,
) -> Vec<AppDeclaration>
```

**Purpose**: Converts a parsed `.app.json` structure into `AppDeclaration` values. Entries with blank ids are dropped, and categories are normalized.

**Data flow**: Consumes `PluginAppFile` and optional `plugin_root` → iterates `parsed.apps`, trims and validates each `id`, warns and skips missing ids when `plugin_root` is available, otherwise constructs `AppDeclaration { name, connector_id: AppConnectorId(app.id), category: cleaned_app_category(app.category) }` → collects and returns `Vec<AppDeclaration>`.

**Call relations**: Shared by filesystem-based app loading and in-memory JSON parsing.

*Call graph*: called by 2 (load_apps_from_paths, plugin_app_declarations_from_value).


##### `cleaned_app_category`  (lines 1081–1085)

```
fn cleaned_app_category(category: Option<String>) -> Option<String>
```

**Purpose**: Normalizes optional app category strings by trimming whitespace and dropping empty results. It prevents blank categories from being propagated.

**Data flow**: Takes `Option<String>` → trims the contained string if present, converts it back to owned `String`, filters out empty strings, and returns `Option<String>`.

**Call relations**: Used by `app_declarations_from_file` when constructing `AppDeclaration.category`.


##### `plugin_telemetry_metadata_from_root`  (lines 1087–1128)

```
async fn plugin_telemetry_metadata_from_root(
    plugin_id: &PluginId,
    plugin_root: &AbsolutePathBuf,
) -> PluginTelemetryMetadata
```

**Purpose**: Builds telemetry metadata for a plugin directly from its root directory. It summarizes whether the plugin has skills, which MCP servers it declares, and which app connector ids it exposes.

**Data flow**: Reads `plugin_id` and `plugin_root` → loads the manifest, returning `PluginTelemetryMetadata::from_plugin_id(plugin_id)` if missing; otherwise computes `has_skills` from `plugin_skill_roots`, loads and unions MCP server names from all MCP config paths, sorts and deduplicates them, loads app declarations from app config paths and converts them to connector ids, then returns `PluginTelemetryMetadata { plugin_id, remote_plugin_id: None, capability_summary: Some(PluginCapabilitySummary { config_name: plugin_id.as_key(), display_name: plugin_id.plugin_name.clone(), description: None, has_skills, mcp_server_names, app_connector_ids }) }`.

**Call relations**: Used when emitting analytics for installed/uninstalled plugins and during installation flows.

*Call graph*: calls 9 internal fn (load_apps_from_paths, load_mcp_servers_from_file, plugin_app_config_paths, plugin_mcp_config_paths, plugin_skill_roots, load_plugin_manifest, from_plugin_id, as_key, as_path); called by 2 (installed_plugin_telemetry_metadata, install_resolved_plugin); 3 external calls (new, app_connector_ids_from_declarations, clone).


##### `load_plugin_mcp_servers`  (lines 1130–1147)

```
async fn load_plugin_mcp_servers(
    plugin_root: &Path,
    auth_mode: Option<AuthMode>,
) -> HashMap<String, McpServerConfig>
```

**Purpose**: Loads a plugin’s declared MCP servers and applies auth-sensitive app/MCP routing policy when appropriate. It is the MCP-specific view used for plugin detail inspection.

**Data flow**: Reads `plugin_root` and optional `auth_mode` → awaits `load_declared_plugin_mcp_servers`, returns immediately if the apps route is unavailable or no MCP servers were declared, otherwise loads plugin apps, mutates apps and MCP servers in place via `apply_app_mcp_routing_policy` with `plugin_active = true`, and returns the resulting `HashMap<String, McpServerConfig>`.

**Call relations**: Called by plugin-detail reading; it composes raw MCP loading with app-routing policy.

*Call graph*: calls 4 internal fn (apply_app_mcp_routing_policy, apps_route_available, load_declared_plugin_mcp_servers, load_plugin_apps); called by 1 (read_plugin_detail_for_marketplace_plugin).


##### `load_declared_plugin_mcp_servers`  (lines 1149–1163)

```
async fn load_declared_plugin_mcp_servers(plugin_root: &Path) -> HashMap<String, McpServerConfig>
```

**Purpose**: Loads MCP servers exactly as declared by plugin files, without app-routing adjustments. Duplicate server names across files keep the first definition.

**Data flow**: Loads the plugin manifest, returning an empty map if absent, iterates MCP config paths from `plugin_mcp_config_paths`, awaits `load_mcp_servers_from_file` for each, and inserts each `(name, config)` into a map with `entry(...).or_insert(config)` so earlier definitions win → returns the map.

**Call relations**: Used by `load_plugin_mcp_servers` as the raw MCP discovery step.

*Call graph*: calls 3 internal fn (load_mcp_servers_from_file, plugin_mcp_config_paths, load_plugin_manifest); called by 1 (load_plugin_mcp_servers); 1 external calls (new).


##### `installed_plugin_telemetry_metadata`  (lines 1165–1181)

```
async fn installed_plugin_telemetry_metadata(
    codex_home: &Path,
    plugin_id: &PluginId,
) -> PluginTelemetryMetadata
```

**Purpose**: Fetches telemetry metadata for an installed plugin from the plugin store. It falls back to id-only metadata when the store or active root cannot be resolved.

**Data flow**: Takes `codex_home` and `plugin_id` → attempts `PluginStore::try_new`, warns and returns `PluginTelemetryMetadata::from_plugin_id(plugin_id)` on failure, resolves `store.active_plugin_root(plugin_id)`, returns id-only metadata if absent, otherwise awaits `plugin_telemetry_metadata_from_root(plugin_id, &plugin_root)` and returns it.

**Call relations**: Used by manager uninstall and analytics flows when a plugin may or may not still be installed.

*Call graph*: calls 3 internal fn (plugin_telemetry_metadata_from_root, try_new, from_plugin_id); called by 2 (emit_plugin_toggle_events, uninstall_plugin_id); 2 external calls (to_path_buf, warn!).


##### `load_mcp_servers_from_file`  (lines 1183–1213)

```
async fn load_mcp_servers_from_file(
    plugin_root: &Path,
    mcp_config_path: &AbsolutePathBuf,
) -> PluginMcpDiscovery
```

**Purpose**: Parses one plugin MCP config file into discovered server configs and logs any parse problems. Invalid files yield an empty discovery result rather than failing the caller.

**Data flow**: Reads `plugin_root` and `mcp_config_path` → asynchronously reads the file, returning `PluginMcpDiscovery::default()` on read failure, parses contents with `parse_plugin_mcp_config(..., PluginMcpServerPlacement::Declared)`, warns and returns default on top-level parse failure, logs each per-server parse error from `parsed.errors`, converts `parsed.servers` into a `HashMap<String, McpServerConfig>`, and returns `PluginMcpDiscovery { mcp_servers }`.

**Call relations**: Called by plugin loading, declared-MCP loading, and telemetry extraction whenever MCP config files need parsing.

*Call graph*: calls 1 internal fn (as_path); called by 3 (load_declared_plugin_mcp_servers, load_plugin, plugin_telemetry_metadata_from_root); 4 external calls (parse_plugin_mcp_config, default, read_to_string, warn!).


##### `materialize_marketplace_plugin_source`  (lines 1226–1279)

```
fn materialize_marketplace_plugin_source(
    codex_home: &Path,
    source: &MarketplacePluginSource,
) -> Result<MaterializedMarketplacePluginSource, String>
```

**Purpose**: Turns a marketplace plugin source into a local filesystem path that can be installed or inspected. Local sources are passed through; git sources are cloned into a temporary staging directory.

**Data flow**: Reads `codex_home` and a `MarketplacePluginSource` → for `Local { path }`, returns `MaterializedMarketplacePluginSource { path: path.clone(), _tempdir: None }`; for `Git { url, path, ref_name, sha }`, creates `plugins/.marketplace-plugin-source-staging` under `codex_home`, creates a tempdir inside it, clones the git source via `clone_git_plugin_source`, resolves either the checkout root or requested subpath as an `AbsolutePathBuf`, and returns `MaterializedMarketplacePluginSource { path, _tempdir: Some(tempdir) }`. Errors are converted to descriptive `String`s.

**Call relations**: Used by non-curated cache refresh and plugin installation/detail flows whenever a marketplace source must be materialized locally.

*Call graph*: calls 2 internal fn (clone_git_plugin_source, try_from); called by 1 (refresh_non_curated_plugin_cache_with_mode); 3 external calls (join, create_dir_all, new).


##### `clone_git_plugin_source`  (lines 1281–1322)

```
fn clone_git_plugin_source(
    url: &str,
    ref_name: Option<&str>,
    sha: Option<&str>,
    sparse_checkout_path: Option<&str>,
    destination: &Path,
) -> Result<(), String>
```

**Purpose**: Clones a git-backed marketplace plugin source into a destination directory, optionally using sparse checkout for a subdirectory and checking out a specific ref or SHA. It encapsulates the git command sequence.

**Data flow**: Takes repository `url`, optional `ref_name`, optional `sha`, optional `sparse_checkout_path`, and destination path → if a sparse path is provided, runs `git clone --filter=blob:none --sparse --no-checkout`, then `git sparse-checkout set --no-cone -- <path>`; otherwise runs a normal `git clone`; then checks out `sha` or `ref_name` if provided, or runs plain `git checkout` after sparse clone to populate files → returns `Result<(), String>`.

**Call relations**: Called only by `materialize_marketplace_plugin_source` for git sources.

*Call graph*: calls 1 internal fn (run_git); called by 1 (materialize_marketplace_plugin_source); 1 external calls (to_string_lossy).


##### `run_git`  (lines 1324–1346)

```
fn run_git(args: &[&str], cwd: Option<&Path>) -> Result<(), String>
```

**Purpose**: Executes a git subprocess with prompts disabled and converts failures into detailed error strings containing stdout and stderr. It is the lowest-level shelling-out helper in this file.

**Data flow**: Builds `Command::new("git")`, adds `args`, sets `GIT_TERMINAL_PROMPT=0`, optionally sets `current_dir`, runs `output()`, returns an error string if process launch fails, returns `Ok(())` on success status, otherwise formats a multi-line error including command, exit status, trimmed stdout, and trimmed stderr.

**Call relations**: Used by `clone_git_plugin_source` for each git operation in the clone/checkout sequence.

*Call graph*: called by 1 (clone_git_plugin_source); 2 external calls (new, format!).


### `core-plugins/src/manager.rs`

`orchestration` · `startup, plugin listing, install/uninstall, background refresh`

This file defines most of the crate’s public operational API. It starts with DTOs and cache-key types: `PluginsConfigInput`, install/read outcomes, `PluginDetail`, configured marketplace summaries, and error enums. `PluginsManager` itself owns CODEX_HOME, a `PluginStore`, several `RwLock`-protected caches (loaded plugins, featured ids, recommended mode, remote installed plugins), refresh-state machines for background tasks, an auth mode, optional analytics client, and an optional product restriction.

The manager’s core runtime path is `plugins_for_config_with_force_reload`. It computes a cache key from configured plugins, skill rules, and the remote-plugin feature flag; serves cached loaded plugins when possible; otherwise serializes loading through a semaphore, calls `load_plugins_from_layer_stack`, logs plugin load errors, caches the result, and finally applies auth-sensitive app/MCP routing in `resolve_loaded_plugins_for_auth`. Separate APIs expose uncached loading for arbitrary layer stacks, hooks-only loading, and effective skill roots.

Marketplace-facing methods assemble roots from configured marketplaces plus curated catalogs, list marketplaces with installed/enabled state and product filtering, read plugin details, and install or uninstall plugins. Detail reads materialize git sources when necessary, load manifest/interface/skills/hooks/apps/MCP metadata, and return a `PluginDetail`; uninstalled git plugins instead return a placeholder description with `InstallRequiredForRemoteSource`. Install and uninstall flows update user config, interact with remote legacy APIs when requested, and emit analytics telemetry.

The rest of the file is orchestration for background maintenance: startup curated repo sync, configured marketplace auto-upgrade, non-curated cache refresh, remote installed-plugin cache refresh, remote bundle sync, global remote catalog warming, featured-plugin-id caching, and recommended-plugin-mode caching. Each background subsystem has explicit request/state structs so repeated triggers collapse onto one worker while preserving stronger notifications such as `AfterSuccessfulRefresh`. The design emphasizes deterministic cache invalidation—whenever installed plugin state or marketplace contents change, the loaded-plugin cache is cleared so subsequent reads recompute effective capabilities.

#### Function details

##### `PluginsConfigInput::new`  (lines 102–114)

```
fn new(
        config_layer_stack: ConfigLayerStack,
        plugins_enabled: bool,
        remote_plugin_enabled: bool,
        chatgpt_base_url: String,
    ) -> Self
```

**Purpose**: Constructs the immutable configuration bundle passed into manager operations. It packages the effective config stack, feature flags, and backend base URL.

**Data flow**: Takes `ConfigLayerStack`, `plugins_enabled`, `remote_plugin_enabled`, and `chatgpt_base_url` → stores them directly in a new `PluginsConfigInput` and returns it.

**Call relations**: Used by config-loading helpers and tests to prepare inputs for `PluginsManager` methods.

*Call graph*: called by 2 (load_plugins_config, plugins_config_input).


##### `remote_plugin_service_config`  (lines 201–205)

```
fn remote_plugin_service_config(config: &PluginsConfigInput) -> RemotePluginServiceConfig
```

**Purpose**: Projects `PluginsConfigInput` down to the remote-service settings needed by remote API helpers. Currently that is just the ChatGPT backend base URL.

**Data flow**: Reads `config.chatgpt_base_url`, clones it into `RemotePluginServiceConfig`, and returns the new struct.

**Call relations**: Called by all manager methods that talk to remote plugin APIs or caches so remote configuration stays consistent.

*Call graph*: called by 9 (build_and_cache_remote_installed_plugin_marketplaces, cached_global_remote_discoverable_plugins_for_config, featured_plugin_ids_for_config, install_plugin_with_remote_sync, maybe_start_global_remote_catalog_cache_refresh, maybe_start_plugin_startup_tasks_for_config, maybe_start_remote_installed_plugin_bundle_sync, maybe_start_remote_installed_plugins_cache_refresh_with_notify, uninstall_plugin_with_remote_sync).


##### `featured_plugin_ids_cache_key`  (lines 207–217)

```
fn featured_plugin_ids_cache_key(
    config: &PluginsConfigInput,
    auth: Option<&CodexAuth>,
) -> FeaturedPluginIdsCacheKey
```

**Purpose**: Builds the cache key for featured-plugin-id responses. It scopes the cache by backend URL and relevant auth identity fields.

**Data flow**: Reads `PluginsConfigInput` and optional `CodexAuth` → clones `chatgpt_base_url`, extracts `account_id`, `chatgpt_user_id`, and workspace-account status from auth when present, and returns `FeaturedPluginIdsCacheKey`.

**Call relations**: Used only by `featured_plugin_ids_for_config` to look up and populate the featured-plugin-id cache.

*Call graph*: called by 1 (featured_plugin_ids_for_config).


##### `recommended_plugins_cache_key`  (lines 219–223)

```
fn recommended_plugins_cache_key(config: &PluginsConfigInput) -> RecommendedPluginsCacheKey
```

**Purpose**: Builds the cache key for recommended-plugin mode. The cache is keyed only by backend URL.

**Data flow**: Reads `config.chatgpt_base_url`, clones it into `RecommendedPluginsCacheKey`, and returns it.

**Call relations**: Used by `recommended_plugins_mode_for_config` and its cache helpers.

*Call graph*: called by 1 (recommended_plugins_mode_for_config).


##### `PluginCapabilitySummary::from`  (lines 313–327)

```
fn from(value: PluginDetail) -> Self
```

**Purpose**: Converts a rich `PluginDetail` into the smaller capability summary used elsewhere in the system. It computes `has_skills` from enabled skill paths and sanitizes the description for prompt use.

**Data flow**: Consumes `PluginDetail` → checks whether any `skills` entry is not listed in `disabled_skill_paths`, passes `description.as_deref()` through `prompt_safe_plugin_description`, and returns `PluginCapabilitySummary { config_name: id, display_name: name, description, has_skills, mcp_server_names, app_connector_ids: apps }`.

**Call relations**: Used by discoverable-plugin logic and other callers that need a compact capability view after reading full plugin details.

*Call graph*: 1 external calls (prompt_safe_plugin_description).


##### `PluginsManager::new`  (lines 370–372)

```
fn new(codex_home: PathBuf) -> Self
```

**Purpose**: Creates a manager with the default product restriction (`Product::Codex`) and no initial auth mode. It is the standard constructor used by most callers.

**Data flow**: Takes `codex_home: PathBuf` → delegates to `PluginsManager::new_with_options(codex_home, Some(Product::Codex), None)` → returns the new manager.

**Call relations**: Primary entry point for constructing the plugin manager across CLI, app-server, and tests.

*Call graph*: called by 84 (detect_migrations, import_plugins, run_list, run_upgrade, run_get, run_list, run_login, run_logout, load_plugin_command_context, deduplicates_configured_marketplace_plugin (+15 more)); 1 external calls (new_with_options).


##### `PluginsManager::new_with_options`  (lines 374–409)

```
fn new_with_options(
        codex_home: PathBuf,
        restriction_product: Option<Product>,
        auth_mode: Option<AuthMode>,
    ) -> Self
```

**Purpose**: Constructs a fully initialized manager with explicit product restriction and auth mode. It allocates all caches, locks, semaphores, and background-task state.

**Data flow**: Consumes `codex_home`, optional `restriction_product`, and optional `auth_mode` → clones/stores `codex_home`, creates `PluginStore::new`, initializes all `RwLock`-wrapped caches and state structs to empty/default values, creates a one-permit `Semaphore`, stores the restriction and auth mode, and returns `PluginsManager`.

**Call relations**: Called by `new` and by tests that need non-default product or auth settings.

*Call graph*: calls 1 internal fn (new); called by 14 (featured_plugin_ids_for_config_defaults_query_param_to_codex, featured_plugin_ids_for_config_uses_restriction_product_query_param, load_plugins_from_config, plugin_auth_projection_hides_apps_without_chatgpt_auth, plugin_auth_projection_hides_dual_surface_mcp_with_agent_identity_apps_route, plugin_auth_projection_hides_matching_mcp_with_chatgpt_apps_route, plugin_auth_projection_keeps_non_conflicting_mcp_with_chatgpt_apps_route, plugin_auth_projection_preserves_duplicate_connector_declaration_names, plugin_auth_projection_reprojects_cached_plugins_when_auth_changes, plugins_manager_tracks_auth_mode (+4 more)); 9 external calls (new, clone, new, new, default, default, default, default, default).


##### `PluginsManager::set_auth_mode`  (lines 411–421)

```
fn set_auth_mode(&self, auth_mode: Option<AuthMode>) -> bool
```

**Purpose**: Updates the manager’s current auth mode and reports whether it changed. This auth mode later affects app/MCP routing and curated marketplace selection.

**Data flow**: Acquires the `auth_mode` write lock, compares the stored value with the new `Option<AuthMode>`, returns `false` if unchanged, otherwise writes the new value and returns `true`.

**Call relations**: Called by higher-level runtime code when auth state changes; subsequent plugin resolution methods read this stored mode.


##### `PluginsManager::auth_mode`  (lines 423–428)

```
fn auth_mode(&self) -> Option<AuthMode>
```

**Purpose**: Returns the manager’s current auth mode, tolerating poisoned locks by recovering the inner value. It is the read accessor for auth-sensitive policy decisions.

**Data flow**: Acquires the `auth_mode` read lock (or poisoned inner value) and returns the copied `Option<AuthMode>`.

**Call relations**: Used by plugin-detail reading and loaded-plugin auth projection.

*Call graph*: called by 2 (read_plugin_detail_for_marketplace_plugin, resolve_loaded_plugins_for_auth).


##### `PluginsManager::set_analytics_events_client`  (lines 430–436)

```
fn set_analytics_events_client(&self, analytics_events_client: AnalyticsEventsClient)
```

**Purpose**: Registers an analytics client used to emit plugin install/uninstall telemetry. It replaces any previously stored client.

**Data flow**: Acquires the `analytics_events_client` write lock and stores `Some(analytics_events_client)`.

**Call relations**: Called during manager setup; install and uninstall flows later read this client to emit events.


##### `PluginsManager::restriction_product_matches`  (lines 438–446)

```
fn restriction_product_matches(&self, products: Option<&[Product]>) -> bool
```

**Purpose**: Checks whether a plugin or marketplace product restriction is compatible with this manager’s configured product. `None` means unrestricted, while an empty list means never allowed.

**Data flow**: Reads optional `products: Option<&[Product]>` and `self.restriction_product` → returns `true` for `None`, `false` for `Some([])`, otherwise asks the stored product whether it matches the restriction list and returns that boolean.

**Call relations**: Used by marketplace listing and plugin-detail reads to filter out plugins not admitted for the current product.

*Call graph*: called by 2 (read_plugin_detail_for_marketplace_plugin, read_plugin_for_config).


##### `PluginsManager::plugins_for_config`  (lines 448–451)

```
async fn plugins_for_config(&self, config: &PluginsConfigInput) -> PluginLoadOutcome
```

**Purpose**: Loads effective plugins for a config using the normal cache-aware path. It is the public convenience wrapper around the force-reload variant.

**Data flow**: Takes `&PluginsConfigInput` → awaits `plugins_for_config_with_force_reload(config, false)` → returns `PluginLoadOutcome`.

**Call relations**: Called by consumers that need effective plugin capabilities, such as MCP and hook builders.

*Call graph*: calls 1 internal fn (plugins_for_config_with_force_reload); called by 2 (to_mcp_config_with_plugin_registrations, build_hooks_for_config).


##### `PluginsManager::plugins_for_config_with_force_reload`  (lines 458–495)

```
async fn plugins_for_config_with_force_reload(
        &self,
        config: &PluginsConfigInput,
        force_reload: bool,
    ) -> PluginLoadOutcome
```

**Purpose**: Loads effective plugins for a config, optionally bypassing the loaded-plugin cache. It is the manager’s main plugin-resolution path.

**Data flow**: Reads `config` and `force_reload` → returns default outcome immediately if plugins are disabled; otherwise builds a `PluginLoadCacheKey` from configured plugins, skill rules, and `remote_plugin_enabled`, checks `cached_loaded_plugins` unless forced, acquires the load semaphore, rechecks the cache, records cache generation, awaits `load_plugins_from_layer_stack` with remote-installed plugin configs and product restriction, logs plugin load errors, caches the loaded plugins if generation is unchanged, then passes them through `resolve_loaded_plugins_for_auth` and returns the resulting `PluginLoadOutcome`.

**Call relations**: Called by `plugins_for_config`; it delegates actual loading to `loader.rs` and owns cache lookup, serialization, and auth projection.

*Call graph*: calls 10 internal fn (load_plugins_from_layer_stack, log_plugin_load_errors, cache_loaded_plugins_if_current, cached_loaded_plugins, loaded_plugins_cache_generation, remote_installed_plugin_configs, resolve_loaded_plugins_for_auth, configured_plugins_from_stack, skill_config_rules_from_stack, default); called by 1 (plugins_for_config); 2 external calls (acquire, warn!).


##### `PluginsManager::resolve_loaded_plugins_for_auth`  (lines 497–509)

```
fn resolve_loaded_plugins_for_auth(&self, mut plugins: Vec<LoadedPlugin>) -> PluginLoadOutcome
```

**Purpose**: Applies auth-dependent app/MCP routing policy to already loaded plugins and converts them into a `PluginLoadOutcome`. It is the final projection step before returning plugin capabilities to callers.

**Data flow**: Takes mutable ownership of `Vec<LoadedPlugin>` → reads current `auth_mode`, iterates each plugin, computes `plugin_active = plugin.is_active()`, mutates `plugin.apps` and `plugin.mcp_servers` via `apply_app_mcp_routing_policy`, then returns `PluginLoadOutcome::from_plugins(plugins)`.

**Call relations**: Used after cache hits and fresh loads, and also by uncached layer-stack loading, so auth-sensitive routing is applied consistently regardless of source.

*Call graph*: calls 3 internal fn (apply_app_mcp_routing_policy, auth_mode, from_plugins); called by 2 (plugins_for_config_with_force_reload, plugins_for_layer_stack).


##### `PluginsManager::clear_cache`  (lines 511–518)

```
fn clear_cache(&self)
```

**Purpose**: Clears the loaded-plugin cache and featured-plugin-id cache. It is the broad invalidation hook used after plugin or marketplace state changes.

**Data flow**: Calls `clear_loaded_plugins_cache`, then acquires the featured-plugin-id cache write lock and sets it to `None`.

**Call relations**: Invoked after cache refreshes and marketplace upgrades when effective plugin state may have changed.

*Call graph*: calls 1 internal fn (clear_loaded_plugins_cache); called by 2 (run_non_curated_plugin_cache_refresh_loop, upgrade_configured_marketplaces_for_config).


##### `PluginsManager::clear_recommended_plugins_cache`  (lines 520–531)

```
fn clear_recommended_plugins_cache(&self)
```

**Purpose**: Clears both the cached recommended-plugin modes and any in-flight refresh cells. It forces future recommendation-mode requests to refetch.

**Data flow**: Acquires the `recommended_plugins_refreshes` write lock and clears it, then acquires the `recommended_plugins_cache` write lock and clears that map.

**Call relations**: Used when recommendation-mode cache invalidation is needed independently of plugin capability caches.


##### `PluginsManager::clear_loaded_plugins_cache`  (lines 533–540)

```
fn clear_loaded_plugins_cache(&self)
```

**Purpose**: Invalidates the loaded-plugin cache by bumping its generation and dropping the cached entry. The generation guard prevents stale concurrent loads from repopulating the cache.

**Data flow**: Acquires the `loaded_plugins_cache` write lock, increments `generation` with wrapping add, and sets `entry` to `None`.

**Call relations**: Called by broader cache-clearing methods and whenever remote installed plugin state changes.

*Call graph*: called by 3 (clear_cache, clear_remote_installed_plugins_cache, write_remote_installed_plugins_cache).


##### `PluginsManager::plugins_for_layer_stack`  (lines 543–560)

```
async fn plugins_for_layer_stack(
        &self,
        config_layer_stack: &ConfigLayerStack,
        config: &PluginsConfigInput,
    ) -> PluginLoadOutcome
```

**Purpose**: Loads plugins for an arbitrary config layer stack without touching the manager’s loaded-plugin cache. It is useful for previewing or evaluating alternate config stacks.

**Data flow**: Reads `config_layer_stack` and `config` → returns default outcome if plugins are disabled; otherwise awaits `load_plugins_from_layer_stack` with remote-installed plugin configs, store, product restriction, and remote-plugin flag, then passes the result through `resolve_loaded_plugins_for_auth` and returns it.

**Call relations**: Used by `effective_skill_roots_for_layer_stack` and other callers that need uncached plugin resolution.

*Call graph*: calls 4 internal fn (load_plugins_from_layer_stack, remote_installed_plugin_configs, resolve_loaded_plugins_for_auth, default); called by 1 (effective_skill_roots_for_layer_stack).


##### `PluginsManager::plugin_hooks_for_layer_stack`  (lines 563–578)

```
async fn plugin_hooks_for_layer_stack(
        &self,
        config_layer_stack: &ConfigLayerStack,
        config: &PluginsConfigInput,
    ) -> PluginHookLoadOutcome
```

**Purpose**: Resolves plugin hooks for an arbitrary config layer stack without loading other capabilities or using the loaded-plugin cache. It is the manager-level hook-only API.

**Data flow**: Reads `config_layer_stack` and `config` → returns default `PluginHookLoadOutcome` if plugins are disabled; otherwise awaits `load_plugin_hooks_from_layer_stack` with remote-installed plugin configs, store, and remote-plugin flag, and returns the result.

**Call relations**: Used by hook-building code that needs plugin hook declarations only.

*Call graph*: calls 2 internal fn (load_plugin_hooks_from_layer_stack, remote_installed_plugin_configs); 1 external calls (default).


##### `PluginsManager::effective_skill_roots_for_layer_stack`  (lines 581–589)

```
async fn effective_skill_roots_for_layer_stack(
        &self,
        config_layer_stack: &ConfigLayerStack,
        config: &PluginsConfigInput,
    ) -> Vec<PluginSkillRoot>
```

**Purpose**: Returns the effective plugin skill roots for a given config layer stack. It is a convenience wrapper over uncached plugin loading.

**Data flow**: Awaits `plugins_for_layer_stack(config_layer_stack, config)`, then calls `.effective_plugin_skill_roots()` on the resulting `PluginLoadOutcome` and returns the vector.

**Call relations**: Delegates entirely to `plugins_for_layer_stack` and the outcome type’s skill-root extraction.

*Call graph*: calls 1 internal fn (plugins_for_layer_stack).


##### `PluginsManager::cached_loaded_plugins`  (lines 591–605)

```
fn cached_loaded_plugins(&self, key: &PluginLoadCacheKey) -> Option<Vec<LoadedPlugin>>
```

**Purpose**: Looks up a cached loaded-plugin vector by exact cache key. It clones the cached plugins so callers can mutate them for auth projection.

**Data flow**: Reads the `loaded_plugins_cache` lock (recovering from poison if needed), checks whether `entry.key == *key`, and if so clones and returns `entry.plugins`; otherwise returns `None`.

**Call relations**: Used by `plugins_for_config_with_force_reload` before and after acquiring the load semaphore.

*Call graph*: called by 1 (plugins_for_config_with_force_reload).


##### `PluginsManager::loaded_plugins_cache_generation`  (lines 607–612)

```
fn loaded_plugins_cache_generation(&self) -> u64
```

**Purpose**: Returns the current generation counter for the loaded-plugin cache. It lets concurrent loads detect whether the cache was invalidated while they were running.

**Data flow**: Reads the `loaded_plugins_cache` lock (or poisoned inner value) and returns `generation`.

**Call relations**: Used by `plugins_for_config_with_force_reload` before starting a fresh load.

*Call graph*: called by 1 (plugins_for_config_with_force_reload).


##### `PluginsManager::cache_loaded_plugins_if_current`  (lines 614–627)

```
fn cache_loaded_plugins_if_current(
        &self,
        generation: u64,
        key: PluginLoadCacheKey,
        plugins: Vec<LoadedPlugin>,
    )
```

**Purpose**: Stores a freshly loaded plugin vector in the cache only if the cache generation has not changed. This prevents stale loads from overwriting newer invalidations.

**Data flow**: Acquires the `loaded_plugins_cache` write lock, compares `cache.generation` with the supplied `generation`, and if equal writes `Some(LoadedPluginsCacheEntry { key, plugins })` into `entry`.

**Call relations**: Called after fresh plugin loads in `plugins_for_config_with_force_reload`.

*Call graph*: called by 1 (plugins_for_config_with_force_reload).


##### `PluginsManager::remote_installed_plugin_configs`  (lines 629–639)

```
fn remote_installed_plugin_configs(&self) -> HashMap<String, PluginConfig>
```

**Purpose**: Converts the cached remote installed plugin list into synthetic plugin configs for effective loading. If no remote-installed cache exists, it returns an empty map.

**Data flow**: Reads `remote_installed_plugins_cache`, returns empty `HashMap` if `None`, otherwise delegates to `remote_installed_plugins_to_config(plugins, &self.store)` and returns that map.

**Call relations**: Used by all plugin-loading entry points so remote installed state participates in effective plugin resolution.

*Call graph*: calls 1 internal fn (remote_installed_plugins_to_config); called by 3 (plugin_hooks_for_layer_stack, plugins_for_config_with_force_reload, plugins_for_layer_stack); 1 external calls (new).


##### `PluginsManager::build_remote_installed_plugin_marketplaces_from_cache`  (lines 641–656)

```
fn build_remote_installed_plugin_marketplaces_from_cache(
        &self,
        visible_marketplaces: &[&str],
    ) -> Option<Vec<crate::remote::RemoteMarketplace>>
```

**Purpose**: Groups the cached remote installed plugins into marketplace-shaped structures for callers that need marketplace views. It is a pure cache projection.

**Data flow**: Reads `remote_installed_plugins_cache`, returns `None` if absent, otherwise calls `crate::remote::group_remote_installed_plugins_by_marketplaces(plugins, visible_marketplaces)` and wraps the result in `Some`.

**Call relations**: Used by discoverable-plugin logic and other callers that need a marketplace grouping without refetching remote state.

*Call graph*: calls 1 internal fn (group_remote_installed_plugins_by_marketplaces).


##### `PluginsManager::cached_global_remote_discoverable_plugins_for_config`  (lines 658–681)

```
fn cached_global_remote_discoverable_plugins_for_config(
        &self,
        config: &PluginsConfigInput,
        auth: Option<&CodexAuth>,
    ) -> Vec<crate::remote::RemoteDiscoverablePlugin>
```

**Purpose**: Returns cached global remote discoverable plugins when remote discovery is applicable for the current config and auth. It enforces feature flags and backend-auth requirements before reading the cache.

**Data flow**: Reads `config` and optional `auth` → returns empty vector if plugins or remote plugins are disabled, if auth is absent or not backend-based, or if account id is missing/empty; otherwise calls `crate::remote::cached_global_remote_discoverable_plugins(self.codex_home.as_path(), &remote_plugin_service_config(config), auth)` and returns the cached vector.

**Call relations**: Used by discoverable-plugin listing to merge cached remote suggestions into local discoverable results.

*Call graph*: calls 2 internal fn (remote_plugin_service_config, cached_global_remote_discoverable_plugins); 2 external calls (as_path, new).


##### `PluginsManager::build_and_cache_remote_installed_plugin_marketplaces`  (lines 683–704)

```
async fn build_and_cache_remote_installed_plugin_marketplaces(
        &self,
        config: &PluginsConfigInput,
        auth: Option<&CodexAuth>,
        visible_marketplaces: &[&str],
        on_e
```

**Purpose**: Fetches remote installed plugins from the backend, groups them by marketplace, writes them into the manager cache, and optionally notifies callers when effective plugin state changed. It is the synchronous fetch-and-cache API.

**Data flow**: Reads `config`, optional `auth`, visible marketplace names, and optional callback → awaits `crate::remote::fetch_remote_installed_plugins`, groups the result with `group_remote_installed_plugins_by_marketplaces`, writes the raw plugin list into cache via `write_remote_installed_plugins_cache`, invokes `on_effective_plugins_changed` if the cache changed, and returns the grouped marketplaces or a `RemotePluginCatalogError`.

**Call relations**: Used by tests and higher-level flows that need an immediate remote-installed refresh rather than background scheduling.

*Call graph*: calls 4 internal fn (write_remote_installed_plugins_cache, remote_plugin_service_config, fetch_remote_installed_plugins, group_remote_installed_plugins_by_marketplaces).


##### `PluginsManager::write_remote_installed_plugins_cache`  (lines 706–718)

```
fn write_remote_installed_plugins_cache(&self, plugins: Vec<RemoteInstalledPlugin>) -> bool
```

**Purpose**: Stores a new remote installed plugin list and invalidates loaded plugins if it changed. It returns whether the cache contents were actually different.

**Data flow**: Acquires the `remote_installed_plugins_cache` write lock, compares the existing cached vector with `plugins`, returns `false` if equal, otherwise writes `Some(plugins)`, drops the lock, calls `clear_loaded_plugins_cache`, and returns `true`.

**Call relations**: Called by explicit remote-installed fetches and by the background refresh loop.

*Call graph*: calls 1 internal fn (clear_loaded_plugins_cache); called by 2 (build_and_cache_remote_installed_plugin_marketplaces, run_remote_installed_plugins_cache_refresh_loop).


##### `PluginsManager::clear_remote_installed_plugins_cache`  (lines 720–732)

```
fn clear_remote_installed_plugins_cache(&self) -> bool
```

**Purpose**: Removes the cached remote installed plugin list and invalidates loaded plugins if anything was cached. It reports whether a change occurred.

**Data flow**: Acquires the `remote_installed_plugins_cache` write lock, returns `false` if already `None`, otherwise sets it to `None`, drops the lock, calls `clear_loaded_plugins_cache`, and returns `true`.

**Call relations**: Used when remote installed plugin refresh determines auth is unavailable or unsupported.

*Call graph*: calls 1 internal fn (clear_loaded_plugins_cache); called by 1 (run_remote_installed_plugins_cache_refresh_loop).


##### `PluginsManager::maybe_start_remote_plugin_caches_refresh`  (lines 734–754)

```
fn maybe_start_remote_plugin_caches_refresh(
        self: &Arc<Self>,
        config: &PluginsConfigInput,
        auth: Option<CodexAuth>,
        on_effective_plugins_changed: Option<Arc<dyn Fn() +
```

**Purpose**: Schedules background refresh of remote installed plugin caches and asynchronously warms recommended-plugin mode. It is the normal remote-cache kickoff path.

**Data flow**: Reads `config`, optional owned `auth`, and optional callback → calls `maybe_start_remote_installed_plugins_cache_refresh_with_notify` with `IfCacheChanged`, clones manager/config/auth into a spawned task, and in that task awaits `recommended_plugins_mode_for_config(&config, auth.as_ref())` to warm the recommendation-mode cache.

**Call relations**: Called by plugin-list background task orchestration and startup flows.

*Call graph*: calls 1 internal fn (maybe_start_remote_installed_plugins_cache_refresh_with_notify); called by 1 (maybe_start_plugin_list_background_tasks_for_config); 3 external calls (clone, clone, spawn).


##### `PluginsManager::maybe_start_remote_installed_plugins_cache_refresh_after_mutation`  (lines 756–768)

```
fn maybe_start_remote_installed_plugins_cache_refresh_after_mutation(
        self: &Arc<Self>,
        config: &PluginsConfigInput,
        auth: Option<CodexAuth>,
        on_effective_plugins_chang
```

**Purpose**: Schedules a remote installed plugin cache refresh that should notify after any successful refresh, even if the installed set is unchanged. This is used after remote mutations that may affect local bundles or MCP state.

**Data flow**: Delegates to `maybe_start_remote_installed_plugins_cache_refresh_with_notify` with `RemoteInstalledPluginsCacheRefreshNotify::AfterSuccessfulRefresh`.

**Call relations**: Used by remote bundle-sync callbacks and other mutation-triggered refresh paths.

*Call graph*: calls 1 internal fn (maybe_start_remote_installed_plugins_cache_refresh_with_notify).


##### `PluginsManager::maybe_start_remote_installed_plugins_cache_refresh_with_notify`  (lines 770–789)

```
fn maybe_start_remote_installed_plugins_cache_refresh_with_notify(
        self: &Arc<Self>,
        config: &PluginsConfigInput,
        auth: Option<CodexAuth>,
        notify: RemoteInstalledPlugin
```

**Purpose**: Common gate for scheduling remote installed plugin cache refreshes. It enforces the global plugins-enabled flag and packages the refresh request.

**Data flow**: Reads `config`, optional auth, notify mode, and optional callback → returns immediately if plugins are disabled; otherwise builds `RemoteInstalledPluginsCacheRefreshRequest { service_config: remote_plugin_service_config(config), auth, notify, on_effective_plugins_changed }` and passes it to `schedule_remote_installed_plugins_cache_refresh`.

**Call relations**: Shared by the normal and post-mutation remote-installed refresh entry points.

*Call graph*: calls 2 internal fn (schedule_remote_installed_plugins_cache_refresh, remote_plugin_service_config); called by 2 (maybe_start_remote_installed_plugins_cache_refresh_after_mutation, maybe_start_remote_plugin_caches_refresh).


##### `PluginsManager::maybe_start_remote_installed_plugin_bundle_sync`  (lines 791–818)

```
fn maybe_start_remote_installed_plugin_bundle_sync(
        self: &Arc<Self>,
        config: &PluginsConfigInput,
        auth: Option<CodexAuth>,
        on_effective_plugins_changed: Option<Arc<dyn
```

**Purpose**: Starts background synchronization of remote installed plugin bundles into local storage. It wires bundle-sync completion back into remote installed cache refresh scheduling.

**Data flow**: Reads `config`, optional auth, and optional callback → returns if plugins are disabled; otherwise clones manager/config/auth, builds an `on_local_cache_changed` closure that schedules `maybe_start_remote_installed_plugins_cache_refresh_after_mutation`, and calls `crate::remote::maybe_start_remote_installed_plugin_bundle_sync(self.codex_home.clone(), remote_plugin_service_config(config), auth, Some(on_local_cache_changed))`.

**Call relations**: Triggered by plugin-list background tasks and startup tasks so remote bundle downloads and installed-state refresh stay ordered.

*Call graph*: calls 1 internal fn (remote_plugin_service_config); called by 1 (maybe_start_plugin_list_background_tasks_for_config); 5 external calls (clone, new, clone, clone, maybe_start_remote_installed_plugin_bundle_sync).


##### `PluginsManager::maybe_start_global_remote_catalog_cache_refresh`  (lines 820–833)

```
fn maybe_start_global_remote_catalog_cache_refresh(
        self: &Arc<Self>,
        config: &PluginsConfigInput,
        auth: Option<CodexAuth>,
    )
```

**Purpose**: Schedules a background refresh of the cached global remote plugin catalog when both plugins and remote plugins are enabled.

**Data flow**: Reads `config` and optional auth → returns immediately unless both feature flags are true; otherwise builds `GlobalRemoteCatalogCacheRefreshRequest` from `remote_plugin_service_config(config)` and auth, and passes it to `schedule_global_remote_catalog_cache_refresh`.

**Call relations**: Called by plugin-list background task orchestration when callers request remote catalog warming.

*Call graph*: calls 2 internal fn (schedule_global_remote_catalog_cache_refresh, remote_plugin_service_config); called by 1 (maybe_start_plugin_list_background_tasks_for_config).


##### `PluginsManager::maybe_start_plugin_list_background_tasks_for_config`  (lines 835–857)

```
fn maybe_start_plugin_list_background_tasks_for_config(
        self: &Arc<Self>,
        config: &PluginsConfigInput,
        auth: Option<CodexAuth>,
        roots: &[AbsolutePathBuf],
        optio
```

**Purpose**: Starts the suite of background tasks relevant to plugin listing: non-curated cache refresh, optional remote catalog refresh, remote installed cache refresh, and remote bundle sync. It is the manager’s plugin-list orchestration entry point.

**Data flow**: Reads config, optional auth, marketplace roots, task options, and optional callback → calls `maybe_start_non_curated_plugin_cache_refresh(roots)`, conditionally `maybe_start_global_remote_catalog_cache_refresh`, then `maybe_start_remote_plugin_caches_refresh` and `maybe_start_remote_installed_plugin_bundle_sync` with cloned auth/callback as needed.

**Call relations**: Invoked by higher-level listing flows to opportunistically refresh caches in the background while serving current data.

*Call graph*: calls 4 internal fn (maybe_start_global_remote_catalog_cache_refresh, maybe_start_non_curated_plugin_cache_refresh, maybe_start_remote_installed_plugin_bundle_sync, maybe_start_remote_plugin_caches_refresh).


##### `PluginsManager::cached_featured_plugin_ids`  (lines 859–889)

```
fn cached_featured_plugin_ids(
        &self,
        cache_key: &FeaturedPluginIdsCacheKey,
    ) -> Option<Vec<String>>
```

**Purpose**: Returns cached featured plugin ids when the cache key matches and the TTL has not expired. It also clears stale or mismatched cache entries on miss.

**Data flow**: Reads the featured-plugin-id cache under a read lock, compares `Instant::now()` and the supplied key against the cached entry, returns a cloned id vector on valid hit; on miss, acquires a write lock, drops the cache entry if expired or keyed differently, and returns `None`.

**Call relations**: Used by `featured_plugin_ids_for_config` before making a remote request.

*Call graph*: called by 1 (featured_plugin_ids_for_config); 1 external calls (now).


##### `PluginsManager::write_featured_plugin_ids_cache`  (lines 891–905)

```
fn write_featured_plugin_ids_cache(
        &self,
        cache_key: FeaturedPluginIdsCacheKey,
        featured_plugin_ids: &[String],
    )
```

**Purpose**: Stores featured plugin ids in the TTL cache for a specific auth/config key. It sets the expiration relative to the current time.

**Data flow**: Acquires the featured-plugin-id cache write lock and writes `Some(CachedFeaturedPluginIds { key: cache_key, expires_at: Instant::now() + FEATURED_PLUGIN_IDS_CACHE_TTL, featured_plugin_ids: featured_plugin_ids.to_vec() })`.

**Call relations**: Called by `featured_plugin_ids_for_config` after a successful remote fetch.

*Call graph*: called by 1 (featured_plugin_ids_for_config); 1 external calls (now).


##### `PluginsManager::featured_plugin_ids_for_config`  (lines 907–928)

```
async fn featured_plugin_ids_for_config(
        &self,
        config: &PluginsConfigInput,
        auth: Option<&CodexAuth>,
    ) -> Result<Vec<String>, RemotePluginFetchError>
```

**Purpose**: Returns featured plugin ids for the current config and auth, using a TTL cache to avoid repeated remote fetches. Plugins-disabled mode yields an empty list.

**Data flow**: Reads `config` and optional auth → returns `Ok(Vec::new())` if plugins are disabled; otherwise builds a cache key with `featured_plugin_ids_cache_key`, returns cached ids if available, awaits `crate::remote_legacy::fetch_remote_featured_plugin_ids(&remote_plugin_service_config(config), auth, self.restriction_product)`, writes the cache on success, and returns the fetched ids or a `RemotePluginFetchError`.

**Call relations**: Used directly by callers and also warmed in startup tasks.

*Call graph*: calls 5 internal fn (cached_featured_plugin_ids, write_featured_plugin_ids_cache, featured_plugin_ids_cache_key, remote_plugin_service_config, fetch_remote_featured_plugin_ids); 1 external calls (new).


##### `PluginsManager::recommended_plugins_mode_for_config`  (lines 930–998)

```
async fn recommended_plugins_mode_for_config(
        &self,
        config: &PluginsConfigInput,
        auth: Option<&CodexAuth>,
    ) -> RecommendedPluginsMode
```

**Purpose**: Determines whether recommended plugins should use the legacy or remote-backed mode, with deduplicated async refresh and caching. It falls back to `Legacy` on disabled features, unsupported auth, or fetch failure.

**Data flow**: Reads `config` and optional auth → returns `RecommendedPluginsMode::Legacy` unless plugins and remote plugins are enabled and auth uses the backend; otherwise builds a cache key, returns a cached mode if present, or obtains/creates an `Arc<OnceCell<RecommendedPluginsMode>>` in `recommended_plugins_refreshes`, awaits `get_or_init` to fetch mode from `crate::remote::fetch_recommended_plugins`, writes successful results into `recommended_plugins_cache`, logs and falls back to `Legacy` on error, then removes the refresh cell if it is still the current one and returns the resolved mode.

**Call relations**: Called directly by callers and opportunistically warmed by `maybe_start_remote_plugin_caches_refresh`.

*Call graph*: calls 2 internal fn (cached_recommended_plugins_mode, recommended_plugins_cache_key).


##### `PluginsManager::cached_recommended_plugins_mode`  (lines 1000–1009)

```
fn cached_recommended_plugins_mode(
        &self,
        cache_key: &RecommendedPluginsCacheKey,
    ) -> Option<RecommendedPluginsMode>
```

**Purpose**: Looks up the cached recommended-plugin mode for a given backend URL key. It is a simple read-only cache accessor.

**Data flow**: Reads `recommended_plugins_cache` and returns a cloned `RecommendedPluginsMode` if the key is present.

**Call relations**: Used by `recommended_plugins_mode_for_config` before and during refresh-cell setup.

*Call graph*: called by 1 (recommended_plugins_mode_for_config).


##### `PluginsManager::install_plugin`  (lines 1011–1021)

```
async fn install_plugin(
        &self,
        request: PluginInstallRequest,
    ) -> Result<PluginInstallOutcome, PluginInstallError>
```

**Purpose**: Installs a plugin from a marketplace manifest into the local plugin store. It first resolves the marketplace entry and product restrictions, then performs the install.

**Data flow**: Takes `PluginInstallRequest` → resolves it with `find_installable_marketplace_plugin(&request.marketplace_path, &request.plugin_name, self.restriction_product)`, awaits `install_resolved_plugin(resolved)`, and returns `PluginInstallOutcome` or `PluginInstallError`.

**Call relations**: Public install API for local-only installs; delegates actual installation work to `install_resolved_plugin`.

*Call graph*: calls 2 internal fn (install_resolved_plugin, find_installable_marketplace_plugin).


##### `PluginsManager::install_plugin_with_remote_sync`  (lines 1023–1044)

```
async fn install_plugin_with_remote_sync(
        &self,
        config: &PluginsConfigInput,
        auth: Option<&CodexAuth>,
        request: PluginInstallRequest,
    ) -> Result<PluginInstallOutc
```

**Purpose**: Performs a legacy remote enable mutation before installing the plugin locally. It keeps backend installed state and local cache in sync for legacy remote plugins.

**Data flow**: Resolves the installable marketplace plugin, derives its plugin id key, awaits `crate::remote_legacy::enable_remote_plugin(&remote_plugin_service_config(config), auth, &plugin_id)`, maps remote errors into `PluginInstallError`, then awaits `install_resolved_plugin(resolved)` and returns the outcome.

**Call relations**: Alternative install path used when backend mutation must precede local installation.

*Call graph*: calls 4 internal fn (install_resolved_plugin, remote_plugin_service_config, find_installable_marketplace_plugin, enable_remote_plugin).


##### `PluginsManager::install_resolved_plugin`  (lines 1046–1104)

```
async fn install_resolved_plugin(
        &self,
        resolved: ResolvedMarketplacePlugin,
    ) -> Result<PluginInstallOutcome, PluginInstallError>
```

**Purpose**: Installs a previously resolved marketplace plugin source into the local store, updates user config, and emits analytics telemetry. It handles curated and non-curated versioning differently.

**Data flow**: Consumes `ResolvedMarketplacePlugin` → captures auth policy, computes an optional curated cache version by reading the curated repo SHA and passing it through `curated_plugin_cache_version` when the marketplace is curated, clones store and CODEX_HOME into a blocking task that materializes the source with `materialize_marketplace_plugin_source` and installs it with either `store.install_with_version` or `store.install`, awaits the task result, enables the plugin in user config via `set_user_plugin_enabled`, reads the optional analytics client and, if present, awaits `plugin_telemetry_metadata_from_root` for the installed path and emits `track_plugin_installed`, then returns `PluginInstallOutcome { plugin_id, plugin_version, installed_path, auth_policy }`.

**Call relations**: Shared implementation behind both install entry points.

*Call graph*: calls 3 internal fn (curated_plugin_cache_version, plugin_telemetry_metadata_from_root, read_curated_plugins_sha); called by 2 (install_plugin, install_plugin_with_remote_sync); 6 external calls (as_path, clone, set_user_plugin_enabled, clone, is_openai_curated_marketplace_name, spawn_blocking).


##### `PluginsManager::uninstall_plugin`  (lines 1106–1109)

```
async fn uninstall_plugin(&self, plugin_id: String) -> Result<(), PluginUninstallError>
```

**Purpose**: Uninstalls a plugin by string id from the local store and user config. It parses the id and delegates to the typed uninstall path.

**Data flow**: Parses `plugin_id: String` with `PluginId::parse`, then awaits `uninstall_plugin_id(plugin_id)` and returns `Result<(), PluginUninstallError>`.

**Call relations**: Public uninstall API for local-only uninstalls.

*Call graph*: calls 2 internal fn (uninstall_plugin_id, parse).


##### `PluginsManager::uninstall_plugin_with_remote_sync`  (lines 1111–1130)

```
async fn uninstall_plugin_with_remote_sync(
        &self,
        config: &PluginsConfigInput,
        auth: Option<&CodexAuth>,
        plugin_id: String,
    ) -> Result<(), PluginUninstallError>
```

**Purpose**: Performs a legacy remote uninstall mutation before removing the plugin locally. It keeps backend installed state aligned with local uninstall behavior.

**Data flow**: Parses the plugin id string, derives its key, awaits `crate::remote_legacy::uninstall_remote_plugin(&remote_plugin_service_config(config), auth, &plugin_key)`, maps remote errors into `PluginUninstallError`, then awaits `uninstall_plugin_id(plugin_id)`.

**Call relations**: Alternative uninstall path used when backend mutation must precede local removal.

*Call graph*: calls 4 internal fn (uninstall_plugin_id, remote_plugin_service_config, uninstall_remote_plugin, parse).


##### `PluginsManager::uninstall_plugin_id`  (lines 1132–1159)

```
async fn uninstall_plugin_id(&self, plugin_id: PluginId) -> Result<(), PluginUninstallError>
```

**Purpose**: Removes an installed plugin from the store, clears its user config entry, and emits uninstall telemetry if possible. It preserves telemetry metadata before deleting the bundle.

**Data flow**: Reads `plugin_id` → if `self.store.active_plugin_root(&plugin_id)` exists, awaits `installed_plugin_telemetry_metadata` and stores it; clones store and plugin id into a blocking task that calls `store.uninstall`, awaits completion, clears the user plugin config via `clear_user_plugin`, reads the optional analytics client, and if both telemetry and client are present emits `track_plugin_uninstalled`. Returns `Ok(())` or `PluginUninstallError`.

**Call relations**: Shared implementation behind both uninstall entry points.

*Call graph*: calls 3 internal fn (installed_plugin_telemetry_metadata, active_plugin_root, as_key); called by 2 (uninstall_plugin, uninstall_plugin_with_remote_sync); 5 external calls (as_path, clear_user_plugin, clone, clone, spawn_blocking).


##### `PluginsManager::list_marketplaces_for_config`  (lines 1161–1250)

```
fn list_marketplaces_for_config(
        &self,
        config: &PluginsConfigInput,
        additional_roots: &[AbsolutePathBuf],
        include_openai_curated: bool,
    ) -> Result<ConfiguredMarke
```

**Purpose**: Lists configured marketplaces and their plugins with installed/enabled state, product filtering, duplicate suppression, and installed-manifest overrides for git sources. It is the main marketplace listing API.

**Data flow**: Reads `config`, additional roots, and `include_openai_curated` → returns default outcome if plugins are disabled; otherwise computes `(installed_plugins, enabled_plugins)` via `configured_plugin_states`, builds marketplace roots with `marketplace_roots`, lists marketplaces with `list_marketplaces`, tracks `seen_plugin_keys` to suppress duplicates across marketplace files, filters plugins by product restriction, computes installed and enabled flags, resolves installed version from the store when installed, and for installed git-source plugins loads the installed manifest to override `local_version` and merge interface category via `plugin_interface_with_marketplace_category`. It collects non-empty `ConfiguredMarketplace` values and returns them with any marketplace-list errors.

**Call relations**: Used by callers that need marketplace summaries and by discoverable-plugin logic as the source of local marketplace candidates.

*Call graph*: calls 3 internal fn (configured_plugin_states, marketplace_roots, list_marketplaces); called by 3 (configured_marketplace_plugins, find_marketplace_for_plugin, verified_plugin_install_completed); 2 external calls (new, default).


##### `PluginsManager::discover_marketplaces_for_config`  (lines 1252–1266)

```
fn discover_marketplaces_for_config(
        &self,
        config: &PluginsConfigInput,
        additional_roots: &[AbsolutePathBuf],
    ) -> Result<MarketplaceListOutcome, MarketplaceError>
```

**Purpose**: Returns raw discovered marketplaces for the current config without projecting installed/enabled state into `ConfiguredMarketplace` structures. It is a thinner listing API.

**Data flow**: Returns default `MarketplaceListOutcome` if plugins are disabled; otherwise computes roots with `marketplace_roots(..., include_openai_curated = true)`, calls `list_marketplaces`, and returns the result.

**Call relations**: Used by callers that need lower-level marketplace discovery rather than configured-state projection.

*Call graph*: calls 2 internal fn (marketplace_roots, list_marketplaces); 1 external calls (default).


##### `PluginsManager::read_plugin_for_config`  (lines 1268–1325)

```
async fn read_plugin_for_config(
        &self,
        config: &PluginsConfigInput,
        request: &PluginReadRequest,
    ) -> Result<PluginReadOutcome, MarketplaceError>
```

**Purpose**: Reads detailed information for one plugin identified by marketplace path and plugin name. It resolves installed/enabled state and then delegates to the richer detail reader.

**Data flow**: Reads `config` and `PluginReadRequest` → errors with `MarketplaceError::PluginsDisabled` if plugins are disabled, resolves the marketplace plugin with `find_marketplace_plugin`, rejects it if product restriction does not match, computes marketplace name and plugin key, derives installed/enabled state from `configured_plugin_states`, resolves installed version from the store when installed, constructs a `ConfiguredMarketplacePlugin`, awaits `read_plugin_detail_for_marketplace_plugin`, and wraps the result in `PluginReadOutcome { marketplace_name, marketplace_path: Some(request.marketplace_path.clone()), plugin }`.

**Call relations**: Public plugin-detail API for callers starting from a marketplace manifest path.

*Call graph*: calls 5 internal fn (configured_plugin_states, read_plugin_detail_for_marketplace_plugin, restriction_product_matches, find_marketplace_plugin, active_plugin_version).


##### `PluginsManager::read_plugin_detail_for_marketplace_plugin`  (lines 1328–1476)

```
async fn read_plugin_detail_for_marketplace_plugin(
        &self,
        config: &PluginsConfigInput,
        marketplace_name: &str,
        plugin: ConfiguredMarketplacePlugin,
    ) -> Result<Plu
```

**Purpose**: Builds a full `PluginDetail` for a marketplace plugin, including manifest/interface metadata, skills, hooks, apps, app categories, and MCP server names. It also handles the special case where uninstalled git-source plugins cannot expose full details until installed.

**Data flow**: Reads `config`, `marketplace_name`, and a `ConfiguredMarketplacePlugin` → rejects product-mismatched plugins, constructs `PluginId`, and if the source is `Git` and not installed returns a placeholder `PluginDetail` with `details_unavailable_reason = InstallRequiredForRemoteSource` and a description from `remote_plugin_install_required_description`; otherwise resolves `source_path` either from the installed store root (for installed git plugins) or by materializing the source in a blocking task, validates the directory and manifest, merges manifest interface with marketplace category, awaits `load_plugin_skills`, loads hooks via `load_plugin_hooks` and summarizes them with `plugin_hook_declarations`, reads current auth mode, awaits `load_plugin_apps` and `load_plugin_mcp_servers`, reapplies `apply_app_mcp_routing_policy` when auth is present, derives app connector ids and first-category-per-connector map, sorts and deduplicates MCP server names, and returns a populated `PluginDetail`.

**Call relations**: Called by `read_plugin_for_config` and indirectly by discoverable-plugin listing when local plugin details are needed.

*Call graph*: calls 14 internal fn (apply_app_mcp_routing_policy, load_plugin_apps, load_plugin_hooks, load_plugin_mcp_servers, load_plugin_skills, auth_mode, restriction_product_matches, remote_plugin_install_required_description, load_plugin_manifest, plugin_interface_with_marketplace_category (+4 more)); called by 1 (read_plugin_for_config); 9 external calls (new, new, clone, new, plugin_hook_declarations, app_connector_ids_from_declarations, InvalidPlugin, matches!, spawn_blocking).


##### `PluginsManager::maybe_start_plugin_startup_tasks_for_config`  (lines 1478–1591)

```
fn maybe_start_plugin_startup_tasks_for_config(
        self: &Arc<Self>,
        config: &PluginsConfigInput,
        auth_manager: Arc<AuthManager>,
        on_effective_plugins_changed: Option<Arc<
```

**Purpose**: Starts the manager’s startup-time background work: curated repo sync, configured marketplace auto-upgrade, remote cache warming, remote bundle sync, remote catalog warming, and featured-plugin-id warming. It is the top-level startup orchestrator for plugin maintenance.

**Data flow**: Reads `config`, `auth_manager`, and optional callback → if plugins are enabled, calls `start_curated_repo_sync`, conditionally spawns a named thread for `upgrade_configured_marketplaces_for_config` guarded by `configured_marketplace_upgrade_state`, spawns an async task that fetches auth and then starts remote installed cache refresh, remote bundle sync, and optional global remote catalog warming with warning suppression for auth-required/unsupported cases, and spawns another async task that fetches auth and warms `featured_plugin_ids_for_config`, logging failures.

**Call relations**: Called during application startup to kick off all plugin-related maintenance tasks in the background.

*Call graph*: calls 3 internal fn (start_curated_repo_sync, remote_plugin_service_config, fetch_and_cache_global_remote_plugin_catalog); 5 external calls (clone, clone, new, spawn, warn!).


##### `PluginsManager::upgrade_configured_marketplaces_for_config`  (lines 1593–1637)

```
fn upgrade_configured_marketplaces_for_config(
        &self,
        config: &PluginsConfigInput,
        marketplace_name: Option<&str>,
    ) -> Result<ConfiguredMarketplaceUpgradeOutcome, String>
```

**Purpose**: Upgrades configured git marketplaces and then force-refreshes cached non-curated plugins from any upgraded roots. It returns upgrade results plus any refresh-related errors.

**Data flow**: Reads `config` and optional `marketplace_name` → if a specific marketplace name is supplied, verifies it is configured as a git marketplace via `configured_git_marketplace_names` and errors otherwise; calls `upgrade_configured_git_marketplaces`, and if any roots were upgraded, calls `refresh_non_curated_plugin_cache_force_reinstall(self.codex_home.as_path(), &outcome.upgraded_roots)`, clearing caches on success when refreshed or on failure while appending a `ConfiguredMarketplaceUpgradeError` to the outcome. Returns `Result<ConfiguredMarketplaceUpgradeOutcome, String>`.

**Call relations**: Used by startup auto-upgrade and explicit marketplace-upgrade flows.

*Call graph*: calls 4 internal fn (refresh_non_curated_plugin_cache_force_reinstall, clear_cache, configured_git_marketplace_names, upgrade_configured_git_marketplaces); 2 external calls (as_path, format!).


##### `PluginsManager::maybe_start_non_curated_plugin_cache_refresh`  (lines 1639–1647)

```
fn maybe_start_non_curated_plugin_cache_refresh(
        self: &Arc<Self>,
        roots: &[AbsolutePathBuf],
    )
```

**Purpose**: Schedules a background non-curated plugin cache refresh in version-sensitive mode. It is the public entry point for opportunistic refresh after marketplace discovery.

**Data flow**: Delegates to `schedule_non_curated_plugin_cache_refresh(roots, NonCuratedCacheRefreshMode::IfVersionChanged)`.

**Call relations**: Called by plugin-list background task orchestration.

*Call graph*: calls 1 internal fn (schedule_non_curated_plugin_cache_refresh); called by 1 (maybe_start_plugin_list_background_tasks_for_config).


##### `PluginsManager::schedule_remote_installed_plugins_cache_refresh`  (lines 1649–1689)

```
fn schedule_remote_installed_plugins_cache_refresh(
        self: &Arc<Self>,
        mut request: RemoteInstalledPluginsCacheRefreshRequest,
    )
```

**Purpose**: Queues a remote installed plugin cache refresh request and ensures at most one worker loop is running. It merges stronger notification semantics and callback presence across queued requests.

**Data flow**: Acquires `remote_installed_plugins_cache_refresh_state`, merges the new request with any existing queued request so `AfterSuccessfulRefresh` wins and a missing callback inherits the existing callback, stores the request in `state.requested`, sets `state.in_flight` if no worker is running, and if a worker should start spawns `run_remote_installed_plugins_cache_refresh_loop` on Tokio.

**Call relations**: Called by `maybe_start_remote_installed_plugins_cache_refresh_with_notify`; it is the queueing layer for remote-installed refresh work.

*Call graph*: called by 1 (maybe_start_remote_installed_plugins_cache_refresh_with_notify); 3 external calls (clone, matches!, spawn).


##### `PluginsManager::schedule_global_remote_catalog_cache_refresh`  (lines 1691–1716)

```
fn schedule_global_remote_catalog_cache_refresh(
        self: &Arc<Self>,
        request: GlobalRemoteCatalogCacheRefreshRequest,
    )
```

**Purpose**: Queues a global remote catalog cache refresh request and ensures only one worker loop runs at a time. Later requests replace earlier queued ones.

**Data flow**: Acquires `global_remote_catalog_cache_refresh_state`, stores the request in `requested`, marks `in_flight` if needed, and if no worker is running spawns `run_global_remote_catalog_cache_refresh_loop` on Tokio.

**Call relations**: Called by `maybe_start_global_remote_catalog_cache_refresh`.

*Call graph*: called by 1 (maybe_start_global_remote_catalog_cache_refresh); 2 external calls (clone, spawn).


##### `PluginsManager::schedule_non_curated_plugin_cache_refresh`  (lines 1718–1780)

```
fn schedule_non_curated_plugin_cache_refresh(
        self: &Arc<Self>,
        roots: &[AbsolutePathBuf],
        mode: NonCuratedCacheRefreshMode,
    )
```

**Purpose**: Queues a non-curated plugin cache refresh request, deduplicating repeated root sets and preserving stronger force-reinstall requests. It ensures only one background thread performs refresh work at a time.

**Data flow**: Clones, sorts, and deduplicates `roots`, returns if empty, builds `NonCuratedCacheRefreshRequest { roots, mode }`, acquires `non_curated_cache_refresh_state`, suppresses scheduling when the same request is already queued or was just completed in `IfVersionChanged` mode, suppresses weaker `IfVersionChanged` requests when an equivalent `ForceReinstall` is already queued, otherwise stores the request and marks `in_flight` if needed, then spawns a named thread running `run_non_curated_plugin_cache_refresh_loop`; on thread-spawn failure it resets state and logs a warning.

**Call relations**: Called by `maybe_start_non_curated_plugin_cache_refresh`; it is the queueing and deduplication layer for non-curated refresh work.

*Call graph*: called by 1 (maybe_start_non_curated_plugin_cache_refresh); 7 external calls (clone, new, dedup, is_empty, sort_unstable, to_vec, warn!).


##### `PluginsManager::start_curated_repo_sync`  (lines 1782–1822)

```
fn start_curated_repo_sync(self: &Arc<Self>)
```

**Purpose**: Starts the one-at-a-time background sync of the curated plugins repository and subsequent curated cache refresh. It uses a global atomic flag to prevent duplicate sync threads.

**Data flow**: Checks and sets `CURATED_REPO_SYNC_STARTED`; if already true returns immediately. Otherwise clones manager and CODEX_HOME and spawns a named thread that runs `sync_openai_plugins_repo`, then on success reads configured curated plugin ids from disk and calls `refresh_curated_plugin_cache`, clearing caches when refreshed and resetting the atomic plus warning on failure; on sync failure or thread-spawn failure it resets the atomic and logs warnings.

**Call relations**: Called from startup task orchestration; it owns the curated-repo sync lifecycle.

*Call graph*: called by 1 (maybe_start_plugin_startup_tasks_for_config); 4 external calls (clone, clone, new, warn!).


##### `PluginsManager::run_remote_installed_plugins_cache_refresh_loop`  (lines 1824–1882)

```
async fn run_remote_installed_plugins_cache_refresh_loop(self: Arc<Self>)
```

**Purpose**: Processes queued remote installed plugin cache refresh requests until the queue is empty. It updates caches, clears them on auth-related failures, and invokes callbacks when effective plugin state may have changed.

**Data flow**: Loops by taking `state.requested` from `remote_installed_plugins_cache_refresh_state`; if none, marks `in_flight = false` and returns. For each request it awaits `crate::remote::fetch_remote_installed_plugins`, on success writes the cache via `write_remote_installed_plugins_cache` and invokes the callback if the cache changed or notify mode is `AfterSuccessfulRefresh`; on `AuthRequired` or `UnsupportedAuthMode`, clears the remote-installed cache and invokes the callback if that changed effective state; on other errors logs a warning and continues to the next queued request.

**Call relations**: Spawned by `schedule_remote_installed_plugins_cache_refresh` as the worker loop for remote-installed refreshes.

*Call graph*: calls 3 internal fn (clear_remote_installed_plugins_cache, write_remote_installed_plugins_cache, fetch_remote_installed_plugins); 2 external calls (matches!, warn!).


##### `PluginsManager::run_global_remote_catalog_cache_refresh_loop`  (lines 1884–1920)

```
async fn run_global_remote_catalog_cache_refresh_loop(self: Arc<Self>)
```

**Purpose**: Processes queued global remote catalog refresh requests until none remain. It warms the on-disk remote catalog cache and suppresses auth-related errors.

**Data flow**: Loops by taking `state.requested` from `global_remote_catalog_cache_refresh_state`; if none, marks `in_flight = false` and returns. For each request it awaits `crate::remote::fetch_and_cache_global_remote_plugin_catalog(self.codex_home.as_path(), &request.service_config, request.auth.as_ref())`, ignores `AuthRequired` and `UnsupportedAuthMode`, and logs warnings for other errors.

**Call relations**: Spawned by `schedule_global_remote_catalog_cache_refresh`.

*Call graph*: calls 1 internal fn (fetch_and_cache_global_remote_plugin_catalog); 2 external calls (as_path, warn!).


##### `PluginsManager::run_non_curated_plugin_cache_refresh_loop`  (lines 1922–1979)

```
fn run_non_curated_plugin_cache_refresh_loop(self: Arc<Self>)
```

**Purpose**: Processes queued non-curated plugin cache refresh requests until the queue is empty or replaced. It clears caches on successful refreshes and on failures.

**Data flow**: Loops by reading the current queued request from `non_curated_cache_refresh_state`; if none, marks `in_flight = false` and returns. For each request it calls either `refresh_non_curated_plugin_cache` or `refresh_non_curated_plugin_cache_force_reinstall` based on mode, clears manager caches if the refresh changed anything, clears caches and logs a warning on error, then updates `last_refreshed` on successful completion and, if the queued request is still the same one, clears `requested`, marks `in_flight = false`, and returns; otherwise it loops again to process the newer request.

**Call relations**: Spawned by `schedule_non_curated_plugin_cache_refresh` as the worker thread for non-curated refreshes.

*Call graph*: calls 3 internal fn (refresh_non_curated_plugin_cache, refresh_non_curated_plugin_cache_force_reinstall, clear_cache); 2 external calls (as_path, warn!).


##### `PluginsManager::configured_plugin_states`  (lines 1981–2000)

```
fn configured_plugin_states(
        &self,
        config: &PluginsConfigInput,
    ) -> (HashSet<String>, HashSet<String>)
```

**Purpose**: Computes which configured plugins are installed and which are enabled according to user config. It returns both sets for marketplace listing and detail reads.

**Data flow**: Reads configured plugins from `configured_plugins_from_stack(&config.config_layer_stack)`, builds `installed_plugins` by parsing each key as `PluginId` and checking `self.store.is_installed(&plugin_id)`, builds `enabled_plugins` by keeping keys whose `PluginConfig.enabled` is true, and returns `(HashSet<String>, HashSet<String>)`.

**Call relations**: Used by marketplace listing and plugin-detail reads to annotate plugins with installed/enabled state.

*Call graph*: calls 1 internal fn (configured_plugins_from_stack); called by 2 (list_marketplaces_for_config, read_plugin_for_config).


##### `PluginsManager::marketplace_roots`  (lines 2002–2041)

```
fn marketplace_roots(
        &self,
        config: &PluginsConfigInput,
        additional_roots: &[AbsolutePathBuf],
        include_openai_curated: bool,
    ) -> Vec<AbsolutePathBuf>
```

**Purpose**: Builds the complete set of marketplace roots visible for a config, combining caller-provided roots, configured installed marketplaces, and optionally the curated marketplace path selected by auth mode. It sorts and deduplicates the result.

**Data flow**: Starts from `additional_roots.to_vec()`, extends with `installed_marketplace_roots_from_layer_stack(&config.config_layer_stack, self.codex_home.as_path())`, conditionally chooses a curated marketplace path when `include_openai_curated` is true—using `curated_plugins_api_marketplace_path` for `ApiKey`/`BedrockApiKey` auth if the file exists, otherwise `curated_plugins_repo_path` if the directory exists—converts that path to `AbsolutePathBuf` when possible, pushes it, sorts the roots, deduplicates them, and returns the vector.

**Call relations**: Used by marketplace listing and discovery APIs to determine which marketplace manifests should be scanned.

*Call graph*: calls 4 internal fn (installed_marketplace_roots_from_layer_stack, curated_plugins_api_marketplace_path, curated_plugins_repo_path, try_from); called by 2 (discover_marketplaces_for_config, list_marketplaces_for_config); 3 external calls (as_path, matches!, to_vec).


##### `remote_plugin_install_required_description`  (lines 2044–2070)

```
fn remote_plugin_install_required_description(source: &MarketplacePluginSource) -> String
```

**Purpose**: Builds the placeholder description shown for uninstalled git-source plugins whose full details are unavailable until installation. It includes concrete source information for user guidance.

**Data flow**: Reads a `MarketplacePluginSource` → for `Git` sources, builds a comma-separated description from URL plus optional path/ref/sha parts; for `Local` sources, uses the filesystem path display string; then formats and returns a sentence explaining that the cross-repo plugin must be installed to view more details.

**Call relations**: Called by `read_plugin_detail_for_marketplace_plugin` when returning a placeholder detail for an uninstalled git-source plugin.

*Call graph*: called by 1 (read_plugin_detail_for_marketplace_plugin); 2 external calls (format!, vec!).


##### `PluginInstallError::join`  (lines 2091–2093)

```
fn join(source: tokio::task::JoinError) -> Self
```

**Purpose**: Wraps a Tokio join error from the blocking install task into `PluginInstallError::Join`. It is a small constructor helper.

**Data flow**: Takes `tokio::task::JoinError` and returns `PluginInstallError::Join(source)`.

**Call relations**: Used when awaiting the blocking install task in `install_resolved_plugin`.

*Call graph*: 1 external calls (Join).


##### `PluginInstallError::is_invalid_request`  (lines 2095–2106)

```
fn is_invalid_request(&self) -> bool
```

**Purpose**: Classifies install errors that represent invalid caller input rather than transient or internal failures. This is useful for HTTP or CLI error mapping.

**Data flow**: Matches `self` against marketplace-not-found, invalid-marketplace-file, plugin-not-found, plugin-not-available, invalid-plugin, and invalid store errors → returns `true` for those cases and `false` otherwise.

**Call relations**: Called by higher-level error handling code to decide whether an install failure is a bad request.

*Call graph*: 1 external calls (matches!).


##### `PluginUninstallError::join`  (lines 2128–2130)

```
fn join(source: tokio::task::JoinError) -> Self
```

**Purpose**: Wraps a Tokio join error from the blocking uninstall task into `PluginUninstallError::Join`. It is a small constructor helper.

**Data flow**: Takes `tokio::task::JoinError` and returns `PluginUninstallError::Join(source)`.

**Call relations**: Used when awaiting the blocking uninstall task in `uninstall_plugin_id`.

*Call graph*: 1 external calls (Join).


##### `PluginUninstallError::is_invalid_request`  (lines 2132–2134)

```
fn is_invalid_request(&self) -> bool
```

**Purpose**: Classifies uninstall errors that represent invalid caller input. Currently only invalid plugin ids are treated as invalid requests.

**Data flow**: Matches `self` against `PluginUninstallError::InvalidPluginId(_)` and returns the resulting boolean.

**Call relations**: Used by higher-level error handling to map uninstall failures appropriately.

*Call graph*: 1 external calls (matches!).


##### `configured_plugins_from_stack`  (lines 2137–2145)

```
fn configured_plugins_from_stack(
    config_layer_stack: &ConfigLayerStack,
) -> HashMap<String, PluginConfig>
```

**Purpose**: Extracts configured plugins from the effective user config in the manager layer. It intentionally treats plugin entries as persisted user config only.

**Data flow**: Reads `config_layer_stack.effective_user_config()`, returns empty map if absent, otherwise delegates to `configured_plugins_from_user_config_value` and returns the parsed plugin map.

**Call relations**: Used by manager cache-key computation and configured-plugin-state derivation.

*Call graph*: calls 2 internal fn (effective_user_config, configured_plugins_from_user_config_value); called by 2 (configured_plugin_states, plugins_for_config_with_force_reload); 1 external calls (new).


##### `configured_plugins_from_user_config_value`  (lines 2147–2160)

```
fn configured_plugins_from_user_config_value(
    user_config: &toml::Value,
) -> HashMap<String, PluginConfig>
```

**Purpose**: Parses the `[plugins]` TOML subtree into `HashMap<String, PluginConfig>` for manager code. Invalid plugin config syntax is logged and treated as empty.

**Data flow**: Looks up `plugins` in the provided `toml::Value`, returns empty map if absent, clones the subtree and attempts `try_into()`, returning the parsed map on success or logging `warn!` and returning empty on failure.

**Call relations**: Shared by manager-level config extraction helpers.

*Call graph*: called by 1 (configured_plugins_from_stack); 3 external calls (new, get, warn!).


### Marketplace lifecycle
These files cover adding, tracking, upgrading, and removing plugin marketplaces from local or git-backed sources.

### `core-plugins/src/marketplace_add/metadata.rs`

`config` · `marketplace add`

This module defines `MarketplaceInstallMetadata`, an internal normalized representation of how a marketplace was added: either a git source with URL/ref/sparse paths or a local source with a canonical path string. The add workflow uses this metadata in two directions. First, `record_added_marketplace_entry` converts it into a `MarketplaceConfigUpdate` and writes or updates the `[marketplaces.<name>]` entry in `config.toml`, including a generated UTC timestamp. Second, `installed_marketplace_root_for_source` and `find_marketplace_root_by_name` read `config.toml`, parse the `[marketplaces]` table, resolve configured roots via `resolve_configured_marketplace_root`, and validate those roots with `validate_marketplace_root` before returning them.

The matching logic is exact: source type, source string, optional ref, and sparse paths must all match for a configured marketplace to count as the same source. Sparse paths are read from TOML arrays and compared as ordered string vectors. Timestamp generation is implemented locally without external date libraries: `utc_timestamp_now` gets seconds since the Unix epoch, `format_utc_timestamp` converts them to RFC3339-like UTC text, and `civil_from_days` performs the Gregorian calendar conversion. Errors are wrapped as `MarketplaceAddError::Internal` with concrete file paths and parse/read context so add operations can report configuration problems precisely.

#### Function details

##### `record_added_marketplace_entry`  (lines 32–53)

```
fn record_added_marketplace_entry(
    codex_home: &Path,
    marketplace_name: &str,
    install_metadata: &MarketplaceInstallMetadata,
) -> Result<(), MarketplaceAddError>
```

**Purpose**: Writes or updates the user config entry for an added marketplace using normalized install metadata. It records source details and a fresh UTC timestamp.

**Data flow**: Takes `codex_home`, `marketplace_name`, and `MarketplaceInstallMetadata`; derives `source`, `source_type`, optional `ref_name`, and sparse paths from the metadata; computes `last_updated` via `utc_timestamp_now`; builds a `MarketplaceConfigUpdate`; and passes it to `record_user_marketplace`, mapping any failure into `MarketplaceAddError::Internal`.

**Call relations**: Called by the add workflow both for first-time installs and for re-adding an already configured source.

*Call graph*: calls 5 internal fn (config_source, config_source_type, ref_name, sparse_paths, utc_timestamp_now); called by 2 (add_marketplace_sync_with_cloner, installed_marketplace_root_for_source_uses_local_source_root); 1 external calls (record_user_marketplace).


##### `installed_marketplace_root_for_source`  (lines 55–96)

```
fn installed_marketplace_root_for_source(
    codex_home: &Path,
    install_root: &Path,
    install_metadata: &MarketplaceInstallMetadata,
) -> Result<Option<PathBuf>, MarketplaceAddError>
```

**Purpose**: Finds an already configured marketplace root whose config entry matches a given source exactly. It is used to detect idempotent re-adds of the same marketplace source.

**Data flow**: Reads `<codex_home>/config.toml` if present, parses it as TOML, extracts the `[marketplaces]` table, iterates entries, filters them through `install_metadata.matches_config`, resolves each matching root with `resolve_configured_marketplace_root`, validates the root with `validate_marketplace_root`, and returns the first valid matching `PathBuf` or `None`.

**Call relations**: Called by `add_marketplace_sync_with_cloner` before any install work to detect already-added sources.

*Call graph*: calls 3 internal fn (resolve_configured_marketplace_root, validate_marketplace_root, matches_config); called by 3 (add_marketplace_sync_with_cloner, installed_marketplace_root_for_source_propagates_config_read_errors, installed_marketplace_root_for_source_uses_local_source_root); 5 external calls (join, Internal, format!, read_to_string, from_str).


##### `find_marketplace_root_by_name`  (lines 98–138)

```
fn find_marketplace_root_by_name(
    codex_home: &Path,
    install_root: &Path,
    marketplace_name: &str,
) -> Result<Option<PathBuf>, MarketplaceAddError>
```

**Purpose**: Looks up a configured marketplace by name and returns its resolved root if the root still validates as a marketplace. It is used to detect name collisions with different sources.

**Data flow**: Reads and parses `config.toml`, extracts `[marketplaces.<marketplace_name>]`, resolves the configured root with `resolve_configured_marketplace_root`, validates it with `validate_marketplace_root`, and returns `Some(root)` only if validation succeeds.

**Call relations**: Used by the add workflow after validating a new source’s marketplace name to reject adding a different source under an already configured name.

*Call graph*: calls 2 internal fn (resolve_configured_marketplace_root, validate_marketplace_root); called by 1 (add_marketplace_sync_with_cloner); 5 external calls (join, Internal, format!, read_to_string, from_str).


##### `MarketplaceInstallMetadata::from_source`  (lines 141–153)

```
fn from_source(source: &MarketplaceSource, sparse_paths: &[String]) -> Self
```

**Purpose**: Normalizes a parsed `MarketplaceSource` plus sparse paths into the internal metadata representation stored in config. It preserves only the fields relevant for duplicate detection and config updates.

**Data flow**: Matches on `MarketplaceSource`; for git sources it clones the URL, optional ref, and sparse path vector into `InstalledMarketplaceSource::Git`; for local sources it stores the path’s display string in `InstalledMarketplaceSource::Local`; then wraps it in `MarketplaceInstallMetadata`.

**Call relations**: Called by the add workflow and metadata tests before config matching or recording.

*Call graph*: called by 3 (add_marketplace_sync_with_cloner, installed_marketplace_root_for_source_propagates_config_read_errors, installed_marketplace_root_for_source_uses_local_source_root).


##### `MarketplaceInstallMetadata::config_source_type`  (lines 155–160)

```
fn config_source_type(&self) -> &'static str
```

**Purpose**: Returns the config `source_type` string corresponding to the metadata source variant. It keeps config serialization and matching consistent.

**Data flow**: Matches `self.source` and returns either `"git"` or `"local"`.

**Call relations**: Used by `record_added_marketplace_entry` and `matches_config`.

*Call graph*: called by 2 (matches_config, record_added_marketplace_entry).


##### `MarketplaceInstallMetadata::config_source`  (lines 162–167)

```
fn config_source(&self) -> String
```

**Purpose**: Returns the config `source` string corresponding to the metadata. For git sources this is the normalized URL; for local sources it is the canonical path string.

**Data flow**: Matches `self.source` and clones either the stored git URL or local path string.

**Call relations**: Used by config writing and config-entry matching.

*Call graph*: called by 2 (matches_config, record_added_marketplace_entry).


##### `MarketplaceInstallMetadata::ref_name`  (lines 169–174)

```
fn ref_name(&self) -> Option<&str>
```

**Purpose**: Exposes the optional git ref associated with the metadata, or `None` for local sources. It lets config writing and matching treat local and git sources uniformly.

**Data flow**: Matches `self.source` and returns `ref_name.as_deref()` for git sources or `None` for local sources.

**Call relations**: Used by `record_added_marketplace_entry` and `matches_config`.

*Call graph*: called by 2 (matches_config, record_added_marketplace_entry).


##### `MarketplaceInstallMetadata::sparse_paths`  (lines 176–181)

```
fn sparse_paths(&self) -> &[String]
```

**Purpose**: Returns the sparse checkout path list associated with the metadata, or an empty slice for local sources. This keeps duplicate detection sensitive to sparse checkout differences.

**Data flow**: Matches `self.source` and returns either the stored sparse path slice or an empty slice.

**Call relations**: Used by `record_added_marketplace_entry` and `matches_config`.

*Call graph*: called by 2 (matches_config, record_added_marketplace_entry).


##### `MarketplaceInstallMetadata::matches_config`  (lines 183–190)

```
fn matches_config(&self, marketplace: &toml::Value) -> bool
```

**Purpose**: Checks whether a TOML marketplace config entry exactly matches this metadata’s source type, source string, optional ref, and sparse paths. It is the equality predicate for duplicate-source detection.

**Data flow**: Reads `source_type`, `source`, and `ref` from the TOML value, computes sparse paths via `config_sparse_paths`, compares each against the metadata-derived values, and returns a boolean.

**Call relations**: Called by `installed_marketplace_root_for_source` while scanning configured marketplaces.

*Call graph*: calls 5 internal fn (config_source, config_source_type, ref_name, sparse_paths, config_sparse_paths); called by 1 (installed_marketplace_root_for_source); 1 external calls (get).


##### `config_sparse_paths`  (lines 193–205)

```
fn config_sparse_paths(marketplace: &toml::Value) -> Vec<String>
```

**Purpose**: Extracts sparse checkout paths from a marketplace TOML entry as a vector of strings. Non-string array elements are ignored.

**Data flow**: Looks up `sparse_paths`, interprets it as an array, filters elements through `as_str`, clones them into a `Vec<String>`, and returns an empty vector if the field is absent or malformed.

**Call relations**: Used only by `MarketplaceInstallMetadata::matches_config`.

*Call graph*: called by 1 (matches_config); 1 external calls (get).


##### `utc_timestamp_now`  (lines 207–214)

```
fn utc_timestamp_now() -> Result<String, MarketplaceAddError>
```

**Purpose**: Generates the current UTC timestamp string used in marketplace config updates. It wraps system clock access and formatting.

**Data flow**: Reads `SystemTime::now()`, computes duration since `UNIX_EPOCH`, maps pre-epoch clocks to `MarketplaceAddError::Internal`, converts seconds to `i64`, formats them with `format_utc_timestamp`, and returns the string.

**Call relations**: Called by `record_added_marketplace_entry` whenever a marketplace is added or re-added.

*Call graph*: calls 1 internal fn (format_utc_timestamp); called by 1 (record_added_marketplace_entry); 1 external calls (now).


##### `format_utc_timestamp`  (lines 216–225)

```
fn format_utc_timestamp(seconds_since_epoch: i64) -> String
```

**Purpose**: Formats seconds since the Unix epoch into an RFC3339-like UTC timestamp string without using an external datetime library. It computes date and time components manually.

**Data flow**: Splits `seconds_since_epoch` into whole days and seconds-of-day, converts days to `(year, month, day)` via `civil_from_days`, derives hour/minute/second, and formats `YYYY-MM-DDTHH:MM:SSZ`.

**Call relations**: Used by `utc_timestamp_now` and directly by tests.

*Call graph*: calls 1 internal fn (civil_from_days); called by 1 (utc_timestamp_now); 1 external calls (format!).


##### `civil_from_days`  (lines 227–240)

```
fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64)
```

**Purpose**: Converts a day count since the Unix epoch into Gregorian calendar year, month, and day components. It is the calendar arithmetic core behind timestamp formatting.

**Data flow**: Applies era/year/day-of-year arithmetic to `days_since_epoch`, computes month and day, adjusts the year around January/February boundaries, and returns `(year, month, day)`.

**Call relations**: Called only by `format_utc_timestamp`.

*Call graph*: called by 1 (format_utc_timestamp).


##### `tests::utc_timestamp_formats_unix_epoch_as_rfc3339_utc`  (lines 249–258)

```
fn utc_timestamp_formats_unix_epoch_as_rfc3339_utc()
```

**Purpose**: Verifies the manual UTC formatter produces expected RFC3339-style strings for known epoch-second values. It anchors the date arithmetic implementation.

**Data flow**: Calls `format_utc_timestamp` with `0` and a later fixed timestamp and asserts the exact formatted strings.

**Call relations**: This test covers the pure formatting helpers without involving config or filesystem state.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::installed_marketplace_root_for_source_propagates_config_read_errors`  (lines 261–287)

```
fn installed_marketplace_root_for_source_propagates_config_read_errors()
```

**Purpose**: Checks that config read failures are surfaced as internal errors rather than silently ignored. A directory at the config path should trigger a read error.

**Data flow**: Creates a temp codex home, creates a directory where `config.toml` should be, builds git-source metadata, calls `installed_marketplace_root_for_source`, captures the error, and asserts the message mentions failure to read the user config path.

**Call relations**: This test targets error propagation in the duplicate-source lookup path.

*Call graph*: calls 2 internal fn (from_source, installed_marketplace_root_for_source); 3 external calls (new, assert!, create_dir).


##### `tests::installed_marketplace_root_for_source_uses_local_source_root`  (lines 290–314)

```
fn installed_marketplace_root_for_source_uses_local_source_root()
```

**Purpose**: Verifies that a recorded local-source marketplace resolves back to its original source root rather than an install-root-derived path. This is essential for idempotent local-source adds.

**Data flow**: Creates a temp codex home and local marketplace source root, writes a minimal marketplace manifest there, builds local-source metadata, records it into config, calls `installed_marketplace_root_for_source`, and asserts the returned root equals the original source root.

**Call relations**: This test covers the local-source branch of metadata recording and lookup.

*Call graph*: calls 3 internal fn (from_source, installed_marketplace_root_for_source, record_added_marketplace_entry); 4 external calls (new, assert_eq!, create_dir_all, write).


### `core-plugins/src/marketplace_add/source.rs`

`domain_logic` · `marketplace add`

This module turns user-facing source strings into a typed `MarketplaceSource` enum. `parse_marketplace_source` accepts three broad forms: local filesystem paths, git URLs, and GitHub shorthand `owner/repo`. It trims input, optionally extracts a ref suffix from `#ref` or `@ref` syntax, rejects empty sources, and enforces that explicit refs are only allowed for git sources. Local paths are recognized broadly, including absolute paths, `./` and `../` relatives, `~/...`, `.`/`..`, and Windows absolute paths even on non-Windows hosts. They are canonicalized against the current working directory and rejected if they resolve to a file rather than a directory.

Git sources include HTTP(S) URLs, SSH URLs, and GitHub shorthand. GitHub HTTPS URLs are normalized to include `.git`, and shorthand expands to `https://github.com/<owner>/<repo>.git`. `stage_marketplace_source` then enforces that sparse checkout is only used with git sources and delegates actual cloning to an injected closure; local sources are unreachable there because the add workflow handles them without staging. Finally, `validate_marketplace_source_root` confirms a staged or local root contains a valid marketplace manifest and that the marketplace name itself passes plugin-segment validation. The module also provides `MarketplaceSource::display`, which reconstructs a stable user-facing source string, including `#ref` for git sources with an explicit ref.

#### Function details

##### `parse_marketplace_source`  (lines 18–65)

```
fn parse_marketplace_source(
    source: &str,
    explicit_ref: Option<String>,
) -> Result<MarketplaceSource, MarketplaceAddError>
```

**Purpose**: Parses a user-supplied marketplace source string into either a normalized git source or a canonical local directory source. It also merges inline and explicit ref syntax and enforces source-type-specific constraints.

**Data flow**: Trims `source`, rejects emptiness, splits any embedded ref with `split_source_ref`, lets `explicit_ref` override the parsed ref, classifies the base source as local path, SSH/HTTP git URL, or GitHub shorthand, canonicalizes local paths with `resolve_local_source_path`, normalizes git URLs with `normalize_git_url`, and returns `MarketplaceSource` or `MarketplaceAddError::InvalidRequest`.

**Call relations**: Used by the add workflow and source-type checks. It delegates classification and normalization to the helper predicates and path/url normalizers in this module.

*Call graph*: calls 7 internal fn (is_git_url, is_ssh_git_url, looks_like_github_shorthand, looks_like_local_path, normalize_git_url, resolve_local_source_path, split_source_ref); called by 6 (add_marketplace_sync_with_cloner, file_url_source_is_rejected, github_shorthand_and_git_url_normalize_to_same_source, local_file_source_is_rejected, local_path_source_parses, non_git_sources_reject_ref_override); 2 external calls (InvalidRequest, format!).


##### `stage_marketplace_source`  (lines 67–90)

```
fn stage_marketplace_source(
    source: &MarketplaceSource,
    sparse_paths: &[String],
    staged_root: &Path,
    clone_source: F,
) -> Result<(), MarketplaceAddError>
```

**Purpose**: Stages a parsed marketplace source into a temporary directory by invoking an injected git clone function. It only supports git sources and rejects sparse checkout for non-git sources.

**Data flow**: Receives a `MarketplaceSource`, sparse path list, staged root, and clone closure; rejects non-empty sparse paths unless the source is `Git`; for git sources it passes the URL, optional ref, sparse paths, and staged root to the clone closure; local sources are unreachable and trigger `unreachable!`.

**Call relations**: Called by `add_marketplace_sync_with_cloner` after source parsing. It isolates the staging policy from the higher-level add orchestration.

*Call graph*: called by 2 (add_marketplace_sync_with_cloner, non_git_sources_reject_sparse_checkout); 3 external calls (InvalidRequest, matches!, unreachable!).


##### `validate_marketplace_source_root`  (lines 92–98)

```
fn validate_marketplace_source_root(root: &Path) -> Result<String, MarketplaceAddError>
```

**Purpose**: Validates that a local or staged directory is a real marketplace root and that its marketplace name is a valid plugin segment. It converts marketplace validation failures into add-request errors.

**Data flow**: Calls `validate_marketplace_root(root)` to load and validate the marketplace manifest, then validates the returned marketplace name with `validate_plugin_segment`, mapping both failure modes into `MarketplaceAddError::InvalidRequest`.

**Call relations**: Used by the add workflow for both local-source roots and staged git clones before recording or installing them.

*Call graph*: calls 1 internal fn (validate_marketplace_root); called by 1 (add_marketplace_sync_with_cloner); 1 external calls (validate_plugin_segment).


##### `split_source_ref`  (lines 100–111)

```
fn split_source_ref(source: &str) -> (String, Option<String>)
```

**Purpose**: Separates an inline ref suffix from a source string when the syntax permits it. It supports `#ref` generally and `@ref` for non-URL, non-SSH shorthand-like sources.

**Data flow**: Checks for `rsplit_once('#')` first and returns the base plus `non_empty_ref`; otherwise, if the source is not a URL/SSH form, checks `rsplit_once('@')`; if neither applies, returns the original source and `None`.

**Call relations**: Called by `parse_marketplace_source` before source classification.

*Call graph*: calls 2 internal fn (is_ssh_git_url, non_empty_ref); called by 1 (parse_marketplace_source).


##### `non_empty_ref`  (lines 113–116)

```
fn non_empty_ref(ref_name: &str) -> Option<String>
```

**Purpose**: Trims a ref string and drops it if empty. It prevents blank inline refs from being treated as meaningful selectors.

**Data flow**: Trims the input `ref_name` and returns `Some(trimmed.to_string())` only if it is non-empty.

**Call relations**: Used by `split_source_ref`.

*Call graph*: called by 1 (split_source_ref).


##### `normalize_git_url`  (lines 118–125)

```
fn normalize_git_url(url: &str) -> String
```

**Purpose**: Normalizes git URLs by removing trailing slashes and appending `.git` to GitHub HTTPS URLs when missing. It leaves non-GitHub URLs otherwise unchanged.

**Data flow**: Strips trailing `/` characters from the input URL, checks for a GitHub HTTPS prefix without `.git`, appends `.git` in that case, and returns the normalized string.

**Call relations**: Called by `parse_marketplace_source` for HTTP(S) and SSH git sources.

*Call graph*: called by 1 (parse_marketplace_source); 1 external calls (format!).


##### `looks_like_local_path`  (lines 127–137)

```
fn looks_like_local_path(source: &str) -> bool
```

**Purpose**: Recognizes whether a source string should be interpreted as a local filesystem path rather than a git source. It intentionally supports Unix, Windows, relative, and tilde-prefixed forms.

**Data flow**: Checks whether `Path::new(source).is_absolute()`, whether it matches a Windows absolute path, or whether it starts with `./`, `../`, `~/`, or equals `.`/`..`, returning a boolean.

**Call relations**: Used by `parse_marketplace_source` as the first source-classification branch.

*Call graph*: calls 1 internal fn (looks_like_windows_absolute_path); called by 1 (parse_marketplace_source); 1 external calls (new).


##### `looks_like_windows_absolute_path`  (lines 139–146)

```
fn looks_like_windows_absolute_path(source: &str) -> bool
```

**Purpose**: Detects Windows absolute path syntax even on non-Windows hosts. This keeps source parsing platform-agnostic for user input.

**Data flow**: Examines the source bytes for drive-letter forms like `C:\` or `C:/`, or UNC paths starting with `\\`, and returns a boolean.

**Call relations**: Called by `looks_like_local_path`.

*Call graph*: called by 1 (looks_like_local_path); 1 external calls (matches!).


##### `resolve_local_source_path`  (lines 148–167)

```
fn resolve_local_source_path(source: &str) -> Result<PathBuf, MarketplaceAddError>
```

**Purpose**: Canonicalizes a local marketplace source path, expanding `~/` and resolving relative paths against the current working directory. It turns user input into a stable absolute path.

**Data flow**: Expands a leading tilde with `expand_tilde_path`, checks whether the resulting path is absolute, otherwise joins it to `std::env::current_dir()`, canonicalizes the final path, and returns the canonical `PathBuf` or an add error.

**Call relations**: Used by `parse_marketplace_source` for local-source inputs.

*Call graph*: calls 1 internal fn (expand_tilde_path); called by 1 (parse_marketplace_source); 1 external calls (current_dir).


##### `expand_tilde_path`  (lines 169–177)

```
fn expand_tilde_path(source: &str) -> PathBuf
```

**Purpose**: Expands a `~/...` path prefix using `HOME` or `USERPROFILE`. If no home variable is available, it leaves the source unchanged.

**Data flow**: Checks for a `~/` prefix, reads `HOME` or `USERPROFILE`, and joins the remainder onto that home path; otherwise returns `PathBuf::from(source)`.

**Call relations**: Called by `resolve_local_source_path`.

*Call graph*: called by 1 (resolve_local_source_path); 2 external calls (from, var_os).


##### `is_ssh_git_url`  (lines 179–181)

```
fn is_ssh_git_url(source: &str) -> bool
```

**Purpose**: Recognizes SSH-style git source syntax. It supports both `ssh://...` and SCP-like `git@host:path` forms.

**Data flow**: Returns true if the source starts with `ssh://` or starts with `git@` and contains `:`.

**Call relations**: Used by `parse_marketplace_source` and `split_source_ref` to distinguish URL-like sources from shorthand/local forms.

*Call graph*: called by 2 (parse_marketplace_source, split_source_ref).


##### `is_git_url`  (lines 183–185)

```
fn is_git_url(source: &str) -> bool
```

**Purpose**: Recognizes HTTP(S) git URLs. It is a narrow predicate used during source classification.

**Data flow**: Returns true if the source starts with `http://` or `https://`.

**Call relations**: Used by `parse_marketplace_source`.

*Call graph*: called by 1 (parse_marketplace_source).


##### `looks_like_github_shorthand`  (lines 187–195)

```
fn looks_like_github_shorthand(source: &str) -> bool
```

**Purpose**: Detects `owner/repo` GitHub shorthand syntax. It requires exactly two slash-separated valid shorthand segments.

**Data flow**: Splits the source on `/`, extracts owner, repo, and any extra segment, validates owner and repo with `is_github_shorthand_segment`, and returns true only when there are exactly two valid segments.

**Call relations**: Used by `parse_marketplace_source` before expanding shorthand into a GitHub URL.

*Call graph*: called by 1 (parse_marketplace_source).


##### `is_github_shorthand_segment`  (lines 197–202)

```
fn is_github_shorthand_segment(segment: &str) -> bool
```

**Purpose**: Validates one GitHub shorthand segment. Allowed characters are ASCII alphanumerics plus `-`, `_`, and `.`.

**Data flow**: Checks the segment is non-empty and all characters are in the allowed set, returning a boolean.

**Call relations**: Used by `looks_like_github_shorthand`.


##### `MarketplaceSource::display`  (lines 205–213)

```
fn display(&self) -> String
```

**Purpose**: Formats a parsed marketplace source back into a stable user-facing string. Git sources include `#ref` when a ref is present; local sources display their path.

**Data flow**: Matches `self`; for `Git` it returns either `url` or `url#ref_name`; for `Local` it returns `path.display().to_string()`.

**Call relations**: Used by the add workflow when populating `MarketplaceAddOutcome.source_display`.

*Call graph*: 1 external calls (format!).


##### `tests::github_shorthand_parses_ref_suffix`  (lines 223–231)

```
fn github_shorthand_parses_ref_suffix()
```

**Purpose**: Verifies GitHub shorthand with an `@ref` suffix parses into a normalized Git source with the expected ref. It anchors shorthand ref parsing behavior.

**Data flow**: Calls `parse_marketplace_source("owner/repo@main", None)` and asserts the exact `MarketplaceSource::Git` result.

**Call relations**: This test covers the shorthand-plus-ref branch of source parsing.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::git_url_parses_fragment_ref`  (lines 234–246)

```
fn git_url_parses_fragment_ref()
```

**Purpose**: Checks that a git URL with `#ref` syntax parses correctly and preserves the URL while extracting the ref. It validates fragment-style ref parsing.

**Data flow**: Parses `https://example.com/team/repo.git#v1` and asserts the resulting git source URL and `ref_name`.

**Call relations**: This test covers the `#ref` branch in `split_source_ref`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::explicit_ref_overrides_source_ref`  (lines 249–257)

```
fn explicit_ref_overrides_source_ref()
```

**Purpose**: Verifies an explicit `--ref` style argument overrides any inline ref embedded in the source string. The parser should prefer the explicit value.

**Data flow**: Parses `owner/repo@main` with `Some("release")` and asserts the resulting git source uses `ref_name = Some("release")`.

**Call relations**: This test targets the `explicit_ref.or(parsed_ref)` precedence rule in `parse_marketplace_source`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::github_shorthand_and_git_url_normalize_to_same_source`  (lines 260–276)

```
fn github_shorthand_and_git_url_normalize_to_same_source()
```

**Purpose**: Checks that GitHub shorthand and the equivalent full GitHub URL normalize to the same parsed source. This ensures duplicate detection sees them as identical.

**Data flow**: Parses `owner/repo` and `https://github.com/owner/repo.git`, compares the two `MarketplaceSource` values for equality, and asserts the normalized expected git source.

**Call relations**: This test validates normalization consistency across accepted git source syntaxes.

*Call graph*: calls 1 internal fn (parse_marketplace_source); 1 external calls (assert_eq!).


##### `tests::github_url_with_trailing_slash_normalizes_without_extra_path_segment`  (lines 279–288)

```
fn github_url_with_trailing_slash_normalizes_without_extra_path_segment()
```

**Purpose**: Verifies a GitHub URL ending in `/` normalizes cleanly to the `.git` form without preserving the trailing slash. It protects against malformed URL normalization.

**Data flow**: Parses `https://github.com/owner/repo/` and asserts the normalized git source URL is `https://github.com/owner/repo.git`.

**Call relations**: This test covers `normalize_git_url` behavior for trailing slashes.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::non_github_https_source_parses_as_git_url`  (lines 291–300)

```
fn non_github_https_source_parses_as_git_url()
```

**Purpose**: Checks that non-GitHub HTTPS repository URLs are accepted as git sources without `.git` rewriting. Only GitHub URLs receive special normalization.

**Data flow**: Parses `https://gitlab.com/owner/repo` and asserts the resulting git source preserves that URL unchanged.

**Call relations**: This test covers the generic HTTP(S) git URL branch.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::file_url_source_is_rejected`  (lines 303–313)

```
fn file_url_source_is_rejected()
```

**Purpose**: Verifies `file://` URLs are not accepted by the marketplace source parser. They should fail with the generic invalid-format error.

**Data flow**: Attempts to parse `file:///tmp/marketplace.git`, captures the error, and asserts the message mentions an invalid marketplace source format.

**Call relations**: This test covers a rejected URL form not handled by `is_git_url` or local-path detection.

*Call graph*: calls 1 internal fn (parse_marketplace_source); 1 external calls (assert!).


##### `tests::local_path_source_parses`  (lines 316–323)

```
fn local_path_source_parses()
```

**Purpose**: Checks that a local path like `.` is recognized and resolved to an absolute local source. It validates the local-path branch of parsing.

**Data flow**: Parses `.` with no explicit ref, pattern-matches the result as `MarketplaceSource::Local`, and asserts the resolved path is absolute.

**Call relations**: This test exercises `looks_like_local_path` and `resolve_local_source_path` together.

*Call graph*: calls 1 internal fn (parse_marketplace_source); 2 external calls (assert!, panic!).


##### `tests::windows_absolute_paths_look_like_local_paths_on_every_host`  (lines 326–331)

```
fn windows_absolute_paths_look_like_local_paths_on_every_host()
```

**Purpose**: Verifies Windows absolute path syntax is recognized as local-path input regardless of the host OS. This keeps parsing behavior consistent across platforms.

**Data flow**: Calls `looks_like_local_path` on drive-letter and UNC examples and asserts true, while asserting false for a drive-relative path.

**Call relations**: This test targets the platform-agnostic path classifier helpers.

*Call graph*: 1 external calls (assert!).


##### `tests::local_file_source_is_rejected`  (lines 334–347)

```
fn local_file_source_is_rejected()
```

**Purpose**: Checks that a local source resolving to a file is rejected; marketplace sources must be directories. This prevents treating a manifest file path as a root directory source.

**Data flow**: Creates a temp file, passes its path to `parse_marketplace_source`, captures the error, and asserts the message says the local source must be a directory, not a file.

**Call relations**: This test covers the post-canonicalization file-vs-directory check in `parse_marketplace_source`.

*Call graph*: calls 1 internal fn (parse_marketplace_source); 3 external calls (new, assert!, write).


##### `tests::non_git_sources_reject_ref_override`  (lines 350–358)

```
fn non_git_sources_reject_ref_override()
```

**Purpose**: Verifies explicit refs are rejected for local sources. Ref selection is only meaningful for git-backed marketplace sources.

**Data flow**: Attempts to parse `./marketplace` with `Some("main")`, captures the error, and asserts the message mentions `--ref` only being supported for git sources.

**Call relations**: This test covers source-type-specific validation in `parse_marketplace_source`.

*Call graph*: calls 1 internal fn (parse_marketplace_source); 1 external calls (assert!).


##### `tests::non_git_sources_reject_sparse_checkout`  (lines 361–376)

```
fn non_git_sources_reject_sparse_checkout()
```

**Purpose**: Checks that staging rejects sparse checkout for local sources before any clone callback is invoked. This mirrors the add workflow’s sparse validation.

**Data flow**: Builds a `MarketplaceSource::Local` from the current directory, calls `stage_marketplace_source` with a non-empty sparse path list and a no-op clone closure, captures the error, and asserts the message mentions sparse checkout only being supported for git sources.

**Call relations**: This test targets `stage_marketplace_source` directly.

*Call graph*: calls 1 internal fn (stage_marketplace_source); 3 external calls (new, assert!, current_dir).


##### `tests::ssh_url_parses_as_git_url`  (lines 379–391)

```
fn ssh_url_parses_as_git_url()
```

**Purpose**: Verifies SSH git URLs with fragment refs parse as git sources and preserve the SSH URL form. It covers the SSH-specific classification branch.

**Data flow**: Parses `ssh://git@github.com/owner/repo.git#main` and asserts the resulting `MarketplaceSource::Git` URL and ref.

**Call relations**: This test exercises `is_ssh_git_url` plus `split_source_ref` handling for SSH URLs.

*Call graph*: 1 external calls (assert_eq!).


### `core-plugins/src/marketplace_add.rs`

`orchestration` · `marketplace add`

This file is the orchestration layer for marketplace addition. It defines request/output/error types and coordinates three lower-level concerns split into submodules: source parsing/staging, install-directory manipulation, and config metadata recording. `add_marketplace` is the async entry point; it offloads the real work to a blocking helper because the flow performs filesystem operations and potentially git cloning.

`add_marketplace_sync_with_cloner` is the core routine. It parses the source string into `MarketplaceSource`, rejects `--sparse` for non-git sources, ensures the marketplace install root exists, and builds `MarketplaceInstallMetadata` from the normalized source. Before doing any install work, it checks whether the same source is already configured and still validates as a marketplace; if so, it simply refreshes the config entry and returns `already_added = true`.

Local sources are not copied into the install root: the code validates the source root, rejects reserved OpenAI curated marketplace names, rejects name collisions with a different configured source, records the config entry, and returns the canonical source path as `installed_root`. Git sources are staged into a temporary directory under `.staging`, validated after cloning, checked for reserved names and destination collisions, then atomically moved into the install root. If config recording fails after installation, the code attempts to roll back by renaming the installed directory back to staging, preserving consistency between disk state and config.

#### Function details

##### `add_marketplace`  (lines 50–57)

```
async fn add_marketplace(
    codex_home: PathBuf,
    request: MarketplaceAddRequest,
) -> Result<MarketplaceAddOutcome, MarketplaceAddError>
```

**Purpose**: Async entry point for adding a marketplace. It runs the synchronous install workflow on a blocking thread and converts join failures into internal errors.

**Data flow**: Consumes `codex_home` and `MarketplaceAddRequest`, moves them into `tokio::task::spawn_blocking`, invokes `add_marketplace_sync`, awaits the join handle, and returns either `MarketplaceAddOutcome` or `MarketplaceAddError`.

**Call relations**: Called by CLI/import flows. It is a thin async wrapper around the synchronous orchestration logic.

*Call graph*: called by 2 (import_plugins, run_add); 1 external calls (spawn_blocking).


##### `is_local_marketplace_source`  (lines 59–67)

```
fn is_local_marketplace_source(
    source: &str,
    explicit_ref: Option<String>,
) -> Result<bool, MarketplaceAddError>
```

**Purpose**: Determines whether a source string resolves to a local marketplace source after full parsing and validation. It is used for command behavior that depends on source type.

**Data flow**: Parses the source and optional explicit ref with `parse_marketplace_source`, pattern-matches the resulting `MarketplaceSource`, and returns `true` for `Local` and `false` for `Git`.

**Call relations**: This helper sits beside the add flow and reuses the same source parser to keep source classification consistent.

*Call graph*: 1 external calls (matches!).


##### `add_marketplace_sync`  (lines 69–74)

```
fn add_marketplace_sync(
    codex_home: &Path,
    request: MarketplaceAddRequest,
) -> Result<MarketplaceAddOutcome, MarketplaceAddError>
```

**Purpose**: Synchronous wrapper around the generic add workflow using the real git cloner. It exists so the async entry point and tests can share the same core logic.

**Data flow**: Passes `codex_home`, `request`, and the concrete `clone_git_source` function into `add_marketplace_sync_with_cloner` and returns its result.

**Call relations**: Used by `add_marketplace`; tests bypass it to inject a fake cloner into `add_marketplace_sync_with_cloner`.

*Call graph*: calls 1 internal fn (add_marketplace_sync_with_cloner).


##### `add_marketplace_sync_with_cloner`  (lines 76–210)

```
fn add_marketplace_sync_with_cloner(
    codex_home: &Path,
    request: MarketplaceAddRequest,
    clone_source: F,
) -> Result<MarketplaceAddOutcome, MarketplaceAddError>
```

**Purpose**: Performs the full marketplace-add workflow, including source parsing, duplicate detection, local-source fast path, git staging/install, reserved-name checks, config recording, and rollback on late failure. It is the central implementation of marketplace addition.

**Data flow**: Destructures the request into `source`, `ref_name`, and `sparse_paths`; parses the source; rejects sparse checkout for non-git sources; creates the install root; derives `MarketplaceInstallMetadata`; checks for an existing configured marketplace with the same source via `installed_marketplace_root_for_source`; for local sources, validates the root, rejects reserved or conflicting names, records config, and returns the canonical path; for git sources, creates a staging root and temp dir, stages the source via `stage_marketplace_source`, validates the staged marketplace root, computes a safe destination under the install root, ensures the destination stays inside the install root, atomically installs it with `replace_marketplace_root`, records config, rolls back on config-write failure, and returns the final `MarketplaceAddOutcome`.

**Call relations**: This function is called by the real sync wrapper and by tests with injected cloners. It orchestrates helpers from `install`, `metadata`, and `source` modules to keep policy and filesystem details separated.

*Call graph*: calls 13 internal fn (marketplace_install_root, ensure_marketplace_destination_is_inside_install_root, marketplace_staging_root, replace_marketplace_root, safe_marketplace_dir_name, from_source, find_marketplace_root_by_name, installed_marketplace_root_for_source, record_added_marketplace_entry, parse_marketplace_source (+3 more)); called by 5 (add_marketplace_sync, add_marketplace_sync_installs_local_directory_source_and_updates_config, add_marketplace_sync_installs_marketplace_and_updates_config, add_marketplace_sync_rejects_sparse_checkout_for_local_directory_source, add_marketplace_sync_treats_existing_local_directory_source_as_already_added); 8 external calls (new, Internal, InvalidRequest, is_openai_curated_marketplace_name, format!, create_dir_all, rename, matches!).


##### `tests::add_marketplace_sync_installs_marketplace_and_updates_config`  (lines 220–254)

```
fn add_marketplace_sync_installs_marketplace_and_updates_config() -> Result<()>
```

**Purpose**: Verifies git-source marketplace addition installs a staged copy into the marketplace install root and records the source in user config. It uses a fake cloner that copies a prepared source tree.

**Data flow**: Creates temp codex-home and source directories, writes a marketplace source fixture, calls `add_marketplace_sync_with_cloner` with a fake clone closure, then asserts the returned marketplace name/source display/installed root and inspects `config.toml` text for the expected `[marketplaces.debug]` fields.

**Call relations**: This test exercises the git-source branch of the add workflow without invoking real git.

*Call graph*: calls 1 internal fn (add_marketplace_sync_with_cloner); 6 external calls (new, new, assert!, assert_eq!, write_marketplace_source, read_to_string).


##### `tests::add_marketplace_sync_installs_local_directory_source_and_updates_config`  (lines 257–298)

```
fn add_marketplace_sync_installs_local_directory_source_and_updates_config() -> Result<()>
```

**Purpose**: Checks that local directory sources are recorded directly without copying into the install root. The returned installed root should be the canonical source directory itself.

**Data flow**: Creates temp codex-home and source directories, writes a marketplace source fixture, calls `add_marketplace_sync_with_cloner` with a cloner that would panic if used, computes the canonical expected source path, and asserts the outcome plus parsed config fields `source_type = "local"` and `source = <canonical path>`.

**Call relations**: This test covers the local-source fast path and confirms the git cloner is bypassed.

*Call graph*: calls 2 internal fn (add_marketplace_sync_with_cloner, from_absolute_path); 7 external calls (new, new, assert!, assert_eq!, write_marketplace_source, read_to_string, from_str).


##### `tests::add_marketplace_sync_rejects_sparse_checkout_for_local_directory_source`  (lines 301–330)

```
fn add_marketplace_sync_rejects_sparse_checkout_for_local_directory_source() -> Result<()>
```

**Purpose**: Verifies `--sparse` is rejected for local marketplace sources before any config or install work occurs. The command should fail cleanly and leave no config file behind.

**Data flow**: Creates temp codex-home and source directories, writes a marketplace source fixture, calls `add_marketplace_sync_with_cloner` with a local source plus non-empty `sparse_paths`, captures the error string, and asserts `config.toml` was never created.

**Call relations**: This test targets the early validation branch shared by add and staging logic.

*Call graph*: calls 1 internal fn (add_marketplace_sync_with_cloner); 5 external calls (new, assert!, assert_eq!, write_marketplace_source, vec!).


##### `tests::add_marketplace_sync_treats_existing_local_directory_source_as_already_added`  (lines 333–360)

```
fn add_marketplace_sync_treats_existing_local_directory_source_as_already_added() -> Result<()>
```

**Purpose**: Checks that adding the same local source twice is treated as an idempotent re-add rather than a conflict. The second call should return `already_added = true` and the same installed root.

**Data flow**: Creates temp codex-home and source directories, writes a marketplace source fixture, constructs one request, calls `add_marketplace_sync_with_cloner` twice with a panic-on-clone closure, and compares the two outcomes.

**Call relations**: This test exercises duplicate-source detection through `installed_marketplace_root_for_source`.

*Call graph*: calls 1 internal fn (add_marketplace_sync_with_cloner); 5 external calls (new, new, assert!, assert_eq!, write_marketplace_source).


##### `tests::write_marketplace_source`  (lines 362–386)

```
fn write_marketplace_source(source: &Path, marker: &str) -> std::io::Result<()>
```

**Purpose**: Creates a minimal marketplace source tree for tests, including a marketplace manifest and one plugin manifest plus a marker file. It supports both git-copy and local-source add tests.

**Data flow**: Creates `.agents/plugins` and `plugins/sample/.codex-plugin`, writes `marketplace.json`, writes `plugins/sample/.codex-plugin/plugin.json`, writes `plugins/sample/marker.txt`, and returns `std::io::Result<()>`.

**Call relations**: Used by all tests in this module to prepare a valid marketplace root.

*Call graph*: 3 external calls (join, create_dir_all, write).


##### `tests::copy_dir_all`  (lines 388–401)

```
fn copy_dir_all(source: &Path, destination: &Path) -> std::io::Result<()>
```

**Purpose**: Recursively copies a directory tree for test-only fake cloning. It simulates a git clone by duplicating the prepared source fixture into the staging destination.

**Data flow**: Creates the destination directory, iterates `read_dir(source)`, recurses into subdirectories, and copies files one by one into the mirrored destination path.

**Call relations**: Used as the fake cloner implementation in git-source add tests.

*Call graph*: 5 external calls (join, copy_dir_all, copy, create_dir_all, read_dir).


### `core-plugins/src/marketplace_upgrade/git.rs`

`io_transport` · `marketplace clone / remote revision check`

This module isolates all Git process execution used by marketplace upgrades. Rather than linking a Git library, it shells out to `git` with a deliberately noninteractive environment: `GIT_OPTIONAL_LOCKS=0` and `GIT_TERMINAL_PROMPT=0`. `git_remote_revision` first short-circuits when the requested ref is already a full 40-character SHA, otherwise runs `git ls-remote <source> <ref>` and parses the first tab-separated line into a revision string. `clone_git_source` supports two modes: a normal `git clone` followed by optional `git checkout <ref>`, or a sparse mode using `git clone --filter=blob:none --no-checkout`, `git sparse-checkout set ...`, and then checkout. In both cases it finishes by reading `HEAD` with `git rev-parse`.

The timeout wrapper polls child processes every 100 ms using `try_wait`, kills the process when the deadline expires, and includes captured stderr in timeout errors when available. `ensure_git_success` standardizes non-zero-exit handling by formatting stderr into the returned error string. On Windows, `git_path_arg` strips the `\\?\` verbatim path prefix, including UNC forms, because some Git invocations do not accept verbatim paths. The embedded tests pin SHA detection, command environment setup, and Windows path rewriting behavior.

#### Function details

##### `git_remote_revision`  (lines 8–41)

```
fn git_remote_revision(
    source: &str,
    ref_name: Option<&str>,
    timeout: Duration,
) -> Result<String, String>
```

**Purpose**: Determines the commit revision to use for a marketplace source and ref. It avoids network work when the ref is already a full SHA and otherwise queries the remote with `git ls-remote`.

**Data flow**: Inputs are a source URL/path, optional ref name, and timeout. If `ref_name` exists and `is_full_git_sha` returns true, it returns that SHA directly. Otherwise it defaults the ref to `HEAD`, builds a `git ls-remote` command via `git_command`, runs it through `run_git_command_with_timeout`, validates success with `ensure_git_success`, parses stdout's first line as `<sha>\t<ref>`, trims the SHA, and returns it as `String` or a contextual error if output is empty or malformed.

**Call relations**: Called by `upgrade_configured_git_marketplace` before deciding whether an installed marketplace is already current. It delegates process execution and status handling to the lower-level helpers in this module.

*Call graph*: calls 4 internal fn (ensure_git_success, git_command, is_full_git_sha, run_git_command_with_timeout); called by 1 (upgrade_configured_git_marketplace); 2 external calls (from_utf8_lossy, format!).


##### `clone_git_source`  (lines 43–110)

```
fn clone_git_source(
    source: &str,
    ref_name: Option<&str>,
    sparse_paths: &[String],
    destination: &Path,
    timeout: Duration,
) -> Result<String, String>
```

**Purpose**: Clones a marketplace Git source into a destination directory, optionally using sparse checkout, and returns the checked-out revision. It encapsulates the exact sequence of Git commands needed for both full and sparse clones.

**Data flow**: Takes source, optional ref, sparse path list, destination path, and timeout. It first normalizes the destination with `git_path_arg`. If `sparse_paths` is empty, it runs `git clone`, optionally `git checkout <ref>`, then returns `git_worktree_revision`. If sparse paths are present, it runs `git clone --filter=blob:none --no-checkout`, then `git sparse-checkout set <paths...>`, then `git checkout <ref or HEAD>`, and finally returns `git_worktree_revision`. Any command failure is converted into a descriptive `Err(String)`.

**Call relations**: Invoked by `upgrade_configured_git_marketplace` after staging directory creation. It relies on `git_command`, `run_git_command_with_timeout`, and `ensure_git_success` for each subprocess step.

*Call graph*: calls 5 internal fn (ensure_git_success, git_command, git_path_arg, git_worktree_revision, run_git_command_with_timeout); called by 1 (upgrade_configured_git_marketplace).


##### `git_worktree_revision`  (lines 112–130)

```
fn git_worktree_revision(destination: &Path, timeout: Duration) -> Result<String, String>
```

**Purpose**: Reads the current `HEAD` revision from a cloned worktree. It is the final step after clone/checkout to capture the activated revision string.

**Data flow**: Accepts a destination path and timeout, runs `git -C <destination> rev-parse HEAD`, checks success, converts stdout to UTF-8 lossily, trims it, and returns the revision string unless it is empty, in which case it returns an error.

**Call relations**: Used internally by `clone_git_source` in both full-clone and sparse-clone branches to report the exact checked-out revision.

*Call graph*: calls 3 internal fn (ensure_git_success, git_command, run_git_command_with_timeout); called by 1 (clone_git_source); 1 external calls (from_utf8_lossy).


##### `is_full_git_sha`  (lines 132–134)

```
fn is_full_git_sha(value: &str) -> bool
```

**Purpose**: Recognizes whether a string is already a full Git object SHA. This lets callers skip remote resolution for pinned revisions.

**Data flow**: Reads the input `&str`, checks that its length is exactly 40 and every character is an ASCII hex digit, and returns a boolean.

**Call relations**: Called only by `git_remote_revision` before deciding whether to invoke `git ls-remote`.

*Call graph*: called by 1 (git_remote_revision).


##### `git_command`  (lines 136–142)

```
fn git_command() -> Command
```

**Purpose**: Constructs a base `git` command configured for stable, noninteractive execution. It centralizes environment setup for all Git subprocesses.

**Data flow**: Creates `Command::new("git")`, sets `GIT_OPTIONAL_LOCKS=0` and `GIT_TERMINAL_PROMPT=0`, and returns the configured `Command`.

**Call relations**: Used by all Git subprocess builders in this module and also inspected by a unit test to verify environment behavior.

*Call graph*: called by 4 (clone_git_source, git_remote_revision, git_worktree_revision, git_command_uses_path_lookup_with_stable_noninteractive_env); 1 external calls (new).


##### `git_path_arg`  (lines 152–154)

```
fn git_path_arg(path: &Path) -> PathBuf
```

**Purpose**: Normalizes filesystem paths before passing them to Git, with Windows-specific rewriting for verbatim paths. On non-Windows it is a no-op clone of the path.

**Data flow**: On Windows/test builds it converts the path to a lossy string, tries `strip_windows_verbatim_path_prefix`, and returns either the stripped `PathBuf` or the original `to_path_buf()`. On non-Windows it simply returns `path.to_path_buf()`.

**Call relations**: Called by `clone_git_source` so clone and checkout commands receive a Git-compatible destination path.

*Call graph*: calls 1 internal fn (strip_windows_verbatim_path_prefix); called by 1 (clone_git_source); 2 external calls (to_path_buf, to_string_lossy).


##### `strip_windows_verbatim_path_prefix`  (lines 157–164)

```
fn strip_windows_verbatim_path_prefix(path: &str) -> Option<String>
```

**Purpose**: Removes the `\\?\` verbatim prefix from Windows paths, including converting `\\?\UNC\...` back to standard UNC syntax. This improves compatibility with Git CLI path parsing.

**Data flow**: Takes a path string, returns `None` if it does not start with `\\?\`. Otherwise it strips that prefix, rewrites a leading `UNC\` segment to `\\server\share...`, and returns the normalized string in `Some`.

**Call relations**: Used by the Windows/test version of `git_path_arg` and covered by dedicated unit tests for disk and UNC path forms.

*Call graph*: called by 1 (git_path_arg).


##### `run_git_command_with_timeout`  (lines 166–207)

```
fn run_git_command_with_timeout(
    command: &mut Command,
    context: &str,
    timeout: Duration,
) -> Result<Output, String>
```

**Purpose**: Executes a prepared Git command with piped output and a hard timeout, killing the child if it runs too long. It standardizes process spawning, polling, and timeout error formatting.

**Data flow**: Receives a mutable `Command`, context string, and timeout. It configures stdin as null and stdout/stderr as piped, spawns the child, records `Instant::now()`, then loops calling `try_wait`. If the child exits, it returns `wait_with_output()`. If polling errors, it returns an error immediately. If elapsed time reaches the timeout, it kills the child, waits for output, extracts trimmed stderr, and returns a timeout error mentioning the context and timeout seconds, optionally including stderr. Between polls it sleeps for 100 ms.

**Call relations**: This is the shared execution primitive used by `git_remote_revision`, `clone_git_source`, and `git_worktree_revision`.

*Call graph*: called by 3 (clone_git_source, git_remote_revision, git_worktree_revision); 8 external calls (from_millis, null, piped, from_utf8_lossy, stdin, format!, sleep, now).


##### `ensure_git_success`  (lines 209–222)

```
fn ensure_git_success(output: &Output, context: &str) -> Result<(), String>
```

**Purpose**: Converts a completed Git process result into success or a readable failure string based on exit status and stderr. It keeps command-specific callers concise.

**Data flow**: Reads an `Output` and context string. If `output.status.success()` is true it returns `Ok(())`; otherwise it decodes and trims stderr and returns an `Err(String)` containing the context, exit status, and stderr when present.

**Call relations**: Called after every Git subprocess in this module so callers can separate transport errors from non-zero Git exits.

*Call graph*: called by 3 (clone_git_source, git_remote_revision, git_worktree_revision); 2 external calls (from_utf8_lossy, format!).


##### `tests::full_git_sha_ref_is_already_a_remote_revision`  (lines 233–237)

```
fn full_git_sha_ref_is_already_a_remote_revision()
```

**Purpose**: Tests the SHA detector used to bypass `git ls-remote`. It verifies acceptance of a full 40-character hex SHA and rejection of branch names and short SHAs.

**Data flow**: Calls `is_full_git_sha` with three representative strings and asserts the expected booleans.

**Call relations**: This unit test directly exercises the helper used by `git_remote_revision`.

*Call graph*: 1 external calls (assert!).


##### `tests::git_command_uses_path_lookup_with_stable_noninteractive_env`  (lines 240–253)

```
fn git_command_uses_path_lookup_with_stable_noninteractive_env()
```

**Purpose**: Verifies that `git_command` invokes `git` by program name and sets only the intended noninteractive environment variables. It protects command construction assumptions.

**Data flow**: Builds a command with `git_command`, inspects `get_program()` and selected environment entries via `command_env`, and asserts expected values for `GIT_OPTIONAL_LOCKS`, `GIT_TERMINAL_PROMPT`, and absence of an explicit `PATH` override.

**Call relations**: This test validates the shared command builder used by all Git subprocess functions.

*Call graph*: calls 1 internal fn (git_command); 1 external calls (assert_eq!).


##### `tests::strips_windows_verbatim_disk_prefix_for_git`  (lines 256–261)

```
fn strips_windows_verbatim_disk_prefix_for_git()
```

**Purpose**: Checks that a verbatim Windows disk path is rewritten into a normal drive-letter path. It pins one branch of Windows path normalization.

**Data flow**: Calls `strip_windows_verbatim_path_prefix` with a `\\?\C:\...` path and asserts the returned normalized string.

**Call relations**: This test covers the helper used by `git_path_arg` on Windows/test builds.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::strips_windows_verbatim_unc_prefix_for_git`  (lines 264–269)

```
fn strips_windows_verbatim_unc_prefix_for_git()
```

**Purpose**: Checks that a verbatim Windows UNC path is rewritten into standard UNC syntax. It pins the UNC-specific normalization branch.

**Data flow**: Calls `strip_windows_verbatim_path_prefix` with a `\\?\UNC\server\share\...` path and asserts the returned `\\server\share\...` string.

**Call relations**: Like the disk-prefix test, this validates the Windows path helper used before invoking Git.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::leaves_non_verbatim_path_without_rewrite`  (lines 272–274)

```
fn leaves_non_verbatim_path_without_rewrite()
```

**Purpose**: Verifies that ordinary Windows paths are not rewritten by the verbatim-prefix stripper. It protects against over-normalization.

**Data flow**: Calls `strip_windows_verbatim_path_prefix` with a normal `C:\Users\alice` path and asserts that the result is `None`.

**Call relations**: This test complements the positive rewrite tests for the same helper.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::command_env`  (lines 276–284)

```
fn command_env(
        command: &'a std::process::Command,
        name: &str,
    ) -> Option<Option<&'a OsStr>>
```

**Purpose**: Looks up a named environment variable in a `Command` for test assertions. It is a small test-only inspection helper.

**Data flow**: Takes a borrowed `Command` and variable name, iterates `get_envs()`, finds the matching key, and returns the optional value as `Option<Option<&OsStr>>`.

**Call relations**: Used only by `tests::git_command_uses_path_lookup_with_stable_noninteractive_env` to inspect the command built by `git_command`.

*Call graph*: 1 external calls (get_envs).


### `core-plugins/src/marketplace_upgrade.rs`

`orchestration` · `background upgrade / config-driven marketplace refresh`

This file is the orchestration layer for marketplace auto-upgrades. It defines the public outcome type `ConfiguredMarketplaceUpgradeOutcome`, which reports which configured marketplaces were selected, which install roots were actually upgraded, and any per-marketplace errors. Internally it uses a compact `ConfiguredGitMarketplace` struct extracted from `MarketplaceConfig` values in the effective user config. Only marketplaces whose `source_type` is `Git` and that have a `source` URL are considered; malformed config is logged and ignored rather than failing the whole operation.

The main flow starts in `upgrade_configured_git_marketplaces`: gather configured Git marketplaces, optionally filter by a requested marketplace name, compute the install root under `.tmp/marketplaces`, and iterate each marketplace independently. Each upgrade validates the marketplace name as a plugin path segment, resolves the remote revision, skips work if the installed manifest exists and both stored revision and install metadata still match, otherwise clones into a temporary staging directory. The staged checkout is validated with `validate_marketplace_root`, required to report the same marketplace name as the configured one, and annotated with install metadata. Activation is delegated to `activation::activate_marketplace_root`, which swaps the staged tree into place and runs a closure that re-reads `config.toml` to ensure the marketplace configuration did not change mid-flight before persisting updated revision and timestamp via `record_user_marketplace`. Errors are converted into user-facing strings at each boundary.

#### Function details

##### `ConfiguredMarketplaceUpgradeOutcome::all_succeeded`  (lines 51–53)

```
fn all_succeeded(&self) -> bool
```

**Purpose**: Reports whether the upgrade run completed without any per-marketplace errors. It is a convenience predicate over the accumulated outcome state.

**Data flow**: Reads `self.errors` and returns `true` when the vector is empty, otherwise `false`. It does not mutate any state.

**Call relations**: This method is consumed by callers after `upgrade_configured_git_marketplaces` returns, to summarize whether the orchestration encountered any failures.


##### `configured_git_marketplace_names`  (lines 56–63)

```
fn configured_git_marketplace_names(config_layer_stack: &ConfigLayerStack) -> Vec<String>
```

**Purpose**: Returns the sorted names of all configured Git marketplaces visible in the effective user config. It is a lightweight discovery helper for callers that need names without performing upgrades.

**Data flow**: Accepts a `&ConfigLayerStack`, calls `configured_git_marketplaces`, maps each `ConfiguredGitMarketplace` to its `name`, sorts the resulting `Vec<String>` with `sort_unstable`, and returns it.

**Call relations**: Called by higher-level upgrade orchestration to enumerate candidate marketplace names. It delegates all config parsing and filtering to `configured_git_marketplaces`.

*Call graph*: calls 1 internal fn (configured_git_marketplaces); called by 1 (upgrade_configured_marketplaces_for_config).


##### `upgrade_configured_git_marketplaces`  (lines 65–103)

```
fn upgrade_configured_git_marketplaces(
    codex_home: &Path,
    config_layer_stack: &ConfigLayerStack,
    marketplace_name: Option<&str>,
) -> ConfiguredMarketplaceUpgradeOutcome
```

**Purpose**: Runs the full upgrade pass for configured Git marketplaces, optionally restricted to one marketplace name. It aggregates successes and failures into a single structured outcome instead of failing fast.

**Data flow**: Takes `codex_home`, a `ConfigLayerStack`, and an optional marketplace-name filter. It loads configured Git marketplaces, filters them by name when provided, returns a default empty outcome if none remain, computes the install root, collects selected names, then loops over each marketplace calling `upgrade_configured_git_marketplace`. `Ok(Some(path))` appends to `upgraded_roots`, `Ok(None)` means no-op, and `Err(message)` becomes a `ConfiguredMarketplaceUpgradeError` paired with the marketplace name. It returns a populated `ConfiguredMarketplaceUpgradeOutcome`.

**Call relations**: This is the public driver invoked by higher-level config upgrade code. It delegates config discovery to `configured_git_marketplaces`, path computation to `marketplace_install_root`, and per-marketplace work to `upgrade_configured_git_marketplace`.

*Call graph*: calls 3 internal fn (configured_git_marketplaces, marketplace_install_root, upgrade_configured_git_marketplace); called by 1 (upgrade_configured_marketplaces_for_config); 2 external calls (new, default).


##### `marketplace_install_root`  (lines 105–107)

```
fn marketplace_install_root(codex_home: &Path) -> PathBuf
```

**Purpose**: Computes the filesystem root where upgraded marketplaces are installed under the Codex home directory. It centralizes the `.tmp/marketplaces` location.

**Data flow**: Receives `&Path` for `codex_home`, joins the constant `INSTALLED_MARKETPLACES_DIR`, and returns the resulting `PathBuf`.

**Call relations**: Used only by `upgrade_configured_git_marketplaces` before iterating upgrades, so all per-marketplace installs share the same destination base.

*Call graph*: called by 1 (upgrade_configured_git_marketplaces); 1 external calls (join).


##### `configured_git_marketplaces`  (lines 109–135)

```
fn configured_git_marketplaces(
    config_layer_stack: &ConfigLayerStack,
) -> Vec<ConfiguredGitMarketplace>
```

**Purpose**: Extracts valid Git marketplace definitions from the effective user config. It tolerates missing config and malformed marketplace sections by returning an empty list and logging warnings.

**Data flow**: Reads `effective_user_config()` from the `ConfigLayerStack`; if absent, returns an empty vector. It looks up the `marketplaces` key, clones that value, attempts conversion into `HashMap<String, MarketplaceConfig>`, warns and returns empty on conversion failure, then `filter_map`s entries through `configured_git_marketplace_from_config`, sorts the resulting vector by marketplace name, and returns it.

**Call relations**: This function is the shared config-parsing backend for both `configured_git_marketplace_names` and `upgrade_configured_git_marketplaces`. It delegates per-entry filtering and shaping to `configured_git_marketplace_from_config`.

*Call graph*: calls 1 internal fn (effective_user_config); called by 2 (configured_git_marketplace_names, upgrade_configured_git_marketplaces); 2 external calls (new, warn!).


##### `configured_git_marketplace_from_config`  (lines 137–166)

```
fn configured_git_marketplace_from_config(
    name: String,
    marketplace: MarketplaceConfig,
) -> Option<ConfiguredGitMarketplace>
```

**Purpose**: Converts one `MarketplaceConfig` entry into the internal `ConfiguredGitMarketplace` form only when it is a usable Git-backed marketplace. Non-Git entries and Git entries missing a source are ignored.

**Data flow**: Consumes a marketplace `name` and `MarketplaceConfig`, destructures fields, returns `None` unless `source_type == Some(MarketplaceSourceType::Git)`, warns and returns `None` if `source` is missing, otherwise builds `ConfiguredGitMarketplace` with `sparse_paths.unwrap_or_default()` and the optional `last_revision` and `ref_name`.

**Call relations**: Called while scanning config maps in both `configured_git_marketplaces` and `read_configured_git_marketplace`. It is the gatekeeper that decides whether a config entry participates in Git upgrade logic.

*Call graph*: called by 1 (read_configured_git_marketplace); 1 external calls (warn!).


##### `upgrade_configured_git_marketplace`  (lines 168–243)

```
fn upgrade_configured_git_marketplace(
    codex_home: &Path,
    install_root: &Path,
    marketplace: &ConfiguredGitMarketplace,
) -> Result<Option<AbsolutePathBuf>, String>
```

**Purpose**: Performs the actual upgrade of one configured Git marketplace from remote revision check through staged clone, validation, metadata write, activation, and config update. It returns `None` when the installed copy is already current and metadata-consistent.

**Data flow**: Inputs are `codex_home`, the shared `install_root`, and a `ConfiguredGitMarketplace`. It validates the marketplace name segment, resolves the remote revision via `git_remote_revision`, computes the destination path, and short-circuits with `Ok(None)` if an installed manifest exists, the stored `last_revision` matches the remote revision, and `installed_marketplace_metadata_matches` confirms source/ref/sparse-path consistency. Otherwise it creates a `.staging` parent, allocates a temp staging dir, clones the source with `clone_git_source`, validates the staged root with `validate_marketplace_root`, rejects mismatched marketplace names, writes install metadata, builds a `MarketplaceConfigUpdate` with current UTC timestamp and activated revision, and calls `activate_marketplace_root`. The activation callback re-checks config consistency via `ensure_configured_git_marketplace_unchanged` and persists the updated config with `record_user_marketplace`. Finally it converts the destination into `AbsolutePathBuf` and returns `Ok(Some(path))`.

**Call relations**: This function is invoked once per selected marketplace by `upgrade_configured_git_marketplaces`. It delegates Git operations to the `git` submodule, activation and metadata handling to the `activation` submodule, root validation to the marketplace module, and config persistence to `codex_config`.

*Call graph*: calls 8 internal fn (find_marketplace_manifest_path, validate_marketplace_root, activate_marketplace_root, installed_marketplace_metadata_matches, write_installed_marketplace_metadata, clone_git_source, git_remote_revision, try_from); called by 1 (upgrade_configured_git_marketplaces); 6 external calls (join, now, validate_plugin_segment, format!, create_dir_all, new).


##### `ensure_configured_git_marketplace_unchanged`  (lines 244–260)

```
fn ensure_configured_git_marketplace_unchanged(
    codex_home: &Path,
    expected: &ConfiguredGitMarketplace,
) -> Result<(), String>
```

**Purpose**: Guards the activation step against concurrent config edits by re-reading the configured marketplace and comparing it to the expected pre-upgrade definition. It prevents writing stale upgrade metadata for a marketplace whose source or type changed mid-flight.

**Data flow**: Takes `codex_home` and an expected `ConfiguredGitMarketplace`, calls `read_configured_git_marketplace`, and matches on the result. It returns `Ok(())` only if the current config entry exists and is exactly equal to `expected`; otherwise it returns a descriptive `Err(String)` for changed, removed, or no-longer-Git marketplaces.

**Call relations**: Used only inside the activation callback in `upgrade_configured_git_marketplace`, immediately before `record_user_marketplace`, so the filesystem swap and config update remain consistent with the current config.

*Call graph*: calls 1 internal fn (read_configured_git_marketplace); 1 external calls (format!).


##### `read_configured_git_marketplace`  (lines 262–297)

```
fn read_configured_git_marketplace(
    codex_home: &Path,
    marketplace_name: &str,
) -> Result<Option<ConfiguredGitMarketplace>, String>
```

**Purpose**: Reads `config.toml` directly from disk and extracts one named Git marketplace entry in the same normalized internal form used during upgrade. It is intentionally independent of the earlier `ConfigLayerStack` snapshot so it can detect in-flight changes.

**Data flow**: Builds the config path from `codex_home` and `CONFIG_TOML_FILE`, reads the file as a string, returning `Ok(None)` if it does not exist. It parses the TOML into `toml::Value`, looks up the `marketplaces` table, converts it into `HashMap<String, MarketplaceConfig>`, removes the requested marketplace by name, and passes it to `configured_git_marketplace_from_config`. Parse and conversion failures become contextual `Err(String)` messages.

**Call relations**: Called by `ensure_configured_git_marketplace_unchanged` during activation-time validation. It reuses `configured_git_marketplace_from_config` so the comparison uses the same normalization rules as the initial config scan.

*Call graph*: calls 1 internal fn (configured_git_marketplace_from_config); called by 1 (ensure_configured_git_marketplace_unchanged); 4 external calls (join, format!, read_to_string, from_str).


### `core-plugins/src/marketplace_remove.rs`

`orchestration` · `marketplace remove`

This file is the teardown counterpart to marketplace addition. `remove_marketplace` is the async entry point and simply runs the synchronous removal logic on a blocking thread. The real work happens in `remove_marketplace_sync`: it validates the requested marketplace name with `validate_plugin_segment`, computes the installed marketplace path under `marketplace_install_root`, and asks `remove_user_marketplace_config` to remove the config entry first. That ordering matters: if config removal fails, the installed root is left untouched.

The function handles a special `RemoveMarketplaceConfigOutcome::NameCaseMismatch` result by returning an `InvalidRequest` that names both the requested and configured marketplace names, preventing accidental removal when casing differs. After config removal, it calls `remove_marketplace_root`, which inspects the filesystem entry with `symlink_metadata` and removes either a directory tree or a single file. If neither config nor installed root existed, the operation is rejected as an unknown marketplace. Otherwise the outcome reports the marketplace name and an optional `AbsolutePathBuf` for the removed installed root. The tests cover normal removal, unknown names, case mismatch, malformed config preventing deletion, file-vs-directory installed roots, and inline TOML marketplace entries.

#### Function details

##### `remove_marketplace`  (lines 29–38)

```
async fn remove_marketplace(
    codex_home: PathBuf,
    request: MarketplaceRemoveRequest,
) -> Result<MarketplaceRemoveOutcome, MarketplaceRemoveError>
```

**Purpose**: Async entry point for marketplace removal. It runs the synchronous removal workflow on a blocking thread and wraps task-join failures as internal errors.

**Data flow**: Consumes `codex_home` and `MarketplaceRemoveRequest`, moves them into `tokio::task::spawn_blocking`, invokes `remove_marketplace_sync`, awaits the result, and returns either `MarketplaceRemoveOutcome` or `MarketplaceRemoveError`.

**Call relations**: Called by the remove command path. It is a thin async wrapper around the synchronous implementation.

*Call graph*: called by 1 (run_remove); 1 external calls (spawn_blocking).


##### `remove_marketplace_sync`  (lines 40–74)

```
fn remove_marketplace_sync(
    codex_home: &Path,
    request: MarketplaceRemoveRequest,
) -> Result<MarketplaceRemoveOutcome, MarketplaceRemoveError>
```

**Purpose**: Performs marketplace removal by validating the name, removing the config entry, handling case-mismatch errors, deleting the installed root if present, and rejecting no-op removals. It is the main implementation of marketplace teardown.

**Data flow**: Extracts `marketplace_name` from the request, validates it with `validate_plugin_segment`, computes the installed destination under `marketplace_install_root`, removes config via `remove_user_marketplace_config`, converts config errors into `Internal`, returns `InvalidRequest` on `NameCaseMismatch`, tracks whether config was removed, removes the installed root via `remove_marketplace_root`, rejects the request if neither config nor root existed, and returns `MarketplaceRemoveOutcome`.

**Call relations**: Used by the async wrapper and directly by tests. It delegates filesystem deletion details to `remove_marketplace_root`.

*Call graph*: calls 2 internal fn (marketplace_install_root, remove_marketplace_root); called by 6 (remove_marketplace_sync_keeps_installed_root_when_config_removal_fails, remove_marketplace_sync_rejects_case_mismatched_configured_name, remove_marketplace_sync_rejects_unknown_marketplace, remove_marketplace_sync_removes_config_and_installed_root, remove_marketplace_sync_removes_file_installed_root, remove_marketplace_sync_removes_inline_config_entry); 4 external calls (remove_user_marketplace_config, validate_plugin_segment, InvalidRequest, format!).


##### `remove_marketplace_root`  (lines 76–105)

```
fn remove_marketplace_root(root: &Path) -> Result<Option<AbsolutePathBuf>, MarketplaceRemoveError>
```

**Purpose**: Deletes an installed marketplace filesystem entry if it exists, handling both directories and files. It returns the absolute removed path for reporting.

**Data flow**: Checks `root.exists()`, returns `None` if absent, converts the path to `AbsolutePathBuf`, reads metadata with `symlink_metadata`, chooses `remove_dir_all` for directories or `remove_file` otherwise, maps failures into `MarketplaceRemoveError::Internal`, and returns `Some(removed_root)`.

**Call relations**: Called by `remove_marketplace_sync` after config removal succeeds.

*Call graph*: calls 1 internal fn (try_from); called by 1 (remove_marketplace_sync); 5 external calls (exists, to_path_buf, remove_dir_all, remove_file, symlink_metadata).


##### `tests::remove_marketplace_sync_removes_config_and_installed_root`  (lines 116–156)

```
fn remove_marketplace_sync_removes_config_and_installed_root()
```

**Purpose**: Verifies the normal removal path deletes both the config entry and the installed marketplace directory. It also checks the returned removed-root path.

**Data flow**: Creates a temp codex home, records a marketplace config entry, creates an installed marketplace directory with a manifest file, calls `remove_marketplace_sync`, and asserts the outcome, absence of the config section, and absence of the installed root.

**Call relations**: This test covers the standard successful removal flow.

*Call graph*: calls 2 internal fn (marketplace_install_root, remove_marketplace_sync); 7 external calls (new, assert!, assert_eq!, record_user_marketplace, create_dir_all, read_to_string, write).


##### `tests::remove_marketplace_sync_rejects_unknown_marketplace`  (lines 159–174)

```
fn remove_marketplace_sync_rejects_unknown_marketplace()
```

**Purpose**: Checks that removing a marketplace with neither config nor installed root returns a clear invalid-request error. The operation should not silently succeed.

**Data flow**: Creates an empty temp codex home, calls `remove_marketplace_sync` for `debug`, captures the error, and asserts the exact message.

**Call relations**: This test covers the final no-op rejection branch in `remove_marketplace_sync`.

*Call graph*: calls 1 internal fn (remove_marketplace_sync); 2 external calls (new, assert_eq!).


##### `tests::remove_marketplace_sync_rejects_case_mismatched_configured_name`  (lines 177–211)

```
fn remove_marketplace_sync_rejects_case_mismatched_configured_name()
```

**Purpose**: Verifies removal is case-sensitive with respect to configured marketplace names. A mismatched case should fail without deleting config or the installed root.

**Data flow**: Creates a config entry for `debug`, creates the installed root, calls `remove_marketplace_sync` with `Debug`, captures the error, and asserts both the installed root and config entry remain.

**Call relations**: This test targets the `NameCaseMismatch` handling branch.

*Call graph*: calls 2 internal fn (marketplace_install_root, remove_marketplace_sync); 6 external calls (new, assert!, assert_eq!, record_user_marketplace, create_dir_all, read_to_string).


##### `tests::remove_marketplace_sync_keeps_installed_root_when_config_removal_fails`  (lines 214–237)

```
fn remove_marketplace_sync_keeps_installed_root_when_config_removal_fails()
```

**Purpose**: Ensures the installed root is not deleted if config removal fails, preserving consistency and avoiding partial teardown. A malformed config should abort before filesystem deletion.

**Data flow**: Writes malformed `config.toml`, creates the installed root, calls `remove_marketplace_sync`, captures the error, and asserts the installed root still exists.

**Call relations**: This test validates the ordering guarantee that config removal happens before root deletion.

*Call graph*: calls 2 internal fn (marketplace_install_root, remove_marketplace_sync); 4 external calls (new, assert!, create_dir_all, write).


##### `tests::remove_marketplace_sync_removes_file_installed_root`  (lines 240–280)

```
fn remove_marketplace_sync_removes_file_installed_root()
```

**Purpose**: Checks that a corrupt installed marketplace represented by a file instead of a directory is still removed successfully. The removal logic should inspect metadata and choose the correct deletion API.

**Data flow**: Creates a config entry, creates a file at the installed-root path, calls `remove_marketplace_sync`, and asserts the returned outcome, file deletion, and config removal.

**Call relations**: This test covers the non-directory branch in `remove_marketplace_root`.

*Call graph*: calls 2 internal fn (marketplace_install_root, remove_marketplace_sync); 7 external calls (new, assert!, assert_eq!, record_user_marketplace, create_dir_all, read_to_string, write).


##### `tests::remove_marketplace_sync_removes_inline_config_entry`  (lines 283–312)

```
fn remove_marketplace_sync_removes_inline_config_entry()
```

**Purpose**: Verifies marketplace removal works when the config uses inline-table syntax instead of a standard table section. The config mutation helper should still remove the entry cleanly.

**Data flow**: Writes an inline `marketplaces = { debug = { ... } }` config, creates the installed root, calls `remove_marketplace_sync`, and asserts the outcome, root deletion, and absence of `debug` in the rewritten config.

**Call relations**: This test covers compatibility with alternate TOML shapes in config removal.

*Call graph*: calls 2 internal fn (marketplace_install_root, remove_marketplace_sync); 6 external calls (new, assert!, assert_eq!, create_dir_all, read_to_string, write).


### Remote bundles and sharing
These files implement remote plugin transport, bundle installation and syncing, legacy backend compatibility, and workspace-plugin sharing and checkout flows.

### `core-plugins/src/remote_bundle.rs`

`domain_logic` · `remote bundle download, install, and checkout extraction`

This module is the low-level transport and installation layer for remote plugin bundles. `ValidatedRemotePluginBundle` captures the local `PluginId`, normalized plugin version, optional app manifest override, and bundle download URL after `validate_remote_plugin_bundle` checks all backend-provided metadata. Validation enforces a valid local plugin ID, a non-empty release version accepted by `validate_plugin_version_segment`, a non-empty parseable URL, and an allowed scheme: HTTPS always, or loopback HTTP only in debug builds when a specific environment variable is set.

Download logic uses the shared reqwest client with a 60-second timeout and two size ceilings: 50 MiB for bundle bodies and 8 KiB for error bodies. It also re-validates the final URL after redirects. Response bodies are streamed chunk by chunk through `read_response_body_with_limit`, which enforces limits using both `content_length` and incremental byte counts.

Installation and checkout extraction happen in blocking tasks. `install_remote_plugin_bundle` extracts into a temporary staging directory under `plugins/.remote-plugin-install-staging`, requires the extraction root itself to contain a standard plugin manifest, optionally rewrites the manifest version and app manifest for the global marketplace only, then installs through `PluginStore::install_with_version`. `extract_remote_plugin_bundle_to_path` performs a similar extraction for editable checkout, but instead verifies that the extracted `plugin.json` name matches the expected remote plugin name before atomically renaming the staged directory into the destination.

The extraction path delegates tar/gzip safety to `unpack_plugin_bundle_tar_gz`, maps unpack errors into domain-specific install errors, and rejects nested plugin roots. Tests cover metadata validation, size limits, malformed archives, path traversal, GNU long-name support, executable permission preservation, and the distinction between global and non-global manifest rewriting.

#### Function details

##### `RemotePluginBundleInstallError::io`  (lines 131–133)

```
fn io(context: &'static str, source: io::Error) -> Self
```

**Purpose**: Constructs the `Io` error variant with a fixed context string and underlying `io::Error`.

**Data flow**: It takes a static `context` and `source` error and returns `RemotePluginBundleInstallError::Io { context, source }`.

**Call relations**: Many filesystem and unpacking helpers use this constructor to standardize I/O error reporting.


##### `validate_remote_plugin_bundle`  (lines 136–196)

```
fn validate_remote_plugin_bundle(
    remote_plugin_id: &str,
    remote_marketplace_name: &str,
    plugin_name: &str,
    release_version: Option<&str>,
    bundle_download_url: Option<&str>,
    ap
```

**Purpose**: Validates backend-provided remote plugin metadata and converts it into a `ValidatedRemotePluginBundle` ready for download and installation.

**Data flow**: It takes the remote plugin ID, remote marketplace name, plugin name, optional release version, optional bundle URL, and optional app manifest. It builds a local `PluginId`, trims and requires a non-empty release version, validates that version segment, trims and requires a non-empty bundle URL, parses it as `Url`, checks the scheme with `is_allowed_bundle_download_url` using `allow_test_loopback_http_bundle_downloads`, and returns `ValidatedRemotePluginBundle { plugin_id, plugin_version, app_manifest, bundle_download_url }`. Failures are mapped into specific `RemotePluginBundleInstallError` variants.

**Call relations**: Higher-level remote install and checkout flows call this before any network or filesystem work so invalid backend metadata is rejected early.

*Call graph*: calls 4 internal fn (allow_test_loopback_http_bundle_downloads, is_allowed_bundle_download_url, validate_plugin_version_segment, new); called by 10 (remote_plugin_install_response, sync_remote_installed_plugin_bundles_once, checkout_remote_plugin_share, install_preserves_non_global_bundle_manifest_metadata, valid_remote_plugin_bundle, validate_remote_plugin_bundle_rejects_invalid_release_version, validate_remote_plugin_bundle_rejects_missing_download_url, validate_remote_plugin_bundle_rejects_missing_release_version, validate_remote_plugin_bundle_rejects_unsupported_download_url_scheme, validate_remote_plugin_bundle_uses_detail_name_for_local_plugin_id); 1 external calls (parse).


##### `allow_test_loopback_http_bundle_downloads`  (lines 198–207)

```
fn allow_test_loopback_http_bundle_downloads() -> bool
```

**Purpose**: Determines whether debug/test builds should permit loopback HTTP bundle URLs.

**Data flow**: In debug builds it reads the environment variable named by `TEST_ALLOW_LOOPBACK_HTTP_REMOTE_PLUGIN_BUNDLES_ENV` and returns `true` only when its value is `"1"`; otherwise it returns `false`. In non-debug builds it always returns `false`.

**Call relations**: Both initial URL validation and post-redirect final-URL validation consult this helper when deciding whether plain HTTP is acceptable.

*Call graph*: called by 2 (download_remote_plugin_bundle_with_limit, validate_remote_plugin_bundle); 1 external calls (var).


##### `is_allowed_bundle_download_url`  (lines 209–215)

```
fn is_allowed_bundle_download_url(url: &Url, allow_loopback_http: bool) -> bool
```

**Purpose**: Checks whether a parsed bundle download URL uses an allowed scheme and host combination.

**Data flow**: It matches on `url.scheme()`: `https` is always allowed, `http` is allowed only when `allow_loopback_http` is true and `is_loopback_url(url)` returns true, and all other schemes are rejected. It returns a boolean.

**Call relations**: Validation and download code both use this helper so the same URL policy applies before and after redirects.

*Call graph*: calls 1 internal fn (is_loopback_url); called by 2 (download_remote_plugin_bundle_with_limit, validate_remote_plugin_bundle); 1 external calls (scheme).


##### `is_loopback_url`  (lines 217–224)

```
fn is_loopback_url(url: &Url) -> bool
```

**Purpose**: Recognizes whether a URL points at a loopback host.

**Data flow**: It inspects `url.host()` and returns true for loopback IPv4, loopback IPv6, or the domain `localhost` ignoring ASCII case; otherwise false.

**Call relations**: This helper supports the debug-only allowance for loopback HTTP bundle downloads.

*Call graph*: called by 1 (is_allowed_bundle_download_url); 1 external calls (host).


##### `download_and_install_remote_plugin_bundle`  (lines 226–244)

```
async fn download_and_install_remote_plugin_bundle(
    codex_home: PathBuf,
    bundle: ValidatedRemotePluginBundle,
) -> Result<PluginInstallResult, RemotePluginBundleInstallError>
```

**Purpose**: Downloads a validated remote plugin bundle and installs it into the local plugin store on a blocking worker thread.

**Data flow**: It takes `codex_home` and a `ValidatedRemotePluginBundle`, downloads the archive bytes with `download_remote_plugin_bundle_with_limit`, then moves `codex_home`, the bundle, and bytes into `tokio::task::spawn_blocking` to run `install_remote_plugin_bundle`. It returns the resulting `PluginInstallResult` or wraps join failure as `InvalidBundle`.

**Call relations**: Remote install flows call this as the main end-to-end bundle installation primitive after metadata validation.

*Call graph*: calls 1 internal fn (download_remote_plugin_bundle_with_limit); called by 2 (remote_plugin_install_response, sync_remote_installed_plugin_bundles_once); 1 external calls (spawn_blocking).


##### `download_and_extract_remote_plugin_bundle_to_path`  (lines 246–264)

```
async fn download_and_extract_remote_plugin_bundle_to_path(
    bundle: ValidatedRemotePluginBundle,
    destination: AbsolutePathBuf,
) -> Result<AbsolutePathBuf, RemotePluginBundleInstallError>
```

**Purpose**: Downloads a validated remote plugin bundle and extracts it into a caller-specified destination directory for editable checkout.

**Data flow**: It downloads bundle bytes with `download_remote_plugin_bundle_with_limit`, then runs `extract_remote_plugin_bundle_to_path(bundle, bytes, destination)` inside `spawn_blocking`. It returns the destination `AbsolutePathBuf` on success or an install error on failure.

**Call relations**: The share checkout flow uses this instead of store installation because it wants an editable local directory rather than a cached installed plugin.

*Call graph*: calls 1 internal fn (download_remote_plugin_bundle_with_limit); called by 1 (checkout_remote_plugin_share); 1 external calls (spawn_blocking).


##### `download_remote_plugin_bundle_with_limit`  (lines 266–307)

```
async fn download_remote_plugin_bundle_with_limit(
    bundle_download_url: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, RemotePluginBundleInstallError>
```

**Purpose**: Fetches a remote bundle over HTTP(S), validates the final URL after redirects, and enforces a maximum response size.

**Data flow**: It builds a GET request with the shared reqwest client and `REMOTE_PLUGIN_BUNDLE_DOWNLOAD_TIMEOUT`, sends it, maps transport failures to `DownloadRequest`, inspects the final response URL after redirects, rejects unsupported final schemes with `UnsupportedBundleDownloadFinalUrl`, and then branches on status. Non-success statuses read at most `REMOTE_PLUGIN_BUNDLE_ERROR_BODY_MAX_BYTES` via `read_response_body_with_limit`, decode that body lossily to UTF-8, and return `DownloadStatus`. Success statuses stream the full body through `read_response_body_with_limit` using the caller-provided `max_bytes` and return the collected bytes.

**Call relations**: Both install and checkout extraction paths call this before handing bytes to blocking extraction/install helpers.

*Call graph*: calls 4 internal fn (allow_test_loopback_http_bundle_downloads, is_allowed_bundle_download_url, read_response_body_with_limit, build_reqwest_client); called by 2 (download_and_extract_remote_plugin_bundle_to_path, download_and_install_remote_plugin_bundle); 1 external calls (from_utf8_lossy).


##### `read_response_body_with_limit`  (lines 309–334)

```
async fn read_response_body_with_limit(
    mut response: Response,
    url: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, RemotePluginBundleInstallError>
```

**Purpose**: Streams an HTTP response body into memory while enforcing a byte limit.

**Data flow**: It takes a mutable `Response`, URL string, and `max_bytes`. If `content_length()` is present, it checks that upfront with `enforce_download_size_limit`. It then repeatedly awaits `response.chunk()`, maps chunk-read failures to `DownloadBody`, computes the next total length, rechecks the limit, and appends each chunk to a `Vec<u8>`. It returns the accumulated bytes.

**Call relations**: The download helper uses this for both successful bundle bodies and truncated error bodies so size enforcement is centralized.

*Call graph*: calls 1 internal fn (enforce_download_size_limit); called by 1 (download_remote_plugin_bundle_with_limit); 3 external calls (new, chunk, content_length).


##### `enforce_download_size_limit`  (lines 336–348)

```
fn enforce_download_size_limit(
    url: &str,
    bytes: u64,
    max_bytes: u64,
) -> Result<(), RemotePluginBundleInstallError>
```

**Purpose**: Fails when a download body size exceeds the configured maximum.

**Data flow**: It compares `bytes` against `max_bytes` and returns `DownloadTooLarge { url, max_bytes }` if `bytes > max_bytes`, otherwise `Ok(())`.

**Call relations**: Streaming response reads call this repeatedly, and a unit test exercises it directly.

*Call graph*: called by 2 (read_response_body_with_limit, download_size_limit_rejects_oversized_bundle).


##### `install_remote_plugin_bundle`  (lines 350–385)

```
fn install_remote_plugin_bundle(
    codex_home: PathBuf,
    bundle: ValidatedRemotePluginBundle,
    bundle_bytes: Vec<u8>,
) -> Result<PluginInstallResult, RemotePluginBundleInstallError>
```

**Purpose**: Extracts a downloaded bundle into a staging directory, prepares any required manifest overrides, and installs it into the plugin store with the validated plugin ID and version.

**Data flow**: It creates the staging root under `codex_home/plugins/.remote-plugin-install-staging`, creates a temporary extraction directory there, extracts the tar.gz bytes with `extract_plugin_bundle_tar_gz`, finds the plugin root with `find_extracted_plugin_root`, applies `prepare_extracted_remote_plugin_root` for global-marketplace overrides, converts the root to `AbsolutePathBuf`, opens a `PluginStore`, and calls `install_with_version(plugin_root, bundle.plugin_id, bundle.plugin_version)`. It returns the resulting `PluginInstallResult` or a mapped install error.

**Call relations**: This is the blocking worker function behind `download_and_install_remote_plugin_bundle`; tests also call it directly with synthetic archives.

*Call graph*: calls 5 internal fn (extract_plugin_bundle_tar_gz, find_extracted_plugin_root, prepare_extracted_remote_plugin_root, try_new, try_from); called by 3 (install_preserves_non_global_bundle_manifest_metadata, install_rejects_bundle_without_standard_plugin_root, install_rejects_invalid_tar_gz_bundle); 3 external calls (join, create_dir_all, new).


##### `extract_remote_plugin_bundle_to_path`  (lines 387–442)

```
fn extract_remote_plugin_bundle_to_path(
    bundle: ValidatedRemotePluginBundle,
    bundle_bytes: Vec<u8>,
    destination: AbsolutePathBuf,
) -> Result<AbsolutePathBuf, RemotePluginBundleInstallErr
```

**Purpose**: Extracts a downloaded bundle into a temporary sibling directory, validates the manifest name, and activates it by renaming into the requested destination.

**Data flow**: It rejects preexisting destinations, requires the destination to have a parent directory, creates that parent, creates a temporary extraction directory in the parent, extracts the tar.gz bytes, finds the plugin root, loads the plugin manifest, and verifies `manifest.name == bundle.plugin_id.plugin_name`. If validation passes, it keeps the temp directory path and renames it into `destination`, then returns `destination`. Errors include invalid bundle structure, missing/invalid manifest, name mismatch, and filesystem failures.

**Call relations**: The share checkout flow uses this blocking helper through `download_and_extract_remote_plugin_bundle_to_path`.

*Call graph*: calls 4 internal fn (load_plugin_manifest, extract_plugin_bundle_tar_gz, find_extracted_plugin_root, as_path); 5 external calls (InvalidBundle, format!, create_dir_all, rename, new).


##### `prepare_extracted_remote_plugin_root`  (lines 444–457)

```
fn prepare_extracted_remote_plugin_root(
    plugin_root: &Path,
    bundle: &ValidatedRemotePluginBundle,
) -> Result<(), RemotePluginBundleInstallError>
```

**Purpose**: Applies backend-provided manifest overrides to an extracted plugin bundle when required by marketplace semantics.

**Data flow**: It checks `bundle.plugin_id.marketplace_name`; if it is not `REMOTE_GLOBAL_MARKETPLACE_NAME`, it returns immediately. For global marketplace bundles it overwrites the plugin manifest version with `overwrite_plugin_manifest_version` and, when `bundle.app_manifest` is present, writes that app manifest with `overwrite_plugin_app_manifest`.

**Call relations**: Installation calls this after extraction and before store install so global curated bundles reflect backend release metadata even if the archive contents differ.

*Call graph*: calls 2 internal fn (overwrite_plugin_app_manifest, overwrite_plugin_manifest_version); called by 1 (install_remote_plugin_bundle).


##### `overwrite_plugin_manifest_version`  (lines 459–490)

```
fn overwrite_plugin_manifest_version(
    plugin_root: &Path,
    plugin_version: &str,
) -> Result<(), RemotePluginBundleInstallError>
```

**Purpose**: Loads the extracted plugin manifest JSON, replaces its `version` field, and writes it back.

**Data flow**: It locates the manifest path with `find_plugin_manifest_path`, reads the file as text, parses it as `serde_json::Value`, requires the root to be a JSON object, inserts `"version": <plugin_version>`, and writes the updated JSON with `write_json_file`. Missing manifests, parse failures, non-object roots, and I/O failures become install errors.

**Call relations**: Global-bundle preparation calls this to force the installed manifest version to match the backend release version.

*Call graph*: calls 1 internal fn (write_json_file); called by 1 (prepare_extracted_remote_plugin_root); 5 external calls (String, find_plugin_manifest_path, InvalidBundle, read_to_string, from_str).


##### `overwrite_plugin_app_manifest`  (lines 492–504)

```
fn overwrite_plugin_app_manifest(
    plugin_root: &Path,
    app_manifest: &JsonValue,
) -> Result<(), RemotePluginBundleInstallError>
```

**Purpose**: Writes the backend-provided app manifest JSON into the extracted plugin root.

**Data flow**: It tries to load the plugin manifest and read `manifest.paths.apps` to determine the app manifest path; if unavailable it falls back to `<plugin_root>/.app.json`. It then writes the provided JSON value to that path via `write_json_file`.

**Call relations**: Global-bundle preparation uses this when the backend supplied an app manifest override alongside the bundle.

*Call graph*: calls 2 internal fn (load_plugin_manifest, write_json_file); called by 1 (prepare_extracted_remote_plugin_root).


##### `write_json_file`  (lines 506–526)

```
fn write_json_file(
    path: &Path,
    value: &JsonValue,
    context: &'static str,
) -> Result<(), RemotePluginBundleInstallError>
```

**Purpose**: Serializes a JSON value with pretty formatting and writes it to disk, creating parent directories as needed.

**Data flow**: It derives the parent directory from `path`, errors if absent, creates the parent directories, serializes `value` with `serde_json::to_vec_pretty`, appends a trailing newline byte, and writes the bytes to `path`. Serialization failures become `InvalidBundle`; filesystem failures become contextual `Io` errors.

**Call relations**: Manifest and app-manifest overwrite helpers both delegate here for consistent JSON output and error mapping.

*Call graph*: called by 2 (overwrite_plugin_app_manifest, overwrite_plugin_manifest_version); 4 external calls (parent, create_dir_all, write, to_vec_pretty).


##### `extract_plugin_bundle_tar_gz`  (lines 528–537)

```
fn extract_plugin_bundle_tar_gz(
    bytes: &[u8],
    destination: &Path,
) -> Result<(), RemotePluginBundleInstallError>
```

**Purpose**: Extracts a plugin tar.gz archive using the module’s standard maximum extracted-size limit.

**Data flow**: It forwards `bytes`, `destination`, and `REMOTE_PLUGIN_BUNDLE_MAX_EXTRACTED_BYTES` to `extract_plugin_bundle_tar_gz_with_limits` and returns that result.

**Call relations**: Install and checkout extraction paths use this standard-limit wrapper; tests also call it directly for extraction behavior.

*Call graph*: calls 1 internal fn (extract_plugin_bundle_tar_gz_with_limits); called by 5 (extract_remote_plugin_bundle_to_path, install_remote_plugin_bundle, extraction_preserves_executable_permissions, extraction_rejects_tar_path_traversal, extraction_supports_gnu_long_name_entries).


##### `extract_plugin_bundle_tar_gz_with_limits`  (lines 539–555)

```
fn extract_plugin_bundle_tar_gz_with_limits(
    bytes: &[u8],
    destination: &Path,
    max_total_bytes: u64,
) -> Result<(), RemotePluginBundleInstallError>
```

**Purpose**: Unpacks a plugin tar.gz archive into a destination directory and maps unpack-layer errors into remote-bundle install errors.

**Data flow**: It calls `unpack_plugin_bundle_tar_gz(bytes, destination, max_total_bytes)` and maps `PluginBundleUnpackError::ExtractedBundleTooLarge`, `Io`, and `InvalidBundle` into the corresponding `RemotePluginBundleInstallError` variants.

**Call relations**: The standard extraction wrapper delegates here, and tests use it directly to verify extracted-size enforcement.

*Call graph*: calls 1 internal fn (unpack_plugin_bundle_tar_gz); called by 2 (extract_plugin_bundle_tar_gz, extraction_rejects_total_size_over_limit).


##### `find_extracted_plugin_root`  (lines 557–567)

```
fn find_extracted_plugin_root(
    extraction_root: &Path,
) -> Result<PathBuf, RemotePluginBundleInstallError>
```

**Purpose**: Accepts only extraction roots that themselves contain a standard plugin manifest and rejects nested plugin directories.

**Data flow**: It checks `is_standard_plugin_root(extraction_root)`. If true, it returns `extraction_root.to_path_buf()`. Otherwise it returns `InvalidBundle` stating that the bundle did not contain a standard plugin root with `plugin.json`.

**Call relations**: Both install and checkout extraction call this immediately after unpacking to enforce the archive layout invariant expected by the rest of the system.

*Call graph*: calls 1 internal fn (is_standard_plugin_root); called by 3 (extract_remote_plugin_bundle_to_path, install_remote_plugin_bundle, find_extracted_plugin_root_rejects_nested_plugin_root); 2 external calls (to_path_buf, InvalidBundle).


##### `is_standard_plugin_root`  (lines 569–571)

```
fn is_standard_plugin_root(path: &Path) -> bool
```

**Purpose**: Determines whether a directory qualifies as a plugin root by containing a discoverable plugin manifest.

**Data flow**: It calls `find_plugin_manifest_path(path)` and returns whether the result is `Some(_)`.

**Call relations**: This helper underpins `find_extracted_plugin_root`’s strict root-layout check.

*Call graph*: called by 1 (find_extracted_plugin_root); 1 external calls (find_plugin_manifest_path).


##### `tests::validate_remote_plugin_bundle_uses_detail_name_for_local_plugin_id`  (lines 585–603)

```
fn validate_remote_plugin_bundle_uses_detail_name_for_local_plugin_id()
```

**Purpose**: Verifies that bundle validation uses the plugin name from remote detail to build the local `PluginId` and preserves the validated version and URL.

**Data flow**: It calls `validate_remote_plugin_bundle` with a known remote ID, marketplace, name, version, and URL, then asserts the resulting `ValidatedRemotePluginBundle` fields.

**Call relations**: This test documents the expected mapping from remote metadata into local bundle-install metadata.

*Call graph*: calls 1 internal fn (validate_remote_plugin_bundle); 1 external calls (assert_eq!).


##### `tests::validate_remote_plugin_bundle_rejects_missing_release_version`  (lines 606–621)

```
fn validate_remote_plugin_bundle_rejects_missing_release_version()
```

**Purpose**: Checks that validation fails when the backend omits the release version.

**Data flow**: It calls `validate_remote_plugin_bundle` with `release_version = None` and asserts the error matches `MissingReleaseVersion`.

**Call relations**: This test covers one early validation failure path in `validate_remote_plugin_bundle`.

*Call graph*: calls 1 internal fn (validate_remote_plugin_bundle); 1 external calls (assert!).


##### `tests::validate_remote_plugin_bundle_rejects_invalid_release_version`  (lines 624–639)

```
fn validate_remote_plugin_bundle_rejects_invalid_release_version()
```

**Purpose**: Checks that validation rejects release versions that are not valid local version path segments.

**Data flow**: It passes an invalid version like `../1.2.3` to `validate_remote_plugin_bundle` and asserts the error matches `InvalidReleaseVersion`.

**Call relations**: This test exercises the version-segment validation delegated from `validate_remote_plugin_bundle`.

*Call graph*: calls 1 internal fn (validate_remote_plugin_bundle); 1 external calls (assert!).


##### `tests::validate_remote_plugin_bundle_rejects_missing_download_url`  (lines 642–657)

```
fn validate_remote_plugin_bundle_rejects_missing_download_url()
```

**Purpose**: Checks that validation fails when the backend omits the bundle download URL.

**Data flow**: It calls `validate_remote_plugin_bundle` with `bundle_download_url = None` and asserts the error matches `MissingBundleDownloadUrl`.

**Call relations**: This test covers another required-field check in `validate_remote_plugin_bundle`.

*Call graph*: calls 1 internal fn (validate_remote_plugin_bundle); 1 external calls (assert!).


##### `tests::validate_remote_plugin_bundle_rejects_unsupported_download_url_scheme`  (lines 660–675)

```
fn validate_remote_plugin_bundle_rejects_unsupported_download_url_scheme()
```

**Purpose**: Verifies that plain HTTP bundle URLs are rejected under normal conditions.

**Data flow**: It validates a bundle using an `http://` URL and asserts the error matches `UnsupportedBundleDownloadUrlScheme`.

**Call relations**: This test documents the default HTTPS-only policy enforced by `validate_remote_plugin_bundle`.

*Call graph*: calls 1 internal fn (validate_remote_plugin_bundle); 1 external calls (assert!).


##### `tests::download_size_limit_rejects_oversized_bundle`  (lines 678–690)

```
fn download_size_limit_rejects_oversized_bundle()
```

**Purpose**: Checks the simple byte-limit guard used during bundle downloads.

**Data flow**: It calls `enforce_download_size_limit` with `bytes > max_bytes` and asserts the returned error matches `DownloadTooLarge`.

**Call relations**: This unit test isolates the size-check helper used by streaming response reads.

*Call graph*: calls 1 internal fn (enforce_download_size_limit); 1 external calls (assert!).


##### `tests::install_rejects_invalid_tar_gz_bundle`  (lines 693–705)

```
fn install_rejects_invalid_tar_gz_bundle()
```

**Purpose**: Verifies that installation fails cleanly when the downloaded bytes are not a valid tar.gz archive.

**Data flow**: It creates a temp Codex home, builds a valid bundle descriptor, calls `install_remote_plugin_bundle` with arbitrary invalid bytes, and asserts the formatted error mentions failure to read the plugin bundle tar.

**Call relations**: This test exercises the extraction error mapping path inside the blocking install helper.

*Call graph*: calls 1 internal fn (install_remote_plugin_bundle); 3 external calls (assert!, valid_remote_plugin_bundle, tempdir).


##### `tests::install_rejects_bundle_without_standard_plugin_root`  (lines 708–722)

```
fn install_rejects_bundle_without_standard_plugin_root()
```

**Purpose**: Checks that installation rejects archives that do not unpack directly into a standard plugin root containing `plugin.json`.

**Data flow**: It creates a temp Codex home, builds a valid bundle descriptor, constructs a tar.gz containing only `README.md`, calls `install_remote_plugin_bundle`, and asserts the error mentions the missing standard plugin root.

**Call relations**: This test targets the `find_extracted_plugin_root` invariant enforced during installation.

*Call graph*: calls 1 internal fn (install_remote_plugin_bundle); 4 external calls (assert!, tar_gz_bytes, valid_remote_plugin_bundle, tempdir).


##### `tests::install_preserves_non_global_bundle_manifest_metadata`  (lines 725–794)

```
fn install_preserves_non_global_bundle_manifest_metadata()
```

**Purpose**: Verifies that non-global marketplace installs do not overwrite the bundle’s own manifest version or app manifest with backend metadata.

**Data flow**: It validates a bundle for a non-global marketplace with backend version and app manifest, installs a tar.gz containing its own `plugin.json` and `.app.json`, then reads the installed files back and asserts they still contain the bundled metadata while the `PluginInstallResult` reports the backend version used for store versioning.

**Call relations**: This test documents the marketplace-specific behavior in `prepare_extracted_remote_plugin_root`.

*Call graph*: calls 2 internal fn (install_remote_plugin_bundle, validate_remote_plugin_bundle); 6 external calls (assert_eq!, tar_gz_bytes, from_str, json!, read_to_string, tempdir).


##### `tests::find_extracted_plugin_root_uses_local_manifest_discovery`  (lines 797–811)

```
fn find_extracted_plugin_root_uses_local_manifest_discovery()
```

**Purpose**: Checks that an extraction root containing `.codex-plugin/plugin.json` is accepted as the plugin root.

**Data flow**: It creates a temp directory, writes a manifest under `.codex-plugin/plugin.json`, calls `find_extracted_plugin_root`, and asserts the returned path equals the extraction root.

**Call relations**: This test covers the positive case for the strict root-layout check.

*Call graph*: 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `tests::find_extracted_plugin_root_rejects_nested_plugin_root`  (lines 814–830)

```
fn find_extracted_plugin_root_rejects_nested_plugin_root()
```

**Purpose**: Checks that a plugin nested one directory below the extraction root is rejected.

**Data flow**: It creates a temp extraction root with `linear/.codex-plugin/plugin.json`, calls `find_extracted_plugin_root` on the parent, and asserts the error mentions the missing standard plugin root.

**Call relations**: This test documents that nested top-level directories are not accepted by bundle extraction.

*Call graph*: calls 1 internal fn (find_extracted_plugin_root); 4 external calls (assert!, create_dir_all, write, tempdir).


##### `tests::extraction_rejects_tar_path_traversal`  (lines 833–842)

```
fn extraction_rejects_tar_path_traversal()
```

**Purpose**: Verifies that tar entries attempting to escape the extraction root are rejected.

**Data flow**: It builds a tar.gz with a raw path like `../evil.txt`, calls `extract_plugin_bundle_tar_gz`, and asserts the error mentions escaping the extraction root.

**Call relations**: This test exercises safety guarantees provided by the underlying unpacker and mapped through this module.

*Call graph*: calls 1 internal fn (extract_plugin_bundle_tar_gz); 3 external calls (assert!, tar_gz_bytes_with_raw_path, tempdir).


##### `tests::extraction_rejects_total_size_over_limit`  (lines 845–861)

```
fn extraction_rejects_total_size_over_limit()
```

**Purpose**: Checks that extraction fails when the total extracted size would exceed the configured limit.

**Data flow**: It builds a tar.gz with two files totaling more than the supplied `max_total_bytes`, calls `extract_plugin_bundle_tar_gz_with_limits`, and asserts the error matches `ExtractedBundleTooLarge`.

**Call relations**: This test targets the extracted-size limit path in the unpack wrapper.

*Call graph*: calls 1 internal fn (extract_plugin_bundle_tar_gz_with_limits); 3 external calls (assert!, tar_gz_bytes, tempdir).


##### `tests::extraction_supports_gnu_long_name_entries`  (lines 864–878)

```
fn extraction_supports_gnu_long_name_entries()
```

**Purpose**: Verifies that extraction handles tar archives containing GNU long-name entries for very long paths.

**Data flow**: It builds a tar.gz with a deeply nested long path, extracts it with `extract_plugin_bundle_tar_gz`, and asserts the extracted file contents match the original bytes.

**Call relations**: This test documents compatibility with long-path tar archives that may arise from shared plugin bundles.

*Call graph*: calls 1 internal fn (extract_plugin_bundle_tar_gz); 4 external calls (assert_eq!, tar_gz_bytes, format!, tempdir).


##### `tests::extraction_preserves_executable_permissions`  (lines 882–905)

```
fn extraction_preserves_executable_permissions()
```

**Purpose**: Checks on Unix that executable mode bits survive extraction.

**Data flow**: It builds a tar.gz containing a manifest and an executable `bin/helper` file, extracts it, reads the file metadata, masks the permission bits, and asserts the mode is `0o755`.

**Call relations**: This test verifies that the unpack path preserves executable permissions needed by plugin helper binaries.

*Call graph*: calls 1 internal fn (extract_plugin_bundle_tar_gz); 4 external calls (assert_eq!, tar_gz_bytes, metadata, tempdir).


##### `tests::valid_remote_plugin_bundle`  (lines 907–917)

```
fn valid_remote_plugin_bundle() -> ValidatedRemotePluginBundle
```

**Purpose**: Creates a reusable valid `ValidatedRemotePluginBundle` fixture for installation tests.

**Data flow**: It calls `validate_remote_plugin_bundle` with fixed valid metadata and returns the resulting bundle, panicking on failure.

**Call relations**: Several installation tests use this helper to avoid repeating bundle-validation setup.

*Call graph*: calls 1 internal fn (validate_remote_plugin_bundle).


##### `tests::tar_gz_bytes`  (lines 919–926)

```
fn tar_gz_bytes(entries: &[(&str, &[u8], u32)]) -> Vec<u8>
```

**Purpose**: Builds a gzip-compressed tar archive from a list of regular-file test entries.

**Data flow**: It creates a `GzEncoder`, wraps it in `tar::Builder`, appends each provided `(path, contents, mode)` entry via `append_tar_entry`, then finalizes the archive with `finish_tar_gz` and returns the bytes.

**Call relations**: Multiple extraction and installation tests use this helper to synthesize bundle archives.

*Call graph*: 6 external calls (new, new, default, append_tar_entry, finish_tar_gz, new).


##### `tests::tar_gz_bytes_with_raw_path`  (lines 928–947)

```
fn tar_gz_bytes_with_raw_path(path: &str, contents: &[u8], mode: u32) -> Vec<u8>
```

**Purpose**: Constructs a minimal gzip-compressed tar archive using a raw path written directly into the tar header, bypassing normal path validation.

**Data flow**: It manually fills a GNU tar header with the provided path, size, mode, and checksum, writes the header and contents into a `GzEncoder`, adds tar padding and terminator blocks, and returns the finished gzip bytes.

**Call relations**: The path-traversal test uses this helper to create an otherwise hard-to-produce malicious tar entry.

*Call graph*: 5 external calls (new, new, default, new_gnu, vec!).


##### `tests::append_tar_entry`  (lines 949–964)

```
fn append_tar_entry(
        tar: &mut tar::Builder<W>,
        entry_type: tar::EntryType,
        path: &str,
        contents: &[u8],
        mode: u32,
    )
```

**Purpose**: Appends one regular tar entry with explicit mode and contents to a test tar builder.

**Data flow**: It creates a GNU tar header, sets entry type, size, mode, and checksum, then calls `tar.append_data`; on failure it panics with a descriptive message.

**Call relations**: `tests::tar_gz_bytes` delegates per-entry archive construction to this helper.

*Call graph*: 3 external calls (append_data, panic!, new_gnu).


##### `tests::finish_tar_gz`  (lines 966–975)

```
fn finish_tar_gz(tar: tar::Builder<GzEncoder<Vec<u8>>>) -> Vec<u8>
```

**Purpose**: Finalizes a test tar builder and returns the resulting gzip-compressed bytes.

**Data flow**: It consumes the `tar::Builder`, extracts the inner `GzEncoder` with `into_inner`, panicking on error, then finishes the encoder and returns the produced bytes, again panicking on error.

**Call relations**: `tests::tar_gz_bytes` uses this helper to complete archive generation.

*Call graph*: 2 external calls (into_inner, panic!).


### `core-plugins/src/remote/remote_installed_plugin_sync.rs`

`orchestration` · `background sync and cache cleanup`

This file implements the background and one-shot workflow that keeps the local plugin cache aligned with remote installed plugins across `Global`, `Workspace`, and `User` scopes. The central async routine fetches installed plugin metadata for all three scopes concurrently, canonicalizes each plugin into a marketplace name, skips entries whose active local version already matches the remote release version, validates bundle metadata, and downloads/installs newer bundles through `crate::remote_bundle`. It accumulates three sorted result sets: successfully installed plugin IDs, stale cache entries removed afterward, and remote plugin IDs that were skipped or failed.

Two global `OnceLock<Mutex<...>>` registries coordinate concurrency. One deduplicates whole sync jobs by plugin cache root so only one sync runs per `codex_home`. The other reference-counts per-plugin cache mutations using `RemotePluginCacheMutationGuard`; stale-cache cleanup consults this map and refuses to delete a plugin cache entry while any install/update operation for that marketplace/plugin pair is active.

Stale cleanup is synchronous filesystem traversal run inside `spawn_blocking`. It scans only known remote marketplace directories under `PLUGINS_CACHE_DIR`, compares directory names against the installed-plugin name sets, skips missing roots and guarded entries, removes stale files or directories, and reports removed plugin IDs using `PluginId::new` when possible. The included tests verify sync deduplication by cache root, mutation-guard reference counting, and cleanup behavior across canonical and non-canonical shared-workspace marketplaces.

#### Function details

##### `RemoteInstalledPluginBundleSyncOutcome::changed_local_cache`  (lines 46–48)

```
fn changed_local_cache(&self) -> bool
```

**Purpose**: Reports whether a sync altered local plugin cache contents in any visible way.

**Data flow**: It reads `installed_plugin_ids` and `removed_cache_plugin_ids` from `self` and returns `true` if either vector is non-empty, otherwise `false`. It does not mutate state.

**Call relations**: The background launcher uses this predicate after a sync completes to decide whether to invoke the optional `on_local_cache_changed` callback.


##### `maybe_start_remote_installed_plugin_bundle_sync`  (lines 82–124)

```
fn maybe_start_remote_installed_plugin_bundle_sync(
    codex_home: PathBuf,
    config: RemotePluginServiceConfig,
    auth: Option<CodexAuth>,
    on_local_cache_changed: Option<Arc<dyn Fn() + Send
```

**Purpose**: Starts a detached remote-installed-plugin sync task only when authentication is available and no equivalent sync is already running for the same cache root.

**Data flow**: It takes ownership of `codex_home`, `config`, optional `auth`, and an optional callback. If `auth` is `None`, it returns immediately. Otherwise it computes a `RemoteInstalledPluginBundleSyncKey` from `remote_plugin_cache_root`, tries to register that key via `mark_remote_installed_plugin_bundle_sync_in_flight`, and if successful spawns a Tokio task. The task runs `sync_remote_installed_plugin_bundles_once`, logs either the detailed outcome or a warning, conditionally invokes the callback when `changed_local_cache()` is true, and finally clears the in-flight marker.

**Call relations**: This is the non-blocking entry used by higher-level startup or refresh flows. It gates execution through the in-flight set, delegates the actual work to `sync_remote_installed_plugin_bundles_once`, and always pairs successful registration with `clear_remote_installed_plugin_bundle_sync_in_flight` at task end.

*Call graph*: calls 4 internal fn (clear_remote_installed_plugin_bundle_sync_in_flight, mark_remote_installed_plugin_bundle_sync_in_flight, remote_plugin_cache_root, sync_remote_installed_plugin_bundles_once); 3 external calls (info!, spawn, warn!).


##### `sync_remote_installed_plugin_bundles_once`  (lines 126–277)

```
async fn sync_remote_installed_plugin_bundles_once(
    codex_home: PathBuf,
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
) -> Result<RemoteInstalledPluginBundleSyncOutcome, R
```

**Purpose**: Performs one full reconciliation pass between remote installed plugins and the local plugin cache, including downloads and stale-cache removal.

**Data flow**: It accepts `codex_home`, service `config`, and optional auth; upgrades auth with `ensure_chatgpt_auth`; concurrently fetches installed plugins for `Global`, `Workspace`, and `User` scopes with download URLs included; opens a `PluginStore`; seeds a `BTreeMap<String, BTreeSet<String>>` for known marketplace names; then iterates every installed plugin. For each plugin it derives the canonical marketplace name, records the plugin name in the marketplace set, builds a local `PluginId`, compares the remote trimmed release version against `store.active_plugin_version`, validates bundle metadata, and if needed downloads and installs the bundle. Invalid IDs, invalid bundle metadata, and download/install failures are logged and recorded in `failed_remote_plugin_ids`. After processing all scopes, it runs `remove_stale_remote_plugin_caches` in `spawn_blocking`, then returns a `RemoteInstalledPluginBundleSyncOutcome` with sorted vectors.

**Call relations**: This is the core sync engine invoked by the background launcher. It depends on remote catalog fetch helpers for source data, `remote_plugin_canonical_marketplace_name` and `PluginId::new` for local identity, `crate::remote_bundle` for validation and installation, and `remove_stale_remote_plugin_caches` for post-install cleanup.

*Call graph*: calls 4 internal fn (download_and_install_remote_plugin_bundle, validate_remote_plugin_bundle, try_new, new); called by 1 (maybe_start_remote_installed_plugin_bundle_sync); 9 external calls (from_iter, new, clone, ensure_chatgpt_auth, fetch_installed_plugins_for_scope_with_download_url, remote_plugin_canonical_marketplace_name, spawn_blocking, try_join!, warn!).


##### `mark_remote_plugin_cache_mutation_in_flight`  (lines 279–297)

```
fn mark_remote_plugin_cache_mutation_in_flight(
    codex_home: &Path,
    marketplace_name: &str,
    plugin_name: &str,
) -> RemotePluginCacheMutationGuard
```

**Purpose**: Registers that a specific remote plugin cache entry is being mutated and returns an RAII guard that will clear that registration later.

**Data flow**: It builds a `RemotePluginCacheMutationKey` from `codex_home`, `marketplace_name`, and `plugin_name`, initializes the global mutation map if needed, locks it, increments the reference count for that key, and returns `RemotePluginCacheMutationGuard { key }`. The only external state written is the shared in-flight mutation map.

**Call relations**: Install/update code can hold this guard around cache writes so `remove_stale_remote_plugin_caches` will skip the same plugin entry. The tests exercise this helper directly to verify cleanup suppression and reference counting.

*Call graph*: calls 1 internal fn (remote_plugin_cache_root); called by 1 (stale_remote_plugin_cleanup_skips_cache_mutations_in_progress).


##### `RemotePluginCacheMutationGuard::drop`  (lines 300–314)

```
fn drop(&mut self)
```

**Purpose**: Decrements the in-flight mutation count for a plugin cache entry and removes the key when the last guard is dropped.

**Data flow**: On drop, it looks up the global mutation map, locks it, finds the count for `self.key`, decrements it, and removes the key entirely when the count reaches zero. If the global map was never initialized, it exits without side effects.

**Call relations**: This is the cleanup half of `mark_remote_plugin_cache_mutation_in_flight`’s RAII protocol. `remove_stale_remote_plugin_caches` indirectly depends on this behavior because it checks the same map before deleting cache entries.


##### `remove_stale_remote_plugin_caches`  (lines 317–390)

```
fn remove_stale_remote_plugin_caches(
    codex_home: &Path,
    installed_plugin_names_by_marketplace: &BTreeMap<String, BTreeSet<String>>,
) -> Result<Vec<String>, String>
```

**Purpose**: Deletes cached remote plugin directories or files that no longer correspond to any remotely installed plugin, except for entries currently being mutated.

**Data flow**: It takes `codex_home` and a marketplace-to-installed-plugin-name map, iterates a fixed list of remote marketplace names, computes each marketplace cache root under `PLUGINS_CACHE_DIR`, skips missing roots, reads directory entries, converts each entry name to UTF-8 plugin names, and compares them against the installed-name set for that marketplace. Non-installed entries are further filtered through `is_remote_plugin_cache_mutation_in_flight`; unguarded stale entries are removed with `remove_dir_all` or `remove_file`. For reporting it tries `PluginId::new(plugin_name, marketplace_name)` and falls back to `name@marketplace` formatting, then sorts and returns the removed IDs or an error string describing the first filesystem/UTF-8 failure.

**Call relations**: The one-shot sync runs this after downloads complete, inside a blocking task, to prune obsolete cache contents. The tests call it directly to verify that guarded entries survive and that stale caches in non-canonical marketplaces are removed while canonical shared caches remain.

*Call graph*: calls 2 internal fn (is_remote_plugin_cache_mutation_in_flight, new); called by 2 (stale_remote_plugin_cleanup_removes_stale_marketplace_caches_and_keeps_canonical_cache, stale_remote_plugin_cleanup_skips_cache_mutations_in_progress); 5 external calls (join, new, read_dir, remove_dir_all, remove_file).


##### `remote_plugin_cache_root`  (lines 392–394)

```
fn remote_plugin_cache_root(codex_home: &Path) -> PathBuf
```

**Purpose**: Computes the root directory where remote plugin caches live under a given Codex home.

**Data flow**: It joins `codex_home` with `PLUGINS_CACHE_DIR` and returns the resulting `PathBuf`. It performs no I/O.

**Call relations**: This helper centralizes cache-root derivation for sync deduplication keys and mutation keys, so all concurrency bookkeeping refers to the same filesystem root.

*Call graph*: called by 4 (is_remote_plugin_cache_mutation_in_flight, mark_remote_plugin_cache_mutation_in_flight, maybe_start_remote_installed_plugin_bundle_sync, remote_installed_plugin_sync_in_flight_dedupes_by_cache_root); 1 external calls (join).


##### `is_remote_plugin_cache_mutation_in_flight`  (lines 396–413)

```
fn is_remote_plugin_cache_mutation_in_flight(
    codex_home: &Path,
    marketplace_name: &str,
    plugin_name: &str,
) -> bool
```

**Purpose**: Checks whether a specific marketplace/plugin cache entry currently has any active mutation guards.

**Data flow**: It returns `false` if the global mutation map has not been initialized. Otherwise it locks the map, constructs a `RemotePluginCacheMutationKey` from `codex_home`, `marketplace_name`, and `plugin_name`, and returns whether that key is present.

**Call relations**: Stale-cache cleanup calls this before deleting an entry so it does not race with installs or updates protected by `mark_remote_plugin_cache_mutation_in_flight`.

*Call graph*: calls 1 internal fn (remote_plugin_cache_root); called by 1 (remove_stale_remote_plugin_caches).


##### `mark_remote_installed_plugin_bundle_sync_in_flight`  (lines 415–425)

```
fn mark_remote_installed_plugin_bundle_sync_in_flight(
    key: RemoteInstalledPluginBundleSyncKey,
) -> bool
```

**Purpose**: Attempts to register a sync job as running for a given plugin cache root and reports whether this call won the race.

**Data flow**: It initializes the global sync set if needed, locks it, inserts the provided `RemoteInstalledPluginBundleSyncKey`, and returns the boolean result of `HashSet::insert`: `true` for a newly registered sync, `false` if one was already present.

**Call relations**: The background launcher uses this as its deduplication gate before spawning a sync task.

*Call graph*: called by 1 (maybe_start_remote_installed_plugin_bundle_sync).


##### `clear_remote_installed_plugin_bundle_sync_in_flight`  (lines 427–436)

```
fn clear_remote_installed_plugin_bundle_sync_in_flight(key: &RemoteInstalledPluginBundleSyncKey)
```

**Purpose**: Removes a previously registered sync-in-flight marker for a cache root.

**Data flow**: It returns immediately if the global sync set was never initialized; otherwise it locks the set and removes the provided key. No value is returned.

**Call relations**: The background launcher calls this in the spawned task’s tail path, and the unit test uses it to verify deduplication resets correctly after completion.

*Call graph*: called by 2 (maybe_start_remote_installed_plugin_bundle_sync, remote_installed_plugin_sync_in_flight_dedupes_by_cache_root).


##### `tests::remote_installed_plugin_sync_in_flight_dedupes_by_cache_root`  (lines 444–462)

```
fn remote_installed_plugin_sync_in_flight_dedupes_by_cache_root()
```

**Purpose**: Verifies that sync deduplication is keyed by plugin cache root and that clearing the marker allows a later sync to start.

**Data flow**: The test creates a temporary Codex home, derives a sync key from `remote_plugin_cache_root`, calls `mark_remote_installed_plugin_bundle_sync_in_flight` twice to observe `true` then `false`, clears the key, and confirms insertion succeeds again. It mutates only the in-memory sync set.

**Call relations**: This test exercises the pairing of `mark_remote_installed_plugin_bundle_sync_in_flight` and `clear_remote_installed_plugin_bundle_sync_in_flight` without involving the async sync body.

*Call graph*: calls 2 internal fn (clear_remote_installed_plugin_bundle_sync_in_flight, remote_plugin_cache_root); 2 external calls (assert!, tempdir).


##### `tests::stale_remote_plugin_cleanup_skips_cache_mutations_in_progress`  (lines 465–531)

```
fn stale_remote_plugin_cleanup_skips_cache_mutations_in_progress()
```

**Purpose**: Checks that stale-cache cleanup does not remove a plugin cache entry while one or more mutation guards for that entry are still alive.

**Data flow**: It creates a temporary cached plugin manifest under the global remote marketplace, builds an installed-name map that leaves the plugin stale, acquires two guards with `mark_remote_plugin_cache_mutation_in_flight`, runs `remove_stale_remote_plugin_caches` after dropping zero, one, and then both guards, and asserts that removal happens only after the final guard is dropped. It writes and later observes filesystem state under the temp directory.

**Call relations**: This test validates the interaction between `mark_remote_plugin_cache_mutation_in_flight`, `RemotePluginCacheMutationGuard::drop`, and `remove_stale_remote_plugin_caches`.

*Call graph*: calls 2 internal fn (mark_remote_plugin_cache_mutation_in_flight, remove_stale_remote_plugin_caches); 7 external calls (from_iter, new, assert!, assert_eq!, create_dir_all, write, tempdir).


##### `tests::stale_remote_plugin_cleanup_removes_stale_marketplace_caches_and_keeps_canonical_cache`  (lines 534–620)

```
fn stale_remote_plugin_cleanup_removes_stale_marketplace_caches_and_keeps_canonical_cache()
```

**Purpose**: Verifies that cleanup removes stale caches from remote marketplaces that no longer contain installed plugins while preserving the canonical shared-with-me cache entry that is still installed.

**Data flow**: It creates cached manifests in `created-by-me`, `workspace-shared-with-me-private`, and canonical `workspace-shared-with-me` marketplace directories, constructs an installed-name map containing only the canonical shared plugin, runs `remove_stale_remote_plugin_caches`, and asserts that only the stale non-canonical entries are deleted and reported. The test mutates temporary filesystem contents and inspects the resulting files.

**Call relations**: This test directly exercises `remove_stale_remote_plugin_caches`’ marketplace iteration and installed-name filtering logic.

*Call graph*: calls 1 internal fn (remove_stale_remote_plugin_caches); 8 external calls (from_iter, from, new, assert!, assert_eq!, create_dir_all, write, tempdir).


### `core-plugins/src/remote.rs`

`io_transport` · `remote catalog fetch, plugin detail reads, install/uninstall, cache refresh`

This is the main remote-plugin integration layer. It defines the public data types used by callers—`RemoteMarketplace`, `RemotePluginSummary`, `RemotePluginDetail`, `RemoteInstalledPlugin`, recommendation models, share context, and the `RemotePluginCatalogError` enum—and a large set of helpers for fetching and normalizing backend responses. The code distinguishes remote scopes (`Global`, `User`, `Workspace`) and maps them onto synthetic marketplace names and display names, including special workspace buckets for directly shared and unlisted plugins.

Most public entrypoints begin by requiring ChatGPT-backed auth via `ensure_chatgpt_auth`, then build authenticated `reqwest` requests with a fixed timeout and `OAI-Product-Sku: codex` header. List endpoints are paginated; helper loops repeatedly call page fetchers until `next_page_token` is absent. `fetch_remote_marketplaces` is the highest-level aggregator: it optionally uses a cached global directory listing, fetches installed plugins where needed, partitions workspace plugins into directory/shared/unlisted marketplaces, and merges directory and installed state through `build_remote_marketplace`. Detail fetches retrieve one plugin, infer its canonical marketplace from backend scope/discoverability, fetch installed state for skill enablement, derive app declarations and MCP servers, and build a rich `RemotePluginDetail`.

The file also normalizes backend text fields (`non_empty_string`), trims and caps default prompts, validates remote plugin IDs, converts release/interface payloads into app-server protocol structs, groups cached installed plugins by marketplace display order, and removes local cache entries after uninstall. Several design choices are subtle: caller-supplied marketplace names are intentionally not trusted for detail/install/uninstall because remote plugin IDs are globally unique; malformed cached or recommended entries are skipped rather than failing the whole response; and workspace discoverability is mandatory for workspace-scoped plugins.

#### Function details

##### `is_valid_remote_plugin_id`  (lines 258–263)

```
fn is_valid_remote_plugin_id(plugin_id: &str) -> bool
```

**Purpose**: Checks whether a remote plugin ID contains only the allowed ASCII characters. It enforces the backend-facing identifier format.

**Data flow**: Reads the input string, returns `false` if empty, otherwise verifies every character is ASCII alphanumeric or one of `-`, `_`, `~`, and returns the boolean result.

**Call relations**: Used by request validators and recommendation/share response handling to reject malformed remote IDs before they propagate.

*Call graph*: called by 7 (plugin_share_checkout_response, plugin_share_delete_response, plugin_share_save_response, plugin_share_update_targets_response, plugin_uninstall_response, recommended_plugins_mode, validate_remote_plugin_id).


##### `validate_remote_plugin_id`  (lines 265–277)

```
fn validate_remote_plugin_id(plugin_id: &str) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Validates a remote plugin ID and converts failures into a JSON-RPC invalid-request error. It is the API-facing wrapper around the raw predicate.

**Data flow**: Takes `&str`, calls `is_valid_remote_plugin_id`, returns `Ok(())` on success, or constructs `JSONRPCErrorError` with code `-32600`, a fixed message, and `data: None` on failure.

**Call relations**: Called by RPC response handlers before invoking remote install/uninstall/detail operations.

*Call graph*: calls 1 internal fn (is_valid_remote_plugin_id); called by 4 (plugin_read_response, plugin_skill_read_response, remote_plugin_install_response, remote_plugin_uninstall_response).


##### `RemotePluginScope::api_value`  (lines 383–389)

```
fn api_value(self) -> &'static str
```

**Purpose**: Maps an internal remote scope enum to the exact uppercase string expected by backend query parameters. It is the wire-format representation of scope.

**Data flow**: Matches `self` and returns one of the static strings `GLOBAL`, `USER`, or `WORKSPACE`.

**Call relations**: Used by list and installed-page request builders when constructing query parameters.

*Call graph*: called by 2 (get_remote_plugin_installed_page, get_remote_plugin_list_page).


##### `RemotePluginScope::marketplace_name`  (lines 391–397)

```
fn marketplace_name(self) -> &'static str
```

**Purpose**: Maps a remote scope to the synthetic local marketplace name used for that scope's primary marketplace bucket. It defines the canonical names used in config IDs.

**Data flow**: Matches `self` and returns one of the corresponding marketplace-name constants.

**Call relations**: Used when building marketplace responses from fetched directory and installed plugin lists.


##### `RemotePluginScope::marketplace_display_name`  (lines 399–405)

```
fn marketplace_display_name(self) -> &'static str
```

**Purpose**: Maps a remote scope to the human-facing display name for its primary marketplace bucket. It centralizes display naming for detail and list responses.

**Data flow**: Matches `self` and returns one of the display-name constants.

**Call relations**: Used by `build_remote_plugin_detail` and marketplace-building code to label scope-derived marketplaces.

*Call graph*: called by 1 (build_remote_plugin_detail).


##### `RemotePluginScope::from_marketplace_name`  (lines 407–417)

```
fn from_marketplace_name(name: &str) -> Option<Self>
```

**Purpose**: Converts a marketplace name string back into a remote scope when that marketplace is supported by the remote backend. Workspace shared/unlisted aliases all map to `Workspace`.

**Data flow**: Matches the input name against known marketplace constants and returns `Some(RemotePluginScope)` or `None` for unsupported names.

**Call relations**: Used by `fetch_remote_plugin_skill_detail` to reject unsupported marketplace names before making a backend request.

*Call graph*: called by 1 (fetch_remote_plugin_skill_detail).


##### `remote_plugin_canonical_marketplace_name`  (lines 539–553)

```
fn remote_plugin_canonical_marketplace_name(
    plugin: &RemotePluginDirectoryItem,
) -> Result<&'static str, RemotePluginCatalogError>
```

**Purpose**: Determines the canonical synthetic marketplace name for a backend plugin item based on its scope and, for workspace plugins, its discoverability. It is the source of truth for marketplace assignment.

**Data flow**: Reads a `RemotePluginDirectoryItem`, matches on `plugin.scope`, returns the global or user marketplace constant directly, or for workspace scope calls `workspace_plugin_discoverability` and maps `Listed` to the workspace directory marketplace and `Private`/`Unlisted` to the shared-with-me marketplace.

**Call relations**: Called whenever a backend plugin item must be turned into a local config ID, summary, installed-cache entry, or canonical marketplace for detail/uninstall flows.

*Call graph*: calls 1 internal fn (workspace_plugin_discoverability); called by 5 (build_remote_plugin_summary, fetch_remote_plugin_detail_with_download_url_option, remote_discoverable_plugin_from_directory_item, remote_installed_plugin_to_cache_entry, uninstall_remote_plugin).


##### `workspace_plugin_discoverability`  (lines 555–564)

```
fn workspace_plugin_discoverability(
    plugin: &RemotePluginDirectoryItem,
) -> Result<RemotePluginShareDiscoverability, RemotePluginCatalogError>
```

**Purpose**: Extracts discoverability from a workspace plugin item and errors if the backend omitted it. This enforces an invariant required for workspace marketplace partitioning.

**Data flow**: Reads `plugin.discoverability` and returns it if present; otherwise returns `RemotePluginCatalogError::UnexpectedResponse` naming the plugin ID.

**Call relations**: Used by canonical marketplace assignment and share-context construction for workspace-scoped plugins.

*Call graph*: called by 2 (remote_plugin_canonical_marketplace_name, remote_plugin_share_context).


##### `fetch_remote_marketplaces`  (lines 633–794)

```
async fn fetch_remote_marketplaces(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
    sources: &[RemoteMarketplaceSource],
    global_catalog_cache_path: Option<&Path>,
) -> Re
```

**Purpose**: Fetches one or more remote marketplace views, merging directory listings, installed state, cache, and workspace sharing buckets into `RemoteMarketplace` values. It is the top-level remote catalog listing API.

**Data flow**: Inputs are service config, optional auth, requested `RemoteMarketplaceSource` slice, and optional global cache path. It first requires ChatGPT auth, determines whether workspace installed plugins are needed, and fetches them once if so. It then iterates requested sources: for `Global`, it optionally loads cached directory plugins and otherwise fetches directory and installed plugins concurrently, builds a marketplace, and may write the directory list back to cache; for `CreatedByMeRemote`, it fetches user-scope directory and installed plugins concurrently and builds a marketplace; for `WorkspaceDirectory`, it fetches workspace directory plugins and merges them with the previously fetched workspace installed list; for `SharedWithMe`, it fetches shared workspace plugins, partitions directly shared private/unlisted plugins into one marketplace, then derives a separate unlisted-installed-only marketplace for installed unlisted plugins not present in the shared endpoint. It returns the collected marketplaces or the first encountered error.

**Call relations**: Called by higher-level plugin list RPC code. It delegates network pagination to the scope-specific fetch helpers, cache reads/writes to `catalog_cache`, and summary merging to `build_remote_marketplace`.

*Call graph*: calls 7 internal fn (build_remote_marketplace, load_cached_global_directory_plugins, write_cached_global_directory_plugins, ensure_chatgpt_auth, fetch_directory_plugins_for_scope, fetch_installed_plugins_for_scope, fetch_shared_workspace_plugins); called by 1 (plugin_list_response); 3 external calls (new, iter, try_join!).


##### `fetch_and_cache_global_remote_plugin_catalog`  (lines 796–806)

```
async fn fetch_and_cache_global_remote_plugin_catalog(
    codex_home: &Path,
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
) -> Result<(), RemotePluginCatalogError>
```

**Purpose**: Refreshes the cached global remote directory listing without returning marketplace data. It is used by background cache warmers and startup tasks.

**Data flow**: Requires ChatGPT auth, fetches global-scope directory plugins via `fetch_directory_plugins_for_scope`, writes them to the global catalog cache, and returns `Ok(())` or a catalog error.

**Call relations**: Invoked by startup/background refresh code. It is a specialized subset of `fetch_remote_marketplaces` focused only on the global directory cache.

*Call graph*: calls 3 internal fn (write_cached_global_directory_plugins, ensure_chatgpt_auth, fetch_directory_plugins_for_scope); called by 4 (expands_cached_remote_plugins_by_loaded_apps, maybe_start_plugin_startup_tasks_for_config, run_global_remote_catalog_cache_refresh_loop, list_tool_suggest_discoverable_plugins_includes_cached_remote_global_plugins).


##### `fetch_recommended_plugins`  (lines 808–821)

```
async fn fetch_recommended_plugins(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
) -> Result<RecommendedPluginsMode, RemotePluginCatalogError>
```

**Purpose**: Calls the backend suggested-plugins endpoint and converts the response into either legacy mode or a validated endpoint-driven recommendation list. It is the public recommendation fetch API.

**Data flow**: Requires ChatGPT auth, builds the `/ps/plugins/suggested` URL from `chatgpt_base_url`, creates a reqwest client, builds an authenticated GET request with a shorter timeout and `scope=GLOBAL`, decodes `RecommendedPluginsResponse` via `send_and_decode`, then returns `recommended_plugins_mode(response)`.

**Call relations**: Called by recommendation-serving code. It delegates auth/header setup to `authenticated_request`, HTTP/JSON handling to `send_and_decode`, and response shaping/filtering to `recommended_plugins_mode`.

*Call graph*: calls 5 internal fn (authenticated_request, ensure_chatgpt_auth, recommended_plugins_mode, send_and_decode, build_reqwest_client); 1 external calls (format!).


##### `recommended_plugins_mode`  (lines 823–886)

```
fn recommended_plugins_mode(response: RecommendedPluginsResponse) -> RecommendedPluginsMode
```

**Purpose**: Normalizes and filters the backend recommendation payload into either `Legacy` mode or a bounded list of valid `RecommendedPlugin` entries. It aggressively drops malformed or unsupported recommendations.

**Data flow**: Consumes `RecommendedPluginsResponse`. If `enabled != Some(true)`, it returns `RecommendedPluginsMode::Legacy`. Otherwise it iterates response plugins, skipping entries with invalid remote IDs, overlong names, unavailable status, or non-available install policy. For each remaining item it constructs a `PluginId` in the global remote marketplace, warning and skipping invalid plugin names, normalizes the display name with `non_empty_string` and length truncation, deduplicates non-empty app IDs, and inserts the first entry per config ID into a `BTreeMap`. Finally it returns `Endpoint { plugins }` from the map values, capped at `MAX_RECOMMENDED_PLUGINS`.

**Call relations**: Used only by `fetch_recommended_plugins` after the raw endpoint response is decoded.

*Call graph*: calls 3 internal fn (is_valid_remote_plugin_id, non_empty_string, new); called by 1 (fetch_recommended_plugins); 3 external calls (new, new, warn!).


##### `has_cached_global_remote_plugin_catalog`  (lines 888–897)

```
fn has_cached_global_remote_plugin_catalog(
    codex_home: &Path,
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
) -> bool
```

**Purpose**: Reports whether a usable cached global remote directory listing exists for the current auth/config combination. It is a cheap cache-presence probe.

**Data flow**: Attempts `ensure_chatgpt_auth`; on failure returns `false`. On success it calls `catalog_cache::load_cached_global_directory_plugins` and returns whether the result is `Some`.

**Call relations**: Called by plugin-listing code to decide whether cached remote catalog data is available before making network requests.

*Call graph*: calls 2 internal fn (load_cached_global_directory_plugins, ensure_chatgpt_auth); called by 1 (plugin_list_response).


##### `cached_global_remote_discoverable_plugins`  (lines 899–915)

```
fn cached_global_remote_discoverable_plugins(
    codex_home: &Path,
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
) -> Vec<RemoteDiscoverablePlugin>
```

**Purpose**: Loads cached global directory plugins and converts them into lightweight discoverable-plugin records for suggestion surfaces. Invalid cached entries are skipped with warnings.

**Data flow**: Reads cached global directory plugins from `catalog_cache`, defaults to an empty vector if absent, then `filter_map`s each `RemotePluginDirectoryItem` through `remote_discoverable_plugin_from_directory_item`. Successful conversions are collected; conversion errors trigger a warning and are dropped.

**Call relations**: Used by higher-level suggestion code that wants discoverable remote plugins without hitting the network.

*Call graph*: calls 1 internal fn (load_cached_global_directory_plugins); called by 1 (cached_global_remote_discoverable_plugins_for_config).


##### `fetch_openai_curated_remote_collection_marketplace`  (lines 917–940)

```
async fn fetch_openai_curated_remote_collection_marketplace(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
) -> Result<Option<RemoteMarketplace>, RemotePluginCatalogError>
```

**Purpose**: Fetches the global remote marketplace restricted to the curated collection key and merges it with installed state. It is a specialized marketplace listing for one backend collection.

**Data flow**: Requires ChatGPT auth, sets scope to `Global`, concurrently fetches directory plugins for the `vertical` collection and installed plugins for the same scope, then passes both into `build_remote_marketplace` with the global marketplace name/display name and `include_installed_only = false`.

**Call relations**: Called by plugin-listing code when it needs the curated collection view rather than the full global marketplace.

*Call graph*: calls 2 internal fn (build_remote_marketplace, ensure_chatgpt_auth); called by 1 (plugin_list_response); 1 external calls (try_join!).


##### `build_remote_marketplace`  (lines 942–977)

```
fn build_remote_marketplace(
    name: &str,
    display_name: &str,
    directory_plugins: Vec<RemotePluginDirectoryItem>,
    installed_plugins: Vec<RemotePluginInstalledItem>,
    include_installed
```

**Purpose**: Merges directory-listed plugins with installed-plugin state into one `RemoteMarketplace`, optionally including installed-only plugins not present in the directory list. It is the common join step for all marketplace fetch paths.

**Data flow**: Consumes a marketplace name/display name, a vector of `RemotePluginDirectoryItem`, a vector of `RemotePluginInstalledItem`, and a boolean. It indexes installed plugins by remote plugin ID in a `BTreeMap`, maps each directory plugin to a `RemotePluginSummary` while removing any matching installed entry, optionally appends summaries for remaining installed-only plugins, returns `Ok(None)` if the final plugin list is empty, otherwise returns `Some(RemoteMarketplace { ... })`.

**Call relations**: Used by `fetch_remote_marketplaces` and `fetch_openai_curated_remote_collection_marketplace` after raw fetches complete. It delegates per-plugin shaping to `build_remote_plugin_summary`.

*Call graph*: called by 2 (fetch_openai_curated_remote_collection_marketplace, fetch_remote_marketplaces).


##### `fetch_remote_installed_plugins`  (lines 979–1012)

```
async fn fetch_remote_installed_plugins(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
) -> Result<Vec<RemoteInstalledPlugin>, RemotePluginCatalogError>
```

**Purpose**: Fetches installed remote plugins across global, workspace, and user scopes and converts them into cache-friendly entries sorted by marketplace and plugin ID. It is the installed-state aggregation API.

**Data flow**: Requires ChatGPT auth, concurrently fetches installed plugins for `Global`, `Workspace`, and `User`, flattens the resulting vectors, converts each `RemotePluginInstalledItem` with `remote_installed_plugin_to_cache_entry`, sorts the final `Vec<RemoteInstalledPlugin>` by `marketplace_name` then `id`, and returns it.

**Call relations**: Called by cache refresh code for installed remote plugins. It delegates per-scope pagination to `fetch_installed_plugins_for_scope` and per-item shaping to `remote_installed_plugin_to_cache_entry`.

*Call graph*: calls 2 internal fn (ensure_chatgpt_auth, fetch_installed_plugins_for_scope); called by 2 (build_and_cache_remote_installed_plugin_marketplaces, run_remote_installed_plugins_cache_refresh_loop); 1 external calls (try_join!).


##### `group_remote_installed_plugins_by_marketplaces`  (lines 1014–1059)

```
fn group_remote_installed_plugins_by_marketplaces(
    plugins: &[RemoteInstalledPlugin],
    visible_marketplaces: &[&str],
) -> Vec<RemoteMarketplace>
```

**Purpose**: Groups cached installed remote plugins into marketplace-shaped buckets in a fixed display order. It is used to reconstruct marketplace views from installed-plugin cache entries.

**Data flow**: Takes a slice of `RemoteInstalledPlugin` and a whitelist of visible marketplace names. It filters plugins to visible marketplaces, attempts to build a `PluginId` from each plugin's name and marketplace name, skips invalid names, converts each into a `RemotePluginSummary` marked installed/enabled with no share context, groups them in a `BTreeMap<String, Vec<_>>`, then emits `RemoteMarketplace` values following `REMOTE_INSTALLED_MARKETPLACE_DISPLAY_ORDER`, sorting each marketplace's plugins by display name with `sort_remote_plugin_summaries_by_display_name`.

**Call relations**: Used by installed-plugin cache builders to present cached installed state in the same marketplace-oriented shape as live fetches.

*Call graph*: calls 1 internal fn (new); called by 2 (build_and_cache_remote_installed_plugin_marketplaces, build_remote_installed_plugin_marketplaces_from_cache); 1 external calls (new).


##### `fetch_remote_plugin_detail`  (lines 1061–1075)

```
async fn fetch_remote_plugin_detail(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
    marketplace_name: &str,
    plugin_id: &str,
) -> Result<RemotePluginDetail, RemotePlugin
```

**Purpose**: Fetches a remote plugin detail view without download URLs. It is the standard detail-read entrypoint.

**Data flow**: Passes its inputs through to `fetch_remote_plugin_detail_with_download_url_option` with `include_download_urls = false` and returns the resulting `RemotePluginDetail`.

**Call relations**: Called by plugin-read RPC code. It is a thin convenience wrapper over the more general detail helper.

*Call graph*: calls 1 internal fn (fetch_remote_plugin_detail_with_download_url_option); called by 1 (plugin_read_response).


##### `fetch_remote_plugin_share_context`  (lines 1077–1088)

```
async fn fetch_remote_plugin_share_context(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
    plugin_id: &str,
) -> Result<Option<RemotePluginShareContext>, RemotePluginCatalog
```

**Purpose**: Fetches just the share-context metadata for a remote plugin. It is a lightweight detail path focused on workspace sharing information.

**Data flow**: Requires ChatGPT auth, fetches the plugin detail payload with `fetch_plugin_detail` excluding download URLs, then converts the resulting `RemotePluginDirectoryItem` with `remote_plugin_share_context` and returns the optional share context.

**Call relations**: Called by plugin-read RPC code when only sharing metadata is needed. It reuses the same backend detail endpoint as full detail fetches.

*Call graph*: calls 3 internal fn (ensure_chatgpt_auth, fetch_plugin_detail, remote_plugin_share_context); called by 1 (plugin_read_response).


##### `fetch_remote_plugin_detail_with_download_urls`  (lines 1090–1104)

```
async fn fetch_remote_plugin_detail_with_download_urls(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
    marketplace_name: &str,
    plugin_id: &str,
) -> Result<RemotePluginD
```

**Purpose**: Fetches a remote plugin detail view including bundle download URLs when the backend provides them. It is used by flows that need downloadable bundle metadata.

**Data flow**: Delegates to `fetch_remote_plugin_detail_with_download_url_option` with `include_download_urls = true` and returns the resulting detail struct.

**Call relations**: Called by install-related response code that needs download URLs after installation.

*Call graph*: calls 1 internal fn (fetch_remote_plugin_detail_with_download_url_option); called by 1 (remote_plugin_install_response).


##### `fetch_remote_plugin_skill_detail`  (lines 1106–1140)

```
async fn fetch_remote_plugin_skill_detail(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
    marketplace_name: &str,
    plugin_id: &str,
    skill_name: &str,
) -> Result<Remo
```

**Purpose**: Fetches the markdown/detail payload for one remote plugin skill and validates that the backend echoed the expected plugin ID and skill name. It is the skill-detail read API.

**Data flow**: Requires ChatGPT auth, rejects unsupported marketplace names by checking `RemotePluginScope::from_marketplace_name`, builds the skill-detail URL with `remote_plugin_skill_detail_url`, creates an authenticated GET request, decodes `RemotePluginSkillDetailResponse`, verifies `response.plugin_id == plugin_id` and `response.name == skill_name`, and returns `RemotePluginSkillDetail { contents }` or an `UnexpectedPluginId` / `UnexpectedSkillName` error.

**Call relations**: Called by plugin-skill read RPC code. It uses marketplace-name validation only as a supported-scope gate; the backend response remains the source of truth for the actual plugin.

*Call graph*: calls 6 internal fn (from_marketplace_name, authenticated_request, ensure_chatgpt_auth, remote_plugin_skill_detail_url, send_and_decode, build_reqwest_client); called by 1 (plugin_skill_read_response).


##### `fetch_remote_plugin_detail_with_download_url_option`  (lines 1142–1158)

```
async fn fetch_remote_plugin_detail_with_download_url_option(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
    _marketplace_name: &str,
    plugin_id: &str,
    include_downlo
```

**Purpose**: Shared implementation for remote plugin detail fetches with or without download URLs. It trusts the backend plugin ID response over the caller-provided marketplace name.

**Data flow**: Requires ChatGPT auth, fetches a `RemotePluginDirectoryItem` with `fetch_plugin_detail`, reads its `scope`, derives the canonical marketplace name with `remote_plugin_canonical_marketplace_name`, and passes config, auth, scope, canonical marketplace name, plugin ID, and the fetched plugin into `build_remote_plugin_detail`.

**Call relations**: Called by both public detail wrappers. It centralizes the rule that caller-supplied marketplace names are not validated because remote plugin IDs are globally unique.

*Call graph*: calls 4 internal fn (build_remote_plugin_detail, ensure_chatgpt_auth, fetch_plugin_detail, remote_plugin_canonical_marketplace_name); called by 2 (fetch_remote_plugin_detail, fetch_remote_plugin_detail_with_download_urls).


##### `build_remote_plugin_detail`  (lines 1160–1252)

```
async fn build_remote_plugin_detail(
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
    scope: RemotePluginScope,
    marketplace_name: String,
    plugin_id: &str,
    plugin: RemotePl
```

**Purpose**: Builds a rich `RemotePluginDetail` from one backend plugin item plus current installed state for its scope. It computes skill enablement, app IDs, app templates, MCP servers, and summary/interface fields.

**Data flow**: Inputs are config, auth, scope, canonical marketplace name, plugin ID, and a `RemotePluginDirectoryItem`. It fetches installed plugins for the same scope and finds the matching installed item by remote plugin ID, derives a `HashSet` of disabled skill names, maps release skills into `RemotePluginSkill` values with optional `SkillInterface` and enabled flags, derives app declarations either from `release.app_manifest` via `plugin_app_declarations_from_value` or from raw `release.app_ids` via `app_declarations_from_remote_app_ids`, builds an MCP-server map from `release.mcp_servers`, applies `apply_app_mcp_routing_policy` using the auth mode and active-plugin flag, extracts sorted/deduped app IDs and MCP server keys, and returns `RemotePluginDetail` containing marketplace labels, `build_remote_plugin_summary(...)`, share URL, normalized description, release version, optional bundle download URL, app manifest, skills, app templates, and MCP servers.

**Call relations**: Called only by `fetch_remote_plugin_detail_with_download_url_option` after the raw plugin detail payload is fetched. It delegates summary shaping to `build_remote_plugin_summary` and several normalization steps to helper functions.

*Call graph*: calls 6 internal fn (apply_app_mcp_routing_policy, marketplace_display_name, build_remote_plugin_summary, fetch_installed_plugins_for_scope, non_empty_string, api_auth_mode); called by 1 (fetch_remote_plugin_detail_with_download_url_option); 1 external calls (app_connector_ids_from_declarations).


##### `app_declarations_from_remote_app_ids`  (lines 1254–1263)

```
fn app_declarations_from_remote_app_ids(app_ids: &[String]) -> Vec<AppDeclaration>
```

**Purpose**: Synthesizes minimal `AppDeclaration` values from raw remote app IDs when no structured app manifest is present. It preserves connector identity while leaving category unset.

**Data flow**: Maps each `String` app ID in the input slice into `AppDeclaration { name, connector_id: AppConnectorId(name), category: None }` and returns the collected vector.

**Call relations**: Used by `build_remote_plugin_detail` as the fallback when `release.app_manifest` is absent.


##### `install_remote_plugin`  (lines 1265–1302)

```
async fn install_remote_plugin(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
    _marketplace_name: &str,
    plugin_id: &str,
) -> Result<RemotePluginInstallResult, RemotePlu
```

**Purpose**: Sends the remote install mutation for a plugin and validates that the backend response reports the expected plugin ID and enabled state. It returns any app IDs that still need auth.

**Data flow**: Requires ChatGPT auth, builds the `/ps/plugins/{plugin_id}/install` URL, creates an authenticated POST request with `includeAppsNeedingAuth=true`, decodes `RemotePluginMutationResponse`, checks that `response.id` matches the requested plugin ID and `response.enabled` is true, then returns `RemotePluginInstallResult { app_ids_needing_auth }`.

**Call relations**: Called by install RPC code after request validation. It intentionally ignores the caller-provided marketplace name because remote plugin IDs are globally unique.

*Call graph*: calls 4 internal fn (authenticated_request, ensure_chatgpt_auth, send_and_decode, build_reqwest_client); called by 1 (remote_plugin_install_response); 1 external calls (format!).


##### `uninstall_remote_plugin`  (lines 1304–1350)

```
async fn uninstall_remote_plugin(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
    codex_home: PathBuf,
    plugin_id: &str,
) -> Result<(), RemotePluginCatalogError>
```

**Purpose**: Sends the remote uninstall mutation, validates the response, and removes any corresponding local cache entries for the plugin. It combines backend mutation with local cleanup.

**Data flow**: Requires ChatGPT auth, first fetches plugin detail to learn the canonical marketplace name and plugin name, builds the `/ps/plugins/{plugin_id}/uninstall` URL, sends an authenticated POST, decodes `RemotePluginMutationResponse`, verifies matching plugin ID and `enabled == false`, then spawns a blocking task that calls `remove_remote_plugin_cache(codex_home, marketplace_name, plugin_name, legacy_plugin_id)`. Join failures and cache-removal failures are mapped into `RemotePluginCatalogError::CacheRemove`.

**Call relations**: Called by uninstall RPC code. It delegates canonical marketplace derivation to `remote_plugin_canonical_marketplace_name` via `fetch_plugin_detail`, and filesystem cleanup to `remove_remote_plugin_cache`.

*Call graph*: calls 6 internal fn (authenticated_request, ensure_chatgpt_auth, fetch_plugin_detail, remote_plugin_canonical_marketplace_name, send_and_decode, build_reqwest_client); called by 1 (remote_plugin_uninstall_response); 2 external calls (format!, spawn_blocking).


##### `remove_remote_plugin_cache`  (lines 1352–1394)

```
fn remove_remote_plugin_cache(
    codex_home: PathBuf,
    marketplace_name: String,
    plugin_name: String,
    legacy_plugin_id: String,
) -> Result<(), String>
```

**Purpose**: Deletes local cached plugin data for an uninstalled remote plugin, including both the current `PluginStore` location and a legacy cache path if different. It is the blocking filesystem cleanup step after uninstall.

**Data flow**: Takes owned `codex_home`, marketplace name, plugin name, and legacy remote plugin ID. It constructs a `PluginStore`, builds a `PluginId` from plugin name and marketplace name, computes the current cache root, calls `store.uninstall(&plugin_id)`, then computes the legacy cache path under `PLUGINS_CACHE_DIR/<marketplace>/<legacy_plugin_id>`. If the legacy path differs from the current cache root and exists, it removes it with `remove_dir_all` or `remove_file` depending on file type. Any failure becomes a descriptive `Err(String)`.

**Call relations**: Called inside `tokio::task::spawn_blocking` by `uninstall_remote_plugin` so synchronous filesystem deletion does not block the async runtime.

*Call graph*: calls 2 internal fn (try_new, new); 4 external calls (clone, join, remove_dir_all, remove_file).


##### `build_remote_plugin_summary`  (lines 1396–1421)

```
fn build_remote_plugin_summary(
    plugin: &RemotePluginDirectoryItem,
    installed_plugin: Option<&RemotePluginInstalledItem>,
) -> Result<RemotePluginSummary, RemotePluginCatalogError>
```

**Purpose**: Converts one backend plugin item plus optional installed state into the compact summary shape used in marketplace listings and detail headers. It computes config ID, share context, install flags, and interface metadata.

**Data flow**: Reads a `RemotePluginDirectoryItem` and optional matching `RemotePluginInstalledItem`, derives the canonical marketplace name, constructs a `PluginId` from plugin name and marketplace, converts invalid names into `UnexpectedResponse`, computes `share_context` with `remote_plugin_share_context`, sets `installed` and `enabled` from the optional installed item, copies install/auth/availability fields, converts interface metadata with `remote_plugin_interface_to_info`, clones keywords, and returns `RemotePluginSummary`.

**Call relations**: Used by `build_remote_marketplace` for list views and by `build_remote_plugin_detail` for the detail summary section.

*Call graph*: calls 4 internal fn (remote_plugin_canonical_marketplace_name, remote_plugin_interface_to_info, remote_plugin_share_context, new); called by 1 (build_remote_plugin_detail).


##### `remote_discoverable_plugin_from_directory_item`  (lines 1423–1449)

```
fn remote_discoverable_plugin_from_directory_item(
    plugin: &RemotePluginDirectoryItem,
) -> Result<RemoteDiscoverablePlugin, RemotePluginCatalogError>
```

**Purpose**: Converts a backend directory item into a lightweight discoverable-plugin record for recommendation and suggestion surfaces. It keeps only fields relevant to discovery.

**Data flow**: Derives the canonical marketplace name, constructs a `PluginId`, normalizes the display name from `release.display_name` or falls back to `plugin.name`, derives a description from interface short description or release description using `non_empty_string`, computes `has_skills`, clones app IDs, install policy, and availability, and returns `RemoteDiscoverablePlugin`.

**Call relations**: Used by `cached_global_remote_discoverable_plugins` when turning cached directory entries into suggestion candidates.

*Call graph*: calls 3 internal fn (non_empty_string, remote_plugin_canonical_marketplace_name, new).


##### `remote_plugin_share_context`  (lines 1451–1479)

```
fn remote_plugin_share_context(
    plugin: &RemotePluginDirectoryItem,
) -> Result<Option<RemotePluginShareContext>, RemotePluginCatalogError>
```

**Purpose**: Builds workspace sharing metadata for a remote plugin when applicable. Global and user-scoped plugins have no share context.

**Data flow**: Matches on `plugin.scope`. For `Global` and `User`, returns `Ok(None)`. For `Workspace`, it requires discoverability via `workspace_plugin_discoverability`, then returns `Some(RemotePluginShareContext)` containing remote plugin ID, optional release version, discoverability, share URL, creator fields, and mapped share principals.

**Call relations**: Called by `build_remote_plugin_summary` and `fetch_remote_plugin_share_context` whenever workspace sharing information needs to be exposed.

*Call graph*: calls 1 internal fn (workspace_plugin_discoverability); called by 2 (build_remote_plugin_summary, fetch_remote_plugin_share_context).


##### `remote_installed_plugin_to_cache_entry`  (lines 1481–1499)

```
fn remote_installed_plugin_to_cache_entry(
    installed_plugin: &RemotePluginInstalledItem,
) -> Result<RemoteInstalledPlugin, RemotePluginCatalogError>
```

**Purpose**: Converts an installed-plugin backend item into the cacheable installed-plugin shape used by local refresh loops. It intentionally ignores per-skill disabled state at this layer.

**Data flow**: Reads the embedded `plugin` from `RemotePluginInstalledItem`, derives the canonical marketplace name, copies remote plugin ID, plugin name, enabled flag, install/auth/availability fields, converts interface metadata with `remote_plugin_interface_to_info`, clones keywords, and returns `RemoteInstalledPlugin`.

**Call relations**: Used by `fetch_remote_installed_plugins` after per-scope installed lists are fetched.

*Call graph*: calls 2 internal fn (remote_plugin_canonical_marketplace_name, remote_plugin_interface_to_info).


##### `remote_plugin_interface_to_info`  (lines 1501–1549)

```
fn remote_plugin_interface_to_info(plugin: &RemotePluginDirectoryItem) -> Option<PluginInterface>
```

**Purpose**: Converts a backend release interface payload into the app-server `PluginInterface` shape, normalizing empty strings and default prompts. It returns `None` when the interface would be entirely empty.

**Data flow**: Reads `plugin.release.interface` and `plugin.release.display_name`, normalizes display name with `non_empty_string`, computes `default_prompt` by preferring `default_prompts` normalized through `normalize_remote_default_prompts` and otherwise a single `default_prompt` normalized through `normalize_remote_default_prompt`, then constructs `PluginInterface` with textual fields and remote URL fields while leaving local asset paths `None`. It checks whether any field is populated and returns `Some(interface)` only if at least one field is present.

**Call relations**: Used by both `build_remote_plugin_summary` and `remote_installed_plugin_to_cache_entry` to expose interface metadata consistently.

*Call graph*: calls 1 internal fn (non_empty_string); called by 2 (build_remote_plugin_summary, remote_installed_plugin_to_cache_entry); 1 external calls (new).


##### `remote_skill_interface_to_info`  (lines 1551–1569)

```
fn remote_skill_interface_to_info(
    interface: Option<RemotePluginSkillInterfaceResponse>,
) -> Option<SkillInterface>
```

**Purpose**: Converts an optional backend skill interface payload into the app-server `SkillInterface` shape. Empty skill interfaces collapse to `None`.

**Data flow**: If the input option is `Some`, it builds `SkillInterface` from display name, short description, brand color, and default prompt while leaving icon paths `None`, then returns `Some` only if at least one field is populated; otherwise it returns `None`.

**Call relations**: Used by `build_remote_plugin_detail` when shaping each remote skill.


##### `remote_plugin_display_name`  (lines 1571–1577)

```
fn remote_plugin_display_name(plugin: &RemotePluginSummary) -> &str
```

**Purpose**: Returns the best display label for a plugin summary, preferring interface display name over raw plugin name. It is a small sorting/display helper.

**Data flow**: Reads `plugin.interface.display_name` if present and non-`None`; otherwise returns `&plugin.name`.

**Call relations**: Used by `sort_remote_plugin_summaries_by_display_name` to compare plugins by user-facing label.


##### `sort_remote_plugin_summaries_by_display_name`  (lines 1579–1589)

```
fn sort_remote_plugin_summaries_by_display_name(plugins: &mut [RemotePluginSummary])
```

**Purpose**: Sorts plugin summaries case-insensitively by display name, then by exact display name, then by ID for stability. It produces deterministic marketplace ordering.

**Data flow**: Mutably borrows a slice of `RemotePluginSummary` and sorts it in place using `remote_plugin_display_name(left/right)`, comparing lowercase forms first, then original strings, then `id`.

**Call relations**: Called by `group_remote_installed_plugins_by_marketplaces` before emitting each marketplace bucket.

*Call graph*: 1 external calls (sort_by).


##### `non_empty_string`  (lines 1591–1596)

```
fn non_empty_string(value: Option<&str>) -> Option<String>
```

**Purpose**: Trims a string and returns it only if non-empty after trimming. It is a shared normalization helper for backend text fields.

**Data flow**: Takes `Option<&str>`, trims the contained string if present, and returns `Some(trimmed.to_string())` only when the trimmed value is not empty; otherwise returns `None`.

**Call relations**: Used across recommendation, detail, discoverable-plugin, and interface shaping code to suppress blank strings.

*Call graph*: called by 4 (build_remote_plugin_detail, recommended_plugins_mode, remote_discoverable_plugin_from_directory_item, remote_plugin_interface_to_info).


##### `normalize_remote_default_prompts`  (lines 1598–1605)

```
fn normalize_remote_default_prompts(prompts: &[String]) -> Option<Vec<String>>
```

**Purpose**: Normalizes a list of backend default prompts by trimming, filtering invalid entries, and capping the count. It enforces local limits on prompt metadata.

**Data flow**: Iterates the input prompt strings, applies `normalize_remote_default_prompt`, takes at most `MAX_REMOTE_DEFAULT_PROMPT_COUNT`, collects the surviving prompts into a vector, and returns `Some(vec)` only if non-empty.

**Call relations**: Used by `remote_plugin_interface_to_info` when the backend provides multiple default prompts.


##### `normalize_remote_default_prompt`  (lines 1607–1613)

```
fn normalize_remote_default_prompt(prompt: &str) -> Option<String>
```

**Purpose**: Validates and trims one backend default prompt. Empty or overlong prompts are discarded.

**Data flow**: Trims the input string, returns `None` if empty or if its character count exceeds `MAX_REMOTE_DEFAULT_PROMPT_LEN`, otherwise returns the trimmed prompt as `Some(String)`.

**Call relations**: Used by both `normalize_remote_default_prompts` and the single-prompt fallback branch in `remote_plugin_interface_to_info`.


##### `fetch_directory_plugins_for_scope`  (lines 1615–1624)

```
async fn fetch_directory_plugins_for_scope(
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
    scope: RemotePluginScope,
) -> Result<Vec<RemotePluginDirectoryItem>, RemotePluginCatalogE
```

**Purpose**: Fetches all directory-listed plugins for one scope without collection filtering. It is the common full-directory helper.

**Data flow**: Delegates to `fetch_directory_plugins_for_scope_with_optional_collection` with `collection = None` and returns the accumulated plugin vector.

**Call relations**: Called by global/user/workspace marketplace fetch paths and by the global catalog cache refresher.

*Call graph*: calls 1 internal fn (fetch_directory_plugins_for_scope_with_optional_collection); called by 2 (fetch_and_cache_global_remote_plugin_catalog, fetch_remote_marketplaces).


##### `fetch_directory_plugins_for_scope_with_collection`  (lines 1626–1639)

```
async fn fetch_directory_plugins_for_scope_with_collection(
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
    scope: RemotePluginScope,
    collection: &str,
) -> Result<Vec<RemotePlug
```

**Purpose**: Fetches all directory-listed plugins for one scope restricted to a named collection. It is used for curated subsets of the global catalog.

**Data flow**: Delegates to `fetch_directory_plugins_for_scope_with_optional_collection` with `Some(collection)` and returns the accumulated plugin vector.

**Call relations**: Used by `fetch_openai_curated_remote_collection_marketplace`.

*Call graph*: calls 1 internal fn (fetch_directory_plugins_for_scope_with_optional_collection).


##### `fetch_directory_plugins_for_scope_with_optional_collection`  (lines 1641–1660)

```
async fn fetch_directory_plugins_for_scope_with_optional_collection(
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
    scope: RemotePluginScope,
    collection: Option<&str>,
) -> Resu
```

**Purpose**: Paginates through the remote directory-list endpoint for one scope, optionally filtered by collection, and concatenates all pages. It is the low-level directory-list loop.

**Data flow**: Initializes an empty plugin vector and `page_token = None`, repeatedly calls `get_remote_plugin_list_page(config, auth, scope, page_token.as_deref(), collection)`, extends the vector with `response.plugins`, and either updates `page_token` from `response.pagination.next_page_token` or breaks when absent. It returns the full vector.

**Call relations**: Shared by both directory-list wrappers. It delegates actual HTTP request construction and decoding to `get_remote_plugin_list_page`.

*Call graph*: calls 1 internal fn (get_remote_plugin_list_page); called by 2 (fetch_directory_plugins_for_scope, fetch_directory_plugins_for_scope_with_collection); 1 external calls (new).


##### `fetch_shared_workspace_plugins`  (lines 1662–1678)

```
async fn fetch_shared_workspace_plugins(
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
) -> Result<Vec<RemotePluginDirectoryItem>, RemotePluginCatalogError>
```

**Purpose**: Paginates through the workspace-shared endpoint and returns all shared workspace plugins. It is the source of truth for plugins explicitly shared with the user.

**Data flow**: Loops over `get_remote_shared_workspace_plugins_page`, extending an output vector with each page's plugins until `next_page_token` is absent, then returns the accumulated vector.

**Call relations**: Called by `fetch_remote_marketplaces` when building the shared-with-me marketplace buckets.

*Call graph*: calls 1 internal fn (get_remote_shared_workspace_plugins_page); called by 1 (fetch_remote_marketplaces); 1 external calls (new).


##### `fetch_installed_plugins_for_scope`  (lines 1680–1689)

```
async fn fetch_installed_plugins_for_scope(
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
    scope: RemotePluginScope,
) -> Result<Vec<RemotePluginInstalledItem>, RemotePluginCatalogE
```

**Purpose**: Fetches all installed plugins for one scope without requesting download URLs. It is the standard installed-state helper.

**Data flow**: Delegates to `fetch_installed_plugins_for_scope_with_download_url` with `include_download_urls = false` and returns the accumulated installed-plugin vector.

**Call relations**: Used by marketplace listing, detail building, and installed-plugin aggregation.

*Call graph*: calls 1 internal fn (fetch_installed_plugins_for_scope_with_download_url); called by 3 (build_remote_plugin_detail, fetch_remote_installed_plugins, fetch_remote_marketplaces).


##### `fetch_installed_plugins_for_scope_with_download_url`  (lines 1691–1715)

```
async fn fetch_installed_plugins_for_scope_with_download_url(
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
    scope: RemotePluginScope,
    include_download_urls: bool,
) -> Result<V
```

**Purpose**: Paginates through the installed-plugins endpoint for one scope, optionally requesting download URLs, and concatenates all pages. It is the low-level installed-list loop.

**Data flow**: Initializes an empty vector and `page_token = None`, repeatedly calls `get_remote_plugin_installed_page(config, auth, scope, page_token.as_deref(), include_download_urls)`, extends the vector with `response.plugins`, and continues until pagination ends. It returns the full installed-plugin list.

**Call relations**: Called by `fetch_installed_plugins_for_scope`; the optional download-URL flag supports detail/install flows that need richer installed payloads.

*Call graph*: calls 1 internal fn (get_remote_plugin_installed_page); called by 1 (fetch_installed_plugins_for_scope); 1 external calls (new).


##### `get_remote_plugin_list_page`  (lines 1717–1737)

```
async fn get_remote_plugin_list_page(
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
    scope: RemotePluginScope,
    page_token: Option<&str>,
    collection: Option<&str>,
) -> Resul
```

**Purpose**: Builds and sends one request to the remote directory-list endpoint for a scope and optional collection/page token. It is the single-page transport helper for directory listings.

**Data flow**: Constructs the `/ps/plugins/list` URL from `chatgpt_base_url`, creates a reqwest client, builds an authenticated GET request, adds `scope`, `limit`, optional `collection`, and optional `pageToken` query parameters, then decodes `RemotePluginListResponse` with `send_and_decode`.

**Call relations**: Called in a loop by `fetch_directory_plugins_for_scope_with_optional_collection`.

*Call graph*: calls 4 internal fn (api_value, authenticated_request, send_and_decode, build_reqwest_client); called by 1 (fetch_directory_plugins_for_scope_with_optional_collection); 1 external calls (format!).


##### `get_remote_shared_workspace_plugins_page`  (lines 1739–1753)

```
async fn get_remote_shared_workspace_plugins_page(
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
    page_token: Option<&str>,
) -> Result<RemotePluginListResponse, RemotePluginCatalog
```

**Purpose**: Builds and sends one request to the workspace-shared endpoint. It is the single-page transport helper for shared workspace plugin listings.

**Data flow**: Constructs the `/ps/plugins/workspace/shared` URL, creates a reqwest client, builds an authenticated GET request with `limit` and optional `pageToken`, and decodes `RemotePluginListResponse` via `send_and_decode`.

**Call relations**: Called in a loop by `fetch_shared_workspace_plugins`.

*Call graph*: calls 3 internal fn (authenticated_request, send_and_decode, build_reqwest_client); called by 1 (fetch_shared_workspace_plugins); 1 external calls (format!).


##### `get_remote_plugin_installed_page`  (lines 1755–1774)

```
async fn get_remote_plugin_installed_page(
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
    scope: RemotePluginScope,
    page_token: Option<&str>,
    include_download_urls: bool,
)
```

**Purpose**: Builds and sends one request to the installed-plugins endpoint for a scope, with optional inclusion of download URLs. It is the single-page transport helper for installed-state fetches.

**Data flow**: Constructs the `/ps/plugins/installed` URL, creates a reqwest client, builds an authenticated GET request, adds `scope`, optional `includeDownloadUrls=true`, and optional `pageToken`, then decodes `RemotePluginInstalledResponse` with `send_and_decode`.

**Call relations**: Called in a loop by `fetch_installed_plugins_for_scope_with_download_url`.

*Call graph*: calls 4 internal fn (api_value, authenticated_request, send_and_decode, build_reqwest_client); called by 1 (fetch_installed_plugins_for_scope_with_download_url); 1 external calls (format!).


##### `fetch_plugin_detail`  (lines 1776–1790)

```
async fn fetch_plugin_detail(
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
    plugin_id: &str,
    include_download_urls: bool,
) -> Result<RemotePluginDirectoryItem, RemotePluginCat
```

**Purpose**: Fetches the backend detail payload for one remote plugin ID, optionally including download URLs. It is the raw detail transport helper.

**Data flow**: Builds the `/ps/plugins/{plugin_id}` URL, creates a reqwest client, builds an authenticated GET request, optionally adds `includeDownloadUrls=true`, and decodes a `RemotePluginDirectoryItem` with `send_and_decode`.

**Call relations**: Used by detail, share-context, and uninstall flows before higher-level shaping occurs.

*Call graph*: calls 3 internal fn (authenticated_request, send_and_decode, build_reqwest_client); called by 3 (fetch_remote_plugin_detail_with_download_url_option, fetch_remote_plugin_share_context, uninstall_remote_plugin); 1 external calls (format!).


##### `remote_plugin_skill_detail_url`  (lines 1792–1811)

```
fn remote_plugin_skill_detail_url(
    config: &RemotePluginServiceConfig,
    plugin_id: &str,
    skill_name: &str,
) -> Result<String, RemotePluginCatalogError>
```

**Purpose**: Constructs a skill-detail URL by appending path segments to the configured base URL while validating that the base URL supports path-segment mutation. It avoids manual string concatenation for path-sensitive URLs.

**Data flow**: Parses `chatgpt_base_url.trim_end_matches('/')` into `Url`, obtains mutable path segments, pops any trailing empty segment, pushes `ps/plugins/{plugin_id}/skills/{skill_name}`, and returns the final URL string. Parse or path-segment failures become `InvalidBaseUrl` or `InvalidBaseUrlPath` errors.

**Call relations**: Called by `fetch_remote_plugin_skill_detail` before building the authenticated request.

*Call graph*: called by 1 (fetch_remote_plugin_skill_detail); 1 external calls (parse).


##### `ensure_chatgpt_auth`  (lines 1813–1821)

```
fn ensure_chatgpt_auth(auth: Option<&CodexAuth>) -> Result<&CodexAuth, RemotePluginCatalogError>
```

**Purpose**: Requires that auth is present and uses the Codex/ChatGPT backend rather than API-key mode. It is the common auth gate for all remote catalog operations.

**Data flow**: Takes `Option<&CodexAuth>`, returns `AuthRequired` if `None`, returns `UnsupportedAuthMode` if `auth.uses_codex_backend()` is false, otherwise returns the borrowed auth reference.

**Call relations**: Called at the start of nearly every public remote operation and some cache helpers before any network or cache work proceeds.

*Call graph*: called by 11 (fetch_and_cache_global_remote_plugin_catalog, fetch_openai_curated_remote_collection_marketplace, fetch_recommended_plugins, fetch_remote_installed_plugins, fetch_remote_marketplaces, fetch_remote_plugin_detail_with_download_url_option, fetch_remote_plugin_share_context, fetch_remote_plugin_skill_detail, has_cached_global_remote_plugin_catalog, install_remote_plugin (+1 more)).


##### `authenticated_request`  (lines 1823–1831)

```
fn authenticated_request(
    request: RequestBuilder,
    auth: &CodexAuth,
) -> Result<RequestBuilder, RemotePluginCatalogError>
```

**Purpose**: Applies standard timeout and authentication headers to a reqwest request builder for remote plugin service calls. It centralizes transport policy.

**Data flow**: Takes a `RequestBuilder` and `&CodexAuth`, sets the standard remote catalog timeout, adds auth headers from `codex_model_provider::auth_provider_from_auth(auth).to_auth_headers()`, adds the `OAI-Product-Sku: codex` header, and returns the updated builder.

**Call relations**: Used by all HTTP request constructors in this file after auth has been validated by `ensure_chatgpt_auth`.

*Call graph*: called by 8 (fetch_plugin_detail, fetch_recommended_plugins, fetch_remote_plugin_skill_detail, get_remote_plugin_installed_page, get_remote_plugin_list_page, get_remote_shared_workspace_plugins_page, install_remote_plugin, uninstall_remote_plugin); 2 external calls (timeout, auth_provider_from_auth).


##### `send_and_decode`  (lines 1833–1858)

```
async fn send_and_decode(
    request: RequestBuilder,
    url: &str,
) -> Result<T, RemotePluginCatalogError>
```

**Purpose**: Sends an authenticated HTTP request, checks for success status, reads the body as text, and deserializes JSON into the requested response type. It is the shared HTTP/JSON transport primitive.

**Data flow**: Consumes a `RequestBuilder` and URL string, awaits `send()`, mapping transport failures into `RemotePluginCatalogError::Request`, reads `status` and body text, returns `UnexpectedStatus` with the raw body if the status is non-success, otherwise parses the body with `serde_json::from_str` into `T`, mapping parse failures into `Decode`.

**Call relations**: Called by all page/detail/mutation request helpers after they finish constructing authenticated requests.

*Call graph*: called by 8 (fetch_plugin_detail, fetch_recommended_plugins, fetch_remote_plugin_skill_detail, get_remote_plugin_installed_page, get_remote_plugin_list_page, get_remote_shared_workspace_plugins_page, install_remote_plugin, uninstall_remote_plugin); 2 external calls (send, from_str).


### `core-plugins/src/remote_legacy.rs`

`io_transport` · `legacy remote fetch and mutation requests`

This module contains a small, self-contained set of legacy remote-plugin API calls separate from the newer catalog/share code. `fetch_remote_featured_plugin_ids` issues a GET to `{chatgpt_base_url}/plugins/featured`, always includes a `platform` query parameter derived from `Product`, and conditionally attaches Codex backend auth headers only when the provided `CodexAuth` is present and `uses_codex_backend()`. It uses a short 10-second timeout and decodes the response body directly as `Vec<String>`.

Mutation operations are stricter. `enable_remote_plugin` and `uninstall_remote_plugin` are thin wrappers over `post_remote_plugin_mutation`, which first requires Codex-backend auth via `ensure_codex_backend_auth`; API-key or non-Codex auth is explicitly rejected. The mutation URL is built by parsing `chatgpt_base_url` as a `Url` and appending `/plugins/{plugin_id}/{action}` through path-segment mutation, rejecting base URLs whose paths cannot be safely extended.

After sending the POST with a 30-second timeout and auth headers, the code checks for HTTP success, parses `RemotePluginMutationResponse { id, enabled }`, and validates both semantic fields: the returned plugin ID must match the requested one, and the returned `enabled` flag must match the requested action (`true` for enable, `false` for uninstall). This extra validation catches backend inconsistencies instead of silently accepting malformed success responses.

#### Function details

##### `fetch_remote_featured_plugin_ids`  (lines 98–136)

```
async fn fetch_remote_featured_plugin_ids(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
    product: Option<Product>,
) -> Result<Vec<String>, RemotePluginFetchError>
```

**Purpose**: Fetches the list of featured remote plugin IDs from the legacy featured-plugins endpoint.

**Data flow**: It takes service `config`, optional `auth`, and optional `product`; trims the base URL, formats `/plugins/featured`, builds a GET request with `platform=<product-or-Codex>.to_app_platform()` and a 10-second timeout, conditionally adds Codex backend auth headers when `auth.uses_codex_backend()` is true, sends the request, checks for HTTP success, reads the body as text, and parses it as `Vec<String>`. Transport, status, and decode failures are mapped into `RemotePluginFetchError` variants.

**Call relations**: Higher-level featured-plugin lookup code calls this function when it needs the legacy featured list for a given backend configuration.

*Call graph*: calls 1 internal fn (build_reqwest_client); called by 1 (featured_plugin_ids_for_config); 3 external calls (auth_provider_from_auth, format!, from_str).


##### `enable_remote_plugin`  (lines 138–145)

```
async fn enable_remote_plugin(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
    plugin_id: &str,
) -> Result<(), RemotePluginMutationError>
```

**Purpose**: Requests that the backend enable a remote plugin and ignores the returned mutation payload after validation.

**Data flow**: It forwards `config`, `auth`, `plugin_id`, and the action string `"enable"` to `post_remote_plugin_mutation`, discards the successful `RemotePluginMutationResponse`, and returns `Ok(())` or the propagated mutation error.

**Call relations**: Remote install/sync flows call this wrapper when they need the legacy enable mutation rather than the raw mutation response.

*Call graph*: calls 1 internal fn (post_remote_plugin_mutation); called by 1 (install_plugin_with_remote_sync).


##### `uninstall_remote_plugin`  (lines 147–154)

```
async fn uninstall_remote_plugin(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
    plugin_id: &str,
) -> Result<(), RemotePluginMutationError>
```

**Purpose**: Requests that the backend uninstall a remote plugin and ignores the returned mutation payload after validation.

**Data flow**: It forwards `config`, `auth`, `plugin_id`, and the action string `"uninstall"` to `post_remote_plugin_mutation`, discards the successful response, and returns `Ok(())` or the propagated error.

**Call relations**: Remote uninstall flows call this wrapper as the legacy counterpart to `enable_remote_plugin`.

*Call graph*: calls 1 internal fn (post_remote_plugin_mutation); called by 1 (uninstall_plugin_with_remote_sync).


##### `ensure_codex_backend_auth`  (lines 156–166)

```
fn ensure_codex_backend_auth(
    auth: Option<&CodexAuth>,
) -> Result<&CodexAuth, RemotePluginMutationError>
```

**Purpose**: Validates that mutation requests have authentication and that the auth mode is the Codex backend mode required by the legacy mutation endpoints.

**Data flow**: It inspects `auth`: `None` becomes `AuthRequired`, non-Codex auth becomes `UnsupportedAuthMode`, and valid Codex backend auth is returned by reference.

**Call relations**: `post_remote_plugin_mutation` calls this before building any request so unsupported auth modes fail early and clearly.

*Call graph*: called by 1 (post_remote_plugin_mutation).


##### `post_remote_plugin_mutation`  (lines 168–216)

```
async fn post_remote_plugin_mutation(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
    plugin_id: &str,
    action: &str,
) -> Result<RemotePluginMutationResponse, RemotePlugi
```

**Purpose**: Sends a legacy remote-plugin mutation request, decodes the response, and verifies that the backend echoed the expected plugin ID and enabled state.

**Data flow**: It validates auth with `ensure_codex_backend_auth`, builds the endpoint URL with `remote_plugin_mutation_url`, creates a POST request with a 30-second timeout and Codex backend auth headers, sends it, checks for HTTP success, reads the body as text, parses `RemotePluginMutationResponse`, computes `expected_enabled` from whether `action == "enable"`, and then compares both `parsed.id` and `parsed.enabled` against expectations. It returns the parsed response on success or a specific mutation error on transport, status, decode, ID mismatch, or enabled-state mismatch.

**Call relations**: The public enable/uninstall wrappers both delegate here; this function contains the shared request construction and semantic response validation.

*Call graph*: calls 3 internal fn (ensure_codex_backend_auth, remote_plugin_mutation_url, build_reqwest_client); called by 2 (enable_remote_plugin, uninstall_remote_plugin); 2 external calls (auth_provider_from_auth, from_str).


##### `remote_plugin_mutation_url`  (lines 218–235)

```
fn remote_plugin_mutation_url(
    config: &RemotePluginServiceConfig,
    plugin_id: &str,
    action: &str,
) -> Result<String, RemotePluginMutationError>
```

**Purpose**: Builds the full legacy mutation endpoint URL by appending plugin/action path segments to the configured ChatGPT base URL.

**Data flow**: It parses `config.chatgpt_base_url.trim_end_matches('/')` into a mutable `Url`, obtains mutable path segments, removes any trailing empty segment, pushes `plugins`, `plugin_id`, and `action`, and returns the resulting URL string. Parse failures and non-hierarchical base URLs become `RemotePluginMutationError` variants.

**Call relations**: `post_remote_plugin_mutation` uses this helper so URL construction and base-URL validation are centralized.

*Call graph*: called by 1 (post_remote_plugin_mutation); 1 external calls (parse).


### `core-plugins/src/remote/share.rs`

`domain_logic` · `user-initiated share create/update/list/delete flows`

This module is the main API surface for remote plugin sharing. It defines share-related enums and structs such as `RemotePluginShareDiscoverability`, `RemotePluginShareTarget`, `RemotePluginSharePrincipal`, `RemotePluginShareSaveResult`, and `RemotePluginShareUpdateTargetsResult`, plus private request/response payload types for the upload and share-target endpoints.

The save flow is multi-phase. `save_remote_plugin_share` first requires ChatGPT auth, then offloads archive creation to a blocking task: `archive_filename` derives `<plugin-dir>.tar.gz`, and `archive_plugin_for_upload` packs the plugin directory with a 50 MiB limit. It requests an upload URL from `/public/plugins/workspace/upload-url`, requires an `etag` in the response, uploads the gzip bytes directly to blob storage with specific headers, ensures unlisted shares always include the current workspace as a reader target, and finalizes creation or update via `/public/plugins/workspace` or `/public/plugins/workspace/{id}`. Successful saves best-effort record a local mapping from remote plugin ID to local path.

Listing shares fetches all created workspace plugins page by page, fetches installed workspace plugins to annotate installed/enabled state, loads the local-path mapping, and converts each remote item into a `RemotePluginShareSummary`, rejecting malformed created-plugin responses that omit `share_principals`. Delete and target-update operations are thin authenticated HTTP wrappers. The module also exposes `checkout_remote_plugin_share` from its submodule and delegates local path persistence to `share/local_paths.rs`.

#### Function details

##### `save_remote_plugin_share`  (lines 138–203)

```
async fn save_remote_plugin_share(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
    codex_home: &Path,
    plugin_path: &AbsolutePathBuf,
    remote_plugin_id: Option<&str>,
```

**Purpose**: Packages a local plugin directory, uploads it as a workspace plugin bundle, finalizes the remote share, and records the local path mapping for the resulting remote plugin ID.

**Data flow**: It consumes service `config`, optional `auth`, `codex_home`, a local `plugin_path`, optional existing `remote_plugin_id`, and an access policy. After `ensure_chatgpt_auth`, it clones the plugin path for a blocking task that computes the archive filename and bytes. It then calls `create_workspace_plugin_upload`, extracts the required `etag`, uploads the archive with `put_workspace_plugin_upload`, normalizes share targets through `ensure_unlisted_workspace_target`, and posts `RemoteWorkspacePluginCreateRequest` via `finalize_workspace_plugin_upload`. It errors if the response has an empty `plugin_id`; otherwise it best-effort writes the local-path mapping and returns `RemotePluginShareSaveResult { remote_plugin_id, share_url }`.

**Call relations**: This is the top-level share save/update operation. It orchestrates archive helpers, upload/finalization HTTP helpers, and local path persistence; callers use it for both first-time share creation and updating an existing remote workspace plugin.

*Call graph*: calls 6 internal fn (create_workspace_plugin_upload, ensure_unlisted_workspace_target, finalize_workspace_plugin_upload, record_plugin_share_local_path, put_workspace_plugin_upload, as_path); 4 external calls (UnexpectedResponse, spawn_blocking, clone, warn!).


##### `list_remote_plugin_shares`  (lines 205–251)

```
async fn list_remote_plugin_shares(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
    codex_home: &Path,
) -> Result<Vec<RemotePluginShareSummary>, RemotePluginCatalogError>
```

**Purpose**: Returns summaries of workspace plugins created by the current user, enriched with installed-state information and any remembered local checkout/share path.

**Data flow**: It authenticates with `ensure_chatgpt_auth`, fetches all created workspace plugins through `fetch_created_workspace_plugins`, short-circuits to an empty vector if none exist, fetches installed workspace plugins and indexes them by remote plugin ID in a `BTreeMap`, loads local path mappings from disk, then maps each created plugin through `build_remote_plugin_summary`. It requires each created plugin summary to include `share_principals`; if not, it returns an `UnexpectedResponse` error. On success it returns `Vec<RemotePluginShareSummary>` with optional `local_plugin_path` attached from the mapping.

**Call relations**: UI or command paths that show the user’s shared plugins call this function. It delegates pagination to `fetch_created_workspace_plugins` and local mapping lookup to `local_paths::load_plugin_share_local_paths`.

*Call graph*: calls 2 internal fn (fetch_created_workspace_plugins, load_plugin_share_local_paths); 1 external calls (new).


##### `load_plugin_share_remote_ids_by_local_path`  (lines 253–271)

```
fn load_plugin_share_remote_ids_by_local_path(
    codex_home: &Path,
) -> io::Result<BTreeMap<AbsolutePathBuf, String>>
```

**Purpose**: Loads the persisted remote-share mapping and inverts it so local plugin paths map back to remote plugin IDs.

**Data flow**: It reads the stored `BTreeMap<String, AbsolutePathBuf>` from `local_paths::load_plugin_share_local_paths`, validates each remote plugin ID with `is_valid_remote_plugin_id`, and collects the entries into a `BTreeMap<AbsolutePathBuf, String>`. Invalid IDs are converted into `io::ErrorKind::InvalidData` errors.

**Call relations**: This helper is used when callers need to start from a local path and discover whether it corresponds to a known remote share, rather than the forward remote-ID-to-path mapping stored on disk.

*Call graph*: calls 1 internal fn (load_plugin_share_local_paths).


##### `delete_remote_plugin_share`  (lines 273–292)

```
async fn delete_remote_plugin_share(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
    codex_home: &Path,
    remote_plugin_id: &str,
) -> Result<(), RemotePluginCatalogError>
```

**Purpose**: Deletes a remote workspace plugin share and removes its local path mapping if present.

**Data flow**: It authenticates, builds the `/public/plugins/workspace/{remote_plugin_id}` URL from `config.chatgpt_base_url`, creates an authenticated DELETE request with the shared reqwest client, and verifies a `204 NO_CONTENT` response via `send_and_expect_status`. After a successful remote delete it best-effort removes the local mapping with `local_paths::remove_plugin_share_local_path`, logging a warning if that cleanup fails, and returns `Ok(())`.

**Call relations**: Delete flows call this as the authoritative remote removal path. It delegates HTTP status checking to `send_and_expect_status` and local bookkeeping cleanup to the `local_paths` submodule.

*Call graph*: calls 3 internal fn (remove_plugin_share_local_path, send_and_expect_status, build_reqwest_client); 2 external calls (format!, warn!).


##### `update_remote_plugin_share_targets`  (lines 294–327)

```
async fn update_remote_plugin_share_targets(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
    remote_plugin_id: &str,
    targets: Vec<RemotePluginShareTarget>,
    discoverab
```

**Purpose**: Replaces the share target list and discoverability for an existing remote plugin share, while enforcing the workspace-reader rule for unlisted shares.

**Data flow**: It authenticates, converts the update-specific discoverability enum into the broader `RemotePluginShareDiscoverability`, passes the requested targets through `ensure_unlisted_workspace_target`, builds the `/ps/plugins/{remote_plugin_id}/shares` URL, sends an authenticated PUT with `RemotePluginShareUpdateTargetsRequest`, decodes `RemotePluginShareUpdateTargetsResponse`, and returns `RemotePluginShareUpdateTargetsResult { principals, discoverability }`.

**Call relations**: Share-management callers use this after a plugin already exists remotely. It shares the target-normalization rule with `save_remote_plugin_share` by delegating to `ensure_unlisted_workspace_target`.

*Call graph*: calls 2 internal fn (ensure_unlisted_workspace_target, build_reqwest_client); 1 external calls (format!).


##### `ensure_unlisted_workspace_target`  (lines 329–354)

```
fn ensure_unlisted_workspace_target(
    auth: &CodexAuth,
    discoverability: Option<RemotePluginShareDiscoverability>,
    targets: Option<Vec<RemotePluginShareTarget>>,
) -> Result<Option<Vec<Remo
```

**Purpose**: Ensures that unlisted workspace shares always include the current workspace account as a reader target.

**Data flow**: It takes `auth`, optional discoverability, and optional target list. If discoverability is not `Some(Unlisted)`, it returns the targets unchanged. Otherwise it reads `auth.get_account_id()`, errors if absent, materializes a mutable target vector, checks whether a `Workspace` target with that account ID already exists, and if not appends one with `Reader` role. It returns `Some(updated_targets)`.

**Call relations**: Both share creation/update paths call this before sending requests so backend-visible target lists satisfy the workspace-sharing invariant for unlisted plugins.

*Call graph*: calls 1 internal fn (get_account_id); called by 2 (save_remote_plugin_share, update_remote_plugin_share_targets).


##### `fetch_created_workspace_plugins`  (lines 356–372)

```
async fn fetch_created_workspace_plugins(
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
) -> Result<Vec<RemotePluginDirectoryItem>, RemotePluginCatalogError>
```

**Purpose**: Retrieves all pages of workspace plugins created by the current user.

**Data flow**: It initializes an empty `Vec` and `page_token = None`, repeatedly calls `get_created_workspace_plugins_page`, extends the accumulated plugin list with each page’s `plugins`, and follows `pagination.next_page_token` until it becomes `None`. It returns the concatenated `Vec<RemotePluginDirectoryItem>`.

**Call relations**: This is the pagination loop used by `list_remote_plugin_shares`; it delegates each HTTP page fetch to `get_created_workspace_plugins_page`.

*Call graph*: calls 1 internal fn (get_created_workspace_plugins_page); called by 1 (list_remote_plugin_shares); 1 external calls (new).


##### `get_created_workspace_plugins_page`  (lines 374–388)

```
async fn get_created_workspace_plugins_page(
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
    page_token: Option<&str>,
) -> Result<RemotePluginListResponse, RemotePluginCatalogError>
```

**Purpose**: Fetches one page of created workspace plugins from the remote service.

**Data flow**: It trims the configured base URL, builds `/ps/plugins/workspace/created`, creates an authenticated GET request, always adds the `limit` query parameter, conditionally adds `pageToken`, and decodes the response into `RemotePluginListResponse`. It returns that decoded page.

**Call relations**: The pagination helper `fetch_created_workspace_plugins` calls this in a loop, varying `page_token` until the backend stops returning a next-page token.

*Call graph*: calls 1 internal fn (build_reqwest_client); called by 1 (fetch_created_workspace_plugins); 1 external calls (format!).


##### `create_workspace_plugin_upload`  (lines 390–409)

```
async fn create_workspace_plugin_upload(
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
    filename: &str,
    size_bytes: usize,
    remote_plugin_id: Option<&str>,
) -> Result<Remote
```

**Purpose**: Requests a temporary upload URL and file identifier for a plugin archive upload.

**Data flow**: It builds the `/public/plugins/workspace/upload-url` endpoint, creates an authenticated POST request, serializes `RemoteWorkspacePluginUploadUrlRequest { filename, mime_type: "application/gzip", size_bytes, plugin_id }` as JSON, and decodes the response into `RemoteWorkspacePluginUploadUrlResponse`. The returned value includes `file_id`, `upload_url`, and optional `etag`.

**Call relations**: `save_remote_plugin_share` calls this before uploading archive bytes so it can send the bundle to the storage URL the backend provisions.

*Call graph*: calls 1 internal fn (build_reqwest_client); called by 1 (save_remote_plugin_share); 1 external calls (format!).


##### `put_workspace_plugin_upload`  (lines 411–439)

```
async fn put_workspace_plugin_upload(
    upload_url: &str,
    archive_bytes: Vec<u8>,
) -> Result<(), RemotePluginCatalogError>
```

**Purpose**: Uploads the prepared plugin archive bytes to the storage URL returned by the backend.

**Data flow**: It takes the opaque `upload_url` and archive bytes, builds a PUT request with the shared reqwest client, applies the catalog timeout plus `x-ms-blob-type: BlockBlob` and `Content-Type: application/gzip` headers, sends the request, reads the response body as text, and accepts only `200 OK` or `201 CREATED`. Any request failure or unexpected status becomes a `RemotePluginCatalogError`.

**Call relations**: This is the middle phase of `save_remote_plugin_share`, sitting between upload-URL creation and finalization.

*Call graph*: calls 1 internal fn (build_reqwest_client); called by 1 (save_remote_plugin_share).


##### `finalize_workspace_plugin_upload`  (lines 441–456)

```
async fn finalize_workspace_plugin_upload(
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
    remote_plugin_id: Option<&str>,
    body: RemoteWorkspacePluginCreateRequest,
) -> Result<R
```

**Purpose**: Tells the backend to create a new workspace plugin or update an existing one using a previously uploaded archive file.

**Data flow**: It chooses the endpoint based on whether `remote_plugin_id` is `Some`: `/public/plugins/workspace/{id}` for updates or `/public/plugins/workspace` for creates. It sends an authenticated POST with the provided `RemoteWorkspacePluginCreateRequest` body and decodes `RemoteWorkspacePluginCreateResponse`, returning the decoded response.

**Call relations**: `save_remote_plugin_share` calls this after the blob upload succeeds to commit the uploaded file into a remote plugin record.

*Call graph*: calls 1 internal fn (build_reqwest_client); called by 1 (save_remote_plugin_share); 1 external calls (format!).


##### `archive_filename`  (lines 458–467)

```
fn archive_filename(plugin_path: &Path) -> Result<String, RemotePluginCatalogError>
```

**Purpose**: Derives the upload archive filename from the plugin directory name.

**Data flow**: It reads the final path segment from `plugin_path`, requires it to be valid UTF-8, and returns `<plugin_name>.tar.gz`. If the path has no valid UTF-8 directory name, it returns `RemotePluginCatalogError::InvalidPluginPath` with the original path and reason.

**Call relations**: The blocking archive-preparation step in `save_remote_plugin_share` uses this helper before packing bytes.

*Call graph*: 2 external calls (file_name, format!).


##### `archive_plugin_for_upload`  (lines 469–471)

```
fn archive_plugin_for_upload(plugin_path: &Path) -> Result<Vec<u8>, RemotePluginCatalogError>
```

**Purpose**: Packs a plugin directory into a gzip-compressed tar archive using the module’s standard size limit.

**Data flow**: It forwards `plugin_path` and `REMOTE_PLUGIN_SHARE_MAX_ARCHIVE_BYTES` to `archive_plugin_for_upload_with_limit` and returns the resulting archive bytes or mapped error.

**Call relations**: This is the normal archive entry point used by `save_remote_plugin_share`; tests also call it to inspect archive layout.

*Call graph*: calls 1 internal fn (archive_plugin_for_upload_with_limit).


##### `archive_plugin_for_upload_with_limit`  (lines 473–489)

```
fn archive_plugin_for_upload_with_limit(
    plugin_path: &Path,
    max_bytes: usize,
) -> Result<Vec<u8>, RemotePluginCatalogError>
```

**Purpose**: Packs a plugin bundle archive with an explicit maximum size and translates archive-layer errors into remote-catalog errors.

**Data flow**: It calls `pack_plugin_bundle_tar_gz(plugin_path, max_bytes)` and maps `PluginBundlePackError::InvalidPluginPath`, `ArchiveTooLarge`, and `Io` into the corresponding `RemotePluginCatalogError` variants, preserving path and size details. It returns the archive bytes on success.

**Call relations**: `archive_plugin_for_upload` delegates here, and tests use it directly to verify oversize rejection behavior.

*Call graph*: calls 1 internal fn (pack_plugin_bundle_tar_gz); called by 1 (archive_plugin_for_upload).


##### `send_and_expect_status`  (lines 491–513)

```
async fn send_and_expect_status(
    request: RequestBuilder,
    url_for_error: &str,
    expected_statuses: &[StatusCode],
) -> Result<(), RemotePluginCatalogError>
```

**Purpose**: Sends an HTTP request and succeeds only if the response status is one of a caller-provided allowed set.

**Data flow**: It takes a `RequestBuilder`, an error-reporting URL string, and a slice of expected `StatusCode`s; sends the request; converts transport failures into `RemotePluginCatalogError::Request`; reads the response body as text; and returns `Ok(())` only when `status` is contained in `expected_statuses`, otherwise returning `UnexpectedStatus { url, status, body }`.

**Call relations**: `delete_remote_plugin_share` uses this helper because it only needs status validation, not JSON decoding.

*Call graph*: called by 1 (delete_remote_plugin_share); 2 external calls (send, contains).


### `core-plugins/src/remote/share/checkout.rs`

`domain_logic` · `user-initiated share checkout`

This submodule turns a remote shared plugin into a local editable plugin under the user’s home directory. `checkout_remote_plugin_share` first fetches plugin detail with download URLs from the private shared-with-me marketplace endpoint, validates the returned plugin name with `validate_plugin_segment`, and rejects shares whose marketplace is not one of the supported shared-workspace variants or that lack share context. It then resolves the OS home directory, loads any previously recorded remote-ID-to-local-path mapping, and chooses a checkout destination with `editable_plugin_path_for_checkout`.

If the share was not already checked out, the function validates the remote bundle metadata and downloads/extracts the bundle directly into the chosen destination. It then updates `~/.agents/plugins/marketplace.json` through `update_personal_marketplace`, ensuring the plugin appears as a local-source entry in the personal marketplace with installation/authentication policy and optional category copied from the remote summary. The marketplace file is created on demand with a default `name` and `displayName`, parsed as generic JSON, validated structurally, and rewritten atomically.

A key invariant is that personal marketplace paths must be representable as `./relative/path` under the user’s home directory; paths outside home, non-UTF-8 segments, root/prefix/parent components, and the home directory itself are rejected. If checkout created a new directory but later marketplace or mapping updates fail, cleanup attempts to remove the created path and folds cleanup failure into the returned error message.

#### Function details

##### `checkout_remote_plugin_share`  (lines 37–162)

```
async fn checkout_remote_plugin_share(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
    codex_home: &Path,
    remote_plugin_id: &str,
) -> Result<RemotePluginShareCheckoutRes
```

**Purpose**: Fetches a shared remote plugin, checks it out to a local editable path if needed, adds it to the personal marketplace, records the local path mapping, and returns the resulting local/plugin identifiers.

**Data flow**: It takes service `config`, optional `auth`, `codex_home`, and `remote_plugin_id`; fetches remote detail with download URLs; extracts and validates `plugin_name`; verifies the marketplace is one of the supported shared-with-me variants and that share context exists; resolves the user home directory into `AbsolutePathBuf`; loads existing local-path mappings; and chooses a destination plus `already_checked_out` flag via `editable_plugin_path_for_checkout`. If not already checked out, it validates the remote bundle and downloads/extracts it to the destination. It then updates the personal marketplace JSON, records the remote-ID-to-local-path mapping, constructs a local `PluginId`, and returns `RemotePluginShareCheckoutResult` containing remote ID, local plugin ID, plugin name, plugin path, marketplace name/path, and remote version. If marketplace update or mapping persistence fails after creating a new checkout path, it invokes `clean_up_created_checkout_path` to remove the newly created directory.

**Call relations**: This is the top-level checkout flow re-exported by `share.rs`. It orchestrates remote detail fetch, path selection, bundle extraction from `crate::remote_bundle`, marketplace-file mutation, and local mapping persistence.

*Call graph*: calls 11 internal fn (home_dir, clean_up_created_checkout_path, editable_plugin_path_for_checkout, is_checkout_supported_share_marketplace, load_share_local_paths_for_checkout, update_personal_marketplace, record_plugin_share_local_path, download_and_extract_remote_plugin_bundle_to_path, validate_remote_plugin_bundle, new (+1 more)); 4 external calls (validate_plugin_segment, UnexpectedResponse, format!, fetch_remote_plugin_detail_with_download_urls).


##### `is_checkout_supported_share_marketplace`  (lines 164–171)

```
fn is_checkout_supported_share_marketplace(marketplace_name: &str) -> bool
```

**Purpose**: Recognizes which remote marketplace names are eligible for local checkout as shared workspace plugins.

**Data flow**: It compares the input `marketplace_name` against the three accepted constants for shared-with-me marketplaces and returns a boolean. No state is read or written beyond those constants.

**Call relations**: `checkout_remote_plugin_share` uses this as an early gate before attempting any local checkout work.

*Call graph*: called by 1 (checkout_remote_plugin_share); 1 external calls (matches!).


##### `load_share_local_paths_for_checkout`  (lines 173–183)

```
fn load_share_local_paths_for_checkout(
    codex_home: &Path,
) -> Result<BTreeMap<String, AbsolutePathBuf>, RemotePluginCatalogError>
```

**Purpose**: Loads the remote-share local-path mapping for checkout, but treats malformed mapping files as empty rather than fatal.

**Data flow**: It calls `local_paths::load_plugin_share_local_paths(codex_home)`. A successful read returns the mapping unchanged; `io::ErrorKind::InvalidData` is downgraded to an empty `BTreeMap`; any other error is wrapped as `RemotePluginCatalogError::UnexpectedResponse`.

**Call relations**: The checkout flow uses this more forgiving loader because stale or malformed best-effort mapping state should not block a user from checking out a share.

*Call graph*: calls 1 internal fn (load_plugin_share_local_paths); called by 1 (checkout_remote_plugin_share); 3 external calls (new, UnexpectedResponse, format!).


##### `editable_plugin_path_for_checkout`  (lines 185–214)

```
fn editable_plugin_path_for_checkout(
    home: &AbsolutePathBuf,
    plugin_name: &str,
    remote_plugin_id: &str,
    local_paths: &BTreeMap<String, AbsolutePathBuf>,
) -> Result<(AbsolutePathBuf,
```

**Purpose**: Chooses the local editable directory for a checked-out share and determines whether the share is already checked out there.

**Data flow**: It receives the user `home`, `plugin_name`, `remote_plugin_id`, and existing mapping. If the mapping contains the remote ID and that path exists, it validates that the path can be represented in the personal marketplace and returns `(existing_path, true)`. Otherwise it uses the mapped path if present or defaults to `home/plugins/<plugin_name>`, validates representability, and errors with `InvalidPluginPath` if that destination already exists. On success it returns `(local_plugin_path, false)`.

**Call relations**: `checkout_remote_plugin_share` delegates destination selection here before deciding whether it needs to download/extract the bundle.

*Call graph*: calls 1 internal fn (ensure_path_can_be_listed_in_personal_marketplace); called by 1 (checkout_remote_plugin_share); 1 external calls (format!).


##### `clean_up_created_checkout_path`  (lines 216–232)

```
fn clean_up_created_checkout_path(
    created_checkout_path: bool,
    local_plugin_path: &AbsolutePathBuf,
    original_err: RemotePluginCatalogError,
) -> RemotePluginCatalogError
```

**Purpose**: Wraps an existing checkout error with best-effort cleanup of a newly created checkout directory or file.

**Data flow**: It takes a `created_checkout_path` flag, the `local_plugin_path`, and the original `RemotePluginCatalogError`. If no path was created, it returns the original error unchanged. Otherwise it calls `remove_created_checkout_path`; on cleanup success it returns the original error, and on cleanup failure it returns a new `UnexpectedResponse` combining both failure messages.

**Call relations**: The main checkout flow uses this when marketplace update or local-path recording fails after extraction created a new local checkout path.

*Call graph*: calls 1 internal fn (remove_created_checkout_path); called by 1 (checkout_remote_plugin_share); 2 external calls (UnexpectedResponse, format!).


##### `remove_created_checkout_path`  (lines 234–240)

```
fn remove_created_checkout_path(local_plugin_path: &AbsolutePathBuf) -> io::Result<()>
```

**Purpose**: Deletes a checkout path that was created during a failed checkout attempt.

**Data flow**: It inspects `local_plugin_path.as_path()`: if it is a directory it removes it recursively with `fs::remove_dir_all`, otherwise it removes it as a file with `fs::remove_file`. It returns the underlying `io::Result<()>`.

**Call relations**: This is the filesystem cleanup primitive used only by `clean_up_created_checkout_path`.

*Call graph*: calls 1 internal fn (as_path); called by 1 (clean_up_created_checkout_path); 2 external calls (remove_dir_all, remove_file).


##### `ensure_path_can_be_listed_in_personal_marketplace`  (lines 242–247)

```
fn ensure_path_can_be_listed_in_personal_marketplace(
    home: &AbsolutePathBuf,
    path: &AbsolutePathBuf,
) -> Result<(), RemotePluginCatalogError>
```

**Purpose**: Validates that a local plugin path can be encoded as a relative path entry in the personal marketplace file.

**Data flow**: It calls `personal_marketplace_relative_plugin_path(home, path)` and discards the resulting string, returning `Ok(())` on success or propagating the validation error. It does not mutate state.

**Call relations**: Path-selection logic calls this before reusing or choosing a checkout destination so later marketplace updates cannot fail due to an unrepresentable path.

*Call graph*: calls 1 internal fn (personal_marketplace_relative_plugin_path); called by 1 (editable_plugin_path_for_checkout).


##### `update_personal_marketplace`  (lines 254–341)

```
fn update_personal_marketplace(
    home: &AbsolutePathBuf,
    plugin_name: &str,
    local_plugin_path: &AbsolutePathBuf,
    install_policy: PluginInstallPolicy,
    auth_policy: PluginAuthPolicy,
```

**Purpose**: Creates or updates the personal marketplace JSON file so the checked-out plugin appears as a local-source plugin entry with current policy metadata.

**Data flow**: It computes the marketplace file path under `PERSONAL_MARKETPLACE_RELATIVE_PATH`, derives the plugin’s relative path with `personal_marketplace_relative_plugin_path`, loads or creates the marketplace JSON via `read_or_create_personal_marketplace`, and requires the root to be a JSON object. It ensures a string `name` field exists, validates that marketplace name with `validate_plugin_segment`, ensures `plugins` is an array, builds a fresh plugin entry with `personal_marketplace_plugin_entry`, and either replaces an existing entry with the same plugin name if its source path matches or appends a new one. If an existing plugin name points at a different path, it errors. Finally it pretty-serializes the JSON with a trailing newline, writes it atomically via `write_json_atomically`, and returns `PersonalMarketplaceUpdate { name, path }`.

**Call relations**: After checkout extraction, `checkout_remote_plugin_share` calls this to make the local plugin discoverable through the personal marketplace. It relies on several local helpers for path validation, JSON defaults, and atomic writes.

*Call graph*: calls 6 internal fn (invalid_marketplace_file, personal_marketplace_plugin_entry, personal_marketplace_relative_plugin_path, read_or_create_personal_marketplace, write_json_atomically, join); called by 1 (checkout_remote_plugin_share); 3 external calls (validate_plugin_segment, format!, to_string_pretty).


##### `read_or_create_personal_marketplace`  (lines 343–364)

```
fn read_or_create_personal_marketplace(
    marketplace_path: &Path,
) -> Result<JsonValue, RemotePluginCatalogError>
```

**Purpose**: Loads the personal marketplace JSON file if it exists, or synthesizes a default marketplace document if it does not.

**Data flow**: It reads the file at `marketplace_path` as a string. On success it parses the contents as `serde_json::Value`, converting parse failures into `invalid_marketplace_file` errors. If the file is missing, it returns a default JSON object containing `name`, `interface.displayName`, and an empty `plugins` array. Other read errors become `UnexpectedResponse`.

**Call relations**: `update_personal_marketplace` uses this helper to normalize the marketplace file into editable JSON regardless of whether the file already exists.

*Call graph*: called by 1 (update_personal_marketplace); 5 external calls (UnexpectedResponse, format!, json!, from_str, read_to_string).


##### `personal_marketplace_plugin_entry`  (lines 366–391)

```
fn personal_marketplace_plugin_entry(
    plugin_name: &str,
    relative_plugin_path: &str,
    install_policy: PluginInstallPolicy,
    auth_policy: PluginAuthPolicy,
    category: Option<String>,
)
```

**Purpose**: Builds the JSON object inserted into the personal marketplace for a checked-out plugin.

**Data flow**: It creates a JSON object with `name`, `source: { source: "local", path }`, and `policy` fields derived from `plugin_install_policy_value` and `plugin_auth_policy_value`. If `category` is present and non-blank, it inserts a `category` field into the object. It returns the assembled `JsonValue`.

**Call relations**: `update_personal_marketplace` calls this to generate the replacement or appended plugin entry written into the marketplace file.

*Call graph*: called by 1 (update_personal_marketplace); 1 external calls (json!).


##### `plugin_install_policy_value`  (lines 393–399)

```
fn plugin_install_policy_value(policy: PluginInstallPolicy) -> &'static str
```

**Purpose**: Converts a `PluginInstallPolicy` enum into the uppercase string expected in the personal marketplace JSON.

**Data flow**: It matches the input enum and returns one of the static strings `NOT_AVAILABLE`, `AVAILABLE`, or `INSTALLED_BY_DEFAULT`. No state is mutated.

**Call relations**: This helper is used when constructing marketplace plugin entries so local JSON mirrors remote policy semantics.


##### `plugin_auth_policy_value`  (lines 401–406)

```
fn plugin_auth_policy_value(policy: PluginAuthPolicy) -> &'static str
```

**Purpose**: Converts a `PluginAuthPolicy` enum into the uppercase string expected in the personal marketplace JSON.

**Data flow**: It matches the input enum and returns either `ON_INSTALL` or `ON_USE`. It has no side effects.

**Call relations**: `personal_marketplace_plugin_entry` uses this to encode authentication policy into the marketplace file.


##### `personal_marketplace_relative_plugin_path`  (lines 408–449)

```
fn personal_marketplace_relative_plugin_path(
    home: &AbsolutePathBuf,
    local_plugin_path: &AbsolutePathBuf,
) -> Result<String, RemotePluginCatalogError>
```

**Purpose**: Converts an absolute local plugin path into the `./...` relative path syntax stored in the personal marketplace file, while rejecting unsafe or unrepresentable paths.

**Data flow**: It strips `home` from `local_plugin_path`, returning `InvalidPluginPath` if the plugin path is outside the home directory. It then iterates path components: `Normal` components must be valid UTF-8 and are collected; `CurDir` is ignored; `ParentDir`, `RootDir`, and Windows `Prefix` components are rejected. If no segments remain, it rejects the home directory itself. Otherwise it joins the segments with `/`, prefixes `./`, and returns the resulting string.

**Call relations**: Both path validation and marketplace update logic depend on this helper to enforce the invariant that personal marketplace entries always point to safe, home-relative plugin paths.

*Call graph*: calls 2 internal fn (as_path, to_path_buf); called by 2 (ensure_path_can_be_listed_in_personal_marketplace, update_personal_marketplace); 2 external calls (new, format!).


##### `invalid_marketplace_file`  (lines 451–456)

```
fn invalid_marketplace_file(path: &Path, message: &str) -> RemotePluginCatalogError
```

**Purpose**: Creates a standardized `InvalidPluginPath` error describing a malformed personal marketplace file.

**Data flow**: It takes a filesystem `path` and message, clones the path into a `PathBuf`, and returns `RemotePluginCatalogError::InvalidPluginPath { path, reason }`.

**Call relations**: Marketplace parsing and validation helpers use this to report structural problems in `marketplace.json` through a single error shape.

*Call graph*: called by 1 (update_personal_marketplace); 1 external calls (to_path_buf).


##### `write_json_atomically`  (lines 458–470)

```
fn write_json_atomically(write_path: &Path, contents: &str) -> io::Result<()>
```

**Purpose**: Writes marketplace JSON to disk atomically by persisting a temporary file into place.

**Data flow**: It derives the parent directory from `write_path`, errors if none exists, creates the parent directories, creates a `tempfile::NamedTempFile` in that directory, writes `contents` bytes into it, and persists the temp file to `write_path`. It returns `io::Result<()>` from those filesystem operations.

**Call relations**: `update_personal_marketplace` uses this helper so marketplace updates are not left partially written if the process fails mid-write.

*Call graph*: called by 1 (update_personal_marketplace); 3 external calls (parent, create_dir_all, new_in).


### Discovery and connector policy
These files compute connector availability, tool policy, discoverable plugin suggestions, mention parsing, and related utility normalization used by install-suggestion and selection flows.

### `connectors/src/app_tool_policy.rs`

`domain_logic` · `request handling`

This file is the policy engine for app/connector tools. `AppToolPolicy` is the compact result type: a boolean `enabled` flag and an `AppToolApproval` mode. `AppToolPolicyInput` carries the connector id, raw tool name, optional display title, and optional destructive/open-world hints supplied by connector metadata. `AppToolPolicyEvaluator` caches one immutable snapshot of relevant config so callers can evaluate many tools without repeatedly decoding the config layer stack.

Construction starts with `apps_config_from_layer_stack`, which extracts and deserializes the merged unmanaged `[apps]` table from `ConfigLayerStack::effective_config()`. `effective_apps_config` then overlays managed requirements by calling `apply_requirements_apps_constraints`, which currently only forces apps disabled when requirements say `enabled = false`; managed enablement never turns a disabled app back on. `managed_app_tool_approval` separately looks up requirement-driven approval overrides by exact connector id and raw tool name.

`app_tool_policy_from_apps_config` implements the precedence chain. If there is no apps config, the tool defaults enabled with approval from managed requirements or `Auto`. Otherwise it resolves the app, optional tool map, and tool config by raw tool name first and optional `tool_title` second for user config matching. Approval precedence is: managed requirement, per-tool user approval, per-app default tool approval, then `Auto`. Enablement precedence is: app disabled check, explicit per-tool `enabled`, per-app `default_tools_enabled`, then hint-based gating using app or global defaults for `destructive_enabled` and `open_world_enabled`. Missing hints default to `true`, making unknown tools conservative unless explicitly allowed.

#### Function details

##### `AppToolPolicy::default`  (lines 15–20)

```
fn default() -> Self
```

**Purpose**: Defines the baseline policy for a tool when no config or managed requirement overrides apply: enabled with automatic approval behavior.

**Data flow**: Constructs and returns `AppToolPolicy { enabled: true, approval: AppToolApproval::Auto }`.

**Call relations**: Used as the fallback policy in callers and inside policy computation when no stronger rule applies.

*Call graph*: called by 1 (handle_mcp_tool_call).


##### `AppToolPolicyEvaluator::new`  (lines 43–47)

```
fn new(config_layer_stack: &'a ConfigLayerStack) -> Self
```

**Purpose**: Builds a reusable evaluator from a full `ConfigLayerStack` by extracting unmanaged apps config and managed requirements once.

**Data flow**: Reads `config_layer_stack` → obtains `apps_config` via `apps_config_from_layer_stack(config_layer_stack)` → reads `requirements_apps_config` from `config_layer_stack.requirements_toml().apps.as_ref()` → passes both into `Self::from_parts` → returns the evaluator.

**Call relations**: Called by request-handling code before evaluating many tools in one exposure build. It delegates config extraction and normalization to helper functions.

*Call graph*: calls 2 internal fn (requirements_toml, apps_config_from_layer_stack); called by 3 (policy_from_config_parts, handle_mcp_tool_call, filter_codex_apps_mcp_tools); 1 external calls (from_parts).


##### `AppToolPolicyEvaluator::policy`  (lines 49–56)

```
fn policy(&self, input: AppToolPolicyInput<'_>) -> AppToolPolicy
```

**Purpose**: Computes the effective policy for one tool input using the evaluator’s cached config snapshot.

**Data flow**: Consumes `input: AppToolPolicyInput` → computes `managed_approval` with `managed_app_tool_approval(self.requirements_apps_config, input.connector_id, input.tool_name)` → passes `self.apps_config.as_ref()`, the input, and managed approval into `app_tool_policy_from_apps_config` → returns `AppToolPolicy`.

**Call relations**: This is the evaluator’s main public method, called once per tool by higher-level filtering and invocation code.

*Call graph*: calls 2 internal fn (app_tool_policy_from_apps_config, managed_app_tool_approval).


##### `AppToolPolicyEvaluator::from_parts`  (lines 58–66)

```
fn from_parts(
        apps_config: Option<AppsConfigToml>,
        requirements_apps_config: Option<&'a AppsRequirementsToml>,
    ) -> Self
```

**Purpose**: Internal/test-facing constructor that builds an evaluator from already-separated unmanaged apps config and managed requirements.

**Data flow**: Accepts `apps_config: Option<AppsConfigToml>` and `requirements_apps_config: Option<&AppsRequirementsToml>` → computes merged effective apps config with `effective_apps_config` → stores that plus the requirements reference in `Self` → returns the evaluator.

**Call relations**: Used by `new` in production and directly by tests that want to bypass `ConfigLayerStack` setup.

*Call graph*: calls 1 internal fn (effective_apps_config); called by 1 (evaluator_reuses_one_snapshot_across_tools).


##### `apps_config_from_layer_stack`  (lines 70–79)

```
fn apps_config_from_layer_stack(
    config_layer_stack: &ConfigLayerStack,
) -> Option<AppsConfigToml>
```

**Purpose**: Extracts and deserializes the merged unmanaged `[apps]` section from a config-layer stack.

**Data flow**: Reads `config_layer_stack.effective_config()`, accesses it as a table, looks up key `"apps"`, clones the value if present, and attempts `AppsConfigToml::deserialize(value).ok()` → returns `Option<AppsConfigToml>`.

**Call relations**: Called only by `AppToolPolicyEvaluator::new` as the bridge from generic layered TOML to typed apps config.

*Call graph*: calls 1 internal fn (effective_config); called by 1 (new).


##### `app_is_enabled`  (lines 81–92)

```
fn app_is_enabled(apps_config: &AppsConfigToml, connector_id: Option<&str>) -> bool
```

**Purpose**: Determines whether an app/connector is enabled after considering global app defaults and any per-app override.

**Data flow**: Reads `apps_config.default.as_ref().map(|defaults| defaults.enabled).unwrap_or(true)` as the fallback → if `connector_id` is present and found in `apps_config.apps`, uses that app’s `enabled`; otherwise returns the fallback default.

**Call relations**: Used inside `app_tool_policy_from_apps_config` before any tool-level enablement logic, because a disabled app disables all its tools.

*Call graph*: called by 1 (app_tool_policy_from_apps_config).


##### `effective_apps_config`  (lines 94–106)

```
fn effective_apps_config(
    apps_config: Option<AppsConfigToml>,
    requirements_apps_config: Option<&AppsRequirementsToml>,
) -> Option<AppsConfigToml>
```

**Purpose**: Combines optional unmanaged apps config with managed requirements constraints and suppresses empty results.

**Data flow**: Takes optional `apps_config` and optional requirements → records whether unmanaged config existed, unwraps or defaults the apps config, mutates it via `apply_requirements_apps_constraints`, then returns `Some(apps_config)` if there was original config or the result now contains defaults/apps entries; otherwise returns `None`.

**Call relations**: Called by `AppToolPolicyEvaluator::from_parts` to precompute the evaluator’s effective unmanaged-plus-managed app snapshot.

*Call graph*: calls 1 internal fn (apply_requirements_apps_constraints); called by 1 (from_parts).


##### `apply_requirements_apps_constraints`  (lines 108–122)

```
fn apply_requirements_apps_constraints(
    apps_config: &mut AppsConfigToml,
    requirements_apps_config: Option<&AppsRequirementsToml>,
)
```

**Purpose**: Applies managed app-level constraints into mutable apps config, currently only forcing apps disabled when requirements demand it.

**Data flow**: Accepts mutable `apps_config` and optional `requirements_apps_config` → returns immediately if requirements are absent → iterates `requirements_apps_config.apps` and, for each requirement with `enabled == Some(false)`, inserts or fetches the corresponding app entry and sets `app.enabled = false`.

**Call relations**: Used only by `effective_apps_config` as the mutation step that overlays managed constraints onto user config.

*Call graph*: called by 1 (effective_apps_config).


##### `managed_app_tool_approval`  (lines 124–138)

```
fn managed_app_tool_approval(
    requirements_apps_config: Option<&AppsRequirementsToml>,
    connector_id: Option<&str>,
    tool_name: &str,
) -> Option<AppToolApproval>
```

**Purpose**: Looks up a managed approval override for one exact connector/tool pair from requirements config.

**Data flow**: Takes optional requirements, optional `connector_id`, and `tool_name` → short-circuits to `None` if connector id or requirements are absent → traverses `requirements.apps[connector_id].tools.tools[tool_name].approval_mode` through chained `?` lookups → returns `Option<AppToolApproval>`.

**Call relations**: Called by `AppToolPolicyEvaluator::policy` before user-config evaluation so managed approval can take precedence.

*Call graph*: called by 1 (policy).


##### `app_tool_policy_from_apps_config`  (lines 140–203)

```
fn app_tool_policy_from_apps_config(
    apps_config: Option<&AppsConfigToml>,
    input: AppToolPolicyInput<'_>,
    managed_approval: Option<AppToolApproval>,
) -> AppToolPolicy
```

**Purpose**: Implements the full precedence rules for tool approval and enablement using apps config, managed approval, app defaults, per-tool overrides, and connector metadata hints.

**Data flow**: Accepts optional typed apps config, `AppToolPolicyInput`, and optional managed approval → if apps config is absent, returns default-enabled policy with approval set to managed approval or `Auto` → otherwise resolves the matching app by `connector_id`, optional tools map, and tool config by raw `tool_name` or fallback `tool_title`; computes approval as managed approval, else per-tool approval, else app default tool approval, else `Auto`; if `app_is_enabled(...)` is false returns disabled policy immediately; else if tool config has explicit `enabled`, returns that; else if app has `default_tools_enabled`, returns that; else computes `destructive_enabled` and `open_world_enabled` from app overrides or global defaults, defaults missing input hints to `true`, and enables the tool only when each disabled policy is not contradicted by a true hint → returns `AppToolPolicy { enabled, approval }`.

**Call relations**: Called by `AppToolPolicyEvaluator::policy` for every tool. It is the core decision function and delegates only the app-level enabled check to `app_is_enabled`.

*Call graph*: calls 1 internal fn (app_is_enabled); called by 1 (policy); 1 external calls (default).


### `utils/plugins/src/mcp_connector.rs`

`domain_logic` · `plugin validation and naming`

This file contains two unrelated but compact pieces of plugin support logic. The first is connector admission control. Two static denylist arrays define connector IDs that must not be used: a general list and a narrower list applied when the current login originator is recognized as first-party chat. `is_connector_id_allowed` fetches the current originator from `codex_login`, then delegates to a private helper that selects the appropriate denylist and performs a membership check. The policy is intentionally deny-by-exact-ID rather than pattern-based.

The second piece is name normalization. `sanitize_slug` walks the input string character by character, lowercasing ASCII alphanumerics and replacing every other character with `-`. It then trims leading and trailing dashes; if nothing remains, it returns the fallback slug `app`. `sanitize_name` builds on that slugging rule by replacing dashes with underscores, producing an identifier-like string suitable for contexts that prefer `_` separators. The implementation is deliberately ASCII-centric and deterministic: non-ASCII letters are not preserved, repeated punctuation becomes repeated separators until trimming, and empty or all-symbol names collapse to the same fallback.

#### Function details

##### `is_connector_id_allowed`  (lines 15–17)

```
fn is_connector_id_allowed(connector_id: &str) -> bool
```

**Purpose**: Determines whether a connector ID is permitted for the current login originator. It is the public policy entrypoint used by callers that do not want to reason about originator-specific denylist selection.

**Data flow**: Accepts a connector ID string, reads the current originator via `originator()`, extracts `originator().value.as_str()`, and passes both strings to `is_connector_id_allowed_for_originator`, returning that boolean result.

**Call relations**: Called by higher-level plugin code when evaluating connector availability. It delegates all actual policy branching to `is_connector_id_allowed_for_originator` after obtaining runtime originator state.

*Call graph*: calls 2 internal fn (originator, is_connector_id_allowed_for_originator).


##### `is_connector_id_allowed_for_originator`  (lines 19–27)

```
fn is_connector_id_allowed_for_originator(connector_id: &str, originator_value: &str) -> bool
```

**Purpose**: Applies the connector denylist policy for a specific originator string. First-party chat originators use a dedicated denylist; all others use the general denylist.

**Data flow**: Takes `connector_id` and `originator_value`, calls `is_first_party_chat_originator(originator_value)` to choose between `FIRST_PARTY_CHAT_DISALLOWED_CONNECTOR_IDS` and `DISALLOWED_CONNECTOR_IDS`, then returns the negation of `contains(&connector_id)` on the selected slice.

**Call relations**: Used internally by `is_connector_id_allowed`. It is the actual decision point where originator classification controls which static denylist is consulted.

*Call graph*: calls 1 internal fn (is_first_party_chat_originator); called by 1 (is_connector_id_allowed).


##### `sanitize_name`  (lines 29–31)

```
fn sanitize_name(name: &str) -> String
```

**Purpose**: Converts an arbitrary display name into an underscore-separated normalized identifier. It reuses slug normalization and then swaps separator style.

**Data flow**: Accepts `&str`, calls `sanitize_slug(name)`, replaces every `-` in the resulting slug with `_`, and returns the new `String`.

**Call relations**: Called by `normalize_codex_apps_callable_name` elsewhere in the system. It delegates normalization details to `sanitize_slug` and only changes the final separator character.

*Call graph*: calls 1 internal fn (sanitize_slug); called by 1 (normalize_codex_apps_callable_name).


##### `sanitize_slug`  (lines 33–48)

```
fn sanitize_slug(name: &str) -> String
```

**Purpose**: Normalizes arbitrary text into a lowercase ASCII slug with dash separators and a non-empty fallback. It is the core string-cleaning routine behind connector/app naming.

**Data flow**: Allocates a `String` with capacity equal to the input length, iterates over `name.chars()`, pushes lowercase ASCII alphanumerics unchanged and `-` for every other character, trims leading and trailing `-` from the accumulated string slice, and returns either `"app"` if the trimmed result is empty or the trimmed text as an owned `String`.

**Call relations**: Private helper used by `sanitize_name`. It encapsulates the actual character-by-character normalization policy.

*Call graph*: called by 1 (sanitize_name); 1 external calls (with_capacity).


### `utils/plugins/src/plugin_namespace.rs`

`domain_logic` · `plugin discovery and skill resolution`

This file resolves plugin names from directory structure and manifest contents. It defines `DISCOVERABLE_PLUGIN_MANIFEST_PATHS`, an ordered list of recognized manifest locations beneath a plugin root: `.codex-plugin/plugin.json` first, then `.claude-plugin/plugin.json`. The synchronous helper `find_plugin_manifest_path` simply joins each candidate relative path onto a supplied root and returns the first one that exists as a file.

The async path is more involved because it works through an abstract `ExecutorFileSystem`. `plugin_manifest_name` receives a filesystem handle and an `AbsolutePathBuf` plugin root, probes each discoverable manifest path in order by converting the candidate to `PathUri` and calling `get_metadata`. Once it finds a file, it reads the manifest text with `read_file_text`, deserializes only the `name` field into `RawPluginManifestName`, and computes the final namespace. If the manifest `name` is blank after trimming, it falls back to the plugin root directory's final path component; otherwise it uses the manifest name verbatim. Any metadata, read, or JSON parse failure yields `None` rather than an error.

`plugin_namespace_for_skill_path` walks `path.ancestors()` from the skill file upward and returns the first namespace produced by `plugin_manifest_name`. The embedded tests create temporary plugin layouts to verify both manifest locations and the end-to-end ancestor search.

#### Function details

##### `find_plugin_manifest_path`  (lines 13–18)

```
fn find_plugin_manifest_path(plugin_root: &Path) -> Option<PathBuf>
```

**Purpose**: Searches a plugin root on the local filesystem for the first recognized manifest path. The search order follows `DISCOVERABLE_PLUGIN_MANIFEST_PATHS`.

**Data flow**: Accepts `&Path` `plugin_root`, iterates over the discoverable relative manifest paths, joins each onto the root, and returns the first `PathBuf` whose `is_file()` check succeeds; otherwise it returns `None`.

**Call relations**: Used as a synchronous local-filesystem helper and by tests to confirm manifest discovery order and alternate manifest support.


##### `plugin_manifest_name`  (lines 27–58)

```
async fn plugin_manifest_name(
    fs: &dyn ExecutorFileSystem,
    plugin_root: &AbsolutePathBuf,
) -> Option<String>
```

**Purpose**: Reads the plugin manifest under a candidate root through an `ExecutorFileSystem` and derives the namespace string. It prefers the manifest's `name` field but falls back to the root directory name when that field is blank.

**Data flow**: Takes an executor filesystem and an absolute plugin-root path. It loops over `DISCOVERABLE_PLUGIN_MANIFEST_PATHS`, joins each relative path onto the root, converts the candidate to `PathUri`, and awaits `fs.get_metadata(&candidate_uri, None)` until it finds a file. It then converts the chosen manifest path to `PathUri`, awaits `fs.read_file_text`, parses the JSON into `RawPluginManifestName`, trims the `name`, and returns either the plugin root's final path component or the manifest name as `Some(String)`. Any failure at discovery, read, parse, or fallback-name extraction returns `None`.

**Call relations**: Called from `plugin_namespace_for_skill_path` for each ancestor directory. It orchestrates manifest probing and content parsing but deliberately swallows errors so ancestor search can continue.

*Call graph*: calls 3 internal fn (read_file_text, join, from_abs_path); called by 1 (plugin_namespace_for_skill_path); 3 external calls (get_metadata, from_str, file_name).


##### `plugin_namespace_for_skill_path`  (lines 62–72)

```
async fn plugin_namespace_for_skill_path(
    fs: &dyn ExecutorFileSystem,
    path: &AbsolutePathBuf,
) -> Option<String>
```

**Purpose**: Finds the nearest ancestor directory of a skill path that contains a valid plugin manifest and returns that plugin's namespace. This is the public async entrypoint for skill-to-plugin resolution.

**Data flow**: Accepts an executor filesystem and an absolute skill path, iterates over `path.ancestors()`, awaits `plugin_manifest_name(fs, &ancestor)` for each ancestor, and returns the first `Some(name)` found; if none succeed, it returns `None`.

**Call relations**: Used by higher-level plugin/skill discovery code. It drives the upward ancestor walk and delegates manifest probing and parsing to `plugin_manifest_name` at each step.

*Call graph*: calls 2 internal fn (ancestors, plugin_manifest_name).


##### `tests::uses_manifest_name`  (lines 86–104)

```
async fn uses_manifest_name()
```

**Purpose**: End-to-end test proving that a skill file under a plugin root resolves to the manifest's `name` field. It exercises the default `.codex-plugin/plugin.json` location.

**Data flow**: Creates a temporary directory tree with `plugins/sample/skills/search/SKILL.md` and `.codex-plugin/plugin.json`, writes manifest and skill contents, calls `plugin_namespace_for_skill_path(LOCAL_FS.as_ref(), &skill_path.abs()).await`, and compares the result with `Some("sample".to_string())`.

**Call relations**: Invoked by the async test harness to validate the main ancestor-search and manifest-read path using the local executor filesystem.

*Call graph*: 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `tests::uses_name_from_alternate_discoverable_manifest_path`  (lines 107–124)

```
async fn uses_name_from_alternate_discoverable_manifest_path()
```

**Purpose**: Verifies that the alternate `.claude-plugin/plugin.json` location is recognized and that synchronous manifest discovery returns that path. It confirms both async namespace resolution and local path probing honor the shared manifest list.

**Data flow**: Creates a temporary plugin tree with a skill file and a manifest at `.claude-plugin/plugin.json`, writes both files, awaits `plugin_namespace_for_skill_path(LOCAL_FS.as_ref(), &skill_path.abs())`, and compares the result with `Some("sample".to_string())`; it then calls `find_plugin_manifest_path(&plugin_root)` and compares with the alternate manifest path.

**Call relations**: Run by the async test harness as the alternate-location companion to `uses_manifest_name`, covering both public helpers in one scenario.

*Call graph*: 4 external calls (assert_eq!, create_dir_all, write, tempdir).


### `core/src/connectors.rs`

`domain_logic` · `request handling`

This file is the core connector-discovery module. It defines a process-wide in-memory cache keyed by `chatgpt_base_url`, account identity, ChatGPT user id, and workspace-account status, storing a `Vec<AppInfo>` plus an expiration `Instant`. The public listing functions progressively wire in more dependencies: a simple wrapper returns connectors only, another constructs `ExecServerRuntimePaths` and an `EnvironmentManager`, another creates a `PluginsManager` and `McpManager`, and the deepest routine performs the actual MCP interaction.

`list_accessible_connectors_from_mcp_tools_with_mcp_manager` is the main control-flow hub. It loads auth, short-circuits to an empty ready result when apps are disabled for the current auth mode, checks the cache unless `force_refetch` is set, computes effective MCP servers and keeps only `CODEX_APPS_MCP_SERVER_NAME`, builds auth statuses, then creates an `McpConnectionManager` with a cancellation token and threadless runtime context. It optionally hard-refreshes the Codex Apps tools cache, otherwise reads startup/cached tools, and determines `codex_apps_ready` by probing server readiness immediately or waiting up to either configured startup timeout or a 30-second fallback when no tools are present. If readiness arrives after waiting, it reloads tools.

Tool lists are converted into connector-level `AppInfo` values by filtering to the Codex Apps MCP and collecting connector ids, names, descriptions, and plugin display names. Results are filtered against disallowed connectors, optionally cached, enriched with plugin provenance, and the MCP manager is shut down. Additional helpers compute tool-suggest connector ids from config plus loaded plugin apps, read cached directory connectors for authenticated tool suggestion, apply user and requirements-based enabled/disabled state, and choose an approvals reviewer for app MCP requests while respecting enterprise requirements.

#### Function details

##### `list_accessible_connectors_from_mcp_tools`  (lines 72–82)

```
async fn list_accessible_connectors_from_mcp_tools(
    config: &Config,
) -> anyhow::Result<Vec<AppInfo>>
```

**Purpose**: Returns the current accessible connectors as a plain `Vec<AppInfo>` using default discovery behavior. It is the simplest public entrypoint for callers that do not need readiness status.

**Data flow**: Takes `&Config`, calls the status-returning variant with `force_refetch = false`, awaits it, and extracts the `.connectors` field from `AccessibleConnectorsStatus`. It returns an `anyhow::Result<Vec<AppInfo>>` and does not mutate shared state directly beyond whatever the delegated discovery path does.

**Call relations**: It is used by `lookup_mcp_tool_metadata` when metadata lookup needs the current connector list. All real work is delegated to `list_accessible_connectors_from_mcp_tools_with_options_and_status`.

*Call graph*: calls 1 internal fn (list_accessible_connectors_from_mcp_tools_with_options_and_status); called by 1 (lookup_mcp_tool_metadata).


##### `list_accessible_and_enabled_connectors_from_manager`  (lines 84–95)

```
async fn list_accessible_and_enabled_connectors_from_manager(
    mcp_connection_manager: &McpConnectionManager,
    config: &Config,
) -> Vec<AppInfo>
```

**Purpose**: Builds a connector list from an already-running `McpConnectionManager` and filters it down to connectors that are both accessible and enabled. This avoids spinning up a new MCP environment when a manager already exists.

**Data flow**: Accepts an `&McpConnectionManager` and `&Config`, awaits `list_all_tools`, converts the resulting `ToolInfo` slice into connector-level `AppInfo` values, applies config-based enablement with `with_app_enabled_state`, then filters for `connector.is_accessible && connector.is_enabled`. It returns the filtered `Vec<AppInfo>`.

**Call relations**: It is called by `build_initial_context` while assembling prompt context from an existing MCP manager. It delegates extraction to `accessible_connectors_from_mcp_tools` and policy overlay to `with_app_enabled_state`.

*Call graph*: calls 3 internal fn (list_all_tools, accessible_connectors_from_mcp_tools, with_app_enabled_state); called by 1 (build_initial_context).


##### `list_tool_suggest_discoverable_tools_with_auth`  (lines 97–130)

```
async fn list_tool_suggest_discoverable_tools_with_auth(
    config: &Config,
    plugins_manager: &PluginsManager,
    auth: Option<&CodexAuth>,
    accessible_connectors: &[AppInfo],
    loaded_plug
```

**Purpose**: Combines discoverable connectors and discoverable plugins into the unified `DiscoverableTool` list used by tool suggestion. It merges configured connector ids, plugin-provided app connector ids, directory metadata, accessibility state, and plugin discovery.

**Data flow**: Inputs are `&Config`, `&PluginsManager`, optional `&CodexAuth`, a slice of accessible connectors, and loaded plugin app connector ids. It computes the connector id set, loads cached directory connectors for the authenticated account, merges in plugin connector placeholders, filters to tool-suggest-discoverable connectors using accessibility and originator rules, converts them to `DiscoverableTool`, then appends discoverable plugins from `list_tool_suggest_discoverable_plugins`. It returns the concatenated `Vec<DiscoverableTool>`.

**Call relations**: It is invoked by `built_tools` when constructing tool-suggestion metadata. Its connector half depends on `tool_suggest_connector_ids` and `cached_directory_connectors_for_tool_suggest_with_auth`, while plugin discovery is delegated to the plugin subsystem.

*Call graph*: calls 5 internal fn (filter_tool_suggest_discoverable_connectors, merge_plugin_connectors, cached_directory_connectors_for_tool_suggest_with_auth, tool_suggest_connector_ids, originator); called by 1 (built_tools); 1 external calls (list_tool_suggest_discoverable_plugins).


##### `list_cached_accessible_connectors_from_mcp_tools`  (lines 132–151)

```
async fn list_cached_accessible_connectors_from_mcp_tools(
    config: &Config,
) -> Option<Vec<AppInfo>>
```

**Purpose**: Reads the in-memory accessible-connector cache for the current auth/config identity without contacting MCP. It also applies feature gating and disallowed-connector filtering before returning cached data.

**Data flow**: Takes `&Config`, creates an `AuthManager`, loads current auth, checks whether apps are enabled for that auth backend, and if not returns `Some(Vec::new())`. Otherwise it derives a cache key, reads the cache, and if present filters the cached connectors through `filter_disallowed_connectors` using the current originator. It returns `Option<Vec<AppInfo>>`.

**Call relations**: It is used by `plugin_apps_needing_auth_for_install` and `lookup_mcp_tool_metadata` when a cheap cached answer is sufficient. It delegates identity derivation to `accessible_connectors_cache_key` and cache lookup to `read_cached_accessible_connectors`.

*Call graph*: calls 3 internal fn (accessible_connectors_cache_key, read_cached_accessible_connectors, shared_from_config); called by 2 (plugin_apps_needing_auth_for_install, lookup_mcp_tool_metadata); 1 external calls (new).


##### `refresh_accessible_connectors_cache_from_mcp_tools`  (lines 153–168)

```
fn refresh_accessible_connectors_cache_from_mcp_tools(
    config: &Config,
    auth: Option<&CodexAuth>,
    mcp_tools: &[ToolInfo],
)
```

**Purpose**: Recomputes the accessible connector cache from a fresh MCP tool list. It is a write-through helper used after auth or connector refresh events.

**Data flow**: Receives `&Config`, optional `&CodexAuth`, and a `&[ToolInfo]`. If the Apps feature is disabled it exits early; otherwise it derives the cache key, converts tools into connectors, filters disallowed connectors by originator, and writes the resulting slice into the global cache with a new expiration. It returns no value and mutates the process-wide cache.

**Call relations**: It is called by `refresh_codex_apps_after_connector_auth` and `refresh_missing_requested_connectors` after those flows obtain updated tool inventories. It relies on `accessible_connectors_from_mcp_tools` for aggregation and `write_cached_accessible_connectors` for persistence.

*Call graph*: calls 5 internal fn (filter_disallowed_connectors, accessible_connectors_cache_key, accessible_connectors_from_mcp_tools, write_cached_accessible_connectors, originator); called by 2 (refresh_codex_apps_after_connector_auth, refresh_missing_requested_connectors).


##### `list_accessible_connectors_from_mcp_tools_with_options`  (lines 170–179)

```
async fn list_accessible_connectors_from_mcp_tools_with_options(
    config: &Config,
    force_refetch: bool,
) -> anyhow::Result<Vec<AppInfo>>
```

**Purpose**: Variant of connector listing that exposes the `force_refetch` flag but still returns only connectors. It is a convenience wrapper over the status-returning API.

**Data flow**: Takes `&Config` and a `bool force_refetch`, awaits `list_accessible_connectors_from_mcp_tools_with_options_and_status`, and returns only the `.connectors` vector from the resulting status. Errors from the delegated call are propagated unchanged.

**Call relations**: It is a thin wrapper around `list_accessible_connectors_from_mcp_tools_with_options_and_status`. Callers use it when they need to bypass cache/startup tools but do not care about the readiness bit.

*Call graph*: calls 1 internal fn (list_accessible_connectors_from_mcp_tools_with_options_and_status).


##### `list_accessible_connectors_from_mcp_tools_with_options_and_status`  (lines 181–201)

```
async fn list_accessible_connectors_from_mcp_tools_with_options_and_status(
    config: &Config,
    force_refetch: bool,
) -> anyhow::Result<AccessibleConnectorsStatus>
```

**Purpose**: Creates the execution environment needed for connector discovery and returns both connectors and Codex Apps readiness. It is the top-level discovery entrypoint when the caller does not already own an environment manager.

**Data flow**: Inputs are `&Config` and `force_refetch`. It derives `ExecServerRuntimePaths` from optional executable paths, asynchronously constructs an `EnvironmentManager` rooted at `config.codex_home`, wraps it in `Arc`, and forwards all inputs to the environment-manager variant. It returns `AccessibleConnectorsStatus` or any setup/discovery error.

**Call relations**: It is called by both simpler public wrappers. Its only job is orchestration: prepare runtime paths and environment, then delegate to `list_accessible_connectors_from_mcp_tools_with_environment_manager`.

*Call graph*: calls 3 internal fn (list_accessible_connectors_from_mcp_tools_with_environment_manager, from_codex_home, from_optional_paths); called by 2 (list_accessible_connectors_from_mcp_tools, list_accessible_connectors_from_mcp_tools_with_options); 1 external calls (new).


##### `list_accessible_connectors_from_mcp_tools_with_environment_manager`  (lines 203–217)

```
async fn list_accessible_connectors_from_mcp_tools_with_environment_manager(
    config: &Config,
    force_refetch: bool,
    environment_manager: Arc<EnvironmentManager>,
) -> anyhow::Result<Accessi
```

**Purpose**: Continues connector-discovery setup when an `EnvironmentManager` is already available. It creates plugin and MCP managers and forwards discovery to the deepest implementation.

**Data flow**: Accepts `&Config`, `force_refetch`, and `Arc<EnvironmentManager>`. It constructs a `PluginsManager` rooted at `config.codex_home`, wraps it in `Arc`, creates an `McpManager` from that plugin manager, and calls the MCP-manager variant. It returns the delegated `AccessibleConnectorsStatus`.

**Call relations**: It is called by the options-and-status wrapper. Its role is to instantiate `PluginsManager` and `McpManager` once and pass them into `list_accessible_connectors_from_mcp_tools_with_mcp_manager`.

*Call graph*: calls 3 internal fn (new, list_accessible_connectors_from_mcp_tools_with_mcp_manager, new); called by 1 (list_accessible_connectors_from_mcp_tools_with_options_and_status); 1 external calls (new).


##### `list_accessible_connectors_from_mcp_tools_with_mcp_manager`  (lines 219–368)

```
async fn list_accessible_connectors_from_mcp_tools_with_mcp_manager(
    config: &Config,
    force_refetch: bool,
    environment_manager: Arc<EnvironmentManager>,
    mcp_manager: Arc<McpManager>,
)
```

**Purpose**: Performs full connector discovery against the Codex Apps MCP server, including auth gating, cache reuse, optional hard refresh, readiness waiting, connector extraction, cache updates, and provenance enrichment. This is the central runtime algorithm for app connector availability.

**Data flow**: Inputs are `&Config`, `force_refetch`, `Arc<EnvironmentManager>`, and `Arc<McpManager>`. It loads auth, short-circuits to an empty ready status when apps are disabled for the current auth mode, computes a cache key, loads MCP runtime config and tool plugin provenance, optionally returns cached connectors after disallowed filtering and provenance enrichment, computes effective MCP servers and retains only the Codex Apps server, computes auth statuses, creates an `McpConnectionManager`, optionally hard-refreshes the Codex Apps tools cache, otherwise lists all tools, probes or waits for server readiness, optionally reloads tools after readiness, cancels background work when ready, converts tools to accessible connectors, filters disallowed connectors, writes cache when ready or non-empty, enriches connectors with app-level plugin sources, shuts down the connection manager, and returns `AccessibleConnectorsStatus { connectors, codex_apps_ready }`.

**Call relations**: It is called by `apps_list_response` and by the environment-manager wrapper when a full discovery pass is needed. It delegates to many helpers: cache-key derivation and cache reads/writes, MCP config/auth-status computation, tool-to-connector aggregation, disallowed filtering, provenance enrichment, and MCP manager lifecycle methods for refresh, readiness waiting, listing, and shutdown.

*Call graph*: calls 11 internal fn (new, new, filter_disallowed_connectors, accessible_connectors_cache_key, accessible_connectors_from_mcp_tools, read_cached_accessible_connectors, with_app_plugin_sources, write_cached_accessible_connectors, originator, shared_from_config (+1 more)); called by 2 (apps_list_response, list_accessible_connectors_from_mcp_tools_with_environment_manager); 11 external calls (new, new, auth_keyring_backend_kind, unbounded, default, codex_apps_tools_cache_key, compute_auth_statuses, effective_mcp_servers, host_owned_codex_apps_enabled, tool_plugin_provenance (+1 more)).


##### `accessible_connectors_cache_key`  (lines 370–383)

```
fn accessible_connectors_cache_key(
    config: &Config,
    auth: Option<&CodexAuth>,
) -> AccessibleConnectorsCacheKey
```

**Purpose**: Builds the identity key used for the global accessible-connector cache. The key separates connector visibility by backend URL and authenticated account identity.

**Data flow**: Takes `&Config` and optional `&CodexAuth`, reads `config.chatgpt_base_url`, extracts `account_id`, `chatgpt_user_id`, and workspace-account status from auth when present, and returns an `AccessibleConnectorsCacheKey` containing those fields.

**Call relations**: It is used whenever the cache is read or written: by the main discovery path, the cached-read helper, and explicit cache refreshes. This keeps all cache accesses partitioned by the same auth-sensitive dimensions.

*Call graph*: called by 3 (list_accessible_connectors_from_mcp_tools_with_mcp_manager, list_cached_accessible_connectors_from_mcp_tools, refresh_accessible_connectors_cache_from_mcp_tools).


##### `read_cached_accessible_connectors`  (lines 385–403)

```
fn read_cached_accessible_connectors(
    cache_key: &AccessibleConnectorsCacheKey,
) -> Option<Vec<AppInfo>>
```

**Purpose**: Reads the single-entry global connector cache if it is still fresh and matches the requested key. It also clears expired cache contents eagerly.

**Data flow**: Accepts `&AccessibleConnectorsCacheKey`, locks `ACCESSIBLE_CONNECTORS_CACHE`, gets `Instant::now()`, and if the stored entry exists, returns a cloned connector vector when the key matches and the entry has not expired. If the entry is expired it clears the cache slot; otherwise it returns `None`.

**Call relations**: It is called by the main discovery path and by the public cached-read helper. Those callers rely on it to enforce TTL and key matching before using cached connector data.

*Call graph*: called by 2 (list_accessible_connectors_from_mcp_tools_with_mcp_manager, list_cached_accessible_connectors_from_mcp_tools); 1 external calls (now).


##### `write_cached_accessible_connectors`  (lines 405–417)

```
fn write_cached_accessible_connectors(
    cache_key: AccessibleConnectorsCacheKey,
    connectors: &[AppInfo],
)
```

**Purpose**: Stores a fresh connector list in the global cache with the standard TTL. It overwrites any previous cached entry unconditionally.

**Data flow**: Takes an owned `AccessibleConnectorsCacheKey` and a connector slice, locks `ACCESSIBLE_CONNECTORS_CACHE`, constructs `CachedAccessibleConnectors` with `expires_at = Instant::now() + codex_connectors::CONNECTORS_CACHE_TTL` and `connectors = connectors.to_vec()`, and writes it into the cache slot. It returns no value.

**Call relations**: It is used by the main discovery path after successful or partially useful discovery and by explicit cache refreshes from fresh tool lists. It is the sole writer for the in-memory accessible-connector cache.

*Call graph*: called by 2 (list_accessible_connectors_from_mcp_tools_with_mcp_manager, refresh_accessible_connectors_cache_from_mcp_tools); 2 external calls (now, to_vec).


##### `tool_suggest_connector_ids`  (lines 419–444)

```
fn tool_suggest_connector_ids(
    config: &Config,
    loaded_plugin_app_connector_ids: &[String],
) -> HashSet<String>
```

**Purpose**: Computes the set of connector ids eligible for tool suggestion by combining loaded plugin app connectors with configured discoverables and then removing explicitly disabled connector suggestions. The result is a deduplicated `HashSet<String>`.

**Data flow**: Inputs are `&Config` and a slice of loaded plugin app connector ids. It starts with those loaded ids, extends the set with `config.tool_suggest.discoverables` entries whose kind is `Connector`, builds a second set from `disabled_tools` entries of the same kind, and retains only connector ids not present in the disabled set. It returns the filtered `HashSet<String>`.

**Call relations**: It is called by `list_tool_suggest_discoverable_tools_with_auth` as the first step in assembling discoverable connectors. That caller then uses the resulting id set to merge directory and plugin connector metadata.

*Call graph*: called by 1 (list_tool_suggest_discoverable_tools_with_auth).


##### `cached_directory_connectors_for_tool_suggest_with_auth`  (lines 447–484)

```
async fn cached_directory_connectors_for_tool_suggest_with_auth(
    config: &Config,
    auth: Option<&CodexAuth>,
) -> Vec<AppInfo>
```

**Purpose**: Loads connector directory metadata from the on-disk cache for the authenticated Codex backend account, if apps are enabled and the auth context is usable. It avoids network work and returns an empty list when prerequisites are missing.

**Data flow**: Takes `&Config` and optional `&CodexAuth`. It first checks the Apps feature flag, then either uses the provided auth or loads auth through `AuthManager`, rejects non-Codex-backend auth, requires a non-empty account id, computes workspace-account status, builds a `ConnectorDirectoryCacheContext` from `config.codex_home` and a `ConnectorDirectoryCacheKey`, and reads cached directory connectors with `unwrap_or_default()`. It returns a `Vec<AppInfo>`.

**Call relations**: It is called by `list_tool_suggest_discoverable_tools_with_auth` to supply richer connector metadata for tool suggestion. The function is instrumented for tracing because it is part of the discoverability pipeline and may silently fall back to empty results.

*Call graph*: calls 3 internal fn (new, new, shared_from_config); called by 1 (list_tool_suggest_discoverable_tools_with_auth); 2 external calls (new, cached_directory_connectors).


##### `accessible_connectors_from_mcp_tools`  (lines 486–502)

```
fn accessible_connectors_from_mcp_tools(mcp_tools: &[ToolInfo]) -> Vec<AppInfo>
```

**Purpose**: Aggregates raw MCP tool entries into connector-level `AppInfo` records for the Codex Apps MCP server. It preserves connector names, namespace descriptions, and plugin display names carried on `ToolInfo`.

**Data flow**: Accepts a `&[ToolInfo]`, iterates over tools, keeps only those whose `server_name` equals `CODEX_APPS_MCP_SERVER_NAME`, skips tools without `connector_id`, maps each remaining tool into `AccessibleConnectorTool { connector_id, connector_name, connector_description, plugin_display_names }`, and passes the iterator to `collect_accessible_connectors`. It returns the collected `Vec<AppInfo>`.

**Call relations**: It is a shared extraction helper used by manager-based listing, full discovery, cache refresh, skill/plugin building, and missing-connector refresh flows. Those callers depend on it to collapse many tool rows into one connector entry per app.

*Call graph*: calls 1 internal fn (collect_accessible_connectors); called by 5 (list_accessible_and_enabled_connectors_from_manager, list_accessible_connectors_from_mcp_tools_with_mcp_manager, refresh_accessible_connectors_cache_from_mcp_tools, build_skills_and_plugins, refresh_missing_requested_connectors); 1 external calls (iter).


##### `with_app_enabled_state`  (lines 504–528)

```
fn with_app_enabled_state(mut connectors: Vec<AppInfo>, config: &Config) -> Vec<AppInfo>
```

**Purpose**: Overlays user config and requirements constraints onto a connector list's `is_enabled` flags. User app settings can enable or disable by default or per connector, while requirements can force-disable specific connectors.

**Data flow**: Takes ownership of `Vec<AppInfo>` plus `&Config`. It reads user apps config from the layer stack and requirements apps config from `requirements_toml`; if neither exists it returns the input unchanged. Otherwise it mutates each connector: user config may set `is_enabled` via `app_is_enabled`, and requirements entries with `enabled = false` force `is_enabled = false`. It returns the mutated vector.

**Call relations**: It is used broadly wherever connector lists are exposed or folded into prompt/tool state, including app listing, connector listing, initial context building, and refresh flows. It delegates user-policy evaluation to `app_is_enabled` and layer extraction to `apps_config_from_layer_stack`.

*Call graph*: called by 6 (apps_list_response, list_connectors, list_accessible_and_enabled_connectors_from_manager, build_skills_and_plugins, built_tools, refresh_missing_requested_connectors); 2 external calls (app_is_enabled, apps_config_from_layer_stack).


##### `with_app_plugin_sources`  (lines 530–540)

```
fn with_app_plugin_sources(
    mut connectors: Vec<AppInfo>,
    tool_plugin_provenance: &ToolPluginProvenance,
) -> Vec<AppInfo>
```

**Purpose**: Enriches connector records with app-level plugin display names derived from tool provenance. This ensures connector listings reflect which plugins contributed the app tools.

**Data flow**: Accepts a mutable `Vec<AppInfo>` and a `&ToolPluginProvenance`. For each connector it replaces `connector.plugin_display_names` with the provenance lookup result for that connector id, converted to a `Vec<String>`. It returns the updated connector vector.

**Call relations**: It is used by the full discovery path both when serving cached connectors and after fresh MCP discovery. That caller applies this enrichment after accessibility/disallowed filtering so the final connector list carries plugin-source metadata.

*Call graph*: calls 1 internal fn (plugin_display_names_for_connector_id); called by 1 (list_accessible_connectors_from_mcp_tools_with_mcp_manager).


##### `mcp_approvals_reviewer`  (lines 542–574)

```
fn mcp_approvals_reviewer(
    config: &Config,
    server_name: &str,
    connector_id: Option<&str>,
) -> ApprovalsReviewer
```

**Purpose**: Chooses the approvals reviewer to use for an MCP request, preferring app-specific or app-default reviewer settings for the Codex Apps server when those settings are allowed by requirements. Otherwise it falls back to the global config reviewer.

**Data flow**: Inputs are `&Config`, `server_name`, and optional `connector_id`. If the server is the Codex Apps MCP, it reads apps config from the layer stack and looks up a connector-specific `approvals_reviewer`, falling back to the apps default reviewer. If a candidate reviewer exists and `config.config_layer_stack.requirements().approvals_reviewer.can_set(&reviewer)` succeeds, it returns that reviewer; otherwise it returns `config.approvals_reviewer`.

**Call relations**: It is called by `review_guardian_mcp_elicitation` and recursively referenced in the call graph for reviewer selection logic. Its role is to inject app-aware reviewer policy while still honoring enterprise requirements constraints.

*Call graph*: called by 2 (mcp_approvals_reviewer, review_guardian_mcp_elicitation); 1 external calls (apps_config_from_layer_stack).


### `core-plugins/src/discoverable.rs`

`domain_logic` · `plugin discovery / suggestion generation`

This file defines the data contract for tool-suggestion discovery and the `PluginsManager` method that produces it. `ToolSuggestPluginDiscoveryInput` carries the effective plugin configuration plus three precomputed `HashSet<String>` collections: configured plugin ids, disabled plugin ids, and app connector ids already loaded elsewhere. `ToolSuggestDiscoverablePlugin` is the normalized output shape used by callers: local and remote ids, display metadata, a `has_skills` flag, MCP server names, and app connector ids.

`PluginsManager::list_tool_suggest_discoverable_plugins` first short-circuits when plugins are globally disabled. It then lists marketplaces with curated catalogs included, optionally loads cached remote-installed marketplaces when remote plugins are enabled, and iterates local marketplace entries. Local plugins are skipped if already installed, marked `NotAvailable`, explicitly disabled, or neither configured nor on the fallback allowlist. For survivors it loads full plugin detail, converts it into `PluginCapabilitySummary`, and emits a discoverable record; failures are logged and ignored.

If remote plugins are enabled, the method also derives installed app connector ids from currently loaded plugin capability summaries plus caller-supplied loaded app ids, and collects installed remote plugin ids from the remote-installed cache. It then scans cached global remote discoverable plugins, skipping entries already installed, admin-disabled, not available, disabled by config, or unrelated to configured/fallback/installed-app criteria. Accepted remote entries are appended with empty MCP server names. Finally, the combined list is sorted by display name then id. The helper `is_tool_suggest_fallback_plugin` implements the curated fallback policy, including a compatibility rule that treats `openai-api-curated` ids as fallback-eligible when their equivalent `openai-curated` id is allowlisted.

#### Function details

##### `PluginsManager::list_tool_suggest_discoverable_plugins`  (lines 70–200)

```
async fn list_tool_suggest_discoverable_plugins(
        &self,
        input: &ToolSuggestPluginDiscoveryInput,
        auth: Option<&CodexAuth>,
    ) -> anyhow::Result<Vec<ToolSuggestDiscoverablePl
```

**Purpose**: Builds the complete discoverable-plugin list used for tool suggestions from local marketplaces and cached remote catalog data. It enforces feature flags and multiple eligibility filters so only installable, relevant suggestions are returned.

**Data flow**: Reads `&self`, `input: &ToolSuggestPluginDiscoveryInput`, and optional `auth` → if `plugins_enabled` is false returns an empty vector immediately; otherwise reads marketplace listings from `list_marketplaces_for_config`, optionally reads cached remote-installed marketplaces, iterates local marketplace plugins and filters by installed state, install policy, disabled ids, configured ids, and fallback allowlist, then asynchronously loads plugin details and converts them into `ToolSuggestDiscoverablePlugin` values; if remote plugins are enabled, it also reads currently loaded plugin capability summaries and cached remote discoverable plugins, derives installed app connector ids and installed remote ids, filters remote entries by install policy, availability, disabled/configured/fallback/app-match criteria, appends normalized remote suggestions, sorts the final vector by `name` then `id`, and returns it as `anyhow::Result<Vec<_>>`. On local detail-load failures it emits `warn!` logs but continues.

**Call relations**: Invoked by higher-level suggestion flows through `PluginsManager`. Internally it depends on `is_tool_suggest_fallback_plugin` to recognize allowlisted fallback ids and delegates marketplace/detail retrieval to other manager methods so this function remains the policy layer that merges and filters local plus remote candidates.

*Call graph*: calls 1 internal fn (is_tool_suggest_fallback_plugin); 3 external calls (new, new, warn!).


##### `is_tool_suggest_fallback_plugin`  (lines 203–220)

```
fn is_tool_suggest_fallback_plugin(plugin_id: &str) -> bool
```

**Purpose**: Determines whether a plugin id is eligible as a fallback suggestion even when it is not explicitly configured. It recognizes both directly allowlisted ids and API-curated ids whose default curated counterpart is allowlisted.

**Data flow**: Takes `plugin_id: &str` → first checks membership in the static `TOOL_SUGGEST_DISCOVERABLE_PLUGIN_ALLOWLIST`; if absent, attempts `PluginId::parse`, rejects invalid ids and non-`OPENAI_API_CURATED_MARKETPLACE_NAME` marketplaces, otherwise formats `<plugin_name>@<OPENAI_CURATED_MARKETPLACE_NAME>` and checks that derived id against the allowlist → returns `bool` without mutating state.

**Call relations**: Called from `PluginsManager::list_tool_suggest_discoverable_plugins` for both local and remote filtering so the main discovery routine can admit curated fallback plugins even when they are not configured.

*Call graph*: calls 1 internal fn (parse); called by 1 (list_tool_suggest_discoverable_plugins); 1 external calls (format!).


### `core/src/plugins/discoverable.rs`

`orchestration` · `request handling`

This file contains a single traced async function that prepares `ToolSuggestPluginDiscoveryInput` from `crate::config::Config` and forwards it to `codex_core_plugins::PluginsManager`. The input is assembled from three config-derived sets: explicitly configured discoverable plugin IDs from `tool_suggest.discoverables`, disabled plugin IDs from `tool_suggest.disabled_tools`, and already loaded app connector IDs supplied by the caller. In both config-derived cases it filters entries to `ToolSuggestDiscoverableType::Plugin`, so non-plugin discoverables or disabled tools are ignored here. It also passes through `config.plugins_config_input()`, which encapsulates broader plugin feature and marketplace settings.

After awaiting the manager call, the function maps each returned plugin record into `codex_tools::DiscoverablePluginInfo`, preserving the plugin ID, optional remote plugin ID, display name, optional description, skill presence flag, MCP server names, and app connector IDs. The function does not add policy of its own beyond set construction and type filtering; all ranking, availability, and remote/local catalog logic remains in `PluginsManager`. The `#[instrument(skip_all)]` annotation makes the discovery step visible in tracing without logging potentially large or sensitive arguments.

#### Function details

##### `list_tool_suggest_discoverable_plugins`  (lines 11–55)

```
async fn list_tool_suggest_discoverable_plugins(
    config: &Config,
    plugins_manager: &PluginsManager,
    auth: Option<&CodexAuth>,
    loaded_plugin_app_connector_ids: &[String],
) -> anyhow::R
```

**Purpose**: Collects plugin-discovery inputs from config and current runtime state, asks `PluginsManager` for discoverable plugins, and converts the result into `Vec<DiscoverablePluginInfo>`. It is the public adapter used by higher-level tool-suggestion flows.

**Data flow**: Inputs are `&Config`, `&PluginsManager`, optional `&CodexAuth`, and a slice of loaded plugin app connector IDs. It reads plugin-related config via `plugins_config_input()`, filters `tool_suggest.discoverables` and `tool_suggest.disabled_tools` down to plugin IDs and collects them into `HashSet<String>`, clones the loaded connector IDs into another `HashSet<String>`, constructs `ToolSuggestPluginDiscoveryInput`, awaits `plugins_manager.list_tool_suggest_discoverable_plugins(&input, auth)`, then maps each returned plugin into a `DiscoverablePluginInfo` with copied fields. It returns `anyhow::Result<Vec<DiscoverablePluginInfo>>`.

**Call relations**: Higher-level plugin suggestion code calls this when it needs the current discoverable plugin list. The function delegates all substantive discovery logic to `PluginsManager`; its own role is shaping caller state into the manager's expected input and normalizing the output type.

*Call graph*: 2 external calls (plugins_config_input, list_tool_suggest_discoverable_plugins).


### `core/src/plugins/mentions.rs`

`domain_logic` · `request handling`

This module works with both structured `UserInput::Mention` items and plaintext markdown-style links embedded in `UserInput::Text`. `CollectedToolMentions` is a small internal container holding two `HashSet<String>` collections: plain mention names and mention paths. `collect_tool_mentions_from_messages` is the default `$`-sigil entrypoint for tool mentions, while the private `collect_tool_mentions_from_messages_with_sigil` performs the actual loop over message strings, calling `extract_tool_mentions_with_sigil` and extending the two sets from each parsed result.

`collect_explicit_app_ids` first extracts all text bodies from the input, then chains together structured mention paths and plaintext-linked tool paths found with the default tool sigil. It filters those paths by `tool_kind_for_path(...) == ToolMentionKind::App`, converts valid app paths with `app_id_from_path`, and returns a deduplicated `HashSet<String>` of app IDs.

`collect_explicit_plugin_mentions` mirrors that flow for plugins but uses `PLUGIN_TEXT_MENTION_SIGIL` (`@`) when scanning plaintext links, intentionally ignoring `$`-prefixed plugin links. It short-circuits when the available plugin list is empty or when no plugin config names were mentioned. Matching is done against each `PluginCapabilitySummary.config_name`, and matching summaries are cloned into the result vector.

Finally, `build_connector_slug_counts` computes a frequency map from connector mention slug to occurrence count using `connector_mention_slug`, supporting downstream disambiguation logic when multiple connectors share the same slug.

#### Function details

##### `collect_tool_mentions_from_messages`  (lines 23–25)

```
fn collect_tool_mentions_from_messages(messages: &[String]) -> CollectedToolMentions
```

**Purpose**: Parses plaintext tool mentions from message strings using the default tool sigil. It is the public convenience wrapper for ordinary `$...` tool-link extraction.

**Data flow**: It takes a slice of message strings and forwards them with `TOOL_MENTION_SIGIL` to `collect_tool_mentions_from_messages_with_sigil`. It returns the resulting `CollectedToolMentions` unchanged.

**Call relations**: This helper is used by app-mention collection and related skill-item logic elsewhere. It delegates all parsing and set-building work to the sigil-parameterized helper.

*Call graph*: calls 1 internal fn (collect_tool_mentions_from_messages_with_sigil); called by 2 (collect_explicit_app_ids, collect_explicit_app_ids_from_skill_items).


##### `collect_tool_mentions_from_messages_with_sigil`  (lines 27–39)

```
fn collect_tool_mentions_from_messages_with_sigil(
    messages: &[String],
    sigil: char,
) -> CollectedToolMentions
```

**Purpose**: Scans message text for linked mentions using a caller-specified sigil and accumulates both plain names and paths into deduplicated sets. It is the shared parser backend for tool and plugin plaintext mentions.

**Data flow**: Inputs are a slice of message strings and a `char` sigil. It initializes empty `HashSet<String>` collections for `plain_names` and `paths`, loops over each message, calls `extract_tool_mentions_with_sigil(message, sigil)`, extends `plain_names` from `mentions.plain_names()` and `paths` from `mentions.paths()` after converting `&str` to owned `String`, and returns `CollectedToolMentions { plain_names, paths }`.

**Call relations**: The default tool wrapper and plugin-mention collector both call this with different sigils. It delegates the actual syntax parsing to `extract_tool_mentions_with_sigil` and focuses on deduplication across messages.

*Call graph*: calls 1 internal fn (extract_tool_mentions_with_sigil); called by 2 (collect_explicit_plugin_mentions, collect_tool_mentions_from_messages); 1 external calls (new).


##### `collect_explicit_app_ids`  (lines 41–60)

```
fn collect_explicit_app_ids(input: &[UserInput]) -> HashSet<String>
```

**Purpose**: Collects all explicitly mentioned app IDs from mixed structured mentions and plaintext linked mentions. It filters out non-app paths before extracting IDs.

**Data flow**: It accepts a slice of `UserInput`. First it gathers all `UserInput::Text` contents into a `Vec<String>`. Then it iterates the original input again, taking `path` from each `UserInput::Mention`, chains those paths with the plaintext mention paths returned by `collect_tool_mentions_from_messages(&messages)`, filters to paths whose `tool_kind_for_path` is `ToolMentionKind::App`, converts each surviving path with `app_id_from_path`, turns borrowed IDs into owned `String`s, and collects them into a deduplicated `HashSet<String>`.

**Call relations**: The skill/plugin assembly flow calls this when deciding which app connectors were explicitly referenced by the user. It delegates plaintext parsing to `collect_tool_mentions_from_messages` and path classification/extraction to the injection-path helpers.

*Call graph*: calls 1 internal fn (collect_tool_mentions_from_messages); called by 1 (build_skills_and_plugins); 1 external calls (iter).


##### `collect_explicit_plugin_mentions`  (lines 63–103)

```
fn collect_explicit_plugin_mentions(
    input: &[UserInput],
    plugins: &[PluginCapabilitySummary],
) -> Vec<PluginCapabilitySummary>
```

**Purpose**: Finds explicitly mentioned plugins in user input and returns the matching `PluginCapabilitySummary` entries from the available plugin list. It supports structured `plugin://...` mentions and plaintext `@`-sigil plugin links.

**Data flow**: Inputs are a slice of `UserInput` and a slice of available `PluginCapabilitySummary`. If `plugins` is empty it returns `Vec::new()`. Otherwise it collects all text bodies into a `Vec<String>`, gathers structured mention paths from `UserInput::Mention`, chains them with plaintext mention paths extracted from those messages using `collect_tool_mentions_from_messages_with_sigil(..., PLUGIN_TEXT_MENTION_SIGIL)`, filters to paths classified as `ToolMentionKind::Plugin`, converts each path to a plugin config name with `plugin_config_name_from_path`, and collects those names into a `HashSet<String>`. If that set is empty it returns `Vec::new()`; otherwise it filters `plugins` to summaries whose `config_name` is in the set, clones them, and returns the resulting vector.

**Call relations**: The higher-level `build_skills_and_plugins` flow calls this after it has an available plugin inventory. It delegates plaintext parsing to the sigil-aware helper and uses path helpers to distinguish plugin mentions from other linked paths.

*Call graph*: calls 1 internal fn (collect_tool_mentions_from_messages_with_sigil); called by 1 (build_skills_and_plugins); 4 external calls (new, iter, is_empty, iter).


##### `build_connector_slug_counts`  (lines 107–116)

```
fn build_connector_slug_counts(
    connectors: &[connectors::AppInfo],
) -> HashMap<String, usize>
```

**Purpose**: Counts how many connectors share each mention slug. This supports downstream logic that needs to detect ambiguous connector slugs.

**Data flow**: It takes a slice of `connectors::AppInfo`, initializes an empty `HashMap<String, usize>`, loops over each connector, computes its slug with `connector_mention_slug`, increments the corresponding counter with `entry(...).or_insert(0)`, and returns the completed map.

**Call relations**: Plugin/skill assembly code and related app-ID collection helpers call this when they need connector-slug frequency information. It delegates slug derivation to connector metadata code and performs only counting locally.

*Call graph*: calls 1 internal fn (connector_mention_slug); called by 2 (build_skills_and_plugins, collect_explicit_app_ids_from_skill_items); 1 external calls (new).


### `core/src/plugins/mod.rs`

`orchestration` · `cross-cutting`

This module is a pure namespace and re-export hub for the core plugin pipeline. It declares four implementation submodules—`discoverable`, `injection`, `mentions`, and `render`—plus a `test_support` module compiled only for tests. The file itself contains no executable logic; its job is to present a curated internal API to the rest of `codex-core` so callers do not need to know which submodule owns each piece of plugin behavior.

The exported items reveal the plugin workflow. Mention-analysis functions from `mentions` extract explicit plugin references, app IDs, tool mentions from messages, and aggregate connector slug or skill-name counts. Those counts and mentions feed later stages that decide what plugin capabilities are relevant. `list_tool_suggest_discoverable_plugins` exposes discovery logic for plugins that can be suggested to the user, while `build_plugin_injections` constructs the concrete injected data or prompt fragments needed to activate plugin behavior in a turn. `render_explicit_plugin_instructions` turns explicit plugin selections into user/model-facing instruction text. The module also re-exports `codex_plugin::PluginCapabilitySummary`, making the shared capability summary type part of the internal plugin API. The design keeps plugin-related concerns grouped while allowing each concern—parsing, discovery, injection, rendering—to evolve independently behind this façade.


### Install suggestion tools
These files define the model-facing tool specs and request payloads for listing installable plugins/connectors and prompting the user to install them, then orchestrate the runtime install-suggestion flow.

### `core/src/tools/handlers/list_available_plugins_to_install_spec.rs`

`config` · `tool registration`

This file is a compact spec builder for `list_available_plugins_to_install`. `create_list_available_plugins_to_install_tool` assembles a long markdown description that tells the model to use the tool only when the user explicitly asks for a plugin or connector that is not already available and when `tool_search` is unavailable or has already failed to make the requested tool callable. The description also explains that the returned candidates can be passed to `request_plugin_install`, and that plugins should be preferred over connectors when both match unless the plugin is already installed.

The resulting `ToolSpec::Function(ResponsesApiTool)` uses the constant `LIST_AVAILABLE_PLUGINS_TO_INSTALL_TOOL_NAME`, sets `strict: false`, leaves `defer_loading` unset, and declares an empty object parameter schema via `JsonSchema::object(Default::default(), Some(Vec::new()), Some(false.into()))`. There is no explicit output schema, so consumers rely on the runtime implementation's JSON text output. The included test locks down the exact wire shape and description text so changes to this guidance or schema are deliberate.

#### Function details

##### `create_list_available_plugins_to_install_tool`  (lines 7–20)

```
fn create_list_available_plugins_to_install_tool() -> ToolSpec
```

**Purpose**: Builds the complete `ToolSpec` for the install-candidate listing tool, including detailed usage instructions for the model.

**Data flow**: Formats a markdown description string that interpolates `TOOL_SEARCH_TOOL_NAME` and `REQUEST_PLUGIN_INSTALL_TOOL_NAME`, constructs a `ResponsesApiTool` with the fixed list-tool name, `strict: false`, no deferred loading, an empty-object parameter schema from `JsonSchema::object`, and `output_schema: None`, then wraps it in `ToolSpec::Function` and returns it.

**Call relations**: It is called by `ListAvailablePluginsToInstallHandler::spec` so the runtime exposes this exact guidance and schema.

*Call graph*: calls 1 internal fn (object); called by 1 (spec); 4 external calls (default, new, format!, Function).


##### `tests::create_list_available_plugins_to_install_tool_uses_expected_wire_shape`  (lines 28–44)

```
fn create_list_available_plugins_to_install_tool_uses_expected_wire_shape()
```

**Purpose**: Pins the exact tool spec, including the full description text and empty parameter schema.

**Data flow**: Calls `create_list_available_plugins_to_install_tool()` and asserts equality with a manually constructed `ToolSpec::Function(ResponsesApiTool)` containing the expected name, description, flags, and schema.

**Call relations**: This test guards the declarative contract in this file rather than any runtime execution path.

*Call graph*: 1 external calls (assert_eq!).


### `core/src/tools/handlers/list_available_plugins_to_install.rs`

`domain_logic` · `request handling`

The main type here is `ListAvailablePluginsToInstallHandler`, which owns a `Vec<RequestPluginInstallEntry>`. Its constructor sorts that vector first by `name` and then by `id`, ensuring stable, deterministic output regardless of input order. The private `result` method then builds a fresh `ListAvailablePluginsToInstallResult` by cloning each entry field-by-field rather than returning the stored vector directly. During that copy it truncates any `description` to `MAX_LIST_AVAILABLE_PLUGINS_TO_INSTALL_DESCRIPTION_CHARS` characters using `truncate_to_char_boundary`, which preserves UTF-8 correctness by cutting only at character boundaries.

As a `ToolExecutor`, the handler advertises the plain built-in tool name from `codex_tools::LIST_AVAILABLE_PLUGINS_TO_INSTALL_TOOL_NAME`, uses the companion spec builder for its `ToolSpec`, and explicitly disables parallel calls by returning `false`. Execution is delegated from `handle` into `handle_call`. That method accepts only `ToolPayload::Function`; any other payload is treated as a fatal internal misuse and returned as `FunctionCallError::Fatal` with the tool name embedded in the message. On valid input it serializes `self.result()` with `serde_json::to_string`, maps serialization failures to another fatal error, and wraps the JSON string in `FunctionToolOutput::from_text(..., Some(true))`. The included tests verify the no-parallel-calls policy and the exact sorting/truncation behavior.

#### Function details

##### `ListAvailablePluginsToInstallHandler::new`  (lines 23–30)

```
fn new(mut tools: Vec<RequestPluginInstallEntry>) -> Self
```

**Purpose**: Constructs the handler and normalizes candidate ordering up front.

**Data flow**: Takes ownership of a mutable `Vec<RequestPluginInstallEntry>`, sorts it by `name` and then `id`, stores the sorted vector in the handler, and returns `Self`.

**Call relations**: It is used during core utility-tool registration and in tests. By sorting once here, later calls to `result` and `handle_call` can assume deterministic ordering.

*Call graph*: called by 2 (result_truncates_candidate_descriptions, add_core_utility_tools).


##### `ListAvailablePluginsToInstallHandler::result`  (lines 32–54)

```
fn result(&self) -> ListAvailablePluginsToInstallResult
```

**Purpose**: Builds the model-facing result payload from the stored install candidates, truncating descriptions as needed.

**Data flow**: Reads `self.tools`, iterates over each `RequestPluginInstallEntry`, clones scalar and vector fields, and maps `description` through `truncate_to_char_boundary(..., 240).to_string()` when present. It collects the transformed entries into `ListAvailablePluginsToInstallResult { tools }` and returns it.

**Call relations**: This helper is called by `handle_call` to produce the serializable response body. Tests also validate its sorting and truncation semantics indirectly through expected output.

*Call graph*: called by 1 (handle_call).


##### `ListAvailablePluginsToInstallHandler::tool_name`  (lines 58–60)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Advertises the built-in tool under its fixed plain name.

**Data flow**: Constructs and returns `ToolName::plain(LIST_AVAILABLE_PLUGINS_TO_INSTALL_TOOL_NAME)`.

**Call relations**: The registry uses this metadata for exposure and dispatch.

*Call graph*: calls 1 internal fn (plain).


##### `ListAvailablePluginsToInstallHandler::spec`  (lines 62–64)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the declarative tool specification for this install-candidate listing tool.

**Data flow**: Calls `create_list_available_plugins_to_install_tool()` and returns the resulting `ToolSpec`.

**Call relations**: This delegates schema and description construction to the companion spec file.

*Call graph*: calls 1 internal fn (create_list_available_plugins_to_install_tool).


##### `ListAvailablePluginsToInstallHandler::supports_parallel_tool_calls`  (lines 66–68)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Declares that this tool should not be run in parallel with itself.

**Data flow**: Returns the constant boolean `false`.

**Call relations**: The scheduler consults this flag; the accompanying test asserts this policy explicitly.


##### `ListAvailablePluginsToInstallHandler::handle`  (lines 70–72)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the async implementation into the boxed future required by the tool-executor trait.

**Data flow**: Takes a `ToolInvocation`, creates the future from `self.handle_call(invocation)`, pins it in a `Box`, and returns it.

**Call relations**: The registry invokes this trait method; all real execution logic lives in `handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ListAvailablePluginsToInstallHandler::handle_call`  (lines 76–100)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Validates the payload shape, serializes the available-plugin list, and returns it as a successful text tool output.

**Data flow**: Consumes `ToolInvocation`, inspects only `payload`, and rejects non-`ToolPayload::Function` payloads with `FunctionCallError::Fatal` naming the tool. For valid payloads it calls `self.result()`, serializes the `ListAvailablePluginsToInstallResult` to a JSON string with `serde_json::to_string`, maps serialization errors to `FunctionCallError::Fatal`, wraps the string in `FunctionToolOutput::from_text(content, Some(true))`, boxes it, and returns it.

**Call relations**: It is called only by `handle`. Its only internal dependency is `result`, which prepares the sorted and truncated payload before serialization.

*Call graph*: calls 3 internal fn (from_text, boxed_tool_output, result); called by 1 (handle); 3 external calls (format!, to_string, Fatal).


##### `truncate_to_char_boundary`  (lines 105–110)

```
fn truncate_to_char_boundary(value: &str, max_chars: usize) -> &str
```

**Purpose**: Safely truncates a UTF-8 string to at most a given number of characters without splitting a code point.

**Data flow**: Reads `value: &str` and `max_chars: usize`, finds the byte index of the `max_chars`-th character using `char_indices().nth(max_chars)`, and returns either the prefix slice up to that byte index or the original string if it is already short enough.

**Call relations**: This helper is used by `ListAvailablePluginsToInstallHandler::result` when shortening descriptions for model-facing output.


##### `tests::list_tool_does_not_support_parallel_calls`  (lines 119–123)

```
fn list_tool_does_not_support_parallel_calls()
```

**Purpose**: Asserts the handler's explicit policy that parallel calls are disabled.

**Data flow**: Constructs an empty handler with `ListAvailablePluginsToInstallHandler::new(Vec::new())`, calls `supports_parallel_tool_calls`, negates the result, and asserts it is true.

**Call relations**: This test directly exercises the trait method without involving serialization or invocation handling.

*Call graph*: 1 external calls (assert!).


##### `tests::result_truncates_candidate_descriptions`  (lines 126–177)

```
fn result_truncates_candidate_descriptions()
```

**Purpose**: Verifies that `result` sorts entries by name and truncates overlong descriptions to the configured character limit.

**Data flow**: Builds a handler from two `RequestPluginInstallEntry` values in unsorted order, one with a description one character longer than the maximum. It then compares `handler.result()` against an expected `ListAvailablePluginsToInstallResult` whose entries are sorted and whose long description has been shortened to exactly the maximum length.

**Call relations**: This test targets the transformation logic inside `ListAvailablePluginsToInstallHandler::new` and `result`, especially deterministic ordering and safe truncation.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, vec!).


### `core/src/tools/handlers/request_plugin_install_spec.rs`

`config` · `tool registration / startup`

This file builds a single `ToolSpec::Function` for the `request_plugin_install` tool using `codex_tools::ResponsesApiTool`. The schema is intentionally narrow: it requires four string properties — `tool_type`, `action_type`, `tool_id`, and `suggest_reason` — and disallows additional properties by passing `Some(false.into())` to `JsonSchema::object`. The property descriptions are concrete and directive, especially `tool_type` (`"connector"` or `"plugin"`) and `action_type` (`"install"`).

The generated description text is also part of the contract. It explicitly ties this tool to the output of `list_available_plugins_to_install`, instructs callers to forward the returned `tool_type` and `id` unchanged, forbids using the tool for adjacent or merely useful capabilities, and warns not to invoke it in parallel with other tools. That wording is assembled with `format!` so the referenced list-tool name stays synchronized with the shared constant.

The embedded test locks down the exact serialized shape of the tool spec, including field descriptions, required-property ordering, `strict: false`, and the absence of an output schema. This makes the file effectively the canonical source for the model-facing API contract of plugin-install suggestions.

#### Function details

##### `create_request_plugin_install_tool`  (lines 8–55)

```
fn create_request_plugin_install_tool() -> ToolSpec
```

**Purpose**: Constructs the `request_plugin_install` function-tool definition with its full JSON parameter schema and model instructions. It returns the exact `ToolSpec` consumed by the tool registry.

**Data flow**: It creates a `BTreeMap<String, JsonSchema>` for the four accepted input fields, builds a multi-paragraph description string that references the shared list-tool constant, then wraps everything in `ToolSpec::Function(ResponsesApiTool { ... })`. The returned value contains the tool name constant, `strict: false`, `defer_loading: None`, an object schema with four required fields, and `output_schema: None`.

**Call relations**: This function is invoked by the handler/registry path via `spec`, where the runtime needs the model-visible definition of the tool. It delegates schema construction to `JsonSchema::string` and `JsonSchema::object`, and uses `format!` so the description stays aligned with the companion discovery tool name.

*Call graph*: calls 2 internal fn (object, string); called by 1 (spec); 4 external calls (from, format!, Function, vec!).


##### `tests::create_request_plugin_install_tool_uses_expected_wire_shape`  (lines 65–118)

```
fn create_request_plugin_install_tool_uses_expected_wire_shape()
```

**Purpose**: Verifies that the generated tool spec exactly matches the expected wire contract. The test protects against accidental changes to names, descriptions, required fields, or schema strictness.

**Data flow**: It builds an expected description with `concat!`, constructs the full expected `ToolSpec::Function(ResponsesApiTool { ... })` inline, calls `create_request_plugin_install_tool()`, and compares the two values with `assert_eq!`. It reads no external state and writes no persistent output.

**Call relations**: This test exercises the only production function in the file and serves as a regression check for downstream consumers that depend on the exact schema and prompt wording.

*Call graph*: 2 external calls (assert_eq!, concat!).


### `tools/src/request_plugin_install.rs`

`domain_logic` · `request handling`

This file packages the data and helper logic around prompting the user to install or enable a discoverable plugin or connector. It defines constants for the approval-kind and persistence metadata values, plus three structs: `RequestPluginInstallArgs` for deserializing tool-call arguments, `RequestPluginInstallResult` for serializing the eventual outcome, and `RequestPluginInstallMeta<'a>` for the metadata attached to the elicitation request. The main builder, `build_request_plugin_install_elicitation_request`, assembles `McpServerElicitationRequestParams` for a form-style request. It copies thread and turn identifiers, records the server name, uses the suggestion reason as the user-facing message, and serializes metadata produced by `build_request_plugin_install_meta` into JSON. The requested schema is intentionally an empty object (`properties: BTreeMap::new(), required: None`), meaning the form is used primarily as an approval prompt rather than to collect structured fields.

The remaining helpers evaluate installation completion for connectors. `verified_connector_install_completed` scans `accessible_connectors` for a matching `AppInfo.id` and requires `is_accessible` to be true. `all_requested_connectors_picked_up` lifts that check over a slice of expected connector IDs and returns true only if every requested connector now appears accessible. `build_request_plugin_install_meta` also contains an important branching detail: connector suggestions omit plugin-specific fields, while plugin suggestions include `remote_plugin_id` and `app_connector_ids` borrowed from the `DiscoverableTool::Plugin` payload.

#### Function details

##### `build_request_plugin_install_elicitation_request`  (lines 56–86)

```
fn build_request_plugin_install_elicitation_request(
    server_name: &str,
    thread_id: String,
    turn_id: String,
    args: &RequestPluginInstallArgs,
    suggest_reason: &str,
    tool: &Discov
```

**Purpose**: Builds the app-server elicitation request used to ask the user to approve or act on a suggested plugin/connector installation.

**Data flow**: Accepts `server_name`, owned `thread_id`, owned `turn_id`, parsed `RequestPluginInstallArgs`, a `suggest_reason` string, and a `DiscoverableTool`. It clones `suggest_reason` into the request `message`, constructs `McpServerElicitationRequestParams` with the provided IDs and server name, serializes metadata from `build_request_plugin_install_meta(...)` into JSON for the `meta` field, and sets `requested_schema` to an empty object-shaped `McpElicitationSchema`. It returns the assembled request params without mutating external state.

**Call relations**: This builder is used when the system needs to surface a plugin-install suggestion to the app server/UI. Internally it delegates only metadata assembly to `build_request_plugin_install_meta`; the rest of the request envelope is fixed in this function.

*Call graph*: 2 external calls (new, json!).


##### `all_requested_connectors_picked_up`  (lines 88–95)

```
fn all_requested_connectors_picked_up(
    expected_connector_ids: &[String],
    accessible_connectors: &[AppInfo],
) -> bool
```

**Purpose**: Returns whether every expected connector ID now corresponds to an accessible connector in the provided app list.

**Data flow**: Takes a slice of expected connector IDs and a slice of `AppInfo`, iterates over the expected IDs, calls `verified_connector_install_completed` for each one, and returns true only if all calls return true.

**Call relations**: This helper is used after an installation flow to decide whether all requested connectors became available. It delegates the per-connector check to `verified_connector_install_completed`.


##### `verified_connector_install_completed`  (lines 97–105)

```
fn verified_connector_install_completed(
    tool_id: &str,
    accessible_connectors: &[AppInfo],
) -> bool
```

**Purpose**: Checks whether a specific connector/tool ID appears in the accessible connector list and is marked accessible.

**Data flow**: Accepts a `tool_id` string and a slice of `AppInfo`, iterates through the connectors, finds the first entry whose `id` matches `tool_id`, and returns `true` only if such an entry exists and its `is_accessible` field is true. Otherwise it returns false.

**Call relations**: This is the per-item predicate used by `all_requested_connectors_picked_up`. It encapsulates the exact completion rule so callers do not duplicate the `id` match plus accessibility check.

*Call graph*: 1 external calls (iter).


##### `build_request_plugin_install_meta`  (lines 107–132)

```
fn build_request_plugin_install_meta(
    tool_type: DiscoverableToolType,
    action_type: DiscoverableToolAction,
    suggest_reason: &'a str,
    tool: &'a DiscoverableTool,
) -> RequestPluginInsta
```

**Purpose**: Constructs the metadata payload attached to a plugin-install elicitation request, including plugin-specific fields only when the suggested tool is a plugin.

**Data flow**: Takes `tool_type`, `action_type`, a borrowed `suggest_reason`, and a borrowed `DiscoverableTool`. It pattern-matches the tool: `Connector(_)` yields `remote_plugin_id: None` and `app_connector_ids: None`, while `Plugin(plugin)` borrows `plugin.remote_plugin_id` and `plugin.app_connector_ids`. It then builds and returns `RequestPluginInstallMeta` using fixed constants for `codex_approval_kind` and `persist`, plus `tool.id()`, `tool.name()`, and `tool.install_url()`.

**Call relations**: This helper is called by `build_request_plugin_install_elicitation_request` to populate the request’s `meta` JSON. Its branch on `DiscoverableTool` determines whether plugin-only metadata is included in the outgoing prompt.

*Call graph*: calls 3 internal fn (id, install_url, name).


### `core/src/tools/handlers/request_plugin_install.rs`

`orchestration` · `tool invocation when suggesting plugin/connector installation`

This file contains a comparatively rich orchestration flow around plugin and connector installation suggestions. `RequestPluginInstallHandler` stores the current list of `DiscoverableTool` entries, exposes the shared tool name and schema, explicitly allows parallel tool calls, and routes execution into `handle_call`. The main handler parses `RequestPluginInstallArgs`, trims and validates `suggest_reason`, enforces that only `DiscoverableToolAction::Install` is supported, and blocks plugin installs for the `codex-tui` client. It then filters the discoverable-tool list for the current client, finds the requested tool by matching both `tool_type` and `tool_id`, and errors if the id was not one of the discoverable options previously advertised.

For valid requests, it builds an MCP elicitation request using the current thread id, turn sub-id, and selected tool, then asks the session to send that elicitation to the app server. If a response arrives, `maybe_persist_disabled_install_request` checks for a declined response whose metadata requests persistent suppression and, if so, writes a config edit under `codex_home` and reloads the user config layer. The handler treats `ElicitationAction::Accept` as user confirmation and then calls `verify_request_plugin_install_completed` to determine whether the install actually took effect. Connector installs are verified by refreshing accessible connectors from MCP tools; plugin installs either short-circuit as complete for remote marketplace suggestions or reload config and inspect marketplace/plugin state via `PluginsManager`, while also refreshing any app connectors associated with the plugin. Successful connector installs additionally merge the connector id into the session's selected connectors. If the elicitation was sent, telemetry records tool type, tool identity, response action, confirmation, and completion. Finally, the handler serializes a `RequestPluginInstallResult` containing both user-confirmed and completed flags and returns it as successful text output.

The helper functions encapsulate persistence and verification details: one detects the persistent-disable metadata convention, one writes the config edit, one maps a `DiscoverableTool` into `ToolSuggestDisabledTool`, one recognizes remote plugin ids by marketplace suffix, one refreshes connector visibility with a hard MCP cache refresh fallback, and one checks installed plugins by enumerating marketplaces from the current config input.

#### Function details

##### `RequestPluginInstallHandler::new`  (lines 46–48)

```
fn new(discoverable_tools: Vec<DiscoverableTool>) -> Self
```

**Purpose**: Constructs the handler with the current discoverable-tool inventory. That inventory is later filtered and searched when a specific install request arrives.

**Data flow**: Takes ownership of `Vec<DiscoverableTool>`, stores it in `discoverable_tools`, and returns the initialized handler.

**Call relations**: Called by `add_core_utility_tools` during tool registration so the handler has the discoverable tools available at runtime.

*Call graph*: called by 1 (add_core_utility_tools).


##### `RequestPluginInstallHandler::tool_name`  (lines 52–54)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the canonical request-plugin-install tool name from the shared constant. This is the dispatch key used by the runtime.

**Data flow**: Wraps `REQUEST_PLUGIN_INSTALL_TOOL_NAME` with `ToolName::plain` and returns it.

**Call relations**: Queried during tool registration and dispatch.

*Call graph*: calls 1 internal fn (plain).


##### `RequestPluginInstallHandler::spec`  (lines 56–58)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the schema for the plugin-install request tool. The schema details live in the companion spec module.

**Data flow**: Calls `create_request_plugin_install_tool()` and returns the resulting `ToolSpec`.

**Call relations**: Used when publishing available tools to the model.

*Call graph*: calls 1 internal fn (create_request_plugin_install_tool).


##### `RequestPluginInstallHandler::supports_parallel_tool_calls`  (lines 60–62)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Declares that multiple plugin-install requests may be executed in parallel. This opts the handler into concurrent tool-call scheduling.

**Data flow**: Returns the constant boolean `true`.

**Call relations**: Consulted by the tool runtime when deciding whether concurrent invocations are allowed.


##### `RequestPluginInstallHandler::handle`  (lines 64–66)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the async install-request workflow to the executor trait's boxed future interface. It delegates all substantive logic to `handle_call`.

**Data flow**: Takes a `ToolInvocation`, calls `self.handle_call(invocation)`, boxes the future, and returns it.

**Call relations**: This is the runtime entrypoint after dispatch.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `RequestPluginInstallHandler::handle_call`  (lines 70–199)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Validates the install request, sends an elicitation to the client, optionally persists a disabled-suggestion preference, verifies completion, updates connector selection, records telemetry, and returns a serialized result. It is the central orchestration routine in the file.

**Data flow**: Reads `payload`, `session`, `turn`, and `call_id` from the invocation; extracts raw arguments only from `ToolPayload::Function`, otherwise returns a fatal unsupported-payload error; parses `RequestPluginInstallArgs`; trims and validates `suggest_reason`; rejects unsupported `action_type` values and plugin installs from `codex-tui`; clones and filters `self.discoverable_tools` for the current client; finds the requested `DiscoverableTool` by type and id or returns a model-facing error; constructs an MCP `RequestId` from `call_id`; builds elicitation params and awaits `session.request_mcp_server_elicitation`; if a response exists, calls `maybe_persist_disabled_install_request`; derives `user_confirmed` from `ElicitationAction::Accept`; reads auth from `session.services.auth_manager`; if confirmed, awaits `verify_request_plugin_install_completed`, otherwise uses `false`; if completion succeeded for a connector tool, merges that connector id into session selection; if the elicitation was sent, records telemetry with tool type, id, name, response action, confirmation, and completion; serializes a `RequestPluginInstallResult` to JSON text, mapping serialization failures to `FunctionCallError::Fatal`; and returns boxed `FunctionToolOutput::from_text(content, Some(true))`.

**Call relations**: Called only from `RequestPluginInstallHandler::handle`. It delegates persistence decisions to `maybe_persist_disabled_install_request` and post-accept verification to `verify_request_plugin_install_completed`, while also relying on shared codex-tools helpers to build and filter install requests.

*Call graph*: calls 5 internal fn (from_text, boxed_tool_output, parse_arguments, maybe_persist_disabled_install_request, verify_request_plugin_install_completed); called by 1 (handle); 8 external calls (from, String, build_request_plugin_install_elicitation_request, filter_request_plugin_install_discoverable_tools_for_client, format!, to_string, Fatal, RespondToModel).


##### `maybe_persist_disabled_install_request`  (lines 204–224)

```
async fn maybe_persist_disabled_install_request(
    session: &crate::session::session::Session,
    turn: &crate::session::turn_context::TurnContext,
    tool: &DiscoverableTool,
    response: &Elici
```

**Purpose**: Persists a user preference to stop suggesting a specific install when the elicitation response explicitly requests permanent disablement. It also reloads the user config layer after a successful write.

**Data flow**: Reads `session`, `turn`, `tool`, and `response`; first checks `request_plugin_install_response_requests_persistent_disable(response)` and returns early if false; otherwise awaits `persist_disabled_install_request(&turn.config.codex_home, tool)`; on error logs a warning with `tool.id()` and returns; on success awaits `session.reload_user_config_layer()`.

**Call relations**: Invoked from `RequestPluginInstallHandler::handle_call` only when an elicitation response is present, so declined responses can update persistent suggestion settings.

*Call graph*: calls 2 internal fn (persist_disabled_install_request, request_plugin_install_response_requests_persistent_disable); called by 1 (handle_call); 2 external calls (reload_user_config_layer, warn!).


##### `request_plugin_install_response_requests_persistent_disable`  (lines 226–240)

```
fn request_plugin_install_response_requests_persistent_disable(
    response: &ElicitationResponse,
) -> bool
```

**Purpose**: Detects whether an elicitation response means 'decline and never suggest this install again'. It interprets a specific metadata key/value convention on declined responses.

**Data flow**: Reads `response.action` and returns `false` unless it is `ElicitationAction::Decline`; then traverses `response.meta` as a JSON object, looks up `REQUEST_PLUGIN_INSTALL_PERSIST_KEY`, reads it as a string, and returns `true` only if it equals `REQUEST_PLUGIN_INSTALL_PERSIST_ALWAYS_VALUE`.

**Call relations**: Called by `maybe_persist_disabled_install_request` before any config edit is attempted.

*Call graph*: called by 1 (maybe_persist_disabled_install_request).


##### `persist_disabled_install_request`  (lines 242–252)

```
async fn persist_disabled_install_request(
    codex_home: &codex_utils_absolute_path::AbsolutePathBuf,
    tool: &DiscoverableTool,
) -> anyhow::Result<()>
```

**Purpose**: Writes a config edit that disables future suggestions for the specified connector or plugin. It encapsulates the config-edit builder sequence.

**Data flow**: Takes `codex_home` and `tool`; creates `ConfigEditsBuilder::new(codex_home)`, adds a single `ConfigEdit::AddToolSuggestDisabledTool(disabled_install_request(tool))`, applies the edits asynchronously, and returns `anyhow::Result<()>`.

**Call relations**: Called by `maybe_persist_disabled_install_request` after the response has been recognized as a persistent-disable request.

*Call graph*: calls 2 internal fn (new, disabled_install_request); called by 1 (maybe_persist_disabled_install_request); 1 external calls (AddToolSuggestDisabledTool).


##### `disabled_install_request`  (lines 254–261)

```
fn disabled_install_request(tool: &DiscoverableTool) -> ToolSuggestDisabledTool
```

**Purpose**: Converts a `DiscoverableTool` into the config-layer representation used to suppress future install suggestions. It preserves whether the disabled suggestion refers to a connector or a plugin.

**Data flow**: Pattern-matches `tool`; for `DiscoverableTool::Connector(connector)` returns `ToolSuggestDisabledTool::connector(connector.id.as_str())`, and for `DiscoverableTool::Plugin(plugin)` returns `ToolSuggestDisabledTool::plugin(plugin.id.as_str())`.

**Call relations**: Used only by `persist_disabled_install_request` when constructing the config edit payload.

*Call graph*: calls 2 internal fn (connector, plugin); called by 1 (persist_disabled_install_request).


##### `verify_request_plugin_install_completed`  (lines 263–304)

```
async fn verify_request_plugin_install_completed(
    session: &crate::session::session::Session,
    turn: &crate::session::turn_context::TurnContext,
    tool: &DiscoverableTool,
    auth: Option<&c
```

**Purpose**: Checks whether an accepted install request actually resulted in an installed/accessible connector or plugin. The verification strategy differs for connectors, local plugins, and remote marketplace plugins.

**Data flow**: Reads `session`, `turn`, `tool`, and optional `auth`; for connectors, calls `refresh_missing_requested_connectors` with the connector id and returns whether `verified_connector_install_completed` finds it in the accessible connector list; for plugins, first returns `true` immediately if `is_remote_plugin_install_suggestion(&plugin.id)` is true, otherwise reloads the user config layer, fetches the current config via `session.get_config()`, computes `completed` with `verified_plugin_install_completed(plugin.id.as_str(), config.as_ref(), session.services.plugins_manager.as_ref())`, then triggers `refresh_missing_requested_connectors` for any `plugin.app_connector_ids` as a side effect, and finally returns `completed`.

**Call relations**: Called from `RequestPluginInstallHandler::handle_call` only after the user accepted the elicitation. It delegates connector refresh logic to `refresh_missing_requested_connectors`, plugin-id classification to `is_remote_plugin_install_suggestion`, and installed-plugin inspection to `verified_plugin_install_completed`.

*Call graph*: calls 3 internal fn (is_remote_plugin_install_suggestion, refresh_missing_requested_connectors, verified_plugin_install_completed); called by 1 (handle_call); 3 external calls (get_config, reload_user_config_layer, from_ref).


##### `is_remote_plugin_install_suggestion`  (lines 306–310)

```
fn is_remote_plugin_install_suggestion(plugin_id: &str) -> bool
```

**Purpose**: Recognizes plugin ids that refer to the remote global marketplace. Such suggestions are treated as completed immediately after acceptance.

**Data flow**: Takes `plugin_id: &str`, splits it from the right on `'@'`, and returns `true` only when the suffix marketplace name equals `REMOTE_GLOBAL_MARKETPLACE_NAME`.

**Call relations**: Used by `verify_request_plugin_install_completed` to short-circuit verification for remote plugin suggestions.

*Call graph*: called by 1 (verify_request_plugin_install_completed).


##### `refresh_missing_requested_connectors`  (lines 312–353)

```
async fn refresh_missing_requested_connectors(
    session: &crate::session::session::Session,
    turn: &crate::session::turn_context::TurnContext,
    auth: Option<&codex_login::CodexAuth>,
    expe
```

**Purpose**: Refreshes the visible connector inventory when expected connectors are not yet accessible, optionally hard-refreshing the Codex Apps MCP tools cache. It returns the accessible connector list when available.

**Data flow**: Reads `session`, `turn`, optional `auth`, `expected_connector_ids`, and `tool_id`; if no expected ids are provided, returns `Some(Vec::new())`; otherwise loads the MCP connection manager, awaits `list_all_tools()`, derives accessible connectors from MCP tools and current config via `connectors::accessible_connectors_from_mcp_tools` and `connectors::with_app_enabled_state`, and if `all_requested_connectors_picked_up` is already true returns that list; if not, awaits `hard_refresh_codex_apps_tools_cache()`, and on success recomputes accessible connectors, refreshes the cached accessible-connector state with `connectors::refresh_accessible_connectors_cache_from_mcp_tools`, and returns `Some(accessible_connectors)`; on refresh failure it logs a warning mentioning `tool_id` and returns `None`.

**Call relations**: Called by `verify_request_plugin_install_completed` for both connector installs and plugin installs that imply app connectors. It encapsulates the retry/refresh path needed before declaring connector-related completion.

*Call graph*: calls 3 internal fn (accessible_connectors_from_mcp_tools, refresh_accessible_connectors_cache_from_mcp_tools, with_app_enabled_state); called by 1 (verify_request_plugin_install_completed); 3 external calls (new, all_requested_connectors_picked_up, warn!).


##### `verified_plugin_install_completed`  (lines 355–368)

```
fn verified_plugin_install_completed(
    tool_id: &str,
    config: &crate::config::Config,
    plugins_manager: &codex_core_plugins::PluginsManager,
) -> bool
```

**Purpose**: Determines whether a plugin with the requested id is currently installed according to the plugin manager and current config. It inspects marketplace listings rather than relying on the elicitation response alone.

**Data flow**: Takes `tool_id`, `config`, and `plugins_manager`; derives `plugins_input` from `config.plugins_config_input()`, asks `plugins_manager.list_marketplaces_for_config(&plugins_input, &[], true)`, ignores errors by converting to an empty iterator, flattens all returned marketplaces and their plugin lists, and returns `true` if any plugin has matching `id` and `installed == true`.

**Call relations**: Used by `verify_request_plugin_install_completed` for non-remote plugin suggestions after reloading the user config layer.

*Call graph*: calls 1 internal fn (list_marketplaces_for_config); called by 1 (verify_request_plugin_install_completed); 1 external calls (plugins_config_input).


### User-facing plugin management surfaces
These files expose plugin ecosystem management through the CLI and TUI, translating user actions into marketplace and manager operations.

### `cli/src/plugin_cmd.rs`

`orchestration` · `on demand during `codex plugin ...` and shared marketplace/plugin listing flows`

This file owns the plugin-management layer above `codex_core_plugins`. It defines `PluginCli` and its subcommands, but the actual top-level dispatch happens in `main.rs`; this file provides the concrete handlers for add/list/remove plus shared helpers used by marketplace commands. `run_plugin_add` and `run_plugin_remove` both begin by loading a `PluginCommandContext`, which resolves `CODEX_HOME`, loads config with CLI overrides, derives `PluginsConfigInput`, constructs a `PluginsManager`, and sets its auth mode based on either `CODEX_API_KEY` or stored CLI auth. Plugin selectors are normalized by `parse_plugin_selection`, which accepts either `plugin@marketplace` or `plugin --marketplace marketplace` and rejects mismatches.

Listing is the richest path. `run_plugin_list` asks the manager for marketplace/plugin inventory including curated OpenAI marketplaces, then calls `ensure_configured_marketplace_snapshots_loaded` so malformed or missing configured marketplace snapshots fail with a detailed multi-line error instead of silently disappearing. Human output groups plugins by marketplace and prints a width-aligned table with plugin id, install status, installed version, and source description. JSON output splits entries into `installed` and optionally `available`, and each entry includes install/auth policy labels plus optional marketplace source metadata reconstructed from the effective user config.

The snapshot-validation helpers are important design glue. `configured_marketplace_snapshot_issues` inspects the raw `[marketplaces]` config table, validates marketplace names, checks local-source completeness, resolves configured roots, verifies supported manifests, and correlates manager load errors back to configured marketplace names. It intentionally suppresses errors for implicit system marketplace roots such as bundled OpenAI marketplaces and the primary runtime marketplace, whose manifests may be absent transiently. This same logic is reused by both plugin and marketplace listing commands so they fail consistently.

#### Function details

##### `run_plugin_add`  (lines 124–173)

```
async fn run_plugin_add(
    overrides: Vec<(String, toml::Value)>,
    args: AddPluginArgs,
) -> Result<()>
```

**Purpose**: Installs a plugin from a configured marketplace snapshot after resolving the plugin selector and marketplace root.

**Data flow**: Consumes parsed TOML overrides and `AddPluginArgs`, loads `PluginCommandContext`, parses the plugin selector into `PluginSelection`, finds the matching configured marketplace with `find_marketplace_for_plugin`, and calls `PluginsManager::install_plugin` with the plugin name and marketplace path. If `json` is set it converts the `PluginInstallOutcome` into `JsonPluginAddOutput` and prints pretty JSON; otherwise it prints the plugin and marketplace names plus the installed plugin root path.

**Call relations**: Called from `cli_main` when `PluginSubcommand::Add` is selected. It delegates selector parsing, marketplace lookup, and install execution to dedicated helpers and the plugins manager.

*Call graph*: calls 4 internal fn (from_outcome, find_marketplace_for_plugin, load_plugin_command_context, parse_plugin_selection); called by 1 (cli_main); 1 external calls (println!).


##### `JsonPluginAddOutput::from_outcome`  (lines 187–196)

```
fn from_outcome(outcome: PluginInstallOutcome) -> Self
```

**Purpose**: Converts a plugin install outcome into the JSON shape exposed by the CLI.

**Data flow**: Consumes `PluginInstallOutcome`, derives the plugin key via `plugin_id.as_key()`, copies plugin and marketplace names, version, stringifies the installed path, and maps the auth policy enum through `auth_policy_label`.

**Call relations**: Used only by `run_plugin_add` for `--json` output.

*Call graph*: calls 1 internal fn (auth_policy_label); called by 1 (run_plugin_add).


##### `run_plugin_list`  (lines 199–312)

```
async fn run_plugin_list(
    overrides: Vec<(String, toml::Value)>,
    args: ListPluginsArgs,
) -> Result<()>
```

**Purpose**: Lists plugins available from configured marketplace snapshots, optionally filtered by marketplace and optionally including uninstalled plugins in JSON output.

**Data flow**: Consumes parsed overrides and `ListPluginsArgs`, loads `PluginCommandContext`, asks the manager for marketplace/plugin inventory with curated marketplaces included, and validates configured marketplace snapshots via `ensure_configured_marketplace_snapshots_loaded`. It filters marketplaces by `args.marketplace_name` when present and reconstructs marketplace source metadata with `configured_marketplace_sources`. In JSON mode it builds `JsonPluginListOutput::from_marketplaces` and prints pretty JSON. In human mode it prints either a no-results message or, for each marketplace, a heading plus a width-aligned table of plugin id, install status (`installed, enabled`, `installed, disabled`, or `not installed`), installed version, and a source description derived from local or Git source fields.

**Call relations**: Called from `cli_main` when `PluginSubcommand::List` is selected. It shares snapshot-validation logic with marketplace listing to avoid silently ignoring broken configured marketplaces.

*Call graph*: calls 4 internal fn (from_marketplaces, configured_marketplace_sources, ensure_configured_marketplace_snapshots_loaded, load_plugin_command_context); called by 1 (cli_main); 4 external calls (new, format!, println!, vec!).


##### `JsonPluginListOutput::from_marketplaces`  (lines 322–350)

```
fn from_marketplaces(
        marketplaces: Vec<codex_core_plugins::ConfiguredMarketplace>,
        include_available: bool,
        marketplace_sources: &HashMap<String, JsonMarketplaceSource>,
    )
```

**Purpose**: Builds the JSON plugin listing, separating installed plugins from optionally included available-but-uninstalled plugins.

**Data flow**: Consumes configured marketplaces, an `include_available` flag, and a map of marketplace-name to `JsonMarketplaceSource`. It iterates every plugin in every marketplace, converts each to `JsonPluginListEntry`, pushes installed entries into `installed`, and pushes uninstalled entries into `available` only when requested.

**Call relations**: Used by `run_plugin_list` for JSON output.

*Call graph*: calls 1 internal fn (from_configured_plugin); called by 1 (run_plugin_list); 1 external calls (new).


##### `JsonPluginListEntry::from_configured_plugin`  (lines 370–388)

```
fn from_configured_plugin(
        marketplace_name: &str,
        marketplace_source: Option<JsonMarketplaceSource>,
        plugin: codex_core_plugins::ConfiguredMarketplacePlugin,
    ) -> Self
```

**Purpose**: Converts one configured marketplace plugin into the JSON entry shape used by plugin listing.

**Data flow**: Takes the marketplace name, optional marketplace source metadata, and a `ConfiguredMarketplacePlugin`. It chooses `version` from `installed_version` or `local_version`, copies install/enabled flags and names, converts the plugin source via `JsonPluginSource::from_marketplace_source`, and maps installation/authentication policies through `install_policy_label` and `auth_policy_label`.

**Call relations**: Called by `JsonPluginListOutput::from_marketplaces` for every listed plugin.

*Call graph*: calls 3 internal fn (from_marketplace_source, auth_policy_label, install_policy_label); called by 1 (from_marketplaces).


##### `JsonPluginSource::from_marketplace_source`  (lines 415–438)

```
fn from_marketplace_source(source: MarketplacePluginSource) -> Self
```

**Purpose**: Normalizes marketplace plugin source variants into the CLI’s tagged JSON representation.

**Data flow**: Consumes a `MarketplacePluginSource` and matches it into `Local { path }`, `GitSubdir { url, path, ref_name, sha }` when a Git path is present, or `Git { url, ref_name, sha }` when the Git source points at the repository root.

**Call relations**: Used by `JsonPluginListEntry::from_configured_plugin`.

*Call graph*: called by 1 (from_configured_plugin).


##### `configured_marketplace_sources`  (lines 448–477)

```
fn configured_marketplace_sources(
    plugins_input: &PluginsConfigInput,
) -> HashMap<String, JsonMarketplaceSource>
```

**Purpose**: Extracts marketplace source metadata from the effective user config for inclusion in plugin and marketplace JSON output.

**Data flow**: Reads `PluginsConfigInput`, accesses the effective user config, looks up the `[marketplaces]` table, and for each entry that contains both `source_type` and `source` strings inserts a `JsonMarketplaceSource` keyed by marketplace name. Returns an empty map when no effective user config or marketplace table exists.

**Call relations**: Used by `run_plugin_list` directly and by `marketplace_cmd::configured_marketplace_sources_by_root` as the name-keyed starting point.

*Call graph*: called by 2 (configured_marketplace_sources_by_root, run_plugin_list); 1 external calls (new).


##### `install_policy_label`  (lines 479–485)

```
fn install_policy_label(policy: MarketplacePluginInstallPolicy) -> &'static str
```

**Purpose**: Maps marketplace plugin installation policy enums to stable uppercase strings for JSON output.

**Data flow**: Consumes a `MarketplacePluginInstallPolicy` and returns `NOT_AVAILABLE`, `AVAILABLE`, or `INSTALLED_BY_DEFAULT`.

**Call relations**: Used by `JsonPluginListEntry::from_configured_plugin`.

*Call graph*: called by 1 (from_configured_plugin).


##### `auth_policy_label`  (lines 487–492)

```
fn auth_policy_label(policy: MarketplacePluginAuthPolicy) -> &'static str
```

**Purpose**: Maps marketplace plugin authentication policy enums to stable uppercase strings for JSON output.

**Data flow**: Consumes a `MarketplacePluginAuthPolicy` and returns `ON_INSTALL` or `ON_USE`.

**Call relations**: Used by both `JsonPluginAddOutput::from_outcome` and `JsonPluginListEntry::from_configured_plugin`.

*Call graph*: called by 2 (from_outcome, from_configured_plugin).


##### `run_plugin_remove`  (lines 494–521)

```
async fn run_plugin_remove(
    overrides: Vec<(String, toml::Value)>,
    args: RemovePluginArgs,
) -> Result<()>
```

**Purpose**: Uninstalls a plugin identified by `plugin@marketplace` or `plugin --marketplace marketplace` and reports the removal.

**Data flow**: Consumes parsed overrides and `RemovePluginArgs`, loads `PluginCommandContext`, parses the selector into `PluginSelection`, calls `PluginsManager::uninstall_plugin` with the plugin key, and then either prints `JsonPluginRemoveOutput` or a human-readable removal message.

**Call relations**: Called from `cli_main` when `PluginSubcommand::Remove` is selected. It shares selector parsing with `run_plugin_add`.

*Call graph*: calls 3 internal fn (from_selection, load_plugin_command_context, parse_plugin_selection); called by 1 (cli_main); 1 external calls (println!).


##### `JsonPluginRemoveOutput::from_selection`  (lines 532–538)

```
fn from_selection(selection: PluginSelection) -> Self
```

**Purpose**: Converts a parsed plugin selection into the JSON shape used for successful removals.

**Data flow**: Consumes `PluginSelection` and copies its plugin key, plugin name, and marketplace name into a serializable struct.

**Call relations**: Used only by `run_plugin_remove` for `--json` output.

*Call graph*: called by 1 (run_plugin_remove).


##### `load_plugin_command_context`  (lines 547–562)

```
async fn load_plugin_command_context(
    overrides: Vec<(String, toml::Value)>,
) -> Result<PluginCommandContext>
```

**Purpose**: Loads the common config, plugin input, manager, and auth mode needed by plugin add/list/remove commands.

**Data flow**: Consumes parsed TOML overrides, resolves `CODEX_HOME`, loads `Config` with those overrides, derives `plugins_config_input`, constructs a `PluginsManager` rooted at `codex_home`, computes the CLI auth mode with `load_cli_auth_mode`, sets that auth mode on the manager, and returns a `PluginCommandContext` containing all three pieces.

**Call relations**: Shared by `run_plugin_add`, `run_plugin_list`, and `run_plugin_remove` so they all see the same config and auth-mode setup.

*Call graph*: calls 3 internal fn (load_cli_auth_mode, new, find_codex_home); called by 3 (run_plugin_add, run_plugin_list, run_plugin_remove); 1 external calls (load_with_cli_overrides).


##### `load_cli_auth_mode`  (lines 564–579)

```
async fn load_cli_auth_mode(config: &Config) -> Option<AuthMode>
```

**Purpose**: Determines the API auth mode the plugin manager should use when talking to authenticated plugin sources or services.

**Data flow**: Reads `CODEX_API_KEY` from the environment first; if present, it constructs `CodexAuth` from that key and returns its API auth mode. Otherwise it attempts to load stored auth from auth storage using config-controlled credential-store and keyring settings, then maps any loaded auth into its API auth mode. Returns `Option<AuthMode>`.

**Call relations**: Used by `load_plugin_command_context` and by marketplace listing so plugin and marketplace operations share the same auth-mode detection.

*Call graph*: calls 2 internal fn (from_api_key, from_auth_storage); called by 2 (run_list, load_plugin_command_context); 2 external calls (auth_keyring_backend_kind, read_codex_api_key_from_env).


##### `PluginSelection::from_plugin_id`  (lines 588–595)

```
fn from_plugin_id(plugin_id: PluginId) -> Self
```

**Purpose**: Builds the internal selector struct from a parsed `PluginId`.

**Data flow**: Consumes `PluginId`, derives its canonical key with `as_key`, and stores plugin name, marketplace name, and key in a `PluginSelection`.

**Call relations**: Used by `parse_plugin_selection` after successful parsing or reconstruction.

*Call graph*: calls 1 internal fn (as_key); called by 1 (parse_plugin_selection).


##### `parse_plugin_selection`  (lines 598–623)

```
fn parse_plugin_selection(
    plugin: String,
    marketplace_name: Option<String>,
) -> Result<PluginSelection>
```

**Purpose**: Accepts either `plugin@marketplace` or `plugin` plus `--marketplace`, validates consistency, and returns a canonical plugin selection.

**Data flow**: Consumes the raw plugin string and optional marketplace name. If `PluginId::parse` succeeds and no marketplace override is given, it returns that parsed id. If both are present, it verifies the parsed marketplace matches the explicit one. If parsing fails but an explicit marketplace is provided, it constructs a new `PluginId` from the two pieces. If parsing fails and no marketplace is provided, it bails with guidance to use `--marketplace` or `plugin@marketplace`.

**Call relations**: Shared by `run_plugin_add` and `run_plugin_remove` so both commands accept the same selector syntax and mismatch checks.

*Call graph*: calls 3 internal fn (from_plugin_id, new, parse); called by 2 (run_plugin_add, run_plugin_remove); 1 external calls (bail!).


##### `find_marketplace_for_plugin`  (lines 625–660)

```
fn find_marketplace_for_plugin(
    manager: &PluginsManager,
    codex_home: &std::path::Path,
    plugins_input: &PluginsConfigInput,
    marketplace_name: &str,
    plugin_name: &str,
) -> Result<C
```

**Purpose**: Finds the unique configured marketplace root that contains the requested plugin name.

**Data flow**: Borrows a `PluginsManager`, `codex_home`, `PluginsConfigInput`, marketplace name, and plugin name. It lists marketplaces for the config with curated marketplaces included, validates configured marketplace snapshots via `ensure_configured_marketplace_snapshots_loaded`, filters marketplaces by matching name and by containing a plugin with the requested name, and then returns the single match, or bails if none or multiple roots match.

**Call relations**: Called only by `run_plugin_add` before installation so the manager receives the correct marketplace path.

*Call graph*: calls 2 internal fn (ensure_configured_marketplace_snapshots_loaded, list_marketplaces_for_config); called by 1 (run_plugin_add); 1 external calls (bail!).


##### `ensure_configured_marketplace_snapshots_loaded`  (lines 668–697)

```
fn ensure_configured_marketplace_snapshots_loaded(
    codex_home: &std::path::Path,
    plugins_input: &PluginsConfigInput,
    load_errors: &[MarketplaceListError],
    marketplace_name: Option<&str
```

**Purpose**: Turns configured marketplace snapshot issues into a single multi-line CLI error.

**Data flow**: Calls `configured_marketplace_snapshot_issues` with the current config and manager load errors. If the returned issue list is empty it succeeds; otherwise it formats each issue as `- <name> at <path>: <message>` joined by newlines and bails with a `failed to load configured marketplace snapshot(s)` error.

**Call relations**: Used by both `find_marketplace_for_plugin` and `run_plugin_list` so broken configured marketplaces fail loudly instead of being silently skipped.

*Call graph*: calls 1 internal fn (configured_marketplace_snapshot_issues); called by 2 (find_marketplace_for_plugin, run_plugin_list); 1 external calls (bail!).


##### `configured_marketplace_snapshot_issues`  (lines 699–786)

```
fn configured_marketplace_snapshot_issues(
    codex_home: &std::path::Path,
    plugins_input: &PluginsConfigInput,
    load_errors: &[MarketplaceListError],
    marketplace_name: Option<&str>,
) ->
```

**Purpose**: Inspects configured marketplace entries and manager load errors to produce user-facing issues tied back to configured marketplace names and paths.

**Data flow**: Reads `codex_home`, `PluginsConfigInput`, manager `load_errors`, and an optional marketplace-name filter. It inspects the effective user config’s `[marketplaces]` table, computes the default install root, and for each configured marketplace: filters by name when requested, rejects non-table entries, validates the marketplace name with `validate_plugin_segment`, checks that local sources have a non-empty `source`, resolves the configured root with `resolve_configured_marketplace_root`, and checks for a supported manifest with `find_marketplace_manifest_path`. Missing manifests become issues unless `is_implicit_system_marketplace_root` says the root is an expected transient system marketplace. It also records manifest paths so later `MarketplaceListError` entries can be mapped back to configured marketplace names. Finally it appends issues for any load error whose path matches a recorded manifest path.

**Call relations**: Called by `ensure_configured_marketplace_snapshots_loaded` and by marketplace listing in `marketplace_cmd`. It is the core consistency checker for configured marketplace snapshots.

*Call graph*: calls 4 internal fn (is_implicit_system_marketplace_root, marketplace_install_root, resolve_configured_marketplace_root, find_marketplace_manifest_path); called by 2 (run_list, ensure_configured_marketplace_snapshots_loaded); 3 external calls (from, new, validate_plugin_segment).


##### `is_implicit_system_marketplace_root`  (lines 788–811)

```
fn is_implicit_system_marketplace_root(
    marketplace_name: &str,
    _codex_home: &Path,
    root: &Path,
) -> bool
```

**Purpose**: Recognizes bundled or runtime-managed marketplace roots whose missing manifests should not be treated as user-facing configuration errors.

**Data flow**: Reads a marketplace name, codex home path, and root path. It returns true when the name is one of the bundled OpenAI marketplace names and the root path ends with `.tmp/bundled-marketplaces/<name>`, or when the name is `openai-primary-runtime` and the root ends with `codex-runtimes/codex-primary-runtime/plugins/<name>`.

**Call relations**: Used only by `configured_marketplace_snapshot_issues` to suppress false-positive errors for implicit system-managed marketplace roots.

*Call graph*: calls 1 internal fn (path_ends_with); called by 1 (configured_marketplace_snapshot_issues); 1 external calls (matches!).


##### `path_ends_with`  (lines 813–824)

```
fn path_ends_with(path: &Path, suffix: &[&str]) -> bool
```

**Purpose**: Checks whether a filesystem path’s component sequence ends with a given suffix component list.

**Data flow**: Converts the path’s components into owned strings, converts the suffix slice into owned strings, and returns whether the path component slice ends with that suffix sequence.

**Call relations**: Used by `is_implicit_system_marketplace_root` for suffix-based root recognition.

*Call graph*: called by 1 (is_implicit_system_marketplace_root); 1 external calls (components).


### `tui/src/chatwidget/plugins.rs`

`orchestration` · `interactive plugin management, async fetch/update handling, and popup rendering`

This file is the largest orchestration layer for the plugins feature. It combines transient UI widgets (`DelayedLoadingHeader`, `PluginDisclosureLine`), cache state (`PluginListFetchState`, `PluginsCacheState`), and a large set of popup builders and event handlers. The overall flow starts with `add_plugins_output`, which checks the feature flag, remembers the active tab, kicks off a fetch, and either opens a cached plugins popup, an error event, or a loading popup.

Caching is cwd-scoped: `plugins_fetch_state.cache_cwd` and `in_flight_cwd` ensure responses are only applied to the current working directory. `on_plugins_loaded` updates cache state, preserves or remaps saved marketplace tab IDs when marketplace roots change, tracks whether remote sections are still loading, and refreshes the popup only when it is visible or stale. `on_plugin_remote_sections_loaded` merges remote marketplace sections into the cached response without duplicating remote placeholders.

UI construction is tab-heavy. `plugins_popup_params` computes aggregate counts, builds tabs for all plugins, installed plugins, OpenAI Curated, each additional marketplace, and an Add Marketplace tab, and attaches per-tab footer hints for removable/upgradable marketplaces. `plugin_selection_items` sorts entries with installed plugins first, computes status labels and search text, optionally adds enable/disable toggles, and wires Enter to fetch plugin details when enough identity information exists.

Detail and mutation flows are explicit: loading popups are shown before fetches; detail popups expose install/uninstall actions plus read-only summaries of skills, hooks, apps, and MCP servers; install completion may branch into a multi-step app-auth flow if bundled apps still need ChatGPT-side installation. Marketplace add/remove/upgrade each have loading, success, and retry/error surfaces. Numerous small helpers normalize marketplace IDs, display names, plugin identities, descriptions, and uninstall/install request parameters so local and remote plugins behave consistently.

#### Function details

##### `DelayedLoadingHeader::new`  (lines 91–104)

```
fn new(
        frame_requester: FrameRequester,
        animations_enabled: bool,
        loading_text: String,
        note: Option<String>,
    ) -> Self
```

**Purpose**: Creates a loading header that can delay and then animate its loading text after a threshold.

**Data flow**: It takes a `FrameRequester`, animation flag, loading text, and optional note, captures `Instant::now()` as `started_at`, stores all fields in a new `DelayedLoadingHeader`, and returns it.

**Call relations**: This constructor is used by the various loading-popup builders so they all share the same delayed shimmer behavior.

*Call graph*: called by 4 (marketplace_add_loading_popup_params, marketplace_upgrade_loading_popup_params, plugin_detail_loading_popup_params, plugins_loading_popup_params); 1 external calls (now).


##### `DelayedLoadingHeader::render`  (lines 108–138)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the plugins loading header, optionally scheduling future frames for delayed or animated loading text.

**Data flow**: It reads the render area, current time, `started_at`, `animations_enabled`, `loading_text`, and optional note. If the area is empty it returns. Otherwise it builds up to three lines, schedules a frame after the initial delay or animation interval as needed, uses `shimmer_text` only after the delay when animations are enabled, and renders the lines as a `Paragraph` into the buffer.

**Call relations**: This method is invoked by the rendering system whenever a loading popup uses `DelayedLoadingHeader` as its header.

*Call graph*: calls 2 internal fn (shimmer_text, schedule_frame_in); 5 external calls (now, from, new, is_empty, with_capacity).


##### `DelayedLoadingHeader::desired_height`  (lines 140–142)

```
fn desired_height(&self, _width: u16) -> u16
```

**Purpose**: Reports the header height as two lines plus one extra line when a note is present.

**Data flow**: It reads `self.note.is_some()` and returns `2 + u16::from(...)`.

**Call relations**: This supports layout sizing for loading popups that use `DelayedLoadingHeader`.

*Call graph*: 1 external calls (from).


##### `PluginDisclosureLine::render`  (lines 152–157)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the plugin data-sharing disclosure line and marks the help-article URL as a hyperlink in the buffer.

**Data flow**: It clones its stored `Line<'static>`, renders it as a wrapped `Paragraph` into the given area/buffer, then calls `mark_url_hyperlink` with the fixed apps help URL.

**Call relations**: This renderable is inserted into plugin detail headers for not-yet-installed plugins.

*Call graph*: 3 external calls (clone, new, mark_url_hyperlink).


##### `PluginDisclosureLine::desired_height`  (lines 159–165)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Computes how many wrapped lines the disclosure text will occupy at a given width.

**Data flow**: It clones its stored line, wraps it in a `Paragraph`, asks for `line_count(width)`, converts that to `u16`, and saturates to `u16::MAX` on conversion failure.

**Call relations**: This supports layout for plugin detail headers containing the disclosure line.

*Call graph*: 2 external calls (clone, new).


##### `ChatWidget::add_plugins_output`  (lines 178–202)

```
fn add_plugins_output(&mut self)
```

**Purpose**: Entry point for opening the plugins UI: checks the feature flag, starts prefetching, and shows cached results, an error, or a loading popup.

**Data flow**: It reads `self.config.features.enabled(Feature::Plugins)`, writes an info message and returns if disabled, otherwise sets `self.plugins_active_tab_id` to the all-plugins tab, calls `prefetch_plugins()`, inspects `plugins_cache_for_current_cwd()`, opens the plugins popup or loading popup or adds an error history cell accordingly, and requests redraw.

**Call relations**: This is the top-level plugins command handler. It delegates fetching to `ChatWidget::prefetch_plugins` and popup construction to `ChatWidget::open_plugins_popup` or `ChatWidget::open_plugins_loading_popup`.

*Call graph*: calls 4 internal fn (open_plugins_loading_popup, open_plugins_popup, plugins_cache_for_current_cwd, prefetch_plugins); 1 external calls (new_error_event).


##### `ChatWidget::on_plugins_loaded`  (lines 204–275)

```
fn on_plugins_loaded(
        &mut self,
        cwd: PathBuf,
        result: Result<PluginListResponse, String>,
    )
```

**Purpose**: Applies the result of a plugin-list fetch for the current cwd, updates cache and remote-section state, and refreshes the popup when appropriate.

**Data flow**: It takes a cwd and `Result<PluginListResponse, String>`, clears `in_flight_cwd` if this response matches it, ignores responses for non-current cwd, computes whether the popup should refresh based on auth-flow and popup visibility/cache state, and then on success updates cache cwd, remote-section flags, saved tab IDs, `plugins_cache`, and possibly refreshes the popup; on error it clears remote-section flags and, if refreshing, stores a failed cache state and replaces the active popup with `plugins_error_popup_params`.

**Call relations**: This is the main completion handler for plugin-list fetches started by `ChatWidget::prefetch_plugins`. It may delegate UI rebuilding to `ChatWidget::refresh_plugins_popup_if_open`.

*Call graph*: calls 2 internal fn (plugins_error_popup_params, refresh_plugins_popup_if_open); 4 external calls (as_path, matches!, Failed, Ready).


##### `ChatWidget::on_plugin_remote_sections_loaded`  (lines 277–312)

```
fn on_plugin_remote_sections_loaded(
        &mut self,
        cwd: PathBuf,
        marketplaces: Vec<PluginMarketplaceEntry>,
        section_errors: Vec<PluginRemoteSectionError>,
    )
```

**Purpose**: Merges asynchronously loaded remote marketplace sections into the cached plugin list and refreshes the popup if it is open.

**Data flow**: It takes a cwd, remote marketplaces, and remote-section errors, ignores non-current cwd, marks remote-section loading complete and loaded true, updates `self.plugin_remote_section_errors`, and when the cache is a ready response for the same cwd mutates it via `merge_remote_marketplaces`, clones the refreshed response, and refreshes the popup if the plugins view currently has an active tab.

**Call relations**: This handler complements `ChatWidget::on_plugins_loaded` by filling in remote marketplace sections after the base list is ready.

*Call graph*: calls 2 internal fn (refresh_plugins_popup_if_open, merge_remote_marketplaces); 1 external calls (as_path).


##### `ChatWidget::prefetch_plugins`  (lines 314–322)

```
fn prefetch_plugins(&mut self)
```

**Purpose**: Starts a plugin-list fetch for the current cwd unless one is already in flight.

**Data flow**: It reads `self.config.cwd`, compares it to `self.plugins_fetch_state.in_flight_cwd`, returns early if already fetching that cwd, otherwise marks fetch start via `on_plugins_list_fetch_started(cwd.clone())` and sends `AppEvent::FetchPluginsList { cwd }`.

**Call relations**: This helper is called by `ChatWidget::add_plugins_output` before deciding which popup to show.

*Call graph*: calls 1 internal fn (on_plugins_list_fetch_started); called by 1 (add_plugins_output).


##### `ChatWidget::on_plugins_list_fetch_started`  (lines 324–333)

```
fn on_plugins_list_fetch_started(&mut self, cwd: PathBuf)
```

**Purpose**: Marks the plugin list as loading for the given cwd and records that a fetch is in flight.

**Data flow**: It takes a cwd, ignores it if it does not match `self.config.cwd`, writes `Some(cwd.clone())` into `self.plugins_fetch_state.in_flight_cwd`, and if the cache is for a different cwd sets `self.plugins_cache = PluginsCacheState::Loading`.

**Call relations**: This state transition is invoked by `ChatWidget::prefetch_plugins` before the actual fetch event is sent.

*Call graph*: called by 1 (prefetch_plugins); 2 external calls (as_path, clone).


##### `ChatWidget::plugins_cache_for_current_cwd`  (lines 335–341)

```
fn plugins_cache_for_current_cwd(&self) -> PluginsCacheState
```

**Purpose**: Returns the plugin cache only when it belongs to the widget’s current cwd; otherwise reports it as uninitialized.

**Data flow**: It compares `self.plugins_fetch_state.cache_cwd` against `self.config.cwd.as_path()` and returns either a clone of `self.plugins_cache` or `PluginsCacheState::Uninitialized`.

**Call relations**: This helper is used throughout the file to avoid showing stale plugin data after cwd changes.

*Call graph*: called by 10 (add_plugins_output, finish_plugin_install_auth_flow, handle_plugins_popup_key_event, marketplace_add_error_popup_params, marketplace_remove_error_popup_params, on_plugin_detail_loaded, on_plugin_enabled_set, on_plugin_install_loaded, on_plugin_uninstall_loaded, open_marketplace_remove_confirmation).


##### `ChatWidget::open_plugins_loading_popup`  (lines 343–351)

```
fn open_plugins_loading_popup(&mut self)
```

**Purpose**: Shows or replaces the plugins loading popup.

**Data flow**: It builds params with `plugins_loading_popup_params()` and first tries `replace_selection_view_if_active(PLUGINS_SELECTION_VIEW_ID, ...)`; if that fails it calls `show_selection_view(...)`.

**Call relations**: This popup is opened from `ChatWidget::add_plugins_output` when no ready cache is available yet.

*Call graph*: calls 1 internal fn (plugins_loading_popup_params); called by 1 (add_plugins_output).


##### `ChatWidget::open_plugins_popup`  (lines 353–361)

```
fn open_plugins_popup(&mut self, response: &PluginListResponse)
```

**Purpose**: Shows the main plugins popup initialized to the all-plugins tab.

**Data flow**: It sets `self.plugins_active_tab_id` to the all-plugins tab ID and writes a selection view built by `plugins_popup_params(response, self.plugins_active_tab_id.clone(), None)` into `self.bottom_pane`.

**Call relations**: This is called by `ChatWidget::add_plugins_output` when a ready plugin list is already cached.

*Call graph*: calls 1 internal fn (plugins_popup_params); called by 1 (add_plugins_output).


##### `ChatWidget::open_marketplace_add_prompt`  (lines 363–387)

```
fn open_marketplace_add_prompt(&mut self)
```

**Purpose**: Opens a custom text prompt where the user can enter a marketplace source to add.

**Data flow**: It sets `self.plugins_active_tab_id` to the add-marketplace tab, captures `app_event_tx` and current cwd, constructs a `CustomPromptView` with title, placeholder, hint, and a submit closure that trims the source and, if non-empty, sends `OpenMarketplaceAddLoading` and `FetchMarketplaceAdd { cwd, source }`, then shows that view in `self.bottom_pane`.

**Call relations**: This prompt is reached from the Add Marketplace tab and starts the marketplace-add fetch flow.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, new).


##### `ChatWidget::open_marketplace_add_loading_popup`  (lines 389–399)

```
fn open_marketplace_add_loading_popup(&mut self, _source: &str)
```

**Purpose**: Shows or replaces the loading popup used while a marketplace add request is running.

**Data flow**: It sets the active tab ID to add-marketplace, builds params with `marketplace_add_loading_popup_params()`, and either replaces the active plugins selection view or shows a new one.

**Call relations**: This popup is opened immediately before or during the marketplace-add request started from `ChatWidget::open_marketplace_add_prompt`.

*Call graph*: calls 1 internal fn (marketplace_add_loading_popup_params).


##### `ChatWidget::open_marketplace_upgrade_loading_popup`  (lines 401–419)

```
fn open_marketplace_upgrade_loading_popup(
        &mut self,
        marketplace_name: Option<&str>,
    )
```

**Purpose**: Shows or replaces the loading popup for marketplace upgrade operations, preserving the currently active marketplace tab when possible.

**Data flow**: It reads the active tab from the current plugins view or falls back to `self.plugins_active_tab_id`, stores that back into `self.plugins_active_tab_id`, builds params with `marketplace_upgrade_loading_popup_params(marketplace_name)`, and replaces or shows the popup.

**Call relations**: This is called from `ChatWidget::handle_plugins_popup_key_event` when the user presses the upgrade shortcut on an eligible marketplace tab.

*Call graph*: calls 1 internal fn (marketplace_upgrade_loading_popup_params); called by 1 (handle_plugins_popup_key_event).


##### `ChatWidget::open_marketplace_remove_confirmation`  (lines 421–454)

```
fn open_marketplace_remove_confirmation(
        &mut self,
        marketplace_name: String,
        marketplace_display_name: String,
    )
```

**Purpose**: Shows a confirmation popup before removing a configured marketplace.

**Data flow**: It preserves the current active tab ID, reads the current ready plugin cache via `plugins_cache_for_current_cwd()`, returns early if unavailable, builds params with `marketplace_remove_confirmation_popup_params`, and replaces or shows the popup.

**Call relations**: This confirmation is opened from `ChatWidget::handle_plugins_popup_key_event` when the user presses the remove shortcut on a removable marketplace tab.

*Call graph*: calls 2 internal fn (marketplace_remove_confirmation_popup_params, plugins_cache_for_current_cwd); called by 1 (handle_plugins_popup_key_event).


##### `ChatWidget::open_marketplace_remove_loading_popup`  (lines 456–466)

```
fn open_marketplace_remove_loading_popup(&mut self, marketplace_display_name: &str)
```

**Purpose**: Shows or replaces the loading popup while a marketplace removal request is in progress.

**Data flow**: It builds params with `marketplace_remove_loading_popup_params(marketplace_display_name)` and replaces or shows the plugins selection view.

**Call relations**: This popup is part of the remove-marketplace flow initiated from the confirmation popup.

*Call graph*: calls 1 internal fn (marketplace_remove_loading_popup_params).


##### `ChatWidget::open_plugin_detail_loading_popup`  (lines 468–478)

```
fn open_plugin_detail_loading_popup(&mut self, plugin_display_name: &str)
```

**Purpose**: Replaces the plugins popup with a loading state while plugin details are being fetched.

**Data flow**: It preserves the current active tab ID, builds params with `plugin_detail_loading_popup_params(plugin_display_name)`, and attempts to replace the active plugins selection view.

**Call relations**: This loading state is shown before `FetchPluginDetail` requests sent from plugin rows.

*Call graph*: calls 1 internal fn (plugin_detail_loading_popup_params).


##### `ChatWidget::open_plugin_install_loading_popup`  (lines 480–485)

```
fn open_plugin_install_loading_popup(&mut self, plugin_display_name: &str)
```

**Purpose**: Replaces the current plugins view with a loading popup while a plugin install request is running.

**Data flow**: It builds params with `plugin_install_loading_popup_params(plugin_display_name)` and attempts to replace the active plugins selection view.

**Call relations**: This popup is shown from install actions in the plugin detail view.

*Call graph*: calls 1 internal fn (plugin_install_loading_popup_params).


##### `ChatWidget::open_plugin_uninstall_loading_popup`  (lines 487–492)

```
fn open_plugin_uninstall_loading_popup(&mut self, plugin_display_name: &str)
```

**Purpose**: Replaces the current plugins view with a loading popup while a plugin uninstall request is running.

**Data flow**: It builds params with `plugin_uninstall_loading_popup_params(plugin_display_name)` and attempts to replace the active plugins selection view.

**Call relations**: This popup is shown from uninstall actions in the plugin detail view.

*Call graph*: calls 1 internal fn (plugin_uninstall_loading_popup_params).


##### `ChatWidget::on_plugin_detail_loaded`  (lines 494–524)

```
fn on_plugin_detail_loaded(
        &mut self,
        cwd: PathBuf,
        result: Result<PluginReadResponse, String>,
    )
```

**Purpose**: Handles completion of a plugin-detail fetch by replacing the loading popup with either the detail view or an error view.

**Data flow**: It takes a cwd and `Result<PluginReadResponse, String>`, ignores non-current cwd, snapshots the current ready plugin list if available, and on success replaces the active plugins view with `plugin_detail_popup_params(&plugins_response, &response.plugin)` when the list exists; on error it replaces the view with `plugin_detail_error_popup_params(&err, plugins_response.as_ref())`.

**Call relations**: This is the completion handler for detail fetches initiated from plugin rows built by `ChatWidget::plugin_selection_items`.

*Call graph*: calls 3 internal fn (plugin_detail_error_popup_params, plugin_detail_popup_params, plugins_cache_for_current_cwd); 1 external calls (as_path).


##### `ChatWidget::on_plugin_install_loaded`  (lines 526–584)

```
fn on_plugin_install_loaded(
        &mut self,
        cwd: PathBuf,
        _location: PluginLocation,
        _plugin_name: String,
        plugin_display_name: String,
        result: Result<Plugi
```

**Purpose**: Handles plugin installation completion, either finishing immediately with an info message or entering the follow-up app-authentication flow.

**Data flow**: It takes cwd, plugin location/name metadata, display name, and `Result<PluginInstallResponse, String>`, ignores non-current cwd, and on success stores `response.apps_needing_auth` into `self.plugin_install_apps_needing_auth`, clears any old auth flow, and either adds a success message and returns `true` when no apps need auth or records a new `PluginInstallAuthFlowState`, opens the auth popup, and returns `false`. On error it clears auth-flow state, builds an error popup from the current plugin list if available, replaces the active view, and returns `true`.

**Call relations**: This handler follows install actions from the plugin detail popup. When bundled apps still need ChatGPT-side setup, it delegates to `ChatWidget::open_plugin_install_auth_popup`.

*Call graph*: calls 3 internal fn (open_plugin_install_auth_popup, plugin_detail_error_popup_params, plugins_cache_for_current_cwd); 2 external calls (as_path, format!).


##### `ChatWidget::on_marketplace_add_loaded`  (lines 586–630)

```
fn on_marketplace_add_loaded(
        &mut self,
        cwd: PathBuf,
        _source: String,
        result: Result<MarketplaceAddResponse, String>,
    )
```

**Purpose**: Handles marketplace-add completion by selecting the new marketplace tab and showing a success message, or by opening an add-error popup.

**Data flow**: It takes cwd, source, and `Result<MarketplaceAddResponse, String>`, ignores non-current cwd, and on success computes the marketplace tab ID from `installed_root`, stores it in `self.plugins_active_tab_id`, optionally marks it as newly installed, and adds an info message describing whether the marketplace was newly added or already present. On error it resets the active tab to add-marketplace and replaces or shows `marketplace_add_error_popup_params()`.

**Call relations**: This is the completion handler for the add-marketplace flow started from `ChatWidget::open_marketplace_add_prompt`.

*Call graph*: calls 2 internal fn (marketplace_add_error_popup_params, marketplace_tab_id_from_path); 2 external calls (as_path, format!).


##### `ChatWidget::on_marketplace_remove_loaded`  (lines 632–677)

```
fn on_marketplace_remove_loaded(
        &mut self,
        cwd: PathBuf,
        marketplace_name: String,
        marketplace_display_name: String,
        result: Result<MarketplaceRemoveResponse,
```

**Purpose**: Handles marketplace-removal completion by returning to the all-plugins tab with a success message or by showing a retry/error popup.

**Data flow**: It takes cwd, marketplace name/display name, and `Result<MarketplaceRemoveResponse, String>`, ignores non-current cwd, and on success sets `self.plugins_active_tab_id` to all-plugins and adds an info message mentioning either the removed root path or config-only removal. On error it replaces or shows `marketplace_remove_error_popup_params(...)`.

**Call relations**: This handler completes the remove-marketplace flow initiated from the confirmation popup.

*Call graph*: calls 1 internal fn (marketplace_remove_error_popup_params); 2 external calls (as_path, format!).


##### `ChatWidget::on_marketplace_upgrade_loaded`  (lines 679–768)

```
fn on_marketplace_upgrade_loaded(
        &mut self,
        cwd: PathBuf,
        result: Result<MarketplaceUpgradeResponse, String>,
    )
```

**Purpose**: Summarizes marketplace-upgrade results, selecting a marketplace tab when exactly one root was upgraded and emitting info/error messages for up-to-date, upgraded, or failed marketplaces.

**Data flow**: It takes cwd and `Result<MarketplaceUpgradeResponse, String>`, ignores non-current cwd, and on success may set `self.plugins_active_tab_id` from the single upgraded root, then computes selected/upgraded/error counts and emits one or more messages describing no-op, successful upgrades, and failures. On error it adds a single error message.

**Call relations**: This is the completion handler for upgrade requests started from `ChatWidget::handle_plugins_popup_key_event`.

*Call graph*: calls 1 internal fn (marketplace_tab_id_from_path); 2 external calls (as_path, format!).


##### `ChatWidget::handle_plugins_popup_key_event`  (lines 770–822)

```
fn handle_plugins_popup_key_event(&mut self, key_event: KeyEvent) -> bool
```

**Purpose**: Intercepts plugin-popup keyboard shortcuts for marketplace removal and upgrade on eligible marketplace tabs.

**Data flow**: It takes a `KeyEvent`, checks whether it matches ctrl-r or ctrl-u, reads the active plugins tab and current ready plugin cache, finds the marketplace corresponding to that tab and verifies whether it is user-configured and/or Git-backed, then either opens remove confirmation, opens upgrade loading and sends upgrade events, or returns `false` when the shortcut is not applicable. It returns `true` when the key was consumed.

**Call relations**: This function is part of the interactive plugins popup loop. It delegates to `ChatWidget::open_marketplace_remove_confirmation` or `ChatWidget::open_marketplace_upgrade_loading_popup` depending on the shortcut.

*Call graph*: calls 6 internal fn (open_marketplace_remove_confirmation, open_marketplace_upgrade_loading_popup, plugins_cache_for_current_cwd, marketplace_display_name, marketplace_is_user_configured_git, ctrl); 1 external calls (Char).


##### `ChatWidget::on_plugin_enabled_set`  (lines 824–865)

```
fn on_plugin_enabled_set(
        &mut self,
        cwd: PathBuf,
        plugin_id: String,
        enabled: bool,
        result: Result<(), String>,
    )
```

**Purpose**: Applies the result of toggling a plugin’s enabled state, updating the cached plugin list in place or restoring the popup after an error.

**Data flow**: It takes cwd, plugin ID, target enabled flag, and `Result<(), String>`, ignores non-current cwd, and on error adds an error message and refreshes the popup from the current cache if ready. On success it mutates matching plugins inside the cached ready response for that cwd, clones the refreshed response, and refreshes the popup if one was updated.

**Call relations**: This handler completes toggle actions emitted from `SelectionToggle`s created by `ChatWidget::plugin_selection_items`.

*Call graph*: calls 2 internal fn (plugins_cache_for_current_cwd, refresh_plugins_popup_if_open); 2 external calls (as_path, format!).


##### `ChatWidget::on_plugin_uninstall_loaded`  (lines 867–897)

```
fn on_plugin_uninstall_loaded(
        &mut self,
        cwd: PathBuf,
        plugin_display_name: String,
        result: Result<PluginUninstallResponse, String>,
    )
```

**Purpose**: Handles plugin uninstall completion by clearing any install-auth flow state and showing success or error UI.

**Data flow**: It takes cwd, plugin display name, and `Result<PluginUninstallResponse, String>`, ignores non-current cwd, and on success clears `plugin_install_apps_needing_auth` and `plugin_install_auth_flow` and adds an info message. On error it replaces the active plugins view with `plugin_detail_error_popup_params` using the current plugin list if available.

**Call relations**: This is the completion handler for uninstall actions from the plugin detail popup.

*Call graph*: calls 2 internal fn (plugin_detail_error_popup_params, plugins_cache_for_current_cwd); 2 external calls (as_path, format!).


##### `ChatWidget::advance_plugin_install_auth_flow`  (lines 899–914)

```
fn advance_plugin_install_auth_flow(&mut self)
```

**Purpose**: Moves the plugin install app-auth flow to the next required app or finishes the flow when all apps have been handled.

**Data flow**: It mutably reads `self.plugin_install_auth_flow`, increments `next_app_index`, computes whether that index has reached `self.plugin_install_apps_needing_auth.len()`, and either calls `finish_plugin_install_auth_flow(false)` or reopens the auth popup.

**Call relations**: This function is triggered by actions in the auth popup after the user confirms an app is installed or already present.

*Call graph*: calls 2 internal fn (finish_plugin_install_auth_flow, open_plugin_install_auth_popup).


##### `ChatWidget::abandon_plugin_install_auth_flow`  (lines 916–918)

```
fn abandon_plugin_install_auth_flow(&mut self)
```

**Purpose**: Terminates the remaining plugin install app-auth flow as skipped.

**Data flow**: It simply calls `finish_plugin_install_auth_flow(true)` and returns no value.

**Call relations**: This is the skip path from the auth popup’s “Skip remaining app setup” action.

*Call graph*: calls 1 internal fn (finish_plugin_install_auth_flow).


##### `ChatWidget::open_plugin_install_auth_popup`  (lines 920–932)

```
fn open_plugin_install_auth_popup(&mut self)
```

**Purpose**: Shows the current step of the plugin install app-auth flow, or finishes the flow immediately if no valid step remains.

**Data flow**: It asks `plugin_install_auth_popup_params()` for the current popup model. If `None`, it calls `finish_plugin_install_auth_flow(false)`. Otherwise it tries to replace the active plugins selection view; if replacement fails it recomputes params and shows a new selection view.

**Call relations**: This popup is opened from `ChatWidget::on_plugin_install_loaded` when apps need authentication and from `ChatWidget::advance_plugin_install_auth_flow` for subsequent steps.

*Call graph*: calls 2 internal fn (finish_plugin_install_auth_flow, plugin_install_auth_popup_params); called by 2 (advance_plugin_install_auth_flow, on_plugin_install_loaded).


##### `ChatWidget::plugin_install_auth_popup_params`  (lines 934–1033)

```
fn plugin_install_auth_popup_params(&self) -> Option<SelectionViewParams>
```

**Purpose**: Builds the selection view for one step of the post-install app-authentication flow.

**Data flow**: It reads `self.plugin_install_auth_flow`, the current app from `self.plugin_install_apps_needing_auth`, and whether that app is already installed via `plugin_install_auth_app_is_installed`. It builds a header showing plugin name and step count, then creates items for opening the ChatGPT install/manage URL when available, continuing or confirming installation depending on current app state, and skipping the remaining flow. It returns `Some(SelectionViewParams)` or `None` if flow state is incomplete.

**Call relations**: This pure-ish builder is consumed by `ChatWidget::open_plugin_install_auth_popup` to render each auth step.

*Call graph*: calls 3 internal fn (plugin_install_auth_app_is_installed, plugin_detail_hint_line, new); called by 1 (open_plugin_install_auth_popup); 6 external calls (new, default, from, new, format!, vec!).


##### `ChatWidget::plugin_install_auth_app_is_installed`  (lines 1035–1041)

```
fn plugin_install_auth_app_is_installed(&self, app_id: &str) -> bool
```

**Purpose**: Checks whether a required app from the plugin install flow is already accessible in the current session’s connectors list.

**Data flow**: It takes an app ID string slice, reads `self.connectors_for_mentions()`, and returns `true` when any connector has the same ID and `is_accessible == true`.

**Call relations**: This helper is used by `ChatWidget::plugin_install_auth_popup_params` to decide whether to show “Continue” or “I've installed it” and how to phrase the status line.

*Call graph*: called by 1 (plugin_install_auth_popup_params).


##### `ChatWidget::finish_plugin_install_auth_flow`  (lines 1043–1081)

```
fn finish_plugin_install_auth_flow(&mut self, abandoned: bool)
```

**Purpose**: Ends the plugin install app-auth flow, emits a completion or skipped message, clears flow state, and restores the main plugins popup if cached data is available.

**Data flow**: It takes an `abandoned` flag, removes `self.plugin_install_auth_flow`, clears `self.plugin_install_apps_needing_auth`, adds an info message tailored to completion vs skip, reads the current ready plugin cache, and if present replaces the active plugins view with `plugins_popup_params(&plugins_response, self.plugins_active_tab_id.clone(), None)`.

**Call relations**: This shared teardown path is called by `ChatWidget::advance_plugin_install_auth_flow`, `ChatWidget::abandon_plugin_install_auth_flow`, and `ChatWidget::open_plugin_install_auth_popup` when no valid auth step remains.

*Call graph*: calls 2 internal fn (plugins_cache_for_current_cwd, plugins_popup_params); called by 3 (abandon_plugin_install_auth_flow, advance_plugin_install_auth_flow, open_plugin_install_auth_popup); 1 external calls (format!).


##### `ChatWidget::refresh_plugins_popup_if_open`  (lines 1083–1097)

```
fn refresh_plugins_popup_if_open(&mut self, response: &PluginListResponse)
```

**Purpose**: Rebuilds the plugins popup in place while preserving the current tab and selected row when the popup is already open.

**Data flow**: It reads the active tab ID and selected index from the current plugins view, falls back to `self.plugins_active_tab_id` when needed, stores the chosen tab back into `self.plugins_active_tab_id`, and attempts to replace the active plugins selection view with `plugins_popup_params(response, active_tab_id, selected_idx)`.

**Call relations**: This helper is used after cache mutations or fetch completions so the visible plugins popup stays synchronized without losing the user’s place.

*Call graph*: calls 1 internal fn (plugins_popup_params); called by 3 (on_plugin_enabled_set, on_plugin_remote_sections_loaded, on_plugins_loaded).


##### `ChatWidget::plugins_loading_popup_params`  (lines 1099–1116)

```
fn plugins_loading_popup_params(&self) -> SelectionViewParams
```

**Purpose**: Builds the generic loading popup shown while the plugin list is being fetched.

**Data flow**: It returns a `SelectionViewParams` with the plugins selection view ID, a `DelayedLoadingHeader` configured for “Loading available plugins...”, and one disabled loading row.

**Call relations**: This builder is used by `ChatWidget::open_plugins_loading_popup`.

*Call graph*: calls 1 internal fn (new); called by 1 (open_plugins_loading_popup); 3 external calls (new, default, vec!).


##### `ChatWidget::marketplace_add_loading_popup_params`  (lines 1118–1137)

```
fn marketplace_add_loading_popup_params(&self) -> SelectionViewParams
```

**Purpose**: Builds the loading popup shown while a marketplace is being added.

**Data flow**: It returns a `SelectionViewParams` with the plugins selection view ID, a `DelayedLoadingHeader` for “Adding marketplace...”, and one disabled loading row.

**Call relations**: This builder is used by `ChatWidget::open_marketplace_add_loading_popup`.

*Call graph*: calls 1 internal fn (new); called by 1 (open_marketplace_add_loading_popup); 3 external calls (new, default, vec!).


##### `ChatWidget::marketplace_remove_confirmation_popup_params`  (lines 1139–1211)

```
fn marketplace_remove_confirmation_popup_params(
        &self,
        plugins_response: &PluginListResponse,
        marketplace_name: String,
        marketplace_display_name: String,
    ) -> Sele
```

**Purpose**: Builds the confirmation popup for removing a marketplace, including remove and back actions plus an on-cancel restoration action.

**Data flow**: It takes the current `PluginListResponse`, marketplace name, and display name; builds a header; captures cwd and cloned plugin response for restoration; creates a remove action that opens the remove-loading popup and sends `FetchMarketplaceRemove`, a back action that replays `AppEvent::PluginsLoaded` with the cached response, and an `on_cancel` closure that does the same restoration; then returns the assembled `SelectionViewParams`.

**Call relations**: This builder is used by `ChatWidget::open_marketplace_remove_confirmation`.

*Call graph*: calls 1 internal fn (new); called by 1 (open_marketplace_remove_confirmation); 6 external calls (new, default, from, clone, format!, vec!).


##### `ChatWidget::marketplace_remove_loading_popup_params`  (lines 1213–1234)

```
fn marketplace_remove_loading_popup_params(
        &self,
        marketplace_display_name: &str,
    ) -> SelectionViewParams
```

**Purpose**: Builds the loading popup shown while a marketplace removal is in progress.

**Data flow**: It takes a marketplace display name, builds a simple header with “Removing ...”, and returns a `SelectionViewParams` containing one disabled loading row.

**Call relations**: This builder is used by `ChatWidget::open_marketplace_remove_loading_popup`.

*Call graph*: calls 1 internal fn (new); called by 1 (open_marketplace_remove_loading_popup); 5 external calls (new, default, from, format!, vec!).


##### `ChatWidget::marketplace_upgrade_loading_popup_params`  (lines 1236–1259)

```
fn marketplace_upgrade_loading_popup_params(
        &self,
        marketplace_name: Option<&str>,
    ) -> SelectionViewParams
```

**Purpose**: Builds the loading popup shown while one or more marketplaces are being upgraded.

**Data flow**: It takes an optional marketplace name, derives either a specific or generic loading string, and returns a `SelectionViewParams` with a `DelayedLoadingHeader` and one disabled loading row.

**Call relations**: This builder is used by `ChatWidget::open_marketplace_upgrade_loading_popup`.

*Call graph*: calls 1 internal fn (new); called by 1 (open_marketplace_upgrade_loading_popup); 3 external calls (new, default, vec!).


##### `ChatWidget::plugin_detail_loading_popup_params`  (lines 1261–1278)

```
fn plugin_detail_loading_popup_params(&self, plugin_display_name: &str) -> SelectionViewParams
```

**Purpose**: Builds the loading popup shown while plugin details are being fetched.

**Data flow**: It takes a plugin display name and returns a `SelectionViewParams` with a `DelayedLoadingHeader` for “Loading details for ...” and one disabled loading row.

**Call relations**: This builder is used by `ChatWidget::open_plugin_detail_loading_popup`.

*Call graph*: calls 1 internal fn (new); called by 1 (open_plugin_detail_loading_popup); 4 external calls (new, default, format!, vec!).


##### `ChatWidget::plugin_install_loading_popup_params`  (lines 1280–1301)

```
fn plugin_install_loading_popup_params(
        &self,
        plugin_display_name: &str,
    ) -> SelectionViewParams
```

**Purpose**: Builds the loading popup shown while a plugin install request is running.

**Data flow**: It takes a plugin display name, builds a simple header with “Installing ...”, and returns a `SelectionViewParams` containing one disabled loading row.

**Call relations**: This builder is used by `ChatWidget::open_plugin_install_loading_popup`.

*Call graph*: calls 1 internal fn (new); called by 1 (open_plugin_install_loading_popup); 5 external calls (new, default, from, format!, vec!).


##### `ChatWidget::plugin_uninstall_loading_popup_params`  (lines 1303–1324)

```
fn plugin_uninstall_loading_popup_params(
        &self,
        plugin_display_name: &str,
    ) -> SelectionViewParams
```

**Purpose**: Builds the loading popup shown while a plugin uninstall request is running.

**Data flow**: It takes a plugin display name, builds a simple header with “Uninstalling ...”, and returns a `SelectionViewParams` containing one disabled loading row.

**Call relations**: This builder is used by `ChatWidget::open_plugin_uninstall_loading_popup`.

*Call graph*: calls 1 internal fn (new); called by 1 (open_plugin_uninstall_loading_popup); 5 external calls (new, default, from, format!, vec!).


##### `ChatWidget::plugins_error_popup_params`  (lines 1326–1342)

```
fn plugins_error_popup_params(&self, err: &str) -> SelectionViewParams
```

**Purpose**: Builds the error popup shown when the plugin list cannot be loaded.

**Data flow**: It takes an error string, builds a header indicating plugin load failure, and returns a `SelectionViewParams` with one disabled row containing the error text.

**Call relations**: This builder is used by `ChatWidget::on_plugins_loaded` on fetch failure.

*Call graph*: calls 1 internal fn (new); called by 1 (on_plugins_loaded); 4 external calls (new, default, from, vec!).


##### `ChatWidget::marketplace_add_error_popup_params`  (lines 1344–1392)

```
fn marketplace_add_error_popup_params(&self) -> SelectionViewParams
```

**Purpose**: Builds the retry/back popup shown when adding a marketplace fails.

**Data flow**: It builds a failure header and default items for a disabled failure row plus a “Try again” action that reopens the add prompt. If a ready plugin cache exists for the current cwd, it also adds a “Back to plugins” action that replays `AppEvent::PluginsLoaded` with the cached response. It returns the assembled `SelectionViewParams`.

**Call relations**: This builder is used by `ChatWidget::on_marketplace_add_loaded` on error.

*Call graph*: calls 3 internal fn (plugins_cache_for_current_cwd, plugin_detail_hint_line, new); called by 1 (on_marketplace_add_loaded); 4 external calls (new, default, from, vec!).


##### `ChatWidget::marketplace_remove_error_popup_params`  (lines 1394–1449)

```
fn marketplace_remove_error_popup_params(
        &self,
        marketplace_name: &str,
        marketplace_display_name: &str,
    ) -> SelectionViewParams
```

**Purpose**: Builds the retry/back popup shown when removing a marketplace fails.

**Data flow**: It takes marketplace name and display name, builds a failure header, adds a disabled failure row and a “Try again” action that reopens the remove confirmation, and optionally adds a “Back to plugins” action using the current ready cache. It returns the resulting `SelectionViewParams`.

**Call relations**: This builder is used by `ChatWidget::on_marketplace_remove_loaded` on error.

*Call graph*: calls 3 internal fn (plugins_cache_for_current_cwd, plugin_detail_hint_line, new); called by 1 (on_marketplace_remove_loaded); 4 external calls (new, default, from, vec!).


##### `ChatWidget::plugin_detail_error_popup_params`  (lines 1451–1489)

```
fn plugin_detail_error_popup_params(
        &self,
        err: &str,
        plugins_response: Option<&PluginListResponse>,
    ) -> SelectionViewParams
```

**Purpose**: Builds the error popup shown when plugin details, install, or uninstall operations fail and the UI should offer a path back to the plugin list.

**Data flow**: It takes an error string and optional `PluginListResponse`, builds a failure header and disabled error row, and when a plugin list is available adds a “Back to plugins” action that replays `AppEvent::PluginsLoaded` with that response. It returns the assembled `SelectionViewParams`.

**Call relations**: This builder is used by `ChatWidget::on_plugin_detail_loaded`, `ChatWidget::on_plugin_install_loaded`, and `ChatWidget::on_plugin_uninstall_loaded` on failure paths.

*Call graph*: calls 2 internal fn (plugin_detail_hint_line, new); called by 3 (on_plugin_detail_loaded, on_plugin_install_loaded, on_plugin_uninstall_loaded); 4 external calls (new, default, from, vec!).


##### `ChatWidget::plugins_popup_params`  (lines 1491–1668)

```
fn plugins_popup_params(
        &self,
        response: &PluginListResponse,
        active_tab_id: Option<String>,
        initial_selected_idx: Option<usize>,
    ) -> SelectionViewParams
```

**Purpose**: Builds the main tabbed plugins popup, including aggregate tabs, per-marketplace tabs, search metadata, footer hints, and row width calculations.

**Data flow**: It takes a `PluginListResponse`, optional active tab ID, and optional selected index. It computes marketplace/plugin aggregates, flattens plugin entries, calculates name-column width, builds tabs for all plugins, installed plugins, OpenAI Curated, sorted additional marketplaces with disambiguated labels and optional remove/upgrade footer hints, and the Add Marketplace tab, then returns a fully populated searchable `SelectionViewParams` preserving the requested initial tab and selection.

**Call relations**: This is the central popup builder used by `ChatWidget::open_plugins_popup`, `ChatWidget::refresh_plugins_popup_if_open`, and `ChatWidget::finish_plugin_install_auth_flow`.

*Call graph*: calls 9 internal fn (marketplace_add_tab, plugin_selection_items, disambiguate_duplicate_tab_labels, marketplace_is_user_configured, marketplace_is_user_configured_git, marketplace_tab_id, plugin_entries_for_marketplaces, plugins_header, plugins_popup_hint_line); called by 3 (finish_plugin_install_auth_flow, open_plugins_popup, refresh_plugins_popup_if_open); 5 external calls (new, default, width, new, format!).


##### `ChatWidget::marketplace_add_tab`  (lines 1670–1692)

```
fn marketplace_add_tab(&self) -> SelectionTab
```

**Purpose**: Builds the dedicated tab that lets the user open the marketplace-add prompt.

**Data flow**: It returns a `SelectionTab` with the add-marketplace tab ID, explanatory header from `plugins_header`, and one row whose action sends `AppEvent::OpenMarketplaceAddPrompt`.

**Call relations**: This helper is used by `ChatWidget::plugins_popup_params` when assembling the tab list.

*Call graph*: calls 1 internal fn (plugins_header); called by 1 (plugins_popup_params); 1 external calls (vec!).


##### `ChatWidget::plugin_detail_popup_params`  (lines 1694–1863)

```
fn plugin_detail_popup_params(
        &self,
        plugins_response: &PluginListResponse,
        plugin: &PluginDetail,
    ) -> SelectionViewParams
```

**Purpose**: Builds the plugin detail popup with install/uninstall actions, disclosure text, and read-only summaries of plugin capabilities.

**Data flow**: It takes the current plugin list and a `PluginDetail`, derives display/status labels, builds a header that may include `PluginDisclosureLine` and a description, creates a back action restoring the plugin list, conditionally adds install or uninstall actions depending on installation state, availability, install policy, and available location/uninstall identity, then appends disabled summary rows for skills, hooks, apps, and MCP servers. It returns the resulting `SelectionViewParams`.

**Call relations**: This builder is used by `ChatWidget::on_plugin_detail_loaded` on successful detail fetches.

*Call graph*: calls 11 internal fn (plugin_app_summary, plugin_detail_description, plugin_detail_hint_line, plugin_detail_location, plugin_display_name, plugin_hook_summary, plugin_mcp_summary, plugin_request_name, plugin_skill_summary, plugin_uninstall_id (+1 more)); called by 1 (on_plugin_detail_loaded); 6 external calls (new, default, from, clone, format!, vec!).


##### `ChatWidget::plugin_selection_items`  (lines 1865–1977)

```
fn plugin_selection_items(
        &self,
        mut plugin_entries: Vec<(&'a PluginMarketplaceEntry, &'a PluginSummary, String)>,
        include_marketplace_names: bool,
        empty_name: &str,
```

**Purpose**: Converts plugin summaries into selection rows with status text, search values, optional enable/disable toggles, and Enter actions for viewing details or installing.

**Data flow**: It takes a vector of `(marketplace, plugin, display_name)` tuples plus flags and empty-state strings, sorts entries with `sort_plugin_entries`, computes the widest status label, and for each plugin derives marketplace/status/description text, detail-request parameters, toggle eligibility, selected-description guidance, search text, toggle actions that send `SetPluginEnabled`, and detail actions that open the detail-loading popup and send `FetchPluginDetail`. If no items exist it returns a single disabled empty-state row.

**Call relations**: This row builder is used repeatedly by `ChatWidget::plugins_popup_params` for the all, installed, curated, and per-marketplace tabs.

*Call graph*: calls 6 internal fn (marketplace_display_name, plugin_brief_description, plugin_brief_description_without_marketplace, plugin_detail_request_for_entry, plugin_status_label, sort_plugin_entries); called by 1 (plugins_popup_params); 4 external calls (default, new, format!, vec!).


##### `plugins_popup_hint_line`  (lines 1980–1998)

```
fn plugins_popup_hint_line(
    can_remove_marketplace: bool,
    can_upgrade_marketplace: bool,
) -> Line<'static>
```

**Purpose**: Returns the footer hint line describing available keyboard shortcuts for the current plugins tab.

**Data flow**: It takes booleans for remove and upgrade availability and returns a `Line<'static>` with the appropriate shortcut text combination.

**Call relations**: This helper is used by `ChatWidget::plugins_popup_params` to set the default footer hint and per-tab footer hints.

*Call graph*: called by 1 (plugins_popup_params); 1 external calls (from).


##### `plugin_detail_hint_line`  (lines 2000–2002)

```
fn plugin_detail_hint_line() -> Line<'static>
```

**Purpose**: Returns the simple footer hint used by plugin detail and related error/auth popups.

**Data flow**: It returns a fixed `Line<'static>` containing `Press esc to close.`.

**Call relations**: This helper is reused by detail, error, and auth popup builders.

*Call graph*: called by 5 (marketplace_add_error_popup_params, marketplace_remove_error_popup_params, plugin_detail_error_popup_params, plugin_detail_popup_params, plugin_install_auth_popup_params); 1 external calls (from).


##### `plugins_header`  (lines 2004–2010)

```
fn plugins_header(subtitle: String, count_line: String) -> Box<dyn Renderable>
```

**Purpose**: Builds a standard three-line plugins header with title, subtitle, and count/status line.

**Data flow**: It takes owned subtitle and count strings, pushes them into a `ColumnRenderable` with styling, and returns the boxed renderable.

**Call relations**: This helper is used by `ChatWidget::plugins_popup_params` and `ChatWidget::marketplace_add_tab`.

*Call graph*: calls 1 internal fn (new); called by 2 (marketplace_add_tab, plugins_popup_params); 2 external calls (new, from).


##### `plugin_entries_for_marketplaces`  (lines 2012–2024)

```
fn plugin_entries_for_marketplaces(
    marketplaces: impl IntoIterator<Item = &'a PluginMarketplaceEntry>,
) -> Vec<(&'a PluginMarketplaceEntry, &'a PluginSummary, String)>
```

**Purpose**: Flattens one or more marketplaces into a vector of `(marketplace, plugin summary, display name)` tuples.

**Data flow**: It takes any iterator of `&PluginMarketplaceEntry`, iterates each marketplace’s `plugins`, maps each plugin to a tuple with `plugin_display_name(plugin)`, collects the tuples, and returns them.

**Call relations**: This helper feeds `ChatWidget::plugins_popup_params` before rows are sorted and rendered.

*Call graph*: called by 1 (plugins_popup_params); 1 external calls (into_iter).


##### `sort_plugin_entries`  (lines 2026–2041)

```
fn sort_plugin_entries(entries: &mut [(&PluginMarketplaceEntry, &PluginSummary, String)])
```

**Purpose**: Sorts plugin entries with installed plugins first, then by case-insensitive display name and stable tie-breakers.

**Data flow**: It mutably sorts the slice in place, comparing installed status descending, lowercase display name, original display name, plugin name, and plugin ID.

**Call relations**: This helper is called by `ChatWidget::plugin_selection_items` before row construction.

*Call graph*: called by 1 (plugin_selection_items); 1 external calls (sort_by).


##### `marketplace_tab_id`  (lines 2043–2048)

```
fn marketplace_tab_id(marketplace: &PluginMarketplaceEntry) -> String
```

**Purpose**: Computes the stable tab ID for a marketplace, preferring its filesystem path when present and falling back to its name.

**Data flow**: It reads `marketplace.path`; if present it delegates to `marketplace_tab_id_from_path`, otherwise it formats `marketplace:<name>`.

**Call relations**: This helper is used when building marketplace tabs and when matching active tabs to marketplaces.

*Call graph*: calls 1 internal fn (marketplace_tab_id_from_path); called by 1 (plugins_popup_params); 1 external calls (format!).


##### `marketplace_tab_id_from_path`  (lines 2050–2052)

```
fn marketplace_tab_id_from_path(path: &Path) -> String
```

**Purpose**: Formats a marketplace tab ID from a marketplace root path.

**Data flow**: It takes a `&Path` and returns `format!("{MARKETPLACE_TAB_ID_PREFIX}{}", path.display())`.

**Call relations**: This helper is used by `marketplace_tab_id` and by marketplace add/upgrade completion handlers when selecting a tab for a known root.

*Call graph*: called by 3 (on_marketplace_add_loaded, on_marketplace_upgrade_loaded, marketplace_tab_id); 1 external calls (format!).


##### `marketplace_tab_id_matching_saved_id`  (lines 2054–2077)

```
fn marketplace_tab_id_matching_saved_id(
    saved_tab_id: &str,
    marketplaces: &[PluginMarketplaceEntry],
) -> Option<String>
```

**Purpose**: Attempts to map a previously saved marketplace tab ID onto the current marketplace list, including prefix matching for moved or nested roots.

**Data flow**: It takes a saved tab ID and slice of marketplaces, first looks for an exact current tab-ID match, then if the saved ID has the marketplace-path prefix parses the root path and returns the first marketplace whose path starts with that root. It returns `Option<String>`.

**Call relations**: This helper is used by `ChatWidget::on_plugins_loaded` to preserve the user’s active marketplace tab across refreshed plugin lists.

*Call graph*: 2 external calls (new, iter).


##### `merge_remote_marketplaces`  (lines 2079–2093)

```
fn merge_remote_marketplaces(
    response: &mut PluginListResponse,
    remote_marketplaces: Vec<PluginMarketplaceEntry>,
)
```

**Purpose**: Replaces stale remote-section marketplaces in a plugin list response with freshly loaded remote marketplaces while preserving local/path-backed marketplaces.

**Data flow**: It takes a mutable `PluginListResponse` and a vector of remote marketplaces, collects the remote names into a `HashSet`, retains only path-backed marketplaces or non-remote-section entries not shadowed by the incoming names, then extends `response.marketplaces` with the new remote marketplaces.

**Call relations**: This helper is called by `ChatWidget::on_plugin_remote_sections_loaded` when remote marketplace sections arrive after the base plugin list.

*Call graph*: called by 1 (on_plugin_remote_sections_loaded).


##### `remote_marketplace_is_remote_section`  (lines 2095–2103)

```
fn remote_marketplace_is_remote_section(marketplace: &PluginMarketplaceEntry) -> bool
```

**Purpose**: Identifies marketplace names that correspond to the special remote workspace/shared-with-me sections.

**Data flow**: It matches `marketplace.name.as_str()` against the four remote-section constants and returns a boolean.

**Call relations**: This helper is used by `merge_remote_marketplaces` to know which existing marketplaces should be replaced by refreshed remote-section data.

*Call graph*: 1 external calls (matches!).


##### `disambiguate_duplicate_tab_labels`  (lines 2105–2140)

```
fn disambiguate_duplicate_tab_labels(labels: Vec<String>) -> Vec<String>
```

**Purpose**: Adds `(n/total)` suffixes to duplicate marketplace display labels so tab names remain unique and understandable.

**Data flow**: It takes a vector of labels, counts total occurrences of each label, tracks how many times each has been seen while iterating, and returns a new vector where unique labels are unchanged and duplicates become `label (current/total)`.

**Call relations**: This helper is used by `ChatWidget::plugins_popup_params` when multiple marketplaces share the same display name.

*Call graph*: called by 1 (plugins_popup_params); 1 external calls (new).


##### `marketplace_display_name`  (lines 2142–2151)

```
fn marketplace_display_name(marketplace: &PluginMarketplaceEntry) -> String
```

**Purpose**: Returns the human-friendly display name for a marketplace, falling back to its raw name when no non-empty interface display name exists.

**Data flow**: It reads `marketplace.interface.display_name`, trims and filters empty strings, converts a valid display name to `String`, and otherwise clones `marketplace.name`.

**Call relations**: This helper is used in popup construction and keyboard handling wherever marketplace names are shown to the user.

*Call graph*: called by 2 (handle_plugins_popup_key_event, plugin_selection_items).


##### `marketplace_is_user_configured`  (lines 2153–2161)

```
fn marketplace_is_user_configured(config: &Config, marketplace_name: &str) -> bool
```

**Purpose**: Checks whether a marketplace is explicitly present in the effective user config.

**Data flow**: It reads `config.config_layer_stack.effective_user_config()`, looks up the `marketplaces` table, and returns whether that table contains the given marketplace name.

**Call relations**: This helper is used by `ChatWidget::plugins_popup_params` and `ChatWidget::handle_plugins_popup_key_event` to decide whether a marketplace can be removed.

*Call graph*: called by 1 (plugins_popup_params).


##### `marketplace_is_user_configured_git`  (lines 2163–2174)

```
fn marketplace_is_user_configured_git(config: &Config, marketplace_name: &str) -> bool
```

**Purpose**: Checks whether a user-configured marketplace is backed by a Git source in the active user config layer.

**Data flow**: It walks the active user layer’s TOML structure down through `marketplaces.<name>.source_type`, reads it as a string, and returns `true` only when it equals `git`.

**Call relations**: This helper is used by `ChatWidget::plugins_popup_params` and `ChatWidget::handle_plugins_popup_key_event` to decide whether a marketplace can be upgraded.

*Call graph*: called by 2 (handle_plugins_popup_key_event, plugins_popup_params).


##### `plugin_display_name`  (lines 2176–2185)

```
fn plugin_display_name(plugin: &PluginSummary) -> String
```

**Purpose**: Returns the human-friendly display name for a plugin, falling back to its raw plugin name when no non-empty interface display name exists.

**Data flow**: It reads `plugin.interface.display_name`, trims and filters empty strings, converts a valid display name to `String`, and otherwise clones `plugin.name`.

**Call relations**: This helper is used when flattening plugin entries and when building plugin detail headers.

*Call graph*: called by 1 (plugin_detail_popup_params).


##### `plugin_brief_description`  (lines 2187–2198)

```
fn plugin_brief_description(
    plugin: &PluginSummary,
    marketplace_label: &str,
    status_label_width: usize,
) -> String
```

**Purpose**: Formats the one-line plugin row description including status, marketplace label, and optional plugin description.

**Data flow**: It takes a `PluginSummary`, marketplace label, and status-label width, computes a padded status label via `plugin_status_label`, reads an optional description via `plugin_description`, and returns either `status · marketplace · description` or `status · marketplace`.

**Call relations**: This helper is used by `ChatWidget::plugin_selection_items` when marketplace names should be shown in row descriptions.

*Call graph*: calls 2 internal fn (plugin_description, plugin_status_label); called by 1 (plugin_selection_items); 1 external calls (format!).


##### `plugin_brief_description_without_marketplace`  (lines 2200–2210)

```
fn plugin_brief_description_without_marketplace(
    plugin: &PluginSummary,
    status_label_width: usize,
) -> String
```

**Purpose**: Formats the one-line plugin row description including status and optional plugin description, omitting marketplace name.

**Data flow**: It takes a `PluginSummary` and status-label width, computes a padded status label via `plugin_status_label`, reads an optional description via `plugin_description`, and returns either `status · description` or just the padded status label.

**Call relations**: This helper is used by `ChatWidget::plugin_selection_items` for marketplace-specific tabs where the marketplace name would be redundant.

*Call graph*: calls 2 internal fn (plugin_description, plugin_status_label); called by 1 (plugin_selection_items); 1 external calls (format!).


##### `plugin_status_label`  (lines 2212–2229)

```
fn plugin_status_label(plugin: &PluginSummary) -> &'static str
```

**Purpose**: Computes the short status string shown for a plugin based on admin availability, installation state, enablement, and install policy.

**Data flow**: It reads fields from `PluginSummary` and returns one of `Disabled by admin`, `Installed`, `Disabled`, `Not installable`, or `Available`.

**Call relations**: This helper is used by row-description builders and by `ChatWidget::plugin_selection_items` when composing selected-row guidance.

*Call graph*: called by 3 (plugin_selection_items, plugin_brief_description, plugin_brief_description_without_marketplace).


##### `plugin_location_for_marketplace`  (lines 2231–2241)

```
fn plugin_location_for_marketplace(
    marketplace: &PluginMarketplaceEntry,
    plugin: &PluginSummary,
) -> Option<PluginLocation>
```

**Purpose**: Determines the install/detail request location for a plugin summary within a marketplace, distinguishing local-path and remote-marketplace plugins.

**Data flow**: It takes a marketplace and plugin summary, returns `Some(PluginLocation::Local { marketplace_path })` when the marketplace has a path, otherwise uses `plugin_remote_identity(plugin)` to decide whether to return `Some(PluginLocation::Remote { marketplace_name })`, or `None` if no remote identity exists.

**Call relations**: This helper is used by `plugin_detail_request_for_entry` to decide whether a plugin row can fetch details.

*Call graph*: calls 1 internal fn (plugin_remote_identity); called by 1 (plugin_detail_request_for_entry).


##### `plugin_detail_location`  (lines 2243–2250)

```
fn plugin_detail_location(plugin: &PluginDetail) -> Option<PluginLocation>
```

**Purpose**: Determines the install location for a fully loaded plugin detail, again distinguishing local and remote plugins.

**Data flow**: It takes a `PluginDetail`, returns a local `PluginLocation` when `marketplace_path` is present, otherwise uses `plugin_remote_identity(&plugin.summary)` to produce a remote location or `None`.

**Call relations**: This helper is used by `ChatWidget::plugin_detail_popup_params` when wiring install actions.

*Call graph*: calls 1 internal fn (plugin_remote_identity); called by 1 (plugin_detail_popup_params).


##### `plugin_detail_request_for_entry`  (lines 2252–2258)

```
fn plugin_detail_request_for_entry(
    marketplace: &PluginMarketplaceEntry,
    plugin: &PluginSummary,
) -> Option<(PluginLocation, String)>
```

**Purpose**: Builds the `(location, plugin_name)` pair needed to fetch plugin details for a plugin row, if enough identity information exists.

**Data flow**: It takes a marketplace and plugin summary, derives a `PluginLocation` via `plugin_location_for_marketplace`, derives the request name via `plugin_request_name(plugin)`, and returns them as `Some((location, name))` or `None`.

**Call relations**: This helper is used by `ChatWidget::plugin_selection_items` to decide whether Enter should fetch details for a row.

*Call graph*: calls 1 internal fn (plugin_location_for_marketplace); called by 1 (plugin_selection_items).


##### `plugin_request_name`  (lines 2260–2267)

```
fn plugin_request_name(plugin: &PluginSummary) -> String
```

**Purpose**: Chooses the plugin identifier that should be sent in detail/install requests, preferring remote plugin IDs for remote plugins.

**Data flow**: It takes a `PluginSummary`, and if `plugin.source` is `Remote` and `plugin_remote_identity(plugin)` exists, returns that remote ID; otherwise it returns `plugin.name.clone()`.

**Call relations**: This helper is used by `plugin_detail_request_for_entry` and `ChatWidget::plugin_detail_popup_params`.

*Call graph*: calls 1 internal fn (plugin_remote_identity); called by 1 (plugin_detail_popup_params); 1 external calls (matches!).


##### `plugin_remote_identity`  (lines 2269–2275)

```
fn plugin_remote_identity(plugin: &PluginSummary) -> Option<String>
```

**Purpose**: Extracts the canonical remote plugin ID from either shared-context metadata or the summary’s direct remote ID field.

**Data flow**: It reads `plugin.share_context.remote_plugin_id` first, falling back to `plugin.remote_plugin_id`, and returns `Option<String>`.

**Call relations**: This helper underpins remote plugin location, request-name, and uninstall-ID derivation.

*Call graph*: called by 4 (plugin_detail_location, plugin_location_for_marketplace, plugin_request_name, plugin_uninstall_id).


##### `plugin_uninstall_id`  (lines 2277–2282)

```
fn plugin_uninstall_id(plugin: &PluginSummary) -> Option<String>
```

**Purpose**: Determines the identifier that should be used to uninstall a plugin, using remote identity for remote plugins and local ID otherwise.

**Data flow**: It takes a `PluginSummary`, and if the source is remote returns `plugin_remote_identity(plugin)`, otherwise returns `Some(plugin.id.clone())`.

**Call relations**: This helper is used by `ChatWidget::plugin_detail_popup_params` when wiring uninstall actions.

*Call graph*: calls 1 internal fn (plugin_remote_identity); called by 1 (plugin_detail_popup_params); 1 external calls (matches!).


##### `plugin_description`  (lines 2284–2297)

```
fn plugin_description(plugin: &PluginSummary) -> Option<String>
```

**Purpose**: Extracts the best short description available from a plugin summary’s interface metadata.

**Data flow**: It reads `plugin.interface.short_description` first, then `long_description`, trims the chosen text, filters out empties, and returns `Option<String>`.

**Call relations**: This helper is used by the brief row-description builders.

*Call graph*: called by 2 (plugin_brief_description, plugin_brief_description_without_marketplace).


##### `plugin_detail_description`  (lines 2299–2320)

```
fn plugin_detail_description(plugin: &PluginDetail) -> Option<String>
```

**Purpose**: Extracts the best long-form description available for a plugin detail view, preferring explicit detail text over interface metadata.

**Data flow**: It reads `plugin.description`, then falls back to interface `long_description`, then `short_description`, trims and filters empty strings, and returns `Option<String>`.

**Call relations**: This helper is used by `ChatWidget::plugin_detail_popup_params` when building the detail header.

*Call graph*: called by 1 (plugin_detail_popup_params).


##### `plugin_skill_summary`  (lines 2322–2333)

```
fn plugin_skill_summary(plugin: &PluginDetail) -> String
```

**Purpose**: Summarizes a plugin’s skills as a comma-separated list or a fixed empty-state string.

**Data flow**: It reads `plugin.skills`; if empty it returns `No plugin skills.`, otherwise it joins each skill’s `name` with commas.

**Call relations**: This helper is used by `ChatWidget::plugin_detail_popup_params` for the read-only Skills row.

*Call graph*: called by 1 (plugin_detail_popup_params).


##### `plugin_app_summary`  (lines 2335–2346)

```
fn plugin_app_summary(plugin: &PluginDetail) -> String
```

**Purpose**: Summarizes a plugin’s bundled apps as a comma-separated list or a fixed empty-state string.

**Data flow**: It reads `plugin.apps`; if empty it returns `No plugin apps.`, otherwise it joins each app’s `name` with commas.

**Call relations**: This helper is used by `ChatWidget::plugin_detail_popup_params` for the read-only Apps row.

*Call graph*: called by 1 (plugin_detail_popup_params).


##### `plugin_hook_summary`  (lines 2348–2369)

```
fn plugin_hook_summary(plugin: &PluginDetail) -> String
```

**Purpose**: Summarizes a plugin’s hooks by counting handlers per hook event and formatting those counts.

**Data flow**: It reads `plugin.hooks`; if empty it returns `No plugin hooks.`. Otherwise it accumulates counts in a vector keyed by `HookEventName`, then formats entries like `EventName (count)` joined by commas.

**Call relations**: This helper is used by `ChatWidget::plugin_detail_popup_params` for the read-only Hooks row.

*Call graph*: called by 1 (plugin_detail_popup_params); 1 external calls (new).


##### `plugin_mcp_summary`  (lines 2371–2377)

```
fn plugin_mcp_summary(plugin: &PluginDetail) -> String
```

**Purpose**: Summarizes the MCP servers exposed by a plugin.

**Data flow**: It reads `plugin.mcp_servers`; if empty it returns `No plugin MCP servers.`, otherwise it joins the server names with commas.

**Call relations**: This helper is used by `ChatWidget::plugin_detail_popup_params` for the read-only MCP Servers row.

*Call graph*: called by 1 (plugin_detail_popup_params).
