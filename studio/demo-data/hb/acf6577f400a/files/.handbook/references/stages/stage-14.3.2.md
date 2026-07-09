# Plugin and connector ecosystem management  `stage-14.3.2`

This stage is the plugin “supply chain” for Codex. It is shared support used during startup, tool discovery, installation, and user interaction. The core plugin files define the public API, read plugin.json manifests safely, load installed plugins into skills, apps, hooks, MCP servers, and telemetry, and coordinate installs, removals, cache refreshes, and marketplace rules. Marketplace files add, validate, upgrade, and remove catalogs from local folders or Git, while remote bundle and remote service files download, sync, install, uninstall, share, and check out plugins from ChatGPT-backed services, including older APIs.

Connector files decide which app connectors and tools are visible, enabled, and safe enough to run, combining login state, user settings, managed policy, and tool safety hints. Discovery and mention files find plugins the user may want, or ones the user explicitly referenced in chat. Install-suggestion tool files let the assistant list possible plugins and ask for user approval before installing. Finally, the CLI and terminal UI provide the human control panels: commands and popups for adding marketplaces, browsing plugins, installing, disabling, upgrading, and removing them.

## Files in this stage

### Plugin subsystem foundations
These files define the core crate surface and the low-level manifest, provider, routing, marketplace, loader, and manager layers that everything else in plugin and connector management builds on.

### `core-plugins/src/lib.rs`

`other` · `cross-cutting`

This file works like the index and reception desk for the plugin system. The real work is split across many smaller modules: loading plugins, reading plugin manifests, talking to remote marketplaces, installing or removing plugins, upgrading marketplace data, and deciding which plugin tools can be discovered. Instead of forcing the rest of the codebase to know where every item lives, this file re-exports the important public pieces from those modules in one place.

It also defines three marketplace name constants. A marketplace is a source where plugins can be found. Two of these names are treated as OpenAI-curated sources, meaning the system may apply special trust, display, or routing behavior to them elsewhere. The helper function in this file answers that one specific question: “Is this marketplace one of the OpenAI-curated ones?”

The type aliases near the middle adapt generic plugin-loading results from the lower-level plugin crate to this project’s specific server configuration type. In plain terms, they make common plugin result types shorter and harder to misuse. Without this file, other parts of the project would need to import many internal module paths directly, and the shared marketplace-name rules would likely be repeated in multiple places.

#### Function details

##### `is_openai_curated_marketplace_name`  (lines 26–29)

```
fn is_openai_curated_marketplace_name(marketplace_name: &str) -> bool
```

**Purpose**: This function checks whether a given marketplace name is one of the OpenAI-curated marketplace names known to this crate. It gives the rest of the system one shared place to make that decision, instead of scattering string comparisons throughout the code.

**Data flow**: It takes a marketplace name as text. It compares that text against the two constants that count as OpenAI-curated marketplace names. It returns true if the input matches either one, and false otherwise; it does not change any stored data.

**Call relations**: Other plugin or marketplace code can call this when it needs to branch based on whether a marketplace is OpenAI-curated. The function does its check directly using the constants in this file and does not hand work off to other functions.


### `core-plugins/src/provider.rs`

`domain_logic` · `plugin resolution`

A plugin is a package of extra capabilities, and its manifest is the small description file that says what the plugin is and how it should be used. This file is the bridge between the plugin system and an execution environment, which may have its own filesystem view. Without it, the system might look for plugin files in the wrong place, or accidentally fall back to the host machine when the plugin actually belongs to a sandboxed or remote environment.

The main type, ExecutorPluginProvider, is given an EnvironmentManager, which is like a directory of currently available execution environments. When asked to resolve a selected capability root, it first makes sure the root path is an explicit absolute path. Then it finds the referenced environment, asks that environment for its filesystem, and inspects the plugin root through that filesystem only.

It then checks that the root is a directory, searches a known list of possible manifest locations, reads the first manifest file it finds, parses it, and builds a source-neutral ResolvedPlugin descriptor. If no manifest exists, it returns “no plugin” rather than an error. But if the path is invalid, the environment is missing, the root is not a directory, the manifest cannot be read, or the manifest is malformed, it returns a specific error explaining what went wrong.

ResolvedExecutorPlugin keeps both the plugin descriptor and the exact filesystem used to read it, so later code can load files from the same environment consistently.

#### Function details

##### `ResolvedExecutorPlugin::plugin`  (lines 89–91)

```
fn plugin(&self) -> &ResolvedPlugin
```

**Purpose**: This returns the resolved plugin description without exposing where it came from. Code uses it when it only needs to know what the plugin is, not how to read more files from it.

**Data flow**: It receives a ResolvedExecutorPlugin object → looks inside it at the stored ResolvedPlugin → returns a borrowed view of that plugin description. It does not change anything.

**Call relations**: After a plugin has been resolved and bound to an executor filesystem, the loading flow calls this to get the plugin descriptor. It is the read-only doorway from the bound wrapper back to the ordinary plugin information.

*Call graph*: called by 1 (load).


##### `ResolvedExecutorPlugin::file_system`  (lines 94–96)

```
fn file_system(&self) -> &dyn ExecutorFileSystem
```

**Purpose**: This returns the exact environment filesystem that was used to resolve the plugin. Code uses it so any later file reads happen in the same environment, not accidentally on the host machine or another filesystem.

**Data flow**: It receives a ResolvedExecutorPlugin object → looks inside it at the stored shared filesystem reference → returns it as an ExecutorFileSystem interface. It does not create, copy, or modify the filesystem.

**Call relations**: The loading flow calls this alongside ResolvedExecutorPlugin::plugin. Together they give the loader both halves it needs: the plugin description and the filesystem that should be trusted for reading the plugin package.

*Call graph*: called by 1 (load).


##### `ExecutorPluginProvider::new`  (lines 101–105)

```
fn new(environment_manager: Arc<EnvironmentManager>) -> Self
```

**Purpose**: This creates a plugin provider backed by the current set of execution environments. It is used during setup so later plugin resolution can ask the right environment for files.

**Data flow**: It receives a shared EnvironmentManager → stores it inside a new ExecutorPluginProvider → returns that provider. Nothing is inspected yet; this only wires the provider to the environment registry.

**Call relations**: Tests and setup code call this before resolving plugins. Later, ExecutorPluginProvider::resolve_bound and ExecutorPluginProvider::resolve use the stored EnvironmentManager to find the environment named by a selected capability root.

*Call graph*: called by 6 (host_and_executor_sources_parse_the_same_manifest, executor_root_must_be_an_explicit_absolute_path, malformed_preferred_manifest_does_not_fall_through_to_alternate, standalone_capability_root_is_not_a_plugin, unavailable_environment_does_not_fall_back_to_host_filesystem, new).


##### `ExecutorPluginProvider::resolve_bound`  (lines 108–129)

```
async fn resolve_bound(
        &self,
        selected_root: &SelectedCapabilityRoot,
    ) -> Result<Option<ResolvedExecutorPlugin>, ExecutorPluginProviderError>
```

**Purpose**: This is the full resolver for environment-owned plugins. It returns not only the plugin description, but also the exact filesystem that was used to find it, so later loading stays tied to the same environment.

**Data flow**: It receives a selected capability root → checks and converts its path with selected_plugin_root → reads the environment id from the root → asks the EnvironmentManager for that environment → gets the environment filesystem → passes the root and filesystem to resolve_plugin_root → returns either no plugin, a ResolvedExecutorPlugin containing the descriptor and filesystem, or a clear error.

**Call relations**: This is the central path used when caller code needs a plugin plus its filesystem. ExecutorPluginProvider::resolve calls it and then discards the filesystem, while resolve_snapshot uses it when it needs the bound filesystem for later package access.

*Call graph*: calls 2 internal fn (resolve_plugin_root, selected_plugin_root); called by 2 (resolve, resolve_snapshot).


##### `ExecutorPluginProvider::resolve`  (lines 135–142)

```
async fn resolve(
        &self,
        selected_root: &SelectedCapabilityRoot,
    ) -> Result<Option<ResolvedPlugin>, Self::Error>
```

**Purpose**: This implements the general PluginProvider interface, which asks only for a plugin description. It adapts the richer environment-specific resolver into the simpler plugin-provider shape.

**Data flow**: It receives a selected capability root → calls ExecutorPluginProvider::resolve_bound → if a bound plugin is found, it takes out just the ResolvedPlugin → returns that plugin, no plugin, or the same error from the deeper resolver.

**Call relations**: This is the standard entry point for code that treats all plugin providers the same way. It delegates the real work to resolve_bound, because this provider still needs the environment-aware checks and filesystem lookup even when the caller only wants the final descriptor.

*Call graph*: calls 1 internal fn (resolve_bound).


##### `selected_plugin_root`  (lines 145–165)

```
fn selected_plugin_root(
    selected_root: &SelectedCapabilityRoot,
) -> Result<AbsolutePathBuf, ExecutorPluginProviderError>
```

**Purpose**: This validates the selected root path and turns it into the project’s safe absolute-path type. It prevents relative or malformed paths from being treated as plugin roots.

**Data flow**: It receives a SelectedCapabilityRoot → reads its id and environment path → converts the path text into a PathBuf → rejects it if it is not absolute → asks AbsolutePathBuf::from_absolute_path_checked to confirm it is a valid absolute path → returns the checked path or an InvalidRootPath error with the root id and reason.

**Call relations**: ExecutorPluginProvider::resolve_bound calls this before touching any environment filesystem. This keeps the rest of the resolver working with a trusted absolute path instead of raw user-provided path text.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); called by 1 (resolve_bound); 1 external calls (from).


##### `resolve_plugin_root`  (lines 167–246)

```
async fn resolve_plugin_root(
    selected_root: &SelectedCapabilityRoot,
    plugin_root: AbsolutePathBuf,
    file_system: &dyn ExecutorFileSystem,
) -> Result<Option<ResolvedPlugin>, ExecutorPlugin
```

**Purpose**: This inspects one candidate plugin directory inside an environment and, if it contains a valid manifest, turns it into a ResolvedPlugin. It is where the actual discovery and manifest reading happens.

**Data flow**: It receives the selected root, a checked absolute plugin root path, and an environment filesystem → converts paths to path URIs, which are filesystem-friendly path identifiers → checks that the root exists and is a directory → tries each known manifest location → ignores missing manifest candidates → reads the first manifest file it finds → parses the manifest text → builds a ResolvedPlugin tied to the environment id and root id → returns that plugin, no plugin if no manifest exists, or a detailed error if inspection, reading, parsing, or descriptor construction fails.

**Call relations**: ExecutorPluginProvider::resolve_bound calls this after it has already found the right environment and filesystem. This function hands off manifest parsing to parse_plugin_manifest and descriptor creation to ResolvedPlugin::from_environment, while all file inspection and file reading go through the provided ExecutorFileSystem.

*Call graph*: calls 5 internal fn (parse_plugin_manifest, read_file_text, from_environment, join, from_abs_path); called by 1 (resolve_bound); 1 external calls (get_metadata).


### `core-plugins/src/manifest.rs`

`config` · `plugin discovery and config load`

A plugin manifest is like a label on a package: it tells Codex the plugin's name, version, keywords, where to find its skills, apps, MCP servers, hooks, and what user-facing information to show. This file is responsible for finding that label on disk, reading it, and translating loose JSON into stricter Rust data that the rest of the program can trust.

The file first deserializes JSON into “raw” shapes. These raw shapes allow fields to be missing or to have several older or newer formats. Then `parse_plugin_manifest` cleans the data up. Empty versions are dropped. A missing name falls back to the plugin folder name. Interface fields such as icons, logos, screenshots, and default prompts are normalized.

The most important safety work is path checking. Manifest paths must start with `./`, must not be just `./`, and must not contain `..` or other components that could escape the plugin folder. The result is an absolute path inside the plugin root. This is like letting a guest use rooms in their own apartment, but not letting them write “go upstairs and open the neighbor’s door.”

Invalid optional fields are not fatal. The code logs a warning and ignores them. That keeps plugin loading robust while still protecting the host.

#### Function details

##### `load_plugin_manifest`  (lines 111–124)

```
fn load_plugin_manifest(plugin_root: &Path) -> Option<PluginManifest>
```

**Purpose**: Finds and loads a plugin manifest from the local filesystem. It is the public entry point for callers that have a plugin folder and want the parsed plugin description, or `None` if it cannot be found or safely read.

**Data flow**: It receives a plugin root folder path. It asks the plugin utility code to find the manifest file, reads that file as text, and passes the text to `parse_plugin_manifest`. If parsing succeeds, it returns the cleaned manifest; if finding, reading, or parsing fails, it returns nothing and logs a warning for parse errors.

**Call relations**: Many plugin-loading paths call this when they need information about a plugin, including loading MCP servers, apps, telemetry metadata, marketplace details, and tests. It delegates the real interpretation work to `parse_plugin_manifest` after it has found and read the file.

*Call graph*: calls 1 internal fn (parse_plugin_manifest); called by 12 (load_declared_plugin_mcp_servers, load_plugin, load_plugin_apps, plugin_telemetry_metadata_from_root, load_sources, read_plugin_detail_for_marketplace_plugin, host_and_executor_sources_parse_the_same_manifest, load_manifest, resolve_marketplace_plugin_entry, extract_remote_plugin_bundle_to_path (+2 more)); 3 external calls (find_plugin_manifest_path, read_to_string, warn!).


##### `parse_plugin_manifest`  (lines 126–230)

```
fn parse_plugin_manifest(
    plugin_root: &Path,
    manifest_path: &Path,
    contents: &str,
) -> Result<PluginManifest, serde_json::Error>
```

**Purpose**: Turns the raw JSON contents of a manifest into the official `PluginManifest` used by the rest of the system. It fills in small conveniences, cleans optional text, and resolves plugin-relative paths into safe absolute paths.

**Data flow**: It receives the plugin root, the manifest file path, and the manifest text. It deserializes the JSON, chooses a name, trims the version, builds the optional interface section, validates default prompts, resolves asset and feature paths, and returns a structured manifest or a JSON parsing error.

**Call relations**: It is called by `load_plugin_manifest` after file reading, and by plugin-root resolution code that already has manifest contents. It calls the path and hook helper functions so every path-like field is checked in the same way before being handed to other plugin subsystems.

*Call graph*: calls 3 internal fn (resolve_manifest_hooks, resolve_manifest_path, resolve_manifest_path_value); called by 3 (load_plugin_manifest, resolve_plugin_root, plugin_root_resolution_uses_supplied_executor_file_system); 1 external calls (file_name).


##### `resolve_manifest_hooks`  (lines 232–260)

```
fn resolve_manifest_hooks(
    plugin_root: &Path,
    hooks: Option<RawPluginManifestHooks>,
) -> Option<PluginManifestHooks>
```

**Purpose**: Interprets the manifest's `hooks` field, which can be written in several supported forms. Hooks are plugin-provided actions or rules, and this function accepts either paths to hook files or inline hook definitions.

**Data flow**: It receives the plugin root and the raw hooks value. If the value is a string or list of strings, it validates each path and returns hook paths. If it is an object or list of objects, it returns inline hook definitions. If the value has the wrong shape or all paths are invalid, it logs a warning or returns nothing.

**Call relations**: It is used only by `parse_plugin_manifest` while building the manifest's paths section. For path-based hooks it hands each path to `resolve_manifest_path`, so hooks follow the same “stay inside the plugin folder” rule as other manifest paths.

*Call graph*: calls 1 internal fn (resolve_manifest_path); called by 1 (parse_plugin_manifest); 4 external calls (Inline, Paths, warn!, vec!).


##### `resolve_interface_asset_path`  (lines 262–268)

```
fn resolve_interface_asset_path(
    plugin_root: &Path,
    field: &'static str,
    path: Option<&str>,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Resolves a user-interface asset path, such as an icon, logo, or screenshot, into a safe absolute path. It exists as a small named wrapper so interface asset fields are treated consistently.

**Data flow**: It receives the plugin root, the name of the manifest field being checked, and an optional path string. It passes those directly to `resolve_manifest_path` and returns the validated absolute path, or nothing if the input is absent or invalid.

**Call relations**: It is used while `parse_plugin_manifest` builds the optional interface section. It relies on `resolve_manifest_path` for the actual validation and conversion.

*Call graph*: calls 1 internal fn (resolve_manifest_path).


##### `resolve_default_prompts`  (lines 270–325)

```
fn resolve_default_prompts(
    manifest_path: &Path,
    value: Option<&RawPluginManifestDefaultPrompt>,
) -> Option<Vec<String>>
```

**Purpose**: Cleans and validates the plugin's suggested starter prompts shown to users. It supports both the old single-string format and the newer list format.

**Data flow**: It receives the manifest file path and the raw default prompt value. A single string becomes a one-item list after cleanup. A list is checked item by item, with invalid entries skipped, and no more than three prompts accepted. If the whole value has the wrong shape or no valid prompts remain, it returns nothing.

**Call relations**: It is called from `parse_plugin_manifest` while building the interface data. It calls `resolve_default_prompt_str` for each candidate prompt and uses `warn_invalid_default_prompt` whenever a prompt is missing, too long, empty, or the wrong type.

*Call graph*: calls 2 internal fn (resolve_default_prompt_str, warn_invalid_default_prompt); 2 external calls (new, format!).


##### `resolve_default_prompt_str`  (lines 327–342)

```
fn resolve_default_prompt_str(manifest_path: &Path, field: &str, prompt: &str) -> Option<String>
```

**Purpose**: Normalizes one default prompt and checks that it is usable. This keeps suggested prompts short and clean before they appear in the interface.

**Data flow**: It receives the manifest path, the field name for error messages, and the prompt text. It collapses repeated whitespace into single spaces, rejects an empty result, rejects text longer than the allowed limit, and returns the cleaned prompt if valid.

**Call relations**: It is called by `resolve_default_prompts` for both single prompts and list entries. When a prompt is invalid, it calls `warn_invalid_default_prompt` so the problem is visible without stopping the whole manifest from loading.

*Call graph*: calls 1 internal fn (warn_invalid_default_prompt); called by 1 (resolve_default_prompts); 1 external calls (format!).


##### `warn_invalid_default_prompt`  (lines 344–349)

```
fn warn_invalid_default_prompt(manifest_path: &Path, field: &str, message: &str)
```

**Purpose**: Writes a warning explaining why a default prompt was ignored. This gives plugin authors a useful clue without making the entire plugin fail to load.

**Data flow**: It receives the manifest path, the field name, and a short reason. It sends a warning to the tracing log and does not return any data.

**Call relations**: It is used by `resolve_default_prompts` and `resolve_default_prompt_str` whenever default prompt data is malformed, empty, too long, or beyond the supported count.

*Call graph*: called by 2 (resolve_default_prompt_str, resolve_default_prompts); 1 external calls (warn!).


##### `json_value_type`  (lines 351–360)

```
fn json_value_type(value: &JsonValue) -> &'static str
```

**Purpose**: Describes a JSON value's broad type in plain words, such as `string`, `array`, or `object`. It is used to make warning messages clearer.

**Data flow**: It receives a JSON value. It checks which JSON category the value belongs to and returns a static text label for that category.

**Call relations**: It supports the warning paths in manifest parsing, especially when fields such as hooks, paths, or default prompts have the wrong kind of JSON value.


##### `resolve_manifest_path_value`  (lines 362–377)

```
fn resolve_manifest_path_value(
    plugin_root: &Path,
    field: &'static str,
    path: Option<&RawPluginManifestPath>,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Validates a manifest field that should be a single path string, while gracefully ignoring values of the wrong JSON type. This is used for fields like `skills` that have a stricter expected shape.

**Data flow**: It receives the plugin root, the manifest field name, and the raw path value. If the value is a string, it passes it to `resolve_manifest_path`. If the value is not a string, it logs what type was found and returns nothing.

**Call relations**: It is called by `parse_plugin_manifest` for path fields represented by the raw path enum. It depends on `resolve_manifest_path` for the actual safety checks.

*Call graph*: calls 1 internal fn (resolve_manifest_path); called by 1 (parse_plugin_manifest); 1 external calls (warn!).


##### `resolve_manifest_path`  (lines 379–420)

```
fn resolve_manifest_path(
    plugin_root: &Path,
    field: &'static str,
    path: Option<&str>,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Converts a plugin-relative manifest path into a safe absolute path inside the plugin folder. This is the main guardrail that prevents manifest paths from escaping the plugin root.

**Data flow**: It receives the plugin root, a field name for warnings, and an optional path string. Empty paths are ignored. Valid paths must start with `./`, must name something after that prefix, and must not contain `..` or special components that leave the plugin folder. A valid relative path is joined to the plugin root and returned as an absolute path.

**Call relations**: It is the shared path checker used by `parse_plugin_manifest`, `resolve_interface_asset_path`, `resolve_manifest_hooks`, and `resolve_manifest_path_value`. Because all these callers go through the same helper, skills, MCP server files, app files, hooks, icons, logos, and screenshots all follow the same safety rule.

*Call graph*: calls 1 internal fn (try_from); called by 4 (parse_plugin_manifest, resolve_interface_asset_path, resolve_manifest_hooks, resolve_manifest_path_value); 4 external calls (join, new, new, warn!).


##### `tests::write_manifest`  (lines 444–460)

```
fn write_manifest(plugin_root: &Path, version: Option<&str>, interface: &str)
```

**Purpose**: Creates a test plugin manifest at the normal `.codex-plugin/plugin.json` location. It lets tests quickly set up different manifest contents without repeating file-writing code.

**Data flow**: It receives a plugin root, an optional version string, and an interface JSON snippet. It creates the manifest directory, builds a JSON file containing a fixed plugin name plus the requested fields, and writes it to disk.

**Call relations**: The manifest parsing tests call this before loading a plugin. It feeds controlled input into `tests::load_manifest` or `load_plugin_manifest` so each test can check one behavior.

*Call graph*: 4 external calls (join, format!, create_dir_all, write).


##### `tests::write_alternate_plugin_manifest`  (lines 462–467)

```
fn write_alternate_plugin_manifest(plugin_root: &Path, contents: &str)
```

**Purpose**: Creates a test manifest at an alternate discoverable path. This verifies that plugin discovery can find more than the primary `.codex-plugin/plugin.json` location.

**Data flow**: It receives a plugin root and raw manifest text. It creates the parent directory for the alternate manifest path and writes the provided contents there.

**Call relations**: It is used by the alternate-path test, which then calls `tests::load_manifest` to prove that `load_plugin_manifest` can discover and parse that location.

*Call graph*: 3 external calls (join, create_dir_all, write).


##### `tests::load_manifest`  (lines 469–471)

```
fn load_manifest(plugin_root: &Path) -> PluginManifest
```

**Purpose**: Loads a manifest during tests and fails the test if loading returns nothing. It keeps test code short when a manifest is expected to be valid.

**Data flow**: It receives a plugin root path. It calls `load_plugin_manifest`, unwraps the successful result, and returns the parsed manifest to the test.

**Call relations**: Most tests in this module use it after writing a temporary manifest. It is a thin testing wrapper around the real public loading function.

*Call graph*: calls 1 internal fn (load_plugin_manifest).


##### `tests::plugin_interface_accepts_legacy_default_prompt_string`  (lines 474–493)

```
fn plugin_interface_accepts_legacy_default_prompt_string()
```

**Purpose**: Checks that a plugin can still use the older single-string `defaultPrompt` format. This protects backward compatibility for existing plugin manifests.

**Data flow**: The test creates a temporary plugin with a default prompt containing extra spaces. It loads the manifest and checks that the interface contains one cleaned prompt with the extra spacing removed.

**Call relations**: It uses `tests::write_manifest` to create input and `tests::load_manifest` to run the real loader. It indirectly exercises `resolve_default_prompts` and `resolve_default_prompt_str`.

*Call graph*: 4 external calls (assert_eq!, load_manifest, write_manifest, tempdir).


##### `tests::plugin_interface_normalizes_default_prompt_array`  (lines 496–530)

```
fn plugin_interface_normalizes_default_prompt_array()
```

**Purpose**: Checks that a list of default prompts is cleaned, filtered, and capped correctly. This proves that bad entries do not poison the whole list.

**Data flow**: The test writes a manifest with a prompt array containing valid strings, a number, an overlong string, an empty string, and more entries than allowed. It loads the manifest and checks that only the first three valid cleaned prompts remain.

**Call relations**: It uses the test manifest writer and loader, then verifies the behavior implemented by `resolve_default_prompts`, including item validation and the maximum prompt count.

*Call graph*: 5 external calls (assert_eq!, load_manifest, write_manifest, format!, tempdir).


##### `tests::plugin_interface_ignores_invalid_default_prompt_shape`  (lines 533–549)

```
fn plugin_interface_ignores_invalid_default_prompt_shape()
```

**Purpose**: Checks that an object-shaped `defaultPrompt` is ignored because only a string or an array of strings is supported. This keeps malformed manifest data from becoming confusing user-facing text.

**Data flow**: The test writes a manifest where `defaultPrompt` is an object. After loading, it checks that the interface has no default prompts.

**Call relations**: It sets up input with `tests::write_manifest` and loads through `tests::load_manifest`. It specifically exercises the invalid-value branch of `resolve_default_prompts`.

*Call graph*: 4 external calls (assert_eq!, load_manifest, write_manifest, tempdir).


##### `tests::plugin_manifest_reads_trimmed_version`  (lines 552–566)

```
fn plugin_manifest_reads_trimmed_version()
```

**Purpose**: Checks that version strings are trimmed before being stored. This prevents accidental spaces in JSON from becoming part of the plugin version.

**Data flow**: The test writes a manifest with a version surrounded by spaces. It loads the manifest and checks that the stored version contains only the meaningful version text.

**Call relations**: It uses the normal test manifest setup and loading helper. It verifies the version cleanup done inside `parse_plugin_manifest`.

*Call graph*: 4 external calls (assert_eq!, load_manifest, write_manifest, tempdir).


##### `tests::plugin_manifest_reads_keywords`  (lines 569–588)

```
fn plugin_manifest_reads_keywords()
```

**Purpose**: Checks that the manifest's keyword list is preserved. Keywords help describe or categorize plugins, so this test ensures they survive parsing.

**Data flow**: The test writes a manifest containing two keywords. It loads the manifest and compares the parsed keyword list to the expected strings.

**Call relations**: It writes the file directly rather than using the shared helper because the test focuses on keywords instead of the interface section. It still uses `tests::load_manifest`, which exercises the real loader.

*Call graph*: 5 external calls (assert_eq!, load_manifest, create_dir_all, write, tempdir).


##### `tests::plugin_manifest_uses_alternate_discoverable_path`  (lines 591–615)

```
fn plugin_manifest_uses_alternate_discoverable_path()
```

**Purpose**: Checks that a manifest can be loaded from an alternate supported location. This matters for compatibility with plugin layouts that do not use the main Codex manifest folder.

**Data flow**: The test creates a temporary plugin with a manifest at the alternate path, including a spaced version and display name. It loads the manifest and checks that the version is trimmed and the interface display name is read.

**Call relations**: It uses `tests::write_alternate_plugin_manifest` to create the alternate file and `tests::load_manifest` to run normal discovery through `load_plugin_manifest`.

*Call graph*: 4 external calls (assert_eq!, load_manifest, write_alternate_plugin_manifest, tempdir).


##### `tests::host_and_executor_sources_parse_the_same_manifest`  (lines 618–657)

```
async fn host_and_executor_sources_parse_the_same_manifest()
```

**Purpose**: Checks that the host-side loader and executor-side plugin provider agree on the same plugin manifest. This prevents two parts of the system from interpreting the same plugin differently.

**Data flow**: The test writes a plugin manifest, loads it directly through `load_plugin_manifest`, then asks an executor plugin provider to resolve the same plugin root. It builds the expected resolved plugin descriptor and checks that the executor result matches it.

**Call relations**: It calls the real loader and also goes through `ExecutorPluginProvider`. This ties the manifest parser to the wider plugin-resolution flow and guards against host/executor drift.

*Call graph*: calls 5 internal fn (load_plugin_manifest, new, default_for_tests, from_environment, from_absolute_path_checked); 4 external calls (new, assert_eq!, write_manifest, tempdir).


### `core-plugins/src/app_mcp_routing.rs`

`domain_logic` · `plugin loading and routing setup`

This file is a small policy gate for plugin routing. Some plugins can be presented as “apps,” but that only works when the current authentication mode can use the Codex backend. In plain terms: if the user is not connected in the right way, the app route is closed, so the app list is emptied before it can be shown or used.

The file also deals with overlap between app declarations and MCP servers. MCP means Model Context Protocol, a way for tools or plugins to be exposed to the system. A plugin may appear both as an app and as an MCP server. When the plugin feature is active and app declarations exist, this code removes MCP server entries with the same names as those apps. That keeps one clear route for each plugin instead of two competing doors to the same place.

An everyday analogy: if a venue has both a front entrance and a side entrance for the same ticket line, this file decides which entrance is open, then closes the duplicate door so people do not queue twice for the same event.

#### Function details

##### `apps_route_available`  (lines 6–8)

```
fn apps_route_available(auth_mode: Option<AuthMode>) -> bool
```

**Purpose**: This function answers a simple yes-or-no question: can app-based routing be used with the current authentication mode? It returns true only when there is an authentication mode and that mode uses the Codex backend.

**Data flow**: It receives an optional authentication mode. If there is no mode, the answer is false. If there is a mode, it asks that mode whether it uses the Codex backend, and returns that answer.

**Call relations**: This is the small gatekeeper used by the broader routing policy in apply_app_mcp_routing_policy. It is also called during plugin MCP server loading so other setup code can make the same decision consistently.

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

**Purpose**: This function applies the project’s rules for when plugin apps and MCP server entries should be kept or removed. It protects users from unusable app entries and avoids duplicate routes for the same plugin.

**Data flow**: It receives a mutable list of app declarations, a mutable map of MCP servers keyed by name, the current authentication mode, and a flag saying whether the plugin feature is active. First it checks whether app routing is available. If not, it clears the app list. If app routing is available, the plugin feature is active, and there are app declarations, it collects the app names and removes any MCP server with a matching name. The result is that the two collections are changed in place to match the routing policy.

**Call relations**: Several plugin-loading paths call this function after they have gathered app declarations and MCP server entries. It first delegates the basic availability check to apps_route_available, then edits the app and server lists so later code sees only the routes that should actually be exposed.

*Call graph*: calls 1 internal fn (apps_route_available); called by 4 (load_plugin_mcp_servers, read_plugin_detail_for_marketplace_plugin, resolve_loaded_plugins_for_auth, build_remote_plugin_detail).


### `core-plugins/src/marketplace.rs`

`domain_logic` · `plugin discovery, marketplace loading, and plugin install lookup`

This file is the bridge between a marketplace JSON file on disk and the rest of the plugin system. Without it, Codex would not know where to look for marketplace catalogs, how to read them safely, or how to turn each catalog entry into a usable plugin record.

A marketplace can live in a few supported folder layouts, such as `.agents/plugins/marketplace.json`. The code searches the user’s home folder, extra configured roots, and sometimes the root of a Git repository. It reads the JSON, reports clear errors for missing or malformed files, and keeps going when a single marketplace cannot be loaded.

For each plugin entry, the file works out whether the source is local or Git-based. Local paths are carefully restricted so they cannot escape the marketplace root, much like refusing to let a shortcut point outside a trusted folder. Git URLs are normalized, including GitHub shorthand like `owner/repo`, and optional selectors such as branch names or commits are cleaned up.

It also combines information from two places: the marketplace entry and, for local plugins, the plugin’s own manifest. Marketplace categories can override manifest categories. Finally, it applies policy rules, such as whether a plugin is installable and whether it is allowed for a particular product.

#### Function details

##### `PluginInstallPolicy::from`  (lines 112–118)

```
fn from(value: MarketplacePluginInstallPolicy) -> Self
```

**Purpose**: Converts this file’s marketplace install policy into the install policy type used by the app-server protocol. This lets the marketplace layer speak cleanly to the API layer without exposing its own internal enum everywhere.

**Data flow**: It receives one marketplace install policy value, matches it to the equivalent protocol value, and returns that new value. Nothing else is changed.

**Call relations**: This is a small adapter used when marketplace information needs to be sent through the app-server protocol. It sits at the boundary between internal marketplace data and externally shared protocol data.


##### `PluginAuthPolicy::from`  (lines 122–127)

```
fn from(value: MarketplacePluginAuthPolicy) -> Self
```

**Purpose**: Converts this file’s marketplace authentication policy into the authentication policy type used by the app-server protocol. It keeps the internal marketplace model separate from the wire-facing API model.

**Data flow**: It receives one marketplace authentication policy value, chooses the matching protocol value, and returns it. It has no side effects.

**Call relations**: This function is used as a boundary translator when plugin marketplace policy is exposed through the app-server protocol.


##### `MarketplaceError::io`  (lines 167–169)

```
fn io(context: &'static str, source: io::Error) -> Self
```

**Purpose**: Builds a marketplace error from a lower-level input/output error, such as a failed file read. It adds a short human context string so the final error message explains what Codex was trying to do.

**Data flow**: It takes a fixed context message and an operating-system file error, wraps them into a `MarketplaceError::Io`, and returns that error value.

**Call relations**: Other functions use this helper when disk operations fail and they want marketplace-specific error messages instead of raw file-system errors.


##### `find_marketplace_plugin`  (lines 172–195)

```
fn find_marketplace_plugin(
    marketplace_path: &AbsolutePathBuf,
    plugin_name: &str,
) -> Result<ResolvedMarketplacePlugin, MarketplaceError>
```

**Purpose**: Looks inside one marketplace file for a plugin with a specific name and returns a fully interpreted plugin record. It is used when another part of Codex knows the marketplace and plugin name and needs the real source, policy, and metadata.

**Data flow**: It receives a marketplace file path and a plugin name. It reads the raw marketplace JSON, scans the plugin list, resolves the matching entry into a safer internal form, and returns that resolved plugin. If no matching usable entry is found, it returns a clear `PluginNotFound` error.

**Call relations**: This function starts by calling `load_raw_marketplace_manifest` to read the catalog, then hands a candidate entry to `resolve_marketplace_plugin_entry` to interpret it. It is called by configuration-reading code and by `find_installable_marketplace_plugin`, which adds install eligibility checks afterward.

*Call graph*: calls 2 internal fn (load_raw_marketplace_manifest, resolve_marketplace_plugin_entry); called by 2 (read_plugin_for_config, find_installable_marketplace_plugin).


##### `find_installable_marketplace_plugin`  (lines 197–220)

```
fn find_installable_marketplace_plugin(
    marketplace_path: &AbsolutePathBuf,
    plugin_name: &str,
    restriction_product: Option<Product>,
) -> Result<ResolvedMarketplacePlugin, MarketplaceError
```

**Purpose**: Finds a plugin in a marketplace and checks whether it is allowed to be installed. This protects installation flows from installing plugins that the marketplace marks as unavailable or not allowed for the current product.

**Data flow**: It receives a marketplace path, a plugin name, and an optional product restriction. It first gets the resolved plugin, then checks the plugin’s install policy and product allow-list. It returns the plugin if installation is allowed, or a `PluginNotAvailable` error if not.

**Call relations**: This builds directly on `find_marketplace_plugin`. Plugin installation paths call it before installing, so policy checks happen before any install work begins.

*Call graph*: calls 1 internal fn (find_marketplace_plugin); called by 2 (install_plugin, install_plugin_with_remote_sync).


##### `list_marketplaces`  (lines 222–226)

```
fn list_marketplaces(
    additional_roots: &[AbsolutePathBuf],
) -> Result<MarketplaceListOutcome, MarketplaceError>
```

**Purpose**: Finds and loads all marketplaces Codex should know about, using the normal home directory lookup. This is the public, convenient entry point for marketplace discovery.

**Data flow**: It receives extra root folders to search. It finds the user’s home directory with `home_dir`, then passes both the extra roots and home directory into `list_marketplaces_with_home`. It returns a list outcome containing loaded marketplaces and recoverable load errors.

**Call relations**: Higher-level cache refresh and configuration discovery code calls this when it needs the current marketplace list. It delegates the real work to `list_marketplaces_with_home` so tests and special cases can supply a chosen home directory.

*Call graph*: calls 2 internal fn (home_dir, list_marketplaces_with_home); called by 3 (refresh_non_curated_plugin_cache_with_mode, discover_marketplaces_for_config, list_marketplaces_for_config).


##### `home_dir`  (lines 228–236)

```
fn home_dir() -> Option<PathBuf>
```

**Purpose**: Finds the user’s home folder in a careful, cross-platform way. Marketplace discovery uses this because a default marketplace may live under the user’s home directory.

**Data flow**: It checks common environment variables such as `HOME` and `USERPROFILE`, ignores empty or relative values, and falls back to the system home-directory helper. It returns an absolute path if one can be found, otherwise nothing.

**Call relations**: It is called by `list_marketplaces` during marketplace discovery and by remote plugin checkout code that also needs a home folder.

*Call graph*: called by 2 (list_marketplaces, checkout_remote_plugin_share).


##### `validate_marketplace_root`  (lines 238–247)

```
fn validate_marketplace_root(root: &Path) -> Result<String, MarketplaceError>
```

**Purpose**: Checks whether a folder is a valid marketplace root and returns the marketplace name if it is. This is useful when users or configuration point Codex at a marketplace folder and Codex needs to verify it before trusting it.

**Data flow**: It receives a root path, searches inside it for a supported marketplace manifest, then loads that marketplace. If the layout or file is invalid, it returns a marketplace error; otherwise it returns the marketplace’s name.

**Call relations**: This function first calls `find_marketplace_manifest_path` to locate the catalog and then `load_marketplace` to prove it can be read. It is used by marketplace configuration, installation, and upgrade flows before accepting a marketplace source.

*Call graph*: calls 2 internal fn (find_marketplace_manifest_path, load_marketplace); called by 4 (find_marketplace_root_by_name, installed_marketplace_root_for_source, validate_marketplace_source_root, upgrade_configured_git_marketplace); 1 external calls (to_path_buf).


##### `find_marketplace_manifest_path`  (lines 249–259)

```
fn find_marketplace_manifest_path(root: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: Looks under a root folder for a marketplace JSON file in one of the supported locations. It answers the simple question: “Does this folder contain a marketplace catalog Codex understands?”

**Data flow**: It receives a root path and tries each supported relative manifest path beneath it. The first existing file is converted to an absolute path and returned. If none exist or the path cannot be made absolute, it returns nothing.

**Call relations**: Marketplace import, configuration checks, discovery, validation, and upgrade code call this whenever they need to locate the actual manifest file inside a candidate root.

*Call graph*: called by 5 (import_plugins, configured_marketplace_snapshot_issues, discover_marketplace_paths_from_roots, validate_marketplace_root, upgrade_configured_git_marketplace).


##### `supported_marketplace_manifest_path`  (lines 261–272)

```
fn supported_marketplace_manifest_path(path: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: Checks whether a given path is itself a marketplace manifest in a supported layout. This is for cases where Codex is handed the file path directly rather than the marketplace root folder.

**Data flow**: It receives a path, confirms it is a file, checks whether its surrounding folders match one of the accepted layouts, and returns an absolute path if so. Otherwise it returns nothing.

**Call relations**: Marketplace discovery uses this before trying broader root-folder searches. It lets `discover_marketplace_paths_from_roots` accept both direct manifest paths and root folders.

*Call graph*: calls 1 internal fn (try_from); called by 1 (discover_marketplace_paths_from_roots); 2 external calls (is_file, to_path_buf).


##### `invalid_marketplace_layout_error`  (lines 274–279)

```
fn invalid_marketplace_layout_error(path: &AbsolutePathBuf) -> MarketplaceError
```

**Purpose**: Creates a consistent error for marketplace files that are not located in one of the supported folder layouts. This keeps layout-related failures easy to recognize and explain.

**Data flow**: It receives the marketplace path and builds an `InvalidMarketplaceFile` error with a fixed message saying the file is not in a supported location.

**Call relations**: It is used by `marketplace_root_dir` when that function cannot work out the marketplace root from the manifest path.

*Call graph*: calls 1 internal fn (to_path_buf); called by 1 (marketplace_root_dir).


##### `marketplace_root_from_layout`  (lines 281–294)

```
fn marketplace_root_from_layout(marketplace_path: &Path, relative_path: &str) -> Option<PathBuf>
```

**Purpose**: Works backward from a marketplace manifest path to find the marketplace root, but only if the path matches one supported layout. For example, it can turn `<root>/.agents/plugins/marketplace.json` back into `<root>`.

**Data flow**: It receives the manifest path and one supported relative layout. It compares the manifest path’s trailing folder and file names against that layout from the end backward. If every piece matches, it returns the root path; otherwise it returns nothing.

**Call relations**: This is a layout-recognition helper used when `marketplace_root_dir` needs to recover the root folder for path resolution.

*Call graph*: called by 1 (marketplace_root_dir); 1 external calls (new).


##### `load_marketplace`  (lines 296–341)

```
fn load_marketplace(path: &AbsolutePathBuf) -> Result<Marketplace, MarketplaceError>
```

**Purpose**: Reads a marketplace file and turns it into the clean public `Marketplace` structure used by the rest of Codex. It filters out unsupported or invalid plugin entries where possible instead of failing the whole marketplace for every bad plugin.

**Data flow**: It receives an absolute manifest path, reads the raw JSON, then resolves each plugin entry. Valid entries become `MarketplacePlugin` records with source, policy, optional local version, optional interface, and keywords. Invalid plugin IDs are logged and skipped; serious marketplace-level errors are returned.

**Call relations**: It calls `load_raw_marketplace_manifest` to read JSON, `resolve_marketplace_plugin_entry` to interpret each plugin, and `resolve_marketplace_interface` for display metadata. It is used by marketplace cache refresh, marketplace listing, and root validation.

*Call graph*: calls 3 internal fn (load_raw_marketplace_manifest, resolve_marketplace_interface, resolve_marketplace_plugin_entry); called by 3 (refresh_curated_plugin_cache, list_marketplaces_with_home, validate_marketplace_root); 3 external calls (new, clone, warn!).


##### `list_marketplaces_with_home`  (lines 344–368)

```
fn list_marketplaces_with_home(
    additional_roots: &[AbsolutePathBuf],
    home_dir: Option<&Path>,
) -> Result<MarketplaceListOutcome, MarketplaceError>
```

**Purpose**: Discovers marketplace files and loads each one, while collecting errors for marketplaces that fail. This lets Codex show or use the marketplaces that worked instead of giving up because one file was bad.

**Data flow**: It receives extra roots plus an optional home directory. It discovers marketplace manifest paths, tries to load each one, appends successful marketplaces to the result, and records failed paths with error messages. It returns one outcome containing both successes and failures.

**Call relations**: The public `list_marketplaces` function calls this after choosing the home directory. It relies on `discover_marketplace_paths_from_roots` for the search and `load_marketplace` for reading each catalog.

*Call graph*: calls 2 internal fn (discover_marketplace_paths_from_roots, load_marketplace); called by 1 (list_marketplaces); 2 external calls (default, warn!).


##### `discover_marketplace_paths_from_roots`  (lines 370–407)

```
fn discover_marketplace_paths_from_roots(
    additional_roots: &[AbsolutePathBuf],
    home_dir: Option<&Path>,
) -> Vec<AbsolutePathBuf>
```

**Purpose**: Builds the ordered list of marketplace manifest files Codex should try to load. It avoids duplicates and supports several ways a marketplace may be provided.

**Data flow**: It receives extra roots and an optional home directory. It first checks the home directory, then for each extra root it tries a direct manifest path, a marketplace root layout, and finally the root of the surrounding Git repository. It returns a de-duplicated list of manifest paths.

**Call relations**: This is the search engine underneath `list_marketplaces_with_home`. It calls `find_marketplace_manifest_path` and `supported_marketplace_manifest_path`, and it can ask Git utilities for the repository root when a supplied path is inside a checkout.

*Call graph*: calls 3 internal fn (find_marketplace_manifest_path, supported_marketplace_manifest_path, try_from); called by 1 (list_marketplaces_with_home); 2 external calls (new, get_git_repo_root).


##### `load_raw_marketplace_manifest`  (lines 409–425)

```
fn load_raw_marketplace_manifest(
    path: &AbsolutePathBuf,
) -> Result<RawMarketplaceManifest, MarketplaceError>
```

**Purpose**: Reads the marketplace JSON file from disk and parses it into the raw manifest shape that mirrors the file format. It is the point where text on disk becomes structured data.

**Data flow**: It receives an absolute file path, reads the file as a string, and parses it as JSON. A missing file becomes `MarketplaceNotFound`; other read problems become input/output errors; invalid JSON becomes `InvalidMarketplaceFile` with the parser’s message.

**Call relations**: Both `find_marketplace_plugin` and `load_marketplace` call this before resolving plugin entries into the safer public marketplace model.

*Call graph*: calls 1 internal fn (as_path); called by 2 (find_marketplace_plugin, load_marketplace); 2 external calls (read_to_string, from_str).


##### `resolve_marketplace_plugin_entry`  (lines 427–466)

```
fn resolve_marketplace_plugin_entry(
    marketplace_path: &AbsolutePathBuf,
    marketplace_name: &str,
    plugin: RawMarketplaceManifestPlugin,
) -> Result<Option<ResolvedMarketplacePlugin>, Market
```

**Purpose**: Turns one raw plugin entry from the marketplace JSON into a usable, validated plugin record. This is where names, sources, policies, local manifests, and categories are brought together.

**Data flow**: It receives the marketplace path, the marketplace name, and one raw plugin entry. It resolves the plugin source, optionally reads the local plugin manifest, merges marketplace category information into the interface, builds a checked plugin ID, and returns a resolved plugin. Unsupported sources are skipped by returning nothing; invalid plugin names become errors.

**Call relations**: `find_marketplace_plugin` uses this when looking for one plugin, and `load_marketplace` uses it for every entry in a catalog. It calls `resolve_supported_plugin_source`, `load_plugin_manifest`, `plugin_interface_with_marketplace_category`, and the plugin ID constructor.

*Call graph*: calls 4 internal fn (load_plugin_manifest, plugin_interface_with_marketplace_category, resolve_supported_plugin_source, new); called by 2 (find_marketplace_plugin, load_marketplace).


##### `resolve_supported_plugin_source`  (lines 468–495)

```
fn resolve_supported_plugin_source(
    marketplace_path: &AbsolutePathBuf,
    plugin_name: &str,
    source: RawMarketplaceManifestPluginSource,
) -> Option<MarketplacePluginSource>
```

**Purpose**: Filters and resolves a plugin source while treating unsupported or bad source descriptions as skippable plugin entries. This keeps one unfamiliar source format from breaking the whole marketplace.

**Data flow**: It receives the marketplace path, plugin name, and raw source. If the source is unsupported, it logs a warning and returns nothing. Otherwise it asks `resolve_plugin_source` to normalize it; success returns a source, while failure is logged and skipped.

**Call relations**: `resolve_marketplace_plugin_entry` calls this before doing any other plugin resolution work. It acts as a safe wrapper around `resolve_plugin_source`.

*Call graph*: calls 1 internal fn (resolve_plugin_source); called by 1 (resolve_marketplace_plugin_entry); 1 external calls (warn!).


##### `resolve_plugin_source`  (lines 497–541)

```
fn resolve_plugin_source(
    marketplace_path: &AbsolutePathBuf,
    source: RawMarketplaceManifestPluginSource,
) -> Result<MarketplacePluginSource, MarketplaceError>
```

**Purpose**: Converts the marketplace JSON’s source field into a clear internal source: either a local folder or a Git repository. It understands several accepted JSON shapes for backward compatibility and convenience.

**Data flow**: It receives the marketplace path and a raw source value. Local sources are converted into safe absolute local paths. Git sources have their URL, optional subdirectory, optional branch or tag, and optional commit hash cleaned up. It returns the normalized source or an error if the source is invalid.

**Call relations**: `resolve_supported_plugin_source` calls this after filtering out unsupported source formats. It delegates detailed cleanup to `resolve_local_plugin_source_path`, `normalize_git_plugin_source_url`, `normalize_remote_plugin_subdir`, and `normalize_optional_git_selector`.

*Call graph*: calls 4 internal fn (normalize_git_plugin_source_url, normalize_optional_git_selector, normalize_remote_plugin_subdir, resolve_local_plugin_source_path); called by 1 (resolve_supported_plugin_source); 1 external calls (unreachable!).


##### `resolve_local_plugin_source_path`  (lines 543–574)

```
fn resolve_local_plugin_source_path(
    marketplace_path: &AbsolutePathBuf,
    path: &str,
) -> Result<AbsolutePathBuf, MarketplaceError>
```

**Purpose**: Validates and resolves a local plugin path from the marketplace file. It makes sure local plugin paths stay inside the marketplace root instead of pointing somewhere unexpected.

**Data flow**: It receives the marketplace manifest path and a source string. The string must start with `./`, must not be empty, and must contain only normal path pieces, not parent-directory jumps like `..`. It then joins the safe relative path to the marketplace root and returns an absolute path.

**Call relations**: `resolve_plugin_source` calls this for local plugin sources. It uses `marketplace_root_dir` to find the trusted root folder before building the final path.

*Call graph*: calls 2 internal fn (marketplace_root_dir, to_path_buf); called by 1 (resolve_plugin_source); 1 external calls (new).


##### `normalize_remote_plugin_subdir`  (lines 576–599)

```
fn normalize_remote_plugin_subdir(
    marketplace_path: &AbsolutePathBuf,
    path: &str,
) -> Result<String, MarketplaceError>
```

**Purpose**: Cleans and checks a subfolder path inside a remote Git repository. It prevents marketplace entries from naming an empty path or escaping upward out of the repository.

**Data flow**: It receives the marketplace path and a subdirectory string. It trims whitespace, removes an optional leading `./`, rejects empty paths, and rejects path components such as `..`. It returns the safe subdirectory string.

**Call relations**: `resolve_plugin_source` calls this when a Git source points to a plugin inside a repository subfolder.

*Call graph*: calls 1 internal fn (to_path_buf); called by 1 (resolve_plugin_source); 1 external calls (new).


##### `normalize_git_plugin_source_url`  (lines 601–636)

```
fn normalize_git_plugin_source_url(
    marketplace_path: &AbsolutePathBuf,
    url: &str,
) -> Result<String, MarketplaceError>
```

**Purpose**: Accepts the different Git URL styles marketplace authors may write and turns them into a form Codex can use. It also rejects empty or unrecognized Git source URLs.

**Data flow**: It receives the marketplace path and a URL string. It trims whitespace, accepts HTTP, HTTPS, file, absolute local, SSH, and GitHub shorthand forms, and normalizes supported forms where needed. Relative URLs are resolved under the marketplace root. If nothing matches, it returns an invalid-file error.

**Call relations**: `resolve_plugin_source` calls this for every Git-based plugin source. It may hand work to `normalize_github_git_url`, `normalize_relative_git_plugin_source_url`, or `normalize_github_shorthand_url` depending on the input style.

*Call graph*: calls 4 internal fn (normalize_github_git_url, normalize_github_shorthand_url, normalize_relative_git_plugin_source_url, to_path_buf); called by 1 (resolve_plugin_source); 1 external calls (format!).


##### `normalize_relative_git_plugin_source_url`  (lines 638–659)

```
fn normalize_relative_git_plugin_source_url(
    marketplace_path: &AbsolutePathBuf,
    url: &str,
) -> Result<String, MarketplaceError>
```

**Purpose**: Resolves a relative Git source path against the marketplace root while refusing to leave that root. This lets a marketplace point at a sibling local repository safely.

**Data flow**: It receives the marketplace path and a relative URL string. It starts from the marketplace root, walks each slash- or backslash-separated segment, ignores `.` and empty pieces, rejects `..`, and returns the resulting local path as a string.

**Call relations**: `normalize_git_plugin_source_url` calls this only for relative Git source URLs such as `./repo`. It uses `marketplace_root_dir` to know the safe base folder.

*Call graph*: calls 2 internal fn (marketplace_root_dir, to_path_buf); called by 1 (normalize_git_plugin_source_url).


##### `normalize_optional_git_selector`  (lines 661–667)

```
fn normalize_optional_git_selector(value: &Option<String>) -> Option<String>
```

**Purpose**: Cleans optional Git selectors, such as a branch name, tag, or commit hash. Empty strings are treated the same as not providing a selector.

**Data flow**: It receives an optional string. If present, it trims whitespace and keeps it only if something remains. It returns either the cleaned string or nothing.

**Call relations**: `resolve_plugin_source` uses this for optional Git `ref` and `sha` fields while building a normalized Git plugin source.

*Call graph*: called by 1 (resolve_plugin_source).


##### `normalize_github_git_url`  (lines 669–675)

```
fn normalize_github_git_url(url: &str) -> String
```

**Purpose**: Adds the conventional `.git` suffix to plain GitHub HTTPS repository URLs when it is missing. This makes GitHub URLs more consistent for later Git operations.

**Data flow**: It receives a URL string. If it starts with `https://github.com/` and does not already end in `.git`, it returns the same URL with `.git` appended. Otherwise it returns the original URL unchanged.

**Call relations**: `normalize_git_plugin_source_url` calls this after recognizing an HTTP or HTTPS URL.

*Call graph*: called by 1 (normalize_git_plugin_source_url); 1 external calls (format!).


##### `normalize_github_shorthand_url`  (lines 677–689)

```
fn normalize_github_shorthand_url(source: &str) -> Option<String>
```

**Purpose**: Turns a short GitHub reference like `owner/repo` into a full GitHub Git URL. This lets marketplace files stay concise while Codex still gets a complete URL.

**Data flow**: It receives a source string, first checks whether it looks like valid two-part GitHub shorthand, then extracts the owner and repository names. It removes any `.git` suffix from the repository part and returns `https://github.com/owner/repo.git`; invalid shorthand returns nothing.

**Call relations**: `normalize_git_plugin_source_url` calls this after other URL styles do not match. It uses `looks_like_github_shorthand` to decide whether the input is eligible.

*Call graph*: calls 1 internal fn (looks_like_github_shorthand); called by 1 (normalize_git_plugin_source_url); 1 external calls (format!).


##### `looks_like_github_shorthand`  (lines 691–699)

```
fn looks_like_github_shorthand(source: &str) -> bool
```

**Purpose**: Checks whether a string has exactly the simple `owner/repo` shape accepted as GitHub shorthand. It keeps the shorthand rule narrow so random strings are not mistaken for repositories.

**Data flow**: It receives a string, splits it on `/`, and requires exactly two valid segments with no extra part. It returns true only when both pieces pass the allowed-character check.

**Call relations**: `normalize_github_shorthand_url` uses this as its gatekeeper before constructing a full GitHub URL.

*Call graph*: called by 1 (normalize_github_shorthand_url).


##### `is_github_shorthand_segment`  (lines 701–706)

```
fn is_github_shorthand_segment(segment: &str) -> bool
```

**Purpose**: Checks whether one part of a GitHub shorthand reference is non-empty and uses only allowed characters. It is the small character-level rule behind the shorthand parser.

**Data flow**: It receives one segment string and returns true if it is not empty and every character is a letter, digit, dash, underscore, or dot. Otherwise it returns false.

**Call relations**: `looks_like_github_shorthand` relies on this for both the owner and repository parts of a shorthand source.


##### `plugin_interface_with_marketplace_category`  (lines 708–719)

```
fn plugin_interface_with_marketplace_category(
    mut interface: Option<PluginManifestInterface>,
    category: Option<String>,
) -> Option<PluginManifestInterface>
```

**Purpose**: Combines plugin interface metadata with a category supplied by the marketplace. If both the plugin manifest and marketplace name a category, the marketplace category wins.

**Data flow**: It receives optional interface metadata and an optional category string. If a category is present, it creates default interface metadata if needed and sets that category. It returns the updated interface, or the original empty value if there is still no metadata.

**Call relations**: `resolve_marketplace_plugin_entry` calls this when combining marketplace and manifest information. Plugin detail reading code also uses it so category behavior stays consistent.

*Call graph*: called by 2 (read_plugin_detail_for_marketplace_plugin, resolve_marketplace_plugin_entry).


##### `marketplace_root_dir`  (lines 722–735)

```
fn marketplace_root_dir(
    marketplace_path: &AbsolutePathBuf,
) -> Result<AbsolutePathBuf, MarketplaceError>
```

**Purpose**: Finds the root folder that owns a marketplace manifest path. Many path checks depend on this root so local plugin paths and relative Git paths can be resolved safely.

**Data flow**: It receives an absolute marketplace manifest path and tries each supported marketplace layout. If one layout matches, it converts the recovered root into an absolute path and returns it. If none match, it returns a consistent invalid-layout error.

**Call relations**: Path-resolution code such as `resolve_local_plugin_source_path` and `normalize_relative_git_plugin_source_url` calls this before joining relative paths. Other listing code also uses it when it needs to reason from manifest file back to root folder.

*Call graph*: calls 4 internal fn (invalid_marketplace_layout_error, marketplace_root_from_layout, as_path, try_from); called by 3 (run_list, normalize_relative_git_plugin_source_url, resolve_local_plugin_source_path).


##### `resolve_marketplace_interface`  (lines 806–817)

```
fn resolve_marketplace_interface(
    interface: Option<RawMarketplaceManifestInterface>,
) -> Option<MarketplaceInterface>
```

**Purpose**: Turns raw marketplace interface metadata from JSON into the public marketplace interface structure, but only when there is meaningful display information. This avoids carrying around empty metadata objects.

**Data flow**: It receives optional raw interface data. If there is no interface, or if it has no display name, it returns nothing. If a display name exists, it returns a `MarketplaceInterface` containing it.

**Call relations**: `load_marketplace` calls this after reading the raw marketplace manifest so the returned `Marketplace` has clean, useful display metadata.

*Call graph*: called by 1 (load_marketplace).


### `core-plugins/src/loader.rs`

`orchestration` · `startup, config load, plugin cache refresh, and plugin detail lookup`

Plugins are extra bundles of capability. A plugin may contain skills, app connectors, hook rules, or MCP servers. MCP means “Model Context Protocol”, a way for the app to talk to external tools through named servers. This file is the place that gathers all those pieces and makes them usable.

At startup or during plugin-related operations, it first reads the user’s plugin configuration. It merges that with remotely installed plugin state when needed, then loads each enabled plugin from the local plugin store. Loading is careful and defensive: if a plugin is disabled, missing, has a bad name, or lacks a valid manifest, the loader returns a plugin record with an error instead of crashing the whole system.

For a valid plugin, it reads the manifest, finds default or manifest-specified files, loads skills, reads MCP server definitions, reads app declarations, and loads hooks. Hooks can be loaded alone, which is useful when the system only needs startup hook rules and does not want to pay the cost of loading everything else.

The file also refreshes cached plugin copies. Curated plugins are copied from bundled marketplace files, while non-curated marketplace plugins may be local folders or git repositories. In short, this file is the “plugin receiving desk”: it checks what plugins are requested, finds their packages, opens their paperwork, and hands clean capability lists to the rest of the program.

#### Function details

##### `log_plugin_load_errors`  (lines 83–93)

```
fn log_plugin_load_errors(plugins: &[LoadedPlugin<McpServerConfig>])
```

**Purpose**: Writes a warning for every loaded plugin that carries an error. This gives operators a visible clue that a plugin failed without stopping all plugins from loading.

**Data flow**: It receives a list of loaded plugin records. It looks for records with an error message, then writes a warning containing the plugin name, root path, and error. It returns nothing and only changes the log output.

**Call relations**: After plugin loading is forced or refreshed, plugins_for_config_with_force_reload calls this to surface any failures found during the earlier loading work.

*Call graph*: called by 1 (plugins_for_config_with_force_reload); 2 external calls (iter, warn!).


##### `load_plugins_from_layer_stack`  (lines 110–129)

```
async fn load_plugins_from_layer_stack(
    config_layer_stack: &ConfigLayerStack,
    extra_plugins: HashMap<String, PluginConfig>,
    store: &PluginStore,
    restriction_product: Option<Product>,
```

**Purpose**: Loads all configured plugins with their full capabilities, using the combined configuration stack. It is the normal high-level entry for turning config into usable plugin records.

**Data flow**: It receives layered configuration, extra plugin settings, the plugin store, an optional product restriction, and a conflict preference. It derives skill enable/disable rules from the configuration, then asks the scoped loader to load every capability. It returns a list of loaded plugin records.

**Call relations**: Higher-level plugin entry points call this when they need complete plugin information. It prepares skill rules, then delegates the actual merge-and-load loop to load_plugins_from_layer_stack_with_scope.

*Call graph*: calls 2 internal fn (load_plugins_from_layer_stack_with_scope, skill_config_rules_from_stack); called by 3 (plugins_for_config_with_force_reload, plugins_for_layer_stack, load_plugins_ignores_project_config_files).


##### `load_plugins_from_layer_stack_with_scope`  (lines 131–167)

```
async fn load_plugins_from_layer_stack_with_scope(
    config_layer_stack: &ConfigLayerStack,
    extra_plugins: HashMap<String, PluginConfig>,
    store: &PluginStore,
    prefer_remote_curated_confl
```

**Purpose**: Loads configured plugins either fully or in a hooks-only mode. This shared path prevents the hooks-only loader and the full loader from disagreeing about which plugins are enabled.

**Data flow**: It reads configured plugins from the config stack, merges in extra or remote-installed plugins, sorts them for stable order, then loads each one. As it goes, it watches for duplicate MCP server names and logs a warning when two plugins declare the same name. It returns all loaded plugin records.

**Call relations**: Both load_plugins_from_layer_stack and load_plugin_hooks_from_layer_stack rely on this. For each plugin it calls load_plugin, and it supplies the scope that tells load_plugin how much work to do.

*Call graph*: calls 3 internal fn (configured_plugins_from_stack, load_plugin, merge_configured_plugins_with_remote_installed); called by 2 (load_plugin_hooks_from_layer_stack, load_plugins_from_layer_stack); 3 external calls (new, with_capacity, warn!).


##### `load_plugin_hooks_from_layer_stack`  (lines 170–196)

```
async fn load_plugin_hooks_from_layer_stack(
    config_layer_stack: &ConfigLayerStack,
    extra_plugins: HashMap<String, PluginConfig>,
    store: &PluginStore,
    prefer_remote_curated_conflicts:
```

**Purpose**: Loads only hook declarations from enabled plugins. This is useful when the system needs hook rules but does not need skills, apps, or MCP servers yet.

**Data flow**: It receives the same plugin configuration inputs as full loading. It asks the shared loader to run in hooks-only mode, filters to active plugins, collects their hook sources and hook warnings, and returns those two lists in a small outcome object.

**Call relations**: plugin_hooks_for_layer_stack calls this when it needs startup hook configuration. Internally it reuses load_plugins_from_layer_stack_with_scope so hook loading follows the same plugin selection rules as full loading.

*Call graph*: calls 1 internal fn (load_plugins_from_layer_stack_with_scope); called by 1 (plugin_hooks_for_layer_stack).


##### `merge_configured_plugins_with_remote_installed`  (lines 198–244)

```
fn merge_configured_plugins_with_remote_installed(
    mut configured_plugins: HashMap<String, PluginConfig>,
    extra_plugins: HashMap<String, PluginConfig>,
    store: &PluginStore,
    prefer_remo
```

**Purpose**: Combines plugins from user configuration with plugins reported as remotely installed. It also resolves a special conflict where a local curated plugin and a remote curated plugin refer to the same plugin name.

**Data flow**: It starts with configured plugins, extra plugin configs, the plugin store, and a conflict preference. It identifies installed local curated plugins, checks whether incoming remote curated plugins overlap, then either keeps the local one or replaces it depending on the preference. It returns the final plugin config map.

**Call relations**: The shared loader calls this before loading any plugin. It uses installed_plugin_name_for_marketplace to recognize remote curated plugins that are actually installed locally.

*Call graph*: calls 3 internal fn (installed_plugin_name_for_marketplace, active_plugin_version, parse); called by 1 (load_plugins_from_layer_stack_with_scope); 2 external calls (new, is_openai_curated_marketplace_name).


##### `installed_plugin_name_for_marketplace`  (lines 246–257)

```
fn installed_plugin_name_for_marketplace(
    plugin_key: &str,
    marketplace_name: &str,
    store: &PluginStore,
) -> Option<String>
```

**Purpose**: Checks whether a plugin key names an installed plugin from a specific marketplace. If so, it returns that plugin’s simple name.

**Data flow**: It receives a plugin key, a marketplace name, and the plugin store. It parses the key, verifies the marketplace matches, and confirms the store has an active root for that plugin. It returns the plugin name, or nothing if any check fails.

**Call relations**: merge_configured_plugins_with_remote_installed uses this as a small helper while deciding whether remote-installed plugin config conflicts with locally configured curated plugins.

*Call graph*: calls 2 internal fn (active_plugin_root, parse); called by 1 (merge_configured_plugins_with_remote_installed).


##### `remote_installed_plugins_to_config`  (lines 259–292)

```
fn remote_installed_plugins_to_config(
    plugins: &[RemoteInstalledPlugin],
    store: &PluginStore,
) -> HashMap<String, PluginConfig>
```

**Purpose**: Turns the server’s list of remotely installed plugins into local plugin configuration entries. It ignores invalid names and plugins whose bundle is not already present in the local cache.

**Data flow**: It receives remote plugin records and the plugin store. For each record it builds a plugin id, checks that the local cache has an active plugin root, and creates a PluginConfig with the remote enabled flag. It returns a map keyed by plugin id string.

**Call relations**: remote_installed_plugin_configs calls this while reconciling remote install state with local loading. The result can later be merged into the normal configured plugin list.

*Call graph*: called by 1 (remote_installed_plugin_configs); 1 external calls (iter).


##### `refresh_curated_plugin_cache`  (lines 294–383)

```
fn refresh_curated_plugin_cache(
    codex_home: &Path,
    plugin_version: &str,
    configured_curated_plugin_ids: &[PluginId],
) -> Result<bool, String>
```

**Purpose**: Refreshes cached copies of curated plugins that are configured by the user. Curated plugins are the officially bundled marketplace plugins shipped through known marketplace files.

**Data flow**: It receives the Codex home directory, the current plugin version, and configured curated plugin ids. It loads curated marketplace files, maps plugin ids to local source folders, removes stale cached plugins that vanished from a loaded marketplace, and installs updated copies when the cache version differs. It returns whether anything changed, or an error string.

**Call relations**: This is called by cache-refresh or install flows. It uses curated_marketplace_paths_for_cache_refresh to find marketplace files and curated_plugin_cache_version to normalize the cache version name.

*Call graph*: calls 5 internal fn (curated_marketplace_paths_for_cache_refresh, curated_plugin_cache_version, load_marketplace, try_new, new); 4 external calls (new, new, to_path_buf, warn!).


##### `curated_marketplace_paths_for_cache_refresh`  (lines 385–407)

```
fn curated_marketplace_paths_for_cache_refresh(
    codex_home: &Path,
) -> Result<Vec<AbsolutePathBuf>, String>
```

**Purpose**: Finds the local marketplace JSON files used to refresh curated plugin cache entries. It knows the expected temporary paths where bundled curated marketplace data is placed.

**Data flow**: It receives the Codex home directory. It builds the required curated marketplace path and optionally adds the API curated marketplace path if that file exists. It returns absolute paths or an error if a path cannot be made absolute.

**Call relations**: refresh_curated_plugin_cache calls this before reading marketplace contents, so cache refresh works from the same known marketplace locations every time.

*Call graph*: calls 1 internal fn (try_from); called by 1 (refresh_curated_plugin_cache); 2 external calls (join, vec!).


##### `curated_plugin_cache_version`  (lines 409–415)

```
fn curated_plugin_cache_version(plugin_version: &str) -> String
```

**Purpose**: Chooses the version string used for cached curated plugin copies. Full git commit hashes are shortened so cache folder versions stay compact.

**Data flow**: It receives a plugin version string. If the string looks like a full 40-character git SHA, it returns the first eight characters; otherwise it returns the original string. It does not touch disk.

**Call relations**: refresh_curated_plugin_cache uses this when deciding whether a cached curated plugin is current. install_resolved_plugin also uses it when installing a curated plugin.

*Call graph*: calls 1 internal fn (is_full_git_sha); called by 2 (refresh_curated_plugin_cache, install_resolved_plugin).


##### `refresh_non_curated_plugin_cache`  (lines 417–426)

```
fn refresh_non_curated_plugin_cache(
    codex_home: &Path,
    additional_roots: &[AbsolutePathBuf],
) -> Result<bool, String>
```

**Purpose**: Refreshes cached copies of configured non-curated plugins, but only when their source version changed. Non-curated means plugins from discovered marketplaces other than the official curated ones.

**Data flow**: It receives Codex home and extra marketplace roots. It calls the shared non-curated refresh helper in normal mode, which compares source versions before reinstalling. It returns whether the cache changed or an error.

**Call relations**: run_non_curated_plugin_cache_refresh_loop calls this for routine background refreshes. The real work is done by refresh_non_curated_plugin_cache_with_mode.

*Call graph*: calls 1 internal fn (refresh_non_curated_plugin_cache_with_mode); called by 1 (run_non_curated_plugin_cache_refresh_loop).


##### `refresh_non_curated_plugin_cache_force_reinstall`  (lines 428–437)

```
fn refresh_non_curated_plugin_cache_force_reinstall(
    codex_home: &Path,
    additional_roots: &[AbsolutePathBuf],
) -> Result<bool, String>
```

**Purpose**: Refreshes configured non-curated plugins by reinstalling them even if their version appears unchanged. This is useful after marketplace upgrades or when the cache may be stale for reasons beyond the version string.

**Data flow**: It receives Codex home and extra marketplace roots. It calls the shared refresh helper in force-reinstall mode. It returns whether anything was reinstalled or an error.

**Call relations**: The background refresh loop and marketplace upgrade flow call this when they want a stronger refresh than the normal version check.

*Call graph*: calls 1 internal fn (refresh_non_curated_plugin_cache_with_mode); called by 2 (run_non_curated_plugin_cache_refresh_loop, upgrade_configured_marketplaces_for_config).


##### `refresh_non_curated_plugin_cache_with_mode`  (lines 439–526)

```
fn refresh_non_curated_plugin_cache_with_mode(
    codex_home: &Path,
    additional_roots: &[AbsolutePathBuf],
    mode: NonCuratedCacheRefreshMode,
) -> Result<bool, String>
```

**Purpose**: Performs the actual cache refresh for configured non-curated marketplace plugins. It discovers sources, materializes them, reads versions, and installs updated bundles into the plugin store.

**Data flow**: It reads plugin config from config.toml, keeps only non-curated plugin ids, lists available marketplaces, and matches configured plugins to marketplace entries. For each match it turns the source into a local path, reads the plugin version, and installs it unless normal mode says the same version is already active. It returns whether any cache entry changed.

**Call relations**: Both public non-curated refresh functions call this with different modes. It uses materialize_marketplace_plugin_source when a marketplace source must be made available as a local directory.

*Call graph*: calls 7 internal fn (configured_plugins_from_codex_home, materialize_marketplace_plugin_source, non_curated_plugin_ids_from_config_keys, list_marketplaces, try_new, plugin_version_for_source, new); called by 2 (refresh_non_curated_plugin_cache, refresh_non_curated_plugin_cache_force_reinstall); 4 external calls (new, to_path_buf, is_openai_curated_marketplace_name, warn!).


##### `configured_plugins_from_stack`  (lines 528–535)

```
fn configured_plugins_from_stack(
    config_layer_stack: &ConfigLayerStack,
) -> HashMap<String, PluginConfig>
```

**Purpose**: Extracts plugin configuration from the effective user configuration in a layered config stack. If there is no user config, it reports no configured plugins.

**Data flow**: It receives a ConfigLayerStack. It asks for the effective user config, then passes that TOML value to configured_plugins_from_user_config_value. It returns a map of plugin keys to plugin settings.

**Call relations**: load_plugins_from_layer_stack_with_scope calls this before merging local config with remote-installed plugins.

*Call graph*: calls 2 internal fn (effective_user_config, configured_plugins_from_user_config_value); called by 1 (load_plugins_from_layer_stack_with_scope); 1 external calls (new).


##### `is_full_git_sha`  (lines 537–539)

```
fn is_full_git_sha(value: &str) -> bool
```

**Purpose**: Checks whether a string looks like a full git commit SHA. A SHA is a hexadecimal identifier used by git to name an exact commit.

**Data flow**: It receives a string. It checks that it is exactly 40 characters long and that every character is hexadecimal. It returns true or false.

**Call relations**: curated_plugin_cache_version calls this to decide whether to shorten a version string.

*Call graph*: called by 1 (curated_plugin_cache_version).


##### `configured_plugins_from_user_config_value`  (lines 541–554)

```
fn configured_plugins_from_user_config_value(
    user_config: &toml::Value,
) -> HashMap<String, PluginConfig>
```

**Purpose**: Reads the plugins section from an already-parsed user config value. Bad plugin config is ignored with a warning instead of breaking startup.

**Data flow**: It receives a TOML value. It looks for the top-level plugins table and tries to convert it into plugin configuration records. It returns that map, or an empty map if the section is missing or invalid.

**Call relations**: configured_plugins_from_stack uses this for in-memory layered config, and configured_plugins_from_codex_home uses it after reading config.toml from disk.

*Call graph*: called by 2 (configured_plugins_from_codex_home, configured_plugins_from_stack); 3 external calls (new, get, warn!).


##### `configured_plugins_from_codex_home`  (lines 556–588)

```
fn configured_plugins_from_codex_home(
    codex_home: &Path,
    read_error_message: &str,
    parse_error_message: &str,
) -> HashMap<String, PluginConfig>
```

**Purpose**: Reads plugin configuration directly from the user’s config.toml file under Codex home. This is used by cache refresh paths that do not already have a full config stack.

**Data flow**: It receives Codex home plus warning messages to use for read and parse failures. It reads config.toml if present, parses it as TOML, extracts the plugins section, and returns plugin settings. Missing files or invalid content produce warnings and an empty map.

**Call relations**: configured_curated_plugin_ids_from_codex_home and the non-curated cache refresh helper call this before deciding which plugin ids need cache work.

*Call graph*: calls 1 internal fn (configured_plugins_from_user_config_value); called by 2 (configured_curated_plugin_ids_from_codex_home, refresh_non_curated_plugin_cache_with_mode); 4 external calls (new, join, read_to_string, warn!).


##### `configured_plugin_ids`  (lines 590–608)

```
fn configured_plugin_ids(
    configured_plugins: HashMap<String, PluginConfig>,
    invalid_plugin_key_message: &str,
) -> Vec<PluginId>
```

**Purpose**: Converts plugin config keys into structured plugin ids and drops invalid keys. This turns raw strings from config into safer values with separate marketplace and plugin names.

**Data flow**: It receives a plugin config map and a warning message. It parses each key, keeps successful ids, and logs the supplied warning for invalid keys. It returns the list of valid plugin ids.

**Call relations**: The curated and non-curated id filters both call this first, then apply their own marketplace selection rules.

*Call graph*: called by 2 (curated_plugin_ids_from_config_keys, non_curated_plugin_ids_from_config_keys).


##### `curated_plugin_ids_from_config_keys`  (lines 610–622)

```
fn curated_plugin_ids_from_config_keys(
    configured_plugins: HashMap<String, PluginConfig>,
) -> Vec<PluginId>
```

**Purpose**: Finds the configured plugin ids that belong to OpenAI curated marketplaces. It returns them in a stable order.

**Data flow**: It receives plugin configuration. It parses keys into plugin ids, keeps only curated marketplace ids, sorts them by key, and returns the list.

**Call relations**: configured_curated_plugin_ids_from_codex_home calls this after reading config.toml so curated cache refresh knows exactly which curated plugins matter.

*Call graph*: calls 1 internal fn (configured_plugin_ids); called by 1 (configured_curated_plugin_ids_from_codex_home).


##### `non_curated_plugin_ids_from_config_keys`  (lines 624–636)

```
fn non_curated_plugin_ids_from_config_keys(
    configured_plugins: HashMap<String, PluginConfig>,
) -> Vec<PluginId>
```

**Purpose**: Finds configured plugin ids that do not belong to OpenAI curated marketplaces. These are the plugins refreshed from discovered external marketplaces.

**Data flow**: It receives plugin configuration. It parses keys into plugin ids, filters out curated marketplaces, sorts the remaining ids, and returns them.

**Call relations**: refresh_non_curated_plugin_cache_with_mode calls this before scanning marketplace entries, so it only looks for plugins the user actually configured.

*Call graph*: calls 1 internal fn (configured_plugin_ids); called by 1 (refresh_non_curated_plugin_cache_with_mode).


##### `configured_curated_plugin_ids_from_codex_home`  (lines 638–644)

```
fn configured_curated_plugin_ids_from_codex_home(codex_home: &Path) -> Vec<PluginId>
```

**Purpose**: Reads config.toml and returns the curated plugin ids configured by the user. It is a convenience wrapper for curated cache setup.

**Data flow**: It receives Codex home. It reads configured plugins from config.toml, filters them to curated plugin ids, and returns the sorted list.

**Call relations**: Cache-refresh setup code uses this to know which curated plugins should be present in the local plugin cache.

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

**Purpose**: Loads one plugin record from its config and installed folder. It validates the plugin, reads its manifest, and fills in the capabilities requested by the current load scope.

**Data flow**: It receives the config name, plugin settings, plugin store, and a scope. It creates a loaded-plugin shell, returns early for disabled or invalid plugins, finds the active installed root, reads plugin.json, and then loads skills, MCP servers, apps, and hooks as appropriate. It returns a LoadedPlugin containing data or an error message.

**Call relations**: load_plugins_from_layer_stack_with_scope calls this once per configured plugin. Inside, it delegates specialized work to helpers such as load_plugin_skills, load_mcp_servers_from_file, load_plugin_apps, and load_plugin_hooks.

*Call graph*: calls 10 internal fn (apply_plugin_mcp_server_policy, load_mcp_servers_from_file, load_plugin_apps, load_plugin_hooks, load_plugin_skills, plugin_mcp_config_paths, plugin_skill_roots, load_plugin_manifest, plugin_data_root, parse); called by 1 (load_plugins_from_layer_stack_with_scope); 4 external calls (new, new, new, warn!).


##### `apply_plugin_mcp_server_policy`  (lines 761–778)

```
fn apply_plugin_mcp_server_policy(config: &mut McpServerConfig, policy: &PluginMcpServerConfig)
```

**Purpose**: Applies the user’s per-plugin MCP server policy to a server declared by the plugin. This lets user config disable a server or restrict its tools.

**Data flow**: It receives a mutable MCP server config and a policy from plugin settings. It updates enabled status, default approval mode, enabled or disabled tool lists, and per-tool approval rules. It returns nothing because it changes the config in place.

**Call relations**: load_plugin calls this while loading MCP servers, after reading a plugin’s declared server config and before storing it in the loaded plugin record.

*Call graph*: called by 1 (load_plugin).


##### `ResolvedPluginSkills::has_enabled_skills`  (lines 788–794)

```
fn has_enabled_skills(&self) -> bool
```

**Purpose**: Answers whether a plugin should be considered to have enabled skills. It treats load errors as important, because errors may mean skills were expected but could not be read.

**Data flow**: It reads the resolved skills, the disabled skill path set, and the error flag inside the ResolvedPluginSkills value. It returns true if there were load errors or if at least one skill is not disabled; otherwise false.

**Call relations**: load_plugin uses this after load_plugin_skills to set the plugin’s has_enabled_skills flag.


##### `load_plugin_skills`  (lines 797–828)

```
async fn load_plugin_skills(
    plugin_root: &AbsolutePathBuf,
    plugin_id: &PluginId,
    manifest_paths: &PluginManifestPaths,
    restriction_product: Option<Product>,
    skill_config_rules: &S
```

**Purpose**: Loads skill metadata from a plugin’s skill folders and applies product and user disable rules. A skill is a reusable instruction or capability bundle available to the assistant.

**Data flow**: It receives the plugin root, plugin id, manifest paths, an optional product restriction, and skill config rules. It builds skill roots, loads skills from those folders, filters out skills not meant for the current product, resolves which skill paths are disabled, and returns the resolved skills plus error status.

**Call relations**: load_plugin calls this during full plugin loading. Plugin detail readers can also call it when showing information about a marketplace plugin.

*Call graph*: calls 3 internal fn (plugin_skill_roots, resolve_disabled_skill_paths, load_skills_from_roots); called by 2 (load_plugin, read_plugin_detail_for_marketplace_plugin).


##### `plugin_skill_roots`  (lines 830–841)

```
fn plugin_skill_roots(
    plugin_root: &AbsolutePathBuf,
    manifest_paths: &PluginManifestPaths,
) -> Vec<AbsolutePathBuf>
```

**Purpose**: Builds the list of folders where a plugin’s skills may live. It combines the default skills folder with any manifest-specified skills path.

**Data flow**: It receives a plugin root and manifest path settings. It starts with the default skills directory if it exists, adds the manifest skills path if present, sorts and removes duplicates, and returns the folder list.

**Call relations**: load_plugin, load_plugin_skills, and plugin_telemetry_metadata_from_root use this so they all agree on where plugin skills are located.

*Call graph*: calls 1 internal fn (default_skill_roots); called by 3 (load_plugin, load_plugin_skills, plugin_telemetry_metadata_from_root).


##### `default_skill_roots`  (lines 843–850)

```
fn default_skill_roots(plugin_root: &AbsolutePathBuf) -> Vec<AbsolutePathBuf>
```

**Purpose**: Finds the conventional skills directory inside a plugin. By default, plugins can place skills in a folder named skills.

**Data flow**: It receives the plugin root, appends the default skills folder name, and checks whether that directory exists. It returns a one-item list if it exists, otherwise an empty list.

**Call relations**: plugin_skill_roots calls this before adding any manifest-defined skills path.

*Call graph*: calls 1 internal fn (join); called by 1 (plugin_skill_roots); 2 external calls (new, vec!).


##### `plugin_mcp_config_paths`  (lines 852–860)

```
fn plugin_mcp_config_paths(
    plugin_root: &Path,
    manifest_paths: &PluginManifestPaths,
) -> Vec<AbsolutePathBuf>
```

**Purpose**: Determines which MCP configuration files to read for a plugin. A manifest path takes priority over the default file location.

**Data flow**: It receives the plugin root and manifest path settings. If the manifest names an MCP config file, it returns that one path; otherwise it searches for the default .mcp.json file. It returns a list of absolute paths.

**Call relations**: load_plugin, load_declared_plugin_mcp_servers, and plugin_telemetry_metadata_from_root use this before parsing MCP server definitions.

*Call graph*: calls 1 internal fn (default_mcp_config_paths); called by 3 (load_declared_plugin_mcp_servers, load_plugin, plugin_telemetry_metadata_from_root); 1 external calls (vec!).


##### `default_mcp_config_paths`  (lines 862–873)

```
fn default_mcp_config_paths(plugin_root: &Path) -> Vec<AbsolutePathBuf>
```

**Purpose**: Looks for the default MCP config file inside a plugin folder. The default file name is .mcp.json.

**Data flow**: It receives the plugin root path, checks whether .mcp.json exists and can be made absolute, sorts and deduplicates the result, and returns zero or one paths.

**Call relations**: plugin_mcp_config_paths calls this when the manifest does not specify a custom MCP config path.

*Call graph*: calls 1 internal fn (try_from); called by 1 (plugin_mcp_config_paths); 2 external calls (join, new).


##### `load_plugin_apps`  (lines 875–884)

```
async fn load_plugin_apps(plugin_root: &Path) -> Vec<AppDeclaration>
```

**Purpose**: Loads app connector declarations from a plugin. App declarations describe external app connectors that the plugin provides or relates to.

**Data flow**: It receives a plugin root. It reads the manifest if available, chooses manifest app paths or the default .app.json file, reads those files, and returns app declarations. If the manifest is missing, it still tries the default app config path.

**Call relations**: load_plugin uses this during full loading, load_plugin_mcp_servers uses it before applying app routing policy, and plugin detail readers use it when showing plugin capabilities.

*Call graph*: calls 4 internal fn (default_app_config_paths, load_apps_from_paths, plugin_app_config_paths, load_plugin_manifest); called by 3 (load_plugin, load_plugin_mcp_servers, read_plugin_detail_for_marketplace_plugin).


##### `plugin_app_declarations_from_value`  (lines 886–894)

```
fn plugin_app_declarations_from_value(value: &JsonValue) -> Vec<AppDeclaration>
```

**Purpose**: Parses app declarations from an already-loaded JSON value. This is useful when app config content is available in memory rather than as a file.

**Data flow**: It receives a JSON value, tries to interpret it as a plugin app file, converts entries into app declarations, removes duplicate connector ids, and returns the remaining declarations. Invalid JSON shape produces an empty list.

**Call relations**: plugin_app_category_by_id_from_value calls this when it needs app declarations from raw JSON data.

*Call graph*: calls 1 internal fn (app_declarations_from_file); called by 1 (plugin_app_category_by_id_from_value); 3 external calls (new, clone, new).


##### `plugin_app_config_paths`  (lines 896–904)

```
fn plugin_app_config_paths(
    plugin_root: &Path,
    manifest_paths: &PluginManifestPaths,
) -> Vec<AbsolutePathBuf>
```

**Purpose**: Chooses which app configuration files to read for a plugin. Manifest-provided paths override the default file location.

**Data flow**: It receives the plugin root and manifest path settings. If the manifest names an apps config path, it returns that; otherwise it checks for the default .app.json file. It returns absolute paths.

**Call relations**: load_plugin_apps and plugin_telemetry_metadata_from_root call this before reading app declarations.

*Call graph*: calls 1 internal fn (default_app_config_paths); called by 2 (load_plugin_apps, plugin_telemetry_metadata_from_root); 1 external calls (vec!).


##### `default_app_config_paths`  (lines 906–917)

```
fn default_app_config_paths(plugin_root: &Path) -> Vec<AbsolutePathBuf>
```

**Purpose**: Looks for the default app config file in a plugin folder. The default file name is .app.json.

**Data flow**: It receives the plugin root path, checks for .app.json, converts it to an absolute path if possible, sorts and deduplicates the result, and returns zero or one paths.

**Call relations**: plugin_app_config_paths and load_plugin_apps use this when no manifest app path is given.

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

**Purpose**: Discovers hook rules bundled with a plugin. Hooks are rules that let plugins run actions at certain system events.

**Data flow**: It receives the plugin root, plugin id, plugin data root, and manifest paths. It reads hooks from manifest-listed files, inline manifest hook objects, or the default hooks/hooks.json file. It returns hook source records and warning messages for files that could not be read or parsed.

**Call relations**: load_plugin calls this for every enabled plugin, even in hooks-only mode. Plugin detail readers also use it to inspect plugin hook capability.

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

**Purpose**: Reads one hook config file and appends it to the collected hook sources. It preserves file location details so later runtime messages can say where the hooks came from.

**Data flow**: It receives plugin identity, the hook file path, and mutable source and warning lists. It reads the file, parses it as a hooks JSON file, ignores empty hook lists, and pushes a PluginHookSource on success. Read or parse failures are added to warnings.

**Call relations**: load_plugin_hooks calls this for each manifest hook file and for the default hook file when present.

*Call graph*: calls 1 internal fn (as_path); called by 1 (load_plugin_hooks); 4 external calls (format!, read_to_string, clone, clone).


##### `load_apps_from_paths`  (lines 1029–1052)

```
async fn load_apps_from_paths(
    plugin_root: &Path,
    app_config_paths: Vec<AbsolutePathBuf>,
) -> Vec<AppDeclaration>
```

**Purpose**: Reads app declarations from one or more app config files. Bad or unreadable files are skipped so one broken app file does not stop plugin loading.

**Data flow**: It receives a plugin root and a list of app config paths. For each file it reads JSON, parses it as a plugin app file, converts it into declarations, and appends those to the result. It returns all declarations that could be loaded.

**Call relations**: load_plugin_apps and plugin_telemetry_metadata_from_root call this after deciding which app config paths apply.

*Call graph*: calls 1 internal fn (app_declarations_from_file); called by 2 (load_plugin_apps, plugin_telemetry_metadata_from_root); 3 external calls (new, read_to_string, warn!).


##### `app_declarations_from_file`  (lines 1054–1079)

```
fn app_declarations_from_file(
    parsed: PluginAppFile,
    plugin_root: Option<&Path>,
) -> Vec<AppDeclaration>
```

**Purpose**: Converts a parsed app config file into app declaration records. It drops entries that do not include a usable app id.

**Data flow**: It receives the parsed app file and optionally the plugin root for warning messages. It walks the app entries, trims and validates ids and categories, creates AppDeclaration records for valid entries, and returns the list.

**Call relations**: load_apps_from_paths uses this after reading files from disk. plugin_app_declarations_from_value uses it for JSON values already in memory.

*Call graph*: called by 2 (load_apps_from_paths, plugin_app_declarations_from_value).


##### `cleaned_app_category`  (lines 1081–1085)

```
fn cleaned_app_category(category: Option<String>) -> Option<String>
```

**Purpose**: Normalizes an optional app category by trimming whitespace and treating an empty string as missing.

**Data flow**: It receives an optional string. If present, it trims surrounding whitespace and returns it only if something remains. Otherwise it returns nothing.

**Call relations**: app_declarations_from_file calls this while building each AppDeclaration.


##### `plugin_telemetry_metadata_from_root`  (lines 1087–1128)

```
async fn plugin_telemetry_metadata_from_root(
    plugin_id: &PluginId,
    plugin_root: &AbsolutePathBuf,
) -> PluginTelemetryMetadata
```

**Purpose**: Builds lightweight telemetry information for a plugin folder. Telemetry here means summary data about capabilities, not the full loaded plugin.

**Data flow**: It receives a plugin id and plugin root. It reads the manifest, checks whether skills exist, gathers MCP server names, gathers app connector ids, and returns a PluginTelemetryMetadata summary. If the manifest is missing, it falls back to metadata made only from the plugin id.

**Call relations**: installed_plugin_telemetry_metadata calls this for installed plugins, and install_resolved_plugin uses it after installing a plugin.

*Call graph*: calls 9 internal fn (load_apps_from_paths, load_mcp_servers_from_file, plugin_app_config_paths, plugin_mcp_config_paths, plugin_skill_roots, load_plugin_manifest, from_plugin_id, as_key, as_path); called by 2 (installed_plugin_telemetry_metadata, install_resolved_plugin); 3 external calls (new, app_connector_ids_from_declarations, clone).


##### `load_plugin_mcp_servers`  (lines 1130–1147)

```
async fn load_plugin_mcp_servers(
    plugin_root: &Path,
    auth_mode: Option<AuthMode>,
) -> HashMap<String, McpServerConfig>
```

**Purpose**: Loads declared MCP servers for a plugin and applies app-based routing rules when those rules are available. Routing rules can adjust which app connector paths are active for the current authentication mode.

**Data flow**: It receives a plugin root and optional authentication mode. It loads declared MCP server configs, then, if app routing is available and servers exist, loads app declarations and applies the routing policy. It returns the final server map.

**Call relations**: Plugin detail readers call this when they need MCP server information with runtime app routing policy applied. It delegates basic server parsing to load_declared_plugin_mcp_servers.

*Call graph*: calls 4 internal fn (apply_app_mcp_routing_policy, apps_route_available, load_declared_plugin_mcp_servers, load_plugin_apps); called by 1 (read_plugin_detail_for_marketplace_plugin).


##### `load_declared_plugin_mcp_servers`  (lines 1149–1163)

```
async fn load_declared_plugin_mcp_servers(plugin_root: &Path) -> HashMap<String, McpServerConfig>
```

**Purpose**: Loads MCP server definitions exactly as declared by a plugin, without auth-dependent app routing. It reads the manifest first so it knows which config paths to use.

**Data flow**: It receives a plugin root. If the manifest is missing, it returns an empty map. Otherwise it reads each MCP config file and inserts the first definition for each server name into the result map.

**Call relations**: load_plugin_mcp_servers calls this before applying app routing policy.

*Call graph*: calls 3 internal fn (load_mcp_servers_from_file, plugin_mcp_config_paths, load_plugin_manifest); called by 1 (load_plugin_mcp_servers); 1 external calls (new).


##### `installed_plugin_telemetry_metadata`  (lines 1165–1181)

```
async fn installed_plugin_telemetry_metadata(
    codex_home: &Path,
    plugin_id: &PluginId,
) -> PluginTelemetryMetadata
```

**Purpose**: Builds telemetry metadata for an already installed plugin. It gracefully falls back to plugin-id-only metadata if the store cannot be opened or the plugin is not installed.

**Data flow**: It receives Codex home and a plugin id. It opens the plugin store, finds the active plugin root, then asks plugin_telemetry_metadata_from_root to inspect that folder. It returns the metadata summary.

**Call relations**: emit_plugin_toggle_events and uninstall_plugin_id call this when they need capability summary data for plugin lifecycle events.

*Call graph*: calls 3 internal fn (plugin_telemetry_metadata_from_root, try_new, from_plugin_id); called by 2 (emit_plugin_toggle_events, uninstall_plugin_id); 2 external calls (to_path_buf, warn!).


##### `load_mcp_servers_from_file`  (lines 1183–1213)

```
async fn load_mcp_servers_from_file(
    plugin_root: &Path,
    mcp_config_path: &AbsolutePathBuf,
) -> PluginMcpDiscovery
```

**Purpose**: Reads and parses one plugin MCP config file. It turns the file’s server definitions into runtime server config objects and logs parse problems.

**Data flow**: It receives the plugin root and MCP config path. It reads the file asynchronously, parses it with the plugin MCP parser, logs any file-level or server-level parse errors, and returns a discovery object containing the valid servers. If reading or parsing fails, it returns an empty discovery.

**Call relations**: load_plugin, load_declared_plugin_mcp_servers, and plugin_telemetry_metadata_from_root call this whenever they need MCP server definitions from a plugin file.

*Call graph*: calls 1 internal fn (as_path); called by 3 (load_declared_plugin_mcp_servers, load_plugin, plugin_telemetry_metadata_from_root); 4 external calls (parse_plugin_mcp_config, default, read_to_string, warn!).


##### `materialize_marketplace_plugin_source`  (lines 1226–1279)

```
fn materialize_marketplace_plugin_source(
    codex_home: &Path,
    source: &MarketplacePluginSource,
) -> Result<MaterializedMarketplacePluginSource, String>
```

**Purpose**: Turns a marketplace plugin source into a local directory path that can be installed. Local sources are used directly; git sources are cloned into a temporary staging folder.

**Data flow**: It receives Codex home and a marketplace source. For a local source, it returns that path. For a git source, it creates a staging temp directory, clones the repository, optionally checks out a ref or SHA and subpath, and returns the resulting path while keeping the temp directory alive.

**Call relations**: refresh_non_curated_plugin_cache_with_mode calls this before reading a plugin version and installing a marketplace plugin into the cache.

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

**Purpose**: Clones a git-based plugin source into a destination folder. It supports sparse checkout, which means downloading only a selected subfolder when the plugin lives inside a larger repository.

**Data flow**: It receives a git URL, optional ref name, optional SHA, optional sparse path, and destination. It runs the needed git commands to clone, configure sparse checkout if requested, and check out the target commit or branch. It returns success or an error string.

**Call relations**: materialize_marketplace_plugin_source calls this when a marketplace plugin source is a git repository. It uses run_git for each actual git command.

*Call graph*: calls 1 internal fn (run_git); called by 1 (materialize_marketplace_plugin_source); 1 external calls (to_string_lossy).


##### `run_git`  (lines 1324–1346)

```
fn run_git(args: &[&str], cwd: Option<&Path>) -> Result<(), String>
```

**Purpose**: Runs one git command and converts failure output into a readable error message. It also disables interactive terminal prompts so background operations do not hang waiting for user input.

**Data flow**: It receives git arguments and an optional working directory. It starts the git process with those arguments, captures stdout and stderr, and returns success only if git exits successfully. On failure it returns a message containing the command, status, stdout, and stderr.

**Call relations**: clone_git_plugin_source uses this for clone, sparse-checkout, and checkout commands.

*Call graph*: called by 1 (clone_git_plugin_source); 2 external calls (new, format!).


### `core-plugins/src/manager.rs`

`orchestration` · `startup, plugin listing, plugin loading, install/uninstall, background refresh`

Plugins can come from local configuration, Git-based marketplaces, OpenAI-curated catalogs, and remote ChatGPT-backed services. This file gives the rest of the system one front desk for all of that. Without it, each caller would need to know where plugin lists live, how installed plugin bundles are cached, when remote state should be refreshed, and how authentication changes affect visible plugin features.

The main type is `PluginsManager`. Think of it like a librarian for plugins: it knows the shelves, remembers what was recently looked up, asks remote catalogs for updates, and checks whether a plugin is allowed for the current product. It loads enabled plugins from the configuration stack, combines them with remote-installed plugins when that feature is on, and then filters app and MCP server capabilities based on the current authentication mode. MCP means “Model Context Protocol,” a way for plugins to expose tools or services to the model.

The manager also handles user actions. Installing a plugin finds it in a marketplace, copies or materializes its source into the local plugin store, enables it in user config, and records analytics. Uninstalling reverses that. Listing and reading marketplace entries adds installed/enabled state and, when possible, reads a plugin’s manifest, skills, hooks, app connectors, and MCP servers. Several background refresh loops keep curated repositories, non-curated caches, remote installed plugins, and remote catalogs up to date without blocking the main user flow.

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

**Purpose**: Builds the small bundle of settings the plugin manager needs for one run or request. It keeps the configuration layers, feature switches, and ChatGPT service address together.

**Data flow**: It receives a config layer stack, two booleans saying whether plugins and remote plugins are enabled, and a base URL. It stores those values unchanged in a `PluginsConfigInput` object and returns it.

**Call relations**: Configuration-loading helpers call this when they need to pass plugin settings into the manager as one clear package.

*Call graph*: called by 2 (load_plugins_config, plugins_config_input).


##### `remote_plugin_service_config`  (lines 201–205)

```
fn remote_plugin_service_config(config: &PluginsConfigInput) -> RemotePluginServiceConfig
```

**Purpose**: Turns the broader plugin configuration into the smaller remote-service configuration used for network calls. This avoids repeating how the ChatGPT base URL is picked.

**Data flow**: It reads the ChatGPT base URL from `PluginsConfigInput`, copies it into a `RemotePluginServiceConfig`, and returns that lightweight object.

**Call relations**: Remote-facing manager methods call this just before they fetch catalogs, sync installed plugins, or send install/uninstall mutations to the backend.

*Call graph*: called by 9 (build_and_cache_remote_installed_plugin_marketplaces, cached_global_remote_discoverable_plugins_for_config, featured_plugin_ids_for_config, install_plugin_with_remote_sync, maybe_start_global_remote_catalog_cache_refresh, maybe_start_plugin_startup_tasks_for_config, maybe_start_remote_installed_plugin_bundle_sync, maybe_start_remote_installed_plugins_cache_refresh_with_notify, uninstall_plugin_with_remote_sync).


##### `featured_plugin_ids_cache_key`  (lines 207–217)

```
fn featured_plugin_ids_cache_key(
    config: &PluginsConfigInput,
    auth: Option<&CodexAuth>,
) -> FeaturedPluginIdsCacheKey
```

**Purpose**: Creates the identity for cached featured-plugin results. Featured plugins can differ by server, account, user, and workspace status, so the cache key includes all of those.

**Data flow**: It takes the current plugin config and optional authentication. It copies the base URL and, when available, extracts account ID, ChatGPT user ID, and workspace-account status, then returns a key object.

**Call relations**: `featured_plugin_ids_for_config` uses this before checking or writing the featured-plugin cache so one user’s featured list is not reused for the wrong context.

*Call graph*: called by 1 (featured_plugin_ids_for_config).


##### `recommended_plugins_cache_key`  (lines 219–223)

```
fn recommended_plugins_cache_key(config: &PluginsConfigInput) -> RecommendedPluginsCacheKey
```

**Purpose**: Creates the identity for cached recommended-plugin mode results. In this file, that cache is separated by ChatGPT base URL.

**Data flow**: It reads the base URL from `PluginsConfigInput`, places it in a cache-key object, and returns it.

**Call relations**: `recommended_plugins_mode_for_config` uses this key to share one in-flight or completed remote lookup for the same service endpoint.

*Call graph*: called by 1 (recommended_plugins_mode_for_config).


##### `PluginCapabilitySummary::from`  (lines 313–327)

```
fn from(value: PluginDetail) -> Self
```

**Purpose**: Converts detailed marketplace information into a short capability summary safe to show to the model or prompt-building code. It keeps only the plugin name, safe description, and exposed capability names.

**Data flow**: It receives a full `PluginDetail`, checks whether it has any non-disabled skills, sanitizes the description for prompt use, and returns a `PluginCapabilitySummary` with skill, MCP server, and app connector information.

**Call relations**: This conversion is used when a detailed plugin record needs to become a compact capability record. It delegates description cleanup to `prompt_safe_plugin_description`.

*Call graph*: 1 external calls (prompt_safe_plugin_description).


##### `PluginsManager::new`  (lines 370–372)

```
fn new(codex_home: PathBuf) -> Self
```

**Purpose**: Creates a normal plugin manager for a Codex home directory. This is the simple constructor most callers use.

**Data flow**: It receives the path to `CODEX_HOME`, then calls the more flexible constructor with Codex product restrictions and no initial authentication mode. The result is a ready-to-use manager.

**Call relations**: Command handlers, login/logout flows, migration checks, and plugin commands call this when they need access to plugin operations without special test options.

*Call graph*: called by 84 (detect_migrations, import_plugins, run_list, run_upgrade, run_get, run_list, run_login, run_logout, load_plugin_command_context, deduplicates_configured_marketplace_plugin (+15 more)); 1 external calls (new_with_options).


##### `PluginsManager::new_with_options`  (lines 374–409)

```
fn new_with_options(
        codex_home: PathBuf,
        restriction_product: Option<Product>,
        auth_mode: Option<AuthMode>,
    ) -> Self
```

**Purpose**: Creates a plugin manager with explicit product and authentication settings. This is useful for tests and for callers that need product-specific plugin restrictions.

**Data flow**: It receives a home directory, an optional product restriction, and an optional authentication mode. It creates the plugin store, initializes locks, caches, background-task state, and semaphores, then returns the manager.

**Call relations**: `PluginsManager::new` calls this for the common case, while tests and specialized loading paths call it directly to control product or auth behavior.

*Call graph*: calls 1 internal fn (new); called by 14 (featured_plugin_ids_for_config_defaults_query_param_to_codex, featured_plugin_ids_for_config_uses_restriction_product_query_param, load_plugins_from_config, plugin_auth_projection_hides_apps_without_chatgpt_auth, plugin_auth_projection_hides_dual_surface_mcp_with_agent_identity_apps_route, plugin_auth_projection_hides_matching_mcp_with_chatgpt_apps_route, plugin_auth_projection_keeps_non_conflicting_mcp_with_chatgpt_apps_route, plugin_auth_projection_preserves_duplicate_connector_declaration_names, plugin_auth_projection_reprojects_cached_plugins_when_auth_changes, plugins_manager_tracks_auth_mode (+4 more)); 9 external calls (new, clone, new, new, default, default, default, default, default).


##### `PluginsManager::set_auth_mode`  (lines 411–421)

```
fn set_auth_mode(&self, auth_mode: Option<AuthMode>) -> bool
```

**Purpose**: Updates the authentication mode remembered by the plugin manager. This matters because some app and MCP capabilities are only shown for certain login modes.

**Data flow**: It receives a new optional authentication mode, compares it with the stored one, and writes it only if it changed. It returns `true` when a change happened and `false` otherwise.

**Call relations**: Other parts of the app can call this after login state changes. Later plugin reads and loads use `auth_mode` to project the right capabilities.


##### `PluginsManager::auth_mode`  (lines 423–428)

```
fn auth_mode(&self) -> Option<AuthMode>
```

**Purpose**: Reads the manager’s current authentication mode. Callers use it to decide which plugin app or MCP capabilities should be visible.

**Data flow**: It reads the protected stored value, recovers gracefully if the lock was poisoned, and returns the optional authentication mode.

**Call relations**: `resolve_loaded_plugins_for_auth` and `read_plugin_detail_for_marketplace_plugin` call this before applying app/MCP routing rules.

*Call graph*: called by 2 (read_plugin_detail_for_marketplace_plugin, resolve_loaded_plugins_for_auth).


##### `PluginsManager::set_analytics_events_client`  (lines 430–436)

```
fn set_analytics_events_client(&self, analytics_events_client: AnalyticsEventsClient)
```

**Purpose**: Stores the analytics client used to record plugin install and uninstall events. If this is not set, those user actions still work but are not tracked here.

**Data flow**: It receives an analytics client and saves it inside the manager behind a lock. It does not return a value.

**Call relations**: Install and uninstall internals later read this stored client and send telemetry when one is available.


##### `PluginsManager::restriction_product_matches`  (lines 438–446)

```
fn restriction_product_matches(&self, products: Option<&[Product]>) -> bool
```

**Purpose**: Checks whether a plugin or marketplace entry is allowed for the current product. This prevents plugins intended for another product from being listed, read, or installed through this manager.

**Data flow**: It receives an optional list of allowed products. If there is no restriction list, it returns true; if the list is empty, false; otherwise it compares the manager’s product against the allowed list.

**Call relations**: Marketplace listing and plugin detail reading use this check before exposing a plugin to the caller.

*Call graph*: called by 2 (read_plugin_detail_for_marketplace_plugin, read_plugin_for_config).


##### `PluginsManager::plugins_for_config`  (lines 448–451)

```
async fn plugins_for_config(&self, config: &PluginsConfigInput) -> PluginLoadOutcome
```

**Purpose**: Loads the effective plugins for a given configuration using the normal cache. This is the main path for callers that need currently active plugin capabilities.

**Data flow**: It receives `PluginsConfigInput` and forwards it to the force-reload variant with force reload turned off. It returns a `PluginLoadOutcome`.

**Call relations**: MCP configuration building and hook building call this when they need the active plugin set.

*Call graph*: calls 1 internal fn (plugins_for_config_with_force_reload); called by 2 (to_mcp_config_with_plugin_registrations, build_hooks_for_config).


##### `PluginsManager::plugins_for_config_with_force_reload`  (lines 458–495)

```
async fn plugins_for_config_with_force_reload(
        &self,
        config: &PluginsConfigInput,
        force_reload: bool,
    ) -> PluginLoadOutcome
```

**Purpose**: Loads active plugins, optionally bypassing the cache. It avoids expensive reloads when the relevant configuration has not changed.

**Data flow**: It first returns an empty outcome if plugins are disabled. Otherwise it builds a cache key from configured plugins, skill rules, and remote-plugin status; tries the cache; serializes real loading with a semaphore; loads from the config layer stack and remote-installed cache; logs load errors; writes the cache if still current; and returns capabilities adjusted for auth.

**Call relations**: `plugins_for_config` uses this as the main implementation. It hands actual filesystem/config loading to loader functions and hands final auth filtering to `resolve_loaded_plugins_for_auth`.

*Call graph*: calls 10 internal fn (load_plugins_from_layer_stack, log_plugin_load_errors, cache_loaded_plugins_if_current, cached_loaded_plugins, loaded_plugins_cache_generation, remote_installed_plugin_configs, resolve_loaded_plugins_for_auth, configured_plugins_from_stack, skill_config_rules_from_stack, default); called by 1 (plugins_for_config); 2 external calls (acquire, warn!).


##### `PluginsManager::resolve_loaded_plugins_for_auth`  (lines 497–509)

```
fn resolve_loaded_plugins_for_auth(&self, mut plugins: Vec<LoadedPlugin>) -> PluginLoadOutcome
```

**Purpose**: Applies the current login-mode rules to already loaded plugins. This makes sure app connectors and MCP servers line up with whether the user is authenticated in the needed way.

**Data flow**: It receives loaded plugins, reads the current auth mode, applies routing policy to each plugin’s apps and MCP servers, and converts the adjusted list into a `PluginLoadOutcome`.

**Call relations**: Both cached and freshly loaded plugin paths call this just before returning plugin capabilities to the rest of the system.

*Call graph*: calls 3 internal fn (apply_app_mcp_routing_policy, auth_mode, from_plugins); called by 2 (plugins_for_config_with_force_reload, plugins_for_layer_stack).


##### `PluginsManager::clear_cache`  (lines 511–518)

```
fn clear_cache(&self)
```

**Purpose**: Clears the manager’s main plugin-related caches. This is used when plugin files, marketplaces, or curated data may have changed.

**Data flow**: It invalidates the loaded-plugin cache and removes the cached featured-plugin IDs. It does not return a value.

**Call relations**: Cache refresh and marketplace-upgrade flows call this after changes so later plugin loads see fresh data.

*Call graph*: calls 1 internal fn (clear_loaded_plugins_cache); called by 2 (run_non_curated_plugin_cache_refresh_loop, upgrade_configured_marketplaces_for_config).


##### `PluginsManager::clear_recommended_plugins_cache`  (lines 520–531)

```
fn clear_recommended_plugins_cache(&self)
```

**Purpose**: Clears cached recommended-plugin mode information and any remembered in-flight refresh markers. This forces the next request to ask again.

**Data flow**: It locks and empties the map of in-flight recommendation lookups, then locks and empties the completed recommendation cache. Nothing is returned.

**Call relations**: This is a maintenance hook for callers that know recommendation state should be recomputed.


##### `PluginsManager::clear_loaded_plugins_cache`  (lines 533–540)

```
fn clear_loaded_plugins_cache(&self)
```

**Purpose**: Invalidates the cached active plugin list. It also bumps a generation number so an older load cannot overwrite a newer invalidation.

**Data flow**: It takes the cache write lock, increments the generation counter with wrapping arithmetic, and removes the cached entry.

**Call relations**: Higher-level cache clearing and remote-installed cache updates call this when effective plugins may have changed.

*Call graph*: called by 3 (clear_cache, clear_remote_installed_plugins_cache, write_remote_installed_plugins_cache).


##### `PluginsManager::plugins_for_layer_stack`  (lines 543–560)

```
async fn plugins_for_layer_stack(
        &self,
        config_layer_stack: &ConfigLayerStack,
        config: &PluginsConfigInput,
    ) -> PluginLoadOutcome
```

**Purpose**: Loads plugins for a supplied configuration layer stack without using or changing the manager’s loaded-plugin cache. This is useful for temporary or alternate config views.

**Data flow**: It returns an empty outcome if plugins are disabled. Otherwise it loads plugins from the provided layer stack plus remote-installed config, then applies auth-based capability filtering and returns the outcome.

**Call relations**: `effective_skill_roots_for_layer_stack` calls this when it only needs skill roots, and callers can use it when cache isolation matters.

*Call graph*: calls 4 internal fn (load_plugins_from_layer_stack, remote_installed_plugin_configs, resolve_loaded_plugins_for_auth, default); called by 1 (effective_skill_roots_for_layer_stack).


##### `PluginsManager::plugin_hooks_for_layer_stack`  (lines 563–578)

```
async fn plugin_hooks_for_layer_stack(
        &self,
        config_layer_stack: &ConfigLayerStack,
        config: &PluginsConfigInput,
    ) -> PluginHookLoadOutcome
```

**Purpose**: Loads only plugin hooks for a supplied configuration layer stack. Hooks are plugin-declared actions triggered by named events.

**Data flow**: It returns an empty hook outcome if plugins are disabled. Otherwise it asks the loader for hooks using the supplied layer stack, remote-installed configs, the store, and the remote-plugin feature flag.

**Call relations**: This is a lighter-weight path than full plugin loading when the caller only needs hook declarations.

*Call graph*: calls 2 internal fn (load_plugin_hooks_from_layer_stack, remote_installed_plugin_configs); 1 external calls (default).


##### `PluginsManager::effective_skill_roots_for_layer_stack`  (lines 581–589)

```
async fn effective_skill_roots_for_layer_stack(
        &self,
        config_layer_stack: &ConfigLayerStack,
        config: &PluginsConfigInput,
    ) -> Vec<PluginSkillRoot>
```

**Purpose**: Returns the skill root directories that are active for a supplied configuration layer stack. Skills are plugin-provided instruction or capability files.

**Data flow**: It loads plugins through `plugins_for_layer_stack`, then extracts the effective skill roots from the resulting load outcome.

**Call relations**: It builds directly on the uncached layer-stack loading path so callers get skill roots for exactly the stack they supplied.

*Call graph*: calls 1 internal fn (plugins_for_layer_stack).


##### `PluginsManager::cached_loaded_plugins`  (lines 591–605)

```
fn cached_loaded_plugins(&self, key: &PluginLoadCacheKey) -> Option<Vec<LoadedPlugin>>
```

**Purpose**: Looks for a cached active-plugin list that matches the requested loading conditions. It prevents repeated disk and config work.

**Data flow**: It reads the loaded-plugin cache, compares the stored key with the requested key, and returns a cloned plugin list only when they match.

**Call relations**: `plugins_for_config_with_force_reload` checks this before and after waiting for the load semaphore.

*Call graph*: called by 1 (plugins_for_config_with_force_reload).


##### `PluginsManager::loaded_plugins_cache_generation`  (lines 607–612)

```
fn loaded_plugins_cache_generation(&self) -> u64
```

**Purpose**: Reads the current loaded-plugin cache generation. The generation is a simple version stamp used to avoid writing stale load results.

**Data flow**: It reads the cache state and returns its generation number.

**Call relations**: `plugins_for_config_with_force_reload` records this before doing a real load, then `cache_loaded_plugins_if_current` checks it afterward.

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

**Purpose**: Writes freshly loaded plugins into the cache only if no invalidation happened while loading. This avoids reintroducing old data after a cache clear.

**Data flow**: It receives the generation seen before loading, a cache key, and the loaded plugin list. If the current generation is unchanged, it stores the key and plugins; otherwise it discards them.

**Call relations**: `plugins_for_config_with_force_reload` calls this after loading from the layer stack.

*Call graph*: called by 1 (plugins_for_config_with_force_reload).


##### `PluginsManager::remote_installed_plugin_configs`  (lines 629–639)

```
fn remote_installed_plugin_configs(&self) -> HashMap<String, PluginConfig>
```

**Purpose**: Converts the cached remote-installed plugin list into local plugin configuration entries. This lets remote-installed plugins participate in the same loading path as locally configured plugins.

**Data flow**: It reads the remote-installed cache. If it is empty, it returns an empty map; otherwise it asks the remote helper to translate those plugins into `PluginConfig` values using the local store.

**Call relations**: Plugin and hook loading paths call this before invoking the loader so remote-installed plugins can be included when enabled.

*Call graph*: calls 1 internal fn (remote_installed_plugins_to_config); called by 3 (plugin_hooks_for_layer_stack, plugins_for_config_with_force_reload, plugins_for_layer_stack); 1 external calls (new).


##### `PluginsManager::build_remote_installed_plugin_marketplaces_from_cache`  (lines 641–656)

```
fn build_remote_installed_plugin_marketplaces_from_cache(
        &self,
        visible_marketplaces: &[&str],
    ) -> Option<Vec<crate::remote::RemoteMarketplace>>
```

**Purpose**: Builds marketplace-shaped data from the cached remote-installed plugins. This is a quick read path that avoids a network request.

**Data flow**: It reads the remote-installed cache. If no cache exists, it returns `None`; otherwise it groups the cached plugins by visible marketplaces and returns that list.

**Call relations**: Callers that already trust the local remote-installed cache can use this instead of fetching fresh remote state.

*Call graph*: calls 1 internal fn (group_remote_installed_plugins_by_marketplaces).


##### `PluginsManager::cached_global_remote_discoverable_plugins_for_config`  (lines 658–681)

```
fn cached_global_remote_discoverable_plugins_for_config(
        &self,
        config: &PluginsConfigInput,
        auth: Option<&CodexAuth>,
    ) -> Vec<crate::remote::RemoteDiscoverablePlugin>
```

**Purpose**: Reads discoverable remote plugins from the global on-disk cache when the current config and auth allow it. Discoverable plugins are remote plugins the user may be able to browse or add.

**Data flow**: It first checks that plugins and remote plugins are enabled, that the auth uses the Codex backend, and that an account ID exists. If any check fails it returns an empty list; otherwise it reads cached remote discoverable plugins for the service config.

**Call relations**: This is a cache-only companion to background catalog refresh tasks, letting UI or listing code show what is already warmed.

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

**Purpose**: Fetches the user’s remote-installed plugins, saves them locally, and returns them grouped as marketplaces. It also notifies the app when the effective plugin set changed.

**Data flow**: It receives config, auth, visible marketplace names, and an optional callback. It fetches remote installed plugins, groups them by marketplace, writes the cache, calls the callback if the cache changed, and returns the grouped marketplaces or an error.

**Call relations**: This is the direct refresh-and-return path for callers that need fresh remote installed marketplace data immediately.

*Call graph*: calls 4 internal fn (write_remote_installed_plugins_cache, remote_plugin_service_config, fetch_remote_installed_plugins, group_remote_installed_plugins_by_marketplaces).


##### `PluginsManager::write_remote_installed_plugins_cache`  (lines 706–718)

```
fn write_remote_installed_plugins_cache(&self, plugins: Vec<RemoteInstalledPlugin>) -> bool
```

**Purpose**: Stores a newly fetched remote-installed plugin list if it differs from the current cache. Changing this cache can change which plugins load locally.

**Data flow**: It compares the incoming plugin list with the cached one. If identical, it returns false; if different, it replaces the cache, clears the loaded-plugin cache, and returns true.

**Call relations**: Immediate remote fetches and the background remote-installed refresh loop call this after successful remote reads.

*Call graph*: calls 1 internal fn (clear_loaded_plugins_cache); called by 2 (build_and_cache_remote_installed_plugin_marketplaces, run_remote_installed_plugins_cache_refresh_loop).


##### `PluginsManager::clear_remote_installed_plugins_cache`  (lines 720–732)

```
fn clear_remote_installed_plugins_cache(&self) -> bool
```

**Purpose**: Removes cached remote-installed plugin state. This is needed when authentication no longer allows reading remote plugins.

**Data flow**: It checks whether the cache exists. If not, it returns false; otherwise it clears the cache, invalidates loaded plugins, and returns true.

**Call relations**: The remote-installed refresh loop calls this when the backend says auth is required or unsupported.

*Call graph*: calls 1 internal fn (clear_loaded_plugins_cache); called by 1 (run_remote_installed_plugins_cache_refresh_loop).


##### `PluginsManager::maybe_start_remote_plugin_caches_refresh`  (lines 734–754)

```
fn maybe_start_remote_plugin_caches_refresh(
        self: &Arc<Self>,
        config: &PluginsConfigInput,
        auth: Option<CodexAuth>,
        on_effective_plugins_changed: Option<Arc<dyn Fn() +
```

**Purpose**: Starts background refreshes for remote plugin state when plugins are enabled. It refreshes installed plugins and also warms the recommended-plugin mode.

**Data flow**: It schedules a remote-installed cache refresh, then spawns an asynchronous task that asks for recommended-plugin mode. It returns immediately.

**Call relations**: `maybe_start_plugin_list_background_tasks_for_config` and startup flows use this so remote state updates happen behind the scenes.

*Call graph*: calls 1 internal fn (maybe_start_remote_installed_plugins_cache_refresh_with_notify); called by 1 (maybe_start_plugin_list_background_tasks_for_config); 3 external calls (clone, clone, spawn).


##### `PluginsManager::maybe_start_remote_installed_plugins_cache_refresh_after_mutation`  (lines 756–768)

```
fn maybe_start_remote_installed_plugins_cache_refresh_after_mutation(
        self: &Arc<Self>,
        config: &PluginsConfigInput,
        auth: Option<CodexAuth>,
        on_effective_plugins_chang
```

**Purpose**: Schedules a remote-installed cache refresh after a remote install or uninstall mutation. It asks the refresh path to notify after any successful refresh, even if the installed list looks unchanged.

**Data flow**: It wraps the config, auth, notification mode, and optional callback and forwards them to the shared scheduling helper.

**Call relations**: Bundle-sync callbacks use this after local or remote mutation work so MCP refreshes happen after the installed cache is updated.

*Call graph*: calls 1 internal fn (maybe_start_remote_installed_plugins_cache_refresh_with_notify).


##### `PluginsManager::maybe_start_remote_installed_plugins_cache_refresh_with_notify`  (lines 770–789)

```
fn maybe_start_remote_installed_plugins_cache_refresh_with_notify(
        self: &Arc<Self>,
        config: &PluginsConfigInput,
        auth: Option<CodexAuth>,
        notify: RemoteInstalledPlugin
```

**Purpose**: Shared helper for scheduling remote-installed plugin cache refreshes with a chosen notification rule. It skips all work if plugins are disabled.

**Data flow**: It checks the plugin feature flag, builds a remote service config, packages auth and callback information into a refresh request, and hands it to the scheduler.

**Call relations**: Both normal remote cache warming and after-mutation refreshes pass through this method.

*Call graph*: calls 2 internal fn (schedule_remote_installed_plugins_cache_refresh, remote_plugin_service_config); called by 2 (maybe_start_remote_installed_plugins_cache_refresh_after_mutation, maybe_start_remote_plugin_caches_refresh).


##### `PluginsManager::maybe_start_remote_installed_plugin_bundle_sync`  (lines 791–818)

```
fn maybe_start_remote_installed_plugin_bundle_sync(
        self: &Arc<Self>,
        config: &PluginsConfigInput,
        auth: Option<CodexAuth>,
        on_effective_plugins_changed: Option<Arc<dyn
```

**Purpose**: Starts background synchronization of local bundles for plugins installed remotely. A bundle is the local copy needed to run a remote-installed plugin.

**Data flow**: If plugins are disabled, it returns. Otherwise it builds a callback that will refresh the remote-installed cache after local bundle changes, then asks the remote module to start bundle sync.

**Call relations**: Plugin-list background tasks and startup tasks call this so remote-installed plugins have usable local files.

*Call graph*: calls 1 internal fn (remote_plugin_service_config); called by 1 (maybe_start_plugin_list_background_tasks_for_config); 5 external calls (clone, new, clone, clone, maybe_start_remote_installed_plugin_bundle_sync).


##### `PluginsManager::maybe_start_global_remote_catalog_cache_refresh`  (lines 820–833)

```
fn maybe_start_global_remote_catalog_cache_refresh(
        self: &Arc<Self>,
        config: &PluginsConfigInput,
        auth: Option<CodexAuth>,
    )
```

**Purpose**: Schedules a background refresh of the global remote plugin catalog. It only runs when both plugins and remote plugins are enabled.

**Data flow**: It checks feature flags, builds a service config with auth, and submits a global catalog refresh request to the scheduler.

**Call relations**: Plugin-list background tasks call this when their options request a global remote catalog refresh.

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

**Purpose**: Kicks off the background jobs that make plugin listing fresher over time. It does not wait for those jobs to finish.

**Data flow**: It receives config, auth, marketplace roots, options, and a callback. It schedules non-curated cache refresh, maybe global remote catalog refresh, remote plugin cache refresh, and remote bundle sync.

**Call relations**: Listing code can call this after returning or while preparing plugin lists so caches are warmed for later requests.

*Call graph*: calls 4 internal fn (maybe_start_global_remote_catalog_cache_refresh, maybe_start_non_curated_plugin_cache_refresh, maybe_start_remote_installed_plugin_bundle_sync, maybe_start_remote_plugin_caches_refresh).


##### `PluginsManager::cached_featured_plugin_ids`  (lines 859–889)

```
fn cached_featured_plugin_ids(
        &self,
        cache_key: &FeaturedPluginIdsCacheKey,
    ) -> Option<Vec<String>>
```

**Purpose**: Reads featured-plugin IDs from the short-lived in-memory cache. It also clears expired or wrong-context entries.

**Data flow**: It checks the cached entry against the supplied key and expiration time. If valid, it returns a cloned list; otherwise it removes stale data and returns `None`.

**Call relations**: `featured_plugin_ids_for_config` calls this before making a remote featured-plugin request.

*Call graph*: called by 1 (featured_plugin_ids_for_config); 1 external calls (now).


##### `PluginsManager::write_featured_plugin_ids_cache`  (lines 891–905)

```
fn write_featured_plugin_ids_cache(
        &self,
        cache_key: FeaturedPluginIdsCacheKey,
        featured_plugin_ids: &[String],
    )
```

**Purpose**: Stores featured-plugin IDs in memory with an expiration time. This reduces repeated network calls for the same user and server.

**Data flow**: It receives a cache key and list of IDs, copies the IDs, sets an expiry three hours in the future, and writes the cache entry.

**Call relations**: `featured_plugin_ids_for_config` calls this after successfully fetching featured IDs from the remote legacy service.

*Call graph*: called by 1 (featured_plugin_ids_for_config); 1 external calls (now).


##### `PluginsManager::featured_plugin_ids_for_config`  (lines 907–928)

```
async fn featured_plugin_ids_for_config(
        &self,
        config: &PluginsConfigInput,
        auth: Option<&CodexAuth>,
    ) -> Result<Vec<String>, RemotePluginFetchError>
```

**Purpose**: Returns the plugin IDs that should be featured for the current config and auth. It uses a cache first and falls back to a remote request.

**Data flow**: If plugins are disabled it returns an empty list. Otherwise it builds a cache key, returns cached IDs when available, fetches remote featured IDs when not, writes them to cache, and returns them.

**Call relations**: Startup warming and callers that need featured plugin ordering use this path.

*Call graph*: calls 5 internal fn (cached_featured_plugin_ids, write_featured_plugin_ids_cache, featured_plugin_ids_cache_key, remote_plugin_service_config, fetch_remote_featured_plugin_ids); 1 external calls (new).


##### `PluginsManager::recommended_plugins_mode_for_config`  (lines 930–998)

```
async fn recommended_plugins_mode_for_config(
        &self,
        config: &PluginsConfigInput,
        auth: Option<&CodexAuth>,
    ) -> RecommendedPluginsMode
```

**Purpose**: Determines whether the app should use the newer remote recommended-plugin behavior or the legacy behavior. It coalesces simultaneous requests so only one remote fetch happens per key.

**Data flow**: It returns legacy mode if plugins, remote plugins, or suitable auth are missing. Otherwise it checks the cache, joins or creates an in-flight `OnceCell` refresh, fetches the mode from the remote service, stores successful results, falls back to legacy on error, removes the in-flight marker, and returns the mode.

**Call relations**: Remote cache warming calls this in the background, while UI or plugin listing code can call it directly when deciding how recommendations should work.

*Call graph*: calls 2 internal fn (cached_recommended_plugins_mode, recommended_plugins_cache_key).


##### `PluginsManager::cached_recommended_plugins_mode`  (lines 1000–1009)

```
fn cached_recommended_plugins_mode(
        &self,
        cache_key: &RecommendedPluginsCacheKey,
    ) -> Option<RecommendedPluginsMode>
```

**Purpose**: Reads a cached recommended-plugin mode for a service endpoint. It is the simple lookup used by the fuller refresh method.

**Data flow**: It locks the recommendation cache, looks up the supplied key, clones the stored mode if present, and returns it.

**Call relations**: `recommended_plugins_mode_for_config` calls this before and during refresh setup to avoid unnecessary remote work.

*Call graph*: called by 1 (recommended_plugins_mode_for_config).


##### `PluginsManager::install_plugin`  (lines 1011–1021)

```
async fn install_plugin(
        &self,
        request: PluginInstallRequest,
    ) -> Result<PluginInstallOutcome, PluginInstallError>
```

**Purpose**: Installs a plugin from a marketplace without doing a remote backend mutation first. This is the local install path.

**Data flow**: It receives a marketplace path and plugin name, resolves that marketplace entry as installable under the product restriction, then passes the resolved plugin to the shared install routine.

**Call relations**: Command and UI install flows use this when local marketplace installation is enough.

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

**Purpose**: Installs a plugin while first telling the legacy remote service to enable it. This keeps older remote plugin state in sync with local installation.

**Data flow**: It resolves the plugin from the marketplace, sends an enable mutation to the remote legacy service using config and auth, then installs the resolved plugin locally through the shared install routine.

**Call relations**: Remote-aware install flows use this when the backend must be updated before local files and config are changed.

*Call graph*: calls 4 internal fn (install_resolved_plugin, remote_plugin_service_config, find_installable_marketplace_plugin, enable_remote_plugin).


##### `PluginsManager::install_resolved_plugin`  (lines 1046–1104)

```
async fn install_resolved_plugin(
        &self,
        resolved: ResolvedMarketplacePlugin,
    ) -> Result<PluginInstallOutcome, PluginInstallError>
```

**Purpose**: Performs the actual local install once a marketplace plugin has already been resolved. It copies or materializes plugin source, records version information, enables the plugin, and sends analytics.

**Data flow**: It receives a resolved marketplace plugin. For curated OpenAI plugins it reads the curated repository version; then it runs blocking store installation off the async runtime, enables the plugin in user config, optionally tracks telemetry, and returns the installed plugin ID, version, path, and auth policy.

**Call relations**: Both public install methods delegate here after marketplace resolution and any optional remote mutation.

*Call graph*: calls 3 internal fn (curated_plugin_cache_version, plugin_telemetry_metadata_from_root, read_curated_plugins_sha); called by 2 (install_plugin, install_plugin_with_remote_sync); 6 external calls (as_path, clone, set_user_plugin_enabled, clone, is_openai_curated_marketplace_name, spawn_blocking).


##### `PluginsManager::uninstall_plugin`  (lines 1106–1109)

```
async fn uninstall_plugin(&self, plugin_id: String) -> Result<(), PluginUninstallError>
```

**Purpose**: Uninstalls a plugin by its string ID using only local state. It parses the ID before doing the shared uninstall work.

**Data flow**: It receives a plugin ID string, parses it into a structured `PluginId`, then calls `uninstall_plugin_id`. It returns success or an uninstall error.

**Call relations**: Local uninstall flows call this when no remote backend mutation is needed.

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

**Purpose**: Uninstalls a plugin while first telling the legacy remote service to remove it. This keeps backend state aligned with local removal.

**Data flow**: It parses the plugin ID string, sends an uninstall mutation to the remote legacy service using config and auth, then calls the shared local uninstall routine.

**Call relations**: Remote-aware uninstall flows use this path until remote plugins have a separate installed-state manager.

*Call graph*: calls 4 internal fn (uninstall_plugin_id, remote_plugin_service_config, uninstall_remote_plugin, parse).


##### `PluginsManager::uninstall_plugin_id`  (lines 1132–1159)

```
async fn uninstall_plugin_id(&self, plugin_id: PluginId) -> Result<(), PluginUninstallError>
```

**Purpose**: Performs the actual local uninstall for a parsed plugin ID. It removes plugin files, clears user config, and optionally records analytics.

**Data flow**: It checks whether an active plugin root exists and gathers telemetry if so. It runs the blocking store uninstall on a blocking task, clears the plugin from user config, sends uninstall analytics when possible, and returns success.

**Call relations**: Both public uninstall methods call this after parsing and any optional remote mutation.

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

**Purpose**: Lists configured marketplaces and their plugins with installed and enabled state added. It is the main marketplace listing view for local and curated sources.

**Data flow**: If plugins are disabled it returns an empty outcome. Otherwise it gathers configured plugin states, computes marketplace roots, reads marketplaces, removes duplicate plugin keys, filters by product restriction, fills in installed version and manifest details when available, and returns marketplaces plus any listing errors.

**Call relations**: Higher-level marketplace lookup and verification helpers call this when they need a complete configured marketplace view.

*Call graph*: calls 3 internal fn (configured_plugin_states, marketplace_roots, list_marketplaces); called by 3 (configured_marketplace_plugins, find_marketplace_for_plugin, verified_plugin_install_completed); 2 external calls (new, default).


##### `PluginsManager::discover_marketplaces_for_config`  (lines 1252–1266)

```
fn discover_marketplaces_for_config(
        &self,
        config: &PluginsConfigInput,
        additional_roots: &[AbsolutePathBuf],
    ) -> Result<MarketplaceListOutcome, MarketplaceError>
```

**Purpose**: Discovers marketplace files or roots available for the current configuration. Unlike the richer list method, it returns the raw marketplace listing outcome.

**Data flow**: It returns an empty listing if plugins are disabled. Otherwise it computes marketplace roots including the curated marketplace and asks the marketplace module to list them.

**Call relations**: Callers use this when they need marketplace discovery rather than per-plugin installed/enabled decoration.

*Call graph*: calls 2 internal fn (marketplace_roots, list_marketplaces); 1 external calls (default).


##### `PluginsManager::read_plugin_for_config`  (lines 1268–1325)

```
async fn read_plugin_for_config(
        &self,
        config: &PluginsConfigInput,
        request: &PluginReadRequest,
    ) -> Result<PluginReadOutcome, MarketplaceError>
```

**Purpose**: Reads detailed information for one plugin from a specific marketplace. It adds local installed/enabled state before loading deeper details.

**Data flow**: It rejects the request if plugins are disabled. It finds the marketplace plugin, checks product restrictions, computes whether it is installed and enabled, builds a configured plugin record, then calls `read_plugin_detail_for_marketplace_plugin` and wraps the result with marketplace information.

**Call relations**: Plugin detail endpoints or commands call this when the user selects a specific marketplace plugin.

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

**Purpose**: Builds a full detail record for one marketplace plugin. It reads the manifest, skills, hooks, app connectors, MCP servers, and availability information when possible.

**Data flow**: It checks product restrictions and validates the plugin ID. For uninstalled Git plugins it returns a limited record explaining that installation is needed. Otherwise it finds or materializes the source directory, loads the manifest, combines marketplace category information, loads skills with config rules, loads hooks, apps, and MCP servers, applies auth routing, deduplicates and sorts capability names, and returns a `PluginDetail`.

**Call relations**: `read_plugin_for_config` calls this after locating a marketplace entry. It delegates source, manifest, skill, hook, app, and MCP reading to specialized loader functions.

*Call graph*: calls 14 internal fn (apply_app_mcp_routing_policy, load_plugin_apps, load_plugin_hooks, load_plugin_mcp_servers, load_plugin_skills, auth_mode, restriction_product_matches, remote_plugin_install_required_description, load_plugin_manifest, plugin_interface_with_marketplace_category (+4 more)); called by 1 (read_plugin_for_config); 9 external calls (new, new, clone, new, plugin_hook_declarations, app_connector_ids_from_declarations, InvalidPlugin, matches!, spawn_blocking).


##### `PluginsManager::maybe_start_plugin_startup_tasks_for_config`  (lines 1478–1591)

```
fn maybe_start_plugin_startup_tasks_for_config(
        self: &Arc<Self>,
        config: &PluginsConfigInput,
        auth_manager: Arc<AuthManager>,
        on_effective_plugins_changed: Option<Arc<
```

**Purpose**: Starts plugin-related background work at application startup. It warms caches and upgrades marketplace data without blocking startup.

**Data flow**: If plugins are enabled, it starts curated repo sync, maybe starts a single marketplace auto-upgrade thread, spawns async work to refresh remote installed state and global remote catalog, and spawns another task to warm featured-plugin IDs.

**Call relations**: Startup code calls this once the manager and authentication manager exist. It fans out to curated sync, marketplace upgrade, remote cache refresh, bundle sync, and featured-cache warming.

*Call graph*: calls 3 internal fn (start_curated_repo_sync, remote_plugin_service_config, fetch_and_cache_global_remote_plugin_catalog); 5 external calls (clone, clone, new, spawn, warn!).


##### `PluginsManager::upgrade_configured_marketplaces_for_config`  (lines 1593–1637)

```
fn upgrade_configured_marketplaces_for_config(
        &self,
        config: &PluginsConfigInput,
        marketplace_name: Option<&str>,
    ) -> Result<ConfiguredMarketplaceUpgradeOutcome, String>
```

**Purpose**: Upgrades configured Git marketplaces, optionally limited to one marketplace name. After an upgrade, it refreshes installed plugin caches so local plugin bundles match the new marketplace contents.

**Data flow**: It validates the requested marketplace name if one was provided, runs the Git marketplace upgrade helper, and if roots were upgraded, force-refreshes the non-curated plugin cache. It clears caches on refresh changes or errors and returns the upgrade outcome.

**Call relations**: Startup auto-upgrade and explicit upgrade commands use this to keep configured Git marketplace checkouts current.

*Call graph*: calls 4 internal fn (refresh_non_curated_plugin_cache_force_reinstall, clear_cache, configured_git_marketplace_names, upgrade_configured_git_marketplaces); 2 external calls (as_path, format!).


##### `PluginsManager::maybe_start_non_curated_plugin_cache_refresh`  (lines 1639–1647)

```
fn maybe_start_non_curated_plugin_cache_refresh(
        self: &Arc<Self>,
        roots: &[AbsolutePathBuf],
    )
```

**Purpose**: Schedules a background refresh for non-curated marketplace plugin caches. Non-curated means not the built-in OpenAI-curated catalog.

**Data flow**: It receives marketplace roots and forwards them to the scheduler with the normal “only if version changed” mode.

**Call relations**: Plugin-list background task setup calls this before listing-related remote refreshes.

*Call graph*: calls 1 internal fn (schedule_non_curated_plugin_cache_refresh); called by 1 (maybe_start_plugin_list_background_tasks_for_config).


##### `PluginsManager::schedule_remote_installed_plugins_cache_refresh`  (lines 1649–1689)

```
fn schedule_remote_installed_plugins_cache_refresh(
        self: &Arc<Self>,
        mut request: RemoteInstalledPluginsCacheRefreshRequest,
    )
```

**Purpose**: Queues and, if needed, starts the worker that refreshes remote-installed plugin state. It collapses repeated requests so only one worker loop is active.

**Data flow**: It merges the new request with any pending request, preserving stronger notification needs and callbacks, stores it, and starts an async worker if none is running.

**Call relations**: The remote-installed refresh helper calls this after checking feature flags and building the request.

*Call graph*: called by 1 (maybe_start_remote_installed_plugins_cache_refresh_with_notify); 3 external calls (clone, matches!, spawn).


##### `PluginsManager::schedule_global_remote_catalog_cache_refresh`  (lines 1691–1716)

```
fn schedule_global_remote_catalog_cache_refresh(
        self: &Arc<Self>,
        request: GlobalRemoteCatalogCacheRefreshRequest,
    )
```

**Purpose**: Queues and starts the worker that refreshes the global remote plugin catalog cache. It keeps at most one worker active at a time.

**Data flow**: It stores the latest catalog refresh request, checks whether a worker is already in flight, and spawns the async refresh loop only when needed.

**Call relations**: `maybe_start_global_remote_catalog_cache_refresh` calls this when list or startup work wants the global catalog warmed.

*Call graph*: called by 1 (maybe_start_global_remote_catalog_cache_refresh); 2 external calls (clone, spawn).


##### `PluginsManager::schedule_non_curated_plugin_cache_refresh`  (lines 1718–1780)

```
fn schedule_non_curated_plugin_cache_refresh(
        self: &Arc<Self>,
        roots: &[AbsolutePathBuf],
        mode: NonCuratedCacheRefreshMode,
    )
```

**Purpose**: Queues and starts a background thread to refresh non-curated plugin caches. It deduplicates repeated requests so listing does not start endless identical refreshes.

**Data flow**: It sorts and deduplicates roots, ignores empty input, builds a request, skips it if an equivalent refresh is already pending or just completed, stores it, and starts a named thread to run the refresh loop.

**Call relations**: `maybe_start_non_curated_plugin_cache_refresh` calls this for normal refreshes, while cache upgrade code can request forced reinstall mode.

*Call graph*: called by 1 (maybe_start_non_curated_plugin_cache_refresh); 7 external calls (clone, new, dedup, is_empty, sort_unstable, to_vec, warn!).


##### `PluginsManager::start_curated_repo_sync`  (lines 1782–1822)

```
fn start_curated_repo_sync(self: &Arc<Self>)
```

**Purpose**: Starts a one-at-a-time background sync of the OpenAI-curated plugin repository. This keeps the built-in curated catalog fresh.

**Data flow**: It uses a global atomic flag to avoid duplicate syncs. The thread syncs the curated repo, finds configured curated plugin IDs, refreshes their cache, clears manager caches if needed, and resets the flag on failures.

**Call relations**: Startup tasks call this when plugins are enabled.

*Call graph*: called by 1 (maybe_start_plugin_startup_tasks_for_config); 4 external calls (clone, clone, new, warn!).


##### `PluginsManager::run_remote_installed_plugins_cache_refresh_loop`  (lines 1824–1882)

```
async fn run_remote_installed_plugins_cache_refresh_loop(self: Arc<Self>)
```

**Purpose**: Worker loop that performs queued remote-installed plugin cache refreshes. It processes the latest queued request until no request remains.

**Data flow**: Each pass takes one queued request, fetches remote installed plugins, writes or clears the cache depending on success or auth errors, calls the effective-plugin callback when needed, logs other errors, and then loops for another queued request.

**Call relations**: `schedule_remote_installed_plugins_cache_refresh` spawns this loop in the background.

*Call graph*: calls 3 internal fn (clear_remote_installed_plugins_cache, write_remote_installed_plugins_cache, fetch_remote_installed_plugins); 2 external calls (matches!, warn!).


##### `PluginsManager::run_global_remote_catalog_cache_refresh_loop`  (lines 1884–1920)

```
async fn run_global_remote_catalog_cache_refresh_loop(self: Arc<Self>)
```

**Purpose**: Worker loop that refreshes the global remote plugin catalog cache. It drains queued catalog refresh requests one by one.

**Data flow**: Each pass takes a queued request, calls the remote catalog fetch-and-cache helper, ignores expected auth-mode errors, logs unexpected errors, and exits when no request remains.

**Call relations**: `schedule_global_remote_catalog_cache_refresh` spawns this loop in the background.

*Call graph*: calls 1 internal fn (fetch_and_cache_global_remote_plugin_catalog); 2 external calls (as_path, warn!).


##### `PluginsManager::run_non_curated_plugin_cache_refresh_loop`  (lines 1922–1979)

```
fn run_non_curated_plugin_cache_refresh_loop(self: Arc<Self>)
```

**Purpose**: Thread worker that refreshes non-curated plugin caches. It keeps running while newer refresh requests are queued.

**Data flow**: It reads the current request, refreshes either only changed versions or force-reinstalls depending on mode, clears manager caches when cache content changes or an error occurs, records successful refreshes, and exits when the processed request is still the latest request.

**Call relations**: `schedule_non_curated_plugin_cache_refresh` starts this thread for marketplace cache maintenance.

*Call graph*: calls 3 internal fn (refresh_non_curated_plugin_cache, refresh_non_curated_plugin_cache_force_reinstall, clear_cache); 2 external calls (as_path, warn!).


##### `PluginsManager::configured_plugin_states`  (lines 1981–2000)

```
fn configured_plugin_states(
        &self,
        config: &PluginsConfigInput,
    ) -> (HashSet<String>, HashSet<String>)
```

**Purpose**: Separates configured plugins into installed and enabled sets. This gives listing and detail code quick answers about local state.

**Data flow**: It reads configured plugins from the config stack. For each plugin key, it parses the ID and asks the store whether it is installed; it also collects keys whose config says enabled. It returns both sets.

**Call relations**: Marketplace listing and single-plugin reading call this before adding state to marketplace entries.

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

**Purpose**: Builds the complete list of marketplace roots to search. It combines caller-provided roots, configured marketplace roots, and optionally the built-in curated marketplace.

**Data flow**: It starts with additional roots, adds roots from the config layer stack, chooses the curated marketplace path based on auth mode and whether curated sources should be included, converts it to an absolute path when present, then sorts and deduplicates the result.

**Call relations**: Marketplace listing and discovery call this before asking the marketplace module to read marketplace contents.

*Call graph*: calls 4 internal fn (installed_marketplace_roots_from_layer_stack, curated_plugins_api_marketplace_path, curated_plugins_repo_path, try_from); called by 2 (discover_marketplaces_for_config, list_marketplaces_for_config); 3 external calls (as_path, matches!, to_vec).


##### `remote_plugin_install_required_description`  (lines 2044–2070)

```
fn remote_plugin_install_required_description(source: &MarketplacePluginSource) -> String
```

**Purpose**: Creates a user-facing explanation for why an uninstalled cross-repository plugin has limited details. It includes enough source information to identify where the plugin would come from.

**Data flow**: It receives a marketplace plugin source. For Git sources it formats the URL plus optional path, ref, and SHA; for local sources it formats the path. It returns a sentence saying installation is required for more detail.

**Call relations**: `read_plugin_detail_for_marketplace_plugin` uses this when a Git plugin is listed but not installed locally.

*Call graph*: called by 1 (read_plugin_detail_for_marketplace_plugin); 2 external calls (format!, vec!).


##### `PluginInstallError::join`  (lines 2091–2093)

```
fn join(source: tokio::task::JoinError) -> Self
```

**Purpose**: Wraps an async task join failure as a plugin install error. A join failure means the spawned install task itself failed to complete normally.

**Data flow**: It receives a `JoinError` from Tokio and returns the `PluginInstallError::Join` variant containing that error.

**Call relations**: The shared install routine uses this when waiting for blocking installation work to finish.

*Call graph*: 1 external calls (Join).


##### `PluginInstallError::is_invalid_request`  (lines 2095–2106)

```
fn is_invalid_request(&self) -> bool
```

**Purpose**: Tells callers whether an install error was caused by a bad user request rather than an internal or service failure. This helps choose the right response status or message.

**Data flow**: It inspects the error variant and returns true for marketplace not found, plugin not found, unavailable plugin, invalid plugin, and invalid store input cases; otherwise it returns false.

**Call relations**: Install command or API layers can call this after `install_plugin` or `install_plugin_with_remote_sync` fails.

*Call graph*: 1 external calls (matches!).


##### `PluginUninstallError::join`  (lines 2128–2130)

```
fn join(source: tokio::task::JoinError) -> Self
```

**Purpose**: Wraps an async task join failure as a plugin uninstall error. This keeps task failures in the same error type as other uninstall problems.

**Data flow**: It receives a Tokio `JoinError` and returns the `PluginUninstallError::Join` variant.

**Call relations**: The shared uninstall routine uses this when waiting for blocking store removal work.

*Call graph*: 1 external calls (Join).


##### `PluginUninstallError::is_invalid_request`  (lines 2132–2134)

```
fn is_invalid_request(&self) -> bool
```

**Purpose**: Tells callers whether an uninstall error came from an invalid plugin ID supplied by the user.

**Data flow**: It checks the error variant and returns true only for invalid plugin ID errors.

**Call relations**: Uninstall command or API layers can call this after uninstall fails to decide whether to report a bad request.

*Call graph*: 1 external calls (matches!).


##### `configured_plugins_from_stack`  (lines 2137–2145)

```
fn configured_plugins_from_stack(
    config_layer_stack: &ConfigLayerStack,
) -> HashMap<String, PluginConfig>
```

**Purpose**: Reads plugin configuration from the effective user config. Plugin entries are intentionally taken from user configuration only.

**Data flow**: It asks the config layer stack for the effective user config. If none exists, it returns an empty map; otherwise it parses the plugin entries from that TOML value.

**Call relations**: Plugin loading and configured-state calculation call this to know which plugins the user has configured.

*Call graph*: calls 2 internal fn (effective_user_config, configured_plugins_from_user_config_value); called by 2 (configured_plugin_states, plugins_for_config_with_force_reload); 1 external calls (new).


##### `configured_plugins_from_user_config_value`  (lines 2147–2160)

```
fn configured_plugins_from_user_config_value(
    user_config: &toml::Value,
) -> HashMap<String, PluginConfig>
```

**Purpose**: Parses the `plugins` section from a user config value. If the section is missing or invalid, it safely returns no configured plugins.

**Data flow**: It looks for a `plugins` key in the TOML value. If present, it tries to convert it into a map of plugin configs; on parse failure it logs a warning and returns an empty map.

**Call relations**: `configured_plugins_from_stack` calls this after it has found the effective user config value.

*Call graph*: called by 1 (configured_plugins_from_stack); 3 external calls (new, get, warn!).


### Marketplace lifecycle
These files cover adding, tracking, upgrading, and removing plugin marketplaces from local or git-backed sources.

### `core-plugins/src/marketplace_add/metadata.rs`

`domain_logic` · `marketplace add and config lookup`

When a user adds a marketplace, the system needs a small receipt: was it installed from a Git repository, or from a local folder, and which branch or sparse subfolders were used? This file creates that receipt as MarketplaceInstallMetadata and stores it in the user's config.toml file. Without it, the add flow would not know whether a marketplace had already been added, where its root folder is, or how to describe it in the user's configuration.

The file has two main jobs. First, it turns a requested marketplace source into config-friendly fields such as source_type, source, ref, and sparse_paths. It also stamps the entry with the current UTC time, like writing the date on a receipt. Second, it reads the config back and compares saved marketplace entries with the source being added. If it finds a matching entry, it resolves that entry into an actual folder path and checks that the folder really looks like a valid marketplace before returning it.

It is careful about broken or missing config files. A missing config simply means "nothing recorded yet." A config that cannot be read or parsed becomes an internal add error. The file also includes its own UTC timestamp formatter, so recorded update times are written in a standard RFC 3339-like form such as 1970-01-01T00:00:00Z.

#### Function details

##### `record_added_marketplace_entry`  (lines 32–53)

```
fn record_added_marketplace_entry(
    codex_home: &Path,
    marketplace_name: &str,
    install_metadata: &MarketplaceInstallMetadata,
) -> Result<(), MarketplaceAddError>
```

**Purpose**: This function writes a newly added marketplace into the user's config.toml. It records where the marketplace came from, when it was added or updated, and any Git-specific details needed to find the same source again.

**Data flow**: It receives the Codex home folder, the marketplace name, and the install metadata. It turns the metadata into config fields, asks for the current UTC timestamp, builds a MarketplaceConfigUpdate, and passes that to the config-writing helper. If the write succeeds, nothing is returned except success; if it fails, the error is wrapped in a marketplace-add error with a useful message.

**Call relations**: During the add flow, add_marketplace_sync_with_cloner calls this after it has enough source information to record the marketplace. The function relies on the metadata helper methods for source, type, ref, and sparse paths, calls utc_timestamp_now for the timestamp, then hands the final update to record_user_marketplace. A test also calls it to set up a local marketplace entry before checking that the lookup path works.

*Call graph*: calls 5 internal fn (config_source, config_source_type, ref_name, sparse_paths, utc_timestamp_now); called by 2 (add_marketplace_sync_with_cloner, installed_marketplace_root_for_source_uses_local_source_root); 1 external calls (record_user_marketplace).


##### `installed_marketplace_root_for_source`  (lines 55–96)

```
fn installed_marketplace_root_for_source(
    codex_home: &Path,
    install_root: &Path,
    install_metadata: &MarketplaceInstallMetadata,
) -> Result<Option<PathBuf>, MarketplaceAddError>
```

**Purpose**: This function checks whether a marketplace from the same source is already recorded in the user's config, and if so returns its real root folder. It helps the add command reuse or recognize an existing installation instead of blindly adding another copy.

**Data flow**: It receives the Codex home folder, the marketplace install root, and the source metadata to match. It reads config.toml, treats a missing file as "no match," parses the TOML text, and looks through the marketplaces table. For each saved marketplace, it compares the saved source fields against the requested source, resolves the saved entry to a folder path, validates that the folder is a real marketplace, and returns the first valid match. If nothing matches, it returns None; unreadable or unparseable config becomes an error.

**Call relations**: add_marketplace_sync_with_cloner calls this while deciding whether the requested marketplace source is already installed. Inside, the function asks MarketplaceInstallMetadata::matches_config to compare config entries, then passes likely matches to resolve_configured_marketplace_root and validate_marketplace_root. The tests call it both to confirm read errors are reported and to confirm a recorded local marketplace can be found.

*Call graph*: calls 3 internal fn (resolve_configured_marketplace_root, validate_marketplace_root, matches_config); called by 3 (add_marketplace_sync_with_cloner, installed_marketplace_root_for_source_propagates_config_read_errors, installed_marketplace_root_for_source_uses_local_source_root); 5 external calls (join, Internal, format!, read_to_string, from_str).


##### `find_marketplace_root_by_name`  (lines 98–138)

```
fn find_marketplace_root_by_name(
    codex_home: &Path,
    install_root: &Path,
    marketplace_name: &str,
) -> Result<Option<PathBuf>, MarketplaceAddError>
```

**Purpose**: This function looks up a marketplace by its configured name and returns the folder where it lives, but only if that folder still looks valid. It is useful when the add flow knows the name and wants to locate an existing entry directly.

**Data flow**: It receives the Codex home folder, the marketplace install root, and the marketplace name. It reads and parses config.toml, finds the named entry under the marketplaces table, resolves that entry into a path, and validates the path. It returns Some(path) for a valid marketplace, None if the config or entry is missing or the resolved folder is invalid, and an error if the config cannot be read or parsed.

**Call relations**: add_marketplace_sync_with_cloner calls this as part of the marketplace add decision-making path. This function does not compare full source metadata; instead it goes straight to the named config entry, then uses resolve_configured_marketplace_root and validate_marketplace_root to turn that entry into a trustworthy folder path.

*Call graph*: calls 2 internal fn (resolve_configured_marketplace_root, validate_marketplace_root); called by 1 (add_marketplace_sync_with_cloner); 5 external calls (join, Internal, format!, read_to_string, from_str).


##### `MarketplaceInstallMetadata::from_source`  (lines 141–153)

```
fn from_source(source: &MarketplaceSource, sparse_paths: &[String]) -> Self
```

**Purpose**: This constructor turns the user's requested marketplace source into the internal receipt format used by this file. It preserves the details that matter later: Git URL, optional Git ref, sparse paths, or a local folder path.

**Data flow**: It receives a MarketplaceSource and a list of sparse paths. If the source is Git, it copies the URL, optional ref name, and sparse paths into the metadata. If the source is local, it converts the local path into a string. It returns a MarketplaceInstallMetadata value ready to be recorded or compared.

**Call relations**: add_marketplace_sync_with_cloner calls this near the start of metadata work, so later functions can use one common shape for both Git and local sources. The tests also call it to build metadata for their lookup scenarios.

*Call graph*: called by 3 (add_marketplace_sync_with_cloner, installed_marketplace_root_for_source_propagates_config_read_errors, installed_marketplace_root_for_source_uses_local_source_root).


##### `MarketplaceInstallMetadata::config_source_type`  (lines 155–160)

```
fn config_source_type(&self) -> &'static str
```

**Purpose**: This helper says which kind of source the metadata represents: git or local. That short label is exactly what gets written into and compared against config.toml.

**Data flow**: It reads the metadata's stored source variant. For a Git source it returns the string git; for a local folder it returns local. It does not change anything.

**Call relations**: record_added_marketplace_entry uses this when writing a config update. MarketplaceInstallMetadata::matches_config uses it later to check whether a saved config entry has the same source kind.

*Call graph*: called by 2 (matches_config, record_added_marketplace_entry).


##### `MarketplaceInstallMetadata::config_source`  (lines 162–167)

```
fn config_source(&self) -> String
```

**Purpose**: This helper returns the main source value that should appear in config.toml. For Git this is the repository URL; for a local marketplace this is the folder path string.

**Data flow**: It reads the metadata's stored source. It clones and returns the Git URL or local path as a String. The metadata itself is left unchanged.

**Call relations**: record_added_marketplace_entry uses this when building the config update. MarketplaceInstallMetadata::matches_config uses it to compare the requested source with the source saved in config.toml.

*Call graph*: called by 2 (matches_config, record_added_marketplace_entry).


##### `MarketplaceInstallMetadata::ref_name`  (lines 169–174)

```
fn ref_name(&self) -> Option<&str>
```

**Purpose**: This helper returns the Git ref, such as a branch, tag, or commit name, when the marketplace came from Git. Local marketplaces do not have a Git ref, so they return no value.

**Data flow**: It reads the metadata. For Git metadata, it returns the optional ref name as a borrowed string if one was supplied. For local metadata, it returns None. Nothing is modified.

**Call relations**: record_added_marketplace_entry uses this to write the optional ref field. MarketplaceInstallMetadata::matches_config uses it to make sure a saved Git marketplace matches the same ref, not just the same repository URL.

*Call graph*: called by 2 (matches_config, record_added_marketplace_entry).


##### `MarketplaceInstallMetadata::sparse_paths`  (lines 176–181)

```
fn sparse_paths(&self) -> &[String]
```

**Purpose**: This helper returns the sparse paths for a Git marketplace. Sparse paths are a list of subfolders to use from a larger repository; local marketplaces do not use them.

**Data flow**: It reads the metadata. For Git metadata, it returns the stored list of sparse path strings. For local metadata, it returns an empty list. It does not copy or change the stored data.

**Call relations**: record_added_marketplace_entry uses this when saving the marketplace config. MarketplaceInstallMetadata::matches_config uses it to confirm that a saved Git entry used the same sparse checkout choices.

*Call graph*: called by 2 (matches_config, record_added_marketplace_entry).


##### `MarketplaceInstallMetadata::matches_config`  (lines 183–190)

```
fn matches_config(&self, marketplace: &toml::Value) -> bool
```

**Purpose**: This function decides whether one marketplace entry from config.toml describes the same source as this metadata. It is the equality check that lets the add flow recognize an already-recorded marketplace.

**Data flow**: It receives a TOML value for one marketplace entry. It reads source_type, source, ref, and sparse_paths from that entry, reads the same values from the metadata, and compares them all. It returns true only when every relevant field matches; otherwise it returns false.

**Call relations**: installed_marketplace_root_for_source calls this while scanning all configured marketplaces. This function gathers expected values through config_source_type, config_source, ref_name, and sparse_paths, and it delegates sparse path extraction from TOML to config_sparse_paths.

*Call graph*: calls 5 internal fn (config_source, config_source_type, ref_name, sparse_paths, config_sparse_paths); called by 1 (installed_marketplace_root_for_source); 1 external calls (get).


##### `config_sparse_paths`  (lines 193–205)

```
fn config_sparse_paths(marketplace: &toml::Value) -> Vec<String>
```

**Purpose**: This helper pulls the sparse_paths list out of a marketplace's TOML config entry. It gives the comparison code a simple list of strings to work with.

**Data flow**: It receives a TOML marketplace value. It looks for a sparse_paths array, keeps only array items that are strings, converts them into owned String values, and returns the list. If the field is missing or not an array, it returns an empty list.

**Call relations**: MarketplaceInstallMetadata::matches_config calls this when comparing a saved config entry with the requested install metadata. Its small job keeps the TOML parsing detail out of the higher-level match logic.

*Call graph*: called by 1 (matches_config); 1 external calls (get).


##### `utc_timestamp_now`  (lines 207–214)

```
fn utc_timestamp_now() -> Result<String, MarketplaceAddError>
```

**Purpose**: This function creates the current UTC timestamp string used in the marketplace config entry. It makes sure recorded marketplace updates have a consistent time format.

**Data flow**: It asks the operating system for the current time, measures how many seconds have passed since the Unix epoch, which is midnight UTC on 1970-01-01, and formats that count as a UTC date-time string. If the system clock is somehow before the Unix epoch, it returns an internal error.

**Call relations**: record_added_marketplace_entry calls this just before writing the config update. utc_timestamp_now hands the numeric seconds to format_utc_timestamp, which does the calendar formatting.

*Call graph*: calls 1 internal fn (format_utc_timestamp); called by 1 (record_added_marketplace_entry); 1 external calls (now).


##### `format_utc_timestamp`  (lines 216–225)

```
fn format_utc_timestamp(seconds_since_epoch: i64) -> String
```

**Purpose**: This function turns a number of seconds since the Unix epoch into a readable UTC timestamp. It exists so config entries can use a standard date-time string instead of a raw number.

**Data flow**: It receives a signed count of seconds since 1970-01-01T00:00:00Z. It splits that into whole days and seconds within the day, converts the day count into year, month, and day, calculates hour, minute, and second, and returns a string like 2026-04-10T00:00:00Z.

**Call relations**: utc_timestamp_now calls this after getting the current time from the system. The timestamp formatting test also relies on it directly to check known dates. It delegates the calendar date calculation to civil_from_days.

*Call graph*: calls 1 internal fn (civil_from_days); called by 1 (utc_timestamp_now); 1 external calls (format!).


##### `civil_from_days`  (lines 227–240)

```
fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64)
```

**Purpose**: This function converts a day count into a calendar date: year, month, and day. It is the calendar math behind the timestamp formatter.

**Data flow**: It receives the number of days since the Unix epoch. It applies a standard civil-calendar calculation that accounts for leap years and 400-year calendar cycles, then returns the matching year, month, and day as numbers.

**Call relations**: format_utc_timestamp calls this when it has already reduced a timestamp to a number of whole days. This helper does not know about hours, minutes, config files, or marketplaces; it only supplies the date part.

*Call graph*: called by 1 (format_utc_timestamp).


##### `tests::utc_timestamp_formats_unix_epoch_as_rfc3339_utc`  (lines 249–258)

```
fn utc_timestamp_formats_unix_epoch_as_rfc3339_utc()
```

**Purpose**: This test checks that timestamp formatting produces the expected UTC strings for known second counts. It protects the config timestamp format from accidental changes.

**Data flow**: It feeds format_utc_timestamp two fixed inputs: zero seconds since the Unix epoch and another known timestamp. It compares the returned strings with the expected RFC 3339-style UTC strings. If either output changes, the test fails.

**Call relations**: The test directly exercises format_utc_timestamp. It does not run during normal marketplace adding; it runs in the test suite to catch mistakes in the date formatting logic.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::installed_marketplace_root_for_source_propagates_config_read_errors`  (lines 261–287)

```
fn installed_marketplace_root_for_source_propagates_config_read_errors()
```

**Purpose**: This test confirms that a config.toml path that cannot be read is reported as an error, not silently treated as missing. That matters because hiding a broken config could make the add flow behave unpredictably.

**Data flow**: It creates a temporary Codex home folder, then creates a directory where config.toml should be, which makes reading it as a file fail. It builds Git install metadata and calls installed_marketplace_root_for_source. The expected result is an error message that includes the failed config path.

**Call relations**: The test builds metadata through MarketplaceInstallMetadata::from_source and then calls installed_marketplace_root_for_source. It verifies the error path used when the add flow cannot read the user's config file.

*Call graph*: calls 2 internal fn (from_source, installed_marketplace_root_for_source); 3 external calls (new, assert!, create_dir).


##### `tests::installed_marketplace_root_for_source_uses_local_source_root`  (lines 290–314)

```
fn installed_marketplace_root_for_source_uses_local_source_root()
```

**Purpose**: This test checks that a local marketplace recorded in config resolves back to its original local source folder. It protects the behavior where local marketplaces are used in place rather than treated like copied installs.

**Data flow**: It creates a temporary Codex home, builds a fake local marketplace folder with the expected marketplace.json file, creates local install metadata, and records it in config.toml. It then asks installed_marketplace_root_for_source to find that source and expects the original local folder path to come back.

**Call relations**: The test calls MarketplaceInstallMetadata::from_source, record_added_marketplace_entry, and installed_marketplace_root_for_source in the same order the real add flow would use them. It confirms that the write-and-read path works for local sources.

*Call graph*: calls 3 internal fn (from_source, installed_marketplace_root_for_source, record_added_marketplace_entry); 4 external calls (new, assert_eq!, create_dir_all, write).


### `core-plugins/src/marketplace_add/source.rs`

`domain_logic` · `marketplace add request handling`

When someone adds a plugin marketplace, they may type the source in several human-friendly ways: `owner/repo`, a full `https://...` Git URL, an SSH Git URL, or a local path like `./marketplace`. This file is the translator and gatekeeper for that input. Without it, later code would not know whether it should clone a repository, read a local directory, which branch or tag to use, or whether the input is simply invalid.

The main type, `MarketplaceSource`, is like a labeled package. It says either “this is Git, with this URL and maybe this branch/tag name” or “this is local, with this resolved folder path.” The parser trims the text, separates optional reference suffixes such as `#v1` or `@main`, rejects empty input, recognizes local paths, recognizes Git URLs, and expands GitHub shorthand into a full `https://github.com/...git` URL.

The file also enforces important rules. A `--ref` value and sparse checkout paths only make sense for Git sources, so local folders are rejected if those options are used. Local paths are resolved to real absolute paths and must be directories, not files. Finally, after a source has been staged or selected, the root is checked to make sure it really looks like a marketplace and that its marketplace name is safe to use as a plugin-style name.

#### Function details

##### `parse_marketplace_source`  (lines 18–65)

```
fn parse_marketplace_source(
    source: &str,
    explicit_ref: Option<String>,
) -> Result<MarketplaceSource, MarketplaceAddError>
```

**Purpose**: Turns the user’s source string into a `MarketplaceSource`, either Git or local. It also gives clear errors for empty text, unsupported formats, local files, or using a Git-only reference with a local path.

**Data flow**: It receives the raw source text and an optional explicit reference, such as a branch or tag. It trims the text, splits off any inline reference, decides whether the base looks like a local path, a Git URL, an SSH Git URL, or GitHub `owner/repo` shorthand, then returns a structured source value or an error message.

**Call relations**: This is the front door used by the marketplace add flow before any cloning or local reading happens. It relies on small helper checks for URL shape, path shape, GitHub shorthand, URL cleanup, reference splitting, and local path resolution; the tests call it with many examples to lock down those rules.

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

**Purpose**: Prepares a Git marketplace source in a staging directory by calling the supplied clone operation. It refuses sparse checkout requests for non-Git sources because sparse checkout is a Git feature.

**Data flow**: It receives a parsed source, a list of sparse paths, a destination folder, and a cloning function supplied by the caller. If the source is Git, it passes the URL, optional reference, sparse path list, and destination to that clone function; if the options do not make sense, it returns an error instead.

**Call relations**: After `parse_marketplace_source` has decided what kind of source the user gave, the marketplace add flow calls this when it needs a staged copy. The actual Git work is handed off through the `clone_source` callback, which keeps this function focused on policy and routing.

*Call graph*: called by 2 (add_marketplace_sync_with_cloner, non_git_sources_reject_sparse_checkout); 3 external calls (InvalidRequest, matches!, unreachable!).


##### `validate_marketplace_source_root`  (lines 92–98)

```
fn validate_marketplace_source_root(root: &Path) -> Result<String, MarketplaceAddError>
```

**Purpose**: Checks that a folder really contains a valid marketplace and that its marketplace name is safe to use. This protects later plugin code from malformed or unsafe names.

**Data flow**: It receives a filesystem path. It asks the marketplace validator to read and verify the marketplace root, then checks the resulting marketplace name as a valid plugin name segment; it returns the marketplace name or turns validation failures into user-facing request errors.

**Call relations**: The marketplace add flow calls this after it has a local or staged marketplace root. It hands the heavy checking to `validate_marketplace_root` and `validate_plugin_segment`, then gives the add flow the trusted marketplace name.

*Call graph*: calls 1 internal fn (validate_marketplace_root); called by 1 (add_marketplace_sync_with_cloner); 1 external calls (validate_plugin_segment).


##### `split_source_ref`  (lines 100–111)

```
fn split_source_ref(source: &str) -> (String, Option<String>)
```

**Purpose**: Separates a source address from an optional branch, tag, or other Git reference written at the end. It understands `#ref` generally and `@ref` for non-URL shorthand forms.

**Data flow**: It receives one source string. It looks from the right for `#`, or for `@` when the text is not a URL and not an SSH Git address, then returns the base source plus an optional cleaned reference.

**Call relations**: `parse_marketplace_source` calls this before deciding what kind of source it is looking at. It uses `is_ssh_git_url` to avoid mistaking SSH addresses for shorthand references and uses `non_empty_ref` so blank suffixes are ignored.

*Call graph*: calls 2 internal fn (is_ssh_git_url, non_empty_ref); called by 1 (parse_marketplace_source).


##### `non_empty_ref`  (lines 113–116)

```
fn non_empty_ref(ref_name: &str) -> Option<String>
```

**Purpose**: Turns a reference suffix into `None` if it is blank, or a cleaned string if it contains real text. This prevents empty references from being treated as meaningful.

**Data flow**: It receives the reference part after a separator like `#` or `@`. It trims surrounding whitespace and returns either no value for an empty result or the trimmed reference string.

**Call relations**: `split_source_ref` calls this whenever it has found a possible reference suffix. Its result flows back into `parse_marketplace_source`, where an explicit `--ref` can override it.

*Call graph*: called by 1 (split_source_ref).


##### `normalize_git_url`  (lines 118–125)

```
fn normalize_git_url(url: &str) -> String
```

**Purpose**: Cleans up Git URLs so the same GitHub repository is represented consistently. In particular, GitHub HTTPS URLs are made to end in `.git`.

**Data flow**: It receives a Git URL string. It removes trailing slashes, adds `.git` for `https://github.com/...` URLs that do not already have it, and returns the normalized URL text.

**Call relations**: `parse_marketplace_source` calls this after it has recognized a full Git URL. This helps GitHub shorthand and equivalent full GitHub URLs compare as the same source.

*Call graph*: called by 1 (parse_marketplace_source); 1 external calls (format!).


##### `looks_like_local_path`  (lines 127–137)

```
fn looks_like_local_path(source: &str) -> bool
```

**Purpose**: Decides whether the user’s source text looks like a path on the local machine rather than a Git repository address. This includes Unix-style paths, Windows-style paths, and home-directory paths.

**Data flow**: It receives the base source string. It checks for absolute paths, Windows absolute paths, relative prefixes like `./` and `../`, `~/`, and the special current or parent directory names; it returns true or false.

**Call relations**: `parse_marketplace_source` uses this early so local folders are not mistaken for GitHub shorthand. It delegates the Windows-specific absolute path check to `looks_like_windows_absolute_path`.

*Call graph*: calls 1 internal fn (looks_like_windows_absolute_path); called by 1 (parse_marketplace_source); 1 external calls (new).


##### `looks_like_windows_absolute_path`  (lines 139–146)

```
fn looks_like_windows_absolute_path(source: &str) -> bool
```

**Purpose**: Recognizes Windows absolute paths even when the code is running on a non-Windows system. This matters because users or tests may pass paths like `C:\Users\...` or network shares.

**Data flow**: It receives a source string. It checks for a drive letter followed by `:` and a slash or backslash, or for a UNC network path beginning with double backslashes, then returns true or false.

**Call relations**: `looks_like_local_path` calls this as one part of its broader local-path decision. The tests specifically check that these Windows forms are recognized consistently.

*Call graph*: called by 1 (looks_like_local_path); 1 external calls (matches!).


##### `resolve_local_source_path`  (lines 148–167)

```
fn resolve_local_source_path(source: &str) -> Result<PathBuf, MarketplaceAddError>
```

**Purpose**: Turns a local marketplace path into a real absolute filesystem path. This gives later code a stable location to read from.

**Data flow**: It receives a local path string. It expands `~/` if possible, joins relative paths to the current working directory, asks the operating system to canonicalize the path, and returns the resolved `PathBuf` or an error if it cannot be resolved.

**Call relations**: `parse_marketplace_source` calls this after deciding the source is local. It uses `expand_tilde_path` for home-directory shorthand and reads the current directory when needed.

*Call graph*: calls 1 internal fn (expand_tilde_path); called by 1 (parse_marketplace_source); 1 external calls (current_dir).


##### `expand_tilde_path`  (lines 169–177)

```
fn expand_tilde_path(source: &str) -> PathBuf
```

**Purpose**: Expands paths that start with `~/` into the user’s home directory. This lets users write familiar shell-style paths.

**Data flow**: It receives a path string. If the string starts with `~/` and a home directory can be found from environment variables, it replaces `~` with that home folder; otherwise it returns the original path as a path object.

**Call relations**: `resolve_local_source_path` calls this before making the path absolute and canonical. It reads `HOME` or `USERPROFILE`, which are common environment variables for the user’s home directory.

*Call graph*: called by 1 (resolve_local_source_path); 2 external calls (from, var_os).


##### `is_ssh_git_url`  (lines 179–181)

```
fn is_ssh_git_url(source: &str) -> bool
```

**Purpose**: Checks whether a source string looks like an SSH Git address. SSH is a way to access Git repositories using secure login keys.

**Data flow**: It receives a source string and returns true if it starts with `ssh://` or looks like the common `git@host:repo` form.

**Call relations**: `parse_marketplace_source` uses this to recognize Git sources. `split_source_ref` also uses it so the `@` in addresses like `git@github.com:owner/repo.git` is not wrongly treated as a branch separator.

*Call graph*: called by 2 (parse_marketplace_source, split_source_ref).


##### `is_git_url`  (lines 183–185)

```
fn is_git_url(source: &str) -> bool
```

**Purpose**: Checks whether a source string is an HTTP or HTTPS Git URL. This catches common repository addresses such as GitHub, GitLab, or other hosted Git servers.

**Data flow**: It receives a source string and returns true if it begins with `http://` or `https://`.

**Call relations**: `parse_marketplace_source` calls this after local-path detection and SSH detection. If it returns true, the parser treats the source as Git and normalizes the URL where needed.

*Call graph*: called by 1 (parse_marketplace_source).


##### `looks_like_github_shorthand`  (lines 187–195)

```
fn looks_like_github_shorthand(source: &str) -> bool
```

**Purpose**: Recognizes the short GitHub form `owner/repo`. This lets users avoid typing the full GitHub URL.

**Data flow**: It receives a source string, splits it on `/`, and checks that there are exactly two valid parts: owner and repository. It returns true only when both parts have allowed characters and there is no extra path segment.

**Call relations**: `parse_marketplace_source` calls this after ruling out local paths and full Git URLs. When it matches, the parser builds a full `https://github.com/owner/repo.git` URL.

*Call graph*: called by 1 (parse_marketplace_source).


##### `is_github_shorthand_segment`  (lines 197–202)

```
fn is_github_shorthand_segment(segment: &str) -> bool
```

**Purpose**: Checks one part of a GitHub shorthand source, such as the owner name or repository name. It allows common GitHub name characters and rejects empty segments.

**Data flow**: It receives a single text segment. It returns true when every character is an ASCII letter, number, dash, underscore, or dot, and the segment is not empty.

**Call relations**: This helper supports the GitHub shorthand check by acting like a small quality gate for each segment. That keeps `owner/repo` recognition strict enough to avoid accepting random malformed text.


##### `MarketplaceSource::display`  (lines 205–213)

```
fn display(&self) -> String
```

**Purpose**: Creates a user-readable version of a parsed marketplace source. It is useful for messages, logs, or summaries where the source needs to be shown back to a person.

**Data flow**: It reads the `MarketplaceSource` value. For Git, it returns the URL and appends `#ref` when there is a reference; for local sources, it returns the path as display text.

**Call relations**: This method sits on the `MarketplaceSource` type itself, so any later marketplace-add code can ask a parsed source how it should be shown. It uses formatting only for the Git-with-reference case.

*Call graph*: 1 external calls (format!).


##### `tests::github_shorthand_parses_ref_suffix`  (lines 223–231)

```
fn github_shorthand_parses_ref_suffix()
```

**Purpose**: Checks that GitHub shorthand with an `@main` suffix becomes a Git source with `main` as the reference. This protects the user-friendly shorthand syntax.

**Data flow**: The test gives the parser `owner/repo@main` and expects a normalized GitHub URL plus the `main` reference. If the actual parsed value differs, the assertion fails.

**Call relations**: The test runner calls this during automated testing. It supports confidence in the parsing behavior that `parse_marketplace_source` provides to the marketplace add flow.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::git_url_parses_fragment_ref`  (lines 234–246)

```
fn git_url_parses_fragment_ref()
```

**Purpose**: Checks that a full Git URL with `#v1` keeps the URL and extracts `v1` as the reference. This covers the fragment-style reference syntax.

**Data flow**: The test feeds in `https://example.com/team/repo.git#v1` and expects the base URL without the fragment plus a reference value of `v1`. The assertion compares expected and actual structured values.

**Call relations**: The test runner calls this as part of the parser test suite. It verifies the behavior that is used before Git cloning begins.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::explicit_ref_overrides_source_ref`  (lines 249–257)

```
fn explicit_ref_overrides_source_ref()
```

**Purpose**: Checks that an explicit reference option wins over a reference written inside the source string. This makes command-line behavior predictable.

**Data flow**: The test uses a source containing `@main` and also supplies `release` as the explicit reference. It expects the parsed result to use `release`, not `main`.

**Call relations**: The test runner calls this to protect the precedence rule used by `parse_marketplace_source`. That rule matters when the marketplace add command receives both forms.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::github_shorthand_and_git_url_normalize_to_same_source`  (lines 260–276)

```
fn github_shorthand_and_git_url_normalize_to_same_source()
```

**Purpose**: Checks that `owner/repo` and the full GitHub `.git` URL produce the same parsed source. This keeps different ways of saying the same GitHub repository consistent.

**Data flow**: The test parses shorthand and full URL inputs, compares them to each other, and compares the result to the expected normalized Git source.

**Call relations**: The test runner calls this, and the test directly exercises `parse_marketplace_source`. It protects the normalization path that uses GitHub shorthand expansion and URL cleanup.

*Call graph*: calls 1 internal fn (parse_marketplace_source); 1 external calls (assert_eq!).


##### `tests::github_url_with_trailing_slash_normalizes_without_extra_path_segment`  (lines 279–288)

```
fn github_url_with_trailing_slash_normalizes_without_extra_path_segment()
```

**Purpose**: Checks that a GitHub URL ending in `/` is cleaned into a normal `.git` URL, not treated as a different repository path. This avoids subtle duplicate-source problems.

**Data flow**: The test gives a GitHub URL with a trailing slash and expects the returned Git source URL to end with `.git` and no extra slash segment.

**Call relations**: The test runner calls this as part of URL normalization coverage. It protects the behavior supplied by `normalize_git_url` through the parser.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::non_github_https_source_parses_as_git_url`  (lines 291–300)

```
fn non_github_https_source_parses_as_git_url()
```

**Purpose**: Checks that HTTPS Git URLs from hosts other than GitHub are accepted. The parser should not be GitHub-only.

**Data flow**: The test supplies a GitLab-style HTTPS URL and expects it to come back as a Git source without adding `.git` or changing the host.

**Call relations**: The test runner calls this to confirm `parse_marketplace_source` accepts generic HTTP-based Git sources. It guards the path recognized by `is_git_url`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::file_url_source_is_rejected`  (lines 303–313)

```
fn file_url_source_is_rejected()
```

**Purpose**: Checks that `file://` URLs are rejected instead of being treated as valid marketplace sources. This keeps the accepted source formats narrow and intentional.

**Data flow**: The test passes a `file:///tmp/...` source, expects an error, and checks that the error says the source format is invalid.

**Call relations**: The test runner calls this, and it directly calls `parse_marketplace_source`. It confirms that unsupported URL schemes do not slip through as Git or local paths.

*Call graph*: calls 1 internal fn (parse_marketplace_source); 1 external calls (assert!).


##### `tests::local_path_source_parses`  (lines 316–323)

```
fn local_path_source_parses()
```

**Purpose**: Checks that `.` is accepted as a local marketplace source and resolved to an absolute path. This supports adding a marketplace from the current directory.

**Data flow**: The test parses `.` and then inspects the result. It expects a local source variant whose path is absolute; otherwise it fails.

**Call relations**: The test runner calls this, and it directly exercises `parse_marketplace_source`. It protects the local-path branch that later marketplace add code can use without staging a clone.

*Call graph*: calls 1 internal fn (parse_marketplace_source); 2 external calls (assert!, panic!).


##### `tests::windows_absolute_paths_look_like_local_paths_on_every_host`  (lines 326–331)

```
fn windows_absolute_paths_look_like_local_paths_on_every_host()
```

**Purpose**: Checks that Windows absolute paths are recognized as local paths even when tests run on another operating system. This keeps parsing behavior portable.

**Data flow**: The test sends several Windows path examples to the local-path detector and checks true or false results, including rejecting `C:relative\path` because it is not absolute.

**Call relations**: The test runner calls this to protect the helper behavior behind local source detection. It is especially important because path syntax differs across operating systems.

*Call graph*: 1 external calls (assert!).


##### `tests::local_file_source_is_rejected`  (lines 334–347)

```
fn local_file_source_is_rejected()
```

**Purpose**: Checks that a local source must be a directory, not a single file. A marketplace root needs directory contents, so accepting a file would fail later in a less clear way.

**Data flow**: The test creates a temporary directory, writes a file inside it, passes that file path as the source, and expects an error saying a directory is required.

**Call relations**: The test runner calls this, and it directly calls `parse_marketplace_source`. It confirms the parser catches local file mistakes before the add flow tries to read a marketplace root.

*Call graph*: calls 1 internal fn (parse_marketplace_source); 3 external calls (new, assert!, write).


##### `tests::non_git_sources_reject_ref_override`  (lines 350–358)

```
fn non_git_sources_reject_ref_override()
```

**Purpose**: Checks that the explicit `--ref` option is rejected for local sources. A branch or tag only makes sense for Git.

**Data flow**: The test passes a local-looking source plus an explicit reference. It expects an error message explaining that `--ref` is only supported for Git marketplace sources.

**Call relations**: The test runner calls this, and it directly exercises `parse_marketplace_source`. It protects the rule that keeps Git-only options away from local folder sources.

*Call graph*: calls 1 internal fn (parse_marketplace_source); 1 external calls (assert!).


##### `tests::non_git_sources_reject_sparse_checkout`  (lines 361–376)

```
fn non_git_sources_reject_sparse_checkout()
```

**Purpose**: Checks that sparse checkout paths are rejected for local sources. Sparse checkout means cloning only selected paths from Git, so it does not apply to an already-local folder.

**Data flow**: The test builds a local `MarketplaceSource`, supplies a sparse path list and a dummy clone function, then expects `stage_marketplace_source` to return a Git-only option error.

**Call relations**: The test runner calls this, and it directly calls `stage_marketplace_source`. It verifies that staging enforces the same Git-only boundary as parsing does for references.

*Call graph*: calls 1 internal fn (stage_marketplace_source); 3 external calls (new, assert!, current_dir).


##### `tests::ssh_url_parses_as_git_url`  (lines 379–391)

```
fn ssh_url_parses_as_git_url()
```

**Purpose**: Checks that SSH Git URLs are accepted and can include a `#main` reference suffix. This supports users who clone private or authenticated repositories over SSH.

**Data flow**: The test provides an `ssh://git@github.com/...#main` source and expects a Git source with the SSH URL as the base and `main` as the reference.

**Call relations**: The test runner calls this to cover the SSH path through source parsing. It protects the behavior supplied by `is_ssh_git_url` and reference splitting.

*Call graph*: 1 external calls (assert_eq!).


### `core-plugins/src/marketplace_add.rs`

`domain_logic` · `marketplace add request handling`

A marketplace is a collection of plugins that Codex can offer to the user. This file is the main doorway for adding one. Without it, Codex would not have a safe, consistent way to turn a user-provided source, such as a Git URL or a local directory, into an installed marketplace entry.

The flow starts with a request that names the source, an optional Git reference such as a branch or tag, and optional sparse paths, which mean "only fetch these parts" from a Git repository. The code first turns the source text into a structured source type. It rejects combinations that do not make sense, such as sparse checkout for a local folder.

For local marketplaces, it does not copy files. It checks that the folder really looks like a marketplace, rejects reserved OpenAI-curated marketplace names, and records the folder in the user's config.

For Git marketplaces, it uses a staging area, like a temporary workbench. It clones or stages the source there, validates it, checks for name conflicts, then moves it into the real install folder. If writing the config fails after the move, it tries to roll the install back. This matters because it avoids leaving Codex half-updated, where files exist but the config does not know about them.

#### Function details

##### `add_marketplace`  (lines 50–57)

```
async fn add_marketplace(
    codex_home: PathBuf,
    request: MarketplaceAddRequest,
) -> Result<MarketplaceAddOutcome, MarketplaceAddError>
```

**Purpose**: This is the public asynchronous entry point for adding a marketplace. It lets callers start the add operation without blocking the async runtime, which is the part of the program that keeps other tasks moving.

**Data flow**: It receives the Codex home folder and a marketplace add request. It moves the slower file and Git work onto a blocking worker thread, runs the synchronous add logic there, and returns either a successful add outcome or a clear error.

**Call relations**: Higher-level flows such as plugin import and the add command call this function when a user wants to add a marketplace. It hands the real work to the synchronous add path inside a worker task so those callers do not freeze the rest of the program.

*Call graph*: called by 2 (import_plugins, run_add); 1 external calls (spawn_blocking).


##### `is_local_marketplace_source`  (lines 59–67)

```
fn is_local_marketplace_source(
    source: &str,
    explicit_ref: Option<String>,
) -> Result<bool, MarketplaceAddError>
```

**Purpose**: This helper answers a simple question: does this source string point to a local marketplace folder? Callers can use it when they need to choose different behavior for local paths versus Git sources.

**Data flow**: It receives the source text and an optional reference name. It parses those into a marketplace source description, checks whether that description is the local-folder kind, and returns true or false, or an error if the source text is invalid.

**Call relations**: This function relies on the same source parser used by the add flow, so the answer matches what adding the marketplace would believe. It does not install anything; it only classifies the source.

*Call graph*: 1 external calls (matches!).


##### `add_marketplace_sync`  (lines 69–74)

```
fn add_marketplace_sync(
    codex_home: &Path,
    request: MarketplaceAddRequest,
) -> Result<MarketplaceAddOutcome, MarketplaceAddError>
```

**Purpose**: This is the normal synchronous version of the marketplace add operation. It exists so the main async wrapper and other plain blocking code can share one implementation.

**Data flow**: It receives the Codex home folder and the add request. It calls the shared add routine using the real Git cloning function, then passes back the resulting outcome or error.

**Call relations**: The async add function reaches the core logic through this function. This wrapper chooses the production cloner, while tests can call the deeper helper with a fake cloner.

*Call graph*: calls 1 internal fn (add_marketplace_sync_with_cloner).


##### `add_marketplace_sync_with_cloner`  (lines 76–210)

```
fn add_marketplace_sync_with_cloner(
    codex_home: &Path,
    request: MarketplaceAddRequest,
    clone_source: F,
) -> Result<MarketplaceAddOutcome, MarketplaceAddError>
```

**Purpose**: This is the main installation recipe. It parses the requested source, prevents unsafe or conflicting installs, stages remote sources, validates the marketplace, writes the user's config, and reports what was added.

**Data flow**: It starts with a Codex home path, a request, and a function that can copy or clone a source into a destination. It parses the source, creates the install area if needed, builds metadata for the config, checks whether the same source is already recorded, and then branches. For a local source, it validates the existing folder and records it. For a Git source, it creates a temporary staging folder, places the source there, validates it, moves it into the install folder, and records it. The result is a marketplace name, a display form of the source, an absolute installed path, and a flag saying whether it was already added.

**Call relations**: This function is called by the normal synchronous wrapper and directly by tests. It coordinates helpers from the install, metadata, and source modules: source helpers parse and stage the marketplace, install helpers choose safe folders and move files, and metadata helpers find or write the marketplace entry in config.

*Call graph*: calls 13 internal fn (marketplace_install_root, ensure_marketplace_destination_is_inside_install_root, marketplace_staging_root, replace_marketplace_root, safe_marketplace_dir_name, from_source, find_marketplace_root_by_name, installed_marketplace_root_for_source, record_added_marketplace_entry, parse_marketplace_source (+3 more)); called by 5 (add_marketplace_sync, add_marketplace_sync_installs_local_directory_source_and_updates_config, add_marketplace_sync_installs_marketplace_and_updates_config, add_marketplace_sync_rejects_sparse_checkout_for_local_directory_source, add_marketplace_sync_treats_existing_local_directory_source_as_already_added); 8 external calls (new, Internal, InvalidRequest, is_openai_curated_marketplace_name, format!, create_dir_all, rename, matches!).


##### `tests::add_marketplace_sync_installs_marketplace_and_updates_config`  (lines 220–254)

```
fn add_marketplace_sync_installs_marketplace_and_updates_config() -> Result<()>
```

**Purpose**: This test proves that adding a Git-style marketplace copies the marketplace into the install area and writes the expected config entry. It uses a fake cloner so the test does not need the network.

**Data flow**: It creates temporary Codex and source folders, writes a small sample marketplace into the source folder, then calls the add routine with a pretend Git URL. The fake cloner copies the sample files into the staging destination. The test then checks that the result names the marketplace correctly, marks it as newly added, leaves marketplace files in the installed root, and writes Git source details to the config file.

**Call relations**: This test calls the shared add routine directly with a test cloner. It also uses the helper that writes a sample marketplace and the recursive copy helper to mimic what a real Git clone would provide.

*Call graph*: calls 1 internal fn (add_marketplace_sync_with_cloner); 6 external calls (new, new, assert!, assert_eq!, write_marketplace_source, read_to_string).


##### `tests::add_marketplace_sync_installs_local_directory_source_and_updates_config`  (lines 257–298)

```
fn add_marketplace_sync_installs_local_directory_source_and_updates_config() -> Result<()>
```

**Purpose**: This test proves that a local marketplace folder is recorded directly instead of copied into Codex's install folder. That distinction matters because local sources should stay where the user put them.

**Data flow**: It creates temporary folders, writes a sample marketplace in the local source folder, and calls the add routine with that folder path. The fake Git cloner would panic if used, so the test confirms the local path avoids cloning. It checks that the outcome points to the canonical local folder, no install-folder copy was made, and the config records the source type as local.

**Call relations**: This test exercises the local-source branch of the shared add routine. It depends on the sample marketplace writer and checks the config file produced by the metadata recording code.

*Call graph*: calls 2 internal fn (add_marketplace_sync_with_cloner, from_absolute_path); 7 external calls (new, new, assert!, assert_eq!, write_marketplace_source, read_to_string, from_str).


##### `tests::add_marketplace_sync_rejects_sparse_checkout_for_local_directory_source`  (lines 301–330)

```
fn add_marketplace_sync_rejects_sparse_checkout_for_local_directory_source() -> Result<()>
```

**Purpose**: This test confirms that sparse checkout is rejected for local folders. Sparse checkout means selecting only parts of a Git repository, so it would not make sense for a plain local directory in this flow.

**Data flow**: It prepares a valid local marketplace folder, then calls the add routine with that folder plus a sparse path. The function returns an error before writing config or calling the fake cloner. The test checks the exact error message and confirms no config file was created.

**Call relations**: This test targets the early validation inside the shared add routine. It verifies that bad input is stopped before any install or config-writing helpers are reached.

*Call graph*: calls 1 internal fn (add_marketplace_sync_with_cloner); 5 external calls (new, assert!, assert_eq!, write_marketplace_source, vec!).


##### `tests::add_marketplace_sync_treats_existing_local_directory_source_as_already_added`  (lines 333–360)

```
fn add_marketplace_sync_treats_existing_local_directory_source_as_already_added() -> Result<()>
```

**Purpose**: This test proves that adding the same local marketplace twice is safe and idempotent. Idempotent means doing the same action again does not create a duplicate or change the result unexpectedly.

**Data flow**: It creates a sample local marketplace and sends the same add request twice. The first call records it as newly added. The second call recognizes the same source from existing metadata, validates the folder again, and returns an outcome marked as already added with the same installed root.

**Call relations**: This test exercises the existing-source lookup in the shared add routine. It shows how metadata lookup prevents duplicate marketplace entries for the same local folder.

*Call graph*: calls 1 internal fn (add_marketplace_sync_with_cloner); 5 external calls (new, new, assert!, assert_eq!, write_marketplace_source).


##### `tests::write_marketplace_source`  (lines 362–386)

```
fn write_marketplace_source(source: &Path, marker: &str) -> std::io::Result<()>
```

**Purpose**: This test helper creates a tiny but valid marketplace folder on disk. Tests use it as a realistic sample source without needing a real external marketplace.

**Data flow**: It receives a destination folder and a marker string. It creates the marketplace metadata directories, writes a marketplace JSON file that names a sample plugin, writes that plugin's own metadata file, and writes a marker text file. It returns success or an input/output error from the filesystem.

**Call relations**: The marketplace add tests call this helper before running the add routine. It supplies the source files that validation and installation code expect to find.

*Call graph*: 3 external calls (join, create_dir_all, write).


##### `tests::copy_dir_all`  (lines 388–401)

```
fn copy_dir_all(source: &Path, destination: &Path) -> std::io::Result<()>
```

**Purpose**: This test helper recursively copies one directory tree into another. It stands in for a Git clone during tests, so the add logic can be tested without contacting Git.

**Data flow**: It receives a source folder and a destination folder. It creates the destination, walks through every entry in the source, recursively copies subfolders, and copies files directly. It returns success or a filesystem error.

**Call relations**: The Git-style install test uses this helper inside its fake cloner. That lets the shared add routine behave as if a remote repository was cloned into the staging folder.

*Call graph*: 5 external calls (join, copy_dir_all, copy, create_dir_all, read_dir).


### `core-plugins/src/marketplace_upgrade/git.rs`

`io_transport` · `marketplace upgrade, while resolving and cloning a Git-backed marketplace source`

Marketplace upgrades can be backed by a Git repository, so the upgrader needs a safe, predictable way to talk to Git. This file is that bridge. It does not implement Git itself; it runs the system's `git` program, captures its output, and turns success or failure into ordinary Rust results.

The main flow is like sending a courier to a warehouse. First, `git_remote_revision` can ask the remote repository, "What exact commit does this branch or tag mean?" If the caller already gave a full 40-character Git commit ID, it trusts that and avoids a network call. Then `clone_git_source` copies the repository into a destination folder. It can either clone everything, or use Git's sparse checkout feature, which means "only bring back these selected paths" instead of the whole warehouse.

The file also protects the upgrader from common problems. Every Git command is run with a timeout, so a stuck network or credential prompt cannot freeze the upgrade forever. Prompts are disabled so Git will not wait for a human password entry in the background. Errors include the Git command's stderr text when available, which makes failures easier to diagnose. On Windows, it also rewrites special long-path forms into paths Git can understand.

#### Function details

##### `git_remote_revision`  (lines 8–41)

```
fn git_remote_revision(
    source: &str,
    ref_name: Option<&str>,
    timeout: Duration,
) -> Result<String, String>
```

**Purpose**: Finds the exact Git commit ID for a marketplace source and optional branch, tag, or commit name. This matters because upgrades should record the precise revision used, not just a moving name like `main`.

**Data flow**: It receives a repository location, an optional reference name, and a timeout. If the reference is already a full 40-character commit ID, it returns it immediately. Otherwise it runs `git ls-remote`, checks that Git succeeded, reads the first line of output, extracts the commit ID before the tab character, and returns that ID or a readable error.

**Call relations**: The marketplace upgrade flow calls this when it needs to know what remote revision it is about to use. It relies on `is_full_git_sha` for the quick no-network case, `git_command` to build a safe Git process, `run_git_command_with_timeout` to run it without hanging, and `ensure_git_success` to turn Git failures into clear errors.

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

**Purpose**: Clones a marketplace Git source into a local destination folder. It can copy the whole repository or only selected paths, which saves time and space when the marketplace data lives in part of a larger repository.

**Data flow**: It receives a repository location, an optional reference name, a list of sparse paths, a destination path, and a timeout. It first prepares the destination path in a Git-friendly form. If no sparse paths are requested, it runs `git clone`, optionally checks out the requested reference, then asks what commit was checked out. If sparse paths are requested, it clones without checking out files, configures sparse checkout for those paths, checks out the requested reference or `HEAD`, and returns the final commit ID.

**Call relations**: The marketplace upgrade flow calls this after deciding which Git source to fetch. It hands each Git operation to `run_git_command_with_timeout`, checks the result with `ensure_git_success`, uses `git_command` for consistent process setup, uses `git_path_arg` for platform-safe paths, and finishes by calling `git_worktree_revision` so the caller knows exactly what was cloned.

*Call graph*: calls 5 internal fn (ensure_git_success, git_command, git_path_arg, git_worktree_revision, run_git_command_with_timeout); called by 1 (upgrade_configured_git_marketplace).


##### `git_worktree_revision`  (lines 112–130)

```
fn git_worktree_revision(destination: &Path, timeout: Duration) -> Result<String, String>
```

**Purpose**: Reads the exact commit ID currently checked out in a cloned repository. This gives the upgrade code a reliable record of what ended up on disk.

**Data flow**: It receives a repository folder and a timeout. It runs `git rev-parse HEAD` inside that folder, verifies that Git succeeded, trims the command output, and returns the commit ID. If Git returns no commit text, it reports that as an error.

**Call relations**: This is called by `clone_git_source` after cloning and checkout are complete. It uses the same Git process builder, timeout runner, and success checker as the rest of the file so revision lookup behaves consistently with clone and remote lookup.

*Call graph*: calls 3 internal fn (ensure_git_success, git_command, run_git_command_with_timeout); called by 1 (clone_git_source); 1 external calls (from_utf8_lossy).


##### `is_full_git_sha`  (lines 132–134)

```
fn is_full_git_sha(value: &str) -> bool
```

**Purpose**: Checks whether a string already looks like a complete Git commit ID. A full Git commit ID is 40 hexadecimal characters, meaning digits 0-9 and letters a-f/A-F.

**Data flow**: It receives a text value. It checks the length and verifies every character is a hexadecimal character. It returns `true` if both checks pass, otherwise `false`.

**Call relations**: `git_remote_revision` uses this as a shortcut. When the caller already supplied an exact commit ID, the upgrade does not need to contact the remote repository just to resolve it.

*Call graph*: called by 1 (git_remote_revision).


##### `git_command`  (lines 136–142)

```
fn git_command() -> Command
```

**Purpose**: Creates a new command configured to run the system `git` program in a non-interactive, stable way. Non-interactive means Git should fail instead of asking the user questions at a terminal.

**Data flow**: It creates a `Command` for `git`, then sets two environment variables: one disables optional Git locks, and the other disables terminal prompts. It returns the prepared command so callers can add subcommands and arguments.

**Call relations**: All Git actions in this file start here, including remote lookup, clone, checkout, sparse checkout, and revision lookup. A test also calls it to confirm it uses normal path lookup for `git` and sets the intended environment variables.

*Call graph*: called by 4 (clone_git_source, git_remote_revision, git_worktree_revision, git_command_uses_path_lookup_with_stable_noninteractive_env); 1 external calls (new).


##### `git_path_arg`  (lines 152–154)

```
fn git_path_arg(path: &Path) -> PathBuf
```

**Purpose**: Converts a local filesystem path into a form that can safely be passed to Git. This is mainly important on Windows, where some paths can have a special long-path prefix that Git may not accept.

**Data flow**: It receives a path. On Windows, it turns the path into text, tries to remove the special verbatim prefix, and returns the cleaned path if possible; otherwise it returns the original path. On non-Windows systems, it simply returns a copy of the original path.

**Call relations**: `clone_git_source` uses this before passing the destination folder to Git. On Windows it delegates the actual prefix removal to `strip_windows_verbatim_path_prefix`.

*Call graph*: calls 1 internal fn (strip_windows_verbatim_path_prefix); called by 1 (clone_git_source); 2 external calls (to_path_buf, to_string_lossy).


##### `strip_windows_verbatim_path_prefix`  (lines 157–164)

```
fn strip_windows_verbatim_path_prefix(path: &str) -> Option<String>
```

**Purpose**: Removes Windows' special `\\?\` path prefix from a path string when present. This helps convert long-path forms into the more ordinary forms Git expects.

**Data flow**: It receives a path as text. If the path begins with `\\?\`, it removes that prefix. If the remaining path begins with `UNC\`, it turns it into a normal network path beginning with `\\`; otherwise it returns the stripped local path. If there is no verbatim prefix, it returns nothing.

**Call relations**: `git_path_arg` uses this during Windows path preparation. The tests call it directly to prove disk paths, network paths, and ordinary paths are treated correctly.

*Call graph*: called by 1 (git_path_arg).


##### `run_git_command_with_timeout`  (lines 166–207)

```
fn run_git_command_with_timeout(
    command: &mut Command,
    context: &str,
    timeout: Duration,
) -> Result<Output, String>
```

**Purpose**: Runs a prepared Git command while enforcing a time limit. This prevents marketplace upgrades from hanging forever because of a slow network, a stuck Git process, or an unexpected prompt.

**Data flow**: It receives a command, a short human-readable context string, and a timeout. It starts the process with no standard input, captures standard output and standard error, then polls until the process exits. If it finishes in time, it returns the captured output. If the timeout is reached, it kills the process, collects any error text, and returns a timeout message.

**Call relations**: The higher-level Git operations call this whenever they need to run Git. It does not decide whether Git succeeded; after it returns output, callers pass that output to `ensure_git_success` for status checking.

*Call graph*: called by 3 (clone_git_source, git_remote_revision, git_worktree_revision); 8 external calls (from_millis, null, piped, from_utf8_lossy, stdin, format!, sleep, now).


##### `ensure_git_success`  (lines 209–222)

```
fn ensure_git_success(output: &Output, context: &str) -> Result<(), String>
```

**Purpose**: Turns Git's exit status into a clear success or error result. Git may produce output even when it fails, so this function is the common checkpoint after each command.

**Data flow**: It receives captured process output and a context label. If the exit status means success, it returns success. If not, it reads Git's standard error text, trims it, and returns an error message that includes the status and, when available, Git's own explanation.

**Call relations**: `git_remote_revision`, `clone_git_source`, and `git_worktree_revision` call this after running Git commands. This keeps failure reporting consistent across remote lookup, clone, checkout, sparse checkout, and revision lookup.

*Call graph*: called by 3 (clone_git_source, git_remote_revision, git_worktree_revision); 2 external calls (from_utf8_lossy, format!).


##### `tests::full_git_sha_ref_is_already_a_remote_revision`  (lines 233–237)

```
fn full_git_sha_ref_is_already_a_remote_revision()
```

**Purpose**: Checks that full commit IDs are recognized correctly and shorter or named references are not mistaken for exact commits.

**Data flow**: It feeds `is_full_git_sha` one valid 40-character hexadecimal string, a branch-like name, and a short hexadecimal string. It expects only the full-length commit ID to be accepted.

**Call relations**: This protects the shortcut used by `git_remote_revision`. If this behavior changed, the upgrader might either make unnecessary remote Git calls or wrongly trust an imprecise reference.

*Call graph*: 1 external calls (assert!).


##### `tests::git_command_uses_path_lookup_with_stable_noninteractive_env`  (lines 240–253)

```
fn git_command_uses_path_lookup_with_stable_noninteractive_env()
```

**Purpose**: Verifies that Git commands are built in the expected safe way. In particular, Git should be found through the normal system path and should not try to prompt a user interactively.

**Data flow**: It creates a command with `git_command`, then inspects its program name and environment settings. It expects the program to be `git`, the non-interactive environment variables to be set, and `PATH` not to be overridden.

**Call relations**: This test directly exercises `git_command`. It uses `tests::command_env` to inspect environment variables stored on the command object.

*Call graph*: calls 1 internal fn (git_command); 1 external calls (assert_eq!).


##### `tests::strips_windows_verbatim_disk_prefix_for_git`  (lines 256–261)

```
fn strips_windows_verbatim_disk_prefix_for_git()
```

**Purpose**: Confirms that a Windows local disk path with the `\\?\` prefix is converted into a normal-looking disk path.

**Data flow**: It passes a verbatim Windows path like `\\?\C:\...` into `strip_windows_verbatim_path_prefix`. It expects the returned text to drop the special prefix and keep the rest of the path.

**Call relations**: This test protects the Windows path cleanup used indirectly by `clone_git_source` through `git_path_arg`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::strips_windows_verbatim_unc_prefix_for_git`  (lines 264–269)

```
fn strips_windows_verbatim_unc_prefix_for_git()
```

**Purpose**: Confirms that a Windows network path with the verbatim UNC form is converted into a normal network path.

**Data flow**: It passes a path beginning with `\\?\UNC\server\share...` into `strip_windows_verbatim_path_prefix`. It expects the result to begin with `\\server\share...`, which is the usual Windows network path form.

**Call relations**: This test protects the network-path branch of `strip_windows_verbatim_path_prefix`, which supports `git_path_arg` on Windows.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::leaves_non_verbatim_path_without_rewrite`  (lines 272–274)

```
fn leaves_non_verbatim_path_without_rewrite()
```

**Purpose**: Checks that ordinary Windows paths are not changed by the verbatim-prefix stripper.

**Data flow**: It passes a normal path such as `C:\Users\alice` into `strip_windows_verbatim_path_prefix`. It expects no rewritten path to be returned.

**Call relations**: This test helps ensure `git_path_arg` only rewrites the special paths that need rewriting and leaves normal paths alone.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::command_env`  (lines 276–284)

```
fn command_env(
        command: &'a std::process::Command,
        name: &str,
    ) -> Option<Option<&'a OsStr>>
```

**Purpose**: Looks up one environment variable on a prepared command during tests. It is a small test helper, not part of the production Git workflow.

**Data flow**: It receives a command object and an environment variable name. It scans the command's configured environment entries and returns the value if that variable was explicitly set, or no result if it was not set.

**Call relations**: `tests::git_command_uses_path_lookup_with_stable_noninteractive_env` uses this helper to check the environment variables added by `git_command`.

*Call graph*: 1 external calls (get_envs).


### `core-plugins/src/marketplace_upgrade.rs`

`orchestration` · `startup or explicit marketplace upgrade`

A marketplace is a collection of plugins. In this file, the project treats some marketplaces like subscribed folders from Git, which is a version-control system used to fetch code from a remote source. The goal is to keep those configured marketplaces up to date without corrupting the user's setup.

The file first reads the user's effective configuration and selects only marketplaces whose source type is Git. It ignores non-Git entries, because those are updated by other paths. For each selected marketplace, it asks the remote Git source what revision is current. A revision is like a precise receipt number for a version of the files. If the local copy already has the same revision and matching install metadata, nothing is changed.

When an upgrade is needed, the file downloads the marketplace into a temporary staging directory, validates that it really is a marketplace, checks that its declared name matches the configured name, writes install metadata, and then activates it by replacing the old installed copy. This is like unpacking a delivery in the garage, checking it, and only then moving it into the shop window.

One important safety check happens just before recording the upgrade: the file rereads the user's config to make sure the marketplace was not edited or removed while the download was happening. That prevents an old background upgrade from overwriting a newer user choice.

#### Function details

##### `ConfiguredMarketplaceUpgradeOutcome::all_succeeded`  (lines 51–53)

```
fn all_succeeded(&self) -> bool
```

**Purpose**: This small helper answers whether an upgrade run finished without any marketplace errors. It is useful for callers that only need a simple yes-or-no result.

**Data flow**: It reads the outcome's list of errors. If that list is empty, it returns true; if any error was recorded, it returns false. It does not change the outcome.

**Call relations**: After an upgrade run has produced a ConfiguredMarketplaceUpgradeOutcome, other code can call this method to decide whether the whole batch should be treated as successful.


##### `configured_git_marketplace_names`  (lines 56–63)

```
fn configured_git_marketplace_names(config_layer_stack: &ConfigLayerStack) -> Vec<String>
```

**Purpose**: This returns the names of all marketplaces in the user's config that are backed by Git. It is used when another part of the system needs to know which configured marketplaces are eligible for Git-based upgrading.

**Data flow**: It receives the layered configuration, asks configured_git_marketplaces to extract the Git marketplace entries, keeps only their names, sorts those names, and returns the sorted list.

**Call relations**: upgrade_configured_marketplaces_for_config calls this when it needs the set of configured Git marketplace names. This function relies on configured_git_marketplaces for the real config-reading and filtering work, then turns the result into a simple name list.

*Call graph*: calls 1 internal fn (configured_git_marketplaces); called by 1 (upgrade_configured_marketplaces_for_config).


##### `upgrade_configured_git_marketplaces`  (lines 65–103)

```
fn upgrade_configured_git_marketplaces(
    codex_home: &Path,
    config_layer_stack: &ConfigLayerStack,
    marketplace_name: Option<&str>,
) -> ConfiguredMarketplaceUpgradeOutcome
```

**Purpose**: This is the batch upgrader for Git-backed marketplaces. It chooses the marketplaces to update, runs the per-marketplace upgrade process, and collects successes and errors into one report.

**Data flow**: It takes the Codex home directory, the current configuration stack, and optionally one marketplace name to target. It reads all configured Git marketplaces, filters to the requested name if one was provided, computes the install folder, then tries to upgrade each marketplace. It returns an outcome containing the selected marketplace names, the installed roots that changed, and any error messages.

**Call relations**: upgrade_configured_marketplaces_for_config calls this as part of the larger marketplace upgrade flow. This function calls configured_git_marketplaces to discover work, marketplace_install_root to choose where installs live, and upgrade_configured_git_marketplace for the detailed one-at-a-time update. It is the loop that turns individual upgrade attempts into a batch result.

*Call graph*: calls 3 internal fn (configured_git_marketplaces, marketplace_install_root, upgrade_configured_git_marketplace); called by 1 (upgrade_configured_marketplaces_for_config); 2 external calls (new, default).


##### `marketplace_install_root`  (lines 105–107)

```
fn marketplace_install_root(codex_home: &Path) -> PathBuf
```

**Purpose**: This builds the directory path where auto-installed marketplaces are stored under the Codex home directory. Keeping this path in one function prevents different parts of the upgrader from inventing different install locations.

**Data flow**: It receives the Codex home path and appends the fixed subdirectory .tmp/marketplaces. It returns that combined path and does not touch the filesystem.

**Call relations**: upgrade_configured_git_marketplaces calls this before processing marketplaces, then passes the resulting install root down into each per-marketplace upgrade.

*Call graph*: called by 1 (upgrade_configured_git_marketplaces); 1 external calls (join).


##### `configured_git_marketplaces`  (lines 109–135)

```
fn configured_git_marketplaces(
    config_layer_stack: &ConfigLayerStack,
) -> Vec<ConfiguredGitMarketplace>
```

**Purpose**: This reads the user's effective config and turns valid Git marketplace entries into internal upgrade records. It is the filter that decides which configured marketplaces this file is responsible for.

**Data flow**: It receives the layered config stack. It looks for the effective user config, then for a marketplaces table inside it. If that table cannot be understood, it logs a warning and returns no marketplaces. Otherwise it converts entries into ConfiguredGitMarketplace values, keeps only Git ones, sorts them by name, and returns them.

**Call relations**: configured_git_marketplace_names calls this when it needs just names, and upgrade_configured_git_marketplaces calls it when it needs full upgrade details. It is the shared discovery step for this file.

*Call graph*: calls 1 internal fn (effective_user_config); called by 2 (configured_git_marketplace_names, upgrade_configured_git_marketplaces); 2 external calls (new, warn!).


##### `configured_git_marketplace_from_config`  (lines 137–166)

```
fn configured_git_marketplace_from_config(
    name: String,
    marketplace: MarketplaceConfig,
) -> Option<ConfiguredGitMarketplace>
```

**Purpose**: This converts one marketplace config entry into the internal shape used by the upgrader, but only if that entry is a Git marketplace. It also rejects Git entries that do not say where to fetch from.

**Data flow**: It receives a marketplace name and its parsed config. It checks the source type; if it is not Git, it returns nothing. If it is Git but has no source URL or path, it logs a warning and returns nothing. Otherwise it returns a ConfiguredGitMarketplace containing the name, source, optional branch or tag name, optional sparse paths, and last known revision.

**Call relations**: read_configured_git_marketplace uses this after rereading the user's config from disk, so the same Git-entry rules are applied during the final safety check. The wider discovery path also depends on this conversion behavior when building the list of upgradeable marketplaces.

*Call graph*: called by 1 (read_configured_git_marketplace); 1 external calls (warn!).


##### `upgrade_configured_git_marketplace`  (lines 168–243)

```
fn upgrade_configured_git_marketplace(
    codex_home: &Path,
    install_root: &Path,
    marketplace: &ConfiguredGitMarketplace,
) -> Result<Option<AbsolutePathBuf>, String>
```

**Purpose**: This upgrades one configured Git marketplace safely. It checks whether an update is needed, downloads into a temporary staging area, validates the result, records metadata, and then activates the new copy.

**Data flow**: It receives the Codex home directory, the install root, and one marketplace record. First it validates the marketplace name so it is safe to use as a path segment. It asks the remote Git source for the current revision. If the installed marketplace already has that revision and matching metadata, it returns no upgraded path. Otherwise it creates a staging directory, clones the Git source into it, validates that the staged files form a marketplace with the expected name, writes metadata, updates the user's config with the new revision and timestamp, activates the staged copy at the final destination, and returns that destination as an absolute path. If any step fails, it returns a human-readable error string.

**Call relations**: upgrade_configured_git_marketplaces calls this once per selected marketplace. This function coordinates several specialist helpers: Git helpers find and clone the remote revision, marketplace validation checks the downloaded files, activation helpers swap the staged directory into place, and config helpers record the new revision. Just before recording, it uses ensure_configured_git_marketplace_unchanged so an in-progress upgrade cannot overwrite a config entry that the user changed meanwhile.

*Call graph*: calls 8 internal fn (find_marketplace_manifest_path, validate_marketplace_root, activate_marketplace_root, installed_marketplace_metadata_matches, write_installed_marketplace_metadata, clone_git_source, git_remote_revision, try_from); called by 1 (upgrade_configured_git_marketplaces); 6 external calls (join, now, validate_plugin_segment, format!, create_dir_all, new).


##### `ensure_configured_git_marketplace_unchanged`  (lines 244–260)

```
fn ensure_configured_git_marketplace_unchanged(
    codex_home: &Path,
    expected: &ConfiguredGitMarketplace,
) -> Result<(), String>
```

**Purpose**: This is a race-prevention check. It confirms that the marketplace config still matches what the upgrader started with before the upgrader writes the new revision back to the user's config.

**Data flow**: It receives the Codex home path and the marketplace settings that were used to start the upgrade. It rereads the current config entry from disk. If the current entry still exactly matches, it returns success. If the entry changed, was removed, or is no longer a Git marketplace, it returns an error message.

**Call relations**: upgrade_configured_git_marketplace invokes this during activation, right before recording the upgraded marketplace in config.toml. It delegates the actual reread-and-parse work to read_configured_git_marketplace, then decides whether it is safe to continue.

*Call graph*: calls 1 internal fn (read_configured_git_marketplace); 1 external calls (format!).


##### `read_configured_git_marketplace`  (lines 262–297)

```
fn read_configured_git_marketplace(
    codex_home: &Path,
    marketplace_name: &str,
) -> Result<Option<ConfiguredGitMarketplace>, String>
```

**Purpose**: This reads one marketplace entry directly from the user's config.toml file and returns it only if it is still a valid Git marketplace. It is used for the final safety check during an upgrade.

**Data flow**: It receives the Codex home path and a marketplace name. It builds the config.toml path, reads the file, parses it as TOML, looks for the marketplaces table, and extracts the named entry. If the file or entry is missing, it returns no marketplace. If parsing fails or the marketplaces table is invalid, it returns an error. If the entry exists, it passes it through configured_git_marketplace_from_config and returns the result.

**Call relations**: ensure_configured_git_marketplace_unchanged calls this when an upgrade is about to be committed. This function supplies the current on-disk truth, while configured_git_marketplace_from_config applies the same Git-marketplace rules used elsewhere in the upgrader.

*Call graph*: calls 1 internal fn (configured_git_marketplace_from_config); called by 1 (ensure_configured_git_marketplace_unchanged); 4 external calls (join, format!, read_to_string, from_str).


### `core-plugins/src/marketplace_remove.rs`

`domain_logic` · `request handling`

A “marketplace” here is a named source of plugins. Removing one is not just a matter of deleting a folder: Codex also remembers marketplaces in the user's config file. This file keeps those two places in sync, like removing both a contact from an address book and that contact's downloaded photo folder.

The main flow starts with a request containing the marketplace name. The code first checks that the name is safe to use as a path segment, so a bad name cannot accidentally point outside the marketplace area. It then finds where that marketplace would be installed under the Codex home directory. Before deleting files, it tries to remove the marketplace entry from the user's config.toml file. If the config contains the same letters but different capitalization, the operation is rejected, because that could hide a mistake on systems where file names may or may not be case-sensitive.

After the config step succeeds, the file removal step deletes the installed marketplace root. It can remove either a normal directory or a stray file, which helps clean up broken installs. If neither config nor files existed, the request is treated as invalid. The public async function runs the blocking disk work on a background thread so it does not stall the async runtime.

#### Function details

##### `remove_marketplace`  (lines 29–38)

```
async fn remove_marketplace(
    codex_home: PathBuf,
    request: MarketplaceRemoveRequest,
) -> Result<MarketplaceRemoveOutcome, MarketplaceRemoveError>
```

**Purpose**: This is the async entry point for removing a marketplace. It lets the rest of the program ask for removal without blocking the async task runner while files and config are changed on disk.

**Data flow**: It receives the Codex home directory and a request containing the marketplace name. It moves that work into a blocking background task, calls the synchronous removal routine there, and then returns either the removal result or an internal error if the background task itself failed.

**Call relations**: The command-level removal flow calls this function when the user asks to remove a marketplace. This function does not do the detailed removal itself; it hands the work to remove_marketplace_sync so the slower filesystem operations happen off the main async path.

*Call graph*: called by 1 (run_remove); 1 external calls (spawn_blocking).


##### `remove_marketplace_sync`  (lines 40–74)

```
fn remove_marketplace_sync(
    codex_home: &Path,
    request: MarketplaceRemoveRequest,
) -> Result<MarketplaceRemoveOutcome, MarketplaceRemoveError>
```

**Purpose**: This function performs the real marketplace removal. It checks the requested name, removes the marketplace from the user's config, deletes the installed marketplace files, and reports what was actually removed.

**Data flow**: It starts with a Codex home path and a marketplace name. It validates the name, computes the expected installed location, asks the config layer to remove the saved marketplace entry, rejects exact-name mismatches, then asks remove_marketplace_root to delete the installed root. It returns a MarketplaceRemoveOutcome containing the marketplace name and the removed path, or an error explaining why removal could not safely happen.

**Call relations**: The async wrapper remove_marketplace calls this function in normal use. The tests call it directly so they can check the exact filesystem and config effects. During its work it relies on marketplace_install_root to find the install area, remove_user_marketplace_config to update config.toml, validate_plugin_segment to reject unsafe names, and remove_marketplace_root to delete files.

*Call graph*: calls 2 internal fn (marketplace_install_root, remove_marketplace_root); called by 6 (remove_marketplace_sync_keeps_installed_root_when_config_removal_fails, remove_marketplace_sync_rejects_case_mismatched_configured_name, remove_marketplace_sync_rejects_unknown_marketplace, remove_marketplace_sync_removes_config_and_installed_root, remove_marketplace_sync_removes_file_installed_root, remove_marketplace_sync_removes_inline_config_entry); 4 external calls (remove_user_marketplace_config, validate_plugin_segment, InvalidRequest, format!).


##### `remove_marketplace_root`  (lines 76–105)

```
fn remove_marketplace_root(root: &Path) -> Result<Option<AbsolutePathBuf>, MarketplaceRemoveError>
```

**Purpose**: This helper deletes the installed marketplace path if it exists. It is careful to return the absolute path it removed, and it can clean up either a directory or an unexpected file.

**Data flow**: It receives a filesystem path. If nothing exists there, it returns None. If something does exist, it converts the path to an absolute path for reporting, inspects the filesystem entry, removes it as a whole directory when it is a directory or as a single file otherwise, and returns Some(path) after successful deletion.

**Call relations**: remove_marketplace_sync calls this after the config entry has been removed or confirmed. This helper is the file-deletion part of the larger removal process, keeping the lower-level disk details out of the main decision-making function.

*Call graph*: calls 1 internal fn (try_from); called by 1 (remove_marketplace_sync); 5 external calls (exists, to_path_buf, remove_dir_all, remove_file, symlink_metadata).


##### `tests::remove_marketplace_sync_removes_config_and_installed_root`  (lines 116–156)

```
fn remove_marketplace_sync_removes_config_and_installed_root()
```

**Purpose**: This test proves the normal successful case: a configured and installed marketplace is fully removed. It checks that both the config entry and the installed directory disappear.

**Data flow**: It creates a temporary Codex home, records a marketplace named debug in the config, creates a matching installed directory with a sample marketplace file, then calls remove_marketplace_sync. Afterward it checks that the outcome names debug, reports the removed installed path, removes the config section, and deletes the installed directory.

**Call relations**: This test calls the same synchronous function used by the real removal path. It also uses the config-writing helper and marketplace_install_root to set up a realistic before-state, then verifies that remove_marketplace_sync coordinated config removal and filesystem cleanup correctly.

*Call graph*: calls 2 internal fn (marketplace_install_root, remove_marketplace_sync); 7 external calls (new, assert!, assert_eq!, record_user_marketplace, create_dir_all, read_to_string, write).


##### `tests::remove_marketplace_sync_rejects_unknown_marketplace`  (lines 159–174)

```
fn remove_marketplace_sync_rejects_unknown_marketplace()
```

**Purpose**: This test confirms that removing a marketplace that is neither configured nor installed is treated as a user error. That prevents a silent success when nothing was actually removed.

**Data flow**: It creates an empty temporary Codex home and asks remove_marketplace_sync to remove debug. Since there is no config entry and no installed root, the function returns an error, and the test checks that the message says the marketplace is not configured or installed.

**Call relations**: This test exercises the final safety check inside remove_marketplace_sync. It shows that the function only reports success when it made a real change to config, disk, or both.

*Call graph*: calls 1 internal fn (remove_marketplace_sync); 2 external calls (new, assert_eq!).


##### `tests::remove_marketplace_sync_rejects_case_mismatched_configured_name`  (lines 177–211)

```
fn remove_marketplace_sync_rejects_case_mismatched_configured_name()
```

**Purpose**: This test checks that marketplace names must match the configured capitalization exactly. This avoids confusing or unsafe behavior across filesystems with different case rules.

**Data flow**: It creates a temporary Codex home, records a marketplace as debug, and creates its installed directory. It then tries to remove Debug with an uppercase D. The call returns an error, and the test verifies that the installed directory and config entry are still present.

**Call relations**: This test drives the case-mismatch branch in remove_marketplace_sync, which depends on the config removal helper reporting that a similarly named marketplace exists with different capitalization. It confirms that the removal flow stops before deleting installed files.

*Call graph*: calls 2 internal fn (marketplace_install_root, remove_marketplace_sync); 6 external calls (new, assert!, assert_eq!, record_user_marketplace, create_dir_all, read_to_string).


##### `tests::remove_marketplace_sync_keeps_installed_root_when_config_removal_fails`  (lines 214–237)

```
fn remove_marketplace_sync_keeps_installed_root_when_config_removal_fails()
```

**Purpose**: This test proves that file deletion does not happen if the config file cannot be safely edited. That matters because deleting installed files while leaving a broken config change half-done would make recovery harder.

**Data flow**: It writes an invalid config.toml file into a temporary Codex home, creates an installed marketplace directory, and calls remove_marketplace_sync. The function returns an error about failing to remove the config entry, and the test checks that the installed directory still exists.

**Call relations**: This test checks the ordering inside remove_marketplace_sync. Because config removal is attempted before remove_marketplace_root is called, a config parsing or editing failure stops the process before any installed files are removed.

*Call graph*: calls 2 internal fn (marketplace_install_root, remove_marketplace_sync); 4 external calls (new, assert!, create_dir_all, write).


##### `tests::remove_marketplace_sync_removes_file_installed_root`  (lines 240–280)

```
fn remove_marketplace_sync_removes_file_installed_root()
```

**Purpose**: This test makes sure cleanup still works when the installed marketplace path is a file instead of a directory. That can happen after a corrupt or interrupted install, and the remover should still be able to clean it up.

**Data flow**: It creates a temporary Codex home, records a debug marketplace in config, then writes a plain file at the expected install path instead of creating a directory there. After calling remove_marketplace_sync, it checks that the outcome reports the removed path, the file is gone, and the config entry is gone.

**Call relations**: This test focuses on remove_marketplace_root as used by remove_marketplace_sync. It confirms that the helper chooses file deletion when the installed root is not a directory, while the overall removal flow still updates config correctly.

*Call graph*: calls 2 internal fn (marketplace_install_root, remove_marketplace_sync); 7 external calls (new, assert!, assert_eq!, record_user_marketplace, create_dir_all, read_to_string, write).


##### `tests::remove_marketplace_sync_removes_inline_config_entry`  (lines 283–312)

```
fn remove_marketplace_sync_removes_inline_config_entry()
```

**Purpose**: This test verifies that marketplace removal works even when the config stores the marketplace entry in an inline TOML table rather than a separate section. In plain terms, it checks that both supported config shapes can be cleaned up.

**Data flow**: It writes a config.toml containing an inline marketplace entry for debug, creates the installed root, and calls remove_marketplace_sync. It then checks that the returned outcome names debug, the installed root was removed, and the config file no longer contains the debug entry.

**Call relations**: This test relies on remove_marketplace_sync delegating config editing to remove_user_marketplace_config. It confirms that the main removal flow does not care about the exact text layout of the config file as long as the config layer can remove the marketplace entry.

*Call graph*: calls 2 internal fn (marketplace_install_root, remove_marketplace_sync); 6 external calls (new, assert!, assert_eq!, create_dir_all, read_to_string, write).


### Remote bundles and sharing
These files implement remote plugin transport, bundle installation and syncing, legacy backend compatibility, and workspace-plugin sharing and checkout flows.

### `core-plugins/src/remote_bundle.rs`

`domain_logic` · `plugin install, sync, and checkout flows`

Remote plugins arrive as compressed bundles from a backend service. This file is the safety gate and assembly line for those bundles. First it checks that the backend gave enough information: a usable plugin name, a valid version, and a secure download URL. It only accepts HTTPS URLs in normal use, with a narrow localhost exception for debug tests.

Once a bundle is approved, the file downloads it with a timeout and a maximum size, so a bad server cannot make the app wait forever or fill memory. It also checks redirected URLs, because a safe-looking URL could otherwise point somewhere unsafe after the request starts.

After download, the work moves to a blocking task because unpacking files is disk-heavy and should not stall the async runtime. The bundle is extracted into a temporary staging folder, checked for a standard plugin root containing plugin.json, and then installed through PluginStore. For globally curated remote plugins, the backend’s version and optional app manifest are written into the extracted files before install. Think of this file like a package receiving desk: it checks the shipping label, refuses oversized or suspicious packages, opens them in a quarantine area, verifies the contents, and only then puts them on the shelf.

#### Function details

##### `RemotePluginBundleInstallError::io`  (lines 131–133)

```
fn io(context: &'static str, source: io::Error) -> Self
```

**Purpose**: Builds a consistent error value for ordinary file-system failures. It lets the rest of the file attach a plain explanation, such as which file operation failed, to the original input/output error.

**Data flow**: It receives a short context message and an operating-system I/O error → wraps both into the file’s remote bundle install error type → returns that error for callers to pass upward.

**Call relations**: The install, extract, and JSON-writing paths use this helper whenever creating directories, reading files, writing files, or renaming folders fails, so all those failures look the same to higher-level code.


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

**Purpose**: Checks the backend’s description of a remote plugin before any download begins. It makes sure the local plugin identity, release version, and bundle URL are all usable and safe.

**Data flow**: It receives the remote plugin id, marketplace name, plugin name, optional version, optional download URL, and optional app manifest → trims and validates the version, parses and checks the URL, and builds a PluginId → returns a ValidatedRemotePluginBundle or a specific reason why the bundle must be rejected.

**Call relations**: Remote install, sync, checkout, and tests call this as the first gate. It relies on the version validator and URL checks before handing a trusted bundle plan to the download and install functions.

*Call graph*: calls 4 internal fn (allow_test_loopback_http_bundle_downloads, is_allowed_bundle_download_url, validate_plugin_version_segment, new); called by 10 (remote_plugin_install_response, sync_remote_installed_plugin_bundles_once, checkout_remote_plugin_share, install_preserves_non_global_bundle_manifest_metadata, valid_remote_plugin_bundle, validate_remote_plugin_bundle_rejects_invalid_release_version, validate_remote_plugin_bundle_rejects_missing_download_url, validate_remote_plugin_bundle_rejects_missing_release_version, validate_remote_plugin_bundle_rejects_unsupported_download_url_scheme, validate_remote_plugin_bundle_uses_detail_name_for_local_plugin_id); 1 external calls (parse).


##### `allow_test_loopback_http_bundle_downloads`  (lines 198–207)

```
fn allow_test_loopback_http_bundle_downloads() -> bool
```

**Purpose**: Decides whether plain HTTP downloads are allowed for local test servers. In normal use it returns false, keeping downloads restricted to secure HTTPS.

**Data flow**: It reads a debug-only environment variable → accepts HTTP only when running a debug build and the variable is exactly set to 1 → returns a yes/no answer.

**Call relations**: The validation and download code call this before deciding whether an HTTP localhost URL is acceptable. It exists so tests can use local servers without weakening production behavior.

*Call graph*: called by 2 (download_remote_plugin_bundle_with_limit, validate_remote_plugin_bundle); 1 external calls (var).


##### `is_allowed_bundle_download_url`  (lines 209–215)

```
fn is_allowed_bundle_download_url(url: &Url, allow_loopback_http: bool) -> bool
```

**Purpose**: Answers whether a bundle URL uses an acceptable scheme. HTTPS is always allowed; HTTP is only allowed for loopback addresses when the caller has explicitly allowed that test mode.

**Data flow**: It receives a parsed URL and a boolean saying whether local HTTP is allowed → checks the URL scheme and, for HTTP, whether the host is loopback → returns true for allowed URLs and false otherwise.

**Call relations**: Validation uses it before accepting a backend URL, and download uses it again after redirects. It delegates the localhost decision to is_loopback_url.

*Call graph*: calls 1 internal fn (is_loopback_url); called by 2 (download_remote_plugin_bundle_with_limit, validate_remote_plugin_bundle); 1 external calls (scheme).


##### `is_loopback_url`  (lines 217–224)

```
fn is_loopback_url(url: &Url) -> bool
```

**Purpose**: Checks whether a URL points back to the same machine, such as localhost or 127.0.0.1. This is used only for test-only HTTP exceptions.

**Data flow**: It receives a parsed URL → looks at its host name or IP address → returns true for localhost, IPv4 loopback, or IPv6 loopback, and false for anything else.

**Call relations**: is_allowed_bundle_download_url calls this when deciding if an HTTP URL can be accepted in debug testing.

*Call graph*: called by 1 (is_allowed_bundle_download_url); 1 external calls (host).


##### `download_and_install_remote_plugin_bundle`  (lines 226–244)

```
async fn download_and_install_remote_plugin_bundle(
    codex_home: PathBuf,
    bundle: ValidatedRemotePluginBundle,
) -> Result<PluginInstallResult, RemotePluginBundleInstallError>
```

**Purpose**: Downloads a validated remote plugin bundle and installs it into the local plugin store. It is the main high-level path for turning a backend-approved bundle into an installed plugin.

**Data flow**: It receives the Codex home folder and a validated bundle plan → downloads the archive bytes within the configured size limit → moves the disk-heavy install work to a blocking worker task → returns the PluginInstallResult or a download/install error.

**Call relations**: Remote install and sync flows call this after validation. It hands downloading to download_remote_plugin_bundle_with_limit and installation to install_remote_plugin_bundle.

*Call graph*: calls 1 internal fn (download_remote_plugin_bundle_with_limit); called by 2 (remote_plugin_install_response, sync_remote_installed_plugin_bundles_once); 1 external calls (spawn_blocking).


##### `download_and_extract_remote_plugin_bundle_to_path`  (lines 246–264)

```
async fn download_and_extract_remote_plugin_bundle_to_path(
    bundle: ValidatedRemotePluginBundle,
    destination: AbsolutePathBuf,
) -> Result<AbsolutePathBuf, RemotePluginBundleInstallError>
```

**Purpose**: Downloads a validated remote plugin bundle and checks it out into a chosen destination folder instead of installing it into the store. This supports flows that need a local copy of a shared remote plugin.

**Data flow**: It receives a validated bundle and an absolute destination path → downloads the archive bytes → runs extraction and destination activation in a blocking worker task → returns the destination path when successful.

**Call relations**: The remote plugin share checkout flow calls this. It shares the same download helper as installation, then hands off to extract_remote_plugin_bundle_to_path for the file work.

*Call graph*: calls 1 internal fn (download_remote_plugin_bundle_with_limit); called by 1 (checkout_remote_plugin_share); 1 external calls (spawn_blocking).


##### `download_remote_plugin_bundle_with_limit`  (lines 266–307)

```
async fn download_remote_plugin_bundle_with_limit(
    bundle_download_url: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, RemotePluginBundleInstallError>
```

**Purpose**: Fetches the bundle bytes from the network while enforcing security and size rules. It prevents unsafe redirects, failed HTTP responses, and oversized downloads from reaching the installer.

**Data flow**: It receives a bundle download URL and a maximum byte count → builds an HTTP client, sends a GET request with a timeout, verifies the final redirected URL, checks the status code, and reads the body with a limit → returns the downloaded bytes or a detailed download error.

**Call relations**: Both high-level download functions call this first. It uses the URL policy helpers and read_response_body_with_limit to keep the network step bounded and safe.

*Call graph*: calls 4 internal fn (allow_test_loopback_http_bundle_downloads, is_allowed_bundle_download_url, read_response_body_with_limit, build_reqwest_client); called by 2 (download_and_extract_remote_plugin_bundle_to_path, download_and_install_remote_plugin_bundle); 1 external calls (from_utf8_lossy).


##### `read_response_body_with_limit`  (lines 309–334)

```
async fn read_response_body_with_limit(
    mut response: Response,
    url: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, RemotePluginBundleInstallError>
```

**Purpose**: Reads an HTTP response body without letting it grow past a chosen maximum. This protects memory even when the server does not honestly report its size up front.

**Data flow**: It receives a response, its URL for error messages, and a maximum byte count → checks the Content-Length header if present, then reads chunks one by one while counting bytes → returns the collected bytes or an error if reading fails or the limit is crossed.

**Call relations**: download_remote_plugin_bundle_with_limit calls this for both successful bundle bodies and small error bodies. It relies on enforce_download_size_limit before and during reading.

*Call graph*: calls 1 internal fn (enforce_download_size_limit); called by 1 (download_remote_plugin_bundle_with_limit); 3 external calls (new, chunk, content_length).


##### `enforce_download_size_limit`  (lines 336–348)

```
fn enforce_download_size_limit(
    url: &str,
    bytes: u64,
    max_bytes: u64,
) -> Result<(), RemotePluginBundleInstallError>
```

**Purpose**: Rejects a download when its known or accumulated size is too large. It is a small guardrail used while reading network data.

**Data flow**: It receives a URL, a byte count, and a maximum byte count → compares the count with the maximum → returns success if it fits or a DownloadTooLarge error if it does not.

**Call relations**: read_response_body_with_limit calls this repeatedly as data arrives. A unit test calls it directly to confirm oversized downloads are rejected.

*Call graph*: called by 2 (read_response_body_with_limit, download_size_limit_rejects_oversized_bundle).


##### `install_remote_plugin_bundle`  (lines 350–385)

```
fn install_remote_plugin_bundle(
    codex_home: PathBuf,
    bundle: ValidatedRemotePluginBundle,
    bundle_bytes: Vec<u8>,
) -> Result<PluginInstallResult, RemotePluginBundleInstallError>
```

**Purpose**: Unpacks a downloaded bundle in a temporary staging area, prepares its metadata, and installs it into PluginStore. It keeps half-extracted files away from the real plugin store until the bundle passes checks.

**Data flow**: It receives the Codex home folder, validated bundle information, and archive bytes → creates a staging directory, extracts the archive, finds the plugin root, optionally rewrites trusted metadata, converts the path to an absolute path, and asks PluginStore to install it with the backend version → returns the install result.

**Call relations**: download_and_install_remote_plugin_bundle runs this inside a blocking task. Tests also call it directly to check invalid archives, missing manifests, and metadata preservation.

*Call graph*: calls 5 internal fn (extract_plugin_bundle_tar_gz, find_extracted_plugin_root, prepare_extracted_remote_plugin_root, try_new, try_from); called by 3 (install_preserves_non_global_bundle_manifest_metadata, install_rejects_bundle_without_standard_plugin_root, install_rejects_invalid_tar_gz_bundle); 3 external calls (join, create_dir_all, new).


##### `extract_remote_plugin_bundle_to_path`  (lines 387–442)

```
fn extract_remote_plugin_bundle_to_path(
    bundle: ValidatedRemotePluginBundle,
    bundle_bytes: Vec<u8>,
    destination: AbsolutePathBuf,
) -> Result<AbsolutePathBuf, RemotePluginBundleInstallErr
```

**Purpose**: Extracts a remote plugin bundle into a specific checkout directory. It verifies the destination is unused and that the bundle’s plugin.json name matches the expected plugin name.

**Data flow**: It receives validated bundle data, archive bytes, and an absolute destination → refuses an existing destination, creates the parent folder, extracts into a temporary sibling directory, verifies the plugin root and manifest name, then renames the temporary directory into place → returns the destination path.

**Call relations**: download_and_extract_remote_plugin_bundle_to_path uses this after downloading. It shares the same extraction and root-finding helpers used by the install path.

*Call graph*: calls 4 internal fn (load_plugin_manifest, extract_plugin_bundle_tar_gz, find_extracted_plugin_root, as_path); 5 external calls (InvalidBundle, format!, create_dir_all, rename, new).


##### `prepare_extracted_remote_plugin_root`  (lines 444–457)

```
fn prepare_extracted_remote_plugin_root(
    plugin_root: &Path,
    bundle: &ValidatedRemotePluginBundle,
) -> Result<(), RemotePluginBundleInstallError>
```

**Purpose**: Applies backend-provided metadata to an extracted plugin when the plugin comes from the global remote marketplace. Other marketplaces keep the metadata already inside the bundle.

**Data flow**: It receives the extracted plugin root and validated bundle details → checks the marketplace name → for global remote plugins, overwrites plugin.json version and optionally writes the app manifest → returns success or the first write/validation error.

**Call relations**: install_remote_plugin_bundle calls this after extraction and before installing into PluginStore. It hands the actual file updates to overwrite_plugin_manifest_version and overwrite_plugin_app_manifest.

*Call graph*: calls 2 internal fn (overwrite_plugin_app_manifest, overwrite_plugin_manifest_version); called by 1 (install_remote_plugin_bundle).


##### `overwrite_plugin_manifest_version`  (lines 459–490)

```
fn overwrite_plugin_manifest_version(
    plugin_root: &Path,
    plugin_version: &str,
) -> Result<(), RemotePluginBundleInstallError>
```

**Purpose**: Rewrites the plugin’s plugin.json file so its version matches the backend release version. This lets trusted backend release metadata be the source of truth for global remote plugins.

**Data flow**: It receives the plugin root and desired version → finds plugin.json, reads and parses it as JSON, confirms it is a JSON object, replaces or adds the version field, and writes it back neatly → returns success or an error.

**Call relations**: prepare_extracted_remote_plugin_root calls this for global remote plugins. It uses write_json_file for the final disk write.

*Call graph*: calls 1 internal fn (write_json_file); called by 1 (prepare_extracted_remote_plugin_root); 5 external calls (String, find_plugin_manifest_path, InvalidBundle, read_to_string, from_str).


##### `overwrite_plugin_app_manifest`  (lines 492–504)

```
fn overwrite_plugin_app_manifest(
    plugin_root: &Path,
    app_manifest: &JsonValue,
) -> Result<(), RemotePluginBundleInstallError>
```

**Purpose**: Writes the app manifest supplied by the backend into the extracted plugin. If the plugin manifest names a custom app manifest path, it uses that; otherwise it writes .app.json at the plugin root.

**Data flow**: It receives the plugin root and app manifest JSON → loads the plugin manifest to find the configured app path if one exists → writes the supplied JSON to that path → returns success or a file/JSON error.

**Call relations**: prepare_extracted_remote_plugin_root calls this only when the validated bundle includes an app manifest. It delegates writing to write_json_file.

*Call graph*: calls 2 internal fn (load_plugin_manifest, write_json_file); called by 1 (prepare_extracted_remote_plugin_root).


##### `write_json_file`  (lines 506–526)

```
fn write_json_file(
    path: &Path,
    value: &JsonValue,
    context: &'static str,
) -> Result<(), RemotePluginBundleInstallError>
```

**Purpose**: Writes a JSON value to disk in a readable, pretty-printed format. It also creates the parent directory when needed.

**Data flow**: It receives a file path, a JSON value, and an error-context message → verifies the path has a parent, creates that parent directory, serializes the JSON with indentation plus a final newline, and writes the bytes → returns success or a clear error.

**Call relations**: The two metadata overwrite functions use this helper so manifest writes behave consistently.

*Call graph*: called by 2 (overwrite_plugin_app_manifest, overwrite_plugin_manifest_version); 4 external calls (parent, create_dir_all, write, to_vec_pretty).


##### `extract_plugin_bundle_tar_gz`  (lines 528–537)

```
fn extract_plugin_bundle_tar_gz(
    bytes: &[u8],
    destination: &Path,
) -> Result<(), RemotePluginBundleInstallError>
```

**Purpose**: Extracts a compressed tar.gz plugin archive using the standard remote bundle size limit. A tar.gz is a common archive format: tar groups files together, gzip compresses them.

**Data flow**: It receives archive bytes and a destination folder → calls the lower-level extractor with the configured maximum extracted size → returns success or an unpacking error translated into this file’s error type.

**Call relations**: Install, checkout, and extraction tests call this when they want normal production extraction rules. It is a convenience wrapper around extract_plugin_bundle_tar_gz_with_limits.

*Call graph*: calls 1 internal fn (extract_plugin_bundle_tar_gz_with_limits); called by 5 (extract_remote_plugin_bundle_to_path, install_remote_plugin_bundle, extraction_preserves_executable_permissions, extraction_rejects_tar_path_traversal, extraction_supports_gnu_long_name_entries).


##### `extract_plugin_bundle_tar_gz_with_limits`  (lines 539–555)

```
fn extract_plugin_bundle_tar_gz_with_limits(
    bytes: &[u8],
    destination: &Path,
    max_total_bytes: u64,
) -> Result<(), RemotePluginBundleInstallError>
```

**Purpose**: Unpacks a plugin archive while enforcing a caller-chosen maximum total extracted size. It translates low-level archive errors into remote plugin install errors.

**Data flow**: It receives archive bytes, a destination folder, and a maximum extracted byte count → asks the shared archive unpacker to extract safely → maps oversized, I/O, and invalid-bundle failures into this file’s error enum → returns success or that mapped error.

**Call relations**: extract_plugin_bundle_tar_gz uses this with the production limit, while one test calls it directly with a tiny limit to confirm size protection works.

*Call graph*: calls 1 internal fn (unpack_plugin_bundle_tar_gz); called by 2 (extract_plugin_bundle_tar_gz, extraction_rejects_total_size_over_limit).


##### `find_extracted_plugin_root`  (lines 557–567)

```
fn find_extracted_plugin_root(
    extraction_root: &Path,
) -> Result<PathBuf, RemotePluginBundleInstallError>
```

**Purpose**: Confirms that the extraction directory itself is a valid plugin root. It deliberately rejects bundles where the plugin root is nested inside another folder.

**Data flow**: It receives an extraction root path → checks whether that exact folder contains a discoverable plugin manifest → returns that path if valid, or an invalid-bundle error if not.

**Call relations**: Both install and checkout call this after extraction. Tests verify that a root-level manifest is accepted and a nested plugin folder is rejected.

*Call graph*: calls 1 internal fn (is_standard_plugin_root); called by 3 (extract_remote_plugin_bundle_to_path, install_remote_plugin_bundle, find_extracted_plugin_root_rejects_nested_plugin_root); 2 external calls (to_path_buf, InvalidBundle).


##### `is_standard_plugin_root`  (lines 569–571)

```
fn is_standard_plugin_root(path: &Path) -> bool
```

**Purpose**: Checks whether a folder looks like a standard plugin root by looking for its plugin manifest. This is the small yes/no check behind root validation.

**Data flow**: It receives a path → asks the shared manifest finder whether plugin.json exists in the expected place → returns true when found and false otherwise.

**Call relations**: find_extracted_plugin_root calls this to decide whether the extracted folder is acceptable.

*Call graph*: called by 1 (find_extracted_plugin_root); 1 external calls (find_plugin_manifest_path).


##### `tests::validate_remote_plugin_bundle_uses_detail_name_for_local_plugin_id`  (lines 585–603)

```
fn validate_remote_plugin_bundle_uses_detail_name_for_local_plugin_id()
```

**Purpose**: Tests that validation builds the local plugin identity from the detailed plugin name and marketplace, not from the opaque remote plugin id.

**Data flow**: It supplies valid remote bundle details → runs validate_remote_plugin_bundle → checks the resulting plugin name, marketplace, version, and URL.

**Call relations**: This test exercises the validation path directly and protects the contract expected by remote install callers.

*Call graph*: calls 1 internal fn (validate_remote_plugin_bundle); 1 external calls (assert_eq!).


##### `tests::validate_remote_plugin_bundle_rejects_missing_release_version`  (lines 606–621)

```
fn validate_remote_plugin_bundle_rejects_missing_release_version()
```

**Purpose**: Tests that a bundle without a release version is rejected. Without this, installs could produce ambiguous or unsafe local version folders.

**Data flow**: It passes no release version into validation → receives an error → checks that the error is MissingReleaseVersion.

**Call relations**: This test calls validate_remote_plugin_bundle to cover one of the first backend-data checks.

*Call graph*: calls 1 internal fn (validate_remote_plugin_bundle); 1 external calls (assert!).


##### `tests::validate_remote_plugin_bundle_rejects_invalid_release_version`  (lines 624–639)

```
fn validate_remote_plugin_bundle_rejects_invalid_release_version()
```

**Purpose**: Tests that suspicious release version strings are rejected. The example uses path-like text that must not become part of an install path.

**Data flow**: It passes an invalid version string into validation → validation runs the version-segment checker → the test confirms the InvalidReleaseVersion error.

**Call relations**: This test guards the connection between validate_remote_plugin_bundle and the shared version validator.

*Call graph*: calls 1 internal fn (validate_remote_plugin_bundle); 1 external calls (assert!).


##### `tests::validate_remote_plugin_bundle_rejects_missing_download_url`  (lines 642–657)

```
fn validate_remote_plugin_bundle_rejects_missing_download_url()
```

**Purpose**: Tests that a bundle cannot be validated without a download URL. The installer needs a real archive location before it can proceed.

**Data flow**: It passes a valid version but no URL → validation returns an error → the test checks for MissingBundleDownloadUrl.

**Call relations**: This test exercises the URL-required branch of validate_remote_plugin_bundle.

*Call graph*: calls 1 internal fn (validate_remote_plugin_bundle); 1 external calls (assert!).


##### `tests::validate_remote_plugin_bundle_rejects_unsupported_download_url_scheme`  (lines 660–675)

```
fn validate_remote_plugin_bundle_rejects_unsupported_download_url_scheme()
```

**Purpose**: Tests that ordinary HTTP URLs are rejected before install. This protects users from insecure remote bundle downloads.

**Data flow**: It passes an http:// URL for a non-localhost host → validation checks the URL policy → the test confirms an UnsupportedBundleDownloadUrlScheme error.

**Call relations**: This test covers validate_remote_plugin_bundle together with the allowed-URL helper policy.

*Call graph*: calls 1 internal fn (validate_remote_plugin_bundle); 1 external calls (assert!).


##### `tests::download_size_limit_rejects_oversized_bundle`  (lines 678–690)

```
fn download_size_limit_rejects_oversized_bundle()
```

**Purpose**: Tests the byte-count guard used during downloads. It proves that data larger than the configured maximum is refused.

**Data flow**: It calls enforce_download_size_limit with a current byte count greater than the maximum → receives an error → checks that the error is DownloadTooLarge.

**Call relations**: This test targets the small helper that read_response_body_with_limit depends on while reading network responses.

*Call graph*: calls 1 internal fn (enforce_download_size_limit); 1 external calls (assert!).


##### `tests::install_rejects_invalid_tar_gz_bundle`  (lines 693–705)

```
fn install_rejects_invalid_tar_gz_bundle()
```

**Purpose**: Tests that random bytes are not accepted as a plugin archive. This protects the installer from treating malformed input as a real plugin.

**Data flow**: It creates a temporary Codex home, builds a valid bundle plan, and passes non-archive bytes to install_remote_plugin_bundle → receives an error → checks that the message mentions reading the tar archive failed.

**Call relations**: This test calls the install path directly and relies on valid_remote_plugin_bundle for a reusable valid plan.

*Call graph*: calls 1 internal fn (install_remote_plugin_bundle); 3 external calls (assert!, valid_remote_plugin_bundle, tempdir).


##### `tests::install_rejects_bundle_without_standard_plugin_root`  (lines 708–722)

```
fn install_rejects_bundle_without_standard_plugin_root()
```

**Purpose**: Tests that an archive without a root-level plugin.json is rejected. A plugin bundle must identify itself in the expected place.

**Data flow**: It builds a tar.gz containing only a README → asks install_remote_plugin_bundle to install it → receives an error → checks that the error mentions the missing standard plugin root.

**Call relations**: This test covers install_remote_plugin_bundle, archive creation helpers, extraction, and root validation together.

*Call graph*: calls 1 internal fn (install_remote_plugin_bundle); 4 external calls (assert!, tar_gz_bytes, valid_remote_plugin_bundle, tempdir).


##### `tests::install_preserves_non_global_bundle_manifest_metadata`  (lines 725–794)

```
fn install_preserves_non_global_bundle_manifest_metadata()
```

**Purpose**: Tests that bundles from non-global marketplaces keep their bundled plugin and app manifest contents. Only the install result version should use the backend release version.

**Data flow**: It validates a non-global bundle with backend metadata, builds an archive with its own plugin.json and .app.json, installs it, then reads the installed files → confirms the files still contain the bundled metadata while the result reports the backend version.

**Call relations**: This test calls validate_remote_plugin_bundle and install_remote_plugin_bundle to verify prepare_extracted_remote_plugin_root does nothing for non-global marketplaces.

*Call graph*: calls 2 internal fn (install_remote_plugin_bundle, validate_remote_plugin_bundle); 6 external calls (assert_eq!, tar_gz_bytes, from_str, json!, read_to_string, tempdir).


##### `tests::find_extracted_plugin_root_uses_local_manifest_discovery`  (lines 797–811)

```
fn find_extracted_plugin_root_uses_local_manifest_discovery()
```

**Purpose**: Tests that a folder with a standard .codex-plugin/plugin.json is accepted as the plugin root.

**Data flow**: It creates a temporary folder with the expected manifest file → calls the root-finding behavior through the assertion → confirms the extraction root itself is returned.

**Call relations**: This test protects the positive case for find_extracted_plugin_root and the shared manifest discovery rule.

*Call graph*: 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `tests::find_extracted_plugin_root_rejects_nested_plugin_root`  (lines 814–830)

```
fn find_extracted_plugin_root_rejects_nested_plugin_root()
```

**Purpose**: Tests that a plugin root nested inside another folder is rejected. Remote bundles must unpack directly into the extraction root.

**Data flow**: It creates a temporary extraction folder with plugin.json inside a child directory → calls find_extracted_plugin_root → receives an error and checks the message.

**Call relations**: This test directly exercises find_extracted_plugin_root’s refusal to search for nested plugin roots.

*Call graph*: calls 1 internal fn (find_extracted_plugin_root); 4 external calls (assert!, create_dir_all, write, tempdir).


##### `tests::extraction_rejects_tar_path_traversal`  (lines 833–842)

```
fn extraction_rejects_tar_path_traversal()
```

**Purpose**: Tests that an archive entry cannot escape the destination folder using a path like ../evil.txt. This is an important safety check against overwriting arbitrary files.

**Data flow**: It builds a tar.gz with a raw parent-directory path → tries to extract it → receives an error mentioning escape from the extraction root.

**Call relations**: This test calls extract_plugin_bundle_tar_gz and uses the raw-path archive helper to trigger the lower-level unpacker’s path-safety check.

*Call graph*: calls 1 internal fn (extract_plugin_bundle_tar_gz); 3 external calls (assert!, tar_gz_bytes_with_raw_path, tempdir).


##### `tests::extraction_rejects_total_size_over_limit`  (lines 845–861)

```
fn extraction_rejects_total_size_over_limit()
```

**Purpose**: Tests that extraction stops when the total uncompressed files would exceed the allowed limit. This protects disk space from compressed “small outside, huge inside” archives.

**Data flow**: It creates an archive whose files add up beyond a tiny test limit → calls extract_plugin_bundle_tar_gz_with_limits → checks that the error is ExtractedBundleTooLarge.

**Call relations**: This test targets the custom-limit extraction helper directly.

*Call graph*: calls 1 internal fn (extract_plugin_bundle_tar_gz_with_limits); 3 external calls (assert!, tar_gz_bytes, tempdir).


##### `tests::extraction_supports_gnu_long_name_entries`  (lines 864–878)

```
fn extraction_supports_gnu_long_name_entries()
```

**Purpose**: Tests that archives using GNU tar long-name entries can still be extracted. Some valid tar files need this format for long paths.

**Data flow**: It builds an archive containing a deeply nested long path → extracts it → reads the resulting file and confirms its contents.

**Call relations**: This test calls extract_plugin_bundle_tar_gz and the normal tar-building helper to verify compatibility with long tar paths.

*Call graph*: calls 1 internal fn (extract_plugin_bundle_tar_gz); 4 external calls (assert_eq!, tar_gz_bytes, format!, tempdir).


##### `tests::extraction_preserves_executable_permissions`  (lines 882–905)

```
fn extraction_preserves_executable_permissions()
```

**Purpose**: On Unix systems, tests that executable files stay executable after extraction. This matters for plugin helper scripts and binaries.

**Data flow**: It creates an archive with a plugin manifest and a helper file marked executable → extracts it → reads the file mode from disk and checks that executable permissions remain.

**Call relations**: This Unix-only test calls extract_plugin_bundle_tar_gz and checks behavior supplied by the archive unpacking layer.

*Call graph*: calls 1 internal fn (extract_plugin_bundle_tar_gz); 4 external calls (assert_eq!, tar_gz_bytes, metadata, tempdir).


##### `tests::valid_remote_plugin_bundle`  (lines 907–917)

```
fn valid_remote_plugin_bundle() -> ValidatedRemotePluginBundle
```

**Purpose**: Creates a reusable valid remote bundle plan for tests. It avoids repeating the same validation setup in multiple test cases.

**Data flow**: It supplies fixed valid plugin details to validate_remote_plugin_bundle → expects validation to succeed → returns the ValidatedRemotePluginBundle.

**Call relations**: Install-related tests call this helper before passing a bundle plan into install_remote_plugin_bundle.

*Call graph*: calls 1 internal fn (validate_remote_plugin_bundle).


##### `tests::tar_gz_bytes`  (lines 919–926)

```
fn tar_gz_bytes(entries: &[(&str, &[u8], u32)]) -> Vec<u8>
```

**Purpose**: Builds an in-memory tar.gz archive for tests from a list of file entries. This lets tests create plugin bundles without fixture files on disk.

**Data flow**: It receives paths, byte contents, and file modes → creates a gzip encoder and tar builder, appends each entry, and finishes the archive → returns the compressed bytes.

**Call relations**: Many extraction and install tests call this helper, which uses append_tar_entry for each file and finish_tar_gz to close the archive.

*Call graph*: 6 external calls (new, new, default, append_tar_entry, finish_tar_gz, new).


##### `tests::tar_gz_bytes_with_raw_path`  (lines 928–947)

```
fn tar_gz_bytes_with_raw_path(path: &str, contents: &[u8], mode: u32) -> Vec<u8>
```

**Purpose**: Builds a special test archive with a manually written raw tar path. It is used to create unusual or unsafe paths that the normal tar builder might clean up or reject.

**Data flow**: It receives a raw path, contents, and mode → writes a tar header and contents directly into a gzip stream, adds padding and an end marker → returns the compressed archive bytes.

**Call relations**: The path-traversal test calls this to make an archive entry like ../evil.txt, then passes the result to extract_plugin_bundle_tar_gz.

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

**Purpose**: Adds one file entry to a test tar archive with the requested path, contents, and permissions. It panics if the test archive cannot be built.

**Data flow**: It receives a mutable tar builder, entry type, path, contents, and mode → creates a tar header, fills in type, size, mode, and checksum, then appends the data → changes the tar builder by adding the entry.

**Call relations**: tests::tar_gz_bytes calls this for every requested file entry while constructing in-memory plugin bundles.

*Call graph*: 3 external calls (append_data, panic!, new_gnu).


##### `tests::finish_tar_gz`  (lines 966–975)

```
fn finish_tar_gz(tar: tar::Builder<GzEncoder<Vec<u8>>>) -> Vec<u8>
```

**Purpose**: Finishes a test tar.gz archive and returns its bytes. It turns the builder state into the final compressed data used by tests.

**Data flow**: It receives a tar builder wrapping a gzip encoder → closes the tar builder, then finishes gzip compression → returns the final byte vector or panics if test data creation fails.

**Call relations**: tests::tar_gz_bytes calls this after adding all entries, so tests can pass complete archive bytes to extraction and install functions.

*Call graph*: 2 external calls (into_inner, panic!).


### `core-plugins/src/remote/remote_installed_plugin_sync.rs`

`domain_logic` · `background sync and cache cleanup`

Remote plugins live in two places: the server knows which ones the user has installed, and the local machine keeps downloaded copies so they can run. This file is the bridge between those two worlds. Without it, a user might keep running an old plugin version, miss a newly installed remote plugin, or keep stale plugin files after uninstalling them remotely.

The main flow starts only when the user is authenticated. It starts a background task, but first records that a sync is already running for this plugin cache folder. That record is protected by a mutex, which is a lock that stops two tasks from changing the same shared list at the same time. This is like putting a “cleaning in progress” sign on a storage room door.

The sync then asks the remote catalog for installed plugins in several scopes: global, workspace, and user. For each plugin, it works out the correct local marketplace name, checks whether the local cached version is already current, validates the remote bundle information, and downloads and installs it if needed. After that, it scans known remote plugin cache folders and deletes entries that are no longer installed. It skips any plugin whose cache is currently being changed by another operation, using a small guard object that automatically unregisters itself when dropped.

The outcome records what was installed, what stale cache entries were removed, and which remote plugins failed.

#### Function details

##### `RemoteInstalledPluginBundleSyncOutcome::changed_local_cache`  (lines 46–48)

```
fn changed_local_cache(&self) -> bool
```

**Purpose**: This small helper answers the question: did this sync actually change anything on disk? It is used to decide whether other parts of the app need to be told that the plugin cache changed.

**Data flow**: It reads the outcome’s two lists of local changes: installed plugin IDs and removed cache plugin IDs. If either list has at least one item, it returns true; if both are empty, it returns false. It does not change the outcome.

**Call relations**: After a background sync finishes, maybe_start_remote_installed_plugin_bundle_sync checks this method before calling the optional cache-changed callback. That keeps the app from doing extra refresh work when the sync only confirmed that everything was already current.


##### `maybe_start_remote_installed_plugin_bundle_sync`  (lines 82–124)

```
fn maybe_start_remote_installed_plugin_bundle_sync(
    codex_home: PathBuf,
    config: RemotePluginServiceConfig,
    auth: Option<CodexAuth>,
    on_local_cache_changed: Option<Arc<dyn Fn() + Send
```

**Purpose**: This function starts a remote plugin sync in the background, but only when there is an authenticated user and no sync is already running for the same local plugin cache. It is the safe “kick off a sync if needed” entry point for this file.

**Data flow**: It receives the Codex home folder, remote service settings, optional authentication, and an optional callback to run if local plugin files change. If authentication is missing, it stops immediately. Otherwise it builds a cache-root key, tries to mark that key as already syncing, and if successful starts an asynchronous task. That task runs the one-time sync, logs success or failure, calls the callback if the cache changed, and finally clears the in-flight marker.

**Call relations**: This function uses remote_plugin_cache_root to identify the cache being protected, mark_remote_installed_plugin_bundle_sync_in_flight to prevent duplicate work, and sync_remote_installed_plugin_bundles_once to do the real sync. When the spawned task ends, it calls clear_remote_installed_plugin_bundle_sync_in_flight so a later sync can run.

*Call graph*: calls 4 internal fn (clear_remote_installed_plugin_bundle_sync_in_flight, mark_remote_installed_plugin_bundle_sync_in_flight, remote_plugin_cache_root, sync_remote_installed_plugin_bundles_once); 3 external calls (info!, spawn, warn!).


##### `sync_remote_installed_plugin_bundles_once`  (lines 126–277)

```
async fn sync_remote_installed_plugin_bundles_once(
    codex_home: PathBuf,
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
) -> Result<RemoteInstalledPluginBundleSyncOutcome, R
```

**Purpose**: This is the main one-shot synchronization routine. It compares the remote list of installed plugins with the local plugin cache, downloads any needed plugin bundles, and removes cached remote plugins that are no longer installed.

**Data flow**: It takes the local Codex home folder, remote service configuration, and authentication. First it confirms the authentication is valid for ChatGPT. Then it fetches installed remote plugins for global, workspace, and user scopes at the same time. It opens the local plugin store, builds a record of which plugin names should exist in each remote marketplace folder, and walks through every remote plugin. For each one, it creates a local plugin ID, skips it if the cached version is already the same, validates the bundle details, and downloads and installs the bundle if needed. Finally, it runs stale-cache removal on a blocking worker thread and returns an outcome listing installed plugin IDs, removed cache IDs, and failed remote IDs.

**Call relations**: maybe_start_remote_installed_plugin_bundle_sync calls this inside a background task. This function hands bundle checking to validate_remote_plugin_bundle, installation to download_and_install_remote_plugin_bundle, local version checks to PluginStore, and final cleanup to remove_stale_remote_plugin_caches.

*Call graph*: calls 4 internal fn (download_and_install_remote_plugin_bundle, validate_remote_plugin_bundle, try_new, new); called by 1 (maybe_start_remote_installed_plugin_bundle_sync); 9 external calls (from_iter, new, clone, ensure_chatgpt_auth, fetch_installed_plugins_for_scope_with_download_url, remote_plugin_canonical_marketplace_name, spawn_blocking, try_join!, warn!).


##### `mark_remote_plugin_cache_mutation_in_flight`  (lines 279–297)

```
fn mark_remote_plugin_cache_mutation_in_flight(
    codex_home: &Path,
    marketplace_name: &str,
    plugin_name: &str,
) -> RemotePluginCacheMutationGuard
```

**Purpose**: This function marks one specific remote plugin cache entry as currently being changed. Callers use the returned guard to protect an install, update, or similar cache operation from being deleted by stale-cache cleanup.

**Data flow**: It receives the Codex home folder, marketplace name, and plugin name. It turns those into a cache mutation key, locks the shared mutation map, and increases a counter for that key. It returns a RemotePluginCacheMutationGuard that remembers the key. The counter allows nested or overlapping operations on the same plugin to be tracked safely.

**Call relations**: The stale-cache cleanup test calls this before running remove_stale_remote_plugin_caches to prove that cleanup skips protected entries. The guard’s Drop implementation later reverses the marker automatically when the caller is done.

*Call graph*: calls 1 internal fn (remote_plugin_cache_root); called by 1 (stale_remote_plugin_cleanup_skips_cache_mutations_in_progress).


##### `RemotePluginCacheMutationGuard::drop`  (lines 300–314)

```
fn drop(&mut self)
```

**Purpose**: This automatic cleanup runs when a cache mutation guard goes out of scope. It unregisters the protected plugin cache entry, so future stale-cache cleanup may remove it if it is no longer installed.

**Data flow**: It reads the key stored inside the guard, locks the shared mutation map, and lowers that key’s counter by one. If the counter reaches zero, it removes the key completely. It does not return a value; its effect is updating the shared in-flight mutation tracking.

**Call relations**: mark_remote_plugin_cache_mutation_in_flight creates this guard. remove_stale_remote_plugin_caches indirectly depends on it because a cache entry is skipped only while the guard still exists; once all guards are dropped, is_remote_plugin_cache_mutation_in_flight will stop reporting that entry as protected.


##### `remove_stale_remote_plugin_caches`  (lines 317–390)

```
fn remove_stale_remote_plugin_caches(
    codex_home: &Path,
    installed_plugin_names_by_marketplace: &BTreeMap<String, BTreeSet<String>>,
) -> Result<Vec<String>, String>
```

**Purpose**: This function deletes cached remote plugin folders or files that no longer appear in the installed-plugin list. It is the cleanup step that keeps the local plugin cache from collecting old, unused remote plugins.

**Data flow**: It receives the Codex home folder and a map saying which plugin names are still installed in each marketplace. It checks each known remote marketplace cache folder. For every cache entry it finds, it reads the plugin name from the folder or file name, keeps it if that name is still installed, and also keeps it if another operation is currently changing that same cache entry. Otherwise it removes the directory or file from disk. It returns a sorted list of plugin IDs that were removed, or a readable error message if reading or deleting fails.

**Call relations**: sync_remote_installed_plugin_bundles_once calls this after downloading needed bundles, so the cache ends up matching the remote installed list. It calls is_remote_plugin_cache_mutation_in_flight before deleting anything, which prevents races with active installs or updates. The tests call it directly to check both protected-cache and stale-marketplace behavior.

*Call graph*: calls 2 internal fn (is_remote_plugin_cache_mutation_in_flight, new); called by 2 (stale_remote_plugin_cleanup_removes_stale_marketplace_caches_and_keeps_canonical_cache, stale_remote_plugin_cleanup_skips_cache_mutations_in_progress); 5 external calls (join, new, read_dir, remove_dir_all, remove_file).


##### `remote_plugin_cache_root`  (lines 392–394)

```
fn remote_plugin_cache_root(codex_home: &Path) -> PathBuf
```

**Purpose**: This helper builds the path to the plugin cache directory under the user’s Codex home folder. It keeps every caller using the same idea of where cached plugins live.

**Data flow**: It takes a Codex home path and appends the shared plugin-cache directory name. It returns the resulting path and does not touch the filesystem.

**Call relations**: maybe_start_remote_installed_plugin_bundle_sync uses this path to deduplicate syncs by cache folder. mark_remote_plugin_cache_mutation_in_flight and is_remote_plugin_cache_mutation_in_flight use it to create matching keys for protected cache entries. A test also uses it when checking sync deduplication.

*Call graph*: called by 4 (is_remote_plugin_cache_mutation_in_flight, mark_remote_plugin_cache_mutation_in_flight, maybe_start_remote_installed_plugin_bundle_sync, remote_installed_plugin_sync_in_flight_dedupes_by_cache_root); 1 external calls (join).


##### `is_remote_plugin_cache_mutation_in_flight`  (lines 396–413)

```
fn is_remote_plugin_cache_mutation_in_flight(
    codex_home: &Path,
    marketplace_name: &str,
    plugin_name: &str,
) -> bool
```

**Purpose**: This function checks whether a specific remote plugin cache entry is currently protected because another operation is changing it. Cleanup uses it to avoid deleting files mid-install.

**Data flow**: It receives the Codex home folder, marketplace name, and plugin name. It looks for the shared mutation map; if none exists, it returns false. If the map exists, it locks it, builds the same key used by mark_remote_plugin_cache_mutation_in_flight, and returns whether that key is present.

**Call relations**: remove_stale_remote_plugin_caches calls this before deleting a stale-looking cache entry. It relies on remote_plugin_cache_root so that its lookup key matches the key created when a mutation guard was registered.

*Call graph*: calls 1 internal fn (remote_plugin_cache_root); called by 1 (remove_stale_remote_plugin_caches).


##### `mark_remote_installed_plugin_bundle_sync_in_flight`  (lines 415–425)

```
fn mark_remote_installed_plugin_bundle_sync_in_flight(
    key: RemoteInstalledPluginBundleSyncKey,
) -> bool
```

**Purpose**: This function records that a remote installed-plugin sync is already running for a particular plugin cache root. It returns whether the caller successfully claimed the right to run that sync.

**Data flow**: It receives a sync key, locks the shared set of active syncs, and tries to insert the key. If the key was not already present, insertion succeeds and it returns true. If another sync already inserted the same key, it returns false.

**Call relations**: maybe_start_remote_installed_plugin_bundle_sync calls this before spawning the background sync task. If it returns false, that caller does nothing, which prevents duplicate downloads and cleanup for the same cache. A test uses it to confirm this deduplication behavior.

*Call graph*: called by 1 (maybe_start_remote_installed_plugin_bundle_sync).


##### `clear_remote_installed_plugin_bundle_sync_in_flight`  (lines 427–436)

```
fn clear_remote_installed_plugin_bundle_sync_in_flight(key: &RemoteInstalledPluginBundleSyncKey)
```

**Purpose**: This function removes the marker that says a sync is running for a plugin cache root. It makes future sync attempts possible after the current one finishes.

**Data flow**: It receives a sync key, looks up the shared set of active syncs, locks it if it exists, and removes the key. It does not return anything.

**Call relations**: maybe_start_remote_installed_plugin_bundle_sync calls this at the end of the spawned background task, whether the sync succeeded or failed. The sync deduplication test also calls it to prove that clearing the marker allows a later sync to be marked again.

*Call graph*: called by 2 (maybe_start_remote_installed_plugin_bundle_sync, remote_installed_plugin_sync_in_flight_dedupes_by_cache_root).


##### `tests::remote_installed_plugin_sync_in_flight_dedupes_by_cache_root`  (lines 444–462)

```
fn remote_installed_plugin_sync_in_flight_dedupes_by_cache_root()
```

**Purpose**: This test proves that only one installed-plugin sync can be marked as running for the same cache root at a time. It also proves that clearing the marker allows a later sync to start.

**Data flow**: It creates a temporary Codex home folder, builds the cache-root sync key, and tries to mark it as in flight. The first mark should succeed, the second should fail because it is a duplicate, and a new mark after clearing should succeed again. The test changes only the in-memory in-flight sync set.

**Call relations**: The test exercises remote_plugin_cache_root, mark_remote_installed_plugin_bundle_sync_in_flight, and clear_remote_installed_plugin_bundle_sync_in_flight together. It documents the protection that maybe_start_remote_installed_plugin_bundle_sync depends on before spawning work.

*Call graph*: calls 2 internal fn (clear_remote_installed_plugin_bundle_sync_in_flight, remote_plugin_cache_root); 2 external calls (assert!, tempdir).


##### `tests::stale_remote_plugin_cleanup_skips_cache_mutations_in_progress`  (lines 465–531)

```
fn stale_remote_plugin_cleanup_skips_cache_mutations_in_progress()
```

**Purpose**: This test proves that stale-cache cleanup will not delete a plugin cache entry while another operation has marked that entry as being changed. It also checks that multiple guards must all be dropped before cleanup can remove the entry.

**Data flow**: It creates a fake cached plugin on disk, builds an installed-plugin map that says the plugin is not installed, and then registers two mutation guards for that plugin. Cleanup runs while both guards exist and removes nothing. After dropping one guard, cleanup still removes nothing. After dropping the second guard, cleanup removes the stale plugin cache and returns its plugin ID.

**Call relations**: The test calls mark_remote_plugin_cache_mutation_in_flight to create protection and remove_stale_remote_plugin_caches to attempt deletion. Through that path it verifies the interaction between mutation guards, their Drop behavior, and is_remote_plugin_cache_mutation_in_flight.

*Call graph*: calls 2 internal fn (mark_remote_plugin_cache_mutation_in_flight, remove_stale_remote_plugin_caches); 7 external calls (from_iter, new, assert!, assert_eq!, create_dir_all, write, tempdir).


##### `tests::stale_remote_plugin_cleanup_removes_stale_marketplace_caches_and_keeps_canonical_cache`  (lines 534–620)

```
fn stale_remote_plugin_cleanup_removes_stale_marketplace_caches_and_keeps_canonical_cache()
```

**Purpose**: This test proves that cleanup removes stale plugin caches from several remote marketplace folders while keeping a cache entry that is still listed as installed. It checks that cleanup respects the canonical marketplace grouping used by remote plugins.

**Data flow**: It creates three fake cached plugin manifests on disk: two that should be stale and one that should still be installed. It builds an installed-plugin map where only the canonical shared plugin remains installed. Then it runs cleanup and checks that the two stale cache entries are reported and deleted, while the still-installed cache file remains.

**Call relations**: The test directly exercises remove_stale_remote_plugin_caches. It gives confidence that the cleanup step called by sync_remote_installed_plugin_bundles_once will remove obsolete remote marketplace cache entries without deleting the current canonical cache.

*Call graph*: calls 1 internal fn (remove_stale_remote_plugin_caches); 8 external calls (from_iter, from, new, assert!, assert_eq!, create_dir_all, write, tempdir).


### `core-plugins/src/remote.rs`

`io_transport` · `startup, catalog refresh, plugin request handling, install/uninstall cleanup`

Remote plugins live outside the local machine, so Codex needs a careful middle layer to talk to them. This file is that layer. It checks that the user is signed in with the right kind of ChatGPT authentication, builds HTTP requests, sends them to plugin-service endpoints, decodes the JSON replies, and reports clear errors when the server says something unexpected. It also translates server terms into Codex terms: scopes become marketplace names, plugin releases become display information, installed records become local cache entries, and workspace sharing data becomes share context. Think of it like a travel adapter: the remote service and the local plugin system use different plug shapes, and this file makes them fit safely. It also deals with paging, because catalog results can arrive in batches; caching, so the global catalog can be reused; and cleanup, so uninstalling a remote plugin removes local cached files too. Several public functions are used by higher-level plugin commands, while many smaller helpers keep IDs safe, normalize user-facing text, sort plugins, or build authenticated requests.

#### Function details

##### `is_valid_remote_plugin_id`  (lines 258–263)

```
fn is_valid_remote_plugin_id(plugin_id: &str) -> bool
```

**Purpose**: Checks whether a remote plugin ID uses only the small set of safe characters Codex accepts. This prevents unsafe or malformed IDs from being sent to the remote service or used in paths and requests.

**Data flow**: It receives a plugin ID string, checks that it is not empty, then checks every character. It returns true only when all characters are ASCII letters, digits, underscore, dash, or tilde.

**Call relations**: It is the basic safety check used before plugin reads, installs, uninstalls, share operations, and recommendation filtering. validate_remote_plugin_id wraps it when callers need a structured JSON-RPC error instead of a simple true-or-false answer.

*Call graph*: called by 7 (plugin_share_checkout_response, plugin_share_delete_response, plugin_share_save_response, plugin_share_update_targets_response, plugin_uninstall_response, recommended_plugins_mode, validate_remote_plugin_id).


##### `validate_remote_plugin_id`  (lines 265–277)

```
fn validate_remote_plugin_id(plugin_id: &str) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Turns the raw plugin-ID safety check into an error format suitable for API responses. Callers use it when an invalid ID should stop a user-facing request cleanly.

**Data flow**: It receives a plugin ID, asks is_valid_remote_plugin_id whether it is safe, and returns success if so. If not, it returns a JSON-RPC error explaining which characters are allowed.

**Call relations**: Plugin read, skill read, install, and uninstall response builders call this before continuing. It delegates the actual character check to is_valid_remote_plugin_id.

*Call graph*: calls 1 internal fn (is_valid_remote_plugin_id); called by 4 (plugin_read_response, plugin_skill_read_response, remote_plugin_install_response, remote_plugin_uninstall_response).


##### `RemotePluginScope::api_value`  (lines 383–389)

```
fn api_value(self) -> &'static str
```

**Purpose**: Converts Codex's internal idea of a plugin scope into the exact word the remote API expects. For example, the internal Global scope becomes the API string "GLOBAL".

**Data flow**: It receives one RemotePluginScope value and returns a fixed string for that value. It does not read or change anything else.

**Call relations**: The page-fetching functions for directory and installed plugins call this while building query parameters for HTTP requests.

*Call graph*: called by 2 (get_remote_plugin_installed_page, get_remote_plugin_list_page).


##### `RemotePluginScope::marketplace_name`  (lines 391–397)

```
fn marketplace_name(self) -> &'static str
```

**Purpose**: Maps a scope to Codex's stable internal marketplace name. This lets code refer to the global, user-created, and workspace marketplaces consistently.

**Data flow**: It receives a scope and returns the matching marketplace identifier string used inside Codex. No network or file access happens.

**Call relations**: This helper supports code that needs a canonical marketplace label for a scope, especially when building marketplace views.


##### `RemotePluginScope::marketplace_display_name`  (lines 399–405)

```
fn marketplace_display_name(self) -> &'static str
```

**Purpose**: Maps a scope to the friendly marketplace name shown to people. It separates user-facing names from internal IDs.

**Data flow**: It receives a scope and returns a fixed display string such as "OpenAI Curated Remote" or "Workspace Directory".

**Call relations**: build_remote_plugin_detail calls it when filling in the display name for a plugin detail response.

*Call graph*: called by 1 (build_remote_plugin_detail).


##### `RemotePluginScope::from_marketplace_name`  (lines 407–417)

```
fn from_marketplace_name(name: &str) -> Option<Self>
```

**Purpose**: Recognizes whether a marketplace name belongs to one of the supported remote scopes. This is a guardrail before fetching skill details.

**Data flow**: It receives a marketplace name string and returns the matching scope when known. Unknown names become None.

**Call relations**: fetch_remote_plugin_skill_detail calls it to reject unsupported marketplace names before contacting the remote service.

*Call graph*: called by 1 (fetch_remote_plugin_skill_detail).


##### `remote_plugin_canonical_marketplace_name`  (lines 539–553)

```
fn remote_plugin_canonical_marketplace_name(
    plugin: &RemotePluginDirectoryItem,
) -> Result<&'static str, RemotePluginCatalogError>
```

**Purpose**: Finds the correct Codex marketplace bucket for a plugin returned by the remote service. Workspace plugins need extra care because listed, private, and unlisted shares are shown differently.

**Data flow**: It receives a remote directory item, reads its scope and sometimes its discoverability, and returns a marketplace name. If a workspace plugin is missing required sharing information, it returns an error.

**Call relations**: Summary building, detail fetching, installed-cache conversion, discoverable-plugin conversion, and uninstall cleanup all call this so they agree on where a remote plugin belongs. It calls workspace_plugin_discoverability for workspace-specific checks.

*Call graph*: calls 1 internal fn (workspace_plugin_discoverability); called by 5 (build_remote_plugin_summary, fetch_remote_plugin_detail_with_download_url_option, remote_discoverable_plugin_from_directory_item, remote_installed_plugin_to_cache_entry, uninstall_remote_plugin).


##### `workspace_plugin_discoverability`  (lines 555–564)

```
fn workspace_plugin_discoverability(
    plugin: &RemotePluginDirectoryItem,
) -> Result<RemotePluginShareDiscoverability, RemotePluginCatalogError>
```

**Purpose**: Reads the sharing visibility of a workspace plugin and treats missing visibility as a bad server response. Workspace plugins cannot be sorted into the right marketplace without this value.

**Data flow**: It receives a remote directory item and returns its discoverability value if present. If the field is missing, it returns an UnexpectedResponse error naming the plugin.

**Call relations**: remote_plugin_canonical_marketplace_name uses it to choose the marketplace bucket, and remote_plugin_share_context uses it when building share information.

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

**Purpose**: Builds the marketplace lists shown to the user by fetching remote plugin directories and installed state. It combines what exists in the catalog with what the user has installed.

**Data flow**: It receives service configuration, optional authentication, requested marketplace sources, and an optional cache path. It verifies authentication, fetches the needed catalog and installed pages, optionally reads or writes the global catalog cache, merges directory and installed records, and returns marketplace objects.

**Call relations**: plugin_list_response calls this when it needs live remote marketplace data. Inside, it calls fetch_directory_plugins_for_scope, fetch_installed_plugins_for_scope, fetch_shared_workspace_plugins, build_remote_marketplace, and the catalog cache helpers.

*Call graph*: calls 7 internal fn (build_remote_marketplace, load_cached_global_directory_plugins, write_cached_global_directory_plugins, ensure_chatgpt_auth, fetch_directory_plugins_for_scope, fetch_installed_plugins_for_scope, fetch_shared_workspace_plugins); called by 1 (plugin_list_response); 3 external calls (new, iter, try_join!).


##### `fetch_and_cache_global_remote_plugin_catalog`  (lines 796–806)

```
async fn fetch_and_cache_global_remote_plugin_catalog(
    codex_home: &Path,
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
) -> Result<(), RemotePluginCatalogError>
```

**Purpose**: Refreshes the cached copy of the global remote plugin catalog. This makes later startup or suggestion flows faster and more resilient.

**Data flow**: It receives the Codex home path, service config, and authentication. After checking auth, it fetches the global directory and writes the result into the catalog cache.

**Call relations**: Startup tasks, cache refresh loops, and suggestion flows call this when they want a fresh global catalog available locally. It relies on fetch_directory_plugins_for_scope and the cache writer.

*Call graph*: calls 3 internal fn (write_cached_global_directory_plugins, ensure_chatgpt_auth, fetch_directory_plugins_for_scope); called by 4 (expands_cached_remote_plugins_by_loaded_apps, maybe_start_plugin_startup_tasks_for_config, run_global_remote_catalog_cache_refresh_loop, list_tool_suggest_discoverable_plugins_includes_cached_remote_global_plugins).


##### `fetch_recommended_plugins`  (lines 808–821)

```
async fn fetch_recommended_plugins(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
) -> Result<RecommendedPluginsMode, RemotePluginCatalogError>
```

**Purpose**: Asks the remote service for plugins it recommends, then converts the reply into Codex's recommendation mode. If the endpoint is not enabled, Codex falls back to legacy behavior.

**Data flow**: It receives config and auth, verifies auth, builds an authenticated GET request to the suggested-plugins endpoint, decodes the response, and returns either Legacy mode or a cleaned list of recommended plugins.

**Call relations**: It prepares the HTTP request with authenticated_request, sends it through send_and_decode, and hands the decoded response to recommended_plugins_mode for filtering.

*Call graph*: calls 5 internal fn (authenticated_request, ensure_chatgpt_auth, recommended_plugins_mode, send_and_decode, build_reqwest_client); 1 external calls (format!).


##### `recommended_plugins_mode`  (lines 823–886)

```
fn recommended_plugins_mode(response: RecommendedPluginsResponse) -> RecommendedPluginsMode
```

**Purpose**: Cleans and limits the recommendation response from the server. It drops invalid, unavailable, duplicate, or overly long entries before Codex shows them.

**Data flow**: It receives a decoded recommendation response. If the endpoint is not explicitly enabled, it returns Legacy mode; otherwise it validates IDs, names, policies, display names, and app IDs, then returns up to the configured maximum recommendations.

**Call relations**: fetch_recommended_plugins calls this after decoding the remote response. It uses is_valid_remote_plugin_id, non_empty_string, and PluginId creation to make sure recommendations can safely become local config IDs.

*Call graph*: calls 3 internal fn (is_valid_remote_plugin_id, non_empty_string, new); called by 1 (fetch_recommended_plugins); 3 external calls (new, new, warn!).


##### `has_cached_global_remote_plugin_catalog`  (lines 888–897)

```
fn has_cached_global_remote_plugin_catalog(
    codex_home: &Path,
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
) -> bool
```

**Purpose**: Answers whether a usable cached global catalog already exists for this user and service configuration. This lets callers decide whether they can show cached remote plugins without fetching.

**Data flow**: It receives Codex home, config, and optional auth. If auth is missing or unsupported, it returns false; otherwise it tries to load the cached catalog and returns whether one was found.

**Call relations**: plugin_list_response calls this as a quick cache availability check. It uses ensure_chatgpt_auth and the catalog cache loader.

*Call graph*: calls 2 internal fn (load_cached_global_directory_plugins, ensure_chatgpt_auth); called by 1 (plugin_list_response).


##### `cached_global_remote_discoverable_plugins`  (lines 899–915)

```
fn cached_global_remote_discoverable_plugins(
    codex_home: &Path,
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
) -> Vec<RemoteDiscoverablePlugin>
```

**Purpose**: Reads cached global plugins and turns them into lightweight discoverable-plugin records for suggestions. Bad cached entries are skipped rather than breaking the whole list.

**Data flow**: It receives Codex home, config, and auth, loads the cached global directory if present, converts each directory item into a discoverable plugin, logs conversion failures, and returns the successful entries.

**Call relations**: cached_global_remote_discoverable_plugins_for_config calls this when suggestions need cached remote plugin data. The conversion work is done by remote_discoverable_plugin_from_directory_item.

*Call graph*: calls 1 internal fn (load_cached_global_directory_plugins); called by 1 (cached_global_remote_discoverable_plugins_for_config).


##### `fetch_openai_curated_remote_collection_marketplace`  (lines 917–940)

```
async fn fetch_openai_curated_remote_collection_marketplace(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
) -> Result<Option<RemoteMarketplace>, RemotePluginCatalogError>
```

**Purpose**: Fetches a special curated collection from the global remote marketplace. This is used when Codex wants a narrower OpenAI-curated view instead of the full global catalog.

**Data flow**: It receives config and auth, verifies auth, fetches global directory plugins for the configured collection and global installed plugins in parallel, then merges them into one marketplace if any plugins exist.

**Call relations**: plugin_list_response calls this for the curated remote collection. It uses build_remote_marketplace after fetching the directory and installed lists.

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

**Purpose**: Combines catalog entries and installed entries into one marketplace view. This is where Codex marks each listed plugin as installed or not installed.

**Data flow**: It receives a marketplace name, display name, directory plugin list, installed plugin list, and a flag saying whether installed-only plugins should be included. It matches installed records by remote ID, builds summaries, optionally adds installed plugins missing from the directory, and returns None if the final list is empty.

**Call relations**: fetch_remote_marketplaces and fetch_openai_curated_remote_collection_marketplace call this after gathering raw server data. It depends on build_remote_plugin_summary for each plugin summary.

*Call graph*: called by 2 (fetch_openai_curated_remote_collection_marketplace, fetch_remote_marketplaces).


##### `fetch_remote_installed_plugins`  (lines 979–1012)

```
async fn fetch_remote_installed_plugins(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
) -> Result<Vec<RemoteInstalledPlugin>, RemotePluginCatalogError>
```

**Purpose**: Fetches all remote plugins installed by the user across global, workspace, and user-created scopes. The result is shaped for local caching.

**Data flow**: It receives config and auth, verifies auth, fetches installed plugins for the three scopes in parallel, converts each installed item into a cache entry, sorts them, and returns the list.

**Call relations**: Installed-plugin cache builders and refresh loops call this. It uses fetch_installed_plugins_for_scope for each scope and remote_installed_plugin_to_cache_entry for conversion.

*Call graph*: calls 2 internal fn (ensure_chatgpt_auth, fetch_installed_plugins_for_scope); called by 2 (build_and_cache_remote_installed_plugin_marketplaces, run_remote_installed_plugins_cache_refresh_loop); 1 external calls (try_join!).


##### `group_remote_installed_plugins_by_marketplaces`  (lines 1014–1059)

```
fn group_remote_installed_plugins_by_marketplaces(
    plugins: &[RemoteInstalledPlugin],
    visible_marketplaces: &[&str],
) -> Vec<RemoteMarketplace>
```

**Purpose**: Turns cached installed plugin records back into marketplace groups for display. It only includes marketplace names the caller says are visible.

**Data flow**: It receives installed plugin cache entries and a list of visible marketplace names. It filters hidden marketplaces, creates plugin summaries, groups them by marketplace, sorts each group by display name, and returns marketplaces in a fixed display order.

**Call relations**: Cache-building and cache-reading flows call this to present installed remote plugins. It uses PluginId creation and sort_remote_plugin_summaries_by_display_name to produce stable, user-friendly output.

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

**Purpose**: Fetches detailed information for one remote plugin without asking for bundle download links. This is the normal detail path for viewing a plugin.

**Data flow**: It receives config, auth, marketplace name, and plugin ID, then forwards the request with include-download-URLs set to false. It returns a RemotePluginDetail or an error.

**Call relations**: plugin_read_response calls this for plugin detail pages. It delegates all real work to fetch_remote_plugin_detail_with_download_url_option.

*Call graph*: calls 1 internal fn (fetch_remote_plugin_detail_with_download_url_option); called by 1 (plugin_read_response).


##### `fetch_remote_plugin_share_context`  (lines 1077–1088)

```
async fn fetch_remote_plugin_share_context(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
    plugin_id: &str,
) -> Result<Option<RemotePluginShareContext>, RemotePluginCatalog
```

**Purpose**: Fetches just the workspace sharing context for a remote plugin. This is useful when a caller needs share metadata without the full plugin detail shape.

**Data flow**: It receives config, auth, and plugin ID, verifies auth, fetches the plugin detail record from the server, and extracts share context if the plugin is a workspace plugin.

**Call relations**: plugin_read_response calls this when share information is needed. It uses fetch_plugin_detail for the remote read and remote_plugin_share_context for translation.

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

**Purpose**: Fetches detailed plugin information and asks the server to include bundle download links. This is used for install flows that may need to download plugin contents.

**Data flow**: It receives config, auth, marketplace name, and plugin ID, then forwards the request with include-download-URLs set to true. It returns the same detail shape as the normal detail function, with download URLs included when available.

**Call relations**: remote_plugin_install_response calls this after installing or preparing an install. It delegates to fetch_remote_plugin_detail_with_download_url_option.

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

**Purpose**: Fetches the markdown contents for a single skill inside a remote plugin. It also checks that the server returned the same plugin ID and skill name that were requested.

**Data flow**: It receives config, auth, marketplace name, plugin ID, and skill name. It verifies auth and marketplace support, builds a safe URL, sends an authenticated request, decodes the response, checks IDs for consistency, and returns the skill contents.

**Call relations**: plugin_skill_read_response calls this when a user opens a remote skill. It uses RemotePluginScope::from_marketplace_name, remote_plugin_skill_detail_url, authenticated_request, and send_and_decode.

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

**Purpose**: Shared detail-fetching path for both normal detail reads and detail reads that include download links. It treats the server's plugin record as the source of truth for the actual marketplace.

**Data flow**: It receives config, auth, a marketplace name, plugin ID, and a download-link flag. It verifies auth, fetches the plugin record, determines the canonical marketplace from the returned record, and builds a full RemotePluginDetail.

**Call relations**: fetch_remote_plugin_detail and fetch_remote_plugin_detail_with_download_urls both call this. It calls fetch_plugin_detail, remote_plugin_canonical_marketplace_name, and build_remote_plugin_detail.

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

**Purpose**: Assembles the full local detail view for a remote plugin. It combines the server's plugin record with installed state, skill enablement, app connectors, MCP server routing, and display metadata.

**Data flow**: It receives config, auth, scope, marketplace name, plugin ID, and the remote plugin record. It fetches installed plugins for the scope, finds this plugin if installed, marks disabled skills, derives app IDs from the app manifest or app IDs, applies app-to-MCP routing policy, and returns a complete RemotePluginDetail.

**Call relations**: fetch_remote_plugin_detail_with_download_url_option calls this after the raw plugin has been fetched. It calls fetch_installed_plugins_for_scope, build_remote_plugin_summary, non_empty_string, apply_app_mcp_routing_policy, and app connector helpers.

*Call graph*: calls 6 internal fn (apply_app_mcp_routing_policy, marketplace_display_name, build_remote_plugin_summary, fetch_installed_plugins_for_scope, non_empty_string, api_auth_mode); called by 1 (fetch_remote_plugin_detail_with_download_url_option); 1 external calls (app_connector_ids_from_declarations).


##### `app_declarations_from_remote_app_ids`  (lines 1254–1263)

```
fn app_declarations_from_remote_app_ids(app_ids: &[String]) -> Vec<AppDeclaration>
```

**Purpose**: Creates simple app declarations from plain app ID strings when the server did not provide a richer app manifest. This gives later routing code a consistent shape to work with.

**Data flow**: It receives a list of app ID strings and returns one AppDeclaration per ID, using the ID as both the app name and connector ID.

**Call relations**: This helper is used by the detail-building path when the plugin release has app IDs but no parsed app manifest.


##### `install_remote_plugin`  (lines 1265–1302)

```
async fn install_remote_plugin(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
    _marketplace_name: &str,
    plugin_id: &str,
) -> Result<RemotePluginInstallResult, RemotePlu
```

**Purpose**: Tells the remote service to install and enable a plugin for the user. It verifies that the server confirms the same plugin ID and that the plugin ended up enabled.

**Data flow**: It receives config, auth, marketplace name, and plugin ID. It verifies auth, sends an authenticated POST request to the install endpoint, decodes the mutation response, validates the returned ID and enabled state, and returns any app IDs that still need authentication.

**Call relations**: remote_plugin_install_response calls this during install handling. It uses authenticated_request and send_and_decode for the HTTP work.

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

**Purpose**: Tells the remote service to uninstall a plugin and then removes Codex's local cached copy of that plugin. This keeps local files from lingering after the remote uninstall succeeds.

**Data flow**: It receives config, auth, Codex home path, and plugin ID. It verifies auth, fetches plugin detail to learn its marketplace and name, sends an uninstall request, checks the server confirmed disabled state, then starts a blocking cleanup task to remove cache files.

**Call relations**: remote_plugin_uninstall_response calls this. It uses fetch_plugin_detail, remote_plugin_canonical_marketplace_name, authenticated_request, send_and_decode, and then hands local file cleanup to remove_remote_plugin_cache.

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

**Purpose**: Deletes local cached files for an uninstalled remote plugin, including an older legacy cache layout if present. This prevents stale plugin bundles from remaining on disk.

**Data flow**: It receives Codex home, marketplace name, plugin name, and legacy remote plugin ID. It opens the plugin store, builds the modern plugin cache ID, removes that store entry, then checks and removes the legacy path if it is different and still exists.

**Call relations**: uninstall_remote_plugin runs this in a blocking task after the remote service confirms uninstall. It works with PluginStore and filesystem deletion calls.

*Call graph*: calls 2 internal fn (try_new, new); 4 external calls (clone, join, remove_dir_all, remove_file).


##### `build_remote_plugin_summary`  (lines 1396–1421)

```
fn build_remote_plugin_summary(
    plugin: &RemotePluginDirectoryItem,
    installed_plugin: Option<&RemotePluginInstalledItem>,
) -> Result<RemotePluginSummary, RemotePluginCatalogError>
```

**Purpose**: Creates the compact plugin summary used in marketplace lists. It records identity, install state, policies, display metadata, keywords, and workspace share context.

**Data flow**: It receives a directory plugin and an optional installed record. It determines the marketplace, creates a stable local plugin ID, extracts share context and interface information, marks whether it is installed and enabled, and returns a RemotePluginSummary.

**Call relations**: build_remote_plugin_detail calls this for the detail's summary, and marketplace-building code uses the same logic for list entries. It calls remote_plugin_canonical_marketplace_name, remote_plugin_share_context, and remote_plugin_interface_to_info.

*Call graph*: calls 4 internal fn (remote_plugin_canonical_marketplace_name, remote_plugin_interface_to_info, remote_plugin_share_context, new); called by 1 (build_remote_plugin_detail).


##### `remote_discoverable_plugin_from_directory_item`  (lines 1423–1449)

```
fn remote_discoverable_plugin_from_directory_item(
    plugin: &RemotePluginDirectoryItem,
) -> Result<RemoteDiscoverablePlugin, RemotePluginCatalogError>
```

**Purpose**: Turns a full cached directory item into a smaller record suitable for discovery and suggestions. It keeps only the fields needed to suggest or describe a plugin briefly.

**Data flow**: It receives a directory plugin, computes its local config ID, chooses a display name and description, records whether it has skills and which app IDs it uses, and returns a RemoteDiscoverablePlugin.

**Call relations**: cached_global_remote_discoverable_plugins uses this when reading cached global catalog data. It relies on remote_plugin_canonical_marketplace_name and non_empty_string.

*Call graph*: calls 3 internal fn (non_empty_string, remote_plugin_canonical_marketplace_name, new).


##### `remote_plugin_share_context`  (lines 1451–1479)

```
fn remote_plugin_share_context(
    plugin: &RemotePluginDirectoryItem,
) -> Result<Option<RemotePluginShareContext>, RemotePluginCatalogError>
```

**Purpose**: Extracts workspace sharing information from a plugin record. Global and user-created plugins do not have workspace share context, so they return none.

**Data flow**: It receives a directory plugin. For global or user-scoped plugins it returns None; for workspace plugins it checks discoverability and copies share URL, creator data, version, and share principals into a local share-context object.

**Call relations**: build_remote_plugin_summary and fetch_remote_plugin_share_context call this when share metadata is needed. It uses workspace_plugin_discoverability to require valid workspace visibility.

*Call graph*: calls 1 internal fn (workspace_plugin_discoverability); called by 2 (build_remote_plugin_summary, fetch_remote_plugin_share_context).


##### `remote_installed_plugin_to_cache_entry`  (lines 1481–1499)

```
fn remote_installed_plugin_to_cache_entry(
    installed_plugin: &RemotePluginInstalledItem,
) -> Result<RemoteInstalledPlugin, RemotePluginCatalogError>
```

**Purpose**: Converts a server installed-plugin record into the smaller local cache record. This lets installed remote plugins be stored and shown later without refetching every detail.

**Data flow**: It receives an installed item, reads the embedded plugin data and enabled state, computes the marketplace name, copies policies and keywords, converts interface metadata, and returns a RemoteInstalledPlugin.

**Call relations**: fetch_remote_installed_plugins uses this after fetching installed plugins for all scopes. It calls remote_plugin_canonical_marketplace_name and remote_plugin_interface_to_info.

*Call graph*: calls 2 internal fn (remote_plugin_canonical_marketplace_name, remote_plugin_interface_to_info).


##### `remote_plugin_interface_to_info`  (lines 1501–1549)

```
fn remote_plugin_interface_to_info(plugin: &RemotePluginDirectoryItem) -> Option<PluginInterface>
```

**Purpose**: Converts the server's release interface fields into Codex's PluginInterface shape. Empty interface data is treated as absent instead of returning a mostly blank object.

**Data flow**: It receives a directory plugin, trims and normalizes display name and default prompts, copies description, developer, category, URL, color, icon, logo, and screenshot fields, then returns Some(interface) only if at least one meaningful field exists.

**Call relations**: build_remote_plugin_summary and remote_installed_plugin_to_cache_entry call this to attach user-facing metadata. It uses non_empty_string and default-prompt normalization helpers.

*Call graph*: calls 1 internal fn (non_empty_string); called by 2 (build_remote_plugin_summary, remote_installed_plugin_to_cache_entry); 1 external calls (new).


##### `remote_skill_interface_to_info`  (lines 1551–1569)

```
fn remote_skill_interface_to_info(
    interface: Option<RemotePluginSkillInterfaceResponse>,
) -> Option<SkillInterface>
```

**Purpose**: Converts optional server skill interface data into Codex's SkillInterface shape. It avoids producing an empty interface when the server did not send useful display information.

**Data flow**: It receives optional skill interface data. If present, it copies display name, short description, brand color, and default prompt, then returns it only when at least one field is set.

**Call relations**: The plugin detail builder uses this while turning each remote skill into a RemotePluginSkill.


##### `remote_plugin_display_name`  (lines 1571–1577)

```
fn remote_plugin_display_name(plugin: &RemotePluginSummary) -> &str
```

**Purpose**: Chooses the best display name for a plugin summary. It prefers the friendly interface display name and falls back to the raw plugin name.

**Data flow**: It receives a plugin summary and returns a string slice pointing either to the interface display name or to the plugin's name.

**Call relations**: sort_remote_plugin_summaries_by_display_name uses this to sort marketplace entries by what users actually see.


##### `sort_remote_plugin_summaries_by_display_name`  (lines 1579–1589)

```
fn sort_remote_plugin_summaries_by_display_name(plugins: &mut [RemotePluginSummary])
```

**Purpose**: Sorts plugin summaries in a stable, user-friendly order. It compares names without case first, then uses exact name and ID as tie breakers.

**Data flow**: It receives a mutable list of plugin summaries and reorders the list in place. It does not create a new list.

**Call relations**: group_remote_installed_plugins_by_marketplaces calls this before returning grouped installed marketplaces. It uses remote_plugin_display_name for each comparison.

*Call graph*: 1 external calls (sort_by).


##### `non_empty_string`  (lines 1591–1596)

```
fn non_empty_string(value: Option<&str>) -> Option<String>
```

**Purpose**: Turns optional text into a clean optional string by trimming whitespace and rejecting empty results. This keeps blank server fields from appearing as meaningful data.

**Data flow**: It receives an optional string slice. If the value exists and has non-whitespace characters after trimming, it returns the trimmed string; otherwise it returns None.

**Call relations**: Detail building, recommendation filtering, discoverable-plugin conversion, and interface conversion call this whenever they need clean user-facing text.

*Call graph*: called by 4 (build_remote_plugin_detail, recommended_plugins_mode, remote_discoverable_plugin_from_directory_item, remote_plugin_interface_to_info).


##### `normalize_remote_default_prompts`  (lines 1598–1605)

```
fn normalize_remote_default_prompts(prompts: &[String]) -> Option<Vec<String>>
```

**Purpose**: Cleans a list of default prompts from the server and limits how many Codex keeps. This prevents overly long or excessive prompt suggestions from leaking into the UI.

**Data flow**: It receives prompt strings, trims and validates each with normalize_remote_default_prompt, keeps only the configured maximum count, and returns None if none survive.

**Call relations**: remote_plugin_interface_to_info uses this when the server sends multiple default prompts for a plugin.


##### `normalize_remote_default_prompt`  (lines 1607–1613)

```
fn normalize_remote_default_prompt(prompt: &str) -> Option<String>
```

**Purpose**: Validates one default prompt from the server. It accepts only prompts that are non-empty after trimming and short enough for Codex's limits.

**Data flow**: It receives one prompt string, trims it, rejects it if empty or too long, and otherwise returns the cleaned prompt.

**Call relations**: normalize_remote_default_prompts uses this for lists, and remote_plugin_interface_to_info uses it for the older single-prompt field.


##### `fetch_directory_plugins_for_scope`  (lines 1615–1624)

```
async fn fetch_directory_plugins_for_scope(
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
    scope: RemotePluginScope,
) -> Result<Vec<RemotePluginDirectoryItem>, RemotePluginCatalogE
```

**Purpose**: Fetches all catalog plugins for one scope, such as global or workspace. It hides pagination so callers receive one complete list.

**Data flow**: It receives config, auth, and scope, then calls the shared paginated fetcher without a collection filter. It returns all directory items for that scope.

**Call relations**: Catalog refresh and marketplace fetching call this. It delegates to fetch_directory_plugins_for_scope_with_optional_collection.

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

**Purpose**: Fetches all catalog plugins for one scope within a named collection. This supports special catalog slices such as an OpenAI-curated collection.

**Data flow**: It receives config, auth, scope, and collection name, then calls the shared paginated fetcher with that collection filter. It returns all matching directory items.

**Call relations**: The curated marketplace path uses this to narrow the global catalog. It delegates pagination to fetch_directory_plugins_for_scope_with_optional_collection.

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

**Purpose**: Fetches every page of directory plugins for a scope, optionally filtered by collection. It is the common pagination loop for catalog listing.

**Data flow**: It starts with no page token, repeatedly requests one page, appends the returned plugins, and continues while the server provides a next-page token. It returns the combined list.

**Call relations**: Both directory-fetching wrappers call this. It gets each page from get_remote_plugin_list_page.

*Call graph*: calls 1 internal fn (get_remote_plugin_list_page); called by 2 (fetch_directory_plugins_for_scope, fetch_directory_plugins_for_scope_with_collection); 1 external calls (new).


##### `fetch_shared_workspace_plugins`  (lines 1662–1678)

```
async fn fetch_shared_workspace_plugins(
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
) -> Result<Vec<RemotePluginDirectoryItem>, RemotePluginCatalogError>
```

**Purpose**: Fetches all workspace plugins explicitly shared with the user. It follows every page returned by the shared-workspace endpoint.

**Data flow**: It starts with no page token, requests shared workspace plugin pages, appends each page's plugins, and stops when there is no next-page token. It returns the complete shared list.

**Call relations**: fetch_remote_marketplaces calls this when building the "Shared with me" marketplaces. It gets each page through get_remote_shared_workspace_plugins_page.

*Call graph*: calls 1 internal fn (get_remote_shared_workspace_plugins_page); called by 1 (fetch_remote_marketplaces); 1 external calls (new).


##### `fetch_installed_plugins_for_scope`  (lines 1680–1689)

```
async fn fetch_installed_plugins_for_scope(
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
    scope: RemotePluginScope,
) -> Result<Vec<RemotePluginInstalledItem>, RemotePluginCatalogE
```

**Purpose**: Fetches all installed remote plugins for one scope without requesting download links. This is the normal installed-state lookup.

**Data flow**: It receives config, auth, and scope, then delegates to the installed pagination helper with include-download-URLs set to false. It returns installed plugin records.

**Call relations**: Marketplace fetching, detail building, and installed-cache refresh call this. It delegates to fetch_installed_plugins_for_scope_with_download_url.

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

**Purpose**: Fetches every page of installed plugins for one scope, optionally asking for download URLs. It hides the remote service's pagination from callers.

**Data flow**: It starts with no page token, repeatedly requests installed-plugin pages, appends each page's plugins, and continues until the server stops returning a next-page token. It returns the combined installed list.

**Call relations**: fetch_installed_plugins_for_scope calls this with download URLs disabled. It requests each page through get_remote_plugin_installed_page.

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

**Purpose**: Requests one page of catalog plugins from the remote list endpoint. It is the low-level HTTP step behind full directory fetching.

**Data flow**: It receives config, auth, scope, optional page token, and optional collection. It builds the list URL, adds authentication and query parameters, sends the request, and decodes one RemotePluginListResponse.

**Call relations**: fetch_directory_plugins_for_scope_with_optional_collection calls this repeatedly. It uses RemotePluginScope::api_value, authenticated_request, and send_and_decode.

*Call graph*: calls 4 internal fn (api_value, authenticated_request, send_and_decode, build_reqwest_client); called by 1 (fetch_directory_plugins_for_scope_with_optional_collection); 1 external calls (format!).


##### `get_remote_shared_workspace_plugins_page`  (lines 1739–1753)

```
async fn get_remote_shared_workspace_plugins_page(
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
    page_token: Option<&str>,
) -> Result<RemotePluginListResponse, RemotePluginCatalog
```

**Purpose**: Requests one page of workspace plugins shared with the user. It is the low-level HTTP step behind the shared-workspace marketplace.

**Data flow**: It receives config, auth, and an optional page token. It builds the shared-workspace URL, adds authentication and pagination parameters, sends the request, and decodes one list response.

**Call relations**: fetch_shared_workspace_plugins calls this repeatedly until all shared plugins are fetched. It uses authenticated_request and send_and_decode.

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

**Purpose**: Requests one page of installed plugins for a scope. This is the low-level HTTP call behind installed-plugin lookups.

**Data flow**: It receives config, auth, scope, optional page token, and a download-link flag. It builds the installed URL, adds query parameters, sends the authenticated request, and decodes one installed response.

**Call relations**: fetch_installed_plugins_for_scope_with_download_url calls this repeatedly. It uses RemotePluginScope::api_value, authenticated_request, and send_and_decode.

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

**Purpose**: Fetches the raw server record for one plugin. Higher-level functions later translate that record into Codex's detail, share, or uninstall shapes.

**Data flow**: It receives config, auth, plugin ID, and a download-link flag. It builds the plugin detail URL, optionally asks for download URLs, sends the authenticated request, and returns the decoded directory item.

**Call relations**: Detail fetching, share-context fetching, and uninstall flows call this. It uses authenticated_request and send_and_decode.

*Call graph*: calls 3 internal fn (authenticated_request, send_and_decode, build_reqwest_client); called by 3 (fetch_remote_plugin_detail_with_download_url_option, fetch_remote_plugin_share_context, uninstall_remote_plugin); 1 external calls (format!).


##### `remote_plugin_skill_detail_url`  (lines 1792–1811)

```
fn remote_plugin_skill_detail_url(
    config: &RemotePluginServiceConfig,
    plugin_id: &str,
    skill_name: &str,
) -> Result<String, RemotePluginCatalogError>
```

**Purpose**: Builds a skill-detail URL safely using URL path segments. This avoids mistakes where special characters in IDs or skill names could break the path.

**Data flow**: It receives config, plugin ID, and skill name. It parses the base URL, appends the plugin and skill path segments, and returns the final URL string or an invalid-URL error.

**Call relations**: fetch_remote_plugin_skill_detail calls this before sending the skill-detail request.

*Call graph*: called by 1 (fetch_remote_plugin_skill_detail); 1 external calls (parse).


##### `ensure_chatgpt_auth`  (lines 1813–1821)

```
fn ensure_chatgpt_auth(auth: Option<&CodexAuth>) -> Result<&CodexAuth, RemotePluginCatalogError>
```

**Purpose**: Confirms that remote plugin calls have ChatGPT-backed authentication. Remote plugin catalog calls require this and do not support API-key-only authentication.

**Data flow**: It receives optional auth. If auth is missing, it returns AuthRequired; if the auth mode cannot use the Codex backend, it returns UnsupportedAuthMode; otherwise it returns the auth reference.

**Call relations**: Almost every public remote operation calls this before making a remote request, including marketplace fetches, detail reads, installs, uninstalls, recommendation fetches, and cache refreshes.

*Call graph*: called by 11 (fetch_and_cache_global_remote_plugin_catalog, fetch_openai_curated_remote_collection_marketplace, fetch_recommended_plugins, fetch_remote_installed_plugins, fetch_remote_marketplaces, fetch_remote_plugin_detail_with_download_url_option, fetch_remote_plugin_share_context, fetch_remote_plugin_skill_detail, has_cached_global_remote_plugin_catalog, install_remote_plugin (+1 more)).


##### `authenticated_request`  (lines 1823–1831)

```
fn authenticated_request(
    request: RequestBuilder,
    auth: &CodexAuth,
) -> Result<RequestBuilder, RemotePluginCatalogError>
```

**Purpose**: Adds the standard timeout, authentication headers, and Codex product header to an HTTP request. This keeps all remote plugin calls consistent.

**Data flow**: It receives a request builder and auth object, attaches a timeout, converts auth into HTTP headers, adds the product SKU header, and returns the updated request builder.

**Call relations**: All low-level remote calls use this before send_and_decode, including list, installed, detail, skill, recommendation, install, and uninstall requests.

*Call graph*: called by 8 (fetch_plugin_detail, fetch_recommended_plugins, fetch_remote_plugin_skill_detail, get_remote_plugin_installed_page, get_remote_plugin_list_page, get_remote_shared_workspace_plugins_page, install_remote_plugin, uninstall_remote_plugin); 2 external calls (timeout, auth_provider_from_auth).


##### `send_and_decode`  (lines 1833–1858)

```
async fn send_and_decode(
    request: RequestBuilder,
    url: &str,
) -> Result<T, RemotePluginCatalogError>
```

**Purpose**: Sends an HTTP request and decodes a successful JSON response into the requested Rust type. It also turns network, status-code, and JSON parsing failures into clear remote-plugin errors.

**Data flow**: It receives a prepared request and URL label. It sends the request, reads the status and body, returns an UnexpectedStatus error for non-success responses, and otherwise parses the body as JSON into the caller's expected type.

**Call relations**: Every remote HTTP operation hands its prepared request to this function. It is the final common step for list, installed, detail, skill, recommendation, install, and uninstall calls.

*Call graph*: called by 8 (fetch_plugin_detail, fetch_recommended_plugins, fetch_remote_plugin_skill_detail, get_remote_plugin_installed_page, get_remote_plugin_list_page, get_remote_shared_workspace_plugins_page, install_remote_plugin, uninstall_remote_plugin); 2 external calls (send, from_str).


### `core-plugins/src/remote_legacy.rs`

`io_transport` · `plugin discovery and plugin install/uninstall sync`

This file exists so local plugin choices can stay in sync with a remote ChatGPT-backed plugin service. Without it, the app could still know about local plugins, but it could not ask the server which plugins are featured, nor tell the server that a plugin should be enabled or uninstalled.

The file does three main jobs. First, it builds web requests to the ChatGPT plugin service using the configured base URL. Second, it adds authentication when needed. Authentication means proving who the user is; mutation actions such as enabling or uninstalling require ChatGPT/Codex backend authentication, and API-key style authentication is rejected because this remote service does not support it. Third, it checks server responses carefully. It does not just trust a successful-looking reply: after enabling or uninstalling, it confirms that the returned plugin ID matches the requested one and that the returned enabled state is what was expected.

The code uses timeouts so a slow server does not leave the app waiting forever: featured-plugin lookups get a shorter timeout, while enable/uninstall requests get more time. Errors are split into fetch errors and mutation errors so callers can show or log a useful explanation, such as “authentication required,” “bad URL,” “server returned an unexpected status,” or “response could not be decoded.”

#### Function details

##### `fetch_remote_featured_plugin_ids`  (lines 98–136)

```
async fn fetch_remote_featured_plugin_ids(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
    product: Option<Product>,
) -> Result<Vec<String>, RemotePluginFetchError>
```

**Purpose**: Asks the remote ChatGPT plugin service for the list of featured plugin IDs. Callers use this when they want the server’s current recommendation list for a given product or platform.

**Data flow**: It receives the remote service configuration, optional user authentication, and an optional product name. It turns the configured base URL into a `/plugins/featured` request, adds a platform query value, and adds auth headers only when the provided auth is suitable for the Codex backend. It sends the request, reads the response body, rejects non-success server statuses, and finally turns the JSON response into a list of plugin ID strings.

**Call relations**: This is called by `featured_plugin_ids_for_config` when higher-level plugin code needs the featured list. Inside, it builds a standard HTTP client with `build_reqwest_client`, uses `auth_provider_from_auth` to translate login information into request headers when appropriate, and uses JSON parsing to turn the server reply into usable data.

*Call graph*: calls 1 internal fn (build_reqwest_client); called by 1 (featured_plugin_ids_for_config); 3 external calls (auth_provider_from_auth, format!, from_str).


##### `enable_remote_plugin`  (lines 138–145)

```
async fn enable_remote_plugin(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
    plugin_id: &str,
) -> Result<(), RemotePluginMutationError>
```

**Purpose**: Tells the remote plugin service that a specific plugin should be enabled. It is a small public wrapper that gives the general mutation helper the concrete action name `enable`.

**Data flow**: It receives the service configuration, optional authentication, and the plugin ID to enable. It passes those values to `post_remote_plugin_mutation` with the action set to `enable`. If the remote call succeeds and the response is verified, it returns success with no extra data; otherwise it returns the detailed mutation error from the helper.

**Call relations**: This is called by `install_plugin_with_remote_sync` when a local plugin installation needs to be reflected on the remote service. It hands the real network work to `post_remote_plugin_mutation`, which performs authentication checks, sends the request, and validates the reply.

*Call graph*: calls 1 internal fn (post_remote_plugin_mutation); called by 1 (install_plugin_with_remote_sync).


##### `uninstall_remote_plugin`  (lines 147–154)

```
async fn uninstall_remote_plugin(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
    plugin_id: &str,
) -> Result<(), RemotePluginMutationError>
```

**Purpose**: Tells the remote plugin service that a specific plugin should be uninstalled. It is the uninstall counterpart to `enable_remote_plugin`.

**Data flow**: It receives the service configuration, optional authentication, and the plugin ID to uninstall. It forwards those values to `post_remote_plugin_mutation` with the action set to `uninstall`. If the server confirms the expected result, it returns success; if not, it returns a clear mutation error.

**Call relations**: This is called by `uninstall_plugin_with_remote_sync` when local uninstall work needs to be synchronized with the remote service. Like the enable path, it delegates the shared HTTP and validation steps to `post_remote_plugin_mutation`.

*Call graph*: calls 1 internal fn (post_remote_plugin_mutation); called by 1 (uninstall_plugin_with_remote_sync).


##### `ensure_codex_backend_auth`  (lines 156–166)

```
fn ensure_codex_backend_auth(
    auth: Option<&CodexAuth>,
) -> Result<&CodexAuth, RemotePluginMutationError>
```

**Purpose**: Checks that the caller supplied the kind of authentication required for remote plugin changes. It protects mutation requests from being sent with missing or unsupported credentials.

**Data flow**: It receives optional authentication. If there is no authentication, it produces an `AuthRequired` error. If the authentication is present but does not use the Codex backend, it produces an `UnsupportedAuthMode` error. If it is valid, it returns the authentication object so the request can use it.

**Call relations**: This is used by `post_remote_plugin_mutation` before any enable or uninstall request is built. It acts like a gatekeeper at the start of the mutation flow, so later code can safely create auth headers knowing the credentials are the right kind.

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

**Purpose**: Performs the shared remote request for plugin-changing actions, such as enable and uninstall. It centralizes the careful parts: authentication, URL construction, HTTP sending, JSON decoding, and response sanity checks.

**Data flow**: It receives the service configuration, optional authentication, the plugin ID, and an action string such as `enable` or `uninstall`. It first verifies the authentication, then builds the correct URL for that plugin and action. It sends an authenticated POST request with a timeout, reads the response body, rejects failed HTTP statuses, parses the JSON response, and checks that the server replied about the same plugin and with the expected enabled state. On success, it returns the parsed response; on failure, it returns a specific mutation error.

**Call relations**: `enable_remote_plugin` and `uninstall_remote_plugin` both call this helper so the two public actions behave consistently. It calls `ensure_codex_backend_auth` to validate credentials, `remote_plugin_mutation_url` to build the endpoint, `build_reqwest_client` to create the HTTP client, `auth_provider_from_auth` to make request headers, and JSON parsing to decode the server’s reply.

*Call graph*: calls 3 internal fn (ensure_codex_backend_auth, remote_plugin_mutation_url, build_reqwest_client); called by 2 (enable_remote_plugin, uninstall_remote_plugin); 2 external calls (auth_provider_from_auth, from_str).


##### `remote_plugin_mutation_url`  (lines 218–235)

```
fn remote_plugin_mutation_url(
    config: &RemotePluginServiceConfig,
    plugin_id: &str,
    action: &str,
) -> Result<String, RemotePluginMutationError>
```

**Purpose**: Builds the exact web address for a remote plugin mutation request. It keeps URL construction in one place so enable and uninstall requests use the same path rules.

**Data flow**: It receives the remote service configuration, the plugin ID, and the action name. It parses the configured ChatGPT base URL, removes an empty trailing path piece if needed, then appends `plugins`, the plugin ID, and the action. It returns the finished URL string, or an error if the base URL is invalid or cannot accept path segments.

**Call relations**: This is called by `post_remote_plugin_mutation` just before the HTTP request is created. Its output becomes the destination for the POST request, so a bad base URL is caught early and reported as a mutation setup error rather than becoming a confusing network failure later.

*Call graph*: called by 1 (post_remote_plugin_mutation); 1 external calls (parse).


### `core-plugins/src/remote/share.rs`

`domain_logic` · `active during remote plugin share commands`

This file is the bridge between a plugin folder on a user’s computer and the remote service where workspace plugins can be shared. Without it, the app could not turn a local plugin into an uploaded share, show the user what they have shared, change who can access it, or cleanly delete it later. The main flow is like mailing a package: first the plugin folder is compressed into a small archive, then the server is asked for a special upload address, then the archive is sent there, and finally the server is told to create or update the shared plugin using that uploaded file. The file also records a local note mapping the remote plugin ID back to the local folder, so future commands can connect “this shared plugin” with “that directory on disk.” Access rules are represented with plain data types: discoverability says whether a plugin is listed, unlisted, or private, and share targets say which user, group, or workspace can read or edit it. One important safety rule is that unlisted workspace shares automatically include the current workspace as a reader target if it is missing. The file also handles paging when listing created plugins, checks upload status codes, limits archive size to 50 MB, and turns lower-level archive or network failures into the remote plugin catalog’s error type.

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

**Purpose**: Uploads a local plugin folder to the remote workspace plugin service and creates or updates a shared plugin record. A caller uses this when the user wants to publish a plugin or save a new version of an existing shared plugin.

**Data flow**: It receives service settings, optional login information, the Codex home folder, the local plugin path, an optional existing remote plugin ID, and access rules. It requires a ChatGPT login, compresses the plugin folder into a tar.gz archive, asks the server for an upload URL, sends the archive to that URL, adjusts the share targets when needed, finalizes the upload with the server, and records the remote ID to local path mapping on disk. It returns the remote plugin ID and, if the service provides one, a share URL.

**Call relations**: This is a top-level sharing operation called by higher-level plugin commands. Inside it, the archive work is moved to a blocking worker so the async task is not stalled, then it calls create_workspace_plugin_upload, put_workspace_plugin_upload, ensure_unlisted_workspace_target, and finalize_workspace_plugin_upload in order. After the server confirms the share, it asks local_paths::record_plugin_share_local_path to remember the local folder; if that bookkeeping fails, it warns but still treats the remote save as successful.

*Call graph*: calls 6 internal fn (create_workspace_plugin_upload, ensure_unlisted_workspace_target, finalize_workspace_plugin_upload, record_plugin_share_local_path, put_workspace_plugin_upload, as_path); 4 external calls (UnexpectedResponse, spawn_blocking, clone, warn!).


##### `list_remote_plugin_shares`  (lines 205–251)

```
async fn list_remote_plugin_shares(
    config: &RemotePluginServiceConfig,
    auth: Option<&CodexAuth>,
    codex_home: &Path,
) -> Result<Vec<RemotePluginShareSummary>, RemotePluginCatalogError>
```

**Purpose**: Builds the list of workspace plugins the current user has created and shared. It enriches the remote data with installation status and any remembered local folder path.

**Data flow**: It receives service settings, optional login information, and the Codex home folder. It fetches all created workspace plugins from the remote service, fetches currently installed workspace plugins, loads the local remote-ID-to-path mapping from disk, and combines these into share summaries. It returns a vector of summaries, or an error if required share information is missing.

**Call relations**: This is used when a higher-level command needs to show the user their shared plugins. It starts by calling fetch_created_workspace_plugins for the remote created list, then also relies on other remote catalog helpers and local_paths::load_plugin_share_local_paths so the final display can connect server-side plugins with local folders.

*Call graph*: calls 2 internal fn (fetch_created_workspace_plugins, load_plugin_share_local_paths); 1 external calls (new).


##### `load_plugin_share_remote_ids_by_local_path`  (lines 253–271)

```
fn load_plugin_share_remote_ids_by_local_path(
    codex_home: &Path,
) -> io::Result<BTreeMap<AbsolutePathBuf, String>>
```

**Purpose**: Loads the saved mapping between local plugin folders and remote plugin IDs, but returns it in the direction that is convenient for looking up a remote ID from a local path.

**Data flow**: It receives the Codex home folder. It reads the stored mapping from disk, checks that every remote plugin ID looks valid, flips each pair from remote ID → local path into local path → remote ID, and returns the new map. If the saved data contains an invalid remote ID, it returns an input/output error.

**Call relations**: This is a utility-style public helper for code that starts from a local plugin folder and wants to know whether it already has a remote share. It delegates the actual disk read to local_paths::load_plugin_share_local_paths and adds validation plus the reversed lookup shape.

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

**Purpose**: Deletes a shared workspace plugin from the remote service and removes its saved local-path record. A caller uses this when the user no longer wants a plugin share to exist.

**Data flow**: It receives service settings, optional login information, the Codex home folder, and the remote plugin ID to delete. It builds the delete URL, sends an authenticated HTTP DELETE request, checks that the server replied with the expected “no content” status, and then removes the local mapping from disk. It returns nothing on success.

**Call relations**: This is a top-level delete operation used by higher-level plugin commands. It builds a request with build_reqwest_client, hands the actual status checking to send_and_expect_status, and then asks local_paths::remove_plugin_share_local_path to clean up local bookkeeping. If that local cleanup fails, it logs a warning rather than undoing the successful remote deletion.

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

**Purpose**: Changes who can access an existing shared plugin and whether it is unlisted or private. It is used when the plugin stays the same but its sharing permissions need to change.

**Data flow**: It receives service settings, optional login information, a remote plugin ID, a list of target users/groups/workspaces, and the desired discoverability setting. It converts the update setting into the broader discoverability type, adds the current workspace as a target when an unlisted share needs it, sends an authenticated HTTP PUT request with the new rules, and returns the server’s updated principals and discoverability.

**Call relations**: This is a public update operation for sharing commands. Before sending the request, it calls ensure_unlisted_workspace_target so unlisted workspace shares remain usable, then uses the configured base URL and HTTP client to send the permission update to the remote service.

*Call graph*: calls 2 internal fn (ensure_unlisted_workspace_target, build_reqwest_client); 1 external calls (format!).


##### `ensure_unlisted_workspace_target`  (lines 329–354)

```
fn ensure_unlisted_workspace_target(
    auth: &CodexAuth,
    discoverability: Option<RemotePluginShareDiscoverability>,
    targets: Option<Vec<RemotePluginShareTarget>>,
) -> Result<Option<Vec<Remo
```

**Purpose**: Makes sure an unlisted workspace share includes the current workspace as a reader. This prevents creating an unlisted share that accidentally does not include the workspace it is meant to belong to.

**Data flow**: It receives the authenticated account, an optional discoverability value, and optional share targets. If the share is not unlisted, it leaves the targets unchanged. If it is unlisted, it reads the account ID from the login, creates an empty target list if needed, adds the workspace reader target when it is missing, and returns the updated list.

**Call relations**: Both save_remote_plugin_share and update_remote_plugin_share_targets call this before sending share rules to the server. It depends on CodexAuth::get_account_id to know the current workspace/account identifier; if that ID is unavailable for an unlisted share, it stops the operation with an error.

*Call graph*: calls 1 internal fn (get_account_id); called by 2 (save_remote_plugin_share, update_remote_plugin_share_targets).


##### `fetch_created_workspace_plugins`  (lines 356–372)

```
async fn fetch_created_workspace_plugins(
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
) -> Result<Vec<RemotePluginDirectoryItem>, RemotePluginCatalogError>
```

**Purpose**: Fetches every workspace plugin created by the current user, even when the server returns the results in pages. It hides pagination from its callers.

**Data flow**: It receives service settings and an authenticated account. It repeatedly asks for one page of created workspace plugins, appends those plugins to a growing list, and follows the next-page token until there are no more pages. It returns the complete list.

**Call relations**: list_remote_plugin_shares calls this when it needs the full created-plugin list. This function drives the loop and delegates each individual page request to get_created_workspace_plugins_page.

*Call graph*: calls 1 internal fn (get_created_workspace_plugins_page); called by 1 (list_remote_plugin_shares); 1 external calls (new).


##### `get_created_workspace_plugins_page`  (lines 374–388)

```
async fn get_created_workspace_plugins_page(
    config: &RemotePluginServiceConfig,
    auth: &CodexAuth,
    page_token: Option<&str>,
) -> Result<RemotePluginListResponse, RemotePluginCatalogError>
```

**Purpose**: Requests one page of created workspace plugins from the remote service. It is the small network step used by the larger pagination loop.

**Data flow**: It receives service settings, an authenticated account, and an optional page token. It builds the created-plugins URL, adds a page size limit and the page token when present, sends an authenticated GET request, and decodes the server response into the plugin list response type.

**Call relations**: fetch_created_workspace_plugins calls this once for the first page and again for each following page token. This function focuses only on one HTTP request; the caller decides whether more pages are needed.

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

**Purpose**: Asks the remote service for a temporary URL where the plugin archive can be uploaded. This is the first server step in saving a shared plugin.

**Data flow**: It receives service settings, authentication, the archive filename, archive size, and an optional existing remote plugin ID. It sends those details as JSON to the upload-url endpoint and decodes the response, which includes a file ID, an upload URL, and possibly an ETag value used later to confirm the upload.

**Call relations**: save_remote_plugin_share calls this after the plugin archive has been prepared. The returned upload URL is then handed to put_workspace_plugin_upload, and the returned file ID and ETag are later handed to finalize_workspace_plugin_upload.

*Call graph*: calls 1 internal fn (build_reqwest_client); called by 1 (save_remote_plugin_share); 1 external calls (format!).


##### `put_workspace_plugin_upload`  (lines 411–439)

```
async fn put_workspace_plugin_upload(
    upload_url: &str,
    archive_bytes: Vec<u8>,
) -> Result<(), RemotePluginCatalogError>
```

**Purpose**: Uploads the compressed plugin archive bytes to the temporary storage URL provided by the server. This sends the actual file contents, not just metadata.

**Data flow**: It receives the upload URL and the archive bytes. It builds an HTTP PUT request with gzip content headers and an Azure-style blob header, sends the bytes, reads the response status and body, and succeeds only if the storage service returns OK or Created. On any other status, it returns an error containing the status and response body.

**Call relations**: save_remote_plugin_share calls this after create_workspace_plugin_upload gives it a temporary upload URL. Once this succeeds, save_remote_plugin_share can safely call finalize_workspace_plugin_upload to tell the main service to use the uploaded file.

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

**Purpose**: Tells the remote plugin service to create a new shared plugin or update an existing one using the file that was just uploaded. This is the final confirmation step after the raw archive upload.

**Data flow**: It receives service settings, authentication, an optional remote plugin ID, and a request body containing the uploaded file ID, ETag, discoverability, and share targets. It chooses the create URL for a new plugin or the update URL for an existing one, sends an authenticated POST request, and decodes the response with the final plugin ID and optional share URL.

**Call relations**: save_remote_plugin_share calls this only after put_workspace_plugin_upload has successfully sent the archive. Its response becomes the final result returned to the caller and is also used to record the local path mapping.

*Call graph*: calls 1 internal fn (build_reqwest_client); called by 1 (save_remote_plugin_share); 1 external calls (format!).


##### `archive_filename`  (lines 458–467)

```
fn archive_filename(plugin_path: &Path) -> Result<String, RemotePluginCatalogError>
```

**Purpose**: Creates the archive filename that will be shown to the upload service. It uses the plugin folder’s name and adds the .tar.gz suffix.

**Data flow**: It receives a plugin path. It extracts the last path component, checks that it is valid UTF-8 text, and returns a filename such as my-plugin.tar.gz. If the path does not end in a usable directory name, it returns an invalid-plugin-path error.

**Call relations**: This helper is used during the archive preparation part of save_remote_plugin_share. It supplies the human-readable filename that create_workspace_plugin_upload sends to the remote service.

*Call graph*: 2 external calls (file_name, format!).


##### `archive_plugin_for_upload`  (lines 469–471)

```
fn archive_plugin_for_upload(plugin_path: &Path) -> Result<Vec<u8>, RemotePluginCatalogError>
```

**Purpose**: Compresses a plugin folder into the archive format expected by the remote upload flow, using the standard maximum size for shared plugins.

**Data flow**: It receives a plugin path. It passes that path and the 50 MB share limit to archive_plugin_for_upload_with_limit, then returns the resulting bytes or any converted error.

**Call relations**: This helper is part of save_remote_plugin_share’s preparation step. It delegates the real packing work to archive_plugin_for_upload_with_limit so tests or internal callers can exercise the same logic with a different size limit.

*Call graph*: calls 1 internal fn (archive_plugin_for_upload_with_limit).


##### `archive_plugin_for_upload_with_limit`  (lines 473–489)

```
fn archive_plugin_for_upload_with_limit(
    plugin_path: &Path,
    max_bytes: usize,
) -> Result<Vec<u8>, RemotePluginCatalogError>
```

**Purpose**: Creates a compressed tar.gz archive of a plugin folder while enforcing a caller-provided byte limit. It turns archive-packing errors into the error language used by the remote plugin catalog.

**Data flow**: It receives a plugin path and a maximum allowed byte count. It calls the plugin bundle archiver, which reads the folder and produces compressed bytes, and maps possible failures into invalid path, archive too large, or input/output archive errors. It returns the archive bytes when packing succeeds.

**Call relations**: archive_plugin_for_upload calls this with the normal remote-share size limit. This function is the adapter between the generic plugin bundle archiving code, pack_plugin_bundle_tar_gz, and the remote sharing code’s own error type.

*Call graph*: calls 1 internal fn (pack_plugin_bundle_tar_gz); called by 1 (archive_plugin_for_upload).


##### `send_and_expect_status`  (lines 491–513)

```
async fn send_and_expect_status(
    request: RequestBuilder,
    url_for_error: &str,
    expected_statuses: &[StatusCode],
) -> Result<(), RemotePluginCatalogError>
```

**Purpose**: Sends an HTTP request and checks that the response status is one of the statuses the caller expected. It is used when the response body does not need to be decoded.

**Data flow**: It receives a prepared HTTP request, a URL label for error messages, and a list of acceptable status codes. It sends the request, captures the status and response text, and returns success only if the status is in the allowed list. Otherwise it returns an unexpected-status error with the body included for troubleshooting.

**Call relations**: delete_remote_plugin_share uses this to verify that the remote delete call returned the expected no-content result. The helper keeps the send-and-check pattern in one place for operations that only care whether the server accepted the request.

*Call graph*: called by 1 (delete_remote_plugin_share); 2 external calls (send, contains).


### `core-plugins/src/remote/share/checkout.rs`

`orchestration` · `request handling`

This file is the “check out this shared plugin” workflow. Imagine someone shares a document with you in the cloud, and you choose “make a local copy I can edit.” This code does the plugin version of that. It first asks the remote plugin service for details about the shared plugin, including its name, marketplace, version, policies, and download link. It checks that the share is from a marketplace type that supports checkout, and that the plugin name is safe to use as part of an identifier or path.

Then it decides where the local editable copy should live. If this remote share was already checked out before and the saved path still exists, it reuses that path. Otherwise it chooses a path under the user’s home directory, usually under a plugins folder, and refuses to overwrite anything already there.

If the plugin is not already local, it downloads and extracts the remote bundle into that path. After that, it updates a personal marketplace JSON file, which is a small catalog telling the app, “this plugin exists locally, here is its name, path, and install/authentication policy.” Finally it records the mapping from the remote plugin id to the local path, so future checkouts can find the same copy. If something fails after creating files, it tries to clean up the newly created checkout folder so the user is not left with a half-installed plugin.

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

**Purpose**: This is the main checkout workflow. It takes a remote shared plugin id, downloads the plugin if necessary, adds it to the user's personal marketplace, and returns the key facts needed to use it locally.

**Data flow**: It receives service configuration, optional login information, the Codex home folder, and a remote plugin id. It fetches remote plugin details, validates that the share can be checked out, chooses or reuses a local path, downloads the bundle when needed, updates the personal marketplace file, records the remote-id-to-local-path mapping, and finally returns a result containing the remote id, local plugin id, plugin name, local plugin path, marketplace name/path, and remote version. If a later step fails after creating files, it tries to remove the newly created local checkout before returning the error.

**Call relations**: This function is the conductor for the file. It calls helpers to check whether the marketplace supports checkout, load saved local paths, choose a safe checkout path, update the personal marketplace, and clean up on failure. It also hands work to outside services for fetching plugin details, validating/downloading the remote bundle, and recording the local path mapping.

*Call graph*: calls 11 internal fn (home_dir, clean_up_created_checkout_path, editable_plugin_path_for_checkout, is_checkout_supported_share_marketplace, load_share_local_paths_for_checkout, update_personal_marketplace, record_plugin_share_local_path, download_and_extract_remote_plugin_bundle_to_path, validate_remote_plugin_bundle, new (+1 more)); 4 external calls (validate_plugin_segment, UnexpectedResponse, format!, fetch_remote_plugin_detail_with_download_urls).


##### `is_checkout_supported_share_marketplace`  (lines 164–171)

```
fn is_checkout_supported_share_marketplace(marketplace_name: &str) -> bool
```

**Purpose**: This function answers a simple yes/no question: is this remote marketplace one of the share marketplaces that can be checked out locally?

**Data flow**: It receives a marketplace name string. It compares that name with the known shared-with-me marketplace names and returns true only when it matches one of them.

**Call relations**: The main checkout function calls this after fetching remote plugin details. If it returns false, checkout stops early because the plugin is not from a supported share source.

*Call graph*: called by 1 (checkout_remote_plugin_share); 1 external calls (matches!).


##### `load_share_local_paths_for_checkout`  (lines 173–183)

```
fn load_share_local_paths_for_checkout(
    codex_home: &Path,
) -> Result<BTreeMap<String, AbsolutePathBuf>, RemotePluginCatalogError>
```

**Purpose**: This function loads the saved map that remembers where shared remote plugins were checked out on this machine. It is forgiving if that map is corrupted, treating bad data as if there were no saved paths.

**Data flow**: It receives the Codex home folder. It asks the local-paths module to read the stored mapping from remote plugin ids to local paths. If reading succeeds, it returns the map. If the file has invalid data, it returns an empty map. If some other read problem happens, it turns that into a remote plugin catalog error.

**Call relations**: The main checkout flow calls this before choosing a local path. The returned map lets checkout reuse an existing local copy instead of downloading a second copy.

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

**Purpose**: This function chooses the local folder where the checked-out plugin should live, and tells the caller whether the plugin is already checked out there.

**Data flow**: It receives the user's home directory, the plugin name, the remote plugin id, and the saved path map. If the map already has a path for this remote id and that path exists, it verifies the path can be listed in the personal marketplace and returns it with “already checked out” set to true. Otherwise it uses the saved path if present, or builds a default path under the home directory. It refuses paths outside the home directory and refuses to overwrite an existing file or folder.

**Call relations**: The main checkout flow calls this after loading saved local paths. It relies on the path validation helper to make sure the chosen path can later be written into the personal marketplace.

*Call graph*: calls 1 internal fn (ensure_path_can_be_listed_in_personal_marketplace); called by 1 (checkout_remote_plugin_share); 1 external calls (format!).


##### `clean_up_created_checkout_path`  (lines 216–232)

```
fn clean_up_created_checkout_path(
    created_checkout_path: bool,
    local_plugin_path: &AbsolutePathBuf,
    original_err: RemotePluginCatalogError,
) -> RemotePluginCatalogError
```

**Purpose**: This function preserves the original error but also tries to remove a checkout folder or file that was just created before the error happened.

**Data flow**: It receives a flag saying whether this checkout created the local path, the local plugin path, and the original error. If nothing was created, it returns the original error unchanged. If something was created, it tries to delete it. If deletion works, it still returns the original error. If deletion also fails, it returns a new error that includes both the original problem and the cleanup problem.

**Call relations**: The main checkout flow calls this when updating the marketplace or recording the local path mapping fails after a download/extract may have created files. It delegates the actual deletion to remove_created_checkout_path.

*Call graph*: calls 1 internal fn (remove_created_checkout_path); called by 1 (checkout_remote_plugin_share); 2 external calls (UnexpectedResponse, format!).


##### `remove_created_checkout_path`  (lines 234–240)

```
fn remove_created_checkout_path(local_plugin_path: &AbsolutePathBuf) -> io::Result<()>
```

**Purpose**: This function deletes the local path created for a checkout, whether it is a directory or a single file.

**Data flow**: It receives the local plugin path. If the path is a directory, it removes the directory and everything inside it. Otherwise, it removes the file at that path. It returns success or the filesystem error that occurred.

**Call relations**: It is called only by clean_up_created_checkout_path. It does the low-level disk cleanup while the caller decides how to report any cleanup failure.

*Call graph*: calls 1 internal fn (as_path); called by 1 (clean_up_created_checkout_path); 2 external calls (remove_dir_all, remove_file).


##### `ensure_path_can_be_listed_in_personal_marketplace`  (lines 242–247)

```
fn ensure_path_can_be_listed_in_personal_marketplace(
    home: &AbsolutePathBuf,
    path: &AbsolutePathBuf,
) -> Result<(), RemotePluginCatalogError>
```

**Purpose**: This function checks that a local plugin path is valid for the personal marketplace catalog. In practice, that means the path must be inside the user's home directory and expressible as a clean relative path.

**Data flow**: It receives the user's home directory and a local plugin path. It tries to convert the local path into the relative form used by the personal marketplace. If that conversion succeeds, it returns success; if not, it returns the same path-related error.

**Call relations**: The path choosing function calls this before accepting either an existing checkout path or a new checkout path. It is a small wrapper around personal_marketplace_relative_plugin_path.

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

**Purpose**: This function adds or refreshes the checked-out plugin entry in the user's personal marketplace JSON file. That file is the local catalog that lets the app discover this plugin as a local plugin.

**Data flow**: It receives the home directory, plugin name, local plugin path, install policy, authentication policy, and optional category. It computes the personal marketplace file path, converts the plugin path to a marketplace-friendly relative path, reads the existing marketplace file or creates a default one, validates that the marketplace structure is sane, builds the plugin entry, replaces an existing entry for the same plugin when it points to the same path, or appends a new one. It writes the updated JSON back to disk atomically and returns the marketplace name and path.

**Call relations**: The main checkout flow calls this after the local plugin path exists or has been confirmed reusable. This function uses helpers to read/create the marketplace JSON, build the plugin entry, validate paths, format policy values, report invalid marketplace files, and write the final JSON safely.

*Call graph*: calls 6 internal fn (invalid_marketplace_file, personal_marketplace_plugin_entry, personal_marketplace_relative_plugin_path, read_or_create_personal_marketplace, write_json_atomically, join); called by 1 (checkout_remote_plugin_share); 3 external calls (validate_plugin_segment, format!, to_string_pretty).


##### `read_or_create_personal_marketplace`  (lines 343–364)

```
fn read_or_create_personal_marketplace(
    marketplace_path: &Path,
) -> Result<JsonValue, RemotePluginCatalogError>
```

**Purpose**: This function loads the user's personal marketplace file, or creates a default in-memory marketplace if the file does not exist yet.

**Data flow**: It receives the path to the marketplace JSON file. If the file exists, it reads it as text and parses it as JSON. If the file is missing, it returns a new JSON object with the default marketplace name, display name, and an empty plugin list. If reading fails or the JSON is malformed, it returns an appropriate error.

**Call relations**: update_personal_marketplace calls this before editing the marketplace data. This function supplies the JSON object that later gets updated and written back to disk.

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

**Purpose**: This function builds the JSON entry for one local plugin inside the personal marketplace. The entry says the plugin is local, where it is, and what install and authentication rules apply.

**Data flow**: It receives the plugin name, the relative plugin path, install policy, authentication policy, and optional category. It creates a JSON object with the plugin name, local source path, and policy values. If a non-empty category is provided, it adds that category to the object. The completed JSON entry is returned.

**Call relations**: update_personal_marketplace calls this when it needs the new or refreshed plugin entry. The policy fields inside the entry are converted by the install-policy and auth-policy helper functions.

*Call graph*: called by 1 (update_personal_marketplace); 1 external calls (json!).


##### `plugin_install_policy_value`  (lines 393–399)

```
fn plugin_install_policy_value(policy: PluginInstallPolicy) -> &'static str
```

**Purpose**: This function converts the program's install policy value into the exact text stored in the marketplace JSON file.

**Data flow**: It receives an install policy such as not available, available, or installed by default. It returns the matching uppercase string used in JSON.

**Call relations**: personal_marketplace_plugin_entry uses this while building the plugin's policy section. It keeps the JSON spelling in one place.


##### `plugin_auth_policy_value`  (lines 401–406)

```
fn plugin_auth_policy_value(policy: PluginAuthPolicy) -> &'static str
```

**Purpose**: This function converts the program's authentication policy value into the exact text stored in the marketplace JSON file.

**Data flow**: It receives an authentication policy saying whether authentication happens on install or on use. It returns the matching uppercase string used in JSON.

**Call relations**: personal_marketplace_plugin_entry uses this while building the plugin's policy section. It keeps the JSON spelling consistent.


##### `personal_marketplace_relative_plugin_path`  (lines 408–449)

```
fn personal_marketplace_relative_plugin_path(
    home: &AbsolutePathBuf,
    local_plugin_path: &AbsolutePathBuf,
) -> Result<String, RemotePluginCatalogError>
```

**Purpose**: This function turns an absolute local plugin path into the relative path format used in the personal marketplace file. It also protects the marketplace from paths that point outside the user's home directory or cannot be represented safely.

**Data flow**: It receives the home directory and the absolute local plugin path. It strips the home directory prefix, walks each path component, rejects non-text path parts, parent-directory jumps, roots, and other unsafe components, and rejects the home directory itself as a plugin path. If everything is valid, it returns a string like ./plugins/example.

**Call relations**: The checkout path validation helper calls this while deciding whether a path is acceptable. update_personal_marketplace calls it again to get the exact relative path that will be written into the JSON file.

*Call graph*: calls 2 internal fn (as_path, to_path_buf); called by 2 (ensure_path_can_be_listed_in_personal_marketplace, update_personal_marketplace); 2 external calls (new, format!).


##### `invalid_marketplace_file`  (lines 451–456)

```
fn invalid_marketplace_file(path: &Path, message: &str) -> RemotePluginCatalogError
```

**Purpose**: This function creates a consistent error for a personal marketplace file that exists but has an invalid shape or invalid contents.

**Data flow**: It receives the marketplace file path and a human-readable reason. It returns an InvalidPluginPath error containing that path and reason.

**Call relations**: update_personal_marketplace and read_or_create_personal_marketplace use this when the JSON file cannot be parsed, is not an object, has the wrong field types, has an invalid marketplace name, or already lists the plugin with a conflicting path.

*Call graph*: called by 1 (update_personal_marketplace); 1 external calls (to_path_buf).


##### `write_json_atomically`  (lines 458–470)

```
fn write_json_atomically(write_path: &Path, contents: &str) -> io::Result<()>
```

**Purpose**: This function writes JSON to disk in a safer way: it writes to a temporary file first, then swaps that file into place. This reduces the chance of leaving a half-written marketplace file if something goes wrong mid-write.

**Data flow**: It receives the final path and the text contents to write. It finds or creates the parent directory, creates a temporary file in that directory, writes all contents into it, and then persists the temporary file as the final path. It returns success or the filesystem error that occurred.

**Call relations**: update_personal_marketplace calls this after preparing the updated marketplace JSON. This is the last disk-writing step for the marketplace update.

*Call graph*: called by 1 (update_personal_marketplace); 3 external calls (parent, create_dir_all, new_in).


### Discovery and connector policy
These files compute connector availability, tool policy, discoverable plugin suggestions, mention parsing, and related utility normalization used by install-suggestion and selection flows.

### `connectors/src/app_tool_policy.rs`

`domain_logic` · `tool exposure and tool-call policy checks`

App connectors can expose many tools, but not every tool should always be shown or run automatically. Some tools may be destructive, such as deleting data, or “open world,” meaning they can reach outside a narrow safe sandbox. This file is the rulebook that turns configuration into a simple answer: enabled or disabled, and automatic or approval-required.

The main type is AppToolPolicy, which is the final answer for one tool. AppToolPolicyEvaluator is the reusable calculator. It reads one snapshot of configuration, including normal app settings and stricter managed requirements, then can be asked about many tools without re-reading everything each time.

The policy is built in layers, like checking a building access list. First, managed requirements can force restrictions, such as disabling an app or setting a required approval mode. Then app-level and tool-level settings are checked. A specific tool setting wins over an app default. If nothing is configured, the default is permissive: tools are enabled and use automatic approval. Finally, safety hints matter: if a tool says it is destructive or open-world, and that kind of tool is disabled for the app, the tool is turned off.

#### Function details

##### `AppToolPolicy::default`  (lines 15–20)

```
fn default() -> Self
```

**Purpose**: Creates the fallback policy for a tool: enabled, with automatic approval. This is the baseline used when no configuration says otherwise.

**Data flow**: It takes no outside input. It fills in a new AppToolPolicy with enabled set to true and approval set to Auto, then returns that policy.

**Call relations**: When handle_mcp_tool_call needs a basic policy value, it can call this default so the system has a safe, predictable starting point before applying any stricter rules.

*Call graph*: called by 1 (handle_mcp_tool_call).


##### `AppToolPolicyEvaluator::new`  (lines 43–47)

```
fn new(config_layer_stack: &'a ConfigLayerStack) -> Self
```

**Purpose**: Builds a policy evaluator from the current configuration layers. Callers use this when they want to evaluate several tools against the same configuration snapshot.

**Data flow**: It receives a ConfigLayerStack, which is a stack of configuration sources already arranged by priority. It reads the merged app configuration, also reads any requirements configuration, and passes those pieces into the evaluator constructor. It returns an AppToolPolicyEvaluator ready to answer tool policy questions.

**Call relations**: policy_from_config_parts, handle_mcp_tool_call, and filter_codex_apps_mcp_tools call this when they need policy decisions. Inside, it asks the config stack for requirements_toml, calls apps_config_from_layer_stack to decode normal app settings, and then hands both pieces to from_parts so the final evaluator sees one cleaned-up view.

*Call graph*: calls 2 internal fn (requirements_toml, apps_config_from_layer_stack); called by 3 (policy_from_config_parts, handle_mcp_tool_call, filter_codex_apps_mcp_tools); 1 external calls (from_parts).


##### `AppToolPolicyEvaluator::policy`  (lines 49–56)

```
fn policy(&self, input: AppToolPolicyInput<'_>) -> AppToolPolicy
```

**Purpose**: Decides the final policy for one specific app tool. It answers two practical questions: is this tool available, and what approval mode does it require?

**Data flow**: It receives an AppToolPolicyInput, which includes the connector id, tool name, optional display title, and safety hints. It first looks for a managed approval rule for that exact tool. Then it combines that rule with the stored app configuration and returns one AppToolPolicy.

**Call relations**: Callers use this after creating an evaluator with new. The function first asks managed_app_tool_approval whether a managed requirement overrides approval, then passes everything to app_tool_policy_from_apps_config, which performs the full enabled/approval calculation.

*Call graph*: calls 2 internal fn (app_tool_policy_from_apps_config, managed_app_tool_approval).


##### `AppToolPolicyEvaluator::from_parts`  (lines 58–66)

```
fn from_parts(
        apps_config: Option<AppsConfigToml>,
        requirements_apps_config: Option<&'a AppsRequirementsToml>,
    ) -> Self
```

**Purpose**: Builds an evaluator from already-separated configuration pieces. This is useful when tests or setup code already have the app settings and requirements ready.

**Data flow**: It receives optional normal app configuration and optional requirements app configuration. It applies requirement constraints to the normal configuration through effective_apps_config, stores the resulting app configuration, and keeps a reference to the requirements for later tool-level approval checks.

**Call relations**: evaluator_reuses_one_snapshot_across_tools calls this to confirm that one prepared snapshot can be reused. The normal construction path also prepares the same ingredients in new before producing an evaluator.

*Call graph*: calls 1 internal fn (effective_apps_config); called by 1 (evaluator_reuses_one_snapshot_across_tools).


##### `apps_config_from_layer_stack`  (lines 70–79)

```
fn apps_config_from_layer_stack(
    config_layer_stack: &ConfigLayerStack,
) -> Option<AppsConfigToml>
```

**Purpose**: Extracts the app-related configuration from the project’s merged configuration stack. It turns the raw configuration value into the typed AppsConfigToml structure used by the policy code.

**Data flow**: It receives a ConfigLayerStack. It asks for the effective_config, looks for the top-level apps section, clones that raw value, and tries to deserialize it into AppsConfigToml. If the section is missing or cannot be decoded, it returns None.

**Call relations**: AppToolPolicyEvaluator::new calls this during setup. This keeps decoding in one place so the evaluator can work with clean Rust data instead of raw configuration tables.

*Call graph*: calls 1 internal fn (effective_config); called by 1 (new).


##### `app_is_enabled`  (lines 81–92)

```
fn app_is_enabled(apps_config: &AppsConfigToml, connector_id: Option<&str>) -> bool
```

**Purpose**: Answers whether a whole app connector is enabled before looking at individual tools. If an app is disabled, its tools should not be available even if a tool has its own settings.

**Data flow**: It receives the app configuration and an optional connector id. It starts with the global default enabled setting, falling back to true if no default exists. If a connector-specific setting exists, that setting replaces the default. It returns true or false.

**Call relations**: app_tool_policy_from_apps_config calls this while building the final tool policy. It acts as the gate at the app level before more detailed tool-level rules are considered.

*Call graph*: called by 1 (app_tool_policy_from_apps_config).


##### `effective_apps_config`  (lines 94–106)

```
fn effective_apps_config(
    apps_config: Option<AppsConfigToml>,
    requirements_apps_config: Option<&AppsRequirementsToml>,
) -> Option<AppsConfigToml>
```

**Purpose**: Creates the app configuration that should actually be used after managed requirements have been applied. This makes stricter requirement rules part of the same view as normal settings.

**Data flow**: It receives optional normal app configuration and optional requirements configuration. If no normal app configuration exists, it starts from an empty default. It then calls apply_requirements_apps_constraints to enforce requirement rules, and returns Some configuration only if there is anything meaningful to use; otherwise it returns None.

**Call relations**: AppToolPolicyEvaluator::from_parts calls this while preparing an evaluator. It hands off the enforcement step to apply_requirements_apps_constraints so later policy checks do not need to remember to apply those app-level restrictions themselves.

*Call graph*: calls 1 internal fn (apply_requirements_apps_constraints); called by 1 (from_parts).


##### `apply_requirements_apps_constraints`  (lines 108–122)

```
fn apply_requirements_apps_constraints(
    apps_config: &mut AppsConfigToml,
    requirements_apps_config: Option<&AppsRequirementsToml>,
)
```

**Purpose**: Applies managed requirement rules that restrict app availability. In this file, it enforces the rule that requirements can force an app to be disabled.

**Data flow**: It receives a mutable AppsConfigToml and optional requirements app configuration. If there are no requirements, it leaves the config unchanged. If a requirement says an app is explicitly disabled, it creates or updates that app’s entry in the normal config and sets enabled to false.

**Call relations**: effective_apps_config calls this while building the final app configuration snapshot. Its changes become part of the configuration that app_tool_policy_from_apps_config later reads.

*Call graph*: called by 1 (effective_apps_config).


##### `managed_app_tool_approval`  (lines 124–138)

```
fn managed_app_tool_approval(
    requirements_apps_config: Option<&AppsRequirementsToml>,
    connector_id: Option<&str>,
    tool_name: &str,
) -> Option<AppToolApproval>
```

**Purpose**: Looks for a managed requirement that sets the approval mode for one exact tool. Managed approval rules take priority over user or app settings.

**Data flow**: It receives optional requirements configuration, an optional connector id, and a tool name. If any needed piece is missing, it returns None. Otherwise it walks to that connector’s tool settings and returns the tool’s approval mode if one is configured.

**Call relations**: AppToolPolicyEvaluator::policy calls this before calculating the full policy. The result is passed into app_tool_policy_from_apps_config so managed approval can override lower-priority approval settings.

*Call graph*: called by 1 (policy).


##### `app_tool_policy_from_apps_config`  (lines 140–203)

```
fn app_tool_policy_from_apps_config(
    apps_config: Option<&AppsConfigToml>,
    input: AppToolPolicyInput<'_>,
    managed_approval: Option<AppToolApproval>,
) -> AppToolPolicy
```

**Purpose**: Combines all available rules into the final policy for one tool. This is the core decision function for enabled/disabled status and approval mode.

**Data flow**: It receives optional app configuration, one tool’s input facts, and an optional managed approval override. If there is no app configuration, it returns the default enabled policy with managed approval if present. Otherwise it finds the connector, finds a matching tool by name or title, chooses approval in priority order, checks whether the whole app is enabled, checks tool-specific and app-default enabled settings, and finally uses destructive/open-world safety hints to decide availability. It returns one AppToolPolicy.

**Call relations**: AppToolPolicyEvaluator::policy calls this after checking managed approval. During its work it calls app_is_enabled for the app-level gate and uses the default policy path when there is no app configuration to consult.

*Call graph*: calls 1 internal fn (app_is_enabled); called by 1 (policy); 1 external calls (default).


### `utils/plugins/src/mcp_connector.rs`

`util` · `cross-cutting`

This file solves two practical problems that come up when working with MCP connectors, which are plugin-like integrations. First, some connector IDs must not be used. The blocked list depends on who is using the system: a first-party Chat originator, meaning an official Chat client, has a different blocked connector list from other clients. This is like a door guard checking both the visitor’s badge and which entrance they came through before deciding whether they may enter.

Second, connector or app names often come from people or outside systems, so they may contain spaces, punctuation, uppercase letters, or other characters that are awkward in code or APIs. The sanitizing helpers turn those names into predictable lowercase identifiers. Letters and numbers are kept, other characters become separators, leading and trailing separators are removed, and an empty result becomes the safe fallback name "app". For callable names, dashes are then changed to underscores, which are often safer in programming-language-style names.

Without this file, blocked connectors could accidentally be exposed in the wrong context, and plugin names could be inconsistent or unsafe to use as identifiers.

#### Function details

##### `is_connector_id_allowed`  (lines 15–17)

```
fn is_connector_id_allowed(connector_id: &str) -> bool
```

**Purpose**: This is the public check for whether a connector ID may be used right now. It hides the detail of figuring out the current originator, which is the client or product area making the request.

**Data flow**: It takes a connector ID as text. It reads the current originator from the login/default client layer, passes both the connector ID and that originator value into the more specific checker, and returns true if the connector is allowed or false if it is blocked.

**Call relations**: Other code can call this when it needs a simple yes-or-no answer before showing or using a connector. It asks originator for the current client identity, then hands the actual decision to is_connector_id_allowed_for_originator so the rule stays in one place.

*Call graph*: calls 2 internal fn (originator, is_connector_id_allowed_for_originator).


##### `is_connector_id_allowed_for_originator`  (lines 19–27)

```
fn is_connector_id_allowed_for_originator(connector_id: &str, originator_value: &str) -> bool
```

**Purpose**: This function applies the connector blocking rule for a specific originator value. It is useful because the same connector ID can be allowed in one context but blocked in another.

**Data flow**: It receives a connector ID and an originator value. It checks whether the originator is a first-party Chat originator; based on that, it chooses the matching blocked-ID list. It then returns the opposite of membership in that list: true when the ID is not listed, false when it is listed.

**Call relations**: is_connector_id_allowed calls this after it has found the current originator. This function relies on is_first_party_chat_originator to classify the originator before it chooses which blocked connector list to use.

*Call graph*: calls 1 internal fn (is_first_party_chat_originator); called by 1 (is_connector_id_allowed).


##### `sanitize_name`  (lines 29–31)

```
fn sanitize_name(name: &str) -> String
```

**Purpose**: This function turns an arbitrary name into a safer callable name, using underscores instead of dashes. It is meant for places that need a name shaped more like a code identifier.

**Data flow**: It takes a name as text. It first asks sanitize_slug to normalize the name into a lowercase dash-separated form, then replaces every dash with an underscore. It returns the cleaned name as a new string.

**Call relations**: normalize_codex_apps_callable_name calls this when it needs a safe callable name for a Codex app. sanitize_name delegates the detailed cleanup to sanitize_slug, then makes the final underscore conversion for callable-name style.

*Call graph*: calls 1 internal fn (sanitize_slug); called by 1 (normalize_codex_apps_callable_name).


##### `sanitize_slug`  (lines 33–48)

```
fn sanitize_slug(name: &str) -> String
```

**Purpose**: This function creates a simple lowercase slug from a name. A slug is a compact, URL- or ID-friendly version of text, such as turning "My App!" into "my-app".

**Data flow**: It takes a name as text and builds a new string. Letters and numbers are kept and lowercased; every other character becomes a dash. Afterward it removes dashes from the start and end. If nothing usable remains, it returns "app" as a safe default; otherwise it returns the cleaned slug.

**Call relations**: sanitize_name calls this as the first cleanup step before converting dashes to underscores. Internally it pre-allocates enough string space for the input size so it can build the normalized result efficiently.

*Call graph*: called by 1 (sanitize_name); 1 external calls (with_capacity).


### `utils/plugins/src/plugin_namespace.rs`

`domain_logic` · `plugin or skill discovery`

A skill file may live several folders deep inside a plugin, so the system needs a reliable way to answer: “What plugin namespace should this skill use?” This file provides that answer. Think of it like finding the name of a building by walking from an office back toward the front door until you find the building directory.

The file recognizes two possible manifest locations under a plugin root: `.codex-plugin/plugin.json` and `.claude-plugin/plugin.json`. A manifest is a small JSON file that can contain the plugin’s `name`. The main flow starts with a skill path, checks each parent folder, and asks whether that folder looks like a plugin root. A folder counts as a plugin root if one of the known manifest files exists there and can be read as JSON.

If the manifest has a non-empty `name`, that name becomes the namespace. If the `name` field is missing or blank, the code falls back to the plugin folder’s own directory name. If no usable manifest is found in any ancestor folder, the result is `None`, meaning no plugin namespace could be determined.

The file includes both asynchronous lookup through the project’s filesystem interface and a simpler local filesystem helper, plus tests for both supported manifest locations.

#### Function details

##### `find_plugin_manifest_path`  (lines 13–18)

```
fn find_plugin_manifest_path(plugin_root: &Path) -> Option<PathBuf>
```

**Purpose**: Looks inside a possible plugin root and returns the first recognized plugin manifest file that actually exists. This is useful when code already has a candidate plugin folder and wants to know where its manifest is.

**Data flow**: It receives a folder path that might be a plugin root. It appends each known manifest location to that folder, checks whether the resulting path is a file, and returns the first matching path. If neither manifest file exists, it returns nothing.

**Call relations**: This helper uses the fixed list of supported manifest locations. In this file’s tests, it is used to confirm that the alternate `.claude-plugin/plugin.json` location is discovered correctly.


##### `plugin_manifest_name`  (lines 27–58)

```
async fn plugin_manifest_name(
    fs: &dyn ExecutorFileSystem,
    plugin_root: &AbsolutePathBuf,
) -> Option<String>
```

**Purpose**: Checks one folder to see whether it is a plugin root, then reads the plugin name from its manifest. It also applies the fallback rule: if the manifest name is blank, use the folder’s own name instead.

**Data flow**: It receives the project filesystem interface and an absolute folder path. It tries each known manifest location under that folder, asks the filesystem whether the candidate is a file, reads the first valid manifest it finds, and parses its JSON. The output is the plugin name as a string, or nothing if no readable, valid manifest is found.

**Call relations**: This is the worker used by `plugin_namespace_for_skill_path`. Each time the outer search reaches another ancestor folder, it asks this function, “Does this folder declare a plugin name?” This function in turn relies on filesystem calls to check metadata and read text, and on JSON parsing to extract the manifest name.

*Call graph*: calls 3 internal fn (read_file_text, join, from_abs_path); called by 1 (plugin_namespace_for_skill_path); 3 external calls (get_metadata, from_str, file_name).


##### `plugin_namespace_for_skill_path`  (lines 62–72)

```
async fn plugin_namespace_for_skill_path(
    fs: &dyn ExecutorFileSystem,
    path: &AbsolutePathBuf,
) -> Option<String>
```

**Purpose**: Finds the plugin namespace for a skill file by searching upward through its parent folders. This is the main function other code would call when it has a skill path and needs to know which plugin owns it.

**Data flow**: It receives the filesystem interface and the absolute path to a skill file or something inside a plugin. Starting at that path and moving through each ancestor folder, it asks `plugin_manifest_name` whether that folder has a usable plugin manifest. The first name found is returned. If the search reaches the top without finding one, it returns nothing.

**Call relations**: This function coordinates the namespace lookup. It does not parse manifests itself; instead, it walks the folder chain and delegates each possible plugin root check to `plugin_manifest_name`.

*Call graph*: calls 2 internal fn (ancestors, plugin_manifest_name).


##### `tests::uses_manifest_name`  (lines 86–104)

```
async fn uses_manifest_name()
```

**Purpose**: Verifies that the namespace lookup uses the `name` field from the standard `.codex-plugin/plugin.json` manifest. It proves the normal plugin layout works as expected.

**Data flow**: The test creates a temporary plugin-like folder tree, writes a skill file, writes a standard manifest containing `{"name":"sample"}`, then calls `plugin_namespace_for_skill_path`. The expected result is the string `sample`.

**Call relations**: This test exercises the main lookup path through `plugin_namespace_for_skill_path`, which then calls `plugin_manifest_name` to find and read the manifest.

*Call graph*: 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `tests::uses_name_from_alternate_discoverable_manifest_path`  (lines 107–124)

```
async fn uses_name_from_alternate_discoverable_manifest_path()
```

**Purpose**: Verifies that the alternate `.claude-plugin/plugin.json` manifest location is also accepted. This matters because the code supports more than one plugin manifest layout.

**Data flow**: The test creates a temporary plugin-like folder tree, places the manifest at the alternate location, writes a skill file, and runs the namespace lookup. It expects the namespace `sample`, and also checks that `find_plugin_manifest_path` returns the alternate manifest path.

**Call relations**: This test covers both the asynchronous namespace lookup through `plugin_namespace_for_skill_path` and the simpler local manifest finder `find_plugin_manifest_path`, confirming that both understand the alternate manifest location.

*Call graph*: 4 external calls (assert_eq!, create_dir_all, write, tempdir).


### `core/src/connectors.rs`

`orchestration` · `connector discovery, tool suggestion, and MCP request handling`

A connector is an app integration, such as a service that exposes tools to Codex. This file answers practical questions like: “Which app connectors are available to this user?”, “Are they enabled by config?”, “Which ones should show up as suggested tools?”, and “Who should review approval requests for this connector?” Without it, Codex could show the wrong apps, miss apps the user has access to, or repeatedly start expensive discovery work.

Most connector information comes from MCP, the Model Context Protocol, which is a way for external tool servers to advertise tools to Codex. The file starts MCP discovery when needed, reads the tools exposed by the special Codex Apps MCP server, and turns those low-level tools into higher-level app records. It also keeps a short-lived in-memory cache, like a note on a desk, so repeated calls do not restart discovery every time.

The file combines several sources of truth. Login state decides whether hosted app support is available. Configuration decides whether apps are enabled or disabled. Plugin provenance adds “this came from plugin X” labels. Directory cache data helps tool suggestions include connectors even before they are loaded. The result is a clean list of app connector records that the rest of Codex can display, use, or filter.

#### Function details

##### `list_accessible_connectors_from_mcp_tools`  (lines 72–82)

```
async fn list_accessible_connectors_from_mcp_tools(
    config: &Config,
) -> anyhow::Result<Vec<AppInfo>>
```

**Purpose**: Returns the app connectors the current user can access, based on tools advertised through MCP. It is the simple public entry point when the caller only wants the connector list and does not need readiness details.

**Data flow**: It receives the main configuration, asks the fuller discovery function to fetch connector status without forcing a refresh, then strips the answer down to just the connector records. The output is a list of app information records.

**Call relations**: When tool metadata lookup needs connector information, it calls this helper. This helper immediately delegates to the richer status-returning discovery path so there is only one main implementation of MCP connector discovery.

*Call graph*: calls 1 internal fn (list_accessible_connectors_from_mcp_tools_with_options_and_status); called by 1 (lookup_mcp_tool_metadata).


##### `list_accessible_and_enabled_connectors_from_manager`  (lines 84–95)

```
async fn list_accessible_and_enabled_connectors_from_manager(
    mcp_connection_manager: &McpConnectionManager,
    config: &Config,
) -> Vec<AppInfo>
```

**Purpose**: Builds a list of connectors that are both visible to the user and currently enabled by configuration. This is useful when the system is preparing the initial working context and should ignore disabled apps.

**Data flow**: It receives an existing MCP connection manager and configuration. It asks the manager for all known tools, converts Codex Apps tools into connector records, applies enable/disable rules from config, then removes anything that is not both accessible and enabled.

**Call relations**: The initial context builder calls this when it already has an MCP manager available. Instead of starting discovery itself, this function reuses that manager, then hands the raw tool list to the connector conversion and enabled-state logic.

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

**Purpose**: Creates the list of tools that can be suggested to the user, combining app connectors and plugins. It respects authentication, user configuration, disabled entries, and plugin-provided connector IDs.

**Data flow**: It receives configuration, a plugin manager, optional login information, currently accessible connectors, and connector IDs already loaded by plugins. It decides which connector IDs are eligible, loads cached directory connector data, merges plugin connectors into that directory data, filters to what should be shown, then appends discoverable plugin tools. The result is one combined list of discoverable tools.

**Call relations**: The tool-building flow calls this when it needs suggestions. This function coordinates connector-directory helpers, connector filtering, the originator identity used for allow/block rules, and the plugin discovery function, then returns one combined stream of suggestions.

*Call graph*: calls 5 internal fn (filter_tool_suggest_discoverable_connectors, merge_plugin_connectors, cached_directory_connectors_for_tool_suggest_with_auth, tool_suggest_connector_ids, originator); called by 1 (built_tools); 1 external calls (list_tool_suggest_discoverable_plugins).


##### `list_cached_accessible_connectors_from_mcp_tools`  (lines 132–151)

```
async fn list_cached_accessible_connectors_from_mcp_tools(
    config: &Config,
) -> Option<Vec<AppInfo>>
```

**Purpose**: Tries to return recently discovered accessible connectors without starting MCP discovery again. It is a fast path for callers that can use cached data if it exists.

**Data flow**: It reads configuration, loads the current authentication state, checks whether app support is allowed for that kind of login, builds a cache key for this user and ChatGPT backend, and looks in the in-memory cache. If a matching unexpired entry exists, it filters out disallowed connectors and returns them; otherwise it returns no cached result.

**Call relations**: Plugin installation and tool metadata lookup call this when they want a quick answer. It relies on the cache key builder and cache reader, rather than talking to MCP directly.

*Call graph*: calls 3 internal fn (accessible_connectors_cache_key, read_cached_accessible_connectors, shared_from_config); called by 2 (plugin_apps_needing_auth_for_install, lookup_mcp_tool_metadata); 1 external calls (new).


##### `refresh_accessible_connectors_cache_from_mcp_tools`  (lines 153–168)

```
fn refresh_accessible_connectors_cache_from_mcp_tools(
    config: &Config,
    auth: Option<&CodexAuth>,
    mcp_tools: &[ToolInfo],
)
```

**Purpose**: Updates the connector cache from a known list of MCP tools. This lets other flows refresh the shared cache after they have already fetched tools for another reason.

**Data flow**: It receives configuration, optional authentication, and MCP tool records. If the Apps feature is off, it does nothing. Otherwise it builds the user-specific cache key, extracts accessible connectors from the tools, filters out disallowed connectors, and writes the cleaned list into the cache.

**Call relations**: Authentication refresh and missing-connector refresh flows call this after getting new MCP tool data. It does not start discovery itself; it turns already-available tools into cached connector records.

*Call graph*: calls 5 internal fn (filter_disallowed_connectors, accessible_connectors_cache_key, accessible_connectors_from_mcp_tools, write_cached_accessible_connectors, originator); called by 2 (refresh_codex_apps_after_connector_auth, refresh_missing_requested_connectors).


##### `list_accessible_connectors_from_mcp_tools_with_options`  (lines 170–179)

```
async fn list_accessible_connectors_from_mcp_tools_with_options(
    config: &Config,
    force_refetch: bool,
) -> anyhow::Result<Vec<AppInfo>>
```

**Purpose**: Returns accessible connectors with one extra choice: whether to force a fresh MCP tool fetch. It is a convenience wrapper for callers that do not need readiness status.

**Data flow**: It receives configuration and a force-refresh flag. It calls the fuller status-returning function with the same options, then returns only the connector list from that status object.

**Call relations**: This sits between simple connector callers and the full discovery machinery. It keeps the public API small while reusing the central status-aware implementation.

*Call graph*: calls 1 internal fn (list_accessible_connectors_from_mcp_tools_with_options_and_status).


##### `list_accessible_connectors_from_mcp_tools_with_options_and_status`  (lines 181–201)

```
async fn list_accessible_connectors_from_mcp_tools_with_options_and_status(
    config: &Config,
    force_refetch: bool,
) -> anyhow::Result<AccessibleConnectorsStatus>
```

**Purpose**: Starts connector discovery and also reports whether the Codex Apps MCP server was ready. It is used when a caller needs to know both the connectors and whether discovery may still be warming up.

**Data flow**: It receives configuration and a force-refresh flag. It builds runtime paths for the local execution environment, creates an environment manager rooted in the Codex home directory, then passes that manager to the next discovery layer. The output is a status object containing connectors and a readiness flag.

**Call relations**: The simpler connector-list functions call this. Its main job is setup: it creates the temporary execution environment needed by MCP discovery, then hands the real work to the environment-manager version.

*Call graph*: calls 3 internal fn (list_accessible_connectors_from_mcp_tools_with_environment_manager, from_codex_home, from_optional_paths); called by 2 (list_accessible_connectors_from_mcp_tools, list_accessible_connectors_from_mcp_tools_with_options); 1 external calls (new).


##### `list_accessible_connectors_from_mcp_tools_with_environment_manager`  (lines 203–217)

```
async fn list_accessible_connectors_from_mcp_tools_with_environment_manager(
    config: &Config,
    force_refetch: bool,
    environment_manager: Arc<EnvironmentManager>,
) -> anyhow::Result<Accessi
```

**Purpose**: Runs connector discovery using an environment manager supplied by the caller. This avoids rebuilding execution-environment state when another part of the system already owns it.

**Data flow**: It receives configuration, a force-refresh flag, and a shared environment manager. It creates a plugin manager and an MCP manager, then calls the MCP-manager-based discovery function. The result is the same connector status object produced by the deeper discovery path.

**Call relations**: The status discovery wrapper calls this after creating an environment manager. This function prepares plugin and MCP management pieces, then passes all of them into the central MCP discovery routine.

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

**Purpose**: This is the main connector discovery routine. It checks login and feature gates, uses cached connector data when possible, starts the Codex Apps MCP server when needed, waits briefly for tools to appear, refreshes the cache, and returns connector records with plugin-source labels.

**Data flow**: It receives configuration, a force-refresh flag, an environment manager, and an MCP manager. It loads authentication, exits early if apps are not available, builds a cache key, reads MCP configuration, and returns cached data unless a refresh is required. If discovery is needed, it keeps only the Codex Apps MCP server, computes authentication status for it, starts an MCP connection manager, optionally hard-refreshes its tools, waits for readiness when appropriate, converts tool records into connector records, filters blocked connectors, writes useful results to the cache, adds plugin display names, shuts down the MCP manager, and returns connectors plus readiness.

**Call relations**: App-list responses and the environment-manager wrapper call this when real discovery is needed. It is the hub that calls cache helpers, MCP configuration helpers, auth-status helpers, tool conversion, plugin provenance enrichment, and final shutdown.

*Call graph*: calls 11 internal fn (new, new, filter_disallowed_connectors, accessible_connectors_cache_key, accessible_connectors_from_mcp_tools, read_cached_accessible_connectors, with_app_plugin_sources, write_cached_accessible_connectors, originator, shared_from_config (+1 more)); called by 2 (apps_list_response, list_accessible_connectors_from_mcp_tools_with_environment_manager); 11 external calls (new, new, auth_keyring_backend_kind, unbounded, default, codex_apps_tools_cache_key, compute_auth_statuses, effective_mcp_servers, host_owned_codex_apps_enabled, tool_plugin_provenance (+1 more)).


##### `accessible_connectors_cache_key`  (lines 370–383)

```
fn accessible_connectors_cache_key(
    config: &Config,
    auth: Option<&CodexAuth>,
) -> AccessibleConnectorsCacheKey
```

**Purpose**: Builds the identity used to decide whether cached connector data belongs to the current user and backend. This prevents one account’s connector list from being reused for another account.

**Data flow**: It receives configuration and optional authentication. It pulls out the ChatGPT base URL, account ID, ChatGPT user ID, and whether the account is a workspace account, then packages those values into a cache key.

**Call relations**: The cache-reading, cache-writing, and cache-refresh paths call this before touching cached connector data. It supplies the comparison value used by the cache reader.

*Call graph*: called by 3 (list_accessible_connectors_from_mcp_tools_with_mcp_manager, list_cached_accessible_connectors_from_mcp_tools, refresh_accessible_connectors_cache_from_mcp_tools).


##### `read_cached_accessible_connectors`  (lines 385–403)

```
fn read_cached_accessible_connectors(
    cache_key: &AccessibleConnectorsCacheKey,
) -> Option<Vec<AppInfo>>
```

**Purpose**: Reads the in-memory connector cache if it still applies. It avoids stale or wrong-account data by checking both expiration time and cache key.

**Data flow**: It receives the desired cache key. It locks the global cache, checks the current time, and returns a cloned connector list only if the entry has not expired and belongs to the same key. If the entry is expired, it clears it and returns nothing.

**Call relations**: The fast cached lookup and the main MCP discovery function call this before doing more expensive work. It does not know how connectors are discovered; it only decides whether the stored answer is safe to reuse.

*Call graph*: called by 2 (list_accessible_connectors_from_mcp_tools_with_mcp_manager, list_cached_accessible_connectors_from_mcp_tools); 1 external calls (now).


##### `write_cached_accessible_connectors`  (lines 405–417)

```
fn write_cached_accessible_connectors(
    cache_key: AccessibleConnectorsCacheKey,
    connectors: &[AppInfo],
)
```

**Purpose**: Stores accessible connectors in the shared short-lived cache. This makes later connector lookups faster.

**Data flow**: It receives a cache key and a slice of connector records. It locks the global cache, clones the connector list, sets a new expiration time using the connector cache time-to-live, and replaces any previous entry.

**Call relations**: The main discovery routine writes to this cache after successful or useful discovery, and refresh flows write to it after they already have MCP tools. The cache reader later serves those saved connector records.

*Call graph*: called by 2 (list_accessible_connectors_from_mcp_tools_with_mcp_manager, refresh_accessible_connectors_cache_from_mcp_tools); 2 external calls (now, to_vec).


##### `tool_suggest_connector_ids`  (lines 419–444)

```
fn tool_suggest_connector_ids(
    config: &Config,
    loaded_plugin_app_connector_ids: &[String],
) -> HashSet<String>
```

**Purpose**: Figures out which connector IDs are allowed to appear in tool suggestions. It combines IDs from loaded plugins with IDs explicitly listed in configuration, then removes IDs disabled by configuration.

**Data flow**: It receives configuration and connector IDs supplied by already-loaded plugins. It starts with the plugin IDs, adds configured discoverable connector IDs, collects configured disabled connector IDs, and removes disabled IDs from the set. The output is the final set of connector IDs eligible for suggestions.

**Call relations**: The tool-suggestion builder calls this before loading and filtering connector directory data. Its result guides which connector records are kept for suggestion.

*Call graph*: called by 1 (list_tool_suggest_discoverable_tools_with_auth).


##### `cached_directory_connectors_for_tool_suggest_with_auth`  (lines 447–484)

```
async fn cached_directory_connectors_for_tool_suggest_with_auth(
    config: &Config,
    auth: Option<&CodexAuth>,
) -> Vec<AppInfo>
```

**Purpose**: Loads cached connector-directory entries for tool suggestions, but only when Apps are enabled and the user has the right kind of authenticated Codex backend account. The directory cache is a saved catalog of known connectors.

**Data flow**: It receives configuration and optional authentication. If no auth was provided, it loads auth from the shared auth manager. It then checks that the auth uses the Codex backend and has a non-empty account ID. With those values, it builds a directory-cache context and reads cached directory connectors, returning an empty list if anything is unavailable or the cache read fails.

**Call relations**: The tool-suggestion builder calls this to get connector catalog data before merging plugin-provided connectors. This function supplies directory data but leaves filtering and merging to its caller.

*Call graph*: calls 3 internal fn (new, new, shared_from_config); called by 1 (list_tool_suggest_discoverable_tools_with_auth); 2 external calls (new, cached_directory_connectors).


##### `accessible_connectors_from_mcp_tools`  (lines 486–502)

```
fn accessible_connectors_from_mcp_tools(mcp_tools: &[ToolInfo]) -> Vec<AppInfo>
```

**Purpose**: Turns raw MCP tool records into app connector records. It looks only at tools from the Codex Apps MCP server and groups them by connector.

**Data flow**: It receives a list of MCP tool information. For each tool, it ignores tools from other MCP servers, skips tools without a connector ID, and keeps the connector ID, name, description, and plugin display names. It then asks the connector helper library to collect those tool-level entries into connector-level app records.

**Call relations**: Many flows call this after they already have MCP tools: initial context building, main connector discovery, cache refresh, skill/plugin building, and missing-connector refresh. It is the common translation step between MCP’s tool view and Codex’s app-connector view.

*Call graph*: calls 1 internal fn (collect_accessible_connectors); called by 5 (list_accessible_and_enabled_connectors_from_manager, list_accessible_connectors_from_mcp_tools_with_mcp_manager, refresh_accessible_connectors_cache_from_mcp_tools, build_skills_and_plugins, refresh_missing_requested_connectors); 1 external calls (iter).


##### `with_app_enabled_state`  (lines 504–528)

```
fn with_app_enabled_state(mut connectors: Vec<AppInfo>, config: &Config) -> Vec<AppInfo>
```

**Purpose**: Applies user and requirement configuration to connector records so each connector says whether it is enabled. This is where accessible apps can be turned off by policy or config.

**Data flow**: It receives connector records and configuration. It reads app settings from the layered config. User app settings can set each connector’s enabled state, including defaults. Requirements configuration can force a connector off. It returns the same connector list with updated enabled flags.

**Call relations**: App-listing, connector-listing, initial context, tool-building, skill/plugin building, and missing-connector refresh flows call this after connector discovery. It does not discover connectors; it annotates discovered connectors with the final enabled state.

*Call graph*: called by 6 (apps_list_response, list_connectors, list_accessible_and_enabled_connectors_from_manager, build_skills_and_plugins, built_tools, refresh_missing_requested_connectors); 2 external calls (app_is_enabled, apps_config_from_layer_stack).


##### `with_app_plugin_sources`  (lines 530–540)

```
fn with_app_plugin_sources(
    mut connectors: Vec<AppInfo>,
    tool_plugin_provenance: &ToolPluginProvenance,
) -> Vec<AppInfo>
```

**Purpose**: Adds plugin display names to connector records, showing which plugins contributed tools for each connector. This helps users understand where connector capabilities came from.

**Data flow**: It receives connector records and a plugin-provenance lookup. For each connector, it asks the provenance object for plugin display names tied to that connector ID and stores those names on the connector record. It returns the enriched list.

**Call relations**: The main MCP discovery function calls this after it has connector records and MCP plugin provenance. It is the final labeling step before the connector status is returned.

*Call graph*: calls 1 internal fn (plugin_display_names_for_connector_id); called by 1 (list_accessible_connectors_from_mcp_tools_with_mcp_manager).


##### `mcp_approvals_reviewer`  (lines 542–574)

```
fn mcp_approvals_reviewer(
    config: &Config,
    server_name: &str,
    connector_id: Option<&str>,
) -> ApprovalsReviewer
```

**Purpose**: Chooses who should review approval requests for an MCP tool call, especially for Codex Apps connectors. An approval reviewer is the authority or policy used when a tool needs permission before running.

**Data flow**: It receives configuration, an MCP server name, and an optional connector ID. For the Codex Apps MCP server, it looks for connector-specific reviewer settings, then app defaults. It only uses that app-level reviewer if requirements policy allows it. If not, or for non-app MCP servers, it falls back to the global reviewer from configuration.

**Call relations**: The MCP approval-review path uses this when deciding how to review elicitation or permission requests. It relies on app configuration from the layered config and is called from the guardian review flow; the call graph also records it as part of its own approval-review decision path.

*Call graph*: called by 2 (mcp_approvals_reviewer, review_guardian_mcp_elicitation); 1 external calls (apps_config_from_layer_stack).


### `core-plugins/src/discoverable.rs`

`domain_logic` · `tool suggestion request handling`

This file is like a shop window curator for plugins. The system may know about many plugins, but not all of them should be suggested to every user. Some are already installed, some are disabled, some are blocked by policy, and some are only useful when they match the user’s existing setup. Without this file, tool suggestions could show unavailable, duplicate, or inappropriate plugins.

The main work happens in `PluginsManager::list_tool_suggest_discoverable_plugins`. It first checks whether plugins are enabled at all. If not, it returns an empty list. Then it reads the configured marketplaces, including OpenAI-curated ones, and walks through their plugins. A plugin is considered only if it is not already installed, is allowed to be installed, is not disabled, and is either explicitly configured by the user or appears on a built-in fallback allowlist.

For matching marketplace plugins, it loads detailed plugin information and converts it into a small summary used by tool suggestions: id, name, description, whether it has skills, server names, and app connector ids.

If remote plugins are enabled, it also looks at cached remote plugin data. It avoids suggesting remote plugins that are already installed, blocked by admin policy, disabled, or unrelated to the user’s configured or already-connected apps. Finally, it sorts all suggestions by name, then id, so the output is stable and easy to display.

#### Function details

##### `PluginsManager::list_tool_suggest_discoverable_plugins`  (lines 70–200)

```
async fn list_tool_suggest_discoverable_plugins(
        &self,
        input: &ToolSuggestPluginDiscoveryInput,
        auth: Option<&CodexAuth>,
    ) -> anyhow::Result<Vec<ToolSuggestDiscoverablePl
```

**Purpose**: Builds the list of plugins that can be suggested to the user as useful tools but are not already installed. It protects the user experience by removing plugins that are disabled, blocked, already present, or not relevant enough to suggest.

**Data flow**: It receives the current plugin configuration, sets of configured plugin ids, disabled plugin ids, already loaded app connector ids, and optional login/authentication information. It first returns an empty list if plugins are turned off. Otherwise it reads available marketplaces, filters each plugin against installation status, policy, disabled status, user configuration, and the fallback allowlist, then loads details for the ones that pass. If remote plugins are enabled, it also checks cached remote plugin suggestions against installed remote ids, installed app connectors, admin availability, and install policy. The result is a sorted list of `ToolSuggestDiscoverablePlugin` records ready for the suggestion UI or caller to use.

**Call relations**: This is the central flow in the file. While scanning plugins, it calls `is_tool_suggest_fallback_plugin` to decide whether a plugin is important enough to suggest even if the user did not explicitly configure it. When loading a marketplace plugin fails, it logs a warning and keeps going, so one bad plugin does not prevent other suggestions from appearing. It also relies on other `PluginsManager` abilities elsewhere in the codebase to list marketplaces, read plugin details, inspect installed plugins, and read cached remote suggestions.

*Call graph*: calls 1 internal fn (is_tool_suggest_fallback_plugin); 3 external calls (new, new, warn!).


##### `is_tool_suggest_fallback_plugin`  (lines 203–220)

```
fn is_tool_suggest_fallback_plugin(plugin_id: &str) -> bool
```

**Purpose**: Checks whether a plugin id belongs to the built-in list of plugins that are safe and useful enough to suggest by default. This lets common plugins like GitHub, Slack, Gmail, and bundled tools appear as suggestions even when they were not explicitly configured.

**Data flow**: It takes a plugin id as text. First it checks whether that exact id is in the allowlist. If not, it tries to parse the id into its plugin name and marketplace name. For plugins from the OpenAI API curated marketplace, it translates the id into the matching default curated marketplace form and checks the allowlist again. It returns `true` when the plugin is allowed as a fallback suggestion, and `false` otherwise.

**Call relations**: This helper is called by `PluginsManager::list_tool_suggest_discoverable_plugins` whenever that larger function needs to decide whether an unconfigured plugin can still be suggested. It uses plugin id parsing to understand marketplace-specific names, and string formatting to compare API-curated plugin ids with their normal curated equivalents.

*Call graph*: calls 1 internal fn (parse); called by 1 (list_tool_suggest_discoverable_plugins); 1 external calls (format!).


### `core/src/plugins/discoverable.rs`

`orchestration` · `tool suggestion discovery`

When the system wants to suggest useful tools, it needs to know which plugins are available, which ones the user already configured, which ones are disabled, and which plugin-backed app connectors are already loaded. This file prepares that checklist and asks the plugin manager for the actual discoverable plugins.

Think of it like making a shopping list before asking a store clerk what is on the shelves. The configuration says what the user wants or does not want. The loaded connector list says what is already present. Authentication, if available, lets the plugin manager include plugins that may depend on the signed-in user. This file packages all of that into a discovery request.

After the plugin manager replies, this file converts the returned plugin records into `DiscoverablePluginInfo`, a simpler shape used by the tools layer. That result includes details such as the plugin’s id, name, description, whether it has skills, related MCP server names, and app connector ids. MCP means “Model Context Protocol,” a way for tools and services to expose capabilities to the model.

Without this file, tool suggestion would either miss important user settings or expose plugins in the wrong form to the rest of the core.

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

**Purpose**: This function asks the plugin system which plugins should be discoverable for tool suggestions. It combines user configuration, disabled plugin choices, already loaded app connectors, and optional login information into one request.

**Data flow**: It receives the current configuration, the plugin manager, optional authentication, and a list of already loaded plugin app connector ids. It reads the plugin-related settings from the configuration, turns relevant lists into sets so ids can be compared cleanly, and builds a discovery input. It sends that input to the plugin manager, waits for the answer, then reshapes each returned plugin into `DiscoverablePluginInfo` and returns the collected list. If the plugin manager reports an error, that error is passed back instead.

**Call relations**: This function sits between higher-level tool suggestion code and the plugin manager. When something needs the list of suggestible plugins, it calls this function; the function pulls plugin configuration through `plugins_config_input`, delegates discovery to the plugin manager’s `list_tool_suggest_discoverable_plugins`, and then hands back tool-layer-friendly plugin descriptions.

*Call graph*: 2 external calls (plugins_config_input, list_tool_suggest_discoverable_plugins).


### `core/src/plugins/mentions.rs`

`domain_logic` · `request handling`

This file is about understanding when a user has deliberately pointed at a tool or plugin. A user can do that in two ways: by sending a structured mention, or by typing a special text mention using a marker character, also called a sigil. Think of it like recognizing tagged people in a chat message: the system needs to notice the tag, figure out who it refers to, and ignore ordinary text.

The file first provides a small container, `CollectedToolMentions`, that separates mentions into simple names and full paths. It then offers helper functions that scan text messages for these mentions. App mentions and plugin mentions are treated slightly differently because plugin text links use `@`, while the default tool mention marker is different.

The higher-level functions combine two sources of evidence: structured `UserInput::Mention` items and mentions embedded inside plain text. They then filter those paths to only the right kind of target, such as apps or plugins, and extract the useful identifier from the path. For plugins, the file also compares the mentioned plugin names against the list of known plugin capability summaries and returns only the plugins the user explicitly named.

Finally, it can count connector mention slugs. A slug is a short, mention-friendly name. Counting them helps other code detect duplicates and avoid ambiguous names.

#### Function details

##### `collect_tool_mentions_from_messages`  (lines 23–25)

```
fn collect_tool_mentions_from_messages(messages: &[String]) -> CollectedToolMentions
```

**Purpose**: Scans a list of text messages for normal tool mentions using the standard tool mention marker. This is the common entry point when other code wants to know what tools were named in user text.

**Data flow**: It receives a list of message strings. It passes those messages to the more general scanner with the default tool sigil, then returns a `CollectedToolMentions` value containing the plain names and path-style mentions it found.

**Call relations**: This is a convenience wrapper around `collect_tool_mentions_from_messages_with_sigil`. It is used by `collect_explicit_app_ids` when app mentions may be typed in user text, and also by `collect_explicit_app_ids_from_skill_items` for the same kind of mention gathering in skill-related input.

*Call graph*: calls 1 internal fn (collect_tool_mentions_from_messages_with_sigil); called by 2 (collect_explicit_app_ids, collect_explicit_app_ids_from_skill_items).


##### `collect_tool_mentions_from_messages_with_sigil`  (lines 27–39)

```
fn collect_tool_mentions_from_messages_with_sigil(
    messages: &[String],
    sigil: char,
) -> CollectedToolMentions
```

**Purpose**: Scans text messages for mentions that use a specific marker character. This lets the same mention-finding logic work for different syntaxes, such as the normal tool marker and the plugin text marker.

**Data flow**: It receives message strings and a sigil character. For each message, it asks `extract_tool_mentions_with_sigil` to find matching mentions, then adds all discovered plain names and paths into two sets so duplicates are removed. It returns those two sets together as `CollectedToolMentions`.

**Call relations**: This is the shared worker used by `collect_tool_mentions_from_messages` for ordinary tool mentions and by `collect_explicit_plugin_mentions` for plugin text links. It hands the actual text parsing to `extract_tool_mentions_with_sigil`, then packages the results for the higher-level functions.

*Call graph*: calls 1 internal fn (extract_tool_mentions_with_sigil); called by 2 (collect_explicit_plugin_mentions, collect_tool_mentions_from_messages); 1 external calls (new).


##### `collect_explicit_app_ids`  (lines 41–60)

```
fn collect_explicit_app_ids(input: &[UserInput]) -> HashSet<String>
```

**Purpose**: Finds app IDs that the user explicitly mentioned. It matters because the system should only activate or consider specific apps when the user has actually pointed to them.

**Data flow**: It receives a list of `UserInput` items, which may include text or structured mentions. It pulls out text messages, scans them for tool paths, also reads structured mention paths, keeps only paths that are app mentions, converts those paths into app IDs, and returns the IDs as a set with duplicates removed.

**Call relations**: This function is called by `build_skills_and_plugins` while deciding what app-related capabilities are relevant to the current user input. It relies on `collect_tool_mentions_from_messages` to catch mentions typed inside plain text, then uses path helper functions to keep only app mentions and extract their app IDs.

*Call graph*: calls 1 internal fn (collect_tool_mentions_from_messages); called by 1 (build_skills_and_plugins); 1 external calls (iter).


##### `collect_explicit_plugin_mentions`  (lines 63–103)

```
fn collect_explicit_plugin_mentions(
    input: &[UserInput],
    plugins: &[PluginCapabilitySummary],
) -> Vec<PluginCapabilitySummary>
```

**Purpose**: Finds plugins that the user explicitly mentioned and returns their known capability summaries. This connects a user’s mention, such as a `plugin://...` link, to the actual plugin information the system already has.

**Data flow**: It receives user input and a list of available plugins. If there are no plugins, it returns an empty list. Otherwise, it gathers text messages and structured mention paths, scans text using the plugin mention marker, keeps only plugin paths, extracts plugin config names, and then returns the plugins whose config names were mentioned.

**Call relations**: This function is called by `build_skills_and_plugins` when the system is choosing which plugins to include for a turn. It uses `collect_tool_mentions_from_messages_with_sigil` because plugin text links use a different marker from normal tools, then matches the extracted names against the provided plugin summaries.

*Call graph*: calls 1 internal fn (collect_tool_mentions_from_messages_with_sigil); called by 1 (build_skills_and_plugins); 4 external calls (new, iter, is_empty, iter).


##### `build_connector_slug_counts`  (lines 107–116)

```
fn build_connector_slug_counts(
    connectors: &[connectors::AppInfo],
) -> HashMap<String, usize>
```

**Purpose**: Counts how many connectors share each mention slug, or short mention name. This helps later code know whether a connector name is unique or could be ambiguous.

**Data flow**: It receives a list of connector app records. For each connector, it computes the connector’s mention slug, increments that slug’s count in a map, and returns the completed slug-to-count table.

**Call relations**: This function is called by `build_skills_and_plugins` and `collect_explicit_app_ids_from_skill_items` when they need background knowledge about connector mention names. It delegates slug creation to `connector_mention_slug`, then supplies the count map to callers that need to reason about repeated or conflicting connector names.

*Call graph*: calls 1 internal fn (connector_mention_slug); called by 2 (build_skills_and_plugins, collect_explicit_app_ids_from_skill_items); 1 external calls (new).


### `core/src/plugins/mod.rs`

`orchestration` · `cross-cutting`

This file does not contain the plugin logic itself. Instead, it works like a reception desk for the plugin subsystem: it points to the rooms where the real work happens, and it makes a selected set of names available to the rest of the core code.

The plugin subsystem appears to cover several jobs. One part finds plugins that can be suggested or discovered. Another builds plugin “injections,” meaning extra plugin-provided instructions or context that can be added into a model request. Another renders explicit plugin instructions, turning plugin information into text the model can read. The mentions module looks through messages for plugin, skill, connector, app, or tool references, and also counts names or slugs so the system can understand what the user explicitly asked for.

By re-exporting these pieces here, the rest of the project can import plugin features from one clear place instead of knowing the internal file layout. That matters because it keeps plugin code easier to reorganize later. If this file were missing, callers would either fail to compile or would need to reach into individual submodules directly, making the plugin subsystem more tangled and harder to maintain.

It also exposes test support only during tests, so helper code for testing does not become part of normal builds.


### Install suggestion tools
These files define the model-facing tool specs and request payloads for listing installable plugins/connectors and prompting the user to install them, then orchestrate the runtime install-suggestion flow.

### `core/src/tools/handlers/list_available_plugins_to_install_spec.rs`

`config` · `tool setup`

This file is like the label and instructions on a special tool in a toolbox. The tool’s job is to list plugins or connectors that could be installed when a user asks for something that is not currently available.

The main function builds a `ToolSpec`, which is the system’s description of a callable tool. That description includes the tool’s name, a human-readable explanation, whether the input rules are strict, and the expected input shape. In this case, the tool takes no meaningful input: its parameters are an empty JSON object. JSON is a common text format for structured data, and a JSON schema is a rulebook describing what that data should look like.

The description text is important. It tells the model not to call this tool casually. It should only be used when the user explicitly asks for a missing plugin or connector, and only after normal tool search is unavailable or failed. It also gives a preference rule: use a plugin over a connector when both match, unless the related plugin is already installed.

The test locks down the exact “wire shape,” meaning the exact data that will be sent across the API boundary. That matters because even small name, schema, or wording changes could affect how the model decides to call the tool.

#### Function details

##### `create_list_available_plugins_to_install_tool`  (lines 7–20)

```
fn create_list_available_plugins_to_install_tool() -> ToolSpec
```

**Purpose**: Builds the specification for the tool that lists installable plugins and connectors. Other parts of the system use this specification to expose the tool with the right name, instructions, and input format.

**Data flow**: It starts with fixed tool-name constants and builds a plain-language description string that mentions related tools by name. It then creates a tool definition with no required input fields, no output schema, and relaxed input strictness. The result is a `ToolSpec` value that can be registered with the broader tool system.

**Call relations**: This function is called by the surrounding tool specification setup, represented here as `spec`. While building the tool definition, it uses helpers to create an empty JSON schema and wraps the finished API-facing tool description as a function-style tool.

*Call graph*: calls 1 internal fn (object); called by 1 (spec); 4 external calls (default, new, format!, Function).


##### `tests::create_list_available_plugins_to_install_tool_uses_expected_wire_shape`  (lines 28–44)

```
fn create_list_available_plugins_to_install_tool_uses_expected_wire_shape()
```

**Purpose**: Checks that the generated tool specification exactly matches the expected API-facing form. This protects the tool name, description, and parameter schema from accidental changes.

**Data flow**: The test calls `create_list_available_plugins_to_install_tool`, compares its returned value with a manually written expected value, and fails if any field differs. It does not change runtime behavior; it only verifies the contract during testing.

**Call relations**: This test exercises the main specification-building function directly. It uses an equality assertion to confirm that callers of the tool setup will receive the exact tool definition the API expects.

*Call graph*: 1 external calls (assert_eq!).


### `core/src/tools/handlers/list_available_plugins_to_install.rs`

`domain_logic` · `request handling`

This file is like a catalog clerk for installable plugins. The rest of the system may know about many plugin candidates, each with an id, name, description, and connection details. This handler turns that internal list into the official response for the `list_available_plugins_to_install` tool.

When the handler is created, it sorts the plugins by name, then by id. That makes the output stable and easier to read. When asked for a result, it copies the plugin entries into a response object, but shortens long descriptions to a fixed character limit. It does this carefully at a real character boundary, so it will not cut a multi-byte character in half and create invalid text.

The handler also tells the tool system its public tool name, its tool specification, and whether calls can run in parallel. Parallel calls are disabled here, likely because this is a simple catalog-style utility where duplicate simultaneous calls do not add value. During an actual tool call, it checks that the incoming request is the expected function-style payload, serializes the plugin list to JSON text, and wraps that text as a tool output. The tests confirm the two important promises: no parallel calls, and long descriptions are trimmed while the list is sorted.

#### Function details

##### `ListAvailablePluginsToInstallHandler::new`  (lines 23–30)

```
fn new(mut tools: Vec<RequestPluginInstallEntry>) -> Self
```

**Purpose**: Creates a new plugin-list handler from a set of installable plugin entries. It sorts the entries first, so later responses come out in a predictable order.

**Data flow**: It receives a list of plugin entries. It rearranges that list by plugin name, using the id as a tie-breaker when names match. It then stores the sorted list inside a new `ListAvailablePluginsToInstallHandler`.

**Call relations**: The core tool registry setup calls this when adding built-in utility tools, giving the handler the current plugin candidates. The test for description truncation also calls it to build a small example handler before checking the produced result.

*Call graph*: called by 2 (result_truncates_candidate_descriptions, add_core_utility_tools).


##### `ListAvailablePluginsToInstallHandler::result`  (lines 32–54)

```
fn result(&self) -> ListAvailablePluginsToInstallResult
```

**Purpose**: Builds the response object that will be returned to whoever asked for available plugins. It preserves the important plugin details while shortening long descriptions.

**Data flow**: It reads the handler's stored plugin list. For each plugin, it copies the id, name, type, skill flag, MCP server names, and app connector ids. If there is a description, it trims it to the maximum allowed number of characters using `truncate_to_char_boundary`. It returns a `ListAvailablePluginsToInstallResult` containing the cleaned list.

**Call relations**: The actual tool-call path uses this inside `ListAvailablePluginsToInstallHandler::handle_call` just before turning the result into JSON text. It is the main bridge between the stored catalog and the public tool response.

*Call graph*: called by 1 (handle_call).


##### `ListAvailablePluginsToInstallHandler::tool_name`  (lines 58–60)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Reports the public name of this tool to the tool registry. This lets the system match an incoming `list_available_plugins_to_install` request to this handler.

**Data flow**: It reads the shared constant for the tool name and wraps it as a plain `ToolName`. It returns that value without changing any stored state.

**Call relations**: The tool system calls this when registering or looking up executors. It delegates the small formatting step to `ToolName::plain`, so the name is represented in the standard form used by the rest of the tool framework.

*Call graph*: calls 1 internal fn (plain).


##### `ListAvailablePluginsToInstallHandler::spec`  (lines 62–64)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Provides the formal description of this tool: what it is called and how it should be invoked. The tool system uses this specification when advertising available tools.

**Data flow**: It takes no outside data beyond the handler itself. It calls `create_list_available_plugins_to_install_tool` and returns the resulting `ToolSpec`.

**Call relations**: The tool registry or tool-advertising layer calls this when it needs to describe available tools to the model. This function hands off to the separate spec-building file so this handler does not duplicate the schema details.

*Call graph*: calls 1 internal fn (create_list_available_plugins_to_install_tool).


##### `ListAvailablePluginsToInstallHandler::supports_parallel_tool_calls`  (lines 66–68)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Says that this tool should not be run in parallel with other calls of the same kind. This keeps execution simple and predictable for this catalog-style request.

**Data flow**: It receives no meaningful input and reads no stored data. It always returns `false`.

**Call relations**: The tool execution framework checks this before deciding whether it may run calls concurrently. The included test `tests::list_tool_does_not_support_parallel_calls` locks in this behavior.


##### `ListAvailablePluginsToInstallHandler::handle`  (lines 70–72)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts processing an incoming tool invocation. It adapts the handler's async work into the future-based shape expected by the tool framework.

**Data flow**: It receives a `ToolInvocation`, which represents one requested tool call. It passes that invocation to `handle_call`, pins the async work so it can be safely polled by the runtime, and returns it as a tool-executor future.

**Call relations**: The tool framework calls this when the model invokes the tool. This function is a small adapter: it does not build the response itself, but hands the real work to `ListAvailablePluginsToInstallHandler::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ListAvailablePluginsToInstallHandler::handle_call`  (lines 76–100)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Performs the actual response work for a tool call. It checks that the request has the expected shape, builds the plugin list response, serializes it as JSON, and wraps it as tool output.

**Data flow**: It receives a `ToolInvocation` and looks at its payload. If the payload is not a function-call payload, it returns a fatal error. If it is valid, it calls `result` to build the plugin list, converts that result to a JSON string, wraps the string in a `FunctionToolOutput`, and returns it boxed as a general tool output. If JSON serialization fails, it returns a fatal error explaining the failure.

**Call relations**: `ListAvailablePluginsToInstallHandler::handle` calls this for each real invocation. Inside, it relies on `result` for the catalog contents, `serde_json::to_string` for JSON conversion, `FunctionToolOutput::from_text` for text output creation, and `boxed_tool_output` to fit the shared tool-output interface.

*Call graph*: calls 3 internal fn (from_text, boxed_tool_output, result); called by 1 (handle); 3 external calls (format!, to_string, Fatal).


##### `truncate_to_char_boundary`  (lines 105–110)

```
fn truncate_to_char_boundary(value: &str, max_chars: usize) -> &str
```

**Purpose**: Shortens a string to at most a given number of characters without breaking a character in the middle. This matters for non-English text and emoji, where one visible character can take multiple bytes.

**Data flow**: It receives a string slice and a maximum character count. It finds the byte position where the next character after that limit begins. If such a position exists, it returns the part of the string before that point; otherwise, it returns the original string unchanged.

**Call relations**: `ListAvailablePluginsToInstallHandler::result` uses this when copying plugin descriptions into the public response. It keeps the response compact while ensuring the resulting text is still valid.


##### `tests::list_tool_does_not_support_parallel_calls`  (lines 119–123)

```
fn list_tool_does_not_support_parallel_calls()
```

**Purpose**: Checks that the handler reports parallel tool calls as unsupported. This protects an intentional execution rule from being changed accidentally.

**Data flow**: It creates an empty handler and asks `supports_parallel_tool_calls` for its answer. The test passes only if the answer is `false`.

**Call relations**: This test exercises the same method the tool framework would consult before scheduling calls. It acts as a small guardrail around the handler's concurrency behavior.

*Call graph*: 1 external calls (assert!).


##### `tests::result_truncates_candidate_descriptions`  (lines 126–177)

```
fn result_truncates_candidate_descriptions()
```

**Purpose**: Checks that the result is sorted and that overly long plugin descriptions are shortened to the configured limit. It also confirms that other plugin details are preserved.

**Data flow**: It builds two sample plugin entries, one with a description one character too long and one with a short description. It creates a handler with those entries, asks for the result, and compares the result with the exact expected list: sorted by name, with the long description trimmed and all other fields copied correctly.

**Call relations**: This test calls `ListAvailablePluginsToInstallHandler::new`, which sorts the input list, and then indirectly verifies the behavior of `ListAvailablePluginsToInstallHandler::result`. It is the safety net for the user-facing shape of the plugin catalog response.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, vec!).


### `core/src/tools/handlers/request_plugin_install_spec.rs`

`config` · `tool registration`

This file is like a carefully written order form for requesting a plugin or connector install. It does not install anything itself. Instead, it tells the larger tool system what information must be provided, what the tool is called, and when it is safe to use.

The main function builds a `ToolSpec`, which is a description of a tool the model can call. The tool requires four pieces of information: whether the item is a plugin or connector, the action to suggest, the exact tool ID, and a short user-facing reason. These fields are described using JSON Schema, which is a standard way to say, “this input must have these named fields, and each field must be this kind of value.”

The wording in the tool description is important. It tells the model not to recommend vaguely useful tools. It may only request installation after another tool, `list_available_plugins_to_install`, has returned an exact match for what the user explicitly asked for. It also warns not to call this install-request tool in parallel with other tools, which helps avoid confusing or conflicting user prompts.

The test at the bottom protects this contract. If someone changes the tool name, required fields, descriptions, or schema shape, the test will catch it.

#### Function details

##### `create_request_plugin_install_tool`  (lines 8–55)

```
fn create_request_plugin_install_tool() -> ToolSpec
```

**Purpose**: Builds the full specification for the `request_plugin_install` tool. Other parts of the system use this specification to know how the tool should be presented to the model and what input it must receive.

**Data flow**: It starts with the names and descriptions of the required input fields. It turns those into a JSON Schema object, adds the human-readable tool instructions, and wraps everything into a `ToolSpec::Function`. The result is a complete tool definition with a name, description, input rules, and no output schema.

**Call relations**: This function is called by `spec` when the system is collecting available tool definitions. It relies on helper constructors such as `JsonSchema::string` and `JsonSchema::object` to describe the expected input, then hands back a finished `ToolSpec` for the larger tool registry to use.

*Call graph*: calls 2 internal fn (object, string); called by 1 (spec); 4 external calls (from, format!, Function, vec!).


##### `tests::create_request_plugin_install_tool_uses_expected_wire_shape`  (lines 65–118)

```
fn create_request_plugin_install_tool_uses_expected_wire_shape()
```

**Purpose**: Checks that `create_request_plugin_install_tool` produces exactly the tool definition expected by the rest of the system. This matters because external tool calling depends on names, field names, and schema details staying stable.

**Data flow**: It builds the expected description text and expected `ToolSpec` by hand. Then it calls `create_request_plugin_install_tool` and compares the actual result with the expected one. If any part differs, the test fails.

**Call relations**: This test runs during the test suite, not during normal use. It directly exercises `create_request_plugin_install_tool` and uses assertion helpers to make sure the tool’s public wire shape, meaning the exact data sent to the tool-calling layer, has not accidentally changed.

*Call graph*: 2 external calls (assert_eq!, concat!).


### `tools/src/request_plugin_install.rs`

`domain_logic` · `request handling`

This file is about a careful handoff between the assistant and the user when the system wants to suggest a plugin or connector. A plugin or connector can give the assistant extra abilities, so the system should not silently add one. Instead, it creates an “elicitation request,” meaning a structured prompt that asks the user for approval.

The main request includes the visible message explaining why the tool is being suggested, plus hidden structured details such as the tool type, action type, tool ID, tool name, install URL, and related connector IDs. Think of it like a permission slip: the user sees the reason, while the application also receives the exact fields it needs to show the right install flow and remember the choice.

The file also defines the input and output shapes for this tool suggestion flow. `RequestPluginInstallArgs` describes what was requested. `RequestPluginInstallResult` describes what happened afterward. `RequestPluginInstallMeta` carries extra context alongside the approval request.

Finally, after installation, the file can verify whether requested connectors are now accessible. That matters because a plugin may depend on one or more app connectors; approval is not enough unless those connectors are actually available to use.

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

**Purpose**: Builds the structured approval request that will be sent to the user when the system wants to suggest installing or enabling a tool. It packages the user-facing reason together with machine-readable details about the tool.

**Data flow**: It receives the server name, conversation thread ID, turn ID, the requested tool action, the reason for the suggestion, and the discovered tool itself. It turns the reason into the message the user will see, builds metadata describing the suggested tool, and wraps everything into a form-style request. The result is an `McpServerElicitationRequestParams` value ready to be sent through the app-server protocol.

**Call relations**: This is the main builder for the approval prompt. While creating the request, it asks `build_request_plugin_install_meta` to prepare the extra tool details, then embeds those details as JSON so the receiving app can understand exactly what is being suggested.

*Call graph*: 2 external calls (new, json!).


##### `all_requested_connectors_picked_up`  (lines 88–95)

```
fn all_requested_connectors_picked_up(
    expected_connector_ids: &[String],
    accessible_connectors: &[AppInfo],
) -> bool
```

**Purpose**: Checks whether every connector the plugin expected is now present and usable. This is useful after an install flow, because the system needs to know whether the required connected apps are actually ready.

**Data flow**: It receives a list of expected connector IDs and a list of connectors the user can currently access. For each expected ID, it checks whether that connector appears in the accessible list and is marked accessible. It returns `true` only if every expected connector passes that check; otherwise it returns `false`.

**Call relations**: This function is the group-level check in the flow after a plugin or connector install. It relies on the single-connector check performed by `verified_connector_install_completed`, repeating that check for each expected connector ID.


##### `verified_connector_install_completed`  (lines 97–105)

```
fn verified_connector_install_completed(
    tool_id: &str,
    accessible_connectors: &[AppInfo],
) -> bool
```

**Purpose**: Checks one connector ID to see whether that connector has been installed or connected successfully and is usable. It answers the simple question: “Can the system access this connector now?”

**Data flow**: It receives one tool or connector ID and the current list of accessible app records. It searches the list for a connector with the same ID. If it finds one, it looks at whether that connector is marked accessible. It returns `true` only when both the ID matches and accessibility is confirmed.

**Call relations**: This is the small, focused check used when confirming installation results. `all_requested_connectors_picked_up` uses this logic repeatedly when a plugin needs several connectors to be ready.

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

**Purpose**: Creates the hidden metadata that travels with the user approval request. This metadata tells the app what kind of suggestion it is, what tool is involved, and where or how that tool can be installed.

**Data flow**: It receives the tool type, action type, suggestion reason, and discovered tool. It looks at whether the tool is a connector or a plugin. For plugins, it includes plugin-specific details such as the remote plugin ID and related app connector IDs. It also reads the tool’s ID, name, and install URL. The output is a `RequestPluginInstallMeta` structure ready to be serialized into the request.

**Call relations**: This helper supports `build_request_plugin_install_elicitation_request`. The larger request builder uses it to keep the approval form compact while still attaching all the exact tool details the client application needs.

*Call graph*: calls 3 internal fn (id, install_url, name).


### `core/src/tools/handlers/request_plugin_install.rs`

`domain_logic` · `request handling`

This file is the “front desk” for plugin and connector install suggestions. When the model thinks a missing tool would help, it calls this handler instead of installing anything directly. The handler checks that the request is valid, finds the matching tool from the known list, and sends an elicitation request, which is a structured prompt asking the user what they want to do. If the user declines and chooses “don’t suggest this again,” the file writes that preference into the user’s config so future runs can respect it.

If the user accepts, the handler does not blindly trust that the install worked. For connectors, it refreshes the app tool list and checks whether the requested connector now appears. For plugins, it reloads config and asks the plugin manager whether the plugin is installed. Remote marketplace plugin suggestions are treated as completed once accepted, because the install happens outside the local plugin list. The final answer is returned as JSON so the model can see whether the user confirmed, whether completion was verified, and which tool was involved.

Without this file, install suggestions would either be unsafe, because they could skip user consent, or unreliable, because the assistant would not know whether the requested plugin or connector was really available afterward.

#### Function details

##### `RequestPluginInstallHandler::new`  (lines 46–48)

```
fn new(discoverable_tools: Vec<DiscoverableTool>) -> Self
```

**Purpose**: Creates a new install-request handler with the list of tools that may be suggested to the user. This gives the handler its menu of valid plugins and connectors.

**Data flow**: A list of discoverable tools goes in. The function stores that list inside a new RequestPluginInstallHandler. The result is a handler ready to be registered with the tool system.

**Call relations**: During tool setup, add_core_utility_tools calls this to build the handler. Later, the registered handler uses the saved tool list when the model asks to suggest an install.

*Call graph*: called by 1 (add_core_utility_tools).


##### `RequestPluginInstallHandler::tool_name`  (lines 52–54)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the public name of this tool, so the tool registry and the model can refer to it consistently.

**Data flow**: No outside data is needed beyond the fixed tool-name constant. The function wraps that name as a ToolName and returns it.

**Call relations**: The tool registry asks the handler for its name when wiring tools together. This function uses plain to make the standard, simple form of the name.

*Call graph*: calls 1 internal fn (plain).


##### `RequestPluginInstallHandler::spec`  (lines 56–58)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the formal description of this tool: what arguments it accepts and what it is meant to do. This is the instruction sheet shown to the model.

**Data flow**: No request-specific data goes in. The function calls create_request_plugin_install_tool and returns the resulting ToolSpec.

**Call relations**: The registry asks for this specification when exposing the tool. The work is handed off to create_request_plugin_install_tool, which builds the schema for the request-plugin-install tool.

*Call graph*: calls 1 internal fn (create_request_plugin_install_tool).


##### `RequestPluginInstallHandler::supports_parallel_tool_calls`  (lines 60–62)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Says that this handler can be called in parallel with other tool calls. In plain terms, it does not require exclusive use of the whole tool system.

**Data flow**: Nothing goes in. The function simply returns true.

**Call relations**: The tool runtime checks this when deciding whether multiple tool calls can run at the same time. This handler opts in to that behavior.


##### `RequestPluginInstallHandler::handle`  (lines 64–66)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts the asynchronous work for a request-plugin-install tool call. It packages the real work into a future, which is Rust’s way of representing work that will finish later.

**Data flow**: A ToolInvocation goes in, containing the call arguments, session, turn information, and call id. The function passes that invocation to handle_call and returns a pinned future for the runtime to await.

**Call relations**: The tool runtime calls handle when the model invokes this tool. handle immediately hands the detailed processing to handle_call.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `RequestPluginInstallHandler::handle_call`  (lines 70–199)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Carries out the full install-suggestion flow: validate the model’s request, ask the user, optionally save a “don’t ask again” preference, verify completion, record telemetry, and return a JSON result.

**Data flow**: A ToolInvocation goes in. The function reads the function-call arguments, the current session, the current turn, and the call id. It parses and checks the arguments, filters the available tools for this client, finds the requested tool, sends a user confirmation request, and reads the user’s response. If the user accepted, it checks whether the plugin or connector became available. It then serializes a result with fields such as completed, user_confirmed, tool_id, and suggest_reason, and returns that as tool output. It may also update disabled-suggestion config, reload user config, merge a newly available connector into the session selection, and record telemetry.

**Call relations**: handle calls this as the main body of the tool. It uses parse_arguments to understand the model’s JSON, build_request_plugin_install_elicitation_request to prepare the user prompt, maybe_persist_disabled_install_request when the user asks not to see the suggestion again, and verify_request_plugin_install_completed after acceptance. At the end it uses from_text and boxed_tool_output to hand a text result back to the tool runtime.

*Call graph*: calls 5 internal fn (from_text, boxed_tool_output, parse_arguments, maybe_persist_disabled_install_request, verify_request_plugin_install_completed); called by 1 (handle); 8 external calls (from, String, build_request_plugin_install_elicitation_request, filter_request_plugin_install_discoverable_tools_for_client, format!, to_string, Fatal, RespondToModel).


##### `maybe_persist_disabled_install_request`  (lines 204–224)

```
async fn maybe_persist_disabled_install_request(
    session: &crate::session::session::Session,
    turn: &crate::session::turn_context::TurnContext,
    tool: &DiscoverableTool,
    response: &Elici
```

**Purpose**: Saves the user’s choice to stop seeing this install suggestion, but only when the response clearly asks for that. This is how a one-time decline can become a lasting preference.

**Data flow**: The current session, turn, suggested tool, and user response go in. The function checks whether the response means “decline and always disable this suggestion.” If not, it does nothing. If yes, it writes the disabled-suggestion entry to config and then reloads the user config layer. If writing fails, it logs a warning and leaves the running session unchanged.

**Call relations**: handle_call calls this after an elicitation response arrives. This function first asks request_plugin_install_response_requests_persistent_disable whether persistence was requested, then uses persist_disabled_install_request to write the config edit, and finally calls reload_user_config_layer so the session can see the updated setting.

*Call graph*: calls 2 internal fn (persist_disabled_install_request, request_plugin_install_response_requests_persistent_disable); called by 1 (handle_call); 2 external calls (reload_user_config_layer, warn!).


##### `request_plugin_install_response_requests_persistent_disable`  (lines 226–240)

```
fn request_plugin_install_response_requests_persistent_disable(
    response: &ElicitationResponse,
) -> bool
```

**Purpose**: Decides whether a user response means “I declined, and please remember not to suggest this again.” It looks for a specific marker in the response metadata.

**Data flow**: An ElicitationResponse goes in. The function first checks that the action was Decline. Then it looks inside the response metadata for the configured persistence key and checks whether its value is the configured “always” value. It returns true only when both conditions are met.

**Call relations**: maybe_persist_disabled_install_request calls this before doing any disk-writing work. It acts like a gatekeeper, preventing ordinary declines from being saved as permanent preferences.

*Call graph*: called by 1 (maybe_persist_disabled_install_request).


##### `persist_disabled_install_request`  (lines 242–252)

```
async fn persist_disabled_install_request(
    codex_home: &codex_utils_absolute_path::AbsolutePathBuf,
    tool: &DiscoverableTool,
) -> anyhow::Result<()>
```

**Purpose**: Writes a disabled-suggestion entry into the user’s configuration. This is the durable record that a certain plugin or connector should no longer be suggested for install.

**Data flow**: The Codex home path and the tool to disable go in. The function builds a config edit that adds the matching disabled tool entry, applies that edit to disk, and returns success or an error.

**Call relations**: maybe_persist_disabled_install_request calls this when the user has chosen to persistently disable a suggestion. This function uses disabled_install_request to turn the tool into the correct config value, then uses ConfigEditsBuilder to apply the edit.

*Call graph*: calls 2 internal fn (new, disabled_install_request); called by 1 (maybe_persist_disabled_install_request); 1 external calls (AddToolSuggestDisabledTool).


##### `disabled_install_request`  (lines 254–261)

```
fn disabled_install_request(tool: &DiscoverableTool) -> ToolSuggestDisabledTool
```

**Purpose**: Converts a suggested tool into the config format used to say “do not suggest this tool again.” It keeps connector and plugin entries distinct.

**Data flow**: A DiscoverableTool goes in. If it is a connector, the function creates a disabled connector entry using the connector id. If it is a plugin, it creates a disabled plugin entry using the plugin id. The matching ToolSuggestDisabledTool value comes out.

**Call relations**: persist_disabled_install_request calls this while preparing the config edit. It hands the result to the config-edit machinery so the saved preference has the right shape.

*Call graph*: calls 2 internal fn (connector, plugin); called by 1 (persist_disabled_install_request).


##### `verify_request_plugin_install_completed`  (lines 263–304)

```
async fn verify_request_plugin_install_completed(
    session: &crate::session::session::Session,
    turn: &crate::session::turn_context::TurnContext,
    tool: &DiscoverableTool,
    auth: Option<&c
```

**Purpose**: Checks whether an accepted install suggestion actually resulted in the requested tool being available. It is the “did it really work?” step after the user says yes.

**Data flow**: The session, current turn, suggested tool, and optional authentication information go in. For connectors, it refreshes connector information if needed and checks whether the requested connector is accessible. For plugins, it treats remote marketplace suggestions as complete immediately; otherwise it reloads config, checks the plugin manager for an installed plugin with the requested id, and also refreshes any connectors that the plugin is expected to provide. It returns true when completion is verified, otherwise false.

**Call relations**: handle_call calls this only after the user accepts the suggestion. This function delegates connector checking to refresh_missing_requested_connectors, plugin installation checking to verified_plugin_install_completed, and remote-plugin detection to is_remote_plugin_install_suggestion.

*Call graph*: calls 3 internal fn (is_remote_plugin_install_suggestion, refresh_missing_requested_connectors, verified_plugin_install_completed); called by 1 (handle_call); 3 external calls (get_config, reload_user_config_layer, from_ref).


##### `is_remote_plugin_install_suggestion`  (lines 306–310)

```
fn is_remote_plugin_install_suggestion(plugin_id: &str) -> bool
```

**Purpose**: Recognizes plugin ids that point to the remote global marketplace. Those suggestions are considered complete after acceptance because local installation state is not checked the same way.

**Data flow**: A plugin id string goes in. The function looks for a marketplace suffix after an at-sign and compares that suffix with the remote global marketplace name. It returns true if the plugin id belongs to that marketplace.

**Call relations**: verify_request_plugin_install_completed calls this before doing local plugin checks. A true result short-circuits the local verification path.

*Call graph*: called by 1 (verify_request_plugin_install_completed).


##### `refresh_missing_requested_connectors`  (lines 312–353)

```
async fn refresh_missing_requested_connectors(
    session: &crate::session::session::Session,
    turn: &crate::session::turn_context::TurnContext,
    auth: Option<&codex_login::CodexAuth>,
    expe
```

**Purpose**: Checks whether expected connectors are visible, and forces a refresh if they are not. This helps the system notice newly installed or newly enabled app connectors.

**Data flow**: The session, current turn, optional authentication, expected connector ids, and the related tool id go in. If no connectors are expected, it immediately returns an empty list. Otherwise it reads the current MCP tools, where MCP is the protocol layer used to expose app tools, turns those tools into accessible connector records, and checks whether all requested connectors are present. If something is missing, it hard-refreshes the Codex Apps tools cache, rebuilds the connector list, refreshes the connector cache, and returns the latest accessible connectors. If refresh fails, it logs a warning and returns nothing.

**Call relations**: verify_request_plugin_install_completed calls this for connector installs and for plugins that should expose app connectors. This function relies on connector helpers to translate raw MCP tools into user-facing connector information and uses all_requested_connectors_picked_up to decide whether a refresh is needed.

*Call graph*: calls 3 internal fn (accessible_connectors_from_mcp_tools, refresh_accessible_connectors_cache_from_mcp_tools, with_app_enabled_state); called by 1 (verify_request_plugin_install_completed); 3 external calls (new, all_requested_connectors_picked_up, warn!).


##### `verified_plugin_install_completed`  (lines 355–368)

```
fn verified_plugin_install_completed(
    tool_id: &str,
    config: &crate::config::Config,
    plugins_manager: &codex_core_plugins::PluginsManager,
) -> bool
```

**Purpose**: Looks through the configured plugin marketplaces to see whether a specific plugin is marked as installed. This is the local proof that a plugin install succeeded.

**Data flow**: A plugin id, current config, and plugin manager go in. The function gets the plugin configuration input, asks the plugin manager for marketplace listings, walks through the plugins in those marketplaces, and returns true if it finds the requested id with installed set to true. If marketplace listing fails or no match is installed, it returns false.

**Call relations**: verify_request_plugin_install_completed calls this after reloading user config for a non-remote plugin suggestion. It hands the yes-or-no result back to the main verification flow.

*Call graph*: calls 1 internal fn (list_marketplaces_for_config); called by 1 (verify_request_plugin_install_completed); 1 external calls (plugins_config_input).


### User-facing plugin management surfaces
These files expose plugin ecosystem management through the CLI and TUI, translating user actions into marketplace and manager operations.

### `cli/src/plugin_cmd.rs`

`orchestration` · `command handling`

This file is the command-line front door for Codex plugins. A plugin is an add-on, and a marketplace is a named source where Codex can find those add-ons. Without this file, users could not run simple commands like `codex plugin add`, `codex plugin list`, or `codex plugin remove`; they would need to interact with lower-level plugin code directly.

The file first defines the command shapes: which subcommands exist, which flags they accept, and how plugin names can be written. Then each command follows the same broad pattern. It loads the Codex home folder and current configuration, builds a `PluginsManager` that knows how to install or uninstall plugins, and checks authentication so private or protected plugin sources can work when needed.

For installing, it turns a user’s plugin selector into a clear plugin-and-marketplace pair, checks that the marketplace snapshot can be read, finds the requested plugin, and asks the manager to install it. For listing, it gathers marketplace data, checks for broken configured snapshots, and prints either a table for humans or structured JSON for tools. For removal, it parses the same selector format and asks the manager to uninstall that plugin.

A notable part of the file is its snapshot validation. It does not silently ignore broken marketplace configuration. Instead, it builds clear error messages that say which marketplace path failed and why, while allowing a few built-in system marketplace paths that may be created implicitly.

#### Function details

##### `run_plugin_add`  (lines 124–173)

```
async fn run_plugin_add(
    overrides: Vec<(String, toml::Value)>,
    args: AddPluginArgs,
) -> Result<()>
```

**Purpose**: Runs the `codex plugin add` command. It finds the requested plugin in the requested marketplace, installs it, and reports the result either as readable text or JSON.

**Data flow**: It receives command-line configuration overrides and parsed add arguments. It loads the plugin command context, parses the user’s plugin selector into a plugin name and marketplace name, finds the matching marketplace snapshot, then asks the plugin manager to install the plugin. It prints either a compact success message and install path, or a JSON object describing the installed plugin.

**Call relations**: The main CLI calls this when the user chooses `plugin add`. This function leans on `load_plugin_command_context` for setup, `parse_plugin_selection` for understanding the user’s plugin input, `find_marketplace_for_plugin` for locating the source, and `JsonPluginAddOutput::from_outcome` when JSON output is requested.

*Call graph*: calls 4 internal fn (from_outcome, find_marketplace_for_plugin, load_plugin_command_context, parse_plugin_selection); called by 1 (cli_main); 1 external calls (println!).


##### `JsonPluginAddOutput::from_outcome`  (lines 187–196)

```
fn from_outcome(outcome: PluginInstallOutcome) -> Self
```

**Purpose**: Turns the internal install result into the JSON shape printed by `codex plugin add --json`. This keeps the command’s machine-readable output stable and easy to consume.

**Data flow**: It receives a `PluginInstallOutcome`, which contains the plugin identity, version, installed folder, and authentication policy. It copies and formats those fields into simple strings, including a readable authentication-policy label. It returns a serializable JSON output struct.

**Call relations**: `run_plugin_add` calls this after a successful install when the user asks for JSON. It uses `auth_policy_label` so the policy appears as a clear fixed string rather than an internal enum value.

*Call graph*: calls 1 internal fn (auth_policy_label); called by 1 (run_plugin_add).


##### `run_plugin_list`  (lines 199–312)

```
async fn run_plugin_list(
    overrides: Vec<(String, toml::Value)>,
    args: ListPluginsArgs,
) -> Result<()>
```

**Purpose**: Runs the `codex plugin list` command. It shows which plugins are installed, enabled, or available from configured marketplaces.

**Data flow**: It receives configuration overrides and list arguments such as marketplace filter, JSON mode, and whether to include available-but-not-installed plugins. It loads configuration and the plugin manager, asks the manager for marketplace plugin information, checks for snapshot loading problems, filters by marketplace if requested, and then prints either JSON or a formatted table.

**Call relations**: The main CLI calls this for `plugin list`. It uses `load_plugin_command_context` for setup, `ensure_configured_marketplace_snapshots_loaded` to stop on broken marketplace snapshots, `configured_marketplace_sources` to include marketplace origin details in JSON, and `JsonPluginListOutput::from_marketplaces` to build JSON output.

*Call graph*: calls 4 internal fn (from_marketplaces, configured_marketplace_sources, ensure_configured_marketplace_snapshots_loaded, load_plugin_command_context); called by 1 (cli_main); 4 external calls (new, format!, println!, vec!).


##### `JsonPluginListOutput::from_marketplaces`  (lines 322–350)

```
fn from_marketplaces(
        marketplaces: Vec<codex_core_plugins::ConfiguredMarketplace>,
        include_available: bool,
        marketplace_sources: &HashMap<String, JsonMarketplaceSource>,
    )
```

**Purpose**: Builds the full JSON result for `codex plugin list --json`. It separates installed plugins from optionally included available plugins.

**Data flow**: It receives a list of marketplaces, a flag saying whether uninstalled available plugins should be included, and known marketplace source details. It walks through every plugin in every marketplace, turns each one into a JSON entry, puts installed entries in one list, and puts uninstalled entries in the available list only when requested. It returns the complete JSON output object.

**Call relations**: `run_plugin_list` calls this when JSON output is requested. For each plugin, it delegates the per-plugin conversion to `JsonPluginListEntry::from_configured_plugin`.

*Call graph*: calls 1 internal fn (from_configured_plugin); called by 1 (run_plugin_list); 1 external calls (new).


##### `JsonPluginListEntry::from_configured_plugin`  (lines 370–388)

```
fn from_configured_plugin(
        marketplace_name: &str,
        marketplace_source: Option<JsonMarketplaceSource>,
        plugin: codex_core_plugins::ConfiguredMarketplacePlugin,
    ) -> Self
```

**Purpose**: Turns one marketplace plugin record into one JSON list entry. It makes sure the JSON includes identity, version, install state, source, and policy labels.

**Data flow**: It receives the marketplace name, optional marketplace source information, and one configured plugin record. It chooses the best version to show, copies install and enabled state, converts the plugin source into a JSON-friendly form, labels the install and authentication policies, and returns a serializable entry.

**Call relations**: `JsonPluginListOutput::from_marketplaces` calls this while assembling list output. It relies on `JsonPluginSource::from_marketplace_source`, `install_policy_label`, and `auth_policy_label` to turn internal values into stable JSON strings.

*Call graph*: calls 3 internal fn (from_marketplace_source, auth_policy_label, install_policy_label); called by 1 (from_marketplaces).


##### `JsonPluginSource::from_marketplace_source`  (lines 415–438)

```
fn from_marketplace_source(source: MarketplacePluginSource) -> Self
```

**Purpose**: Converts a plugin source into a clean JSON form. It distinguishes local folders, whole Git repositories, and subfolders inside Git repositories.

**Data flow**: It receives an internal `MarketplacePluginSource`. If the plugin comes from a local path, it records that path as text. If it comes from Git, it records the URL and optional reference or commit; when a subdirectory is involved, it records that path separately. It returns the matching JSON source variant.

**Call relations**: `JsonPluginListEntry::from_configured_plugin` calls this while preparing list JSON. This keeps source formatting in one place instead of spreading Git and local-path details through the listing command.

*Call graph*: called by 1 (from_configured_plugin).


##### `configured_marketplace_sources`  (lines 448–477)

```
fn configured_marketplace_sources(
    plugins_input: &PluginsConfigInput,
) -> HashMap<String, JsonMarketplaceSource>
```

**Purpose**: Reads the user’s marketplace configuration and extracts where each configured marketplace came from. This extra source information is useful in JSON listing output.

**Data flow**: It receives plugin configuration input. It looks for the effective user configuration, then for a `marketplaces` table, and then for each marketplace’s `source_type` and `source` fields. It returns a map from marketplace name to a small JSON-friendly source description; if the needed configuration is missing, it returns an empty map.

**Call relations**: `run_plugin_list` uses this to enrich JSON output with marketplace source details. Another helper, `configured_marketplace_sources_by_root`, also calls it when it needs the same source lookup organized for a different purpose.

*Call graph*: called by 2 (configured_marketplace_sources_by_root, run_plugin_list); 1 external calls (new).


##### `install_policy_label`  (lines 479–485)

```
fn install_policy_label(policy: MarketplacePluginInstallPolicy) -> &'static str
```

**Purpose**: Turns an internal install-policy value into a fixed text label for JSON output. This avoids exposing Rust-specific enum formatting to users or scripts.

**Data flow**: It receives a marketplace plugin installation policy. It matches that policy to one of the public string labels: not available, available, or installed by default. It returns that label.

**Call relations**: `JsonPluginListEntry::from_configured_plugin` calls this while building each JSON list entry. It is a small translation step between internal plugin rules and external output.

*Call graph*: called by 1 (from_configured_plugin).


##### `auth_policy_label`  (lines 487–492)

```
fn auth_policy_label(policy: MarketplacePluginAuthPolicy) -> &'static str
```

**Purpose**: Turns an internal authentication-policy value into a fixed text label. This tells users or scripts whether authentication is needed when installing or when using the plugin.

**Data flow**: It receives a marketplace plugin authentication policy. It maps the policy to either `ON_INSTALL` or `ON_USE`. It returns that label as text.

**Call relations**: `JsonPluginAddOutput::from_outcome` uses this for install JSON, and `JsonPluginListEntry::from_configured_plugin` uses it for list JSON. This keeps policy wording consistent across commands.

*Call graph*: called by 2 (from_outcome, from_configured_plugin).


##### `run_plugin_remove`  (lines 494–521)

```
async fn run_plugin_remove(
    overrides: Vec<(String, toml::Value)>,
    args: RemovePluginArgs,
) -> Result<()>
```

**Purpose**: Runs the `codex plugin remove` command. It removes an installed plugin from local plugin configuration and cache.

**Data flow**: It receives configuration overrides and parsed remove arguments. It loads the plugin command context, parses the plugin selector into a full plugin key, asks the plugin manager to uninstall that plugin, and then prints either JSON or a human-readable removal message.

**Call relations**: The main CLI calls this when the user chooses `plugin remove`. It uses `load_plugin_command_context` for setup, `parse_plugin_selection` to understand the plugin argument, and `JsonPluginRemoveOutput::from_selection` for JSON output.

*Call graph*: calls 3 internal fn (from_selection, load_plugin_command_context, parse_plugin_selection); called by 1 (cli_main); 1 external calls (println!).


##### `JsonPluginRemoveOutput::from_selection`  (lines 532–538)

```
fn from_selection(selection: PluginSelection) -> Self
```

**Purpose**: Builds the JSON response for a successful plugin removal. It reports exactly which plugin and marketplace were targeted.

**Data flow**: It receives a parsed `PluginSelection`. It copies the full plugin key, plugin name, and marketplace name into a serializable output struct. It returns that struct for JSON printing.

**Call relations**: `run_plugin_remove` calls this after uninstalling a plugin when the user requested JSON output.

*Call graph*: called by 1 (run_plugin_remove).


##### `load_plugin_command_context`  (lines 547–562)

```
async fn load_plugin_command_context(
    overrides: Vec<(String, toml::Value)>,
) -> Result<PluginCommandContext>
```

**Purpose**: Prepares the shared setup needed by plugin commands. It finds Codex’s home folder, loads configuration, creates the plugin manager, and attaches authentication information if available.

**Data flow**: It receives command-line configuration overrides. It resolves `CODEX_HOME`, loads configuration with those overrides applied, derives plugin-specific configuration input, creates a `PluginsManager` rooted at the Codex home folder, and sets the manager’s authentication mode. It returns all of that bundled into a command context.

**Call relations**: `run_plugin_add`, `run_plugin_list`, and `run_plugin_remove` all call this at the start of their work. It calls `load_cli_auth_mode` so the manager can use an API key or stored login when plugin operations require authentication.

*Call graph*: calls 3 internal fn (load_cli_auth_mode, new, find_codex_home); called by 3 (run_plugin_add, run_plugin_list, run_plugin_remove); 1 external calls (load_with_cli_overrides).


##### `load_cli_auth_mode`  (lines 564–579)

```
async fn load_cli_auth_mode(config: &Config) -> Option<AuthMode>
```

**Purpose**: Finds the authentication mode the command-line tool should use for plugin-related requests. It first honors an API key from the environment, then falls back to stored login credentials.

**Data flow**: It receives the loaded Codex configuration. It checks for an API key in the environment; if one exists, it converts it into an API authentication mode. Otherwise, it reads stored authentication using the configured credential store, base URL, and keyring backend, and converts that login into an API authentication mode if found. It returns an optional authentication mode.

**Call relations**: `load_plugin_command_context` calls this during plugin command setup, and `run_list` also calls it elsewhere in the CLI. It delegates to login helpers that know how to read environment variables and stored credentials.

*Call graph*: calls 2 internal fn (from_api_key, from_auth_storage); called by 2 (run_list, load_plugin_command_context); 2 external calls (auth_keyring_backend_kind, read_codex_api_key_from_env).


##### `PluginSelection::from_plugin_id`  (lines 588–595)

```
fn from_plugin_id(plugin_id: PluginId) -> Self
```

**Purpose**: Turns a parsed plugin identifier into the local selection object used by add and remove commands. It keeps the separate plugin name, marketplace name, and combined key together.

**Data flow**: It receives a `PluginId`, which already knows the plugin name and marketplace name. It asks the ID for its combined key string, then stores all three pieces in a `PluginSelection`. It returns that selection.

**Call relations**: `parse_plugin_selection` calls this whenever it has a valid `PluginId`. This function is the bridge between the shared plugin ID type and this file’s command-specific selection shape.

*Call graph*: calls 1 internal fn (as_key); called by 1 (parse_plugin_selection).


##### `parse_plugin_selection`  (lines 598–623)

```
fn parse_plugin_selection(
    plugin: String,
    marketplace_name: Option<String>,
) -> Result<PluginSelection>
```

**Purpose**: Interprets how the user named a plugin on the command line. It accepts either `plugin@marketplace` or `plugin --marketplace marketplace`, and rejects ambiguous or conflicting input.

**Data flow**: It receives the plugin text and an optional marketplace name from the flag. It first tries to parse the plugin text as a full plugin ID. If both the text and flag specify a marketplace, it checks they agree. If the text is only a plugin name, it requires the flag and builds a full plugin ID. It returns a `PluginSelection` or an error explaining what is wrong.

**Call relations**: `run_plugin_add` and `run_plugin_remove` call this before doing any plugin operation. It uses `PluginSelection::from_plugin_id` after parsing or creating a valid ID, and stops the command early with clear errors when the user’s input cannot identify one plugin.

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

**Purpose**: Finds the configured marketplace snapshot that contains the plugin the user wants to install. It also makes sure broken marketplace snapshots are reported clearly before installation proceeds.

**Data flow**: It receives the plugin manager, Codex home path, plugin configuration input, marketplace name, and plugin name. It asks the manager to list configured marketplaces, checks whether any configured snapshots failed to load, then filters to marketplaces with the requested name and plugin. It returns the one matching marketplace, or errors if none or more than one match.

**Call relations**: `run_plugin_add` calls this before asking the manager to install. It calls `ensure_configured_marketplace_snapshots_loaded` so install failures point to bad marketplace setup rather than looking like the plugin simply disappeared.

*Call graph*: calls 2 internal fn (ensure_configured_marketplace_snapshots_loaded, list_marketplaces_for_config); called by 1 (run_plugin_add); 1 external calls (bail!).


##### `ensure_configured_marketplace_snapshots_loaded`  (lines 668–697)

```
fn ensure_configured_marketplace_snapshots_loaded(
    codex_home: &std::path::Path,
    plugins_input: &PluginsConfigInput,
    load_errors: &[MarketplaceListError],
    marketplace_name: Option<&str
```

**Purpose**: Stops a command when configured marketplace snapshots are broken. It turns lower-level load problems into a readable multi-line error message.

**Data flow**: It receives the Codex home path, plugin configuration input, marketplace loading errors, and an optional marketplace filter. It asks `configured_marketplace_snapshot_issues` to identify relevant problems. If there are no issues, it returns success; otherwise, it formats each issue with the marketplace name, path, and message, then returns an error.

**Call relations**: `run_plugin_list` calls this after listing marketplaces, and `find_marketplace_for_plugin` calls it before installing. It delegates the detailed inspection work to `configured_marketplace_snapshot_issues`.

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

**Purpose**: Inspects configured marketplace entries and explains why any snapshot cannot be used. This is the diagnostic engine behind the clearer marketplace error messages.

**Data flow**: It receives the Codex home path, plugin configuration input, marketplace load errors, and an optional marketplace name to focus on. It reads the user’s marketplace configuration, validates that entries are tables with valid names and usable local sources, resolves each marketplace root folder, looks for a supported manifest file, and matches reported load errors back to configured marketplaces. It returns a list of issue records with name, path, and message.

**Call relations**: `ensure_configured_marketplace_snapshots_loaded` calls this when commands need to decide whether marketplace loading problems should fail the command. `run_list` also calls it elsewhere. It uses helpers from the plugin marketplace layer to resolve paths and find manifests, and it uses `is_implicit_system_marketplace_root` to avoid flagging certain built-in system paths as user errors.

*Call graph*: calls 4 internal fn (is_implicit_system_marketplace_root, marketplace_install_root, resolve_configured_marketplace_root, find_marketplace_manifest_path); called by 2 (run_list, ensure_configured_marketplace_snapshots_loaded); 3 external calls (from, new, validate_plugin_segment).


##### `is_implicit_system_marketplace_root`  (lines 788–811)

```
fn is_implicit_system_marketplace_root(
    marketplace_name: &str,
    _codex_home: &Path,
    root: &Path,
) -> bool
```

**Purpose**: Recognizes special built-in marketplace folder layouts that are allowed to exist without a normal manifest in this check. This prevents internal system marketplace paths from being reported as broken user configuration.

**Data flow**: It receives a marketplace name, the Codex home path, and a root path. It checks whether the name is one of the known OpenAI system marketplace names and whether the path ends with the expected folder pattern. It returns true for those recognized implicit system roots and false otherwise.

**Call relations**: `configured_marketplace_snapshot_issues` calls this when a marketplace root has no supported manifest. This helper decides whether that missing manifest is acceptable for built-in system marketplaces or should become a reported issue.

*Call graph*: calls 1 internal fn (path_ends_with); called by 1 (configured_marketplace_snapshot_issues); 1 external calls (matches!).


##### `path_ends_with`  (lines 813–824)

```
fn path_ends_with(path: &Path, suffix: &[&str]) -> bool
```

**Purpose**: Checks whether a filesystem path ends with a given sequence of folder names. It is a small helper for recognizing expected built-in marketplace locations.

**Data flow**: It receives a path and a list of suffix components. It breaks the path into its folder components, converts them to strings, and compares the end of the path to the requested suffix. It returns true if the path has that ending, otherwise false.

**Call relations**: `is_implicit_system_marketplace_root` calls this to test the exact folder layouts used by built-in system marketplaces.

*Call graph*: called by 1 (is_implicit_system_marketplace_root); 1 external calls (components).


### `tui/src/chatwidget/plugins.rs`

`orchestration` · `active when the user opens or interacts with the /plugins popup`

This file is the terminal UI’s control room for plugins. A plugin is an add-on that can give Codex extra skills, hooks, apps, or MCP servers. A marketplace is a source of plugins, like a catalog. Without this file, the `/plugins` command would have no usable menu: users could not browse catalogs, see install status, add custom marketplaces, or recover gracefully from loading errors.

The file works like a shop counter. First it checks whether plugins are enabled. Then it asks the app backend to fetch the current plugin list for the current working folder. While waiting, it shows loading rows with optional animation. When data arrives, it builds a tabbed selection view: all plugins, installed plugins, OpenAI-curated plugins, one tab per extra marketplace, and an add-marketplace tab.

It also reacts to later events. If plugin details load, it replaces the list with a detail page. If install or uninstall finishes, it shows success, error, or a follow-up app-authentication flow. If remote marketplace sections arrive after the first list, it merges them into the cached list and refreshes the popup.

A lot of the helper functions turn raw plugin data into human labels, tab IDs, descriptions, and button actions. The important behavior is that almost every response is checked against the current working folder first. That prevents an old background result from changing the UI after the user has moved to another project.

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

**Purpose**: Creates a loading header for plugin-related popups. It records when loading started so the UI can delay or animate the loading text instead of flickering immediately.

**Data flow**: It receives a frame requester, an animation setting, the loading message, and an optional note. It stores those with the current time and returns a header object ready to render.

**Call relations**: Loading popup builders call this when they need a consistent header for fetching plugins, adding marketplaces, upgrading marketplaces, or loading plugin details.

*Call graph*: called by 4 (marketplace_add_loading_popup_params, marketplace_upgrade_loading_popup_params, plugin_detail_loading_popup_params, plugins_loading_popup_params); 1 external calls (now).


##### `DelayedLoadingHeader::render`  (lines 108–138)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the loading header into the terminal. It shows the title, loading text, and optional note, and it schedules future redraws when animation is needed.

**Data flow**: It reads its start time, text, note, animation flag, and the drawing area. It writes formatted lines into the terminal buffer and may ask the UI to draw another frame later.

**Call relations**: The selection view calls this through the generic render system whenever a loading popup is visible.

*Call graph*: calls 2 internal fn (shimmer_text, schedule_frame_in); 5 external calls (now, from, new, is_empty, with_capacity).


##### `DelayedLoadingHeader::desired_height`  (lines 140–142)

```
fn desired_height(&self, _width: u16) -> u16
```

**Purpose**: Tells the layout system how many terminal rows this loading header needs. It adds one extra row when there is a note.

**Data flow**: It ignores width because this header has a fixed small number of lines. It returns either two rows or three rows.

**Call relations**: The rendering system uses this before drawing, so the bottom pane can reserve enough vertical space.

*Call graph*: 1 external calls (from).


##### `PluginDisclosureLine::render`  (lines 152–157)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the disclosure text shown before installing an uninstalled plugin. It also marks the help URL as a clickable hyperlink in supporting terminals.

**Data flow**: It receives a drawing area and buffer. It writes the disclosure line with wrapping, then annotates the help article URL in that same area.

**Call relations**: The plugin detail popup includes this renderable when a plugin is not yet installed, so users see the data-sharing warning before installing.

*Call graph*: 3 external calls (clone, new, mark_url_hyperlink).


##### `PluginDisclosureLine::desired_height`  (lines 159–165)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Calculates how many terminal rows the disclosure text will take after wrapping. This keeps the detail page from overlapping text.

**Data flow**: It receives the available width, measures the wrapped paragraph, and returns the needed row count.

**Call relations**: The layout system calls this when preparing the plugin detail header.

*Call graph*: 2 external calls (clone, new).


##### `ChatWidget::add_plugins_output`  (lines 178–202)

```
fn add_plugins_output(&mut self)
```

**Purpose**: Starts the `/plugins` UI flow. It checks whether plugins are allowed, begins fetching plugin data, and opens either the real plugin list, an error, or a loading popup.

**Data flow**: It reads feature flags, cache state, and current working folder. It may send a fetch request, update the active tab, write an error or info message, open a popup, and request a redraw.

**Call relations**: This is the main entry from the chat command. It calls the prefetch and popup-building helpers that start the rest of the plugin browsing experience.

*Call graph*: calls 4 internal fn (open_plugins_loading_popup, open_plugins_popup, plugins_cache_for_current_cwd, prefetch_plugins); 1 external calls (new_error_event).


##### `ChatWidget::on_plugins_loaded`  (lines 204–275)

```
fn on_plugins_loaded(
        &mut self,
        cwd: PathBuf,
        result: Result<PluginListResponse, String>,
    )
```

**Purpose**: Processes the result of fetching the plugin list. It updates the cache and refreshes the popup if the user is still looking at plugins.

**Data flow**: It receives the folder that was fetched and either a plugin list or an error. If the folder matches the current one, it stores the new state, repairs saved tab IDs when marketplace paths changed, clears or records errors, and updates the visible pane.

**Call relations**: The app event loop calls this after the backend finishes listing plugins. It hands successful data to the popup refresh path, or builds an error popup on failure.

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

**Purpose**: Adds remote marketplace sections that arrive after the initial plugin list. This lets the UI show quick local results first and fill in remote sections later.

**Data flow**: It receives a folder, remote marketplace entries, and any section errors. If the folder matches, it merges remote entries into the cached response, stores section errors, and refreshes the popup if it is open.

**Call relations**: The background plugin loader calls this when slower remote sections finish. It relies on the merge helper to replace stale remote sections cleanly.

*Call graph*: calls 2 internal fn (refresh_plugins_popup_if_open, merge_remote_marketplaces); 1 external calls (as_path).


##### `ChatWidget::prefetch_plugins`  (lines 314–322)

```
fn prefetch_plugins(&mut self)
```

**Purpose**: Starts a plugin-list fetch unless the same folder is already being fetched. This avoids duplicate backend work.

**Data flow**: It reads the current working folder and the in-flight fetch state. If no matching fetch is running, it marks the fetch as started and sends an app event requesting the plugin list.

**Call relations**: The `/plugins` command calls this before deciding what popup to show, so cached data can be displayed immediately while fresh data is requested.

*Call graph*: calls 1 internal fn (on_plugins_list_fetch_started); called by 1 (add_plugins_output).


##### `ChatWidget::on_plugins_list_fetch_started`  (lines 324–333)

```
fn on_plugins_list_fetch_started(&mut self, cwd: PathBuf)
```

**Purpose**: Records that plugin loading has begun for the current folder. It also switches the cache to loading when there is no valid cached list for that folder.

**Data flow**: It receives a folder path. If it matches the current folder, it saves it as in-flight and may replace the cache state with loading.

**Call relations**: The prefetch helper calls this just before sending the fetch request to the app event system.

*Call graph*: called by 1 (prefetch_plugins); 2 external calls (as_path, clone).


##### `ChatWidget::plugins_cache_for_current_cwd`  (lines 335–341)

```
fn plugins_cache_for_current_cwd(&self) -> PluginsCacheState
```

**Purpose**: Returns plugin cache data only if it belongs to the current working folder. This prevents stale data from another project from appearing in the popup.

**Data flow**: It compares the cache folder with the widget’s current folder. If they match, it returns the stored cache state; otherwise it returns an uninitialized state.

**Call relations**: Many handlers call this before showing lists, detail errors, confirmation screens, or restoring the plugin view.

*Call graph*: called by 10 (add_plugins_output, finish_plugin_install_auth_flow, handle_plugins_popup_key_event, marketplace_add_error_popup_params, marketplace_remove_error_popup_params, on_plugin_detail_loaded, on_plugin_enabled_set, on_plugin_install_loaded, on_plugin_uninstall_loaded, open_marketplace_remove_confirmation).


##### `ChatWidget::open_plugins_loading_popup`  (lines 343–351)

```
fn open_plugins_loading_popup(&mut self)
```

**Purpose**: Shows the standard loading popup for the plugin list. If the plugin popup is already open, it replaces it instead of stacking another view.

**Data flow**: It builds loading view parameters and gives them to the bottom pane. The visible UI becomes a disabled loading row with a loading header.

**Call relations**: The `/plugins` command uses this while waiting for the plugin list.

*Call graph*: calls 1 internal fn (plugins_loading_popup_params); called by 1 (add_plugins_output).


##### `ChatWidget::open_plugins_popup`  (lines 353–361)

```
fn open_plugins_popup(&mut self, response: &PluginListResponse)
```

**Purpose**: Opens the full plugin browser using a loaded plugin-list response. It starts on the All Plugins tab.

**Data flow**: It stores the active tab as All Plugins, turns the response into selection-view parameters, and asks the bottom pane to show that view.

**Call relations**: The `/plugins` command calls this when cached plugin data is already ready.

*Call graph*: calls 1 internal fn (plugins_popup_params); called by 1 (add_plugins_output).


##### `ChatWidget::open_marketplace_add_prompt`  (lines 363–387)

```
fn open_marketplace_add_prompt(&mut self)
```

**Purpose**: Shows a text prompt where the user can type a marketplace source. The source can be an owner/repo name, a Git URL, or a local path.

**Data flow**: It builds a custom prompt. When the user submits non-empty text, the prompt sends events to show loading and fetch marketplace installation.

**Call relations**: The Add Marketplace tab and retry flows route here when the user wants to add a new plugin catalog.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, new).


##### `ChatWidget::open_marketplace_add_loading_popup`  (lines 389–399)

```
fn open_marketplace_add_loading_popup(&mut self, _source: &str)
```

**Purpose**: Shows a loading popup while a marketplace is being added. It keeps the active tab on the add-marketplace area.

**Data flow**: It builds loading parameters and either replaces the current plugin selection view or opens a new one.

**Call relations**: The event system calls this after the add prompt submits, before the backend add operation finishes.

*Call graph*: calls 1 internal fn (marketplace_add_loading_popup_params).


##### `ChatWidget::open_marketplace_upgrade_loading_popup`  (lines 401–419)

```
fn open_marketplace_upgrade_loading_popup(
        &mut self,
        marketplace_name: Option<&str>,
    )
```

**Purpose**: Shows a loading popup while one marketplace, or all eligible marketplaces, are being upgraded. It remembers the current plugin tab when possible.

**Data flow**: It reads the current active plugin tab, builds an upgrade-loading view with an optional marketplace name, and places it in the bottom pane.

**Call relations**: The keyboard handler calls this after the user presses the upgrade shortcut for a marketplace tab.

*Call graph*: calls 1 internal fn (marketplace_upgrade_loading_popup_params); called by 1 (handle_plugins_popup_key_event).


##### `ChatWidget::open_marketplace_remove_confirmation`  (lines 421–454)

```
fn open_marketplace_remove_confirmation(
        &mut self,
        marketplace_name: String,
        marketplace_display_name: String,
    )
```

**Purpose**: Asks the user to confirm removing a marketplace before doing it. This protects against accidental removal.

**Data flow**: It reads the current plugin cache, builds a confirmation view with Remove and Back choices, and shows or replaces the plugin popup.

**Call relations**: The keyboard handler calls this after the user presses the remove shortcut on a removable marketplace tab.

*Call graph*: calls 2 internal fn (marketplace_remove_confirmation_popup_params, plugins_cache_for_current_cwd); called by 1 (handle_plugins_popup_key_event).


##### `ChatWidget::open_marketplace_remove_loading_popup`  (lines 456–466)

```
fn open_marketplace_remove_loading_popup(&mut self, marketplace_display_name: &str)
```

**Purpose**: Shows progress while a marketplace removal request is running.

**Data flow**: It receives the marketplace display name, builds a loading row using that name, and places it into the bottom pane.

**Call relations**: The remove confirmation action sends an event that leads here before the backend removal result arrives.

*Call graph*: calls 1 internal fn (marketplace_remove_loading_popup_params).


##### `ChatWidget::open_plugin_detail_loading_popup`  (lines 468–478)

```
fn open_plugin_detail_loading_popup(&mut self, plugin_display_name: &str)
```

**Purpose**: Shows progress while detailed information for a plugin is being fetched.

**Data flow**: It remembers the current tab, builds a detail-loading view for the selected plugin name, and replaces the active plugin selection view.

**Call relations**: Plugin list item actions trigger this before sending the backend request for plugin details.

*Call graph*: calls 1 internal fn (plugin_detail_loading_popup_params).


##### `ChatWidget::open_plugin_install_loading_popup`  (lines 480–485)

```
fn open_plugin_install_loading_popup(&mut self, plugin_display_name: &str)
```

**Purpose**: Shows progress while a plugin install request is running.

**Data flow**: It receives a plugin display name, builds an install-loading view, and replaces the current plugin selection view if present.

**Call relations**: The install button in a plugin detail page triggers this just before requesting installation.

*Call graph*: calls 1 internal fn (plugin_install_loading_popup_params).


##### `ChatWidget::open_plugin_uninstall_loading_popup`  (lines 487–492)

```
fn open_plugin_uninstall_loading_popup(&mut self, plugin_display_name: &str)
```

**Purpose**: Shows progress while a plugin uninstall request is running.

**Data flow**: It receives a plugin display name, builds an uninstall-loading view, and replaces the current plugin selection view if present.

**Call relations**: The uninstall button in a plugin detail page triggers this just before requesting removal.

*Call graph*: calls 1 internal fn (plugin_uninstall_loading_popup_params).


##### `ChatWidget::on_plugin_detail_loaded`  (lines 494–524)

```
fn on_plugin_detail_loaded(
        &mut self,
        cwd: PathBuf,
        result: Result<PluginReadResponse, String>,
    )
```

**Purpose**: Processes the result of loading a plugin’s full details. It shows the detail page on success or an error page on failure.

**Data flow**: It receives the fetched folder and either detail data or an error. If the folder matches, it reads the cached list for a back button, then replaces the visible popup.

**Call relations**: The backend detail request leads here. It delegates to detail-popup or detail-error builders depending on the result.

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

**Purpose**: Processes the result of installing a plugin. It may finish immediately or start a follow-up flow for required ChatGPT apps that still need authentication.

**Data flow**: It receives folder, plugin identity information, display name, and the install result. On success it stores apps needing authentication, posts messages, and may open the auth popup; on failure it clears auth state and shows an error.

**Call relations**: The backend install operation leads here. If more app setup is needed, this function starts the auth-flow helpers and returns false to show the flow is still active.

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

**Purpose**: Processes the result of adding a marketplace. It selects the new marketplace tab and tells the user what happened, or shows a retry screen on failure.

**Data flow**: It receives the folder, source, and add result. On success it updates active-tab state and posts an info message with the installed root. On failure it opens an add-error popup.

**Call relations**: The backend marketplace-add request leads here after the add prompt and loading popup.

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

**Purpose**: Processes the result of removing a marketplace. It returns focus to the all-plugins tab on success or offers a retry on failure.

**Data flow**: It receives the folder, marketplace names, and removal result. On success it posts a message showing what was removed; on failure it builds a marketplace removal error popup.

**Call relations**: The backend marketplace-remove request leads here after the confirmation and loading screens.

*Call graph*: calls 1 internal fn (marketplace_remove_error_popup_params); 2 external calls (as_path, format!).


##### `ChatWidget::on_marketplace_upgrade_loaded`  (lines 679–768)

```
fn on_marketplace_upgrade_loaded(
        &mut self,
        cwd: PathBuf,
        result: Result<MarketplaceUpgradeResponse, String>,
    )
```

**Purpose**: Processes the result of upgrading Git-backed marketplaces. It reports whether anything changed and surfaces per-marketplace failures.

**Data flow**: It receives the folder and upgrade result. It counts selected marketplaces, upgraded roots, and errors, then posts clear info or error messages and may select the upgraded marketplace tab.

**Call relations**: The backend upgrade request leads here after the keyboard shortcut starts an upgrade.

*Call graph*: calls 1 internal fn (marketplace_tab_id_from_path); 2 external calls (as_path, format!).


##### `ChatWidget::handle_plugins_popup_key_event`  (lines 770–822)

```
fn handle_plugins_popup_key_event(&mut self, key_event: KeyEvent) -> bool
```

**Purpose**: Handles special keyboard shortcuts in the plugin popup for removing or upgrading a marketplace. It ignores keys that are not relevant or not allowed for the current tab.

**Data flow**: It receives a key event, reads the active tab and cached marketplace list, checks configuration permissions, and either opens a remove confirmation or starts an upgrade request.

**Call relations**: The chat widget’s input path calls this while the plugins popup is active. It hands off to remove or upgrade popup functions and sends backend events.

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

**Purpose**: Updates the UI after the user enables or disables an installed plugin. It also rolls the visible list back to the cache if the config update failed.

**Data flow**: It receives folder, plugin ID, desired enabled state, and result. On success it updates matching plugin summaries in the cached response; on failure it shows an error and refreshes from cache.

**Call relations**: Toggle controls in plugin rows send events that eventually call this when the config write completes.

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

**Purpose**: Processes the result of uninstalling a plugin. It clears any install-auth state and reports success, or shows an error page.

**Data flow**: It receives folder, plugin display name, and uninstall result. On success it posts an info message; on failure it builds a detail error popup with a possible back button.

**Call relations**: The backend uninstall request leads here after the uninstall loading popup.

*Call graph*: calls 2 internal fn (plugin_detail_error_popup_params, plugins_cache_for_current_cwd); 2 external calls (as_path, format!).


##### `ChatWidget::advance_plugin_install_auth_flow`  (lines 899–914)

```
fn advance_plugin_install_auth_flow(&mut self)
```

**Purpose**: Moves to the next required app in the post-install app setup flow. If there are no more apps, it finishes the flow.

**Data flow**: It increments the next app index in the auth-flow state. It either opens the next app setup popup or calls the finish helper.

**Call relations**: The “Continue” or “I’ve installed it” action in the auth popup sends an event that calls this.

*Call graph*: calls 2 internal fn (finish_plugin_install_auth_flow, open_plugin_install_auth_popup).


##### `ChatWidget::abandon_plugin_install_auth_flow`  (lines 916–918)

```
fn abandon_plugin_install_auth_flow(&mut self)
```

**Purpose**: Stops the remaining app setup steps for a newly installed plugin. It is used when the user chooses to skip the rest.

**Data flow**: It does not need extra input. It calls the finish helper with an abandoned flag so the user gets the right message.

**Call relations**: The auth popup’s “Skip remaining app setup” action leads here.

*Call graph*: calls 1 internal fn (finish_plugin_install_auth_flow).


##### `ChatWidget::open_plugin_install_auth_popup`  (lines 920–932)

```
fn open_plugin_install_auth_popup(&mut self)
```

**Purpose**: Shows the next app-authentication step after installing a plugin. If there is no valid next step, it finishes the flow instead.

**Data flow**: It asks for auth-popup parameters from current flow state. If parameters exist, it replaces or opens the selection view; otherwise it completes the flow.

**Call relations**: Install completion and auth-flow advancement both call this to display the current app setup step.

*Call graph*: calls 2 internal fn (finish_plugin_install_auth_flow, plugin_install_auth_popup_params); called by 2 (advance_plugin_install_auth_flow, on_plugin_install_loaded).


##### `ChatWidget::plugin_install_auth_popup_params`  (lines 934–1033)

```
fn plugin_install_auth_popup_params(&self) -> Option<SelectionViewParams>
```

**Purpose**: Builds the selection view for one required ChatGPT app after plugin installation. It gives the user a link to install or manage the app, a continue action, and a skip option.

**Data flow**: It reads the current auth-flow state, the current required app, and connector availability. It returns view parameters with header text and actionable rows, or no view if the state is incomplete.

**Call relations**: The auth popup opener calls this. Its row actions send events to open a browser, advance the flow, refresh connectors, or abandon setup.

*Call graph*: calls 3 internal fn (plugin_install_auth_app_is_installed, plugin_detail_hint_line, new); called by 1 (open_plugin_install_auth_popup); 6 external calls (new, default, from, new, format!, vec!).


##### `ChatWidget::plugin_install_auth_app_is_installed`  (lines 1035–1041)

```
fn plugin_install_auth_app_is_installed(&self, app_id: &str) -> bool
```

**Purpose**: Checks whether a required app already appears installed and accessible in this session. This changes the wording and action in the auth popup.

**Data flow**: It receives an app ID, reads the current connector list, and returns true if a connector with that ID is accessible.

**Call relations**: The auth-popup builder calls this for the app currently being shown.

*Call graph*: called by 1 (plugin_install_auth_popup_params).


##### `ChatWidget::finish_plugin_install_auth_flow`  (lines 1043–1081)

```
fn finish_plugin_install_auth_flow(&mut self, abandoned: bool)
```

**Purpose**: Ends the post-install app setup flow and returns the user toward the plugin list. It posts a different message depending on whether the user completed or skipped setup.

**Data flow**: It removes the active auth-flow state, clears the app list, posts an info message, and if plugin cache is available, rebuilds the plugin popup on the saved tab.

**Call relations**: Advance, abandon, and invalid auth-popup states all call this as the final cleanup step.

*Call graph*: calls 2 internal fn (plugins_cache_for_current_cwd, plugins_popup_params); called by 3 (abandon_plugin_install_auth_flow, advance_plugin_install_auth_flow, open_plugin_install_auth_popup); 1 external calls (format!).


##### `ChatWidget::refresh_plugins_popup_if_open`  (lines 1083–1097)

```
fn refresh_plugins_popup_if_open(&mut self, response: &PluginListResponse)
```

**Purpose**: Rebuilds the plugin popup while preserving the current tab and selected row as much as possible. This keeps the list fresh without disorienting the user.

**Data flow**: It reads the active tab and selected index from the bottom pane, stores the active tab, builds new plugin popup parameters from the response, and replaces the active view.

**Call relations**: Plugin-list loading, remote-section loading, and enable/disable updates call this after cache data changes.

*Call graph*: calls 1 internal fn (plugins_popup_params); called by 3 (on_plugin_enabled_set, on_plugin_remote_sections_loaded, on_plugins_loaded).


##### `ChatWidget::plugins_loading_popup_params`  (lines 1099–1116)

```
fn plugins_loading_popup_params(&self) -> SelectionViewParams
```

**Purpose**: Builds the standard loading view shown while the plugin list is being fetched.

**Data flow**: It reads animation settings and the frame requester, creates a delayed loading header, and returns selection-view parameters with one disabled loading row.

**Call relations**: The loading popup opener calls this when `/plugins` starts without ready cache data.

*Call graph*: calls 1 internal fn (new); called by 1 (open_plugins_loading_popup); 3 external calls (new, default, vec!).


##### `ChatWidget::marketplace_add_loading_popup_params`  (lines 1118–1137)

```
fn marketplace_add_loading_popup_params(&self) -> SelectionViewParams
```

**Purpose**: Builds the loading view shown while a new marketplace is being added.

**Data flow**: It creates a delayed loading header and one disabled row explaining that the view will update when installation finishes.

**Call relations**: The marketplace add loading opener calls this after the user submits a marketplace source.

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

**Purpose**: Builds the confirmation screen for removing a marketplace. It includes a remove action and a back action.

**Data flow**: It receives the current plugin response and marketplace names. It creates rows whose actions either request removal or re-send the plugin-loaded event to restore the list; cancel does the same restore.

**Call relations**: The remove confirmation opener calls this after the remove keyboard shortcut is accepted.

*Call graph*: calls 1 internal fn (new); called by 1 (open_marketplace_remove_confirmation); 6 external calls (new, default, from, clone, format!, vec!).


##### `ChatWidget::marketplace_remove_loading_popup_params`  (lines 1213–1234)

```
fn marketplace_remove_loading_popup_params(
        &self,
        marketplace_display_name: &str,
    ) -> SelectionViewParams
```

**Purpose**: Builds the loading view shown while a marketplace is being removed.

**Data flow**: It receives the marketplace display name and returns view parameters with a header and disabled loading row.

**Call relations**: The remove loading opener calls this after the user confirms removal.

*Call graph*: calls 1 internal fn (new); called by 1 (open_marketplace_remove_loading_popup); 5 external calls (new, default, from, format!, vec!).


##### `ChatWidget::marketplace_upgrade_loading_popup_params`  (lines 1236–1259)

```
fn marketplace_upgrade_loading_popup_params(
        &self,
        marketplace_name: Option<&str>,
    ) -> SelectionViewParams
```

**Purpose**: Builds the loading view shown while marketplace upgrades are running.

**Data flow**: It receives an optional marketplace name, chooses singular or general loading text, and returns a disabled loading selection view.

**Call relations**: The upgrade loading opener calls this when the upgrade keyboard shortcut starts backend work.

*Call graph*: calls 1 internal fn (new); called by 1 (open_marketplace_upgrade_loading_popup); 3 external calls (new, default, vec!).


##### `ChatWidget::plugin_detail_loading_popup_params`  (lines 1261–1278)

```
fn plugin_detail_loading_popup_params(&self, plugin_display_name: &str) -> SelectionViewParams
```

**Purpose**: Builds the loading view shown while a plugin detail page is being fetched.

**Data flow**: It receives a plugin display name and returns view parameters with a delayed loading header and disabled row.

**Call relations**: The detail loading opener calls this when a plugin row is selected.

*Call graph*: calls 1 internal fn (new); called by 1 (open_plugin_detail_loading_popup); 4 external calls (new, default, format!, vec!).


##### `ChatWidget::plugin_install_loading_popup_params`  (lines 1280–1301)

```
fn plugin_install_loading_popup_params(
        &self,
        plugin_display_name: &str,
    ) -> SelectionViewParams
```

**Purpose**: Builds the loading view shown while a plugin is installing.

**Data flow**: It receives a plugin display name and returns a selection view with an installing header and one disabled row.

**Call relations**: The install loading opener calls this from the plugin detail install action.

*Call graph*: calls 1 internal fn (new); called by 1 (open_plugin_install_loading_popup); 5 external calls (new, default, from, format!, vec!).


##### `ChatWidget::plugin_uninstall_loading_popup_params`  (lines 1303–1324)

```
fn plugin_uninstall_loading_popup_params(
        &self,
        plugin_display_name: &str,
    ) -> SelectionViewParams
```

**Purpose**: Builds the loading view shown while a plugin is being uninstalled.

**Data flow**: It receives a plugin display name and returns a selection view with an uninstalling header and one disabled row.

**Call relations**: The uninstall loading opener calls this from the plugin detail uninstall action.

*Call graph*: calls 1 internal fn (new); called by 1 (open_plugin_uninstall_loading_popup); 5 external calls (new, default, from, format!, vec!).


##### `ChatWidget::plugins_error_popup_params`  (lines 1326–1342)

```
fn plugins_error_popup_params(&self, err: &str) -> SelectionViewParams
```

**Purpose**: Builds an error view for when the plugin marketplace list cannot be loaded.

**Data flow**: It receives the error message and returns a selection view with a failure header and disabled row containing the error.

**Call relations**: The plugin-list result handler calls this when fetching plugins fails while the popup should be refreshed.

*Call graph*: calls 1 internal fn (new); called by 1 (on_plugins_loaded); 4 external calls (new, default, from, vec!).


##### `ChatWidget::marketplace_add_error_popup_params`  (lines 1344–1392)

```
fn marketplace_add_error_popup_params(&self) -> SelectionViewParams
```

**Purpose**: Builds a retry screen for a failed marketplace add. It may also include a path back to the plugin list if cached data is available.

**Data flow**: It reads current cache, creates a disabled failure row, a Try Again action, and optionally a Back to plugins action that restores the cached list.

**Call relations**: The marketplace-add result handler calls this when adding a marketplace fails.

*Call graph*: calls 3 internal fn (plugins_cache_for_current_cwd, plugin_detail_hint_line, new); called by 1 (on_marketplace_add_loaded); 4 external calls (new, default, from, vec!).


##### `ChatWidget::marketplace_remove_error_popup_params`  (lines 1394–1449)

```
fn marketplace_remove_error_popup_params(
        &self,
        marketplace_name: &str,
        marketplace_display_name: &str,
    ) -> SelectionViewParams
```

**Purpose**: Builds a retry screen for a failed marketplace removal. It lets the user revisit the confirmation prompt or return to plugins.

**Data flow**: It receives marketplace names, reads current cache, and creates rows for the failure, retrying confirmation, and optionally restoring the cached plugin list.

**Call relations**: The marketplace-remove result handler calls this after a failed removal.

*Call graph*: calls 3 internal fn (plugins_cache_for_current_cwd, plugin_detail_hint_line, new); called by 1 (on_marketplace_remove_loaded); 4 external calls (new, default, from, vec!).


##### `ChatWidget::plugin_detail_error_popup_params`  (lines 1451–1489)

```
fn plugin_detail_error_popup_params(
        &self,
        err: &str,
        plugins_response: Option<&PluginListResponse>,
    ) -> SelectionViewParams
```

**Purpose**: Builds an error screen for failures related to plugin details, installation, or uninstallation. It includes a back button when the plugin list is available.

**Data flow**: It receives an error message and optional plugin-list response. It returns a view with a disabled error row and, when possible, an action to restore the plugin list.

**Call relations**: Detail, install, and uninstall result handlers call this when backend work fails.

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

**Purpose**: Builds the main tabbed plugin browser. It turns raw marketplace and plugin data into tabs, rows, search settings, counts, footer hints, and add-marketplace access.

**Data flow**: It receives a plugin-list response, preferred active tab, and optional selected row. It counts installed and total plugins, builds entries for each tab, assigns labels and footer shortcuts, and returns complete selection-view parameters.

**Call relations**: Opening, refreshing, and returning to the plugin list all call this. It uses many small helpers to format names, sort rows, detect user-configured marketplaces, and build row actions.

*Call graph*: calls 9 internal fn (marketplace_add_tab, plugin_selection_items, disambiguate_duplicate_tab_labels, marketplace_is_user_configured, marketplace_is_user_configured_git, marketplace_tab_id, plugin_entries_for_marketplaces, plugins_header, plugins_popup_hint_line); called by 3 (finish_plugin_install_auth_flow, open_plugins_popup, refresh_plugins_popup_if_open); 5 external calls (new, default, width, new, format!).


##### `ChatWidget::marketplace_add_tab`  (lines 1670–1692)

```
fn marketplace_add_tab(&self) -> SelectionTab
```

**Purpose**: Builds the final tab in the plugin browser where users can add another marketplace.

**Data flow**: It returns a tab with explanatory header text and one action row that opens the marketplace source prompt.

**Call relations**: The main plugin popup builder appends this tab after all marketplace tabs.

*Call graph*: calls 1 internal fn (plugins_header); called by 1 (plugins_popup_params); 1 external calls (vec!).


##### `ChatWidget::plugin_detail_popup_params`  (lines 1694–1863)

```
fn plugin_detail_popup_params(
        &self,
        plugins_response: &PluginListResponse,
        plugin: &PluginDetail,
    ) -> SelectionViewParams
```

**Purpose**: Builds the detail page for one plugin. It shows install status, description, disclosure text when relevant, install or uninstall actions, and summaries of what the plugin contains.

**Data flow**: It receives the cached plugin list and a detailed plugin record. It computes labels, builds a header, creates Back, Install, or Uninstall rows as appropriate, and adds read-only summary rows for skills, hooks, apps, and MCP servers.

**Call relations**: The plugin-detail result handler calls this after details load successfully. The action rows send events for install, uninstall, or returning to the list.

*Call graph*: calls 11 internal fn (plugin_app_summary, plugin_detail_description, plugin_detail_hint_line, plugin_detail_location, plugin_display_name, plugin_hook_summary, plugin_mcp_summary, plugin_request_name, plugin_skill_summary, plugin_uninstall_id (+1 more)); called by 1 (on_plugin_detail_loaded); 6 external calls (new, default, from, clone, format!, vec!).


##### `ChatWidget::plugin_selection_items`  (lines 1865–1977)

```
fn plugin_selection_items(
        &self,
        mut plugin_entries: Vec<(&'a PluginMarketplaceEntry, &'a PluginSummary, String)>,
        include_marketplace_names: bool,
        empty_name: &str,
```

**Purpose**: Builds the selectable rows shown in plugin-list tabs. Each row shows status, description, optional enable/disable toggle, and an action to load details when available.

**Data flow**: It receives plugin entries and display options, sorts them, computes aligned status text, creates row descriptions, toggle actions, search text, and detail-fetch actions. If there are no plugins, it returns one disabled empty-state row.

**Call relations**: The main plugin popup builder calls this for the All, Installed, curated, and marketplace-specific tabs.

*Call graph*: calls 6 internal fn (marketplace_display_name, plugin_brief_description, plugin_brief_description_without_marketplace, plugin_detail_request_for_entry, plugin_status_label, sort_plugin_entries); called by 1 (plugins_popup_params); 4 external calls (default, new, format!, vec!).


##### `plugins_popup_hint_line`  (lines 1980–1998)

```
fn plugins_popup_hint_line(
    can_remove_marketplace: bool,
    can_upgrade_marketplace: bool,
) -> Line<'static>
```

**Purpose**: Creates the footer help text for the plugin browser. It changes the shortcuts shown depending on whether the current marketplace can be removed or upgraded.

**Data flow**: It receives two booleans and returns a single line of keyboard instructions.

**Call relations**: The main plugin popup builder uses this for the default footer and for marketplace-specific tab footers.

*Call graph*: called by 1 (plugins_popup_params); 1 external calls (from).


##### `plugin_detail_hint_line`  (lines 2000–2002)

```
fn plugin_detail_hint_line() -> Line<'static>
```

**Purpose**: Creates the simple footer help text used on detail and error screens.

**Data flow**: It takes no input and returns a line telling the user they can press Escape to close.

**Call relations**: Detail, error, and auth popup builders reuse this for consistent footer wording.

*Call graph*: called by 5 (marketplace_add_error_popup_params, marketplace_remove_error_popup_params, plugin_detail_error_popup_params, plugin_detail_popup_params, plugin_install_auth_popup_params); 1 external calls (from).


##### `plugins_header`  (lines 2004–2010)

```
fn plugins_header(subtitle: String, count_line: String) -> Box<dyn Renderable>
```

**Purpose**: Creates the standard three-line header used by plugin-list tabs. It keeps the plugin browser’s title and explanatory text consistent.

**Data flow**: It receives a subtitle and a count line, adds them under a bold Plugins title, and returns a renderable header object.

**Call relations**: The main popup builder and add-marketplace tab builder call this for tab headers.

*Call graph*: calls 1 internal fn (new); called by 2 (marketplace_add_tab, plugins_popup_params); 2 external calls (new, from).


##### `plugin_entries_for_marketplaces`  (lines 2012–2024)

```
fn plugin_entries_for_marketplaces(
    marketplaces: impl IntoIterator<Item = &'a PluginMarketplaceEntry>,
) -> Vec<(&'a PluginMarketplaceEntry, &'a PluginSummary, String)>
```

**Purpose**: Flattens marketplaces into individual plugin rows while keeping each plugin tied to its marketplace. This is the raw material for list tabs.

**Data flow**: It receives marketplaces, walks through their plugin summaries, computes each plugin’s display name, and returns marketplace-plugin-display-name triples.

**Call relations**: The main plugin popup builder calls this for all plugins and for each marketplace-specific tab.

*Call graph*: called by 1 (plugins_popup_params); 1 external calls (into_iter).


##### `sort_plugin_entries`  (lines 2026–2041)

```
fn sort_plugin_entries(entries: &mut [(&PluginMarketplaceEntry, &PluginSummary, String)])
```

**Purpose**: Orders plugin rows so installed plugins appear first, then names are sorted predictably. This makes the list easier to scan.

**Data flow**: It receives a mutable list of plugin entries and rearranges it by installed status, display name, plugin name, and plugin ID.

**Call relations**: The plugin row builder calls this before creating selection items.

*Call graph*: called by 1 (plugin_selection_items); 1 external calls (sort_by).


##### `marketplace_tab_id`  (lines 2043–2048)

```
fn marketplace_tab_id(marketplace: &PluginMarketplaceEntry) -> String
```

**Purpose**: Creates a stable tab ID for a marketplace. Local marketplaces use their path, while remote marketplaces use their marketplace name.

**Data flow**: It receives a marketplace entry and returns a string ID prefixed as a marketplace tab.

**Call relations**: The main popup builder uses this to create and compare marketplace tabs.

*Call graph*: calls 1 internal fn (marketplace_tab_id_from_path); called by 1 (plugins_popup_params); 1 external calls (format!).


##### `marketplace_tab_id_from_path`  (lines 2050–2052)

```
fn marketplace_tab_id_from_path(path: &Path) -> String
```

**Purpose**: Creates a marketplace tab ID from a filesystem path. This lets path-backed marketplaces keep a unique tab identity.

**Data flow**: It receives a path and returns a prefixed string containing that displayed path.

**Call relations**: Marketplace add, marketplace upgrade, and general tab-ID building use this when a marketplace has a local installed root.

*Call graph*: called by 3 (on_marketplace_add_loaded, on_marketplace_upgrade_loaded, marketplace_tab_id); 1 external calls (format!).


##### `marketplace_tab_id_matching_saved_id`  (lines 2054–2077)

```
fn marketplace_tab_id_matching_saved_id(
    saved_tab_id: &str,
    marketplaces: &[PluginMarketplaceEntry],
) -> Option<String>
```

**Purpose**: Finds the current tab ID that best matches a previously saved marketplace tab ID. This helps preserve the selected tab even if a marketplace path changes slightly.

**Data flow**: It receives an old tab ID and the current marketplace list. It first looks for an exact match, then tries to match by path prefix, and returns the new matching tab ID if found.

**Call relations**: The plugin-list result handler uses this when replacing cached marketplace data after a fresh fetch.

*Call graph*: 2 external calls (new, iter).


##### `merge_remote_marketplaces`  (lines 2079–2093)

```
fn merge_remote_marketplaces(
    response: &mut PluginListResponse,
    remote_marketplaces: Vec<PluginMarketplaceEntry>,
)
```

**Purpose**: Replaces old remote marketplace sections in a plugin-list response with newly loaded remote sections. It avoids showing duplicate or stale remote catalogs.

**Data flow**: It receives a mutable plugin-list response and new remote marketplace entries. It removes older remote-section entries or remote entries with the same names, then appends the new ones.

**Call relations**: The remote-section result handler calls this before refreshing the visible plugin popup.

*Call graph*: called by 1 (on_plugin_remote_sections_loaded).


##### `remote_marketplace_is_remote_section`  (lines 2095–2103)

```
fn remote_marketplace_is_remote_section(marketplace: &PluginMarketplaceEntry) -> bool
```

**Purpose**: Recognizes special marketplace names that represent remote workspace sections. These sections are treated differently when refreshing remote data.

**Data flow**: It receives a marketplace entry and returns true if its name matches one of the known remote workspace section names.

**Call relations**: The remote marketplace merge helper uses this to know which old sections can be removed.

*Call graph*: 1 external calls (matches!).


##### `disambiguate_duplicate_tab_labels`  (lines 2105–2140)

```
fn disambiguate_duplicate_tab_labels(labels: Vec<String>) -> Vec<String>
```

**Purpose**: Makes duplicate marketplace tab labels distinct by adding counters like “Name (1/2)”. This prevents two tabs from looking identical.

**Data flow**: It receives labels, counts repeated names, then returns a new label list where repeated labels are numbered in order.

**Call relations**: The main plugin popup builder uses this after sorting additional marketplaces by display name.

*Call graph*: called by 1 (plugins_popup_params); 1 external calls (new).


##### `marketplace_display_name`  (lines 2142–2151)

```
fn marketplace_display_name(marketplace: &PluginMarketplaceEntry) -> String
```

**Purpose**: Chooses the best human-readable name for a marketplace. It prefers a non-empty display name from the marketplace interface, falling back to the internal name.

**Data flow**: It receives a marketplace entry, trims any provided display name, and returns that or the marketplace name.

**Call relations**: The keyboard handler and plugin row builder use this when showing marketplace names to users.

*Call graph*: called by 2 (handle_plugins_popup_key_event, plugin_selection_items).


##### `marketplace_is_user_configured`  (lines 2153–2161)

```
fn marketplace_is_user_configured(config: &Config, marketplace_name: &str) -> bool
```

**Purpose**: Checks whether a marketplace came from the user’s configuration. Only user-configured marketplaces can be removed from this UI.

**Data flow**: It reads the effective user configuration and looks for the marketplace name under the marketplaces table. It returns true if found.

**Call relations**: The main popup builder and keyboard handler use this to decide whether to show and honor the remove shortcut.

*Call graph*: called by 1 (plugins_popup_params).


##### `marketplace_is_user_configured_git`  (lines 2163–2174)

```
fn marketplace_is_user_configured_git(config: &Config, marketplace_name: &str) -> bool
```

**Purpose**: Checks whether a user-configured marketplace is Git-backed. Only Git-backed configured marketplaces can be upgraded.

**Data flow**: It reads the active user config layer, finds the marketplace entry, checks its source_type value, and returns true if it is git.

**Call relations**: The main popup builder and keyboard handler use this to decide whether to show and honor the upgrade shortcut.

*Call graph*: called by 2 (handle_plugins_popup_key_event, plugins_popup_params).


##### `plugin_display_name`  (lines 2176–2185)

```
fn plugin_display_name(plugin: &PluginSummary) -> String
```

**Purpose**: Chooses the best human-readable name for a plugin. It prefers a non-empty interface display name, falling back to the plugin’s internal name.

**Data flow**: It receives a plugin summary, trims any provided display name, and returns that or the plugin name.

**Call relations**: Plugin entry building and detail-page building use this whenever a plugin name is shown to the user.

*Call graph*: called by 1 (plugin_detail_popup_params).


##### `plugin_brief_description`  (lines 2187–2198)

```
fn plugin_brief_description(
    plugin: &PluginSummary,
    marketplace_label: &str,
    status_label_width: usize,
) -> String
```

**Purpose**: Builds the one-line description used when a plugin row should include its marketplace name.

**Data flow**: It receives a plugin summary, marketplace label, and status-column width. It formats the status label, marketplace label, and optional plugin description into one readable string.

**Call relations**: The plugin row builder uses this for tabs that combine plugins from multiple marketplaces.

*Call graph*: calls 2 internal fn (plugin_description, plugin_status_label); called by 1 (plugin_selection_items); 1 external calls (format!).


##### `plugin_brief_description_without_marketplace`  (lines 2200–2210)

```
fn plugin_brief_description_without_marketplace(
    plugin: &PluginSummary,
    status_label_width: usize,
) -> String
```

**Purpose**: Builds the one-line description used when the current tab already identifies the marketplace. This avoids repeating the same marketplace name on every row.

**Data flow**: It receives a plugin summary and status-column width. It formats the status label and optional plugin description into one string.

**Call relations**: The plugin row builder uses this for marketplace-specific tabs and the curated tab.

*Call graph*: calls 2 internal fn (plugin_description, plugin_status_label); called by 1 (plugin_selection_items); 1 external calls (format!).


##### `plugin_status_label`  (lines 2212–2229)

```
fn plugin_status_label(plugin: &PluginSummary) -> &'static str
```

**Purpose**: Turns plugin availability and install state into a short user-facing status label, such as Installed, Disabled, or Not installable.

**Data flow**: It reads whether the plugin is disabled by admin, installed, enabled, and installable. It returns the matching static text label.

**Call relations**: Plugin row descriptions and selected-row help text use this status label.

*Call graph*: called by 3 (plugin_selection_items, plugin_brief_description, plugin_brief_description_without_marketplace).


##### `plugin_location_for_marketplace`  (lines 2231–2241)

```
fn plugin_location_for_marketplace(
    marketplace: &PluginMarketplaceEntry,
    plugin: &PluginSummary,
) -> Option<PluginLocation>
```

**Purpose**: Figures out where a plugin should be requested from when the user wants details. It distinguishes local path marketplaces from remote marketplaces.

**Data flow**: It receives a marketplace entry and plugin summary. If the marketplace has a path, it returns a local location; otherwise it returns a remote location only if the plugin has a remote identity.

**Call relations**: The detail-request helper calls this when building plugin row actions.

*Call graph*: calls 1 internal fn (plugin_remote_identity); called by 1 (plugin_detail_request_for_entry).


##### `plugin_detail_location`  (lines 2243–2250)

```
fn plugin_detail_location(plugin: &PluginDetail) -> Option<PluginLocation>
```

**Purpose**: Figures out where an install request should target from a full plugin detail record. It uses a local marketplace path when available, otherwise remote identity.

**Data flow**: It receives plugin detail data and returns either a local location, a remote location, or no location if the plugin cannot be identified.

**Call relations**: The plugin detail page builder calls this before adding an enabled Install action.

*Call graph*: calls 1 internal fn (plugin_remote_identity); called by 1 (plugin_detail_popup_params).


##### `plugin_detail_request_for_entry`  (lines 2252–2258)

```
fn plugin_detail_request_for_entry(
    marketplace: &PluginMarketplaceEntry,
    plugin: &PluginSummary,
) -> Option<(PluginLocation, String)>
```

**Purpose**: Creates the information needed to fetch full details for a plugin row. It combines the plugin’s marketplace location with the correct request name.

**Data flow**: It receives a marketplace and plugin summary. If a location can be found, it returns that location plus the request name; otherwise it returns nothing.

**Call relations**: The plugin row builder calls this to decide whether pressing Enter can load details.

*Call graph*: calls 1 internal fn (plugin_location_for_marketplace); called by 1 (plugin_selection_items).


##### `plugin_request_name`  (lines 2260–2267)

```
fn plugin_request_name(plugin: &PluginSummary) -> String
```

**Purpose**: Chooses the plugin name to send to backend requests. Remote plugins may need their remote plugin ID instead of their local display or package name.

**Data flow**: It receives a plugin summary. If the plugin is remote and has a remote identity, it returns that identity; otherwise it returns the plugin name.

**Call relations**: Detail and install actions use this so backend requests address the correct plugin.

*Call graph*: calls 1 internal fn (plugin_remote_identity); called by 1 (plugin_detail_popup_params); 1 external calls (matches!).


##### `plugin_remote_identity`  (lines 2269–2275)

```
fn plugin_remote_identity(plugin: &PluginSummary) -> Option<String>
```

**Purpose**: Finds the remote identity for a plugin, if one exists. It supports both the newer shared-context field and the older direct remote ID field.

**Data flow**: It receives a plugin summary and returns the remote plugin ID from share context or from the summary itself.

**Call relations**: Location, request-name, and uninstall-ID helpers use this whenever remote plugins need a stable backend identifier.

*Call graph*: called by 4 (plugin_detail_location, plugin_location_for_marketplace, plugin_request_name, plugin_uninstall_id).


##### `plugin_uninstall_id`  (lines 2277–2282)

```
fn plugin_uninstall_id(plugin: &PluginSummary) -> Option<String>
```

**Purpose**: Chooses the identifier to use when uninstalling a plugin. Remote plugins need their remote identity, while local plugins can use their normal ID.

**Data flow**: It receives a plugin summary. It returns a remote ID for remote plugins, or the plugin ID for local plugins.

**Call relations**: The plugin detail page builder calls this before enabling the Uninstall action.

*Call graph*: calls 1 internal fn (plugin_remote_identity); called by 1 (plugin_detail_popup_params); 1 external calls (matches!).


##### `plugin_description`  (lines 2284–2297)

```
fn plugin_description(plugin: &PluginSummary) -> Option<String>
```

**Purpose**: Extracts a short description for a plugin list row. It prefers the short description and falls back to the long description.

**Data flow**: It receives a plugin summary, reads interface description fields, trims whitespace, and returns a non-empty description if available.

**Call relations**: Brief description helpers call this when building plugin row text.

*Call graph*: called by 2 (plugin_brief_description, plugin_brief_description_without_marketplace).


##### `plugin_detail_description`  (lines 2299–2320)

```
fn plugin_detail_description(plugin: &PluginDetail) -> Option<String>
```

**Purpose**: Extracts the best description for a plugin detail page. It prefers the detail record’s description, then long summary text, then short summary text.

**Data flow**: It receives plugin detail data, checks description fields in priority order, trims whitespace, and returns a non-empty string if available.

**Call relations**: The plugin detail popup builder calls this to add descriptive text under the header.

*Call graph*: called by 1 (plugin_detail_popup_params).


##### `plugin_skill_summary`  (lines 2322–2333)

```
fn plugin_skill_summary(plugin: &PluginDetail) -> String
```

**Purpose**: Summarizes the skills included in a plugin. A skill is a named capability the plugin provides.

**Data flow**: It receives plugin detail data. If there are no skills it returns a “No plugin skills” message; otherwise it joins skill names with commas.

**Call relations**: The plugin detail page builder uses this for its read-only Skills row.

*Call graph*: called by 1 (plugin_detail_popup_params).


##### `plugin_app_summary`  (lines 2335–2346)

```
fn plugin_app_summary(plugin: &PluginDetail) -> String
```

**Purpose**: Summarizes the ChatGPT apps bundled or required by a plugin.

**Data flow**: It receives plugin detail data. If there are no apps it returns a “No plugin apps” message; otherwise it joins app names with commas.

**Call relations**: The plugin detail page builder uses this for its read-only Apps row.

*Call graph*: called by 1 (plugin_detail_popup_params).


##### `plugin_hook_summary`  (lines 2348–2369)

```
fn plugin_hook_summary(plugin: &PluginDetail) -> String
```

**Purpose**: Summarizes plugin hooks by event type. A hook is code that runs when a certain event happens.

**Data flow**: It receives plugin detail data. If there are no hooks it returns a no-hooks message; otherwise it counts handlers for each event name and returns a comma-separated summary.

**Call relations**: The plugin detail page builder uses this for its read-only Hooks row.

*Call graph*: called by 1 (plugin_detail_popup_params); 1 external calls (new).


##### `plugin_mcp_summary`  (lines 2371–2377)

```
fn plugin_mcp_summary(plugin: &PluginDetail) -> String
```

**Purpose**: Summarizes MCP servers provided by a plugin. MCP means Model Context Protocol, a way for tools and data sources to connect to an AI assistant.

**Data flow**: It receives plugin detail data. If there are no MCP servers it returns a no-servers message; otherwise it joins the server names with commas.

**Call relations**: The plugin detail page builder uses this for its read-only MCP Servers row.

*Call graph*: called by 1 (plugin_detail_popup_params).
