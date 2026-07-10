# App-server integration suites — plugins, marketplace, MCP, and tool/executor integrations  `stage-23.1.4.3`

This stage is a big safety net for the app server’s extension points: the places where outside add-ons, tools, and command runners plug into the system. It sits around the main work loop, checking that once the server is running, it can discover, install, use, and remove extra capabilities correctly.

The plugin and marketplace tests cover the full plugin life cycle: listing catalogs, reading plugin details and skills, adding or removing marketplaces, upgrading them, installing plugins, sharing them with a backend service, and uninstalling them cleanly. The app, hooks, and skills tests check what the server can discover from local files, project settings, plugins, and remote sources, and whether updates and caches behave properly.

Another group focuses on MCP, a protocol for external tool and resource servers. These tests check server status, direct tool calls, user-confirmation requests, resource reads, and executor-scoped behavior so one thread sees only the tools it selected. The command and shell tests verify running local commands safely, with streaming output, approvals, and special shell modes. Finally, extension-backed tools like image generation, sleep, web search, and fuzzy file search are tested end to end.

## Files in this stage

### Plugin catalog and lifecycle
These suites cover discovering plugins and marketplaces, reading plugin details, installing and removing plugins, sharing them, and upgrading or deleting marketplace-backed content.

### `app-server/tests/suite/v2/plugin_list.rs`

`test` · `startup and request handling`

This file is the broad integration suite for plugin discovery. It covers `plugin/list` and `plugin/installed` behavior for local repository marketplaces, home-curated marketplaces under `.tmp/plugins`, remote curated catalogs fetched from ChatGPT backend endpoints, workspace-shared and user-created remote plugins, and startup/background synchronization of remote installed bundles. The tests create isolated homes and repositories, write marketplace manifests and plugin manifests directly to disk, and use `wiremock::MockServer` to emulate backend endpoints such as `/ps/plugins/list`, `/ps/plugins/installed`, `/ps/plugins/workspace/shared`, `/plugins/featured`, and account settings.

A recurring pattern is to start `TestAppServer`, initialize it under timeout, send a typed request, deserialize the `JSONRPCResponse`, and assert on `PluginMarketplaceEntry`, `PluginSummary`, and `featured_plugin_ids`. The suite checks many subtle invariants: invalid marketplace files are skipped but reported in `marketplace_load_errors`; home config, not project config, controls enabled state for shared curated plugins; alternate discoverable manifest paths (`.claude-plugin/...`) are accepted; legacy string `defaultPrompt` is normalized into a one-element vector; cached installed git-source plugin interfaces are read from cache without cloning; remote curated conflicts suppress local curated duplicates when remote plugins are enabled; explicit marketplace kinds prevent implicit global remote catalogs; API-key auth skips ChatGPT-only remote collections but still exposes API-curated local marketplaces; and remote plugin availability `DISABLED_BY_ADMIN` is preserved in summaries.

The helper section writes config files, curated marketplaces, installed-plugin cache directories, plugin-share local-path mappings, remote plugin list/installed fixtures, and tar.gz bundles. Polling helpers wait for exact backend request counts, remote installed-scope fetches, cache contents, and filesystem appearance/disappearance so tests can assert asynchronous startup sync and bundle upgrade/removal behavior deterministically.

#### Function details

##### `write_plugins_enabled_config`  (lines 49–56)

```
fn write_plugins_enabled_config(codex_home: &std::path::Path) -> std::io::Result<()>
```

**Purpose**: Writes the minimal config enabling plugins for local marketplace tests. It is the simplest setup helper in the file.

**Data flow**: Joins `config.toml` under `codex_home` and writes a TOML string containing only `[features] plugins = true`. It returns the filesystem write result.

**Call relations**: Many local-only plugin list tests call this helper before starting `TestAppServer`. It enables plugin discovery without configuring any remote backend.

*Call graph*: called by 7 (plugin_list_accepts_legacy_string_default_prompt, plugin_list_accepts_omitted_cwds, plugin_list_keeps_valid_marketplaces_when_another_marketplace_fails_to_load, plugin_list_returns_plugin_interface_with_absolute_asset_paths, plugin_list_returns_share_context_for_shared_local_plugin, plugin_list_skips_invalid_marketplace_file_and_reports_error, plugin_list_uses_alternate_discoverable_manifest_and_keeps_undiscoverable_plugins); 2 external calls (join, write).


##### `write_plugins_enabled_config_with_base_url`  (lines 58–72)

```
fn write_plugins_enabled_config_with_base_url(
    codex_home: &std::path::Path,
    base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes config enabling plugins and pointing ChatGPT backend requests at a supplied base URL. It is used when plugin listing needs workspace settings or remote backend endpoints.

**Data flow**: Formats a TOML string with `chatgpt_base_url = "{base_url}"` and `[features] plugins = true`, writes it to `codex_home/config.toml`, and returns `std::io::Result<()>`.

**Call relations**: Tests that need backend calls but not full remote-plugin enablement use this helper. It is the common setup for workspace-settings and explicit remote-collection request tests.

*Call graph*: called by 8 (plugin_list_does_not_query_openai_curated_remote_collection_by_default, plugin_list_fetches_shared_with_me_kind, plugin_list_fetches_workspace_directory_kind_without_remote_plugin_flag, plugin_list_includes_openai_curated_remote_collection_when_requested, plugin_list_propagates_explicit_openai_curated_remote_collection_errors, plugin_list_returns_empty_when_workspace_codex_plugins_disabled, plugin_list_reuses_cached_workspace_codex_plugins_setting, plugin_list_skips_explicit_openai_curated_remote_collection_for_api_auth); 3 external calls (join, format!, write).


##### `plugin_list_skips_invalid_marketplace_file_and_reports_error`  (lines 75–130)

```
async fn plugin_list_skips_invalid_marketplace_file_and_reports_error() -> Result<()>
```

**Purpose**: Verifies that an invalid local marketplace file is omitted from the returned marketplace list but reported in `marketplace_load_errors`. It ensures one bad file does not fail the whole request.

**Data flow**: Creates temp home and repo root, creates `.git` and `.agents/plugins`, enables plugins, writes malformed JSON to the absolute marketplace path, starts `TestAppServer` with `HOME` and `USERPROFILE` pointing at the temp home, initializes it, sends `PluginListParams` with the repo cwd, deserializes `PluginListResponse`, and asserts no returned marketplace references the invalid path while exactly one load error names that path and contains `invalid marketplace file`.

**Call relations**: This test covers tolerant local marketplace discovery. It uses environment overrides so home-directory scanning behaves predictably and focuses on error reporting rather than endpoint failure.

*Call graph*: calls 3 internal fn (new_with_env, write_plugins_enabled_config, try_from); 9 external calls (new, Integer, to_response, assert!, assert_eq!, create_dir_all, write, timeout, vec!).


##### `plugin_installed_includes_installed_plugins_and_explicit_install_suggestions`  (lines 133–183)

```
async fn plugin_installed_includes_installed_plugins_and_explicit_install_suggestions() -> Result<()>
```

**Purpose**: Checks that `plugin/installed` returns actually installed curated plugins plus explicitly requested install suggestions from the same marketplace. It verifies installed/enabled flags are merged with suggestion filtering.

**Data flow**: Creates temp home, writes an OpenAI curated marketplace containing `linear`, `computer-use`, and `not-mentioned`, writes an installed cache entry for `linear`, writes config enabling plugins and `linear@openai-curated`, starts and initializes the server, sends `PluginInstalledParams` with `install_suggestion_plugin_names: Some(["computer-use"])`, deserializes `PluginInstalledResponse`, and asserts the single marketplace contains `linear` as installed/enabled and `computer-use` as not installed/not enabled, with no load errors.

**Call relations**: This test exercises the installed-plugin endpoint's curated-marketplace path and explicit suggestion filtering. It relies on curated marketplace and installed-cache fixture helpers rather than remote backend mocks.

*Call graph*: calls 3 internal fn (new, write_installed_plugin, write_openai_curated_marketplace); 7 external calls (new, Integer, to_response, assert_eq!, write, timeout, vec!).


##### `plugin_installed_prefers_remote_curated_conflicts_when_remote_plugin_enabled`  (lines 186–285)

```
async fn plugin_installed_prefers_remote_curated_conflicts_when_remote_plugin_enabled() -> Result<()>
```

**Purpose**: Verifies that when remote curated plugins are enabled, remote installed entries win over conflicting local curated cache entries of the same plugin names. It prevents duplicate or stale local curated entries from shadowing remote truth.

**Data flow**: Creates temp home and mock server, writes a local OpenAI curated marketplace and local installed cache entries for `linear` and `calendar`, writes config enabling plugins and remote plugins with both local plugins enabled, writes ChatGPT auth, constructs a remote installed body containing `linear` plus a remote-only plugin, mounts remote installed responses for `GLOBAL` and empty `WORKSPACE`, mounts empty user-installed plugins, starts and initializes the server, sends `plugin/installed`, deserializes the response, and asserts the local `openai-curated` marketplace now contains only `calendar` while the remote `openai-curated-remote` marketplace contains `linear` and `remote-only`.

**Call relations**: This test spans both local curated and remote installed sources. It proves the endpoint resolves conflicts in favor of remote curated state when that feature is enabled.

*Call graph*: calls 8 internal fn (new, new, empty_remote_installed_plugins_body, mount_empty_user_installed_plugins, mount_remote_installed_plugins, remote_installed_plugin_body, write_installed_plugin, write_openai_curated_marketplace); 12 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, from_str, json!, to_string (+2 more)).


##### `plugin_installed_ignores_local_cache_without_catalog`  (lines 288–321)

```
async fn plugin_installed_ignores_local_cache_without_catalog() -> Result<()>
```

**Purpose**: Checks that installed cache directories alone do not create installed-plugin entries when no corresponding marketplace catalog exists. It enforces catalog-driven visibility.

**Data flow**: Creates temp home, writes an installed cache entry for `linear@openai-curated`, writes config enabling plugins and that plugin id, starts and initializes the server, sends `plugin/installed`, deserializes the response, and asserts both `marketplaces` and `marketplace_load_errors` are empty.

**Call relations**: This test isolates the installed-cache lookup rule by omitting any marketplace manifest. It confirms the endpoint does not infer plugin metadata solely from cache directories.

*Call graph*: calls 2 internal fn (new, write_installed_plugin); 6 external calls (new, Integer, to_response, assert_eq!, write, timeout).


##### `plugin_list_rejects_relative_cwds`  (lines 324–347)

```
async fn plugin_list_rejects_relative_cwds() -> Result<()>
```

**Purpose**: Ensures raw `plugin/list` requests with relative cwd paths are rejected as invalid requests. It validates absolute-path requirements on request parameters.

**Data flow**: Starts an empty server, sends a raw `plugin/list` request with `cwds: ["relative-root"]`, waits for the error response, and asserts code `-32600` with an `Invalid request` message fragment.

**Call relations**: This is a request-validation test using `send_raw_request` to bypass typed absolute-path wrappers. It fails before any marketplace scanning occurs.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Integer, assert!, assert_eq!, json!, timeout).


##### `plugin_list_keeps_valid_marketplaces_when_another_marketplace_fails_to_load`  (lines 350–469)

```
async fn plugin_list_keeps_valid_marketplaces_when_another_marketplace_fails_to_load() -> Result<()>
```

**Purpose**: Verifies that one invalid marketplace file does not suppress another valid marketplace from the same request. It also checks that plugin metadata from the valid marketplace is still fully populated.

**Data flow**: Creates temp home plus separate valid and invalid repo roots, prepares `.git` and `.agents/plugins` directories, enables plugins, computes absolute marketplace and plugin paths, writes a valid marketplace JSON and plugin manifest with keywords, writes malformed JSON to the invalid marketplace path, starts `TestAppServer` with home env overrides, initializes it, sends `plugin/list` with both repo roots as cwds, deserializes `PluginListResponse`, and asserts the response contains exactly one `PluginMarketplaceEntry` for the valid marketplace with a fully populated `PluginSummary`, one load error for the invalid path, and no featured plugin ids.

**Call relations**: This test extends the invalid-marketplace case to mixed success/failure input. It proves the endpoint aggregates per-marketplace results instead of failing atomically.

*Call graph*: calls 3 internal fn (new_with_env, write_plugins_enabled_config, try_from); 9 external calls (new, Integer, to_response, assert!, assert_eq!, create_dir_all, write, timeout, vec!).


##### `plugin_list_returns_empty_when_workspace_codex_plugins_disabled`  (lines 472–553)

```
async fn plugin_list_returns_empty_when_workspace_codex_plugins_disabled() -> Result<()>
```

**Purpose**: Checks that local plugin listing returns no marketplaces when workspace settings disable Codex plugins for the authenticated ChatGPT account. It validates workspace policy gating on list, not just install.

**Data flow**: Creates temp home and repo root, starts a mock backend, prepares a local marketplace file, writes config enabling plugins with backend base URL, writes ChatGPT auth for a team plan account, mounts `/backend-api/accounts/account-123/settings` returning `enable_plugins: false`, starts `TestAppServer` without managed config and with home env overrides, initializes it, sends `plugin/list` for the repo cwd, deserializes the response, and asserts it equals an empty `PluginListResponse`.

**Call relations**: This test covers the workspace-settings gate in the list path. It uses backend settings mocks and the unmanaged-config server startup variant so the request reflects the written config directly.

*Call graph*: calls 3 internal fn (new, new_without_managed_config_with_env, write_plugins_enabled_config_with_base_url); 16 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, create_dir_all (+6 more)).


##### `plugin_list_reuses_cached_workspace_codex_plugins_setting`  (lines 556–641)

```
async fn plugin_list_reuses_cached_workspace_codex_plugins_setting() -> Result<()>
```

**Purpose**: Verifies that the workspace plugin-enabled setting fetched from the backend is cached and reused across repeated list requests. It ensures the server does not refetch account settings on every call.

**Data flow**: Creates temp home and repo root, starts a mock backend, prepares a valid local marketplace and plugin manifest, writes config enabling plugins with backend base URL, writes ChatGPT auth, mounts one successful account-settings response with `enable_plugins: true`, starts `TestAppServer` without managed config and with home env overrides, initializes it, then performs two identical `plugin/list` requests for the same cwd and asserts each returns one marketplace named `local-marketplace`. Finally it waits for exactly one `/accounts/account-123/settings` request.

**Call relations**: This test drives the same endpoint twice to observe caching behavior across requests. It delegates the backend-count assertion to `wait_for_workspace_settings_request_count`.

*Call graph*: calls 4 internal fn (new, new_without_managed_config_with_env, wait_for_workspace_settings_request_count, write_plugins_enabled_config_with_base_url); 16 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, create_dir_all (+6 more)).


##### `plugin_list_uses_alternate_discoverable_manifest_and_keeps_undiscoverable_plugins`  (lines 644–786)

```
async fn plugin_list_uses_alternate_discoverable_manifest_and_keeps_undiscoverable_plugins() -> Result<()>
```

**Purpose**: Checks support for alternate discoverable manifest locations (`.claude-plugin/...`) while still retaining marketplace entries whose plugin source directories are missing. It verifies discovery and non-pruning behavior together.

**Data flow**: Creates temp home and repo root, prepares `.git`, alternate marketplace directory, and alternate plugin manifest directory, enables plugins, computes absolute marketplace and plugin paths, writes an alternate marketplace JSON listing `valid-plugin` and `missing-plugin`, writes an alternate plugin manifest for `valid-plugin` with interface display name, starts `TestAppServer` with home env overrides, initializes it, sends `plugin/list` for the repo cwd, deserializes the response, and asserts the returned marketplace contains both plugin summaries: one with interface metadata from the alternate manifest and one unresolved local path entry for the missing plugin.

**Call relations**: This test covers compatibility with alternate manifest conventions and the design choice not to drop marketplace entries just because their source bundle is absent.

*Call graph*: calls 3 internal fn (new_with_env, write_plugins_enabled_config, try_from); 9 external calls (new, Integer, to_response, assert!, assert_eq!, create_dir_all, write, timeout, vec!).


##### `plugin_list_accepts_omitted_cwds`  (lines 789–833)

```
async fn plugin_list_accepts_omitted_cwds() -> Result<()>
```

**Purpose**: Verifies that `plugin/list` works when `cwds` is omitted entirely, falling back to home-directory marketplace discovery. It checks the endpoint's default search behavior.

**Data flow**: Creates temp home, creates `.agents/plugins`, enables plugins, writes a home marketplace JSON under the home directory, starts `TestAppServer` with `HOME` and `USERPROFILE` pointing at the temp home, initializes it, sends `PluginListParams { cwds: None, marketplace_kinds: None }`, waits for the response, and successfully deserializes it into `PluginListResponse` without asserting specific contents beyond successful parsing.

**Call relations**: This test covers the no-cwd branch of marketplace discovery. It relies on environment overrides so the home directory used by the server matches the temp fixture directory.

*Call graph*: calls 2 internal fn (new_with_env, write_plugins_enabled_config); 6 external calls (new, Integer, to_response, create_dir_all, write, timeout).


##### `plugin_list_returns_share_context_for_shared_local_plugin`  (lines 836–906)

```
async fn plugin_list_returns_share_context_for_shared_local_plugin() -> Result<()>
```

**Purpose**: Checks that a local plugin whose path is mapped to a remote shared plugin id gains a `share_context` in list results. It verifies local-to-remote share metadata projection.

**Data flow**: Creates temp home and repo root, prepares a local marketplace and plugin manifest with version `1.2.3`, enables plugins, writes a plugin-share local-path mapping from remote id `plugins_123` to the plugin path, starts and initializes the server, sends `plugin/list` for the repo cwd, deserializes the response, finds the `demo-plugin` summary, and asserts `remote_plugin_id` is `None`, `local_version` is `Some("1.2.3")`, and `share_context` contains the mapped remote id with all remote-only fields absent.

**Call relations**: This test covers the local share-mapping enrichment path. It depends on `write_plugin_share_local_path_mapping` to seed the `.tmp/plugin-share-local-paths-v1.json` file the server reads.

*Call graph*: calls 4 internal fn (new, write_plugin_share_local_path_mapping, write_plugins_enabled_config, try_from); 8 external calls (new, Integer, to_response, assert_eq!, create_dir_all, write, timeout, vec!).


##### `plugin_list_includes_install_and_enabled_state_from_config`  (lines 909–1041)

```
async fn plugin_list_includes_install_and_enabled_state_from_config() -> Result<()>
```

**Purpose**: Verifies that list results merge installed-cache presence with per-plugin enabled flags from config. It checks installed/enabled combinations for installed-enabled, installed-disabled, and uninstalled plugins in one marketplace.

**Data flow**: Creates temp home and repo root, prepares `.git` and `.agents/plugins`, writes installed cache entries for `enabled-plugin` and `disabled-plugin`, writes a marketplace JSON with three plugins and marketplace interface display name, writes config enabling plugins and setting explicit enabled flags for the first two plugin ids, starts and initializes the server, sends `plugin/list` for the repo cwd, deserializes the response, selects the repo marketplace by absolute path, and asserts marketplace/interface metadata plus each plugin's `installed`, `enabled`, `install_policy`, and `auth_policy` fields.

**Call relations**: This test is the main local-state merge check for `plugin/list`. It combines marketplace metadata, installed cache, and config state in a single assertion-heavy scenario.

*Call graph*: calls 2 internal fn (new, write_installed_plugin); 8 external calls (new, Integer, to_response, assert_eq!, create_dir_all, write, timeout, vec!).


##### `plugin_list_uses_home_config_for_enabled_state`  (lines 1044–1145)

```
async fn plugin_list_uses_home_config_for_enabled_state() -> Result<()>
```

**Purpose**: Checks that enabled-state resolution for shared curated plugins comes from home config rather than trusted project config overrides. It prevents workspace-local config from shadowing home-level plugin enablement in this case.

**Data flow**: Creates temp home, writes a home marketplace and installed cache entry for `shared-plugin`, writes home config enabling that plugin, creates one trusted workspace with its own marketplace and `.codex/config.toml` disabling the same plugin id, marks that workspace trusted, creates a second workspace with no override, starts `TestAppServer` with home env overrides, initializes it, sends `plugin/list` with both workspace paths as cwds, deserializes the response, finds `shared-plugin`, and asserts it is still `installed: true` and `enabled: true`.

**Call relations**: This test spans home config, trusted project config, and multi-cwd listing. It specifically targets precedence rules for enabled-state computation.

*Call graph*: calls 3 internal fn (new_with_env, write_installed_plugin, set_project_trust_level); 8 external calls (new, Integer, to_response, assert_eq!, create_dir_all, write, timeout, vec!).


##### `plugin_list_returns_plugin_interface_with_absolute_asset_paths`  (lines 1148–1279)

```
async fn plugin_list_returns_plugin_interface_with_absolute_asset_paths() -> Result<()>
```

**Purpose**: Verifies that plugin interface asset paths from a local manifest are resolved to absolute filesystem paths and that marketplace category overrides plugin-manifest category. It checks rich interface metadata mapping.

**Data flow**: Creates temp home and repo root, prepares a local plugin manifest with interface fields including display names, URLs, prompts, brand color, and relative asset paths, writes a marketplace JSON whose plugin entry sets category `Design`, enables plugins, starts and initializes the server, sends `plugin/list`, deserializes the response, finds `demo-plugin`, and asserts summary fields plus interface fields including absolute `composer_icon`, `logo`, and `screenshots` paths rooted under the plugin directory.

**Call relations**: This test covers local manifest parsing and path canonicalization in list results. It demonstrates that marketplace metadata can override manifest category while other interface fields come from the plugin bundle.

*Call graph*: calls 2 internal fn (new, write_plugins_enabled_config); 8 external calls (new, Integer, to_response, assert_eq!, create_dir_all, write, timeout, vec!).


##### `plugin_list_accepts_legacy_string_default_prompt`  (lines 1282–1346)

```
async fn plugin_list_accepts_legacy_string_default_prompt() -> Result<()>
```

**Purpose**: Checks that a legacy string-valued `defaultPrompt` in a local plugin manifest is normalized into a one-element `default_prompt` vector in list results.

**Data flow**: Creates temp home and repo root, prepares a local marketplace and plugin manifest whose interface contains `defaultPrompt` as a string, enables plugins, starts and initializes the server, sends `plugin/list`, deserializes the response, finds `demo-plugin`, and asserts its interface `default_prompt` equals `Some(vec!["Starter prompt for trying a plugin"])`.

**Call relations**: This test covers backward-compatible manifest parsing for local plugins. It is the list-side counterpart to a similar plugin-read test.

*Call graph*: calls 2 internal fn (new, write_plugins_enabled_config); 8 external calls (new, Integer, to_response, assert_eq!, create_dir_all, write, timeout, vec!).


##### `plugin_list_returns_installed_git_source_interface_from_cache`  (lines 1349–1464)

```
async fn plugin_list_returns_installed_git_source_interface_from_cache() -> Result<()>
```

**Purpose**: Verifies that for an installed git-source plugin whose remote repository is unavailable, the server still describes the plugin using cached bundle metadata without cloning. It checks source preservation and cached interface loading.

**Data flow**: Creates temp home and repo root, constructs a file URL to a nonexistent remote repo, writes a marketplace JSON with a `git-subdir` source, writes a cached installed plugin manifest under `plugins/cache/debug/toolkit/local/.codex-plugin/plugin.json` containing interface metadata, writes config enabling `toolkit@debug`, starts and initializes the server, sends `plugin/list`, deserializes the response, finds `toolkit`, and asserts it is installed/enabled, its `PluginSource::Git` fields match the marketplace source, and its interface fields come from the cached plugin manifest with asset paths resolved under the canonicalized cache directory.

**Call relations**: This test covers the installed-git fallback path where the source repo is not cloned or reachable. It proves the endpoint can still present rich metadata from cache.

*Call graph*: calls 1 internal fn (new); 11 external calls (new, Integer, to_response, assert_eq!, format!, canonicalize, create_dir_all, write, timeout, from_directory_path (+1 more)).


##### `app_server_startup_sync_downloads_remote_installed_plugin_bundles`  (lines 1467–1532)

```
async fn app_server_startup_sync_downloads_remote_installed_plugin_bundles() -> Result<()>
```

**Purpose**: Checks that plugin startup tasks proactively download bundles for already-installed remote plugins during app-server initialization. It validates asynchronous startup synchronization rather than request-triggered sync.

**Data flow**: Creates temp home and mock server, writes remote-plugin config/auth, mounts a bundle download for `linear`, builds a remote installed body with version `1.2.3` and an app manifest, mounts remote installed responses for `GLOBAL` and empty `WORKSPACE`, mounts empty user-installed plugins, computes the expected installed cache path, starts `TestAppServer` with plugin startup tasks and the HTTP-download override, initializes it, waits for `.codex-plugin/plugin.json` to appear under the cache path, reads and asserts the installed plugin manifest version and `.app.json` contents, checks the bundled skill file exists, and asserts `config.toml` was not mutated to add a plugin entry.

**Call relations**: This test covers background startup work rather than an explicit plugin-list/install request. It uses `wait_for_path_exists` to synchronize with asynchronous bundle download and extraction.

*Call graph*: calls 10 internal fn (new, new_with_env_and_plugin_startup_tasks, empty_remote_installed_plugins_body, mount_empty_user_installed_plugins, mount_remote_installed_plugins, mount_remote_plugin_bundle, remote_installed_plugin_body_with_app_manifest, remote_plugin_bundle_tar_gz_bytes, wait_for_path_exists, write_remote_plugin_catalog_config); 10 external calls (start, new, write_chatgpt_auth, assert!, assert_eq!, format!, from_str, json!, read_to_string, timeout).


##### `plugin_list_sync_upgrades_and_removes_remote_installed_plugin_bundles`  (lines 1535–1638)

```
async fn plugin_list_sync_upgrades_and_removes_remote_installed_plugin_bundles() -> Result<()>
```

**Purpose**: Verifies that a `plugin/list` request triggers remote installed-bundle synchronization that upgrades outdated bundles and removes stale ones. It checks both additive and cleanup behavior on disk.

**Data flow**: Creates temp home and mock server, writes remote-plugin config/auth, seeds local installed cache directories for `linear` version `1.0.0` and stale plugin `stale`, mounts a bundle download for `linear`, mounts remote plugin list and installed responses showing only `linear` version `1.2.3` with an app manifest, mounts empty user-installed plugins, computes old/new/stale cache paths, starts and initializes the server with HTTP downloads allowed, sends `plugin/list`, deserializes the response and asserts the remote marketplace reports `linear` as installed/enabled, then waits for the new bundle path to appear, verifies manifest version and app manifest contents, and waits for the old and stale paths to disappear. It also asserts config was not mutated.

**Call relations**: This test ties request-time remote catalog listing to background cache reconciliation. It uses both remote list and installed fixtures plus filesystem polling helpers to observe upgrade/removal side effects.

*Call graph*: calls 13 internal fn (new, new_with_env, empty_remote_installed_plugins_body, mount_empty_user_installed_plugins, mount_remote_installed_plugins, mount_remote_plugin_bundle, mount_remote_plugin_list, remote_installed_plugin_body_with_app_manifest, remote_plugin_bundle_tar_gz_bytes, wait_for_path_exists (+3 more)); 12 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, format!, from_str, json! (+2 more)).


##### `plugin_list_includes_remote_marketplaces_when_remote_plugin_enabled`  (lines 1641–1870)

```
async fn plugin_list_includes_remote_marketplaces_when_remote_plugin_enabled() -> Result<()>
```

**Purpose**: Checks that enabling remote plugins causes `plugin/list` to include the global OpenAI curated remote marketplace populated from backend catalog and installed-plugin endpoints. It also verifies remote catalog caching and default-prompt normalization.

**Data flow**: Creates temp home and mock server, writes remote-plugin config/auth, mounts `GET /ps/plugins/list` for `GLOBAL` and `WORKSPACE`, mounts `GET /ps/plugins/installed` for `GLOBAL` and `WORKSPACE`, starts and initializes the server, sends `plugin/list`, deserializes the response, finds the `openai-curated-remote` marketplace, and asserts its path is `None`, display name is `OpenAI Curated Remote`, the single plugin has remote source/id, installed/enabled flags, availability `Available`, normalized `default_prompt` from `default_prompts`, and expected keywords. It then reads the cached remote catalog file under `cache/remote_plugin_catalog`, asserts schema version and cached plugin ids, and confirms no request used `collection=vertical`.

**Call relations**: This is the main happy-path remote catalog listing test. It covers backend fetch, response mapping, cache persistence, and the default behavior of not querying the vertical collection.

*Call graph*: calls 3 internal fn (new, new, write_remote_plugin_catalog_config); 18 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, format! (+8 more)).


##### `plugin_list_uses_cached_global_remote_catalog_and_refreshes_it`  (lines 1873–1968)

```
async fn plugin_list_uses_cached_global_remote_catalog_and_refreshes_it() -> Result<()>
```

**Purpose**: Verifies that once a global remote catalog has been fetched, subsequent list requests can serve the cached catalog immediately while refreshing it in the background. It checks both first-use warming and later cache replacement.

**Data flow**: Creates temp home and mock server, writes remote-plugin config/auth, mounts an initial global remote plugin list body for `linear`, mounts empty installed responses and empty user-installed plugins, starts and initializes the server, sends `plugin/list`, deserializes the response, asserts the remote marketplace shows `linear`, waits for one `/ps/plugins/list` request and for the cached catalog to contain the initial plugin id, then resets the server and mounts a refreshed catalog body for `notion` plus empty installed responses. It sends `plugin/list` again, deserializes the response, asserts the returned marketplace still shows cached `linear`, waits for one new `/ps/plugins/list` request, and then waits for the cached catalog file to update to the refreshed plugin id.

**Call relations**: This test explicitly observes stale-while-refresh behavior across two requests. It uses `wait_for_cached_remote_catalog_plugin_ids` and request-count polling to separate immediate response contents from eventual cache refresh.

*Call graph*: calls 10 internal fn (new, new, empty_remote_installed_plugins_body, mount_empty_user_installed_plugins, mount_remote_installed_plugins, mount_remote_plugin_list, remote_plugin_list_body, wait_for_cached_remote_catalog_plugin_ids, wait_for_remote_plugin_request_count, write_remote_plugin_catalog_config); 8 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, timeout).


##### `plugin_list_includes_openai_curated_remote_collection_when_requested`  (lines 1971–2073)

```
async fn plugin_list_includes_openai_curated_remote_collection_when_requested() -> Result<()>
```

**Purpose**: Checks that explicitly requesting marketplace kind `Vertical` causes the server to query the remote catalog with `collection=vertical` and return that marketplace. It validates opt-in collection fetching.

**Data flow**: Creates temp home and mock server, writes plugins-enabled config with backend base URL, writes ChatGPT auth, mounts a `GLOBAL` remote plugin list handler requiring `collection=vertical`, mounts empty installed responses and empty user-installed plugins, starts and initializes the server, sends `plugin/list` with `marketplace_kinds: Some([Vertical])`, deserializes the response, asserts the returned `openai-curated-remote` marketplace contains the expected remote plugin summary, then inspects recorded requests to confirm a `/ps/plugins/list` request included `collection=vertical`.

**Call relations**: This test covers the explicit remote-collection branch that is not used by default. It contrasts with tests that assert no vertical collection query occurs unless requested.

*Call graph*: calls 7 internal fn (new, new, empty_remote_installed_plugins_body, mount_empty_user_installed_plugins, mount_openai_curated_remote_collection_plugin_list, mount_remote_installed_plugins, write_plugins_enabled_config_with_base_url); 10 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, format!, timeout, vec!).


##### `plugin_list_propagates_explicit_openai_curated_remote_collection_errors`  (lines 2076–2129)

```
async fn plugin_list_propagates_explicit_openai_curated_remote_collection_errors() -> Result<()>
```

**Purpose**: Verifies that when an explicitly requested vertical remote collection fetch fails, the endpoint returns an error instead of silently omitting the marketplace. It distinguishes explicit-request failures from optional background fetches.

**Data flow**: Creates temp home and mock server, writes plugins-enabled config with backend base URL, writes ChatGPT auth, mounts a failing `GET /ps/plugins/list?scope=GLOBAL&collection=vertical` returning HTTP 500, mounts empty installed responses and empty user-installed plugins, starts and initializes the server, sends `plugin/list` with `marketplace_kinds: Some([Vertical])`, waits for the error response, and asserts code `-32603` with a message mentioning `list OpenAI Curated remote plugin catalog`.

**Call relations**: This test covers the explicit-error propagation branch for requested remote collections. It ensures the server treats requested marketplaces as required rather than best-effort.

*Call graph*: calls 6 internal fn (new, new, empty_remote_installed_plugins_body, mount_empty_user_installed_plugins, mount_remote_installed_plugins, write_plugins_enabled_config_with_base_url); 15 external calls (given, start, new, new, Integer, write_chatgpt_auth, assert!, assert_eq!, format!, timeout (+5 more)).


##### `plugin_list_skips_explicit_openai_curated_remote_collection_for_api_auth`  (lines 2132–2166)

```
async fn plugin_list_skips_explicit_openai_curated_remote_collection_for_api_auth() -> Result<()>
```

**Purpose**: Checks that API-key-authenticated sessions ignore explicit `Vertical` marketplace requests instead of querying ChatGPT remote catalogs. It enforces auth-mode restrictions on remote collection access.

**Data flow**: Creates temp home and mock server, writes plugins-enabled config with backend base URL, logs in with an API key using file storage, starts and initializes the server, sends `plugin/list` with `marketplace_kinds: Some([Vertical])`, deserializes the response, asserts both `marketplaces` and `marketplace_load_errors` are empty, and waits for zero `/ps/plugins/list` requests.

**Call relations**: This test covers the API-auth branch where ChatGPT-only remote collections are unavailable. It uses `wait_for_remote_plugin_request_count` to prove no backend fetch was attempted.

*Call graph*: calls 4 internal fn (new, wait_for_remote_plugin_request_count, write_plugins_enabled_config_with_base_url, default); 9 external calls (start, new, Integer, to_response, assert!, login_with_api_key, format!, timeout, vec!).


##### `plugin_list_includes_api_curated_marketplace_for_api_auth_when_remote_plugin_enabled`  (lines 2169–2221)

```
async fn plugin_list_includes_api_curated_marketplace_for_api_auth_when_remote_plugin_enabled() -> Result<()>
```

**Purpose**: Verifies that API-key-authenticated sessions still see the local API-curated marketplace when remote-plugin support is enabled. It distinguishes API-curated local content from ChatGPT remote catalogs.

**Data flow**: Creates temp home and mock server, writes remote-plugin config, writes an OpenAI API curated marketplace containing `api-plugin`, logs in with an API key, starts and initializes the server, sends `plugin/list`, deserializes the response, finds the `openai-api-curated` marketplace, and asserts its display name is `OpenAI Curated`, it contains one plugin `api-plugin@openai-api-curated`, there are no load errors, and zero remote `/ps/plugins/list` requests were made.

**Call relations**: This test complements the previous one by showing that API auth still exposes curated local marketplaces even while skipping ChatGPT remote fetches.

*Call graph*: calls 5 internal fn (new, wait_for_remote_plugin_request_count, write_openai_api_curated_marketplace, write_remote_plugin_catalog_config, default); 9 external calls (start, new, Integer, to_response, assert!, assert_eq!, login_with_api_key, format!, timeout).


##### `plugin_list_does_not_query_openai_curated_remote_collection_by_default`  (lines 2224–2274)

```
async fn plugin_list_does_not_query_openai_curated_remote_collection_by_default() -> Result<()>
```

**Purpose**: Checks that ordinary `plugin/list` requests do not implicitly query the vertical remote collection. It guards against accidental extra backend traffic.

**Data flow**: Creates temp home and mock server, writes plugins-enabled config with backend base URL, writes ChatGPT auth, starts and initializes the server, sends `plugin/list` with no explicit marketplace kinds, deserializes the response, asserts no returned marketplace is named `openai-curated-remote`, and inspects recorded requests to ensure none included `collection=vertical`.

**Call relations**: This test covers the default behavior for marketplace-kind omission. It pairs with the explicit vertical-collection test to define the intended opt-in semantics.

*Call graph*: calls 3 internal fn (new, new, write_plugins_enabled_config_with_base_url); 8 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert!, format!, timeout).


##### `plugin_list_vertical_kind_noops_when_remote_plugin_enabled`  (lines 2277–2327)

```
async fn plugin_list_vertical_kind_noops_when_remote_plugin_enabled() -> Result<()>
```

**Purpose**: Verifies that requesting `Vertical` does nothing when remote-plugin support is already enabled in the newer mode that should not append the old collection automatically. It protects against legacy behavior leaking into the new remote-plugin path.

**Data flow**: Creates temp home and mock server, writes remote-plugin config/auth, starts and initializes the server, sends `plugin/list` with `marketplace_kinds: Some([Vertical])`, deserializes the response, asserts no marketplace named `openai-curated-remote` is returned, and confirms no request included `collection=vertical`.

**Call relations**: This test is a compatibility/no-op check for explicit marketplace kinds under remote-plugin-enabled configuration. It ensures the server does not mix old and new remote catalog mechanisms.

*Call graph*: calls 3 internal fn (new, new, write_remote_plugin_catalog_config); 9 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert!, format!, timeout, vec!).


##### `plugin_list_does_not_append_global_remote_when_marketplace_kinds_are_explicit`  (lines 2330–2372)

```
async fn plugin_list_does_not_append_global_remote_when_marketplace_kinds_are_explicit() -> Result<()>
```

**Purpose**: Checks that when marketplace kinds are explicitly specified, the server does not also append the default global remote marketplace. It enforces exactness of explicit marketplace selection.

**Data flow**: Creates temp home and mock server, writes remote-plugin config/auth, starts and initializes the server, sends `plugin/list` with `marketplace_kinds: Some([Local])`, deserializes the response, asserts no marketplace named `openai-curated-remote` is present, and waits for zero `/ps/plugins/list` requests.

**Call relations**: This test covers explicit-kind filtering in the presence of remote-plugin support. It uses backend request-count polling to prove the omitted marketplace was not even fetched.

*Call graph*: calls 4 internal fn (new, new, wait_for_remote_plugin_request_count, write_remote_plugin_catalog_config); 9 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert!, format!, timeout, vec!).


##### `plugin_installed_includes_remote_shared_with_me_plugins`  (lines 2375–2474)

```
async fn plugin_installed_includes_remote_shared_with_me_plugins() -> Result<()>
```

**Purpose**: Verifies that `plugin/installed` includes workspace-shared remote plugins when plugin sharing is enabled, including both private and unlisted discoverability variants. It checks marketplace naming and installed/enabled flags.

**Data flow**: Creates temp home and mock server, writes config with `plugins = true`, `remote_plugin = false`, and `plugin_sharing = true`, writes ChatGPT auth, builds a workspace installed body containing one private shared plugin and one unlisted shared plugin, mounts global and workspace installed responses plus empty user-installed plugins, starts and initializes the server, sends `plugin/installed`, deserializes the response, and asserts a single marketplace named `workspace-shared-with-me` with display name `Shared with me` and two installed plugin summaries with the expected ids and enabled flags. It then waits for installed-scope requests for both `WORKSPACE` and `GLOBAL`.

**Call relations**: This test covers installed-plugin aggregation for shared-with-me remote plugins without enabling the full remote-plugin catalog feature. It relies on workspace installed fixtures rather than `/ps/plugins/list`.

*Call graph*: calls 7 internal fn (new, new, mount_empty_user_installed_plugins, mount_remote_installed_plugins, remote_installed_plugin_body, wait_for_remote_installed_scope_request, workspace_remote_plugin_page_body); 11 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, from_str, to_string, write (+1 more)).


##### `plugin_installed_includes_workspace_directory_without_plugin_sharing`  (lines 2477–2561)

```
async fn plugin_installed_includes_workspace_directory_without_plugin_sharing() -> Result<()>
```

**Purpose**: Checks that when plugin sharing is disabled, workspace-installed listed plugins still appear under `workspace-directory` while private shared plugins are omitted. It distinguishes workspace directory from shared-with-me behavior.

**Data flow**: Creates temp home and mock server, writes config with `plugins = true`, `remote_plugin = false`, `plugin_sharing = false`, writes ChatGPT auth, builds a workspace installed body containing one listed workspace plugin and one private shared plugin, mounts empty global installed and the workspace installed response plus empty user-installed plugins, starts and initializes the server, sends `plugin/installed`, deserializes the response, and asserts a single marketplace named `workspace-directory` containing only the listed workspace plugin as installed/enabled. It waits for installed-scope requests for `WORKSPACE` and `GLOBAL`.

**Call relations**: This test covers filtering of workspace-installed remote plugins based on discoverability and feature flags. It is the installed-endpoint counterpart to workspace-directory list tests.

*Call graph*: calls 7 internal fn (new, new, empty_remote_installed_plugins_body, mount_empty_user_installed_plugins, mount_remote_installed_plugins, wait_for_remote_installed_scope_request, workspace_remote_plugin_page_body); 11 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, from_str, to_string, write (+1 more)).


##### `plugin_installed_includes_created_by_me_when_remote_plugins_enabled`  (lines 2564–2652)

```
async fn plugin_installed_includes_created_by_me_when_remote_plugins_enabled() -> Result<()>
```

**Purpose**: Verifies that user-scoped remote plugins appear under `created-by-me-remote` when remote plugins are enabled and that their bundles are synchronized to cache. It combines installed listing with user-scope bundle download.

**Data flow**: Creates temp home and mock server, writes config enabling plugins and remote plugins, writes ChatGPT auth, mounts empty global/workspace installed responses, mounts a bundle download for `private-linear`, builds a user installed body for a private plugin and injects the bundle URL into its release, mounts that as the `USER` installed response, starts `TestAppServer` with HTTP downloads allowed, initializes it, sends `plugin/installed`, deserializes the response, asserts a single marketplace named `created-by-me-remote` containing `private-linear` as installed/enabled, waits for the cached bundle path to appear under `plugins/cache/created-by-me-remote/private-linear/1.2.3/...`, and waits for a `USER` installed-scope request.

**Call relations**: This test covers user-scope remote installed plugins and their bundle sync side effect. It uses `wait_for_path_exists` to observe asynchronous extraction after the installed request.

*Call graph*: calls 9 internal fn (new, new_with_env, empty_remote_installed_plugins_body, mount_remote_installed_plugins, mount_remote_plugin_bundle, remote_plugin_bundle_tar_gz_bytes, user_remote_plugin_page_body, wait_for_path_exists, wait_for_remote_installed_scope_request); 12 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, from_str, json!, to_string (+2 more)).


##### `plugin_installed_starts_remote_installed_bundle_sync`  (lines 2655–2731)

```
async fn plugin_installed_starts_remote_installed_bundle_sync() -> Result<()>
```

**Purpose**: Checks that a `plugin/installed` request triggers synchronization of remote installed bundles for global remote plugins. It validates request-time sync, not just startup sync.

**Data flow**: Creates temp home and mock server, writes config enabling plugins and remote plugins, writes ChatGPT auth, mounts a bundle download for `linear`, mounts global installed response containing `linear` with bundle URL and empty workspace/user installed responses, starts `TestAppServer` with HTTP downloads allowed, initializes it, sends `plugin/installed`, deserializes the response, asserts the returned marketplace is `openai-curated-remote` with `linear` installed/enabled, waits for the cached bundle manifest path to appear, and waits for installed-scope requests for `GLOBAL` and `WORKSPACE`.

**Call relations**: This test complements the startup-sync test by proving the installed endpoint itself can kick off bundle synchronization. It uses the same bundle and installed fixtures but a different trigger.

*Call graph*: calls 10 internal fn (new, new_with_env, empty_remote_installed_plugins_body, mount_empty_user_installed_plugins, mount_remote_installed_plugins, mount_remote_plugin_bundle, remote_installed_plugin_body, remote_plugin_bundle_tar_gz_bytes, wait_for_path_exists, wait_for_remote_installed_scope_request); 9 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, write, timeout).


##### `plugin_list_fetches_workspace_directory_kind_without_remote_plugin_flag`  (lines 2734–2819)

```
async fn plugin_list_fetches_workspace_directory_kind_without_remote_plugin_flag() -> Result<()>
```

**Purpose**: Verifies that explicitly requesting `WorkspaceDirectory` fetches workspace remote plugins even when the global `remote_plugin` feature flag is off. It checks marketplace-kind-driven access to workspace directory listings.

**Data flow**: Creates temp home and mock server, writes plugins-enabled config with backend base URL, writes ChatGPT auth, builds workspace plugin list and installed bodies for one listed workspace plugin, mounts `WORKSPACE` remote plugin list and installed responses plus empty user-installed plugins, starts and initializes the server, sends `plugin/list` with `marketplace_kinds: Some([WorkspaceDirectory])`, deserializes the response, and asserts a single marketplace named `workspace-directory` with display name `Workspace Directory` and one plugin summary marked installed but disabled. It also confirms no request queried `scope=GLOBAL`.

**Call relations**: This test covers explicit workspace-directory listing independent of the broader remote-plugin feature. It proves marketplace kinds can selectively enable backend fetches.

*Call graph*: calls 7 internal fn (new, new, mount_empty_user_installed_plugins, mount_remote_installed_plugins, mount_remote_plugin_list, workspace_remote_plugin_page_body, write_plugins_enabled_config_with_base_url); 10 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, format!, timeout, vec!).


##### `plugin_list_fetches_user_plugins_in_created_by_me_remote_marketplace`  (lines 2822–2955)

```
async fn plugin_list_fetches_user_plugins_in_created_by_me_remote_marketplace() -> Result<()>
```

**Purpose**: Checks that explicitly requesting `CreatedByMeRemote` fetches paginated user-scope remote plugins and merges installed state from the user installed endpoint. It validates pagination and marketplace naming for user-created plugins.

**Data flow**: Creates temp home and mock server, writes config enabling plugins and remote plugins, writes ChatGPT auth, mounts two paginated `GET /ps/plugins/list?scope=USER` responses for private plugins, mounts a `USER` installed response marking the first plugin enabled plus empty global/workspace installed responses, starts and initializes the server, sends `plugin/list` with `marketplace_kinds: Some([CreatedByMeRemote])`, deserializes the response, and asserts a single marketplace named `created-by-me-remote` with display name `Created by me`, containing two plugin summaries where the first is installed/enabled and the second is not. It also confirms no `/ps/plugins/list` request used a scope other than `USER`.

**Call relations**: This test covers user-scope remote listing with pagination. It combines explicit marketplace-kind selection, paginated backend fixtures, and installed-state merging.

*Call graph*: calls 5 internal fn (new, new, empty_remote_installed_plugins_body, mount_remote_installed_plugins, user_remote_plugin_page_body); 19 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, format! (+9 more)).


##### `plugin_list_fetches_shared_with_me_kind`  (lines 2958–3152)

```
async fn plugin_list_fetches_shared_with_me_kind() -> Result<()>
```

**Purpose**: Verifies that explicitly requesting `SharedWithMe` fetches shared workspace plugins and returns separate marketplaces for private and unlisted discoverability, with full share-context metadata and installed-state merging. It is the most detailed shared-plugin list test.

**Data flow**: Creates temp home and mock server, writes plugins-enabled config with backend base URL, writes ChatGPT auth, builds a shared-workspace plugin list body containing one private and one unlisted shared plugin, builds a workspace installed body containing one installed private shared plugin and one installed unlisted plugin, mounts shared-workspace list, global/workspace installed responses, and empty user-installed plugins, starts and initializes the server, sends `plugin/list` with `marketplace_kinds: Some([SharedWithMe])`, deserializes the response, and asserts two marketplaces: `workspace-shared-with-me-private` and `workspace-shared-with-me-unlisted`. It checks plugin ids, remote ids, installed/enabled flags, and detailed `share_context` fields including remote version, discoverability, creator ids/names, share URL, and optional principals. It then waits for installed-scope requests and confirms no generic `/ps/plugins/list` requests were made.

**Call relations**: This test covers the explicit shared-with-me listing path and its marketplace partitioning by discoverability. It relies on `mount_shared_workspace_plugins` rather than the generic remote plugin list endpoint.

*Call graph*: calls 10 internal fn (new, new, empty_remote_installed_plugins_body, mount_empty_user_installed_plugins, mount_remote_installed_plugins, mount_shared_workspace_plugins, wait_for_remote_installed_scope_request, wait_for_remote_plugin_request_count, workspace_remote_plugin_page_body, write_plugins_enabled_config_with_base_url); 11 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, from_str, to_string, timeout (+1 more)).


##### `plugin_list_omits_shared_with_me_kind_when_plugin_sharing_disabled`  (lines 3155–3211)

```
async fn plugin_list_omits_shared_with_me_kind_when_plugin_sharing_disabled() -> Result<()>
```

**Purpose**: Checks that requesting `SharedWithMe` yields an empty response when plugin sharing is disabled in config. It ensures the endpoint respects feature gating for shared-plugin discovery.

**Data flow**: Creates temp home and mock server, writes config enabling plugins but disabling `plugin_sharing`, writes ChatGPT auth, starts and initializes the server, sends `plugin/list` with `marketplace_kinds: Some([SharedWithMe])`, deserializes the response, asserts it equals an empty `PluginListResponse`, and waits for zero `/ps/plugins/workspace/shared` requests.

**Call relations**: This test covers feature gating before any shared-workspace backend fetch. It uses request-count polling to prove the disabled feature suppresses network traffic entirely.

*Call graph*: calls 3 internal fn (new, new, wait_for_remote_plugin_request_count); 10 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, write, timeout, vec!).


##### `plugin_list_omits_created_by_me_when_remote_plugins_disabled`  (lines 3214–3266)

```
async fn plugin_list_omits_created_by_me_when_remote_plugins_disabled() -> Result<()>
```

**Purpose**: Verifies that requesting `CreatedByMeRemote` returns nothing when remote plugins are disabled. It enforces feature gating for user-created remote marketplaces.

**Data flow**: Creates temp home and mock server, writes config enabling plugins and plugin sharing but disabling `remote_plugin`, writes ChatGPT auth, starts and initializes the server, sends `plugin/list` with `marketplace_kinds: Some([CreatedByMeRemote])`, deserializes the response, asserts it equals an empty `PluginListResponse`, and waits for zero `/ps/plugins/list` requests.

**Call relations**: This test is the remote-plugin-disabled counterpart to the explicit created-by-me listing test. It proves the endpoint short-circuits before backend access.

*Call graph*: calls 3 internal fn (new, new, wait_for_remote_plugin_request_count); 10 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, write, timeout, vec!).


##### `plugin_list_marks_remote_plugin_disabled_by_admin`  (lines 3269–3401)

```
async fn plugin_list_marks_remote_plugin_disabled_by_admin() -> Result<()>
```

**Purpose**: Checks that remote plugin summaries preserve `DisabledByAdmin` availability even when the plugin is installed and enabled. It validates availability mapping from backend status strings.

**Data flow**: Creates temp home and mock server, writes remote-plugin config/auth, mounts global and workspace remote plugin list responses where the global plugin status is `DISABLED_BY_ADMIN`, mounts matching installed responses, starts and initializes the server, sends `plugin/list`, deserializes the response, finds the `openai-curated-remote` marketplace and its first plugin, and asserts `installed == true`, `enabled == true`, and `availability == PluginAvailability::DisabledByAdmin`.

**Call relations**: This test covers status propagation in remote catalog mapping. It combines list and installed backend fixtures to show availability is independent of installed/enabled state.

*Call graph*: calls 3 internal fn (new, new, write_remote_plugin_catalog_config); 14 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, timeout (+4 more)).


##### `plugin_list_does_not_fetch_remote_marketplaces_when_plugins_disabled`  (lines 3404–3449)

```
async fn plugin_list_does_not_fetch_remote_marketplaces_when_plugins_disabled() -> Result<()>
```

**Purpose**: Ensures that disabling plugins globally suppresses all remote marketplace fetches even if `remote_plugin = true` is set. It validates the top-level plugin feature gate.

**Data flow**: Creates temp home and mock server, writes config with `plugins = false` and `remote_plugin = true`, writes ChatGPT auth, starts and initializes the server, sends `plugin/list`, deserializes the response, asserts `marketplaces` is empty, and waits for zero `/ps/plugins/list` requests.

**Call relations**: This test covers the highest-level feature gate for plugin listing. It proves remote-plugin enablement alone is insufficient when plugins are globally disabled.

*Call graph*: calls 3 internal fn (new, new, wait_for_remote_plugin_request_count); 9 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert!, format!, write, timeout).


##### `plugin_list_fetches_featured_plugin_ids_without_chatgpt_auth`  (lines 3452–3487)

```
async fn plugin_list_fetches_featured_plugin_ids_without_chatgpt_auth() -> Result<()>
```

**Purpose**: Checks that featured plugin ids can be fetched from the backend even without ChatGPT auth and are returned alongside local curated marketplaces. It validates the unauthenticated featured-plugin path.

**Data flow**: Creates temp home and mock server, writes plugin-sync config with backend base URL, writes an OpenAI curated marketplace containing `linear` and `gmail`, mounts `GET /backend-api/plugins/featured?platform=codex` returning `["linear@openai-curated"]`, starts and initializes the server, sends `plugin/list`, deserializes the response, and asserts `featured_plugin_ids == ["linear@openai-curated"]`.

**Call relations**: This test isolates featured-plugin fetching from authenticated remote plugin catalogs. It uses `write_plugin_sync_config` to seed local curated plugin state and backend URL.

*Call graph*: calls 3 internal fn (new, write_openai_curated_marketplace, write_plugin_sync_config); 12 external calls (given, start, new, new, Integer, to_response, assert_eq!, format!, timeout, method (+2 more)).


##### `plugin_list_uses_warmed_featured_plugin_ids_cache_on_first_request`  (lines 3490–3527)

```
async fn plugin_list_uses_warmed_featured_plugin_ids_cache_on_first_request() -> Result<()>
```

**Purpose**: Verifies that plugin startup tasks can warm the featured-plugin-id cache so the first `plugin/list` request returns featured ids without triggering another backend fetch. It checks startup prefetch behavior.

**Data flow**: Creates temp home and mock server, writes plugin-sync config and an OpenAI curated marketplace, mounts a single expected `GET /backend-api/plugins/featured?platform=codex` response, starts `TestAppServer` with plugin startup tasks, initializes it, waits for one featured-plugin request, sends `plugin/list`, deserializes the response, and asserts the returned `featured_plugin_ids` contains `linear@openai-curated`.

**Call relations**: This test covers startup warming rather than on-demand fetching. It delegates backend-count verification to `wait_for_featured_plugin_request_count`.

*Call graph*: calls 4 internal fn (new_with_plugin_startup_tasks, wait_for_featured_plugin_request_count, write_openai_curated_marketplace, write_plugin_sync_config); 12 external calls (given, start, new, new, Integer, to_response, assert_eq!, format!, timeout, method (+2 more)).


##### `wait_for_featured_plugin_request_count`  (lines 3529–3534)

```
async fn wait_for_featured_plugin_request_count(
    server: &MockServer,
    expected_count: usize,
) -> Result<()>
```

**Purpose**: Convenience wrapper that waits for a specific number of featured-plugin backend requests. It specializes the generic remote-request poller for `/plugins/featured`.

**Data flow**: Forwards the mock server, path suffix `/plugins/featured`, and expected count to `wait_for_remote_plugin_request_count`, returning its `Result<()>`.

**Call relations**: Only the warmed-featured-cache test calls this helper. It exists to make that test read in domain terms rather than raw path suffixes.

*Call graph*: calls 1 internal fn (wait_for_remote_plugin_request_count); called by 1 (plugin_list_uses_warmed_featured_plugin_ids_cache_on_first_request).


##### `wait_for_workspace_settings_request_count`  (lines 3536–3542)

```
async fn wait_for_workspace_settings_request_count(
    server: &MockServer,
    expected_count: usize,
) -> Result<()>
```

**Purpose**: Convenience wrapper that waits for a specific number of workspace account-settings requests. It is used to assert caching of the workspace plugin-enabled setting.

**Data flow**: Calls `wait_for_remote_plugin_request_count` with path suffix `/accounts/account-123/settings` and the expected count, returning the result.

**Call relations**: The workspace-settings cache test uses this helper after two list requests to prove only one backend settings fetch occurred.

*Call graph*: calls 1 internal fn (wait_for_remote_plugin_request_count); called by 1 (plugin_list_reuses_cached_workspace_codex_plugins_setting).


##### `wait_for_remote_plugin_request_count`  (lines 3544–3573)

```
async fn wait_for_remote_plugin_request_count(
    server: &MockServer,
    path_suffix: &str,
    expected_count: usize,
) -> Result<()>
```

**Purpose**: Polls a mock backend until it has observed exactly the expected number of GET requests whose path ends with a given suffix. It is the generic request-count assertion helper for this file.

**Data flow**: Within a timeout-wrapped loop, fetches recorded requests from the `MockServer`, errors if wiremock has no request log, filters for `GET` requests whose path ends with `path_suffix`, and compares the count to `expected_count`. It returns success on equality, bails on excess, or sleeps 10 ms and retries otherwise.

**Call relations**: Many tests and wrapper helpers use this function to assert both that backend fetches happened and that forbidden fetches did not happen. It is the central polling primitive for remote request observability.

*Call graph*: called by 10 (plugin_list_does_not_append_global_remote_when_marketplace_kinds_are_explicit, plugin_list_does_not_fetch_remote_marketplaces_when_plugins_disabled, plugin_list_fetches_shared_with_me_kind, plugin_list_includes_api_curated_marketplace_for_api_auth_when_remote_plugin_enabled, plugin_list_omits_created_by_me_when_remote_plugins_disabled, plugin_list_omits_shared_with_me_kind_when_plugin_sharing_disabled, plugin_list_skips_explicit_openai_curated_remote_collection_for_api_auth, plugin_list_uses_cached_global_remote_catalog_and_refreshes_it, wait_for_featured_plugin_request_count, wait_for_workspace_settings_request_count); 5 external calls (from_millis, received_requests, bail!, sleep, timeout).


##### `wait_for_remote_installed_scope_request`  (lines 3575–3596)

```
async fn wait_for_remote_installed_scope_request(server: &MockServer, scope: &str) -> Result<()>
```

**Purpose**: Polls until the mock backend has observed a `/ps/plugins/installed` request for a specific scope. It is used to prove that installed-state fetches occurred for `GLOBAL`, `WORKSPACE`, or `USER` as expected.

**Data flow**: Within a timeout loop, reads recorded requests from the `MockServer`, errors if unavailable, scans for any `GET` request whose path ends with `/ps/plugins/installed` and whose query pairs include `scope=<scope>`, returns success when found, or sleeps 10 ms and retries.

**Call relations**: Installed-plugin and shared-plugin tests call this helper after requests that should trigger installed-scope fetches. It complements exact-count assertions by focusing on scope presence.

*Call graph*: called by 5 (plugin_installed_includes_created_by_me_when_remote_plugins_enabled, plugin_installed_includes_remote_shared_with_me_plugins, plugin_installed_includes_workspace_directory_without_plugin_sharing, plugin_installed_starts_remote_installed_bundle_sync, plugin_list_fetches_shared_with_me_kind); 5 external calls (from_millis, received_requests, bail!, sleep, timeout).


##### `wait_for_cached_remote_catalog_plugin_ids`  (lines 3598–3619)

```
async fn wait_for_cached_remote_catalog_plugin_ids(
    codex_home: &std::path::Path,
    expected_plugin_ids: &[&str],
) -> Result<()>
```

**Purpose**: Polls the on-disk remote catalog cache until it contains exactly the expected set of plugin ids. It synchronizes tests with asynchronous cache refresh behavior.

**Data flow**: Copies and sorts the expected plugin ids, then within a timeout loop calls `cached_remote_catalog_plugin_ids(codex_home)` and compares the sorted result to the expected vector. It returns success on equality or sleeps 10 ms and retries otherwise.

**Call relations**: The cached-global-remote-catalog test uses this helper after each request to observe when the cache has been warmed or refreshed.

*Call graph*: calls 1 internal fn (cached_remote_catalog_plugin_ids); called by 1 (plugin_list_uses_cached_global_remote_catalog_and_refreshes_it); 3 external calls (from_millis, sleep, timeout).


##### `cached_remote_catalog_plugin_ids`  (lines 3621–3642)

```
fn cached_remote_catalog_plugin_ids(codex_home: &std::path::Path) -> Result<Vec<String>>
```

**Purpose**: Reads all cached remote catalog files from disk and extracts their plugin ids. It provides a filesystem-level view of the remote catalog cache contents.

**Data flow**: Builds `codex_home/cache/remote_plugin_catalog`, returns an empty vector if it does not exist, otherwise iterates `read_dir`, reads each file, parses it as JSON, extracts any string `id` fields from the `plugins` array, accumulates them into a vector, sorts it, and returns it.

**Call relations**: Only `wait_for_cached_remote_catalog_plugin_ids` calls this helper. It is the low-level cache inspection routine used by tests observing asynchronous remote catalog refresh.

*Call graph*: called by 1 (wait_for_cached_remote_catalog_plugin_ids); 5 external calls (join, new, from_slice, read, read_dir).


##### `wait_for_path_exists`  (lines 3644–3655)

```
async fn wait_for_path_exists(path: &std::path::Path) -> Result<()>
```

**Purpose**: Polls until a filesystem path exists. It is used to synchronize tests with asynchronous bundle extraction and cache writes.

**Data flow**: Within a timeout loop, checks `path.exists()`, returns success when true, or sleeps 10 ms and retries otherwise.

**Call relations**: Startup sync, installed sync, and bundle upgrade tests call this helper to wait for downloaded remote plugin files to appear before reading them.

*Call graph*: called by 4 (app_server_startup_sync_downloads_remote_installed_plugin_bundles, plugin_installed_includes_created_by_me_when_remote_plugins_enabled, plugin_installed_starts_remote_installed_bundle_sync, plugin_list_sync_upgrades_and_removes_remote_installed_plugin_bundles); 4 external calls (from_millis, exists, sleep, timeout).


##### `wait_for_path_missing`  (lines 3657–3668)

```
async fn wait_for_path_missing(path: &std::path::Path) -> Result<()>
```

**Purpose**: Polls until a filesystem path no longer exists. It is used to verify stale remote bundle directories are removed during synchronization.

**Data flow**: Within a timeout loop, checks `!path.exists()`, returns success when the path is absent, or sleeps 10 ms and retries otherwise.

**Call relations**: Only the remote bundle upgrade/removal test uses this helper to confirm old and stale cache directories were deleted.

*Call graph*: called by 1 (plugin_list_sync_upgrades_and_removes_remote_installed_plugin_bundles); 4 external calls (from_millis, exists, sleep, timeout).


##### `mount_remote_plugin_list`  (lines 3670–3680)

```
async fn mount_remote_plugin_list(server: &MockServer, scope: &str, body: &str)
```

**Purpose**: Mounts a generic remote plugin catalog list endpoint for a given scope. It is the standard fixture for `/ps/plugins/list` responses in remote listing tests.

**Data flow**: Registers a wiremock `GET /backend-api/ps/plugins/list` handler requiring `scope=<scope>`, `limit=200`, and the standard auth headers, and responds with the supplied body string.

**Call relations**: Many remote listing tests call this helper to provide `GLOBAL`, `WORKSPACE`, or `USER` catalog pages without duplicating matcher setup.

*Call graph*: called by 3 (plugin_list_fetches_workspace_directory_kind_without_remote_plugin_flag, plugin_list_sync_upgrades_and_removes_remote_installed_plugin_bundles, plugin_list_uses_cached_global_remote_catalog_and_refreshes_it); 6 external calls (given, new, header, method, path, query_param).


##### `remote_plugin_list_body`  (lines 3682–3717)

```
fn remote_plugin_list_body(
    remote_plugin_id: &str,
    plugin_name: &str,
    display_name: &str,
    short_description: &str,
) -> String
```

**Purpose**: Builds a simple one-plugin remote catalog page body for tests that only need a minimal global remote plugin listing. It parameterizes plugin id, name, display name, and short description.

**Data flow**: Formats and returns a JSON string containing one `GLOBAL` plugin entry with installation/authentication policies, status `ENABLED`, release version `1.2.3`, display/description fields, empty app ids, interface short description and capabilities, empty skills, and terminal pagination.

**Call relations**: The cached-global-remote-catalog test uses this helper to generate both the initial and refreshed catalog bodies.

*Call graph*: called by 1 (plugin_list_uses_cached_global_remote_catalog_and_refreshes_it); 1 external calls (format!).


##### `mount_openai_curated_remote_collection_plugin_list`  (lines 3719–3730)

```
async fn mount_openai_curated_remote_collection_plugin_list(server: &MockServer, body: &str)
```

**Purpose**: Mounts the remote plugin list endpoint specifically for the `collection=vertical` query. It supports explicit vertical-collection tests.

**Data flow**: Registers a wiremock `GET /backend-api/ps/plugins/list` handler requiring `scope=GLOBAL`, `limit=200`, `collection=vertical`, and the standard auth headers, then responds with the supplied body string.

**Call relations**: Only the explicit vertical-collection success test uses this helper. It isolates the extra query parameter from the generic remote list fixture.

*Call graph*: called by 1 (plugin_list_includes_openai_curated_remote_collection_when_requested); 6 external calls (given, new, header, method, path, query_param).


##### `mount_shared_workspace_plugins`  (lines 3732–3741)

```
async fn mount_shared_workspace_plugins(server: &MockServer, body: &str)
```

**Purpose**: Mounts the shared-workspace plugin listing endpoint used for `SharedWithMe` marketplace requests. It provides the backend fixture for shared plugin discovery.

**Data flow**: Registers a wiremock `GET /backend-api/ps/plugins/workspace/shared` handler requiring `limit=200` and the standard auth headers, then responds with the supplied body string.

**Call relations**: The shared-with-me list test uses this helper instead of the generic remote plugin list endpoint because shared plugins come from a distinct backend route.

*Call graph*: called by 1 (plugin_list_fetches_shared_with_me_kind); 6 external calls (given, new, header, method, path, query_param).


##### `mount_remote_installed_plugins`  (lines 3743–3752)

```
async fn mount_remote_installed_plugins(server: &MockServer, scope: &str, body: &str)
```

**Purpose**: Mounts a remote installed-plugins endpoint for a given scope. It is the standard fixture for installed-state merging and bundle sync tests.

**Data flow**: Registers a wiremock `GET /backend-api/ps/plugins/installed` handler requiring `scope=<scope>` and the standard auth headers, then responds with the supplied body string.

**Call relations**: Many tests call this helper directly or indirectly through `mount_empty_user_installed_plugins` to provide installed-state data for `GLOBAL`, `WORKSPACE`, or `USER` scopes.

*Call graph*: called by 14 (app_server_startup_sync_downloads_remote_installed_plugin_bundles, mount_empty_user_installed_plugins, plugin_installed_includes_created_by_me_when_remote_plugins_enabled, plugin_installed_includes_remote_shared_with_me_plugins, plugin_installed_includes_workspace_directory_without_plugin_sharing, plugin_installed_prefers_remote_curated_conflicts_when_remote_plugin_enabled, plugin_installed_starts_remote_installed_bundle_sync, plugin_list_fetches_shared_with_me_kind, plugin_list_fetches_user_plugins_in_created_by_me_remote_marketplace, plugin_list_fetches_workspace_directory_kind_without_remote_plugin_flag (+4 more)); 6 external calls (given, new, header, method, path, query_param).


##### `mount_empty_user_installed_plugins`  (lines 3754–3756)

```
async fn mount_empty_user_installed_plugins(server: &MockServer)
```

**Purpose**: Convenience helper that mounts an empty `USER` installed-plugins response. It reduces duplication in tests that do not care about user-installed plugins.

**Data flow**: Calls `empty_remote_installed_plugins_body()` and passes the result to `mount_remote_installed_plugins(server, "USER", ...)`.

**Call relations**: Many remote listing and installed tests call this helper to complete the installed-state fixture set without writing a custom user-scope body.

*Call graph*: calls 2 internal fn (empty_remote_installed_plugins_body, mount_remote_installed_plugins); called by 11 (app_server_startup_sync_downloads_remote_installed_plugin_bundles, plugin_installed_includes_remote_shared_with_me_plugins, plugin_installed_includes_workspace_directory_without_plugin_sharing, plugin_installed_prefers_remote_curated_conflicts_when_remote_plugin_enabled, plugin_installed_starts_remote_installed_bundle_sync, plugin_list_fetches_shared_with_me_kind, plugin_list_fetches_workspace_directory_kind_without_remote_plugin_flag, plugin_list_includes_openai_curated_remote_collection_when_requested, plugin_list_propagates_explicit_openai_curated_remote_collection_errors, plugin_list_sync_upgrades_and_removes_remote_installed_plugin_bundles (+1 more)).


##### `empty_remote_installed_plugins_body`  (lines 3758–3766)

```
fn empty_remote_installed_plugins_body() -> &'static str
```

**Purpose**: Returns the canonical empty installed-plugins JSON body used by many remote fixture helpers. It centralizes the exact pagination shape.

**Data flow**: Returns a static string literal containing `{ "plugins": [], "pagination": { "limit": 50, "next_page_token": null } }`.

**Call relations**: This helper feeds `mount_empty_user_installed_plugins` and many tests that need empty installed responses for one or more scopes.

*Call graph*: called by 12 (app_server_startup_sync_downloads_remote_installed_plugin_bundles, mount_empty_user_installed_plugins, plugin_installed_includes_created_by_me_when_remote_plugins_enabled, plugin_installed_includes_workspace_directory_without_plugin_sharing, plugin_installed_prefers_remote_curated_conflicts_when_remote_plugin_enabled, plugin_installed_starts_remote_installed_bundle_sync, plugin_list_fetches_shared_with_me_kind, plugin_list_fetches_user_plugins_in_created_by_me_remote_marketplace, plugin_list_includes_openai_curated_remote_collection_when_requested, plugin_list_propagates_explicit_openai_curated_remote_collection_errors (+2 more)).


##### `workspace_remote_plugin_page_body`  (lines 3768–3822)

```
fn workspace_remote_plugin_page_body(
    remote_plugin_id: &str,
    plugin_name: &str,
    display_name: &str,
    discoverability: &str,
    enabled: Option<bool>,
) -> String
```

**Purpose**: Builds a remote plugin page body for workspace-scoped plugins, optionally including installed-state fields. It is used for both list and installed fixtures involving workspace/shared plugins.

**Data flow**: Accepts remote plugin id, plugin name, display name, discoverability string, and optional enabled flag; conditionally formats an `enabled` plus `disabled_skill_names` fragment; and returns a JSON string containing one `WORKSPACE` plugin entry with creator metadata, share URL, share principals, installation/authentication policies, status `ENABLED`, release version `1.2.3`, and terminal pagination.

**Call relations**: Several tests use this helper directly for workspace list/installed fixtures, and `user_remote_plugin_page_body` reuses it by replacing the scope.

*Call graph*: called by 5 (plugin_installed_includes_remote_shared_with_me_plugins, plugin_installed_includes_workspace_directory_without_plugin_sharing, plugin_list_fetches_shared_with_me_kind, plugin_list_fetches_workspace_directory_kind_without_remote_plugin_flag, user_remote_plugin_page_body); 1 external calls (format!).


##### `user_remote_plugin_page_body`  (lines 3824–3839)

```
fn user_remote_plugin_page_body(
    remote_plugin_id: &str,
    plugin_name: &str,
    display_name: &str,
    discoverability: &str,
    enabled: Option<bool>,
) -> String
```

**Purpose**: Builds a user-scoped remote plugin page body by reusing the workspace-scoped template and changing the scope to `USER`. It supports created-by-me remote plugin tests.

**Data flow**: Calls `workspace_remote_plugin_page_body(...)` with the supplied arguments and then replaces the first occurrence of `"scope": "WORKSPACE"` with `"scope": "USER"` in the resulting string.

**Call relations**: User-created remote plugin tests call this helper to avoid duplicating the full JSON template used for workspace-scoped plugins.

*Call graph*: calls 1 internal fn (workspace_remote_plugin_page_body); called by 2 (plugin_installed_includes_created_by_me_when_remote_plugins_enabled, plugin_list_fetches_user_plugins_in_created_by_me_remote_marketplace).


##### `remote_installed_plugin_body`  (lines 3841–3852)

```
fn remote_installed_plugin_body(
    bundle_download_url: &str,
    release_version: &str,
    enabled: bool,
) -> String
```

**Purpose**: Builds a simple global remote installed-plugin body with no app manifest. It is the common fixture for installed remote plugin tests.

**Data flow**: Forwards the bundle download URL, release version, and enabled flag to `remote_installed_plugin_body_with_optional_app_manifest` with `None` for the app manifest and returns the resulting JSON string.

**Call relations**: Several installed and conflict-resolution tests use this helper when they only need a basic installed remote plugin fixture.

*Call graph*: calls 1 internal fn (remote_installed_plugin_body_with_optional_app_manifest); called by 3 (plugin_installed_includes_remote_shared_with_me_plugins, plugin_installed_prefers_remote_curated_conflicts_when_remote_plugin_enabled, plugin_installed_starts_remote_installed_bundle_sync).


##### `remote_installed_plugin_body_with_app_manifest`  (lines 3854–3866)

```
fn remote_installed_plugin_body_with_app_manifest(
    bundle_download_url: &str,
    release_version: &str,
    enabled: bool,
    app_manifest: serde_json::Value,
) -> String
```

**Purpose**: Builds a global remote installed-plugin body that includes an embedded app manifest. It supports bundle sync tests that verify `.app.json` persistence.

**Data flow**: Calls `remote_installed_plugin_body_with_optional_app_manifest` with `Some(app_manifest)` and returns the formatted JSON string.

**Call relations**: Startup sync and bundle upgrade tests use this helper to include app-manifest data in the installed-plugin fixture.

*Call graph*: calls 1 internal fn (remote_installed_plugin_body_with_optional_app_manifest); called by 2 (app_server_startup_sync_downloads_remote_installed_plugin_bundles, plugin_list_sync_upgrades_and_removes_remote_installed_plugin_bundles).


##### `remote_installed_plugin_body_with_optional_app_manifest`  (lines 3868–3906)

```
fn remote_installed_plugin_body_with_optional_app_manifest(
    bundle_download_url: &str,
    release_version: &str,
    enabled: bool,
    app_manifest: Option<serde_json::Value>,
) -> String
```

**Purpose**: Formats the full JSON body for a global remote installed plugin, optionally embedding an app manifest. It parameterizes bundle URL, release version, enabled state, and app-manifest presence.

**Data flow**: Conditionally formats an `app_manifest` field, then returns a JSON string containing one `GLOBAL` plugin entry with fixed id/name `linear`, installation/authentication policies, release metadata including `bundle_download_url`, optional app manifest, empty interface and skills, plus `enabled` and `disabled_skill_names` fields and terminal pagination.

**Call relations**: Both installed-plugin body wrappers delegate to this function. It is the underlying fixture generator for remote installed bundle sync tests.

*Call graph*: called by 2 (remote_installed_plugin_body, remote_installed_plugin_body_with_app_manifest); 1 external calls (format!).


##### `mount_remote_plugin_bundle`  (lines 3908–3924)

```
async fn mount_remote_plugin_bundle(
    server: &MockServer,
    plugin_name: &str,
    body: Vec<u8>,
) -> String
```

**Purpose**: Mounts a bundle download endpoint for a named remote plugin and returns its full URL. It serves tar.gz bytes used by remote bundle sync tests.

**Data flow**: Formats `/bundles/{plugin_name}.tar.gz`, registers a wiremock `GET` handler for that path returning HTTP 200 with `content-type: application/gzip` and the supplied bytes, and returns the full URL string based on `server.uri()`.

**Call relations**: Remote installed-bundle sync tests call this helper to create downloadable artifacts referenced from installed-plugin fixtures.

*Call graph*: called by 4 (app_server_startup_sync_downloads_remote_installed_plugin_bundles, plugin_installed_includes_created_by_me_when_remote_plugins_enabled, plugin_installed_starts_remote_installed_bundle_sync, plugin_list_sync_upgrades_and_removes_remote_installed_plugin_bundles); 5 external calls (given, new, format!, method, path).


##### `remote_plugin_bundle_tar_gz_bytes`  (lines 3926–3950)

```
fn remote_plugin_bundle_tar_gz_bytes(plugin_name: &str) -> Result<Vec<u8>>
```

**Purpose**: Builds a simple tar.gz bundle for a remote plugin containing a plugin manifest and one skill file. It is the artifact generator used by remote bundle sync tests.

**Data flow**: Formats a minimal plugin manifest JSON string and a sample skill markdown file, creates a gzip encoder and tar builder, appends `.codex-plugin/plugin.json` and `skills/plan-work/SKILL.md` with mode `0o644`, finalizes the archive, and returns the compressed bytes.

**Call relations**: Bundle sync tests call this helper before mounting bundle download endpoints. It is the plugin-list suite's simpler counterpart to the more configurable bundle builders in the install suite.

*Call graph*: called by 4 (app_server_startup_sync_downloads_remote_installed_plugin_bundles, plugin_installed_includes_created_by_me_when_remote_plugins_enabled, plugin_installed_starts_remote_installed_bundle_sync, plugin_list_sync_upgrades_and_removes_remote_installed_plugin_bundles); 6 external calls (new, new, default, format!, new, new_gnu).


##### `write_installed_plugin`  (lines 3952–3958)

```
fn write_installed_plugin(
    codex_home: &TempDir,
    marketplace_name: &str,
    plugin_name: &str,
) -> Result<()>
```

**Purpose**: Convenience wrapper that writes an installed plugin cache entry using version `local`. It is used for local installed-cache fixtures where versioning is not under test.

**Data flow**: Forwards the temp home, marketplace name, and plugin name to `write_installed_plugin_with_version(..., "local")` and returns its result.

**Call relations**: Many local installed/list tests call this helper to seed cache directories without caring about explicit version strings.

*Call graph*: calls 1 internal fn (write_installed_plugin_with_version); called by 5 (plugin_installed_ignores_local_cache_without_catalog, plugin_installed_includes_installed_plugins_and_explicit_install_suggestions, plugin_installed_prefers_remote_curated_conflicts_when_remote_plugin_enabled, plugin_list_includes_install_and_enabled_state_from_config, plugin_list_uses_home_config_for_enabled_state).


##### `write_installed_plugin_with_version`  (lines 3960–3979)

```
fn write_installed_plugin_with_version(
    codex_home: &TempDir,
    marketplace_name: &str,
    plugin_name: &str,
    plugin_version: &str,
) -> Result<()>
```

**Purpose**: Creates an installed plugin cache directory and writes a minimal `plugin.json` for a specific marketplace, plugin name, and version. It is used when tests need explicit versioned cache paths.

**Data flow**: Builds `<codex_home>/plugins/cache/<marketplace>/<plugin>/<version>/.codex-plugin`, creates the directory tree, writes `plugin.json` containing the plugin name, and returns `Result<()>`.

**Call relations**: The versioned bundle upgrade/removal test calls this helper directly, while simpler tests use `write_installed_plugin` as a wrapper.

*Call graph*: called by 2 (plugin_list_sync_upgrades_and_removes_remote_installed_plugin_bundles, write_installed_plugin); 4 external calls (path, format!, create_dir_all, write).


##### `write_plugin_sync_config`  (lines 3981–4002)

```
fn write_plugin_sync_config(codex_home: &std::path::Path, base_url: &str) -> std::io::Result<()>
```

**Purpose**: Writes config enabling plugins, pointing at a backend base URL, and seeding explicit enabled flags for several curated plugin ids. It is used by featured-plugin sync tests.

**Data flow**: Formats a TOML file containing `chatgpt_base_url`, `[features] plugins = true`, and `[plugins."..."] enabled = ...` entries for `linear`, `gmail`, and `calendar`, then writes it to `codex_home/config.toml`.

**Call relations**: Featured-plugin tests call this helper before startup so the server has both a backend URL and local curated plugin config state.

*Call graph*: called by 2 (plugin_list_fetches_featured_plugin_ids_without_chatgpt_auth, plugin_list_uses_warmed_featured_plugin_ids_cache_on_first_request); 3 external calls (join, format!, write).


##### `write_remote_plugin_catalog_config`  (lines 4004–4020)

```
fn write_remote_plugin_catalog_config(
    codex_home: &std::path::Path,
    base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes config enabling plugins and remote-plugin support against a supplied backend base URL. It is the standard setup helper for remote catalog tests.

**Data flow**: Formats and writes `config.toml` containing `chatgpt_base_url = "{base_url}"` and `[features] plugins = true` plus `remote_plugin = true`.

**Call relations**: Most remote catalog and bundle sync tests call this helper before writing auth and starting the server.

*Call graph*: called by 8 (app_server_startup_sync_downloads_remote_installed_plugin_bundles, plugin_list_does_not_append_global_remote_when_marketplace_kinds_are_explicit, plugin_list_includes_api_curated_marketplace_for_api_auth_when_remote_plugin_enabled, plugin_list_includes_remote_marketplaces_when_remote_plugin_enabled, plugin_list_marks_remote_plugin_disabled_by_admin, plugin_list_sync_upgrades_and_removes_remote_installed_plugin_bundles, plugin_list_uses_cached_global_remote_catalog_and_refreshes_it, plugin_list_vertical_kind_noops_when_remote_plugin_enabled); 3 external calls (join, format!, write).


##### `write_openai_curated_marketplace`  (lines 4022–4033)

```
fn write_openai_curated_marketplace(
    codex_home: &std::path::Path,
    plugin_names: &[&str],
) -> std::io::Result<()>
```

**Purpose**: Writes the standard local OpenAI curated marketplace fixture under the home `.tmp/plugins` area. It is a thin wrapper over the generic curated-marketplace writer.

**Data flow**: Calls `write_curated_marketplace` with manifest name `marketplace.json`, marketplace name `openai-curated`, no explicit display name, and the supplied plugin names.

**Call relations**: Several curated-marketplace tests use this helper to seed local curated plugin catalogs without repeating manifest naming details.

*Call graph*: calls 1 internal fn (write_curated_marketplace); called by 4 (plugin_installed_includes_installed_plugins_and_explicit_install_suggestions, plugin_installed_prefers_remote_curated_conflicts_when_remote_plugin_enabled, plugin_list_fetches_featured_plugin_ids_without_chatgpt_auth, plugin_list_uses_warmed_featured_plugin_ids_cache_on_first_request).


##### `write_openai_api_curated_marketplace`  (lines 4035–4046)

```
fn write_openai_api_curated_marketplace(
    codex_home: &std::path::Path,
    plugin_names: &[&str],
) -> std::io::Result<()>
```

**Purpose**: Writes the API-curated marketplace fixture under the home `.tmp/plugins` area with display name `OpenAI Curated`. It supports API-auth marketplace tests.

**Data flow**: Calls `write_curated_marketplace` with manifest name `api_marketplace.json`, marketplace name `openai-api-curated`, display name `Some("OpenAI Curated")`, and the supplied plugin names.

**Call relations**: Only the API-auth curated-marketplace test uses this helper. It specializes the generic curated-marketplace writer for the API surface.

*Call graph*: calls 1 internal fn (write_curated_marketplace); called by 1 (plugin_list_includes_api_curated_marketplace_for_api_auth_when_remote_plugin_enabled).


##### `write_curated_marketplace`  (lines 4048–4109)

```
fn write_curated_marketplace(
    codex_home: &std::path::Path,
    manifest_name: &str,
    marketplace_name: &str,
    display_name: Option<&str>,
    plugin_names: &[&str],
) -> std::io::Result<()>
```

**Purpose**: Creates a curated marketplace fixture under `.tmp/plugins`, including plugin manifests and a pinned SHA file. It simulates the curated plugin bundle layout used by the app-server.

**Data flow**: Creates `.tmp/plugins/.git` and `.tmp/plugins/.agents/plugins`, formats a marketplace JSON listing each supplied plugin as a local source under `./plugins/<name>`, optionally includes a marketplace interface display name, writes the manifest under the requested manifest name, creates each plugin's `.codex-plugin/plugin.json`, ensures `.tmp` exists under `codex_home`, and writes `.tmp/plugins.sha` containing `TEST_CURATED_PLUGIN_SHA`.

**Call relations**: Both curated-marketplace wrappers delegate to this function. It is the core fixture builder for local curated plugin catalogs used across installed/list and featured-plugin tests.

*Call graph*: called by 2 (write_openai_api_curated_marketplace, write_openai_curated_marketplace); 4 external calls (join, format!, create_dir_all, write).


##### `write_plugin_share_local_path_mapping`  (lines 4111–4130)

```
fn write_plugin_share_local_path_mapping(
    codex_home: &std::path::Path,
    remote_plugin_id: &str,
    plugin_path: &AbsolutePathBuf,
) -> std::io::Result<()>
```

**Purpose**: Writes the `.tmp/plugin-share-local-paths-v1.json` mapping from remote plugin ids to local plugin paths. It enables local plugins to surface share-context metadata.

**Data flow**: Builds a JSON object `{ localPluginPathsByRemotePluginId: { remote_plugin_id: plugin_path } }`, serializes it prettily, ensures `codex_home/.tmp` exists, and writes the contents plus a trailing newline to `plugin-share-local-paths-v1.json`.

**Call relations**: The local share-context list test calls this helper before startup so the server can enrich matching local plugin summaries with remote share metadata.

*Call graph*: called by 1 (plugin_list_returns_share_context_for_shared_local_plugin); 8 external calls (join, format!, new, json!, to_string_pretty, to_value, create_dir_all, write).


### `app-server/tests/suite/v2/plugin_read.rs`

`test` · `request handling`

This file focuses on detail-oriented plugin APIs rather than marketplace enumeration. The tests cover `plugin/read` source validation, remote plugin detail fetches from ChatGPT backend endpoints, local plugin bundle inspection, remote skill content reads, and the interaction between local share mappings and remote share metadata. Remote tests write config enabling `remote_plugin`, install ChatGPT auth, and mount wiremock handlers for `/ps/plugins/{id}`, `/ps/plugins/installed`, and sometimes `/connectors/directory/list`; local tests create repository marketplaces and plugin bundles directly on disk.

The assertions are concrete and protocol-level. For remote plugins, tests verify canonical marketplace naming, `PluginSource::Remote`, installed/enabled state merged from installed-plugin listings, `PluginAvailability::DisabledByAdmin`, `share_url`, `keywords`, normalized default prompts, app template summaries, and filtering of MCP servers that overlap with app-manifest entries. For local plugins, the suite checks canonicalization of `openai-curated`, share-context enrichment from `.tmp/plugin-share-local-paths-v1.json`, fallback behavior when remote auth is unavailable, malformed share-mapping failures, detailed bundle inspection of skills, hooks, apps, and MCP servers, and the rule that uninstalled git-source plugins are described textually without cloning or creating staging directories. The helper `start_apps_server` launches a tiny Axum connectors backend that validates auth headers and `external_logos=true`, allowing tests to verify app category extraction from `AppMetadata` and the API-key-auth rule that hides apps while still exposing MCP servers. Additional helpers write installed cache entries, plugin-enabled config, local marketplaces, plugin sources, connector config, remote-plugin config, and share-path mappings.

#### Function details

##### `plugin_read_rejects_missing_read_source`  (lines 57–83)

```
async fn plugin_read_rejects_missing_read_source() -> Result<()>
```

**Purpose**: Checks that `plugin/read` requires exactly one source selector and rejects requests that specify neither a local marketplace path nor a remote marketplace name.

**Data flow**: Creates a temp home, starts and initializes `TestAppServer`, sends `PluginReadParams` with both source fields `None`, waits for the error response for that request id, and asserts code `-32600` with a message explaining that exactly one of `marketplacePath` or `remoteMarketplaceName` is required.

**Call relations**: This is a pure request-validation test run directly by the harness. It fails before any marketplace lookup or backend access.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, Integer, assert!, assert_eq!, timeout).


##### `plugin_read_rejects_multiple_read_sources`  (lines 86–114)

```
async fn plugin_read_rejects_multiple_read_sources() -> Result<()>
```

**Purpose**: Verifies that specifying both a local marketplace path and a remote marketplace name is invalid for `plugin/read`. It complements the missing-source validation case.

**Data flow**: Creates a temp home, starts and initializes the server, constructs an absolute marketplace path, sends `PluginReadParams` with both source fields populated, waits for the error response, and asserts code `-32600` with the same exclusivity message.

**Call relations**: Like the previous test, this one covers semantic request validation before any plugin detail resolution occurs.

*Call graph*: calls 2 internal fn (new, try_from); 5 external calls (new, Integer, assert!, assert_eq!, timeout).


##### `plugin_read_returns_remote_mcp_servers_when_uninstalled`  (lines 117–290)

```
async fn plugin_read_returns_remote_mcp_servers_when_uninstalled() -> Result<()>
```

**Purpose**: Checks that reading an uninstalled remote plugin returns MCP servers that are not already represented by app-manifest entries, and also returns app details from the connectors directory. It validates remote detail mapping plus app/MCP deduplication.

**Data flow**: Creates temp home and mock server, writes config enabling plugins and apps, writes ChatGPT auth, mounts a remote plugin detail body containing app manifest entry `example-server -> example-app`, two remote MCP servers (`example-server`, `other-server`), and legacy/default prompt fields, mounts an empty global installed response, mounts a connectors directory response containing `example-app`, starts and initializes the server, sends `plugin/read` for remote marketplace `openai-curated-remote` and the remote plugin id, deserializes `PluginReadResponse`, and asserts marketplace naming, remote source/id, normalized default prompt, `mcp_servers == ["other-server"]`, and returned app ids `== ["example-app"]`.

**Call relations**: This test covers the remote detail happy path for an uninstalled plugin. It combines backend detail, installed-state, and connectors-directory fixtures to verify the endpoint's final merged view.

*Call graph*: calls 2 internal fn (new, new); 16 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, json! (+6 more)).


##### `plugin_read_returns_share_context_for_shared_remote_plugin`  (lines 293–443)

```
async fn plugin_read_returns_share_context_for_shared_remote_plugin() -> Result<()>
```

**Purpose**: Verifies that reading a shared remote plugin returns canonical marketplace name `workspace-shared-with-me` and a fully populated `share_context`, regardless of whether the request used the private-specific or generic shared marketplace alias.

**Data flow**: Creates temp home and mock server, writes remote-plugin config/auth, mounts a workspace-scoped remote plugin detail body with discoverability `PRIVATE`, creator metadata, share URL, share principals, and release version `2.3.4`, mounts an empty workspace installed response, starts and initializes the server, then loops over two requested remote marketplace names (`workspace-shared-with-me-private` and `workspace-shared-with-me`). For each, it sends `plugin/read`, deserializes the response, and asserts canonical marketplace name, summary id/remote id, and detailed `share_context` fields including remote version, discoverability, creator ids/names, share URL, and typed principals.

**Call relations**: This test covers alias normalization and share-context mapping for shared remote plugins. It uses the same backend fixture for two request variants to prove canonicalization happens in the response.

*Call graph*: calls 3 internal fn (new, new, write_remote_plugin_catalog_config); 14 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, timeout (+4 more)).


##### `plugin_read_includes_share_url_for_admin_disabled_remote_plugin`  (lines 446–671)

```
async fn plugin_read_includes_share_url_for_admin_disabled_remote_plugin() -> Result<()>
```

**Purpose**: Checks that reading an admin-disabled remote plugin still returns its share URL, app templates, keywords, normalized prompts, and disabled skill state. It validates rich detail mapping even when availability is `DisabledByAdmin`.

**Data flow**: Creates temp home and mock server, writes remote-plugin config/auth, mounts a remote plugin detail body with `status: DISABLED_BY_ADMIN`, `share_url`, app templates, keywords, interface metadata including both legacy and modern prompt fields, and one skill, mounts a global installed response marking the plugin installed but disabled with `disabled_skill_names: ["plan-work"]`, starts and initializes the server, sends `plugin/read`, deserializes `PluginReadResponse`, and asserts marketplace/source/id, installed/enabled/availability fields, `share_url`, description, keywords, normalized default prompts, one disabled skill with no local path, zero apps, and two `AppTemplateSummary` values with the expected typed unavailable reason.

**Call relations**: This test exercises the richest remote detail mapping path in the file. It merges remote detail metadata with installed-state data to verify disabled skills and availability are surfaced correctly.

*Call graph*: calls 3 internal fn (new, new, write_remote_plugin_catalog_config); 14 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, timeout (+4 more)).


##### `plugin_skill_read_reads_remote_skill_contents_when_remote_plugin_enabled`  (lines 674–735)

```
async fn plugin_skill_read_reads_remote_skill_contents_when_remote_plugin_enabled() -> Result<()>
```

**Purpose**: Verifies that `pluginSkill/read` fetches remote skill markdown contents from the backend when remote plugins are enabled. It checks the dedicated skill-read endpoint rather than full plugin detail.

**Data flow**: Creates temp home and mock server, writes remote-plugin config/auth, mounts `GET /backend-api/ps/plugins/<id>/skills/plan-work` returning a JSON body with `skill_md_contents`, starts and initializes the server, sends `PluginSkillReadParams` naming the remote marketplace, plugin id, and skill name, deserializes `PluginSkillReadResponse`, and asserts `contents` equals the returned markdown string.

**Call relations**: This test covers the remote skill-read endpoint specifically. It is independent of installed-state or marketplace listing and uses only the remote skill backend fixture.

*Call graph*: calls 3 internal fn (new, new, write_remote_plugin_catalog_config); 13 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, timeout (+3 more)).


##### `plugin_read_maps_missing_remote_plugin_to_invalid_request`  (lines 738–786)

```
async fn plugin_read_maps_missing_remote_plugin_to_invalid_request() -> Result<()>
```

**Purpose**: Checks that a missing remote plugin detail fetch (HTTP 404) is surfaced as a JSON-RPC invalid request rather than an internal error. It validates error mapping for nonexistent remote plugins.

**Data flow**: Creates temp home and mock server, writes remote-plugin config/auth, mounts `GET /backend-api/ps/plugins/plugins~Plugin_missing` returning 404 with a small JSON body, starts and initializes the server, sends `plugin/read` for that remote plugin id, waits for the error response, and asserts code `-32600` with a message containing `read remote plugin details: remote plugin catalog request`.

**Call relations**: This test covers backend-error translation in the remote detail path. It proves not-found is treated as a bad client request rather than a server failure.

*Call graph*: calls 3 internal fn (new, new, write_remote_plugin_catalog_config); 13 external calls (given, start, new, new, Integer, write_chatgpt_auth, assert!, assert_eq!, format!, timeout (+3 more)).


##### `plugin_read_rejects_remote_marketplace_when_plugins_are_disabled`  (lines 789–838)

```
async fn plugin_read_rejects_remote_marketplace_when_plugins_are_disabled() -> Result<()>
```

**Purpose**: Ensures remote plugin reads are blocked when plugins are globally disabled, even if `remote_plugin = true` is set. It validates top-level feature gating for detail reads.

**Data flow**: Creates temp home and mock server, writes config with `plugins = false` and `remote_plugin = true`, writes ChatGPT auth, starts and initializes the server, sends `plugin/read` for remote marketplace `openai-curated-remote`, waits for the error response, and asserts code `-32600` with a message containing `remote plugin read is not enabled`.

**Call relations**: This test covers feature gating before any remote backend call. It parallels similar gating tests in the list and install suites.

*Call graph*: calls 2 internal fn (new, new); 9 external calls (start, new, Integer, write_chatgpt_auth, assert!, assert_eq!, format!, write, timeout).


##### `plugin_read_rejects_invalid_remote_plugin_name`  (lines 841–869)

```
async fn plugin_read_rejects_invalid_remote_plugin_name() -> Result<()>
```

**Purpose**: Checks that malformed remote plugin ids are rejected before any backend access. It enforces the allowed character set for remote detail reads.

**Data flow**: Writes remote-plugin config pointing at a dummy backend, starts and initializes the server, sends `plugin/read` with `plugin_name` set to `linear/../../oops`, waits for the error response, and asserts code `-32600` with message fragments `invalid remote plugin id` and the allowed-character explanation.

**Call relations**: This is an early validation test for the remote read path. It does not require a live backend because the request should fail locally.

*Call graph*: calls 2 internal fn (new, write_remote_plugin_catalog_config); 5 external calls (new, Integer, assert!, assert_eq!, timeout).


##### `plugin_read_returns_canonical_openai_curated_marketplace_name`  (lines 872–927)

```
async fn plugin_read_returns_canonical_openai_curated_marketplace_name() -> Result<()>
```

**Purpose**: Verifies that reading a local plugin from an `openai-curated` marketplace returns that canonical marketplace name in the response. It checks naming normalization for local curated plugins.

**Data flow**: Creates temp home and repo root, writes a local marketplace named `openai-curated`, writes a plugin manifest with description, writes config enabling plugins and that plugin id, writes an installed cache entry, starts and initializes the server, sends `plugin/read` with the absolute marketplace path and plugin name, deserializes `PluginReadResponse`, and asserts `marketplace_name == "openai-curated"`, `marketplace_path` matches the request path, and the summary id/name are canonicalized accordingly.

**Call relations**: This test covers local curated naming rather than remote behavior. It uses installed-cache and marketplace fixtures to ensure the plugin is fully resolvable.

*Call graph*: calls 4 internal fn (new, write_installed_plugin, write_plugin_marketplace, try_from); 7 external calls (new, Integer, to_response, assert_eq!, create_dir_all, write, timeout).


##### `plugin_read_returns_share_context_for_shared_local_plugin`  (lines 930–1070)

```
async fn plugin_read_returns_share_context_for_shared_local_plugin() -> Result<()>
```

**Purpose**: Checks that a local plugin mapped to a remote shared plugin id is enriched with remote share metadata fetched from the backend. It validates local-to-remote share-context hydration when ChatGPT auth is available.

**Data flow**: Creates temp home, repo root, and mock server, writes remote-plugin config/auth, writes a local marketplace and plugin manifest with version `1.2.3`, writes `.mcp.json`, writes a plugin-share local-path mapping from `plugins_123` to the plugin path, mounts `GET /backend-api/ps/plugins/plugins_123` returning workspace-scoped remote share metadata with discoverability `UNLISTED`, creator info, share URL, principals, and remote release version `1.2.4`, starts and initializes the server, sends `plugin/read` for the local marketplace/plugin, deserializes the response, and asserts `remote_plugin_id == None`, `local_version == Some("1.2.3")`, and `share_context` contains the remote id, remote version, discoverability, share URL, creator metadata, and typed principals.

**Call relations**: This test covers the branch where local plugin detail is augmented by a remote share lookup. It depends on both the local share-path mapping file and a remote detail backend fixture.

*Call graph*: calls 6 internal fn (new, new, write_plugin_marketplace, write_plugin_share_local_path_mapping, write_remote_plugin_catalog_config, try_from); 16 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, json! (+6 more)).


##### `plugin_read_keeps_remote_version_when_share_principals_are_missing`  (lines 1073–1175)

```
async fn plugin_read_keeps_remote_version_when_share_principals_are_missing() -> Result<()>
```

**Purpose**: Verifies that when the remote share lookup returns `share_principals: null`, the server still preserves the remote version in `share_context` but drops discoverability and other share metadata. It checks partial-share-data fallback behavior.

**Data flow**: Sets up the same local marketplace, plugin manifest, `.mcp.json`, share-path mapping, remote-plugin config/auth, and backend detail lookup as the previous test, except the remote detail body has `share_principals: null`. After sending `plugin/read` and deserializing the response, it asserts `remote_plugin_id == None`, `local_version == Some("1.2.3")`, and `share_context` retains `remote_plugin_id` and `remote_version == Some("1.2.4")` while all other optional fields are `None`.

**Call relations**: This test is a nuanced variant of the shared-local-plugin case. It proves the server treats missing principals as a signal to suppress share metadata while still preserving version linkage.

*Call graph*: calls 6 internal fn (new, new, write_plugin_marketplace, write_plugin_share_local_path_mapping, write_remote_plugin_catalog_config, try_from); 16 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, json! (+6 more)).


##### `plugin_read_falls_back_to_local_share_context_without_remote_auth`  (lines 1178–1228)

```
async fn plugin_read_falls_back_to_local_share_context_without_remote_auth() -> Result<()>
```

**Purpose**: Checks that when no remote auth is available, a local plugin with a share-path mapping still gets a minimal `share_context` derived solely from the local mapping file. It validates offline/local fallback behavior.

**Data flow**: Creates temp home and repo root, writes plugins-enabled config, writes a local marketplace and plugin source, writes a plugin-share local-path mapping from `plugins_123` to the plugin path, starts and initializes the server without ChatGPT auth, sends `plugin/read` for the local plugin, deserializes the response, and asserts `remote_plugin_id == None`, `local_version == None`, and `share_context` contains only `remote_plugin_id` with all other fields absent.

**Call relations**: This test covers the no-remote-auth branch of share-context enrichment. It shows the server can still expose the remote id from local mapping without attempting backend hydration.

*Call graph*: calls 6 internal fn (new, write_plugin_marketplace, write_plugin_share_local_path_mapping, write_plugin_source, write_plugins_enabled_config, try_from); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `plugin_read_fails_on_malformed_share_mapping`  (lines 1231–1277)

```
async fn plugin_read_fails_on_malformed_share_mapping() -> Result<()>
```

**Purpose**: Ensures that an invalid `.tmp/plugin-share-local-paths-v1.json` file causes `plugin/read` to fail with an internal error. It validates error handling for corrupted local share metadata.

**Data flow**: Creates temp home and repo root, writes plugins-enabled config, writes a local marketplace and plugin source, creates `.tmp`, writes `not valid json` into `plugin-share-local-paths-v1.json`, starts and initializes the server, sends `plugin/read` for the local plugin, waits for a `JSONRPCError`, and asserts code `-32603` with a message containing `failed to load plugin share local path mapping`.

**Call relations**: This test covers a local metadata-loading failure that occurs during plugin detail assembly. It is the error-path counterpart to the share-context enrichment tests.

*Call graph*: calls 5 internal fn (new, write_plugin_marketplace, write_plugin_source, write_plugins_enabled_config, try_from); 7 external calls (new, Integer, assert!, assert_eq!, create_dir_all, write, timeout).


##### `plugin_read_returns_plugin_details_with_bundle_contents`  (lines 1280–1556)

```
async fn plugin_read_returns_plugin_details_with_bundle_contents() -> Result<()>
```

**Purpose**: Verifies that reading a local installed plugin returns rich detail assembled from bundle contents: description, keywords, interface metadata, filtered skills, hook summaries, apps, and MCP servers. It is the main local plugin-detail happy-path test.

**Data flow**: Creates temp home and repo root, prepares a plugin bundle with `.codex-plugin/plugin.json`, two skills (one CODEX-visible and one CHATGPT-only), per-skill `agents/openai.yaml` product policies, `.app.json`, `.mcp.json`, and `hooks/hooks.json`, writes a marketplace JSON with category `Design`, writes config enabling plugins, disabling one skill by name, enabling the plugin, and disabling one specific hook state key, writes an installed cache entry, starts and initializes the server, sends `plugin/read` with the marketplace path and plugin name, deserializes `PluginReadResponse`, and asserts marketplace/source/id, description, installed/enabled state, install/auth policies, interface display name/category/default prompts, keywords, exactly one visible skill (`demo-plugin:thread-summarizer`) marked disabled, three hook summaries with stable keys and event names, one app summary for `gmail` with install URL/category, and one MCP server `demo`.

**Call relations**: This is the most comprehensive local detail test in the file. It exercises bundle parsing, product filtering, config-driven skill/hook enablement, app extraction, and MCP server enumeration in one end-to-end read.

*Call graph*: calls 3 internal fn (new, write_installed_plugin, try_from); 8 external calls (new, Integer, to_response, assert!, assert_eq!, create_dir_all, write, timeout).


##### `plugin_read_returns_app_metadata_category`  (lines 1559–1660)

```
async fn plugin_read_returns_app_metadata_category() -> Result<()>
```

**Purpose**: Checks that app categories in plugin detail come from connector `AppMetadata.categories` when available. It validates category extraction from the connectors directory.

**Data flow**: Builds two `AppInfo` connectors, one with `AppMetadata.categories = ["Productivity"]` and one without metadata, starts the mock apps server, writes connectors config and ChatGPT auth, creates a local marketplace and plugin source referencing both app ids, starts and initializes the app server, sends `plugin/read`, deserializes the response, and asserts the returned plugin apps map to categories `Some("Productivity")` for `alpha` and `None` for `beta`. It then aborts the apps server task.

**Call relations**: This test covers connector-directory enrichment in local plugin detail reads. It uses `start_apps_server` and `write_connectors_config` to make app metadata available to the server.

*Call graph*: calls 7 internal fn (new, new, start_apps_server, write_connectors_config, write_plugin_marketplace, write_plugin_source, try_from); 7 external calls (new, Integer, to_response, write_chatgpt_auth, assert_eq!, timeout, vec!).


##### `plugin_read_hides_apps_for_api_key_auth`  (lines 1663–1748)

```
async fn plugin_read_hides_apps_for_api_key_auth() -> Result<()>
```

**Purpose**: Verifies that under API-key auth the plugin detail response hides app entries even if `.app.json` exists, while still exposing MCP servers. It enforces auth-mode-specific app visibility.

**Data flow**: Starts a mock apps server exposing connector `alpha`, writes connectors config, writes an `auth.json` containing only `OPENAI_API_KEY`, creates a local marketplace and plugin source referencing `alpha`, writes `.mcp.json` with MCP server `alpha`, starts `TestAppServer` with environment variables clearing token-based auth, initializes it, sends `plugin/read`, deserializes the response, and asserts `plugin.apps` is empty while `plugin.mcp_servers == ["alpha"]`. It then aborts the apps server task.

**Call relations**: This test covers the API-key-auth branch of plugin detail assembly. It contrasts with the app-metadata test by proving app visibility is suppressed even though connector and MCP metadata exist.

*Call graph*: calls 6 internal fn (new_with_env, start_apps_server, write_connectors_config, write_plugin_marketplace, write_plugin_source, try_from); 8 external calls (new, Integer, to_response, assert!, assert_eq!, write, timeout, vec!).


##### `plugin_read_accepts_legacy_string_default_prompt`  (lines 1751–1814)

```
async fn plugin_read_accepts_legacy_string_default_prompt() -> Result<()>
```

**Purpose**: Checks that a local plugin manifest using legacy string `defaultPrompt` is normalized into a one-element prompt vector in plugin detail responses.

**Data flow**: Creates temp home and repo root, prepares a local marketplace and plugin manifest whose interface contains `defaultPrompt` as a string, writes plugins-enabled config, starts and initializes the server, sends `plugin/read`, deserializes the response, and asserts the summary interface `default_prompt` equals `Some(vec!["Starter prompt for trying a plugin"])`.

**Call relations**: This test is the plugin-read counterpart to the list-side legacy prompt normalization test. It covers backward-compatible manifest parsing in detail responses.

*Call graph*: calls 3 internal fn (new, write_plugins_enabled_config, try_from); 7 external calls (new, Integer, to_response, assert_eq!, create_dir_all, write, timeout).


##### `plugin_read_describes_uninstalled_git_source_without_cloning`  (lines 1817–1884)

```
async fn plugin_read_describes_uninstalled_git_source_without_cloning() -> Result<()>
```

**Purpose**: Verifies that reading an uninstalled git-source plugin returns a descriptive placeholder message instead of cloning the repository or exposing bundle contents. It checks the non-installing read path for cross-repo plugins.

**Data flow**: Creates temp home and repo root, constructs a file URL to a nonexistent remote repo, writes a marketplace JSON with a `git-subdir` source, writes plugins-enabled config, starts and initializes the server, sends `plugin/read` for `toolkit`, deserializes the response, and asserts the description explains that the plugin is cross-repo and must be installed to view more details, including the source URL and subpath. It also asserts the plugin is not installed, has empty skills/apps/MCP servers, and that no staging directory under `plugins/.marketplace-plugin-source-staging` was created.

**Call relations**: This test covers the read-only description path for uninstalled git plugins. It proves the endpoint does not clone or stage sources merely to answer a detail request.

*Call graph*: calls 3 internal fn (new, write_plugins_enabled_config, try_from); 10 external calls (new, Integer, to_response, assert!, assert_eq!, format!, create_dir_all, write, timeout, from_directory_path).


##### `plugin_read_returns_invalid_request_when_plugin_is_missing`  (lines 1887–1935)

```
async fn plugin_read_returns_invalid_request_when_plugin_is_missing() -> Result<()>
```

**Purpose**: Checks that requesting a plugin name absent from the local marketplace returns a JSON-RPC invalid request. It validates local marketplace lookup failure handling.

**Data flow**: Creates temp home and repo root, prepares `.git` and `.agents/plugins`, writes a marketplace containing only `demo-plugin`, writes plugins-enabled config, starts and initializes the server, sends `plugin/read` for `missing-plugin`, waits for the error response, and asserts code `-32600` with a message containing `plugin `missing-plugin` was not found`.

**Call relations**: This test covers local plugin-name resolution before any bundle inspection. It is the local counterpart to the missing remote plugin test.

*Call graph*: calls 3 internal fn (new, write_plugins_enabled_config, try_from); 7 external calls (new, Integer, assert!, assert_eq!, create_dir_all, write, timeout).


##### `plugin_read_returns_invalid_request_when_plugin_manifest_is_missing`  (lines 1938–1984)

```
async fn plugin_read_returns_invalid_request_when_plugin_manifest_is_missing() -> Result<()>
```

**Purpose**: Verifies that a local plugin source directory without a valid `.codex-plugin/plugin.json` causes `plugin/read` to fail as an invalid request. It enforces manifest presence for local detail reads.

**Data flow**: Creates temp home and repo root, prepares a marketplace pointing at `plugins/demo-plugin`, creates the plugin directory without a manifest, writes plugins-enabled config, starts and initializes the server, sends `plugin/read` for `demo-plugin`, waits for the error response, and asserts code `-32600` with a message containing `missing or invalid plugin.json`.

**Call relations**: This test covers local bundle validation after marketplace lookup succeeds. It ensures the endpoint does not fabricate details for malformed plugin sources.

*Call graph*: calls 3 internal fn (new, write_plugins_enabled_config, try_from); 7 external calls (new, Integer, assert!, assert_eq!, create_dir_all, write, timeout).


##### `write_installed_plugin`  (lines 1986–2003)

```
fn write_installed_plugin(
    codex_home: &TempDir,
    marketplace_name: &str,
    plugin_name: &str,
) -> Result<()>
```

**Purpose**: Creates a minimal installed-plugin cache entry under `plugins/cache/<marketplace>/<plugin>/local/.codex-plugin/plugin.json`. It is used by local plugin-read tests that need the plugin marked installed.

**Data flow**: Builds the cache directory path under the temp home, creates it, writes `plugin.json` containing the plugin name, and returns `Result<()>`.

**Call relations**: The canonical curated-name test and the rich local bundle-detail test call this helper before startup so the server reports the plugin as installed.

*Call graph*: called by 2 (plugin_read_returns_canonical_openai_curated_marketplace_name, plugin_read_returns_plugin_details_with_bundle_contents); 4 external calls (path, format!, create_dir_all, write).


##### `write_plugins_enabled_config`  (lines 2005–2013)

```
fn write_plugins_enabled_config(codex_home: &TempDir) -> Result<()>
```

**Purpose**: Writes the minimal config enabling plugins for local plugin-read tests. It is a small convenience wrapper around a single config file write.

**Data flow**: Writes `[features]
plugins = true
` to `codex_home/config.toml` and returns `Result<()>`.

**Call relations**: Several local plugin-read tests call this helper before starting `TestAppServer` when no remote backend configuration is needed.

*Call graph*: called by 6 (plugin_read_accepts_legacy_string_default_prompt, plugin_read_describes_uninstalled_git_source_without_cloning, plugin_read_fails_on_malformed_share_mapping, plugin_read_falls_back_to_local_share_context_without_remote_auth, plugin_read_returns_invalid_request_when_plugin_is_missing, plugin_read_returns_invalid_request_when_plugin_manifest_is_missing); 2 external calls (path, write).


##### `start_apps_server`  (lines 2020–2042)

```
async fn start_apps_server(connectors: Vec<AppInfo>) -> Result<(String, JoinHandle<()>)>
```

**Purpose**: Starts a tiny Axum server that serves connector-directory responses for plugin-read tests. It returns the base URL and the spawned server task handle.

**Data flow**: Wraps the supplied connector list in `AppsServerState` as JSON `{ apps: connectors, next_token: null }`, binds a random localhost TCP port, builds an Axum router exposing `/connectors/directory/list` and `/connectors/directory/list_workspace` via `list_directory_connectors`, spawns `axum::serve`, and returns `(http://addr, handle)`.

**Call relations**: The app-category and API-key-auth tests call this helper to simulate the connectors backend. It underpins `list_directory_connectors` and is simpler than the install suite's apps server because no MCP service is needed here.

*Call graph*: called by 2 (plugin_read_hides_apps_for_api_key_auth, plugin_read_returns_app_metadata_category); 9 external calls (new, new, new, bind, get, serve, format!, json!, spawn).


##### `list_directory_connectors`  (lines 2044–2073)

```
async fn list_directory_connectors(
    State(state): State<Arc<AppsServerState>>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<impl axum::response::IntoResponse, StatusCode>
```

**Purpose**: Implements the mock connectors-directory handler for plugin-read tests. It validates auth headers and `external_logos=true` before returning the configured connector list.

**Data flow**: Receives shared `AppsServerState`, request headers, and URI; checks `Authorization == Bearer chatgpt-token`, `chatgpt-account-id == account-123`, and that the query string contains `external_logos=true`. It returns `UNAUTHORIZED` or `BAD_REQUEST` on failed checks, otherwise locks and clones the stored JSON response and returns it as `Json`.

**Call relations**: Mounted by `start_apps_server`, this handler is exercised indirectly when the app-server enriches plugin apps from the connectors directory during `plugin/read`.

*Call graph*: 3 external calls (get, query, Json).


##### `write_connectors_config`  (lines 2075–2090)

```
fn write_connectors_config(codex_home: &std::path::Path, base_url: &str) -> std::io::Result<()>
```

**Purpose**: Writes config enabling plugins and connectors and pointing `chatgpt_base_url` at the mock connectors backend. It also selects file-backed auth credential stores needed by connector-related tests.

**Data flow**: Formats a TOML file containing `chatgpt_base_url`, `cli_auth_credentials_store = "file"`, `mcp_oauth_credentials_store = "file"`, and `[features] plugins = true`, `connectors = true`, then writes it to `codex_home/config.toml`.

**Call relations**: Connector-aware plugin-read tests call this helper before startup so the server can query the mock apps backend.

*Call graph*: called by 2 (plugin_read_hides_apps_for_api_key_auth, plugin_read_returns_app_metadata_category); 3 external calls (join, format!, write).


##### `write_remote_plugin_catalog_config`  (lines 2092–2108)

```
fn write_remote_plugin_catalog_config(
    codex_home: &std::path::Path,
    base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes config enabling plugins and remote-plugin support against a supplied backend base URL. It is the standard setup helper for remote plugin-read tests.

**Data flow**: Formats and writes `config.toml` containing `chatgpt_base_url = "{base_url}"` and `[features] plugins = true` plus `remote_plugin = true`.

**Call relations**: Most remote plugin-read and plugin-skill-read tests call this helper before writing ChatGPT auth and starting the server.

*Call graph*: called by 7 (plugin_read_includes_share_url_for_admin_disabled_remote_plugin, plugin_read_keeps_remote_version_when_share_principals_are_missing, plugin_read_maps_missing_remote_plugin_to_invalid_request, plugin_read_rejects_invalid_remote_plugin_name, plugin_read_returns_share_context_for_shared_local_plugin, plugin_read_returns_share_context_for_shared_remote_plugin, plugin_skill_read_reads_remote_skill_contents_when_remote_plugin_enabled); 3 external calls (join, format!, write).


##### `write_plugin_marketplace`  (lines 2110–2135)

```
fn write_plugin_marketplace(
    repo_root: &std::path::Path,
    marketplace_name: &str,
    plugin_name: &str,
    source_path: &str,
) -> std::io::Result<()>
```

**Purpose**: Creates a simple local marketplace fixture under a fake repository for plugin-read tests. It ensures the repository has `.git` and `.agents/plugins` directories and writes one local plugin entry.

**Data flow**: Creates `.git` and `.agents/plugins` under `repo_root`, formats a marketplace JSON containing the supplied marketplace name, plugin name, and local source path, writes it to `.agents/plugins/marketplace.json`, and returns the write result.

**Call relations**: Several local plugin-read tests call this helper before adding plugin bundle contents. It is the basic marketplace fixture writer for this file.

*Call graph*: called by 7 (plugin_read_fails_on_malformed_share_mapping, plugin_read_falls_back_to_local_share_context_without_remote_auth, plugin_read_hides_apps_for_api_key_auth, plugin_read_keeps_remote_version_when_share_principals_are_missing, plugin_read_returns_app_metadata_category, plugin_read_returns_canonical_openai_curated_marketplace_name, plugin_read_returns_share_context_for_shared_local_plugin); 4 external calls (join, format!, create_dir_all, write).


##### `write_plugin_source`  (lines 2137–2158)

```
fn write_plugin_source(
    repo_root: &std::path::Path,
    plugin_name: &str,
    app_ids: &[&str],
) -> Result<()>
```

**Purpose**: Creates a minimal local plugin source tree with `.codex-plugin/plugin.json` and `.app.json` listing the supplied app ids. It supports local plugin-read tests that need app metadata.

**Data flow**: Creates `<repo_root>/<plugin_name>/.codex-plugin`, writes `plugin.json` containing the plugin name, builds a JSON map from each app id to `{ "id": app_id }`, serializes it prettily as `.app.json`, and returns `Result<()>`.

**Call relations**: The malformed-share-mapping, local-share-fallback, API-key-auth, and app-category tests use this helper to create plugin bundles with app manifests.

*Call graph*: called by 4 (plugin_read_fails_on_malformed_share_mapping, plugin_read_falls_back_to_local_share_context_without_remote_auth, plugin_read_hides_apps_for_api_key_auth, plugin_read_returns_app_metadata_category); 6 external calls (join, format!, json!, to_vec_pretty, create_dir_all, write).


##### `write_plugin_share_local_path_mapping`  (lines 2160–2179)

```
fn write_plugin_share_local_path_mapping(
    codex_home: &std::path::Path,
    remote_plugin_id: &str,
    plugin_path: &AbsolutePathBuf,
) -> std::io::Result<()>
```

**Purpose**: Writes the local-path-to-remote-plugin-id mapping file used to enrich local plugin detail with share context. It is the same mapping format used by the list suite.

**Data flow**: Builds a JSON object mapping `remote_plugin_id` to the serialized `AbsolutePathBuf`, wraps it under `localPluginPathsByRemotePluginId`, pretty-prints it, ensures `codex_home/.tmp` exists, and writes it to `.tmp/plugin-share-local-paths-v1.json` with a trailing newline.

**Call relations**: The local share-context tests call this helper before startup so `plugin/read` can associate a local plugin path with a remote shared plugin id.

*Call graph*: called by 3 (plugin_read_falls_back_to_local_share_context_without_remote_auth, plugin_read_keeps_remote_version_when_share_principals_are_missing, plugin_read_returns_share_context_for_shared_local_plugin); 8 external calls (join, format!, json!, new, to_string_pretty, to_value, create_dir_all, write).


### `app-server/tests/suite/v2/marketplace_add.rs`

`test` · `request handling`

This test file builds a minimal local marketplace tree under a temporary Codex home and drives the app server through its JSON-RPC test harness. The fixture includes `.agents/plugins/marketplace.json` naming the marketplace `debug`, a plugin manifest at `plugins/sample/.codex-plugin/plugin.json`, and a marker file in the plugin payload. After starting `TestAppServer` and waiting for initialization under a fixed timeout, the test sends `MarketplaceAddParams` with a relative source path `./marketplace` and no Git ref or sparse checkout settings. It then waits for the matching response by integer request id, decodes the `JSONRPCResponse` into `MarketplaceAddResponse`, and compares concrete fields: the marketplace name must come from the marketplace manifest, `installed_root` must equal the canonical absolute path of the source directory, and `already_added` must be false on first add. The final assertion reads back `plugins/sample/marker.txt` through the returned installed root to prove the server preserved the local directory contents rather than synthesizing metadata only. The test’s main invariant is that local-directory marketplace adds resolve relative paths against the Codex home/config context and return canonical absolute installation roots.

#### Function details

##### `marketplace_add_local_directory_source`  (lines 17–62)

```
async fn marketplace_add_local_directory_source() -> Result<()>
```

**Purpose**: Creates a temporary local marketplace, invokes `marketplace/add`, and verifies the server reports and exposes that directory as the installed marketplace root.

**Data flow**: It allocates a `TempDir` for `codex_home`, constructs a `marketplace` subtree with marketplace and plugin JSON files plus a marker text file, then starts `TestAppServer` against that home. It sends `MarketplaceAddParams { source: "./marketplace", ref_name: None, sparse_paths: None }`, waits for the response tied to the returned numeric request id, converts the JSON-RPC payload into `MarketplaceAddResponse`, canonicalizes the expected source path into an `AbsolutePathBuf`, and asserts on response fields and the marker file contents read from `installed_root`.

**Call relations**: This is the file’s only test entrypoint. It drives the full flow itself: setup via filesystem writes, server startup via `TestAppServer::new` and `initialize`, request submission through the test harness, response decoding through `to_response`, and final validation through equality and existence assertions.

*Call graph*: calls 2 internal fn (new, from_absolute_path); 8 external calls (new, Integer, to_response, assert!, assert_eq!, create_dir_all, write, timeout).


### `app-server/tests/suite/v2/plugin_install.rs`

`test` · `request handling`

This is the largest plugin-install test suite and doubles as a fixture library for plugin installation scenarios. The top-level tests cover request validation (relative marketplace paths, missing or multiple install sources, invalid remote IDs), feature gating (`plugins`, `remote_plugin`, workspace plugin settings), local marketplace installs, and remote curated installs fetched from ChatGPT backend endpoints. Remote-install tests mount wiremock handlers for plugin detail, installed-plugin listings, bundle downloads, and install POSTs; they verify exact side effects in `codex_home/plugins/cache/<marketplace>/<plugin>/<version>`, including rewritten `plugin.json` version fields, persisted `.app.json`, bundled skills, and the invariant that remote installs are stored under the plugin name rather than the opaque remote plugin id.

The file also models connector-aware auth behavior. `start_apps_server` launches an Axum server exposing `/connectors/directory/list` and a streamable HTTP MCP service under `/api/codex/ps/mcp`; `AppsServerControl` tracks directory fetch counts, and `PluginInstallMcpServer` returns configured `Tool` definitions whose metadata includes `connector_id` and `connector_name`. Tests use this to prove `apps_needing_auth` is derived from inaccessible connectors, filtered against disallowed app ids, and that MCP OAuth discovery is skipped for ChatGPT dual-surface plugins but started when only plugin apps are disallowed or when API-key auth is used. Additional helpers write marketplace manifests, plugin bundles, `.mcp.json`, analytics config, and remote-plugin catalog config; polling helpers wait for analytics payloads, OAuth discovery requests, and exact backend request counts. The tarball builders create realistic `.tar.gz` bundles containing `.codex-plugin/plugin.json`, optional `.app.json`, optional `.mcp.json`, and a sample skill file so install flows exercise extraction logic rather than mocked file writes.

#### Function details

##### `plugin_install_rejects_relative_marketplace_paths`  (lines 73–97)

```
async fn plugin_install_rejects_relative_marketplace_paths() -> Result<()>
```

**Purpose**: Ensures raw JSON-RPC requests with a relative `marketplacePath` are rejected as invalid requests. It validates request-shape enforcement before any install logic runs.

**Data flow**: Creates a temp home, starts and initializes `TestAppServer`, sends a raw `plugin/install` request whose params contain `marketplacePath: "relative-marketplace.json"` and `pluginName`, waits for an error response for that request id, and asserts code `-32600` plus an `Invalid request` message fragment.

**Call relations**: This test directly exercises the endpoint's parameter validation branch using `send_raw_request` instead of typed params. It does not delegate to fixture helpers beyond server startup because the failure should occur before filesystem or marketplace access.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Integer, assert!, assert_eq!, json!, timeout).


##### `plugin_install_rejects_missing_install_source`  (lines 100–126)

```
async fn plugin_install_rejects_missing_install_source() -> Result<()>
```

**Purpose**: Checks that the endpoint requires exactly one install source and rejects requests that specify neither a local marketplace path nor a remote marketplace name.

**Data flow**: Starts an empty test server, sends `PluginInstallParams` with both `marketplace_path` and `remote_marketplace_name` set to `None`, waits for the error message, and asserts JSON-RPC code `-32600` with text explaining that exactly one of the two fields is required.

**Call relations**: This is a pure validation test run directly by the harness. It covers the branch where typed request deserialization succeeds but semantic validation fails before any install source is resolved.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, Integer, assert!, assert_eq!, timeout).


##### `plugin_install_rejects_multiple_install_sources`  (lines 129–157)

```
async fn plugin_install_rejects_multiple_install_sources() -> Result<()>
```

**Purpose**: Verifies that specifying both a local marketplace path and a remote marketplace name is also invalid. It complements the missing-source test by covering the opposite exclusivity violation.

**Data flow**: Creates a temp home, starts and initializes the server, constructs an absolute path to a would-be marketplace file, sends `PluginInstallParams` with both source fields populated, waits for the error response, and asserts code `-32600` and the same exclusivity message.

**Call relations**: Like the previous test, this one targets request validation before any marketplace loading. It uses `AbsolutePathBuf::try_from` only to satisfy the typed parameter shape.

*Call graph*: calls 2 internal fn (new, try_from); 5 external calls (new, Integer, assert!, assert_eq!, timeout).


##### `plugin_install_rejects_remote_marketplace_when_plugins_are_disabled`  (lines 160–192)

```
async fn plugin_install_rejects_remote_marketplace_when_plugins_are_disabled() -> Result<()>
```

**Purpose**: Confirms that remote plugin installation is blocked when the `plugins` feature flag is disabled in config. It ensures remote install cannot bypass the global plugin gate.

**Data flow**: Writes a `config.toml` with `[features] plugins = false`, starts and initializes the server, sends a remote install request naming a remote marketplace and plugin id, waits for the error response, and asserts code `-32600` with a message containing `remote plugin install is not enabled`.

**Call relations**: This test covers feature gating after request validation but before any remote backend calls. It relies only on config setup and the typed install request path.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Integer, assert!, assert_eq!, write, timeout).


##### `plugin_install_writes_remote_plugin_to_cloud_and_cache`  (lines 195–289)

```
async fn plugin_install_writes_remote_plugin_to_cloud_and_cache() -> Result<()>
```

**Purpose**: Exercises the full happy path for remote curated plugin installation, including bundle download, extraction into cache, app manifest persistence, and delayed cloud install until the cache manifest exists. It verifies both response contents and on-disk side effects.

**Data flow**: Creates a temp home and mock server, computes the expected installed cache path, builds a remote app manifest JSON value, mounts a bundle download returning a tar.gz with plugin manifest, bundled app manifest, and skill contents, writes remote-plugin config and ChatGPT auth, mounts remote plugin detail including a release version and app manifest, mounts an empty installed-plugins listing, and mounts an install endpoint guarded by `CacheManifestExists` so it only matches after `.codex-plugin/plugin.json` has been written. It starts `TestAppServer` with the HTTP-download test env var enabled, sends a remote install request via `send_remote_plugin_install_request`, deserializes `PluginInstallResponse`, waits for exact POST and GET request counts, then asserts the cache files exist and contain the expected plugin version, app manifest, and skill file while no cache directory keyed by the opaque remote plugin id exists.

**Call relations**: This is the central remote-install integration test. It orchestrates many helpers—config writers, bundle builders, wiremock mounts, request-count pollers—to prove the endpoint sequences local cache writes before the backend install call and returns the expected auth policy.

*Call graph*: calls 9 internal fn (new_with_env, configure_remote_plugin_test, mount_empty_remote_installed_plugins, mount_remote_plugin_bundle, mount_remote_plugin_detail_with_app_manifest, mount_remote_plugin_install_after_cache_write, remote_plugin_bundle_tar_gz_bytes_with_contents, send_remote_plugin_install_request, wait_for_remote_plugin_request_count); 11 external calls (start, new, Integer, to_response, assert!, assert_eq!, format!, json!, from_str, read_to_string (+1 more)).


##### `plugin_install_uses_remote_apps_needing_auth_response`  (lines 292–357)

```
async fn plugin_install_uses_remote_apps_needing_auth_response() -> Result<()>
```

**Purpose**: Checks that when the remote install backend explicitly returns `app_ids_needing_auth`, the endpoint surfaces those apps directly without consulting the connectors directory. It validates the short-circuit path for remote auth requirements.

**Data flow**: Creates temp home and mock server, mounts a remote bundle, writes config enabling remote plugins plus connectors, mounts plugin detail with an app manifest containing app `alpha`, mounts an empty installed list, and mounts a remote install response containing `app_ids_needing_auth: ["alpha"]`. After starting the server with HTTP bundle downloads allowed, it sends the remote install request, deserializes `PluginInstallResponse`, asserts `auth_policy: OnUse` and a single `AppSummary` for `alpha` with install URL/category, then waits for zero `/backend-api/connectors/directory/list` requests.

**Call relations**: This test covers the branch where the install response itself is authoritative about auth-needed apps. It uses the same remote-install scaffolding as the cache-write test but asserts the absence of connector-directory fallback traffic.

*Call graph*: calls 9 internal fn (new_with_env, configure_remote_plugin_with_apps_test, mount_empty_remote_installed_plugins, mount_remote_plugin_bundle, mount_remote_plugin_detail_with_app_manifest, mount_remote_plugin_install_with_apps_needing_auth, remote_plugin_bundle_tar_gz_bytes, send_remote_plugin_install_request, wait_for_remote_plugin_request_count); 7 external calls (start, new, Integer, to_response, assert_eq!, json!, timeout).


##### `plugin_install_rejects_missing_remote_bundle_url`  (lines 360–403)

```
async fn plugin_install_rejects_missing_remote_bundle_url() -> Result<()>
```

**Purpose**: Ensures remote install fails if plugin detail lacks a bundle download URL. It verifies the server does not attempt cloud installation or create cache directories without a downloadable release artifact.

**Data flow**: Creates temp home and mock server, writes remote-plugin config/auth, mounts plugin detail with `bundle_download_url: None`, mounts an empty installed list, starts and initializes the server, sends the remote install request, waits for an error response, and asserts code `-32603` with a message about the backend not returning a download URL. It then waits for zero install POSTs and asserts the expected cache subtree does not exist.

**Call relations**: This negative-path test enters the remote detail fetch branch but fails before any bundle download or install POST. It uses `wait_for_remote_plugin_request_count` to prove no later-stage backend calls were made.

*Call graph*: calls 6 internal fn (new, configure_remote_plugin_test, mount_empty_remote_installed_plugins, mount_remote_plugin_detail, send_remote_plugin_install_request, wait_for_remote_plugin_request_count); 7 external calls (start, new, Integer, assert!, assert_eq!, format!, timeout).


##### `plugin_install_rejects_plain_http_remote_bundle_url`  (lines 406–444)

```
async fn plugin_install_rejects_plain_http_remote_bundle_url() -> Result<()>
```

**Purpose**: Checks that insecure plain-HTTP bundle URLs are rejected unless the explicit test override is enabled. It protects the install path from unsupported download schemes.

**Data flow**: Creates temp home and mock server, constructs an `http://.../bundles/linear.tar.gz` URL from the mock server URI, writes remote-plugin config/auth, mounts plugin detail with that URL and an empty installed list, starts the server without the HTTP-allow env var, sends the remote install request, and asserts a `-32603` error mentioning `unsupported download URL scheme`. It then verifies no install POST occurred and no cache directory was created.

**Call relations**: This test covers URL-scheme validation between detail fetch and bundle download. It shares setup with other remote-install failures but specifically proves the server blocks insecure transport before touching disk or cloud install APIs.

*Call graph*: calls 6 internal fn (new, configure_remote_plugin_test, mount_empty_remote_installed_plugins, mount_remote_plugin_detail, send_remote_plugin_install_request, wait_for_remote_plugin_request_count); 7 external calls (start, new, Integer, assert!, assert_eq!, format!, timeout).


##### `plugin_install_rejects_invalid_remote_release_version`  (lines 447–486)

```
async fn plugin_install_rejects_invalid_remote_release_version() -> Result<()>
```

**Purpose**: Verifies that unsafe remote release versions such as path-traversal-like strings are rejected. It ensures the version string cannot be used to escape the intended cache layout.

**Data flow**: Creates temp home and mock server, writes remote-plugin config/auth, mounts plugin detail with release version `../1.2.3` and a nominal HTTPS bundle URL, mounts an empty installed list, starts the server, sends the remote install request, and asserts a `-32603` error containing `invalid release version`. It then confirms no install POST occurred and no cache directory was created.

**Call relations**: This test targets filesystem-safety validation in the remote install path. It reaches the detail parsing stage and then proves the server aborts before download or install when the version is not a safe path component.

*Call graph*: calls 6 internal fn (new, configure_remote_plugin_test, mount_empty_remote_installed_plugins, mount_remote_plugin_detail, send_remote_plugin_install_request, wait_for_remote_plugin_request_count); 7 external calls (start, new, Integer, assert!, assert_eq!, format!, timeout).


##### `plugin_install_rejects_invalid_remote_plugin_name`  (lines 489–512)

```
async fn plugin_install_rejects_invalid_remote_plugin_name() -> Result<()>
```

**Purpose**: Checks that malformed remote plugin identifiers are rejected at request validation time. It enforces the allowed character set for remote plugin ids.

**Data flow**: Writes remote-plugin catalog config pointing at a dummy backend, starts and initializes the server, sends `PluginInstallParams` with `remote_marketplace_name` set and `plugin_name` containing `linear/../../oops`, waits for the error response, and asserts code `-32600` with a message containing `invalid remote plugin id`.

**Call relations**: This is an early validation test that does not require a live backend because the request should fail before any HTTP call. It complements the remote read/list suites' similar id-validation coverage.

*Call graph*: calls 2 internal fn (new, write_remote_plugin_catalog_config); 5 external calls (new, Integer, assert!, assert_eq!, timeout).


##### `plugin_install_rejects_remote_plugin_disabled_by_admin_before_download`  (lines 515–572)

```
async fn plugin_install_rejects_remote_plugin_disabled_by_admin_before_download() -> Result<()>
```

**Purpose**: Ensures a remote plugin marked `DisabledByAdmin` in detail metadata is rejected before bundle download or install POST. It verifies availability gating is enforced from catalog metadata.

**Data flow**: Creates temp home and mock server, mounts a valid bundle URL, writes remote-plugin config/auth, mounts plugin detail with `PluginAvailability::DisabledByAdmin`, mounts an empty installed list, starts the server with HTTP downloads allowed, sends the remote install request, and asserts a `-32600` error mentioning `disabled by admin`. It then waits for zero bundle GETs and zero install POSTs and confirms no cache directory exists.

**Call relations**: This test covers the availability check after detail fetch but before any side effects. It uses the same remote scaffolding as the happy path while asserting that later stages are skipped entirely.

*Call graph*: calls 8 internal fn (new_with_env, configure_remote_plugin_test, mount_empty_remote_installed_plugins, mount_remote_plugin_bundle, mount_remote_plugin_detail_with_status, remote_plugin_bundle_tar_gz_bytes, send_remote_plugin_install_request, wait_for_remote_plugin_request_count); 7 external calls (start, new, Integer, assert!, assert_eq!, format!, timeout).


##### `plugin_install_rejects_when_workspace_codex_plugins_disabled`  (lines 575–639)

```
async fn plugin_install_rejects_when_workspace_codex_plugins_disabled() -> Result<()>
```

**Purpose**: Verifies that local marketplace installation is blocked when the workspace's ChatGPT account settings disable Codex plugins. It tests the workspace-policy gate rather than the global feature flag.

**Data flow**: Creates temp home and repo root, starts a mock backend, writes config enabling plugins with `chatgpt_base_url`, writes ChatGPT auth for account `account-123`, writes a local marketplace and plugin source, computes the absolute marketplace path, mounts a GET `/backend-api/accounts/account-123/settings` response with `enable_plugins: false`, starts and initializes the server, sends a local install request, waits for the error response, and asserts code `-32600` with a message stating Codex plugins are disabled for the workspace.

**Call relations**: This test drives the local install path far enough to require workspace settings lookup. It depends on marketplace/source fixture helpers and a backend settings mock to prove policy enforcement happens before installation.

*Call graph*: calls 6 internal fn (new, new, write_plugin_marketplace, write_plugin_source, write_plugins_enabled_config_with_base_url, try_from); 13 external calls (given, start, new, new, Integer, write_chatgpt_auth, assert!, assert_eq!, format!, timeout (+3 more)).


##### `plugin_install_returns_invalid_request_for_missing_marketplace_file`  (lines 642–667)

```
async fn plugin_install_returns_invalid_request_for_missing_marketplace_file() -> Result<()>
```

**Purpose**: Checks that a local install request fails cleanly when the specified marketplace file does not exist. It validates filesystem existence checks on the request path.

**Data flow**: Starts an empty server, constructs an absolute path to a nonexistent `missing-marketplace.json`, sends a local install request using that path, waits for the error response, and asserts code `-32600` with message fragments mentioning `marketplace file` and `does not exist`.

**Call relations**: This is a local-source validation test that fails before marketplace parsing or plugin lookup. It uses typed params and the standard error-stream read helper.

*Call graph*: calls 2 internal fn (new, try_from); 5 external calls (new, Integer, assert!, assert_eq!, timeout).


##### `plugin_install_returns_invalid_request_for_not_available_plugin`  (lines 670–705)

```
async fn plugin_install_returns_invalid_request_for_not_available_plugin() -> Result<()>
```

**Purpose**: Verifies that a marketplace entry whose installation policy is not available cannot be installed. It ensures marketplace policy metadata is enforced.

**Data flow**: Creates temp home and repo root, writes a marketplace whose plugin has installation policy `NOT_AVAILABLE`, writes the plugin source, computes the marketplace path, starts and initializes the server, sends the install request, waits for the error response, and asserts code `-32600` with a message containing `not available for install`.

**Call relations**: This test covers local marketplace policy evaluation after the marketplace file is successfully loaded. It relies on `write_plugin_marketplace` to encode the policy into the fixture manifest.

*Call graph*: calls 4 internal fn (new, write_plugin_marketplace, write_plugin_source, try_from); 5 external calls (new, Integer, assert!, assert_eq!, timeout).


##### `plugin_install_returns_invalid_request_for_disallowed_product_plugin`  (lines 708–755)

```
async fn plugin_install_returns_invalid_request_for_disallowed_product_plugin() -> Result<()>
```

**Purpose**: Checks that plugins restricted to another product surface are not installable in the current session source. It validates product-policy filtering for local marketplace entries.

**Data flow**: Creates temp home and repo root, manually writes a marketplace JSON whose plugin policy lists `products: ["CHATGPT"]`, writes the plugin source, computes the marketplace path, starts `TestAppServer` with `--session-source atlas`, initializes it, sends the install request, waits for the error response, and asserts code `-32600` with `not available for install` in the message.

**Call relations**: This test differs from the generic not-available case by exercising product-surface filtering rather than installation policy. It uses `new_with_args` to force a non-ChatGPT session source before invoking the endpoint.

*Call graph*: calls 3 internal fn (new_with_args, write_plugin_source, try_from); 7 external calls (new, Integer, assert!, assert_eq!, create_dir_all, write, timeout).


##### `plugin_install_tracks_analytics_event`  (lines 758–821)

```
async fn plugin_install_tracks_analytics_event() -> Result<()>
```

**Purpose**: Verifies that a successful local plugin install emits the expected analytics payload. It checks the exact event type and event parameters sent to the analytics backend.

**Data flow**: Starts an analytics events server, creates temp home, writes analytics config pointing `chatgpt_base_url` at that server, writes ChatGPT auth, creates a local marketplace and plugin source, starts and initializes the app server, sends the install request, deserializes `PluginInstallResponse`, asserts no apps need auth, then polls `wait_for_plugin_analytics_payload` and compares the JSON payload to the expected `codex_plugin_installed` event with plugin id/name, marketplace name, skill count flag, MCP server count, connector ids, and `product_client_id`.

**Call relations**: This test extends the local install happy path with backend-observable analytics verification. It delegates payload polling to `wait_for_plugin_analytics_payload`, which scans recorded requests until the analytics event appears.

*Call graph*: calls 7 internal fn (new, new, wait_for_plugin_analytics_payload, write_analytics_config, write_plugin_marketplace, write_plugin_source, try_from); 7 external calls (new, Integer, start_analytics_events_server, to_response, write_chatgpt_auth, assert_eq!, timeout).


##### `plugin_install_tracks_remote_plugin_analytics_event`  (lines 824–874)

```
async fn plugin_install_tracks_remote_plugin_analytics_event() -> Result<()>
```

**Purpose**: Checks that successful remote curated installs also emit the correct analytics event, with remote marketplace and plugin metadata. It confirms analytics covers remote installs as well as local ones.

**Data flow**: Creates temp home and mock server, mounts a remote bundle, writes remote-plugin config/auth, mounts plugin detail, empty installed list, install endpoint, and analytics endpoint, starts the server with HTTP downloads allowed, sends the remote install request, deserializes the response, asserts no apps need auth, then polls `wait_for_plugin_analytics_payload` on the same mock server and compares the JSON event payload to the expected remote-plugin values including `plugin_id: REMOTE_PLUGIN_ID`, `plugin_name: linear`, `marketplace_name: openai-curated-remote`, and `has_skills: true`.

**Call relations**: This test combines the remote install happy path with analytics verification. It depends on `mount_backend_analytics_events` so the analytics POST succeeds and can be inspected afterward.

*Call graph*: calls 10 internal fn (new_with_env, configure_remote_plugin_test, mount_backend_analytics_events, mount_empty_remote_installed_plugins, mount_remote_plugin_bundle, mount_remote_plugin_detail, mount_remote_plugin_install, remote_plugin_bundle_tar_gz_bytes, send_remote_plugin_install_request, wait_for_plugin_analytics_payload); 6 external calls (start, new, Integer, to_response, assert_eq!, timeout).


##### `plugin_install_errors_when_remote_bundle_download_fails`  (lines 877–928)

```
async fn plugin_install_errors_when_remote_bundle_download_fails() -> Result<()>
```

**Purpose**: Ensures remote install surfaces bundle download failures as internal errors and does not proceed to cloud installation. It validates error handling for non-200 bundle responses.

**Data flow**: Creates temp home and mock server, mounts a bundle endpoint returning status 503 and plain bytes, writes remote-plugin config/auth, mounts plugin detail, empty installed list, and install endpoint, starts the server with HTTP downloads allowed, sends the remote install request, waits for an error response, and asserts code `-32603` with a message mentioning status 503. It then verifies exactly one bundle GET occurred, zero install POSTs occurred, and no cache directory was created.

**Call relations**: This negative-path test reaches the download stage of remote install and proves the flow aborts before backend install when the artifact fetch fails. It uses request-count polling to make that sequencing explicit.

*Call graph*: calls 8 internal fn (new_with_env, configure_remote_plugin_test, mount_empty_remote_installed_plugins, mount_remote_plugin_bundle, mount_remote_plugin_detail, mount_remote_plugin_install, send_remote_plugin_install_request, wait_for_remote_plugin_request_count); 7 external calls (start, new, Integer, assert!, assert_eq!, format!, timeout).


##### `plugin_install_returns_apps_needing_auth`  (lines 931–1028)

```
async fn plugin_install_returns_apps_needing_auth() -> Result<()>
```

**Purpose**: Verifies that local plugin installation consults the connectors directory and returns inaccessible connector apps that require authentication. It also checks that the directory cache is actually refreshed during install.

**Data flow**: Builds two `AppInfo` connectors (`alpha`, `beta`) and one MCP tool for `beta`, starts the apps server, writes connectors config and ChatGPT auth, creates a local marketplace and plugin source referencing both app ids, starts and initializes the app server, records the directory request count before install, sends the install request, deserializes `PluginInstallResponse`, and asserts `auth_policy: OnInstall` with only `alpha` in `apps_needing_auth` because `beta` is represented by an MCP tool. It then asserts the apps server's directory request count increased.

**Call relations**: This test exercises the connector-aware branch of local install. It relies on `start_apps_server` and `connector_tool` fixtures to simulate both connector directory entries and MCP tool metadata, proving the endpoint distinguishes app auth from MCP-backed connectors.

*Call graph*: calls 7 internal fn (new, new, start_apps_server, write_connectors_config, write_plugin_marketplace, write_plugin_source, try_from); 8 external calls (new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, timeout, vec!).


##### `plugin_install_skips_mcp_oauth_for_chatgpt_dual_surface_plugin`  (lines 1031–1099)

```
async fn plugin_install_skips_mcp_oauth_for_chatgpt_dual_surface_plugin() -> Result<()>
```

**Purpose**: Checks that MCP OAuth discovery is skipped when a plugin's app is already represented as a ChatGPT connector in a dual-surface scenario. It prevents redundant OAuth setup for the same surface.

**Data flow**: Starts an apps server exposing connector `sample-mcp` and a separate mock OAuth server, writes connectors config and ChatGPT auth, creates a local marketplace and plugin source referencing `sample-mcp`, writes `.mcp.json` pointing at the OAuth server, starts and initializes the app server, sends the install request, deserializes the response, asserts `auth_policy: OnInstall`, and then asserts `oauth_discovery_request_count(&oauth_server) == 0`.

**Call relations**: This test covers the branch where connector presence suppresses MCP OAuth startup. It combines local plugin fixtures with both apps and OAuth mock servers to observe the absence of discovery traffic.

*Call graph*: calls 8 internal fn (new, new, start_apps_server, write_connectors_config, write_plugin_marketplace, write_plugin_mcp_config, write_plugin_source, try_from); 9 external calls (start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, timeout, vec!).


##### `plugin_install_starts_mcp_oauth_when_only_plugin_apps_are_disallowed`  (lines 1102–1160)

```
async fn plugin_install_starts_mcp_oauth_when_only_plugin_apps_are_disallowed() -> Result<()>
```

**Purpose**: Verifies that MCP OAuth discovery still starts when the plugin references only disallowed plugin-app ids rather than accessible ChatGPT connectors. It distinguishes dual-surface suppression from generic app filtering.

**Data flow**: Starts an empty apps server and a mock OAuth server, writes connectors config and ChatGPT auth, creates a local marketplace and plugin source referencing only a disallowed app id, writes `.mcp.json` pointing at the OAuth server, starts and initializes the app server, sends the install request, deserializes the response, asserts `auth_policy: OnInstall` and no `apps_needing_auth`, then asserts the OAuth server saw discovery requests.

**Call relations**: This test is the converse of the dual-surface suppression case. It proves that when connector matching does not explain away the plugin app ids, the install flow proceeds to MCP OAuth initialization.

*Call graph*: calls 8 internal fn (new, new, start_apps_server, write_connectors_config, write_plugin_marketplace, write_plugin_mcp_config, write_plugin_source, try_from); 9 external calls (start, new, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, timeout).


##### `plugin_install_starts_mcp_oauth_for_api_key_dual_surface_plugin`  (lines 1163–1215)

```
async fn plugin_install_starts_mcp_oauth_for_api_key_dual_surface_plugin() -> Result<()>
```

**Purpose**: Checks that API-key-authenticated sessions do start MCP OAuth even for dual-surface plugins, because ChatGPT connector auth is not available in that mode. It validates auth-mode-sensitive behavior.

**Data flow**: Creates temp home with config enabling plugins/connectors and file-backed MCP OAuth credentials, creates a local marketplace and plugin source referencing `sample-mcp`, writes `.mcp.json` pointing at a mock OAuth server, starts `TestAppServer` with `OPENAI_API_KEY=test-api-key`, initializes it, sends the install request, deserializes the response, asserts `auth_policy: OnInstall`, and confirms the OAuth server saw discovery traffic.

**Call relations**: This test covers the API-key branch of install behavior, contrasting with the ChatGPT-auth dual-surface suppression test. It uses environment-based auth setup instead of ChatGPT auth fixtures.

*Call graph*: calls 5 internal fn (new_with_env, write_plugin_marketplace, write_plugin_mcp_config, write_plugin_source, try_from); 8 external calls (start, new, Integer, to_response, assert!, assert_eq!, write, timeout).


##### `plugin_install_starts_remote_mcp_oauth_for_install_response_only_app`  (lines 1218–1263)

```
async fn plugin_install_starts_remote_mcp_oauth_for_install_response_only_app() -> Result<()>
```

**Purpose**: Verifies that remote plugin installs can trigger MCP OAuth discovery when the install response reports apps needing auth and the downloaded bundle contains MCP server config. It ensures remote installs participate in the same OAuth bootstrap logic.

**Data flow**: Creates temp home and two mock servers, mounts a remote bundle tarball containing `.mcp.json`, writes remote-plugin-plus-connectors config/auth, mounts plugin detail, empty installed list, and an install response listing app `alpha` as needing auth, starts the app server with HTTP downloads allowed, sends the remote install request, deserializes the response, asserts `auth_policy: OnUse` and one `AppSummary` for `alpha`, then asserts the OAuth server saw discovery requests.

**Call relations**: This test extends remote install coverage into MCP OAuth startup. It depends on the tarball builder that embeds `.mcp.json` so the installed bundle exposes an MCP server to initialize.

*Call graph*: calls 8 internal fn (new_with_env, configure_remote_plugin_with_apps_test, mount_empty_remote_installed_plugins, mount_remote_plugin_bundle, mount_remote_plugin_detail, mount_remote_plugin_install_with_apps_needing_auth, remote_plugin_bundle_tar_gz_bytes_with_mcp_config, send_remote_plugin_install_request); 7 external calls (start, new, Integer, to_response, assert!, assert_eq!, timeout).


##### `plugin_install_skips_remote_mcp_oauth_for_bundled_same_name_app`  (lines 1266–1315)

```
async fn plugin_install_skips_remote_mcp_oauth_for_bundled_same_name_app() -> Result<()>
```

**Purpose**: Checks that remote install skips MCP OAuth when the downloaded bundle's `.app.json` maps the same MCP server name to the app already reported as needing auth. It avoids redundant OAuth for bundled same-name app/server pairs.

**Data flow**: Creates temp home and mock servers, mounts a remote bundle containing both `.app.json` and `.mcp.json` where `sample-mcp` maps to app id `alpha`, writes remote-plugin-plus-connectors config/auth, mounts plugin detail, empty installed list, and install response listing `alpha` as needing auth, starts the app server with HTTP downloads allowed, sends the remote install request, deserializes the response, asserts the expected `PluginInstallResponse`, and confirms the OAuth server saw zero discovery requests.

**Call relations**: This test covers a subtle deduplication branch in remote install auth handling. It uses the specialized tarball builder with both app and MCP config to make the same-name relationship observable.

*Call graph*: calls 8 internal fn (new_with_env, configure_remote_plugin_with_apps_test, mount_empty_remote_installed_plugins, mount_remote_plugin_bundle, mount_remote_plugin_detail, mount_remote_plugin_install_with_apps_needing_auth, remote_plugin_bundle_tar_gz_bytes_with_app_and_mcp_config, send_remote_plugin_install_request); 6 external calls (start, new, Integer, to_response, assert_eq!, timeout).


##### `plugin_install_filters_disallowed_apps_needing_auth`  (lines 1318–1406)

```
async fn plugin_install_filters_disallowed_apps_needing_auth() -> Result<()>
```

**Purpose**: Verifies that `apps_needing_auth` excludes disallowed plugin-app ids and reuses a warmed connector directory cache instead of refetching it. It checks both filtering correctness and cache behavior.

**Data flow**: Starts an apps server exposing connector `alpha`, writes connectors config and ChatGPT auth, creates a local marketplace whose auth policy is `ON_USE` and whose plugin source references both `alpha` and a disallowed app id, starts and initializes the app server, warms the app directory cache via `warm_app_directory_cache`, sends the install request, deserializes `PluginInstallResponse`, and asserts only `alpha` appears in `apps_needing_auth` with `auth_policy: OnUse`. It then asserts the apps server's directory request count did not increase beyond the warmed-cache count.

**Call relations**: This test combines two helper paths: `warm_app_directory_cache` primes connector data, and the install request then proves the endpoint can answer from cache while still filtering out disallowed app ids. It is the main consumer of the cache-warming helper.

*Call graph*: calls 8 internal fn (new, new, start_apps_server, warm_app_directory_cache, write_connectors_config, write_plugin_marketplace, write_plugin_source, try_from); 8 external calls (new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, timeout, vec!).


##### `plugin_install_makes_bundled_mcp_servers_available_to_followup_requests`  (lines 1409–1479)

```
async fn plugin_install_makes_bundled_mcp_servers_available_to_followup_requests() -> Result<()>
```

**Purpose**: Checks that installing a plugin with bundled `.mcp.json` makes those MCP servers available to later app-server requests without writing them into `config.toml`. It validates runtime registration rather than persistent config mutation.

**Data flow**: Creates temp home with plugins enabled, writes a local marketplace and plugin source, writes `.mcp.json` containing `sample-mcp` with command `echo`, starts and initializes the app server, sends the install request, deserializes `PluginInstallResponse`, asserts no apps need auth, reads `config.toml` and asserts it does not contain an `[mcp_servers.sample-mcp]` section or the command, then sends a raw `mcpServer/oauth/login` request for `sample-mcp`. It waits for the error response and asserts code `-32600` with message `OAuth login is only supported for streamable HTTP servers.`

**Call relations**: This test proves the install path registers bundled MCP servers in memory strongly enough that a follow-up endpoint recognizes the server name, even though no persistent config entry was written. The specific OAuth-login error confirms the server exists but is command-based rather than streamable HTTP.

*Call graph*: calls 4 internal fn (new, write_plugin_marketplace, write_plugin_source, try_from); 9 external calls (new, Integer, to_response, assert!, assert_eq!, json!, read_to_string, write, timeout).


##### `AppsServerControl::directory_request_count`  (lines 1493–1495)

```
fn directory_request_count(&self) -> usize
```

**Purpose**: Returns the number of connector-directory requests observed by the mock apps server. It exposes the atomic counter used by cache-behavior assertions.

**Data flow**: Reads `self.directory_request_count`, an `Arc<AtomicUsize>`, using `Ordering::SeqCst` and returns the current `usize` count. It does not mutate any state.

**Call relations**: Tests and helpers call this accessor before and after operations like cache warming or plugin install to determine whether the app directory was fetched again. It is the public observation point for `AppsServerState` request-count tracking.


##### `warm_app_directory_cache`  (lines 1498–1524)

```
async fn warm_app_directory_cache(
    mcp: &mut TestAppServer,
    server_control: &AppsServerControl,
    expected_app_name: &str,
) -> Result<usize>
```

**Purpose**: Forces an `apps/list` request so the app-server populates its connector directory cache, then returns the observed backend request count. It also sanity-checks that the expected app is present in the warmed response.

**Data flow**: Takes a mutable `TestAppServer`, an `AppsServerControl`, and an expected app name, sends `AppsListParams { force_refetch: true, ..Default::default() }`, waits for the typed `AppsListResponse`, asserts at least one returned app has the expected name, reads the current directory request count from `server_control`, asserts it is greater than zero, and returns that count.

**Call relations**: Only `plugin_install_filters_disallowed_apps_needing_auth` calls this helper. It sits before the install request in that test's call flow to establish a known cached-directory baseline.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_apps_list_request); called by 1 (plugin_install_filters_disallowed_apps_needing_auth); 6 external calls (default, Integer, directory_request_count, to_response, assert!, timeout).


##### `PluginInstallMcpServer::get_info`  (lines 1532–1534)

```
fn get_info(&self) -> ServerInfo
```

**Purpose**: Advertises the mock MCP server's capabilities to RMCP clients, enabling only tool listing. It provides the minimal server metadata needed for the streamable HTTP MCP fixture.

**Data flow**: Constructs and returns a `ServerInfo` using `ServerCapabilities::builder().enable_tools().build()`. It reads no mutable state and performs no I/O.

**Call relations**: RMCP calls this method when serving the mock MCP endpoint created by `start_apps_server`. Its role is to make the fixture server look like a tools-capable MCP server to the app-server under test.

*Call graph*: 2 external calls (builder, new).


##### `PluginInstallMcpServer::list_tools`  (lines 1536–1554)

```
fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> impl std::future::Futu
```

**Purpose**: Returns the current set of mock MCP tools configured for the fixture server. It clones the shared tool list out of a mutex so requests can inspect connector metadata.

**Data flow**: Ignores the pagination request and request context, clones `self.tools`, locks the `StdMutex<Vec<Tool>>`, recovers from poisoning by taking the inner value, clones the vector, and returns `ListToolsResult { tools, next_cursor: None, meta: None }` inside the async future. It does not mutate the stored tools.

**Call relations**: This method is invoked by the RMCP transport when the app-server queries the mock MCP endpoint. Tests that need connector-backed MCP tools rely on `start_apps_server` to expose this implementation.


##### `start_apps_server`  (lines 1557–1601)

```
async fn start_apps_server(
    connectors: Vec<AppInfo>,
    tools: Vec<Tool>,
) -> Result<(String, JoinHandle<()>, AppsServerControl)>
```

**Purpose**: Starts a local Axum server that serves both connector-directory endpoints and a streamable HTTP MCP service for tool discovery. It returns the base URL, the spawned task handle, and a control object for observing request counts.

**Data flow**: Accepts connector `AppInfo` values and MCP `Tool` values, creates an `AtomicUsize` request counter, wraps a JSON connector-directory response and the counter in `AppsServerState`, wraps tools in `Arc<StdMutex<Vec<Tool>>>`, binds a random localhost TCP port, constructs a `StreamableHttpService` whose factory creates `PluginInstallMcpServer` instances sharing the tool list, builds an Axum `Router` with `/connectors/directory/list`, `/connectors/directory/list_workspace`, and nested `/api/codex/ps/mcp` routes, spawns `axum::serve`, and returns `(http://addr, handle, AppsServerControl)`.

**Call relations**: Several tests call this helper to simulate the ChatGPT connectors backend and MCP tool discovery surface. It is the central fixture provider for connector-aware install scenarios and underpins `list_directory_connectors`, `AppsServerControl`, and `PluginInstallMcpServer`.

*Call graph*: called by 4 (plugin_install_filters_disallowed_apps_needing_auth, plugin_install_returns_apps_needing_auth, plugin_install_skips_mcp_oauth_for_chatgpt_dual_surface_plugin, plugin_install_starts_mcp_oauth_when_only_plugin_apps_are_disallowed); 13 external calls (new, new, default, new, new, default, new, bind, get, serve (+3 more)).


##### `list_directory_connectors`  (lines 1603–1634)

```
async fn list_directory_connectors(
    State(state): State<Arc<AppsServerState>>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<impl axum::response::IntoResponse, StatusCode>
```

**Purpose**: Implements the mock connector-directory HTTP handler used by the apps server fixture. It validates auth headers and the `external_logos=true` query parameter before returning the configured connector list.

**Data flow**: Receives shared `AppsServerState`, request headers, and URI; increments `directory_request_count`; checks that `Authorization` equals `Bearer chatgpt-token`, `chatgpt-account-id` equals `account-123`, and the query string contains `external_logos=true`. If auth is wrong it returns `StatusCode::UNAUTHORIZED`; if the query flag is missing it returns `BAD_REQUEST`; otherwise it locks and clones the stored JSON response and returns it wrapped in `axum::Json`.

**Call relations**: This handler is mounted by `start_apps_server` on both directory routes. Tests do not call it directly; they observe its effects through request counts and through app-server behavior that depends on successful connector-directory fetches.

*Call graph*: 3 external calls (get, query, Json).


##### `connector_tool`  (lines 1636–1655)

```
fn connector_tool(connector_id: &str, connector_name: &str) -> Result<Tool>
```

**Purpose**: Builds a mock RMCP `Tool` annotated as a connector-backed tool for a specific connector id and display name. It encodes connector metadata in the tool's `meta` map.

**Data flow**: Creates a minimal JSON schema object, constructs a `Tool` named `connector_<connector_id>` with description `Connector test tool`, marks it read-only via `ToolAnnotations`, creates a `Meta` map containing `connector_id` and `connector_name`, assigns that metadata to the tool, and returns it. Errors only if the schema JSON cannot be deserialized into `JsonObject`.

**Call relations**: Tests that need MCP tools corresponding to connectors call this helper before passing the resulting tools into `start_apps_server`. The app-server later consumes these tools through the mock MCP service to infer connector relationships.

*Call graph*: 9 external calls (new, Borrowed, Owned, new, new, format!, json!, new, from_value).


##### `write_connectors_config`  (lines 1657–1670)

```
fn write_connectors_config(codex_home: &std::path::Path, base_url: &str) -> std::io::Result<()>
```

**Purpose**: Writes a minimal config enabling connectors and pointing `chatgpt_base_url` at a mock apps server. It also selects file-backed MCP OAuth credential storage for tests that trigger OAuth discovery.

**Data flow**: Formats a `config.toml` string containing `chatgpt_base_url = "{base_url}"`, `mcp_oauth_credentials_store = "file"`, and `[features] connectors = true`, then writes it under `codex_home/config.toml`. It returns the filesystem write result.

**Call relations**: Connector-aware install tests call this helper before starting `TestAppServer`. It is setup-only but determines whether the server will query the mock apps backend and persist OAuth credentials.

*Call graph*: called by 4 (plugin_install_filters_disallowed_apps_needing_auth, plugin_install_returns_apps_needing_auth, plugin_install_skips_mcp_oauth_for_chatgpt_dual_surface_plugin, plugin_install_starts_mcp_oauth_when_only_plugin_apps_are_disallowed); 3 external calls (join, format!, write).


##### `write_plugins_enabled_config_with_base_url`  (lines 1672–1686)

```
fn write_plugins_enabled_config_with_base_url(
    codex_home: &std::path::Path,
    base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes config that enables plugins and points ChatGPT backend requests at a supplied base URL. It is used for tests that need plugin feature gating plus workspace settings lookups.

**Data flow**: Formats and writes `config.toml` containing `chatgpt_base_url = "{base_url}"` and `[features] plugins = true` under the given home directory. It returns `std::io::Result<()>` from the write.

**Call relations**: The workspace-settings rejection test uses this helper before startup so the app-server can call the mock backend while treating plugins as globally enabled.

*Call graph*: called by 1 (plugin_install_rejects_when_workspace_codex_plugins_disabled); 3 external calls (join, format!, write).


##### `write_analytics_config`  (lines 1688–1693)

```
fn write_analytics_config(codex_home: &std::path::Path, base_url: &str) -> std::io::Result<()>
```

**Purpose**: Writes the minimal config needed for analytics tests by setting only `chatgpt_base_url`. It lets the app-server send analytics events to a local mock backend.

**Data flow**: Formats `chatgpt_base_url = "{base_url}"` and writes it to `codex_home/config.toml`. No other state is touched.

**Call relations**: Only the local analytics test calls this helper. It is intentionally minimal because the analytics path under test does not require plugin feature flags in config.

*Call graph*: called by 1 (plugin_install_tracks_analytics_event); 3 external calls (join, format!, write).


##### `mount_backend_analytics_events`  (lines 1695–1701)

```
async fn mount_backend_analytics_events(server: &MockServer)
```

**Purpose**: Registers a wiremock endpoint that accepts analytics event POSTs and returns a simple success body. It allows analytics-emitting tests to complete without backend failures.

**Data flow**: Adds a `wiremock::Mock` matching `POST /backend-api/codex/analytics-events/events` and responding with HTTP 200 and body `{"status":"ok"}` to the provided `MockServer`. It writes no local files and returns no value.

**Call relations**: The remote analytics test calls this helper before installation so the app-server's analytics POST succeeds and can later be inspected by `wait_for_plugin_analytics_payload`.

*Call graph*: called by 1 (plugin_install_tracks_remote_plugin_analytics_event); 4 external calls (given, new, method, path).


##### `wait_for_plugin_analytics_payload`  (lines 1703–1724)

```
async fn wait_for_plugin_analytics_payload(server: &MockServer) -> Result<serde_json::Value>
```

**Purpose**: Polls a mock server until it observes an analytics events POST, then parses and returns the JSON payload body. It tolerates startup races by sleeping and retrying until timeout.

**Data flow**: Within a timeout-wrapped loop, fetches recorded requests from the `MockServer`; if none are available it sleeps 25 ms and retries. Once requests exist, it searches for a `POST` whose path ends with `/codex/analytics-events/events`, parses `request.body` as JSON with `serde_json::from_slice`, and returns that value; parse failures are wrapped as `anyhow` errors.

**Call relations**: Both analytics tests call this helper after a successful install. It bridges backend-observable side effects back into test assertions by extracting the exact emitted payload.

*Call graph*: called by 2 (plugin_install_tracks_analytics_event, plugin_install_tracks_remote_plugin_analytics_event); 5 external calls (from_millis, received_requests, from_slice, sleep, timeout).


##### `oauth_discovery_request_count`  (lines 1726–1734)

```
async fn oauth_discovery_request_count(server: &MockServer) -> usize
```

**Purpose**: Counts how many recorded requests on a mock server target OAuth authorization-server discovery endpoints. It is used to assert whether MCP OAuth bootstrap did or did not occur.

**Data flow**: Reads all recorded requests from the `MockServer`, defaults to an empty list if unavailable, filters for requests whose path contains `oauth-authorization-server`, and returns the count as `usize`. It does not mutate state.

**Call relations**: Several MCP OAuth tests call this helper after installation to distinguish branches that should trigger discovery from those that should suppress it.

*Call graph*: 1 external calls (received_requests).


##### `write_remote_plugin_catalog_config`  (lines 1736–1752)

```
fn write_remote_plugin_catalog_config(
    codex_home: &std::path::Path,
    base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes config enabling both plugins and remote-plugin support against a supplied ChatGPT backend base URL. It is the standard setup for remote curated install tests.

**Data flow**: Formats a `config.toml` containing `chatgpt_base_url = "{base_url}"` and `[features] plugins = true` plus `remote_plugin = true`, then writes it under `codex_home`. It returns the filesystem write result.

**Call relations**: This helper is called directly by one validation test and indirectly by `configure_remote_plugin_test`. It establishes the feature flags required for remote install code paths.

*Call graph*: called by 2 (configure_remote_plugin_test, plugin_install_rejects_invalid_remote_plugin_name); 3 external calls (join, format!, write).


##### `configure_remote_plugin_test`  (lines 1754–1764)

```
fn configure_remote_plugin_test(codex_home: &std::path::Path, server: &MockServer) -> Result<()>
```

**Purpose**: Combines remote-plugin config writing with ChatGPT auth fixture creation for standard remote install tests. It centralizes the common authenticated remote-plugin setup.

**Data flow**: Calls `write_remote_plugin_catalog_config` with a backend URL derived from `server.uri()`, then writes ChatGPT auth credentials for token `chatgpt-token` and account/user ids under the given home directory using file storage. It returns `Result<()>`, propagating either config-write or auth-write failures.

**Call relations**: Most remote install tests call this helper before starting `TestAppServer`. It packages the minimum environment needed for authenticated requests to the mock ChatGPT backend.

*Call graph*: calls 2 internal fn (new, write_remote_plugin_catalog_config); called by 7 (plugin_install_errors_when_remote_bundle_download_fails, plugin_install_rejects_invalid_remote_release_version, plugin_install_rejects_missing_remote_bundle_url, plugin_install_rejects_plain_http_remote_bundle_url, plugin_install_rejects_remote_plugin_disabled_by_admin_before_download, plugin_install_tracks_remote_plugin_analytics_event, plugin_install_writes_remote_plugin_to_cloud_and_cache); 2 external calls (write_chatgpt_auth, format!).


##### `configure_remote_plugin_with_apps_test`  (lines 1766–1792)

```
fn configure_remote_plugin_with_apps_test(
    codex_home: &std::path::Path,
    server: &MockServer,
) -> Result<()>
```

**Purpose**: Writes remote-plugin config that also enables connectors, then installs ChatGPT auth. It is used for remote install scenarios where app manifests and connector auth behavior matter.

**Data flow**: Writes a `config.toml` containing `chatgpt_base_url = "{server}/backend-api/"` and `[features] plugins = true`, `remote_plugin = true`, `connectors = true`, then writes ChatGPT auth credentials for the standard test account. It returns `Result<()>`.

**Call relations**: Remote install tests that assert `apps_needing_auth` or MCP OAuth behavior call this helper instead of the simpler remote-plugin setup helper.

*Call graph*: calls 1 internal fn (new); called by 3 (plugin_install_skips_remote_mcp_oauth_for_bundled_same_name_app, plugin_install_starts_remote_mcp_oauth_for_install_response_only_app, plugin_install_uses_remote_apps_needing_auth_response); 4 external calls (join, write_chatgpt_auth, format!, write).


##### `mount_remote_plugin_bundle`  (lines 1794–1809)

```
async fn mount_remote_plugin_bundle(
    server: &MockServer,
    status_code: u16,
    body: Vec<u8>,
) -> String
```

**Purpose**: Registers a mock bundle download endpoint and returns its URL. It serves the tar.gz bytes used by remote install extraction tests.

**Data flow**: Adds a wiremock handler for `GET /bundles/linear.tar.gz` that responds with the supplied status code, `content-type: application/gzip`, and raw body bytes, then returns the full URL string based on `server.uri()`. It does not touch disk.

**Call relations**: Many remote install tests call this helper to obtain a bundle URL they can embed into plugin detail fixtures. It is the standard source of downloadable release artifacts in this file.

*Call graph*: called by 7 (plugin_install_errors_when_remote_bundle_download_fails, plugin_install_rejects_remote_plugin_disabled_by_admin_before_download, plugin_install_skips_remote_mcp_oauth_for_bundled_same_name_app, plugin_install_starts_remote_mcp_oauth_for_install_response_only_app, plugin_install_tracks_remote_plugin_analytics_event, plugin_install_uses_remote_apps_needing_auth_response, plugin_install_writes_remote_plugin_to_cloud_and_cache); 5 external calls (given, new, format!, method, path).


##### `mount_remote_plugin_detail`  (lines 1811–1825)

```
async fn mount_remote_plugin_detail(
    server: &MockServer,
    remote_plugin_id: &str,
    release_version: &str,
    bundle_download_url: Option<&str>,
)
```

**Purpose**: Convenience wrapper that mounts a remote plugin detail response with default availability `Available` and no app manifest. It reduces duplication for common detail fixtures.

**Data flow**: Forwards its arguments to `mount_remote_plugin_detail_with_status` with `PluginAvailability::Available`. It returns after the underlying wiremock mount completes.

**Call relations**: Several remote install tests call this helper when they only need basic detail metadata. It exists to keep those tests concise while sharing the full detail-body construction logic.

*Call graph*: calls 1 internal fn (mount_remote_plugin_detail_with_status); called by 7 (plugin_install_errors_when_remote_bundle_download_fails, plugin_install_rejects_invalid_remote_release_version, plugin_install_rejects_missing_remote_bundle_url, plugin_install_rejects_plain_http_remote_bundle_url, plugin_install_skips_remote_mcp_oauth_for_bundled_same_name_app, plugin_install_starts_remote_mcp_oauth_for_install_response_only_app, plugin_install_tracks_remote_plugin_analytics_event).


##### `mount_remote_plugin_detail_with_app_manifest`  (lines 1827–1843)

```
async fn mount_remote_plugin_detail_with_app_manifest(
    server: &MockServer,
    remote_plugin_id: &str,
    release_version: &str,
    bundle_download_url: Option<&str>,
    app_manifest: serde_js
```

**Purpose**: Convenience wrapper that mounts a remote plugin detail response including an embedded app manifest. It is used when tests need the backend-provided `.app.json` to be persisted or surfaced.

**Data flow**: Delegates to `mount_remote_plugin_detail_with_status_and_app_manifest` with availability `Available` and `Some(app_manifest)`. It performs no additional transformation beyond forwarding arguments.

**Call relations**: The remote cache-write and remote apps-needing-auth tests call this helper to include app-manifest data in the mocked detail response.

*Call graph*: calls 1 internal fn (mount_remote_plugin_detail_with_status_and_app_manifest); called by 2 (plugin_install_uses_remote_apps_needing_auth_response, plugin_install_writes_remote_plugin_to_cloud_and_cache).


##### `mount_remote_plugin_detail_with_status`  (lines 1845–1861)

```
async fn mount_remote_plugin_detail_with_status(
    server: &MockServer,
    remote_plugin_id: &str,
    release_version: &str,
    bundle_download_url: Option<&str>,
    status: PluginAvailability,
```

**Purpose**: Convenience wrapper that mounts a remote plugin detail response with a specified availability status but no app manifest. It supports tests that vary only the plugin's enabled/disabled state.

**Data flow**: Calls `mount_remote_plugin_detail_with_status_and_app_manifest` with the provided status and `None` for the app manifest. It returns once the wiremock route is mounted.

**Call relations**: Used by the generic detail helper and by the admin-disabled test to vary availability without duplicating the full JSON body template.

*Call graph*: calls 1 internal fn (mount_remote_plugin_detail_with_status_and_app_manifest); called by 2 (mount_remote_plugin_detail, plugin_install_rejects_remote_plugin_disabled_by_admin_before_download).


##### `mount_remote_plugin_detail_with_status_and_app_manifest`  (lines 1863–1912)

```
async fn mount_remote_plugin_detail_with_status_and_app_manifest(
    server: &MockServer,
    remote_plugin_id: &str,
    release_version: &str,
    bundle_download_url: Option<&str>,
    status: Plu
```

**Purpose**: Builds and mounts the full remote plugin detail HTTP response used by remote install tests. It parameterizes release version, bundle URL, availability status, and optional app manifest.

**Data flow**: Maps `PluginAvailability` to backend strings (`ENABLED` or `DISABLED_BY_ADMIN`), conditionally formats JSON fields for `bundle_download_url` and `app_manifest`, interpolates them into a detail JSON string containing plugin id, name `linear`, scope `GLOBAL`, installation/authentication policies, release metadata, interface description, and empty skills, then mounts a wiremock `GET /backend-api/ps/plugins/{remote_plugin_id}?includeDownloadUrls=true` handler requiring the expected auth headers and returning that body with HTTP 200.

**Call relations**: This is the underlying fixture builder for all remote detail variants in the file. Wrapper helpers call it to specialize common cases, and remote install tests depend on it to shape the metadata the app-server consumes.

*Call graph*: called by 2 (mount_remote_plugin_detail_with_app_manifest, mount_remote_plugin_detail_with_status); 7 external calls (given, new, format!, header, method, path, query_param).


##### `mount_empty_remote_installed_plugins`  (lines 1914–1931)

```
async fn mount_empty_remote_installed_plugins(server: &MockServer)
```

**Purpose**: Mounts a backend response indicating that no remote plugins are currently installed. It provides the baseline installed-list fixture for many remote install tests.

**Data flow**: Registers a wiremock `GET /backend-api/ps/plugins/installed?scope=GLOBAL` handler requiring the standard auth headers and returning a JSON body with an empty `plugins` array and pagination metadata. It performs no local side effects.

**Call relations**: Most remote install tests call this helper before issuing the install request so the app-server sees a clean installed-plugin state.

*Call graph*: called by 10 (plugin_install_errors_when_remote_bundle_download_fails, plugin_install_rejects_invalid_remote_release_version, plugin_install_rejects_missing_remote_bundle_url, plugin_install_rejects_plain_http_remote_bundle_url, plugin_install_rejects_remote_plugin_disabled_by_admin_before_download, plugin_install_skips_remote_mcp_oauth_for_bundled_same_name_app, plugin_install_starts_remote_mcp_oauth_for_install_response_only_app, plugin_install_tracks_remote_plugin_analytics_event, plugin_install_uses_remote_apps_needing_auth_response, plugin_install_writes_remote_plugin_to_cloud_and_cache); 6 external calls (given, new, header, method, path, query_param).


##### `mount_remote_plugin_install`  (lines 1933–1946)

```
async fn mount_remote_plugin_install(server: &MockServer, remote_plugin_id: &str)
```

**Purpose**: Mounts a successful remote install POST endpoint that simply returns the plugin id and `enabled: true`. It is the basic cloud-install fixture for remote happy-path tests.

**Data flow**: Registers a wiremock `POST /backend-api/ps/plugins/{remote_plugin_id}/install` handler requiring the standard auth headers and responding with HTTP 200 and a small JSON body containing the plugin id and enabled flag.

**Call relations**: The remote analytics and bundle-download-failure tests use this helper when they need a nominal install endpoint available after earlier stages succeed.

*Call graph*: called by 2 (plugin_install_errors_when_remote_bundle_download_fails, plugin_install_tracks_remote_plugin_analytics_event); 6 external calls (given, new, format!, header, method, path).


##### `mount_remote_plugin_install_with_apps_needing_auth`  (lines 1948–1967)

```
async fn mount_remote_plugin_install_with_apps_needing_auth(
    server: &MockServer,
    remote_plugin_id: &str,
    app_ids_needing_auth: &[&str],
)
```

**Purpose**: Mounts a successful remote install endpoint that also returns `app_ids_needing_auth`. It supports tests where the backend explicitly tells the client which apps still require auth.

**Data flow**: Registers a wiremock `POST /backend-api/ps/plugins/{remote_plugin_id}/install?includeAppsNeedingAuth=true` handler requiring auth headers and responding with JSON containing the plugin id, `enabled: true`, and the supplied `app_ids_needing_auth` slice.

**Call relations**: Remote auth-related tests call this helper to drive the branch where the install response itself determines `apps_needing_auth`.

*Call graph*: called by 3 (plugin_install_skips_remote_mcp_oauth_for_bundled_same_name_app, plugin_install_starts_remote_mcp_oauth_for_install_response_only_app, plugin_install_uses_remote_apps_needing_auth_response); 8 external calls (given, new, format!, json!, header, method, path, query_param).


##### `CacheManifestExists::matches`  (lines 1975–1977)

```
fn matches(&self, _request: &Request) -> bool
```

**Purpose**: Implements a custom wiremock matcher that succeeds only after a specific manifest file has been written to disk. It lets tests assert ordering between local cache extraction and remote install POST.

**Data flow**: Reads `self.manifest_path` and returns `true` if `is_file()` reports that the path exists as a file, ignoring the incoming HTTP request contents. It does not mutate state.

**Call relations**: This matcher is used only by `mount_remote_plugin_install_after_cache_write`, where it gates the install endpoint until the app-server has written `.codex-plugin/plugin.json` into the cache.

*Call graph*: 1 external calls (is_file).


##### `mount_remote_plugin_install_after_cache_write`  (lines 1980–1998)

```
async fn mount_remote_plugin_install_after_cache_write(
    server: &MockServer,
    remote_plugin_id: &str,
    manifest_path: std::path::PathBuf,
)
```

**Purpose**: Mounts a remote install endpoint that becomes matchable only after the local cache manifest exists. It is used to prove the app-server writes the bundle to disk before calling the cloud install API.

**Data flow**: Registers a wiremock `POST /backend-api/ps/plugins/{remote_plugin_id}/install` handler requiring auth headers and additionally matching `CacheManifestExists { manifest_path }`; when matched, it returns HTTP 200 with a JSON body containing the plugin id and `enabled: true`.

**Call relations**: Only the remote cache-write happy-path test uses this helper. It creates a causal dependency between local extraction and backend install that the test can observe without instrumenting production code.

*Call graph*: called by 1 (plugin_install_writes_remote_plugin_to_cloud_and_cache); 6 external calls (given, new, format!, header, method, path).


##### `send_remote_plugin_install_request`  (lines 2000–2010)

```
async fn send_remote_plugin_install_request(
    mcp: &mut TestAppServer,
    remote_plugin_id: &str,
) -> Result<i64>
```

**Purpose**: Sends a typed remote install request while intentionally ignoring the caller-supplied marketplace name. It standardizes how tests invoke remote installs by plugin id.

**Data flow**: Takes a mutable `TestAppServer` and remote plugin id string, constructs `PluginInstallParams` with `marketplace_path: None`, `remote_marketplace_name: Some("caller-marketplace-is-ignored")`, and `plugin_name` set to the remote id, then forwards it to `send_plugin_install_request`. It returns the integer request id.

**Call relations**: Most remote install tests call this helper instead of constructing params inline. Its role is to keep those tests focused on plugin ids and backend behavior rather than the nominal marketplace-name field.

*Call graph*: calls 1 internal fn (send_plugin_install_request); called by 10 (plugin_install_errors_when_remote_bundle_download_fails, plugin_install_rejects_invalid_remote_release_version, plugin_install_rejects_missing_remote_bundle_url, plugin_install_rejects_plain_http_remote_bundle_url, plugin_install_rejects_remote_plugin_disabled_by_admin_before_download, plugin_install_skips_remote_mcp_oauth_for_bundled_same_name_app, plugin_install_starts_remote_mcp_oauth_for_install_response_only_app, plugin_install_tracks_remote_plugin_analytics_event, plugin_install_uses_remote_apps_needing_auth_response, plugin_install_writes_remote_plugin_to_cloud_and_cache).


##### `wait_for_remote_plugin_request_count`  (lines 2012–2042)

```
async fn wait_for_remote_plugin_request_count(
    server: &MockServer,
    method_name: &str,
    path_suffix: &str,
    expected_count: usize,
) -> Result<()>
```

**Purpose**: Polls a mock backend until it has observed exactly the expected number of requests for a given HTTP method and path suffix. It is used to assert both presence and absence of remote install side effects.

**Data flow**: Within a timeout-wrapped loop, fetches recorded requests from the `MockServer`, errors if wiremock has no request log, filters requests whose method equals `method_name` and whose path ends with `path_suffix`, and compares the count to `expected_count`. It returns success on equality, bails on excess, or sleeps 10 ms and retries otherwise.

**Call relations**: Many remote install tests call this helper after issuing a request to verify sequencing: whether bundle downloads happened, whether install POSTs were skipped, or whether exactly one backend call occurred.

*Call graph*: called by 7 (plugin_install_errors_when_remote_bundle_download_fails, plugin_install_rejects_invalid_remote_release_version, plugin_install_rejects_missing_remote_bundle_url, plugin_install_rejects_plain_http_remote_bundle_url, plugin_install_rejects_remote_plugin_disabled_by_admin_before_download, plugin_install_uses_remote_apps_needing_auth_response, plugin_install_writes_remote_plugin_to_cloud_and_cache); 5 external calls (from_millis, received_requests, bail!, sleep, timeout).


##### `write_plugin_marketplace`  (lines 2044–2089)

```
fn write_plugin_marketplace(
    repo_root: &std::path::Path,
    marketplace_name: &str,
    plugin_name: &str,
    source_path: &str,
    install_policy: Option<&str>,
    auth_policy: Option<&str>,
```

**Purpose**: Creates a local marketplace fixture file under a fake repository, optionally including installation and authentication policy metadata. It also ensures the repository has `.git` and `.agents/plugins` directories.

**Data flow**: Accepts repo root, marketplace name, plugin name, source path, and optional install/auth policy strings; formats a `policy` JSON fragment only when needed; creates `.git` and `.agents/plugins` directories; and writes `.agents/plugins/marketplace.json` containing a single local plugin entry with the requested source and optional policy block.

**Call relations**: Many local install tests call this helper to generate marketplace fixtures with different policy combinations. It is foundational setup for the local plugin-install path.

*Call graph*: called by 9 (plugin_install_filters_disallowed_apps_needing_auth, plugin_install_makes_bundled_mcp_servers_available_to_followup_requests, plugin_install_rejects_when_workspace_codex_plugins_disabled, plugin_install_returns_apps_needing_auth, plugin_install_returns_invalid_request_for_not_available_plugin, plugin_install_skips_mcp_oauth_for_chatgpt_dual_surface_plugin, plugin_install_starts_mcp_oauth_for_api_key_dual_surface_plugin, plugin_install_starts_mcp_oauth_when_only_plugin_apps_are_disallowed, plugin_install_tracks_analytics_event); 5 external calls (join, new, format!, create_dir_all, write).


##### `write_plugin_source`  (lines 2091–2112)

```
fn write_plugin_source(
    repo_root: &std::path::Path,
    plugin_name: &str,
    app_ids: &[&str],
) -> Result<()>
```

**Purpose**: Creates a minimal local plugin bundle on disk with `.codex-plugin/plugin.json` and `.app.json` listing the supplied app ids. It gives install tests a concrete plugin source tree to copy from.

**Data flow**: Creates `<repo_root>/<plugin_name>/.codex-plugin`, writes `plugin.json` containing the plugin name, builds a JSON object mapping each app id to `{ "id": app_id }`, serializes it prettily as `{ "apps": ... }`, and writes that to `.app.json`. It returns `Result<()>` and propagates serialization or filesystem errors.

**Call relations**: Local install tests use this helper alongside `write_plugin_marketplace` to create installable plugin sources. Some tests later add `.mcp.json` manually on top of this base fixture.

*Call graph*: called by 10 (plugin_install_filters_disallowed_apps_needing_auth, plugin_install_makes_bundled_mcp_servers_available_to_followup_requests, plugin_install_rejects_when_workspace_codex_plugins_disabled, plugin_install_returns_apps_needing_auth, plugin_install_returns_invalid_request_for_disallowed_product_plugin, plugin_install_returns_invalid_request_for_not_available_plugin, plugin_install_skips_mcp_oauth_for_chatgpt_dual_surface_plugin, plugin_install_starts_mcp_oauth_for_api_key_dual_surface_plugin, plugin_install_starts_mcp_oauth_when_only_plugin_apps_are_disallowed, plugin_install_tracks_analytics_event); 6 external calls (join, format!, json!, to_vec_pretty, create_dir_all, write).


##### `write_plugin_mcp_config`  (lines 2114–2133)

```
fn write_plugin_mcp_config(
    repo_root: &std::path::Path,
    plugin_name: &str,
    mcp_base_url: &str,
) -> Result<()>
```

**Purpose**: Writes a `.mcp.json` file for a local plugin fixture that defines a single HTTP MCP server named `sample-mcp`. It is used to trigger MCP OAuth discovery logic during install.

**Data flow**: Formats a JSON document under `<repo_root>/<plugin_name>/.mcp.json` with `mcpServers.sample-mcp.type = "http"` and `url = "{mcp_base_url}/mcp"`, writes it to disk, and returns `Result<()>`.

**Call relations**: The MCP OAuth tests call this helper after `write_plugin_source` to augment the plugin fixture with an MCP server definition.

*Call graph*: called by 3 (plugin_install_skips_mcp_oauth_for_chatgpt_dual_surface_plugin, plugin_install_starts_mcp_oauth_for_api_key_dual_surface_plugin, plugin_install_starts_mcp_oauth_when_only_plugin_apps_are_disallowed); 3 external calls (join, format!, write).


##### `remote_plugin_bundle_tar_gz_bytes`  (lines 2135–2138)

```
fn remote_plugin_bundle_tar_gz_bytes(plugin_name: &str) -> Result<Vec<u8>>
```

**Purpose**: Builds a simple remote plugin tar.gz bundle containing a plugin manifest and a sample skill. It is the default artifact generator for remote install tests.

**Data flow**: Formats a minimal plugin manifest JSON string with the supplied plugin name and forwards it to `remote_plugin_bundle_tar_gz_bytes_with_contents` with no app manifest. It returns the compressed tarball bytes.

**Call relations**: Several remote install tests call this helper when they only need a basic bundle. It is a convenience wrapper over the more general tarball builders.

*Call graph*: calls 1 internal fn (remote_plugin_bundle_tar_gz_bytes_with_contents); called by 3 (plugin_install_rejects_remote_plugin_disabled_by_admin_before_download, plugin_install_tracks_remote_plugin_analytics_event, plugin_install_uses_remote_apps_needing_auth_response); 1 external calls (format!).


##### `remote_plugin_bundle_tar_gz_bytes_with_mcp_config`  (lines 2140–2160)

```
fn remote_plugin_bundle_tar_gz_bytes_with_mcp_config(
    plugin_name: &str,
    mcp_base_url: &str,
) -> Result<Vec<u8>>
```

**Purpose**: Builds a remote plugin tar.gz bundle that includes both a plugin manifest and `.mcp.json`. It supports remote install tests that need MCP OAuth startup after extraction.

**Data flow**: Formats a plugin manifest and an `.mcp.json` document pointing `sample-mcp` at `{mcp_base_url}/mcp`, then forwards both to `remote_plugin_bundle_tar_gz_bytes_with_entries` with no app manifest. It returns the resulting compressed tarball bytes.

**Call relations**: The remote MCP OAuth startup test uses this helper to ensure the downloaded bundle exposes an MCP server definition.

*Call graph*: calls 1 internal fn (remote_plugin_bundle_tar_gz_bytes_with_entries); called by 1 (plugin_install_starts_remote_mcp_oauth_for_install_response_only_app); 1 external calls (format!).


##### `remote_plugin_bundle_tar_gz_bytes_with_app_and_mcp_config`  (lines 2162–2183)

```
fn remote_plugin_bundle_tar_gz_bytes_with_app_and_mcp_config(
    plugin_name: &str,
    app_manifest: &str,
    mcp_base_url: &str,
) -> Result<Vec<u8>>
```

**Purpose**: Builds a remote plugin tar.gz bundle containing a plugin manifest, `.app.json`, and `.mcp.json`. It is used for tests that need to reason about overlap between bundled apps and MCP servers.

**Data flow**: Formats a plugin manifest and `.mcp.json`, accepts an app-manifest string, and forwards all three entries to `remote_plugin_bundle_tar_gz_bytes_with_entries`. It returns the compressed tarball bytes.

**Call relations**: The remote same-name app/MCP deduplication test uses this helper to create a bundle where app and MCP metadata can be compared after extraction.

*Call graph*: calls 1 internal fn (remote_plugin_bundle_tar_gz_bytes_with_entries); called by 1 (plugin_install_skips_remote_mcp_oauth_for_bundled_same_name_app); 1 external calls (format!).


##### `remote_plugin_bundle_tar_gz_bytes_with_contents`  (lines 2185–2194)

```
fn remote_plugin_bundle_tar_gz_bytes_with_contents(
    plugin_manifest: &str,
    app_manifest: Option<&str>,
) -> Result<Vec<u8>>
```

**Purpose**: Builds a remote plugin tar.gz bundle from an arbitrary plugin manifest string and optional app manifest. It is a mid-level helper used when tests need custom plugin manifest contents.

**Data flow**: Forwards the provided plugin manifest string, optional app manifest, and no MCP config to `remote_plugin_bundle_tar_gz_bytes_with_entries`, returning the resulting tar.gz bytes.

**Call relations**: The remote cache-write test and the simpler `remote_plugin_bundle_tar_gz_bytes` wrapper both use this helper to avoid duplicating tarball assembly logic.

*Call graph*: calls 1 internal fn (remote_plugin_bundle_tar_gz_bytes_with_entries); called by 2 (plugin_install_writes_remote_plugin_to_cloud_and_cache, remote_plugin_bundle_tar_gz_bytes).


##### `remote_plugin_bundle_tar_gz_bytes_with_entries`  (lines 2196–2230)

```
fn remote_plugin_bundle_tar_gz_bytes_with_entries(
    plugin_manifest: &str,
    app_manifest: Option<&str>,
    mcp_config: Option<&str>,
) -> Result<Vec<u8>>
```

**Purpose**: Constructs the actual tar.gz archive bytes for remote plugin bundle fixtures. It writes the requested manifest files plus a sample skill into a tar stream and gzip-compresses it.

**Data flow**: Creates a `GzEncoder<Vec<u8>>` and `tar::Builder`, seeds an entry list with `.codex-plugin/plugin.json` and `skills/plan-work/SKILL.md`, conditionally appends `.app.json` and `.mcp.json`, then for each entry creates a GNU tar header, sets size/mode/checksum, and appends the file contents. Finally it finalizes the tar builder and gzip encoder and returns the resulting `Vec<u8>`.

**Call relations**: All remote bundle builders funnel into this function. It is the lowest-level artifact generator that makes remote install tests exercise real archive extraction paths.

*Call graph*: called by 3 (remote_plugin_bundle_tar_gz_bytes_with_app_and_mcp_config, remote_plugin_bundle_tar_gz_bytes_with_contents, remote_plugin_bundle_tar_gz_bytes_with_mcp_config); 6 external calls (new, new, default, new, new_gnu, vec!).


### `app-server/tests/suite/v2/plugin_share.rs`

`test` · `request handling`

This test module builds realistic plugin-share scenarios around `TestAppServer`, `wiremock::MockServer`, and temporary filesystem state. The positive save path creates a minimal local plugin tree (`.codex-plugin/plugin.json` plus a sample skill), configures ChatGPT auth and remote-plugin features, then mocks the three-step backend flow: request upload URL, upload gzip bundle, and create workspace plugin share. It also verifies that corrupted local path mapping state in `.tmp/plugin-share-local-paths-v1.json` is tolerated and replaced by fresh data. Listing tests combine mocked `/ps/plugins/workspace/created` and `/ps/plugins/installed` responses into expected `PluginShareListItem` values, including `PluginSummary`, `PluginShareContext`, and optional `local_plugin_path` resolution.

Checkout tests are more involved: they synthesize a tar.gz plugin bundle, allow HTTP bundle downloads via `CODEX_TEST_ALLOW_HTTP_REMOTE_PLUGIN_BUNDLE_DOWNLOADS`, and assert that checkout writes a plugin under `$HOME/plugins/<name>`, updates `~/.agents/plugins/marketplace.json`, and persists a remote-plugin-id→local-path mapping under codex home. They also cover idempotent re-checkout preserving local edits, rejection of non-workspace/non-share plugins, and cleanup when marketplace update fails. Negative tests enforce API invariants: LISTED discoverability is rejected on save, workspace principals cannot be supplied by clients, access policy updates are only allowed on creation, and feature flags can disable sharing entirely. Helper functions centralize config writing, mock response bodies, tarball generation, and small filesystem fixtures.

#### Function details

##### `plugin_share_save_uploads_local_plugin`  (lines 53–191)

```
async fn plugin_share_save_uploads_local_plugin() -> Result<()>
```

**Purpose**: Verifies the full happy path for `plugin/share/save` when given a local plugin directory, including upload, share creation, path-mapping recovery, and subsequent visibility through `plugin/share/list`.

**Data flow**: Creates temporary codex home and plugin root directories, writes a minimal plugin tree, writes remote-plugin config and ChatGPT auth, and intentionally writes invalid JSON into the local path-mapping file. It mounts backend mocks for upload URL creation, blob upload, plugin-share creation, then sends a raw JSON-RPC `plugin/share/save` request with an `AbsolutePathBuf`. After decoding `PluginShareSaveResponse`, it mounts list/install mocks, sends `plugin/share/list`, decodes `PluginShareListResponse`, and asserts the returned `PluginSummary`, `PluginShareContext`, and recovered `local_plugin_path`.

**Call relations**: This is a top-level async test invoked by the test runner. It relies on local helpers to create plugin/config fixtures and then drives the app server through initialization, save, and list requests to prove the save flow feeds the later list flow.

*Call graph*: calls 6 internal fn (new, new, write_corrupt_plugin_share_local_path_mapping, write_remote_plugin_config, write_test_plugin, try_from); 16 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, json! (+6 more)).


##### `plugin_share_save_forwards_access_policy`  (lines 194–289)

```
async fn plugin_share_save_forwards_access_policy() -> Result<()>
```

**Purpose**: Checks that share discoverability and explicit user targets supplied on creation are forwarded to the backend, with the workspace reader target added server-side.

**Data flow**: Builds temp config/auth/plugin state, mounts upload and create mocks, and expects the create request body to contain `discoverability: UNLISTED` plus both the user editor target from the client and the workspace reader target for the authenticated account. It sends `plugin/share/save`, reads the JSON-RPC response, converts it to `PluginShareSaveResponse`, and asserts the returned remote plugin id and share URL.

**Call relations**: Run directly by the test harness, this test focuses on request-shaping during the create-share branch. It delegates fixture creation to `write_remote_plugin_config` and `write_test_plugin`, then validates the backend POST body through wiremock.

*Call graph*: calls 5 internal fn (new, new, write_remote_plugin_config, write_test_plugin, try_from); 15 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, json! (+5 more)).


##### `plugin_share_save_rejects_listed_discoverability`  (lines 292–331)

```
async fn plugin_share_save_rejects_listed_discoverability() -> Result<()>
```

**Purpose**: Ensures the API rejects `discoverability = LISTED` before any backend interaction.

**Data flow**: Creates temp plugin/config/auth state, initializes the app server, sends `plugin/share/save` with a local plugin path and `discoverability: LISTED`, then waits for a `JSONRPCError`. It asserts invalid-request code `-32600` and the exact explanatory message naming supported values.

**Call relations**: This test is invoked by the runner as a validation-only case. It exercises the server’s input validation path and intentionally avoids mounting backend mocks because the request should fail locally.

*Call graph*: calls 4 internal fn (new, new, write_remote_plugin_config, write_test_plugin); 8 external calls (start, new, Integer, write_chatgpt_auth, assert_eq!, format!, json!, timeout).


##### `plugin_share_save_rejects_when_plugin_sharing_disabled`  (lines 334–389)

```
async fn plugin_share_save_rejects_when_plugin_sharing_disabled() -> Result<()>
```

**Purpose**: Confirms that the plugin-sharing feature flag blocks share creation entirely.

**Data flow**: Writes a `config.toml` with `plugin_sharing = false`, writes auth and a local plugin fixture, initializes the server, and sends `plugin/share/save`. It reads a `JSONRPCError`, checks for code `-32600` and message `plugin sharing is disabled`, then inspects the mock server’s recorded requests to ensure no HTTP calls were made.

**Call relations**: This top-level test covers feature gating before transport work begins. It depends on `write_test_plugin` for local input but otherwise proves the request is rejected in-process.

*Call graph*: calls 3 internal fn (new, new, write_test_plugin); 10 external calls (start, new, Integer, write_chatgpt_auth, assert!, assert_eq!, format!, json!, write, timeout).


##### `plugin_share_rejects_workspace_targets_from_client`  (lines 392–467)

```
async fn plugin_share_rejects_workspace_targets_from_client() -> Result<()>
```

**Purpose**: Validates that clients cannot directly specify workspace principals in `shareTargets` for either save or update-targets operations.

**Data flow**: Creates temp plugin/config/auth state, initializes the server, sends `plugin/share/save` with a workspace principal target, reads and asserts the invalid-request error, then repeats with `plugin/share/updateTargets` using the same forbidden target. Both responses must carry the same explanatory message directing clients to use `UNLISTED` discoverability instead.

**Call relations**: The test runner invokes this as a shared validation case for two RPCs. It demonstrates that both creation and update paths share the same client-input restriction.

*Call graph*: calls 4 internal fn (new, new, write_remote_plugin_config, write_test_plugin); 8 external calls (start, new, Integer, write_chatgpt_auth, assert_eq!, format!, json!, timeout).


##### `plugin_share_save_rejects_access_policy_for_existing_plugin`  (lines 470–517)

```
async fn plugin_share_save_rejects_access_policy_for_existing_plugin() -> Result<()>
```

**Purpose**: Checks that discoverability and share targets cannot be changed through `plugin/share/save` when `remotePluginId` indicates an existing share.

**Data flow**: Creates temp plugin/config/auth state, initializes the server, sends `plugin/share/save` with both a local path and `remotePluginId` plus access-policy fields, then reads a `JSONRPCError`. It asserts invalid-request code and the message instructing callers to use `plugin/share/updateTargets` instead.

**Call relations**: This test is a pure validation branch. It is called by the test harness to ensure the save RPC distinguishes create-vs-update semantics before any backend upload or mutation occurs.

*Call graph*: calls 4 internal fn (new, new, write_remote_plugin_config, write_test_plugin); 8 external calls (start, new, Integer, write_chatgpt_auth, assert_eq!, format!, json!, timeout).


##### `plugin_share_list_returns_created_workspace_plugins`  (lines 520–595)

```
async fn plugin_share_list_returns_created_workspace_plugins() -> Result<()>
```

**Purpose**: Verifies that `plugin/share/list` returns created workspace plugins merged with installed-state information from the remote catalog.

**Data flow**: Writes remote-plugin config and ChatGPT auth, mounts `/ps/plugins/workspace/created` and `/ps/plugins/installed?scope=WORKSPACE` mocks, initializes the app server, sends `plugin/share/list`, decodes `PluginShareListResponse`, and asserts a single `PluginShareListItem` with remote source, installed/enabled flags, expected interface metadata, and no local path mapping.

**Call relations**: This test is invoked directly and exercises the read-only listing path. It depends on helper JSON constructors for remote plugin detail and installed-plugin augmentation.

*Call graph*: calls 3 internal fn (new, new, write_remote_plugin_config); 15 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, json! (+5 more)).


##### `plugin_share_checkout_adds_personal_marketplace_entry`  (lines 598–763)

```
async fn plugin_share_checkout_adds_personal_marketplace_entry() -> Result<()>
```

**Purpose**: Tests the full checkout flow for a shared workspace plugin, including bundle download, local extraction, marketplace registration, path mapping, plugin listing visibility, and idempotent re-checkout behavior.

**Data flow**: Creates temp codex home and fake HOME directories, writes config/auth, mounts a downloadable tar.gz bundle and remote plugin detail, and starts the app server with HOME/USERPROFILE overrides plus the HTTP-download test env var. It sends `plugin/share/checkout`, decodes `PluginShareCheckoutResponse`, asserts the extracted plugin files and generated `marketplace.json`, reads the persisted remote-id mapping file, then issues `plugin/list` filtered to local marketplaces to confirm the checked-out plugin appears with share context. Finally it writes a local edit file, repeats checkout, and asserts the existing directory is reused without clobbering local edits.

**Call relations**: This is the most integrated checkout test and is run by the test harness. It composes several helpers—bundle generation, bundle/detail mock mounting, and installed-plugin mocking—to prove checkout affects both filesystem state and later plugin discovery.

*Call graph*: calls 8 internal fn (new, new_with_env, mount_empty_remote_installed_plugins, mount_remote_plugin_bundle, mount_remote_plugin_detail_with_bundle, remote_plugin_bundle_tar_gz_bytes, write_remote_plugin_config, try_from); 14 external calls (start, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, format!, json!, from_str (+4 more)).


##### `plugin_share_checkout_rejects_non_share_remote_plugin`  (lines 766–827)

```
async fn plugin_share_checkout_rejects_non_share_remote_plugin() -> Result<()>
```

**Purpose**: Ensures checkout refuses remote plugins that are not workspace-share plugins.

**Data flow**: Creates temp codex home and HOME, writes config/auth, mounts remote plugin detail with `scope = GLOBAL` and an empty installed list, starts the server with HTTP-download allowance, sends `plugin/share/checkout`, and reads a `JSONRPCError`. It asserts invalid-request semantics and confirms no plugin directory was created under the fake home.

**Call relations**: Invoked by the test runner, this case covers the eligibility check after remote detail lookup but before local extraction. It reuses the same checkout harness shape as the happy path with a different mocked scope.

*Call graph*: calls 5 internal fn (new, new_with_env, mount_empty_remote_installed_plugins, mount_remote_plugin_detail_with_bundle, write_remote_plugin_config); 9 external calls (start, new, Integer, write_chatgpt_auth, assert!, assert_eq!, format!, json!, timeout).


##### `plugin_share_checkout_cleans_up_path_when_marketplace_update_fails`  (lines 830–924)

```
async fn plugin_share_checkout_cleans_up_path_when_marketplace_update_fails() -> Result<()>
```

**Purpose**: Verifies that checkout removes partially created local state if marketplace registration fails due to a conflicting plugin entry.

**Data flow**: Pre-populates `~/.agents/plugins/marketplace.json` with a conflicting `demo-plugin` entry, then mounts a valid bundle and workspace plugin detail. After starting the server with HOME overrides and HTTP-download allowance, it sends `plugin/share/checkout`, reads the resulting `JSONRPCError`, and asserts both the extracted plugin directory and the codex-home path-mapping file were cleaned up.

**Call relations**: This test is called directly to cover rollback behavior in the checkout path. It uses the same helper setup as the successful checkout test but injects a marketplace conflict to force cleanup.

*Call graph*: calls 7 internal fn (new, new_with_env, mount_empty_remote_installed_plugins, mount_remote_plugin_bundle, mount_remote_plugin_detail_with_bundle, remote_plugin_bundle_tar_gz_bytes, write_remote_plugin_config); 12 external calls (start, new, Integer, write_chatgpt_auth, assert!, assert_eq!, format!, json!, to_string_pretty, create_dir_all (+2 more)).


##### `plugin_share_update_targets_updates_share_targets`  (lines 927–1039)

```
async fn plugin_share_update_targets_updates_share_targets() -> Result<()>
```

**Purpose**: Checks that `plugin/share/updateTargets` sends the expected backend payload and maps the returned principals/discoverability into protocol types.

**Data flow**: Writes config/auth, mounts a `PUT /ps/plugins/plugins_123/shares` mock expecting `discoverability: UNLISTED` and both user and workspace targets, initializes the server, sends `plugin/share/updateTargets`, decodes `PluginShareUpdateTargetsResponse`, and asserts the returned principal list and `PluginShareDiscoverability::Unlisted` value.

**Call relations**: This top-level test exercises the update-targets mutation path after validation. It relies on wiremock body matching to prove the app server transforms client camelCase fields into backend snake_case payloads.

*Call graph*: calls 3 internal fn (new, new, write_remote_plugin_config); 15 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, json! (+5 more)).


##### `plugin_share_update_targets_rejects_when_plugin_sharing_disabled`  (lines 1042–1090)

```
async fn plugin_share_update_targets_rejects_when_plugin_sharing_disabled() -> Result<()>
```

**Purpose**: Confirms the update-targets RPC is blocked by the same feature flag as share creation.

**Data flow**: Writes a config with `plugin_sharing = false`, writes auth, initializes the server, sends `plugin/share/updateTargets`, and reads a `JSONRPCError`. It asserts invalid-request code and the exact `plugin sharing is disabled` message.

**Call relations**: Run by the test harness as a feature-gating case, this test mirrors the disabled-save scenario for the update-targets endpoint.

*Call graph*: calls 2 internal fn (new, new); 9 external calls (start, new, Integer, write_chatgpt_auth, assert_eq!, format!, json!, write, timeout).


##### `plugin_share_delete_removes_created_workspace_plugin`  (lines 1093–1196)

```
async fn plugin_share_delete_removes_created_workspace_plugin() -> Result<()>
```

**Purpose**: Verifies that deleting a shared workspace plugin succeeds and removes any persisted local-path mapping so later listing no longer reports a local checkout path.

**Data flow**: Writes config/auth, creates a local path mapping for `plugins_123`, mounts a successful `DELETE /public/plugins/workspace/plugins_123`, initializes the server, sends `plugin/share/delete`, and asserts an empty `PluginShareDeleteResponse`. It then mounts list/install mocks, calls `plugin/share/list`, decodes `PluginShareListResponse`, and asserts the plugin still appears remotely but with `local_plugin_path: None`.

**Call relations**: This test is invoked directly and links the delete mutation to subsequent list behavior. It uses `write_plugin_share_local_path_mapping` to seed state that the delete path should clear.

*Call graph*: calls 5 internal fn (new, new, write_plugin_share_local_path_mapping, write_remote_plugin_config, try_from); 15 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, json! (+5 more)).


##### `write_remote_plugin_config`  (lines 1198–1211)

```
fn write_remote_plugin_config(codex_home: &Path, base_url: &str) -> std::io::Result<()>
```

**Purpose**: Writes a minimal `config.toml` enabling plugins and remote plugins against a supplied backend base URL.

**Data flow**: Takes a codex-home path and backend base URL string, formats a TOML document with `chatgpt_base_url`, `[features].plugins = true`, and `remote_plugin = true`, then writes it to `<codex_home>/config.toml`.

**Call relations**: This helper is called by most plugin-share tests to put the app server into a remote-plugin-capable configuration before initialization.

*Call graph*: called by 11 (plugin_share_checkout_adds_personal_marketplace_entry, plugin_share_checkout_cleans_up_path_when_marketplace_update_fails, plugin_share_checkout_rejects_non_share_remote_plugin, plugin_share_delete_removes_created_workspace_plugin, plugin_share_list_returns_created_workspace_plugins, plugin_share_rejects_workspace_targets_from_client, plugin_share_save_forwards_access_policy, plugin_share_save_rejects_access_policy_for_existing_plugin, plugin_share_save_rejects_listed_discoverability, plugin_share_save_uploads_local_plugin (+1 more)); 3 external calls (join, format!, write).


##### `mount_remote_plugin_bundle`  (lines 1213–1230)

```
async fn mount_remote_plugin_bundle(
    server: &MockServer,
    plugin_name: &str,
    body: Vec<u8>,
) -> String
```

**Purpose**: Registers a wiremock endpoint that serves a gzipped plugin bundle and returns its absolute URL.

**Data flow**: Accepts a `MockServer`, plugin name, and raw bundle bytes; constructs `/bundles/<plugin>.tar.gz`, mounts a GET mock returning `application/gzip` with the provided bytes, and returns `server.uri() + bundle_path`.

**Call relations**: Checkout tests call this helper before mounting plugin detail so the detail response can reference a concrete downloadable bundle URL.

*Call graph*: called by 2 (plugin_share_checkout_adds_personal_marketplace_entry, plugin_share_checkout_cleans_up_path_when_marketplace_update_fails); 5 external calls (given, new, format!, method, path).


##### `mount_remote_plugin_detail_with_bundle`  (lines 1232–1274)

```
async fn mount_remote_plugin_detail_with_bundle(
    server: &MockServer,
    remote_plugin_id: &str,
    plugin_name: &str,
    bundle_url: &str,
    scope: &str,
)
```

**Purpose**: Mounts a remote-plugin detail response that includes release metadata, share metadata, and a bundle download URL.

**Data flow**: Builds and mounts a GET mock for `/backend-api/ps/plugins/<remote_plugin_id>?includeDownloadUrls=true` requiring auth headers. The JSON body includes id, name, scope, discoverability, share URL/principals, install/auth policies, and a `release` object with version, display metadata, interface capabilities, and `bundle_download_url`.

**Call relations**: Used by checkout-related tests to make the app server believe a remote plugin is shareable and downloadable. It feeds the detail-fetch step before extraction.

*Call graph*: called by 3 (plugin_share_checkout_adds_personal_marketplace_entry, plugin_share_checkout_cleans_up_path_when_marketplace_update_fails, plugin_share_checkout_rejects_non_share_remote_plugin); 8 external calls (given, new, format!, json!, header, method, path, query_param).


##### `mount_empty_remote_installed_plugins`  (lines 1276–1290)

```
async fn mount_empty_remote_installed_plugins(server: &MockServer, scope: &str)
```

**Purpose**: Mounts an installed-plugins listing endpoint that returns no installed plugins for a given scope.

**Data flow**: Registers a GET `/backend-api/ps/plugins/installed?scope=<scope>` mock requiring auth headers and returning `{ plugins: [], pagination: { next_page_token: null } }`.

**Call relations**: Checkout tests use this helper to ensure the app server sees the target plugin as not already installed remotely.

*Call graph*: called by 3 (plugin_share_checkout_adds_personal_marketplace_entry, plugin_share_checkout_cleans_up_path_when_marketplace_update_fails, plugin_share_checkout_rejects_non_share_remote_plugin); 7 external calls (given, new, json!, header, method, path, query_param).


##### `remote_plugin_json`  (lines 1292–1326)

```
fn remote_plugin_json(plugin_id: &str) -> serde_json::Value
```

**Purpose**: Constructs a canonical remote workspace-share plugin JSON object used in list-related mocks.

**Data flow**: Takes a plugin id and returns a `serde_json::Value` object containing fixed name, scope, discoverability, share URL, owner/reader principals, install/auth policies, and release/interface metadata.

**Call relations**: This helper is the base fixture for list tests and is further modified by `installed_remote_plugin_json` to represent installed state.

*Call graph*: called by 1 (installed_remote_plugin_json); 1 external calls (json!).


##### `installed_remote_plugin_json`  (lines 1328–1336)

```
fn installed_remote_plugin_json(plugin_id: &str) -> serde_json::Value
```

**Purpose**: Adds installed-state fields to the base remote plugin JSON fixture.

**Data flow**: Calls `remote_plugin_json`, pattern-matches the returned value as an object, inserts `enabled: true` and `disabled_skill_names: []`, and returns the modified JSON value. It panics with `unreachable!` if the base fixture is not an object.

**Call relations**: List tests use this helper for the `/ps/plugins/installed` endpoint so the app server can merge installation state into `PluginSummary`.

*Call graph*: calls 1 internal fn (remote_plugin_json); 2 external calls (json!, unreachable!).


##### `empty_pagination_json`  (lines 1338–1342)

```
fn empty_pagination_json() -> serde_json::Value
```

**Purpose**: Provides the standard pagination object used by mocked list endpoints.

**Data flow**: Returns a JSON object with `next_page_token: null`.

**Call relations**: Called inline by tests when constructing mock list responses for created and installed plugin endpoints.

*Call graph*: 1 external calls (json!).


##### `expected_plugin_interface`  (lines 1344–1364)

```
fn expected_plugin_interface() -> PluginInterface
```

**Purpose**: Builds the exact `PluginInterface` value expected from the mocked remote release metadata.

**Data flow**: Returns a `PluginInterface` struct populated with display name, short description, `Read`/`Write` capabilities, and all other optional fields unset or empty.

**Call relations**: Used in assertions for `plugin/share/list` responses so tests compare typed protocol values rather than raw JSON.

*Call graph*: 2 external calls (new, vec!).


##### `expected_share_context`  (lines 1366–1389)

```
fn expected_share_context(plugin_id: &str) -> PluginShareContext
```

**Purpose**: Builds the exact `PluginShareContext` expected from the mocked remote share metadata.

**Data flow**: Takes a plugin id and returns a `PluginShareContext` containing remote id/version, private discoverability, share URL, no creator identity, and two principals: owner and reader.

**Call relations**: List and delete-followup assertions use this helper to keep expected share metadata consistent with `remote_plugin_json`.

*Call graph*: 1 external calls (vec!).


##### `write_test_plugin`  (lines 1391–1402)

```
fn write_test_plugin(root: &Path, plugin_name: &str) -> std::io::Result<PathBuf>
```

**Purpose**: Creates a minimal local plugin directory tree suitable for upload tests.

**Data flow**: Given a root path and plugin name, creates `<root>/<plugin_name>/.codex-plugin/plugin.json` containing just the plugin name and `skills/example/SKILL.md` with sample markdown, then returns the plugin directory path.

**Call relations**: Save-related tests call this helper to produce a concrete local plugin path that the app server can package and upload.

*Call graph*: calls 1 internal fn (write_file); called by 6 (plugin_share_rejects_workspace_targets_from_client, plugin_share_save_forwards_access_policy, plugin_share_save_rejects_access_policy_for_existing_plugin, plugin_share_save_rejects_listed_discoverability, plugin_share_save_rejects_when_plugin_sharing_disabled, plugin_share_save_uploads_local_plugin); 2 external calls (join, format!).


##### `remote_plugin_bundle_tar_gz_bytes`  (lines 1404–1428)

```
fn remote_plugin_bundle_tar_gz_bytes(plugin_name: &str) -> Result<Vec<u8>>
```

**Purpose**: Synthesizes an in-memory `.tar.gz` plugin bundle matching the minimal plugin fixture layout.

**Data flow**: Formats a manifest JSON string and skill markdown, wraps a `flate2::write::GzEncoder` in `tar::Builder`, appends two entries with explicit GNU tar headers and mode `0o644`, then finalizes and returns the compressed bytes.

**Call relations**: Checkout tests call this helper before `mount_remote_plugin_bundle` so the mocked bundle download contains a valid plugin archive.

*Call graph*: called by 2 (plugin_share_checkout_adds_personal_marketplace_entry, plugin_share_checkout_cleans_up_path_when_marketplace_update_fails); 6 external calls (new, new, default, format!, new, new_gnu).


##### `write_corrupt_plugin_share_local_path_mapping`  (lines 1430–1435)

```
fn write_corrupt_plugin_share_local_path_mapping(codex_home: &Path) -> std::io::Result<()>
```

**Purpose**: Seeds the plugin-share local-path mapping file with invalid contents to test recovery behavior.

**Data flow**: Writes the literal string `not-json` to `<codex_home>/.tmp/plugin-share-local-paths-v1.json` using `write_file`.

**Call relations**: Only the save happy-path test uses this helper to prove the app server ignores or repairs corrupt mapping state.

*Call graph*: calls 1 internal fn (write_file); called by 1 (plugin_share_save_uploads_local_plugin); 1 external calls (join).


##### `write_plugin_share_local_path_mapping`  (lines 1437–1455)

```
fn write_plugin_share_local_path_mapping(
    codex_home: &Path,
    remote_plugin_id: &str,
    plugin_path: &AbsolutePathBuf,
) -> std::io::Result<()>
```

**Purpose**: Writes a valid remote-plugin-id to local-path mapping file in the format expected by plugin-share code.

**Data flow**: Builds a `serde_json::Map` keyed by remote plugin id with the `AbsolutePathBuf` serialized as JSON, wraps it under `localPluginPathsByRemotePluginId`, pretty-prints the JSON with a trailing newline, and writes it to `.tmp/plugin-share-local-paths-v1.json`.

**Call relations**: The delete test uses this helper to pre-seed local checkout state that should be removed when a share is deleted.

*Call graph*: calls 1 internal fn (write_file); called by 1 (plugin_share_delete_removes_created_workspace_plugin); 6 external calls (join, format!, json!, new, to_string_pretty, to_value).


##### `write_file`  (lines 1457–1466)

```
fn write_file(path: &Path, contents: &str) -> std::io::Result<()>
```

**Purpose**: Creates parent directories and writes a text file, failing if the target path has no parent.

**Data flow**: Accepts a file path and string contents, derives the parent directory, returns an `std::io::Error::other` if absent, otherwise creates the parent tree and writes the contents to disk.

**Call relations**: This low-level helper underpins plugin fixture creation and mapping-file helpers so tests can write nested files without repeating directory setup.

*Call graph*: called by 3 (write_corrupt_plugin_share_local_path_mapping, write_plugin_share_local_path_mapping, write_test_plugin); 5 external calls (parent, other, format!, create_dir_all, write).


### `app-server/tests/suite/v2/plugin_uninstall.rs`

`test` · `request handling`

This module splits uninstall coverage into two broad paths. For local plugins, it creates a cached plugin directory under `plugins/cache/<marketplace>/<plugin>/local/.codex-plugin/plugin.json`, writes a matching `[plugins."<id>"]` section into `config.toml`, and confirms `plugin/uninstall` removes both the cache tree and config stanza. It also verifies idempotency by uninstalling the same local plugin twice. Analytics coverage points the app server at a dedicated mock analytics server, writes ChatGPT auth, performs uninstall, then polls recorded requests until it finds a POST to `/codex/analytics-events/events` with the expected `codex_plugin_uninstalled` payload.

For remote plugins, the tests enable `remote_plugin`, mock remote detail fetches and uninstall POSTs, and create cache directories in both current and legacy layouts. They verify that uninstall first fetches plugin detail to determine plugin name and scope, then posts to `/ps/plugins/<id>/uninstall`, and finally removes only the cache namespace implied by the detail scope (`openai-curated-remote` for global, `workspace-directory` for workspace). Additional tests accept workspace-style remote ids, reject when plugins are disabled, reject before POST when detail fetch fails, and reject malformed ids containing spaces, traversal-like segments, or emptiness before any network call. Helper functions centralize fixture creation, remote detail mocks, config writing, and polling wiremock request counts.

#### Function details

##### `plugin_uninstall_removes_plugin_cache_and_config_entry`  (lines 32–80)

```
async fn plugin_uninstall_removes_plugin_cache_and_config_entry() -> Result<()>
```

**Purpose**: Verifies local plugin uninstall removes both on-disk cache contents and the plugin’s config section, and remains harmless when repeated.

**Data flow**: Creates a temp codex home, writes an installed plugin cache tree and a config file containing `[plugins."sample-plugin@debug"] enabled = true`, initializes the app server, sends `PluginUninstallParams { plugin_id }`, decodes `PluginUninstallResponse`, and asserts the cache directory no longer exists and the config file no longer contains the plugin section. It then repeats the uninstall request and asserts another empty success response.

**Call relations**: This top-level test is run by the harness as the basic local uninstall case. It depends on `write_installed_plugin` to seed the cache layout the server is expected to remove.

*Call graph*: calls 2 internal fn (new, write_installed_plugin); 8 external calls (new, Integer, to_response, assert!, assert_eq!, read_to_string, write, timeout).


##### `plugin_uninstall_tracks_analytics_event`  (lines 83–153)

```
async fn plugin_uninstall_tracks_analytics_event() -> Result<()>
```

**Purpose**: Checks that uninstalling a local plugin emits the expected analytics event payload.

**Data flow**: Starts a mock analytics server, writes local plugin cache and config pointing `chatgpt_base_url` at that server, writes ChatGPT auth, initializes the app server, and performs uninstall. After asserting success, it polls `received_requests()` until it finds the analytics POST, parses the JSON body, and compares it to the expected event structure including plugin id/name, marketplace name, skill/server counts, connector ids, and `DEFAULT_CLIENT_NAME`.

**Call relations**: Invoked directly by the test runner, this test extends the local uninstall path by observing the side effect on the analytics transport after the uninstall response has been returned.

*Call graph*: calls 3 internal fn (new, new, write_installed_plugin); 12 external calls (from_millis, new, Integer, start_analytics_events_server, to_response, write_chatgpt_auth, assert_eq!, format!, from_slice, write (+2 more)).


##### `plugin_uninstall_rejects_remote_plugin_when_plugins_are_disabled`  (lines 156–186)

```
async fn plugin_uninstall_rejects_remote_plugin_when_plugins_are_disabled() -> Result<()>
```

**Purpose**: Ensures remote-plugin uninstall is rejected when the global plugins feature is disabled.

**Data flow**: Writes a config with `[features] plugins = false`, initializes the app server, sends uninstall for a remote-style plugin id, reads the error response, and asserts invalid-request code and a message indicating remote plugin uninstall is not enabled.

**Call relations**: This is a validation-only test run by the harness. It covers feature gating before any remote detail lookup or uninstall POST can occur.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Integer, assert!, assert_eq!, write, timeout).


##### `plugin_uninstall_writes_remote_plugin_to_cloud_when_remote_plugin_enabled`  (lines 189–259)

```
async fn plugin_uninstall_writes_remote_plugin_to_cloud_when_remote_plugin_enabled() -> Result<()>
```

**Purpose**: Verifies the remote uninstall flow fetches detail, posts uninstall to the backend, and removes both current and legacy cache directories for a global remote plugin.

**Data flow**: Creates temp codex home and mock server, writes remote-plugin catalog config and ChatGPT auth, mounts remote detail for `REMOTE_PLUGIN_ID` with version `1.0.0` and scope `GLOBAL`, and mounts a successful uninstall POST. It creates both the current cache root `plugins/cache/openai-curated-remote/linear/1.0.0/...` and the legacy cache root keyed by remote plugin id. After uninstalling through the app server and decoding `PluginUninstallResponse`, it waits until exactly one uninstall POST was observed and asserts both cache roots were deleted.

**Call relations**: This test is called directly to cover the successful remote uninstall branch. It uses `mount_remote_plugin_detail` and `wait_for_remote_plugin_request_count` to prove the GET-then-POST sequence and resulting cache cleanup.

*Call graph*: calls 5 internal fn (new, new, mount_remote_plugin_detail, wait_for_remote_plugin_request_count, write_remote_plugin_catalog_config); 16 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, format! (+6 more)).


##### `plugin_uninstall_uses_detail_scope_for_cache_namespace`  (lines 262–331)

```
async fn plugin_uninstall_uses_detail_scope_for_cache_namespace() -> Result<()>
```

**Purpose**: Checks that cache cleanup uses the plugin scope returned by remote detail rather than assuming the global namespace.

**Data flow**: Configures remote-plugin support and auth, mounts remote detail for `REMOTE_PLUGIN_ID` with scope `WORKSPACE`, mounts a successful uninstall POST, creates both workspace and global cache roots, then uninstalls the plugin. It waits for one uninstall POST and asserts the workspace cache root was removed while the global cache root remains.

**Call relations**: Run by the test harness, this test narrows in on namespace selection after detail fetch. It proves the detail response influences local cache deletion.

*Call graph*: calls 5 internal fn (new, new, mount_remote_plugin_detail, wait_for_remote_plugin_request_count, write_remote_plugin_catalog_config); 16 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, format! (+6 more)).


##### `plugin_uninstall_accepts_workspace_remote_plugin_id_shape`  (lines 334–404)

```
async fn plugin_uninstall_accepts_workspace_remote_plugin_id_shape() -> Result<()>
```

**Purpose**: Verifies uninstall accepts workspace-style remote plugin ids and removes the corresponding workspace cache tree.

**Data flow**: Writes remote-plugin config and auth, mounts remote detail with explicit plugin name `skill-improver`, version `1.0.0`, and scope `WORKSPACE` for `WORKSPACE_REMOTE_PLUGIN_ID`, mounts the uninstall POST, creates the workspace cache root, then sends uninstall and decodes success. It waits for one uninstall POST and asserts the cache root no longer exists.

**Call relations**: This top-level test covers identifier-shape compatibility for workspace remote plugins. It uses `mount_remote_plugin_detail_with_name` because the cache path depends on the plugin name returned by detail.

*Call graph*: calls 5 internal fn (new, new, mount_remote_plugin_detail_with_name, wait_for_remote_plugin_request_count, write_remote_plugin_catalog_config); 16 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, format! (+6 more)).


##### `plugin_uninstall_rejects_before_post_when_remote_detail_fetch_fails`  (lines 407–460)

```
async fn plugin_uninstall_rejects_before_post_when_remote_detail_fetch_fails() -> Result<()>
```

**Purpose**: Ensures the app server does not attempt the uninstall POST if the prerequisite remote detail request fails.

**Data flow**: Writes remote-plugin config and auth, creates only a legacy cache root, initializes the app server, sends uninstall for `REMOTE_PLUGIN_ID`, and reads an error response. It asserts invalid-request semantics mentioning the remote plugin catalog request, waits for exactly one GET detail request and zero POST uninstall requests, and confirms the legacy cache root still exists.

**Call relations**: This test is invoked directly to verify control flow ordering: detail fetch must succeed before uninstall POST or cache deletion can happen.

*Call graph*: calls 4 internal fn (new, new, wait_for_remote_plugin_request_count, write_remote_plugin_catalog_config); 9 external calls (start, new, Integer, write_chatgpt_auth, assert!, assert_eq!, format!, create_dir_all, timeout).


##### `plugin_uninstall_rejects_remote_plugin_id_with_spaces_before_network_call`  (lines 463–495)

```
async fn plugin_uninstall_rejects_remote_plugin_id_with_spaces_before_network_call() -> Result<()>
```

**Purpose**: Checks that remote plugin ids containing spaces are rejected locally without any backend traffic.

**Data flow**: Writes remote-plugin config, initializes the app server, sends uninstall for `sample plugin`, reads the error response, asserts invalid-request code and message containing `invalid remote plugin id`, then waits for zero matching POST requests.

**Call relations**: This validation test is run by the harness to prove malformed ids are filtered before URL construction or network I/O.

*Call graph*: calls 3 internal fn (new, wait_for_remote_plugin_request_count, write_remote_plugin_catalog_config); 7 external calls (start, new, Integer, assert!, assert_eq!, format!, timeout).


##### `plugin_uninstall_rejects_invalid_remote_plugin_id_before_network_call`  (lines 498–530)

```
async fn plugin_uninstall_rejects_invalid_remote_plugin_id_before_network_call() -> Result<()>
```

**Purpose**: Checks that traversal-like or otherwise invalid remote plugin ids are rejected before any network call.

**Data flow**: Writes remote-plugin config, initializes the app server, sends uninstall for `linear/../../oops`, reads the error response, asserts invalid-request semantics, and confirms zero uninstall POSTs were recorded.

**Call relations**: Like the spaces case, this test covers local identifier validation and ensures dangerous path-like ids never reach the backend layer.

*Call graph*: calls 3 internal fn (new, wait_for_remote_plugin_request_count, write_remote_plugin_catalog_config); 7 external calls (start, new, Integer, assert!, assert_eq!, format!, timeout).


##### `plugin_uninstall_rejects_empty_remote_plugin_id`  (lines 533–558)

```
async fn plugin_uninstall_rejects_empty_remote_plugin_id() -> Result<()>
```

**Purpose**: Ensures an empty remote plugin id is rejected as invalid input.

**Data flow**: Writes remote-plugin config, initializes the app server, sends uninstall with an empty `plugin_id`, reads the error response, and asserts invalid-request code and message containing `invalid remote plugin id`.

**Call relations**: This is the simplest malformed-id test and is invoked directly by the test runner to cover the empty-string edge case.

*Call graph*: calls 2 internal fn (new, write_remote_plugin_catalog_config); 8 external calls (start, new, new, Integer, assert!, assert_eq!, format!, timeout).


##### `write_installed_plugin`  (lines 560–577)

```
fn write_installed_plugin(
    codex_home: &TempDir,
    marketplace_name: &str,
    plugin_name: &str,
) -> Result<()>
```

**Purpose**: Creates the minimal local cache layout representing an installed plugin in a named marketplace.

**Data flow**: Builds `<codex_home>/plugins/cache/<marketplace>/<plugin>/local/.codex-plugin`, creates the directory tree, writes `plugin.json` containing the plugin name, and returns success as `anyhow::Result<()>`.

**Call relations**: Used by local uninstall tests to seed the exact cache structure the app server should remove.

*Call graph*: called by 2 (plugin_uninstall_removes_plugin_cache_and_config_entry, plugin_uninstall_tracks_analytics_event); 4 external calls (path, format!, create_dir_all, write).


##### `write_remote_plugin_catalog_config`  (lines 579–595)

```
fn write_remote_plugin_catalog_config(
    codex_home: &std::path::Path,
    base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes a minimal config enabling plugins and remote-plugin catalog access against a supplied backend URL.

**Data flow**: Formats and writes `config.toml` with `chatgpt_base_url`, `[features].plugins = true`, and `remote_plugin = true` under the provided codex-home path.

**Call relations**: All remote uninstall tests call this helper before initialization so the app server takes the remote-plugin code path.

*Call graph*: called by 7 (plugin_uninstall_accepts_workspace_remote_plugin_id_shape, plugin_uninstall_rejects_before_post_when_remote_detail_fetch_fails, plugin_uninstall_rejects_empty_remote_plugin_id, plugin_uninstall_rejects_invalid_remote_plugin_id_before_network_call, plugin_uninstall_rejects_remote_plugin_id_with_spaces_before_network_call, plugin_uninstall_uses_detail_scope_for_cache_namespace, plugin_uninstall_writes_remote_plugin_to_cloud_when_remote_plugin_enabled); 3 external calls (join, format!, write).


##### `mount_remote_plugin_detail`  (lines 597–611)

```
async fn mount_remote_plugin_detail(
    server: &MockServer,
    remote_plugin_id: &str,
    release_version: &str,
    scope: &str,
)
```

**Purpose**: Convenience wrapper that mounts remote detail for the default plugin name `linear`.

**Data flow**: Forwards the server, remote plugin id, release version, and scope to `mount_remote_plugin_detail_with_name` with `plugin_name = "linear"`.

**Call relations**: Remote uninstall tests use this helper when the plugin name does not need to vary; it keeps fixture setup concise.

*Call graph*: calls 1 internal fn (mount_remote_plugin_detail_with_name); called by 2 (plugin_uninstall_uses_detail_scope_for_cache_namespace, plugin_uninstall_writes_remote_plugin_to_cloud_when_remote_plugin_enabled).


##### `mount_remote_plugin_detail_with_name`  (lines 613–653)

```
async fn mount_remote_plugin_detail_with_name(
    server: &MockServer,
    remote_plugin_id: &str,
    plugin_name: &str,
    release_version: &str,
    scope: &str,
)
```

**Purpose**: Mounts a remote-plugin detail endpoint returning a specific plugin name, version, and scope.

**Data flow**: Builds a JSON response body string for `/backend-api/ps/plugins/<remote_plugin_id>`, conditionally injecting `discoverability: LISTED` for workspace scope, and includes install/auth policies plus release metadata. It mounts a GET mock requiring auth headers and returning that body.

**Call relations**: This helper feeds the detail-fetch step of remote uninstall. Tests use it directly when cache-path assertions depend on the returned plugin name.

*Call graph*: called by 2 (mount_remote_plugin_detail, plugin_uninstall_accepts_workspace_remote_plugin_id_shape); 6 external calls (given, new, format!, header, method, path).


##### `wait_for_remote_plugin_request_count`  (lines 655–688)

```
async fn wait_for_remote_plugin_request_count(
    server: &MockServer,
    method_name: &str,
    path_suffix: &str,
    expected_count: usize,
) -> Result<()>
```

**Purpose**: Polls wiremock until the exact number of matching requests has been observed, failing on timeout or excess requests.

**Data flow**: Given a mock server, HTTP method, path suffix, and expected count, it repeatedly fetches recorded requests, filters by method and `url.path().ends_with(path_suffix)`, and returns success when the count matches. It bails immediately if requests are unavailable when a nonzero count is expected, or if the observed count exceeds the target.

**Call relations**: Remote uninstall tests call this helper after issuing requests to assert both positive and negative network behavior, such as one detail GET, one uninstall POST, or zero POSTs on validation failures.

*Call graph*: called by 6 (plugin_uninstall_accepts_workspace_remote_plugin_id_shape, plugin_uninstall_rejects_before_post_when_remote_detail_fetch_fails, plugin_uninstall_rejects_invalid_remote_plugin_id_before_network_call, plugin_uninstall_rejects_remote_plugin_id_with_spaces_before_network_call, plugin_uninstall_uses_detail_scope_for_cache_namespace, plugin_uninstall_writes_remote_plugin_to_cloud_when_remote_plugin_enabled); 5 external calls (from_millis, received_requests, bail!, sleep, timeout).


### `app-server/tests/suite/v2/marketplace_remove.rs`

`test` · `request handling`

This file validates that marketplace removal updates both persistent configuration and the installed marketplace directory tree. The helper `configured_marketplace_update` returns a concrete `MarketplaceConfigUpdate<'static>` describing a Git-backed marketplace with a fixed timestamp, source URL, and `main` ref; tests use it to seed `config.toml` through `record_user_marketplace`. `write_installed_marketplace` mirrors the runtime install layout by creating `<install-root>/<name>/.agents/plugins/marketplace.json`, which is enough for the server to treat the marketplace as installed. `canonicalize_path_with_existing_parent` is a defensive comparison helper: it canonicalizes only the parent directory and rejoins the file name, allowing path comparison even after the target itself has been deleted. The success test seeds both config and install state, starts the app server, sends `MarketplaceRemoveParams { marketplace_name: "debug" }`, decodes `MarketplaceRemoveResponse`, and confirms the returned removed root matches the expected install path. It then reads `config.toml` to ensure the `[marketplaces.debug]` section is gone and checks the install directory no longer exists. The negative test starts from an empty home and confirms the server returns JSON-RPC error code `-32600` with the precise message that the marketplace is neither configured nor installed.

#### Function details

##### `configured_marketplace_update`  (lines 20–29)

```
fn configured_marketplace_update() -> MarketplaceConfigUpdate<'static>
```

**Purpose**: Builds a fixed Git marketplace configuration payload used to seed user config for removal tests.

**Data flow**: It takes no arguments and returns a `MarketplaceConfigUpdate<'static>` populated with a constant timestamp, `source_type` of `git`, a GitHub repository URL, `ref_name` of `Some("main")`, no recorded revision, and an empty sparse path slice.

**Call relations**: It is a pure fixture helper used by `marketplace_remove_deletes_config_and_installed_root` before calling `record_user_marketplace`, so the test can create a configured marketplace without duplicating literal field values.

*Call graph*: called by 1 (marketplace_remove_deletes_config_and_installed_root).


##### `write_installed_marketplace`  (lines 31–36)

```
fn write_installed_marketplace(codex_home: &std::path::Path, marketplace_name: &str) -> Result<()>
```

**Purpose**: Creates the minimal on-disk installed-marketplace structure expected by the removal path.

**Data flow**: Given `codex_home` and a marketplace name, it computes the install root with `marketplace_install_root(codex_home).join(marketplace_name)`, creates `.agents/plugins`, writes an empty `marketplace.json`, and returns `Result<()>`.

**Call relations**: The successful removal test invokes it after seeding config so the server sees both configured and installed state. It delegates install-root path construction to the production helper `marketplace_install_root` to match runtime layout exactly.

*Call graph*: calls 1 internal fn (marketplace_install_root); called by 1 (marketplace_remove_deletes_config_and_installed_root); 2 external calls (create_dir_all, write).


##### `canonicalize_path_with_existing_parent`  (lines 38–47)

```
fn canonicalize_path_with_existing_parent(path: &std::path::Path) -> Result<std::path::PathBuf>
```

**Purpose**: Normalizes a path for comparison even when the final path component may no longer exist.

**Data flow**: It accepts a `&Path`, extracts its parent and file name with contextual errors if either is missing, canonicalizes only the parent directory, rejoins the original file name, and returns the resulting `PathBuf`.

**Call relations**: The success test uses it when comparing the response’s removed install root against the expected path after deletion, avoiding failure from canonicalizing a path that has already been removed.

*Call graph*: 2 external calls (file_name, parent).


##### `marketplace_remove_deletes_config_and_installed_root`  (lines 50–88)

```
async fn marketplace_remove_deletes_config_and_installed_root() -> Result<()>
```

**Purpose**: Verifies that removing a known marketplace deletes both its config entry and its installed directory and reports the removed root in the response.

**Data flow**: It creates a temporary Codex home, writes a configured marketplace entry using `configured_marketplace_update`, creates the installed marketplace tree with `write_installed_marketplace`, computes the expected install path, starts and initializes `TestAppServer`, sends a remove request for `debug`, waits for the matching response, decodes `MarketplaceRemoveResponse`, and asserts the marketplace name and removed root. It then reads `config.toml` to ensure the marketplace section is absent and checks the install directory no longer exists.

**Call relations**: This test is the positive-path consumer of all local helpers in the file. It seeds state, drives the RPC through the test harness, uses `to_response` for decoding, and relies on `canonicalize_path_with_existing_parent` because the returned path refers to a deleted location.

*Call graph*: calls 4 internal fn (new, configured_marketplace_update, write_installed_marketplace, marketplace_install_root); 8 external calls (new, Integer, to_response, assert!, assert_eq!, record_user_marketplace, read_to_string, timeout).


##### `marketplace_remove_rejects_unknown_marketplace`  (lines 91–115)

```
async fn marketplace_remove_rejects_unknown_marketplace() -> Result<()>
```

**Purpose**: Confirms the server rejects `marketplace/remove` when the named marketplace is neither configured nor installed.

**Data flow**: It starts from an empty temporary Codex home, initializes `TestAppServer`, sends a remove request for `debug`, waits for the error message associated with that request id, and asserts the JSON-RPC error code is `-32600` and the message exactly states that `debug` is not configured or installed.

**Call relations**: This is the negative-path counterpart to the successful removal test. It bypasses all seeding helpers and exercises the server’s validation branch directly through the same request/response harness.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, Integer, assert_eq!, timeout).


### `app-server/tests/suite/v2/marketplace_upgrade.rs`

`test` · `request handling`

This file assembles realistic Git-backed marketplace fixtures and then drives the app server’s upgrade endpoint. `run_git` is the low-level shell helper: it executes `git` in a given directory, returning trimmed stdout or bailing with stderr on failure. `write_marketplace_files`, `init_marketplace_repo`, and `commit_marketplace_marker` build tiny repositories whose `marker.txt` content changes across commits, letting tests prove which revision was installed. Two config constructors produce `MarketplaceConfigUpdate` values for Git and local sources; `record_git_marketplace` persists Git marketplace entries into user config with a chosen `last_revision` and optional `ref_name`. `disable_plugin_startup_tasks` appends `[features]
plugins = false` to `config.toml` so plugin startup side effects do not interfere with upgrade assertions. The tests then start `TestAppServer`, call a shared async helper `send_marketplace_upgrade`, and inspect `MarketplaceUpgradeResponse`. Positive cases verify selected marketplace names, upgraded roots, marker file contents, and config updates containing new revisions. The named-upgrade test additionally proves untouched marketplaces are not installed. The already-up-to-date test performs two upgrades in sequence and expects the second response to contain an empty `upgraded_roots` list. The negative test seeds a local marketplace and checks that both unknown and non-Git marketplaces are rejected with the same `-32600` validation code and a message specifically requiring a Git marketplace.

#### Function details

##### `run_git`  (lines 26–37)

```
fn run_git(cwd: &Path, args: &[&str]) -> Result<String>
```

**Purpose**: Runs a Git command in a temporary repository and returns its stdout, failing the test with detailed stderr if the command exits unsuccessfully.

**Data flow**: It takes a working directory and argument slice, spawns `git` with `Command::new("git")`, captures output, checks `status.success()`, and either returns trimmed UTF-8-decoded stdout as `String` or bails with a message containing the command, cwd, and stderr.

**Call relations**: Repository-building helpers call it for `init`, `config`, `add`, `commit`, and `rev-parse`. It centralizes subprocess execution so higher-level helpers can focus on repository state transitions.

*Call graph*: called by 2 (commit_marketplace_marker, init_marketplace_repo); 3 external calls (from_utf8_lossy, bail!, new).


##### `write_marketplace_files`  (lines 39–47)

```
fn write_marketplace_files(root: &Path, marketplace_name: &str, marker: &str) -> Result<()>
```

**Purpose**: Creates the minimal marketplace manifest and marker file inside a repository working tree.

**Data flow**: Given a root path, marketplace name, and marker text, it creates `.agents/plugins`, writes `marketplace.json` containing the marketplace name and empty plugin list, writes `marker.txt` with the supplied marker, and returns `Result<()>`.

**Call relations**: It is used only during repository initialization by `init_marketplace_repo`, separating file layout creation from Git commit orchestration.

*Call graph*: called by 1 (init_marketplace_repo); 4 external calls (join, format!, create_dir_all, write).


##### `init_marketplace_repo`  (lines 49–57)

```
fn init_marketplace_repo(root: &Path, marketplace_name: &str, marker: &str) -> Result<String>
```

**Purpose**: Initializes a temporary Git repository containing a valid marketplace and returns the initial commit hash.

**Data flow**: It accepts a repository root, marketplace name, and initial marker text; runs `git init`, configures test user identity, writes marketplace files, stages all files, commits them, and returns `git rev-parse HEAD` as the initial revision string.

**Call relations**: The upgrade tests call it to create source repositories before recording marketplace config. It delegates command execution to `run_git` and file creation to `write_marketplace_files`.

*Call graph*: calls 2 internal fn (run_git, write_marketplace_files); called by 3 (marketplace_upgrade_all_configured_git_marketplaces, marketplace_upgrade_named_marketplace_only, marketplace_upgrade_returns_empty_roots_when_already_up_to_date).


##### `commit_marketplace_marker`  (lines 59–64)

```
fn commit_marketplace_marker(root: &Path, marker: &str) -> Result<String>
```

**Purpose**: Updates only the repository marker file, commits the change, and returns the new commit hash.

**Data flow**: It writes a new `marker.txt` value under the repository root, stages that file, commits with a fixed message, and returns the new `HEAD` revision string.

**Call relations**: Tests use it after `init_marketplace_repo` to create a newer revision that `marketplace/upgrade` should fetch or detect. It relies on `run_git` for all Git operations.

*Call graph*: calls 1 internal fn (run_git); called by 3 (marketplace_upgrade_all_configured_git_marketplaces, marketplace_upgrade_named_marketplace_only, marketplace_upgrade_returns_empty_roots_when_already_up_to_date); 2 external calls (join, write).


##### `configured_git_marketplace_update`  (lines 66–79)

```
fn configured_git_marketplace_update(
    source: &'a str,
    last_revision: Option<&'a str>,
    ref_name: Option<&'a str>,
) -> MarketplaceConfigUpdate<'a>
```

**Purpose**: Constructs a `MarketplaceConfigUpdate` describing a Git marketplace with caller-supplied source, revision, and ref.

**Data flow**: It takes `source`, `last_revision`, and `ref_name` string references and returns a `MarketplaceConfigUpdate` with fixed timestamp, `source_type: "git"`, the provided source/ref/revision values, and no sparse paths.

**Call relations**: It is a pure helper used by `record_git_marketplace` so tests can seed config entries without repeating field literals.

*Call graph*: called by 1 (record_git_marketplace).


##### `configured_local_marketplace_update`  (lines 81–90)

```
fn configured_local_marketplace_update(source: &str) -> MarketplaceConfigUpdate<'_>
```

**Purpose**: Constructs a `MarketplaceConfigUpdate` for a local-source marketplace used in negative upgrade testing.

**Data flow**: It takes a source path string and returns a config update with fixed timestamp, `source_type: "local"`, no revision, no ref, and empty sparse paths.

**Call relations**: Only `marketplace_upgrade_rejects_unknown_or_non_git_marketplace` uses it to seed a marketplace that should be rejected by the upgrade endpoint.

*Call graph*: called by 1 (marketplace_upgrade_rejects_unknown_or_non_git_marketplace).


##### `record_git_marketplace`  (lines 92–106)

```
fn record_git_marketplace(
    codex_home: &Path,
    marketplace_name: &str,
    source: &Path,
    last_revision: &str,
    ref_name: Option<&str>,
) -> Result<()>
```

**Purpose**: Persists a Git marketplace entry into the user config for a given Codex home.

**Data flow**: It receives `codex_home`, marketplace name, source path, last revision, and optional ref name; converts the source path to a display string, builds a `MarketplaceConfigUpdate` via `configured_git_marketplace_update`, writes it with `record_user_marketplace`, and returns `Result<()>`.

**Call relations**: The positive upgrade tests call it to seed configured marketplaces before server startup. It bridges temporary filesystem paths into the config format expected by the production config writer.

*Call graph*: calls 1 internal fn (configured_git_marketplace_update); called by 3 (marketplace_upgrade_all_configured_git_marketplaces, marketplace_upgrade_named_marketplace_only, marketplace_upgrade_returns_empty_roots_when_already_up_to_date); 2 external calls (display, record_user_marketplace).


##### `disable_plugin_startup_tasks`  (lines 108–116)

```
fn disable_plugin_startup_tasks(codex_home: &Path) -> Result<()>
```

**Purpose**: Appends a feature flag to disable plugin startup work in the generated test config.

**Data flow**: It reads `config.toml` from `codex_home`, appends a `[features]` section setting `plugins = false`, writes the modified file back, and returns `Result<()>`.

**Call relations**: Positive upgrade tests invoke it after writing marketplace config and before starting the server, ensuring upgrade assertions are not affected by plugin initialization side effects.

*Call graph*: called by 3 (marketplace_upgrade_all_configured_git_marketplaces, marketplace_upgrade_named_marketplace_only, marketplace_upgrade_returns_empty_roots_when_already_up_to_date); 4 external calls (join, format!, read_to_string, write).


##### `marketplace_install_root`  (lines 118–120)

```
fn marketplace_install_root(codex_home: &Path) -> std::path::PathBuf
```

**Purpose**: Computes the test file’s expected installed-marketplaces directory under a Codex home.

**Data flow**: It takes `codex_home` and returns `codex_home.join(INSTALLED_MARKETPLACES_DIR)` as a `PathBuf`.

**Call relations**: This local helper is used by `expected_installed_root` and directly in assertions that check whether a marketplace directory exists or remains absent.

*Call graph*: called by 1 (expected_installed_root); 1 external calls (join).


##### `expected_installed_root`  (lines 122–127)

```
fn expected_installed_root(codex_home: &Path, marketplace_name: &str) -> Result<AbsolutePathBuf>
```

**Purpose**: Builds the absolute installed root path expected for a named marketplace after upgrade.

**Data flow**: It canonicalizes `codex_home`, appends the installed-marketplaces directory and marketplace name, converts the resulting absolute path into `AbsolutePathBuf` with `try_from`, and adds context if conversion somehow fails.

**Call relations**: Positive tests call it before issuing upgrades so they can compare exact `MarketplaceUpgradeResponse.upgraded_roots` values against deterministic absolute paths.

*Call graph*: calls 2 internal fn (marketplace_install_root, try_from); called by 2 (marketplace_upgrade_all_configured_git_marketplaces, marketplace_upgrade_named_marketplace_only); 1 external calls (canonicalize).


##### `send_marketplace_upgrade`  (lines 129–145)

```
async fn send_marketplace_upgrade(
    mcp: &mut TestAppServer,
    marketplace_name: Option<&str>,
) -> Result<MarketplaceUpgradeResponse>
```

**Purpose**: Submits a `marketplace/upgrade` request through `TestAppServer` and decodes the typed response.

**Data flow**: It takes a mutable `TestAppServer` and an optional marketplace name, sends `MarketplaceUpgradeParams` with that optional name, waits under `DEFAULT_TIMEOUT` for the response matching the returned integer request id, and converts the `JSONRPCResponse` into `MarketplaceUpgradeResponse`.

**Call relations**: All positive upgrade tests use this helper to avoid duplicating request/response plumbing. It sits between test setup and final assertions, delegating transport details to the test harness and decoding to `to_response`.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_marketplace_upgrade_request); called by 3 (marketplace_upgrade_all_configured_git_marketplaces, marketplace_upgrade_named_marketplace_only, marketplace_upgrade_returns_empty_roots_when_already_up_to_date); 3 external calls (Integer, to_response, timeout).


##### `marketplace_upgrade_all_configured_git_marketplaces`  (lines 148–199)

```
async fn marketplace_upgrade_all_configured_git_marketplaces() -> Result<()>
```

**Purpose**: Verifies that an unnamed upgrade request upgrades every configured Git marketplace and records the new revisions.

**Data flow**: It creates temporary Codex home and two Git source repos, captures old and new revisions for `debug` and `tools`, records both marketplaces in config with old revisions and refs pointing at the new revisions, disables plugin startup tasks, starts the server, computes expected installed roots, sends an upgrade request with `marketplace_name: None`, and asserts the response lists both marketplaces and both roots with no errors. It then reads each installed `marker.txt` and `config.toml` to confirm the new content and revisions were persisted.

**Call relations**: This is the broadest positive-path test in the file. It composes nearly every helper: repository creation, config seeding, startup suppression, expected-path computation, and the shared upgrade request helper.

*Call graph*: calls 7 internal fn (new, commit_marketplace_marker, disable_plugin_startup_tasks, expected_installed_root, init_marketplace_repo, record_git_marketplace, send_marketplace_upgrade); 5 external calls (new, assert!, assert_eq!, read_to_string, timeout).


##### `marketplace_upgrade_named_marketplace_only`  (lines 202–250)

```
async fn marketplace_upgrade_named_marketplace_only() -> Result<()>
```

**Purpose**: Checks that specifying a marketplace name upgrades only that marketplace and leaves other configured Git marketplaces untouched.

**Data flow**: It creates two Git repos and records both with old revisions, advances both repos with new commits, disables plugin startup tasks, starts the server, computes the expected installed root for `tools`, sends an upgrade request naming `tools`, and asserts the response contains only `tools` in `selected_marketplaces` and only its root in `upgraded_roots`. It then verifies `tools` has the new marker content and `debug` has not been installed at all.

**Call relations**: This test follows the same setup pattern as the all-marketplaces case but exercises the branch where the request targets a single configured marketplace.

*Call graph*: calls 7 internal fn (new, commit_marketplace_marker, disable_plugin_startup_tasks, expected_installed_root, init_marketplace_repo, record_git_marketplace, send_marketplace_upgrade); 4 external calls (new, assert!, assert_eq!, timeout).


##### `marketplace_upgrade_returns_empty_roots_when_already_up_to_date`  (lines 253–283)

```
async fn marketplace_upgrade_returns_empty_roots_when_already_up_to_date() -> Result<()>
```

**Purpose**: Ensures a second upgrade of the same Git marketplace becomes a no-op and reports no upgraded roots.

**Data flow**: It creates one Git repo, records the marketplace with an old revision, advances the repo, disables plugin startup tasks, starts the server, performs one named upgrade and asserts it has no errors, then performs a second named upgrade and asserts the response still selects `debug` but returns empty `upgraded_roots` and no errors.

**Call relations**: This test depends on `send_marketplace_upgrade` twice in sequence to prove stateful behavior across requests: the first call updates config/install state, and the second observes that the marketplace is already current.

*Call graph*: calls 6 internal fn (new, commit_marketplace_marker, disable_plugin_startup_tasks, init_marketplace_repo, record_git_marketplace, send_marketplace_upgrade); 4 external calls (new, assert!, assert_eq!, timeout).


##### `marketplace_upgrade_rejects_unknown_or_non_git_marketplace`  (lines 286–318)

```
async fn marketplace_upgrade_rejects_unknown_or_non_git_marketplace() -> Result<()>
```

**Purpose**: Confirms the endpoint rejects both missing marketplaces and configured marketplaces whose source type is not Git.

**Data flow**: It creates a temporary Codex home and local source directory, records a `local-only` marketplace using `configured_local_marketplace_update`, starts the server, then loops over `missing` and `local-only`, sending a named upgrade request for each and asserting the resulting JSON-RPC error has code `-32600` and a message stating the marketplace is not configured as a Git marketplace.

**Call relations**: This is the negative-path test for upgrade validation. It bypasses the shared `send_marketplace_upgrade` helper because it expects error messages rather than typed success responses.

*Call graph*: calls 2 internal fn (new, configured_local_marketplace_update); 5 external calls (new, Integer, assert_eq!, record_user_marketplace, timeout).


### App, hook, and skill discovery
These tests focus on listing higher-level extensibility surfaces exposed by the app server, including apps, hooks, and skills from local, plugin, and MCP-backed sources.

### `app-server/tests/suite/v2/app_list.rs`

`test` · `connector discovery and incremental app-list updates in integration tests`

This file is both a substantial integration suite and a self-contained fake backend for app-list behavior. The tests drive `apps/list` requests through `TestAppServer` under different auth and feature configurations: connectors disabled globally, API-key auth, workspace plugin settings disabled, plugin fixtures enabled, thread-specific feature flags, app-only tool visibility, per-app `enabled` overrides, pagination, and force-refetch semantics. Several tests assert not just final responses but the sequence of `app/list/updated` notifications emitted while the server merges two asynchronous data sources: accessible apps inferred from MCP tools and directory metadata fetched over HTTP.

To support those scenarios, the file defines `AppsServerState` for expected bearer/account headers and mutable directory JSON, `AppListMcpServer` implementing `rmcp::handler::server::ServerHandler` to serve `list_tools`, and `AppsServerControl` to mutate connectors and tools mid-test. `start_apps_server_with_delays_and_control_inner` binds a random localhost port, mounts Axum routes for `/connectors/directory/list`, `/connectors/directory/list_workspace`, and `/accounts/account-123/settings`, nests a streamable HTTP MCP service under `/api/codex/ps/mcp`, and returns both the base URL and a task handle. The HTTP handlers enforce authorization headers and `external_logos=true`, optionally sleep to simulate slow directory or tool loading, and return either JSON or HTTP errors.

The tests capture subtle invariants: directory-only updates must not be emitted before accessible-tool data is available; empty interim updates are suppressed; force-refetch failures preserve the previous cache; and force-refetch patching starts from cached snapshots so users do not see regressions to inaccessible-only intermediate states.

#### Function details

##### `list_apps_returns_empty_when_connectors_disabled`  (lines 64–90)

```
async fn list_apps_returns_empty_when_connectors_disabled() -> Result<()>
```

**Purpose**: Verifies that `apps/list` returns no apps when the connectors feature is not enabled in config. The server should respond successfully with an empty page.

**Data flow**: Creates a temp codex home with no connector config, starts and initializes `TestAppServer`, sends `AppsListParams { limit: Some(50), cursor: None, thread_id: None, force_refetch: false }`, reads the JSON-RPC response, deserializes `AppsListResponse`, and asserts `data.is_empty()` and `next_cursor.is_none()`.

**Call relations**: This is the baseline negative test for feature gating and does not involve the fake apps backend.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, Integer, to_response, assert!, timeout).


##### `list_apps_returns_empty_with_api_key_auth`  (lines 93–155)

```
async fn list_apps_returns_empty_with_api_key_auth() -> Result<()>
```

**Purpose**: Checks that connector apps are not exposed when the user is authenticated with an API key rather than ChatGPT auth, even if the backend advertises connectors and tools.

**Data flow**: Starts the fake apps server with one connector and one MCP tool, writes connector config pointing at that server, persists `AuthDotJson` with `AuthMode::ApiKey`, starts and initializes the app server, sends `apps/list`, deserializes the response, asserts empty `data` and no cursor, then aborts and awaits the fake server task.

**Call relations**: This test proves auth mode gates connector visibility independently of backend availability.

*Call graph*: calls 4 internal fn (new, start_apps_server_with_delays, write_connectors_config, default); 7 external calls (new, Integer, to_response, assert!, save_auth, timeout, vec!).


##### `list_apps_returns_empty_when_workspace_codex_plugins_disabled`  (lines 158–217)

```
async fn list_apps_returns_empty_when_workspace_codex_plugins_disabled() -> Result<()>
```

**Purpose**: Verifies that even with ChatGPT auth and connector config, app listing is empty when workspace settings report plugins disabled.

**Data flow**: Starts the fake apps server configured with `workspace_plugins_enabled = false`, writes connector config, writes ChatGPT auth fixture, starts the app server without managed config, sends `apps/list`, asserts the response contains no apps and no cursor, then shuts down the fake server.

**Call relations**: This test exercises the `/accounts/account-123/settings` route in the fake backend and documents workspace-level gating.

*Call graph*: calls 4 internal fn (new, new_without_managed_config, start_apps_server_with_workspace_plugins_enabled, write_connectors_config); 7 external calls (new, Integer, to_response, write_chatgpt_auth, assert!, timeout, vec!).


##### `list_apps_includes_plugin_apps_for_chatgpt_auth`  (lines 220–261)

```
async fn list_apps_includes_plugin_apps_for_chatgpt_auth() -> Result<()>
```

**Purpose**: Checks that locally cached plugin app metadata is included in `apps/list` for ChatGPT-authenticated users when plugins are enabled.

**Data flow**: Starts an otherwise empty fake apps server, writes config enabling both connectors and plugins, writes a plugin fixture under `plugins/cache/test/<plugin>/local` with `.codex-plugin/plugin.json` and `.app.json`, writes ChatGPT auth, starts and initializes the app server, sends `apps/list`, deserializes the response, and asserts some returned app has id `connector_sample` and there is no next cursor; then stops the fake server.

**Call relations**: This test covers plugin-app inclusion from local cache rather than remote connector directory or MCP tool discovery.

*Call graph*: calls 5 internal fn (new, new, start_apps_server_with_delays, write_connectors_and_plugins_config, write_plugin_app_fixture); 7 external calls (new, new, Integer, to_response, write_chatgpt_auth, assert!, timeout).


##### `list_apps_uses_thread_feature_flag_when_thread_id_is_provided`  (lines 264–364)

```
async fn list_apps_uses_thread_feature_flag_when_thread_id_is_provided() -> Result<()>
```

**Purpose**: Verifies that `apps/list` can use thread-scoped feature flags when a `thread_id` is supplied, even if the global config has since disabled connectors.

**Data flow**: Starts a fake apps server with one connector/tool, writes connector config and ChatGPT auth, starts and initializes the app server, creates a thread via `thread/start`, then overwrites `config.toml` to disable connectors globally, sends one `apps/list` request without `thread_id` and asserts it is empty, sends another with `thread_id: Some(thread.id)` and asserts the returned data includes app `beta`, then shuts down the fake server.

**Call relations**: This test ties app-list behavior to thread lifecycle by first creating a thread under one config snapshot and then changing global config before querying.

*Call graph*: calls 4 internal fn (new, new, start_apps_server_with_delays, write_connectors_config); 10 external calls (new, Integer, default, to_response, write_chatgpt_auth, assert!, format!, write, timeout, vec!).


##### `list_apps_keeps_apps_with_app_only_tools_accessible`  (lines 367–431)

```
async fn list_apps_keeps_apps_with_app_only_tools_accessible() -> Result<()>
```

**Purpose**: Checks that apps remain marked accessible even when their MCP tools are visible only in app UI contexts. Tool visibility metadata should not cause the app itself to disappear.

**Data flow**: Builds a connector tool for `beta`, mutates its `meta` to include `ui.visibility = ["app"]`, starts the fake apps server with that tool and one connector, writes connector config and ChatGPT auth, starts and initializes the app server, sends `apps/list(force_refetch = true)`, deserializes the response, and asserts there is exactly one app `beta`, `is_accessible` is true, and no cursor remains; then stops the fake server.

**Call relations**: This test depends on `connector_tool` to create the base MCP tool and then customizes metadata inline to hit the app-only visibility edge case.

*Call graph*: calls 5 internal fn (new, new, connector_tool, start_apps_server_with_delays, write_connectors_config); 9 external calls (new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, json!, timeout, vec!).


##### `list_apps_reports_is_enabled_from_config`  (lines 434–507)

```
async fn list_apps_reports_is_enabled_from_config() -> Result<()>
```

**Purpose**: Verifies that per-app config overrides are reflected in the returned `is_enabled` field even when the backend reports the app as enabled.

**Data flow**: Starts a fake apps server with connector `beta`, writes a custom `config.toml` enabling connectors but setting `[apps.beta] enabled = false`, writes ChatGPT auth, starts and initializes the app server, sends `apps/list`, deserializes the response, and asserts there is one app `beta` with `is_enabled == false` and no next cursor; then stops the fake server.

**Call relations**: This test isolates config overlay behavior on top of backend-provided app metadata.

*Call graph*: calls 3 internal fn (new, new, start_apps_server_with_delays); 10 external calls (new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, format!, write, timeout, vec!).


##### `list_apps_emits_updates_and_returns_after_both_lists_load`  (lines 510–680)

```
async fn list_apps_emits_updates_and_returns_after_both_lists_load() -> Result<()>
```

**Purpose**: Checks the incremental merge behavior when accessible-tool data arrives before slower directory metadata. The server should emit an accessible-only update first, then a merged update, and only then complete the RPC response.

**Data flow**: Defines rich `alpha` directory metadata and a `beta` MCP tool, starts the fake apps server with a 300 ms directory delay and no tools delay, writes connector config and ChatGPT auth, starts and initializes the app server, sends `apps/list`, reads the first `app/list/updated` notification and asserts it contains only accessible `beta`, reads the second update and asserts it contains merged `beta` plus `alpha` with install URLs and metadata, then reads the final response and asserts it matches the merged list with no cursor; finally stops the fake server.

**Call relations**: This test relies on `read_app_list_updated_notification` to observe the notification stream and documents the intended ordering between interim updates and final response.

*Call graph*: calls 5 internal fn (new, new, read_app_list_updated_notification, start_apps_server_with_delays, write_connectors_config); 10 external calls (from_millis, from, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, timeout, vec!).


##### `list_apps_waits_for_accessible_data_before_emitting_directory_updates`  (lines 683–805)

```
async fn list_apps_waits_for_accessible_data_before_emitting_directory_updates() -> Result<()>
```

**Purpose**: Verifies that if directory metadata arrives before accessible-tool data, the server suppresses directory-only interim updates until accessible data is available. Users should not see a transient inaccessible-only list.

**Data flow**: Starts the fake apps server with immediate directory responses and a 300 ms tools delay, writes connector config and ChatGPT auth, starts and initializes the app server, sends `apps/list`, then loops reading `app/list/updated` notifications until one equals the expected merged list; any earlier update is asserted to be non-empty and entirely accessible-only. Finally it reads the response and asserts it equals the merged expected list with no cursor.

**Call relations**: This test complements the previous one by reversing source timing and asserting the server's suppression rule for premature directory-only updates.

*Call graph*: calls 5 internal fn (new, new, read_app_list_updated_notification, start_apps_server_with_delays, write_connectors_config); 9 external calls (from_millis, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, timeout, vec!).


##### `list_apps_does_not_emit_empty_interim_updates`  (lines 808–895)

```
async fn list_apps_does_not_emit_empty_interim_updates() -> Result<()>
```

**Purpose**: Checks that the server does not emit an empty `app/list/updated` notification while waiting for delayed directory data. The first visible update should already contain meaningful app data.

**Data flow**: Starts the fake apps server with one directory connector, no tools, and a 300 ms directory delay, writes connector config and ChatGPT auth, starts and initializes the app server, sends `apps/list`, waits only 150 ms for an update and asserts timeout, then reads the eventual update and asserts it contains the expected `alpha` app with install URL, reads the final response, and asserts it matches the same list with no cursor; then stops the fake server.

**Call relations**: This test uses `read_app_list_updated_notification` under a short timeout to prove the absence of empty interim notifications.

*Call graph*: calls 5 internal fn (new, new, read_app_list_updated_notification, start_apps_server_with_delays, write_connectors_config); 10 external calls (from_millis, new, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, timeout, vec!).


##### `list_apps_paginates_results`  (lines 898–1038)

```
async fn list_apps_paginates_results() -> Result<()>
```

**Purpose**: Verifies pagination over the merged app list. It checks that the first page returns one app plus a cursor and the second page returns the remainder.

**Data flow**: Starts the fake apps server with directory connectors `alpha` and `beta` plus a `beta` MCP tool and delayed tools, writes connector config and ChatGPT auth, starts and initializes the app server, sends `apps/list(limit = Some(1), cursor = None)`, asserts the first page contains only accessible `beta` and captures `next_cursor`, waits until an update shows both apps loaded, then sends `apps/list(limit = Some(1), cursor = Some(next_cursor))` and asserts the second page contains only `alpha` with no further cursor; finally stops the fake server.

**Call relations**: This test combines pagination with asynchronous loading, ensuring cursors operate on the stabilized merged list rather than a transient partial snapshot.

*Call graph*: calls 5 internal fn (new, new, read_app_list_updated_notification, start_apps_server_with_delays, write_connectors_config); 9 external calls (from_millis, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, timeout, vec!).


##### `list_apps_force_refetch_preserves_previous_cache_on_failure`  (lines 1041–1142)

```
async fn list_apps_force_refetch_preserves_previous_cache_on_failure() -> Result<()>
```

**Purpose**: Checks that a failed force-refetch does not destroy the previously cached app list. Subsequent non-refetch reads should still return the last good snapshot.

**Data flow**: Starts the fake apps server with one accessible connector/tool, writes connector config and valid ChatGPT auth, starts and initializes the app server, performs an initial `apps/list(force_refetch = false)` and stores the returned data, overwrites auth with an invalid token, sends `apps/list(force_refetch = true)` and asserts the JSON-RPC error message contains `failed to`, then sends another cached `apps/list(force_refetch = false)` and asserts the returned data equals the original cached snapshot with no cursor; then stops the fake server.

**Call relations**: This test documents cache retention semantics across refetch failures, rather than notification ordering.

*Call graph*: calls 4 internal fn (new, new, start_apps_server_with_delays, write_connectors_config); 8 external calls (new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, timeout, vec!).


##### `list_apps_force_refetch_patches_updates_from_cached_snapshots`  (lines 1145–1383)

```
async fn list_apps_force_refetch_patches_updates_from_cached_snapshots() -> Result<()>
```

**Purpose**: Verifies that force-refetch incremental updates are patched against the previous cached snapshot, avoiding regressions to inaccessible-only or partially erased states while fresh data is loading.

**Data flow**: Starts the fake apps server with controllable initial connectors/tools and a delayed directory, writes connector config and ChatGPT auth, warms the cache by issuing `apps/list` and asserting the first accessible-only update, second merged update, and final response. It then mutates backend state through `AppsServerControl` to remove tools and change `alpha` description to `v2`, sends `apps/list(force_refetch = true)`, asserts the first update repeats the cached merged snapshot, asserts no second inaccessible-only update arrives within 150 ms, then reads the final update and response and asserts both equal the new single-app `alpha v2` snapshot.

**Call relations**: This is the most detailed cache/refetch test and depends on `start_apps_server_with_delays_and_control`, `AppsServerControl::set_connectors`, `AppsServerControl::set_tools`, and `read_app_list_updated_notification`.

*Call graph*: calls 5 internal fn (new, new, read_app_list_updated_notification, start_apps_server_with_delays_and_control, write_connectors_config); 10 external calls (from_millis, new, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, timeout, vec!).


##### `read_app_list_updated_notification`  (lines 1385–1398)

```
async fn read_app_list_updated_notification(
    mcp: &mut TestAppServer,
) -> Result<AppListUpdatedNotification>
```

**Purpose**: Reads the next `app/list/updated` notification and converts it into the typed payload. It fails if the notification variant is not `AppListUpdated`.

**Data flow**: Takes mutable `TestAppServer` → waits under `DEFAULT_TIMEOUT` for `read_stream_until_notification_message("app/list/updated")`, converts the raw notification into `ServerNotification`, pattern-matches `ServerNotification::AppListUpdated(payload)`, and returns the `AppListUpdatedNotification` payload.

**Call relations**: Shared by all tests that assert incremental app-list updates, insulating them from raw JSON-RPC notification parsing.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 5 (list_apps_does_not_emit_empty_interim_updates, list_apps_emits_updates_and_returns_after_both_lists_load, list_apps_force_refetch_patches_updates_from_cached_snapshots, list_apps_paginates_results, list_apps_waits_for_accessible_data_before_emitting_directory_updates); 2 external calls (bail!, timeout).


##### `AppListMcpServer::new`  (lines 1416–1418)

```
fn new(tools: Arc<StdMutex<Vec<Tool>>>, tools_delay: Duration) -> Self
```

**Purpose**: Constructs the fake MCP server used to advertise connector tools. It stores shared tool state and an optional artificial delay.

**Data flow**: Accepts `Arc<StdMutex<Vec<Tool>>>` and a `Duration` → returns `AppListMcpServer { tools, tools_delay }` without side effects.

**Call relations**: Called from the fake backend startup path when building the `StreamableHttpService` factory.


##### `AppsServerControl::set_connectors`  (lines 1428–1434)

```
fn set_connectors(&self, connectors: Vec<AppInfo>)
```

**Purpose**: Replaces the fake directory response payload with a new connector list. This lets tests mutate backend directory state between requests.

**Data flow**: Locks the shared `response` mutex, recovering from poisoning if necessary, and overwrites the stored JSON with `json!({ "apps": connectors, "next_token": null })` → returns unit after mutating shared backend state.

**Call relations**: Used by the force-refetch patching test to simulate directory changes after the cache has been warmed.

*Call graph*: 1 external calls (json!).


##### `AppsServerControl::set_tools`  (lines 1436–1442)

```
fn set_tools(&self, tools: Vec<Tool>)
```

**Purpose**: Replaces the fake MCP tool list served by the backend. Tests use it to simulate accessible-app changes independently of directory metadata.

**Data flow**: Locks the shared `tools` mutex, recovering from poisoning if necessary, and assigns the provided `Vec<Tool>` into it → returns unit after mutating shared state.

**Call relations**: Used alongside `set_connectors` in the force-refetch patching test to remove previously accessible tools.


##### `AppListMcpServer::get_info`  (lines 1446–1448)

```
fn get_info(&self) -> ServerInfo
```

**Purpose**: Reports MCP server capabilities for the fake tool server. It advertises only tool support.

**Data flow**: Builds `ServerCapabilities` with tools enabled and wraps it in `ServerInfo::new(...)` → returns the resulting `ServerInfo` without touching shared state.

**Call relations**: Called by the RMCP framework when clients connect to the fake MCP service.

*Call graph*: 2 external calls (builder, new).


##### `AppListMcpServer::list_tools`  (lines 1450–1472)

```
fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> impl std::future::Futu
```

**Purpose**: Implements the fake MCP `list_tools` method, optionally delaying before returning the current shared tool list. This simulates slow accessible-app discovery.

**Data flow**: Captures cloned `tools` state and `tools_delay`, asynchronously sleeps if the delay is nonzero, locks and clones the current `Vec<Tool>`, and returns `ListToolsResult { tools, next_cursor: None, meta: None }`.

**Call relations**: Invoked by the app server when it queries the nested MCP backend for accessible connector tools; timing-sensitive tests manipulate `tools_delay` to control update ordering.

*Call graph*: 1 external calls (sleep).


##### `start_apps_server_with_delays`  (lines 1475–1485)

```
async fn start_apps_server_with_delays(
    connectors: Vec<AppInfo>,
    tools: Vec<Tool>,
    directory_delay: Duration,
    tools_delay: Duration,
) -> Result<(String, JoinHandle<()>)>
```

**Purpose**: Starts the fake apps backend with configurable directory and tool delays, returning only the base URL and task handle. It is the common convenience wrapper for most tests.

**Data flow**: Accepts connector list, tool list, `directory_delay`, and `tools_delay` → delegates to `start_apps_server_with_delays_and_control`, discards the returned control handle, and returns `(server_url, server_handle)`.

**Call relations**: Most app-list tests call this helper when they do not need to mutate backend state after startup.

*Call graph*: calls 1 internal fn (start_apps_server_with_delays_and_control); called by 10 (list_apps_does_not_emit_empty_interim_updates, list_apps_emits_updates_and_returns_after_both_lists_load, list_apps_force_refetch_preserves_previous_cache_on_failure, list_apps_includes_plugin_apps_for_chatgpt_auth, list_apps_keeps_apps_with_app_only_tools_accessible, list_apps_paginates_results, list_apps_reports_is_enabled_from_config, list_apps_returns_empty_with_api_key_auth, list_apps_uses_thread_feature_flag_when_thread_id_is_provided, list_apps_waits_for_accessible_data_before_emitting_directory_updates).


##### `start_apps_server_with_workspace_plugins_enabled`  (lines 1487–1502)

```
async fn start_apps_server_with_workspace_plugins_enabled(
    connectors: Vec<AppInfo>,
    tools: Vec<Tool>,
    workspace_plugins_enabled: bool,
) -> Result<(String, JoinHandle<()>)>
```

**Purpose**: Starts the fake apps backend with an explicit workspace plugin-enabled flag while using zero delays. It supports tests for workspace settings gating.

**Data flow**: Accepts connectors, tools, and `workspace_plugins_enabled` → delegates to `start_apps_server_with_delays_and_control_inner` with zero delays and the supplied flag, discards the control handle, and returns `(server_url, server_handle)`.

**Call relations**: Used only by the test that verifies empty app lists when workspace Codex plugins are disabled.

*Call graph*: calls 1 internal fn (start_apps_server_with_delays_and_control_inner); called by 1 (list_apps_returns_empty_when_workspace_codex_plugins_disabled).


##### `start_apps_server_with_delays_and_control`  (lines 1504–1518)

```
async fn start_apps_server_with_delays_and_control(
    connectors: Vec<AppInfo>,
    tools: Vec<Tool>,
    directory_delay: Duration,
    tools_delay: Duration,
) -> Result<(String, JoinHandle<()>, A
```

**Purpose**: Starts the fake apps backend with delays and returns a mutable control handle in addition to URL and task handle. It defaults workspace plugins to enabled.

**Data flow**: Accepts connectors, tools, directory delay, and tools delay → delegates to `start_apps_server_with_delays_and_control_inner(..., workspace_plugins_enabled = true)` → returns `(server_url, server_handle, AppsServerControl)`.

**Call relations**: Called by `start_apps_server_with_delays` and directly by the force-refetch patching test that needs runtime backend mutation.

*Call graph*: calls 1 internal fn (start_apps_server_with_delays_and_control_inner); called by 2 (list_apps_force_refetch_patches_updates_from_cached_snapshots, start_apps_server_with_delays).


##### `start_apps_server_with_delays_and_control_inner`  (lines 1520–1574)

```
async fn start_apps_server_with_delays_and_control_inner(
    connectors: Vec<AppInfo>,
    tools: Vec<Tool>,
    directory_delay: Duration,
    tools_delay: Duration,
    workspace_plugins_enabled: b
```

**Purpose**: Builds and launches the full fake backend: Axum HTTP routes for connector directory and workspace settings plus a nested streamable HTTP MCP service for tools. It is the core test-server constructor.

**Data flow**: Takes initial connectors, tools, delays, and workspace-plugin flag → wraps directory JSON and tools in `Arc<StdMutex<...>>`, constructs `AppsServerState` with expected bearer/account headers, creates `AppsServerControl`, binds a random localhost `TcpListener`, builds a `StreamableHttpService` whose factory creates `AppListMcpServer`, assembles an Axum `Router` with routes for `/connectors/directory/list`, `/connectors/directory/list_workspace`, `/accounts/account-123/settings`, and nested `/api/codex/ps/mcp`, spawns `axum::serve(listener, router)` on a Tokio task, and returns the base URL, join handle, and control handle.

**Call relations**: All fake-backend startup helpers funnel through this function, and the HTTP handlers plus MCP server methods it wires together are what the app server talks to during app-list tests.

*Call graph*: called by 2 (start_apps_server_with_delays_and_control, start_apps_server_with_workspace_plugins_enabled); 12 external calls (new, default, new, new, default, new, bind, get, serve, format! (+2 more)).


##### `workspace_settings_response`  (lines 1576–1598)

```
async fn workspace_settings_response(
    State(state): State<Arc<AppsServerState>>,
    headers: HeaderMap,
) -> Result<impl axum::response::IntoResponse, StatusCode>
```

**Purpose**: Serves fake workspace settings, enforcing expected auth headers and returning whether plugins are enabled. Unauthorized requests receive HTTP 401.

**Data flow**: Reads shared `AppsServerState` plus request headers → checks `Authorization` equals the expected bearer token and `chatgpt-account-id` equals the expected account id; if either check fails returns `Err(StatusCode::UNAUTHORIZED)`, otherwise returns JSON `{ "beta_settings": { "enable_plugins": state.workspace_plugins_enabled } }`.

**Call relations**: Mounted by the fake backend and called by the app server when deciding whether workspace-level plugin support allows connector apps.

*Call graph*: 3 external calls (get, Json, json!).


##### `list_directory_connectors`  (lines 1600–1633)

```
async fn list_directory_connectors(
    State(state): State<Arc<AppsServerState>>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<impl axum::response::IntoResponse, StatusCode>
```

**Purpose**: Serves the fake connector directory endpoint with optional delay and strict header/query validation. It returns the current shared connector JSON or an HTTP error.

**Data flow**: Reads shared state, request headers, and URI → sleeps for `directory_delay` if nonzero, validates bearer token and `chatgpt-account-id` headers, checks the query string contains `external_logos=true`, and if validation passes clones the shared JSON response from the mutex and returns it as `Json`; otherwise returns `UNAUTHORIZED` or `BAD_REQUEST`.

**Call relations**: Mounted on both directory-list routes in the fake backend. Timing-sensitive tests manipulate `directory_delay`, and auth/query checks ensure the app server sends the expected request shape.

*Call graph*: 4 external calls (get, query, Json, sleep).


##### `connector_tool`  (lines 1635–1654)

```
fn connector_tool(connector_id: &str, connector_name: &str) -> Result<Tool>
```

**Purpose**: Constructs a minimal MCP `Tool` representing a connector app, including metadata linking the tool back to connector id and display name.

**Data flow**: Builds a JSON schema object `{ "type": "object", "additionalProperties": false }`, creates a `Tool` named `connector_<connector_id>` with description `Connector test tool`, marks it read-only via `ToolAnnotations`, creates `Meta`, inserts `connector_id` and `connector_name`, assigns that metadata to the tool, and returns `Result<Tool>`.

**Call relations**: Used by tests that need accessible apps inferred from MCP tools, and especially by the app-only visibility test which mutates the returned tool's metadata further.

*Call graph*: called by 1 (list_apps_keeps_apps_with_app_only_tools_accessible); 9 external calls (new, Borrowed, Owned, new, new, format!, json!, new, from_value).


##### `write_connectors_config`  (lines 1656–1670)

```
fn write_connectors_config(codex_home: &std::path::Path, base_url: &str) -> std::io::Result<()>
```

**Purpose**: Writes a minimal config enabling connectors against the fake backend base URL. It also selects file-based MCP OAuth credential storage.

**Data flow**: Takes codex-home path and backend `base_url` → writes `config.toml` containing `chatgpt_base_url`, `mcp_oauth_credentials_store = "file"`, and `[features] connectors = true` → returns `std::io::Result<()>`.

**Call relations**: Used by most connector-focused tests before starting the app server.

*Call graph*: called by 10 (list_apps_does_not_emit_empty_interim_updates, list_apps_emits_updates_and_returns_after_both_lists_load, list_apps_force_refetch_patches_updates_from_cached_snapshots, list_apps_force_refetch_preserves_previous_cache_on_failure, list_apps_keeps_apps_with_app_only_tools_accessible, list_apps_paginates_results, list_apps_returns_empty_when_workspace_codex_plugins_disabled, list_apps_returns_empty_with_api_key_auth, list_apps_uses_thread_feature_flag_when_thread_id_is_provided, list_apps_waits_for_accessible_data_before_emitting_directory_updates); 3 external calls (join, format!, write).


##### `write_connectors_and_plugins_config`  (lines 1672–1690)

```
fn write_connectors_and_plugins_config(codex_home: &Path, base_url: &str) -> std::io::Result<()>
```

**Purpose**: Writes config enabling both connectors and plugins, plus a specific plugin entry. It supports tests that merge plugin-app fixtures into app-list results.

**Data flow**: Takes codex-home path and backend base URL → writes `config.toml` containing `chatgpt_base_url`, file-based MCP OAuth credential storage, `[features] connectors = true`, `[features] plugins = true`, and `[plugins."sample@test"] enabled = true`.

**Call relations**: Called only by the plugin-app inclusion test.

*Call graph*: called by 1 (list_apps_includes_plugin_apps_for_chatgpt_auth); 3 external calls (join, format!, write).


##### `write_plugin_app_fixture`  (lines 1692–1712)

```
fn write_plugin_app_fixture(codex_home: &Path, plugin_name: &str, app_id: &str) -> Result<()>
```

**Purpose**: Creates an on-disk plugin fixture that maps a local plugin to an app id. This simulates cached plugin metadata consumed by app-list logic.

**Data flow**: Builds `plugins/cache/test/<plugin_name>/local`, creates `.codex-plugin` directory, writes `.codex-plugin/plugin.json` containing the plugin name, writes `.app.json` containing `{ "apps": { plugin_name: { "id": app_id } } }` as pretty JSON, and returns `Result<()>`.

**Call relations**: Used only by the plugin-app inclusion test to seed local plugin metadata before the app server starts.

*Call graph*: called by 1 (list_apps_includes_plugin_apps_for_chatgpt_auth); 6 external calls (join, format!, json!, to_vec_pretty, create_dir_all, write).


### `app-server/tests/suite/v2/hooks_list.rs`

`test` · `config inspection and live session updates`

This file validates the `hooks/list` API and the interaction between hook metadata, trust state, and live sessions. It includes small setup helpers that write user hook config, plugin hook config under the plugin cache layout, and project hook config under `.codex/config.toml`. `command_hook_hash` reconstructs the normalized TOML identity used by the server to compute a stable version hash for command hooks, allowing tests to assert exact `current_hash` values in returned `HookMetadata`.

The listing tests cover user hooks, plugin hooks, plugin hook parse warnings, per-cwd feature enablement, and linked-worktree behavior. They assert concrete metadata fields such as `key`, `event_name`, `handler_type`, matcher, command, timeout, source path, source kind, plugin ID, enabled flag, managed flag, computed hash, and initial `HookTrustStatus::Untrusted`. The linked-worktree test is especially specific: it creates a worktree whose `.git` points into the root repo's `.git/worktrees/...`, verifies both repo root and worktree resolve to the root repo's hook config, then writes `hooks.state` trust data and confirms the worktree view becomes `Trusted`.

The latter tests prove `config/batchWrite` updates are reflected both in subsequent `hooks/list` responses and in already loaded sessions. One test toggles a user hook off and back on. Two session-oriented tests create a real command hook script that appends JSON payloads to a log file, then show that untrusted hooks do not run, trusted hooks begin running without recreating the session, modified hooks revert to `Modified` and stop running, and disabling a trusted hook via `hooks.state` prevents further executions in the same loaded thread.

#### Function details

##### `command_hook_hash`  (lines 43–67)

```
fn command_hook_hash(
    event_name: &'static str,
    matcher: Option<&str>,
    command: &str,
    timeout_sec: u64,
    status_message: Option<&str>,
) -> String
```

**Purpose**: Recomputes the normalized version hash for a command hook so tests can assert the exact `current_hash` returned by the server.

**Data flow**: It accepts the event name, optional matcher, command string, timeout seconds, and optional status message, builds a `NormalizedHookIdentity` containing a `codex_config::MatcherGroup` with one `HookHandlerConfig::Command`, converts that structure into `codex_config::TomlValue`, and passes it to `codex_config::version_for_toml`. It returns the resulting hash string and panics only if serialization unexpectedly fails.

**Call relations**: The hook-list assertion tests call this helper when constructing expected `HookMetadata`, ensuring their expected hashes match the server's normalization logic.

*Call graph*: 4 external calls (try_from, version_for_toml, unreachable!, vec!).


##### `write_user_hook_config`  (lines 69–85)

```
fn write_user_hook_config(codex_home: &std::path::Path) -> Result<()>
```

**Purpose**: Writes a simple user-level hook configuration containing one `PreToolUse` command hook.

**Data flow**: It takes a Codex home path, writes `config.toml` under that directory with a `[hooks]` section defining one `PreToolUse` matcher `Bash` and one command hook `python3 /tmp/listed-hook.py` with timeout 5 and status message, and returns `Result<()>`.

**Call relations**: The user-hook listing and toggle tests call this helper during setup to create a stable hook definition on disk.

*Call graph*: called by 2 (config_batch_write_toggles_user_hook, hooks_list_shows_discovered_hook); 2 external calls (join, write).


##### `write_plugin_hook_config`  (lines 87–107)

```
fn write_plugin_hook_config(codex_home: &std::path::Path, hooks_json: &str) -> Result<()>
```

**Purpose**: Creates a cached local plugin layout with a plugin manifest, hooks JSON file, and user config enabling plugin and hooks features plus the plugin itself.

**Data flow**: It takes a Codex home path and raw hooks JSON string, creates `plugins/cache/test/demo/local/.codex-plugin` and `hooks` directories, writes `.codex-plugin/plugin.json`, writes `hooks/hooks.json` with the provided JSON, writes `config.toml` enabling `[features] plugins = true` and `hooks = true` plus `[plugins."demo@test"].enabled = true`, and returns `Result<()>`.

**Call relations**: Plugin-hook discovery, warning, and capability-warming tests all use this helper to establish the plugin cache structure expected by the server.

*Call graph*: called by 3 (hooks_list_shows_discovered_plugin_hook, hooks_list_shows_plugin_hook_load_warnings, hooks_list_warms_plugin_capabilities_for_thread_start); 3 external calls (join, create_dir_all, write).


##### `write_project_hook_config`  (lines 109–130)

```
fn write_project_hook_config(dot_codex_folder: &std::path::Path, command: &str) -> Result<()>
```

**Purpose**: Writes a project-local `.codex/config.toml` containing one `PreToolUse` command hook and hooks feature enablement.

**Data flow**: It takes the `.codex` directory path and a command string, creates the directory, formats a TOML file enabling `[features] hooks = true` and defining one `PreToolUse` command hook with the supplied command and timeout 5, writes it to `config.toml`, and returns `Result<()>`.

**Call relations**: The linked-worktree test uses this helper to create distinct root-repo and worktree hook configs so it can verify which one the server actually resolves.

*Call graph*: called by 1 (hooks_list_uses_root_repo_hooks_for_linked_worktrees); 4 external calls (join, format!, create_dir_all, write).


##### `hooks_list_shows_discovered_hook`  (lines 133–187)

```
async fn hooks_list_shows_discovered_hook() -> Result<()>
```

**Purpose**: Verifies that a user-configured hook is discovered and returned with complete metadata for an arbitrary cwd.

**Data flow**: It creates temp Codex home and cwd directories, writes user hook config, starts and initializes `TestAppServer`, sends `HooksListParams { cwds: vec![cwd] }`, deserializes `HooksListResponse`, canonicalizes the user `config.toml` into `AbsolutePathBuf`, constructs the expected `HooksListEntry` with one `HookMetadata` including computed key and `current_hash`, and asserts exact equality.

**Call relations**: This direct listing test uses `write_user_hook_config` for setup and `command_hook_hash` to build the expected metadata returned by `hooks/list`.

*Call graph*: calls 3 internal fn (new, write_user_hook_config, from_absolute_path); 7 external calls (new, Integer, to_response, assert_eq!, canonicalize, timeout, vec!).


##### `hooks_list_shows_discovered_plugin_hook`  (lines 190–265)

```
async fn hooks_list_shows_discovered_plugin_hook() -> Result<()>
```

**Purpose**: Checks that a plugin-provided hook is listed with plugin source metadata and the expected stable key format.

**Data flow**: It writes plugin hook config with valid JSON, starts and initializes the server, sends `hooks/list` for one cwd, deserializes the response, canonicalizes the plugin `hooks/hooks.json` path into `AbsolutePathBuf`, constructs the expected `HooksListEntry` containing one plugin-sourced `HookMetadata`, and asserts exact equality.

**Call relations**: The test harness invokes it directly. It depends on `write_plugin_hook_config` for setup and `command_hook_hash` for the expected `current_hash` field.

*Call graph*: calls 3 internal fn (new, write_plugin_hook_config, from_absolute_path); 7 external calls (new, Integer, to_response, assert_eq!, canonicalize, timeout, vec!).


##### `hooks_list_warms_plugin_capabilities_for_thread_start`  (lines 268–343)

```
async fn hooks_list_warms_plugin_capabilities_for_thread_start() -> Result<()>
```

**Purpose**: Verifies that listing hooks preloads plugin capabilities strongly enough that a later thread start still starts the plugin's MCP server even after the plugin `.mcp.json` file is removed.

**Data flow**: It writes plugin hook config, writes a plugin `.mcp.json` declaring `plugin-server`, starts and initializes the server, sends `hooks/list` and waits only for the response, deletes the `.mcp.json` file from disk, then sends `thread/start`, deserializes `ThreadStartResponse`, and waits for a matching `mcpServer/startupStatus/updated` notification whose params name is `plugin-server`.

**Call relations**: This test is driven by the harness and uses `write_plugin_hook_config` for setup. Its key relation is temporal: `hooks/list` must warm plugin capability state that `thread/start` later consumes.

*Call graph*: calls 2 internal fn (new, write_plugin_hook_config); 8 external calls (new, Integer, default, to_response, remove_file, write, timeout, vec!).


##### `hooks_list_shows_plugin_hook_load_warnings`  (lines 346–375)

```
async fn hooks_list_shows_plugin_hook_load_warnings() -> Result<()>
```

**Purpose**: Ensures malformed plugin hook JSON does not crash listing and instead surfaces a warning while returning no hooks.

**Data flow**: It writes plugin hook config with invalid JSON text `{ not-json`, starts and initializes the server, sends `hooks/list`, deserializes `HooksListResponse`, and asserts the single returned entry has an empty `hooks` vector, exactly one warning, and that the warning text contains `failed to parse plugin hooks config`.

**Call relations**: This negative plugin-listing test uses `write_plugin_hook_config` for setup and validates the warning path rather than successful hook discovery.

*Call graph*: calls 2 internal fn (new, write_plugin_hook_config); 7 external calls (new, Integer, to_response, assert!, assert_eq!, timeout, vec!).


##### `hooks_list_uses_each_cwds_effective_feature_enablement`  (lines 378–469)

```
async fn hooks_list_uses_each_cwds_effective_feature_enablement() -> Result<()>
```

**Purpose**: Checks that `hooks/list` evaluates feature enablement separately for each requested cwd, so project-local config can enable hooks even when user config disables them globally.

**Data flow**: It writes user `config.toml` with `[features] hooks = false`, creates a workspace with `.git` and `.codex/config.toml` enabling hooks and defining a project hook, marks the workspace trusted via `set_project_trust_level`, starts and initializes the server, sends `hooks/list` for both the Codex home and workspace paths, deserializes the response, constructs the expected two-entry `Vec<HooksListEntry>` where only the workspace has a hook, and asserts equality.

**Call relations**: This test combines direct filesystem setup with `set_project_trust_level`; it demonstrates that `hooks/list` resolves effective config per cwd rather than once globally.

*Call graph*: calls 3 internal fn (new, set_project_trust_level, try_from); 8 external calls (new, Integer, to_response, assert_eq!, create_dir_all, write, timeout, vec!).


##### `hooks_list_uses_root_repo_hooks_for_linked_worktrees`  (lines 472–551)

```
async fn hooks_list_uses_root_repo_hooks_for_linked_worktrees() -> Result<()>
```

**Purpose**: Verifies that linked Git worktrees inherit hooks from the root repository's `.codex/config.toml`, and that trust state keyed by the root hook applies when listing from the worktree.

**Data flow**: It creates a repo root and linked worktree layout where the worktree `.git` file points into `repo/.git/worktrees/feature-x`, writes different project hook configs into both repo root and worktree `.codex` directories, marks only the repo root trusted, starts and initializes the server, sends `hooks/list` for both paths, and asserts both returned hooks use the root repo command, key, and source path. It then writes `hooks.state` via `config/batchWrite` to store `trusted_hash` for that hook key, sends `hooks/list` again for the worktree only, and asserts the hook's `trust_status` is now `Trusted`.

**Call relations**: This test uses `write_project_hook_config` and `set_project_trust_level` during setup, then relies on `config/batchWrite` to mutate hook trust state and observe the updated listing.

*Call graph*: calls 4 internal fn (new, write_project_hook_config, set_project_trust_level, from_absolute_path); 9 external calls (new, Integer, to_response, assert_eq!, format!, create_dir_all, write, timeout, vec!).


##### `config_batch_write_toggles_user_hook`  (lines 554–650)

```
async fn config_batch_write_toggles_user_hook() -> Result<()>
```

**Purpose**: Shows that writing `hooks.state` through `config/batchWrite` toggles a user hook's enabled flag in subsequent `hooks/list` responses.

**Data flow**: It writes user hook config, starts and initializes the server, lists hooks to capture the initial hook key and confirm `enabled == true`, sends `config/batchWrite` with `hooks.state` upserting `{ hook.key: { enabled: false } }`, waits for a `ConfigWriteResponse`, lists hooks again and asserts the same hook key is present but `enabled == false`, then sends another batch write setting `enabled: true` and confirms a final `hooks/list` shows the hook enabled again.

**Call relations**: This test is a pure config/list round-trip. It uses `write_user_hook_config` for setup and repeatedly alternates between `hooks/list` and `config/batchWrite` to validate persisted enablement state.

*Call graph*: calls 2 internal fn (new, write_user_hook_config); 6 external calls (new, Integer, to_response, assert_eq!, timeout, vec!).


##### `config_batch_write_updates_hook_trust_for_loaded_session`  (lines 653–901)

```
async fn config_batch_write_updates_hook_trust_for_loaded_session() -> Result<()>
```

**Purpose**: Verifies that changing hook trust and then modifying the hook definition affects execution behavior immediately for an already loaded session.

**Data flow**: On non-Windows platforms, it creates a mock responses server with four canned assistant turns, writes a Python hook script that appends stdin JSON payloads to a log file, writes `config.toml` defining a `UserPromptSubmit` command hook, starts and initializes the server, lists hooks to capture the initial untrusted hook metadata, starts a thread, and runs a first turn; because the hook is untrusted, the log file must not exist. It then batch-writes `hooks.state` with `trusted_hash` equal to the hook's `current_hash`, lists hooks again to confirm `HookTrustStatus::Trusted`, runs a second turn, and asserts exactly one log entry exists. Next it batch-writes a replacement `hooks.UserPromptSubmit` definition adding `statusMessage`, lists hooks again to confirm the key is unchanged but `current_hash` changed and `trust_status` became `Modified`, runs a third turn, and asserts the log entry count remains one.

**Call relations**: This is the most dynamic hook test in the file. It alternates among `hooks/list`, `config/batchWrite`, and live turn execution to prove that trust-state changes and hook-definition changes are applied to an already loaded session without recreating the thread.

*Call graph*: calls 1 internal fn (new); 13 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert!, assert_eq!, assert_ne!, format!, skip_if_windows! (+3 more)).


##### `config_batch_write_disables_hook_for_loaded_session`  (lines 904–1094)

```
async fn config_batch_write_disables_hook_for_loaded_session() -> Result<()>
```

**Purpose**: Checks that disabling a trusted hook via `hooks.state` stops further executions in an already loaded session.

**Data flow**: On non-Windows platforms, it creates a mock responses server with three canned assistant turns, writes the same style of Python logging hook and config, starts and initializes the server, lists hooks to capture the hook key, batch-writes `trusted_hash` so the hook becomes trusted, starts a thread, runs a first turn, and asserts one log entry was written. It then batch-writes `hooks.state` with `{ hook.key: { enabled: false } }`, runs a second turn on the same thread, and asserts the log file still contains only one entry.

**Call relations**: This test complements the trust-update test by focusing on the enabled flag. It uses the same live-session pattern—trust first, execute once, disable, execute again—to prove loaded sessions observe hook disablement immediately.

*Call graph*: calls 1 internal fn (new); 11 external calls (default, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, format!, skip_if_windows!, write, timeout (+1 more)).


### `app-server/tests/suite/v2/skills_list.rs`

`test` · `request handling`

This module is a broad integration suite for skill discovery. Several small fixture helpers create realistic on-disk layouts: `write_skill` creates a home-level `skills/<name>/SKILL.md`; `write_plugin_with_skill` builds a local plugin marketplace under `.agents/plugins`, a plugin manifest under `.codex-plugin/plugin.json`, and a nested skill; `write_cached_remote_plugin_with_skill` simulates a cached remote plugin under `plugins/cache/openai-curated-remote/...`; and two config writers enable plugins or remote plugins by writing `chatgpt_base_url` plus feature flags. The tests then combine those fixtures with `TestAppServer`, mock ChatGPT auth, and `wiremock` HTTP endpoints to validate concrete behaviors.

The remote-plugin-cache test demonstrates a two-phase refresh model: an initial forced skills list sees only stale cache state, then a plugin-list request triggers installed-plugin refresh, after which repeated non-forced skills-list polling eventually reveals `linear:triage-issues` with the canonicalized cached path and `enabled = true`. Other tests verify that workspace plugin skills are hidden when account settings disable plugins, cwd-local roots are skipped when `CODEX_EXEC_SERVER_URL_ENV_VAR=none`, relative cwd values are accepted and echoed back unchanged, and response ordering preserves the requested cwd order. Cache semantics are tested by seeding a cwd result before a skill exists, confirming it remains absent until `force_reload = true`. Runtime extra roots are process-local: setting them emits `skills/changed`, affects subsequent listings, can be reset or cleared, and does not persist across a new `TestAppServer` instance. Finally, a watcher-based test edits an existing `SKILL.md` after initialization and an active thread, waits for `skills/changed`, and confirms the updated description is visible without forcing reload.

#### Function details

##### `write_skill`  (lines 38–44)

```
fn write_skill(root: &TempDir, name: &str) -> Result<()>
```

**Purpose**: Creates a simple standalone skill fixture under a temporary Codex home directory. The generated `SKILL.md` includes frontmatter with the supplied name and a matching description.

**Data flow**: Takes a `TempDir` root and skill name, constructs `root/skills/<name>`, creates the directory tree, formats markdown frontmatter plus a body, writes it to `SKILL.md`, and returns `Ok(())` or any filesystem error wrapped in `anyhow::Result`.

**Call relations**: Used by tests that need a home-level skill fixture: plugin-disabling behavior, cwd-root disabling behavior, and watcher-driven `skills/changed` behavior.

*Call graph*: called by 3 (skills_changed_notification_is_emitted_after_skill_change, skills_list_excludes_plugin_skills_when_workspace_codex_plugins_disabled, skills_list_skips_cwd_roots_when_environment_disabled); 4 external calls (path, format!, create_dir_all, write).


##### `expect_skills_changed_notification`  (lines 46–61)

```
async fn expect_skills_changed_notification(
    mcp: &mut TestAppServer,
    timeout_duration: Duration,
) -> Result<()>
```

**Purpose**: Waits for a `skills/changed` notification and asserts that its payload is the empty `SkillsChangedNotification {}` struct. It encapsulates the repeated timeout, deserialization, and equality check used by runtime-root tests.

**Data flow**: Accepts a mutable `TestAppServer` and a timeout duration, waits for `read_stream_until_notification_message("skills/changed")`, requires notification params to be present, deserializes them into `SkillsChangedNotification`, asserts equality with the empty struct, and returns `Ok(())`.

**Call relations**: Called by `skills_extra_roots_set_updates_process_runtime_roots` after each successful extra-roots mutation to verify the server announces the cache invalidation/change.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 1 (skills_extra_roots_set_updates_process_runtime_roots); 3 external calls (assert_eq!, from_value, timeout).


##### `write_plugins_enabled_config_with_base_url`  (lines 63–77)

```
fn write_plugins_enabled_config_with_base_url(
    codex_home: &std::path::Path,
    base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes a minimal config enabling plugin support against a supplied ChatGPT backend base URL. It is used for tests that need local plugin discovery but not remote-plugin-specific behavior.

**Data flow**: Receives the Codex home path and base URL, joins `config.toml`, formats a TOML string containing `chatgpt_base_url` and `[features] plugins = true`, and writes it to disk. It returns `std::io::Result<()>`.

**Call relations**: Used by `skills_list_excludes_plugin_skills_when_workspace_codex_plugins_disabled` during setup.

*Call graph*: called by 1 (skills_list_excludes_plugin_skills_when_workspace_codex_plugins_disabled); 3 external calls (join, format!, write).


##### `write_remote_plugins_enabled_config_with_base_url`  (lines 79–94)

```
fn write_remote_plugins_enabled_config_with_base_url(
    codex_home: &std::path::Path,
    base_url: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes a config enabling both plugins and remote-plugin support against a supplied backend base URL. This is the setup path for tests that exercise cached remote plugin skills and plugin refresh.

**Data flow**: Takes the Codex home path and base URL, computes `config.toml`, formats TOML with `chatgpt_base_url`, `plugins = true`, and `remote_plugin = true`, and writes it to disk. It returns `std::io::Result<()>`.

**Call relations**: Called by `skills_list_loads_remote_installed_plugin_skills_from_cache` before starting `TestAppServer`.

*Call graph*: called by 1 (skills_list_loads_remote_installed_plugin_skills_from_cache); 3 external calls (join, format!, write).


##### `write_plugin_with_skill`  (lines 96–135)

```
fn write_plugin_with_skill(
    repo_root: &std::path::Path,
    plugin_name: &str,
    skill_name: &str,
) -> Result<()>
```

**Purpose**: Creates a local workspace plugin fixture complete with marketplace metadata, plugin manifest, and one skill. The resulting layout mimics how workspace plugins are discovered from a repository root.

**Data flow**: Accepts a repository root path, plugin name, and skill name; creates `.git` and `.agents/plugins`, writes `marketplace.json` referencing a local plugin path, creates `<plugin>/.codex-plugin/plugin.json`, creates `<plugin>/skills/<skill>`, and writes a `SKILL.md` with frontmatter and body. It returns `Result<()>`.

**Call relations**: Used by `skills_list_excludes_plugin_skills_when_workspace_codex_plugins_disabled` to provide a plugin skill that should be hidden when workspace plugin support is disabled by account settings.

*Call graph*: called by 1 (skills_list_excludes_plugin_skills_when_workspace_codex_plugins_disabled); 4 external calls (join, format!, create_dir_all, write).


##### `write_cached_remote_plugin_with_skill`  (lines 137–155)

```
fn write_cached_remote_plugin_with_skill(
    codex_home: &std::path::Path,
) -> Result<std::path::PathBuf>
```

**Purpose**: Builds a cached remote plugin fixture under the Codex home plugin cache and returns the path to its skill file. The test uses that path later to verify the discovered skill points at the cached plugin content on disk.

**Data flow**: Takes the Codex home path, creates `plugins/cache/openai-curated-remote/linear/local/.codex-plugin`, writes `plugin.json` naming the plugin `linear`, creates `skills/triage-issues`, writes its `SKILL.md`, and returns the resulting `PathBuf` to that file.

**Call relations**: Called by `skills_list_loads_remote_installed_plugin_skills_from_cache` during fixture setup before the app server is started.

*Call graph*: called by 1 (skills_list_loads_remote_installed_plugin_skills_from_cache); 3 external calls (join, create_dir_all, write).


##### `skills_list_loads_remote_installed_plugin_skills_from_cache`  (lines 158–337)

```
async fn skills_list_loads_remote_installed_plugin_skills_from_cache() -> Result<()>
```

**Purpose**: Tests that cached remote plugin skills become visible only after plugin installation state is refreshed, and that the discovered skill points at the cached file path. It models the interaction between stale skills cache, plugin directory listing, installed-plugin refresh, and eventual skills-list visibility.

**Data flow**: Creates temporary Codex home and cwd directories, starts a `wiremock::MockServer`, writes a cached remote plugin fixture and remote-plugins-enabled config, and writes ChatGPT auth credentials. It mounts `/ps/plugins/list` responses showing the plugin in the directory but not yet installed, initializes `TestAppServer`, and sends a forced `skills/list` request; the resulting `SkillsListResponse` must not yet contain `linear:triage-issues`. It then mounts `/ps/plugins/installed` responses showing `linear` enabled, sends `plugin/list` to trigger refresh, and repeatedly sends non-forced `skills/list` requests until the response contains `linear:triage-issues`. Finally it asserts there is one cwd entry, no errors, the skill path canonicalizes to the cached `SKILL.md`, and `enabled` is true.

**Call relations**: This is a top-level integration test that uses `write_cached_remote_plugin_with_skill` and `write_remote_plugins_enabled_config_with_base_url` for setup. It also depends on external auth/config helpers and repeatedly drives `TestAppServer` request/response methods until the asynchronous plugin refresh is reflected in skills listing.

*Call graph*: calls 4 internal fn (new, new, write_cached_remote_plugin_with_skill, write_remote_plugins_enabled_config_with_base_url); 19 external calls (from_millis, given, start, new, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq! (+9 more)).


##### `skills_list_excludes_plugin_skills_when_workspace_codex_plugins_disabled`  (lines 340–402)

```
async fn skills_list_excludes_plugin_skills_when_workspace_codex_plugins_disabled() -> Result<()>
```

**Purpose**: Verifies that home-level skills remain visible while workspace plugin skills are suppressed when account settings disable plugins. It specifically checks that plugin discovery honors remote account policy rather than blindly exposing local plugin content.

**Data flow**: Creates temporary Codex home and repo directories, starts a mock backend, writes a home skill and a workspace plugin-with-skill fixture, writes plugin-enabled config, and writes ChatGPT auth with a team plan. It mounts an account-settings endpoint returning `enable_plugins: false`, starts `TestAppServer` without managed config, sends a forced `skills/list` request for the repo root, parses `SkillsListResponse`, and asserts the single cwd entry contains `home-skill` but not `demo-plugin:plugin-skill`.

**Call relations**: This top-level test uses `write_skill`, `write_plugin_with_skill`, and `write_plugins_enabled_config_with_base_url` to build the fixture state before exercising the skills-list endpoint.

*Call graph*: calls 5 internal fn (new, new_without_managed_config, write_plugin_with_skill, write_plugins_enabled_config_with_base_url, write_skill); 15 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq!, format! (+5 more)).


##### `skills_list_skips_cwd_roots_when_environment_disabled`  (lines 405–452)

```
async fn skills_list_skips_cwd_roots_when_environment_disabled() -> Result<()>
```

**Purpose**: Checks that cwd-local skill roots are ignored when the exec-server environment variable is explicitly set to `none`. Home-level skills should still be listed, but repository-local `.codex/skills` content should not.

**Data flow**: Creates temporary Codex home and cwd directories, writes a home skill, creates `.codex/skills/repo-skill/SKILL.md` under the cwd, starts `TestAppServer::new_with_env` with `CODEX_EXEC_SERVER_URL_ENV_VAR` set to `none`, initializes it, sends a forced `skills/list` request for the cwd, and parses the response. It asserts there is one entry whose `cwd` matches the requested cwd, `errors` is empty, `home-skill` is present, and `repo-skill` is absent.

**Call relations**: This direct test uses `write_skill` for the home fixture and relies on environment-controlled server startup rather than custom config writers.

*Call graph*: calls 2 internal fn (new_with_env, write_skill); 9 external calls (new, Integer, to_response, assert!, assert_eq!, create_dir_all, write, timeout, vec!).


##### `skills_list_accepts_relative_cwds`  (lines 455–480)

```
async fn skills_list_accepts_relative_cwds() -> Result<()>
```

**Purpose**: Ensures the skills-list API accepts relative cwd paths and echoes them back in the response instead of requiring absolute paths. The test is about request normalization behavior, not skill discovery content.

**Data flow**: Creates a temporary Codex home, constructs a relative path `relative-cwd`, creates that directory under the home, starts and initializes `TestAppServer`, sends a forced `skills/list` request with the relative cwd, parses `SkillsListResponse`, and asserts there is one entry whose `cwd` equals the original relative path and whose `errors` vector is empty.

**Call relations**: This is a standalone API-shape test. It does not use any fixture helpers beyond filesystem setup and the standard `TestAppServer` request/response flow.

*Call graph*: calls 1 internal fn (new); 8 external calls (new, Integer, to_response, assert_eq!, create_dir_all, from, timeout, vec!).


##### `skills_list_preserves_requested_cwd_order`  (lines 483–517)

```
async fn skills_list_preserves_requested_cwd_order() -> Result<()>
```

**Purpose**: Verifies that the server returns skills-list entries in the same order as the requested cwd list. This guards against internal sorting or deduplication changing client-visible ordering.

**Data flow**: Creates temporary Codex home plus two cwd directories, starts and initializes `TestAppServer`, sends a forced `skills/list` request with `[first_cwd, second_cwd]`, parses the response, maps each returned entry to its `cwd`, collects them into a vector, and asserts that vector exactly matches the original request order.

**Call relations**: This top-level test directly exercises the skills-list endpoint and checks only ordering semantics in the returned `data` array.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Integer, to_response, assert_eq!, timeout, vec!).


##### `skills_list_uses_cached_result_until_force_reload`  (lines 520–595)

```
async fn skills_list_uses_cached_result_until_force_reload() -> Result<()>
```

**Purpose**: Tests the cwd-level skills cache by proving that newly created skills do not appear in repeated non-forced requests until a forced reload is requested. It validates both cache reuse and explicit invalidation.

**Data flow**: Creates temporary Codex home and cwd directories, starts and initializes `TestAppServer`, and first sends a non-forced `skills/list` request before any cwd-local skill exists; the parsed response must not contain `late-extra-skill`. It then creates `.codex/skills/late-extra-skill/SKILL.md`, sends a second non-forced request and confirms the skill is still absent, then sends a third request with `force_reload: true` and confirms the skill is now present in the returned `SkillsListResponse`.

**Call relations**: This direct test drives the same endpoint three times to observe cache behavior over time. It does not call helper functions beyond standard server setup.

*Call graph*: calls 1 internal fn (new); 9 external calls (new, Integer, to_response, assert!, assert_eq!, create_dir_all, write, timeout, vec!).


##### `skills_extra_roots_set_updates_process_runtime_roots`  (lines 598–739)

```
async fn skills_extra_roots_set_updates_process_runtime_roots() -> Result<()>
```

**Purpose**: Validates that runtime-configured extra skill roots affect subsequent skills listings, emit `skills/changed`, can be replaced or cleared, and do not persist across process restarts. It specifically tests process-local mutable state rather than static config.

**Data flow**: Creates temporary Codex home, cwd, and extra-root directories; writes a `runtime-skill` under `<extra_root>/skills`; starts and initializes `TestAppServer`; sends `skills/extraRoots/set` with the absolute extra skills root; parses `SkillsExtraRootsSetResponse`; and waits for `skills/changed` via `expect_skills_changed_notification`. It then sends `skills/list` and asserts `runtime-skill` is present. Next it sets extra roots to a missing directory, waits for another change notification, lists skills again, and asserts `runtime-skill` is absent. It repeats with an empty extra-roots list, verifies absence again, drops the server, starts a fresh `TestAppServer`, lists skills once more, and confirms the runtime root did not persist across restart.

**Call relations**: This test is the sole caller of `expect_skills_changed_notification`. It orchestrates repeated mutation of runtime roots and subsequent skills-list reads to validate both notification and state-reset behavior.

*Call graph*: calls 2 internal fn (new, expect_skills_changed_notification); 10 external calls (new, new, Integer, to_response, assert!, assert_eq!, create_dir_all, write, timeout, vec!).


##### `skills_changed_notification_is_emitted_after_skill_change`  (lines 742–849)

```
async fn skills_changed_notification_is_emitted_after_skill_change() -> Result<()>
```

**Purpose**: Checks the filesystem watcher path by modifying an existing skill file after initialization and asserting that the server emits `skills/changed` and serves updated skill metadata. It proves that skill caches are invalidated by on-disk edits without requiring `force_reload`.

**Data flow**: Starts a repeating mock responses server, creates a temporary Codex home, writes config via `write_mock_responses_config_toml_with_chatgpt_base_url`, writes an initial `demo` skill, and starts `TestAppServer::new_with_env` with the exec-server URL unset. After initialization it sends an initial forced `skills/list` request and confirms the `demo` skill has description `demo description`. It then starts a thread with an explicit `ThreadStartParams` literal, rewrites the skill's `SKILL.md` so the description becomes `updated`, waits up to `WATCHER_TIMEOUT` for `skills/changed`, deserializes and asserts the empty notification payload, and finally sends a non-forced `skills/list` request to confirm the updated description is now visible.

**Call relations**: This top-level watcher test uses `write_skill` for fixture creation and relies on the external mock-config helper for setup. It combines skills-list requests, a thread-start request, and a file rewrite to trigger and validate watcher-driven cache invalidation.

*Call graph*: calls 2 internal fn (new_with_env, write_skill); 11 external calls (new, Integer, create_mock_responses_server_repeating_assistant, to_response, write_mock_responses_config_toml_with_chatgpt_base_url, assert!, assert_eq!, from_value, write, timeout (+1 more)).


### `app-server/tests/suite/v2/executor_skills.rs`

`test` · `request handling`

This test file exercises the interaction between thread startup capability-root selection and skill resolution during a turn. It builds a temporary Codex home with a minimal `config.toml` pointing at a mock Responses API server, enables skill instruction inclusion, and deliberately creates two competing skill definitions: a local skill under `skills/local-deploy/SKILL.md` whose frontmatter names it `demo-plugin:deploy`, and a plugin skill inside a temporary plugin directory containing `.codex-plugin/plugin.json` plus `skills/deploy/SKILL.md`. The thread is started with `selected_capability_roots` containing a single `SelectedCapabilityRoot` whose `CapabilityRootLocation::Environment` points at that plugin directory, making the plugin root explicitly active for the thread.

After initialization, the test starts a thread, then starts a turn whose user text references `$demo-plugin:deploy`. It waits for both the request response and the `turn/completed` notification, then inspects the outbound mock model request captured by the SSE harness. The assertions are concrete: the developer-visible prompt must mention the skill name, exactly one user-visible `<skill>` fragment must be present, that fragment must contain `<name>demo-plugin:deploy</name>` and the plugin marker text, and it must not contain the local-skill marker. The test therefore locks in precedence behavior: when an executor root is selected, the plugin skill from that root becomes model-visible and wins over a same-named local skill.

#### Function details

##### `selected_executor_root_exposes_plugin_skill`  (lines 24–148)

```
async fn selected_executor_root_exposes_plugin_skill() -> Result<()>
```

**Purpose**: Builds a temporary app-server environment with both local and plugin skill definitions, starts a thread with the plugin capability root selected, runs a turn that invokes the skill name, and asserts that the model saw only the plugin skill body.

**Data flow**: It creates temporary directories for `codex_home` and the plugin root, writes `config.toml`, local `SKILL.md`, plugin manifest JSON, and plugin `SKILL.md`, then starts a mock SSE server and mounts a canned assistant response stream. It initializes `TestAppServer`, sends `ThreadStartParams` with `selected_capability_roots`, converts the JSON-RPC thread-start response into `ThreadStartResponse`, sends a `TurnStartParams` containing `UserInput::Text`, waits for the turn response and `turn/completed`, then reads the captured outbound provider request and derives developer texts plus `<skill>` user fragments for assertions. It returns `Ok(())` on success and otherwise propagates I/O, timeout, or protocol conversion failures.

**Call relations**: This is the file's only test entrypoint and is invoked by the async test harness. Within its flow it delegates environment setup to `responses::start_mock_server`, `responses::mount_sse_once`, and `TestAppServer::new`, then uses the app-server request helpers and `to_response` to drive initialization, thread creation, and turn execution before validating the captured provider-side request.

*Call graph*: calls 4 internal fn (new, mount_sse_once, sse, start_mock_server); 11 external calls (default, new, Integer, to_response, assert!, assert_eq!, format!, create_dir_all, write, timeout (+1 more)).


### MCP servers, tools, and resources
These suites exercise MCP integration end to end, from server status and executor-scoped exposure to direct tool calls, elicitation forwarding, and resource access.

### `app-server/tests/suite/v2/executor_mcp.rs`

`test` · `request handling`

This file contains a focused integration test around executor-scoped MCP server exposure. It sets up a mock responses backend for normal model turns, writes `environments.toml` defining a local executor environment that launches `codex exec-server --listen stdio` with a marker environment variable, and creates a temporary plugin directory containing both `.codex-plugin/plugin.json` and `.mcp.json`. The plugin’s MCP server definition references a stdio test server binary and requests that the executor-only environment variable be forwarded.

The main test starts `TestAppServer`, creates one thread with `selected_capability_roots` pointing at the plugin path inside the configured executor environment, then mutates both the plugin `.mcp.json` and the main `config.toml` to add a separate globally configured MCP server before calling `config/mcpServer/reload`. It next drives a turn whose mocked model output calls the executor plugin’s MCP tool via namespace `mcp__executor_demo`, waits for turn completion, and inspects the recorded follow-up request to confirm the tool output contains both the echoed message and the executor-only environment variable value. Finally, it directly calls the reloaded global MCP server through `mcp_server_tool_call`, verifies the structured echo response, and compares `listMcpServerStatus` results for the selected thread versus an unselected thread to prove the executor plugin server is visible only on the selected thread.

Two small helpers package repeated RPC patterns: `start_thread` returns a thread id from `thread/start`, and `mcp_server_names` lists MCP server names for a given thread by deserializing `ListMcpServerStatusResponse`.

#### Function details

##### `selected_executor_plugin_exposes_its_stdio_mcp_only_to_that_thread`  (lines 34–219)

```
async fn selected_executor_plugin_exposes_its_stdio_mcp_only_to_that_thread() -> Result<()>
```

**Purpose**: Verifies that a plugin selected through an executor capability root exposes its stdio MCP server only within that thread, while globally reloaded MCP servers remain callable normally. It also proves the executor-scoped MCP tool runs with executor-provided environment variables.

**Data flow**: Starts a mock responses server, writes mock-provider config and an `environments.toml` defining executor `executor-1`, creates a temporary plugin directory with `.codex-plugin/plugin.json` and `.mcp.json` declaring MCP server `executor_demo`, starts and initializes `TestAppServer`, and creates a selected thread via `start_thread` with one `SelectedCapabilityRoot` pointing at the plugin path in the executor environment. It then rewrites the plugin `.mcp.json` to empty, appends a global MCP server `refresh_probe` to `config.toml`, triggers `config/mcpServer/reload`, mounts two SSE responses where the first emits a namespaced function call to `mcp__executor_demo.echo` and the second completes the turn, starts a turn on the selected thread, waits for response and `turn/completed`, inspects recorded requests to assert the tool call occurred and the follow-up function output contains both the echoed message and `EXECUTOR_ENV_VALUE`, directly calls `refresh_probe.echo` through `send_mcp_server_tool_call_request` and asserts the structured echo response, then compares `mcp_server_names` for the selected thread and a newly created unselected thread to assert only the selected thread sees `executor_demo`.

**Call relations**: This is the file’s sole test and is invoked by the Tokio harness. It delegates thread creation to `start_thread`, MCP server listing to `mcp_server_names`, and otherwise orchestrates config mutation, reload, turn execution, and direct MCP tool invocation to prove thread-scoped executor plugin visibility.

*Call graph*: calls 4 internal fn (new, start_thread, mount_sse_sequence, start_mock_server); 16 external calls (new, default, new, Integer, to_response, write_mock_responses_config_toml, assert!, assert_eq!, format!, json! (+6 more)).


##### `mcp_server_names`  (lines 221–244)

```
async fn mcp_server_names(
    app_server: &mut TestAppServer,
    thread_id: String,
) -> Result<Vec<String>>
```

**Purpose**: Lists MCP server names visible to a specific thread by calling the status-list RPC and extracting the `name` field from each entry. It is a convenience helper for visibility assertions.

**Data flow**: Accepts a mutable `TestAppServer` and a thread id string, sends `ListMcpServerStatusParams` with `thread_id: Some(thread_id)` and no pagination/detail options, waits for the matching response under timeout, deserializes it to `ListMcpServerStatusResponse`, maps `response.data` to each server’s `name`, and returns the collected `Vec<String>`.

**Call relations**: Called twice by the main test: once for the selected thread and once for an unselected thread. It packages the repeated list-status request/response flow so the test can compare visibility sets directly.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_list_mcp_server_status_request); 3 external calls (Integer, to_response, timeout).


##### `start_thread`  (lines 246–264)

```
async fn start_thread(
    app_server: &mut TestAppServer,
    selected_capability_roots: Option<Vec<SelectedCapabilityRoot>>,
) -> Result<String>
```

**Purpose**: Starts a thread with optional selected capability roots and returns the created thread id. It is the setup helper for creating selected and unselected threads in the executor MCP test.

**Data flow**: Sends `ThreadStartParams` with `model: Some("mock-model")`, the provided `selected_capability_roots`, and other fields defaulted, waits for the matching response under timeout, deserializes it to `ThreadStartResponse`, and returns `thread.id`.

**Call relations**: Used by the main test to create both the executor-selected thread and the comparison thread without selected capability roots. It sits at the start of each visibility branch in that test’s flow.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_start_request); called by 1 (selected_executor_plugin_exposes_its_stdio_mcp_only_to_that_thread); 4 external calls (default, Integer, to_response, timeout).


### `app-server/tests/suite/v2/mcp_server_status.rs`

`test` · `request handling`

This file validates how the app server inventories configured MCP servers and reports their tools, resources, and metadata. `McpStatusServer` is a simple tool-only RMCP server that advertises a titled implementation (`Lookup Server`) and returns one read-only tool whose name is supplied at startup. `SlowInventoryServer` extends that pattern with resource and resource-template capabilities but intentionally sleeps for two seconds in both inventory methods, allowing the tests to prove that `McpServerStatusDetail::ToolsAndAuthOnly` avoids expensive resource enumeration. The tests all write a base mock-provider config, append `[mcp_servers.*]` entries to `config.toml`, start `TestAppServer`, and issue `ListMcpServerStatusParams`. One test checks that raw configured server names and raw tool names are preserved and that server info title is surfaced. Another creates a trusted workspace, starts a thread rooted there, writes `.codex/config.toml` inside the workspace, and proves threadless status listing ignores project-local MCP config while thread-scoped listing includes it. The slow-inventory test uses a 500 ms response timeout to ensure the app server does not block on resource inventory when only tools/auth are requested. The collision test configures `some-server` and `some_server` simultaneously and verifies both survive sanitization without losing their distinct tool inventories.

#### Function details

##### `mcp_server_status_list_returns_raw_server_and_tool_names`  (lines 46–115)

```
async fn mcp_server_status_list_returns_raw_server_and_tool_names() -> Result<()>
```

**Purpose**: Checks that status listing returns configured server names and tool names exactly as exposed by the MCP server, along with server info metadata.

**Data flow**: It starts an empty mock responses server and a mock MCP server exposing tool `look-up.raw`, writes base config, appends an `[mcp_servers.some-server]` entry pointing at the MCP server, starts `TestAppServer`, sends a status-list request with no detail override and no thread id, decodes `ListMcpServerStatusResponse`, and asserts there is one entry named `some-server` whose tool map contains `look-up.raw` and whose `server_info.title` is `Lookup Server`. It then aborts the MCP server task.

**Call relations**: This is the baseline status-list test. It uses `start_mcp_server` to provide a predictable inventory and verifies the app server does not sanitize away raw names in the returned status payload.

*Call graph*: calls 2 internal fn (new, start_mcp_server); 12 external calls (new, new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, write_mock_responses_config_toml, assert_eq!, format!, read_to_string (+2 more)).


##### `mcp_server_status_list_uses_thread_project_local_config`  (lines 118–207)

```
async fn mcp_server_status_list_uses_thread_project_local_config() -> Result<()>
```

**Purpose**: Verifies that project-local `.codex/config.toml` MCP server config is visible only when status listing is scoped to a thread rooted in that trusted workspace.

**Data flow**: It starts a mock responses server and MCP server exposing `project_lookup`, writes base config into a temporary Codex home, creates a temporary workspace with `.git`, marks that workspace trusted, starts `TestAppServer`, creates a thread with `cwd` set to the workspace, writes `.codex/config.toml` inside the workspace defining `[mcp_servers.project-server]`, then issues two status-list requests: one threadless and one with `thread_id` set to the created thread. It decodes both responses and asserts the threadless one is empty while the thread-scoped one contains `project-server` with tool `project_lookup`.

**Call relations**: This test combines trust setup, thread creation, and project-local config to exercise the app server branch that resolves MCP config relative to a thread’s workspace.

*Call graph*: calls 3 internal fn (new, start_mcp_server, set_project_trust_level); 13 external calls (new, default, new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, write_mock_responses_config_toml, assert_eq!, format! (+3 more)).


##### `McpStatusServer::get_info`  (lines 215–219)

```
fn get_info(&self) -> ServerInfo
```

**Purpose**: Advertises the simple mock status server as tool-capable and includes implementation metadata with a human-readable title.

**Data flow**: It builds tool-enabled `ServerCapabilities`, wraps them in `ServerInfo`, and attaches `Implementation::new("lookup-server", "1.0.0").with_title("Lookup Server")` as server info.

**Call relations**: The app server reads this during MCP handshake so status responses can include `server_info`, which the baseline test asserts on.

*Call graph*: 3 external calls (new, builder, new).


##### `McpStatusServer::list_tools`  (lines 221–244)

```
async fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<ListTools
```

**Purpose**: Returns a single read-only tool whose name is supplied when the mock server is started.

**Data flow**: It builds an empty-object `JsonObject` schema from JSON, creates a `Tool` using the stored `tool_name`, marks it read-only, and returns `ListToolsResult` with that one tool and no pagination.

**Call relations**: Status-list tests using `start_mcp_server` rely on this inventory to populate the `tools` map in `ListMcpServerStatusResponse`.

*Call graph*: 8 external calls (new, Borrowed, Owned, new, json!, new, from_value, vec!).


##### `SlowInventoryServer::get_info`  (lines 253–260)

```
fn get_info(&self) -> ServerInfo
```

**Purpose**: Advertises a mock server that supports tools, resources, and resource templates.

**Data flow**: It constructs `ServerInfo` from capabilities with both `enable_tools()` and `enable_resources()` enabled.

**Call relations**: The app server uses this capability set when deciding what inventory calls are possible; the slow-inventory test then verifies a detail-limited status request does not invoke the expensive resource paths.

*Call graph*: 2 external calls (builder, new).


##### `SlowInventoryServer::list_tools`  (lines 262–285)

```
async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<rmcp::service::RoleServer>,
    ) -> Result<ListToolsResult, rmcp::ErrorData>
```

**Purpose**: Returns a single read-only tool for the slow-inventory mock server.

**Data flow**: It mirrors `McpStatusServer::list_tools`: builds an empty-object schema, creates a tool from the stored `tool_name`, marks it read-only, and returns it in `ListToolsResult`.

**Call relations**: The slow-inventory status test depends on this method returning quickly so the response can arrive within 500 ms even though resource inventory methods are intentionally slow.

*Call graph*: 8 external calls (new, Borrowed, Owned, new, json!, new, from_value, vec!).


##### `SlowInventoryServer::list_resources`  (lines 287–298)

```
async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<rmcp::service::RoleServer>,
    ) -> Result<ListResourcesResult, rmcp::ErrorD
```

**Purpose**: Simulates an expensive resource inventory call by sleeping before returning an empty resource list.

**Data flow**: It ignores request/context, awaits `tokio::time::sleep(Duration::from_secs(2))`, then returns `ListResourcesResult` with empty `resources`, no cursor, and no metadata.

**Call relations**: This method exists specifically so `mcp_server_status_list_tools_and_auth_only_skips_slow_inventory_calls` can prove the app server does not call it when only tools/auth details are requested.

*Call graph*: 3 external calls (from_secs, new, sleep).


##### `SlowInventoryServer::list_resource_templates`  (lines 300–311)

```
async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<rmcp::service::RoleServer>,
    ) -> Result<ListResourceTemplatesRes
```

**Purpose**: Simulates an expensive resource-template inventory call by sleeping before returning an empty template list.

**Data flow**: It sleeps for two seconds and then returns `ListResourceTemplatesResult` with empty `resource_templates`, no cursor, and no metadata.

**Call relations**: Like `list_resources`, this method supports the timing-based assertion that detail-limited status listing skips slow inventory branches.

*Call graph*: 3 external calls (from_secs, new, sleep).


##### `mcp_server_status_list_tools_and_auth_only_skips_slow_inventory_calls`  (lines 315–372)

```
async fn mcp_server_status_list_tools_and_auth_only_skips_slow_inventory_calls() -> Result<()>
```

**Purpose**: Ensures that requesting only tools/auth status avoids blocking on slow resource and resource-template inventory.

**Data flow**: It starts an empty mock responses server and a slow-inventory MCP server exposing tool `lookup`, writes base config plus an `[mcp_servers.some-server]` entry, starts `TestAppServer`, sends a status-list request with `detail: Some(McpServerStatusDetail::ToolsAndAuthOnly)`, and waits for the response with a 500 ms timeout. It decodes the response and asserts one server entry exists with tool `lookup` while both `resources` and `resource_templates` are empty vectors.

**Call relations**: This test uses `start_slow_inventory_mcp_server` and a deliberately short timeout to validate control flow inside the app server: it must skip the slow inventory methods entirely for this detail level.

*Call graph*: calls 2 internal fn (new, start_slow_inventory_mcp_server); 13 external calls (new, from_millis, new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, write_mock_responses_config_toml, assert_eq!, format! (+3 more)).


##### `mcp_server_status_list_keeps_tools_for_sanitized_name_collisions`  (lines 375–451)

```
async fn mcp_server_status_list_keeps_tools_for_sanitized_name_collisions() -> Result<()>
```

**Purpose**: Verifies that two configured MCP servers whose names would sanitize similarly still retain separate status entries and tool inventories.

**Data flow**: It starts an empty mock responses server plus two MCP servers exposing `dash_lookup` and `underscore_lookup`, writes base config, appends `[mcp_servers.some-server]` and `[mcp_servers.some_server]` entries, starts `TestAppServer`, sends a status-list request, decodes the response, transforms the returned data into a `BTreeMap` from server name to tool-name set, and asserts both entries are present with their respective tools. It then aborts both MCP server tasks.

**Call relations**: This test exercises a naming edge case in status aggregation. It uses two instances of `start_mcp_server` to prove the app server does not collapse distinct configured servers just because their sanitized forms might collide elsewhere.

*Call graph*: calls 2 internal fn (new, start_mcp_server); 12 external calls (new, new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, write_mock_responses_config_toml, assert_eq!, format!, read_to_string (+2 more)).


##### `start_mcp_server`  (lines 453–473)

```
async fn start_mcp_server(tool_name: &str) -> Result<(String, JoinHandle<()>)>
```

**Purpose**: Starts a simple tool-only MCP server exposing one configurable tool name.

**Data flow**: It binds a random localhost port, stores the provided tool name in an `Arc<String>`, constructs a `StreamableHttpService` factory that clones that name into `McpStatusServer`, nests the service under `/mcp` in an Axum router, spawns `axum::serve`, and returns the base URL plus task handle.

**Call relations**: Three tests call this helper to obtain a fast MCP server with predictable tool inventory and server metadata.

*Call graph*: called by 3 (mcp_server_status_list_keeps_tools_for_sanitized_name_collisions, mcp_server_status_list_returns_raw_server_and_tool_names, mcp_server_status_list_uses_thread_project_local_config); 9 external calls (new, default, new, default, new, bind, serve, format!, spawn).


##### `start_slow_inventory_mcp_server`  (lines 475–495)

```
async fn start_slow_inventory_mcp_server(tool_name: &str) -> Result<(String, JoinHandle<()>)>
```

**Purpose**: Starts an MCP server whose tool inventory is fast but whose resource inventories are intentionally slow.

**Data flow**: It binds a random localhost port, stores the tool name in an `Arc<String>`, constructs a `StreamableHttpService` factory that creates `SlowInventoryServer` instances, nests the service under `/mcp`, spawns the Axum server, and returns the base URL plus task handle.

**Call relations**: Only the slow-inventory test uses this helper, specifically to validate that the app server’s `ToolsAndAuthOnly` detail path avoids the server’s delayed inventory methods.

*Call graph*: called by 1 (mcp_server_status_list_tools_and_auth_only_skips_slow_inventory_calls); 9 external calls (new, default, new, default, new, bind, serve, format!, spawn).


### `app-server/tests/suite/v2/mcp_tool.rs`

`test` · `request handling`

This file focuses on the app server’s `mcp/server/toolCall` path and on model-driven MCP tool execution inside turns. `ToolAppsMcpServer` is a compact RMCP server exposing one read-only tool, `echo_tool`, with a single optional string argument `message`. Its `call_tool` implementation branches on that message: normal messages return structured JSON containing the echoed message and thread id plus text content and metadata; `large` returns oversized structured and text payloads to trigger truncation logic; `confirm` creates a form elicitation requiring `{ confirmed: true }`; and `auth` creates a URL elicitation with a fixed device-login URL and elicitation id. The tests write base config, append an MCP server entry, start `TestAppServer`, and then verify several behaviors: successful direct tool calls return content, structured content, `is_error`, and metadata; unknown thread ids produce an error mentioning `thread not found`; form and URL elicitations are surfaced as `ServerRequest::McpServerElicitationRequest` with exact typed payloads and can be answered by the client; and model-triggered MCP tool calls emit `item/completed` notifications whose embedded `ThreadItem::McpToolCall` result is truncated enough to stay below PTY output caps while still indicating truncation. The helper `wait_for_mcp_tool_call_completed` loops until the desired `item/completed` notification arrives, filtering by MCP call id.

#### Function details

##### `mcp_server_tool_call_returns_tool_result`  (lines 73–159)

```
async fn mcp_server_tool_call_returns_tool_result() -> Result<()>
```

**Purpose**: Verifies that a direct MCP tool call returns the mock server’s text content, structured content, error flag, and metadata.

**Data flow**: It starts a mock responses server and the mock MCP tool server, writes base config plus an `[mcp_servers.tool_server]` entry, starts `TestAppServer`, creates a thread, sends `McpServerToolCallParams` naming `echo_tool` with arguments `{message: "hello from app"}` and meta `{source: "mcp-app"}`, waits for the response, decodes `McpServerToolCallResponse`, and asserts the returned content text is `echo: hello from app`, `structured_content` contains the echoed message and thread id, `is_error` is `Some(false)`, and `meta` contains `calledBy: "mcp-app"`. It then shuts down the MCP server task.

**Call relations**: This is the baseline positive-path direct-call test. It depends on `start_mcp_server` and the normal branch of `ToolAppsMcpServer::call_tool`.

*Call graph*: calls 3 internal fn (new, start_mcp_server, start_mock_server); 12 external calls (new, default, new, Integer, to_response, write_mock_responses_config_toml, assert_eq!, format!, json!, read_to_string (+2 more)).


##### `mcp_server_tool_call_returns_error_for_unknown_thread`  (lines 162–188)

```
async fn mcp_server_tool_call_returns_error_for_unknown_thread() -> Result<()>
```

**Purpose**: Confirms that direct MCP tool calls fail when the supplied thread id does not exist.

**Data flow**: It creates an empty temporary Codex home, starts and initializes `TestAppServer`, sends `McpServerToolCallParams` with a fixed nonexistent UUID thread id, waits for the matching JSON-RPC error, and asserts the error message contains `thread not found`.

**Call relations**: This negative-path test bypasses MCP server setup entirely because validation should fail before any remote tool invocation occurs.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, Integer, assert!, json!, timeout).


##### `mcp_server_tool_call_round_trips_elicitation`  (lines 191–298)

```
async fn mcp_server_tool_call_round_trips_elicitation() -> Result<()>
```

**Purpose**: Tests that a form elicitation initiated by an MCP tool call is forwarded to the client and that the accepted response resumes the tool call successfully.

**Data flow**: It starts mock responses and MCP servers, writes config, starts `TestAppServer`, creates a thread with approval policy `UnlessTrusted`, sends a direct MCP tool call whose message is `confirm`, waits for a `ServerRequest::McpServerElicitationRequest`, constructs and asserts the expected boolean schema and request parameters, sends an accept response containing `{confirmed: true}`, then waits for the original tool-call response and asserts it contains one text content item `accepted`.

**Call relations**: This test exercises the `confirm` branch of `ToolAppsMcpServer::call_tool`, proving the app server can suspend a direct tool call on elicitation and resume it after the client responds.

*Call graph*: calls 3 internal fn (new, start_mcp_server, start_mock_server); 18 external calls (new, new, default, builder, Boolean, new, Integer, to_response, write_mock_responses_config_toml, assert_eq! (+8 more)).


##### `mcp_server_tool_call_forwards_url_elicitation`  (lines 301–401)

```
async fn mcp_server_tool_call_forwards_url_elicitation() -> Result<()>
```

**Purpose**: Tests that URL-style elicitation requests from an MCP tool are forwarded with the correct message, URL, and elicitation id.

**Data flow**: It performs the same setup pattern as the form-elicitation test, but sends a direct tool call whose message is `auth`. It waits for a `McpServerElicitationRequest`, asserts the params contain the `Url` variant with `Sign in to GitHub to continue.`, the fixed login URL, and elicitation id `github-auth-123`, sends an accept response with no content, then waits for the tool-call response and asserts it contains one text content item `accepted`.

**Call relations**: This test targets the `auth` branch of `ToolAppsMcpServer::call_tool`, complementing the form-elicitation test by covering URL-based elicitation forwarding.

*Call graph*: calls 3 internal fn (new, start_mcp_server, start_mock_server); 14 external calls (new, default, new, Integer, to_response, write_mock_responses_config_toml, assert_eq!, format!, json!, panic! (+4 more)).


##### `mcp_tool_call_completion_notification_contains_truncated_large_result`  (lines 404–534)

```
async fn mcp_tool_call_completion_notification_contains_truncated_large_result() -> Result<()>
```

**Purpose**: Verifies that large MCP tool results are truncated in completion notifications and serialized thread items so they stay within output-size limits.

**Data flow**: It creates a mock model response sequence that triggers an MCP tool call with message `large` and then a final assistant response, starts the mock MCP server, writes config with a large auto-compact limit, starts `TestAppServer`, creates a thread, starts a turn that causes the model to call the MCP tool, decodes the turn start response, waits for the matching `item/completed` notification via `wait_for_mcp_tool_call_completed`, destructures the returned `ThreadItem::McpToolCall`, and asserts identifiers, status, absence of error, and that the result contains one text item whose text mentions truncation and remains below `DEFAULT_OUTPUT_BYTES_CAP + 1024`. It then serializes the completed thread item and asserts the JSON length also stays bounded, waits for `turn/completed`, and shuts down the MCP server.

**Call relations**: This test combines model-driven tool invocation with the `large` branch of `ToolAppsMcpServer::call_tool`. It relies on `wait_for_mcp_tool_call_completed` to filter asynchronous notifications down to the relevant MCP call.

*Call graph*: calls 3 internal fn (new, start_mcp_server, wait_for_mcp_tool_call_completed); 17 external calls (new, default, new, Integer, create_mock_responses_server_sequence, to_response, write_mock_responses_config_toml, assert!, assert_eq!, format! (+7 more)).


##### `ToolAppsMcpServer::get_info`  (lines 540–542)

```
fn get_info(&self) -> ServerInfo
```

**Purpose**: Advertises the mock MCP server as supporting tools.

**Data flow**: It returns `ServerInfo::new(ServerCapabilities::builder().enable_tools().build())`.

**Call relations**: The app server reads this during MCP handshake before listing tools or invoking them.

*Call graph*: 2 external calls (builder, new).


##### `ToolAppsMcpServer::list_tools`  (lines 544–572)

```
async fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, rmcp::ErrorData>
```

**Purpose**: Returns the single read-only `echo_tool` definition with a schema containing an optional string `message` property.

**Data flow**: It builds a `JsonObject` schema from JSON describing an object with `message: string` and `additionalProperties: false`, creates a `Tool` named `echo_tool` with description `Echo a message.`, marks it read-only, and returns it in `ListToolsResult` with no pagination.

**Call relations**: The app server inventories this tool when exposing MCP tools for direct calls or model-driven invocation.

*Call graph*: 7 external calls (new, Borrowed, new, json!, new, from_value, vec!).


##### `ToolAppsMcpServer::call_tool`  (lines 574–665)

```
async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, rmcp::ErrorData>
```

**Purpose**: Implements all mock tool behaviors: normal echoing, oversized results, form elicitation, and URL elicitation.

**Data flow**: It asserts the requested tool name is `echo_tool`, extracts `message` from `request.arguments`, extracts `threadId` from `context.meta`, and initializes metadata with `calledBy: "mcp-app"`. If the message is `large`, it returns a `CallToolResult::structured` containing oversized structured JSON and large text content. If the message is `confirm`, it builds a boolean `ElicitationSchema`, calls `context.peer.create_elicitation` with a form request, asserts accepted content equals `{confirmed: true}` when accepted, and returns a success text result of `accepted`, `declined`, or `cancelled`. If the message is `auth`, it creates a URL elicitation, asserts accepted content is `{}` on accept, and returns the corresponding text result. Otherwise it returns structured echo data with text `echo: {message}` and the metadata.

**Call relations**: All direct-call and model-driven tests ultimately exercise this method. Different tests target different branches by choosing specific `message` values.

*Call graph*: 9 external calls (new, builder, new, Boolean, assert_eq!, json!, structured, success, vec!).


##### `start_mcp_server`  (lines 668–683)

```
async fn start_mcp_server() -> Result<(String, JoinHandle<()>)>
```

**Purpose**: Starts the mock MCP tool server on a random local port and returns its base URL and task handle.

**Data flow**: It binds a localhost TCP listener, constructs a `StreamableHttpService` that instantiates `ToolAppsMcpServer`, nests it under `/mcp` in an Axum router, spawns `axum::serve`, and returns `(format!("http://{addr}"), handle)`.

**Call relations**: All positive-path tests in this file call this helper to provide the MCP endpoint referenced from `config.toml`.

*Call graph*: called by 4 (mcp_server_tool_call_forwards_url_elicitation, mcp_server_tool_call_returns_tool_result, mcp_server_tool_call_round_trips_elicitation, mcp_tool_call_completion_notification_contains_truncated_large_result); 9 external calls (new, default, new, default, new, bind, serve, format!, spawn).


##### `wait_for_mcp_tool_call_completed`  (lines 685–703)

```
async fn wait_for_mcp_tool_call_completed(
    mcp: &mut TestAppServer,
    call_id: &str,
) -> Result<ItemCompletedNotification>
```

**Purpose**: Filters asynchronous `item/completed` notifications until it finds the completed MCP tool call with the requested call id.

**Data flow**: It takes a mutable `TestAppServer` and target `call_id`, repeatedly waits for `item/completed` notifications under `DEFAULT_READ_TIMEOUT`, skips notifications without params, deserializes params into `ItemCompletedNotification`, and returns the first one whose `item` matches `ThreadItem::McpToolCall { id, .. }` with the requested id.

**Call relations**: Only the large-result truncation test uses this helper, because that scenario needs to observe the intermediate MCP tool completion item before the enclosing turn completes.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 1 (mcp_tool_call_completion_notification_contains_truncated_large_result); 3 external calls (matches!, from_value, timeout).


### `app-server/tests/suite/v2/mcp_server_elicitation.rs`

`test` · `request handling`

This file simulates the full path from model tool invocation to MCP server elicitation and back. The main test mounts a mock responses server that first performs a warmup turn, then emits a function call into the connector namespace `mcp__codex_apps__calendar`, and finally completes after the tool result is returned. `start_apps_server` launches an Axum app with two connector-directory endpoints plus an RMCP service under `/api/codex/ps/mcp`; the directory endpoints validate bearer auth, `chatgpt-account-id`, and the `external_logos=true` query parameter before returning a single enabled connector. The MCP implementation, `ElicitationAppsMcpServer`, advertises tools, returns one read-only tool annotated with connector metadata, and in `call_tool` invokes `context.peer.create_elicitation` with a boolean form schema asking `Allow this request?`. The test writes config and auth, starts a thread, performs a warmup turn to load connectors, then starts a second turn that triggers the tool. It waits for a `ServerRequest::McpServerElicitationRequest`, verifies the exact `McpServerElicitationRequestParams` including thread id, turn id, server name, message, and schema, sends an accept response with `{ "confirmed": true }`, and then enforces notification ordering: `serverRequest/resolved` must arrive before `turn/completed`. Finally it inspects the model request stream to confirm the tool output was wrapped as wall-time-prefixed text containing a JSON array with a single `accepted` text content item.

#### Function details

##### `mcp_server_elicitation_round_trip`  (lines 76–300)

```
async fn mcp_server_elicitation_round_trip() -> Result<()>
```

**Purpose**: Runs a full integration test proving that an MCP server’s elicitation request is surfaced to the client, answered, resolved, and fed back into the model/tool flow.

**Data flow**: It starts a mock responses server with three SSE exchanges, launches the mock apps/MCP server, writes config and ChatGPT auth into a temporary Codex home, starts `TestAppServer`, creates a thread, performs a warmup turn and validates its completion notification, then starts a second turn whose model response triggers the connector tool. It waits for a `McpServerElicitationRequest`, constructs the expected boolean schema, asserts the request parameters, sends an accept response containing `{confirmed: true}`, loops over subsequent JSON-RPC notifications until it sees `serverRequest/resolved` followed by `turn/completed`, and finally inspects the captured model requests to verify the tool output payload equals a JSON text-content array containing `accepted`.

**Call relations**: This is the file’s top-level integration test. It depends on `start_apps_server` and `write_config_toml` for environment setup, and on the `ElicitationAppsMcpServer` implementation plus connector-directory route to make the app server discover and invoke the MCP tool.

*Call graph*: calls 6 internal fn (new, new, start_apps_server, write_config_toml, mount_sse_sequence, start_mock_server); 18 external calls (new, default, builder, Boolean, new, Integer, to_response, write_chatgpt_auth, assert!, assert_eq! (+8 more)).


##### `ElicitationAppsMcpServer::get_info`  (lines 312–315)

```
fn get_info(&self) -> ServerInfo
```

**Purpose**: Advertises the mock MCP server as tool-capable and using the 2025-06-18 protocol version.

**Data flow**: It builds `ServerInfo` from tool-enabled `ServerCapabilities` and sets the protocol version to `rmcp::model::ProtocolVersion::V_2025_06_18`.

**Call relations**: The RMCP transport calls this during capability negotiation so the app server can inventory tools from this mock server.

*Call graph*: 2 external calls (builder, new).


##### `ElicitationAppsMcpServer::list_tools`  (lines 317–347)

```
async fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, rmcp::ErrorData>
```

**Purpose**: Returns a single read-only connector-backed tool with connector metadata attached.

**Data flow**: It constructs an empty-object `JsonObject` schema from JSON, creates a `Tool` named `calendar_confirm_action` with description `Confirm a calendar action.`, marks it read-only via `ToolAnnotations`, inserts `connector_id` and `connector_name` into `Meta`, assigns that metadata to the tool, and returns `ListToolsResult` containing the one tool and no pagination cursor.

**Call relations**: The app server calls this while discovering tools for the `codex_apps` MCP server. The metadata it attaches is what lets the app server map the tool into the connector namespace used by the model.

*Call graph*: 8 external calls (new, Borrowed, new, new, json!, new, from_value, vec!).


##### `ElicitationAppsMcpServer::call_tool`  (lines 349–384)

```
async fn call_tool(
        &self,
        _request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, rmcp::ErrorData>
```

**Purpose**: Implements the mock tool by requesting a form elicitation from the peer and converting the user’s decision into a text result.

**Data flow**: It ignores the incoming tool arguments, builds an `ElicitationSchema` requiring a boolean `confirmed` property, calls `context.peer.create_elicitation` with message `Allow this request?`, maps transport errors into RMCP internal errors, then matches on the returned `ElicitationAction`. On `Accept` it asserts the returned content equals `{ "confirmed": true }` and chooses `accepted`; on `Decline` or `Cancel` it chooses corresponding strings. It returns `CallToolResult::success` with one text `Content` item containing that output.

**Call relations**: This method is invoked by the app server after the model selects the connector tool. Its elicitation request is what the main test expects to receive as a `ServerRequest::McpServerElicitationRequest`.

*Call graph*: 6 external calls (new, builder, Boolean, assert_eq!, success, vec!).


##### `start_apps_server`  (lines 387–416)

```
async fn start_apps_server() -> Result<(String, JoinHandle<()>)>
```

**Purpose**: Starts the combined mock apps HTTP server and MCP endpoint used by the elicitation test.

**Data flow**: It creates shared `AppsServerState` containing the expected bearer token and account id, binds a random localhost port, constructs a `StreamableHttpService` that instantiates `ElicitationAppsMcpServer`, builds an Axum router with connector-directory routes and the MCP service nested under `/api/codex/ps/mcp`, spawns `axum::serve`, and returns the base URL plus task handle.

**Call relations**: The main test calls this once to provide both connector discovery endpoints and the MCP tool endpoint. It wires `list_directory_connectors` and `ElicitationAppsMcpServer` into one server.

*Call graph*: called by 1 (mcp_server_elicitation_round_trip); 10 external calls (new, default, new, default, new, bind, get, serve, format!, spawn).


##### `list_directory_connectors`  (lines 418–458)

```
async fn list_directory_connectors(
    State(state): State<Arc<AppsServerState>>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Json<serde_json::Value>, StatusCode>
```

**Purpose**: Mocks the apps connector-directory API and validates auth/query requirements before returning the calendar connector.

**Data flow**: It receives shared `AppsServerState`, request headers, and URI; checks that `Authorization` matches the expected bearer token, `chatgpt-account-id` matches the expected account id, and the query string contains `external_logos=true`. If auth fails it returns `UNAUTHORIZED`; if the query flag is missing it returns `BAD_REQUEST`; otherwise it returns JSON describing one enabled but inaccessible connector with id `calendar` and name `Calendar`.

**Call relations**: The app server calls this during connector warmup/discovery before it can expose the MCP tool to the model. The main test’s warmup turn implicitly exercises this route.

*Call graph*: 4 external calls (get, query, Json, json!).


##### `write_config_toml`  (lines 460–489)

```
fn write_config_toml(
    codex_home: &std::path::Path,
    responses_server_uri: &str,
    apps_server_url: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes the minimal app-server configuration needed for the elicitation integration test.

**Data flow**: It takes `codex_home`, the mock responses server URI, and the apps server URL, formats a TOML string containing model/provider settings, `chatgpt_base_url`, file-based MCP OAuth credential storage, apps feature enablement, and mock provider response endpoints, and writes it to `codex_home/config.toml`.

**Call relations**: The main test calls this before writing auth and starting `TestAppServer`, ensuring the app server points at both the mock model backend and the mock apps/MCP server.

*Call graph*: called by 1 (mcp_server_elicitation_round_trip); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/mcp_resource.rs`

`test` · `request handling`

This file covers two related behaviors: direct `mcp/resource/read` RPCs and the app server’s use of MCP resources to expose orchestrator skills to the model. It defines a miniature HTTP MCP server, `ResourceAppsMcpServer`, backed by `ResourceAppsMcpCalls` counters so tests can assert how many times resources were listed or read. The server advertises resource capability, returns paginated resource listings with one ignored non-skill resource, one valid `mcp/skill` resource, and then a simulated later-page failure, and serves either the main skill prompt, a referenced skill document, or a generic test resource containing both text and blob contents. Helper functions write a full `config.toml`, auth fixture, and launch both the app server and the MCP server. The tests verify: direct resource reads with and without a thread; an unknown-thread error path using the in-process app server startup API; orchestrator skill discovery and repeated `skills.read` behavior without an executor; cache behavior across MCP reloads; and the absence of orchestrator skills when using a local executor. Important details include HTML-escaped skill descriptions, preservation of `skill://` URIs in prompts, warning propagation when later resource pages fail, and call-count assertions proving referenced resources are cached while main prompts are re-read after MCP reload.

#### Function details

##### `mcp_resource_read_returns_resource_contents`  (lines 87–128)

```
async fn mcp_resource_read_returns_resource_contents() -> Result<()>
```

**Purpose**: Verifies that reading a known MCP resource within a thread returns the expected text and blob contents.

**Data flow**: It starts a mock responses server, launches the resource MCP server, writes app-server config via `start_resource_test_app_server`, creates a thread, sends `McpResourceReadParams` with that thread id, server `codex_apps`, and `TEST_RESOURCE_URI`, waits for the response, decodes it to `McpResourceReadResponse`, and compares it to `expected_resource_read_response()`. It then aborts and joins the MCP server task.

**Call relations**: This is the simplest positive-path resource-read test. It depends on both startup helpers and the shared expected-response constructor, but does not exercise orchestrator skill discovery.

*Call graph*: calls 3 internal fn (start_resource_apps_mcp_server, start_resource_test_app_server, start_mock_server); 5 external calls (default, Integer, to_response, assert_eq!, timeout).


##### `orchestrator_skill_can_read_referenced_resource_without_an_executor`  (lines 131–364)

```
async fn orchestrator_skill_can_read_referenced_resource_without_an_executor() -> Result<()>
```

**Purpose**: Exercises orchestrator skill discovery and referenced-resource reading when no executor environments are configured, including cache and reload behavior.

**Data flow**: It starts mock model and MCP servers, creates a thread with `environments: Some(Vec::new())`, mounts a sequence of SSE model responses that first call `skills.list`, then `skills.read` twice, then complete two assistant turns, and starts a turn asking to use the orchestrator skill. After the turn completes, it inspects captured model requests to verify tool availability, developer-message catalog content, escaped descriptions, absence of ignored skills, inclusion of anti-filesystem guidance for `skill://` URIs, and injected `<skill>` user fragments containing the main prompt and reference URI. It also parses function-call outputs for `skills.list` and repeated `skills.read`, checks warning text from paginated listing failure, asserts repeated reads return identical cached output, verifies MCP call counters, reloads MCP config, runs another turn, and confirms list/main-prompt reads increase while reference reads remain cached.

**Call relations**: This is the file’s most comprehensive integration test. It drives the app server, mock model server, and mock MCP server together, then validates both prompt construction and MCP-side call counts before and after `config/mcpServer/reload`.

*Call graph*: calls 4 internal fn (start_resource_apps_mcp_server, start_resource_test_app_server, mount_sse_sequence, start_mock_server); 9 external calls (default, new, Integer, to_response, assert!, assert_eq!, format!, timeout, vec!).


##### `local_executor_does_not_expose_orchestrator_skills`  (lines 367–437)

```
async fn local_executor_does_not_expose_orchestrator_skills() -> Result<()>
```

**Purpose**: Confirms that orchestrator skills are not surfaced to the model when the thread uses the default local executor path.

**Data flow**: It starts the mock model and MCP servers, creates a thread with default parameters, mounts a single assistant-only SSE response, starts a turn asking to use the orchestrator skill, waits for completion, then inspects the single captured model request to ensure no `skills.list` or `skills.read` tools were exposed and neither developer nor user messages contain the orchestrator skill name or marker text.

**Call relations**: This test contrasts with the previous orchestrator-skill case by keeping executor settings at defaults, proving the app server gates orchestrator skill exposure on execution context.

*Call graph*: calls 5 internal fn (start_resource_apps_mcp_server, start_resource_test_app_server, mount_sse_once, sse, start_mock_server); 6 external calls (default, Integer, to_response, assert!, timeout, vec!).


##### `mcp_resource_read_returns_resource_contents_without_thread`  (lines 440–490)

```
async fn mcp_resource_read_returns_resource_contents_without_thread() -> Result<()>
```

**Purpose**: Verifies that `mcp/resource/read` can succeed without a thread id when the server is configured with apps support and auth.

**Data flow**: It starts the resource MCP server, manually writes a minimal `config.toml` enabling apps and pointing `chatgpt_base_url` at the MCP server, writes file-based ChatGPT auth credentials, starts and initializes `TestAppServer`, sends `McpResourceReadParams` with `thread_id: None`, waits for the response, decodes it to `McpResourceReadResponse`, and compares it to `expected_resource_read_response()`. It then shuts down the MCP server task.

**Call relations**: This positive-path test bypasses the shared app-server startup helper to prove threadless resource reads work with only the minimal config and auth prerequisites.

*Call graph*: calls 3 internal fn (new, new, start_resource_apps_mcp_server); 7 external calls (new, Integer, write_chatgpt_auth, assert_eq!, format!, write, timeout).


##### `mcp_resource_read_returns_error_for_unknown_thread`  (lines 493–553)

```
async fn mcp_resource_read_returns_error_for_unknown_thread() -> Result<()>
```

**Purpose**: Checks that the app server rejects resource reads that reference a nonexistent thread id.

**Data flow**: It creates a temporary Codex home, builds config with `ConfigBuilder` and test loader overrides, starts the app server in-process with explicit `InProcessStartArgs`, sends a `ClientRequest::McpResourceRead` containing a fixed nonexistent UUID thread id, awaits the result, shuts down the client, and asserts the returned error message contains `thread not found` rather than a success payload.

**Call relations**: Unlike the other tests, this one uses `codex_app_server::in_process::start` instead of the stdio-based `TestAppServer` to avoid subprocess teardown issues in a negative-path case.

*Call graph*: calls 5 internal fn (start, default, without_managed_config_for_tests, default_for_tests, new); 8 external calls (new, new, new, bail!, Integer, default, assert!, default).


##### `start_resource_test_app_server`  (lines 555–599)

```
async fn start_resource_test_app_server(
    apps_server_url: &str,
    responses_server_uri: &str,
) -> Result<(TempDir, TestAppServer)>
```

**Purpose**: Creates a temporary Codex home configured for apps, skills, and the mock model provider, writes auth, and returns an initialized `TestAppServer`.

**Data flow**: It takes the apps MCP server URL and mock responses server URI, creates a `TempDir`, writes a full `config.toml` containing model/provider settings, apps enablement, skills instruction inclusion, and the mock provider base URL, writes file-based ChatGPT auth credentials, starts `TestAppServer`, waits for initialization, and returns `(TempDir, TestAppServer)`.

**Call relations**: The thread-based resource and orchestrator-skill tests call this helper to avoid duplicating config and auth setup. It encapsulates all app-server bootstrap work needed for those scenarios.

*Call graph*: calls 2 internal fn (new, new); called by 3 (local_executor_does_not_expose_orchestrator_skills, mcp_resource_read_returns_resource_contents, orchestrator_skill_can_read_referenced_resource_without_an_executor); 5 external calls (new, write_chatgpt_auth, format!, write, timeout).


##### `start_resource_apps_mcp_server`  (lines 601–624)

```
async fn start_resource_apps_mcp_server() -> Result<(String, Arc<ResourceAppsMcpCalls>, JoinHandle<()>)>
```

**Purpose**: Launches the local HTTP MCP server used by the tests and returns its base URL, shared call counters, and task handle.

**Data flow**: It binds a random localhost TCP port, formats the base URL, creates an `Arc<ResourceAppsMcpCalls>`, clones that state into a `StreamableHttpService` factory that constructs `ResourceAppsMcpServer`, nests the service under `/api/codex/ps/mcp` in an Axum router, spawns `axum::serve`, and returns `(String, Arc<ResourceAppsMcpCalls>, JoinHandle<()>)`.

**Call relations**: All tests that need an MCP resource server call this helper. It wires the `ResourceAppsMcpServer` implementation into an actual HTTP endpoint and exposes counters for later assertions.

*Call graph*: called by 4 (local_executor_does_not_expose_orchestrator_skills, mcp_resource_read_returns_resource_contents, mcp_resource_read_returns_resource_contents_without_thread, orchestrator_skill_can_read_referenced_resource_without_an_executor); 11 external calls (clone, new, default, new, default, new, bind, default, serve, format! (+1 more)).


##### `expected_resource_read_response`  (lines 626–643)

```
fn expected_resource_read_response() -> McpResourceReadResponse
```

**Purpose**: Builds the exact `McpResourceReadResponse` expected from reading the test resource.

**Data flow**: It returns a `McpResourceReadResponse` containing two `McpResourceContent` entries: a text resource for `TEST_RESOURCE_URI` with markdown MIME type and `TEST_RESOURCE_TEXT`, and a blob resource for `TEST_BLOB_RESOURCE_URI` with octet-stream MIME type and `TEST_RESOURCE_BLOB`.

**Call relations**: Both successful resource-read tests use this helper as the canonical expected payload, keeping assertions aligned with the mock MCP server’s `read_resource` implementation.

*Call graph*: 1 external calls (vec!).


##### `ResourceAppsMcpCalls::snapshot`  (lines 653–659)

```
fn snapshot(&self) -> ResourceAppsMcpCallCounts
```

**Purpose**: Reads the current MCP server call counters into a plain comparable struct.

**Data flow**: It loads `list_resources`, `main_prompt_reads`, and `reference_reads` atomics with relaxed ordering and returns them as a `ResourceAppsMcpCallCounts` value.

**Call relations**: The orchestrator-skill test calls this after turns and after MCP reload to assert exactly which MCP operations were repeated and which were cached.

*Call graph*: 1 external calls (load).


##### `ResourceAppsMcpServer::get_info`  (lines 675–678)

```
fn get_info(&self) -> ServerInfo
```

**Purpose**: Advertises this mock server as an MCP server that supports resources and uses the 2025-06-18 protocol version.

**Data flow**: It constructs `ServerInfo` from `ServerCapabilities::builder().enable_resources().build()` and then sets the protocol version to `ProtocolVersion::V_2025_06_18`.

**Call relations**: The RMCP transport invokes this during server handshake/capability discovery so the app server knows resource APIs are available.

*Call graph*: 2 external calls (builder, new).


##### `ResourceAppsMcpServer::list_resources`  (lines 680–726)

```
async fn list_resources(
        &self,
        request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, rmcp::ErrorData>
```

**Purpose**: Returns paginated mock resource listings that include one ignored resource, one valid skill resource, and a simulated later-page failure.

**Data flow**: It increments the `list_resources` counter, extracts an optional cursor from the request, and branches on cursor value. With no cursor it returns a non-skill `text/plain` resource plus `next_cursor = Some("skills-page")`; with `skills-page` it returns the real skill resource plus `next_cursor = Some("failing-page")`; with `failing-page` it returns an internal error; with any other cursor it returns invalid-params. Each resource is built via `skill_resource`.

**Call relations**: The app server calls this while discovering orchestrator skills. The orchestrator-skill test relies on its pagination and failure behavior to verify warning propagation and partial discovery.

*Call graph*: 3 external calls (internal_error, invalid_params, vec!).


##### `ResourceAppsMcpServer::read_resource`  (lines 728–777)

```
async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResult, rmcp::ErrorData>
```

**Purpose**: Serves either the skill main prompt, the referenced skill document, or the generic test resource, and errors on unknown URIs.

**Data flow**: It reads `request.uri` and branches: for `SKILL_MAIN_PROMPT_URI` it increments `main_prompt_reads` and returns one markdown text resource containing `SKILL_CONTENTS`; for `SKILL_REFERENCE_URI` it increments `reference_reads` and returns one markdown text resource containing `SKILL_REFERENCE_CONTENTS`; for `TEST_RESOURCE_URI` it returns both the text and blob test resources; otherwise it returns `resource_not_found` with the missing URI in the message.

**Call relations**: Direct resource-read tests hit the `TEST_RESOURCE_URI` branch, while orchestrator-skill tests trigger the skill prompt and reference branches. Counter increments feed later cache assertions.

*Call graph*: 4 external calls (new, format!, resource_not_found, vec!).


##### `skill_resource`  (lines 780–795)

```
fn skill_resource(
    uri: &str,
    name: &str,
    description: &str,
    mime_type: &str,
    plugin_name: &str,
    skill_name: &str,
) -> Resource
```

**Purpose**: Constructs an RMCP `Resource` with description, MIME type, and skill-identifying metadata.

**Data flow**: It takes URI, display name, description, MIME type, plugin name, and skill name; builds a `RawResource`, attaches description and MIME type, adds metadata from `skill_resource_meta`, wraps it in `Resource::new`, and returns the result.

**Call relations**: The mock server’s `list_resources` method uses this helper for both the ignored resource and the valid skill resource so metadata formatting stays consistent.

*Call graph*: calls 1 internal fn (skill_resource_meta); 2 external calls (new, new).


##### `skill_resource_meta`  (lines 797–802)

```
fn skill_resource_meta(plugin_name: &str, skill_name: &str) -> Meta
```

**Purpose**: Builds the metadata map that tags a resource with plugin and skill names.

**Data flow**: It takes `plugin_name` and `skill_name`, creates a `serde_json::Map` from two key/value pairs using `json!`, wraps it in `Meta`, and returns it.

**Call relations**: Only `skill_resource` calls this helper. The resulting metadata is what lets the app server interpret listed resources as MCP skills.

*Call graph*: called by 1 (skill_resource); 3 external calls (json!, Meta, from_iter).


### Command and shell execution
These tests validate the app server's command-execution surfaces, including generic command RPCs, thread shell commands, and the specialized zsh-fork turn-start path.

### `app-server/tests/suite/v2/command_exec.rs`

`test` · `request handling`

This file is a broad end-to-end test suite for command execution over the app-server’s MCP/JSON-RPC interface. Most tests build an isolated `config.toml` with `create_config_toml`, start `TestAppServer`, initialize it, then issue `CommandExecParams` requests with different combinations of `process_id`, `tty`, stdin/stdout streaming flags, output caps, timeout controls, cwd, env overrides, sandbox policy, and permission profile. Successful cases deserialize `CommandExecResponse`; invalid combinations instead read JSON-RPC errors and assert exact messages.

A major theme is the distinction between buffered compatibility mode and connection-scoped streaming mode. Without a client-supplied `process_id`, the server must buffer stdout/stderr into the final response and reject streaming/TTY. With a `process_id`, tests verify output-delta notifications, stdin writes via base64 payloads, PTY resize support, output-cap truncation semantics, and explicit termination. The suite also checks environment merge rules, including request-level overrides and unsetting inherited variables, plus permission-profile effects such as network proxy activation and project-root resolution relative to command cwd.

Helper code centralizes notification decoding and polling. `collect_command_exec_output_until` reads MCP or websocket notifications until a predicate over accumulated stdout/stderr and the latest `CommandExecOutputDeltaNotification` succeeds, decoding base64 and normalizing CRLF by stripping `\r`. Additional helpers splice TOML snippets into the generated config, wait for websocket initialization responses, and poll `ps -axo command` for marker processes to prove connection-scoped process cleanup after disconnect.

#### Function details

##### `command_exec_without_streams_can_be_terminated`  (lines 41–88)

```
async fn command_exec_without_streams_can_be_terminated() -> Result<()>
```

**Purpose**: Verifies a non-streaming command started with a `process_id` can be terminated through `command/exec/terminate`, and that the final command response reports failure with empty buffered output. It checks termination behavior even when stdout/stderr streaming is disabled.

**Data flow**: Creates a mock responses server and config, starts and initializes `TestAppServer`, sends `CommandExecParams` for `sh -lc 'sleep 30'` with `process_id = Some("sleep-1")`, then sends `CommandExecTerminateParams` for the same id. It reads the terminate response and asserts an empty JSON object result, then reads the original command response, deserializes it to `CommandExecResponse`, and asserts nonzero `exit_code` plus empty `stdout` and `stderr`.

**Call relations**: Run by the Tokio test harness after setup. It drives the server through `send_command_exec_request` and `send_command_exec_terminate_request`, then relies on `to_response` only for the final command result because the terminate RPC is expected to return a raw empty-object JSON-RPC success.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, assert_ne!, timeout, vec!).


##### `command_exec_without_process_id_keeps_buffered_compatibility`  (lines 91–135)

```
async fn command_exec_without_process_id_keeps_buffered_compatibility() -> Result<()>
```

**Purpose**: Checks the legacy buffered mode remains available when no `process_id` is supplied. The server should collect stdout and stderr and return them in the final `CommandExecResponse`.

**Data flow**: Starts a configured test server, sends a shell command that prints `legacy-out` to stdout and `legacy-err` to stderr with `process_id: None` and all streaming disabled, then reads the matching response. It deserializes to `CommandExecResponse` and compares the whole struct against the expected exit code and buffered output strings.

**Call relations**: This test is invoked directly by the test runner. It follows the standard initialize → send request → read response path and uses `to_response` to validate the compatibility contract for non-streaming execution.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, timeout, vec!).


##### `command_exec_env_overrides_merge_with_server_environment_and_support_unset`  (lines 138–194)

```
async fn command_exec_env_overrides_merge_with_server_environment_and_support_unset() -> Result<()>
```

**Purpose**: Validates that request-level environment overrides are merged on top of the app-server process environment and that `None` values remove inherited variables. It also confirms `CODEX_HOME` remains available to the child process.

**Data flow**: Starts `TestAppServer::new_with_env` with `COMMAND_EXEC_BASELINE=server`, then sends a shell command that prints four environment-derived fields separated by `|`. The request `env` map overrides `COMMAND_EXEC_BASELINE` to `request`, adds `COMMAND_EXEC_EXTRA=added`, and unsets `RUST_LOG` by assigning `None`; after reading and deserializing the response, the test asserts stdout equals `request|added|unset|<codex_home>` and stderr is empty.

**Call relations**: The test harness invokes it as an integration test. It depends on `new_with_env` to seed the server environment and then uses the command itself as an observable probe of the merge/unset logic implemented by the server.

*Call graph*: calls 2 internal fn (new_with_env, create_config_toml); 9 external calls (from, new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, timeout, vec!).


##### `command_exec_accepts_permission_profile`  (lines 197–241)

```
async fn command_exec_accepts_permission_profile() -> Result<()>
```

**Purpose**: Confirms that a built-in permission profile name can be supplied on `command/exec` without causing validation failure. The test uses a trivial command to prove the request executes successfully under that profile.

**Data flow**: Creates config and server, initializes, sends `CommandExecParams` with `permission_profile: Some(BUILT_IN_PERMISSION_PROFILE_READ_ONLY.to_string())` and a shell command that prints `profile`, then reads and deserializes the response. It asserts exit code 0, stdout `profile`, and empty stderr.

**Call relations**: This test is called by the Tokio harness and follows the standard request/response path. It specifically exercises the permission-profile branch rather than sandbox-policy handling, which is covered by separate rejection tests.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, timeout, vec!).


##### `command_exec_permission_profile_starts_selected_network_proxy`  (lines 244–292)

```
async fn command_exec_permission_profile_starts_selected_network_proxy() -> Result<()>
```

**Purpose**: Checks that selecting a permission profile with network access enabled causes the command environment to indicate an active network proxy. It proves the chosen profile can start its own proxy instance.

**Data flow**: After writing base config, it injects a `networked` permission profile via `insert_networked_permission_profile_config`, starts the server, and runs a shell command that prints `${CODEX_NETWORK_PROXY_ACTIVE-unset}` under `permission_profile: Some("networked")`. The final `CommandExecResponse` is deserialized and asserted to contain stdout `1` and empty stderr.

**Call relations**: The test runner invokes it; during setup it delegates TOML mutation to `insert_networked_permission_profile_config`. The command itself acts as the observable endpoint for whether the selected profile activated proxy-related environment state.

*Call graph*: calls 3 internal fn (new, insert_networked_permission_profile_config, create_config_toml); 8 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, timeout, vec!).


##### `command_exec_permission_profile_does_not_reuse_default_network_proxy`  (lines 295–340)

```
async fn command_exec_permission_profile_does_not_reuse_default_network_proxy() -> Result<()>
```

**Purpose**: Ensures a command using a different permission profile does not inherit or reuse the default network proxy configured for another profile. It guards against proxy leakage across profile selections.

**Data flow**: Writes config with `default_permissions = "networked"` plus the `networked` profile, starts the server, and executes a shell command that prints `${CODEX_NETWORK_PROXY_ACTIVE-unset}` while requesting the built-in read-only profile. It deserializes the response and asserts stdout is `unset`, proving no proxy was active for that command.

**Call relations**: This test is structurally similar to the previous network-profile test but flips the requested profile. It relies on `insert_networked_permission_profile_config` to create the default-profile scenario and then observes the child environment to verify isolation.

*Call graph*: calls 3 internal fn (new, insert_networked_permission_profile_config, create_config_toml); 8 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, timeout, vec!).


##### `command_exec_permission_profile_project_roots_use_command_cwd`  (lines 344–402)

```
async fn command_exec_permission_profile_project_roots_use_command_cwd() -> Result<()>
```

**Purpose**: Verifies that `:workspace_roots` in a permission profile is resolved relative to the command’s `cwd`, not the server’s own working directory. The test proves writes are allowed inside the command cwd but denied in the parent directory.

**Data flow**: On Unix, it creates a `command-cwd` subdirectory, writes a permission profile granting `:root` read and `:workspace_roots` write, starts the server, and runs a shell command from `cwd: Some("command-cwd")` that writes `child.txt` locally and attempts `../parent.txt` with a negated expectation. After deserializing the successful response, it reads `child.txt` to confirm content `child` and asserts `parent.txt` does not exist in the codex home.

**Call relations**: The test harness invokes it only on Unix. It depends on `insert_command_exec_config` to splice the profile into config and uses filesystem side effects after command completion to validate how the server computed project-root permissions.

*Call graph*: calls 3 internal fn (new, insert_command_exec_config, create_config_toml); 10 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert!, assert_eq!, create_dir, timeout, vec!).


##### `command_exec_returns_error_when_local_environment_is_disabled`  (lines 405–441)

```
async fn command_exec_returns_error_when_local_environment_is_disabled() -> Result<()>
```

**Purpose**: Checks that `command/exec` fails with a clear JSON-RPC error when the local execution environment is explicitly disabled. This protects the API contract for deployments without an exec server.

**Data flow**: Starts `TestAppServer::new_with_env` with `CODEX_EXEC_SERVER_URL_ENV_VAR=none`, initializes, sends a simple `true` command, then waits for the matching error message instead of a response. It asserts the error text is exactly `local environment is not configured`.

**Call relations**: Invoked by the test harness. It uses environment injection at server startup to force the disabled-local-environment branch and then reads an error message from the stream rather than deserializing a success payload.

*Call graph*: calls 2 internal fn (new_with_env, create_config_toml); 7 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, timeout, vec!).


##### `command_exec_rejects_sandbox_policy_with_permission_profile`  (lines 444–479)

```
async fn command_exec_rejects_sandbox_policy_with_permission_profile() -> Result<()>
```

**Purpose**: Verifies request validation rejects combining `permissionProfile` with `sandboxPolicy`. The server should fail fast before attempting execution.

**Data flow**: Starts and initializes the server, sends `CommandExecParams` containing both `sandbox_policy: Some(SandboxPolicy::DangerFullAccess)` and `permission_profile: Some(read_only)`, then reads the matching JSON-RPC error. It asserts the message states that `permissionProfile` cannot be combined with `sandboxPolicy`.

**Call relations**: This test is a pure validation-path check. It is invoked by the test runner and intentionally stops at the error read, without any command execution side effects.

*Call graph*: calls 2 internal fn (new, create_config_toml); 7 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, timeout, vec!).


##### `command_exec_rejects_disable_timeout_with_timeout_ms`  (lines 482–517)

```
async fn command_exec_rejects_disable_timeout_with_timeout_ms() -> Result<()>
```

**Purpose**: Checks that mutually exclusive timeout controls are rejected when both `disableTimeout` and `timeoutMs` are set. It enforces the request-shape invariant for command execution.

**Data flow**: Creates and initializes the server, sends a `sleep 1` command with `disable_timeout: true` and `timeout_ms: Some(1000)`, then reads the error for that request id. It asserts the exact validation message about not setting both fields.

**Call relations**: Called by the test harness as a negative test. It exercises only server-side parameter validation and does not wait for any command process lifecycle.

*Call graph*: calls 2 internal fn (new, create_config_toml); 7 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, timeout, vec!).


##### `command_exec_rejects_disable_output_cap_with_output_bytes_cap`  (lines 520–555)

```
async fn command_exec_rejects_disable_output_cap_with_output_bytes_cap() -> Result<()>
```

**Purpose**: Ensures the server rejects requests that simultaneously specify `outputBytesCap` and `disableOutputCap`. This preserves a single unambiguous output-cap policy per command.

**Data flow**: Starts the server, sends a `sleep 1` command with `output_bytes_cap: Some(1024)` and `disable_output_cap: true`, then reads the resulting JSON-RPC error. It asserts the message explicitly names the conflicting fields.

**Call relations**: This is another validation-only test invoked by the Tokio harness. It parallels the timeout-conflict test but for output-cap configuration.

*Call graph*: calls 2 internal fn (new, create_config_toml); 7 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, timeout, vec!).


##### `command_exec_rejects_negative_timeout_ms`  (lines 558–593)

```
async fn command_exec_rejects_negative_timeout_ms() -> Result<()>
```

**Purpose**: Verifies negative timeout values are rejected with a descriptive error. It guards the numeric validation path for `timeoutMs`.

**Data flow**: Initializes the server, sends a command with `timeout_ms: Some(-1)`, waits for the error response, and asserts the message includes the invalid value. No command response is expected because validation should fail before execution.

**Call relations**: Invoked directly by the test runner. It complements the timeout-conflict test by checking scalar-range validation rather than field exclusivity.

*Call graph*: calls 2 internal fn (new, create_config_toml); 7 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, timeout, vec!).


##### `command_exec_without_process_id_rejects_streaming`  (lines 596–631)

```
async fn command_exec_without_process_id_rejects_streaming() -> Result<()>
```

**Purpose**: Checks that streaming or TTY execution requires a client-supplied `processId`. This preserves the server’s compatibility mode semantics for requests without process tracking.

**Data flow**: Starts the server, sends a `cat` command with `process_id: None` and `stream_stdout_stderr: true`, then reads the JSON-RPC error. It asserts the message says tty or streaming requires a client-supplied process id.

**Call relations**: This negative test is run by the harness and targets the validation gate between buffered compatibility mode and tracked streaming mode.

*Call graph*: calls 2 internal fn (new, create_config_toml); 7 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, timeout, vec!).


##### `command_exec_non_streaming_respects_output_cap`  (lines 634–678)

```
async fn command_exec_non_streaming_respects_output_cap() -> Result<()>
```

**Purpose**: Verifies buffered stdout and stderr are truncated independently to the configured byte cap in non-streaming mode. It checks the final response contains only capped prefixes.

**Data flow**: Runs a shell command that prints six bytes to stdout and six to stderr with `output_bytes_cap: Some(5)` and no streaming, then reads and deserializes the final `CommandExecResponse`. It asserts stdout is `abcde`, stderr is `uvwxy`, and exit code is 0.

**Call relations**: The test harness invokes it as a successful execution case. It uses the final buffered response rather than output-delta notifications to validate cap behavior in non-streaming mode.

*Call graph*: calls 2 internal fn (new, create_config_toml); 8 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, timeout, vec!).


##### `command_exec_streaming_does_not_buffer_output`  (lines 681–742)

```
async fn command_exec_streaming_does_not_buffer_output() -> Result<()>
```

**Purpose**: Checks that when stdout/stderr are streamed, output is delivered via delta notifications and not buffered into the final response. It also verifies cap-reached signaling on streamed output.

**Data flow**: Starts a long-running command that prints `abcdefghij` then sleeps, with `process_id`, streaming enabled, and `output_bytes_cap: Some(5)`. It calls `collect_command_exec_output_until` with an MCP reader and a predicate that stops on a stdout delta whose `cap_reached` flag is true, asserts collected stdout is `abcde`, terminates the process, confirms the terminate RPC returns `{}`, then reads the final `CommandExecResponse` and asserts nonzero exit code with empty buffered stdout/stderr.

**Call relations**: This test is driven by the harness and delegates notification accumulation to `collect_command_exec_output_until`. It demonstrates the intended split between streamed deltas during execution and empty final buffers after a streaming session.

*Call graph*: calls 3 internal fn (new, collect_command_exec_output_until, create_config_toml); 10 external calls (new, new, Integer, Mcp, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, assert_ne!, timeout, vec!).


##### `command_exec_pipe_streams_output_and_accepts_write`  (lines 745–818)

```
async fn command_exec_pipe_streams_output_and_accepts_write() -> Result<()>
```

**Purpose**: Exercises pipe-based interactive execution with streamed stdout/stderr and explicit stdin writes. It proves the server can forward initial output, accept base64-encoded input, close stdin, and continue streaming subsequent output.

**Data flow**: Starts a shell command that emits startup lines to stdout/stderr, reads one line from stdin, then echoes that line to both streams. The test waits for initial output using `wait_for_command_exec_outputs_contains`, sends `CommandExecWriteParams` with base64-encoded `hello\n` and `close_stdin: true`, asserts the write RPC returns `{}`, waits for echoed output on both streams, then reads the final `CommandExecResponse` and asserts exit code 0 with empty buffered output.

**Call relations**: Invoked by the test harness. It relies on `wait_for_command_exec_outputs_contains` to consume output-delta notifications before and after the write, and uses the write RPC as the midpoint of the interaction.

*Call graph*: calls 3 internal fn (new, wait_for_command_exec_outputs_contains, create_config_toml); 8 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, timeout, vec!).


##### `command_exec_tty_implies_streaming_and_reports_pty_output`  (lines 821–889)

```
async fn command_exec_tty_implies_streaming_and_reports_pty_output() -> Result<()>
```

**Purpose**: Verifies PTY mode implicitly enables streaming and that the child process sees a real terminal. It also checks stdin writes are delivered through the PTY and echoed output arrives on stdout deltas.

**Data flow**: Runs a shell command under `tty: true` that disables echo, prints `tty` if stdin is a terminal, reads a line, and prints `echo:<line>`. The test waits for stdout to contain `tty\n`, sends a base64-encoded `world\n` write with `close_stdin: true`, waits for stdout to contain `echo:world\n`, then reads the final `CommandExecResponse` and asserts exit code 0 with empty buffered stdout/stderr.

**Call relations**: This test is called by the harness and uses `wait_for_command_exec_output_contains` twice to observe PTY output. It demonstrates that TTY requests are treated as streaming sessions even when the explicit stream flags are false.

*Call graph*: calls 3 internal fn (new, wait_for_command_exec_output_contains, create_config_toml); 8 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, timeout, vec!).


##### `command_exec_tty_supports_initial_size_and_resize`  (lines 892–977)

```
async fn command_exec_tty_supports_initial_size_and_resize() -> Result<()>
```

**Purpose**: Checks PTY sessions honor an initial terminal size and can be resized during execution through `command/exec/resize`. The child process observes both dimensions via `stty size`.

**Data flow**: Starts a PTY command with initial `CommandExecTerminalSize { rows: 31, cols: 101 }` that prints `start:<size>`, waits for stdin, then prints `after:<size>`. The test waits for `start:31 101`, sends a resize request to `45x132` and asserts `{}` response, sends a stdin write `go\n` and closes stdin, waits for `after:45 132`, then reads the final `CommandExecResponse` and asserts success with empty buffered output.

**Call relations**: Invoked by the test harness. It uses `wait_for_command_exec_output_contains` around the resize and write RPCs to prove the PTY size change took effect before the command resumed.

*Call graph*: calls 3 internal fn (new, wait_for_command_exec_output_contains, create_config_toml); 8 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, timeout, vec!).


##### `command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process`  (lines 980–1062)

```
async fn command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process() -> Result<()>
```

**Purpose**: Verifies websocket-scoped process ownership: a `processId` started on one connection cannot be terminated from another, and disconnecting the owning connection kills the running process. It also proves loaded process state does not leak across websocket clients.

**Data flow**: Creates config and a unique marker string, spawns a websocket app-server, opens two websocket clients, initializes both, and sends `command/exec` from the first client with `processId = "shared-process"` and streaming enabled for a Python process that prints `ready` then sleeps. It collects output from ws1 until stdout contains `ready\n`, polls `ps` via `wait_for_process_marker` to confirm the process exists, sends `command/exec/terminate` from ws2 for the same process id, loops on `read_jsonrpc_message` until it finds the matching error, asserts the error says no active command exists for that process id, confirms the marker process still exists, asserts ws2 receives no extra messages, closes ws1, waits for the marker process to disappear, and finally kills the app-server process.

**Call relations**: This is the most orchestration-heavy test in the file. It depends on websocket helpers from `connection_handling_websocket`, uses `collect_command_exec_output_until` with a websocket reader to observe streamed output, and then uses `wait_for_process_marker` to tie websocket lifecycle to actual OS process cleanup.

*Call graph*: calls 10 internal fn (collect_command_exec_output_until, read_initialize_response, wait_for_process_marker, assert_no_message, connect_websocket, create_config_toml, read_jsonrpc_message, send_initialize_request, send_request, spawn_websocket_server); 9 external calls (from_millis, new, new, Integer, Websocket, create_mock_responses_server_sequence_unchecked, assert_eq!, format!, json!).


##### `read_command_exec_delta`  (lines 1064–1071)

```
async fn read_command_exec_delta(
    mcp: &mut TestAppServer,
) -> Result<CommandExecOutputDeltaNotification>
```

**Purpose**: Reads the next MCP notification for `command/exec/outputDelta` and deserializes it into the typed delta struct. It is the MCP-specific adapter used by the generic output collector.

**Data flow**: Takes `&mut TestAppServer`, waits for a notification message with method `command/exec/outputDelta`, then passes the resulting `JSONRPCNotification` to `decode_delta_notification`. It returns a `CommandExecOutputDeltaNotification` or an error if the notification is malformed.

**Call relations**: This helper is called only from `collect_command_exec_output_until` when the reader variant is `CommandExecDeltaReader::Mcp`. It isolates the MCP transport-specific read step from the shared accumulation logic.

*Call graph*: calls 2 internal fn (read_stream_until_notification_message, decode_delta_notification); called by 1 (collect_command_exec_output_until).


##### `wait_for_command_exec_output_contains`  (lines 1073–1094)

```
async fn wait_for_command_exec_output_contains(
    mcp: &mut TestAppServer,
    process_id: &str,
    stream: CommandExecOutputStream,
    expected: &str,
) -> Result<()>
```

**Purpose**: Waits until streamed output for a specific process contains a target substring on either stdout or stderr. It is a convenience wrapper around the generic collector for single-stream assertions.

**Data flow**: Accepts a mutable MCP server handle, process id, target `CommandExecOutputStream`, and expected substring. It builds a human-readable wait description, invokes `collect_command_exec_output_until` with an MCP reader and a predicate that checks the accumulated stdout or stderr string for the substring, discards the collected output, and returns `Ok(())` once the predicate succeeds.

**Call relations**: Used by the PTY tests to wait for specific stdout content before sending writes or asserting completion. It delegates all notification reading and accumulation to `collect_command_exec_output_until`.

*Call graph*: calls 1 internal fn (collect_command_exec_output_until); called by 2 (command_exec_tty_implies_streaming_and_reports_pty_output, command_exec_tty_supports_initial_size_and_resize); 2 external calls (Mcp, format!).


##### `wait_for_command_exec_outputs_contains`  (lines 1096–1112)

```
async fn wait_for_command_exec_outputs_contains(
    mcp: &mut TestAppServer,
    process_id: &str,
    stdout_expected: &str,
    stderr_expected: &str,
) -> Result<()>
```

**Purpose**: Waits until both stdout and stderr for a process contain specified substrings. It is the dual-stream counterpart to `wait_for_command_exec_output_contains`.

**Data flow**: Takes `&mut TestAppServer`, a process id, and expected stdout/stderr substrings, then calls `collect_command_exec_output_until` with an MCP reader and a predicate requiring both accumulated streams to contain their targets. It returns `Ok(())` after the condition is met.

**Call relations**: Called by the pipe-streaming test before and after stdin writes. It wraps the generic collector so tests can express a two-stream synchronization point without duplicating accumulation logic.

*Call graph*: calls 1 internal fn (collect_command_exec_output_until); called by 1 (command_exec_pipe_streams_output_and_accepts_write); 2 external calls (Mcp, format!).


##### `collect_command_exec_output_until`  (lines 1125–1167)

```
async fn collect_command_exec_output_until(
    mut reader: CommandExecDeltaReader<'_>,
    process_id: &str,
    waiting_for: impl Into<String>,
    mut should_stop: impl FnMut(
        &CollectedCom
```

**Purpose**: Continuously reads command-exec output deltas from either MCP or websocket transport, accumulates decoded stdout/stderr text, and stops when a caller-supplied predicate is satisfied. It is the central synchronization primitive for streaming command tests.

**Data flow**: Consumes a `CommandExecDeltaReader`, target `process_id`, a descriptive `waiting_for` label, and a mutable predicate over `CollectedCommandExecOutput` plus the latest `CommandExecOutputDeltaNotification`. It computes a deadline from `DEFAULT_READ_TIMEOUT`, loops reading the next delta via `read_command_exec_delta` or `read_command_exec_delta_ws` under a shrinking timeout, asserts the delta’s `process_id` matches, base64-decodes `delta_base64`, strips carriage returns, appends text to either `output.stdout` or `output.stderr` based on `delta.stream`, and returns the accumulated output once `should_stop` returns true; timeout errors include the collected output in context.

**Call relations**: This helper is called by multiple streaming tests and by the websocket connection-scoping test. It delegates transport-specific reads to `read_command_exec_delta` or `read_command_exec_delta_ws`, while callers provide the stopping condition that defines what output milestone they are waiting for.

*Call graph*: calls 2 internal fn (read_command_exec_delta, read_command_exec_delta_ws); called by 4 (command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process, command_exec_streaming_does_not_buffer_output, wait_for_command_exec_output_contains, wait_for_command_exec_outputs_contains); 6 external calls (now, into, from_utf8, default, assert_eq!, timeout).


##### `read_command_exec_delta_ws`  (lines 1169–1181)

```
async fn read_command_exec_delta_ws(
    stream: &mut super::connection_handling_websocket::WsClient,
) -> Result<CommandExecOutputDeltaNotification>
```

**Purpose**: Reads websocket JSON-RPC messages until it finds a `command/exec/outputDelta` notification, then deserializes it. It is the websocket-specific counterpart to `read_command_exec_delta`.

**Data flow**: Takes a mutable websocket client, loops on `read_jsonrpc_message`, ignores non-notification messages and notifications for other methods, and when it sees `command/exec/outputDelta` passes the `JSONRPCNotification` to `decode_delta_notification`. It returns the typed delta notification.

**Call relations**: Called only from `collect_command_exec_output_until` when the reader variant is `Websocket`. It lets the collector share the same accumulation logic across MCP and websocket transports.

*Call graph*: calls 2 internal fn (decode_delta_notification, read_jsonrpc_message); called by 1 (collect_command_exec_output_until).


##### `decode_delta_notification`  (lines 1183–1190)

```
fn decode_delta_notification(
    notification: JSONRPCNotification,
) -> Result<CommandExecOutputDeltaNotification>
```

**Purpose**: Deserializes a raw JSON-RPC notification into `CommandExecOutputDeltaNotification`, requiring that params be present. It centralizes the notification-shape validation used by both transports.

**Data flow**: Accepts a `JSONRPCNotification`, extracts `notification.params`, errors if params are missing, and runs `serde_json::from_value` to produce `CommandExecOutputDeltaNotification`. It returns the typed struct or a contextual deserialization error.

**Call relations**: Used by both `read_command_exec_delta` and `read_command_exec_delta_ws`. It is the shared final decoding step after transport-specific message selection.

*Call graph*: called by 2 (read_command_exec_delta, read_command_exec_delta_ws); 1 external calls (from_value).


##### `insert_networked_permission_profile_config`  (lines 1192–1215)

```
fn insert_networked_permission_profile_config(
    codex_home: &Path,
    default_permissions: Option<&str>,
) -> Result<()>
```

**Purpose**: Builds and inserts a TOML snippet defining a `networked` permission profile with filesystem read access and network proxy settings. It optionally prepends a `default_permissions` assignment.

**Data flow**: Takes the codex home path and an optional default-permissions profile name, formats a TOML string containing `[features] network_proxy = true`, `[permissions.networked.filesystem]`, and `[permissions.networked.network]` sections, then passes that string to `insert_command_exec_config`. It returns `Ok(())` after the config file is rewritten.

**Call relations**: Called by the two permission-profile network proxy tests during setup. It delegates the actual file splicing to `insert_command_exec_config` so those tests can focus on execution behavior.

*Call graph*: calls 1 internal fn (insert_command_exec_config); called by 2 (command_exec_permission_profile_does_not_reuse_default_network_proxy, command_exec_permission_profile_starts_selected_network_proxy); 1 external calls (format!).


##### `insert_command_exec_config`  (lines 1217–1227)

```
fn insert_command_exec_config(codex_home: &Path, inserted_config: &str) -> Result<()>
```

**Purpose**: Splices additional TOML content into the generated `config.toml` immediately before the mock provider table. It is a small file-editing helper for command-exec tests that need extra config sections.

**Data flow**: Reads `<codex_home>/config.toml` into a string, splits it once on the marker `\n[model_providers.mock_provider]\n`, formats a new config string as `prefix + inserted_config + marker + suffix`, and writes the result back to the same path. It errors if the marker table is missing.

**Call relations**: Used directly by the command-cwd permission-profile test and indirectly by `insert_networked_permission_profile_config`. It assumes the base config was created by `create_config_toml`, which always includes the mock provider marker.

*Call graph*: called by 2 (command_exec_permission_profile_project_roots_use_command_cwd, insert_networked_permission_profile_config); 4 external calls (join, format!, read_to_string, write).


##### `read_initialize_response`  (lines 1229–1241)

```
async fn read_initialize_response(
    stream: &mut super::connection_handling_websocket::WsClient,
    request_id: i64,
) -> Result<()>
```

**Purpose**: Consumes websocket JSON-RPC messages until it finds the initialize response for a specific request id. It is a minimal handshake helper for tests using raw websocket clients.

**Data flow**: Accepts a mutable websocket client and integer request id, loops on `read_jsonrpc_message`, and returns `Ok(())` once it sees a `JSONRPCMessage::Response` whose `id` equals `RequestId::Integer(request_id)`. Other messages are ignored.

**Call relations**: Called by the websocket-based process-scoping test after `send_initialize_request` on each connection. It delegates frame parsing to `read_jsonrpc_message` and exists because that test only needs to know initialization completed, not inspect the payload.

*Call graph*: calls 1 internal fn (read_jsonrpc_message); called by 1 (command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process); 1 external calls (Integer).


##### `wait_for_process_marker`  (lines 1243–1255)

```
async fn wait_for_process_marker(marker: &str, should_exist: bool) -> Result<()>
```

**Purpose**: Polls the OS process list until a marker string either appears or disappears, within a fixed timeout. It is used to prove whether a spawned command process is still alive.

**Data flow**: Takes a marker string and a boolean `should_exist`, computes a 5-second deadline, repeatedly calls `process_with_marker_exists`, and returns once the observed existence matches the expectation. If the deadline expires first, it constructs an error indicating the marker process did not appear or exit in time; between polls it sleeps for 50 ms.

**Call relations**: Used only by the websocket connection-scoping test. It delegates the actual `ps` invocation to `process_with_marker_exists` and turns that low-level probe into a timed wait primitive.

*Call graph*: calls 1 internal fn (process_with_marker_exists); called by 1 (command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process); 5 external calls (from_millis, from_secs, now, bail!, sleep).


##### `process_with_marker_exists`  (lines 1257–1264)

```
fn process_with_marker_exists(marker: &str) -> Result<bool>
```

**Purpose**: Checks whether any running process command line contains a given marker substring. It is the low-level OS probe behind process-lifecycle assertions.

**Data flow**: Runs `ps -axo command`, decodes `stdout` as UTF-8, scans each line for `line.contains(marker)`, and returns `true` if any match is found. It adds context if spawning `ps` or decoding its output fails.

**Call relations**: Called by `wait_for_process_marker` inside a polling loop. It is intentionally simple and platform-dependent, matching the Unix-oriented websocket process cleanup test that uses it.

*Call graph*: called by 1 (wait_for_process_marker); 2 external calls (from_utf8, new).


### `app-server/tests/suite/v2/thread_shell_command.rs`

`test` · `request handling, command execution, and history serialization`

This file covers user-initiated shell commands attached to threads. The tests create threads with `TestAppServer`, invoke `thread/shellCommand`, and then observe the resulting `item/started`, output-delta, and `item/completed` notifications for `ThreadItem::CommandExecution`. The first scenario runs a shell command in its own turn and verifies the command execution item reports `CommandExecutionSource::UserShell`, streams output, completes with exit code 0, and then disappears from all persisted-history views: `thread/read`, `thread/turns/list`, and `thread/fork` must all exclude command-execution items. That exclusion is enforced by the local `assert_no_command_executions` helper.

The second scenario disables the local execution environment by setting `CODEX_EXEC_SERVER_URL_ENV_VAR=none` and confirms `thread/shellCommand` returns a JSON-RPC error instead of attempting execution. The third scenario is more subtle: it starts an agent-driven turn that requests a shell command and blocks on approval, then issues a user shell command against the same thread. The test proves the user command is attached to the existing active turn rather than creating a separate turn, while still preserving the pending agent approval flow.

Helper functions make the asynchronous notification stream manageable. `current_shell_output_command` generates a portable shell command and expected newline convention based on `default_user_shell()`. The `wait_for_command_execution_*` helpers loop until they see the desired command-execution item by id or source, filtering out unrelated notifications. `create_config_toml` writes a configurable approval policy and feature flags into the test config so each scenario can precisely control trust and execution behavior.

#### Function details

##### `thread_shell_command_history_responses_exclude_persisted_command_executions`  (lines 47–181)

```
async fn thread_shell_command_history_responses_exclude_persisted_command_executions() -> Result<()>
```

**Purpose**: Runs a user shell command on a thread and verifies that command execution items are observable live but never returned in persisted thread-history APIs.

**Data flow**: It creates Codex home and workspace directories, writes config with approval policy `never`, starts a thread, derives a portable shell command and expected output via `current_shell_output_command`, sends `thread/shellCommand`, and parses the success response. It then waits for command-execution start, output delta, and completion notifications, asserting source `UserShell`, in-progress/completed status, aggregated output, and exit code. After `turn/completed`, it calls `thread/read`, `thread/turns/list`, and `thread/fork`, asserting each returned turn list contains no `ThreadItem::CommandExecution`.

**Call relations**: This is the file’s main persistence-visibility test. It relies on `wait_for_command_execution_started`, `wait_for_command_execution_output_delta`, `wait_for_command_execution_completed`, `current_shell_output_command`, and `assert_no_command_executions`.

*Call graph*: calls 7 internal fn (new, assert_no_command_executions, create_config_toml, current_shell_output_command, wait_for_command_execution_completed, wait_for_command_execution_output_delta, wait_for_command_execution_started); 11 external calls (default, default, new, Integer, default, create_mock_responses_server_sequence, assert_eq!, create_dir, timeout, unreachable! (+1 more)).


##### `thread_shell_command_returns_error_when_local_environment_is_disabled`  (lines 184–224)

```
async fn thread_shell_command_returns_error_when_local_environment_is_disabled() -> Result<()>
```

**Purpose**: Checks that explicit shell-command requests fail fast when the local execution environment is disabled.

**Data flow**: It writes config, initializes `TestAppServer` with `CODEX_EXEC_SERVER_URL_ENV_VAR` set to `none`, starts a thread, sends `thread/shellCommand` with `pwd`, reads the JSON-RPC error for that request id, and asserts the message is `local environment is not configured`.

**Call relations**: This negative test isolates environment-manager availability; unlike the other tests it never expects command-execution notifications because the request should be rejected before execution starts.

*Call graph*: calls 2 internal fn (new_with_env, create_config_toml); 9 external calls (default, new, Integer, default, create_mock_responses_server_sequence, assert_eq!, create_dir, timeout, vec!).


##### `thread_shell_command_uses_existing_active_turn`  (lines 227–377)

```
async fn thread_shell_command_uses_existing_active_turn() -> Result<()>
```

**Purpose**: Verifies that a user shell command issued while an agent turn is already active is attached to that existing turn rather than creating a separate one.

**Data flow**: It configures approval policy `untrusted`, starts a thread, computes a portable shell command, then starts a turn whose model output requests an agent shell command requiring approval. It waits for the agent command-execution item and approval request, then sends `thread/shellCommand` on the same thread. The test waits for a `UserShell` command-execution item, asserts its `turn_id` matches the active turn id and its aggregated output matches the expected shell output, then declines the pending agent approval, waits for `turn/completed`, and finally confirms `thread/read` still excludes command-execution items from persisted history.

**Call relations**: This test combines live agent-driven command execution with explicit user shell commands. It uses `wait_for_command_execution_started`, `wait_for_command_execution_started_by_source`, `wait_for_command_execution_completed`, `current_shell_output_command`, and `assert_no_command_executions` to distinguish the two command sources within one active turn.

*Call graph*: calls 7 internal fn (new, assert_no_command_executions, create_config_toml, current_shell_output_command, wait_for_command_execution_completed, wait_for_command_execution_started, wait_for_command_execution_started_by_source); 14 external calls (default, default, new, Integer, default, create_mock_responses_server_sequence, assert_eq!, panic!, from_value, to_value (+4 more)).


##### `assert_no_command_executions`  (lines 379–386)

```
fn assert_no_command_executions(items: &[ThreadItem], context: &str)
```

**Purpose**: Asserts that a slice of thread items contains no `ThreadItem::CommandExecution` entries.

**Data flow**: It iterates over the provided `items` slice, checks every item with `matches!`, and panics with the supplied context string if any command execution item is present.

**Call relations**: Used by both history-visibility tests to enforce the invariant that command executions are excluded from returned turns in read/list/fork responses.

*Call graph*: called by 2 (thread_shell_command_history_responses_exclude_persisted_command_executions, thread_shell_command_uses_existing_active_turn); 1 external calls (assert!).


##### `current_shell_output_command`  (lines 388–404)

```
fn current_shell_output_command(text: &str) -> Result<(String, String)>
```

**Purpose**: Builds a shell command that prints a given string and returns both the command text and the exact expected output for the current platform shell.

**Data flow**: It inspects `default_user_shell().name()` and chooses a PowerShell, `cmd`, or POSIX command form, quoting the text appropriately (`shlex::try_quote` on POSIX). It returns a tuple of command string and expected output string with the platform’s newline convention.

**Call relations**: Shared by the two positive shell-command tests so they can assert exact streamed and aggregated output regardless of the host shell.

*Call graph*: calls 1 internal fn (default_user_shell); called by 2 (thread_shell_command_history_responses_exclude_persisted_command_executions, thread_shell_command_uses_existing_active_turn); 2 external calls (format!, try_quote).


##### `wait_for_command_execution_started`  (lines 406–426)

```
async fn wait_for_command_execution_started(
    mcp: &mut TestAppServer,
    expected_id: Option<&str>,
) -> Result<ItemStartedNotification>
```

**Purpose**: Loops until it sees an `item/started` notification for a command-execution item, optionally matching a specific item id.

**Data flow**: It repeatedly reads `item/started` notifications from the server stream, deserializes each into `ItemStartedNotification`, filters out non-command-execution items, and returns the first matching notification whose id matches `expected_id` if one was supplied.

**Call relations**: This helper is used directly by both positive tests and indirectly by `wait_for_command_execution_started_by_source` to synchronize on live command execution startup.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 3 (thread_shell_command_history_responses_exclude_persisted_command_executions, thread_shell_command_uses_existing_active_turn, wait_for_command_execution_started_by_source); 1 external calls (from_value).


##### `wait_for_command_execution_started_by_source`  (lines 428–441)

```
async fn wait_for_command_execution_started_by_source(
    mcp: &mut TestAppServer,
    expected_source: CommandExecutionSource,
) -> Result<ItemStartedNotification>
```

**Purpose**: Finds the next started command-execution item whose `source` matches the requested `CommandExecutionSource`.

**Data flow**: It repeatedly calls `wait_for_command_execution_started` without an id filter, inspects the returned item’s `source`, and returns once the source equals `expected_source`.

**Call relations**: Used only by `thread_shell_command_uses_existing_active_turn` to distinguish the user-initiated shell command from the agent-initiated command execution already in flight.

*Call graph*: calls 1 internal fn (wait_for_command_execution_started); called by 1 (thread_shell_command_uses_existing_active_turn).


##### `wait_for_command_execution_completed`  (lines 443–463)

```
async fn wait_for_command_execution_completed(
    mcp: &mut TestAppServer,
    expected_id: Option<&str>,
) -> Result<ItemCompletedNotification>
```

**Purpose**: Loops until it sees an `item/completed` notification for a command-execution item, optionally matching a specific item id.

**Data flow**: It repeatedly reads `item/completed` notifications, deserializes them into `ItemCompletedNotification`, filters to `ThreadItem::CommandExecution`, and returns the first one whose id matches `expected_id` if provided.

**Call relations**: Used by both positive tests to wait for the terminal command-execution item and inspect final status, output, and exit code.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 2 (thread_shell_command_history_responses_exclude_persisted_command_executions, thread_shell_command_uses_existing_active_turn); 1 external calls (from_value).


##### `wait_for_command_execution_output_delta`  (lines 465–482)

```
async fn wait_for_command_execution_output_delta(
    mcp: &mut TestAppServer,
    item_id: &str,
) -> Result<CommandExecutionOutputDeltaNotification>
```

**Purpose**: Waits for the next output-delta notification belonging to a specific command-execution item id.

**Data flow**: It repeatedly reads `item/commandExecution/outputDelta` notifications, deserializes them into `CommandExecutionOutputDeltaNotification`, and returns the first one whose `item_id` equals the requested id.

**Call relations**: Used only by `thread_shell_command_history_responses_exclude_persisted_command_executions` to verify live streaming output before command completion.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 1 (thread_shell_command_history_responses_exclude_persisted_command_executions); 1 external calls (from_value).


##### `create_config_toml`  (lines 484–524)

```
fn create_config_toml(
    codex_home: &Path,
    server_uri: &str,
    approval_policy: &str,
    feature_flags: &BTreeMap<Feature, bool>,
) -> std::io::Result<()>
```

**Purpose**: Writes a mock-provider config for shell-command tests, parameterized by approval policy and feature flags.

**Data flow**: It converts the supplied `BTreeMap<Feature, bool>` into TOML `[features]` entries by looking up each feature’s config key in `FEATURES`, then writes `config.toml` with model `mock-model`, the chosen approval policy, read-only sandbox, provider `mock_provider`, and the supplied mock server URL.

**Call relations**: Called by all three tests in the file so each scenario can control approval behavior and enabled features while keeping the provider wiring identical.

*Call graph*: called by 3 (thread_shell_command_history_responses_exclude_persisted_command_executions, thread_shell_command_returns_error_when_local_environment_is_disabled, thread_shell_command_uses_existing_active_turn); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/turn_start_zsh_fork.rs`

`test` · `request handling`

This non-Windows integration test module sets up a packaged app-server layout containing both the `codex-app-server` binary and a vendored zsh executable fetched through DotSlash. The tests create temporary Codex homes and workspaces, write feature-gated config enabling `Feature::ShellZshFork` while disabling unrelated execution paths, and then launch `TestAppServer` with `ZDOTDIR` pointing at the workspace so zsh startup behavior is controlled. The first test verifies that a shell command item launched through zsh-fork reports a command string beginning with the packaged zsh path and can be interrupted while still in flight. The next two tests cover approval decline and cancel decisions, asserting the resulting `ThreadItem::CommandExecution` becomes `Declined` and, for cancel, that the enclosing turn ends `Interrupted`. The most involved test simulates a parent shell command containing two `rm` subcommands, observes multiple `CommandExecutionRequestApproval` prompts, distinguishes parent-shell approval from intercepted subcommand approvals using command text and `CommandAction` metadata, accepts the parent and first subcommand, cancels the second, and then tolerates platform-specific completion differences while still requiring the parent command or turn to reflect interruption/decline. Helper functions package the app server, compute packaged zsh paths, copy binaries with permissions preserved, write config, fetch the shared test zsh artifact, and probe whether a zsh build supports `EXEC_WRAPPER` interception.

#### Function details

##### `turn_start_shell_zsh_fork_executes_command_v2`  (lines 50–176)

```
async fn turn_start_shell_zsh_fork_executes_command_v2() -> Result<()>
```

**Purpose**: Verifies that with Shell Zsh Fork enabled, a command execution item launches through the packaged zsh binary and reports the expected command string and cwd. It then interrupts the running turn to avoid racing with command completion.

**Data flow**: Creates temp Codex home and workspace, computes a release-marker path, resolves a test zsh binary with `find_test_zsh_path`, builds a shell command that loops until the marker file exists, and mounts a mock server returning that shell-command tool call plus a no-op follow-up response. It writes config enabling zsh-fork, creates a packaged app-server process via `create_zsh_test_mcp_process`, initializes it, starts a thread and turn with full-access sandbox and no approval, then loops for `item/started` until it finds `ThreadItem::CommandExecution`. It asserts the item id, `InProgress` status, command prefix/path fragments, and cwd, then calls `interrupt_turn_and_wait_for_aborted`.

**Call relations**: This Tokio test is invoked by the harness and depends on `find_test_zsh_path`, `create_config_toml`, and `create_zsh_test_mcp_process` for setup. It is the primary positive-path zsh-fork launch test and delegates interruption cleanup to the `TestAppServer` helper.

*Call graph*: calls 4 internal fn (create_config_toml, create_zsh_test_mcp_process, find_test_zsh_path, sse); 16 external calls (from, default, new, Integer, create_mock_responses_server_sequence_unchecked, create_shell_command_sse_response, assert!, assert_eq!, eprintln!, format! (+6 more)).


##### `turn_start_shell_zsh_fork_exec_approval_decline_v2`  (lines 179–312)

```
async fn turn_start_shell_zsh_fork_exec_approval_decline_v2() -> Result<()>
```

**Purpose**: Checks that declining a zsh-fork command approval marks the command execution item as declined with no exit code or aggregated output. It validates approval handling on the zsh-fork execution path.

**Data flow**: Creates temp directories, resolves the test zsh binary, mounts a mock sequence with one shell-command tool call and one final assistant message, writes config with `approval_policy = untrusted` and zsh-fork enabled, launches the packaged app server, initializes it, starts a thread and turn, and waits for a `ServerRequest::CommandExecutionRequestApproval`. After asserting the request's `item_id` and `thread_id`, it sends a `Decline` response, loops until `item/completed` yields a `ThreadItem::CommandExecution`, and asserts id `call-zsh-fork-decline`, status `Declined`, and absent `exit_code` and `aggregated_output`. It then waits for `turn/completed`.

**Call relations**: This test is run directly by the harness and shares the packaged-zsh setup path with the other tests in the file. It exercises the approval-request branch rather than the direct execution branch.

*Call graph*: calls 3 internal fn (create_config_toml, create_zsh_test_mcp_process, find_test_zsh_path); 16 external calls (from, default, new, Integer, create_mock_responses_server_sequence, assert!, assert_eq!, eprintln!, panic!, from_value (+6 more)).


##### `turn_start_shell_zsh_fork_exec_approval_cancel_v2`  (lines 315–443)

```
async fn turn_start_shell_zsh_fork_exec_approval_cancel_v2() -> Result<()>
```

**Purpose**: Verifies that canceling a zsh-fork command approval declines the command item and interrupts the enclosing turn. It distinguishes cancel semantics from a simple decline-only completion.

**Data flow**: Creates temp directories, resolves the test zsh binary, mounts a mock sequence with a single shell-command tool call, writes untrusted zsh-fork config, launches and initializes the packaged app server, starts a thread and turn, and waits for `ServerRequest::CommandExecutionRequestApproval`. It asserts ids, sends a `Cancel` response, loops until `item/completed` yields the command execution item, and asserts id `call-zsh-fork-cancel` and status `Declined`. It then reads `turn/completed`, deserializes `TurnCompletedNotification`, and asserts the thread id matches and the turn status is `Interrupted`.

**Call relations**: This test is invoked by the runner and follows the same setup path as the decline test, but validates the stronger turn-level interruption effect of the cancel decision.

*Call graph*: calls 3 internal fn (create_config_toml, create_zsh_test_mcp_process, find_test_zsh_path); 15 external calls (from, default, new, Integer, create_mock_responses_server_sequence, assert_eq!, eprintln!, panic!, from_value, to_value (+5 more)).


##### `turn_start_shell_zsh_fork_subcommand_decline_marks_parent_declined_v2`  (lines 446–740)

```
async fn turn_start_shell_zsh_fork_subcommand_decline_marks_parent_declined_v2() -> Result<()>
```

**Purpose**: Exercises zsh exec-wrapper interception for subcommands inside a parent shell command, ensuring that declining a later intercepted subcommand causes the parent command or turn to reflect interruption/decline. It is the most detailed approval-propagation test for zsh-fork.

**Data flow**: Creates temp Codex home and workspace, resolves the test zsh binary, skips if the binary lacks `EXEC_WRAPPER` support, writes two files, constructs a shell command `/bin/rm first && /bin/rm second`, and mounts a mock server whose first response emits a `shell_command` function call and whose second is a no-op. After writing zsh-fork config and launching the packaged app server, it starts a thread and turn with `approval_policy = UnlessTrusted` and full-access sandbox. It then repeatedly reads `CommandExecutionRequestApproval` requests, classifies each as parent-shell approval, target subcommand approval, or ignorable startup helper based on command text and `command_actions`, sends `Accept` for the parent and first target subcommand, `Cancel` for the second target subcommand, and records approval ids/strings. After asserting it saw the expected approvals, it tries to observe the parent `item/completed` notification and, depending on platform timing, either asserts the parent command is `Declined` with acceptable output and the turn is `Interrupted` or `Completed`, or falls back to asserting the turn completion status directly, interrupting manually if needed.

**Call relations**: This test is called by the harness and depends on nearly every helper in the file: zsh discovery, support probing, config writing, packaged-path computation, and packaged-process creation. It sits on the most complex zsh-fork path where intercepted subcommand approvals must propagate back to the parent command execution.

*Call graph*: calls 6 internal fn (command_packaged_zsh_path, create_config_toml, create_zsh_test_mcp_process, find_test_zsh_path, supports_exec_wrapper_intercept, sse); 22 external calls (from, default, new, new, Integer, create_mock_responses_server_sequence_unchecked, assert!, assert_eq!, assert_ne!, eprintln! (+12 more)).


##### `create_zsh_test_mcp_process`  (lines 742–755)

```
async fn create_zsh_test_mcp_process(
    codex_home: &Path,
    zdotdir: &Path,
    zsh_path: &Path,
) -> Result<TestAppServer>
```

**Purpose**: Builds a packaged app-server layout containing the test zsh binary and launches `TestAppServer` against that packaged executable with `ZDOTDIR` set. It abstracts the special process setup required by zsh-fork tests.

**Data flow**: Accepts Codex home, `zdotdir`, and zsh path. It calls `create_test_package_app_server` to create the packaged executable tree, converts `zdotdir` to an owned string, and invokes `TestAppServer::new_with_program_and_env` with the packaged app-server path and an environment override setting `ZDOTDIR` to that string. It returns the initialized `TestAppServer` future result.

**Call relations**: This helper is called by all four top-level zsh-fork tests after config writing and zsh discovery. It delegates filesystem packaging to `create_test_package_app_server` and process launch to `TestAppServer`.

*Call graph*: calls 2 internal fn (new_with_program_and_env, create_test_package_app_server); called by 4 (turn_start_shell_zsh_fork_exec_approval_cancel_v2, turn_start_shell_zsh_fork_exec_approval_decline_v2, turn_start_shell_zsh_fork_executes_command_v2, turn_start_shell_zsh_fork_subcommand_decline_marks_parent_declined_v2); 2 external calls (as_str, to_string_lossy).


##### `create_test_package_app_server`  (lines 757–775)

```
fn create_test_package_app_server(codex_home: &Path, zsh_path: &Path) -> Result<PathBuf>
```

**Purpose**: Creates a fake packaged installation tree under the test Codex home, copies in the real `codex-app-server` binary and the chosen zsh binary, and writes a minimal package manifest. This makes the app server believe it is running from a packaged distribution.

**Data flow**: Takes Codex home and zsh path, computes `test-package/bin` and the packaged zsh destination via `packaged_zsh_path`, ensures both directories exist, writes an empty `codex-package.json`, resolves the built `codex-app-server` binary with `cargo_bin`, copies that binary into `bin/codex-app-server`, copies the supplied zsh binary into the packaged zsh location using `copy_with_permissions`, and returns the packaged app-server path. If the packaged zsh path has no parent, it bails with an error.

**Call relations**: This helper is only called by `create_zsh_test_mcp_process`. It is the filesystem-packaging step that enables the zsh-fork code path under test.

*Call graph*: calls 2 internal fn (copy_with_permissions, packaged_zsh_path); called by 1 (create_zsh_test_mcp_process); 5 external calls (join, bail!, cargo_bin, create_dir_all, write).


##### `packaged_zsh_path`  (lines 777–784)

```
fn packaged_zsh_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Computes the canonical packaged location where the test zsh binary should live inside the fake package tree. It centralizes the expected resource layout.

**Data flow**: Accepts the Codex home path and returns `codex_home/test-package/codex-resources/zsh/bin/zsh` as a `PathBuf` by joining path segments. It performs no I/O.

**Call relations**: This helper is used by `create_test_package_app_server` when copying the zsh binary and by `command_packaged_zsh_path` when building expected command strings for assertions.

*Call graph*: called by 2 (command_packaged_zsh_path, create_test_package_app_server); 1 external calls (join).


##### `command_packaged_zsh_path`  (lines 786–789)

```
fn command_packaged_zsh_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Returns the packaged zsh path, canonicalized if possible, for use in command-string assertions. It smooths over symlink or path-normalization differences in the launched command.

**Data flow**: Calls `packaged_zsh_path` to compute the nominal path, then attempts `std::fs::canonicalize`; if canonicalization fails, it falls back to the original path. It returns the resulting `PathBuf`.

**Call relations**: This helper is used by the subcommand-decline test to recognize parent-shell approval commands and by the execution test to validate the command prefix indirectly.

*Call graph*: calls 1 internal fn (packaged_zsh_path); called by 1 (turn_start_shell_zsh_fork_subcommand_decline_marks_parent_declined_v2); 1 external calls (canonicalize).


##### `copy_with_permissions`  (lines 791–794)

```
fn copy_with_permissions(source: &Path, destination: &Path) -> std::io::Result<()>
```

**Purpose**: Copies a file and preserves the source file's permissions on the destination. It is used to install binaries into the fake package tree without losing executability.

**Data flow**: Accepts source and destination paths, copies the file bytes with `std::fs::copy`, reads source metadata, extracts its permissions, and applies those permissions to the destination with `std::fs::set_permissions`. It returns `std::io::Result<()>`.

**Call relations**: This helper is only called by `create_test_package_app_server` for both the app-server binary and the zsh binary.

*Call graph*: called by 1 (create_test_package_app_server); 3 external calls (copy, metadata, set_permissions).


##### `create_config_toml`  (lines 796–841)

```
fn create_config_toml(
    codex_home: &Path,
    server_uri: &str,
    approval_policy: &str,
    feature_flags: &BTreeMap<Feature, bool>,
) -> std::io::Result<()>
```

**Purpose**: Writes the zsh-fork test configuration, enabling requested feature flags while forcing `RemoteModels` off and pointing the mock provider at the supplied server. It standardizes the feature matrix for these tests.

**Data flow**: Takes Codex home, server URI, approval policy, and feature-flag map. It seeds a `BTreeMap` with `(Feature::RemoteModels, false)`, overlays the provided flags, maps each feature id to its config key via `FEATURES`, joins the resulting `key = bool` lines, and writes a `config.toml` containing model defaults, approval policy, `sandbox_mode = "read-only"`, the `[features]` section, and a `[model_providers.mock_provider]` block using `{server_uri}/v1`.

**Call relations**: This helper is called by all top-level tests in the file before launching the packaged app server. It is setup-only and mirrors the broader turn-start suite's config writer with zsh-fork-specific defaults.

*Call graph*: called by 4 (turn_start_shell_zsh_fork_exec_approval_cancel_v2, turn_start_shell_zsh_fork_exec_approval_decline_v2, turn_start_shell_zsh_fork_executes_command_v2, turn_start_shell_zsh_fork_subcommand_decline_marks_parent_declined_v2); 4 external calls (from, join, format!, write).


##### `find_test_zsh_path`  (lines 843–861)

```
fn find_test_zsh_path() -> Result<Option<std::path::PathBuf>>
```

**Purpose**: Locates and fetches the shared test zsh artifact referenced by the repository's DotSlash file. It returns `None` and prints a skip reason when the artifact is unavailable.

**Data flow**: Finds the repository root via `repo_root`, constructs the expected DotSlash file path `codex-rs/app-server/tests/suite/zsh`, checks whether that file exists, and if so calls `core_test_support::fetch_dotslash_file` to materialize the actual binary. On success it returns `Some(path)`; on missing file or fetch failure it prints a diagnostic with `eprintln!` and returns `Ok(None)`.

**Call relations**: This helper is called by every top-level zsh-fork test before any setup proceeds. Its `None` result is used by callers to skip tests gracefully rather than fail.

*Call graph*: called by 4 (turn_start_shell_zsh_fork_exec_approval_cancel_v2, turn_start_shell_zsh_fork_exec_approval_decline_v2, turn_start_shell_zsh_fork_executes_command_v2, turn_start_shell_zsh_fork_subcommand_decline_marks_parent_declined_v2); 3 external calls (repo_root, fetch_dotslash_file, eprintln!).


##### `supports_exec_wrapper_intercept`  (lines 863–873)

```
fn supports_exec_wrapper_intercept(zsh_path: &Path) -> bool
```

**Purpose**: Probes whether a given zsh binary honors `EXEC_WRAPPER` interception by running a trivial command under a failing wrapper. It gates tests that require subcommand interception support.

**Data flow**: Spawns `zsh_path -fc /usr/bin/true` with environment variable `EXEC_WRAPPER=/usr/bin/false` and inspects the resulting exit status. It returns `true` when the command fails, indicating the wrapper intercepted execution, and `false` on success or process-spawn error.

**Call relations**: This helper is only used by `turn_start_shell_zsh_fork_subcommand_decline_marks_parent_declined_v2` to decide whether the subcommand-interception scenario is meaningful on the current zsh build.

*Call graph*: called by 1 (turn_start_shell_zsh_fork_subcommand_decline_marks_parent_declined_v2); 1 external calls (new).


### Extension-backed tool execution
These suites cover built-in or extension-backed tool behaviors exposed through turns, including image generation, sleep, web search, and fuzzy file search sessions.

### `app-server/tests/suite/v2/imagegen_extension.rs`

`test` · `turn execution and tool integration`

This file tests the `imagegenext` feature end to end against a mock ChatGPT-compatible backend. It defines a small `ImagegenTestMode` enum to switch config generation between direct exposure and `code_mode_only`, plus constants for a tiny PNG and its data URL. The main generation tests mount mock SSE response sequences where the model first emits either a namespaced function call (`image_gen.imagegen`) or a custom tool call (`tools.image_gen__imagegen(...)`), then a follow-up assistant message after the tool result is sent back. `mount_image_response` and `mount_image_edit_response` stub the backend image endpoints, while `create_config_toml` writes a config enabling `imagegenext`, pointing both `chatgpt_base_url` and the model provider at the mock server, and requiring ChatGPT auth.

The tests assert more than mere success. For direct generation, the completed `ThreadItem::ImageGeneration` must include `status`, `revised_prompt`, base64 `result`, and a real `saved_path` whose file contents equal `b"png"`; the tool output sent back to the model must include an `input_image` data URL and a separate text hint naming the saved path, without the legacy developer-message hint. The failure case expects a terminal `ImageGeneration` item with `status: "failed"` and empty result, plus a function-call output mentioning failure. Two edit tests verify how referenced images are assembled: from an attached local image path or from a recent pathless image URL. Code-mode-only tests confirm the tool is still exposed and callable from generated code, and that its output shape differs slightly by including the legacy saved-images text hint in the custom-tool output array.

#### Function details

##### `standalone_image_generation_returns_saved_path_hint_to_model`  (lines 53–148)

```
async fn standalone_image_generation_returns_saved_path_hint_to_model() -> Result<()>
```

**Purpose**: Verifies successful standalone image generation produces a completed image item, saves the image to disk, and sends a model-visible output payload containing both the generated image and a saved-path hint.

**Data flow**: It starts a mock server, mounts the image-generation HTTP response and a two-step SSE sequence where the model first calls `image_gen.imagegen` and then replies `Done`, writes config in `Direct` mode, stores ChatGPT auth, starts `TestAppServer` with `OPENAI_API_KEY` unset, initializes, and calls `start_image_generation_turn`. It waits for `wait_for_image_generation_completed`, then for `turn/completed`, pattern-matches the returned `ThreadItem::ImageGeneration` to extract `status`, `revised_prompt`, `result`, and `saved_path`, verifies the saved file contains `b"png"`, then inspects the captured provider requests to assert the second request's function-call output contains an `input_image` data URL and a text hint mentioning the saved path, while developer messages do not contain the legacy hint.

**Call relations**: This top-level test orchestrates the file's main helpers: `create_config_toml`, `mount_image_response`, `start_image_generation_turn`, and `wait_for_image_generation_completed`. It then validates the downstream provider request captured by the SSE mock.

*Call graph*: calls 8 internal fn (new, new_with_env, create_config_toml, mount_image_response, start_image_generation_turn, wait_for_image_generation_completed, mount_sse_sequence, start_mock_server); 7 external calls (new, write_chatgpt_auth, assert!, assert_eq!, panic!, timeout, vec!).


##### `standalone_image_generation_failure_emits_terminal_item`  (lines 151–226)

```
async fn standalone_image_generation_failure_emits_terminal_item() -> Result<()>
```

**Purpose**: Checks that a backend image-generation failure still yields a terminal `ImageGeneration` thread item and a failure message in the tool output sent back to the model.

**Data flow**: It mounts a mock HTTP 500 response for `/api/codex/images/generations` and an SSE sequence where the model calls the image tool and then emits an apologetic assistant message, writes direct-mode config and ChatGPT auth, starts and initializes the server, and triggers a generation turn. It waits for `wait_for_image_generation_completed`, asserts the returned item equals `ThreadItem::ImageGeneration { id, status: "failed", revised_prompt: Some(...), result: "", saved_path: None }`, waits for `turn/completed`, then inspects the second captured provider request and asserts the function-call output text mentions `image generation failed`.

**Call relations**: Invoked by the harness, it follows the same helper-driven flow as the success case but swaps in a failing HTTP mock and asserts the failure-specific terminal item and tool-output text.

*Call graph*: calls 7 internal fn (new, new_with_env, create_config_toml, start_image_generation_turn, wait_for_image_generation_completed, mount_sse_sequence, start_mock_server); 10 external calls (given, new, new, write_chatgpt_auth, assert!, assert_eq!, timeout, vec!, method, path).


##### `standalone_image_edit_uses_attached_model_visible_image`  (lines 229–255)

```
async fn standalone_image_edit_uses_attached_model_visible_image() -> Result<()>
```

**Purpose**: Verifies that image-edit requests use an attached local image as the source image sent to the backend.

**Data flow**: It calls `run_image_edit_test` with a closure that writes `attached.png` containing `TINY_PNG_BYTES` under the temp Codex home and returns both the tool-call arguments JSON referencing that path and the turn input vector containing `V2UserInput::Text` plus `V2UserInput::LocalImage { path, detail: None }`. It receives the captured backend request body JSON and asserts `prompt == "add a red hat"` and `images[0].image_url == TINY_PNG_DATA_URL`.

**Call relations**: This is a thin assertion wrapper around `run_image_edit_test`; the helper performs all server setup, turn execution, and backend request capture.

*Call graph*: calls 1 internal fn (run_image_edit_test); 1 external calls (assert_eq!).


##### `standalone_image_edit_uses_recent_pathless_image`  (lines 258–283)

```
async fn standalone_image_edit_uses_recent_pathless_image() -> Result<()>
```

**Purpose**: Checks that image-edit requests can source the image from a recent pathless image URL when the tool arguments request inclusion of recent images.

**Data flow**: It calls `run_image_edit_test` with a closure returning tool-call arguments containing `num_last_images_to_include: 1` and turn input containing a text message plus `V2UserInput::Image { url, detail: None }`. It then asserts the captured backend request body has the expected prompt and that `images[0].image_url` equals the original remote URL.

**Call relations**: Like the previous edit test, this function delegates all protocol and backend plumbing to `run_image_edit_test` and only checks the resulting request JSON.

*Call graph*: calls 1 internal fn (run_image_edit_test); 1 external calls (assert_eq!).


##### `standalone_image_generation_is_exposed_in_code_mode_only`  (lines 286–326)

```
async fn standalone_image_generation_is_exposed_in_code_mode_only() -> Result<()>
```

**Purpose**: Verifies that when `imagegenext` is configured as code-mode-only, the model still sees the image-generation tool in code mode.

**Data flow**: It starts a mock server with a single assistant-message SSE response, writes config in `CodeModeOnly` mode plus ChatGPT auth, starts and initializes the server with `OPENAI_API_KEY` unset, triggers a generation turn via `start_image_generation_turn`, waits for `turn/completed`, and asserts the single captured provider request body contains the tool name `image_gen__imagegen`.

**Call relations**: This test uses `create_config_toml` and `start_image_generation_turn` but does not need image HTTP mocks because it only checks tool exposure in the initial model request.

*Call graph*: calls 7 internal fn (new, new_with_env, create_config_toml, start_image_generation_turn, mount_sse_once, sse, start_mock_server); 5 external calls (new, write_chatgpt_auth, assert!, timeout, vec!).


##### `standalone_image_generation_is_callable_from_code_mode_only`  (lines 330–402)

```
async fn standalone_image_generation_is_callable_from_code_mode_only() -> Result<()>
```

**Purpose**: Checks that in code-mode-only configuration the generated code can call the image-generation tool and that the custom-tool output sent back includes the generated image and saved-images hint.

**Data flow**: It mounts a successful image-generation HTTP response and an SSE sequence where the model emits a custom `exec` tool call that invokes `tools.image_gen__imagegen(...)` and then calls `generatedImage(result)`, followed by a final assistant message. After writing code-mode-only config and ChatGPT auth, starting and initializing the server, and triggering a generation turn, it waits for `turn/completed`, inspects the two captured provider requests, asserts the first contains `image_gen__imagegen`, and checks the second request's custom-tool output array: element 1 is the `input_image` data URL, element 2 is a text hint containing `Generated images are saved`, and the array length is exactly 3.

**Call relations**: This harness-invoked test combines `mount_image_response`, `create_config_toml`, and `start_image_generation_turn`, then validates the custom-tool output path rather than the namespaced function-call path used in direct mode.

*Call graph*: calls 7 internal fn (new, new_with_env, create_config_toml, mount_image_response, start_image_generation_turn, mount_sse_sequence, start_mock_server); 6 external calls (new, write_chatgpt_auth, assert!, assert_eq!, timeout, vec!).


##### `start_image_generation_turn`  (lines 404–413)

```
async fn start_image_generation_turn(mcp: &mut TestAppServer) -> Result<()>
```

**Purpose**: Starts a new thread and turn containing the standard `Generate an image` user text used by the generation tests.

**Data flow**: It takes a mutable `TestAppServer`, constructs a one-element `Vec<V2UserInput>` containing `Text { text: "Generate an image", text_elements: Vec::new() }`, and forwards that vector to `start_turn`. It returns the `Result<()>` from `start_turn`.

**Call relations**: The generation tests call this helper to avoid repeating the standard prompt construction; it is a thin specialization of `start_turn`.

*Call graph*: calls 1 internal fn (start_turn); called by 4 (standalone_image_generation_failure_emits_terminal_item, standalone_image_generation_is_callable_from_code_mode_only, standalone_image_generation_is_exposed_in_code_mode_only, standalone_image_generation_returns_saved_path_hint_to_model); 1 external calls (vec!).


##### `run_image_edit_test`  (lines 415–477)

```
async fn run_image_edit_test(
    input: impl FnOnce(&Path) -> Result<(serde_json::Value, Vec<V2UserInput>)>,
) -> Result<serde_json::Value>
```

**Purpose**: Provides the shared harness for image-edit tests: set up the mock backend and app server, run a turn whose tool call performs an image edit, and return the actual backend edit request body.

**Data flow**: It accepts a closure that, given the temp Codex home path, returns a pair of tool-call arguments JSON and turn input vector. The function starts a mock server, mounts the image-edit HTTP response, creates a temp home, invokes the closure to get arguments and input, mounts a two-step SSE sequence where the model calls `image_gen.imagegen` with those arguments and then replies `Done`, writes direct-mode config and ChatGPT auth, starts and initializes the server, calls `start_turn` with the provided input, waits for `wait_for_image_generation_completed` and `turn/completed`, asserts two provider requests were made, fetches all received HTTP requests from the mock server, finds the one whose path is `/api/codex/images/edits`, deserializes its body JSON, and returns that JSON value.

**Call relations**: Both image-edit tests delegate entirely to this helper. Internally it uses `mount_image_edit_response`, `create_config_toml`, `start_turn`, and `wait_for_image_generation_completed` to drive the scenario.

*Call graph*: calls 8 internal fn (new, new_with_env, create_config_toml, mount_image_edit_response, start_turn, wait_for_image_generation_completed, mount_sse_sequence, start_mock_server); called by 2 (standalone_image_edit_uses_attached_model_visible_image, standalone_image_edit_uses_recent_pathless_image); 5 external calls (new, write_chatgpt_auth, assert_eq!, timeout, vec!).


##### `start_turn`  (lines 479–506)

```
async fn start_turn(mcp: &mut TestAppServer, input: Vec<V2UserInput>) -> Result<()>
```

**Purpose**: Starts a fresh thread and immediately starts a turn on it with the supplied user inputs.

**Data flow**: It takes a mutable `TestAppServer` and a `Vec<V2UserInput>`, sends `ThreadStartParams::default()`, waits for the matching response under `DEFAULT_READ_TIMEOUT`, deserializes `ThreadStartResponse` to obtain `thread.id`, then sends `TurnStartParams { thread_id, client_user_message_id: None, input, ..Default::default() }`, waits for the matching response, deserializes `TurnStartResponse`, and returns `Ok(())`.

**Call relations**: This helper underpins both `start_image_generation_turn` and `run_image_edit_test`, encapsulating the common thread-start plus turn-start protocol sequence.

*Call graph*: calls 3 internal fn (read_stream_until_response_message, send_thread_start_request, send_turn_start_request); called by 2 (run_image_edit_test, start_image_generation_turn); 4 external calls (default, Integer, default, timeout).


##### `wait_for_image_generation_completed`  (lines 508–524)

```
async fn wait_for_image_generation_completed(
    mcp: &mut TestAppServer,
) -> Result<ItemCompletedNotification>
```

**Purpose**: Consumes `item/completed` notifications until it finds one whose item is an image-generation item, then returns that typed notification.

**Data flow**: It loops reading `item/completed` notifications from the server, deserializes each notification's params into `ItemCompletedNotification`, checks `matches!(&completed.item, ThreadItem::ImageGeneration { .. })`, and returns the first matching notification. Non-image completed items are ignored and the loop continues.

**Call relations**: The success, failure, and edit helpers call this function after starting a turn so they can synchronize specifically on the image-generation item's completion rather than on generic turn completion.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 3 (run_image_edit_test, standalone_image_generation_failure_emits_terminal_item, standalone_image_generation_returns_saved_path_hint_to_model); 2 external calls (matches!, from_value).


##### `mount_image_response`  (lines 526–536)

```
async fn mount_image_response(server: &MockServer)
```

**Purpose**: Registers a successful mock HTTP response for image-generation requests.

**Data flow**: It takes a `wiremock::MockServer`, mounts a `POST /api/codex/images/generations` expectation that returns HTTP 200 with JSON `{ "created": 1, "data": [{ "b64_json": RESULT }] }`, and awaits the mount operation.

**Call relations**: The successful generation tests call this helper before starting the app server so the image backend request made during tool execution receives a deterministic response.

*Call graph*: called by 2 (standalone_image_generation_is_callable_from_code_mode_only, standalone_image_generation_returns_saved_path_hint_to_model); 5 external calls (given, new, json!, method, path).


##### `mount_image_edit_response`  (lines 538–548)

```
async fn mount_image_edit_response(server: &MockServer)
```

**Purpose**: Registers a successful mock HTTP response for image-edit requests.

**Data flow**: It takes a `MockServer`, mounts a `POST /api/codex/images/edits` expectation that returns HTTP 200 with JSON containing `b64_json: RESULT`, and awaits the mount.

**Call relations**: Only `run_image_edit_test` calls this helper, using it to stub the backend endpoint that should receive the assembled edit request.

*Call graph*: called by 1 (run_image_edit_test); 5 external calls (given, new, json!, method, path).


##### `create_config_toml`  (lines 550–584)

```
fn create_config_toml(
    codex_home: &Path,
    server_uri: &str,
    mode: ImagegenTestMode,
) -> std::io::Result<()>
```

**Purpose**: Writes the test `config.toml` enabling the image-generation extension and pointing both ChatGPT and model-provider endpoints at the mock server.

**Data flow**: It takes the Codex home path, server URI, and `ImagegenTestMode`, derives an optional `code_mode_only = true` line from the mode, formats a TOML file containing model settings, `chatgpt_base_url`, `[features] imagegenext = true`, optional code-mode-only flag, and an `openai-custom` provider configured for the mock `/api/codex` endpoint with `requires_openai_auth = true`, then writes it to `config.toml`.

**Call relations**: All top-level tests in this file call this helper during setup so they can vary only the mode while sharing the same backend and auth configuration.

*Call graph*: called by 5 (run_image_edit_test, standalone_image_generation_failure_emits_terminal_item, standalone_image_generation_is_callable_from_code_mode_only, standalone_image_generation_is_exposed_in_code_mode_only, standalone_image_generation_returns_saved_path_hint_to_model); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/sleep.rs`

`test` · `request handling`

This file sets up a compact end-to-end test for the sleep tool. The mock server is configured with a two-response SSE sequence: the first response creates a function call named `sleep` with JSON arguments `{ "duration_ms": 1 }` and call id `sleep-1`, and the second response emits a final assistant message `Done`. The test then writes a temporary `config.toml` that selects `mock-model`, disables approvals, uses read-only sandboxing, points the provider at the mock server, and enables `[features] sleep_tool = true`.

Using `TestAppServer`, the test initializes the server, starts a thread, and starts a turn with a single text input `Sleep briefly`. After parsing the typed thread and turn responses, it enters a bounded loop that reads raw JSON-RPC messages until it has captured both an `ItemStartedNotification` and an `ItemCompletedNotification` whose `item` is `ThreadItem::Sleep`. Other notifications are ignored. Once both are found, it separately waits for `turn/completed`, then constructs the expected `ThreadItem::Sleep { id: "sleep-1", duration_ms: 1 }` and asserts that the completion timestamp is not earlier than the start timestamp. It also compares the full started/completed payloads against expected thread id, turn id, and item values, allowing only the observed timestamps to vary.

#### Function details

##### `sleep_emits_started_and_completed_items`  (lines 25–150)

```
async fn sleep_emits_started_and_completed_items() -> Result<()>
```

**Purpose**: Runs a full sleep-tool turn and confirms the server emits both start and completion item notifications for the same sleep call. It validates the concrete `ThreadItem::Sleep` payload and basic timestamp ordering.

**Data flow**: Starts a mock server, mounts a two-step SSE sequence containing a `sleep` function call and then a final assistant message, creates a temporary Codex home, writes config via `create_config_toml`, initializes `TestAppServer`, and sends thread-start and turn-start requests. It converts the resulting `JSONRPCResponse` values into `ThreadStartResponse` and `TurnStartResponse`, then loops over `read_next_message()` until it has captured both `ItemStartedNotification` and `ItemCompletedNotification` whose `item` matches `ThreadItem::Sleep`. After waiting for `turn/completed`, it builds the expected sleep item, asserts `completed_at_ms >= started_at_ms`, and compares the full notification payloads against expected thread id, turn id, and item values before returning `Ok(())`.

**Call relations**: This is the file's sole Tokio test. It uses `create_config_toml` during setup and otherwise directly drives the mock server and `TestAppServer` through initialization, thread creation, turn creation, notification collection, and final assertions.

*Call graph*: calls 4 internal fn (new, create_config_toml, mount_sse_sequence, start_mock_server); 10 external calls (default, new, Integer, to_response, assert!, assert_eq!, matches!, from_value, timeout, vec!).


##### `create_config_toml`  (lines 152–174)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes the temporary TOML configuration for the sleep-tool test, enabling the feature and pointing the mock provider at the supplied server URI. The config also fixes approval policy and sandbox mode for deterministic execution.

**Data flow**: Accepts the Codex home path and server URI, joins `config.toml`, formats a TOML string embedding `server_uri` and `[features] sleep_tool = true`, and writes it to disk. It returns the `std::io::Result<()>` from `std::fs::write`.

**Call relations**: Called only by `sleep_emits_started_and_completed_items` before `TestAppServer::new` so the server process starts with the sleep tool enabled.

*Call graph*: called by 1 (sleep_emits_started_and_completed_items); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/web_search.rs`

`test` · `request handling`

This integration test module sets up a mock OpenAI-compatible Responses API server plus a separate mocked `/api/codex/alpha/search` endpoint to validate the standalone web-search feature. The main test writes a config that enables `standalone_web_search`, points both `chatgpt_base_url` and the model provider at the mock server, and writes ChatGPT auth credentials while explicitly unsetting `OPENAI_API_KEY` so auth comes from the fixture. It starts a thread and turn, then waits for `item/started` and `item/completed` notifications whose `ThreadItem` variant is `WebSearch`. After turn completion, it inspects the first model request to confirm the `web.run` tool schema is present and that no hosted `web_search` tool remains, inspects the standalone search POST body to verify model id, command payload, allowed callers, and user input forwarding, and inspects the second model request to confirm the search result was returned as `function_call_output`. The completed `ThreadItem::WebSearch` is expected to carry the resolved query and `WebSearchAction::Search`. Finally, the test restarts the app server, reads the thread with turns included, and asserts the completed web-search item persisted in thread history. Small helpers wait for the relevant item notifications, mount the search endpoint, detect hosted web-search tools in request JSON, extract the standalone search request body, and write the feature-enabled config.

#### Function details

##### `standalone_web_search_round_trips_output`  (lines 44–221)

```
async fn standalone_web_search_round_trips_output() -> Result<()>
```

**Purpose**: Exercises the full standalone web-search flow and verifies request shaping, item notifications, function-call output reinjection, and persistence across restart. It is the end-to-end regression test for the feature.

**Data flow**: Starts a mock server, mounts the standalone search endpoint with `mount_search_response`, and mounts two SSE model responses: first a `web.run` function call, then a final assistant message. It writes feature-enabled config and ChatGPT auth, launches `TestAppServer` with `OPENAI_API_KEY` unset, initializes it, starts a thread, and starts a text turn. It waits for `wait_for_web_search_started` and `wait_for_web_search_completed`, then for `turn/completed`. Next it inspects captured model requests to assert the `web.run` tool schema and absence of hosted web search, calls `search_request_body` to inspect the standalone search POST, and asserts the second model request contains the expected `function_call_output`. It compares the started and completed `ThreadItem::WebSearch` values to expected variants, restarts the app server, reads the thread with turns included, filters persisted items to `WebSearch`, and asserts the completed item was stored.

**Call relations**: This top-level test is invoked by the harness and orchestrates all helpers in the file: config writing, search endpoint mounting, notification waiting, and request-body extraction. It spans initial execution and later persistence verification after process restart.

*Call graph*: calls 9 internal fn (new, new_with_env, create_config_toml, mount_search_response, search_request_body, wait_for_web_search_completed, wait_for_web_search_started, mount_sse_sequence, start_mock_server); 9 external calls (default, new, Integer, default, write_chatgpt_auth, assert!, assert_eq!, timeout, vec!).


##### `wait_for_web_search_started`  (lines 223–237)

```
async fn wait_for_web_search_started(mcp: &mut TestAppServer) -> Result<ItemStartedNotification>
```

**Purpose**: Consumes notification traffic until it finds an `item/started` notification whose item is `ThreadItem::WebSearch`. It isolates the relevant item from mixed notification streams.

**Data flow**: Takes a mutable `TestAppServer`, repeatedly reads `item/started` notifications, deserializes each into `ItemStartedNotification`, and returns the first one whose `item` matches `ThreadItem::WebSearch`. Errors from missing params or deserialization are propagated.

**Call relations**: This helper is called by `standalone_web_search_round_trips_output` immediately after turn start. It acts as a filtering loop over the app server's notification stream.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 1 (standalone_web_search_round_trips_output); 2 external calls (matches!, from_value).


##### `wait_for_web_search_completed`  (lines 239–255)

```
async fn wait_for_web_search_completed(
    mcp: &mut TestAppServer,
) -> Result<ItemCompletedNotification>
```

**Purpose**: Consumes notification traffic until it finds an `item/completed` notification for a `ThreadItem::WebSearch`. It lets the main test wait specifically for web-search completion.

**Data flow**: Accepts a mutable `TestAppServer`, loops reading `item/completed` notifications, deserializes each into `ItemCompletedNotification`, and returns the first notification whose `item` matches `ThreadItem::WebSearch`. It propagates notification and deserialization errors.

**Call relations**: This helper is called by the main standalone web-search test after `wait_for_web_search_started`. It mirrors the started helper but targets completion notifications.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 1 (standalone_web_search_round_trips_output); 2 external calls (matches!, from_value).


##### `mount_search_response`  (lines 257–267)

```
async fn mount_search_response(server: &MockServer)
```

**Purpose**: Registers the mock HTTP response for the standalone search backend endpoint. It provides deterministic encrypted and plaintext output for the web-search tool.

**Data flow**: Accepts a `wiremock::MockServer`, builds a `Mock` matching `POST /api/codex/alpha/search`, configures it to return HTTP 200 with JSON `{ encrypted_output: "ciphertext", output: "Search result" }`, expects exactly one call, and mounts it asynchronously.

**Call relations**: This helper is called during setup by `standalone_web_search_round_trips_output` before the app server starts. It supplies the external search service that the standalone tool should invoke.

*Call graph*: called by 1 (standalone_web_search_round_trips_output); 5 external calls (given, new, json!, method, path).


##### `has_hosted_web_search`  (lines 269–277)

```
fn has_hosted_web_search(body: &Value) -> bool
```

**Purpose**: Detects whether a model request body still contains a hosted `web_search` tool entry. It is used to prove the standalone tool replaced the hosted one.

**Data flow**: Accepts a JSON `Value`, looks up its `tools` array, and returns `true` if any tool object has `type == "web_search"`; otherwise returns `false`. It performs no I/O.

**Call relations**: This helper is used only by `standalone_web_search_round_trips_output` when inspecting the first model request body.

*Call graph*: 1 external calls (get).


##### `search_request_body`  (lines 279–289)

```
async fn search_request_body(server: &MockServer) -> Result<Value>
```

**Purpose**: Finds and parses the standalone search backend request body from the mock server's recorded requests. It gives the main test direct access to the search POST payload.

**Data flow**: Reads all received requests from the `MockServer`, finds the one whose path is `/api/codex/alpha/search`, parses its body as JSON, and returns that `Value`. It adds context-rich errors if request retrieval, lookup, or JSON parsing fails.

**Call relations**: This helper is called by `standalone_web_search_round_trips_output` after the turn completes, once the search backend should have been invoked exactly once.

*Call graph*: called by 1 (standalone_web_search_round_trips_output); 1 external calls (received_requests).


##### `create_config_toml`  (lines 291–316)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes the standalone-web-search test configuration, enabling the feature and configuring an auth-required custom OpenAI provider against the mock server. It ensures the app server routes web search through the standalone backend.

**Data flow**: Accepts the Codex home path and server URI, then writes `config.toml` containing `model = "mock-model"`, `approval_policy = "never"`, `sandbox_mode = "read-only"`, `model_provider = "openai-custom"`, `chatgpt_base_url = server_uri`, `[features] standalone_web_search = true`, and a `[model_providers.openai-custom]` section pointing at `{server_uri}/api/codex` with `requires_openai_auth = true` and retries disabled.

**Call relations**: This helper is called only by `standalone_web_search_round_trips_output` during setup, before auth is written and the app server is launched.

*Call graph*: called by 1 (standalone_web_search_round_trips_output); 3 external calls (join, format!, write).


### `app-server/tests/suite/fuzzy_file_search.rs`

`test` · `request handling and notification streaming in integration tests`

This file is a focused integration suite for the fuzzy file search RPCs and notifications. It creates temporary roots populated with carefully chosen filenames, then drives the server through `TestAppServer`. A small config writer enables dangerous full-access sandboxing and disables shell snapshots so file traversal is allowed in tests. The helper `initialized_mcp` standardizes startup and initialization, while `wait_for_session_updated` and `wait_for_session_completed` repeatedly scan buffered notifications until they find the expected session id, query, and file cardinality, producing detailed timeout errors that include buffered notification methods.

The tests split into two modes. One-shot request tests assert exact JSON response payloads, including deterministic ordering, fuzzy-match scores, and `indices` arrays. Session tests exercise start/update/stop semantics: updates can arrive even if the caller has not yet awaited the start response; updates are case-insensitive; a completed search emits no further updates until the query changes; clearing the query yields an empty snapshot; stopping a session suppresses later updates and makes subsequent update requests fail with JSON-RPC code `-32600`. `assert_no_session_updates_for` is intentionally defensive: it first drains any in-flight notifications during a grace period, then watches for unexpected same-session updates while tolerating unrelated session traffic. Together these tests document the server's asynchronous contract, not just its search results.

#### Function details

##### `create_config_toml`  (lines 32–45)

```
fn create_config_toml(codex_home: &Path) -> std::io::Result<()>
```

**Purpose**: Writes the minimal app-server config needed for fuzzy file search tests. It enables full filesystem access and disables shell snapshots.

**Data flow**: Takes a codex-home path → joins `config.toml` under it and writes TOML with `model`, `approval_policy`, `sandbox_mode = "danger-full-access"`, and `[features] shell_snapshot = false` → returns `std::io::Result<()>`.

**Call relations**: Used by direct startup tests and by `initialized_mcp`, so every test runs the server with consistent filesystem permissions and feature flags.

*Call graph*: called by 3 (initialized_mcp, test_fuzzy_file_search_accepts_cancellation_token, test_fuzzy_file_search_sorts_and_includes_indices); 2 external calls (join, write).


##### `initialized_mcp`  (lines 47–52)

```
async fn initialized_mcp(codex_home: &TempDir) -> Result<TestAppServer>
```

**Purpose**: Creates a configured `TestAppServer` and waits for initialization to complete. It packages the common startup sequence used by most session-oriented tests.

**Data flow**: Accepts a `TempDir` reference for codex home → writes config via `create_config_toml`, constructs `TestAppServer`, awaits `initialize()` under `DEFAULT_READ_TIMEOUT`, and returns the initialized server handle in `Result<TestAppServer>`.

**Call relations**: Most session tests call this helper first so they can focus on session behavior rather than repeated setup boilerplate.

*Call graph*: calls 2 internal fn (new, create_config_toml); called by 10 (test_fuzzy_file_search_query_cleared_sends_blank_snapshot, test_fuzzy_file_search_session_multiple_query_updates_work, test_fuzzy_file_search_session_no_updates_after_complete_until_query_edited, test_fuzzy_file_search_session_stops_sending_updates_after_stop, test_fuzzy_file_search_session_streams_updates, test_fuzzy_file_search_session_update_after_stop_fails, test_fuzzy_file_search_session_update_before_start_errors, test_fuzzy_file_search_session_update_is_case_insensitive, test_fuzzy_file_search_session_update_works_without_waiting_for_start_response, test_fuzzy_file_search_two_sessions_are_independent); 2 external calls (path, timeout).


##### `wait_for_session_updated`  (lines 54–99)

```
async fn wait_for_session_updated(
    mcp: &mut TestAppServer,
    session_id: &str,
    query: &str,
    file_expectation: FileExpectation,
) -> Result<FuzzyFileSearchSessionUpdatedNotification>
```

**Purpose**: Waits until a `fuzzyFileSearch/sessionUpdated` notification matching a specific session id, query, and file-presence expectation appears. It filters out unrelated notifications and malformed payloads.

**Data flow**: Consumes a mutable `TestAppServer`, target `session_id`, `query`, and `FileExpectation` → repeatedly reads notifications through `read_stream_until_matching_notification`, deserializes candidate params into `FuzzyFileSearchSessionUpdatedNotification`, checks method, session id, query, and whether `files` is any/empty/non-empty as requested → returns the parsed notification payload or a timeout error that includes buffered notification methods.

**Call relations**: Called by nearly every session test after issuing an update request. It sits between raw notification transport and test assertions, ensuring each test observes the intended update rather than whichever notification arrives first.

*Call graph*: calls 1 internal fn (read_stream_until_matching_notification); called by 8 (test_fuzzy_file_search_query_cleared_sends_blank_snapshot, test_fuzzy_file_search_session_multiple_query_updates_work, test_fuzzy_file_search_session_no_updates_after_complete_until_query_edited, test_fuzzy_file_search_session_stops_sending_updates_after_stop, test_fuzzy_file_search_session_streams_updates, test_fuzzy_file_search_session_update_is_case_insensitive, test_fuzzy_file_search_session_update_works_without_waiting_for_start_response, test_fuzzy_file_search_two_sessions_are_independent); 3 external calls (bail!, format!, timeout).


##### `wait_for_session_completed`  (lines 101–140)

```
async fn wait_for_session_completed(
    mcp: &mut TestAppServer,
    session_id: &str,
) -> Result<FuzzyFileSearchSessionCompletedNotification>
```

**Purpose**: Blocks until the server emits a `fuzzyFileSearch/sessionCompleted` notification for the specified session. It ignores unrelated notifications and malformed payloads.

**Data flow**: Takes mutable server state and a `session_id` → scans notifications until one has method `fuzzyFileSearch/sessionCompleted` and deserializes to a payload whose `session_id` matches → returns the parsed `FuzzyFileSearchSessionCompletedNotification`, or a timeout error with buffered notification methods.

**Call relations**: Used in tests that need to prove the server marks a search pass complete before asserting post-completion invariants or issuing another query.

*Call graph*: calls 1 internal fn (read_stream_until_matching_notification); called by 3 (test_fuzzy_file_search_session_multiple_query_updates_work, test_fuzzy_file_search_session_no_updates_after_complete_until_query_edited, test_fuzzy_file_search_session_streams_updates); 3 external calls (bail!, format!, timeout).


##### `assert_update_request_fails_for_missing_session`  (lines 142–161)

```
async fn assert_update_request_fails_for_missing_session(
    mcp: &mut TestAppServer,
    session_id: &str,
    query: &str,
) -> Result<()>
```

**Purpose**: Asserts that updating a nonexistent fuzzy-search session yields the expected JSON-RPC error. It checks both the protocol error code and the human-readable message.

**Data flow**: Sends a session-update request for the provided `session_id` and `query`, waits for the matching error response by request id, then asserts `err.error.code == -32600` and `err.error.message == format!("fuzzy file search session not found: {session_id}")` → returns `Ok(())` on success.

**Call relations**: Shared by tests covering update-before-start and update-after-stop, where the server should reject the request instead of silently creating or reviving a session.

*Call graph*: calls 2 internal fn (read_stream_until_error_message, send_fuzzy_file_search_session_update_request); called by 2 (test_fuzzy_file_search_session_update_after_stop_fails, test_fuzzy_file_search_session_update_before_start_errors); 3 external calls (Integer, assert_eq!, timeout).


##### `assert_no_session_updates_for`  (lines 163–215)

```
async fn assert_no_session_updates_for(
    mcp: &mut TestAppServer,
    session_id: &str,
    grace_period: std::time::Duration,
    duration: std::time::Duration,
) -> Result<()>
```

**Purpose**: Verifies that no further `sessionUpdated` notifications are delivered for a given session during a watch window. It tolerates unrelated session traffic and drains already-buffered updates during an initial grace period.

**Data flow**: Given mutable server state, a target `session_id`, a `grace_period`, and a `duration`, it first loops until the grace deadline reading any `SESSION_UPDATED_METHOD` notifications and discarding them; then it loops until the main deadline, timing out successfully if no more updates arrive, but if a notification does arrive it deserializes it and fails only when `payload.session_id` matches the forbidden session id → returns `Ok(())` if the session stays quiet.

**Call relations**: Used after completion and after explicit stop to enforce the server's no-more-updates invariants without being brittle in the presence of delayed or unrelated notifications.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 2 (test_fuzzy_file_search_session_no_updates_after_complete_until_query_edited, test_fuzzy_file_search_session_stops_sending_updates_after_stop); 3 external calls (bail!, now, timeout).


##### `test_fuzzy_file_search_sorts_and_includes_indices`  (lines 218–295)

```
async fn test_fuzzy_file_search_sorts_and_includes_indices() -> Result<()>
```

**Purpose**: Checks the one-shot fuzzy search response ordering, scores, match types, and character indices for a deterministic file set. It proves the server returns ranked matches rather than arbitrary filesystem order.

**Data flow**: Creates temp codex-home and root directories, writes files `abc`, `abcde`, `abexy`, `zzz.txt`, and `sub/abce`, starts and initializes the server, sends a fuzzy search for `abe` over the root path, reads the JSON-RPC response, and asserts the entire `result` JSON equals an expected object containing three ranked file entries with exact `score` and `indices` values.

**Call relations**: This top-level test directly exercises the one-shot RPC path and does not use the session helpers because it validates the immediate response payload shape.

*Call graph*: calls 2 internal fn (new, create_config_toml); 7 external calls (new, Integer, assert_eq!, create_dir_all, write, timeout, vec!).


##### `test_fuzzy_file_search_accepts_cancellation_token`  (lines 298–344)

```
async fn test_fuzzy_file_search_accepts_cancellation_token() -> Result<()>
```

**Purpose**: Verifies that a one-shot fuzzy search request can reference another request id as a cancellation token without breaking normal results. The test confirms the second request still returns the expected file list.

**Data flow**: Creates config and a root containing `alpha.txt`, starts the server, sends one fuzzy search without a cancellation token, sends a second search with `Some(request_id.to_string())` as the token, reads the second response, extracts the `files` array from JSON, and asserts it contains exactly one entry for `alpha.txt` under the expected root.

**Call relations**: This is a standalone request-level test for protocol compatibility around the optional cancellation token field.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (new, Integer, assert_eq!, write, timeout, vec!).


##### `test_fuzzy_file_search_session_streams_updates`  (lines 347–372)

```
async fn test_fuzzy_file_search_session_streams_updates() -> Result<()>
```

**Purpose**: Confirms that a started fuzzy-search session emits an update notification with results and then a completion notification. It also verifies the returned file path content for a simple query.

**Data flow**: Creates a root with `alpha.txt`, starts an initialized server, starts session `session-1`, sends query `alp`, waits for a non-empty session-updated payload, asserts the single file entry, waits for session completion, then stops the session and returns success.

**Call relations**: This is the baseline session-flow test and demonstrates the intended start → update → completed → stop sequence using the helper wait functions.

*Call graph*: calls 3 internal fn (initialized_mcp, wait_for_session_completed, wait_for_session_updated); 4 external calls (new, assert_eq!, write, vec!).


##### `test_fuzzy_file_search_session_update_is_case_insensitive`  (lines 375–396)

```
async fn test_fuzzy_file_search_session_update_is_case_insensitive() -> Result<()>
```

**Purpose**: Shows that session updates match files regardless of query case. An uppercase query still finds a lowercase filename.

**Data flow**: Creates `alpha.txt`, starts a session, updates it with query `ALP`, waits for a non-empty update payload, and asserts the single returned file is `alpha.txt` under the expected root.

**Call relations**: It reuses `initialized_mcp` and `wait_for_session_updated` to isolate the case-insensitivity property from other session mechanics.

*Call graph*: calls 2 internal fn (initialized_mcp, wait_for_session_updated); 4 external calls (new, assert_eq!, write, vec!).


##### `test_fuzzy_file_search_session_no_updates_after_complete_until_query_edited`  (lines 399–423)

```
async fn test_fuzzy_file_search_session_no_updates_after_complete_until_query_edited() -> Result<()>
```

**Purpose**: Enforces the invariant that once a query run completes, the server stays silent until the query changes. It then proves that editing the query reactivates updates.

**Data flow**: Starts a session over a root with `alpha.txt`, updates with `alp`, waits for a non-empty update and completion, calls `assert_no_session_updates_for` over a grace period plus short timeout, then updates the same session with `alpha` and waits for a fresh non-empty update.

**Call relations**: This test combines both helper waiters and the no-update assertion to document the session state machine after completion.

*Call graph*: calls 4 internal fn (assert_no_session_updates_for, initialized_mcp, wait_for_session_completed, wait_for_session_updated); 3 external calls (new, write, vec!).


##### `test_fuzzy_file_search_session_update_before_start_errors`  (lines 426–432)

```
async fn test_fuzzy_file_search_session_update_before_start_errors() -> Result<()>
```

**Purpose**: Checks that sending an update for a session id that has never been started is rejected. The server must not implicitly create sessions on update.

**Data flow**: Starts an initialized server with no sessions and delegates to `assert_update_request_fails_for_missing_session` for session id `missing` and query `alp`.

**Call relations**: A small negative test built entirely around the shared missing-session assertion helper.

*Call graph*: calls 2 internal fn (assert_update_request_fails_for_missing_session, initialized_mcp); 1 external calls (new).


##### `test_fuzzy_file_search_session_update_works_without_waiting_for_start_response`  (lines 435–470)

```
async fn test_fuzzy_file_search_session_update_works_without_waiting_for_start_response() -> Result<()>
```

**Purpose**: Verifies that the server can process an update request immediately after a start request, even if the client has not yet awaited the start response. This guards against ordering assumptions in asynchronous clients.

**Data flow**: Creates `alpha.txt`, starts an initialized server, sends a raw session-start request and captures its request id, immediately sends a raw session-update request, waits for the update response first and the start response second, then waits for a non-empty session-updated notification and asserts the returned file entry.

**Call relations**: This test specifically exercises concurrency between request handling and notification production, using raw send/read methods instead of the convenience wrappers that await each response in order.

*Call graph*: calls 2 internal fn (initialized_mcp, wait_for_session_updated); 6 external calls (new, Integer, assert_eq!, write, timeout, vec!).


##### `test_fuzzy_file_search_session_multiple_query_updates_work`  (lines 473–504)

```
async fn test_fuzzy_file_search_session_multiple_query_updates_work() -> Result<()>
```

**Purpose**: Shows that a single session can be reused for multiple distinct queries, including one that yields no matches. Each query should produce its own update and completion cycle.

**Data flow**: Creates `alpha.txt` and `alphabet.txt`, starts a session, updates with `alp`, waits for a non-empty update and completion, then updates with `zzzz`, waits for an update with any file cardinality, asserts the query string and that `files` is empty, and waits for another completion.

**Call relations**: It demonstrates that completion does not terminate the session itself; later query edits restart search work within the same session.

*Call graph*: calls 3 internal fn (initialized_mcp, wait_for_session_completed, wait_for_session_updated); 4 external calls (new, assert_eq!, write, vec!).


##### `test_fuzzy_file_search_session_update_after_stop_fails`  (lines 507–522)

```
async fn test_fuzzy_file_search_session_update_after_stop_fails() -> Result<()>
```

**Purpose**: Confirms that once a session is stopped, later update requests are rejected as missing-session errors. Stop is therefore terminal for that session id.

**Data flow**: Creates `alpha.txt`, starts and then stops a session, then calls `assert_update_request_fails_for_missing_session` with the stopped session id and query `alp`.

**Call relations**: This is the stop-state counterpart to the update-before-start negative test.

*Call graph*: calls 2 internal fn (assert_update_request_fails_for_missing_session, initialized_mcp); 3 external calls (new, write, vec!).


##### `test_fuzzy_file_search_session_stops_sending_updates_after_stop`  (lines 525–548)

```
async fn test_fuzzy_file_search_session_stops_sending_updates_after_stop() -> Result<()>
```

**Purpose**: Ensures that stopping an active session suppresses any further update notifications, even when a broad query could have produced many results. It protects against background workers continuing after stop.

**Data flow**: Creates 512 files named `file-0000.txt` through `file-0511.txt`, starts a session, updates with query `file-`, waits for an initial non-empty update, stops the session, then calls `assert_no_session_updates_for` with a grace period and short watch duration.

**Call relations**: This test stresses the stop path with a larger result set so delayed background emissions are more likely if cancellation is broken.

*Call graph*: calls 3 internal fn (assert_no_session_updates_for, initialized_mcp, wait_for_session_updated); 4 external calls (new, format!, write, vec!).


##### `test_fuzzy_file_search_two_sessions_are_independent`  (lines 551–587)

```
async fn test_fuzzy_file_search_two_sessions_are_independent() -> Result<()>
```

**Purpose**: Verifies that two concurrent fuzzy-search sessions maintain separate roots, queries, and notifications. Activity in one session must not overwrite or satisfy expectations for the other.

**Data flow**: Creates separate roots containing `alpha.txt` and `beta.txt`, starts sessions `session-a` and `session-b`, updates session A with `alp` and asserts its update references only root A and `alpha.txt`, then updates session B with `bet` and asserts its update references only root B and `beta.txt`.

**Call relations**: It relies on `wait_for_session_updated`'s session-id filtering to prove the server can multiplex notifications for multiple sessions correctly.

*Call graph*: calls 2 internal fn (initialized_mcp, wait_for_session_updated); 4 external calls (new, assert_eq!, write, vec!).


##### `test_fuzzy_file_search_query_cleared_sends_blank_snapshot`  (lines 590–611)

```
async fn test_fuzzy_file_search_query_cleared_sends_blank_snapshot() -> Result<()>
```

**Purpose**: Checks that clearing a session query emits an explicit empty snapshot rather than leaving stale results visible. This defines the UI-facing behavior for blank search input.

**Data flow**: Starts a session over a root with `alpha.txt`, updates with `alp` and waits for a non-empty update, then updates with the empty string, waits for a `sessionUpdated` payload whose query is `""` and whose `files` list is empty, and asserts that emptiness.

**Call relations**: This test uses `FileExpectation::Empty` in `wait_for_session_updated` to validate the special blank-query case.

*Call graph*: calls 2 internal fn (initialized_mcp, wait_for_session_updated); 4 external calls (new, assert_eq!, write, vec!).
